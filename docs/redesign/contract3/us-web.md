# us-web: as built (brief 3, wave 1)

Role `us-web` (web: lower-48 overview, fire-local time zones and the mixed clock, national search and coverage, fire
card records, per-region accuracy labels). This note records what was built against CONTRACT §14 and every deviation.
It is kept current at each milestone; the integration folds it into §14 as "as built" sub-headings.

## 14.9 Time zones and the mixed clock (M1)

### 14.9.2 `web/src/lib/time.ts`

Implemented exactly as §14.9.2 (names, signatures, exact strings):
`Clock`, `TimeFmt`, `timeFmt`, `viewerZone`, `isValidZone`, `zoneAbbr`, `zoneName`, `zoneLine`, `WallParts`,
`wallParts`, `zoneOffsetMinutes`, `startOfLocalDay`, `wallTimeToMs`, `localYear`, `localHourTicks`, `localDayTicks`,
`localWallTicks`, `fmtClock`, `fmtAt`, `fmtDayDate`, `fmtDayRange`. The zone-free helpers keep their names.

Details the contract left open:
- `timeFmt(tz, clock)` returns a frozen, shared instance per (zone, clock), so a `TimeFmt` is a stable React
  dependency. A null, empty or unknown zone falls back to `viewerZone()` (never Pacific).
- `fmtAt` and `fmtDayDate` default to `year: 'never'` (so a migrated `fmtDateTime` call keeps today's string);
  `'auto'` adds the year when the local year differs from `refMs`'s (default now); `'always'` always.
- `zoneAbbr` uses Intl `short` (en-US); a zone without an English abbreviation reads "UTC−3" / "UTC+5:30".
- `zoneName` uses Intl `longGeneric`: "Pacific Time", "Mountain Time", "Central Time", "Eastern Time"; Arizona
  (America/Phoenix) reads "Mountain Standard Time" (Intl's own name, correct: no daylight time); UTC zones read
  "Coordinated Universal Time".
- `zoneLine(tf, ms, whose)`: "Times: Mountain Time (MDT), the fire's local time" / "Times: Eastern Time (EST), local
  time at this place" / "Times: your device's time (CDT)".
- `wallTimeToMs(tz, y, mo, d, h, mi)`: candidates from the offsets a day either side plus the offset at each first
  guess (two passes, no fixed offsets); the earliest candidate whose wall clock matches wins (fall-back: the daylight
  instant); none matches inside a spring-forward gap, so it resolves forward (02:30 → 03:30 daylight time), as
  `laWallToMs` did.
- `localWallTicks` labels: 24-hour "06:00", 12-hour "6 AM" / "12 AM" / "12 PM"; the day label "Oct 22" in both.

### 14.9.3 Deprecated names

All 19 kept, marked `@deprecated`, each delegating to the new API with America/Los_Angeles and a 24-hour clock. An
equivalence run (old file from git vs new, Pacific ticks over 4 starts × 4 spans × 7 steps, every formatter every
7 h 13 min through 2025-2026, `laWallToMs` over March and November 2026) gave identical output.

`web/scripts/check-time-api.mjs` (+ `check-time-api.d.mts` for its unit test):
- `--role <label>` expands that role's `owns` (and `owns_bugfix_only`) globs from `plan3-roles.json` with the PLAN-3
  appendix B rules, over the code files under `web/` (`.ts .tsx .mts .mjs .js .jsx`; `node_modules`, `dist` skipped);
  explicit files or directories can be given too; `--quiet` prints only files with a count above 0.
- Parses each file with the TypeScript compiler: counts uses of deprecated names imported from `lib/time` (named,
  renamed, namespace `T.name` and `T.Type`), re-exports of them, never comments, strings or same-named properties.
  Skips `web/src/lib/time.ts`.
- Counts `America/Los_Angeles` in string, template and JSX-text literals of non-test files (`*.test.*`,
  `*.testutil.*` skipped); a line with `// tz-ok: <reason>` is listed with its reason and not counted.
- Prints both counts per file and the totals; exit 1 when either total is above 0 (2 on a usage error).
- Opt-out in use: the checker's own search string (`web/scripts/check-time-api.mjs`, "the checker's own search
  string").

### 14.9.4 `web/src/state/timeZone.ts`

As §14.9.4: `clockFor`, `useClock`, `useTimeFormat`, `useTimeFormatFor`, `useZoneSource`, `getTimeFormat`, plus:
- `usePlaceZone` (zustand: `placeZone`, `setPlaceZone(tz | null)`): the zone of the place the location card shows
  when no fire is open (from `/api/geo/lookup`). `useTimeFormat` uses the open fire's `summary.time_zone`, else this
  place zone, else the viewer's zone; `useZoneSource` reports which ('fire' | 'place' | 'viewer'). This is how the
  'place' value of §14.9.4 is fed.
- `getZoneSource()` (non-hook read), `zoneOf(summary)` (a summary's valid zone or null), `zoneSourceOf(fire, place)`.
- A summary whose `id` differs from the store's `incidentId` (stale during a switch) is ignored.

## 14.11 Overview map and list (M2)

- Frame: `map/framing.ts` `LOWER48_BOUNDS = [-124.85, 24.4, -66.89, 49.38]` (replaces `CALIFORNIA_BOUNDS`, removed)
  and `LOWER48_START` ([-98.6, 39.8] z3). The overview goal, the "All states" control and the safe-area refit use it.
  Measured fits: 1440x900 without chrome z4.1, with the panel and timeline safe area about z3.7 (the opening run in
  the browser settled at z3.58); 390x844 phone z2.1 (the whole lower 48, round 2 default).
- Wording: header "United States · all fires" (tooltip "Lower 48 states; Alaska and Hawaii are not supported yet"),
  "← All fires" tooltip "Back to the overview of all fires (lower 48 states)", control "All states" ("Show all of the
  lower 48 states"), panel and button "Fires in the lower 48", coordinate strip "United States overview",
  `index.html` meta "… for the lower 48 US states …", Command menu "Active (lower 48)" from `LiveStatus.detections_24h`
  and "Times" from `zoneLine`.
- Three sources (`map/overviewLayers.ts`, `OVERVIEW_SOURCES`): `fx-overview-pinned` (no clustering; active fires
  >= 5,000 ac + the fire whose card is open), `fx-overview-active` (`clusterRadius` 28, 44 when the map container is
  under 500 px wide at style load; `clusterMaxZoom` 6; `clusterMinPoints` 3), `fx-overview-other` (radius 40,
  `clusterMaxZoom` 7, min 3). `clusterProperties`: `max_acres` (max of `acres`) and `small` (count of small active
  fires). Group bubbles: radius by `ln(max_acres)` (8 px with no size to 15 px at 100,000 ac), the count as label
  (`point_count_abbreviated`, Noto Sans Bold). Small active fires (< 10 ac or no size) are 2.5 px-radius orange dots
  without the white ring. Single markers scale 0.6x at z3 to 1x at z7.
- 21 layers, bottom to top: other (group, casing, point, count), active (same), pinned (casing, past, live), the
  selection ring (pinned source only), three invisible hit layers, three label layers (other, active, pinned: the top
  one is placed first) and three chip layers. Every expression validates with `validateStyleMin` (tested).
- Labels: one `text-field` `step` on zoom against each feature's `lz` (`labelMinZoom`): pinned 0; active >= 300 ac or
  any >= 20,000 ac from z5; active >= 10 ac or any >= 1,000 ac from z7; the rest from z9 (and on hover).
  `symbol-sort-key` = acres plus 1e7 only for active fires of 300 ac or more.
- Hidden fires (the open fire; in a replay, fires not started by the timeline time) are removed from the data by
  `splitOverview`; the controller re-splits only when its key (`overview set version | units | card id | hidden ids`)
  changes, never per frame. The chip filters change only when the chip targets do.
- Clicks: a single fire wins over a group; a group click eases to `clusterClickZoom(getClusterExpansionZoom, zoom)` =
  min(expansion, 8) and never out; it counts as an explicit request (`framing.explicit()`) and resets the list to
  "in this view" (`useWorkspace.overviewShowAll = false`). Hover: "61 active fires · largest 606 ac · 57 under 10 ac
  or size not reported · click to zoom in" (`clusterHoverText`); a fire's hover shows "Garfield Co., CO", the issuer
  label from `recordIssuerLabel` and "Updated …" in the row's own zone with the current clock.
- In-view list: the controller publishes `useMapRuntime.viewBox` (the visible box inside the safe-area padding, rounded
  to 1e-4°) at every move end; `null` while the map is unmounted (Forensic shows the whole list). `OverviewList`
  shows "{N} fires in this view · Show all {M}" (`inViewLabel`) or "All {M} listed fires · Show the fires in this
  view"; counts per filter are memoised on the three lists (`overviewCounts`).
- Rows "Garfield Co., CO" (`fireWhere`: Louisiana "Parish", names that already say County/Parish/Borough/City kept,
  no county → location or unit, then the state). The picker uses `pickerWhere` / `pickerMatches` (state code and name
  searchable) and shows the start day in the row's own zone.
- Wording of §14.14 in `state/overview.ts`: `LIST_ABSENCE` (legend details, compact legend title, list footer, empty
  view), `LIST_ABSENCE_SHORT` (phone peek second line, compact legend row), `EMPTY_VIEW`, `NIFC_LIST_DOWN` /
  `CALFIRE_LIST_DOWN` (from `catalog.sources[list]`, kept by `catalogApply`). Phone peek: "{N} active fires · records
  updated {5 min} ago" (relative: the rows span many zones).
- Legend: compact row "Active fire", "Group of active fires", "Small active fire", "Other 2026 fire", "Group of other
  fires" (titles carry the full §14.11 strings) and the short absence line; details carry the exact §14.11 strings
  and `LIST_ABSENCE`.
