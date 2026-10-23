"""Address lookup for the map-first UI: a caching proxy for the US Census Geocoder (docs/redesign/BRIEF.md section 8,
docs/redesign/CONTRACT.md section 6), plus local US town, county and ZIP matches (brief 2 C-R5; national since brief 3,
CONTRACT 14.10). Owned by us-catalog in brief 3; app.py mounts ``router``.

``GET /api/geocode?q=<one-line US street address | US city, town, CDP or county ("Boise, ID") | ZIP code ("83702")>``

* Street addresses (text that starts with a house number) go upstream to the Census Geocoder
  ``locations/onelineaddress`` search (no geographies lookup), ``format=json``, with the current documented benchmark
  ``Public_AR_Current`` (id 4, "Public Address Ranges - Current Benchmark", the default; checked 2026-10-17 on
  Geocoding_Services_API.html and /geocoder/benchmarks). No API key. ``FIRE3D_GEOCODER_URL`` /
  ``FIRE3D_GEOCODER_BENCHMARK`` override the endpoint and benchmark.
* Census positions are calculated along TIGER/Line address ranges, not rooftops: every response says so, and the
  matched range (``from_address``..``to_address``) and street side are passed on.
* Town, county names and ZIP codes are matched locally in ``fire3d/data/gazetteer_us.json`` (built by
  ``scripts/build_gazetteer.py`` from the public-domain U.S. Census Bureau Gazetteer Files: the places, counties and ZIP
  Code Tabulation Areas of every state; Alaska, Hawaii and territory rows are kept and flagged ``supported: false`` with
  "Fire-3d does not support Alaska, Hawaii or US territories yet."). A trailing state ("Springfield, IL",
  "Springfield IL", "83702 ID", "ID 83702") narrows the search; a bare name lists the largest matches across states.
  Each local match carries ``state``, ``state_name``, ``county``, ``supported`` and ``"<Name>, <ST>"`` names. No
  upstream call is made for them. Positions are each area's Census internal point
  (approximate: "town center", "ZIP area"); ZCTAs approximate USPS ZIP codes and PO-box-only ZIP codes are missing.
* Only explicitly submitted queries: no autocomplete, no POI search, no Nominatim. Coordinate-like queries are
  refused (the browser resolves coordinates itself; they are never sent upstream).
* Census requests go through ``fire3d.http`` (identifying User-Agent, shared concurrency cap, one retry, secret-free
  errors) and are cached for 30 days, keyed by the normalised query (NFKC, trimmed, whitespace collapsed,
  case-folded): on disk by ``fire3d.http`` and in memory (bounded LRU of parsed replies). Only parseable replies are
  kept; a cached reply that fails to parse is fetched again once. Cache misses are limited to
  ``UPSTREAM_PER_MINUTE`` upstream requests per process (429 beyond that).
* Every reply says what it is: top-level ``kind`` (``address`` | ``place`` | ``zip``) and ``local``, and each match
  carries ``kind``. Local matches add ``name``, ``place_type`` (``city`` | ``town`` | ``cdp``; places), ``zip``
  (ZIP areas), ``land_km2``, ``exact`` and ``near`` / ``near_km`` (the nearest other place, to tell same-named places
  apart and to name a ZIP area). ``benchmark`` is null for local replies, which add ``vintage``.
* Errors (``{"detail": ...}``): 400 empty, too long, coordinates or neither an address, a town nor a ZIP code; 429 own
  rate limit; 502 upstream error or unparseable reply; 503 town and ZIP search unavailable (index missing); 504
  upstream timeout. Messages never include upstream bodies (at most Census's own short error text).
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
from dataclasses import dataclass
from pathlib import Path
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
        raise GeocodeError(400, f"Enter a US street address, town, county or ZIP code ({EXAMPLES}).")
    if len(q) > MAX_QUERY_CHARS:
        raise GeocodeError(400, f"The address is too long (at most {MAX_QUERY_CHARS} characters).")
    if looks_like_coordinates(q):
        raise GeocodeError(400, "This looks like coordinates. Coordinates are located in the app and are never sent to the address service.")
    return q


# A US street address starts with a house number followed by a street word ("600 E Mariposa St"), including grid
# styles such as "N1234 County Rd" or "100-12 Main St" (the web client uses the same rule).
_STREET = re.compile(r"^\s*(?:[NSEW]\s?)?\d+[A-Z]?(?:[-/]\d+[A-Z]?)?\s+[A-Z0-9]", re.IGNORECASE)


def looks_like_street_address(q: str) -> bool:
    return bool(_STREET.match(q)) and bool(re.search(r"[^\W\d_]{2,}", q))


# ------------------------------------------------------------------------------------------------------------------
# Towns, cities and ZIP areas: the local Census Gazetteer index (no upstream calls)
# ------------------------------------------------------------------------------------------------------------------
GAZETTEER_PATH = Path(__file__).resolve().parents[1] / "data" / "gazetteer_us.json"
GAZETTEER_SOURCE = "U.S. Census Bureau Gazetteer Files"
PLACE_LIMIT = 8                      # place candidates returned (total_matches gives the full count)
NEAR_MAX_KM = 25.0                   # "near <place>" only within this distance
PLACE_TYPE_LABEL = {"city": "city", "town": "town", "village": "village", "borough": "borough",
                    "municipality": "municipality", "government": "consolidated city-county", "county": "county",
                    "cdp": "census-designated place", "comunidad": "comunidad (Puerto Rico)",
                    "zona_urbana": "zona urbana (Puerto Rico)", "place": "place"}
_TYPE_RANK = {"city": 0, "government": 0, "town": 1, "village": 2, "borough": 2, "municipality": 2, "county": 3,
              "cdp": 4, "comunidad": 5, "zona_urbana": 5, "place": 6}
_SYNONYMS = {"mount": "mt", "saint": "st", "fort": "ft"}
_COUNTRY_WORDS = {"usa", "us"}
EXAMPLES = "e.g. 600 E Mariposa St, Altadena; Boise, ID; 83702"
NOT_SUPPORTED_NOTE = "Fire-3d does not support Alaska, Hawaii or US territories yet."
PLACE_NOTE = ("Town positions are the Census Bureau's internal point of the area (approximate), not a street address. "
              "To check a spot, enter a street address with a house number or click the map.")
ZIP_NOTE = ("ZIP areas are Census ZIP Code Tabulation Areas, which approximate USPS ZIP codes (PO-box-only ZIP codes "
            "are not included). The position is the area's internal point (approximate).")
NO_MATCH_TAIL = (" Landmarks, businesses and street names without a house number are not searched (" + EXAMPLES + ").")


def no_match_note(q: str) -> str:
    """CONTRACT 14.10: "No US city, town, county or ZIP code matches '<q>'." plus what is searched."""
    return f"No US city, town, county or ZIP code matches '{q}'." + NO_MATCH_TAIL


def fold(s: str) -> str:
    """Accents removed, case-folded, punctuation as spaces, whitespace collapsed ("La Cañada-Flintridge" ->
    "la canada flintridge")."""
    s = "".join(ch for ch in unicodedata.normalize("NFKD", s) if not unicodedata.combining(ch))
    return re.sub(r"[^0-9a-z]+", " ", s.casefold()).strip()


def words(s: str) -> tuple[str, ...]:
    return tuple(_SYNONYMS.get(w, w) for w in fold(s).split())


def _state_names() -> dict[tuple[str, ...], str]:
    from .. import regions

    out: dict[tuple[str, ...], str] = {}
    for code, name in regions.STATE_NAMES.items():
        out[(code.lower(),)] = code
        out[tuple(fold(name).split())] = code
    out[("calif",)] = "CA"
    out[("d", "c")] = "DC"
    out[("washington", "d", "c")] = "DC"
    return out


_STATE_WORDS = _state_names()
_STATE_MAX_WORDS = max(len(k) for k in _STATE_WORDS)


def _state_supported(state: str | None) -> bool:
    from .. import regions

    return regions.is_supported_state(state)


@dataclass(frozen=True)
class Place:
    name: str
    type: str
    state: str
    lat: float
    lon: float
    land_km2: float
    county: str | None
    words: tuple[str, ...]
    alt: tuple[str, ...] | None       # the name in parentheses ("San Buenaventura (Ventura)" -> ventura) or the alias
    main: tuple[str, ...] | None      # the name without it ("san buenaventura")


@dataclass(frozen=True)
class ZipArea:
    zip: str
    state: str
    lat: float
    lon: float
    land_km2: float


class Gazetteer:
    def __init__(self, raw: dict[str, Any]):
        self.vintage = int(raw["vintage"])
        self.retrieved_ms = _date_ms(raw.get("retrieved"))
        self.places: list[Place] = []
        for row in raw["places"]:
            name, kind, state, lat, lon, area, county = row[:7]
            alias = row[7] if len(row) > 7 else None
            m = re.match(r"^(.*?)\s*\(([^)]+)\)\s*$", name)
            alt = words(m.group(2)) if m else (words(alias) if alias else None)
            self.places.append(Place(name, kind, state, float(lat), float(lon), float(area), county, words(name), alt,
                                     words(m.group(1)) if m else None))
        self.zips: dict[str, ZipArea] = {z: ZipArea(z, st, float(lat), float(lon), float(area)) for z, st, lat, lon, area in raw["zips"]}
        self.by_state: dict[str, list[Place]] = {}
        counts: dict[tuple[str, tuple[str, ...]], int] = {}
        for p in self.places:
            self.by_state.setdefault(p.state, []).append(p)
            counts[(p.state, p.words)] = counts.get((p.state, p.words), 0) + 1
        self.shared_names = {k for k, n in counts.items() if n > 1}

    def nearest_place(self, lat: float, lon: float, state: str, exclude: Place | None = None,
                      incorporated: bool = False) -> tuple[Place, float] | None:
        """The nearest place of ``state`` (cities and towns only with ``incorporated``; never a county)."""
        best: tuple[Place, float] | None = None
        for p in self.by_state.get(state, []):
            if p is exclude or p.type == "county" or (incorporated and p.type not in ("city", "town", "village", "borough", "government")):
                continue
            d = _km(lat, lon, p.lat, p.lon)
            if best is None or d < best[1]:
                best = (p, d)
        return best


def _date_ms(s: Any) -> int:
    try:
        return int(time.mktime(time.strptime(str(s), "%Y-%m-%d")) * 1000)
    except (TypeError, ValueError):
        return 0


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance (km); plenty for labels such as "near Altadena"."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(min(1.0, math.sqrt(a)))


_gazetteer: Gazetteer | None = None
_gazetteer_error: str | None = None
_gazetteer_lock = threading.Lock()


def gazetteer() -> Gazetteer | None:
    """The local index, loaded once (None, logged once, when the file is missing or unreadable)."""
    global _gazetteer, _gazetteer_error
    with _gazetteer_lock:
        if _gazetteer is None and _gazetteer_error is None:
            try:
                _gazetteer = Gazetteer(orjson.loads(GAZETTEER_PATH.read_bytes()))
            except (OSError, ValueError, KeyError, TypeError) as e:
                _gazetteer_error = type(e).__name__
                log.warning("town and ZIP search unavailable: %s (%s); run scripts/build_gazetteer.py", GAZETTEER_PATH.name, _gazetteer_error)
        return _gazetteer


def reset_gazetteer() -> None:
    """Forget the loaded index (tests)."""
    global _gazetteer, _gazetteer_error
    with _gazetteer_lock:
        _gazetteer, _gazetteer_error = None, None


def _take_state(t: list[str]) -> str | None:
    """Pop trailing state words ("ID", "Idaho", "New Mexico") from ``t`` when a name stays in front of them."""
    for n in range(min(_STATE_MAX_WORDS, len(t) - 1), 0, -1):
        code = _STATE_WORDS.get(tuple(t[-n:]))
        if code:
            del t[-n:]
            return code
    return None


def split_local(q: str) -> tuple[tuple[str, ...], str | None]:
    """(place words, ZIP) of a query that is not a street address (see :func:`split_query` for the state)."""
    name, zip5, _ = split_query(q)
    return name, zip5


def split_query(q: str) -> tuple[tuple[str, ...], str | None, str | None]:
    """(place words, ZIP, state) of a query that is not a street address: a trailing 5-digit ZIP (or ZIP+4), a state
    ("Springfield, IL", "Springfield IL", "Springfield, Illinois", "83702 ID", "ID 83702") and "USA" are taken off; a
    name that is only a state word is kept ("California" still finds California City; "Washington" finds the towns)."""
    t = list(words(q))
    while len(t) > 1 and t[-1] in _COUNTRY_WORDS:
        t.pop()
    zip5 = None
    state = None
    if t and re.fullmatch(r"\d{5}", t[-1]):
        zip5 = t.pop()
    elif len(t) >= 2 and re.fullmatch(r"\d{4}", t[-1]) and re.fullmatch(r"\d{5}", t[-2]):
        zip5 = t[-2]
        del t[-2:]
    if t and zip5 and _STATE_WORDS.get(tuple(t)):         # "ID 83702", "Idaho 83702"
        state, t = _STATE_WORDS[tuple(t)], []
    elif zip5 is None and len(t) >= 2 and re.fullmatch(r"\d{5}", t[-2]) and _STATE_WORDS.get((t[-1],)):   # "83702 ID"
        zip5, state = t[-2], _STATE_WORDS[(t[-1],)]
        del t[-2:]
    while len(t) > 1 and t[-1] in _COUNTRY_WORDS:
        t.pop()
    if state is None and t:
        state = _take_state(t)
    if zip5 and t and len(t) <= _STATE_MAX_WORDS and _STATE_WORDS.get(tuple(t)):   # "CA 91001"
        state = state or _STATE_WORDS[tuple(t)]
        t = []
    return tuple(t), zip5, state


def _place_score(p: Place, q: tuple[str, ...]) -> int:
    """The best of: exact name 100 (the name in parentheses or a known common name 96, the name without it 94), name
    prefix 80 / 76 / 74, every query word starting a word of the name 60; 0 when nothing matches."""
    best = 0
    for name, exact, prefix in ((p.words, 100, 80), (p.alt, 96, 76), (p.main, 94, 74)):
        if not name:
            continue
        if name == q:
            best = max(best, exact)
        elif len(q) <= len(name) and name[: len(q) - 1] == q[:-1] and name[len(q) - 1].startswith(q[-1]):
            best = max(best, prefix)
    if not best and all(any(w.startswith(x) for w in p.words) for x in q):
        best = 60
    return best


def search_places(g: Gazetteer, q: tuple[str, ...], state: str | None = None) -> list[tuple[Place, int]]:
    """Places (and counties) whose name matches every query word (each starts a word of the name), best first: exact
    name (also the name in parentheses or a known common name), then name prefix, then all words; ties by city >
    town > village > county > CDP, then larger area. ``state`` keeps one state's places."""
    if not q:
        return []
    pool = g.by_state.get(state, []) if state else g.places
    hits = [(p, s) for p in pool if (s := _place_score(p, q)) > 0]
    hits.sort(key=lambda h: (-h[1], _TYPE_RANK.get(h[0].type, 9), -h[0].land_km2, h[0].state, h[0].name))
    return hits


def _state_fields(state: str) -> dict[str, Any]:
    from .. import regions

    supported = _state_supported(state)
    return {"state": state, "state_name": regions.STATE_NAMES.get(state), "supported": supported,
            "note": None if supported else NOT_SUPPORTED_NOTE}


def _place_match(g: Gazetteer, p: Place, score: int) -> dict[str, Any]:
    near = None
    if (p.state, p.words) in g.shared_names and p.type != "county":   # same-named places of one state: the nearest town
        near = g.nearest_place(p.lat, p.lon, p.state, exclude=p, incorporated=True) or g.nearest_place(p.lat, p.lon, p.state, exclude=p)
    return {
        "kind": "place", "matched_address": f"{p.name}, {p.state}", "name": f"{p.name}, {p.state}", "place_type": p.type,
        "place_type_label": PLACE_TYPE_LABEL.get(p.type, "place"), "lat": p.lat, "lon": p.lon, "land_km2": p.land_km2,
        "exact": score >= 94, "near": near[0].name if near else None, "near_km": round(near[1], 1) if near else None,
        "county": p.county if p.type != "county" else p.name, **_state_fields(p.state),
        "tiger_line_id": None, "side": None, "from_address": None, "to_address": None,
    }


def _zip_match(g: Gazetteer, z: ZipArea) -> dict[str, Any]:
    from .. import regions

    near = g.nearest_place(z.lat, z.lon, z.state)
    near = near if near and near[1] <= NEAR_MAX_KM else None
    c = regions.county_at(z.lon, z.lat) if _state_supported(z.state) else None
    return {
        "kind": "zip", "matched_address": f"ZIP {z.zip}, {z.state}", "name": f"ZIP {z.zip}, {z.state}", "zip": z.zip,
        "lat": z.lat, "lon": z.lon, "land_km2": z.land_km2, "exact": True, "near": near[0].name if near else None,
        "near_km": round(near[1], 1) if near else None, "place_type": "zip", "place_type_label": "ZIP area",
        "county": c.name if c is not None and c.state == z.state else None, **_state_fields(z.state),
        "tiger_line_id": None, "side": None, "from_address": None, "to_address": None,
    }


def local_lookup(q: str, zip_only: bool) -> dict[str, Any]:
    """The reply for a town, county or ZIP query (no upstream call); raises GeocodeError 503 without the index."""
    g = gazetteer()
    if g is None:
        raise GeocodeError(503, "Town and ZIP search is not available on this server. Enter a street address with a "
                                "house number, or click the map.")
    name, zip5, state = split_query(q)
    matches: list[dict[str, Any]] = []
    place_total = 0
    if name and not zip_only:
        hits = search_places(g, name, state)
        place_total = len(hits)
        matches = [_place_match(g, p, sc) for p, sc in hits[:PLACE_LIMIT]]
    z = g.zips.get(zip5) if zip5 else None
    if z:
        matches.append(_zip_match(g, z))          # "Altadena, CA 91001": the town first, then its ZIP area
    total = place_total + (1 if z else 0)
    kind = "zip" if zip_only or (z and not place_total) else "place"
    if matches:
        note = ZIP_NOTE if kind == "zip" else PLACE_NOTE
        if any(not m["supported"] for m in matches):
            note = f"{note} {NOT_SUPPORTED_NOTE}"
    else:
        note = no_match_note(q)
    return {
        "query": q, "kind": kind, "local": True, "matches": matches, "total_matches": total, "benchmark": None,
        "vintage": g.vintage, "source": GAZETTEER_SOURCE,
        "attribution": f"Towns, counties and ZIP areas: {GAZETTEER_SOURCE} ({g.vintage}, public domain)",
        "note": note, "cached": False, "fetched_ms": g.retrieved_ms,
    }


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
            "kind": "address",
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
    """The /api/geocode reply for a raw query; raises GeocodeError. ZIP codes and text without a house number are
    matched locally (towns and ZIP areas); street addresses go to the Census Geocoder."""
    q = validate_query(raw_query)
    name, zip5, _state = split_query(q)
    if zip5 and not name:
        return local_lookup(q, zip_only=True)
    if not looks_like_street_address(q):
        if not re.search(r"[^\W\d_]", q):
            raise GeocodeError(400, f"Enter a street address with a house number, a US town, county or ZIP code ({EXAMPLES}).")
        return local_lookup(q, zip_only=False)
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
        "kind": "address",
        "local": False,
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
def geocode(q: str = Query("", description="One-line US street address (house number, street, city/state or ZIP), "
                                           "or a US city, town, county or ZIP code ('Boise, ID', 'Springfield IL', '83702')")) -> Response:
    """Census Geocoder lookup of an explicitly submitted US street address (approximate, interpolated positions), or
    local US town, county and ZIP-area matches from the Census Gazetteer (approximate internal points)."""
    try:
        return _json(lookup(q), 200, {"Cache-Control": CACHE_CONTROL_OK})
    except GeocodeError as e:
        return _json({"detail": config.mask_secrets(e.detail)}, e.status, {"Cache-Control": "no-store", **e.headers})
