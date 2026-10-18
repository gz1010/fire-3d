"""Incident catalog: CAL FIRE lists + FIRMS live feeds -> IncidentSummary (SPEC 4.4, 6, 8.1). Owner: firedata agent.

* Historical: the CAL FIRE list of one year (default :data:`HISTORICAL_YEAR` = 2025; ``year=`` for others, e.g. the
  2026 season), fire types only (Wildfire/Fire), ``acres >= min_acres`` (default 300; pass 0 for all), sorted by
  acres desc. ``detections_24h`` is None and every row keeps mode "historical" (the list's mode; ``is_active`` says
  whether CAL FIRE still lists the fire as active). The current year's list is refreshed every 30 min and overlaid
  with the fresher live-list records of the same fires (and live fires it does not list yet).
* Live: every incident CAL FIRE lists as active with ``Type`` in {Wildfire, Fire}, sorted by ``detections_24h``
  desc then acres desc. ``detections_24h`` counts the California detections of the keyless 24h FIRMS feeds (VIIRS
  x3 + MODIS) near the incident: within ``max(5 km, 2 x the radius of a circle of its acreage)`` (capped at 25 km);
  a detection near several incidents counts once, for the one it is relatively closest to. None if the feeds fail.
* ``bundle_status`` / ``bundle_built_ms`` come from ``DATA_DIR/incidents/{id}/manifest.json`` at call time.
* Ids: ``f"{year}-{slugify(name)}-{uid[:6].lower()}"`` (SPEC 4.4), year = UTC year of ``Started``.

Base lists are cached in memory (live 5 min, the current year 10 min, past years 1 h) on top of the fire3d.http
cache; ``refresh=True`` refetches CAL FIRE and the FIRMS feeds. Every CAL FIRE list this module fetches feeds the
CAL FIRE status history (``sources.calfire_history``): active fires and already tracked ones, so a fire that leaves
the live list gets its record after containment from its year's list.
"""

from __future__ import annotations

import logging
import math
import re
import threading
import time

import numpy as np
import orjson

from . import config
from .contracts import IncidentSummary, Mode
from .grid import fallback_radius_m
from .timeutil import DAY_MS, HOUR_MS, now_ms

log = logging.getLogger(__name__)

HISTORICAL_YEAR = 2025
DEFAULT_MIN_ACRES = 300.0
FIRE_TYPES = frozenset({"wildfire", "fire"})
LIVE_CACHE_S = 300.0
HISTORICAL_CACHE_S = 3600.0
CURRENT_YEAR_CACHE_S = 600.0
DET_RADIUS_MIN_M = 5000.0
DET_RADIUS_FACTOR = 2.0
DET_RADIUS_MAX_M = 25000.0
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
# state-wide total; the FIRMS loaders keep the SPEC's CA bbox because fires near the borders cross them.
CA_OUTLINE = ((-124.8, 42.0), (-120.0, 42.0), (-120.0, 39.0), (-114.633, 35.002), (-114.57, 34.83), (-114.13, 34.27),
              (-114.43, 34.08), (-114.52, 33.6), (-114.50, 33.03), (-114.72, 32.72), (-117.12, 32.53), (-118.6, 32.3),
              (-121.2, 33.6), (-124.8, 40.0))

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_ID_RE = re.compile(r"^(\d{4})-(.+)-([0-9a-f]{6})$")
_lock = threading.Lock()
_cache: dict[str, tuple[float, list[IncidentSummary]]] = {}
_live_total: dict[str, int | None] = {"n": None}


# ------------------------------------------------------------------------------------------------------------------
# Ids
# ------------------------------------------------------------------------------------------------------------------
def slugify(name: str) -> str:
    """SPEC 4.4 slug: lowercase, strip, non-alphanumerics -> "-", repeats collapsed, "-" trimmed."""
    return _SLUG_RE.sub("-", str(name or "").strip().lower()).strip("-")


def make_incident_id(year: int, name: str, uid: str) -> str:
    """``2025-eaton-fire-dbfa57`` (year, slug of the name, first 6 chars of the CAL FIRE UniqueId)."""
    return f"{int(year)}-{slugify(name) or 'incident'}-{str(uid).strip().lower()[:6]}"


def parse_incident_id(incident_id: str) -> tuple[int, str, str] | None:
    """``(year, slug, uid6)`` of a catalog id, or None (e.g. ``fixture-demo``)."""
    m = _ID_RE.match(str(incident_id or ""))
    return (int(m.group(1)), m.group(2), m.group(3)) if m else None


# ------------------------------------------------------------------------------------------------------------------
# Summaries
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


def summary_from_record(rec: dict, mode: Mode, detections_24h: int | None = None) -> IncidentSummary | None:
    """A cleaned CAL FIRE record (``sources.calfire``) -> IncidentSummary (bundle fields "none"/None).
    None when the record lacks a start time, coordinates or UniqueId."""
    if rec.get("started_ms") is None or rec.get("lat") is None or rec.get("lon") is None or not rec.get("uid"):
        return None
    year = int(rec.get("year") or time.gmtime(rec["started_ms"] / 1000).tm_year)
    return IncidentSummary(
        id=make_incident_id(year, rec["name"], rec["uid"]),
        name=rec["name"],
        mode=mode,
        year=year,
        calfire_uid=str(rec.get("UniqueId") or rec["uid"]),
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
        lat=float(rec["lat"]),
        lon=float(rec["lon"]),
        detections_24h=detections_24h,
        bundle_status="none",
        bundle_built_ms=None,
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
    """Search radius around the CAL FIRE point for ``detections_24h``."""
    return float(min(DET_RADIUS_MAX_M, max(DET_RADIUS_MIN_M, DET_RADIUS_FACTOR * fallback_radius_m(acres))))


def assign_detections(incidents: list[tuple[float, float, float]], lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Count detections per incident ``(lat, lon, radius_m)``: a detection within the radius of several incidents
    goes to the one with the smallest distance/radius. Returns int counts aligned with ``incidents``."""
    counts = np.zeros(len(incidents), dtype=np.int64)
    if not incidents or len(lat) == 0:
        return counts
    la = np.asarray(lat, dtype=np.float64)[:, None]
    lo = np.asarray(lon, dtype=np.float64)[:, None]
    ilat = np.array([i[0] for i in incidents])[None, :]
    ilon = np.array([i[1] for i in incidents])[None, :]
    rad = np.array([i[2] for i in incidents])[None, :]
    dy = (la - ilat) * M_PER_DEG_LAT
    dx = (lo - ilon) * M_PER_DEG_LAT * np.cos(np.radians(ilat))
    ratio = np.hypot(dx, dy) / rad
    ok = ratio <= 1.0
    has = ok.any(axis=1)
    best = np.where(ok, ratio, np.inf).argmin(axis=1)
    np.add.at(counts, best[has], 1)
    return counts


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


def _live_base(refresh: bool) -> list[IncidentSummary]:
    from .sources import calfire, firms

    raw = calfire.list_live(refresh=refresh)
    record_history(raw, "live")
    _record_left_live(raw)
    recs = [r for r in raw if r.get("is_active") and r.get("type", "").lower() in FIRE_TYPES]
    summaries = [s for s in (summary_from_record(r, "live") for r in recs) if s is not None]
    counts: list[int | None] = [None] * len(summaries)
    try:
        det = firms.load_live_ca(1, refresh=refresh)
        _live_total["n"] = int(in_california(det["lat"].to_numpy(), det["lon"].to_numpy()).sum())
        c = assign_detections([(s.lat, s.lon, detection_radius_m(s.acres)) for s in summaries], det["lat"].to_numpy(), det["lon"].to_numpy())
        counts = [int(v) for v in c]
        for w in det.attrs.get("warnings", []):
            log.warning("live catalog: %s", w)
    except firms.FirmsError as e:
        _live_total["n"] = None
        log.warning("live catalog: FIRMS 24h feeds unavailable, detections_24h = None (%s)", e)
    out = [s.model_copy(update={"detections_24h": n}) for s, n in zip(summaries, counts)]
    out.sort(key=lambda s: (-(s.detections_24h if s.detections_24h is not None else -1), -(s.acres or 0.0), s.name))
    return out


def _historical_base(refresh: bool, year: int = HISTORICAL_YEAR) -> list[IncidentSummary]:
    recs = [r for r in year_records(year, refresh=refresh) if r.get("type", "").lower() in FIRE_TYPES]
    out = [s for s in (summary_from_record(r, "historical") for r in recs) if s is not None]
    out.sort(key=lambda s: (-(s.acres or 0.0), s.name))
    return out


def _base(mode: Mode, refresh: bool, year: int = HISTORICAL_YEAR) -> list[IncidentSummary]:
    if mode == "live":
        key, ttl = "live", LIVE_CACHE_S
    else:
        key = f"historical:{int(year)}"
        ttl = CURRENT_YEAR_CACHE_S if int(year) >= time.gmtime().tm_year else HISTORICAL_CACHE_S
    with _lock:
        hit = _cache.get(key)
        if hit is not None and not refresh and time.monotonic() - hit[0] < ttl:
            return hit[1]
    rows = _live_base(refresh) if mode == "live" else _historical_base(refresh, int(year))
    with _lock:
        _cache[key] = (time.monotonic(), rows)
    return rows


def get_catalog(mode: Mode, min_acres: float | None = None, refresh: bool = False,
                year: int | None = None) -> list[IncidentSummary]:
    """Live: all active Wildfire/Fire incidents sorted by detections_24h then acres. Historical: the incidents of
    ``year`` (default :data:`HISTORICAL_YEAR`) with acres >= ``min_acres`` (default 300) sorted by acres desc;
    ``year`` is ignored for live. ``bundle_status`` reflects bundles on disk.
    Raises ``sources.calfire.CalFireError`` when CAL FIRE is unreachable and nothing is cached."""
    if mode not in ("live", "historical"):
        raise ValueError(f"mode must be 'live' or 'historical', got {mode!r}")
    rows = _base(mode, refresh, int(year) if year is not None else HISTORICAL_YEAR)
    lo = min_acres if min_acres is not None else (DEFAULT_MIN_ACRES if mode == "historical" else None)
    if lo:
        rows = [s for s in rows if (s.acres or 0.0) >= lo]
    return [_with_bundle(s) for s in rows]


def live_detections_24h_total(refresh: bool = False) -> int | None:
    """Detections inside California (:data:`CA_OUTLINE`) in the keyless 24h feeds, for
    ``LiveStatus.detections_24h_ca``; None if the feeds are unavailable."""
    _base("live", refresh)
    return _live_total["n"]


def clear_cache() -> None:
    """Forget the in-memory catalogs (the HTTP cache is kept)."""
    with _lock:
        _cache.clear()


def get_summary(incident_id: str) -> IncidentSummary | None:
    """The summary for one incident id (either mode), or None.

    Looks in the live catalog, then the 2025 catalog (all sizes), then the CAL FIRE list of the id's year (e.g.
    a 2026 fire no longer active -> mode "historical"), then a bundle on disk (e.g. ``fixture-demo``: the
    manifest's summary)."""
    from .sources import calfire

    for mode in ("live", "historical"):
        try:
            for s in _base(mode, False):
                if s.id == incident_id:
                    return _with_bundle(s)
        except calfire.CalFireError as e:
            log.warning("get_summary(%s): %s catalog unavailable: %s", incident_id, mode, e)
    parsed = parse_incident_id(incident_id)
    if parsed and parsed[0] != HISTORICAL_YEAR:
        year, slug, uid6 = parsed
        try:
            for r in year_records(year):
                if r.get("uid", "").startswith(uid6) and slugify(r.get("name", "")) == slug:
                    s = summary_from_record(r, "live" if r.get("is_active") else "historical")
                    if s is not None:
                        return _with_bundle(s)
        except calfire.CalFireError as e:
            log.warning("get_summary(%s): CAL FIRE %d list unavailable: %s", incident_id, year, e)
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
            df = firms.filter_bbox_time(firms.load_live_ca(7), search, t0, t1)
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
    perims = perimeters.fetch_perimeters(summary.name, lat, lon, int(summary.started_ms), perim_end,
                                         acres=summary.acres, contained_ms=summary.contained_ms)
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
