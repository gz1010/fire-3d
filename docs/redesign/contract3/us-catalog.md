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

## Deviations
- §14.1 "before-validator" is an after-validator with the same effect (reason above).
