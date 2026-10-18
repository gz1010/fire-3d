"""CAL FIRE incident lists (SPEC 2). Owner: firedata agent.

``list_live()`` / ``list_year(year)`` return one dict per incident. Each dict keeps the raw API keys (``Name``,
``Started``, ``AcresBurned``, ``UniqueId`` ...; strings stripped, so ``Name`` has no trailing space) and adds parsed
snake_case fields:

  ``name`` (clean, single-spaced), ``uid`` (UniqueId, lower-case), ``type``, ``year`` (UTC year of ``Started``),
  ``started_ms`` / ``updated_ms`` / ``extinguished_ms`` (int epoch ms UTC or None), ``acres``, ``percent_contained``
  (float or None), ``lat`` / ``lon`` (float, None when missing/zero), ``is_active`` / ``final`` (bool),
  ``county`` / ``location`` / ``admin_unit`` / ``url`` (str or None).

Requests go through :mod:`fire3d.http` (live list cached 10 min, yearly lists 24 h). When CAL FIRE is unreachable a
stale cached copy is served (with a warning) before giving up.
"""

from __future__ import annotations

import logging
import math
import re
from pathlib import Path
from typing import Any

from .. import config
from .. import http as fhttp
from ..timeutil import iso_to_ms, ms_to_dt

log = logging.getLogger(__name__)

LIST_URL = "https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List"
LIVE_TTL_S = 600.0            # 10 min
YEAR_TTL_S = 86400.0          # 24 h
REFRESH_TTL_S = 1e-6          # any cached copy counts as stale -> refetch, and the fresh copy is cached

_WS = re.compile(r"\s+")


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


def _get_list(params: dict, ttl_s: float | None, retries: int = fhttp.DEFAULT_RETRIES) -> list:
    """GET + parse; a 2xx answer that is not a JSON list is evicted from the cache and raised as CalFireError."""
    try:
        data = fhttp.get_json(LIST_URL, params, ttl_s=ttl_s, timeout=45.0, retries=retries)
    except ValueError as e:                       # HTML/garbage with status 200 (orjson.JSONDecodeError)
        evict_http_cache(LIST_URL, params)
        raise CalFireError(f"CAL FIRE incident list {params}: invalid JSON ({e})") from None
    if not isinstance(data, list):
        evict_http_cache(LIST_URL, params)
        raise CalFireError(f"CAL FIRE incident list {params}: unexpected response type {type(data).__name__}")
    return data


def _fetch(params: dict, ttl_s: float, refresh: bool) -> list[dict]:
    """GET the list (cached); on failure serve any cached copy (stale-if-error)."""
    try:
        data = _get_list(params, REFRESH_TTL_S if refresh else ttl_s)
    except (fhttp.HttpError, CalFireError) as e:
        try:
            data = _get_list(params, None, retries=0)    # any age; network only if never cached
            log.warning("CAL FIRE list %s unavailable (%s); serving the cached copy", params, e)
        except (fhttp.HttpError, CalFireError):
            raise CalFireError(f"CAL FIRE incident list unavailable ({params}): {e}") from None
    return [normalize_incident(r) for r in data if isinstance(r, dict)]


def list_live(refresh: bool = False) -> list[dict]:
    """Incidents CAL FIRE currently lists as active (``IncidentApi/List?inactive=false``), cleaned (see module doc).
    ``refresh`` bypasses the 10-min cache."""
    return _fetch({"inactive": "false"}, LIVE_TTL_S, refresh)


def list_year(year: int, refresh: bool = False) -> list[dict]:
    """All CAL FIRE incidents of ``year`` (``IncidentApi/List?inactive=true&year={year}``; includes the still-active
    ones), cleaned (see module doc). ``refresh`` bypasses the 24-h cache."""
    return _fetch({"inactive": "true", "year": int(year)}, YEAR_TTL_S, refresh)
