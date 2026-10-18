# shell agent progress log

Role: shell (API 8713, Vite 5182). Owns web/src/App.tsx, web/src/ui/shell/**, web/src/styles/**, web/index.html;
additive changes to web/src/state/store.ts and web/src/state/workspace.ts.

## Done
- 15:51 attempt 1 started from foundation skeletons (changed nothing). Read BRIEF, CONTRACT, references.
- 16:02 attempt 2: re-read docs + Forensic UI + other agents' skeletons.
- 16:10 ui/shell/layout.ts (+9 tests): safe insets from docked chrome, union-area coverage.
- 16:15 useMapSafeArea (generic [data-chrome] slots, --chrome-side per breakpoint, --mw-bottom-stack,
  --mw-drawer-space, dev window.__mapChrome()); hooks.ts (media query, drawer focus, overflow).
- 16:20 MapHeader (+ Command ID chip, demo badge, compact menu), WorkspaceSwitch, UpdatesPanel (+ Command data
  status from dataStatus.ts, 7 tests), AnalysisDrawer (lazy AnalysisCharts, draw-path notice), LayersPanel
  (basemap cards, layers, optional sources, forecast run, units, Forensic pointer), ForensicWorkspace (lazy).
- 16:25 styles: map-tokens (preset tokens, gold->blue re-pointing, chart colours), map-layout (grid regions,
  phone sheets, Command density, collapsed H, reduced motion), map-bridge (reused Forensic controls),
  map-fallbacks (:where() fallbacks for other owners' skeleton classes), forensic-narrow (phone Forensic).
- 16:33 App.tsx: lazy Forensic, map workspace slots, phone one-sheet rule, Escape closes newest drawer,
  skip links, map after chrome in tab order. Keyboard check passes (tab order, Escape, focus return).
- 16:40 MapBoundary (map crash card), Forensic demo badge + phone layout (forensic-narrow.css, docking-aware
  safe area), Escape leaves path drawing to useHotkeys, icon-only header toggles < 1280 px.
- 16:45 with the real map/location/timeline components: research note moved above the coordinates (credits get a
  full line), header 48 px, updates 304 px / compact list 236 px, bottom row protects the timeline
  (minmax(min(--m-timeline-min,100%),1fr)); 1440x900 Public default 75.7 % unobstructed, 1920x1080 83.5 %.
- Round trip (kb/roundtrip.mjs): incident, run, time, mode, selection, preset, perspective kept; map canvas gone in
  Forensic and R3F canvas gone back on the map; idle rAF 0/2 s on the map vs 120/2 s in Forensic. Forensic -> map
  hand-off centre error 0.04 m vs pyproj, zoom equal. Keyboard check (kb/keys.mjs) passes.
- typecheck 0 errors, vitest 315/315, lint exit 0 (0 warnings in shell files), build ok; three.js out of the
  Public start-up chunks (only Analysis charts / Forensic / hand-off load it).
- 18:25 attempt 3 (resume): checks green (typecheck 0, vitest 348/348, lint 55 baseline in src/scene). Full shot set
  re-run; review found (a) Public strip with a selected point wider than its stacked content (empty band), (b) phone
  Command default only 34 % open map (tall Command strip), (c) 1440x900 default 74.1-74.7 % on Madre and both fixtures
  (legend wraps to two rows next to the 480 px timeline).
- 18:45 fixes: bottom-row coordinate column per preset (--mw-coords-col: Public fit-content(280px), Command
  minmax(0, max-content)); CoordsSlot.tsx (phones + Command: strip clamped to the reported location, toggle, focus in
  the hidden part expands, scroll reset); header 44 px (phones 48), compact updates body 212 px. 1440x900 default now
  75.9-76.9 % on all 10 bundles; phone Command default 53 %; keyboard, round trip, reduced motion re-checked.

- 21:46 attempt 4 (resume after the user's pause): log + owned files read, all kept. .mw-note gets the credits' dark
  chip (map-core: white note unreadable on the Roads basemap); first chip too transparent (a highway shield showed
  through), now --m-panel-soft + blur. map-fallbacks.css pruned to the rules still matching map-core's .mw-ctl /
  .mw-legend / .mw-attrib (the skeleton classes for search, card, strip, timeline, feed no longer exist).
- 21:50 checks: typecheck 0, vitest 26 files / 392 tests, lint exit 0 (55 warnings, all src/scene), build ok (three.js
  only in the raster/build chunks). Coverage 1440x900 default: Public 75.1-76.8 % on all 10 bundles, Command
  62.5-66.0 %. Round trip, keyboard (1440 + 390 tab order), reduced motion, phone strip clamp all re-run: pass, 0 page
  errors. 1024 Command: capping the legend does not unwrap the coordinates (strip stays .is-tight even at 336 px) and
  costs map area -> left as is. CONTRACT §3.1 numbers updated. Final shots re-running.

- 22:05 final shots re-run (27, 0 page errors) and reviewed; note chip legible on Roads + 3D aerial. Servers 8713 /
  5182 stopped. Report written: docs/redesign/reports/shell.json.

## Next
- Nothing left for the shell role; ui-integration takes over (see the report's notes_for_integrator).

## Decisions
- Other agents style their own component internals (their folders); my skeleton fallbacks for their classes are
  wrapped in :where() (zero specificity) so their CSS always wins regardless of import order.
- Card sits under the search box (left column, docks left); updates panel right; Analysis drawer full width above
  the bottom row (panels above shrink); Layers drawer top right over the updates panel.
- Phones: updates closed by default (reopened when wide again), one bottom sheet at a time, card hidden while a
  sheet is open, legend moves into the Layers sheet. Forensic on phones: right column as bottom sheet, dock shows
  only the timeline (charts + Key Events need width; available in the map's Analysis drawer / updates).
- "H" (panelsCollapsed) also works in Public/Command: hides updates, card, legend, drawers; keeps header, search,
  controls, coordinates, timeline, credits; header shows "Show panels H".

## Open problems
- (resolved by timeline-feed: the feed list is one tab stop with arrow keys.)
- (resolved by location: the strip no longer runs under its buttons; card summary shortened.)
- (resolved by map-core: start-up framing race.)
- With a selected point: Public 67.6 %, Command 55.3 % unobstructed at 1440x900 (card + updates both visible, as in
  Image 1); the 75 % target is met for the default state. Command default 62.5-66 % (denser by design).
- 1024 px Command: the coordinate strip wraps lat / lon onto two lines (location's .is-tight mode).
