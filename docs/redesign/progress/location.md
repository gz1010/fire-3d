# location agent progress log

Role: location (API 8714, Vite 5183). Owns backend/fire3d/api/geocode.py, backend/tests/test_geocode.py,
web/src/location/**, web/src/lib/geodesy.ts (+ tests).

## Done
- 16:10 attempt 1 started from the foundation skeletons. Read BRIEF, CONTRACT, SPEC 4-6, ensemble.py semantics,
  rasters.ts, workspace.ts, store, probe driver, fire3d.http, conftest.
- Census docs checked (Geocoding_Services_API.html + /geocoder/benchmarks, 2026-10-17): current documented benchmark
  = Public_AR_Current (id 4, "Public Address Ranges - Current Benchmark", isDefault). Recorded 4 samples (single
  match, no match, 50-match ambiguous, 400 invalid benchmark) for offline tests.

- 16:20 backend/fire3d/api/geocode.py + tests/test_geocode.py (29 tests pass): Census proxy, normalised-query cache
  (memory LRU + fire3d.http disk cache, 30 d), own rate limit 30/min, 400/429/502/504, coordinates refused.
- 16:30 lib/geodesy.ts (parser: decimal/DMS/DM/hemispheres/labels/map links; Vincenty WGS84) 73 tests;
  location/geometry.ts (point-in-rings, nearest edge, reconstructed footprint) 10 tests; location/types.ts (additive
  fields); locationCheck.ts full report 34 tests; describe.ts plain-language card model 18 tests.

- 16:45 search.ts (+19 tests), SearchBox, LocationCard (summary-first + details disclosure), CoordinateStrip,
  addressStore, location.css. Map-core's real MapView landed (pin draggable when adjustable). First screenshots OK.

- 17:05 Verified in the running app with the real map (scratchpad flows.mjs, Playwright + Chrome GPU): address ->
  approximate + draggable pin, drag 177 m -> adjusted; DMS paste via "/"; clicks inside / never-burn / outside AOI;
  ambiguous list (10 of 50) + keyboard choice; Command strip (DMS + UTM); Camino (zone 10, no forecast); Cooley
  (live, zone 10); phone 390 px compact sheet. Fixes from screenshots: summary-first card, phone compact mode,
  strip layout, wording (arrival "not reached by the end", outside forecast line, wind "at the fire").

- 18:25 resumed after the pause. Location tests 157 pass, geocode 29 pass, full backend 478 pass, typecheck clean.
  3D click (pitch 58) selects within 30 m (~1 px) of the target; incident search "Palisades" switches incidents.
- 18:45 fixed the two layout problems the shell reported (known bug #3): the card summary is shorter (sources,
  periods and explanations of summary lines move into the details as notes; at-time line in the details; kind tags
  lead their lines; Command details collapsed by default and remembered per preset in cardPrefs.ts). Card 407 ->
  300 px (inside), 558 -> 378 px (outside); 1440x900 unobstructed with a point: Public 63.9 -> 66.5 % / 60.4 ->
  64.7 %, Command 49.5 -> 54.9 %. Strip: lat / lon wrap as whole units and buttons never shrink (880 px: no
  overflow; before, buttons ran 19 px past the strip). describe tests + 1 (158 location/geodesy tests).

- 19:00 card: "model and observation differ" line when the fire reached a spot during the run but no run did
  (e.g. 600 E Mariposa St: burned ~Jan 8 07:39, 0 of 31 runs); duplicate "no run reached" arrival line and the
  outside-area forecast line stay in the details; shorter address type line; years on source times and on the
  Command strip timestamps. Strip: the shell switched the Public column to min-content, so wrapping is now enabled
  only when the strip is actually squeezed (CoordinateStrip fitStrip -> .is-tight); one line at 1024-1440 px.
  1440x900: Public default 75.7 %, with a point 66.9 %; Command 63.0 % / 55.3 %. CONTRACT §6 "as built" note.

- 19:15 final verification with the real map (API 8714 FIRE3D_LIVE=0, Vite 5183; both stopped): all 12 flows pass
  (address + drag 177 m, DMS paste, clicks inside / no run / outside AOI centred first, ambiguous list, Command
  details remembered, Escape closes only the search list with Layers open, 880 px strip, Camino, Cooley, 3D, phone).
  Reconstructed perimeter line now carries its age ("12 h ago" live). Screenshots docs/screenshots/redesign-location-
  *.png (14). vitest 387/387, typecheck 0, lint 55 baseline (0 in location), build ok, geocode 29, backend 478.

## Next
- Done; report sent. Possible follow-ups listed in the report (updates panel folding, DEM 404s are map-core's).

## Decisions
- Cache: memory LRU (512) + fire3d.http disk cache, both 30 d, keyed by the normalised query (task asked 30 d via
  fire3d.http; CONTRACT said ~24 h in-process). Only parseable replies are kept in memory; a bad disk entry is refetched.
- Upstream address is the case-folded, upper-cased normalised query (one spelling per cache key).
- Reconstructed footprint fallback when no mapped perimeter <= t: arrival <= t cells; distance to the nearest burned
  cell square; inside -> distance to the nearest unburned cell.
- Distances/directions: nearest point found in the UTM plane, then Vincenty WGS84 distance + true bearing.
- Forecast arrival rasters: pixels already burned at the forecast start hold exactly start_h (engine sets the ignition
  mask to start) -> "already burned when the forecast starts", not an arrival.
- Card = summary (perimeter + time, burn time if relevant, burn chance with end time and horizon, arrival quantiles,
  wind/terrain line) + one disclosure (notes with sources / periods / meanings, nearest detection, at-time statement,
  conditions, caveats, sources with years, Command scientific values). Disclosure state per preset, memory only.

## Open problems
- 75 % unobstructed with a selected point is not reachable by the card alone at 1440x900 (default layout is ~75 %
  before the card); suggestion for ui-integration: fold the updates panel while a point is selected.
