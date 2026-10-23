# brief3-us-catalog progress

Role: us-catalog (backend national list, contracts, regions, UTM, FIRMS feed, live list, records, accuracy seed,
national search). Ports API 8711, Vite 5181. Started 2026-10-23 ~00:20 UTC.

## Done
- M1 contracts: contracts.py (all §14.1-14.7/14.12 models, defaulted), types.ts, client.ts (getGeoLookup,
  getAccuracyRegions, state option), records.ts (+tests), fixtures.testutil.ts, SPEC §5.1/§6 rows, parity test
  (tests/test_us_catalog_contracts.py). Backend 585+20 pass; web 60 files / 760 tests pass; lint 55 (scene).

- M2: regions.py + us_states/us_counties/us_timezones geojson + build_us_regions.py; /api/geo/lookup; UTM rule;
  check_bundle.py; test_grid zones 10-19; make_fixture --only east (fixture-east on disk).

- M3: sources/wfigs.py, catalog national list + CA merge + resolve_listed etc., FIRMS national loaders and callers,
  live.py national, app.py list (state, sources, gzip) + build gate texts; synthetic tests
  (test_us_catalog_list.py, test_us_catalog_firms.py, test_us_catalog_mock.py helpers).

- M3 samples: `record_test_samples_firedata.py --brief3` -> tests/data/firedata/us_* (PROVENANCE.md "Brief 3");
  tests/test_us_catalog_samples.py (merge 69/8/2, TCU 5 members, Timber, McCovey/Marshall, Dale two records, RX/CX,
  Hay Creek members, POOState cases, Horse Gulch/Black Cove by IRWIN, feed box, Montana keyless).
  Live-loop guard added to my TestClient tests (lifespan would auto-build).

## Next
- M4 records endpoint + accuracy seed/endpoint. M5 gazetteer.

## Decisions
- §14.1 before-validator implemented as an after-validator using model_fields_set (a before-validator breaks strict
  JSON tuple checks for bbox_lonlat). Same effect. Recorded in contract3/us-catalog.md "Deviations".

## Open problems
- tests/test_official_calfire.py:224 (us-pipeline) asserts default year 2025; fails since M3 (contract default
  year = current UTC year). Exact fix in contract3/us-catalog.md "Changes other roles need".
- tests/test_official_nws.py::test_endpoint_live_alert_near_a_fire fails in the shared tree with us-pipeline's
  uncommitted nws.py/official.py/test_official_nws.py edits (not my files); rerun after their next commit.
