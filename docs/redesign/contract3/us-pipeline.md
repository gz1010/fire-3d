# us-pipeline as built (CONTRACT §14, brief 3 wave 1)

Role `us-pipeline`: prepare fires anywhere in the lower 48, Open-Meteo quota handling, national NWS alerts and the
local officials' messages. This note replaces "append to §14" (CONTRACT §14.0); the integration folds it into §14 as
"as built" sub-headings. Kept current at each milestone.

## Status

| Milestone | Commit | State |
|---|---|---|
| M1 weather quota (§14.12.2) | `brief 3 us-pipeline: M1 weather quota` | done |
| M3 NWS and local alerts (§14.6, §14.7) | - | next (before M2 until `us-catalog` M3 lands) |
| M2 build anywhere (§14.2 gate, §14.12.3/5/6/8/10, §14.9.7) | - | waiting for `brief 3 us-catalog: M3` |
| M4 smoke builds (§14.12.11) | - | after M2 |

## §14.12.2 Weather quota (as built, M1)

- `fire3d.http`:
  - A 429 whose body matches `(daily|hourly|minutely) API request limit exceeded` raises `HttpError(429, …)` at once
    (no retries); any other 429 / 5xx keeps the old backoff. `http.quota_period(text)` returns the period.
  - `http.is_error_body(content, content_type)`: a 2xx body is an error in disguise when it holds "Unexpected error
    while streaming data" (last 1 KB, or anywhere in a body <= 4 KB), is JSON that does not parse or is cut off, or
    is a JSON object whose `error` is `true` or an object (Open-Meteo, ArcGIS). Such a body is returned to the
    caller as before but **never cached**; a cached entry that is one is **evicted** on read and fetched again.
    JSON bodies above 4 MB are only checked for a cut-off end (parsing them twice would be slow).
- `fire3d.sources.weather`:
  - `class WeatherQuotaExceeded(WeatherError)` with `host` (label), `period` ("daily" | "hourly" | "minutely"),
    `until_ms`, `detail`. `str(e)` for the daily limit is exactly "Open-Meteo daily request limit reached; retry
    after the reset (00:00 UTC)" (`QUOTA_DAILY_MESSAGE`); hourly "Open-Meteo hourly request limit reached; retry
    after the reset (HH:00 UTC)"; per-minute "Open-Meteo per-minute request limit reached; retry in a minute".
  - Host labels `HOSTS = {"forecast", "historical-forecast", "archive", "ensemble"}`. Per-process, in-memory block:
    `block_host(label, period)` until the next 00:00 UTC (daily), next whole hour (hourly) or next minute;
    `host_block`, `blocked_hosts`, `clear_host_blocks`, `raise_if_blocked(labels)`, `deterministic_hosts(start,
    end)`. `om_request(url, params, ttl_s)` is the only way the module calls Open-Meteo: a blocked host answers from
    the disk cache or raises `WeatherQuotaExceeded` with **no network call**; a limit answer blocks the host and
    raises.
  - `OpenMeteoSource.deterministic`: a refused historical-forecast / forecast request **raises**
    `WeatherQuotaExceeded` (no ERA5 fill). `OpenMeteoSource(allow_era5=False)` (used for `require_hrrr`) never asks
    the archive and raises `WeatherError` "HRRR and GFS are missing for N past hour(s); ERA5 filling is not allowed
    (--require-hrrr)". A refused ERA5 archive request when only filling holes is a warning naming the limit.
  - `ensemble()`: a refused request returns None with `last_error` naming the limit, so `member_weathers` keeps the
    perturbed fallback with the warning "gfs025 ensemble unavailable (Open-Meteo daily request limit reached; …)".
  - `water_year_precip`: any failed part makes `precip_mm` None (a partial total would understate the rain); new
    key `refused` (True when the limit refused a part); warnings name the reason. Success paths are unchanged, so
    California bundles build identically.
  - `probe_open_meteo(timeout=20)` → `{"overall", "live", "hosts": {forecast, historical-forecast, archive,
    ensemble}, "detail": {host: text}}`; statuses `ok` / `daily_limit` (any request-limit answer, the period is in
    `detail`) / `unreachable` (timeouts, 5xx, other errors, error bodies). One uncached (`ttl_s=0`, `retries=0`) tiny
    request per host (one location, `temperature_2m`, one day). `detail` is an addition to the contract's shape.
    A limit answer blocks the host; an ok answer lifts this process's block.
- `fire3d.cli`:
  - `weather-probe`: a header line, one line per host (`<host> <status>  (<detail>)`), then `overall` and `live`;
    exit 0 only when `overall` is `ok`.
  - `build <id> [--force] [--require-hrrr]`; after a build it prints `weather: <source>; N h: HRRR a h, not HRRR b h
    (GFS fill, 0 ERA5 h | ERA5 used)` from `sim/weather.npz` (`cli.weather_hours(bundle_dir)`).
- `fire3d.build.pipeline`:
  - `build_incident(incident_id, progress=None, force=False, *, require_hrrr=False)` (new keyword only).
  - `weather_preflight(summary)`: before the bundle is cleared, a build whose weather host is blocked in this process
    raises `WeatherQuotaExceeded` (no network call, the ready bundle untouched); this is what makes the live loop's
    remaining auto-build candidates fail at once.
  - A build whose weather is refused is marked `error` (never ready with partial weather) and its job's `error` is
    the quota sentence itself (`short_error` prints `WeatherQuotaExceeded` without the class name).
  - `refresh_live`: a refused weather refresh keeps `weather.json` / `sim/weather.npz` (nothing was written), the
    observed refresh still lands, and the manifest gets "Weather not refreshed: Open-Meteo daily request limit
    reached." (hourly / per-minute variants name their limit); the next successful refresh removes it.
- `fire3d.build.weather_bundle.build_weather`: with `ctx.require_hrrr` an ERA5-filled answer fails ("ERA5 reanalysis
  filled hours …; --require-hrrr refuses them"); a missing water-year total fails for a California fire
  (`is_california(summary)`: `state == "CA"`, or a CAL FIRE uid when `state` is unset) with "…; --require-hrrr needs
  it for California's drought adjustment"; otherwise it is the bundle warning "water-year precipitation unavailable:
  live fuel moisture uses the month table (<reason>)".
- `fire3d.types.BuildContext` gains `time_zone: str | None = None` and `require_hrrr: bool = False`.
- Tests: `backend/tests/test_us_pipeline_quota.py` (34 tests).
- Below the cut line, not built in M1: the weighted counter `open_meteo_usage()`, `OPEN_METEO_DAILY_SOFT_CAP` and the
  hourly live refetch.

## Files

`backend/fire3d/http.py`, `backend/fire3d/sources/weather.py`, `backend/fire3d/build/weather_bundle.py`,
`backend/fire3d/build/pipeline.py`, `backend/fire3d/cli.py`, `backend/fire3d/types.py`,
`backend/tests/test_us_pipeline_quota.py`.

## Deviations

- `probe_open_meteo()` returns an extra `detail` key (the contract's three keys are unchanged).
