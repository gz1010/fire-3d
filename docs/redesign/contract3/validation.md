# validation as built (CONTRACT §14.4, §14.12.10; brief 3 wave 2)

Role `validation`: the California baseline, GSI live fuel moisture outside California (pre-registered), the 12 test
fires, the regional accuracy file and docs/validation.md section 10. This note is folded into §14 by the integration
("14.x as built"). Kept current at each milestone.

## Status

| Milestone | Commit | State |
|---|---|---|
| M1 pre-registration (docs/validation.md 10.1, `scripts/validate_us_fires.py` FIRES) | `brief 3 validation: M1 pre-registration` (29f0e2d) | done, before any score outside California |
| M2 GSI + regional tooling + absolute starts | `brief 3 validation: M2 GSI live fuel moisture ...` | done |
| M3 builds and bundle checks | | in progress (weather quota) |
| M4 California baseline (pre-GSI worktree) and post-GSI re-run | | in progress |
| M5 hindcasts, `regional_accuracy.json`, docs/validation.md 10.2+ | | pending |

## §14.12.10 GSI (as built)

- **Switch** (`build/weather_bundle.py`): `is_california(summary)` (`state == "CA"`, else a CAL FIRE uid when the state
  is unset) keeps today's rule exactly; everything else uses `gsi_nfdrs2016`.
- **Method** (`spread/moisture.py`, parameters `config.GSI_*`): `saturation_vp_pa`, `gsi_vpd_pa` (es(Tmax) ·
  (1 − max(RHmin, 5 %)/100)), `daylength_s` (NFDRS4 `CalcDayl`, MT-CLIM constants incl. `DAYSOFF` 10.25),
  `gsi_indicators`, `daily_gsi`, `gsi_mean` (21 values required, scaled by `GSI_MAX` 1.0, clamped 0..1),
  `gsi_live_fuel_moisture` (green-up 0.5; herb 0.30 → 2.50, woody 0.60 → 2.00, linear above the threshold).
  Parameters are NFDRS4's defaults (`github.com/firelab/NFDRS4`, `livefuelmoisture.cpp` / `livefuelmoisture.h`, read
  2026-10-23); nothing is fitted.
- **Inputs** (`sources/weather.py`): `gsi_inputs(lat, lon, start_ms, end_ms, tz, *, live=False, past_days=28)`:
  historical → `ARCHIVE_URL` with `models=era5`, local days `start − 28 d .. min(end, now − ERA5_DELAY_DAYS)`; live →
  `FORECAST_URL` with `past_days=28`, `forecast_days=1` (TTL `GSI_LIVE_TTL_S` 6 h). Hourly `temperature_2m` and
  `relative_humidity_2m` with `timezone=<fire zone>`, aggregated by `gsi_daily_rows` to local days (Tmin, Tmax, RHmin;
  a day needs >= 20 hourly values) plus daily `daylight_duration` (stored for audit). Never raises; `refused` flags a
  request-limit answer. Cost: one location, 3 series, about 2-6 weighted calls.
- **Series** `sim/lfm_gsi.json` (backend-only, no SPEC contract): `{method: "gsi_nfdrs2016", source, url, lat, lon,
  time_zone, from, to, fetched_ms, parameters, days: [{date, tmin_c, tmax_c, rhmin_pct, hours, daylight_s, gsi}]}`.
  Written by `build_weather` (`fetch_lfm_gsi`) for historical and live builds outside California (re-fetched by every
  live weather refresh, which calls `build_weather`). The window is the weather window `[a, b]` with
  `a − 28 d` in front, so every hindcast start inside the bundle has its 21 days. A failed fetch deletes a stale file.
- **Use**: `live_moisture_detail(bdir, manifest, start_ms, gw=None, *, fetch=True) -> {herb, woody, note, method,
  gsi}`; `live_moisture_for` (unchanged signature) returns its first three values. `gsi_at(doc, t_ms)` = the mean of
  the daily index over the 21 local days before the day of `t_ms`, recomputed from the stored inputs. Used by
  `member_weathers` (every forecast), `ensemble.members_from_weather_json` (fallback members) and
  `behavior._live_moisture_by_hour` (the at-fire behaviour annotation, per local day).
- **Never silent**: no series, or no 21 days before the start → California's values, the note
  `INTERIM_LFM_NOTE` = "Live fuel moisture: California's seasonal values (GSI series unavailable); experimental."
  (text changed from wave 1's "(regional method not tested yet)" to the §14.12.10 wording), `method`
  `ca_month_table(_drought)`, and the manifest warning `INTERIM_LFM_WARNING` plus "Weather: GSI live fuel moisture
  series unavailable: California's seasonal values are used (…)". With `require_hrrr` a missing series raises
  `WeatherError("GSI live fuel moisture series unavailable …; --require-hrrr needs it outside California")`.
- **California unchanged**: `_california_moisture` is the pre-GSI code path; `tests/test_gsi.py` compares it with a
  frozen copy of the pre-GSI `live_moisture_for` on Eaton, Palisades, Madre (when built) and `fixture-demo`.
- **Ablation switch**: `config.LFM_FORCE_CALIFORNIA` (validation only; `validate hindcast --lfm california`).

## §14.4 regional tooling (as built)

- `spread/validate.py`: `ACCURACY_REGIONS`, `region_status(n_fires, n_leads)`, `fire_score(rows)`,
  `region_accuracy(id, name, fires, *, in_sample, caveats)`, `regional_accuracy(fires, *, generated_ms, engine,
  settings, in_sample_regions, region_caveats, starts, secondary)`; CLI `validate regional <fires.json> --out <file>`.
  Region value = mean of the fire means; `pooled_leads`, `by_lead` (keys "12"/"24"/"48"/"72", pooled per lead),
  `range` (min-max of the fire means), `growth_ratio_median` (median of per-lead forecast/observed growth ratios),
  `ignition_relative` (mean of the fire means of the ignition rows), `fuel_groups_tested` (union of the fires' fuel
  words: grass / shrub / timber whose summed LANDFIRE FBFM40 family shares reach 25 % of the fire's burnable burned
  area; GR grass, GS half grass and half shrub, SH shrub, TU/TL/SB timber). Never writes `seed`.
- `batch_hindcast(..., start_times_ms=[...])` and the CLI spec `'<id>@2025-08-25T19:30Z,...'`: absolute UTC starts.
- `live_start_check(..., until_h=)` / `live-start --until`: last issue time after ignition (long-lived fires).
- `backend/scripts/validate_us_fires.py`: `FIRES` (pre-registered), `starts`, `checks` (protocol step 2),
  `hindcast --what main|main_det|ignition|ablation_det`, `collect` (fires.json for `validate regional`).

## Bug fix in the build code (validation's bug-fix permission)

- `backend/fire3d/catalog.py` `_estimate` (AOI sizing, `estimate_fire_bbox`): it called
  `perimeters.fetch_perimeters` without the WFIGS identity, so for a fire outside California the California-only
  default query found no perimeter and the AOI was sized from the VIIRS cluster alone. Windy Deuce's AOI came out 36 km
  and clipped the fire (observed / WFIGS area 0.78, 1,138 burned cells on the AOI edge). Fix: pass `record_source`,
  `state` and `irwin_id` for WFIGS rows (as `observed.perimeter_identity` does); CAL FIRE rows unchanged. Regression
  test `tests/test_firedata_catalog.py::test_estimate_fire_bbox_matches_a_wfigs_fire_by_irwin_id`. Effect: Windy
  Deuce 36 → 60 km (area ratio 1.04, inside the AOI); Emigrant 34 → 37 km; Table Rock 19 → 20 km; centre shifts under
  270 m for Lower Sugarloaf, Cottonwood Peak, Trout and Greer; Black Cove, Island Creek, France Canyon, Horse Gulch and
  Rush unchanged. The seven changed bundles were rebuilt and re-scored; before/after values are in docs/validation.md
  section 10.9.

## Deviations

- Day length uses NFDRS4's own formula (`CalcDayl`), as the reference code does; Open-Meteo's `daylight_duration` is
  fetched and stored for audit only (CONTRACT: "day length from the archive host").
- The daily inputs are hourly temperature and humidity aggregated to the fire's local days (Tmin, Tmax, RHmin), not
  Open-Meteo daily aggregates, so both hosts give the same variables (CONTRACT: "daily … minimum/maximum temperature,
  vapour pressure deficit or dew point").
- Outside California the water-year request is still made (best effort, never a warning while GSI applies): it serves
  the never-silent fallback (`ca_month_table_drought`) and the validation ablation.
- Build gate: the queue started a build when historical-forecast or the archive answered the probe (not only on
  `overall ok`; the forecast host is not used by these historical builds), relying on `--require-hrrr` to fail rather
  than fill. Every scored bundle has 0 ERA5 and 0 GFS-filled hours and an ERA5 GSI series (docs/validation.md 10.3).
- The series covers `start − 28 d` through the end of the bundle's weather window (CONTRACT: start − 28 d to start),
  so hindcasts started days after ignition use the 21 days before their own start.

## Files

`backend/fire3d/config.py`, `backend/fire3d/spread/moisture.py`, `backend/fire3d/spread/behavior.py`,
`backend/fire3d/spread/ensemble.py`, `backend/fire3d/spread/validate.py`, `backend/fire3d/sources/weather.py`,
`backend/fire3d/build/weather_bundle.py`, `backend/scripts/validate_us_fires.py`, `backend/tests/test_gsi.py`,
`backend/tests/test_regional_accuracy.py`, `backend/tests/test_spread_validate.py`,
`backend/tests/test_us_pipeline_quota.py` (one test adapted to GSI), `backend/tests/test_regional_accuracy_script.py`,
`backend/fire3d/catalog.py` and `backend/tests/test_firedata_catalog.py` (bug fix), `backend/fire3d/data/regional_accuracy.json`,
`docs/validation.md`.
