"""spread/behavior.py: head-fire surface behaviour and the weather.json annotation."""

from __future__ import annotations

import shutil

import numpy as np
import pytest

from fire3d import bundle, config
from fire3d.contracts import WeatherFile, contract_problems
from fire3d.spread import behavior, engine
from fire3d.types import SpreadSettings
from test_spread_support import ORIGIN, H, make_bundle, make_static, make_weather

DRY = dict(fm1=0.06, fm10=0.08, fm100=0.10, fm_live_herb=0.3, fm_live_woody=0.7)


def _b(code=102, wind=20.0, slope=0.0, **kw):
    args = {**DRY, **{k: v for k, v in kw.items() if k in DRY}}
    extra = {k: v for k, v in kw.items() if k not in DRY}
    return behavior.surface_behavior(code, args["fm1"], args["fm10"], args["fm100"], args["fm_live_herb"],
                                     args["fm_live_woody"], wind, slope, **extra)


def test_matches_the_level_set_head_fire() -> None:
    """burn_cell_as_head_fire and the level-set solver agree on the head-fire rate (two pyretechnics code paths)."""
    b = _b(102, 20.0, 0.0)
    m, c = 64, 16
    mask = np.zeros((m, m), bool)
    mask[32, c] = True
    out = engine.simulate(make_static(m), make_weather(speed_kmh=20.0), mask, ORIGIN + 3 * H, 1, ORIGIN, SpreadSettings())
    assert b["ros_m_per_min"] == pytest.approx(float(out.spread_rate_m_min.max()), rel=0.02)
    assert b["flame_length_m"] == pytest.approx(float(out.result.flame_length_m.max()), rel=0.02)
    assert b["ros_ch_per_h"] == pytest.approx(b["ros_m_per_min"] * 60 / config.CHAIN_M)
    assert b["flame_length_ft"] == pytest.approx(b["flame_length_m"] / 0.3048)
    assert b["burnable"] and b["fire_type"] == 1 and b["fireline_intensity_kw_m"] > 0
    assert 5.0 < b["ros_m_per_min"] < 25.0 and 0.5 < b["flame_length_m"] < 3.0     # GR2, 20 km/h, cured


def test_behaviour_responds_to_wind_slope_moisture_and_shelter() -> None:
    base = _b(102, 10.0)
    assert _b(102, 30.0)["ros_m_per_min"] > 2 * base["ros_m_per_min"]
    assert _b(102, 10.0, 0.6)["ros_m_per_min"] > base["ros_m_per_min"]
    assert _b(102, 10.0, fm1=0.12, fm10=0.14)["ros_m_per_min"] < base["ros_m_per_min"]
    open_ = _b(165, 25.0)
    sheltered = _b(165, 25.0, canopy_cover=0.8, canopy_height_m=25.0)
    assert sheltered["ros_m_per_min"] < open_["ros_m_per_min"]
    assert sheltered["fire_type"] == 1                                       # surface only, never crowns
    assert _b(145, 20.0)["flame_length_m"] > _b(181, 20.0)["flame_length_m"]  # SH5 chaparral vs TL1 litter
    for code in (91, 98, 99, 0, 57):
        z = _b(code, 30.0)
        assert z["ros_m_per_min"] == 0.0 and z["flame_length_ft"] == 0.0 and not z["burnable"]
    assert _b(102, 20.0, spread_adjustment=2.0)["ros_m_per_min"] == pytest.approx(2 * _b(102, 20.0)["ros_m_per_min"], rel=1e-4)


def test_fbfm40_code_table_is_accepted() -> None:
    """All 40 FBFM40 burnable models are in pyretechnics' table and burn; the 5 NB codes never do."""
    fbfm40 = [*range(101, 110), *range(121, 125), *range(141, 150), *range(161, 166), *range(181, 190), *range(201, 205)]
    assert len(fbfm40) == 40 and engine.is_burnable_code(np.array(fbfm40)).all()
    for code in fbfm40:
        assert _b(code, 30.0, 0.2, fm1=0.04, fm10=0.05, fm100=0.07)["ros_m_per_min"] > 0, code
    assert not engine.is_burnable_code(np.array([91, 92, 93, 98, 99])).any()
    assert set(engine._known_fuel_codes().tolist()) >= set(fbfm40) | {91, 92, 93, 98, 99}


def test_front_cells_follow_the_observed_arrival() -> None:
    m = 48
    obs = np.full((m, m), config.NEVER, np.float32)
    obs[10, 10] = 2.0
    obs[10, 30] = 5.5
    obs[40, 40] = 9.0
    man = {"time_origin_ms": ORIGIN, "ignition": {"x": -(m * 30) / 2 + 10.5 * 30, "z": -(m * 30) / 2 + 10.5 * 30}}
    t = ORIGIN + np.array([0, 2, 3, 6, 7, 9, 30]) * H
    cells = behavior.front_cells(man, obs, (m, m), 30.0, t)
    np.testing.assert_allclose(cells[0], [10, 10], atol=1e-6)                # before ignition: ignition cell
    np.testing.assert_allclose(cells[1], [10, 10])                            # burned in (1, 2]
    np.testing.assert_allclose(cells[2], [10, 10])                            # nothing in (2, 3]: most recent
    np.testing.assert_allclose(cells[3], [10, 30])
    np.testing.assert_allclose(cells[4], [10, 20])                            # mean of the burned pixels so far
    np.testing.assert_allclose(cells[5], [40, 40])
    z = behavior.fuel_zone(make_static(m, fuel=145, slope=0.3), 24.0, 24.0)
    assert z["fuel_code"] == 145 and z["share"] == 1.0 and z["slope"] == pytest.approx(0.3)
    assert behavior.fuel_zone(make_static(m, fuel=99), 24.0, 24.0) is None


def test_annotate_follows_the_front_into_new_fuel(tmp_path, monkeypatch) -> None:
    m = 48
    fuel = np.full((m, m), 102, np.int16)
    fuel[:, 30:] = 145                                                        # chaparral east of column 30
    obs = np.full((m, m), config.NEVER, np.float32)
    obs[20:28, 8:14] = 2.5                                                    # first run in the grass (west)
    obs[20:28, 36:42] = 20.5                                                  # later run in the chaparral (east)
    bdir = make_bundle(tmp_path, fuel=fuel, observed=obs, ignition_rc=(24, 10))
    monkeypatch.setattr(behavior, "ZONE_RADIUS_M", 300.0)                     # 10 cells: zones stay local
    behavior.annotate_weather_with_behavior(bdir)
    assert contract_problems(WeatherFile, (bdir / "weather.json").read_bytes()) == []
    w = bundle.read_json(bdir / "weather.json")
    af = w["at_fire"]
    fl = np.array(af["flame_length_ft"])
    ros = np.array(af["ros_ch_per_h_potential"])
    assert len(fl) == len(ros) == len(w["t_ms"])
    assert np.all(np.isfinite(fl)) and np.all(fl > 0) and np.all(ros > 0)

    def expect(code: int, hour: float) -> dict:
        k = int(np.searchsorted(np.array(w["t_ms"]), ORIGIN + int(hour * H)))
        return k, behavior.surface_behavior(code, af["fm1_pct"][k] / 100, af["fm10_pct"][k] / 100, af["fm100_pct"][k] / 100,
                                            0.3, 0.7, af["wind_speed_ms"][k] * 3.6, 0.0)

    for code, hour in ((102, 0.0), (102, 3.0), (102, 10.0), (145, 21.0), (145, 50.0)):
        k, b = expect(code, hour)
        assert fl[k] == pytest.approx(b["flame_length_ft"], abs=0.01), (code, hour)
        assert ros[k] == pytest.approx(b["ros_ch_per_h"], abs=0.01), (code, hour)


def test_annotate_degrades_gracefully(tmp_path) -> None:
    bdir = make_bundle(tmp_path, iid="no-static")
    (bdir / bundle.STATIC_NPZ).unlink()
    before = (bdir / "weather.json").read_bytes()
    behavior.annotate_weather_with_behavior(bdir)                            # no static inputs: unchanged
    assert (bdir / "weather.json").read_bytes() == before
    behavior.annotate_weather_with_behavior(tmp_path / "nothing-here")        # no weather.json: no error
    b2 = make_bundle(tmp_path, iid="no-fm")
    w = bundle.read_json(b2 / "weather.json")
    for k in ("fm1_pct", "fm10_pct", "fm100_pct"):
        del w["at_fire"][k]
    bundle.write_json(b2 / "weather.json", w)
    behavior.annotate_weather_with_behavior(b2)                              # fuel moisture from temperature/RH
    w2 = bundle.read_json(b2 / "weather.json")
    assert len(w2["at_fire"]["flame_length_ft"]) == len(w2["t_ms"]) and max(w2["at_fire"]["flame_length_ft"]) > 0


def test_annotate_fixture_copy(fixture_bundle, tmp_path) -> None:
    dst = tmp_path / "demo"
    shutil.copytree(fixture_bundle, dst, ignore=shutil.ignore_patterns("forecasts", "naip.jpg", "trees.bin", "elevation.bin"))
    behavior.annotate_weather_with_behavior(dst)
    assert contract_problems(WeatherFile, (dst / "weather.json").read_bytes()) == []
    af = bundle.read_json(dst / "weather.json")["at_fire"]
    assert 0 < max(af["flame_length_ft"]) < 200 and 0 < max(af["ros_ch_per_h_potential"]) < 2000
