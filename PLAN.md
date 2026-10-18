# Fire-3d — Plan

A real-data version of the mocked 3D wildfire demo (`docs/reference/firetrace-demo.png`): real terrain, real fire
observations, real weather, and an ensemble fire-spread forecast. Detailed build contract: **[SPEC.md](SPEC.md)**.

## Decisions

| Topic | Decision |
|---|---|
| Goal | Visual demo on real data first, then harden prediction into something defensible |
| Region | California |
| Incidents | **Live:** everything CAL FIRE lists as active. **Past:** all 2025 CA fires ≥ 300 acres (toggle ≥ 100), not just one showcase fire |
| Modes | Live (now + 72 h forecast) and Historical (forensic replay + hindcast from any moment, scored against reality) |
| Prediction | Physics: `pyretechnics` (Rothermel surface + crown fire, level-set spread), run once per ensemble member → burn probability |
| Weather | Open-Meteo: HRRR 3 km for single forecasts. Live ensembles from GFS (31 runs) / ECMWF (51 runs). 2025 replays use archived HRRR with a perturbed 31-member ensemble, because real ensembles only go back ~90 days |
| WeatherNext 3 | Access requested; **skipped for now**. Weather sits behind a `WeatherSource` interface so it can be added later |
| Visual style | Cinematic **realistic + parametric** look from `docs/reference/art-direction.png`: photographic terrain in a dark, moody atmosphere with a golden data lattice, isolines, and monospace telemetry, plus depth of field. Modes: hybrid (default), realistic, parametric. The panel layout follows the original demo, restyled as dark glass |
| Stack | React + react-three-fiber frontend, Python FastAPI backend (uv) |
| Hosting | Local first; deployment comes later |
| Drones/Resources tabs | Replaced by live firefighting aircraft from ADS-B (adsb.lol) |
| Build approach | **Everything in one pass** (no multi-phase rollout), except deployment |

## Data (all free; one free NASA FIRMS key)
- **Terrain:** USGS 3DEP.
- **Fuels and canopy:** LANDFIRE LF2024 (pre-2025 fuels) / LF2025 (live).
- **Aerial imagery:** NAIP.
- **Burn scar:** Sentinel-2 dNBR.
- **Fire observations:**
  - NASA FIRMS via the MAP_KEY in the gitignored `.env`: three VIIRS satellites + MODIS + GOES (minutes-level
    timing) + Landsat. Keyless 7-day and 2025 yearly files are the fallback.
  - NIFC daily perimeters.
  - CAL FIRE incident lists.
- **Weather:** Open-Meteo (HRRR, GFS/ECMWF ensembles, historical HRRR).
- **Aircraft:** adsb.lol.

Full endpoint list, formats, and gotchas: SPEC.md §2.

## How the pieces fit
```
 Terrain (DEM) ───┐
 Fuels (LANDFIRE) ┼──► pyretechnics (Rothermel + level set) ──► arrival-time raster per member
 Weather member ──┤          × 31–51 ensemble members                  │
 Fire now ────────┘                                                    ▼
 (FIRMS + perimeters)                                  arrival quantiles p10/p50/p90 + burn probability
```
Every fire layer (observed or forecast) is an **arrival-time raster**. The terrain shader compares it to the
timeline time, so scrubbing is free. Forecast probability at time t comes from the per-pixel arrival quantiles.

## Build
Run as one coordinated multi-agent build, from SPEC.md:
1. **Scaffold:** repo, environments, shared contracts, a fixture bundle, and a fixture server.
2. **Parallel modules:**
   - terrain/imagery/fuels/trees/burn scar
   - fire data + catalog → observed reconstruction
   - weather + fuel moisture
   - spread engine + ensemble + hindcast
   - API/jobs/live refresh/aircraft
   - 3D scene
   - UI shell/charts/timeline
3. **Integration:** real builds for 2025 fires (e.g. Eaton, Madre) and a live fire; end-to-end UI screenshots.
4. **Independent review and fix pass:** science/units, data robustness, rendering/UX, contract consistency.

## After v1 (not in this build)
- **WeatherNext 3:** a `WeatherSource` adapter; its 64-member ensemble replaces GFS/ECMWF.
- **WindNinja:** terrain-aware wind downscaling, if hindcasts show wind is the main error.
- **Hugging Face ML models:** side by side with physics (`eitanlebras/fire-spread-forecast-v1-small`,
  `RAI-Lab/Wildfire-FM`); validate against WildfireSpreadTS.
- **Deployment:** Google Cloud Run + GCS + Cloud Scheduler. Check the data terms before a public link, and keep the
  "not for operational use" disclaimer.

## Known limits
- Satellite detections are coarse: VIIRS 375 m, MODIS 1 km, a few passes per day. Replays are interpolated between
  observations.
- The spread model doesn't simulate suppression and simplifies spotting. LANDFIRE fuels can lag reality.
- Weather is 3–25 km resolution, so ridge and valley winds are smoothed.
