# Fire-3d

**Wildfire forensics and forecast for California, built on real data.**

Fire-3d is a map-first web app that helps you understand a California wildfire: where it is, how it spread, which
nearby places it may reach, and how current and reliable that information is. It combines public data (satellite heat
detections, agency-mapped fire perimeters, elevation, vegetation "fuels" and weather) and runs a physics-based
fire-spread model many times with slightly different weather (an *ensemble*), so it can show how many of those model
runs reached each spot. It opens on a map of California with the fires CAL FIRE lists as active and this year's (2026)
fires of 300 acres or more; the 2025 fires of 300 acres or more are one filter away. Past fires can be replayed hour by
hour and re-forecast from any past moment to see how well the model would have done (a *hindcast*). Official
information (evacuation orders and warnings from local officials, CAL FIRE's own record and National Weather Service
fire-weather alerts) is shown with its issuer and its own times, always separate from the model. Fire-3d is a
**research prototype, not for operational use**.

> [!IMPORTANT]
> Fire-3d's forecasts are experimental model output. They are not evacuation instructions and they are not official
> information. Always follow the orders of local officials and CAL FIRE.

## Screenshots

![Public view on aerial photos with road and place labels: zooming in on the 2025 Eaton Fire shows its spread without a click, with the burned area, satellite heat detections, the hatched modeled spread, the archived NWS Red Flag Warning outline, the "Official now" block (evacuations, CAL FIRE's record, fire weather), the timeline and the coordinate strip](docs/screenshots/brief2-final-zoom-focus-eaton-1440.png)

| Command preset: the location card of an address | Forensic workspace: the 3D analysis scene |
|---|---|
| ![Command preset on the dark map: the four-part location card for 600 E Mariposa St, Altadena, inside the Eaton Fire's burned area, with the model's 0 % figure and run, official information at the replay time, coordinates in decimal degrees, DMS and UTM, the incident ID and the full Official now panel](docs/screenshots/brief2-final-card-eaton-burned-home-command-1440.png) | ![Forensic workspace: the Eaton Fire on photographic 3D terrain with arrival-time lines and the forecast field, the layer panel, Key Events, the weather card and the fire-area, spread-rate and elevation-profile charts](docs/screenshots/brief2-final-forensic-key-events-1440.png) |

## What you can do

Fire-3d has two workspaces. **Public / Command** is one map of California with the fires drawn on top; its two
presets, Public and Command, share the same map and data. **Forensic** is a 3D analysis scene with the scientific
detail. The header switch reads "Public · Command · Forensic". Switching keeps the fire, the timeline time, the forecast
and your selected point.

### Start on the California map

- **The California overview.** With no fire in the link, the app opens on a map of California with one marker per
  fire at CAL FIRE's reported location, sized by its acreage (filled orange: CAL FIRE lists it as active). The filters
  are Active, 2026 season (the default: active fires plus 2026 fires of 300 acres or more) and 2025. A panel lists the
  fires with CAL FIRE's official record, plus "Official now · California" (the National Weather Service's fire-weather
  alerts statewide). Nothing is opened or built by itself.
- **Zoom in to see the spread.** Zooming in on a fire whose analysis is prepared (from about zoom 8.5) shows it without
  a click and without moving the camera: the burned area colored by when it burned, perimeters, satellite detections
  and the selected forecast appear, and the timeline, the updates panel and the location card switch to that fire.
  Panning to a neighboring prepared fire switches to it; zooming out (below about zoom 7) returns to the overview.
  Other prepared fires in view show their latest perimeter as a dashed outline. Opening a fire explicitly (its card, a
  search result or a link) frames it and adds a browser history step, so Back returns to the overview.
- **The fire card.** Clicking a marker opens the fire's card: CAL FIRE's record (acres, containment, status, CAL
  FIRE's own update time and incident page), Play spread, Check a location and Open in 3D. For a fire that is not
  prepared yet (zoomed in, a chip under its marker reads "Spread not prepared yet"), the card offers **Prepare analysis
  (1-3 min)**: the only way the Public and Command views start a build. A progress card shows each step (terrain,
  observations, weather, forecast).

### Public (the default view)

- **See where the fire is** on a continuous map with roads, towns and landmarks: the burned area reconstructed from
  satellite detections and perimeters, agency-mapped perimeters (with the time they were mapped), satellite heat
  detections, and the incident's reported location (CAL FIRE's point, not the exact ignition point).
- **Aerial photos by default.** Public opens on aerial photos with road and place labels (USDA/USGS orthoimagery).
  The legend says when they were taken: "Photos: June 2024 or earlier", so they show the land *before* recent fires,
  and they are not live satellite images. Dark and roads maps are one click away, and a map you pick wins. If the USGS
  photos stop loading, the map switches to the dark map and offers "Try aerial again".
- **Switch between 2D and 3D:** a north-up map, or tilted 3D terrain. In 3D, buttons rotate and tilt the view
  (also Shift + arrow keys), and "Top-down" and "North up" reset it. From zoom 15, plain 3D building shapes from
  OpenStreetMap appear (no photo textures), with the caveat "today's OpenStreetMap; buildings destroyed by this fire may
  be missing; not a damage assessment". If the terrain service is down, the map stays usable as a flat map and says so.
- **Read the forecast in plain words.** The modeled spread is shaded by the share of model runs that reached each spot
  ("at least 10 %, 50 % or 90 % of model runs had reached this spot by this time"). The chance of burning is always
  stated for the forecast's whole period, for example "by Jan 11, 00:18 PST (72 h)", never as "the next 24 hours".
  Forecasts show their start and issue times, and the time zone. Public calls a past fire's re-forecast a "model re-run
  on past weather" and never shows run IDs; Command and Forensic keep the run IDs and the word hindcast.
- **Check a location.** The "Check an address" box takes a US street address, a California town or ZIP code, pasted
  coordinates (decimal, degrees-minutes-seconds or a map link) or a fire's exact name (which opens that fire); you can
  also click the map. A town or ZIP code moves the map to that area and asks for an address or a map click; it never
  opens or builds a fire (zooming there can still show a prepared fire's spread, as any zoom does). On the California
  overview a point lists the nearest fires and their distance, with the reminder "Distance alone does not tell you the
  risk", and "Zoom to the Eaton Fire" when it lies in a prepared fire's area. Inside a fire, the location card starts
  with four short parts, details one tap away:
  1. **Near here:** inside the latest mapped perimeter or the satellite-based estimate, or the distance and direction
     to its edge, tagged Mapped or Estimate, with its age (STALE when old).
  2. **Official information:** evacuation orders and warnings at that spot from local officials via Cal OES (verbatim
     status, issuer and the issuer's own time), an NWS fire-weather alert line, or exactly why nothing is shown:
     "No evacuation order or warning listed here · not an all-clear", "not checked here", "not shown for past dates"
     or "unavailable". Then "Follow local officials." with links.
  3. **What could bring fire here:** in Public a dated sentence, for example "In the experimental model, 0 of 31
     simulated fires reached here by Oct 21, 10:00 PDT (72 h). Not a safety guarantee." (Command shows the figure,
     the model run and the arrival times.) Up to three reasons, each tagged: the wind blowing from the fire toward or
     away from the spot (Model), dryness (Model, or an NWS Red Flag Warning: Official) and lying uphill of the fire
     edge (Terrain data).
  4. **Updated and reliability:** the latest fire observation, the model's issue time and "Research prototype, not an
     evacuation order".

  Outside the area the model covers, the card says "Unknown, not low risk". Street-address pins are approximate
  (placed along a range of house numbers, not on the rooftop) and you can drag them.
- **Follow the timeline:** past observations (solid line), NOW for live fires, and +24 h / +48 h / +72 h where the
  selected forecast covers them (dashed). Periods without data are disabled, with the reason. Live data older than
  6 hours is flagged STALE, and the current time is shown separately from the latest observation.
- **Official now.** The top of the updates panel (and of the phone's "Updates" sheet, whose button shows a badge)
  has three official rows, each with its issuer, its own times and a link, kept apart from the model:
  - **Evacuations:** orders and warnings from local officials via Cal OES within 15 km of the fire, with their
    distance, and "Cal OES does not say which fire this is for" when a zone lies outside the fire's area;
  - **CAL FIRE:** its record of the fire and every change Fire-3d has recorded since it started checking, for
    example "CAL FIRE: 50 % contained (was 25 %)" with CAL FIRE's own update time (past fires: CAL FIRE's final
    record);
  - **Fire weather:** National Weather Service Red Flag Warnings and Fire Weather Watches, in the NWS's own words,
    drawn as outlines on the map. For a past fire's replay they come from an archived copy (Iowa Environmental
    Mesonet) and are labelled so.

  A quiet row says so and adds "Not an all-clear". In Public on a wide screen the block starts as three short lines;
  "Details" shows everything.
- **Read the updates feed:** fire start, rapid growth, ridge crossings, possible spot fires, peak wind, perimeter
  updates, containment, satellite passes (a day's passes grouped in one row) and the official rows, each with its time,
  source and kind (observation, estimate, model output, official update or your own note), filtered by Official · All
  · Key events. Automated items carry an "Automated" label. Clicking an item moves the timeline to its time (official
  items only within the observed record) and flies the map to its location or official area.
- **See the newest satellite image.** A "Satellite" chip in the header names the newest image of the fire, for example
  "newest 23 h ago · 375 m · VIIRS NOAA-21 · Oct 17, 14:30 PDT". One click lays it on the map with a caption: platform,
  acquisition time, age, pixel size, cloud cover and "not live". "More images" lists the others (Sentinel-2,
  Landsat, VIIRS, GOES-West).
- **Copy coordinates at any time.** The coordinate strip is always visible (compact in Public, one line on phones):
  the incident's reported location and your selected point in WGS84 latitude and longitude, with copy buttons.
- **Turn on official and public sources** in the Layers panel:
  - evacuation orders and warnings from local officials via Cal OES, with the official wording, the issuing authority
    and the update time; the location card lists any zone your point is in (current status only, never shown for
    past dates, and "no zones listed" is never an all-clear);
  - public wildfire and traffic cameras (an image loads only when you ask for it);
  - recently acquired satellite images (Sentinel-2, Landsat, VIIRS and GOES-West) with their acquisition time, cloud
    cover and resolution.
- **Use everyday units:** mph, feet, miles, °F and acres by default, metric on request. The three analysis charts (fire
  area, rate of spread and elevation profile) open in an Analysis drawer.
- **Keyboard and phone friendly:** `/` focuses the search box, `H` hides the panels, `Space` plays the timeline and the
  arrow keys step it (Shift: 6 hours). On the map, the arrow keys pan, `+` and `-` zoom and Shift + arrows rotate.
  Reduced-motion settings are respected. On phones the panels become bottom sheets and the map stays visible above an
  open card.

### Command (for emergency managers)

The same map and data, but denser, on the dark map by default: coordinates also in degrees-minutes-seconds and UTM, the
incident ID, timestamps with years, the location card's model percentage, run ID, issue time and P10 / P50 / P90 arrival
times, the full Official now block, and a data-status block that lists the newest time of each source (observations,
perimeter, last detection, forecast issue, weather, Cal OES, NWS and the CAL FIRE record).

### Forensic (the 3D analysis scene)

The original React Three Fiber scene, with all the scientific tools. It opens map-first: the fire framed, the timeline,
a "Frame fire" button and "Charts & key events" for the rest; your selected point is drawn as a cyan pin, and clicking
the terrain selects a point.

- photographic terrain (NAIP aerial photos on USGS elevation) in three visual styles: hybrid, realistic and parametric;
- the observed fire with isochrones (lines of equal arrival time), contours, burn severity (dNBR) and fuels; the
  forecast as a probability field with 10 / 50 / 90 % contours; detections by satellite; perimeters; trees, smoke,
  embers and wind streaks; the golden data lattice (for example the activity or slope lattice) and telemetry labels;
- the full timeline with event markers, Key Events with your own notes, and charts of fire area, rate of spread (in
  chains per hour) and an elevation profile along a path you draw;
- forecast controls: choose a start time, a 24, 48 or 72 h horizon and the weather ensemble, then see the run's
  progress, the P10–P90 area range and, for past fires, the hindcast skill scores;
- Evidence and Notes tabs (Evidence ends with the data sources, their credits and NASA's FIRMS acknowledgement), a
  weather and fire-behavior card, and live firefighting aircraft from open ADS-B data (live incidents only, in
  Forensic only);
- a setting "Prepare analysis when I pick an unprepared fire" (off by default) for Forensic's own incident picker.

## Quick start

### Prerequisites

- macOS or Linux with a C compiler (on macOS: `xcode-select --install`). The fire-spread engine, pyretechnics, is
  compiled from source when the backend is first installed (about 45 s).
- [uv](https://docs.astral.sh/uv/) (developed with 0.10.3). uv also installs Python 3.12, which the backend requires
  (`requires-python = ">=3.12,<3.13"` in `backend/pyproject.toml`).
- [Node.js](https://nodejs.org/) 22.12 or newer, with npm. `web/package.json` has no `engines` field; the limits come
  from its tools: Vite 8 needs Node `^20.19 || >=22.12`, and the test runner Vitest 5 needs `^22.12 || ^24 || >=26`.
  Fire-3d was developed with Node 25.6.1 and npm 11.9, which work but may print an npm engine warning.
- About 1 GB of free disk for `data/`. Each incident bundle is 10–30 MB, and the shared download cache grows to a few
  hundred MB.
- A browser with WebGL2 (any recent desktop browser). Google Chrome is needed only for the screenshot script.

### Install

```bash
git clone <this repository> Fire-3d && cd Fire-3d
(cd backend && uv sync --frozen)   # creates backend/.venv from uv.lock; compiles pyretechnics the first time
(cd web && npm ci)                  # installs the exact versions in web/package-lock.json
```

### Optional: a NASA FIRMS key

Fire-3d works without any key, using NASA's free download files: Suomi NPP VIIRS and MODIS for 2025 fires, and the
last 7 days of VIIRS and MODIS for live fires. A free NASA FIRMS `MAP_KEY` unlocks the FIRMS area service, which adds
GOES (fire timing to within minutes), Landsat and, for 2025 fires, the NOAA-20 and NOAA-21 VIIRS satellites. Request
one at <https://firms.modaps.eosdis.nasa.gov/api/map_key/> (limit: 5,000 transactions per 10 minutes; Fire-3d
throttles itself to 150 requests per 10 minutes). Then create a file named `.env` in the repository root with your
editor:

```ini
FIRMS_MAP_KEY=<your key>
```

and run `chmod 600 .env`. Only `backend/fire3d/config.py` reads it (a real environment variable of the same name takes
precedence). `.gitignore` already excludes `.env` and `.env.*`, so the key is never committed, and Fire-3d masks it as
`***` in logs and error messages. Never paste the key into code, issues or screenshots.

### Run

```bash
./dev.sh --no-live     # quiet start: API on http://127.0.0.1:8710, web app on http://localhost:5173
```

Open <http://localhost:5173>. `Ctrl-C` stops both servers.

| Command | What it starts |
|---|---|
| `./dev.sh` | the API with the live loop: every 15 minutes it checks CAL FIRE (recording each change of acres, containment and status), refreshes the prepared live fires and re-forecasts them when needed; right after startup it also prepares up to 4 active live fires (at least 100 acres, with detections in the last 48 h), one at a time |
| `./dev.sh --no-live` | the API without the live loop or auto-builds (best for a first look) |
| `./dev.sh --reload` | the API restarts when backend code changes; live auto-build is off, because a restart would kill builds in progress |
| `./dev.sh --fixture` | a small fixture server (`backend/scripts/serve_fixture.py`) that lists and serves only the bundles already on disk, with fake build and forecast jobs and synthetic aircraft; address search and the optional sources need the real API |

Ports: the API uses **8710** and the web app **5173** (Vite's default in `web/vite.config.ts`, which proxies `/api` to
the API). Change them with `API_PORT=… WEB_PORT=… ./dev.sh`. Port 8000 is never used: `dev.sh` refuses it, because
another local app owns it on the development machine. Other settings: `FIRE3D_DATA_DIR` and `FIRE3D_CACHE_DIR` (where
data goes, default `data/` and `data/cache/`), `FIRE3D_LIVE`, `FIRE3D_AUTO_BUILD_LIVE`, `FIRE3D_LIVE_INTERVAL_S`
(backend), and `VITE_API_TARGET` (where Vite sends `/api`). The optional `FIRE3D_NWS_CONTACT` (a website or email
address) is added to the User-Agent of National Weather Service requests only; unset, Fire-3d identifies itself as
"Fire-3d/0.1 (research prototype)" with no personal contact.

**Data you cannot download again.** `data/official/calfire/` holds the CAL FIRE change history (one JSON-lines file per
fire, outside the incident bundles). CAL FIRE's lists keep only the latest record, so this history exists only because
Fire-3d recorded it whenever it checked CAL FIRE (since Oct 18, 2026). Keep it when you clean up `data/`; the bundles in
`data/incidents/` and the download cache in `data/cache/` can be rebuilt.

**Town and ZIP search index.** `backend/fire3d/data/gazetteer_ca.json` (131 KB) is built from the U.S. Census Bureau
Gazetteer Files. To rebuild it: `cd backend && uv run python scripts/build_gazetteer.py [--year 2026]` (downloads two
files once), or `--source DIR` to use files already downloaded. Without it, street addresses still work, but town and
ZIP searches fail (the API answers 503).

### The first run: what to expect

- **The app opens on the California overview** with the fires from CAL FIRE's lists. Nothing is selected and nothing
  is built by itself. A fresh clone has no incident data (`data/` is gitignored), so every fire's card offers
  **Prepare analysis (1-3 min)**, the only way the Public and Command views start a build. Fires open from the map
  (click a marker, or zoom in on a prepared fire), the list, the search box or a link, and Back returns to the
  overview. With `./dev.sh` (live loop on), the backend also prepares up to 4 active live fires by itself after
  startup, so they usually show their spread when you zoom in.
- **In Forensic**, the setting "Prepare analysis when I pick an unprepared fire" (off by default) lets Forensic's own
  incident picker start the build directly; otherwise its card offers **Prepare analysis (1-3 min)** too.
- **A first build takes about 1–3 minutes per fire**, mostly downloads. Measured during development: Eaton 69 s,
  Palisades 75 s, Madre 87 s and Camino 192 s; the live Henderson and Norte fires 57 s and 47 s, and the live Cyrus
  Fire (543 acres, Oct 18, 2026) 159 s, each including its first forecast. The 4,000-pixel aerial photo alone takes
  about 30 s on a cold cache, and the satellite detections of a long fire can take 1–2 minutes. Rebuilds with a warm
  cache are much faster.
- **A forecast takes about 2–30 seconds** (31–51 model runs over 72 h, measured on a 12-core laptop).
- **To try it without downloads**, create the two synthetic demo incidents (about 30 s), then open one of them
  directly by its address (they are not in CAL FIRE's lists, so the overview does not show them):

  ```bash
  (cd backend && uv run python scripts/make_fixture.py)
  # then open http://localhost:5173/?incident=fixture-demo   (or ?incident=fixture-live)
  ```

  The app labels them "Demo · simulated data".

Useful address-bar options: `?incident=2025-eaton-fire-dbfa57`, `&preset=command`, `&persp=3d`,
`&basemap=dark`, `&basemap=roads` or `&basemap=aerial`, `&units=metric`, `&ws=forensic` for the Forensic workspace,
`&view=<lon>,<lat>,<zoom>[,<bearing>,<pitch>]` for a map view and `&sel=<lat>,<lon>` for a selected point. With no
`incident`, the app opens on the California overview; a link to an unknown fire falls back to the overview with a
notice.

### Checks

```bash
(cd backend && uv run pytest -q)    # offline backend tests (about 40 s)
(cd web && npm run typecheck && npm run lint && npm test && npm run build)
(cd web && node scripts/shot.mjs "http://localhost:5173/?incident=fixture-demo" /tmp/fire3d.png --wait 8000)   # screenshot with the installed Chrome
```

## How data flows

```mermaid
flowchart LR
  S["Public sources<br/>CAL FIRE · NASA FIRMS and CMR · NIFC perimeters<br/>USGS 3DEP · LANDFIRE · NAIP · Sentinel-2<br/>Open-Meteo weather"]
  B["Build pipeline<br/>fire3d.build"]
  D[("Incident bundle<br/>data/incidents/{id}")]
  F["Ensemble forecast<br/>fire3d.spread + pyretechnics"]
  A["FastAPI<br/>port 8710"]
  W["Web app, port 5173<br/>Public / Command map · Forensic 3D"]
  S --> B --> D
  D --> F --> D
  D --> A --> W
```

1. **Catalog.** CAL FIRE's incident lists give the live fires and the fires of a year (the 2026 season for the
   overview, 2025 behind a filter); NASA FIRMS's public 24-hour feeds count recent detections near each one. Every
   time the backend checks CAL FIRE, it appends any change of a fire's acres, containment or status, with CAL FIRE's
   own update time, to `data/official/calfire/`.
2. **Build** (`fire3d.build.pipeline`). Fire-3d chooses an *analysis area* around the fire: a square in the fire's UTM
   zone (10 or 11), sized to the fire. It then downloads elevation (USGS 3DEP), fuels and canopy (LANDFIRE), an aerial
   photo (NAIP) and burn severity (Sentinel-2 dNBR). From satellite detections and perimeters it reconstructs when
   each cell burned (an *arrival-time* map), plus hourly burned area and key events. For live fires it also asks
   NASA's catalog of satellite passes (CMR) whether later passes over the fire saw nothing, which sets the latest
   observation. Finally it fetches weather for a 4 × 4 grid of points (Open-Meteo) and, for live fires, runs a first
   forecast.
3. **Bundle.** Everything lands in `data/incidents/<id>/`: `manifest.json`, raw grids (`layers/*.bin`), JSON files
   (detections, perimeters, timeseries, events, weather) and one folder per forecast run (`forecasts/<run_id>/`, with
   arrival-time quantiles, burn probability and flame length). Incident IDs look like `2025-eaton-fire-dbfa57` (year,
   name, and the start of CAL FIRE's ID).
4. **Forecast** (`fire3d.spread`). Many model runs start from the area burned at the start time and spread the fire
   for up to 72 hours (details in [the forecast section](#the-forecast-model-and-how-good-it-is)). For past fires
   Fire-3d also scores the forecast against what actually burned.
5. **API.** FastAPI serves incident lists, bundle files and build or forecast jobs, plus the official information:
   CAL FIRE's record and recorded changes, and NWS fire-weather alerts (one statewide request to the NWS, cached
   2 minutes; for past times the Iowa Environmental Mesonet archive). With the live loop on, every 15 minutes it copies
   CAL FIRE's latest acres, containment and status into each live fire; when there are new detections, or every
   3 hours, it also refreshes the observations and weather and re-runs the forecast if needed.
6. **Web app.** The Public / Command map reprojects the UTM grids pixel by pixel into the web map's projection and draws
   them below the road and place labels; Forensic draws the same arrays in 3D.

Conventions: JSON times are UTC epoch milliseconds (fields end in `_ms`) and the app displays Pacific time; grid row 0
is the north edge; wind directions are the direction the wind blows **from**. The data contracts are in
[SPEC.md](SPEC.md) (sections 4–6).

### Command line

Run these from `backend/`:

```bash
uv run python -m fire3d.cli catalog --mode live                          # list incidents (--mode historical --min-acres 100)
uv run python -m fire3d.cli build eaton                                  # build a bundle by name or ID (--force rebuilds)
uv run python -m fire3d.cli forecast <id> --horizon 72 --ensemble auto   # optional: --start ISO, --members N
uv run python -m fire3d.cli hindcast <id> --start 2025-01-08T08:18:00Z --ensemble perturbed   # prints the skill scores
uv run python -m fire3d.cli serve --port 8710 --no-live                  # the API alone (also --reload, --live, --auto-build)
```

`--ensemble` accepts `auto` (live fires: `gfs025`; past fires: `perturbed`), `gfs025` (31 GFS members),
`ecmwf_ifs025` (51 ECMWF members), `perturbed` (31 runs around the archived weather) or `none` (a single run). The real
GFS and ECMWF ensembles only cover about the last 90 days, so past fires use `perturbed`.

Helper scripts, also from `backend/`:

| Script | Purpose |
|---|---|
| `uv run python scripts/make_fixture.py [--only demo\|live]` | write the two synthetic demo bundles |
| `uv run python scripts/serve_fixture.py --port 8710` | serve bundles from disk without the full backend |
| `uv run python scripts/check_bundle.py <id> [--quicklook DIR]` | check a bundle against the data contract; optional quick-look images |
| `uv run python -m fire3d.spread.validate hindcast …` or `… live-start …` | batch hindcasts for calibration, or the check of the live start on past fires (see [docs/validation.md](docs/validation.md), section 9) |

<details>
<summary>HTTP API</summary>

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ok, version}` |
| GET | `/api/incidents?mode=live\|historical&year=2026&min_acres=300` | incident list; `year` picks CAL FIRE's list of that year (historical mode, default 2025); each row adds `bbox_lonlat`, the analysis area of a prepared fire |
| GET | `/api/incidents/{id}` | summary, manifest and current job |
| POST | `/api/incidents/{id}/build?force=false` | a build job |
| POST | `/api/incidents/{id}/forecast` | a forecast job (body: `start_ms`, `horizon_h`, `ensemble`, `members`, all optional) |
| GET | `/api/jobs/{job_id}` | job status and progress |
| GET | `/api/bundles/{id}/{path}` | bundle files (gzip, ETag) |
| GET | `/api/incidents/{id}/aircraft` | firefighting aircraft near a live fire |
| GET | `/api/live/status` | live-loop status |
| GET | `/api/geocode?q=<US street address \| California town \| ZIP code>` | street addresses: Census Geocoder matches (cached 30 days); California towns and ZIP areas: the local Census Gazetteer index (no upstream call) |
| GET | `/api/official/calfire?incident=<id>` | CAL FIRE's current record of the fire (its own numbers and update time) and every change Fire-3d has recorded since it first checked; past fires: CAL FIRE's final record |
| GET | `/api/official/fire-weather?incident=<id>&at_ms=<ms>&margin_km=15` | NWS Red Flag Warnings and Fire Weather Watches whose zones meet the fire's area + 15 km, verbatim; the present from the NWS, past times from the Iowa Environmental Mesonet archive (labelled archived); without `incident`, every current California alert |
| GET | `/api/extras/{evacuations,cameras,cameras/latest,imagery,sources}` | optional sources (`?incident=<id>` or `?bbox=w,s,e,n`; a camera image needs `?id=<camera id>`) |

</details>

## Architecture

```mermaid
flowchart TB
  subgraph Browser["web/ · Vite, React, TypeScript"]
    App["App.tsx<br/>mounts only the active workspace"]
    MapWs["Public / Command<br/>MapLibre map · search · location card<br/>timeline · updates feed · optional sources"]
    ForensicWs["Forensic<br/>React Three Fiber scene · charts · forecast controls"]
    App --> MapWs
    App --> ForensicWs
  end
  subgraph Backend["backend/fire3d · Python 3.12, FastAPI"]
    API["api/<br/>routes · jobs · live loop · geocode · extras · official"]
    Build["build/ and sources/"]
    Spread["spread/ with pyretechnics"]
    API --> Build
    API --> Spread
  end
  Data[("data/incidents")]
  MapWs -- "/api" --> API
  ForensicWs -- "/api" --> API
  Build --> Data
  Spread --> Data
  API --> Data
```

**Backend** (`backend/fire3d/`):

| Module | Role |
|---|---|
| `config.py`, `http.py` | settings, environment variables, the FIRMS key and secret masking; a cached HTTP client with retries, a concurrency cap and the FIRMS rate limiter |
| `grid.py`, `bundle.py`, `contracts.py`, `types.py`, `timeutil.py` | analysis-area math, bundle reading and writing (atomic, locked), data contracts |
| `sources/` | one module per provider: `calfire`, `calfire_history` (the CAL FIRE change log), `firms`, `overpass` (NASA CMR satellite passes), `perimeters`, `terrain` (3DEP), `landfire`, `imagery` (NAIP), `sentinel` (dNBR), `weather` (Open-Meteo), `nws` (NWS alerts and the IEM archive), `aircraft` (adsb.lol, adsb.fi fallback) |
| `catalog.py` | the live list and the year lists (2026 season, 2025), with each prepared fire's area |
| `data/gazetteer_ca.json` | the California towns and ZIP areas index for search (built by `scripts/build_gazetteer.py`) |
| `build/` | `pipeline` (the build sequence), `aoi` (terrain, fuels, imagery, trees, burn scar), `observed` (spread reconstruction), `live_observation` (the latest observation of a live fire), `weather_bundle` |
| `spread/` | `moisture` (fuel moisture, fire weather index), `behavior`, `engine` (pyretechnics runs), `ensemble` (forecasts), `validate` (scores and calibration) |
| `api/` | `app` (routes), `jobs` (build and forecast queue), `live` (refresh loop), `geocode` (Census proxy, local towns and ZIP codes), `extras` (evacuation zones, cameras, recent imagery), `official` (CAL FIRE record and changes, NWS fire weather) |
| `cli.py` | the command line above |

**Web app** (`web/src/`):

| Folder | Role |
|---|---|
| `state/` | two zustand stores: `store.ts` (incident, the three CAL FIRE lists, live or past data, forecast run, timeline, zoom focus) and `workspace.ts` (workspace, preset, 2D/3D, basemap, units, selected point, map view, overview filter, fire card); browser history |
| `api/` | typed API client |
| `map/` | the MapLibre map: basemaps, terrain, reprojected fire overlays, vector layers, fire markers, zoom focus, fire framing, 3D buildings, controls, legend and credits |
| `location/` | search (addresses, towns, ZIP codes, coordinates, fire names), the location card and the coordinate strip |
| `ui/shell/`, `ui/timeline/`, `ui/feed/` | the map workspace layout (header, overview panel, fire card, panels, drawers, safe area, workspace switching), the compact timeline, Official now and the updates feed |
| `official/` | official information: Cal OES evacuations at a point, CAL FIRE's record and changes, NWS alerts and their map layer |
| `extras/` | optional sources: evacuation zones, cameras, recent satellite imagery and the satellite chip |
| `scene/` and the other `ui/` files | the Forensic workspace: 3D scene, effects, panels, full timeline, charts, Key Events |
| `lib/`, `data/` | geodesy, UTM reprojection, plain-language wording, raster loading |

**The two workspaces.** `App.tsx` mounts only the active workspace, so the hidden one does not render in the
background. In Public / Command, MapLibre GL JS owns the camera, terrain and tiles, and the fire grids are drawn as
reprojected image overlays draped on the terrain. Forensic keeps its own Three.js renderer. When you switch, the camera
is handed over so you keep looking at the same place.

Design documents: [SPEC.md](SPEC.md) (data contracts and HTTP API), [docs/redesign/BRIEF.md](docs/redesign/BRIEF.md)
(the map-first redesign), [docs/redesign/BRIEF-2.md](docs/redesign/BRIEF-2.md) and
[docs/redesign/PLAN-2.md](docs/redesign/PLAN-2.md) (the California overview, civilian search and official
information), [docs/redesign/CONTRACT.md](docs/redesign/CONTRACT.md) (interfaces between the parts),
[docs/validation.md](docs/validation.md) (forecast validation), [PLAN.md](PLAN.md) and
[docs/dev/module-reports.md](docs/dev/module-reports.md) (build notes).

## The forecast model and how good it is

### What the model does

Each forecast runs the open-source fire model [pyretechnics](https://github.com/pyregence/pyretechnics) (Rothermel
surface-fire spread, Van Wagner crown fire, level-set front tracking) on the analysis area, a grid of up to 512 × 512
cells of about 30–100 m. Its inputs are LANDFIRE fuels and canopy, slope and aspect from USGS elevation, and hourly
wind, temperature and humidity. Each run starts from the area that had already burned at the start time.

- **Past fires:** 31 runs around archived HRRR weather, each with slightly changed wind speed and direction, humidity
  and temperature.
- **Live fires:** the 31 GFS or 51 ECMWF ensemble members from Open-Meteo, adjusted to the HRRR model while HRRR data
  exist.

Fire-3d summarizes the runs in two ways:

- **Burn probability:** the share of runs that burned a cell by the end of the forecast (72 hours by default). It
  describes the model ensemble, not real-world odds, and it always covers the whole forecast period.
- **Arrival-time quantiles P10, P50 and P90:** the times by which at least 10 %, 50 % and 90 % of the runs had reached a
  cell. They are not scenarios, and P90 is not a "worst case".

Three calibrated settings are on by default ([docs/validation.md](docs/validation.md), sections 3 and 5):

1. **Drought-adjusted live fuel moisture.** After a dry winter the vegetation is treated as drier than the monthly
   table says. (Eaton had only 12 mm of rain since October.)
2. **Held quiet perimeter.** Edges with no growth and no satellite detection of new burning within 1 km in the
   12 hours before the start do not spread. A detection counts as spread only where it coincides with growth: hot
   pixels on ground that burned more than 12 hours earlier are burnout, not spread.
3. **A spread-rate multiplier that shrinks with lead time:** 0.5 × (0.1 + 0.9 × e^(−lead / 12 h)), which is 0.22 at
   12 h, 0.11 at 24 h and 0.05 at 72 h. It stands in for things the model lacks, such as firefighting and fires dying
   down after a wind event.

### How it was tested

Three 2025 fires (Eaton, Madre and Palisades) were re-forecast from 8 past start times and compared at 12, 24, 48 and
72 hours with the spread reconstructed from satellite detections and perimeters: 32 comparisons in all. The score is
the **growth-only Sørensen score**: the overlap between the forecast (P50) area and the observed area that burned
*after* the start, from 0 (no overlap) to 1 (a perfect match).

| Configuration | Mean of 32 | Eaton | Madre | Palisades | +12 h | +24 h | +48 h | +72 h |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Model as first specified (monthly fuel-moisture table, constant multiplier), single run | 0.390 | 0.429 | 0.207 | 0.473 | 0.274 | 0.402 | 0.451 | 0.434 |
| Current settings, single run | 0.432 | 0.432 | 0.392 | 0.458 | 0.341 | 0.425 | 0.476 | 0.485 |
| Current settings, 31-run ensemble | 0.438 | 0.438 | 0.395 | 0.467 | 0.349 | 0.432 | 0.481 | 0.490 |

The burnout rule (see the held perimeter above, added on Oct 18, 2026) raised the single-run score from 0.422 to 0.432 and the ensemble score from 0.428 to
0.438, all through Madre, which was forecast after its main run (single run 0.353 → 0.392); Eaton and Palisades did
not change. A total-area score, which also counts the area already burned at the start, averages about 0.82, but that
number looks good mainly because the starting area always overlaps. The past-fire hindcasts stored in the app's
bundles were made before the burnout rule and were not re-made: Eaton's and Palisades' are unaffected, and Madre's
would improve.

### What the scores mean

- **Skill is moderate.** Use the forecast as experimental guidance about direction and reach, not as a prediction of
  exact lines.
- **Too much growth late in a fire.** After the main wind-driven run ends, the model keeps spreading. In the median,
  the forecast grows about 1.85 times as much as the real fire. The published Madre hindcast, started after its main
  run, grew 2.1–2.5 times as much as the fire did.
- **Too little growth at the start of extreme runs.** Started 6 hours after ignition, the Eaton forecast grew 1,966
  acres in the next 12 hours, while the fire grew 6,204 (about 30 %); Palisades grew 2,967 against 11,778 (25 %). Part
  of that early "observed" growth is satellite overestimation ("VIIRS bloat") around small, very hot fires, and part is
  burning through neighborhoods, which the model cannot do.
- **Wind and slope work as expected.** Unit tests and a check on Eaton confirm that modeled fire runs downwind and
  uphill. On Eaton the default model still grew mostly north into the mountains, because the neighborhoods downwind
  are coded as non-burnable; the real fire went west and northwest.

### What is not modeled

- **Firefighting, including the initial attack that stops many small fires early.** The shrinking multiplier and the
  held perimeter imitate some of this statistically, and for live fires at least CAL FIRE's contained share of the
  perimeter is held.
- **Fire spreading through neighborhoods.** LANDFIRE marks developed land as non-burnable, so the urban burning in
  Altadena and Pacific Palisades cannot be reproduced. A tested option that lets developed land near wildland burn
  lowered the scores and is off.
- **Ember spotting.** With untuned parameters it produced about 15 times too much growth, so it is off.
- **Fuel and model uncertainty.** The runs differ only in weather, so the P10–P90 range is too narrow (about 2–4 % of
  the burned area for live forecasts).
- **Fire beyond the analysis area.** Probabilities near the edge are underestimated; forecasts warn when runs reach the
  edge.
- **Terrain-scale winds.** The weather models have 3–25 km cells, so ridge and valley winds are smoothed out.

### Caveats on the scores

- The hindcasts used almost perfect weather (archived short-range HRRR forecasts). Real-time forecasts will do worse.
- Only three fires were used, two of them in the same Santa Ana wind event, and all in chaparral and grass. The
  settings may not transfer to timber or other fire regimes.
- The shrinking multiplier will under-predict a new wind event two or three days after the start.
- The "observed" spread is itself a reconstruction: on a synthetic test its median timing error was 1.29 hours.

### Live forecasts

Live forecasts start at the **latest observation** of the fire: its newest satellite detection or mapped perimeter,
or a later satellite pass that looked at the fire and saw no new fire (checked against NASA's catalog of VIIRS and
MODIS passes). The burned area is never grown past the last detection or mapped perimeter. Any part of the perimeter
that stayed quiet for the 12 hours before the start is held, and so is at least CAL FIRE's contained share. A fully held
perimeter means no modeled growth, not that the fire is out. If CAL FIRE reports more than 1.25 times the mapped area
plus 100 acres after the last detection (the fire may have grown unseen under cloud or smoke), or NASA's pass catalog
cannot be reached, the forecast starts at the last detection instead, with a warning.

Example, Oct 17, 2026: the Henderson Fire's old forecast started at its last detection (Oct 16, 14:48 PDT) and
predicted about 13,000 acres for that evening. The new one starts at the latest pass (Oct 17, 15:50 PDT; 13 passes in
between saw no fire) and holds 3,228 acres; CAL FIRE reported 3,160 acres, 50 % contained.

Live forecasts cannot be scored yet. Instead, [docs/validation.md](docs/validation.md) section 6 re-issues past fires
as if they were live. In the 14 cases where the fire had gone quiet, the new start raised the total Sørensen score
from 0.36 to 0.67 and cut the median growth ratio from 86 to 2.6 times the observed growth; it does not affect
historical hindcasts. The sample is small and mostly one fire (9 of the 14 cases are the Lidia Fire).

**Still over-predicted: small fires that crews stop early.** The model has no suppression or initial attack; besides
the statistical settings above, only CAL FIRE's containment minimum (live fires only) partly stands in for it. In the
re-issued forecasts made after they had gone quiet, the small Lidia and Camino fires (both stayed under 400 acres)
show a mean growth error of about 1,450 acres against about 50 acres of observed growth, most likely spread from
edges that crews had already stopped. The archive cannot test a small fire
that is still actively burning: of 33 re-issued small-fire forecasts (every 2 hours), only one started while the fire
was active (Camino: 1,696 acres of forecast growth, none observed).

Always check a forecast's start and issue times. Its details list its warnings: where it starts and why, the
multiplier schedule, the share of the perimeter held and the live fuel moisture used. A forecast takes about 2–30
seconds. To reproduce the numbers, see [docs/validation.md, section 9](docs/validation.md#9-reproduce).

## Limitations

- **California only.** The overview shows what CAL FIRE lists as active and its 2026 list (300 acres or more); the
  2025 list (300 acres or more, or 100 with the picker's toggle) is behind a filter. Zooming in shows the spread only
  for prepared fires in those lists; any other fire needs "Prepare analysis" first.
- **Fixed analysis area.** Each fire's model area is set when it is built. Panning beyond it shows "Outside modeled
  area", which means unknown, not low risk.
- **Coarse observations.** Satellite detections are 375 m (VIIRS), 1 km (MODIS) or 2–3 km (GOES) across, with a few
  polar-orbiting passes a day. The replay is interpolated between them. 27 of the 78 past fires of 300 acres or
  more have no agency perimeter, so they rely on detections alone, and perimeter times are best estimates.
- **"No fire seen" has limits.** A satellite pass only rules out fire above its detection limit: thick cloud, smoke or
  smoldering can hide a burning fire. Passes are looked up at the fire's center, so a very large fire can lie partly
  outside a pass. A live forecast's start moves forward only when its bundle refreshes (new detections, or every
  3 hours for a quiet fire), so it can trail the newest pass by a few hours.
- **Search** finds US street addresses with house numbers (approximate pins), California towns and ZIP codes
  (approximate centers; the map moves there and asks for an address or a click), coordinates and fire names; no
  landmarks, businesses or street names without a house number. A town search never opens a fire, but if the town
  lies in a prepared fire's area, zooming there shows that fire's spread (for example "Malibu" shows the Bryson Fire),
  as any zoom does.
- **Evacuation data** is current status only, and only as complete as the counties that feed the Cal OES layer. Cal
  OES gives no issue time (Fire-3d shows when Cal OES listed the zone) and does not say which fire a zone belongs to;
  zones within 15 km of a fire are shown with their distance.
- **CAL FIRE history** exists only from Oct 18, 2026, when Fire-3d started recording it, and only while a backend
  checks CAL FIRE (the live loop does so every 15 minutes). Past fires show CAL FIRE's final record, and a record CAL
  FIRE edited long after containment (Eaton, Aug 2026) says that its update time is that edit, not news from the fire.
- **NWS alerts:** live alerts come from the NWS API (no live Red Flag Warning was in effect in California during the
  final test, so live outlines were checked only with recorded samples and Eaton's archived warning). Past alerts come
  from the Iowa Environmental Mesonet archive, an archived copy and not an official NWS source; its search samples 5
  points (the reported location and the corners of the analysis area) and looks back 14 days, so an alert covering
  only another part of the area, or one that began more than about 13 days earlier, could be missed. Zone outlines on
  the map are simplified to about 100 m.
- **Aircraft** are shown in Forensic only, for live fires. adsb.lol was unreachable from the development network, so
  the adsb.fi fallback (personal, non-commercial use only) usually answers. News or police helicopters that broadcast
  no callsign can be mistaken for firefighting aircraft flying low and slow over the fire.
- **Map photos and 3D shapes.** The USGS aerial photos are from June 2024 or earlier (before recent fires) and have
  voids (dark ocean blocks, a dark disc over Edwards Air Force Base at some zooms). The 3D building shapes are today's
  OpenStreetMap: buildings destroyed by a fire may be missing, and they are not a damage assessment.
- **Performance.** On a 1440 × 900 window at pixel ratio 2, Forensic's default (high quality with depth of field)
  runs at about 50 frames per second (about 37 uncapped in the realistic style); high without depth of field, medium
  and low hold 60. The map draws 2D at well over 200 frames per second; in 3D it reaches about 60–70 at pixel ratio 2
  (about 105 at pixel ratio 1), measured without the browser's frame cap.
- **Free public map services** (OpenFreeMap, Mapterhorn, USGS) have no service-level guarantee.
- **Local only.** There is no deployment, user accounts or authentication.
- **Known advisory:** maplibre-gl 5.24.0 carries advisory GHSA-jrc7-96c5-q579 (a cross-site scripting bypass in the
  sanitizer behind MapLibre's built-in attribution control). Fire-3d keeps that control off and renders credits and
  pop-ups as plain text, so the vulnerable code never runs. Upgrading to MapLibre 6.5 or newer would remove it.

## Troubleshooting

| Problem | What to do |
|---|---|
| `dev.sh` or Vite says a port is in use | Pick other ports: `API_PORT=8720 WEB_PORT=5174 ./dev.sh`. Vite uses a strict port, so it stops instead of picking another. Never use 8000. |
| The app shows errors or no incidents | Check the API: `curl http://127.0.0.1:8710/api/health` should return `{"ok": true, …}`. If you run the servers separately, set `VITE_API_TARGET`. |
| No FIRMS key | Builds still work with NASA's keyless files (see [the FIRMS key section](#optional-a-nasa-firms-key)), without GOES timing or Landsat. The bundle's warnings then include "FIRMS: no FIRMS_MAP_KEY: keyless feeds only". Add the key to `.env` and rebuild with `build <id> --force`. |
| Builds are slow | Large past fires need many FIRMS requests; Fire-3d waits for its rate limiter instead of failing. Use `./dev.sh --no-live` so live auto-builds do not compete. |
| Aircraft are missing or slow to appear | Aircraft are tracked for live fires only and shown in Forensic only (the map workspace does not ask for them). When adsb.lol cannot be reached, Fire-3d falls back to adsb.fi automatically; the first request after each 5-minute retry window can wait about 17 seconds for the timeout. |
| The map says "Street map unavailable", "Roads and place names unavailable", "3D terrain unavailable … showing a flat map" or "Aerial photos are not loading (USGS); showing the street map" | That map service is down. The fire layers keep working; after a USGS failure the map uses the dark map until you press "Try aerial again". Try another basemap, or point `VITE_OPENFREEMAP_STYLE_BASE`, `VITE_MAPTERHORN_TILEJSON` or `VITE_USGS_IMAGERY_SERVICE` at another server. |
| Zooming in on a fire shows only its marker | Its analysis is not prepared yet: the chip under the marker says "Spread not prepared yet · Prepare analysis (1-3 min)". Click it and press the button on the fire's card. With `./dev.sh`, the live loop prepares up to 4 active live fires after startup. |
| A row of "Official now" says "Unavailable right now" | That official source (Cal OES, CAL FIRE or the NWS) did not answer; Fire-3d never fills in a quiet state for it. "Not available for past dates" means the source publishes current status only (Cal OES), or the archive could not be reached. |
| Town or ZIP code searches fail | The local index `backend/fire3d/data/gazetteer_ca.json` is missing: rebuild it with `uv run python scripts/build_gazetteer.py` (see Run). |
| An optional source says "unavailable" | The official source did not answer; the panel gives the reason. Fire-3d never fills in invented data. |
| A build ends with an error | A required step failed, for example the CAL FIRE list, USGS elevation, LANDFIRE fuels or Open-Meteo weather. The message says which; retry later from the app or with `build <id> --force`. If CAL FIRE is down, its last cached list is used. Optional parts (aerial photo, burn severity, trees) only add a warning. |
| `uv sync` fails while building pyretechnics | Install a C compiler (on macOS: `xcode-select --install`) and run it again. |
| Live data is marked STALE | The newest observation is more than 6 hours old. It means "check the time", not "the fire is out". |
| A live forecast shows no growth | Its whole perimeter is held: satellites saw no new fire near it for 12 hours or more, or CAL FIRE reports it fully contained. That means no modeled growth, not that the fire is out; check official sources. |
| The Forensic scene stays blank | It needs WebGL2. Check that hardware acceleration is turned on in your browser. |

## Data sources, licenses and credits

Fire-3d uses only free public data and services. Each keeps its own terms; follow the credit and use rules below if
you share or publish anything made with Fire-3d.

> [!WARNING]
> **Some sources are for non-commercial use only:** Open-Meteo's free API, adsb.fi and ALERTCalifornia camera images
> (CC BY-NC-ND 4.0). Newer pyretechnics releases may also be non-commercial (see below). Commercial use would need an
> Open-Meteo API subscription, permission from adsb.fi, a license from UC San Diego for ALERTCalifornia, and a check
> of the pyretechnics license, or those features turned off.

### Fire, terrain and weather data

| Source | Used for | License and terms | Credit |
|---|---|---|---|
| [CAL FIRE incidents](https://www.fire.ca.gov/incidents) | incident lists, reported location, acres, containment, and the change history Fire-3d records | public website data. fire.ca.gov refuses automated requests (HTTP 403), so CAL FIRE's own conditions of use could not be read; the [State of California conditions of use](https://www.ca.gov/use/) treat information on state websites as public domain unless marked otherwise (photographs may need permission) | CAL FIRE |
| [NASA FIRMS](https://www.earthdata.nasa.gov/data/tools/firms) | satellite fire detections (VIIRS, MODIS, GOES, Landsat) | NASA open data, [no restrictions on use](https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance); optional free [MAP_KEY](https://firms.modaps.eosdis.nasa.gov/api/map_key/) | "We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) and NASA's Earth Science Data and Information System (ESDIS)." |
| [NASA CMR](https://cmr.earthdata.nasa.gov/search/site/docs/search/api.html) (Common Metadata Repository) | times of the VIIRS and MODIS passes over a live fire, which set where its forecast starts; pass times for recent imagery | NASA open data, no key, [no restrictions on use](https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance) | NASA Earthdata (CMR) |
| [NIFC WFIGS perimeters](https://data-nifc.opendata.arcgis.com/) | agency-mapped fire perimeters | open federal interagency data, no login; the public ArcGIS items (owner NIFC_Authoritative) carry only NIFC's disclaimer (no warranty; the data are not legal documents) and no use restrictions | Wildland Fire Interagency Geospatial Services (WFIGS) Group, NIFC |
| [USGS 3DEP](https://www.usgs.gov/3d-elevation-program) | elevation for the model and the Forensic terrain | U.S. public domain ([USGS copyrights and credits](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)) | U.S. Geological Survey |
| [LANDFIRE](https://landfire.gov/) (LF2024, LF2025) | fuels and canopy for the model | U.S. Government data (U.S. Department of the Interior and USDA Forest Service), public domain with no use constraints in the USGS metadata; landfire.gov itself states no license and asks to be cited | cite as on [landfire.gov/data/citation](https://landfire.gov/data/citation) |
| [NAIP](https://naip-usdaonline.hub.arcgis.com/) (USDA), served by [The National Map](https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer) | aerial photo in Forensic, water mask | U.S. public domain, credit requested ([USDA FSA policy](https://www.fsa.usda.gov/help/policies-and-links)) | USGS, USDA, The National Map: Orthoimagery |
| [Sentinel-2 L2A](https://registry.opendata.aws/sentinel-2-l2a-cogs/) via [Element 84 Earth Search](https://www.element84.com/earth-search/) | burn severity (dNBR); recent images | [Copernicus Sentinel data legal notice](https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice): free, full and open access, modification allowed | "Contains modified Copernicus Sentinel data <year>" |
| [Open-Meteo](https://open-meteo.com/) | weather: HRRR, GFS and ECMWF ensembles, archived forecasts, ERA5 | data [CC BY 4.0](https://open-meteo.com/en/licence); the free API is for **non-commercial use only**, under 10,000 calls a day ([terms](https://open-meteo.com/en/terms)) | "Weather data by Open-Meteo.com", linked to open-meteo.com |

### Map, search and aircraft

| Source | Used for | License and terms | Credit |
|---|---|---|---|
| [OpenFreeMap](https://openfreemap.org/) | dark and roads basemaps, labels | free, commercial use allowed, no service-level guarantee ([terms of service](https://openfreemap.org/tos/)) | OpenFreeMap |
| [OpenMapTiles](https://openmaptiles.org/) | vector tile schema and style design | design [CC BY 4.0, code BSD-3-Clause](https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md) | © OpenMapTiles |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | roads, places and labels, and the 3D building shapes (served by OpenFreeMap) | [ODbL 1.0](https://www.openstreetmap.org/copyright) | © OpenStreetMap contributors |
| [Mapterhorn](https://mapterhorn.com/) | 3D terrain and hillshade | code BSD-3-Clause; tiles built from open data, listed on its [attribution page](https://mapterhorn.com/attribution/). In California: USGS 3DEP (public domain) and Copernicus GLO-30 (Copernicus free and open license) | © Mapterhorn; U.S. Geological Survey; Copernicus GLO-30: © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA |
| [USGS Imagery Only](https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer) | aerial basemap (dated photos, not live) | U.S. public domain ([USGS](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)) | USDA, USGS The National Map: Orthoimagery |
| [MapLibre GL JS](https://maplibre.org/) 5.24.0 | map renderer | [BSD-3-Clause](https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt) | MapLibre |
| [US Census Geocoder](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html) | street-address search (`Public_AR_Current` benchmark) | free U.S. government service, no key; no separate terms page | U.S. Census Bureau |
| [U.S. Census Bureau Gazetteer Files](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html) (2026: California places and ZIP Code Tabulation Areas) | town and ZIP code search, from a local index (no request at search time) | U.S. public domain (a U.S. Government work, 17 U.S.C. 105) | U.S. Census Bureau Gazetteer Files |
| [adsb.lol](https://www.adsb.lol/docs/open-data/api/) | live aircraft positions | ODbL 1.0 | adsb.lol |
| [adsb.fi](https://github.com/adsbfi/opendata) | aircraft fallback when adsb.lol cannot be reached | **personal, non-commercial use only**; about 1 request per second | adsb.fi, with a link to its home page |

### Official and optional public sources

| Source | Used for | License and terms | Credit |
|---|---|---|---|
| [National Weather Service API](https://www.weather.gov/documentation/services-web-api) | current Red Flag Warnings and Fire Weather Watches in California and their fire-weather zone outlines | U.S. public domain, open data ([NWS disclaimer](https://www.weather.gov/disclaimer)); no key; Fire-3d sends the User-Agent "Fire-3d/0.1 (research prototype)" and limits itself to 30 requests a minute | National Weather Service |
| [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/) (Iowa State University) NWS product archive | past Red Flag Warnings and Fire Weather Watches for replays | public domain ([IEM disclaimer](https://mesonet.agron.iastate.edu/disclaimer.php)); an archived copy of NWS products, not an official NWS source | National Weather Service, archived copy via the Iowa Environmental Mesonet (Iowa State University) |
| [Cal OES California Evacuation Aggregation Layer](https://data.ca.gov/dataset/california-evacuation-aggregation-layer) (with the County Evacuation Inventory) | official evacuation zones | public, "No restrictions on public use"; Cal OES disclaimer: "This information is constantly changing, and Cal OES does not verify or certify the information contained herein." | Evacuation zones: local officials via Cal OES |
| [Cal OES California Webcams](https://www.arcgis.com/home/item.html?id=5b4040338d704693994d5682ab2747c5) | camera locations | public use | Cal OES California Webcams |
| [ALERTCalifornia](https://alertcalifornia.org/terms/) (UC San Diego) | wildfire camera images | **CC BY-NC-ND 4.0: non-commercial, no derivatives**; never crop the information bar or partner logos ([crediting rules](https://alertcalifornia.org/crediting-and-branding/)) | ALERTCalifornia \| UC San Diego, with every image |
| [Caltrans CCTV](https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm) | traffic camera images | no charge; public domain ([conditions of use](https://dot.ca.gov/conditions-of-use)) | Caltrans |
| [NASA GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api) | Landsat (HLS), VIIRS and GOES-West image tiles (their pass times come from NASA CMR, above) | NASA open data, [no restrictions on use](https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance); GOES is NOAA public domain | the product's credit plus "NASA GIBS (ESDIS)" and the GIBS acknowledgement |
| [Element 84 Earth Search](https://www.element84.com/earth-search/) | Sentinel-2 scene search | free public STAC API; the images follow the Copernicus terms above | Earth Search by Element 84 |

### Software

- **[pyretechnics](https://pypi.org/project/pyretechnics/2026.8.10/) 2026.8.10** (the fire-spread engine, Spatial
  Informatics Group) is pinned in `backend/pyproject.toml` and is released under the **Eclipse Public License 2.0**
  (stated on its PyPI page and in the license file of the installed package). The app credits it, with its version and
  license, in the "Data sources" note of the Analysis drawer and Forensic's Evidence tab whenever a forecast is shown. The project's GitHub `main` branch now
  carries a different [dual license](https://github.com/pyregence/pyretechnics/blob/main/LICENSE.md): a no-fee
  "Community License" for non-commercial use and a paid commercial license. Check the license before upgrading.
- The other dependencies (React, Three.js, FastAPI, rasterio and so on) keep their own open-source licenses; see
  `web/package.json` and `backend/pyproject.toml`.
- Fire-3d's own code has no license file yet.
