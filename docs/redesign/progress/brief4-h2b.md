# Brief 4 H2b (Command in a fire): progress

Ports: API 8732, Vite 5192 (a Vite on 5192 -> 8732 was already running from H2a; reused, stop at the end).

## Plan (files)
- location/describe.ts: NearHere gains edge / basis / staleFor (structured parts for the readout sentence + tags).
- location/LocationCard.tsx: useLocationCheck() hook + exported blocks (Public card unchanged).
- location/CommandReadout.tsx (new): SELECTED POINT header (copy/centre/clear), 30 px point, DMS·UTM·WGS84,
  near sentence + tags, MODEL line, official at point (compact), rows (BURNED, CONTAINED, REPORTED LOCATION ·
  issuer, INCIDENT ID copy, RECORD UPDATED · issuer), "More about this spot" (cardPrefs). Phones: bottom sheet + peek.
- location/CommandSearch.tsx (new) + searchUi.ts searchOpen: "Check an address" IconPill + 400 px popover;
  fireActions.focusSearch opens it first (one small edit, noted for the orchestrator).
- ui/feed/OfficialNow.tsx: Row variant 'command' (collapsible: dot + label — verdict + meta; alerts start open).
- ui/shell/UpdatesPanel.tsx: Command column (no panel) + "View all updates" expanded glass panel.
- ui/timeline/CompactTimeline.tsx: variant 'slim' (full width, no card, same parts).
- map/MapLegend.tsx: variant 'chips' (+ scale + "Legend details" popover); MapAttribution styling.
- extras/ImageryChip.tsx: variant 'status' for the bar.
- ui/shell/CommandFireChrome.tsx + styles/view-command.css: the layout.

## Done
- Read BRIEF-4, PLAN-4 (all), CONTRACT §15, HANDOFF, CommandView screen + render + before shot; all source files.

## Next
- describe.ts fields, LocationCard hook, CommandReadout.

## Checkpoint 1 (committed)
- describe.ts NearHere edge/basis/staleFor; useLocationCheck.ts (shared by the Public card and the readout);
  readoutText.ts (coordinate line, near sentence, selection label) + tests.
- CommandReadout, CommandSearch (+ searchUi.searchOpen, fireActions.focusSearch opens it), OfficialNow command rows,
  UpdatesPanel column + "View all updates" panel, CompactTimeline slim, MapLegend chips, ImageryChip status,
  CommandFireChrome + view-command.css. Gates green (lint 55).
- Next: map leader labels (DOM), MapControls variant="bar" once H2c lands it, phones 390x844, 1024x768, contrast,
  screenshots, CONTRACT, report.
