"""Observed fire progression (SPEC 8.3). Owner: observed agent.

:func:`build_observed` turns satellite fire detections and mapped perimeters into the bundle's observed spread:

1. **Detections** (``sources.firms.detections_for`` over the AOI bbox for [start - 12 h, end]). VIIRS x3, MODIS and
   Landsat say *where* the fire burned. GOES (10-min scans, ~2 km pixels) says *when*: ignition time, the FRP activity
   curve and ``frp_mw_per_h``. GOES never enters the spatial mask. Detections are filtered in this order:

   * the SPEC 8.3 confidence filter;
   * static sources: places that were already hot on 2+ days in the week before ignition, or that FIRMS tags as
     static land sources;
   * space-time clustering (1.5 km, 2 days), seeded at the ignition point and on the perimeters, which drops other
     fires inside the AOI.

   GOES pixels are kept within 4 km of this fire unless another fire's detections are closer.
2. **Perimeters** (``sources.perimeters.fetch_perimeters``): cumulative unions in local coordinates. A perimeter more
   than 20 % smaller than the earlier ones is dropped and flagged. Perimeters dated more than 24 h after the
   detections stopped growing (finals re-dated to containment, stale edits) define the extent only, not timing.
3. **Final burned mask F**:

   * With a perimeter covering >= 75 % of the CAL FIRE acres: the perimeter (plus growth detected after it, live
     fires). VIIRS footprints reach up to a pixel past the true edge, so no detection rim is added (it inflated
     Eaton by 20 %).
   * Otherwise: perimeter ∪ the union of footprints shrunk to 2/3 of the pixel (MODIS to 0.4, and only near
     VIIRS/Landsat), closed, hole-filled and smoothed. Without a perimeter the shrink is calibrated to the CAL FIRE
     acres when it misses them by more than 20 %.
4. **Snapshots** ``B_k`` at every overpass group (detections chained within 30 min) and every trusted perimeter time.
   They are cumulative and clipped to F. Further rules:

   * The first snapshot is joined to the ignition by cones and closed.
   * Later detached areas are joined by a cone within 1 km; areas under 10 ha are deferred.
   * Probable spot fires stay detached and grow from their own core.
5. **Arrival**: distance-ratio interpolation between snapshots, with time inside each interval warped by the GOES
   fire radiative power, so growth happens when the fire was active. Then:

   * pixels whose snapshot says little about their timing (seen only in a perimeter, or late hot spots inside an
     area the fire had already enclosed) burn no later than their neighbours plus travel time;
   * pixels of F that no snapshot covers get that neighbour estimate too;
   * a masked median, sink filling and a bilateral filter give smooth, speckle-free fronts. With sink filling, every
     area connects to the ignition through earlier-burning pixels, unless that would delay observed burning by more
     than 12 h.
6. **Ignition**: the CAL FIRE point at the CAL FIRE start, moved into F when it lies outside. When the point is more
   than 3 km from the earliest detections, their centroid is used instead. The time moves earlier when the first
   persistent GOES detection, or a polar detection near the point, comes before the start.
7. **Outputs**:

   * ``timeseries.json``;
   * ``events.json``: ignition, rapid growth, spot fires, ridge crossings, an inferred wind shift, perimeter updates
     and containment (``peak_wind`` is added by the pipeline);
   * ``detections.json`` (GOES thinned);
   * ``perimeters.json``;
   * the ``observed_arrival`` layer;
   * the manifest's ``ignition``, ``default_profile_path``, ``time_range``, ``stats``, ``data_sources`` and
     ``warnings`` (this module's entries are replaced on every run).

Standalone dev runner with quick-look PNGs: ``uv run python -m fire3d.build.observed --help``.
"""

from __future__ import annotations

import argparse
import logging
import math
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Sequence
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import shapely
from scipy import ndimage
from shapely.geometry import box
from shapely.geometry.base import BaseGeometry

from .. import bundle, config
from ..grid import Grid
from ..timeutil import DAY_MS, HOUR_MS, floor_hour_ms, ms_to_iso, now_ms
from ..types import BuildContext
from . import live_observation as la_obs

log = logging.getLogger(__name__)

NEVER = float(config.NEVER)
STEP = "observations"
LA = ZoneInfo("America/Los_Angeles")
SPATIAL_INSTRUMENTS = ("VIIRS", "MODIS", "LANDSAT")

# --- time windows -------------------------------------------------------------------------------------------------
PRE_START_MS = 12 * HOUR_MS              # detections from started - 12 h (SPEC 8.3)
MAX_SPAN_MS = 45 * DAY_MS                # never look further than 45 days after the start
MIN_HIST_SPAN_MS = 7 * DAY_MS
DEFAULT_HIST_SPAN_MS = 14 * DAY_MS
PERIM_HORIZON_MS = 120 * DAY_MS
STATIC_LOOKBACK_MS = 7 * DAY_MS          # pre-fire window that reveals static hot spots

# --- static sources and clustering ---------------------------------------------------------------------------------
STATIC_SITE_RADIUS_M = 500.0
STATIC_REMOVE_RADIUS_M = 600.0
STATIC_MIN_DAYS = 2
STATIC_IGNITION_GUARD_M = 2000.0
CLUSTER_EPS_M = 1500.0
CLUSTER_EPS_MS = 2 * DAY_MS
SEED_RADIUS_M = 3000.0
SEED_WINDOW_MS = 2 * DAY_MS
SEED_FALLBACK_M = 10_000.0
SEED_FALLBACK_MS = 3 * DAY_MS
PERIM_SEED_BUFFER_M = 375.0
GOES_MAX_DIST_M = 4000.0
GOES_RIVAL_WINDOW_MS = 12 * HOUR_MS

# --- footprints and masks ------------------------------------------------------------------------------------------
SHRINK = {"VIIRS": 2.0 / 3.0, "MODIS": 0.4, "LANDSAT": 1.0}   # fraction of the pixel side kept (VIIRS bloat)
NOMINAL_PIXEL_KM = {"VIIRS": 0.375, "MODIS": 1.0, "GOES": 2.0, "LANDSAT": 0.03}
GOES_FOOTPRINT_M = 2000.0
SMOOTH_M = 90.0                          # Gaussian smoothing of masks (no speckle, round fronts)
HOLE_MAX_M2 = 100 * 10_000.0             # holes < 100 ha inside detection masks are filled
PERIM_NEAR_M = 300.0
PERIM_COMPLETE_FRAC = 0.75               # perimeter >= 75 % of the CAL FIRE acres: it defines F
OUTSIDE_FRAC_MAX = 0.15
FIRST_CLOSE_M = 400.0                    # the first snapshot (cones from the ignition) is closed with this radius
ENVELOPE_M = 500.0                       # new pixels inside the closed earlier burned area are infill, not growth
SPOT_ENVELOPE_M = 1000.0                 # spot fires must lie outside the earlier burned area closed by 1 km
CALIBRATE_TOL = 0.2
CALIBRATE_MAX_ERODE_M = 400.0            # extra erosion when even the strongest shrink overstates the CAL FIRE acres
SHRINK_RANGE = (0.45, 1.0)
SNAPSHOT_SHRINK = 0.45                   # VIIRS footprint fraction for the timing snapshots
PERIM_SHRINK_FRAC = 0.8                  # drop perimeters > 20 % smaller than the earlier ones
MAX_PERIM_VERTICES = 1500
CORRIDOR_MAX_M = 1000.0                  # detached new areas closer than this are joined by a cone (after the first)
MODIS_SUPPORT_M = 1500.0                 # MODIS footprints define burned area only near VIIRS/Landsat detections

# --- snapshots, activity, arrival ----------------------------------------------------------------------------------
PASS_GAP_MS = 30 * 60_000
PASS_MAX_SPAN_MS = 75 * 60_000
GROWTH_END_FRAC = 0.97
PERIM_TRUST_MS = 24 * HOUR_MS
ACTIVITY_BIN_MS = 10 * 60_000
ACTIVITY_BLEND = 0.6                     # weight of the GOES FRP curve vs linear time inside an interval
FILL_SPEED_RANGE = (20.0, 800.0)         # m/h
FILL_SPEED_DEFAULT = 150.0
LATE_GROUP_MS = 24 * HOUR_MS             # historical: overpasses later than growth end + this are mop-up, not growth
SMOOTH_ARRIVAL_M = 150.0                 # bilateral smoothing of the arrival field: spatial sigma ...
SMOOTH_TAU_H = 2.0                       # ... and time-similarity scale
MEDIAN_M = 200.0                         # masked median of the arrival field (speckle removal), window radius
MAX_RAISE_H = 12.0                       # sink filling may delay an island's burning by at most this much
MIN_DETACHED_M2 = 10 * 10_000.0          # new detached areas smaller than 10 ha are not growth of that snapshot
PERIM_SNAPSHOT_SMOOTH_M = 180.0          # perimeter masks used as snapshots are smoothed (WFIGS polygons are angular)

# --- ignition ------------------------------------------------------------------------------------------------------
IGN_MAX_OFFSET_M = 3000.0
GOES_IGN_RADIUS_M = 5000.0
GOES_PERSIST_N = 3
GOES_PERSIST_MS = HOUR_MS
GOES_LAG_MS = 10 * 60_000
POLAR_IGN_RADIUS_M = 3000.0
POLAR_LAG_MS = 30 * 60_000

# --- time range, series, events -----------------------------------------------------------------------------------
END_PAD_MS = 24 * HOUR_MS
CONTAIN_EXTEND_MS = 72 * HOUR_MS
ROS_MAX_CH_H = 300.0                     # ~6 km/h: clamp of the P90 front speed (outliers at compressed intervals)
ROS_MIN_PIXELS = 8                       # fewer pixels burning in an hour: ROS 0 (too noisy)
MAX_EVENTS = 11                          # + peak_wind from the pipeline = at most 12
RAPID_MIN_AC_H = 250.0
RAPID_MEDIAN_FACTOR = 3.0
RAPID_SEP_MS = 12 * HOUR_MS
RAPID_MAX = 3
SPOT_MIN_GAP_M = 750.0
SPOT_MAX = 3
RIDGE_TPI_RADIUS_M = 500.0
RIDGE_TPI_MIN_M = 40.0
RIDGE_MIN_LEN_M = 1000.0
RIDGE_SIDE_M = 400.0
RIDGE_MIN_DROP_M = 20.0
RIDGE_MAX_CROSS_H = 12.0
RIDGE_MAX = 2
SHIFT_WINDOW_H = 6
SHIFT_MIN_DEG = 75.0
SHIFT_MIN_COHERENCE = 0.5
SHIFT_MAX_GAP_H = 18

# --- outputs --------------------------------------------------------------------------------------------------------
GOES_THIN_MS = 10 * 60_000
GOES_THIN_CELL_M = 2000.0
WARNING_PREFIX = "Observations: "
SOURCE_PREFIXES = ("NASA FIRMS", "NIFC WFIGS", "NASA CMR")
SATELLITE_NAMES = {"N": "Suomi NPP", "N20": "NOAA-20", "N21": "NOAA-21", "Terra": "Terra", "Aqua": "Aqua",
                   "G16": "GOES-16", "G17": "GOES-17", "G18": "GOES-18", "G19": "GOES-19", "L8": "Landsat 8", "L9": "Landsat 9"}
EVENT_PRIORITY = ("ignition", "containment", "rapid_growth", "spot_fire", "ridge_crossing", "wind_shift", "perimeter_update")


# ==================================================================================================================
# Small helpers
# ==================================================================================================================
def la_time(ms: int | float) -> str:
    """``"Jan 07, 18:18 PST"`` (America/Los_Angeles)."""
    return datetime.fromtimestamp(int(ms) / 1000.0, tz=LA).strftime("%b %d, %H:%M %Z")


def cardinal(deg: float) -> str:
    """16-point compass name of a bearing in degrees (clockwise from north)."""
    names = ("N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW")
    return names[int(((float(deg) % 360.0) + 11.25) // 22.5) % 16]


def bearing(dx: float, dz: float) -> float:
    """Bearing (degrees clockwise from north) of a local displacement (x east, z south)."""
    return float(np.degrees(np.arctan2(dx, -dz)) % 360.0)


def to_hours(t_ms: Any, origin_ms: int) -> Any:
    """Hours since ``origin_ms`` (float64, vectorised)."""
    return (np.asarray(t_ms, dtype=np.float64) - float(origin_ms)) / HOUR_MS


def disk(radius_px: float) -> np.ndarray:
    """Boolean disk structuring element of the given radius (pixels, >= 1)."""
    r = max(1, int(round(radius_px)))
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    return (xx * xx + yy * yy) <= r * r + 0.25


def cell_acres(res_m: float) -> float:
    return res_m * res_m / config.ACRE_M2


def burned(arr: np.ndarray) -> np.ndarray:
    """Pixels with an arrival time (not NEVER)."""
    return np.asarray(arr) < NEVER * 0.5


# ==================================================================================================================
# Detections: preparation, static sources, clustering, GOES assignment
# ==================================================================================================================
def prepare_detections(df: pd.DataFrame | None, grid: Grid, *, quality: bool = True) -> pd.DataFrame:
    """Detections inside the AOI square, sorted by time, with local ``x``/``z`` (m), full footprint half sizes
    ``hx``/``hz`` (m; along scan ~ east-west, along track ~ north-south) and ``footprint_m`` (nominal pixel size for
    detections.json). Applies the SPEC 8.3 confidence filter (``firms.quality_mask``) unless ``quality=False``."""
    from ..sources import firms

    cols = ("x", "z", "hx", "hz", "footprint_m")
    if df is None or len(df) == 0:
        out = firms.empty_frame()
        for c in cols:
            out[c] = pd.Series(dtype="float64")
        return out
    df = df.reset_index(drop=True)
    if quality:
        df = df[firms.quality_mask(df).to_numpy(dtype=bool)].reset_index(drop=True)
    x, z = grid.lonlat_to_local(df["lon"].to_numpy(dtype=np.float64), df["lat"].to_numpy(dtype=np.float64))
    x, z = np.atleast_1d(x), np.atleast_1d(z)
    inside = np.atleast_1d(np.asarray(grid.contains_local(x, z), dtype=bool))
    df = df[inside].reset_index(drop=True)
    x, z = x[inside], z[inside]
    inst = df["instrument"].astype(str).to_numpy()
    nominal = np.array([NOMINAL_PIXEL_KM.get(i, 0.375) for i in inst], dtype=np.float64)
    scan = df["scan"].to_numpy(dtype=np.float64)
    track = df["track"].to_numpy(dtype=np.float64)
    scan = np.where(np.isfinite(scan) & (scan > 0) & (scan < 20), scan, nominal)
    track = np.where(np.isfinite(track) & (track > 0) & (track < 20), track, nominal)
    fixed = (inst == "GOES") | (inst == "LANDSAT")
    scan = np.where(fixed, nominal, scan)
    track = np.where(fixed, nominal, track)
    df = df.assign(x=x, z=z, hx=500.0 * scan, hz=500.0 * track, footprint_m=np.round(1000.0 * np.sqrt(scan * track), 1))
    return df.sort_values("t_ms", kind="stable").reset_index(drop=True)


def static_sites(pre: pd.DataFrame | None, ign_xz: tuple[float, float]) -> np.ndarray:
    """Local x/z (N, 2) of static hot spots seen BEFORE the fire: pre-fire detections whose 500 m neighbourhood was hot
    on >= 2 UTC days, or that FIRMS tags as static land sources (type 2). Points within 2 km of the ignition point
    are ignored (they may be an early start of this very fire)."""
    from scipy.spatial import cKDTree

    if pre is None or len(pre) == 0:
        return np.zeros((0, 2))
    sel = pre[pre["instrument"].isin(SPATIAL_INSTRUMENTS)]
    if not len(sel):
        return np.zeros((0, 2))
    xy = sel[["x", "z"]].to_numpy(dtype=np.float64)
    far = np.hypot(xy[:, 0] - ign_xz[0], xy[:, 1] - ign_xz[1]) > STATIC_IGNITION_GUARD_M
    xy = xy[far]
    if not len(xy):
        return np.zeros((0, 2))
    days = (sel["t_ms"].to_numpy(dtype=np.int64)[far] // DAY_MS)
    typ = sel["type"].to_numpy(dtype=np.int64)[far]
    tree = cKDTree(xy)
    nb = tree.query_ball_point(xy, STATIC_SITE_RADIUS_M)
    keep = np.array([typ[i] == 2 or len({int(days[j]) for j in n}) >= STATIC_MIN_DAYS for i, n in enumerate(nb)], dtype=bool)
    return xy[keep]


@dataclass
class FireSelection:
    """This fire's detections: ``spatial`` (VIIRS/MODIS/Landsat) and ``goes``, plus what was dropped."""

    spatial: pd.DataFrame
    goes: pd.DataFrame
    others: pd.DataFrame                 # spatial detections of other fires in the AOI
    n_static: int = 0
    n_goes_dropped: int = 0


def _points_in(geom: BaseGeometry | None, x: np.ndarray, z: np.ndarray) -> np.ndarray:
    if geom is None or geom.is_empty or len(x) == 0:
        return np.zeros(len(x), dtype=bool)
    return np.asarray(shapely.contains_xy(geom, x, z), dtype=bool)


def select_fire_detections(det: pd.DataFrame, ign_xz: tuple[float, float], started_ms: int,
                           perimeter_local: BaseGeometry | None = None, static_xy: np.ndarray | None = None) -> FireSelection:
    """Keep the detections of THIS fire (SPEC 8.3 step 1).

    * Spatial detections within 600 m of a static site are dropped, except inside the perimeter (+300 m).
    * Seeds: spatial detections within 3 km of the ignition point during its first 2 days, plus detections inside
      the perimeter (+375 m). The fallback seed is the detection nearest the point within 10 km during the first
      3 days.
    * Clustering: space-time connected components (1.5 km, 2 days; ``catalog.cluster_detections``) that contain
      a seed.
    * GOES: kept within 4 km of this fire's detections, perimeter or ignition point, unless another cluster's
      detection is closer within 12 h."""
    from scipy.spatial import cKDTree

    from ..catalog import cluster_detections

    is_sp = det["instrument"].isin(SPATIAL_INSTRUMENTS).to_numpy()
    spatial = det[is_sp].reset_index(drop=True)
    goes = det[det["instrument"].to_numpy() == "GOES"].reset_index(drop=True)
    sx = spatial["x"].to_numpy(dtype=np.float64)
    sz = spatial["z"].to_numpy(dtype=np.float64)
    st = spatial["t_ms"].to_numpy(dtype=np.int64)
    n = len(spatial)
    protect = _points_in(perimeter_local.buffer(PERIM_NEAR_M) if perimeter_local is not None else None, sx, sz)
    static = np.zeros(n, dtype=bool)
    if static_xy is not None and len(static_xy) and n:
        d, _ = cKDTree(np.asarray(static_xy, dtype=np.float64)).query(np.c_[sx, sz])
        static = (d <= STATIC_REMOVE_RADIUS_M) & ~protect
    keep = ~static
    dist_ign = np.hypot(sx - ign_xz[0], sz - ign_xz[1])
    seeds = (dist_ign <= SEED_RADIUS_M) & (st <= started_ms + SEED_WINDOW_MS) & keep
    if perimeter_local is not None:
        seeds |= _points_in(perimeter_local.buffer(PERIM_SEED_BUFFER_M), sx, sz) & keep
    if not seeds.any():
        cand = np.where(keep & (dist_ign <= SEED_FALLBACK_M) & (st <= started_ms + SEED_FALLBACK_MS))[0]
        if len(cand):
            seeds[cand[np.argmin(dist_ign[cand])]] = True
    member = np.zeros(n, dtype=bool)
    if seeds.any():
        idx = np.where(keep)[0]
        m = cluster_detections(sx[idx], sz[idx], st[idx], seeds[idx], eps_m=CLUSTER_EPS_M, eps_ms=CLUSTER_EPS_MS)
        member[idx[m]] = True
    fire_sp = spatial[member].reset_index(drop=True)
    others = spatial[keep & ~member].reset_index(drop=True)

    # GOES: near this fire and not nearer to another fire's detections at about the same time
    anchors = [np.c_[fire_sp["x"].to_numpy(), fire_sp["z"].to_numpy()], np.array([[ign_xz[0], ign_xz[1]]])]
    if perimeter_local is not None and not perimeter_local.is_empty:
        bnd = perimeter_local.boundary
        pts = shapely.line_interpolate_point(bnd, np.linspace(0.0, 1.0, 400), normalized=True) if bnd.length > 0 else []
        if len(pts):
            anchors.append(shapely.get_coordinates(pts))
    anchors_xy = np.vstack([a for a in anchors if len(a)])
    g_keep = np.zeros(len(goes), dtype=bool)
    if len(goes):
        gxy = np.c_[goes["x"].to_numpy(), goes["z"].to_numpy()]
        d_fire, _ = cKDTree(anchors_xy).query(gxy)
        g_keep = d_fire <= GOES_MAX_DIST_M
        if len(others) and g_keep.any():
            rx = np.c_[others["x"].to_numpy(), others["z"].to_numpy()]
            rt = others["t_ms"].to_numpy(dtype=np.int64)
            gt = goes["t_ms"].to_numpy(dtype=np.int64)
            rtree = cKDTree(rx)
            for i in np.where(g_keep)[0]:
                near = rtree.query_ball_point(gxy[i], max(d_fire[i] - 1.0, 0.0))
                if near and np.any(np.abs(rt[near] - gt[i]) <= GOES_RIVAL_WINDOW_MS):
                    g_keep[i] = False
    return FireSelection(spatial=fire_sp, goes=goes[g_keep].reset_index(drop=True), others=others,
                         n_static=int(static.sum()), n_goes_dropped=int((~g_keep).sum()))


def thin_goes(goes: pd.DataFrame) -> pd.DataFrame:
    """At most one GOES detection per 10 min per ~2 km cell, keeping the one with the highest FRP (SPEC 5)."""
    if goes is None or len(goes) == 0:
        return goes
    g = goes.assign(
        _bin=goes["t_ms"].to_numpy(dtype=np.int64) // GOES_THIN_MS,
        _cx=np.floor(goes["x"].to_numpy() / GOES_THIN_CELL_M).astype(np.int64),
        _cz=np.floor(goes["z"].to_numpy() / GOES_THIN_CELL_M).astype(np.int64),
        _f=goes["frp"].fillna(-1.0).to_numpy(),
    )
    g = g.sort_values(["_bin", "_cx", "_cz", "_f"], ascending=[True, True, True, False], kind="stable")
    g = g.drop_duplicates(subset=["_bin", "_cx", "_cz"], keep="first")
    return g.drop(columns=["_bin", "_cx", "_cz", "_f"]).sort_values("t_ms", kind="stable").reset_index(drop=True)


def pass_groups(t_ms: np.ndarray) -> list[np.ndarray]:
    """Index arrays of overpass groups in time-sorted ``t_ms``: detections chained by gaps <= 30 min, a group
    spanning at most 75 min (the three VIIRS satellites pass within ~50 min of each other)."""
    t = np.asarray(t_ms, dtype=np.int64)
    out: list[np.ndarray] = []
    start = 0
    for i in range(1, len(t) + 1):
        if i == len(t) or t[i] - t[i - 1] > PASS_GAP_MS or t[i] - t[start] > PASS_MAX_SPAN_MS:
            out.append(np.arange(start, i))
            start = i
    return out


# ==================================================================================================================
# Rasters: footprints, perimeters, mask cleaning
# ==================================================================================================================
def footprint_mask(x: np.ndarray, z: np.ndarray, hx: np.ndarray, hz: np.ndarray, grid: Grid) -> np.ndarray:
    """Union of axis-aligned rectangles ``[x-hx, x+hx] x [z-hz, z+hz]`` (local m) on ``grid``: pixels whose centre
    lies inside; a rectangle smaller than a pixel marks the pixel that contains its centre."""
    H, W = grid.height, grid.width
    x = np.atleast_1d(np.asarray(x, dtype=np.float64))
    if x.size == 0:
        return np.zeros((H, W), dtype=bool)
    z = np.atleast_1d(np.asarray(z, dtype=np.float64))
    hx = np.broadcast_to(np.asarray(hx, dtype=np.float64), x.shape)
    hz = np.broadcast_to(np.asarray(hz, dtype=np.float64), x.shape)
    h, res = grid.extent_m / 2.0, grid.res_m
    c0 = np.ceil((x - hx + h) / res - 0.5)
    c1 = np.floor((x + hx + h) / res - 0.5)
    r0 = np.ceil((z - hz + h) / res - 0.5)
    r1 = np.floor((z + hz + h) / res - 0.5)
    cin, rin = np.floor((x + h) / res), np.floor((z + h) / res)
    small = c1 < c0
    c0[small], c1[small] = cin[small], cin[small]
    small = r1 < r0
    r0[small], r1[small] = rin[small], rin[small]
    ok = (c1 >= 0) & (c0 <= W - 1) & (r1 >= 0) & (r0 <= H - 1)
    if not ok.any():
        return np.zeros((H, W), dtype=bool)
    c0 = np.clip(c0[ok], 0, W - 1).astype(np.int64)
    c1 = np.clip(c1[ok], 0, W - 1).astype(np.int64)
    r0 = np.clip(r0[ok], 0, H - 1).astype(np.int64)
    r1 = np.clip(r1[ok], 0, H - 1).astype(np.int64)
    diff = np.zeros((H + 1, W + 1), dtype=np.int32)
    np.add.at(diff, (r0, c0), 1)
    np.add.at(diff, (r0, c1 + 1), -1)
    np.add.at(diff, (r1 + 1, c0), -1)
    np.add.at(diff, (r1 + 1, c1 + 1), 1)
    return diff.cumsum(axis=0).cumsum(axis=1)[:H, :W] > 0


def fill_small_holes(mask: np.ndarray, max_px: float) -> np.ndarray:
    """Fill holes (background components not touching the border) of at most ``max_px`` pixels."""
    m = np.asarray(mask, dtype=bool)
    lab, n = ndimage.label(~m)
    if n == 0:
        return m.copy()
    sizes = np.bincount(lab.ravel())
    small = sizes <= max_px
    small[0] = False
    border = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    small[border] = False
    return m | small[lab]


def clean_mask(mask: np.ndarray, res_m: float, close_m: float, hole_m2: float = HOLE_MAX_M2, smooth_m: float = SMOOTH_M) -> np.ndarray:
    """Morphological closing (gaps between neighbouring footprints), small-hole filling and Gaussian smoothing of a
    footprint union, so fronts are smooth and speckle-free. Monotone: a subset never cleans to more."""
    m = np.asarray(mask, dtype=bool)
    if not m.any():
        return m.copy()
    r = close_m / res_m
    if r >= 0.75:
        k = max(1, int(round(r)))
        p = np.pad(m, k + 1)
        p = ndimage.binary_closing(p, structure=disk(k))
        m = p[k + 1:-(k + 1), k + 1:-(k + 1)]
    if hole_m2 > 0:
        m = fill_small_holes(m, hole_m2 / (res_m * res_m))
    s = smooth_m / res_m
    if s >= 0.5:
        m = ndimage.gaussian_filter(m.astype(np.float32), s, mode="constant") >= 0.5
    return m


def close_radius_m(res_m: float = 0.0) -> float:
    """Closing radius for the eroded footprint union: bridges small gaps where neighbouring pixel footprints do not
    quite touch (scan/track geometry), at least 1.5 px."""
    return max(80.0, 1.5 * res_m)


def shrink_factors(instrument: np.ndarray, viirs_shrink: float = SHRINK["VIIRS"]) -> np.ndarray:
    """Per-detection fraction of the pixel side kept for the spatial mask (MODIS scales with the VIIRS value)."""
    k = viirs_shrink / SHRINK["VIIRS"]
    inst = np.asarray(instrument).astype(str)
    return np.where(inst == "VIIRS", viirs_shrink,
                    np.where(inst == "MODIS", min(1.0, SHRINK["MODIS"] * k), SHRINK["LANDSAT"])).astype(np.float64)


class FootprintUnion:
    """Accumulates detection footprints and yields "the union shrunk by 1/3" (SPEC 8.3): the union of full pixel
    footprints with its boundary eroded by ``(1 - shrink) x half-size`` of the footprints there. Unlike shrinking each
    footprint, neighbouring pixels stay joined (no gaps to close) and the area grows monotonically with ``shrink``.
    An isolated footprint ends up exactly ``shrink`` x its size; MODIS uses its own (stronger) shrink."""

    def __init__(self, grid: Grid, viirs_shrink: float = SHRINK["VIIRS"]):
        self.grid = grid
        self.viirs_shrink = viirs_shrink
        self.union = np.zeros(grid.shape, dtype=bool)
        self.erode = np.full(grid.shape, np.inf, dtype=np.float32)    # erosion distance (m), min over footprints

    def add(self, d: pd.DataFrame) -> "FootprintUnion":
        if d is None or len(d) == 0:
            return self
        g = self.grid
        inst = d["instrument"].to_numpy()
        landsat = inst == "LANDSAT"
        hx = np.where(landsat, np.maximum(d["hx"].to_numpy(), 0.5 * g.res_m), d["hx"].to_numpy())
        hz = np.where(landsat, np.maximum(d["hz"].to_numpy(), 0.5 * g.res_m), d["hz"].to_numpy())
        x, z = d["x"].to_numpy(), d["z"].to_numpy()
        self.union |= footprint_mask(x, z, hx, hz, g)
        e = (1.0 - shrink_factors(inst, self.viirs_shrink)) * np.minimum(hx, hz)
        h, res, H, W = g.extent_m / 2.0, g.res_m, g.height, g.width
        c0 = np.clip(np.floor((x - hx + h) / res), 0, W - 1).astype(int)
        c1 = np.clip(np.floor((x + hx + h) / res), 0, W - 1).astype(int)
        r0 = np.clip(np.floor((z - hz + h) / res), 0, H - 1).astype(int)
        r1 = np.clip(np.floor((z + hz + h) / res), 0, H - 1).astype(int)
        for i in np.argsort(-e):                   # smallest erosion painted last
            sub = self.erode[r0[i]:r1[i] + 1, c0[i]:c1[i] + 1]
            np.minimum(sub, e[i], out=sub)
        return self

    def raw(self) -> np.ndarray:
        """The eroded union (before cleaning)."""
        if not self.union.any():
            return self.union.copy()
        dist = ndimage.distance_transform_edt(np.pad(self.union, 1))[1:-1, 1:-1] * self.grid.res_m
        return self.union & (dist > np.where(np.isfinite(self.erode), self.erode, 0.0))

    def mask(self) -> np.ndarray:
        """The eroded union, closed (small misalignment gaps), hole-filled and smoothed."""
        return clean_mask(self.raw(), self.grid.res_m, close_radius_m(self.grid.res_m))


def detection_mask(spatial: pd.DataFrame, grid: Grid, viirs_shrink: float = SHRINK["VIIRS"]) -> np.ndarray:
    """Cleaned, eroded union of footprints: the detection-only burned area."""
    return FootprintUnion(grid, viirs_shrink).add(spatial).mask()


def local_geometry(geom: BaseGeometry, grid: Grid) -> BaseGeometry | None:
    """lon/lat geometry -> local x/z, valid, clipped to the AOI square (None if empty)."""
    if geom is None or geom.is_empty:
        return None

    def fn(xy: np.ndarray) -> np.ndarray:
        x, z = grid.lonlat_to_local(xy[:, 0], xy[:, 1])
        return np.column_stack([np.atleast_1d(x), np.atleast_1d(z)])

    g = shapely.transform(geom, fn)
    if not g.is_valid:
        g = shapely.make_valid(g)
    h = grid.extent_m / 2.0
    g = g.intersection(box(-h, -h, h, h))
    polys = [p for p in getattr(g, "geoms", [g]) if p.geom_type in ("Polygon", "MultiPolygon") and not p.is_empty]
    if not polys:
        return None
    g = shapely.union_all(polys)
    return None if g.is_empty or g.area <= 0 else g


def rasterize_local(geom: BaseGeometry | None, grid: Grid) -> np.ndarray:
    """Boolean mask of pixel centres inside a local x/z geometry."""
    from rasterio import features

    if geom is None or geom.is_empty:
        return np.zeros(grid.shape, dtype=bool)
    utm = shapely.transform(geom, lambda xy: np.column_stack([xy[:, 0] + grid.center_e, grid.center_n - xy[:, 1]]))
    out = features.rasterize([(utm, 1)], out_shape=grid.shape, transform=grid.transform, fill=0, dtype="uint8", all_touched=False)
    return out.astype(bool)


# ==================================================================================================================
# Perimeters
# ==================================================================================================================
@dataclass
class PerimeterStep:
    """One cumulative perimeter (local x/z geometry, clipped to the AOI)."""

    t_ms: int
    geom: BaseGeometry                 # cumulative union up to this perimeter
    acres: float                       # cumulative acres
    own_acres: float                   # this record's own acres
    source: str
    category: str
    t_field: str
    containment_ms: int | None
    trusted: bool = True               # its time is used as an arrival snapshot
    mask: np.ndarray | None = None     # rasterised cumulative geometry (fire grid)
    snap_mask: np.ndarray | None = None   # smoothed mask used as a snapshot (rounded corners)


def cumulative_perimeters(perims: Sequence[dict], grid: Grid) -> tuple[list[PerimeterStep], list[str]]:
    """Time-ordered cumulative perimeters (SPEC 8.3 step 2): each is the union with all earlier ones; a record more
    than 20 % smaller than the running union is dropped and flagged. Records at the same time are merged."""
    warnings: list[str] = []
    steps: list[PerimeterStep] = []
    cum: BaseGeometry | None = None
    for p in sorted(perims, key=lambda d: int(d["t_ms"])):
        g = local_geometry(p.get("geometry"), grid)
        if g is None:
            continue
        own = g.area / config.ACRE_M2
        prev = cum.area / config.ACRE_M2 if cum is not None else 0.0
        if cum is not None and own < PERIM_SHRINK_FRAC * prev:
            warnings.append(f"WFIGS perimeter of {ms_to_iso(int(p['t_ms']))[:16]}Z ({own:,.0f} ac) is more than 20% smaller "
                            f"than the earlier perimeters ({prev:,.0f} ac): skipped")
            continue
        cum = g if cum is None else shapely.union(cum, g)
        if not cum.is_valid:
            cum = shapely.make_valid(cum)
        step = PerimeterStep(
            t_ms=int(p["t_ms"]), geom=cum, acres=cum.area / config.ACRE_M2, own_acres=own,
            source=str(p.get("source") or "NIFC WFIGS"), category=str(p.get("category") or ""),
            t_field=str(p.get("t_field") or ""), containment_ms=p.get("containment_ms"))
        if steps and steps[-1].t_ms == step.t_ms:
            steps[-1] = step
        else:
            steps.append(step)
    return steps, warnings


def simplify_rings(geom: BaseGeometry, res_m: float, max_vertices: int = MAX_PERIM_VERTICES) -> list[list[list[float]]]:
    """Rings (exteriors and holes) of a local geometry as ``[[x, z], ...]`` lists (closed, 0.1 m), simplified until the
    total vertex count is <= ``max_vertices``; slivers under ~2 pixels are dropped."""
    min_area = 2.0 * res_m * res_m
    polys = [p for p in getattr(geom, "geoms", [geom]) if p.geom_type == "Polygon" and p.area >= min_area]
    if not polys:
        return []
    g = shapely.MultiPolygon(polys) if len(polys) > 1 else polys[0]
    tol = 0.25 * res_m
    for _ in range(40):
        s = g.simplify(tol, preserve_topology=True)
        parts = [p for p in getattr(s, "geoms", [s]) if p.geom_type == "Polygon" and not p.is_empty]
        rings = []
        for p in parts:
            if p.area < min_area:
                continue
            rings.append(np.asarray(p.exterior.coords))
            rings += [np.asarray(r.coords) for r in p.interiors if shapely.Polygon(r).area >= min_area]
        if sum(len(r) for r in rings) <= max_vertices:
            return [[[round(float(a), 1), round(float(b), 1)] for a, b in r] for r in rings if len(r) >= 4]
        tol *= 1.4
    return []


# ==================================================================================================================
# Final burned mask F
# ==================================================================================================================
@dataclass
class FinalMask:
    mask: np.ndarray
    method: str                        # "perimeter" | "perimeter+detections" | "detections" | "none"
    viirs_shrink: float
    detection_acres: float
    perimeter_acres: float
    notes: list[str] = field(default_factory=list)


def supported_spatial(spatial: pd.DataFrame) -> pd.DataFrame:
    """Rows that may define the burned area without a perimeter: VIIRS and Landsat, plus MODIS only within 1.5 km of a
    VIIRS/Landsat detection (a 1-5 km MODIS pixel alone is too coarse). All rows when there is no VIIRS/Landsat."""
    if spatial is None or len(spatial) == 0:
        return spatial
    from scipy.spatial import cKDTree

    fine = spatial["instrument"].isin(("VIIRS", "LANDSAT")).to_numpy()
    if not fine.any():
        return spatial
    modis = ~fine
    keep = fine.copy()
    if modis.any():
        d, _ = cKDTree(spatial.loc[fine, ["x", "z"]].to_numpy()).query(spatial.loc[modis, ["x", "z"]].to_numpy())
        keep[np.where(modis)[0]] = d <= MODIS_SUPPORT_M
    return spatial[keep].reset_index(drop=True)


def calibrate_shrink(spatial: pd.DataFrame, grid: Grid, target_acres: float | None, allow_reduce: bool = True
                     ) -> tuple[float, np.ndarray, str | None]:
    """VIIRS shrink factor (and its detection mask) whose area is closest to ``target_acres`` when the default 2/3
    misses it by more than 20 % (search range 0.45-1.0). Small intense fires bloat more than any shrink removes:
    the mask is then also eroded (up to 400 m). ``allow_reduce=False`` (a CAL FIRE acreage older than the
    detections) only allows growing toward the target. Returns (shrink, mask, note or None)."""
    s0 = SHRINK["VIIRS"]
    m0 = detection_mask(spatial, grid, s0)
    if not target_acres or target_acres <= 0 or not m0.any():
        return s0, m0, None
    ca = cell_acres(grid.res_m)
    a0 = m0.sum() * ca
    if abs(a0 / target_acres - 1.0) <= CALIBRATE_TOL or (a0 > target_acres and not allow_reduce):
        return s0, m0, None
    lo, hi = SHRINK_RANGE
    best = (abs(a0 - target_acres), s0, m0)
    if a0 > target_acres:
        hi = s0
    else:
        lo = s0
    for _ in range(7):
        mid = 0.5 * (lo + hi)
        m = detection_mask(spatial, grid, mid)
        a = m.sum() * ca
        if abs(a - target_acres) < best[0]:
            best = (abs(a - target_acres), mid, m)
        if a > target_acres:
            hi = mid
        else:
            lo = mid
    _, s, m = best
    eroded_m = 0.0
    a = m.sum() * ca
    if a > (1.0 + 0.5 * CALIBRATE_TOL) * target_acres:
        s = SHRINK_RANGE[0]                          # the strongest shrink, then erosion
        m = detection_mask(spatial, grid, s)
        a = m.sum() * ca
        dist = ndimage.distance_transform_edt(np.pad(m, 1))[1:-1, 1:-1] * grid.res_m
        sig = SMOOTH_M / grid.res_m
        lo_r, hi_r = 0.0, CALIBRATE_MAX_ERODE_M
        best_e = (abs(a - target_acres), 0.0, m)
        for _ in range(10):
            r = 0.5 * (lo_r + hi_r)
            me = ndimage.gaussian_filter((dist > r).astype(np.float32), sig) >= 0.5 if sig >= 0.5 else dist > r
            ae = me.sum() * ca
            if me.any() and ae >= 0.3 * a and abs(ae - target_acres) < best_e[0]:
                best_e = (abs(ae - target_acres), r, me)
            if ae > target_acres:
                lo_r = r
            else:
                hi_r = r
        _, eroded_m, m = best_e
    if abs(s - s0) < 1e-6 and eroded_m == 0.0:
        return s0, m0, None
    how = f"VIIRS footprints scaled to {s:.2f} of the pixel (default {s0:.2f})"
    if eroded_m > 0:
        how += f" and eroded by {eroded_m:.0f} m"
    note = f"detection-only burned area {a0:,.0f} ac vs {target_acres:,.0f} ac reported by CAL FIRE: {how} -> {m.sum() * ca:,.0f} ac"
    return float(s), m, note


def final_mask(perim_last: np.ndarray | None, spatial: pd.DataFrame, grid: Grid, target_acres: float | None,
               after_ms: int | None = None, allow_reduce: bool = True) -> FinalMask:
    """Final burned mask F (SPEC 8.3 step 3).

    * No perimeter: the detection mask, its shrink calibrated to ``target_acres`` (CAL FIRE) when it misses by > 20 %.
    * A complete perimeter (>= 75 % of ``target_acres``; without acres: < 15 % of the detection area lies more than
      300 m outside it): the perimeter itself. VIIRS footprints reach up to a pixel beyond the true edge, so the 300 m
      rim of detections the SPEC suggests would inflate the area by ~20 % (Eaton). Only growth detected after
      ``after_ms`` (the latest perimeter, live fires) is added outside it.
    * An incomplete perimeter: perimeter ∪ detection mask, closed."""
    res = grid.res_m
    ca = cell_acres(res)
    has_p = perim_last is not None and bool(perim_last.any())
    spatial = supported_spatial(spatial)
    if not has_p:
        s, D, note = calibrate_shrink(spatial, grid, target_acres, allow_reduce)
        return FinalMask(D, "detections" if D.any() else "none", s, float(D.sum() * ca), 0.0, [note] if note else [])
    s = SHRINK["VIIRS"]
    D = detection_mask(spatial, grid, s)
    P = np.asarray(perim_last, dtype=bool)
    near = ndimage.binary_dilation(P, structure=disk(PERIM_NEAR_M / res)) if PERIM_NEAR_M / res >= 0.75 else P
    outside = D & ~near
    p_ac, d_ac = float(P.sum() * ca), float(D.sum() * ca)
    complete = (p_ac >= PERIM_COMPLETE_FRAC * target_acres) if target_acres else (outside.sum() <= OUTSIDE_FRAC_MAX * P.sum())
    notes: list[str] = []
    if complete:
        F = P.copy()
        method = "perimeter"
        if after_ms is not None:
            late = spatial[spatial["t_ms"].to_numpy() > after_ms]
            if len(late):
                grow = detection_mask(late, grid, s) & ~near
                if grow.any():
                    F = clean_mask(F | grow, res, close_radius_m(res), smooth_m=0.0) | P
                    method = "perimeter+detections"
                    notes.append(f"{(F & ~P).sum() * ca:,.0f} ac detected after the latest perimeter added to the burned area")
    else:
        F = clean_mask(P | D, res, close_radius_m(res)) | P
        method = "perimeter+detections"
        tgt = f" ({100.0 * p_ac / target_acres:.0f}% of the {target_acres:,.0f} ac reported by CAL FIRE)" if target_acres else ""
        notes.append(f"the WFIGS perimeter covers only {p_ac:,.0f} ac{tgt}; satellite detections fill the rest")
    return FinalMask(F, method, s, d_ac, p_ac, notes)


# ==================================================================================================================
# GOES activity (FRP) on a 10-minute grid
# ==================================================================================================================
class Activity:
    """Fire radiative power of this fire from GOES, per 10-min bin: total FRP of each scan, averaged over the scans of
    the bin, from the satellite with the most detections (another satellite fills bins it misses). Used to warp time
    inside snapshot intervals and for ``frp_mw_per_h``."""

    def __init__(self, goes: pd.DataFrame | None, t0_ms: int, t1_ms: int):
        self.t0 = int(t0_ms) // ACTIVITY_BIN_MS * ACTIVITY_BIN_MS
        nb = max(1, int(math.ceil((int(t1_ms) - self.t0) / ACTIVITY_BIN_MS)) + 1)
        self.a = np.zeros(nb, dtype=np.float64)
        self.satellite: str | None = None
        self.n = 0
        if goes is not None and len(goes):
            g = goes[(goes["t_ms"] >= self.t0) & (goes["t_ms"] < self.t0 + nb * ACTIVITY_BIN_MS)]
            g = g[np.isfinite(g["frp"].to_numpy(dtype=np.float64))]
            if len(g):
                self.n = len(g)
                counts = g["satellite"].value_counts()
                order = list(counts.index)
                self.satellite = str(order[0])
                per_scan = g.groupby(["satellite", "t_ms"])["frp"].sum().reset_index()
                filled = np.zeros(nb, dtype=bool)
                for sat in order:
                    ps = per_scan[per_scan["satellite"] == sat]
                    b = ((ps["t_ms"].to_numpy(dtype=np.int64) - self.t0) // ACTIVITY_BIN_MS).astype(np.int64)
                    tot = np.bincount(b, weights=ps["frp"].to_numpy(dtype=np.float64), minlength=nb)[:nb]
                    cnt = np.bincount(b, minlength=nb)[:nb]
                    val = np.where(cnt > 0, tot / np.maximum(cnt, 1), 0.0)
                    use = (cnt > 0) & ~filled
                    self.a[use] = val[use]
                    filled |= cnt > 0
        self.edges = self.t0 + np.arange(nb + 1, dtype=np.float64) * ACTIVITY_BIN_MS
        self.cum = np.concatenate([[0.0], np.cumsum(self.a)])

    @property
    def available(self) -> bool:
        return self.n > 0

    def cumulative(self, t_ms: Any) -> np.ndarray:
        """Cumulative activity (MW x bins) at ``t_ms`` (linear inside bins)."""
        return np.interp(np.asarray(t_ms, dtype=np.float64), self.edges, self.cum)

    def hourly_mean_mw(self, t_ms: np.ndarray) -> np.ndarray:
        """Mean total FRP (MW) over (t - 1 h, t] for each hourly ``t_ms``."""
        t = np.asarray(t_ms, dtype=np.float64)
        return (self.cumulative(t) - self.cumulative(t - HOUR_MS)) / (HOUR_MS / ACTIVITY_BIN_MS)

    def warp(self, ta_ms: float, tb_ms: float, ratio: np.ndarray) -> np.ndarray:
        """Map growth fractions (distance ratios, 0..1) to time fractions of [ta, tb]: growth follows the GOES
        activity (blended 60/40 with linear time; linear when GOES saw nothing in the interval)."""
        ratio = np.clip(np.asarray(ratio, dtype=np.float64), 0.0, 1.0)
        if tb_ms <= ta_ms or not self.available:
            return ratio
        n = int(min(2000, max(2, math.ceil((tb_ms - ta_ms) / ACTIVITY_BIN_MS) + 1)))
        ts = np.linspace(ta_ms, tb_ms, n)
        c = self.cumulative(ts)
        tot = c[-1] - c[0]
        lin = (ts - ta_ms) / (tb_ms - ta_ms)
        if not np.isfinite(tot) or tot <= 1e-9:
            return ratio
        w = ACTIVITY_BLEND * (c - c[0]) / tot + (1.0 - ACTIVITY_BLEND) * lin
        return np.interp(ratio, w, lin)


# ==================================================================================================================
# Snapshots and arrival interpolation
# ==================================================================================================================
@dataclass
class Snapshot:
    """A cumulative burned mask observed at ``t_ms``."""

    t_ms: int
    kind: str                          # "detections" | "perimeter"
    label: str                         # e.g. "VIIRS N20+N21", "WFIGS perimeter"
    mask: np.ndarray                   # cumulative, within F
    det_index: np.ndarray | None = None   # rows of FireSelection.spatial in this overpass group


def growth_end_ms(times: Sequence[int], masks: Sequence[np.ndarray]) -> int | None:
    """First snapshot time at which the detection-only burned area reached 97 % of its final value."""
    if not masks:
        return None
    final = masks[-1].sum()
    if final == 0:
        return None
    for t, m in zip(times, masks):
        if m.sum() >= GROWTH_END_FRAC * final:
            return int(t)
    return int(times[-1])


def _group_label(spatial: pd.DataFrame, idx: np.ndarray) -> str:
    d = spatial.iloc[idx]
    parts = []
    for inst in ("VIIRS", "MODIS", "LANDSAT"):
        sats = sorted(set(d.loc[d["instrument"] == inst, "satellite"].astype(str)))
        if sats:
            parts.append(f"{inst} {'+'.join(sats)}")
    return ", ".join(parts)


def build_snapshots(spatial: pd.DataFrame, groups: list[np.ndarray], det_masks: list[np.ndarray],
                    perim_steps: Sequence[PerimeterStep], F: np.ndarray, min_t_ms: int) -> list[Snapshot]:
    """Cumulative snapshots ``B_k = (D_k ∪ P_k) ∩ F ∪ B_{k-1}`` at overpass-group times (median detection time) and
    trusted perimeter times (SPEC 8.3 step 4). Times are clamped to >= ``min_t_ms``; equal times are merged."""
    items: list[tuple[int, int, int]] = []
    t_all = spatial["t_ms"].to_numpy(dtype=np.int64)
    for gi, g in enumerate(groups):
        items.append((max(int(np.median(t_all[g])), min_t_ms), 0, gi))
    for pi, p in enumerate(perim_steps):
        if p.trusted and (p.snap_mask is not None or p.mask is not None):
            items.append((max(int(p.t_ms), min_t_ms), 1, pi))
    items.sort()
    shape = F.shape
    D = np.zeros(shape, dtype=bool)
    P = np.zeros(shape, dtype=bool)
    B = np.zeros(shape, dtype=bool)
    out: list[Snapshot] = []
    for t, kind, i in items:
        if kind == 0:
            D = det_masks[i]
        else:
            pm = perim_steps[i].snap_mask if perim_steps[i].snap_mask is not None else perim_steps[i].mask
            P = P | pm
        Bk = ((D | P) & F) | B
        label = _group_label(spatial, groups[i]) if kind == 0 else "WFIGS perimeter"
        idx = groups[i] if kind == 0 else None
        if out and t - out[-1].t_ms < 60_000:
            prev = out[-1]
            prev.mask = Bk
            prev.label = f"{prev.label}; {label}" if label not in prev.label else prev.label
            if idx is not None:
                prev.det_index = idx if prev.det_index is None else np.concatenate([prev.det_index, idx])
            if kind == 1:
                prev.kind = "perimeter" if prev.kind == "perimeter" else prev.kind
        else:
            out.append(Snapshot(int(t), "detections" if kind == 0 else "perimeter", label, Bk, idx))
        B = Bk
    return out


def _crop_box(mask: np.ndarray, pad: int) -> tuple[slice, slice] | None:
    rows = np.flatnonzero(mask.any(axis=1))
    if rows.size == 0:
        return None
    cols = np.flatnonzero(mask.any(axis=0))
    r0, r1 = max(0, rows[0] - pad), min(mask.shape[0], rows[-1] + pad + 1)
    c0, c1 = max(0, cols[0] - pad), min(mask.shape[1], cols[-1] + pad + 1)
    return slice(r0, r1), slice(c0, c1)


def connect_detached(prev: np.ndarray, B: np.ndarray, F: np.ndarray, res_m: float, max_gap_m: float | None,
                     keep_detached: np.ndarray | None = None) -> np.ndarray:
    """Join each component of ``B \\ prev`` that does not touch ``prev`` to it with a cone (convex hull of the component
    and the nearest ``prev`` pixel) clipped to F, when the gap is <= ``max_gap_m`` (None: always) and the component has
    no pixel in ``keep_detached`` (probable spot fires stay detached). Returns the new B."""
    from skimage.morphology import convex_hull_image

    new = B & ~prev
    if not new.any() or not prev.any():
        return B
    lab, n = ndimage.label(new, structure=np.ones((3, 3)))
    if n == 0:
        return B
    skip = set(np.unique(lab[ndimage.binary_dilation(prev, structure=np.ones((3, 3))) & new]).tolist())
    if keep_detached is not None and keep_detached.any():
        skip |= set(np.unique(lab[keep_detached & new]).tolist())
    detached = [i for i in range(1, n + 1) if i not in skip]
    if not detached:
        return B
    dist, (ir, ic) = ndimage.distance_transform_edt(~prev, return_indices=True)
    out = B.copy()
    objs = ndimage.find_objects(lab)
    for i in detached:
        sl = objs[i - 1]
        comp = lab[sl] == i
        d_local = np.where(comp, dist[sl], np.inf)
        k = np.unravel_index(int(np.argmin(d_local)), d_local.shape)
        gap_m = float(d_local[k]) * res_m
        if max_gap_m is not None and gap_m > max_gap_m:
            continue
        pr, pc = sl[0].start + k[0], sl[1].start + k[1]
        qr, qc = int(ir[pr, pc]), int(ic[pr, pc])
        r0, r1 = min(sl[0].start, qr), max(sl[0].stop, qr + 1)
        c0, c1 = min(sl[1].start, qc), max(sl[1].stop, qc + 1)
        sub = np.zeros((r1 - r0, c1 - c0), dtype=bool)
        sub[sl[0].start - r0:sl[0].stop - r0, sl[1].start - c0:sl[1].stop - c0] = comp
        sub[qr - r0, qc - c0] = True
        hull = convex_hull_image(sub) if sub.sum() >= 3 else sub
        out[r0:r1, c0:c1] |= hull & F[r0:r1, c0:c1]
    return out


def interpolate_arrival(masks: Sequence[np.ndarray], times_h: Sequence[float], ign_rc: tuple[int, int] | None,
                        t_ign_h: float, warp: Callable[[float, float, np.ndarray], np.ndarray] | None = None
                        ) -> tuple[np.ndarray, np.ndarray]:
    """Arrival time (hours) from cumulative snapshot masks ``B_k`` at increasing ``times_h`` (SPEC 8.3 step 5).

    A pixel first contained in ``B_k`` gets ``T = t_{k-1} + (t_k - t_{k-1}) * u``, ``u = warp(ratio)`` with
    ``ratio = d_prev / (d_prev + d_next)``: ``d_prev`` = distance to ``B_{k-1}`` (to the ignition pixel for k = 0),
    ``d_next`` = distance to the outside of ``B_k``. Components of a new area that do not touch ``B_{k-1}`` (spots)
    grow from their own deepest point during the second half of the interval. The ignition pixel gets ``t_ign``.
    Returns (float32 arrival with NEVER outside the snapshots, int16 index k* of the first snapshot, -1 never)."""
    if not masks:
        raise ValueError("no snapshots")
    shape = masks[0].shape
    T = np.full(shape, NEVER, dtype=np.float64)
    kstar = np.full(shape, -1, dtype=np.int16)
    prev = np.zeros(shape, dtype=bool)
    t_prev = float(t_ign_h)
    if ign_rc is not None:
        prev[ign_rc] = True
        T[ign_rc] = t_ign_h
        kstar[ign_rc] = 0
    st8 = np.ones((3, 3), dtype=bool)
    for k, (Bk, tk) in enumerate(zip(masks, times_h)):
        tk = float(tk)
        B = np.asarray(Bk, dtype=bool) | prev
        new = B & ~prev
        if new.any():
            box_ = _crop_box(B, 2)
            sl = box_ if box_ is not None else (slice(None), slice(None))
            Bc, Pc, Nc = B[sl], prev[sl], new[sl]
            d_next = ndimage.distance_transform_edt(np.pad(Bc, 1))[1:-1, 1:-1]
            if Pc.any():
                d_prev = ndimage.distance_transform_edt(~Pc)
            else:
                d_prev = np.zeros(Bc.shape, dtype=np.float64)
            lab, n = ndimage.label(Nc, structure=st8)
            u = np.zeros(Bc.shape, dtype=np.float64)
            touching: set[int] = set()
            if Pc.any() and n:
                touching = set(np.unique(lab[ndimage.binary_dilation(Pc, structure=st8) & Nc]).tolist())
            attached = np.isin(lab, sorted(touching)) & Nc if touching else np.zeros_like(Nc)
            if attached.any():
                r = d_prev[attached] / np.maximum(d_prev[attached] + d_next[attached], 1e-9)
                u[attached] = warp(t_prev, tk, r) if warp else r
            detached = Nc & ~attached
            if detached.any():
                objs = ndimage.find_objects(lab)
                for i in range(1, n + 1):
                    if i in touching or objs[i - 1] is None:
                        continue
                    osl = objs[i - 1]
                    comp = lab[osl] == i
                    dn = d_next[osl]
                    core = np.zeros(comp.shape, dtype=bool)
                    core[np.unravel_index(int(np.argmax(np.where(comp, dn, -1.0))), comp.shape)] = True
                    dc = ndimage.distance_transform_edt(~core)
                    r = dc[comp] / np.maximum(dc[comp] + dn[comp], 1e-9)
                    rr = warp(t_prev, tk, r) if warp else r
                    sub = u[osl]
                    sub[comp] = 0.5 + 0.5 * rr
                    u[osl] = sub
            Tc = T[sl]
            Tc[Nc] = t_prev + np.clip(u[Nc], 0.0, 1.0) * (tk - t_prev)
            T[sl] = Tc
            Kc = kstar[sl]
            Kc[Nc] = k
            kstar[sl] = Kc
        prev = B
        t_prev = tk
    return T.astype(np.float32), kstar


def typical_speed_m_h(T: np.ndarray, res_m: float) -> float:
    """Median front speed (m/h) of an arrival field, 1/|grad T| over burned pixels (clamped to 20-800 m/h)."""
    _, _, speed = arrival_gradient(T, res_m)
    v = speed[np.isfinite(speed)]
    if v.size < 20:
        return FILL_SPEED_DEFAULT
    return float(np.clip(np.median(v), *FILL_SPEED_RANGE))


def neighbour_arrival(T: np.ndarray, sources: np.ndarray, targets: np.ndarray, res_m: float, speed_m_h: float) -> np.ndarray:
    """For every pixel, min over ``sources`` s of (T(s) + path length / speed): a multi-source Dijkstra on the
    16-neighbour pixel graph (path lengths within ~2 % of Euclidean, so fronts stay round), restricted to the bounding
    box of sources and targets. +inf where unreachable."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import dijkstra

    out = np.full(T.shape, np.inf, dtype=np.float64)
    src_m = np.asarray(sources, dtype=bool)
    if not src_m.any() or not np.asarray(targets, dtype=bool).any():
        return out
    sl = _crop_box(src_m | targets, 2)
    Tk, Kk = np.asarray(T, dtype=np.float64)[sl], src_m[sl]
    H, W = Tk.shape
    n = H * W
    idx = np.arange(n, dtype=np.int64).reshape(H, W)
    step = res_m / max(speed_m_h, 1e-6)
    pairs = []
    for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1), (1, 2), (2, 1), (1, -2), (2, -1)):   # 16-neighbour metric
        c0, c1 = max(0, -dc), W - max(0, dc)
        if H - dr <= 0 or c1 <= c0:
            continue
        a = idx[0:H - dr, c0:c1]
        b = idx[dr:H, c0 + dc:c1 + dc]
        pairs.append((a, b, step * math.hypot(dr, dc)))
    t0 = float(Tk[Kk].min())
    src = idx[Kk]
    rows = np.concatenate([a.ravel() for a, _, _ in pairs] + [np.full(src.size, n, dtype=np.int64)])
    cols = np.concatenate([b.ravel() for _, b, _ in pairs] + [src])
    wts = np.concatenate([np.full(a.size, w) for a, _, w in pairs] + [Tk[Kk] - t0 + 1e-9])
    graph = coo_matrix((wts, (rows, cols)), shape=(n + 1, n + 1)).tocsr()
    out[sl] = dijkstra(graph, directed=False, indices=n)[:n].reshape(H, W) + t0
    return out


def fill_unreached(T: np.ndarray, F: np.ndarray, res_m: float, speed_m_h: float, cap_h: float | None = None) -> np.ndarray:
    """Pixels of F without an arrival get min over burned pixels s of (T(s) + path length / speed) (pixels outside F
    relay distance but keep NEVER). Optional upper cap."""
    T = np.asarray(T, dtype=np.float32).copy()
    known = burned(T)
    todo = np.asarray(F, dtype=bool) & ~known
    if not todo.any() or not known.any():
        return T
    vals = neighbour_arrival(T, known, todo, res_m, speed_m_h)[todo]
    if cap_h is not None:
        vals = np.minimum(vals, cap_h)
    T[todo] = np.where(np.isfinite(vals), vals, NEVER).astype(np.float32)
    return T


def relax_suspect(T: np.ndarray, suspect: np.ndarray, res_m: float, speed_m_h: float) -> np.ndarray:
    """Pixels whose snapshot time says little about when they burned (seen only in a perimeter, or late detections
    inside the area the fire had already surrounded) burn no later than their reliable neighbours plus the travel
    time at the fire's typical speed: ``T = min(T, min_s T(s) + d / v)`` over burned non-suspect pixels s."""
    T = np.asarray(T, dtype=np.float32).copy()
    sus = np.asarray(suspect, dtype=bool) & burned(T)
    src = burned(T) & ~sus
    if not sus.any() or not src.any():
        return T
    nb = neighbour_arrival(T, src, sus, res_m, speed_m_h)
    T[sus] = np.minimum(T[sus], nb[sus]).astype(np.float32)
    return T


def close_mask(mask: np.ndarray, res_m: float, radius_m: float) -> np.ndarray:
    """Morphological closing with a ``radius_m`` disk (padded, so the border does not erode)."""
    m = np.asarray(mask, dtype=bool)
    k = int(round(radius_m / res_m))
    if not m.any() or k < 1:
        return m.copy()
    sl = _crop_box(m, k + 2)
    sub = np.pad(m[sl], k + 1)
    sub = ndimage.binary_closing(sub, structure=disk(k))[k + 1:-(k + 1), k + 1:-(k + 1)]
    out = m.copy()
    out[sl] |= sub
    return out


def envelope(mask: np.ndarray, res_m: float, radius_m: float) -> np.ndarray:
    """The area a burned mask encloses: closing with a ``radius_m`` disk, then holes filled."""
    m = np.asarray(mask, dtype=bool)
    if not m.any():
        return m.copy()
    k = max(1, int(round(radius_m / res_m)))
    sl = _crop_box(m, k + 2)
    sub = np.pad(m[sl], k + 1)
    sub = ndimage.binary_fill_holes(ndimage.binary_closing(sub, structure=disk(k)))[k + 1:-(k + 1), k + 1:-(k + 1)]
    out = m.copy()
    out[sl] |= sub
    return out


def median_arrival(T: np.ndarray, res_m: float, radius_m: float = MEDIAN_M) -> np.ndarray:
    """Masked median filter of an arrival field (window ~2 x ``radius_m``, 1-3 px radius) over burned pixels only:
    removes salt-and-pepper patches of outlier times (scattered single-pass footprints) without moving the edge of the
    burned area. NEVER stays NEVER."""
    T = np.asarray(T, dtype=np.float32)
    b = burned(T)
    R = int(min(3, max(1, round(radius_m / res_m))))
    if not b.any():
        return T.copy()
    sl = _crop_box(b, R + 1)
    cur = np.where(b, T, np.nan).astype(np.float32)[sl]
    H, W = cur.shape
    pad = np.pad(cur, R, constant_values=np.nan)
    stack = np.stack([pad[R + dr:R + dr + H, R + dc:R + dc + W] for dr in range(-R, R + 1) for dc in range(-R, R + 1)
                      if dr * dr + dc * dc <= R * R + R], axis=0)
    with np.errstate(all="ignore"):
        import warnings as _w

        with _w.catch_warnings():
            _w.simplefilter("ignore", RuntimeWarning)
            med = np.nanmedian(stack, axis=0)
    valid = b[sl]
    out = T.copy()
    sub = out[sl]
    sub[valid] = np.where(np.isfinite(med[valid]), med[valid], sub[valid])
    out[sl] = sub
    return out


def fill_sinks(T: np.ndarray, seeds: np.ndarray, res_m: float, speed_m_h: float, max_raise_h: float = MAX_RAISE_H) -> tuple[np.ndarray, int]:
    """Make every burned pixel reachable from a seed (the ignition, probable spot fires, and the earliest pixel of each
    separate burned component) through pixels that burned no later: morphological reconstruction by erosion
    ("sink filling") of the arrival field. Islands that would burn more than ``max_raise_h`` later this way are real
    early burning and become seeds themselves. Raised pixels are re-timed from their unraised neighbours plus travel
    time (the front sweeps into them instead of a flat plateau). Returns (arrival, raised pixel count)."""
    from skimage.morphology import reconstruction

    T = np.asarray(T, dtype=np.float32)
    b = burned(T)
    if not b.any():
        return T.copy(), 0
    sl = _crop_box(b, 2)
    Tc = np.where(b, T, NEVER).astype(np.float64)[sl]
    bc = b[sl]
    sd = np.asarray(seeds, dtype=bool)[sl] & bc
    lab, n = ndimage.label(bc, structure=np.ones((3, 3)))
    has = np.zeros(n + 1, dtype=bool)
    has[np.unique(lab[sd])] = True
    for i in np.where(~has[1:])[0] + 1:
        pos = ndimage.minimum_position(Tc, lab, i)
        sd[pos] = True
    out = Tc
    for _ in range(6):
        out = reconstruction(np.where(sd, Tc, NEVER), Tc, method="erosion", footprint=np.ones((3, 3)))
        raised = bc & (out > Tc + 1e-4)
        if not raised.any():
            break
        rl, rn = ndimage.label(raised, structure=np.ones((3, 3)))
        big = np.asarray(ndimage.maximum(out - Tc, rl, index=np.arange(1, rn + 1))) > max_raise_h
        if not np.any(big):
            break
        sd |= np.isin(rl, np.where(big)[0] + 1)     # real early burning: keep it, then reconstruct again
    raised = bc & (out > Tc + 1e-4)
    res_T = np.where(bc, out, NEVER)
    if raised.any():
        nb = neighbour_arrival(res_T, bc & ~raised, raised, res_m, speed_m_h)
        res_T = np.where(raised & np.isfinite(nb), np.maximum(nb, out), res_T)
    full = np.asarray(T, dtype=np.float32).copy()
    sub = full[sl]
    sub[bc] = res_T[bc].astype(np.float32)
    full[sl] = sub
    return full, int(raised.sum())


def drop_small_detached(prev: np.ndarray, B: np.ndarray, res_m: float, min_m2: float, keep: np.ndarray | None = None) -> np.ndarray:
    """Remove from snapshot ``B`` the new components that do not touch ``prev`` and are smaller than ``min_m2`` (a
    single footprint ahead of the fire is noise for the replay; it is timed later from its neighbours), except
    components containing a ``keep`` pixel (probable spot fires)."""
    new = B & ~prev
    if not new.any() or not prev.any():
        return B
    lab, n = ndimage.label(new, structure=np.ones((3, 3)))
    if n == 0:
        return B
    sizes = np.bincount(lab.ravel(), minlength=n + 1)
    touching = np.zeros(n + 1, dtype=bool)
    touching[np.unique(lab[ndimage.binary_dilation(prev, structure=np.ones((3, 3))) & new])] = True
    if keep is not None and keep.any():
        touching[np.unique(lab[keep & new])] = True
    small = (sizes * res_m * res_m < min_m2) & ~touching
    small[0] = False
    return B & ~small[lab]


def smooth_arrival(T: np.ndarray, res_m: float, sigma_m: float = SMOOTH_ARRIVAL_M, tau_h: float = SMOOTH_TAU_H,
                   passes: int = 2) -> np.ndarray:
    """Edge-preserving (bilateral) smoothing of an arrival field over burned pixels: spatial Gaussian ``sigma_m`` times
    a time-similarity weight ``exp(-dT² / 2 tau²)``. Rounds the blocky / straight-edged fronts that snapshots, cones
    and the neighbour fill leave, without blurring real jumps (islands that burned days later). NEVER stays NEVER."""
    T = np.asarray(T, dtype=np.float32)
    b = burned(T)
    s = min(sigma_m / res_m, 3.0)                  # pixels; the artefacts it removes are pixel-scale anyway
    if not b.any() or s < 0.5:
        return T.copy()
    R = max(1, int(math.ceil(2.0 * s)))
    sl = _crop_box(b, R + 1)
    cur = np.where(b, T, np.nan).astype(np.float64)[sl]
    valid = b[sl]
    H, W = cur.shape
    for _ in range(passes):
        pad = np.pad(cur, R, constant_values=np.nan)
        num = np.zeros((H, W))
        den = np.zeros((H, W))
        for dr in range(-R, R + 1):
            for dc in range(-R, R + 1):
                ws = math.exp(-(dr * dr + dc * dc) / (2.0 * s * s))
                if ws < 0.01:
                    continue
                nb = pad[R + dr:R + dr + H, R + dc:R + dc + W]
                ok = np.isfinite(nb)
                w = np.where(ok, ws * np.exp(-np.square(np.where(ok, nb, 0.0) - np.nan_to_num(cur)) / (2.0 * tau_h * tau_h)), 0.0)
                num += w * np.where(ok, nb, 0.0)
                den += w
        cur = np.where(valid & (den > 0), num / np.where(den > 0, den, 1.0), np.nan)
    out = T.copy()
    sub = out[sl]
    sub[valid] = cur[valid].astype(np.float32)
    out[sl] = sub
    return out


def arrival_gradient(T: np.ndarray, res_m: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(dT/dx, dT/dz) in h/m and the front speed 1/|grad T| in m/h (NaN where undefined)."""
    a = np.where(burned(T), np.asarray(T, dtype=np.float64), np.nan)
    gz, gx = np.gradient(a, res_m)
    g = np.hypot(gx, gz)
    with np.errstate(divide="ignore", invalid="ignore"):
        speed = np.where(g > 1e-9, 1.0 / g, np.nan)
    return gx, gz, speed


# ==================================================================================================================
# Ignition
# ==================================================================================================================
def first_persistent_goes(goes: pd.DataFrame, ign_xz: tuple[float, float]) -> tuple[int | None, str | None]:
    """Time and satellite of the first GOES detection within 5 km of the point that is followed by >= 2 more within
    the next hour (a persistent detection, not a one-scan false alarm)."""
    if goes is None or len(goes) == 0:
        return None, None
    d = np.hypot(goes["x"].to_numpy() - ign_xz[0], goes["z"].to_numpy() - ign_xz[1])
    g = goes[d <= GOES_IGN_RADIUS_M]
    if not len(g):
        return None, None
    t = g["t_ms"].to_numpy(dtype=np.int64)
    order = np.argsort(t, kind="stable")
    t = t[order]
    sats = g["satellite"].astype(str).to_numpy()[order]
    hi = np.searchsorted(t, t + GOES_PERSIST_MS, side="right")
    lo = np.arange(len(t))
    ok = (hi - lo) >= GOES_PERSIST_N
    if not ok.any():
        return None, None
    i = int(np.argmax(ok))
    return int(t[i]), str(sats[i])


def ignition_time(started_ms: int, origin_ms: int, ign_xz: tuple[float, float], goes: pd.DataFrame,
                  spatial: pd.DataFrame, first_snapshot_ms: int | None) -> tuple[int, str, str, int | None, str | None]:
    """(t_ms, source text, confidence, first GOES ms, GOES satellite): the CAL FIRE start, moved earlier when the first
    persistent GOES detection near the point (minus 10 min) or the first polar-orbiter detection within 3 km (minus
    30 min) is earlier; never before ``origin_ms`` and always before the first snapshot. "observed" when a detection
    confirms the start within 2 h."""
    t_ign = int(started_ms)
    why = "CAL FIRE start"
    conf = "estimated"
    tg, sat = first_persistent_goes(goes, ign_xz)
    if tg is not None:
        if tg - GOES_LAG_MS < t_ign:
            t_ign = tg - GOES_LAG_MS
            why = f"10 min before the first persistent {SATELLITE_NAMES.get(sat, sat)} detection ({la_time(tg)})"
        if tg <= started_ms + 2 * HOUR_MS:
            conf = "observed"
    if spatial is not None and len(spatial):
        d = np.hypot(spatial["x"].to_numpy() - ign_xz[0], spatial["z"].to_numpy() - ign_xz[1])
        near = spatial[d <= POLAR_IGN_RADIUS_M]
        if len(near):
            first = near.iloc[int(np.argmin(near["t_ms"].to_numpy()))]
            tp = int(first["t_ms"])
            if tp - POLAR_LAG_MS < t_ign:
                t_ign = tp - POLAR_LAG_MS
                why = (f"30 min before the first {first['instrument']} detection near the point "
                       f"({SATELLITE_NAMES.get(str(first['satellite']), first['satellite'])}, {la_time(tp)})")
                conf = "observed"
    if first_snapshot_ms is not None and t_ign >= first_snapshot_ms:
        t_ign = int(first_snapshot_ms) - GOES_LAG_MS
        why = "just before the first satellite detection"
    if t_ign < origin_ms:
        t_ign = int(origin_ms)
        why += " (clamped to the timeline start)"
    return int(t_ign), why, conf, tg, sat


def place_ignition(grid: Grid, cal_xz: tuple[float, float], first_xz: np.ndarray | None, F: np.ndarray
                   ) -> tuple[float, float, tuple[int, int], str, list[str]]:
    """Ignition location (SPEC 8.3 step 6): the CAL FIRE point, or the centroid of the earliest detections when the point
    is > 3 km from all of them; then moved to the nearest pixel of F when outside it.
    Returns (x, z, (row, col), description of the source, warnings)."""
    notes: list[str] = []
    where = "CAL FIRE incident point"
    x, z = float(cal_xz[0]), float(cal_xz[1])
    if first_xz is not None and len(first_xz):
        d = np.hypot(first_xz[:, 0] - x, first_xz[:, 1] - z)
        if d.min() > IGN_MAX_OFFSET_M:
            x, z = float(first_xz[:, 0].mean()), float(first_xz[:, 1].mean())
            where = "centroid of the earliest FIRMS detections"
            notes.append(f"CAL FIRE point is {d.min() / 1000:.1f} km from the earliest detections: ignition at their centroid")
    h = grid.extent_m / 2.0
    x, z = float(np.clip(x, -h + 1e-3, h - 1e-3)), float(np.clip(z, -h + 1e-3, h - 1e-3))
    r, c = grid.local_to_rowcol(x, z)
    rc = (int(min(max(math.floor(r), 0), grid.height - 1)), int(min(max(math.floor(c), 0), grid.width - 1)))
    if F.any() and not F[rc]:
        _, (ir, ic) = ndimage.distance_transform_edt(~F, return_indices=True)
        nr, nc = int(ir[rc]), int(ic[rc])
        nx, nz = grid.pixel_center_local(nr, nc)
        moved = math.hypot(nx - x, nz - z)
        where += f" (moved {moved:,.0f} m into the burned area)"
        if moved > 2.0 * grid.res_m:
            notes.append(f"ignition moved {moved:,.0f} m into the observed burned area")
        x, z, rc = float(nx), float(nz), (nr, nc)
    return x, z, rc, where, notes


# ==================================================================================================================
# Time series, events, profile path
# ==================================================================================================================
def hourly_times(start_ms: int, now_ms_: int) -> np.ndarray:
    """Hourly t_ms from ``start_ms`` to floor_hour(now_ms) inclusive."""
    return np.arange(int(start_ms), floor_hour_ms(int(now_ms_)) + 1, HOUR_MS, dtype=np.int64)


def make_timeseries(T: np.ndarray, res_m: float, origin_ms: int, t_ms: np.ndarray, det_times: np.ndarray,
                    activity: Activity | None, polar: pd.DataFrame | None) -> dict:
    """timeseries.json (SPEC 8.3 step 7): area, growth, P90 front speed (ch/h), detections and mean FRP per hour."""
    hours = to_hours(t_ms, origin_ms)
    b = burned(T)
    ts_sorted = np.sort(T[b].astype(np.float64))
    ca = cell_acres(res_m)
    area = np.searchsorted(ts_sorted, hours, side="right") * ca
    growth = np.diff(area, prepend=0.0)
    _, _, speed = arrival_gradient(T, res_m)
    a = np.where(b, T, np.nan).astype(np.float64).ravel()
    sp = np.minimum(speed.ravel(), ROS_MAX_CH_H * config.CHAIN_M)
    order = np.argsort(np.nan_to_num(a, nan=np.inf), kind="stable")
    sa, ss = a[order], sp[order]
    lo = np.searchsorted(sa, hours - 1.0, side="right")
    hi = np.searchsorted(sa, hours, side="right")
    ros = np.zeros(len(hours))
    for i, (l, h) in enumerate(zip(lo, hi)):
        if h - l >= ROS_MIN_PIXELS:
            v = ss[l:h]
            v = v[np.isfinite(v)]
            if v.size >= ROS_MIN_PIXELS:
                ros[i] = float(np.percentile(v, 90)) / config.CHAIN_M
    dt = np.sort(np.asarray(det_times, dtype=np.int64))
    det_n = np.searchsorted(dt, t_ms, side="right") - np.searchsorted(dt, t_ms - HOUR_MS, side="right")
    out = {
        "step_h": 1,
        "t_ms": [int(v) for v in t_ms],
        "area_acres": [round(float(v), 2) for v in area],
        "growth_acres_per_h": [round(float(v), 2) for v in growth],
        "ros_ch_per_h": [round(float(v), 2) for v in ros],
        "detections_per_h": [int(v) for v in det_n],
    }
    frp = None
    if activity is not None and activity.available:
        frp = activity.hourly_mean_mw(t_ms)
    elif polar is not None and len(polar) and np.isfinite(polar["frp"].to_numpy(dtype=np.float64)).any():
        groups = pass_groups(polar["t_ms"].to_numpy(dtype=np.int64))
        pt = np.array([int(np.median(polar["t_ms"].to_numpy()[g])) for g in groups], dtype=np.float64)
        pf = np.array([float(np.nansum(polar["frp"].to_numpy(dtype=np.float64)[g])) for g in groups])
        frp = np.interp(t_ms.astype(np.float64), pt, pf, left=0.0, right=0.0)
        gap = np.diff(pt) > 12 * HOUR_MS
        for j in np.where(gap)[0]:
            frp[(t_ms > pt[j] + 6 * HOUR_MS) & (t_ms < pt[j + 1] - 6 * HOUR_MS)] = 0.0
    if frp is not None:
        out["frp_mw_per_h"] = [round(float(v), 2) for v in np.maximum(frp, 0.0)]
    return out


def _event(type_: str, t_ms: int, title: str, detail: str, confidence: str, source: str, xz: tuple[float, float] | None = None) -> dict:
    e: dict[str, Any] = {"type": type_, "t_ms": int(t_ms), "title": title, "detail": detail}
    if xz is not None:
        e["x"], e["z"] = round(float(xz[0]), 1), round(float(xz[1]), 1)
    e["confidence"] = confidence
    e["source"] = source
    return e


def rapid_growth_events(ts: dict, T: np.ndarray, grid: Grid, origin_ms: int, snap_times: Sequence[int]) -> list[dict]:
    """Hours with growth >= max(250 ac/h, 3 x the median positive growth), >= 12 h apart, at most 3."""
    growth = np.asarray(ts["growth_acres_per_h"], dtype=np.float64)
    t_arr = np.asarray(ts["t_ms"], dtype=np.int64)
    pos = growth[growth > 0]
    if not pos.size:
        return []
    thr = max(RAPID_MIN_AC_H, RAPID_MEDIAN_FACTOR * float(np.median(pos)))
    picked: list[int] = []
    for i in np.argsort(-growth, kind="stable"):
        if growth[i] < thr or len(picked) >= RAPID_MAX:
            break
        if all(abs(int(t_arr[i]) - int(t_arr[j])) >= RAPID_SEP_MS for j in picked):
            picked.append(int(i))
    X, Z = grid.cell_centers_local()
    snaps = np.asarray(sorted(snap_times), dtype=np.int64)
    out = []
    for i in picked:
        th = to_hours(t_arr[i], origin_ms)
        sel = (T > th - 1.0) & (T <= th) & burned(T)
        xz = (float(X[sel].mean()), float(Z[sel].mean())) if sel.any() else None
        t_mid = int(t_arr[i]) - HOUR_MS // 2
        k = np.searchsorted(snaps, t_mid)
        bracket = (snaps[k] - snaps[k - 1]) if 0 < k < len(snaps) else np.inf
        conf = "observed" if bracket <= 6 * HOUR_MS else "estimated"
        out.append(_event("rapid_growth", t_mid, "Rapid growth",
                          f"+{growth[i]:,.0f} ac/h; front ROS {ts['ros_ch_per_h'][i]:.0f} ch/h (P90)", conf,
                          "Observed arrival (FIRMS VIIRS/MODIS + WFIGS)", xz))
    return out


@dataclass
class SpotCandidate:
    k: int                             # snapshot index
    rc: tuple[int, int]
    gap_m: float
    t_ms: int
    x: float
    z: float
    what: str                          # e.g. "VIIRS NOAA-20"


def find_spots(snaps: Sequence[Snapshot], spatial: pd.DataFrame, grid: Grid, F: np.ndarray, t_ign_ms: int) -> list[SpotCandidate]:
    """VIIRS/Landsat detections (accurate, small pixels) whose shrunk footprint lies > 750 m outside the previous
    burned area, outside the area it encloses (closed by 1 km), and that stay disconnected from it in the new
    snapshot: probable spot fires (one per new component). Uses the snapshot masks before any cone connection."""
    out: list[SpotCandidate] = []
    res = grid.res_m
    st8 = np.ones((3, 3), dtype=bool)
    for k in range(1, len(snaps)):
        s = snaps[k]
        if s.det_index is None or s.t_ms < t_ign_ms + HOUR_MS:
            continue
        prev = snaps[k - 1].mask
        if not prev.any():
            continue
        d = spatial.iloc[s.det_index]
        d = d[d["instrument"].isin(("VIIRS", "LANDSAT")).to_numpy()]
        if not len(d):
            continue
        dist = ndimage.distance_transform_edt(~prev) * res
        r, c = grid.local_to_rowcol(d["x"].to_numpy(), d["z"].to_numpy())
        r = np.clip(np.floor(np.atleast_1d(r)).astype(int), 0, grid.height - 1)
        c = np.clip(np.floor(np.atleast_1d(c)).astype(int), 0, grid.width - 1)
        half = np.maximum(d["hx"].to_numpy(), d["hz"].to_numpy()) * shrink_factors(d["instrument"].to_numpy())
        gap = dist[r, c] - half
        sel = (gap > SPOT_MIN_GAP_M) & F[r, c] & s.mask[r, c]
        if not sel.any():
            continue
        sel &= ~envelope(prev, res, SPOT_ENVELOPE_M)[r, c]
        if not sel.any():
            continue
        lab, _ = ndimage.label(s.mask, structure=st8)
        main = set(np.unique(lab[prev]).tolist()) - {0}
        best: dict[int, int] = {}
        for j in np.where(sel)[0]:
            L = int(lab[r[j], c[j]])
            if L == 0 or L in main:
                continue
            if L not in best or gap[j] > gap[best[L]]:
                best[L] = int(j)
        for j in best.values():
            row = d.iloc[j]
            out.append(SpotCandidate(k, (int(r[j]), int(c[j])), float(gap[j]), int(s.t_ms), float(row["x"]), float(row["z"]),
                                     f"{row['instrument']} {SATELLITE_NAMES.get(str(row['satellite']), row['satellite'])}"))
    return out


def spot_fire_events(cands: Sequence[SpotCandidate]) -> list[dict]:
    """At most 3 spot-fire events, the largest gaps, at most one per overpass (>= 3 h apart)."""
    out = []
    picked: list[SpotCandidate] = []
    for c in sorted(cands, key=lambda c: -c.gap_m):
        if len(picked) >= SPOT_MAX:
            break
        if any(abs(c.t_ms - p.t_ms) < 3 * HOUR_MS for p in picked):
            continue
        picked.append(c)
    for c in picked:
        out.append(_event("spot_fire", c.t_ms, "Spot fire (prob.)",
                          f"New detection {c.gap_m / 1000:.1f} km beyond the mapped fire edge ({c.what}); likely spotting.",
                          "probable", f"FIRMS {c.what}", (c.x, c.z)))
    return out


def tpi(elev: np.ndarray, res_m: float, radius_m: float = RIDGE_TPI_RADIUS_M) -> np.ndarray:
    """Topographic position index: elevation minus the mean within ~``radius_m`` (square window)."""
    size = 2 * max(1, int(round(radius_m / res_m))) + 1
    return (elev - ndimage.uniform_filter(elev.astype(np.float64), size=size, mode="nearest")).astype(np.float32)


def ridge_crossing_events(T: np.ndarray, F: np.ndarray, elev: np.ndarray, grid: Grid, origin_ms: int) -> list[dict]:
    """Prominent ridges (TPI > +40 m at ~500 m, lines >= 1 km) that the front crossed: arrival on one flank (400 m
    across the ridge) < crest < other flank, within 12 h, flanks >= 20 m lower. At most 2, on different ridges."""
    from skimage.morphology import skeletonize

    res = grid.res_m
    e = np.asarray(elev, dtype=np.float64)
    t_ = tpi(e, res)
    ridge = t_ > RIDGE_TPI_MIN_M
    if not ridge.any():
        return []
    sk = skeletonize(ridge)
    lab, n = ndimage.label(sk, structure=np.ones((3, 3)))
    if n == 0:
        return []
    sizes = np.bincount(lab.ravel())
    long_ = sizes * res >= RIDGE_MIN_LEN_M
    long_[0] = False
    cand = long_[lab] & F & burned(T)
    if not cand.any():
        return []
    sm = ndimage.gaussian_filter(e, max(0.7, 150.0 / res))
    gz, gx = np.gradient(sm, res)
    gzz, gzx = np.gradient(gz, res)
    _, gxx = np.gradient(gx, res)
    rr, cc = np.nonzero(cand)
    a, b, c = gxx[rr, cc], gzx[rr, cc], gzz[rr, cc]
    lam = 0.5 * (a + c) - np.sqrt(0.25 * (a - c) ** 2 + b * b)
    vx, vz = b, lam - a
    norm = np.hypot(vx, vz)
    flat = norm < 1e-12
    vx = np.where(flat, 1.0, vx / np.where(flat, 1.0, norm))
    vz = np.where(flat, 0.0, vz / np.where(flat, 1.0, norm))
    dpx = RIDGE_SIDE_M / res
    H, W = T.shape

    def sample(arr, r, c):
        r = np.clip(np.round(r).astype(int), 0, H - 1)
        c = np.clip(np.round(c).astype(int), 0, W - 1)
        return arr[r, c], F[r, c]

    ta, fa = sample(T, rr + vz * dpx, cc + vx * dpx)
    tb, fb = sample(T, rr - vz * dpx, cc - vx * dpx)
    ea, _ = sample(e, rr + vz * dpx, cc + vx * dpx)
    eb, _ = sample(e, rr - vz * dpx, cc - vx * dpx)
    tp = T[rr, cc]
    ok = fa & fb & burned(ta) & burned(tb)
    lo, hi = np.minimum(ta, tb), np.maximum(ta, tb)
    ok &= (lo < tp - 0.05) & (tp + 0.05 < hi) & (hi - lo <= RIDGE_MAX_CROSS_H)
    ok &= (e[rr, cc] - ea >= RIDGE_MIN_DROP_M) & (e[rr, cc] - eb >= RIDGE_MIN_DROP_M)
    if not ok.any():
        return []
    idx = np.where(ok)[0]
    # per ridge line: the first crossing (earliest crest arrival); ridges ranked by their prominence (max TPI)
    first: dict[int, int] = {}
    prominence: dict[int, float] = {}
    for j in idx:
        L = int(lab[rr[j], cc[j]])
        prominence[L] = max(prominence.get(L, -1e9), float(t_[rr[j], cc[j]]))
        if L not in first or tp[j] < tp[first[L]]:
            first[L] = int(j)
    picks = [first[L] for L in sorted(first, key=lambda L: -prominence[L])]
    out: list[dict] = []
    chosen: list[tuple[float, float, float]] = []
    for j in picks:
        x, z = grid.pixel_center_local(int(rr[j]), int(cc[j]))
        th = float(tp[j])
        if any(math.hypot(x - cx, z - cz) < 3000.0 and abs(th - ct) < 6.0 for cx, cz, ct in chosen):
            continue
        chosen.append((x, z, th))
        sgn = 1.0 if ta[j] < tb[j] else -1.0       # travel from the earlier flank to the later one
        heading = bearing(-sgn * vx[j], -sgn * vz[j])
        t_ms = int(round(origin_ms + th * HOUR_MS))
        out.append(_event("ridge_crossing", t_ms, "Ridge crossing",
                          f"Front crossed a ridge at {e[rr[j], cc[j]]:,.0f} m (TPI +{t_[rr[j], cc[j]]:.0f} m), moving {cardinal(heading)}.",
                          "estimated", "USGS 3DEP terrain + observed arrival", (x, z)))
        if len(out) >= RIDGE_MAX:
            break
    return out


def wind_shift_events(T: np.ndarray, grid: Grid, origin_ms: int, total_acres: float) -> list[dict]:
    """A marked change (>= 75 deg) of the main spread direction between consecutive 6-hour growth windows, each with
    coherent spread (mean resultant length >= 0.5) and >= max(3 % of the final area, 125 ac). At most 1; inferred
    from the observed arrival (weather is not used)."""
    b = burned(T)
    if b.sum() < 50:
        return []
    gx, gz, _ = arrival_gradient(T, grid.res_m)
    g = np.hypot(gx, gz)
    ok = b & np.isfinite(g) & (g > 0)
    if ok.sum() < 50:
        return []
    ux, uz = np.where(ok, gx / np.where(ok, g, 1.0), 0.0), np.where(ok, gz / np.where(ok, g, 1.0), 0.0)
    X, Z = grid.cell_centers_local()
    t_ok = T[ok].astype(np.float64)
    w0 = math.floor(t_ok.min() / SHIFT_WINDOW_H)
    w1 = math.floor(t_ok.max() / SHIFT_WINDOW_H)
    ca = cell_acres(grid.res_m)
    min_ac = max(0.03 * total_acres, 125.0)
    wins = []
    for w in range(w0, w1 + 1):
        sel = ok & (T >= w * SHIFT_WINDOW_H) & (T < (w + 1) * SHIFT_WINDOW_H)
        n = int(sel.sum())
        if n * ca < min_ac:
            continue
        mx, mz = float(ux[sel].mean()), float(uz[sel].mean())
        R = math.hypot(mx, mz)
        if R < SHIFT_MIN_COHERENCE:
            continue
        wins.append((w, bearing(mx, mz), R, n * ca, float(X[sel].mean()), float(Z[sel].mean())))
    best = None
    for (w_a, b_a, _, a_a, _, _), (w_b, b_b, _, a_b, x_b, z_b) in zip(wins, wins[1:]):
        if (w_b - w_a) * SHIFT_WINDOW_H > SHIFT_MAX_GAP_H:
            continue
        d = abs((b_b - b_a + 180.0) % 360.0 - 180.0)
        if d >= SHIFT_MIN_DEG:
            score = d * min(a_a, a_b)
            if best is None or score > best[0]:
                best = (score, w_b, b_a, b_b, x_b, z_b, d)
    if best is None:
        return []
    _, w_b, b_a, b_b, x_b, z_b, d = best
    t_ms = int(round(origin_ms + w_b * SHIFT_WINDOW_H * HOUR_MS))
    return [_event("wind_shift", t_ms, "Wind shift (inferred)",
                   f"Main spread direction turned {d:.0f}° (toward {cardinal(b_a)} -> toward {cardinal(b_b)}), "
                   "inferred from the observed growth.", "estimated", "Observed arrival (spread direction)", (x_b, z_b))]


def perimeter_events(steps: Sequence[PerimeterStep], start_ms: int, end_ms: int) -> list[dict]:
    """First and latest trusted perimeters inside the timeline (at most 2)."""
    tr = [p for p in steps if p.trusted and start_ms <= p.t_ms <= end_ms]
    if not tr:
        return []
    picks = [tr[0]] + ([tr[-1]] if len(tr) > 1 and tr[-1].t_ms - tr[0].t_ms >= 12 * HOUR_MS else [])
    out = []
    for i, p in enumerate(picks):
        c = p.geom.centroid
        title = "First mapped perimeter" if i == 0 else "Perimeter update"
        out.append(_event("perimeter_update", p.t_ms, title,
                          f"NIFC WFIGS perimeter: {p.own_acres:,.0f} ac (cumulative {p.acres:,.0f} ac).", "observed",
                          "NIFC WFIGS", (c.x, c.y)))
    return out


def containment_time(perims: Sequence[dict], summary: Any) -> tuple[int | None, str]:
    """Containment time: WFIGS ``attr_ContainmentDateTime`` (latest record), else CAL FIRE at 100 %."""
    cands = [int(p["containment_ms"]) for p in perims if p.get("containment_ms")]
    started = int(summary.started_ms)
    cands = [c for c in cands if started < c <= started + PERIM_HORIZON_MS]
    if cands:
        return max(cands), "NIFC WFIGS ContainmentDateTime"
    pc = getattr(summary, "percent_contained", None)
    if pc is not None and float(pc) >= 100.0 and getattr(summary, "contained_ms", None):
        return int(summary.contained_ms), "CAL FIRE (100% contained)"
    return None, ""


def limit_events(events: list[dict], max_n: int = MAX_EVENTS) -> list[dict]:
    """Keep at most ``max_n`` events by type priority, sorted by time, with ids ``ev-01``..."""
    rank = {t: i for i, t in enumerate(EVENT_PRIORITY)}
    keep = sorted(events, key=lambda e: (rank.get(e["type"], 99), e["t_ms"]))[:max_n]
    keep.sort(key=lambda e: (e["t_ms"], rank.get(e["type"], 99)))
    out = []
    for i, e in enumerate(keep):
        d = {"id": f"ev-{i + 1:02d}"}
        d.update(e)
        out.append(d)
    return out


def profile_path(T: np.ndarray, grid: Grid, ign_xz: tuple[float, float]) -> list[list[float]]:
    """``[ignition, farthest burned pixel along the dominant growth direction]`` (local x/z). The direction points from
    the ignition to the burned-area centroid (the principal axis when they nearly coincide)."""
    b = burned(T)
    ix, iz = float(ign_xz[0]), float(ign_xz[1])
    if b.sum() < 2:
        return [[round(ix, 1), round(iz, 1)], [round(ix + grid.res_m, 1), round(iz, 1)]]
    X, Z = grid.cell_centers_local()
    bx, bz = X[b] - ix, Z[b] - iz
    cx, cz = float(bx.mean()), float(bz.mean())
    if math.hypot(cx, cz) < 2.0 * grid.res_m:
        cov = np.cov(np.vstack([bx, bz]))
        _, v = np.linalg.eigh(cov)
        cx, cz = float(v[0, -1]), float(v[1, -1])
    n = math.hypot(cx, cz) or 1.0
    ux, uz = cx / n, cz / n
    along = bx * ux + bz * uz
    across = np.abs(-bx * uz + bz * ux)
    cone = (along > 0) & (across <= np.tan(np.radians(20.0)) * np.maximum(along, 1e-9))
    if not cone.any():
        cone = along > 0
    if not cone.any():
        cone = np.ones_like(along, dtype=bool)
    j = int(np.argmax(np.where(cone, along, -np.inf)))
    fx, fz = float(bx[j] + ix), float(bz[j] + iz)
    return [[round(ix, 1), round(iz, 1)], [round(fx, 1), round(fz, 1)]]


# ==================================================================================================================
# Elevation for ridge detection
# ==================================================================================================================
def fire_elevation(bdir: Path, grid: Grid, manifest: dict | None, allow_fetch: bool = True) -> tuple[np.ndarray | None, str]:
    """Fire-grid elevation from ``sim/static.npz``, else the render-grid ``elevation`` layer (area mean), else a 3DEP
    request (``sources.terrain.fetch_dem``). (None, reason) when none works."""
    p = Path(bdir) / bundle.STATIC_NPZ
    if p.is_file():
        try:
            e = bundle.read_npz(p).get("elevation")
            if e is not None and e.shape == grid.shape:
                return np.asarray(e, dtype=np.float32), "sim/static.npz"
        except (OSError, ValueError, KeyError) as exc:
            log.info("static.npz unreadable for elevation: %s", exc)
    if manifest and "elevation" in (manifest.get("layers") or {}):
        try:
            from ..sources.terrain import area_resample

            e = bundle.read_layer(bdir, "elevation", manifest)
            return area_resample(e, grid.shape), "elevation layer"
        except Exception as exc:  # noqa: BLE001 - optional input
            log.info("elevation layer unreadable: %s", exc)
    if not allow_fetch:
        return None, "no elevation in the bundle"
    try:
        from ..sources.terrain import fetch_dem

        return np.asarray(fetch_dem(grid), dtype=np.float32), "USGS 3DEP"
    except Exception as exc:  # noqa: BLE001 - ridges are optional
        return None, f"no elevation ({config.mask_secrets(exc)})"


# ==================================================================================================================
# Main entry
# ==================================================================================================================
def _live_observation(raw: pd.DataFrame, goes: pd.DataFrame, sites: np.ndarray, T: np.ndarray, grid: Grid, summary: Any,
                      last_det: int, wall: int) -> tuple["la_obs.LiveObservation", list[dict]]:
    """Live bundles: the latest observation (confirmed satellite passes after the last detection, see
    build/live_observation.py) and the activity markers after the last detection. Never raises."""
    from ..sources import firms

    b = burned(T)
    res = grid.res_m
    if b.any():
        r, c = np.nonzero(b)
        x, z = grid.pixel_center_local(r, c)
        lon, lat = grid.local_to_lonlat(float(np.mean(x)), float(np.mean(z)))
    else:
        lon, lat = float(summary.lon), float(summary.lat)
    data_times = firms.data_times_by_satellite(raw)
    acres, updated = la_obs.official_from(summary)
    sp = raw[raw["instrument"].isin(SPATIAL_INSTRUMENTS)] if raw is not None and len(raw) else None
    det_t = np.asarray([] if sp is None else sp["t_ms"], dtype=np.int64)
    det_s = np.asarray([] if sp is None else sp["satellite"].astype(str), dtype=object)
    obs = la_obs.latest_observation(last_det, (float(lon), float(lat)), det_t, det_s, data_times, wall,
                                    official_acres=acres, official_updated_ms=updated,
                                    mapped_acres=float(b.sum() * cell_acres(res)))
    try:
        all_det = prepare_detections(raw, grid, quality=False)
        markers = la_obs.activity_markers(all_det, goes, b, res, last_det, wall, sites)
    except Exception as e:  # noqa: BLE001 - markers are optional
        log.warning("activity markers failed: %s", config.mask_secrets(e))
        markers = []
    return obs, markers


def _det_window(summary: Any, mode: str, ctx_end_ms: int | None, ctx_now_ms: int | None, wall_ms: int) -> tuple[int, int]:
    start = int(summary.started_ms)
    if mode == "live":
        end = int(min(ctx_now_ms or wall_ms, wall_ms))
        return max(start - PRE_START_MS, end - MAX_SPAN_MS), end
    cands = [int(c) for c in (ctx_end_ms, getattr(summary, "contained_ms", None)) if c and c > start]
    end = max(cands) if cands else start + DEFAULT_HIST_SPAN_MS
    end = max(end, start + MIN_HIST_SPAN_MS) + DAY_MS
    return start - PRE_START_MS, int(min(end, start + MAX_SPAN_MS, wall_ms))


def _detections_json(spatial: pd.DataFrame, goes: pd.DataFrame, t0: int, t1: int) -> list[dict]:
    rows = pd.concat([spatial, thin_goes(goes)], ignore_index=True) if len(goes) else spatial
    rows = rows[(rows["t_ms"] >= t0) & (rows["t_ms"] <= t1)].sort_values(["t_ms", "instrument"], kind="stable")
    out = []
    for r in rows.itertuples(index=False):
        frp = float(r.frp) if r.frp is not None and np.isfinite(r.frp) else None
        dn = str(r.daynight) if str(r.daynight) in ("D", "N") else "D"
        out.append({
            "t_ms": int(r.t_ms), "lat": round(float(r.lat), 5), "lon": round(float(r.lon), 5),
            "x": round(float(r.x), 1), "z": round(float(r.z), 1), "frp": None if frp is None else round(frp, 2),
            "satellite": str(r.satellite), "instrument": str(r.instrument), "confidence": str(r.confidence),
            "daynight": dn, "footprint_m": float(GOES_FOOTPRINT_M if r.instrument == "GOES" else r.footprint_m),
        })
    return out


def _firms_detail(df: pd.DataFrame, n_fire: int, window: tuple[int, int]) -> tuple[str, int]:
    srcs = (df.attrs.get("sources") if df is not None else None) or []
    via = sorted({str(s.get("via")) for s in srcs if s.get("via")})
    fetched = max([int(s.get("fetched_ms") or 0) for s in srcs] or [0])
    counts = df.groupby("instrument").size().to_dict() if df is not None and len(df) else {}
    parts = [f"{k} {int(v):,}" for k, v in sorted(counts.items())]
    detail = (f"{', '.join(via) or 'no data'}; {ms_to_iso(window[0])[:10]} -> {ms_to_iso(window[1])[:10]}; "
              f"{len(df) if df is not None else 0:,} detections in the AOI ({', '.join(parts) or 'none'}); {n_fire:,} of this fire")
    return detail, fetched


def build_observed(ctx: BuildContext) -> None:
    """Write detections.json, perimeters.json, the observed_arrival layer, timeseries.json and events.json, and set
    ``ignition``, ``default_profile_path``, ``time_range``, ``stats``, ``data_sources`` and ``warnings`` in the
    manifest (also ``ctx.end_ms`` / ``ctx.now_ms``). Never raises for data gaps (an empty fire is written)."""
    build_observed_stats(ctx)


def build_observed_stats(ctx: BuildContext) -> dict[str, Any]:
    """:func:`build_observed`, returning a diagnostics dict (areas, snapshot counts, timings, warnings)."""
    from ..sources import firms, perimeters as wfigs

    t_run = time.time()
    s = ctx.summary
    grid: Grid = ctx.fire_grid
    bdir = Path(ctx.bundle_dir)
    origin = int(ctx.time_origin_ms)
    mode = ctx.mode
    res = grid.res_m
    ca = cell_acres(res)
    wall = now_ms()
    started = int(s.started_ms)
    warnings: list[str] = []
    stats: dict[str, Any] = {"id": s.id, "mode": mode}

    def progress(f: float, msg: str) -> None:
        try:
            ctx.progress(STEP, float(min(max(f, 0.0), 1.0)), msg)
        except Exception:  # noqa: BLE001 - a broken progress sink must not break the build
            log.debug("progress callback failed", exc_info=True)

    det_t0, det_t1 = _det_window(s, mode, ctx.end_ms, ctx.now_ms, wall)
    cal_xz = tuple(float(v) for v in grid.lonlat_to_local(float(s.lon), float(s.lat)))

    # --- perimeters ----------------------------------------------------------------------------------------------
    progress(0.02, "NIFC WFIGS perimeters")
    perim_end = wall if mode == "live" else min(wall, started + PERIM_HORIZON_MS)
    try:
        perims = wfigs.fetch_perimeters(s.name, float(s.lat), float(s.lon), started, perim_end, acres=s.acres,
                                        contained_ms=s.contained_ms)
        warnings += [f"WFIGS: {w}" for w in getattr(perims, "warnings", [])]
        perims = list(perims)
    except Exception as e:  # noqa: BLE001 - perimeters are optional
        log.warning("perimeters unavailable for %s: %s", s.id, config.mask_secrets(e))
        warnings.append(f"WFIGS perimeters unavailable ({config.mask_secrets(e)})")
        perims = []
    steps, w = cumulative_perimeters(perims, grid)
    warnings += w
    perim_union = steps[-1].geom if steps else None
    t_perim_fetch = now_ms()

    # --- detections ---------------------------------------------------------------------------------------------
    progress(0.05, f"FIRMS detections {ms_to_iso(det_t0)[:10]} -> {ms_to_iso(det_t1)[:10]}")
    raw = firms.detections_for(grid.bbox_lonlat(), det_t0, det_t1, mode)
    warnings += [f"FIRMS: {w}" for w in (raw.attrs.get("warnings") or [])[:5]]
    det = prepare_detections(raw, grid)
    pre = None
    try:
        progress(0.35, "pre-fire hot spots (static sources)")
        pre_end = min(det_t0, started - PRE_START_MS) - 1        # always the week before the fire, never later
        pre_raw = firms.detections_for(grid.bbox_lonlat(), started - STATIC_LOOKBACK_MS, pre_end, mode,
                                       instruments=("VIIRS",), families=("SNPP", "NOAA20"))
        pre = prepare_detections(pre_raw, grid)
    except Exception as e:  # noqa: BLE001 - static-source screening is optional
        log.info("pre-fire detections unavailable: %s", config.mask_secrets(e))
    early = det[(det["t_ms"] < started - HOUR_MS)]
    pre_parts = [d for d in (pre, early) if d is not None and len(d)]
    sites = static_sites(pd.concat(pre_parts, ignore_index=True) if pre_parts else None, cal_xz)

    # --- this fire's detections -------------------------------------------------------------------------------------
    progress(0.45, "selecting this fire's detections")
    sel = select_fire_detections(det, cal_xz, started, perim_union, sites)
    spatial, goes = sel.spatial, sel.goes
    stats.update({"detections_aoi": int(len(det)), "spatial": int(len(spatial)), "goes": int(len(goes)),
                  "static_dropped": sel.n_static, "other_fires": int(len(sel.others)), "static_sites": int(len(sites))})
    if sel.n_static:
        warnings.append(f"{sel.n_static} detection(s) at {len(sites)} static hot spot(s) (hot before the fire) ignored")
    if len(sel.others):
        warnings.append(f"{len(sel.others)} detection(s) of other fires inside the AOI ignored")

    # --- detection snapshots (unclipped) ------------------------------------------------------------------------------
    progress(0.5, "burned area")
    groups = pass_groups(spatial["t_ms"].to_numpy(dtype=np.int64)) if len(spatial) else []
    target = float(s.acres) if s.acres else None
    last_trusted_ms = None
    for st_ in steps:
        st_.mask = rasterize_local(st_.geom, grid)
        sig = PERIM_SNAPSHOT_SMOOTH_M / res
        st_.snap_mask = (ndimage.gaussian_filter(st_.mask.astype(np.float32), sig) >= 0.5) if sig >= 0.5 else st_.mask
    P_last = steps[-1].mask if steps else None
    # trusted perimeters: inside the detection-defined growth period (+24 h)
    viirs_s = SHRINK["VIIRS"]
    if not steps:
        # CAL FIRE acres may only shrink the detection estimate when they are final (historical) or newer than our
        # latest detection (live); an older live number says nothing about the growth since
        latest = int(spatial["t_ms"].max()) if len(spatial) else None
        fresh = mode != "live" or (s.updated_ms is not None and latest is not None and s.updated_ms >= latest - HOUR_MS)
        fm = final_mask(None, spatial, grid, target, allow_reduce=fresh)
        viirs_s = fm.viirs_shrink
    # snapshot masks shrink harder than F: an intense small fire lights up a ring of neighbouring pixels, so the early
    # footprint unions overstate the burned area (Palisades: ~4x in the first hours with 2/3)
    viirs_s = min(viirs_s, SNAPSHOT_SHRINK)
    acc = FootprintUnion(grid, viirs_s)
    det_masks: list[np.ndarray] = [acc.add(spatial.iloc[g]).mask() for g in groups]
    g_times = [int(np.median(spatial["t_ms"].to_numpy()[g])) for g in groups]
    t_growth_end = growth_end_ms(g_times, det_masks)
    snap_groups = list(range(len(groups)))
    if mode != "live" and t_growth_end is not None:
        # mop-up hot spots long after the growth stopped are not growth: their pixels get neighbour times instead
        snap_groups = [i for i in snap_groups if g_times[i] <= t_growth_end + LATE_GROUP_MS]
        stats["late_groups_dropped"] = len(groups) - len(snap_groups)
    if steps:
        for st_ in steps:
            st_.trusted = t_growth_end is None or st_.t_ms <= t_growth_end + PERIM_TRUST_MS
        tr = [p for p in steps if p.trusted]
        last_trusted_ms = tr[-1].t_ms if tr else None
        untrusted = [p for p in steps if not p.trusted]
        if untrusted:
            warnings.append(f"{len(untrusted)} WFIGS perimeter(s) dated after the fire stopped growing "
                            f"({', '.join(ms_to_iso(p.t_ms)[:10] for p in untrusted)}) used for the final extent only")
        fm = final_mask(P_last, spatial, grid, target, after_ms=(last_trusted_ms + 3 * HOUR_MS) if mode == "live" and last_trusted_ms else None)
    F = fm.mask
    warnings += fm.notes
    stats.update({"F_method": fm.method, "viirs_shrink": round(fm.viirs_shrink, 3), "detection_acres": round(fm.detection_acres),
                  "perimeter_acres": round(fm.perimeter_acres), "F_acres": round(float(F.sum() * ca)),
                  "official_acres": target, "perimeters_total": len(steps), "perimeters_trusted": sum(p.trusted for p in steps)})

    # --- ignition -------------------------------------------------------------------------------------------------------
    first_xz = None
    if groups:
        g0 = spatial.iloc[groups[0]]
        first_xz = g0[["x", "z"]].to_numpy(dtype=np.float64)
    ign_x, ign_z, ign_rc, ign_where, ign_notes = place_ignition(grid, cal_xz, first_xz, F)
    warnings += ign_notes

    # --- snapshots + arrival --------------------------------------------------------------------------------------------
    progress(0.6, "snapshots and arrival-time interpolation")
    snaps = (build_snapshots(spatial, [groups[i] for i in snap_groups], [det_masks[i] for i in snap_groups], steps, F,
                             origin + 2 * 60_000) if F.any() else [])
    t_ign, ign_why, ign_conf, t_goes, goes_sat = ignition_time(started, origin, (ign_x, ign_z), goes, spatial,
                                                               snaps[0].t_ms if snaps else None)
    t_ign_h = float(to_hours(t_ign, origin))
    activity = Activity(goes, min(t_ign, det_t0), max(det_t1, t_ign + HOUR_MS))
    T = np.full(grid.shape, NEVER, dtype=np.float32)
    spots = find_spots(snaps, spatial, grid, F, t_ign) if snaps else []
    if snaps:
        # Join detached new areas to the earlier burned area by cones: always for the first snapshot (then closed by
        # 400 m and smoothed: the early run is one area, not a starburst); later only within 1 km and never for
        # probable spot fires, which grow from their own core. New pixels inside the area the fire had already
        # enclosed are infill, timed from their neighbours.
        prev = np.zeros(grid.shape, dtype=bool)
        prev[ign_rc] = True
        infill = np.zeros(grid.shape, dtype=bool)
        for k, sn in enumerate(snaps):
            keep = None
            ks = [c.rc for c in spots if c.k == k]
            if ks:
                keep = np.zeros(grid.shape, dtype=bool)
                keep[tuple(np.array(ks).T)] = True
            obs_m = sn.mask | prev
            if k > 0:
                obs_m = drop_small_detached(prev, obs_m, res, MIN_DETACHED_M2, keep)
            m = connect_detached(prev, obs_m, F, res, None if k == 0 else CORRIDOR_MAX_M, keep)
            if k == 0:
                c0 = close_mask(m, res, FIRST_CLOSE_M)
                c0 = ndimage.gaussian_filter(c0.astype(np.float32), max(0.5, 2.0 * SMOOTH_M / res)) >= 0.5
                m = (c0 & F) | m                     # keep the cones too: the ignition stays connected
            else:
                infill |= m & ~prev & envelope(prev, res, ENVELOPE_M)
            sn.mask = m
            prev = m
        times_h = [to_hours(sn.t_ms, origin) for sn in snaps]
        warp = (lambda ta, tb, r: activity.warp(origin + ta * HOUR_MS, origin + tb * HOUR_MS, r)) if activity.available else None
        T, _ = interpolate_arrival([sn.mask for sn in snaps], times_h, ign_rc, t_ign_h, warp)
        speed = typical_speed_m_h(T, res)
        d_all = det_masks[-1] if det_masks else np.zeros(grid.shape, dtype=bool)
        suspect = (F & ~d_all) | infill
        T = relax_suspect(T, suspect, res, speed)
        unreached = F & ~burned(T)
        if unreached.any():
            T = fill_unreached(T, F, res, speed, cap_h=to_hours(det_t1, origin))
        T = median_arrival(T, res)
        seeds = np.zeros(grid.shape, dtype=bool)
        seeds[ign_rc] = True
        for c in spots:
            seeds[c.rc] = True
        T[ign_rc] = np.float32(t_ign_h)
        T, n_raised = fill_sinks(T, seeds, res, speed)
        T = smooth_arrival(T, res)
        stats["sink_filled_acres"] = round(n_raised * ca)
        stats.update({"fill_acres": round(float(unreached.sum() * ca)), "fill_speed_m_h": round(speed, 1),
                      "suspect_acres": round(float(suspect.sum() * ca)), "infill_acres": round(float(infill.sum() * ca))})
    elif F.any():
        T[F] = t_ign_h
    T = np.where(burned(T), np.maximum(T, max(t_ign_h, 0.0)), NEVER).astype(np.float32)
    if burned(T).any():
        T[ign_rc] = np.float32(t_ign_h)

    # --- time range --------------------------------------------------------------------------------------------------
    b = burned(T)
    live_obs = None
    markers: list[dict] = []
    if mode == "live":
        obs = [int(spatial["t_ms"].max())] if len(spatial) else []
        obs += [p.t_ms for p in steps if p.t_ms <= wall]
        if obs and config.LIVE_START_LATEST_PASS:
            # the burned area is known up to the last detection / perimeter; later confirmed satellite passes that
            # saw no new fire move the latest observation (and the default forecast start) forward
            last_det = max(min(max(obs), wall), t_ign)
            T = np.where(b & (T > to_hours(last_det, origin)), np.float32(to_hours(last_det, origin)), T).astype(np.float32)
            progress(0.78, "satellite passes since the last detection (NASA CMR)")
            live_obs, markers = _live_observation(raw, goes, sites, T, grid, s, last_det, wall)
            end_ms = now_ms_ = int(live_obs.now_ms)
            warnings += live_obs.warnings
            stats.update({"last_detection_ms": last_det, "live_rule": live_obs.rule, "quiet_passes": live_obs.quiet_passes,
                          "activity_markers": len(markers)})
        else:
            end_ms = now_ms_ = max(min(max(obs), wall) if obs else int(ctx.now_ms or wall), t_ign)
            T = np.where(b & (T > to_hours(now_ms_, origin)), np.float32(to_hours(now_ms_, origin)), T).astype(np.float32)
    else:
        if b.any():
            t99 = origin + float(np.percentile(T[b], 99)) * HOUR_MS
            end_ms = int(min(t99 + END_PAD_MS, started + MAX_SPAN_MS))
        else:
            end_ms = int(min(max(t_ign + DAY_MS, origin + DAY_MS), started + MAX_SPAN_MS))
        end_ms = max(end_ms, t_ign + HOUR_MS)
        t_cont, cont_src = containment_time(perims, s)
        if t_cont is not None and end_ms < t_cont <= end_ms + CONTAIN_EXTEND_MS and t_cont <= started + MAX_SPAN_MS:
            end_ms = int(t_cont) + HOUR_MS
        now_ms_ = end_ms
        T = np.where(b & (T > to_hours(end_ms, origin)), np.float32(to_hours(end_ms, origin)), T).astype(np.float32)
    end_ms, now_ms_ = int(end_ms), int(now_ms_)
    ctx.end_ms, ctx.now_ms = end_ms, now_ms_
    b = burned(T)
    final_acres = float(b.sum() * ca)

    # --- outputs ---------------------------------------------------------------------------------------------------
    progress(0.8, "time series and events")
    dets_json = _detections_json(spatial, goes, origin, now_ms_)
    t_hourly = hourly_times(origin, now_ms_)
    ts = make_timeseries(T, res, origin, t_hourly, np.array([d["t_ms"] for d in dets_json], dtype=np.int64),
                         activity, spatial)

    events: list[dict] = []
    ign_detail = f"Reported by CAL FIRE {la_time(started)}."
    if t_goes is not None:
        ign_detail += f" First persistent GOES detection {la_time(t_goes)} ({SATELLITE_NAMES.get(goes_sat, goes_sat)})."
    if t_ign != started:
        ign_detail += f" Ignition estimated {ign_why}."
    ign_src = "CAL FIRE" + (" + FIRMS GOES" if t_goes is not None else "")
    events.append(_event("ignition", t_ign, "Ignition", ign_detail, ign_conf, ign_src, (ign_x, ign_z)))
    events += rapid_growth_events(ts, T, grid, origin, [sn.t_ms for sn in snaps])
    events += spot_fire_events(spots)
    elev, elev_src = fire_elevation(bdir, grid, bundle.load_manifest(bdir))
    if elev is not None and b.any():
        try:
            events += ridge_crossing_events(T, F, elev, grid, origin)
        except Exception as e:  # noqa: BLE001 - optional event type
            log.warning("ridge detection failed: %s", e)
    elif elev is None:
        warnings.append(f"ridge crossings not detected: {elev_src}")
    events += wind_shift_events(T, grid, origin, final_acres)
    events += perimeter_events(steps, origin, end_ms)
    if mode != "live":
        t_cont, cont_src = containment_time(perims, s)
        if t_cont is not None and origin <= t_cont <= end_ms:
            events.append(_event("containment", t_cont, "Containment", f"100% contained ({cont_src}).", "observed", cont_src))
    events = [e for e in events if origin <= e["t_ms"] <= end_ms]
    events = limit_events(events)

    # perimeters.json: cumulative, retimed into the timeline
    perim_json: list[dict] = []
    for p in steps:
        t = min(max(p.t_ms, origin), end_ms)
        src = p.source
        if p.t_ms > end_ms:
            src += f" (final extent, mapped {ms_to_iso(p.t_ms)[:10]})"
        rings = simplify_rings(p.geom, res)
        if not rings:
            continue
        item = {"t_ms": int(t), "acres": round(float(p.acres), 1), "source": src, "rings": rings}
        if perim_json and perim_json[-1]["t_ms"] == item["t_ms"]:
            perim_json[-1] = item
        else:
            perim_json.append(item)

    path = profile_path(T, grid, (ign_x, ign_z))
    ign_lon, ign_lat = grid.local_to_lonlat(ign_x, ign_z)

    # --- write ------------------------------------------------------------------------------------------------------
    progress(0.92, "writing")
    bundle.write_json(bdir / "detections.json", {"detections": dets_json})
    bundle.write_json(bdir / "perimeters.json", {"perimeters": perim_json})
    bundle.write_json(bdir / "timeseries.json", ts)
    bundle.write_json(bdir / "events.json", {"events": events})
    bundle.write_layer(bdir, "observed_arrival", T, "fire", "h",
                       "Observed arrival time, hours since time_origin_ms (NEVER = 1e6): VIIRS/MODIS/Landsat overpass "
                       "snapshots + NIFC WFIGS perimeters, distance-ratio interpolation with GOES FRP timing")
    firms_detail, firms_fetched = _firms_detail(raw, len(spatial) + len(goes), (det_t0, det_t1))
    sources = [{"name": "NASA FIRMS active fire detections", "detail": firms_detail, "fetched_ms": int(firms_fetched or wall)}]
    if steps:
        p_detail = (f"{len(steps)} perimeter(s) {ms_to_iso(steps[0].t_ms)[:10]} -> {ms_to_iso(steps[-1].t_ms)[:10]}, "
                    f"final {steps[-1].acres:,.0f} ac ({sum(p.trusted for p in steps)} used for timing)")
    else:
        p_detail = "no perimeter found for this incident; burned area from satellite detections only"
    sources.append({"name": "NIFC WFIGS fire perimeters", "detail": p_detail, "fetched_ms": int(t_perim_fetch)})
    if live_obs is not None and live_obs.source:
        sources.append(live_obs.source)
    if mode == "live":
        act_path = bdir / "sim" / la_obs.ACTIVITY_FILE
        if live_obs is not None:
            bundle.write_json(act_path, live_obs.activity_doc(markers), indent=True)
        else:
            act_path.unlink(missing_ok=True)
    if not F.any():
        warnings.append("no satellite detections or perimeters of this fire: no observed spread")
    my_warnings = [WARNING_PREFIX + config.mask_secrets(w) for w in dict.fromkeys(warnings)]
    ignition = {"x": round(ign_x, 1), "z": round(ign_z, 1), "lat": round(float(ign_lat), 6), "lon": round(float(ign_lon), 6),
                "t_ms": int(t_ign), "source": f"{ign_where}; time: {ign_why}"}
    m_stats = {"final_acres_observed": round(final_acres, 1), "detections": len(dets_json), "perimeters": len(perim_json)}

    time_range: dict[str, int] = {"start_ms": origin, "end_ms": end_ms, "now_ms": now_ms_}
    if live_obs is not None:
        time_range["last_detection_ms"] = int(live_obs.last_detection_ms)
        if live_obs.last_pass_ms is not None:
            time_range["last_pass_ms"] = int(live_obs.last_pass_ms)

    def fn(m: dict) -> None:
        m["time_range"] = time_range
        m["ignition"] = ignition
        m["default_profile_path"] = path
        m["stats"] = m_stats
        keep = [d for d in m.get("data_sources") or [] if not str(d.get("name", "")).startswith(SOURCE_PREFIXES)]
        m["data_sources"] = keep + sources
        kept_w = [x for x in m.get("warnings") or [] if not str(x).startswith(WARNING_PREFIX)]
        m["warnings"] = kept_w + my_warnings

    bundle.update_manifest(bdir, fn)
    stats.update({
        "final_acres": round(final_acres, 1), "ratio_official": round(final_acres / target, 3) if target else None,
        "snapshots": len(snaps), "snapshots_perimeter": sum(1 for sn in snaps if sn.kind == "perimeter"),
        "pass_groups": len(groups), "ignition_ms": t_ign, "ignition_source": ign_why, "start_ms": origin, "end_ms": end_ms,
        "now_ms": now_ms_, "events": [f"{e['type']}@{ms_to_iso(e['t_ms'])[:16]}" for e in events],
        "detections_json": len(dets_json), "perimeters_json": len(perim_json), "goes_satellite": activity.satellite,
        "elevation": elev_src, "warnings": my_warnings, "runtime_s": round(time.time() - t_run, 1),
    })
    progress(1.0, f"observed spread: {final_acres:,.0f} ac, {len(snaps)} snapshots, {len(events)} events")
    return stats


# ==================================================================================================================
# Quick-look PNGs (dev)
# ==================================================================================================================
def _hillshade(elev: np.ndarray, res_m: float) -> np.ndarray:
    gz, gx = np.gradient(elev.astype(np.float64), res_m)
    az, alt = np.radians(315.0), np.radians(45.0)
    slope = np.arctan(np.hypot(gx, gz))
    aspect = np.arctan2(-gx, gz)
    hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return np.clip(hs, 0.0, 1.0)


def _ramp(u: np.ndarray) -> np.ndarray:
    """Early (pale yellow) -> late (deep violet) colour ramp, u in 0..1 -> (.., 3) float 0..255."""
    stops = np.array([[255, 246, 170], [255, 190, 70], [250, 110, 40], [200, 45, 70], [120, 30, 120], [50, 30, 110]], dtype=np.float64)
    u = np.clip(u, 0.0, 1.0) * (len(stops) - 1)
    i = np.minimum(np.floor(u).astype(int), len(stops) - 2)
    f = (u - i)[..., None]
    return stops[i] * (1 - f) + stops[i + 1] * f


def write_quicklooks(bdir: Path, out: Path, prefix: str, elev: np.ndarray | None = None) -> list[Path]:
    """Arrival map (colour ramp, isochrones, perimeters, ignition, detections by instrument, events), a 3 x 2 grid of
    fronts at six times, and the area/growth/FRP series. Returns the PNG paths."""
    from PIL import Image, ImageDraw

    out.mkdir(parents=True, exist_ok=True)
    m = bundle.load_manifest(bdir) or {}
    from ..grid import grids_from_manifest

    _, grid = grids_from_manifest(m)
    T = bundle.read_layer(bdir, "observed_arrival", m)
    dets = bundle.read_json(bdir / "detections.json")["detections"]
    pers = bundle.read_json(bdir / "perimeters.json")["perimeters"]
    evs = bundle.read_json(bdir / "events.json")["events"]
    ts = bundle.read_json(bdir / "timeseries.json")
    origin = int(m["time_origin_ms"])
    tr = m["time_range"]
    S = 1024
    ext = grid.extent_m
    paths: list[Path] = []
    b = burned(T)
    t_ign = (int(m["ignition"]["t_ms"]) - origin) / HOUR_MS if m.get("ignition") else 0.0
    t_hi = float(np.percentile(T[b], 99)) if b.any() else t_ign + 1
    span = max(t_hi - t_ign, 1e-3)
    if elev is not None:
        hs = _hillshade(elev, grid.res_m)
        base = (hs * 0.6 + 0.15)[..., None] * np.array([150.0, 160.0, 150.0])
    else:
        base = np.full(T.shape + (3,), 40.0)
    u = (T.astype(np.float64) - t_ign) / span
    col = np.where(b[..., None], _ramp(u) * 0.8 + base * 0.2, base)
    step = next((s_ for s_ in (1, 2, 3, 6, 12, 24, 48, 96) if span / s_ <= 16), 96)
    band = np.where(b, np.floor((T - t_ign) / step), -1)
    edge = b & ((np.diff(band, axis=0, prepend=band[:1]) != 0) | (np.diff(band, axis=1, prepend=band[:, :1]) != 0))
    col[edge] = [30, 20, 20]
    img = Image.fromarray(col.astype(np.uint8)).resize((S, S), Image.NEAREST)
    dr = ImageDraw.Draw(img)

    def px(x: float, z: float) -> tuple[float, float]:
        return ((x / ext + 0.5) * S, (z / ext + 0.5) * S)

    for p in pers:
        for ring in p["rings"]:
            dr.line([px(a, c) for a, c in ring], fill=(255, 255, 255), width=1)
    colors = {"VIIRS": (40, 230, 255), "MODIS": (255, 60, 255), "LANDSAT": (60, 255, 120), "GOES": (120, 120, 255)}
    for d in dets:
        X, Y = px(d["x"], d["z"])
        c = colors.get(d["instrument"], (255, 255, 255))
        if d["instrument"] == "GOES":
            dr.point((X, Y), fill=c)
        elif d["instrument"] == "MODIS":
            dr.rectangle([X - 2, Y - 2, X + 2, Y + 2], outline=c)
        else:
            dr.point((X, Y), fill=c)
    for e in evs:
        if "x" in e:
            X, Y = px(e["x"], e["z"])
            dr.polygon([(X, Y - 7), (X + 7, Y), (X, Y + 7), (X - 7, Y)], outline=(255, 255, 0))
            dr.text((X + 9, Y - 6), e["type"][:12], fill=(255, 255, 0))
    if m.get("ignition"):
        X, Y = px(m["ignition"]["x"], m["ignition"]["z"])
        dr.ellipse([X - 8, Y - 8, X + 8, Y + 8], outline=(255, 0, 0), width=3)
    pth = m.get("default_profile_path") or []
    if len(pth) >= 2:
        dr.line([px(a, c) for a, c in pth], fill=(255, 215, 90), width=2)
    st = m.get("stats", {})
    acres = (m.get("summary") or {}).get("acres")
    ratio = f" ({st.get('final_acres_observed', 0) / acres:.2f}x of {acres:,.0f} official)" if acres else ""
    lines = [f"{m.get('name')}  {m.get('id')}",
             f"observed {st.get('final_acres_observed', 0):,.0f} ac{ratio}; dets {st.get('detections')}; perims {st.get('perimeters')}",
             f"{ms_to_iso(tr['start_ms'])[:16]} -> {ms_to_iso(tr['end_ms'])[:16]} (now {ms_to_iso(tr['now_ms'])[:16]}); isochrones {step} h",
             "VIIRS cyan, MODIS magenta, Landsat green, GOES blue; perimeters white; ignition red"]
    for i, t in enumerate(lines):
        dr.text((8, 8 + 14 * i), t, fill=(255, 255, 255))
    p1 = out / f"{prefix}-arrival.png"
    img.save(p1)
    paths.append(p1)

    # fronts at six times
    tiles = []
    for f in (0.05, 0.15, 0.3, 0.5, 0.75, 1.0):
        th = t_ign + f * span
        c2 = base.copy() * 0.8
        done = b & (T <= th)
        c2[done] = [70, 25, 20]
        front = b & (T > th - max(1.0, span / 60)) & (T <= th)
        c2[front] = [255, 200, 60]
        tile = Image.fromarray(c2.astype(np.uint8)).resize((512, 512), Image.NEAREST)
        d2 = ImageDraw.Draw(tile)
        d2.text((6, 6), f"{ms_to_iso(int(origin + th * HOUR_MS))[:16]}Z  {done.sum() * cell_acres(grid.res_m):,.0f} ac", fill=(255, 255, 255))
        tiles.append(tile)
    grid_img = Image.new("RGB", (1536, 1024), (0, 0, 0))
    for i, t in enumerate(tiles):
        grid_img.paste(t, ((i % 3) * 512, (i // 3) * 512))
    p2 = out / f"{prefix}-fronts.png"
    grid_img.save(p2)
    paths.append(p2)

    # series
    W_, H_ = 1200, 520
    sim = Image.new("RGB", (W_, H_), (12, 16, 14))
    d3 = ImageDraw.Draw(sim)
    t = np.asarray(ts["t_ms"], dtype=np.float64)
    if len(t) > 1:
        def xmap(v):
            return 60 + (v - t[0]) / (t[-1] - t[0]) * (W_ - 80)

        def plot(vals, top, h, color, label):
            v = np.asarray(vals, dtype=np.float64)
            vmax = float(v.max()) if v.size and v.max() > 0 else 1.0
            pts = [(xmap(a), top + h - c / vmax * h) for a, c in zip(t, v)]
            d3.line(pts, fill=color, width=2)
            d3.text((8, top), f"{label} max {vmax:,.0f}", fill=color)

        plot(ts["area_acres"], 20, 140, (226, 190, 114), "area ac")
        plot(ts["growth_acres_per_h"], 190, 90, (255, 106, 43), "growth ac/h")
        plot(ts["ros_ch_per_h"], 300, 90, (143, 191, 122), "ROS ch/h")
        if ts.get("frp_mw_per_h"):
            plot(ts["frp_mw_per_h"], 410, 90, (120, 160, 255), "FRP MW")
        for e in evs:
            X = xmap(e["t_ms"])
            d3.line([(X, 15), (X, H_ - 10)], fill=(90, 90, 90))
            d3.text((X + 2, H_ - 22), e["type"][:4], fill=(200, 200, 200))
    p3 = out / f"{prefix}-series.png"
    sim.save(p3)
    paths.append(p3)
    return paths


# ==================================================================================================================
# Standalone runner (dev)
# ==================================================================================================================
def _main(argv: list[str] | None = None) -> int:
    import json

    from .. import catalog
    from ..contracts import DetectionsFile, EventsFile, PerimetersFile, TimeseriesFile, contract_problems, dump
    from ..grid import make_aoi, manifest_grid
    from ..timeutil import time_origin_for

    ap = argparse.ArgumentParser(description="Reconstruct the observed spread of one incident (observed agent dev runner).")
    ap.add_argument("incident", help="incident id (e.g. 2025-eaton-fire-dbfa57) or a name to search in the catalogs")
    ap.add_argument("--quicklook", type=Path, default=None, help="write quick-look PNGs to this directory")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    summary = catalog.get_summary(args.incident)
    if summary is None:
        q = args.incident.strip().lower()
        for mode in ("live", "historical"):
            hits = [x for x in catalog.get_catalog(mode, min_acres=0) if q in x.name.lower()]
            if hits:
                summary = max(hits, key=lambda x: x.acres or 0)
                break
    if summary is None:
        print(f"unknown incident {args.incident!r}", file=sys.stderr)
        return 2
    t0 = time.time()
    bbox = catalog.estimate_fire_bbox(summary)
    render, fire = make_aoi(summary.lon, summary.lat, bbox, summary.mode, acres=summary.acres)
    bdir = bundle.bundle_dir(summary.id)
    origin = time_origin_for(summary.started_ms)
    initial = {
        "schema_version": 1, "id": summary.id, "name": summary.name, "mode": summary.mode, "status": "building",
        "summary": dump(summary), "time_origin_ms": origin, "grid": manifest_grid(render, fire, 0.0, 0.0), "layers": {},
        "data_sources": [], "forecasts": [], "warnings": [],
    }
    bundle.update_manifest(bdir, lambda m: initial)
    print(f"{summary.id}: AOI {render.extent_m / 1000:g} km {render.crs}, fire grid {fire.width}² @ {fire.res_m:.1f} m "
          f"(bbox {time.time() - t0:.1f} s) -> {bdir}", flush=True)

    def progress(step: str, frac: float, msg: str) -> None:
        print(f"[{time.time() - t0:6.1f}s] {frac:4.0%} {msg}", flush=True)

    ctx = BuildContext(summary=summary, bundle_dir=bdir, render_grid=render, fire_grid=fire, time_origin_ms=origin,
                       mode=summary.mode, progress=progress, fire_bbox_lonlat=tuple(bbox) if bbox else None,
                       end_ms=summary.contained_ms, now_ms=now_ms() if summary.mode == "live" else None)
    stats = build_observed_stats(ctx)
    print(json.dumps(stats, indent=1, default=str))
    problems = []
    for name, model in (("detections.json", DetectionsFile), ("perimeters.json", PerimetersFile),
                        ("timeseries.json", TimeseriesFile), ("events.json", EventsFile)):
        problems += [f"{name}: {p}" for p in contract_problems(model, (bdir / name).read_bytes())]
    print("contract problems:", problems or "none")
    if args.quicklook:
        elev, _ = fire_elevation(bdir, fire, bundle.load_manifest(bdir))
        for p in write_quicklooks(bdir, args.quicklook, summary.id, elev):
            print("quicklook", p)
    return 0


if __name__ == "__main__":
    sys.exit(_main())
