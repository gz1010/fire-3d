# brief2-map progress (role: map; API 8711, Vite 5181)

Owns `web/src/map/**` (+ tests) and `web/src/lib/fireBounds.ts` (+ test).

## Done
- 2026-10-18: read BRIEF-2, PLAN-2, audit-2/opening-map.md, CONTRACT, the map code.
- 12:16 lib/fireBounds.ts + test (12, incl. real Eaton / Norte): burned ∪ latest perimeter ∪ P90 ∪ point, +40 %,
  3 km .. AOI; point + acreage (2.5 radii) without mapped data.
- 12:25 map/framing.ts + test (19): pure goalFor() + Framing state machine (first load keeps restored view for the
  linked incident; one flight when ready; done only on completion; re-issue on non-user interruption, max 4; user
  gesture / explicit request ends it; provisional point/building goals upgraded unless the user moved).
- 12:55 overviewLayers.ts + test (7, style-spec validated); basemapStyle (muted 3D buildings per basemap, hidden in
  2D, overlayBeforeId; aerial major roads 0.45) + tests; layers.ts aerial theme (casings, 12 px labels, lighter
  observed fill + outline-only detections from z13, incident hit circle) + layers.test.ts (5); providers photo-date
  line + test; mapStore actions/framing/fireBounds; mapController rewritten around Framing (overview layer, fire
  hit-test I3, USGS fallback via basemapFallback + 8 s timer, buildings visibility, orbit actions, official layers
  I6 mounted: official-web's module existed); MapControls (orbit group + hint, Incident/California toggle, zoom via
  controller), MapNotices (fallback, photo detail), MapLegend (overview markers, photo date, 3D caveat), map.css.
  typecheck clean for map/lib; lint: 0 warnings in map/lib; map + fireBounds tests 82/82.

- 13:40 visual checks (8711/5181): overview 1440 z5.24 / phone; Eaton z11.58 3/3 runs (was AOI z10.69); ?view= kept
  5/5 with delayed lists / incident; delayed bundle (2 s) and rasters (3 s): 1 flight, same camera; mid-flight compass
  -> same as clean, zoom-in -> fit +1, drag -> user, 3D switch -> pitch 58 (fixed: padding re-issue only while our fit
  moves); reduced motion = same camera (settling re-fit within 2 s); hit-test (overview marker + label -> card + fly,
  own marker -> card, empty click -> close + select); fallback (?mapfail=imagery) -> dark + notice, USGS source gone;
  align.mjs 0 mismatches on 5 bundles; idle 0 renders/0 runs, playback 43 runs/5 s; selection/time/overlays kept
  across 2D/3D + 3 basemaps. CONTRACT 13 "map" written.
- 13:45 NEW (coordinator, decision 10): focus by zooming (focusIncidentFromMap), no camera move on map focus, other
  prepared fires' latest perimeters, "Spread not prepared yet" chip, markers at all zooms (lighter when focused).

- 14:30 decision 10 built: map/focus.ts (+12 tests: thresholds 8.5/7, central half, nearest, hysteresis, chips),
  map/nearbyPerimeters.ts (+6 tests: selection, replay time rule, cached loader), overviewLayers (chip, hidden-set
  filters, dim paint; +4 tests), framing setTarget keepCamera (+1), layers nearby outline (+casing), controller:
  debounced evaluation after the camera settles, focusIncidentFromMap (shell landed it with incidentSource 'zoom'),
  markers at all zooms (dim 0.55 while a fire is open, own marker and not-yet-started fires hidden in replays),
  chips only near the view centre (z>=9, max 2), legend rows. Browser: z8 outlines (2), z9.6 Eaton focused by zoom
  with the camera unchanged and time at latest observation, pan -> Palisades, z6.8 -> overview, Timber chip -> card,
  0 non-GET requests. Re-ran probe/interrupt/guarantees/hits/motion: unchanged results. CONTRACT 13 map updated.

- 15:40 resumed after the usage-limit pause. Coordinator correction: focus candidates = ALL prepared fires of the
  three lists (allFocusCandidates; test: 2026-season filter, Altadena z10 -> Eaton), outlines from all lists too;
  fixed: the focus evaluation no longer waits for the basemap style (it was dropped while the style loaded and never
  retried) and re-runs after each style load. Chips wrap to two lines (phone edge); toolbar z-index so the one-time
  hint shows above the updates panel; legend "Prepared fire perimeter" on the overview.
- Finals: 16 docs/screenshots/brief2-map-*.png (viewed). Gates: typecheck 0, lint 55 (scene baseline), vitest
  55 files / 669 tests, build ok, pytest 597 passed. Servers 8711/5181 stopped. Report written.

## Next
- Nothing (report delivered); integrator notes in docs/redesign/reports/brief2-map.json.

## Decisions
- Shell's CONTRACT 13 (landed): overviewFires(catalog, filter) / fireFlyTo / findFire in state/overview.ts;
  useWorkspace.fireCardId + setFireCard; basemap = effective; basemapFallback + setBasemapFallback (map only).
- (Superseded by decision 10) Markers now show at every zoom, dimmed while a fire is open; the replay anachronism
  is handled by hiding fires that started after the timeline time (markers and other fires' outlines) while a past
  fire is open; the open fire's own marker + label open its card.
- Focus candidates: all prepared fires of the three lists (coordinator correction); markers and chips follow the
  overview filter.
- Fire bounds use the rasters, so the opening fit waits for the raster set (timeout 6 s, then vector data).

## Open problems
- The USGS imagery has voids (e.g. a dark disc over Edwards AFB at z8): the provider's data, not a map layer.
