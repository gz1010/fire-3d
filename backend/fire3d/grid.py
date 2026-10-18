"""Grid + AOI math (SPEC 4.1, 7.2, 8.1).

Conventions (Contract):
  * An AOI is a square of side ``extent_m`` centred on (``center_e``, ``center_n``) in the incident's UTM zone
    (EPSG:32610 if the centre longitude is < -120, else EPSG:32611).
  * Arrays are row-major, **row 0 = north edge, col 0 = west edge**. Pixel (r, c) centre:
    ``e = minx + (c + .5) * res``, ``n = maxy - (r + .5) * res``.
  * Local/world coordinates: ``x = e - center_e`` (east +), ``z = -(n - center_n)`` (**south +**), metres.
  * "rowcol" values are *continuous pixel coordinates* (rasterio convention): pixel (r, c) covers
    ``[r, r+1) x [c, c+1)`` and its centre is ``(r + .5, c + .5)``. ``np.floor`` gives the containing pixel;
    subtract 0.5 before ``scipy.ndimage.map_coordinates``.

All coordinate methods are vectorized: scalars in -> floats out, arrays in -> float64 arrays out.
"""

from __future__ import annotations

import dataclasses
import math
import threading
from dataclasses import dataclass
from typing import Literal

import numpy as np
from affine import Affine
from pyproj import Transformer

from . import config

Mode = Literal["live", "historical"]
WGS84 = 4326

_tls = threading.local()


def transformer(src_epsg: int, dst_epsg: int) -> Transformer:
    """Cached (per thread) ``always_xy`` pyproj Transformer from ``src_epsg`` to ``dst_epsg``."""
    cache: dict[tuple[int, int], Transformer] | None = getattr(_tls, "cache", None)
    if cache is None:
        cache = _tls.cache = {}
    key = (int(src_epsg), int(dst_epsg))
    t = cache.get(key)
    if t is None:
        t = cache[key] = Transformer.from_crs(key[0], key[1], always_xy=True)
    return t


def _arrays(a, b):
    scalar = np.ndim(a) == 0 and np.ndim(b) == 0
    return np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64), scalar


def _out(a, b, scalar: bool):
    if scalar:
        return float(a), float(b)
    return a, b


def utm_epsg_for(lon: float) -> int:
    """UTM EPSG for California: 32610 when ``lon < -120``, else 32611 (SPEC 4.1)."""
    return 32610 if float(lon) < -120.0 else 32611


def utm_zone_for_epsg(epsg: int) -> int:
    """UTM zone number of a WGS84/UTM north EPSG code (32610 -> 10)."""
    return int(epsg) - 32600


@dataclass(frozen=True)
class Grid:
    """A square AOI raster grid in UTM (see module docstring for conventions)."""

    epsg: int
    center_e: float
    center_n: float
    extent_m: float
    width: int
    height: int

    # --- geometry -------------------------------------------------------------------------------------------
    @property
    def res_x(self) -> float:
        return self.extent_m / self.width

    @property
    def res_y(self) -> float:
        return self.extent_m / self.height

    @property
    def res_m(self) -> float:
        """Pixel size in metres (grids are square, so ``res_x == res_y``)."""
        return self.res_x

    @property
    def shape(self) -> tuple[int, int]:
        return (self.height, self.width)

    @property
    def crs(self) -> str:
        return f"EPSG:{self.epsg}"

    @property
    def utm_zone(self) -> int:
        return utm_zone_for_epsg(self.epsg)

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        """(minx, miny, maxx, maxy) in UTM metres."""
        h = self.extent_m / 2.0
        return (self.center_e - h, self.center_n - h, self.center_e + h, self.center_n + h)

    @property
    def transform(self) -> Affine:
        """rasterio affine transform (north-up, origin at the north-west corner)."""
        minx, _, _, maxy = self.bounds
        return Affine(self.res_x, 0.0, minx, 0.0, -self.res_y, maxy)

    def with_size(self, w: int, h: int) -> "Grid":
        """Same extent, different raster size."""
        return dataclasses.replace(self, width=int(w), height=int(h))

    # --- UTM <-> local ----------------------------------------------------------------------------------------
    def en_to_local(self, e, n):
        """UTM (e, n) -> local (x east+, z south+)."""
        e, n, s = _arrays(e, n)
        return _out(e - self.center_e, -(n - self.center_n), s)

    def local_to_en(self, x, z):
        """Local (x, z) -> UTM (e, n)."""
        x, z, s = _arrays(x, z)
        return _out(x + self.center_e, self.center_n - z, s)

    # --- lon/lat ----------------------------------------------------------------------------------------------
    def lonlat_to_en(self, lon, lat):
        lon, lat, s = _arrays(lon, lat)
        e, n = transformer(WGS84, self.epsg).transform(lon, lat)
        return _out(np.asarray(e, dtype=np.float64), np.asarray(n, dtype=np.float64), s)

    def en_to_lonlat(self, e, n):
        e, n, s = _arrays(e, n)
        lon, lat = transformer(self.epsg, WGS84).transform(e, n)
        return _out(np.asarray(lon, dtype=np.float64), np.asarray(lat, dtype=np.float64), s)

    def lonlat_to_local(self, lon, lat):
        """WGS84 lon/lat -> local (x, z) metres. Vectorized."""
        lon, lat, s = _arrays(lon, lat)
        e, n = transformer(WGS84, self.epsg).transform(lon, lat)
        return _out(np.asarray(e) - self.center_e, -(np.asarray(n) - self.center_n), s)

    def local_to_lonlat(self, x, z):
        """Local (x, z) -> WGS84 (lon, lat). Vectorized."""
        x, z, s = _arrays(x, z)
        lon, lat = transformer(self.epsg, WGS84).transform(x + self.center_e, self.center_n - z)
        return _out(np.asarray(lon, dtype=np.float64), np.asarray(lat, dtype=np.float64), s)

    # --- pixel coordinates ------------------------------------------------------------------------------------
    def local_to_rowcol(self, x, z):
        """Local (x, z) -> continuous (row, col); pixel (r, c) covers [r, r+1) x [c, c+1)."""
        x, z, s = _arrays(x, z)
        h = self.extent_m / 2.0
        return _out((z + h) / self.res_y, (x + h) / self.res_x, s)

    def rowcol_to_local(self, row, col):
        """Continuous (row, col) -> local (x, z). Pass ``r + 0.5, c + 0.5`` for pixel centres."""
        row, col, s = _arrays(row, col)
        h = self.extent_m / 2.0
        return _out(col * self.res_x - h, row * self.res_y - h, s)

    def pixel_center_local(self, row, col):
        """Integer pixel indices -> local (x, z) of the pixel centre."""
        row, col, _ = _arrays(row, col)
        return self.rowcol_to_local(row + 0.5, col + 0.5)  # 0-d inputs stay scalar

    def lonlat_to_rowcol(self, lon, lat):
        """WGS84 lon/lat -> continuous (row, col) (float, vectorized)."""
        x, z = self.lonlat_to_local(lon, lat)
        return self.local_to_rowcol(x, z)

    def contains_local(self, x, z):
        """True where local (x, z) lies inside the AOI square."""
        h = self.extent_m / 2.0
        x = np.asarray(x, dtype=np.float64)
        z = np.asarray(z, dtype=np.float64)
        out = (np.abs(x) <= h) & (np.abs(z) <= h)
        return bool(out) if out.ndim == 0 else out

    def bbox_lonlat(self) -> tuple[float, float, float, float]:
        """(w, s, e, n) lon/lat bounds of the AOI square (edges densified, so it encloses the whole square)."""
        minx, miny, maxx, maxy = self.bounds
        t = np.linspace(0.0, 1.0, 33)
        es = np.concatenate([minx + (maxx - minx) * t, np.full_like(t, maxx), maxx - (maxx - minx) * t, np.full_like(t, minx)])
        ns = np.concatenate([np.full_like(t, miny), miny + (maxy - miny) * t, np.full_like(t, maxy), maxy - (maxy - miny) * t])
        lon, lat = transformer(self.epsg, WGS84).transform(es, ns)
        return (float(np.min(lon)), float(np.min(lat)), float(np.max(lon)), float(np.max(lat)))

    def cell_centers_local(self) -> tuple[np.ndarray, np.ndarray]:
        """2-D (H, W) arrays X, Z of pixel-centre local coordinates (Z increases with row = southward)."""
        h = self.extent_m / 2.0
        xs = -h + (np.arange(self.width, dtype=np.float64) + 0.5) * self.res_x
        zs = -h + (np.arange(self.height, dtype=np.float64) + 0.5) * self.res_y
        X, Z = np.meshgrid(xs, zs)
        return X, Z

    def cell_centers_lonlat(self) -> tuple[np.ndarray, np.ndarray]:
        """2-D (H, W) arrays LON, LAT of pixel centres."""
        X, Z = self.cell_centers_local()
        return self.local_to_lonlat(X, Z)


# ---------------------------------------------------------------------------------------------------------------
# AOI sizing (SPEC 8.1)
# ---------------------------------------------------------------------------------------------------------------
def fire_grid_size(extent_m: float) -> int:
    """``M = clamp(ceil(extent / 30 / 16) * 16, 128, 512)``: always divisible by 16 (and by 4)."""
    m = math.ceil(extent_m / config.FIRE_GRID_TARGET_RES_M / config.FIRE_GRID_MULTIPLE - 1e-9) * config.FIRE_GRID_MULTIPLE
    return int(min(max(m, config.FIRE_GRID_MIN), config.FIRE_GRID_MAX))


def aoi_extent(bbox_size_m: float, mode: Mode) -> float:
    """``clamp(ceil((size * 1.3 + 2 * margin) / 1000) * 1000, min_extent, 60000)``."""
    margin = config.AOI_MARGIN_M[mode]
    raw = bbox_size_m * config.AOI_BBOX_SCALE + 2.0 * margin
    ext = math.ceil(raw / 1000.0 - 1e-9) * 1000.0
    return float(min(max(ext, config.AOI_MIN_EXTENT_M[mode]), config.AOI_MAX_EXTENT_M))


def fallback_radius_m(acres: float | None) -> float:
    """Radius of a circle of ``acres`` (min 1 km): the AOI fallback when no fire bbox is known."""
    if not acres or acres <= 0:
        return config.FALLBACK_MIN_RADIUS_M
    return max(config.FALLBACK_MIN_RADIUS_M, math.sqrt(acres * config.ACRE_M2 / math.pi))


def make_aoi(
    center_lon: float,
    center_lat: float,
    fire_bbox_lonlat: tuple[float, float, float, float] | None,
    mode: Mode,
    *,
    acres: float | None = None,
) -> tuple[Grid, Grid]:
    """AOI grids ``(render 1024², fire M²)`` per SPEC 8.1.

    With ``fire_bbox_lonlat`` (w, s, e, n) the AOI is centred on the bbox centre and sized from its larger side.
    Without it, a circle of ``acres`` (min radius 1 km) around (``center_lon``, ``center_lat``) is used.
    Centres are rounded to whole metres.
    """
    if fire_bbox_lonlat is not None:
        w, s, e, n = (float(v) for v in fire_bbox_lonlat)
        epsg = utm_epsg_for((w + e) / 2.0)
        t = np.linspace(0.0, 1.0, 17)
        lons = np.concatenate([w + (e - w) * t, np.full_like(t, e), e - (e - w) * t, np.full_like(t, w)])
        lats = np.concatenate([np.full_like(t, s), s + (n - s) * t, np.full_like(t, n), n - (n - s) * t])
        es, ns = transformer(WGS84, epsg).transform(lons, lats)
        minx, maxx, miny, maxy = float(np.min(es)), float(np.max(es)), float(np.min(ns)), float(np.max(ns))
        ce, cn = (minx + maxx) / 2.0, (miny + maxy) / 2.0
        size = max(maxx - minx, maxy - miny)
    else:
        epsg = utm_epsg_for(center_lon)
        ce, cn = transformer(WGS84, epsg).transform(float(center_lon), float(center_lat))
        size = 2.0 * fallback_radius_m(acres)
    extent = aoi_extent(size, mode)
    render = Grid(epsg, float(round(ce)), float(round(cn)), extent, config.RENDER_SIZE, config.RENDER_SIZE)
    m = fire_grid_size(extent)
    return render, render.with_size(m, m)


# ---------------------------------------------------------------------------------------------------------------
# Weather grid (4 x 4) and terrain helpers
# ---------------------------------------------------------------------------------------------------------------
def weather_axes(grid: Grid, n: int = config.WEATHER_GRID_N) -> tuple[list[float], list[float]]:
    """Local coordinates of the n x n weather cell centres: ``xs`` west->east (columns), ``zs`` north->south
    (rows). These are ``WeatherFile.grid.x`` / ``.z``."""
    h = grid.extent_m / 2.0
    step = grid.extent_m / n
    xs = [-h + (i + 0.5) * step for i in range(n)]
    zs = [-h + (j + 0.5) * step for j in range(n)]
    return xs, zs


def weather_points(grid: Grid, n: int = config.WEATHER_GRID_N) -> list[tuple[float, float]]:
    """(lat, lon) of the n x n weather cell centres, row-major from the north-west corner."""
    xs, zs = weather_axes(grid, n)
    X, Z = np.meshgrid(np.asarray(xs), np.asarray(zs))
    lon, lat = grid.local_to_lonlat(X.ravel(), Z.ravel())
    return [(float(la), float(lo)) for la, lo in zip(lat, lon)]


def slope_aspect(elevation: np.ndarray, res_m: float) -> tuple[np.ndarray, np.ndarray]:
    """Slope (rise/run) and aspect (degrees clockwise from north, the direction the slope FACES = downslope)
    of a north-up elevation array (row 0 = north). Flat cells get aspect 0. float32 outputs."""
    d_row, d_col = np.gradient(np.asarray(elevation, dtype=np.float64), res_m, res_m)
    dz_de = d_col          # columns increase eastward
    dz_dn = -d_row         # rows increase southward
    slope = np.hypot(dz_de, dz_dn)
    aspect = np.degrees(np.arctan2(-dz_de, -dz_dn)) % 360.0
    aspect = np.where(slope < 1e-9, 0.0, aspect)
    return slope.astype(np.float32), aspect.astype(np.float32)


def manifest_grid(render: Grid, fire: Grid, elev_min_m: float, elev_max_m: float) -> dict:
    """The ``IncidentManifest.grid`` dict for a render/fire grid pair."""
    return {
        "crs": render.crs,
        "utm_zone": render.utm_zone,
        "center_e": render.center_e,
        "center_n": render.center_n,
        "extent_m": render.extent_m,
        "bbox_lonlat": list(render.bbox_lonlat()),
        "render": {"width": render.width, "height": render.height, "res_m": render.res_m},
        "fire": {"width": fire.width, "height": fire.height, "res_m": fire.res_m},
        "elev_min_m": float(elev_min_m),
        "elev_max_m": float(elev_max_m),
    }


def grids_from_manifest(manifest: dict) -> tuple[Grid, Grid]:
    """Rebuild ``(render, fire)`` grids from a manifest dict (or ``IncidentManifest.model_dump()``)."""
    g = manifest["grid"]
    epsg = int(str(g["crs"]).split(":")[-1])
    render = Grid(epsg, float(g["center_e"]), float(g["center_n"]), float(g["extent_m"]), int(g["render"]["width"]), int(g["render"]["height"]))
    return render, render.with_size(int(g["fire"]["width"]), int(g["fire"]["height"]))
