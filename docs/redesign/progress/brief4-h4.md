# Brief 4 H4 progress (Public fire view)

Ports: API 8733, Vite 5193. Builder started 2026-10-24.

## Plan (order)
1. Read BRIEF-4, PLAN-4 (§3.4, §6 a/i, §11), CONTRACT 15 (H2 + H3 as built), HANDOFF, FireView screen + render.
2. Map profile for Public in a fire (decision a): newest perimeter only, reported point restyled, official layers kept,
   other fires dimmed; hidden: forecast, observed raster, detections, AOI, events. Time = latest observation on entry.
3. ui/public: FireTitle, DistanceChip, HazardCircle (+ leader to the reported point), FireFacts, the map key.
4. PublicFireChrome rebuilt (X, title, top-right cluster [view pill · search · layers], compact controls, key, bar).
5. Unprepared / building / no-perimeter states; NotPreparedNotice hidden in Public (CSS, App.tsx is frozen).
6. Location card in Public fire: model block -> "The experimental spread model for this spot is in Command ›";
   Layers drawer hides model toggles with that note.
7. Phones (decision h).
8. Screenshots, gates, CONTRACT 15.5 H4 paragraph, report, commit, push.

## Log
- Built: map/fireProfile.ts (+ tests: profile, hidden layers, newest perimeter, stale rule, ring polygons), the
  controller's Public-fire profile (newest perimeter filled via SRC/LYR perimeterArea, no observed / forecast /
  detections / events / AOI / map ring + label), MapNotices and MapLegend follow the profile (legend variant "key").
- ui/public: fireView.ts (pure, tested: title dates, status words, name fit, distance, key, facts, sources),
  HazardCircle, FireTitle, DistanceChip, ReportedPoint (point + leader over the map), FireFacts (+ MapDataState),
  FireKey, FireMenu, usePublicFireTime (+ test). PublicFireChrome rebuilt; CommandSearch gains variant "pill";
  LocationCard drops the model block in Public (ModelInCommand); LayersPanel hides model toggles in the fire view.
- Screens checked (scratch): Lower Sugarloaf 1440x1000, fixture-live, Willow (unprepared, prepare button in view),
  phone 390x844.
- Review pass on my own screens: imagery status moved under the cluster (it ran into the title), cluster + key grouped
  bottom right (key above the controls for its legend details), prepare block kept in view (smaller circle while it
  shows), sticky facts foot on short windows, phone bar title room, two-line status in the 120 px circle, phone sheet
  key wraps and the cluster gives way to an open sheet, leader recomputed for the search pill, card and chrome.
- Contrast (decision l): "MORE IN COMMAND" was 3.95-4.18:1 over the active glow; taller centre shade + tight text edge:
  min 5.51:1 over every fire-view text run (Lower Sugarloaf +/- chip, Eaton, Greer, Willow, fixture-live).
- Browser checks 39/39 (scratch h4-checks.mjs). Command in a fire re-shot: unchanged vs brief4-h2.
- Final: screenshots docs/screenshots/brief4-h4-*.png (viewed), CONTRACT 15.5 "H4" paragraph, reports/brief4-h4.json.
