"""FEMA IPAWS archived alerts via OpenFEMA: the archive channel of the local-alerts endpoint (CONTRACT 14.7).

Source: ``https://www.fema.gov/api/open/v1/IpawsArchivedAlerts`` (OpenFEMA dataset "IPAWS Archived Alerts" v1):
every message sent through FEMA IPAWS, as its CAP fields, "published with a twenty-four (24) hour delay"; "FEMA does
not validate the content of each message". Terms: OpenFEMA terms and conditions
(https://www.fema.gov/about/openfema/terms-conditions, version of 2025-01-22, checked by the brief-3 evacuations
audit): free to use, the notice :data:`NOTICE` is required, and no FEMA or DHS logo may be used.

Query (:func:`fetch_window`): one date window on ``sent`` with ``status eq 'Actual'``, paged with ``$top``/``$skip``.
Event codes, SAME county codes and polygons are matched here (:func:`parse_record`, ``nws.place_local``), not on the
server: OpenFEMA's nested ``any()`` filters on ``info`` are slow (the audit saw a 503 after 60 s), while a day of
national messages is about 40-200 rows and answers in about a second. ``references`` exist only inside the CAP XML
(``originalMessage``), so it is requested and read with a regular expression (never parsed as XML); only the
identifiers are kept, never the operators' sender addresses.

Every alert's ``source_url`` is the OpenFEMA query for that record, by its CAP ``identifier`` (:func:`record_url`).
Requests go through :mod:`fire3d.http` (disk cache) behind :data:`OPENFEMA_LIMITER`.

Never on the request path for long (:func:`ensure`): an incident's archive is one window covering its whole record
(:func:`incident_window`), fetched once in a background thread (deduplicated per window) and stored, parsed, under
``DATA_DIR/official/openfema/``. A request waits at most :data:`REQUEST_WAIT_S` for it and otherwise answers
``pending``; a successful build fetches it right away (:func:`prefetch`, from ``build/pipeline.py``). A failed fetch
is remembered for :data:`RETRY_AFTER_S`, so a broken upstream is not asked again on every request.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote

import orjson
import shapely

from .. import config
from .. import http as fhttp
from ..timeutil import DAY_MS, HOUR_MS, ms_to_dt, now_ms
from . import nws

log = logging.getLogger(__name__)

API_URL = "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts"
DATASET_URL = "https://www.fema.gov/openfema-data-page/ipaws-archived-alerts-v1"
TERMS_URL = "https://www.fema.gov/about/openfema/terms-conditions"
CREDIT = "FEMA IPAWS archive via OpenFEMA"
NOTICE = "This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA"
SOURCE: dict[str, str] = {
    "name": "FEMA IPAWS Archived Alerts (OpenFEMA)",
    "url": DATASET_URL,
    "credit": CREDIT,
    "license": "OpenFEMA terms: free to use with the notice \"" + NOTICE + "\"; no FEMA or DHS logos",
    "terms_url": TERMS_URL,
}
ARCHIVE_DELAY_MS = 24 * HOUR_MS        # OpenFEMA publishes IPAWS messages about a day later
PAGE_SIZE = 1000
MAX_PAGES = 10
SELECT = "identifier,sent,msgType,status,info"
REFS_SELECT = "identifier,originalMessage"      # only for updates and cancellations (their <references>)
TIMEOUT_S = 60.0
RETRIES = 1
RECENT_TTL_S = 3600.0                  # a window that ended less than 3 days ago may still be filling
PAST_TTL_S = 30 * 86400.0
OPENFEMA_LIMITER = fhttp.RateLimiter(20, 60.0, "official: OpenFEMA")
REQUEST_WAIT_S = 3.0                   # the request path never waits longer for the archive (CONTRACT 14.7: 5 s in all)
RETRY_AFTER_S = 600.0                  # a failed window is not asked again for 10 min
INCIDENT_SPAN_MAX_MS = 22 * DAY_MS     # one incident window covers at most this much (~1,000 national messages)
HISTORICAL_DEFAULT_SPAN_MS = 14 * DAY_MS   # a past fire without a known end
CACHE_SUBDIR = ("official", "openfema")
CACHE_VERSION = 1
_NAME = "FEMA's IPAWS archive (OpenFEMA)"
_REFS_RE = re.compile(r"<(?:\w+:)?references>(.*?)</(?:\w+:)?references>", re.S)


def record_url(identifier: str) -> str:
    """The OpenFEMA query that returns this one message, by its CAP identifier (URL-encoded)."""
    flt = f"identifier eq '{identifier}'"
    return f"{API_URL}?$filter={quote(flt, safe='')}"


def _iso(ms: int) -> str:
    return ms_to_dt(ms).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def window_params(start_ms: int, end_ms: int, skip: int = 0, *, refs: bool = False) -> dict[str, str]:
    """OData parameters of one page of the ``[start_ms, end_ms)`` window (sent time, actual messages only); with
    ``refs`` the updates and cancellations only, with their CAP XML (for ``references``)."""
    flt = f"status eq 'Actual' and sent ge '{_iso(start_ms)}' and sent lt '{_iso(end_ms)}'"
    return {
        "$filter": flt + (" and msgType ne 'Alert'" if refs else ""),
        "$select": REFS_SELECT if refs else SELECT,
        "$orderby": "sent",
        "$top": str(PAGE_SIZE),
        "$skip": str(skip),
        "$inlinecount": "allpages",
    }


def window_ttl_s(end_ms: int, now: int) -> float:
    return RECENT_TTL_S if end_ms > now - 3 * DAY_MS else PAST_TTL_S


def fetch_window(start_ms: int, end_ms: int, *, now: int | None = None, timeout: float = TIMEOUT_S) -> tuple[list[dict], int, bool]:
    """Every actual IPAWS message sent in ``[start_ms, end_ms)``: ``(records, fetched_ms, truncated)``; updates and
    cancellations also carry their ``originalMessage`` (a second, smaller query) so their references can be read.
    Raises ``nws.SourceError`` (unreachable, unreadable) or ``nws.SourceBusy`` (Fire-3d's own limit)."""
    recs, fetched, truncated = _fetch_pages(start_ms, end_ms, now=now, timeout=timeout, refs=False)
    try:
        xml, _, _ = _fetch_pages(start_ms, end_ms, now=now, timeout=timeout, refs=True)
        by_id = {str(r.get("identifier")): r.get("originalMessage") for r in xml}
        for r in recs:
            if r.get("msgType") != "Alert" and str(r.get("identifier")) in by_id:
                r["originalMessage"] = by_id[str(r.get("identifier"))]
    except nws.SourceError as e:     # references are optional: the messages themselves are shown
        log.info("openfema: references unavailable for %s..%s: %s", _iso(start_ms), _iso(end_ms), e)
    return recs, fetched, truncated


def _fetch_pages(start_ms: int, end_ms: int, *, now: int | None, timeout: float, refs: bool) -> tuple[list[dict], int, bool]:
    t_now = now if now is not None else now_ms()
    ttl = window_ttl_s(end_ms, t_now)
    out: list[dict] = []
    fetched: list[int] = []
    total = None
    for page in range(MAX_PAGES):
        params = window_params(start_ms, end_ms, page * PAGE_SIZE, refs=refs)
        hit = fhttp.peek_cache("GET", API_URL, params, ttl)
        if hit is None and not OPENFEMA_LIMITER.try_acquire():
            raise nws.SourceBusy(f"{_NAME}: Fire-3d's request limit is reached; try again in a minute")
        try:
            resp = hit or fhttp.request("GET", API_URL, params=params, ttl_s=ttl, timeout=timeout, retries=RETRIES)
            data = resp.json()
        except fhttp.HttpError as e:
            code = f"HTTP {e.status}" if e.status is not None else "no response"
            raise nws.SourceError(f"{_NAME} could not be reached ({code})", e.status) from None
        except ValueError:
            fhttp.evict_cache("GET", API_URL, params)
            raise nws.SourceError(f"{_NAME} sent a reply Fire-3d could not read") from None
        rows = data.get("IpawsArchivedAlerts") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            fhttp.evict_cache("GET", API_URL, params)
            raise nws.SourceError(f"{_NAME} sent an unexpected reply")
        fetched.append(int(resp.fetched_ms))
        out.extend(r for r in rows if isinstance(r, dict))
        meta = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
        total = meta.get("count") if isinstance(meta.get("count"), int) else total
        if len(rows) < PAGE_SIZE or (total is not None and len(out) >= total):
            return out, min(fetched), False
    return out, min(fetched), True


def references_of(original_message: Any) -> list[str]:
    """The referenced messages' identifiers from the CAP XML ``<references>`` ("sender,identifier,sent" triples);
    the sender part is never kept."""
    if not isinstance(original_message, str):
        return []
    m = _REFS_RE.search(original_message)
    if not m:
        return []
    out = []
    for triple in m.group(1).split():
        parts = triple.split(",")
        if len(parts) >= 3 and parts[1]:
            out.append(parts[1])
    return list(dict.fromkeys(out))


def _pairs(items: Any, key: str) -> list[str]:
    """Values of the ``{name, value}`` items named ``key`` (OpenFEMA's transformed eventCode / parameter / geocode)."""
    out = []
    for it in items or []:
        if isinstance(it, dict) and str(it.get("name") or it.get("valueName") or "") == key and it.get("value") is not None:
            out.append(str(it["value"]))
    return out


def _pick_info(infos: Any) -> dict | None:
    items = [i for i in infos or [] if isinstance(i, dict)]
    if not items:
        return None
    return next((i for i in items if str(i.get("language") or "en").lower().startswith("en")), items[0])


def parse_record(rec: dict) -> dict[str, Any] | None:
    """One OpenFEMA record -> a LocalAlert dict (``channel`` openfema_archive, ``archived`` true, text verbatim, keys
    starting with "_" internal); None unless it is an actual local officials' message in scope (FRW, EVI, SPW, CDW;
    CEM and LAE when the text mentions fire, smoke or evacuation). The operator's ``sender`` is never read."""
    if not isinstance(rec, dict) or rec.get("status") != "Actual":
        return None
    ident = str(rec.get("identifier") or "").strip()
    info = _pick_info(rec.get("info"))
    if not ident or info is None:
        return None
    codes = _pairs(info.get("eventCode"), "SAME")
    code = next((c for c in codes if c in nws.LOCAL_CODES), None)
    if code is None:
        return None
    params = info.get("parameter")
    wea = next(iter(_pairs(params, "CMAMtext")), None)
    wea_long = next(iter(_pairs(params, "CMAMlongtext")), None)
    event = nws._text(info.get("event"))
    headline = nws._text(info.get("headline"))
    desc, instr = nws._verbatim(info.get("description")), nws._verbatim(info.get("instruction"))
    if not nws.local_in_scope(code, event, headline, desc, instr, wea, wea_long):
        return None
    areas = [a for a in info.get("area") or [] if isinstance(a, dict)]
    same = [c for a in areas for c in _pairs(a.get("geocode"), "SAME") if re.fullmatch(r"\d{6}", c)]
    ugcs = [c for a in areas for c in _pairs(a.get("geocode"), "UGC") if nws.UGC_RE.match(c)]
    polys = [g for g in (nws.polygonal(a.get("polygon")) for a in areas) if g is not None]
    geom = shapely.union_all(polys) if polys else None
    descs = [nws._text(a.get("areaDesc")) for a in areas]
    mt = nws._text(rec.get("msgType"))
    sender_name = nws._text(info.get("senderName"))
    return {
        "id": ident,
        "channel": "openfema_archive",
        "archived": True,
        "event": event or code,
        "event_code": code,
        "message_type": mt if mt in ("Alert", "Update", "Cancel") else None,
        "references": references_of(rec.get("originalMessage")),
        "sender_name": sender_name,
        "sender_is_platform": nws.is_platform_sender(sender_name),
        "sent_ms": nws._ms(rec.get("sent")),
        "effective_ms": nws._ms(info.get("effective")),
        "onset_ms": nws._ms(info.get("onset")),
        "expires_ms": nws._ms(info.get("expires")),
        "headline": headline,
        "description": desc,
        "instruction": instr,
        "wea_text": nws._verbatim(wea),
        "wea_long_text": nws._verbatim(wea_long),
        "web": nws._https(info.get("web")),
        "source_url": record_url(ident),
        "area_desc": "; ".join(dict.fromkeys(d for d in descs if d)) or None,
        "same_codes": list(dict.fromkeys(same)),
        "ugcs": list(dict.fromkeys(ugcs)),
        "polygon": nws.geojson_out(geom),
        "_geom": geom,
    }


def parse_records(records: Iterable[dict]) -> list[dict]:
    """The in-scope messages of ``records``, one per CAP identifier (the latest copy of a duplicate wins)."""
    out: dict[str, dict] = {}
    for r in records:
        a = parse_record(r)
        if a is not None:
            out[a["id"]] = a
    return list(out.values())


def archive_window(at_ms: int) -> tuple[int, int]:
    """The archive window of a replay time: messages sent from ``at_ms - 24 h`` to ``at_ms + 1 h`` (whole hours, the
    same span as the NWS past request), so one window is one cache entry."""
    a = (int(at_ms) - nws.PAST_BEFORE_MS) // HOUR_MS * HOUR_MS
    b = -(-(int(at_ms) + nws.PAST_AFTER_MS) // HOUR_MS) * HOUR_MS
    return a, b


def archived_alerts(at_ms: int, *, now: int | None = None, timeout: float = TIMEOUT_S) -> tuple[list[dict], int, bool]:
    """The in-scope archived messages around ``at_ms`` (see :func:`archive_window`): ``(alerts, fetched_ms,
    truncated)``. Raises ``nws.SourceError`` / ``nws.SourceBusy``."""
    a, b = archive_window(at_ms)
    recs, fetched, truncated = fetch_window(a, b, now=now, timeout=timeout)
    return parse_records(recs), fetched, truncated


# ----------------------------------------------------------------------------------------------------------------
# Incident windows, the disk cache and the background fetch (CONTRACT 14.7, us-pipeline cut-line item a)
# ----------------------------------------------------------------------------------------------------------------
_lock = threading.Lock()
_running: dict[tuple[int, int], threading.Thread] = {}
_failed: dict[tuple[int, int], tuple[float, str]] = {}


def reset_state() -> None:
    """Forget running fetches and remembered failures (tests)."""
    with _lock:
        _running.clear()
        _failed.clear()


def _floor_day(ms: int) -> int:
    return int(ms) // DAY_MS * DAY_MS


def _ceil_day(ms: int) -> int:
    return -(-int(ms) // DAY_MS) * DAY_MS


def incident_window(started_ms: int | None, end_ms: int | None, at_ms: int, now: int) -> tuple[int, int]:
    """The archive window answering ``at_ms`` for an incident: its whole record ``[day(start − 1 d), day(end + 1 d)]``
    (end None = an ongoing fire: now; at most 22 days; never past today's 00:00 UTC, since the archive is a day late)
    when ``at_ms`` falls in it, so one fetch serves every replay time (and a live fire one fetch a day); else the UTC
    days around :func:`archive_window`."""
    today = _floor_day(now)
    if started_ms:
        lo = _floor_day(int(started_ms) - DAY_MS)
        hi = min(_ceil_day(int(end_ms if end_ms else now) + DAY_MS), lo + INCIDENT_SPAN_MAX_MS, today)
        if hi > lo and lo + nws.PAST_BEFORE_MS <= at_ms <= hi:
            return lo, hi
    a, b = archive_window(at_ms)
    lo = _floor_day(a)
    return lo, max(min(_ceil_day(b), today), lo + DAY_MS)


def cache_file(window: tuple[int, int]) -> Path:
    return Path(config.DATA_DIR).joinpath(*CACHE_SUBDIR, f"window_{window[0]}_{window[1]}.json")


def _fresh(doc: dict, window: tuple[int, int], now: int) -> bool:
    if doc.get("version") != CACHE_VERSION:
        return False
    age_s = (now - int(doc.get("fetched_ms") or 0)) / 1000.0
    return age_s < window_ttl_s(window[1], now)


def load_cached(window: tuple[int, int], now: int | None = None) -> dict | None:
    """The stored archive of ``window`` (``{version, window, fetched_ms, truncated, alerts}``; alerts parsed, with
    their ``_geom`` rebuilt), or None when missing, unreadable or stale."""
    t = now if now is not None else now_ms()
    p = cache_file(window)
    try:
        doc = orjson.loads(p.read_bytes())
    except (OSError, orjson.JSONDecodeError):
        return None
    if not isinstance(doc, dict) or not _fresh(doc, window, t) or not isinstance(doc.get("alerts"), list):
        return None
    for a in doc["alerts"]:
        a["_geom"] = nws.polygonal(a.get("polygon"))
    return doc


def store(window: tuple[int, int], alerts: list[dict], fetched_ms: int, truncated: bool) -> dict:
    doc = {"version": CACHE_VERSION, "window": list(window), "fetched_ms": int(fetched_ms), "truncated": bool(truncated),
           "alerts": [{k: v for k, v in a.items() if not k.startswith("_")} for a in alerts]}
    try:
        fhttp.atomic_write_bytes(cache_file(window), orjson.dumps(doc))
    except OSError as e:   # a read-only data dir: the answer still serves this process via the http cache
        log.warning("openfema: could not store %s: %s", cache_file(window).name, e)
    for a, src in zip(doc["alerts"], alerts):
        a["_geom"] = src.get("_geom")
    return doc


def fetch_and_store(window: tuple[int, int], *, now: int | None = None, timeout: float = TIMEOUT_S) -> dict:
    """Fetch, parse and store one window (raises ``nws.SourceError`` / ``nws.SourceBusy``)."""
    recs, fetched, truncated = fetch_window(window[0], window[1], now=now, timeout=timeout)
    return store(window, parse_records(recs), fetched, truncated)


def _run(window: tuple[int, int]) -> None:
    try:
        fetch_and_store(window)
        with _lock:
            _failed.pop(window, None)
    except Exception as e:  # noqa: BLE001 - remembered and reported as "unavailable"
        msg = str(e) if isinstance(e, nws.SourceError) else f"{_NAME} could not be reached (no response)"
        log.info("openfema: window %s failed: %s", window, config.mask_secrets(e))
        with _lock:
            _failed[window] = (time.monotonic(), msg)
    finally:
        with _lock:
            _running.pop(window, None)


def start(window: tuple[int, int]) -> threading.Thread:
    """Start (or join) the one background fetch of ``window``."""
    with _lock:
        th = _running.get(window)
        if th is None:
            th = threading.Thread(target=_run, args=(window,), name=f"openfema-{window[0]}", daemon=True)
            _running[window] = th
            th.start()
    return th


def ensure(window: tuple[int, int], *, wait_s: float | None = None, now: int | None = None) -> tuple[str, dict | None, str | None]:
    """``("available", doc, None)`` from the disk cache; else starts the background fetch and waits at most
    ``wait_s``: ``("available", doc, None)`` when it finished in time, ``("pending", None, None)`` otherwise;
    ``("unavailable", None, reason)`` when the last fetch of this window failed less than 10 min ago."""
    doc = load_cached(window, now)
    if doc is not None:
        return "available", doc, None
    with _lock:
        fail = _failed.get(window)
    if fail is not None and time.monotonic() - fail[0] < RETRY_AFTER_S:
        return "unavailable", None, fail[1]
    th = start(window)
    th.join(max(0.0, REQUEST_WAIT_S if wait_s is None else wait_s))
    doc = load_cached(window, now)
    if doc is not None:
        return "available", doc, None
    with _lock:
        fail = _failed.get(window) if window not in _running else None
    if fail is not None:
        return "unavailable", None, fail[1]
    return "pending", None, None


def prefetch(started_ms: int | None, end_ms: int | None, *, now: int | None = None, timeout: float = TIMEOUT_S) -> bool:
    """Fetch an incident's archive now (after a successful build), when part of its record is older than the 24 h
    publication delay and the window is not stored yet. True when the window is stored. Never raises."""
    t = now if now is not None else now_ms()
    if not started_ms or int(started_ms) > t - ARCHIVE_DELAY_MS:
        return False
    window = incident_window(started_ms, end_ms, int(started_ms) + DAY_MS, t)
    if load_cached(window, t) is not None:
        return True
    try:
        fetch_and_store(window, now=t, timeout=timeout)
        return True
    except Exception as e:  # noqa: BLE001 - a build never fails over the archive
        log.info("openfema: prefetch %s failed: %s", window, config.mask_secrets(e))
        return False


def answer(window: tuple[int, int], at_ms: int, doc: dict) -> list[dict]:
    """The stored messages of ``doc`` sent in ``[at_ms − 24 h, at_ms + 1 h]`` (the replay window)."""
    lo, hi = int(at_ms) - nws.PAST_BEFORE_MS, int(at_ms) + nws.PAST_AFTER_MS
    return [a for a in doc.get("alerts") or [] if a.get("sent_ms") is not None and lo <= a["sent_ms"] <= hi]
