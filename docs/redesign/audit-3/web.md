# Audit 3: the web app for the lower 48 states

Role `audit-web-us` (brief 3, stage A). Read-only: no project code changed, no fire built, "Prepare analysis" never
pressed. Servers: API 8712 (`FIRE3D_LIVE=0`) and Vite 5182. The browser runs made 105 API requests, all GET (0
non-GET, counted from the API access log). Evidence is in section 5. Official evacuation data is covered by
[`evacuations.md`](evacuations.md); this file cross-references it (E-G1 = its gap G1, E-R1 = its change R1).

## 0. Summary

- California-shaped in five places: the overview frame and wording, the time zone, the fire-record source (CAL FIRE),
  search (California Gazetteer) and the official panels (Cal OES, NWS "in California").
- **Time is the deepest assumption**: `lib/time.ts:4` `TZ = 'America/Los_Angeles'` feeds 214 call sites in 43 files,
  and `laWallToMs` hard-codes the PDT/PST offsets (`:187-188`), so swapping the constant moves ticks 1-3 h and drops
  hourly ticks for any other zone.
- **Scale**: NIFC WFIGS lists 1,178 lower-48 wildfires of 300 ac or more in 2026 so far (984 in 2025). Loaded into
  today's overview they make one orange blob on phones and about 40 colliding labels on desktop
  (`audit3-web-national-1178-*.png`). MapLibre's built-in GeoJSON clustering fixes it without a new dependency.
- No web data type carries a state or a time zone (`api/types.ts:9-33`): the backend must add both (3.4).
- 418 non-test lines in `web/src` name California, CAL FIRE, Cal OES, Pacific time or Los Angeles: 160 code or visible
  text, 197 comments, 61 fixtures or dev pages (1.6). Two phone bugs show in the evidence (G12).

## 1. What exists today

### 1.1 Overview (map workspace, no fire open)
- **Frame**: `map/framing.ts:22` `CALIFORNIA_BOUNDS = [-124.48, 32.53, -114.13, 42.01]` (goal `:138`); the map starts at
  `CALIFORNIA = [-119.4, 37.2]` z5 (`map/mapController.ts:89, :237`; fallback `:690`, padding refit `:780`, button goal
  `:1011`). No `maxBounds`.
- **Wording**: "California · all fires" / "Back to the California overview" (`ui/shell/MapHeader.tsx:185, :189`);
  "California fires" (`MapHeader.tsx:139`, `ui/shell/OverviewPanel.tsx:254, :267`, `App.tsx:351`); "California" /
  "Show all of California" (`map/MapControls.tsx:107-108, :164`); "Showing all California fires"
  (`OverviewPanel.tsx:296-297`); "California overview" (`location/CoordinateStrip.tsx:220`).
- **Filters**: `state/overview.ts:9-20` (2026 season, 2025, 300 ac, CAL FIRE tips); lists from `state/catalog.ts`.
- **Markers** (`map/overviewLayers.ts`, one source, one point per fire `:88-114`): sqrt(acres) 4-13 px at every zoom
  (`:62-67`); labels for active fires and fires of 20,000 ac or more (`:51, :78-80`), dropped on collision
  (`:295-297`); nearest-centre clicks (`:125-136`); replay hides by layer filter (`:193-202`). **No clustering**.
- **List**: every row rendered (`OverviewPanel.tsx:68-97`), counts recomputed per render (`:168-172`), rows say
  "<County> Co." with no state (`:43`).

### 1.2 Time handling (every place a time is shown or assumed)
Core: `lib/time.ts`.
- `TZ :4` (SPEC §4.2:140 "The UI displays America/Los_Angeles time").
- `tzLabel :54` (fallback "PT"), `laParts :92`, `laOffsetMinutes :113`, `startOfLaDay :120`, `laTicks`/`laDayTicks :129-153`.
- **`laWallToMs :184-196`** (only UTC−7/−8), which `laWallTicks :217` uses.

| Area | Call sites (file: lines); 214 calls in total |
|---|---|
| Timeline | `ui/timeline/CompactTimeline.tsx` 140,234,279 (LA day ticks),343,344,359,395,452,464,476,504,509,524,558; `ui/Timeline.tsx` 76,77,102,244 (laWallTicks),292,355,356,415,428,436 |
| Feed | `ui/feed/feedModel.ts` 400,422,434 (groups by LA day),441,442,470,478; `ui/feed/UpdatesFeed.tsx` 302-304,348,396,462,607 |
| Cards | `ui/shell/FireCard.tsx` 73,77,81,163 (an LA start date); `location/describe.ts` 138,300,591,608,681; `location/official.ts` 59; `location/OverviewCard.tsx` 135; `location/CoordinateStrip.tsx` 243,248 |
| Charts, analysis | `ui/Charts.tsx` 194 (laWallTicks),270,972; `ui/WeatherCard.tsx` 57,73,75; `ui/AnalysisTab.tsx` 87,171,183,264; `lib/plainLanguage.ts` 191,196-198,296 |
| Forensic | `scene/fx/Telemetry.tsx` 190; `scene/fx/Ignition.tsx` 179; `scene/overlays/SceneOverlays.tsx` 290; `ui/EvidenceTab.tsx` 101,156,177,212,235; `ui/KeyEvents.tsx` 80,132; `ui/NotesTab.tsx` 51,73,122; `ui/IncidentOverview.tsx` 96,104; `ui/Header.tsx` 58,155 |
| Official, extras | `ui/feed/OfficialNow.tsx` 134,157,176,239,240,322; `official/calfire.ts` 145,148,191,210,223; `official/fireWeather.ts` 178-185; `extras/format.ts` 12-14 (year compared in UTC),63; `extras/evacuation.ts` 304,305,396; `extras/imagery.ts` 196,218,248-255,301,303; `extras/cameras.ts` 235,252; `extras/EvacuationPanel.tsx` 147 |
| Shell, map, other | `ui/shell/dataStatus.ts` 73,74,85,116,122,155,181,198,221; `OverviewPanel.tsx` 110,146; `officialSummary.ts` 65; `LayersPanel.tsx` 175; `map/MapLegend.tsx` 95,96,153,171-175,224; `map/mapController.ts` 1325,1355,1371,1392; `map/overlayModel.ts` 263; `map/nearbyPerimeters.ts` 91; `ui/Overlays.tsx` 109; `ui/IncidentPicker.tsx` 249; `ui/Menus.tsx` 340 ("Times: America/Los_Angeles") |
| Dev only | `extras/dev/DevApp.tsx` 305,306,334; `extras/dev/presets.ts` 59-71; `scene/dev`, `scene/fx/dev` |

- **No zone shown**: the phone peek "CAL FIRE, updated 13:19" (`OverviewPanel.tsx:146`), and every date-only `fmtDate`.
- **Backend text** with Pacific time baked in reaches the UI. Examples: "Jan 07, 18:18 PST" (`build/observed.py:89, :200`),
  and `LA_TZ` in `spread/ensemble.py:70`, `spread/behavior.py:32`, `sources/overpass.py:50` (backend audit).

### 1.3 Search
- `location/search.ts`: `STATE_WORDS` is `ca, calif, california, usa, us` (`:57`), so "83702 ID" is not a ZIP code;
  "a California town" messages (`:102, :187, :191`); a California box in `likelyMissingWestSign` (`:109-111`). Same
  wording in `SearchBox.tsx:180, :236, :380` and `geocodeClient.ts:37`.
- Towns and ZIP codes come from `backend/fire3d/data/gazetteer_ca.json`: "Boise, ID" gets "No California city, town
  or census-designated place matches", and "83702" gets "not a California ZIP area … Fire-3d covers California only".
  Street addresses (Census geocoder) are already national. Incident search (`searchIncidents :62-90`) ignores the state.

### 1.4 Official UI (evacuations: E-G1 to E-G4)
- `official/model.ts` `insideCalifornia :166-168` gates the evacuation point query (`:160`), the statewide NWS answer
  (`:393`) and the NWS state at a point (`:425`: "Fire-3d checks NWS fire weather alerts in California only.").
- The location card lists NWS alerts only while one is in effect (`location/official.ts:150`), so outside California
  "not checked" is **silent**; it still links "Cal OES" at an Idaho point (`:154`).
- Overview: "OFFICIAL NOW · California … No Red Flag Warning or Fire Weather Watch in effect in California"
  (`ui/feed/OfficialNow.tsx:283, :310, :364, :369`), from `official/client.ts:17` (backend `nws.py:445` `area=CA`).
- Cameras: ALERTCalifornia and Caltrans via "Cal OES California Webcams" (`extras/cameras.ts:212-236`,
  `CameraPanel.tsx:52, :111`, `extras/credits.ts:23-25`). Elsewhere: "No public cameras are listed in this area."
  (`CameraPanel.tsx:58`), as if none existed.

### 1.5 Fire record, picker, URLs, credits, Alaska and Hawaii, reprojection
- **CAL FIRE is the only issuer**: `official/calfire.ts:14-17` (`CALFIRE_ISSUER`, `CALFIRE_SOURCE`, fire.ca.gov
  fallback); card `FireCard.tsx:50-92, :145`; list `OverviewPanel.tsx:35-37, :106-146, :204-220`; hover
  `mapController.ts:1324, :1382`; legend `MapLegend.tsx:137, :140`; status `dataStatus.ts:196-205`; feed
  `feedMeta.ts:22`, `UpdatesFeed.tsx:69, :77, :382`; picker `IncidentPicker.tsx:34, :198-265`; `ForensicWorkspace.tsx:91`.
- **Ids**: "CAL FIRE incident UID" (`MapHeader.tsx:86`, `IncidentOverview.tsx:87`); `IncidentSummary.calfire_uid` is
  required (`api/types.ts:14`) and ids derive from it (SPEC §4.4). URLs carry only `?incident=<id>` plus workspace keys
  (`state/history.ts:28`, `state/workspace.ts:188-209`). Credits: CAL FIRE only (`lib/dataCredits.ts:51`). Command
  menu: "Active (CA)", `detections_24h_ca` (`ui/Menus.tsx:331-334`, `api/types.ts:355`).
- **Alaska and Hawaii**: nothing marks them; a point there gets the California wording, a fire link the generic
  "could not find" notice.
- **Reprojection**: `lib/reproject.ts` and `lib/geo.ts` work in any northern UTM zone (`manifest.grid.utm_zone`), but
  `lib/reproject.test.ts:44-83` covers EPSG:32610/32611 only (fixtures, Eaton, Cooley, Madre across 120° W, Camino).
  `CoordinateStrip.tsx:195` shows any point in the fire's zone.

### 1.6 California-specific strings (non-test `web/src`; grep `California|CAL FIRE|Cal OES|Pacific|Los_Angeles|PDT|PST|PT`)

| Term (lines) | Code / visible | Comments | Fixtures / dev | Files |
|---|---|---|---|---|
| California | 36 | 52 | 16 | 38 |
| CAL FIRE | 89 | 87 | 16 | 48 |
| Cal OES (E-G4) | 35 | 37 | 16 | 19 |
| Pacific / Los_Angeles / PDT·PST·PT | 3 | 34 | 18 | 21 |
| `CA` code | 3 (`Menus.tsx:331`, `search.ts:57`, `addressStore.ts:42`) | 3 | – | 5 |

| Component | Code lines (file: lines) |
|---|---|
| ui (78) | `shell/OverviewPanel.tsx` 35-37,106,118,119,137-139,146,204,208,219,220,254,267,280,296,297; `feed/OfficialNow.tsx` 71,95,102,134,157,158,171,176,188,201,239,283,310,364,369; `shell/dataStatus.ts` 142,148,155,160,196,200,204,205; `shell/FireCard.tsx` 50,53,73,77,87,92,145; `IncidentPicker.tsx` 34,198,207,220,222,265; `shell/MapHeader.tsx` 86,139,185,189; `IncidentOverview.tsx` 77,78,87,121; `Overlays.tsx` 36,155,200; `feed/UpdatesFeed.tsx` 69,77,382; `shell/LayersPanel.tsx` 45,251; `shell/officialSummary.ts` 28,57; `feed/feedMeta.ts` 22; `feed/feedModel.ts` 124; `EvidenceTab.tsx` 195; `shell/ForensicWorkspace.tsx` 91; `Menus.tsx` 331,340 |
| official (26) | `calfire.ts` 14,15,17,68,103,105,148,162,168,170,183,190,191,198,208,216,217,223,235; `model.ts` 160,166,209,213,360,393,425 |
| location (21) | `official.ts` 73,76,79,98,105,153,154,177; `OverviewCard.tsx` 111,120,122,135; `search.ts` 102,187,191; `SearchBox.tsx` 180,236,380; `CoordinateStrip.tsx` 196,220; `geocodeClient.ts` 37 |
| extras (17) | `evacuation.ts` 263,305,396,409,410; `cameras.ts` 212,225,235,236; `credits.ts` 17,23,25; `CameraPanel.tsx` 52,54,111; `EvacuationPanel.tsx` 43,45 |
| map (9) | `mapController.ts` 1324,1330,1343,1382; `MapControls.tsx` 107,108,164; `MapLegend.tsx` 137,140 |
| lib, app, state, scene (9) | `lib/time.ts` 4,56; `lib/plainLanguage.ts` 377,378; `lib/dataCredits.ts` 51; `App.tsx` 277,351; `state/overview.ts` 17; `scene/fx/Telemetry.tsx` 187 |
| tests | 163 lines in 19 files (`official/calfire.test.ts` 29, `location/official.test.ts` 20, …); 62 PDT/PST strings in 12 files |

## 2. Gaps

| # | Grade | Gap | Evidence |
|---|---|---|---|
| G1 | **BLOCKER** | Every time is Pacific, and no data carries a zone. Swapping `TZ` breaks the ticks. A fire found at 00:30 EDT on Oct 17 shows "Started Oct 16" and "21:30 PDT" | `lib/time.ts:4, :184-196`; 1.2; `api/types.ts:9-33` |
| G2 | **BLOCKER** | The overview is framed and named for California | 1.1; `audit3-web-overview-*.png` |
| G3 | **BLOCKER** | No clustering or zoom-aware decluttering for about 1,200 markers a year | `overviewLayers.ts:62-114, :283-301`; `audit3-web-national-1178-phone.png` (blob), `-desktop.png` |
| G4 | **BLOCKER** | The fire record is hard-wired to CAL FIRE: issuer, link, legend, hover, card, list, credits, ID | 1.5; 89 code lines |
| G5 | **BLOCKER** | Official panels outside California: evacuations (E-G1, E-G2); NWS "California only" and silent on the card; a "Cal OES" link in Idaho; "Official now · California" | `model.ts:393, :425`; `location/official.ts:150, :154`; `audit3-web-location-boise-*.png` |
| G6 | INCOMPLETE | Search covers California towns and ZIP codes only; "Town, ST" is not parsed | 1.3; `audit3-web-search-boise-desktop.png`, `-zip-phone.png` |
| G7 | MISSING | No state on rows, cards or hover. "Garfield Co." could be in CO, MT, NE, OK, UT or WA | `OverviewPanel.tsx:43`, `IncidentPicker.tsx:243` |
| G8 | INCOMPLETE | The list renders all 1,262 rows. One sample in this software-rendered sandbox took 424 ms from setState to the next frame (indicative only; frame rates are not meaningful here) | `OverviewPanel.tsx:68-97, :168-172` |
| G9 | MISSING | Nothing marks Alaska and Hawaii "not supported yet"; points outside the US get California wording | 1.5 |
| G10 | INCOMPLETE | Cameras are California-only, and the empty state elsewhere implies there are none | `CameraPanel.tsx:52, :58` |
| G11 | INCOMPLETE | Reprojection is tested in UTM 10/11 only; the lower 48 needs 10-19 | `reproject.test.ts:44-83` |
| G12 | INCOMPLETE | Phones: (a) the controls row covers the search message; (b) with the list sheet open, the refit hides the fires behind it | `audit3-web-search-zip-phone.png`, `audit3-web-official-overview-phone.png` |
| G13 | INCOMPLETE | "Active (CA)", "Times: America/Los_Angeles", `detections_24h_ca` | `Menus.tsx:331-340` |
| G14 | INCOMPLETE | Backend text with "PST" baked in reaches the feed | `observed.py:200` (backend audit) |
| G15 | INCOMPLETE | Ids use `calfire_uid`. If California rows change source, old links and bundles break | SPEC §4.4; `api/types.ts:14`; `state/history.ts:28` |

## 3. Recommended changes

### 3.1 One shared time formatter (fixes G1, G13; supports E-R5)
- **`lib/time.ts` takes an IANA zone in every function; no zone constant.**
  - `fmtAt(ms, tz, { date, year, refMs, clock: '24h'|'12h' })` → "Oct 22, 15:40 MDT" or "3:40 PM MDT" (Q1); the year
    is compared in `tz`, not UTC (`extras/format.ts:13`).
  - `zoneAbbr(ms, tz)` = Intl `timeZoneName: 'short'` (en-US), fallback "UTC−7". Checked in Node ICU (July and January):
    PDT/PST; MDT/MST for Boise and Denver; MST all year for Phoenix; CDT/CST for Chicago, Indiana/Knox,
    North_Dakota/Center and Menominee; EDT/EST for Detroit, Kentucky/Louisville and New_York.
  - `zoneName(tz)` → "Mountain Time" (`longGeneric`, checked). `wallParts`, `startOfDay`, `wallTicks`, `dayTicks` take
    `tz`; `wallToMs(…, tz)` finds the offset in two passes (no 420/480 constants; DST gaps resolve forward as now).
- **`tz` is required**, so `npm run typecheck` lists all 214 call sites. California fires pass `America/Los_Angeles`:
  every California string and test stays identical, and tests only add the argument.
- **Where the zone comes from**:
  1. A fire's own times (timeline, feed, charts, card, its official items, scene labels, notes): the fire's zone, via
     `useDisplayTz()` (`state/timeZone.ts`, new) = `manifest.time_zone ?? summary.time_zone`.
  2. Overview rows and fire cards: each row's `time_zone`.
  3. Times about many fires and Fire-3d's own check times: relative ("checked 2 min ago"), absolute in a tooltip in
     the viewer's browser zone, labelled.
  4. A point with no fire: the `time_zone` of its official answer (E-R1), else the viewer's zone, labelled.
  5. Fallback: always the viewer's zone with its abbreviation, **never** Pacific.
- **Wording**: one line per panel, "Times: Mountain Time (MDT), the fire's local time" (also the Command menu,
  `Menus.tsx:340`). A fire straddling a zone line uses its reported point's zone. A source time without a zone
  (Florida, E-G8) is shown as given with "time zone not stated".
- **The backend supplies `time_zone`** (3.4); the backend audit picks how: NWS `/points` `timeZone` (public domain,
  cached once per fire) or a committed county-FIPS → IANA table.

### 3.2 National overview: frame, clusters, labels, list (fixes G2, G3, G8)
- **Frame**: `LOWER48_BOUNDS = [-124.85, 24.40, -66.89, 49.38]` replaces `CALIFORNIA_BOUNDS`; start [-98.6, 39.8] at
  about z3. The fit is about z3.2 on a 1440x900 desktop and about z2.1 on a 390 px phone (width-limited). Header
  "United States · all fires" (tooltip "lower 48 states; Alaska and Hawaii are not supported yet"), button "All
  states". Keep the last-view restore; no `maxBounds`.
- **Clusters** (built into MapLibre 5.24: `cluster`, `clusterProperties`, `getClusterExpansionZoom`; no dependency):
  - Two sources: `fx-overview-active` (`clusterRadius` 28, `clusterMaxZoom` 6, `clusterMinPoints` 3) and
    `fx-overview-other` (40, 7, 3). `clusterProperties` sums `active` and `ready` and keeps `max_acres`.
  - Bubbles 12-22 px by log(count), with the count. Active groups are orange, drawn on top, never mixed with
    contained fires (Q2). Hover: "23 fires (contained or out) · largest 642,029 ac · click to zoom in".
  - Click: `getClusterExpansionZoom` → `easeTo` at **min(expansion, 8)**, below `FOCUS_IN_ZOOM` 8.5, so it never
    zoom-focuses a prepared fire. It is an explicit request (ends the opening framing); the list switches to "in this
    view". `fireAt` returns `{ cluster_id, source }` for clusters.
  - Layer filters do not change cluster counts: drop hidden fires (replay, the open fire) from the data before
    `setData`, keyed on the hidden set (never per frame).
- **Markers and labels**: the radius follows zoom (`interpolate`, 0.6× at z3 to 1× at z7). A zoom `step` in
  `text-field` picks the labels: below z5, active fires of 5,000 ac or more and any fire of 100,000 ac or more; z5-7,
  today's rule; from z7, every active fire and every fire of 1,000 ac or more.
- **List**: "312 fires in this view · Show all 1,262" (Q3); windowed (fixed 50 px rows, visible ±10); rows read
  "Garfield Co., CO"; counts memoised.
- **Phones**: put the search message above the controls row (z-index); never refit the overview into the strip above
  an open sheet.

### 3.3 Change list

| # | Change | Value | Effort | Risk | Files | Prio |
|---|---|---|---|---|---|---|
| W1 | Shared formatter (3.1); `tz` at every call site; `useDisplayTz` | Brief time rule; correct dates and ticks | L | Medium: 43 files; California output identical (proved by tests) | `lib/time.ts`(+test), `state/timeZone.ts` (new), the files of 1.2, SPEC §4.2 | **P0** |
| W2 | Lower-48 frame and wording (3.2) | National first view | S | Low | `map/framing.ts`(+test), `map/mapController.ts`, `map/MapControls.tsx`, `ui/shell/MapHeader.tsx`, `OverviewPanel.tsx`, `App.tsx`, `location/CoordinateStrip.tsx` | **P0** |
| W3 | Clusters, zoom-aware markers and labels (3.2) | Readable at about 1,200-3,000 fires | M | Medium: hit-testing, replay data, focus | `map/overviewLayers.ts`(+test), `map/mapController.ts`, `map/MapLegend.tsx` ("Group of N fires") | **P0** |
| W4 | Source-neutral fire record: issuer, link and credit per row (`record_source`, `record_agency`, `record_url`); California rows keep the CAL FIRE wording | Correct issuer and credit | M | Medium: many strings; keep the California snapshots | `official/calfire.ts`, `FireCard.tsx`, `OverviewPanel.tsx`, `IncidentPicker.tsx`, `MapLegend.tsx`, `mapController.ts`, `dataStatus.ts`, `officialSummary.ts`, `feed/*`, `IncidentOverview.tsx`, `MapHeader.tsx`, `lib/dataCredits.ts`, `location/OverviewCard.tsx`, `location/incidents.ts` | **P0** |
| W5 | State on rows, card, hover and picker; state names and codes in incident search | Tells same-named counties apart | S | Low | `OverviewPanel.tsx`, `IncidentPicker.tsx`, `FireCard.tsx`, `location/search.ts`(+test), `lib/usStates.ts` (new: 48 + DC) | **P0** |
| W6 | National search: parse "Town, ST" and "ST 83702"; send `state=`; national wording; a lower-48 box for the missing minus; Alaska and Hawaii ZIP codes (995-999, 967-968) and names → "not supported yet" | Search works in every state | S-M | Low (the backend owns the Gazetteer) | `location/search.ts`(+test), `SearchBox.tsx`, `geocodeClient.ts`, `location/types.ts` | **P0** |
| W7 | Official outside California: the E-R1/R3 states in the UI; national NWS (coverage from the response); "Official now · United States: N alerts in M states, the 3 most recent"; the card always states the NWS status; links from `sources[]` | No implied checks; "not available in this state" | M | Medium | `official/model.ts`(+test), `official/client.ts`, `ui/feed/OfficialNow.tsx`, `location/official.ts`(+test), `dataStatus.ts`, `officialSummary.ts` | **P0** |
| W8 | List "in this view", windowing, memoised counts | A fast, relevant list | M | Low | `OverviewPanel.tsx`, `state/overview.ts`(+test), `IncidentPicker.tsx` | P1 |
| W9 | `coverageAt(lon, lat)` (rough Alaska, Hawaii and lower-48 boxes; the response's `states[]` decides near borders) → "Fire-3d does not support Alaska and Hawaii yet" / "outside the United States: not covered" | Brief decision 1 | S | Low | `lib/coverage.ts` (new)(+test), `location/OverviewCard.tsx`, `location/official.ts`, `OverviewPanel.tsx` | P1 |
| W10 | Cameras outside California: "Public cameras: California only (ALERTCalifornia, Caltrans). Not available in this state." | Honest empty state | S | Low | `extras/CameraPanel.tsx`, `extras/cameras.ts`, `extras/legend.ts` | P1 |
| W11 | UTM tests for zones 10-19 (3.5) | Overlays align everywhere | S | Low | `lib/reproject.test.ts` | P1 |
| W12 | Phone fixes (G12) | Usable phone search and list | S | Low | `styles/overview.css`, `location/searchUi.ts`, `map/mapController.ts:780` | P1 |
| W13 | Per-region accuracy label (decision 3) in the forecast text, the card's model block and the Analysis drawer, from the validation audit's field | Honest skill label | S | Low | `lib/plainLanguage.ts`, `location/describe.ts`, `ui/AnalysisTab.tsx`, `ui/timeline/CompactTimeline.tsx` | P1 |
| W14 | Clean-up: 197 comment lines, dev presets, "Active (CA)", the UTM label "(fire grid zone)" | Accurate code docs | S | Low | the comment lines of 1.6, `ui/Menus.tsx`, `location/CoordinateStrip.tsx` | P2 |

### 3.4 Contract requests (CONTRACT §14, SPEC, `contracts.py`, `api/types.ts`; all additive)
- `IncidentSummary`: `state` (USPS), `time_zone` (IANA), `record_source` (`'calfire' | 'wfigs' | …`), `record_agency`,
  `record_url` (https or null), `uid` (keep `calfire_uid` as a deprecated alias); Alaska and Hawaii rows not listed
  (or `supported: false`).
- Manifest: `time_zone`, `state`. Official and extras answers: `time_zone`, `states[]` (E-R1). Live status:
  `detections_24h` (keep `detections_24h_ca` one release).
- Ids stay `{year}-{slug}-{uid6}`; today's California ids and bundles keep resolving (G15). SPEC §4.2: "The UI shows
  each fire's local time with its zone abbreviation."

### 3.5 Reprojection tests to add (W11)
The lower 48 spans 124.7° W (Cape Alava, WA) to 66.9° W (West Quoddy Head, ME): UTM zones 10-19. Zones 10 and 11
(123° W / 117° W: WA, OR, CA, west NV, ID panhandle) are tested today.

| Zone | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
|---|---|---|---|---|---|---|---|---|
| Central meridian | 111° W | 105° W | 99° W | 93° W | 87° W | 81° W | 75° W | 69° W |
| Mostly | AZ, UT, east ID, west MT | CO, NM, WY, east MT | Dakotas, NE, KS, OK, TX | MN, IA, MO, AR, LA | WI, IL, IN, TN, AL, FL panhandle | east MI, OH, GA, Carolinas, FL | NY, PA, NJ, MD, east VA | ME, east MA |

- **Per zone** (parametrised): grids at the central meridian and ±3.4°, at 24.5°, 37° and 49.4° N. Check the round
  trip against `lib/geo.ts` (< 1 mm), the true AOI quadrilateral, and the per-pixel inverse mapping at edges and
  corners (today's cases, run per zone).
- **Zone-line AOIs** like Madre at 120° W: 102° W (13/14), 108° W (12/13), 84° W (16/17). **Extreme points**: Key West
  24.55° N 81.8° W (17), Northwest Angle 49.38° N 95.15° W (15), West Quoddy 44.82° N 66.95° W (19).
- **Real bundles**: add the grids of stage D's out-of-state bundles (values copied from their manifests).
  **Backend test** (backend-owned): the chosen zone is `floor((lon + 180) / 6) + 1`.

## 4. Questions only the user can answer

1. **Clock style.** (a) 24-hour everywhere ("15:40 MDT"). (b) 12-hour everywhere ("3:40 PM MDT"). (c) 12-hour in
   Public, 24-hour in Command and Forensic. **Recommended: (c)**: the public and the NWS read 12-hour, incident
   command uses 24-hour, and one formatter option gives both.
2. **Active fires in groups.** (a) Active fires group only with other active fires, never hidden among contained
   ones. (b) All fires group together, with "N active" on each group. **Recommended: (a).**
3. **National list.** (a) Fires in the current map view, with "Show all". (b) The whole list, grouped by state.
   (c) The whole list as today. **Recommended: (a)**: short, and it follows the map.
4. **Phone opening view.** (a) The whole lower 48 with grouped markers. (b) The region with the most active fires.
   **Recommended: (a)**: predictable, and it never suggests other regions are quiet.
5. **Cameras outside California.** (a) California only; "not available in this state" elsewhere. (b) Research other
   public camera networks and their terms in a later brief. **Recommended: (a) now, (b) later.**

## 5. Evidence log (2026-10-22 UTC)

- **Screenshots** (swiftshader, each viewed): `docs/screenshots/audit3-web-<name>.png`, `-desktop` 1440x900, `-phone`
  390x844.
  - `overview-*`: "California · all fires", season 84, PDT; the phone peek "CAL FIRE, updated 13:19" has no zone.
  - `firecard-*`: Norte Fire, "CAL FIRE incident record", "Started Oct 16, 2026", "13:19 PDT".
  - `location-boise-*` (43.615° N, 116.2° W): "Nearest fires (CAL FIRE)" 273 mi away; "Evacuation zones: not checked
    here · Cal OES lists evacuation zones in California only"; "Follow local officials. Cal OES"; "(Oct 22, 14:30
    PDT)"; no NWS line.
  - `search-boise-desktop` ("Boise, ID" → "No California city…"); `search-zip-phone` ("83702": the message is hidden
    under the map controls).
  - `official-eaton-command-desktop` ("Evacuations via Cal OES", CAL FIRE record, NWS archived copy, PST);
    `official-overview-phone` ("OFFICIAL NOW · California"; fires pushed behind the sheet).
  - `national-1178-*`: 1,178 real 2026 lower-48 WFIGS points (wildfires of 300 ac or more), put into
    `useStore.catalog.season` in the browser only and fitted to the lower 48; the panel lists 1,262 rows.
- **WFIGS (NIFC)**: 6 count-only or small GETs with a descriptive User-Agent; raw files stayed in the scratchpad.
  `WFIGS_Incident_Locations_YearToDate` `IncidentTypeCategory='WF' AND IncidentSize>=300`: 1,204 in all, 1,109
  outside AK, HI and CA, 69 in CA; by state OK 135, TX 119, FL 105, OR 85, ID 84, WA 73, CA 69, MT 57, NM 53, CO 45
  (37 states). `WFIGS_Incident_Locations`, 2025 by discovery date: 984.
- **Time zones**: Node 22 Intl (en-US) as in 3.1; Oct 17 00:30 EDT = Oct 16 9:30 PM PDT.
- **Greps**: 1.6 classifies each grep hit as comment, code or fixture; 214 time calls in 43 files (not counting
  `lib/time.ts` and tests).
- **Gates**: not run (stage A changes no code). A count-only scan of the server logs for the key name found 0.
