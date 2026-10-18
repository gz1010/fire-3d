# brief2-official-web progress (role: official-web; API 8715, Vite 5184)

Owns `web/src/ui/feed/**`, new `web/src/official/**`, `web/src/extras/**`, `web/src/ui/KeyEvents.tsx`,
`web/src/ui/eventMeta.ts`, `web/src/ui/timeline/**`.

## Done (2026-10-18)
- Read the prompt, BRIEF-2, PLAN-2, audit-2 (updates-official fully; civilian-flow G13-G15/R7; opening-map R15),
  CONTRACT, BRIEF and the code and consumers.
- `official/` module: types, client, query, geo, fire, url, guard, calfire, fireWeather, model, context, hooks (I5),
  runtime (+ `useOfficialSync` in ExtrasSync), select, style, mapLayer (I6); fixtures from the real API.
- Components: `ui/feed/OfficialNow.tsx` (compact rows + "More"; California variant on the overview) and
  `extras/ImageryChip.tsx` (priority truncation; compact caption portaled and placed by measurement).
- U-R1 (honest evacuation times, issuer, distance, "Cal OES does not say which fire", bbox-aware zonesAtPoint, camera
  summary time), U-R2 (FeedItem fields + details), U-R3, U-R5 (fit + highlight, seek rules), U-R6 web (CAL FIRE change
  and final-record rows; a real change, Norte 25 → 50 %, verified), U-R7 web (NWS rows, segments, 48 h expired,
  archived label, outlines, legend entry, credit), U-R8, U-R10 (filters, day groups, time zone), O-R15 (chip, caption,
  newest-first list, compact legend), C-R8 (plain words, no run ids, Note in Command only), U-R11 (P2) glyphs.
- Decision 10 (fire changes on zoom): shared per-URL query cache, abort of unused requests, `forIncident` guards,
  `officialTimeReady` wait, statewide NWS on the overview (U-R12 outlines).
- Backend notes (phases, CAN/UPG, per-segment text, `seen_ms` only as "checked", agencies string, last-record answers).
- Location's bug fixed: minute-quantised timeline vs an unquantised NOW marker (`officialPast`, test with hh:mm:41;
  verified on Norte by link and by zoom focus).
- CONTRACT §13 "official-web" written and kept as built. 14 final screenshots in docs/screenshots.
- Gates: typecheck 0; lint 55 (baseline, all src/scene); web tests 671/671 (55 files); build OK; backend 597 passed.

## Next
- Report written (docs/redesign/reports/brief2-official-web.json); servers stopped.

## Decisions
- Plain-language helpers in `lib/plainLanguage.ts` belong to location: wording overrides for Public live in my files.
- Shell shows a compact official summary in desktop Public and my full OfficialNow when expanded / Command / phones.
- Point checks: Cal OES point query outside the fire's area; NWS statewide answer outside it (current time only).
- Overview OfficialNow: "Official now · California" (statewide NWS) + pointer to zoom in on a fire.
- Forensic Key Events: automated shown as a corner dot on the kind glyph (titles stay readable in the narrow dock).

## Open problems
- Chip slot is 300 px (shell token `--m-chip-w`): the platform and clock time give way first; ~380 px shows them.
- Decision 10 zoom focus also reacts to fits from official rows (Henderson's Orange County zone focuses Norte).
- No live Red Flag Warning in California during the build: live outlines checked with the recorded CAP sample (tests)
  and on screen with Eaton's archived warning.
