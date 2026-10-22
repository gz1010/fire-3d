# Brief 3 restore: backend/tests/data/firedata

Owner: restore-firedata agent (2026-10-22). Status: done.

- [x] Read the 5 test files and the modules under test; derived what each sample must contain.
- [x] Recorded real CAL FIRE lists (2025, 2026), FIRMS area-API samples (NOAA-20 SP, MODIS SP, GOES, Landsat, Kilauea), keyless 24h feeds (SNPP, MODIS) and the WFIGS daily layer's field list.
- [x] Recording script backend/scripts/record_test_samples_firedata.py writes the trimmed samples (re-run gave identical files).
- [x] backend/tests/data/firedata/PROVENANCE.md (sources, dates, trimming, real vs reconstructed vs synthetic).
- [x] 5 target test files: 93 passed. Full backend suite (--continue-on-collection-errors): 562 passed, 2 failed, 1 collection error; all three need other folders (tests/data/terrain, tests/data/official).
- [x] Count-only key scan: 0 files contain FIRMS_MAP_KEY.
- [x] Report docs/redesign/reports/brief3-restore-firedata.json; committed.

No test was edited.
