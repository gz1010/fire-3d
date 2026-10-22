# brief3-audit-web-us progress

## Done
- read brief 3, CONTRACT §13 (shell/map/location), evacuations audit
- grep counts: 418 CA-specific lines in web/src non-test (scratchpad ca_src.txt)
- servers up (API 8712 FIRE3D_LIVE=0, Vite 5182); 10 screenshots taken and viewed (overview, fire card, Boise location card, search Boise/83702, official panels)
- found: phone search message hidden under map controls (audit3-web-search-zip-phone.png)

- national density check: WFIGS count-only 2026 YTD WF>=300 ac = 1,204 (lower 48: 1,178; CA 69); 2025 = 984; 1,178 real points injected into the store -> audit3-web-national-1178-*.png
- time: 214 formatting call sites in 43 files; laWallToMs hard-codes PDT/PST offsets (time.ts:183-195)
- 0 non-GET requests in browser runs (API log: 105 GET)

## Next
- write docs/redesign/audit-3/web.md, report JSON, commit; kill servers

## Decisions
- Stage A is read-only: no code changes, gates skipped.

## Open problems
- none yet
