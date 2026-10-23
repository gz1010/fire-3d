# brief3-restore-web progress log

Task: recreate web/src/data/rasters.ts and rasters.test.ts (never committed because of the old unanchored `data/`
ignore rule). Ports: API 8711, Vite 5181.

## Log
- Read CONTRACT §2, §5.2, §10, §11 and the later raster mentions (§13 map), lib/raster.ts, api/client.ts,
  api/types.ts, SPEC 4.1-4.3 and 5.1, the store, lib/reproject.ts, every importer and its tests, the foundation /
  map-core / location progress logs and the reports.
- Wrote web/src/data/rasters.ts (CONTRACT §10 API exactly) and rasters.test.ts (26 tests). Mutation check: 12
  deliberate bugs in rasters.ts (NEVER boundary, edge rule, LRU limit/touch, failure caching, forecast mismatch,
  nodata, time origin, clear match, forecast version, key ordering, cached-set completeness) are all caught.
- Gates: typecheck 0; lint 55 warnings, all src/scene; vitest 56 files, 694 passed + 2 skipped (real-bundle tests
  that need Eaton forecasts / Norte, absent in this clone); build OK, main chunk 440 kB with 0 WebGLRenderer.
- Browser (API 8711 FIRE3D_LIVE=0, Vite 5181, SwiftShader): fixture-demo at t = forecast start + 12 h.
  restore-rasters-1.png: observed fire and modeled spread drawn from the CPU rasters (mapController.loadRasterSet).
  restore-rasters-2.png (Command, ?sel=34.19065,-118.10162): card "39% · 12 of 31 model runs ... by Aug 18, 14:00
  PDT (72 h)", "Arrival P10 Aug 17, 12:24 PDT · P50 not reached · P90 not reached"; the raw files at that pixel
  (r 233, c 102) hold burn_probability 0.3871 (= 12/31), arrival_p10 71.408 h (= Aug 17 12:24 PDT from the
  forecast's time origin), p50 / p90 NEVER. 0 console errors, 0 page errors. Servers stopped.
- Count-only key scan of my files and scratch: 0 of 15 contain the key.

## Done
- All gates pass; report written to docs/redesign/reports/brief3-restore-web.json; files committed.
