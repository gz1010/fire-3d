"""Terrain agent: DEM fetch, slope/aspect, sky-view, LANDFIRE scaling/fetch, trees and build_static_layers (offline)."""

from __future__ import annotations

import io
import math
import re
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import httpx
import numpy as np
import pytest
from affine import Affine
from PIL import Image
from rasterio.io import MemoryFile

import fire3d.http as fhttp
from fire3d import bundle, contracts
from fire3d.build import aoi
from fire3d.contracts import IncidentSummary
from fire3d.grid import Grid
from fire3d.sources import imagery, landfire, sentinel, terrain
from fire3d.sources.terrain import FetchInfo, RasterFetchError
from fire3d.timeutil import DAY_MS, HOUR_MS, iso_to_ms, time_origin_for
from fire3d.types import STATIC_NPZ_KEYS, BuildContext


def small_grid(n: int = 64, extent: float = 6400.0) -> Grid:
    return Grid(32611, 400000.0, 3785000.0, extent, n, n)


def geotiff(arr, grid: Grid, dtype: str, nodata=None, transform=None, crs=None) -> bytes:
    a = np.asarray(arr)
    if a.ndim == 2:
        a = a[None]
    with MemoryFile() as mf:
        with mf.open(driver="GTiff", width=a.shape[2], height=a.shape[1], count=a.shape[0], dtype=dtype,
                     crs=crs or grid.crs, transform=transform or grid.transform, nodata=nodata) as ds:
            ds.write(a.astype(dtype))
        return bytes(mf.read())


def query(req: httpx.Request) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlparse(str(req.url)).query).items()}


@pytest.fixture
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(terrain.time, "sleep", lambda s: None)


# ----------------------------------------------------------------------------------------------------------------
# Terrain maths
# ----------------------------------------------------------------------------------------------------------------
def test_fire_terrain_slope_aspect_on_synthetic_planes() -> None:
    render = Grid(32611, 400000.0, 3785000.0, 7680.0, 256, 256)       # 30 m render pixels
    fire = render.with_size(128, 128)                                    # 60 m fire pixels
    X, Z = render.cell_centers_local()
    FX, FZ = fire.cell_centers_local()
    k = 0.2
    # rises toward the north (z is south+) -> the slope faces south -> aspect 180
    elev, slope, aspect = aoi.fire_terrain((500.0 - k * Z).astype(np.float32), fire)
    assert elev.shape == fire.shape and slope.dtype == np.float32 and aspect.dtype == np.float32
    np.testing.assert_allclose(elev, 500.0 - k * FZ, atol=2e-3)         # exact area mean of a plane
    np.testing.assert_allclose(slope, k, atol=1e-4)
    np.testing.assert_allclose(aspect, 180.0, atol=1e-3)
    # rises toward the east -> faces west -> 270
    _, slope, aspect = aoi.fire_terrain((500.0 + k * X).astype(np.float32), fire)
    np.testing.assert_allclose(slope, k, atol=1e-4)
    np.testing.assert_allclose(aspect, 270.0, atol=1e-3)
    # rises toward the north-east -> faces south-west -> 225
    _, slope, aspect = aoi.fire_terrain((500.0 + 0.1 * X - 0.1 * Z).astype(np.float32), fire)
    np.testing.assert_allclose(slope, 0.1 * math.sqrt(2), atol=1e-4)
    np.testing.assert_allclose(aspect, 225.0, atol=1e-3)


def test_sky_view_flat_is_255_and_valley_darker_than_ridge() -> None:
    assert (terrain.sky_view_uint8(np.full((96, 96), 812.0, np.float32), 10.0) == 255).all()
    n, res = 160, 10.0
    X = np.broadcast_to((np.arange(n) - n / 2 + 0.5) * res, (n, n))
    valley = (0.5 * np.abs(X)).astype(np.float32)                        # N-S valley, side slope 0.5
    ridge = (1000.0 - 0.5 * np.abs(X)).astype(np.float32)
    sv_v = terrain.sky_view_factor(valley, res, max_dist_m=600.0)
    sv_r = terrain.sky_view_factor(ridge, res, max_dist_m=600.0)
    c = n // 2
    assert sv_r[c, c] == pytest.approx(1.0)
    # infinite V-valley floor: mean over azimuths of 1 / (1 + s² sin²(az)) = 1 / sqrt(1 + s²)
    assert sv_v[c, c] == pytest.approx(1.0 / math.sqrt(1.25), abs=0.03)
    deeper = terrain.sky_view_factor((1.0 * np.abs(X)).astype(np.float32), res, max_dist_m=600.0)
    assert deeper[c, c] < sv_v[c, c] < sv_r[c, c]
    u8 = terrain.sky_view_uint8(valley, res, max_dist_m=600.0)
    assert u8.dtype == np.uint8 and u8[c, c] < 240 and u8[c, 5] > u8[c, c]


def test_clean_dem_fills_nodata_and_rejects_empty_rasters() -> None:
    a = np.full((10, 10), 100.0, np.float32)
    a[2, 3], a[5, 5], a[7, 7] = -3.4e38, np.nan, -9999.0
    out, n = terrain.clean_dem(a, nodata=-9999.0)
    assert n == 3 and np.isfinite(out).all() and out.min() == 100.0 and out.dtype == np.float32
    sea = np.zeros((4, 4), np.float32)                                    # 3DEP ocean ~0 m is valid
    assert terrain.clean_dem(sea)[1] == 0
    with pytest.raises(RasterFetchError, match="nodata"):
        terrain.clean_dem(np.full((10, 10), np.nan, np.float32))


def test_resample_helpers_and_bilinear_sampling() -> None:
    a = np.arange(16, dtype=np.float32).reshape(4, 4)
    np.testing.assert_allclose(terrain.area_resample(a, (2, 2)), [[2.5, 4.5], [10.5, 12.5]])
    big = np.random.default_rng(0).random((1024, 1024)).astype(np.float32)
    small = terrain.area_resample(big, (400, 400))                        # non-integer ratio
    assert small.shape == (400, 400) and small.mean() == pytest.approx(big.mean(), rel=1e-5)
    up = terrain.nearest_resample(np.array([[1, 2], [3, 4]], np.uint8), (4, 4))
    assert up.dtype == np.uint8 and up.tolist() == [[1, 1, 2, 2], [1, 1, 2, 2], [3, 3, 4, 4], [3, 3, 4, 4]]
    render = small_grid(64)
    X, Z = render.cell_centers_local()
    dem = (100.0 + 0.1 * X - 0.05 * Z).astype(np.float32)
    rng = np.random.default_rng(1)
    xs, zs = rng.uniform(-3100, 3100, 300), rng.uniform(-3100, 3100, 300)
    np.testing.assert_allclose(terrain.bilinear_at(dem, render, xs, zs), 100.0 + 0.1 * xs - 0.05 * zs, atol=2e-3)


# ----------------------------------------------------------------------------------------------------------------
# DEM / exportImage fetching (mocked HTTP)
# ----------------------------------------------------------------------------------------------------------------
def test_fetch_dem_requests_grid_and_decodes(tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    grid = small_grid(64)
    dem = (np.arange(64 * 64).reshape(64, 64) % 97).astype(np.float32) + 300.0
    seen: dict[str, str] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.update(query(req))
        return httpx.Response(200, content=geotiff(dem, grid, "float32", nodata=-3.4e38), headers={"content-type": "image/tiff"})

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    out = terrain.fetch_dem(grid)
    np.testing.assert_allclose(out, dem)
    assert out.dtype == np.float32
    assert seen["bboxSR"] == seen["imageSR"] == "32611" and seen["size"] == "64,64"
    assert seen["format"] == "tiff" and seen["pixelType"] == "F32" and seen["f"] == "image"
    assert [float(v) for v in seen["bbox"].split(",")] == pytest.approx(list(grid.bounds))


def test_fetch_export_arcgis_error_body_is_retried_then_raises(tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch, no_sleep: None) -> None:
    calls: list[int] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={"error": {"code": 500, "message": "Error exporting image", "details": []}})

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    with pytest.raises(RasterFetchError, match="Error exporting image"):
        terrain.fetch_dem(small_grid())
    assert len(calls) == 2                       # the cached error body was evicted and re-requested once


def test_read_geotiff_validates_crs_shape_and_alignment() -> None:
    grid = small_grid(32)
    ok, nod = terrain.read_geotiff(geotiff(np.ones((32, 32)), grid, "float32", nodata=-1.0), grid, what="t")
    assert ok.shape == (1, 32, 32) and nod == -1.0
    shifted = Affine(grid.res_m, 0, grid.bounds[0] + 50, 0, -grid.res_m, grid.bounds[3])
    with pytest.raises(RasterFetchError, match="not aligned"):
        terrain.read_geotiff(geotiff(np.zeros((32, 32)), grid, "float32", transform=shifted), grid, what="t")
    with pytest.raises(RasterFetchError, match="CRS"):
        terrain.read_geotiff(geotiff(np.zeros((32, 32)), grid, "float32", crs="EPSG:32610"), grid, what="t")
    with pytest.raises(RasterFetchError, match="shape"):
        terrain.read_geotiff(geotiff(np.zeros((31, 32)), grid, "float32"), grid, what="t")
    with pytest.raises(RasterFetchError, match="unreadable"):
        terrain.read_geotiff(b"II*\x00garbage", grid, what="t")


# ----------------------------------------------------------------------------------------------------------------
# LANDFIRE
# ----------------------------------------------------------------------------------------------------------------
def test_scale_landfire_units_nodata_and_canopy_consistency() -> None:
    raw = {
        "FBFM40": np.array([[145, -9999, 0, 250], [98, 165, 91, 183]], np.int16),
        "CC": np.array([[0, -9999, 55, 75], [0, 45, 25, 105]], np.int16),
        "CH": np.array([[120, 0, 255, 310], [0, 190, 150, 300]], np.int16),
        "CBH": np.array([[0, 0, 30, 400], [0, 25, 10, 20]], np.int16),
        "CBD": np.array([[0, 0, 12, 9], [0, 5, -9999, 16]], np.int16),
    }
    f = landfire.scale_landfire(raw)
    assert f.fuel_code.dtype == np.uint8 and f.fuel_model.dtype == np.int16
    assert f.fuel_code.tolist() == [[145, 0, 0, 0], [98, 165, 91, 183]]          # fuel.bin: 0 = nodata
    assert f.fuel_model.tolist() == [[145, 99, 99, 99], [98, 165, 91, 183]]      # simulation: nodata -> 99
    assert f.nodata_cells == 3
    assert f.cc_pct.tolist() == [[0, 0, 55, 75], [0, 45, 25, 100]]
    np.testing.assert_allclose(f.cc_frac, f.cc_pct / 100.0)
    np.testing.assert_allclose(f.ch_m, [[0, 0, 25.5, 31.0], [0, 19.0, 15.0, 30.0]])    # m x 10 -> m; no canopy where cc = 0
    np.testing.assert_allclose(f.cbh_m, [[0, 0, 3.0, 31.0], [0, 2.5, 1.0, 2.0]])      # CBH clamped to CH
    np.testing.assert_allclose(f.cbd_kg_m3, [[0, 0, 0.12, 0.09], [0, 0.05, 0.0, 0.16]], atol=1e-6)
    assert f.fixes == {"canopy_attrs_without_cover": 1, "cbh_above_ch": 1}


def test_fetch_landfire_mock_nodata_and_seasonal_fallback(tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch, no_sleep: None) -> None:
    grid = small_grid(32)
    codes = {"FBFM40": 145, "CC": 55, "CH": 120, "CBH": 20, "CBD": 11, "EVT": 7118}
    urls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        urls.append(url)
        if "Seasonal_Fuels" in url:
            return httpx.Response(200, json={"error": {"code": 400, "message": "Unable to complete operation."}})
        layer = re.search(r"_(FBFM40|CC|CH|CBH|CBD|EVT|EVC)_CONUS", url).group(1)
        a = np.full((32, 32), codes[layer], np.int16)
        a[0, 0] = -32768
        return httpx.Response(200, content=geotiff(a, grid, "int16", nodata=-32768))

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    raw = landfire.fetch_landfire(grid, "LF2024")
    assert set(raw) == {"FBFM40", "CC", "CH", "CBH", "CBD", "EVT"}
    assert raw["CC"].dtype == np.int16 and raw["CC"][0, 0] == landfire.NODATA and raw["CC"][1, 1] == 55
    assert all("Landfire_LF2024/LF2024_" in u and "RSP_NearestNeighbor" in u for u in urls)
    urls.clear()
    raw2, infos, notes = landfire.fetch_landfire_info(grid, "LF2025", ("FBFM40", "CC"), seasonal="FA26")
    assert any("Landfire_LF2025_Seasonal_Fuels_2026/LF2025_FBFM40_FA26" in u for u in urls)
    assert notes and "FA26" in notes[0] and "Seasonal_Fuels" not in infos["FBFM40"].url
    assert raw2["FBFM40"][5, 5] == 145
    with pytest.raises(ValueError):
        landfire.service_url("LF2019", "FBFM40")


def test_fetch_landfire_rejects_aoi_without_fuel_codes(tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    grid = small_grid(16)
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(
        lambda req: httpx.Response(200, content=geotiff(np.full((16, 16), -9999), grid, "int16", nodata=-9999))))
    with pytest.raises(RasterFetchError, match="no fuel codes"):
        landfire.fetch_layer(grid, "LF2024", "FBFM40")


def test_seasonal_products_and_editions() -> None:
    assert landfire.edition_for("live") == "LF2025" and landfire.edition_for("historical") == "LF2024"
    assert landfire.seasonal_fbfm40(iso_to_ms("2026-10-16T00:00:00Z")) == "FA26"
    assert landfire.seasonal_fbfm40(iso_to_ms("2026-07-20T00:00:00Z")) == "SU26"
    assert landfire.seasonal_fbfm40(iso_to_ms("2026-06-10T00:00:00Z")) == "ES26"
    assert landfire.seasonal_fbfm40(iso_to_ms("2026-04-01T00:00:00Z")) == "SP26"
    assert landfire.seasonal_fbfm40(iso_to_ms("2026-01-15T00:00:00Z")) is None
    assert landfire.seasonal_fbfm40(iso_to_ms("2027-10-01T00:00:00Z")) is None
    assert landfire.seasonal_fbfm40(None) is None


def test_evt_tree_kind_evc_shrub_cover_and_attribute_table(tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    table = {7014: ("Conifer", "Tree"), 7118: ("Hardwood", "Tree"), 7110: ("Shrubland", "Shrub"), 7911: ("Developed", "Tree"),
             9129: ("Riparian", "Tree"), 7020: ("Conifer-Hardwood", "Tree"), 7140: ("Grassland", "Herb"),
             7296: ("Developed-Low Intensity", "Developed")}
    k = landfire.evt_tree_kind(np.array([[7014, 7118, 7110], [7911, 9129, 7020], [7140, 7296, 1234]]), table)
    assert k.dtype == np.int8 and k.tolist() == [[0, 1, 2], [1, 1, 3], [-1, 1, -1]]
    c = landfire.evc_shrub_cover(np.array([[152, 251, 365], [11, 0, 299]], np.int16))
    np.testing.assert_allclose(c, [[0, 0.51, 0], [0, 0, 0.99]], atol=1e-6)
    rows = ["﻿VALUE,EVT_NAME,EVT_LF,EVT_PHYS"] + [f"{7000 + i},Name {i},Tree,{'Conifer' if i % 2 else 'Hardwood'}" for i in range(150)]
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(
        lambda req: httpx.Response(200, content="\n".join(rows).encode(), headers={"content-type": "text/csv"})))
    t, info = landfire.fetch_evt_physiognomy()
    assert len(t) == 150 and t[7001] == ("Conifer", "Tree") and t[7000] == ("Hardwood", "Tree")


def test_fetch_fuels_edition_fallback_and_optional_layers(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_info(grid, edition, layers, seasonal=None):
        if edition == "LF2025":
            raise RasterFetchError("LANDFIRE LF2025 FBFM40: HTTP 500")
        return ({k: np.full(grid.shape, 1, np.int16) for k in layers}, {k: FetchInfo(f"u-{k}", 5, True, 0.0) for k in layers}, [])

    def fake_layer(grid, edition, name, seasonal=None):
        if name == "EVC":
            raise RasterFetchError("LANDFIRE LF2025 EVC: HTTP 404")
        return np.full(grid.shape, 7118, np.int16), FetchInfo("u-evt", 6, True, 0.0)

    monkeypatch.setattr(landfire, "fetch_landfire_info", fake_info)
    monkeypatch.setattr(landfire, "fetch_layer", fake_layer)
    monkeypatch.setattr(landfire, "fetch_evt_physiognomy", lambda: ({7118: ("Hardwood", "Tree")}, FetchInfo("csv", 7, True, 0.0)))
    ff = aoi.fetch_fuels(small_grid(16), "LF2025", "FA26")
    assert ff.edition == "LF2024" and ff.seasonal is None and "LF2025 unavailable" in ff.notes[0]
    assert "EVT" in ff.raw and "EVC" not in ff.raw and "EVC" in ff.veg_notes[0] and ff.evt_table == {7118: ("Hardwood", "Tree")}

    def both_fail(grid, edition, layers, seasonal=None):
        raise RasterFetchError(f"LANDFIRE {edition}: timeout")

    monkeypatch.setattr(landfire, "fetch_landfire_info", both_fail)
    with pytest.raises(aoi.StaticLayerError, match="LANDFIRE fuels unavailable"):
        aoi.fetch_fuels(small_grid(16), "LF2024")


# ----------------------------------------------------------------------------------------------------------------
# Trees
# ----------------------------------------------------------------------------------------------------------------
def make_fuels(fuel, cc_pct, ch_m) -> landfire.Fuels:
    fuel = np.asarray(fuel, np.int16)
    zeros = np.zeros(fuel.shape, np.int16)
    return landfire.scale_landfire({"FBFM40": fuel, "CC": np.asarray(cc_pct, np.int16),
                                    "CH": np.round(np.asarray(ch_m, np.float64) * 10).astype(np.int16), "CBH": zeros, "CBD": zeros})


def test_generate_trees_kinds_by_fuel_heights_and_ground() -> None:
    fire = Grid(32611, 400000.0, 3785000.0, 3840.0, 128, 128)               # 30 m cells
    render = fire.with_size(256, 256)
    fuel = np.empty((128, 128), np.int16)
    cc = np.zeros((128, 128), np.int16)
    ch = np.zeros((128, 128))
    fuel[:64, :64], cc[:64, :64], ch[:64, :64] = 165, 60, 20.0             # timber understory -> conifer
    fuel[:64, 64:], cc[:64, 64:], ch[:64, 64:] = 102, 40, 12.0             # tall trees over grass -> broadleaf
    fuel[64:, :64], cc[64:, :64], ch[64:, :64] = 102, 30, 3.0              # low trees -> shrub kind, 3 m floor
    fuel[64:, 64:], cc[64:, 64:], ch[64:, 64:] = 145, 0, 0.0               # chaparral without canopy -> low shrubs
    fuel[:4, :], cc[:4, :] = 98, 50                                          # open water: never trees
    fuels = make_fuels(fuel, cc, ch)
    X, Z = render.cell_centers_local()
    dem = (200.0 + 0.05 * X + 0.02 * Z).astype(np.float32)
    pts, st = aoi.generate_trees(fire, render, dem, fuels, seed=7)
    assert pts.dtype == np.float32 and pts.ndim == 2 and pts.shape[1] == 6
    assert st["count"] == len(pts) <= aoi.MAX_TREES and st["count"] > 50_000
    x, y, z, h, r, k = pts.T.astype(np.float64)
    inner = (np.abs(x) < 1900) & (np.abs(z) < 1900)
    np.testing.assert_allclose(y[inner], 200.0 + 0.05 * x[inner] + 0.02 * z[inner], atol=0.01)   # y = bilinear DEM
    col = ((x + 1920.0) // 30.0).astype(int)
    row = ((z + 1920.0) // 30.0).astype(int)
    assert (fuel[row, col] != 98).all()
    con, broad = (row < 64) & (col < 64), (row < 64) & (col >= 64)
    low, shrub = (row >= 64) & (col < 64), (row >= 64) & (col >= 64)
    assert (k[con] == aoi.TREE_CONIFER).all() and (k[broad] == aoi.TREE_BROADLEAF).all()
    assert (k[low] == aoi.TREE_SHRUB).all() and (h[low] >= 3.0 - 1e-6).all()
    assert (k[shrub] == aoi.TREE_SHRUB).all() and shrub.sum() > 1000 and (h[shrub] <= 4.0 + 1e-6).all()
    assert (h[con] >= 14.0 - 1e-4).all() and (h[con] <= 22.0 + 1e-4).all()                       # CH x U(0.7, 1.1)
    np.testing.assert_allclose(r, np.clip(0.28 * h, 1.5, 9.0), rtol=1e-5)
    assert con.sum() / broad.sum() == pytest.approx(60 / 40, rel=0.05)                               # density ~ canopy cover
    assert st["conifer"] + st["broadleaf"] + st["shrub"] == st["count"]


def test_generate_trees_budget_cap_and_uniform_order() -> None:
    fire = Grid(32611, 400000.0, 3785000.0, 15360.0, 512, 512)
    render = fire.with_size(1024, 1024)
    fuels = make_fuels(np.full((512, 512), 165), np.full((512, 512), 100), np.full((512, 512), 25.0))
    dem = np.full((1024, 1024), 500.0, np.float32)
    pts, st = aoi.generate_trees(fire, render, dem, fuels, seed=1)
    assert len(pts) <= aoi.MAX_TREES and len(pts) == pytest.approx(aoi.TREE_TARGET, rel=0.02)
    head = pts[: len(pts) // 10]                                     # any prefix is a uniform thinning
    assert abs(head[:, 0].mean()) < 300 and head[:, 0].std() == pytest.approx(pts[:, 0].std(), rel=0.05)
    capped, _ = aoi.generate_trees(fire, render, dem, fuels, max_trees=1000, seed=1)
    assert len(capped) == 1000
    none, st0 = aoi.generate_trees(fire, render, dem, make_fuels(np.full((512, 512), 98), np.zeros((512, 512)), np.zeros((512, 512))))
    assert none.shape == (0, 6) and st0["count"] == 0
    a, _ = aoi.generate_trees(fire, render, dem, fuels, seed=aoi.incident_seed("x"))
    b, _ = aoi.generate_trees(fire, render, dem, fuels, seed=aoi.incident_seed("x"))
    assert np.array_equal(a, b)                                       # deterministic per incident


def test_generate_trees_evt_and_evc_refinement() -> None:
    fire = Grid(32611, 400000.0, 3785000.0, 1920.0, 64, 64)
    render = fire.with_size(128, 128)
    fuels = make_fuels(np.full((64, 64), 165), np.full((64, 64), 50), np.full((64, 64), 15.0))   # rule says conifer
    evt = np.full((64, 64), landfire.EVT_KIND_UNKNOWN, np.int8)
    evt[:32, :] = landfire.EVT_KIND_BROADLEAF
    evt[32:, :32] = landfire.EVT_KIND_MIXED
    pts, st = aoi.generate_trees(fire, render, np.zeros((128, 128), np.float32), fuels, evt_kind=evt, seed=3)
    x, z, k = pts[:, 0], pts[:, 2], pts[:, 5]
    top, mixed, rule = z < 0, (z >= 0) & (x < 0), (z >= 0) & (x >= 0)
    assert (k[top] == aoi.TREE_BROADLEAF).all() and (k[rule] == aoi.TREE_CONIFER).all()
    assert 0.35 < (k[mixed] == aoi.TREE_CONIFER).mean() < 0.65 and set(np.unique(k[mixed])) == {0.0, 1.0}
    assert st["evt"] is True
    # shrub cover: EVC where shrub-dominated, else 0.3 x the fuel model's nominal cover
    sc = aoi.shrub_cover(np.array([[145, 145, 102]], np.uint8), np.array([[0.8, 0.0, 0.0]], np.float32))
    np.testing.assert_allclose(sc, [[0.8, 0.3 * aoi.NOMINAL_SHRUB_COVER[145], 0.0]], atol=1e-6)


# ----------------------------------------------------------------------------------------------------------------
# build_static_layers (network mocked at function level)
# ----------------------------------------------------------------------------------------------------------------
def _jpeg(w: int, h: int, color=(90, 110, 70)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "JPEG", quality=85)
    return buf.getvalue()


@pytest.fixture
def static_env(tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    render = Grid(32611, 400000.0, 3785000.0, 7680.0, 256, 256)
    fire = render.with_size(128, 128)
    X, Z = render.cell_centers_local()
    dem = (600.0 + 0.1 * X - 0.05 * Z).astype(np.float32)
    fuel = np.full((128, 128), 145, np.int16)
    fuel[:, :40] = 165
    fuel[100:, 100:] = 98                                                      # a lake in the SE corner
    cc = np.where(fuel == 165, 60, 0).astype(np.int16)
    raw = {"FBFM40": fuel, "CC": cc, "CH": np.where(cc > 0, 180, 0).astype(np.int16), "CBH": np.where(cc > 0, 30, 0).astype(np.int16),
           "CBD": np.where(cc > 0, 12, 0).astype(np.int16), "EVT": np.full((128, 128), 7014, np.int16)}
    infos = {k: FetchInfo(f"https://lfps.example/{k}", 1_700_000_000_000 + i, True, 0.0) for i, k in enumerate(raw)}
    env = SimpleNamespace(render=render, fire=fire, dem=dem, fuel=fuel, raw=raw)
    calls: dict[str, int] = {}

    def count(name: str) -> None:
        calls[name] = calls.get(name, 0) + 1

    monkeypatch.setattr(terrain, "fetch_dem_info", lambda g: (count("dem"), (dem, FetchInfo("dem", 1_700_000_000_000, True, 0.0), 0))[1])
    monkeypatch.setattr(aoi, "fetch_fuels", lambda g, ed, seasonal=None: (count("fuels"), aoi.FuelsFetch(
        dict(raw), dict(infos), ed, None, {7014: ("Conifer", "Tree")}))[1])
    monkeypatch.setattr(imagery, "fetch_naip_info", lambda g, max_px=4000: imagery.NaipImage(
        _jpeg(2560, 2560), 2560, 2560, 1.0, FetchInfo("naip", 1_700_000_000_500, False, 0.0)))
    g = np.full(render.shape, 90, np.uint8)                                     # land: NDWI -0.22
    nir = np.full(render.shape, 140, np.uint8)
    g[200:, 200:], nir[200:, 200:] = 80, 30                                    # the lake reads as water (NDWI 0.45)
    monkeypatch.setattr(imagery, "fetch_naip_gnir", lambda gr: (g, nir, FetchInfo("gnir", 1_700_000_000_600, False, 0.0)))
    dn = np.where(np.arange(128)[None, :] > 64, 0.6, 0.02).astype(np.float32).repeat(128, 0)
    monkeypatch.setattr(sentinel, "compute_dnbr", lambda gr, pre, post: (dn, {
        "pre": [{"id": "S2A_X", "cloud_pct": 1.0}], "post": [{"id": "S2B_Y", "cloud_pct": 2.0}], "valid_frac": 1.0,
        "fetched_ms": 1_700_000_001_000, "reason": None}))
    started = iso_to_ms("2025-01-08T02:18:00Z")
    summary = IncidentSummary(
        id="2025-test-fire-abc123", name="Test Fire", mode="historical", year=2025, calfire_uid="abc123", started_ms=started,
        updated_ms=None, contained_ms=started + 20 * DAY_MS, acres=1000.0, percent_contained=100.0, is_active=False,
        county=None, location=None, admin_unit=None, url=None, lat=34.2, lon=-118.07, detections_24h=None,
        bundle_status="building", bundle_built_ms=None)
    steps: list[tuple[str, float, str]] = []
    env.steps, env.calls = steps, calls
    env.ctx = BuildContext(summary=summary, bundle_dir=bundle.bundle_dir(summary.id), render_grid=render, fire_grid=fire,
                           time_origin_ms=time_origin_for(started), mode="historical",
                           progress=lambda s, f, m: steps.append((s, f, m)))
    return env


def test_build_static_layers_end_to_end(static_env: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    ctx = static_env.ctx
    aoi.build_static_layers(ctx)
    bdir = Path(ctx.bundle_dir)
    m = bundle.load_manifest(bdir)
    assert set(m["layers"]) == {"elevation", "sky_view", "fuel", "canopy_cover", "canopy_height", "naip", "water", "trees", "burn_severity"}
    for name, info in m["layers"].items():
        assert contracts.contract_problems(contracts.LayerInfo, info) == [], name
        path = bdir / info["file"]
        if info["dtype"] != "jpeg":
            n = info["count"] * 6 if info["grid"] == "points" else info["width"] * info["height"]
            assert path.stat().st_size == n * bundle.DTYPES[info["dtype"]].itemsize, name
    shapes = {k: (m["layers"][k].get("height"), m["layers"][k].get("width")) for k in ("elevation", "sky_view", "water")}
    assert set(shapes.values()) == {(256, 256)}
    assert (m["layers"]["fuel"]["width"], m["layers"]["burn_severity"]["nodata"]) == (128, -9999.0)
    assert contracts.contract_problems(contracts.ManifestGrid, m["grid"]) == []
    assert m["grid"]["elev_min_m"] == pytest.approx(float(static_env.dem.min())) and m["grid"]["elev_max_m"] == pytest.approx(float(static_env.dem.max()))
    assert m["fuels_edition"] == "LF2024" and m["warnings"] == []
    assert [d["name"] for d in m["data_sources"]] == ["USGS 3DEP DEM", "LANDFIRE LF2024", "NAIP imagery", "Sentinel-2 L2A (Earth Search)"]
    assert all(contracts.contract_problems(contracts.DataSource, d) == [] for d in m["data_sources"])
    assert m["data_sources"][1]["fetched_ms"] == 1_700_000_000_005
    # progress: the five steps in order, fractions within [0, 1], each finishing at 1.0
    order = list(dict.fromkeys(s for s, _, _ in static_env.steps))
    assert order == list(aoi.STEPS)
    assert all(0.0 <= f <= 1.0 for _, f, _ in static_env.steps)
    assert all(any(s == step and f == 1.0 for s, f, _ in static_env.steps) for step in aoi.STEPS)
    # sim/static.npz: the SPEC keys, dtypes and model units
    z = bundle.read_npz(bdir / bundle.STATIC_NPZ)
    assert set(STATIC_NPZ_KEYS) <= set(z) and float(z["res_m"]) == pytest.approx(60.0)
    assert z["fuel_model"].dtype == np.int16 and all(z[k].dtype == np.float32 for k in STATIC_NPZ_KEYS if k != "fuel_model")
    assert all(z[k].shape == (128, 128) for k in STATIC_NPZ_KEYS)
    np.testing.assert_allclose(z["slope"], math.hypot(0.1, 0.05), atol=1e-4)
    np.testing.assert_allclose(z["aspect"], (math.degrees(math.atan2(-0.1, -0.05)) % 360.0), atol=1e-3)
    assert z["canopy_cover"].max() == pytest.approx(0.6) and z["canopy_height"].max() == pytest.approx(18.0)
    assert z["canopy_base_height"].max() == pytest.approx(3.0) and z["canopy_bulk_density"].max() == pytest.approx(0.12)
    # layer contents
    water = bundle.read_layer(bdir, "water", m)
    assert water[230, 230] == 255 and water[20, 20] == 0                       # LANDFIRE lake, dry land
    sev = bundle.read_layer(bdir, "burn_severity", m)
    assert (sev[110:, 110:] == sentinel.NODATA).all()                         # masked over open water
    trees = bundle.read_layer(bdir, "trees", m)
    assert 0 < len(trees) <= aoi.MAX_TREES and (trees[trees[:, 0] < -3840 + 40 * 60 - 60, 5] == aoi.TREE_CONIFER).all()

    # rebuild with every optional source failing: warnings, stale layers removed, water from FBFM40 98 only
    def naip_fail(g, max_px=4000):
        raise RasterFetchError("NAIP 2560px: HTTP 502 for https://imagery.example/exportImage")

    def gnir_fail(g):
        raise RasterFetchError("NAIP green/NIR: timeout")

    monkeypatch.setattr(imagery, "fetch_naip_info", naip_fail)
    monkeypatch.setattr(imagery, "fetch_naip_gnir", gnir_fail)
    monkeypatch.setattr(sentinel, "compute_dnbr", lambda gr, pre, post: (None, {"reason": "no post-fire Sentinel-2 scene"}))
    aoi.build_static_layers(ctx)
    m2 = bundle.load_manifest(bdir)
    assert "naip" not in m2["layers"] and "burn_severity" not in m2["layers"] and "water" in m2["layers"]
    assert not (bdir / "layers/naip.jpg").exists() and not (bdir / "layers/burn_severity.bin").exists()
    assert [w.split(":")[0] for w in m2["warnings"]] == ["NAIP", "Water mask", "Burn severity"]
    assert [d["name"] for d in m2["data_sources"]] == ["USGS 3DEP DEM", "LANDFIRE LF2024"]
    water2 = bundle.read_layer(bdir, "water", m2)
    assert water2[230, 230] == 255 and water2[20, 20] == 0


def test_build_static_layers_required_failures_raise(static_env: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    def dem_fail(g):
        raise RasterFetchError("USGS 3DEP DEM: HTTP 500 after 5 attempts")

    monkeypatch.setattr(terrain, "fetch_dem_info", dem_fail)
    with pytest.raises(aoi.StaticLayerError, match="Elevation .*USGS 3DEP"):
        aoi.build_static_layers(static_env.ctx)

    def fuels_fail(g, ed, seasonal=None):
        raise aoi.StaticLayerError("LANDFIRE fuels unavailable: LANDFIRE LF2024 FBFM40: HTTP 503")

    monkeypatch.setattr(terrain, "fetch_dem_info", lambda g: (static_env.dem, FetchInfo("dem", 1, True, 0.0), 0))
    monkeypatch.setattr(aoi, "fetch_fuels", fuels_fail)
    with pytest.raises(aoi.StaticLayerError, match="LANDFIRE fuels unavailable"):
        aoi.build_static_layers(static_env.ctx)
    with pytest.raises(ValueError, match="differ"):
        aoi.check_grids(static_env.render, Grid(32611, 1.0, 2.0, 7680.0, 128, 128))


def test_dnbr_windows(static_env: SimpleNamespace) -> None:
    ctx = static_env.ctx
    start = ctx.summary.started_ms
    end = ctx.summary.contained_ms
    now = start + 400 * DAY_MS
    pre, post = aoi.dnbr_windows(ctx, now)
    assert pre == (start - 60 * DAY_MS, start - DAY_MS) and post == (end + 3 * DAY_MS, end + 60 * DAY_MS)
    ctx.end_ms = start + 5 * DAY_MS                                                      # observed end wins
    assert aoi.dnbr_windows(ctx, now)[1] == (start + 8 * DAY_MS, start + 65 * DAY_MS)
    ctx.end_ms = None
    ctx.summary.contained_ms = start + 200 * DAY_MS                                      # capped at start + 60 d
    assert aoi.dnbr_windows(ctx, now)[1][0] == start + 63 * DAY_MS
    ctx.summary.contained_ms = None                                                      # default 14 d
    assert aoi.dnbr_windows(ctx, now)[1][0] == start + 17 * DAY_MS
    assert aoi.dnbr_windows(ctx, start + 30 * DAY_MS)[1][1] == start + 30 * DAY_MS     # clipped to now
    ctx.mode = "live"
    assert aoi.dnbr_windows(ctx, start + 3 * DAY_MS)[1] == (start + 12 * HOUR_MS, start + 3 * DAY_MS)
    assert aoi.dnbr_windows(ctx, start + 40 * DAY_MS)[1] == (start + 30 * DAY_MS, start + 40 * DAY_MS)
