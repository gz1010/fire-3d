# brief2-integration progress (role: b2-integration; API 8716, Vite 5185)

Only agent editing the repo after the five brief-2 build agents. Prompt:
scratchpad v7/prompts/b2-integration.md. Report: docs/redesign/reports/brief2-integration.json.

## Done
- 2026-10-18: read BRIEF-2, PLAN-2, the five brief2-*.json reports and progress files, CONTRACT §13.
- Checklist audit of the leftover cross-agent items against the code:
  - returnToIncident -> frameFire: done by shell (state/workspace.ts); CONTRACT §13 map text still says AOI (fix).
  - MapFlyTo.source 'official': type exists; NOT passed by fitOfficialBounds / LayersPanel zone fit, NOT read by map.
  - OfficialNow California variant in the overview panel: mounted by shell (OverviewPanel .ov-official).
  - Widths: --m-card-w 360, --m-chip-w 380 already; coverage to re-measure.
  - Duplicate ImageryPanel: still in LayersPanel; both copies share radio name "xs-imagery" (real cross-talk bug).
  - "Hindcast" in Public: forecastDescription title; Public-visible "hindcast(s)" in LayersPanel, views tip,
    AnalysisDrawer tip; chart legends show run ids.
  - API client year=2026 / year=2025, three lists kept: done (state/store.ts fetchList).
  - .gitignore !backend/fire3d/data/: done (gazetteer not ignored; data/incidents ignored).
  - Lint baseline: 55 warnings, all src/scene; typecheck 0.

- 14:12 Official fits no longer change the open fire: fitOfficialBounds (and LayersPanel's zone fit) pass
  MapFlyTo.source 'official'; map/focus.ts FocusHold + focusUnlessHeld (tests with real Henderson / Norte / Orange
  County zone boxes); MapController holds the focus from that flight until the user's next gesture / zoom button,
  another explicit flight or framing, or an incident change (and cancels a focus change pending in the store).
  official/select.test.ts added. Browser: Eaton replay "Show area" on the archived RFW -> Eaton stays open.
- 14:15 ImageryPanel: one radio group per list (useId; both copies shared name "xs-imagery"). Layers drawer on wide
  screens shows ImageryLayerSummary (image shown, not live, opacity, credit, pointer to the chip's "More images");
  phones keep the full list in the drawer (the chip is hidden while a sheet is open).
- 14:16 Public wording: forecastDescription(f, mode, { plain }) ("Model re-run on past weather"); LayersPanel notes,
  view-switch and Analysis-drawer tips use plain words; Analysis drawer charts in Public: "Model forecast" / "Model
  re-run" without run ids (Command and Forensic keep "Forecast <run id>", P50, P10-P90); replay stop description.
  Forensic switch relabelled "Prepare analysis when I pick an unprepared fire" (was "Auto-build unbuilt incidents").
- 14:25 Coordinator's clarity note (NWS outlines dominated the Eaton replay on aerial): unselected outlines 1.4 / 1.2 px
  dashed / dotted, opacity 0.85 -> 0.4 by zoom, light 3 px casing (0.5), sparser labels; a selected NWS alert is drawn
  in its own colour (1.8 px solid, faint 7 % fill) BELOW the fire layers (white outline kept for evacuation zones only,
  on top). Legend entry and credit unchanged. Checked at z11.6, z8.9 and selected (z8.2): fire layers dominate.
- Gates after these: tsc 0; lint 55 (scene); vitest 56 files / 677+ tests.
- Browser so far (API 8716, Vite 5185): history flow (flow.mjs) OK, 0 builds; opening probe Eaton z11.58 3/3, ?view=
  kept z13.50 3/3 with delayed lists/incident, delayed bundle+rasters 2/2 same camera; interrupt.mjs as the map agent.

- 14:35 Decision 10 with real gestures (b2i/js/zoom.mjs, flicker.mjs): wheel into Eaton (2026 filter on), Henderson,
  Cooley -> focused by zoom, camera unchanged, no history step, spread drawn (28,307 / 7,076 / 2,680 px), time at the
  latest observation; drag Eaton -> Palisades switches; z6.6 -> overview (camera unchanged); Timber chip -> card, 0
  non-GET. Per-frame sampling: 0 stale frames in header / updates / timeline / card; new fire shown after 1-2 frames.
  FIX: neighbouring areas overlap, so dragging Henderson -> Norte never switched: focusTarget now switches when the
  view centre is inside another candidate's area and outside the open fire's (map/focus.ts + 2 tests).
  FIX: MapLibre starts a wheel zoom without originalEvent, so the official hold also ends on a user moveend.
  Note: MapLibre ends a drag released over a panel on the next mouse move (scripts move after releasing).
- 14:45 Official now / feed (official.mjs): Henderson order 14 mi + Cal OES caveat + listing time, CAL FIRE 3,160 ac
  65 %, NWS none + not an all-clear; "Show" keeps Henderson open; Cooley quiet; Norte CAL FIRE change row, time =
  NOW marker, order listed (not past date); Eaton replay archived RFW + Fire Weather Watch, 15 outline features,
  legend + credit; filters Official 3 / All 43 / Key 12; phone badges Henderson 1 (order), Eaton 2 (fire weather).
- 14:50 Search + card (loc/flows.mjs, card.mjs, search2.mjs): burned home 4 blocks, Public dated sentence, Command
  0% + run line; Henderson stale + Model / Official / Terrain data tags; outside modeled area "Unknown, not low";
  overview nearest fires + "Zoom to the Eaton Fire"; ZIP 91001; Altadena; Malibu lists Bryson as not prepared (no
  build); Escape / edit / map click cancel a slow lookup; exact name "Eaton Fire" opens (push, framed z11.58), Back
  -> overview; 504 in plain words. Official line states: listed / none listed / not checked (Arizona point) / past
  date / unavailable (request fails). Strip: full (Command), compact (Public), one 32 px line on phones.
  FIX: phone card dropped the zone issuer + time and "not an all-clear" (location/official.ts subCompact + tests).
- 15:00 Opening (opening.mjs): Public aerial overview (85 markers, 7 active, radius by acres), Command dark, filters
  Active 7 / 2026 season 85 / 2025 78, marker click -> card + flight, unbuilt card "Prepare analysis (1-3 min)" (not
  pressed), phone peek "7 active fires · CAL FIRE, updated 11:18".
- 15:05 Clarity: coverage Public 1440 = 75.7-77.5 % on all 10 bundles; contrast min Public 6.63 / 6.80 / 6.30, Command
  7.04 / 7.11 / 6.73, overview 7.20 / 7.13 / 6.54, card 7.20 / 7.01 / 6.36 (dark / aerial / roads).
- 15:10 Map detail (mapdetail.mjs): 3D buildings in 3D (26 rendered), photo-date line, orbit group, Shift+arrows,
  chip 380 px with platform + time, caption "not live", ?mapfail=imagery -> dark + "Try aerial again".
  FIX: Layers drawer imagery entry used the mono meta style; now proportional (ImageryLayerSummary).
- 15:15 Guarantees: align.mjs 0 mismatched px + 0 edge mismatches (observed + forecast) on Eaton, Palisades, Madre,
  Cooley, fixture-live; idle 0 renders; switches keep selection / time / pixels; playback 44 runs / 5 s; reduced
  motion same camera (4 vs 81 move events); keyboard (keys2.mjs, keys.mjs); Forensic (forensic.mjs) all OK.
- Backend pytest 601 passed. Secret scan 906 files, 0 contain the key. API log: 0 non-GET requests.

- 15:20 FIX: official / extras layer groups sat ABOVE the fire layers after every basemap load (MapLibre fires
  'styledata', where the group re-added itself below the labels, before 'style.load', where map-core re-adds its fire
  layers underneath). extras/mapLayers.ts now moves existing layers back on the forced style.load sync (+ test that
  replays the event order). Verified on Eaton (NWS) and Henderson (evacuation zones) on dark / roads / aerial.
- 15:25 NWS outline labels moved below the fire layers (they crossed the fire); phone card NWS line keeps sender,
  "archived copy" and "Read it"; timeline freshness line wraps in reading order on phones (.ctl-latest).
- 15:30 Final screenshots: 30 docs/screenshots/brief2-final-*.png (1440x900, 390x844 @2x, 1920x1080), 0 page errors,
  0 non-GET; 15 retaken after the last fixes; all viewed.
- 15:40 Gates (final): tsc 0; lint 55 warnings, 0 outside src/scene; vitest 56 files / 680 tests; build OK (main
  438 kB, no three.js); pytest 601 passed; key scan 959 files, 0 hits. Coverage re-measured 75.7-77.5 %.
- Two bundles appeared during the run from the user's preview (API 8710), not from me (0 POST on 8716):
  2025-salt-fire-5da4a9 (14:41) and 2026-bryson-fire-f96f24 (14:44-14:46).
- Servers 8716 / 5185 stopped. Report: docs/redesign/reports/brief2-integration.json.

## Next
- Nothing for this role; the final-verification agent takes over (README, live loop, final review).

## Decisions
- Official fits hold the zoom focus until the user's next move (not a time limit): the user asked to see an area.
- Imagery: one list per screen (chip popover on wide screens, the drawer on phones).
- Timeline status stays 11 px (shell's token roles; 12 px would eat into the 75 % margin); noted for the final agent.

## Open problems
- See the report's known_issues (thin 75 % margin, no live NWS alert to test on screen, drag-release quirk of MapLibre,
  external bundles built during the run).
