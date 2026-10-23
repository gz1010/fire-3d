# us-catalog: as built (brief 3, wave 1)

Role `us-catalog` (CONTRACT §14.1-14.5, 14.10, 14.12.1/4/9/12, 14.13). This note says what exists in the tree at each
milestone commit; other roles read it instead of guessing. Kept current at every milestone.

## M1: contracts (commit `brief 3 us-catalog: M1 ...`)

### Python (`backend/fire3d/contracts.py`)
- `IncidentSummary` gains every §14.1 field, all defaulted (§14.0): `uid`, `record_source`, `record_issuer`, `state`,
  `time_zone`, `source_name` use `Optional_()` (omitted from dumps when None); `agency`, `agency_code`, `irwin_id`,
  `unique_fire_id`, `gacc`, `accuracy_region`, `complex_name` default to `None` and are always serialized (null);
  `active_sources`, `other_records`, `complex_members`, `aliases` default to `[]`.
- The §14.1 "before-validator" is implemented as a **`model_validator(mode="after")`** that fills only fields the input
  did not give (`model_fields_set`). Reason: a `mode="before"` validator turns strict JSON validation into strict
  Python validation, and `contract_problems(IncidentListResponse, ...)` then rejects every `bbox_lonlat` JSON array as
  "not a valid tuple" (seen in `test_api.py::test_incident_lists`). The effect is the contract's: old manifests and
  fixtures get `uid <- calfire_uid`, `record_source "calfire"`, `record_issuer "CAL FIRE"`, `agency "CAL FIRE"`,
  `source_name <- name`, `active_sources ["calfire"] if is_active else []`; a WFIGS row never gets a CAL FIRE default.
  `state` / `time_zone` come from `fire3d.regions` once it exists (M2); before M2 both stay unset (omitted).
- New models: `OtherRecord`, `ListSource`, `GeoCounty`, `GeoLookup`, `AccuracyFire`, `AccuracyRegion`,
  `AccuracyModelInfo`, `AccuracyMethod`, `AccuracyAssignment`, `AccuracyRegionsResponse`, `IncidentRecordCurrent`,
  `IncidentRecordComplex`, `IncidentRecordResponse` (`kind: Literal["incident_record"]`, `changes` must be `[]`,
  `recording_since_ms: None`), `LocalAlert`, `LocalChannelStatus`, `LocalAlertCounty`, `LocalAlertsResponse`
  (`kind: Literal["local_alerts"]`). Literal aliases: `RecordSource`, `AccuracyRegionId`, `Coverage`, `AccuracyStatus`,
  `OfficialKind`, `LocalChannel`.
- Defaulted additions to existing models (`Optional_()`, marked (R)): `IncidentListResponse.sources`,
  `LiveStatus.detections_24h`, `FireWeatherResponse.states_checked` / `alert_states`, `FireWeatherAlert.time_zone`,
  `SkillEntry.growth_sorensen`. Widened Literals: `OfficialEnvelope.kind` (+ `incident_record`, `local_alerts`),
  `OfficialReasonCode` (+ `state_not_available`).
- Checked at the M1 commit with `nws.py`, `api/official.py`, `api/extras.py` unchanged: `tests/test_official_nws.py`,
  `tests/test_official_real_bundles.py`, `tests/test_extras.py` pass (and the whole backend suite).

### Web (`web/src/api/**`)
- `types.ts`: `RecordSource`, `AccuracyRegionId`, `OtherRecord`, the `IncidentSummary` additions (all optional, (R)
  marked), `ListSource`, `IncidentListResponse.sources?`, `LiveStatus.detections_24h?` (and `detections_24h_ca` marked
  deprecated), `Coverage`, `GeoLookup`, `AccuracyStatus`, `AccuracyFire`, `AccuracyRegion`, `AccuracyRegionsResponse`,
  `ForecastManifest.skill[].growth_sorensen?`.
- `client.ts`: `getGeoLookup(lon, lat, opts?)` (point rounded to 1e-5° via `geoLookupQuery`, so repeats share the
  browser cache), `getAccuracyRegions(opts?)`, `IncidentListOptions.state` and a 4th optional `state` argument of
  `incidentListQuery` (both modes; trimmed, upper-cased).
- `records.ts`: `RecordBlock`, `recordIssuerLabel(summary)`, `recordBlocks(summary)` exactly as §14.5; also exported:
  `otherRecordIssuerLabel(rec)` (same rule for an `other_records` entry) and `ownRecordActive(summary)`.
  - The plain agency name is added only when it differs from the code: "USFS (USDA Forest Service) via NIFC WFIGS".
  - The row's own block has `name: null` (its name is the card heading); other blocks carry their record's name.
  - A WFIGS row whose protecting-agency **code** is literally `CAL FIRE` (9 such Current rows on Oct 22) reads
    "CAL FIRE via NIFC WFIGS": that is the code verbatim, as published by NIFC, never a fallback.
- `fixtures.testutil.ts`: `summaryFixture(overrides)` (a complete CAL FIRE row in California),
  `wfigsSummaryFixture(overrides)` (a complete USFS row in Montana, America/Denver), `otherRecordFixture(overrides)`.

### SPEC
- §5.1: the `IncidentSummary` additions, `OtherRecord`, `skill[].growth_sorensen`.
- §6: rows for `/api/incidents` (year default, `state`, `sources`, gzip), the build gate texts, `/api/live/status`
  (`detections_24h`), `/api/geo/lookup`, `/api/accuracy-regions`, `/api/geocode` (national), `/api/extras` (state
  registry, `state_not_available`), `/api/official/calfire` (WFIGS rows), `/api/official/fire-weather` (national,
  `states_checked`), `/api/official/incident-record`, `/api/official/local-alerts`; the official TS shapes.

### Tests
- `backend/tests/test_us_catalog_contracts.py`: the defaults on an old manifest, given fields never overwritten, the
  defaulted additions, widened Literals, the new shapes (strict), and **contracts.py <-> types.ts parity** (field names
  and optionality) for `IncidentSummary` (incl. `aliases`; `bbox_lonlat` is `IncidentListRow`'s), `OtherRecord`,
  `ListSource`, `IncidentListResponse`, `LiveStatus`, `GeoLookup`, `AccuracyRegionsResponse` (and its inline `model`,
  `method`, `assignment`), `AccuracyRegion`, `AccuracyFire`, `GeoLookup.county`, `skill[]`.
- `web/src/api/records.test.ts`, `web/src/api/client.test.ts`.

## M2: regions, UTM, fixture-east (commit `brief 3 us-catalog: M2 ...`)

### `backend/fire3d/regions.py` (§14.3, exactly the listed API)
- `L48`, `STATE_NAMES` (also names AK, HI and the territories for messages), `County(fips, name, state)`,
  `state_at(lon, lat, *, max_km=5.0)`, `states_in_bbox(bbox, margin_km=0.0)`, `county_at`, `counties_in_bbox`,
  `same_codes` ("0" + 5-digit FIPS), `time_zone_at`, `main_zone`, `zone_name`, `coverage_at`, `lookup`.
  Extras: `is_supported_state(state)`, `sources_meta()`, constants `MAIN_ZONE`, `ZONE_NAMES`, `OUTSIDE_L48_BOXES`,
  `NOT_SUPPORTED_NOTE`, `OUTSIDE_US_NOTE`, `COVERAGE_TOLERANCE_KM`.
- Data (built by `backend/scripts/build_us_regions.py`, about 12 GETs; each file has a top-level `meta` with sources,
  licences, retrieval date and simplification):
  - `backend/fire3d/data/us_states.geojson` (49 features, 274 KB; TIGERweb `State_County/MapServer/0`, 0.005°);
  - `backend/fire3d/data/us_counties.geojson` (3,109 counties and equivalents, 1.5 MB; `State_County/MapServer/1`,
    0.01°, 3 decimals);
  - `backend/fire3d/data/us_timezones.geojson` (NTAD Eastern/Central/Mountain/Pacific + Navajo Nation Reservation +
    Hopi Reservation, 168 KB). Rule: the highest-priority feature containing the point wins (Hopi 3 > Navajo 2 > NTAD
    1); an NTAD Mountain point in Arizona outside the Navajo Nation is America/Phoenix.
- Terms checked 2026-10-23: NTAD Time Zones' own `copyrightText` ("This NTAD dataset is a work of the United States
  government ... available for unrestricted public use."); TIGERweb "Source: U.S. Census Bureau" (public domain).
- All 15 required points of §14.3 pass, plus Boise, DC, Shiprock NM and Tuba City AZ (Navajo Nation, America/Denver),
  Key West, Windsor ON and Mexico City.

### `GET /api/geo/lookup?lon=&lat=` (in `api/app.py`)
- `GeoLookup` body; 400 for a missing, non-numeric, non-finite or out-of-range value; `Cache-Control: public,
  max-age=86400`. Not supported: `state`, `county`, `time_zone` null and `note` = the §14.14 sentence.

### UTM (§14.12.4)
- `grid.utm_epsg_for(lon) = 32600 + floor((lon + 180) / 6) + 1` (new helper `grid.utm_zone_for(lon)`, clamped 1..60).
  California unchanged (tests on -120.0 / -120.0001, Eaton, Palisades, fixture-demo zone 11, fixture-live zone 10,
  and the real bundles on disk). `scripts/check_bundle.py` expects the standard zone of the AOI centre or of the
  incident point, and checks `utm_zone` against `crs`.

### `fixture-east` (§14.12.9)
- `uv run python scripts/make_fixture.py --only east` (about 40 s) writes `data/incidents/fixture-east`: historical
  2025-03-22 18:10 UTC (14:10 EDT), 12 km AOI at (35.29, -82.30), EPSG:32617, ~3,950 ac. Summary: `state` "NC",
  `time_zone` "America/New_York", `record_source` "wfigs", `record_issuer` "NIFC WFIGS (IRWIN)", `irwin_id` null,
  `calfire_uid` "", `uid` "", name "Fixture East (synthetic)"; event and ignition text say "NIFC WFIGS (IRWIN)" and
  "ET" (no "CAL FIRE" anywhere in the bundle). The default run (demo + live) is unchanged.
- `check_bundle.py fixture-east` reports one problem, "forecast fx-001: arrival before the start", which
  `fixture-demo` and `fixture-live` already report on the same synthetic forecast (pre-existing, not brief 3).

## Deviations
- `coverage_at` uses a **1 km** tolerance around the state polygons, not 5 km: the TIGERweb state polygons already
  include near-shore water, and 5 km would put central Tijuana (2.0 km south of the border; §14.3 requires
  `outside_us`) and Windsor, ON (2.8 km from Detroit) in the United States. `state_at` keeps `max_km=5.0` (filling a
  missing `POOState`), and `time_zone_at` keeps the 5 km nearest-zone rule.
- §14.1 "before-validator" is an after-validator with the same effect (reason above).
