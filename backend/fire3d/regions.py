"""State, county, time zone and coverage at a point, offline (brief 3, CONTRACT 14.3). Owner: us-catalog.

Data (public domain, built by ``scripts/build_us_regions.py``; sources and dates in each file's ``meta``):

* ``data/us_states.geojson``: the 48 states + DC (Census TIGERweb ``State_County/MapServer/0``, 0.005 degrees). The
  polygons include near-shore water (the Great Lakes are split at the international line).
* ``data/us_counties.geojson``: counties of the 48 states + DC (TIGERweb ``State_County/MapServer/1``, 0.01 degrees).
* ``data/us_timezones.geojson``: USDOT BTS NTAD Time Zones (Eastern, Central, Mountain, Pacific) plus the Navajo Nation
  and Hopi Reservation (TIGERweb ``AIANNHA/MapServer/2``).

IANA mapping: Pacific -> America/Los_Angeles, Mountain -> America/Denver, Central -> America/Chicago, Eastern ->
America/New_York; Arizona -> America/Phoenix except the Navajo Nation (America/Denver) and the Hopi Reservation inside
it (America/Phoenix). Alaska, Hawaii and the territories are recognised by documented coarse boxes
(:data:`OUTSIDE_L48_BOXES`); they are never "lower48".

Everything is lazy-loaded once (shapely STRtree), thread-safe, and makes no network request.
"""

from __future__ import annotations

import math
import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import orjson

DATA_DIR = Path(__file__).resolve().parent / "data"
STATES_FILE = DATA_DIR / "us_states.geojson"
COUNTIES_FILE = DATA_DIR / "us_counties.geojson"
TIMEZONES_FILE = DATA_DIR / "us_timezones.geojson"

L48: tuple[str, ...] = (
    "AL", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
    "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
)
STATE_NAMES: dict[str, str] = {
    "AL": "Alabama", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado", "CT": "Connecticut",
    "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
    "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
    "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    # not supported (kept so messages can name them)
    "AK": "Alaska", "HI": "Hawaii", "PR": "Puerto Rico", "VI": "U.S. Virgin Islands", "GU": "Guam",
    "MP": "Northern Mariana Islands", "AS": "American Samoa",
}
# The zone most of each state's people live in (fallback when a point misses the zone polygons).
MAIN_ZONE: dict[str, str] = {
    **{s: "America/New_York" for s in ("CT", "DE", "DC", "FL", "GA", "IN", "KY", "ME", "MD", "MA", "MI", "NH", "NJ",
                                         "NY", "NC", "OH", "PA", "RI", "SC", "VT", "VA", "WV")},
    **{s: "America/Chicago" for s in ("AL", "AR", "IL", "IA", "KS", "LA", "MN", "MS", "MO", "NE", "ND", "OK", "SD",
                                        "TN", "TX", "WI")},
    **{s: "America/Denver" for s in ("CO", "ID", "MT", "NM", "UT", "WY")},
    "AZ": "America/Phoenix",
    **{s: "America/Los_Angeles" for s in ("CA", "NV", "OR", "WA")},
    # not supported yet; named so a resolved record still carries its own zone (never Pacific by default)
    "AK": "America/Anchorage", "HI": "Pacific/Honolulu", "PR": "America/Puerto_Rico", "VI": "America/St_Thomas",
    "GU": "Pacific/Guam", "MP": "Pacific/Saipan", "AS": "Pacific/Pago_Pago",
}
ZONE_NAMES: dict[str, str] = {
    "America/Los_Angeles": "Pacific Time", "America/Denver": "Mountain Time", "America/Phoenix": "Mountain Time",
    "America/Boise": "Mountain Time", "America/Chicago": "Central Time", "America/New_York": "Eastern Time",
    "America/Detroit": "Eastern Time", "America/Indiana/Indianapolis": "Eastern Time",
}
# Coarse boxes (w, s, e, n) of the places Fire-3d does not support yet (CONTRACT 14.3); generous on the ocean side.
OUTSIDE_L48_BOXES: tuple[tuple[str, tuple[float, float, float, float]], ...] = (
    ("alaska", (-179.99, 51.0, -129.9, 71.6)),
    ("alaska", (172.0, 51.0, 180.0, 53.2)),           # western Aleutians (east of 180)
    ("hawaii", (-178.5, 18.7, -154.6, 28.5)),          # main islands to Kure Atoll
    ("territory", (-67.35, 17.8, -65.2, 18.6)),        # Puerto Rico
    ("territory", (-65.1, 17.6, -64.5, 18.45)),        # U.S. Virgin Islands
    ("territory", (144.55, 13.2, 145.0, 13.7)),        # Guam
    ("territory", (145.05, 14.05, 146.1, 20.6)),       # Northern Mariana Islands
    ("territory", (-171.2, -14.6, -168.1, -11.0)),     # American Samoa
)
STATE_MAX_KM = 5.0          # state_at / time_zone_at: nearest polygon within this distance
# coverage_at: lower 48 inside the state polygons or within this distance of them. The TIGERweb state polygons
# already include near-shore water, so this only absorbs the 0.005-degree simplification (~0.5 km); 5 km would put
# central Tijuana (2.0 km south of the border) and Windsor, ON (2.8 km from Detroit) in the United States.
COVERAGE_TOLERANCE_KM = 1.0
COUNTY_MAX_KM = 2.0
KM_PER_DEG = 111.32

NOT_SUPPORTED_NOTE = "Fire-3d does not support Alaska, Hawaii or US territories yet."
OUTSIDE_US_NOTE = "Outside the United States: Fire-3d has no data here."

Coverage = Literal["lower48", "alaska", "hawaii", "territory", "outside_us"]


@dataclass(frozen=True)
class County:
    fips: str           # "41029"
    name: str           # "Jackson County"
    state: str          # "OR"


# ------------------------------------------------------------------------------------------------------------------
# Loading
# ------------------------------------------------------------------------------------------------------------------
class _Layer:
    """Shapes + properties of one GeoJSON file with an STRtree (built on first use)."""

    def __init__(self, path: Path):
        import shapely
        from shapely.geometry import shape

        fc = orjson.loads(path.read_bytes())
        self.props: list[dict[str, Any]] = [f["properties"] for f in fc["features"]]
        self.geoms = [shape(f["geometry"]) for f in fc["features"]]
        for g in self.geoms:
            shapely.prepare(g)
        self.tree = shapely.STRtree(self.geoms)
        self.meta: dict[str, Any] = fc.get("meta") or {}

    def containing(self, lon: float, lat: float) -> list[int]:
        from shapely.geometry import Point

        return [int(i) for i in self.tree.query(Point(lon, lat), predicate="intersects")]

    def nearest_within(self, lon: float, lat: float, max_km: float) -> tuple[int, float] | None:
        """Index and distance (km) of the nearest shape within ``max_km`` (an equirectangular distance at ``lat``)."""
        from shapely.geometry import Point, box
        from shapely.ops import nearest_points

        if max_km <= 0:
            return None
        dlat = max_km / KM_PER_DEG
        dlon = max_km / (KM_PER_DEG * max(0.05, math.cos(math.radians(lat))))
        pt = Point(lon, lat)
        best: tuple[int, float] | None = None
        for i in self.tree.query(box(lon - dlon, lat - dlat, lon + dlon, lat + dlat)):
            q = nearest_points(self.geoms[int(i)], pt)[0]
            d = _km(lon, lat, q.x, q.y)
            if d <= max_km and (best is None or d < best[1]):
                best = (int(i), d)
        return best

    def intersecting(self, bbox: tuple[float, float, float, float]) -> list[int]:
        from shapely.geometry import box

        return [int(i) for i in self.tree.query(box(*bbox), predicate="intersects")]


_lock = threading.Lock()
_layers: dict[str, _Layer] = {}
REGIONS_UNAVAILABLE_TEXT = ("Fire-3d's region files (states, counties and time zones) could not be read on this server, "
                            "so the state, county and time zone are unknown here. Reinstall Fire-3d.")


class RegionsUnavailable(RuntimeError):
    """A bundled region file is missing or unreadable (a broken installation, never a provider outage). The API
    answers 503 with :data:`REGIONS_UNAVAILABLE_TEXT` (final verification, panel SR-m3), never a 500."""


def _layer(name: str) -> _Layer:
    with _lock:
        lay = _layers.get(name)
        if lay is None:
            path = {"states": STATES_FILE, "counties": COUNTIES_FILE, "timezones": TIMEZONES_FILE}[name]
            try:
                lay = _Layer(path)
            except (OSError, ValueError, KeyError, TypeError) as e:
                raise RegionsUnavailable(f"region file {path.name} could not be read: {type(e).__name__}") from None
            _layers[name] = lay
        return lay


def _km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    k = math.cos(math.radians((lat1 + lat2) / 2.0))
    return math.hypot((lon2 - lon1) * k, lat2 - lat1) * KM_PER_DEG


def _ok(lon: Any, lat: Any) -> bool:
    try:
        return math.isfinite(float(lon)) and math.isfinite(float(lat)) and -180 <= float(lon) <= 180 and -90 <= float(lat) <= 90
    except (TypeError, ValueError):
        return False


def _expand(bbox: tuple[float, float, float, float], margin_km: float) -> tuple[float, float, float, float]:
    w, s, e, n = (float(v) for v in bbox)
    if margin_km <= 0:
        return (w, s, e, n)
    lat = (s + n) / 2.0
    dlat = margin_km / KM_PER_DEG
    dlon = margin_km / (KM_PER_DEG * max(0.05, math.cos(math.radians(lat))))
    return (w - dlon, s - dlat, e + dlon, n + dlat)


# ------------------------------------------------------------------------------------------------------------------
# Public API (CONTRACT 14.3)
# ------------------------------------------------------------------------------------------------------------------
@lru_cache(maxsize=65536)
def state_at(lon: float, lat: float, *, max_km: float = STATE_MAX_KM) -> str | None:
    """USPS code of the lower-48 state (or DC) at the point, else of the nearest one within ``max_km``; None off L48."""
    if not _ok(lon, lat):
        return None
    lay = _layer("states")
    hits = lay.containing(float(lon), float(lat))
    if hits:
        return str(lay.props[hits[0]]["state"])
    near = lay.nearest_within(float(lon), float(lat), max_km)
    return str(lay.props[near[0]]["state"]) if near else None


def states_in_bbox(bbox: tuple[float, float, float, float], margin_km: float = 0.0) -> list[str]:
    """Sorted USPS codes of the lower-48 states (and DC) that the bbox (w, s, e, n), grown by ``margin_km``, touches."""
    lay = _layer("states")
    return sorted({str(lay.props[i]["state"]) for i in lay.intersecting(_expand(bbox, margin_km))})


@lru_cache(maxsize=65536)
def county_at(lon: float, lat: float) -> County | None:
    """The county (or county equivalent) at the point, else the nearest within 2 km; None off L48."""
    if not _ok(lon, lat):
        return None
    lay = _layer("counties")
    hits = lay.containing(float(lon), float(lat))
    i = hits[0] if hits else (lay.nearest_within(float(lon), float(lat), COUNTY_MAX_KM) or (None,))[0]
    if i is None:
        return None
    p = lay.props[i]
    return County(fips=str(p["fips"]), name=str(p["name"]), state=str(p["state"]))


def counties_in_bbox(bbox: tuple[float, float, float, float], margin_km: float = 0.0) -> list[County]:
    """Counties the bbox (grown by ``margin_km``) touches, sorted by FIPS."""
    lay = _layer("counties")
    out = {str(lay.props[i]["fips"]): lay.props[i] for i in lay.intersecting(_expand(bbox, margin_km))}
    return [County(fips=f, name=str(p["name"]), state=str(p["state"])) for f, p in sorted(out.items())]


def same_codes(counties: list[County]) -> list[str]:
    """IPAWS SAME location codes of whole counties: "0" + the 5-digit county FIPS ("041029")."""
    return ["0" + c.fips for c in counties]


@lru_cache(maxsize=65536)
def time_zone_at(lon: float, lat: float) -> str | None:
    """IANA zone at the point (Arizona, Navajo Nation and Hopi rules in the module doc): the zone containing it, else
    the nearest within 5 km, else the state's main zone; None off the lower 48."""
    if not _ok(lon, lat):
        return None
    lon, lat = float(lon), float(lat)
    lay = _layer("timezones")
    hits = lay.containing(lon, lat)
    if hits:
        best = max(hits, key=lambda i: int(lay.props[i].get("priority") or 0))
    else:
        if state_at(lon, lat) is None:
            return None
        near = lay.nearest_within(lon, lat, STATE_MAX_KM)
        best = near[0] if near else None
    st = state_at(lon, lat)
    if best is None:
        return MAIN_ZONE.get(st) if st else None
    p = lay.props[best]
    tz = str(p["tz"])
    if p.get("kind") == "ntad" and tz == "America/Denver" and st == "AZ":
        return "America/Phoenix"               # Arizona keeps standard time all year (outside the Navajo Nation)
    return tz


def main_zone(state: str) -> str:
    """The IANA zone most of the state's people live in ("UTC" for an unknown code)."""
    return MAIN_ZONE.get(str(state or "").upper(), "UTC")


def zone_name(tz: str) -> str:
    """"Pacific Time", "Mountain Time", "Central Time", "Eastern Time" (other zones: the IANA name)."""
    return ZONE_NAMES.get(str(tz or ""), str(tz or ""))


def coverage_at(lon: float, lat: float) -> Coverage:
    """"lower48" inside (or within 1 km of) the state polygons; "alaska" / "hawaii" / "territory" by the coarse
    boxes; else "outside_us"."""
    if not _ok(lon, lat):
        return "outside_us"
    if state_at(float(lon), float(lat), max_km=COVERAGE_TOLERANCE_KM) is not None:
        return "lower48"
    for kind, (w, s, e, n) in OUTSIDE_L48_BOXES:
        if w <= float(lon) <= e and s <= float(lat) <= n:
            return kind  # type: ignore[return-value]
    return "outside_us"


def lookup(lon: float, lat: float) -> dict[str, Any]:
    """The ``GET /api/geo/lookup`` body (``contracts.GeoLookup``)."""
    lon, lat = float(lon), float(lat)
    cov = coverage_at(lon, lat)
    out: dict[str, Any] = {"lon": lon, "lat": lat, "coverage": cov, "supported": cov == "lower48", "state": None,
                           "state_name": None, "county": None, "time_zone": None, "time_zone_name": None, "note": None}
    if cov != "lower48":
        out["note"] = OUTSIDE_US_NOTE if cov == "outside_us" else NOT_SUPPORTED_NOTE
        return out
    st = state_at(lon, lat, max_km=COVERAGE_TOLERANCE_KM)
    c = county_at(lon, lat)
    tz = time_zone_at(lon, lat) or main_zone(st or "")
    out.update(state=st, state_name=STATE_NAMES.get(st or ""), time_zone=tz, time_zone_name=zone_name(tz),
               county={"fips": c.fips, "name": c.name} if c is not None and c.state == st else None)
    return out


def in_lower48(lon: Any, lat: Any) -> Any:
    """Vectorized: a boolean numpy array, True for points inside the lower-48 + DC state polygons (no tolerance;
    the polygons include near-shore water). Used for national detection totals."""
    import numpy as np
    import shapely

    lo = np.asarray(lon, dtype=np.float64).ravel()
    la = np.asarray(lat, dtype=np.float64).ravel()
    out = np.zeros(lo.shape, dtype=bool)
    if lo.size:
        idx = _layer("states").tree.query(shapely.points(lo, la), predicate="intersects")[0]
        out[np.unique(idx)] = True
    return out


def is_supported_state(state: str | None) -> bool:
    """True for the 48 states + DC (USPS codes)."""
    return str(state or "").upper() in L48


def sources_meta() -> dict[str, Any]:
    """The ``meta`` of the three region files (sources, licences, retrieval dates)."""
    return {k: _layer(k).meta for k in ("states", "counties", "timezones")}
