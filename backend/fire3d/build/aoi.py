"""Static layers of a bundle (SPEC 4.1, 5, 8.2). Owner: terrain agent.

:func:`build_static_layers` starts every download at once (``fire3d.http`` keeps at most 4 requests in flight;
Sentinel-2 COG reads have their own limit of 4) and then processes the steps in order, reporting
``ctx.progress(step, fraction, message)``:

* ``terrain``   3DEP DEM on the render grid -> ``elevation``, ``sky_view``; fire-grid elevation (exact area mean),
  slope (rise/run) and aspect (downslope-facing, degrees clockwise from north).
* ``fuels``     LANDFIRE FBFM40/CC/CH/CBH/CBD on the fire grid -> ``fuel``, ``canopy_cover``, ``canopy_height``,
  ``sim/static.npz``; EVT and EVC (optional) feed the trees.
* ``imagery``   NAIP JPEG -> ``naip``; NAIP G/NIR NDWI ∪ FBFM40 98 -> ``water``.
* ``trees``     ``trees`` instances from canopy cover/height, fuel model, EVT physiognomy and EVC shrub cover.
* ``burn_scar`` Sentinel-2 dNBR -> ``burn_severity`` (optional).

DEM and LANDFIRE failures raise :class:`StaticLayerError`; NAIP, water, trees and dNBR failures become manifest
warnings (and a stale layer of that name from an earlier build is removed).
Standalone run with quick-look PNGs: ``uv run python -m fire3d.build.aoi --help``.
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .. import bundle, config
from ..grid import Grid, manifest_grid, slope_aspect
from ..sources import imagery, landfire, sentinel, terrain
from ..sources.terrain import FetchInfo, RasterFetchError
from ..timeutil import DAY_MS, HOUR_MS, ms_to_iso, now_ms
from ..types import BuildContext

log = logging.getLogger(__name__)

STEPS = ("terrain", "fuels", "imagery", "trees", "burn_scar")

# Trees (SPEC 8.2)
MAX_TREES = 120_000
TREE_TARGET = 110_000                 # expected instances; Poisson noise keeps the total under MAX_TREES
SHRUB_DENSITY = 0.6                   # shrub instances per unit shrub cover, relative to trees per unit canopy cover
SHRUB_SHARE_MAX = 0.45                # shrubs (cells with cc = 0) get at most this share of the budget
MAX_INSTANCES_PER_M2 = 1.0 / 30.0     # density cap at full cover (~30 m² per crown) for small AOIs
TREE_CONIFER, TREE_BROADLEAF, TREE_SHRUB = 0, 1, 2
CONIFER_CODES = tuple(range(161, 166)) + tuple(range(181, 190))   # TU1-5, TL1-9 (SPEC 8.2 rule)
NO_TREE_CODES = (92, 98)                                          # snow/ice, open water
NO_SHRUB_CODES = (91, 92, 93, 98, 99)                             # urban, snow, agriculture, water, barren
# Scott & Burgan (2005) fuel-bed depth (m) of grass-shrub (GS) and shrub (SH) models -> shrub instance height.
SHRUB_DEPTH_M = {121: 0.27, 122: 0.46, 123: 0.55, 124: 0.64, 141: 0.30, 142: 0.30, 143: 0.73, 144: 0.91,
                 145: 1.83, 146: 0.61, 147: 1.83, 148: 0.91, 149: 1.34}
# Nominal shrub cover by fuel model when LANDFIRE EVC is unavailable (or the cell is not shrub-dominated).
NOMINAL_SHRUB_COVER = {121: 0.15, 122: 0.25, 123: 0.25, 124: 0.30, 141: 0.25, 142: 0.45, 143: 0.45, 144: 0.50,
                       145: 0.60, 146: 0.50, 147: 0.70, 148: 0.60, 149: 0.70}

# Burn scar windows (SPEC 8.2)
DNBR_PRE_DAYS = (60, 1)               # [start - 60 d, start - 1 d]
DNBR_POST_DAYS = (3, 60)              # historical: [end + 3 d, end + 60 d]
DNBR_LIVE_DAYS = 10                   # live: last 10 days (but not before start + 12 h)
DEFAULT_DURATION_D = 14               # historical end estimate when neither end_ms nor contained_ms is known
END_CAP_D = 60                        # the post-fire window is anchored no later than start + 60 d

# Manifest entries owned by this step (replaced on rebuild).
WARNING_PREFIXES = ("DEM:", "LANDFIRE:", "NAIP:", "Water mask:", "Trees:", "Burn severity:")
SOURCE_PREFIXES = ("USGS 3DEP", "LANDFIRE", "NAIP", "Sentinel-2")

DESC = {
    "elevation": "USGS 3DEP elevation on the render grid (exportImage, bilinear), metres",
    "sky_view": "Sky-view factor (horizon-based AO: mean cos² of the horizon angle over 16 azimuths to 1.5 km), "
                "0 enclosed .. 255 open sky",
    "water": "Water mask 0..255: NAIP NDWI > 0.15 blobs (flat in the DEM, not on developed land) ∪ LANDFIRE open "
             "water (FBFM40 98), soft edges",
    "trees": "Trees: x, y(ground m), z, height_m, crown_radius_m, kind (0 conifer, 1 broadleaf, 2 shrub)",
    "burn_severity": "Sentinel-2 L2A dNBR = NBR(pre) - NBR(post) - unburned offset, unscaled; nodata -9999 "
                     "(also over LANDFIRE open water)",
}


class StaticLayerError(RuntimeError):
    """A required static layer (DEM or LANDFIRE fuels) could not be built."""

    def __init__(self, message: str):
        super().__init__(config.mask_secrets(message))


# ----------------------------------------------------------------------------------------------------------------
# Terrain
# ----------------------------------------------------------------------------------------------------------------
def fire_terrain(dem: np.ndarray, fire: Grid) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Fire-grid elevation (exact area mean of the render DEM), slope (rise/run) and aspect (downslope-facing)."""
    elev = terrain.area_resample(dem, fire.shape)
    slope, aspect = slope_aspect(elev, fire.res_m)
    return elev, slope, aspect


def check_grids(render: Grid, fire: Grid) -> None:
    """Both grids must cover the same AOI square (SPEC 4.1)."""
    same = (render.epsg == fire.epsg and render.center_e == fire.center_e and render.center_n == fire.center_n
            and render.extent_m == fire.extent_m)
    if not same:
        raise ValueError(f"render and fire grids differ in AOI: {render} vs {fire}")
    if fire.width % 4 or fire.height % 4:
        raise ValueError(f"fire grid {fire.width}x{fire.height} must be divisible by 4")


# ----------------------------------------------------------------------------------------------------------------
# Trees
# ----------------------------------------------------------------------------------------------------------------
def _lut(mapping: dict[int, float], default: float = 0.0) -> np.ndarray:
    lut = np.full(256, default, np.float32)
    for k, v in mapping.items():
        lut[k] = v
    return lut


_SHRUB_DEPTH_LUT = _lut(SHRUB_DEPTH_M)
_NOMINAL_SHRUB_LUT = _lut(NOMINAL_SHRUB_COVER)


def shrub_cover(fuel_code: np.ndarray, evc_cover: np.ndarray | None = None) -> np.ndarray:
    """Shrub cover 0-1 per fire cell: LANDFIRE EVC shrub cover where shrub-dominated, else 0.3 x the nominal cover
    of the fuel model (or the full nominal cover without EVC)."""
    code = np.asarray(fuel_code).astype(np.uint8)
    nominal = _NOMINAL_SHRUB_LUT[code]
    if evc_cover is None:
        return nominal
    evc = np.asarray(evc_cover, dtype=np.float32)
    return np.where(evc > 0, evc, 0.3 * nominal).astype(np.float32)


def tree_kind_rule(fuel_code: np.ndarray, ch_m: np.ndarray) -> np.ndarray:
    """SPEC 8.2 kind by fuel: FBFM 161-165 / 181-189 -> conifer; else broadleaf if CH >= 5 m; else shrub."""
    conifer = np.isin(np.asarray(fuel_code), CONIFER_CODES)
    return np.where(conifer, TREE_CONIFER, np.where(np.asarray(ch_m) >= 5.0, TREE_BROADLEAF, TREE_SHRUB)).astype(np.int8)


def generate_trees(
    fire: Grid,
    render: Grid,
    dem: np.ndarray,
    fuels: landfire.Fuels,
    *,
    evt_kind: np.ndarray | None = None,
    evc_cover: np.ndarray | None = None,
    max_trees: int = MAX_TREES,
    target: int = TREE_TARGET,
    seed: int = 0,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Tree/shrub instances ``(N, 6)`` float32: x, y (ground m, bilinear DEM), z, height_m, crown_radius_m, kind.

    Per fire cell, trees ~ Poisson(cc * k) jittered in the cell, height = CH x U(0.7, 1.1) (>= 3 m), crown radius =
    clamp(0.28 h, 1.5, 9); low shrubs ~ Poisson(shrub_cover * k_s) where cc = 0 (chaparral reads as scrub), height
    from the fuel-bed depth. k is tuned so the expected total is ``target`` and the total never exceeds
    ``max_trees``. Kind: :func:`tree_kind_rule`, refined by EVT physiognomy when given (conifer / hardwood / mixed
    / shrubland). The rows are shuffled, so any prefix is a uniform thinning (quality levels).
    """
    rng = np.random.default_rng(seed)
    code = np.asarray(fuels.fuel_code).astype(np.int32)
    cc = np.asarray(fuels.cc_frac, dtype=np.float64)
    ch = np.asarray(fuels.ch_m, dtype=np.float64)
    tree_w = np.where((cc > 0) & ~np.isin(code, NO_TREE_CODES), cc, 0.0)
    shrub_w = np.where((cc <= 0) & (code > 0) & ~np.isin(code, NO_SHRUB_CODES), shrub_cover(code, evc_cover), 0.0)
    sum_t, sum_s = float(tree_w.sum()), float(shrub_w.sum())
    stats: dict[str, Any] = {"count": 0, "conifer": 0, "broadleaf": 0, "shrub": 0, "k_tree": 0.0, "k_shrub": 0.0,
                             "evt": evt_kind is not None, "evc": evc_cover is not None}
    if sum_t + sum_s <= 0:
        return np.zeros((0, 6), np.float32), stats
    k0 = target / (sum_t + SHRUB_DENSITY * sum_s)
    n_shrub = min(SHRUB_DENSITY * sum_s * k0, SHRUB_SHARE_MAX * target) if sum_t > 0 else min(sum_s * k0, SHRUB_SHARE_MAX * target)
    k_cap = fire.res_m * fire.res_m * MAX_INSTANCES_PER_M2
    k_t = min((target - n_shrub) / sum_t, k_cap) if sum_t > 0 else 0.0
    k_s = min(n_shrub / sum_s, k_cap) if sum_s > 0 else 0.0
    n_t = rng.poisson(tree_w * k_t)
    n_s = rng.poisson(shrub_w * k_s)

    def place(counts: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        r, c = np.nonzero(counts)
        n = counts[r, c]
        rr, cc_ = np.repeat(r, n), np.repeat(c, n)
        x = (cc_ + rng.random(rr.size)) * fire.res_x - fire.extent_m / 2.0
        z = (rr + rng.random(rr.size)) * fire.res_y - fire.extent_m / 2.0
        return rr, cc_, x, z

    tr, tc, tx, tz = place(n_t)
    th = np.maximum(ch[tr, tc] * rng.uniform(0.7, 1.1, tr.size), 3.0)
    tkind = tree_kind_rule(code[tr, tc], ch[tr, tc])
    if evt_kind is not None:
        e = np.asarray(evt_kind)[tr, tc]
        chv = ch[tr, tc]
        tkind = np.where(e == landfire.EVT_KIND_CONIFER, TREE_CONIFER, tkind)
        tkind = np.where(e == landfire.EVT_KIND_BROADLEAF, np.where(chv >= 3.0, TREE_BROADLEAF, TREE_SHRUB), tkind)
        tkind = np.where(e == landfire.EVT_KIND_SHRUB, np.where(chv >= 5.0, TREE_BROADLEAF, TREE_SHRUB), tkind)
        mixed = e == landfire.EVT_KIND_MIXED
        tkind = tkind.astype(np.int8)
        tkind[mixed] = rng.integers(0, 2, int(mixed.sum()), dtype=np.int8)     # conifer or broadleaf
    sr, sc_, sx, sz = place(n_s)
    depth = _SHRUB_DEPTH_LUT[code[sr, sc_].astype(np.uint8)].astype(np.float64)
    sh = np.where(depth > 0, depth * rng.uniform(0.8, 1.5, sr.size), rng.uniform(0.6, 1.8, sr.size))
    sh = np.clip(sh, 0.4, 4.0)

    x = np.concatenate([tx, sx])
    z = np.concatenate([tz, sz])
    h = np.concatenate([th, sh])
    kind = np.concatenate([tkind.astype(np.float64), np.full(sr.size, float(TREE_SHRUB))])
    y = terrain.bilinear_at(dem, render, x, z)
    crown = np.clip(0.28 * h, 1.5, 9.0)
    pts = np.column_stack([x, y, z, h, crown, kind]).astype(np.float32)
    if len(pts) > max_trees:
        pts = pts[rng.choice(len(pts), max_trees, replace=False)]
    else:
        pts = pts[rng.permutation(len(pts))]
    k = pts[:, 5]
    stats.update(count=int(len(pts)), conifer=int((k == TREE_CONIFER).sum()), broadleaf=int((k == TREE_BROADLEAF).sum()),
                 shrub=int((k == TREE_SHRUB).sum()), k_tree=round(k_t, 3), k_shrub=round(k_s, 3))
    return pts, stats


def incident_seed(incident_id: str) -> int:
    """Deterministic RNG seed per incident (rebuilds place the same trees)."""
    return int(hashlib.sha1(incident_id.encode()).hexdigest()[:8], 16)


# ----------------------------------------------------------------------------------------------------------------
# Water, burn-scar windows
# ----------------------------------------------------------------------------------------------------------------
def build_water(dem: np.ndarray, render: Grid, fuel_code: np.ndarray,
                gnir: tuple[np.ndarray, np.ndarray] | None) -> tuple[np.ndarray, imagery.WaterStats]:
    """Water mask on the render grid from NAIP G/NIR (optional) and LANDFIRE open water (SPEC 8.2)."""
    open_water = imagery.open_water_render(fuel_code, render.shape)
    slope_r, _ = slope_aspect(dem, render.res_m)
    g, nir = gnir if gnir is not None else (None, None)
    if g is None:
        return imagery.water_mask(None, None, open_water)
    developed = imagery.developed_render(fuel_code, render.shape)
    return imagery.water_mask(g, nir, open_water, slope_r, dem, render.res_m, developed)


def dnbr_windows(ctx: BuildContext, now: int) -> tuple[tuple[int, int], tuple[int, int]]:
    """(pre, post) Sentinel-2 windows in epoch ms (SPEC 8.2): pre [start - 60 d, start - 1 d]; post
    [end + 3 d, end + 60 d] (historical, end = ctx.end_ms | contained | start + 14 d, capped at start + 60 d) or the
    last 10 days (live, not before start + 12 h). Both are clipped to ``now``."""
    start = int(ctx.summary.started_ms)
    pre = (start - DNBR_PRE_DAYS[0] * DAY_MS, start - DNBR_PRE_DAYS[1] * DAY_MS)
    if ctx.mode == "live":
        post = (max(now - DNBR_LIVE_DAYS * DAY_MS, start + 12 * HOUR_MS), now)
    else:
        end = ctx.end_ms or ctx.summary.contained_ms or (start + DEFAULT_DURATION_D * DAY_MS)
        end = min(max(int(end), start), start + END_CAP_D * DAY_MS)
        post = (end + DNBR_POST_DAYS[0] * DAY_MS, min(end + DNBR_POST_DAYS[1] * DAY_MS, now))
    return pre, post


# ----------------------------------------------------------------------------------------------------------------
# LANDFIRE fetch with fallbacks
# ----------------------------------------------------------------------------------------------------------------
@dataclass
class FuelsFetch:
    raw: dict[str, np.ndarray]
    infos: dict[str, FetchInfo]
    edition: str
    seasonal: str | None                       # seasonal FBFM40 product actually used
    evt_table: dict[int, tuple[str, str]] | None = None
    notes: list[str] = field(default_factory=list)       # -> "LANDFIRE:" warnings
    veg_notes: list[str] = field(default_factory=list)   # -> "Trees:" warnings


def fetch_fuels(fire: Grid, edition: str, seasonal: str | None = None) -> FuelsFetch:
    """Core LANDFIRE layers (required; the next OLDER edition is tried once before giving up, never a newer one:
    CONTRACT 14.12.3) plus EVT, EVC and the EVT attribute table (optional, fetched concurrently)."""
    veg_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="landfire-veg")
    veg_futs = {name: veg_pool.submit(landfire.fetch_layer, fire, edition, name) for name in landfire.VEG_LAYERS}
    table_fut = veg_pool.submit(landfire.fetch_evt_physiognomy)
    notes: list[str] = []
    try:
        try:
            raw, infos, n = landfire.fetch_landfire_info(fire, edition, landfire.CORE_LAYERS, seasonal)
            notes += n
        except RasterFetchError as e:
            alt = landfire.older_edition(edition)
            if alt is None:
                raise StaticLayerError(f"LANDFIRE fuels unavailable: {e}") from None
            try:
                raw, infos, _ = landfire.fetch_landfire_info(fire, alt, landfire.CORE_LAYERS)
            except RasterFetchError:
                raise StaticLayerError(f"LANDFIRE fuels unavailable: {e}") from None
            if isinstance(e, landfire.LandfireNoData):      # no data at all here (not a failure): CONTRACT 14.12.3
                notes.append(landfire.switch_warning(edition, alt, 1.0))
            else:
                notes.append(f"{edition} unavailable ({e}); used {alt} instead")
            edition = alt
            veg_futs = {name: veg_pool.submit(landfire.fetch_layer, fire, edition, name) for name in landfire.VEG_LAYERS}
        used_seasonal = seasonal if seasonal and "Seasonal_Fuels" in infos["FBFM40"].url else None
        out = FuelsFetch(raw, infos, edition, used_seasonal, notes=notes)
        for name, f in veg_futs.items():
            try:
                out.raw[name], out.infos[name] = f.result()
            except RasterFetchError as e:
                out.veg_notes.append(f"LANDFIRE {name} unavailable ({e})")
        if "EVT" in out.raw:
            try:
                out.evt_table, out.infos["EVT table"] = table_fut.result()
            except RasterFetchError as e:
                out.veg_notes.append(str(e))
        return out
    finally:
        veg_pool.shutdown(wait=False, cancel_futures=True)


LAND_MIN_ELEV_M = 0.5            # 3DEP answers ~0 m over the sea: such cells are not land for the NoData rule
LAND_STRIDE = 4                  # the state-polygon test runs on every 4th cell (then nearest-neighbour upsampled)


def land_masks(fire: Grid, elev: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """``(land, abroad)`` on the fire grid (CONTRACT 14.12.3): ``land`` = inside the lower-48 + DC state polygons
    with ground above sea level; ``abroad`` = ground above sea level outside them (Mexico, Canada). Without the
    regions data every cell above sea level counts as land."""
    above = np.asarray(elev) > LAND_MIN_ELEV_M
    try:
        from .. import regions

        r = np.arange(0, fire.height, LAND_STRIDE)
        c = np.arange(0, fire.width, LAND_STRIDE)
        rr, cc = np.meshgrid(r, c, indexing="ij")
        x, z = fire.pixel_center_local(rr.ravel(), cc.ravel())
        lon, lat = fire.local_to_lonlat(np.asarray(x), np.asarray(z))
        inside = np.asarray(regions.in_lower48(lon, lat), dtype=bool).reshape(rr.shape)
        inside = np.repeat(np.repeat(inside, LAND_STRIDE, axis=0), LAND_STRIDE, axis=1)[: fire.height, : fire.width]
    except Exception as e:  # noqa: BLE001 - no regions data: the NoData rule still runs on all ground
        log.warning("land mask without state polygons: %s", e)
        inside = np.ones(above.shape, dtype=bool)
    return inside & above, ~inside & above


def choose_fuels(fire: Grid, ff: "FuelsFetch", land: np.ndarray, progress: Any = None,
                 fetch: Any = None) -> tuple["FuelsFetch", list[str]]:
    """Switch the whole bundle to the next older edition while more than 2 % of the land cells have no fuel code
    (LANDFIRE 2025 is not released in much of the South and East): CONTRACT 14.12.3. Returns the fetch used and the
    "LANDFIRE:" notes (e.g. "LANDFIRE 2025 is not released here yet; LANDFIRE 2024 used")."""
    fetch = fetch or fetch_fuels
    notes: list[str] = []
    frac = landfire.nodata_land_fraction(ff.raw["FBFM40"], land)
    while frac > landfire.NODATA_SWITCH_FRAC:
        older = landfire.older_edition(ff.edition)
        if older is None:
            notes.append(f"LANDFIRE {ff.edition[2:]} has no fuel data for {frac:.0%} of the land here and no older "
                         "edition is available; those cells are simulated as non-burnable (unknown, not low)")
            break
        if progress is not None:
            progress("fuels", 0.3, f"LANDFIRE {ff.edition} has no data for {frac:.0%} of the land; fetching {older}")
        try:
            nxt = fetch(fire, older, None)
        except StaticLayerError as e:
            notes.append(f"LANDFIRE {ff.edition[2:]} has no fuel data for {frac:.0%} of the land here; {older} "
                         f"unavailable ({e})")
            break
        notes.append(landfire.switch_warning(ff.edition, older, frac))
        ff, frac = nxt, landfire.nodata_land_fraction(nxt.raw["FBFM40"], land)
    return ff, notes


# ----------------------------------------------------------------------------------------------------------------
# Manifest helpers
# ----------------------------------------------------------------------------------------------------------------
def _source(name: str, detail: str, fetched_ms: int) -> dict:
    return {"name": name, "detail": detail, "fetched_ms": int(fetched_ms)}


def _set_grid(bdir: Path, render: Grid, fire: Grid, lo: float, hi: float) -> None:
    def fn(m: dict) -> None:
        g = m.get("grid")
        if not isinstance(g, dict) or "render" not in g:
            g = manifest_grid(render, fire, lo, hi)
        g["elev_min_m"], g["elev_max_m"] = float(lo), float(hi)
        m["grid"] = g

    bundle.update_manifest(bdir, fn)


def _finish_manifest(bdir: Path, edition: str, sources: list[dict], warnings: list[str]) -> None:
    def fn(m: dict) -> None:
        m["fuels_edition"] = edition
        keep = [d for d in m.get("data_sources") or [] if not str(d.get("name", "")).startswith(SOURCE_PREFIXES)]
        m["data_sources"] = keep + sources
        kept_w = [w for w in m.get("warnings") or [] if not str(w).startswith(WARNING_PREFIXES)]
        m["warnings"] = kept_w + [config.mask_secrets(w) for w in warnings]

    bundle.update_manifest(bdir, fn)


# ----------------------------------------------------------------------------------------------------------------
# Main entry
# ----------------------------------------------------------------------------------------------------------------
def build_static_layers(ctx: BuildContext) -> None:
    """Write elevation, fuel, canopy_cover, canopy_height, naip, sky_view, water, trees, burn_severity (optional)
    and ``sim/static.npz``; register each layer and update ``grid.elev_min_m/elev_max_m``, ``fuels_edition``,
    ``data_sources`` and ``warnings`` in the manifest."""
    build_static_layers_stats(ctx)


def build_static_layers_stats(ctx: BuildContext) -> dict[str, Any]:
    """:func:`build_static_layers`, returning statistics and per-step timings (for logs and verification)."""
    t_all = time.monotonic()
    render, fire = ctx.render_grid, ctx.fire_grid
    check_grids(render, fire)
    bdir = Path(ctx.bundle_dir)
    bdir.mkdir(parents=True, exist_ok=True)
    now = int(ctx.now_ms or now_ms())
    started = getattr(ctx.summary, "started_ms", None)
    edition = landfire.edition_for(ctx.mode, int(started) if started is not None else None)
    seasonal = landfire.seasonal_fbfm40(now) if ctx.mode == "live" else None
    progress = ctx.progress
    warnings: list[str] = []
    if ctx.mode != "live" and started is not None and not landfire.has_prefire_edition(int(started)):
        warnings.append(f"LANDFIRE: the fire began before October 2023; {edition} may already show its own burn scar")
    sources: list[dict] = []
    stats: dict[str, Any] = {"timings_s": {}}
    tim = stats["timings_s"]
    pre_w, post_w = dnbr_windows(ctx, now)

    progress("terrain", 0.0, f"Fetching USGS 3DEP elevation ({render.width}² at {render.res_m:.1f} m)")
    pool = ThreadPoolExecutor(max_workers=5, thread_name_prefix="static")
    try:
        f_dem = pool.submit(terrain.fetch_dem_info, render)
        f_fuels = pool.submit(fetch_fuels, fire, edition, seasonal)
        f_naip = pool.submit(imagery.fetch_naip_info, render)
        f_gnir = pool.submit(imagery.fetch_naip_gnir, render)
        f_dnbr = pool.submit(sentinel.compute_dnbr, fire, pre_w, post_w)

        # ---- terrain ------------------------------------------------------------------------------------
        t0 = time.monotonic()
        try:
            dem, dem_info, filled = f_dem.result()
        except RasterFetchError as e:
            raise StaticLayerError(f"Elevation (USGS 3DEP DEM) unavailable: {e}") from None
        tim["dem_fetch"] = round(time.monotonic() - t0, 2)
        progress("terrain", 0.4, "Deriving slope, aspect and sky-view factor")
        t0 = time.monotonic()
        elev, slope, aspect = fire_terrain(dem, fire)
        lo, hi = float(dem.min()), float(dem.max())
        bundle.write_layer(bdir, "elevation", dem, "render", "m", DESC["elevation"])
        _set_grid(bdir, render, fire, lo, hi)
        svf = terrain.sky_view_uint8(dem, render.res_m)
        bundle.write_layer(bdir, "sky_view", svf, "render", "0-255", DESC["sky_view"])
        tim["terrain_derive"] = round(time.monotonic() - t0, 2)
        if filled:
            warnings.append(f"DEM: filled {filled} nodata cells from their nearest valid neighbours")
        sources.append(_source("USGS 3DEP DEM", f"3DEPElevation exportImage, {render.width}² at {render.res_m:.2f} m "
                                                f"(bilinear), {render.crs}", dem_info.fetched_ms))
        stats["terrain"] = {"elev_min_m": round(lo, 1), "elev_max_m": round(hi, 1), "filled": filled,
                            "slope_median": round(float(np.median(slope)), 3), "sky_view_min": int(svf.min()),
                            "sky_view_mean": round(float(svf.mean()), 1)}
        progress("terrain", 1.0, f"Elevation {lo:.0f}-{hi:.0f} m")

        # ---- fuels --------------------------------------------------------------------------------------
        progress("fuels", 0.0, f"Fetching LANDFIRE {edition} fuels and canopy ({fire.width}² at {fire.res_m:.1f} m)")
        t0 = time.monotonic()
        ff = f_fuels.result()
        land, abroad = land_masks(fire, elev)
        ff, switch_notes = choose_fuels(fire, ff, land, progress)
        warnings += [f"LANDFIRE: {n}" for n in switch_notes]
        edition = ff.edition
        tim["landfire_fetch"] = round(time.monotonic() - t0, 2)
        progress("fuels", 0.6, "Scaling fuels and canopy")
        fuels = landfire.scale_landfire(ff.raw)
        bundle.write_layer(bdir, "fuel", fuels.fuel_code, "fire", "FBFM40",
                           f"LANDFIRE {edition} FBFM40 fuel model codes{' (' + ff.seasonal + ' seasonal)' if ff.seasonal else ''}; 0 = nodata",
                           nodata=0)
        bundle.write_layer(bdir, "canopy_cover", fuels.cc_pct, "fire", "%", f"LANDFIRE {edition} canopy cover, percent")
        bundle.write_layer(bdir, "canopy_height", fuels.ch_m, "fire", "m", f"LANDFIRE {edition} canopy height, m")
        bundle.write_npz(bdir / bundle.STATIC_NPZ, fuel_model=fuels.fuel_model.astype(np.int16), slope=slope.astype(np.float32),
                         aspect=aspect.astype(np.float32), canopy_cover=fuels.cc_frac, canopy_height=fuels.ch_m,
                         canopy_base_height=fuels.cbh_m, canopy_bulk_density=fuels.cbd_kg_m3, elevation=elev.astype(np.float32),
                         res_m=np.float64(fire.res_m))
        warnings += [f"LANDFIRE: {n}" for n in ff.notes]
        if fuels.nodata_cells > 0.01 * fuels.fuel_code.size:
            warnings.append(f"LANDFIRE: {fuels.nodata_cells} fire-grid cells have no fuel code (simulated as non-burnable)")
        outside = int(((fuels.fuel_code == 0) & abroad).sum())
        if outside:
            warnings.append(f"LANDFIRE: {outside} fire-grid cells ({outside / fuels.fuel_code.size:.1%}) outside the "
                            f"United States are {landfire.OUTSIDE_COVERAGE}")
        layers_used = ", ".join(k for k in (*landfire.CORE_LAYERS, *landfire.VEG_LAYERS) if k in ff.raw)
        detail = f"{layers_used} exportImage, {fire.width}² at {fire.res_m:.2f} m (nearest)"
        if ff.seasonal:
            detail += f"; FBFM40 from LF2025 Seasonal Fuels {landfire.SEASONAL_FBFM40_YEAR} ({ff.seasonal})"
        sources.append(_source(f"LANDFIRE {edition}", detail, max(i.fetched_ms for i in ff.infos.values())))
        hist = landfire.fuel_histogram(fuels.fuel_code)
        stats["fuels"] = {"edition": edition, "seasonal": ff.seasonal, "histogram_top": dict(list(hist.items())[:10]),
                          "nodata_land_frac": round(landfire.nodata_land_fraction(ff.raw["FBFM40"], land), 4),
                          "outside_coverage_cells": outside,
                          "nodata_cells": fuels.nodata_cells, "burnable_frac": round(float((fuels.fuel_code > 100).mean()), 3),
                          "cc_mean_pct": round(float(fuels.cc_pct.mean()), 1), "ch_max_m": round(float(fuels.ch_m.max()), 1),
                          "cbd_max": round(float(fuels.cbd_kg_m3.max()), 3), "fixes": fuels.fixes}
        progress("fuels", 1.0, f"{len(hist)} fuel models, {100 * stats['fuels']['burnable_frac']:.0f}% burnable")

        # ---- imagery ------------------------------------------------------------------------------------
        progress("imagery", 0.0, "Fetching NAIP aerial imagery")
        t0 = time.monotonic()
        naip_note = ""
        try:
            img = f_naip.result()
            bundle.write_image_layer(bdir, "naip", img.jpeg, img.width, img.height,
                                     f"NAIP aerial photo (USGS NAIP ImageServer), {img.width} px = {render.extent_m / img.width:.1f} m/px")
            naip_note = f"{img.width}² JPEG ({render.extent_m / img.width:.1f} m/px{', 4 parallel quadrants' if any('quadrant' in n for n in img.notes) else ''})"
            if img.coverage < 0.98:
                warnings.append(f"NAIP: imagery covers {100 * img.coverage:.0f}% of the AOI (black elsewhere, e.g. ocean)")
            stats["naip"] = {"px": img.width, "bytes": len(img.jpeg), "coverage": round(img.coverage, 4), "notes": img.notes}
            naip_fetched = img.info.fetched_ms
        except RasterFetchError as e:
            warnings.append(f"NAIP: aerial imagery unavailable ({e}); terrain falls back to the fuel/canopy palette")
            bundle.remove_layer(bdir, "naip")
            naip_fetched = 0
        tim["naip"] = round(time.monotonic() - t0, 2)
        progress("imagery", 0.6, "Water mask (NAIP NDWI ∪ LANDFIRE open water)")
        t0 = time.monotonic()
        gnir = None
        try:
            g, nir, ginfo = f_gnir.result()
            gnir = (g, nir)
            naip_fetched = max(naip_fetched, ginfo.fetched_ms)
        except RasterFetchError as e:
            warnings.append(f"Water mask: NAIP NDWI unavailable ({e}); LANDFIRE open water (FBFM40 98) only")
        water, wst = build_water(dem, render, fuels.fuel_code, gnir)
        bundle.write_layer(bdir, "water", water, "render", "0-255", DESC["water"])
        tim["water"] = round(time.monotonic() - t0, 2)
        stats["water"] = {"water_px": wst.water_pixels, "ndwi_px": wst.ndwi_pixels, "open_water_px": wst.open_water_pixels,
                          "ndwi_valid_frac": round(wst.ndwi_valid_frac, 4)}
        if naip_note or gnir is not None:
            parts = ([naip_note] if naip_note else []) + ([f"water NDWI from G/NIR {render.width}²"] if gnir is not None else [])
            sources.append(_source("NAIP imagery", "USGSNAIPImagery exportImage: " + "; ".join(parts), naip_fetched or now_ms()))
        progress("imagery", 1.0, f"{wst.water_pixels} water pixels")

        # ---- trees --------------------------------------------------------------------------------------
        progress("trees", 0.0, "Placing trees from LANDFIRE canopy")
        t0 = time.monotonic()
        warnings += [f"Trees: {n}; using the FBFM40-based fallback" for n in ff.veg_notes]
        try:
            evt_kind = landfire.evt_tree_kind(ff.raw["EVT"], ff.evt_table) if ("EVT" in ff.raw and ff.evt_table) else None
            evc_cov = landfire.evc_shrub_cover(ff.raw["EVC"]) if "EVC" in ff.raw else None
            pts, tstats = generate_trees(fire, render, dem, fuels, evt_kind=evt_kind, evc_cover=evc_cov,
                                         seed=incident_seed(ctx.summary.id))
            bundle.write_layer(bdir, "trees", pts, "points", "m", DESC["trees"])
            stats["trees"] = tstats
        except Exception as e:  # trees are decoration: never fail the build for them
            log.exception("tree generation failed")
            warnings.append(f"Trees: generation failed ({type(e).__name__}: {e})")
            bundle.remove_layer(bdir, "trees")
            tstats = {"count": 0}
        tim["trees"] = round(time.monotonic() - t0, 2)
        progress("trees", 1.0, f"{tstats.get('count', 0)} trees")

        # ---- burn scar ----------------------------------------------------------------------------------
        progress("burn_scar", 0.0, "Sentinel-2 dNBR (pre/post-fire composites)")
        t0 = time.monotonic()
        try:
            dnbr, dinfo = f_dnbr.result()
        except Exception as e:  # network / GDAL surprises must not fail the build
            dnbr, dinfo = None, {"reason": f"{type(e).__name__}: {e}"}
        tim["dnbr"] = round(time.monotonic() - t0, 2)
        stats["dnbr"] = {k: v for k, v in dinfo.items() if k not in ("fetched_ms",)}
        if dnbr is not None:
            dnbr = np.where(fuels.fuel_code == 98, np.float32(sentinel.NODATA), dnbr).astype(np.float32)  # surf/foam noise
            bundle.write_layer(bdir, "burn_severity", dnbr, "fire", "dNBR", DESC["burn_severity"], nodata=sentinel.NODATA)
            used = lambda lst: ", ".join(f"{u['id']} ({u['cloud_pct']:.1f}% cloud)" for u in lst) or "-"  # noqa: E731
            sources.append(_source("Sentinel-2 L2A (Earth Search)",
                                   f"dNBR: pre {used(dinfo.get('pre', []))}; post {used(dinfo.get('post', []))}; "
                                   f"{100 * dinfo.get('valid_frac', 0):.1f}% valid", int(dinfo.get("fetched_ms") or now_ms())))
            valid = dnbr != sentinel.NODATA
            stats["dnbr"]["p50"] = round(float(np.median(dnbr[valid])), 3) if valid.any() else None
            stats["dnbr"]["p99"] = round(float(np.percentile(dnbr[valid], 99)), 3) if valid.any() else None
            progress("burn_scar", 1.0, f"dNBR from {len(dinfo.get('pre', []))}+{len(dinfo.get('post', []))} scenes")
        else:
            warnings.append(f"Burn severity: Sentinel-2 dNBR unavailable ({dinfo.get('reason') or 'unknown error'})")
            bundle.remove_layer(bdir, "burn_severity")
            progress("burn_scar", 1.0, "dNBR unavailable (see warnings)")
    except BaseException:
        pool.shutdown(wait=False, cancel_futures=True)
        raise
    pool.shutdown(wait=True)

    _finish_manifest(bdir, edition, sources, warnings)
    tim["total"] = round(time.monotonic() - t_all, 2)
    stats["warnings"] = warnings
    log.info("static layers for %s built in %.1f s (%s)", ctx.summary.id, tim["total"], tim)
    return stats


# ----------------------------------------------------------------------------------------------------------------
# Quick-look PNGs (verification aid, not part of the bundle)
# ----------------------------------------------------------------------------------------------------------------
FUEL_GROUP_COLORS = {   # first code of each FBFM40 group -> RGB (quick-looks only; the UI palette is lib/fuels.ts)
    91: (120, 110, 130), 92: (240, 240, 250), 93: (170, 200, 120), 98: (40, 90, 200), 99: (70, 70, 70),
    101: (236, 220, 120), 121: (196, 196, 90), 141: (186, 120, 60), 161: (110, 150, 70), 181: (40, 100, 50),
    201: (150, 60, 140),
}


def _fuel_rgb(code: np.ndarray) -> np.ndarray:
    lut = np.zeros((256, 3), np.uint8)
    starts = sorted(FUEL_GROUP_COLORS)
    for c in range(256):
        if c in (91, 92, 93, 98, 99):
            lut[c] = FUEL_GROUP_COLORS[c]
        elif c >= 101:
            base = max(s for s in starts if s <= c)
            shade = 1.0 - 0.06 * (c - base)
            lut[c] = np.clip(np.array(FUEL_GROUP_COLORS[base]) * shade, 0, 255)
    return lut[np.asarray(code).astype(np.uint8)]


def write_quicklooks(bdir: Path, out: Path, prefix: str) -> list[Path]:
    """Hillshade x sky-view, fuels, canopy, dNBR, water, NAIP (+ contour alignment check) and trees PNGs."""
    from PIL import Image, ImageDraw

    out.mkdir(parents=True, exist_ok=True)
    m = bundle.load_manifest(bdir) or {}
    lay = m.get("layers", {})
    dem = bundle.read_layer(bdir, "elevation", m)
    res = float(m["grid"]["render"]["res_m"])
    paths: list[Path] = []

    def save(a: np.ndarray, name: str, size: int = 1024, nearest: bool = False) -> None:
        im = Image.fromarray(np.ascontiguousarray(a).astype(np.uint8))
        if im.size != (size, size):
            im = im.resize((size, size), Image.NEAREST if nearest else Image.BILINEAR)
        p = out / f"{prefix}-{name}.png"
        im.save(p)
        paths.append(p)

    hs = terrain.hillshade(dem, res)
    svf = bundle.read_layer(bdir, "sky_view", m).astype(np.float32) / 255.0
    save(np.clip(hs * 0.75 + 0.25, 0, 1) * svf * 255.0, "hillshade-skyview")
    save(svf * 255.0, "skyview")
    hs_rgb = (np.clip(hs * 0.7 + 0.3, 0, 1)[..., None] * np.array([150, 150, 150])).astype(np.float32)

    fuel = bundle.read_layer(bdir, "fuel", m)
    shade = terrain.nearest_resample(hs, fuel.shape)[..., None] * 0.5 + 0.5
    save(_fuel_rgb(fuel) * shade, "fuels", nearest=True)
    cc = bundle.read_layer(bdir, "canopy_cover", m).astype(np.float32) / 100.0
    ch = bundle.read_layer(bdir, "canopy_height", m)
    can = np.stack([cc * 40 + 20, cc * 200 + 20, np.clip(ch / 40.0, 0, 1) * 255], -1)
    save(can, "canopy", nearest=True)
    if "burn_severity" in lay:
        d = bundle.read_layer(bdir, "burn_severity", m)
        ramp = np.select(
            [d == sentinel.NODATA, d < 0.1, d < 0.27, d < 0.44, d < 0.66],
            [0, 1, 2, 3, 4], 5)
        cols = np.array([[0, 0, 0], [60, 110, 60], [235, 230, 90], [245, 160, 50], [220, 50, 40], [130, 40, 160]], np.float32)
        base = terrain.nearest_resample(hs, d.shape)[..., None] * 120 + 40
        rgb = np.where((ramp <= 1)[..., None], base * np.array([0.8, 1.0, 0.8]), cols[ramp] * 0.85 + base * 0.15)
        save(rgb, "dnbr", nearest=True)
    if "water" in lay:
        w = bundle.read_layer(bdir, "water", m).astype(np.float32) / 255.0
        save(hs_rgb * (1 - w[..., None]) + w[..., None] * np.array([40, 120, 255]), "water")
    if "naip" in lay:
        with Image.open(bdir / lay["naip"]["file"]) as im:
            th = im.convert("RGB").resize((1024, 1024), Image.LANCZOS)
        th.save(out / f"{prefix}-naip.jpg", quality=88)
        paths.append(out / f"{prefix}-naip.jpg")
        a = np.asarray(th).astype(np.float32)
        step = 100.0 if (float(dem.max()) - float(dem.min())) > 600 else 25.0
        band = np.floor(dem / step)
        edge = (np.diff(band, axis=0, prepend=band[:1]) != 0) | (np.diff(band, axis=1, prepend=band[:, :1]) != 0)
        a[edge] = [255, 220, 60]
        if "water" in lay:
            wm = bundle.read_layer(bdir, "water", m) >= 128
            wedge = wm ^ np.roll(wm, 1, 0) | wm ^ np.roll(wm, 1, 1)
            a[wedge] = [255, 40, 200]
        save(a, "naip-contours")
    if "trees" in lay:
        pts = bundle.read_layer(bdir, "trees", m)
        img = Image.fromarray((hs_rgb * 0.45).astype(np.uint8))
        draw = ImageDraw.Draw(img)
        ext = float(m["grid"]["extent_m"])
        sel = pts[:: max(1, len(pts) // 40000)]
        colors = {0: (60, 200, 90), 1: (230, 200, 60), 2: (200, 110, 60)}
        for x, _, z, _, _, k in sel:
            px, py = (x / ext + 0.5) * 1024, (z / ext + 0.5) * 1024
            draw.point((px, py), fill=colors.get(int(k), (255, 255, 255)))
        p = out / f"{prefix}-trees.png"
        img.save(p)
        paths.append(p)
    return paths


# ----------------------------------------------------------------------------------------------------------------
# Standalone runner
# ----------------------------------------------------------------------------------------------------------------
def _main(argv: list[str] | None = None) -> int:
    import json

    from ..bundle import bundle_dir
    from ..contracts import IncidentSummary
    from ..grid import make_aoi
    from ..timeutil import iso_to_ms, time_origin_for

    ap = argparse.ArgumentParser(description="Build the static layers of one AOI (terrain agent dev runner).")
    ap.add_argument("--id", required=True, help="bundle id (directory under FIRE3D_DATA_DIR/incidents)")
    ap.add_argument("--name", required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--bbox", type=float, nargs=4, metavar=("W", "S", "E", "N"), default=None)
    ap.add_argument("--acres", type=float, default=None)
    ap.add_argument("--mode", choices=("historical", "live"), default="historical")
    ap.add_argument("--started", required=True, help="ISO start time")
    ap.add_argument("--contained", default=None, help="ISO containment time (historical)")
    ap.add_argument("--uid", default="00000000-0000-0000-0000-000000000000")
    ap.add_argument("--quicklook", type=Path, default=None, help="write quick-look PNGs to this directory")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    started = iso_to_ms(args.started)
    contained = iso_to_ms(args.contained) if args.contained else None
    summary = IncidentSummary(
        id=args.id, name=args.name, mode=args.mode, year=int(ms_to_iso(started)[:4]), calfire_uid=args.uid,
        started_ms=started, updated_ms=None, contained_ms=contained, acres=args.acres, percent_contained=None,
        is_active=args.mode == "live", county=None, location=None, admin_unit=None, url=None, lat=args.lat, lon=args.lon,
        detections_24h=None, bundle_status="building", bundle_built_ms=None,
    )
    render, fire = make_aoi(args.lon, args.lat, tuple(args.bbox) if args.bbox else None, args.mode, acres=args.acres)
    bdir = bundle_dir(args.id)
    t_last = [time.monotonic()]

    def progress(step: str, frac: float, msg: str) -> None:
        print(f"[{time.monotonic() - t_last[0]:6.1f}s] {step:9s} {frac:4.0%}  {msg}", flush=True)

    ctx = BuildContext(summary=summary, bundle_dir=bdir, render_grid=render, fire_grid=fire,
                       time_origin_ms=time_origin_for(started), mode=args.mode, progress=progress,
                       fire_bbox_lonlat=tuple(args.bbox) if args.bbox else None)
    print(f"AOI {render.crs} centre ({render.center_e:.0f}, {render.center_n:.0f}) extent {render.extent_m:.0f} m; "
          f"render {render.width}² @ {render.res_m:.2f} m; fire {fire.width}² @ {fire.res_m:.2f} m -> {bdir}")
    stats = build_static_layers_stats(ctx)
    print(json.dumps(stats, indent=1, default=str))
    if args.quicklook:
        for p in write_quicklooks(bdir, args.quicklook, args.id):
            print("quicklook", p)
    return 0


if __name__ == "__main__":
    sys.exit(_main())
