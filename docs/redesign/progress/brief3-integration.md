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

# part2 (integration part 2 of 2), 2026-10-23 from ~14:45 UTC

Ports API 8716, Vite 5186. Scratch: session scratchpad `integration2/`. Only agent editing the repo; may edit any file
(never data/, no builds, never press "Prepare analysis").

## Done
- 14:50Z read part 1 report/progress, orchestrator carry-over, validation report and review leftovers.
- Baseline gates: backend 988 passed; web typecheck 0, lint 55 (scene), 75 files 1173 passed 2 skipped.
- f29c291 backend: ListsUnavailable -> 503 "The fire lists could not be reached right now; try again later." (gate,
  build, incident, record, extras); Lucas same-name records -> one record (largest, then newest); deprecated names
  removed (load_live_ca/load_year_ca, HISTORICAL_YEAR, spec_incident_id; la_time -> fire_local_time); INTERIM_LFM
  warning text (legacy text removed on rebuild); AccuracyFire.growth_ratio_median + regional file regenerated (15 values
  added only). Backend 990 passed.
- 95545c0 web: feed/panel one time (localFeedMs, sentAfterRef, afterSpan minute-cut, "less than a minute"); accuracy
  wording (outcome words in Public's first view, region named, fires named behind the tap, two decimals, fuel caveat,
  Command "of 1"/region/ratio by fire/GSI); analysis line without a model run; 503 wording. Web 1183 passed.
- rasters.test.ts carry-over: already done (three tests present, lines 316/331/350).

## Next
- Docs: CONTRACT §14.4/§14.12.10 fold of contract3/validation.md + wording amendment, §14.2 503/same-name, §14.7 feed
  time; SPEC §8.4 GSI + interim text, build gate 503, AccuracyFire; validation.md 10.11 6 days.
- Verify end to end (screenshots brief3-final-*), gates, report part2_done.


## Decisions (part 2)
- An outage is "cannot tell now": resolve_listed raises ListsUnavailable when no answering list knows the id and a
  lookup failed; get_summary still answers from a bundle on disk; every API path answers 503 with one sentence.
- Same-name records: the largest reported size, then the newest, is the fire's record; every record stays listed.
- Feed vs panels: the replay feed lists a local message from the minute after it was sent (its seekMs), so the feed
  and the minute-quantised panels agree; the rest of the feed keeps the exact time (seeking to an item keeps it listed).
- Accuracy: Public's first view adds an outcome sentence in words (direction of the growth error from each fire's own
  ratio; no number); the score stays one tap away (round 2 decision 7 kept); Public's detail uses two decimals like
  Command (no 0.05 rounding: the fires' own scores are named next to it).

## Open problems (part 2)

