"""CAL FIRE status history (BRIEF-2 U-R6): an append-only JSON-lines log per incident, kept outside the bundles.

CAL FIRE's incident list holds only each incident's current record, so a change of acreage, containment or status
overwrites the previous one. Fire-3d keeps every distinct record it sees whenever it checks CAL FIRE: the live and
year lists in :mod:`fire3d.catalog` (the list endpoints and the live loop's refresh and summary sync go through it)
and ``GET /api/official/calfire``.

* ``DATA_DIR/official/calfire/<UniqueId>.jsonl``: one JSON object per line (:func:`snapshot`), oldest first; the
  first line is the baseline. Rebuilds never touch these files.
* A line is appended when CAL FIRE's ``Updated`` time or a recorded value (acres, containment, active, final,
  extinguished) differs from the last line. A copy older than the last line (a stale cached list) is ignored, so the
  log never goes backwards.
* Recorded: fires CAL FIRE lists as active, incidents already tracked (so the record after containment is caught)
  and incidents asked for explicitly (``track=True``).
* Each write rewrites the file atomically (temp file + ``os.replace``) under a per-process lock and an ``fcntl`` lock
  on ``.lock``, so readers never see a partial line and concurrent writers never lose one.

:func:`changes` turns a history into value changes (``acres``, ``percent_contained``, ``is_active``, ``final`` as
``[old, new]``): an ``Updated`` change without new values is not a change.
"""

from __future__ import annotations

import fcntl
import logging
import os
import re
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator

import orjson

from .. import config
from ..bundle import atomic_write_bytes
from ..timeutil import now_ms

log = logging.getLogger(__name__)

SCHEMA = 1
DIR_PARTS = ("official", "calfire")
LOCK_NAME = ".lock"
SUFFIX = ".jsonl"
KEY_FIELDS = ("updated_ms", "acres", "percent_contained", "is_active", "final", "extinguished_ms")
CHANGE_FIELDS = ("acres", "percent_contained", "is_active", "final")
TRACKED_RESCAN_S = 300.0          # re-list the directory this often (another process may have added files)

_UID_RE = re.compile(r"^[0-9a-f][0-9a-f-]{5,63}$")
_lock = threading.RLock()
_last: dict[str, dict[str, Any] | None] = {}               # file path -> last snapshot (None: no file)
_tracked: dict[str, tuple[float, set[str]]] = {}            # directory -> (listed at, uids with a file)


# ----------------------------------------------------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------------------------------------------------
def history_dir() -> Path:
    """``DATA_DIR/official/calfire`` (resolved at call time, so tests can move DATA_DIR)."""
    return Path(config.DATA_DIR).joinpath(*DIR_PARTS)


def valid_uid(uid: Any) -> str | None:
    """CAL FIRE's UniqueId lower-cased, or None when it is not a safe file name (hex digits and dashes)."""
    u = str(uid or "").strip().lower()
    return u if _UID_RE.match(u) else None


def history_path(uid: str) -> Path:
    u = valid_uid(uid)
    if u is None:
        raise ValueError(f"invalid CAL FIRE UniqueId: {uid!r}")
    return history_dir() / f"{u}{SUFFIX}"


def reset_state() -> None:
    """Forget the in-memory caches (tests)."""
    with _lock:
        _last.clear()
        _tracked.clear()


@contextmanager
def _file_lock(d: Path) -> Iterator[None]:
    d.mkdir(parents=True, exist_ok=True)
    fd = os.open(d / LOCK_NAME, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


# ----------------------------------------------------------------------------------------------------------------
# Snapshots
# ----------------------------------------------------------------------------------------------------------------
def _clean(v: Any) -> str | None:
    s = str(v).strip() if v is not None else ""
    return s or None


def snapshot(rec: dict, seen_ms: int, list_name: str) -> dict[str, Any]:
    """One history line from a cleaned CAL FIRE record (``sources.calfire.normalize_incident``)."""
    from ..catalog import make_incident_id    # lazy: catalog imports this module

    uid = valid_uid(rec.get("uid") or rec.get("UniqueId"))
    name = _clean(rec.get("name"))
    year = rec.get("year")
    return {
        "v": SCHEMA,
        "seen_ms": int(seen_ms),
        "updated_ms": rec.get("updated_ms"),
        "uid": uid,
        "incident_id": make_incident_id(int(year), name or "", uid) if year and uid else None,
        "name": name,
        "acres": rec.get("acres"),
        "percent_contained": rec.get("percent_contained"),
        "is_active": bool(rec.get("is_active")),
        "final": bool(rec.get("final")),
        "extinguished_ms": rec.get("extinguished_ms"),
        "url": _clean(rec.get("url")),
        "agencies": _clean(rec.get("AgencyNames")),
        "list": list_name,
    }


def _key(s: dict) -> tuple:
    return tuple(s.get(f) for f in KEY_FIELDS)


def is_new(last: dict | None, snap: dict) -> bool:
    """True when ``snap`` belongs after ``last``: a different (Updated, values) and not an older copy."""
    if last is None:
        return True
    lu, su = last.get("updated_ms"), snap.get("updated_ms")
    if lu is not None and su is not None and su < lu:
        return False
    return _key(last) != _key(snap)


def _parse_lines(data: bytes, where: str) -> list[dict]:
    out: list[dict] = []
    for i, line in enumerate(data.splitlines()):
        if not line.strip():
            continue
        try:
            obj = orjson.loads(line)
        except orjson.JSONDecodeError:
            log.warning("CAL FIRE history %s: line %d is not JSON; skipped", where, i + 1)
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def _read_path(p: Path) -> list[dict]:
    try:
        data = p.read_bytes()
    except FileNotFoundError:
        return []
    return _parse_lines(data, p.name)


def read(uid: str | None) -> list[dict]:
    """Every recorded snapshot of one incident, oldest first ([] when none or the id is not usable)."""
    u = valid_uid(uid)
    return _read_path(history_path(u)) if u else []


def _last_snapshot(p: Path) -> dict | None:
    key = str(p)
    with _lock:
        if key in _last:
            return _last[key]
    hist = _read_path(p)
    last = hist[-1] if hist else None
    with _lock:
        _last[key] = last
    return last


def tracked_uids() -> set[str]:
    """UniqueIds that have a history file (listed again every few minutes)."""
    d = history_dir()
    key = str(d)
    with _lock:
        hit = _tracked.get(key)
        if hit is not None and time.monotonic() - hit[0] < TRACKED_RESCAN_S:
            return hit[1]
    uids = {p.name[: -len(SUFFIX)] for p in d.glob(f"*{SUFFIX}")} if d.is_dir() else set()
    with _lock:
        _tracked[key] = (time.monotonic(), uids)
    return uids


# ----------------------------------------------------------------------------------------------------------------
# Recording
# ----------------------------------------------------------------------------------------------------------------
def record(recs: Iterable[dict], *, list_name: str, seen_ms: int | None = None, track: bool = False) -> list[str]:
    """Append a snapshot for every record that is active, already tracked or (``track``) asked for, when it differs
    from that incident's last line. ``seen_ms``: when Fire-3d fetched the list copy (default now). Returns the
    UniqueIds that got a new line. Disk errors are logged, never raised."""
    seen = int(seen_ms or now_ms())
    tracked = tracked_uids()
    todo: list[tuple[str, Path, dict]] = []
    for rec in recs:
        uid = valid_uid(rec.get("uid") or rec.get("UniqueId"))
        if uid is None or not (track or rec.get("is_active") or uid in tracked):
            continue
        p = history_path(uid)
        snap = snapshot(rec, seen, list_name)
        if is_new(_last_snapshot(p), snap):
            todo.append((uid, p, snap))
    if not todo:
        return []
    appended: list[str] = []
    d = history_dir()
    try:
        with _lock, _file_lock(d):
            for uid, p, snap in todo:
                hist = _read_path(p)                 # re-read under the lock: another process may have written
                last = hist[-1] if hist else None
                if not is_new(last, snap):
                    _last[str(p)] = last
                    continue
                old = p.read_bytes() if p.exists() else b""
                if old and not old.endswith(b"\n"):
                    old += b"\n"
                atomic_write_bytes(p, old + orjson.dumps(snap) + b"\n")
                _last[str(p)] = snap
                tracked.add(uid)
                appended.append(uid)
    except OSError as e:
        log.warning("CAL FIRE history not written (%s): %s", d, e)
    return appended


def missing_active(listed_uids: Iterable[str]) -> dict[int, set[str]]:
    """Tracked incidents whose last line says active but that ``listed_uids`` (this live list) no longer includes,
    grouped by the year of their incident id: their record after containment is in that year's list."""
    listed = {str(u).lower() for u in listed_uids}
    out: dict[int, set[str]] = {}
    for uid in tracked_uids() - listed:
        last = _last_snapshot(history_path(uid))
        if not last or not last.get("is_active"):
            continue
        iid = str(last.get("incident_id") or "")
        if len(iid) > 5 and iid[:4].isdigit() and iid[4] == "-":
            out.setdefault(int(iid[:4]), set()).add(uid)
    return out


def find_uid(incident_id: str) -> str | None:
    """The UniqueId of a tracked incident by its Fire-3d id (files are named by UniqueId; the id carries its first
    six characters), or None."""
    m = re.match(r"^\d{4}-.+-([0-9a-f]{6})$", str(incident_id or ""))
    if not m:
        return None
    for uid in sorted(u for u in tracked_uids() if u.startswith(m.group(1))):
        last = _last_snapshot(history_path(uid))
        if last and last.get("incident_id") == incident_id:
            return uid
    return None


# ----------------------------------------------------------------------------------------------------------------
# Reading
# ----------------------------------------------------------------------------------------------------------------
def changes(history: list[dict]) -> list[dict]:
    """Value changes between consecutive snapshots: ``{updated_ms, seen_ms, <field>: [old, new], ...}`` for the
    fields in :data:`CHANGE_FIELDS` that changed (snapshots that changed only ``Updated`` are skipped)."""
    out: list[dict] = []
    for prev, cur in zip(history, history[1:]):
        diff = {f: [prev.get(f), cur.get(f)] for f in CHANGE_FIELDS if prev.get(f) != cur.get(f)}
        if diff:
            out.append({"updated_ms": cur.get("updated_ms"), "seen_ms": int(cur.get("seen_ms") or 0), **diff})
    return out
