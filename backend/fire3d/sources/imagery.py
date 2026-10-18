"""NAIP aerial imagery and the NAIP/LANDFIRE water mask (SPEC 2, 8.2). Owner: terrain agent.

* :func:`fetch_naip` (contract): true-colour JPEG from the USGS NAIP ImageServer ``exportImage`` covering the AOI
  square, ``size = min(max_px, max(2048, extent / 3))`` px (the service's default JPEG rendering is the raw
  R, G, B bands). Large images are fetched as four quadrant exports in parallel (a single 4000 px export takes
  ~75 s server-side) and stitched pixel-exactly. :func:`fetch_naip_info` adds provenance, a coverage check and
  smaller single-request retries.
* :func:`fetch_naip_gnir`: raw green + near-infrared bands (``bandIds=1,3``, uint8 GeoTIFF) on a grid.
* :func:`ndwi` / :func:`water_mask`: NDWI = (G - NIR) / (G + NIR) > ~0.15, unioned with LANDFIRE open water (FBFM40
  98) and slightly blurred for soft edges. NDWI alone also flags charred ground (old burn scars in the NAIP photo
  read NDWI ~0.35, water ~0.55) and shadowed steep slopes, so each NDWI blob must either touch open water or be
  flat in the DEM (3DEP hydro-flattens water: plane-fit gradient < 3 %, residual RMS < 1.5 m) and not mostly on
  LANDFIRE developed land (FBFM40 91: dark roofs, solar panels and asphalt also pass NDWI, and urban pools are
  sub-pixel); steep pixels are then trimmed.
"""

from __future__ import annotations

import dataclasses
import io
import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from PIL import Image
from scipy import ndimage

from ..grid import Grid
from .terrain import FetchInfo, RasterFetchError, export_params, fetch_export, nearest_resample, read_geotiff

log = logging.getLogger(__name__)

NAIP_URL = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage"
NAIP_MIN_PX = 2048
NAIP_MAX_PX = 4000                  # service maxImageWidth/Height
NAIP_JPEG_QUALITY = 85              # final JPEG (single export, or re-encoded mosaic)
NAIP_TILE_QUALITY = 92              # quadrant exports (re-encoded once at NAIP_JPEG_QUALITY)
NAIP_TILE_MIN_PX = 2560             # images at least this large are fetched as 2 x 2 quadrants
NAIP_TIMEOUT_S = 300.0
NAIP_BLACK_LEVEL = 3                # R, G and B all <= this -> no imagery (outside NAIP coverage)
NAIP_MIN_COVERAGE = 0.02            # fewer covered pixels than this -> treat as unavailable

NDWI_THRESHOLD = 0.15
NDWI_MIN_SIGNAL = 8                 # G + NIR below this (DN) is nodata / unreliable
WATER_MAX_SLOPE = 0.15              # rise/run; NDWI water pixels steeper than ~8.5 deg are trimmed (banks, shadow)
WATER_MAX_GRADIENT = 0.03           # NDWI blob plane-fit gradient limit (water surfaces are hydro-flattened)
WATER_MAX_RMS_M = 1.5               # NDWI blob plane-fit residual RMS limit, metres
WATER_MAX_DEVELOPED = 0.5           # NDWI blobs with more of their pixels on developed land (FBFM40 91) are rejected
WATER_MIN_PIXELS = 4                # NDWI-only blobs smaller than this (render pixels) are dropped as speckle
WATER_LAND_NDWI = -0.15             # FBFM40-98 pixels where NAIP clearly shows land are trimmed (blocky edges)
WATER_BLUR_PX = 0.8                 # gaussian sigma for soft edges, render pixels


def naip_size(extent_m: float, max_px: int = NAIP_MAX_PX) -> int:
    """SPEC 8.2: ``min(max_px, max(2048, extent / 3))`` px (square), rounded down to an even number so the image
    splits into equal quadrants."""
    s = int(min(int(max_px), max(NAIP_MIN_PX, math.ceil(float(extent_m) / 3.0))))
    return s - (s % 2)


def naip_params(grid: Grid, quality: int = NAIP_JPEG_QUALITY) -> dict[str, Any]:
    return export_params(grid, "jpg", interpolation="RSP_BilinearInterpolation", compressionQuality=int(quality))


def gnir_params(grid: Grid) -> dict[str, Any]:
    return export_params(
        grid, "tiff", bandIds="1,3", pixelType="U8", interpolation="RSP_BilinearInterpolation",
        renderingRule='{"rasterFunction":"None"}',
    )


@dataclass
class NaipImage:
    """A NAIP JPEG for the AOI square plus provenance."""

    jpeg: bytes
    width: int
    height: int
    coverage: float                     # fraction of pixels with imagery (not black nodata)
    info: FetchInfo
    notes: list[str] = field(default_factory=list)


def jpeg_coverage(jpeg: bytes, expect: tuple[int, int] | None = None) -> tuple[int, int, float]:
    """Decode a JPEG: ``(width, height, fraction of non-black pixels)``; raises on undecodable data / wrong size."""
    try:
        with Image.open(io.BytesIO(jpeg)) as im:
            im.load()
            w, h = im.size
            if expect is not None and (w, h) != tuple(expect):
                raise RasterFetchError(f"NAIP: image is {w}x{h}, expected {expect[0]}x{expect[1]}")
            small = np.asarray(im.convert("RGB").reduce(4) if min(w, h) >= 256 else im.convert("RGB"))
    except RasterFetchError:
        raise
    except Exception as e:  # PIL errors on truncated data
        raise RasterFetchError(f"NAIP: undecodable JPEG ({type(e).__name__}: {e})") from None
    covered = float((small.max(axis=2) > NAIP_BLACK_LEVEL).mean())
    return w, h, covered


def quadrants(grid: Grid, size: int) -> list[tuple[Grid, tuple[int, int]]]:
    """The 2 x 2 split of ``grid``'s square at ``size`` px: ``[(tile grid, (x, y) paste offset px)]``, NW first."""
    half, q = size // 2, grid.extent_m / 4.0
    out = []
    for j, dn in enumerate((q, -q)):            # row 0 = north
        for i, de in enumerate((-q, q)):        # col 0 = west
            g = dataclasses.replace(grid, center_e=grid.center_e + de, center_n=grid.center_n + dn,
                                    extent_m=grid.extent_m / 2.0, width=half, height=half)
            out.append((g, (i * half, j * half)))
    return out


def _fetch_single(grid: Grid, size: int) -> NaipImage:
    g = grid.with_size(size, size)
    content, info = fetch_export(NAIP_URL, naip_params(g), kind="jpeg", what=f"NAIP {size}px", timeout=NAIP_TIMEOUT_S)
    w, h, cov = jpeg_coverage(content, (size, size))
    return NaipImage(content, w, h, cov, info)


def _fetch_tiled(grid: Grid, size: int) -> NaipImage:
    t0 = time.monotonic()
    tiles = quadrants(grid, size)
    half = size // 2
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="naip") as pool:
        futs = [pool.submit(fetch_export, NAIP_URL, naip_params(g, NAIP_TILE_QUALITY), kind="jpeg",
                            what=f"NAIP {size}px quadrant {k + 1}/4", timeout=NAIP_TIMEOUT_S) for k, (g, _) in enumerate(tiles)]
        results = [f.result() for f in futs]
    canvas = Image.new("RGB", (size, size))
    for (_, offset), (content, _) in zip(tiles, results):
        try:
            with Image.open(io.BytesIO(content)) as im:
                if im.size != (half, half):
                    raise RasterFetchError(f"NAIP quadrant is {im.size[0]}x{im.size[1]}, expected {half}x{half}")
                canvas.paste(im.convert("RGB"), offset)
        except RasterFetchError:
            raise
        except Exception as e:
            raise RasterFetchError(f"NAIP quadrant: undecodable JPEG ({type(e).__name__}: {e})") from None
    buf = io.BytesIO()
    canvas.save(buf, "JPEG", quality=NAIP_JPEG_QUALITY)
    small = np.asarray(canvas.reduce(4))
    cov = float((small.max(axis=2) > NAIP_BLACK_LEVEL).mean())
    infos = [r[1] for r in results]
    info = FetchInfo(infos[0].url, max(i.fetched_ms for i in infos), all(i.from_cache for i in infos), time.monotonic() - t0)
    return NaipImage(buf.getvalue(), size, size, cov, info, ["fetched as 4 parallel quadrant exports"])


def fetch_naip_info(grid: Grid, max_px: int = NAIP_MAX_PX) -> NaipImage:
    """NAIP JPEG covering ``grid``'s square: quadrant mosaic for large sizes, then single-request fallbacks at
    smaller sizes if that fails. Raises :class:`RasterFetchError` when nothing works or there is no coverage."""
    size = naip_size(grid.extent_m, max_px)
    plans: list[tuple[str, int]] = []
    if size >= NAIP_TILE_MIN_PX and size % 2 == 0:
        plans.append(("tiled", size))
    else:
        plans.append(("single", size))
    plans += [("single", s) for s in (NAIP_MIN_PX, 1024) if s < size]
    errors: list[str] = []
    for kind, s in plans:
        try:
            img = _fetch_tiled(grid, s) if kind == "tiled" else _fetch_single(grid, s)
        except RasterFetchError as e:
            errors.append(str(e))
            log.warning("%s", e)
            continue
        if img.coverage < NAIP_MIN_COVERAGE:
            raise RasterFetchError(f"NAIP: no imagery over the AOI ({100 * img.coverage:.1f}% covered)")
        if errors:
            img.notes.append(f"retried at {s}px after: {errors[0]}")
        return img
    raise RasterFetchError("; ".join(errors) or "NAIP: no attempt")


def fetch_naip(grid: Grid, max_px: int = 4000) -> tuple[bytes, int, int]:
    """NAIP true-colour JPEG covering the AOI square: ``(jpeg_bytes, width, height)``, at most ``max_px`` square."""
    img = fetch_naip_info(grid, max_px)
    return img.jpeg, img.width, img.height


def fetch_naip_gnir(grid: Grid) -> tuple[np.ndarray, np.ndarray, FetchInfo]:
    """Raw NAIP green and NIR bands (uint8, (H, W) each) on ``grid`` (bandIds=1,3 TIFF; 0 = no imagery)."""
    content, info = fetch_export(NAIP_URL, gnir_params(grid), kind="tiff", what="NAIP green/NIR", timeout=NAIP_TIMEOUT_S)
    arr, _ = read_geotiff(content, grid, what="NAIP green/NIR")
    if arr.shape[0] != 2:
        raise RasterFetchError(f"NAIP green/NIR: expected 2 bands, got {arr.shape[0]}")
    if arr.dtype != np.uint8:
        arr = np.clip(arr, 0, 255).astype(np.uint8)
    return arr[0], arr[1], info


# ----------------------------------------------------------------------------------------------------------------
# Water mask
# ----------------------------------------------------------------------------------------------------------------
def ndwi(green: np.ndarray, nir: np.ndarray, min_signal: float = NDWI_MIN_SIGNAL) -> np.ndarray:
    """McFeeters NDWI = (G - NIR) / (G + NIR) as float32; NaN where G + NIR < ``min_signal`` (no imagery)."""
    g = np.asarray(green, dtype=np.float32)
    n = np.asarray(nir, dtype=np.float32)
    s = g + n
    out = np.full(g.shape, np.nan, dtype=np.float32)
    np.divide(g - n, s, out=out, where=s >= np.float32(min_signal))
    return out


@dataclass
class WaterStats:
    ndwi_pixels: int                    # NDWI water pixels kept
    open_water_pixels: int              # FBFM40-98 pixels (render grid) after trimming
    water_pixels: int                   # pixels >= 128 in the final mask
    ndwi_valid_frac: float              # fraction of the AOI with usable NAIP G/NIR


def blob_flatness(labels: np.ndarray, n: int, elevation: np.ndarray, res_m: float) -> tuple[np.ndarray, np.ndarray]:
    """Per-label plane fit of ``elevation`` over each labelled blob (vectorized): ``(gradient, residual RMS m)``,
    arrays of length ``n + 1`` (index 0 = background)."""
    r, c = np.nonzero(labels)
    lab = labels[r, c]
    z = np.asarray(elevation, dtype=np.float64)[r, c]
    x, y = c * float(res_m), r * float(res_m)
    w = np.bincount(lab, minlength=n + 1).astype(np.float64)
    wd = np.maximum(w, 1.0)
    dx = x - (np.bincount(lab, x, n + 1) / wd)[lab]
    dy = y - (np.bincount(lab, y, n + 1) / wd)[lab]
    dz = z - (np.bincount(lab, z, n + 1) / wd)[lab]
    sxx, syy, sxy = (np.bincount(lab, v, n + 1) for v in (dx * dx, dy * dy, dx * dy))
    sxz, syz = np.bincount(lab, dx * dz, n + 1), np.bincount(lab, dy * dz, n + 1)
    det = sxx * syy - sxy * sxy
    ok = det > 1e-6 * np.maximum(sxx * syy, 1e-12)
    with np.errstate(divide="ignore", invalid="ignore"):
        b = np.where(ok, (sxz * syy - syz * sxy) / det, np.where(sxx > 0, sxz / sxx, 0.0))
        cc = np.where(ok, (syz * sxx - sxz * sxy) / det, np.where(syy > 0, syz / syy, 0.0))
    b, cc = np.nan_to_num(b), np.nan_to_num(cc)
    resid = dz - b[lab] * dx - cc[lab] * dy
    rms = np.sqrt(np.bincount(lab, resid * resid, n + 1) / wd)
    return np.hypot(b, cc), rms


def water_mask(
    green: np.ndarray | None,
    nir: np.ndarray | None,
    open_water: np.ndarray | None,
    slope: np.ndarray | None = None,
    elevation: np.ndarray | None = None,
    res_m: float | None = None,
    developed: np.ndarray | None = None,
    *,
    threshold: float = NDWI_THRESHOLD,
    max_slope: float = WATER_MAX_SLOPE,
    min_pixels: int = WATER_MIN_PIXELS,
    blur_px: float = WATER_BLUR_PX,
) -> tuple[np.ndarray, WaterStats]:
    """Soft water mask uint8 0..255 on the render grid.

    ``green``/``nir``: NAIP bands (None -> open water only). ``open_water``: bool FBFM40 == 98 on the same grid.
    NDWI blobs (8-connected) are kept if they touch open water, or if they have >= ``min_pixels`` pixels, are
    flat in ``elevation`` (see :func:`blob_flatness`; skipped when no elevation is given) and lie mostly off
    ``developed`` land (bool, FBFM40 91); pixels steeper than ``max_slope`` (rise/run, from ``slope``) are then
    trimmed. Open-water pixels where NAIP clearly shows land are trimmed too (removes the blocky 30 m LANDFIRE
    edges at shorelines).
    """
    shape = (green if green is not None else open_water).shape
    ow = np.zeros(shape, bool) if open_water is None else np.asarray(open_water, bool)
    core = np.zeros(shape, bool)
    valid_frac = 0.0
    if green is not None and nir is not None:
        nd = ndwi(green, nir)
        valid = np.isfinite(nd)
        valid = ndimage.binary_erosion(valid, iterations=1, border_value=1)   # bilinear edge pixels mix in nodata
        valid_frac = float(valid.mean())
        core = valid & (nd > threshold)
        lab, n = ndimage.label(core, structure=np.ones((3, 3), bool))
        if n:
            idx = lab.ravel()
            sizes = np.bincount(idx, minlength=n + 1)
            near_ow = ndimage.binary_dilation(ow, iterations=1)
            touches = np.bincount(idx, weights=near_ow.ravel(), minlength=n + 1) > 0
            flat = np.ones(n + 1, bool)
            if elevation is not None and res_m:
                grad, rms = blob_flatness(lab, n, elevation, res_m)
                flat = (grad < WATER_MAX_GRADIENT) & (rms < WATER_MAX_RMS_M)
            if developed is not None:
                dev_frac = np.bincount(idx, weights=np.asarray(developed, bool).ravel(), minlength=n + 1) / np.maximum(sizes, 1)
                flat &= dev_frac <= WATER_MAX_DEVELOPED
            keep = touches | ((sizes >= min_pixels) & flat)
            keep[0] = False
            core = keep[lab]
            if slope is not None:
                core &= (np.asarray(slope) < max_slope) | near_ow
        ow = ow & ~(valid & (nd < WATER_LAND_NDWI))
    w = np.maximum(core, ow).astype(np.float32)
    if blur_px > 0:
        w = ndimage.gaussian_filter(w, blur_px, mode="nearest")
    out = (np.clip(w, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    return out, WaterStats(int(core.sum()), int(ow.sum()), int((out >= 128).sum()), valid_frac)


def open_water_render(fuel_code: np.ndarray, render_shape: tuple[int, int]) -> np.ndarray:
    """LANDFIRE open water (FBFM40 98) on the fire grid, nearest-upsampled to the render grid (bool)."""
    return nearest_resample(np.asarray(fuel_code) == 98, render_shape)


def developed_render(fuel_code: np.ndarray, render_shape: tuple[int, int]) -> np.ndarray:
    """LANDFIRE developed land (FBFM40 91) nearest-upsampled to the render grid (bool)."""
    return nearest_resample(np.asarray(fuel_code) == 91, render_shape)
