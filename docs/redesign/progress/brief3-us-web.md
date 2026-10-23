# brief3-us-web progress

Role: us-web (API 8712, Vite 5182). Scratch: /tmp/claude-0/-home-user-fire-3d/46b23942-68f3-578a-a513-ea699dabb6b6/scratchpad/us-web/

## Done
- Read BRIEF-3, PLAN-3, CONTRACT §14, plan3-roles us-web entry, audit-3/web.md.
- Baseline screenshots from HEAD 9aa4c87 (before any code change): docs/screenshots/brief3-us-web-baseline-{eaton-command,palisades-command,eaton-forensic}-desktop.png (1440x900); scratch: baseline-eaton-public-desktop.png, baseline-overview-public-desktop.png.
- M1: lib/time.ts new API + deprecated shims (old==new equivalence run), time.test.ts, state/timeZone.ts (+usePlaceZone), timeZone.test.ts, scripts/check-time-api.mjs (+ .d.mts, lib/checkTimeApi.test.ts). Gates: tsc 0, lint 55 (all scene), tests 60 files / 760 passed.

- M2: national overview (frame, wording, 3 sources + clusters, labels, hidden data, legend, in-view list, peek, sources notices, Menus). Scratch injection script inject/national.mjs (1,334 recorded WFIGS points) shows 14 active + 40 other groups at z3.58; NW z5.6 readable; phone z2.09. Gates: tsc 0, lint 55, tests 61 files / 793, build OK.

- M3: time migration (0 and 0 with --role us-web; checker skips lib/time.test.ts too), zone lines, DataCredits local year, geo lookup hook (coverage notice, place zone) early from M5. Eaton Command after M3 = baseline strings.

- M4: FireCard records (recordBlocks, complexes, id line, own zone), accuracy store + templates + card label, skill table relabel, credits. Tests: FireCard.test.ts (9), accuracy.test.ts (8).

- M5: national search (usStates, search, SearchBox, geocodeClient, types), W8 geodesy order, coverage (done in M3). Accuracy seed check: exact §14.4 OSCC lines from the real seed (seed rule for "starts during main growth").

- Screenshots: all 18 named in plan3-roles taken and viewed (docs/screenshots/brief3-us-web-*.png).

- M6 cut line: (a) RegionAccuracy in the Analysis drawer and Forensic Analysis tab, (c) W15 phone fixes, (d) rasters carry-over (RasterSetLoader), (e) W14 reprojection zones 10-19 + fixture-east, (f) location card accuracy line. Not done: (b) W11 windowing.
- Late: tf passed to every us-official shim call site; overview official block cap and single list-absence line; AK/HI nearest-fires line; partOfComplex; ZIP titles.
- Gates (final): tsc 0; lint 55 (all src/scene); vitest 1,028 passed, 2 skipped, 3 failed (all in us-official's uncommitted files: extras/evacuation.test.ts, official/model.test.ts); build OK; backend 870 passed; check-time-api --role us-web 0/0; 0 non-GET in api.log/api2.log/api3.log; key scan 0.

## Next
- Report JSON, then hand back.

## Decisions
- fmtAt/fmtDayDate default year 'never' (keeps CA strings).
- usePlaceZone store feeds 'place' zone source.
- Small active dot radius 2.5 px.
- SSR tests: ui/ssr.testutil.ts sets zustand initial state (server snapshot).

## Open problems
- us-official's uncommitted official/model.ts (at 02:10 UTC) shows "No evacuation order or warning listed here · Cal OES" for points in Georgia and Alaska (search-atlanta and location-anchorage screenshots); §14.14 wants "Evacuation zones: not available in this state". Their file: listed for the integrator.
- W11 windowing not done.
