"""USGS 3DEP elevation, sky-view factor and shared raster helpers (SPEC 2, 8.2). Owner: terrain agent.

Shared by ``landfire.py`` / ``imagery.py`` / ``build/aoi.py``:
  * :func:`export_params` / :func:`fetch_export` - ArcGIS ImageServer ``exportImage`` straight onto a :class:`Grid`
    (bbox + size in the grid's UTM CRS), through the cached ``fire3d.http`` client. ArcGIS reports errors as JSON
    with HTTP 200, so every response is checked for the expected magic number; a bad body is evicted from the cache
    and retried once before :class:`RasterFetchError` is raised.
  * :func:`read_geotiff` - decode + validate (CRS, shape, transform alignment) a GeoTIFF for a grid.
  * :func:`area_resample` / :func:`nearest_resample` - exact area-weighted down-sampling and nearest up-sampling
    between grids that share one extent (render 1024² <-> fire M²).
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass
from typing import Any

import numpy as np
import orjson
from rasterio.io import MemoryFile
from scipy import ndimage

from .. import config, http
from ..grid import Grid

log = logging.getLogger(__name__)

DEM_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
STATIC_TTL_S = 90 * 86400.0          # terrain, fuels and imagery change rarely
DEM_TIMEOUT_S = 180.0
DEM_MIN_M, DEM_MAX_M = -500.0, 9000.0  # anything outside is treated as nodata
DEM_MAX_NODATA_FRAC = 0.5

SKY_VIEW_AZIMUTHS = 16
SKY_VIEW_MAX_DIST_M = 1500.0
SKY_VIEW_STEPS = 24

_TIFF_MAGIC = (b"II*\x00", b"MM\x00*")
_JPEG_MAGIC = b"\xff\xd8"


class RasterFetchError(RuntimeError):
    """A raster could not be fetched or failed validation (message is secret-free)."""

    def __init__(self, message: str):
        super().__init__(config.mask_secrets(message))


@dataclass
class FetchInfo:
    """Where a raster came from (for ``manifest.data_sources``)."""

    url: str            # masked display URL
    fetched_ms: int     # when the bytes were actually downloaded (cache hits keep the original time)
    from_cache: bool
    seconds: float      # wall time of this call


# ----------------------------------------------------------------------------------------------------------------
# ArcGIS ImageServer exportImage
# ----------------------------------------------------------------------------------------------------------------
def export_params(grid: Grid, fmt: str, **extra: Any) -> dict[str, Any]:
    """exportImage query parameters that put the image exactly on ``grid`` (bbox + size in the grid's CRS)."""
    minx, miny, maxx, maxy = grid.bounds
    p: dict[str, Any] = {
        "bbox": f"{minx:.3f},{miny:.3f},{maxx:.3f},{maxy:.3f}",
        "bboxSR": grid.epsg,
        "imageSR": grid.epsg,
        "size": f"{grid.width},{grid.height}",
        "format": fmt,
    }
    p.update({k: v for k, v in extra.items() if v is not None})
    p["f"] = "image"
    return p


def _arcgis_error(content: bytes) -> str | None:
    """The message of an ArcGIS JSON error body, if ``content`` is one."""
    head = content[:1].strip()
    if head not in (b"{", b"["):
        return None
    try:
        j = orjson.loads(content)
    except orjson.JSONDecodeError:
        return "unparseable JSON body"
    err = j.get("error") if isinstance(j, dict) else None
    if isinstance(err, dict):
        details = "; ".join(str(d) for d in (err.get("details") or []) if d)
        msg = f"server error {err.get('code', '?')}: {err.get('message', 'unknown')}"
        return f"{msg} ({details})" if details else msg
    return "unexpected JSON body"


def content_problem(content: bytes, kind: str) -> str | None:
    """None if ``content`` looks like a ``kind`` ("tiff" | "jpeg") image, else a short description."""
    if not content:
        return "empty response"
    ok = content[:4] in _TIFF_MAGIC if kind == "tiff" else content[:2] == _JPEG_MAGIC
    if ok:
        return None
    err = _arcgis_error(content)
    if err:
        return err
    snippet = content[:80].decode("utf-8", errors="replace").strip().replace("\n", " ")
    return f"expected {kind.upper()} data, got {len(content)} bytes starting {snippet!r}"


def evict_cached(url: str, params: Any) -> None:
    """Drop a cached response (used when a 200 response turned out to be an error body)."""
    key = http.cache_key("GET", url, params)
    paths_fn = getattr(http, "_cache_paths", None)
    if paths_fn is None:
        return
    for p in paths_fn(key):
        try:
            p.unlink()
        except FileNotFoundError:
            pass


def fetch_export(
    url: str,
    params: dict[str, Any],
    *,
    kind: str,
    what: str,
    timeout: float,
    ttl_s: float | None = STATIC_TTL_S,
    attempts: int = 2,
    retries: int = http.DEFAULT_RETRIES,
) -> tuple[bytes, FetchInfo]:
    """GET an exportImage (cached) and check it is a ``kind`` image; raises :class:`RasterFetchError`.

    ``retries`` are transport-level (5xx, timeouts) inside ``fire3d.http``; ``attempts`` re-request after a 200
    response that turned out to be an ArcGIS error body."""
    t0 = time.monotonic()
    last = "no attempt"
    for attempt in range(attempts):
        try:
            resp = http.request("GET", url, params=params, ttl_s=ttl_s, timeout=timeout, retries=retries)
        except http.HttpError as e:
            raise RasterFetchError(f"{what}: {e}") from None
        problem = content_problem(resp.content, kind)
        if problem is None:
            return resp.content, FetchInfo(resp.url, resp.fetched_ms, resp.from_cache, time.monotonic() - t0)
        last = problem
        evict_cached(url, params)
        if attempt + 1 < attempts:
            log.warning("%s: %s; retrying", what, problem)
            time.sleep(2.0)
    raise RasterFetchError(f"{what}: {last} ({http.display_url(url, params)})")


def read_geotiff(content: bytes, grid: Grid, *, what: str) -> tuple[np.ndarray, float | None]:
    """Decode a GeoTIFF and check it sits exactly on ``grid``: returns ``(array (bands, H, W), nodata)``."""
    try:
        with MemoryFile(content) as mf, mf.open() as ds:
            epsg = ds.crs.to_epsg() if ds.crs is not None else None
            if epsg != grid.epsg:
                raise RasterFetchError(f"{what}: CRS {ds.crs} differs from EPSG:{grid.epsg}")
            if (ds.height, ds.width) != grid.shape:
                raise RasterFetchError(f"{what}: shape {(ds.height, ds.width)} differs from {grid.shape}")
            t, g = ds.transform, grid.transform
            tol = 0.01 * grid.res_m
            if abs(t.c - g.c) > tol or abs(t.f - g.f) > tol or abs(t.a - g.a) > 1e-6 * abs(g.a) or abs(t.e - g.e) > 1e-6 * abs(g.e) or abs(t.b) > 1e-9 or abs(t.d) > 1e-9:
                raise RasterFetchError(f"{what}: transform {tuple(t)[:6]} is not aligned with the grid {tuple(g)[:6]}")
            return ds.read(), ds.nodata
    except RasterFetchError:
        raise
    except Exception as e:  # rasterio errors on corrupt data
        raise RasterFetchError(f"{what}: unreadable GeoTIFF ({type(e).__name__}: {e})") from None


# ----------------------------------------------------------------------------------------------------------------
# DEM
# ----------------------------------------------------------------------------------------------------------------
def dem_params(grid: Grid) -> dict[str, Any]:
    return export_params(grid, "tiff", pixelType="F32", interpolation="RSP_BilinearInterpolation")


def clean_dem(arr: np.ndarray, nodata: float | None = None) -> tuple[np.ndarray, int]:
    """Replace nodata / non-finite / out-of-range cells by their nearest valid neighbour.

    Returns ``(float32 array, number of filled cells)``; raises if more than half the cells are invalid.
    (3DEP returns ~0 m over the ocean, which is valid sea level.)
    """
    a = np.asarray(arr, dtype=np.float32)
    bad = ~np.isfinite(a) | (a < DEM_MIN_M) | (a > DEM_MAX_M)
    if nodata is not None and np.isfinite(nodata):
        bad |= a == np.float32(nodata)
    n = int(bad.sum())
    if n > DEM_MAX_NODATA_FRAC * a.size:
        raise RasterFetchError(f"DEM: {100.0 * n / a.size:.0f}% of cells are nodata (AOI outside 3DEP coverage?)")
    if n:
        idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
        a = a[tuple(idx)]
    return np.ascontiguousarray(a, dtype=np.float32), n


def fetch_dem_info(grid: Grid) -> tuple[np.ndarray, FetchInfo, int]:
    """3DEP DEM on ``grid`` plus provenance and the number of nodata cells that were filled."""
    content, info = fetch_export(DEM_URL, dem_params(grid), kind="tiff", what="USGS 3DEP DEM", timeout=DEM_TIMEOUT_S)
    arr, nodata = read_geotiff(content, grid, what="USGS 3DEP DEM")
    dem, filled = clean_dem(arr[0], nodata)
    return dem, info, filled


def fetch_dem(grid: Grid) -> np.ndarray:
    """3DEP DEM resampled onto ``grid`` (exportImage in the grid's UTM CRS): float32 (H, W) metres, row 0 north."""
    return fetch_dem_info(grid)[0]


# ----------------------------------------------------------------------------------------------------------------
# Resampling between grids that share one extent
# ----------------------------------------------------------------------------------------------------------------
def area_weights(n_src: int, n_dst: int) -> np.ndarray:
    """(n_dst, n_src) matrix of fractional overlaps of equal-width cells on the same interval, rows summing to 1."""
    src_edges = np.linspace(0.0, 1.0, n_src + 1)
    dst_edges = np.linspace(0.0, 1.0, n_dst + 1)
    lo = np.maximum(dst_edges[:-1, None], src_edges[None, :-1])
    hi = np.minimum(dst_edges[1:, None], src_edges[None, 1:])
    w = np.clip(hi - lo, 0.0, None)
    return w / w.sum(axis=1, keepdims=True)


def area_resample(arr: np.ndarray, out_shape: tuple[int, int]) -> np.ndarray:
    """Exact area-weighted average of a 2-D array onto ``out_shape`` covering the same extent (float32)."""
    a = np.asarray(arr, dtype=np.float64)
    wr = area_weights(a.shape[0], out_shape[0])
    wc = area_weights(a.shape[1], out_shape[1])
    return (wr @ a @ wc.T).astype(np.float32)


def nearest_resample(arr: np.ndarray, out_shape: tuple[int, int]) -> np.ndarray:
    """Nearest-neighbour resample (pixel centres) onto ``out_shape`` covering the same extent; keeps dtype."""
    a = np.asarray(arr)
    ri = np.minimum(((np.arange(out_shape[0]) + 0.5) * a.shape[0] / out_shape[0]).astype(np.int64), a.shape[0] - 1)
    ci = np.minimum(((np.arange(out_shape[1]) + 0.5) * a.shape[1] / out_shape[1]).astype(np.int64), a.shape[1] - 1)
    return a[np.ix_(ri, ci)]


def bilinear_at(arr: np.ndarray, grid: Grid, x: np.ndarray, z: np.ndarray) -> np.ndarray:
    """Bilinear sample of a ``grid`` raster at local (x, z) (edge-clamped), float32."""
    r, c = grid.local_to_rowcol(np.asarray(x, dtype=np.float64), np.asarray(z, dtype=np.float64))
    out = ndimage.map_coordinates(np.asarray(arr, dtype=np.float32), [np.asarray(r) - 0.5, np.asarray(c) - 0.5], order=1, mode="nearest")
    return out.astype(np.float32)


# ----------------------------------------------------------------------------------------------------------------
# Sky-view factor (horizon-based ambient occlusion)
# ----------------------------------------------------------------------------------------------------------------
def sky_view_factor(
    dem: np.ndarray,
    res_m: float,
    n_azimuths: int = SKY_VIEW_AZIMUTHS,
    max_dist_m: float = SKY_VIEW_MAX_DIST_M,
    n_steps: int = SKY_VIEW_STEPS,
) -> np.ndarray:
    """Sky-view factor 0..1 (1 = open sky): mean over ``n_azimuths`` of cos²(horizon angle).

    The horizon in each direction is the steepest elevation angle to terrain sampled at geometrically growing
    distances (1 px .. ``max_dist_m``); below-horizontal angles count as 0, so flat ground and summits get 1.
    Vectorized over shifted views of an edge-padded array (no per-pixel Python).
    """
    z = np.ascontiguousarray(dem, dtype=np.float32)
    h, w = z.shape
    max_px = max(1.0, float(max_dist_m) / float(res_m))
    radii = np.geomspace(1.0, max_px, max(2, int(n_steps)))
    pad = int(math.ceil(max_px)) + 1
    padded = np.pad(z, pad, mode="edge")
    acc = np.zeros_like(z)
    tmp = np.empty_like(z)
    max_tan = np.empty_like(z)
    for k in range(int(n_azimuths)):
        az = 2.0 * math.pi * k / n_azimuths
        de, dn = math.sin(az), math.cos(az)
        max_tan.fill(0.0)
        seen: set[tuple[int, int]] = set()
        for rad in radii:
            dc, dr = int(round(de * rad)), int(round(-dn * rad))     # row grows southward
            if (dr, dc) == (0, 0) or (dr, dc) in seen:
                continue
            seen.add((dr, dc))
            view = padded[pad + dr: pad + dr + h, pad + dc: pad + dc + w]
            np.subtract(view, z, out=tmp)
            tmp *= np.float32(1.0 / (math.hypot(dr, dc) * res_m))
            np.maximum(max_tan, tmp, out=max_tan)
        np.multiply(max_tan, max_tan, out=tmp)
        tmp += 1.0
        np.reciprocal(tmp, out=tmp)          # cos²(atan(t)) = 1 / (1 + t²)
        acc += tmp
    return acc / np.float32(n_azimuths)


def sky_view_uint8(dem: np.ndarray, res_m: float, **kw: Any) -> np.ndarray:
    """:func:`sky_view_factor` scaled to uint8 0 (enclosed) .. 255 (open sky)."""
    svf = sky_view_factor(dem, res_m, **kw)
    return (np.clip(svf, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def hillshade(dem: np.ndarray, res_m: float, azimuth_deg: float = 315.0, altitude_deg: float = 45.0) -> np.ndarray:
    """Lambertian hillshade 0..1 of a north-up DEM (sun from ``azimuth_deg`` clockwise from north)."""
    d_row, d_col = np.gradient(np.asarray(dem, dtype=np.float64), res_m, res_m)
    nx, ny, nz = -d_col, d_row, np.ones_like(d_col)        # normal of z(e, n): (-dz/de, -dz/dn, 1), dz/dn = -d_row
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    az, alt = math.radians(azimuth_deg), math.radians(altitude_deg)
    sx, sy, sz = math.sin(az) * math.cos(alt), math.cos(az) * math.cos(alt), math.sin(alt)
    return np.clip((nx * sx + ny * sy + nz * sz) / norm, 0.0, 1.0).astype(np.float32)
