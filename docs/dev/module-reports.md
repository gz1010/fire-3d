# Module agent reports (condensed)

Condensed final reports from the 10 build agents (scaffold + 9 modules), 2026-10-16/17. Full reports are in the Claude Code workflow journal. Secrets are masked.

## scaffold

### Summary

The scaffold is built and verified. All 30 backend modules import, 55 tests pass, both fixtures validate strictly, every fixture-server endpoint behaves, the web build passes, and the scaffold screenshot renders on the GPU with 0 page errors.

The existing environments were reused unchanged: `uv sync --frozen` and `npm ls` were clean, and nothing was installed or upgraded.

**Backend core** (`fire3d/`):
- `config.py`: `.env` loader where the real environment wins; paths, where a relative `FIRE3D_DATA_DIR`/`FIRE3D_CACHE_DIR` resolves against the repo root; constants; certifi SSL setup; `FIRMS_MAP_KEY` plus `mask_secrets()`; flags; the live fuel moisture table; an empty AIRCRAFT CLASSIFICATION block for the api agent.
- `contracts.py`: pydantic models for every SPEC 5.1/6 shape. `x?` fields are omitted from dumps when None; `contract_problems`/`validate_strict` check types strictly and flag unknown keys.
- `types.py`: the SPEC 7.1 dataclasses.
- `grid.py`: Grid/AOI maths with cached pyproj transformers, vectorised.
- `http.py`: on-disk cache, retry with backoff, 4 concurrent requests, User-Agent, a FIRMS limiter applied automatically, and masked URLs in errors and logs (including httpx's own logger).
- `bundle.py`: atomic writes and a lock-protected manifest update (fcntl plus re-entrant), layer/JSON/npz I/O, traversal-safe paths.
- `timeutil.py`.
- Stubs with the exact SPEC 7.3 signatures, `cli.py` (catalog/build/forecast/hindcast/serve), and `api/app.py` serving `/api/health` only.

**Fixtures** (`scripts/make_fixture.py`, ~30 s): two procedural, strictly validated bundles.
- `fixture-demo` (historical): 12 km AOI, EPSG:32611, 400² fire grid. 11,878 ac over ~5 days, with a 20.2 m/s wind event, a spot fire across the creek, 8 events, 287 VIIRS + 25 MODIS + 942 GOES + 36 Landsat detections, 9 perimeters, ~60k trees, a 2048 px NAIP-like photo, and a 31-member perturbed hindcast `fx-001` with skill scores.
- `fixture-live` (live): 16 km AOI, EPSG:32610, 512² grid. "Now" sits ~2/3 of the way through the observed period, and the gfs025 ×31 forecast starts at now.
- Both have realistic terrain (300–1800 m, median slope 20°), a carved river valley, FBFM40 fuels and sky-view AO.

**Fixture server** (`scripts/serve_fixture.py`): serves every SPEC 6 read endpoint from disk. Bundle files get gzip, ETag/304 and no-cache, and are traversal-safe. Jobs are fake and finish in ~5 s. 4–6 synthetic aircraft circle live incidents.

**Web**:
- Config: Vite multi-page build (port from `PORT`, strict, `/api` proxy), TS 6 configs, fonts, the theme tokens.
- `api/types.ts` and `api/client.ts`.
- `state/store.ts`: the full SPEC 9.2 store with its defaults, every setter, and working async actions (race-guarded, with job polling); exposed as `window.__store`.
- `lib/`: raster, geo (heightfield raycast and an in-browser UTM conversion, checked against pyproj to 0.3 mm), time (DST-safe LA formatting), format, fuels with both lookup tables.
- `scene/`: shared `assets.ts` (`useIncidentAssets`, deduped, disposes old textures), `sceneStore.ts`, the `SceneFx` placeholder, and a minimal working `Scene.tsx` (NAIP terrain, charred ground and front from arrival time, fog/edge fade).
- Dev pages, `scripts/shot.mjs`, `App.tsx` (lazy scene, `VITE_SCENE=off`, default incident selection, `?t=`), and glass placeholder panels.

`dev.sh` was tested on my ports: clean start, and SIGTERM stops both process trees.

### Contract deviations

- contracts.py: models accept unknown keys so loading and re-saving a file loses nothing; `contract_problems()`/`validate_strict()` do the strict check (JSON types such as int vs float, Literal values, and unknown keys anywhere). TS `x?` fields default to None and are left out of dumps. Added API wrapper models: HealthResponse, IncidentListResponse, IncidentDetailResponse, ForecastRequest, AircraftResponse (with an optional `note`, used for 'historical → empty list plus a note'), LiveStatus. Also added a `dump()` helper.
- WeatherFile.grid.x/z: interpreted as the 4 column-centre x values (west→east) and the 4 row-centre z values (north→south). u/v hold len(t)·16 values, flattened [t][j][i]. The validator enforces this; `grid.weather_axes()` produces it.
- grid.py: 'rowcol' values use rasterio's continuous convention: pixel (r, c) covers [r, r+1), so its centre is (r+.5, c+.5). Use floor for the containing pixel and subtract 0.5 for scipy map_coordinates. `make_aoi` gained an optional `acres=` keyword for the fallback radius. Additional helpers: transformer, res_x/res_y, shape, crs, utm_zone, pixel_center_local, local_to_rowcol, rowcol_to_local, en↔lonlat, contains_local, cell_centers_lonlat, fire_grid_size, aoi_extent, fallback_radius_m, weather_axes, slope_aspect (aspect = downslope-facing, degrees clockwise from N), manifest_grid, grids_from_manifest.
- bundle.py: the manifest is handled as a dict during builds; `load_manifest_model()` returns the pydantic model. `write_layer` has keyword-only `rel_dir=` and `register=` so forecast rasters go to forecasts/{run}/ without registering in manifest.layers. float64 is stored as float32 and bool as uint8. `read_layer` on a JPEG returns an (H, W, 3) uint8 array. Extras: resolve_bundle_file, forecast_dir, new_forecast_run_id ('fx-NNN'), write_npz/read_npz, read_array, remove_layer, manifest_lock, layer_stats, STATIC_NPZ.
- http.py: besides get_json/get_bytes/get_text/post_json there is `request()`, which returns a Response carrying content_type and from_cache (useful because ArcGIS returns errors with status 200). `ttl_s=None` means never expire and `0` bypasses the cache. The cache key uses the masked URL, so cached entries survive key rotation. Failures raise HttpError. `stream_download` keeps an existing file unless overwrite=True.
- config.py: a relative FIRE3D_DATA_DIR/FIRE3D_CACHE_DIR resolves against REPO_ROOT, not the current directory. `mask_secrets` also masks FIRMS key-shaped path segments and `MAP_KEY=` query values even when the key isn't set. Added AOI-sizing constants. The AIRCRAFT CLASSIFICATION section declares empty FIRE_AIRCRAFT_TYPES, FIRE_REGISTRATION_PATTERNS and FIRE_CALLSIGN_PREFIXES.
- sim/static.npz in the fixtures has an extra scalar key `res_m` alongside the 8 SPEC keys.
- spread/behavior.surface_behavior: the SPEC's 'fm...' was expanded to explicit fm1, fm10, fm100, fm_live_herb, fm_live_woody arguments. validate.hindcast_skill's '...' became (time_origin_ms, lead_hours, data_end_ms). api/jobs.py and api/live.py stubs propose JobManager.submit/get/latest_for, live_refresh_loop and live_status; the api agent owns them.
- web/src/api/types.ts: the event element type is named `FireEvent` (not `Event`) to avoid shadowing the DOM Event type. NEVER is exported as a constant.
- store.ts additions: `incidentLoading` and `incidentError` fields; convenience actions togglePlaying, togglePanelsCollapsed, setLayer/setLayerVisible/setLayerOpacity/toggleLayer/resetLayers, flyToLocal (generates the nonce), setIncidentError. Exports DEFAULT_LAYERS, LAYER_KEYS, SPEEDS_HOURS_PER_SEC, getTimeBounds, defaultTimeFor. selectIncident takes opts {autoBuild, keepTime}; loadCatalog takes {minAcres}. Default timeWindow is [start, max(end, newest forecast end)]. Non-spec opacity defaults: fuels 0.7, burnScar 0.9, wind 0.7. `window.__store` is set in production too (useful for screenshots).
- IncidentAssets additions: `forecast` and `key` fields. Exports assetStore, syncIncidentAssets, useAssetsLoading, useAssetsError. Texture semantics: uint8 layers sample as value/255; canopyCover is percent/255; fuel needs nearest filtering (code/255); burnSeverity nodata → 0.
- Fixtures:
- fixture-demo is a 12 km AOI holding ~12,000 ac, as the task asked; SPEC 8.1 sizing would give ~16 km for a fire this size.
- fixture-live uses the live AOI rules (16 km, M = 512) in UTM zone 10, to exercise a second zone.
- fixture-live has no burn_severity layer (it is optional), and the manifest carries a warning about it.
- The fixture spread and forecast come from a synthetic anisotropic Dijkstra, not pyretechnics. ForecastManifest.model.engine still says 'pyretechnics' (it is a Literal), and the forecast warnings state it is synthetic.
- The fixture server reports source 'adsb.lol (fixture)' and accepts extra `?force=1` (aircraft for historical incidents).

### Known issues

- R3F 9.8 with three 0.186 logs one console warning, 'THREE.Clock: This module has been deprecated', from inside @react-three/fiber. It is harmless and not from our code.
- oxlint warnings (not errors): react(immutability) on mutating ShaderMaterial uniforms in Scene.tsx (the standard R3F pattern), and only-export-components on the dev entry files.
- Linear filtering an arrival texture next to NEVER (clamped to 60000) sweeps through every time value at burned/unburned edges. Naive front shading then lights a false 'front' along the whole perimeter. The scaffold Scene suppresses this with fwidth(a); scene agents need an equivalent (fwidth guard, nearest sampling at NEVER edges, or a distance-to-NEVER mask).
- fire3d/types.py and fire3d/http.py have stdlib module names. They are safe with `python -m ...` from backend/ (and under pytest), but running a file inside backend/fire3d directly as a script would shadow the stdlib modules.
- fixture-live dates are relative to when make_fixture.py last ran (Oct 16, 2026 ~18:10 PDT). Rerun `uv run python scripts/make_fixture.py --only live` to refresh 'now'. The live forecast grows ~3.8x in 72 h because the front reaches fast grass fuels.
- Fixture terrain and NAIP are procedural. They look plausible from overview distance, but the NAIP shows its synthetic nature up close (uniform clump texture, grid-like town).
- tsconfig.app.json sets noUnusedLocals/noUnusedParameters to false on purpose, so a parallel agent's work-in-progress file can't break everyone else's `npm run build`.

### Notes for integrator

**Running the fixture server.** Frontend agents should run `cd backend && uv run python scripts/serve_fixture.py --port <P> --data-dir /Users/georgezhou/Desktop/Project/Fire-3d/data`. Pass `--data-dir` explicitly if FIRE3D_DATA_DIR points elsewhere, since the fixtures live in `<repo>/data/incidents`. Then run `cd web && PORT=<p> VITE_API_TARGET=http://localhost:<P> npm run dev`. `./dev.sh --fixture` does the same on 8000/5173, and `API_PORT`/`WEB_PORT` override the ports.

**Screenshots.** `node scripts/shot.mjs <url> <out> [--wait] [--eval js] [--eval-after-wait js]` works headless on the GPU (ANGLE Metal, M3 Pro). Drive the app with `window.__store.getState()...`, for example `--eval-after-wait "window.__store.getState().setTimeMs(...)"`. Pages: `/scene-dev.html?incident=fixture-demo`, `/fx-dev.html` (defaults to fixture-live), and `/?incident=&t=`.

**Backend tests.** An autouse conftest fixture blocks real network access through fire3d.http. Tests should install `httpx.MockTransport` via `monkeypatch.setattr(fire3d.http, '_transport', ...)` or use `@pytest.mark.network`. Shared fixtures: `tmp_data_dir`, `fixture_bundle`, `fixture_live_bundle`, `demo_grids`.

**Validating output.** Module agents can check their bundle output with `contracts.validate_strict(Model, path.read_bytes())` (strict JSON types: integer ms, no extra keys). `bundle.update_manifest(dir, fn)` is the only safe way to change a manifest while a build is running.

**Grid conventions.**
- Use `grid.slope_aspect()` for slope and aspect (downslope-facing).
- Use `grid.weather_axes()` for WeatherFile.grid x/z.
- Use `grids_from_manifest()` to rebuild Grid objects.

**Scene agents.**
- `scene/assets.ts` is the shared loader. Depend on the identities of `assets.elevation` and `assets.textures.*`; `assets.key` changes whenever the forecast changes.
- Arrival textures hold hours since `manifest.time_origin_ms`; `uTimeH = (timeMs - time_origin_ms) / 3.6e6`.
- The PlaneGeometry rotated −90° about X has vertex row 0 at the north edge, matching elevation row 0, so per-vertex displacement maps directly.
- Charcoal `#16130F` must be converted to linear (≈0.008, 0.0065, 0.005) inside ShaderMaterial, because R3F applies ACES tone mapping plus sRGB output.

**Ownership.** The scene-core agent replaces `web/src/scene/Scene.tsx` (keep both the named and default exports, because App lazy-loads the default). The UI agent replaces `src/ui/*` and `App.css`.

**Backend agents.**
- The http cache lives in `data/cache/http`, shared even when FIRE3D_DATA_DIR changes.
- Use `fire3d.http.request()` when you need content_type, for example to catch ArcGIS JSON errors returned with status 200.
- FIRMS area-API URLs are rate-limited automatically.

**Not done here (user request in this run).** The user asked for a more realistic and parametric UI like the attached image. The scaffold only lays the groundwork (theme tokens, a minimal NAIP terrain); the art-direction look belongs to the scene and UI agents.

### Screenshots

docs/screenshots/scaffold.png

## terrain

### Summary

The terrain role is finished: all 5 owned modules work, the 45 new offline tests pass, and the whole backend suite passes (361 tests, 17.6 s). On the user's question about whether the agents are still running: this agent ran to completion and has no servers or background jobs left. I can't see the other agents or the API usage from here.

**What I kept from the interrupted run.** Its `terrain.py` (DEM fetch, export validation, sky-view, resampling) checked out against the SPEC. I only added a retry setting. `landfire.py` was mostly correct; I extended it with:
- a fetch that also returns where each layer came from, and uses the live seasonal fuel product with a fallback;
- a tree-kind lookup from LANDFIRE's vegetation-type table (conifer / hardwood / shrubland);
- shrub cover from LANDFIRE's vegetation-cover layer.

**What I wrote new:**
- `imagery.py`: the NAIP photo is fetched as four quadrant requests in parallel and stitched exactly. That cut a 75 s single 4000 px request to about 30 s. If it fails it retries at 2048 px, then 1024 px, and it checks that the image actually covers the area. It also fetches raw green and near-infrared bands for the water mask.
- `sentinel.py`: searches the public Sentinel-2 catalogue, reads only the needed part of each image straight onto the fire grid and caches it, then builds a cloud-free mosaic before and after the fire and computes the burn-severity difference (dNBR).
- `build/aoi.py`: `build_static_layers(ctx)` starts every download at once and then works through the steps terrain → fuels → imagery → trees → burn_scar, reporting progress and updating the manifest. A missing elevation model or missing LANDFIRE fuels stops the build with a clear `StaticLayerError`. Failures of the photo, water mask, trees or burn severity only add a warning and delete any stale copy of that layer.

**Problems that only showed up on real data, all fixed:**
1. **Sentinel-2 offset applied twice.** The catalogue lists a −0.1 offset, but the image values already have it removed. Its "offset applied" flag is also wrong when it says false. Following the SPEC literally left 17% of Eaton pixels with no valid value and covered unburned areas in false "low severity" speckle. The code now decides from the image values themselves, and only applies the offset when the data really still contains it.
2. **Too many images read.** The mosaic chased a 99.5% fill that permanent gaps (water, winter terrain shadow labelled as cloud shadow) make impossible, and re-read other tiles from the same satellite pass. It read 13 + 8 tiles; now it reads 1 + 3.
3. **False water.** The green-vs-near-infrared water index also lights up three things that aren't water:
   - steep shaded slopes;
   - old burn scars in the photo: a Camp Pendleton burn read 0.36, against 0.56 for real water;
   - dark roofs and solar panels.

   A patch is now kept only if it is flat in the elevation model (lakes are flattened in 3DEP, so I fit a plane over each patch) and not mostly on developed land, unless it touches LANDFIRE open water.
4. **Smaller fixes.** Surf and foam speckle in the burn layer is masked over LANDFIRE open water. A typo in a GDAL setting (a string where it needs an integer) was breaking the Sentinel-2 reads.

**Real builds** (four areas, each checked visually; numbers below). Re-building with warm caches takes about 1 s; from scratch it takes 35–51 s, mostly waiting for the NAIP photo. Every manifest entry validates against the contract.
- **Eaton

### Contract deviations

- Sentinel-2 offset (SPEC 2 says to apply each asset's raster:bands scale/offset): Earth Search COGs already have the +1000 BOA offset removed, but raster:bands still lists −0.1. The earthsearch:boa_offset_applied flag is unreliable when false (items flagged false read water at 15–300 DN, just like flagged-true ones). The offset is therefore applied only when the data carry it: a true flag means no offset; otherwise the 1st percentile of both bands must be ≥ 80% of the offset in DN. Applying it literally corrupted dNBR (17% NaN, speckle across unburned areas).
- dNBR = NBR_pre − NBR_post − an unburned offset: the mode of the dNBR histogram, applied when it is ≥ 0.01 (MTBS-style phenology correction). The layer is also nodata (−9999) over FBFM40 98 (surf/foam noise). Each window is a best-pixel composite (≤ 3 passes, stop at 98% observed or < 0.5% gain, last-resort fill from shadow-flagged pixels) rather than a single least-cloudy scene. If no scene passes the 20% cloud filter, the search is repeated at 60%.
- Water mask: on top of NDWI > 0.15 ∪ FBFM40 98, an NDWI patch must touch open water, or be ≥ 4 px, flat in the DEM (plane-fit gradient < 3%, residual RMS < 1.5 m) and ≤ 50% on FBFM40 91. Pixels steeper than 0.15 are trimmed, and FBFM40-98 pixels where NAIP clearly shows land (NDWI < −0.15) are trimmed.
- NAIP: the size is rounded down to an even number (e.g. 2667 → 2666) and images ≥ 2560 px are fetched as four parallel quadrant exports (quality 92) and re-encoded once as JPEG q85. Imagery uses bilinear interpolation.
- Trees: the SPEC FBFM rule is the fallback. When available, LANDFIRE EVT physiognomy refines the kind (Conifer → conifer; Hardwood/Riparian/Developed/Agricultural/Exotic tree-shrub → broadleaf if CH ≥ 3 m; Shrubland → shrub if CH < 5 m; Conifer-Hardwood → 50/50 mix). Shrub density comes from LANDFIRE EVC shrub cover (or nominal cover per SH/GS model); shrub heights come from the Scott & Burgan fuel-bed depth. The build fetches EVC, which is not in the SPEC layer list; both EVT and EVC are optional. Rows are shuffled so any prefix is a uniform thinning.
- LANDFIRE: live incidents automatically use the seasonal FBFM40 for the month (2026: SP26/ES26/SU26/FA26), falling back to base LF2025. fuels_edition stays 'LF2025'; the seasonal product appears in the fuel layer description and in data_sources. If the requested edition fails, the other edition is tried once (with a 'LANDFIRE:' warning) before StaticLayerError.
- sim/static.npz carries the extra scalar res_m (the same convention as the fixture).
- Additions beyond SPEC 7.3: build.aoi.build_static_layers_stats(ctx) returns stats and timings (build_static_layers wraps it and returns None). Also StaticLayerError, generate_trees, fire_terrain, dnbr_windows, fetch_fuels, and a `python -m fire3d.build.aoi` dev runner with write_quicklooks. Other public helpers: imagery.fetch_naip_info / fetch_naip_gnir / water_mask; landfire.fetch_landfire_info / scale_landfire; sentinel.search_scenes / composite_nbr.
- New cache subdirectory CACHE_DIR/sentinel/<grid hash>/ holds per-scene, per-band reads on the fire grid (compressed npz, ~0.3–1 MB each).

### Known issues

- Cold NAIP is the slowest step: ~30–36 s even as 4 parallel quadrants, ~75 s as one 4000 px export. Cold builds take 35–51 s; warm builds ~1 s.
- The NDWI water filters rely on terrain and land cover, so char or dark surfaces on flat, non-developed ground can still read as water. In Napa, a few rectangular vineyard features are either irrigation ponds or dark roofs.
- Live dNBR uses the last 10 days (not before start + 12 h). Fresh fires often have no post-fire pass yet, which gives a warning. When one exists, it shows the burn at the scene time, not at 'now'. Henderson got a same-day pass through the 60% cloud fallback.
- After the global offset, dry-grass areas can still show low positive dNBR (0.1–0.27): phenology differs by cover type between the before and after dates.
- The 120k tree budget is sparse on large areas: a 20 km area on the 512² grid gets about 2 trees per 39 m cell at full canopy. The scene may want to scale crowns up.
- sky_view is the physical cos²-weighted sky-view factor (typical mean ~0.9, minimum 94–144). The terrain shader will probably want a contrast curve for visible ambient occlusion.
- Without a fire bbox, the acres-circle fallback AOI can cut off part of the burn: Pickett spread NE past the AOI edge. A production build should pass catalog.estimate_fire_bbox (perimeter ∪ detections).
- sentinel.py sets the 'rasterio.session' logger to WARNING to silence an INFO line ('boto3 not available') on every COG open.
- Sentinel-2 COG reads go through GDAL /vsicurl/, as SPEC 2 says, not through fire3d.http. They have their own limit of 4 concurrent reads, 3 retries and a disk cache.

### Notes for integrator

**For the pipeline (api agent):**
- Call `fire3d.build.aoi.build_static_layers(ctx)`. It creates `manifest.grid` with `grid.manifest_grid` if it is missing; otherwise it only sets `elev_min_m` / `elev_max_m`.
- It sets `fuels_edition` and replaces only its own `data_sources` entries (names starting with 'USGS 3DEP', 'LANDFIRE', 'NAIP' or 'Sentinel-2') and its own warnings (prefixes 'DEM:', 'LANDFIRE:', 'NAIP:', 'Water mask:', 'Trees:', 'Burn severity:'). Other modules should avoid those prefixes, or a rebuild will remove their entries.
- A missing DEM or LANDFIRE raises `build.aoi.StaticLayerError`, a RuntimeError with a user-presentable, secret-free message.
- For historical incidents the burn-severity 'after' window uses `ctx.end_ms` when set, else `summary.contained_ms`, else start + 14 d. If observed runs first and sets `ctx.end_ms`, the window will track the end of spread.
- Progress steps are exactly "terrain", "fuels", "imagery", "trees", "burn_scar", each running 0 → 1.
- Standalone check: `cd backend && FIRE3D_DATA_DIR=… uv run python -m fire3d.build.aoi --id X --name N --lon L --lat B [--bbox W S E N] [--acres A] --mode historical|live --started ISO [--contained ISO] --quicklook DIR`.

**For the scene agent:**
- `trees.bin` rows are shuffled, so taking the first 60% / 30% for the medium / low quality levels is a uniform thinning. Kinds are 0 conifer, 1 broadleaf, 2 shrub.
- `water.bin` is a soft mask; the ocean shows up where FBFM40 = 98.
- `burn_severity` is unscaled dNBR with the unburned offset removed, so values are near 0 off the fire and up to about 1.3 inside it. Nodata is −9999, including over open water.
- `sky_view` is physical; consider an ambient-occlusion curve such as `pow(sv, 2..3)`.

**Where things are:**
- Real dev bundles for integration tests: `data/dev/terrain/incidents/{2025-eaton-fire-dbfa57, 2026-henderson-fire-3e3dfe, 2025-pickett-fire-5b4fef, 2025-border-2-fire-a9719e}`. They contain static layers only: no observed, weather or forecast data.
- The shared HTTP cache now holds the Eaton/Henderson/Pickett/Border 2 DEM, LANDFIRE, NAIP and catalogue responses, so pipeline builds of those AOIs are fast as long as the AOI is identical.

**SPEC follow-up:** SPEC 2's Sentinel-2 note ('apply raster:bands offset') should be amended. Earth Search data already have the offset removed; `sentinel.offset_in_dn` handles it.

### Screenshots

data/dev/terrain/quicklook/2025-eaton-fire-dbfa57-hillshade-skyview.png, data/dev/terrain/quicklook/2025-eaton-fire-dbfa57-skyview.png, data/dev/terrain/quicklook/2025-eaton-fire-dbfa57-fuels.png, data/dev/terrain/quicklook/2025-eaton-fire-dbfa57-canopy.png, data/dev/terrain/quicklook/2025-eaton-fire-dbfa57-dnbr.png, data/dev/terrain/quicklook/2025-eaton-fire-dbfa57-water.png, data/dev/terrain/quicklook/2025-eaton-fire-dbfa57-naip.jpg, data/dev/terrain/quicklook/2025-eaton-fire-dbfa57-naip-contours.png, data/dev/terrain/quicklook/2025-eaton-fire-dbfa57-trees.png, data/dev/terrain/quicklook/2026-henderson-fire-3e3dfe-naip-contours.png, data/dev/terrain/quicklook/2026-henderson-fire-3e3dfe-dnbr.png, data/dev/terrain/quicklook/2026-henderson-fire-3e3dfe-fuels.png, data/dev/terrain/quicklook/2026-henderson-fire-3e3dfe-trees.png, data/dev/terrain/quicklook/2025-pickett-fire-5b4fef-naip-contours.png, data/dev/terrain/quicklook/2025-pickett-fire-5b4fef-dnbr.png, data/dev/terrain/quicklook/2025-border-2-fire-a9719e-fuels.png

## firedata

### Summary

The firedata agent finished its role; it resumed after the earlier usage-limit cut-off and is not still running. The earlier run had left only stubs, so all four modules and their tests were written in this session.

**calfire.py** lists the live and yearly CAL FIRE incidents through the shared cache (10 min live, 24 h yearly). Names are cleaned, times parsed to epoch ms, and a cached copy is served if CAL FIRE is down.

**firms.py** turns every FIRMS format into one 12-column table: the keyed area API (VIIRS ×3, MODIS, GOES, Landsat), the keyless 7-day feeds and the 2025 yearly archive. It fetches in day chunks, 4 at a time, through the rate limiter, picks SP or NRT products from a daily availability check, and falls back to the keyless files when there is no key or every request fails.
- Archived GOES days are fetched one day at a time: two-day requests took 30–65 s each, and the Eaton test dropped from 18 min to 24 s.
- GOES "30.0000" confidence is a fire-mask code meaning the best class, not 30 %. Taken literally, the SPEC's "drop GOES < 50" rule would delete every GOES row, so it is mapped to "100".

**perimeters.py** matches NIFC WFIGS perimeters to one fire by name tokens, California only, IRWIN discovery time, time window and distance. It fixes the timestamp problems found in the 2025 data: stale or local-time dates, repeated edits, bulk edits, final perimeters re-dated to 2026, 0.1-acre placeholders, and a mislabelled neighbouring fire's polygon.

**catalog.py** builds both catalogs (78 fires at ≥ 300 ac; 14 live fires today, sorted by 24 h detections) and reads bundle status from disk. It also finds summaries by id and estimates each fire's bounding box from its perimeter plus the connected detections.

78 offline tests cover all of this, and the full backend suite passes (367). Real-data checks matched the SPEC throughout. 51 of the 78 fires get perimeters and 47 of those match CAL FIRE's acreage within ±25 %; the other 27 have no WFIGS record at all. FIRMS use peaked at 530 of the 5,000 transactions per 10 minutes.

### Contract deviations

- FIRMS DataFrame has 12 columns: SPEC 7.3's 10 plus `type` and `source`, as the role asked. GOES confidence is the FDC fire-mask code mapped to a nominal percentage (10/30 and 11/31 → 100, 13/33 → 80, 12/32 → 60, 14/34 → 40, 15/35 → 20). This keeps SPEC 8.3's "drop GOES < 50" rule from deleting all GOES rows. GOES and Landsat scan/track become 2.0 and 0.03 km; GOES day/night is recomputed from the sun's elevation.
- firms extras: `load_live_ca(days=7, *, refresh=False)`; `load_year_ca(year=2025)` refuses the current or future year (FirmsError).
- firms extras: `detections_for(bbox, start_ms, end_ms, mode='historical', *, instruments=None, families=None, use_key=None, max_workers=4)` and `fetch_area(..., *, availability=None, max_workers=4)`.
- firms extras: archived GOES days (more than 30 days old) use 1-day chunks instead of 2-day; FIRMS answers them in about 5 s versus 30–65 s.
- firms extras: NRT coverage is treated as open-ended (the availability end date is just the day the check was cached).
- `fetch_perimeters(name, lat, lon, start_ms, end_ms, *, acres=None, contained_ms=None)` returns `PerimeterList` (a list subclass with `.warnings`). Dicts carry the role's 8 keys plus `name`, `t_field`, `object_id`, `date_current_ms`, `discovery_ms`. If both kwargs are None, acres and containment are looked up in the cached CAL FIRE year list.
- Perimeter rules go beyond SPEC 2: IRWIN discovery must be within [start − 7 d, start + 20 d]. The window starts at min(start, discovery) − 2 d. Complex children (matched by attr_CpxName) may be up to 60 km away. Placeholders under 0.5 ac are dropped; with known acres, perimeters over 2 × acres + 500 ac are dropped.
- Perimeter timestamp fixes go beyond SPEC 2 (stale, out-of-order, bulk-edit, re-dated finals; see notes_for_integrator). Records sharing one timestamp are merged by geometric union (complex children).
- `detections_24h` counts detections within max(5 km, 2 × the radius of a circle of the incident's acreage), capped at 25 km, rather than a strict 5 km or perimeter test. A detection near two incidents counts once, for the relatively closer one.
- `live_detections_24h_total()` counts points inside a simplified California outline, because the SPEC's CA bbox also covers parts of NV, AZ, OR and Mexico. The loaders themselves keep the bbox, because fires cross state lines.
- Historical catalog excludes non-fire Types (the one 2025 "Flood"; 0 of the 78 at ≥ 300 ac are affected).
- `get_summary` falls back to the CAL FIRE list of the id's year (an inactive 2026 fire gets mode "historical"), then to the bundle manifest's summary (e.g. fixture-demo).
- calfire lists return cleaned dicts: raw keys (Name stripped) plus `name, uid, type, year, started_ms, updated_ms, extinguished_ms, acres, percent_contained, lat, lon, is_active, final, county, location, admin_unit, url`. Both take an optional `refresh=False`.

### Known issues

- 27 of the 78 historical fires have no WFIGS perimeter at all; they are CAL FIRE-only incidents (14 checked: nothing within 15 km). The observed reconstruction must rely on detections for those.
- Perimeter times are best estimates. Single perimeters of small fires are often mapped near or after containment (Mountain +14 d, Mammoth +16 d). Use them mainly for the final burned area; take timing from detections.
- Complexes come back as per-child perimeters, not cumulative unions; only same-time children are unioned. TCU Complex's largest single perimeter is 51 % of CAL FIRE's acres, because it is one child fire.
- Archived GOES queries are slow on FIRMS' side (1-day requests about 4–27 s), and requests sometimes drop or time out; the http retries handle that. A 45-day historical fire needs about 45 GOES requests, roughly 1–2 min with 4 workers.
- The shared FIRMS limiter allows 150 requests per 10 min. One Gifford-size historical build uses about 110 (bbox estimate about 20, plus about 90 for the area detections), so back-to-back large builds will block waiting on the limiter. They don't fail, just slow down.
- The CAL FIRE start time can be wrong. Log Fire: CAL FIRE says 2025-09-01; IRWIN discovery is 2025-08-26, and a perimeter predates CAL FIRE's start. Perimeter dicts carry `discovery_ms` so the observed agent can widen its detection window.
- The WFIGS current layer holds only 7 California fires today. Henderson and Norte have no perimeter yet, so live bboxes for them come from detections only.
- `fire3d.http` caches every 2xx, including error text FIRMS/ArcGIS return with status 200. My modules evict those entries with `calfire.evict_http_cache`, which rebuilds the cache path from `fhttp.cache_key`. It would be cleaner as `http.request(validate=...)`.

### Notes for integrator

## FIRMS detections DataFrame
Returned by `firms.detections_for`, `fetch_area`, `load_live_ca`, `load_year_ca` and `parse_firms_csv`. Columns are exactly `FIRMS_COLUMNS`, in this order:

| Column | dtype | Meaning |
|---|---|---|
| `t_ms` | int64 | Epoch ms UTC: acq_date + acq_time zero-filled to 4 digits ("949" = 09:49) |
| `lat`, `lon` | float64 | Degrees |
| `frp` | float64 | MW; NaN for Landsat. Convert NaN to None for detections.json |
| `satellite` | str | "N" (Suomi NPP), "N20", "N21", "Terra", "Aqua", "G16", "G17", "G18", "G19", "L8", "L9" |
| `instrument` | str | "VIIRS", "MODIS", "GOES" or "LANDSAT" |
| `confidence` | str | VIIRS "l"/"n"/"h"; MODIS "0".."100"; Landsat "l"/"m"/"h"; GOES "0".."100" (mapped from the FDC code; normal rows are "100") |
| `daynight` | str | "D" or "N" (GOES recomputed) |
| `scan`, `track` | float64 | Real pixel size in km: VIIRS 0.32–0.8, MODIS 1–4.8; GOES fixed at 2.0, Landsat 0.03. Footprint ≈ scan × track km, not SPEC 8.3's "375 m × scan" |
| `type` | int64 | 0 vegetation, 2 static, 3 offshore, -1 not reported (NRT area API, feeds, GOES, Landsat) |
| `source` | str | "VIIRS_SNPP_SP", "VIIRS_NOAA20_NRT", "MODIS_SP", "GOES_NRT", "LANDSAT_NRT", … |

- Already removed: type 1 rows and the GOES `*FRP` rows.
- Not removed: confidence filtering. Use `firms.quality_mask(df)` for the SPEC 8.3 thresholds.
- Rows are sorted by time, with exact duplicates dropped.
- `df.attrs["sources"]` is a list of `{source, via: area_api|yearly_archive|csv_feed_24h/48h/7d, requests, failed, rows, fetched_ms, …}`; use it for manifest `data_sources`. `df.attrs["warnings"]` lists gaps and fallbacks for manifest warnings.

## Calling the FIRMS functions
- `detections_for(aoi.bbox_lonlat(), start_ms - 12*3600_000, end_ms, mode)` never raises on network problems.
- `load_live_ca` raises `FirmsError` only if all 4 feeds fail. `load_year_ca` raises `FirmsError` for the current year or a failed download.

## Perimeters
`perimeters.fetch_perimeters(name, lat, lon, start_ms, end_ms, *, acres=None, contained_ms=None)`. Pass `acres=summary.acres, contained_ms=summary.contained_ms`.

- It returns a list subclass with `.warnings`, sorted by `t_ms`, not cumulative. It never raises for service problems.
- Each dict has these keys:
  - `t_ms`
  - `acres`
  - `geometry` (shapely, lon/lat, simplified server-side to about 10 m)
  - `source` ("NIFC WFIGS daily perimeters" or "NIFC WFIGS current perimeter")
  - `category` ("Wildfire Daily/Final Fire Perimeter", or "")
  - `irwin_id`
  - `containment_ms`
  - `cause`
  - `name`
  - `t_field` (which timestamp rule fired)
  - `object_id`
  - `date_current_ms`
  - `discovery_ms`

## Catalog
- `get_catalog(mode, min_acres=None, refresh=False)` raises `calfire.CalFireError` only if CAL FIRE is down and nothing is cached.
- `get_summary(id)` → summary or None.
- `estimate_fire_bbox(summary)` → (w, s, e, n). It always returns a bbox, falling back to the acreage circle; then call `grid.make_aoi(lon, lat, bbox, mode)`.
- `live_detections_24h_total()` gives `LiveStatus.detections_24h_ca`.
- `clear_cache()`; ids use `slugify` and `make_incident_id` (e.g. `2025-eaton-fire-dbfa57`).
- For the live loop: `get_catalog('live', refresh=True)` and `firms.load_live_ca(7, refresh=True)`.

## Data quirks found (2026-10-16)

**CAL FIRE**
- Names have trailing spaces. Types include Wildfire, Fire, Flood and Hazmat. `ExtinguishedDate` may be "". `PercentContained` may be null.
- The yearly list (`inactive=true`) includes still-active fires.
- `Started` can be days off (Log Fire). The point can be far from IRWIN's origin (Timber: 45 km), but the perimeter contains the CAL FIRE point.

**FIRMS area API**
- `DAY_RANGE` counts days starting at the date (verified).
- Only SP responses have a `type` column.
- GOES: `instrument` is empty; `bright_ti4/5` = -999; scan/track are pixel indices; every row is marked "D".
- GOES `*FRP` rows are a second stream: integer confidence, real brightness, 3-decimal coordinates, times about 2 min later. They are not exact duplicates.
- Landsat has path/row columns and no frp, type, instrument or version.
- Type 2 rows include real fire pixels (49 of Eaton's 123 MODIS rows) and true static sources: the Scholl Canyon landfill flare about 3 km west of Eaton, which bbox clustering drops.
- About 5–9 transactions per request.

**Keyless feeds**
- 7-day feeds use "low/nominal/high"; MODIS satellites are "T"/"A"; the USA file also covers Canada and Mexico.
- 2025 yearly archive is SNPP + MODIS only.

**WFIGS**
- Polygon date is often stale: Palisades has one record dated Jan 8 holding 23,448 ac, edited Jan 21; moved to its edit time.
- Repeated edits share one polygon date: Gifford has 13 edits dated Aug 4 growing from 72k to 104k ac. Big changes become new perimeters at their edit time; small ones count as corrections.
- Local time was typed as UTC (Gifford, Madre). Polygons predating ignition, or out of order, move to their creation or edit time.
- Bulk-edit times are shared by many records (TCU: Sep 9 20:30) and are ignored.
- Backfilled records (Dias, created in 2026) keep their polygon date.
- Final perimeters and category-less records are re-dated by bulk loads (Eaton, Madre, Gifford finals dated 2026-05-12; Hughes July). They move to containment: the WFIGS containment, control or fire-out time, else CAL FIRE's containment, else the window end.
- Daily perimeters dated more than 7 days after containment are re-dated too (Silver).
- 0.1 ac placeholders (Jaw, Lidia) are dropped.
- Polygons can be mislabelled: Fay has Little Fire's polygon under Fay's IRWIN id. The oversize check drops it.
- One fire can have 2 IRWIN ids (Eaton).
- Names collide across years and states: Gifford 2020/2021/2023 sit at the same spot (separated by discovery time); Gifford and Palisades also appear in WA and NV.
- The current layer has 7 California fires.
- No `poly_GISAcres` → geodesic area is used.

## observed

### Summary

On the user's question: this observed-role agent ran to completion. Its earlier run was the one stopped by the usage limit, and this run is not still going. The role is finished and every check below passes.

`build_observed(ctx)` (SPEC 8.3) is implemented in `backend/fire3d/build/observed.py`, with a dev runner (`python -m fire3d.build.observed <id> --quicklook DIR`). It writes `detections.json`, `perimeters.json`, `timeseries.json` (including `frp_mw_per_h`), `events.json`, the `observed_arrival` layer, and the manifest's `ignition`, `default_profile_path`, `time_range`, `stats`, `data_sources` and `warnings`. It also sets `ctx.end_ms` and `ctx.now_ms`.

**Detections.** Detections are quality-filtered, then two screens remove what isn't this fire:
- Static sources: hot spots seen on 2+ days in the week before ignition. This costs ~4 extra FIRMS requests per build.
- Other fires: space-time clustering (1.5 km, 2 days) seeded at the ignition point and on the perimeters.

GOES is used only for timing:
- the ignition time;
- a fire radiative power (FRP) curve that warps time inside each interval between snapshots, so growth happens when the fire was active;
- the hourly FRP series.

GOES never enters the spatial mask.

**Burned area.** When a perimeter covers at least 75% of the CAL FIRE acres, the final burned area is that perimeter. Otherwise it comes from the VIIRS/Landsat footprint union with its edge eroded by 1/3 of a pixel. Without a perimeter that union is calibrated to the CAL FIRE acres, but only when that figure is final or newer than the detections.

**Arrival times.** Arrival times are interpolated between snapshots by the distance-ratio rule. Several cleanup steps then keep the fronts smooth and free of speckle. Perimeters dated after the fire stopped growing set the final extent only, so late-dated perimeters can't create late "pops".

**Results** (all five bundles validate strictly against the contracts):

| Fire | Mode | Observed / official acres | Ratio | Snapshots | Events* |
|---|---|---|---|---|---|
| Eaton | historical | 14,115 / 14,021 | 1.007 | 19 | 8 |
| Madre | historical | 81,938 / 80,779 | 1.014 | 30 | 8 |
| Palisades | historical | 23,457 / 23,448 | 1.000 | 31 | 6 |
| Henderson | live | 2,084 / 2,079 | 1.003 | 6 | 5 |
| Norte | live | 461 / 465 | 0.992 | 3 | 3 |

*Before the pipeline adds `peak_wind`; at most 11 here, so at most 12 in total.

Ignition is at the right place and time. Eaton's start is confirmed by GOES-18 12 minutes after the CAL FIRE time; Palisades moves to 10 minutes before the first persistent GOES-18 detection.

**Main weakness.** In the first hours of intense fires the reconstructed area runs ahead of reported figures, because VIIRS flags pixels around very hot small fires. Palisades shows about 2,300 ac at 1 PM PST against roughly 800 reported. The final area is right.

I looked at the quick-looks after every iteration. The isochrones went from blocky and fragmented to smooth crescents that follow the real runs: Eaton south-west on the first night, Madre to the east, and Palisades west and then north-east.

### Contract deviations

- **Final burned area with a perimeter.** SPEC 8.3 step 3 says perimeter ∪ footprints within 300 m. When the perimeter covers at least 75% of the CAL FIRE acres, I use the perimeter alone. The 300 m rim inflated Eaton to 1.22x. Detections still extend the area after the latest perimeter (live), or fill in when the perimeter is incomplete.
- **How footprints shrink.** Footprint size comes from FIRMS scan × track in km, not 375 m × scan. "Shrunk by 1/3" is done as the union of full footprints with its edge eroded by (1 − shrink) × half the pixel. Shrinking each footprint and then closing was non-monotone and left gaps. MODIS uses a stronger shrink (0.4) and only defines burned area within 1.5 km of a VIIRS/Landsat detection.
- **Snapshot masks shrink harder than the final area** (0.45 vs 2/3). Early unions over intense fires were about 4x too large; this brought the synthetic timing bias from −1.0 h to about 0.
- **Extra cleanup of the arrival field beyond the SPEC rule.** Cones join detached areas: always for the first snapshot, within 1 km later. Areas under 10 ha are deferred. Perimeter-only and enclosed late pixels are re-timed from their neighbours. Then a masked median, sink filling (an island keeps its own early time only if it burned more than 12 h before its surroundings) and a bilateral filter are applied. Each snapshot is still burned by its own time; times inside an interval may be earlier than the previous snapshot.
- **Perimeters used for timing.** Perimeters dated more than 24 h after detections reached 97% of their area set the final extent only. In `perimeters.json`, perimeters later than `end_ms` are clamped to `end_ms`, with "(final extent, mapped YYYY-MM-DD)" added to the source.
- **Historical end and mop-up.** Overpass groups more than 24 h after growth ended are mop-up and don't define snapshots. `end_ms` follows the SPEC (t99 + 24 h, capped at start + 45 d), except it is extended to containment + 1 h when containment falls at most 72 h after that end.
- **Live `now_ms` and `end_ms`.** Both equal the latest observation from VIIRS/MODIS/Landsat or a perimeter, not GOES. This way `pipeline.has_new_detections` triggers a refresh on the next VIIRS pass. GOES rows after `now_ms` are left out.
- **Ignition time.** It moves earlier only for the first *persistent* GOES detection (3 within 1 h, within 5 km; time minus 10 min) or a polar detection within 3 km (minus 30 min). It is never before `time_origin_ms` and always before the first snapshot.
- **Ridge-crossing elevation source.** In order: `sim/static.npz`, then the render-grid elevation layer (area-averaged to the fire grid), then `terrain.fetch_dem(fire_grid)`. If none works, ridge events are skipped with a warning.
- **Extra event types.** `wind_shift` is inferred from the observed spread direction (a 75°+ change between coherent 6 h windows), confidence "estimated", and says it was inferred; weather is not available when this module runs. Up to 2 `perimeter_update` events are added. At most 11 events in total, so `peak_wind` from the pipeline brings it to 12.
- **Manifest entries owned by this module.** `data_sources` named "NASA FIRMS active fire detections" and "NIFC WFIGS fire perimeters", and warnings prefixed "Observations: ". They are replaced on every run, so live refreshes don't duplicate them.
- **Extra functions.** `build_observed_stats(ctx)` returns a diagnostics dict; `build_observed(ctx)` still returns None. `detections_per_h` counts every detection in `detections.json`, including thinned GOES.

### Known issues

- VIIRS bloat over intense young fires makes the first hours run ahead of reported growth. The final area is right. Examples: Palisades about 2,300 ac at 21:00Z against roughly 800 reported; Madre 12.8k ac at 22:49Z while its first perimeter is 8.4k at 23:11Z.
- The rate-of-spread series (90th percentile of 1/|∇T|) is clamped at 300 ch/h. Madre hits the clamp in 4 of 59 active hours and Henderson in 3 of 22. Typical medians are 12–39 ch/h.
- Patchy mountain burning, such as the Palisades north-east and Madre south-east, keeps early islands that burned more than 12 h before their surroundings. This is deliberate, since they are observed, but those areas look mottled rather than like one front.
- The spot-fire rule is conservative (VIIRS/Landsat only, more than 750 m beyond the earlier burned area closed by 1 km, still disconnected). The one spot each on Eaton, Madre and Palisades is plausible but unverified.
- GOES intermediate spatial snapshots (optional in the SPEC) are not implemented; GOES is used through FRP time-warping instead.
- Without the key, the pre-fire static screen relies on the keyless SNPP yearly archive or 7-day feeds. Static hot spots within 2 km of the ignition point are never screened; clustering and the perimeter still limit them.
- A CAL FIRE start that is days late (Log Fire) cannot be fixed: the timeline starts at `time_origin_ms`, so earlier burning is clamped to the timeline start.
- The live fires were run with the dev runner on 2026-10-16/17 data. `now_ms` is the latest VIIRS pass (Oct 16 21:48Z), not the wall clock.

### Notes for integrator

**Call order.** Call `build_observed(ctx)` after `build_static_layers` (pipeline.py already does). It reads fire-grid elevation from `sim/static.npz` for ridge crossings and never fetches it again in that case. It sets `ctx.end_ms` and `ctx.now_ms` and writes `time_range`; `pipeline._build_locked` re-reads that afterwards, which works.

**Network use.**
- FIRMS: one `firms.detections_for` over the AOI bbox, plus one small pre-fire call (VIIRS SNPP+NOAA20, the week before ignition).
- WFIGS: one `perimeters.fetch_perimeters` with the same arguments as `catalog.estimate_fire_bbox`, so it hits the cache.
- Neither raises for network problems; gaps become manifest warnings.
- When cached a build takes about 2–3 s. Uncached it is dominated by FIRMS GOES (Eaton 131 s, Madre 348 s).

**Live refresh** (`pipeline.refresh_live`) can call `build_observed` repeatedly: its manifest entries are replaced, never duplicated. `peak_wind` is still added by `pipeline.add_peak_wind_event`, which places it at the burning pixels with id `ev-peak-wind`.

**For the frontend.**
- Live `now_ms` is the latest VIIRS/MODIS/Landsat/perimeter time; the forecast starts from it.
- `perimeters.json` times never exceed `end_ms`. Late finals are clamped and labelled "final extent".
- `detections.json` holds only this fire's detections, with GOES thinned to one per 10 min per 2 km cell.
- `observed_arrival` is float32 hours since origin, NEVER = 1e6. It is never earlier than the ignition time, and the ignition pixel equals it exactly.

**Dev runner.** `cd backend && FIRE3D_DATA_DIR=<dir> uv run python -m fire3d.build.observed <incident-id|name> --quicklook <dir>`. It prints a JSON of diagnostics and contract problems and writes 3 PNGs per fire.

**Suggestions for other modules.**
- The scene could show `events.json` confidence ("probable" spots, "estimated" ridge/wind_shift).
- The rate-of-spread chart could show its 300 ch/h clamp.
- `docs/validation.md` could quote the synthetic timing check: median absolute error 1.3 h.

### Screenshots

data/dev/observed/quicklook/2025-eaton-fire-dbfa57-arrival.png, data/dev/observed/quicklook/2025-eaton-fire-dbfa57-fronts.png, data/dev/observed/quicklook/2025-eaton-fire-dbfa57-series.png, data/dev/observed/quicklook/2025-madre-fire-01e7e8-arrival.png, data/dev/observed/quicklook/2025-madre-fire-01e7e8-fronts.png, data/dev/observed/quicklook/2025-madre-fire-01e7e8-series.png, data/dev/observed/quicklook/2025-palisades-fire-abfed7-arrival.png, data/dev/observed/quicklook/2025-palisades-fire-abfed7-fronts.png, data/dev/observed/quicklook/2025-palisades-fire-abfed7-series.png, data/dev/observed/quicklook/2026-henderson-fire-3e3dfe-arrival.png, data/dev/observed/quicklook/2026-henderson-fire-3e3dfe-fronts.png, data/dev/observed/quicklook/2026-henderson-fire-3e3dfe-series.png, data/dev/observed/quicklook/2026-norte-fire-87ebb8-arrival.png, data/dev/observed/quicklook/2026-norte-fire-87ebb8-fronts.png, data/dev/observed/quicklook/2026-norte-fire-87ebb8-series.png, data/dev/observed/quicklook/synthetic-arrival.png, data/dev/observed/quicklook/synthetic-fronts.png, data/dev/observed/quicklook/synthetic-series.png

## weather

### Summary

The weather role is finished. Weather data comes from Open-Meteo through a pluggable WeatherSource interface. Each bundle gets a weather.json with hourly weather, fuel moisture and FFWI at the fire. Forecast members are built for the spread engine, and all of it is checked against real data for Eaton (Jan 2025) and the live Henderson Fire.

The interrupted run's sources/weather.py turned out to be complete. I checked it against the SPEC and against fresh live probes, and fixed one real problem: which API serves which dates. The forecast API accepts dates 92 days back, but it returns HRRR only for the last ~31 days. The historical-forecast API has HRRR right up to today. So anything older than 21 days now comes from the historical-forecast API (FORECAST_PAST_DAYS changed from 88 to 21). Its response shapes, the multi-location request, unixtime/m-per-second units, chunks of at most 31 days, the ERA5 fallback, the ensemble member keys and the cache TTLs (30 min live, 30 days archived) all match what the endpoints actually return.

spread/moisture.py was correct and is unchanged:
- equilibrium moisture from the Simard (1968) formulas (80°F / 20 % RH gives 4.25 %);
- 1-h fuel = 1.03 × that value, 10-h and 100-h lag it with time constants of 10 h and 100 h, warmed up over the 72 h before the start;
- live fuel moisture comes from the monthly table in config.py, and FFWI uses the Fosberg formula.

build/weather_bundle.py was an empty stub and is now fully written:
- **build_weather(ctx):** writes weather.json for the windows in the spec (historical: start − 72 h to end + 72 h; live: max(start, now − 7 d) − 72 h to now + 96 h). The at-fire values are interpolated from the 4×4 grid at the ignition point, or the AOI centre if there is none. It also writes the u/v wind grid, sets forecast_from_ms, reports progress under "weather", and records a "Weather" data source and any warnings in the manifest (replaced, not duplicated, on rebuild). It also saves a backend-only file, sim/weather.npz.
- **member_weathers(...):**
  - gfs025 / ecmwf_ifs025: real ensemble members, shifted onto HRRR while HRRR exists, then eased back to the raw members over 6 h.
  - Perturbed: 31 members by default, varied smoothly over time (8 h correlation) in wind speed, direction, RH and temperature; reproducible seeds; member 0 is unperturbed.
  - None: one member.
  - All kinds: fuel moisture recomputed per member after a 72 h warm-up. Output is hourly from the start hour through start + horizon, with wind in km/h and RH kept within 1–100 %.
  - If a real ensemble isn't available (any 2025 date, a failed fetch, or the synthetic fixtures), it falls back to perturbed members and adds a warning.

I added 47 offline tests in three files (1.4 s). The full backend suite is 102 passed. The real-data numbers are under Verification.

### Contract deviations

- New backend-only bundle file sim/weather.npz (holds the full deterministic 4×4 weather, the hours HRRR covers, and where it came from). It is not registered in manifest.layers. member_weathers reads it; if it is missing, as in the fixtures, it falls back to weather.json: wind from the u/v grid, and temperature, RH and rain from the at-fire series spread evenly over the grid.
- build_weather(ctx, source=None) and member_weathers(..., *, source=None) take an optional source (any WeatherSource). This is where a future WeatherNext3Source would plug in; it is noted in the docstrings and not implemented.
- member_weathers returns a MemberList: an ordinary list of MemberWeather that also carries .source, .ensemble (the kind actually used after any fallback) and .warnings. It also accepts ensemble="auto" (live → gfs025, historical → perturbed). When gfs025 / ecmwf_ifs025 aren't available (2025 dates, a failed fetch, the synthetic fixtures) it falls back to perturbed members with a warning instead of raising an error.
- spread/moisture.dead_fuel_moisture has an extra optional precip_mm argument. Hours with at least 0.25 mm/h of rain raise the 1-h fuel and the 10-h/100-h targets to 35 % (the NFDRS wet-fuel convention). All outputs are floored at 2 %. Both weather.json and the members use it.
- Perturbed members: the speed factor is exp(0.25·z), a lognormal with median 1, so the median member keeps the deterministic speed. Perturbations are the same over the whole 4×4 grid. Seeds are default_rng([842025, k]). Member labels are perturbed-00…30, "deterministic" for none, and control / member01… for the real ensembles.
- On the live forecast API, OpenMeteoSource uses start_date/end_date instead of the spec example's past_days/forecast_days (verified to work), so any window can be requested. Dates older than 21 days use the historical-forecast API (see summary). The deterministic result dict also carries extra keys: hrrr (hours with HRRR), fetched_ms, warnings, era5.
- Manifest bookkeeping: build_weather adds warnings prefixed "Weather: " and replaces the previous ones on every rebuild. It keeps exactly one data_sources entry named "Weather".

### Known issues

- Open-Meteo free tier is 10,000 calls a day. Its docs say the number of locations, variables and models all count toward each request's weight, but give no exact rule for ensembles. Each live gfs025 or ecmwf_ifs025 forecast makes one 16-location request with 155 or 255 member series, plus a fresh deterministic fetch (cached 30 min). The live refresh loop should not re-run ensemble forecasts more often than needed; the ensemble models only update every 6 h.
- At the Eaton ignition point HRRR gives NNE wind (median 20°) rather than the expected 30–80°. Over the whole grid the median is 27°, and the ridge cells show 31–48° (NE). This looks like HRRR's 3 km model channeling the flow down the north–south Eaton Canyon, not a direction mix-up: a FROM/TO swap would read about 200°.
- The spec's additive RH perturbation (N(0, 6 %)) hits the 1 % clamp when the deterministic RH is in single digits; for Eaton the perturbed p10 RH is 1 % at +24 h. 1-h fuel moisture is already at its 2 % floor there, so the effect on spread is small.
- The deterministic series switches straight from HRRR to GFS where HRRR ends (about +44 h in live mode). gfs_seamless equals HRRR in the overlap, so there is no offset to blend across the switch. On Henderson the measured change was within normal hourly variation. The ensemble members are blended over 6 h as the spec requires.
- build_weather rewrites weather.json from scratch, which drops the flame_length_ft and ros_ch_per_h_potential fields that spread/behavior.py adds. annotate_weather_with_behavior must run after every build_weather, including during refresh_live.
- For bundles that only have weather.json (the fixtures), member temperature and RH are the same in every grid cell, because weather.json stores them only at the fire. Wind still varies across the grid.
- As the role specifies, the at-fire series is at the ignition point (or the AOI centre), not at the current fire front.

### Notes for integrator

**Pipeline (api agent):** run build_observed → build_weather(ctx) → spread.behavior.annotate_weather_with_behavior → add the peak_wind event.
- build_weather reads the manifest's time_range and ignition, and works without them (falls back to ctx.time_origin_ms and the CAL FIRE dates).
- If no weather can be fetched at all, it raises WeatherError or the provider's own exception. Catch it and add a manifest warning if the build should continue.
- On refresh_live, call build_weather again, then annotate again. Rebuilding is idempotent for data_sources and warnings.

**Spread agent:** `ml = member_weathers(bundle_dir, start_ms, horizon_h, ensemble, members)`.
- For ForecastManifest.weather and warnings, use `getattr(ml, 'ensemble', ensemble)`, `ml.source` and `ml.warnings`. ml.ensemble can differ from the request after a fallback (for example gfs025 → perturbed for any 2025 incident).
- MemberWeather.t_ms starts at the start hour (floor) and runs hourly through start + horizon (rounded up). That fits engine.weather_bases, whose time origin is t_ms[0] − 30 min.
- Fields are (T, 4, 4), indexed [time][row north→south][column west→east]. Wind is in km/h with direction FROM, in degrees clockwise from north. Moistures are fractions. Live herb/woody moisture comes from the Los Angeles-local month of the start; foliar moisture is 1.0. Members pickle cleanly for a process pool.
- Network use: historical members reuse sim/weather.npz and need no network. Live members re-fetch HRRR (30-min cache) to shift the ensemble onto it. Fixture bundles never touch the network.

**Test helpers for other agents:** tests/test_weather_bundle.py has a FakeSource that implements the WeatherSource protocol; tests/test_weather_source.py has a FakeOpenMeteo that mocks all four Open-Meteo endpoints.

**Dev bundles** (weather only, minimal manifests): data/dev/weather/incidents/2025-eaton-fire-dbfa57 and 2026-henderson-fire-3e3dfe. The scripts that reproduce the real runs are in /tmp/fire3d_weather (outside the repo): `real_run.py eaton|live` and `probe.py`.

**User question:** the relayed user message asked whether the agents were still running. This weather agent ran to completion and was not stalled; its real-data runs made the live Open-Meteo calls, which may account for some of the API usage the user saw.

## spread

### Summary

The spread role is finished and tested: the engine, ensemble forecast, fire behaviour and hindcast validation (SPEC 7.3 / 8.5). I kept engine.py from the interrupted run after checking it against the pyretechnics source, and wrote the rest from scratch. All 47 spread tests pass in about 5 s, and the full backend suite passes (361 tests in 14.9 s).

**Engine (engine.py).** Forecasts use pyretechnics exactly as documented:
- Input rasters are flipped north-up, because pyretechnics counts rows from the south. This is confirmed by its source and by the docs plotting everything with `origin="lower"`.
- Fuel codes that pyretechnics doesn't know (nodata 0, 94–97, …) are turned into non-burnable 99; otherwise the model would read uninitialised memory.
- Crown fire is switched off cell by cell where there is no canopy fuel.
- Each member's 4×4 weather grid is smoothly refined (up to 32×32) and filled forward/backward in time where data are missing.
- Long runs can be split into chunks with a wall-clock check between them. On resume, the cell size is not passed again: at cell sizes like 8000/272 m, pyretechnics' stored value no longer matches and it raises an error (I reproduced this).

**Ensemble (ensemble.py).**
- Members run in parallel processes, `min(10, cpu - 2)` of them. If no process pool can be started (e.g. inside a daemon process), the members run one after another, with a warning.
- p10/p50/p90 use the rank-based definition the SPEC requires, so "burned by t with ≥ K% probability" exactly matches "arrival_pK ≤ t".
- It writes burn probability, median flame length, and hourly area and spread-rate quantiles, plus skill scores when observations cover the lead time.
- It writes `forecasts/<run_id>/` and keeps the manifest entry going from running to ready or error.
- If members run too slowly, it switches to a 2× coarser grid and records a warning.
- If the weather agent's `member_weathers` fails, it builds members from `weather.json` instead and records a warning.

**Behaviour (behavior.py).**
- `surface_behavior` computes the potential head-fire spread rate and flame length.
- `annotate_weather_with_behavior` follows the observed fire front hour by hour and uses the dominant burnable fuel within 2 km of it.

**Validation (validate.py).** It provides Sørensen scoring, `hindcast_skill`, and `batch_hindcast` with a summary table and markdown output. A CLI offers `hindcast` (batch calibration) and `bench` (timing).

**Real-data trials.** I merged the terrain and weather agents' bundles in `data/dev/spread`.
- **Eaton 2025:** 31 perturbed members ran in 31 s. The median area was 3,677 ac at +24 h, against about 10,600 ac in published Eaton figures (not a bundle measurement). That under-prediction is expected: 35% of the area is coded urban (non-burnable) in LANDFIRE, and spotting is off.
- **Henderson (live):** a real 31-member GFS ensemble, bias-corrected to HRRR, ran in 110 s.

There is still no observed spread data for any real fire, so both trials started from the CAL FIRE ignition point.

### Contract deviations

- Weather cubes: SPEC 8.5's guidance says a (T,4,4) weather grid; I refine it smoothly to (T,W,W) with W dividing M and at most 32 (wind interpolated through its east/north components). This avoids 4 km wind blocks with jumps at their edges. Hourly bands are centred on each weather hour (cube origin = first hour − 30 min).
- run_forecast keeps the SPEC signature and adds optional keyword-only arguments: settings (SpreadSettings), workers and budget_s. A failure after the run entry exists marks the entry and forecast.json 'error' and raises ForecastError; a failure during setup (missing static.npz, bad start or horizon, no weather) raises before any manifest entry is written.
- Error runs write a contract-valid forecast.json: status 'error', the error message, empty series, and layer entries pointing to files that were never written.
- Skill is computed whenever some lead time falls inside the observed data range: historical end_ms, or live now_ms. A live forecast starting now therefore has no skill, but a live hindcast does.
- Pixels already burned at the start get arrival = start (no arrival before the start, as the role requires). The scaffold's fixture forecast fx-001 kept the observed arrival times there instead.
- Area and spread-rate series use the same rank-based percentile as the maps (rank ceil(K·N/100)), not interpolated percentiles. Front spread rate per member is the 90th percentile of the spread rate of cells burning in that hour, converted to chains/h; the median across members is reported. Hour 0 repeats hour 1's value.
- Ignition fallback when nothing has burned yet: the ignition cell is moved to the nearest burnable cell within 1.5 km if needed and ignites at max(start, ignition time). If start is after the ignition but nothing is observed, it ignites at start, with a warning.
- "running" forecast entries older than 1 h are marked 'error' at the next run, as leftovers from a process that died.
- A one-line timing summary is added to the forecast warnings, as SPEC 8.5 asks (runtime_s/warnings).
- surface_behavior adds optional keyword-only arguments (canopy_cover, canopy_height_m, spread_adjustment, surface_lw_ratio_model) and extra return keys (fuel_code, burnable, fire_type). It always computes a surface head fire with the wind blowing straight upslope.
- hindcast_skill uses the signature the scaffold proposed: (forecast_dir, observed_arrival, time_origin_ms=None, lead_hours=(12,24,48,72), data_end_ms=None). batch_hindcast takes extra keywords (ensemble='none', members, horizon_h, lead_hours, workers, progress) and its rows add sorensen_growth, observed_growth_acres, forecast_growth_acres and area_ratio.
- Weather fallback: if member_weathers raises, members are built from weather.json (one deterministic member, or the SPEC 8.4 AR(1) perturbed set) and weather.source gets '(fallback)'. When member_weathers succeeds, its MemberList .ensemble/.source/.warnings are used as given.
- Spotting parameters (used only when spotting=True) are the spot_config example from the pyretechnics documentation. The interrupted run's comment claimed this, but its values didn't match.
- docs/validation.md was not written: it isn't in my file list, and no real observed bundles exist yet. `python -m fire3d.spread.validate hindcast … --out docs/validation.md` generates it.

### Known issues

- No real bundle has an observed_arrival layer yet (build/observed.py is still a stub). The real-data trials therefore ignite only the CAL FIRE ignition cell, and neither real-fire skill nor spread_adjustment calibration could be measured.
- Eaton under-predicts (median 3,677 ac at +24 h against about 10,600 ac observed): 35% of the area is coded urban (91, non-burnable) in LANDFIRE, and spotting is off by SPEC. Urban fires spread through structures and embers, which this model setup cannot represent.
- Without observed data, a live forecast from now starts from a single cell at now, even if the fire is many hours old.
- Members that reach the edge of the area of interest are reported in a warning; spread beyond the edge is not simulated, so burn probability near the edges is underestimated. This happened in the Henderson and fixture runs.
- Members run about 2–3× slower in parallel than alone (6 performance + 6 efficiency cores). The downsample fallback only triggers if a member exceeds budget/rounds (60 s for 31 members on 10 workers); in every run I measured it would not have.
- When the time budget is armed, members run in 12 h chunks, which changes arrival times very slightly compared with a single call (mean about 0.1–0.5 min). run_member always makes a single call.
- Scripts that call run_forecast directly need an `if __name__ == "__main__":` guard, because the worker processes re-import the main module. Without it, the error now surfaces as a crashed pool instead of a silent serial rerun. The CLI, the API and pytest are fine.
- The 10th/50th/90th percentile area series is not the same number as the area of the p50 map (different statistics). For example, a single fast member out of 10 shows in arrival_p10 but not in area_acres_p90.

### Notes for integrator

**Running it**
- Forecast: `cd backend && uv run python -m fire3d.cli forecast <id> [--start ISO] [--horizon 72] [--ensemble auto]`.
- Calibration: `uv run python -m fire3d.spread.validate hindcast <id1> <id2> [--offsets 24 48] [--adjustments 0.5 0.75 1 1.5 2] [--ensemble none] --out ../docs/validation.md --json rows.json`. Run this once 2–3 historical bundles have observed_arrival, and use summarize_hindcast's 'best' (highest mean growth-only Sørensen) to set SpreadSettings.spread_adjustment.
- Timing: `uv run python -m fire3d.spread.validate bench <id> --sizes 256 384 512`.
- Environment variables: FIRE3D_FORECAST_WORKERS (default min(10, cpu−2)) and FIRE3D_FORECAST_BUDGET_S (default 240; 0 disables the downsample fallback).

**For the api agent**
- Progress step names are `weather`, `spread`, `spread-coarse` (only after a fallback), `aggregate` and `write`. These match jobs.py's FORECAST_STEP_WEIGHTS.
- run_forecast starts 10 worker processes per run; inside a daemon process it runs members one after another with a warning.
- It only takes bundle/.manifest.lock (re-entrant) through bundle.update_manifest, so pipeline's shared .build.lock can't deadlock with it.
- annotate_weather_with_behavior never raises for missing inputs: it logs and leaves weather.json unchanged.

**For the weather agent**
- Your member_weathers MemberList (.ensemble/.source/.warnings) is used as-is; its warnings appear in forecast warnings prefixed 'weather: '.

**For scene and UI agents**
- Real merged bundles with genuine pyretechnics forecasts are in `data/dev/spread/incidents/` (2025-eaton-fire-dbfa57, 2026-henderson-fire-3e3dfe). They have no observed_arrival, detections or timeseries, and their manifests are partial (no time-series files).
- Quick-look images: `data/dev/spread/quicklook-eaton.png` and `data/dev/spread/quicklook-henderson.png`.
- Fixture report: `data/dev/spread/validation-fixture.md`.

**Bug avoided:** re-passing the cell-size tuple to spread_fire_with_phi_field on a resumed SpreadState raises "The cube_resolution does not match" whenever the cell size isn't exactly representable in float32 (e.g. the api agent's Lidia bundle, M=272, 29.41 m). engine.simulate passes None after the first chunk.

### Screenshots

data/dev/spread/quicklook-eaton.png, data/dev/spread/quicklook-henderson.png

## api

### Summary

The api role is complete and tested. All 367 backend tests pass, 95 of them mine. A real-data smoke test on port 8010 exercised every SPEC 6 endpoint.

One gap: `build/observed.py` is still the stub, and the observed agent had not started during my run. So a fully real build has not been run end to end. It is the one thing left to check once observed lands.

What was built:
- **`build/pipeline.py`**: `build_incident` runs the SPEC sequence: catalog → fire bbox → AOI → initial manifest → static layers → observed → weather → peak_wind event → behaviour annotation → the live forecast → ready. Progress is weighted across the 10 SPEC stages and never goes backwards. If a required step fails, the manifest becomes "error" with a masked message and the exception is re-raised. If peak_wind, behaviour or the live forecast fails, the bundle is still marked ready with a warning.
  - An fcntl lock serialises builds, refreshes and forecasts across processes, and tells a running build from a stale "building" manifest left by a killed process.
  - Only real CAL FIRE ids can be built or refreshed. `catalog.get_summary` also answers from manifests on disk, so without this guard a forced build would wipe the fixtures.
  - `refresh_live` re-runs observed and weather for a live bundle when FIRMS has detections newer than its `now_ms`.
- **`api/jobs.py`**: a job manager with a build pool of 2 daemon threads (also used for refresh jobs) and a forecast pool of 1. A second request for the same job kind and incident returns the existing job. Errors are short and masked; full tracebacks go to the log, also masked.
- **`api/app.py`**: every SPEC 6 route.
  - Bundle files are served gzipped with an ETag (304 on match) and `Cache-Control: no-cache`; traversal attempts and dotfiles return 404.
  - Aircraft responses are cached 10 s per incident; if adsb.lol fails, the last good list is served for up to 2 min with a note.
  - Unhandled errors return a masked 500, logs mask secrets in tracebacks too, and CORS is limited to localhost.
  - The live loop starts on startup when FIRE3D_LIVE=1.
- **`api/live.py`**: the SPEC 8.7 loop every 15 min. It refreshes bundles with new detections, re-forecasts when the last forecast is over 3 h old or the area changed by more than 2 %, and auto-builds up to 4 active live fires one at a time.
- **`sources/aircraft.py`** plus the config AIRCRAFT CLASSIFICATION section: adsb.lol fetching with a request budget and a cooldown after HTTP 429. Classification follows SPEC 8.6 using researched type designators, fleet registrations and callsigns. Positions are converted to local x/z, altitude to metres above sea level, and height above ground comes from the DEM inside the AOI.
- **`cli.py`**: catalog, build (id or fuzzy name), forecast, hindcast (prints skill), and serve (default 8710, `--live/--no-live`).
- **`dev.sh`**: adds `--no-live` and refuses port 8000.

Real-data findings:
- Fixed a mismatch with the terrain module, which treats `ctx.now_ms` as the current time: the first real build got no burn-severity layer, and the second produced it.
- With only `build_observed` replaced at runtime by a throwaway script outside the repo, a historical build (Lidia Fire) reached "ready" in 51 s using the real terrain, weather and behaviour modules. The manifest passed the strict contract check with 0 problems.
- Real forecast jobs (pyretechnics) also ran through the API.

### Contract deviations

- build_incident's progress callback gets the OVERALL build fraction (0..1) with step = the SPEC stage name. Inside the build, each module's own (step, fraction-within-step) reports are mapped onto those stages.
- build_incident without force returns an already-ready bundle untouched. Ids that fail the SPEC 4.4 check (bundle-only ones such as the fixtures) raise LookupError and are never rebuilt. The API answers 409 for a forced build of such an id.
- refresh_live(incident_id, progress=None, *, detections=None, force=False) -> bool. The extra keyword arguments are optional, so the SPEC call still works.
- Optional steps degrade instead of failing the bundle: peak_wind, the behaviour annotation and the live forecast inside a build only add warnings. Required steps (catalog, static, observed, weather) mark the bundle 'error' and re-raise.
- BuildContext before build_observed runs: end_ms is a best guess (contained_ms, else updated_ms, else start + 14 d, capped at 45 d). now_ms is the wall clock for live and None for historical, because the terrain module clips imagery windows to ctx.now_ms. After observed, both come from time_range.
- Forecast jobs (API and live loop) pass start_ms=None when the request omits it, so spread.ensemble.run_forecast applies the SPEC 6 defaults in one place. Explicit start_ms values outside time_range give 422. horizon_h is limited to 1..240 and members to 1..101.
- Detail response: a non-ready manifest gets placeholder values (time_range, stats, built_ms 0, …) for any missing keys, so it keeps the IncidentManifest shape. A 'building' manifest with no live build lock or job is reported as 'error' with an 'interrupted' warning.
- bundle_status in the incident list and detail is overlaid from this server's running jobs and the build lock, not taken as-is from the catalog.
- Incident list: if the catalog raises, the bundles on disk for that mode are listed instead.
- Aircraft fields:
- alt_m is metres above mean sea level: alt_geom corrected with geoid undulation −33 m, else alt_baro corrected with nav_qnh.
- On-ground aircraft get agl_m = 0.
- seen_s prefers seen_pos.
- The adsb.lol query is centred on the AOI centre when a bundle exists, else on the CAL FIRE point.
- An empty list carries an explanatory note.
- SPEC 8.6 proximity rule is slightly stricter: an aircraft must also be within 5 km of the burned area when that is known (AIRCRAFT_NEAR_FIRE_M). It must be airborne and not a surface-vehicle category (C*). Shared types (C130, H60, PC12, BE20, …) need a fleet registration, a fire callsign or low & slow flight over the fire.
- JobManager API: submit(kind, incident_id, fn, progress_mode='steps'|'overall', weights=None), get, active_for, latest_for, list, wait, drain, shutdown; plus get_manager / set_manager / shutdown_manager. Job ids look like 'job-0001-xxxxxxxx'. A forecast job's result carries run_id. Refresh jobs use the build pool.
- live.live_refresh_loop(jobs=None, interval_s=None). It also refreshes a ready live bundle that is more than 3 h old even without new detections, to pick up new HRRR forecasts. detections_24h_ca uses catalog.live_detections_24h_total() when it exists, so the number is the same with or without the loop.
- CORS allows localhost / 127.0.0.1 origins only. The Vite proxy makes requests same-origin, so the frontend is unaffected.

### Known issues

- build/observed.py is still the stub; the observed agent had not started during my run. A fully real build has therefore not run end to end. Every other stage was verified with real modules using a runtime stand-in for build_observed only.
- No firefighting aircraft were airborne during the live smoke test (20:10 PDT). Real-data classification was checked on 51 non-fire aircraft (all correctly rejected) and on crafted samples built from real adsb.lol field formats.
- News or police helicopters flying low and slow over a fire are classified as fire aircraft. The reason text states this inference ('low & slow over fire' or a shared type).
- With FIRE3D_LIVE=1 (the default), every API start, including each `uvicorn --reload` restart via dev.sh, runs the auto-build. Bundles that are already ready are skipped, but builds still in progress are killed by the reload (daemon threads), restarted by the next auto-build, and reported as 'error / interrupted' in the meantime. Use `./dev.sh --no-live` or FIRE3D_AUTO_BUILD_LIVE=0 for quiet development.
- dev.sh was only checked for syntax, help and argument guards. I have no assigned web port, so a full run starting Vite was not done; the process-group logic is unchanged from the scaffold's tested version.
- The installed Starlette emits a deprecation warning for using httpx in its TestClient (it suggests httpx2). It is silenced at import in tests/test_api.py; no dependency changes were made.
- A forced rebuild deletes the bundle's previous forecasts (they belong to the old grid and time origin).

### Notes for integrator

Running it:
- `cd backend && uv run python -m fire3d.cli serve` (port 8710, `--no-live` to disable the live loop).
- Or `./dev.sh`; `./dev.sh --no-live` for quiet development.
- With FIRE3D_LIVE=1 the API refreshes every 15 min and, if FIRE3D_AUTO_BUILD_LIVE=1, auto-builds up to 4 active live fires (≥100 ac, detections in the last 48 h) one at a time. Right now that would build Norte and Henderson (and anything else that qualifies), which needs observed.py first.

Once observed.py lands, re-run a real build:
- `FIRE3D_DATA_DIR=... uv run python -m fire3d.cli build lidia --force` (small, quick).
- Then a live one: `build henderson`, which also runs the 31-member gfs025 forecast inside the build.
- The HTTP cache already holds the Lidia DEM, LANDFIRE and NAIP downloads.

Interfaces other agents should know:
- `catalog.get_summary` also answers from bundle manifests. The pipeline therefore checks the SPEC 4.4 id (`pipeline.is_catalog_incident`) before building or refreshing, and the API answers 409 for forced builds of fixtures.
- The terrain module (aoi.dnbr_windows) treats ctx.now_ms as the current time. The pipeline leaves it unset (historical) or sets the wall clock (live) until build_observed sets time_range.
- The spread module's run ids look like 'fc-20250815T2126-perturbed-cc74', not fx-NNN. Its step names (weather/spread/aggregate/write) are mapped by FORECAST_STEP_WEIGHTS in api/jobs.py.
- Frontend: jobs follow the JobStatus contract. A forecast job's result.run_id names the new run. Refresh jobs (kind 'refresh') show up in detail.job while a live bundle refreshes; built_ms changes afterwards. The aircraft response's `note` explains empty lists.
- tests/test_pipeline_support.py has a FakeBuild that writes small contract-complete bundles. It is reusable for integration tests.

On the user's question that started this run ("are the agents still running?"): this api agent ran and finished. The firedata, terrain, weather and spread agents all landed code during my run. The observed agent had not started: there is no data/dev/observed directory and observed.py is untouched since 20:54.

## scene-core

### Summary

Built the scene-core half of Fire-3d (SPEC 9.0/9.3/9.6), keeping and extending the interrupted run's raster.ts / assets.ts / sceneStore.ts (APIs only added, never removed). One custom terrain shader (scene/terrain/terrainMaterial.ts) renders: graded NAIP (hue-shifted toward moss/olive, bicubic when magnified) or a procedural albedo from FUEL_REALISTIC_LUT + canopy (fuel categories blended bilinearly so 30 m cells never show); world-space fbm micro-detail + detail normals weighted by slope/fuel/canopy (rock, shrub clumps, canopy); sun x GPU-baked soft heightfield shadow (penumbra ray-march, re-baked on exaggeration/style change with cross-fade) x three.js PCF shadow map (trees) + hemisphere sky x sky_view AO x cavity; water with Fresnel sky reflection, sun glints and gold sparkles that bloom; parametric dark relief; observed fire (warm charcoal/ash modulated by dNBR, sparse smouldering embers decaying over ~6 h, domain-warped incandescent flame band, gold front filament); isochrones (1/3/6/12 h by duration+zoom, every 4th brighter); fwidth contours (10/20/50/100 m, index every 5th); forecast P(burned by t) from p10/p50/p90 as a hatched luminous field (heat wash in realistic) with crisp 10/50/90 % contours and a dashed p50 front; burn scar dNBR ramp; FBFM40 fuels overlay; all opacities as uniforms; aerial-perspective height fog + rounded-square AOI edge fade into the sky colour; one-time scan-sweep reveal. To stop linear filtering from faking a front at the burned/never-burned edge, assets now carry observedField (filled arrival + never-mask) and forecastField (filled quantiles + smoothed probability inpainted across non-burnable fuel) textures. A visual-style module (look.ts + LookDriver) drives terrain, sky dome, sun/hemisphere lights, fog and the post grade from one preset per style with animated ~0.9 s transitions, and publishes sceneStore.env for scene-fx. Post-processing (vanilla postprocessing): bokeh DOF focused on the orbit target (store.dof; off in 2D / low; far bokeh buffer kept at reduced resolution), mipmap bloom with luminance threshold, custom AgX/ACES filmic grade (green-black lift, warm gain), vignette, SMAA (skipped at DPR >= 1.75), film grain. Camera rig: MapControls with damping and zoom-to-cursor, SSE oblique framing of the fire bbox (observed + forecast reach) inside the area not covered by UI panels (view offset from measured --safe-* insets), animated 2D/3D, flyTo, compass/frame/zoom commands, exaggeration anchoring, target kept on the ground under the view centre, zoom-adaptive near/far. HTML overlays in dark glass: compass (rotates, click = north), scale bar, 2D/3D, exaggeration, quality, DOF, frame-fire, fullscreen, hover probe readout (raycastHeightfield -> sceneStore.probe), low-FPS quality suggestion toast, loading veil. Quality levels follow SPEC 9.6 plus a drawing-buffer pixel budget. The standalone dev page (scene-dev.html + scene/dev/) loads bundles itself via api/client + setState and has a debug panel (time slider, play, style, lattice field, view, quality, DOF, exaggeration, tree scale, forecast run, all 18 layers with opacity, probe JSON); window.__store/__sceneStore exposed.

### Contract deviations

- **Terrain mesh**: instead of PlaneGeometry(extent, extent, 1023, 1023) displaced on the CPU, the scene uses an indexed grid on the render-grid pixel centres (vertex row 0 = north, alternating diagonals). Raw elevation sits in position.y and the vertex shader applies the exaggeration (uExag), so exaggeration changes rebuild nothing. Normals are computed per fragment from the elevation texture. raycastHeightfield in lib/geo.ts still matches.
- **Shadows**: the terrain's own sun shadows come from a GPU-baked soft heightfield shadow (terrain/sunBake.ts). The texture is published as sceneStore.terrainShadow: R = sun visibility, G = multi-scale cavity. The terrain receives the three.js shadow map (trees) but does not cast into it. The map is static (autoUpdate false) and re-renders only on frustum snap, look change, exaggeration change, requestShadowUpdate(), or the timeline moving (at most 4 times per second).
- **Tone mapping and grade**: done by a custom FilmGradeEffect in post (AgX for hybrid/parametric, ACES for realistic, blended during transitions; then contrast, green-black lift, warm gain and saturation in display space) instead of postprocessing's ToneMappingEffect, because the grade must come after the tone curve. The Canvas uses `flat` (NoToneMapping).
- **SMAA**: skipped when the effective DPR is 1.75 or higher (edges are already fine; saves a full-screen pass). Film grain then runs inside the grade pass.
- **DOF**: LeanDepthOfField subclasses postprocessing's DepthOfFieldEffect so the far-field bokeh buffer stays at the effect's reduced resolution (the library allocates it at full resolution).
- **Quality DPR**: the SPEC caps are kept (high ≤ 2, medium ≤ 1.5, low 1). High and medium are additionally capped by a drawing-buffer budget of 4.6 / 3.2 MP, so a full-screen Retina window renders slightly below the device ratio.
- **Camera**: MapControls with left-drag pan, right-drag orbit and wheel zoom-to-cursor. There is no keyboard panning, because the UI uses the arrow keys to step time. The fire is framed once per incident id (live rebuilds keep the user's view). setViewOffset centres the view in the area not covered by panels, measured from the CSS --safe-* variables into sceneStore.viewInsets.
- **Additions (nothing removed or renamed)**:
  - sceneStore: `sweep` / `setSweep` (ScanSweep). The interrupted run's env, camera, terrainShadow, shadowVersion, qualitySuggestion, viewInsets, cameraCommand and interacting fields are kept.
  - Probe: screenX/screenY, canopyPct, arrivalP50H, pBurnNow.
  - IncidentAssets.textures: observedField and forecastField.
  - lib/raster: NEVER_THRESHOLD, fillNever, arrivalFieldTexture, forecastFieldTexture (optional `unburnable` mask parameter), lutAtlasTexture.
- **Probe readout**: shown only in hybrid and parametric, per SPEC 9.3. sceneStore.probe still updates in realistic.

### Known issues

- At DPR 2 (Retina), high + DOF averages about 41–47 fps in the contended test environment: the median frame is 60 fps, but frames just over budget fall to 33 ms. That is below the SPEC's 50 fps target. High without DOF, medium and low reach 51–60 fps. The PerfMonitor suggests medium after 5 s below 30 fps.
- The FPS measurements are noisy (±10 fps between identical runs) because other agents' headless Chrome sessions and the user's Chrome were using the GPU at the same time.
- The fixture's synthetic NAIP looks blotchy at very close range; bicubic upsampling and procedural detail soften it, and real NAIP should look better.
- Errors from other agents' in-progress files, seen during my runs:
  - In the full app (index.html): an 'Invalid hook call' page error in the UI agent's IncidentMeta (Header).
  - Once during scene-fx hot reload: a Vite error that src/scene/fx/Wind.ts has no export named 'Wind'.
  Neither is in my files.
- R3F 9.8 logs a 'THREE.Clock deprecated' warning from its own internals.
- Fuel-zone boundaries can still show as soft colour steps when imagery is off, since procedural albedo follows LANDFIRE polygons. Large-scale noise breaks them up.
- Micro-detail noise is projected in world XZ (not triplanar), so it stretches by about 2× on the steepest slopes. Rock detail still reads at normal zoom.

### Notes for integrator

**Status.** scene-core has finished. Every server I started is stopped (ports 8101 and 5174 are free), and no processes from this agent remain.

**Post-processing.** It lives in scene/post/PostFX.tsx, and PostFX renders the frame. scene-fx must NOT add its own EffectComposer (the old placeholder comment in fx/index.tsx mentions post-processing). Because the Canvas uses `flat` and tone mapping happens in post, fx materials' `#include <tonemapping_fragment>` is a no-op. Emissive output above 1.0 is what blooms, and the bloom threshold is about 0.85–1.0 depending on the look.

**Matching the terrain atmosphere in other materials.**
- Use ATMOSPHERE_GLSL and atmosphereUniforms/updateAtmosphereUniforms from scene/atmosphere/atmosphere.ts. Then call `col = atmApply(col, cameraPosition, worldPos)` followed by `mix(atmSky(viewDir), col, atmEdgeFade(planeUv, 0.08))`.
- Or read sceneStore.env:
  - fogDensity is the extinction per metre at fogBaseY.
  - fogFalloff is 1 / the haze height scale (exponential height fog).
  - fogColor is the sky horizon colour. The true haze colour varies with view direction (atmSky).
- scene-fx's own fogDensity = 1/(extent·4.5) formula in fx/common.ts is a different model.

**Shared state for other agents.**
- The look blackboard (scene/look.ts `look.current`) is per-frame and mutable. Read it inside useFrame for any style-dependent value: lineGain, reliefMix, realistic weight, sun direction and colour.
- camState (scene/camera/cameraState.ts) holds the orbit target and distance every frame.
- The DirectionalLight named 'sun' carries colour × π (Lambert-correct), and the HemisphereLight named 'sky' carries ambient × π.

**UI coordination.**
- Scene overlays position themselves with the CSS --safe-top/right/bottom/left variables from theme.css; the app shell should keep those accurate.
- The UI's View menu and the scene's overlay dock both write viewMode, exaggeration, quality and dof to the store, so they stay in sync.
- sceneStore.issueCameraCommand('frame-fire' | 'reset-north' | 'zoom-in' | 'zoom-out') is available for UI buttons. qualitySuggestion appears as a scene toast; the UI may also show it.

**Dev page.**
- URL: http://localhost:<port>/scene-dev.html
- Parameters: ?incident=, &t=, &style=, &quality=, &view=, &exag=, &dof=0, &panel=0, &forecast=<run|none>, &layers=-lattice,fuels (a '+' prefix also works).
- Dev-only window handles: __assetStore, __camState, __look.

**Next step.** Re-measure FPS on an idle machine. If high + DOF at Retina is still under 50, lower PIXEL_BUDGET.high in scene/Scene.tsx (currently 4.6e6).

### Screenshots

docs/screenshots/scene-core-hybrid.png, docs/screenshots/scene-core-realistic.png, docs/screenshots/scene-core-parametric.png, docs/screenshots/scene-core-forecast.png, docs/screenshots/scene-core-2d.png, docs/screenshots/scene-core-front.png, docs/screenshots/scene-core-front-realistic.png, docs/screenshots/scene-core-devpage.png

## scene-fx

### Summary

The scene-fx layer is finished and working: all eleven effect components the spec asks for, the isolated dev page, and the shared foundation the interrupted run left behind. To your question: yes, the agents are still running, this one included. The cut-off run was resumed and completed. `npm run build` passes, typecheck is clean, and lint shows 0 errors (only warnings). I iterated visually more than 30 times, viewing each screenshot, and 0 page errors were reported on the final shots.

**Recovered from the interrupted run:**
- `fronts.ts` turned out to be complete and correct. It is kept as is and now drives smoke, embers and the telemetry columns.
- `common.ts` and `state.ts` were reworked around one set of shared shader values (time, sun, fog, wind) that a single per-frame driver updates for every effect.
- `wind.ts` was kept with a small fix: it now zeroes the wind when weather data is missing.

**What `SceneFx` renders** (each one follows layer visibility and opacity, visual style, exaggeration and quality):
- **Golden lattice:** 512/384/256² points depending on quality, plus faint wire rows on every 4th row. Brightness encodes the lattice field (activity, probability, elevation, slope or canopy). Coarser points drop out as you zoom out so the grid never shimmers. It fades out around the fire in hybrid, covers the whole area in parametric, and sweeps in once on load.
- **Trees:** three instanced shapes (conifer, broadleaf, shrub). Burned trees turn to charcoal and shrink; trees on the front torch with flicker. They pick up ridge shadows from scene-core and cast shadows at high quality.
- **Smoke:** sorted, sun-lit soft billboards rising from a few persistent hot spots on the front plus FRP-weighted recent detections, drifting with the real wind.
- **Embers:** GPU sparks along the front, drifting downwind.
- **Detections:** true-size footprint outlines in hybrid/parametric, small FRP-sized glows in realistic, faint GOES rings only when zoomed out.
- **Perimeters:** older ones dim, the latest one before the current time highlighted.
- **Ignition:** flare, pulsing ground rings and a label.
- **Telemetry:** gold monospace columns at the ignition, the top 3 fronts and the hover point, real values only. Digits tick briefly when they change. Overlapping columns fade, and columns flip left when they would run under the side panel.
- **Wind streaks:** about 3,000, drawn from the 4×4 wind grid.
- **Profile path:** click-to-draw on the terrain; Esc or double-click ends.
- **Aircraft:** heading-oriented icons, drop lines to the ground, 5-minute trails and smoothed motion.

All labels are drawn after scene-core's post-processing, so depth of field and bloom never blur the numbers. I also guarded the shader maths against NaN after an intermittent all-black frame showed up on the GPU; three repeat shots afterwards all rendered normally.

**Frame rate** in the integrated scene-dev page (Apple M3 Pro, fixture-demo, 12 km area):
- At device pixel ratio 1: 60 fps at high, medium and low.
- At device pixel ratio 2: high 49 fps with effects vs 53 fps without; medium and low 60 fps.

The spec's ≥ 50 fps target at high is just missed at pixel ratio 2, and the terrain plus post-processing alone only reach 53 there.

### Contract deviations

- The component file for wind streaks is `WindStreaks.tsx`, not `Wind.tsx`. The Mac filesystem is case-insensitive, so `./Wind` collided with the existing `wind.ts` helper and broke the typecheck. The component is still exported as `Wind` and is mounted through `index.tsx`.
- Telemetry, ignition and aircraft labels are drawn in a separate overlay pass after the frame is rendered (`Overlay` in `fx/text.tsx`, a frame hook at priority 100 that clears depth and draws a second scene). This keeps depth of field, bloom and grain off the monospace text. If no post-processing composer is rendering the frame, the overlay renders the main scene first so nothing is lost.
- The lattice activity value also mixes in a blurred "front proximity" texture (`FrontField`, about 320 m radius) computed on the CPU from the active-front window, in addition to recency and forecast probability.
- Aircraft altitude is drawn as alt_m × exaggeration, so planes stay at a consistent height above the exaggerated terrain.
- The FX driver reads the camera target from R3F's controls (scene-core registers its MapControls there); without controls it falls back to the fire centroid.
- Trees are hidden in parametric mode, and the lattice and telemetry are hidden in realistic mode, matching the style descriptions in SPEC 9.0. Smoke is dimmed in parametric (×0.35) and hybrid (×0.85).

### Known issues

- At high quality and pixel ratio 2 the integrated scene runs at 49 fps, against the spec's ≥ 50 target. The effects cost about 4 fps there (53 → 49), and the base scene alone reaches only 53. Every other quality / pixel-ratio combination holds 60 fps.
- Frame-rate figures were taken in a headless browser while other agents' builds were running, so individual readings varied between runs by a few fps up to ±15. All figures are medians of alternating on/off runs.
- The probe's "P(BURN) NOW" value only appears when scene-core fills `pBurnNow` in sceneStore.probe; otherwise the column shows the end-of-forecast probability.
- The dev page approximates scene-core's look with a simplified copy of its look presets; it does not import scene-core's code. The integrated screenshots show the real result.
- `JetBrainsMono-Regular.woff` from the interrupted run was removed because it was unused; only the Medium weight is bundled (28 kB). If the font fails to load, labels fall back to troika's default font with a console warning.

### Notes for integrator

**Mounting.** Scene-core already mounts `<SceneFx/>` inside its Canvas, and it works with scene-core's PostFX, LookDriver env, CameraRig controls and sun shadows. Nothing in scene-core needs to change.

**What scene-fx reads from scene-core:**
- `sceneStore.env`: sun direction and colour, sky and ground ambient, fog density/falloff/base height, line gain. Effect fog uses the same height-fog formula as the terrain, and the edge fade uses the same rounded square (exponent 7, 8 %) as `terrainMaterial.ts`.
- `sceneStore.terrainShadow`: ridge shadows on trees.
- `sceneStore.probe` and `sceneStore.interacting`: the probe column.
- `sceneStore.viewInsets`: the right-hand panel width, so telemetry flips left.
- R3F `state.controls.target`.
- Trees call `requestShadowUpdate()` when they change.

**Shared state for other modules:**
- `fx/state.ts` exports `fxStore` (zustand: active fronts with clusters, centroid, length, ROS and FRP) and `fxShared` (per-frame time, wind grid, fire centroid/radius, front-proximity texture).
- The UI or scene-core can read the active fronts from `fxStore.getState().fronts`, for example for a "front length" readout.

**Frame order.** The driver runs at priority -2, before every other fx callback. The label overlay renders at priority 100, after scene-core's composer (priority 1).

**Dev page.** `/fx-dev.html` accepts query params:
- `?incident`, `?th` (hours) or `?tf` (fraction 0–1), `?style`, `?field`, `?quality`, `?exag`, `?trees`
- `?layers=%2Bwind,-smoke` (URL-encode `+` as `%2B`)
- `?dof`, `?play=1&speed=`, `?cam=px,py,pz,tx,ty,tz`, `?panel=0`

It also exposes `window.__fxDev.measureFps(ms)`, `__fxDev.gpuMs(frames)`, `__fxDev.setCamera(...)`, `window.__fxStore`, `window.__fxShared` and `window.__fxScene`.

**Performance knobs if the integrator wants 50+ fps at high quality and pixel ratio 2:** smoke count `SMOKE_N` in `Smoke.tsx` (640/420/240), the lattice level-of-detail thresholds in `Lattice.tsx`, and trees per quality (`QUALITY_SCALE`).

### Screenshots

docs/screenshots/scene-fx-hybrid.png, docs/screenshots/scene-fx-parametric-wind.png, docs/screenshots/scene-fx-parametric-probability.png, docs/screenshots/scene-fx-live-aircraft.png, docs/screenshots/scene-fx-probe-path.png, docs/screenshots/scene-fx-front-closeup.png, docs/screenshots/scene-fx-integrated-hybrid.png, docs/screenshots/scene-fx-integrated-lattice.png, docs/screenshots/scene-fx-integrated-realistic.png, docs/screenshots/scene-fx-integrated-parametric.png

## ui

### Summary

I finished the UI role. I kept and checked everything the interrupted run had written (store, theme, client, time/format helpers, picker, header, menus, hooks) and built the rest. At the start the whole web build was broken for every agent, because RightPanel imported 7 files that didn't exist; I fixed that first.

New parts:
- **App shell:** loads the catalog and picks the default incident (SPEC 9.4), honours `?incident=`, `?mode=` and `?t=` (applied once the bundle is ready, even after a build), and keeps the address bar in sync.
- **Runtime:** rAF playback, live polling (manifest every 60 s, aircraft every 10 s), keyboard shortcuts (H, Space, arrows) and `VITE_SCENE=off`.
- **Safety and layout:** the 3D scene sits behind an error boundary, so a scene crash leaves the panels working. The shell publishes the canvas area not covered by panels as `--safe-*` CSS variables.
- **Right panel:**
  - Layers tab: grouped rows with checkbox, swatch, label, opacity slider and %. Unavailable layers are greyed with a tooltip saying why. Legends appear for forecast, fuels and detections.
  - Analysis tab: forecast runner (start, 24/48/72 h, five ensemble choices, live progress), run list, P50 area at +24/48/72 h with the P10–P90 range, hindcast skill table and the disclaimer.
  - Evidence and Notes tabs.
  - Aircraft list for live incidents.
  - Incident Overview card and Weather & Fire Behavior card.
- **Bottom dock:**
  - Timeline with every SPEC 9.4 element: play/step/speed, time bubble, Pacific-time ticks, event markers, an hourly fire-activity strip, the Now marker with a hatched forecast region, and window presets.
  - Key Events with "+ Add" annotations.
  - Three SVG charts. Each has a cheap time cursor synced to the timeline, a hover readout and click-to-scrub.
- **Overlays:** build card with step trail, rebuild/forecast progress pill, not-built card with Build button, error banners with Retry, a no-live-fires notice, and toasts.
- **Store fixes:** a freshly built incident now starts at its default time, not the previous incident's time. A failed bundle JSON file now shows a retry banner instead of silently empty charts.
- **Responsive:** container queries keep 1440×900 usable. On short screens the Overview card starts collapsed.

### Contract deviations

- Store additions beyond SPEC 9.2; every contract field and default is unchanged:
- fields: incidentLoading, incidentError, windowPreset, headerTab, aircraftAll, aircraftMeta, liveStatus, autoBuild; catalog gained minAcres and updatedMs;
- actions: setWindowPreset, setHeaderTab, setAircraftAll, setAutoBuild, stepTime, requestFlyTo/flyToLocal, refreshAircraft, refreshLiveStatus;
- exported helpers: getTimeBounds, defaultTimeFor, nowMarkerMs, windowFor, SPEEDS_HOURS_PER_SEC, DEFAULT_LAYERS, LAYER_KEYS.
- The shell does not write sceneStore.viewInsets. It publishes the uncovered canvas area as the CSS vars --safe-top/right/bottom/left, measured from the panels, including when collapsed. Scene-core's SafeAreaProbe already measures those vars into viewInsets. Having both write caused a 12 px disagreement, so the CSS vars are now the single source.
- The 'optional GOES FRP overlay' on the Rate of Spread chart is an hourly intensity strip along the time axis, toggled from the legend or menu. It is not a second y-axis (the dataviz guidance forbids dual axes). FRP values appear in the hover readout. 'Potential ROS (weather)' is an optional third line in the chart menu.
- Incident Overview 'Cause' shows 'Not reported' because IncidentSummary has no cause field. It displays summary.cause or summary.fire_cause if the API ever adds one.
- The flame length in the weather card is the single weather.at_fire.flame_length_ft value at the current hour, not a range like the demo's '6–9 ft'.
- In historical mode the 'Now' marker is the selected hindcast's start (labelled T₀) and the hatched region is labelled HINDCAST. Live mode uses now_ms and FORECAST.
- Elevation profile: the burned part is split by recency (≤ 6 h in fire orange, older in dim ember). The fire marker sits on the most recently burned sample of the path, so it never sticks to non-burnable gaps such as rivers. Forecast P50 reach is hatched.
- App.css is no longer imported; the layout moved to styles/layout.css. The file is left in place because it is not in my owned list; it can be deleted.
- A failed load of any of the 5 bundle JSON files (or the selected forecast) sets incidentError, which shows a retry banner. The scaffold had ignored these failures silently.

### Known issues

- The fixture server only serves ready bundles. The not-built → Build → progress flow was therefore verified by forcing store state (manifest null, bundle_status 'none') and using the fixture's fake 5 s jobs. Real step names come from the api agent and are shown verbatim, capitalised, as a trail of chips.
- Scene-side behaviours are owned by the scene agents and were only checked from the UI side: drawing a profile path (I set drawingPath and can reset to default_profile_path), the flyTo animation (I bump the nonce) and camera framing from viewInsets.
- Share falls back to window.prompt when clipboard permission is denied.
- Timeline event markers closer than 13 px are spread apart by a few pixels to stay clickable; exact times are in their tooltips.
- On screens shorter than 960 px the Overview card starts collapsed so the tabbed panel stays usable; the user's choice is remembered in localStorage (fire3d:card:*). Below roughly 1300 px wide, the header menus drop their text labels and become icon-only.

### Notes for integrator

**Running it.** Same as the fixture setup: `uv run python scripts/serve_fixture.py --port P --data-dir <repo>/data`, then `VITE_API_TARGET=http://localhost:P PORT=p npm run dev`. `window.__store` (and the scene's `window.__sceneStore`) let screenshots drive the app, e.g. `setRightTab('analysis')`, `setHeaderTab('aircraft')`, `setPanelsCollapsed(true)`.

**Test scripts.** The Playwright suites I used are throwaway files in `/tmp/ui-e2e` (e2e.mjs, failures.mjs, states.mjs, build-shot.mjs), not part of the repo. They are reusable against the real API on 8710 by setting `BASE`.

**For the api agent:**
- Job `step` strings are shown to users as-is. Short human words like "terrain" or "weather members" read best.
- A forecast job's `result.run_id` selects the new run; failing that, the newest ready run is selected.
- Historical forecast requests always send `start_ms`: the timeline time floored to the hour and clamped to [ignition, end_ms].
- Live requests omit `start_ms`, so the server uses `now_ms`.
- The Overview's Cause row reads an optional `summary.cause` (or `fire_cause`) if you add one.
- Build progress shows the centre card when there is no ready manifest. A rebuild or refresh of a loaded bundle shows a top pill instead, and the replay stays usable.

**For the scene agents:**
- Position overlays with `var(--safe-*)`; they update on resize and on H.
- The shell no longer calls `setViewInsets`; SafeAreaProbe is the only writer.
- The UI sets `flyTo` from Key Events, profile hover-click and aircraft rows (distance 5000).
- `drawingPath` comes from the profile chart's Draw button and the Analysis menu; Escape ends drawing (runtime hotkey).
- `profilePath` resets to `default_profile_path`.

**localStorage keys:** `fire3d:notes:{id}`, `fire3d:annotations:{id}`, `fire3d:card:{overview|weather}`.

**Re-check after integration:** `npm run build` passed at the end; it depends on scene files that other agents are still editing.

**Your question in the message:** this UI agent was running and using API credit until now; it has finished, and its two servers (5175, 8102) are stopped. The scene-core agent's own servers on 5174 and 8101 were still running when I checked; I left them alone.

### Screenshots

docs/screenshots/ui-historical.png, docs/screenshots/ui-live-aircraft.png, docs/screenshots/ui-picker.png, docs/screenshots/ui-analysis.png, docs/screenshots/ui-evidence.png, docs/screenshots/ui-collapsed.png, docs/screenshots/ui-building.png, docs/screenshots/ui-1440.png
