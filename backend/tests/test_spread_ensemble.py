"""spread/ensemble.py: quantile semantics, run_forecast end to end on a synthetic bundle, fallbacks, manifest."""

from __future__ import annotations

import re

import numpy as np
import pytest

import fire3d.build.weather_bundle as weather_bundle
from fire3d import bundle, config
from fire3d.contracts import ForecastManifest, contract_problems
from fire3d.spread import ensemble
from test_spread_support import ORIGIN, H, make_bundle, make_weather

NEVER = np.float32(config.NEVER)


def _fake_members(calls: list | None = None, n: int = 10, windy: tuple[int, ...] = (0,)):
    """member_weathers stand-in: ``windy`` members get a strong west wind, the others calm."""

    def fake(bundle_dir, start_ms, horizon_h, ens, members=None):
        if calls is not None:
            calls.append((start_ms, horizon_h, ens, members))
        k = members or n
        return [make_weather(t0=ORIGIN - 72 * H, hours=300, speed_kmh=40.0 if i in windy else 0.0,
                             label=f"member{i:02d}") for i in range(k)]

    return fake


def test_order_statistic_quantiles() -> None:
    assert ensemble.order_rank(10, 10) == 0 and ensemble.order_rank(10, 50) == 4 and ensemble.order_rank(10, 90) == 8
    assert ensemble.order_rank(31, 50) == 15 and ensemble.order_rank(31, 10) == 3 and ensemble.order_rank(31, 90) == 27
    assert ensemble.order_rank(1, 90) == 0 and ensemble.order_rank(51, 50) == 25
    stack = np.full((10, 2, 2), NEVER, np.float32)
    stack[3, 0, 0] = 5.0                                        # 1 of 10 members burns pixel (0, 0)
    stack[:, 1, 1] = np.arange(10, 20)                          # every member burns pixel (1, 1)
    stack[:5, 0, 1] = 7.0                                       # half the members burn pixel (0, 1)
    q = ensemble.quantile_maps(stack)
    assert q[10][0, 0] == 5.0 and q[50][0, 0] == NEVER and q[90][0, 0] == NEVER
    assert q[10][1, 1] == 10 and q[50][1, 1] == 14 and q[90][1, 1] == 18
    assert q[50][0, 1] == 7.0 and q[90][0, 1] == NEVER
    bp = ensemble.burn_probability(stack, 100.0)
    assert bp[0, 0] == pytest.approx(0.1) and bp[0, 1] == pytest.approx(0.5) and bp[1, 1] == 1.0 and bp[1, 0] == 0.0
    # P(burned by t) >= K%  <=>  arrival_pK <= t, at every pixel and time
    for t in (4.0, 5.0, 7.0, 12.0, 14.0, 19.0):
        frac = (stack <= t).mean(axis=0)
        for k, m in q.items():
            np.testing.assert_array_equal(frac >= k / 100.0 - 1e-9, m <= t)


def test_flame_area_and_ros_series() -> None:
    arr = np.full((3, 4, 4), NEVER, np.float32)
    arr[:, 0, 0] = 10.0
    arr[0, 0, 1] = 11.5
    arr[1, 0, 1] = 12.0
    flame = np.zeros((3, 4, 4), np.float32)
    flame[0, 0, 1], flame[1, 0, 1], flame[2, 0, 1] = 2.0, 4.0, 99.0     # member 2 did not burn (0, 1)
    fl = ensemble.flame_length_p50(arr, flame)
    assert fl[0, 1] == pytest.approx(3.0) and fl[3, 3] == 0.0
    a = ensemble.area_acres_series(arr[0], 10.0, 3, 30.0)
    cell = 900.0 / config.ACRE_M2
    np.testing.assert_allclose(a, [cell, cell, 2 * cell, 2 * cell])
    ros = np.zeros((4, 4), np.float32)
    ros[0, 1] = 10.0                                            # m/min
    ign = np.zeros((4, 4), bool)
    ign[0, 0] = True
    s = ensemble.ros_series_ch_h(arr[0], ros, ign, 10.0, 3)
    np.testing.assert_allclose(s, [0.0, 0.0, 10.0 * 60 / config.CHAIN_M, 0.0])
    sq = ensemble.series_quantile(np.array([[1.0, 5.0], [2.0, 6.0], [3.0, 7.0]]), 50)
    np.testing.assert_allclose(sq, [2.0, 6.0])


def test_resolve_ensemble_and_run_id() -> None:
    assert ensemble.resolve_ensemble("live", "auto") == "gfs025"
    assert ensemble.resolve_ensemble("historical", "auto") == "perturbed"
    assert ensemble.resolve_ensemble("historical", "ECMWF_IFS025") == "ecmwf_ifs025"
    with pytest.raises(ValueError):
        ensemble.resolve_ensemble("live", "hrrr")
    rid = ensemble.make_run_id(1736362800000, "perturbed", "x")
    assert re.fullmatch(r"fc-20250108T1900-perturbed-[0-9a-f]{4}", rid)
    assert ensemble.make_run_id(1736362800000, "perturbed", "y") != rid


def test_run_forecast_end_to_end(tmp_data_dir, monkeypatch) -> None:
    bdir = make_bundle(tmp_data_dir / "incidents")
    calls: list = []
    monkeypatch.setattr(weather_bundle, "member_weathers", _fake_members(calls, n=10, windy=(0,)))
    start = ORIGIN + 8 * H
    fm = ensemble.run_forecast(bdir, start_ms=start, horizon_h=12, ensemble="auto", workers=1)
    assert calls == [(start, 12, "perturbed", None)]
    assert re.fullmatch(r"fc-\d{8}T\d{4}-perturbed-[0-9a-f]{4}", fm.run_id)
    doc = (bdir / "forecasts" / fm.run_id / "forecast.json").read_bytes()
    assert contract_problems(ForecastManifest, doc) == []
    assert fm.status == "ready" and fm.weather.members == 10 and fm.weather.ensemble == "perturbed"
    assert fm.start_ms == start and fm.horizon_h == 12 and fm.time_origin_ms == ORIGIN
    assert fm.model.engine == "pyretechnics" and fm.model.grid_res_m == 30.0 and fm.model.crown
    man = bundle.load_manifest(bdir)
    assert man["forecasts"][0]["run_id"] == fm.run_id and man["forecasts"][0]["status"] == "ready"
    assert man["forecasts"][0]["file"] == f"forecasts/{fm.run_id}/forecast.json"
    m = 48
    lay = {k: bundle.read_array(bdir, getattr(fm.layers, k).model_dump()) for k in
           ("arrival_p10", "arrival_p50", "arrival_p90", "burn_probability", "flame_length_p50")}
    for k, a in lay.items():
        assert a.shape == (m, m) and a.dtype == np.float32, k
    start_h = (start - ORIGIN) / H
    for k in ("arrival_p10", "arrival_p50", "arrival_p90"):
        a = lay[k]
        assert np.all(a[a < NEVER] >= start_h - 1e-4)                   # no arrival before the start
        assert np.all(a[a < NEVER] <= start_h + 12 + 1e-3)
    assert np.all(lay["arrival_p10"] <= lay["arrival_p50"]) and np.all(lay["arrival_p50"] <= lay["arrival_p90"])
    # pixels only the windy member reaches: p10 finite, p50 NEVER, burn probability 0.1
    only_one = (lay["arrival_p10"] < NEVER) & (lay["arrival_p50"] >= NEVER)
    assert only_one.sum() > 20
    np.testing.assert_allclose(lay["burn_probability"][only_one], 0.1, atol=1e-6)
    assert np.all(lay["burn_probability"][lay["arrival_p50"] < NEVER] >= 0.5)
    assert lay["flame_length_p50"][only_one].max() > 0
    obs = bundle.read_layer(bdir, "observed_arrival")
    init = obs <= start_h
    assert np.all(lay["arrival_p90"][init] == np.float32(start_h)) and np.all(lay["burn_probability"][init] == 1.0)
    s = fm.series
    assert len(s.t_ms) == 13 and s.t_ms[0] == start and s.t_ms[-1] == start + 12 * H
    assert s.area_acres_p10[0] == pytest.approx(init.sum() * 900 / config.ACRE_M2, abs=0.051)   # rounded to 0.1 ac
    assert all(np.diff(s.area_acres_p50) >= 0) and all(a <= b <= c for a, b, c in zip(s.area_acres_p10, s.area_acres_p50, s.area_acres_p90))
    # 1 windy member of 10 is above the 90th percentile (rank 9 of 10 is a calm member): p90 == p50 here
    assert s.area_acres_p90[-1] == s.area_acres_p50[-1] and s.area_acres_p50[-1] > s.area_acres_p50[0]
    assert fm.skill and [e.lead_h for e in fm.skill] == [12.0]        # 24-72 h exceed the 12 h horizon
    assert 0.0 <= fm.skill[0].sorensen <= 1.0 and fm.skill[0].observed_acres > 0
    assert any(w.startswith("timing:") for w in fm.warnings)


def test_run_forecast_process_pool_matches_serial(tmp_data_dir, monkeypatch) -> None:
    bdir = make_bundle(tmp_data_dir / "incidents", iid="pool-test", m=32, ignition_rc=(16, 10))
    monkeypatch.setattr(weather_bundle, "member_weathers", _fake_members(n=3, windy=(0, 2)))
    start = ORIGIN + 6 * H
    a = ensemble.run_forecast(bdir, start_ms=start, horizon_h=4, workers=2)
    b = ensemble.run_forecast(bdir, start_ms=start, horizon_h=4, workers=1)
    assert a.run_id != b.run_id
    for k in ("arrival_p10", "arrival_p50", "burn_probability"):
        np.testing.assert_array_equal(bundle.read_array(bdir, getattr(a.layers, k).model_dump()),
                                      bundle.read_array(bdir, getattr(b.layers, k).model_dump()))
    runs = [f["run_id"] for f in bundle.load_manifest(bdir)["forecasts"]]
    assert runs[:2] == [b.run_id, a.run_id]                            # newest first


def test_downsample_fallback_when_members_are_too_slow(tmp_data_dir, monkeypatch) -> None:
    bdir = make_bundle(tmp_data_dir / "incidents", iid="slow-test")
    monkeypatch.setattr(weather_bundle, "member_weathers", _fake_members(n=3, windy=(1,)))
    monkeypatch.setattr(ensemble, "MIN_MEMBER_CAP_S", 0.0)
    monkeypatch.setattr(ensemble, "CHUNK_H", 1.0)
    fm = ensemble.run_forecast(bdir, start_ms=ORIGIN + 8 * H, horizon_h=6, workers=1, budget_s=1e-6)
    assert fm.model.grid_res_m == 60.0
    assert any("downsampled grid" in w for w in fm.warnings)
    p50 = bundle.read_array(bdir, fm.layers.arrival_p50.model_dump())
    assert p50.shape == (48, 48) and (p50 < NEVER).sum() > 0


def test_weather_json_fallback(tmp_data_dir, monkeypatch) -> None:
    bdir = make_bundle(tmp_data_dir / "incidents", iid="fallback-test", m=32, ignition_rc=(16, 10))

    def broken(*a, **k):
        raise NotImplementedError("member_weathers is not ready")

    monkeypatch.setattr(weather_bundle, "member_weathers", broken)
    fm = ensemble.run_forecast(bdir, start_ms=ORIGIN + 8 * H, horizon_h=6, members=4, workers=1)
    assert fm.weather.ensemble == "perturbed" and fm.weather.members == 4
    assert "fallback" in fm.weather.source
    assert any("unavailable" in w for w in fm.warnings)
    mws, kind = ensemble.members_from_weather_json(bdir, ORIGIN + 8 * H, 6, "perturbed", 3)
    assert kind == "perturbed" and [m.label for m in mws] == ["control", "perturbed-01", "perturbed-02"]
    assert mws[0].t_ms[0] <= ORIGIN + 8 * H and mws[0].t_ms[-1] >= ORIGIN + 14 * H
    assert not np.allclose(mws[1].wind_speed_10m_kmh, mws[0].wind_speed_10m_kmh)
    assert np.all((mws[1].fm1 > 0) & (mws[1].fm1 < 0.6))
    one, kind1 = ensemble.members_from_weather_json(bdir, ORIGIN + 8 * H, 6, "none")
    assert kind1 == "none" and len(one) == 1


def test_ignition_fallback_when_nothing_burned_yet(tmp_data_dir, monkeypatch) -> None:
    obs = np.full((48, 48), NEVER, np.float32)
    fuel = np.full((48, 48), 102, np.int16)
    fuel[24, 16] = 91                                                  # the ignition cell itself is urban
    bdir = make_bundle(tmp_data_dir / "incidents", iid="ign-test", observed=obs, fuel=fuel, t_ign_h=10.0)
    monkeypatch.setattr(weather_bundle, "member_weathers", _fake_members(n=2, windy=()))
    fm = ensemble.run_forecast(bdir, start_ms=ORIGIN + 4 * H, horizon_h=12, workers=1)
    p50 = bundle.read_array(bdir, fm.layers.arrival_p50.model_dump())
    assert p50.min() == pytest.approx(10.0)                           # ignites at the ignition time, not the start
    assert p50[24, 16] >= NEVER and (p50 < NEVER).sum() > 1
    assert any("ignited the ignition cell" in w for w in fm.warnings)
    assert any("not burnable" in w for w in fm.warnings)
    assert fm.series.area_acres_p50[0] == 0.0


def test_failed_run_is_recorded(tmp_data_dir, monkeypatch) -> None:
    bdir = make_bundle(tmp_data_dir / "incidents", iid="err-test", m=32, ignition_rc=(16, 10))

    def bad(*a, **k):
        w = make_weather(t0=ORIGIN, hours=40)
        w.t_ms = w.t_ms * 2                                            # not hourly -> simulate raises
        return [w]

    monkeypatch.setattr(weather_bundle, "member_weathers", bad)
    with pytest.raises(ensemble.ForecastError):
        ensemble.run_forecast(bdir, start_ms=ORIGIN + 8 * H, horizon_h=6, ensemble="none", workers=1)
    entry = bundle.load_manifest(bdir)["forecasts"][0]
    assert entry["status"] == "error" and entry["ensemble"] == "none"
    doc = (bdir / entry["file"]).read_bytes()
    assert contract_problems(ForecastManifest, doc) == []
    assert bundle.read_json(bdir / entry["file"])["error"]


def test_live_defaults_and_stale_entries(tmp_data_dir, monkeypatch) -> None:
    bdir = make_bundle(tmp_data_dir / "incidents", iid="live-test", m=32, ignition_rc=(16, 10), mode="live", data_end_h=10.0)
    bundle.update_manifest(bdir, lambda m: m.__setitem__("forecasts", [
        {"run_id": "fc-old", "status": "running", "issued_ms": 1, "start_ms": ORIGIN, "horizon_h": 72,
         "ensemble": "gfs025", "members": 31, "file": "forecasts/fc-old/forecast.json"}]))
    calls: list = []
    monkeypatch.setattr(weather_bundle, "member_weathers", _fake_members(calls, n=2))
    fm = ensemble.run_forecast(bdir, horizon_h=6, workers=1)
    assert calls[0][0] == ORIGIN + 10 * H and calls[0][2] == "gfs025"     # live: start = now_ms, auto = gfs025
    assert fm.start_ms == ORIGIN + 10 * H and fm.weather.ensemble == "gfs025"
    assert fm.skill is None                                               # nothing observed after "now"
    fl = bundle.load_manifest(bdir)["forecasts"]
    assert fl[0]["run_id"] == fm.run_id and fl[1] == {**fl[1], "run_id": "fc-old", "status": "error"}


def test_default_historical_start() -> None:
    man = {"mode": "historical", "time_origin_ms": ORIGIN, "ignition": {"t_ms": ORIGIN + 2 * H}}
    assert ensemble.default_start_ms(man) == ORIGIN + 26 * H
    man2 = {"mode": "historical", "time_origin_ms": ORIGIN, "summary": {"started_ms": ORIGIN + H}}
    assert ensemble.default_start_ms(man2) == ORIGIN + 25 * H
    # a historical bundle's final extent stays valid after growth ends: until containment, else end + 7 days
    assert ensemble.data_end_ms({"mode": "historical", "time_range": {"end_ms": 5, "now_ms": 5}}) == 5 + ensemble.HISTORICAL_FINAL_MS
    assert ensemble.data_end_ms({"mode": "historical", "time_range": {"end_ms": 5, "now_ms": 5},
                                 "summary": {"contained_ms": 9 * H}}) == 9 * H
