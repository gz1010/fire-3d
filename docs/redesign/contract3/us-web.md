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

## 14.9 migration of us-web's files (M3)

- `node web/scripts/check-time-api.mjs --role us-web` → 0 deprecated uses, 0 `America/Los_Angeles` literals; one
  `tz-ok` opt-out (the checker's own search string). **Deviation:** the checker also skips `web/src/lib/time.test.ts`
  (the definitions' own test, which checks the deprecated shims until the integration deletes both), as it skips
  `lib/time.ts`; the contract named only `lib/time.ts`.
- Components use `useTimeFormat()` (the open fire's zone) or `useTimeFormatFor(row.time_zone)` (the fire card's fire,
  which may not be the open one). Pure helpers take a `TimeFmt`:
  - `lib/plainLanguage.ts`: `forecastPeriod(f, tf?)`, `burnProbabilityText(fraction, f, members?, tf?)`,
    `forecastDescription(f, mode, { plain?, tf? })`: optional (us-official's `ui/feed/feedModel.ts` imports
    `forecastPeriod`), defaulting to `getTimeFormat()`.
  - `location/describe.ts`: `DescribeOptions.tf` (required; only `LocationCard.tsx` and the test call it).
  - `map/overlayModel.ts`: `perimeterFeatures(perimeters, grid, tMs, tf)`; the controller's perimeter key includes the
    zone and clock, so a preset switch relabels them. `map/nearbyPerimeters.ts`: each other fire's own zone
    (`NearbyFire.timeZone`).
- Zone lines (§14.9.1, `zoneLine`): the location card's reliability block (fire / viewer), the overview location card
  (place / viewer: the place zone comes from `/api/geo/lookup` and is published with `usePlaceZone.setPlaceZone`), the
  Public/Command timeline's time tooltip, the Forensic timeline's window tooltip, the Command settings menu "Times".
- Years in the zone: `ui/DataCredits.tsx` uses `localYear(started_ms, summary zone)`.
- Not yet passed (us-official's §14.9.6 shims do not exist yet; they fall back to `getTimeFormat()`): see the report's
  `notes_for_integrator` for each call site.

## 14.4 / 14.5 Records and accuracy on the fire card (M4)

- `ui/shell/FireCard.tsx` reads the summary only (no official fetch) through `recordIssuerLabel` / `recordBlocks`
  (`api/records.ts`, imported, never re-implemented):
  - `.fc-official` (aria-label "<issuer> official record"): "<issuer> incident record", size / containment / status,
    "Updated by <issuer> <time>" (active) or "<issuer> record last edited <time> · contained <day>" in the fire's own
    zone (`useTimeFormatFor(fire.time_zone)`, the preset's clock, the year only when not this year), the record link
    ("CAL FIRE incident page" / "NIFC WFIGS record"), and the id line `agencyIdLine` ("Incident ID (CAL FIRE): …" /
    "Incident ID (NIFC WFIGS): …").
  - When `recordBlocks` returns more than one block: "The agencies' records differ on whether the fire is active; each
    is shown as published:" then one line per block, `recordBlockText`: "Active (USFS via NIFC WFIGS, updated Oct 22,
    9:05 AM PDT)" / "Not listed as active (CAL FIRE, updated …)", with each record's link and a member's name.
  - `complex_members` → "Includes (NIFC WFIGS names): 2-2, 2-7", each linked to its `other_records` entry's https
    `url` (matched by name, `complexMembers`); the heading, acres, containment and times stay CAL FIRE's.
  - `complex_name` → "Part of the {X} Complex" under the title. The title line shows `fireWhere` ("Garfield Co., CO").
  - FireCard no longer imports `fmtStatusTime` (us-official's).
- Accuracy (§14.4): `state/accuracy.ts` (`useAccuracyStore`, `useAccuracyRegions()` loads `/api/accuracy-regions`
  once; `findRegion`). Templates in `lib/plainLanguage.ts`: `accuracyLabel(region, method)` → `{ status, publicLine,
  publicDetail, commandLine, fuelCaveat, always }`, `lfmMethodWords`, `ACCURACY_*` constants. Rules as built:
  - every number from the file; Public one decimal with the range, Command two decimals (growth ratio as few digits
    as needed: 1.85, 2.1); `+12-72 h` from the region's `by_lead` keys, else `method.leads_h`;
  - "starts during main growth" (Command) and "started during the fires' main growth and" (Public detail) only when
    `method.starts` mentions "main growth" (a clause the file does not support is left out; the seed line of §14.4
    has no such clause);
  - growth ratio ≥ 1.05: "about 2.1× too much growth"; 0.95-1.05: "about as much growth as really happened"; below:
    "about 60% of the real growth" ("half" for 45-55 %);
  - limited Command bracket from `fires[0]`; untested Command adds the region name only when the file names one;
  - a load failure says "The accuracy of the model in this region could not be loaded right now." (never "untested").
- The label (`AccuracyNote`, class `fc-accuracy`) sits after `.fc-official` and before `.fc-note`; Public shows the
  line, the fuel caveat and a "How was it tested?" disclosure (`aria-expanded`); Command shows the score line and the
  fuel caveat; both end with "Outside the modeled area is unknown, not low."
- Per-run skill table (`ui/AnalysisTab.tsx`, V-R13): a "Growth" column first when any `skill[].growth_sorensen` is
  present, the total relabelled "Total-area overlap (includes the area already burned at the start)" and no
  green/amber/red tone (neutral bars); without growth values: "The growth score (new spread only) is not stored for
  this run."
- Other record wording: `IncidentOverview.tsx` (link "CAL FIRE" / "NIFC WFIGS", id tooltip `agencyIdLine`, state in
  the location), `MapHeader.tsx` id chip tooltip `agencyIdLine`, `lib/dataCredits.ts` credits "NIFC WFIGS (IRWIN)"
  for a data source named "NIFC WFIGS incident record …", `plainLanguage.sourceName` keeps "USFS via NIFC WFIGS"
  issuers, the Forensic telemetry ignition column says "NIFC" for a WFIGS start, the not-prepared notice and the map
  hovers use the issuer label.
