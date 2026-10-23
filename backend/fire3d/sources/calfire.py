"""CAL FIRE incident lists (SPEC 2). Owner: firedata agent.

``list_live()`` / ``list_year(year)`` return one dict per incident. Each dict keeps the raw API keys (``Name``,
``Started``, ``AcresBurned``, ``UniqueId`` ...; strings stripped, so ``Name`` has no trailing space) and adds parsed
snake_case fields:

  ``name`` (clean, single-spaced), ``uid`` (UniqueId, lower-case), ``type``, ``year`` (UTC year of ``Started``),
  ``started_ms`` / ``updated_ms`` / ``extinguished_ms`` (int epoch ms UTC or None), ``acres``, ``percent_contained``
  (float or None), ``lat`` / ``lon`` (float, None when missing/zero), ``is_active`` / ``final`` (bool),
  ``county`` / ``location`` / ``admin_unit`` / ``url`` (str or None).

Requests go through :mod:`fire3d.http` (live list cached 10 min, the current year's list 30 min, past years 24 h).
When CAL FIRE is unreachable a stale cached copy is served (with a warning; :func:`is_stale` says so) before giving
up, and the failure is remembered for ``fhttp.DOWN_HOLD_S`` (60 s, :data:`down_memo`), so the request path does not
wait on a dead host again (CONTRACT 14.16). :func:`fetched_ms` says when the copy last returned for a list was fetched
from CAL FIRE (for "checked ..." times).
"""

from __future__ import annotations

import logging
import math
import re
import threading
import time
from pathlib import Path
from typing import Any

from .. import config
from .. import http as fhttp
from ..timeutil import iso_to_ms, ms_to_dt

log = logging.getLogger(__name__)

LIST_URL = "https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List"
LIVE_TTL_S = 600.0            # 10 min
YEAR_TTL_S = 86400.0          # 24 h (past years)
CURRENT_YEAR_TTL_S = 1800.0   # 30 min: the current season's list changes as fires grow and are contained
REFRESH_TTL_S = 1e-6          # any cached copy counts as stale -> refetch, and the fresh copy is cached
TIMEOUT_S = 12.0              # read timeout (seconds without data; answers take about 1 s): with one retry a hung host costs about 25 s, under the web's 30 s
CONNECT_TIMEOUT_S = 5.0
LIST_RETRIES = 1              # one retry when no copy is cached; none when one is (stale-if-error answers at once)
SOURCE_KEY = "calfire"        # down_memo key of the whole source (after a connection error or a timeout)
down_memo = fhttp.DownMemo("CAL FIRE")

_WS = re.compile(r"\s+")
_fetched_lock = threading.Lock()
_fetched: dict[str, int] = {}   # list key ("live" | "year:2026") -> fetch time (ms) of the copy last returned
_stale: dict[str, bool] = {}    # list key -> the copy last returned is an older one served because CAL FIRE failed


class CalFireError(RuntimeError):
    """CAL FIRE incident list unavailable (and no cached copy)."""


def evict_http_cache(url: str, params: Any = None, method: str = "GET") -> None:
    """Drop one fire3d.http cache entry, e.g. an error page some services return with status 200 (the shared
    cache stores every 2xx). Keyed exactly like :func:`fire3d.http.cache_key`."""
    key = fhttp.cache_key(method, url, params)
    d = Path(config.CACHE_DIR) / config.HTTP_CACHE_DIR_NAME / key[:2]
    for p in (d / f"{key}.bin", d / f"{key}.json"):
        try:
            p.unlink()
        except FileNotFoundError:
            pass


def clean_name(name: Any) -> str:
    """Strip and collapse whitespace (``"Timber Fire "`` -> ``"Timber Fire"``)."""
    return _WS.sub(" ", str(name or "")).strip()


def parse_time_ms(value: Any) -> int | None:
    """ISO-8601 (``Z``/offset/naive=UTC) -> epoch ms; blank or unparseable -> None."""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        return iso_to_ms(s)
    except (ValueError, TypeError):
        return None


def _float(value: Any) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _str_or_none(value: Any) -> str | None:
    s = clean_name(value) if value is not None else ""
    return s or None


def normalize_incident(raw: dict) -> dict:
    """One raw ``IncidentApi/List`` record -> cleaned dict (raw keys kept + parsed fields, see module doc)."""
    rec: dict[str, Any] = {k: (v.strip() if isinstance(v, str) else v) for k, v in raw.items()}
    name = clean_name(raw.get("Name"))
    rec["Name"] = name
    rec["name"] = name
    rec["uid"] = str(raw.get("UniqueId") or "").strip().lower()
    rec["type"] = clean_name(raw.get("Type"))
    started = parse_time_ms(raw.get("Started"))
    rec["started_ms"] = started
    rec["updated_ms"] = parse_time_ms(raw.get("Updated"))
    rec["extinguished_ms"] = parse_time_ms(raw.get("ExtinguishedDate"))
    rec["year"] = ms_to_dt(started).year if started is not None else None
    acres = _float(raw.get("AcresBurned"))
    rec["acres"] = acres if acres is not None and acres >= 0 else None
    pc = _float(raw.get("PercentContained"))
    rec["percent_contained"] = pc if pc is not None and 0 <= pc <= 100 else None
    lat, lon = _float(raw.get("Latitude")), _float(raw.get("Longitude"))
    ok = lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180 and not (lat == 0 and lon == 0)
    rec["lat"], rec["lon"] = (lat, lon) if ok else (None, None)
    rec["is_active"] = bool(raw.get("IsActive"))
    rec["final"] = bool(raw.get("Final"))
    rec["county"] = _str_or_none(raw.get("County"))
    rec["location"] = _str_or_none(raw.get("Location"))
    rec["admin_unit"] = _str_or_none(raw.get("AdminUnit"))
    rec["url"] = _str_or_none(raw.get("Url"))
    return rec


def list_key(params: dict) -> str:
    """``"live"`` for the active list, ``"year:<year>"`` for a year list."""
    return "live" if str(params.get("inactive")) == "false" else f"year:{params.get('year')}"


def fetched_ms(key: str) -> int | None:
    """When the copy of list ``key`` (:func:`list_key`) last returned by this module was fetched from CAL FIRE (a
    cached copy keeps its original fetch time); None before the first call."""
    with _fetched_lock:
        return _fetched.get(key)


def is_stale(key: str) -> bool:
    """True when the copy of list ``key`` last returned is an older cached copy served because CAL FIRE could not be
    reached (or answered an error) when it was due for a refresh."""
    with _fetched_lock:
        return bool(_stale.get(key))


def _parse_list(resp: fhttp.Response, params: dict) -> list:
    try:
        data = resp.json()
    except ValueError as e:                       # HTML/garbage with status 200 (orjson.JSONDecodeError)
        fhttp.evict_bad_answer(resp, "GET", LIST_URL, params)
        raise CalFireError(f"CAL FIRE incident list {params}: invalid JSON ({e})") from None
    if not isinstance(data, list):
        fhttp.evict_bad_answer(resp, "GET", LIST_URL, params)
        raise CalFireError(f"CAL FIRE incident list {params}: unexpected response type {type(data).__name__}")
    return data


def _get_list(params: dict, ttl_s: float | None) -> tuple[list, int]:
    """``(rows, fetched_ms)``: the cached copy while it is fresh, else GET + parse, unless CAL FIRE (or this list)
    failed less than a minute ago (then :class:`CalFireError` at once). A 2xx answer that is not a JSON list is
    evicted from the cache and raised as CalFireError; a failure is remembered (:data:`down_memo`)."""
    key = list_key(params)
    hit = fhttp.peek_cache("GET", LIST_URL, params, ttl_s)
    if hit is not None:
        return _parse_list(hit, params), int(hit.fetched_ms)
    if down_memo.down(SOURCE_KEY, key):
        raise CalFireError(f"CAL FIRE incident list {params}: CAL FIRE could not be reached a moment ago")
    retries = 0 if fhttp.has_cache("GET", LIST_URL, params) else LIST_RETRIES
    try:
        resp = fhttp.request("GET", LIST_URL, params=params, ttl_s=ttl_s, timeout=TIMEOUT_S, retries=retries,
                             connect_timeout=CONNECT_TIMEOUT_S, expect_json=True)
        data = _parse_list(resp, params)
    except fhttp.HttpError as e:
        down_memo.mark(SOURCE_KEY if e.status is None else key)   # a bad body answers fast: not remembered
        raise
    down_memo.clear(SOURCE_KEY)
    down_memo.clear(key)
    return data, int(resp.fetched_ms)


def _fetch(params: dict, ttl_s: float, refresh: bool) -> list[dict]:
    """GET the list (cached); on failure serve any cached copy (stale-if-error, :func:`is_stale`)."""
    key = list_key(params)
    stale = False
    try:
        data, t = _get_list(params, REFRESH_TTL_S if refresh else ttl_s)
    except (fhttp.HttpError, CalFireError) as e:
        hit = fhttp.peek_cache("GET", LIST_URL, params, None)        # any age; never the network
        try:
            if hit is None:
                raise CalFireError("no cached copy")
            data, t = _parse_list(hit, params), int(hit.fetched_ms)
        except CalFireError:
            raise CalFireError(f"CAL FIRE incident list unavailable ({params}): {e}") from None
        stale = True
        log.warning("CAL FIRE list %s unavailable (%s); serving the cached copy", params, e)
    with _fetched_lock:
        _fetched[key] = t
        _stale[key] = stale
    return [normalize_incident(r) for r in data if isinstance(r, dict)]


def list_live(refresh: bool = False) -> list[dict]:
    """Incidents CAL FIRE currently lists as active (``IncidentApi/List?inactive=false``), cleaned (see module doc).
    ``refresh`` bypasses the 10-min cache."""
    return _fetch({"inactive": "false"}, LIVE_TTL_S, refresh)


def year_ttl_s(year: int) -> float:
    """HTTP cache TTL of a year list: 30 min for the current (UTC) year or later, else 24 h."""
    return CURRENT_YEAR_TTL_S if int(year) >= time.gmtime().tm_year else YEAR_TTL_S


def list_year(year: int, refresh: bool = False) -> list[dict]:
    """All CAL FIRE incidents of ``year`` (``IncidentApi/List?inactive=true&year={year}``; includes the still-active
    ones), cleaned (see module doc). ``refresh`` bypasses the cache (30 min for the current year, else 24 h)."""
    return _fetch({"inactive": "true", "year": int(year)}, year_ttl_s(year), refresh)
