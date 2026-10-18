"""Terrain agent: Sentinel-2 dNBR - STAC parsing/search, reflectance offsets, compositing, dNBR math (offline)."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import numpy as np
import pytest
import rasterio
from affine import Affine

import fire3d.http as fhttp
from fire3d.grid import Grid, make_aoi, transformer
from fire3d.sources import sentinel
from fire3d.timeutil import DAY_MS, iso_to_ms

DATA = Path(__file__).parent / "data" / "terrain"
EATON_FIRE_GRID = make_aoi(-118.069155, 34.203483, (-118.16, 34.16, -118.03, 34.25), "historical")[1]


def small_grid(n: int = 32) -> Grid:
    return Grid(32611, 400000.0, 3785000.0, n * 30.0, n, n)


def scene(sid: str, day: str, cloud: float, platform: str = "sentinel-2a", coverage: float = 1.0, offset: float = 0.0,
          flag: bool | None = True) -> sentinel.Scene:
    assets = {b: sentinel.Asset(f"https://example.test/{sid}/{b}.tif", 1e-4 if b != "scl" else 1.0, offset if b != "scl" else 0.0, 0.0)
              for b in sentinel.BANDS}
    return sentinel.Scene(sid, iso_to_ms(day), cloud, platform, "11SLT", assets, coverage, flag)


class FakeReader:
    """In-memory band reader standing in for the COG reads; records calls."""

    def __init__(self) -> None:
        self.data: dict[tuple[str, str], np.ndarray] = {}
        self.calls: list[tuple[str, str]] = []

    def add(self, sid: str, scl, nir, swir) -> None:
        self.data[(sid, "scl")] = np.asarray(scl, np.uint8)
        self.data[(sid, "nir")] = np.asarray(nir, np.uint16)
        self.data[(sid, "swir22")] = np.asarray(swir, np.uint16)

    def __call__(self, sc: sentinel.Scene, band: str, grid: Grid) -> tuple[np.ndarray, int]:
        self.calls.append((sc.id, band))
        return self.data[(sc.id, band)], 1_700_000_000_000 + len(self.calls)


def test_parse_scene_from_a_real_earth_search_item() -> None:
    f = json.loads((DATA / "stac_item_s2_11SLT_20250102.json").read_text())
    sc = sentinel.parse_scene(f, EATON_FIRE_GRID)
    assert sc is not None and sc.id == "S2A_11SLT_20250102_0_L2A" and sc.tile == "11SLT"
    assert sc.cloud == pytest.approx(3.015763) and sc.platform == "sentinel-2a" and sc.acquisition == "sentinel-2a:2025-01-02"
    assert sc.t_ms == iso_to_ms("2025-01-02T18:45:02.738Z")
    nir, swir, scl = sc.assets["nir"], sc.assets["swir22"], sc.assets["scl"]
    assert nir.href.endswith("/B08.tif") and swir.href.endswith("/B12.tif") and scl.href.endswith("/SCL.tif")
    assert (nir.scale, nir.offset, nir.nodata) == (1e-4, -0.1, 0.0) and scl.offset == 0.0
    assert sc.boa_offset_applied is True
    assert sc.coverage == pytest.approx(1.0, abs=1e-3)            # tile 11SLT contains the whole Eaton AOI
    f2 = json.loads(json.dumps(f))
    del f2["assets"]["swir22"]
    assert sentinel.parse_scene(f2, EATON_FIRE_GRID) is None


def test_footprint_coverage_fraction() -> None:
    g = small_grid(32)
    lon0, lat0 = g.local_to_lonlat(0.0, 0.0)
    w, s, e, n = g.bbox_lonlat()
    west_half = {"type": "Polygon", "coordinates": [[[w - 1, s - 1], [lon0, s - 1], [lon0, n + 1], [w - 1, n + 1], [w - 1, s - 1]]]}
    assert sentinel.footprint_coverage(west_half, g) == pytest.approx(0.5, abs=0.02)
    assert sentinel.footprint_coverage(None, g) == 1.0


def test_search_scenes_request_body_and_pagination(tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    item = json.loads((DATA / "stac_item_s2_11SLT_20250102.json").read_text())
    item2 = json.loads(json.dumps(item))
    item2["id"] = "S2B_11SLT_20241218_0_L2A"
    item2["properties"]["datetime"] = "2024-12-18T18:45:03.766Z"
    bodies: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        bodies.append(body)
        if body.get("next") == "tok2":
            return httpx.Response(200, json={"type": "FeatureCollection", "features": [item2], "links": []})
        return httpx.Response(200, json={"type": "FeatureCollection", "features": [item],
                                         "links": [{"rel": "next", "href": sentinel.STAC_URL, "method": "POST", "body": {"next": "tok2"}, "merge": True}]})

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    t0, t1 = iso_to_ms("2024-11-09T02:18:00Z"), iso_to_ms("2025-01-07T02:18:00Z")
    scenes = sentinel.search_scenes(EATON_FIRE_GRID, t0, t1)
    assert [s.id for s in scenes] == ["S2B_11SLT_20241218_0_L2A", "S2A_11SLT_20250102_0_L2A"]     # sorted by time
    b = bodies[0]
    assert b["collections"] == ["sentinel-2-l2a"] and b["query"] == {"eo:cloud_cover": {"lt": 20.0}}
    assert b["datetime"] == "2024-11-09T02:18:00Z/2025-01-07T02:18:00Z" and len(b["bbox"]) == 4
    assert bodies[1]["next"] == "tok2" and bodies[1]["collections"] == ["sentinel-2-l2a"]       # merged next body


def test_reflectance_offsets_and_nbr() -> None:
    a = sentinel.Asset("x", 1e-4, -0.1, 0.0)
    dn = np.array([[0, 1000, 3000], [2000, 11000, 1500]], np.uint16)
    np.testing.assert_allclose(sentinel.to_reflectance(dn, a), [[np.nan, 0.0, 0.2], [0.1, 1.0, 0.05]], atol=1e-6)
    np.testing.assert_allclose(sentinel.to_reflectance(dn, a, 0.0), [[np.nan, 0.1, 0.3], [0.2, 1.1, 0.15]], atol=1e-6)
    v = sentinel.nbr(np.array([0.4, 0.3, 0.01, np.nan], np.float32), np.array([0.1, 0.3, 0.005, 0.2], np.float32))
    np.testing.assert_allclose(v[:2], [0.6, 0.0], atol=1e-6)
    assert np.isnan(v[2]) and np.isnan(v[3])                      # nir + swir below MIN_SIGNAL, NaN input


def test_offset_is_applied_only_when_the_dns_carry_it() -> None:
    a = sentinel.Asset("x", 1e-4, -0.1, 0.0)
    rng = np.random.default_rng(0)
    carried = (1000 + rng.integers(0, 3000, 5000)).astype(np.uint16)      # BOA_ADD_OFFSET still in the data
    removed = rng.integers(50, 3000, 5000).astype(np.uint16)              # water ~150 DN: offset already removed
    assert sentinel.offset_in_dn([carried, carried], [a, a], None) is True
    assert sentinel.offset_in_dn([carried, carried], [a, a], False) is True
    assert sentinel.offset_in_dn([removed, carried], [a, a], None) is False
    assert sentinel.offset_in_dn([removed, removed], [a, a], False) is False      # flag false is not trusted
    assert sentinel.offset_in_dn([carried, carried], [a, a], True) is False       # flag true: already removed
    assert sentinel.offset_in_dn([carried[:50], carried[:50]], [a, a], None) is True   # too few pixels: trust metadata
    assert sentinel.effective_offsets([carried, carried], [a, a], None) == [-0.1, -0.1]
    assert sentinel.effective_offsets([removed, removed], [a, a], None) == [0.0, 0.0]
    z = sentinel.Asset("x", 1e-4, 0.0, 0.0)
    assert sentinel.effective_offsets([removed, removed], [z, z], None) == [0.0, 0.0]


def test_clear_mask_masks_and_dilates_clouds() -> None:
    scl = np.full((9, 9), 4, np.uint8)
    scl[4, 4] = 9                                                 # cloud high probability
    scl[0, :] = 0                                                 # nodata
    scl[8, 8] = 6                                                 # water is fine
    m = sentinel.clear_mask(scl)
    assert not m[0].any() and not m[4, 4] and not m[3, 4] and not m[4, 5]
    assert m[3, 3] and m[8, 8] and m[6, 6]


def test_rank_acquisitions_prefers_clear_full_coverage_then_close_in_time() -> None:
    ref = iso_to_ms("2025-01-07T00:00:00Z")
    a = scene("A", "2025-01-05T18:45:00Z", 12.0)                  # cloud bin 2
    b = scene("B", "2024-12-01T18:45:00Z", 1.0)                   # bin 0, far
    c = scene("C", "2025-01-06T18:45:00Z", 3.0, platform="sentinel-2b")   # bin 0, close
    d = scene("D", "2025-01-06T18:45:00Z", 0.5, platform="sentinel-2c", coverage=0.3)   # bin 0, partial
    ranked = sentinel.rank_acquisitions([a, b, c, d], ref)
    assert [g[0].id for g in ranked] == ["C", "B", "D", "A"]
    e = scene("E1", "2025-01-03T18:45:00Z", 2.0, coverage=0.4)
    f = scene("E2", "2025-01-03T18:45:00Z", 2.0, coverage=0.9)   # same pass: larger coverage first
    assert [s.id for s in sentinel.rank_acquisitions([e, f], ref)[0]] == ["E2", "E1"]


def test_composite_fills_clouds_from_the_next_pass_and_skips_redundant_tiles() -> None:
    g = small_grid(32)
    rd = FakeReader()
    scl_a = np.full((32, 32), 4, np.uint8)
    scl_a[:, :16] = 9                                             # pass A: west half cloudy
    rd.add("A1", scl_a, np.full((32, 32), 3000), np.full((32, 32), 1000))          # NBR 0.5
    rd.add("A2", scl_a, np.full((32, 32), 3000), np.full((32, 32), 1000))          # other tile of pass A
    rd.add("B1", np.full((32, 32), 4), np.full((32, 32), 2000), np.full((32, 32), 1000))   # NBR 1/3
    ref = iso_to_ms("2025-01-07T00:00:00Z")
    sc = [scene("A1", "2025-01-05T18:45:00Z", 2.0), scene("A2", "2025-01-05T18:45:00Z", 2.0, coverage=0.4),
          scene("B1", "2024-12-20T18:45:00Z", 6.0, platform="sentinel-2b")]
    comp = sentinel.composite_nbr(g, sc, ref, reader=rd)
    assert comp.passes == 2 and comp.fill_frac == 1.0 and [u["id"] for u in comp.used] == ["A1", "B1"]
    assert not any(sid == "A2" for sid, _ in rd.calls)            # pass A fully covered by its first tile
    np.testing.assert_allclose(comp.nbr[:, 17:], 0.5, atol=1e-6)  # clear in pass A
    np.testing.assert_allclose(comp.nbr[:, :16], 1 / 3, atol=1e-6)   # filled from pass B
    np.testing.assert_allclose(comp.nbr[:, 16], 1 / 3, atol=1e-6)    # dilated cloud edge also from pass B


def test_composite_stops_on_diminishing_returns_and_fills_terrain_shadow() -> None:
    g = small_grid(32)
    rd = FakeReader()
    scl = np.full((32, 32), 4, np.uint8)
    scl[20:, 20:] = 3                                             # "cloud shadow" in every scene: terrain shadow
    for sid in ("P1", "P2", "P3"):
        rd.add(sid, scl, np.full((32, 32), 2500), np.full((32, 32), 1500))
    ref = iso_to_ms("2025-01-07T00:00:00Z")
    sc = [scene("P1", "2025-01-05T18:45:00Z", 1.0), scene("P2", "2024-12-30T18:45:00Z", 1.0, platform="sentinel-2b"),
          scene("P3", "2024-12-20T18:45:00Z", 1.0, platform="sentinel-2c")]
    comp = sentinel.composite_nbr(g, sc, ref, reader=rd)
    assert comp.passes == 2                                       # the second pass added nothing -> stop
    assert comp.fill_frac < 0.9 and comp.shadow_filled_frac > 0.05
    assert np.isfinite(comp.nbr).all()                            # shadow block filled from shadow-flagged values


def test_unburned_offset_is_the_histogram_mode() -> None:
    rng = np.random.default_rng(1)
    d = np.concatenate([rng.normal(0.04, 0.03, 80_000), rng.normal(0.6, 0.15, 20_000)]).astype(np.float32)
    assert sentinel.unburned_offset(d) == pytest.approx(0.04, abs=0.012)
    assert sentinel.unburned_offset(np.array([0.1, 0.2], np.float32)) == 0.0


def test_compute_dnbr_end_to_end(monkeypatch: pytest.MonkeyPatch) -> None:
    g = small_grid(40)
    rd = FakeReader()
    clear = np.full((40, 40), 4, np.uint8)
    rd.add("PRE", clear, np.full((40, 40), 3000), np.full((40, 40), 1000))          # NBR 0.5
    post_n = np.full((40, 40), 2900)                                                 # slight green-up: NBR 0.4872
    post_s = np.full((40, 40), 1000)
    post_n[10:20, 10:20], post_s[10:20, 10:20] = 1200, 1800                          # burned: NBR -0.2
    scl_post = clear.copy()
    scl_post[35:, 35:] = 9                                                           # cloud, no other scene
    rd.add("POST", scl_post, post_n, post_s)
    pre_w = (iso_to_ms("2024-11-09T00:00:00Z"), iso_to_ms("2025-01-07T00:00:00Z"))
    post_w = (iso_to_ms("2025-02-03T00:00:00Z"), iso_to_ms("2025-04-01T00:00:00Z"))
    pre_sc, post_sc = scene("PRE", "2025-01-02T18:45:00Z", 3.0), scene("POST", "2025-03-08T18:45:00Z", 1.8)
    monkeypatch.setattr(sentinel, "search_scenes", lambda grid, a, b, max_cloud=20.0: [pre_sc] if a < pre_w[1] else [post_sc])
    monkeypatch.setattr(sentinel, "read_scene_band", rd)
    d, info = sentinel.compute_dnbr(g, pre_w, post_w)
    assert d is not None and d.dtype == np.float32 and d.shape == (40, 40)
    raw_unburned = 0.5 - 1900 / 3900
    assert info["offset"] == pytest.approx(raw_unburned, abs=0.006) and info["reason"] is None
    assert abs(float(np.median(d[25:33, 0:30]))) < 0.006                             # unburned ~0 after the offset
    assert float(np.median(d[12:18, 12:18])) == pytest.approx(0.7 - info["offset"], abs=1e-3)
    assert (d[36:, 36:] == sentinel.NODATA).all() and 0.9 < info["valid_frac"] < 1.0
    assert [u["id"] for u in info["pre"]] == ["PRE"] and [u["id"] for u in info["post"]] == ["POST"]
    assert info["fetched_ms"] > 0


def test_compute_dnbr_failure_modes(monkeypatch: pytest.MonkeyPatch) -> None:
    g = small_grid(16)
    pre_w = (iso_to_ms("2024-11-09T00:00:00Z"), iso_to_ms("2025-01-07T00:00:00Z"))
    post_w = (iso_to_ms("2025-02-03T00:00:00Z"), iso_to_ms("2025-04-01T00:00:00Z"))
    d, info = sentinel.compute_dnbr(g, pre_w, (post_w[0], post_w[0]))
    assert d is None and "empty imagery window" in info["reason"]
    calls: list[float] = []

    def search(grid, a, b, max_cloud=20.0):
        calls.append(max_cloud)
        return [scene("PRE", "2025-01-02T18:45:00Z", 3.0)] if a < pre_w[1] else []

    monkeypatch.setattr(sentinel, "search_scenes", search)
    d, info = sentinel.compute_dnbr(g, pre_w, post_w)
    assert d is None and "post-fire" in info["reason"] and calls == [20.0, 20.0, 60.0]     # cloud filter relaxed once

    def broken(grid, a, b, max_cloud=20.0):
        raise fhttp.HttpError(503, sentinel.STAC_URL, "Service Unavailable")

    monkeypatch.setattr(sentinel, "search_scenes", broken)
    d, info = sentinel.compute_dnbr(g, pre_w, post_w)
    assert d is None and "STAC search failed" in info["reason"]


def test_read_scene_band_uses_the_disk_cache(tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    g = small_grid(16)
    calls: list[str] = []

    def fake_warp(href, grid, band, nodata=0.0):
        calls.append(band)
        return np.full(grid.shape, 7, np.uint16)

    monkeypatch.setattr(sentinel, "warp_read", fake_warp)
    sc = scene("S2X_11SLT_20250101_0_L2A", "2025-01-01T18:45:00Z", 1.0)
    a, t1 = sentinel.read_scene_band(sc, "nir", g)
    b, t2 = sentinel.read_scene_band(sc, "nir", g)
    assert calls == ["nir"] and t1 == t2 and np.array_equal(a, b) and a.dtype == np.uint16
    assert sentinel._cache_file(sc.id, "nir", g).is_file()
    assert str(sentinel._cache_file(sc.id, "nir", g)).startswith(str(tmp_data_dir))


def test_warp_read_reprojects_a_local_cog_across_utm_zones(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # target grid in zone 11 near lon -120; source tile in zone 10 (as Sentinel-2 tiles near zone edges are)
    e11, n11 = transformer(4326, 32611).transform(-119.98, 36.0)
    grid = Grid(32611, round(e11), round(n11), 3000.0, 30, 30)    # 100 m cells
    w, s, e, n = grid.bbox_lonlat()
    xs, ys = transformer(4326, 32610).transform([w, e, w, e], [s, s, n, n])
    x0, y1 = min(xs) - 2000, max(ys) + 2000
    width, height = int((max(xs) - x0 + 2000) / 10), int((y1 - min(ys) + 2000) / 10)
    arr = np.full((height, width), 2500, np.uint16)
    arr[:, : width // 2] = 0                                      # west half: nodata
    path = tmp_path / "B08.tif"
    with rasterio.open(path, "w", driver="GTiff", width=width, height=height, count=1, dtype="uint16", crs="EPSG:32610",
                       transform=Affine(10.0, 0, x0, 0, -10.0, y1), nodata=0, tiled=True, blockxsize=256, blockysize=256) as ds:
        ds.write(arr, 1)
    out = sentinel.warp_read(str(path), grid, "nir", 0.0)
    assert out.shape == (30, 30) and out.dtype == np.uint16
    valid = out > 0
    assert 0.2 < valid.mean() < 0.8 and (out[valid] == 2500).all()   # constant reflectance preserved, nodata kept
    scl = sentinel.warp_read(str(path), grid, "scl", 0.0)             # nearest path
    assert set(np.unique(scl)) <= {0, 2500}
    monkeypatch.setattr(sentinel, "READ_ATTEMPTS", 1)
    with pytest.raises(sentinel.SentinelError, match="COG read failed"):
        sentinel.warp_read(str(tmp_path / "missing.tif"), grid, "nir", 0.0)


def test_grid_signature_is_stable_and_specific() -> None:
    a = small_grid(32)
    assert sentinel.grid_signature(a) == sentinel.grid_signature(Grid(32611, 400000.0, 3785000.0, 960.0, 32, 32))
    assert sentinel.grid_signature(a) != sentinel.grid_signature(a.with_size(64, 64))
    assert DAY_MS == 86_400_000
