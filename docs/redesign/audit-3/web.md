# Audit 3: the web app for the lower 48 states

Role `audit-web-us` (brief 3, stage A). Read-only: no project code changed, no fire built, "Prepare analysis" never
pressed. Servers: API 8712 (`FIRE3D_LIVE=0`), Vite 5182. Browser runs made 105 API requests, all GET (0 non-GET,
counted from the API access log). Evidence is in section 5. Official evacuation data is in
[`evacuations.md`](evacuations.md); this file cross-references it (E-G1 = its gap G1, E-R1 = its change R1).

## 0. Summary

- The web app is California-shaped in five places:
  - the overview frame and wording;
  - the time zone;
  - the fire-record source (CAL FIRE);
  - search (a California Gazetteer);
  - the official panels (Cal OES, and NWS "in California").
- **Time is the deepest assumption.** Every time goes through `lib/time.ts` with `TZ = 'America/Los_Angeles'` (`:4`):
  214 call sites in 43 files. Swapping the constant is not enough. `laWallToMs` hard-codes the PDT/PST offsets
  (`:187-188`), so for any other zone the timeline and chart ticks would land 1-3 h off, and hourly ticks would vanish.
- **Scale.** NIFC WFIGS lists 1,178 wildfires of 300 acres or more in the lower 48 so far in 2026 (984 in 2025).
  - These are count-only queries (section 5).
  - With these 1,178 real points loaded into today's overview, phones show one orange blob and desktops about 40
    colliding labels (`audit3-web-national-1178-*.png`).
  - MapLibre's built-in GeoJSON clustering fixes this with no new dependency.
- No web data type carries a state or a time zone (`api/types.ts:9-33`). The backend must add both (section 3.4).
- 418 non-test lines in `web/src` name California, CAL FIRE, Cal OES, Pacific time or Los Angeles: 160 code or
  user-visible lines, 197 comments, 61 fixture or dev lines (section 1.8).
- Two phone layout bugs show in the evidence: the map controls cover the search message, and opening the list sheet
  pushes the fires off the map (G12).

## 1. What exists today

### 1.1 Overview (map workspace with no fire open)
- **Frame**: `map/framing.ts:22` `CALIFORNIA_BOUNDS = [-124.48, 32.53, -114.13, 42.01]`, the goal at `:138`.
  - The map starts at `CALIFORNIA = [-119.4, 37.2]`, z5 (`map/mapController.ts:89, :237`); fallback `:690`; refit
    `:780`; the "California" button goal `:1011`.
  - There is no `maxBounds`.
- **Wording**:
  - the header "California · all fires" and "Back to the California overview" (`ui/shell/MapHeader.tsx:185, :189`);
  - the "California fires" panel (`MapHeader.tsx:139`, `ui/shell/OverviewPanel.tsx:254, :267`, `App.tsx:351`);
  - "California" and "Show all of California" (`map/MapControls.tsx:107-108, :164`);
  - "Showing all California fires" (`OverviewPanel.tsx:296-297`) and "California overview"
    (`location/CoordinateStrip.tsx:220`).
- **Filters**: `state/overview.ts:9-20` (2026 season, 2025, 300 ac, CAL FIRE tips). The lists come from
  `state/catalog.ts` (`?mode=live`, `?mode=historical&year=…&min_acres=…`).
- **Markers**: `map/overviewLayers.ts`, one source `fx-overview-fires` with one point per fire (`:88-114`).
  - The radius is sqrt(acres), 4-13 px, at every zoom (`:62-67`).
  - Labels: active fires and fires of 20,000 ac or more (`:51, :78-80`), dropped on collision (`:295-297`).
  - Clicks go to the nearest marker centre (`:125-136`). Replay hides fires with layer filters (`:193-202`).
  - **No clustering** (a brief-2 map report known issue).
- **List**: every row is rendered (`OverviewPanel.tsx:68-97`), with no windowing. The counts are recomputed on every
  render (`:168-172`). A row shows only "<County> Co." (`:43`), with no state.

### 1.2 Time handling (every place a time is shown or assumed)
- **Core** (`lib/time.ts`):
  - `TZ` `:4` (SPEC §4.2:140: "The UI displays America/Los_Angeles time");
  - `tzLabel :54` (falls back to "PT"), `laParts :92`, `laOffsetMinutes :113`, `startOfLaDay :120`, `laTicks/laDayTicks :129-153`;
  - **`laWallToMs :184-196` (tries only UTC−7 and −8)**, which `laWallTicks :217` uses.
- **Call sites** (file: lines; 214 calls):
  - Timeline:
    - `ui/timeline/CompactTimeline.tsx` 140,234,279 (LA day ticks),343,344,359,395,452,464,476,504,509,524,558;
    - `ui/Timeline.tsx` 76,77,102,244 (laWallTicks),292,355,356,415,428,436.
  - Feed:
    - `ui/feed/feedModel.ts` 400,422/434 (groups passes by LA day),441,442,470,478;
    - `ui/feed/UpdatesFeed.tsx` 302-304,348,396,462,607.
  - Cards:
    - `ui/shell/FireCard.tsx` 73,77,81,163 ("Started Oct 16" is an LA date);
    - `location/describe.ts` 138,300,591,608,681; `location/official.ts` 59; `location/OverviewCard.tsx` 135;
      `location/CoordinateStrip.tsx` 243,248.
  - Charts and analysis:
    - `ui/Charts.tsx` 194 (laWallTicks),270,972;
    - `ui/WeatherCard.tsx` 57,73,75; `ui/AnalysisTab.tsx` 87,171,183,264.
  - Forensic:
    - `scene/fx/Telemetry.tsx` 190; `scene/fx/Ignition.tsx` 179; `scene/overlays/SceneOverlays.tsx` 290;
    - `ui/EvidenceTab.tsx` 101,156,177,212,235; `ui/KeyEvents.tsx` 80,132; `ui/NotesTab.tsx` 51,73,122;
    - `ui/IncidentOverview.tsx` 96,104; `ui/Header.tsx` 58,155.
  - Official:
    - `ui/feed/OfficialNow.tsx` 134,157,176,239,240,322;
    - `official/calfire.ts` 145,148,191,210,223; `official/fireWeather.ts` 178-185.
  - Extras: `extras/format.ts` 12-14 (the year is compared in UTC),63; `extras/evacuation.ts` 304,305,396;
    `extras/imagery.ts` 196,218,248-255,301,303; `extras/cameras.ts` 235,252; `extras/EvacuationPanel.tsx` 147.
  - Shell:
    - `ui/shell/dataStatus.ts` 73,74,85,116,122,155,181,198,221;
    - `ui/shell/OverviewPanel.tsx` 110,146; `officialSummary.ts` 65; `LayersPanel.tsx` 175.
  - Map: `map/MapLegend.tsx` 95,96,153,171-175,224; `map/mapController.ts` 1325,1355,1371,1392;
    `map/overlayModel.ts` 263; `map/nearbyPerimeters.ts` 91.
  - Other:
    - `lib/plainLanguage.ts` 191,196-198,296; `ui/Overlays.tsx` 109; `ui/IncidentPicker.tsx` 249;
    - `ui/Menus.tsx` 340 ("Times: America/Los_Angeles").
  - Dev: `extras/dev/DevApp.tsx`, `extras/dev/presets.ts:59-71`, `scene/dev`, `scene/fx/dev`.
- **No zone label**: the phone peek "CAL FIRE, updated 13:19" (`OverviewPanel.tsx:146`), and every date-only `fmtDate`
  (start and containment dates, picker, perimeter labels).
- **Backend text with Pacific time baked in** reaches the UI (`build/observed.py:89, :200` "Jan 07, 18:18 PST"). The
  backend also uses `LA_TZ` in `spread/ensemble.py:70`, `spread/behavior.py:32` and `sources/overpass.py:50`
  (backend audit).

### 1.3 Search
- `location/search.ts`:
  - `STATE_WORDS` is only `ca, calif, california, usa, us` (`:57`), so "83702 ID" is not read as a ZIP code;
  - "a California town" (`:102`), "No California town or ZIP code matches" (`:187, :191`);
  - a California box in `likelyMissingWestSign` (`:109-111`).
- More California wording: `SearchBox.tsx:180` ("far from California"), `:236`, `:380`; `geocodeClient.ts:37`.
- The backend index `backend/fire3d/data/gazetteer_ca.json` covers California only, and says so:
  - "Boise, ID": "No California city, town or census-designated place matches";
  - "83702": "not a California ZIP area … Fire-3d covers California only".
- Street addresses go to the Census geocoder, which is already national.
- Incident search (`searchIncidents :62-90`) matches name, county, location, unit, id and year, but not the state.

### 1.4 Official UI (evacuations: E-G1 to E-G4; the rest here)
- `official/model.ts` `insideCalifornia :166-168` gates three things:
  - the evacuation point query (`:160`);
  - the statewide NWS answer (`:393`);
  - the NWS state at a point (`:425`: "Fire-3d checks NWS fire weather alerts in California only.").
- The location card lists fire weather only while an alert is in effect (`location/official.ts:150`). Outside
  California, "not checked" is therefore **silent**. The card still links "Cal OES" at an Idaho point (`:154`).
- On the overview, "OFFICIAL NOW · California" says "No Red Flag Warning or Fire Weather Watch in effect in California"
  (`ui/feed/OfficialNow.tsx:283, :310, :364, :369`). The data comes from `fireWeatherStatewideUrl()`
  (`official/client.ts:17`; backend `nws.py:445` `area=CA`).
- Cameras: ALERTCalifornia and Caltrans via "Cal OES California Webcams" (`extras/cameras.ts:212-236`,
  `CameraPanel.tsx:52, :111`, `extras/credits.ts:23-25`). Elsewhere the panel says "No public cameras are listed in
  this area." (`CameraPanel.tsx:58`): it reads as if there are none.

### 1.5 Fire record, picker, URLs, legends, credits
- **CAL FIRE is the only issuer**:
  - `official/calfire.ts:14-17` (`CALFIRE_ISSUER`, `CALFIRE_SOURCE`, a fire.ca.gov fallback link);
  - the fire card `FireCard.tsx:50-92, :145`; the list `OverviewPanel.tsx:35-37, :106-146, :204-220`;
  - the hover `mapController.ts:1324, :1382`; the legend `map/MapLegend.tsx:137, :140`;
  - the data status `dataStatus.ts:196-205`; the feed `feedMeta.ts:22`, `UpdatesFeed.tsx:69, :77, :382`;
  - the picker `IncidentPicker.tsx:34, :198-265` and `ForensicWorkspace.tsx:91`.
- **IDs**: the chip says "CAL FIRE incident UID" (`MapHeader.tsx:86`, `IncidentOverview.tsx:87`).
  `IncidentSummary.calfire_uid` is required (`api/types.ts:14`), and ids derive from it (SPEC §4.4).
- **URLs** carry only `?incident=<id>` and workspace keys (`state/history.ts:28`, `state/workspace.ts:188-209`). An
  unknown id falls back to the overview (`MissingFireNotice`).
- **Credits**: CAL FIRE only (`lib/dataCredits.ts:51`); there is no national fire-source credit.
- **Command menu**: "Active (CA)" and `detections_24h_ca` (`ui/Menus.tsx:331-334`, `api/types.ts:355`).

### 1.6 Alaska and Hawaii; 1.7 Reprojection
- **Alaska and Hawaii**: nothing marks them. A point there gets the California wording above. A link to a fire there
  gets the generic "could not find" notice.
- **Reprojection**: `lib/reproject.ts` and `lib/geo.ts` (Krüger series) work in any northern UTM zone, taken from
  `manifest.grid.utm_zone`. But `lib/reproject.test.ts:44-83` covers only EPSG:32610/32611 (fixtures, Eaton, Cooley,
  Madre across 120° W, Camino). `CoordinateStrip.tsx:195` shows any point in the fire's zone.

### 1.8 California-specific strings (non-test `web/src`)
Grep: `California|CAL FIRE|Cal OES|Pacific|Los_Angeles|PDT|PST|PT`. Totals: 418 lines = 160 code or visible lines,
197 comments, 61 fixture or dev lines.

| Term (line hits) | Code / visible | Comments | Fixtures / dev | Files |
|---|---|---|---|---|
| California | 36 | 52 | 16 | 38 |
| CAL FIRE | 89 | 87 | 16 | 48 |
| Cal OES (E-G4) | 35 | 37 | 16 | 19 |
| Pacific / America/Los_Angeles / PDT·PST·PT | 3 | 34 | 18 | 21 |
| `CA` as a state code | 3: `Menus.tsx:331`, `search.ts:57`, `addressStore.ts:42` | 3 | – | 5 |

Code lines by component:
- **ui (78)**:
  - `shell/OverviewPanel.tsx` 35-37,106,118,119,137-139,146,204,208,219,220,254,267,280,296,297;
  - `feed/OfficialNow.tsx` 71,95,102,134,157,158,171,176,188,201,239,283,310,364,369;
  - `shell/dataStatus.ts` 142,148,155,160,196,200,204,205; `shell/FireCard.tsx` 50,53,73,77,87,92,145;
  - `IncidentPicker.tsx` 34,198,207,220,222,265; `shell/MapHeader.tsx` 86,139,185,189;
  - `IncidentOverview.tsx` 77,78,87,121; `Overlays.tsx` 36,155,200; `feed/UpdatesFeed.tsx` 69,77,382;
  - `shell/LayersPanel.tsx` 45,251; `shell/officialSummary.ts` 28,57; `feed/feedMeta.ts` 22; `feed/feedModel.ts` 124;
    `EvidenceTab.tsx` 195; `shell/ForensicWorkspace.tsx` 91; `Menus.tsx` 331,340.
- **official (26)**:
  - `calfire.ts` 14,15,17,68,103,105,148,162,168,170,183,190,191,198,208,216,217,223,235;
  - `model.ts` 160,166,209,213,360,393,425.
- **location (21)**:
  - `official.ts` 73,76,79,98,105,153,154,177; `OverviewCard.tsx` 111,120,122,135;
  - `search.ts` 102,187,191; `SearchBox.tsx` 180,236,380; `CoordinateStrip.tsx` 196,220; `geocodeClient.ts` 37.
- **extras (17)**:
  - `evacuation.ts` 263,305,396,409,410; `cameras.ts` 212,225,235,236; `credits.ts` 17,23,25;
  - `CameraPanel.tsx` 52,54,111; `EvacuationPanel.tsx` 43,45.
- **map (9)**: `mapController.ts` 1324,1330,1343,1382; `MapControls.tsx` 107,108,164; `MapLegend.tsx` 137,140.
- **lib (5)**: `time.ts` 4,56; `plainLanguage.ts` 377,378; `dataCredits.ts` 51.
- **other (4)**: `App.tsx` 277,351; `state/overview.ts` 17; `scene/fx/Telemetry.tsx` 187.
- **Tests**: 163 lines in 19 files (top: `official/calfire.test.ts` 29, `location/official.test.ts` 20); 62 PDT/PST
  strings in 12 files.

## 2. Gaps

| # | Grade | Gap | Evidence |
|---|---|---|---|
| G1 | **BLOCKER** | Every time is Pacific, and no data carries a zone. Swapping `TZ` breaks the ticks. Example: a fire found at 00:30 EDT on Oct 17 shows "Started Oct 16" and "21:30 PDT" | `lib/time.ts:4, :184-196`; 1.2; `api/types.ts:9-33` |
| G2 | **BLOCKER** | The overview is framed and named for California | 1.1; `audit3-web-overview-*.png` |
| G3 | **BLOCKER** | No clustering or zoom-aware decluttering for about 1,200 markers a year | `overviewLayers.ts:62-114, :283-301`; `audit3-web-national-1178-phone.png` (one blob), `-desktop.png` |
| G4 | **BLOCKER** | The fire record is hard-wired to CAL FIRE: issuer, link, legend, hover, card, list, credits, ID | 1.5 (89 code lines) |
| G5 | **BLOCKER** | Official panels outside California: evacuations (E-G1, E-G2); NWS "California only" and silent on the card; a "Cal OES" link at an Idaho point; "Official now · California" | `model.ts:393, :425`; `location/official.ts:150, :154`; `audit3-web-location-boise-*.png` |
| G6 | INCOMPLETE | Search covers California towns and ZIP codes only; "Town, ST" is not parsed | 1.3; `audit3-web-search-boise-desktop.png`, `-zip-phone.png` |
| G7 | MISSING | No state on rows, cards or hover. "Garfield Co." could be in CO, MT, NE, OK, UT or WA | `OverviewPanel.tsx:43`, `IncidentPicker.tsx:243` |
| G8 | INCOMPLETE | The list renders all 1,262 rows. One sample in this software-rendered sandbox took 424 ms from setState to the next frame (indicative only; frame rates are not meaningful without a GPU) | `OverviewPanel.tsx:68-97, :168-172` |
| G9 | MISSING | Nothing marks Alaska and Hawaii "not supported yet"; points outside the US get California wording | 1.6 |
| G10 | INCOMPLETE | Cameras are California-only, and the empty state elsewhere implies there are none | `CameraPanel.tsx:52, :58` |
| G11 | INCOMPLETE | Reprojection is tested in UTM 10/11 only; the lower 48 needs 10-19 | `reproject.test.ts:44-83` |
| G12 | INCOMPLETE | Phones: (a) the map controls row covers the search message; (b) with the list sheet open, the refit hides the fires behind the sheet | `audit3-web-search-zip-phone.png`, `audit3-web-official-overview-phone.png` |
| G13 | INCOMPLETE | "Active (CA)", "Times: America/Los_Angeles", `detections_24h_ca` | `Menus.tsx:331-340` |
| G14 | INCOMPLETE | Backend text with "PST" baked in reaches the feed | `observed.py:200` (backend audit) |
| G15 | INCOMPLETE | Ids use `calfire_uid` (SPEC §4.4). If California rows change source, old links and bundles break | `api/types.ts:14`, `state/history.ts:28` |

## 3. Recommended changes

### 3.1 One shared time formatter (fixes G1 and G13; supports E-R5)
- **`lib/time.ts` has no zone constant; every function takes an IANA zone `tz`:**
  - `fmtAt(ms, tz, { date, year, refMs, clock: '24h'|'12h' })` → "Oct 22, 15:40 MDT" or "3:40 PM MDT" (Q1). The year
    is compared in `tz`, not UTC (`extras/format.ts:13`).
  - `zoneAbbr(ms, tz)`: Intl `timeZoneName: 'short'`, en-US. Checked in Node ICU:
    - PDT/PST; MDT/MST (Boise, Denver); MST all year (Phoenix);
    - CDT/CST (Chicago, Indiana/Knox, North_Dakota/Center, Menominee);
    - EDT/EST (Detroit, Kentucky/Louisville, New_York);
    - fallback "UTC−7".
  - `zoneName(tz)` → "Mountain Time" (`longGeneric`, checked).
  - `wallParts`, `startOfDay`, `wallTicks`, `dayTicks` take the zone. `wallToMs(…, tz)` finds the offset in two
    passes: no 420/480 constants; DST gaps resolve forward as now.
- **The `tz` parameter is required**, so `npm run typecheck` finds all 214 call sites. California fires pass
  `America/Los_Angeles`, so every California string and test stays identical; tests only add the argument.
- **Where the zone comes from**:
  1. A fire's own times (timeline, feed, charts, card, its official items, scene labels, notes): the fire's zone.
     `useDisplayTz()` (`state/timeZone.ts`, new) returns `manifest.time_zone ?? summary.time_zone`.
  2. Overview rows and fire cards: each row's own `time_zone`.
  3. Times about many fires, and Fire-3d's own check times: relative ("checked 2 min ago"). The absolute time goes in
     a tooltip, in the viewer's browser zone, labelled.
  4. A point with no fire: the `time_zone` of the official answer for that point (E-R1), else the viewer's zone,
     labelled.
  5. The fallback is always the viewer's zone, with its abbreviation shown: **never** Pacific.
- **Wording**:
  - One line per panel: "Times: Mountain Time (MDT), the fire's local time". The Command menu shows the same instead
    of `Menus.tsx:340`.
  - A fire that straddles a zone line uses its reported point's zone.
  - A source time without a zone (Florida, E-G8) is shown as given, with "time zone not stated".
- **The backend supplies `time_zone`** (3.4). Options for it (the backend audit decides): the NWS `/points`
  `timeZone` (public domain, cached once per fire) or a committed county-FIPS → IANA table.

### 3.2 National overview: frame, clusters, labels, list (fixes G2, G3, G8)
- **Frame**:
  - `LOWER48_BOUNDS = [-124.85, 24.40, -66.89, 49.38]` replaces `CALIFORNIA_BOUNDS`. The start view is
    [-98.6, 39.8] at about z3.
  - That fits at about z3.2 on a 1440x900 desktop and about z2.1 on a 390 px phone, limited by the width.
  - Header "United States · all fires" (tooltip "lower 48 states; Alaska and Hawaii are not supported yet"), and the
    button "All states". Keep the last-view restore, and add no `maxBounds`.
- **Clusters** (built into MapLibre 5.24: `cluster`, `clusterProperties`, `getClusterExpansionZoom`; no new
  dependency):
  - Two GeoJSON sources:
    - `fx-overview-active`: `clusterRadius` 28, `clusterMaxZoom` 6, `clusterMinPoints` 3;
    - `fx-overview-other`: radius 40, max zoom 7, min points 3.
  - `clusterProperties` sums `active` and `ready` and keeps `max_acres`.
  - The bubbles are 12-22 px by log(count) and show the count. Active groups are orange and drawn on top, never mixed
    with contained fires (Q2).
  - Hover: "23 fires (contained or out) · largest 642,029 ac · click to zoom in".
  - Click: `getClusterExpansionZoom` → `easeTo` at **min(expansion, 8)**. 8 stays below `FOCUS_IN_ZOOM` 8.5, so a
    cluster click never zoom-focuses a prepared fire. It is an explicit request (it ends the opening framing), and the
    list switches to "in this view".
  - `fireAt` returns `{ cluster_id, source }` for clusters.
  - Replay and the open fire: today's layer filters do not change cluster counts. Drop hidden fires from the data
    before `setData`, keyed on the hidden set (never per frame).
- **Markers and labels**:
  - The radius follows zoom (`interpolate` z3 → 0.6×, z7 → 1×).
  - Labels use a zoom `step` in `text-field`:
    - z < 5: active fires of 5,000 ac or more, and any fire of 100,000 ac or more;
    - z 5-7: today's rule;
    - z ≥ 7: every active fire and every fire of 1,000 ac or more.
- **List**: "312 fires in this view · Show all 1,262" by default (Q3).
  - It is windowed: 50 px rows, the visible rows ±10.
  - Rows say "Garfield Co., CO", and the counts are memoised.
- **Phones**: the search message goes above the controls row (z-index). Do not refit the overview into the strip
  above an open sheet.

### 3.3 Change list

| # | Change | Value | Effort | Risk | Files | Prio |
|---|---|---|---|---|---|---|
| W1 | Shared formatter (3.1), `tz` at every call site, `useDisplayTz` | Brief time rule; correct dates and ticks | L | Medium: 43 files; California output identical (tests prove it) | `lib/time.ts`(+test), `state/timeZone.ts` (new), the files of 1.2, SPEC §4.2 | **P0** |
| W2 | Lower-48 frame and wording (3.2) | National first view | S | Low | `map/framing.ts`(+test), `map/mapController.ts`, `map/MapControls.tsx`, `ui/shell/MapHeader.tsx`, `OverviewPanel.tsx`, `App.tsx`, `location/CoordinateStrip.tsx` | **P0** |
| W3 | Clusters and zoom-aware markers and labels (3.2) | Readable at about 1,200-3,000 fires | M | Medium: hit-testing, replay data, focus | `map/overviewLayers.ts`(+test), `map/mapController.ts`, `map/MapLegend.tsx` ("Group of N fires") | **P0** |
| W4 | Source-neutral fire record: issuer, link and credit per row (`record_source`, `record_agency`, `record_url`); California rows keep the CAL FIRE wording | Correct issuer and credit | M | Medium: many strings; keep the California snapshots | `official/calfire.ts`, `FireCard.tsx`, `OverviewPanel.tsx`, `IncidentPicker.tsx`, `MapLegend.tsx`, `mapController.ts`, `dataStatus.ts`, `officialSummary.ts`, `feed/*`, `IncidentOverview.tsx`, `MapHeader.tsx`, `lib/dataCredits.ts`, `location/OverviewCard.tsx`, `location/incidents.ts` | **P0** |
| W5 | State on rows, card, hover and picker; state names and codes in incident search | Disambiguation | S | Low | `OverviewPanel.tsx`, `IncidentPicker.tsx`, `FireCard.tsx`, `location/search.ts`(+test), `lib/usStates.ts` (new, 48 + DC) | **P0** |
| W6 | National search: parse "Town, ST" and "ST 83702", send `state=`, national wording; a lower-48 box for the missing minus sign; Alaska/Hawaii ZIP prefixes 995-999 and 967-968 and their names → "not supported yet" | Search in every state | S-M | Low (the backend owns the national Gazetteer) | `location/search.ts`(+test), `SearchBox.tsx`, `geocodeClient.ts`, `location/types.ts` | **P0** |
| W7 | Official outside California. E-R1/R3 states in the UI; national NWS (coverage from the response, not `insideCalifornia`); "Official now · United States: N alerts in M states, 3 most recent"; the card always states the NWS state; links from `sources[]` | No implied checks; "not available in this state" | M | Medium | `official/model.ts`(+test), `official/client.ts`, `ui/feed/OfficialNow.tsx`, `location/official.ts`(+test), `dataStatus.ts`, `officialSummary.ts` | **P0** |
| W8 | List "in this view", windowing, memoised counts | Fast, relevant list | M | Low | `OverviewPanel.tsx`, `state/overview.ts`(+test), `IncidentPicker.tsx` | P1 |
| W9 | `coverageAt(lon, lat)`: rough Alaska, Hawaii and lower-48 boxes; the response's `states[]` decides near borders → "Fire-3d does not support Alaska and Hawaii yet" / "outside the United States: not covered" | Brief decision 1 | S | Low | `lib/coverage.ts` (new)(+test), `location/OverviewCard.tsx`, `location/official.ts`, `OverviewPanel.tsx` | P1 |
| W10 | Cameras outside California: "Public cameras: California only (ALERTCalifornia, Caltrans). Not available in this state." | Honest empty state | S | Low | `extras/CameraPanel.tsx`, `extras/cameras.ts`, `extras/legend.ts` | P1 |
| W11 | UTM tests for zones 10-19 (3.5) | Overlays align everywhere | S | Low | `lib/reproject.test.ts` | P1 |
| W12 | Phone fixes (G12) | Usable phone search and list | S | Low | `styles/overview.css`, `location/searchUi.ts`, `map/mapController.ts:780` | P1 |
| W13 | Per-region accuracy label (decision 3) in the forecast text, the card's model block and the Analysis drawer, from the field the validation audit defines | Honest skill label | S | Low | `lib/plainLanguage.ts`, `location/describe.ts`, `ui/AnalysisTab.tsx`, `ui/timeline/CompactTimeline.tsx` | P1 |
| W14 | Clean-up: 197 comment lines, dev presets, "Active (CA)", the UTM label "(fire grid zone)" | Accurate code docs | S | Low | 1.8 comment lines, `ui/Menus.tsx`, `location/CoordinateStrip.tsx` | P2 |

### 3.4 Contract requests (CONTRACT §14, SPEC, `contracts.py`, `api/types.ts`; all additive)
- `IncidentSummary`:
  - `state` (USPS code) and `time_zone` (IANA);
  - `record_source` (`'calfire' | 'wfigs' | …`), `record_agency` (display name), `record_url` (https or null);
  - `uid` (source-neutral), keeping `calfire_uid` as a deprecated alias;
  - no Alaska or Hawaii rows (or `supported: false` on them).
- Manifest: `time_zone` and `state`. Official and extras answers: `time_zone` and `states[]` (E-R1).
- Live status: `detections_24h` replaces `detections_24h_ca`; keep both for one release.
- Ids stay `{year}-{slug}-{uid6}`, and today's California ids and bundles keep resolving (G15).
- SPEC §4.2 becomes: "The UI shows each fire's local time with its zone abbreviation".

### 3.5 Reprojection tests to add (W11)
The lower 48 runs from 124.7° W (Cape Alava, WA) to 66.9° W (West Quoddy Head, ME): UTM zones 10-19.

| Zone | Central meridian | Mostly | Tested |
|---|---|---|---|
| 10 / 11 | 123° W / 117° W | WA, OR, CA, NV west, ID panhandle | yes |
| 12 | 111° W | AZ, UT, ID east, MT west | add |
| 13 | 105° W | CO, NM, WY, MT east | add |
| 14 | 99° W | Dakotas, NE, KS, OK, W. and central TX | add |
| 15 | 93° W | MN, IA, MO, AR, LA, E. TX | add |
| 16 | 87° W | WI, IL, IN, TN, AL, FL panhandle | add |
| 17 | 81° W | MI east, OH, GA, Carolinas, FL peninsula | add |
| 18 / 19 | 75° W / 69° W | NY, PA, NJ, MD, VA east / ME, E. MA | add |

Tests:
- **Per zone** (a parametrised table): grids at the central meridian and at ±3.4°, at 24.5°, 37° and 49.4° N. Check:
  - the UTM ↔ lon/lat round trip against `lib/geo.ts` (< 1 mm);
  - the true AOI quadrilateral;
  - the per-pixel inverse mapping at edges and corners (today's cases, run per zone).
- **Zone-line AOIs**, like the Madre 120° W case: 102° W (13/14), 108° W (12/13), 84° W (16/17).
- **Extreme points**: Key West 24.55° N 81.8° W (zone 17), Northwest Angle 49.38° N 95.15° W (zone 15), West Quoddy
  44.82° N 66.95° W (zone 19).
- **Real bundles**: add the grids of real out-of-state bundles once stage D builds them, with values copied from their
  manifests.
- **Backend test** (in the backend's own files): the chosen zone is `floor((lon + 180) / 6) + 1`.

## 4. Questions only the user can answer

1. **Clock style.** (a) The 24-hour clock everywhere ("15:40 MDT"). (b) 12-hour everywhere ("3:40 PM MDT").
   (c) 12-hour in Public, 24-hour in Command and Forensic. **Recommended: (c)**: the public and NWS use the 12-hour
   clock, incident command uses the 24-hour clock, and one formatter option does both.
2. **Active fires in groups.** (a) Active fires group only with other active fires, never hidden among contained
   ones. (b) Every fire groups together, and each group shows "N active". **Recommended: (a).**
3. **National list.** (a) Fires in the current map view, with "Show all". (b) The whole list, grouped by state.
   (c) The whole list as today. **Recommended: (a)**: short, and it follows the map.
4. **Phone opening view.** (a) The whole lower 48, with grouped markers. (b) The region with the most active fires.
   **Recommended: (a)**: predictable, and it never suggests other regions are quiet.
5. **Cameras outside California.** (a) California only for now, "not available in this state" elsewhere.
   (b) Research other public camera networks and their terms in a later brief. **Recommended: (a) now, (b) later.**

## 5. Evidence log (2026-10-22 UTC)

- **Screenshots** (swiftshader, each viewed): `docs/screenshots/audit3-web-<name>.png`. `-desktop` is 1440x900 and
  `-phone` is 390x844.
  - `overview-*`: "California · all fires", season 84, PDT. The phone peek says "CAL FIRE, updated 13:19", with no zone.
  - `firecard-*`: the Norte Fire, "CAL FIRE incident record", "Started Oct 16, 2026", "13:19 PDT".
  - `location-boise-*` (a point at 43.615° N, 116.2° W):
    - "Nearest fires (CAL FIRE)", 273 mi away;
    - "Evacuation zones: not checked here · Cal OES lists evacuation zones in California only";
    - "Follow local officials. Cal OES"; "(Oct 22, 14:30 PDT)";
    - no NWS line.
  - `search-boise-desktop`: "Boise, ID" → "No California city…". `search-zip-phone`: the "83702" message is hidden
    under the map controls.
  - `official-eaton-command-desktop`: OFFICIAL NOW "Evacuations via Cal OES", the CAL FIRE record, the NWS archived
    copy, PST. `official-overview-phone`: "OFFICIAL NOW · California", with the fires pushed behind the sheet.
  - `national-1178-*`: 1,178 real 2026 lower-48 WFIGS points (wildfires of 300 ac or more), loaded into
    `useStore.catalog.season` in the browser only and fitted to the lower 48. The panel lists 1,262 rows.
- **WFIGS (NIFC)**: 6 GETs (count-only or small), with a descriptive User-Agent. Raw files stayed in the scratchpad,
  not `data/`.
  - `WFIGS_Incident_Locations_YearToDate` `IncidentTypeCategory='WF' AND IncidentSize>=300`: 1,204 in all; 1,109
    without AK, HI and CA; 69 in CA.
  - By state: OK 135, TX 119, FL 105, OR 85, ID 84, WA 73, CA 69, MT 57, NM 53, CO 45 (37 states in all).
  - `WFIGS_Incident_Locations`, 2025 by discovery date: 984.
- **Time zones**: abbreviations checked with Node 22 Intl, en-US (3.1). "Oct 17 00:30 EDT = Oct 16 9:30 PM PDT" was
  computed the same way.
- **Greps**: the term counts in 1.8 come from a comment / code / fixture classifier over the grep output; 214 time
  calls in 43 files (excluding `lib/time.ts` and tests).
- **Gates**: none run, because stage A changed no code. A count-only scan of the server logs for the key name found 0.
