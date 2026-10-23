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

## Next
1. Baseline gates.
2. Code: credits when a fire is open (NWCG / NTAD), rasters.test.ts check, minor review notes.
3. Docs: CONTRACT §14 "as built" fold-in + contract fixes; SPEC lag.
4. Verification screenshots; gates; report with part2 list.

## Decisions
- IncidentSummary (R) fields keep a Python default (old manifests are filled on read) but are always dumped; TS
  requires them; the parity test has a FILLED_ON_READ exception. SkillEntry.growth_sorensen stays optional (old
  forecast manifests lack it).
- Brief-2 official TS leniency kept for envelope kind / incident_id / caveats (parity test ENVELOPE_LENIENT).
- Location card: the point's own live box answer lists all its messages (they are not in Updates).

## Open problems
