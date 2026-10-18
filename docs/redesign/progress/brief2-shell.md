# brief2-shell progress log

Role: b2-shell (files: shell). API 8712, Vite 5182. Owns web/src/App.tsx, web/src/ui/shell/**, web/src/styles/**,
web/src/state/**, web/src/api/**, web/src/ui/IncidentPicker.tsx, web/index.html; for O-R7 also the new
web/src/scene/overlays/SelectionPin.tsx plus minimal mount / click lines.

## Done (2026-10-18)
- Read BRIEF-2, PLAN-2, the three audits, CONTRACT, owned files. CONTRACT §13 "Brief 2 interfaces" created early with
  the shell sub-heading (I1 names, lists, filter, fire card, history, basemap, strip variant); rewritten as built.
- State: closeIncident, missingIncidentId (404 -> overview), per-list catalog (state/catalog.ts: live, season 2026,
  historical 2025), autoBuild default off + explicit-only builds, incidentSource, focusIncidentFromMap (decision 10:
  300 ms debounce, ready fires only, no build / framing / push, latest-observation time, Play from start, 4-fire
  cache), workspace fireCardId / overviewFilter / basemap pick + fallback + preset default / MapFlyTo.source,
  view + selection kept on zoom, returnToIncident -> map frameFire; state/overview.ts (overviewFires, preparedFires,
  findFire, fireStatus, analysisState, newestRecordMs, fireFlyTo); state/history.ts (push explicit, replace zoom and
  404, popstate applies incident / t / ws); runtime: no default pick, live list refresh on the overview.
- UI: App (parallel bootstrap, overview layout, fire card slot, Escape, not-prepared notice, pin above the phone
  sheet, credits fold), MapHeader (California · all fires / ← All fires, one Public · Command · Forensic switch,
  Updates label + badge, satellite chip in the bar >= 1024 px), OverviewPanel (+ California OfficialNow, peek sheet,
  missing-link notice), FireCard, fireActions, IncidentPicker (3 lists, no build on pick), UpdatesPanel (one scroll
  area, OfficialNow, Command data status with Cal OES / NWS / CAL FIRE rows, Public freshness line, desktop Public
  compact official summary), LayersPanel (overview sections, basemap default / fallback note), CoordsSlot +
  coordsVariant, ForensicWorkspace ("Zoom in on a fire or pick one", timeline-only dock, labelled Frame fire,
  collapsed phone sheet), SelectionPin + ProbeDriver click.
- C-R9: --m-text-3 #98a4b2, text-2 #b3bfcc, Public panels 0.94, opaque note / credits chips, meta 12 px. Contrast
  (b2s/contrast.mjs, panels composited over real basemap pixels): every key text >= 6.3:1 on dark, aerial and roads.
- Coverage (b2s/coverage2.mjs, after framing 'done' + 7 s): Public default 75.7-77.5 % on all 10 bundles; Command
  60.5-62.0 %; phones 59.1-60.7 %.
- Gates: typecheck 0, lint 55 (all src/scene), vitest 55 files / 671 tests, build ok, pytest 597.
- 26 final screenshots docs/screenshots/brief2-shell-*.png viewed.

## Next
- Nothing for this role; integration notes are in docs/redesign/reports/brief2-shell.json.

## Decisions
- The 2026 season = live ∪ season list (dedup by id, live wins), active first, then acres desc.
- Effective basemap = fallback ?? pick ?? preset default; URL writes the pick only when it differs from the default.
- Desktop Public opens on a compact "Official now" summary (same useOfficialNow data) to keep >= 75 % open map;
  the full OfficialNow is one click away and always shown in Command, on phones and in the expanded panel.
- The satellite chip lives in the header bar >= 1024 px (no extra map area), next to the controls below that.
- --m-fs-xs stays 11 px (tags / headings): a global 12 px wraps the legend and drops Henderson to 74.5 %.

## Open problems
- See the report's known_issues (coverage margin, phone card height, other owners' 11 px meta).
