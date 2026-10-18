# map-core progress log

Role: map-core (API 8712, Vite 5181). Owns web/src/map/**, web/src/lib/reproject.ts (+ tests), web/src/data/**.

## Done
- 16:01 restart: earlier attempt left no files (map/ still the foundation skeletons). Read BRIEF, CONTRACT, SPEC 4-5,
  references, rasters.ts, workspace.ts, App.tsx mount points, map-layout.css, MapLibre 5.24 image/canvas source + RTT code.
- 16:35 lib/reproject.ts (three-free UTM/Mercator, AOI ring, snapped overlay placement, per-pixel mapping, cache;
  512² mapping = 50 ms) + reproject.test.ts 25/25 (exhaustive per-pixel check fixture-demo, sampled zones 10/11,
  edges/corners, backend bbox agreement, MapLibre corner rounding, no source pixel dropped).
- map/contours.ts (+9 tests), map/basemapStyle.ts (+6 tests; real OpenFreeMap styles validate with 0 errors via
  @maplibre/maplibre-gl-style-spec), map/providers.ts (DEM z16, USGS z16, credits, dev ?mapfail=),
  map/overlayModel.ts (+13 tests incl. real Eaton: quantile vs probability classes identical at horizon end).

- 17:20 MapView = thin wrapper over map/mapController.ts (style load/switch, overlays, vectors, pin, fly-to, padding,
  2D/3D terrain, hover popups, provider health) + rasterOverlay.ts, markers.ts, layers.ts, mapStore.ts,
  MapNotices.tsx, MapControls.tsx, MapLegend.tsx, MapAttribution.tsx (+ scale.ts, 3 tests), map.css.
  Typecheck clean, lint 55 baseline, 32 map tests + 25 reproject tests pass.
- Visual (Eaton, servers 8712/5181): 2D dark framed on the AOI; z15 west Altadena at the final time: NIFC perimeter,
  reprojected raster blocks and edge line coincide on OSM streets; roads + aerial basemaps; aerial 3D draped.
- Fixes found visually: safe-area padding interrupted the framing flight (now restarts the flight); detections were
  overwhelming (24 h window, GOES 90 min outline only, dots below z12.5, footprints above); light-map label theme;
  liberty null warnings (building-3d coalesce, guarded rank comparisons).

- 18:25 resumed after the pause. Dev counters (window.__mapStats) and ?mapfail= now sit behind import.meta.env.DEV
  (production build checked: no counter / mapfail strings). Scenario checks on Eaton (servers 8712/5181): selection +
  centre survive 2D->3D->aerial->2D, basemap switch keeps all overlays (same pixel counts), forecast scrub
  (before start = horizon, +24/+48 h = time), outside AOI notice + return, event marker click, pin drag, Forensic
  round trip (map removed, centre 0 m, zoom 0), reduced motion, fixture-live zone 10. Playing 5 s: 45 runs (max
  21 ms), idle 3 s: 0 renders / 0 runs.
- Fixes: TileJSON failures (vector, terrain) now fail the provider at once (error without a tile); credits drop
  failed providers (+ providers.test.ts); phone controls fit one row; hover prefers event markers (like click);
  forecast leaves out only what the observed layer shows (no blank band before the forecast start; observed layer
  off -> full model output); older detection dots smaller/dimmer; observed fill = --m-fire-observed-fill.
- reproject.test.ts: + real Cooley (zone 10), Madre (zone 11 AOI across 120° W), Camino (272 px) -> 46 tests.

- 19:00 start-up race fixed: under StrictMode the discarded first map saved its placeholder California view
  (moveend -> setView) and the second restored it, so late incident data never framed the AOI. Views are now kept
  only once framed / restored / moved by the user (moveend.originalEvent) or after a fly request; fly() records
  activeFly after starting the move. Checked with delayed catalog loads: 4/4 runs end framed on the AOI.
- Final screenshots docs/screenshots/redesign-map-*.png (17: 2D dark/roads, 3D dark/aerial (Command), beyond and
  outside the AOI, forecast +24 h / before start with legend, Eaton alignment close-ups (west Altadena roads +
  aerial, Lake Ave, Eaton Canyon), fixture-live zone 10 + AOI corner, terrain / basemap failure, phone 390).
- Keyboard: canvas tabindex 0 + label; arrows pan, = zooms, Shift+arrows rotate; compass / zoom / Incident / 3D
  buttons work with Enter / Space. typecheck 0, lint 55 (baseline, 0 outside src/scene), npm test 26 files /
  392 tests, vite build ok (no dev strings in production chunks).

## Next
- Report. (Done unless the integrator asks for changes.)

## Decisions
- Forecast display uses only exact readings: classes ">= K % of model runs reached this spot by X" for K = 10/50/90,
  X = timeline time (arrival_pK <= t) or the horizon end (burn_probability). No interpolation between quantiles.
  View 'auto' (default): full-horizon chance before the forecast start, spread by the timeline time inside it.
  Hatch + dashed outline = >= 50 % of runs; dotted outline = >= 10 %; darker tint = >= 90 %.
- Overlay placement: MapLibre rounds image/canvas corners to 1/8192 of the image's tile (getCoordinatesCenterTileID);
  the output rectangle is snapped to that grid so the per-pixel mapping matches what is drawn exactly.
- Canvas source (animate false) updated with play()/pause() + setCoordinates(same) so 3D terrain RTT tiles refresh.
- Basemaps: symbol layers moved last; overlays inserted below the first label layer (above roads). Hillshade from a
  separate Mapterhorn DEM source in dark / roads. Aerial = USGS (sat -0.6, brightness-max 0.68) + liberty roads/labels.
- Hover = text-only popup (detections, perimeters, events, incident); click = select location (events: selectFeedItem).

## Open problems
- Optional sources (evacuation / cameras / recent imagery) are not mounted on the map; MapLegend lists toggled-on
  keys as "not available". extras/mapLayers.ts LayerGroupHandle re-adds its layers on style.load and can take
  beforeId = drapedLayers() ids / topBeforeId = topLayers() ids (ui-integration).
- Shell-owned: the "Research prototype" note is white text that is hard to read on the light Roads basemap.
