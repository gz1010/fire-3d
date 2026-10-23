# brief3-us-official progress

Role: us-official (API 8713, Vite 5183). Scratch: /tmp/claude-0/-home-user-fire-3d/46b23942-68f3-578a-a513-ea699dabb6b6/scratchpad/us-official/
Started 2026-10-23 ~01:45 UTC (late start; us-catalog finished, us-web past M5, us-pipeline past M4).

## Done
- Read BRIEF-3, plan3-roles us-official entry, CONTRACT §14.0, 14.5-14.9, 14.13-14.15, us-web as-built note.

- M1 committed (8ac1154): shims + 'not-available'. Web gates: tc 0, lint 55 (scene), 65 files / 1024 tests.
- M2: sources/evacuations.py (registry, CA/OR adapters, status fix, dedup), extras.py route + cameras, Oregon sample
  recorded (12 zones), CA brief-2 expected answers, tests/test_evacuations_sources.py. pytest 870 passed.

- M2 committed c56947e. M3: web evacuations source-neutral (see contract3 note); NWS checked from states_checked;
  point state from geo lookup. Web gates: tc 0, lint 55, 65 files / 1055 tests, build OK. (Orchestrator checkpoint
  commits picked up most M3 files before my M3 commit.)
- Orchestrator relay (us-pipeline finished): fix data status PDT for Horse Gulch (M6), the repeated not-available
  text (done M3), WFIGS record card (M4), OpenFEMA notice on archived alerts (M5). Check on 2024-horse-gulch-889237.

## Next
- M4 records (recordUrl, useRecord, record model, Official now row, complex, synthetic, feed kind 'record').

## Decisions
- State check before the past-date check (a Nevada replay says not available, not 'past dates').
- Negation statuses map to 'other' and are dropped as placeholders; null Cal OES status stays 'unknown' (CA unchanged).

## Open problems
