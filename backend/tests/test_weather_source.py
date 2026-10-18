"""sources/weather.py: helpers (u/v, blending, gap filling) and OpenMeteoSource against a mock Open-Meteo server."""

from __future__ import annotations

from datetime import date, datetime, timezone

import httpx
import numpy as np
import pytest

import fire3d.http as fhttp
from fire3d.sources import weather as W
from fire3d.timeutil import DAY_MS, HOUR_MS, floor_hour_ms, iso_to_ms

NOW = iso_to_ms("2026-10-16T12:30:00Z")
HRRR_FORECAST_H = 44                       # the mock's HRRR stops 44 h after the current hour


# ----------------------------------------------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------------------------------------------
def test_wind_uv_conventions() -> None:
    u, v = W.wind_to_uv(10.0, 270.0)        # wind FROM the west blows toward the east
    assert u == pytest.approx(10.0) and abs(v) < 1e-9
    u, v = W.wind_to_uv(10.0, 0.0)          # from the north -> toward the south
    assert abs(u) < 1e-9 and v == pytest.approx(-10.0)
    u, v = W.wind_to_uv(10.0, 90.0)
    assert u == pytest.approx(-10.0)
    u, v = W.wind_to_uv(10.0, 45.0)         # NE (Santa Ana) wind blows toward the SW
    assert u < 0 and v < 0
    dirs = np.arange(0.0, 360.0, 7.5)
    s, d = W.uv_to_wind(*W.wind_to_uv(np.full_like(dirs, 6.0), dirs))
    assert np.allclose(s, 6.0) and np.allclose(d, dirs)
    s0, d0 = W.uv_to_wind(np.array([0.0, np.nan]), np.array([0.0, 1.0]))
    assert s0[0] == 0.0 and d0[0] == 0.0 and np.isnan(d0[1])


def test_dewpoint_rh_roundtrip() -> None:
    t = np.array([-5.0, 10.0, 25.0, 38.0])
    rh = np.array([90.0, 55.0, 20.0, 6.0])
    assert np.allclose(W.rh_from_dewpoint(t, W.dewpoint_from_rh(t, rh)), rh, atol=1e-6)
    assert W.rh_from_dewpoint(20.0, 20.0) == pytest.approx(100.0)


def test_hourly_axis_and_date_chunks() -> None:
    t = W.hourly_axis(iso_to_ms("2025-01-07T03:20:00Z"), iso_to_ms("2025-01-07T06:01:00Z"))
    assert t[0] == iso_to_ms("2025-01-07T03:00:00Z") and t[-1] == iso_to_ms("2025-01-07T07:00:00Z") and len(t) == 5
    with pytest.raises(ValueError):
        W.hourly_axis(10 * HOUR_MS, 5 * HOUR_MS)
    ch = W.date_chunks(iso_to_ms("2025-01-01T05:00:00Z"), iso_to_ms("2025-02-15T00:00:00Z"))
    assert ch == [("2025-01-01", "2025-01-31"), ("2025-02-01", "2025-02-15")]
    assert W.date_chunks(iso_to_ms("2025-01-01"), iso_to_ms("2025-01-01T23:00:00Z")) == [("2025-01-01", "2025-01-01")]


def test_blend_offsets_interpolates_and_decays() -> None:
    T = 30
    diff = np.full(T, 4.0)
    have = np.zeros(T, dtype=bool)
    have[5:10] = True
    have[14:16] = True
    diff[14:16] = 2.0
    off = W.blend_offsets(diff, have, blend_h=6.0)
    assert np.allclose(off[5:10], 4.0) and np.allclose(off[14:16], 2.0)
    assert np.allclose(off[10:14], [3.6, 3.2, 2.8, 2.4])            # linear across the interior gap
    assert np.allclose(off[16:23], [2.0 * (1 - k / 6) for k in range(1, 7)] + [0.0])
    assert np.allclose(off[22:], 0.0)
    assert np.allclose(off[:5], [4.0 * (1 - k / 6) for k in (5, 4, 3, 2, 1)])
    assert np.max(np.abs(np.diff(off))) <= 4.0 / 6 + 1e-12            # never a step
    grid = W.blend_offsets(np.ones((T, 4, 4)), have, 6.0)
    assert grid.shape == (T, 4, 4) and np.allclose(grid[7], 1.0)
    assert np.all(W.blend_offsets(diff, np.zeros(T, dtype=bool)) == 0.0)


def test_merge_fields_blends_fill_without_steps() -> None:
    T, P = 24, 2
    t = np.arange(T, dtype=float)
    primary = {k: np.full((T, P), np.nan) for k in W.FIELDS}
    fill = {
        "temp_c": np.tile(20 + 0.1 * t[:, None], (1, P)), "rh_pct": np.full((T, P), 30.0), "dewpoint_c": np.full((T, P), 2.0),
        "wind_speed_ms": np.full((T, P), 5.0), "wind_dir_deg": np.full((T, P), 90.0), "wind_gust_ms": np.full((T, P), 8.0),
        "precip_mm": np.zeros((T, P)),
    }
    for k in W.FIELDS:
        primary[k][:10] = fill[k][:10]
    primary["temp_c"][:10] += 2.0              # primary runs 2 °C warmer than the fill
    primary["wind_dir_deg"][:10] = 100.0
    out = W.merge_fields(primary, fill, blend_h=6.0)
    assert np.allclose(out["temp_c"][:10], primary["temp_c"][:10])
    expect = fill["temp_c"][10:, 0] + 2.0 * np.clip(1 - (t[10:] - 9) / 6, 0, 1)
    assert np.allclose(out["temp_c"][10:, 0], expect)
    assert np.allclose(out["temp_c"][16:], fill["temp_c"][16:])
    assert np.all(np.isfinite(out["wind_dir_deg"])) and 90.0 <= out["wind_dir_deg"][12, 0] <= 100.0
    assert np.allclose(out["wind_dir_deg"][16:], 90.0)


def test_finalize_fields_fills_gaps_and_derives() -> None:
    T, P = 12, 3
    f = {
        "temp_c": np.tile(np.linspace(10, 21, T)[:, None], (1, P)), "rh_pct": np.full((T, P), 40.0),
        "dewpoint_c": np.full((T, P), np.nan), "wind_speed_ms": np.full((T, P), 4.0), "wind_dir_deg": np.full((T, P), 350.0),
        "wind_gust_ms": np.full((T, P), np.nan), "precip_mm": np.full((T, P), np.nan),
    }
    f["wind_dir_deg"][:, 1] = 10.0
    f["temp_c"][4:7, 0] = np.nan
    f["rh_pct"][:, 2] = np.nan                 # a point without RH at all
    warn: list[str] = []
    out = W.finalize_fields(f, warn)
    assert np.allclose(out["temp_c"][:, 0], np.linspace(10, 21, T))
    assert np.allclose(out["rh_pct"][:, 2], 40.0)
    assert np.allclose(out["dewpoint_c"], W.dewpoint_from_rh(out["temp_c"], out["rh_pct"]))
    assert np.allclose(out["wind_gust_ms"], 6.0) and np.all(out["precip_mm"] == 0.0)
    assert any("interpolated" in w for w in warn) and any("no rh_pct" in w for w in warn) and any("gusts" in w for w in warn)
    for k in W.FIELDS:
        assert np.all(np.isfinite(out[k])), k
    bad = {**f, "temp_c": np.full((T, P), np.nan)}
    with pytest.raises(W.WeatherError):
        W.finalize_fields(bad, [])


# ----------------------------------------------------------------------------------------------------------------
# Mock Open-Meteo
# ----------------------------------------------------------------------------------------------------------------
def truth(var: str, lat: float, lon: float, ts: np.ndarray) -> np.ndarray:
    """Synthetic 'true' hourly weather (smooth in time, distinct per location)."""
    h = ts / 3600.0
    day = np.sin(2 * np.pi * (h % 24 - 9) / 24)
    if var == "temperature_2m":
        return 12.0 + 40.0 * (lat - 34.0) + 6.0 * day
    if var == "relative_humidity_2m":
        return np.clip(45.0 - 20.0 * day + 10.0 * (lon + 118.0), 3.0, 100.0)
    if var == "dew_point_2m":
        return W.dewpoint_from_rh(truth("temperature_2m", lat, lon, ts), truth("relative_humidity_2m", lat, lon, ts))
    if var == "wind_speed_10m":
        return 4.0 + 2.0 * np.cos(2 * np.pi * h / 72.0) + 10.0 * (lat - 34.0)
    if var == "wind_direction_10m":
        return np.full_like(h, (40.0 + 200.0 * (lon + 118.0)) % 360.0)
    if var == "wind_gusts_10m":
        return 1.6 * truth("wind_speed_10m", lat, lon, ts)
    if var == "precipitation":
        return np.where((h % 240) < 2, 0.5, 0.0)
    raise KeyError(var)


class FakeOpenMeteo:
    """httpx handler answering forecast / historical-forecast / archive / ensemble requests with :func:`truth`."""

    def __init__(self, fail: frozenset[str] = frozenset(), hrrr_hole: tuple[int, int] | None = None, gfs_bias_everywhere: bool = False):
        self.fail = set(fail)
        self.hrrr_hole = hrrr_hole              # (start_ms, end_ms) with HRRR null at point 0 (historical)
        self.gfs_bias_everywhere = gfs_bias_everywhere   # seamless = pure GFS (+1 °C) even where HRRR exists
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host
        kind = {"api.open-meteo.com": "forecast", "historical-forecast-api.open-meteo.com": "historical",
                "archive-api.open-meteo.com": "archive", "ensemble-api.open-meteo.com": "ensemble"}[host]
        q = dict(request.url.params)
        self.calls.append((kind, q))
        if kind in self.fail:
            return httpx.Response(400, json={"error": True, "reason": "test failure"})
        lats = [float(v) for v in q["latitude"].split(",")]
        lons = [float(v) for v in q["longitude"].split(",")]
        d0, d1 = date.fromisoformat(q["start_date"]), date.fromisoformat(q["end_date"])
        t0 = int(datetime(d0.year, d0.month, d0.day, tzinfo=timezone.utc).timestamp())
        n = ((d1 - d0).days + 1) * 24
        ts = t0 + 3600 * np.arange(n)
        variables = q["hourly"].split(",")
        models = q.get("models", "").split(",") if q.get("models") else []
        locs = []
        for p, (la, lo) in enumerate(zip(lats, lons)):
            hourly: dict = {"time": [int(x) for x in ts]}
            for var in variables:
                base = truth(var, la, lo, ts.astype(float))
                if kind == "ensemble":
                    size = {"gfs025": 31, "ecmwf_ifs025": 51}[models[0]]
                    for k in range(size):
                        key = var if k == 0 else f"{var}_member{k:02d}"
                        val = base + (0.1 * k if var == "temperature_2m" else 0.0)
                        hourly[key] = [float(x) for x in val]
                elif kind == "archive":
                    hourly[var] = [float(x) + (0.5 if var == "temperature_2m" else 0.0) for x in base]
                else:
                    hrrr = base.astype(object)
                    if kind == "forecast":
                        hrrr[ts * 1000 >= floor_hour_ms(NOW) + HRRR_FORECAST_H * HOUR_MS] = None
                    if self.hrrr_hole and p == 0:
                        hrrr[(ts * 1000 >= self.hrrr_hole[0]) & (ts * 1000 < self.hrrr_hole[1])] = None
                    bias = 1.0 if var == "temperature_2m" else 0.0
                    # like Open-Meteo, gfs_seamless equals gfs_hrrr wherever HRRR exists (unless gfs_bias_everywhere)
                    seamless = base + bias if self.gfs_bias_everywhere else np.where(hrrr == None, base + bias, base)  # noqa: E711
                    hourly[f"{var}_gfs_hrrr"] = [None if x is None else float(x) for x in hrrr]
                    hourly[f"{var}_gfs_seamless"] = [float(x) for x in seamless]
            locs.append({"latitude": la, "longitude": lo, "hourly": hourly})
        return httpx.Response(200, json=locs if len(locs) > 1 else locs[0])


@pytest.fixture
def fake_om(tmp_data_dir, monkeypatch: pytest.MonkeyPatch) -> FakeOpenMeteo:
    fake = FakeOpenMeteo()
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(fake))
    monkeypatch.setattr(W, "now_ms", lambda: NOW)
    return fake


POINTS = [(34.10 + 0.02 * j, -118.20 + 0.03 * i) for j in range(4) for i in range(4)]


def expected(var: str, t_ms: np.ndarray) -> np.ndarray:
    return np.stack([truth(var, la, lo, t_ms / 1000.0) for la, lo in POINTS], axis=1)


def test_deterministic_live_window(fake_om: FakeOpenMeteo) -> None:
    src = W.OpenMeteoSource()
    a, b = NOW - 10 * DAY_MS, NOW + 96 * HOUR_MS
    r = src.deterministic(POINTS, a, b)
    t = r["t_ms"]
    assert t[0] == floor_hour_ms(a) and t[-1] == W.ceil_hour_ms(b) and np.all(np.diff(t) == HOUR_MS)
    assert len(fake_om.calls) == 1                          # one multi-location request for all 16 points
    kind, q = fake_om.calls[0]
    assert kind == "forecast" and len(q["latitude"].split(",")) == 16 and q["models"] == "gfs_hrrr,gfs_seamless"
    assert q["timeformat"] == "unixtime" and q["wind_speed_unit"] == "ms"
    hrrr_end = floor_hour_ms(NOW) + HRRR_FORECAST_H * HOUR_MS
    assert np.array_equal(r["hrrr"], t < hrrr_end)
    assert r["source"] == "open-meteo:gfs_hrrr+gfs_seamless"
    assert r["forecast_from_ms"] == floor_hour_ms(NOW) + HOUR_MS
    for f, var in (("rh_pct", "relative_humidity_2m"), ("wind_speed_ms", "wind_speed_10m"), ("wind_dir_deg", "wind_direction_10m")):
        assert np.allclose(r[f], expected(var, t), atol=1e-6), f
    temp = expected("temperature_2m", t)
    assert np.allclose(r["temp_c"][t < hrrr_end], temp[t < hrrr_end])
    assert np.allclose(r["temp_c"][t >= hrrr_end], temp[t >= hrrr_end] + 1.0)   # GFS fill (seamless) after HRRR
    for f in W.FIELDS:
        assert r[f].shape == (len(t), 16) and np.all(np.isfinite(r[f])), f
    assert not r["warnings"]


def test_deterministic_historical_chunks_and_hrrr_gap(tmp_data_dir, monkeypatch: pytest.MonkeyPatch) -> None:
    hole = (iso_to_ms("2025-01-20T00:00:00Z"), iso_to_ms("2025-01-20T05:00:00Z"))
    fake = FakeOpenMeteo(hrrr_hole=hole, gfs_bias_everywhere=True)
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(fake))
    monkeypatch.setattr(W, "now_ms", lambda: NOW)
    a, b = iso_to_ms("2025-01-01T03:00:00Z"), iso_to_ms("2025-02-15T00:00:00Z")
    r = W.OpenMeteoSource().deterministic(POINTS, a, b)
    assert [c[0] for c in fake.calls] == ["historical", "historical"]
    assert [(c[1]["start_date"], c[1]["end_date"]) for c in fake.calls] == [("2025-01-01", "2025-01-31"), ("2025-02-01", "2025-02-15")]
    assert r["source"] == "open-meteo:historical-forecast:gfs_hrrr+gfs_seamless"
    assert r["forecast_from_ms"] is None
    t = r["t_ms"]
    in_hole = (t >= hole[0]) & (t < hole[1])
    assert np.array_equal(r["hrrr"], ~in_hole)
    assert np.allclose(r["temp_c"][~in_hole], expected("temperature_2m", t)[~in_hole])
    # the gap at point 0 is filled from GFS shifted by the HRRR-GFS offset around it, i.e. continuous
    assert np.allclose(r["temp_c"][in_hole, 0], expected("temperature_2m", t)[in_hole, 0], atol=1e-6)
    assert any("filled with GFS" in w for w in r["warnings"])
    # the cache makes a repeat free
    W.OpenMeteoSource().deterministic(POINTS, a, b)
    assert len(fake.calls) == 2


def test_deterministic_falls_back_to_era5(tmp_data_dir, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeOpenMeteo(fail=frozenset({"historical"}))
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(fake))
    monkeypatch.setattr(W, "now_ms", lambda: NOW)
    a, b = iso_to_ms("2025-01-05T00:00:00Z"), iso_to_ms("2025-01-12T00:00:00Z")
    r = W.OpenMeteoSource().deterministic(POINTS, a, b)
    assert [c[0] for c in fake.calls] == ["historical", "archive"]
    assert r["source"] == "open-meteo:archive:era5" and r["era5"] is True
    assert not r["hrrr"].any()
    assert np.allclose(r["temp_c"], expected("temperature_2m", r["t_ms"]) + 0.5)
    assert any("failed" in w for w in r["warnings"]) and any("ERA5" in w for w in r["warnings"])


def test_deterministic_raises_when_everything_fails(tmp_data_dir, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeOpenMeteo(fail=frozenset({"historical", "archive", "forecast"}))
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(fake))
    monkeypatch.setattr(W, "now_ms", lambda: NOW)
    with pytest.raises(W.WeatherError):
        W.OpenMeteoSource().deterministic(POINTS, iso_to_ms("2025-01-05"), iso_to_ms("2025-01-06"))


def test_deterministic_spanning_both_apis(fake_om: FakeOpenMeteo) -> None:
    a, b = NOW - 30 * DAY_MS, NOW + 24 * HOUR_MS
    r = W.OpenMeteoSource().deterministic(POINTS, a, b)
    kinds = [c[0] for c in fake_om.calls]
    assert kinds == ["historical", "forecast"]
    assert r["source"].startswith("open-meteo:historical-forecast+forecast:")
    assert np.all(np.diff(r["t_ms"]) == HOUR_MS) and np.all(np.isfinite(r["temp_c"]))


def test_ensemble_members(fake_om: FakeOpenMeteo) -> None:
    src = W.OpenMeteoSource()
    a, b = NOW - 72 * HOUR_MS, NOW + 72 * HOUR_MS
    for model, size in (("gfs025", 31), ("ecmwf_ifs025", 51)):
        e = src.ensemble(POINTS, a, b, model)
        assert e is not None
        T = len(e["t_ms"])
        assert e["members"][0] == "control" and e["members"][7] == "member07" and len(e["members"]) == size
        assert e["temp_c"].shape == (size, T, 16) and e["wind_dir_deg"].shape == (size, T, 16)
        assert np.allclose(e["temp_c"][7], expected("temperature_2m", e["t_ms"]) + 0.7)
        assert e["source"] == f"open-meteo:ensemble:{model}"
    assert all(c[1]["models"] in ("gfs025", "ecmwf_ifs025") for c in fake_om.calls)
    with pytest.raises(ValueError):
        src.ensemble(POINTS, a, b, "gefs05")


def test_ensemble_out_of_range_returns_none_without_request(fake_om: FakeOpenMeteo) -> None:
    src = W.OpenMeteoSource()
    assert src.ensemble(POINTS, iso_to_ms("2025-01-07"), iso_to_ms("2025-01-10"), "gfs025") is None
    assert src.last_error is not None and "days" in src.last_error
    assert fake_om.calls == []


def test_ensemble_failure_returns_none(tmp_data_dir, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeOpenMeteo(fail=frozenset({"ensemble"}))
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(fake))
    monkeypatch.setattr(W, "now_ms", lambda: NOW)
    src = W.OpenMeteoSource()
    assert src.ensemble(POINTS, NOW - DAY_MS, NOW + DAY_MS, "gfs025") is None
    assert "unavailable" in (src.last_error or "")


def test_protocol_and_points_validation() -> None:
    src = W.OpenMeteoSource()
    assert isinstance(src, W.WeatherSource)
    with pytest.raises(ValueError):
        src.deterministic([], NOW, NOW + HOUR_MS)
    with pytest.raises(ValueError):
        src.deterministic([(95.0, 0.0)], NOW, NOW + HOUR_MS)
    assert W.CHUNK_DAYS <= 31
