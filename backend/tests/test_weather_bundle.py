"""build/weather_bundle.py: weather.json (window, at_fire interpolation, u/v grid, moisture, FFWI) and the forecast
weather members (alignment, spin-up, perturbations, ensemble bias correction and blending, fallbacks)."""

from __future__ import annotations

import math
import pickle
from pathlib import Path

import numpy as np
import pytest

from fire3d import bundle
from fire3d.build import weather_bundle as WB
from fire3d.contracts import IncidentSummary, WeatherFile, validate_strict
from fire3d.grid import Grid, make_aoi, manifest_grid, weather_axes
from fire3d.sources.weather import WeatherError, WeatherSource, ceil_hour_ms, dewpoint_from_rh, hourly_axis, uv_to_wind, wind_to_uv
from fire3d.spread import moisture as mo
from fire3d.timeutil import DAY_MS, HOUR_MS, floor_hour_ms, iso_to_ms, ms_to_iso
from fire3d.types import BuildContext, MemberWeather

NOW = iso_to_ms("2026-10-16T12:30:00Z")
IGN_XZ = (1200.0, -800.0)


def diurnal(t_ms: np.ndarray) -> np.ndarray:
    return np.sin(2 * np.pi * ((np.asarray(t_ms) / HOUR_MS) % 24) / 24.0)


class FakeSource:
    """A WeatherSource whose fields are linear in local x/z (so bilinear interpolation is exact), wind FROM 270°."""

    name = "fake"

    def __init__(self, grid: Grid, *, hrrr_until: int | None = None, forecast_from: int | None = None, ens: bool = True,
                 rh_low: bool = False, fail: bool = False):
        self.grid = grid
        self.hrrr_until = hrrr_until
        self.forecast_from = forecast_from
        self.ens = ens
        self.rh_low = rh_low
        self.fail = fail
        self.calls: list[tuple[str, int, int]] = []
        self.last_error: str | None = None

    def fields(self, points, t: np.ndarray) -> dict[str, np.ndarray]:
        lat = np.array([p[0] for p in points])
        lon = np.array([p[1] for p in points])
        x, z = self.grid.lonlat_to_local(lon, lat)
        d = diurnal(t)[:, None]
        temp = 20.0 + 1e-3 * x[None] - 2e-3 * z[None] + 6.0 * d
        rh = np.full_like(temp, 0.3) if self.rh_low else 35.0 + 5e-4 * x[None] - 10.0 * d
        speed = 6.0 + 1e-4 * x[None] + 0.0 * d
        return {"temp_c": temp, "rh_pct": rh, "dewpoint_c": dewpoint_from_rh(temp, rh), "wind_speed_ms": speed,
                "wind_dir_deg": np.full_like(temp, 270.0), "wind_gust_ms": 1.5 * speed, "precip_mm": np.zeros_like(temp)}

    def deterministic(self, points, start_ms, end_ms):
        self.calls.append(("det", int(start_ms), int(end_ms)))
        if self.fail:
            raise RuntimeError("provider down")
        t = hourly_axis(start_ms, end_ms)
        out = {"source": "fake:det", "t_ms": t, **self.fields(points, t)}
        hrrr = np.ones(len(t), dtype=bool) if self.hrrr_until is None else t < self.hrrr_until
        ff = self.forecast_from if self.forecast_from is not None and t[-1] >= self.forecast_from else None
        out.update({"hrrr": hrrr, "forecast_from_ms": ff, "fetched_ms": NOW, "warnings": ["fake det warning"]})
        return out

    def ensemble(self, points, start_ms, end_ms, model):
        self.calls.append((model, int(start_ms), int(end_ms)))
        if not self.ens:
            self.last_error = "fake: no ensemble"
            return None
        size = {"gfs025": 31, "ecmwf_ifs025": 51}[model]
        t = hourly_axis(start_ms, end_ms)
        f = self.fields(points, t)
        u, v = wind_to_uv(f["wind_speed_ms"], f["wind_dir_deg"])
        k = np.arange(size)[:, None, None]
        ph = 2 * np.pi * k / size                     # sin/cos over members sum to zero: the mean is the bias alone
        eu, ev = u[None] + 1.0 + 0.5 * np.sin(ph), v[None] - 0.5 + 0.5 * np.cos(ph)
        s, d = uv_to_wind(eu, ev)
        return {"source": f"fake:ensemble:{model}", "model": model, "t_ms": t,
                "members": ["control"] + [f"member{i:02d}" for i in range(1, size)],
                "temp_c": f["temp_c"][None] + 2.0 + 0.8 * np.sin(ph), "rh_pct": f["rh_pct"][None] - 5.0 + 3.0 * np.cos(ph),
                "wind_speed_ms": s, "wind_dir_deg": d, "precip_mm": np.zeros((size,) + f["temp_c"].shape), "warnings": []}


def make_ctx(root: Path, mode: str, started_ms: int, *, end_h: int = 120, ignition: bool = True) -> tuple[BuildContext, list]:
    render, fire = make_aoi(-118.07, 34.20, (-118.10, 34.18, -118.04, 34.22), mode)
    bid = f"test-{mode}"
    bdir = root / "incidents" / bid
    origin = floor_hour_ms(started_ms) - HOUR_MS
    end = NOW if mode == "live" else origin + end_h * HOUR_MS
    lon, lat = fire.local_to_lonlat(*IGN_XZ)
    manifest = {
        "schema_version": 1, "id": bid, "name": "Test", "mode": mode, "status": "building", "time_origin_ms": origin,
        "time_range": {"start_ms": origin, "end_ms": end, "now_ms": end}, "grid": manifest_grid(render, fire, 100.0, 1500.0),
        "ignition": {"x": IGN_XZ[0], "z": IGN_XZ[1], "lat": lat, "lon": lon, "t_ms": started_ms, "source": "test"} if ignition else None,
        "layers": {}, "forecasts": [], "data_sources": [{"name": "Other", "detail": "x", "fetched_ms": 1}], "warnings": ["Other: keep me"],
    }
    bundle.save_manifest(bdir, manifest)
    summary = IncidentSummary(id=bid, name="Test", mode=mode, year=2025, calfire_uid="abc123", started_ms=started_ms, updated_ms=None,
                              contained_ms=None, acres=1000.0, percent_contained=None, is_active=mode == "live", county=None,
                              location=None, admin_unit=None, url=None, lat=34.2, lon=-118.07, detections_24h=None,
                              bundle_status="building", bundle_built_ms=None)
    calls: list = []
    ctx = BuildContext(summary=summary, bundle_dir=bdir, render_grid=render, fire_grid=fire, time_origin_ms=origin, mode=mode,
                       progress=lambda s, f, m: calls.append((s, f, m)), end_ms=None if mode == "live" else end, now_ms=end)
    return ctx, calls


def _fake_water_year_precip(lat: float, lon: float, start_ms: int) -> dict:
    """Offline stand-in for the Open-Meteo water-year precipitation (a normal winter: the month table applies)."""
    return {"precip_mm": 150.0, "from": "2024-10-01", "to": ms_to_iso(start_ms - DAY_MS)[:10], "days": 99,
            "source": "fake:precip", "fetched_ms": 0, "warnings": []}


@pytest.fixture
def hist(tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[BuildContext, FakeSource, list]:
    monkeypatch.setattr(WB, "water_year_precip", _fake_water_year_precip)
    ctx, calls = make_ctx(tmp_data_dir, "historical", iso_to_ms("2025-01-08T02:18:00Z"))
    src = FakeSource(ctx.fire_grid)
    WB.build_weather(ctx, source=src)
    return ctx, src, calls


@pytest.fixture
def live(tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[BuildContext, FakeSource]:
    monkeypatch.setattr(WB, "now_ms", lambda: NOW)
    monkeypatch.setattr(WB, "water_year_precip", _fake_water_year_precip)
    ctx, _ = make_ctx(tmp_data_dir, "live", NOW - 2 * DAY_MS)
    src = FakeSource(ctx.fire_grid, hrrr_until=floor_hour_ms(NOW) + 40 * HOUR_MS, forecast_from=floor_hour_ms(NOW) + HOUR_MS)
    WB.build_weather(ctx, source=src)
    return ctx, src


# ----------------------------------------------------------------------------------------------------------------
# weather.json
# ----------------------------------------------------------------------------------------------------------------
def test_build_weather_historical(hist) -> None:
    ctx, src, calls = hist
    raw = (ctx.bundle_dir / "weather.json").read_bytes()
    wf = validate_strict(WeatherFile, raw)
    t = np.asarray(wf.t_ms, dtype=np.int64)
    assert t[0] == ctx.time_origin_ms - 72 * HOUR_MS and t[-1] == ctx.time_origin_ms + (120 + 72) * HOUR_MS
    assert np.all(np.diff(t) == HOUR_MS)
    assert src.calls == [("det", int(t[0]), int(t[-1]))]
    af = wf.at_fire
    x, z = IGN_XZ
    assert np.allclose(af.temp_c, 20.0 + 1e-3 * x - 2e-3 * z + 6.0 * diurnal(t), atol=0.006)      # bilinear is exact
    assert np.allclose(af.rh_pct, 35.0 + 5e-4 * x - 10.0 * diurnal(t), atol=0.06)
    assert np.allclose(af.wind_speed_ms, 6.0 + 1e-4 * x, atol=0.006)
    assert np.allclose(np.asarray(af.wind_dir_deg) % 360.0, 270.0, atol=0.06)
    assert np.allclose(af.wind_gust_ms, 1.5 * (6.0 + 1e-4 * x), atol=0.006)
    temp, rh = np.asarray(af.temp_c), np.asarray(af.rh_pct)
    assert np.allclose(af.fm1_pct, np.maximum(1.03 * mo.emc(temp, rh), 2.0), atol=0.02)
    assert np.allclose(af.ffwi, mo.ffwi(temp, rh, np.asarray(af.wind_speed_ms)), atol=0.15)
    assert np.all(np.asarray(af.fm100_pct) > 2.0) and np.ptp(af.fm100_pct) < np.ptp(af.fm10_pct) < np.ptp(af.fm1_pct)
    assert wf.forecast_from_ms is None and wf.source == "fake:det"
    # grid: x west->east, z north->south, u/v flattened [t][j][i]; FROM 270 => u > 0 (eastward), v ~ 0
    xs, zs = weather_axes(ctx.fire_grid)
    assert wf.grid.x == pytest.approx(xs) and wf.grid.z == pytest.approx(zs) and wf.grid.nx == wf.grid.ny == 4
    u = np.asarray(wf.grid.u_ms).reshape(len(t), 4, 4)
    v = np.asarray(wf.grid.v_ms).reshape(len(t), 4, 4)
    assert np.all(u > 0) and np.allclose(v, 0.0, atol=0.006)
    assert np.allclose(u[5], (6.0 + 1e-4 * np.asarray(xs))[None, :].repeat(4, 0), atol=0.006)   # varies along i only
    # manifest bookkeeping + progress
    m = bundle.load_manifest(ctx.bundle_dir)
    assert [d["name"] for d in m["data_sources"]] == ["Other", "Weather"]
    assert m["warnings"] == ["Other: keep me", "Weather: fake det warning"]
    ante = WB.load_antecedent(ctx.bundle_dir)                                  # drought adjustment input stored
    assert ante is not None and ante["precip_wy_mm"] == 150.0 and ante["source"] == "fake:precip"
    assert calls[0][:2] == ("weather", 0.0) and calls[-1][:2] == ("weather", 1.0)
    assert all(c[0] == "weather" for c in calls)
    gw = WB.load_grid_weather(ctx.bundle_dir)
    assert gw is not None and np.array_equal(gw.t_ms, t) and gw.hrrr.all() and gw.source == "fake:det"
    assert np.allclose(gw.wind_speed_ms[:, 0, :], 6.0 + 1e-4 * np.asarray(xs)[None, :], atol=1e-4)


def test_build_weather_rerun_replaces_bookkeeping(hist) -> None:
    ctx, src, _ = hist
    WB.build_weather(ctx, source=src)
    m = bundle.load_manifest(ctx.bundle_dir)
    assert [d["name"] for d in m["data_sources"]].count("Weather") == 1
    assert m["warnings"].count("Weather: fake det warning") == 1 and "Other: keep me" in m["warnings"]


def test_build_weather_live_window_and_forecast_from(live) -> None:
    ctx, src = live
    wf = validate_strict(WeatherFile, (ctx.bundle_dir / "weather.json").read_bytes())
    start = ctx.time_origin_ms
    assert wf.t_ms[0] == floor_hour_ms(start - 72 * HOUR_MS)
    assert wf.t_ms[-1] == ceil_hour_ms(NOW + 96 * HOUR_MS)
    assert wf.forecast_from_ms == floor_hour_ms(NOW) + HOUR_MS


def test_build_weather_at_aoi_centre_without_ignition(tmp_data_dir: Path) -> None:
    ctx, _ = make_ctx(tmp_data_dir, "historical", iso_to_ms("2025-01-08T02:18:00Z"), ignition=False)
    WB.build_weather(ctx, source=FakeSource(ctx.fire_grid))
    wf = validate_strict(WeatherFile, (ctx.bundle_dir / "weather.json").read_bytes())
    assert np.allclose(wf.at_fire.temp_c, 20.0 + 6.0 * diurnal(np.asarray(wf.t_ms)), atol=0.006)
    assert "AOI centre" in bundle.load_manifest(ctx.bundle_dir)["data_sources"][-1]["detail"]


def test_weather_window_rules() -> None:
    s = iso_to_ms("2025-01-07T17:00:00Z")
    e = s + 4 * DAY_MS + 30 * 60_000
    assert WB.weather_window("historical", s, e, NOW) == (s - 72 * HOUR_MS, ceil_hour_ms(e + 72 * HOUR_MS))
    assert WB.weather_window("live", NOW - 2 * DAY_MS, None, NOW) == (floor_hour_ms(NOW - 2 * DAY_MS - 72 * HOUR_MS), ceil_hour_ms(NOW + 96 * HOUR_MS))
    assert WB.weather_window("live", NOW - 30 * DAY_MS, None, NOW)[0] == floor_hour_ms(NOW - 7 * DAY_MS - 72 * HOUR_MS)


def test_bilinear_at_is_exact_for_linear_fields_and_clamps() -> None:
    xs, zs = [-3.0, -1.0, 1.0, 3.0], [-3.0, -1.0, 1.0, 3.0]
    X, Z = np.meshgrid(xs, zs)
    field = (2.0 + 0.5 * X - 0.25 * Z)[None].repeat(3, 0)
    assert np.allclose(WB.bilinear_at(field, xs, zs, 0.4, -2.2), 2.0 + 0.2 + 0.55)
    assert np.allclose(WB.bilinear_at(field, xs, zs, 3.0, -3.0), 2.0 + 1.5 + 0.75)
    assert np.allclose(WB.bilinear_at(field, xs, zs, 9.0, -9.0), 2.0 + 1.5 + 0.75)     # outside: edge cell
    assert WB.bilinear_at(field, xs, zs, 0.0, 0.0).shape == (3,)


def test_grid_weather_window_holds_edges(hist) -> None:
    ctx, _, _ = hist
    gw = WB.load_grid_weather(ctx.bundle_dir)
    a = int(gw.t_ms[0]) - 3 * HOUR_MS
    w, held = gw.window(a, int(gw.t_ms[0]) + 2 * HOUR_MS)
    assert held == 3 and len(w.t_ms) == 6 and np.allclose(w.temp_c[0], gw.temp_c[0]) and not w.hrrr[:3].any()


# ----------------------------------------------------------------------------------------------------------------
# Forecast members
# ----------------------------------------------------------------------------------------------------------------
def _uv(mw: MemberWeather) -> tuple[np.ndarray, np.ndarray]:
    return wind_to_uv(mw.wind_speed_10m_kmh / 3.6, mw.upwind_dir_deg)


def test_members_none_alignment_units_and_spinup(hist) -> None:
    ctx, src, _ = hist
    start = ctx.time_origin_ms + 30 * HOUR_MS + 17 * 60_000
    ml = WB.member_weathers(ctx.bundle_dir, start, 72, "none", source=src)
    assert len(ml) == 1 and ml.ensemble == "none" and ml[0].label == "deterministic"
    assert len(src.calls) == 1                                   # historical: the stored weather covers the window
    mw = ml[0]
    t = mw.t_ms
    assert t.dtype == np.int64 and t[0] == floor_hour_ms(start) and t[-1] == ceil_hour_ms(start + 72 * HOUR_MS)
    assert np.all(np.diff(t) == HOUR_MS) and len(t) == 74
    for a in (mw.wind_speed_10m_kmh, mw.upwind_dir_deg, mw.temp_c, mw.rh_pct, mw.fm1, mw.fm10, mw.fm100):
        assert a.shape == (len(t), 4, 4)
    xs, _ = weather_axes(ctx.fire_grid)
    assert np.allclose(mw.wind_speed_10m_kmh[:, 2, :], 3.6 * (6.0 + 1e-4 * np.asarray(xs))[None, :], atol=1e-3)
    assert np.allclose(mw.upwind_dir_deg, 270.0, atol=1e-6)
    # moisture is spun up over the 72 h before the start (not initialised at the start)
    gw, _ = WB.load_grid_weather(ctx.bundle_dir).window(int(t[0]) - 72 * HOUR_MS, int(t[-1]))
    fm1, fm10, fm100 = mo.dead_fuel_moisture(gw.temp_c, gw.rh_pct, precip_mm=gw.precip_mm)
    assert np.allclose(mw.fm10, fm10[72:]) and np.allclose(mw.fm100, fm100[72:]) and np.allclose(mw.fm1, fm1[72:])
    cold = mo.dead_fuel_moisture(gw.temp_c[72:], gw.rh_pct[72:])[2]
    assert not np.allclose(mw.fm100, cold)
    assert (mw.fm_live_herb, mw.fm_live_woody, mw.foliar_moisture) == (1.2, 1.2, 1.0)    # January defaults


def test_members_perturbed_statistics(hist) -> None:
    ctx, src, _ = hist
    start = ctx.time_origin_ms + 24 * HOUR_MS
    det = WB.member_weathers(ctx.bundle_dir, start, 96, "none", source=src)[0]
    ml = WB.member_weathers(ctx.bundle_dir, start, 96, "perturbed", members=241, source=src)
    assert len(ml) == 241 and ml.ensemble == "perturbed" and ml[0].label == "perturbed-00" and ml[17].label == "perturbed-17"
    assert "perturbed" in ml.source
    m0 = ml[0]
    for name in ("wind_speed_10m_kmh", "upwind_dir_deg", "temp_c", "rh_pct", "fm1", "fm10", "fm100"):
        assert np.allclose(getattr(m0, name), getattr(det, name)), name       # member 0 is unperturbed
    rest = ml[1:]
    ls = np.stack([np.log(m.wind_speed_10m_kmh / det.wind_speed_10m_kmh) for m in rest])
    dd = np.stack([(m.upwind_dir_deg - det.upwind_dir_deg + 180.0) % 360.0 - 180.0 for m in rest])
    dr = np.stack([m.rh_pct - det.rh_pct for m in rest])
    dt = np.stack([m.temp_c - det.temp_c for m in rest])
    assert abs(ls.mean()) < 0.03 and ls.std() == pytest.approx(0.25, rel=0.1)
    assert abs(dd.mean()) < 2.5 and dd.std() == pytest.approx(20.0, rel=0.1)
    assert abs(dr.mean()) < 0.8 and dr.std() == pytest.approx(6.0, rel=0.1)
    assert abs(dt.mean()) < 0.2 and dt.std() == pytest.approx(1.5, rel=0.1)
    # AR(1) with tau = 8 h: lag-1 autocorrelation exp(-1/8)
    x = dt[:, :, 0, 0]
    r1 = np.mean(x[:, 1:] * x[:, :-1]) / np.mean(x * x)
    assert r1 == pytest.approx(math.exp(-1 / 8), abs=0.03)
    # spatially coherent perturbation; moisture recomputed from the perturbed T/RH
    assert np.allclose(dt[:, :, 0, 0], dt[:, :, 3, 2])
    m5 = ml[5]
    assert np.allclose(m5.fm1, np.maximum(1.03 * mo.emc(m5.temp_c, m5.rh_pct) / 100.0, mo.MIN_DEAD_FM))
    assert not np.allclose(m5.fm10, det.fm10)
    assert all(np.all((m.rh_pct >= 1.0) & (m.rh_pct <= 100.0)) for m in ml)
    # deterministic seeds
    again = WB.member_weathers(ctx.bundle_dir, start, 96, "perturbed", members=6, source=src)
    for a, b in zip(again, ml[:6]):
        assert np.array_equal(a.temp_c, b.temp_c) and np.array_equal(a.wind_speed_10m_kmh, b.wind_speed_10m_kmh)
    assert len(WB.member_weathers(ctx.bundle_dir, start, 24, "perturbed", source=src)) == 31     # default 31


def test_ar1_series_statistics() -> None:
    rng = np.random.default_rng(7)
    x = np.stack([WB.ar1_series(rng, 400) for _ in range(300)])
    assert x.std() == pytest.approx(1.0, rel=0.05) and abs(x.mean()) < 0.05
    assert np.mean(x[:, 1:] * x[:, :-1]) / np.mean(x * x) == pytest.approx(math.exp(-1 / 8), abs=0.02)
    assert np.mean(x[:, 8:] * x[:, :-8]) / np.mean(x * x) == pytest.approx(math.exp(-1), abs=0.04)
    assert WB.ar1_series(rng, 1).shape == (1,) and WB.ar1_series(rng, 0).shape == (0,)


def test_members_bias_corrected_and_blended(live) -> None:
    ctx, src = live
    hrrr_end = floor_hour_ms(NOW) + 40 * HOUR_MS
    ml = WB.member_weathers(ctx.bundle_dir, NOW, 72, "gfs025", source=src)
    assert len(ml) == 31 and ml.ensemble == "gfs025" and ml[0].label == "control" and ml[30].label == "member30"
    assert "bias-corrected" in ml.source and ("gfs025", NOW - 72 * HOUR_MS - NOW % HOUR_MS, ceil_hour_ms(NOW + 72 * HOUR_MS)) in src.calls
    det = WB.member_weathers(ctx.bundle_dir, NOW, 72, "none", source=src)[0]
    t = det.t_ms
    assert np.array_equal(ml[0].t_ms, t) and t[0] == floor_hour_ms(NOW)
    temp = np.stack([m.temp_c for m in ml])
    rh = np.stack([m.rh_pct for m in ml])
    uv = [_uv(m) for m in ml]
    u = np.stack([a for a, _ in uv])
    v = np.stack([b for _, b in uv])
    du, dv = _uv(det)
    on = t < hrrr_end
    after = t >= hrrr_end + 5 * HOUR_MS          # last HRRR hour + 6 h
    # while HRRR exists the members are centred on it ...
    assert np.allclose(temp.mean(0)[on], det.temp_c[on], atol=1e-9)
    assert np.allclose(rh.mean(0)[on], det.rh_pct[on], atol=1e-9)
    assert np.allclose(u.mean(0)[on], du[on], atol=1e-9) and np.allclose(v.mean(0)[on], dv[on], atol=1e-9)
    # ... and keep their spread; 6 h after HRRR ends they are the raw members (bias +2 °C, -5 % RH, +1/-0.5 m/s)
    assert np.allclose(temp.std(0)[on], 0.8 / math.sqrt(2), atol=1e-6)
    assert np.allclose(temp.mean(0)[after] - det.temp_c[after], 2.0, atol=1e-9)
    assert np.allclose(rh.mean(0)[after] - det.rh_pct[after], -5.0, atol=1e-9)
    assert np.allclose(u.mean(0)[after] - du[after], 1.0, atol=1e-9) and np.allclose(v.mean(0)[after] - dv[after], -0.5, atol=1e-9)
    # continuous blend: the offset changes by at most |bias| / 6 per hour
    off_t = temp.mean(0)[:, 0, 0] - det.temp_c[:, 0, 0]
    assert np.max(np.abs(np.diff(off_t))) <= 2.0 / 6 + 1e-9
    k = int(np.flatnonzero(~on)[0])
    assert off_t[k] == pytest.approx(2.0 / 6, abs=1e-9) and off_t[k + 2] == pytest.approx(2.0 * 3 / 6, abs=1e-9)
    # fewer members on request; ECMWF has 51
    assert [m.label for m in WB.member_weathers(ctx.bundle_dir, NOW, 24, "gfs025", members=5, source=src)] == \
        ["control", "member01", "member02", "member03", "member04"]
    assert len(WB.member_weathers(ctx.bundle_dir, NOW, 24, "ecmwf_ifs025", source=src)) == 51


def test_members_ensemble_unavailable_falls_back_to_perturbed(live) -> None:
    ctx, _ = live
    src = FakeSource(ctx.fire_grid, ens=False, hrrr_until=floor_hour_ms(NOW) + 40 * HOUR_MS)
    ml = WB.member_weathers(ctx.bundle_dir, NOW, 48, "gfs025", source=src)
    assert ml.ensemble == "perturbed" and len(ml) == 31 and ml[1].label == "perturbed-01"
    assert any("unavailable" in w and "fake: no ensemble" in w for w in ml.warnings)
    assert len(WB.member_weathers(ctx.bundle_dir, NOW, 48, "ecmwf_ifs025", members=7, source=src)) == 7


def test_members_live_fetch_failure_uses_stored_weather(live) -> None:
    ctx, _ = live
    src = FakeSource(ctx.fire_grid, fail=True, ens=False)
    ml = WB.member_weathers(ctx.bundle_dir, NOW, 24, "none", source=src)
    assert len(ml) == 1 and any("fetch failed" in w for w in ml.warnings)
    assert ml[0].t_ms[0] == floor_hour_ms(NOW)


def test_members_auto_and_validation(hist, live) -> None:
    hctx, hsrc, _ = hist
    lctx, lsrc = live
    assert WB.member_weathers(hctx.bundle_dir, hctx.time_origin_ms + 30 * HOUR_MS, 12, "auto", members=3, source=hsrc).ensemble == "perturbed"
    assert WB.member_weathers(lctx.bundle_dir, NOW, 12, "auto", members=3, source=lsrc).ensemble == "gfs025"
    with pytest.raises(ValueError):
        WB.member_weathers(hctx.bundle_dir, NOW, 12, "gefs", source=hsrc)
    with pytest.raises(ValueError):
        WB.member_weathers(hctx.bundle_dir, NOW, 0, "none", source=hsrc)
    with pytest.raises(ValueError):
        WB.member_weathers(hctx.bundle_dir, NOW, 12, "perturbed", members=0, source=hsrc)
    with pytest.raises(WeatherError):
        WB.member_weathers(hctx.bundle_dir.parent / "missing", NOW, 12, "none", source=hsrc)


def test_members_rh_clamped(tmp_data_dir: Path) -> None:
    ctx, _ = make_ctx(tmp_data_dir, "historical", iso_to_ms("2025-07-08T02:18:00Z"))
    src = FakeSource(ctx.fire_grid, rh_low=True)
    WB.build_weather(ctx, source=src)
    ml = WB.member_weathers(ctx.bundle_dir, ctx.time_origin_ms + 20 * HOUR_MS, 24, "perturbed", members=5, source=src)
    assert all(np.all(m.rh_pct >= 1.0) for m in ml) and np.allclose(ml[0].rh_pct, 1.0)
    assert (ml[0].fm_live_herb, ml[0].fm_live_woody) == (0.3, 0.7)          # July defaults


def test_member_list_pickles_with_provenance(hist) -> None:
    ctx, src, _ = hist
    ml = WB.member_weathers(ctx.bundle_dir, ctx.time_origin_ms + 30 * HOUR_MS, 6, "perturbed", members=2, source=src)
    back = pickle.loads(pickle.dumps(ml))
    assert isinstance(back, list) and len(back) == 2 and back.source == ml.source and back.ensemble == "perturbed"
    assert isinstance(back[1], MemberWeather) and np.array_equal(back[1].temp_c, ml[1].temp_c)


def test_fake_source_satisfies_protocol(hist) -> None:
    _, src, _ = hist
    assert isinstance(src, WeatherSource)


def test_members_from_fixture_bundles(fixture_bundle: Path, fixture_live_bundle: Path) -> None:
    m = bundle.load_manifest(fixture_bundle)
    start = m["time_range"]["start_ms"] + 30 * HOUR_MS
    ml = WB.member_weathers(fixture_bundle, start, 72, "perturbed")
    assert len(ml) == 31 and ml[0].t_ms[0] == floor_hour_ms(start) and ml[0].wind_speed_10m_kmh.shape == (73, 4, 4)
    lm = bundle.load_manifest(fixture_live_bundle)
    now = lm["time_range"]["now_ms"]
    ml = WB.member_weathers(fixture_live_bundle, now, 72, "auto")         # synthetic: no network, perturbed fallback
    assert ml.ensemble == "perturbed" and len(ml) == 31 and any("synthetic" in w for w in ml.warnings)
    assert all(np.all(np.isfinite(getattr(mm, f))) for mm in ml for f in ("fm1", "fm10", "fm100", "wind_speed_10m_kmh"))


def test_build_weather_propagates_total_failure(tmp_data_dir: Path) -> None:
    ctx, _ = make_ctx(tmp_data_dir, "historical", iso_to_ms("2025-01-08T02:18:00Z"))
    with pytest.raises(RuntimeError):
        WB.build_weather(ctx, source=FakeSource(ctx.fire_grid, fail=True))
    assert not (ctx.bundle_dir / "weather.json").exists()


def test_build_weather_historical_end_fallback(tmp_data_dir: Path) -> None:
    started = iso_to_ms("2025-01-08T02:18:00Z")
    ctx, _ = make_ctx(tmp_data_dir, "historical", started)
    bundle.update_manifest(ctx.bundle_dir, lambda m: m.pop("time_range"))
    contained = started + 10 * DAY_MS + 25 * 60_000
    ctx.end_ms = None
    ctx.summary = ctx.summary.model_copy(update={"contained_ms": contained})
    WB.build_weather(ctx, source=FakeSource(ctx.fire_grid))
    wf = validate_strict(WeatherFile, (ctx.bundle_dir / "weather.json").read_bytes())
    assert wf.t_ms[0] == ctx.time_origin_ms - 72 * HOUR_MS and wf.t_ms[-1] == ceil_hour_ms(contained + 72 * HOUR_MS)
    ctx.summary = ctx.summary.model_copy(update={"contained_ms": started + 400 * DAY_MS})   # capped at start + 45 d
    WB.build_weather(ctx, source=FakeSource(ctx.fire_grid))
    wf = validate_strict(WeatherFile, (ctx.bundle_dir / "weather.json").read_bytes())
    assert wf.t_ms[-1] == ctx.time_origin_ms + (45 * 24 + 72) * HOUR_MS
