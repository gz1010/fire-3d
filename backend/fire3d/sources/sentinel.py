"""Sentinel-2 L2A burn severity (dNBR) (SPEC 2, 8.2). Owner: terrain agent.

* Scenes come from Element84 Earth Search (STAC ``POST /v1/search``, cached through ``fire3d.http``).
* Bands are public COGs read straight onto the fire grid with rasterio ``WarpedVRT`` (GDAL ``/vsicurl/``):
  average resampling for reflectance (B08 ``nir`` 10 m, B12 ``swir22`` 20 m), nearest for ``scl``. Reads are
  cached per scene/band/grid under ``CACHE_DIR/sentinel`` so rebuilds don't download again.
* Each window becomes a best-pixel composite: passes (one satellite overpass = several MGRS tiles) are ranked by
  cloud cover (5 % bins), AOI coverage and closeness to the fire. Within a pass only pixels no earlier tile covered
  are read (tiles of one pass see the same clouds); later passes only fill pixels never observed clear (scene
  classes nodata/defective, cloud shadow, cloud, cirrus, snow = SCL 0, 1, 3, 8, 9, 10, 11 are masked, masks
  dilated by one cell). Compositing stops at 98 % observed, after 3 passes, or when a pass adds < 0.5 %.
  Pixels still missing then take any non-cloud value seen (SCL 2-7, including cells masked only by the dilation):
  winter terrain shadow is often classed as cloud shadow in every scene.
* Reflectance = DN * scale + offset from each asset's ``raster:bands`` (L2A has offset -0.1 since 2022) ONLY if
  the DNs really carry the +1000 offset. Earth Search COGs have it removed already while ``raster:bands`` still
  lists -0.1, and ``earthsearch:boa_offset_applied`` is not reliable either (items flagged false read water at
  15-300 DN, like flagged-true ones; checked on 11SLT 2024-11..2025-03). Applying it twice pushes dark land to
  <= 0 and inflates NBR differences ~3x. So: flag true -> no offset; otherwise the scene's darkest pixels decide
  (1st percentile of both bands >= 80 % of the offset in DN -> the offset is in the data -> apply it).
  NBR = (nir - swir22) / (nir + swir22); dNBR = NBR_pre - NBR_post - offset, where the offset is the mode of the
  dNBR histogram (the unburned majority; MTBS-style phenology correction). float32, nodata -9999.
"""

from __future__ import annotations

import hashlib
import io
import logging
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import numpy as np
from scipy import ndimage

from .. import config, http
from ..grid import WGS84, Grid, transformer
from ..timeutil import DAY_MS, iso_to_ms, ms_to_iso, now_ms

log = logging.getLogger(__name__)

STAC_URL = "https://earth-search.aws.element84.com/v1/search"
COLLECTION = "sentinel-2-l2a"
BANDS = ("nir", "swir22", "scl")
MAX_CLOUD_PCT = 20.0                     # SPEC 2 search filter
FALLBACK_CLOUD_PCT = 60.0                # retried when nothing passes the strict filter (pixels are cloud-masked anyway)
SCL_BAD = (0, 1, 3, 8, 9, 10, 11)        # nodata, saturated/defective, cloud shadow, cloud medium/high, cirrus, snow
NODATA = -9999.0
TARGET_FILL = 0.98                       # stop compositing once this fraction of the AOI was observed clear
MAX_PASSES = 3                           # satellite passes per window
MIN_PASS_GAIN = 0.005                    # stop when a further pass adds less than this fraction of the AOI
SCL_RELAXED = (2, 3, 4, 5, 6, 7)         # last resort for pixels never observed clear (terrain shadow flagged as 3)
OFFSET_MIN = 0.01                        # dNBR offsets smaller than this are not applied
MIN_VALID_FRAC = 0.25                    # dNBR with less valid area is reported as unavailable
MIN_SIGNAL = 0.02                        # nir + swir22 reflectance below this -> NBR undefined (water, deep shadow)
STAC_TTL_PAST_S = 30 * 86400.0
STAC_TTL_RECENT_S = 3600.0
MAX_CONCURRENT_READS = 4
READ_ATTEMPTS = 3

GDAL_ENV: dict[str, Any] = {
    "GDAL_HTTP_MULTIRANGE": "YES",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "GDAL_HTTP_TIMEOUT": "90",
    "GDAL_HTTP_CONNECTTIMEOUT": "20",
    "GDAL_HTTP_USERAGENT": config.USER_AGENT,
    "GDAL_CACHEMAX": 256,                 # MB; rasterio.Env requires an int here
}

_read_slots = threading.Semaphore(MAX_CONCURRENT_READS)
logging.getLogger("rasterio.session").setLevel(logging.WARNING)   # "boto3 not available" on every open


class SentinelError(RuntimeError):
    """dNBR could not be computed (message is secret-free)."""


@dataclass
class Asset:
    href: str
    scale: float = 1.0
    offset: float = 0.0
    nodata: float | None = 0.0


@dataclass
class Scene:
    """One Sentinel-2 L2A item (an MGRS tile on one pass)."""

    id: str
    t_ms: int
    cloud: float                         # eo:cloud_cover of the whole tile, %
    platform: str
    tile: str
    assets: dict[str, Asset]
    coverage: float = 1.0                # fraction of the AOI square inside the item footprint
    boa_offset_applied: bool | None = None   # earthsearch:boa_offset_applied (None = not stated)

    @property
    def acquisition(self) -> str:
        """Pass identifier: satellite + UTC day (tiles of one pass are acquired together)."""
        return f"{self.platform}:{ms_to_iso(self.t_ms)[:10]}"


Reader = Callable[[Scene, str, Grid], tuple[np.ndarray, int]]


# ----------------------------------------------------------------------------------------------------------------
# STAC search
# ----------------------------------------------------------------------------------------------------------------
def _band_asset(a: dict) -> Asset | None:
    href = a.get("href")
    if not href or not str(href).startswith("http"):
        return None
    rb = (a.get("raster:bands") or [{}])[0] or {}
    nod = rb.get("nodata", 0)
    return Asset(str(href), float(rb.get("scale", 1.0) or 1.0), float(rb.get("offset", 0.0) or 0.0), None if nod is None else float(nod))


def footprint_coverage(geometry: dict | None, grid: Grid) -> float:
    """Fraction of the AOI square covered by a GeoJSON (lon/lat) footprint; 1.0 if it cannot be computed."""
    if not geometry:
        return 1.0
    try:
        import shapely
        from shapely.geometry import box, shape

        tr = transformer(WGS84, grid.epsg)
        poly = shapely.transform(shape(geometry), lambda xy: np.column_stack(tr.transform(xy[:, 0], xy[:, 1])))
        aoi = box(*grid.bounds)
        return float(min(1.0, poly.intersection(aoi).area / aoi.area))
    except Exception as e:  # malformed geometry: don't drop the scene
        log.debug("footprint coverage failed: %s", e)
        return 1.0


def parse_scene(feature: dict, grid: Grid | None = None) -> Scene | None:
    """A :class:`Scene` from a STAC item, or None if it lacks the needed assets."""
    props = feature.get("properties") or {}
    assets = feature.get("assets") or {}
    parsed = {b: _band_asset(assets.get(b) or {}) for b in BANDS}
    if any(v is None for v in parsed.values()) or not props.get("datetime"):
        return None
    tile = f"{props.get('mgrs:utm_zone', '')}{props.get('mgrs:latitude_band', '')}{props.get('mgrs:grid_square', '')}"
    cov = footprint_coverage(feature.get("geometry"), grid) if grid is not None else 1.0
    applied = props.get("earthsearch:boa_offset_applied")
    return Scene(
        id=str(feature.get("id")),
        t_ms=iso_to_ms(props["datetime"]),
        cloud=float(props.get("eo:cloud_cover", 100.0) or 0.0),
        platform=str(props.get("platform", "sentinel-2")),
        tile=tile,
        assets=parsed,  # type: ignore[arg-type]
        coverage=cov,
        boa_offset_applied=applied if isinstance(applied, bool) else None,
    )


def search_scenes(grid: Grid, start_ms: int, end_ms: int, max_cloud: float = MAX_CLOUD_PCT, max_pages: int = 5) -> list[Scene]:
    """L2A items intersecting the AOI in [start_ms, end_ms] with tile cloud cover < ``max_cloud`` %."""
    w, s, e, n = grid.bbox_lonlat()
    body: dict[str, Any] = {
        "collections": [COLLECTION],
        "bbox": [round(w, 5), round(s, 5), round(e, 5), round(n, 5)],
        "datetime": f"{ms_to_iso(int(start_ms))}/{ms_to_iso(int(end_ms))}",
        "query": {"eo:cloud_cover": {"lt": float(max_cloud)}},
        "limit": 100,
    }
    ttl = STAC_TTL_RECENT_S if end_ms > now_ms() - 2 * DAY_MS else STAC_TTL_PAST_S
    scenes: dict[str, Scene] = {}
    req: dict[str, Any] | None = body
    url = STAC_URL
    for _ in range(max_pages):
        page = http.post_json(url, req, ttl_s=ttl, timeout=90.0)
        for f in page.get("features") or []:
            sc = parse_scene(f, grid)
            if sc is not None and sc.coverage > 0.005:
                scenes[sc.id] = sc
        nxt = next((lk for lk in page.get("links") or [] if lk.get("rel") == "next"), None)
        if not nxt or not page.get("features"):
            break
        url = nxt.get("href") or STAC_URL
        nb = nxt.get("body")
        if isinstance(nb, dict):
            req = {**body, **nb} if nxt.get("merge") else nb
        else:
            break
    return sorted(scenes.values(), key=lambda sc: sc.t_ms)


# ----------------------------------------------------------------------------------------------------------------
# Band reads (WarpedVRT onto the grid), cached
# ----------------------------------------------------------------------------------------------------------------
def grid_signature(grid: Grid) -> str:
    raw = f"{grid.epsg}:{grid.center_e:.3f}:{grid.center_n:.3f}:{grid.extent_m:.3f}:{grid.width}x{grid.height}"
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def _cache_file(scene_id: str, band: str, grid: Grid) -> Path:
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in scene_id)
    return Path(config.CACHE_DIR) / "sentinel" / grid_signature(grid) / f"{safe}_{band}.npz"


def warp_read(href: str, grid: Grid, band: str, nodata: float | None = 0.0) -> np.ndarray:
    """Read one COG band onto ``grid`` (average for reflectance, nearest for ``scl``); 0 outside the tile."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.vrt import WarpedVRT

    resampling = Resampling.nearest if band == "scl" else Resampling.average
    nod = 0 if nodata is None else nodata
    last: Exception | None = None
    for attempt in range(READ_ATTEMPTS):
        try:
            with _read_slots, rasterio.Env(**GDAL_ENV), rasterio.open(href) as src:
                with WarpedVRT(src, crs=grid.crs, transform=grid.transform, width=grid.width, height=grid.height,
                               resampling=resampling, src_nodata=nod, nodata=nod) as vrt:
                    arr = vrt.read(1)
            if arr.shape != grid.shape:
                raise SentinelError(f"{band}: read shape {arr.shape} != {grid.shape}")
            return arr
        except SentinelError:
            raise
        except Exception as e:  # rasterio/GDAL HTTP errors
            last = e
            if attempt + 1 < READ_ATTEMPTS:
                time.sleep(2.0 * (attempt + 1))
    raise SentinelError(f"{band}: COG read failed ({type(last).__name__}: {config.mask_secrets(last)})")


def read_scene_band(scene: Scene, band: str, grid: Grid) -> tuple[np.ndarray, int]:
    """``(array on grid, fetched_ms)`` for one band of a scene, from the disk cache when possible."""
    path = _cache_file(scene.id, band, grid)
    if path.is_file():
        try:
            with np.load(path) as z:
                return z["a"], int(z["fetched_ms"])
        except Exception:
            path.unlink(missing_ok=True)
    arr = warp_read(scene.assets[band].href, grid, band, scene.assets[band].nodata)
    fetched = now_ms()
    buf = io.BytesIO()
    np.savez_compressed(buf, a=arr, fetched_ms=np.int64(fetched))
    try:
        http.atomic_write_bytes(path, buf.getvalue())
    except OSError as e:  # a full disk must not fail the build
        log.warning("sentinel cache write failed: %s", e)
    return arr, fetched


# ----------------------------------------------------------------------------------------------------------------
# Compositing and dNBR
# ----------------------------------------------------------------------------------------------------------------
def offset_in_dn(dns: list[np.ndarray], assets: list[Asset], boa_offset_applied: bool | None) -> bool:
    """True if the DNs still carry the +offset, i.e. the declared negative offset must be applied (see module
    docstring). Decided per scene from the darkest pixels of all bands; a ``True`` flag means already removed."""
    neg = [(d, a) for d, a in zip(dns, assets) if a.offset < 0]
    if not neg or boa_offset_applied is True:
        return False
    p1s, thresholds = [], []
    for d, a in neg:
        v = np.asarray(d)
        v = v[(v > 0) if a.nodata is None else ((v != a.nodata) & (v > 0))]
        if v.size < 100:
            return True                       # too little data to tell: trust the declared offset
        p1s.append(float(np.percentile(v, 1)))
        thresholds.append(0.8 * (-a.offset) / a.scale)
    return min(p1s) >= min(thresholds)


def effective_offsets(dns: list[np.ndarray], assets: list[Asset], boa_offset_applied: bool | None) -> list[float]:
    """Per-band additive offsets to use: the declared ones, with negative offsets dropped unless
    :func:`offset_in_dn` says the data carry them."""
    carried = offset_in_dn(dns, assets, boa_offset_applied)
    return [a.offset if (a.offset >= 0 or carried) else 0.0 for a in assets]


def to_reflectance(dn: np.ndarray, asset: Asset, offset: float | None = None) -> np.ndarray:
    """DN -> surface reflectance (float32) = DN * scale + offset (``offset`` defaults to the asset's); NaN where
    DN is nodata."""
    a = np.asarray(dn)
    off = asset.offset if offset is None else offset
    r = a.astype(np.float32) * np.float32(asset.scale) + np.float32(off)
    if asset.nodata is not None:
        r[a == asset.nodata] = np.nan
    return r


def nbr(nir: np.ndarray, swir: np.ndarray) -> np.ndarray:
    """Normalized Burn Ratio (float32); NaN where either input is NaN or nir + swir < MIN_SIGNAL."""
    s = nir + swir
    out = np.full(np.shape(nir), np.nan, np.float32)
    ok = np.isfinite(s) & (s >= MIN_SIGNAL)
    np.divide(nir - swir, s, out=out, where=ok)
    return np.clip(out, -1.0, 1.0)


def clear_mask(scl: np.ndarray, dilate: int = 1) -> np.ndarray:
    """True where the scene classification is usable (data, not cloud/shadow/cirrus/snow); masks dilated."""
    s = np.asarray(scl)
    bad = np.isin(s, SCL_BAD) & (s != 0)
    if dilate and bad.any():
        bad = ndimage.binary_dilation(bad, iterations=dilate)
    return (s != 0) & ~bad


def rank_acquisitions(scenes: list[Scene], ref_ms: int) -> list[list[Scene]]:
    """Group tiles by pass; order passes by cloud cover (5 % bins), AOI coverage, then |t - ref_ms|."""
    groups: dict[str, list[Scene]] = {}
    for sc in scenes:
        groups.setdefault(sc.acquisition, []).append(sc)

    def key(g: list[Scene]) -> tuple[float, float, float]:
        wsum = sum(max(s.coverage, 1e-6) for s in g)
        cloud = sum(s.cloud * max(s.coverage, 1e-6) for s in g) / wsum
        cov = min(1.0, sum(s.coverage for s in g))
        dt = abs(sum(s.t_ms for s in g) / len(g) - ref_ms)
        return (math.floor(cloud / 5.0), -math.floor(cov * 4.0 + 1e-9), dt)

    ranked = sorted(groups.values(), key=key)
    return [sorted(g, key=lambda s: -s.coverage) for g in ranked]


@dataclass
class Composite:
    nbr: np.ndarray                       # float32, NaN where no clear data (or NBR undefined, e.g. water)
    used: list[dict] = field(default_factory=list)
    fill_frac: float = 0.0                # fraction of the AOI observed clear
    shadow_filled_frac: float = 0.0       # fraction filled by the last-resort (SCL_RELAXED) pass
    passes: int = 0
    fetched_ms: int = 0


def composite_nbr(grid: Grid, scenes: list[Scene], ref_ms: int, reader: Reader | None = None,
                  max_passes: int = MAX_PASSES, target: float = TARGET_FILL, min_gain: float = MIN_PASS_GAIN) -> Composite:
    """Best-pixel NBR composite of ``scenes`` on ``grid`` (see module docstring); ``reader`` defaults to
    :func:`read_scene_band` (looked up at call time)."""
    reader = reader if reader is not None else read_scene_band
    out = np.full(grid.shape, np.nan, np.float32)
    observed = np.zeros(grid.shape, bool)
    comp = Composite(out)
    shadow: list[tuple[np.ndarray, np.ndarray]] = []
    for group in rank_acquisitions(scenes, ref_ms):
        if observed.mean() >= target or comp.passes >= max_passes:
            break
        comp.passes += 1
        before = int(observed.sum())
        seen = np.zeros(grid.shape, bool)              # pixels with data from this pass's earlier tiles
        for sc in group:
            if seen.mean() > 0.999 or not (~observed & ~seen).any():
                break
            scl, t_scl = reader(sc, "scl", grid)
            fresh = (scl != 0) & ~seen
            seen |= scl != 0
            need = clear_mask(scl) & fresh & ~observed
            relax = np.isin(scl, SCL_RELAXED) & fresh & ~observed & ~need     # last-resort candidates
            if not need.any() and not relax.any():
                continue
            with ThreadPoolExecutor(max_workers=2) as pool:
                fn = pool.submit(reader, sc, "nir", grid)
                fs = pool.submit(reader, sc, "swir22", grid)
                (dn_n, t_n), (dn_s, t_s) = fn.result(), fs.result()
            a_n, a_s = sc.assets["nir"], sc.assets["swir22"]
            off_n, off_s = effective_offsets([dn_n, dn_s], [a_n, a_s], sc.boa_offset_applied)
            v = nbr(to_reflectance(dn_n, a_n, off_n), to_reflectance(dn_s, a_s, off_s))
            good = need & np.isfinite(v)
            out[good] = v[good]
            observed |= need                          # observed clear, even where NBR is undefined (water)
            if relax.any():
                shadow.append((relax & np.isfinite(v), v))
            comp.fetched_ms = max(comp.fetched_ms, t_scl, t_n, t_s)
            comp.used.append({"id": sc.id, "date": ms_to_iso(sc.t_ms)[:10], "cloud_pct": round(sc.cloud, 2),
                              "filled_frac": round(float(good.mean()), 4), "offset": [off_n, off_s]})
        if comp.passes > 1 and int(observed.sum()) - before < min_gain * observed.size:
            break
    comp.fill_frac = float(observed.mean())
    filled_shadow = np.zeros(grid.shape, bool)
    for mask, v in shadow:
        add = mask & ~observed & ~filled_shadow
        out[add] = v[add]
        filled_shadow |= add
    comp.shadow_filled_frac = float(filled_shadow.mean())
    return comp


def unburned_offset(dnbr: np.ndarray) -> float:
    """Mode of the dNBR histogram in [-0.3, 0.3] (0.01 bins, smoothed): the unburned majority's dNBR, i.e. the
    phenology/illumination difference between the two composites. 0.0 if too few pixels."""
    d = np.asarray(dnbr)
    v = d[np.isfinite(d) & (d > -0.3) & (d < 0.3)]
    if v.size < 500:
        return 0.0
    hist, edges = np.histogram(v, bins=60, range=(-0.3, 0.3))
    hist = ndimage.gaussian_filter1d(hist.astype(np.float64), 1.5)
    i = int(np.argmax(hist))
    return float(0.5 * (edges[i] + edges[i + 1]))


def _window_scenes(grid: Grid, window: tuple[int, int]) -> tuple[list[Scene], float]:
    scenes = search_scenes(grid, window[0], window[1], MAX_CLOUD_PCT)
    if scenes:
        return scenes, MAX_CLOUD_PCT
    return search_scenes(grid, window[0], window[1], FALLBACK_CLOUD_PCT), FALLBACK_CLOUD_PCT


def compute_dnbr(grid: Grid, pre_window_ms: tuple[int, int], post_window_ms: tuple[int, int]) -> tuple[np.ndarray | None, dict]:
    """dNBR = NBR_pre - NBR_post on ``grid`` from the least-cloudy scenes in each window (float32, nodata -9999),
    minus the unburned offset (histogram mode, applied when >= 0.01; see module docstring).

    Returns ``(array or None, info)``; ``info`` lists the scenes used per window, fill fractions, the offset, or
    why it failed (``info["reason"]``).
    """
    t0 = time.monotonic()
    info: dict[str, Any] = {
        "pre_window": [ms_to_iso(pre_window_ms[0]), ms_to_iso(pre_window_ms[1])],
        "post_window": [ms_to_iso(post_window_ms[0]), ms_to_iso(post_window_ms[1])],
        "reason": None,
    }
    if post_window_ms[0] >= post_window_ms[1] or pre_window_ms[0] >= pre_window_ms[1]:
        info["reason"] = "empty imagery window (no post-fire acquisition time yet)"
        return None, info
    try:
        (pre_sc, pre_cloud), (post_sc, post_cloud) = _window_scenes(grid, pre_window_ms), _window_scenes(grid, post_window_ms)
    except http.HttpError as e:
        info["reason"] = f"STAC search failed: {e}"
        return None, info
    info["pre_candidates"], info["post_candidates"] = len(pre_sc), len(post_sc)
    for name, sc, win in (("pre-fire", pre_sc, info["pre_window"]), ("post-fire", post_sc, info["post_window"])):
        if not sc:
            info["reason"] = f"no {name} Sentinel-2 scene with < {FALLBACK_CLOUD_PCT:.0f}% cloud in {win[0][:10]}..{win[1][:10]}"
            return None, info
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            fpre = pool.submit(composite_nbr, grid, pre_sc, pre_window_ms[1])
            fpost = pool.submit(composite_nbr, grid, post_sc, post_window_ms[0])
            pre, post = fpre.result(), fpost.result()
    except SentinelError as e:
        info["reason"] = str(e)
        return None, info
    valid = np.isfinite(pre.nbr) & np.isfinite(post.nbr)
    raw = np.where(valid, pre.nbr - post.nbr, np.nan).astype(np.float32)
    offset = unburned_offset(raw)
    applied = offset if abs(offset) >= OFFSET_MIN else 0.0
    dnbr = np.where(valid, raw - np.float32(applied), np.float32(NODATA)).astype(np.float32)
    info.update(
        pre=pre.used, post=post.used, pre_fill=round(pre.fill_frac, 4), post_fill=round(post.fill_frac, 4),
        pre_passes=pre.passes, post_passes=post.passes,
        shadow_filled=[round(pre.shadow_filled_frac, 4), round(post.shadow_filled_frac, 4)],
        cloud_filter_pct=[pre_cloud, post_cloud], valid_frac=round(float(valid.mean()), 4),
        offset=round(applied, 4), offset_raw=round(offset, 4),
        fetched_ms=max(pre.fetched_ms, post.fetched_ms) or now_ms(), seconds=round(time.monotonic() - t0, 2),
    )
    if valid.mean() < MIN_VALID_FRAC:
        info["reason"] = f"only {100 * valid.mean():.0f}% of the AOI has cloud-free pre- and post-fire data"
        return None, info
    return dnbr, info
