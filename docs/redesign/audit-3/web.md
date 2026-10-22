# Audit 3: the web app for the lower 48 states

Role `audit-web-us` (brief 3, stage A). Read-only: no project code changed, no fire built, "Prepare analysis" never
pressed. Servers: API 8712 (`FIRE3D_LIVE=0`), Vite 5182. Browser runs made 105 API requests, all GET (0 non-GET, from
the API access log). Evidence is in section 5. Official evacuation data is covered by
[`evacuations.md`](evacuations.md); this file cross-references it (E-G1 = its gap G1, E-R1 = its change R1).

## 0. Summary

- The web app is California-shaped in five places: the overview frame and wording, the time zone, the fire-record
  source (CAL FIRE), search (California Gazetteer) and the official panels (Cal OES, NWS "in California").
- **Time is the deepest assumption.** Every time goes through `lib/time.ts` with `TZ = 'America/Los_Angeles'` (`:4`):
  214 call sites in 43 files. Swapping the constant is not enough: `laWallToMs` hard-codes the PDT/PST offsets
  (`:187-188`), so timeline and chart ticks would land 1-3 h off, and hourly ticks would vanish, for any other zone.
- **Scale.** NIFC WFIGS lists 1,178 wildfires of 300 acres or more in the lower 48 so far in 2026 (984 for 2025;
  count-only queries, section 5). With these 1,178 real points loaded into the current overview, phones show
  one orange blob and desktops dozens of colliding labels (`audit3-web-national-1178-*.png`). Clustering is needed,
  and MapLibre's built-in GeoJSON clustering does it without a new dependency.
- No web data type carries a state or a time zone (`api/types.ts:9-33`). The backend must add `state` and `time_zone`
  (section 3.4).
- 418 non-test lines in `web/src` name California, CAL FIRE, Cal OES, Pacific time or Los Angeles: about 160 are
  user-visible strings or logic, about 190 are comments and about 66 are fixtures or dev pages (section 1.8).
- Two phone layout bugs show up in the evidence: the map controls hide the search message, and opening the list sheet
  pushes the fires off the map (section 2, G12).

## 1. What exists today

### 1.1 Overview (map workspace with no fire open)
- Frame: `map/framing.ts:22` `CALIFORNIA_BOUNDS = [-124.48, 32.53, -114.13, 42.01]`, the goal `:138`. The map is
  built at `CALIFORNIA = [-119.4, 37.2]`, zoom 5 (`map/mapController.ts:89, :237`), with fallback `:690`, refit on
  padding `:780` and the "California" button goal `:1011`. There is no `maxBounds`.
- Wording: header "California · all fires" (`ui/shell/MapHeader.tsx:185`); "Back to the California overview" `:189`;
  "California fires" panel (`:139`, `ui/shell/OverviewPanel.tsx:254, :267`, `App.tsx:351`); the button
  "California" / "Show all of California" (`map/MapControls.tsx:107-108, :164`); missing fire "Showing all California
  fires" (`OverviewPanel.tsx:296-297`); the coordinate strip "California overview" (`location/CoordinateStrip.tsx:220`).
- Filters: `state/overview.ts:9-20`: `SEASON_YEAR` 2026, `PAST_YEAR` 2025, `SEASON_MIN_ACRES` 300, with CAL FIRE tips.
  The lists come from `state/catalog.ts` (`?mode=live`, `?mode=historical&year=…&min_acres=…`).
- Markers: `map/overviewLayers.ts`. One GeoJSON source `fx-overview-fires` (`:23`) and one point per fire (`:88-114`).
  - Radius: sqrt(acres), 4-13 px (`:62-67`); zoom does not change it.
  - Labels: active fires and fires of 20,000 ac or more (`:51, :78-80`), dropped on collision (`:295-297`).
  - Hit testing: nearest marker centre (`:125-136`).
  - Replay: hidden fires are removed by layer filters (`:193-202`).
  - No clustering (brief-2 map report, known issue: "Southern California at z5: hollow markers overlap … there is no
    clustering").
- List: `OverviewPanel.tsx` renders every row as a button (`:68-97`), with no windowing. The filter counts are
  recomputed on every render (`:168-172`). A row says only "<County> Co." (`:43`), with no state.

### 1.2 Time handling (every place a time is shown or assumed)
- Core: `lib/time.ts`.
  - The zone: `:1-4` (`TZ`, SPEC §4.2 "The UI displays America/Los_Angeles time"), `laParts :92`, `tzLabel :54`
    (falls back to "PT"), `laOffsetMinutes :113`, `startOfLaDay :120`, `laTicks/laDayTicks :129-153`.
  - **`laWallToMs :184-196` tries only UTC-7/UTC-8**. `laWallTicks :217` is built on it.
- Call sites (file: lines), 214 in total:
  - Timeline: `ui/timeline/CompactTimeline.tsx` 140,234,279(LA day ticks),343,344,359,395,452,464,476,504,509,524,558;
    `ui/Timeline.tsx` 76,77,102,244(laWallTicks),292,355,356,415,428,436.
  - Feed: `ui/feed/feedModel.ts` 400,422/434 (`startOfLaDay` groups passes by LA day),441,442,470,478;
    `ui/feed/UpdatesFeed.tsx` 302-304,348,396,462,607.
  - Cards: `ui/shell/FireCard.tsx` 73,77,81,163 ("Started Oct 16" is an LA date); `location/describe.ts`
    138,300,591,608,681; `location/official.ts` 59; `location/OverviewCard.tsx` 135; `location/CoordinateStrip.tsx` 243,248.
  - Charts: `ui/Charts.tsx` 194 (laWallTicks),270,972; `ui/WeatherCard.tsx` 57,73,75; `ui/AnalysisTab.tsx` 87,171,183,264.
  - Forensic: `scene/fx/Telemetry.tsx` 190; `scene/fx/Ignition.tsx` 179; `scene/overlays/SceneOverlays.tsx` 290;
    `ui/EvidenceTab.tsx` 101,156,177,212,235; `ui/KeyEvents.tsx` 80,132; `ui/NotesTab.tsx` 51,73,122;
    `ui/IncidentOverview.tsx` 96,104; `ui/Header.tsx` 58,155.
  - Official and extras:
    - official: `ui/feed/OfficialNow.tsx` 134,157,176,239,240,322; `official/calfire.ts` 145,148,191,210,223;
      `official/fireWeather.ts` 178-185;
    - extras: `extras/format.ts` 12-14 (year compared in UTC), 63; `extras/evacuation.ts` 304,305,396;
      `extras/imagery.ts` 196,218,248-255,301,303; `extras/cameras.ts` 235,252; `extras/EvacuationPanel.tsx` 147.
  - Shell and map:
    - shell: `ui/shell/dataStatus.ts` 73,74(year via laParts),85,116,122,155,181,198,221; `ui/shell/OverviewPanel.tsx`
      110,146; `ui/shell/officialSummary.ts` 65; `ui/shell/LayersPanel.tsx` 175;
    - map: `map/MapLegend.tsx` 95,96,153,171-175,224; `map/mapController.ts` 1325,1355,1371,1392;
      `map/overlayModel.ts` 263; `map/nearbyPerimeters.ts` 91;
    - other: `lib/plainLanguage.ts` 191,196-198,296; `ui/Overlays.tsx` 109; `ui/IncidentPicker.tsx` 249;
      `ui/Menus.tsx` 340 ("Times: America/Los_Angeles").
  - Dev only: `extras/dev/DevApp.tsx` 305,306,334, `extras/dev/presets.ts:59-71`, `scene/dev`, `scene/fx/dev`.
- Times without a zone label: the phone peek "CAL FIRE, updated 13:19" (`OverviewPanel.tsx:146`); every date-only
  `fmtDate` (card start and containment dates, picker, nearby perimeter labels).
- The backend also sends text with Pacific time baked in. For example `build/observed.py:89, :200` writes "Jan 07,
  18:18 PST" into event text, and `spread/ensemble.py:70`, `spread/behavior.py:32` and `sources/overpass.py:50` use
  `LA_TZ`. The web app cannot reformat these strings (cross-ref the backend audit).

### 1.3 Search
- `location/search.ts`:
  - `STATE_WORDS` contains only `ca, calif, california, usa, us` (`:57`), so "83702 ID" is not read as a ZIP code;
  - the messages "a California town" (`:102`) and "No California town or ZIP code matches" (`:187, :191`);
  - `likelyMissingWestSign` uses a California box (`:109-111`).
- `location/SearchBox.tsx`: "far from California" (`:180`), "Searching California towns and ZIP codes…" (`:236`), the help text
  (`:380`). `location/geocodeClient.ts:37` says the same.
- Backend: the town and ZIP index is `backend/fire3d/data/gazetteer_ca.json`, with California only. The answers say
  "No California city, town or census-designated place matches" (Boise) and "not a California ZIP area … Fire-3d covers
  California only" (83702) (`audit3-web-search-*.png`). Street addresses use the Census geocoder, which is already national.
- Incident search (`searchIncidents :62-90`) matches the name, county, location, unit, id and year, but not the state.

### 1.4 Official UI (evacuations: see E-G1 to E-G4; the rest is here)
- `official/model.ts`: `insideCalifornia :166-168` gates the evacuation point query (`:160`). It also gates the NWS
  statewide answer (`:393`) and the NWS state at a point (`:425`: "Fire-3d checks NWS fire weather alerts in
  California only.").
- The location card lists fire weather only while an alert is in effect (`location/official.ts:150`), so outside
  California the NWS "not checked" state is **silent**. The card still links "Cal OES" at a point in Idaho (`:154`;
  `audit3-web-location-boise-*.png`).
- On the overview, OfficialNow is "OFFICIAL NOW · California": "No Red Flag Warning or Fire Weather Watch in effect in
  California" (`ui/feed/OfficialNow.tsx:283, :310, :364, :369`), from `fireWeatherStatewideUrl()` (`official/client.ts:17`),
  which is `area=CA` in the backend (`nws.py:445`).
- Cameras are California-only by source (ALERTCalifornia and Caltrans via "Cal OES California Webcams":
  `extras/cameras.ts:212-236`, `extras/CameraPanel.tsx:52, :111`, `extras/credits.ts:23-25`). Outside California the panel
  would say "No public cameras are listed in this area." (`CameraPanel.tsx:58`), which reads as if there are none.

### 1.5 Fire record, picker, URLs, legends, credits
- CAL FIRE is the only issuer:
  - `official/calfire.ts:14-17` (`CALFIRE_ISSUER`, `CALFIRE_SOURCE`, fire.ca.gov fallback link);
  - the fire card "CAL FIRE incident record" (`ui/shell/FireCard.tsx:50-92, :145`);
  - the list source line and empty states (`OverviewPanel.tsx:35-37, :106-146, :204-220`);
  - the hover "CAL FIRE (official)" (`mapController.ts:1324, :1382`);
  - the legend "Fires (CAL FIRE, official)" (`map/MapLegend.tsx:137, :140`);
  - the data status rows (`ui/shell/dataStatus.ts:196-205`), the feed (`ui/feed/feedMeta.ts:22`, `UpdatesFeed.tsx:69, :77, :382`).
- The picker (`ui/IncidentPicker.tsx:34, :198-265`) and the Forensic empty state (`ui/shell/ForensicWorkspace.tsx:91`)
  also name CAL FIRE.
- The ID chip says "CAL FIRE incident UID" (`MapHeader.tsx:86`, `IncidentOverview.tsx:87`). `IncidentSummary.calfire_uid`
  is required (`api/types.ts:14`). SPEC §4.4 builds incident ids from it.
- URLs carry only `?incident=<id>` plus workspace keys (`state/history.ts:28`, `state/workspace.ts:188-209`). The ids of
  prepared California fires (e.g. `2025-eaton-fire-dbfa57`) must keep resolving. A 404 falls back to the overview with
  `MissingFireNotice`.
- Credits: `lib/dataCredits.ts:51` (CAL FIRE → fire.ca.gov). There is no credit for a national fire source.
- `ui/Menus.tsx:331-334` "Active (CA)" and `detections_24h_ca` (`api/types.ts:355`).

### 1.6 Alaska and Hawaii
Nothing marks them. No list row comes from there today. A point in Alaska would get the California wording above
(Cal OES, "California only"). An Alaska fire link would get the generic "could not find" notice.

### 1.7 Reprojection
- `lib/reproject.ts` and `lib/geo.ts` use the Krüger series for any northern UTM zone. The zone comes from
  `manifest.grid.utm_zone`.
- `lib/reproject.test.ts:44-83` tests only EPSG:32610/32611: fixture-demo, fixture-live, Eaton, Cooley, Madre (an AOI
  across 120° W) and Camino.
- `CoordinateStrip.tsx:195` shows any selected point in the fire's zone ("UTM 11N"), even when the point lies in
  another zone.

### 1.8 California-specific strings (non-test `web/src`; grep `California|CAL FIRE|Cal OES|Pacific|Los_Angeles|PDT|PST|PT`)

| Term | Code / visible | Comments | Fixtures / dev | Files |
|---|---|---|---|---|
| California | 36 | 52 | 16 | 38 |
| CAL FIRE | 89 | 87 | 16 | 48 |
| Cal OES | 35 | 37 | 16 | 19 |
| Pacific / America/Los_Angeles / PDT·PST·PT | 3 | 34 | 18 | 21 |
| `CA` as a state code | 3 (`Menus.tsx:331`, `search.ts:57`, `addressStore.ts:42`) | 3 | – | 5 |

Code lines by component (file: lines):
- **ui (78)**:
  - `shell/OverviewPanel.tsx` 35-37,106,118,119,137-139,146,204,208,219,220,254,267,280,296,297;
  - `feed/OfficialNow.tsx` 71,95,102,134,157,158,171,176,188,201,239,283,310,364,369;
  - `shell/dataStatus.ts` 142,148,155,160,196,200,204,205; `shell/FireCard.tsx` 50,53,73,77,87,92,145;
  - `IncidentPicker.tsx` 34,198,207,220,222,265; `shell/MapHeader.tsx` 86,139,185,189;
    `IncidentOverview.tsx` 77,78,87,121; `Overlays.tsx` 36,155,200;
  - `feed/UpdatesFeed.tsx` 69,77,382; `shell/LayersPanel.tsx` 45,251; `shell/officialSummary.ts` 28,57;
    `feed/feedMeta.ts` 22; `feed/feedModel.ts` 124; `EvidenceTab.tsx` 195; `shell/ForensicWorkspace.tsx` 91;
    `Menus.tsx` 331,340.
- **official (26)**: `calfire.ts` 14,15,17,68,103,105,148,162,168,170,183,190,191,198,208,216,217,223,235;
  `model.ts` 160,166,209,213,360,393,425.
- **location (21)**: `official.ts` 73,76,79,98,105,153,154,177; `OverviewCard.tsx` 111,120,122,135; `search.ts` 102,187,191;
  `SearchBox.tsx` 180,236,380; `CoordinateStrip.tsx` 196,220; `geocodeClient.ts` 37.
- **extras (17)**: `evacuation.ts` 263,305,396,409,410; `cameras.ts` 212,225,235,236; `credits.ts` 17,23,25;
  `CameraPanel.tsx` 52,54,111; `EvacuationPanel.tsx` 43,45.
- **map (9)**: `mapController.ts` 1324,1330,1343,1382; `MapControls.tsx` 107,108,164; `MapLegend.tsx` 137,140.
- **lib (5)**: `time.ts` 4,56; `plainLanguage.ts` 377,378; `dataCredits.ts` 51.
- **app, state, scene (4)**: `App.tsx` 277,351; `state/overview.ts` 17; `scene/fx/Telemetry.tsx` 187.
- **Tests**: 163 lines in 19 test files (top: `official/calfire.test.ts` 29, `location/official.test.ts` 20); 62 PDT/PST
  strings in 12 test files.

## 2. Gaps

| # | Grade | Gap | Evidence |
|---|---|---|---|
| G1 | **BLOCKER** | Every time is Pacific, and no data carries a zone. Swapping `TZ` breaks the ticks (`laWallToMs` tries only −7/−8 h). Example: a fire found at 00:30 EDT on Oct 17 shows "Started Oct 16" and "21:30 PDT" | `lib/time.ts:4, :184-196`; 214 call sites (1.2); `api/types.ts:9-33`; SPEC §4.2:140 |
| G2 | **BLOCKER** | Overview framed and named for California | 1.1 (`framing.ts:22`, `mapController.ts:89`, `MapHeader.tsx:185`); `audit3-web-overview-*.png` |
| G3 | **BLOCKER** | No clustering or zoom-aware decluttering for about 1,200 markers a year | `overviewLayers.ts:62-114, :283-301`; `audit3-web-national-1178-phone.png` (one blob), `-desktop.png` (about 40 labels) |
| G4 | **BLOCKER** | The fire record is hard-wired to CAL FIRE (issuer, link, legend, hover, card, list, credits, ID) | 1.5; 89 code lines |
| G5 | **BLOCKER** | Official panels outside California: evacuations (E-G1, E-G2); NWS "California only" and silent on the card; a "Cal OES" link at an Idaho point; "Official now · California" | `model.ts:393, :425`; `location/official.ts:150, :154`; `audit3-web-location-boise-*.png` |
| G6 | INCOMPLETE | Search covers California towns and ZIP codes only; "Town, ST" is not parsed | 1.3; `audit3-web-search-boise-desktop.png`, `-zip-phone.png` |
| G7 | MISSING | No state on rows, cards or hover. "Garfield Co." is ambiguous: Garfield County exists in CO, MT, NE, OK, UT and WA | `OverviewPanel.tsx:43`, `IncidentPicker.tsx:243` |
| G8 | INCOMPLETE | List scale: 1,262 rows rendered at once. One sample in this software-rendered sandbox took 424 ms from setState to the next frame (indicative only; frame rates are not meaningful without a GPU) | `OverviewPanel.tsx:68-97, :168-172`; shot11 log |
| G9 | MISSING | Alaska and Hawaii are not marked "not supported yet"; points outside the US get California wording | 1.6 |
| G10 | INCOMPLETE | Cameras are California-only, and the empty state elsewhere implies there are none | `CameraPanel.tsx:52, :58` |
| G11 | INCOMPLETE | Reprojection tested in UTM 10/11 only; the lower 48 needs 10-19 | `reproject.test.ts:44-83` |
| G12 | INCOMPLETE | Phones (existing bugs that matter more nationally): (a) the map controls row covers the search message; (b) with the list sheet open, the overview refit leaves the fires behind the sheet | `audit3-web-search-zip-phone.png`, `audit3-web-official-overview-phone.png` |
| G13 | INCOMPLETE | Command menu "Active (CA)" and "Times: America/Los_Angeles"; `detections_24h_ca` | `Menus.tsx:331-340` |
| G14 | INCOMPLETE | Backend text with "PST" baked in reaches the feed (e.g. `observed.py:200`) | 1.2; backend audit |
| G15 | INCOMPLETE | Ids use `calfire_uid` (SPEC §4.4). If California rows switch source, old links and bundles break | `api/types.ts:14`; `state/history.ts:28` |

## 3. Recommended changes

### 3.1 One shared time formatter (fixes G1, G13; supports E-R5)
- **Module**: `lib/time.ts`. It has no zone constant; every function takes an IANA zone (`tz`).
  - `fmtAt(ms, tz, { date: 'auto'|'always'|'never', year: 'auto'|'always', refMs, clock: '24h'|'12h' })` gives
    "Oct 22, 15:40 MDT" (or "3:40 PM MDT": Q1). The year is compared in `tz`, not UTC (`extras/format.ts:13`).
  - `zoneAbbr(ms, tz)` uses Intl `timeZoneName: 'short'` in en-US. Checked in Node's ICU for July and January:
    - Los_Angeles PDT/PST, Boise and Denver MDT/MST, Phoenix MST all year;
    - Chicago, Indiana/Knox, North_Dakota/Center and Menominee CDT/CST;
    - Detroit, Kentucky/Louisville and New_York EDT/EST.
    - Fallback: "UTC−7".
  - `zoneName(tz)` gives "Mountain Time" (Intl `longGeneric`).
  - `wallParts`, `startOfDay`, `wallTicks` and `dayTicks` take `tz`. `wallToMs(y, mo, d, h, mi, tz)` finds the offset in
    two passes (no 420/480 constants; DST gaps resolve forward, as now).
- **Required parameter**: `tz` is required, so `npm run typecheck` lists all 214 call sites. California fires pass
  `America/Los_Angeles`, so every California string and test stays the same. Tests only add the argument.
- **Where the zone comes from**:
  1. A fire's own times use the fire's zone, everywhere: timeline, feed, charts, card, official items about the fire,
     scene labels and notes. `useDisplayTz()` (`state/timeZone.ts`, new) returns
     `manifest.time_zone ?? summary.time_zone`.
  2. Overview rows and the fire card use each row's `time_zone`.
  3. Times about many fires, and Fire-3d's own check times, are relative ("checked 2 min ago"). The absolute time goes
     in a tooltip in the viewer's browser zone, labelled.
  4. A point with no fire uses `time_zone` from the official answer for that point (E-R1's point query); otherwise the
     viewer's zone, labelled.
  5. The fallback is always the viewer's zone, with its abbreviation shown, **never** Pacific.
- **Wording**: one line per panel says which zone is used ("Times: Mountain Time (MDT), the fire's local time"); the
  Command menu shows the same in place of `Menus.tsx:340`. A fire that straddles a zone line uses its reported point's
  zone. A source time without a zone (Florida SERT, E-G8) is shown as given, with "time zone not stated".
- **Backend**: it supplies `time_zone` (section 3.4). How it derives the zone is the backend audit's call. Options: the
  NWS `/points` `timeZone` (public domain, cached once per fire), or a committed table from county FIPS to zone.

### 3.2 National overview: frame, markers, clusters, labels, list (fixes G2, G3, G8)
- **Frame**: `LOWER48_BOUNDS = [-124.85, 24.40, -66.89, 49.38]` replaces `CALIFORNIA_BOUNDS`. The centre is
  [-98.6, 39.8] at about z3 (replaces `mapController.ts:89`).
  - With today's safe area that is about z3.2 on a 1440x900 desktop and about z2.1 on a 390 px phone, where the box is
    limited by its width (`audit3-web-national-1178-*.png`).
  - Wording: "United States · all fires" (tooltip "lower 48 states; Alaska and Hawaii are not supported yet"), and the
    button "All states". Keep the "last overview view" restore. Add no `maxBounds`.
- **Clustering, built into MapLibre 5.24** (`cluster`, `clusterProperties`, `getClusterExpansionZoom`; no new dependency):
  - Two GeoJSON sources:
    - `fx-overview-active`: active fires, `clusterRadius` 28, `clusterMaxZoom` 6, `clusterMinPoints` 3;
    - `fx-overview-other`: contained, out and past fires, `clusterRadius` 40, `clusterMaxZoom` 7, `clusterMinPoints` 3.
  - Each source sums `active`, `ready` and `max_acres` in `clusterProperties`.
  - Cluster bubbles: 12-22 px by log(count), with the count as text. Active clusters are filled orange and drawn above
    the amber hollow clusters, so active fires are never hidden inside amber bubbles (Q2).
  - Hit-testing and pick: `fireAt` returns `{ cluster_id, source }` for a cluster.
  - Hover: "23 fires (contained or out) · largest 642,029 ac · click to zoom in".
  - Cluster click: `getClusterExpansionZoom`, then `easeTo` at **min(expansion, 8)**. 8 stays below `FOCUS_IN_ZOOM` 8.5,
    so a cluster click never zoom-focuses a prepared fire, and the opening framing ends as for any explicit request.
    The list then switches to "in this view" (below).
  - Replay and the open fire: today's layer filters do not change cluster counts, so drop the hidden fires from the
    data before `setData`. That data is keyed on the hidden set, so it is never rebuilt per frame.
- **Markers and labels**: the radius follows zoom (`interpolate` z3 → 0.6×, z7 → 1×). Labels use a zoom `step` in
  `text-field`, since layout properties take zoom:
  - z < 5: active fires of 5,000 ac or more, and any fire of 100,000 ac or more;
  - z 5-7: today's rule;
  - z ≥ 7: every active fire and every fire of 1,000 ac or more.
  - Labels add the state on hover only ("Garnet · 59,844 ac").
- **List**: by default it shows the fires in the current map view ("312 fires in this view · Show all 1,262", Q3). It
  is windowed: a fixed 50 px row height, the visible rows ±10, and no new dependency. The rows say "Garfield Co., CO".
  The filter counts are memoised.
- **Phones**: fix the z-index of the search message over the controls row. Keep the overview fit when the list sheet
  opens (fit only to the visible strip, or do not refit while the sheet is open).

### 3.3 Change list

| # | Change | Value | Effort | Risk | Files | Priority |
|---|---|---|---|---|---|---|
| W1 | Shared formatter (3.1); `tz` at every call site; `useDisplayTz` | The brief's time rule; correct dates and ticks | L | Medium: 43 files. California output identical (tests prove it) | `lib/time.ts`(+test), `state/timeZone.ts` (new), the 43 files of 1.2, SPEC §4.2 | **P0** |
| W2 | Lower-48 frame and wording (3.2) | First view works nationally | S | Low | `map/framing.ts`(+test), `map/mapController.ts`, `map/MapControls.tsx`, `ui/shell/MapHeader.tsx`, `OverviewPanel.tsx`, `App.tsx`, `location/CoordinateStrip.tsx`, `state/history.ts` comments | **P0** |
| W3 | Clusters, zoom-aware markers and labels (3.2) | Readable at about 1,200-3,000 fires | M | Medium: hit-testing, replay data, focus interplay | `map/overviewLayers.ts`(+test), `map/mapController.ts`, `map/MapLegend.tsx` ("Group of N fires") | **P0** |
| W4 | Source-neutral fire record: issuer, link and credit per row (`record_source`, `record_agency`, `record_url`); CAL FIRE wording kept for California rows | Correct credit and issuer outside California | M | Medium: many strings; keep the California snapshots | `official/calfire.ts`, `FireCard.tsx`, `OverviewPanel.tsx`, `IncidentPicker.tsx`, `MapLegend.tsx`, `mapController.ts`, `dataStatus.ts`, `officialSummary.ts`, `feed/*`, `IncidentOverview.tsx`, `MapHeader.tsx`, `lib/dataCredits.ts`, `location/OverviewCard.tsx`, `location/incidents.ts` | **P0** |
| W5 | State everywhere: rows, card, hover, picker, and state names and codes in incident search | Disambiguation | S | Low | `OverviewPanel.tsx`, `IncidentPicker.tsx`, `FireCard.tsx`, `location/search.ts`(+test), `lib/usStates.ts` (new: 48 + DC names and USPS codes) | **P0** |
| W6 | National search: parse "Town, ST" / "ST 83702"; send `state=`; national wording; missing-minus box for the lower 48; Alaska and Hawaii ZIP prefixes (995-999, 967-968) and names answer "not supported yet" | Search works in every state | S-M | Low; the backend owns the national Gazetteer | `location/search.ts`(+test), `SearchBox.tsx`, `geocodeClient.ts`, `location/types.ts` | **P0** |
| W7 | Official outside California: E-R1 and E-R3 states in the UI; NWS fire weather national (`insideCalifornia` → the coverage from the response); "Official now · United States" with "N alerts in M states, the 3 most recent"; the card always says the NWS state ("not checked here" is never silent); links from `sources[]` | No implied checks; "not available in this state" | M | Medium | `official/model.ts`(+test), `official/client.ts`, `ui/feed/OfficialNow.tsx`, `location/official.ts`(+test), `ui/shell/dataStatus.ts`, `ui/shell/officialSummary.ts` | **P0** |
| W8 | List "in this view" + windowing + memoised counts | Fast, relevant list | M | Low | `OverviewPanel.tsx`, `state/overview.ts`(+test), `ui/IncidentPicker.tsx` | P1 |
| W9 | Coverage notices: `coverageAt(lon, lat)` (rough Alaska, Hawaii and lower-48 boxes; the response's `states[]` decides near borders) → "Fire-3d does not support Alaska and Hawaii yet" / "outside the United States: not covered" in the card, search and missing-fire notice | Brief decision 1 | S | Low | `lib/coverage.ts` (new)(+test), `location/OverviewCard.tsx`, `location/official.ts`, `ui/shell/OverviewPanel.tsx` | P1 |
| W10 | Cameras: "Public cameras: California only (ALERTCalifornia, Caltrans). Not available in this state." outside California | Honest empty state | S | Low | `extras/CameraPanel.tsx`, `extras/cameras.ts`, `extras/legend.ts` | P1 |
| W11 | UTM tests for zones 10-19 (3.5) | Overlay alignment everywhere | S | Low | `lib/reproject.test.ts`, `lib/geo` tests | P1 |
| W12 | The two phone layout fixes (G12) | Usable phone search and list | S | Low | `styles/overview.css`, `location/searchUi.ts`, `map/mapController.ts` (`:780` refit) | P1 |
| W13 | Per-region accuracy label in the web (decision 3), at the forecast description, the card's model block and the Analysis drawer, from the backend field the validation audit defines | Honest skill label | S | Low | `lib/plainLanguage.ts`, `location/describe.ts`, `ui/AnalysisTab.tsx`, `ui/timeline/CompactTimeline.tsx` | P1 |
| W14 | Clean-up: about 190 comments, dev presets, "Active (CA)", UTM label "(fire grid zone)" for points in another zone | Accuracy of the code docs | S | Low | the comment lines of 1.8, `ui/Menus.tsx`, `location/CoordinateStrip.tsx` | P2 |

### 3.4 Contract requests (CONTRACT §14, SPEC, `contracts.py`, `api/types.ts`; all additive)
- **`IncidentSummary`**, additive fields:
  - `state` (USPS code), `time_zone` (IANA);
  - `record_source` (`'calfire' | 'wfigs' | …`), `record_agency` (display name), `record_url` (https or null);
  - `uid` (source-neutral). Keep `calfire_uid` as a deprecated alias.
  - Rows from Alaska or Hawaii are not listed (or carry `supported: false`).
- **Manifest**: `time_zone`, `state`.
- **Official and extras answers**: `time_zone` and `states[]` (E-R1).
- **Live status**: `detections_24h` replaces `detections_24h_ca` (keep both for one release).
- **Ids** stay `{year}-{slug}-{uid6}`. Existing California ids and bundles must keep resolving (G15).
- **SPEC §4.2**: "The UI shows each fire's local time with its zone abbreviation".

### 3.5 Reprojection tests to add (W11)
The lower 48 runs from 124.7° W (Cape Alava, WA) to 66.9° W (West Quoddy Head, ME): UTM zones 10-19.

| Zone | Central meridian | States (mostly) | Status |
|---|---|---|---|
| 10 | 123° W | coastal WA, OR, N. CA | tested |
| 11 | 117° W | S. CA, NV west, E. WA and OR, ID panhandle | tested |
| 12 | 111° W | AZ, UT, ID east, MT west | add |
| 13 | 105° W | CO, NM, WY, MT east | add |
| 14 | 99° W | Dakotas, NE, KS, OK, W. and central TX | add |
| 15 | 93° W | MN, IA, MO, AR, LA, E. TX | add |
| 16 | 87° W | WI, IL, IN, TN, AL, MS east, FL panhandle | add |
| 17 | 81° W | MI east, OH, KY east, GA, Carolinas, FL peninsula | add |
| 18 | 75° W | NY, PA, NJ, DE, MD, VA east | add |
| 19 | 69° W | ME, E. MA | add |

Tests:
- For each zone (a parametrised table): synthetic grids at the central meridian and at ±3.4°, at 24.5°, 37° and
  49.4° N. Check the UTM ↔ lon/lat round trip against `lib/geo.ts` (< 1 mm), the true AOI quadrilateral, and the
  per-pixel inverse mapping at the edges and corners (the existing `reproject.test.ts` cases, run per zone).
- AOIs across zone lines, like the Madre 120° W case: 102° W (13/14), 108° W (12/13) and 84° W (16/17).
- Extreme points: Key West 24.55° N 81.8° W (zone 17), Northwest Angle 49.38° N 95.15° W (zone 15) and West Quoddy
  44.82° N 66.95° W (zone 19).
- Add the grids of real out-of-state bundles once stage D builds them (values copied from their manifests, no `data/`).
- Backend test (backend's file): the zone chosen for each of these points is `floor((lon + 180) / 6) + 1`.

## 4. Questions only the user can answer

1. **Q1. Clock style.** (a) Keep the 24-hour clock everywhere ("15:40 MDT"). (b) 12-hour everywhere ("3:40 PM MDT").
   (c) 12-hour in Public, 24-hour in Command and Forensic. **Recommended: (c).** The public reads the 12-hour clock
   (NWS and agencies write it that way); incident command uses the 24-hour clock; one formatter option does both.
2. **Q2. Active fires in clusters.** (a) Active fires group only with other active fires: orange groups that split
   early, never hidden among contained fires. (b) Every fire groups together, and a group shows "N active".
   **Recommended: (a).** Active fires stay visible at a glance.
3. **Q3. National list.** (a) Fires in the current map view, with "Show all" (sorted active first, then size).
   (b) The whole national list, grouped by state. (c) The whole list as today. **Recommended: (a).** It stays short
   and follows the map.
4. **Q4. Opening view on phones.** (a) The whole lower 48 (small, with grouped markers). (b) The region with the most
   active fires right now. **Recommended: (a).** It is predictable and never suggests other regions are quiet.
5. **Q5. Cameras outside California.** (a) Keep California only and say "not available in this state" elsewhere.
   (b) Research other public camera networks and their terms in a later brief. **Recommended: (a) now, (b) later.**

## 5. Evidence log (2026-10-22 UTC)

- Screenshots (swiftshader, each viewed). Files are `docs/screenshots/audit3-web-<name>.png`; `-desktop` is 1440x900
  and `-phone` is 390x844.
  - `overview-desktop`, `overview-phone`: "California · all fires", 2026 season 84, times in PDT. On the phone peek:
    "CAL FIRE, updated 13:19", with no zone.
  - `firecard-desktop`, `firecard-phone`: Norte Fire card, "CAL FIRE incident record", "Started Oct 16, 2026",
    "13:19 PDT".
  - `location-boise-desktop`, `location-boise-phone` (a point at 43.615 N, 116.2 W):
    - "Nearest fires (CAL FIRE)" 273 mi away;
    - "Evacuation zones: not checked here · Cal OES lists evacuation zones in California only";
    - "Follow local officials. Cal OES";
    - "(Oct 22, 14:30 PDT)" in Mountain Time country;
    - no NWS line.
  - `search-boise-desktop` ("Boise, ID": "No California city, town or census-designated place matches") and
    `search-zip-phone` ("83702": the message is hidden under the map controls).
  - `official-eaton-command-desktop` (OFFICIAL NOW: "Evacuations via Cal OES", CAL FIRE record, NWS archived copy,
    PST) and `official-overview-phone` ("OFFICIAL NOW · California"; the fires are pushed behind the sheet).
  - `national-1178-desktop`, `national-1178-phone`: the 1,178 real lower-48 WFIGS points of 2026 (wildfires of 300 ac
    or more) loaded into `useStore.catalog.season` in the browser only, then fitted to the lower 48. The panel lists
    1,262 rows.
- WFIGS (NIFC) count-only and small GETs, descriptive User-Agent, 6 requests. Raw files are in the scratchpad, not `data/`.
  - `WFIGS_Incident_Locations_YearToDate`, `IncidentTypeCategory='WF' AND IncidentSize>=300`: 1,204; without AK, HI
    and CA: 1,109; CA: 69.
  - By state: OK 135, TX 119, FL 105, OR 85, ID 84, WA 73, CA 69, MT 57, NM 53, CO 45 (37 states).
  - `WFIGS_Incident_Locations` 2025 (by discovery date): 984.
- Time zone abbreviations checked with Node 22 Intl (en-US): see 3.1. The example "Oct 17 00:30 EDT = Oct 16 9:30 PM
  PDT" was computed the same way.
- Greps: the term counts in 1.8 come from a classifier over the grep output (comment vs code vs fixture/dev).
  214 time-formatting calls in 43 files (excluding `lib/time.ts` and tests).
- No gates were run: stage A changed no code. No secret was involved; a count-only scan of the server logs for the key
  name found 0.
