# Audit 3: the web app for the lower 48 states

Role `audit-web-us` (brief 3, stage A), revised after an independent review (section 6). Read-only: no project code
changed, no fire built, "Prepare analysis" never pressed. Servers: API 8712, then 8714 for the revision (both
`FIRE3D_LIVE=0`), Vite 5182, then 5184. Browser runs: 105 + 51 API requests, all GET (0 non-GET). Evidence is in
section 5. Cross-references: [`evacuations.md`](evacuations.md) (E-G1 = its gap G1, E-R1 = its change R1),
[`backend.md`](backend.md) (B-R3, B-I9, B-Q2) and [`validation.md`](validation.md) (V-G6, V-R10, §5 label wording).
The user's round-2 decisions (BRIEF-3, "Decisions round 2") are applied throughout and answer the questions this
audit first asked (section 4).

## 0. Summary

- California-shaped in six places: the overview frame and wording, the time zone, the fire record (CAL FIRE only,
  down to the fetch path), search (California Gazetteer, a lat/lon guess that fails in the East), the official panels
  (Cal OES, NWS "in California") and the imagery labels (GOES-West only).
- **Time is the deepest assumption**: `lib/time.ts:4` `TZ = 'America/Los_Angeles'` feeds 214 call sites in 43 files,
  and `laWallToMs` hard-codes the PDT/PST offsets (`:187-188`), so swapping the constant moves ticks 1-3 h and drops
  hourly ticks in other zones. The user chose a mixed clock (12-hour in Public), so Public strings change even in
  California ("13:19 PDT" becomes "1:19 PM PDT").
- **Scale** (NIFC WFIGS, count-only, 2026-10-22): 2026 wildfires of 300 ac or more in the lower 48: **1,178** in 35
  states. 2025: **861** in 38 states (984 counting Alaska 122 and Hawaii 1). With the 2025 "≥ 100 ac" switch: 1,664.
  **Active now: 244** in the lower 48. 112 of them are 1 ac or less, 43 have no size, and 178 are under 10 ac or have
  no size. Round 2 lists all of them.
- **Today's overview with real active fires** (`audit3-web-national-active-*.png`, 1,334 fires, no duplicates): an
  amber blob, and 42 labels on desktop. 11 of those labels go to fires under 10 ac, because every active fire is
  labelled first (`overviewLayers.ts:78-85`). Only 12 of the 74 fires of 20,000 ac or more get a label.
- **A browser-only prototype** with three MapLibre sources (no new dependency) shows 48 marks instead of 1,334 at the
  national view, and it stays readable at z5.6 (`audit3-web-national-cluster-*.png`). It also exposes two design
  needs. Clusters must be sized by acres, not by count: the "61" bubble of small Upper-Midwest fires (WI, MN and MI
  hold 69 active fires, 1,804 ac in all) is the biggest mark on the map. And per-fire layers (labels, selection ring, chip) need fires that are never clustered.
- **One safety BLOCKER is hidden in the record code.** `official/calfire.ts:89` falls back to the summary whenever
  `calfire_uid` is set. Once that field becomes an alias of `uid` (B-R2), a Montana fire's WFIGS numbers would show
  under "CAL FIRE incident record", which credits the wrong issuer.
- No web type carries a state or a time zone (`api/types.ts:9-33`); the backend adds both (3.7).

## 1. What exists today

### 1.1 Overview (map workspace, no fire open)
- **Frame**: `map/framing.ts:22` `CALIFORNIA_BOUNDS = [-124.48, 32.53, -114.13, 42.01]` (goal `:138`); the map starts at
  `CALIFORNIA = [-119.4, 37.2]` z5 (`map/mapController.ts:89, :237`; fallback `:690`, padding refit `:780`, button goal
  `:1011`). No `maxBounds`. `web/index.html:8`: "wildfire map, forecast and forensics for California".
- **Wording**: "California · all fires" / "Back to the California overview" (`ui/shell/MapHeader.tsx:185, :189`);
  "California fires" (`MapHeader.tsx:139`, `ui/shell/OverviewPanel.tsx:254, :267`, `App.tsx:351`); "California" /
  "Show all of California" (`map/MapControls.tsx:107-108, :164`); "Showing all California fires"
  (`OverviewPanel.tsx:296-297`); "California overview" (`location/CoordinateStrip.tsx:220`); empty states "CAL FIRE
  lists no active fires…" (`OverviewPanel.tsx:35-36`).
- **Lists**: `state/overview.ts:9-20` (2026 season, 2025, 300 ac, CAL FIRE tips). All three lists load at start
  (`App.tsx:68`). The 2025 "≥ 100 ac" switch reloads 2025 at 100 ac (`ui/IncidentPicker.tsx:183`, empty-catalog button
  `ui/Overlays.tsx:157`, tip `state/overview.ts:19`).
- **Markers** (`map/overviewLayers.ts`): one source `fx-overview-fires` (`:23`, one point per fire `:88-114`) feeds
  every layer: casing, past, live, the selection ring (`:261-274`, filter set at `mapController.ts:549-550`), hit,
  label (`:282-300`) and chip (`:305`). sqrt(acres) 4-13 px at every zoom (`:62-67`). Labels go to every active fire
  and every fire of 20,000 ac or more (`:51, :78-80`); `sortKey` ranks any active fire above any other (`:83-85`),
  so a 0-ac active fire wins a label collision against a 90,000-ac contained one. Replay hides fires by layer filter
  (`:193-202`). **No clustering**.
- **List**: every row rendered (`OverviewPanel.tsx:68-97`); arrow/Home/End focus rows with
  `querySelector('[data-row=…]')` (`:74-77`); counts recomputed per render (`:168-172`); rows say "<County> Co." with
  no state (`:43`). The phone peek "N active fires · CAL FIRE, updated 13:19" (`:146`) has no zone.

### 1.2 Time handling
Core: `lib/time.ts`.
- `TZ :4` (SPEC §4.2:140 "The UI displays America/Los_Angeles time"). 24-hour strings only (`:20-40`, "Aug 14, 17:02").
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
| Shell, map, other | `ui/shell/dataStatus.ts` 73,74,85,116,122,155,181,198,221; `OverviewPanel.tsx` 110,146; `officialSummary.ts` 65; `LayersPanel.tsx` 175; `map/MapLegend.tsx` 95,96,153,171-175,224; `map/mapController.ts` 1325,1355,1371,1392; `map/overlayModel.ts` 263; `map/nearbyPerimeters.ts` 91; `ui/Overlays.tsx` 109; `ui/IncidentPicker.tsx` 249; `ui/Menus.tsx` 340 ("Times: America/Los_Angeles"); `ui/DataCredits.tsx` 35 (fire year in UTC) |
| Dev only | `extras/dev/DevApp.tsx` 305,306,334; `extras/dev/presets.ts` 59-71; `scene/dev`, `scene/fx/dev` |

- **UTC years**: `extras/format.ts:13` and `ui/DataCredits.tsx:35` (`getUTCFullYear`, the Copernicus credit year). A
  fire found at 8 PM EST on Dec 31 is in the next year in UTC.
- **No zone shown**: the phone peek (`OverviewPanel.tsx:146`) and every date-only `fmtDate`.
- **Backend text** with Pacific time baked in reaches the UI, e.g. "Jan 07, 18:18 PST" (`build/observed.py:89, :200`);
  backend B-R7 and V-G6 fix it.
- **Tests**: about 47 test lines in 12 files hold 24-hour display times; 62 PDT/PST strings in 12 files.

### 1.3 Search
- `location/search.ts`: `STATE_WORDS` is `ca, calif, california, usa, us` (`:57`), so "83702 ID" is not a ZIP code;
  "a California town" messages (`:102, :187, :191`); `likelyMissingWestSign` tests a California box only
  (`:109-111`). The same wording is in `SearchBox.tsx:180, :236, :380` and `geocodeClient.ts:37`.
- **Lat/lon order guess** (`lib/geodesy.ts:160-165`, documented at `:144-145` "because 118 > 90"): a bare pair is
  swapped only when the first value is over 90. Run on the real parser: "-84.39, 33.75" (Atlanta, pasted lon-first) →
  84.39° S, 33.75° E; "-80.19, 25.76" (Miami) and "-71.06, 42.36" (Boston) are read the same way. "-95.37, 29.76"
  (Houston) works. `SearchBox.tsx:179-181` then says "Showing 84.39° S, 33.75° E." in the **ok** tone and flies there.
  Every lon-first pair east of 90° W fails silently.
- Towns and ZIP codes come from `backend/fire3d/data/gazetteer_ca.json`. "Boise, ID" gets "No California city, town
  or census-designated place matches"; "83702" gets "not a California ZIP area … Fire-3d covers California only".
  Street addresses (Census geocoder) are already national. Incident search (`searchIncidents :62-90`) ignores the state.

### 1.4 Official UI (evacuations: E-G1 to E-G4)
- `official/model.ts` `insideCalifornia :166-168` gates the evacuation point query (`:160`), the overview NWS answer
  (`:393`) and the NWS state at a point (`:425`: "Fire-3d checks NWS fire weather alerts in California only.").
- The location card lists NWS alerts only while one is in effect (`location/official.ts:150`), so outside California
  "not checked" is **silent**; it still links "Cal OES" at an Idaho point (`:154`).
- **Overview panel**: "OFFICIAL NOW · California" (`ui/feed/OfficialNow.tsx:364`); "No Red Flag Warning or Fire Weather
  Watch in effect in California. Not an all-clear." (`:283`); "N alerts in effect in California; the 3 most recent"
  (`:310`); `model.ts:360`. Data: `official/client.ts:15-19` `fireWeatherStatewideUrl` (backend `nws.py:445` `area=CA`).
- **Overview map outlines**: `official/mapLayer.ts:1-8, :203` draw "California's" Red Flag Warning and Fire Weather Watch
  zone outlines on the overview. Labels already start at z7 (`:137`); the outlines have no zoom limit. The backend
  places only zones whose outlines loaded (30 requests/min, `nws.py:102`; caveat text `:571-574`).
- **"statewide"** names the overview answer in 54 non-test lines in 12 files (`official/runtime.ts`, `hooks.ts`,
  `model.ts`, `client.ts`, `guard.ts`, `types.ts`, `mapLayer.ts`, `ui/feed/OfficialNow.tsx`, `ui/shell/dataStatus.ts`;
  plus Cal OES's "statewide layer" in `extras/*`, which belongs to E-R3).
- Cameras: the panel promises "Wildfire cameras (ALERTCalifornia) and traffic cameras (Caltrans)"
  (`extras/CameraPanel.tsx:52`); elsewhere "No public cameras are listed in this area." (`:58`), as if none existed.
  Legend, feed and credit strings (`extras/cameras.ts:208-236`, `extras/credits.ts:20-25`) appear only with CA data.

### 1.5 Fire record, ids, credits, imagery, Alaska and Hawaii, reprojection
- **CAL FIRE is the only record, down to the fetch**: `official/client.ts:11-13` `calfireUrl` →
  `/api/official/calfire`, queried for every non-demo fire (`official/runtime.ts:106`); `official/hooks.ts:58-65`
  `useCalfire`; types `CalFireCurrent`/`CalFireChange`/`CalFireResponse` (`official/types.ts:42-71`); constants
  `official/calfire.ts:14-17`; `calfireStatus :67`, whose **summary fallback `:89`** ("if summary.calfire_uid") labels
  the list row's numbers as CAL FIRE's record. Feed kind `'calfire'` ("CAL FIRE record", `ui/feed/feedMeta.ts:22`;
  `ui/shell/UpdatesPanel.tsx:100`; `officialSummary.ts`; `UpdatesFeed.tsx:69, :77, :382`; `ui/feed/types.ts`).
  Display: card `FireCard.tsx:50-92, :145`; list `OverviewPanel.tsx:35-37, :106-146, :204-220`; hover
  `mapController.ts:1324, :1382`; legend `MapLegend.tsx:137, :140`; status `dataStatus.ts:196-205`; picker
  `IncidentPicker.tsx:34, :198-265`; `ForensicWorkspace.tsx:91`.
- **Ids**: "CAL FIRE incident UID" (`MapHeader.tsx:86`, `IncidentOverview.tsx:87`); `IncidentSummary.calfire_uid` is
  required (`api/types.ts:14`) and ids derive from it (SPEC §4.4). URLs carry only `?incident=<id>` plus workspace keys
  (`state/history.ts:28`, `state/workspace.ts:188-209`). Credits: CAL FIRE only (`lib/dataCredits.ts:51`). Command
  menu: "Active (CA)", `detections_24h_ca` (`ui/Menus.tsx:331-334`, `api/types.ts:355`).
- **Imagery**: GOES-West is hard-coded in `extras/imagery.ts:26` (`FAMILY_LABEL.goes` "GOES-West, every 10 min
  (1-2 km)") and `:134` (heading "GOES-West: every 10 min, 1-2 km pixels"), plus comments (`imagery.ts:2`,
  `ImageryPanel.tsx:2`). Each product already carries `platform` ("GOES-West", fixture `samples.ts:377`). Backend
  B-R15 adds GOES-East east of about 105° W.
- **Alaska and Hawaii**: nothing marks them; a point there gets the California wording, a fire link the generic
  "could not find" notice. WFIGS "Current" also holds a US Virgin Islands fire (Grootpan, -64.7° W), so territories
  need the same "not supported" handling.
- **Reprojection**: `lib/reproject.ts` and `lib/geo.ts` work in any northern UTM zone (`manifest.grid.utm_zone`), but
  `lib/reproject.test.ts:44-83` covers EPSG:32610/32611 only. `CoordinateStrip.tsx:195` shows any point in the
  fire's zone.

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
| outside `src` | `web/index.html` 8 (meta description) |
| tests | 163 lines in 19 files (`official/calfire.test.ts` 29, `location/official.test.ts` 20, …) |

## 2. Gaps

| # | Grade | Gap | Evidence |
|---|---|---|---|
| G1 | **BLOCKER** | Every time is Pacific and no data carries a zone; swapping `TZ` breaks the ticks. A fire found at 00:30 EDT on Oct 17 shows "Started Oct 16" and "21:30 PDT" | `lib/time.ts:4, :184-196`; 1.2; `api/types.ts:9-33` |
| G2 | **BLOCKER** | The overview is framed and named for California | 1.1; `audit3-web-overview-*.png` |
| G3 | **BLOCKER** | No clustering or zoom-aware decluttering for 1,334 fires (244 active); labels favour tiny active fires | `overviewLayers.ts:62-114, :78-85`; `audit3-web-national-active-*.png` (42 labels, 11 on fires < 10 ac) |
| G4 | **BLOCKER** | The fire record is CAL FIRE end to end (fetch, types, hook, feed kind, card, list, credits, id), and `calfire.ts:89` would show a WFIGS row as "CAL FIRE incident record" | 1.5; 89 code lines |
| G5 | **BLOCKER** | Official panels outside California: evacuations (E-G1, E-G2); NWS "California only" and silent on the card; a "Cal OES" link in Idaho; "Official now · California" and California-only map outlines | `model.ts:393, :425`; `location/official.ts:150, :154`; `mapLayer.ts:3`; `audit3-web-location-boise-*.png` |
| G6 | INCOMPLETE | Search covers California towns and ZIP codes only; "Town, ST" is not parsed | 1.3; `audit3-web-search-boise-desktop.png`, `-zip-phone.png` |
| G7 | MISSING | No state on rows, cards or hover. "Garfield Co." could be in CO, MT, NE, OK, UT or WA | `OverviewPanel.tsx:43`, `IncidentPicker.tsx:243` |
| G8 | INCOMPLETE | The list renders every row (1,334 in the evidence); the lists are not gzipped (586 B/row, measured) | `OverviewPanel.tsx:68-97, :168-172`; B-I9 |
| G9 | MISSING | Nothing marks Alaska, Hawaii or territories "not supported yet"; points outside the US get California wording | 1.5 |
| G10 | INCOMPLETE | Cameras are California-only, and the empty state elsewhere implies there are none | `CameraPanel.tsx:52, :58` |
| G11 | INCOMPLETE | Reprojection is tested in UTM 10/11 only; the lower 48 needs 10-19 | `reproject.test.ts:44-83` |
| G12 | INCOMPLETE | Phones: (a) the controls row covers the search message; (b) with the list sheet open, the refit hides the fires behind it | `audit3-web-search-zip-phone.png`, `audit3-web-official-overview-phone.png` |
| G13 | INCOMPLETE | "Active (CA)", "Times: America/Los_Angeles", `detections_24h_ca`, `index.html:8` | `Menus.tsx:331-340` |
| G14 | INCOMPLETE | Backend text with "PST" baked in reaches the feed | `observed.py:200` (B-R7) |
| G15 | INCOMPLETE | Ids use `calfire_uid`. If California rows change source, old links and bundles break | SPEC §4.4; `api/types.ts:14` |
| G16 | **BLOCKER** | A lon-first pair east of 90° W lands in the southern hemisphere, with an "ok" message | `geodesy.ts:160-165`; 1.3 |
| G17 | INCOMPLETE | GOES-West named in the UI; eastern fires will get GOES-East | `imagery.ts:26, :134` |
| G18 | MISSING | Clusters hide per-fire layers: a clustered fire has no label, no selection ring, no chip | `overviewLayers.ts:23, :261-305`; prototype |
| G19 | INCOMPLETE | The 2025 "≥ 100 ac" switch would load 1,664 national rows, not counted or designed | `IncidentPicker.tsx:183`; `Overlays.tsx:157` |

## 3. Recommended changes

### 3.1 One shared time formatter (fixes G1, G13; supports E-R5)
- **`lib/time.ts` takes a zone and a clock in every function; no zone constant.**
  - `fmtAt(ms, { tz, clock, date, year, refMs })`. With `clock: '12h'`: "Oct 22, 3:40 PM MDT"; with `'24h'`: "Oct 22,
    15:40 MDT" (round 2, item 8). The year is compared in `tz`, not UTC (`extras/format.ts:13`, `DataCredits.tsx:35`).
  - `zoneAbbr(ms, tz)` = Intl `timeZoneName: 'short'` (en-US), fallback "UTC−7". Checked in Node 22 ICU (July and
    January): PDT/PST; MDT/MST for Boise and Denver; MST all year for Phoenix; CDT/CST for Chicago, Indiana/Knox,
    North_Dakota/Center and Menominee; EDT/EST for Detroit, Kentucky/Louisville and New_York.
  - `zoneName(tz)` → "Mountain Time" (`longGeneric`, checked). `wallParts`, `startOfDay`, `wallTicks`, `dayTicks` take
    `tz`; `wallToMs(…, tz)` finds the offset in two passes (no 420/480 constants; DST gaps resolve forward as now).
- **`useTimeFormat()`** (new `state/timeZone.ts`) returns `{ tz, clock }`. `tz` = `manifest.time_zone ??
  summary.time_zone`; `clock` = `'12h'` in the map workspace's Public preset, else `'24h'` (`useWorkspace` `workspace`,
  `preset`). Pure model code (`feedModel`, `describe`, `dataStatus`) takes the pair as an argument.
- **Both fields are required**, so `npm run typecheck` lists all 214 call sites.
- **What changes in California**: Command and Forensic strings stay identical. Public strings change by the user's
  decision ("13:19 PDT" → "1:19 PM PDT"), so about 47 test lines in 12 files change or gain a `clock` argument.
- **Where the zone comes from**: the backend's offline lookup (B-R3: NTAD time-zone polygons plus Navajo/Hopi;
  B-R2 adds `time_zone` to `IncidentSummary` and the manifest; `GET /api/geo/lookup` returns it for a point).
  - A county table is wrong for split counties: Idaho County, ID is split at the Salmon River, which is V-G6's Island
    Creek case. Malheur OR and the Navajo Nation inside Arizona counties are split too.
  - NWS `/points` was rejected by B-R2: one request per point, and an outage leaves no zone.
  1. A fire's own times (timeline, feed, charts, card, its official items, scene labels, notes): the fire's zone.
  2. Overview rows and hover: each row's `time_zone`.
  3. Times about many fires: relative ("records updated 5 min ago"), with absolute times per row in that row's zone.
     The phone peek becomes "244 active fires · records updated 5 min ago".
  4. A point with no fire: the `time_zone` from `/api/geo/lookup`, else the viewer's zone, labelled.
  5. Fallback: always the viewer's zone with its abbreviation, **never** Pacific.
- **Wording**: one line per panel, "Times: Mountain Time (MDT), the fire's local time" (also the Command menu,
  `Menus.tsx:340`). A fire on a zone line uses its reported point's zone. A source time without a zone (Florida, E-G8)
  is shown as given, with "time zone not stated".

### 3.2 National overview: frame, sources, markers, labels (fixes G2, G3, G18)
- **Frame**: `LOWER48_BOUNDS = [-124.85, 24.40, -66.89, 49.38]` replaces `CALIFORNIA_BOUNDS`. Start at [-98.6, 39.8],
  about z3. The fit is z2.96 on a 1440x900 desktop with the panel open and z2.12 on a 390 px phone (measured; the
  phone is limited by width). Header "United States · all fires" (tooltip "lower 48 states; Alaska and Hawaii are not
  supported yet"); button "All states". Keep the last-view restore; no `maxBounds`.
- **Three sources** (MapLibre 5.24 built-in clustering; no dependency). This is the layout the prototype tried:
  - `fx-overview-pinned`, never clustered: active fires of 5,000 ac or more (19 now), plus the fire whose card is open
    (moved here on open). The selection ring, chip and label layers read this source too.
  - `fx-overview-active`: the other active fires; `clusterRadius` 28 (44 on screens under 500 px, set at mount),
    `clusterMaxZoom` 6, `clusterMinPoints` 3. `clusterProperties`: `max_acres` (max), `small` (count under 10 ac or
    with no size).
  - `fx-overview-other`: fires that are not active; radius 40, `clusterMaxZoom` 7, `clusterMinPoints` 3, `max_acres`.
- **Size-aware marks** (round 2, item 1):
  - Active clusters: the bubble is sized by log(`max_acres`), and the count is the label. The 69 small fires in the Upper
    Midwest (largest 606 ac) then draw smaller than Little Giant's single 172,912-ac marker.
  - Small active fires (under 10 ac or no size) are 4 px orange dots with no white ring.
  - Point radius follows zoom (0.6× at z3 to 1× at z7).
  - Hover: "61 active fires · largest 606 ac · 57 under 10 ac or size not reported · click to zoom in".
  - Active marks always draw above other fires; active and other fires never share a group (round 2 default).
- **Labels**: priority by acres; activity is a bonus only at 300 ac or more (replaces `sortKey :83-85`).
  - Below z5: pinned fires only (8 shown on desktop and 6 on phones in the prototype).
  - z5-7: also active fires of 300 ac or more, and any fire of 20,000 ac or more.
  - From z7: active fires of 10 ac or more, and any fire of 1,000 ac or more.
  - Fires under 10 ac: labelled from z9 or on hover.
  - Names stay verbatim, even code-like ones ("Fd140011"; 63 of 244 active names contain digits).
- **Clicks**: a cluster opens at **min(`getClusterExpansionZoom`, 8)**, below `FOCUS_IN_ZOOM` 8.5, so it never
  zoom-focuses a prepared fire. It is an explicit request that ends the opening framing, and the list switches to
  "in this view". `fireAt` returns `{ cluster_id, source }` for clusters.
- **Hidden fires** (replay, the open fire): remove them from the data before `setData`, keyed on the hidden set (never
  per frame), because layer filters do not change cluster counts.
- **Legend**: "Group of active fires (number = how many)", "Group of other 2026 fires", "Small active fire (under 10
  acres or size not reported)".

| Option (no new dependency) | Verdict and evidence |
|---|---|
| A. Clustered GeoJSON sources, plus a pinned source | **Chosen.** 48 marks at the national view (11 + 11 bubbles, 8 singles, 18 pinned) instead of 1,334; readable at z5.6 (`-cluster-nw-desktop.png`). Clustering runs in MapLibre's worker. |
| B. Heatmap or density below z4 | Rejected. It reads as a risk surface ("blank = quiet"), against "unknown, not low"; it hides individual active fires; no counts or clicks. |
| C. Symbol collision only (today) | Rejected. Circles do not collide: the amber blob stays, and 42 labels show, 11 of them on fires under 10 ac. |
| D. Backend grid aggregation | Not needed. It adds an API and work per filter or replay change and loses client hit-testing; it pays off far above ~10,000 points. |
| E. Hide small fires below a zoom | Rejected for markers: round 2 lists every active fire. Kept for labels only. |

### 3.3 List, payload and the 100-acre switch (fixes G7, G8, G19)
- **List**: "312 fires in this view · Show all 1,334" (round 2 default). Rows read "Garfield Co., CO" and counts are
  memoised.
- **Windowing**: hand-written, no `react-window`. Fixed 50 px rows, the visible rows ±10, and spacers.
  - Keyboard: `move()` (`OverviewPanel.tsx:74-77`) scrolls the target row into the window, then focuses it in the
    next frame. Each row keeps `aria-setsize`/`aria-posinset`, so a screen reader still hears "12 of 312".
  - Window only above 150 rows. Test End/Home on 1,334 rows.
- **Payload**: the list rows weigh 586 B each (48,693 B for 83 rows; gzip 9,859 B, 20 %). The API sends no gzip today.
  Nationally that is about 0.74 MB for 2026 plus 0.53 MB for 2025 at start (`App.tsx:68` loads all lists), and
  1.0 MB with the 100-ac switch. Gzip (B-R17) therefore matters for phones and should ship with the national list.
- **The 100-ac switch** (planner default, 4.2): keep it in every state. Its 1,664 rows use the same clusters and
  windowed list. Wording: "Include 2025 fires of 100-300 acres".

### 3.4 Official UI outside California (fixes G5; with E-R1, E-R3, E-R7, E-R8)
- **Overview panel** (`OfficialNow.tsx`): header "Official now · lower 48 states".
  - None in effect: "No Red Flag Warning or Fire Weather Watch in effect in the lower 48 states. Not an all-clear."
  - Some in effect: "{N} alerts in effect in {M} states; the 3 most recent:". Each alert keeps the issuing NWS office,
    its own sent and expiry times in its own zone, its verbatim headline and a link.
  - Coverage comes from the response's `sources[]`. Show the backend caveat verbatim when outlines are missing:
    "{n} fire weather alert(s) could not be placed on the map…" (`nws.py:571`).
  - Footer: "Official evacuation information and each fire's agency record are shown for a fire: zoom in on a fire or
    pick one, or check an address."
- **Map outlines** (`mapLayer.ts`): keep thin outlines at every zoom (NWS's own national map does the same); labels
  stay at z7 (`:137`). Completeness depends on the zone-outline cache (B-R18).
- **Rename `statewide` → `overview`** in the 9 official/shell files of 1.4 (not the Cal OES layer, E-R3).
- **Location card**: always states the NWS status at a point: "checked: none in effect · Not an all-clear", "in
  effect" or "not checked". Links come from `sources[]` and never default to Cal OES.
- **Local officials' messages relayed by NWS** (round 2, item 5: Fire Warning, Evacuation Immediate, and the OpenFEMA
  archive for past days, labelled "archived") are a separate official kind; E-R7 and E-R8 define it.
  States without evacuation data say "not available in this state" (E-R1).

### 3.5 Source-neutral fire record (fixes G4, G15)
- **Fetch by `record_source`**: `recordUrl(summary)` in `official/client.ts` sends `/api/official/calfire` for
  `'calfire'` and `/api/official/incident-record` for `'wfigs'` (B-R10, kind `incident_record`); `runtime.ts:106`
  queries it.
  - Types: `IncidentRecordResponse`, with WFIGS/IRWIN fields verbatim, the issuer = the protecting agency, and
    `changes[]` in the `CalFireChange` shape from B-R11.
  - Hook: `useRecord` (`hooks.ts`). Model: `RecordOfficial` (`model.ts:456-457`).
- **`calfireStatus :89`**: take the summary fallback only when `record_source === 'calfire'`. Otherwise the card says
  "{record_agency} incident record via NIFC WFIGS", with its own `ModifiedOnDateTime` time.
- **Feed kind `'calfire'` → `'record'`**: label from the issuer (`feedMeta.ts:22`, `UpdatesPanel.tsx:100`,
  `ui/feed/types.ts`, `officialSummary.ts`, `UpdatesFeed.tsx`).
- **Display**: California rows keep every CAL FIRE string, and `calfire.test.ts` must still pass unchanged. The id
  line reads "Incident ID (NIFC WFIGS)" or "(CAL FIRE)" instead of "CAL FIRE incident UID" (`MapHeader.tsx:86`,
  `IncidentOverview.tsx:87`).

### 3.6 Change list

| # | Change | Value | Effort | Risk | Files | Prio |
|---|---|---|---|---|---|---|
| W1 | Shared formatter (3.1): `tz` and `clock` at every call site; `useTimeFormat`; UTC-year fixes | Brief time rule; round 2 item 8 | L | Medium-High: 43 files; Public strings change in CA too (about 47 test lines); Command/Forensic CA identical | `lib/time.ts`(+test), `state/timeZone.ts` (new), the files of 1.2, `ui/DataCredits.tsx`, SPEC §4.2 | **P0** |
| W2 | Lower-48 frame and wording (3.2), meta description | National first view | S | Low | `map/framing.ts`(+test), `map/mapController.ts`, `map/MapControls.tsx`, `ui/shell/MapHeader.tsx`, `OverviewPanel.tsx`, `App.tsx`, `location/CoordinateStrip.tsx`, `index.html` | **P0** |
| W3 | Three sources, size-aware clusters, zoom labels, legend (3.2) | Readable with 244 active and 1,334 fires | M | Medium: hit-testing, replay data, focus, pinned moves | `map/overviewLayers.ts`(+test), `map/mapController.ts`, `map/MapLegend.tsx` | **P0** |
| W4 | Source-neutral record and fetch (3.5) | Right issuer; no mislabelled official record | M | Medium: many strings; CA snapshots kept | `official/client.ts`, `runtime.ts`, `hooks.ts`, `types.ts`, `model.ts`, `calfire.ts`(+test), `ui/feed/feedMeta.ts`, `ui/feed/types.ts`, `UpdatesFeed.tsx`, `ui/shell/UpdatesPanel.tsx`, `officialSummary.ts`, `FireCard.tsx`, `OverviewPanel.tsx`, `IncidentPicker.tsx`, `MapLegend.tsx`, `mapController.ts`, `dataStatus.ts`, `IncidentOverview.tsx`, `MapHeader.tsx`, `lib/dataCredits.ts`, `location/OverviewCard.tsx` | **P0** |
| W5 | State on rows, card, hover and picker; state words in incident search | Tells same-named counties apart | S | Low | `OverviewPanel.tsx`, `IncidentPicker.tsx`, `FireCard.tsx`, `location/search.ts`(+test), `lib/usStates.ts` (new: 48 + DC) | **P0** |
| W6 | National search: "Town, ST", "ST 83702", `state=`, national wording; show the backend's Alaska/Hawaii note (B-R12) | Search works in every state | S-M | Low | `location/search.ts`(+test), `SearchBox.tsx`, `geocodeClient.ts`, `location/types.ts` | **P0** |
| W7 | Official UI outside California (3.4) with the exact wording | No implied checks or all-clears | M | Medium | `official/model.ts`(+test), `client.ts`, `runtime.ts`, `hooks.ts`, `guard.ts`, `types.ts`, `mapLayer.ts`, `ui/feed/OfficialNow.tsx`, `location/official.ts`(+test), `dataStatus.ts`, `officialSummary.ts` | **P0** |
| W8 | Lat/lon order and missing minus: if a bare pair has no letters and both values are within ±90, try both orders and pick the one inside the lower 48. If neither is inside, read lat-lon and warn "outside the area Fire-3d covers". Use the same lower-48 box for the missing minus. The box is a parsing heuristic, never a coverage claim | No silent jump to the Southern Ocean | S | Low | `lib/geodesy.ts`(+test: Atlanta, Miami, Boston, Houston, LA), `location/search.ts`(+test), `SearchBox.tsx` | **P0** |
| W9 | Coverage at a point from `GET /api/geo/lookup` (B-R3): `supported: false` → "Fire-3d does not support Alaska, Hawaii or US territories yet"; no state → "Outside the United States: Fire-3d has no data here"; no client boxes | Brief decision 1 | S | Low | `location/OverviewCard.tsx`, `location/official.ts`, `location/geocodeClient.ts` (lookup call), `OverviewPanel.tsx` | **P0** |
| W10 | Per-region accuracy label (decision 3; round 2 item 7). Public: "Tested on {2} past fires in this region…", score one tap away; Command: the score; untested: "Accuracy not yet tested here."; always "Outside the modeled area is unknown, not low." Templates per V §5; skill-table colour fix V-G15 | Launch requirement | M | Medium: wording review | `lib/plainLanguage.ts`, `location/describe.ts`, `ui/AnalysisTab.tsx`, `FireCard.tsx`, `ui/timeline/CompactTimeline.tsx` (with V-R10/R13) | **P0** |
| W11 | List in view, windowing, memoised counts; national 100-ac switch (3.3) | A fast list that follows the map | M | Medium: keyboard and screen reader in a windowed list | `OverviewPanel.tsx`, `state/overview.ts`(+test), `IncidentPicker.tsx`, `Overlays.tsx` | P1 |
| W12 | Cameras: "Public cameras: California only (ALERTCalifornia, Caltrans). Not available in this state." on `not_covered` (B-R16) | Honest empty state | S | Low | `extras/CameraPanel.tsx`, `extras/cameras.ts` | P1 |
| W13 | Imagery labels from `p.platform` ("GOES-East, every 10 min (1-2 km)"), with B-R15 | Right satellite name | S | Low | `extras/imagery.ts`(+test), `ImageryPanel.tsx` | P1 |
| W14 | UTM tests for zones 10-19 (3.8) | Overlays align everywhere | S | Low | `lib/reproject.test.ts` | P1 |
| W15 | Phone fixes (G12) | Usable phone search and list | S | Low | `styles/overview.css`, `location/searchUi.ts`, `map/mapController.ts:780` | P1 |
| W16 | Clean-up: 197 comment lines, dev presets, "Active (CA)", the UTM label "(fire grid zone)" | Accurate code docs | S | Low | the comment lines of 1.6, `ui/Menus.tsx`, `location/CoordinateStrip.tsx` | P2 |

### 3.7 Contract requests (CONTRACT §14, SPEC, `contracts.py`, `api/types.ts`; all additive)
- `IncidentSummary`: `state` (USPS), `time_zone` (IANA), `record_source` (`'calfire' | 'wfigs'`), `record_agency`,
  `record_url`, `uid` (keep `calfire_uid` as a deprecated alias), `accuracy_region` (V §5). Alaska, Hawaii and
  territories are not listed.
- Manifest: `time_zone`, `state`. Official and extras answers: `states[]` (E-R1); each NWS alert carries `time_zone`
  (from B-R3 at its zones). `GET /api/geo/lookup` → `{state, state_name, time_zone, supported}`.
- `GET /api/official/incident-record` (kind `incident_record`, B-R10). Live status: `detections_24h` (keep
  `detections_24h_ca` one release). Gzip on `/api/incidents` (B-R17).
- Ids stay `{year}-{slug}-{uid6}`; today's California ids and bundles keep resolving (G15). SPEC §4.2: "The UI shows
  each fire's local time with its zone abbreviation."

### 3.8 Reprojection tests to add (W14)
The lower 48 spans 124.7° W (Cape Alava, WA) to 66.9° W (West Quoddy Head, ME): UTM zones 10-19. Zones 10 (126-120° W:
western WA and OR, California west of 120° W) and 11 (120-114° W: eastern WA and OR, California east of 120° W,
nearly all of Nevada, Idaho west of 114° W) are tested today.

| Zone | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
|---|---|---|---|---|---|---|---|---|
| Central meridian | 111° W | 105° W | 99° W | 93° W | 87° W | 81° W | 75° W | 69° W |
| Mostly | AZ, UT, east ID, west MT | CO, NM, WY, east MT | Dakotas, NE, KS, OK, TX | MN, IA, MO, AR, LA | WI, IL, IN, TN, AL, FL panhandle | east MI, OH, GA, Carolinas, FL | NY, PA, NJ, MD, east VA | ME, RI, east MA, east NH |

- **Per zone** (parametrised): grids at the central meridian and ±3.4°, at 24.5°, 37° and 49.4° N. Check the round trip
  against `lib/geo.ts` (< 1 mm), the true AOI quadrilateral, and the per-pixel inverse mapping at edges and corners.
- **Zone-line AOIs** like Madre at 120° W: 102° W (13/14), 108° W (12/13), 84° W (16/17). **Extreme points**: Key West
  24.55° N 81.8° W (17), Northwest Angle 49.38° N 95.15° W (15), West Quoddy 44.82° N 66.95° W (19).
- **Real bundles**: add the grids of stage D's out-of-state bundles. Backend test (B-R4): zone = `floor((lon + 180) / 6) + 1`.

## 4. Questions

### 4.1 Answered by the user in round 2 (BRIEF-3)
1. Clock → **mixed** (item 8): Public 12-hour, Command and Forensic 24-hour, always with the fire's zone. Cost: Public
   strings change in California too (W1 risk Medium-High).
2. Active fires in groups → default: they group only with other active fires (3.2).
3. National list → default: fires in the current map view, with "Show all" (3.3).
4. Phone opening view → default: the whole lower 48 with grouped markers (3.2).
5. Cameras → default: California only; "not available in this state" elsewhere (W12; same as B-Q5).
6. Which active fires (B-Q2, answered together with 2) → **all of them** (item 1): 244 now, so W3's size-aware marks
   are required.

### 4.2 Planner defaults in this audit (the user can override)
- The 2025 "≥ 100 ac" switch stays in every state (3.3).
- Pinned fires are active fires of 5,000 ac or more, plus the open fire; small active fires (under 10 ac or no size)
  are plain dots, labelled from z9 (3.2).
- Times about many fires are relative; each row keeps its own zone (3.1).

### 4.3 Still open for the user
None. Everything left is a design choice for the planner.

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
  - `national-1178-*` (first pass): 1,178 WFIGS 2026 points, all injected as **not active**, on top of the 84 CAL FIRE
    rows, so about 69 California fires appear twice (1,262 rows). This does not test active fires; superseded by:
  - `national-active-*` (revision): today's layers with 179 active fires (176 non-CA WFIGS "Current" + 3 CAL FIRE)
    and 1,109 non-CA 2026 rows, with California from CAL FIRE only (31 WFIGS rows merged with their active row): 1,334
    fires. Desktop z2.96: 42 labels, 11 on fires under 10 ac, 12 on fires of 20,000 ac or more (of 74). Phone z2.12:
    22 labels (5 under 10 ac). Labels such as "Toe · 0 ac" and "S. Dike Rd · 1 ac"; Grootpan (VI) in the Caribbean.
  - `national-cluster-desktop`, `-phone`, `-nw-desktop` (revision, browser-only prototype): today's overview layers
    hidden; three throwaway sources as in 3.2 (pinned ≥ 5,000 ac active: 18; clustered active: 161; clustered other:
    1,155).
    - National view: 11 other bubbles, 1 single, 11 active bubbles, 7 singles, 18 pinned (8 labels on desktop, 6 on
      the phone).
    - z5.6 Northwest: 43 + 63 other, 4 + 36 active, 13 pinned labels.
    - The Upper-Midwest active bubble ("61") is the largest mark. WI, MN and MI hold 69 active fires: 57 under 10 ac
      or with no size, the largest 606 ac. Bubbles must be sized by acres.
  - The prototype ran in the page via `useMapRuntime.getState().map`; script (session scratchpad, not committed):
    `/tmp/claude-0/-home-user-fire-3d/46b23942-68f3-578a-a513-ea699dabb6b6/scratchpad/audit-web-us/rev/national.mjs`.
    0 page errors and 0 non-GET requests in each run.
- **WFIGS (NIFC)**: count-only or small GETs with a descriptive User-Agent (6 in the first pass, 4 in the revision);
  raw files stayed in the scratchpad.
  - `WFIGS_Incident_Locations_YearToDate`, `IncidentTypeCategory='WF' AND IncidentSize>=300`, grouped by `POOState`:
    1,204 in all (AK 25, HI 1); lower 48: 1,178 in 35 states (CA 69; OK 135, TX 119, FL 105, OR 85, ID 84).
  - `WFIGS_Incident_Locations`, discovered in 2025: at 300 ac or more, 984 (AK 122, HI 1); lower 48: 861 in 38
    states (CA 79). At 100 ac or more: 1,810, of which 1,664 in the lower 48 (CA 125).
  - `WFIGS_Incident_Locations_Current` WF: 298 rows; 245 active (containment < 100 % or not given), including 1 in the
    Virgin Islands. Lower 48: 244 active (112 of 1 ac or less, 43 with no size, 66 of 10 ac or more, 27 of 1,000 ac or
    more, 19 of 5,000 ac or more; CA 69, of which 4 are 10 ac or more).
- **Payload**: local `/api/incidents` (fixture data): 2026 list 48,693 B for 83 rows (586 B/row), 9,859 B gzipped;
  2025 list 46,951 B for 78 rows. No `content-encoding` with `Accept-Encoding: gzip`.
- **Parser run**: `parseLatLonDetailed` from a copy of `lib/geodesy.ts` (Node 22 `--experimental-strip-types`), the
  cases in 1.3.
- **Time zones**: Node 22 Intl (en-US) as in 3.1; Oct 17 00:30 EDT = Oct 16 9:30 PM PDT.
- **Greps**: 1.6 classifies each hit as comment, code or fixture; 214 time calls in 43 files (not counting
  `lib/time.ts` and tests); "statewide" 54 non-test lines in 12 files; 24-hour times in about 47 test lines in 12 files.
- **Gates**: not run (stage A changes no code). Count-only scans of the API and Vite logs for the key name found 0.

## 6. Revision notes (after the independent review)

**Corrected**
- 2025 count: 861 in the lower 48 (984 included Alaska and Hawaii); 2026 spans 35 lower-48 states, not 37.
- The first national screenshots had no active fires and duplicated about 69 California fires. Redone with real
  active fires and no duplicates (`national-active-*`).
- Dropped the county-FIPS time-zone option (split counties: Idaho County, Malheur, the Navajo Nation). The web uses
  B-R2/R3 and `/api/geo/lookup`.
- Zone 11 covers eastern WA and OR, California east of 120° W, nearly all of Nevada and Idaho west of 114° W.
- W1 no longer claims "California identical": the mixed clock changes Public strings, so its risk is now Medium-High.
- W10 (cameras, now W12) lists `cameras.ts` and drops `legend.ts`, which has no California strings.

**Added**
- The CAL FIRE fetch path and the `calfire.ts:89` mislabel (G4, W4; the files of 3.5).
- GOES-West labels (W13).
- The lon/lat order bug (G16, W8, P0).
- National NWS overview outlines and wording, and the `statewide` rename (3.4). The reviewer's worry about labels at
  z3 does not apply: the labels already start at z7 (`mapLayer.ts:137`).
- The 244 active fires and the label evidence; the 100-ac switch (1,664 rows; "several times 861" overstated it,
  it is 1.9×); cluster and per-fire layer interaction (G18, pinned source).
- The `index.html` meta description; the `DataCredits` UTC year; the payload numbers with B-I9/R17.

**Strengthened**
- Clustering: five options compared, plus a browser prototype with numbers.
- Windowing risk raised to Medium, with the keyboard and ARIA design, hand-written.
- Coverage (W9) uses `/api/geo/lookup`, not client boxes.
- W9 and the accuracy label (now W10) raised to P0, with the validation audit's wording.
- The national "Official now" text is written out.

**Questions**: Q1-Q5 and B-Q2 were answered in round 2 (4.1). Nothing is left for the user.
