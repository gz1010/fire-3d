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
- Questions Q1-Q5: answered by BRIEF-3 round 2 (no open user questions).
- laWallToMs hard-codes PDT/PST offsets: a TZ swap alone breaks ticks.

## Revision pass (critic review), started 2026-10-22
- Done: read BRIEF-3 round-2 decisions (they answer Q1-Q5: mixed clock, active-only groups, list in view, lower-48
  phone view, cameras CA-only, all 245 active fires listed). Verified critic code claims (client.ts/runtime/hooks/types
  CAL FIRE path, GOES-West labels, geodesy lon/lat order: "-84.39, 33.75" -> 84.39 S, mapLayer statewide NWS outlines,
  shared overview source, 100-ac switch, index.html, DataCredits UTC year, FireList querySelector nav, camera strings).
- Done: WFIGS count-only re-check: 2025 >= 300 ac lower 48 = 861 (38 states; 984 incl. AK 122, HI 1); 2026 YTD lower
  48 = 1,178 (35 states); 2025 >= 100 ac lower 48 = 1,664; Current active lower 48 = 245 (113 <= 1 ac, 43 unknown).
- Done: servers API 8714 / Vite 5184 (FIRE3D_LIVE=0), 51 API GETs, 0 non-GET; stopped. Injection with real WFIGS
  actives (176 non-CA + 3 CAL FIRE) and 1,109 non-CA 2026 rows (CA from CAL FIRE only, no duplicates): 42 labels,
  11 on fires < 10 ac, 12 of 74 fires >= 20,000 ac. Browser-only clustering prototype (3 sources: pinned >= 5,000 ac
  active, clustered active, clustered other): 48 marks at the national view. Screenshots audit3-web-national-active-*,
  -cluster-*, -cluster-nw-desktop (all viewed). /api/incidents ~590 B/row, gzip 20 %, not gzipped today.
- Done: rewrote web.md (corrections, G16-G19, 3.2 three-source design + options table, 3.3 list/payload/100-ac,
  3.4 national official wording, 3.5 record fetch, W1-W16 re-prioritised, section 4 = round-2 answers + planner
  defaults, section 6 revision notes); report JSON has a "revision" key; committed.
- Next: none (revision pass done).
