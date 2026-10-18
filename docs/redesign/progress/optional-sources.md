# optional-sources progress log

Role: optional sources of BRIEF §11 (evacuation zones/status, public cameras, recent satellite imagery).
Owns `backend/fire3d/api/extras.py`, `backend/tests/test_extras.py`, `data/cache/extras/**`, `web/src/extras/**`,
`web/extras-dev.html`, and the appended "Optional sources" section of `docs/redesign/CONTRACT.md`.
Ports: API 8716, Vite 5185. Nothing is mounted into the app (ui-integration does that).

## Done
- Read BRIEF, CONTRACT, SPEC, reference images, http.py, app.py, map/feed skeletons.
- Research (2026-10-17, polite single requests, evidence in the final report):
  - Evacuations: Cal OES "California Evacuation Aggregation Layer"
    (services.arcgis.com/BLN4oKB0N1YSgvY8/.../CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0), public, "No
    restrictions on public use" (data.ca.gov), item licence "Public Use" + Cal OES disclaimer, rebuilt every 5 min,
    only active zones (26 statewide today: LA wildfire zones, Orange, stale 2023 Tulare flood orders). Coverage per
    county from Cal OES "County_Evacuation_Inventory_Public" (58 counties; DataInUse / DataAcqStatus / Source).
    Genasys Zone Map Service needs a signed agreement -> not used.
  - Cameras: Cal OES "CalOES California Webcams" layer (public, primary audience the general public): 2,936
    Caltrans + 1,289 ALERTCalifornia + 120 ALERTWildfire. ALERTCalifornia = CC BY-NC-ND 4.0, credit
    "ALERTCalifornia | UC San Diego", non-commercial, no derivatives. Caltrans CWWP2 CCTV feeds: public domain,
    "no charge", documented fields (inService, currentImageUpdateFrequency). Images carry Last-Modified.
    ALERTWildfire (UNR) excluded: separate terms not verified, plain-HTTP image API.
  - Imagery: Element 84 Earth Search STAC (Sentinel-2 L2A, TCI COG, ~4-5 h latency, Copernicus licence);
    NASA CMR (HLS L30, VIIRS granule pass times, public metadata); NASA GIBS WMTS EPSG:3857 (VIIRS daily
    L9, HLS L30 L12, GOES-West GeoColor 10-min L7; CORS *; acknowledgement text required).

- Backend `extras.py` done: /api/extras/{evacuations,cameras,cameras/latest,cameras/frames/{token},imagery,
  imagery/sentinel2.webp,sources}. Live-checked on port 8716 (Bryson Fire area: 2 orders + 12 warnings in LA
  County; Cooley: none listed, coverage Lake/Mendocino/Sonoma; Eaton: not available for past dates; 41 cameras
  near Cooley; ALERTCalifornia Mt. Sanel 1 frame with Last-Modified; imagery Cooley 18 products, Eaton replay 17;
  Sentinel-2 render 2043x2048 WebP in 14 s, cached).
- `tests/test_extras.py`: 39 offline tests pass; full backend suite 477 passed.

- Frontend modules web/src/extras/** (client, hooks, format, style, mapLayers, evacuation, cameras, imagery, legend,
  panels, extras.css) + vitest (54 tests). Dev page web/extras-dev.html + src/extras/dev/** (18:25 resume: fixed
  the blank map (maplibre-gl.css position: relative), styleimagemissing filler).
- 18:30 resume: `extrasAtMs` / `isPastForCurrentSources` take the timeline NOW marker (`liveNowMs`) so a stale live
  incident still shows current status at NOW and in its forecast; imagery timing flags re-processed catalogue
  entries (> 30 days) and replay images listed after the selected time.

- 18:50: dev page finished (presets relative to the NOW marker, two-row chrome, responsive framing, Show on map,
  dev controls view/setOpacity/fitZones). pickDefaultImagery(data, startedMs) prefers post-fire images, then
  full-coverage context; imagery feed items only after the fire start; backend S2 display.pixel_m + resolution
  note ("shown at about 13 m"), 39 backend tests pass. Screenshots: redesign-extras-{evacuations-live,
  cameras-live,imagery-live,replay,imagery-alignment,imagery-viirs,unavailable,narrow}.png (outage shot = real
  failure path: API restarted with a dead HTTPS proxy and an empty scratch cache, then restored).

- 19:02: panels, credits.ts (+ test), format.test.ts; CONTRACT §12 "Optional sources" appended (12.1-12.7).
- 21:44 resume (after the user's pause): `tsc -b` clean. Security sweep done: no HTML sinks (setHTML,
  innerHTML, dangerouslySetInnerHTML, eval) in web/src/extras or extras-dev.html; the real FIRMS key appears in none
  of the 38 owned/cache files (count-only scan); the test key is a placeholder; hrefs are https-only
  (`Reference_App` filtered) or fixed templates with regex-checked ids; Caltrans/ALERTCalifornia frames fetched from
  fixed https templates only; extras-dev.html is not a build input.

- 21:46 final checks: tsc -b 0; lint 0 (55 warnings = src/scene baseline, 0 in extras); vitest 26 files / 392
  (extras 8 / 61); vite build to scratch OK (extras-dev.html not emitted, no extras code bundled); pytest extras 39,
  full backend 478. Live smoke on 8716/5185 (18:48 PDT): Cooley evac available 0 zones + coverage Lake/Mendocino/
  Sonoma; Eaton past -> not_available_for_past_dates; LA bbox 0 zones (Bryson zones lifted; statewide layer now 1
  Orange order + 8 old Tulare orders); Orange bbox 1 "Evacuation Order" zone; Cooley cameras 41 (37 wildfire, 4
  traffic); ALERTCalifornia frame 1920x1080, 19 s old; bad id -> 400; imagery Cooley 18 products, Eaton replay 16.
  Dev page 0 console/page errors. Servers stopped. Report written.

## Next
- Nothing left in this role; ui-integration mounts per CONTRACT §12.3.

## Decisions
- Evacuation status is current-only: `at_ms` older than now - 6 h (= timeline STALE_AFTER) or a historical
  incident -> `not_available_for_past_dates`. Cameras likewise (live images only). Imagery supports past dates.
- Map colours follow CONTRACT §9 (order #e0459b, warning #a78bfa, other #7aa2f7) + cross-hatch; official status
  wording verbatim.
- Camera frames: backend fetches on explicit request, returns JSON with a content-addressed frame URL + the
  frame's Last-Modified time (time always matches the bytes). In-memory only (Caltrans does not retain images).
- Sentinel-2: backend renders the TCI asset into EPSG:3857 WebP over the request bbox (exact MapLibre image
  source alignment); disk cache data/cache/extras/sentinel2 (size-capped).

## Open problems
