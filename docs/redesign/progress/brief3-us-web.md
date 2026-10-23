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

- M6 cut line, all six: (a) RegionAccuracy in the Analysis drawer and Forensic Analysis tab, (b) W11 windowing (overview list and incident picker, ui/useListWindow.ts), (c) W15 phone fixes, (d) rasters carry-over (RasterSetLoader), (e) W14 reprojection zones 10-19 + fixture-east, (f) location card accuracy line.
- Late: tf passed to every us-official shim call site; overview official block cap and single list-absence line; AK/HI nearest-fires line; partOfComplex; ZIP titles; national search examples (orchestrator relay); Horse Gulch (MT) Public/Command screenshots.
- Gates (final): tsc 0; lint 55 (all src/scene); vitest 65 files, 1,055 passed, 2 skipped; build OK; backend 870 passed; check-time-api --role us-web 0/0; 0 non-GET in api.log..api4.log; key scan 0.

## Next
- Report JSON, then hand back.

## Decisions
- fmtAt/fmtDayDate default year 'never' (keeps CA strings).
- usePlaceZone store feeds 'place' zone source.
- Small active dot radius 2.5 px.
- SSR tests: ui/ssr.testutil.ts sets zustand initial state (server snapshot).

## Open problems
- (resolved) Georgia/Alaska points showed "No evacuation order or warning listed here · Cal OES" while my API ran pre-us-official-M2 backend code; after restarting the API the card says "Evacuation zones: not available in this state" (Georgia) / "not available here" (Alaska).
- us-official panels still print fire-weather and data-status times in PDT for a Montana fire (Horse Gulch shots): their files.

## Review fixes round 1 (2026-10-23)
- Start: no uncommitted us-web changes and no earlier fix commit (clean restart).
- R1 fire card record status from the record's own agency (recordStatus), hover via map/hoverText.ts with the other record on its own line; status cell wraps. R2 zone hover names the source from sources[] (Cal OES / Oregon OEM). R3 skill-table note under the table when the header is short. R4 urlLabel link labels. R5 NWCG and TIGERweb/NTAD credits next to the data. R6 dev page meta. R7 narrow-map labels grow inward below z3 (the reviewer's 'right first' would have made it worse: 'right' puts text left of the point).
- Gates: backend 880 passed; tsc 0; lint 55 (all src/scene); vitest 72 files, 1,107 passed, 2 skipped; build OK; check-time-api 0/0; 0 non-GET; key scan 0.
- Screenshots: docs/screenshots/brief3-us-web-fix1-*.png (8), each viewed.
