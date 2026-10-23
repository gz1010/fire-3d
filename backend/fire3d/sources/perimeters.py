"""NIFC WFIGS fire perimeters (SPEC 2, 7.3). Owner: firedata agent.

:func:`fetch_perimeters` returns the perimeters of ONE fire as a list (a :class:`PerimeterList`, which also carries
``.warnings``) of dicts sorted by ``t_ms``; they are NOT cumulative (build/observed does the unions):

  ``t_ms``            int, epoch ms UTC: when the polygon depicts the fire (see "timestamps" below)
  ``acres``           float: ``poly_GISAcres``, or the geodesic area of the geometry when that is missing/0
  ``geometry``        shapely Polygon/MultiPolygon in lon/lat (EPSG:4326), generalised server-side to ~10 m
  ``source``          "NIFC WFIGS daily perimeters" | "NIFC WFIGS current perimeter"
  ``category``        ``poly_FeatureCategory`` ("Wildfire Daily Fire Perimeter", "Wildfire Final Fire Perimeter", ...)
  ``irwin_id``        IRWIN id (str) or None
  ``containment_ms``  ``attr_ContainmentDateTime`` (int) or None
  ``cause``           ``attr_FireCause`` ("Human", "Natural", "Undetermined", ...) or None
  ``name``            WFIGS incident name of the record (complex children keep their own names)
  ``t_field``         which rule produced ``t_ms`` (documents the timestamp quirks below)
  ``object_id``       OBJECTID in the source layer; ``date_current_ms``: ``poly_DateCurrent`` (last edit) or None
  ``discovery_ms``    IRWIN ``attr_FireDiscoveryDateTime`` (int) or None; can be earlier than CAL FIRE "Started"

Brief 3 (CONTRACT 14.12.8): a fire whose record is NIFC WFIGS's (``record_source="wfigs"``) is matched by its IRWIN id
(``attr_IrwinID`` / ``poly_IRWINID``) when known, else by name and its own state (``attr_POOState``); there is no
CAL FIRE hint for it, and the size check stays. California rows (``record_source="calfire"``, the default, complexes
included) take exactly the path below.

Matching (the layers are messy: names recur across years and states, many duplicate edits):
  * name: "Fire"/"Complex" suffixes stripped, ``LIKE`` on ``poly_IncidentName`` OR ``attr_IncidentName`` (plus
    ``attr_CpxName`` for CAL FIRE complexes), then whole-token matching client-side ("KEATON" is not "EATON");
  * state ``US-CA``; prescribed fires excluded; ``attr_FireDiscoveryDateTime`` (when present) within
    [start - 7 d, start + 20 d], which is what separates Gifford 2025 from Gifford 2020/2021/2023;
  * polygon time within [min(start, earliest discovery) - 2 d, min(start + 120 d, end + 2 d)];
  * polygon within 30 km of the CAL FIRE point (60 km for complex children);
  * 0.1-ac placeholder polygons dropped; with a known incident size (``acres``), perimeters larger than
    2 x acres + 500 ac are dropped (Fay Fire: polygons of the neighbouring Little Fire carry Fay's IRWIN id).
  If no record matches by name, records discovered within 1 day of ``start_ms`` and within 10 km are used
  (spatial fallback, reported in ``.warnings``).

Timestamps: ``poly_PolygonDateTime`` -> ``poly_DateCurrent`` -> ``poly_CreateDate`` (SPEC 2), corrected for
quirks seen in the 2025 data:
  * polygon time after the record's last edit (impossible) -> the edit time;
  * polygon time more than 24 h before the record's first edit while the record was created near the polygon time
    ("stale", e.g. Palisades: one record dated Jan 8 14:31 holding the final 23,448 ac, last edited Jan 21) -> the
    edit time (later is safe for the replay, too early is not). Records created long after the fire (backfills,
    e.g. Dias: created 2026-02) keep their polygon time;
  * records sharing one polygon time are successive edits: small changes (< 1 % / 5 ac) are corrections (latest
    edit wins, time kept = SPEC "dedupe per timestamp, max poly_DateCurrent"); bigger changes are new
    observations at their edit time (e.g. Gifford: 13 edits dated Aug 4 21:53 growing 72k -> 104k ac until Aug 9);
  * polygon time before the fire's start -> the edit time (local time typed as UTC, e.g. Madre);
  * edit times shared by several records (bulk attribute edits) are never used;
  * "Final Fire Perimeter" records (and records without a category, e.g. Hughes) are often re-dated by later bulk
    loads (Eaton/Madre/Gifford finals carry 2026-05-12) -> retimed to the containment time: WFIGS
    ``attr_ContainmentDateTime`` / ``attr_ControlDateTime`` / ``attr_FireOutDateTime``, else the CAL FIRE
    containment (``contained_ms``), else the end of the window. Daily perimeters dated more than 7 days after the
    containment are re-dated the same way (Silver: a daily perimeter dated 3 weeks after containment).
"""

from __future__ import annotations

import logging
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable

import numpy as np
import shapely
from pyproj import Geod
from shapely.geometry import MultiPolygon, Point, Polygon, shape
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

from .. import config
from .. import http as fhttp
from ..grid import transformer, utm_epsg_for
from ..timeutil import DAY_MS, HOUR_MS, now_ms
from .calfire import evict_http_cache

log = logging.getLogger(__name__)

ARCGIS_ROOT = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services"
DAILY_URL = f"{ARCGIS_ROOT}/WFIGS_Daily_Perimeters_Public/FeatureServer/0"
CURRENT_URL = f"{ARCGIS_ROOT}/WFIGS_Interagency_Perimeters_Current/FeatureServer/0"
SOURCE_LABELS = {DAILY_URL: "NIFC WFIGS daily perimeters", CURRENT_URL: "NIFC WFIGS current perimeter"}

STATE = "US-CA"
MAX_DISTANCE_M = 30_000.0
COMPLEX_MAX_DISTANCE_M = 60_000.0        # complex children (matched on attr_CpxName) spread further
PREFILTER_DISTANCE_M = 80_000.0          # attr_InitialLatitude/Longitude sanity check before fetching geometry
WINDOW_BEFORE_MS = 2 * DAY_MS
WINDOW_AFTER_MS = 120 * DAY_MS
DISCOVERY_BEFORE_MS = 7 * DAY_MS         # CAL FIRE "Started" can lag IRWIN discovery (Log Fire: 6 days)
DISCOVERY_AFTER_MS = 20 * DAY_MS
POST_CONTAINMENT_SLACK_MS = 7 * DAY_MS   # daily perimeters dated later than containment + this are re-dated
PLACEHOLDER_ACRES = 0.5                  # 0.1-ac placeholder polygons (Jaw, Lidia) are dropped
OVERSIZE_FACTOR = 2.0                    # with a known incident size: drop perimeters > 2 x acres + 500 ac
OVERSIZE_MARGIN_ACRES = 500.0
SERVER_DISCOVERY_SLACK_MS = 30 * DAY_MS
STALE_EDIT_MS = 24 * HOUR_MS
PDT_GROUP_TOL_MS = 2 * 60_000            # polygon times this close belong to the same polygon (edits)
OUT_OF_ORDER_FRAC = 0.05                 # "clearly larger": > 5 % and > 100 ac bigger than a perimeter <= 24 h later
OUT_OF_ORDER_MIN_ACRES = 100.0
OUT_OF_ORDER_WINDOW_MS = 24 * HOUR_MS
EDIT_TOLERANCE_MS = HOUR_MS
CORRECTION_FRAC = 0.01
CORRECTION_MIN_ACRES = 5.0
SPATIAL_FALLBACK_KM = 10.0
SPATIAL_FALLBACK_DISCOVERY_MS = DAY_MS
CURRENT_LAYER_RECENT_MS = 3 * DAY_MS      # also query the "current" layer when end_ms is this close to now
PAGE_SIZE = 2000
GEOMETRY_BATCH = 40
MAX_OFFSET_DEG = 0.0001                   # ~10 m server-side generalisation (fire grids are >= 16 m)
TTL_RECENT_S = 15 * 60.0
TTL_OLD_S = 24 * 3600.0
OLD_FIRE_MS = 150 * DAY_MS

ATTR_FIELDS = (
    "OBJECTID,poly_IncidentName,attr_IncidentName,attr_CpxName,attr_IsCpxChild,poly_FeatureCategory,poly_GISAcres,"
    "poly_PolygonDateTime,poly_DateCurrent,poly_CreateDate,poly_IRWINID,attr_IrwinID,attr_POOState,"
    "attr_FireDiscoveryDateTime,attr_ContainmentDateTime,attr_ControlDateTime,attr_FireOutDateTime,attr_FireCause,"
    "attr_InitialLatitude,attr_InitialLongitude,attr_IncidentTypeCategory"
)
_SUFFIXES = {"FIRE", "COMPLEX", "INCIDENT"}
_TOKEN = re.compile(r"[A-Z0-9]+")
_GEOD = Geod(ellps="WGS84")


class PerimeterError(RuntimeError):
    """A WFIGS query failed (ArcGIS reports errors as JSON with HTTP 200)."""


class PerimeterList(list):
    """A plain list of perimeter dicts plus ``warnings`` (data gaps, fallbacks used)."""

    def __init__(self, items: Iterable[dict] = (), warnings: Iterable[str] = ()):
        super().__init__(items)
        self.warnings: list[str] = list(warnings)


# ------------------------------------------------------------------------------------------------------------------
# Names
# ------------------------------------------------------------------------------------------------------------------
def name_tokens(name: Any) -> list[str]:
    """Upper-case alphanumeric tokens without trailing "Fire"/"Complex"/"Incident" ("6-5 Fire" -> ["6", "5"])."""
    toks = _TOKEN.findall(str(name or "").upper())
    while toks and toks[-1] in _SUFFIXES:
        toks.pop()
    return toks


def name_core(name: Any) -> str:
    """``"Orleans Complex "`` -> ``"ORLEANS"``; ``"TCU September Lightning Complex"`` -> ``"TCU SEPTEMBER LIGHTNING"``."""
    return " ".join(name_tokens(name))


def _contains_run(hay: list[str], needle: list[str]) -> bool:
    n = len(needle)
    return n > 0 and any(hay[i:i + n] == needle for i in range(len(hay) - n + 1))


def name_matches(core_tokens: list[str], candidate: Any) -> bool:
    """Whole-token match between a CAL FIRE name core and a WFIGS name: equal ignoring spaces ("LA PORTE" ~
    "LAPORTE"), or one is a contiguous token run of the other ("RANCH" ~ "BDU/RANCH"; never "EATON" ~ "KEATON")."""
    cand = name_tokens(candidate)
    if not core_tokens or not cand:
        return False
    if "".join(core_tokens) == "".join(cand):
        return True
    if _contains_run(cand, core_tokens):
        return True
    return len("".join(cand)) >= 4 and _contains_run(core_tokens, cand)


def _ts(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def build_where(name: str, start_ms: int, *, include_complex: bool = False, state: str = STATE) -> str:
    """Server-side filter: state (``US-CA`` unless given), name ``LIKE`` (tokens joined by ``%``) and a coarse
    discovery-time window."""
    toks = name_tokens(name)
    if not toks:
        raise ValueError(f"cannot match an empty fire name: {name!r}")
    if not re.fullmatch(r"US-[A-Z]{2}", state):
        raise ValueError(f"invalid WFIGS state code {state!r}")
    pat = "%" + "%".join(toks) + "%"          # tokens are [A-Z0-9]+: nothing to escape
    fields = ["poly_IncidentName", "attr_IncidentName"] + (["attr_CpxName"] if include_complex else [])
    like = " OR ".join(f"UPPER({f}) LIKE '{pat}'" for f in fields)
    a, b = _ts(start_ms - SERVER_DISCOVERY_SLACK_MS), _ts(start_ms + SERVER_DISCOVERY_SLACK_MS)
    return (f"attr_POOState='{state}' AND ({like}) AND (attr_FireDiscoveryDateTime IS NULL OR "
            f"(attr_FireDiscoveryDateTime >= TIMESTAMP '{a}' AND attr_FireDiscoveryDateTime <= TIMESTAMP '{b}'))")


_IRWIN_RE = re.compile(r"[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}")


def norm_irwin(v: Any) -> str | None:
    """An IRWIN id upper case without braces, or None when it is not one."""
    s = str(v or "").strip().strip("{}").upper()
    return s if _IRWIN_RE.fullmatch(s) else None


def irwin_where(irwin_id: str) -> str:
    """Server-side filter on the IRWIN id in either field, with or without braces (WFIGS stores both forms)."""
    x = norm_irwin(irwin_id)
    if x is None:
        raise ValueError(f"not an IRWIN id: {irwin_id!r}")
    forms = f"('{{{x}}}', '{x}')"
    return f"(UPPER(attr_IrwinID) IN {forms} OR UPPER(poly_IRWINID) IN {forms})"


def wfigs_state(state: str | None) -> str | None:
    """``"MT"`` -> ``"US-MT"`` (WFIGS ``attr_POOState``); None for anything else."""
    st = str(state or "").strip().upper()
    return f"US-{st}" if re.fullmatch(r"[A-Z]{2}", st) else None


# ------------------------------------------------------------------------------------------------------------------
# ArcGIS access
# ------------------------------------------------------------------------------------------------------------------
def _arcgis_json(url: str, params: dict, ttl_s: float) -> dict:
    """GET an ArcGIS query (cached); JSON errors returned with status 200 are evicted and raised; when the service
    is unreachable a stale cached copy is used."""
    def once(ttl: float | None, retries: int) -> dict:
        try:
            data = fhttp.get_json(url, params, ttl_s=ttl, timeout=60.0, retries=retries)
        except ValueError as e:
            evict_http_cache(url, params)
            raise PerimeterError(f"WFIGS: invalid JSON from {url.split('/services/')[-1]}: {e}") from None
        if not isinstance(data, dict) or "error" in data:
            evict_http_cache(url, params)
            err = data.get("error") if isinstance(data, dict) else data
            raise PerimeterError(f"WFIGS query error ({url.split('/services/')[-1]}): {err}")
        return data

    try:
        return once(ttl_s, fhttp.DEFAULT_RETRIES)
    except (fhttp.HttpError, PerimeterError) as e:
        try:
            data = once(None, 0)
        except (fhttp.HttpError, PerimeterError):
            raise PerimeterError(str(e)) from None
        log.warning("WFIGS unavailable (%s); using a cached response", e)
        return data


def query_attributes(url: str, where: str, ttl_s: float, extra: dict | None = None) -> list[dict]:
    """All matching records (attributes only), paginated with resultOffset. Each dict gets ``_layer`` = url."""
    out: list[dict] = []
    offset = 0
    while True:
        params = {"where": where, "outFields": ATTR_FIELDS, "returnGeometry": "false", "f": "json",
                  "orderByFields": "OBJECTID", "resultOffset": offset, "resultRecordCount": PAGE_SIZE, **(extra or {})}
        data = _arcgis_json(url + "/query", params, ttl_s)
        feats = data.get("features") or []
        for f in feats:
            a = dict(f.get("attributes") or {})
            a["_layer"] = url
            out.append(a)
        if not data.get("exceededTransferLimit") or not feats or offset > 50_000:
            return out
        offset += len(feats)


def fetch_geometries(url: str, object_ids: list[int], ttl_s: float) -> dict[int, Any]:
    """``{OBJECTID: shapely geometry (lon/lat)}`` via ``f=geojson``, ``outSR=4326``, ~10 m generalisation."""
    out: dict[int, Any] = {}
    ids = sorted({int(i) for i in object_ids})
    for k in range(0, len(ids), GEOMETRY_BATCH):
        batch = ids[k:k + GEOMETRY_BATCH]
        params = {"objectIds": ",".join(map(str, batch)), "outFields": "OBJECTID", "returnGeometry": "true", "outSR": 4326,
                  "f": "geojson", "maxAllowableOffset": MAX_OFFSET_DEG, "geometryPrecision": 6}
        data = _arcgis_json(url + "/query", params, ttl_s)
        for f in data.get("features") or []:
            oid = (f.get("properties") or {}).get("OBJECTID", f.get("id"))
            g = f.get("geometry")
            if oid is None or not g:
                continue
            geom = clean_geometry(shape(g))
            if geom is not None:
                out[int(oid)] = geom
    return out


def clean_geometry(geom: Any) -> Polygon | MultiPolygon | None:
    """Valid polygonal geometry (invalid rings repaired, non-polygon parts dropped) or None if empty."""
    if geom is None or geom.is_empty:
        return None
    if not geom.is_valid:
        geom = shapely.make_valid(geom)
    if geom.geom_type not in ("Polygon", "MultiPolygon"):
        polys = [g for g in getattr(geom, "geoms", []) if g.geom_type in ("Polygon", "MultiPolygon")]
        if not polys:
            return None
        geom = unary_union(polys)
    return None if geom.is_empty else geom


def geodesic_acres(geom: Any) -> float:
    """Area on the WGS84 ellipsoid, in acres (holes subtracted)."""
    if geom is None or geom.is_empty:
        return 0.0
    polys = [geom] if geom.geom_type == "Polygon" else list(getattr(geom, "geoms", []))
    total = 0.0
    for p in polys:
        if p.geom_type == "Polygon" and not p.is_empty:
            area, _ = _GEOD.geometry_area_perimeter(orient(p, 1.0))
            total += abs(area)
    return total / config.ACRE_M2


def distance_m(geom: Any, lat: float, lon: float) -> float:
    """Distance (m) from the point to the geometry (0 inside), computed in the point's UTM zone."""
    epsg = utm_epsg_for(lon)
    tr = transformer(4326, epsg)
    g = shapely.transform(geom, lambda xy: np.column_stack(tr.transform(xy[:, 0], xy[:, 1])))
    px, py = tr.transform(lon, lat)
    return float(g.distance(Point(px, py)))


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6_371_000.0 * math.asin(min(1.0, math.sqrt(a)))


# ------------------------------------------------------------------------------------------------------------------
# Record selection + timestamps (pure functions on attribute dicts; tested offline)
# ------------------------------------------------------------------------------------------------------------------
def _int(v: Any) -> int | None:
    try:
        return None if v is None else int(v)
    except (TypeError, ValueError):
        return None


def _acres_attr(a: dict) -> float | None:
    v = a.get("poly_GISAcres")
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) and f > 0 else None


def _key(a: dict) -> str:
    irwin = (a.get("attr_IrwinID") or a.get("poly_IRWINID") or "").strip().strip("{}").upper()
    return irwin or "name:" + name_core(a.get("poly_IncidentName") or a.get("attr_IncidentName"))


def identity_filter(records: list[dict], name: str, lat: float, lon: float, start_ms: int, *, complex_: bool | None = None,
                    state: str = STATE, irwin_id: str | None = None) -> list[dict]:
    """Records that belong to this fire by state, category, name tokens, discovery time and (coarse) origin. With
    ``irwin_id`` (a WFIGS fire) the IRWIN id replaces the name and state tests."""
    core = name_tokens(name)
    if complex_ is None:
        complex_ = "COMPLEX" in str(name).upper()
    lo, hi = start_ms - DISCOVERY_BEFORE_MS, start_ms + DISCOVERY_AFTER_MS
    want = norm_irwin(irwin_id) if irwin_id else None
    out = []
    for a in records:
        cat = (a.get("poly_FeatureCategory") or "").lower()
        if want is not None:
            if want not in (norm_irwin(a.get("attr_IrwinID")), norm_irwin(a.get("poly_IRWINID"))):
                continue
            own, via_cpx = True, False
        else:
            if (a.get("attr_POOState") or "").strip().upper() != state:
                continue
            own = via_cpx = False
        if "prescribed" in cat or (a.get("attr_IncidentTypeCategory") or "").strip().upper() == "RX":
            continue
        if want is None:
            own = any(name_matches(core, n) for n in (a.get("poly_IncidentName"), a.get("attr_IncidentName")) if n)
            via_cpx = bool(complex_ and not own and a.get("attr_CpxName") and name_matches(core, a.get("attr_CpxName")))
        if not (own or via_cpx):
            continue
        disc = _int(a.get("attr_FireDiscoveryDateTime"))
        if disc is not None and not (lo <= disc <= hi):
            continue
        ilat, ilon = a.get("attr_InitialLatitude"), a.get("attr_InitialLongitude")
        if isinstance(ilat, (int, float)) and isinstance(ilon, (int, float)) and (ilat or ilon):
            if _haversine_m(lat, lon, float(ilat), float(ilon)) > PREFILTER_DISTANCE_M:
                continue
        out.append({**a, "_via_complex": via_cpx})
    return out


@dataclass
class Observation:
    """One perimeter observation chosen from one or more WFIGS edits of a record group."""

    t_ms: int
    t_field: str
    rec: dict
    key: str


def _substantive(a_old: dict, a_new: dict) -> bool:
    x, y = _acres_attr(a_old), _acres_attr(a_new)
    if x is None or y is None:
        return False
    return abs(y - x) > max(CORRECTION_FRAC * max(x, y), CORRECTION_MIN_ACRES)


def _edit_fn(records: list[dict]):
    """``edit(rec)`` = poly_DateCurrent unless it is a bulk-edit time shared by several records of the same layer
    (then None). The "current" layer repeats the newest daily record, so layers are counted separately."""
    dcs = Counter((a.get("_layer"), _int(a.get("poly_DateCurrent"))) for a in records if a.get("poly_DateCurrent") is not None)
    bulk = {k for k, n in dcs.items() if n >= 2}

    def edit(a: dict) -> int | None:
        dc = _int(a.get("poly_DateCurrent"))
        return dc if dc is not None and (a.get("_layer"), dc) not in bulk else None

    return edit


def _edit_groups(records: list[dict]) -> list[tuple[str, str, int, list[dict]]]:
    """``[(key, kind, t0, recs)]``: successive edits of one polygon (same incident key and layer, polygon times
    within PDT_GROUP_TOL_MS; records without a polygon time group on their exact edit/creation time)."""
    by_kind: dict[tuple, list[tuple[int, dict]]] = defaultdict(list)
    for a in records:
        pdt, dc, cd = (_int(a.get(k)) for k in ("poly_PolygonDateTime", "poly_DateCurrent", "poly_CreateDate"))
        kind, t0 = ("pdt", pdt) if pdt is not None else ("dc", dc) if dc is not None else ("cd", cd)
        if t0 is not None:
            by_kind[(_key(a), str(a.get("_layer")), kind)].append((t0, a))
    groups: list[tuple[str, str, int, list[dict]]] = []
    for (key, _layer, kind), items in by_kind.items():
        items.sort(key=lambda it: it[0])
        tol = PDT_GROUP_TOL_MS if kind == "pdt" else 0
        current: list[dict] = []
        g0 = 0
        for t0, a in items:
            if current and t0 - g0 <= tol:
                current.append(a)
                continue
            if current:
                groups.append((key, kind, g0, current))
            current, g0 = [a], t0
        if current:
            groups.append((key, kind, g0, current))
    return groups


def assign_times(records: list[dict], start_ms: int) -> list[Observation]:
    """Effective timestamps + per-timestamp dedupe (module doc, "Timestamps")."""
    edit = _edit_fn(records)
    obs: list[Observation] = []
    for key, kind, t0, recs in _edit_groups(records):
        recs.sort(key=lambda a: (_int(a.get("poly_DateCurrent")) or _int(a.get("poly_CreateDate")) or 0, _int(a.get("OBJECTID")) or 0))
        first = recs[0]
        e = edit(first)
        disc = _int(first.get("attr_FireDiscoveryDateTime"))
        ref_start = min(start_ms, disc) if disc is not None else start_ms
        t, why = t0, {"pdt": "poly_PolygonDateTime", "dc": "poly_DateCurrent", "cd": "poly_CreateDate"}[kind]
        if kind == "pdt" and e is not None:
            cd = _int(first.get("poly_CreateDate"))
            if t0 > e + EDIT_TOLERANCE_MS:
                t, why = e, "poly_DateCurrent (polygon time after its last edit)"
            elif e - t0 > STALE_EDIT_MS and (cd is None or cd - t0 <= STALE_EDIT_MS):
                t, why = e, "poly_DateCurrent (stale polygon time)"
        if t < ref_start - EDIT_TOLERANCE_MS and e is not None and e >= ref_start - EDIT_TOLERANCE_MS:
            t, why = e, "poly_DateCurrent (polygon time before the fire start)"
        cur = Observation(t, why, first, key)
        for a in recs[1:]:
            e2 = edit(a)
            if _substantive(cur.rec, a) and e2 is not None and e2 > cur.t_ms:
                obs.append(cur)
                cur = Observation(e2, "poly_DateCurrent (re-edited polygon)", a, key)
            else:
                cur.rec = a                          # correction: the latest edit wins, the time stays
        obs.append(cur)
    return fix_out_of_order(_dedupe(obs), edit)


def _dedupe(obs: list[Observation]) -> list[Observation]:
    """One observation per (key, t): the latest edit (max poly_DateCurrent, then the daily layer, then max OBJECTID)."""
    best: dict[tuple[str, int], tuple[tuple, Observation]] = {}
    for o in obs:
        k = (o.key, o.t_ms)
        rank = (_int(o.rec.get("poly_DateCurrent")) or 0, o.rec.get("_layer") == DAILY_URL, _int(o.rec.get("OBJECTID")) or 0)
        if k not in best or rank > best[k][0]:
            best[k] = (rank, o)
    return sorted((o for _, o in best.values()), key=lambda o: (o.t_ms, o.key))


def _bigger(a_big: dict, a_small: dict) -> bool:
    x, y = _acres_attr(a_big), _acres_attr(a_small)
    return x is not None and y is not None and x > (1.0 + OUT_OF_ORDER_FRAC) * y + OUT_OF_ORDER_MIN_ACRES


def fix_out_of_order(obs: list[Observation], edit=None) -> list[Observation]:
    """A perimeter clearly larger than a later one of the same incident within 24 h usually carries a local time
    typed as UTC (Gifford: 30,519 ac "15:36" vs 23,588 ac 17:20, record created 23:11). Move it to the first of its
    creation/edit times that restores the order (later is safe for the replay); otherwise leave it."""
    edit = edit or (lambda a: _int(a.get("poly_DateCurrent")))
    for _ in range(3):
        changed = False
        by_key: dict[str, list[Observation]] = defaultdict(list)
        for o in obs:
            by_key[o.key].append(o)
        for items in by_key.values():
            items.sort(key=lambda o: o.t_ms)
            for i, o in enumerate(items):
                later = [p for p in items[i + 1:] if o.t_ms < p.t_ms <= o.t_ms + OUT_OF_ORDER_WINDOW_MS and _bigger(o.rec, p.rec)]
                if not later:
                    continue
                need = max(p.t_ms for p in later)
                cands = sorted(c for c in (_int(o.rec.get("poly_CreateDate")), edit(o.rec)) if c is not None and c >= need)
                if cands:
                    o.t_ms, o.t_field = cands[0], "poly_CreateDate/poly_DateCurrent (out-of-order polygon time)"
                    changed = True
        if not changed:
            break
    return _dedupe(obs)


def _containment(a: dict, start_ms: int, contained_ms: int | None) -> tuple[int | None, str]:
    """The fire's containment time for re-dating: WFIGS containment / control / out (within [start, start + 120 d]),
    else the CAL FIRE containment."""
    for fld in ("attr_ContainmentDateTime", "attr_ControlDateTime", "attr_FireOutDateTime"):
        v = _int(a.get(fld))
        if v is not None and start_ms <= v <= start_ms + WINDOW_AFTER_MS:
            return v, fld
    if contained_ms is not None and contained_ms >= start_ms:
        return int(contained_ms), "CAL FIRE containment"
    return None, ""


def retime_finals(obs: list[Observation], start_ms: int, end_ms: int, contained_ms: int | None = None,
                  earliest_ms: int | None = None) -> list[Observation]:
    """Re-date perimeters dated after the fire's containment (finals / uncategorised: any time after it; dailies:
    more than 7 d after it), clamp finals to the window end, then keep [earliest - 2 d, min(start + 120 d,
    end + 2 d)] (``earliest`` = min(start, IRWIN discovery)) and dedupe again per (incident, time)."""
    lo = min(start_ms, earliest_ms if earliest_ms is not None else start_ms) - WINDOW_BEFORE_MS
    hi = min(start_ms + WINDOW_AFTER_MS, int(end_ms) + WINDOW_BEFORE_MS)
    out: list[Observation] = []
    for o in obs:
        cat = (o.rec.get("poly_FeatureCategory") or "").strip().lower()
        final = "final" in cat or not cat
        end_t, fld = _containment(o.rec, start_ms, contained_ms)
        if end_t is not None and o.t_ms > end_t + (0 if final else POST_CONTAINMENT_SLACK_MS):
            o.t_ms, o.t_field = end_t, f"{fld} ({'final perimeter' if final else 'perimeter dated after containment'} re-dated)"
        if final and o.t_ms > hi:
            o.t_ms, o.t_field = hi, "window end (final perimeter re-dated)"
        if lo <= o.t_ms <= hi:
            out.append(o)
    return _dedupe(out)


def _merge_same_time(items: list[dict]) -> list[dict]:
    """Union perimeters of different incident keys that share a timestamp (complex children)."""
    by_t: dict[int, list[dict]] = defaultdict(list)
    for it in items:
        by_t[it["t_ms"]].append(it)
    out = []
    for t, group in sorted(by_t.items()):
        if len(group) == 1:
            out.append(group[0])
            continue
        group.sort(key=lambda d: -d["acres"])
        merged = dict(group[0])
        merged["geometry"] = clean_geometry(unary_union([g["geometry"] for g in group])) or group[0]["geometry"]
        merged["acres"] = geodesic_acres(merged["geometry"])
        merged["name"] = " + ".join(dict.fromkeys(g["name"] for g in group if g["name"]))
        merged["t_field"] = group[0]["t_field"] + f" (union of {len(group)} records)"
        out.append(merged)
    return out


# ------------------------------------------------------------------------------------------------------------------
# Public API
# ------------------------------------------------------------------------------------------------------------------
def _ttl_for(start_ms: int) -> float:
    return TTL_OLD_S if now_ms() - start_ms > OLD_FIRE_MS else TTL_RECENT_S


def _spatial_candidates(lat: float, lon: float, start_ms: int, ttl: float, state: str = STATE) -> list[dict]:
    a, b = _ts(start_ms - SPATIAL_FALLBACK_DISCOVERY_MS), _ts(start_ms + SPATIAL_FALLBACK_DISCOVERY_MS)
    where = (f"attr_POOState='{state}' AND attr_FireDiscoveryDateTime >= TIMESTAMP '{a}' AND "
             f"attr_FireDiscoveryDateTime <= TIMESTAMP '{b}'")
    extra = {"geometry": f"{lon:.6f},{lat:.6f}", "geometryType": "esriGeometryPoint", "inSR": 4326,
             "spatialRel": "esriSpatialRelIntersects", "distance": SPATIAL_FALLBACK_KM, "units": "esriSRUnit_Kilometer"}
    recs = [r for r in query_attributes(DAILY_URL, where, ttl, extra)
            if "prescribed" not in (r.get("poly_FeatureCategory") or "").lower()]
    if not recs:
        return []
    by_key: dict[str, list[dict]] = defaultdict(list)
    for r in recs:
        by_key[_key(r)].append(r)
    best = min(by_key.values(), key=lambda rs: abs((_int(rs[0].get("attr_FireDiscoveryDateTime")) or start_ms) - start_ms))
    return best


def _calfire_hint(name: str, start_ms: int) -> tuple[float | None, int | None]:
    """(acres, containment ms) of the CAL FIRE incident with this name that started within 6 h of ``start_ms``
    (cached yearly list; best effort)."""
    from . import calfire

    try:
        recs = calfire.list_year(datetime.fromtimestamp(start_ms / 1000.0, tz=timezone.utc).year)
    except Exception as e:  # noqa: BLE001 - a hint only
        log.debug("CAL FIRE hint unavailable: %s", e)
        return None, None
    core = name_tokens(name)
    for r in recs:
        if r.get("started_ms") is not None and abs(r["started_ms"] - start_ms) <= 6 * HOUR_MS and name_tokens(r.get("name")) == core:
            return r.get("acres"), r.get("extinguished_ms")
    return None, None


def fetch_perimeters(name: str, lat: float, lon: float, start_ms: int, end_ms: int, *, acres: float | None = None,
                     contained_ms: int | None = None, record_source: str = "calfire", state: str | None = None,
                     irwin_id: str | None = None) -> PerimeterList:
    """Perimeters of the incident ``name`` at (``lat``, ``lon``) that started at ``start_ms``, with polygon times up
    to ``end_ms`` (+2 d). See the module doc for the dict schema, matching rules and timestamp fixes.

    ``acres`` / ``contained_ms`` (the record's size and containment, e.g. ``summary.acres`` /
    ``summary.contained_ms``) enable the oversize check and re-dating finals that WFIGS dates later; for a CAL FIRE
    record, when both are None they are looked up in the CAL FIRE list of the start year. ``record_source="wfigs"``
    (CONTRACT 14.12.8): matched by ``irwin_id`` when given, else by name in ``state`` (USPS); California records
    ignore ``state`` and ``irwin_id``. Never raises for service problems: returns what it could get, with
    ``.warnings`` explaining gaps."""
    start_ms, end_ms = int(start_ms), int(end_ms)
    warnings: list[str] = []
    wfigs_row = record_source == "wfigs"
    st = (wfigs_state(state) or "") if wfigs_row else STATE
    by_irwin = norm_irwin(irwin_id) if wfigs_row else None
    if wfigs_row and by_irwin is None and not st:
        return PerimeterList([], ["no IRWIN id and no state for this NIFC WFIGS fire: perimeters not matched"])
    if acres is None and contained_ms is None and not wfigs_row:
        acres, contained_ms = _calfire_hint(name, start_ms)
    try:
        if by_irwin is not None:
            where = irwin_where(by_irwin)
        elif wfigs_row:
            where = build_where(name, start_ms, state=st)
        else:
            where = build_where(name, start_ms, include_complex="COMPLEX" in str(name).upper())
    except ValueError as e:
        return PerimeterList([], [str(e)])
    ttl = _ttl_for(start_ms)
    layers = [DAILY_URL] + ([CURRENT_URL] if end_ms >= now_ms() - CURRENT_LAYER_RECENT_MS else [])
    records: list[dict] = []
    failed = 0
    for url in layers:
        try:
            records += query_attributes(url, where, ttl)
        except PerimeterError as e:
            failed += 1
            warnings.append(f"{SOURCE_LABELS[url]} unavailable: {e}")
    if failed == len(layers):
        return PerimeterList([], warnings)
    if wfigs_row:
        cands = identity_filter(records, name, lat, lon, start_ms, complex_=False, state=st, irwin_id=by_irwin)
    else:
        cands = identity_filter(records, name, lat, lon, start_ms)
    if not cands:
        try:
            spatial = _spatial_candidates(lat, lon, start_ms, ttl, st)
        except PerimeterError as e:
            spatial = []
            warnings.append(f"WFIGS spatial fallback failed: {e}")
        if spatial:
            names = sorted({str(r.get("poly_IncidentName") or r.get("attr_IncidentName")) for r in spatial})
            how = f"with IRWIN id {by_irwin}" if by_irwin else f"named like {name!r}"
            warnings.append(f"no WFIGS perimeter {how}; matched by place and discovery time: {', '.join(names)}")
            cands = spatial
    discs = [d for d in (_int(a.get("attr_FireDiscoveryDateTime")) for a in cands) if d is not None and d >= start_ms - DISCOVERY_BEFORE_MS]
    earliest = min([start_ms] + discs)
    obs = retime_finals(assign_times(cands, start_ms), start_ms, end_ms, contained_ms, earliest)
    if not obs:
        return PerimeterList([], warnings)
    geoms: dict[tuple[str, int], Any] = {}
    for url in layers:
        ids = [_int(o.rec.get("OBJECTID")) for o in obs if o.rec.get("_layer") == url]
        ids = [i for i in ids if i is not None]
        if not ids:
            continue
        try:
            for oid, g in fetch_geometries(url, ids, ttl).items():
                geoms[(url, oid)] = g
        except PerimeterError as e:
            warnings.append(f"{SOURCE_LABELS[url]} geometry download failed: {e}")
    items: list[dict] = []
    far = tiny = big = 0
    for o in obs:
        a = o.rec
        g = geoms.get((a.get("_layer"), _int(a.get("OBJECTID"))))
        if g is None:
            continue
        if distance_m(g, lat, lon) >= (COMPLEX_MAX_DISTANCE_M if a.get("_via_complex") else MAX_DISTANCE_M):
            far += 1
            continue
        size = float(_acres_attr(a) or geodesic_acres(g))
        if size < PLACEHOLDER_ACRES:
            tiny += 1
            continue
        if acres and size > OVERSIZE_FACTOR * float(acres) + OVERSIZE_MARGIN_ACRES:
            big += 1
            continue
        irwin = (a.get("attr_IrwinID") or a.get("poly_IRWINID") or "").strip() or None
        items.append({
            "t_ms": int(o.t_ms),
            "acres": size,
            "geometry": g,
            "source": SOURCE_LABELS.get(a.get("_layer"), "NIFC WFIGS"),
            "category": a.get("poly_FeatureCategory") or "",
            "irwin_id": irwin,
            "containment_ms": _int(a.get("attr_ContainmentDateTime")),
            "cause": (a.get("attr_FireCause") or "").strip() or None,
            "name": str(a.get("poly_IncidentName") or a.get("attr_IncidentName") or "").strip(),
            "t_field": o.t_field,
            "object_id": _int(a.get("OBJECTID")),
            "date_current_ms": _int(a.get("poly_DateCurrent")),
            "discovery_ms": _int(a.get("attr_FireDiscoveryDateTime")),
        })
    if far:
        warnings.append(f"{far} WFIGS perimeter(s) named like {name!r} dropped: more than {MAX_DISTANCE_M / 1000:.0f} km away")
    if tiny:
        warnings.append(f"{tiny} WFIGS placeholder perimeter(s) (< {PLACEHOLDER_ACRES} ac) dropped")
    if big:
        warnings.append(f"{big} WFIGS perimeter(s) dropped: larger than {OVERSIZE_FACTOR:g} x the incident's {acres:,.0f} ac + {OVERSIZE_MARGIN_ACRES:.0f} ac")
    return PerimeterList(_merge_same_time(items), warnings)
