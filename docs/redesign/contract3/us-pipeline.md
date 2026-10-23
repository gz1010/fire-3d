# us-pipeline as built (CONTRACT §14, brief 3 wave 1)

Role `us-pipeline`: prepare fires anywhere in the lower 48, Open-Meteo quota handling, national NWS alerts and the
local officials' messages. This note replaces "append to §14" (CONTRACT §14.0); the integration folds it into §14 as
"as built" sub-headings. Kept current at each milestone.

## Status

| Milestone | Commit | State |
|---|---|---|
| M1 weather quota (§14.12.2) | `brief 3 us-pipeline: M1 weather quota` | done |
| M3 NWS and local alerts (§14.6, §14.7) | `brief 3 us-pipeline: M3 national NWS and local alerts` | done |
| Cut-line (a) OpenFEMA prefetch | `brief 3 us-pipeline: M3 OpenFEMA archive channel` | done (done early, while waiting for `us-catalog` M3) |
| M2 build anywhere (§14.2 gate, §14.12.3/5/6/8/10, §14.9.7) | `brief 3 us-pipeline: M2 build anywhere` | done |
| Cut-line (b) weighted Open-Meteo counter, soft cap, hourly live refetch | `brief 3 us-pipeline: M4 cut-line b and d` | done |
| Cut-line (d) `SkillEntry.growth_sorensen` writer | `brief 3 us-pipeline: M4 cut-line b and d` | done |
| Cut-line (c) 3rd smoke build | fallback used: recorded LANDFIRE window test | no active Southern/Eastern fire of 1,000 ac or more on 2026-10-23 (0 of 22 non-CA fires >= 1,000 ac); test `test_recorded_black_cove_window_switches_lf2025_to_lf2024` on `tests/data/pipeline_us/landfire_black_cove_*_fbfm40.tif` |
| M4 smoke builds (§14.12.11) | - | in progress |

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
    the disk cache or raises `WeatherQuotaExceeded` with **no network call**; a daily or hourly limit answer blocks
    the host and raises. A **per-minute** limit answer is waited out once (until the next minute + 1 s, at most
    65 s) and asked again; a second refusal raises (deviation, below).
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
- Cut-line (b), built: `weather.request_cost(params)` = locations × max(1, series / 10) × max(1, days / 14) (series =
  variables × models; days from start/end dates, else forecast + past days); every real Open-Meteo request
  (`om_request`, also refused ones, never cache hits; each probe request counts 1) adds its cost to
  `open_meteo_usage() -> {"date", "weighted_calls"}`, persisted in `data/cache/open_meteo_usage.json` (a new UTC day
  starts at 0); `over_soft_cap()` compares with `config.OPEN_METEO_DAILY_SOFT_CAP = 6000.0`. `config.
  LIVE_WEATHER_REFETCH_S = 3600`. `pipeline.live_weather_skip(bdir, now)`: a live refresh keeps the bundle's weather
  when over the cap (warning "Weather not refreshed: daily request budget reached.") or when the stored weather is
  under an hour old (no warning); `weather_bundle.deterministic_grid(prefer_fresh=True)` (live forecasts) uses the
  stored weather in the same two cases (the cap case adds the same warning to the forecast).

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
- Channel `openfema_archive`: bbox form → `not_checked` "The FEMA archive is checked for a chosen fire only.";
  `at_ms` within 24 h → `not_checked` "FEMA publishes its archive about a day later; messages of the last 24 hours
  come from the National Weather Service."; older (incident form) → `openfema.ensure(incident_window(...))`:
  `available` from the disk cache; on a miss one background fetch per window (deduplicated) and a wait of at most
  `openfema.REQUEST_WAIT_S` = 3 s (the catalog lookup of an incident without a bundle can add about 2 s), then `pending` ("FEMA's archive is being fetched; ask again in a minute.");
  `unavailable` ("… that does not mean there were none.") when the window's last fetch failed less than 10 min ago.
  `official.ARCHIVE_ENABLED = True` (False gives the fallback `not_checked` "The FEMA archive is not checked in
  this version."). When the archive channel is consulted the caveats add "Archived copy from FEMA (OpenFEMA, published
  about a day later); FEMA does not validate message content. Replays can list more than was visible live." and
  "FEMA IPAWS archive via OpenFEMA: This product uses the Federal Emergency Management Agency's OpenFEMA API, but is
  not endorsed by FEMA."
- Archive windows (`openfema.incident_window(started, end, at, now)`): one window per incident covering
  `[day(start − 1 d), day(end + 1 d)]` (end = now for a live fire, start + 14 d for a past fire without an end; at
  most 22 days, about 1,000 national messages; never past today 00:00 UTC), so
  every replay time of a fire is served by one fetch; outside the record, the UTC days around `[at − 24 h, at + 1 h]`.
  Stored parsed (no `_geom`, no `sender`) in `DATA_DIR/official/openfema/window_<lo>_<hi>.json`; fresh for 1 h when
  the window ends within 3 days of now, else 30 days. The answer lists the stored messages sent in
  `[at − 24 h, at + 1 h]` (`openfema.answer`), matched like the NWS ones (`place_local`).
- After a successful build `pipeline.archive_prefetch(summary, manifest)` fetches the incident's window
  synchronously (best effort, logged; never fails the build; skipped when the fire began less than 24 h ago).
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
  `$select=identifier,sent,msgType,status,info`, then a second query `msgType ne 'Alert'` with
  `$select=identifier,originalMessage` for the updates' references; pages of 1000, at most 10 pages; TTL 1 h for windows
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

## §14.2 Build gate (as built, M2)

- `pipeline.is_catalog_incident(incident_id, summary)` (signature unchanged): `summary.id == incident_id`, and
  `catalog.resolve_listed(incident_id)` answers a summary with this same id (a CAL FIRE or NIFC WFIGS list; never a
  manifest alone) whose state `catalog.is_supported` accepts. A lookup failure means "not buildable now" (logged).
- `pipeline.BuildRefused(LookupError)` with `.status`; `gate_refusal(id, summary)` gives the same texts as
  `api/app.py`: 404 "unknown incident '<id>'"; 422 "Fire-3d does not support Alaska, Hawaii or US territories yet."
  (`pipeline.UNSUPPORTED_TEXT`); 409 "'<id>' is a local or synthetic bundle; it cannot be rebuilt."; 409 "'<alias>' is
  listed as '<id>'."; 409 "'<id>' cannot be built in this version yet.". No "CAL FIRE catalog" wording remains.
  `build_incident` raises it before taking the bundle lock; `short_error` prints it without the class name.
- `landfire_gate(summary, force)`: a historical fire before Oct 2023 (federal FY2023 or earlier) → `BuildRefused`
  422 "LANDFIRE has no pre-fire fuels edition here for a fire that began in federal fiscal year <FY> (before October
  2023); rebuild with force to use LF2023, which may already show the fire's own burn scar." unless `force`; with
  `force` the build uses LF2023 and adds a "LANDFIRE:" warning.
- CLI `build`: ids or names (a name not in this year's lists is also looked up in the two previous years' lists);
  a refusal prints "refused (HTTP <status> in the API): <text>" on stderr and exits 1.
- `refresh_live` without `detections` loads `firms.load_live_us(days=2)` (the national feed; `pipeline.py` only).
- `spec_incident_id` is kept, marked deprecated (nothing in the gate uses it).
- Test support: `tests/test_pipeline_support.py` `FakeBuild` also fakes `catalog.resolve_listed` (`bundle_only` ids
  and ids not of the catalog's form answer None), so `test_api.py` needs no change for the new gate.

## §14.9.7 Backend fire-local time (as built, M2)

- `timeutil`: `zone(tz)` (ZoneInfo; UTC for None / unknown, never Pacific), `local_dt`, `fmt_local(ms, tz, *,
  year=False)` → "Jan 07, 18:18 MST" / "Jan 07, 2025, 18:18 MST", `fmt_local_short(ms, tz)` → "Oct 17 14:24 PDT"
  (satellite passes), `local_month(ms, tz)`, `zone_of(summary_or_manifest)` (`time_zone`, else
  `regions.time_zone_at(lon, lat)`, else the state's main zone, else "UTC").
- `BuildContext.time_zone` = `summary.time_zone` (pipeline build and refresh). `observed.py` labels (ignition detail,
  GOES / polar start reasons), `live_observation.py` (notes, veto, `describe_start(doc, start_ms, tz)`),
  `overpass.Pass.describe(tz)` / `overpass.pass_time(ms, tz)` (`la_time` kept as a deprecated alias),
  `ensemble.py` (start note; moisture month), `behavior.py` (moisture month) and `weather_bundle.py` (moisture month)
  use the fire's zone. No `ZoneInfo("America/Los_Angeles")` remains in `build/`, `spread/` or `sources/overpass.py`.
  California bundles get America/Los_Angeles from their location, so their strings are unchanged.

## §14.12.3 LANDFIRE (as built, M2)

- `landfire.EDITIONS = ("LF2023", "LF2024", "LF2025")` (LF2023 is on the same lfps.usgs.gov service; its 7 CONUS
  layers were listed on 2026-10-23). `federal_fy(ms)` (UTC), `prefire_edition(started_ms)`, `edition_for(mode,
  started_ms=None)` (live LF2025; historical LF{FY − 1}, at least LF2023; without a start, brief 2's LF2024),
  `has_prefire_edition`, `older_edition`, `nodata_land_fraction`, `switch_warning`, `NODATA_SWITCH_FRAC = 0.02`,
  `NOT_RELEASED_LF2025 = "LANDFIRE 2025 is not released here yet; LANDFIRE 2024 used"`, `OUTSIDE_COVERAGE =
  "outside fuel data coverage: not modeled (unknown, not low)"`.
- `aoi.fetch_fuels`: a failed edition falls back to the next **older** edition only (LF2025 → LF2024 → LF2023;
  never forward); the vegetation layers are refetched for the edition used. An edition with no fuel code at all in
  the AOI raises `landfire.LandfireNoData` (a `RasterFetchError`) and its switch uses the same warning as below
  ("LANDFIRE 2025 is not released here yet; LANDFIRE 2024 used"): at Black Cove, NC, LF2025 has no data in any
  cell (checked 2026-10-23), so a live build there takes this path.
- `aoi.land_masks(fire, elev)`: `land` = cell centres inside the lower-48 + DC state polygons (`regions.in_lower48`,
  every 4th cell, upsampled) with fire-grid elevation above 0.5 m (3DEP answers ~0 m over the sea, which the
  polygons partly include); `abroad` = ground above 0.5 m outside them. `aoi.choose_fuels` switches the whole
  bundle to the next older edition while more than 2 % of the land cells have no fuel code, with the warning
  "LANDFIRE: LANDFIRE 2025 is not released here yet; LANDFIRE 2024 used" (other editions: "LANDFIRE: LANDFIRE <E>
  has no fuel data for <p>% of the land here; LANDFIRE <older> used").
- Cells outside the US without fuel data keep fuel 99 and are counted: "LANDFIRE: <n> fire-grid cells (<p>) outside
  the United States are outside fuel data coverage: not modeled (unknown, not low)". Stats gain
  `nodata_land_frac` and `outside_coverage_cells`.
- Measured on the local California bundles: Palisades has 8.7 % NoData cells (the sea), 0.22 % inside the state
  polygon and 0 % on land above 0.5 m, so a live Palisades-like coast stays on LF2025; Eaton has none.

## §14.12.5 / §14.12.6 Issuer text and data source names (as built, M2)

- `types.record_issuer_of(summary)` (model or dict): `record_issuer`, else "NIFC WFIGS (IRWIN)" for a WFIGS record,
  else "CAL FIRE" (the 14.1 validator's reading of old manifests).
- Bundle text from it: "Reported by {issuer} {fmt_local}", "{issuer} start", "{issuer} incident point", "{issuer}
  point is N km from the earliest detections…", "{issuer} (100% contained)", "… ac reported by {issuer}", the event
  source "{issuer}[ + FIRMS GOES]", the live veto "{issuer} reported N ac at …" and the forecast note "{issuer}
  reports N% containment". California strings are unchanged.
- The fire's own record source: CAL FIRE rows keep brief 2's "CAL FIRE incidents"; WFIGS rows "NIFC WFIGS incident
  record (IRWIN)" with the IRWIN id and issuer in `detail` (`pipeline.incident_record_source`). Perimeters keep
  "NIFC WFIGS fire perimeters"; LANDFIRE keeps "LANDFIRE <edition>".

## §14.12.8 Perimeters (as built, M2)

- `perimeters.fetch_perimeters(..., record_source="calfire", state=None, irwin_id=None)`: California records
  (default) take brief 2's path exactly (`state` / `irwin_id` ignored; same queries, proven by replaying recorded
  Eaton, Palisades, Madre and TCU answers: identical OBJECTID sets and identical query keys). WFIGS records: by IRWIN
  id (`irwin_where`: `UPPER(attr_IrwinID) IN ('{ID}', 'ID') OR UPPER(poly_IRWINID) IN (...)`; the identity filter then
  skips the name and state tests), else by name in `US-<state>`; no CAL FIRE hint; the distance and size checks stay.
  A WFIGS record without IRWIN id and state is not matched (warning). `observed.perimeter_identity(summary)` passes
  the WFIGS identity. Helpers `norm_irwin`, `irwin_where`, `wfigs_state`; `build_where(..., state=)`.

## §14.12.10 Interim live fuel moisture (as built, M2)

- `weather_bundle.is_california(summary)`; outside California `build_weather` adds the unprefixed manifest warning
  "Live fuel moisture outside California uses California's seasonal values until a regional method is tested;
  experimental." (`INTERIM_LFM_WARNING`, replaced on every rebuild) and `live_moisture_for` starts its note with
  "Live fuel moisture: California's seasonal values (regional method not tested yet); experimental."
  (`INTERIM_LFM_NOTE`), which every forecast appends to its warnings. California notes are unchanged.
- Tests: `tests/test_us_pipeline_build.py` (24), `tests/test_us_pipeline_perimeters.py` (8); recorded data in
  `tests/data/pipeline_us/` (PROVENANCE.md).

## §14.12.7 Skill (as built, cut-line item d)

- `spread/validate.skill_entry(row)` maps a `skill_from_arrays(..., growth=True)` row to the `SkillEntry` shape with
  `growth_sorensen` (= the row's `sorensen_growth`, new growth only). `spread/ensemble.run_forecast` writes it on every
  skill entry (any run with observed data inside the horizon: historical runs and hindcasts); `validate.hindcast_skill`
  returns the same shape. Test: `test_us_pipeline_build.py::test_forecast_skill_carries_growth_sorensen`.

## Files

`backend/fire3d/http.py`, `backend/fire3d/sources/weather.py`, `backend/fire3d/build/weather_bundle.py`,
`backend/fire3d/build/pipeline.py`, `backend/fire3d/cli.py`, `backend/fire3d/types.py`,
`backend/fire3d/sources/nws.py`, `backend/fire3d/sources/openfema.py` (new), `backend/fire3d/api/official.py`,
`backend/scripts/record_test_samples_official.py`, `backend/tests/data/official/*` (3 new samples + PROVENANCE),
`backend/tests/test_us_pipeline_quota.py`, `backend/tests/test_local_alerts_nws.py`, `backend/tests/test_openfema_parse.py`,
`backend/tests/test_official_nws.py`, `backend/fire3d/build/aoi.py`, `backend/fire3d/build/observed.py`,
`backend/fire3d/build/live_observation.py`, `backend/fire3d/sources/landfire.py`, `backend/fire3d/sources/perimeters.py`,
`backend/fire3d/sources/overpass.py`, `backend/fire3d/spread/ensemble.py`, `backend/fire3d/spread/behavior.py`,
`backend/fire3d/timeutil.py`, `backend/tests/test_us_pipeline_build.py`, `backend/tests/test_us_pipeline_perimeters.py`,
`backend/tests/data/pipeline_us/*`, `backend/tests/test_pipeline_support.py`, `backend/tests/test_official_calfire.py`.

## Deviations

- `probe_open_meteo()` returns an extra `detail` key (the contract's three keys are unchanged). Any request-limit
  period (daily, hourly, per-minute) is reported as status `daily_limit`; `detail` names the period.
- A per-minute Open-Meteo refusal is waited out once inside `om_request` (the contract says "no retries"): on
  2026-10-23 other tenants of the shared IP pushed the archive host over its 600-a-minute limit, and a whole build
  failing on a one-minute limit would waste every other request it made. Daily and hourly refusals are never retried.
- `observed.SOURCE_PREFIXES` is now `("NASA FIRMS", "NIFC WFIGS fire perimeters", "NASA CMR")` so the observed step no
  longer removes the pipeline's "NIFC WFIGS incident record (IRWIN)" entry (found in the first Horse Gulch build).
- OpenFEMA: server-side filter by date window and status only (see §14.7 above).
- Local alerts matched by county: `covers_reported_location` and `nearest_km` are null (not computed from the
  county), so a county-wide message is never presented as covering the fire's point.
