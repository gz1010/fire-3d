"""Address lookup for the map-first UI: a caching proxy for the US Census Geocoder (docs/redesign/BRIEF.md section 8,
docs/redesign/CONTRACT.md section 6). Owned by the redesign location agent; app.py mounts ``router``.

``GET /api/geocode?q=<one-line US street address>``

* Upstream: the Census Geocoder ``locations/onelineaddress`` search (no geographies lookup), ``format=json``, with
  the current documented benchmark ``Public_AR_Current`` (id 4, "Public Address Ranges - Current Benchmark", the
  default; checked 2026-10-17 on Geocoding_Services_API.html and /geocoder/benchmarks). No API key.
  ``FIRE3D_GEOCODER_URL`` / ``FIRE3D_GEOCODER_BENCHMARK`` override the endpoint and benchmark.
* Census positions are calculated along TIGER/Line address ranges, not rooftops: every response says so, and the
  matched range (``from_address``..``to_address``) and street side are passed on.
* Only explicitly submitted street addresses: no autocomplete, no POI search. Coordinate-like queries are refused
  (the browser resolves coordinates itself; they are never sent upstream).
* Requests go through ``fire3d.http`` (identifying User-Agent, shared concurrency cap, one retry, secret-free
  errors) and are cached for 30 days, keyed by the normalised query (NFKC, trimmed, whitespace collapsed,
  case-folded): on disk by ``fire3d.http`` and in memory (bounded LRU of parsed replies). Only parseable replies are
  kept; a cached reply that fails to parse is fetched again once. Cache misses are limited to
  ``UPSTREAM_PER_MINUTE`` upstream requests per process (429 beyond that).
* Errors (``{"detail": ...}``): 400 empty, too long or not an address; 429 own rate limit; 502 upstream error or
  unparseable reply; 504 upstream timeout. Messages never include upstream bodies (at most Census's own short
  error text).
"""
from __future__ import annotations

import logging
import math
import os
import re
import threading
import time
import unicodedata
from collections import OrderedDict
from typing import Any

import orjson
from fastapi import APIRouter, Query
from fastapi.responses import Response

from .. import config
from .. import http as fhttp

log = logging.getLogger(__name__)

router = APIRouter(tags=["geocode"])

CENSUS_URL = os.environ.get("FIRE3D_GEOCODER_URL", "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress")
BENCHMARK = os.environ.get("FIRE3D_GEOCODER_BENCHMARK", "Public_AR_Current")
SOURCE = "U.S. Census Bureau Geocoder"
ATTRIBUTION = "Address search: U.S. Census Bureau Geocoder (positions interpolated along address ranges)"
NOTE = ("Census positions are calculated along a street's address range (interpolated), not at a building or "
        "rooftop: treat them as approximate and adjust the pin if needed.")

MAX_QUERY_CHARS = 200
MAX_MATCHES = 10                     # candidates returned (total_matches gives the full count)
CACHE_TTL_S = 30 * 86_400.0          # address ranges change only with benchmark releases (about twice a year)
CACHE_MAX_ENTRIES = 512
TIMEOUT_S = 10.0                     # per attempt; with one retry the worst case stays under ~25 s
RETRIES = 1
UPSTREAM_PER_MINUTE = 30
RETRY_AFTER_S = 60
CACHE_CONTROL_OK = "private, max-age=3600"

upstream_limiter = fhttp.RateLimiter(UPSTREAM_PER_MINUTE, 60.0, name="Census Geocoder limiter")

_cache: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()   # key -> (stored monotonic s, reply)
_cache_lock = threading.Lock()


class GeocodeError(Exception):
    """A request the proxy answers with ``status`` and a user-facing ``detail``."""

    def __init__(self, status: int, detail: str, headers: dict[str, str] | None = None):
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.headers = headers or {}


# ------------------------------------------------------------------------------------------------------------------
# Query handling
# ------------------------------------------------------------------------------------------------------------------
def normalize_query(q: str | None) -> str:
    """NFKC, control characters dropped, whitespace collapsed, trimmed (display form; the cache key case-folds)."""
    s = unicodedata.normalize("NFKC", q or "")
    s = "".join(" " if unicodedata.category(ch).startswith("C") else ch for ch in s)
    return re.sub(r"\s+", " ", s).strip()


def cache_key(normalized: str) -> str:
    return normalized.casefold()


_COORD_CHARS = re.compile(r"^[\s0-9.,;:+\-−°º'’′\"”″NSEWnsew]+$")
_COORD_MARK = re.compile(r"[.°º'’′\"”″]")


def looks_like_coordinates(normalized: str) -> bool:
    """True for latitude/longitude text ("34.2, -118.1", "34°12'N 118°7'W", "geo:34.2,-118.1"): numbers with
    decimals or degree/minute marks and nothing but hemisphere letters. "100 W 200 N" (a street grid address)
    has no decimals or marks and is not treated as coordinates."""
    s = re.sub(r"^geo:", "", normalized.strip(), flags=re.IGNORECASE)
    if not _COORD_CHARS.match(s):
        return False
    return len(re.findall(r"\d+(?:\.\d+)?", s)) >= 2 and bool(_COORD_MARK.search(s))


def validate_query(raw: str | None) -> str:
    q = normalize_query(raw)
    if not q:
        raise GeocodeError(400, "Enter a US street address, for example \"600 E Mariposa St, Altadena, CA 91001\".")
    if len(q) > MAX_QUERY_CHARS:
        raise GeocodeError(400, f"The address is too long (at most {MAX_QUERY_CHARS} characters).")
    if looks_like_coordinates(q):
        raise GeocodeError(400, "This looks like coordinates. Coordinates are located in the app and are never sent to the address service.")
    if not re.search(r"[^\W\d_]", q):
        raise GeocodeError(400, "Enter a street address with a street name, for example \"600 E Mariposa St, Altadena, CA\".")
    return q


# ------------------------------------------------------------------------------------------------------------------
# Upstream reply
# ------------------------------------------------------------------------------------------------------------------
def _text(v: Any) -> str | None:
    s = str(v).strip() if v is not None else ""
    return s or None


def parse_reply(payload: Any) -> tuple[list[dict[str, Any]], str | None]:
    """``(matches, benchmark name)`` from a Census ``locations`` JSON reply; ValueError when it is not one.
    Matches without finite, in-range coordinates are dropped; duplicates (same address and position) collapse."""
    result = payload.get("result") if isinstance(payload, dict) else None
    raw = result.get("addressMatches") if isinstance(result, dict) else None
    if not isinstance(raw, list):
        raise ValueError("reply has no result.addressMatches list")
    bench = None
    inp = result.get("input") if isinstance(result, dict) else None
    if isinstance(inp, dict) and isinstance(inp.get("benchmark"), dict):
        bench = _text(inp["benchmark"].get("benchmarkName"))
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, float, float]] = set()
    for m in raw:
        if not isinstance(m, dict):
            continue
        coords = m.get("coordinates") if isinstance(m.get("coordinates"), dict) else {}
        try:
            lon = float(coords.get("x"))
            lat = float(coords.get("y"))
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(lat) and math.isfinite(lon) and -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            continue
        tiger = m.get("tigerLine") if isinstance(m.get("tigerLine"), dict) else {}
        comps = m.get("addressComponents") if isinstance(m.get("addressComponents"), dict) else {}
        side = _text(tiger.get("side"))
        item = {
            "matched_address": _text(m.get("matchedAddress")) or "",
            "lat": round(lat, 7),
            "lon": round(lon, 7),
            "tiger_line_id": _text(tiger.get("tigerLineId")),
            "side": side if side in ("L", "R") else None,
            "from_address": _text(comps.get("fromAddress")),
            "to_address": _text(comps.get("toAddress")),
        }
        k = (item["matched_address"], item["lat"], item["lon"])
        if k in seen:
            continue
        seen.add(k)
        out.append(item)
    return out, bench


def _upstream_error(e: fhttp.HttpError) -> GeocodeError:
    if e.status is None:
        if "timeout" in e.message.lower():
            return GeocodeError(504, "The Census Geocoder did not answer in time. Try again in a moment.")
        return GeocodeError(502, "Cannot reach the Census Geocoder (network error). Coordinates and incident search still work.")
    if e.status == 429 or e.status >= 500:
        return GeocodeError(502, f"The Census Geocoder is unavailable right now (HTTP {e.status}). Try again later.")
    detail = ""
    try:   # Census 4xx replies are {"errors": ["..."], "status": "400"}; pass on its short message only
        errs = orjson.loads(e.message).get("errors")
        if isinstance(errs, list) and errs and isinstance(errs[0], str):
            detail = re.sub(r"[^\w .,:;'()/-]", "", errs[0])[:120].strip()
    except (orjson.JSONDecodeError, AttributeError, TypeError):
        pass
    return GeocodeError(502, f"The Census Geocoder rejected the request (HTTP {e.status}){': ' + detail if detail else ''}.")


def _fetch(address: str, ttl_s: float) -> fhttp.Response:
    params = {"address": address, "benchmark": BENCHMARK, "format": "json"}
    return fhttp.request("GET", CENSUS_URL, params=params, ttl_s=ttl_s, timeout=TIMEOUT_S, retries=RETRIES)


def lookup(raw_query: str | None) -> dict[str, Any]:
    """The /api/geocode reply for a raw query; raises GeocodeError."""
    q = validate_query(raw_query)
    key = cache_key(q)
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] <= CACHE_TTL_S:
            _cache.move_to_end(key)
            return {**hit[1], "query": q, "cached": True}
        if hit:
            del _cache[key]
    if not upstream_limiter.try_acquire():
        raise GeocodeError(429, "Too many address lookups in the last minute. Try again shortly; coordinates and incident search still work.",
                           {"Retry-After": str(RETRY_AFTER_S)})
    address = key.upper()   # TIGER is upper case; one spelling per key keeps fire3d.http's disk cache shared
    try:
        resp = _fetch(address, CACHE_TTL_S)
        try:
            matches, bench = parse_reply(resp.json())
        except (orjson.JSONDecodeError, ValueError):
            if not resp.from_cache:
                raise
            resp = _fetch(address, 1e-9)    # a stale bad cache entry: fetch again (overwrites the disk entry)
            matches, bench = parse_reply(resp.json())
    except fhttp.HttpError as e:
        log.warning("geocode upstream failed: status=%s", e.status)
        raise _upstream_error(e) from None
    except (orjson.JSONDecodeError, ValueError):
        log.warning("geocode upstream reply could not be parsed")
        raise GeocodeError(502, "The Census Geocoder sent a reply that could not be read. Try again later.") from None
    reply = {
        "matches": matches[:MAX_MATCHES],
        "total_matches": len(matches),
        "benchmark": bench or BENCHMARK,
        "source": SOURCE,
        "attribution": ATTRIBUTION,
        "note": NOTE,
        "fetched_ms": int(resp.fetched_ms),
    }
    with _cache_lock:
        _cache[key] = (time.monotonic(), reply)
        _cache.move_to_end(key)
        while len(_cache) > CACHE_MAX_ENTRIES:
            _cache.popitem(last=False)
    log.info("geocode: %d match(es), cached=%s", len(matches), resp.from_cache)
    return {**reply, "query": q, "cached": bool(resp.from_cache)}


def clear_cache() -> None:
    """Drop the in-memory cache (tests)."""
    with _cache_lock:
        _cache.clear()


def _json(obj: Any, status: int, headers: dict[str, str]) -> Response:
    return Response(orjson.dumps(obj), status_code=status, media_type="application/json", headers=headers)


@router.get("/api/geocode")
def geocode(q: str = Query("", description="One-line US street address (house number, street, city/state or ZIP)")) -> Response:
    """Census Geocoder lookup of an explicitly submitted US street address (approximate, interpolated positions)."""
    try:
        return _json(lookup(q), 200, {"Cache-Control": CACHE_CONTROL_OK})
    except GeocodeError as e:
        return _json({"detail": config.mask_secrets(e.detail)}, e.status, {"Cache-Control": "no-store", **e.headers})
