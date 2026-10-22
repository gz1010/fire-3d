# Brief 3 restore: backend/tests/data/official and backend/tests/data/terrain

Owner: restore-official agent (2026-10-22). Status: done.

- [x] Read test_official_nws.py, test_terrain_sentinel.py and test_official_real_bundles.py, and the modules they
  test: sources/nws.py, sources/sentinel.py and api/official.py. Worked out what each sample must contain.
  test_official_real_bundles reads no recorded samples; it uses data/incidents read-only.
- [x] api.weather.gov still serves the real Oct 17 2026 09:11 PDT LOX Red Flag Warning messages (FW.W #5 CON,
  .002.1 and .001.1), so nothing was rebuilt from IEM.
  - Today's California answer was really empty.
  - Two values were set by hand, both collection `updated` stamps: Oct 17 16:20 UTC for the LOX file, and Oct 18
    16:09:10 UTC (the original recording's value, which a test asserts) for the empty file.
- [x] IEM:
  - the Eaton bypoint answer, unchanged;
  - LOX FW.W/FW.A #1 and #2 of 2025, with the per-zone rows unchanged and a few products kept;
  - FW.W #1's polygons, simplified to about 100 m with the MultiPolygon type kept.
- [x] Earth Search: the STAC item S2A_11SLT_20250102_0_L2A, unchanged.
- [x] Recording script backend/scripts/record_test_samples_official.py: about 15 polite requests through fire3d.http,
  with its cache outside data/. It checks each sample before writing. A second run from the cache gave identical
  files, and ruff reports no problems.
- [x] PROVENANCE.md in both folders: sources, recording date, trimming, and which values are real and which were set.
- [x] Target tests, unchanged:
  - test_official_nws: 21 passed;
  - test_terrain_sentinel: 15 passed;
  - test_official_real_bundles: 4 passed.
- [x] Full backend suite: 585 passed, 0 failed, 0 errors.
- [x] Count-only key scan of backend/tests/data and the script: 22 files, 0 contain FIRMS_MAP_KEY.
- [x] Report docs/redesign/reports/brief3-restore-official.json; committed.

No test was edited. data/ was not touched.
