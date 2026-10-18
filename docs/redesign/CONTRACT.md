# Map-first redesign: contract for the redesign agents

Written by the foundation agent on 2026-10-17. Authority: `docs/redesign/BRIEF.md` for UI behaviour, model
semantics, honesty, providers and attribution; `SPEC.md` for data contracts, coordinates, time and the HTTP API.
This file fixes how the four redesign agents (map-core, shell, location, timeline-feed) share state and talk to each
other. The app is **Fire-3d** (never "FireTrace"). Change an interface here only together with every agent that uses
it; additive changes (new optional fields, new helpers) are fine and must be noted in your report.

Everything below already exists in the repo as working code or a compiling skeleton. Skeleton files say so in their
header comment; their owner replaces them.

---

## 1. Ownership, ports, running and screenshots

| Agent | Owns (create / edit only these) | API port | Vite port |
|---|---|---|---|
| map-core | `web/src/map/**`, `web/src/lib/reproject.ts` (+ tests), `web/src/data/**` (from now on) | 8712 | 5181 |
| shell | `web/src/App.tsx`, `web/src/ui/shell/**`, `web/src/styles/**`, `web/index.html`; additive changes to `web/src/state/store.ts` and `web/src/state/workspace.ts` | 8713 | 5182 |
| location | `backend/fire3d/api/geocode.py`, `backend/tests/test_geocode.py`, `web/src/location/**`, `web/src/lib/geodesy.ts` (+ tests) | 8714 | 5183 |
| timeline-feed | `web/src/ui/timeline/**`, `web/src/ui/feed/**`, `web/src/lib/plainLanguage.ts` (+ tests), `web/src/ui/KeyEvents.tsx`, `web/src/ui/eventMeta.ts` | 8715 | 5184 |
| foundation (done) | `docs/redesign/CONTRACT.md`, `web/package.json`, `web/vite.config.ts` | 8719 | 5189 |

- Nobody edits `web/src/scene/**` or other existing Forensic UI files (`ui/Header.tsx`, `ui/RightPanel.tsx`,
  `ui/BottomDock.tsx`, `ui/Timeline.tsx`, `ui/Charts.tsx`, `ui/timelineModel.ts`, ...) in this round. Import them
  freely. `backend/fire3d/api/app.py` already mounts `geocode.router` and `extras.router`; do not edit it.
- `backend/fire3d/api/extras.py` (evacuation zones, cameras, recent imagery) belongs to a later optional-sources
  agent. Until its endpoints exist, the `evacuation`, `cameras` and `recentImagery` layers show an honest
  "not available" state.
- Packages are installed: `maplibre-gl@5.24.0`, `vitest@5.0.3` (dev). Nobody installs or upgrades anything.
- Tests: `npm test` (= `vitest run`, Node environment, no DOM/jsdom) picks up `web/src/**/*.test.ts`. Put pure logic
  in `.ts` files next to the code and test it there. Backend: `cd backend && uv run pytest tests/test_geocode.py`.

Run your piece (replace the ports with yours):

```bash
cd backend && FIRE3D_LIVE=0 uv run uvicorn fire3d.api.app:app --port 8712          # any bundle + /api/geocode
#   or: cd backend && uv run python scripts/serve_fixture.py --port 8712 --data-dir ../data   (fake jobs, aircraft)
cd web && VITE_API_TARGET=http://localhost:8712 PORT=5181 npm run dev
node scripts/shot.mjs "http://localhost:5181/?incident=fixture-demo" ../docs/screenshots/redesign-map-core-demo.png --wait 9000 --w 1440 --h 900
```

- Bundles: `fixture-demo` (EPSG:32611, synthetic, real coordinates near Altadena), `fixture-live` (EPSG:32610,
  synthetic, Santa Lucia Range) and `2025-eaton-fire-dbfa57` (real, EPSG:32611, one 72 h forecast). More real
  bundles appear as the backend integrator publishes them.
- Useful URL parameters: `incident`, `t` (epoch ms), `mode`, `ws=map|forensic`, `preset=command`, `persp=3d`,
  `basemap=roads|aerial`, `units=metric`, and the one-shot test inputs `view=lon,lat,zoom[,bearing,pitch]` and
  `sel=lat,lon` (§2.3).
- Dev handles for `shot.mjs --eval`: `window.__store` (main store), `window.__workspace` (workspace store),
  `window.__sceneStore` (Forensic scene). Example:
  `--eval 'await new Promise(r=>setTimeout(r,6000)); window.__workspace.getState().setPerspective("3d")'`.
- Save final screenshots as `docs/screenshots/redesign-<role>-*.png`. Public map services are for normal
  interactive use only: a few page loads per check, never loops or prefetching.
- Keep the progress log `docs/redesign/progress/<role>.md` (done / next / decisions / open problems).

---

## 2. State model

Two zustand stores. Neither knows about the other's internals except where listed.

**Main store** `web/src/state/store.ts` (unchanged): incident and catalog, live/historical data context `mode`,
manifest and bundle JSON, selected forecast run (`forecastRunId`, `forecast`), timeline (`timeMs`, `playing`,
`timeWindow`), Forensic view state (`viewMode`, `visualStyle`, `layers`, ...), `selectedEventId`, and the Forensic
fly-to request `flyTo: { x, z, distance?, nonce }` (incident-local metres). Do not overload `mode`.

**Workspace store** `web/src/state/workspace.ts` (`useWorkspace`, implemented, tested in `workspace.test.ts`):

```ts
export type Workspace = 'map' | 'forensic'            // 'map' = Public/Command
export type Preset = 'public' | 'command'
export type Perspective = '2d' | '3d'                 // the map's perspective; Forensic keeps store.viewMode
export type Basemap = 'dark' | 'roads' | 'aerial'
export type Units = 'us' | 'metric'
export type SelectionSource = 'click' | 'coords' | 'address' | 'event' | 'incident'

export interface SelectedLocation {
  lat: number; lon: number; source: SelectionSource
  label?: string            // matched address, event title or incident name (absent -> show coordinates)
  matchedAddress?: string   // Census matchedAddress
  approximate?: boolean     // interpolated address, estimated event location
  adjustable?: boolean      // pin may be dragged (addresses)
  eventId?: string          // source 'event'
  adjusted?: boolean        // set by moveSelection after a drag
}
export interface GeoView { centerLon: number; centerLat: number; zoom: number; bearing: number; pitch: number }
export interface MapFlyTo { lon: number; lat: number; zoom?: number; bounds?: [number, number, number, number]; nonce: number }
export type PanelKey = 'updates' | 'analysis' | 'layers'          // ui-integration: unused 'search' removed
export type MapLayerKey = 'observed' | 'detections' | 'perimeters' | 'forecast' | 'selection' | 'events'
                        | 'evacuation' | 'cameras' | 'recentImagery'
export interface SafeInsets { top: number; right: number; bottom: number; left: number }

interface WorkspaceState {
  workspace: Workspace                     // default 'map'
  preset: Preset                           // default 'public'
  perspective: Perspective                 // default '2d' (north-up)
  basemap: Basemap                         // default 'dark'; independent of the preset
  units: Units                             // default 'us' (mph, ft, mi, °F, acres)
  selection: SelectedLocation | null
  view: GeoView | null                     // last settled map view; null = frame the incident on mount
  mapFlyTo: MapFlyTo | null
  panels: Record<PanelKey, boolean>        // default updates open, others closed
  mapLayers: Record<MapLayerKey, boolean>  // default all on except cameras, recentImagery
  safeInsets: SafeInsets                   // published by the shell

  setWorkspace(w): void; setPreset(p): void; setPerspective(p): void; togglePerspective(): void
  setBasemap(b): void; setUnits(u): void
  selectLocation(loc: SelectedLocation, opts?: { fly?: boolean; zoom?: number }): void  // invalid lat/lon ignored
  moveSelection(lat: number, lon: number): void   // keeps label/source; adjusted = true, approximate = false
  clearSelection(): void
  setView(v: GeoView): void
  requestMapFlyTo(req: Omit<MapFlyTo, 'nonce'>): void   // nonce = previous + 1
  returnToIncident(): void                             // AOI bounds, else reported coordinates (zoom 12)
  setPanel(key, open): void; togglePanel(key): void
  setMapLayer(key, visible): void; toggleMapLayer(key): void; resetMapLayers(): void
  setSafeInsets(i: SafeInsets): void                   // no-op when unchanged
}
// helpers: parseWorkspaceParams(search), writeWorkspaceParams(url, state), isDemoBundle(id, manifest?),
//          incidentFlyTo(summary, manifest), useWorkspaceUrlSync(enabled), DEFAULT_MAP_LAYERS, DEFAULT_PANELS
```

### 2.1 Where each concept lives
| Concept | Field |
|---|---|
| Workspace | `useWorkspace.workspace` |
| Preset | `useWorkspace.preset` (CSS: `html[data-preset]`) |
| Data context (live / historical) | `useStore.mode` (unchanged) |
| Perspective | `useWorkspace.perspective` (map); Forensic keeps `useStore.viewMode` |
| Visual style (Forensic) | `useStore.visualStyle` |
| Incident, forecast run, timeline time | `useStore.incidentId`, `forecastRunId`/`forecast`, `timeMs` |
| Selected point | `useWorkspace.selection` |
| Selected event | `useStore.selectedEventId` |

`App.tsx` mirrors workspace, preset and perspective onto `<html data-workspace data-preset data-perspective>`.

### 2.2 Invariants
- Switching workspace, preset or perspective never changes the incident, data context, forecast run, timeline time
  or selection. Basemap changes keep overlays, timeline, selection and attribution.
- When `useStore.incidentId` changes, the workspace store drops `view` (the map frames the new incident) and drops a
  selection whose source is `'event'` or `'incident'`; user-picked points (`click`, `coords`, `address`) stay.
- A map click selects without flying; search results, pasted coordinates and "Check this location" select with
  `{ fly: true }`.

### 2.3 URL
`useWorkspaceUrlSync` keeps `ws` (always), `preset`, `persp`, `basemap`, `units` (non-defaults) in the address bar
with `replaceState`, next to the existing `incident`/`t`/`mode`. `view=` and `sel=` are read once at start-up (deep
links, screenshots) and then removed: shared links never carry the user's selected point or view (privacy). Old
links without `ws` open the Public map.

---

## 3. Workspaces, layout and the shell (shell)

- `App.tsx` mounts **only the active workspace**. Forensic = today's UI unchanged plus a small workspace switch
  (`.fx-ws-switch`, top-left under the compass) until the shell gives Forensic a better place for it. Leaving a
  workspace unmounts it: the R3F canvas disposes its renderer, `MapView` must call `map.remove()`. No hidden
  instances, no background rendering.
- Switch workspaces only through `switchWorkspace(target)` (`web/src/ui/shell/handoff.ts`). It hands the camera over:
  - map -> Forensic: if the map centre is inside the AOI, `useStore.flyToLocal(x, z, distance)` with the same ground
    resolution (CameraRig fov 35°); repeated once right after the incident's Forensic assets first load (CameraRig
    frames the fire on a first visit). Outside the AOI: `flyTo = null`, Forensic frames the fire.
  - Forensic -> map: `useWorkspace.view` from `sceneStore.camera` (target -> lon/lat, metres per pixel -> zoom;
    bearing / pitch only when the map perspective is 3D).
  - Helpers: `metersPerPixel(zoom, lat)` (MapLibre 512 px world), `zoomForMetersPerPixel`, `forensicDistance`.
  - Verified: map view (-118.06, 34.19, z 13.5) -> Forensic target (909.7, 1118.1) m, distance 9571 m; Forensic
    target (570, 225) -> map centre (-118.0638, 34.1980), z 12.15.
- Map workspace mount points (in `App.tsx` `MapWorkspace`, classes in `styles/map-layout.css`):

| Slot | Component (owner) |
|---|---|
| `.mw-map` (full-bleed, bottom layer) | `MapView` (map-core), lazy-loaded default export |
| `.mw-header` | `MapHeader` (shell): logo, incident picker, workspace + preset switches, demo badge, Analysis / Layers toggles |
| `.mw-search` | `SearchBox` (location) |
| `.mw-controls` | `MapControls` (map-core) |
| `.mw-updates` | `UpdatesPanel` container (shell) wrapping `UpdatesFeed` (timeline-feed) |
| `.mw-card` | `LocationCard` (location) |
| `.mw-coords` | `CoordinateStrip` (location), always visible |
| `.mw-timeline` | `CompactTimeline` (timeline-feed) |
| free | `MapLegend`, `MapAttribution` (map-core), `LayersPanel`, `AnalysisDrawer` (shell), shared `StatusOverlay`, `ErrorBanner`, `NoLiveNotice`, `ForecastPill`, `Toasts`, `TooltipLayer` |

- **Safe area** (shell, `useMapSafeArea`): the map area not covered by chrome, re-measured on resize and whenever a
  panel opens or closes, published twice: CSS vars `--safe-top/right/bottom/left` on `<html>` (the same names the
  Forensic shell uses; tooltips, popups, overlays) and `useWorkspace.safeInsets` (map padding). Target ≥ 75 %
  unobstructed map at 1440×900 with no drawer open (BRIEF §6).
- Narrow screens (shell): drawers / bottom sheets; search, coordinates and timeline stay reachable; default panels
  never cover most of the map. Keyboard access and `prefers-reduced-motion` everywhere.
- Command preset: shell, location and timeline-feed make coordinates, source timestamps, incident identifiers and the
  selected point more prominent (style on `html[data-preset='command']` or read `preset`); no Forensic effects.
- Demo badge: `isDemoBundle(incidentId, manifest)` (fixture ids or synthetic data sources) -> "Demo · simulated data".
- Analysis drawer: the existing `FireAreaChart`, `RosChart`, `ProfileChart` from `ui/Charts.tsx`, closed by default
  (`panels.analysis`). Optional optimisation for the shell: lazy-load the drawer and the Forensic workspace so
  three.js (pulled in by `ui/Charts.tsx` -> `lib/raster.ts`) leaves the Public start-up bundle.

### 3.1 Shell implementation notes (shell, added 2026-10-17; additive)
- Every floating region of the map workspace is a `[data-chrome="<name>"]` element; CSS gives it `--chrome-side`
  (`top | right | bottom | left | none`, per breakpoint) and `useMapSafeArea` turns the docked ones into the safe
  insets (`ui/shell/layout.ts`, tested). A new floating element only needs those two attributes to be accounted for.
  Dev handle: `window.__mapChrome()` -> `{ insets, unobstructed, items }`.
- Layout vars on `.mw`: `--mw-bottom-stack` (height of the bottom row), `--mw-drawer-space` (open Analysis drawer),
  `--mw-coords-col` (coordinate column: Public `fit-content(280px)`, Command `minmax(0, max-content)`). State classes
  on `.mw`: `is-collapsed` ("H" hides updates, card, legend and drawers), `has-updates`, `has-drawer`, `has-selection`,
  `has-sheet` (phone sheet open).
- `.mw-coords` is rendered by `ui/shell/CoordsSlot.tsx`. On phones (<= 760 px) in Command it starts clamped to the
  first `.loc-coord` block (the reported location with its copy buttons) with a toggle; focus entering the hidden part
  opens it. Public and wider screens are never clamped.
- Phones: updates closed by default, one bottom sheet at a time (updates / layers / analysis), the card hides while a
  sheet is open, the legend moves into the Layers sheet; the header gets icon toggles and a menu (workspace, preset,
  panels). 761-1279 px: icon-only Analysis / Layers, no Command ID chip (the strip shows the identifier).
- Drawers are non-modal: opening one focuses its heading, Escape closes the newest one and focus returns to its toggle;
  skip links (search, timeline, map); the map comes after the chrome in tab order. Layers opens below the top row so
  the map controls stay usable.
- Tokens now: header 44 px (phones 48), updates 304 px (Command 324), compact updates list 212 px, card 300 px,
  timeline 620 px / min 480 (<= 1279 px: 520 / 420). Default view at 1440x900 (no point selected, no drawer):
  Public 75.1-76.8 % unobstructed on all 10 bundles in `data/incidents`; Command 62.5-66.0 % (data-status block and
  full coordinate strip, by design); 1920x1080 Public 84.2 % (shell report, re-measured 2026-10-17 21:50).
- `.mw-note` (research-prototype note) and the credits sit on dark chips so they stay readable on Roads and aerial.

---

## 4. Map (map-core)

### 4.1 MapView
`export function MapView(): JSX.Element` + `export default MapView` in `web/src/map/MapView.tsx`. The skeleton is a
working minimal map (OpenFreeMap dark style, view restore/write, click selection, pin, fly-to, perspective pitch,
basemap swap). map-core owns the real implementation:
- Container: the root element is sized `width: 100%; height: 100%` (maplibre-gl.css forces `position: relative` on
  the map container, so `position: absolute; inset: 0` does not size it).
- On mount: restore `useWorkspace.view` if set, else frame the incident (`incidentFlyTo` / AOI). On `moveend`:
  `setView(...)` (settled views only, never per frame). On unmount: `map.remove()`.
- Follow only nonces issued **after** mount (remember the current nonce at mount):
  - `useWorkspace.mapFlyTo`: `bounds` -> fit inside the safe area; else ease/fly to `lon, lat, zoom`.
  - `useStore.flyTo` (local x/z, the existing Forensic request used by events): convert with the manifest grid
    (`localToLonLat`) and fly there in both perspectives, keeping pitch/bearing in 3D.
- Incident change while mounted: frame the new incident.
- Clicks: `selectLocation({ lat, lon, source: 'click' })` with the terrain-correct position in 3D. Clicking an event
  marker calls `selectFeedItem` (§8); other features may open text-only popups.
- Selection pin: cyan (`--m-select`), label `selection.label ?? coordinates`, an "approximate" treatment when
  `approximate`; draggable only when `adjustable`, `dragend` -> `moveSelection(lat, lon)`.
- Perspectives: `2d` = top-down, north-up by default; `3d` = Mapterhorn terrain + oblique camera. Transitions keep the
  geographic centre and the selection. If terrain fails, stay usable as a flat map and say so.
- Padding: apply `useWorkspace.safeInsets` (e.g. `map.setPadding`) so centring and framing use the visible area.
- Respect `prefers-reduced-motion` (duration 0) and keep wildfire overlays below road / place labels.

### 4.2 Providers (`web/src/map/providers.ts`)
All endpoints are overridable with `VITE_*` variables and need no key: OpenFreeMap styles
(`https://tiles.openfreemap.org/styles/{liberty,dark,positron,bright}`, vector tiles maxzoom 14), Mapterhorn
TileJSON (`https://tiles.mapterhorn.com/tilejson.json`: Terrarium webp, 512 px), USGS Imagery Only
(`.../USGSImageryOnly/MapServer/tile/{z}/{y}/{x}`, 256 px, dated orthoimagery, never "live satellite"). Every
provider can fail: show an honest state (basemap / terrain / imagery unavailable) and keep the rest working.

### 4.3 Wildfire overlays (BRIEF §4)
- Rasters (observed arrival, forecast) come from `web/src/data/rasters.ts` (§10) and are reprojected from the
  incident's UTM grid to Web Mercator image/canvas overlays: never stretch the axis-aligned `bbox_lonlat`. Row 0 =
  north, col 0 = west, pixel (r, c) centre at `e = minx + (c + .5)·res`, `n = maxy − (r + .5)·res`; keep nodata
  transparent; use `manifest.grid.utm_zone` (10 or 11). `aoiCornersLonLat(grid)` in `lib/reproject.ts` gives the
  true AOI quadrilateral. Cache reprojection mappings per incident/grid; recompute colours only when time, forecast
  or layer state changes. Prove alignment (interior points + all AOI edges, both UTM zones) with tests.
- Native vector layers: perimeters (local rings -> lon/lat), detections, incident marker (reported location, not
  "ignition point"), selection, geolocated events, AOI boundary ("Outside modeled area" beyond it).
- Forecast display at timeline time t: `arrival_pK <= t` is exact for "at least K % of model runs had reached this
  point" (K = 10, 50, 90); `burn_probability` is the member fraction by the end of the horizon. Never interpolate
  other probabilities from the three quantiles (§5.2).
- Legends name every layer and use line style / fill pattern, not colour alone.

### 4.4 Attribution and a security rule
- Keep `attributionControl: false` and render credits with `MapAttribution` as React text and links (current
  credits: OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors, © Mapterhorn when terrain is on, USGS imagery
  when aerial is on, MapLibre). Reason: maplibre-gl 5.x passes provider attribution HTML through `DOM.sanitize()`,
  which has a critical bypass (GHSA-jrc7-96c5-q579, fixed only in 6.5+); with the control off that code never runs.
  If you show TileJSON attribution, convert it to text (DOMParser -> textContent, allow-listed `https:` links).
- Never pass provider, API or user strings to `Popup.setHTML()`; use `setText()` / `setDOMContent()`.

---

## 5. Location checks (location)

### 5.1 Selection and coordinates
- Search box: pasted coordinates (`parseLatLon` in `lib/geodesy.ts`) -> `{ source: 'coords' }`; local incident
  names from the catalog -> `selectIncident`; otherwise an explicitly submitted US street address -> `/api/geocode`
  -> `{ source: 'address', label, matchedAddress, approximate: true, adjustable: true }` with `{ fly: true }`.
  No autocomplete, no POI search, no Nominatim. Coordinates and map clicks work without the geocoder.
- Coordinate strip (always visible, also with panels collapsed): the incident's **reported location** (never "the
  ignition point") and, separately, the selected point; WGS84 decimal degrees, labelled, with copy buttons; larger
  and with the incident id and timestamps in Command.

### 5.2 Model semantics (all agents)
- `burn_probability` = fraction of ensemble members that burned the pixel by `start_ms + horizon_h` (whole horizon).
  Say "by <end time> (<horizon> h after <start>)"; never relabel it as "next 24 h".
- `arrival_p10/p50/p90` = per-pixel order-statistic percentiles of arrival across members, members that never arrive
  counting as +∞; `arrival_pK <= t` exactly when at least K % of members burned the pixel by t. They are arrival-time
  quantiles, not wind scenarios; P90 is not a "worst case".
- NEVER (1e6, `NEVER_MIN = 999000` in `data/rasters.ts`) = never burned / not reached. nodata = no value. Outside the
  AOI = unknown, never "low risk". Missing forecast = say so. Probabilities describe the model ensemble.
- The nearest satellite detection is context, never "the fire front". Wind directions are meteorological FROM
  directions. Qualitative risk words only with documented thresholds.

### 5.3 Location check (`web/src/location/types.ts`, `locationCheck.ts`)
`export function checkLocation(input: LocationCheckInput): LocationReport` (pure). Types (abridged; the file is the
source of truth):

```ts
type ModelGap = 'no_bundle' | 'outside_modeled_area' | 'no_forecast' | 'nodata' | 'loading' | 'error'
interface LocationRasters { observedArrival, elevation, fuel, burnProbability, arrivalP10, arrivalP50, arrivalP90: RasterSlot }
interface LocationCheckInput {
  point: SelectedLocation; timeMs: number; nowMs: number
  summary: IncidentSummary | null; manifest: IncidentManifest | null   // ready manifest or null
  perimeters: Perimeter[]; detections: Detection[]; weather: WeatherFile | null
  forecast: ForecastManifest | null; rasters: LocationRasters
}
interface LocationReport {
  point: { lat; lon; label; source; locationType; approximate; adjusted }
  modeledArea: 'inside' | 'outside' | 'no_bundle'
  local: { x: number; z: number } | null
  perimeter: { state: 'none'; reason: 'no_perimeters' | 'none_before_time' | 'no_bundle' }
           | { state: 'ok'; inside; distanceM; directionDeg | null; perimeterTimeMs; perimeterSource; perimeterAcres; ageMs }
  observedFire: { state: 'gap'; gap } | { state: 'not_burned'; asOfMs } | { state: 'burned'; arrivalMs }
  nearestDetection: { state: 'none' } | { state: 'ok'; distanceM; directionDeg; tMs; instrument; satellite; footprintM; ageMs }
  forecast: { state: 'gap'; gap }
          | { state: 'ok'; runId; issuedMs; startMs; endMs; horizonH; members; ensemble
              burnProbability: { state: 'value'; fraction } | { state: 'nodata' }
              arrival: { p10, p50, p90: { state: 'time'; ms } | { state: 'not_reached' } | { state: 'nodata' } }
              reachedShareAtTime: 0 | 10 | 50 | 90 | null }
  wind: { state: 'none' } | { state: 'ok'; tMs; speedMs; gustMs; fromDeg; isForecast; source; where: 'fire' | 'point' }
  terrain: { state: 'gap'; gap } | { state: 'ok'; elevationM; slopePct; aspectDeg; fuelCode; fuelLabel; burnable }
  sources: { name; kind: 'observation' | 'estimate' | 'model' | 'official' | 'reference'; timeMs; detail }[]
  caveats: string[]; timeMs: number; computedAtMs: number
}
```
- "Latest observed perimeter" = newest perimeter with `t_ms <= timeMs`; distance and direction from real geometry
  (local metres; direction relative to true north: correct for UTM grid convergence or state the approximation).
- Sample the original scientific grids (`sampleArrival`, `sampleLayer`), never the reprojected display images.
- Label approximations (address interpolation, reconstructed arrival). One point check never clears a route or area;
  route / polygon analysis is separate work.

---

## 6. Geocode endpoint (location)

`GET /api/geocode?q=<one-line US street address>` in `backend/fire3d/api/geocode.py` (router already mounted).

- Upstream: the Census Geocoder `locations/onelineaddress` endpoint (no geographies lookup) with the current
  documented benchmark (`Public_AR_Current` unless the docs say otherwise), `format=json`; a short timeout; an
  identifying User-Agent; no API key.
- 200 response (snake_case, mirrored by `GeocodeResponse` in `web/src/location/types.ts`):
  ```json
  {"query": "...", "matches": [{"matched_address": "...", "lat": 34.2, "lon": -118.1, "tiger_line_id": "...", "side": "L"}],
   "benchmark": "Public_AR_Current", "source": "U.S. Census Bureau Geocoder",
   "attribution": "Address search: U.S. Census Bureau Geocoder (positions interpolated along address ranges)",
   "cached": false, "fetched_ms": 0}
  ```
  `matches` may be empty (200) or hold several candidates (list them; never pick silently when ambiguous).
- Errors (`{"detail": "..."}`): 400 empty or > 200 characters; 429 when the proxy's own rate limit trips; 502 upstream
  error or unparseable reply; 504 upstream timeout. Never echo secrets or full upstream bodies.
- Caching: in-process LRU keyed by the normalised query (trim, collapse spaces, case-fold), ~24 h TTL, bounded size;
  `cached: true` on hits; `Cache-Control: private, max-age=3600`. Coordinates are never sent upstream.
- Frontend: `geocodeAddress(query, opts?)` in `web/src/location/geocodeClient.ts`.
- As built (location agent): additive fields `total_matches` (candidates before the 10-match limit), `note`
  (plain-language accuracy note) and per match `from_address` / `to_address` (the TIGER/Line house-number range).
  Cache: 30 days, keyed by the normalised query, in memory (bounded LRU) and on disk through `fire3d.http`; cache
  misses are limited to 30 upstream requests per minute per process (then 429 with `Retry-After`). Queries that
  look like coordinates get 400 (the browser parses coordinates itself; they are never sent upstream).

---

## 7. Compact timeline (timeline-feed)

`web/src/ui/timeline/model.ts`:

```ts
export const STALE_AFTER_MS = 6 * 3_600_000   // live: latest observation older than this is stale (document changes)
export type StopId = 'past' | 'now' | 'h24' | 'h48' | 'h72'
export interface TimelineStop { id: StopId; label: string; tMs: number | null; kind: 'observation' | 'now' | 'forecast'; available: boolean; reason: string | null }
export interface TimelineSegment { kind: 'observed' | 'forecast'; startMs: number; endMs: number }
export interface CompactTimelineModel {
  mode: Mode; startMs: number; endMs: number; segments: TimelineSegment[]
  latestObservationMs: number; nowMarkerMs: number | null; wallClockMs: number
  forecast: { runId: string; issuedMs: number; startMs: number; endMs: number; horizonH: number } | null
  stops: TimelineStop[]; stale: { isStale: boolean; ageMs: number; thresholdMs: number }
  currentMs: number; currentKind: 'observation' | 'forecast' | 'beyond'
}
export function buildCompactTimeline(manifest: IncidentManifest, forecast: ForecastManifest | null, timeMs: number, wallClockMs: number): CompactTimelineModel
```
- Stops: Past; NOW in live mode (= latest observation, labelled apart from the actual current time) or
  "Forecast start" in replay (hindcast start; never implies the present); +24/+48/+72 h only when the selected
  forecast's horizon covers them, else disabled with a reason. Observations and forecast look different.
- Show the forecast issue time and the valid time (the timeline time) whenever a forecast period is shown.
- Keep playback (`useStore.playing`, `usePlayback`), historical replay and the arrow / space shortcuts.
- `CompactTimeline` (`export function CompactTimeline()`) renders in `.mw-timeline`.
- As built (timeline-feed, additive): `buildCompactTimeline(..., opts?: { forecastRunId })`; extra model fields
  `trackEndMs`, `unavailable` (disabled forecast hours: live without a forecast, horizon < 72 h), `anchorMs`,
  `inForecastPeriod`, `leadH`, `forecastStatus`, `forecastNotes`, `checkedMs`; stops carry `posMs` + `description`.
  While live data is stale (latest observation > `STALE_AFTER_MS` before the clock) the NOW stop reads "Latest data"
  (old data is never called "now"); the current time is shown separately with its own track mark. Pure helpers:
  `describeTime`, `clampToData`, `activeStop`, `trackScale` (piecewise-linear, readable +24/+48/+72 h),
  `spreadLabels`, `labelsCoverPoints`.

---

## 8. Updates feed and plain language (timeline-feed)

`web/src/ui/feed/types.ts`:

```ts
export type FeedKind = 'observation' | 'estimate' | 'model' | 'official' | 'annotation'
export type FeedTopic = EventKind | 'detection' | 'perimeter' | 'forecast' | 'evacuation' | 'weather' | 'imagery' | 'camera'
export interface FeedItem {
  id: string; topic: FeedTopic; kind: FeedKind; tMs: number; title: string; detail: string | null
  source: string; automated: boolean; key: boolean
  confidence: 'observed' | 'estimated' | 'probable' | null
  location: { lon: number; lat: number; x: number; z: number } | null
  seekable: boolean; eventId: string | null
}
```
`web/src/ui/feed/feedModel.ts`: `buildFeedItems({ manifest, events, annotations }): FeedItem[]` (chronological)
and **`selectFeedItem(item: FeedItem): void`**, the single selection action for the feed, map event markers and
timeline markers: pause; seek to `tMs` when `seekable` (clamped to the timeline); `setSelectedEventId(eventId ?? id)`;
when geolocated, `useStore.requestFlyTo(x, z)` — the existing Forensic nonce, which `MapView` also follows, so the
fly works in 2D, 3D and Forensic. Items without coordinates stay selectable without an invented target. Selecting
an event does not replace the user's selected point; a "Check this location" action may call
`selectLocation({ lat, lon, source: 'event', eventId, label: title, approximate: confidence !== 'observed' }, { fly: true })`.
- Every item shows a plain title, useful detail, timestamp, source and its kind; automated items are never
  presented as human reporting. Key Events leave the Forensic dock only in Public/Command; Forensic keeps its list.
- `UpdatesFeed` (`export function UpdatesFeed()`) renders inside the shell's `UpdatesPanel`.
- As built (timeline-feed, additive): `UpdatesFeed({ extraItems? })` merges FeedItems from other producers (§12.3
  item 5; `FeedInput.extra`, repeated ids and invalid times dropped; memoise the array). `FeedInput` also takes
  `timeseries`, `weather`, `perimeters`, `detections` (one item per VIIRS / MODIS / Landsat pass), `forecast`,
  `units`; `FeedItem` adds optional `seekMs`, `original`, `facts`, `approximate`, `locationLabel`. Not seekable =
  current status: never dimmed as "later" in live mode; in replay it is listed only with the later updates. The
  first batch of a separately loaded topic (`LATE_TOPICS`: evacuation, camera, imagery, weather) is not marked
  "New". The list is one Tab stop (roving focus: ↑/↓, Home/End, Enter). Live default filter "All", replay "Key
  events" (events.json, notes and any `key` extra item). An ignition event that is only CAL FIRE's reported start
  (source "CAL FIRE", not moved or confirmed by satellites) is "Fire start reported", kind official, not automated;
  a start moved or confirmed by satellite detections stays estimate / observation and automated.

`web/src/lib/plainLanguage.ts` (signatures; everyday units from `units`, original values in `scientific`):

```ts
export interface PlainValue { text: string; value: number | null; unit: string; scientific: string | null }
export function spreadSpeed(chainsPerHour: number | null | undefined, units: Units): PlainValue
export function windSpeed(speedMs: number | null | undefined, units: Units): PlainValue
export function windFrom(fromDeg: number | null | undefined): string
export function windSummary(speedMs, fromDeg, gustMs, units: Units): PlainValue
export function fireWeatherSeverity(ffwi: number | null | undefined): PlainValue & { explanation: string }
export function temperature(c: number | null | undefined, units: Units): PlainValue
export function distance(m: number | null | undefined, units: Units): PlainValue
export function area(acres: number | null | undefined, units: Units): PlainValue
export function elevation(m: number | null | undefined, units: Units): PlainValue
export function directionWord(deg: number): string
export function relativeTime(ms: number, nowMs: number): string
export function forecastPeriod(f: Pick<ForecastManifest, 'start_ms' | 'horizon_h'>): string
export function burnProbabilityText(fraction: number, f: Pick<ForecastManifest, 'start_ms' | 'horizon_h'>): string
```
"Spread speed" replaces ROS / chains per hour, "Fire weather severity" explains FFWI, "Activity lattice" / "Slope
lattice" name the lattice; scientific names, units and values stay in details and in Forensic.
As built (timeline-feed, additive): `fireWeatherSeverity` shows "42 of 100" + `explanation` and no category (no
official or peer-reviewed FFWI category scale was found; NOAA SPC's old "FFWI >= 50 appears significant" note is a
rule of thumb). Also `growthRate`, `cardinalWord`, `forecastLead`, `forecastDescription` (title, period, issued,
runs, probability, uncertainty, weather, caveat), `modeledArea`, `ensemblePhrase`, `weatherSourceName`,
`sourceName`, `LATTICE_NAMES` / `latticeName` (name + explanation + scientific name), `EXPLAIN` (shared one-line
explanations), `keepUnits` (no-break space between a number and h / min / days); `burnProbabilityText` takes an
optional member count.

---

## 9. Design tokens (`web/src/styles/map-tokens.css`, shell owns)

All Public/Command tokens start with `--m-`; Forensic keeps `theme.css`. Under `html[data-workspace='map']` the
generic `--text*`, `--glass*`, `--hairline*`, `--focus-ring`, `--bg-0`, `--bg-gradient`, `--font-*` point at them, so
reused controls match.

| Group | Tokens (initial values) |
|---|---|
| Surfaces | `--m-bg #0b1119`, `--m-bg-2 #111a25`, `--m-panel rgba(14,21,30,.88)`, `--m-panel-strong .96`, `--m-panel-soft .70`, `--m-panel-raised rgba(24,34,47,.97)`, `--m-panel-blur blur(12px) saturate(140%)`, `--m-border rgba(148,178,210,.16)`, `--m-border-strong .30`, `--m-hover .09`, `--m-radius 10px`, `--m-radius-sm 6px`, `--m-shadow` |
| Text | `--m-text #e8edf3`, `--m-text-2 #a7b3c0`, `--m-text-3 #74818f`, `--m-text-inverse #0b1119` |
| UI accent | `--m-accent #5b9dff`, `--m-accent-bg #27476b`, `--m-accent-bg-hover #30577f`, `--m-focus-ring` |
| Selection (cyan) | `--m-select #22d3ee`, `--m-select-strong #67e8f9`, `--m-select-soft rgba(34,211,238,.18)` |
| Observed fire | `--m-fire-observed #ff5a1f` (solid outline), `--m-fire-observed-fill rgba(150,36,16,.45)`, `--m-fire-observed-glow`, `--m-fire-front #ffb066`, `--m-perimeter #ff7849`, `--m-perimeter-old` |
| Forecast | `--m-forecast #f5a524` (dashed outline), `--m-forecast-fill rgba(245,165,36,.24)`, `--m-forecast-hatch .60` (diagonal hatch) |
| Detections | `--m-detection #ffd84a` (point / footprint with dark stroke), `--m-detection-stroke #6b1f00`, `--m-detection-old #c27a3a` |
| Evacuation (official) | `--m-evac-order #e0459b`, `--m-evac-warning #a78bfa`, `--m-evac-other #7aa2f7` (cross-hatch + official wording) |
| Other map | `--m-aoi rgba(232,237,243,.55)` (dashed modeled-area edge), `--m-event #f0f4f8` |
| Status | `--m-ok #4ade80`, `--m-warn #fbbf24`, `--m-danger #f87171`, `--m-info #60a5fa`, `--m-stale #fbbf24`, `--m-demo #f5b83d` (+ `-bg`, `-border`) |
| Type | `--m-font-ui` Inter, `--m-font-mono` JetBrains Mono (tabular numbers for coordinates and times), `--m-fs-xs 11px` … `--m-fs-xl 18px` |
| Layout | `--m-gap 12px`, `--m-header-h 52px`, `--m-search-w 400px`, `--m-updates-w 320px`, `--m-card-w 300px`, `--m-timeline-w 620px`, `--m-drawer-h 300px`, `--m-z-map/chrome/drawer/header 0/10/15/20` |

MapLibre paint properties cannot read CSS variables: map-core mirrors the colours it needs in one TS constant next
to the style code and keeps them equal to these tokens.

---

## 10. Shared CPU rasters (`web/src/data/rasters.ts`, map-core owns from now on)

Three.js-free (only `import type` from `lib/raster.ts`), tested in `rasters.test.ts`. Same files, URLs and
cache-busting versions as `lib/raster.ts`; values are the stored scientific arrays (`LoadedLayer`: `name, url, info:
LayerInfo, data: Float32Array | Uint8Array | Uint16Array | Int16Array, width, height`).

```ts
export function loadIncidentRaster(manifest: IncidentManifest, name: string, opts?: FetchOptions): Promise<LoadedLayer>
export function loadForecastRaster(manifest: IncidentManifest, forecast: ForecastManifest, name: ForecastLayerName, opts?: FetchOptions): Promise<LoadedLayer>
export function incidentRasterUrl(manifest, name): string | null;  export function forecastRasterUrl(manifest, forecast, name): string | null
export function clearCpuRasterCache(match?: string): void;          export function cpuRasterCacheStats(): { entries: number; bytes: number }
export type SlotStatus = 'loading' | 'ready' | 'missing' | 'error'  // missing = not in this bundle / no forecast run
export interface RasterSlot { status: SlotStatus; layer: LoadedLayer | null; error: string | null }
export interface RasterRequest { incident?: readonly string[]; forecast?: readonly ForecastLayerName[] }
export interface RasterSet { key: string; manifest; forecast; incident: Record<string, RasterSlot>; forecastLayers: Partial<Record<ForecastLayerName, RasterSlot>>; loading: boolean }
export function useRasterSet(req: RasterRequest): RasterSet               // store's ready manifest + selected forecast
export function loadRasterSet(manifest, forecast, req, opts?): Promise<RasterSet>   // never rejects
export function pendingRasterSet(manifest, forecast, req): RasterSet;      export function rasterSetKey(...): string
// sampling in incident-local metres (x east, z south): nearest pixel, no interpolation, edges belong to the last row/col
export function insideAoi(x, z, extent): boolean
export function pixelAt(x, z, extent, width, height): { row; col; index } | null
export function pixelCenter(row, col, extent, width, height): { x; z }
export function sampleLayer(layer, x, z, extent): { kind: 'outside' } | { kind: 'nodata'; row; col } | { kind: 'value'; value; row; col }
export function sampleArrival(layer, x, z, extent, timeOriginMs): { kind: 'outside' } | { kind: 'nodata'; ... } | { kind: 'never'; ... } | { kind: 'arrival'; hours; ms; row; col }
export const NEVER_MIN = 999000, HOUR_MS = 3_600_000
```
- A forecast whose `incident_id` differs from the manifest is ignored (store switch in progress). Unready bundles
  give 'missing' slots. Decoded layers are cached by URL (LRU 256 MB); the Forensic loader keeps its own cache and a
  repeated download is an ETag 304. Convert lon/lat to local metres with `lonLatToLocal(lon, lat, manifest.grid)`.
- Forecast rasters use `forecast.time_origin_ms`; incident rasters `manifest.time_origin_ms`.

---

## 11. Conventions and gotchas

- Lint (`npm run lint`, oxlint) has 55 baseline warnings, all in `src/scene/**`; add none. The React rules flag
  `Date.now()` during render (use `useNow()` from `ui/hooks.ts`), refs read during render, and `.tsx` files that
  export non-components (put helpers in `.ts`).
- `npm run build`, `npm run typecheck`, `npm run lint`, `npm test` must pass after your change.
- Times display in America/Los_Angeles with the zone (`lib/time.ts`); numbers, coordinates and times in the mono
  font with tabular numerals.
- Never print, log or copy the FIRMS MAP_KEY (it stays in `.env`, read only by `backend/fire3d/config.py`).
- Do not build bundles or forecasts; only the backend integrator does.

---

## 12. Optional sources (optional-sources; BRIEF §11)

Appended by the optional-sources agent on 2026-10-17. Nothing here is mounted yet: ui-integration mounts it once the
core is complete. Backend `backend/fire3d/api/extras.py` (router already mounted; offline tests
`backend/tests/test_extras.py`). Frontend `web/src/extras/**`: public API in `index.ts`, panels in `.tsx` files, styles
in `extras.css` (classes `xs-*`), pure logic tested in `*.test.ts`. Dev-only proof page `web/extras-dev.html` (not a
build input).

| Source | Status | Provider (free, no key, official or officially sanctioned) | Cadence / Fire-3d caching |
|---|---|---|---|
| Official evacuation zones | working, current status only | Cal OES "California Evacuation Aggregation Layer" (county GIS services + Genasys Protect) + Cal OES "County Evacuation Inventory" (which counties feed it) | Cal OES rebuilds every 5 min; cached 2 min (inventory 24 h) |
| Public cameras | working, live only | Cal OES "California Webcams" (locations) → ALERTCalifornia wildfire cameras (UC San Diego) and Caltrans CCTV; status from the Caltrans CWWP2 district feeds | list 2 min, Caltrans status 6 h; frames 15 s (ALERTCalifornia) / 60 s (Caltrans), held in memory ≤ 10 min, never on disk |
| Recent satellite imagery | working, live and past dates | Sentinel-2 L2A (Element 84 Earth Search STAC; true colour rendered by Fire-3d), Landsat 8/9 HLS L30 (NASA CMR + GIBS tiles), VIIRS daily NOAA-20/21 (CMR pass times + GIBS), GOES-West GeoColor every 10 min (GIBS) | catalogue 30 min near now, 30 days for the past; renders on disk (`data/cache/extras/sentinel2`, ≤ 300 MB) |

### 12.1 Endpoints

Query: `bbox=w,s,e,n` (WGS84 degrees; span ≤ 2° for evacuations and cameras, ≤ 0.8° for imagery) **or**
`incident=<id>` (AOI bbox + `margin_km`, else ± 10 km around the reported location; default margins 15 / 25 / 5 km),
plus `at_ms` (epoch ms; omit = now). Errors (`{"detail": "..."}`): 400 bad bbox, ids or families; 404 unknown
incident; 429 Fire-3d's own per-source limit (Cal OES 60/min, Caltrans 20, frames 30, Earth Search 30, CMR 60, GIBS 30,
renders 8). An upstream failure is not an HTTP error: the list endpoints answer 200 with `status: "unavailable"`.
JSON is `Cache-Control: no-store`.

Every list response carries this envelope (mirrored in `web/src/extras/types.ts`):

```ts
{ kind: 'evacuations' | 'cameras' | 'imagery'
  status: 'available' | 'unavailable' | 'not_available_for_past_dates'; reason: string | null
  reason_code: 'past_date' | 'upstream_error' | 'not_covered' | null
  retrieved_ms: number | null       // when Fire-3d fetched it from the source
  source_updated_ms: number | null  // the source's own update time (Cal OES layer edit; imagery: newest catalogue listing)
  requested_at_ms: number | null; now_ms: number; bbox: [w, s, e, n]; incident_id: string | null
  sources: { id, name, publisher, url, license, terms_url, attribution, disclaimer, cadence }[]; caveats: string[] }
```

- `GET /api/extras/evacuations` + `{ issuing_authority, zones: FeatureCollection<Polygon | MultiPolygon>, counts,
  coverage: { county, in_statewide_layer, acquisition_status, zone_source, reference_url }[] }`. Zone properties:
  `zone_id, zone_name, status` (official wording, verbatim), `status_key` (`order | shelter | warning | advisory |
  lifted | other | training | normal | unknown`, styling only), `county, jurisdiction, city_code, event_type, notes,
  critical_info, public_info` (verbatim), `status_updated_ms` (issuer's edit; null = not given), `aggregated_ms`.
  Past time (`at_ms` < now − 6 h) or a historical incident → `not_available_for_past_dates`, no zones. Counties not in
  the statewide layer → `unavailable / not_covered` when none of the area is covered, else a caveat. No zones →
  `available` + caveat "That is not an all-clear".
- `GET /api/extras/cameras` + `{ cameras: FeatureCollection<Point>, counts: { wildfire, traffic }, excluded }`.
  Properties: `id` (`alertca:<slug>` | `caltrans:d<n>:<name>`), `name, source_id, kind, view, azimuth_deg` (PTZ
  pointing as last reported), `viewer_url, credit, license, district, county, nearby_place, elevation_ft, in_service,
  update_minutes, status_record_ms, streaming_video, frame_endpoint`. Same past rule as evacuations.
- `GET /api/extras/cameras/latest?id=<camera id>` (explicit user action only) → `{ camera_id, status: 'available' |
  'unavailable', reason, image_url` (`/api/extras/cameras/frames/<32 hex>.jpg|png`, content-addressed, ~10 min)`,
  image_time_ms` (the camera server's Last-Modified; null = not reported)`, image_time_basis, retrieved_ms, age_ms,
  width, height, bytes, credit, license, viewer_url, source }`. Ids must match the two networks' patterns (else 400):
  no arbitrary URLs are fetched.
- `GET /api/extras/imagery[?families=sentinel-2,landsat,viirs,goes]` + `{ reference_ms` (= min(at_ms, now))`,
  products, families: { family, label, source_id, status: 'available' | 'none' | 'unavailable', reason, count }[] }`.
  Product: `id, family, label, composite` (`true_color | fire_false_color | geocolor`)`, platform, sensor,
  acquired_ms, acquired_end_ms, pass_times_ms, published_ms` (catalogue listing)`, latency_ms, latency_note,
  resolution_m, resolution_note, cloud_cover_pct` (whole scene; null = not reported)`, cloud_note, coverage_pct` (of
  the bbox)`, coverage_note, available, unavailable_reason, display, attribution, source_id, notes`. `display` is
  `{ type: 'image', url, coordinates, bbox, pixel_m }` (Sentinel-2 render: an exact MapLibre image source) or
  `{ type: 'raster', tiles, tile_size, max_zoom, bounds }` (GIBS WMTS, EPSG:3857). Only images acquired ≤
  `reference_ms`; `unavailable` only when every family failed (single failures are listed in `families`). Imagery is
  archived, so it never answers `not_available_for_past_dates`.
- `GET /api/extras/imagery/sentinel2.webp?items=<1-4 ids>&bbox=…` → Web Mercator WebP over the bbox (transparent
  no-data, ≤ 2048 px a side, 10 m when the area is small; `pixel_m` says the shown size), `public, max-age=604800,
  immutable`; 502 source error, 503 limit. Use only through `display.url`.
- `GET /api/extras/sources` → `{ sources, past_tolerance_ms }` (`public, max-age=3600`).

### 12.2 Time rules

- Evacuations and cameras are current status. Request them with
  `atMs = extrasAtMs(kind, mode, timeMs, nowMs, nowMarkerMs(manifest, forecast))` (`client.ts`, hour-quantised so
  playback does not refetch). In live mode a time at or after the NOW marker (the latest observation, even when it is
  stale) or within 6 h of now is the present (`null`). Anything earlier, and all of historical replay, is past: the
  backend answers "not available for past dates", so today's status never appears as historical fact.
  `isPastForCurrentSources(...)` answers the same question for UI states.
- Imagery: `extrasAtMs('imagery', ...)` is null for the live present, else the timeline time floored to 30 min
  (images acquired up to then). `imageryTiming(p, refMs, startedMs, live)` returns `acquired`, `relative`,
  `beforeFire`, `latency` and `listedAfterRef` ("Listed after the selected time: not available yet at that time").
  Catalogue entries created more than 30 days after acquisition are described as re-processed, never as the first
  availability.

### 12.3 Mounting (ui-integration)

1. **Data**, fetched only while the layer is on:
   ```ts
   const area = (k: ExtrasKind) => incidentAreaBbox(summary, manifest, DEFAULT_MARGIN_KM[k])   // null without either
   const marker = nowMarkerMs(manifest, forecast)                                                // state/store.ts
   const q = (k: ExtrasKind) => { const bbox = area(k); return bbox ? { bbox, incident: incidentId, atMs: extrasAtMs(k, mode, timeMs, now, marker) } : null }
   const evac = useEvacuations(q('evacuations'), mapLayers.evacuation)
   const cams = useCameras(q('cameras'), mapLayers.cameras)
   const imgs = useImagery(q('imagery'), mapLayers.recentImagery)
   const frame = useCameraFrame()   // nothing is fetched until frame.request(id)
   ```
   The hooks refresh on the source cadence while current (`REFRESH_MS`: 2 / 5 / 30 min), keep the previous answer
   while refreshing and abort on unmount.
2. **Map**, where map-core creates the map (`MapController`); once per map, `remove()` before `map.remove()`:
   ```ts
   import { drapedLayers, topLayers } from '../map/layers'
   const draped = drapedLayers().map((l) => l.id), top = topLayers().map((l) => l.id)
   const img = mountImageryLayer(map, { beforeId: draped, visible: mapLayers.recentImagery })      // mount first
   const ev = mountEvacuationLayer(map, { beforeId: draped, topBeforeId: top, visible: mapLayers.evacuation })
   const cam = mountCameraLayer(map, { topBeforeId: top, visible: mapLayers.cameras, onSelect: setCameraId })
   ev.setData(evac.data); cam.setData(cams.data); cam.setSelected(cameraId); img.setProduct(product); img.setOpacity(v)
   ev.setVisible(mapLayers.evacuation); cam.setVisible(mapLayers.cameras); img.setVisible(mapLayers.recentImagery)
   ```
   `beforeId` / `topBeforeId` take candidate ids bottom-first; the lowest one present is used, resolved again on every
   re-add. The handles re-add their sources, images (hatch patterns, camera icons) and layers after every `setStyle`
   (basemap swap). Stacking: imagery < zones < fire overlays < labels < official wording and camera icons < map-core's
   top layers (incident, events, selection).
   - Clicks: map-core's `onClick` selects a location on every click. It must skip camera icons:
     `if (map.queryRenderedFeatures(e.point, { layers: CAMERA_INTERACTIVE_LAYERS.filter((l) => map.getLayer(l)) }).length) return`.
     Its hover handler should also leave the pointer cursor on them.
   - A click inside a zone selects the point as usual. The location card can then list
     `zonesAtPoint(evac.data, lon, lat)` (official wording, jurisdiction, issuer time; empty unless the status is
     `available`, so never in replay).
   - Product shown: `pickDefaultImagery(imgs.data, summary.started_ms)` (images of the fire first, then
     full-coverage context; GOES only when nothing else exists), or the user's pick in `ImageryPanel`.
3. **Panels** are presentational; `import '../extras/extras.css'` once. Components come from their own files
   (`extras/EvacuationPanel.tsx`, `CameraPanel.tsx`, `ImageryPanel.tsx`; `ExtrasLegend` from `ExtrasCommon.tsx`);
   `extras/index.ts` exports only non-component code (Fast Refresh). The `mount*Layer` functions wrap
   `LayerGroupHandle` (`mapLayers.ts`); use them rather than the class.
   - `<EvacuationPanel state={evac} onShowZone={(id) => { const b = zonesBounds([zone]); requestMapFlyTo({ lon: (b[0] + b[2]) / 2, lat: (b[1] + b[3]) / 2, bounds: b }) }} selectedZoneId={...} />`
   - `<CameraPanel state={cams} frame={frame} selectedId={cameraId} onSelect={setCameraId} centre={[summary.lon, summary.lat]} units={units} />`
   - `<ImageryPanel state={imgs} selectedId={product?.id ?? null} onSelect={setProductId} opacity={v} onOpacity={setV} startedMs={summary.started_ms} />`

   They render every explicit state (loading, unavailable + reason, not available for past dates, error + retry),
   the authority, update and fetch times, limits, credits and terms. Good homes are the Layers panel under each
   toggle, or a drawer; on narrow screens, a bottom sheet.
4. **Legend**: `[...evacuationLegend(evac.data), ...cameraLegend(cams.data), ...imageryLegend(product, imgs.data?.reference_ms ?? now)]`
   gives `ExtrasLegendEntry { id, layer, label, detail, swatch }`. Render it with `<ExtrasLegend entries />` or map the
   swatches into MapLegend. Swatch kinds: `hatch` (cross-hatch + outline style), `camera` (filled = wildfire,
   outlined = traffic), `direction` (dashed tick), `raster`.
5. **Feed**: `<UpdatesFeed extraItems={[...evacuationFeedItems(evac.data, manifest), ...cameraFeedItems(cams.data), ...imageryFeedItems(imgs.data, [range.start_ms, range.end_ms], summary.started_ms)]} />`
   (topics `evacuation`, `camera`, `imagery`; memoise the array).
   - Evacuation: kind `official`, not seekable (current status), one item per wording and jurisdiction at the issuer's
     latest update, located at the zones' approximate centre.
   - Camera: one automated summary, not seekable.
   - Imagery: Sentinel-2 / Landsat scenes acquired after the fire start; kind `observation`, seekable when on the
     timeline.
6. **Attribution**: append `evacuationCredits(evac.data)`, `cameraCredits(cams.data)` and
   `imageryCredits(product, imgs.data)` (`{ id, text, href }`) to MapAttribution while each layer is visible. Render
   them as text (§4.4).
7. **LayersPanel copy**: "Public cameras" covers ALERTCalifornia wildfire cameras *and* Caltrans traffic cameras.
   Suggested text: "Wildfire and traffic cameras; an image loads only when you ask".

### 12.4 Presentation rules

- **Zones** use the §9 tokens with cross-hatching, so they never look like the forecast's single-direction orange
  hatch:

  | Status | Colour | Hatch | Outline |
  |---|---|---|---|
  | Order, Shelter in Place | `#e0459b` | dense | solid, 2.6 px |
  | Warning | `#a78bfa` | medium | dashed |
  | Other shown statuses (advisory, lifted, unrecognised wording) | `#7aa2f7` | sparse | dotted |
  | Normal, Training | not drawn | | |

  Labels are the official wording verbatim; the zone name or id is added from z 12.5. This deviates from Cal OES's
  own symbology (red Order, yellow Warning, purple Shelter), because red, orange and yellow mean fire information
  here (BRIEF §5).
- Always say "Fire-3d's modeled spread is not an evacuation instruction". "No zones listed" is never an all-clear.
- **Cameras**: map icons only. An image loads on "Show latest image" and is shown unmodified (`object-fit: contain`:
  ALERTCalifornia's information bar and partner logos stay), with the credit, the licence and "Image updated <time>
  by the camera server's clock". No video, no autoplay, no auto-refresh.
- **Imagery** labels always carry the platform and the acquisition time, e.g. "Satellite image · Sentinel-2B,
  acquired Jan 7, 10:44 PST · 10 m pixels (shown at about 20 m over this area)".
- Keep the four kinds of imagery apart in every label:
  - USGS basemap aerial: dated orthoimagery, never "live satellite".
  - Satellite fire detections: FIRMS points and footprints.
  - Recently acquired satellite images (this layer): with acquisition time, latency, cloud, coverage and resolution.
  - Camera images: timed by the camera server.
- Never pass source strings to `Popup.setHTML`. Official messages render as React text.

### 12.5 Required credits and terms (verified 2026-10-17)

| Source | Show | Terms (quoted) |
|---|---|---|
| Cal OES evacuation layer | "Evacuation zones: local officials via Cal OES"; disclaimer "This information is constantly changing, and Cal OES does not verify or certify the information contained herein." | data.ca.gov `california-evacuation-aggregation-layer`: accessLevel `public`, rights "No restrictions on public use"; "fully updated every 5 minutes". ArcGIS item `3ba86748155e4582954d6a0c217ecd3c` licence: "Public Use", followed by "This product is for use by Cal OES personnel and supporting partners to conduct emergency management operations…" |
| Cal OES webcams | "Cameras: … via Cal OES California Webcams" | item `5b4040338d704693994d5682ab2747c5`: "The primary audience is the general public as well as Cal OES response personnel and supporting partners"; ALERTCalifornia data CC BY-NC-ND 4.0 |
| ALERTCalifornia | "ALERTCalifornia \| UC San Diego" with every image; never crop the information bar or partner logos; non-commercial use only | alertcalifornia.org/crediting-and-branding: "available for public use with credit. CREDIT: we require 'ALERTCalifornia \| UC San Diego'…"; /terms: CC BY-NC-ND 4.0, commercial use needs a UC San Diego OIC licence |
| Caltrans CCTV | "Caltrans" | cwwp2.dot.ca.gov CCTV docs: "There is no charge for the use of this data"; "still images are neither retained nor archived". dot.ca.gov/conditions-of-use: "considered in the public domain" |
| Sentinel-2 | "Contains modified Copernicus Sentinel data <year> (Earth Search by Element 84)" | Copernicus legal notice (sentinels.copernicus.eu): "free, full and open access"; "(d) adaptation, modification…"; modified data need that notice |
| NASA GIBS products (HLS, VIIRS, GOES) | product credit + "NASA GIBS (ESDIS)"; the panel shows the GIBS acknowledgement | earthdata data-use guidance: CC0 unless marked, "there are no restrictions on the use of these data"; GIBS asks clients to include its acknowledgement |

### 12.6 Not used

- **Genasys Protect direct (zone map service / API).** It has no public API: access falls under the Genasys Protect
  Master Subscription Agreement for subscribing agencies. Counties' Genasys zones already arrive through the Cal OES
  layer. Unblocked by: a data agreement with Genasys or a county.
- **ALERTWildfire (University of Nevada, Reno) cameras** in the Cal OES layer: their separate terms are not verified,
  and their image links are plain HTTP. They are excluded and counted in `excluded`.
- **CAL FIRE incident pages**: their evacuation notes are free text without zones, so they are not parsed.
- **Paid or keyed services** (Google, Planet, Maxar): not used.

### 12.7 Dev page

`cd web && VITE_API_TARGET=http://localhost:8716 PORT=5185 npm run dev`, then open
`http://localhost:5185/extras-dev.html?preset=cooley|bryson|eaton|palisades&time=<index>`.

- It has its own minimal map (raw OpenFreeMap dark style, so its labels are not moved last like map-core's).
- `window.__extrasDev` offers `setPreset`, `setTime`, `setLayers`, `selectProduct`, `selectCamera`, `requestFrame`,
  `fitZones`, `view`, `setOpacity` and `state()`.
- Screenshots: `docs/screenshots/redesign-extras-*.png`.

---

## 13. Integration (ui-integration, as built 2026-10-17)

- **Optional sources, one fetch per source.** `extras/ExtrasSync.tsx` (mounted once in `App.tsx` `MapWorkspace`)
  runs `useEvacuations` / `useCameras` / `useImagery` / `useCameraFrame` with the §12.3 queries and publishes them to
  `useExtrasRuntime` (`extras/runtime.ts`), next to the viewer's choices (`cameraId`, `productChoice`, `zoneId`,
  `opacity`) and the drawn `product`. The query time is held while the timeline plays (no fetches during playback)
  and the choices reset when the incident changes. Readers: `map/extrasLayers.ts`, `LayersPanel`, `MapLegend`,
  `MapAttribution`, `UpdatesFeed extraItems` (`useExtrasFeedItems`) and `LocationCard` (zones at the point).
  Dev handle: `window.__extrasRuntime`.
- **Map.** `MapController` calls `bindExtrasLayers(map)` after its own event binding (so its `style.load` re-adds run
  first) and `destroy()` before `map.remove()`. Imagery `beforeId` = `[fx-extras-evac-tint, ...drapedLayers ids]`,
  zones below map-core's draped layers, official wording and camera icons below map-core's top layers. Map clicks
  skip camera icons (the camera handle opens the camera: `cameraId` + Layers drawer); a click inside a zone selects
  the point as usual and sets `zoneId`. Hover tooltips (text only) for camera icons and zones; an event marker wins,
  then a camera, and a zone only when nothing else is under the pointer.
- **Panels** live in the Layers drawer under their toggles (bottom sheet on phones); a camera picked on the map
  opens the drawer scrolled to that camera. **Legend**: a compact entry per optional layer that draws something; the
  details list every entry and an explicit status for each switched-on layer that draws nothing (loading, error, not
  available for past dates, unavailable + reason, none listed: "not an all-clear"); pure helpers
  `extrasStatusLines`, `compactExtrasLegend` (tested in `extras/runtime.test.ts`). **Credits**: appended to the map
  credits while each layer shows data (https links only).
- **Other cross-owner changes**: Forensic `WeatherCard` shows FFWI as a value with the Fosberg explanation (no
  unsourced categories or tint); the timeline forecast popover lists the run's `warnings` (collapsed); aircraft
  tooltips name the adsb.fi fallback; event-marker hover names the item's real kind (official / model / ...).
- **Data credits** (`lib/dataCredits.ts`, `ui/DataCredits.tsx`, `styles/credits.css`; README "Data sources, licenses
  and credits"): "Weather data by Open-Meteo.com" (https link, CC BY 4.0) in the map credits while the incident's
  weather or the selected forecast comes from Open-Meteo, under the Fire Area / Rate of Spread charts when they draw
  forecast or weather series (Forensic dock and Analysis drawer), and in the Forensic weather card. A "Data sources"
  note built from the bundle's own `data_sources` (CAL FIRE, NASA FIRMS with NASA's acknowledgement, NIFC WFIGS when
  perimeters were found, USGS 3DEP, LANDFIRE, NAIP, Copernicus Sentinel-2 with the scenes' year, Open-Meteo; none for
  synthetic fixtures) sits under the Analysis drawer's charts and in the Forensic Evidence tab.
- **Scale bar** moved out of the credits line into its own slot (`.mw-scale-slot`, the bottom-right corner of the safe
  area via `--safe-right` / `--safe-bottom`: left of the updates panel, above the bottom row and any open drawer;
  hidden on phones while the card or a sheet is open), so the required credits keep one line at 1440 px: default
  Public view 75.1-76.6 % unobstructed on all 10 bundles (Henderson and Norte, which list an official zone and so add
  the Cal OES credit, were 74.9 / 73.5 % before).
- **Detection footprints** (map-core's known clutter issue): true-size squares from zoom 13 (was 12.5; dots below),
  recent fill opacity 0.08 (was 0.2), outlines 0.6 / 0.25 (was 0.8 / 0.4), GOES 0.4 (was 0.55).
- **Freshness** (backend-followups, SPEC 8.3): `TimeRange.last_detection_ms` / `last_pass_ms` (optional). Command's
  data status says "Latest satellite pass: no new fire seen" on the Last observation row (the CMR source detail as its
  tooltip) when the newest detection or perimeter is more than 1 h older than `now_ms`.
