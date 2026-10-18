# ui-integration progress log

Role: ui-integration (API 8717, Vite 5186). Only agent editing web/; may also edit backend/fire3d/api/geocode.py,
backend/fire3d/api/extras.py and their tests (unchanged this round). From 22:40 backend-followups (API 8711) owns
backend/** except those, SPEC.md, docs/validation.md and data/**; readme owns README.md.

## Done
- 22:15 started (no earlier log). Read the prompt, BRIEF, CONTRACT (incl. §12), all progress logs and reports.
  Baseline: tsc 0, lint 55 (src/scene), vitest 26 files / 393. No user hand edits found (mtimes match agent logs).
- 22:20 optional sources mounted: extras/runtime.ts (shared store + legend / credits / feed / status helpers, dev
  handle window.__extrasRuntime), extras/ExtrasSync.tsx (hooks run once; query time held while playing; choices reset
  per incident), map/extrasLayers.ts (imagery < zones < fire layers; icons below map-core's top layers) mounted by
  MapController; clicks skip camera icons, zone clicks set zoneId; hover text for cameras / zones; event hover names
  the real kind. Panels under their toggles in the Layers drawer (a camera picked on the map opens it there). Legend
  compact entries + honest status lines; extras credits (https only); UpdatesFeed extraItems; zones at the point in
  the location card.
- 22:28 cross-owner requests: WeatherCard FFWI value + Fosberg explanation (no categories / tint); aircraft tooltips
  name adsb.fi; forecast popover lists forecast.warnings. Dead 'search' PanelKey and MAP_LAYER_KEYS removed.
- 22:40 in-app alignment (checks/align.mjs): Eaton, Madre, Palisades, Cooley, fixture-live: 0 mismatches over ~1.05 M
  overlay px each (observed + forecast), 0 edge-band mismatches, 0 px outside the AOI. Perimeter co-registration
  (checks/vectors.mjs): drawn vertices = bundle rings (0 m); Dice 0.999 at 0 shift vs 0.98 (+-1 px), 0.95 (+-3 px).
- 22:51 paused by the user; resumed, servers restarted.
- 23:45 MapLibre crash fixed ("reading 'shaderPreludeCode'" when the camera moved during a basemap swap with terrain):
  terrain dropped before setStyle, re-enabled on style.load. Frame rate with the browser cap lifted (probe/fps.mjs):
  2D 540 fps (0.9 ms/frame), 3D dark 146, 3D aerial 213, playback 80 map frames/s, idle 0 renders.
- 23:50 licence fix: lib/dataCredits.ts, ui/DataCredits.tsx, styles/credits.css: Open-Meteo credit (map credits,
  chart footers, Forensic weather card), "Data sources" note with the FIRMS acknowledgement (Analysis drawer,
  Forensic Evidence tab).
- 00:15 §12 scenario (checks/scenario.mjs) passed on Eaton, Madre, Palisades, Cooley (0 page errors).
- 00:20 backend-followups requests: TimeRange fields + docs, timeline comment / tooltip, data status quiet-pass row,
  warnings checked in the popover; modeledArea "runs agree" wording. Real Cal OES order near Henderson verified.
- 00:30 coverage: scale bar moved to its own map slot (credits keep one line): all 10 bundles 75.1-76.6 % at 1440.
  Phone, keyboard, reduced-motion checks pass.
- 00:50 review of finals: detection footprints quieter (squares from z13, lighter); scale anchored to the safe-area
  corner and kept left of an open Layers drawer. Finals retaken (20), provider failures + incident search re-checked.
- 01:00 final checks: tsc 0, lint 55 (src/scene), vitest 28 files / 412, build ok; pytest geocode + extras 68.
  Report written: docs/redesign/reports/ui-integration.json. Servers stopped.

## Next
- Nothing left in this role.

## Decisions
- Optional-source panels live in the Layers drawer under their toggles (CONTRACT §12.3); a camera icon opens that
  drawer at the camera. The compact legend shows an optional layer only when it draws something; every status (past
  dates, outage, none listed: never an all-clear) is in the legend details, the Layers panel and the card.
- The updates panel is not folded when a point is selected (shell's decision kept): with a point selected the map is
  67 % (Public) / 55 % (Command) unobstructed at 1440x900; the 75 % target is met for the default view.
- Detection footprints: the true-size squares stay (honest sensor pixels) but start at z13 and are lighter.

## Open problems
- See the report's known_issues.
