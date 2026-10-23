"""Open-Meteo request limits (CONTRACT 14.12.2, V-R7): no retries on a limit answer, a per-host block, no cached
error bodies, the per-host probe and its CLI, builds that fail instead of filling with ERA5, ``--require-hrrr``,
refused live builds and refreshes. Offline (httpx.MockTransport)."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

import fire3d.http as fhttp
from fire3d import bundle, cli, config
from fire3d.build import pipeline
from fire3d.build import weather_bundle as WB
from fire3d.sources import weather as W
from fire3d.timeutil import DAY_MS, iso_to_ms
from test_pipeline_support import FakeBuild, make_summary
from test_weather_bundle import FakeSource, make_ctx
from test_weather_source import NOW, POINTS, FakeOpenMeteo

DAILY_BODY = {"reason": "Daily API request limit exceeded. Please try again tomorrow.", "error": True}
HOURLY_BODY = {"reason": "Hourly API request limit exceeded. Please try again in the next hour.", "error": True}
LIVE_ID = "2026-live-fire-def456"
HIST_ID = "2025-test-fire-abc123"


@pytest.fixture(autouse=True)
def _no_blocks():
    W.clear_host_blocks()
    yield
    W.clear_host_blocks()


def _cache_files() -> list[Path]:
    return list((Path(config.CACHE_DIR) / config.HTTP_CACHE_DIR_NAME).rglob("*.bin"))


class Hosts:
    """MockTransport handler: a per-host-label answer (status, JSON or bytes); counts calls per label."""

    LABELS = {"api.open-meteo.com": "forecast", "historical-forecast-api.open-meteo.com": "historical-forecast",
              "archive-api.open-meteo.com": "archive", "ensemble-api.open-meteo.com": "ensemble"}

    def __init__(self, answers: dict[str, tuple[int, object]] | None = None, default: tuple[int, object] = (200, {"hourly": {}})):
        self.answers = answers or {}
        self.default = default
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        label = self.LABELS.get(request.url.host, request.url.host)
        self.calls.append((label, dict(request.url.params)))
        status, body = self.answers.get(label, self.default)
        if isinstance(body, (bytes, str)):
            return httpx.Response(status, content=body if isinstance(body, bytes) else body.encode())
        return httpx.Response(status, json=body)

    def count(self, label: str) -> int:
        return sum(1 for c in self.calls if c[0] == label)


@pytest.fixture
def hosts(tmp_data_dir, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)

    def install(answers: dict[str, tuple[int, object]] | None = None, **kw) -> Hosts:
        h = Hosts(answers, **kw)
        monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(h))
        return h

    return install


# ----------------------------------------------------------------------------------------------------------------
# fire3d.http: limit answers and error bodies
# ----------------------------------------------------------------------------------------------------------------
def test_quota_period_parsing() -> None:
    assert fhttp.quota_period(DAILY_BODY["reason"]) == "daily"
    assert fhttp.quota_period(b'{"reason":"Hourly API request limit exceeded."}') == "hourly"
    assert fhttp.quota_period("Minutely API request limit exceeded. Please try again in one minute.") == "minutely"
    assert fhttp.quota_period("Too many requests") is None and fhttp.quota_period(None) is None


def test_limit_429_is_not_retried_and_nothing_is_cached(hosts) -> None:
    h = hosts({"historical-forecast": (429, DAILY_BODY)})
    with pytest.raises(fhttp.HttpError) as ei:
        fhttp.request("GET", W.HISTORICAL_URL, params={"a": 1}, retries=4)
    assert ei.value.status == 429 and "Daily API request limit exceeded" in ei.value.message
    assert h.count("historical-forecast") == 1            # no retries against a daily cap
    assert _cache_files() == []


def test_plain_429_is_still_retried(hosts) -> None:
    h = hosts({"forecast": (429, {"reason": "slow down"})})
    with pytest.raises(fhttp.HttpError):
        fhttp.request("GET", W.FORECAST_URL, params={"a": 1}, retries=2)
    assert h.count("forecast") == 3


@pytest.mark.parametrize("body", [
    b"Unexpected error while streaming data: timeoutReached",
    b'{"hourly": {"time": [1, 2, 3]}}Unexpected error while streaming data: timeoutReached',
    b'{"error": true, "reason": "Cannot initialize WeatherVariable"}',
    b'{"error": {"code": 400, "message": "Invalid query parameters"}}',
    b'{"hourly": {"time": [1, 2',                       # cut off
])
def test_error_bodies_with_status_200_are_never_cached(hosts, body: bytes) -> None:
    h = hosts({"forecast": (200, body)})
    for _ in range(2):
        r = fhttp.request("GET", W.FORECAST_URL, params={"x": 1})
        assert r.content == body and not r.from_cache   # returned to the caller as before, never stored
    assert h.count("forecast") == 2 and _cache_files() == []


def test_good_body_is_cached_and_a_stored_error_body_is_evicted(hosts) -> None:
    h = hosts({"forecast": (200, {"hourly": {"time": [1]}})})
    fhttp.request("GET", W.FORECAST_URL, params={"x": 1})
    fhttp.request("GET", W.FORECAST_URL, params={"x": 1})
    assert h.count("forecast") == 1 and len(_cache_files()) == 1
    # an error body stored by an older version is evicted on read and fetched again
    key = fhttp.cache_key("GET", W.FORECAST_URL, {"x": 2})
    fhttp._cache_write(key, fhttp.Response(200, "u", b"Unexpected error while streaming data: timeoutReached", "application/json", False, 1))
    assert len(_cache_files()) == 2
    r = fhttp.request("GET", W.FORECAST_URL, params={"x": 2})
    assert not r.from_cache and r.json() == {"hourly": {"time": [1]}} and h.count("forecast") == 2
    assert fhttp.request("GET", W.FORECAST_URL, params={"x": 2}).from_cache


# ----------------------------------------------------------------------------------------------------------------
# sources/weather.py: per-host block
# ----------------------------------------------------------------------------------------------------------------
def test_daily_limit_raises_quota_error_and_blocks_only_that_host(hosts, monkeypatch) -> None:
    monkeypatch.setattr(W, "now_ms", lambda: NOW)
    h = hosts({"historical-forecast": (429, DAILY_BODY)})
    with pytest.raises(W.WeatherQuotaExceeded) as ei:
        W.om_request(W.HISTORICAL_URL, {"q": 1}, W.HISTORICAL_TTL_S)
    e = ei.value
    assert isinstance(e, W.WeatherError) and e.host == "historical-forecast" and e.period == "daily"
    assert str(e) == "Open-Meteo daily request limit reached; retry after the reset (00:00 UTC)"
    assert e.until_ms == iso_to_ms("2026-10-17T00:00:00Z")
    assert h.count("historical-forecast") == 1 and _cache_files() == []
    # a second request to the blocked host makes no network call until the reset
    for params in ({"q": 1}, {"q": 2}):
        with pytest.raises(W.WeatherQuotaExceeded):
            W.om_request(W.HISTORICAL_URL, params, W.HISTORICAL_TTL_S)
    assert h.count("historical-forecast") == 1
    assert W.blocked_hosts() == {"historical-forecast": iso_to_ms("2026-10-17T00:00:00Z")}
    # other hosts are not blocked (the limit is per host)
    W.om_request(W.FORECAST_URL, {"q": 1}, W.LIVE_TTL_S)
    assert h.count("forecast") == 1
    # after the reset the host is asked again
    monkeypatch.setattr(W, "now_ms", lambda: iso_to_ms("2026-10-17T00:00:30Z"))
    h.answers.pop("historical-forecast")
    W.om_request(W.HISTORICAL_URL, {"q": 1}, W.HISTORICAL_TTL_S)
    assert h.count("historical-forecast") == 2 and W.blocked_hosts() == {}


def test_blocked_host_still_answers_from_the_cache(hosts, monkeypatch) -> None:
    monkeypatch.setattr(W, "now_ms", lambda: NOW)
    h = hosts()
    W.om_request(W.FORECAST_URL, {"q": 1}, W.LIVE_TTL_S)
    W.block_host("forecast", "daily")
    assert W.om_request(W.FORECAST_URL, {"q": 1}, W.LIVE_TTL_S).from_cache
    with pytest.raises(W.WeatherQuotaExceeded):
        W.om_request(W.FORECAST_URL, {"q": 9}, W.LIVE_TTL_S)
    assert h.count("forecast") == 1


def test_hourly_and_minutely_limits_block_until_the_next_hour_or_minute(hosts, monkeypatch) -> None:
    monkeypatch.setattr(W, "now_ms", lambda: NOW)          # 12:30 UTC
    hosts({"ensemble": (429, HOURLY_BODY)})
    with pytest.raises(W.WeatherQuotaExceeded) as ei:
        W.om_request(W.ENSEMBLE_URL, {"q": 1}, W.LIVE_TTL_S)
    assert ei.value.period == "hourly" and ei.value.until_ms == iso_to_ms("2026-10-16T13:00:00Z")
    assert "hourly request limit" in str(ei.value) and "13:00 UTC" in str(ei.value)
    assert W.quota_reset_ms("minutely", NOW + 5_000) == iso_to_ms("2026-10-16T12:31:00Z")
    assert W.quota_reset_ms("daily", NOW) == iso_to_ms("2026-10-17T00:00:00Z")


def test_deterministic_hosts_follow_the_window() -> None:
    assert W.deterministic_hosts(NOW - 5 * DAY_MS, NOW + 4 * DAY_MS, NOW) == ["forecast"]
    assert W.deterministic_hosts(iso_to_ms("2025-01-01"), iso_to_ms("2025-01-20"), NOW) == ["historical-forecast"]
    assert W.deterministic_hosts(NOW - 30 * DAY_MS, NOW, NOW) == ["historical-forecast", "forecast"]


# ----------------------------------------------------------------------------------------------------------------
# probe + CLI
# ----------------------------------------------------------------------------------------------------------------
def test_probe_archive_refused_fails_overall_and_cli_exits_1(hosts, capsys) -> None:
    h = hosts({"archive": (429, DAILY_BODY)})
    r = W.probe_open_meteo()
    assert r["hosts"] == {"forecast": "ok", "historical-forecast": "ok", "archive": "daily_limit", "ensemble": "ok"}
    assert r["overall"] == "daily_limit" and r["live"] == "ok"
    assert len(h.calls) == 4 and _cache_files() == []        # one uncached request per host
    assert all(len(c[1]["latitude"].split(",")) == 1 for c in h.calls)     # tiny: one location
    W.clear_host_blocks()
    assert cli.main(["weather-probe"]) == 1
    out = capsys.readouterr().out
    lines = [ln.split()[:2] for ln in out.splitlines()[1:]]
    assert lines == [["forecast", "ok"], ["historical-forecast", "ok"], ["archive", "daily_limit"], ["ensemble", "ok"],
                     ["overall", "daily_limit"], ["live", "ok"]]


def test_probe_only_ensemble_refused_keeps_overall_ok_and_cli_exits_0(hosts, capsys) -> None:
    hosts({"ensemble": (429, DAILY_BODY)})
    r = W.probe_open_meteo()
    assert r["overall"] == "ok" and r["live"] == "daily_limit" and r["hosts"]["ensemble"] == "daily_limit"
    W.clear_host_blocks()
    assert cli.main(["weather-probe"]) == 0
    out = capsys.readouterr().out
    assert "overall              ok" in out and "live                 daily_limit" in out


def test_probe_unreachable_and_error_bodies(hosts) -> None:
    hosts({"forecast": (503, "down"), "archive": (200, "Unexpected error while streaming data: timeoutReached")})
    r = W.probe_open_meteo()
    assert r["hosts"]["forecast"] == "unreachable" and r["hosts"]["archive"] == "unreachable"
    assert r["overall"] == "unreachable" and r["live"] == "unreachable"


def test_probe_lifts_a_block_when_the_host_answers(hosts, monkeypatch) -> None:
    hosts()
    W.block_host("forecast", "daily")
    assert "forecast" in W.blocked_hosts()
    assert W.probe_open_meteo()["overall"] == "ok"
    assert W.blocked_hosts() == {}


# ----------------------------------------------------------------------------------------------------------------
# OpenMeteoSource: refused HRRR fails, no ERA5; --require-hrrr; ensemble fallback names the limit
# ----------------------------------------------------------------------------------------------------------------
class QuotaOpenMeteo(FakeOpenMeteo):
    """FakeOpenMeteo whose hosts in ``refuse`` answer the daily-limit 429."""

    def __init__(self, refuse: set[str], **kw):
        super().__init__(**kw)
        self.refuse = refuse

    def __call__(self, request: httpx.Request) -> httpx.Response:
        kind = {"api.open-meteo.com": "forecast", "historical-forecast-api.open-meteo.com": "historical",
                "archive-api.open-meteo.com": "archive", "ensemble-api.open-meteo.com": "ensemble"}[request.url.host]
        if kind in self.refuse:
            self.calls.append((kind, dict(request.url.params)))
            return httpx.Response(429, json=DAILY_BODY)
        return super().__call__(request)


def _install(monkeypatch, fake) -> None:
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(fake))
    monkeypatch.setattr(W, "now_ms", lambda: NOW)


def test_historical_refused_hrrr_fails_instead_of_era5(tmp_data_dir, monkeypatch) -> None:
    fake = QuotaOpenMeteo({"historical"})
    _install(monkeypatch, fake)
    with pytest.raises(W.WeatherQuotaExceeded, match="daily request limit reached; retry after the reset"):
        W.OpenMeteoSource().deterministic(POINTS, iso_to_ms("2025-01-05"), iso_to_ms("2025-01-12"))
    assert [c[0] for c in fake.calls] == ["historical"]       # no ERA5 hour: the archive is never asked


def test_live_refused_forecast_fails(tmp_data_dir, monkeypatch) -> None:
    fake = QuotaOpenMeteo({"forecast"})
    _install(monkeypatch, fake)
    with pytest.raises(W.WeatherQuotaExceeded):
        W.OpenMeteoSource().deterministic(POINTS, NOW - 3 * DAY_MS, NOW + 4 * DAY_MS)
    assert [c[0] for c in fake.calls] == ["forecast"]


def test_refused_era5_fill_is_a_named_warning(tmp_data_dir, monkeypatch) -> None:
    hole = (iso_to_ms("2025-01-06T00:00:00Z"), iso_to_ms("2025-01-06T05:00:00Z"))

    class NoGfs(QuotaOpenMeteo):          # HRRR and GFS both null in the hole: only ERA5 could fill it
        def __call__(self, request):
            r = super().__call__(request)
            if request.url.host.startswith("historical"):
                doc = r.json()
                for loc in doc if isinstance(doc, list) else [doc]:
                    hh = loc["hourly"]
                    for k in list(hh):
                        if k.endswith("_gfs_seamless"):
                            hh[k] = [None if hole[0] <= t * 1000 < hole[1] else v for t, v in zip(hh["time"], hh[k])]
                return httpx.Response(200, json=doc)
            return r

    fake = NoGfs({"archive"}, hrrr_hole=hole)
    _install(monkeypatch, fake)
    r = W.OpenMeteoSource().deterministic(POINTS, iso_to_ms("2025-01-05"), iso_to_ms("2025-01-08"))
    assert r["era5"] is False and any("ERA5 archive" in w and "daily request limit" in w for w in r["warnings"])
    W.clear_host_blocks()
    with pytest.raises(W.WeatherError, match="require-hrrr"):
        W.OpenMeteoSource(allow_era5=False).deterministic(POINTS, iso_to_ms("2025-01-05"), iso_to_ms("2025-01-08"))


def test_require_hrrr_never_asks_the_archive(tmp_data_dir, monkeypatch) -> None:
    fake = FakeOpenMeteo(fail=frozenset({"historical"}))          # HRRR unavailable (not refused): ERA5 would fill
    _install(monkeypatch, fake)
    assert W.OpenMeteoSource().deterministic(POINTS, iso_to_ms("2025-01-05"), iso_to_ms("2025-01-06"))["era5"] is True
    fake.calls.clear()
    with pytest.raises(W.WeatherError, match="ERA5 filling is not allowed"):
        W.OpenMeteoSource(allow_era5=False).deterministic(POINTS, iso_to_ms("2025-01-07"), iso_to_ms("2025-01-08"))
    assert "archive" not in [c[0] for c in fake.calls]


def test_refused_ensemble_falls_back_with_the_limit_named(tmp_data_dir, monkeypatch) -> None:
    fake = QuotaOpenMeteo({"ensemble"})
    _install(monkeypatch, fake)
    src = W.OpenMeteoSource()
    assert src.ensemble(POINTS, NOW - DAY_MS, NOW + DAY_MS, "gfs025") is None
    assert "daily request limit reached" in (src.last_error or "")


def test_water_year_partial_or_refused_is_not_used(tmp_data_dir, monkeypatch) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host)
        if request.url.host.startswith("archive"):
            return httpx.Response(429, json=DAILY_BODY)
        return httpx.Response(200, json={"daily": {"precipitation_sum": [1.0, 2.0]}})

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    monkeypatch.setattr(W, "now_ms", lambda: NOW)
    r = W.water_year_precip(35.0, -82.0, NOW - DAY_MS)
    assert r["precip_mm"] is None and r["refused"] is True     # never a partial total (forecast part only)
    assert any("refused" in w and "daily request limit" in w for w in r["warnings"])
    assert calls == ["archive-api.open-meteo.com", "api.open-meteo.com"]


# ----------------------------------------------------------------------------------------------------------------
# build_weather: --require-hrrr and the water-year rule
# ----------------------------------------------------------------------------------------------------------------
class Era5Source(FakeSource):
    def deterministic(self, points, start_ms, end_ms):
        out = super().deterministic(points, start_ms, end_ms)
        out["era5"] = True
        return out


class QuotaSource(FakeSource):
    def deterministic(self, points, start_ms, end_ms):
        self.calls.append(("det", int(start_ms), int(end_ms)))
        raise W.WeatherQuotaExceeded("historical-forecast")


def _refused_water_year(lat, lon, start_ms):
    return {"precip_mm": None, "from": "2024-10-01", "to": "2025-01-07", "days": 0, "source": "", "fetched_ms": 0,
            "warnings": ["water-year precipitation 2024-10-01..2025-01-07 refused (" + W.QUOTA_DAILY_MESSAGE + ")"],
            "refused": True}


def _hist_ctx(tmp_data_dir: Path, *, state: str | None, require: bool):
    ctx, _ = make_ctx(tmp_data_dir, "historical", iso_to_ms("2025-01-08T02:18:00Z"))
    upd: dict = {"state": state}
    if state not in (None, "CA"):
        upd["calfire_uid"] = ""
    ctx.summary = ctx.summary.model_copy(update=upd)
    ctx.require_hrrr = require
    return ctx


def test_build_weather_require_hrrr_fails_on_era5_hours(tmp_data_dir, monkeypatch) -> None:
    monkeypatch.setattr(WB, "water_year_precip", lambda *a: {"precip_mm": 150.0, "from": "x", "to": "y", "days": 9,
                                                              "source": "fake", "fetched_ms": 0, "warnings": []})
    ctx = _hist_ctx(tmp_data_dir, state="CA", require=True)
    with pytest.raises(W.WeatherError, match="require-hrrr"):
        WB.build_weather(ctx, source=Era5Source(ctx.fire_grid))
    assert not (ctx.bundle_dir / "weather.json").exists()
    ctx.require_hrrr = False
    WB.build_weather(ctx, source=Era5Source(ctx.fire_grid))              # without the flag ERA5 hours are allowed
    assert (ctx.bundle_dir / "weather.json").exists()


def test_build_weather_refused_hrrr_writes_nothing(tmp_data_dir) -> None:
    ctx = _hist_ctx(tmp_data_dir, state="MT", require=False)
    with pytest.raises(W.WeatherQuotaExceeded):
        WB.build_weather(ctx, source=QuotaSource(ctx.fire_grid))
    assert not (ctx.bundle_dir / "weather.json").exists() and WB.load_grid_weather(ctx.bundle_dir) is None


def test_water_year_refused_fails_california_with_flag_and_warns_otherwise(tmp_data_dir, monkeypatch) -> None:
    monkeypatch.setattr(WB, "water_year_precip", _refused_water_year)
    ctx = _hist_ctx(tmp_data_dir, state="CA", require=True)
    with pytest.raises(W.WeatherError, match="drought adjustment"):
        WB.build_weather(ctx, source=FakeSource(ctx.fire_grid))
    # without the flag: a bundle warning that names the refusal, never silent
    ctx.require_hrrr = False
    WB.build_weather(ctx, source=FakeSource(ctx.fire_grid))
    warns = bundle.load_manifest(ctx.bundle_dir)["warnings"]
    assert any("water-year precipitation unavailable" in w and "daily request limit" in w for w in warns)


def test_water_year_refused_outside_california_is_a_warning_even_with_flag(tmp_data_dir, monkeypatch) -> None:
    monkeypatch.setattr(WB, "water_year_precip", _refused_water_year)
    ctx = _hist_ctx(tmp_data_dir, state="MT", require=True)
    WB.build_weather(ctx, source=FakeSource(ctx.fire_grid))
    assert any("water-year precipitation unavailable" in w for w in bundle.load_manifest(ctx.bundle_dir)["warnings"])


def test_is_california_rule() -> None:
    assert WB.is_california({"state": "CA", "calfire_uid": ""}) is True
    assert WB.is_california({"state": "MT", "calfire_uid": "abc"}) is False
    assert WB.is_california({"state": None, "calfire_uid": "abc123"}) is True        # before the regions data
    assert WB.is_california({"calfire_uid": ""}) is False


# ----------------------------------------------------------------------------------------------------------------
# pipeline: live builds fail their job; the preflight; refused live refresh keeps the weather
# ----------------------------------------------------------------------------------------------------------------
@pytest.fixture
def fake(tmp_data_dir, monkeypatch) -> FakeBuild:
    fb = FakeBuild([make_summary(HIST_ID, "historical"), make_summary(LIVE_ID, "live", name="Live Fire", detections_24h=40)])
    return fb.install(monkeypatch)


def test_live_build_refused_fails_its_job_with_the_message(fake) -> None:
    from fire3d.api.jobs import JobManager

    fake.fail["weather"] = W.WeatherQuotaExceeded("forecast")
    jm = JobManager()
    try:
        st = jm.wait(jm.submit("build", LIVE_ID, lambda p: pipeline.build_incident(LIVE_ID, progress=p).model_dump()).id, 30)
    finally:
        jm.shutdown()
        jm.drain(30)
    assert st.status == "error" and st.error == W.QUOTA_DAILY_MESSAGE
    m = bundle.load_manifest(bundle.bundle_dir(LIVE_ID))
    assert m["status"] == "error" and m["summary"]["bundle_status"] == "error"     # never ready with partial weather
    assert any(W.QUOTA_DAILY_MESSAGE in w for w in m["warnings"])


def test_blocked_weather_host_fails_the_build_before_anything_is_touched(fake) -> None:
    m0 = pipeline.build_incident(LIVE_ID)
    static_before = fake.calls["static"]
    W.block_host("forecast", "daily")
    with pytest.raises(W.WeatherQuotaExceeded):
        pipeline.build_incident(LIVE_ID, force=True)
    assert fake.calls["static"] == static_before                 # no terrain / fuel requests
    m1 = bundle.load_manifest(bundle.bundle_dir(LIVE_ID))
    assert m1["status"] == "ready" and m1["built_ms"] == m0.built_ms   # the ready bundle is untouched
    # a historical fire older than 21 days needs historical-forecast, which is not blocked
    assert pipeline.build_incident(HIST_ID).status == "ready"
    W.block_host("historical-forecast", "daily")
    with pytest.raises(W.WeatherQuotaExceeded):
        pipeline.build_incident(HIST_ID, force=True)
    assert pipeline.short_error(W.WeatherQuotaExceeded("forecast")) == W.QUOTA_DAILY_MESSAGE


def test_refused_live_refresh_keeps_last_weather_with_warning(fake) -> None:
    pipeline.build_incident(LIVE_ID)
    bdir = bundle.bundle_dir(LIVE_ID)
    before = (bdir / "weather.json").read_bytes()
    fake.fail["weather"] = W.WeatherQuotaExceeded("forecast")
    assert pipeline.refresh_live(LIVE_ID, force=True) is True
    m = bundle.load_manifest(bdir)
    assert m["status"] == "ready"
    assert "Weather not refreshed: Open-Meteo daily request limit reached." in m["warnings"]
    assert (bdir / "weather.json").read_bytes() == before
    del fake.fail["weather"]
    assert pipeline.refresh_live(LIVE_ID, force=True) is True
    assert not any(w.startswith("Weather not refreshed") for w in bundle.load_manifest(bdir)["warnings"])


def test_build_incident_passes_require_hrrr(fake, monkeypatch) -> None:
    from fire3d.build import weather_bundle

    seen: list[bool] = []
    orig = weather_bundle.build_weather            # FakeBuild's stand-in

    def bw(ctx):
        seen.append(ctx.require_hrrr)
        return orig(ctx)

    monkeypatch.setattr(weather_bundle, "build_weather", bw)
    pipeline.build_incident(HIST_ID, require_hrrr=True)
    pipeline.build_incident(HIST_ID, force=True)
    assert seen == [True, False]


def test_cli_build_flag_and_weather_hours(fake, monkeypatch, capsys) -> None:
    got: dict = {}
    real = pipeline.build_incident

    def fake_build(incident_id, progress=None, force=False, *, require_hrrr=False):
        got.update(id=incident_id, force=force, require_hrrr=require_hrrr)
        return real(incident_id, progress=progress, force=force)

    monkeypatch.setattr(pipeline, "build_incident", fake_build)
    assert cli.main(["build", HIST_ID, "--force", "--require-hrrr"]) == 0
    assert got == {"id": HIST_ID, "force": True, "require_hrrr": True}
    assert "(require HRRR)" in capsys.readouterr().out
    wh = cli.weather_hours(bundle.bundle_dir(HIST_ID))
    assert wh is not None and wh["hours"] == wh["hrrr_hours"] + wh["gfs_fill_hours"]


def test_format_probe_lines() -> None:
    lines = cli.format_probe({"overall": "ok", "live": "daily_limit", "hosts": {"forecast": "ok", "ensemble": "daily_limit"},
                              "detail": {"forecast": "HTTP 200", "ensemble": "HTTP 429 daily limit"}})
    assert [ln.split()[:2] for ln in lines] == [["forecast", "ok"], ["ensemble", "daily_limit"], ["overall", "ok"],
                                                ["live", "daily_limit"]]
    assert "(HTTP 429 daily limit)" in lines[1]
