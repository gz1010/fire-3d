# Brief 4 H6: final check (progress)

Ports: API 8739, Vite 5199.

- [x] 1. git status clean (nothing of the build left uncommitted at bf3e79c)
- [x] 2. gates: typecheck ok, lint 55 (all src/scene), web 1383 passed + 2 skipped, build ok; backend 1009 passed. Root cause of test_health_lists_status_and_errors found and fixed in the test setup (see notes)
- [ ] 3. final screenshots
- [ ] 4. scratch Playwright smoke (rotation, reduced motion, fixed copy, console errors)
- [x] 5. count-only scans: FIRMS key 0 in 1372 tracked files, 0 in f318347..HEAD diffs and messages; FireTrace 0 in code/UI; safe / low risk 0 in new UI copy
- [ ] 6. README UI + screenshots section
- [ ] 7. CONTRACT 15.5 "Final check — as built"
- [ ] 8. report final-verification-4.json, commit, push

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
