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

## 14.10 Search and coverage (M5)

- `lib/usStates.ts`: `L48_STATES` (48 + DC), `UNSUPPORTED_STATES` (AK, HI, PR, VI, GU, AS, MP: recognised so search can
  say so), `stateCode(word)` (codes, names, common abbreviations such as "Calif.", "Wash."), `stateName`,
  `isLower48`, `stateWords`.
- `location/search.ts`: `looksLikeZip` strips leading / trailing state words, multi-word names included ("83702 ID",
  "ID 83702", "83702, Idaho", "87501 New Mexico"); `queryState` ("Boise, ID", "Springfield IL", "Raleigh North
  Carolina"; a lower-case two-letter word without a comma is not a state); "Town, ST" queries go to the local lookup
  as typed (the backend parses them); `searchIncidents` matches the state code and name and the record's own name;
  `likelyMissingWestSign` uses the lower-48 box; messages `noPlaceMessage(q)` = "No US city, town, county or ZIP code
  matches “q”." (curly quotes, as the other search messages), the invalid-input message with "Boise, ID",
  `NOT_SUPPORTED_NOTE`, `OUTSIDE_LOWER48_WARNING`, `SEARCH_EXAMPLES`; `placeName` / `areaLabel` / `areaSub` show the
  state ("Boise, ID (town center, approximate)", "ZIP 83702, ID near Boise …", "city · Ada County · …") and keep an
  Alaska or Hawaii row with the not-supported note.
- `location/types.ts`: `GeocodeMatch` gains `state`, `state_name`, `county`, `supported`; `PlaceType` widened to the
  Census LSAD words.
- `lib/geodesy.ts` (W8): a bare pair with both values within ±90° takes the order inside `LOWER48_BOX`
  (`[-124.85, 24.4, -66.89, 49.38]`); inside neither, latitude first and `ParsedLatLon.outsideLower48 = true`, and the
  search box warns "This point is outside the area Fire-3d covers (the lower 48 states)." Letters and labels decide
  as before. `inLower48Box` is exported for the search heuristics only.
- `SearchBox.tsx`: "Searching US towns and ZIP codes…", the hint with "Boise, ID; 83702", "east longitude, far from the
  lower 48 states", a not-supported match flies there and warns with the §14.14 sentence.
- Coverage (W9, built in M3): `location/geoLookup.ts` (`useGeoLookup`, `lookupPoint` cache, `coverageText`,
  `lookupPlace`, `NOT_SUPPORTED_TEXT`, `OUTSIDE_US_TEXT`); `CoverageNotice` in `CardParts.tsx`; `OverviewCard.tsx` and
  `LocationCard.tsx` show it from `/api/geo/lookup` only (no client boxes). `OverviewCard`: "Nearest fires (official
  records)", the place's county and state, "Fire lists: CAL FIRE and NIFC WFIGS, checked …", the zone line "Times:
  Mountain Time (MDT), local time at this place".

## Cut line (M6): all six items done

- (a) Accuracy line in the Analysis drawer and the Forensic Analysis tab: `ui/RegionAccuracy.tsx` (`RegionAccuracy`)
  shows the Command line, the fuel caveat and "Outside the modeled area is unknown, not low." for the open fire, from
  `state/accuracy.ts` `useOpenFireAccuracy()` (null while the file loads or with no fire open; a load failure says
  "The accuracy of the model in this region could not be loaded right now."). Rendered by `ui/shell/AnalysisDrawer.tsx`
  and `ui/AnalysisTab.tsx`, never inside an official record. Test: `ui/RegionAccuracy.test.ts`.
- (f) Location card model block (`location/LocationCard.tsx` `ReasonsBlock`): one `.loc-model-accuracy` line under the
  model sentence (Public: the words; Command: the score line), then the "always" sentence; hidden in the compact phone
  sheet.
- (d) `data/rasters.ts`: `RasterSetLoader` (plain class, no new dependency) owns the load of one raster set:
  `update(key, entries)` reloads when the key changes and drops a stale answer, `dispose()` ends it; `useRasterSet`
  holds one per component (`useState(() => new RasterSetLoader(setLoaded))`). `rasters.test.ts`: a 288 MiB layer above
  the 256 MiB cache cap stays cached while it is the only layer; two names sharing one URL keep their own names;
  reload on key change, stale answers dropped, dispose.
- (e) `lib/reproject.test.ts` W14: zones 10-19 (central meridian ±3.4°, 24.5/37/49.4° N) round trips and grid alignment
  (72 grids), zone-line AOIs at 102/108/84° W, Key West, Northwest Angle, West Quoddy, and the `fixture-east` grid
  (UTM 17N, centre 381789 E / 3905979 N, 12 km).
- (c) W15 phone fixes (audit G12):
  - search message under the controls: `location/searchUi.ts` `controlsShift(popover, controlsTop)`; on phones
    `map/MapControls.tsx` slides the controls below an open search message with a transform (the controls' slot
    keeps its size, so the safe area and the map framing do not move with the message).
  - refit with the list sheet open: `map/framing.ts` `MIN_MAP_PX = 160` and `mapCovered(insets, w, h)`; while the chrome
    leaves less map than that (the phone list sheet), `mapController` keeps the last usable padding and does not
    follow the safe area, so the camera and the list's "N fires in this view" keep what the user saw; closing the
    sheet frames again. On phones the frame button ("All states" / "Incident") first closes an open bottom sheet
    (updates, layers, analysis), so the framed map shows.
- (b) W11 list windowing above 150 rows: `state/overview.ts` `LIST_WINDOW_MIN = 150`, `LIST_OVERSCAN = 10`,
  `listWindow(n, scrollTop, viewH, rowH)` and `scrollToRow(i, rowH, scrollTop, viewH)`; `ui/useListWindow.ts`
  (`useListWindow(n, scroller, list, { padPx, rowSelector, onWindow })`) follows the scroller's position and size and
  the rendered row pitch (layout offsets averaged over the rendered rows; the view height never above the window's).
  The overview list (`ui/shell/OverviewPanel.tsx` `FireList`) keeps the unrendered rows as padding on the `<ul>`;
  every `<li>` carries `aria-posinset` / `aria-setsize`; ArrowUp/Down, Home and End move the roving focus over the
  whole list (an unrendered row is scrolled in, then focused); a focused row scrolled out of the window by the wheel
  hands focus to the list itself (`tabIndex=-1`), from where the arrows continue. The incident picker
  (`ui/IncidentPicker.tsx`) uses spacer elements instead of padding (its scroller is the list, a flex item that cannot
  shrink below its own padding), `aria-posinset` / `aria-setsize` on each option, and a new tab or query scrolls the
  list back to the top. Checked in Chrome: 1,393 rows render 14-32 at a time; End lands on row 1,393 and Home on
  row 1, both visible.

## Late changes (after M5)

- `us-official`'s §14.9.6 shims (commit "brief 3 us-official: M1") now get `tf` at every us-web call site:
  `buildFeedItems` (`ui/KeyEvents.tsx`, `ui/timeline/CompactTimeline.tsx`, `map/mapController.ts` `mapEvents`, whose
  event key includes the zone and clock), `zoneDetail` and `cameraViewText` (map hovers, `getTimeFormat()`),
  `officialBlock` (`location/LocationCard.tsx`, `location/OverviewCard.tsx`) and `officialFireWeatherNote`
  (`location/LocationCard.tsx`).
- Overview panel: the official block above the list is capped at 22vh (`.ov-official`; the old 34 % of an indefinite
  height did not apply and the list could shrink to no rows) and the list keeps at least 132 px. An empty view or empty
  filter carries the list-absence line itself, so the footer is not rendered under it (the line is said once).
- Alaska, Hawaii and territories (`location/geoLookup.ts` `nearestFiresMeaningful`, `UNLISTED_HERE_TEXT`): the
  overview location card replaces "Nearest fires (official records)" rows (the nearest lower-48 fire is more than a
  thousand miles away and would read as nothing nearby) with "Fire-3d lists fires in the lower 48 states only, so fires
  here are not listed. Follow local officials." Places outside the US keep the list (a point across a border can be
  near a listed US fire).
- Fire card: a member fire outside California shows "Part of the {complex_name}" with the name verbatim
  (`lib/recordText.ts` `partOfComplex`; "Complex" is added only when the name lacks it).
- Search: a ZIP match is titled "ZIP 83702, ID" from the match's own `zip` and `state`.
- Search examples are national: the placeholder "e.g. 150 N Capitol Blvd, Boise, ID", the hint and the invalid-input
  message "e.g. 150 N Capitol Blvd, Boise, ID; Springfield, IL; 83702" (`location/search.ts` `SEARCH_EXAMPLES`; a test
  checks each example parses as the kind it shows).

## Review fixes round 1 (behaviour changes)

- Fire card record status (R1, §14.5, round 3 item 2): the `.fc-official` section takes its status from the record's
  own agency (`lib/recordText.ts` `recordStatus`, built on `ownRecordActive` from `api/records.ts`), never from the
  merged listing row. Own record active: the listing word ("Active"; "Contained" for a non-live row at 100 %). Own
  record not active: "Contained" at 100 % or with `contained_ms`; else "Not listed as active" when the other agency
  still lists the fire (the merged row is live or active); else the listing word ("Out"). The time line follows the
  same flag: "Updated by <issuer> …" only when the record itself is active, else "<issuer> record last edited …". The
  title chip ("ACTIVE") stays Fire-3d's listing (active when either agency says so) and sits outside `.fc-official`.
  The status cell wraps (`.fc-facts dd.fc-status`), so "Not listed as active" stays inside the card.
- Map hovers (`map/hoverText.ts`, pure, tested): a fire's hover reads "<issuer> (official): <size> · <n> % contained
  · <recordStatus>", "Updated <time, year when not this year>", then one line per disagreeing record
  (`recordBlocks(s).slice(1)`, "Timber: Active (USFS via NIFC WFIGS, updated …)"). An evacuation zone's hover names the
  state source from the answer's `sources[]` (`aggregatorOf(data, zoneSourceId(zone.properties))`: "Official status
  from local officials via Cal OES." / "… via Oregon OEM.") (R2, §14.8.5).
- Per-run skill table (R3, §14.4): with growth values the header stays "Total-area overlap" and a note under the table
  says "Growth scores only the new spread after the start. Total-area overlap includes the area already burned at the
  start."; without them the header keeps the full wording. `SkillTable` is exported (props `{ skill }`) for its test.
- Location card official links (R4, §14.7): `OfficialSection` labels each link with the line's `urlLabel`
  ("Issuer's link", "Source record (NWS)", "Source record (FEMA archive)"; first letter capitalised), else "Read it".
- Credits next to the data (R5, §14.13): `lib/dataCredits.ts` `NWCG_AGENCY_CREDIT` ("Agency names: NWCG unit
  identifiers") under the fire card's record whenever a plain agency name was added after an agency code
  (`recordText.agencyNameShown`: the own issuer label or a shown disagreeing record); `GEO_LOOKUP_CREDIT`
  ("Boundaries: U.S. Census Bureau TIGERweb · Time zones: USDOT BTS NTAD") in the overview location card's "Updated and
  reliability" list whenever `/api/geo/lookup` answered.
- Dev pages (R6): `fx-dev.html` and `scene-dev.html` meta descriptions use the `index.html` wording (lower 48).
- Phone labels (R7, §14.11): features carry `side` (`labelSide(lon)`: 'ww' < -116°, 'w' < -105°, 'c', 'e' > -87°,
  'ee' > -76°). On a map narrower than `NARROW_PX` (500 px), the three label layers get `text-variable-anchor-offset`
  = `narrowLabelAnchorOffset()`: below z3 (`NARROW_LABEL_MAX_ZOOM`) the anchors of `LABEL_ANCHORS[side]` (a western
  label grows east, an eastern one west: 'ww' ['left'], 'w' ['left', 'top', 'bottom'], 'e' ['right', 'top', 'bottom'],
  'ee' ['right']), from z3 the default four; offsets follow the marker radius as `text-radial-offset` does
  (0.45 + r/12 em). Wide maps are unchanged. The controller applies it at style load and on `resize` when the map
  crosses 500 px. A label that does not fit inward is left out (text-optional), as a colliding label is.
