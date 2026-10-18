"""spread/engine.py: pyretechnics conventions on synthetic terrain (orientation, wind, slope, barriers, time)."""

from __future__ import annotations

import numpy as np
import pytest

from fire3d import bundle, config
from fire3d.spread import engine
from fire3d.types import SpreadSettings
from test_spread_support import ORIGIN, H, extents, make_static, make_weather

NEVER = config.NEVER
START = ORIGIN + 3 * H


def _ignite(m: int, r: int, c: int) -> np.ndarray:
    mask = np.zeros((m, m), bool)
    mask[r, c] = True
    return mask


def _run(static, weather, mask, hours, **kw):
    return engine.simulate(static, weather, mask, START, hours, ORIGIN, SpreadSettings(**kw))


def test_flat_calm_grass_is_near_circular() -> None:
    m, c = 64, 32
    out = _run(make_static(m), make_weather(), _ignite(m, c, c), 6)
    e = extents(out.result.arrival_h, c, c)
    assert min(e["N"], e["S"], e["E"], e["W"]) >= 5
    assert max(e["N"], e["S"], e["E"], e["W"]) - min(e["N"], e["S"], e["E"], e["W"]) <= 1
    radius = np.mean([e["N"], e["S"], e["E"], e["W"]])
    assert 0.75 < e["n"] / (np.pi * radius ** 2) < 1.25


def test_wind_from_west_spreads_east_much_faster() -> None:
    m, c = 96, 48
    out = _run(make_static(m), make_weather(speed_kmh=20.0, from_deg=270.0), _ignite(m, c, c), 1)
    e = extents(out.result.arrival_h, c, c)
    assert e["E"] >= 3 * e["W"]
    assert e["E"] > 1.8 * max(e["N"], e["S"])
    assert abs(e["N"] - e["S"]) <= 1


def test_wind_from_south_spreads_north() -> None:
    """Rows are flipped for pyretechnics (y north+): wind FROM 180 must burn toward row 0 (north)."""
    m, c = 96, 48
    out = _run(make_static(m), make_weather(speed_kmh=20.0, from_deg=180.0), _ignite(m, c, c), 1)
    e = extents(out.result.arrival_h, c, c)
    assert e["N"] >= 3 * e["S"]
    assert abs(e["E"] - e["W"]) <= 1


def test_south_facing_slope_burns_uphill_to_the_north() -> None:
    m, c = 64, 32
    out = _run(make_static(m, slope=0.4, aspect=180.0), make_weather(), _ignite(m, c, c), 2)
    e = extents(out.result.arrival_h, c, c)
    assert e["N"] >= 2 * e["S"]
    out2 = _run(make_static(m, slope=0.4, aspect=0.0), make_weather(), _ignite(m, c, c), 2)   # north-facing: rises south
    e2 = extents(out2.result.arrival_h, c, c)
    assert e2["S"] >= 2 * e2["N"]


def test_arrival_is_monotone_away_from_the_ignition() -> None:
    m, c = 64, 32
    a = _run(make_static(m), make_weather(speed_kmh=12.0, from_deg=250.0), _ignite(m, c, c), 2).result.arrival_h
    rays = [a[c, c:], a[c, c::-1], a[c:, c], a[c::-1, c]]
    for ray in rays:
        burned = ray[ray < NEVER * 0.999]
        assert burned.size >= 3
        assert np.all(np.diff(burned) >= -1e-4)
        assert np.all(ray[burned.size:] >= NEVER * 0.999)       # burned cells are contiguous from the ignition


@pytest.mark.parametrize("barrier", [99, 91, 0, 50])
def test_non_burnable_barrier_stops_the_fire(barrier: int) -> None:
    """NB codes (and unknown codes, sanitized to 99) are never crossed, even with a strong tail wind."""
    m, c = 48, 24
    fuel = np.full((m, m), 102, np.int16)
    fuel[:, 30:33] = barrier
    out = _run(make_static(m, fuel=fuel), make_weather(speed_kmh=30.0, from_deg=270.0), _ignite(m, c, 20), 4)
    a = out.result.arrival_h
    assert (a[:, 29] < NEVER).sum() > 10                       # the fire reached the barrier
    assert np.all(a[:, 30:] >= NEVER)                           # and nothing on or beyond it burned


def test_time_conventions_and_no_arrival_before_start() -> None:
    m, c = 48, 24
    out = _run(make_static(m), make_weather(speed_kmh=15.0), _ignite(m, c, c), 5)
    r = out.result
    start_h = (START - ORIGIN) / H
    burned = r.arrival_h < NEVER * 0.999
    assert out.start_h == pytest.approx(start_h) and out.end_h == pytest.approx(start_h + 5)
    assert r.arrival_h[c, c] == pytest.approx(start_h)
    assert np.all(r.arrival_h[burned] >= start_h - 1e-5)
    assert np.all(r.arrival_h[burned] <= start_h + 5 + 1e-4)
    assert np.all(r.arrival_h[~burned] == np.float32(NEVER))
    assert r.arrival_h.dtype == np.float32 and r.flame_length_m.dtype == np.float32 and r.fire_type.dtype == np.uint8
    assert np.all(r.flame_length_m[~burned] == 0) and np.all(r.fire_type[~burned] == 0)
    assert np.all(r.fire_type[burned] >= 1)
    assert r.flame_length_m[c, c] == 0                          # ignition cells carry no behaviour
    assert (r.flame_length_m[burned] > 0).mean() > 0.9
    assert out.spread_rate_m_min.max() > 0
    assert out.stop_condition == "max duration reached"


def test_run_member_contract_matches_simulate() -> None:
    m, c = 48, 24
    st, wx, mask = make_static(m), make_weather(speed_kmh=10.0), _ignite(m, c, c)
    res = engine.run_member(st, wx, mask, START, 3, ORIGIN, SpreadSettings())
    ref = _run(st, wx, mask, 3).result
    assert res.label == "control" and res.runtime_s > 0
    np.testing.assert_array_equal(res.arrival_h, ref.arrival_h)


def test_crown_fire_and_crown_switch() -> None:
    m, c = 48, 24
    st = make_static(m, fuel=165, canopy_cover=0.7, canopy_height=20.0, cbh=1.0, cbd=0.25)   # TU5 under a dense canopy
    wx = make_weather(speed_kmh=45.0, from_deg=270.0, fm1=0.04, fm10=0.05, fm100=0.07)
    on = _run(st, wx, _ignite(m, c, 10), 2)
    off = _run(st, wx, _ignite(m, c, 10), 2, crown=False)
    ft_on = on.result.fire_type[on.result.arrival_h < NEVER]
    ft_off = off.result.fire_type[off.result.arrival_h < NEVER]
    assert np.isin(ft_on, (2, 3)).any()
    assert not np.isin(ft_off, (2, 3)).any()
    assert extents(on.result.arrival_h, c, 10)["E"] >= extents(off.result.arrival_h, c, 10)["E"]


def test_spotting_can_jump_a_fuel_break() -> None:
    """Spotting (off by default) uses the documented pyretechnics spot_config and survives chunked runs."""
    m = 64
    fuel = np.full((m, m), 145, np.int16)                      # SH5 chaparral
    fuel[:, 30:34] = 99                                        # 120 m fuel break
    st = make_static(m, fuel=fuel)
    wx = make_weather(speed_kmh=50.0, from_deg=270.0, fm1=0.03, fm10=0.04, fm100=0.06)
    mask = _ignite(m, 32, 12)
    plain = _run(st, wx, mask, 2).result.arrival_h
    assert np.all(plain[:, 34:] >= NEVER)
    for chunk in (None, 0.5):
        out = engine.simulate(st, wx, mask, START, 2, ORIGIN, SpreadSettings(spotting=True), seed=7, chunk_h=chunk,
                              check=(lambda e, h: True) if chunk else None)
        assert (out.result.arrival_h[:, 34:] < NEVER).sum() > 0


def test_spread_adjustment_scales_spread() -> None:
    m, c = 64, 16
    slow = _run(make_static(m), make_weather(speed_kmh=15.0), _ignite(m, 32, c), 1, spread_adjustment=0.5)
    fast = _run(make_static(m), make_weather(speed_kmh=15.0), _ignite(m, 32, c), 1, spread_adjustment=2.0)
    assert extents(fast.result.arrival_h, 32, c)["E"] > 2.5 * extents(slow.result.arrival_h, 32, c)["E"]


def test_weather_refinement_keeps_north_up_rows() -> None:
    """The 4 x 4 grid is [t][j][i] with j north->south; in the cube (y north+) the north row must be last."""
    wx = make_weather(hours=3)
    wx.wind_speed_10m_kmh[:, 0, :] = 40.0         # northern row of weather cells: strong
    wx.wind_speed_10m_kmh[:, 3, :] = 0.0          # southern row: calm
    wb = engine.weather_bases(wx, 64)
    assert wb.wind_speed_10m.shape == (3, 32, 32)
    assert wb.wind_speed_10m[:, -1, :].mean() > 30.0 and wb.wind_speed_10m[:, 0, :].mean() < 5.0
    assert wb.origin_ms == ORIGIN - H // 2
    np.testing.assert_allclose(wb.upwind_direction[wb.wind_speed_10m > 1.0], 270.0, atol=1e-3)


def test_weather_gaps_and_persistence() -> None:
    m, c = 48, 24
    wx = make_weather(t0=START - 2 * H, hours=4, speed_kmh=15.0)            # ends 2 h after the start
    wx.wind_speed_10m_kmh[2] = np.nan
    wx.fm1[1] = np.nan
    out = _run(make_static(m), wx, _ignite(m, c, c), 6)
    assert any("persistence" in w for w in out.warnings)
    late = make_weather(t0=START + 2 * H, hours=8, speed_kmh=15.0)          # starts after the simulation start
    out2 = _run(make_static(m), late, _ignite(m, c, c), 3)
    assert any("starts" in w for w in out2.warnings)
    wb = engine.weather_bases(wx, m, end_ms=START + 6 * H)
    assert np.isfinite(wb.wind_speed_10m).all() and np.isfinite(wb.fm1).all()
    assert wb.padded_hours >= 4
    with pytest.raises(ValueError):
        bad = make_weather(hours=3)
        bad.t_ms = bad.t_ms * 2
        engine.weather_bases(bad, m)


def test_fill_nan_time_uses_nearest_hour() -> None:
    a = np.array([np.nan, 1.0, np.nan, np.nan, 4.0, np.nan])
    np.testing.assert_allclose(engine.fill_nan_time(a, -1.0), [1.0, 1.0, 1.0, 4.0, 4.0, 4.0])
    np.testing.assert_allclose(engine.fill_nan_time(np.full(3, np.nan), 7.0), [7.0, 7.0, 7.0])


def test_prepare_static_sanitizes() -> None:
    st = make_static(8, fuel=102, canopy_cover=0.6, canopy_height=15.0, cbh=2.0, cbd=0.1)
    st.fuel_model[0, :4] = [0, 94, 300, 91]
    st.canopy_height[1, :] = 0.0
    st.slope[2, 0] = np.nan
    st.aspect[3, 0] = -90.0
    p = engine.prepare_static(st, SpreadSettings())
    assert list(p.fuel_model[0, :4]) == [99, 99, 99, 91]
    assert np.all(p.canopy_base_height[1] == engine.NO_CROWN_CBH_M)
    assert np.all(p.canopy_base_height[2] == 2.0)
    assert p.slope[2, 0] == 0.0 and p.aspect[3, 0] == pytest.approx(270.0)
    off = engine.prepare_static(st, SpreadSettings(crown=False))
    assert np.all(off.canopy_base_height == engine.NO_CROWN_CBH_M)
    assert not engine.is_burnable_code(np.array([0, 91, 99, 94])).any()
    assert engine.is_burnable_code(np.array([101, 102, 165, 204])).all()


def test_snap_to_burnable_and_edges() -> None:
    fuel = np.full((20, 20), 91, np.int16)
    fuel[10, 15] = 102
    assert engine.snap_to_burnable(fuel, 10, 10, 6.0) == (10, 15)
    assert engine.snap_to_burnable(fuel, 10, 10, 4.0) is None
    a = np.full((10, 10), NEVER, np.float32)
    assert not engine.reached_edge(a)
    a[0, 5] = 3.0
    assert engine.reached_edge(a)


def test_chunked_run_and_abort() -> None:
    m, c = 48, 24
    st, wx, mask = make_static(m), make_weather(speed_kmh=12.0), _ignite(m, c, c)
    one = _run(st, wx, mask, 6).result.arrival_h
    chunked = engine.simulate(st, wx, mask, START, 6, ORIGIN, SpreadSettings(), chunk_h=2.0, check=lambda e, h: True).result.arrival_h
    b1, b2 = one < NEVER, chunked < NEVER
    assert np.sum(b1 ^ b2) <= 0.02 * b1.sum()
    both = b1 & b2
    assert np.abs(one[both] - chunked[both]).mean() < 0.1           # hours
    seen = []

    def stop(elapsed, sim_h):
        seen.append(sim_h)
        return False

    with pytest.raises(engine.SimulationAborted):
        engine.simulate(st, wx, mask, START, 6, ORIGIN, SpreadSettings(), chunk_h=2.0, check=stop)
    assert seen and seen[0] == pytest.approx(2.0, abs=0.01)


def test_odd_resolution_chunked_and_coarse() -> None:
    """res = 8000/272 m is not exact in float32 (pyretechnics stores it as float32): chunked runs must still resume,
    and M = 272 (weather base 17 x 17) must downsample to 136."""
    m, res = 272, 8000.0 / 272
    st = make_static(m, res=res)
    mask = _ignite(m, 136, 136)
    wx = make_weather(speed_kmh=15.0)
    assert engine.weather_grid_size(m) == 17 and engine.weather_grid_size(m // 2) == 17
    out = engine.simulate(st, wx, mask, START, 3, ORIGIN, SpreadSettings(), chunk_h=1.0, check=lambda e, h: True)
    assert (out.result.arrival_h < NEVER).sum() > 50 and out.sim_res_m == pytest.approx(res)
    coarse = engine.simulate_downsampled(st, wx, mask, START, 3, ORIGIN, SpreadSettings())
    assert coarse.result.arrival_h.shape == (m, m) and coarse.sim_res_m == pytest.approx(2 * res)


def test_downsample_round_trip() -> None:
    m, c = 48, 24
    fuel = np.full((m, m), 102, np.int16)
    fuel[:, 40:] = 99
    st = make_static(m, fuel=fuel)
    cs = engine.downsample_static(st, 2)
    assert cs.fuel_model.shape == (24, 24) and cs.res_m == 60.0 and cs.fuel_model[0, 23] == 99
    mask = _ignite(m, c, c)
    assert engine.downsample_mask(mask, 2).sum() == 1
    out = engine.simulate_downsampled(st, make_weather(speed_kmh=20.0), mask, START, 4, ORIGIN, SpreadSettings())
    a = out.result.arrival_h
    assert a.shape == (m, m) and out.factor == 2 and out.sim_res_m == 60.0
    assert a[c, c] == pytest.approx((START - ORIGIN) / H)
    assert np.all(a[:, 40:] >= NEVER)
    assert (a < NEVER).sum() > 20
    np.testing.assert_array_equal(engine.upsample_nearest(np.arange(4).reshape(2, 2), 2)[1:3, 1:3], [[0, 1], [2, 3]])


def test_load_static_inputs(tmp_path) -> None:
    st = make_static(16)
    arrays = {k: getattr(st, k) for k in ("fuel_model", "slope", "aspect", "canopy_cover", "canopy_height",
                                          "canopy_base_height", "canopy_bulk_density", "elevation")}
    bundle.write_npz(tmp_path / bundle.STATIC_NPZ, **arrays, res_m=np.float64(25.0))
    got = engine.load_static_inputs(tmp_path)
    assert got.res_m == 25.0 and got.fuel_model.dtype == np.int16 and got.slope.dtype == np.float32
    b2 = tmp_path / "b2"
    bundle.write_npz(b2 / bundle.STATIC_NPZ, **arrays)
    bundle.save_manifest(b2, {"grid": {"fire": {"width": 16, "height": 16, "res_m": 31.25}}})
    assert engine.load_static_inputs(b2).res_m == 31.25
    with pytest.raises(FileNotFoundError):
        engine.load_static_inputs(tmp_path / "missing")
    bad = dict(arrays)
    del bad["slope"]
    bundle.write_npz(tmp_path / "b3" / bundle.STATIC_NPZ, **bad, res_m=np.float64(30.0))
    with pytest.raises(ValueError):
        engine.load_static_inputs(tmp_path / "b3")


def test_fixture_static_inputs_load(fixture_bundle) -> None:
    st = engine.load_static_inputs(fixture_bundle)
    assert st.fuel_model.shape == (400, 400) and st.res_m == pytest.approx(30.0)
    assert engine.is_burnable_code(st.fuel_model).mean() > 0.5
