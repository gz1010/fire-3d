"""Terrain agent: NAIP imagery (sizes, quadrant mosaic, fallbacks, G/NIR) and the NDWI water mask (offline)."""

from __future__ import annotations

import io
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import numpy as np
import pytest
from PIL import Image
from rasterio.io import MemoryFile

import fire3d.http as fhttp
from fire3d.grid import Grid, slope_aspect
from fire3d.sources import imagery, terrain
from fire3d.sources.terrain import RasterFetchError


def grid_km(km: float, n: int = 1024) -> Grid:
    return Grid(32611, 400000.0, 3785000.0, km * 1000.0, n, n)


def jpeg(w: int, h: int, color=(90, 110, 70), quality: int = 92) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def query(req: httpx.Request) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlparse(str(req.url)).query).items()}


@pytest.fixture
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(terrain.time, "sleep", lambda s: None)


def test_naip_size_rule() -> None:
    assert imagery.naip_size(12000) == 4000                  # min(4000, max(2048, extent / 3))
    assert imagery.naip_size(8000) == 2666                   # 2667 rounded down to even
    assert imagery.naip_size(3000) == 2048
    assert imagery.naip_size(60000) == 4000
    assert imagery.naip_size(12000, max_px=1024) == 1024


def test_quadrants_tile_the_square_exactly() -> None:
    g = grid_km(8)
    tiles = imagery.quadrants(g, 2666)
    assert [off for _, off in tiles] == [(0, 0), (1333, 0), (0, 1333), (1333, 1333)]
    nw, ne, sw, se = (t for t, _ in tiles)
    assert nw.bounds == (g.bounds[0], g.center_n, g.center_e, g.bounds[3])
    assert se.bounds == (g.center_e, g.bounds[1], g.bounds[2], g.center_n)
    assert all(t.width == t.height == 1333 and t.res_m == pytest.approx(g.extent_m / 2666) for t in (nw, ne, sw, se))


def test_fetch_naip_quadrant_mosaic_is_stitched_north_up(tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    g = grid_km(8)
    seen: list[dict[str, str]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        q = query(req)
        seen.append(q)
        minx, miny, maxx, maxy = (float(v) for v in q["bbox"].split(","))
        w, h = (int(v) for v in q["size"].split(","))
        east, north = (minx + maxx) / 2 > g.center_e, (miny + maxy) / 2 > g.center_n
        return httpx.Response(200, content=jpeg(w, h, (200 if east else 40, 200 if north else 40, 120)), headers={"content-type": "image/jpeg"})

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    img = imagery.fetch_naip_info(g)
    assert (img.width, img.height) == (2666, 2666) and img.coverage == 1.0 and img.jpeg[:2] == b"\xff\xd8"
    assert len(seen) == 4 and all(q["size"] == "1333,1333" and q["compressionQuality"] == "92" and q["format"] == "jpg" for q in seen)
    a = np.asarray(Image.open(io.BytesIO(img.jpeg))).astype(int)
    assert a.shape == (2666, 2666, 3)
    for (r, c), expect in {(100, 100): (40, 200), (100, -100): (200, 200), (-100, 100): (40, 40), (-100, -100): (200, 40)}.items():
        assert abs(a[r, c, 0] - expect[0]) < 12 and abs(a[r, c, 1] - expect[1]) < 12, (r, c, a[r, c])
    jpg, w, h = imagery.fetch_naip(g)                            # contract tuple (served from the cache)
    assert (w, h) == (2666, 2666) and jpg[:2] == b"\xff\xd8"


def test_fetch_naip_falls_back_to_single_request(tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch, no_sleep: None) -> None:
    g = grid_km(8)

    def handler(req: httpx.Request) -> httpx.Response:
        w, h = (int(v) for v in query(req)["size"].split(","))
        if w == 1333:
            return httpx.Response(404, text="Not Found")
        return httpx.Response(200, content=jpeg(w, h), headers={"content-type": "image/jpeg"})

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    img = imagery.fetch_naip_info(g)
    assert img.width == 2048 and any("retried at 2048px" in n for n in img.notes)


def test_fetch_naip_rejects_no_coverage_and_errors(tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch, no_sleep: None) -> None:
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(
        lambda req: httpx.Response(200, content=jpeg(*(int(v) for v in query(req)["size"].split(",")), color=(0, 0, 0)))))
    with pytest.raises(RasterFetchError, match="no imagery"):
        imagery.fetch_naip_info(grid_km(3))
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(
        lambda req: httpx.Response(200, json={"error": {"code": 500, "message": "Error exporting image"}})))
    with pytest.raises(RasterFetchError, match="Error exporting image"):
        imagery.fetch_naip(grid_km(3), max_px=1024)


def test_jpeg_coverage_counts_black_nodata() -> None:
    im = Image.new("RGB", (400, 400), (90, 100, 80))
    im.paste((0, 0, 0), (0, 0, 200, 400))                        # left half outside NAIP coverage
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=95)
    w, h, cov = imagery.jpeg_coverage(buf.getvalue(), (400, 400))
    assert (w, h) == (400, 400) and cov == pytest.approx(0.5, abs=0.02)
    with pytest.raises(RasterFetchError, match="expected"):
        imagery.jpeg_coverage(buf.getvalue(), (512, 512))
    with pytest.raises(RasterFetchError, match="undecodable"):
        imagery.jpeg_coverage(b"\xff\xd8\xff\xe0broken")


def test_fetch_naip_gnir_requests_raw_green_and_nir(tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    g = grid_km(4, 64)
    data = np.stack([np.full((64, 64), 80, np.uint8), np.full((64, 64), 30, np.uint8)])
    seen: dict[str, str] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.update(query(req))
        with MemoryFile() as mf:
            with mf.open(driver="GTiff", width=64, height=64, count=2, dtype="uint8", crs=g.crs, transform=g.transform) as ds:
                ds.write(data)
            return httpx.Response(200, content=bytes(mf.read()), headers={"content-type": "image/tiff"})

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    green, nir, info = imagery.fetch_naip_gnir(g)
    assert green.dtype == nir.dtype == np.uint8 and green[5, 5] == 80 and nir[5, 5] == 30
    assert seen["bandIds"] == "1,3" and seen["format"] == "tiff" and seen["pixelType"] == "U8"
    assert "None" in seen["renderingRule"]


# ----------------------------------------------------------------------------------------------------------------
# NDWI water mask
# ----------------------------------------------------------------------------------------------------------------
def test_ndwi_values_and_nodata() -> None:
    nd = imagery.ndwi(np.array([[80, 90, 0, 3]], np.uint8), np.array([[30, 140, 0, 2]], np.uint8))
    assert nd[0, 0] == pytest.approx(50 / 110) and nd[0, 1] == pytest.approx(-50 / 230)
    assert np.isnan(nd[0, 2]) and np.isnan(nd[0, 3])            # no imagery / too dark to trust


def test_water_mask_keeps_flat_water_and_rejects_char_roofs_and_speckle() -> None:
    n, res = 128, 15.0
    rr, cc = np.mgrid[0:n, 0:n]
    dem = 300.0 + 0.01 * cc * res                                 # gentle plane
    dem[10:31, 10:31] = 301.5                                     # hydro-flattened lake
    hill = np.clip(120.0 - 0.5 * np.hypot(rr - 80, cc - 80) * res, 0, None)
    dem = dem + hill                                              # cone hill (relief 120 m)
    dem[40:56, 10:41] = 400.0 + 0.08 * (55 - rr[40:56, 10:41]) * res   # planar 8 % slope
    green = np.full((n, n), 90, np.uint8)
    nir = np.full((n, n), 140, np.uint8)                          # land: NDWI -0.22

    def paint(sl, g, ni):
        green[sl], nir[sl] = g, ni

    paint((slice(10, 31), slice(10, 31)), 80, 30)                 # lake: NDWI 0.45
    paint((slice(62, 99), slice(62, 99)), 99, 49)                 # char on the hill: NDWI 0.34
    paint((slice(41, 55), slice(11, 40)), 99, 49)                 # char on the planar 8 % slope
    paint((slice(10, 17), slice(80, 91)), 70, 40)                 # dark roofs / solar panels (flat, developed)
    paint((slice(110, 111), slice(10, 12)), 80, 30)               # 2-pixel speckle
    paint((slice(110, n), slice(100, n)), 0, 0)                   # no NAIP over the LANDFIRE lake
    open_water = np.zeros((n, n), bool)
    open_water[110:, 100:] = True
    developed = np.zeros((n, n), bool)
    developed[5:22, 75:96] = True
    slope, _ = slope_aspect(dem, res)
    out, st = imagery.water_mask(green, nir, open_water, slope, dem, res, developed)
    assert out.dtype == np.uint8 and out.shape == (n, n)
    assert out[20, 20] == 255                                     # flat lake kept
    assert out[80, 80] == 0 and out[48, 25] == 0                  # char (hill and planar slope) rejected
    assert out[13, 85] == 0                                       # roofs on developed land rejected
    assert out[110, 10] == 0                                      # speckle removed
    assert out[120, 115] == 255                                   # LANDFIRE open water without NAIP
    edge = out[8:33, 20]
    assert ((edge > 0) & (edge < 255)).any()                      # soft edges
    assert st.water_pixels > 0 and 0.9 < st.ndwi_valid_frac < 1.0
    # without elevation the flatness test is skipped: the char on gentle slopes would pass
    out2, _ = imagery.water_mask(green, nir, open_water, None, None, None, developed)
    assert out2[48, 25] == 255
    # no NAIP at all: LANDFIRE open water only
    out3, st3 = imagery.water_mask(None, None, open_water)
    assert out3[120, 115] == 255 and out3[20, 20] == 0 and st3.ndwi_pixels == 0 and st3.ndwi_valid_frac == 0.0


def test_water_mask_trims_open_water_where_naip_shows_land() -> None:
    green = np.full((40, 40), 80, np.uint8)
    nir = np.full((40, 40), 30, np.uint8)
    green[:, 30:], nir[:, 30:] = 90, 160                          # NDWI -0.28 on the right: land
    ow = np.zeros((40, 40), bool)
    ow[:, 20:36] = True                                           # blocky LANDFIRE water overhanging the shore
    out, st = imagery.water_mask(green, nir, ow, np.zeros((40, 40)), np.zeros((40, 40)), 15.0)
    assert out[20, 25] == 255 and out[20, 34] == 0


def test_blob_flatness_plane_fit() -> None:
    labels = np.zeros((30, 30), np.int32)
    labels[2:10, 2:10] = 1
    labels[15:28, 15:28] = 2
    labels[20, 2:12] = 3                                          # a straight line (degenerate fit)
    rr, cc = np.mgrid[0:30, 0:30]
    z = 100.0 + 0.02 * cc * 10.0
    z[15:28, 15:28] += np.random.default_rng(0).normal(0, 3.0, (13, 13))
    grad, rms = imagery.blob_flatness(labels, 3, z, 10.0)
    assert grad[1] == pytest.approx(0.02, abs=1e-6) and rms[1] < 1e-6
    assert rms[2] == pytest.approx(3.0, rel=0.3)
    assert grad[3] == pytest.approx(0.02, abs=1e-6) and rms[3] < 1e-6
