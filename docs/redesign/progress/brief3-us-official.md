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

- M3 committed 1c14914. M4: records (record.ts, recordUrl/secondaryRecordUrl, runtime record query, useRecord,
  RecordRow, feed topic 'record', summary/data status labels). Gates: tc 0, lint 55, 66 files / 1067, build OK.
- Orchestrator relay (us-web finished): migrate remaining time calls (OfficialNow, officialSummary, dataStatus,
  calfire.ts:192, fireWeather.ts:178-184) in M6; Official now header must follow states_checked ("lower 48
  states") in M5; restart API after backend commits before screenshots.

- M4 committed 4dcb81b. M5: national NWS wording, alert zones, local alerts (types, model, card lines, Official now row,
  feed), dev preset us-official (screenshot docs/screenshots/brief3-us-official-dev-preset-desktop.png, 0 non-GET).
  Gates: tc 0, lint 55, 67 files / 1077, build OK. Servers: API 8713 + Vite 5183 running (kill before finishing).

- M5 committed f6ddb54. Container restarted ~02:50 UTC (servers gone). M6: time migration done, checker 0/0,
  zone lines; gates tc 0, lint 55, 67 files / 1078, build OK.

- M6 committed 77291ab. Screenshots taken and viewed (dev preset, overview, Reno, Brookings phone, fixture-east,
  cameras non-CA, Eaton Command, Horse Gulch Command/Public); 0 non-GET (239 GET). Cut line (a) W12 and (b) W13 done.
  Final gates: tc 0, lint 55 (scene), 67 files / 1079, build OK, pytest 878, check-time-api 0/0.

## Next
- Write the report (docs/redesign/reports/brief3-us-official.json), commit, kill servers, hand back.

## Decisions
- State check before the past-date check (a Nevada replay says not available, not 'past dates').
- Negation statuses map to 'other' and are dropped as placeholders; null Cal OES status stays 'unknown' (CA unchanged).

## Open problems
