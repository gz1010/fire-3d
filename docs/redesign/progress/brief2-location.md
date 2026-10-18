# brief2-location progress log

Role: b2-location (API 8713, Vite 5183). Owns web/src/location/**, web/src/lib/geodesy.ts, web/src/lib/plainLanguage.ts
(+ tests), backend/fire3d/api/geocode.py, backend/tests/test_geocode.py, backend/fire3d/data/gazetteer_ca.json,
backend/scripts/build_gazetteer.py.

## Done
- 12:05 read BRIEF-2, PLAN-2, audit-2 (civilian-flow fully, opening-map R9, updates-official), CONTRACT, sibling prompts.
- 12:15 C-R5 backend: scripts/build_gazetteer.py (2026 Census Gazetteer: CA places 462 cities / 21 towns / 1,139 CDPs,
  1,802 CA ZCTAs; pipe or tab files; UTF-8 / Latin-1) -> fire3d/data/gazetteer_ca.json (131 KB, 46 KB gz).
  geocode.py: ZIP and town queries matched locally (no upstream), kinds address/place/zip, exact, near; 503 without
  the index. test_geocode.py 60 pass.
- 12:27 search.ts rewrite (planner, exact-name incident rule, decide(), state machine with sequence numbers,
  areaBounds/labels), geocodeClient plainSearchError, incidents.ts (pool, nearest fires), searchUi.ts (card yields to
  the popover), SearchBox.tsx rewrite.
- 12:40 card: locationCheck dryness / edgeRise / latestObservationMs; describe.ts four-block summary (near, model
  sentence / Command figure + run, up to 3 tagged reasons, reliability + stale); official.ts (I5 wording);
  LocationCard / CardParts / OverviewCard; CoordinateStrip variants (useCoordsVariant: full / compact / line);
  location.css rewrite (13 / 12 / 11 px minimums, text-2 for information).
- 13:10 app checks on 8713 / 5183 (flows.mjs in scratchpad v7/loc): burned home desktop / phone / Command, Henderson
  stale, outside the modeled area, overview search, ZIP 91001, Paradise, Malibu (town, no build, Bryson listed "Data
  not prepared"), phone with Layers open (sheet closes, pick blurs), Escape / edit / map click during a slow lookup
  (no late selection), 504 error (plain words, card pushed down).
- 13:20 decision 10 (zoom focus): incident changes no longer close the search or cancel lookups; the card shows a
  loading line while a focused fire loads; the official hook stays mounted across focus changes; fires open with
  source 'search' (openFromSearch.ts); overview button "Zoom to <fire>". CONTRACT 13 "location" sub-section written.
- 14:20 Public details plain (no "hindcast", no scientific values; Command keeps them); phone card shows the fire
  position's age; 20 final screenshots docs/screenshots/brief2-location-*.png (all viewed). Gates: typecheck 0, lint 56
  (55 scene baseline + 1 App.tsx, 0 location), vitest 660/660 (location 144), build ok, pytest 597. Servers stopped.
  Report: docs/redesign/reports/brief2-location.json.

## Next
- Done. Follow-ups are in the report (gitignore line, official-web minute quantisation, card width suggestion,
  README rows).

## Decisions
- Exact incident name = full name, id, or name + its year. A bare name ("Eaton") opens the fire only when the local
  lookup finds no exact town of that name. Unprepared fires: listed "Data not prepared"; picking opens the shell's
  fire card (setFireCard + fireFlyTo), whose "Prepare analysis" is the only build path (shell's rule).
- Town / ZIP pick: clears the old selection, flies to a box sized by land area, prompts for an address or map click.
- Popover never covers the card: card pushed down (desktop) / sheet capped or hidden (phones) via searchUi store.
- Card: coordinates are not repeated in the card (the strip always shows them); the drag hint lives on the map pin.
  Model sentence leads block 3; kind tags lead their lines (fewer wrapped lines).
- Card height: at 300 px the most verbose case (burned home + archived Red Flag Warning + "model missed") is ~800 px
  and scrolls in its slot; Henderson ~670 px. At 360 px it would be 712 / 638 px.

## Open problems
- Root .gitignore `data/` also ignores backend/fire3d/data/: integrator must add `!backend/fire3d/data/` after it
  (verified in a scratch repo).
- official-web hooks.ts useOfficialContext floors the timeline time to the minute: a zoom-focused live fire whose
  latest observation is not on a whole minute reads as "past date" (evacuation status hidden). Exact fix in the report.
