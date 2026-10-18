"""Live forecast start (docs/validation.md section 6): held perimeter with activity markers and CAL FIRE containment,
the decay clock counted from the last activity, and run_forecast on a live bundle with sim/activity.json."""

from __future__ import annotations

import dataclasses
import math

import numpy as np
import pytest

import fire3d.build.weather_bundle as weather_bundle
from fire3d import bundle, config
from fire3d.build import live_observation as lo
from fire3d.contracts import ForecastManifest, contract_problems
from fire3d.spread import engine, ensemble
from fire3d.types import SpreadSettings
from test_spread_support import ORIGIN, H, make_bundle, make_weather

NEVER = np.float32(config.NEVER)


def _disk_observed(m: int = 40, r0: int = 20, c0: int = 20, radius: float = 6.0, t: float = 5.0) -> np.ndarray:
    rr, cc = np.mgrid[0:m, 0:m]
    obs = np.full((m, m), NEVER, np.float32)
    obs[np.hypot(rr - r0, cc - c0) <= radius] = t
    return obs


def test_markers_keep_the_nearby_perimeter_active() -> None:
    res, m = 50.0, 100
    obs = _disk_observed(m, 50, 50, 30.0, t=5.0)       # 1.5 km radius, burned at 5 h; start at 30 h: window is quiet
    half = m * res / 2
    mask, st = ensemble.held_perimeter(obs, 30.0, res, ORIGIN, None)
    assert st["held_fraction"] == 1.0 and mask is not None
    # a GOES-like marker (1 km radius) 2 h before the start on the east edge: the east perimeter stays active
    x_east = (50 + 31 + 0.5) * res - half
    z_mid = (50 + 0.5) * res - half
    mk = np.array([[x_east, z_mid, ORIGIN + 28 * H, 1000.0]])
    mask2, st2 = ensemble.held_perimeter(obs, 30.0, res, ORIGIN, None, markers=mk)
    assert st2["markers"] == 1 and 0.0 < st2["held_fraction"] < 1.0
    assert not mask2[50, 81] and mask2[50, 19]          # east edge not held, west edge held
    # markers after the start count too; markers older than the window do not
    late = mk.copy(); late[0, 2] = ORIGIN + 31 * H
    old = mk.copy(); old[0, 2] = ORIGIN + 10 * H
    assert ensemble.held_perimeter(obs, 30.0, res, ORIGIN, None, markers=late)[1]["held_fraction"] < 1.0
    assert ensemble.held_perimeter(obs, 30.0, res, ORIGIN, None, markers=old)[1]["held_fraction"] == 1.0


def test_containment_sets_a_minimum_held_share() -> None:
    res, m = 50.0, 100
    obs = _disk_observed(m, 50, 50, 30.0, t=5.0)
    rr, cc = np.mgrid[0:m, 0:m]
    obs[(obs < NEVER) & (cc >= 45)] = 29.0              # the east part burned 1 h before the start
    _, st0 = ensemble.held_perimeter(obs, 30.0, res, ORIGIN, None)
    assert 0.0 < st0["held_fraction"] < 0.4 and "contained_fraction" not in st0
    mask, st = ensemble.held_perimeter(obs, 30.0, res, ORIGIN, None, min_held_fraction=0.6)
    assert st["contained_fraction"] == 0.6 and st["held_fraction_with_containment"] >= 0.6
    rows, cols = np.nonzero(mask)
    assert cols.mean() < 45                             # the extra held part is the side away from the activity
    _, st_full = ensemble.held_perimeter(obs, 30.0, res, ORIGIN, None, min_held_fraction=1.0)
    assert st_full["held_fraction_with_containment"] == 1.0
    # never less than the observation hold
    _, st_q = ensemble.held_perimeter(_disk_observed(m, 50, 50, 30.0, t=5.0), 30.0, res, ORIGIN, None, min_held_fraction=0.2)
    assert st_q["held_fraction"] == 1.0 and "contained_fraction" not in st_q


def test_adjustment_origin_shifts_the_decay() -> None:
    st = SpreadSettings(spread_adjustment=0.5, adjustment_decay_h=12.0, adjustment_floor=0.1)
    a = engine.adjustment_series(st, ORIGIN, 4, ORIGIN)
    b = engine.adjustment_series(dataclasses.replace(st, adjustment_origin_ms=ORIGIN - 12 * H), ORIGIN, 4, ORIGIN)
    assert a[0] == pytest.approx(0.5 * (0.1 + 0.9 * math.exp(-0.5 / 12)), rel=1e-5)
    assert b[0] == pytest.approx(0.5 * (0.1 + 0.9 * math.exp(-12.5 / 12)), rel=1e-5)
    assert np.all(b < a)
    note = ensemble.adjustment_note(dataclasses.replace(st, adjustment_origin_ms=ORIGIN - 12 * H), ORIGIN)
    assert "12 h before the start" in note and "0.22 at the start" in note
    assert "relaxing toward 0.05" in ensemble.adjustment_note(st)


def _live_bundle(root, t_obs_end_h: float, now_h: float, markers=(), last_det_h: float | None = None):
    m = 32
    obs = _disk_observed(m, r0=16, c0=12, radius=4.0, t=t_obs_end_h)
    bdir = make_bundle(root, iid="live-quiet", m=m, mode="live", observed=obs, ignition_rc=(16, 12), t_ign_h=2.0,
                       data_end_h=now_h)
    last = ORIGIN + int((last_det_h if last_det_h is not None else t_obs_end_h) * H)
    doc = {"last_detection_ms": last, "now_ms": ORIGIN + int(now_h * H), "last_pass_ms": ORIGIN + int(now_h * H),
           "rule": "latest_pass" if now_h > (last_det_h or t_obs_end_h) else "last_detection", "note": "test",
           "quiet_passes": 5, "vetoed": None, "passes": [], "markers": list(markers)}
    bundle.write_json(bdir / "sim" / lo.ACTIVITY_FILE, doc)
    bundle.update_manifest(bdir, lambda mm: mm["summary"].update(percent_contained=35.0))
    return bdir


def _members(calls: list):
    def fake(bundle_dir, start_ms, horizon_h, ens, members=None):
        calls.append(start_ms)
        return [make_weather(t0=ORIGIN - 72 * H, hours=300, speed_kmh=30.0, label=f"member{i:02d}") for i in range(2)]
    return fake


def test_live_settings_only_for_quiet_live_starts(tmp_data_dir, monkeypatch) -> None:
    calls: list = []
    monkeypatch.setattr(weather_bundle, "member_weathers", _members(calls))
    bdir = _live_bundle(tmp_data_dir / "incidents", t_obs_end_h=6.0, now_h=20.0)
    setup = ensemble.prepare_forecast(bdir, horizon_h=6)
    assert setup.start_ms == ORIGIN + 20 * H and setup.activity["rule"] == "latest_pass" and setup.percent_contained == 35.0
    st = ensemble.live_settings(setup, ensemble.forecast_settings())
    assert st.adjustment_origin_ms == ORIGIN + 6 * H
    monkeypatch.setattr(config, "FORECAST_DECAY_FROM_LAST_ACTIVITY", False)
    assert ensemble.live_settings(setup, ensemble.forecast_settings()).adjustment_origin_ms is None
    monkeypatch.setattr(config, "FORECAST_DECAY_FROM_LAST_ACTIVITY", True)
    hist = dataclasses.replace(setup, mode="historical")
    assert ensemble.live_settings(hist, ensemble.forecast_settings()).adjustment_origin_ms is None
    # a start at the last detection is not shifted
    setup2 = dataclasses.replace(setup, sim_start_ms=ORIGIN + 6 * H)
    assert ensemble.live_settings(setup2, ensemble.forecast_settings()).adjustment_origin_ms is None


def test_quiet_live_forecast_holds_the_perimeter(tmp_data_dir, monkeypatch) -> None:
    calls: list = []
    monkeypatch.setattr(weather_bundle, "member_weathers", _members(calls))
    bdir = _live_bundle(tmp_data_dir / "incidents", t_obs_end_h=6.0, now_h=20.0)
    fm = ensemble.run_forecast(bdir, horizon_h=6, workers=1)
    assert fm.start_ms == ORIGIN + 20 * H and calls[0] == ORIGIN + 20 * H
    area = fm.series.area_acres_p50
    assert area[-1] == pytest.approx(area[0])            # quiet for 14 h: whole perimeter held, no growth
    text = " | ".join(fm.warnings)
    assert "latest satellite pass" in text and "14 h after the last detection" in text
    assert "100% of the perimeter" in text and "does not mean the fire is out" in text
    assert "lead counted from the last sign of activity" in text
    doc = bundle.read_json(bdir / f"forecasts/{fm.run_id}/forecast.json")
    assert contract_problems(ForecastManifest, doc) == []


def test_live_forecast_with_recent_activity_spreads(tmp_data_dir, monkeypatch) -> None:
    calls: list = []
    monkeypatch.setattr(weather_bundle, "member_weathers", _members(calls))
    # burned 2 h before the start (inside the 12 h window): the active perimeter spreads; 35 % containment holds
    bdir = _live_bundle(tmp_data_dir / "incidents", t_obs_end_h=18.0, now_h=20.0)
    fm = ensemble.run_forecast(bdir, horizon_h=6, workers=1)
    area = fm.series.area_acres_p50
    assert area[-1] > area[0]
    assert "CAL FIRE reports 35% containment" in " | ".join(fm.warnings)


def test_live_forecast_survives_missing_or_corrupt_side_files(tmp_data_dir, monkeypatch) -> None:
    """A corrupt sim/activity.json and a missing detections.json degrade to the plain rule; nothing crashes."""
    calls: list = []
    monkeypatch.setattr(weather_bundle, "member_weathers", _members(calls))
    bdir = _live_bundle(tmp_data_dir / "incidents", t_obs_end_h=6.0, now_h=20.0)
    (bdir / "sim" / lo.ACTIVITY_FILE).write_text("{not json")
    (bdir / "detections.json").unlink(missing_ok=True)
    assert ensemble.load_activity(bdir) is None and ensemble.load_polar_detections(bdir) is None
    fm = ensemble.run_forecast(bdir, horizon_h=6, workers=1)
    assert fm.status == "ready" and fm.start_ms == ORIGIN + 20 * H
    text = " | ".join(fm.warnings)
    assert "latest satellite pass" not in text and "lead counted from" not in text     # no activity document
    assert "100% of the perimeter" in text                                             # the calibrated hold still applies


def test_experimental_activity_filters() -> None:
    """edge_m ignores activity deep inside the burned area; growth_only ignores detections on ground that burned
    before the window (both off by default, docs/validation.md 6.6)."""
    res, m = 50.0, 60
    obs = _disk_observed(m, 30, 30, 15.0, t=5.0)       # 750 m radius, burned long before the window
    half = m * res / 2
    centre = np.array([[(30 + 0.5) * res - half, (30 + 0.5) * res - half, ORIGIN + 29 * H]])
    outside = np.array([[(30 + 17 + 0.5) * res - half, (30 + 0.5) * res - half, ORIGIN + 29 * H]])
    _, st = ensemble.held_perimeter(obs, 30.0, res, ORIGIN, centre)
    assert st["held_fraction"] == 0.0                  # an interior hot pixel marks the whole small perimeter active
    _, st_edge = ensemble.held_perimeter(obs, 30.0, res, ORIGIN, centre, edge_m=375.0)
    _, st_growth = ensemble.held_perimeter(obs, 30.0, res, ORIGIN, centre, growth_only=True)
    assert st_edge["held_fraction"] == 1.0 and st_growth["held_fraction"] == 1.0
    assert st_growth["detections"] == 0
    # a detection outside the burned area is growth evidence under both filters
    _, st_out = ensemble.held_perimeter(obs, 30.0, res, ORIGIN, outside, growth_only=True, edge_m=375.0)
    assert st_out["detections"] == 1 and st_out["held_fraction"] < 1.0
    # settings plumbing: defaults are off; forecast_settings copies the config values
    st0 = ensemble.forecast_settings()
    assert st0.active_edge_m == config.FORECAST_ACTIVE_EDGE_M and st0.active_growth_only == config.FORECAST_ACTIVE_GROWTH_ONLY
    assert st0.active_radius_m == config.FORECAST_ACTIVE_RADIUS_M
