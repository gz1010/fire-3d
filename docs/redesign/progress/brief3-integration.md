# brief 3 integration (part 1 of 2): progress

Role `integration` part 1. Ports: API 8715, Vite 5185. Scratch: session scratchpad `integration/`.
Not mine (validation's): backend/fire3d/spread/**, build/**, sources/{weather,landfire,perimeters,terrain,firms}.py,
config.py, catalog.py, cli.py, types.py, data/regional_accuracy.json, docs/validation.md, contract3/validation.md,
validation's progress/report, tests that test only those.

## Done
- 06:35Z read the reports, reviews, fix rounds, orchestrator carry-over, PLAN-3 checklist.
- Baseline gates: web 72 files 1111 passed 2 skipped, lint 55 (scene), typecheck 0; backend 918 passed, 1 failed
  (test_api fallback test: data/incidents held a bundle validation was building, status error/building).
- 6072b83 time API cleanup: tf required at the 14.9.6 shims; deprecated lib/time names, insideCalifornia,
  NOT_FIRE_SPECIFIC, fmtStatusTime, topic 'calfire', useCalfire removed; check-time-api 0/0 on web/src.
- f861621 (+ orchestrator checkpoints a9ec7b2, 1a51563, 8bf42a8 that captured my edits): (R) fields required in
  contracts.py (LiveStatus.detections_24h, IncidentListResponse.sources, FireWeatherResponse.states_checked /
  alert_states, FireWeatherAlert.time_zone; IncidentSummary five fields always dumped, WFIGS issuer filled), TS
  api/types.ts, official/types.ts, extras/types.ts (EvacSource, states, zone props); parity test extended to
  official shapes; test_api build-gate texts + robust fallback test.
- 3021449 N2 backend (local alerts outside the lower 48: state_not_available, not_checked) and N3 (box answer lists
  every message at the point).

- 5c3085c credits TIGERweb / NTAD / NWCG in an open fire's data sources; rasters.test.ts carry-over already done by
  us-web (three tests present).
- 7955e6b SPEC (required fields, local alerts outside the lower 48, MultiPolygon, daily re-check, prefetch).
- 991e780 removed fill_from_calfire and overpass.la_time.
- c4f1175 CONTRACT §14 "14.x as built" fold-in + §14.5/§14.7/§14.12.2 fixes; Public summary keeps the year of a past
  record's update time.
- Screenshots batch 1 (overview x6) and 2 (fires x10) taken and viewed; wording scan 48 hits, all justified; key scan
  0 (scratch logs, my commits, tracked files).

- Batch 3 screenshots, keyboard and reduced-motion checks; two bugs found and fixed: 9ed18c0 (an unprepared fire's
  card no longer loses to a nearby prepared fire's zoom focus), b6c90a4 (past time in a state without a feed:
  'not available in this state' on the location card); cf98ab1 CONTRACT notes for both.
- Final gates: backend 956 passed; web typecheck 0, lint 55 (scene only), 73 files 1116 passed 2 skipped, build OK;
  check-time-api 0/0; wording scan 48 hits all justified; key scan 0; API log 674 GET, 0 non-GET.
- Report docs/redesign/reports/brief3-integration.json (with `part2`); servers 8715/5185 stopped.

## Next
- Part 2 (after validation): see the report's `part2` list.

## Decisions
- IncidentSummary (R) fields keep a Python default (old manifests are filled on read) but are always dumped; TS
  requires them; the parity test has a FILLED_ON_READ exception. SkillEntry.growth_sorensen stays optional (old
  forecast manifests lack it).
- Brief-2 official TS leniency kept for envelope kind / incident_id / caveats (parity test ENVELOPE_LENIENT).
- Location card: the point's own live box answer lists all its messages (they are not in Updates).
- §14.12.2: the hourly re-check of a daily Open-Meteo block is accepted and written into the contract.
- Emigrant is in Oregon (America/Los_Angeles, UTM 10), not Montana as the task list said.

## Open problems
- Startup race: a search answered before the map controller exists is dropped (mapController.ts:286); minor.
- Forensic screenshots time out under swiftshader here (not a functional finding).
