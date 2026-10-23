"""Incident catalog: the national fire list (brief 3, CONTRACT 14.1-14.2; SPEC 4.4, 6, 8.1). Owner: us-catalog.

Sources: NIFC WFIGS (IRWIN) for the lower 48 states + DC (``sources.wfigs``) and CAL FIRE for California
(``sources.calfire``), merged so that CAL FIRE stays the record in California and WFIGS adds only the California fires
CAL FIRE does not list (BRIEF-3 round 2 item 2, round 3 items 2-3):

* **Live** (``mode="live"``): every active wildfire in the lower 48, whatever its size: CAL FIRE's active fires in
  California, the CAL FIRE fires that a matched NIFC record calls active (:data:`CA_ACTIVE_RULE` "either"), and every
  WFIGS Current wildfire with ``PercentContained`` null or < 100 that is not a CAL FIRE fire. Sorted by
  ``detections_24h`` (the keyless 24 h FIRMS feeds near the fire) then acres.
* **Historical** (``mode="historical"``): the wildfires of ``year`` (default: the current UTC year) of ``min_acres``
  (default 300) or more: CAL FIRE's year list in California plus the WFIGS year list (YearToDate for the current
  year, the all-years layer for past years); every row keeps mode "historical" (``is_active`` says whether a record
  still calls the fire active). Sorted by acres.
* Never listed: prescribed burns (RX) and complex parents (CX) (``IncidentTypeCategory='WF'`` server-side and here),
  Alaska, Hawaii, territories and foreign ``POOState`` values. ``POOState`` decides the state; the state polygons only
  fill a missing one (nearest state within 5 km). Complex members outside California are listed on their own with
  ``complex_name``; a California complex keeps CAL FIRE's one row (:data:`CA_COMPLEX_ROWS` "calfire") with its
  members in ``complex_members`` / ``other_records``.
* California merge: a WFIGS-CA row is dropped when (1) its ``CpxName`` equals a CAL FIRE complex name, or (2) it is the
  same fire as a CAL FIRE fire of that year or the year before (name tokens equal, <= 30 km, discovery -7/+20 days
  from CAL FIRE's start; or any name, <= 3 km, +/-3 days); (3) otherwise it is listed as a WFIGS row.
* WFIGS duplicates (same name tokens and state, size within 1 % (both reported, over 1 ac), <= 10 km, discovery <= 30
  days apart): the most recently modified row is kept and the dropped id is logged.
* Ids (SPEC 4.4): CAL FIRE rows ``{year}-{slug}-{UniqueId[:6]}`` (unchanged); WFIGS rows ``{UFI year}-{slug}-{IRWIN
  hex[:6]}``.
* Either source down: the other one still lists (``sources[]`` says which, with the CONTRACT 14.14 wording); both
  down raises (the API then lists the bundles on disk).

``bundle_status`` / ``bundle_built_ms`` come from ``DATA_DIR/incidents/{id}/manifest.json`` at call time. Base lists
are cached in memory (live 5 min, the current year 10 min, past years 1 h) on top of the fire3d.http cache;
``refresh=True`` refetches. Every CAL FIRE list this module fetches feeds the CAL FIRE status history
(``sources.calfire_history``).
"""

from __future__ import annotations

import logging
import math
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np
import orjson

from . import config
from .contracts import IncidentSummary, Mode, OtherRecord
from .grid import fallback_radius_m
from .timeutil import DAY_MS, HOUR_MS, now_ms

log = logging.getLogger(__name__)

# Switches (CONTRACT 14.2; one constant each)
CA_ACTIVE_RULE = "either"       # a California fire is active when CAL FIRE's or NIFC's record says so; "calfire" | "wfigs"
CA_COMPLEX_ROWS = "calfire"     # CAL FIRE's one row per California complex; "members" lists NIFC's member fires instead


def default_year() -> int:
    """The default year of historical lists: the current UTC year (brief 3)."""
    return time.gmtime().tm_year


DEFAULT_MIN_ACRES = 300.0
WFIGS_YEAR_FLOOR_ACRES = 100.0      # WFIGS year lists are never fetched below this size (a year has ~40,000 wildfires)
FIRE_TYPES = frozenset({"wildfire", "fire"})
LIVE_CACHE_S = 300.0
DEGRADED_CACHE_S = 60.0        # a list built while a source failed is rebuilt after this long (CONTRACT 14.16)
HISTORICAL_CACHE_S = 3600.0
CURRENT_YEAR_CACHE_S = 600.0
DET_RADIUS_MIN_M = 5000.0
DET_RADIUS_FACTOR = 2.0
DET_RADIUS_MAX_M = 25000.0
# California merge (CONTRACT 14.2) and WFIGS duplicates
MERGE_NAME_KM = 30.0
MERGE_NAME_DAYS = (-7.0, 20.0)
MERGE_ANY_KM = 3.0
MERGE_ANY_DAYS = 3.0
DUP_SIZE_FRAC = 0.01
DUP_MIN_ACRES = 1.0
DUP_KM = 10.0
DUP_DAYS = 30.0
# estimate_fire_bbox (SPEC 8.1)
BBOX_SEARCH_MIN_M = 10_000.0
BBOX_SEARCH_MAX_M = 40_000.0
BBOX_SEED_RADIUS_M = 3_000.0
BBOX_SEED_FALLBACK_M = 10_000.0
CLUSTER_EPS_M = 1_500.0
CLUSTER_EPS_MS = 2 * DAY_MS
CLUSTER_CELL_M = 300.0
CLUSTER_BIN_MS = 6 * HOUR_MS
FOOTPRINT_PAD_M = 300.0
HISTORICAL_MAX_DAYS = 45
LIVE_LOOKBACK_MS = 7 * DAY_MS
M_PER_DEG_LAT = 111_320.0

# Simplified California outline (lon, lat): land borders traced, generous on the ocean side. Used only for the
# California total (``LiveStatus.detections_24h_ca``).
CA_OUTLINE = ((-124.8, 42.0), (-120.0, 42.0), (-120.0, 39.0), (-114.633, 35.002), (-114.57, 34.83), (-114.13, 34.27),
              (-114.43, 34.08), (-114.52, 33.6), (-114.50, 33.03), (-114.72, 32.72), (-117.12, 32.53), (-118.6, 32.3),
              (-121.2, 33.6), (-124.8, 40.0))

CALFIRE_NAME = "CAL FIRE"
WFIGS_NAME = "NIFC WFIGS (IRWIN)"
WFIGS_DOWN = "The national fire list (NIFC) is unavailable right now; only California fires (CAL FIRE) are listed."
CALFIRE_DOWN = "CAL FIRE's list is unavailable right now; California fires are listed from NIFC WFIGS."
WFIGS_STALE = "The national fire list (NIFC) could not be refreshed right now; the copy shown was fetched earlier."
CALFIRE_STALE = "CAL FIRE's list could not be refreshed right now; the copy shown was fetched earlier."
ACCURACY_REGIONS = frozenset({"NWCC", "NRCC", "GBCC", "SWCC", "RMCC", "EACC", "ONCC", "OSCC"})
SOUTHERN_PLAINS = frozenset({"TX", "OK"})

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_ID_RE = re.compile(r"^(\d{4})-(.+)-([0-9a-f]{6})$")
_TOKEN_RE = re.compile(r"[a-z0-9]+")
_NAME_STOP = frozenset({"fire", "the", "incident", "wildfire"})
_lock = threading.Lock()
_cache: dict[str, tuple[float, list[IncidentSummary], list[dict]]] = {}
_live_total: dict[str, int | None] = {"n": None, "us": None}


# ------------------------------------------------------------------------------------------------------------------
# Ids and names
# ------------------------------------------------------------------------------------------------------------------
def slugify(name: str) -> str:
    """SPEC 4.4 slug: lowercase, strip, non-alphanumerics -> "-", repeats collapsed, "-" trimmed."""
    return _SLUG_RE.sub("-", str(name or "").strip().lower()).strip("-")


def make_incident_id(year: int, name: str, uid: str) -> str:
    """``2025-eaton-fire-dbfa57`` (year, slug of the name, first 6 chars of the CAL FIRE UniqueId or IRWIN id)."""
    return f"{int(year)}-{slugify(name) or 'incident'}-{str(uid).strip().lower()[:6]}"


def parse_incident_id(incident_id: str) -> tuple[int, str, str] | None:
    """``(year, slug, uid6)`` of a catalog id, or None (e.g. ``fixture-demo``)."""
    m = _ID_RE.match(str(incident_id or ""))
    return (int(m.group(1)), m.group(2), m.group(3)) if m else None


_APOSTROPHES = "'\u2019"
_CONTRACTION_TAILS = frozenset({"s", "t", "d", "ll", "re", "ve"})


def display_name(raw: Any) -> str:
    """A WFIGS name for display: ALL CAPS names are title-cased word by word ("BIG CLIFF" -> "Big Cliff", "O'NEIL" ->
    "O'Neil", "FD140011" -> "Fd140011", "2ND" -> "2nd"); a short run after an apostrophe stays lower case ("DEVIL'S
    CANYON" -> "Devil's Canyon", "DON'T" -> "Don't"); any other name is kept as it is (spaces collapsed)."""
    s = " ".join(str(raw or "").split())
    letters = [c for c in s if c.isalpha()]
    if not letters or not all(c.isupper() for c in letters):
        return s

    def cap(m: re.Match) -> str:
        w, i = m.group(0), m.start()
        if i >= 2 and s[i - 1] in _APOSTROPHES and s[i - 2].isalpha() and w.lower() in _CONTRACTION_TAILS:
            return w.lower()
        return w.capitalize() if i == 0 or not s[i - 1].isalnum() else w.lower()

    return re.sub(r"[A-Za-z]+", cap, s)


def name_tokens(name: Any) -> frozenset[str]:
    """Name tokens for the California merge: lower-case alphanumeric runs without "fire", "the", "incident",
    "wildfire" ("Eaton Fire" and "EATON" both give {"eaton"})."""
    toks = _TOKEN_RE.findall(str(name or "").lower())
    kept = frozenset(t for t in toks if t not in _NAME_STOP)
    return kept or frozenset(toks)


def norm_name(name: Any) -> str:
    """Case- and punctuation-insensitive name ("TCU SEPTEMBER LIGHTNING COMPLEX" == "TCU September Lightning Complex")."""
    return " ".join(_TOKEN_RE.findall(str(name or "").lower()))


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(min(1.0, max(0.0, a))))


# ------------------------------------------------------------------------------------------------------------------
# Records -> summaries
# ------------------------------------------------------------------------------------------------------------------
def bundle_status_for(incident_id: str) -> tuple[str, int | None]:
    """(bundle_status, bundle_built_ms) from the bundle manifest on disk ("none", None when absent)."""
    try:
        from .bundle import bundle_dir, manifest_path

        p = manifest_path(bundle_dir(incident_id))
        m = orjson.loads(p.read_bytes())
    except (ValueError, OSError):
        return "none", None
    status = m.get("status") if isinstance(m, dict) else None
    built = m.get("built_ms") if isinstance(m, dict) else None
    st = status if status in ("building", "ready", "error") else "none"
    return st, (int(built) if isinstance(built, (int, float)) and st != "building" else None)


_AGENCY_NAMES: dict[str, str] | None = None
AGENCY_CODES_FILE = Path(__file__).resolve().parent / "data" / "nwcg_agency_codes.json"


def agency_name(agency_code: str | None) -> str | None:
    """The plain name of a protecting-agency code as NWCG's Unit Identifier standard (PMS 931) names it
    (``data/nwcg_agency_codes.json``: "USFS" -> "USDA Forest Service", "C&L" -> "County and Local"); None for a code
    the table does not name (the code is then shown verbatim)."""
    global _AGENCY_NAMES
    if _AGENCY_NAMES is None:
        try:
            _AGENCY_NAMES = dict(orjson.loads(AGENCY_CODES_FILE.read_bytes()).get("codes") or {})
        except (OSError, ValueError, AttributeError) as e:
            log.info("nwcg_agency_codes.json unavailable (%s): agency codes are shown verbatim", e)
            _AGENCY_NAMES = {}
    code = " ".join(str(agency_code or "").split())
    return _AGENCY_NAMES.get(code) if code else None


def issuer_for(agency_code: str | None) -> str:
    """CONTRACT 14.2 issuer text of a WFIGS record: "<CODE verbatim> via NIFC WFIGS", else "NIFC WFIGS (IRWIN)"."""
    code = " ".join(str(agency_code or "").split())
    return f"{code} via NIFC WFIGS" if code else WFIGS_NAME


def record_issuer(summary: IncidentSummary | dict) -> str:
    """The issuer text of a summary's own record (CONTRACT 14.2): "CAL FIRE", "<CODE> via NIFC WFIGS" or
    "NIFC WFIGS (IRWIN)"."""
    s = summary if isinstance(summary, IncidentSummary) else IncidentSummary.model_validate(summary)
    if s.record_issuer:
        return s.record_issuer
    return CALFIRE_NAME if (s.record_source or "calfire") == "calfire" else issuer_for(s.agency_code)


def accuracy_region_for(gacc: str | None, state: str | None) -> str | None:
    """CONTRACT 14.4: the WFIGS GACC of the record, with the Southern Area split by state (SACC in TX or OK ->
    "SACC-SP", the rest of SACC -> "SACC-SE"); any other or missing code -> None ("Accuracy not yet tested here")."""
    g = str(gacc or "").strip().upper()
    if g == "SACC":
        return "SACC-SP" if str(state or "").upper() in SOUTHERN_PLAINS else "SACC-SE"
    return g if g in ACCURACY_REGIONS else None


_CA_COUNTY_GACC: dict[str, str | None] | None = None
CA_COUNTY_GACC_FILE = Path(__file__).resolve().parent / "data" / "ca_county_gacc.json"


def ca_county_region(lon: float, lat: float) -> str | None:
    """CONTRACT 14.4 fallback for a California fire no WFIGS record matches: the GACC of its county when that
    county's WFIGS fires are >= 80 % one GACC (``data/ca_county_gacc.json``, ``scripts/build_ca_county_gacc.py``);
    None for the six mixed counties, outside California, or without the file."""
    global _CA_COUNTY_GACC
    from . import regions

    if _CA_COUNTY_GACC is None:
        try:
            raw = orjson.loads(CA_COUNTY_GACC_FILE.read_bytes())
            _CA_COUNTY_GACC = {k: v.get("gacc") for k, v in (raw.get("counties") or {}).items()}
        except (OSError, ValueError, AttributeError) as e:
            log.info("ca_county_gacc.json unavailable (%s): California fires without a WFIGS record get no region", e)
            _CA_COUNTY_GACC = {}
    c = regions.county_at(lon, lat)
    if c is None or c.state != "CA":
        return None
    key = " ".join(c.name.lower().replace("county", " ").split())
    return accuracy_region_for(_CA_COUNTY_GACC.get(key), "CA")


def is_supported(summary: IncidentSummary | dict | None) -> bool:
    """True when the summary's state is one of the lower 48 + DC."""
    from . import regions

    if summary is None:
        return False
    st = summary.get("state") if isinstance(summary, dict) else summary.state
    return regions.is_supported_state(st)


def active_sources(summary: IncidentSummary) -> list[str]:
    """Which records call the fire active (``summary.active_sources``; California may list both)."""
    return list(summary.active_sources or [])


def wfigs_state(rec: dict) -> str | None:
    """The listing state of a WFIGS row: ``POOState`` decides (lower 48 + DC, else None: not listed); the polygons only
    fill a missing ``POOState`` (nearest state within 5 km). Mismatches with the polygons are logged, never dropped."""
    from . import regions

    st = rec.get("poo_state")
    if st:
        if st not in regions.L48:
            return None
        poly = regions.state_at(rec["lon"], rec["lat"])
        if poly != st:
            log.debug("WFIGS %s (%s): POOState %s, point in %s", rec.get("irwin_id"), rec.get("source_name"), st, poly or "no state")
        return st
    if rec.get("poo_state_raw"):
        return None
    return regions.state_at(rec["lon"], rec["lat"])


def wfigs_active(rec: dict, current_irwins: set[str]) -> bool:
    """A WFIGS record is active when it is in the Current layer with ``PercentContained`` null or < 100 (a
    year-to-date row is never active on its own)."""
    return rec.get("irwin_id") in current_irwins


def active_irwin_ids(current_rows: list[dict]) -> set[str]:
    """IRWIN ids of the Current rows that count as active (wildfires, ``PercentContained`` null or < 100)."""
    return {r["irwin_id"] for r in current_rows
            if r.get("type") == "WF" and (r.get("percent_contained") is None or r["percent_contained"] < 100)}


def other_record(rec: dict, current_irwins: set[str]) -> OtherRecord:
    """A WFIGS record as an ``other_records`` entry of a CAL FIRE row (its own name, issuer, numbers, status, time)."""
    return OtherRecord(source="wfigs", id=rec["irwin_id"], name=rec.get("source_name") or "", issuer=issuer_for(rec.get("agency_code")),
                       agency=agency_name(rec.get("agency_code")), agency_code=rec.get("agency_code"), acres=rec.get("acres"),
                       percent_contained=rec.get("percent_contained"), is_active=wfigs_active(rec, current_irwins),
                       updated_ms=rec.get("updated_ms"), url=rec.get("url"))


def summary_from_record(rec: dict, mode: Mode, detections_24h: int | None = None) -> IncidentSummary | None:
    """A cleaned CAL FIRE record (``sources.calfire``) -> IncidentSummary (bundle fields "none"/None).
    None when the record lacks a start time, coordinates or UniqueId."""
    from . import regions

    if rec.get("started_ms") is None or rec.get("lat") is None or rec.get("lon") is None or not rec.get("uid"):
        return None
    year = int(rec.get("year") or time.gmtime(rec["started_ms"] / 1000).tm_year)
    lat, lon = float(rec["lat"]), float(rec["lon"])
    state = regions.state_at(lon, lat) or "CA"
    tz = regions.time_zone_at(lon, lat) or regions.main_zone(state)
    uid = str(rec.get("UniqueId") or rec["uid"])
    return IncidentSummary(
        id=make_incident_id(year, rec["name"], rec["uid"]),
        name=rec["name"],
        mode=mode,
        year=year,
        calfire_uid=uid,
        started_ms=int(rec["started_ms"]),
        updated_ms=rec.get("updated_ms"),
        contained_ms=rec.get("extinguished_ms"),
        acres=rec.get("acres"),
        percent_contained=rec.get("percent_contained"),
        is_active=bool(rec.get("is_active")),
        county=rec.get("county"),
        location=rec.get("location"),
        admin_unit=rec.get("admin_unit"),
        url=rec.get("url"),
        lat=lat,
        lon=lon,
        detections_24h=detections_24h,
        bundle_status="none",
        bundle_built_ms=None,
        uid=uid,
        record_source="calfire",
        record_issuer=CALFIRE_NAME,
        state=state,
        time_zone=tz,
        agency=CALFIRE_NAME,
        source_name=rec.get("Name") or rec["name"],
        accuracy_region=ca_county_region(lon, lat) if state == "CA" else None,
        active_sources=["calfire"] if rec.get("is_active") else [],
    )


def summary_from_wfigs(rec: dict, mode: Mode, current_irwins: set[str], state: str | None = None,
                       detections_24h: int | None = None) -> IncidentSummary:
    """A cleaned WFIGS row (``sources.wfigs.normalize``) -> IncidentSummary (CONTRACT 14.1 "WFIGS rows")."""
    from . import regions

    st = state if state is not None else wfigs_state(rec)
    tz = regions.time_zone_at(rec["lon"], rec["lat"]) or (regions.main_zone(st) if st else "UTC")
    name = display_name(rec.get("source_name"))
    active = wfigs_active(rec, current_irwins)
    cpx = rec.get("cpx_name") if (rec.get("is_cpx_child") or rec.get("cpx_name")) else None
    return IncidentSummary(
        id=make_incident_id(int(rec["year"]), name, rec["irwin_id"]),
        name=name,
        mode=mode,
        year=int(rec["year"]),
        calfire_uid="",
        started_ms=int(rec["started_ms"]),
        updated_ms=rec.get("updated_ms"),
        contained_ms=rec.get("contained_ms") or rec.get("controlled_ms") or rec.get("out_ms"),
        acres=rec.get("acres"),
        percent_contained=rec.get("percent_contained"),
        is_active=active,
        county=rec.get("county"),
        location=None,
        admin_unit=rec.get("protecting_unit"),
        url=rec.get("url"),
        lat=float(rec["lat"]),
        lon=float(rec["lon"]),
        detections_24h=detections_24h,
        bundle_status="none",
        bundle_built_ms=None,
        uid=rec["irwin_id"],
        record_source="wfigs",
        record_issuer=issuer_for(rec.get("agency_code")),
        state=st,
        time_zone=tz,
        agency=agency_name(rec.get("agency_code")),
        agency_code=rec.get("agency_code"),
        irwin_id=rec["irwin_id"],
        unique_fire_id=rec.get("unique_fire_id"),
        source_name=rec.get("source_name"),
        gacc=rec.get("gacc"),
        accuracy_region=accuracy_region_for(rec.get("gacc"), st),
        active_sources=["wfigs"] if active else [],
        complex_name=display_name(cpx) if cpx else None,
    )


def _with_bundle(s: IncidentSummary) -> IncidentSummary:
    st, built = bundle_status_for(s.id)
    return s.model_copy(update={"bundle_status": st, "bundle_built_ms": built})


def in_california(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Boolean mask of points inside :data:`CA_OUTLINE` (excludes the NV/AZ/OR/Mexico parts of the CA bbox)."""
    import shapely
    from shapely.geometry import Polygon

    return shapely.contains_xy(Polygon(CA_OUTLINE), np.asarray(lon, dtype=np.float64), np.asarray(lat, dtype=np.float64))


def detection_radius_m(acres: float | None) -> float:
    """Search radius around the reported point for ``detections_24h``."""
    return float(min(DET_RADIUS_MAX_M, max(DET_RADIUS_MIN_M, DET_RADIUS_FACTOR * fallback_radius_m(acres))))


def assign_detections(incidents: list[tuple[float, float, float]], lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Count detections per incident ``(lat, lon, radius_m)``: a detection within the radius of several incidents
    goes to the one with the smallest distance/radius. Returns int counts aligned with ``incidents``. Detections are
    first cut to the incidents' combined box, so the national feed costs little."""
    counts = np.zeros(len(incidents), dtype=np.int64)
    if not incidents or len(lat) == 0:
        return counts
    la0 = np.asarray(lat, dtype=np.float64)
    lo0 = np.asarray(lon, dtype=np.float64)
    ilat = np.array([i[0] for i in incidents])
    ilon = np.array([i[1] for i in incidents])
    rad = np.array([i[2] for i in incidents])
    pad_lat = rad.max() / M_PER_DEG_LAT
    pad_lon = rad.max() / (M_PER_DEG_LAT * max(0.1, math.cos(math.radians(min(85.0, float(np.abs(ilat).max()))))))
    near = (la0 >= ilat.min() - pad_lat) & (la0 <= ilat.max() + pad_lat) & (lo0 >= ilon.min() - pad_lon) & (lo0 <= ilon.max() + pad_lon)
    la = la0[near][:, None]
    lo = lo0[near][:, None]
    if la.size == 0:
        return counts
    dy = (la - ilat[None, :]) * M_PER_DEG_LAT
    dx = (lo - ilon[None, :]) * M_PER_DEG_LAT * np.cos(np.radians(ilat[None, :]))
    ratio = np.hypot(dx, dy) / rad[None, :]
    ok = ratio <= 1.0
    has = ok.any(axis=1)
    best = np.where(ok, ratio, np.inf).argmin(axis=1)
    np.add.at(counts, best[has], 1)
    return counts


# ------------------------------------------------------------------------------------------------------------------
# CAL FIRE lists (status history side records)
# ------------------------------------------------------------------------------------------------------------------
def record_history(recs: list[dict], key: str) -> None:
    """Feed CAL FIRE's status history (fire types only); never breaks the catalog."""
    from .sources import calfire, calfire_history

    try:
        calfire_history.record([r for r in recs if (r.get("type") or "").lower() in FIRE_TYPES], list_name=key,
                               seen_ms=calfire.fetched_ms(key))
    except Exception as e:  # noqa: BLE001 - history is a side record
        log.warning("CAL FIRE history not recorded (%s): %s", key, config.mask_secrets(e))


def _record_left_live(live_recs: list[dict]) -> None:
    """Tracked fires that left the live list: record their latest record from their year's list (cached)."""
    from .sources import calfire, calfire_history

    try:
        missing = calfire_history.missing_active(r.get("uid", "") for r in live_recs)
    except Exception as e:  # noqa: BLE001
        log.warning("CAL FIRE history: tracked fires not checked: %s", e)
        return
    for year, uids in sorted(missing.items()):
        try:
            recs = calfire.list_year(year)
        except calfire.CalFireError as e:
            log.info("CAL FIRE history: %d list unavailable: %s", year, config.mask_secrets(e))
            continue
        record_history([r for r in recs if r.get("uid") in uids], calfire.list_key({"inactive": "true", "year": year}))


def _with_live_records(recs: list[dict], year: int) -> list[dict]:
    """The current year's records with each fire's live-list record where that one is at least as new, plus live
    fires of ``year`` that the (cached) year list does not include yet."""
    from .sources import calfire

    try:
        live = calfire.list_live()
    except calfire.CalFireError as e:
        log.info("CAL FIRE %d list: live overlay skipped: %s", year, config.mask_secrets(e))
        return recs
    record_history(live, "live")
    by_uid = {r["uid"]: r for r in live if r.get("uid") and r.get("year") == year}
    out = []
    for r in recs:
        fresh = by_uid.pop(r.get("uid"), None)
        out.append(fresh if fresh is not None and (fresh.get("updated_ms") or 0) >= (r.get("updated_ms") or 0) else r)
    return out + list(by_uid.values())


def year_records(year: int, refresh: bool = False) -> list[dict]:
    """CAL FIRE's cleaned records of ``year`` (``sources.calfire.list_year``; the current year overlaid with the live
    list, see :func:`_with_live_records`), recorded into the status history."""
    from .sources import calfire

    year = int(year)
    recs = calfire.list_year(year, refresh=refresh)
    record_history(recs, calfire.list_key({"inactive": "true", "year": year}))
    if year >= time.gmtime().tm_year:
        recs = _with_live_records(recs, year)
    return recs


def _fire_records(recs: list[dict]) -> list[dict]:
    return [r for r in recs if (r.get("type") or "").lower() in FIRE_TYPES]


def _calfire_pool(years: set[int], extra: list[dict] = ()) -> list[dict]:
    """CAL FIRE fire records of ``years`` (any size; for matching), plus ``extra`` (e.g. the live list), one per uid
    (the newest record wins). A year whose list is unavailable is skipped with a log line."""
    from .sources import calfire

    by_uid: dict[str, dict] = {}
    for y in sorted(years):
        if y < 2000 or y > time.gmtime().tm_year:
            continue
        try:
            recs = year_records(y)
        except calfire.CalFireError as e:
            log.info("California merge: CAL FIRE %d list unavailable: %s", y, config.mask_secrets(e))
            continue
        for r in _fire_records(recs):
            by_uid[r.get("uid", "")] = r
    for r in _fire_records(list(extra)):
        old = by_uid.get(r.get("uid", ""))
        if old is None or (r.get("updated_ms") or 0) >= (old.get("updated_ms") or 0):
            by_uid[r.get("uid", "")] = r
    return [r for u, r in by_uid.items() if u]


# ------------------------------------------------------------------------------------------------------------------
# California merge (CONTRACT 14.2)
# ------------------------------------------------------------------------------------------------------------------
def same_fire_score(cal: dict, wf: dict) -> tuple[int, float] | None:
    """How a WFIGS row matches a CAL FIRE record (rule 2): ``(0, km)`` for equal name tokens within 30 km and
    discovery -7/+20 days from CAL FIRE's start, ``(1, km)`` for any name within 3 km and +/-3 days, else None."""
    if cal.get("lat") is None or cal.get("lon") is None or cal.get("started_ms") is None:
        return None
    d = _km(float(cal["lat"]), float(cal["lon"]), float(wf["lat"]), float(wf["lon"]))
    dt_days = (int(wf["started_ms"]) - int(cal["started_ms"])) / DAY_MS
    if (d <= MERGE_NAME_KM and MERGE_NAME_DAYS[0] <= dt_days <= MERGE_NAME_DAYS[1]
            and name_tokens(cal.get("name")) == name_tokens(wf.get("source_name"))):
        return (0, d)
    if d <= MERGE_ANY_KM and abs(dt_days) <= MERGE_ANY_DAYS:
        return (1, d)
    return None


def merge_california(wf_rows: list[dict], cal_pool: list[dict]) -> tuple[dict[str, list[dict]], dict[str, list[dict]], list[dict]]:
    """Split WFIGS-CA rows against CAL FIRE fire records (of their year and the year before): ``(matched, members,
    unmatched)``. ``members[uid]``: rows whose ``CpxName`` equals the name of CAL FIRE complex ``uid`` (rule 1, when
    :data:`CA_COMPLEX_ROWS` is "calfire"); ``matched[uid]``: rows that are the same fire as CAL FIRE fire ``uid``
    (rule 2, the best match); ``unmatched``: the rest (rule 3, listed as WFIGS rows)."""
    by_year: dict[int, list[dict]] = {}
    for c in cal_pool:
        if c.get("year") is not None:
            by_year.setdefault(int(c["year"]), []).append(c)
    matched: dict[str, list[dict]] = {}
    members: dict[str, list[dict]] = {}
    unmatched: list[dict] = []
    for wf in wf_rows:
        y = int(wf.get("year") or 0)
        cands = by_year.get(y, []) + by_year.get(y - 1, [])
        cpx = norm_name(wf.get("cpx_name"))
        if CA_COMPLEX_ROWS == "calfire" and cpx:
            hit = [c for c in cands if norm_name(c.get("name")) == cpx]
            if hit:
                members.setdefault(hit[0]["uid"], []).append(wf)
                continue
        scored = [(sc, c) for c in cands if (sc := same_fire_score(c, wf)) is not None]
        if scored:
            best = min(scored, key=lambda t: t[0])[1]
            matched.setdefault(best["uid"], []).append(wf)
        else:
            unmatched.append(wf)
    return matched, members, unmatched


def _common(values: list[Any]) -> Any:
    vals = {v for v in values if v}
    return vals.pop() if len(vals) == 1 and all(values) else None


def enrich_calfire(s: IncidentSummary, matched: list[dict], members: list[dict], current_irwins: set[str],
                   is_complex: bool = False) -> IncidentSummary:
    """What a CAL FIRE row carries from the WFIGS rows dropped into it (CONTRACT 14.2): rule (2), one fire: its
    ``irwin_id``, ``unique_fire_id``, ``gacc``, one ``other_records`` entry and "wfigs" in ``active_sources`` when that
    record is active (two records of one fire, e.g. DALE and BRADFORD BRANCH for CAL FIRE's Dale Fire: both in
    ``other_records``, the ``irwin_id`` of the one with the same name; several with the same name, e.g. LUCAS twice:
    :func:`same_name_primary`; none with the same name: null); rule (1), a complex: ``irwin_id`` null,
    ``complex_members`` (every member name verbatim), one
    named ``other_records`` entry per member, the members' GACC when they all agree, and "wfigs" when any member is
    active. ``is_active`` follows :data:`CA_ACTIVE_RULE`. CAL FIRE's own name, acres, containment and times stay."""
    recs = members + matched
    if not recs:
        return s
    ors = [other_record(r, current_irwins) for r in recs]
    cal_active = "calfire" in (s.active_sources or [])
    wf_active = any(o.is_active for o in ors)
    srcs = (["calfire"] if cal_active else []) + (["wfigs"] if wf_active else [])
    active = {"either": cal_active or wf_active, "calfire": cal_active, "wfigs": wf_active}.get(CA_ACTIVE_RULE, cal_active or wf_active)
    gacc = _common([r.get("gacc") for r in recs])
    region = accuracy_region_for(gacc, s.state) or (ca_county_region(s.lon, s.lat) if s.state == "CA" else None)
    upd: dict[str, Any] = {"other_records": ors, "active_sources": srcs, "is_active": active, "gacc": gacc,
                           "accuracy_region": region}
    primary = None
    if not (members or is_complex):
        same_name = [r for r in matched if name_tokens(r.get("source_name")) == name_tokens(s.name)]
        primary = matched[0] if len(matched) == 1 else (same_name_primary(same_name) if same_name else None)
    if primary is None:
        upd.update(irwin_id=None, unique_fire_id=None)       # a complex, or several records with no single same-name one
        if members:
            upd["complex_members"] = [r.get("source_name") or "" for r in members]
    else:
        upd.update(irwin_id=primary["irwin_id"], unique_fire_id=primary.get("unique_fire_id"))
        pinned = pinned_id(primary)
        if pinned is not None and pinned != s.id:
            upd.update(id=pinned, aliases=sorted({*(s.aliases or []), s.id}))
    return s.model_copy(update=upd)


def same_name_primary(recs: list[dict]) -> dict:
    """One record for several WFIGS records that all carry the fire's own name (the Lucas Fire: LUCAS from two CAL FIRE
    units, 1,099 ac and 4,128 ac): they are one fire's records, so the largest reported size is its record, then the
    most recently modified (CONTRACT 14.2). Every record stays in ``other_records`` with its own issuer and status."""
    return max(recs, key=lambda r: (r.get("acres") if r.get("acres") is not None else -1.0, r.get("updated_ms") or 0))


def wfigs_id(rec: dict) -> str:
    """The id a WFIGS row is (or was) listed under: ``{UFI year}-{slug(display name)}-{IRWIN hex[:6]}``."""
    return make_incident_id(int(rec["year"]), display_name(rec.get("source_name")), rec["irwin_id"])


def pinned_id(rec: dict) -> str | None:
    """CONTRACT 14.2 "Id pinning": the WFIGS id of a record CAL FIRE now lists, when a bundle already exists under that
    id (built while the fire was WFIGS-only). The merged CAL FIRE row then keeps that id, so the bundle is never
    orphaned or built twice; its CAL FIRE id becomes an alias. None when no bundle exists (the CAL FIRE id is used)."""
    wid = wfigs_id(rec)
    return wid if bundle_status_for(wid)[0] != "none" else None


def dedupe_wfigs(rows: list[tuple[dict, str]]) -> list[tuple[dict, str]]:
    """Drop WFIGS duplicates (same name tokens and state, sizes both reported, over 1 ac and within 1 %, <= 10 km,
    discovery <= 30 days apart): the most recently modified row is kept; each dropped id is logged."""
    groups: dict[tuple[str, frozenset[str]], list[tuple[dict, str]]] = {}
    for r, st in rows:
        groups.setdefault((st, name_tokens(r.get("source_name"))), []).append((r, st))
    out: list[tuple[dict, str]] = []
    for grp in groups.values():
        kept: list[tuple[dict, str]] = []
        for r, st in sorted(grp, key=lambda t: -(t[0].get("updated_ms") or 0)):
            dup = next((k for k, _ in kept if _is_duplicate(k, r)), None)
            if dup is not None:
                log.info("WFIGS duplicate dropped: %s (%s) duplicates %s", r["irwin_id"], r.get("source_name"), dup["irwin_id"])
                continue
            kept.append((r, st))
        out += kept
    return out


def _is_duplicate(a: dict, b: dict) -> bool:
    sa, sb = a.get("acres"), b.get("acres")
    if sa is None or sb is None or min(sa, sb) <= DUP_MIN_ACRES or abs(sa - sb) > DUP_SIZE_FRAC * max(sa, sb):
        return False
    if abs(int(a["started_ms"]) - int(b["started_ms"])) > DUP_DAYS * DAY_MS:
        return False
    return _km(a["lat"], a["lon"], b["lat"], b["lon"]) <= DUP_KM


# ------------------------------------------------------------------------------------------------------------------
# The lists
# ------------------------------------------------------------------------------------------------------------------
def _source(sid: str, ok: bool, retrieved_ms: int | None, reason: str | None, stale: bool = False) -> dict:
    """One ``ListSource`` (CONTRACT 14.1): ``stale`` when the list could not be refreshed and an older cached copy was
    used (``retrieved_ms`` is that copy's fetch time; CONTRACT 14.16)."""
    stale = bool(ok and stale)
    stale_reason = CALFIRE_STALE if sid == "calfire" else WFIGS_STALE
    return {"id": sid, "name": CALFIRE_NAME if sid == "calfire" else WFIGS_NAME, "status": "available" if ok else "unavailable",
            "retrieved_ms": retrieved_ms if ok else (retrieved_ms or None), "stale": stale,
            "reason": (stale_reason if stale else None) if ok else reason}


def _side_by_side(f_cal, f_wf) -> tuple[tuple[Any, BaseException | None], tuple[Any, BaseException | None]]:
    """Run the CAL FIRE and the NIFC WFIGS fetches at the same time, so an outage of one never adds its wait to the
    other's: ``((cal_value, cal_error), (wf_value, wf_error))``."""
    def outcome(fut):
        try:
            return fut.result(), None
        except Exception as e:  # noqa: BLE001 - the caller decides what each failure means
            return None, e

    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="fire-lists") as ex:
        a, b = ex.submit(f_cal), ex.submit(f_wf)
        return outcome(a), outcome(b)


def _wfigs_rows(rows: list[dict]) -> list[tuple[dict, str]]:
    """Wildfire rows of the lower 48 + DC with their listing state (RX, CX, Alaska, Hawaii, territories dropped)."""
    out = []
    for r in rows:
        if r.get("type") != "WF":
            continue
        st = wfigs_state(r)
        if st is not None:
            out.append((r, st))
    return out


def _live_base(refresh: bool) -> tuple[list[IncidentSummary], list[dict]]:
    from . import regions
    from .sources import calfire, firms, wfigs

    cal_live: list[dict] = []
    (raw, cal_err), (current, wf_err) = _side_by_side(lambda: calfire.list_live(refresh=refresh), lambda: wfigs.list_current(refresh=refresh))
    if cal_err is not None and not isinstance(cal_err, calfire.CalFireError):
        raise cal_err
    if cal_err is None:
        record_history(raw, "live")
        _record_left_live(raw)
        cal_live = [r for r in _fire_records(raw) if r.get("is_active")]
    current = current if wf_err is None else []      # any failure of the national list degrades to California only
    if cal_err is not None and wf_err is not None:
        raise calfire.CalFireError(f"CAL FIRE and NIFC WFIGS lists unavailable: {cal_err}; {config.mask_secrets(wf_err)}")
    if wf_err is not None:
        log.warning("live catalog: NIFC WFIGS unavailable, California only: %s", config.mask_secrets(wf_err))
    if cal_err is not None:
        log.warning("live catalog: CAL FIRE unavailable, California from NIFC WFIGS: %s", cal_err)
    active = active_irwin_ids(current)
    l48 = dedupe_wfigs(_wfigs_rows(current))
    ca_all = [r for r, st in l48 if st == "CA"]
    wf_rows = [(r, st) for r, st in l48 if st != "CA" and r["irwin_id"] in active]
    cal_rows: dict[str, dict] = {r["uid"]: r for r in cal_live if r.get("uid")}
    matched: dict[str, list[dict]] = {}
    members: dict[str, list[dict]] = {}
    if cal_err is None and ca_all:
        years = {int(r["year"]) - k for r in ca_all for k in (0, 1)}
        pool = _calfire_pool(years, cal_live)
        matched, members, unmatched = merge_california(ca_all, pool)
        by_uid = {r["uid"]: r for r in pool}
        for uid in set(matched) | set(members):
            if uid in cal_rows or uid not in by_uid:
                continue
            attached = matched.get(uid, []) + members.get(uid, [])
            if CA_ACTIVE_RULE in ("either", "wfigs") and any(r["irwin_id"] in active for r in attached):
                cal_rows[uid] = by_uid[uid]
        wf_rows += [(r, "CA") for r in unmatched if r["irwin_id"] in active]
    elif cal_err is not None:
        wf_rows += [(r, "CA") for r in ca_all if r["irwin_id"] in active]
    summaries: list[IncidentSummary] = []
    for uid, rec in cal_rows.items():
        s = summary_from_record(rec, "live")
        if s is None:
            continue
        s = enrich_calfire(s, matched.get(uid, []), members.get(uid, []), active, is_complex=bool(members.get(uid)))
        if s.is_active:
            summaries.append(s)
    for r, st in wf_rows:
        summaries.append(summary_from_wfigs(r, "live", active, st))
    counts: list[int | None] = [None] * len(summaries)
    try:
        det = firms.load_live_us(1, refresh=refresh)
        t0 = time.monotonic()
        lat, lon = det["lat"].to_numpy(), det["lon"].to_numpy()
        w, s_, e, n = config.CA_BBOX
        in_box = (lon >= w) & (lon <= e) & (lat >= s_) & (lat <= n)
        _live_total["n"] = int(in_california(lat[in_box], lon[in_box]).sum())
        _live_total["us"] = int(regions.in_lower48(lon, lat).sum())
        c = assign_detections([(x.lat, x.lon, detection_radius_m(x.acres)) for x in summaries], lat, lon)
        counts = [int(v) for v in c]
        log.info("live catalog: %d detections assigned to %d fires in %.2f s", len(det), len(summaries), time.monotonic() - t0)
        for msg in det.attrs.get("warnings", []):
            log.warning("live catalog: %s", msg)
    except firms.FirmsError as e:
        _live_total["n"] = _live_total["us"] = None
        log.warning("live catalog: FIRMS 24h feeds unavailable, detections_24h = None (%s)", e)
    out = [x.model_copy(update={"detections_24h": k}) for x, k in zip(summaries, counts)]
    out.sort(key=lambda x: (-(x.detections_24h if x.detections_24h is not None else -1), -(x.acres or 0.0), x.name))
    wf_key = wfigs.list_key(wfigs.CURRENT_URL, wfigs.current_where())
    sources = [_source("calfire", cal_err is None, calfire.fetched_ms("live"), CALFIRE_DOWN, calfire.is_stale("live")),
               _source("wfigs", wf_err is None, wfigs.fetched_ms(wf_key), WFIGS_DOWN, wfigs.is_stale(wf_key))]
    return out, sources


def _historical_base(refresh: bool, year: int, wf_min: float) -> tuple[list[IncidentSummary], list[dict]]:
    from .sources import calfire, wfigs

    year = int(year)
    (cal, cal_err), (rows, wf_err) = _side_by_side(lambda: _fire_records(year_records(year, refresh=refresh)),
                                                   lambda: wfigs.list_year(year, wf_min, refresh=refresh))
    if cal_err is not None and not isinstance(cal_err, calfire.CalFireError):
        raise cal_err
    cal = cal if cal_err is None else []
    rows = rows if wf_err is None else []            # any failure of the national list degrades to California only
    if cal_err is not None and wf_err is not None:
        raise calfire.CalFireError(f"CAL FIRE and NIFC WFIGS {year} lists unavailable: {cal_err}; {config.mask_secrets(wf_err)}")
    active: set[str] = set()
    if wf_err is None:
        try:
            active = active_irwin_ids(wfigs.list_current())
        except Exception as e:  # noqa: BLE001 - activity only; the year list still lists
            log.warning("historical catalog: WFIGS Current unavailable, WFIGS rows read as not active: %s", config.mask_secrets(e))
    else:
        log.warning("historical catalog %d: NIFC WFIGS unavailable, California only: %s", year, config.mask_secrets(wf_err))
    l48 = dedupe_wfigs(_wfigs_rows(rows))
    ca = [r for r, st in l48 if st == "CA"]
    wf_rows = [(r, st) for r, st in l48 if st != "CA"]
    matched: dict[str, list[dict]] = {}
    members: dict[str, list[dict]] = {}
    if cal_err is None and ca:
        pool = cal + _calfire_pool({year - 1}) if any(int(r["year"]) == year for r in ca) else cal
        matched, members, unmatched = merge_california(ca, pool)
        wf_rows += [(r, "CA") for r in unmatched]
    elif cal_err is not None:
        wf_rows += [(r, "CA") for r in ca]
    out: list[IncidentSummary] = []
    for rec in cal:
        s = summary_from_record(rec, "historical")
        if s is None:
            continue
        uid = rec.get("uid", "")
        out.append(enrich_calfire(s, matched.get(uid, []), members.get(uid, []), active, is_complex=bool(members.get(uid))))
    for r, st in wf_rows:
        out.append(summary_from_wfigs(r, "historical", active, st))
    out.sort(key=lambda x: (-(x.acres or 0.0), x.name))
    cal_key = calfire.list_key({"inactive": "true", "year": year})
    wf_key = wfigs.list_key(wfigs.YTD_URL if year >= time.gmtime().tm_year else wfigs.ALL_YEARS_URL, wfigs.year_where(year, wf_min))
    sources = [_source("calfire", cal_err is None, calfire.fetched_ms(cal_key), CALFIRE_DOWN, calfire.is_stale(cal_key)),
               _source("wfigs", wf_err is None, wfigs.fetched_ms(wf_key), WFIGS_DOWN, wfigs.is_stale(wf_key))]
    return out, sources


def _wf_min(min_acres: float | None) -> float:
    lo = DEFAULT_MIN_ACRES if min_acres is None else float(min_acres)
    return max(WFIGS_YEAR_FLOOR_ACRES, lo)


def _base(mode: Mode, refresh: bool, year: int | None = None, wf_min: float = DEFAULT_MIN_ACRES) -> tuple[list[IncidentSummary], list[dict]]:
    yr = int(year) if year is not None else default_year()
    if mode == "live":
        key, ttl = "live", LIVE_CACHE_S
    else:
        key = f"historical:{yr}:{wf_min:g}"
        ttl = CURRENT_YEAR_CACHE_S if yr >= time.gmtime().tm_year else HISTORICAL_CACHE_S
    with _lock:
        hit = _cache.get(key)
        # a list built while a source failed (unavailable, or an old copy) is rebuilt after a minute, not 5-60 min
        degraded = hit is not None and any(x.get("status") != "available" or x.get("stale") for x in hit[2])
        if hit is not None and not refresh and time.monotonic() - hit[0] < (min(ttl, DEGRADED_CACHE_S) if degraded else ttl):
            return hit[1], hit[2]
    rows, sources = _live_base(refresh) if mode == "live" else _historical_base(refresh, yr, wf_min)
    with _lock:
        _cache[key] = (time.monotonic(), rows, sources)
    return rows, sources


def list_incidents(mode: Mode, min_acres: float | None = None, refresh: bool = False, year: int | None = None,
                   state: str | None = None) -> tuple[list[IncidentSummary], list[dict]]:
    """``(rows, sources)`` of ``GET /api/incidents`` (CONTRACT 14.1): the list of :func:`get_catalog` plus the
    ``ListSource`` dicts of the CAL FIRE and WFIGS lists behind it. ``state`` (USPS) keeps one state's rows."""
    if mode not in ("live", "historical"):
        raise ValueError(f"mode must be 'live' or 'historical', got {mode!r}")
    lo = min_acres if min_acres is not None else (DEFAULT_MIN_ACRES if mode == "historical" else None)
    rows, sources = _base(mode, refresh, year, _wf_min(lo))
    if lo:
        rows = [s for s in rows if (s.acres or 0.0) >= lo]
    if state:
        st = str(state).strip().upper()
        rows = [s for s in rows if (s.state or "").upper() == st]
    return [_with_bundle(s) for s in rows], [dict(x) for x in sources]


def cached_sources(mode: Mode, year: int | None = None, min_acres: float | None = None) -> list[dict]:
    """The ``ListSource`` dicts of the cached base list behind ``get_catalog(mode, min_acres, year=year)`` (no
    request; [] when that list was not computed in this process)."""
    lo = min_acres if min_acres is not None else (DEFAULT_MIN_ACRES if mode == "historical" else None)
    key = "live" if mode == "live" else f"historical:{int(year) if year is not None else default_year()}:{_wf_min(lo):g}"
    with _lock:
        hit = _cache.get(key)
    return [dict(x) for x in hit[2]] if hit is not None else []


def get_catalog(mode: Mode, min_acres: float | None = None, refresh: bool = False,
                year: int | None = None, state: str | None = None) -> list[IncidentSummary]:
    """Live: every active wildfire of the lower 48 sorted by detections_24h then acres. Historical: the wildfires of
    ``year`` (default: the current UTC year) with acres >= ``min_acres`` (default 300) sorted by acres desc; ``year``
    is ignored for live. ``state`` (optional USPS code) filters rows. ``bundle_status`` reflects bundles on disk.
    Raises ``sources.calfire.CalFireError`` when both CAL FIRE and NIFC WFIGS are unreachable and nothing is cached."""
    return list_incidents(mode, min_acres, refresh, year, state)[0]


def live_detections_24h_total(refresh: bool = False) -> int | None:
    """Detections inside California (:data:`CA_OUTLINE`) in the keyless 24h feeds, for
    ``LiveStatus.detections_24h_ca``; None if the feeds are unavailable."""
    _base("live", refresh)
    return _live_total["n"]


def live_detections_24h_us_total(refresh: bool = False) -> int | None:
    """Detections inside the lower-48 state polygons in the keyless 24h feeds (``load_live_us(days=1)``), for
    ``LiveStatus.detections_24h``; None if the feeds are unavailable."""
    _base("live", refresh)
    return _live_total["us"]


def clear_cache() -> None:
    """Forget the in-memory catalogs (the HTTP cache is kept)."""
    with _lock:
        _cache.clear()


# ------------------------------------------------------------------------------------------------------------------
# Resolution (CONTRACT 14.2)
# ------------------------------------------------------------------------------------------------------------------
def _find(rows: list[IncidentSummary], incident_id: str) -> IncidentSummary | None:
    for s in rows:
        if s.id == incident_id or incident_id in (s.aliases or []):
            return s
    return None


class ListsUnavailable(LookupError):
    """:func:`resolve_listed` could not decide an id: no list that answered knows it and at least one source list
    (CAL FIRE or NIFC WFIGS) could not be reached. The API answers 503 with :data:`LISTS_UNAVAILABLE_TEXT` (CONTRACT
    14.2), never "a local or synthetic bundle"."""

    def __init__(self, message: str = "", *, failed: tuple[str, ...] = ()):
        super().__init__(message or LISTS_UNAVAILABLE_TEXT)
        self.failed = failed


LISTS_UNAVAILABLE_TEXT = "The fire lists could not be reached right now; try again later."


def resolve_listed(incident_id: str) -> IncidentSummary | None:
    """The summary of an id that a source list knows (never a bundle manifest): the live list, the year list of the
    id's year, CAL FIRE's year list (any size), then one cached ``IrwinID LIKE '{ABCDEF%'`` query on the WFIGS
    all-years layer; the id's year and slug are checked. A California WFIGS record that the merge folds into a CAL FIRE
    fire is not listed under its WFIGS id (None). Bundle-only ids (``fixture-demo``, ``fixture-east``) -> None.

    Raises :class:`ListsUnavailable` when no list that answered knows the id and at least one lookup failed (an outage
    is "cannot tell now", never "unknown" or "a local bundle")."""
    from .sources import calfire, wfigs

    parsed = parse_incident_id(incident_id)
    if parsed is None:
        return None
    year, slug, uid6 = parsed
    failed: list[str] = []
    try:
        hit = _find(_base("live", False)[0], incident_id)
        if hit is not None:
            return _with_bundle(hit)
    except calfire.CalFireError as e:
        log.warning("resolve_listed(%s): live catalog unavailable: %s", incident_id, e)
        failed.append("live list")
    if 2000 <= year <= default_year():
        try:
            hit = _find(_base("historical", False, year)[0], incident_id)
            if hit is not None:
                return _with_bundle(hit)
        except calfire.CalFireError as e:
            log.warning("resolve_listed(%s): %d catalog unavailable: %s", incident_id, year, e)
            failed.append(f"{year} list")
        try:
            for r in year_records(year):
                if r.get("uid", "").startswith(uid6) and slugify(r.get("name", "")) == slug and (r.get("type") or "").lower() in FIRE_TYPES:
                    s = summary_from_record(r, "live" if r.get("is_active") else "historical")
                    if s is not None:
                        return _with_bundle(s)
        except calfire.CalFireError as e:
            log.warning("resolve_listed(%s): CAL FIRE %d list unavailable: %s", incident_id, year, e)
            failed.append(f"CAL FIRE {year} list")
    try:
        cands = [r for r in wfigs.find_irwin_prefix(uid6) if r["irwin_id"].lower().startswith(uid6)
                 and int(r.get("year") or 0) == year and slugify(display_name(r.get("source_name"))) == slug]
    except Exception as e:  # noqa: BLE001
        log.warning("resolve_listed(%s): WFIGS lookup unavailable: %s", incident_id, config.mask_secrets(e))
        failed.append("NIFC WFIGS lookup")
        cands = []
    for r in cands:
        # Alaska, Hawaii and territories are never listed, but their ids resolve (with their own state), so the build
        # gate can answer "not supported yet" (422) instead of "unknown"
        st = wfigs_state(r) or r.get("poo_state")
        if st == "CA" and _folded_into_calfire(r):
            return None
        active = set()
        try:
            active = active_irwin_ids(wfigs.list_current())
        except Exception:  # noqa: BLE001
            pass
        return _with_bundle(summary_from_wfigs(r, "live" if r["irwin_id"] in active else "historical", active, st))
    if failed:
        raise ListsUnavailable(failed=tuple(failed))
    return None


def _folded_into_calfire(rec: dict) -> bool:
    from .sources import calfire

    y = int(rec.get("year") or 0)
    try:
        pool = _calfire_pool({y, y - 1})
    except calfire.CalFireError:
        return False
    matched, members, _ = merge_california([rec], pool)
    return bool(matched or members)


def get_summary(incident_id: str) -> IncidentSummary | None:
    """The summary for one incident id (either mode), or None: :func:`resolve_listed`, else a bundle manifest on disk
    (e.g. ``fixture-demo``, ``fixture-east``: the manifest's summary, served read-only). When the lists cannot be
    reached a bundle on disk still answers; without one :class:`ListsUnavailable` is raised."""
    try:
        s = resolve_listed(incident_id)
    except ListsUnavailable:
        m = manifest_summary(incident_id)
        if m is not None:
            return m
        raise
    if s is not None:
        return s
    return manifest_summary(incident_id)


def manifest_summary(incident_id: str) -> IncidentSummary | None:
    """The summary of the bundle manifest on disk, or None."""
    try:
        from .bundle import bundle_dir, load_manifest

        m = load_manifest(bundle_dir(incident_id))
    except (ValueError, OSError):
        m = None
    if isinstance(m, dict) and isinstance(m.get("summary"), dict):
        try:
            return _with_bundle(IncidentSummary.model_validate(m["summary"]))
        except ValueError:
            return None
    return None


def is_bundle_only(incident_id: str) -> bool:
    """True when only a bundle manifest knows this id (``fixture-demo``, ``fixture-east``, any local or synthetic
    bundle): no CAL FIRE or WFIGS list does. False when the lists cannot be reached (cannot tell)."""
    try:
        return resolve_listed(incident_id) is None and manifest_summary(incident_id) is not None
    except ListsUnavailable:
        return False


def find_by_irwin(irwin_id: str) -> IncidentSummary | None:
    """The listed summary that carries this IRWIN id (as its own record or a matched one), else the WFIGS record's own
    summary from the all-years layer; None when unknown."""
    from .sources import calfire, wfigs

    want = wfigs.clean_irwin(irwin_id)
    if not want:
        return None
    for mode, yr in (("live", None), ("historical", default_year())):
        try:
            for s in _base(mode, False, yr)[0]:
                if s.irwin_id == want or (s.record_source == "wfigs" and s.uid == want) or any(o.id == want for o in s.other_records):
                    return _with_bundle(s)
        except calfire.CalFireError:
            continue
    try:
        rows = [r for r in wfigs.find_irwin_prefix(want[:8]) if r["irwin_id"] == want]
    except Exception:  # noqa: BLE001
        return None
    if not rows:
        return None
    r = rows[0]
    try:
        return resolve_listed(make_incident_id(int(r["year"]), display_name(r.get("source_name")), r["irwin_id"]))
    except ListsUnavailable:
        return None


# ------------------------------------------------------------------------------------------------------------------
# Fire bbox (SPEC 8.1)
# ------------------------------------------------------------------------------------------------------------------
def _circle_bbox(lat: float, lon: float, radius_m: float) -> tuple[float, float, float, float]:
    dlat = radius_m / M_PER_DEG_LAT
    dlon = radius_m / (M_PER_DEG_LAT * max(0.1, math.cos(math.radians(lat))))
    return (lon - dlon, lat - dlat, lon + dlon, lat + dlat)


def _local_xy(lat0: float, lon0: float, lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    k = M_PER_DEG_LAT * math.cos(math.radians(lat0))
    return (np.asarray(lon, dtype=np.float64) - lon0) * k, (np.asarray(lat, dtype=np.float64) - lat0) * M_PER_DEG_LAT


def cluster_detections(x: np.ndarray, y: np.ndarray, t_ms: np.ndarray, seeds: np.ndarray,
                       eps_m: float = CLUSTER_EPS_M, eps_ms: int = CLUSTER_EPS_MS) -> np.ndarray:
    """Boolean mask of detections space-time connected (<= ``eps_m`` and <= ``eps_ms`` apart, transitively) to any
    seed detection. Detections are thinned to 300 m / 6 h cells first, so this stays fast for large fires."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    from scipy.spatial import cKDTree

    n = len(x)
    if n == 0 or not np.any(seeds):
        return np.zeros(n, dtype=bool)
    cells = np.stack([np.floor(x / CLUSTER_CELL_M), np.floor(y / CLUSTER_CELL_M), np.floor(np.asarray(t_ms) / CLUSTER_BIN_MS)], axis=1).astype(np.int64)
    uniq, inv = np.unique(cells, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    cx = (uniq[:, 0] + 0.5) * CLUSTER_CELL_M
    cy = (uniq[:, 1] + 0.5) * CLUSTER_CELL_M
    ct = (uniq[:, 2] + 0.5) * CLUSTER_BIN_MS
    pairs = cKDTree(np.stack([cx, cy], axis=1)).query_pairs(eps_m + CLUSTER_CELL_M, output_type="ndarray")
    if len(pairs):
        pairs = pairs[np.abs(ct[pairs[:, 0]] - ct[pairs[:, 1]]) <= eps_ms + CLUSTER_BIN_MS]
    m = len(uniq)
    g = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])) if len(pairs) else ([], ([], [])), shape=(m, m))
    _, labels = connected_components(g, directed=False)
    keep_labels = np.unique(labels[inv[np.asarray(seeds, dtype=bool)]])
    return np.isin(labels[inv], keep_labels)


def _fire_window(summary: IncidentSummary) -> tuple[int, int, int]:
    """(detections start, detections end, perimeter end) for a summary."""
    now = now_ms()
    start = int(summary.started_ms)
    if summary.mode == "live" or summary.is_active:
        return max(start - 12 * HOUR_MS, now - LIVE_LOOKBACK_MS), now, now
    end = summary.contained_ms or (start + 30 * DAY_MS)
    t1 = min(start + HISTORICAL_MAX_DAYS * DAY_MS, max(end, start + 7 * DAY_MS) + DAY_MS, now)
    return start - 12 * HOUR_MS, t1, min(now, start + 120 * DAY_MS)


def _bbox_detections(summary: IncidentSummary, search: tuple[float, float, float, float], t0: int, t1: int):
    from .sources import firms

    live = summary.mode == "live" or summary.is_active
    df = None
    if live:
        try:
            df = firms.filter_bbox_time(firms.load_live_us(7), search, t0, t1)
        except firms.FirmsError as e:
            log.warning("estimate_fire_bbox(%s): live feeds failed (%s)", summary.id, e)
    if df is None:
        df = firms.detections_for(search, t0, t1, "live" if live else "historical", instruments=("VIIRS",), families=("SNPP", "NOAA20"))
    if len(df):
        df = df[firms.quality_mask(df)]
    return df


def estimate_fire_bbox(summary: IncidentSummary) -> tuple[float, float, float, float] | None:
    """Fire bbox (w, s, e, n) lon/lat for AOI sizing (SPEC 8.1).

    Historical: the largest WFIGS perimeter ∪ the VIIRS detection cluster connected to the CAL FIRE point or the
    perimeter, over [start - 12 h, min(start + 45 d, containment + 1 d)]. Live: the latest perimeter ∪ the last-7-day
    cluster (keyless feeds). The CAL FIRE point is always included. Without any perimeter or detection: the circle
    of the incident's acreage (min radius 1 km) around the CAL FIRE point. Network problems degrade to that
    fallback; never raises for them."""
    lat, lon = float(summary.lat), float(summary.lon)
    fallback = _circle_bbox(lat, lon, fallback_radius_m(summary.acres))
    try:
        return _estimate(summary, lat, lon) or fallback
    except Exception as e:  # noqa: BLE001 - a bbox estimate must never break a build
        log.warning("estimate_fire_bbox(%s): %s; using the acreage circle", summary.id, config.mask_secrets(e))
        return fallback


def _estimate(summary: IncidentSummary, lat: float, lon: float) -> tuple[float, float, float, float] | None:
    from shapely.geometry import box

    from .sources import perimeters

    t0, t1, perim_end = _fire_window(summary)
    live = summary.mode == "live" or summary.is_active
    geom = None
    # A NIFC WFIGS record is matched by its IRWIN id (else name + its own state), as build/observed.py does
    # (CONTRACT 14.12.8); without this the California-only default found no perimeter outside California and the AOI
    # was sized from the VIIRS cluster alone (brief 3 validation: Windy Deuce's AOI 36 km clipped the fire).
    ident = ({"record_source": "wfigs", "state": getattr(summary, "state", None), "irwin_id": getattr(summary, "irwin_id", None)}
             if getattr(summary, "record_source", None) == "wfigs" else {})
    perims = perimeters.fetch_perimeters(summary.name, lat, lon, int(summary.started_ms), perim_end,
                                         acres=summary.acres, contained_ms=summary.contained_ms, **ident)
    for w in perims.warnings:
        log.info("estimate_fire_bbox(%s): %s", summary.id, w)
    if perims:
        pick = max(perims, key=lambda p: p["t_ms"]) if live else max(perims, key=lambda p: p["acres"])
        geom = pick["geometry"]
    radius = min(BBOX_SEARCH_MAX_M, max(BBOX_SEARCH_MIN_M, 3.0 * fallback_radius_m(summary.acres)))
    search = _circle_bbox(lat, lon, radius)
    if geom is not None:
        gw, gs, ge, gn = geom.bounds
        search = (min(search[0], gw - 0.02), min(search[1], gs - 0.02), max(search[2], ge + 0.02), max(search[3], gn + 0.02))
    det = _bbox_detections(summary, search, t0, t1)
    xs: list[float] = [lon]
    ys: list[float] = [lat]
    if geom is not None:
        gw, gs, ge, gn = geom.bounds
        xs += [gw, ge]
        ys += [gs, gn]
    if len(det):
        x, y = _local_xy(lat, lon, det["lat"].to_numpy(), det["lon"].to_numpy())
        t = det["t_ms"].to_numpy()
        seeds = np.hypot(x, y) <= BBOX_SEED_RADIUS_M
        if geom is not None:
            import shapely

            k = M_PER_DEG_LAT * math.cos(math.radians(lat))
            g_local = shapely.transform(geom, lambda xy: np.column_stack(((xy[:, 0] - lon) * k, (xy[:, 1] - lat) * M_PER_DEG_LAT)))
            seeds |= shapely.contains_xy(g_local.buffer(CLUSTER_EPS_M), x, y)
        if not seeds.any():
            d = np.hypot(x, y)
            early = (t >= summary.started_ms - 12 * HOUR_MS) & (t <= summary.started_ms + 3 * DAY_MS)
            cand = np.where(early & (d <= BBOX_SEED_FALLBACK_M))[0]
            if len(cand):
                seeds[cand[np.argmin(d[cand])]] = True
        keep = cluster_detections(x, y, t, seeds)
        if keep.any():
            kx, ky = x[keep], y[keep]
            pad = FOOTPRINT_PAD_M
            k = M_PER_DEG_LAT * math.cos(math.radians(lat))
            xs += [lon + (kx.min() - pad) / k, lon + (kx.max() + pad) / k]
            ys += [lat + (ky.min() - pad) / M_PER_DEG_LAT, lat + (ky.max() + pad) / M_PER_DEG_LAT]
    if len(xs) == 1:
        return None
    w, s, e, n = min(xs), min(ys), max(xs), max(ys)
    if box(w, s, e, n).area <= 0:
        return None
    return (float(w), float(s), float(e), float(n))
