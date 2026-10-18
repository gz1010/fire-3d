# Map-first UI/UX redesign: brief

This is the user's brief of 2026-10-17, reproduced verbatim below. Where it conflicts with the UI defaults in SPEC.md, this brief wins (see its section 1).

**Reference images** (in `docs/reference/`):
- "Image 1" is `redesign-ref-1-public-dark.png`: the Public view, with a subdued dark geographic context.
- "Image 2" is `redesign-ref-2-command-aerial.png`: the Command view, with desaturated aerial imagery and cyan selection.
- `redesign-ref-3-forensic.png` is an extra mockup of a restyled Forensic workspace. It is optional direction only, and Forensic keeps all its existing functionality.

The mockups show direction, not pixel targets; the user said they "don't need to be 100% looking like this". Their place names and numbers are invented.

**Decisions made with the user on 2026-10-17:**
- Backend integration (real builds, forecasts, calibration, API checks) runs alongside the redesign. A final full-stack pass then verifies the new UI on real fires.
- All three optional sources (evacuation zones, public cameras, recent satellite imagery) are built after the core, where free official access allows.
- Quality comes before saving usage.
- Public/Command use US customary units (mph, ft, mi, °F, acres). Scientific units stay in Forensic and in detail views.

---

Implement a map-first UI/UX redesign for Fire-3d.

Audience:
Civilians and emergency managers.

Product goal:
Users should quickly understand:
- Where the fire is.
- Which nearby places may be affected.
- What the forecast shows.
- What has changed.
- How current and reliable the information is.
- The coordinates of the incident or selected location.

The current problems are:
- The analysis area appears as a cropped square floating in empty space.
- Surrounding roads, towns, neighborhoods, and landmarks are missing.
- Scientific jargon dominates the interface.
- The bottom charts and full-height sidebar crowd the map.
- Too many overlays compete for attention.
- Coordinates and useful location context are not prominent enough.

Work through the phases below in order. Implement and verify the changes.
Do not stop after producing a plan.

The map architecture and baseline providers have already been researched.
Use the decisions below rather than repeating a broad provider comparison.

1. INSPECT AND PRESERVE THE EXISTING APPLICATION

Read SPEC.md and relevant code before making changes.

Start with:
- web/src/App.tsx
- web/src/state/store.ts
- web/src/scene/Scene.tsx
- web/src/scene/assets.ts
- web/src/scene/terrain/Terrain.tsx
- web/src/scene/terrain/terrainMaterial.ts
- web/src/scene/camera/CameraRig.tsx
- web/src/lib/geo.ts
- web/src/ui/RightPanel.tsx
- web/src/ui/BottomDock.tsx
- web/src/ui/Timeline.tsx
- web/src/ui/KeyEvents.tsx
- web/src/ui/IncidentOverview.tsx
- web/src/styles/
- backend/fire3d/api/app.py
- backend/fire3d/spread/ensemble.py

Reuse existing functionality where practical:
- Incident and forecast loading.
- Zustand state.
- Timeline and historical replay.
- Geographic coordinate conversion.
- Probes and location sampling.
- Event selection and fly-to actions.
- Existing scientific arrays and data sources.

These new requirements replace conflicting UI defaults in SPEC.md.
Preserve existing data contracts, coordinate conventions, simulation
behavior, and live/historical functionality.

Keep the application name Fire-3d.

Protect secrets. Keep the optional NASA FIRMS key in the existing
environment configuration. Never expose it in frontend code, logs,
screenshots, documentation, or error messages.

Respect the repository’s disk constraints. Avoid bulk downloads and
unnecessary regeneration of incident bundles or forecasts.

2. ESTABLISH TWO WORKSPACES

Create two top-level workspaces:

A. Public / Command

Use one shared map implementation with two presets:

Public:
- Default preset.
- Emphasize incident status, understandable forecasts, location checks,
  nearby places, and incident updates.
- Start in a clean, north-up 2D view with an obvious 3D toggle.
- Keep advanced scientific controls secondary.

Command:
- Use the same map and underlying data.
- Make coordinates, source timestamps, incident identifiers, and selected
  location information more prominent.
- Provide denser operational information without restoring all the
  Forensic visual effects.

B. Forensic

Preserve:
- Existing Three.js/R3F analytical scene.
- Charts and scientific units.
- Historical replay and hindcasts.
- Forecast controls.
- Hybrid, realistic, and parametric visual styles.
- Golden lattice, detailed telemetry, and other analytical overlays.

Do not delete analytical functionality to simplify Public/Command.

Keep these concepts separate in state:
- Workspace: Public/Command or Forensic.
- Preset: Public or Command.
- Data context: live or historical.
- Perspective: 2D or 3D.
- Visual style where applicable.

Do not overload the existing live/historical “mode” field.

Changing workspace, preset, or perspective must preserve the selected
incident, forecast, timeline position, selected location, and geographic
view center where practical.

3. BUILD THE CONTINUOUS GEOGRAPHIC MAP

Use this baseline stack:

Renderer:
- MapLibre GL JS.
- Pin a stable release compatible with the implementation.
- Use Mercator projection for the baseline.

Vector roads and place labels:
- OpenFreeMap.
- Starting style:
  https://tiles.openfreemap.org/styles/liberty
- Derive suitable dark and road-focused styles from its available styles.

Continuous terrain:
- Mapterhorn.
- TileJSON:
  https://tiles.mapterhorn.com/tilejson.json
- Its terrain tiles use Terrarium encoding.
- Follow the provider’s published source configuration and metadata.

Aerial imagery:
- USGS Imagery Only:
  https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer
- Tile template:
  https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}
- Tile size: 256.
- Coordinate system: Web Mercator.
- Respect actual service coverage and useful imagery resolution.

Address lookup:
- Census Geocoder for explicitly submitted US street addresses.
- API documentation:
  https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html
- Use the current documented benchmark.
- Proxy requests through the existing backend where useful for caching,
  request control, and browser compatibility.

Coordinate entry, map clicks, and local incident search must work without
a geocoding service.

Provider constraints:
- No additional API key or billing account is required for this baseline.
- Keep provider endpoints configurable.
- Preserve required attribution and software/style license notices.
- OpenFreeMap permits commercial use and advertises no interactive
  map-view/request limits, but offers no SLA.
- Its offline-download policy is separate: at most 3,000 tiles or 50 MB
  per download, at most four parallel requests, and an identifying
  User-Agent. Do not build offline downloading in this change.
- Mapterhorn and USGS publish no numeric request allowance in the reviewed
  documentation. Do not describe them as guaranteed unlimited.
- Mapterhorn data licenses vary by source. Preserve terrain/source credits.
- Credit USDA/USGS and applicable imagery sources.
- Treat these as replaceable public services with honest failure states.

Do not introduce:
- A paid map-service dependency.
- Google billing setup.
- A Google Earth embed.
- A statewide PMTiles download.
- A second map engine without a concrete unresolved need.

Required map behavior:
- Continuous panning and zooming beyond the incident analysis area.
- Readable roads, towns, neighborhoods, and relevant landmarks.
- A compass and reset-north action.
- A scale.
- A “Return to incident” action.
- Consistent location selection in both perspectives.
- A usable flat geographic map if terrain becomes unavailable.

Provide three basemap choices:
- Dark vector.
- Road/navigation style.
- Aerial imagery with road and place labels.

The road/navigation style does not require turn-by-turn routing.

Implement 2D and 3D as perspectives of the same MapLibre map:
- 2D uses a top-down view.
- 3D uses continuous terrain and an oblique camera.
- Preserve geographic center and selection during transitions.

4. ADAPT WILDFIRE OVERLAYS WITHOUT DUPLICATING TERRAIN

The existing terrain shader combines elevation, imagery, observed fire,
and forecast fields. Do not simply place that complete terrain mesh on
top of MapLibre terrain.

For Public/Command:
- Let MapLibre own the map camera, terrain, navigation, and tile loading.
- Use native geographic layers for perimeters, detections, incident
  markers, selected locations, and labels.
- Display observed-arrival and forecast raster fields through transparent
  image/canvas overlays draped onto MapLibre terrain.
- Reuse the existing scientific arrays and display logic where practical.

Geographic correctness:
- Reproject the existing UTM grids correctly for map display.
- Do not stretch an axis-aligned latitude/longitude bounding box over the
  map and assume that the raster is aligned.
- Preserve row orientation, pixel-center conventions, nodata masks, and
  the correct incident UTM zone.
- Use one consistent displayed terrain surface for overlay alignment.
- Sample location checks from the original scientific grids.
- Reproject display output without changing scientific values.

Keep the simulation limited to its existing analysis area.
Panning outside the area must not expand or rerun the simulation.
Outside coverage, show “Outside modeled area.”

Retain the existing R3F renderer for Forensic.

If an actual 3D object requires Three.js in Public/Command:
- Use a small custom layer sharing MapLibre’s WebGL context and camera
  transforms.
- Let MapLibre control the render lifecycle.
- Handle depth and WebGL state correctly.
- Avoid running two independently controlled terrain scenes.
- Do not move the entire R3F scene into the map merely to display a few
  objects.

Keep MapLibre’s experimental renderToTerrainTile API outside the baseline
dependency path.

Performance:
- Stream visible tiles.
- Cache incident assets and reprojection mappings.
- Update raster display when timeline, forecast, or layer state changes.
- Avoid recomputing scientific fields on every map frame.
- Stop rendering the inactive workspace.
- Keep wildfire overlays below readable road/place labels where appropriate.

First prove this approach with one incident before integrating all UI changes.

5. APPLY THE REFERENCE IMAGES

Use both attached images as visual direction.

Image 1:
- Subdued dark geographic context.
- Restrained outlines.
- Selective highlights.
- Readable labels.
- Clear separation between background context and selected objects.

Image 2:
- Desaturated aerial imagery.
- Clear geographic boundaries.
- Strong regional context.
- Selective cyan highlights for selected sites or locations.

Use orange/red for wildfire information and distinct styling for selection.
Keep observed fire, forecasts, detections, and official evacuation zones
visually distinguishable.

Building extrusions are optional where suitable data exists.
Continuous geographic context is required.

Prioritize legibility over decorative effects.

6. SIMPLIFY THE DEFAULT LAYOUT

Make the map the dominant surface.

Public/Command should contain:
- Compact incident and workspace controls.
- Address/coordinate/local incident search.
- Small map controls.
- A collapsible updates panel on the right.
- A compact floating timeline at the bottom.
- A persistent incident-coordinate strip.

Collapse the three bottom charts by default.
Keep them accessible through an Analysis drawer and in Forensic.

Move advanced layers, scientific settings, and visual effects into
secondary controls.

Keep only essential incident information visible initially.
Target at least 75% unobstructed map area on a 1440×900 desktop viewport
with no drawer expanded.

Reuse and update the existing safe-area logic so camera framing,
tooltips, and selected locations account for visible panels.

For narrow screens:
- Use collapsible drawers or bottom sheets.
- Keep search, coordinates, and timeline accessible.
- Avoid covering most of the map with default panels.

7. SIMPLIFY THE TIMELINE

Retain playback and historical replay.

Provide:
- Past observations.
- NOW for live context.
- +24h / +48h / +72h where supported by the selected forecast.

Clearly distinguish observations from forecasts.
Show forecast issue time and valid time.
Disable unavailable periods rather than inventing data.

Distinguish actual current time from the latest available observation.
Show stale-data status where appropriate.

Basemap changes must preserve wildfire overlays, timeline state,
selection, and required attribution.

8. ADD LOCATION CHECKS AND PERSISTENT COORDINATES

Allow location selection through:
- Submitted street address.
- Pasted latitude/longitude.
- Clicking the map.

Census address results are interpolated along address ranges.
Label them appropriately and allow users to adjust the pin.
Do not imply rooftop accuracy.
Census Geocoder is not general POI search or autocomplete.

Show a plain-language location card with available information:
- Address/place label or coordinates.
- Inside or outside the latest observed perimeter.
- Distance and direction from that perimeter.
- Perimeter timestamp.
- Modeled burn probability for an explicitly stated period.
- Available modeled arrival-time information.
- Relevant wind and terrain context.
- Sources, freshness, and uncertainty.

Calculate values from real geometry and model outputs.
Label approximations.
Do not describe the nearest satellite detection as an exact fire front.

Model semantics:
- The existing burn_probability raster describes probability by the
  forecast’s full horizon.
- Do not relabel a 72-hour probability as “next 24 hours.”
- Show only supported periods unless the necessary time-specific output
  is implemented.
- Do not derive exact probabilities from three arrival-quantile rasters.
- P10/P50/P90 are arrival-time quantiles, not wind-shift scenarios.
- Do not label P90 as “worst-case spread.”
- Handle never-burn, missing forecast, and nodata values explicitly.
- Outside the modeled area means unknown, not low risk.
- Explain that modeled probabilities describe the model ensemble.

Use qualitative risk categories only with documented, defensible definitions.

Prioritize point checks.
Do not imply a single point check establishes the safety of a whole route.
Identify route/polygon analysis as separate work if it needs new support.

Coordinates:
- Always display the selected incident’s reported coordinates, including
  when panels are collapsed.
- Separately display selected-point coordinates.
- Label the location type accurately.
- Do not call a reported incident location the exact ignition point.
- Use clearly labeled WGS84 latitude/longitude with copy controls.
- Make coordinates, incident identifiers, and timestamps especially
  prominent in Command.

Do not silently add public Nominatim as an alternative.
Its public service forbids autocomplete, limits the whole application to
one request/second, requires identification and attribution, and requires
a deliberate developer decision to accept its usage policy.

9. TRANSLATE TELEMETRY AND REDUCE CLUTTER

Use understandable primary labels:
- “Spread speed” with everyday units instead of unexplained ROS/chains/hour.
- “Fire weather severity” with an explanation of FFWI.
- Forecast descriptions stating the period, probability, and uncertainty.
- “Activity lattice” or “Slope lattice” instead of unexplained terminology.

Retain original scientific names, units, and values in accessible details
and in Forensic.

Do not invent authoritative “slow,” “fast,” or severity categories.
Use defensible thresholds and document their meaning.

Keep these off by default in Public/Command:
- Golden lattice.
- Dense telemetry.
- Decorative particles.
- Nonessential smoke and visual effects.
- Advanced analytical overlays.

Prioritize:
- Observed perimeter.
- Satellite detections.
- Selected forecast overlay.
- Roads and place labels.
- Selected location.
- Official evacuation information when available.

Use legends, labels, line styles, and fill patterns.
Do not rely on color alone.

Keep experimental forecasts distinct from official evacuation instructions.

Interpret wind direction using the existing meteorological FROM convention.
Only describe a “primary driver” when there is evidence supporting that
attribution.

10. PROMOTE KEY EVENTS INTO THE UPDATES FEED

Move Key Events from the bottom dock into the primary right-side panel.

Reuse the existing event model, annotations, selection, and timeline markers.

Each item should show:
- Plain-language title and useful detail.
- Event timestamp.
- Source.
- Whether it is an observation, estimate, model output, official update,
  or user annotation, as applicable.

Use a clear chronological ordering.
Keep live updates and historical replay behavior understandable.
Do not present automated events as human reporting.

Clicking a geolocated event should:
- Select it.
- Move the timeline to its time where appropriate.
- Fly or pan to its location in both 2D and 3D.

Events without coordinates must remain usable without an invented target.

11. HANDLE EVACUATIONS, CAMERAS, AND RECENT IMAGERY HONESTLY

Complete the core map and UI before optional source integrations.

Where suitable free sources are available, integrate:
- Official evacuation zones/status.
- Public camera feeds.
- Recently acquired satellite imagery.

Use official documentation to verify access and usage requirements for
these additional integrations.

For evacuation data:
- Show the issuing authority and update time.
- Preserve official status wording.
- Do not show current evacuation status as historical fact in replay.
- Show unavailable status when an appropriate source is missing.

Distinguish:
- Dated basemap aerial/satellite imagery.
- Near-real-time fire detections.
- Recently acquired satellite imagery.
- Camera imagery or video.

Show available acquisition/update times and relevant coverage, cloud,
resolution, or latency limitations.

Do not call ordinary USGS basemap imagery “live satellite.”
Do not fabricate evacuation records, camera feeds, or satellite updates.

Keep demonstration data confined to clearly labeled development fixtures.
If a source requires unavailable access or additional infrastructure,
complete independent work and report the dependency.

12. VERIFY AND DELIVER

First verify one incident:
- Confirm raster/vector alignment at multiple interior points and all AOI edges.
- Test relevant UTM zones and coordinate conversions.
- Pan beyond the AOI.
- Change zoom, pitch, bearing, and basemap.
- Scrub observation and forecast times.
- Confirm selection survives perspective/workspace changes.
- Check attribution and provider failure states.

Then verify the complete interface:
- Continuous geographic context in Public/Command 2D and 3D.
- Correct overlay alignment.
- Persistent incident coordinates.
- Address lookup, coordinate entry, and map selection.
- Missing forecasts and outside-modeled-area behavior.
- Event selection in both perspectives.
- Accessible Forensic tools.
- Desktop and narrow-screen layouts.
- Keyboard access and reduced-motion behavior.
- No unnecessary background rendering.

Run:
- Frontend build and lint checks.
- Relevant backend tests when backend behavior changes.
- Focused tests for new coordinate, probability/time, and location-check logic.
- The existing screenshot workflow, followed by visual inspection.

Use existing fixtures where suitable. Avoid unnecessary network-heavy
bundle builds or simulation runs.

Deliver:
- Concise summary of changes.
- Verification results and screenshots.
- Any remaining integrations or limitations.
- Any architectural deviation from this prompt, with its concrete reason.

Proceed through routine implementation decisions without repeated approval
requests. If an optional integration is blocked, complete the independent
work and clearly report the missing dependency.
