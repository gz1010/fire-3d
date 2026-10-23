# brief3-us-web progress

Role: us-web (API 8712, Vite 5182). Scratch: /tmp/claude-0/-home-user-fire-3d/46b23942-68f3-578a-a513-ea699dabb6b6/scratchpad/us-web/

## Done
- Read BRIEF-3, PLAN-3, CONTRACT §14, plan3-roles us-web entry, audit-3/web.md.
- Baseline screenshots from HEAD 9aa4c87 (before any code change): docs/screenshots/brief3-us-web-baseline-{eaton-command,palisades-command,eaton-forensic}-desktop.png (1440x900); scratch: baseline-eaton-public-desktop.png, baseline-overview-public-desktop.png.
- M1: lib/time.ts new API + deprecated shims (old==new equivalence run), time.test.ts, state/timeZone.ts (+usePlaceZone), timeZone.test.ts, scripts/check-time-api.mjs (+ .d.mts, lib/checkTimeApi.test.ts). Gates: tsc 0, lint 55 (all scene), tests 60 files / 760 passed.

- M2: national overview (frame, wording, 3 sources + clusters, labels, hidden data, legend, in-view list, peek, sources notices, Menus). Scratch injection script inject/national.mjs (1,334 recorded WFIGS points) shows 14 active + 40 other groups at z3.58; NW z5.6 readable; phone z2.09. Gates: tsc 0, lint 55, tests 61 files / 793, build OK.

- M3: time migration (0 and 0 with --role us-web; checker skips lib/time.test.ts too), zone lines, DataCredits local year, geo lookup hook (coverage notice, place zone) early from M5. Eaton Command after M3 = baseline strings.

- M4: FireCard records (recordBlocks, complexes, id line, own zone), accuracy store + templates + card label, skill table relabel, credits. Tests: FireCard.test.ts (9), accuracy.test.ts (8).

## Next
- M5 search (usStates, search.ts, SearchBox, geocodeClient, types), geodesy lat/lon order.

## Decisions
- fmtAt/fmtDayDate default year 'never' (keeps CA strings).
- usePlaceZone store feeds 'place' zone source.
- Small active dot radius 2.5 px.
- SSR tests: ui/ssr.testutil.ts sets zustand initial state (server snapshot).

## Open problems
