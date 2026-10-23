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
useOfficialBadge(): { count: number; level: 'order' | 'warning' | 'local' | 'fire-weather' | null }   // 'local': brief 3 (14.15, part 1 review fixes)
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
  time. `outsideAnalysisArea` → show "Cal OES does not say which fire this is for." (`NOT_FIRE_SPECIFIC`, removed by
  the brief-3 integration: the sentence now names each zone's aggregator, `notFireSpecific`; 14.0 as built).
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
  children`. `FeedTopic` adds `'calfire' | 'fire-weather' | 'quiet'` (`'calfire'` removed by the brief-3 integration:
  the agency record's rows use the topic `'record'`; 14.0 as built). `FeedFilter = 'official' | 'all' | 'key'`.
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
  "not checked here", "not shown for past dates" (brief 3: "not available for past dates", 14.15), "unavailable"; an NWS line only while an alert is in effect or
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

---

## 14. Brief 3 (US) interfaces

Written by the planner on 2026-10-22, before wave 1, and revised twice the same night after two independent critics
(what changed: `docs/redesign/PLAN-3.md`, "Revision notes", first and second pass); from `docs/redesign/BRIEF-3.md`
(decisions 1-4, rounds 2 and 3), the four audits in `docs/redesign/audit-3/` and `docs/redesign/PLAN-3.md`. Audit
references: B-R* = `backend.md`, W* = `web.md`, EV-* = `evacuations.md`, V-* = `validation.md`. Every interface below
is **fixed**: implement it or consume it exactly. A role that has to deviate records it in its report
(`contract_deviations`) and in its as-built note (14.15). Round 3 removed Washington completely: there is no
Washington adapter, flag or certificate anywhere.

### 14.0 Rules for wave 1

**Roles and ports** (`docs/redesign/plan3-roles.json` lists every owned path):

| Role | Owns (short) | API | Vite | Start |
|---|---|---|---|---|
| `us-catalog` | backend list, contracts (`contracts.py`, `SPEC.md`, `web/src/api/**`), regions, UTM, FIRMS feed, live loop list, records endpoint, accuracy file seed, gazetteer, fixtures | 8711 | 5181 | first batch |
| `us-web` | `web/src/lib/**` (incl. `lib/time.ts`), `state/**`, `map/**`, `scene/**`, `styles/**`, `ui/` (except feed and 4 official shell files), `location/` (except `official.*`), `data/**`, `App.tsx`, `index.html`, `web/scripts/**` | 8712 | 5182 | first batch |
| `us-official` | backend `api/extras.py` + new `sources/evacuations.py`; web `official/**`, `extras/**`, `ui/feed/**`, `ui/shell/{officialSummary,dataStatus}*`, `ui/shell/{UpdatesPanel,LayersPanel}.tsx`, `location/official*` | 8713 | 5183 | first batch |
| `us-pipeline` | backend `build/**`, `spread/**`, build sources, `nws.py`, new `openfema.py`, `api/official.py`, `api/jobs.py`, `cli.py`, `config.py`, `http.py`, `bundle.py`, `types.py`, `timeutil.py` | 8714 | 5184 | 4th: the first free slot (see "Schedule") |
| `validation` (wave 2) | GSI live fuel moisture, `spread/validate.py` regional tooling, `regional_accuracy.json`, `docs/validation.md`; bug fixes only in the build code it exercises | 8716 | - | after wave 1 is reviewed and fixed |

- **One owner per file.** The contract files `backend/fire3d/contracts.py`, `SPEC.md` and `web/src/api/**` belong to
  `us-catalog` alone; it transcribes every pydantic model and every `web/src/api/types.ts` shape of this section.
  Official response TS types stay where brief 2 put them (`web/src/official/types.ts`, `web/src/extras/types.ts`,
  owned by `us-official`); geocode TS types stay in `web/src/location/types.ts` (`us-web`).
- **CONTRACT.md is not edited in wave 1.** Each role writes its as-built note in its own file
  `docs/redesign/contract3/<label>.md` (this replaces the runbook's "append to §14"); the integration folds them in.
  `README.md` is updated by final verification from 14.13; `docs/validation.md` by the validation role.
- **Shared working tree.** All agents work in one checkout. Commit with a pathspec so that only your own paths are
  committed, whatever else another agent has staged: `git add -- <your new paths> && git commit -m "<message>" --
  <your paths>` (a plain `git commit` commits the whole index, including another role's staged files). A file of
  another role that shows as modified is theirs: never stage, restore or edit it. Milestone commits start with
  `brief 3 <label>: M<n>` (for example `brief 3 us-catalog: M3 national list`), so others can wait for them with
  `git log --oneline --grep 'brief 3 us-catalog: M3'`. Expect your own test fixtures to need the new fields of 14.1
  as soon as `us-catalog` lands them: update your fixtures, never the contract.
- **Gate failures in a shared tree.** When a gate fails only in another role's uncommitted or just-committed file
  (its test, its module), record the file and the test in your report, do not touch it, and rerun that gate after
  that role's next commit. Your own report is complete when every failure is either fixed in your files or
  attributed this way.
- **Fields added to an existing response model are defaulted in wave 1.** A producer owned by another role may not
  emit a new field for hours, and the strict tests (`contract_problems(...)` in `test_official_nws.py`,
  `test_official_real_bundles.py` and others) treat a missing required field as an error. So every field that wave 1
  adds to an existing Python response model is declared with a default (`Optional_()`) and marked **(R)** in this
  section: `FireWeatherResponse.states_checked` / `alert_states` and `FireWeatherAlert.time_zone` (14.6),
  `LiveStatus.detections_24h`, `IncidentListResponse.sources` (14.1), `SkillEntry.growth_sorensen` (14.12.7) and
  every new `IncidentSummary` field. Only Literal widenings (`OfficialEnvelope.kind`, `reason_code`) change existing
  fields. (The evacuation response has no Python model; its 14.8.2 additions are optional in
  `web/src/extras/types.ts` until the integration.) The integration makes the (R) fields required once every producer
  sends them. `us-catalog`'s acceptance includes, at its M1 commit, `test_official_nws.py`,
  `test_official_real_bundles.py` and `test_extras.py` passing with `nws.py`, `api/official.py` and `api/extras.py`
  unchanged.
- **Schedule** (at most 3 agents at once). `us-catalog`, `us-web` and `us-official` start together. The first free
  slot goes to `us-pipeline` (the critical path to validation). Its M1 (weather quota) needs nothing from the other
  roles; it starts its build-anywhere milestone only after `us-catalog`'s M3 commit is in `git log` (until then it
  works on the NWS and local-alerts backend, which needs only `us-catalog` M1 and M2). Reviewers and fixers take the
  later free slots, one agent per slot, in the order the roles finished; there is never a 4th agent. `us-pipeline`
  reads `docs/redesign/contract3/us-catalog.md` when it exists, otherwise this section plus `us-catalog`'s commits.
- **Hand-offs** (sequential, so ownership stays disjoint at any moment): once `us-catalog` has finished and its
  review and fixes are committed, `us-pipeline` may update the build-gate tests in `backend/tests/test_api.py`
  (14.2) and lists each change in its report. The wave-2 `validation` role may fix bugs in the build code it exercises
  (its role entry lists the files), each fix with a regression test named in its report.
- **Day-one deliverables** (others code against this section until they land; each is committed on its own):
  - `us-catalog` M1 (first 60-75 min): every pydantic model of 14.1-14.7 and 14.12 in `contracts.py` (including
    `IncidentRecordResponse`, `LocalAlertsResponse` and the 14.6 additions, all defaulted as above), the
    before-validator of 14.1, the TS of 14.1-14.4 in `web/src/api/types.ts`, the fetchers of 14.3/14.4 in
    `web/src/api/client.ts`, the record helpers of 14.5 in `web/src/api/records.ts`,
    `web/src/api/fixtures.testutil.ts` (`summaryFixture()`), and SPEC §5.1/§6 rows. Until M2 lands `regions.py`, the
    before-validator leaves `state` and `time_zone` unset (omitted), so the web shows the viewer's zone, labelled
    (never Pacific); M2 fills them.
  - `us-web` M1 (first 60 min): the new API of `web/src/lib/time.ts`, `web/src/state/timeZone.ts` and
    `web/scripts/check-time-api.mjs` (14.9).
  - `us-official` M1 (within 60 min of `us-web` M1): the optional `tf?` shims of 14.9.6 and the
    `EvacuationOfficial.state 'not-available'` value (14.8.5).
  - `us-catalog` M2 (by about 2 h): `fire3d/regions.py` + its data files + `GET /api/geo/lookup` (14.3), the UTM rule
    (14.12.4) and `make_fixture.py --only east` (14.12.9).
- **Never change the signature of an export that another role's file imports.** Add a new export (or a new optional
  parameter) and mark the old one `@deprecated`; the integration removes deprecated exports once nothing imports them.
- **Switches** are one module constant each (14.2). There is no Washington switch (round 3).
- **No new dependencies** in any role (shapely, scipy, pyarrow, httpx, MapLibre clustering are already present).
- **Builds**: only `us-pipeline` (2 smoke fires outside California, a 3rd below its cut line, each after the weather
  probe says `overall: ok`; the live 3rd also needs `live: ok`, 14.12.2) and `validation`. Nobody presses "Prepare
  analysis" in a browser.
- **Wording scan** (every role, before it reports): on the lines it added since wave 1 began, `git diff $(git log -1
  --format=%h --grep '^brief 3 planner') -- <its non-test source paths> | grep '^+' | grep -inE
  '\bsafe\b|low risk|all[- ]clear|Fire[T]race'`; each hit is listed and justified in the report (a negation such as
  "not an all-clear", a CSS "safe area", a code comment). A user-facing "safe", "low risk", implied all-clear or the
  reference demo's name is a bug to fix (the pattern `Fire[T]race` matches that name without writing it). The
  integration and final verification run the same scan over the whole brief.

#### 14.0 as built (integration, part 1)

- Wave 1 ran with the orchestrator's schedule change (first batch `us-catalog`, `us-web`, `us-pipeline`;
  `us-official` in the first free slot); each role was reviewed in a clean worktree and fixed (reports
  `docs/redesign/reports/review3-*.json`, fix rounds in each role's report). The integration's part 1 ran while
  `validation` (wave 2) was still building; validation's own files and the build code it may fix were left to part 2
  (`docs/redesign/reports/brief3-integration.json`, key `part2`).
- **(R) fields** are required (Python: `LiveStatus.detections_24h`, `IncidentListResponse.sources`,
  `FireWeatherResponse.states_checked` / `alert_states`, `FireWeatherAlert.time_zone`; TS: the same plus the five
  `IncidentSummary` fields, and the official and extras types; details in 14.1, 14.6 and 14.8 as built).
  `SkillEntry.growth_sorensen` stays optional (forecast manifests built before brief 3 lack it). The parity test now
  also covers `web/src/official/types.ts` (`IncidentRecordResponse`, `IncidentRecordCurrent`, `LocalAlert`,
  `LocalChannelStatus`, `LocalAlertsResponse` field for field; the brief-2 envelope fields `kind`, `incident_id` and
  `caveats` may stay optional in TS; the 14.6 additions required in both).
- **Deprecated exports removed** (no importer left): the 19 Pacific-bound names of `lib/time.ts`, `insideCalifornia`,
  `NOT_FIRE_SPECIFIC`, `fmtStatusTime`, the feed topic `'calfire'`, `useCalfire`, `fill_from_calfire`,
  `overpass.la_time`. Kept: `IncidentSummary.calfire_uid` and `LiveStatus.detections_24h_ca` (response fields, "one
  release"), and in validation's files `firms.load_live_ca` / `load_year_ca`, `catalog.HISTORICAL_YEAR`,
  `pipeline.spec_incident_id` (part 2 or later).
- **Hand-off:** the `test_api.py` build-gate tests were updated by the integration (14.2 as built).
- **Wording scan** (item 4a of PLAN-3) over the whole brief: see the integration report.

### 14.1 Incident summary, list rows and live status (`us-catalog`)

**`IncidentSummary` additions** (Python `contracts.py` and TS `web/src/api/types.ts`; every existing field keeps its
meaning unless noted):

```ts
export type RecordSource = 'calfire' | 'wfigs'
export type AccuracyRegionId = 'NWCC' | 'NRCC' | 'GBCC' | 'SWCC' | 'SACC-SP' | 'SACC-SE' | 'RMCC' | 'EACC' | 'ONCC' | 'OSCC'

export interface OtherRecord {          // another agency's record of the same fire (California rows matched to WFIGS)
  source: RecordSource
  id: string                            // CAL FIRE UniqueId or IRWIN id
  name: string                          // that record's name, verbatim (a complex member's own name)
  issuer: string                        // same rule as record_issuer
  agency: string | null                 // plain protecting-agency name, null if unknown
  agency_code: string | null            // verbatim code ("USFS"), null for CAL FIRE
  acres: number | null
  percent_contained: number | null
  is_active: boolean                    // that agency's own active status
  updated_ms: number | null             // that record's own update time
  url: string | null                    // that record's human-readable page (https)
}

export interface IncidentSummary {
  // ... existing fields ...
  uid: string                           // (R) CAL FIRE UniqueId, or IRWIN id (upper case, no braces)
  calfire_uid: string                   // DEPRECATED: the CAL FIRE UniqueId, or '' when the row is not CAL FIRE's record
  record_source: RecordSource           // (R) whose record this row is; filled as 'calfire' on read when absent (old fixtures)
  record_issuer: string                 // (R) "CAL FIRE" | "USFS via NIFC WFIGS" | "NIFC WFIGS (IRWIN)" (14.2)
  state: string | null                  // (R) USPS code of the point of origin (48 states + "DC"); null only off-US fixtures
  time_zone: string                     // (R) IANA zone of the reported location (regions.time_zone_at), never assumed
  agency?: string | null                // protecting agency, plain name: "USDA Forest Service"; "CAL FIRE" for CAL FIRE rows; null if unknown
  agency_code?: string | null           // protecting-agency code, verbatim ("USFS", "C&L"); null for CAL FIRE rows
  irwin_id?: string | null              // WFIGS rows; CAL FIRE rows matched to ONE WFIGS fire (rule 2 of 14.2); null on a CAL FIRE complex row
  unique_fire_id?: string | null        // NWCG UniqueFireIdentifier, e.g. "2026-TXTXS-000006"
  source_name?: string                  // the record's name verbatim (WFIGS names are often ALL CAPS)
  gacc?: string | null                  // WFIGS GACC code verbatim ("NWCC", "OSCC", ...)
  accuracy_region?: AccuracyRegionId | null   // null: "Accuracy not yet tested here" (14.4)
  active_sources?: RecordSource[]       // which records call the fire active (California may list both)
  other_records?: OtherRecord[]         // [] unless a California row matched WFIGS records (a complex row: one per member)
  complex_name?: string | null          // a member fire outside California: "Part of the X Complex"
  complex_members?: string[]            // a CAL FIRE complex row: its WFIGS member names, verbatim; [] otherwise
  aliases?: string[]                    // other ids that resolve to this row (14.2 "Id pinning"); [] otherwise
}
```

- **(R)** = required after the integration (the block above shows them as built: required since the brief-3
  integration). In wave 1 every new TS field was optional, so no role's test fixtures broke while the roles worked in
  parallel; the backend always sends every field. The integration makes the five (R) fields
  required once the fixtures carry them (`summaryFixture()` in `web/src/api/fixtures.testutil.ts` helps). Readers
  never fall back to Pacific time: a missing `time_zone` means the viewer's zone, labelled (14.9).
- Python: every new field exists on `IncidentSummary` with a default, and responses always carry all of them. A
  model validator (as built: `mode="after"`, filling only the fields the input did not give; see "14.1 as built")
  fills old manifests and fixtures: `uid ← calfire_uid`, `record_source ← "calfire"`,
  `record_issuer ← "CAL FIRE"`, `agency ← "CAL FIRE"`, `source_name ← name`, `state` / `time_zone` from
  `regions.state_at` / `regions.time_zone_at(lon, lat)` (fallback: the state's main zone, then `"UTC"`; never
  America/Los_Angeles by default; before `us-catalog` M2 lands both stay unset), `active_sources ← ["calfire"] if
  is_active else []`, lists `[]`, others `null`. So every existing bundle and both fixtures keep loading unchanged,
  and their `time_zone` comes from their location.
- The same concept has one name everywhere in this section: `agency` / `agency_code` (the protecting agency) in the
  summary, `OtherRecord` and the incident record (14.5); `message_type` for the CAP message type (as in brief 2's
  `FireWeatherAlert`); `record_issuer` for the issuer text.
- **WFIGS rows** (`record_source: "wfigs"`): `name` = display name (title-cased when the source is ALL CAPS, names with
  digits kept as they are, e.g. "Fd140011"), `source_name` = verbatim; `acres` = `IncidentSize`; `percent_contained` =
  `PercentContained` (null = not reported); `started_ms` = `FireDiscoveryDateTime`; `updated_ms` =
  `ModifiedOnDateTime_dt`; `contained_ms` = Containment, else Control, else FireOut (never inferred); `county` =
  `POOCounty` verbatim; `admin_unit` = `POOProtectingUnit`; `location` = null; `url` = the record page
  (`.../WFIGS_Incident_Locations/FeatureServer/0/query?where=IrwinID%3D%27%7B<IRWIN>%7D%27&outFields=*&f=html`);
  `year` = the `UniqueFireIdentifier` year.
- `is_active`: WFIGS rows: in the Current layer with `PercentContained` null or < 100 (a year-to-date row is never
  active on its own). California rows: per `CA_ACTIVE_RULE` (14.2; default "either agency").
- Not listed anywhere: prescribed burns (RX), complex parents (CX) outside California, Alaska, Hawaii, territories and
  foreign `POOState` values (`supported` rule 14.2).

**List endpoint** `GET /api/incidents?mode=live|historical&year=&min_acres=&state=`:
- `year` default = the current UTC year (2026); `min_acres` default 300 (historical only). `state` (optional USPS code)
  filters rows. The `live` list holds **every active wildfire in the lower 48, whatever its size** (round 2 item 1),
  sorted by `detections_24h` then acres, as today.
- The JSON is gzip-compressed when the request accepts it (`Accept-Encoding: gzip`, `Vary: Accept-Encoding`), in the
  handler (B-R17).
- `IncidentListResponse` gains `sources`:

```ts
export interface ListSource {
  id: 'calfire' | 'wfigs'
  name: string                          // "CAL FIRE" | "NIFC WFIGS (IRWIN)"
  status: 'available' | 'unavailable'
  retrieved_ms: number | null           // when Fire-3d fetched that list (never an issue time)
  reason: string | null                 // plain words when unavailable
}
export interface IncidentListResponse { mode: Mode; updated_ms: number; incidents: IncidentListRow[]; year?: number; sources: ListSource[] }   // sources: (R), required since the integration
// Python: IncidentListResponse.incidents stays list[IncidentListRow]; sources: list[ListSource] (required since the integration; Optional_() in wave 1)
```

  WFIGS down: California fires are still listed from CAL FIRE (plus bundles on disk), `sources` says WFIGS is
  unavailable, and the web shows "The national fire list (NIFC) is unavailable right now; only California fires (CAL
  FIRE) are listed." (14.14). CAL FIRE down: California's WFIGS rows still list, with the same kind of notice.
- **`LiveStatus`** gains `detections_24h: number | null` ((R), required in both since the integration; Python
  `Optional_()` in wave 1; FIRMS feed rows of the last 24 h inside the lower-48 state polygons); `detections_24h_ca`
  stays for one release. `active_incidents` = the live list length.

#### 14.1 as built

From `docs/redesign/contract3/us-catalog.md` (M1, M3) and the integration.
- `contracts.py`: the 14.1 "before-validator" is a `model_validator(mode="after")` that fills only the fields the
  input did not give (`model_fields_set`), with the same effect: a `mode="before"` validator turned strict JSON checks
  into strict Python checks and rejected every `bbox_lonlat` array. `state` / `time_zone` come from `fire3d.regions`.
- **Integration:** the five (R) fields are required in `web/src/api/types.ts` (`uid: string`, `record_source`,
  `record_issuer: string`, `state: string | null`, `time_zone: string`); in Python they keep a default because old
  manifests and fixtures lack them, and are filled on read and always dumped (`state` null off the US; a NIFC WFIGS
  summary without an issuer gets the 14.2 issuer text, never "CAL FIRE"). `IncidentListResponse.sources` and
  `LiveStatus.detections_24h` are required in both. The parity test (`tests/test_us_catalog_contracts.py`) treats the
  five as `FILLED_ON_READ` (Python default, TS required) and checks that every dump carries them.
- `/api/incidents`: `state=` (two letters, else 422), `year` default `catalog.default_year()`, `sources[]` always
  present, gzip in the handler when accepted and the body is at least 1 KB. Measured 2026-10-23 06:50 UTC (API 8715,
  both sources available): live 227 rows, 2026 list 1,193 (the overview's "2026 season" filter, live plus 2026 without
  duplicates, shows 1,388), 2025 list 856.
- `LiveStatus.detections_24h` counts inside the state polygons (`regions.in_lower48`); `SUMMARY_SYNC_FIELDS` also
  copies `active_sources`, `other_records`, `complex_members`, `irwin_id`, `gacc`, `accuracy_region`.

### 14.2 Ids, resolution, the California merge and switches (`us-catalog`; `us-pipeline` consumes)

- **Ids** (SPEC §4.4): CAL FIRE rows unchanged (`{year}-{slug}-{UniqueId[:6]}`), so every California link and bundle
  keeps resolving. WFIGS rows: `{UFI year}-{slug(name)}-{IRWIN hex[:6].lower()}`, e.g. `2025-emigrant-241e2b`
  (the validation audit's ids follow this rule).
- **Python API** (`fire3d/catalog.py`):
  - `resolve_listed(incident_id) -> IncidentSummary | None`: an id that a source list knows (CAL FIRE lists, WFIGS
    Current / year lists, then one cached `IrwinID LIKE '{ABCDEF%'` query on the all-years layer), with the id's slug
    and year checked. Never answers from a bundle manifest.
  - `get_summary(incident_id) -> IncidentSummary | None`: `resolve_listed`, else a bundle manifest on disk (as today:
    `fixture-demo`, `fixture-east` and other local bundles are served read-only).
  - `find_by_irwin(irwin_id) -> IncidentSummary | None`; `is_supported(summary) -> bool` (state in 48 + DC);
    `record_issuer(summary) -> str`.
- **`record_issuer` text** (also used by bundle text, 14.12.5): CAL FIRE rows `"CAL FIRE"`; WFIGS rows with a
  protecting-agency code `"<CODE verbatim> via NIFC WFIGS"` ("USFS via NIFC WFIGS", "C&L via NIFC WFIGS"); without a
  code `"NIFC WFIGS (IRWIN)"`. Cards add the plain name when known: "USFS (USDA Forest Service) via NIFC WFIGS".
- **California merge** (round 2 item 2, rounds 3.2-3.3; B-R1): CAL FIRE is the record. A WFIGS-CA row is dropped when
  (1) its `CpxName` equals a CAL FIRE complex name (the CAL FIRE complex row stays; its `complex_members` lists the
  WFIGS member names), or (2) it is the same fire as a CAL FIRE fire of that year or the year before: name tokens equal,
  <= 30 km, discovery -7/+20 days from CAL FIRE's start; or any name, <= 3 km, ±3 days. (3) Otherwise it is listed as
  a WFIGS row (64 such active fires on Oct 22).
  - What a CAL FIRE row carries from dropped rows. Rule (2), one fire: its `irwin_id`, `gacc`, one `other_records`
    entry, and `'wfigs'` in `active_sources` when that record is active. Rule (1), a complex: `irwin_id` stays
    **null** (no single member speaks for the complex), `complex_members` lists every member name verbatim,
    `other_records` holds one entry per member (with its `name`), `gacc` is the members' GACC when they all agree
    (else null), and `active_sources` gains `'wfigs'` when any member is active. The incident record of 14.5 is never
    fetched for a complex row (the endpoint answers `not_covered` with the complex reason of 14.5); each member's
    record is reached from its `other_records` entry (its `url`). No member's name, acres, containment or times ever
    stand in for the complex's own (CAL FIRE's) values.
  - **Id pinning** (below `us-catalog`'s cut line; fallback until it lands: an orphaned bundle stays reachable by
    its old link, and the list shows the CAL FIRE row without it). CAL FIRE often lists a California fire later than
    NIFC, so a bundle may already exist under the fire's WFIGS id when rule (2) first matches it. Then the merged row
    keeps the bundle's WFIGS id as its `id` (CAL FIRE's record and fields otherwise, `record_source: "calfire"`) and
    lists the CAL FIRE id in `aliases`; `resolve_listed` / `get_summary` answer both ids with that row. The build
    gate compares `summary.id`, so the fire is never built a second time under the CAL FIRE id: a build request by
    an alias answers HTTP 409 "'{alias}' is listed as '{id}'." (`api/app.py`). Without such a bundle the CAL FIRE id
    is used, as today. Test: a recorded before/after pair (WFIGS-only, then listed by CAL FIRE) with a manifest under
    the WFIGS id.
  - Regression cases (B §5): Orleans/Butler/Big Cliff, TCU/2-2 ×2/2-7/2-8/6-2/6-5, Swift/Peak, Log (-6 d), Gianelli,
    Bradford Branch/Dale, McCovey vs Marshall (separate), Alpaugh (added), Timber (one row, active by NIFC).
- **Outside California**: complex members are listed on their own with `complex_name`; CX parents are never listed.
  WFIGS duplicates (same name tokens and state, size within 1 %, <= 10 km, discovery <= 30 days apart): keep the most
  recently modified, log the dropped id.
- **`POOState` decides listing**; the state polygons only fill a missing `POOState` (nearest state within 5 km);
  mismatches over 5 km are logged, never dropped (Paradise OR, Zamora Bend TX, Sharpe CO stay listed).
- **Switches** (one constant each, in `catalog.py`):
  - `CA_ACTIVE_RULE = "either"`: a California fire is active when CAL FIRE's or NIFC's record says so (round 3 item 2).
    Alternatives `"calfire"`, `"wfigs"`.
  - `CA_COMPLEX_ROWS = "calfire"`: CAL FIRE's one complex row in California (round 3 item 3). Alternative `"members"`.
- **Build gate** (`us-pipeline`, `pipeline.py`; HTTP text in `api/app.py` by `us-catalog`): an id is buildable only
  when `catalog.resolve_listed` resolves it (a CAL FIRE or WFIGS record, never a manifest alone) and
  `is_supported(summary)`. `pipeline.is_catalog_incident(incident_id, summary)` keeps its signature (`app.py:184`
  imports it) and becomes `summary is not None and summary.id == incident_id and catalog.resolve_listed(incident_id)
  is not None`. Answers: unknown id → HTTP 404 "unknown incident"; Alaska, Hawaii or a territory → HTTP 422 "Fire-3d
  does not support Alaska, Hawaii or US territories yet."; a bundle-only id (`fixture-demo`, `fixture-east`, any local
  or synthetic bundle) → HTTP 409 "'{id}' is a local or synthetic bundle; it cannot be rebuilt." (no "CAL FIRE
  catalog" wording; a non-forced build of a ready bundle-only id still returns it untouched, as `test_api.py` expects
  today). The CLI resolves the same way. Until `us-pipeline` lands the new `is_catalog_incident`, WFIGS ids are not
  buildable (nobody builds in wave 1 except `us-pipeline`).

#### 14.2 as built

From `us-catalog.md` (M3, cut-line f, review round 1) and `us-pipeline.md` (§14.2).
- `catalog.py`: switches `CA_ACTIVE_RULE = "either"`, `CA_COMPLEX_ROWS = "calfire"`; `resolve_listed` searches the live
  list, the id's year list, CAL FIRE's year list (any size), then one cached `IrwinID LIKE '{ABCDEF%'` query (never a
  manifest). Alaska, Hawaii and territory ids **resolve** with their own state and zone although never listed, so the
  build gate answers 422 rather than 404. A California WFIGS record folded into a CAL FIRE fire is not resolvable under
  its WFIGS id unless a bundle pins it.
- Rules decided while building: name tokens drop "fire", "the", "incident", "wildfire"; duplicates need both sizes
  reported and over 1 ac and are removed before the California merge; WFIGS year lists are never fetched below 100 ac
  (`WFIGS_YEAR_FLOOR_ACRES`); a CAL FIRE fire matched by two WFIGS records keeps both in `other_records` and takes the
  `irwin_id` of the one with its name (null when there is no single one); `display_name` keeps a short run after an
  apostrophe lower case ("Devil's Canyon", "O'Neil").
- Id pinning (`catalog.pinned_id`, `wfigs_id`; tested on a synthetic before/after pair): the live loop's summary sync
  copies `RECORD_IDENTITY_FIELDS` when the listed row is another record than the bundle's (`live.record_identity`), so
  a pinned bundle never shows CAL FIRE's numbers under a NIFC WFIGS issuer.
- Build gate (`pipeline.is_catalog_incident`, `pipeline.BuildRefused`, `gate_refusal`; `api/app.py` the same texts):
  404 "unknown incident '<id>'"; 422 "Fire-3d does not support Alaska, Hawaii or US territories yet."; 409 "'<id>' is
  a local or synthetic bundle; it cannot be rebuilt."; 409 "'<alias>' is listed as '<id>'."; plus `landfire_gate`
  (14.12.3). The `test_api.py` hand-off was done by the integration: the API tests assert these texts.
- **Source lists unreachable** (integration part 2; us-pipeline review R8): `resolve_listed` raises
  `catalog.ListsUnavailable` (a `LookupError`) when no list that answered knows the id and at least one lookup failed
  (CAL FIRE's live or year list, the WFIGS lists or the IRWIN prefix query); bundle-only ids never ask the lists and
  stay None. `get_summary` still answers from a bundle on disk; without one it raises. Every API path answers **HTTP
  503 "The fire lists could not be reached right now; try again later."** (`catalog.LISTS_UNAVAILABLE_TEXT`): the build
  gate (`pipeline.gate_refusal`, `build_incident` as `BuildRefused(503, …)`, `api/app.py` `_not_buildable`), a 503
  handler for `ListsUnavailable` in `api/app.py` (`GET /api/incidents/{id}` of an unbuilt listed fire), the incident
  record (14.5) and `/api/extras/*` by incident. Never "a local or synthetic bundle" and never 404 for an outage. The
  web's `describeError` reads a 503 as "Unavailable right now: <the server's sentence> (HTTP 503)".
- **Same-name records** (integration part 2; us-catalog review N2): several WFIGS records matched to one CAL FIRE fire
  that all carry its name (the Lucas Fire, 2026: LUCAS from CAL FIRE MEU, 1,099 ac, and from CAL FIRE LNU, 4,128 ac)
  are one fire's records: `catalog.same_name_primary` picks the largest reported size, then the most recently
  modified, as the row's `irwin_id` / `unique_fire_id`; every record stays in `other_records` with its own issuer,
  numbers, status and time. Records with other names keep the Dale rule; none with the fire's name: `irwin_id` null.

### 14.3 Regions: state, county, time zone and coverage (`us-catalog`)

`backend/fire3d/regions.py` (offline, shapely STRtree, lazy-loaded, no network):

```python
L48: tuple[str, ...]                     # the 48 states + "DC" (USPS)
STATE_NAMES: dict[str, str]              # "OR" -> "Oregon"
@dataclass(frozen=True)
class County: fips: str; name: str; state: str          # "41029", "Jackson County", "OR"
def state_at(lon: float, lat: float, *, max_km: float = 5.0) -> str | None
def states_in_bbox(bbox: tuple[float, float, float, float], margin_km: float = 0.0) -> list[str]
def county_at(lon: float, lat: float) -> County | None
def counties_in_bbox(bbox, margin_km: float = 0.0) -> list[County]
def same_codes(counties: list[County]) -> list[str]     # IPAWS SAME: "0" + 5-digit FIPS
def time_zone_at(lon: float, lat: float) -> str | None  # IANA; nearest zone <= 5 km, else the state's main zone; None off L48
def main_zone(state: str) -> str
def zone_name(tz: str) -> str                            # "Pacific Time", "Mountain Time", "Central Time", "Eastern Time"
def coverage_at(lon: float, lat: float) -> Literal["lower48", "alaska", "hawaii", "territory", "outside_us"]
def lookup(lon: float, lat: float) -> dict               # the /api/geo/lookup body
```

- Data (public domain, built by `backend/scripts/build_us_regions.py`, sources and dates in a `meta` property):
  `backend/fire3d/data/us_states.geojson` (Census TIGERweb `State_County/MapServer/0`, 0.005°),
  `us_timezones.geojson` (USDOT BTS NTAD Time Zones + Census TIGERweb AIANNH Navajo Nation and Hopi Reservation),
  `us_counties.geojson` (TIGERweb counties, lower 48 + DC, simplified). IANA mapping: Pacific → America/Los_Angeles,
  Mountain → America/Denver, Central → America/Chicago, Eastern → America/New_York; Arizona → America/Phoenix
  except the Navajo Nation (America/Denver) and the Hopi Reservation inside it (America/Phoenix).
- `coverage_at`: lower 48 + DC by the polygons (5 km tolerance); Alaska, Hawaii and the territories by documented
  coarse boxes; anything else `outside_us`.
- Required test points: El Paso TX → America/Denver; Pensacola FL → America/Chicago; Ontario OR (Malheur) →
  America/Denver; Island Creek ID (46.036, -115.438) → America/Los_Angeles; Phoenix → America/Phoenix; Window Rock AZ
  → America/Denver; Kykotsmovi AZ (Hopi) → America/Phoenix; Greer AZ → America/Phoenix; Bozeman MT → America/Denver;
  Black Cove NC (35.286, -82.298) → America/New_York; Paradise OR (20 m outside its polygon) → OR; Anchorage →
  `alaska`; Honolulu → `hawaii`; San Juan → `territory`; Tijuana → `outside_us`.

**`GET /api/geo/lookup?lon=&lat=`** (400 on bad numbers; `Cache-Control: public, max-age=86400`):

```ts
export type Coverage = 'lower48' | 'alaska' | 'hawaii' | 'territory' | 'outside_us'
export interface GeoLookup {
  lon: number; lat: number
  coverage: Coverage
  supported: boolean                    // coverage === 'lower48'
  state: string | null                  // USPS (lower 48 + DC only)
  state_name: string | null
  county: { fips: string; name: string } | null
  time_zone: string | null              // IANA; null when not supported
  time_zone_name: string | null         // "Mountain Time"
  note: string | null                   // the 14.14 coverage sentence when not supported, else null
}
// web/src/api/client.ts
export function getGeoLookup(lon: number, lat: number, opts?: FetchOptions): Promise<GeoLookup>
```

#### 14.3 as built

From `us-catalog.md` (M2).
- `fire3d/regions.py` has exactly the listed API plus `is_supported_state`, `sources_meta`, `in_lower48`. Data built
  by `backend/scripts/build_us_regions.py` (about 12 GETs, each file with a `meta` block): `us_states.geojson` (TIGERweb
  `State_County/MapServer/0`, 0.005°), `us_counties.geojson` (3,109 counties), `us_timezones.geojson` (NTAD Time Zones
  plus the Navajo Nation and Hopi Reservation from TIGERweb AIANNH; Hopi > Navajo > NTAD; an NTAD Mountain point in
  Arizona outside the Navajo Nation is America/Phoenix). Terms checked 2026-10-23.
- **Deviation:** `coverage_at` uses a 1 km tolerance, not 5 km (TIGERweb state polygons already include near-shore
  water; 5 km would put central Tijuana and Windsor, ON in the US). `state_at` keeps 5 km, `time_zone_at` the 5 km
  nearest-zone rule.
- `GET /api/geo/lookup` (in `api/app.py`): 400 for a bad value, `Cache-Control: public, max-age=86400`; not supported →
  `state`, `county`, `time_zone` null and `note` the 14.14 sentence.

### 14.4 Accuracy regions (`us-catalog` serves and seeds; `validation` writes; `us-web` shows)

- **Regions** (V §5): the WFIGS GACC of the fire's record; the Southern Area is split by state: `SACC-SP` = SACC in
  TX or OK, `SACC-SE` = the rest of SACC. Names: NWCC "Northwest", NRCC "Northern Rockies", GBCC "Great Basin", SWCC
  "Southwest", SACC-SP "Southern Plains", SACC-SE "Southeast", RMCC "Rocky Mountain", EACC "Eastern", ONCC "Northern
  California", OSCC "Southern California".
- **`accuracy_region` assignment** (`us-catalog`): WFIGS rows → their GACC (split as above); California rows → the
  matched WFIGS record's GACC, else `backend/fire3d/data/ca_county_gacc.json` (counties whose WFIGS fires are >= 80 %
  one GACC, built by `backend/scripts/build_ca_county_gacc.py`; Stanislaus, San Joaquin, Alpine, Imperial, Mono and
  Sierra are ambiguous → null); otherwise null. No GACC polygons (their terms are unverified) and no borrowing from a
  neighbour. A searched place with no modeled fire gets no label.
- **Data file** `backend/fire3d/data/regional_accuracy.json`, schema version 1 (V §5), written only by the validation
  tooling in wave 2. `us-catalog` commits a **seed**: OSCC `tested`, `in_sample: true`, 3 fires (Eaton 0.438, Madre
  0.395, Palisades 0.467), `growth_sorensen` 0.43 (mean of fire means), `range` [0.395, 0.467], `pooled_leads` 0.438,
  `n_leads` 32, `growth_ratio_median` 1.85, `lfm_method` "ca_month_table_drought", `seed: true`; every other region
  `untested`, `n_fires` 0.

```ts
export type AccuracyStatus = 'tested' | 'limited' | 'untested'
export interface AccuracyFire { id: string; name: string; state: string; n_leads: number; growth_sorensen: number; fuels_edition: string; lfm_method: string; era5_hours: number; gfs_fill_hours?: number; weather_source?: string; replaced?: string | null; growth_ratio_median?: number | null }
// gfs_fill_hours: hours of the model window where HRRR was missing and GFS filled it (0 for pure HRRR);
// weather_source: the bundle's verbatim source ("open-meteo:historical-forecast:gfs_hrrr");
// replaced: the V §3 fire this one replaced and the failed check, else null (validation step 3);
// growth_ratio_median: this fire's own median forecast / observed growth ratio (integration part 2)
export interface AccuracyRegion {
  id: AccuracyRegionId; name: string; status: AccuracyStatus; in_sample?: boolean; seed?: boolean
  n_fires: number; n_leads?: number
  growth_sorensen?: number | null       // mean over fires of each fire's mean growth Sørensen (31-member p50)
  range?: [number, number] | null       // min-max of the per-fire values
  pooled_leads?: number | null; ignition_relative?: number | null
  by_lead?: Record<string, number>      // keys "12", "24", "48", "72" (lead hours as strings)
  growth_ratio_median?: number | null
  years?: number[]; lfm_method?: string; fuels_editions?: string[]; fuel_groups_tested?: string[]
  caveats?: string[]; fires?: AccuracyFire[]
}
export interface AccuracyRegionsResponse {
  schema_version: 1; generated_ms: number; served_ms: number
  model: { engine: string; settings: string }
  method: { metric: 'growth_sorensen'; forecast: string; leads_h: number[]; aggregate: 'mean_of_fire_means'; min_fires: number; min_leads: number; weather: string; starts: string; secondary: string }
  assignment: { by: string; split: Record<string, string[]>; fallback: string }
  regions: AccuracyRegion[]             // all ten ids, always
}
// web/src/api/client.ts
export const getAccuracyRegions: (opts?: FetchOptions) => Promise<AccuracyRegionsResponse>
```

- **`GET /api/accuracy-regions`** returns the file plus `served_ms` (`Cache-Control: no-cache`). A region missing from
  the file is served as `untested`. Status rule: `tested` needs >= 2 fires and >= 16 scored leads; otherwise
  `limited` when it has at least 1 fire; 0 fires `untested`. (So 2 fires with 12 leads are `limited`.)
- **Wording** (`us-web`, templates in `web/src/lib/plainLanguage.ts`; V §5 verbatim, placeholders in braces):
  - Public line (tested): "Tested on {2} past fires in this region ({2024-2025}; {grass} fires)." The score is one tap
    away ("How was it tested?"): "When re-run on these fires, the predicted new spread matched the real new spread with
    a score of about {0.4} out of 1 (1 = perfect, 0 = none; the fires ranged {0.3-0.5}). It usually predicted about
    {2}× too much growth" (ratio below 1: "about {half} of the real growth"). "These re-runs started during the fires'
    main growth and used archived weather, so live forecasts usually do worse. Experimental: follow local officials."
    Public rounds to one decimal and always shows the range.
  - Command line (tested): "Hindcast growth score {0.41} (fires {0.33-0.48}; {2} fires, {24} leads, +12-72 h; growth
    ×{2.1}; starts during main growth; live fuel moisture {GSI}; fuels {LF2023, LF2024})." Two decimals.
  - Fuel caveat (whenever `fuel_groups_tested` is non-empty; no field lists a region's fuel groups): "Tested on
    {timber and grass} fires only; other fuels here are untested."
  - Limited: "Tested on only 1 past fire in this region: too few for a score." Command adds "[that fire {0.38}, {12}
    leads; not a regional score]".
  - Untested or null region: "Accuracy not yet tested here." Command adds "No past fires in the {region name} region
    have been re-run."
  - In-sample (any region with `in_sample: true`: OSCC today, and any region whose fires informed an adopted change,
    validation step 4): the same templates with every number filled from the file (no number is written into a
    template, OSCC included), plus a fixed sentence. Public adds "The model's settings were tuned on these same fires,
    so this is a best case."; Command adds "; in-sample: settings fitted on these fires" inside the parentheses. With
    the seed file, OSCC reads "Tested on 3 past fires in this region (2025; chaparral and grass fires). The model's
    settings were tuned on these same fires, so this is a best case." and "Hindcast growth score 0.43 (fires
    0.40-0.47; 3 fires, 32 leads, +12-72 h; growth ×1.85; live fuel moisture California seasonal values,
    drought-adjusted; in-sample: settings fitted on these fires)." A clause whose value the file lacks (the seed has
    no `fuels_editions`) is left out, never filled with a guess. A `us-web` test changes the OSCC numbers in a fixture
    file and checks that both lines change.
  - `lfm_method` in words: `gsi_nfdrs2016` "GSI"; `ca_month_table_drought` "California seasonal values,
    drought-adjusted"; `ca_month_table` "California seasonal values". The Command line describes the hindcasts, not
    the open fire's own run (that run's method is in its forecast notes, 14.12.10).
  - Always under the label: "Outside the modeled area is unknown, not low."
  - Never "accurate", "reliable", "safe" or "low risk".
- **Where it shows** (`us-web`): the fire card (Public: the line + "How was it tested?" disclosure; Command: the score
  line), the location card's model block inside a fire (one line; below `us-web`'s cut line), the Analysis drawer and
  the Forensic Analysis tab (the Command line; below the cut line). Only for a fire, never for a searched place without
  one. On the fire card the label is model information: it sits **outside** the official record section
  (`.fc-official`, the agency's record) next to the experimental-model note (`.fc-note`), never inside it; a DOM test
  asserts that no accuracy text is a descendant of `.fc-official`.
- **Per-run skill table** (V-R13, `us-web`): show `growth_sorensen` first when present, label the total "total-area
  overlap (includes the area already burned at the start)", and drop the green/amber/red tone. Python
  `SkillEntry` gains `growth_sorensen: float | None = Optional_()`; in TS the `ForecastManifest.skill[]` items (an
  inline type in `web/src/api/types.ts`) gain `growth_sorensen?: number | null` (written by `us-pipeline`, 14.12.7).

#### 14.4 as built

From `us-catalog.md` (M4), `us-web.md` (M4, cut line a/f) and `validation.md` (folded in integration part 2, below).
- Seed `backend/fire3d/data/regional_accuracy.json` (schema 1): OSCC `tested`, `in_sample`, `seed`, 3 fires, 32 leads,
  `growth_sorensen` 0.433 (renders 0.43), `range` [0.395, 0.467]; no `fires` or `fuels_editions` (per-fire
  `era5_hours` unknown, never guessed); the other nine `untested`. Validation replaces the file.
- `/api/accuracy-regions` serves every region in the fixed order, recomputes each `status` from its counts and adds a
  missing region as untested; `Cache-Control: no-cache`; 503 when the file is unreadable.
- Web: `state/accuracy.ts` (`useAccuracyRegions`, `useOpenFireAccuracy`), templates `accuracyLabel(region, method)` in
  `lib/plainLanguage.ts`; the label sits after `.fc-official` on the fire card (`AccuracyNote`), in the Analysis drawer
  and the Forensic Analysis tab (`ui/RegionAccuracy.tsx`) and in the location card's model block. The "main growth"
  clause is shown only when `method.starts` says so (the seed line has none). A load failure says "The accuracy of the
  model in this region could not be loaded right now." (never "untested").
- Per-run skill table (`ui/AnalysisTab.tsx`): "Growth" first when `growth_sorensen` is present, neutral bars, the total
  column "Total-area overlap" with the note "Growth scores only the new spread after the start. Total-area overlap
  includes the area already burned at the start." (review R3); without growth values the full header and "The growth
  score (new spread only) is not stored for this run." `SkillEntry.growth_sorensen` stays optional (forecast manifests
  built before brief 3 lack it).
- **Validation's file** (folded from `contract3/validation.md`, integration part 2): `regional_accuracy.json` is written
  by `python -m fire3d.spread.validate regional <fires.json> --out …` (`fires.json` from `backend/scripts/
  validate_us_fires.py collect`); it never writes `seed`. All six test regions are `tested` (2 fires each, 24-32
  leads); RMCC, EACC and ONCC `untested`; OSCC re-measured after GSI with the same values, `in_sample: true`, the others
  `false`. Results (31-member p50 growth Sørensen, mean of the fire means): NWCC 0.255, NRCC 0.341, GBCC 0.247, SWCC
  0.351, SACC-SP 0.394, SACC-SE 0.193, OSCC 0.433. `growth_ratio_median` is the median of the per-lead forecast /
  observed growth ratios, **null** when the fires err in opposite directions (one ≤ 0.95 and one ≥ 1.05 by their own
  median) and no majority errs the pooled way (`validate.growth_split`, which adds the caveat "The fires erred in
  opposite directions: …"): NRCC is null; OSCC keeps 1.85 with that caveat (Palisades ×0.57). Each fire carries its own
  `growth_ratio_median` (added in part 2; the file was regenerated from validation's `fires_review_fixes.json` with
  only these 15 values added). `fuel_groups_tested`: the fires' fuel words (grass / shrub / timber whose LANDFIRE FBFM40
  family shares reach 25 % of the fire's burnable burned area). `caveats`: "Two fires only: a rough value (the two
  fires scored A and B)." per region, plus named problems (Windy Deuce's timing, Rush, Lower Sugarloaf); they are served
  but not shown in the app.
- **Wording, amended by the integration (part 2; validation review W-M2, W-m1..m4, W-m7, m5).** Round 2 decision 7
  is kept: Public shows words with the score one tap away; Command shows the score. Templates (`accuracyLabel`):
  - Public line (tested): "Tested on {2} past fires in the {Northwest} region ({2025})." then one outcome sentence in
    words, no number, from each fire's own `growth_ratio_median` (else the region's): "In those tests the forecast
    showed {less | much less | more | much more | about as much} new spread than really happened." ("much" when the
    region ratio is ≤ 0.5 or ≥ 2), or, when the fires erred both ways, "… showed too much new spread on one fire and too
    little on the other." / "… on 2 of the 3 fires and too little on the other."; no ratio at all: no sentence. The
    fuels are named once: in the caveat ("Tested on timber fires only; other fuels here are untested."), or, when the
    fires span grass, shrub and timber, in the line ("(2025; grass, shrub and timber fires)") with the caveat "Only 2
    fires were tested here: most fuel and weather conditions in this region are untested." In-sample adds the fixed
    sentence as before.
  - Public "How was it tested?": "When re-run on these fires, the predicted new spread matched the real new spread
    with a score of about {0.26} out of 1 (1 = perfect, 0 = none). The test fires scored {Emigrant, OR 0.28 and Lower
    Sugarloaf, WA 0.23}." (two decimals, as Command; without per-fire values "the fires ranged {lo-hi}", "both fires
    {x}" when the ends are equal: never "0.2-0.2"), then the growth: "It usually predicted about {26%} of the real
    growth ({Emigrant: about 20%; Lower Sugarloaf: about 40%})." ("Overall it predicted …" when a fire was about
    right; "It predicted too much growth on {Horse Gulch (about 1.8 times the real growth)} and too little on {Island
    Creek (about 63% of the real growth)}." when the region has no ratio; "Overall it predicted about 1.9 times as much
    growth as really happened, but not on every fire: …" when the majority kept it), then "These re-runs started during
    the fires' main growth and used the weather that really happened; live forecasts must use predicted weather and
    usually do worse. Experimental: follow local officials."
  - Command (tested): "Hindcast growth score {0.26} of 1 in the {Northwest} region (fires {0.23-0.28} | both fires
    {0.35}; {2} fires, {24} leads, +12-72 h; forecast/real growth ×{0.26} [(×{0.57-2.2} by fire) when the fires split] |
    forecast/real growth ×{0.63-1.78} by fire [no region ratio]; starts during main growth; live fuel moisture GSI
    (NFDRS growing-season index); fuels {LF2024}[; in-sample: settings fitted on these fires])."
  - Limited, untested, the always line and the banned words: unchanged.
  - Fire card (W-m8): "Analysis ready: spread reconstruction and the experimental model" only when the open bundle
    holds a model run; "Analysis ready: spread reconstruction (no model run yet)" without one (the 12 test fires,
    Eaton); "Analysis ready: spread reconstruction" for a prepared fire that is not open (`state/overview.ts`
    `analysisReadyText`).

### 14.5 Official fire records (`us-catalog` new endpoint; `us-pipeline` CAL FIRE endpoint; `us-official` web; `us-web` fire card)

**`GET /api/official/incident-record?incident=<id>`** (new router `backend/fire3d/api/records.py`, included by
`api/app.py`; Python model `IncidentRecordResponse` in `contracts.py`; TS in `web/src/official/types.ts`). The I7
envelope (CONTRACT §13 official-backend) with `kind` extended:

```ts
type OfficialKind = 'calfire' | 'fire_weather' | 'incident_record' | 'local_alerts'
type OfficialReasonCode = 'past_date' | 'upstream_error' | 'not_covered' | 'state_not_available' | null
interface IncidentRecordResponse extends OfficialEnvelope {           // kind 'incident_record'
  record_source: 'wfigs'
  irwin_id: string | null; unique_fire_id: string | null
  publisher: 'NIFC WFIGS (IRWIN)'
  agency_code: string | null              // protecting-agency code, verbatim
  agency: string | null                   // its plain name from nwcg_agency_codes.json; null when the code is unknown
  protecting_unit: string | null; state: string | null; county: string | null; time_zone: string
  incident_url: string | null             // the all-years layer's f=html query by IrwinID (https)
  dataset_url: string                     // the NIFC Open Data item page ("about this source")
  current: {
    name: string                          // verbatim
    acres: number | null; percent_contained: number | null; is_active: boolean
    discovered_ms: number | null; contained_ms: number | null; controlled_ms: number | null; out_ms: number | null
    updated_ms: number | null             // ModifiedOnDateTime_dt: the record's own update time
    ics209_report_ms: number | null
  } | null
  complex: { name: string; id: string | null } | null
  changes: []                             // history outside California is deferred (PLAN-3); always [] in brief 3
  recording_since_ms: null
}
```

- Works for any listed id with an IRWIN id: WFIGS rows and California rows matched to one WFIGS record. A California
  row without one: `unavailable` + `not_covered`, reason "NIFC WFIGS has no record matched to this fire." A California
  row matched to two or more WFIGS records none of which has its name (`irwin_id` null, `other_records` non-empty;
  added by the integration): `unavailable` + `not_covered`, reason "NIFC WFIGS lists this fire under several records
  ({names}), so no single record is shown here." (the records' names verbatim, joined by ", "). Several records that
  all carry the fire's name are one record (14.2 as built, "Same-name records"): the Lucas Fire shows its LUCAS
  record, never "several records (LUCAS, LUCAS)". The source lists unreachable: HTTP 503 (14.2 as built). A CAL FIRE
  complex row (14.2, `complex_members` non-empty): `unavailable` + `not_covered`, reason "This is a CAL FIRE complex;
  NIFC WFIGS lists its member fires separately." (never one member's record). A bundle-only or synthetic id
  (`fixture-demo`, `fixture-east`, any id that `get_summary` answers only from a manifest): `unavailable` +
  `not_covered`, reason "This is synthetic or local data; it has no agency record." An id nobody knows: HTTP 404.
- `source_updated_ms` = `current.updated_ms`; `retrieved_ms` = Fire-3d's fetch; WFIGS down: `unavailable` +
  `upstream_error`, `current: null`. Caveats always include: "These are the protecting agency's numbers as published
  by NIFC WFIGS (IRWIN), with the record's own update time. Fire-3d does not record changes to this record yet." and
  "No record or no change is not an all-clear: follow local officials."
- Agency names: `backend/fire3d/data/nwcg_agency_codes.json` `{ "meta": {source, checked}, "codes": {"USFS": "USDA
  Forest Service", ...} }` for the codes in use (B 2.1); an unknown code is shown verbatim. `us-catalog` checks the
  wording and the terms against NWCG's official Unit Identifier page and records the result in `meta`. The file is
  below `us-catalog`'s cut line: until it lands, `agency` is null for WFIGS rows and every label shows the code
  verbatim ("USFS via NIFC WFIGS"), which is already the 14.2 issuer text.
- **`GET /api/official/calfire`** (`us-pipeline`, `api/official.py`): for a fire whose `record_source` is `wfigs`:
  `unavailable` + `not_covered`, reason "CAL FIRE does not list this fire; its official record is published by NIFC
  WFIGS." California answers are unchanged. `incident_ref` / `find_record` / `fill_from_calfire` become
  `fill_from_catalog`, which resolves any listed id through `catalog.get_summary` (no 404 for a listed fire without a
  bundle).
- **Shared web helpers** (`us-catalog` M1, `web/src/api/records.ts`, with tests; both web roles import them, so the
  issuer label and the disagreement rule are written once):
  - `recordIssuerLabel(summary: IncidentSummary): string`: `record_issuer`, with the plain agency name added when
    known ("USFS (USDA Forest Service) via NIFC WFIGS"; "CAL FIRE"; "NIFC WFIGS (IRWIN)"); `record_issuer` absent →
    "CAL FIRE" only when `calfire_uid` is non-empty, else "Agency record".
  - `recordBlocks(summary: IncidentSummary): RecordBlock[]` with `RecordBlock { source: RecordSource; issuer: string;
    name: string | null; is_active: boolean; updated_ms: number | null; url: string | null }`: the row's own record
    first (its own status is `active_sources.includes(record_source)`), then every `other_records` entry whose
    `is_active` differs from it (a complex member keeps its `name`). One block when the agencies agree.
- **Web (`us-official`)**: `official/client.ts` `recordUrl(summary)` → `/api/official/calfire` for `record_source
  'calfire'`, `/api/official/incident-record` for `'wfigs'`; for a California fire with `irwin_id` and
  `active_sources.length === 1`, both are fetched (round 3 item 2). A complex row (`irwin_id` null) fetches only CAL
  FIRE's record and shows its members from `other_records`. `useRecord()` replaces `useCalfire()` (keep the
  old export as a deprecated alias). `calfireStatus` takes the summary fallback only when `record_source ===
  'calfire'` (fixes the `calfire.ts:89` mislabel). Feed kind `'calfire'` becomes `'record'`, labelled from the issuer.
- **Fire card (`us-web`, `ui/shell/FireCard.tsx`)**, from the summary only (no official fetch), through
  `recordIssuerLabel` and `recordBlocks`:
  - heading `"<recordIssuerLabel> incident record"` ("CAL FIRE incident record", "USFS (USDA Forest Service) via NIFC WFIGS
    incident record"), acres and containment verbatim, "Updated by <issuer> <time in the fire's zone>", the record link;
  - California fires with `other_records` whose `is_active` differs from the CAL FIRE record: each record as its own
    block with its own issuer, status and time (Timber: "Active (NIFC WFIGS, updated …)" and "Not listed as active
    (CAL FIRE, updated …)");
  - `complex_name` → "Part of the {X} Complex"; `complex_members` → "Includes (NIFC WFIGS names): {names}", verbatim,
    each name linked to its `other_records` entry's `url`; the heading, acres, containment and update time stay CAL
    FIRE's (a test: a complex row whose members carry other acres never shows a member's numbers as the complex's);
  - the id line "Incident ID (CAL FIRE)" or "Incident ID (NIFC WFIGS)" (also `MapHeader.tsx`, `IncidentOverview.tsx`).

#### 14.5 as built

From `us-catalog.md` (M4), `us-pipeline.md` (§14.5), `us-official.md` (M4) and `us-web.md` (M4, review round 1).
- `/api/official/incident-record` (`api/records.py`): the record from `wfigs.record_by_irwin` (all-years layer, exact
  IrwinID, cached 10 min); `dataset_url` the NIFC Open Data item page; WFIGS down → `upstream_error` "NIFC WFIGS could
  not be reached; the agency record is not shown."; `Cache-Control: no-store`; the several-records reason above (review
  R3, `records.several_reason`).
- `/api/official/calfire` for a `wfigs` record answers `not_covered` with no CAL FIRE request; `fill_from_catalog`
  replaced `fill_from_calfire` (the alias was removed by the integration).
- Web (`official/record.ts`, new): `RecordStatus` (a superset of `CalFireStatus`; `OfficialInfo.calfire` keeps its
  field name and holds it), `recordStatus`, `recordBlockText`, `partOfComplex` (never "Complex Complex"),
  `wfigsRecordFeedItems` (topic `'record'`), synthetic and not-checked reasons; `useRecord()` replaced `useCalfire()`
  (the alias and the feed topic `'calfire'` were removed by the integration). A WFIGS fire never asks
  `/api/official/calfire`.
- Fire card (review round 1, R1, round 3 item 2): `.fc-official` takes its status from the record's own agency
  (`lib/recordText.ts` `recordStatus`, built on `ownRecordActive`): "Not listed as active" / "Contained" when the
  record itself is not active, with "<issuer> record last edited …" instead of "Updated by …"; the ACTIVE title chip
  (Fire-3d's listing, either agency) stays outside `.fc-official`. Map hovers (`map/hoverText.ts`) follow the same rule
  and list each disagreeing record with its own issuer and time.
- Credits (review R5 of us-web, and the integration): "Agency names: NWCG unit identifiers" under the fire card's
  record when a plain agency name is shown (`agencyNameShown`), and in an open fire's "Data sources" note
  (`bundleCredits(..., { place: { agencyNames } })`, linked to NWCG PMS 931).

### 14.6 NWS fire weather nationally (`us-pipeline` backend; `us-official` web)

- `sources/nws.py`: one cached request per cycle (2 min) to `/alerts/active` with `area=` the 48 states + DC, and the
  events RFW, FWW plus the local-officials' events of 14.7 in the same call, split in code. `NWS_LIMITER` stays 30/min.
- **Per fire**: before any zone outline is loaded, keep only alerts with a UGC whose two-letter state prefix is in
  `regions.states_in_bbox(area_bbox)`; then the area test as today. A Montana alert never reaches a Florida fire, and
  no zone is loaded for it.
- **Without `incident`** (overview): every current lower-48 alert; zones load within the 30/min budget; alerts whose
  outlines could not load keep today's verbatim caveat ("{n} fire weather alert(s) could not be placed on the map…").
  The bundled fire-zone file (B-R18) is deferred.
- **Response additions** (Python `FireWeatherResponse` in `contracts.py`, TS `official/types.ts`; all (R), defaulted
  in wave 1 per 14.0):
  - `states_checked: string[]`: the states the answer actually covers. Overview: every state the shared request
    asked for (all 48 + DC = 49 codes once the national request lands; `["CA"]` from today's backend). Per fire: the
    fire's `states_in_bbox(area_bbox)` that are also in the shared request. Python `list[str] | None = Optional_()`.
  - `alert_states: string[]`: the states with at least one alert in this answer. Python `list[str] | None =
    Optional_()`.
  - each alert `time_zone: string | null` (from its first zone's outline centroid, else the state's main zone).
    Python `str | None = Optional_()`.
  - The endpoint keeps no `bbox` parameter: the location card at a point uses the overview answer.
- **"Checked" is decided from `states_checked` only** (web, `us-official`): a point or fire is "checked" when its
  state is in `states_checked`; otherwise the line says "not checked". A missing `states_checked` (today's backend,
  which asks `area=CA` only) is read as `["CA"]`. The lower-48 quiet line is shown only when `states_checked` holds
  all 49 codes. A unit test against a CA-only answer (`states_checked: ["CA"]`) shows
  Reno as "not checked" and never claims "lower 48 states".
- Wording: "in California" becomes "in the lower 48 states" in the backend caveats; the per-fire caveat keeps
  `STANDING_NWS`. The IEM archive is unchanged (point based, national).
- **Web** (W 3.4, `us-official`): header "Official now · lower 48 states"; quiet line "No Red Flag Warning or Fire
  Weather Watch in effect in the lower 48 states. Not an all-clear."; "{N} alerts in effect in {M} states; the 3 most
  recent:"; each alert keeps its office, its own times in its own zone, its headline verbatim and a link; footer
  "Official evacuation information and each fire's agency record are shown for a fire: zoom in on a fire or pick one,
  or check an address." The location card always states the NWS status at a point in the lower 48: "Fire weather
  alerts (NWS): checked, none in effect here · Not an all-clear", the alert line, or "Fire weather alerts (NWS): not
  checked here". With today's California-only backend the header stays "Official now · California" and the quiet
  line names California (the text follows `states_checked`, never a hard-coded scope). The code
  identifier `statewide` may stay (renaming it is deferred); its user-visible text changes.

#### 14.6 as built

From `us-pipeline.md` (§14.6) and `us-official.md` (M5).
- `nws.national_active()` → `NationalAnswer(fire, local, fetched_ms, updated_ms, states, dropped_no_link)`: one cached
  request with the 49 codes and the RFW/FWW plus local-officials' events; `in_states` (UGC prefix) is applied before
  any zone outline loads; every placed alert gets `time_zone` (its first zone's outline, else its state's main zone).
- Overview `states_checked` = the request's 49 codes; per fire = `states_in_area(area)` ∩ the request's states (IEM
  archive answers: `states_in_area`); both `[]` when NWS could not be reached. **Integration:** `states_checked`,
  `alert_states` and `FireWeatherAlert.time_zone` are required in Python and TS (the web still reads a cached answer
  without `states_checked` as ["CA"]).
- Web: "checked" is decided from `states_checked` and the point's state only (`statesChecked`, `coversLower48`,
  `checkedScope`, `officialNowScope`); while the point's state is being looked up the line says "Checking NWS fire
  weather alerts…" (review R2). Alert times are in each alert's own zone (`alertTimeFmt`) with the preset's clock;
  the overview's block is headed "Official now · lower 48 states".
- **Deviation (dev preset, §14.8.7):** the only recorded national answer has Mountain-time alerts only, so the preset
  shows a second zone through local alerts (Pacific and Mountain) instead of merging another day's alert.

### 14.7 Local officials' messages relayed by NWS, and the FEMA archive (`us-pipeline` backend; `us-official` web)

Round 2 item 5: no IPAWS registration. Live: the NWS-relayed messages. Past days: OpenFEMA, labelled archived.

**`GET /api/official/local-alerts?incident=<id>&at_ms=&margin_km=15`** or **`?bbox=w,s,e,n`** (in `api/official.py`;
Python `LocalAlertsResponse` in `contracts.py`; TS in `web/src/official/types.ts`). `incident` and `bbox` are mutually
exclusive: both, or neither, → HTTP 400. An unknown incident → 404.

```ts
type LocalChannel = 'nws_api' | 'openfema_archive'
interface LocalAlert {
  id: string                            // the CAP identifier, verbatim (the same message has the same id in both channels)
  channel: LocalChannel; archived: boolean
  event: string                         // verbatim ("Fire Warning", "Evacuation Immediate")
  event_code: string                    // FRW | EVI | SPW | CDW | CEM | LAE
  message_type: 'Alert' | 'Update' | 'Cancel' | null; references: string[]
  sender_name: string | null            // verbatim; never the operator's `sender` address
  sender_is_platform: boolean           // e.g. "Public Alert System": then the card says "issuer not named"
  sent_ms: number | null; effective_ms: number | null; onset_ms: number | null; expires_ms: number | null
  headline: string | null; description: string | null; instruction: string | null
  wea_text: string | null; wea_long_text: string | null       // all verbatim
  web: string | null                    // https only; the issuer's own link, present on only about 6 % of messages
  source_url: string                    // always set, https: where this copy of the message can be read (below)
  area_desc: string | null; same_codes: string[]; ugcs: string[]
  polygon: GeoJsonPolygon | GeoJsonMultiPolygon | null   // MultiPolygon when an archived message had several areas
  match: 'polygon' | 'county'           // how it was tied to this area
  covers_reported_location: boolean | null; nearest_km: number | null   // null for a county match (says nothing of the point)
  time_zone: string | null              // IANA of its area (regions)
  phase: 'upcoming' | 'in_effect' | 'ended'   // relative to `at_ms` when given, else to now
}
interface LocalAlertsResponse extends OfficialEnvelope {          // kind 'local_alerts'
  alerts: LocalAlert[]
  channels: { id: LocalChannel; status: 'available' | 'unavailable' | 'pending' | 'not_checked'; retrieved_ms: number | null; source_updated_ms: number | null; reason: string | null }[]
  area_bbox: [number, number, number, number] | null; reported_location: [number, number] | null
  counties: { fips: string; name: string; state: string }[]   // the counties searched (SAME matching)
}
```

- **Channels and time windows** (`at_ms` absent = now):
  - `nws_api`, live (`at_ms` within the last 2 h or absent): the shared national `/alerts/active` request of 14.6
    (one cached request per cycle; filtered by state, then by area).
  - `nws_api`, past up to 7 days (`at_ms` older than 2 h and newer than 7 days): one cached request per incident to
    `/alerts?start=<at_ms − 24 h>&end=<at_ms + 1 h>&event=<the 14.7 events>&area=<states_in_bbox>` (TTL 10 min,
    `NWS_LIMITER`). Older than 7 days: this channel is `not_checked` with the reason "NWS keeps about 7 days of
    alerts."
  - `openfema_archive` (`sources/openfema.py`, `https://www.fema.gov/api/open/v1/IpawsArchivedAlerts`, `status eq
    'Actual'`): for `at_ms` older than 24 h. It is never fetched on the request path for longer than 5 s: a cache miss
    starts one background fetch per incident (deduplicated, cached on disk under `DATA_DIR/official/openfema/`) and
    answers that channel `pending`; a successful build also starts it. If the background fetch is not built (below
    `us-pipeline`'s cut line), the channel answers `not_checked` with the reason "The FEMA archive is not checked in
    this version." The `?bbox=` form is live only (`not_checked` for the archive).
  - Overlap (24 h to 7 days back, both channels): one alert per `id`; the `nws_api` copy wins and the archived copy
    is dropped.
- **A link on every message** (round 2 item 5; the brief's official-information rule): `source_url` is always set.
  `nws_api`: the alert's own API URL, `properties['@id']` (`https://api.weather.gov/alerts/urn:oid:…`, the same link
  brief 2's `FireWeatherAlert.url` uses). `openfema_archive`: the OpenFEMA query for that record,
  `https://www.fema.gov/api/open/v1/IpawsArchivedAlerts?$filter=identifier%20eq%20'<identifier>'` (URL-encoded).
  An alert without an https `source_url` is dropped and counted in a caveat ("{n} alert(s) without a source link were
  not shown"), never shown without a link.
- **Scope**: FRW, EVI, SPW and CDW always; CEM and LAE only when their text mentions fire, smoke or evacuation. Text is
  verbatim and never classified ("TEST" texts and burn bans sent as FRW are shown as sent).
- **Matching**: by polygon when present; else by SAME county codes against `regions.counties_in_bbox(area_bbox)`.
- **Times**: an instant is converted, never shown with the raw offset; the web shows them in the fire's zone.
- **Credits**: live "National Weather Service (relayed local officials' messages)"; archive "FEMA IPAWS archive via
  OpenFEMA" plus the required notice "This product uses the Federal Emergency Management Agency's OpenFEMA API, but is
  not endorsed by FEMA" (terms: https://www.fema.gov/about/openfema/terms-conditions; no FEMA or DHS logos).
- **Caveats** (always): "Fire-3d lists only the local alerts the National Weather Service relays; most are not relayed
  (about 1 in 20 fire and evacuation alerts in 2024-26). No alert here is not an all-clear: follow local officials."
  Archive: "Archived copy from FEMA (OpenFEMA, published about a day later); FEMA does not validate message content.
  Replays can list more than was visible live."
- **Web card line** (`us-official`): "Alert from <issuer>: "<verbatim text>" · sent <time in the fire's zone> · relayed
  by the National Weather Service · <link>"; archived: "Archived alert from <issuer> … (FEMA archive)". The link is
  `web` ("issuer's link") when present, else `source_url` ("source record (NWS)" / "source record (FEMA archive)"), so
  every line has one; a `location/official.test.ts` case asserts a link on every local-alert line. Shown in Official
  now, the feed (kind `'local-alert'`), the location card's official block (live, at the point via `?bbox=`), and for
  every state, including Washington and Florida. With no alert, the card has one status line "Local officials' alerts
  relayed by NWS: none here · not an all-clear" (its sub-line carries the standing caveat); when the endpoint is
  missing (HTTP 404, as for the whole of `us-official`'s run before `us-pipeline` lands it) or fails, the line reads
  "Local officials' alerts: not checked" and never "none".
- **Where the card lines go** (no renderer change in wave 1): `us-official` puts the NWS status line (14.6) and the
  local-alert lines into the existing `OfficialBlock.fireWeather` array of `location/official.ts`, in that order, each
  with its caveat in `sub` / `subCompact`; `us-web`'s `OfficialSection` (`location/CardParts.tsx`) already renders that
  array and only updates its doc comment. Renaming the field (for example to `lines`) is left to the integration.

#### 14.7 as built

From `us-pipeline.md` (§14.7, review round 1) and `us-official.md` (M5, review rounds 1 and 2).
- Channels as specified, plus: the archive channel waits at most `openfema.REQUEST_WAIT_S` = 3 s before `pending`;
  archive windows are one per incident (`[day(start − 1 d), day(end + 1 d)]`, at most 22 days, stored parsed under
  `DATA_DIR/official/openfema/`); the server-side OpenFEMA filter is by date window and status only (event codes and
  SAME counties are matched locally: nested `any()` filters failed or timed out); `references` come from a second
  query for non-Alert messages.
- After a successful build `pipeline.archive_prefetch` warms the fire's window: an API build job only starts the
  deduplicated background fetch (`openfema.start`; `JobManager.drain` waits for it), a CLI build fetches synchronously,
  each request capped at 15 s with no retry (review R2; a deviation from "a successful build also starts it").
- County matches have `covers_reported_location` and `nearest_km` null; `polygon` may be a MultiPolygon (now in the
  type above); `sender_name` is verbatim and can carry the sender's COG number ("200277,LA City Public Alerts,City of
  Los Angeles"), shown as sent.
- **Integration:** an area that touches no lower-48 state answers `unavailable` + `state_not_available`, both
  channels `not_checked` with "Fire-3d checks local officials' alerts in the lower 48 states only." and the reason
  that sentence plus the 14.14 coverage sentence, with no NWS request (before, a box at Tijuana or Anchorage answered
  `available` with no alerts; review round 2, N2). The web reads it as "not checked", never "none" or an outage.
- Web (`official/localAlerts.ts`, new): `localAlertsState` ("none" only when a channel answered; HTTP 404 → not
  checked), quoted text = WEA text, else headline, else description, cut at 220 characters (a deviation from
  "headline first"); every line has a link (`localAlertLink`: `web`, else `source_url`) named by
  `OfficialLine.urlLabel` ("issuer's link", "source record (NWS)", "source record (FEMA archive)"), rendered by the
  location card's `OfficialSection` (capitalised), else "Read it".
- Relevance and place (review round 1, R1, deviation 9 of us-official): `localAlertOrder` (in effect, upcoming, ended;
  within a phase the area covering the location, then the nearest, then the newest); every line, feed row and card
  line says where its area lies (`localAlertPlace`: "area covers the fire's reported location" / "area 1.7 mi from the
  fire's reported location · may be about another fire" / "matched by county, not by an exact area · may be about
  another fire"). The feed shows it on its own unclamped line (`FeedItem.place`, round 2 N1).
- At a point (location card): `localAlertsAtPoint` keeps the messages whose area reaches the point (covering it or
  within 1 km; a county match in the point's county) and counts the rest: the fire's own answer (a past time inside
  its area) in `elsewhere` ("N of the fire's local alerts are for other places in its area (see Updates).") and the
  live `?bbox=` answer in `nearby` ("N nearby local alert(s) … neighbouring county / an area that does not reach this
  point."; round 2 N3). **Integration:** the point's own box answer lists every message that reaches the point (they
  are not in Updates), so the card never says "+N more (see Updates)" for it (`pointSource: 'box'`). Local alerts at a
  point wait for the point's state like NWS fire weather (round 2 N2).
- Credits (review R4): `localAlertCredits` in the map attribution: "Local officials' alerts: National Weather Service
  (relayed local officials' messages)" and, when the archive answered, "Local officials' alerts: FEMA IPAWS archive
  via OpenFEMA. This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by
  FEMA." (no logo).
- `OfficialBlock.fireWeather` keeps its name (it carries the NWS status line and the local alert lines); renaming it
  to `lines` is left for a later brief.
- **Integration, review round 3 (N4): a message is never in effect before its own sent time.** An issuer can give an
  onset or effective time earlier than the sent time (Horse Gulch, MT: MTHelenaPoliceDepartment's "Urgent! Evacuation
  for Horse Gulch Fire …" sent 5:45 PM MDT, effective and onset 5:00 PM). `nws.local_phase` starts a message at
  max(sent, onset else effective), so at 5:00 PM it is `upcoming`, from 5:45 PM `in_effect`; `onset_ms` /
  `effective_ms` stay as the issuer gave them. The web says "sent 45 min after this time" whenever `sent_ms` is later
  than the panel's time, whatever the phase (`localPhaseText`), reads an `in_effect` message sent after the answer's
  `requested_at_ms` as not yet in effect (`toLocalAlertItem`, for an older backend), and the phone badge counts only
  messages sent by the answer's time (`LocalAlertsOfficial.refMs`, `officialBadge`): at 5:00 PM Public's short line
  quotes the 3:53 PM Cave Gulch message, the badge says 2, and the 5:45 PM message is listed last in Details with
  "sent 45 min after this time".
- **Integration, review round 4: the web decides at the panel's own time, from each message's own times.** Round 3
  judged "in effect" at the answer's `requested_at_ms`, which is the start of the hour (the query's `at_ms` is
  hour-quantised, `fireWeatherAtMs`), so at 5:50 PM MDT the 5:45 PM evacuation read "not yet in effect", Public's
  short line quoted the 3:53 PM message and the badge said 2 (at 2:50 PM the 2:45 PM Fire Warning read "not yet in
  effect" and there was no badge). The rule now (`localPhaseAt`): at the panel's time `refMs` (the replay minute on
  screen, or now for a live fire) a message is **in effect** when `sent_ms <= refMs`, max(sent, onset else effective)
  `<= refMs` and `expires_ms` is null or later than `refMs`; it is **"sent N min after this time"** when `sent_ms >
  refMs` (never quoted as current, never counted); it is "not yet in effect" only when it was sent and its own onset
  (else effective) time is still ahead; it has **ended** from its expiry, or when it is a Cancel. Every panel decides
  at its own time: `localAlertsState(q, { refMs })` (the hooks: `useOfficialNow` at `useOfficialPanelTime()`,
  `useOfficialAtPoint` and the feed at the official context's `refMs`) and `localAlertsAt(l, refMs)` (re-decides the
  phases and the order at another time; used by Official now's `LocalAlertsRow`, Public's `localAlertsLine`, the
  location card's `localAlertLines` and `officialBadge(evac, fw, local, refMs)`). `useOfficialBadge` passes
  `useOfficialPanelTime()`: now for a live fire (or no fire), else the replay minute, the rule of Official now, the
  short summary and the location card, so the badge counts what the panel it opens lists. `LocalAlertItem` carries
  `onsetMs` (onset, else effective) and `cancelled`; `LocalAlertsOfficial.refMs` is the time the phases were decided at
  (the panel's, else `requested_at_ms`, else `now_ms`). The backend's hour-level `phase` stays as a hint (used only for
  an answer without any time); `nws.local_phase` is unchanged. **Why the query stays hour-quantised:** the answer at an
  hour lists every message sent in [hour − 24 h, hour + 1 h], so it already holds every message any minute of that
  hour needs; deciding at the minute on the web needs no refetch while the timeline is scrubbed or played, and the
  web's per-URL cache and the backend's archive cache stay keyed by the hour (an exact-time query would be a new
  request every minute of scrubbing). Horse Gulch: 5:50 PM all three in effect, the short line quotes the 5:45 PM
  evacuation, badge 3; 2:50 PM the Fire Warning in effect, badge 1; 5:00 PM and 6:00 PM as in round 3 (badge 2 and
  3); 7:50 PM the 5:45 PM message has ended (its expiry 7:45 PM), badge 2.
- **One time for the feed and the panels** (integration part 2, the orchestrator's carry-over of round 4): the panels
  decide at the replay minute while the feed split its list at the exact timeline time, so for up to 59 s after a
  message's sent second the feed listed it as "Not yet in effect" (Horse Gulch: sent 5:45:12 PM MDT). A replay now
  lists a local message from the minute after it was sent (`localFeedMs(sent_ms)`, its `FeedItem.seekMs`; these rows
  are not seekable, so only the split uses it), exactly when the panels' minute reaches it; until then it sits with
  the later updates as "Sent after this time". `FeedItem.sentAfterRef` keeps that chip where the feed lists
  everything (a live fire seen at a past time). The rest of the feed keeps the exact time. "sent N min after this
  time" counts from both times cut to the minute as they are shown ("sent 2:45 PM" at 2:20 PM: 25 min, before a
  rounded 26) and says "sent less than a minute after this time" in the same minute (`afterSpan(sentMs, refMs)`).
  Tested at 5:45:12 and 5:45:30 PM MDT (later, "Sent after this time", badge 2) and 5:46 PM (listed, in effect).

### 14.8 Evacuations and cameras (`us-official`, both ends)

**14.8.1 State registry** (`backend/fire3d/sources/evacuations.py`, new; `api/extras.py` keeps the route and calls
it). One adapter shape (EV §4) without the Washington fields:

```python
@dataclass(frozen=True)
class EvacAdapter:
    id: str                       # 'caloes_evacuations' | 'or_oem_evacuations'
    home_state: str               # 'CA' | 'OR'
    availability: Literal['available']
    query_url: str
    out_fields: tuple[str, ...]   # explicit whitelist, never '*'
    where: str
    ttl_s: float                  # 120 for both
    limiter: fhttp.RateLimiter    # services.arcgis.com shared by CA and OR
    confirm_drop: bool            # CA only (the 5-minute rebuild)
    source: dict                  # SOURCES entry + 'credit'
    issuing_authority: str        # replaces the literal at extras.py:625-626
    aggregator: str               # 'Cal OES' | 'Oregon OEM'
    standing_caveats: tuple[str, ...]
    normalize: Callable[[dict], dict | None]   # -> EvacZoneProps or None (drop)
    status_key: Callable[[dict], str]
    zone_state: Callable[[dict], str | None]
STATE_AVAILABILITY: dict[str, dict]   # 48 + DC: {state, name, availability: 'available' | 'not_available', adapter_ids, note, audited: '2026-10-22', links}
```

Only CA (Cal OES) and OR (Oregon OEM "Evacuation Areas Public") are `available`. Every other state, **Washington and
Florida included** (round 3 item 1), is `not_available`. Arizona's note: "Arizona's statewide zones are planning zones
whose status was not kept up to date in 2026; not shown."

**14.8.2 Response additions** to `GET /api/extras/evacuations` (all additive; California answers keep today's values):
- `states: { state, name, availability: 'available' | 'not_available', checked: boolean, source_ids: string[], note: string | null, links: {label, url}[] }[]`: every state the bbox touches.
- `sources[]` entries gain `retrieved_ms`, `updated_ms`, `status: 'available' | 'unavailable'`, `reason`,
  `home_state`, `credit`. The envelope `retrieved_ms` / `source_updated_ms` stay when one zone source answered (every
  California answer) and are `null` when several did; the UI then reads `sources[]`.
- `reason_code` gains `'state_not_available'` (also used by cameras, 14.8.6).
- Zone props gain `state`, `source_id`, `status_verbatim: boolean`, `status_raw`, `status_label`,
  `status_label_source`, `incident_name`, `hazard_type`, `listed_ms`, `time_basis: 'issuer' | 'state_layer_added' |
  'state_layer_edit' | 'date_only' | 'none'`.

**14.8.3 Rules**
- A bbox that touches no `available` state: `status: 'unavailable'`, `reason_code: 'state_not_available'`, reason
  "Official evacuation zones are not available in this state ({Montana}). Follow local officials." No upstream request.
  Outside the lower 48: "Fire-3d does not support Alaska, Hawaii or US territories yet." / "Outside the United States:
  Fire-3d has no data here."
- Mixed states (OR/CA, CA/NV, OR/WA): fetch each available adapter the bbox touches; every other state adds the caveat
  "{Nevada}: official evacuation zones are not available in this state". A failed source is `unavailable` in
  `sources[]`, never "none".
- Dedup at borders: a zone takes its state from `zone_state` (Oregon's `County` domain includes "Del Norte", CA); when
  that state's own adapter answered, its copy wins.
- No zones in a checked state: the per-source "not an all-clear" caveat; never the source's own "If there are no
  records in this dataset, there are no evacuations currently in place."
- Hazards: every hazard type is kept; a non-fire hazard shows "Evacuation for: Other, as recorded by Oregon OEM".
- Past dates: unchanged (`not_available_for_past_dates`); Oregon's history layer is not used (round 3 item 4).
- **Status mapping (EV-R6, before any new source)**: negations ("No …", "Not …") never map to order, warning or
  advisory; placeholder rows ("No Evacuation Order", "Not Reporting", null level) are dropped; regression tests for
  "No Evacuation Order", "Not Reporting", "Level 1 - Ready", "Level 2 - Be Set", "Level 3 - Go", "Level 3", "Planning
  Zone", null.
- **Privacy (EV-R4)**: explicit `outFields` per adapter; a test asserts that no response key matches
  `email|phone|user|editor|creator|submit` (Oregon's `Editor_*`, `created_user`, `last_edited_user` are never requested).

**14.8.4 Oregon mapping** (EV §4): `zone_id` ← `GlobalID`; `zone_name` ← `Evac_Area_Name`; `status` ← "Level " +
`Fire_Evacuation_Level`, `status_verbatim: false`, `status_raw` the integer; `status_label` = OEM's definition ("Level
1: BE READY to evacuate", "Level 2: BE SET to evacuate", "Level 3: GO NOW – Leave Immediately!") with
`status_label_source` the OEM press-release URL; levels 1/2/3 → advisory / warning / order; `county` ← `County` +
" County"; `incident_name` ← `Fire_Name` ("as recorded by Oregon OEM; a name match is not proof it is this fire");
`hazard_type` ← `HazardType`; `status_updated_ms` null (OEM gives no issue time); `listed_ms` ← `created_date` ("added
to the Oregon state layer"); `last_edited_date` is "state layer recalculated", never an issue time. Credit: "Oregon
Department of Emergency Management". Fixture: the recorded 2026-08-15 12:00Z history snapshot (EV §6), committed under
`backend/tests/data/evacuations/` with a `PROVENANCE.md`.

**14.8.5 Web** (`official/model.ts`, `location/official.ts`, `extras/*`): `EvacuationOfficial.state` gains
`'not-available'` with `reason` ("Not available in this state (Nevada)") and `links`. The California rectangle
(`insideCalifornia`) leaves every evacuation and NWS path: for a point at the current time the hook always asks the
backend, which answers from the registry without an upstream request. Issuer, aggregator, credit and the
"<aggregator> does not say which fire this is for" text come from `sources[]`; times from the per-source fields, in the
fire's zone (or the point's zone). Card line for a covered state with nothing listed: "No evacuation order or warning
listed here · {Oregon OEM}, checked {time} · not an all-clear".

**14.8.7 Official dev preset** (`us-official`, `web/src/extras/dev/presets.ts`, opened through `web/extras-dev.html`):
one preset `us-official` renders, from `web/src/official/__fixtures__/samples.ts` and the recorded Oregon sample only
(no backend), the Official now panel with a national NWS answer (`states_checked` = 49 codes, alerts in two zones),
a live relayed local alert (NWEM), an archived alert with the FEMA notice, an archive channel in `pending`, and the
location card at a Medford OR point with Oregon zones (levels with OEM's definitions, "added to the Oregon state
layer" in Pacific time). Reviewers screenshot it; live-endpoint views that need `us-pipeline`'s backend move to the
integration checklist.

**14.8.6 Cameras** (B-R16, W12): outside California `/api/extras/cameras` answers `unavailable` +
`state_not_available`, reason "Public cameras: California only (ALERTCalifornia, Caltrans). Not available in this
state." The panel shows that sentence instead of "No public cameras are listed in this area." GOES-East imagery
(B-R15) is deferred; image labels come from each product's `platform` (W13).

#### 14.8 as built

From `us-official.md` (M2, M3, review round 1).
- Registry: `EvacAdapter` as specified plus three derived properties (`upstream_name`, `layer_what`, `none_caveat`,
  and since review R6 `none_caveat_named`); `ADAPTERS` = `caloes_evacuations` and `or_oem_evacuations` only;
  `STATE_AVAILABILITY` derives from `ADAPTERS` (no flag); one ArcGIS limiter (60/min). Washington is not built (round 3).
- Rules in this order: the bbox's states; no available state → `state_not_available`, `sources: []`, no upstream
  request (also for past dates: **deviation**, the state check comes before the past-date check); then past dates;
  then each adapter. Several states without a feed: "Official evacuation zones are not available in these states
  (Nevada, Utah). Follow local officials." (**deviation**: plural form). In an answer covering several states Cal
  OES's "none" names its source ("Cal OES lists no evacuation zone here right now. …"); a California-only answer keeps
  brief 2's sentence, and four California answers equal brief 2's key by key
  (`tests/data/evacuations/caloes_brief2_expected.json`).
- Response: `sources[]` entries also carry `aggregator` ("Cal OES" / "Oregon OEM"; **deviation**, additive).
  **Integration:** the 14.8.2 additions are required in `web/src/extras/types.ts` (`EvacSource extends ExtrasSource`
  with the per-source fields and `aggregator`; `EvacuationsResponse.sources: EvacSource[]`, `states`, the ten zone
  props); the recorded brief-2 web sample carries them as the brief-3 backend adds them.
- Oregon: `normalize_oregon` as specified; standing caveats (no issue time; levels are Fire-3d's rendering with OEM's
  definitions); OEM's "If there are no records … no evacuations" sentence is never repeated. The live Oregon layer is
  empty off-season; zones with content come from the recorded 2026-08-15 history snapshot (tests, dev preset).
- Cameras outside California: `state_not_available` with `sources: []` (review R5) and the 14.14 sentence.
- Web: `official/model.ts` `EvacuationState 'not-available'` ("Not available in this state (Nevada)"), sources per
  answer, `checkedBy`; the zone hover names the state source from `sources[]` (us-web review R2). `insideCalifornia`
  was removed by the integration. **Integration:** at a past time, a point inside the open fire's area in a state
  without a feed reads "Evacuation zones: not available in this state" (the fire's own answer is
  `state_not_available`), as the fire's panel says, instead of "not shown for past dates" (Horse Gulch, MT).

### 14.9 Time zones and the mixed clock (`us-web` owns `lib/time.ts` and `state/timeZone.ts`; backend `timeutil.py` is `us-pipeline`'s)

**14.9.1 Rules** (round 2 item 8; brief rule "never assume Pacific time"):
- Clock: `'12h'` in the map workspace's Public preset ("3:40 PM MDT"); `'24h'` in Command and Forensic ("15:40 MDT").
- Zone: a fire's own times (timeline, feed, charts, cards, its official items, scene labels, notes) use the fire's
  `summary.time_zone`. Overview rows and hovers use each row's `time_zone`. Times about many fires are relative
  ("records updated 5 min ago"). A point without a fire uses `/api/geo/lookup`'s `time_zone`. Fallback: the viewer's
  zone with its abbreviation, labelled; **never** Pacific.
- Panel line: "Times: Mountain Time (MDT), the fire's local time" / "…, local time at this place" / "Times: your
  device's time (CDT)". A source time without a zone is shown as given with "time zone not stated".
- Years and days are computed in the zone (`extras/format.ts:13` and `ui/DataCredits.tsx:35` used UTC).

**14.9.2 `web/src/lib/time.ts` new API** (`us-web` M1; the zone-free helpers keep their names: `MINUTE_MS`, `HOUR_MS`,
`DAY_MS`, `MONTHS`, `WEEKDAYS`, `fmtTPlus`, `fmtDuration`, `fmtRelative`, `tickStepHours`, `floorToHour`,
`hoursSince`, `msFromHours`, `TimeTick`):

```ts
export type Clock = '12h' | '24h'
export interface TimeFmt { readonly tz: string; readonly clock: Clock }   // tz: IANA
export function timeFmt(tz: string | null | undefined, clock: Clock): TimeFmt   // null/invalid tz → viewerZone()
export function viewerZone(): string                                   // Intl resolvedOptions().timeZone, else 'UTC'
export function isValidZone(tz: string): boolean
export function zoneAbbr(ms: number, tz: string): string               // "PDT", "MST" (Intl short, en-US); fallback "UTC−7"
export function zoneName(tz: string, ms?: number): string              // "Mountain Time" (Intl longGeneric)
export function zoneLine(tf: TimeFmt, ms: number, whose: 'fire' | 'place' | 'viewer', alsoMs?: number | null): string   // 14.9.1 panel line (alsoMs: 14.15)
export interface WallParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }
export function wallParts(ms: number, tz: string): WallParts
export function zoneOffsetMinutes(ms: number, tz: string): number
export function startOfLocalDay(ms: number, tz: string): number
export function wallTimeToMs(tz: string, y: number, mo: number, d: number, h?: number, mi?: number): number  // two-pass offset; DST gaps resolve forward
export function localYear(ms: number, tz: string): number
export function localHourTicks(startMs: number, endMs: number, tz: string, stepHours?: number): number[]
export function localDayTicks(startMs: number, endMs: number, tz: string, stepDays?: number): number[]
export function localWallTicks(startMs: number, endMs: number, stepHours: number, tf: TimeFmt): TimeTick[]   // timeLabel "06:00" | "6 AM"
export function fmtClock(ms: number, tf: TimeFmt, o?: { zone?: boolean }): string
export function fmtAt(ms: number, tf: TimeFmt, o?: { year?: 'auto' | 'always' | 'never'; zone?: boolean; weekday?: boolean; refMs?: number }): string
export function fmtDayDate(ms: number, tz: string, o?: { year?: 'auto' | 'always' | 'never'; weekday?: boolean; refMs?: number }): string
export function fmtDayRange(startMs: number, endMs: number, tz: string): string
```

Exact strings (tests in `lib/time.test.ts`, new):

| Call | `'24h'` | `'12h'` |
|---|---|---|
| `fmtClock(ms, tf)` | `15:40` (`07:05`) | `3:40 PM` (`7:05 AM`, `12:05 AM`, `12:00 PM`) |
| `fmtClock(ms, tf, { zone: true })` | `15:40 MDT` | `3:40 PM MDT` |
| `fmtAt(ms, tf)` | `Oct 22, 15:40` | `Oct 22, 3:40 PM` |
| `fmtAt(ms, tf, { zone: true })` | `Oct 22, 15:40 MDT` | `Oct 22, 3:40 PM MDT` |
| `fmtAt(ms, tf, { year: 'always', zone: true })` | `Oct 22, 2026 15:40 MDT` | `Oct 22, 2026 3:40 PM MDT` |
| `fmtAt(ms, tf, { weekday: true })` | `Thu Oct 22, 15:40` | `Thu Oct 22, 3:40 PM` |
| `fmtDayDate(ms, tz)` / `{ year: 'always' }` / `{ weekday: true }` | `Oct 22` / `Oct 22, 2026` / `Thu Oct 22` | same |
| `localWallTicks` labels | `06:00`, day label `Oct 22` | `6 AM`, `Oct 22` |

`year: 'auto'` adds the year when the local year differs from `refMs`'s (default now). California Command and
Forensic strings stay identical to today's; Public strings change by the user's decision ("13:19 PDT" → "1:19 PM
PDT"). Zones checked in Node 22 ICU: PDT/PST, MDT/MST (Boise, Denver), MST all year (Phoenix), CDT/CST (Chicago,
Indiana/Knox, North_Dakota/Center), EDT/EST (Detroit, New_York).

**14.9.3 Deprecated** (kept until the integration deletes them; Pacific-bound): `TZ`, `tzLabel`, `laParts`,
`laOffsetMinutes`, `startOfLaDay`, `laTicks`, `laDayTicks`, `laWallToMs`, `laWallTicks`, `fmtDateTime`, `fmtDate`,
`fmtDateTimeYear`, `fmtTime`, `fmtDay`, `fmtDateRange`, `fmtDateTimeTz`, `fmtDateTimeYearTz`, `fmtWeekdayDay`,
`LaParts`. `web/scripts/check-time-api.mjs` (`us-web` M1) measures the migration:
- Input: `--role <label>` (expands that role's `owns` globs from `docs/redesign/plan3-roles.json`, keeping files under
  `web/`) and/or explicit paths (`node web/scripts/check-time-api.mjs web/src`).
- It skips `web/src/lib/time.ts` itself (where the names are defined) and counts **import-based uses only**: a name
  imported from `lib/time` (directly, renamed, or through a namespace import) and used in the file. Comments and
  strings do not count.
- It also counts `America/Los_Angeles` literals outside comments and test files (a line can opt out with a
  `// tz-ok: <reason>` comment, which the report lists).
- It prints both counts per file and in total, and exits 1 when either total is above 0. Each web role runs it with
  `--role <label>` (acceptance: 0 and 0); the integration runs it on `web/src`.

**14.9.4 `web/src/state/timeZone.ts`** (`us-web` M1):

```ts
export function clockFor(workspace: Workspace, preset: Preset): Clock       // map + public → '12h', else '24h'
export function useClock(): Clock
export function useTimeFormat(): TimeFmt            // the open fire's summary.time_zone (store), else viewerZone()
export function useTimeFormatFor(tz: string | null | undefined): TimeFmt     // same clock, another zone
export function useZoneSource(): 'fire' | 'place' | 'viewer'   // same words as zoneLine's `whose`
export function getTimeFormat(): TimeFmt            // non-hook read for imperative code (map controller)
```

**14.9.5 Who migrates what.** Each role migrates the call sites in the files it owns (W 1.2 table). `us-official`:
`official/**`, `extras/**`, `ui/feed/**`, `ui/shell/{dataStatus,officialSummary,UpdatesPanel,LayersPanel}`,
`location/official.ts`. `us-web`: every other file, including `scene/**`, the dev pages and their tests. Pure model
functions take a `tf: TimeFmt` argument (or a field in their input object); components use the hooks.

**14.9.6 Cross-role shims** (`us-official` M1; optional now, required after the integration): `FeedInput.tf?:
TimeFmt` (`buildFeedItems`, called by `ui/KeyEvents.tsx`, `ui/timeline/CompactTimeline.tsx`, `map/mapController.ts`);
`officialBlock(official, { …, tf?: TimeFmt })` and `officialFireWeatherNote(fw, tf?)` (`location/LocationCard.tsx`,
`location/OverviewCard.tsx`); `zoneDetail(zone, nowMs, tf?)` and `cameraViewText(cam, tf?)` (`map/mapController.ts`).
Without `tf` they use `getTimeFormat()`. `us-web` passes `tf` at those call sites once the shims exist. `FireCard.tsx`
stops importing `fmtStatusTime` (it uses `fmtAt`); `us-official` keeps `fmtStatusTime(ms, nowMs)` and adds
`fmtStatusTimeAt(ms, nowMs, tf)`. The new official lines need no new argument either: `useOfficialAtPoint`
(`official/hooks`, `us-official`) adds the NWS status, the point's state (from `getGeoLookup`) and the local alerts to
`OfficialInfo`, and `officialBlock` turns them into lines of the existing `fireWeather` array (14.7), so
`LocationCard.tsx` and `OverviewCard.tsx` (`us-web`) keep their calls.

**14.9.7 Backend** (`us-pipeline`, `fire3d/timeutil.py`): `fmt_local(ms, tz, *, year=False) -> "Jan 07, 18:18 MST"`
(24-hour with the zone abbreviation; backend text never re-parsed by the web) and `local_month(ms, tz) -> int`.
`BuildContext.time_zone` = `summary.time_zone`. Every `ZoneInfo("America/Los_Angeles")` in `build/`, `spread/` and
`sources/overpass.py` goes; the live fuel moisture month uses the fire's zone.

#### 14.9 as built

From `us-web.md` (M1, M3, late changes), `us-official.md` (M1, M6) and `us-pipeline.md` (§14.9.7).
- `lib/time.ts` exactly as 14.9.2; `timeFmt` returns a frozen shared instance per (zone, clock); `fmtAt` /
  `fmtDayDate` default to `year: 'never'`; `zoneName('America/Phoenix')` is Intl's "Mountain Standard Time".
  `state/timeZone.ts` adds `usePlaceZone` (the overview location card's zone from `/api/geo/lookup`), `getZoneSource`,
  `zoneOf`, `zoneSourceOf`.
- **Integration (14.9.3, 14.9.6):** `node web/scripts/check-time-api.mjs web/src` reported 0 deprecated uses and 0
  `America/Los_Angeles` literals, so the 19 deprecated names were deleted from `lib/time.ts` (their tests became tests
  of the new API in Pacific 24-hour, the brief-2 California strings) and the checker no longer skips `lib/time.test.ts`
  (it keeps the list, so a reintroduced name is counted). The shims' `tf` is required: `FeedInput.tf`,
  `OfficialContext.tf` (`officialBlock`), `officialFireWeatherNote(fw, tf)`, `zoneDetail(zone, nowMs, tf)`,
  `cameraViewText(cam, tf)`; `fmtStatusTime` was deleted (`fmtStatusTimeAt(ms, nowMs, tf)` stays). Other pure helpers
  keep an optional `tf` defaulting to `getTimeFormat()` (the open fire's zone, else the place's, else the viewer's;
  never Pacific). Opt-outs still listed: the dev preset's Oregon point and the recorded zones of
  `official/__fixtures__/localAlerts.ts`.
- Panel zone lines on the data status, the fire's Official now block, the location cards and the timeline tooltips;
  the overview's Official now says "Times: each alert in its own area's local time."
- Backend (`timeutil.py`): `zone`, `local_dt`, `fmt_local`, `fmt_local_short`, `local_month`, `zone_of`; no
  `ZoneInfo("America/Los_Angeles")` in `build/`, `spread/` or `sources/overpass.py` (`overpass.la_time` alias removed
  by the integration).

### 14.10 Search (`us-catalog` backend; `us-web` web)

- **Gazetteer** (B-R12): `backend/fire3d/data/gazetteer_us.json`, built by `backend/scripts/build_gazetteer.py` from
  the 2026 Census Gazetteer Files (places of every LSAD, ZCTAs, counties; public domain), replaces `gazetteer_ca.json`
  (removed by `us-catalog`). Alaska and Hawaii rows are kept and flagged.
- **`GET /api/geocode` additions** (TS in `web/src/location/types.ts`, `us-web`): each local match gains `state`
  (USPS), `state_name`, `county` (name or null), `supported` (false in Alaska, Hawaii, territories); `name` and
  `matched_address` read "<Name>, <ST>" ("Boise, ID", "ZIP 83702, ID"); `place_type` is the Census LSAD in plain
  words (`city | town | village | borough | cdp | county | …`) with `place_type_label`. Parsing: "Springfield, IL",
  "Springfield IL", "83702 ID", "ID 83702"; a bare "Springfield" lists the largest matches across states (state
  shown). Messages: no match → "No US city, town, county or ZIP code matches '<q>'."; an Alaska or Hawaii match keeps
  its row and adds the note "Fire-3d does not support Alaska, Hawaii or US territories yet."; national examples in
  errors ("e.g. 600 E Mariposa St, Altadena; Boise, ID; 83702").
- **Web** (`us-web`): `location/search.ts` state words are the 48 + DC codes and names (`lib/usStates.ts`, new),
  "Town, ST" is parsed, incident search matches the state; wording says "US" (no "California"). Lat/lon order (W8,
  `lib/geodesy.ts`): a bare pair with no letters and both values within ±90 tries both orders and picks the one inside
  the lower-48 box `[-124.85, 24.40, -66.89, 49.38]`; if neither is inside, it reads lat, lon and warns "This point is
  outside the area Fire-3d covers (the lower 48 states)." The box is a parsing heuristic, never a coverage claim
  (coverage comes from `/api/geo/lookup`). Tests: Atlanta "-84.39, 33.75", Miami, Boston, Houston, Los Angeles,
  Seattle.

#### 14.10 as built

From `us-catalog.md` (M5) and `us-web.md` (M5, late changes).
- `gazetteer_us.json` (3.7 MB, 1.1 MB gzipped): 35,585 places and counties and 33,791 ZIP areas, every state, DC and
  Puerto Rico (Alaska, Hawaii and territory rows kept and flagged); `gazetteer_ca.json` removed. Census names are kept:
  "Boise, ID" finds "Boise City, ID" (alias "Boise").
- `/api/geocode` local matches as specified; parsing (`geocode.split_query`) also takes "Springfield, Illinois", "ID
  83702", "Ada County, ID", "Washington, DC"; a state word alone is a name. National examples:
  "e.g. 150 N Capitol Blvd, Boise, ID; Springfield, IL; 83702" (`SEARCH_EXAMPLES`); ZIP matches are titled "ZIP 83702,
  ID"; `noPlaceMessage` uses curly quotes.
- Coverage at a point from `/api/geo/lookup` only (`location/geoLookup.ts`); Alaska, Hawaii and territories replace
  the nearest-fires rows with "Fire-3d lists fires in the lower 48 states only, so fires here are not listed. Follow
  local officials." (new wording); the overview location card credits "Boundaries: U.S. Census Bureau TIGERweb · Time
  zones: USDOT BTS NTAD" when the lookup answered, and (integration) an open fire's "Data sources" note credits both.

### 14.11 Overview map and list (`us-web`; others only read)

- Frame `LOWER48_BOUNDS = [-124.85, 24.40, -66.89, 49.38]`, start [-98.6, 39.8] about z3, header "United States · all
  fires" (tooltip "Lower 48 states; Alaska and Hawaii are not supported yet"), button "All states", phones open on the
  whole lower 48 (round 2 default).
- Three MapLibre sources (W 3.2): `fx-overview-pinned` (never clustered: active fires >= 5,000 ac plus the fire whose
  card is open; selection ring, chip and label layers read it), `fx-overview-active` (`clusterRadius` 28, 44 under 500
  px; `clusterMaxZoom` 6; `clusterMinPoints` 3; `clusterProperties` `max_acres`, `small`), `fx-overview-other` (radius
  40, `clusterMaxZoom` 7). Active and other fires never share a group; active marks draw above. Bubbles sized by
  log(`max_acres`), the count as the label; small active fires (< 10 ac or no size) are 4 px dots. Labels by acres
  with zoom thresholds (W 3.2). A cluster click zooms to min(expansion zoom, 8). Hidden fires are removed from the data,
  keyed on the hidden set, never per frame.
- Legend: "Group of active fires (number = how many)", "Group of other 2026 fires", "Small active fire (under 10 acres
  or size not reported)", "Fires (CAL FIRE in California, NIFC WFIGS elsewhere; official records)", followed by the
  list-absence line of 14.14.
- Panel list: "{312} fires in this view · Show all {1,334}" (round 2 default); rows "Garfield Co., CO"; counts
  memoised; the phone peek "{244} active fires · records updated {5 min} ago". The list's footer carries the 14.14
  list-absence line and the phone peek its short form; a view with no listed fire says "No listed fires in this
  view." followed by the same line (never "no fires"). Windowing the list (W11) is P1 (cut line). The "Include 2025
  fires of 100-300 acres" switch stays in every state.
- Coverage at a point (W9): `/api/geo/lookup` `supported: false` → the 14.14 sentences; no client boxes.

#### 14.11 as built

From `us-web.md` (M2, cut line b/c, review round 1).
- As specified, with these values: `LOWER48_START` [-98.6, 39.8] z3 (`CALIFORNIA_BOUNDS` removed); small active fires
  are 2.5 px dots (**deviation**: the text says 4 px); 21 layers; labels by `labelMinZoom` (pinned 0; active >= 300 ac
  or any >= 20,000 ac from z5; >= 10 ac / >= 1,000 ac from z7; the rest from z9).
- Phone labels (review R7): below z3 on a map narrower than 500 px a western label grows east and an eastern one west
  (`narrowLabelAnchorOffset`); a label that cannot grow inward is left out.
- List windowing above 150 rows (W11, `ui/useListWindow.ts`) with `aria-posinset` / `aria-setsize` and roving focus
  (Home, End, arrows over the whole list); W15 phone fixes (the search message never pushes the map controls; framing
  keeps the last usable padding while the list sheet covers the map).
- The empty view or empty filter carries the list-absence line itself, so the footer is not repeated.
- **Integration:** a flight to an unprepared fire's card carries `MapFlyTo.source: 'fire-card'`, which holds the
  zoom focus like an official flight (`map/focus.ts` `FocusHold`) until the user moves the map: picking Little Giant
  (WA) opened the prepared Lower Sugarloaf Fire, whose analysis area the card's view covered, instead of Little
  Giant's card. A prepared fire is still opened by the zoom.
- **Part 1 review fixes (R1, R3):** every path that shows a fire's card and flies to it goes through one function,
  `state/fireCard.ts` `showFireCard(id, row?)`: the overview list row and the header picker (`ui/shell/fireActions`
  re-exports it), a click on a fire's map marker or label (`mapController.openFireFromOverview`), the search box's
  fire result (`location/SearchBox`, which then closes its popover) and the location card's nearest-fire rows
  (`location/OverviewCard`). When the map is shown and the picked fire has no ready analysis, another fire that is
  open closes first (an ordinary history step: Back returns to it), so the header, the updates and the coordinate
  strip never describe a fire other than the one the map shows with its card; the close comes before the flight,
  because the map releases the hold whenever the open fire changes. Forensic only opens the card.
- **Part 1 review fixes, round 2 (R1, the map marker):** the hold also survives the marker click itself
  (`map/userInput.ts` `MapInput`). The map tells the user's moves from Fire-3d's own by input on the map within 400 ms
  of a move's end; the card's own layout change restarted the flight with the new safe-area padding within that time
  after the click, and that restart's moveend counted as the user's move and ended the hold (the zoom focus then
  opened Lower Sugarloaf at both the national view and regional zoom). Now a click handled as a request (a fire's
  marker or label) is not a camera gesture (`consumeClick`), and a move that one of our own camera commands ends (the
  padding restart, an explicit flight, an instant flight with reduced motion) is ours (`ours`). The user's next drag,
  wheel zoom or zoom button still ends the hold.
- **Part 1 review fixes, round 3 (the wheel):** one wheel notch did not end the hold. MapLibre 5.24 starts and ends a
  lone notch's zoom without an originalEvent and ends it 400-450 ms after the wheel (2.6 s with swiftshader), at or
  past `USER_INPUT_MS`. Now `MapInput` also judges a move by its start: the controller reports every movestart
  (`moveStart(gesture)`) and moveend (`moveEnd(gesture)`); a move that starts outside our own commands while the
  pointer is down, within `USER_INPUT_MS` of an input, or as the first move after a wheel or key input
  (`INPUT_MOVE_START_MS` = 3 s, for slow renderers) is the user's at its moveend, however late that comes. Every camera
  command of the controller runs in `ours` (fits, explicit flights, padding eases, the 2D/3D pitch, the compass,
  tilt and zoom buttons, a group's zoom), so the app's own flight after a marker click still keeps the hold; the zoom
  buttons end it themselves. Little Giant's card, then Lower Sugarloaf at the centre at zoom 8.42 and one real notch:
  Lower Sugarloaf opens (before: the card stayed).

### 14.12 Pipeline interfaces (`us-pipeline` unless noted)

1. **FIRMS feed** (`us-catalog`, `sources/firms.py`): `load_live_us(days: int = 7) -> pd.DataFrame` and
   `load_year_us(year: int, bbox: tuple | None = None) -> pd.DataFrame` keep a lower-48 box with a 0.5° margin
   (`L48_FIRMS_BOX = (-125.4, 23.9, -66.4, 49.9)`), read the yearly parquet `firms_us_{year}.parquet` with pyarrow
   `filters=`; same columns as today. `load_live_ca` / `load_year_ca` stay as deprecated wrappers. `us-catalog` also
   switches every caller in its own files: the keyless path `firms._keyless` (`firms.py:736`, `:744`, used by
   `detections_for`), `catalog.py:252` and `:416`, `api/live.py:138` and `:163` (test: a keyless historical bbox in
   Montana returns rows from `firms_us_{year}`). `catalog.assign_detections` uses a scipy KD-tree (below `us-catalog`'s
   cut line: today's matching stays if it runs on the national feed in under 2 s). `us-pipeline` switches only
   `refresh_live` (`pipeline.py:655`). `LiveStatus.detections_24h` is counted from `load_live_us(days=1)` inside the
   lower-48 state polygons (`api/live.py:138`), and the live cycle's feed is `load_live_us(days=7)` (`:163`,
   `fetch_cycle_data`). The checks that prove the national feed are in both roles' acceptance lists
   (`plan3-roles.json`): box, yearly file, candidates, status, `refresh_live`, and a smoke build with detections.
2. **Weather quota** (V-R7, B-R13; `sources/weather.py`, `http.py`, `cli.py`):
   - `class WeatherQuotaExceeded(WeatherError)` (`weather.py:85`'s base class): raised on Open-Meteo's daily-limit answer (HTTP 429 with "Daily API
     request limit exceeded", or the minute/hour variants), with **no retries**; `fire3d.http` never caches a non-2xx
     body or an unparsable / error JSON body (`{"error": true}`, "Unexpected error while streaming data") and evicts
     such entries.
   - The limit is per host (on 2026-10-22 only historical-forecast and archive were refused). After a daily-limit
     answer, `sources/weather.py` marks that host blocked until 00:00 UTC (an hourly or minutely limit: until the next
     hour or minute; in memory, per process); a request to a blocked host raises `WeatherQuotaExceeded` at once,
     without a network call. **Integration decision (2026-10-23):** a *daily* block is re-checked with one tiny
     uncached probe request at most once an hour and lifted when the host answers (us-pipeline review round 1, R3:
     on a shared IP the daily refusal was transient, and one such answer would otherwise stop every build and live
     refresh of a long-running API for up to 24 h; cost at most 24 tiny requests a day per blocked host). Hourly and
     per-minute blocks are never re-checked.
   - `probe_open_meteo() -> dict` = `{"overall": status, "live": status, "hosts": {"forecast": status,
     "historical-forecast": status, "archive": status, "ensemble": status}}` with `status ∈ {'ok', 'daily_limit',
     'unreachable'}`: one uncached tiny request to each host. `overall` (what historical and validation builds need)
     is `ok` only when forecast, historical-forecast and archive are; `live` (what live builds need) only when forecast
     and ensemble are. CLI `uv run python -m fire3d.cli weather-probe` prints one line per host plus the `overall` and
     `live` lines and exits 0 only when `overall` is `ok`.
   - A historical build whose HRRR request is refused **fails** ("Open-Meteo daily request limit reached; retry after
     the reset (00:00 UTC)") instead of filling with ERA5. `build --require-hrrr` (CLI) / `require_hrrr=True` (API of
     `build_incident`) also fails on any ERA5-filled hour and, for a California fire (`summary.state == "CA"`), on a
     refused water-year precipitation request (the California drought adjustment, so Madre's rebuild can never lose it
     silently; validation extends the same flag to the GSI series of fires outside California, 14.12.10). Without the flag, the water-year request failing is a bundle warning, never silent.
   - **Live builds** (Prepare analysis, the CLI, the live loop's auto-builds) follow the same rule: a build whose
     deterministic weather is refused fails its job with the message above and is never marked ready with partial
     weather. The live loop's auto-build runs once per loop start (`STATE.auto_build_done`), so nothing retries each
     cycle, and its remaining candidates fail at once without network use because the host is blocked. A refused
     ensemble request keeps today's fallback to perturbed members, its warning naming the daily limit. A refused live
     refresh keeps the bundle's last weather with the warning "Weather not refreshed: Open-Meteo daily request limit
     reached." This bullet is above `us-pipeline`'s cut line; the weighted counter and soft cap of the next bullet are
     below it.
   - Below `us-pipeline`'s cut line (the integration finishes it otherwise). Weighted counter: `open_meteo_usage() -> {"date": "YYYY-MM-DD", "weighted_calls": float}` with cost ≈ locations ×
     max(1, series / 10) × max(1, days / 14), persisted in `DATA_DIR/cache/open_meteo_usage.json`. Live deterministic
     weather refetch at most hourly per bundle; above `OPEN_METEO_DAILY_SOFT_CAP = 6000` the live refresh keeps the last
     weather with the warning "Weather not refreshed: daily request budget reached."
3. **LANDFIRE** (V-R4, B-R8; `sources/landfire.py`, `build/aoi.py`): `EDITIONS` adds LF2023; `edition_for(mode,
   started_ms)` = historical LF{federal FY of ignition − 1} (FY2024 → LF2023, FY2025 → LF2024, FY2026 → LF2025), live
   LF2025. Never fall forward for a historical fire: on failure or NoData use the next older edition with a warning; a
   fire before Oct 2023 is refused unless forced. "Land" = cells inside the state polygons with valid DEM; more than 2 %
   NoData land cells in LF2025 → LF2024 for the whole bundle with the warning "LANDFIRE 2025 is not released here yet;
   LANDFIRE 2024 used". Cells outside the US keep 99 but are counted and labelled "outside fuel data coverage: not
   modeled (unknown, not low)". Eaton, Palisades and Madre stay on LF2024; Palisades-like coasts and the San Diego
   border stay LF2025 for live builds.
4. **UTM** (`us-catalog`, `grid.py`, `scripts/check_bundle.py`, SPEC §4.1): `utm_epsg_for(lon) = 32600 +
   floor((lon + 180) / 6) + 1`; California unchanged (10 below −120°, else 11). Tests for zones 10-19 (B and W 3.8).
5. **Issuer text in bundles** (B-R22): every "CAL FIRE" in observed, ignition, forecast and veto text comes from
   `summary.record_issuer`: "Reported by {record_issuer} {fmt_local(t, tz)}", "{record_issuer} start", "{record_issuer}
   incident point", "{record_issuer} reports {N}% containment", "{record_issuer} reported {N} ac". California strings
   are unchanged. A test asserts a WFIGS summary yields no "CAL FIRE" anywhere in a built bundle's text.
6. **`data_sources` names** (read by `web/src/lib/dataCredits.ts`, `us-web`): CAL FIRE fires keep "CAL FIRE incident
   record"; WFIGS fires use "NIFC WFIGS incident record (IRWIN)"; perimeters keep "NIFC WFIGS perimeters"; LANDFIRE
   detail names the edition. `dataCredits.ts` credits "NIFC WFIGS (IRWIN)" for the new name.
7. **Skill** (V-R13, P1): `SkillEntry.growth_sorensen: float | None = Optional_()` (contract by `us-catalog` M1)
   written by `spread/ensemble.py` for historical runs (`spread/validate.py` already computes growth Sørensen). The
   writer is below `us-pipeline`'s cut line; until it lands the web's per-run table shows the relabelled total only
   (14.4), and the regional scores do not depend on it.
8. **Perimeters** (B-R6, V-R2):
   - `record_source == 'wfigs'`: by `attr_IrwinID` / `poly_IRWINID` when `summary.irwin_id` is set; else name + state
     from `summary.state`; no `_calfire_hint`; the size check stays.
   - `record_source == 'calfire'` (every California row, complexes included): today's path exactly (`STATE` "US-CA",
     name tokens, the `attr_CpxName` complex path of `identity_filter`, `_calfire_hint`, the spatial checks). A matched
     `irwin_id` may only break a tie between candidate groups; it never narrows or replaces the name query (a complex
     row has no `irwin_id`, 14.2).
   - Regression test: the recorded Eaton, Palisades and Madre samples and a California complex sample (TCU) give the
     same perimeter `OBJECTID` sets before and after the change.
9. **Fixtures** (`us-catalog`, `scripts/make_fixture.py`): `--only east` writes `fixture-east`, a synthetic historical
   fire near Black Cove, NC (35.29, −82.30; UTM 17; America/New_York; `state` "NC", `record_source` "wfigs",
   `record_issuer` "NIFC WFIGS (IRWIN)", `irwin_id` null, `calfire_uid` "", name "Fixture East (synthetic)"). It is
   bundle-only: never buildable (409, 14.2), and the incident record answers `unavailable` + `not_covered` "This is
   synthetic or local data; it has no agency record." (14.5). The default run (demo + live) is unchanged.
10. **Live fuel moisture outside California**:
    - **Which fires.** The switch is `summary.state`: `"CA"` keeps today's method exactly (the month table with the
      water-year drought adjustment, `ca_month_table_drought`; `ca_month_table` when the bundle has no water-year
      total); any other state uses the regional method once it lands. Old bundles get `state` from the 14.1
      before-validator (their location), never from a box.
    - **Until GSI lands** (wave 1, and any bundle built before validation's GSI commit): a non-California bundle
      carries, from `build/weather_bundle.py` (where `live_fuel_moisture` is called, `:356`), the warning "Live fuel
      moisture outside California uses California's seasonal values until a regional method is tested;
      experimental." Every forecast already appends its moisture note to its warnings (`member_weathers`), which the
      web shows under "Model settings and notes"; that note names the method used.
    - **GSI** (validation, wave 2; V-R5): the NFDRS 2016 Growing Season Index, pre-registered (method, parameters,
      inputs, herb/woody mapping) in `docs/validation.md` before any non-California hindcast. Inputs, start − 28 d to
      start: historical builds take daily ERA5 from the archive host; live builds take the same daily variables from
      the forecast host with `past_days=28` (ERA5 lags about 6 days, `ERA5_DELAY_DAYS`). Both inputs are named in the
      pre-registration. The series is stored as the backend-only `sim/lfm_gsi.json` (`method: "gsi_nfdrs2016"`,
      `source`, days; no SPEC contract change); hindcasts never fetch. Where GSI applies, the interim warning goes.
    - **Never silent.** A non-California bundle without `sim/lfm_gsi.json` (request refused or failed) uses
      California's values with the interim warning and the moisture note "Live fuel moisture: California's seasonal
      values (GSI series unavailable); experimental." (`lfm_method` `ca_month_table` or `ca_month_table_drought`,
      as the California rule would give); `spread/ensemble.py` and
      `spread/behavior.py` never fall back without that note. With `require_hrrr=True` (every validation build) a
      refused GSI series (non-California) or water-year total (California, 14.12.2) **fails** the build.
    - **California unchanged.** A unit test asserts that the (herb, woody) values and the moisture note for Eaton,
      Palisades, Madre (bundles when present, skipped otherwise, as `test_official_real_bundles.py` does) and
      `fixture-demo` are identical before and after the GSI code; validation re-runs the California hindcasts after
      GSI lands (its step 2).
    - The validation role records the method as `lfm_method` per fire and per region in `regional_accuracy.json`, and
      writes its SPEC §8.4 GSI paragraph in `notes_for_integrator` (SPEC is not its file).
11. **Smoke builds** (`us-pipeline`, at most 3, each after `weather-probe` says ok): `2024-horse-gulch-889237` (MT,
    UTM 12, LF2023, MDT), `2025-black-cove-95c3c8` (NC, UTM 17, LF2024, EDT) and, below the cut line, one currently
    active non-California wildfire of 1,000 ac or more in the Southern or Eastern area (live path, LF2025 NoData →
    LF2024 switch, Central or Eastern time; needs `live: ok` too). Fallback for the third: any active non-California
    fire of 1,000 ac or more where LF2025 is NoData; if none exists that day, a unit test of the switch on a recorded
    LF2025 NoData LANDFIRE window (a small window near Black Cove, NC, under `backend/tests/data/pipeline_us/`); the
    report says which was used. The observed-area ratio (final observed acres / WFIGS `IncidentSize`) is a reported
    value, with an explanation when it falls outside 0.8-1.25, never a pass/fail check; so are the GFS fill hours
    (hours with `hrrr` false). Validation rebuilds Horse Gulch and Black Cove with `--force` after wave 1.
    **Stop rule**: if `weather-probe` is refused when the smoke builds are due, `us-pipeline` waits only when the reset
    (00:00 UTC) is less than 1 h away; otherwise it reports both builds as "pending (quota)" and finishes. The
    `us-pipeline` fixer (who acts as `us-pipeline`, after its review) runs them once the probe is ok, if that comes
    before validation starts; otherwise validation builds them first (it rebuilds both anyway) and takes over their
    checks and screenshots. No slot is held waiting for a reset, and reviewers never build.
12. **Live loop** (`us-catalog`, `api/live.py`; round 2 item 4): `AUTO_BUILD_MAX = 4`, 100 ac and 48 h detections
    unchanged, candidates from the whole lower-48 live list with today's scoring and the national feed.

#### 14.12 as built

From `us-pipeline.md` and `us-catalog.md` (FIRMS, UTM, fixture-east, live loop).
- 14.12.1 FIRMS: `load_live_us`, `load_year_us` as specified; the deprecated `load_live_ca` / `load_year_ca` were
  removed in integration part 2 (their tests moved to the national loaders), with `catalog.HISTORICAL_YEAR` and
  `pipeline.spec_incident_id`; `observed.la_time` is now `fire_local_time` (it always took the fire's zone). The KD-tree was not
  done: the dense matching, first cut to the fires' box, takes about 0.5 s on the national feed.
- 14.12.2 Weather quota: as specified, plus the decision recorded in item 2 above (hourly re-check of a daily block,
  `weather.recheck_daily_block`, `DAILY_RECHECK_S = 3600`) and two **deviations**: `probe_open_meteo()` returns an extra
  `detail` key and reports every request-limit period as `daily_limit`; a per-minute refusal is waited out once (at
  most 65 s; other tenants of the shared IP pushed the archive host over its per-minute limit). Cut-line (b): the
  weighted counter `open_meteo_usage()` (`data/cache/open_meteo_usage.json`), `OPEN_METEO_DAILY_SOFT_CAP = 6000`,
  hourly live weather refetch (`LIVE_WEATHER_REFETCH_S = 3600`).
- 14.12.3 LANDFIRE: `EDITIONS` LF2023-LF2025, `edition_for`, `landfire_gate` (a fire before October 2023 needs force),
  the 2 % NoData land switch to the next older edition only, "outside fuel data coverage: not modeled (unknown, not
  low)"; LF2025 has no data at Black Cove, NC (checked 2026-10-23).
- 14.12.4 UTM: `grid.utm_epsg_for(lon)` / `utm_zone_for`; California zones unchanged; `check_bundle.py` checks
  `utm_zone` against `crs`. Bundles on disk: Horse Gulch EPSG:32612, Black Cove and fixture-east EPSG:32617, Emigrant
  (Oregon) EPSG:32610, Eaton and Palisades EPSG:32611.
- 14.12.5 / 14.12.6: `types.record_issuer_of(summary)` drives every bundle text ("Reported by USFS via NIFC WFIGS Jul
  09, 13:32 MDT"); WFIGS records add the data source "NIFC WFIGS incident record (IRWIN)" (**deviation**:
  `observed.SOURCE_PREFIXES` gained it so the observed step keeps it).
- 14.12.7: `validate.skill_entry` writes `growth_sorensen` on every skill entry (cut-line d).
- 14.12.8 Perimeters: California records keep brief 2's queries exactly (identical OBJECTID sets for Eaton,
  Palisades, Madre, TCU); WFIGS records match by IRWIN id, else by name in `US-<state>`.
- 14.12.9 `fixture-east`: `make_fixture.py --only east`, NC, America/New_York, EPSG:32617, record "NIFC WFIGS (IRWIN)".
- 14.12.10 GSI live fuel moisture outside California (folded from `contract3/validation.md`, integration part 2):
  - Switch `is_california(summary)` (`state == "CA"`, else a CAL FIRE uid when the state is unset) keeps the month
    table and drought rule exactly (`_california_moisture`, compared in `tests/test_gsi.py` with a frozen pre-GSI copy
    on Eaton, Palisades, Madre and `fixture-demo`); everything else uses `gsi_nfdrs2016`.
  - Method `spread/moisture.py` (`config.GSI_*`, NFDRS4's defaults, nothing fitted): daily GSI = iTmin · iVPD · iDayl;
    VPD = es(Tmax) · (1 − max(RHmin, 5 %)/100); day length NFDRS4 `CalcDayl` (**deviation**: not the archive host's
    `daylight_duration`, which is stored for audit only); the mean of the 21 local days before the start's day (all 21
    required), scaled by `GSI_MAX` 1.0; green-up 0.5: herb 0.30 → 2.50, woody 0.60 → 2.00, linear above it.
  - Inputs `sources/weather.py` `gsi_inputs`: hourly 2 m temperature and humidity aggregated to the fire's local days
    (**deviation**: not daily aggregates), ERA5 on the archive host (`models=era5`, historical: start − 28 d through
    the end of the weather window, **deviation**: not to the start) or the forecast host's `past_days=28` (live, TTL
    6 h). Stored in the backend-only `sim/lfm_gsi.json`; builds and live forecasts fetch it, hindcasts never do.
  - `live_moisture_detail(bdir, manifest, start_ms, gw=None, *, fetch=True, fetch_gsi=None)`, `gsi_at(doc, t_ms, *,
    hold_last=False)` (the behaviour charts hold the latest 21-day value after the series ends; gaps are never bridged).
  - Never silent: no series or fewer than 21 days → California's values with the note "Live fuel moisture:
    California's seasonal values (GSI series unavailable); experimental." and the manifest warnings "Weather: GSI live
    fuel moisture series unavailable: …" and `INTERIM_LFM_WARNING`, whose text the integration changed in part 2 to
    "Live fuel moisture outside California uses California's seasonal values because the regional (GSI) series is
    unavailable; experimental." (validation review R2: the GSI method is tested now; the wave-1 text "… until a regional
    method is tested; experimental." is removed on rebuild, `LEGACY_INTERIM_LFM_WARNINGS`). The behaviour charts'
    fallback hours: "Fire behaviour charts (<dates>, <n> h): live fuel moisture uses California's seasonal values (GSI
    series unavailable); experimental." (not added when the bundle already carries the interim warning, either text).
    `build --require-hrrr` fails instead (`WeatherError`).
  - Outside California the water-year request is still made best-effort (the fallback and the ablation;
    **deviation**), herb treated as perennial, no snow-day flag. Ablation switch `config.LFM_FORCE_CALIFORNIA`.
  - Results: docs/validation.md section 10 (12 fires; California unchanged to |Δ| < 0.001 after GSI).
- 14.12.11 Smoke builds: Horse Gulch (MT) ready (UTM 12, LF2023, 346 h HRRR, 2,937 FIRMS detections, observed/record
  acres 1.01, 0 "CAL FIRE"). Black Cove (NC), built by validation, checked in integration part 2: UTM 17 (EPSG:32617),
  LF2024, America/New_York, 339 h HRRR (`open-meteo:historical-forecast:gfs_hrrr`), 1,308 FIRMS detections (1,290 of
  this fire), final WFIGS perimeter 3,772 ac vs record 3,502 ac (1.08), 0 "CAL FIRE" in the manifest.
- 14.12.13 Validation's build-code bug fix (`catalog._estimate`, validation's permission): AOI sizing passes the WFIGS
  identity to the perimeter query, so fires outside California are sized by their own perimeter (Windy Deuce 36 → 60
  km); seven bundles rebuilt; regression test `test_firedata_catalog.py::test_estimate_fire_bbox_matches_a_wfigs_fire_by_irwin_id`.
- 14.12.12 Live loop: national candidates, `AUTO_BUILD_MAX = 4`.

### 14.13 Sources and credits (exact lines; SPEC §2 rows by `us-catalog`, README by final verification)

| Source | Use | Terms (checked) | Credit line | Owner |
|---|---|---|---|---|
| NIFC WFIGS Incident Locations (Current, YearToDate, all years), `services3.arcgis.com/T4QMspbfLg3qTGWY` | national fire list and records | item licence is a disclaimer only, no use restriction (B 2.1, 2026-10-22) | "NIFC WFIGS (IRWIN)" | us-catalog |
| NWCG Unit Identifier codes | plain agency names | to verify on NWCG's official page (us-catalog) | "Agency names: NWCG unit identifiers" | us-catalog |
| USDOT BTS NTAD Time Zones | time zone at a point | "available for unrestricted public use" (2023-01-05 edition) | "Time zones: USDOT BTS NTAD" | us-catalog |
| Census TIGERweb states, counties, AIANNH | state, county, Navajo/Hopi | public domain, "Source: U.S. Census Bureau" | "Boundaries: U.S. Census Bureau TIGERweb" | us-catalog |
| Census 2026 Gazetteer Files (national) | towns, ZIP areas, counties | public domain | "U.S. Census Bureau Gazetteer Files" | us-catalog |
| NWS API alerts, national (incl. relayed local officials' messages) | fire weather, local alerts live | public domain (weather.gov/disclaimer) | "National Weather Service" | us-pipeline |
| OpenFEMA IPAWS Archived Alerts v1 | local alerts, past days | OpenFEMA terms (2025-01-22): notice required, no logos | "FEMA IPAWS archive via OpenFEMA" + the notice of 14.7 | us-pipeline |
| Oregon OEM "Evacuation Areas Public" | evacuation zones in Oregon | licence field "Public"; no further terms published (checked 2026-10-22) | "Oregon Department of Emergency Management" | us-official |
| LANDFIRE LF2023 (same service as LF2024/LF2025) | pre-fire fuels of FY2024 fires | public domain (as today) | "LANDFIRE" (edition named) | us-pipeline |

Not used (and why): FEMA IPAWS public feed (needs registration, round 2 item 5); Washington SEOC evacuation layer
(indemnification terms declined, round 3 item 1); Florida SERT (county status only, round 2 item 6); Arizona DEMA
planning zones (not maintained); NIFC GACC polygons (terms unverified); GOES-East imagery (deferred); county and
vendor evacuation systems (out of scope).

#### 14.13 as built

- Terms checked by the roles: NWCG PMS 931 (public domain, credit NWCG; `nwcg_agency_codes.json` `meta`), NTAD Time
  Zones (`copyrightText`: unrestricted public use), TIGERweb ("Source: U.S. Census Bureau"), Census Gazetteer (public
  domain), Oregon OEM item (`licenseInfo` "Public", re-read 2026-10-23), OpenFEMA terms (notice, no logos). SPEC §2
  carries a row per source.
- In the app: "NIFC WFIGS (IRWIN)" (data sources, record links), "Agency names: NWCG unit identifiers" (fire card;
  integration: also an open fire's data sources), "Boundaries: U.S. Census Bureau TIGERweb · Time zones: USDOT BTS
  NTAD" (overview location card; integration: also an open fire's data sources, linked to the services named in the
  backend's data files), evacuation credits per answered source ("Evacuation zones: local officials via Oregon
  Department of Emergency Management"), local alerts' NWS and OpenFEMA credits (14.7). README rows are written by
  final verification.

### 14.14 Fixed wording (exact strings shared across roles)

- No evacuation feed: "Official evacuation zones are not available in this state ({State}). Follow local officials."
  Short form (cards, phones): "Evacuation zones: not available in this state".
- Not supported: "Fire-3d does not support Alaska, Hawaii or US territories yet." Outside the US: "Outside the United
  States: Fire-3d has no data here."
- Cameras: "Public cameras: California only (ALERTCalifornia, Caltrans). Not available in this state."
- Accuracy: 14.4. Untested: "Accuracy not yet tested here." Always: "Outside the modeled area is unknown, not low."
- National list down: "The national fire list (NIFC) is unavailable right now; only California fires (CAL FIRE) are
  listed." CAL FIRE down: "CAL FIRE's list is unavailable right now; California fires are listed from NIFC WFIGS."
- List absence (legend, list footer, empty view; 14.11): "Only fires reported to CAL FIRE or NIFC are listed; a place
  with no marker is not an all-clear. Follow local officials." Short form (phone peek): "Only reported fires are
  listed · not an all-clear".
- Standing (unchanged, `lib/plainLanguage.ts`): "Experimental model output, not an official forecast or evacuation
  instruction. Follow local officials."; never "safe" or "low risk"; absence of official information is never an
  all-clear.

#### 14.14 as built

- Used as written, plus: the plural not-available sentence ("… not available in these states (Nevada, Utah). Follow
  local officials."); the cameras sentence as the backend's `CAMERAS_NOT_AVAILABLE`; "Fire-3d lists fires in the lower
  48 states only, so fires here are not listed. Follow local officials." (Alaska, Hawaii and territories on the
  overview location card); "Fire-3d checks local officials' alerts in the lower 48 states only." (local alerts outside
  the lower 48).

### 14.15 As-built notes

Reviewers write `docs/redesign/reports/review3-<label>.json` and `docs/screenshots/review3-<label>-*.png` and never
overwrite a role's own evidence. Each wave-1 role writes `docs/redesign/contract3/<label>.md` (what was built against each sub-section above, deviations,
file list) and keeps it current; `validation` writes `docs/redesign/contract3/validation.md`. The integration folds
them into this section as "14.x as built" sub-headings.

**Integration part 1 review fixes (2026-10-23).** What changed after the review of integration part 1 (report:
`docs/redesign/reports/brief3-integration.json`, key `part1_review_fixes`):
- 14.1: the fixture server (`backend/scripts/serve_fixture.py`, `./dev.sh --fixture`) answers with every required
  field again: list rows carry `bbox_lonlat`, the list carries `sources` (both lists "unavailable": "Fixture server:
  only the fire bundles on disk are listed …") and honours `year` / `state`; `LiveStatus.detections_24h` is the sum
  of the live bundles' detections (`tests/test_serve_fixture.py`).
- 14.4: the Analysis drawer follows decision 7: Public shows the words with the score behind "How was it tested?"
  (`RegionAccuracy words`); Command and the Forensic Analysis tab show the score line.
- 14.5: agency record times on the fire card and in Official now carry their year whenever any of them differs from
  the fire's year, the replay's or today's (`lib/time.ts` `recordYearMode`): "record last edited May 14, 2026" for a
  2025 fire, "Updated … Sep 6, 2026 14:18 PDT · contained Dec 16, 2025 14:30 PST".
- 14.6: the overview's national count says "N alerts upcoming" / "in effect or upcoming" when any alert starts later
  (`official/model.ts` `statewideCountText`).
- 14.7: local officials' messages reach the places a non-expert sees first. Public's compact "Official now" gains a
  "Local officials' alerts" line while a message is in effect or was sent within the replay's next hour
  (`officialSummary.ts` `localAlertsLine`): the lead ("Archived alert from <issuer>"), the verbatim text in quotes,
  its own sent time in its area's zone, "FEMA archive" / "relayed by NWS", "+N more in Details" and its link; it sits
  after the Evacuations line and is never merged with it or with model output. The phone Updates badge counts those
  messages (`officialBadge(evac, fw, local)`); its level is `'order'` for a verbatim "Evacuation Immediate" or
  "Shelter In Place Warning", else the new `'local'` ("local officials' alert"), above fire weather and below an
  evacuation warning. A message sent after the reference time reads "sent 32 min after this time" (one whose onset is
  later "not yet in effect"), never "upcoming", in Official now, the location card and the feed chip ("Sent after
  this time"; `localPhaseText`, `feedStatusLabel`); the link is separated from the phase words. "None here" lines and
  the row's source name the channels that answered (`answeredChannelsText`): "relayed by NWS", "FEMA archive" (a past
  time older than NWS keeps), "NWS, FEMA archive"; "1 of the fire's local alerts is …".
- 14.8 / 14.14: Public's compact Evacuations line names the states like the full panel ("Not available in this state
  (Montana).", "Not available in these states (North Carolina, South Carolina)."); the location card's past-date line
  reads "Evacuation zones: not available for past dates" (was "Evacuation orders: not shown for past dates").
- 14.9: the fire-start text the build writes ("Reported by DFR via NIFC WFIGS Mar 19, 15:00 EDT") is shown in the
  panel's clock and the fire's zone (`feedModel.ts` `localizeDetailTimes`: Public "Mar 19, 3:00 PM EDT"); the
  `original` wording keeps the producer's words, its times in the panel's clock too (round 2, N2).
  `zoneLine(tf, ms, whose, alsoMs?)`: a replay's panel names the abbreviation at the replay time first and today's
  too when it differs ("Times: Pacific Time (PST/PDT), the fire's local time" for the Eaton replay read in October).
- 14.10: fire results in the search say where each fire is with its state (`fireResultFacts`, the overview's
  `fireWhere`: "Lincoln Co., NE · 2026 · 129,253 acres · 100% contained"); when nothing matches, the message covers
  fires ("No listed fire, US city, town, county or ZIP code matches …", the geocoder's hint kept). Only the listed
  fires are searched (active, 2026, 2025 and the open fire): a prepared fire of another year (Horse Gulch, 2024) still
  opens by its link only.
- 14.11: see "14.11 as built" (one `showFireCard` for every path; another open fire closes first).
- Build: `vite.config.ts` also bundles `extras-dev.html`, so the build gate covers every page.

**Integration part 1 review fixes, round 2 (2026-10-23; report key `part1_review_fixes_round2`).**
- 14.11: a click on an unprepared fire's map marker keeps its card and the zoom focus hold (see "14.11 as built").
- 14.7: Public's short "Local officials' alerts" line says where the quoted message's area lies, in the full block's
  words and the viewer's units (`localAlertPlace`): "… · FEMA archive · area covers the fire's reported location ·
  +2 more in Details", "… · matched by county, not by an exact area · may be about another fire".
- 14.9: the expanded feed row's "Original" line (`FeedItem.original`, the producer's wording) shows the times the
  build wrote into it in the panel's clock (Public "Mar 19, 3:00 PM EDT", Command "Mar 19, 15:00 EDT").
- Shell store (CONTRACT §13 shell): leaving a fire (close, zoom-out, the not-found fallback) returns the store to the
  overview's clock, live mode at the current time, as at start. Before, a closed past fire's replay mode and minute
  stayed: the next fire opened kept them until its own data arrived (one without a ready analysis kept them for
  good, so its official answers were for the closed fire's replay time), and `/api/live/status` stopped refreshing on
  the overview.

**Integration part 1 review fixes, round 3 (2026-10-23; report key `part1_review_fixes_round3`).**
- 14.7: a local officials' message is never in effect, quoted as current or counted by the phone badge before its own
  sent time (see "14.7 as built", N4). This narrows the round-1 note above: the badge counts the messages in effect or
  announced with a later onset, not those sent after the replay time; the short line may still quote one of those
  (when nothing else is in effect) with "sent N min after this time". The badge's screen-reader words read "the most
  urgent an evacuation order" (was "a evacuation order").
- 14.11: one wheel notch ends a fire card's or an official area's focus hold (see "14.11 as built", round 3).

**Integration part 1 review fixes, round 4 (2026-10-23; report key `part1_review_fixes_round4`).**
- 14.7: round 3 decided whether a local message was in effect at the start of the hour (the answer's
  `requested_at_ms`), so a message sent between the hour and the replay time read "not yet in effect" and was left
  out of the badge. The web now decides "in effect", the order, the short line and the badge count at the panel's own
  time from each message's own times (see "14.7 as built", round 4); the query stays hour-quantised (why: same
  sub-heading). No backend change (a docstring in `nws.local_phase`).

**Integration part 2 (2026-10-23; report key `part2_done`).** Every item of part 1's `part2` list, the orchestrator's
round-4 carry-over and the validation review's web leftovers:
- 14.2: an outage of the source lists is HTTP 503 "The fire lists could not be reached right now; try again later."
  (never "a local or synthetic bundle"); same-name WFIGS records are one record (both: "14.2 as built").
- 14.4: validation's results folded; `AccuracyFire.growth_ratio_median`; the amended wording ("14.4 as built").
- 14.7: one time for the feed and the panels; "less than a minute" ("14.7 as built").
- 14.12: deprecated FIRMS loaders and names removed; GSI folded; `INTERIM_LFM_WARNING` text; Black Cove's acceptance
  numbers ("14.12 as built").

**Folded (integration part 1, 2026-10-23):** `us-catalog.md`, `us-official.md`, `us-pipeline.md` and `us-web.md` are
summarised in the "14.0 as built" to "14.14 as built" sub-headings above (what differs from the text, the deviations
and the integration's own changes). The role notes stay in `docs/redesign/contract3/` as the detailed record (file
lists, measurements, review fixes). `validation.md` (GSI, the regional results, `regional_accuracy.json`) was folded
in part 2 ("14.4 as built", "14.12 as built" 14.12.10 and 14.12.13).
