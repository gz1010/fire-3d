# brief3-us-web progress

Role: us-web (API 8712, Vite 5182). Scratch: /tmp/claude-0/-home-user-fire-3d/46b23942-68f3-578a-a513-ea699dabb6b6/scratchpad/us-web/

## Done
- Read BRIEF-3, PLAN-3, CONTRACT §14, plan3-roles us-web entry, audit-3/web.md.
- Baseline screenshots from HEAD 9aa4c87 (before any code change): docs/screenshots/brief3-us-web-baseline-{eaton-command,palisades-command,eaton-forensic}-desktop.png (1440x900); scratch: baseline-eaton-public-desktop.png, baseline-overview-public-desktop.png.
- M1: lib/time.ts new API + deprecated shims (old==new equivalence run), time.test.ts, state/timeZone.ts (+usePlaceZone), timeZone.test.ts, scripts/check-time-api.mjs (+ .d.mts, lib/checkTimeApi.test.ts). Gates: tsc 0, lint 55 (all scene), tests 60 files / 760 passed.

## Next
- M2 national overview.

## Decisions

## Open problems
