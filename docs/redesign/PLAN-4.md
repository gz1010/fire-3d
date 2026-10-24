# Brief 4 build plan: the handoff restyle (PLAN-4)

Planner, 2026-10-24. Inputs: `BRIEF-4.md` (authority), `handoff-4/HANDOFF.md` (spec), `handoff-4/screens/*.dc.html`
(exact px, colours, fonts), `handoff-4/renders/*.jpg`, CONTRACT §9, §11, §13, §14. "Before" screenshots of today's app:
`handoff-4/before/*.jpg` (1440×1000 unless named `phone-*`, 390×844 @2x). Interfaces: CONTRACT §15.

## 0. Scope and ground rules

- Restyle and re-layout only. Keep every datum, map layer, control and behaviour that exists today (section 7 lists
  Command's). No backend or HTTP contract change (`SPEC.md`, `contracts.py`, `api/types.ts` stay as they are).
- Keep the real map. The mock map images are placeholders. Do not copy the Main mockup's cut-off right edge: the map is
  full-bleed in every view.
- Standing rules (CLAUDE.md, BRIEF-4): safety wording, official information verbatim with issuer + own time + link,
  never merged with model output; "Research prototype — not for operational use" and "Not an all-clear. Follow local
  officials." on every view; reduced motion stops every animation; no new dependency; lint 55 warnings (all `src/scene`),
  add none; gates `npm run typecheck && npm run lint && npm test && npm run build` and `uv run pytest -q`.
- Order: **H2** alone, then **H3+H4** and **H5** in parallel (disjoint files, §4). One independent review per view, its
  findings fixed; then a final check (gates + screenshots).
- Ports: H2 API 8732 / Vite 5192; H3+H4 8733 / 5193; H5 8734 / 5194; reviewers 8735-8737 / 5195-5197; final 8738 / 5198.
  Never 8000, 8710, 5173, 5180. Stop your servers when done.
- Each step writes `docs/redesign/progress/brief4-<step>.md`, `docs/redesign/reports/brief4-<step>.json` (summary, files,
  screenshots, known_issues) and fills its "As built" sub-heading in CONTRACT §15. Screenshots:
  `docs/screenshots/brief4-<step>-<view>.png`; view every one.

## 1. Token strategy (most components change by token value, not by edit)

Today the map workspace (Public/Command) reads `--m-*` tokens (`styles/map-tokens.css`): `map-layout.css`, `overview.css`,
`map/map.css`, `location/location.css`, `ui/feed/updatesFeed.css`, `ui/timeline/compactTimeline.css` and
`extras/extras.css` use 95-199 `var(--m-…)` each. Under `html[data-workspace='map']` the generic Forensic tokens
(`--text*`, `--glass*`, `--hairline*`, `--gold*`, `--chart-*`) are re-pointed at them, so reused controls follow.
Forensic reads `styles/theme.css` (`--glass`, `--hairline`, `--text*`, `--gold*`); its CSS also has many raw hex values
(panel.css 67, scene/overlays/overlays.css 37, dock.css 11, header.css 8).

**Step 1 (H2): change values, keep names.** In `map-tokens.css`:

| Token(s) | Today | New (handoff) |
|---|---|---|
| `--m-bg`, `--m-bg-2`, `--m-chip-opaque` | `#0b1119`, `#111a25`, `#0e151e` | `#0c0c0c`, `#141414`, `#0e0e0e` |
| `--m-panel` / `-soft` / `-strong` / `-raised` | navy .94 / .86 / .97 / .97 | `rgba(14,14,14,.74)` / `.62` / `.86` / `rgba(26,26,26,.96)` |
| `--m-panel-blur` | `blur(12px) saturate(140%)` | `blur(22px) saturate(140%)` |
| `--m-border` / `-strong`, `--m-hover`, `--m-active` | navy-blue alphas | `rgba(200,200,200,.16)` / `.28`, `.08`, `.14` |
| `--m-radius` / `-sm`, `--m-shadow` | 10 / 6 px | 14 / 8 px, `0 12px 32px rgba(0,0,0,.4)` |
| `--m-text` / `-2` / `-3` | `#e8edf3` / `#b3bfcc` / `#98a4b2` | `#f0f0f0` / `#cfcfcf` / `#9a9a9a` |
| `--m-accent`, `--m-accent-bg`, `-bg-hover` | blue `#5b9dff`, `#27476b` | `#ff7a3d`, `#ff7a3d`, `#ff8d57` |
| `--m-accent-text` (links) | `#8fbcff` | `#e0e0e0` (links underlined, as the screens) |
| `--m-focus-ring` | blue | `0 0 0 2px #d0d0d0` |
| `--m-select`, `-strong`, `-soft` | cyan `#22d3ee` … | `#9fd6ff`, `#cfeaff`, `rgba(143,208,255,.16)` |
| `--m-fire-observed`, `-fill`, `--m-fire-front`, `--m-perimeter` | `#ff5a1f`, …, `#ff7849` | `#ff6a2a`, `rgba(160,50,20,.6)`, `#ffb27a`, `#ff8a3c` |
| `--m-forecast`, `-fill`, `-hatch` | `#f5a524` … | `#f5c060`, `rgba(245,192,96,.22)`, `rgba(245,192,96,.6)` |
| `--m-stale`, `--m-warn`, `--m-demo*` | `#fbbf24`, `#f5b83d` | `#e8b04a` |
| `--m-ok`, `--m-official-ink`, `--m-official-line` | green / magenta | `#8fd3a8`, `#8fd3a8`, `rgba(143,211,168,.6)` |
| `--m-aoi` | blue-white | `rgba(230,230,230,.5)` |

New tokens (H2): `--m-accent-ink #1a0a03`, `--m-accent-soft rgba(255,122,61,.16)`, `--m-text-body #e6e6e6`,
`--m-text-2b #bdbdbd`, `--m-text-4 #8a8a8a`, `--m-fire #ff6a2a`, `--m-fire-2 #ff8a3c`, `--m-fire-3 #ff9a5a`,
`--m-fire-4 #ffb27a`, `--m-alert #ee7aa0`, `--m-label-track .14em`, `--m-readout-fs 22px`, `--m-readout-lg 26px`,
`--m-coord-xl 30px`, `--m-topbar-top 20px`, `--m-topbar-x 28px`, `--m-topbar-h 44px`, `--m-chrome-top` (top of the
first row under the floating bar, 84 px). Evacuation (`--m-evac-*`), detection and event colours stay (data colours).

**Step 2 (H2): remove hard-coded colours that bypass tokens** in the map workspace: `map-bridge.css` (blue
`rgba(91,157,255,…)` × 16, `color:#fff` on active states → `var(--m-accent-ink)`), `map-layout.css` (`.mw-btn.is-active`,
`.is-primary`, selection, basemap tiles), the re-pointing block's `--gold-dim/-soft/-faint/-ghost` (blue alphas → orange).
**Mirrors in TypeScript** (MapLibre cannot read CSS vars): `map/overlayModel.ts TOKENS` + `OBSERVED_RGBA`/`FORECAST_RGBA`,
`map/basemapStyle.ts DARK` (navy → greys), `extras/style.ts EXTRAS_COLORS.select/bg/text`, `official/style.ts`
(`redFlag #ff5fae` → `#ee7aa0`), `map/overviewLayers.ts PALETTE` (H3+H4 restyles it).

**Forensic (H5):** `theme.css` values: `--glass rgba(14,14,14,.62)`, `--glass-strong .8`, `--glass-blur blur(22px)
saturate(140%)`, `--hairline rgba(200,200,200,.16)` (soft .08, strong .28), `--text #f0f0f0`, `--text-2 #bdbdbd`,
`--text-3 #9a9a9a`, `--text-4 #7a7a7a`, `--bg-*` greys, and the UI accent `--gold*` → `#ff7a3d` family with a new
`--accent-ink #1a0a03`. Keep scene graphics gold: `--lattice-*`, `--fire*`, `--ev-*`, `--ac-*` and the three.js colours.
`--chart-observed #ff8a3c`, `--chart-forecast #f5c060`, `--chart-cursor #e6e6e6`. Then replace the gold gradients and
glows hard-coded in `controls.css` (`.seg-btn[aria-checked]`, `.btn-solid`, `.switch`, `.check`, sliders), `panel.css`,
`dock.css`, `header.css`, `overlays.css`, `scene/overlays/overlays.css`. The map workspace is protected by its own
re-pointing and `map-bridge.css`; H5 checks a Public and a Command screenshot after changing a global file.

**Fonts.** `web/index.html` loads Inter 400-700 and JetBrains Mono 400-600: **add Inter 800** (the fire view's 72 px name).
Also set `<meta name="theme-color" content="#0c0c0c">`. MapLibre text uses OpenFreeMap glyphs (Noto Sans only): map
labels cannot be JetBrains Mono (decision e).

## 2. What H2 must leave in place for H3+H4 and H5 (frozen after H2; changes only through the orchestrator)

1. Final token values and the new tokens above (`map-tokens.css`), and the map re-pointing block.
2. `ui/shell/TopBar.tsx` + `styles/topbar.css`: `TopBar` (floating three-slot bar, no full-width background:
   `left`/`centre`/`right` slots, `flex:1 1 0` sides), `ViewPill` (the Public · Command · Forensic switch as a 32 px pill,
   active = accent + ink; wraps `ViewSwitch` logic from `views.ts`), `BackButton` (36 px round glass, "Back to all
   fires"), `LiveDot` ("● LIVE" mono, or the year chip for a past fire), `IconPill` (36 px round glass icon button with
   tooltip + `aria-label`), `TopBarStatus` (mono 10.5 px .1em status text; stale part amber). `ui/Logo.tsx` (mountain
   outline `#d0d0d0` + orange flame, as the screens), re-exported from `ui/Header.tsx` (one-line edit by H2).
3. `ui/shell/fixedCopy.ts` (`PROTOTYPE_LINE`, `NOT_ALL_CLEAR = 'Not an all-clear. Follow local officials.'`) and
   `ui/shell/FixedCopy.tsx` (variants `line` Main, `corner` Command, `bar` fire view, `pill` Forensic).
4. `ui/shell/Readout.tsx`: `ReadoutRow` ("value unit — LABEL": value mono 22 or 26 px, unit 12-13 px `#bdbdbd`, label
   10.5-11 px 600 .12em `#9a9a9a`, optional `tone`, `sub` line). Used by Command (H2) and the fire view (H3+H4).
5. `App.tsx` `MapWorkspace` split into one map mount + three chrome components: `ui/shell/OverviewChrome.tsx` (no fire,
   both presets), `ui/shell/PublicFireChrome.tsx`, `ui/shell/CommandFireChrome.tsx`. H2 builds Command; the other two
   start as today's layouts moved verbatim (plus the new top bar), so the app works between steps. The map, atmosphere,
   credits, `StatusOverlay`, banners, toasts and tooltips stay in `MapWorkspace`. Every floating element keeps
   `[data-chrome]` + `--chrome-side` (safe area, CONTRACT §3.1).
6. `map/MapAtmosphere.tsx` (vignette + per-view edge gradients, decision g) and the basemap tint API
   `MapActions.setTint('overview' | 'fire' | 'none')` (decision j).
7. Rotation (decision f): `state/rotation.ts` (registry + `rotateView(deg)`, `viewNorthUp()`), Q / E / N hotkeys in
   `state/runtime.ts useHotkeys`, `lib/compass.ts` (pure angle maths, tested), `ui/useCompassDrag.ts`, `lib/rotateGesture.ts`
   (Safari trackpad rotation), `MapActions.setBearing(deg)`, heading kept on 2D↔3D, `useStore.flyTo.bearingDeg?` for the
   workspace hand-off (H5 reads it in `CameraRig`).
8. Workspace store additions (behaviour by H3+H4): `overviewDetails` + `setOverviewDetails`, `device` + `setDevice`
   (browser location; never in the URL, never persisted), `SelectionSource` gains `'device'`.
9. `MapControls` variants: `bar` (Main details, Command) and `compact` (vertical cluster: zoom ±, ⟲ compass ⟳; Public
   minimal and fire view).
10. CSS moves (no visual change) so H5 owns all Forensic CSS: `.fx-empty*` from `overview.css` and `.fx-ws*`,
    `.fx-demo-badge` from `map-layout.css` → `styles/forensic-entry.css`.
11. `web/scripts/shot.mjs`: `--shot-timeout <ms>` (page.screenshot timeout) and `--quality low` (sets
    `useStore.quality` and DOF off before the scene renders): Forensic times out under SwiftShader today (§9).

## 3. Element-by-element mapping

"New" = no current equivalent. Paths are under `web/src/`.

### 3.1 Shared (every view)

| Handoff element | Today (component / class) | Change |
|---|---|---|
| Floating top bar (no full-width bar), left / centre / right | `ui/shell/MapHeader.tsx` (`.mw-hdr` grid, opaque `--m-panel-strong` bar, `styles/map-layout.css` header block); Forensic `ui/Header.tsx` (`.hdr.glass`, `styles/header.css`) | **New** `TopBar` (§2.2): items float on the dimmed map at top 20, sides 28 (Forensic 20), height 40-44. MapHeader and Forensic Header become TopBar users. |
| Logo + "Fire-3d" | `Logo` in `ui/Header.tsx` (stroke `var(--gold)`), `.mw-brand` | `ui/Logo.tsx`: stroke `#d0d0d0`, flame `#ff6a2a`, 18 px 600 name. Overview and Forensic show it; Command and fire view omit it (screens). |
| View switch pill, centre | `ViewSwitch` (`ui/shell/WorkspaceSwitch.tsx`, `Segmented`), `.mw-hdr-mid`; Forensic `.fx-ws-switch` under the compass | `ViewPill` in the bar centre for all three views; `.fx-ws-switch` removed (decision i-11 on the active colour). |
| Back arrow (event views) | `.mw-allfires` "← All fires" button (`goToOverview`) | `BackButton` (36 px round). Forensic: back = close the fire and return to the map overview. |
| Event name + LIVE dot + place/date grey | `IncidentPicker` (`.picker-btn`, chip "LIVE"/year), Forensic `IncidentMeta` (`.hdr-meta`) | Name is the picker trigger ("Willow ▾", Forensic as a pill); `LiveDot`; place = `summary.location` else "<County> County, <State>"; date mono. |
| Right: data-source status in mono, age amber when stale | Satellite chip `extras/ImageryChip.tsx` (`.xs-chip`, in `.mw-hdr-chip`) | `ImageryChip` gets a `variant="status"`: "VIIRS NOAA · 375 M · 6.2 H AGO" (same data and click actions: show image, "More images"). Overview: "OCT 24 2026 · 203 ACTIVE" (**new**, H3+H4). |
| Round icon buttons | `PanelToggle` (`.mw-hdr-toggle` labelled buttons), `HeaderMenu`, Forensic `ViewMenu`, `AnalysisMenu`, `ShareButton`, `SettingsMenu`, hide-panels | `IconPill` (labels become `aria-label` + tooltip). Keep the compact menu < 1024 px and the phone Updates toggle with its badge. |
| Glass panels/pills | `.mw-panel`, `.glass` | By token (§1). |
| Map tint `#333` `mix-blend-mode: color` (.75 US, .35 fire/Command, none Forensic) | Aerial raster paint `raster-saturation -0.6`, `raster-brightness-max .68` (`map/basemapStyle.ts deriveAerial`) | Basemap-only tint through paint (decision j), never over the fire layers. |
| Edge dimming gradients | none (aerial dimmed by paint only) | **New** `map/MapAtmosphere.tsx` (decision g). |
| Fixed copy | `.mw-note` "Research prototype — not for operational use"; "not an all-clear" lines in the panels | `FixedCopy` per view (§2.3). |
| Credits | `MapAttribution` in `.mw-footer` (`styles/credits.css`, phone "© Credits" toggle) | Restyle: mono 10 px `#6f6f6f`-`#8a8a8a`; position per view; keep every credit text (decision i-9). |
| Map rotation (all modes) | 3D-only orbit group (`map/MapControls.tsx OrbitGroup`), compass = north up only; Forensic compass `scene/overlays/SceneOverlays.tsx Compass` | Decision f. |

### 3.2 Command view (CommandView.dc.html) — H2

| Element | Today | Change |
|---|---|---|
| Bar left: back, "Willow" 18/600, LIVE, "Leadville, Colorado" `#8a8a8a` | `.mw-allfires`, `IncidentPicker`, `IncidentIdChip` (ID moves to the readout rows) | TopBar left; demo badge after the place (`DemoBadge`, amber). |
| Bar right: status + Analysis / Check an address / Layers | `ImageryChip` (`.mw-hdr-chip`), `PanelToggle analysis/layers`, `SearchBox` in `.mw-search` | Status variant + three `IconPill`s. "Check an address" opens the search (`location/SearchBox.tsx`) in a popover slot under the bar, right-aligned, 400 px; `focusSearch()` opens it first. |
| Left readout "SELECTED POINT" + copy / centre / clear | `location/CoordinateStrip.tsx` (`.loc-strip` full: `.loc-coord`, copy and centre buttons), `LocationCard` header (`.loc-card-head`, clear) | **New** `location/CommandReadout.tsx` (no panel, text on the left edge gradient), left 40, top 100, width 420. |
| Point in mono 30 px, two lines | `.loc-coord-value` (13-15 px) | `--m-coord-xl`; empty state "Click the map or search to select a point". |
| DMS · UTM · WGS84 line, mono 11 `#8a8a8a` | `.loc-coord-extra` (full variant) | Same data, one line. |
| "Inside the mapped fire area. Burned around … (estimate), 0.7 mi from the edge." + MAPPED / STALE tags | `LocationCard` near block (`describe.ts` `summary.near`, `.loc-headline`, `.loc-chip`, `StaleChip`) | Sentence 14/21; tags as outlined mono pills (Mapped `#ff9a5a`, Stale `#e8b04a`). |
| MODEL line (dashed `#f5c060` tag) | `.loc-model` + `KindTag model` | Same text (dated, experimental); run figure and arrival quantiles move into "More about this spot". |
| (not in mockup) official line at the point | `OfficialSection` (`CardParts.tsx`) | Keep, compact, always shown under MODEL (zones verbatim, NWS line, "not an all-clear"). |
| Rows: 7,359 ac — BURNED; 92 % — CONTAINED; reported location — REPORTED LOCATION · <issuer>; id — INCIDENT ID | Strip full (`.loc-strip-meta` id, record time), fire card facts, `IncidentIdChip` copy | `ReadoutRow`s from `summary` (official record values only) + copy button on the id; add "— RECORD UPDATED <time>" row. |
| (not in mockup) reasons, reliability, details | `ReasonsBlock`, `ReliabilityBlock`, `Details` in `LocationCard.tsx` | Behind a "More about this spot" disclosure under the rows (remembered per preset, `cardPrefs`). |
| Right "OFFICIAL NOW" (green mono) + "TIMES IN MDT" | `ui/shell/UpdatesPanel.tsx` (`.mw-updates-panel`) + `ui/feed/OfficialNow.tsx` (`.on-row` blocks) | Right 40, top 100, width 380, no panel (right edge gradient). Header from `zoneLine`. |
| Notice rows: dot, "Title — verdict", mono meta, chevron, expand to full wording | `OfficialNow` `Row` (`.on-row-head` + body + "More") | `Row` becomes collapsible: collapsed = dot (tone) + label — verdict + meta (issuer · own time · checked); expanded = today's body unchanged (verbatim text, links, "Show" area, extras). Orders, warnings and alerts in effect open by default (decision i-6). |
| Foot: "modeled spread … not an evacuation order. Follow local officials." + "View all updates ›" | `.os-foot`, `.mw-panel-foot` "View all updates" | Add `NOT_ALL_CLEAR`. "View all updates" expands the column into today's expanded panel: `OfficialNow` + `DataStatus` (every source's time) + `UpdatesFeed`, scrollable, glass background. |
| Map labels with leaders: SELECTED (blue), Willow REPORTED, Observed fire + acres/time, Modeled spread + BY … EXPERIMENTAL | Selection pin `.fxm-pin` (+ chip), incident marker label (`layers.ts` incident layers), area labels in MapLibre | Pin recoloured `#9fd6ff`; reported label "REPORTED"; **new** two-line leader labels for "Observed fire" and "Modeled spread" (DOM, the H3+H4 `LeaderLabels` engine is not available yet: H2 uses MapLibre symbol labels styled like the screens, H3+H4 may switch them). |
| Legend chips (Observed, Modeled hatched, Perimeter, Selected) + 1 mi scale, above the timeline right | `map/MapLegend.tsx` compact row (`.fxm-legend-row`), `ScaleBar` (`.mw-scale-slot`) | Chips row right 40, bottom ≈160; "Legend details" button keeps today's details popover (every layer, forecast view mode, optional sources, photo date, buildings caveat). |
| Slim timeline: play 40 px, "ISSUED … · NOW …", past solid `#ff6a2a`, forecast dashed `#f5c060`, event dots, stop buttons, handle (orange, amber ring when stale), label above handle, tick labels | `ui/timeline/CompactTimeline.tsx` (`.ctl-*`, `compactTimeline.css`; 620 px card) | Full width (left 40, right 40, bottom 52, height 72), no card. Keep: stops and their disabled reasons, keyboard slider, forecast info popover (`.ctl-fcinfo`, run, warnings), freshness and wall clock, replay line, zone labels, key-event markers. |
| Bottom line: "RESEARCH PROTOTYPE — NOT FOR OPERATIONAL USE" left, credits right | `.mw-note`, `CreditsFooter` | `FixedCopy corner` + credits (wrap allowed). |
| (not in mockup) map controls | `MapControls` (`.mw-controls`, top right) | `bar` variant bottom-left above the timeline (mirrors the legend row); 3D orbit row above it. |
| (not in mockup) fire card for other fires' markers | `ui/shell/FireCard.tsx` (`.mw-firecard`) | Floats in place of the readout while open (as today: it hides the location card). |
| (not in mockup) Analysis / Layers drawers | `AnalysisDrawer` (`.mw-drawer-slot`), `LayersPanel` (`.mw-layers-slot`) | Unchanged behaviour; glass restyle by tokens. |
| Edge gradients L 540 / R 500 / B 230 / T 120 | none | `MapAtmosphere` `edges="command"`. Tint .35 → `setTint('fire')`. |

### 3.3 Public overview (Main.dc.html) — H3+H4

| Element | Today | Change |
|---|---|---|
| Bar: logo, "United States · all fires", pill, "OCT 23 2026 · 203 ACTIVE" | `MapHeader` overview branch (`.mw-hdr-title`), Layers toggle | Right: viewer's local date (mono .14em) + active count (`overviewCounts`) in `#ff8a3c`, tooltip "listed by CAL FIRE or NIFC; no marker is not an all-clear". Layers moves into the controls bar. |
| Centred search pill 560×52 + Search button | `location/SearchBox.tsx` (`.loc-search*`, left column 360 px, label "Check an address") | Centred at `--m-chrome-top`; visually hidden label kept; placeholder "Check an address, town, ZIP or coordinates"; results popover centred under it. |
| Locate-me button 52 px | none | **New** `location/LocateButton.tsx`: `navigator.geolocation.getCurrentPosition` on click only → `setDevice` + `selectLocation({source:'device', label:'Your location', approximate: accuracy > 100 m}, {fly:true})`. Denied / unavailable / timeout: plain message under the pill. No outside service. |
| Edge dimming (radial + top/bottom 200 px) | none | `MapAtmosphere edges="overview"` + globe vignette. Tint .75 → `setTint('overview')`. |
| Markers: transparent circles, centre dot, sizes by type; "28 FIRES"; leader labels | `map/overviewLayers.ts` (3 sources, `OVR.*` layers, `PALETTE`, `markerRadius`, `CLUSTER_RADIUS_EXPR`, `LABEL_TEXT`) | Decision e. |
| NWS fire-weather polygons (pink dashed) | `official/mapLayer.ts` | Colour `#ee7aa0` (H2 changes `official/style.ts`). |
| Disclaimer one line, bottom centre | `.mw-note` (bottom left), `LIST_ABSENCE` in legend / list footer | `FixedCopy line`: "RESEARCH PROTOTYPE · Not for operational use. " + `LIST_ABSENCE` (exact §14.14 string). |
| "Show details" pill + count (bottom right) | none (panels always open; "H" collapses) | **New** `ui/public/ShowDetailsPill.tsx` → `overviewDetails` (decision d). |
| Details: map controls bar (2D/3D, basemap, compass, −, +, All states, Layers) | `MapControls` (`.fxm-ctl`), `PanelToggle layers` | `bar` variant top-left (top 160, left 28) + Layers icon at its end. |
| Details: "Fires in the lower 48" panel (title + close, OFFICIAL NOW, NWS block, Show area / Source, tabs Active / 2026 season / 2025 with counts, OFFICIAL source line + refresh, "200 fires in this view · Show all 203", rows) | `ui/shell/OverviewPanel.tsx` (`.ov-panel`, `.ov-official` + `OfficialNow` overview variant, `.ov-filters` `Segmented`, `.ov-source`, `.ov-viewline`, `.ov-list` rows `.ov-row/.ov-name/.ov-sub/.ov-acres`, footer `.ov-foot`) | Restyle to the screen: panel right 12, top 160, bottom 236, width 472, radius 16; title 20/600; NWS block pink frame `rgba(238,122,160,.4)`; tabs accent; rows 16/600 name, 13 `#9a9a9a` sub, mono 15 acres. Keep windowing, roving focus, "Analysis ready" chip, list-down notices, footer (the "Include 2025 fires of 100–300 acres" switch lives in the incident picker and stays there). Row click → fire view (decision b). |
| Details: overview card ("UNITED STATES OVERVIEW / No fire open; SELECTED POINT …") | `CoordinateStrip` compact (`.loc-strip`, in `.mw-coords`) | Restyle (left 28, bottom 92, width 360, mono .14em eyebrows). |
| Details: scale bar, legend (6 entries incl. "Photos: June 2024 or earlier") | `ScaleBar`, `MapLegend` overview branch | Scale left 404 bottom 92; legend right 12 bottom 112 width 600 with new marker swatches (`.fxm-sw-*` in `map/map.css`) and the "Details" popover kept. |
| (not in mockup) location card after a search / click / locate | `LocationCard` / `OverviewCard` (left column under search) | Always shown when a point is selected, left 28 top 160 width 360 (details or not). Nearest-fire rows open the fire view. |
| Attribution bottom centre | `CreditsFooter` | Centred mono 10 px. |

### 3.4 Public fire view (FireView.dc.html) — H3+H4

| Element | Today | Change |
|---|---|---|
| Close X (44 px, top-left 24) | "← All fires" (`goToOverview`) in the header | X = `goToOverview()` (history back when opened from the overview). No logo. View pill compact at top-right (decision a). |
| Title: place 24/600, "JUN 28 2026 — PRESENT" mono .16em | header picker + `IncidentMeta` (Forensic) | **New** in `ui/public/FireTitle.tsx`; place = `summary.location` ?? "<County> County, <State name>" (`lib/usStates.ts`); end = "present" (active) or the record's end time with its label (`containedLabel`). |
| Distance chip "↗ 20 mi | northeast of you" ↔ "Share your location to see how far you are" | none (location card distances only) | **New** `ui/public/DistanceChip.tsx` from `device`: distance + direction to the latest perimeter's nearest edge (else to the reported location), label says which (decision i-7); click toggles sharing (`setDevice(null)` clears). |
| Hazard circle 312 px: thermal texture (feTurbulence glow, drift, specks, grain), "WILDFIRE · ACTIVE", name 72/800, "MORE IN COMMAND ›" | none | **New** `ui/public/HazardCircle.tsx` (inline SVG as the screen; unique filter ids; SMIL frozen under reduced motion and `pauseAnimations()` when the tab is hidden); status words from the agency record (`recordStatus`); name auto-fits (72 → 40 px, 2 lines, full name in `aria-label`); button → `applyView('command')`. |
| Leader line circle → reported point (orange 1.5 px) + point marker | incident marker in MapLibre (`layers.ts` incident layers, "Reported location" label) | Point restyled as the screen (r12 `#ff6a2a`, ring `#ffd79a`, centre dot); line drawn by the `LeaderLabels` overlay engine (§6 e), hidden when the point is off-screen. |
| Facts rows (7) + OFFICIAL badge + sources + checked + "Not an all-clear. Follow local officials. NIFC WFIGS" | Public compact "Official now" (`UpdatesPanel` `OfficialSummary`, `officialSummary.ts`: evacuation / local / record / fire-weather lines), `FireCard` `OfficialRecord` | **New** `ui/public/FireFacts.tsx` with `ReadoutRow`s: acres — BURNED, % — CONTAINED, start — STARTED, lat/lon — REPORTED, fire weather — RED FLAG WARNING (NWS), evacuations — EVACUATION ZONES (<state>), local officials' alerts (only when one is in effect), record time — LAST OFFICIAL UPDATE. Values from `useOfficialNow()` + `officialSummary()` lines (verbatim, own times, links). Text values use 16-18 px (decision i-1/2). |
| Map: only the current fire area | Observed raster, perimeters, detections, forecast, AOI, events (`map/layers.ts`, `rasterOverlay.ts`) | Public fire profile: newest perimeter only (any time) + reported point + official layers + dimmed other fires (decision a). |
| Map key: "Fire area now · Oct 23, 2:30 PM MDT" + 0.5 mi scale | `MapLegend` compact row, `ScaleBar` | Key right 24 bottom 52: "Latest perimeter · NIFC WFIGS · <its time> (<age>)" + Stale tag, scale inside; legend details on demand. |
| Left gradient 560 px; tint .35 | none | `MapAtmosphere edges="fire"`, `setTint('fire')`. |
| Bottom bar 30 px: prototype left, credits right | `.mw-note`, `CreditsFooter` | `FixedCopy bar` + credits. |
| (not in mockup) timeline, updates, location card, search, Analysis, Layers | `CompactTimeline`, `UpdatesPanel`, `LocationCard`, `SearchBox`, drawers | Decision a. |

### 3.5 Forensic (ForensicView.dc.html) — H5

| Element | Today | Change |
|---|---|---|
| Bar: back, logo, "LIVE Willow ▾" pill, "Lake County · Jun 28, 2026 – present", centre pill, right: Incident / Aircraft 0 tabs, View options, Analysis, Share, Settings | `ui/Header.tsx` (`Brand` + tagline, `IncidentPicker`, `IncidentMeta`, `HeaderTabs` `.hdr-tab`, `ViewMenu`/`AnalysisMenu`/`ShareButton`/`SettingsMenu`, hide panels), `.fx-ws-switch` | `TopBar` with these items; menus open from `IconPill`s; tagline dropped; keep hide-panels (H) as an icon and `MiniBar` when collapsed (restyled). |
| Compass 60 px + "000° · 29°" | `Compass` in `SceneOverlays.tsx` (`.sc-compass`, gold ticks, `#E8C77E`) | Grey glass, N `#ff7a3d`, S `#9a9a9a`; drag to rotate; ⟲ ⟳ buttons beside it (decision f). |
| Frame fire + Charts & key events under the compass | `EntryControls` (`.fx-entry`) inside `.fx-ws` (top = safe-top + 120) | Directly under the compass (left 20, top ≈170); demo badge below them. |
| Map controls bottom-right above the timeline: scale, 2D/3D (accent), 1.5×, High, Lighting, Recenter, Full screen | `ViewDock` (`.sc-dock`, `.sc-group`, `.sc-seg`, `.sc-select`, DOF, frame, fullscreen) | Recolour; 2D/3D active accent + ink; selects as "1.5× ▾" / "High ▾" text buttons (same `<select>`s underneath). |
| Right panel: tabs (accent underline, count chip, dot), BASE / FIRE groups with eye toggles, rows (checkbox accent, swatch, name, slider, %), P(burned by t) ramp, PARAMETRIC row | `ui/RightPanel.tsx` (`.rcol`, `.tabs`), `ui/LayersTab.tsx` (`.lg`, `.lrow-*`, `.legend-ramp`), `panel.css` | Recolour only; swatches keep their data colours. Panel 336 px wide, top 76, radius 16. |
| Incident Overview collapsed row with "NIFC WFIGS ↗"; Weather & Fire Behavior 3×2 grid, flame length orange | `ui/IncidentOverview.tsx` (`.ov`, `.kv`), `ui/WeatherCard.tsx` (`.wx-*`) | Recolour; overview collapsible (today expanded); flame length `#ff9a5a`; icons kept. |
| Timeline: title, step ‹ ›, accent play 36 px, speed, time + zone + T+, range tabs All / 7 d / 72 h, range text, event marks, track with orange observed hatch, NOW handle with accent ring, month labels | `ui/Timeline.tsx` (`.tl-*`), `ui/BottomDock.tsx` (`.dock`), `dock.css` | Recolour; dock left 16, right 368, bottom 16, height 112 (charts row unchanged when opened). |
| Disclaimer pill bottom-left | `.mw-note`-like Forensic note | `FixedCopy pill`: prototype line + `NOT_ALL_CLEAR`. |
| Top gradient 120 px; no tint; green terrain and gold scene graphics kept | scene | No vignette in Forensic (decision g). |
| (not in mockup) "Zoom in on a fire or pick one" (no fire) | `OpenFireFirst` in `ForensicWorkspace.tsx` (`.fx-empty*`) | Same restyle (TopBar + glass). |

## 4. Steps with file ownership

Ownership is by step. H2 runs alone and may edit everything listed for H2 *and* (read-mostly) the others' files only as
named in §2. After H2 lands: H3+H4 owns the map workspace, H5 owns Forensic; the two lists below are disjoint.

### H2 — foundation + Command (alone, first)

Owns: `web/index.html`, `web/scripts/shot.mjs`, `src/App.tsx`, `src/main.tsx`, `src/styles/map-*.css`, `credits.css`,
`overview.css`, new `topbar.css` / `atmosphere.css` / `view-command.css`, `src/ui/shell/**` except
`ForensicWorkspace.tsx`, new `src/ui/Logo.tsx`, `src/ui/timeline/**`, `src/ui/feed/**` except `keyEvents.css`,
`src/map/**`, `src/location/**`, `src/extras/**`, `src/official/style.ts`, `src/state/workspace.ts`, `store.ts`,
`runtime.ts`, new `state/rotation.ts`, new `lib/compass.ts` + `lib/rotateGesture.ts` (+ tests), new `ui/useCompassDrag.ts`,
`src/ui/IncidentPicker.tsx` (trigger only), one-line `Logo` re-export in `ui/Header.tsx`.

Do, in order: (1) tokens, fonts, TS colour mirrors (§1); (2) `TopBar` family, `Logo`, `FixedCopy`, `Readout`;
(3) `MapWorkspace` split into the three chromes (stubs keep today's layouts); (4) `MapAtmosphere` + tint; (5) rotation in
Public/Command (§6 f) + registry + hotkeys + compass drag + Safari gesture; (6) Command in a fire (§3.2); (7) CSS moves and
`shot.mjs` flags (§2.10-11); (8) gates, screenshots (Command, Public stubs unchanged apart from tokens, Forensic untouched
except the logo), CONTRACT §15 "H2 as built". Review: Command view.

Acceptance: every §7 Command feature reachable; Command at 1440×1000 matches the render within reason on `fixture-live`;
2D map rotates by buttons, compass drag, Q/E, Ctrl/right-drag; N and the compass return north; tests updated deliberately
(§8); text contrast checked (decision l); open-map share recorded with `__mapChrome()` (decision m).

### H3+H4 — Public overview + Public fire view + Command overview (after H2, parallel with H5)

Owns everything H2 owned except the frozen shared files below and the Forensic files: `src/ui/shell/**` except
`ForensicWorkspace.tsx` (so `OverviewChrome.tsx`, `PublicFireChrome.tsx`, `OverviewPanel.tsx`, `fireActions.ts`,
`MapHeader.tsx`, `UpdatesPanel.tsx`, `FireCard.tsx`, `LayersPanel.tsx`, `officialSummary.ts`, … and their tests), new
`src/ui/public/**`, new `src/styles/view-public.css`, `overview.css`, `map-layout.css`, `map-fallbacks.css`, `credits.css`,
`atmosphere.css`, `src/map/**`, `src/location/**` except `CommandReadout.tsx`, `src/state/{fireCard,overview,history,
workspace}.ts` (+ tests), `src/lib/**` (additive), `src/ui/feed/**` except `keyEvents.css`, `src/ui/timeline/**`,
`src/extras/**`, `src/official/**`. Must not change Command in a fire (compare with H2's screenshots) or any Forensic file.

P0 (in order): `overviewDetails` minimal/details (§3.3, decision d) with the centred search + locate-me; marker restyle in
GL (sizes, colours, centre dot, groups, "N FIRES"); click → fire view for list, marker, label, search result,
location-card row (decision b); fire view (§3.4) with static hazard circle, facts, distance chip, perimeter-only profile,
unprepared and no-perimeter states; Command overview (decision c); phone layouts (decision h).
P1: leader-line labels with collision (decision e); animated circle texture; compact control cluster polish.
Review: Public overview + fire view (+ Command overview).

### H5 — Forensic (after H2, parallel with H3+H4)

Owns: `src/scene/**`, `src/ui/shell/ForensicWorkspace.tsx`, `src/ui/{Header,RightPanel,BottomDock,Timeline,timelineModel,
LayersTab,AnalysisTab,EvidenceTab,NotesTab,IncidentOverview,WeatherCard,AircraftPanel,KeyEvents,Menus,Charts,
RegionAccuracy,DataCredits,Overlays,Tooltip,controls,IncidentPicker}.tsx/.ts` (+ their tests; keep the picker trigger H2
styled for Command), `src/ui/feed/keyEvents.css`, `src/styles/{theme,layout,controls,header,panel,dock,overlays,
forensic-entry,forensic-narrow}.css`.

Do: theme tokens + hard-coded golds (§1); TopBar header (§3.5); compass, entry controls, view dock, right panel,
overview/weather, timeline, disclaimer; rotation in Forensic 2D and 3D (decision f: `CameraRig` `enableRotate` in 2D
with the polar clamp kept, heading kept on 2D↔3D, `sceneStore` command `{ kind: 'rotate', deg }` and `'set-heading'`,
compass drag via `ui/useCompassDrag.ts`, ⟲ ⟳ buttons, register with `state/rotation.ts`, Safari gesture on the canvas,
read `useStore.flyTo.bearingDeg`). Add no lint warning in `src/scene` (baseline 55). Review: Forensic.

### Shared files (nobody edits after H2 without the orchestrator)

`App.tsx`, `main.tsx`, `index.html`, `ui/shell/TopBar.tsx`, `topbar.css`, `WorkspaceSwitch.tsx`, `views.ts`,
`ui/Logo.tsx`, `fixedCopy.ts`, `FixedCopy.tsx`, `Readout.tsx`, `state/rotation.ts`, `state/store.ts`, `lib/compass.ts`,
`lib/rotateGesture.ts`, `ui/useCompassDrag.ts`, `ui/hooks.ts`, `map-tokens.css`, `map-bridge.css`, `view-command.css`,
`CommandFireChrome.tsx`, `location/CommandReadout.tsx`, `api/**`, and any file no step lists (`ui/eventMeta.ts`,
`ui/toast.ts`, `ui/useListWindow.ts`, `ui/options.ts`, `data/**`, test utilities, `backend/**`). Global CSS owned by H5 (`theme.css`, `controls.css`,
`overlays.css`, `header.css` incl. the picker popover) also styles reused controls in the map workspace: H5 keeps the
map's look (it is protected by `map-bridge.css`) and posts a Public + Command screenshot after changing them.

## 5. Sequencing and reviews

H2 → review (Command) → fixes → H3+H4 ∥ H5 → review (Public) and review (Forensic) → fixes → final check (gates,
`uv run pytest -q`, screenshots of the five views at 1440×1000 and phones, rotation in all modes, reduced motion, a
FIRMS-key count-only leak scan). The orchestrator commits and pushes after each step (cloud session).

## 6. Decisions (recommendation first; the orchestrator decides)

**a. Public inside a fire.** Recommend the fire view of §3.4 with:
- Map: newest perimeter only (any time, not the timeline time), its source and own time in the key, Stale tag when old;
  reported-location point + leader; official layers (evacuation zones, NWS outlines) kept; other fires dimmed. Hidden in
  Public: modeled spread, observed burned-area raster (an estimate), detections, AOI boundary, event markers, timeline,
  Analysis drawer, updates feed — all still in Command ("MORE IN COMMAND ›", and the view pill).
- Time: on entry Public sets the timeline time to the latest observation (live: now; past fire: end of record), so the
  card, the facts and the map agree; `?t=` applies once the user switches to Command.
- Search and location card: a search icon in a small top-right cluster [view pill · search · layers] opens the same
  centred pill as the overview. A picked point shows the location card on the right: near block (distance to that
  perimeter), official block, reliability; the model block is replaced by "The experimental spread model for this spot is
  in Command ›". Locate-me = the distance chip. Layers drawer keeps basemap, units and official layers; model toggles
  hidden with that note.
- Updates feed: not shown (official items are in the facts; the full feed is in Command). No incident picker (the
  overview list picks fires; the picker, with its "Include 2025 fires of 100–300 acres" switch, stays in Command and
  Forensic).
- Unprepared fire (no bundle): same layout; facts from the list row + `useOfficialNow()` (works without a bundle); map:
  reported point only; key "No mapped perimeter yet · reported location (<issuer>)"; under the facts "Fire-3d has not
  prepared this fire's map data yet. Prepare map data (1-3 min)" (today's `openFire(id,'prepare')`; replaces the top
  `NotPreparedNotice` in Public). Building: progress line in the same place.
- Bundle but no perimeter: key "No perimeter published yet"; the observed raster is not substituted (it is an estimate)
  — "Estimated burned area from satellite detections: in Command ›".
Options: A as above (recommended); B today's Public layout restyled (timeline, updates, card) plus the hazard circle;
C as A but keep the model sentence in the card.

**b. Click → fire view.** Today every pick (list row, marker, label, search fire result, location-card nearest row,
header picker) calls `showFireCard()` (`state/fireCard.ts`): card + flight; a prepared fire then opens by zoom focus,
an unprepared one keeps a `fire-card` focus hold; the card's "Open this fire" calls `openFire()` →
`selectIncident(id, {source:'card'})` (history push). Recommend for **Public**: `openFireView(id)` (new in
`fireActions.ts`) = `setFireCard(null)` + `selectIncident(id, { source: 'card' })`: one history push, framed on the fire,
no build; Back / X returns to the overview and the view the user left (`Framing` restores it). **Zoom focus off in Public**
(the chrome never swaps while zooming; zooming out of a fire view does not close it); on in Command as today. Public hides
the "Spread not prepared yet" chips (the fire view has the prepare link). Command and Forensic keep the fire card. Group
click: zoom in as today. Options: A direct (recommended); B card first, then "Open"; C card only for unprepared fires.

**c. Command overview (no mockup).** Recommend Main's layout with details shown by default and no "Show details" pill
(Command can still hide panels with H): top bar like Main (date · N ACTIVE), controls bar top-left, list panel right with
the national Official now, coordinate readout bottom-left (DMS/UTM when a point is picked), legend + scale bottom; fire
clicks open the fire card (as today); search pill centred as in Public. Built by **H3+H4** (they own the overview
chrome); H2 only gives it the new top bar. Options: A (recommended); B Command-style floating readouts without the list;
C identical to Public minimal.

**d. Behind "Show details".** Recommend: the controls bar, the "Fires in the lower 48" panel (national Official now, filters
+ counts, sources + refresh, view line, list, list-absence footer), the overview readout, the scale
bar and the legend. Always visible: bar, search + locate, compact compass cluster, disclaimer, credits, the pill, the
location card when a point is selected, and list-down / missing-fire banners (top centre). Pill count = fires the map
shows for the current filter (`overviewFires(catalog, filter).length`, the "Show all N" number), `aria-label` "Show details:
list of N fires"; spinner while lists load. Default filter stays `season`. On phones the pill opens the list peek sheet.
Option: count active fires only (the mockup's 203 is that number).

**e. Markers and labels.** Markers are MapLibre layers (`map/overviewLayers.ts`: 3 GeoJSON sources, clustering in
MapLibre's worker, ~21 layers, hit circles ≥ 11 px); keep that (thousands of points stay cheap). Restyle: fill `#ff8a3c`
@ .10, stroke `#ffc08a` @ .8, 1-1.2 px, plus a centre-dot circle layer `#fff3dc` (r 1.4 / 2.2 / 2.8); radius by type
(handoff): small active (< 10 ac or no size) r7, active r11, pinned (active ≥ 5,000 ac or the open card) r15, other
(not active) a hollow `#f0d9b0` ring r4.5; groups `10 + 3·√n` capped at 34 (the screen's circles fit ≈3; HANDOFF's 4.2
gives 32 px for 28 fires — pick one), no shrink at the national zoom, × 1.2 by z10; dim while a fire is open (as today).
Group labels "28 FIRES": a MapLibre symbol (`['format', count, {}, ' FIRES', {'font-scale': .62}]`, Noto Sans Bold, upper
right of the circle, short tick as an `addImage` line icon) — JetBrains Mono is not in OpenFreeMap's glyphs; accept Noto
Sans (DOM labels for groups would cost per-frame work for up to ~100 items). Leader-line labels: **new** DOM/SVG overlay
`map/LeaderLabels.tsx` + pure `map/leaderLayout.ts` (tested) for at most 12 fires in view (pinned or ≥ 20,000 ac, largest
first): two lines (name Inter 12/600 `#f0f0f0`; "172,912 AC" mono 10 `#cfcfcf`), 0.8-0.9 px leader `#cfcfcf` @ .55;
greedy layout to the nearer free side (a right-aligned gutter column for the westernmost fires, as the screen, else a
30-40 px diagonal), avoiding other labels, marker circles and chrome rects; a label with no free slot is dropped and its
MapLibre label shows instead. Recomputed on moveend / resize / data change; during moves labels follow their anchors
(`map.project`, ≤ 12 per frame) and hide while zooming. Same engine draws the fire view's circle → point leader and may
replace Command's area labels. Clicking a leader label = clicking the marker.

**f. Rotation (compass heading) in all modes.** Blockers today: Public/Command 2D — MapLibre's gestures are on
(right-drag, Ctrl+drag, two-finger twist, Shift+←/→ with the map focused) but nothing visible offers rotation (the
orbit group is 3D only, the compass only resets), switching to 2D resets the bearing (`applyPerspective`), Mac trackpads
have no rotate gesture in Chrome and MapLibre 5.24 ignores Safari's `gesturechange`. Forensic 2D — `CameraRig` sets
`controls.enableRotate = viewMode === '3d'` and the 2D tween forces azimuth 0 (3D rotates with right-drag or
Shift/Ctrl/Cmd+drag). Recommend in every mode: (1) visible ⟲ ⟳ buttons (15°) beside the compass — `bar` controls,
the `compact` cluster (Public minimal and fire view: zoom ±, ⟲, compass, ⟳, bottom-right), Forensic under the compass;
(2) drag the compass around its centre to set the heading (`useCompassDrag`, pointer capture; click without drag = north
up, so "reset north" stays); (3) keys Q / E rotate 15°, N north up, outside text fields, routed by `state/rotation.ts` to
the visible view (plus MapLibre's Shift+←/→ when the map is focused); (4) Safari trackpad two-finger rotate via
`lib/rotateGesture.ts` (`gesturestart/change/end`, `preventDefault`, bearing = start − rotation; Safari only, cannot be
tested in the cloud: the user tries it); (5) mouse/touch as today, Forensic 2D gains right-drag, modifier-drag and
two-finger twist; (6) heading kept across 2D↔3D and the map↔Forensic hand-off (`handoff.ts` both ways); north up only on
request. Update the one-time hint text (Ctrl+drag on a Mac trackpad, Q/E). Note for H2: every MapLibre camera call in
`mapController.ts` must sit inside `this.input.ours(…)` (`userInput.test.ts`); a rotate gesture still counts as the
user's move (call `this.input.input()`).

**g. Globe-like dimming.** Recommend `map/MapAtmosphere.tsx`: one `aria-hidden`, `pointer-events:none` layer between the
map canvas and the chrome. (1) Vignette: `radial-gradient(circle at var(--mw-vig-x) var(--mw-vig-y), rgba(12,12,12,0)
calc(var(--mw-vig-r)*.6), rgba(12,12,12,.55) calc(var(--mw-vig-r)*.92), rgba(12,12,12,.9) calc(var(--mw-vig-r)*1.35))`;
centre = centre of the safe area (where the fire is framed), radius = half its shorter side, so the dark edge is a circle
like a globe's limb; opacity `--mw-vignette = clamp((zoom − 3) / 7, .25, 1)` (z3 .25 → z10 1), written from a
`useMapRuntime` subscription (no React render per frame) only when it changes by ≥ .02; no transition under reduced
motion. (2) Static per-view edge gradients from the screens behind text (Command L/R/B/T, fire view left, overview
top/bottom). Public and Command, 2D and 3D; not Forensic (its scene has its own atmosphere; the screen shows only a top
gradient there). Options: A CSS overlay (recommended, cheap, compositor-only); B a MapLibre `sky`/fog effect (3D only,
no 2D); C a WebGL post pass (complex).

**h. Narrow screens.** Keep today's model: ≤ 760 px one bottom sheet at a time (`has-sheet`, handle, peek bar,
"© Credits" toggle, coordinate line), 761-1023 px compact bar with the view menu, ≤ 1279 px narrower columns.
Per view: Public overview — bar (logo, title, menu), full-width search pill + 44 px locate, "Show details" opens the
list sheet, compact cluster above it, disclaimer + credits on one line. Fire view — bar: X, place/date (small), menu;
distance chip under it; a 120 px hazard circle beside the name in a header strip; facts in a bottom sheet whose peek shows
acres, containment and the official line; key inside the sheet. Command — readout as the bottom sheet (its peek = selected
point or reported location), Official now = the Updates sheet (badge as today), full-width timeline at the bottom, legend
in the Layers sheet, controls row as today. Forensic — `forensic-narrow.css` as today, compact bar (back, name, menu).
1024-1279: Command readout 360 / official 320 px; Public list 400 px. Touch targets ≥ 44 px on phones.

**i. Conflicts with the safety rules and with keeping features.**
1. "N/A — EVACUATION ZONES (CO)": use the §14.14 short form "Not available in this state" (never "N/A"); zones listed
   → verbatim status, issuer, own time, link.
2. "None — RED FLAG WARNING (NWS)": "None in effect" with the NWS source and check time; an alert in effect shows its
   verbatim event, its own end time, issuer and link. The facts end with `NOT_ALL_CLEAR`.
3. "Fire area now": an old perimeter is not "now" → "Latest perimeter · <source> · <its time> (<age>)", Stale tag.
4. "203 ACTIVE": a count of listed fires, with the list-absence tooltip.
5. Main's disclaimer wording differs from §14.14: use "RESEARCH PROTOTYPE · Not for operational use. " + `LIST_ABSENCE`.
6. Command's collapsed official rows hide verbatim wording: keep issuer + own time in the collapsed meta; open by default
   any row with an evacuation order or warning, a local officials' alert or an NWS alert in effect; quiet rows say "not
   an all-clear" when expanded.
7. Distance chip: say what it measures ("to the mapped edge, Oct 23 perimeter" / "to the reported location, not its
   edge"), never a colour or word that implies safety; device location stays in the browser (not sent, not in the URL,
   not stored).
8. Fixed copy: the Command and Forensic screens lack "Not an all-clear. Follow local officials." — add it (§2.3).
9. Credits: keep every required text (OpenFEMA disclaimer, Open-Meteo CC BY 4.0, Mapterhorn, USGS photo date); do not
   shorten to the mockup's line; wrap or fold behind "© Credits".
10. Hazard circle status from the agency record ("ACTIVE" only when listed active; "CONTAINED"/"DECLARED OUT" with its
    meaning, §14.17); Public shows no model output, Command keeps "experimental" + "Outside the modeled area is unknown,
    not low." where the model shows.
11. Active view tab: Main shows `#e6e6e6`, HANDOFF and the other screens accent `#ff7a3d` → accent everywhere.
12. Tint must not desaturate fire, official or selection layers (decision j). Command features kept: section 7.

**j. Map tint.** The screens put a `#333` `mix-blend-mode: color` div over a picture. In the app the fire, official and
marker layers are in the same WebGL canvas, so such a div would grey them too. Recommend basemap paint:
`MapActions.setTint(level)` sets the aerial layer's `raster-saturation` (overview −0.85, fire −0.6 as today) and
`raster-brightness-max`; the dark basemap becomes neutral grey (`basemapStyle.ts DARK`); Roads (a user pick) untinted.
Options: A paint (recommended); B CSS blend (greys the fire too).

**k. Heading on mode switches.** Recommend keeping the heading on 2D↔3D and on the map↔Forensic hand-off (today both reset or
drop it); "North up" / N / compass click restores north. Option: keep today's reset.

**l. Lighter glass and contrast.** Panels go from .94 to .62-.74 alpha; brief 2 required `--m-text-3` ≥ 4.5:1 over every
basemap. Recommend keeping the handoff values but measuring composited contrast over bright aerial (Eaton, Lower Sugarloaf)
and raising a panel's alpha or its edge gradient where meta text fails.

**m. The "≥ 75 % open map" target (BRIEF §6, brief 2).** The fire view's left column (≈ 460 px) leaves ≈ 68 % at
1440 px, and Command's readout + official columns (no panels, text on gradients) leave less by the chrome measure.
Recommend dropping the target for the handoff layouts (the user's own design), keeping the map full-bleed and framing the
fire in the free area, and recording `__mapChrome().unobstructed` per view in the reports. Option: keep the target and
narrow the columns.

## 7. Command today → new place (nothing is dropped)

| Feature (today) | New place |
|---|---|
| "← All fires", incident picker (filters, list), ID chip + copy, demo badge | Bar: back, name ▾ (picker), demo badge; ID → readout row with copy |
| View switch | Bar centre pill |
| Satellite chip (newest image, show, caption, "More images") | Bar right status (same actions) |
| Analysis / Layers toggles, compact menu, phone Updates toggle + badge, "Show panels (H)" | Bar right icons; menu < 1024 px; phone toggle kept; H kept |
| Search (addresses, towns, ZIPs, coordinates, fire names, results, "Showing …") | "Check an address" icon → popover search under the bar |
| Map controls (2D/3D, basemap + photo date, compass, zoom, Incident/area framing, orbit row + hint) | `bar` controls bottom-left above the timeline; + rotation (f) |
| Location card (near, official at point, model + run + quantiles, reasons, reliability, details, coverage, pin drag) | Readout: near, MODEL, official line; "More about this spot" holds the rest |
| Coordinate strip full (reported + selected, decimal, DMS, UTM, copy, centre, id, record time, selected time, datum) | Readout header, DMS/UTM line, rows; timeline label shows the selected time |
| Fire card for other fires (record, analysis, Prepare, Open, Play, Check, 3D, accuracy score) | Floats in the readout's place while open |
| Official now (evacuations, record, fire weather, local alerts; Show area; More) | Right column, one-line rows that expand |
| Data status (every source, stale, zone note), updates feed (filters, items, notes) | "View all updates" expands the right column |
| Compact timeline (play, stops, scrubber keys, lanes, markers, forecast info + warnings, freshness, clock, replay, zones) | Slim full-width timeline, same parts |
| Legend compact + details (every layer, forecast view mode, optional sources, photo date, buildings caveat) | Chips + scale above the timeline right; "Legend details" popover |
| Scale bar, credits, research note | Legend row; bottom line |
| Layers drawer (basemap, layers, source panels, forecast run, units, settings); Analysis drawer (charts, sources, accuracy score) | Unchanged, glass restyle |
| Map overlays, hover text, nearby perimeters, chips, zoom focus, official fits | Unchanged (pin colour `#9fd6ff`) |
| Notices (loading/build, errors, missing fire, not prepared, forecast pill, toasts, map notices) | Unchanged positions (top centre) |
| Keys: H, Space, ←/→, skip links, Escape order | Kept; + Q / E / N |

## 8. Tests at risk (update deliberately, in the same commit as the change)

- `src/map/overviewLayers.test.ts`: `markerRadius` 4-13 px by √acres; "bubbles are sized by the largest fire (log acres),
  not by the count" (`CLUSTER_RADIUS_EXPR` must not contain `point_count` — the handoff sizes groups by count);
  `overviewPaint` opacities; chip pill image and `icon-image`; style validity of every layer; draw order; label anchor
  offsets (`narrowLabelAnchorOffset`); `labelMinZoom`, `overviewLabel` strings. (H3+H4)
- `src/state/fireCard.test.ts`: reads `mapController.ts`, `SearchBox.tsx`, `OverviewCard.tsx` source: `openFireFromOverview`
  must call `showFireCard(id)` and not `requestMapFlyTo`; Public's direct fire view changes these paths. (H3+H4)
- `src/map/userInput.test.ts`: regexes over `mapController.ts` (the click handler with `consumeClick()` then
  `openFireFromOverview(fireId)`, the padding restart, `private fly`, `moveStart`/`moveEnd` handlers) and "every camera
  call inside `this.input.ours(`" (incl. `rotateTo`, `setBearing`, `resetNorth`). (H2 rotation, H3+H4 clicks)
- `src/ui/shell/FireCard.test.ts`: splits markup at `<section class="fc-official"`; asserts "StatusActive" (the `<dt>`
  "Status" directly before its value), "incident record", "record last edited …". A "value — LABEL" reorder breaks it. (H2)
- `src/ui/shell/OverviewPanel.test.ts`: `class="ov-list is-windowed"`, `aria-setsize/posinset`, no `<footer` in empty
  states, `PeekBar` markup `active fires</b> · …`, freshness strings, "70.0k ha". (H3+H4)
- `src/ui/shell/views.test.ts`: `VIEWS` names/order and `useCoordsVariant` full/compact/line. (H2)
- `src/map/basemapStyle.test.ts`: dark background `#0b1119`, `BUILDING_COLORS` equality, aerial `raster-saturation < 0`. (H2)
- `src/state/workspace.test.ts`: defaults (`overviewFilter 'season'`, panels, URL params) when fields are added. (H2)
- `src/ui/shell/officialSummary.test.ts`, `dataStatus.test.ts`, `location/describe.test.ts`, `CardParts.test.ts`,
  `OverviewCard.test.ts`, `extras/imageryChip.test.ts`, `ui/timeline/model.test.ts`: exact copy the new layouts reuse
  (keep the strings; restyle only). (H2, H3+H4)
- `src/ui/AnalysisTab.test.ts` (`<span class="muted mono">—</span>`, no `tone-*` classes), `RegionAccuracy.test.ts`
  (copy). (H5)
- `src/state/history.test.ts`, `fireActions.test.ts` if `openFireView` changes push/replace rules. (H3+H4)

## 9. Screenshot recipe

Run (your ports): `cd backend && FIRE3D_LIVE=0 uv run uvicorn fire3d.api.app:app --port <api>` and
`cd web && VITE_API_TARGET=http://localhost:<api> PORT=<vite> npm run dev -- --port <vite> --strictPort`. The fire lists
need outbound network (they loaded here: 203 active on 2026-10-24). Shots:
`cd web && node scripts/shot.mjs "<url>" ../docs/screenshots/brief4-<step>-<view>.png --w 1440 --h 1000 --wait <ms> --backend swiftshader`.

| View | URL (`http://localhost:<vite>` +) | Wait | Notes |
|---|---|---|---|
| Public overview (minimal) | `/` | 9000 | |
| Public overview (details) | `/` + `--eval "await new Promise(r=>setTimeout(r,4000)); window.__workspace.getState().setOverviewDetails(true)"` | 9000 | after H2 adds the action |
| Public fire view (real, past fire, 36 NIFC perimeters) | `/?incident=2025-lower-sugarloaf-569fb7` | 12000 | also `2025-trout-4fd248` |
| Public fire view (live, synthetic) | `/?incident=fixture-live` | 12000 | demo badge; forecast hidden in Public |
| Public fire view (unprepared; the mockup's fire) | `/?incident=2026-willow-548a8d` | 12000 | listed live fire, no bundle; a link never builds |
| Distance chip | add `--eval "…; window.__workspace.getState().setDevice({lat:47.42,lon:-120.31,accuracyM:30,tMs:Date.now()})"` | 12000 | Wenatchee, WA (~25 mi) |
| Command in a fire (live, forecast, timeline) | `/?incident=fixture-live&preset=command&sel=36.215,-121.43` | 12000 | readout + official + timeline |
| Command in a fire (real) | `/?incident=2025-lower-sugarloaf-569fb7&preset=command&sel=47.70,-120.48` | 12000 | no forecast run in local real bundles |
| Command overview | `/?preset=command` | 9000 | |
| Rotated map (2D) | add `&view=-120.55,47.70,10.5,35,0` | 12000 | one-shot `view=lon,lat,zoom,bearing,pitch` |
| Forensic | `/?incident=fixture-live&ws=forensic`, `/?incident=2025-lower-sugarloaf-569fb7&ws=forensic` | 25000 | needs `--quality low --shot-timeout 240000` (§2.11); without them the screenshot times out under SwiftShader |
| Phones | any of the above with `--w 390 --h 844 --dpr 2` | same | also `--w 1024 --h 768` |

Bundles: every real bundle in `data/incidents/` is a past fire with NIFC perimeters and **no forecast run**; only
`fixture-demo`, `fixture-east` and `fixture-live` (synthetic, demo badge) have one. `2026-bee-haven-2-24-06-de4697` is a
failed build (useful for the "preparation failed" state). Dev handles: `window.__store`, `__workspace`, `__mapRuntime`
(`framing === 'done'`), `__sceneStore`, `__mapChrome()`. Reduced motion: `--eval` cannot emulate it; use Playwright's
`emulateMedia({ reducedMotion: 'reduce' })` in a scratch script. Until H2's flags land, the planner's scratch script
(Chrome channel, `localStorage`/store quality low, `page.screenshot({ timeout: 240000 })`) produced the Forensic "before"
shots in ~50-65 s.

## 10. Risks

1. Contrast: lighter glass (.62-.74) and text on gradients over bright aerial photos may fall below 4.5:1 (decision l).
2. Hidden official information: collapsed Command rows and Public's minimal overview hide the national NWS list and the
   legend that explains the pink polygons by default (decisions d, i-6).
3. H3+H4 is the largest step (two views, markers, leader labels, locate-me, fire profile, phones); P1 cut line in §4.
4. Global CSS (`theme.css`, `controls.css`, `overlays.css`, `header.css`) edited by H5 while H3+H4 screenshots the map.
5. `mapController.ts` source-regex tests make camera and click changes brittle (§8).
6. The animated `feTurbulence` circle repaints its filter every frame (CPU); freeze under reduced motion, pause when hidden,
   and check a laptop's CPU use.
7. Leader labels and the fire-view leader are DOM over WebGL: they must follow pans, rotation and 3D tilt without lag;
   hide during zoom gestures.
8. Safari trackpad rotation cannot be verified in the cloud (Chrome only); Chrome on a Mac has no rotate gesture at all.
9. Forensic screenshots need the new `shot.mjs` flags; frame rates are not measurable under SwiftShader.
10. Changing Public's click flow and turning zoom focus off in Public changes brief-2 decision 10 behaviour; Back/history
    must stay correct (`state/history.ts`).

## 11. Orchestrator decisions (2026-10-24; these settle §6)

- **a. Public inside a fire: option A** as written (fire view, newest perimeter only, no model output, timeline,
  updates feed or picker in Public; search behind an icon; the card's model block replaced by the Command link;
  unprepared and no-perimeter states as written; time set to the latest observation on entry).
- **b. Click → fire view: option A** (direct `openFireView(id)`, one history push; zoom focus off in Public; Command and
  Forensic keep the fire card; group click zooms in).
- **c. Command overview: option A** (Main's layout with details shown, no "Show details" pill; built by H3+H4).
- **d. Show details: as recommended.** Pill count = fires the map shows for the current filter; the default filter stays
  `season`. List-down and missing-fire banners stay visible.
- **e. Markers: as recommended**, with groups sized by HANDOFF.md's formula `10 + 4.2·√n` (the written spec), capped at
  36 px. Group labels stay MapLibre text (Noto Sans); leader labels are the DOM overlay (P1 in H3+H4, but expected).
- **f. Rotation: as recommended** (buttons, compass drag with click = north up, Q / E / N, Safari gesture, Forensic 2D).
- **g. Globe dimming: option A** (CSS circular vignette following zoom; Public and Command, 2D and 3D; not Forensic).
- **h. Narrow screens: as recommended.**
- **i. Safety and feature conflicts: all twelve points as written.**
- **j. Map tint: option A** (basemap paint, never over fire, official or selection layers).
- **k. Heading kept** across 2D↔3D and the map↔Forensic hand-off.
- **l. Lighter glass: keep the handoff values, measure contrast, darken only where text fails 4.5:1.**
- **m. Drop the "≥ 75 % open map" target** for the handoff layouts; record `__mapChrome().unobstructed` per view.

H2 runs as three parts: **H2a** foundation (§4 H2 items 1-3 and 7: tokens, colour mirrors, fonts, TopBar family, Logo,
FixedCopy, Readout, MapWorkspace split into three chromes, CSS moves, `shot.mjs` flags), then in parallel **H2b**
Command in a fire (§3.2) and **H2c** rotation in Public/Command + MapAtmosphere + tint (§6 f, g, j, k for the map).
Ports: H2a and H2b API 8732 / Vite 5192; H2c 8740 / 5200; reviewers 8735 / 5195 and 8736 / 5196.
