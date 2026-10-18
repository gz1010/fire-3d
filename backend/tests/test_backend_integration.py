"""Science and integration additions of the backend-integration pass (docs/validation.md):

drought-adjusted live fuel moisture, water-year precipitation, the WUI surrogate for developed (NB1) cells, the held
inactive perimeter, the lead-time spread adjustment, the historical skill window and burn-severity masking.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import numpy as np
import pytest

import fire3d.http as fhttp
from fire3d import bundle, config
from fire3d.build import pipeline
from fire3d.build import weather_bundle as wb
from fire3d.sources import weather as wsrc
from fire3d.spread import engine, ensemble, moisture
from fire3d.timeutil import iso_to_ms
from fire3d.types import SpreadSettings
from test_spread_support import ORIGIN, H, extents, make_static, make_weather

NEVER = config.NEVER


# ---------------------------------------------------------------------------------------------------------------
# Live fuel moisture: drought adjustment
# ---------------------------------------------------------------------------------------------------------------
def test_greenup_fraction_ramps_between_thresholds() -> None:
    lo, hi = config.GREENUP_MIN_PRECIP_MM, config.GREENUP_FULL_PRECIP_MM
    assert moisture.greenup_fraction(None) is None
    assert moisture.greenup_fraction(0.0) == 0.0
    assert moisture.greenup_fraction(lo) == 0.0
    assert moisture.greenup_fraction((lo + hi) / 2) == pytest.approx(0.5)
    assert moisture.greenup_fraction(hi * 3) == 1.0


def test_dry_winter_uses_dry_season_live_moisture() -> None:
    dry = config.LIVE_FUEL_MOISTURE_DRY
    assert moisture.live_fuel_moisture(1) == config.LIVE_FUEL_MOISTURE_BY_MONTH[1]        # unknown precip: table
    assert moisture.live_fuel_moisture(1, 12.0) == pytest.approx(dry)                       # Jan 2025 in LA
    assert moisture.live_fuel_moisture(1, 400.0) == pytest.approx(config.LIVE_FUEL_MOISTURE_BY_MONTH[1])
    herb, woody = moisture.live_fuel_moisture(3, 62.5)                                      # half green-up
    t_h, t_w = config.LIVE_FUEL_MOISTURE_BY_MONTH[3]
    assert herb == pytest.approx(dry[0] + 0.5 * (t_h - dry[0]))
    assert woody == pytest.approx(dry[1] + 0.5 * (t_w - dry[1]))
    # the dry season is never made wetter by rain totals
    assert moisture.live_fuel_moisture(8, 1000.0) == pytest.approx(config.LIVE_FUEL_MOISTURE_BY_MONTH[8])


def test_water_year_start() -> None:
    assert wsrc.water_year_start_ms(iso_to_ms("2025-01-08T02:00:00Z")) == iso_to_ms("2024-10-01T00:00:00Z")
    assert wsrc.water_year_start_ms(iso_to_ms("2025-10-02T00:00:00Z")) == iso_to_ms("2025-10-01T00:00:00Z")
    assert wsrc.water_year_start_ms(iso_to_ms("2025-09-30T23:00:00Z")) == iso_to_ms("2024-10-01T00:00:00Z")


def test_water_year_precip_sums_the_archive(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path) -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        assert "precipitation_sum" in str(request.url)
        return httpx.Response(200, json={"daily": {"time": ["2024-10-01", "2024-10-02", "2024-10-03"],
                                                   "precipitation_sum": [1.5, None, 2.5]}})

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    r = wsrc.water_year_precip(34.2, -118.07, iso_to_ms("2024-10-04T12:00:00Z"))
    assert r["precip_mm"] == pytest.approx(4.0)
    assert r["from"] == "2024-10-01" and r["days"] == 2
    assert seen and wsrc.ARCHIVE_URL in seen[0]


def test_water_year_precip_failure_returns_none(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path) -> None:
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(lambda r: httpx.Response(500, text="down")))
    monkeypatch.setattr(fhttp.time, "sleep", lambda s: None)
    r = wsrc.water_year_precip(34.2, -118.07, iso_to_ms("2025-01-08T02:00:00Z"))
    assert r["precip_mm"] is None and r["warnings"]


def test_precip_to_adds_bundle_rain_after_the_stored_total(tmp_path: Path) -> None:
    bdir = tmp_path / "b"
    (bdir / "sim").mkdir(parents=True)
    t0 = iso_to_ms("2025-01-05T00:00:00Z")
    bundle.write_json(bdir / wb.ANTECEDENT_JSON, {"precip_wy_mm": 10.0, "to_ms": t0, "source": "test"})
    t = t0 + np.arange(96, dtype=np.int64) * H
    zeros = np.zeros((96, 4, 4))
    rain = zeros.copy()
    rain[60:70] = 3.0                                    # 30 mm on Jan 7
    gw = wb.GridWeather(t_ms=t, temp_c=zeros + 20, rh_pct=zeros + 30, dewpoint_c=zeros, wind_speed_ms=zeros,
                        wind_dir_deg=zeros, wind_gust_ms=zeros, precip_mm=rain, hrrr=np.ones(96, bool), source="test")
    p, _ = wb.precip_to(bdir, {}, t0 + 50 * H, gw, fetch=False)
    assert p == pytest.approx(10.0)
    p, _ = wb.precip_to(bdir, {}, t0 + 90 * H, gw, fetch=False)
    assert p == pytest.approx(40.0)
    herb, woody, note = wb.live_moisture_for(bdir, {}, t0 + 90 * H, gw, fetch=False)
    assert (herb, woody) == pytest.approx(moisture.live_fuel_moisture(1, 40.0))
    assert "40 mm" in note


def test_precip_to_without_data_falls_back_to_the_table(tmp_path: Path) -> None:
    p, why = wb.precip_to(tmp_path, {}, ORIGIN, None, fetch=False)
    assert p is None and why
    herb, woody, note = wb.live_moisture_for(tmp_path, {}, iso_to_ms("2025-01-08T00:00:00Z"), None, fetch=False)
    assert (herb, woody) == config.LIVE_FUEL_MOISTURE_BY_MONTH[1]
    assert "month table" in note


# ---------------------------------------------------------------------------------------------------------------
# WUI surrogate for developed cells
# ---------------------------------------------------------------------------------------------------------------
def _wui_landscape(m: int = 160, res: float = 30.0) -> np.ndarray:
    """Wildland in the north half; a town just south of it; a far town in the south-east corner; a 1-cell road
    across the wildland."""
    f = np.full((m, m), 145, np.int16)
    f[80:, :] = 93                     # agriculture (NB3, non-burnable) in the south half
    f[80:110, 20:70] = 91              # town next to the wildland
    f[150:, 140:] = 91                 # far town, 1.2 km from the wildland
    f[30, :] = 91                      # road through the wildland
    return f


def test_wui_mask_selects_towns_near_wildland_not_roads() -> None:
    f = _wui_landscape()
    w = engine.wui_mask(f, 30.0, buffer_m=2400.0)
    assert w[85:105, 25:65].all()                      # the town by the wildland
    assert not w[30, :].any()                          # the road through the wildland stays non-burnable
    assert not w[f != 91].any()                        # only developed cells
    assert w[150:, 140:].all()                         # 1.2 km from the wildland: inside the 2.4 km interface
    near_only = engine.wui_mask(f, 30.0, buffer_m=300.0)
    assert near_only[80:85, 25:65].all() and not near_only[105:110, 25:65].any() and not near_only[150:, 140:].any()


def test_wui_mask_needs_a_wildland_core() -> None:
    rng = np.random.default_rng(3)
    f = np.where(rng.random((100, 100)) < 0.5, 91, 102).astype(np.int16)   # half developed: no >= 75 % burnable block
    assert not engine.wui_mask(f, 30.0).any()
    assert not engine.wui_mask(np.full((50, 50), 91, np.int16), 30.0).any()


def test_prepare_static_wui_burnable_with_adjustment() -> None:
    f = _wui_landscape()
    st = make_static(160, fuel=f)
    off = engine.prepare_static(st, SpreadSettings())
    assert off.fuel_adjustment is None and (off.fuel_model == 91).sum() == (f == 91).sum()
    on = engine.prepare_static(st, SpreadSettings(wui=True, wui_fuel_model=165, wui_spread_adjustment=0.3))
    w = engine.wui_mask(engine.sanitize_fuel_codes(f), 30.0)
    assert (on.fuel_model[w] == 165).all() and (on.fuel_model[f == 145] == 145).all()
    assert on.fuel_adjustment is not None
    assert np.allclose(on.fuel_adjustment[w], 0.3) and np.allclose(on.fuel_adjustment[~w], 1.0)
    note = engine.wui_summary(st, SpreadSettings(wui=True, wui_spread_adjustment=0.3))
    assert note and "FBFM 165" in note and "0.3 x" in note
    assert engine.wui_summary(st, SpreadSettings()) is None


def test_fire_enters_wui_cells_only_with_the_treatment() -> None:
    m = 64
    f = np.full((m, m), 102, np.int16)
    f[:, 40:] = 91                                     # a town east of a grass field
    st = make_static(m, fuel=f)
    mask = np.zeros((m, m), bool)
    mask[32, 20] = True
    wx = make_weather(speed_kmh=25.0, from_deg=270.0)
    base = engine.simulate(st, wx, mask, ORIGIN + 3 * H, 3, ORIGIN, SpreadSettings())
    assert not (base.result.arrival_h[:, 40:] < NEVER * 0.5).any()
    # the town block borders a large burnable block, so it is WUI; the treatment lets the fire in, slowly
    on = engine.simulate(st, wx, mask, ORIGIN + 3 * H, 3, ORIGIN,
                         SpreadSettings(wui=True, wui_buffer_m=5000.0, wui_spread_adjustment=0.5))
    assert (on.result.arrival_h[:, 40:] < NEVER * 0.5).any()


# ---------------------------------------------------------------------------------------------------------------
# Lead-time spread adjustment
# ---------------------------------------------------------------------------------------------------------------
def test_adjustment_series_constant_and_decaying() -> None:
    assert engine.adjustment_series(SpreadSettings(spread_adjustment=0.7), 0, 10, 0) == pytest.approx(0.7)
    s = SpreadSettings(spread_adjustment=2.0, adjustment_decay_h=10.0, adjustment_floor=0.5)
    a = engine.adjustment_series(s, 0, 100, 5 * H)
    assert isinstance(a, np.ndarray) and a.shape == (100,)
    assert a[:5] == pytest.approx(2.0)                                   # bands before the start: no decay
    assert a[15] == pytest.approx(2.0 * (0.5 + 0.5 * np.exp(-10.5 / 10.0)), rel=1e-5)
    assert a[-1] == pytest.approx(1.0, rel=1e-3)                          # tends to adjustment x floor
    assert np.all(np.diff(a) <= 1e-7)


def test_decaying_adjustment_slows_late_spread() -> None:
    m, c = 96, 48
    st = make_static(m)
    wx = make_weather(speed_kmh=15.0, from_deg=270.0)
    mask = np.zeros((m, m), bool)
    mask[c, c] = True
    const = engine.simulate(st, wx, mask, ORIGIN + 3 * H, 4, ORIGIN, SpreadSettings())
    decay = engine.simulate(st, wx, mask, ORIGIN + 3 * H, 4, ORIGIN,
                            SpreadSettings(adjustment_decay_h=1.0, adjustment_floor=0.2))
    e1, e2 = extents(const.result.arrival_h, c, c), extents(decay.result.arrival_h, c, c)
    assert e2["E"] < e1["E"] and e2["n"] < e1["n"]


# ---------------------------------------------------------------------------------------------------------------
# Held inactive perimeter
# ---------------------------------------------------------------------------------------------------------------
def _two_sided_fire(m: int = 80) -> np.ndarray:
    """Burned disc around the centre: the west half burned at 1-2 h, the east half at 20-21 h."""
    rr, cc = np.mgrid[0:m, 0:m]
    disc = (rr - 40) ** 2 + (cc - 40) ** 2 <= 15 ** 2
    t = np.where(cc < 40, 1.0 + (40 - cc) / 40.0, 20.0 + (cc - 40) / 40.0)
    return np.where(disc, t, NEVER).astype(np.float32)


def test_held_perimeter_holds_only_the_quiet_side() -> None:
    obs = _two_sided_fire()
    hold, stats = ensemble.held_perimeter(obs, 22.0, 30.0, ORIGIN, None, window_h=12.0, radius_m=150.0)
    assert hold is not None
    cols = np.nonzero(hold)[1]
    assert cols.max() < 40                            # only the west (quiet) side is held
    assert 0.3 < stats["held_fraction"] < 0.7
    # a recent detection on the west edge makes that edge active again
    dets = np.array([[(25 - 40 + 0.5) * 30.0, 0.0, ORIGIN + 21.5 * H]])
    hold2, stats2 = ensemble.held_perimeter(obs, 22.0, 30.0, ORIGIN, dets, window_h=12.0, radius_m=150.0)
    assert stats2["detections"] == 1 and stats2["held_fraction"] < stats["held_fraction"]
    # everything burned recently: nothing is held
    none, _ = ensemble.held_perimeter(obs, 22.0, 30.0, ORIGIN, None, window_h=48.0, radius_m=150.0)
    assert none is None


def test_held_cells_block_spread() -> None:
    m = 64
    st = make_static(m)
    burned = np.zeros((m, m), bool)
    burned[28:36, 28:36] = True
    hold = np.zeros((m, m), bool)
    hold[27:37, 36:38] = True                         # held band on the east side
    held_static = ensemble._with_hold(engine.prepare_static(st, SpreadSettings()), hold)
    out = engine.simulate(held_static, make_weather(speed_kmh=20.0, from_deg=270.0), burned, ORIGIN + 3 * H, 1, ORIGIN,
                          SpreadSettings(), prepared=True)
    b = out.result.arrival_h < NEVER * 0.5
    assert not b[:, 36:38][hold[:, 36:38]].any()


# ---------------------------------------------------------------------------------------------------------------
# Historical skill window, burn severity masking
# ---------------------------------------------------------------------------------------------------------------
def test_data_end_extends_to_containment_for_historical() -> None:
    m = {"mode": "historical", "time_range": {"start_ms": 0, "end_ms": 100 * H, "now_ms": 100 * H},
         "summary": {"contained_ms": 500 * H}}
    assert ensemble.data_end_ms(m) == 500 * H
    m["summary"]["contained_ms"] = None
    assert ensemble.data_end_ms(m) == 100 * H + ensemble.HISTORICAL_FINAL_MS
    m["summary"]["contained_ms"] = 50 * H                                  # containment before the growth end
    assert ensemble.data_end_ms(m) == 100 * H
    live = {"mode": "live", "time_range": {"start_ms": 0, "end_ms": 10 * H, "now_ms": 10 * H}, "summary": {"contained_ms": 99 * H}}
    assert ensemble.data_end_ms(live) == 10 * H


def test_mask_burn_severity_keeps_only_the_incident(tmp_path: Path) -> None:
    from fire3d.sources.sentinel import NODATA

    bdir = tmp_path / "b"
    bdir.mkdir()
    m = 50
    bundle.save_manifest(bdir, {"id": "x", "layers": {}, "grid": {"fire": {"res_m": 100.0}}})
    obs = np.full((m, m), NEVER, np.float32)
    obs[20:30, 20:30] = 5.0
    d = np.full((m, m), 0.5, np.float32)
    d[0, 0] = NODATA
    bundle.write_layer(bdir, "observed_arrival", obs, "fire", "h", "obs")
    bundle.write_layer(bdir, "burn_severity", d, "fire", "dNBR", "dnbr", nodata=NODATA)
    n = pipeline.mask_burn_severity(bdir, margin_m=500.0)
    out = bundle.read_layer(bdir, "burn_severity")
    assert n > 0
    assert (out[20:30, 20:30] == 0.5).all() and (out[16:34, 24] == 0.5).all()
    assert out[0, 49] == NODATA and out[49, 0] == NODATA
    info = bundle.load_manifest(bdir)["layers"]["burn_severity"]
    assert "limited to this incident" in info["description"] and info["max"] == pytest.approx(0.5)
    assert pipeline.mask_burn_severity(bdir, margin_m=500.0) == 0                 # idempotent
