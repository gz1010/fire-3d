"""grid.py: coordinate conventions (SPEC 4.1), AOI sizing (SPEC 8.1), weather points, slope/aspect."""

from __future__ import annotations

import math

import numpy as np
import pytest

from fire3d import config
from fire3d.grid import (
    Grid,
    aoi_extent,
    fallback_radius_m,
    fire_grid_size,
    grids_from_manifest,
    make_aoi,
    manifest_grid,
    slope_aspect,
    utm_epsg_for,
    weather_axes,
    weather_points,
)


@pytest.fixture
def g() -> Grid:
    return Grid(32611, 401000.0, 3785000.0, 12000.0, 1024, 1024)


def test_utm_zone_choice_at_minus_120() -> None:
    assert utm_epsg_for(-120.0) == 32611
    assert utm_epsg_for(-120.0001) == 32610
    assert utm_epsg_for(-118.07) == 32611
    assert utm_epsg_for(-124.0) == 32610


def test_basic_properties(g: Grid) -> None:
    assert g.res_m == pytest.approx(12000 / 1024)
    assert g.bounds == (395000.0, 3779000.0, 407000.0, 3791000.0)
    assert g.crs == "EPSG:32611" and g.utm_zone == 11
    t = g.transform
    assert t @ (0, 0) == pytest.approx((395000.0, 3791000.0))      # NW corner
    assert t @ (1024, 1024) == pytest.approx((407000.0, 3779000.0))  # SE corner
    f = g.with_size(400, 400)
    assert f.res_m == pytest.approx(30.0) and f.extent_m == g.extent_m and f.center_e == g.center_e


def test_local_en_round_trip(g: Grid) -> None:
    x, z = g.en_to_local(401500.0, 3784000.0)
    assert (x, z) == pytest.approx((500.0, 1000.0))                # 1 km south of centre -> z = +1000
    assert g.local_to_en(x, z) == pytest.approx((401500.0, 3784000.0))


def test_lonlat_local_round_trip_vectorized(g: Grid) -> None:
    rng = np.random.default_rng(1)
    X = rng.uniform(-6000, 6000, 500)
    Z = rng.uniform(-6000, 6000, 500)
    lon, lat = g.local_to_lonlat(X, Z)
    assert lon.shape == (500,)
    X2, Z2 = g.lonlat_to_local(lon, lat)
    assert np.allclose(X2, X, atol=1e-6) and np.allclose(Z2, Z, atol=1e-6)
    lon_s, lat_s = g.local_to_lonlat(0.0, 0.0)
    assert isinstance(lon_s, float) and isinstance(lat_s, float)


def test_z_is_south_positive(g: Grid) -> None:
    lon0, lat0 = g.local_to_lonlat(0.0, 0.0)
    _, z_north = g.lonlat_to_local(lon0, lat0 + 0.01)
    x_east, _ = g.lonlat_to_local(lon0 + 0.01, lat0)
    assert z_north < -1000 and x_east > 800


def test_row0_is_north_and_rowcol_round_trip(g: Grid) -> None:
    x0, z0 = g.pixel_center_local(0, 0)
    assert x0 == pytest.approx(-6000 + g.res_m / 2) and z0 == pytest.approx(-6000 + g.res_m / 2)
    _, lat_top = g.local_to_lonlat(*g.pixel_center_local(0, 512))
    _, lat_bottom = g.local_to_lonlat(*g.pixel_center_local(1023, 512))
    assert lat_top > lat_bottom
    rows = np.array([0.5, 10.25, 1023.5])
    cols = np.array([0.5, 700.75, 3.5])
    x, z = g.rowcol_to_local(rows, cols)
    r2, c2 = g.local_to_rowcol(x, z)
    assert np.allclose(r2, rows) and np.allclose(c2, cols)
    lon, lat = g.local_to_lonlat(x, z)
    r3, c3 = g.lonlat_to_rowcol(lon, lat)
    assert np.allclose(r3, rows, atol=1e-6) and np.allclose(c3, cols, atol=1e-6)
    # pixel-centre convention: e = minx + (c + .5) res, n = maxy - (r + .5) res
    e, n = g.local_to_en(*g.pixel_center_local(3, 5))
    minx, _, _, maxy = g.bounds
    assert e == pytest.approx(minx + 5.5 * g.res_m) and n == pytest.approx(maxy - 3.5 * g.res_m)


def test_cell_centers_local(g: Grid) -> None:
    f = g.with_size(400, 400)
    X, Z = f.cell_centers_local()
    assert X.shape == (400, 400)
    assert X[0, 0] == pytest.approx(-6000 + 15) and X[0, -1] == pytest.approx(6000 - 15)
    assert Z[0, 0] == pytest.approx(-6000 + 15) and Z[-1, 0] == pytest.approx(6000 - 15)
    assert np.all(np.diff(X[0]) > 0) and np.all(np.diff(Z[:, 0]) > 0)
    assert (X[7, 9], Z[7, 9]) == pytest.approx(f.pixel_center_local(7, 9))


def test_bbox_lonlat_encloses_square(g: Grid) -> None:
    w, s, e, n = g.bbox_lonlat()
    corners = [(-6000, -6000), (6000, -6000), (6000, 6000), (-6000, 6000)]
    for x, z in corners:
        lon, lat = g.local_to_lonlat(x, z)
        assert w - 1e-9 <= lon <= e + 1e-9 and s - 1e-9 <= lat <= n + 1e-9
    lon0, lat0 = g.local_to_lonlat(0.0, 0.0)
    assert w < lon0 < e and s < lat0 < n


def test_fire_grid_size_rules() -> None:
    for ext in (1000, 4000, 8000, 9000, 12000, 15000, 16000, 30000, 60000):
        m = fire_grid_size(ext)
        assert m % 16 == 0 and 128 <= m <= 512
    assert fire_grid_size(1000) == 128
    assert fire_grid_size(8000) == 272
    assert fire_grid_size(12000) == 400
    assert fire_grid_size(60000) == 512


def test_aoi_extent_formula() -> None:
    assert aoi_extent(4000, "historical") == 10000          # 4000*1.3 + 4000 = 9200 -> 10000
    assert aoi_extent(4000, "live") == 18000                # 5200 + 12000 = 17200 -> 18000
    assert aoi_extent(100, "historical") == 8000            # min extent
    assert aoi_extent(100, "live") == 16000
    assert aoi_extent(80000, "historical") == 60000         # max extent


def test_make_aoi_historical_bbox() -> None:
    bbox = (-118.12, 34.17, -118.02, 34.24)
    render, fire = make_aoi(-118.07, 34.20, bbox, "historical")
    assert render.epsg == 32611 and render.width == render.height == config.RENDER_SIZE
    assert fire.width == fire.height == fire_grid_size(render.extent_m)
    assert fire.extent_m == render.extent_m and render.extent_m % 1000 == 0
    # the whole fire bbox lies inside the AOI with at least the margin
    xs, zs = render.lonlat_to_local(np.array([bbox[0], bbox[2], bbox[0], bbox[2]]), np.array([bbox[1], bbox[1], bbox[3], bbox[3]]))
    half = render.extent_m / 2
    assert np.all(np.abs(xs) <= half - 2000 + 1) and np.all(np.abs(zs) <= half - 2000 + 1)
    w_m = xs.max() - xs.min()
    h_m = zs.max() - zs.min()
    assert render.extent_m == aoi_extent(max(w_m, h_m), "historical")


def test_make_aoi_live_and_fallback() -> None:
    r_live, f_live = make_aoi(-121.5, 39.8, (-121.55, 39.78, -121.45, 39.83), "live")
    assert r_live.epsg == 32610 and r_live.extent_m >= 16000
    r_fb, _ = make_aoi(-118.07, 34.20, None, "historical")
    assert r_fb.extent_m == 8000
    lon, lat = r_fb.local_to_lonlat(0.0, 0.0)
    assert lon == pytest.approx(-118.07, abs=1e-4) and lat == pytest.approx(34.20, abs=1e-4)
    r_fb_live, _ = make_aoi(-118.07, 34.20, None, "live")
    assert r_fb_live.extent_m == 16000
    r_big, f_big = make_aoi(-118.07, 34.20, None, "historical", acres=100_000)
    radius = fallback_radius_m(100_000)
    assert radius == pytest.approx(math.sqrt(100_000 * config.ACRE_M2 / math.pi))
    assert r_big.extent_m == aoi_extent(2 * radius, "historical")
    assert f_big.width % 16 == 0
    assert fallback_radius_m(1) == 1000.0


def test_weather_points_and_axes(g: Grid) -> None:
    pts = weather_points(g)
    assert len(pts) == 16
    lats = np.array([p[0] for p in pts]).reshape(4, 4)
    lons = np.array([p[1] for p in pts]).reshape(4, 4)
    assert np.all(np.diff(lats, axis=0) < 0)     # rows go north -> south
    assert np.all(np.diff(lons, axis=1) > 0)     # columns go west -> east
    xs, zs = weather_axes(g)
    assert xs == pytest.approx([-4500, -1500, 1500, 4500]) and zs == pytest.approx([-4500, -1500, 1500, 4500])
    lon, lat = g.local_to_lonlat(xs[0], zs[0])
    assert (lat, lon) == pytest.approx(pts[0])


def test_slope_aspect_conventions() -> None:
    res = 30.0
    r, c = np.mgrid[0:50, 0:50].astype(np.float64)
    rising_north = 1000.0 - r * res * 0.5          # 0.5 rise/run toward the north (row 0)
    s, a = slope_aspect(rising_north, res)
    assert np.allclose(s[5:-5, 5:-5], 0.5) and np.allclose(a[5:-5, 5:-5], 180.0)   # faces south
    rising_east = 500.0 + c * res * 0.2
    s, a = slope_aspect(rising_east, res)
    assert np.allclose(s[5:-5, 5:-5], 0.2) and np.allclose(a[5:-5, 5:-5], 270.0)   # faces west
    rising_ne = 500.0 + (c - r) * res * 0.1
    _, a = slope_aspect(rising_ne, res)
    assert np.allclose(a[5:-5, 5:-5], 225.0)                                         # faces south-west
    s, a = slope_aspect(np.full((10, 10), 7.0), res)
    assert np.all(s == 0) and np.all(a == 0)
    assert s.dtype == np.float32 and a.dtype == np.float32


def test_manifest_grid_round_trip(g: Grid) -> None:
    f = g.with_size(400, 400)
    d = manifest_grid(g, f, 300.0, 1800.0)
    assert d["crs"] == "EPSG:32611" and d["utm_zone"] == 11 and d["fire"]["res_m"] == pytest.approx(30.0)
    r2, f2 = grids_from_manifest({"grid": d})
    assert r2 == g and f2 == f
