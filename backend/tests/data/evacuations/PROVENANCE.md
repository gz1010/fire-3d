# Evacuation test samples (brief 3, us-official)

Read by `backend/tests/test_evacuations_sources.py`. No personal or account fields: `Editor_Name`, `Editor_Email`,
`Editor_Phone`, `created_user` and `last_edited_user` were never requested (the recorder refuses to write a sample that
has them).

## `or_oem_2026-08-15T1200Z.geojson`

- Recorded 2026-10-23 01:52 UTC with `backend/scripts/record_test_samples_evacuations.py` (4 GET requests through
  `fire3d.http`).
- Source: Oregon Department of Emergency Management (OEM), "2026 Wildfire Evac History" (item
  `c8b3c502f58045269f32737fa8f5c025`,
  `https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/2026_Wildfire_Evac_History/FeatureServer/0`), a
  5-minute snapshot of the live layer "Evacuation Areas Public" (item `dd2bee51e3004dc4b1004df34fbd9e29`).
- Query (EV §6 recipe of `docs/redesign/audit-3/evacuations.md`): the snapshot `Date >= 2026-08-15 12:00 UTC AND Date <
  12:05 UTC`, rows with `Fire_Name IN ('Fielders Mountain','HWY 229 Landslide')` (11 zones: Fielders Mountain (`HazardType` "Fire") in
  Jackson and Josephine counties, levels 1, 2 and 3; the non-fire "HWY 229 Landslide", `HazardType` "Other", level 3,
  Lincoln County), plus one zone of the same snapshot with `Fire_Name` null (Umatilla County, level 2).
- Fields: `fire3d.sources.evacuations.OR_OEM_FIELDS` only (`OBJECTID, GlobalID, Fire_Name, Fire_Evacuation_Level,
  County, Evac_Area_Name, HazardType, created_date, last_edited_date`). The history layer's `Date` was dropped, so the
  sample has the live layer's shape. Geometry WGS84, 5 decimals (`geometryPrecision=5`), unchanged otherwise.
- What it shows: `created_date` is when each zone entered the state layer (Aug 14, 2026 for Fielders Mountain);
  `last_edited_date` is 2026-08-15 12:00 UTC for every zone (OEM's 15-minute recalculation, not an issue time).
- Terms: item `licenseInfo` "Public", `accessInformation` "Oregon Department of Emergency Management" (read again by
  the recorder on 2026-10-23). The live layer had 0 zones at recording time (off-season).

## `or_oem_layer_info.json`

The live layer's description at recording time, trimmed: name, `objectIdField`, `maxRecordCount`, `editingInfo`
(`dataLastEditDate` 2026-09-29T18:42Z), the number of fields and the whitelisted field names (all present). Used as the
mocked `?f=json` answer.

## `caloes_brief2_expected.json`

Not recorded upstream: the brief-2 answers of `GET /api/extras/evacuations` for four California cases (zones listed,
none listed, a county not in the statewide layer, Cal OES HTTP 503), computed offline on 2026-10-23 from
`backend/fire3d/api/extras.py` as it was before brief 3 (last changed in commit `b07e0cb`) with the recorded Cal OES
samples of `tests/test_extras.py`. The brief-3 code must keep every one of these keys and values (CONTRACT §14.8.2:
only new keys are added). `retrieved_ms` (Fire-3d's fetch time) is not compared.
