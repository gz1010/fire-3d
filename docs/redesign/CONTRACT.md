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
  basemap: Basemap                         // effective basemap (brief 2, decision 5): basemapFallback ?? basemapPick
                                           //   ?? (Public 'aerial', Command 'dark'); see §13 shell
  basemapPick: Basemap | null              // brief 2: the user's explicit pick (menu, Layers, ?basemap=); null = preset default
  basemapFallback: Basemap | null          // brief 2: set by the map only while the effective provider fails (never a pick)
  units: Units                             // default 'us' (mph, ft, mi, °F, acres)
  selection: SelectedLocation | null
  view: GeoView | null                     // last settled map view; null = frame the incident on mount
  mapFlyTo: MapFlyTo | null
  panels: Record<PanelKey, boolean>        // default updates open, others closed
  mapLayers: Record<MapLayerKey, boolean>  // default all on except cameras, recentImagery
  safeInsets: SafeInsets                   // published by the shell

  setWorkspace(w): void; setPreset(p): void; setPerspective(p): void; togglePerspective(): void
  setBasemap(b): void                      // explicit pick; clears a fallback (brief 2)
  setBasemapFallback(b | null): void; setUnits(u): void
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
with `replaceState`, next to the existing `incident`/`t`/`mode`. Brief 2: `basemap` is written only when the user's
pick differs from the preset's default (Public aerial, Command dark), so `?basemap=dark` is valid in Public and old
Public links now open on aerial; incident changes are history entries (§13 shell). `view=` and `sel=` are read once at start-up (deep
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
rule of thumb). Also `growthRate`, `cardinalWord`, `forecastLead`, `forecastDescription(f, mode, { plain? })` (title,
period, issued, runs, probability, uncertainty, weather, caveat; `plain` = Public: a past fire's run is titled "Model
re-run on past weather", never "Hindcast"; brief 2 integration), `modeledArea`, `ensemblePhrase`, `weatherSourceName`,
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
   top layers (incident, events, selection). Since the brief 2 integration the handles also move their existing
   layers back to this order on every `style.load` (MapLibre's `styledata` re-add came before map-core's fire layers,
   so zones ended above the fire layers after a basemap load; CONTRACT §13 official-web I6).
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

---

## 13. Brief 2 interfaces

Added for UI/UX brief 2 (`docs/redesign/BRIEF-2.md`, `PLAN-2.md`). The section above with the same number is brief 1's
integration record. Each role appends its own sub-heading below and edits only that.

### shell (I1 overview state and zoom focus, I3 fire card, history, basemap default, layout, as built 2026-10-18)

Written early on 2026-10-18 so map, location and official-web could build against it; updated as built.

**Overview = the map workspace with `useStore.incidentId === null`.** No default fire, no auto-build.
- `useStore.getState().closeIncident(): void` (`state/store.ts`): stops job polling, drops late responses of the
  previous selection, resets `incidentId` to `null` and every per-incident field; the catalog, `timeMs` and `mode`
  stay; `incidentSource` becomes `null`. The workspace store then drops `view` and any `'event'` / `'incident'`
  selection; user-picked points (`click`, `coords`, `address`) stay.
- `useStore.missingIncidentId: string | null`: set when an explicit `selectIncident(id)` answers 404 (unknown or old
  link, fire no longer listed). The store returns to the overview by itself (the URL entry is replaced) and the shell
  shows a notice (`MissingFireNotice`); `setMissingIncidentId(null)` dismisses it.
- `selectIncident(id, { autoBuild?, keepTime?, source? })`: `autoBuild: true` builds a missing bundle (only the fire
  card's "Prepare analysis (1-3 min)" passes it; the incident picker passes the Forensic setting
  `useStore.autoBuild`, now off by default). `source` (default `'other'`) sets `incidentSource`.

**Zoom focus (decision 10).** The overview and a fire's view are one map.
- `useStore.getState().focusIncidentFromMap(id: string | null)`, called by the map's viewport logic
  (`map/focus.ts`). Debounced `FOCUS_DEBOUNCE_MS` = 300 ms, the last call wins; a call matching what is shown cancels
  a pending change. `id`: only a fire with a ready analysis (`canFocus`: a catalog row with `bundle_status: 'ready'`,
  the cache, or the fire shown); anything else is ignored. Never builds, frames or pushes history (the URL entry is
  replaced). Time: `latestObservationMs(m)` (live `time_range.now_ms`, historical `time_range.end_ms`), kept in
  `useStore.focusTimeMs`; the first Play from it starts at the window start (`playStartsOver` in
  `state/runtime.ts`), so it animates the spread. `null`: back to the overview with `incidentSource: 'zoom'`.
  Both keep every selection, the preset, perspective, basemap and the map `view`.
- `useStore.incidentSource: IncidentSource | null`, set in the same update as `incidentId`:
  `'zoom' | 'card' | 'search' | 'link' | 'picker' | 'history' | 'other'`. The map frames a new incident unless it is
  `'zoom'`.
- Cache: the last `INCIDENT_CACHE_SIZE` = 4 shown fires' bundle data stay in memory (`cachedIncidentIds()`); focusing
  or opening one again shows it at once and revalidates it (files refetched only when `built_ms` changed).
- `MapFlyTo.source?: MapFlySource` (`'official'`; `state/workspace.ts`): a flight that shows an official area
  (official-web's `fitOfficialBounds` passes it). The map's zoom focus should skip the move it causes, so showing
  Henderson's Orange County zone never focuses the Norte Fire. Wired by the integration: `fitOfficialBounds` and the
  Layers drawer's zone fit pass it, and the map holds the focus (`FocusHold`, CONTRACT §13 map).
- Focus candidates: all prepared fires whatever the overview filter. `catalog.live`, `.season` and `.historical` are
  loaded at start and stay loaded (the filter never refetches; live refreshes every 5 min, also on the overview);
  `preparedFires(catalog)` (`state/overview.ts`) = every ready row with `bbox_lonlat`, deduplicated. Limit: a past
  fire under the 2025 list's size threshold (300 ac; 100 with the picker's switch) is not a candidate; today all 8
  prepared real fires are listed.

**Incident lists** (`useStore.catalog`, `state/catalog.ts`): `live` (`?mode=live`), `season` (new:
`?mode=historical&year=2026&min_acres=300`; rows of another year are dropped, so a server ignoring `year=` cannot leak
2025 rows), `historical` (`?mode=historical&year=2025&min_acres=<minAcres>`). Per list `listLoading`, `listErrors`,
`updatedMs` (Fire-3d's check time, not CAL FIRE's); `loading` / `error` are their union. Each list applies on
arrival; an older answer never overwrites a newer one. `loadCatalog({ lists?, modes?, minAcres? })`.

**Overview filter and helpers** (`useWorkspace.overviewFilter: 'active' | 'season' | 'past'`, default `'season'`;
`state/overview.ts`, tested): `overviewFires(catalog, filter)` (the panel list and the map's markers: `'season'` =
live ∪ season, deduplicated, active fires first, then acres), `preparedFires`, `findFire(id, summary, catalog)`,
`fireStatus(row)` (CAL FIRE's flags: Active / Contained / Out), `analysisState(row)`, `newestRecordMs(rows)` (CAL
FIRE's own newest update), `fireFlyTo(row)` (`bbox_lonlat`, else 2.5x the acreage radius, at least 3 km).

**Fire card (I3)**: `useWorkspace.fireCardId` + `setFireCard(id)` (never moves the camera). `ui/shell/FireCard.tsx` in
the `.mw-firecard` slot (left column on desktop, a bottom sheet on phones; it hides the location card while open):
CAL FIRE's official record (acres, containment, status, CAL FIRE's update time, incident page), the analysis state,
and "Open this fire" / "Prepare analysis (1-3 min)" / Play spread / Check a location / Open in 3D through
`openFire(id, action)` (`ui/shell/fireActions.ts`; `source: 'card'`). Closes on Escape (capture phase, before the
drawers), a new selected point (`selectLocation` clears it), an incident change unless it is the card's fire, or a
map click elsewhere (map). Focus returns to the opener, else the map canvas. `showFireCard(id)` (list rows, picker):
card + `requestMapFlyTo(fireFlyTo(row))`; on a prepared fire that flight usually zoom-focuses it.

**History** (`state/history.ts`, tested): explicit incident changes push (`?ws=…&incident=<id>` or none; `t` / `mode`
dropped); zoom focus changes and the 404 fallback replace; Back / Forward apply the entry's `incident`
(`selectIncident(id, { source: 'history' })` or `closeIncident()`), its `t` once ready and its `ws`. "← All fires"
(`goToOverview()`) goes back when the entry was pushed from the overview, else closes (push). A named fire loads in
parallel with the lists (`source: 'link'`). `useWorkspace.returnToIncident()` calls the mounted map's
`actions.frameFire()` (the fire itself), else requests the AOI bounds.

**Basemap default (O-R10; §2):** effective `basemap = basemapFallback ?? basemapPick ?? defaultBasemap(preset)`
(Public aerial, Command dark); `setBasemap` = explicit pick (clears a fallback); `setBasemapFallback` = map only; a
preset switch follows the new default unless picked; the URL writes the pick only when it differs from the default.

**Header and presets (C-R8):** one "Public · Command · Forensic" switch (`ViewSwitch`, `ui/shell/views.ts`: Forensic
keeps the preset); "California · all fires" on the overview, "← All fires" + the picker inside a fire; no Analysis
toggle without a fire. Phones: the labelled "Updates" button with `useOfficialBadge()`'s count and colour.

**Updates panel (U-R3, U-R4, U-R9):** one scroll area: official-web's `OfficialNow` at the top, then the data status
(Command: every source, Cal OES / NWS / CAL FIRE rows from `useOfficialNow()`, a past fire's CAL FIRE row with the
year and "Last edit of CAL FIRE's record"; Public: one line `freshnessLine()`, "Sources checked 2 min ago · satellite
data 16 h old" / "Archived replay to Jan 10, 2025", rows on demand), then the feed. **Deviation from I5:** desktop
Public opens on a compact "Official now" (`ui/shell/officialSummary.ts`, tested): three short lines from the same
`useOfficialNow()` data (zone status and NWS event verbatim, issuer, distance; quiet states say "Not an
all-clear"), the data line and the standing line; "Details" in the panel header shows `OfficialNow`, the data rows
and the feed. Reason: OfficialNow is 380-780 px tall and the default Public view must keep >= 75 % open map. Command,
phones (the sheet) and the expanded panel mount `OfficialNow` at the top.

**Overview panel:** official-web's `OfficialNow` California variant (statewide NWS alerts, "zoom in on a fire or pick
one") sits above the list (`.ov-official`, at most 34 % of the panel, scrolls).

**Satellite chip (I5 ImageryChip):** in the header bar from 1024 px (`.mw-hdr-chip`, right above the map controls;
the bar is chrome anyway, so the chip costs no map area), below that in the `.mw-imagery` slot next to the controls
(phones: its own row, hidden while a card or sheet is open). Its caption hangs over the map.

**Coordinate strip (decision 7):** always visible; `useCoordsVariant()` (`ui/shell/coordsVariant.ts`): `'full'`
Command, `'compact'` Public, `'line'` phones (the slot's toggle shows the preset's form). Location's strip follows it.

**Layout and tokens (C-R9, C-R2):** `--m-text-3` #98a4b2, `--m-text-2` #b3bfcc, Public `--m-panel` 0.94 (Command
0.95); `--m-fs-xs` 11 px = tags and headings only, `--m-fs-sm` / `--m-meta-fs` 12 px = meta, `--m-fs-md` 13 px =
body; `--m-chip-opaque` (the research note and credits chips), `--m-official-ink` / `--m-official-line` (the
"Official" tag), `--m-header-h` 40, `--m-search-w` / `--m-card-w` 360, `--m-legend-w` 380 (the legend's bottom-row
column), `--m-chip-w` 380 (the chip shows the platform). Phones: the note and "© Credits" (a toggle that opens the full credits above the bottom
row) share one line; the timeline hides its current-time line (and, with a card open, the forecast-issue and
freshness lines: `.ctl-clock`, `.ctl-fcinfo`, `.ctl-fresh`, `.ctl-replay`, CSS in `styles/overview.css`); cards and
sheets stack above the map controls (z 6-7) and the cards stop at 42vh; a clicked pin under a sheet is panned into
view (`usePinAboveSheet`, `layout.ts pointHidden`).

**Forensic (O-R7):** no fire: "Zoom in on a fire or pick one" with the list and the card; a fire: desktop opens with a
timeline-only dock (`.fx-dock-min`; "Charts & key events" restores it) and a labelled "Frame fire"
(`issueCameraCommand('frame-fire')`), phones with the panel sheet collapsed ("Layers & analysis"). The shared
selection is drawn as a cyan pin (`scene/overlays/SelectionPin.tsx`, mounted in `Scene.tsx`); a click (not a drag) on
the terrain selects that point (`ProbeDriver`).

### official-web (I5 official hooks and components, I6 official map layer, feed and imagery chip)

Written early on 2026-10-18 so location, shell and map can build against it; kept up to date as built.

**Data flow.** `extras/ExtrasSync.tsx` (always mounted in the map workspace) now, for the open fire:
- fetches the Cal OES zones whatever the evacuation toggle says (the toggle only hides them on the map, legend and
  credits);
- fetches the satellite image list for the chip: with the imagery layer off, one list per fire (live: now; replay: up
  to the end of the record); with it on, the list follows the timeline as before;
- runs `useOfficialSync()` (`official/runtime.ts`): `GET /api/official/calfire?incident=` (refresh 5 min, live only)
  and `GET /api/official/fire-weather?incident=&at_ms=`. `at_ms = fireWeatherAtMs(...)` (`official/client.ts`) is
  omitted while a live timeline stands for the present, else the hour; it is held during playback, and current answers
  refresh every 2 min. Demo bundles (`isDemoBundle`) fetch neither.

Answers live in `useOfficialRuntime` (`calfire`, `fireWeather`, `statewide`, same shape as ExtrasQueryState;
`seen` = live NWS alerts remembered this session, so one that leaves the live feed stays listed 48 h as expired;
`highlight`). Dev handle: `window.__officialRuntime`. On the overview (no fire open) the sync fetches only `statewide`
(`GET /api/official/fire-weather` without an incident: every current California alert).

**Fire changes (decision 10: zooming in focuses a fire, zooming out returns to the overview).**
- Every extras and official query goes through one per-URL cache (`extras/jsonQuery.ts`, `useCachedJsonQuery`; the
  URL names the fire, area and time). Re-focusing a fire shows its last answers at once; they are refetched only when
  older than the source's cadence (evacuations and NWS 2 min, CAL FIRE and cameras 5 min, imagery 30 min, at least
  1 min). Readers of one URL share one request, and a request no reader needs any more is aborted.
- Readers keep only the open fire's answers (`forIncident` in `official/guard.ts` compares `incident_id`), so a
  previous fire's rows never show under the new fire, not even for one render.
- Time-dependent queries (evacuations, cameras, imagery, NWS) wait until the timeline belongs to the new fire
  (`officialTimeReady`: its manifest is loaded; a fire without a ready bundle is asked for the present), so a switch
  never sends the previous fire's time (no needless archive request, no flash of "not available for past dates").
- The hooks compare the minute-quantised timeline with a NOW marker quantised the same way (`officialPast` in
  `official/context.ts`): a live fire shown at its latest observation (e.g. 00:42:41) is the present, never a past
  date.
- Official fits never change the open fire: `fitOfficialBounds` (`official/select.ts`) requests
  `requestMapFlyTo({ ..., source: 'official' })`, and the map's zoom focus holds what is open until the user moves the
  map again (integration; CONTRACT §13 map "Focus by zooming").
- Overview: `OfficialNow` shows "Official now · California" (the state's current NWS alerts, or the quiet line "No
  Red Flag Warning or Fire Weather Watch in effect in California. Not an all-clear.") and the pointer "Official
  evacuation zones and CAL FIRE's record are shown for a fire: zoom in on a fire or pick one, or check an address".
  `useOfficialNow()` there: evacuation `'not-checked'`, calfire `'unavailable'`, fireWeather = California's alerts;
  `useOfficialBadge()` is `{ count: 0, level: null }`. The official map layer outlines California's alerts (U-R12).

**I5 hooks** (`web/src/official/hooks.ts`; types in `official/model.ts`, re-exported):

```ts
useOfficialAtPoint(lon: number | null, lat: number | null): OfficialInfo
useOfficialNow(): OfficialInfo                      // the open fire, no point ("Official now")
useOfficialBadge(): { count: number; level: 'order' | 'warning' | 'fire-weather' | null }
interface OfficialInfo { evacuation: EvacuationOfficial; fireWeather: FireWeatherOfficial; calfire: CalFireOfficial }
interface EvacuationOfficial {
  state: 'listed' | 'none-listed' | 'not-checked' | 'past-date' | 'unavailable' | 'loading'
  zones: OfficialZone[]; checkedMs: number | null; sourceUpdatedMs: number | null; sourceUrl: string | null; caveat: string
  reason?: string | null; links?: { label: string; url: string }[]; bounds?: [w, s, e, n] | null; layerOff?: boolean
}
interface OfficialZone {
  id: string; status: string /* verbatim */; group: 'order' | 'warning' | 'other'; issuer: string
  issuedMs?: number; updatedMs?: number; listedMs?: number; distanceKm: number | null; outsideAnalysisArea: boolean
  name: string | null; message: string | null /* verbatim */
}
interface FireWeatherOfficial {
  state: 'active' | 'none' | 'past-date' | 'unavailable' | 'loading'; alerts: OfficialAlert[]; checkedMs: number | null
  archived: boolean; credit: string; sourceUrl: string; reasonCode?: string | null; reason?: string | null; caveat: string
}
interface OfficialAlert {
  id: string; event: string /* verbatim */; senderName: string; onsetMs?: number; endsMs?: number; expiresMs?: number
  headline: string /* verbatim, '' if none */; url: string | null; archived: boolean
  phase: 'active' | 'upcoming' | 'expired' | 'cancelled'; timeText: string /* "until Oct 20, 18:00 PDT" */; sentMs?: number
  coversReportedLocation: boolean | null; nearestKm: number | null; ugcs: string[]; bounds: [w, s, e, n] | null
}
type CalFireOfficial = { state: 'available' | 'unavailable' | 'loading'; acres?; percentContained?; isActive?; updatedMs?;
  url?; final?; agencies?; checkedMs?; recordingSinceMs?: number | null; containedMs?; reason? }
```

Rules the states follow (pure, tested in `official/model.test.ts`):
- **Evacuation at a point.**
  - `'listed'` / `'none-listed'` only where Cal OES was really checked: inside the open fire's query box (its analysis
    area + 15 km; `evacuationAtPoint` in `extras/evacuation.ts` respects the response `bbox`).
  - For a point outside that box, or on the overview, the hook checks a small box around the point itself (±0.005°,
    current time only).
  - `'past-date'`: historical replay, or a live time before the NOW marker − 6 h ("Official status is shown only for
    the current time").
  - `'not-checked'`: no point, or outside California. `'unavailable'` + `reason` on outages or counties missing from
    the statewide layer (+ the counties' own maps in `links`).
  - Normal / Training zones are never listed.
- **Zone times.** `issuedMs` is always absent (Cal OES gives none). Show `updatedMs` as "Updated by the issuer …",
  else `listedMs` as "Issuer time not given; listed by Cal OES …". `checkedMs` is only "checked …", never an issue
  time. `outsideAnalysisArea` → show "Cal OES does not say which fire this is for." (`NOT_FIRE_SPECIFIC`).
- **Fire weather at a point.** Alerts whose NWS zones contain the point and that are in effect (or upcoming) at the
  reference time (now, or the replay time). Inside the open fire's checked area (`area_bbox`: its analysis area + 15
  km) its answer decides, archived for past times. Elsewhere at the current time, and on the overview, the statewide
  answer decides, so `'none'` holds anywhere in California. A past time outside the fire's area is `'past-date'`;
  outside California `'unavailable'` with `reasonCode: 'not_checked'`; demo fires `reasonCode: 'demo'`. Always show
  `caveat`: a Red Flag Warning is a weather warning, not an evacuation order. Card line:
  `` `Fire weather alert here: ${a.event} (${a.senderName}) ${a.timeText}` ``. `phase` `'cancelled'` covers NWS
  CAN and UPG (UPG reads "Replaced by a newer NWS alert").
- **Near the fire (`useOfficialNow`).** Evacuation = every shown zone in the fire's query box with its distance
  (orders, warnings, other; then nearest first). Fire weather = the fire's alerts, kept 48 h after they end
  (`phase`); `'active'` while one is in effect or upcoming.
- **Badge.** `count` = (status, issuer) groups of order / shelter / warning zones + NWS alerts in effect or upcoming;
  `level` = order > warning > fire-weather > null.
- **`calfire`.** The endpoint's `current`, else the incident summary (also CAL FIRE's list); `'unavailable'` for demo
  fires and when no record exists.

**I5 components** (no props; both render nothing on the overview):
- `web/src/ui/feed/OfficialNow.tsx` `OfficialNow()`. Mount it at the top of `UpdatesPanel`, above the scrolling feed,
  in the desktop panel and the phone sheet. Classes `on-*` (`ui/feed/updatesFeed.css`). About 150-240 px tall:
  three rows (evacuations, CAL FIRE, fire weather) + the "not an evacuation order" line.
- `web/src/extras/ImageryChip.tsx` `ImageryChip()`. A one-line chip ("Satellite · newest 20 h ago · 375 m · VIIRS
  NOAA-21 · Oct 17, 14:30 PDT"; the clock time, then the platform, give way first when the slot is narrow) and a
  popover with `ImageryPanel`. While an image is shown, a compact caption (title, "not live", one line of time, age,
  pixel size and cloud cover; limits and credit behind "More") is portaled to `document.body` and placed next to the
  chip where it covers no `[data-chrome]` element (`extras/placement.ts`), so the slot needs no room for it. Wrap the
  chip in a `[data-chrome="imagery"]` element with `--chrome-side`, like the other floating chrome. Classes
  `xs-chip*`, `xs-caption*` (`extras/extras.css`). The image list (`ImageryPanel`) is one list: images since the fire
  started (newest first; true color before false color at the same time), then context before it, GOES last.
  One list per screen (integration): on wide screens the chip's "More images" popover holds the image list and the
  Layers drawer shows `ImageryLayerSummary` under the recent-imagery toggle (the image shown, "not live", time, age,
  pixel size, cloud cover, opacity, credit, and where to pick another); phones keep the full `ImageryPanel` in the
  drawer (the chip is hidden while a sheet is open). Each `ImageryPanel` has its own radio group (`useId`), so two open
  lists never uncheck each other.

**Selection read by the official map layer (U-R5).** `useOfficialRuntime.highlight: OfficialHighlight | null`:

```ts
type OfficialHighlight =
  | { kind: 'evacuation'; id: string; zoneIds: string[] }                    // Cal OES zone ids
  | { kind: 'fire-weather'; id: string; ugcs: string[]; alertIds: string[] } // NWS zones / alert ids
```

- Set by `selectFeedItem(item)` (from `item.highlight`) and by "Show on map" in Official now
  (`showOfficialArea(h, bounds, { toggle })` in `official/select.ts`).
- Cleared when another update is selected, the selection closes (`selectedEventId` changes) or the fire changes.
- Official items with `bounds` are fitted with `useWorkspace.requestMapFlyTo({ lon, lat, bounds })` in the map
  workspace (`fitOfficialBounds`); others fly as before.
- extras' `zoneId` (map click in a zone) keeps its meaning.

**I6 map layer** (`web/src/official/mapLayer.ts`):

```ts
mountOfficialLayers(map, { beforeId?: string | string[]; topBeforeId?: string | string[] })
  => { update(state?: unknown): void; remove(): void; layerIds(): string[] }
```

- Mount once per map, after `bindExtrasLayers(map)`:
  `mountOfficialLayers(map, { beforeId: [EVAC_LAYERS.tint, ...drapedLayers().map((l) => l.id)], topBeforeId: topLayers().map((l) => l.id) })`.
  Call `remove()` before `map.remove()`. It re-adds itself after basemap swaps.
- Stacking: imagery < NWS outlines, their labels and a selected NWS alert's outline < evacuation zones < fire layers <
  basemap labels < a selected evacuation zone's outline < map-core's top layers (integration: the NWS labels moved
  below the fire layers, so where an outline crosses the fire, the fire covers its label).
- `LayerGroupHandle` (`extras/mapLayers.ts`, also used for the evacuation zones and imagery) restores this stacking after
  every style load (integration fix): MapLibre fires `styledata` (the group re-adds itself, before map-core's fire
  layers exist, so it falls back below the basemap labels) before `style.load` (map-core re-adds its fire layers below
  it); the forced sync on `style.load` now moves existing layers back below the first present `beforeId` candidate.
  Before the fix, evacuation zones and NWS outlines were drawn above the fire layers.
- Style (integration, the coordinator's clarity note: NWS zones are large and their outlines crossed the whole map):
  unselected outlines are thin and quiet (`FW_LINE` warning 1.4 px dashed, watch 1.2 px dotted; `FW_OPACITY` 0.85 at
  z6 fading to 0.4 by z14; a light 3 px casing at 0.5), labels sparse (`symbol-spacing` 600, from z7). A selected NWS
  alert (`highlight.kind 'fire-weather'`) is drawn in its own colour, solid 1.8 px with a light casing and a faint 7 %
  fill, below the fire layers (`hlFwCasing` / `hlFwLine`); a selected evacuation zone keeps the white outline on top
  (`hlCasing` / `hlLine`, filtered by the highlight feature's `kind`). The outline labels sit below the fire layers.
  The fire layers stay the most prominent element; the legend entry and credit are unchanged.
- It subscribes to its stores itself. `update()` is optional: `update()` re-syncs, `update({ visible: false | true })`
  hides or shows every official layer.
- Ids are in `OFFICIAL_LAYERS` / `OFFICIAL_SOURCES` (`fx-official-*`). The layers are non-interactive: the map's
  click handling needs no change.

**Legend and credits** (no change needed in MapLegend or MapAttribution):
- `useExtrasLegend()` also returns the NWS entries (layer key `'fireWeather'`, swatch `{ kind: 'outline', color, line }`,
  drawn by `LegendSwatch`). `EXTRAS_LAYER_KEYS` includes `'fireWeather'`.
- `compactExtrasLegend()` labels them "Fire weather alert (NWS)" and uses an entry's new optional `compact` label: the
  satellite image now reads "Satellite image · VIIRS NOAA-21 · Oct 17, 14:30".
- `useExtrasStatus()` adds a `fireWeather` line when alerts cannot be shown.
- `useExtrasCredits()` adds "Fire weather alerts: National Weather Service" (or "… via Iowa Environmental Mesonet
  archive") while outlines are drawn.

**Feed (U-R2, R5, R8, R10).**
- `FeedItem` gains optional `url, issuer, issuedMs, updatedMs, expiresMs, checkedMs, bounds, status ('active' |
  'upcoming' | 'expired' | 'cancelled'), distanceKm, highlight, links, sections, archived, notes, timeNotGiven,
  children`. `FeedTopic` adds `'calfire' | 'fire-weather' | 'quiet'`. `FeedFilter = 'official' | 'all' | 'key'`.
  `FeedInput` adds `preset`, `groupPasses`, `wallMs`.
- `useExtrasFeedItems()` (unchanged call in App.tsx) now also returns the evacuation rows whatever the toggle says, CAL
  FIRE change / final-record rows and NWS rows.
- Official rows are timed by the issuer, else by the source's own time, never by Fire-3d's fetch (`timeNotGiven`). They
  are seekable only inside the observed record (`time_range.start_ms` … `now_ms`); not seekable means never "later".

**Forensic Key Events (U-R11).** Each row shows its kind as a glyph (the feed's kind icons: observation, estimate,
model output, official update, your note); automated items get a corner dot on the glyph, spelled out in its label and
tooltip. The empty list says "No key events detected for this fire. No update does not mean no danger; follow local
officials."

### official-backend (I2 list data, I7 official endpoints; as built 2026-10-18)

Backend: `backend/fire3d/api/official.py` (router), `sources/nws.py`, `sources/calfire_history.py`, `catalog.py`,
`sources/calfire.py`, `contracts.py` (`IncidentListRow`, `CalFireOfficialResponse`, `FireWeatherResponse`); TS shapes
in SPEC §6. Tests: `backend/tests/test_official_*.py` (recorded samples in `backend/tests/data/official/`).

**I2 lists (`GET /api/incidents`).**
- `year=YYYY` (2000-2100) applies to `mode=historical` only; the default stays 2025. Historical answers gain `year`.
- Every row (both modes) is `IncidentListRow` = `IncidentSummary` + `bbox_lonlat: [w, s, e, n] | null`: the analysis
  area (`manifest.grid.bbox_lonlat`) when `bundle_status` is `"ready"`, else null. The detail endpoint's `summary`
  is unchanged (no `bbox_lonlat`).
- Rows of a year list keep `mode: "historical"`, as the 2025 list always did, and `detections_24h: null`.
  `is_active` is CAL FIRE's status. `/api/incidents/{id}` resolves a fire in CAL FIRE's live list as `mode: "live"`,
  and the store takes the mode from there.
- The current year's list is refreshed every 30 min (HTTP cache; in memory 10 min); past years every 24 h. It is
  overlaid with CAL FIRE's live list:
  - a fire's live record replaces the year copy when it is at least as new;
  - live fires of that year that the copy lacks are added.
  So a 2026 `season` row of an active fire has the same CAL FIRE values as its `live` row.
- CAL FIRE down: with `year`, the fallback lists that year's bundles on disk in either mode. Without `year`, the
  fallback is unchanged.

**I7 envelope (both endpoints).**
`{ kind: 'calfire' | 'fire_weather', status: 'available' | 'unavailable' | 'not_available_for_past_dates',
reason_code: 'past_date' | 'upstream_error' | 'not_covered' | null, reason: string | null,
source: { name, url, credit, license?, terms_url? }, retrieved_ms, source_updated_ms, requested_at_ms, now_ms,
incident_id: string | null, caveats: string[] }`.
- `retrieved_ms` is when Fire-3d fetched the source, never an issue time. `source_updated_ms` is the source's own time.
- An upstream failure answers 200 with a status, so an empty list never stands in for "none".
- HTTP errors: 400 invalid id, 404 unknown incident, 422 bad query, 429 Fire-3d's own request limit (NWS and IEM
  30 requests/min each).
- `Cache-Control: no-store`. Show every `caveats` string, or at least the not-an-all-clear and not-an-evacuation-order
  ones.

**`GET /api/official/calfire?incident=<id>`**: `{ ...envelope, incident_url, agencies, current, changes,
recording_since_ms }`.
- `current`: `{ acres, percent_contained, is_active, final, updated_ms, extinguished_ms }`, CAL FIRE's own numbers.
  `updated_ms` is CAL FIRE's `Updated` and `extinguished_ms` its `ExtinguishedDate` (the extinguished field is
  additive).
- `changes`: oldest first, `{ updated_ms, seen_ms, acres?: [old, new], percent_contained?: [old, new],
  is_active?: [old, new], final?: [old, new] }`.
  - Only the fields that changed are present.
  - `updated_ms` is CAL FIRE's time for the new record (use it as the row time); `seen_ms` is when Fire-3d first saw it.
  - A new `Updated` time without new values is recorded but is not a change.
- `agencies` is CAL FIRE's `AgencyNames` verbatim: free text, sometimes starting with ", ", or null when empty.
- `incident_url` is CAL FIRE's incident page (https only), also in `source.url`.
- `recording_since_ms` is the baseline's `seen_ms`, or null when nothing has been recorded.
- `retrieved_ms` is the fetch time of the CAL FIRE list copy used (null when CAL FIRE was unreachable).
  `source_updated_ms` = `current.updated_ms`.
- States:
  - `available`.
  - `unavailable` + `not_covered`: a demo or fixture bundle (no network call), or CAL FIRE no longer lists the fire.
  - `unavailable` + `upstream_error`: CAL FIRE unreachable. `current` / `changes` then hold the last record Fire-3d
    recorded, or `null` / `[]` when there is none.
- Caveats:
  - "These are CAL FIRE's own numbers and update time, …"
  - "Fire-3d records CAL FIRE's changes only since it first checked this incident (recording_since_ms); …"
  - For an inactive fire with no recorded change: "CAL FIRE's list keeps only the latest record, so the
    update-by-update history of a past fire is not available. This is CAL FIRE's final record." (or "latest record").
  - When CAL FIRE edited the record more than 7 days after containment (Eaton: Aug 2026): "CAL FIRE edited this
    record well after the fire was contained; its update time is that edit, not news from the fire."
- History storage: `data/official/calfire/<UniqueId>.jsonl`, one JSON line per distinct (`Updated`, values), outside
  the bundles; atomic rewrite + fcntl lock; never goes backwards (an older cached copy is ignored).
  - Recorded whenever the backend checks CAL FIRE: every live-list fetch (the list endpoints, the live loop's cycle,
    `/api/live/status` counts) and every year-list fetch (the 2026 season list, the summary sync's lookups,
    `get_summary`) records active fires and fires already tracked. Each `/api/official/calfire` call records its fire.
  - A tracked fire that leaves the live list gets its next record from its year's list.
  - History started on 2026-10-18; nothing earlier exists.

**`GET /api/official/fire-weather?incident=<id>&at_ms=<ms>&margin_km=15`**: `{ ...envelope, alerts, zones,
area_bbox, reported_location }`.
- Area: the bundle's analysis area (or the reported location ± 10 km without a bundle) + `margin_km` (default 15,
  0-60). `area_bbox` is that box; `reported_location` is `[lon, lat]` (both additive).
- Which source:
  - No `at_ms`, `at_ms` within 6 h of now, or later (forecast times): the live NWS list (`archived: false`, source
    "National Weather Service"). One statewide request for every fire, cached 2 min; zone polygons are cached 30 days.
  - `at_ms` older than now − 6 h, or any `at_ms` of a historical incident: the IEM archive (`archived: true`, source
    name "NWS products, archived copy: Iowa Environmental Mesonet").
  - A historical incident without `at_ms`: `not_available_for_past_dates` + `past_date`. Pass the replay time.
  - Archive failure: `not_available_for_past_dates` + `upstream_error` ("… that does not mean there were none").
  - NWS failure (live): `unavailable` + `upstream_error`. NWS itself is never asked about a past date.
- Without `incident`: every current California alert and all its zones (outlines simplified to about 400 m),
  `covers_reported_location` / `nearest_km` null (for the overview, U-R12). A past `at_ms` there:
  `not_available_for_past_dates`.
- `alerts[]` (I7 fields + additive `phase`, `office_url`, `nws_headline`).
  - Wording is verbatim (`event`, `headline`, `nws_headline`, `description`, `instruction`, `area_desc`).
  - Sorted: in effect, then upcoming, then ended; the alert covering the reported location first, then nearest.
  - `id`: live = the NWS CAP id. NWS sends one message per zone group, so one VTEC event can come as several alerts:
    group by `vtec.office + phenomena + significance + etn`. Archived = `"<year>-<office>-FW-<W|A>-<etn:04d>"`.
  - `url`: live = the NWS API record (JSON); archived = IEM's page of the event. `office_url` is the issuing office's
    page (`https://www.weather.gov/lox`), the human-readable link.
  - `headline`: live = NWS's CAP headline ("Red Flag Warning issued … until … by NWS …"); `nws_headline` = NWS's own
    headline text. Archived: `headline` = the headline of the statement segment that names this event (one segment
    can head a warning and a watch: "...A... ...B..."); `nws_headline` = the whole headline paragraph.
    `message_type` is null for archived alerts.
  - `sender_name`: live "NWS Los Angeles/Oxnard CA"; archived "National Weather Service Los Angeles/Oxnard CA" (the
    product's own line).
  - Times: live = the CAP times. Archived = as the latest statement issued by `at_ms` gave them for the zone covering
    the reported location (else the zone that best describes the event at `at_ms`), so they match the quoted text and
    never reveal later extensions:
    - `onset_ms` = the statement's start for that zone (the archive's per-zone start when it says "in effect");
    - `ends_ms` = the statement's end; for an ended alert, the archive's per-zone end (when it actually ended);
    - `expires_ms` = null (a CAP message expiry; archived products have none);
    - `sent_ms` = `effective_ms` = the statement's time; its segment for that zone gives the text.
    `phase` uses the archive's per-zone times (some watches were upgraded or cancelled before they began).
  - `phase` at the reference time (now, or `at_ms`):
    - `upcoming` (before onset);
    - `in_effect`;
    - `ended`: past the end, or `vtec.action` CAN / UPG / EXP. Archived alerts stay listed 48 h after they end; live
      ones only while NWS lists them.
    Suggested UI mapping: `ended` + action CAN or UPG → "cancelled" / "replaced", other `ended` → "expired".
  - `covers_reported_location` (bool | null) and `nearest_km` (0 inside; null when a zone outline could not be loaded
    or there is no point). Distances use the full NWS polygons.
- `zones`: a FeatureCollection of the alert zones meeting the area. Feature `id` = UGC; `properties { ugc, name,
  alert_ids }` (`alert_ids` = the alerts above covering it). Outlines are simplified to about 100 m for display, so
  a point within about 100 m of a zone edge can test differently than in `covers_reported_location`.
- Archive search: IEM bypoint at the reported location and the four corners of the analysis area. The window is the
  whole record of a historical fire (start − 14 d … max(end, start + 3 d) + 2 d), else the UTC day of `at_ms` − 14 d
  … + 2 d. Polygons are fetched only for events issued by `at_ms`. Caveats say what was searched and what failed.
- Caveats always include `STANDING_NWS`: "A Red Flag Warning or Fire Weather Watch is a weather alert about fire
  danger, not an evacuation order. Follow local officials."
- When nothing is in effect or upcoming: "No Red Flag Warning or Fire Weather Watch … right now. That is not an
  all-clear: follow local officials." (live), or "… is in the archive for this area at the selected time. That is
  not an all-clear." (archive).
- NWS User-Agent: "Fire-3d/0.1 (research prototype)". The optional env `FIRE3D_NWS_CONTACT` (a website or email,
  sanitized) is appended inside the parentheses, for NWS requests only. No personal data by default.
- Credits:
  - live: "National Weather Service" (public domain, open data, https://www.weather.gov/disclaimer);
  - archive: "National Weather Service, archived copy via the Iowa Environmental Mesonet (Iowa State University)",
    public domain, not an official NWS source (https://mesonet.agron.iastate.edu/disclaimer.php);
  - CAL FIRE: "CAL FIRE".

### map (I3 hit-test, I4 fire bounds, I6 mount, opening camera, overview markers, aerial, 3D buildings, orbit)

As built 2026-10-18 (`web/src/map/**`, `web/src/lib/fireBounds.ts`).

**I4 fire bounds** (`web/src/lib/fireBounds.ts`, pure, tested):
```ts
type LonLatBox = [w, s, e, n]
fireBounds({ grid?, burned?, p90?, perimeter?, point?, acres? }): LonLatBox | null
aoiBounds(grid): LonLatBox                // the AOI's true UTM square, as a lon/lat box
hasMappedFire(input): boolean             // burned area, perimeter or P90 reach present
```
- `grid` = `manifest.grid` (ready or building); `burned` = observed_arrival and `p90` = the selected forecast's
  arrival_p90 (`{ data, width, height }`, e.g. data/rasters.ts `LoadedLayer`; finite arrival = fire); `perimeter` = the
  newest perimeter (local metres); `point` = CAL FIRE's reported location; `acres` = CAL FIRE's acreage.
- Mapped data: union of burned area, perimeter, P90 reach and point, grown by 40 % of its span (20 % each side), at
  least 3 km on each axis, never larger than the AOI (shifted inside it, not shrunk). Nothing mapped: 2.5 acreage-circle
  radii around the point (at least 3 km across), inside the AOI when there is a grid. Nothing at all: null.
- The open fire's box, once its rasters are in: `useMapRuntime.getState().fireBounds` (null otherwise).

**Opening camera (O-R4)** (`web/src/map/framing.ts`, pure `goalFor()` + `Framing` state machine, tested):
- One flight per target, issued when its goal is ready: a ready bundle once its fire rasters are in (bounded wait 6 s,
  then the vector data), a building bundle's grid, or CAL FIRE's point and acreage for a fire without a bundle. The
  overview's goal is California `[-124.48, 32.53, -114.13, 42.01]` in the safe area (z5.2 at 1440x900, z4.5 phones), or
  the overview view the user last left (Back / "← All fires").
- `null -> id` keeps a view restored at mount (`?view=`, Forensic hand-off) when the link names that incident.
- Done only when the fit completes; a fit stopped off target by a non-user call (compass, 2D/3D switch, padding) is
  issued again once the camera is free (at most 4 times); a gesture on the map (drag, wheel, keys, touch) or an
  explicit request (`requestMapFlyTo`, `useStore.flyTo`, the overview list) ends the opening framing. A provisional goal
  (point / building) is replaced by a better one only while the user has not moved. The padding is set before every fit;
  when MapLibre cannot fit, the camera eases to the box centre (padding included).
- Views are written to `useWorkspace.view` only once settled (never mid-flight or while waiting for data).
- Runtime (`useMapRuntime`): `framing: 'idle' | 'waiting' | 'flying' | 'done' | 'user'` (screenshot scripts can wait for
  `'done'`), `framedKind: 'overview' | 'fire' | 'area' | null`, `actions: MapActions | null`:
  `frameFire()`, `frameArea()`, `frameOverview()`, `rotateBy(deg)`, `tiltBy(deg)`, `topDown()`, `northUp()`,
  `zoomBy(delta)` (relative to the opening fit while it flies), `retryAerial()`.
- `useWorkspace.returnToIncident()` (shell; used by the search box's "Showing the Eaton Fire") frames the fire itself
  through the mounted map's `actions.frameFire()` (the AOI box only when no map is mounted). The map's "Incident" button
  toggles fire / modeled area (O-R5); MapNotices' "Return to incident" frames the fire. On the overview the button
  reads "California".

**Fire markers (O-R2, decision 10)** (`web/src/map/overviewLayers.ts`, source `fx-overview-fires`, layers `OVR.*`):
- Exactly the shell's set `overviewFires({ live, season, historical }, useWorkspace.overviewFilter)`, at every zoom;
  rebuilt when a list, the filter or the units change (never per frame).
- Circle radius by sqrt(acres), 4-13 px; active fires (`isActiveFire`) filled orange with a white ring, other fires
  hollow amber, a dark casing (light on Roads); labels "Name · 1,234 ac" (ha in metric) for active fires and fires of
  20,000 ac or more, placed around the marker and dropped on collision (active and larger fires first); an invisible
  hit circle of at least 11 px radius; the open card's fire gets a ring (`fireCardId`).
- While a fire is open (focused by zoom or opened): markers at `DIM_OPACITY` 0.55, drawn below the open fire's own
  markers; the open fire's marker is left out (its reported-location ring shows it); while a past fire is open
  (`mode: 'historical'`), fires that started after the timeline time are left out too (honest replay). Filters change
  only when that set changes.
- Hover: CAL FIRE's official record (acres, containment, status, update time) as text.

**Focus by zooming (decision 10)** (`web/src/map/focus.ts`, pure, tested; evaluated by `MapController` 300 ms after the
camera settles, never during a gesture, a flight or the opening framing):
- Candidates: every prepared fire (`bundle_status 'ready'` with a list row `bbox_lonlat`) of all three lists
  (`catalog.live`, `catalog.season`, `catalog.historical`: `allFocusCandidates`), whatever the overview filter, which
  only decides the markers, their chips and the panel list. E.g. with the 2026 season shown, zooming in over Altadena
  focuses the 2025 Eaton Fire.
- Enter at `FOCUS_IN_ZOOM` 8.5: the candidate whose area meets the central part of the visible map (the middle
  `CENTRAL_FRACTION` 0.5 of the safe area's width and height, unprojected, so it works in 3D) and lies nearest the
  camera centre. Stay while zoom >= `FOCUS_OUT_ZOOM` 7 and the open fire's area (manifest grid or row `bbox_lonlat`;
  without one, its reported point) is in view, unless it left the central part and another candidate qualifies to
  enter, or (integration) the view is centred inside another candidate's area and outside the open fire's own area
  (neighbouring analysis areas overlap: dragging from Henderson onto Norte switches; a centre inside both keeps the open
  one). Leave below 7, or when the open fire left the view and nothing qualifies: `focusIncidentFromMap(null)`.
- Official areas (integration): a `MapFlyTo` with `source: 'official'` (an evacuation zone, an NWS alert's zones; from
  `fitOfficialBounds` and the Layers drawer) starts `FocusHold`: the focus rule keeps what is open (`focusUnlessHeld`;
  a change pending in the store's debounce is cancelled) until the user moves the map again (a gesture: drag, wheel,
  keys, touch, the zoom buttons), another explicit flight or framing, or the open fire changes. Orbit buttons keep the
  hold. MapLibre starts a wheel zoom without an `originalEvent` (only its `moveend` carries the wheel event), so the
  hold also ends when a move ends by the user or right after input on the map.
- The map calls `useStore.getState().focusIncidentFromMap(id | null)` (shell) only when the answer differs from what
  is shown, or to cancel a request of its own still pending in the store's debounce.
- Camera: a new incident whose `useStore.incidentSource === 'zoom'` (set in the same update) is never framed
  (`Framing.setTarget(id, { keepCamera: true })`); every other source frames it as before. The overview view that
  Back / "← All fires" returns to is only one below zoom 7, so it never refocuses a fire.
- Other prepared fires in view (`web/src/map/nearbyPerimeters.ts`), from all three lists like the focus: from zoom
  `NEARBY_MIN_ZOOM` 7, up to `NEARBY_MAX` 8 nearest the centre (never the open one): their bundle `manifest.json` (grid) and `perimeters.json` are fetched
  once per `bundle_built_ms` (`/api/bundles/<id>/…?v=`), and their latest perimeter is drawn as a lighter dashed
  outline (`LYR.nearbyLine`, label from z9.5 "Palisades Fire · perimeter Jan 12, 2025"), following the perimeter
  toggle; in a past fire's replay, the newest perimeter published by the timeline time, and none for fires not
  started then. `useMapRuntime.overlays.nearby` counts them (legend "Prepared fire perimeter" on the overview, "Other fire
  perimeter" while a fire is open).
- Unprepared fires: zoomed in near one (zoom >= `CHIP_ZOOM` 9, reported point in the central part, at most
  `CHIP_MAX` 2 nearest the centre: `chipTargets`), a chip under its marker: "Spread not prepared yet · Prepare
  analysis (1-3 min)" ("Spread being prepared (1-3 min)…" while building). Its click opens the fire card; nothing
  builds on zoom or click.

**I3 clicks** (`MapController.onClick`): camera icons first; then a chip or another fire's perimeter outline ->
`setFireCard(id)` (no camera move); then event markers (`selectFeedItem`); then a fire marker or label at any zoom
(nearest marker centre wins) -> `setFireCard(id)` + `requestMapFlyTo(fireFlyTo(row))`, no location select; inside a
fire, the fire's own marker, label or hit circle (`LYR.incidentHit`, 24 px) -> `setFireCard(incidentId)`, no select;
any other click closes an open card (`setFireCard(null)`) and selects the point as before.

**Basemap (O-R10, O-R12)**: the map renders `useWorkspace.basemap` (effective). When the USGS photos fail (4 tile
errors and no tile, or no tile within 8 s while the tab is visible) it calls `setBasemapFallback('dark')`: the aerial
style and every USGS request go away. MapNotices shows "Aerial photos are not loading (USGS); showing the street map."
with "Try aerial again" (`actions.retryAerial()` = `setBasemapFallback(null)`); picking aerial in the menu does the same
through `setBasemap`. Past z16.5 on aerial: "Photo detail ends here …" (USGS stops at level 16).

**Aerial legibility (O-R11)**: theme `'aerial'` in `layers.ts`: 3.6 px dark casings under the AOI and perimeter lines,
12 px area / perimeter labels with 1.6 px halos, the observed fill fading to 0.55 between z12.5 and z13.5 (its edge
stays), detection footprints outline-only and fainter; aerial major roads at 0.45 alpha (`basemapStyle.ts`). Photo date:
`aerialPhotoLine(startedMs)` in `providers.ts` ("Aerial photos: USDA/USGS, June 2024 or earlier: taken before this
fire"; source: the MapServer's copyrightText "Data refreshed June, 2024"), in the legend and the basemap menu.

**3D buildings (O-R13)**: `BUILDINGS_3D_LAYER` (`fx-buildings-3d`), one muted fill-extrusion per basemap (dark
`#4a5566`, roads `#a8a095`, aerial `#c3c9d1`, opacity 0.6, fading in z14.5 -> 15), directly below the labels, visible
in 3D only, never coloured by fire state; liberty's own extrusion is dropped. Draped overlays go below it
(`DerivedStyle.overlayBeforeId`), so the 3D draped layers stay one render-to-texture stack. Legend caveat:
`buildingsCaveat()` ("3D shapes: today's OpenStreetMap; buildings destroyed by this fire may be missing; not a damage
assessment").

**Orbit group (O-R14)**: in 3D a second controls row: rotate ±15°, tilt ±10°, "Top-down" (pitch 0, terrain kept),
"North up"; a one-time gesture hint (`localStorage['fire3d.orbitHintSeen']`); the canvas label lists Shift + arrows.

**I6 mount**: `mountOfficialLayers(map, { beforeId: [EVAC_LAYERS.tint, ...drapedLayers ids], topBeforeId: topLayers ids })`
right after `bindExtrasLayers(map)`; `remove()` before `map.remove()`.

### location (search, towns and ZIP codes, overview search, card summary, official line, coordinate strip; as built 2026-10-18)

**`GET /api/geocode` (CONTRACT §6, additive).** One endpoint, three kinds, said in every reply: top-level `kind`
(`'address' | 'place' | 'zip'`) and `local` (true = matched locally, no upstream call), and `kind` on each match.
- Classification (`backend/fire3d/api/geocode.py`): a 5-digit ZIP (also ZIP+4, "CA 91001", "91001 CA") → local ZIP
  areas; text starting with a house number → the Census Geocoder (unchanged); other text with letters → local towns;
  anything else → 400. Coordinates stay 400 (the browser parses them).
- Local index `backend/fire3d/data/gazetteer_ca.json` (131 KB, 46 KB gzipped), built by
  `backend/scripts/build_gazetteer.py` from the **2026 U.S. Census Bureau Gazetteer Files** (public domain): 1,622
  California places (462 cities, 21 towns, 1,139 CDPs) and 1,802 ZCTAs (ZIP prefixes 900-961). Positions are each
  area's internal point (approximate). Credit: "U.S. Census Bureau Gazetteer Files".
- Local matches add `name`, `place_type` (`city | town | cdp`) + `place_type_label`, `zip`, `land_km2`, `exact` (the
  whole name, or the name in parentheses: "Ventura"), `near` / `near_km` (same-named places: the nearest city or town;
  ZIP areas: the nearest place within 25 km). Town matching folds accents and punctuation, `mount/saint/fort` =
  `mt/st/ft`, every word must start a name word; exact > prefix > all words, then city > town > CDP, larger first; at
  most 8. Local replies: `benchmark: null`, `vintage`, `source: "U.S. Census Bureau Gazetteer Files"`, a `note` (or,
  with no match, why: "Landmarks, businesses and street names without a house number are not searched", "not a
  California ZIP area"). 503 when the index is missing (addresses still work).
- **Git:** the root `.gitignore` line `data/` also ignores `backend/fire3d/data/`. It must be followed by
  `!backend/fire3d/data/` or the index is never committed (integrator; verified in a scratch repo).

**Search box (`location/SearchBox.tsx`, logic in `search.ts`, tested).**
- Labelled "Check an address" (sub-label "street, town, ZIP code or coordinates"), placeholder "e.g. 600 E Mariposa St,
  Altadena". `#mw-search input` is still the input (the shell's `focusSearch()` works).
- Plan: coordinates → select; one **exact** incident name (full name, id, or name + its year) → open it; a bare name
  ("Eaton") opens the fire only when the town lookup finds no exact town of that name; everything else → `/api/geocode`.
  Other incident matches are only listed: "Analysis ready", "Being prepared", "Data not prepared" ("opens its card").
- Opening a prepared fire from search (and from the overview card) is explicit: `openFromSearch(id)`
  (`location/openFromSearch.ts`) = `setFireCard(null)` + `selectIncident(id, { source: 'search' })`, never
  `autoBuild`. An unprepared fire: `requestMapFlyTo(fireFlyTo(row))` + `setFireCard(id)`: its card asks. The
  current fire: `returnToIncident()` + "Showing the Eaton Fire".
- A town or ZIP pick clears the previous point, flies to a box sized by the area's land area (3-50 km) and says "Showing
  Altadena (town center, approximate). To check a spot, enter a street address with a house number, or click the map."
  with the Gazetteer credit; other matches stay listed.
- State machine (`searchReducer`, `cancelledLookup`): every lookup has a sequence number; Escape, an edit, Clear, an
  outside pointer-down (the map included), a new selection and a pick close the one popover and abort the request;
  a reply with an old number is dropped. **A change of `incidentId` (zoom focus, decision 10) closes nothing.**
  Phones: focusing the box closes open sheets (`setPanel(k, false)` for updates / layers / analysis); a pick blurs.
- Errors in plain words (`plainSearchError` in `geocodeClient.ts`): no status codes.
- `location/searchUi.ts`: `useSearchUi.popover` = the popover's viewport box while open. The card yields to it
  (`cardYield`): pushed down on desktop, a shorter or hidden sheet on phones. Nothing else needs to read it.

**Location card (`LocationCard.tsx`, `CardParts.tsx`, `OverviewCard.tsx`; wording in `describe.ts` / `official.ts`).**
- Inside a fire, four blocks (`describeLocation(r, opts).summary`): `near` (inside / distance + direction to the
  mapped edge or estimated area, Mapped / Estimate tag, basis time and age, `stale`); the official block; `model` (the
  dated sentence in Public: "In the experimental model, N of M simulated fires reached here by <end> (<h> h). Not a
  safety guarantee."; Command adds `figure` and `run` = run id, issue time, members, period + arrival quantiles) and up
  to three `reasons` (`wind` relative to the point: toward / away / across, Model; `dryness`: humidity and 1-h fuel
  moisture as numbers, Model, citing an NWS Red Flag Warning in effect as Official; `terrain`: uphill of the nearest
  edge when ≥ 30 m and ≥ 5 % average grade, Terrain data); `reliability` (latest fire observation + Stale by the
  timeline's 6 h rule, model issue time, "Research prototype, not an evacuation order"). Details stay one tap away.
- `LocationReport` additions: `dryness`, `edgeRise`, `latestObservationMs`.
- While a fire just focused or opened is loading (`incidentLoading` and no ready manifest of that id), the card keeps
  the point and says "Loading the Eaton Fire’s data for this spot…" instead of "no data".
- The official block uses `useOfficialAtPoint(sel.lon, sel.lat)` (I5) and is always present (phones, replay, layer
  off): zones verbatim with issuer and own times (and "Cal OES does not say which fire this is for" with the
  distance), "No evacuation order or warning listed here · Cal OES, checked … · not an all-clear" only where checked,
  "not checked here", "not shown for past dates", "unavailable"; an NWS line only while an alert is in effect or
  upcoming at the point ("Fire weather alert here: Red Flag Warning until …", sender, archived copy, and the caveat "a
  weather warning, not an evacuation order", kept on phones); then "Follow local officials." with CAL FIRE and Cal OES
  links (https only, + county maps). Phones (compact card, integration) keep a listed zone's issuer, its own time and,
  for a zone away from the fire, the distance and "Cal OES does not say which fire this is for"
  (`OfficialLine.subCompact`, e.g. "Orange County · listed by Cal OES Oct 17, 18:01 PDT"), "Cal OES · not an
  all-clear" under "No evacuation order or warning listed here", and an NWS line's sender, "archived copy", caveat and
  "Read it" link (`CardParts.tsx` shows the link in the compact card too).
- On the overview (`incidentId === null`) the card shows the nearest fires (`incidents.ts overviewNearby`: CAL FIRE's
  reported points, three nearest + the nearest active fire, "Distance from here to where CAL FIRE reported each fire,
  not to its edge. Distance alone does not tell you the risk."), the official block, and, when a prepared fire's
  `bbox_lonlat` contains the point, "Zoom to the Eaton Fire" (an explicit open, framed). Rows: prepared → explicit
  open; unprepared → its card.

**Coordinate strip (`CoordinateStrip.tsx`, reads `useCoordsVariant()`).** `'full'` as before; `'compact'` decimal
only (the overview shows "California overview · No fire open" and the selected point); `'line'` one 32 px line
(`.loc-strip.is-line`): the selected point ("Selected" / "Address"), else "<Fire> reported", else "Search or click
the map to get coordinates", one copy and one centre button.

### integration (b2-integration, as built 2026-10-18)

The pieces above as one app; each change is also written into the owning sub-heading.
- **Official fits keep the open fire** (map "Focus by zooming", shell `MapFlyTo.source`, official-web): `FocusHold` and
  `focusUnlessHeld` in `map/focus.ts`, tested with the real Henderson / Norte / Orange County zone boxes
  (`map/focus.test.ts`, `official/select.test.ts`).
- **Neighbouring fires**: centring the view inside another prepared fire's area (outside the open fire's) switches the
  focus (map "Focus by zooming").
- **NWS outlines** are quiet; their labels and a selected NWS alert are drawn below the fire layers (official-web I6).
- **Layer stacking after a style load** (`extras/mapLayers.ts`): evacuation zones, imagery and NWS outlines return
  below the fire layers after every basemap load (they were drawn above the fire before; official-web I6).
- **One image list per screen** (official-web I5 components): `ImageryLayerSummary` in the wide Layers drawer.
- **Public words**: `forecastDescription(..., { plain })`; the Layers drawer notes, the view-switch and Analysis-drawer
  tips say "model re-runs on past weather"; the Analysis drawer's charts in Public name the model "Model forecast" /
  "Model re-run" without run ids (Command and Forensic keep "Forecast <run id>", P50, P10–P90; `ui/Charts.tsx`
  `useModelNames`); the replay's forecast-start stop drops "(a hindcast …)".
- **Phone card official lines** keep the issuer, the source's own time, the "which fire" caveat, "not an all-clear"
  and the NWS sender, archive label and link (location).
- **Timeline freshness line** (`.ctl-latest`) wraps in reading order on phones instead of four squeezed columns.
- **Forensic setting** "Auto-build unbuilt incidents" is now labelled "Prepare analysis when I pick an unprepared fire"
  (off by default; only the Forensic incident picker uses it).

### final verification (as built 2026-10-18)

Small changes after the live end-to-end check; no HTTP contract changed (SPEC §5-6, `contracts.py` and
`web/src/api/types.ts` are unchanged).
- **CAL FIRE outage vs no record** (official-web I5): `CalFireStatus.unreachable?: boolean` (`official/calfire.ts`) is
  set when the endpoint answers `reason_code: 'upstream_error'` without a record or the request fails. The compact
  "Official now" line (`ui/shell/officialSummary.ts`) then says "Unavailable right now." instead of "No record for this
  fire." (which stays for demo data and fires with no CAL FIRE record).
- **CAL FIRE change rows** keep CAL FIRE's precision (up to one decimal): "1,037 acres (was 1,036.8)" instead of
  "1,037 acres (was 1,037)" (`changeTitleParts`; a real 0.2-acre edit of the Cooley record on Oct 18, 2026).
- **Aircraft polling** (`state/runtime.ts`): `useLivePolling({ aircraft })`; App passes `workspace === 'forensic'`, so
  `/api/incidents/{id}/aircraft` is polled every 10 s only while Forensic, the only workspace that shows aircraft, is
  open (adsb.fi, the fallback provider, is for light non-commercial use). Entering Forensic polls at once.
- **Data credits** (`lib/dataCredits.ts` `bundleCredits(sources, { …, forecastModel })`, `ui/DataCredits.tsx`): the
  "Data sources" note (Analysis drawer, Forensic Evidence tab) adds "NASA Earthdata CMR (satellite pass times)" when
  the bundle lists `NASA CMR satellite passes`, and "Fire-spread model: pyretechnics <version> (Spatial Informatics
  Group, Eclipse Public License 2.0)" when a forecast is shown (never for synthetic fixtures).
- **Legend** (`map/MapLegend.tsx`): the compact 3D row reads "3D shapes: today's OSM, not a damage assessment" (was
  "… not damage") and carries the full decision-8 caveat as its tooltip.
- **Build progress card** (`ui/Overlays.tsx`): "Preparing the analysis" with plain source names (was "Building incident
  bundle"); Forensic's not-prepared card says "Analysis not prepared" with a "Prepare analysis (1-3 min)" button.
- **Forecast warning text** (`backend/fire3d/spread/ensemble.py` `adjustment_note`): the decay-from-activity case now
  states the engine's formula, "0.5 x (0.1 + 0.9 x e^(-lead/12 h))" (it read "0.5 x (floor 0.1 + e^(-lead/12 h))").
