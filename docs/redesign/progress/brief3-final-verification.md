# Brief 3 final verification: progress

Role: final-verification (API 8718, Vite 5188; the only agent editing). 2026-10-23, about 15:30-17:40 UTC.

## Done
- Read BRIEF-3, CONTRACT §14, PLAN-3, RUNBOOK-3, brief3-integration.json and the panel's 13 findings.
- Panel findings: all 13 verified against the code (and several reproduced); every blocker, major and minor fixed with
  tests (commits 6b65a82 backend, 631737c web, bef4a52 orchestrator checkpoint of follow-ups).
  - SR-B1 / F4: both lists down -> one notice, no "list no active fires", peek "Fire lists unavailable right now";
    synthetic bundles and failed builds never listed; Forensic banner names the replay's year.
  - SR-M1 / F2: `ListSource.stale` + "checked/fetched" from `retrieved_ms`; stale notice; peek "not refreshed (N ago)".
  - SR-M2 / F1: `fire3d.http.DownMemo` (60 s), list requests 5 s connect / 12 s read / <= 1 retry, CAL FIRE, WFIGS
    and the FIRMS feeds side by side, degraded lists rebuilt after 60 s. Total outage: prepared fire 2.1 s
    (was 273 s), listed fire without bundle 503 in 0.01 s, lists 0.01-0.4 s.
  - F5 at_ms <= 2100 (422); F6 fallback year; SR-m1 "Unavailable right now"; SR-m2 active_incidents null;
    SR-m3 region files 503; SR-m4 hectares in lists; F7 "Unknown, not low."; F3 README.
- One live-loop cycle (FIRE3D_LIVE=1, interval 7200 s so only one ran): 228 active fires in 23 states; auto-build
  candidates (cap 4, national): Bee Haven 2-24-06 FL, Border 2 WA, West Fork WA, Garda Falls WA. All 4 refused by
  Open-Meteo's daily limit on this shared IP (16:52 UTC; weather-probe said ok at 16:51). The quota path held: 1
  request reached the limit, the next 3 were refused without requests.
- One "Prepare analysis" press (Sand Creek, MT, from its card): 1 POST, refused at once with the quota message.
- Official records nationally: WFIGS records for WA (NPS), FL (DVF), MT (USFS) and CA (Timber) with their own zones;
  CAL FIRE history recorded (Cooley 74 -> 80 %); WFIGS change history deferred (changes [] + caveat).
- Endpoint walk: 102 GET paths, 0 contract problems, 0 answers with the key, no 5xx, none over 10 s.
- Count-only key scan: 7,833 files (repo, docs, data/official, bundles, scratchpad) 0 hits; git history 0 commits.
- Wording scan (added lines since 1c500b1): only identifiers and negations; check-time-api 0 / 0.
- Outage screenshots (harness on 8718): lists down, NIFC stale, official sources down; 9 copied to
  docs/screenshots/final3-*.png, each viewed.
- README rewritten for the lower 48 (coverage, sources and licences, limitations, 12-fire summary); SPEC rows;
  CONTRACT §14.16.
- Gates: pytest 1004 passed; web typecheck 0, lint 55 (all src/scene), vitest 76 files 1197 passed 2 skipped, build OK.

## Decisions
- Both lists down keeps HTTP 200 with the prepared fires (clearly labelled) rather than 503, so prepared fires stay
  reachable during an outage (panel suggested considering 503).
- Removed 4 empty build dirs (lock file only) left by the refused builds; kept Bee Haven's failed bundle (honest
  error state, "Prepare analysis again").

## Open problems
- No new fire could be prepared in this session (Open-Meteo daily limit on the shared cloud IP).
- A host that accepts connections but never answers costs about 25 s once (12 s read timeout, one retry on a cold
  cache), then 60 s of instant answers; refusals and HTTP errors answer in seconds. Not measured against a real hung
  host (unit test with a simulated read timeout).
- Frame rates not measurable here (no GPU).
