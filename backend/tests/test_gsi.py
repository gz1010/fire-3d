"""Live fuel moisture outside California: the NFDRS 2016 Growing Season Index (CONTRACT 14.12.10, docs/validation.md
section 10.1). Reference values are the method's published definitions (Jolly et al. 2005; the default parameters of
the US Forest Service reference code NFDRS4, ``livefuelmoisture.cpp``), checked by hand below; the never-silent
fallback; ``require_hrrr`` failing on a refused series; California's (herb, woody) values and notes unchanged."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest

from fire3d import bundle, config
from fire3d.build import weather_bundle as WB
from fire3d.sources import weather as W
from fire3d.spread import behavior
from fire3d.spread import moisture as mo
from fire3d.timeutil import DAY_MS, HOUR_MS, iso_to_ms, ms_to_iso

from test_weather_bundle import FakeSource, _fake_water_year_precip, make_ctx


# ----------------------------------------------------------------------------------------------------------------
# The method's reference values
# ----------------------------------------------------------------------------------------------------------------
def test_parameters_are_the_nfdrs4_defaults() -> None:
    assert config.GSI_TMIN_C == (-2.0, 5.0)
    assert config.GSI_VPD_PA == (900.0, 4100.0)
    assert config.GSI_DAYL_S == (36000.0, 39600.0)
    assert config.GSI_MA_DAYS == 21 and config.GSI_MAX == 1.0 and config.GSI_GREENUP == 0.5
    assert config.GSI_HERB_LFM == (0.30, 2.50) and config.GSI_WOODY_LFM == (0.60, 2.00)
    assert config.GSI_RH_FLOOR_PCT == 5.0 and config.GSI_SERIES_PAST_DAYS == 28


@pytest.mark.parametrize("tmin,it", [(-10.0, 0.0), (-2.0, 0.0), (1.5, 0.5), (5.0, 1.0), (30.0, 1.0)])
def test_tmin_indicator(tmin: float, it: float) -> None:
    assert mo.gsi_indicators(tmin, 0.0, 50000.0)[0] == pytest.approx(it)


@pytest.mark.parametrize("vpd,iv", [(0.0, 1.0), (900.0, 1.0), (2500.0, 0.5), (4100.0, 0.0), (6000.0, 0.0)])
def test_vpd_indicator(vpd: float, iv: float) -> None:
    assert mo.gsi_indicators(10.0, vpd, 50000.0)[1] == pytest.approx(iv)


@pytest.mark.parametrize("dayl,idl", [(30000.0, 0.0), (36000.0, 0.0), (37800.0, 0.5), (39600.0, 1.0), (50000.0, 1.0)])
def test_daylength_indicator(dayl: float, idl: float) -> None:
    assert mo.gsi_indicators(10.0, 0.0, dayl)[2] == pytest.approx(idl)


def test_saturation_vapour_pressure_and_vpd() -> None:
    assert mo.saturation_vp_pa(0.0) == pytest.approx(610.7)                       # the formula's base value
    assert mo.saturation_vp_pa(20.0) == pytest.approx(610.7 * math.exp(17.38 * 20 / 259), rel=1e-12)
    assert mo.saturation_vp_pa(20.0) == pytest.approx(2337.2, abs=0.1)            # ~ Tetens 2339 Pa
    es25 = 610.7 * math.exp(17.38 * 25 / 264)
    assert mo.gsi_vpd_pa(25.0, 30.0) == pytest.approx(es25 * 0.70)
    assert mo.gsi_vpd_pa(25.0, 2.0) == pytest.approx(es25 * 0.95)                 # RH floored at 5 %
    assert mo.gsi_vpd_pa(25.0, 100.0) == pytest.approx(0.0)


def test_daylength_mtclim() -> None:
    assert mo.daylength_s(0.0, 80) == pytest.approx(43200.0, abs=1.0)              # equator: 12 h every day
    yday_winter = 365.0 - 10.25                                                    # NFDRS4's winter solstice
    hss = math.acos(math.tan(math.radians(45.0)) * math.tan(0.4092797))
    assert mo.daylength_s(45.0, yday_winter) == pytest.approx(2 * hss * 13750.9871, rel=1e-6)
    assert mo.daylength_s(45.0, yday_winter) == pytest.approx(30863.0, abs=60.0)  # ~8 h 34 min
    assert mo.daylength_s(80.0, 172) == pytest.approx(86400.0, rel=1e-3)          # polar day
    assert mo.daylength_s(80.0, 355) == pytest.approx(0.0, abs=1.0)               # polar night
    assert mo.daylength_s(-35.0, 172) < 43200.0 < mo.daylength_s(35.0, 172)


def test_daily_gsi_hand_example() -> None:
    # Tmin 10 °C (iTmin 1); Tmax 25 °C, RHmin 30 % -> VPD 0.7 es(25) = 2216.5 Pa (iVPD 0.5886); 45° N in June (iDayl 1)
    vpd = 0.7 * 610.7 * math.exp(17.38 * 25 / 264)
    expect = 1.0 - (vpd - 900.0) / 3200.0
    assert mo.daily_gsi(10.0, 25.0, 30.0, 45.0, 172) == pytest.approx(expect, rel=1e-9)
    assert mo.daily_gsi(10.0, 25.0, 30.0, 45.0, 172) == pytest.approx(0.5886, abs=1e-4)
    assert mo.daily_gsi(-5.0, 25.0, 30.0, 45.0, 172) == 0.0                        # frost
    assert mo.daily_gsi(10.0, 25.0, 30.0, 45.0, 355) == 0.0                        # short winter day
    v = mo.daily_gsi(np.array([10.0, 1.5]), np.array([25.0, 10.0]), np.array([30.0, 90.0]), 45.0, np.array([172, 172]))
    assert v.shape == (2,) and v[1] == pytest.approx(0.5)


@pytest.mark.parametrize("g,herb,woody", [(0.0, 0.30, 0.60), (0.49, 0.30, 0.60), (0.5, 0.30, 0.60), (0.75, 1.40, 1.30),
                                          (1.0, 2.50, 2.00), (1.7, 2.50, 2.00)])
def test_gsi_to_live_fuel_moisture(g: float, herb: float, woody: float) -> None:
    h, w = mo.gsi_live_fuel_moisture(g)
    assert (h, w) == pytest.approx((herb, woody))
    if g >= 0.5:   # NFDRS4: slope (max - min) / (1 - 0.5), intercept max - slope (in %): herb 440 g - 190, woody 280 g - 80
        gg = min(g, 1.0)
        assert h * 100 == pytest.approx(440 * gg - 190) and w * 100 == pytest.approx(280 * gg - 80)


def test_gsi_mean_needs_all_21_days() -> None:
    assert mo.gsi_mean([0.6] * 21) == pytest.approx(0.6)
    assert mo.gsi_mean([0.6] * 20) is None
    assert mo.gsi_mean([0.6] * 20 + [None]) is None
    assert mo.gsi_mean([0.6] * 20 + [float("nan")]) is None
    assert mo.gsi_mean(iter([0.2] * 21)) == pytest.approx(0.2)                     # any iterable


# ----------------------------------------------------------------------------------------------------------------
# Daily inputs from Open-Meteo
# ----------------------------------------------------------------------------------------------------------------
def _payload(days: int, t0_local_midnight_s: int, *, short_last: bool = False) -> dict:
    n = days * 24 - (6 if short_last else 0)
    t = [t0_local_midnight_s + 3600 * i for i in range(n)]
    temp = [10.0 + 10.0 * math.sin(2 * math.pi * (i % 24) / 24) + (i // 24) for i in range(n)]
    rh = [50.0 - 30.0 * math.sin(2 * math.pi * (i % 24) / 24) for i in range(n)]
    return {"hourly": {"time": t, "temperature_2m": temp, "relative_humidity_2m": rh},
            "daily": {"time": [t0_local_midnight_s + 86400 * d for d in range(days)], "daylight_duration": [50000.0] * days}}


def test_gsi_daily_rows_local_days() -> None:
    t0 = iso_to_ms("2025-06-01T06:00:00Z") // 1000                 # 00:00 MDT
    rows = W.gsi_daily_rows(_payload(3, t0, short_last=True), "America/Denver")
    assert [r["date"] for r in rows] == ["2025-06-01", "2025-06-02"]          # the 18-hour day is left out
    assert rows[0]["tmin_c"] == pytest.approx(0.0) and rows[0]["tmax_c"] == pytest.approx(20.0)
    assert rows[1]["tmax_c"] == pytest.approx(21.0) and rows[0]["rhmin_pct"] == pytest.approx(20.0)
    assert rows[0]["daylight_s"] == 50000.0 and rows[0]["hours"] == 24


class _Resp:
    def __init__(self, data: dict):
        self._d = data
        self.fetched_ms = 123

    def json(self) -> dict:
        return self._d


def test_gsi_inputs_historical_and_live_requests(monkeypatch) -> None:
    seen: list = []
    t0 = iso_to_ms("2025-07-01T06:00:00Z") // 1000

    def fake(url, params, ttl, timeout=120.0, **kw):
        seen.append((url, dict(params), ttl))
        return _Resp(_payload(30, t0))

    monkeypatch.setattr(W, "om_request", fake)
    start, end = iso_to_ms("2025-07-29T18:00:00Z"), iso_to_ms("2025-08-03T18:00:00Z")
    r = W.gsi_inputs(46.7, -111.7, start, end, "America/Denver")
    url, p, ttl = seen[-1]
    assert url == W.ARCHIVE_URL and p["models"] == "era5" and p["timezone"] == "America/Denver"
    assert p["start_date"] == "2025-07-01" and p["end_date"] == "2025-08-03"     # start - 28 d .. end, local days
    assert p["hourly"] == "temperature_2m,relative_humidity_2m" and p["daily"] == "daylight_duration"
    assert ttl == W.HISTORICAL_TTL_S and r["source"] == "open-meteo:archive:era5" and len(r["rows"]) == 30
    r = W.gsi_inputs(46.7, -111.7, start, end, "America/Denver", live=True)
    url, p, ttl = seen[-1]
    assert url == W.FORECAST_URL and p["past_days"] == "28" and p["forecast_days"] == "1" and "models" not in p
    assert ttl == W.GSI_LIVE_TTL_S and r["source"] == "open-meteo:forecast (past days)"


def test_gsi_inputs_refused_is_reported(monkeypatch) -> None:
    def refuse(*a, **k):
        raise W.WeatherQuotaExceeded("archive", "daily")

    monkeypatch.setattr(W, "om_request", refuse)
    r = W.gsi_inputs(35.0, -82.0, iso_to_ms("2025-03-20T00:00:00Z"), iso_to_ms("2025-03-30T00:00:00Z"), "America/New_York")
    assert r["rows"] is None and r["refused"] is True and "daily request limit" in r["warnings"][0]


# ----------------------------------------------------------------------------------------------------------------
# The series in a bundle, the switch and the never-silent fallback
# ----------------------------------------------------------------------------------------------------------------
def _rows(first: str, n: int, *, tmin: float = 12.0, tmax: float = 24.0, rhmin: float = 40.0) -> list[dict]:
    d0 = iso_to_ms(first + "T12:00:00Z")
    return [{"date": ms_to_iso(d0 + k * DAY_MS)[:10], "tmin_c": tmin, "tmax_c": tmax, "rhmin_pct": rhmin, "hours": 24,
             "daylight_s": 52000.0} for k in range(n)]


def _fake_gsi_inputs(rows: list[dict] | None, refused: bool = False):
    def f(lat, lon, start_ms, end_ms, tz, *, live=False, past_days=28):
        f.calls.append((start_ms, end_ms, tz, live, past_days))
        if rows is None:
            return {"rows": None, "source": "", "url": "", "params": {}, "from": None, "to": None, "fetched_ms": 0,
                    "warnings": ["GSI inputs refused (Open-Meteo daily request limit reached; retry after the reset (00:00 UTC))"],
                    "refused": refused}
        return {"rows": rows, "source": "fake:era5", "url": "x", "params": {}, "from": rows[0]["date"], "to": rows[-1]["date"],
                "fetched_ms": 1, "warnings": [], "refused": False}
    f.calls = []
    return f


def _montana(ctx) -> None:
    s = ctx.summary.model_copy(update={"calfire_uid": "", "record_source": "wfigs", "state": "MT",
                                       "time_zone": "America/Denver", "lat": 46.69, "lon": -111.70})
    ctx.summary, ctx.time_zone = s, "America/Denver"
    bundle.update_manifest(ctx.bundle_dir, lambda m: m.update(summary=s.model_dump()))


@pytest.fixture
def mt_ctx(tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(WB, "water_year_precip", _fake_water_year_precip)
    ctx, _ = make_ctx(tmp_data_dir, "historical", iso_to_ms("2025-07-31T20:00:00Z"))
    _montana(ctx)
    return ctx


def test_build_weather_outside_california_stores_the_gsi_series(mt_ctx, monkeypatch) -> None:
    fake = _fake_gsi_inputs(_rows("2025-06-20", 60))
    monkeypatch.setattr(WB, "gsi_inputs", fake)
    mt_ctx.require_hrrr = True
    WB.build_weather(mt_ctx, source=FakeSource(mt_ctx.fire_grid))
    doc = WB.load_lfm_gsi(mt_ctx.bundle_dir)
    assert doc is not None and doc["method"] == "gsi_nfdrs2016" and doc["time_zone"] == "America/Denver"
    assert len(doc["days"]) == 60 and all("gsi" in d for d in doc["days"])
    a, b, tz, live, past = fake.calls[0]
    assert tz == "America/Denver" and live is False and past == 28
    m = bundle.load_manifest(mt_ctx.bundle_dir)
    assert WB.INTERIM_LFM_WARNING not in m["warnings"]                     # GSI applies: the interim warning goes
    assert not any("water-year" in w for w in m["warnings"])
    det = next(d["detail"] for d in m["data_sources"] if d["name"] == "Weather")
    assert "NFDRS 2016 growing season index" in det
    d = WB.live_moisture_detail(mt_ctx.bundle_dir, m, iso_to_ms("2025-07-31T20:00:00Z"), fetch=False)
    g = mo.daily_gsi(12.0, 24.0, 40.0, doc["lat"], 200)                    # every stored day is the same (July)
    assert d["method"] == "gsi_nfdrs2016" and d["gsi"] == pytest.approx(round(g, 4), abs=1e-4)
    assert (d["herb"], d["woody"]) == pytest.approx(mo.gsi_live_fuel_moisture(d["gsi"]))
    assert d["note"].startswith("live fuel moisture herb") and "California" not in d["note"]


def test_refused_gsi_series_fails_a_require_hrrr_build(mt_ctx, monkeypatch) -> None:
    monkeypatch.setattr(WB, "gsi_inputs", _fake_gsi_inputs(None, refused=True))
    mt_ctx.require_hrrr = True
    with pytest.raises(W.WeatherError, match="GSI live fuel moisture series unavailable.*--require-hrrr"):
        WB.build_weather(mt_ctx, source=FakeSource(mt_ctx.fire_grid))
    assert not (mt_ctx.bundle_dir / WB.LFM_GSI_JSON).exists()


def test_refused_gsi_series_never_silent_without_require(mt_ctx, monkeypatch) -> None:
    monkeypatch.setattr(WB, "gsi_inputs", _fake_gsi_inputs(None, refused=True))
    (mt_ctx.bundle_dir / "sim").mkdir(parents=True, exist_ok=True)
    (mt_ctx.bundle_dir / WB.LFM_GSI_JSON).write_text('{"method": "gsi_nfdrs2016", "days": [{"date": "x"}]}')   # stale
    legacy = next(iter(WB.LEGACY_INTERIM_LFM_WARNINGS))                       # wave 1's "until ... is tested" text
    bundle.update_manifest(mt_ctx.bundle_dir, lambda m: m.__setitem__("warnings", [*m.get("warnings", []), legacy]))
    WB.build_weather(mt_ctx, source=FakeSource(mt_ctx.fire_grid))
    assert not (mt_ctx.bundle_dir / WB.LFM_GSI_JSON).exists()                 # a stale series is removed
    m = bundle.load_manifest(mt_ctx.bundle_dir)
    assert WB.INTERIM_LFM_WARNING in m["warnings"] and legacy not in m["warnings"]
    assert m["warnings"].count(WB.INTERIM_LFM_WARNING) == 1
    assert WB.INTERIM_LFM_WARNING == ("Live fuel moisture outside California uses California's seasonal values because "
                                      "the regional (GSI) series is unavailable; experimental.")
    assert any(w.startswith("Weather: GSI live fuel moisture series unavailable") for w in m["warnings"])
    d = WB.live_moisture_detail(mt_ctx.bundle_dir, m, iso_to_ms("2025-08-01T03:00:00Z"), fetch=False)
    assert d["note"].startswith("Live fuel moisture: California's seasonal values (GSI series unavailable); experimental.")
    assert d["method"] == "ca_month_table_drought" and (d["herb"], d["woody"]) == mo.live_fuel_moisture(7, 150.0)


def test_series_without_21_days_before_the_start_falls_back_with_the_note(mt_ctx, monkeypatch) -> None:
    monkeypatch.setattr(WB, "gsi_inputs", _fake_gsi_inputs(_rows("2025-07-20", 30)))
    WB.build_weather(mt_ctx, source=FakeSource(mt_ctx.fire_grid))
    m = bundle.load_manifest(mt_ctx.bundle_dir)
    d = WB.live_moisture_detail(mt_ctx.bundle_dir, m, iso_to_ms("2025-08-01T18:00:00Z"), fetch=False)
    assert d["method"].startswith("ca_month_table") and d["note"].startswith(WB.INTERIM_LFM_NOTE)
    d = WB.live_moisture_detail(mt_ctx.bundle_dir, m, iso_to_ms("2025-08-11T18:00:00Z"), fetch=False)
    assert d["method"] == "gsi_nfdrs2016"                                       # Jul 21 .. Aug 10 are stored


def test_gsi_at_uses_the_21_local_days_before_the_start() -> None:
    rows = _rows("2025-03-01", 40)
    rows[25]["tmin_c"] = -10.0                                                  # Mar 26: a frost day
    doc = {"method": "gsi_nfdrs2016", "lat": 35.0, "time_zone": "America/New_York", "days": rows}
    before = WB.gsi_at(doc, iso_to_ms("2025-03-27T03:59:00Z"))                 # Mar 26 23:59 EDT: frost day not counted
    after = WB.gsi_at(doc, iso_to_ms("2025-03-27T04:01:00Z"))                  # Mar 27 00:01 EDT: counted
    assert before["last"] == "2025-03-25" and before["first"] == "2025-03-05" and before["days"] == 21
    assert after["last"] == "2025-03-26" and after["gsi"] < before["gsi"]
    assert after["gsi"] == pytest.approx(before["gsi"] * 20 / 21 + 0.0, abs=0.05)
    assert WB.gsi_at(doc, iso_to_ms("2025-03-10T12:00:00Z")) is None            # not 21 days stored before it
    assert WB.gsi_at(None, iso_to_ms("2025-03-27T12:00:00Z")) is None


def test_validation_ablation_forces_californias_rule(mt_ctx, monkeypatch) -> None:
    monkeypatch.setattr(WB, "gsi_inputs", _fake_gsi_inputs(_rows("2025-06-20", 60)))
    WB.build_weather(mt_ctx, source=FakeSource(mt_ctx.fire_grid))
    m = bundle.load_manifest(mt_ctx.bundle_dir)
    monkeypatch.setattr(config, "LFM_FORCE_CALIFORNIA", True)
    d = WB.live_moisture_detail(mt_ctx.bundle_dir, m, iso_to_ms("2025-07-31T20:00:00Z"), fetch=False)
    assert d["method"] == "ca_month_table_drought" and "validation ablation" in d["note"]


def test_behaviour_annotation_uses_gsi_outside_california(mt_ctx, monkeypatch) -> None:
    monkeypatch.setattr(WB, "gsi_inputs", _fake_gsi_inputs(_rows("2025-06-20", 60, rhmin=60.0)))
    WB.build_weather(mt_ctx, source=FakeSource(mt_ctx.fire_grid))
    m = bundle.load_manifest(mt_ctx.bundle_dir)
    f = behavior._live_moisture_by_hour(mt_ctx.bundle_dir, m, "America/Denver", None)
    t = iso_to_ms("2025-07-31T20:00:00Z")
    g = WB.gsi_at(WB.load_lfm_gsi(mt_ctx.bundle_dir), t)["gsi"]
    assert f(t) == pytest.approx(mo.gsi_live_fuel_moisture(g)) and g > 0.5
    m["summary"]["state"] = "CA"
    f_ca = behavior._live_moisture_by_hour(mt_ctx.bundle_dir, m, "America/Los_Angeles", 150.0)
    assert f_ca(t) == mo.live_fuel_moisture(7, 150.0)


def test_gsi_at_holds_the_latest_value_after_the_series_only_when_asked() -> None:
    rows = _rows("2025-03-01", 30)                                              # Mar 01 .. Mar 30 (local days)
    for k, r in enumerate(rows):
        r["tmin_c"] = -2.0 + 0.3 * k                                            # warming: every 21-day window differs
    doc = {"method": "gsi_nfdrs2016", "lat": 35.0, "time_zone": "America/New_York", "days": rows}
    last = WB.gsi_at(doc, iso_to_ms("2025-03-31T16:00:00Z"))                   # Mar 31: Mar 10..30, all stored
    assert last["first"] == "2025-03-10" and last["last"] == "2025-03-30" and "held_from" not in last
    for t in ("2025-04-01T16:00:00Z", "2025-04-03T03:00:00Z"):                  # after the series
        assert WB.gsi_at(doc, iso_to_ms(t)) is None                             # the ensemble path: unchanged
        held = WB.gsi_at(doc, iso_to_ms(t), hold_last=True)
        assert held["gsi"] == last["gsi"] and held["held_from"] == "2025-03-31" and held["last"] == "2025-03-30"
    assert WB.gsi_at(doc, iso_to_ms("2025-03-31T16:00:00Z"), hold_last=True) == last
    assert WB.gsi_at(doc, iso_to_ms("2025-03-10T16:00:00Z"), hold_last=True) is None    # before 21 days: no hold
    gap = {**doc, "days": rows[:19] + rows[20:]}                                # Mar 20 missing: never bridged
    assert WB.gsi_at(gap, iso_to_ms("2025-03-25T16:00:00Z"), hold_last=True) is None
    assert WB.gsi_at(gap, iso_to_ms("2025-04-02T16:00:00Z"), hold_last=True) is None


def _live_series_bundle(tmp_path: Path, now_iso: str, tz: str, state: str = "TX") -> tuple[Path, dict, int]:
    """A bundle whose GSI series is shaped like a live one (forecast host, past_days=28 + forecast_days=1: local
    days today - 28 .. today), cold and dry (GSI well below green-up), as review M1's reproduction."""
    from datetime import timedelta

    from fire3d.timeutil import local_dt

    now = iso_to_ms(now_iso)
    today = local_dt(now, tz).date()
    days = [{"date": (today - timedelta(days=k)).isoformat(), "tmin_c": -1.0, "tmax_c": 12.0, "rhmin_pct": 20.0,
             "hours": 24, "daylight_s": None} for k in range(28, -1, -1)]
    bdir = tmp_path / "live-gsi"
    (bdir / "sim").mkdir(parents=True)
    bundle.write_json(bdir / WB.LFM_GSI_JSON, {"method": "gsi_nfdrs2016", "lat": 35.63, "lon": -101.85, "time_zone": tz,
                                               "days": days, "source": "test"})
    man = {"summary": {"state": state, "time_zone": tz}, "warnings": []}
    return bdir, man, now


def test_behaviour_annotation_holds_gsi_over_a_live_window(tmp_path) -> None:
    """Review M1: the live series ends today while the weather runs to now + 96 h; every hour keeps the GSI value
    (held from the last computable day), never California's green-winter table (herb/woody 120 %)."""
    tz = "America/Chicago"
    bdir, man, now = _live_series_bundle(tmp_path, "2024-02-27T18:00:00Z", tz)
    f = behavior._live_moisture_by_hour(bdir, man, tz, 120.0)
    doc = WB.load_lfm_gsi(bdir)
    expect_now = mo.gsi_live_fuel_moisture(WB.gsi_at(doc, now)["gsi"])
    expect_late = mo.gsi_live_fuel_moisture(WB.gsi_at(doc, now + 24 * HOUR_MS)["gsi"])
    assert expect_now == (0.3, 0.6)                                             # below green-up
    assert f(now) == expect_now and f(now + 24 * HOUR_MS) == expect_late
    for h in (48, 72, 96):
        assert WB.gsi_at(doc, now + h * HOUR_MS) is None                         # the 21 days are not all stored
        assert f(now + h * HOUR_MS) == expect_late                               # held, not (1.2, 1.2)
    assert mo.live_fuel_moisture(2, 120.0) != expect_late and f.fallback == {}


def test_behaviour_annotation_fallback_is_never_silent(tmp_path) -> None:
    """A day with no GSI value outside California (no series, or a gap) uses California's values and the manifest
    says so; the warning is replaced on every annotation and never added on top of the build's interim warning."""
    tz = "America/Chicago"
    bdir, man, now = _live_series_bundle(tmp_path, "2024-02-27T18:00:00Z", tz)
    doc = WB.load_lfm_gsi(bdir)
    doc["days"] = [d for d in doc["days"] if d["date"] != "2024-02-20"]          # a gap inside the series
    bundle.write_json(bdir / WB.LFM_GSI_JSON, doc)
    f = behavior._live_moisture_by_hour(bdir, man, tz, None)
    for h in range(30):
        f(now + h * HOUR_MS)
    assert sum(f.fallback.values()) == 30 and len(f.fallback) == 2              # Feb 27 and Feb 28 (CST)
    msg = behavior._behavior_lfm_warning(f.fallback)
    assert msg == ("Fire behaviour charts (2024-02-27..2024-02-28, 30 h): live fuel moisture uses California's "
                   "seasonal values (GSI series unavailable); experimental.")
    bundle.save_manifest(bdir, {"id": "x", "warnings": ["Other: keep me", "Fire behaviour charts (2024-01-01, 3 h): old"]})
    behavior._record_behavior_lfm_warning(bdir, bundle.load_manifest(bdir), msg)
    assert bundle.load_manifest(bdir)["warnings"] == ["Other: keep me", msg]
    behavior._record_behavior_lfm_warning(bdir, bundle.load_manifest(bdir), None)          # all hours have GSI now
    assert bundle.load_manifest(bdir)["warnings"] == ["Other: keep me"]
    bundle.save_manifest(bdir, {"id": "x", "warnings": [WB.INTERIM_LFM_WARNING]})
    behavior._record_behavior_lfm_warning(bdir, bundle.load_manifest(bdir), msg)
    assert bundle.load_manifest(bdir)["warnings"] == [WB.INTERIM_LFM_WARNING]   # the build's warning says it already
    old = sorted(WB.LEGACY_INTERIM_LFM_WARNINGS)
    bundle.save_manifest(bdir, {"id": "x", "warnings": old})
    behavior._record_behavior_lfm_warning(bdir, bundle.load_manifest(bdir), msg)
    assert bundle.load_manifest(bdir)["warnings"] == old                       # an older build's text says it too
    ca = behavior._live_moisture_by_hour(bdir, {"summary": {"state": "CA"}}, tz, None)
    ca(now)
    assert ca.fallback == {}                                                    # California's own rule: no warning


def test_annotation_records_the_fallback_in_the_manifest(tmp_path) -> None:
    from test_spread_support import make_bundle

    bdir = make_bundle(tmp_path, iid="mt-no-series")
    bundle.update_manifest(bdir, lambda m: m["summary"].update(state="MT", time_zone="America/Denver"))
    behavior.annotate_weather_with_behavior(bdir)                               # outside California, no series
    ws = bundle.load_manifest(bdir)["warnings"]
    assert len(ws) == 1 and ws[0].startswith("Fire behaviour charts (") and "GSI series unavailable" in ws[0]
    bundle.update_manifest(bdir, lambda m: m["summary"].update(state="CA"))
    behavior.annotate_weather_with_behavior(bdir)                               # California: the warning goes
    assert bundle.load_manifest(bdir)["warnings"] == []


def test_hindcasts_never_fetch_the_gsi_series(mt_ctx, monkeypatch) -> None:
    """Review m4: member_weathers fetches a missing series for a live bundle only."""
    monkeypatch.setattr(WB, "gsi_inputs", _fake_gsi_inputs(_rows("2025-06-20", 60)))
    WB.build_weather(mt_ctx, source=FakeSource(mt_ctx.fire_grid))
    (mt_ctx.bundle_dir / WB.LFM_GSI_JSON).unlink()                              # a bundle built before GSI
    fake = _fake_gsi_inputs(_rows("2025-06-20", 60))
    monkeypatch.setattr(WB, "gsi_inputs", fake)
    mws = WB.member_weathers(mt_ctx.bundle_dir, iso_to_ms("2025-08-01T00:00:00Z"), 12, "none",
                             source=FakeSource(mt_ctx.fire_grid))
    assert fake.calls == [] and not (mt_ctx.bundle_dir / WB.LFM_GSI_JSON).exists()
    assert any(w.startswith(WB.INTERIM_LFM_NOTE) for w in mws.warnings)          # never silent
    bundle.update_manifest(mt_ctx.bundle_dir, lambda m: m.update(mode="live"))
    WB.member_weathers(mt_ctx.bundle_dir, iso_to_ms("2025-08-01T00:00:00Z"), 12, "none", source=FakeSource(mt_ctx.fire_grid))
    assert len(fake.calls) == 1 and fake.calls[0][3] is True                     # live: fetched (forecast host)


# ----------------------------------------------------------------------------------------------------------------
# California unchanged by the GSI code (14.12.10): Eaton, Palisades, Madre (when present) and fixture-demo
# ----------------------------------------------------------------------------------------------------------------
def _pre_gsi_live_moisture_for(bdir: Path, manifest: dict, start_ms: int) -> tuple[float, float, str]:
    """A frozen copy of ``live_moisture_for`` before brief 3's GSI code (California path, fetch=False)."""
    from fire3d.timeutil import local_month, zone_of

    month = local_month(int(start_ms), zone_of(manifest))
    p, why = WB.precip_to(bdir, manifest, int(start_ms), None, fetch=False)
    herb, woody = mo.live_fuel_moisture(month, p)
    base = mo.live_fuel_moisture(month)
    if p is None:
        return herb, woody, f"live fuel moisture: month table (herb {base[0]:.0%}, woody {base[1]:.0%}); {why}"
    g = mo.greenup_fraction(p)
    adj = "" if (herb, woody) == base else f" (month table {base[0]:.0%}/{base[1]:.0%}; green-up {g:.0%})"
    return herb, woody, (f"live fuel moisture herb {herb:.0%}, woody {woody:.0%}{adj}: water-year precipitation "
                         f"{p:.0f} mm by {ms_to_iso(int(start_ms))[:10]} ({why})")


# (bundle, start offsets after ignition (h), expected (herb, woody) from the pre-GSI code, method)
CALIFORNIA_CASES = [
    ("2025-eaton-fire-dbfa57", (6, 12, 24), (0.3, 0.7), "ca_month_table_drought"),
    ("2025-palisades-fire-abfed7", (6, 12, 24), (0.3, 0.7), "ca_month_table_drought"),
    ("2025-madre-fire-01e7e8", (24, 48), (0.3, 0.7), "ca_month_table_drought"),
    ("fixture-demo", (6, 12, 24, 48), (0.3, 0.7), "ca_month_table"),
]


@pytest.mark.parametrize("bid,offsets,values,method", CALIFORNIA_CASES)
def test_california_values_and_notes_unchanged(bid: str, offsets, values, method) -> None:
    bdir = config.REPO_ROOT / "data" / "incidents" / bid
    if not (bdir / "manifest.json").is_file():
        pytest.skip(f"{bid} not built here")
    man = bundle.load_manifest(bdir)
    t_ign = (man.get("ignition") or {}).get("t_ms") or man["summary"]["started_ms"]
    for off in offsets:
        t = int(t_ign + off * HOUR_MS)
        d = WB.live_moisture_detail(bdir, man, t, fetch=False)
        assert (d["herb"], d["woody"], d["note"]) == _pre_gsi_live_moisture_for(bdir, man, t)
        assert (d["herb"], d["woody"]) == values and d["method"] == method and d["gsi"] is None
        assert WB.live_moisture_for(bdir, man, t, fetch=False) == (d["herb"], d["woody"], d["note"])
        f = behavior._live_moisture_by_hour(bdir, man, man["summary"].get("time_zone") or "America/Los_Angeles",
                                            WB.precip_to(bdir, man, t, fetch=False)[0])
        assert f(t) == values
