# timeline-feed agent progress log

Role: timeline-feed (API 8715, Vite 5184). Owns web/src/ui/timeline/**, web/src/ui/feed/**, web/src/lib/plainLanguage.ts
(+ tests), web/src/ui/KeyEvents.tsx, web/src/ui/eventMeta.ts.

## Done
- 16:05 EDT (20:05 UTC) started from the foundation skeletons (no earlier attempt). Read BRIEF, CONTRACT, SPEC
  (events, time range, weather), references, module reports, store/runtime/Timeline/KeyEvents/annotations.

- 16:29 lib/plainLanguage.ts (+16 tests), ui/timeline/model.ts (+17 tests: live, stale, missing forecast, partial
  horizon, replay, scale, label spreading), ui/feed/types.ts + feedModel.ts (+15 tests: order, kinds, automated,
  plain wording, locations, perimeters/passes/forecast, selectFeedItem), eventMeta.ts (plain + hex), feedMeta.ts,
  UpdatesFeed.tsx + updatesFeed.css written (not yet checked in the browser).

- 16:45 CompactTimeline.tsx + compactTimeline.css, UpdatesFeed polish, KeyEvents (Forensic) now uses the shared feed
  model (kind + automated in tooltips, selectFeedItem). Real-data smoke run over every ready bundle (11 bundles: feed
  sorted, 0 bad items; stops/stale/zones sane). Browser checks on 8715/5184 (map-core map partly landed): event click
  flies 2D (138 m from event after 3 s), 3D (0 m, pitch kept), Forensic camera (0 m); time = event time, selected,
  details open; keyboard (arrows/PgUp/PgDn/Home/End/Enter on stops), reduced motion, popover, live New badge,
  notes add/delete, Check this location -> selection source 'event'. Narrow 390x844 OK.

- 18:35 resumed after the user's pause (16:51-18:25). Kept all earlier work. Added: `FeedInput.extra` +
  `UpdatesFeed extraItems` prop (optional-sources FeedItems: evacuation / cameras / imagery; repeats + invalid times
  dropped), live current-status items (not seekable) never dimmed as "later", first batch of separately loaded
  sources not marked "New" (extendFeedBaseline), roving focus in the feed (one Tab stop; arrows/Home/End; fixes
  shell's "one tab stop per item" open problem), filter tooltips name what the feed holds; Forensic note time floors
  to the minute. Feed tests 22 (was 15).

- 18:48 stop labels: full labels while each still covers its tick, else short ones (was a fixed width < 420 px
  rule that shortened "Forecast start" at 1440 px when the legend was wide); live forecast item titled "Spread
  forecast issued (72 h)" (no clash with the "New" badge). Checks on 8715/5184 with the real map: event click 2D
  0 m / 3D 0 m (pitch 58 kept) / Forensic 0 m, time + selection + details; keyboard; roving focus (1 tab stop, arrows,
  Home/End, Enter, Tab leaves, Shift+Tab returns); live +24h / popover / NOW / New / notes / Check this location.
  npm test 387/387 (25 files), typecheck 0, lint 55 baseline (0 mine), build ok.

- 18:55 optional sources checked in the running app: a second <UpdatesFeed extraItems> root (same store) with real
  /api/extras answers for Cooley (41 cameras -> 1 summary item, 3 Sentinel-2 scenes, 0 evacuation zones): kinds,
  sources, "Automated", no "New" on the first batch, camera item not dimmed, click keeps the time and says why.
  Observation meaning text generalised (cameras, images). Popover "Map shows" row (valid time vs the period).
  Playback (play/pause button, Space on the track: 2.7 h in 2.5 s), basemap -> aerial keeps time + selection.

- 19:05 user-facing strings switched to US spelling (plainLanguage.ts, UpdatesFeed.tsx, feedModel.ts); CONTRACT
  as-built notes (§7, §8, plain language) updated; scratchpad final-all.sh written. Paused by the user 19:05.

- 21:45 resumed (v5). Kept everything. After the spelling change: tsc -b 0, npm test 392/392 (26 files; mine 55:
  plainLanguage 16, timeline 17, feed 22), lint 55 baseline warnings (0 mine), vite build ok. Servers 8715/5184
  started; final-all.sh v5 running (map-core finished, shell in its last screenshots).

- 21:57 v5 run all green; review found two fixes: (1) Public replay time column was one line ("Jun 20, 13:13",
  ~90 px) so kind + Automated chips wrapped in the expanded panel -> stacked time over date like Command;
  (2) Camino's ignition (CAL FIRE's reported start, unconfirmed by satellites) showed as Fire-3d "Estimate" +
  "Automated" -> "Fire start reported", kind official, not automated (+1 test; CONTRACT §8 note). final-all.sh v6:
  6/6 steps exit 0, 0 page errors; event click 2D 0 m / 3D 0 m (pitch 58) / Forensic 1 m; screenshots copied.
  Final: tsc 0, npm test 393/393 (26 files; mine 56), lint 55 baseline (0 mine), vite build ok. Servers stopped.

## Next
- Done. Report at docs/redesign/reports/timeline-feed.json.

## Decisions
- FFWI: no categories. NOAA SPC's old "FFWI >= 50 generally appears significant on a national scale" note is a rule of
  thumb (page now 404), not a category scale -> value "42 of 100" + explanation only.
- Stale = latest observation > 6 h older than the wall clock (CONTRACT value), documented as a "check the time" flag;
  while stale the NOW stop reads "Latest data" (never call old data "now"); current time shown separately.
- Track scale is piecewise linear (record / forecast / after) with minimum shares so +24/+48/+72 stay readable.
- Live without forecast: the next 72 h are drawn as a disabled zone; replay without hindcast: forecast stops disabled
  in a group, no invented positions.
- Feed: newest first; live shows everything ("New" for arrivals), replay shows what had happened by the replay time
  with a "later updates" toggle. Filter All / Key events (key = events.json + annotations, as in CONTRACT).
- Satellite passes = VIIRS/MODIS/Landsat detections grouped per satellite (< 30 min apart); GOES skipped (continuous).
- Kinds: perimeter_update -> observation (agency-mapped, automated=false), containment -> official (automated=false),
  peak_wind -> model, other events by confidence; annotations -> annotation. Ignition with source "CAL FIRE" only
  and no "Ignition estimated" (backend ignition_time kept CAL FIRE's start) -> official, automated=false.

## Open problems
- Forensic ui/WeatherCard.tsx (not mine) labels FFWI low/moderate/high/extreme at 25/50/75 without a source; the
  integrator should switch it to fireWeatherSeverity() (value + explanation) or cite a source.
