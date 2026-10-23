# us-pipeline as built (CONTRACT §14, brief 3 wave 1)

Role `us-pipeline`: prepare fires anywhere in the lower 48, Open-Meteo quota handling, national NWS alerts and the
local officials' messages. This note replaces "append to §14" (CONTRACT §14.0); the integration folds it into §14 as
"as built" sub-headings. Kept current at each milestone.

## Status

| Milestone | Commit | State |
|---|---|---|
| M1 weather quota (§14.12.2) | `brief 3 us-pipeline: M1 weather quota` | done |
| M3 NWS and local alerts (§14.6, §14.7) | `brief 3 us-pipeline: M3 national NWS and local alerts` | done (archive channel `not_checked` until the prefetch lands) |
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

## §14.6 NWS fire weather nationally (as built, M3)

- `sources/nws.py`:
  - `national_active() -> NationalAnswer(fire, local, fetched_ms, updated_ms, states, dropped_no_link)`: one request
    `/alerts/active?area=<49 codes>&event=Red Flag Warning,Fire Weather Watch,Fire Warning,Evacuation Immediate,
    Shelter In Place Warning,Civil Danger Warning,Civil Emergency Message,Local Area Emergency` (`national_url()`),
    cached 2 min by `fire3d.http`, `NWS_LIMITER` unchanged (30/min). Split in code: `fire` (normalize_alert, RFW/FWW)
    and `local` (`normalize_local_nws`, in scope only). `active_alerts()` keeps its signature and returns the
    national fire alerts.
  - The 49 codes come from `regions.L48`, with `nws.L48_CODES` as the fallback when `fire3d.regions` cannot be
    imported. `states_in_area(bbox)` = `regions.states_in_bbox` ∩ the 49 (all 49 without the regions module).
  - `in_states(alerts, states)`: the UGC two-letter prefix filter, applied by `api/official.py` **before**
    `place_live` (so no zone outline of another state is ever loaded). `alert_states(alerts)` from UGC / SAME codes.
  - Every placed alert (live and IEM archive) gets `time_zone`: `regions.time_zone_at` at a representative point of its
    first zone outline, else `regions.main_zone` of its first UGC state, else null.
- `api/official.py` fire weather: overview `states_checked` = the request's 49 codes, `alert_states` from the alerts;
  per fire `states_checked` = `states_in_area(area)` ∩ the request's states (IEM archive answers: `states_in_area`);
  both `[]` when NWS could not be reached. Quiet line "… is in effect in the lower 48 states right now. That is not an
  all-clear: follow local officials." (`SCOPE_WORDS`). The per-fire caveat keeps `STANDING_NWS`.
- `fill_from_catalog(ref)` replaces `fill_from_calfire` (kept as a deprecated alias): fills location, mode, times,
  `record_source`, `state`, `time_zone` from `catalog.get_summary` for any listed id (no 404 for a listed fire without
  a bundle; 404 only when the catalog answers None and there is no bundle). `IncidentRef` gains `record_source`,
  `state`, `time_zone` (old manifests: `record_source` "calfire" when a CAL FIRE uid is present).

## §14.5 `/api/official/calfire` (as built, M3)

- A fire whose `record_source` is `wfigs` (bundle summary, else `catalog.get_summary`) answers `unavailable` +
  `not_covered`, reason "CAL FIRE does not list this fire; its official record is published by NIFC WFIGS." with no
  CAL FIRE request. Synthetic / local ids keep their brief-2 answer first. California answers are unchanged.

## §14.7 Local officials' messages (as built, M3)

- `GET /api/official/local-alerts?incident=<id>&at_ms=&margin_km=15` or `?bbox=w,s,e,n` (`local_alerts_payload`):
  both or neither → 400; a bad bbox (not 4 numbers, w >= e, s >= n, out of range, or more than 10° a side) → 400;
  invalid id → 400; unknown id → 404; NWS rate limit → 429. `Cache-Control: no-store`.
- Area: the fire's analysis area (else the reported location ± 10 km) + `margin_km`, or the bbox. `counties` =
  `regions.counties_in_bbox(area)` (`[]` without the regions module; polygon matching still works).
- Channel `nws_api`: `at_ms` absent or within 2 h → the shared national answer (`local_in_states`, then
  `place_local`); 2 h to 7 days back (incident form) → `nws.past_local(states, at_ms)`: one cached request
  `/alerts?start=<at−24 h, hour>&end=<min(at+1 h, now), hour>&event=<the 6 local events>&area=<states>&limit=500`
  (TTL 10 min); older → `not_checked` "NWS keeps about 7 days of alerts."; the bbox form older than 2 h →
  `not_checked` "Past local alerts are checked for a chosen fire only."; NWS down → `unavailable` with "… that does
  not mean there were none."
- Channel `openfema_archive` (M3): bbox form → `not_checked` "The FEMA archive is checked for a chosen fire only.";
  `at_ms` within 24 h → `not_checked` "FEMA publishes its archive about a day later; messages of the last 24 hours
  come from the National Weather Service."; older → `not_checked` "The FEMA archive is not checked in this version."
  (until the background prefetch, cut-line item (a), lands; see below).
- Scope (`nws.local_in_scope`): FRW, EVI, SPW, CDW always; CEM and LAE only when the event, headline, description,
  instruction or WEA text matches `fire(s) | wildfire(s) | brush fire | grass fire | smoke | evacuat*`, after removing
  names that are not about a fire ("Fire Station", "Fire Department", "fire hydrant", "fireworks", "smoke
  detector" …; the text itself is never changed). Only `status: Actual`.
- Matching (`nws.place_local`): by polygon when the message has one (`match: "polygon"`, `covers_reported_location`
  and `nearest_km` at the reported location); else by SAME county codes against the area's counties (`match:
  "county"`, `covers_reported_location` and `nearest_km` null: a county match says nothing about the point).
  `time_zone`: polygon → `time_zone_at` of a representative point; county → the point's zone when the point's county
  is named, else the county's state's main zone. `phase` relative to `at_ms` (or now): Cancel → ended; before
  onset/effective/sent → upcoming; at or after `expires` → ended; else in effect.
- `polygon` is GeoJSON `Polygon`, or `MultiPolygon` when an archived message has several areas (us-official should
  draw both).
- `merge_local(nws, archive)`: one alert per CAP `id`, the `nws_api` copy wins; alerts without an https `source_url`
  are dropped and counted in the caveat "{n} alert(s) without a source link were not shown."
- `sender_name` verbatim; `sender_is_platform` when it is one of `nws.PLATFORM_SENDERS` ("Public Alert System",
  "IPAWS", …). The operator's `sender` address is never read; tests assert no `sender` key anywhere in the answer.
- `source`: "National Weather Service (relayed local officials' messages)"; `caveats[0]` is always the 14.7 sentence
  "Fire-3d lists only the local alerts the National Weather Service relays; … follow local officials.".
- Envelope status: `available` when a channel answered; `unavailable` + `upstream_error` when every channel that was
  tried failed; `not_available_for_past_dates` + `past_date` when no channel was checked (reason: "Local officials'
  alerts are not checked for this time: " + the channels' reasons).
- `sources/openfema.py`: `API_URL`, `record_url(identifier)` (`…/IpawsArchivedAlerts?$filter=identifier%20eq%20%27<id>%27`),
  `window_params`, `fetch_window(start, end)` (one date window `status eq 'Actual' and sent ge … and sent lt …`,
  `$select=identifier,sent,msgType,status,info,originalMessage`, pages of 1000, at most 10 pages; TTL 1 h for windows
  ending within 3 days, else 30 days; `OPENFEMA_LIMITER` 20/min), `references_of(originalMessage)` (regex on
  `<references>`, identifiers only), `parse_record` / `parse_records`, `archive_window(at_ms)` (`[at−24 h, at+1 h]`
  in whole hours), `archived_alerts(at_ms)`; `CREDIT`, `NOTICE`, `TERMS_URL`, `SOURCE`.
- **Deviation:** the archive query filters on the server by date window and status only; event codes and SAME
  counties are matched in `parse_record` / `place_local`. OpenFEMA's nested `any()` filters on `info` fail or are
  slow (syntax errors in the test, and the audit's 503 after 60 s), while a day of national messages is 40-200 rows.
- Samples: `backend/tests/data/official/nws_alerts_national.json`, `nws_nwem_cem_la.json`, `openfema_window_frw.json`
  (provenance in `PROVENANCE.md`; operator addresses redacted). Recorder: `scripts/record_test_samples_official.py
  --only national`.
- Tests: `backend/tests/test_local_alerts_nws.py` (16), `backend/tests/test_openfema_parse.py` (8); updated
  `test_official_nws.py` (the national URL).

## Files

`backend/fire3d/http.py`, `backend/fire3d/sources/weather.py`, `backend/fire3d/build/weather_bundle.py`,
`backend/fire3d/build/pipeline.py`, `backend/fire3d/cli.py`, `backend/fire3d/types.py`,
`backend/fire3d/sources/nws.py`, `backend/fire3d/sources/openfema.py` (new), `backend/fire3d/api/official.py`,
`backend/scripts/record_test_samples_official.py`, `backend/tests/data/official/*` (3 new samples + PROVENANCE),
`backend/tests/test_us_pipeline_quota.py`, `backend/tests/test_local_alerts_nws.py`, `backend/tests/test_openfema_parse.py`,
`backend/tests/test_official_nws.py`.

## Deviations

- `probe_open_meteo()` returns an extra `detail` key (the contract's three keys are unchanged).
- OpenFEMA: server-side filter by date window and status only (see §14.7 above).
- Local alerts matched by county: `covers_reported_location` and `nearest_km` are null (not computed from the
  county), so a county-wide message is never presented as covering the fire's point.
