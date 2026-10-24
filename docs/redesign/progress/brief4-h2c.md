# Brief 4 H2c: rotation, globe-like dimming, basemap tint (progress)

Ports: API 8740, Vite 5200.

## Done
- Read BRIEF-4, PLAN-4 (all), CONTRACT 15, HANDOFF, screens (Main controls bar, gradients of Main/Fire/Command).

## Decisions so far
- The atmosphere element is placed inside the MapLibre canvas container right after the canvas (imperatively, by
  MapAtmosphere), so the map's DOM overlays (selection pin, hover popups, MapNotices) stay above the dimming. The
  App.tsx mount stays where H2a put it.
- Tint: default by view (MapAtmosphere edges: overview -> 'overview', fire/command -> 'fire'); useMapTint(level) lets a
  chrome override it.

## Done (code, typecheck + tests green, not committed yet)
- lib/compass.ts (+test), lib/rotateGesture.ts (+test), state/rotation.ts (+test), ui/useCompassDrag.ts
- mapStore: setBearing, setTint, tint, tintRequest; mapController: turnTo (jumpTo in ours; Safari twist as gesture
  with originalEvent), rotateBy with goal, northUp, applyTint, 2D keeps heading, registerRotation, gesture binding
- MapControls: variants bar / compact (+ anchor, layers), compass drag in all, new hint text + key, dev ?ctl=
- map/atmosphere.ts (+test), MapAtmosphere.tsx (element moved into the map above the canvas), useMapTint.ts,
  styles/atmosphere.css
- basemapStyle tint (AERIAL_TINT, aerialTintPaint) + tests; userInput.test rotation block; runtime hotkeys Q/E/N
- handoff.ts: heading both ways

- Browser checks (scratch scripts in the session scratchpad): rotation 33/34 (the miss = Command's search box moved
  into a popover by H2b), hand-off + tint 5/5. Screenshots docs/screenshots/brief4-h2c-*.png (8), all viewed.
- CONTRACT 15.5 H2c paragraph, reports/brief4-h2c.json, gates green (lint 55, all src/scene).

## Next
- commit + push; stop servers 8740 / 5200.
