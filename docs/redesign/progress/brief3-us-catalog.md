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

- M4: api/records.py (incident-record, accuracy-regions), regional_accuracy.json seed, wfigs.record_by_irwin,
  tests/test_us_catalog_records.py.

- M5: national gazetteer (places + counties + ZCTAs; cut line (a) done), geocode.py national parsing and fields.

- Acceptance on API 8711 (FIRE3D_LIVE=0): live 235 rows / 23 states / 0 outside; 2026 1,192; 2025 856; OR 85; gzip 13.5 %;
  detections_24h 10,816 vs _ca 199; geo lookup ID/AK/Tijuana ok; accuracy 10 regions; record available; fixture-east ok.
- Web gates: typecheck 0, lint 55 (scene), vitest 64 files / 835 tests, build ok.
- Cut line: (a) in M5, (b) ca_county_gacc, (d) SPEC prose, (e) nwcg_agency_codes, (f) id pinning done; (c) KD-tree not done
  (dense 235x11,792 in 0.57 s).

- Final gates (backend 829 passed; web gates ok), wording scan (5 justified hits), key scan (0), report written.

## Review fixes round 1 (2026-10-23)
- I reviewed the interrupted fixer's work, which was already in the orchestrator checkpoint c1a71bb, and kept all of it.
- R1 fixed. When a pinned id changes records, the live sync now also copies the record identity (api/live.py
  RECORD_IDENTITY_FIELDS, including started_ms and year). The id and time_origin_ms stay.
- R2 fixed. A possessive keeps a lower-case "s" ("Devil's Canyon"). Ids do not change.
- R3 fixed. The reason now names the matched records ("NIFC WFIGS lists this fire under several records (...)").
  Recorded as a §14.5 deviation.
- SPEC: us-pipeline's text applied after checking each part against the code. The OpenFEMA prefetch is described
  as "prefetched once", because HEAD runs it at the end of the build.
- Gates: backend 872 passed, 1 failed (test_openfema_parse.py, us-pipeline's file); role set 351 passed. Web:
  typecheck 0, lint 55 (all in src/scene), vitest 67 files / 1078 passed, build ok. API 8711: 0 non-GET requests.

## Next
- Done; waiting for re-review.

## Decisions
- §14.1 before-validator implemented as an after-validator using model_fields_set (a before-validator breaks strict
  JSON tuple checks for bbox_lonlat). Same effect. Recorded in contract3/us-catalog.md "Deviations".

## Open problems
- (resolved: tests/test_official_calfire.py now passes at HEAD.)
- tests/test_official_nws.py::test_endpoint_live_alert_near_a_fire fails in the shared tree with us-pipeline's
  uncommitted nws.py/official.py/test_official_nws.py edits (not my files); rerun after their next commit.
