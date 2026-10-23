# Fire-3d — Build Spec v1

Source of truth for every build agent. Sections marked **(Contract)** are interfaces other modules depend on:
implement them exactly. If a contract is wrong or impossible, make the smallest compatible change, keep old fields
working, and list the deviation in your report. Sections marked **(Guidance)** describe recommended approaches you
may improve on.

Reference UI (a mocked demo we are rebuilding on real data): `docs/reference/firetrace-demo.png`. View it.
Do **not** use the name "FireTrace" anywhere. The app is called **Fire-3d**, tagline "Wildfire Forensics & Forecast".

---

## 0. Product

A 3D wildfire analysis app for the **lower 48 US states and DC** (brief 3; it started with California), built on
real data. Alaska, Hawaii and US territories are not supported yet: their fires are not listed, and a point there says
"Fire-3d does not support Alaska, Hawaii or US territories yet." The national fire list comes from NIFC WFIGS (IRWIN);
in California CAL FIRE stays the record and WFIGS adds only the fires CAL FIRE does not list
(docs/redesign/CONTRACT.md §14.1-14.2). The brief-2 text below describes California, where it still holds:

- **Live mode:** incidents CAL FIRE currently lists as active, plus satellite fire detections, perimeters, weather, a
  72-hour **ensemble** fire-spread forecast (burn probability), and live firefighting aircraft from ADS-B.
- **Historical mode:** **all 2025** California incidents ≥ 300 acres (toggle for ≥ 100). Each gets a forensic
  replay of the observed spread (timeline animation, charts, key events) and **hindcasts**: a forecast launched from
  any past moment, scored against what actually burned.
- The 3D terrain is real (USGS 10 m DEM + NAIP aerial imagery + LANDFIRE vegetation). It is rendered in the
  **cinematic "realistic + parametric" art direction** of `docs/reference/art-direction.png`: photographic terrain in a
  dark, moody atmosphere, overlaid with a luminous golden data lattice, isolines, and monospace telemetry, with depth
  of field. Modes: hybrid (default), realistic, parametric (§9.0). The panel layout follows
  `docs/reference/firetrace-demo.png`, restyled as dark glass.
- WeatherNext 3 is **out of scope for now** (access pending). Weather sits behind a `WeatherSource` interface so it
  can be added later. Do not implement a WeatherNext adapter.

## 1. Environment facts (verified 2026-10-16)

- macOS arm64, 12 cores, 36 GB RAM. **Only ~28 GB free disk:** keep `data/` under 3 GB. The only bulk downloads
  allowed are the FIRMS 2025 yearly CSVs (~46 MB total).
- Node 25.6.1, npm 11.9. Python 3.12 via **uv 0.10.3**. Xcode CLT clang 17 is present (pyretechnics compiles from
  sdist in ~45 s).
- No GDAL CLI. Use `rasterio` wheels, which bundle GDAL.
- **SSL gotcha:** the python.org Python's `urllib` fails certificate checks on this machine. Use `httpx` (certifi).
  `fire3d/config.py` sets `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` to `certifi.where()` at import, so
  rasterio/GDAL `/vsicurl/` reads work.
- Google Chrome is installed. Playwright drives it with `channel: "chrome"` (no browser download).
- Free-to-use public APIs only. The one secret is the **NASA FIRMS MAP_KEY**, which lives in `<repo>/.env` as
  `FIRMS_MAP_KEY=…`. That file is gitignored and chmod 600.
  - `fire3d/config.py` loads `.env` at import with a tiny built-in parser (no python-dotenv); real environment
    variables take precedence.
  - **Never print, log, commit, or copy the key** into any other file, report, screenshot, or error message. Mask
    it as `***` in logged URLs.
  - Limit: **5,000 transactions per 10 minutes**; one area request costs roughly 5–8. Use a client-side limiter
    (≤ 150 FIRMS API requests per rolling 10 min) and cache aggressively.
  - Usage check: `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=…`.
  - Everything must still work without the key, using the no-key fallbacks in §2.

## 2. Data sources (all verified working on 2026-10-16)

| Data | Endpoint | Notes |
|---|---|---|
| CAL FIRE live incidents | `GET https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false` | JSON list. Fields: `Name` (may have trailing space), `Started`/`Updated` (ISO Z), `AcresBurned`, `PercentContained` (nullable), `Latitude`, `Longitude`, `County`, `Location`, `AdminUnit`, `Type` ("Wildfire", "Fire", …), `UniqueId` (uuid), `Url`, `IsActive`, `Final`, `ExtinguishedDate`. 13 active on 2026-10-16. |
| CAL FIRE 2025 incidents | `GET …/IncidentApi/List?inactive=true&year=2025` | 556 incidents: 130 ≥ 100 ac, 78 ≥ 300 ac, 36 ≥ 1000 ac. Largest: Gifford 131,612; Madre 80,779; Garnet 59,844; Palisades 23,448; Eaton 14,021. |
| **FIRMS area API (primary, key)** | `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SOURCE}/{w,s,e,n}/{DAY_RANGE}/{YYYY-MM-DD}` | DAY_RANGE is the number of days starting at the date: **max 5** for VIIRS/MODIS/LANDSAT, **max 2 for GOES_NRT** ("Invalid day range" otherwise). Availability on 2026-10-16 (`/api/data_availability/csv/{KEY}/ALL`):<br>• `VIIRS_SNPP_SP` 2012-01-20…2026-06-30, `VIIRS_NOAA20_SP` 2018-04-01…2026-06-30, `VIIRS_NOAA21_SP` 2023-03-01…2026-06-30, `MODIS_SP` 2000-11…2026-07-31<br>• NRT: `VIIRS_SNPP_NRT` and `VIIRS_NOAA20_NRT` from 2026-07-01, `VIIRS_NOAA21_NRT` from 2024-01-17, `MODIS_NRT` from 2026-08-01, `GOES_NRT` from 2022-08-09, `LANDSAT_NRT` from 2022-06-20<br>**2025 replays:** use the three VIIRS SP sources + MODIS_SP (≈6 VIIRS passes/day at 375 m; e.g. Eaton Jan 8–12: ~530 NOAA-20, ~550 SNPP, ~660 NOAA-21 detections) + GOES_NRT + LANDSAT_NRT.<br>**Live:** the NRT sources (SP for dates before NRT coverage).<br>Columns as the CSV feeds below, plus `instrument` and `type`. **`acq_time` is NOT zero-padded** ("949" = 09:49 UTC): `zfill(4)`.<br>**`type`:** 0 vegetation, 1 volcano, 2 static land source, 3 offshore. Real fire pixels can be tagged 2 (MODIS on Eaton/Palisades) or 3 (Palisades coast), so drop only type 1 and rely on space-time clustering (§8.3) to exclude unrelated static sources.<br>**GOES_NRT** rows: satellites `G16`, `G18` (also `G19`), plus duplicate `G18FRP`-style rows (drop the `*FRP` duplicates). Pixel ≈ 2–3 km; `scan`/`track` are not km (assume a 2 km footprint). Confidence ranges from `30.0000` (low) to `100`. ~2,000 rows per 2 days over Eaton. Use GOES for **timing and activity** (ignition refinement, hourly FRP/activity series, gaps between VIIRS passes), not for the spatial burned mask.<br>**LANDSAT_NRT**: 30 m, sparse (~8-day revisit). Use it for the spatial mask when present.<br>**Caching:** SP and past-dated responses are immutable (TTL 30 d); NRT responses touching the last 48 h TTL 15 min. |
| FIRMS live CSV (no key) | `https://firms.modaps.eosdis.nasa.gov/data/active_fire/{dir}/csv/{prefix}_USA_contiguous_and_Hawaii_{24h\|48h\|7d}.csv`; (dir, prefix) ∈ (`suomi-npp-viirs-c2`,`SUOMI_VIIRS_C2`), (`noaa-20-viirs-c2`,`J1_VIIRS_C2`), (`noaa-21-viirs-c2`,`J2_VIIRS_C2`), (`modis-c6.1`,`MODIS_C6_1`) | Used for the **California-wide live catalog** (`detections_24h` for every incident in one request per source), and as the fallback when the key is missing. VIIRS columns `latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence(l/n/h),version,bright_ti5,frp,daynight`. MODIS has `brightness`, numeric `confidence`. 7d files < 1 MB. |
| FIRMS 2025 yearly archive (no key, fallback) | `https://firms.modaps.eosdis.nasa.gov/data/country/{viirs-snpp\|modis}/2025/{viirs-snpp\|modis}_2025_United_States.csv` | 37 MB / 9 MB, full year 2025, SNPP + MODIS only (`viirs-noaa20` yearly is 404). Fallback for 2025 when the area API is unavailable. Download once, filter to the California bbox (lon −124.6…−113.9, lat 32.4…42.1), cache as parquet. Same `type` rule. |
| NIFC daily perimeters | `https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Daily_Perimeters_Public/FeatureServer/0/query` with `where`, `outFields`, `outSR=4326`, `f=geojson` (max 2000 records/page; paginate with `resultOffset`) | 1,046 CA records in 2025. Fields: `poly_IncidentName`, `poly_PolygonDateTime` (epoch ms, may be null → fall back to `poly_DateCurrent` → `poly_CreateDate`), `poly_GISAcres`, `poly_FeatureCategory` ("Wildfire Daily Fire Perimeter" / "Wildfire Final Fire Perimeter"), `attr_IrwinID`, `attr_POOState` ("US-CA"), `attr_FireDiscoveryDateTime`, `attr_ContainmentDateTime`, `attr_FireCause`. **Messy:** many duplicate edits share one timestamp; names recur across years and states (e.g. "Gifford" 2020/2021/2023/2025; "Eaton" in MN/FL). California fires (CAL FIRE records) keep this path exactly: state = US-CA, time window [start − 2 d, start + 120 d], distance (< 30 km from the CAL FIRE point). Fires elsewhere (NIFC WFIGS records) match by IRWIN id: `UPPER(attr_IrwinID) IN (...) OR UPPER(poly_IRWINID) IN (...)`, else by name in `US-<state>`; the time window, distance and size checks stay; a WFIGS record with neither IRWIN id nor state is not matched (warning). Example where-clause that works: `attr_POOState='US-CA' AND poly_PolygonDateTime >= TIMESTAMP '2025-01-01 00:00:00'`. Current perimeters of live fires are also in `WFIGS_Interagency_Perimeters_Current`. |
| USGS 3DEP DEM | `https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox={minx},{miny},{maxx},{maxy}&bboxSR={epsg}&imageSR={epsg}&size={W},{H}&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image` | Returns a float32 GeoTIFF already in our UTM grid. maxImage 8000. |
| LANDFIRE | `https://lfps.usgs.gov/arcgis/rest/services/Landfire_{ED}/{ED}_{LAYER}_CONUS/ImageServer/exportImage?…&format=tiff&interpolation=RSP_NearestNeighbor&f=image` with ED ∈ {`LF2023`,`LF2024`,`LF2025`} (LF2023 added in brief 3, same service), LAYER ∈ {`FBFM40`,`CC`,`CH`,`CBH`,`CBD`,`EVT`} | int16, 30 m native (EPSG:5070), reprojected server-side. FBFM40 codes: 91–99 non-burnable, 101–204 burnable. **CC** is percent; **CH** and **CBH** are metres × 10; **CBD** is kg/m³ × 100. Historical: the pre-fire edition LF{federal fiscal year of the start − 1}, at least LF2023 (a fire before October 2023 is refused with 422 unless forced); live: LF2025. LF2025 has no data in parts of the South and East (none at Black Cove, NC, checked 2026-10-23). Optional seasonal fuels for live: `Landfire_LF2025_Seasonal_Fuels_2026/LF2025_FBFM40_FA26` (fall 2026). |
| NAIP imagery | `https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bbox=…&bboxSR=…&imageSR=…&size=W,H&format=jpg&f=image` | maxImage 4000×4000. (`USGSNAIPPlus` timed out; don't use it.) |
| Sentinel-2 L2A | STAC `POST https://earth-search.aws.element84.com/v1/search` with `{"collections":["sentinel-2-l2a"],"bbox":[…],"datetime":"a/b","query":{"eo:cloud_cover":{"lt":20}}}` | Assets `nir` (B08, 10 m), `swir22` (B12, 20 m), `scl`. Public HTTPS COGs; read windowed via rasterio `WarpedVRT` onto our grid. **Apply each asset's `raster:bands` scale/offset** (L2A has a −0.1 offset since 2022). |
| Weather forecast (deterministic) | `https://api.open-meteo.com/v1/forecast?latitude=a,b,…&longitude=c,d,…&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation&models=gfs_hrrr&wind_speed_unit=ms&timeformat=unixtime&past_days=3&forecast_days=4` | Multi-location works (one JSON object per location). HRRR fills only ~48 h (later hours null); fill the rest with `models=gfs_seamless`. `wind_direction_10m` is the meteorological FROM direction. |
| Weather ensemble (**live only**) | `https://ensemble-api.open-meteo.com/v1/ensemble?…&models=gfs025` (31 members: control + `_member01…30`) or `models=ecmwf_ifs025` (51) | Keys look like `wind_speed_10m_member07`. Multi-location works. **Only covers ~the last 90 days plus the forecast** (range 2026-07-16…2026-11-21 on 2026-10-16), so it cannot be used for 2025. |
| Weather historical | `https://historical-forecast-api.open-meteo.com/v1/forecast?…&start_date=YYYY-MM-DD&end_date=…&models=gfs_hrrr` | Archived HRRR forecasts; works for 2025. Fallback: `https://archive-api.open-meteo.com/v1/archive` (ERA5). Free tier limits per IP: daily (~10k), hourly (~5k) and per-minute (~600) weighted calls; a refusal is HTTP 429 with a JSON body such as {"error":true,"reason":"Daily API request limit exceeded. Please try again tomorrow."} (resets 00:00 UTC). Cache everything; never cache an error body (§8.4). |
| ADS-B | `https://api.adsb.lol/v2/point/{lat}/{lon}/{radius_nm}`, `https://api.adsb.lol/v2/type/{ICAO type}`; fallback `https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm}` (free for non-commercial use) when adsb.lol is unreachable | Response `{ac:[…], now, total}` (adsb.fi: `{aircraft:[…], now (s), resultCount}`). Aircraft fields: `hex`, `flight` (callsign, space-padded), `r` (registration), `t` (ICAO type), `lat`, `lon`, `alt_baro` (ft, or the string "ground"), `alt_geom`, `gs` (kt), `track`, `category`, `seen`, `squawk`. |
| NWS fire weather alerts (no key; added 2026-10-18) | `GET https://api.weather.gov/alerts/active?area=CA&event=Red%20Flag%20Warning,Fire%20Weather%20Watch` (header `User-Agent: Fire-3d/0.1 (research prototype)`, `Accept: application/geo+json`); zone polygons `GET https://api.weather.gov/zones/fire/{UGC}` | GeoJSON CAP alerts; fire weather alerts carry `geometry: null` and list their fire weather zones in `geocode.UGC` / `affectedZones`; P-VTEC in `parameters.VTEC` (e.g. `/O.CON.KLOX.FW.W.0005.000000T0000Z-261018T0300Z/`). Open data, free to use; a User-Agent is required (optional contact via `FIRE3D_NWS_CONTACT`). NWS keeps no archive: past dates answer an empty list. Cached 2 min (alerts) / 30 days (zones). |
| NWS alert archive (Iowa Environmental Mesonet, no key; added 2026-10-18) | `GET https://mesonet.agron.iastate.edu/json/vtec_events_bypoint.py?lat=&lon=&sdate=YYYY-MM-DD&edate=`, `/json/vtec_event.py?wfo=LOX&year=2025&phenomena=FW&significance=W&etn=1`, `/geojson/vtec_event.py?…` (same query) | Public domain ("may be used freely by anyone for any lawful purpose"), an archived copy of NWS products, not an NWS source. bypoint lists events by their start date (look back about 14 days); `vtec_event` gives per-zone `utc_product_issue`, `utc_issue`, `utc_expire` (final; a watch upgraded or cancelled before it began ends before it begins) and the original text products (`report`, `svs[]`); the geojson features' `id` is the UGC. Cached 30 days (30 min while the window touches the last day). |
| NIFC WFIGS Incident Locations (no key; brief 3) | `https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations{_Current,_YearToDate,}/FeatureServer/0/query` with `IncidentTypeCategory='WF'` (+ `UniqueFireIdentifier LIKE '<year>-%' AND IncidentSize>=<min>` for year lists), explicit `outFields`, `outSR=4326`, `f=json`, 2,000 rows per page | The national fire list and each fire's agency record (`sources/wfigs.py`; Current 5 min, YearToDate 30 min, all years 24 h, one record by IRWIN id 10 min). Item licence is a disclaimer only, no use restriction (checked 2026-10-22/23). Credit "NIFC WFIGS (IRWIN)". |
| NWCG Unit Identifier codes (brief 3) | PMS 931 (Sep 2022), https://www.nwcg.gov/publications/pms931 | Plain names of protecting-agency codes, `backend/fire3d/data/nwcg_agency_codes.json`. NWCG publications are public domain, use permitted when credited to NWCG (checked 2026-10-23). Credit "Agency names: NWCG unit identifiers". |
| USDOT BTS NTAD Time Zones (brief 3) | `https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Time_Zones/FeatureServer/0` | Time zone at a point (`backend/fire3d/data/us_timezones.geojson`, built offline by `scripts/build_us_regions.py`). "Available for unrestricted public use" (the layer's own text, checked 2026-10-23). Credit "Time zones: USDOT BTS NTAD". |
| Census TIGERweb states, counties, AIANNH (brief 3) | `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/{State_County/MapServer/0,1, AIANNHA/MapServer/2}` | State, county, Navajo Nation and Hopi Reservation (`us_states.geojson`, `us_counties.geojson`, `us_timezones.geojson`). Public domain, "Source: U.S. Census Bureau". Credit "Boundaries: U.S. Census Bureau TIGERweb". |
| Census 2026 Gazetteer Files, national (brief 3) | `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2026_Gazetteer/2026_Gaz_{place,counties,zcta}_national.zip` | Towns, counties and ZIP areas of every state for `/api/geocode` (`backend/fire3d/data/gazetteer_us.json`). Public domain. Credit "U.S. Census Bureau Gazetteer Files". |
| NWS API alerts, national (brief 3, us-pipeline) | `GET https://api.weather.gov/alerts/active?area=<the 48 states + DC>` | Fire weather and the local officials' messages NWS relays: also `event=` the local officials' NWEM types (Fire Warning FRW, Evacuation Immediate EVI, Shelter In Place Warning SPW, Civil Danger Warning CDW always; Civil Emergency Message CEM and Local Area Emergency LAE only when the text mentions fire, smoke or evacuation); NWS keeps about 7 days, so past dates use the OpenFEMA IPAWS archive. Public domain (weather.gov/disclaimer). Credit "National Weather Service". |
| OpenFEMA IPAWS Archived Alerts v1 (brief 3, us-pipeline) | `https://www.fema.gov/api/open/v1/IpawsArchivedAlerts` | Local officials' messages of past days, labelled archived. OpenFEMA terms (2025-01-22): the notice "This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA" is required; no FEMA or DHS logos. Credit "FEMA IPAWS archive via OpenFEMA". |
| Oregon OEM "Evacuation Areas Public" (brief 3, us-official) | Oregon Department of Emergency Management ArcGIS layer | Evacuation zones in Oregon. Licence field "Public"; no further terms published (checked 2026-10-22). Credit "Oregon Department of Emergency Management". |
| LANDFIRE LF2023 (brief 3, us-pipeline) | the LANDFIRE service above with ED `LF2023` | Pre-fire fuels of federal fiscal year 2024 fires. Public domain. Credit "LANDFIRE" (edition named). |
| Satellite passes (NASA CMR, no key; added 2026-10-17) | `GET https://cmr.earthdata.nasa.gov/search/granules.json?short_name={SN}&version={V}&point={lon},{lat}&temporal={iso},{iso}&sort_key=-start_date&page_size=200` (header `Client-Id: fire3d`) | Granules of the active-fire products FIRMS is made from. Live (LANCE NRT): `VNP14IMG_NRT` v2 (Suomi NPP), `VJ114IMG_NRT` v2 (NOAA-20), `VJ214IMG_NRT` v2 (NOAA-21), `MOD14` v6.1NRT (Terra), `MYD14` v6.1NRT (Aqua). Archive: `VNP14IMG`/`VJ114IMG`/`VJ214IMG` v002, `MOD14`/`MYD14` v061. Fields used: `time_start`/`time_end` (6-min VIIRS, 5-min MODIS granules; FIRMS `acq_time` falls inside), `day_night_flag`, `updated` (publication, 0.75–3 h after acquisition). A granule containing the fire's point is a pass over it (§8.3). |

## 3. Repo layout

```
Fire-3d/
  SPEC.md  PLAN.md  README.md  dev.sh  .gitignore
  .env                                   FIRMS_MAP_KEY (gitignored, chmod 600; never copy the key elsewhere)
  docs/reference/firetrace-demo.png      reference for layout and features
  docs/reference/art-direction.png       reference for the LOOK (realistic + parametric, dark cinematic)
  docs/screenshots/                      verification screenshots
  backend/
    pyproject.toml  uv.lock  .venv/
    fire3d/
      __init__.py
      config.py          paths, env, constants, SSL setup
      types.py           shared dataclasses (Contract §7.1)
      contracts.py       pydantic models mirroring §5/§6 JSON (Contract)
      grid.py            Grid + AOI math (Contract §7.2)
      http.py            cached HTTP client with retries
      bundle.py          bundle paths, manifest load/save/update (atomic + lock), layer write/read
      timeutil.py
      sources/  calfire.py firms.py perimeters.py terrain.py landfire.py imagery.py sentinel.py weather.py aircraft.py
      catalog.py
      build/    aoi.py observed.py weather_bundle.py pipeline.py
      spread/   moisture.py behavior.py engine.py ensemble.py validate.py
      api/      app.py jobs.py live.py
      cli.py
    scripts/  make_fixture.py  serve_fixture.py
    tests/
  web/
    package.json vite.config.ts tsconfig*.json index.html
    scripts/shot.mjs                     Playwright screenshot tool
    src/
      main.tsx App.tsx
      api/types.ts (Contract, mirrors §5/§6)  api/client.ts
      state/store.ts (Contract §9.2)
      lib/raster.ts lib/geo.ts lib/time.ts lib/format.ts lib/fuels.ts
      scene/…  ui/…  styles/…
  data/            gitignored; FIRE3D_DATA_DIR overrides
    cache/         shared HTTP and file cache; FIRE3D_CACHE_DIR overrides
    incidents/{id}/  bundles
```

## 4. Conventions (Contract)

### 4.1 Coordinates
- Each incident has an **AOI**: a square in the incident's standard UTM zone (brief 3): EPSG
  `32600 + floor((lon + 180) / 6) + 1` of the centre longitude, zones 10-19 across the lower 48. California is
  unchanged: EPSG:32610 if the centre longitude is < −120°, else EPSG:32611. It is centered at (`center_e`,
  `center_n`) with side `extent_m`.
- Two grids cover exactly that extent:
  - **render grid** 1024 × 1024: elevation and trees.
  - **fire grid** M × M: fuels, canopy, burn scar, every fire raster and the simulation.
    `M = clamp(ceil(extent_m / 30 / 16) * 16, 128, 512)`, so `res = extent_m / M`.
    M is always divisible by 16; the weather grid is 4 × 4.
- Raster arrays are row-major. **Row 0 = NORTH edge, col 0 = WEST edge.** Pixel (r, c) center:
  `e = minx + (c + .5)·res`, `n = maxy − (r + .5)·res`.
- **Local/world coordinates** (all JSON and the frontend use these):
  `x = e − center_e` (east +), `z = −(n − center_n)` (**south +**, Three.js convention), `y` = elevation in metres.
  The frontend multiplies `y` by the vertical exaggeration. One world unit = 1 metre.
- Frontend plane UV: `u = x/extent + 0.5`, `v = 0.5 − z/extent` (v = 1 at the north edge). Every raster covers the
  full extent, so all layers share the same UV regardless of resolution. The frontend raster loader flips rows on
  upload so DataTexture `(u, v)` lines up with plane UV.

### 4.2 Time
- JSON timestamps are integer **epoch milliseconds UTC**, in fields ending `_ms`.
- Raster time values are float32 **hours since `manifest.time_origin_ms`**. **NEVER = 1.0e6** marks a pixel that
  never burns.
- `time_origin_ms = floor_to_hour(started_ms) − 3_600_000`.
- The UI shows each fire's local time with its zone (`summary.time_zone`, never assumed to be Pacific; a point
  without a fire uses `/api/geo/lookup`'s zone; the viewer's zone only as a labelled fallback). Public 12-hour
  ("Aug 14, 5:02 PM PDT"), Command and Forensic 24-hour ("Aug 14, 17:02 PDT") (brief 3, CONTRACT §14.9).

### 4.3 Raster files
`.bin` files are raw little-endian with no header. dtype and shape come from the `LayerInfo` in the manifest.
dtypes: `float32`, `uint8`, `uint16`, `int16`. The API serves them gzip-compressed.

### 4.4 Incident IDs
CAL FIRE rows: `f"{year}-{slug(name)}-{calfire_uid[:6].lower()}"` (year of `Started`), e.g. `2025-eaton-fire-dbfa57`.
NIFC WFIGS rows (brief 3): `f"{UFI year}-{slug(name)}-{IRWIN id[:6].lower()}"` (the `UniqueFireIdentifier` year and
the IRWIN id without braces), e.g. `2025-black-cove-95c3c8`. Every California id keeps resolving; ids nobody lists
(fixtures, local bundles) are served read-only from their manifest and never rebuilt.
Id pinning (CONTRACT 14.2): a CAL FIRE row matched to a WFIGS record that already has a bundle under its WFIGS id
keeps that id; its CAL FIRE id is listed in `aliases` and resolves too (a build by the alias answers 409
"'{alias}' is listed as '{id}'."), and the live loop makes the bundle's summary CAL FIRE's record (§8.7).
WFIGS names in ALL CAPS are title-cased for display, a short run after an apostrophe kept lower case ("DEVIL'S
CANYON" → "Devil's Canyon", "O'NEIL" → "O'Neil"); the slug is the same either way.
`slug`: lowercase, strip, non-alphanumerics → `-`, collapse repeats, trim `-`.
The fixture uses id `fixture-demo`.

### 4.5 Units in the UI (match the reference)
Area in acres (1 ac = 4046.8564224 m²), rate of spread in chains/hour (1 chain = 20.1168 m), wind in mph with a
cardinal direction, temperature in °C, RH %, fuel moisture %, flame length in ft, elevation axis in m.

## 5. Incident bundle (Contract)

```
data/incidents/{id}/
  manifest.json
  layers/elevation.bin          render  float32  m
  layers/fuel.bin               fire    uint8    FBFM40 code (0 = nodata)
  layers/canopy_cover.bin       fire    uint8    percent
  layers/canopy_height.bin      fire    float32  m
  layers/burn_severity.bin      fire    float32  dNBR (optional; nodata −9999)
  layers/observed_arrival.bin   fire    float32  hours since origin, NEVER = 1e6
  layers/naip.jpg               image   JPEG ≤ 4000 px
  layers/sky_view.bin           render  uint8    sky-view factor / ambient occlusion, 0 (enclosed) .. 255 (open sky)
  layers/water.bin              render  uint8    water mask 0..255 (NAIP NDWI ∪ FBFM40 98), soft edges; optional
  layers/trees.bin              points  float32 × 6 per tree: x, y(ground m), z, height_m, crown_radius_m, kind (0 conifer, 1 broadleaf, 2 shrub)
  sim/static.npz                fire    backend only: fuel_model(int16), slope(rise/run), aspect(deg cw from N, downslope-facing),
                                         canopy_cover(0–1), canopy_height(m), canopy_base_height(m), canopy_bulk_density(kg/m³), elevation(m)
  detections.json  perimeters.json  timeseries.json  events.json  weather.json
  forecasts/{run_id}/forecast.json + arrival_p10.bin arrival_p50.bin arrival_p90.bin burn_probability.bin flame_length_p50.bin   (fire grid)
```

### 5.1 TypeScript shapes
The pydantic and TS mirrors must match these.

```ts
type Mode = "live" | "historical";

interface IncidentSummary {
  id: string; name: string; mode: Mode; year: number; calfire_uid: string;
  started_ms: number; updated_ms: number | null; contained_ms: number | null;
  acres: number | null; percent_contained: number | null; is_active: boolean;
  county: string | null; location: string | null; admin_unit: string | null; url: string | null;
  lat: number; lon: number;
  detections_24h: number | null;                       // live only
  bundle_status: "none" | "building" | "ready" | "error";
  bundle_built_ms: number | null;
  // Brief 3 (docs/redesign/CONTRACT.md §14.1). `calfire_uid` is deprecated: the CAL FIRE UniqueId, or "" when the row
  // is not CAL FIRE's record. The new fields are optional in TS until the integration makes the five (R) ones required;
  // the backend always sends them (old manifests and fixtures are filled on read: uid <- calfire_uid, record_source
  // "calfire", record_issuer and agency "CAL FIRE", source_name <- name, active_sources from is_active, state and
  // time_zone from the location; never America/Los_Angeles by default).
  uid?: string;                                        // (R) CAL FIRE UniqueId, or IRWIN id (upper case, no braces)
  record_source?: "calfire" | "wfigs";                 // (R) whose record this row is; absent = "calfire"
  record_issuer?: string;                              // (R) "CAL FIRE" | "<agency code> via NIFC WFIGS" | "NIFC WFIGS (IRWIN)"
  state?: string | null;                               // (R) USPS code of the point of origin (48 states + "DC")
  time_zone?: string;                                  // (R) IANA zone of the reported location, never assumed
  agency?: string | null; agency_code?: string | null; // protecting agency: plain name and verbatim code
  irwin_id?: string | null; unique_fire_id?: string | null; source_name?: string; gacc?: string | null;
  accuracy_region?: "NWCC" | "NRCC" | "GBCC" | "SWCC" | "SACC-SP" | "SACC-SE" | "RMCC" | "EACC" | "ONCC" | "OSCC" | null;
  active_sources?: ("calfire" | "wfigs")[];            // which records call the fire active (California may list both)
  other_records?: OtherRecord[];                       // other agencies' records of the same fire (California rows)
  complex_name?: string | null;                        // a member fire outside California ("Part of the X Complex")
  complex_members?: string[];                          // a CAL FIRE complex row: its NIFC WFIGS member names, verbatim
  aliases?: string[];                                  // other ids that resolve to this row (id pinning)
}

interface OtherRecord {                                // brief 3: another agency's record of the same fire
  source: "calfire" | "wfigs"; id: string; name: string; issuer: string;
  agency: string | null; agency_code: string | null; acres: number | null; percent_contained: number | null;
  is_active: boolean; updated_ms: number | null; url: string | null;
}

interface LayerInfo {
  file: string;                                        // path relative to the bundle dir
  grid: "render" | "fire" | "image" | "points";
  dtype: "float32" | "uint8" | "uint16" | "int16" | "jpeg";
  width?: number; height?: number; count?: number;     // count for points
  units?: string; nodata?: number; min?: number; max?: number;
  description: string;
}

interface ForecastSummary {
  run_id: string; status: "running" | "ready" | "error";
  issued_ms: number; start_ms: number; horizon_h: number;
  ensemble: "gfs025" | "ecmwf_ifs025" | "perturbed" | "none"; members: number;
  file: string;                                        // "forecasts/{run_id}/forecast.json"
}

interface IncidentManifest {
  schema_version: 1;
  id: string; name: string; mode: Mode; status: "building" | "ready" | "error";
  summary: IncidentSummary;
  time_origin_ms: number;
  time_range: {
    start_ms: number; end_ms: number;
    now_ms: number;              // latest observation of the fire. Live: the newest of its detections, mapped perimeters and
                                 // confirmed satellite passes over it that saw no new fire (§8.3); historical: end_ms
    last_detection_ms?: number;  // live: newest detection or mapped perimeter (the burned area is known up to here)
    last_pass_ms?: number;       // live: newest confirmed VIIRS/MODIS pass over the fire, whatever it saw
  };
  grid: {
    crs: string; utm_zone: number; center_e: number; center_n: number; extent_m: number;
    bbox_lonlat: [number, number, number, number];     // w, s, e, n
    render: { width: number; height: number; res_m: number };
    fire:   { width: number; height: number; res_m: number };
    elev_min_m: number; elev_max_m: number;
  };
  layers: Record<string, LayerInfo>;  // keys: elevation fuel canopy_cover canopy_height burn_severity? observed_arrival naip sky_view water? trees
  ignition: { x: number; z: number; lat: number; lon: number; t_ms: number; source: string } | null;
  default_profile_path: [number, number][];            // local [x, z] polyline (ignition → main run)
  fuels_edition: string;                               // e.g. "LF2024"
  data_sources: { name: string; detail: string; fetched_ms: number }[];
  stats: { final_acres_observed: number; detections: number; perimeters: number };
  forecasts: ForecastSummary[];                        // newest first
  warnings: string[];
  built_ms: number;                                    // also the cache-buster: fetch files with ?v={built_ms}
}

interface DetectionsFile { detections: {
  t_ms: number; lat: number; lon: number; x: number; z: number; frp: number | null;
  satellite: string; instrument: "VIIRS" | "MODIS" | "GOES" | "LANDSAT"; confidence: string; daynight: "D" | "N"; footprint_m: number }[] }
  // GOES rows are thinned to ≤ 1 per 10 min per ~2 km cell (keep max FRP) to keep the file small.

interface PerimetersFile { perimeters: {
  t_ms: number; acres: number; source: string; rings: [number, number][][] }[] }   // local x,z; ≤ 1500 vertices each; cumulative/monotone

interface TimeseriesFile {
  step_h: 1; t_ms: number[];                           // hourly, time_range.start_ms .. now_ms
  area_acres: number[]; growth_acres_per_h: number[]; ros_ch_per_h: number[]; detections_per_h: number[];
  frp_mw_per_h?: number[];                             // hourly mean total FRP (MW) of this fire, GOES-based when available (else VIIRS/MODIS)
}

type EventType = "ignition" | "rapid_growth" | "spot_fire" | "ridge_crossing" | "containment" | "peak_wind" | "wind_shift" | "perimeter_update";
interface EventsFile { events: {
  id: string; type: EventType; t_ms: number; title: string; detail: string;
  x?: number; z?: number; confidence: "observed" | "estimated" | "probable"; source: string }[] }

interface WeatherFile {
  source: string;                                      // e.g. "open-meteo:gfs_hrrr" or "open-meteo:historical-forecast:gfs_hrrr"
  t_ms: number[];                                      // hourly
  at_fire: {
    temp_c: number[]; rh_pct: number[]; dewpoint_c: number[];
    wind_speed_ms: number[]; wind_dir_deg: number[];   // FROM direction
    wind_gust_ms: number[]; precip_mm: number[];
    fm1_pct: number[]; fm10_pct: number[]; fm100_pct: number[];
    ffwi: number[];                                    // Fosberg Fire Weather Index
    flame_length_ft?: number[]; ros_ch_per_h_potential?: number[];  // added by spread/behavior.py
  };
  grid: { nx: 4; ny: 4; x: number[]; z: number[]; u_ms: number[]; v_ms: number[] };  // u,v flattened [t][j][i]; j row north→south; u east+, v north+
  forecast_from_ms: number | null;                     // first hour that is forecast rather than (re)analysis
}

interface ForecastManifest {
  run_id: string; incident_id: string; status: "running" | "ready" | "error"; error?: string;
  issued_ms: number; start_ms: number; horizon_h: number; time_origin_ms: number;
  model: { engine: "pyretechnics"; version: string; surface_lw_ratio_model: string; crown: boolean; spotting: boolean; spread_adjustment: number; grid_res_m: number };
  weather: { source: string; ensemble: "gfs025" | "ecmwf_ifs025" | "perturbed" | "none"; members: number };
  layers: { arrival_p10: LayerInfo; arrival_p50: LayerInfo; arrival_p90: LayerInfo; burn_probability: LayerInfo; flame_length_p50: LayerInfo };
  series: { t_ms: number[]; area_acres_p10: number[]; area_acres_p50: number[]; area_acres_p90: number[]; ros_ch_per_h_p50: number[] };
  skill?: { lead_h: number; sorensen: number; observed_acres: number; forecast_acres_p50: number;
            growth_sorensen?: number | null }[];   // historical runs only; growth_sorensen: brief 3 (CONTRACT §14.12.7)
  runtime_s: number; warnings: string[];
}
```

**Arrival-quantile semantics:** `arrival_pK` is the K-th percentile, across members, of each pixel's arrival time,
counting members that never reach the pixel as +∞ (stored as NEVER).
So `P(burned by t) ≥ K%` ⇔ `arrival_pK ≤ t`. `burn_probability` = fraction of members burned by `start + horizon`.

## 6. HTTP API (Contract)

FastAPI on port **8710** (`fire3d.api.app:app`). Vite proxies `/api` there by default (`VITE_API_TARGET` overrides).
**Port 8000 is NOT ours:** an unrelated local app (the user's MeetingPipelines uvicorn) permanently listens on
127.0.0.1:8000, and 8765 is also busy. Never stop those processes. Fire-3d's default API port is **8710**
everywhere: `vite.config.ts` default proxy target `http://localhost:8710`, `dev.sh`, the CLI `serve` default,
and README.

| Method | Path | Response |
|---|---|---|
| GET | `/api/health` | `{ok: true, version}` |
| GET | `/api/incidents?mode=live\|historical&min_acres=300&year=<current UTC year>&state=` | `{mode, updated_ms, incidents: IncidentListRow[], year?, sources?}`. **Brief 3 (CONTRACT §14.1, §14.2):** the lower 48 states + DC from NIFC WFIGS, with CAL FIRE as the record in California (WFIGS adds only the California fires CAL FIRE does not list; a California fire is active when either agency says so; a CAL FIRE complex is one row). Live: every active wildfire in the lower 48, whatever its size, sorted by `detections_24h` then acres. Historical: the wildfires of `year` (default: the current UTC year) of `min_acres` (default 300) or more, by acres. Prescribed burns, complex parents outside California, Alaska, Hawaii and territories are never listed. `state` (USPS code) filters rows. `sources[]` (`ListSource`: `id` "calfire" \| "wfigs", `name`, `status` "available" \| "unavailable", `retrieved_ms`, `reason`) says which lists answered; with WFIGS down only California (CAL FIRE) is listed, with CAL FIRE down California's WFIGS rows still list. gzip when the request accepts it (`Vary: Accept-Encoding`). Brief 2 text, still true for California: `{mode, updated_ms, incidents: IncidentListRow[], year?}`. Historical: CAL FIRE's list of `year` (default 2025; e.g. `year=2026` for the current season, refreshed every 30 min and overlaid with the fresher live-list records), default `min_acres=300`, sorted by acres desc; every row keeps mode `"historical"` (`is_active` says whether CAL FIRE still lists the fire as active; `/api/incidents/{id}` resolves such a fire as live); the response says which `year` it lists. Live: all active `Type ∈ {Wildfire, Fire}` incidents, sorted by `detections_24h` then acres (`year` is ignored). Rows (BRIEF-2) are `IncidentSummary` + `bbox_lonlat: [w, s, e, n] \| null`: the analysis area (`manifest.grid.bbox_lonlat`) of a ready bundle, else null. |
| GET | `/api/incidents/{id}` | `{summary: IncidentSummary, manifest: IncidentManifest \| null, job: JobStatus \| null}` |
| POST | `/api/incidents/{id}/build?force=false` | `JobStatus`. Builds or rebuilds the bundle in the background; returns the existing job if one is running. Brief 3 (CONTRACT §14.2): an id is buildable only when a CAL FIRE or NIFC WFIGS list knows it (never a manifest alone) and its state is in the lower 48 + DC: unknown id 404 "unknown incident"; Alaska, Hawaii or a territory 422 "Fire-3d does not support Alaska, Hawaii or US territories yet."; a local or synthetic bundle (`fixture-demo`, `fixture-east`) 409 "'{id}' is a local or synthetic bundle; it cannot be rebuilt." (a non-forced build of a ready one returns it untouched). |
| POST | `/api/incidents/{id}/forecast` body `{start_ms?: number, horizon_h?: number = 72, ensemble?: "auto" \| "gfs025" \| "ecmwf_ifs025" \| "perturbed" \| "none", members?: number}` | `JobStatus`. Default `start_ms`: live = `time_range.now_ms`, the latest observation of the fire: a confirmed satellite pass after the last detection counts (§8.3), so a fire that went quiet starts at the latest pass with its last mapped area, not at its last detection; historical = 24 h after ignition. `"auto"`: live → gfs025, historical → perturbed. |
| GET | `/api/jobs/{job_id}` | `JobStatus` |
| GET | `/api/bundles/{id}/{path:path}` | Static bundle files, gzip, `Cache-Control: no-cache` + ETag. Path traversal must be impossible. |
| GET | `/api/incidents/{id}/aircraft?all=0` | `{updated_ms, source: "adsb.lol" \| "adsb.fi", radius_nm, aircraft: Aircraft[], note?}`. `source` names the provider that answered (adsb.fi is the fallback while adsb.lol is unreachable). Live incidents only (historical → empty list plus a note). Every provider failing or rate-limited → empty list plus a note (never an error status). Cached 10 s. |
| GET | `/api/live/status` | `{last_refresh_ms, next_refresh_ms, active_incidents, detections_24h_ca, auto_build, detections_24h?}`. Brief 3: `detections_24h` = keyless FIRMS feed rows of the last 24 h inside the lower-48 state polygons; `detections_24h_ca` (California) stays for one release; `active_incidents` = the live list length. |
| GET | `/api/geo/lookup?lon=&lat=` | Brief 3 (CONTRACT §14.3). `GeoLookup` `{lon, lat, coverage: "lower48" \| "alaska" \| "hawaii" \| "territory" \| "outside_us", supported, state, state_name, county: {fips, name} \| null, time_zone, time_zone_name, note}`: offline (Census TIGERweb states and counties, USDOT BTS NTAD time zones with the Navajo Nation and Hopi Reservation). `note` is the coverage sentence when not supported. 400 on bad numbers; `Cache-Control: public, max-age=86400`. |
| GET | `/api/accuracy-regions` | Brief 3 (CONTRACT §14.4). `AccuracyRegionsResponse`: `backend/fire3d/data/regional_accuracy.json` (schema 1) plus `served_ms`; all ten regions (NWCC, NRCC, GBCC, SWCC, SACC-SP, SACC-SE, RMCC, EACC, ONCC, OSCC), a region missing from the file served as `untested`. Status: `tested` with >= 2 fires and >= 16 scored leads, else `limited` with >= 1 fire, else `untested`. `Cache-Control: no-cache`. |
| GET | `/api/geocode?q=<US street address \| US town \| ZIP code \| county>` | Brief 3 (CONTRACT §14.10): local matches come from `backend/fire3d/data/gazetteer_us.json` (2026 Census Gazetteer Files, every state; replaces `gazetteer_ca.json`); each gains `state`, `state_name`, `county`, `supported` (false in Alaska, Hawaii, territories), `name`/`matched_address` "<Name>, <ST>", `place_type` (Census LSAD in plain words) and `place_type_label`; "Springfield, IL", "Springfield IL", "83702 ID" parse; no match: "No US city, town, county or ZIP code matches '<q>'." Brief 2 text: Map-first redesign (shapes in docs/redesign/CONTRACT.md §6 and §13 location). A street address (house number first) is proxied to the US Census Geocoder (`Public_AR_Current`, cached 30 days); a California town or a 5-digit ZIP code is matched locally in `backend/fire3d/data/gazetteer_ca.json` (2026 Census Gazetteer Files, no upstream call; replies say `kind` and `local: true`). Coordinates are parsed by the browser (400 here). 503 when the local index is missing. |
| GET | `/api/extras/{evacuations,cameras,cameras/latest,imagery,sources}` | Optional official and public sources (CONTRACT §12.1): Cal OES evacuation zones, public cameras, recent satellite imagery; `?incident=<id>` or `?bbox=w,s,e,n`. Upstream failures answer 200 with an honest status, never invented data. Brief 3 (CONTRACT §14.8): evacuations come from a state registry (Cal OES in California, Oregon OEM in Oregon); every other state answers `unavailable` + `reason_code: "state_not_available"` without an upstream request ("Official evacuation zones are not available in this state ({State}). Follow local officials."); the answer adds `states[]` and per-source fields. Cameras outside California answer `state_not_available`. |
| GET | `/api/official/calfire?incident={id}` | BRIEF-2. `CalFireOfficial`: CAL FIRE's current record of the incident (its own numbers and `Updated` time), every change of acres, containment, active or final status Fire-3d has recorded since it first checked (append-only `data/official/calfire/<UniqueId>.jsonl`, outside the bundles), and caveats. Each call is a check and records the current record. Past fires have only CAL FIRE's final record. Brief 3 (§14.5): a fire whose `record_source` is "wfigs" answers `unavailable` + `not_covered` ("CAL FIRE does not list this fire; its official record is published by NIFC WFIGS."); any listed id resolves (no 404 for a listed fire without a bundle). |
| GET | `/api/official/fire-weather?incident={id}&at_ms=&margin_km=15` | BRIEF-2. `FireWeather`: NWS Red Flag Warnings and Fire Weather Watches whose zones meet the incident's analysis area + `margin_km`, verbatim, with `covers_reported_location` and `nearest_km`. The present (no `at_ms`, or within 6 h of now, or later): the live NWS list (one statewide request, cached 2 min; zone polygons cached 30 days). An older `at_ms`, or any `at_ms` of a historical incident: the Iowa Environmental Mesonet archive (`archived: true`); a historical incident without `at_ms`, or an archive failure, is `not_available_for_past_dates`, never "no alerts". Without `incident`: every current California alert.  Brief 3 (§14.6): one cached national request (`area=` the 48 states + DC); per fire, alerts are kept only when a UGC's state is in the fire's states before any zone loads. Adds `states_checked` (the states this answer covers; absent = ["CA"]), `alert_states`, and each alert's `time_zone`. |
| GET | `/api/official/incident-record?incident={id}` | Brief 3 (CONTRACT §14.5). `IncidentRecord`: the fire's NIFC WFIGS (IRWIN) record (WFIGS rows and California rows matched to one WFIGS record) with the protecting agency, its own times and a link. A California row without a match, one matched to several records none of which has its name (the reason names them), a CAL FIRE complex row and a synthetic or local bundle answer `unavailable` + `not_covered` with their reasons; an unknown id is 404; WFIGS down is `upstream_error`. |
| GET | `/api/official/local-alerts?incident={id}&at_ms=&margin_km=15` or `?bbox=w,s,e,n` | Brief 3 (CONTRACT §14.7). `LocalAlerts`: local officials' messages relayed by the NWS (live and the last 7 days) and FEMA's IPAWS archive via OpenFEMA (older days, labelled archived), verbatim, each with a `source_url`. `incident` xor `bbox` (else 400); unknown incident 404. |

```ts
interface JobStatus {
  id: string; kind: "build" | "forecast" | "refresh"; incident_id: string;
  status: "queued" | "running" | "done" | "error"; progress: number /* 0..1 */; step: string; message: string;
  created_ms: number; started_ms: number | null; finished_ms: number | null; error: string | null; result: any | null;
}
interface Aircraft {
  hex: string; callsign: string | null; registration: string | null; type: string | null;
  category: "airtanker" | "helicopter" | "air_attack" | "lead_plane" | "other_fire" | "unknown";
  is_fire_aircraft: boolean; reason: string;
  lat: number; lon: number; x: number; z: number;
  alt_m: number | null; agl_m: number | null; gs_kt: number | null; track_deg: number | null;
  seen_s: number; on_ground: boolean;
}
```

Official endpoints (BRIEF-2; built in `backend/fire3d/api/official.py`, details in `docs/redesign/CONTRACT.md` §13). An upstream failure is not an HTTP error: they answer 200 with `status: "unavailable"` (or `"not_available_for_past_dates"` for the archive). Errors: 400 bad id, 404 unknown incident, 422 bad query, 429 Fire-3d's own request limit (NWS 30/min, IEM 30/min). JSON is `Cache-Control: no-store`.

```ts
interface IncidentListRow extends IncidentSummary { bbox_lonlat: [number, number, number, number] | null }
interface OfficialEnvelope {
  kind: "calfire" | "fire_weather" | "incident_record" | "local_alerts";      // brief 3 widened
  status: "available" | "unavailable" | "not_available_for_past_dates";
  reason_code: "past_date" | "upstream_error" | "not_covered" | "state_not_available" | null; reason: string | null;
  source: { name: string; url: string; credit: string; license?: string; terms_url?: string };
  retrieved_ms: number | null;        // when Fire-3d fetched it from the source
  source_updated_ms: number | null;   // the source's own update time
  requested_at_ms: number | null; now_ms: number; incident_id: string | null; caveats: string[];
}
interface CalFireOfficial extends OfficialEnvelope {
  incident_url: string | null; agencies: string | null;   // CAL FIRE's AgencyNames, verbatim
  current: { acres: number | null; percent_contained: number | null; is_active: boolean; final: boolean;
             updated_ms: number | null; extinguished_ms: number | null } | null;
  changes: { updated_ms: number | null; seen_ms: number; acres?: [number | null, number | null];
             percent_contained?: [number | null, number | null]; is_active?: [boolean, boolean]; final?: [boolean, boolean] }[];
  recording_since_ms: number | null;
}
interface FireWeatherAlert {
  id: string; url: string | null; office_url: string | null; event: "Red Flag Warning" | "Fire Weather Watch";
  vtec: { office: string; phenomena: string; significance: string; etn: number; action: string } | null;
  sender_name: string | null; sent_ms: number | null; effective_ms: number | null; onset_ms: number | null;
  expires_ms: number | null; ends_ms: number | null;
  headline: string | null; nws_headline: string | null; description: string | null; instruction: string | null;
  area_desc: string | null; ugcs: string[]; message_type: string | null; status: string;
  covers_reported_location: boolean | null; nearest_km: number | null; archived: boolean;
  phase: "upcoming" | "in_effect" | "ended";
  time_zone?: string | null;          // (R) brief 3: IANA zone of the alert's first zone, else its state's main zone
}
interface FireWeather extends OfficialEnvelope {
  alerts: FireWeatherAlert[];
  zones: GeoJSON.FeatureCollection;   // simplified outlines; properties { ugc, name, alert_ids }
  area_bbox: [number, number, number, number] | null; reported_location: [number, number] | null;   // lon, lat
  states_checked?: string[];          // (R) brief 3: the states this answer covers; absent = ["CA"]
  alert_states?: string[];            // (R) brief 3: the states with at least one alert in this answer
}
// Brief 3 (CONTRACT §14.5, §14.7)
interface IncidentRecord extends OfficialEnvelope {          // kind "incident_record"
  record_source: "wfigs"; irwin_id: string | null; unique_fire_id: string | null; publisher: "NIFC WFIGS (IRWIN)";
  agency_code: string | null; agency: string | null; protecting_unit: string | null; state: string | null;
  county: string | null; time_zone: string; incident_url: string | null; dataset_url: string;
  current: { name: string; acres: number | null; percent_contained: number | null; is_active: boolean;
             discovered_ms: number | null; contained_ms: number | null; controlled_ms: number | null; out_ms: number | null;
             updated_ms: number | null; ics209_report_ms: number | null } | null;
  complex: { name: string; id: string | null } | null;
  changes: [];                        // history outside California is deferred
  recording_since_ms: null;
}
interface LocalAlerts extends OfficialEnvelope {             // kind "local_alerts"
  alerts: LocalAlert[];               // fields in CONTRACT §14.7 (id = CAP identifier, channel "nws_api" | "openfema_archive",
                                      // archived, event, event_code, message_type, references, sender_name, sender_is_platform,
                                      // sent/effective/onset/expires_ms, headline, description, instruction, wea_text,
                                      // wea_long_text, web, source_url (always, https), area_desc, same_codes, ugcs, polygon,
                                      // match, covers_reported_location, nearest_km, time_zone, phase)
  channels: { id: "nws_api" | "openfema_archive"; status: "available" | "unavailable" | "pending" | "not_checked";
              retrieved_ms: number | null; source_updated_ms: number | null; reason: string | null }[];
  area_bbox: [number, number, number, number] | null; reported_location: [number, number] | null;
  counties: { fips: string; name: string; state: string }[];
}
```

## 7. Backend modules (Contract)

### 7.1 `fire3d/types.py` (shared dataclasses, written by scaffold)
```python
@dataclass
class BuildContext:
    summary: IncidentSummary            # pydantic model from contracts.py
    bundle_dir: Path
    render_grid: Grid
    fire_grid: Grid
    time_origin_ms: int
    mode: Literal["live", "historical"]
    progress: Callable[[str, float, str], None]  # (step, fraction 0..1 within step, message)
    fire_bbox_lonlat: tuple[float, float, float, float] | None = None
    end_ms: int | None = None           # time_range.end_ms once known
    now_ms: int | None = None

@dataclass
class StaticInputs:                     # fire grid; loaded from sim/static.npz
    fuel_model: np.ndarray              # int16 FBFM40 codes
    slope: np.ndarray                   # float32 rise/run
    aspect: np.ndarray                  # float32 deg clockwise from N, the direction the slope FACES (downslope)
    canopy_cover: np.ndarray            # float32 0–1
    canopy_height: np.ndarray           # float32 m
    canopy_base_height: np.ndarray      # float32 m
    canopy_bulk_density: np.ndarray     # float32 kg/m³
    elevation: np.ndarray               # float32 m
    res_m: float

@dataclass
class MemberWeather:                    # one ensemble member; hourly on the 4×4 weather grid
    t_ms: np.ndarray                    # (T,) int64 hourly
    wind_speed_10m_kmh: np.ndarray      # (T, 4, 4)
    upwind_dir_deg: np.ndarray          # (T, 4, 4) FROM direction, deg clockwise from N
    temp_c: np.ndarray                  # (T, 4, 4)
    rh_pct: np.ndarray                  # (T, 4, 4)
    fm1: np.ndarray; fm10: np.ndarray; fm100: np.ndarray   # (T, 4, 4) kg/kg (fractions)
    fm_live_herb: float; fm_live_woody: float; foliar_moisture: float   # kg/kg
    label: str                          # "control", "member07", "perturbed-03" …

@dataclass
class SpreadSettings:
    spread_adjustment: float = 1.0
    surface_lw_ratio_model: str = "behave"
    crown: bool = True
    spotting: bool = False
    max_cells_per_timestep: float = 0.4

@dataclass
class MemberResult:
    label: str
    arrival_h: np.ndarray               # float32 (M, M) hours since time_origin, NEVER = 1e6
    flame_length_m: np.ndarray          # float32 (M, M), 0 where unburned
    fire_type: np.ndarray               # uint8 (M, M) 0 unburned, 1 surface, 2 passive crown, 3 active crown
    runtime_s: float
```

### 7.2 `fire3d/grid.py` (scaffold)
```python
@dataclass(frozen=True)
class Grid:
    epsg: int; center_e: float; center_n: float; extent_m: float; width: int; height: int
    res_m: float                       # property
    bounds: tuple[float, float, float, float]  # property: (minx, miny, maxx, maxy) in UTM
    transform: Affine                  # property (rasterio)
    def with_size(self, w: int, h: int) -> "Grid": ...
    def en_to_local(self, e, n) -> tuple[x, z]: ...
    def local_to_en(self, x, z) -> tuple[e, n]: ...
    def lonlat_to_local(self, lon, lat) -> tuple[x, z]: ...      # vectorized
    def local_to_lonlat(self, x, z) -> tuple[lon, lat]: ...
    def lonlat_to_rowcol(self, lon, lat) -> tuple[row, col]: ... # float, vectorized
    def bbox_lonlat(self) -> tuple[w, s, e, n]: ...
    def cell_centers_local(self) -> tuple[X, Z]: ...             # 2-D arrays
def utm_epsg_for(lon: float) -> int
def make_aoi(center_lon, center_lat, fire_bbox_lonlat | None, mode) -> tuple[Grid, Grid]   # (render 1024², fire M²) per §8.1
def weather_points(grid: Grid) -> list[tuple[lat, lon]]          # 4×4 cell centers, row-major from the north-west
```

### 7.3 Module functions (owners in brackets)
```python
# sources/terrain.py      [terrain]  fetch_dem(grid) -> np.float32 (H, W)
# sources/landfire.py     [terrain]  fetch_landfire(grid, edition, layers=("FBFM40","CC","CH","CBH","CBD","EVT")) -> dict[str, np.ndarray]  (raw int16)
# sources/imagery.py      [terrain]  fetch_naip(grid, max_px=4000) -> tuple[bytes, int, int]
# sources/sentinel.py     [terrain]  compute_dnbr(grid, pre_window_ms, post_window_ms) -> tuple[np.ndarray | None, dict]
# build/aoi.py            [terrain]  build_static_layers(ctx) -> None  # elevation, fuel, canopy_*, naip, trees, burn_severity, sim/static.npz; updates manifest
# sources/calfire.py      [firedata] list_live() -> list[dict]; list_year(year) -> list[dict]
# sources/firms.py        [firedata] load_year_ca(year) -> pd.DataFrame; load_live_ca(days=7) -> pd.DataFrame
#                                    columns: t_ms, lat, lon, frp, satellite, instrument, confidence, daynight, scan, track
# sources/perimeters.py   [firedata] fetch_perimeters(name, lat, lon, start_ms, end_ms) -> list[dict(t_ms, acres, geometry: shapely (lon/lat), source, category)]
# catalog.py              [firedata] get_catalog(mode, min_acres=None, refresh=False) -> list[IncidentSummary]; get_summary(incident_id) -> IncidentSummary | None
#                                    estimate_fire_bbox(summary) -> tuple | None
# build/observed.py       [observed] build_observed(ctx) -> None  # detections, perimeters, observed_arrival, timeseries, events, ignition, default_profile_path, time_range
# sources/weather.py      [weather]  class WeatherSource(Protocol); class OpenMeteoSource
#                                    .deterministic(points, start_ms, end_ms) -> dict;  .ensemble(points, start_ms, end_ms, model) -> dict | None
# build/weather_bundle.py [weather]  build_weather(ctx) -> None (weather.json)
#                                    member_weathers(bundle_dir, start_ms, horizon_h, ensemble, members=None) -> list[MemberWeather]
# spread/moisture.py      [weather]  dead_fuel_moisture(temp_c, rh_pct, dt_h=1, init=None) -> (fm1, fm10, fm100) fractions
#                                    live_fuel_moisture(month) -> (herb, woody); emc(temp_c, rh_pct); ffwi(temp_c, rh_pct, wind_ms)
# spread/behavior.py      [spread]   surface_behavior(fuel_code, fm..., wind_10m_kmh, slope) -> dict; annotate_weather_with_behavior(bundle_dir) -> None
# spread/engine.py        [spread]   load_static_inputs(bundle_dir) -> StaticInputs
#                                    run_member(static, weather, ignition_mask, start_ms, horizon_h, time_origin_ms, settings) -> MemberResult
# spread/ensemble.py      [spread]   run_forecast(bundle_dir, start_ms=None, horizon_h=72, ensemble="auto", members=None, progress=None) -> ForecastManifest
# spread/validate.py      [spread]   sorensen(a_mask, b_mask) -> float; hindcast_skill(forecast_dir, observed_arrival, ...) -> list[dict]
# sources/aircraft.py     [api]      fetch_aircraft(lat, lon, radius_nm) -> list[dict]; classify(ac, context) -> (category, is_fire, reason)
# build/pipeline.py       [api]      build_incident(incident_id, progress=None, force=False) -> IncidentManifest; refresh_live(incident_id) -> bool
# api/app.py, api/jobs.py, api/live.py, cli.py   [api]
```

## 8. Algorithms (Guidance)

### 8.1 AOI sizing (`grid.make_aoi`)
- Fire bbox:
  - Historical: final perimeter ∪ the detection cluster belonging to this fire.
  - Live: current perimeter ∪ the last-7-day detection cluster.
  - Fallback: a circle of radius `sqrt(acres·4046.86/π)` around the CAL FIRE point (min 1 km).
  - `catalog.estimate_fire_bbox` computes it.
- Margin: historical 2,000 m, live 6,000 m (room to grow).
- `extent = clamp(ceil((max(w, h)·1.3 + 2·margin) / 1000)·1000, min_extent, 60000)`, with min_extent 8,000 m
  historical and 16,000 m live. Centered on the bbox center.

### 8.2 Static layers (`build/aoi.py`)
- **DEM:** one exportImage at 1024² (render). Also derive the fire-grid elevation by area-averaging, or a second
  request at M². Slope (rise/run) and aspect go on the fire grid; `numpy.gradient` with `res_m` is fine.
  Aspect = the downslope-facing direction, degrees clockwise from north. Sanity-check it on a synthetic plane.
- **LANDFIRE:** request at M² with nearest neighbour.
  - Scale: CH and CBH ÷ 10 → m; CBD ÷ 100 → kg/m³; CC ÷ 100 → fraction (keep percent in `canopy_cover.bin`).
  - Nodata/negative → non-burnable 99 for fuel, 0 for canopy.
  - Edition (`landfire.edition_for`): historical = the pre-fire edition LF{FY − 1} of the start's federal fiscal year, at least LF2023 (`landfire_gate`: before October 2023 → 422 unless forced; forced builds use LF2023 with a "LANDFIRE:" warning); live = LF2025. A failed edition falls back to the next older one only (LF2025 → LF2024 → LF2023, never forward). An edition with no fuel code in the AOI, or with no fuel code on more than 2 % of the land cells (inside the lower-48 + DC state polygons, elevation above 0.5 m), switches the whole bundle to the next older edition with the warning "LANDFIRE: LANDFIRE 2025 is not released here yet; LANDFIRE 2024 used" (other editions: "LANDFIRE <E> has no fuel data for <p>% of the land here; LANDFIRE <older> used"). Ground outside the US without fuel data stays fuel 99 and is labelled "outside fuel data coverage: not modeled (unknown, not low)"; stats gain `nodata_land_frac` and `outside_coverage_cells`.
- **NAIP:** `size = min(4000, max(2048, extent/3))` px square, JPEG.
- **Sky-view factor** (`sky_view.bin`, render grid): horizon-based ambient occlusion from the DEM.
  - 16 azimuths, march out to ~1.5 km with geometric step growth; SVF = mean over azimuths of cos²(horizon angle);
    scale to 0–255.
  - Vectorized numpy over shifted arrays: a few seconds at 1024². Verify that valleys are darker than ridges in a
    quick-look.
- **Water mask** (`water.bin`, render grid, optional):
  - Source 1: NAIP green + NIR from exportImage with `bandIds=1,3` (G, NIR), `format=tiff`, 1024², uint8.
    NDWI = (G − NIR)/(G + NIR); water where NDWI > ~0.15, slightly blurred for soft edges.
  - Source 2: FBFM40 code 98 (open water), upsampled. Union the two.
  - On failure, write fuel-98 only plus a warning.
- **Trees:** jittered placement per fire cell.
  - Count ~ Poisson(cc_frac · k), with k tuned so the total is ≤ 120,000.
  - Height = CH × U(0.7, 1.1), with a floor of 3 m where cc > 0.
  - Crown radius = clamp(0.28·h, 1.5, 9).
  - Kind:
    - FBFM 161–165 and 181–189 → conifer (0);
    - else broadleaf (1) if CH ≥ 5 m;
    - shrub fuels 141–149 → shrub (2), with a few low shrubs even where cc = 0 (density ∝ shrub cover) so chaparral
      reads as scrub.
  - y = bilinear DEM at (x, z).
- **dNBR** (historical; best-effort for live):
  - Pre-fire scene: least cloudy in [start − 60 d, start − 1 d].
  - Post-fire scene: least cloudy in [end + 3 d, end + 60 d]; live: last 10 days.
  - Mosaic tiles if needed. NBR = (B08 − B12)/(B08 + B12) after scale/offset; mask clouds with SCL (3, 8, 9, 10, 11).
  - dNBR = NBR_pre − NBR_post.
  - After the observed reconstruction, pixels farther than 1 km from this incident's burned area become nodata
    (`pipeline.mask_burn_severity`): the post-fire window can hold other fires' scars and harvested fields.
  - On failure, write nothing and add a manifest warning.

### 8.3 Observed arrival-time reconstruction (`build/observed.py`)
1. **Detections for this fire:**
   - **With the key (primary):** the FIRMS area API over the AOI bbox (§2), in 5-day chunks (GOES: 2-day chunks),
     for t ∈ [start − 12 h, end].
     - Historical sources: `VIIRS_SNPP_SP`, `VIIRS_NOAA20_SP`, `VIIRS_NOAA21_SP`, `MODIS_SP`, `LANDSAT_NRT`,
       `GOES_NRT`.
     - Live sources: the matching NRT sources, plus SP for dates before NRT coverage.
   - **Without the key (fallback):** historical = yearly SNPP + MODIS; live = the four 7d feeds.
   - **Filters:**
     - Drop `type == 1` (volcano) only.
     - Drop VIIRS confidence "l", MODIS confidence < 30, and GOES confidence < 50 (and `*FRP` duplicate rows).
   - **GOES** contributes timing (ignition refinement, `frp_mw_per_h`, `detections_per_h`) and may add intermediate
     snapshot times when it shows clear growth between VIIRS passes. It never contributes to the spatial mask.
   - Cluster in space-time (eps ≈ 1.5 km, 2 days) and keep clusters connected to the ignition/perimeter. This removes
     other fires inside the AOI.
   - Footprint: VIIRS ≈ 375 m × (scan, track); MODIS ≈ 1 km × (scan, track); LANDSAT 30 m; GOES ≈ 2 km (timing
     only).
2. **Perimeters:**
   - Fetch: California records as §2; other fires by IRWIN id, else name + state (§2).
   - Dedupe per timestamp (keep the latest edit, i.e. max `poly_DateCurrent`).
   - Make them cumulative: each perimeter = union with all earlier ones.
   - Drop ones that shrink by more than 20%; flag them.
   - Simplify to ≤ 1500 vertices.
3. **Final burned mask F:**
   - Use the latest/largest perimeter when available, ∪ detection footprints within 300 m of it.
   - Otherwise use the union of footprints shrunk by ~⅓ to reduce VIIRS bloat.
4. **Snapshots:**
   - Snapshot times = perimeter times ∪ detection overpasses (detections grouped within 30 min).
   - `B_k` = (perimeters with t ≤ t_k ∪ footprints with t ≤ t_k) ∩ F.
   - Enforce `B_k ⊇ B_{k−1}`.
5. **Arrival per pixel in F:**
   - k\* = the first snapshot containing the pixel.
   - Interpolate between snapshots with the distance-ratio rule:
     `T = t_{k*−1} + (t_{k*} − t_{k*−1}) · d_prev / (d_prev + d_next)`, where
     `d_prev` = EDT distance to `B_{k*−1}` and `d_next` = distance to the outside of `B_{k*}`.
   - For k\* = 0, use the ignition point at the ignition time.
   - Result: smooth, monotone fronts. Pixels outside F = NEVER.
6. **Ignition:**
   - Use the fire record's point (CAL FIRE in California, NIFC WFIGS/IRWIN elsewhere) at its start time, snapped into the earliest burned region; every text names the record's issuer (`record_issuer`, e.g. "Reported by USFS via NIFC WFIGS Jul 09, 13:32 MDT"), times in the fire's own zone (`summary.time_zone`).
   - If that point is > 3 km from the earliest detections, use their centroid and label the source.
7. **timeseries:**
   - `area(t)` = count(arrival ≤ t)·res² → acres; growth = Δarea.
   - `ros_ch_per_h(t)` = 90th percentile of `1/|∇T|` (m/h) over pixels with arrival in (t − 1 h, t], in chains/h.
     Clamp outliers; use 0 when nothing burned that hour.
8. **events** (≤ ~12 total, each with location and confidence):
   - **ignition**.
   - **rapid_growth:** hours with growth ≥ max(250 ac/h, 3 × the median positive growth); keep events ≥ 12 h
     apart, max 3.
   - **spot_fire (prob.):** a detection > 750 m outside the previous `B_k`; max 3.
   - **ridge_crossing (est.):** the front crosses a prominent ridge, e.g. pixels with TPI > +40 m at ~500 m radius
     forming lines, burned from one side then the other within 12 h.
   - **containment:** from WFIGS `attr_ContainmentDateTime`, or the record at 100% ("{issuer} (100% contained)").
   - **peak_wind:** max gust while the fire grew. This is added in `pipeline.py` after weather is built.
9. `default_profile_path` = [ignition, the farthest burned pixel along the dominant growth direction].
   `time_range`:
   - start = `time_origin_ms`.
   - end: historical = the time 99% of the final area was reached + 24 h (capped at start + 45 d); live = now_ms.
   - now_ms: historical = end. Live = the latest observation of the fire (`build/live_observation.py`):
     - `last_detection_ms` = the newest VIIRS/MODIS/Landsat detection or mapped perimeter of this fire. The burned
       area is known up to here; the observed arrival is clipped to it (no growth is invented after it).
     - Satellite passes over the fire's centroid since then come from NASA CMR (§2). A pass is *confirmed* when its
       granule was published ≥ 30 min before our FIRMS data of the same satellite were fetched (a satellite whose
       FIRMS request failed has no confirmed passes). A confirmed pass after `last_detection_ms` saw no fire above
       the detection limit; `last_pass_ms` = the newest confirmed pass.
     - now_ms = max(`last_detection_ms`, `last_pass_ms`), except when the record's acreage (CAL FIRE or NIFC WFIGS) reported after the last
       detection exceeds 1.25 × the mapped area + 100 ac (the fire grew unseen): then now_ms = `last_detection_ms`
       with a warning. Without CMR (outage) now_ms = `last_detection_ms`, with a warning.
     - Activity too weak or coarse to map area (low-confidence VIIRS/MODIS pixels within 1 km of the burned area,
       GOES detections of this fire on ≥ 2 scans within 1 h) after `last_detection_ms` is stored with the confirmed
       passes in `sim/activity.json` (backend only) for the forecast (§8.5). It never moves now_ms.
     - The `NASA CMR satellite passes` data source explains the decision in plain words.
10. **Data sources:** the data sources list the fire's own record first: "CAL FIRE incidents" or "NIFC WFIGS incident
    record (IRWIN)" (IRWIN id and issuer in `detail`).

### 8.4 Weather and fuel moisture
- **Points:** the 4×4 `weather_points(grid)`.
- **Live:** HRRR (`past_days=3`) filled with `gfs_seamless`.
- **Historical:** historical-forecast HRRR over [start − 72 h, end + 72 h], falling back to the ERA5 archive.
  Chunk long ranges.
- **Fire-local time:** month-dependent values (live fuel moisture rows) use the month in the fire's zone
  (`timeutil.local_month(ms, summary.time_zone)`), never Pacific.
- **Open-Meteo limits** (`sources/weather.py`, `fire3d.http`): a 429 naming a daily, hourly or per-minute limit is never
  retried (a per-minute one is waited out once) and blocks that host in the process until the reset; a blocked host
  answers from the cache or raises `WeatherQuotaExceeded` ("Open-Meteo daily request limit reached; retry after the
  reset (00:00 UTC)"); error bodies (stream errors, cut-off JSON, `{"error": true}`) are never cached and are evicted
  when found. A refused deterministic request fails the build (never ERA5-filled); `build --require-hrrr` also refuses
  ERA5-filled hours and, in California, a missing water-year total. `weather-probe` sends one tiny uncached request
  per host.
- Request `timeformat=unixtime`, `wind_speed_unit=ms`.
- Wind direction is FROM. Convert to u/v for averaging/interpolation:
  `u = −S·sin(dir)`, `v = −S·cos(dir)`.
- **Dead fuel moisture:** EMC (Simard 1968, from °F and RH) → 1-h ≈ 1.03·EMC; 10-h and 100-h are exponential lags
  of EMC with τ = 10 h and 100 h. Spin up over the 72 h before the start.
- **Live fuel moisture** (CA defaults by month, documented and configurable; operational forecasts blend them toward
  the dry-season row when the water year has been dry, see `config.DROUGHT_ADJUSTED_LFM` and docs/validation.md 3.1):
  - Jan–Apr: herb 1.2, woody 1.2
  - May–Jun: herb 0.6, woody 1.0
  - Jul–Oct: herb 0.3, woody 0.7
  - Nov–Dec: herb 0.6, woody 0.9
  - Foliar moisture 1.0.
  - Outside California these California values are used as an interim with the manifest warning "Live fuel moisture
    outside California uses California's seasonal values until a regional method is tested; experimental." and the
    forecast note prefix "Live fuel moisture: California's seasonal values (regional method not tested yet);
    experimental."
- **FFWI:** Fosberg, using EMC (%) and wind (mph).
- `at_fire` = weather interpolated at the ignition/centroid.
- **Ensembles** (`member_weathers`):
  - **gfs025 / ecmwf_ifs025** (live): fetch the members at the 16 points. Bias-correct to HRRR while HRRR exists:
    `x_i = x_hrrr + (x_i − mean_ens)` in u/v/T/RH space, blending to raw members over 6 h after HRRR ends.
  - **perturbed** (historical, or a fallback): 31 members around the deterministic series. Perturbations are AR(1)
    with τ = 8 h:
    - wind speed × lognormal (σ = 0.25)
    - direction + N(0, 20°)
    - RH + N(0, 6%)
    - temperature + N(0, 1.5 °C)
    Seeds are deterministic; member 0 is unperturbed.
  - **none:** the single deterministic member.
  - Recompute fuel moisture per member.

### 8.5 Spread forecast (`spread/*`)
- **pyretechnics API (verified):**
  `pyretechnics.eulerian_level_set.spread_fire_with_phi_field(space_time_cubes, spread_state, cube_resolution=(band_minutes, cell_h, cell_w), start_time, max_duration, …)`.
  - Cubes are `pyretechnics.space_time_cube.SpaceTimeCube(cube_shape=(bands, rows, cols), base)`; the base may be
    lower resolution if the dims divide evenly. Use base `(1, M, M)` for static layers and `(T, 4, 4)` for weather,
    so M must be divisible by 4.
  - Required cube units:
    - slope: rise/run; aspect: degrees clockwise from N
    - fuel_model: FBFM integer code
    - canopy_cover: 0–1; canopy_height and canopy_base_height: m; canopy_bulk_density: kg/m³
    - wind_speed_10m: km/h; upwind_direction: degrees clockwise from N (FROM)
    - moistures: kg/kg; temperature: °C
    - optional `weather_spread_adjustment`
  - `SpreadState(cube_shape).ignite_cells(lower_left_corner, ignition_matrix)`.
  - `get_full_matrices()` returns phi, fire_type, spread_rate, flame_length, time_of_arrival, …
  - **Verify the conventions with tests:** on a synthetic upslope the fire runs uphill; with wind FROM 270° it runs
    east; the FBFM40 code table is accepted.
- **Ignition mask** = observed_arrival ≤ start_h on the fire grid. If empty (start before ignition), ignite the
  ignition cell at its time.
- **Members** run in a `ProcessPoolExecutor(max_workers=min(10, cpu − 2))`. Target < 5 min for 31 members × 72 h
  at M ≤ 512. If slower, downsample the simulation grid ×2 and upsample the results (nearest for arrival). Log
  timings in `runtime_s`/warnings.
- **Outputs:**
  - Per-pixel arrival quantiles p10/p50/p90 (§5 semantics) and burn_probability at the horizon.
  - flame_length_p50 over members that burned the pixel.
  - Series: hourly area quantiles across members; ROS p50 from the members' spread_rate at the front.
- **Historical runs:** skill = Sørensen between (forecast p50 burned by start + L) and (observed burned by
  start + L), for L ∈ {12, 24, 48, 72} within the data range. Each skill entry also carries `growth_sorensen`
  (Sørensen of the new growth only, `validate.skill_entry`).
- **`validate.py`** also provides a CLI-callable batch hindcast used to pick `spread_adjustment`, e.g. a grid search
  over {0.5, 0.75, 1, 1.5, 2} on 2–3 fires. Record the result in `docs/validation.md`.
- Spotting is off by default. Crown fire is on.
- **Operational settings** (`config.FORECAST_*`, calibrated in docs/validation.md 3–5): spread-rate multiplier 0.5 at
  the start relaxing as × (0.1 + 0.9 e^(−lead/12 h)); drought-adjusted live fuel moisture; WUI surrogate off.
  `ForecastManifest.model.spread_adjustment` reports the multiplier at zero lead (0.5); the schedule, including a
  decay clock that starts before the forecast (live, below), is in the forecast warnings.
- **Held perimeter** (observation-informed start): unburned cells along the perimeter are made non-burnable (2-cell
  band) where nothing burned and no VIIRS/MODIS/Landsat detection of new burning was made within 1 km in the 12 h
  before the start. A detection counts only where it coincides with growth: its cell burned in the window or lies
  outside the burned area. A hot pixel on ground that burned before the window is burnout, not spread.
  Live forecasts add, from `sim/activity.json` and the manifest summary:
  - activity markers (§8.3) after the window start, also those seen after the forecast start: the perimeter within
    1 km of them (GOES: of a 1 km disk around the pixel centre) stays active;
  - the record's containment (CAL FIRE or NIFC WFIGS, note "{issuer} reports N% containment"): at least `percent_contained` of the perimeter is held, the cells farthest from recent
    activity first (where the contained lines are is not published);
  - when the start is later than the last sign of activity (a quiet satellite pass), the multiplier's decay is
    counted from that activity, as if the forecast had started there.
  A fully held perimeter gives a no-growth forecast; its warning says that this does not mean the fire is out.
- **Activity-rule switches** (`config.FORECAST_ACTIVE_*`; tested on 2026-10-18, docs/validation.md 6.6): the 1 km
  activity radius (`FORECAST_ACTIVE_RADIUS_M`), ignoring activity deeper than `FORECAST_ACTIVE_EDGE_M` inside the
  burned area (0 = off) and counting detections only where they coincide with growth (`FORECAST_ACTIVE_GROWTH_ONLY`).
  Operational: 1 km radius, edge filter off, growth-only on (docs/validation.md 6.6). `validate hindcast` and
  `validate live-start` take `--radius-m`, `--edge-m` and `--growth-only` / `--no-growth-only`.

### 8.6 Aircraft classification (`sources/aircraft.py`)
Sources: adsb.lol `point` around the incident (radius 40 nm); adsb.fi open data when adsb.lol is unreachable (each
provider is skipped for 5 min after a failure and paused 30 s after HTTP 429). Rules, in confidence order:
1. **Known firefighting types** (configurable list in `config.py`; verify the ICAO designators):
   - fixed-wing tankers: `DC10`, `MD87`, `RJ85`, `B461`/`B462`/`B463`, `C130`/`C30J`, `CL2T`, `S2P`/`S2T`, `AT8T`
   - air attack / lead: `OV10`, `AC90`, `AC95`
   - helicopters: `S64`, `S70`/`H60`, `CH47`/`H47`, `KMAX`
2. Registration/operator patterns (CAL FIRE and contractor fleets) and callsign prefixes such as `CALFIRE`, `TNKR`,
   `TANKER`, `ATTACK`, `LEAD`, `HELI`. Keep these in config with comments.
3. **Proximity:** inside the AOI, AGL < 1,500 m, gs < 250 kt, not an airliner category (A3–A5) → `other_fire` with
   reason "low & slow over fire".
4. Squawk 1255 (the US firefighting beacon code) counts as strong evidence, like a fire callsign. Air-ambulance,
   police, news and airlift callsigns or operators and emitter categories B1–B4 (gliders, balloons, parachutists,
   ultralights) veto only the "low & slow" inferences (`config.NON_FIRE_*`).

Only fire aircraft are returned unless `all=1`. `agl_m` uses the DEM when the aircraft is inside the AOI.

### 8.7 Live refresh (`api/live.py`)
An asyncio loop every 15 min refreshes the national live list (every active wildfire of the lower 48: CAL FIRE in
California, NIFC WFIGS elsewhere; brief 3) and the national FIRMS 7d feeds (`firms.load_live_us(days=7)`, the
lower-48 box with a 0.5° margin). Then:
- every ready live bundle's `manifest.summary` follows its records (acres, containment, update time, active flag,
  location fields, `detections_24h`, and since brief 3 `active_sources`, `other_records`, `complex_members`,
  `irwin_id`, `gacc`, `accuracy_region`): an atomic manifest update, no rebuild, `built_ms` unchanged. When the
  listed row is another agency's record than the summary's (`record_source` or `uid` differs: an id pinned to a bundle
  built under the fire's NIFC WFIGS id, §4.4 / CONTRACT 14.2), the record's identity is copied too (`name`,
  `source_name`, `record_source`, `record_issuer`, `uid`, `calfire_uid`, `agency`, `agency_code`, `unique_fire_id`,
  `aliases`, `complex_name`, `state`, `time_zone`, `started_ms`, `year`; the id and `time_origin_ms` stay), so the
  numbers, the link and the issuer always come from one record. An incident that left the live list is looked up in
  its year list;
- for each built live bundle with detections newer than `now_ms` (or built > 3 h ago, which picks up quiet
  satellite passes):
  - re-run `build_observed` and `build_weather`;
  - re-run the forecast when the last one is > 3 h old or burned area changed > 2%;
  - after a live-loop forecast, keep the newest 4 ready runs plus every run issued in the last 6 h; other runs leave
    the manifest first, and their directories are deleted ≥ 1 h later (an open view keeps working).
- Weather in a live refresh is refetched at most hourly (`config.LIVE_WEATHER_REFETCH_S = 3600`) and not at all once
  the day's weighted Open-Meteo usage passes `config.OPEN_METEO_DAILY_SOFT_CAP = 6000` (`weather.open_meteo_usage()`,
  persisted in `data/cache/open_meteo_usage.json`; cost = locations × max(1, series/10) × max(1, days/14)); the
  bundle then keeps its weather with "Weather not refreshed: daily request budget reached."; a refused refresh keeps
  it with "Weather not refreshed: Open-Meteo daily request limit reached." (the hourly and per-minute limits name
  themselves the same way; removed by the next successful refresh). A refresh without supplied detections loads
  `firms.load_live_us(days=2)`. After a successful build, the OpenFEMA archive window of the fire is prefetched once
  (`pipeline.archive_prefetch` → `openfema.prefetch`; best effort, never fails the build).

Max 1 forecast job at a time.

Auto-build on startup (env `FIRE3D_AUTO_BUILD_LIVE=1`, default on): up to 4 live incidents with ≥ 100 acres and
detections in the last 48 h, chosen from the whole lower-48 live list (brief 3, round 2 item 4). Builds run
sequentially. `LiveStatus.detections_24h` counts the feed's last 24 h inside the lower-48 state polygons
(`detections_24h_ca`, California, stays for one release).

## 9. Frontend

### 9.0 Art direction (read this first)
There are two references, and each has a different job:
- **Layout and features:** `docs/reference/firetrace-demo.png`. It shows the header, the right panel
  (Layers / Incident Overview / Weather), the bottom timeline, key events, three charts, and map controls.
- **Look:** `docs/reference/art-direction.png`. A cinematic "digital twin":
  - photographic terrain (moss, rock and vegetation micro-detail) in a dark, moody green-black atmosphere;
  - a luminous **golden parametric lattice** (dot grid / wire mesh) draped over the relief;
  - a glowing data "river of light";
  - floating **monospace numeric readouts**;
  - shallow **depth of field with bokeh**, soft bloom, film grain.

  It is **realistic and parametric at the same time**. View both images before writing any visual code, and keep
  comparing against them.

The look applied to wildfire data:

- **Realistic layer = the real place.**
  - Terrain: the NAIP aerial photo, colour-graded toward desaturated moss/olive greens and stone greys; DEM relief
    with soft sun shadows and sky-view ambient occlusion (`sky_view.bin`); procedural micro-detail by slope, fuel
    and canopy (rock on steep slopes, grass/scrub texture, dark canopy).
  - Instanced trees from LANDFIRE canopy.
  - Water with sun glints and sparkle (`water.bin`).
  - Aerial-perspective haze.
  - Fire is physical: charred ground (from arrival time, plus dNBR when available), an incandescent flame front
    with flicker, drifting embers, and **smoke plumes that drift with the real wind**.
- **Parametric layer = the data.**
  - A golden **dot lattice** draped on the terrain. Spacing adapts from about 30 to 120 m. Dot size and brightness
    encode `latticeField`:
    - fire **activity** (default): how recently each spot burned, plus front proximity;
    - forecast **probability**;
    - **elevation**, **slope** or **canopy**.
  - **Elevation contour lines.**
  - **Fire isochrones**: lines of equal arrival time every 1, 3, 6 or 12 h depending on zoom and fire duration.
    They tell the parametric story of the spread.
  - Forecast probability as a luminous field with crisp 10/50/90 % contours.
  - The active front as a bright filament.
  - **Telemetry columns**: small gold monospace text, with a subtle flicker only when values change. They are
    anchored at the ignition, the active front's main clusters, and a hover probe.
    - Real values only: lat/lon, elevation, arrival `T+hh:mm`, local ROS, FRP, wind, burn probability.
    - Never fake binary.
  - A one-time scan-sweep animation when an incident loads.
- **Visual modes** (`visualStyle`):
  - `hybrid` (default): realistic terrain, with the parametric lattice concentrated over the fire area and fading
    out radially, as in the reference (the lattice covers the valley and fades on the slopes). Isochrones and
    telemetry sit on top; dark atmospheric sky.
  - `realistic`: no lattice or telemetry. Natural golden-hour light, a sky gradient with sun glow, smoke and flames
    emphasized.
  - `parametric`: terrain reduced to dark relief (near-black with faint hillshade); everything drawn as glowing
    points and lines. The purest digital-twin look.
- **Palette:**
  - sky/background: deep green-black gradient `#060A08 → #111A14`
  - lattice gold: `#E8C77E` (core) → `#B08A45` (falloff)
  - fire: `#FFF3C4 → #FFB347 → #FF6A2B → #B8321A` (embers)
  - burned ground: charcoal `#16130F` with a warm undertone
  - probability ramp: transparent → gold → orange → red
- **Camera and post-processing:**
  - Tone mapping (AgX or ACES) with a filmic grade: lifted green-black shadows, warm highlights.
  - Bloom only on emissive things: fire, lattice, telemetry, water glints.
  - Depth of field with bokeh, auto-focused on the camera target. Toggled by `dof`; off in 2D.
  - Vignette, subtle film grain, fog/aerial perspective.
  - The square AOI edge must never read as a hard border: terrain fades into the dark fog over the outer ~8%.
- **Motion:** gentle lattice shimmer, front flicker, ember and smoke drift, telemetry ticking only when values
  change. Calm when idle. Honour `prefers-reduced-motion`.

### 9.1 Stack
- Vite + React 19 + TypeScript, `three`, `@react-three/fiber`, `@react-three/drei` (`<Text>`/troika for 3D
  telemetry), `@react-three/postprocessing` (Bloom, DepthOfField, Vignette, Noise, ToneMapping, SMAA), `zustand`,
  d3 (`d3-scale`, `d3-shape`, `d3-array`, `d3-time`) for SVG charts, `lucide-react` icons.
- Fonts: **Inter** (UI) + **JetBrains Mono** (numbers, coordinates, timestamps, telemetry) from Google Fonts in
  `index.html`, with tabular numerals.
- No other UI framework. Plain CSS (CSS variables) or CSS modules.

### 9.2 Store (`state/store.ts`, Contract)
```ts
type LayerKey = "terrain" | "imagery" | "trees" | "fuels" | "burnScar"
              | "observedFire" | "isochrones" | "forecast" | "detections" | "perimeters" | "smoke" | "ignition"
              | "lattice" | "contours" | "telemetry"
              | "wind" | "aircraft" | "profilePath";
interface LayerState { visible: boolean; opacity: number }      // opacity 0..1
type VisualStyle = "hybrid" | "realistic" | "parametric";
type LatticeField = "activity" | "probability" | "elevation" | "slope" | "canopy";
interface AppState {
  mode: Mode;
  catalog: { live: IncidentSummary[]; historical: IncidentSummary[]; loading: boolean; error: string | null };
  incidentId: string | null;
  summary: IncidentSummary | null;
  manifest: IncidentManifest | null;
  job: JobStatus | null;
  forecastRunId: string | null; forecast: ForecastManifest | null;
  timeseries: TimeseriesFile | null; events: EventsFile | null; weather: WeatherFile | null;
  detections: DetectionsFile | null; perimeters: PerimetersFile | null;
  timeMs: number; playing: boolean; speedHoursPerSec: number;
  timeWindow: { startMs: number; endMs: number } | null;       // visible timeline window
  viewMode: "3d" | "2d"; visualStyle: VisualStyle; latticeField: LatticeField;
  exaggeration: number; treeScale: number; dof: boolean; quality: "high" | "medium" | "low";
  panelsCollapsed: boolean;                                     // hide UI chrome for a cinematic view (key "H")
  layers: Record<LayerKey, LayerState>;
  aircraft: Aircraft[]; aircraftUpdatedMs: number | null;      // UI polls /aircraft every 10 s (live); scene renders
  profilePath: [number, number][]; drawingPath: boolean;
  selectedEventId: string | null;
  flyTo: { x: number; z: number; distance?: number; nonce: number } | null;
  rightTab: "layers" | "analysis" | "evidence" | "notes";
  // actions: setters + async loaders (loadCatalog, selectIncident, startBuild, startForecast, selectForecast, refreshManifest)
}
```
- **Defaults:** visualStyle `hybrid`, latticeField `activity`, exaggeration 1.5, treeScale 1, dof true, quality
  `high`.
  - Visible: terrain, imagery, trees, observedFire, isochrones (0.8), forecast (0.85), detections (0.9),
    perimeters (0.6), smoke (0.8), ignition, lattice (0.9), contours (0.35), telemetry, aircraft, profilePath.
  - Hidden: fuels, burnScar, wind.
- Large binary arrays never go in the store; `lib/raster.ts` caches them by URL.
- During playback the scene reads time with `useStore.getState()` inside `useFrame`.
- Scene-only transient state (hover probe, FPS, focus distance) lives in `scene/sceneStore.ts`.

### 9.3 Scene (`scene/`, R3F)
- **Terrain mesh:** `PlaneGeometry(extent, extent, 1023, 1023)` in XZ, displaced on the CPU from `elevation.bin` ×
  exaggeration. Normals are computed once per incident or exaggeration change. Edge fade per §9.0.
- **One custom terrain shader** with these components:
  - **Realistic shading:**
    - Albedo: graded NAIP when `imagery` is on, else a procedural realistic palette from fuels and canopy.
    - Plus triplanar/procedural micro-detail and a detail normal by slope, fuel and canopy.
    - Lighting: sun + hemisphere sky × `sky_view` AO + soft shadow map + aerial perspective.
    - Water (`water.bin`): darker, reflective, with animated sparkle that blooms.
  - **Parametric style:** dark relief with faint hillshade; contours and isochrones emphasized.
  - **Observed fire:** with `a` = observed arrival and `t` = time (hours):
    - a ≤ t: charred. Charcoal and ash albedo, ember glow decaying over ~6 h, dNBR-modulated darkness when
      available.
    - t − 0.75 h < a ≤ t: an incandescent flame front with animated flame-tongue noise, emissive so it blooms.
    - a > t: untouched.
  - **Isochrones:** thin gold-white lines where `fract(a / step)` crosses, only for a ≤ t. Brighter every 4th
    line; the current front is the brightest filament.
  - **Contours:** elevation lines via `fwidth` anti-aliasing. Interval 10/20/50/100 m by extent; index contour
    every 5th.
  - **Forecast:** P(burned by t) piecewise-linear from p10/p50/p90. Shown as a luminous field (hybrid/parametric)
    or a translucent heat wash (realistic), with crisp 10/50/90 % contours and a dimmer, dashed p50 front.
  - **Burn scar:** dNBR ramp overlay.
  - **Fuels:** FBFM40 colour overlay (data-viz palette in `lib/fuels.ts`).
  - All layer opacities are uniforms.
- **Parametric lattice:** `THREE.Points` on a regular grid (256²/384²/512² by quality) draped 2 m above the
  terrain, with a custom shader:
  - Size and brightness from `latticeField`. Activity = recency of burning + front proximity + forecast
    probability ahead of the front.
  - Radial falloff around the fire centroid in hybrid; full extent in parametric.
  - Distance attenuation, subtle shimmer, additive blending.
  - Every 4th row is optionally connected as faint gold wire lines (the reference's mesh lines).
- **Trees:** InstancedMesh variants: conifer (stacked cones), broadleaf (lumpy blob), shrub (flattened blob).
  - Per-instance moss-green colour variation and base AO; shadow casting at high quality.
  - The vertex shader samples arrival: burned → charred black, shrunk 60%; on the front → emissive.
  - Respects treeScale and exaggeration.
- **Smoke:** instanced soft billboards with a procedural noise texture.
  - Emitted from active-front clusters at the current time and from FRP-weighted recent detections.
  - Rises and drifts with the interpolated wind, lit by the sun. Density scales with active length/FRP.
  - Alpha-blended, never bloomed.
- **Embers:** GPU points spawned along the front, rising and drifting downwind.
- **Detections:**
  - Realistic: small hot-pixel glows sized by FRP.
  - Parametric/hybrid: true-size footprint squares (375 m VIIRS, 1 km MODIS) outlined in gold/orange.
  - Coloured by age (≤ 12 h bright → dim). GOES points are drawn only as faint large halos (2 km) when
    `detections` is on and zoomed out.
- **Perimeters:** thin luminous draped lines; older ones dimmer; the latest ≤ t highlighted.
- **Ignition:** bright point + additive flare + monospace label.
- **Telemetry:** drei `<Text>` columns (3–8 lines, JetBrains Mono, gold, ~70% opacity), billboarded. Anchors:
  ignition, the top-3 active front clusters (centroid of pixels with t − 1 h < a ≤ t), and the hover probe.
  - Probe: raycast the terrain to get lat/lon, elevation, fuel model name, arrival time or "unburned", P(burn), and
    slope.
  - Values update when time changes by ≥ 10 min of simulation time; digits "tick" briefly.
- **Wind:** ~3000 particle streaks from the 4×4 u/v grid at the current time; gold-white in parametric, faint white
  otherwise.
- **Profile path:** a draped gold polyline with click-to-draw (raycast; Esc or double-click ends) that writes
  `store.profilePath`.
- **Aircraft:** small glowing heading-oriented icons (fixed-wing / rotor), category accents, monospace callsign
  labels, 5-minute trails, smoothed interpolation.
- **Sky/background:** gradient dome in palette colours. In realistic mode, a warm sun glow near the horizon.
- **Camera:** MapControls/OrbitControls with damping.
  - Initial oblique view from the south-south-east framing the fire bbox; 2D = top-down; `flyTo` animates.
  - DOF focus follows the orbit target.
- **HTML overlays** (dark glass style §9.5):
  - compass (rotates with azimuth; click resets north) and scale bar;
  - 2D/3D toggle, exaggeration select, quality select, DOF toggle, fullscreen;
  - probe readout near the cursor (hybrid/parametric).
- **Post-processing:** Bloom (luminance threshold so only emissive glows), DepthOfField (bokeh), Vignette, Noise
  (film grain, subtle), ToneMapping, SMAA.

### 9.4 UI layout (structure of the demo, chrome of the art direction)
- The **3D canvas is full-bleed** (whole window). UI panels float above it as dark glass.
- `panelsCollapsed` (key **H** or a button) hides everything except a minimal top bar for a cinematic view.
- **Header (≈52 px, floating, full width):**
  - Logo mark + "Fire-3d" + "Wildfire Forensics & Forecast".
  - Incident picker: dropdown with a **Live / 2025** segmented control and search. Rows show name, acres,
    containment, start date, status chip, and bundle status (ready / build needed / building). The 2025 list has
    a ≥ 100 ac toggle.
  - Location; date range in monospace.
  - Tabs "Incident" | "Aircraft (n)" (live only).
  - View menu: Hybrid / Realistic / Parametric, lattice field, 2D/3D, exaggeration, tree scale, DOF, quality.
  - Analysis menu; Share (copies a `?incident=&t=&mode=` link); settings.
- **Right panel (~360 px, floating, from below the header to the bottom margin):**
  - Tabs **Layers** (grouped: Base · Fire · Parametric · Live & Atmosphere). Each row: checkbox, small swatch,
    label, opacity slider, %. Unavailable layers are greyed with a tooltip.
  - **Analysis:**
    - Forecast runner: start = the current timeline time (historical) or now (live); horizon 24/48/72 h; ensemble
      Auto / GFS 31 / ECMWF 51 / Perturbed / None. Shows progress.
    - Run list. Selected-run summary: p50 area at +24/48/72 h with the p10–p90 range.
    - Skill table for hindcasts.
    - Disclaimer: "Research prototype — not for operational use".
  - **Evidence:** data sources with fetch times; detection counts by satellite/instrument; perimeter list that
    jumps the timeline; warnings.
  - **Notes:** a textarea saved to localStorage per incident.
  - **Incident Overview** card: name, incident ID, location, start, end/containment, total acres, cause, analysis
    status.
  - **Weather & Fire Behavior (at fire front)** card at the current time: wind mph + cardinal (degrees), temp,
    RH, fuel moisture (1-h), FFWI, flame length. Numbers in monospace.
- **Bottom dock (floating, left of the right panel):**
  - **Timeline:**
    - Play/pause/step; speed in hours/sec (0.5, 1, 3, 6, 12, 24).
    - Scrubber with a time bubble, day/6-hour ticks, event markers.
    - Hatched forecast region after the **Now** marker.
    - Window presets: All / 7 d / 72 h + forecast.
  - **Key Events** list: icon per type, title, local time. Click → set time + fly to. "+ Add" annotations.
  - **Charts row:**
    - Fire Area (acres): observed + forecast p10–p90 band + p50.
    - Rate of Spread (chains/hr), with an optional GOES FRP overlay.
    - Elevation Profile (selected path): elevation along `store.profilePath`, burned portion at the current time
      shaded, fire position marker.
    - All charts carry a time cursor synced to the timeline.
- **Overlays:**
  - Build/forecast progress (step, %, message).
  - Empty states (no live fires; bundle not built → Build button).
  - Errors with retry.
  - "Not for operational use" in the Analysis tab and footer.
- **Default selection:** the largest live incident with a ready bundle; else the Eaton Fire 2025. Unbuilt
  incidents auto-build with the progress overlay. Live mode polls the manifest every 60 s and refetches files when
  `built_ms` changes.

### 9.5 Look and feel (dark, matches the art direction)
- **Panels:** translucent dark glass `rgba(9,14,11,0.72)` + `backdrop-filter: blur(14px) saturate(120%)`;
  1 px hairline borders `rgba(232,214,170,0.12)`; radius 10 px; soft shadow.
- **Colour tokens:** text `#ECE6D6`, secondary `#9BA394`, muted `#6B7468`, accent gold `#E2BE72`, fire `#FF6A2B`,
  danger `#E5483A`, ok `#8FBF7A`, warn `#F0A35E`.
- **Typography:** Inter 12–13 px for UI; JetBrains Mono for all numbers, coordinates, times, telemetry and table
  values (tabular-nums).
- **Charts:** dark background, hairline grid `rgba(255,255,255,0.06)`, gold observed series, fire-orange forecast
  with a translucent band, gold time cursor.
- **Controls:** minimal; gold focus rings; sliders with gold fills; tabs with a gold underline.
- Professional and dense: a scientific instrument with a cinematic finish, never a game UI.

### 9.6 Performance rules
- **Quality levels:**
  - `high`: DPR ≤ 2, shadow map 4096, DOF on, all trees, lattice 512².
  - `medium`: DPR 1.5, shadows 2048, DOF on, 60% trees, lattice 384².
  - `low`: DPR 1, no shadows, no DOF, 30% trees, lattice 256².
  - Auto-suggest `medium` if FPS < 30 for 5 s.
- Target ≥ 50 fps on an M-series Mac at `high` for a 12 km AOI.
- Upload textures once per file. No per-frame allocations in `useFrame`. Build terrain displacement, tree
  instancing and the lattice once per incident or exaggeration change.
- Arrival textures: HalfFloat + LinearFilter; clamp NEVER to 60000 before conversion.

## 10. Testing and verification

- **Backend:** `cd backend && uv run pytest -q`. Covers the pure functions: grid transforms, moisture, FFWI,
  quantile semantics, arrival interpolation on synthetic snapshots, aircraft classification, pyretechnics
  conventions on synthetic terrain. Tests are offline and fast (< 60 s total).
- **Network smoke scripts** live in `fire3d/cli.py`:
  - `uv run python -m fire3d.cli catalog --mode live|historical`
  - `… build <id-or-name> [--force] [--require-hrrr]` (`--require-hrrr` fails instead of filling with ERA5; every
    build prints the HRRR / GFS / ERA5 hour counts)
  - `… weather-probe` (one uncached request per Open-Meteo host; exit 0 only when historical builds can run)
  - `… forecast <id> [--start ISO] [--horizon 72] [--ensemble auto]`
  - `… hindcast <id> --start ISO`
  - `… serve`
- **Fixture:** `uv run python scripts/make_fixture.py` writes a synthetic, contract-complete bundle
  `data/incidents/fixture-demo/`. `uv run python scripts/serve_fixture.py --port P --data-dir D` is a standalone
  server for the §6 read endpoints that does not import `fire3d.api`. Frontend agents develop against it.
- **Frontend:** `cd web && npm run build` must pass (tsc + vite).
  `node scripts/shot.mjs <url> <out.png> [--wait ms] [--w 1720 --h 1080]` takes a screenshot with the installed
  Chrome (headless; it tries GPU flags and falls back to SwiftShader) and prints console errors. Inspect screenshots
  with the Read tool.
- **Ports:** integration uses API **8710** / web 5173 (8000 is occupied by an unrelated app; see §6). Module
  agents use only the ports their prompts assign. Wherever a prompt says "port 8000" for the Fire-3d API,
  use 8710.
- **Scene isolation:** the scene agent develops in `web/scene-dev.html` + `web/src/scene/dev/`, a standalone page that
  mounts only `<Scene/>` and loads the fixture into the store itself. App.tsx supports `VITE_SCENE=off`, which
  renders a placeholder instead of `<Scene/>`, so UI work isn't blocked by scene work in progress.

## 11. Out of scope for v1
WeatherNext 3, WindNinja terrain winds, the Hugging Face ML models (side-by-side later), deployment, user accounts,
suppression data, GOES 5-minute detections.
