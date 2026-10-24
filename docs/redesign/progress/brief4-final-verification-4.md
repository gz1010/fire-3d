# Brief 4 H6: final check (progress)

Ports: API 8739, Vite 5199.

- [x] 1. git status clean (nothing of the build left uncommitted at bf3e79c)
- [x] 2. gates: typecheck ok, lint 55 (all src/scene), web 1383 passed + 2 skipped, build ok; backend 1009 passed. Root cause of test_health_lists_status_and_errors found and fixed in the test setup (see notes)
- [x] 3. final screenshots: 14 in docs/screenshots/brief4-final-*.png, all viewed (phone fire view re-taken after the date fix)
- [x] 4. smoke (scratch smoke.mjs): rotation 56/56 (55 in one run + Forensic re-run 11/11 with a tilt wait), reduced motion 27/27, fixed copy / safety words / console errors 56/56 on 14 views
- [x] 5. count-only scans: FIRMS key 0 in 1372 tracked files, 0 in f318347..HEAD diffs and messages; FireTrace 0 in code/UI; safe / low risk 0 in new UI copy
- [x] 6. README: brief-4 screenshots, 'The three views at a glance', old-look lines corrected, design docs listed
- [x] 7. CONTRACT 15.5 "Final check — as built" filled
- [x] 8. report final-verification-4.json; commit + push

## Notes
- Start: working tree clean at bf3e79c.
- Backend test: the module fixture `client` of tests/test_endpoint_contracts.py did not isolate CACHE_DIR, so the
  unknown id's answer depended on the developer's data/cache: with a fresh live list (10 min TTL, refreshed by any dev
  server) and the cached WFIGS `IrwinID LIKE '{000000%'` answer older than its 24 h TTL, the lookup hit the blocked
  transport, `resolve_listed` counted it as failed and the API answered 503 (lists unavailable), not 404. Reproduced
  (503) right after my API fetched the live list; fixed by an empty temp CACHE_DIR + `catalog.clear_cache()` in the
  fixture; the suite passes with a fresh live cache (1009 passed).
- Screenshots 1-12 taken and viewed; phone fire view's date line broke inside "DEC 15 2025": fixed (FireTitle.tsx
  `keepDatesWhole`, `.pfv-date-day` nowrap).
- Map compass needle: removed its 80 ms CSS transition (map/map.css), which spun it the long way across ±180° (H5's
  known issue); smoke checks transition-duration 0s in four map views.
- Smoke-script lessons (SwiftShader): poll for the expected heading instead of fixed sleeps; Forensic camera info and
  the 3D tilt can lag several seconds; press the compass inside its own box before dragging around it.
- Servers 8739 / 5199 stopped at the end.
