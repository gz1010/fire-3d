# brief3-us-catalog progress

Role: us-catalog (backend national list, contracts, regions, UTM, FIRMS feed, live list, records, accuracy seed,
national search). Ports API 8711, Vite 5181. Started 2026-10-23 ~00:20 UTC.

## Done
- M1 contracts: contracts.py (all §14.1-14.7/14.12 models, defaulted), types.ts, client.ts (getGeoLookup,
  getAccuracyRegions, state option), records.ts (+tests), fixtures.testutil.ts, SPEC §5.1/§6 rows, parity test
  (tests/test_us_catalog_contracts.py). Backend 585+20 pass; web 60 files / 760 tests pass; lint 55 (scene).

- M2: regions.py + us_states/us_counties/us_timezones geojson + build_us_regions.py; /api/geo/lookup; UTM rule;
  check_bundle.py; test_grid zones 10-19; make_fixture --only east (fixture-east on disk).

## Next
- M3 sources/wfigs.py + catalog national list + CA merge + FIRMS national + live.py + samples.

## Decisions
- §14.1 before-validator implemented as an after-validator using model_fields_set (a before-validator breaks strict
  JSON tuple checks for bbox_lonlat). Same effect. Recorded in contract3/us-catalog.md "Deviations".

## Open problems
- tests/test_official_nws.py::test_endpoint_live_alert_near_a_fire fails in the shared tree with us-pipeline's
  uncommitted nws.py/official.py/test_official_nws.py edits (not my files); rerun after their next commit.
