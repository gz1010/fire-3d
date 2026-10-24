# Brief 4 H2 integration (step h2): progress

Ports: API 8732, Vite 5192.

## Start (2026-10-24)
- Tree clean at e56725b (H2a, H2b, H2c all committed and pushed; nothing left uncommitted).
- Read BRIEF-4, PLAN-4 (all), CONTRACT 15, HANDOFF, the three H2 progress notes.

## Plan
1. Seams: Command already passes MapControls variant="bar"; MapAtmosphere edges come from views.ts per chrome and
   set the view's tint (no chrome needs useMapTint). Check them in the browser.
2. Notes for others: ReadoutRow vs Forensic chart readout class clash (.ro-row / .ro-label, both directions);
   selected-point label flips left when it would leave the free map area; selection chip vs the right column
   (safe area); incident label "REPORTED" in Command (optional).
3. Gates, screenshots (brief4-h2-*.png), FIRMS count-only scan, CONTRACT 15.5 "H2 as built", report, commit, push.

## Done
- Baseline gates green at e56725b (lint 55, 1271 passed / 2 skipped).
- Seams checked in the browser: Command passes MapControls variant="bar" anchor="bottom"; MapAtmosphere data-edges
  per chrome (overview / fire / command) and the tint per view (overview / fire / fire) - no chrome needs useMapTint.
- Selected-point label: new map/pinLabel.ts (pure, tested) picks the corner (up-right first) that stays inside the
  safe area and off the fire's point / label and the key events; markers.ts SelectionPin.place, map.css mirrored leader;
  controller calls it on moveend, idle, safe-area change and pin update.
- Command reported label "REPORTED" (layers.ts incidentLabelField(preset); controller updates it on preset switch).
- .ro-row / .ro-label clash: Forensic chart cross-hair readout renamed to .xr-* (Charts.tsx, dock.css); the shared
  ReadoutRow keeps .ro-*. view-command.css comment updated.
- Scratch checks (session scratchpad): h2-rotate-check.mjs 38/38 (Public, Command, overview; edges + tint),
  h2b-keys.mjs 27/27, h2-handoff-check.mjs 5/5 (the H2c script's Forensic -> map step raced the live camera;
  fixed in the script by switching in the same tick).

## Next
- Full gates, screenshots, FIRMS scan, CONTRACT merge, report, commit, push.
