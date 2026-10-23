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

## M3: national list, merge, FIRMS feed, live loop (commit `brief 3 us-catalog: M3 ...`)

### `backend/fire3d/sources/wfigs.py`
- `list_current(refresh=False)` (Current layer, 5 min), `list_year(year, min_acres=300, refresh=False)` (YearToDate for
  the current UTC year, 30 min; all-years layer for past years, 24 h), `find_irwin_prefix(prefix)` (all-years, 24 h).
  Server-side `IncidentTypeCategory='WF'` (+ `UniqueFireIdentifier LIKE '<year>-%' AND IncidentSize>=<min>` for year
  lists), explicit `OUT_FIELDS`, `outSR=4326`, pages of 2,000, through `fire3d.http`, stale-if-error, `WfigsError`.
- Rows are cleaned dicts (`normalize`): `irwin_id` (upper, no braces), `unique_fire_id`, `year` (UFI year),
  `source_name`, `type`, `acres`, `percent_contained`, `started_ms`, `contained_ms`, `controlled_ms`, `out_ms`,
  `updated_ms`, `ics209_report_ms`, `poo_state` (USPS), `county`, `agency_code`, `protecting_unit`, `gacc`,
  `is_cpx_child`, `cpx_name`, `lat`, `lon`, `url` (= `record_url(irwin)`, the all-years `f=html` page).
  Helpers: `clean_irwin`, `record_url`, `ufi_year`, `fetched_ms(key)`, `list_key(url, where)`, `DATASET_URL`.

### `backend/fire3d/catalog.py` (what other roles call)
- Switches: `CA_ACTIVE_RULE = "either"`, `CA_COMPLEX_ROWS = "calfire"`.
- `default_year()` (current UTC year; `HISTORICAL_YEAR` is kept as a deprecated import-time alias).
- `get_catalog(mode, min_acres=None, refresh=False, year=None, state=None)` (signature extended with an optional
  `state`), `list_incidents(...) -> (rows, sources)`, `cached_sources(mode, year=None, min_acres=None)`.
- **`resolve_listed(incident_id) -> IncidentSummary | None`**: live list, the id's year list, CAL FIRE's year list (any
  size), then one cached `IrwinID LIKE '{ABCDEF%'` query; year and slug checked; never a manifest. A California WFIGS
  record folded into a CAL FIRE fire is not resolvable under its WFIGS id. **Alaska, Hawaii and territory ids
  resolve** (with their own `state` and zone, e.g. America/Anchorage) although they are never listed, so the build
  gate can answer 422; `is_supported(summary)` is False for them.
- `get_summary(id)` = `resolve_listed` else `manifest_summary(id)`; `is_bundle_only(id)`; `find_by_irwin(irwin_id)`
  (a listed row carrying that IRWIN id as its own or a matched record, else the record's own summary);
  `is_supported(summary)`; `record_issuer(summary)`; `issuer_for(code)`; `active_sources(summary)`;
  `accuracy_region_for(gacc, state)` (SACC split TX/OK -> SACC-SP, else SACC-SE; unknown codes -> None);
  `summary_from_wfigs(rec, mode, current_irwins, state)`; `merge_california(wf_rows, cal_pool)`;
  `display_name` (ALL CAPS -> title case word by word); `name_tokens`; `norm_name`;
  `live_detections_24h_us_total()` (new) next to `live_detections_24h_total()` (California, kept).
- Merge as §14.2, measured live on 2026-10-23 01:00 UTC: live 235 rows in 23 states (CAL FIRE rows 6: Timber
  (active by NIFC only), Rocky, Lost (NIFC only), Norte, Cooley, Soda; 62 WFIGS-only California rows); 2026 list 1,192
  rows; 2025 list 856 rows, California = 78 CAL FIRE + 2 WFIGS (Big Cliff, Alpaugh); TCU September Lightning Complex
  one row with 5 members (the duplicate "2-2" record dropped first), Orleans Complex (Butler), Swift Complex (PEAK).
- Rules decided here: name tokens drop "fire", "the", "incident", "wildfire"; duplicates need both sizes reported and
  over 1 ac (two different 0.1 ac "SMOKE CHECK" fires are never merged); duplicates are removed **before** the
  California merge; WFIGS year lists are never fetched below 100 ac (`WFIGS_YEAR_FLOOR_ACRES`; `min_acres=0` lists
  CAL FIRE of every size plus WFIGS >= 100 ac); `complex_name` is the complex's display name (title-cased when ALL
  CAPS) and usually already ends in "Complex" ("Montana Lightning Complex"): the card should not add "Complex" again.
- `agency` on WFIGS rows: from `nwcg_agency_codes.json` once that landed (cut-line item (e), done; see below); `record_issuer` always
  shows the code verbatim ("USFS via NIFC WFIGS").

### `api/app.py`
- `GET /api/incidents`: `state=` (two letters; 422 otherwise), `year` default `catalog.default_year()`, `sources[]`
  always present (from `catalog.cached_sources`; `[]` only with a test's fake catalog), gzip in the handler when
  accepted and the body is >= 1 KB (`Vary: Accept-Encoding`).
- Build gate texts: 422 "Fire-3d does not support Alaska, Hawaii or US territories yet." (a listed id whose state is
  not in the lower 48); 409 "'{id}' is a local or synthetic bundle; it cannot be rebuilt." (no list knows the id);
  409 "'{alias}' is listed as '{id}'." (an alias); 409 "'{id}' cannot be built in this version yet." (listed but
  `pipeline.is_catalog_incident` still refuses it: every WFIGS id until us-pipeline's build-anywhere lands).

### FIRMS (`sources/firms.py`, §14.12.1)
- `L48_FIRMS_BOX = (-125.4, 23.9, -66.4, 49.9)`; `load_live_us(days=7, refresh=False)`; `load_year_us(year,
  bbox=None)` (national CSVs cut to the box, sorted by lon, `firms_us_{year}.parquet` with 50,000-row groups, read
  with pyarrow `filters=`); `load_live_ca` / `load_year_ca` are deprecated wrappers (CA box cut of the national
  loaders; `load_year_ca` reads `firms_us_{year}.parquet`, no `firms_ca_*` file is written any more).
- Callers switched: `firms._keyless` (yearly `load_year_us(year, bbox)`, live `load_live_us(7)`), `catalog._live_base`
  (`load_live_us(1)`), `catalog._bbox_detections` (`load_live_us(7)`), `api/live.py` (`fetch_cycle_data`:
  `load_live_us(days=7)`; counts: `load_live_us(days=1)`).
- `assign_detections`: dense matching kept (cut-line item (c) not done); a 300-fire x 20,000-detection national case
  runs well under 2 s (test `test_assign_detections_national_timing`).

### `api/live.py` (§14.12.12)
- Candidates from the national live list; `AUTO_BUILD_MAX = 4`, 100 ac and 48 h unchanged.
- `LiveStatus.detections_24h` (state polygons, `regions.in_lower48`) next to `detections_24h_ca`;
  `detections_24h_us(dets_7d=None)` new.
- `SUMMARY_SYNC_FIELDS` also copies `active_sources`, `other_records`, `complex_members`, `irwin_id`, `gacc`,
  `accuracy_region` into ready live bundles' summaries.

- A CAL FIRE fire matched by two WFIGS records (CAL FIRE's Dale Fire: DALE and BRADFORD BRANCH) keeps both in
  `other_records` and takes the `irwin_id` of the one with the same name tokens (null when there is no single one).
- Samples (`backend/tests/data/firedata/us_*`, PROVENANCE.md "Brief 3") and `tests/test_us_catalog_samples.py`: the
  2025 merge gives 69 same-fire matches, 8 complex members (Orleans: Butler; Swift: PEAK; TCU: 2-2, 2-7, 2-8, 6-2, 6-5
  after the duplicate 2-2 is dropped) and 2 WFIGS rows (Alpaugh, Big Cliff).

### Changes other roles need
- `backend/tests/test_official_calfire.py:224` (us-pipeline) asserts the old default year: `catalog.get_catalog
  ("historical")` now lists the current UTC year (§14.1). Replace that line with
  `assert [s.id for s in catalog.get_catalog("historical", year=2025)][:1] == ["2025-gifford-fire-fb7c1c"]`.
- `pipeline.is_catalog_incident` (us-pipeline) can now be `summary is not None and summary.id == incident_id and
  catalog.resolve_listed(incident_id) is not None` (§14.2) plus `catalog.is_supported`; `refresh_live`
  (`pipeline.py:677`) should call `firms.load_live_us(days=2)`.

## M4: incident records and accuracy regions (commit `brief 3 us-catalog: M4 ...`)

### `GET /api/official/incident-record?incident=<id>` (`backend/fire3d/api/records.py`, included by `api/app.py`)
- Exactly `IncidentRecordResponse` (§14.5). Resolution: `catalog.resolve_listed`, else the bundle manifest (then
  `not_covered` "This is synthetic or local data; it has no agency record."); unknown id 404; invalid id 400.
- A CAL FIRE complex row (`complex_members` non-empty): `not_covered` "This is a CAL FIRE complex; NIFC WFIGS lists its
  member fires separately." (`irwin_id` and `current` null). A California row without `irwin_id`: `not_covered`
  "NIFC WFIGS has no record matched to this fire.".
- The record: `wfigs.record_by_irwin(irwin)` (all-years layer, exact `IrwinID='{...}'`, cached 10 min).
  `current.is_active` = in the Current layer with `PercentContained` null or < 100. `source.url` = the record page;
  `incident_url` = the all-years `f=html` query; `dataset_url` =
  https://data-nifc.opendata.arcgis.com/datasets/nifc::wildland-fire-incident-locations (checked: HTTP 200; item
  b4402f7887ca4ea9a6189443f220ef28, licence text a disclaimer only). WFIGS down: `upstream_error` with
  "NIFC WFIGS could not be reached; the agency record is not shown.". `agency` is null until the NWCG code file lands
  (cut line (e), since done: names from `nwcg_agency_codes.json`); `agency_code` verbatim. `Cache-Control: no-store`.

### `GET /api/accuracy-regions` and the seed
- `backend/fire3d/data/regional_accuracy.json` (schema 1): OSCC `tested`, `in_sample`, `seed`, 3 fires, 32 leads,
  `growth_sorensen` 0.433 (mean of fire means; renders 0.43), `range` [0.395, 0.467], `pooled_leads` 0.438, `by_lead`
  {"12": 0.349, "24": 0.432, "48": 0.481, "72": 0.49}, `growth_ratio_median` 1.85, `years` [2025], `lfm_method`
  "ca_month_table_drought", `fuel_groups_tested` ["chaparral", "grass"], two caveats; no `fuels_editions` and no
  `fires` (their per-fire `era5_hours` is not known, and a value is never guessed). The other nine `untested`, 0 fires.
- The endpoint serves the file with every region (fixed order NWCC ... OSCC; a missing one `untested`), each `status`
  recomputed from its counts (`tested` >= 2 fires and >= 16 leads, else `limited` with >= 1 fire, else `untested`),
  plus `served_ms`; `Cache-Control: no-cache`; 503 when the file is unreadable.

## M5: national search (commit `brief 3 us-catalog: M5 ...`)

- `backend/scripts/build_gazetteer.py` -> `backend/fire3d/data/gazetteer_us.json` (3.7 MB, 1.1 MB gzipped; 2026
  Census Gazetteer national place, county and ZCTA files): 35,585 places and counties (city 10,253, town 4,317,
  village 3,716, borough 1,215, cdp 12,557, county 3,222, comunidad 214, zona urbana 78, municipality 7, government 6)
  and 33,791 ZIP areas, every state, DC and Puerto Rico (Alaska, Hawaii and territory rows kept). Place rows
  `[name, type, state, lat, lon, land_km2, county, alias]`; ZIP rows `[zip, state, lat, lon, land_km2]` (state from
  the lower-48 polygons, else the ZIP prefix). `gazetteer_ca.json` is removed. Cut-line item (a) (ZCTA and county
  rows) is therefore done too.
- `GET /api/geocode` local matches gain `state`, `state_name`, `county` (name or null), `supported` (false in Alaska,
  Hawaii, territories) and `note` per match (the §14.14 sentence when not supported); `name` and `matched_address`
  read "<Name>, <ST>" / "ZIP <zip>, <ST>"; `place_type` is the LSAD in plain words (`city`, `town`, `village`,
  `borough`, `municipality`, `government` = consolidated city-county, `county`, `cdp`, `comunidad`, `zona_urbana`,
  ZIP matches `zip`) with `place_type_label`. Parsing (`geocode.split_query`): "Springfield, IL", "Springfield IL",
  "Springfield, Illinois", "83702 ID", "ID 83702", "Ada County, ID", "Washington, DC"; a bare "Springfield" lists the
  largest matches across states (exact first, then city > town > village > county > CDP, then land area); a state
  word alone is a name ("Washington", "California"). No match: "No US city, town, county or ZIP code matches
  '<q>'." + what is searched with the national examples "e.g. 600 E Mariposa St, Altadena; Boise, ID; 83702"; the
  400 messages use the same examples. Census names are kept: "Boise, ID" finds "Boise City, ID" (exact, through the
  alias "Boise"), "Nashville, TN" finds "Nashville-Davidson, TN".
- For us-web: the local match's `name` now carries the state ("Altadena, CA"); `near` stays a bare place name of the
  same state.

## Cut-line items done

- (a) ZCTA and county rows of the gazetteer: done in M5.
- (b) `backend/scripts/build_ca_county_gacc.py` -> `backend/fire3d/data/ca_county_gacc.json` (1 GET: WFIGS all-years
  statistics of California wildfires >= 10 ac by `POOCounty` and `GACC`): 57 counties; exactly the six of §14.4 are
  null (Alpine, Imperial, Mono, San Joaquin, Sierra, Stanislaus). `catalog.ca_county_region(lon, lat)` gives a CAL FIRE
  row its region when no WFIGS record is matched (county from `regions.county_at`); `gacc` stays null (no GACC is
  claimed for the record).
- (d) SPEC prose: §0 scope (lower 48), §2 rows for every §14.13 source, §4.1 UTM rule, §4.2 local time with its zone
  (Public 12-hour, Command and Forensic 24-hour), §4.4 ids (CAL FIRE and WFIGS), §8.7 national live list.
- (e) `backend/fire3d/data/nwcg_agency_codes.json`: 28 codes named as NWCG's "Standards for Unit Identifiers, PMS 931"
  (September 2022, https://www.nwcg.gov/publications/pms931, section 4 "Tier 2 (Organizational Unit Agency)") names
  them, checked 2026-10-23; terms (PMS 931): "Publications and training materials produced by NWCG are in the public
  domain. Use of public domain information, including copying, is permitted. Use of NWCG information within another
  document is permitted if NWCG information is accurately credited to NWCG." Credit "Agency names: NWCG unit
  identifiers". IRWIN spellings mapped to PMS 931 codes and recorded in `meta.equivalents`: USFS (PMS 931 "FS" under
  USDA) "USDA Forest Service", USFWS ("FWS") "U.S. Fish and Wildlife Service", CAL FIRE ("CDF") "California Department
  of Forestry and Fire Protection". Codes PMS 931 does not name (INTER, SHP, TRIBE, USMC) stay verbatim
  (`meta.not_named`). `catalog.agency_name(code)` fills `agency` on WFIGS rows, `OtherRecord.agency` and the incident
  record's `agency`.
- (f) Id pinning: `catalog.pinned_id(rec)` / `wfigs_id(rec)`; a CAL FIRE row matched (rule 2, one record) to a WFIGS
  record with a bundle under its WFIGS id keeps that id, lists its CAL FIRE id in `aliases`; both resolve; a build by
  the alias answers 409 "'{alias}' is listed as '{id}'." Tested with a before/after pair built from the synthetic
  McCovey row and a hand-made CAL FIRE record of the same fire (no real before/after pair exists in the samples).

## Cut-line item not done

- (c) The scipy KD-tree in `catalog.assign_detections`: not done; the dense matching (now first cut to the fires'
  combined box) runs on the national feed in well under 2 s (synthetic 300 fires x 20,000 detections in the test;
  the national-sized case of 235 fires x 11,792 detections takes 0.57 s here; `_live_base` logs the time of each run).

## Deviations
- Id pinning is tested with a synthetic before/after pair, not a recorded one (none exists in the samples).
- `coverage_at` uses a **1 km** tolerance around the state polygons, not 5 km: the TIGERweb state polygons already
  include near-shore water, and 5 km would put central Tijuana (2.0 km south of the border; §14.3 requires
  `outside_us`) and Windsor, ON (2.8 km from Detroit) in the United States. `state_at` keeps `max_km=5.0` (filling a
  missing `POOState`), and `time_zone_at` keeps the 5 km nearest-zone rule.
- §14.1 "before-validator" is an after-validator with the same effect (reason above).
