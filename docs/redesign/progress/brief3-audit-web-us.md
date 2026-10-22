# brief3-audit-web-us progress

## Done
- Read brief 3, CONTRACT §13 (shell/map/location/integration), evacuations audit, brief-2 map report.
- Greps: 418 CA-specific non-test lines in web/src (160 code, 197 comments, 61 fixture/dev); 214 time calls in 43 files.
- Servers (API 8712 FIRE3D_LIVE=0, Vite 5182): 12 screenshots taken and viewed; 105 API requests, 0 non-GET; servers stopped.
- WFIGS count-only: 2026 YTD WF >= 300 ac lower 48 = 1,178 (CA 69); 2025 = 984. 1,178 real points injected in the
  browser store -> audit3-web-national-1178-*.png (phone blob).
- Wrote docs/redesign/audit-3/web.md (265 lines), report docs/redesign/reports/brief3-audit-web-us.json; committed.

## Next
- none (stage A done for this role)

## Decisions
- Stage A is read-only: no code changes, gates skipped.
- Recommended: one tz-parameterised formatter in lib/time.ts (tz required), backend time_zone/state fields,
  two clustered MapLibre sources (active/other), list "in this view" with windowing.

## Open problems
- Questions Q1-Q5 for the user (clock style, active clusters, list scope, phone view, cameras).
- laWallToMs hard-codes PDT/PST offsets: a TZ swap alone breaks ticks.
