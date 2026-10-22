# Audit 3: official evacuation data for the lower 48 states

Role `audit-evacuations` (brief 3, stage A). Research only: no project code changed, no fire built, no browser run.
First pass 2026-10-22, 20:45-21:40 UTC. Revision pass after an independent review, 22:00-22:40 UTC (section 11).
All requests were polite GETs (descriptive User-Agent, count-only or small queries). The evidence log is section 10.

## 0. Summary

- **The user's round-2 decisions (BRIEF-3, Oct 22) settle most of the first pass's questions.**
  - FEMA IPAWS: no registration. Live, Fire-3d shows the local officials' messages the NWS relays. For past days it
    uses FEMA's OpenFEMA archive, labelled as archived.
  - Washington is the only partial state used, labelled "updated daily, may be out of date", and only if it loads
    reliably. Florida is not shown ("not available in this state"). County feeds are out of scope.
  - Two questions remain, both with a recommendation (section 8).
- **Oregon: available.** OEM "Evacuation Areas Public" is a live statewide layer, empty off-season (count 0 at
  22:34Z). Corrections from the revision:
  - its whole terms basis is the one-word licence "Public";
  - `last_edited_date` is an OEM recalculation time, not an issue time;
  - half of the 2026 history rows have no fire name;
  - a non-fire evacuation ("HWY 229 Landslide", hazard "Other", level 3) sat in the layer from July 1 to Aug 25, 2026.
- **Washington: now read live.**
  - Why it failed: the server sends only its own certificate, without DigiCert's intermediate, so Python fails on
    any machine. Browsers often fill the gap themselves.
  - With that public intermediate added for this one host (verification stays on), the layer reads: 583 rows, 73
    "Active", but only 5 of those carry a level. The other 68 are automated rows with no level, and they must be
    filtered out.
  - Its licence also has an **indemnification ("hold harmless, defend, and indemnify")** clause and an "as-is"
    clause. Only the user can accept those (question Q-A).
- **Arizona: none, on firmer evidence.**
  - DEMA's statewide zones are planning zones.
  - Their data was last edited 2026-02-12, while Coconino and Cochise counties sent 7 fire alerts during the 2026
    season.
  - The 2026 "Emergency Evacuation Zones" items are views or exports of that same layer.
- **The other 43 states: none.** 44 state searches are now logged, each naming the state agency checked.
  "Blocked" is no longer a separate verdict: Utah is "none", with a note that its counties use Genasys.
- **Blockers in today's code (California-only design):**
  - G1: outside California the backend still queries Cal OES and answers `available` with zero zones.
  - G2: the web treats a rectangle as California (lon -124.9..-113.8, lat 32.2..42.3). Points in Reno, Carson City,
    Stateline and Las Vegas (NV), Klamath Falls, Ashland and Brookings (OR), Yuma, Lake Havasu City and Bullhead City
    (AZ), and Tijuana (MX) therefore get a Cal OES point query. Each one reads "No evacuation order or warning listed
    here · Cal OES, checked just now · not an all-clear". That is an implied check that never happened (offline run of
    today's model, section 10).
  - G11: `evac_status_key("No Evacuation Order")` returns `"order"`, and Washington's layer contains that wording.

## 1. What exists today (California only)

Backend (`backend/fire3d/api/extras.py`; tests `backend/tests/test_extras.py`):
- Layers `:69-71` (Cal OES `CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0`, `County_Evacuation_Inventory_Public`),
  `SOURCES` metadata `:113-137`, TTLs `:83-84` (zones 120 s, inventory 24 h), one limiter `UP_ARCGIS` "Cal OES ArcGIS"
  60/min `:271`.
- `evac_status_key()` `:525-544` (styling key; the wording stays verbatim). `normalize_zone()` `:553-582` reads the Cal
  OES fields `STATUS, ZONE_ID, ZONE_NAME, COUNTY, CITY, EVENT_TYPE, NOTES, CRITICAL_INFO, PUBLIC_INFO, EDIT_DATE`
  (issuer edit) and `EditDate` (Cal OES copy).
- `_evac_zone_features()` `:604-620`: `outFields: "*"` at `:610`; a Cal OES-specific "confirm a drop" re-query after
  `time.sleep(2.0)` at `:613-617`.
- `evacuations_payload()` `:623-670`:
  - `issuing_authority` hard-coded with "Cal OES aggregates and does not verify" (`:625-626`);
  - past time → `not_available_for_past_dates` (`:628`);
  - inventory counties all missing → `unavailable`/`not_covered`, meaning "check the county's channels" (`:642-646`);
  - the always-on caveat "During Cal OES's 5-minute rebuild…" (`:666`);
  - no zones → `available` + "not an all-clear" (`:668`).
- Envelope (CONTRACT §12.1): one `retrieved_ms` and one `source_updated_ms` per response; `reason_code` is
  `past_date | upstream_error | not_covered` (also `contracts.py:450`, `web/src/extras/types.ts:6`).
- NWS: `backend/fire3d/sources/nws.py:50` `FIRE_EVENTS` (Red Flag Warning, Fire Weather Watch only) and `area=CA` at
  `:445`. backend.md R9 makes it national.
- `fire3d/http.py:145-154`: one shared `httpx.Client` with default TLS verification (certifi, no fetching of missing
  intermediates); `_transport` (`:142`) lets tests inject an `httpx.MockTransport`.

Web:
- Types `web/src/extras/types.ts` (`ExtrasEnvelope :23-39`, `EvacZoneProps :45-65`, `EvacuationsResponse :75-91`).
  `ExtrasSync.tsx:61` fetches the incident query whatever the layer toggle says.
- `official/model.ts`:
  - `evacuationNow()` `:114-133` ("No orders or warnings are listed within 15 km … not an all-clear");
  - `needsPointQuery()` `:158-163`, gated by **`insideCalifornia()` `:166-168`**, a rectangle;
  - `evacuationAtPointState()` `:195-214` ("Cal OES lists evacuation zones in California only." `:209`, only outside
    the rectangle);
  - the same rectangle gates the statewide NWS answer (`:393`, `:425`; web.md G5/W7).
- Location card `location/official.ts`: "No evacuation order or warning listed here · Cal OES · not an all-clear"
  (`:98`), "not checked" (`:105`), a "Cal OES" link always (`:154`).
- **"Cal OES" in non-test `web/src`** (regex `cal ?oes|CAL_OES|caloes`): 85 lines in 19 files. Line numbers:
  - `official/model.ts` 30,32,36,40,50,52,54,68,103,104,106,116,128,165,187,196,199,209,213;
  - `extras/evacuation.ts` 214,232,243,262,263 (`NOT_FIRE_SPECIFIC`),301,305,328,337,345,347,359,361,396,409,410;
  - `ui/feed/OfficialNow.tsx` 4,71 ("via Cal OES"),95,102,134,157,158,171,176;
  - `location/official.ts` 5,58,73,76,78,79,98,105,154; `ui/shell/dataStatus.ts` 8,130,142,148,155,160;
  - `extras/credits.ts` 13,16,17 (evacuations) and 20,24,25 (cameras); `extras/EvacuationPanel.tsx` 2,43,45;
  - `extras/types.ts` 62,81; `official/hooks.ts` 4,69; `official/mapLayer.ts` 4,40;
  - one each in `ui/shell/officialSummary.ts:28`, `ui/shell/LayersPanel.tsx:45`, `ui/feed/types.ts:95`,
    `official/fire.ts:4`, `map/mapController.ts:1343`, `extras/hooks.ts:13`, `styles/map-tokens.css:64` (comment);
  - camera-only lines stay California-only (backend R16, web W10): `extras/cameras.ts` 2,226,235,236,
    `extras/CameraPanel.tsx:54`, `credits.ts` 20-25.
  - Tests and fixtures: 57 lines in 13 files:
    - `extras/__fixtures__/samples.ts` 19, `location/official.test.ts` 13, `extras/evacuation.test.ts` 7;
    - `ui/shell/dataStatus.test.ts` 3, `extras/credits.test.ts` 3;
    - 2 each: `official/model.test.ts`, `extras/runtime.test.ts`, `extras/format.test.ts`, `extras/cameras.test.ts`;
    - 1 each: `ui/feed/feedModel.test.ts`, `official/select.test.ts`, `official/mapLayer.test.ts`, `map/focus.test.ts`.

## 2. Findings

### 2.1 State feeds that exist

**Oregon: available.** Oregon Department of Emergency Management (OEM), "Evacuation Areas Public".
- Item `dd2bee51e3004dc4b1004df34fbd9e29`, owner `Oregon_OEM`, modified 2026-08-05.
- Service: `https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/Fire_Evacuation_Areas_Public/FeatureServer/0`
  (polygons, maxRecordCount 1000). It is also published as KML (`1559623319d74687a7a5c72f4643dd24`) and WFS
  (`b43c89ad020c4fd7b65121a3dc2299d9`).
- **Terms basis (all of it):**
  - `licenseInfo` "Public" and `accessInformation` "Oregon Department of Emergency Management" on all three items;
  - the OEM StoryMap "Evacuation Layer Initiative Overview" (`7b0a65738c1447dbbac2f46820a422bf`, licence "Public")
    states the "need and desire to share information to the public";
  - no disclaimer or redistribution text was found, on the items, the StoryMap or by web search (section 10).
  - This is acceptable by analogy with the Cal OES item ("Public Use"). Credit: "Oregon Department of Emergency
    Management". CONTRACT §12.5 must say "licence field 'Public'; no further terms published (checked 2026-10-22)".
- Description (quoted): "Statewide evacuation layer - showing current evacuations issued across Oregon. Data is
  entered by local/tribal/state GIS staff …". Integrations:
  - Clackamas and Deschutes, "updates every 5 minutes";
  - Genasys "for zones not in a normal status, updates every 5 minutes";
  - Perimeter (synced);
  - the OEM upload utility, "every 15 minutes".
  - Also: "Data calculations run every 15 minutes on this service".
- Fields:
  - `Fire_Evacuation_Level` (integer 1-3), `Fire_Name`, `Evac_Area_Name`, `County` (36 Oregon counties + "Del
    Norte", CA), `HazardType` (Earthquake, Fire, Flood, Tsunami, Nuclear, Other), `created_date`,
    `last_edited_date`, `StructuresWithin/AddressesWithin/PopulationWithin`;
  - **personal or account data, never request: `Editor_Name`, `Editor_Email`, `Editor_Phone`, `created_user`,
    `last_edited_user`.**
- Today: count 0 (20:49Z and 22:34Z); `dataLastEditDate` 2026-09-29T18:42Z.
- **History layer, for fixtures and for any later replay (Q-B):** "2026 Wildfire Evac History".
  - Item `c8b3c502f58045269f32737fa8f5c025`, owner `Oregon_OEM`, `licenseInfo` empty.
  - Service `https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/2026_Wildfire_Evac_History/FeatureServer/0`.
  - Contents: 5,180,769 rows, one snapshot of the live layer every 5 minutes (field `Date`), 2026-07-01 to 09-29.
  - Same fields as the live layer except `Editor_*`; `created_user` and `last_edited_user` are present.
- What the history shows about the fields:
  - **`last_edited_date` is not an issue time.** All 10 Fielders Mountain zones in the 12:01Z snapshot of 2026-08-15
    read `last_edited_date` 12:00Z, which is OEM's 15-minute recalculation. `created_date` (2026-08-14 00:20-01:25Z)
    is when the zone entered the state layer.
  - `Fire_Name` is null in 2,630,502 of 5,180,769 rows (51%); in the 2026-08-15 12:01Z snapshot, 126 of 380 zones.
  - `County` is null or empty in 101,432 rows (2%); "Del Norte" in 0 rows.
  - The only non-fire hazard is "HWY 229 Landslide" (`HazardType` "Other", level 3, Lincoln County): created
    2025-12-14, in the snapshots from 2026-07-01 to 08-25 (15,741 rows).
  - `Evac_Area_Name` often carries Genasys zone ids ("US-OR-JAC-JAC-044").
- Level wording, OEM press release of 2024-05-28
  (`https://www.oregon.gov/oem/Documents/NR-052424-2024_Evacuation_Preparedness_Release_EN.pdf`): "Level one (green
  on a map) means BE READY to evacuate"; "Level two (yellow on a map) means BE SET to evacuate"; "Level three (red on a
  map) means GO NOW – Leave Immediately!".
- Never repeat the item's "If there are no records in this dataset, there are no evacuations currently in place."
  (also in the KML and WFS items): absence is never an all-clear.

**Washington: partial; readable with a TLS fix; terms need the user (Q-A).** WA State EOC (Military Dept / EMD),
"Evacuation_Zone_Level".
- Item `cee84395f08a4d32b2ae128e8f149cd3`, owner `waseocgis`, modified 2026-08-17.
- Service `https://wise.wamil.us/bmw/rest/services/Hosted/Evacuation_Zone_Level/FeatureServer/5` (polygons,
  maxRecordCount 2000). Its capabilities include Create, Update and Delete: an editable layer.
- **TLS root cause** (`openssl s_client` through the session proxy):
  - wise.wamil.us presents one certificate (depth 0, "Military Department, Washington State", issuer "DigiCert Global
    G2 TLS RSA SHA256 2020 CA1"; valid to **2026-11-26**), without the intermediate.
  - services.arcgis.com presents leaf and intermediate from the same CA and verifies.
  - The issuers are DigiCert's, not the proxy's, so this is the server's own chain. Python/httpx never fetches a
    missing intermediate, so `fire3d.http` fails the same way on the user's machine. A browser loading the map proves
    nothing.
  - Fix, verification still on: add DigiCert's public intermediate
    (`https://cacerts.digicert.com/DigiCertGlobalG2TLSRSASHA2562020CA1-1.crt`, valid to 2031-03-29, SHA-256
    `C8:02:5F:9F:…:25:A9`) to the trust used for this one host. Tested: certifi alone gives
    `CERTIFICATE_VERIFY_FAILED`; certifi plus the intermediate gives HTTP 200.
- Live read (22:0x Z): 583 rows.
  - By status and level: Inactive (L1 136, L2 138, L3 137, "Planning Zone" 39, **"No Evacuation Order" 5**); null or
    empty status 55; **Active 73**.
  - The Active rows are 5 with a level and 68 with `evactype` null. The 68 are Asotin 64 and Kittitas 4,
    `data_source` "automated", aggregated from county layers `View_Evacuation_Zones` and `Active_Fire_Areas_View`.
  - The 5 with a level: 4 manual "Hatch Grade" rows (Walla Walla, L3 ×3 and L2, `date_added` 2026-09-30T07:00Z =
    local midnight, link `https://inciweb.wildfire.gov/`). News results could not confirm whether they are still in
    force. One automated Chelan row, "Stehekin - Level 1 (Get Ready)", was added at 22:03Z.
  - Newest `dateedited` 2026-10-22T22:03Z: automated rows are rewritten on each run, so `date_added` and
    `dateedited` are compile times, not issue times. `level_{1,2,3}_active_date` was empty on all 73 Active rows.
- Fields: `objectid, id, incidentna, evactype, county` ("Asotin_County"), `status, date_added, dateedited,
  level_{1,2,3}_{active,inactive,reduction}_date, comments` ("Auto-aggregated from <county layer URL> on <time>"),
  `incident_link, data_source`. There are no personal fields.
- **Licence, full** (quoted from the item, 2026-10-22):
  - "Operational Lag: … updated on a daily schedule, there may be a temporary lag between an official county-level
    evacuation order and the representation on this layer."
  - "Do not rely solely on this map layer for immediate life-safety decisions."
  - "'As-Is' Provision: This data is provided 'as-is' without warranties of any kind …"
  - **"Indemnification and Hold Harmless … By using this data, the user agrees to hold harmless, defend, and
    indemnify the State of Washington, the State Emergency Operations Center (SEOC), participating Washington State
    counties, and their respective officials, employees, and agents from any and all claims, demands, losses, or
    liabilities arising from the use, misuse, or reliance upon this geospatial data."**
  - "Freedom of Reuse: Users are permitted to view, request, share, and integrate this layer into public-facing
    applications, provided that the data source is properly credited and not misrepresented."
  - "Any public display … must provide visible attribution to the 'Washington State SEOC and Participating County
    Emergency Management Agencies.'"
  - "No Endorsement".
  - The description adds: "Data is systematically compiled from multiple county websites, external web feeds, and
    local public safety portals, then processed and updated daily".

**Florida: partial, but not shown (decision 6).** FDEM SERT "Evacuations and Curfews"
(`SERT_EvacCurfew2026/FeatureServer/0`, item `c64b6755aee247c8aef0f258e6d2dd52`).
- WebEOC county-level rows: 87, all `evacuation_status` "Not Reporting"; times without a zone.
- Registry note only. If it is ever revisited: `evac_status_key` maps "Not Reporting", "Mandatory Evacuation" and
  "Voluntary Evacuation" all to `other` (verified offline), and `other` is drawn (`web/src/extras/style.ts:26-31` hides
  only `normal`/`training`). It would need its own mapping and a "Not Reporting" filter.

### 2.2 National official channels (local officials' messages, not zone maps)

They are official alerts written by local authorities and sent through FEMA IPAWS (WEA, EAS, NOAA Weather Radio, the
public feed). They are not zone maps or complete order lists, and their absence is **not** an all-clear.

| Channel | Use (decision 5) | Terms (official page) | Latency, geometry | Fit |
|---|---|---|---|---|
| NWS API `api.weather.gov/alerts` (event types `Fire Warning`, `Evacuation Immediate`, `Civil Danger Warning`, `Civil Emergency Message`, `Shelter In Place Warning`, `Local Area Emergency`, `Law Enforcement Warning` exist in `/alerts/types`) | **Live** | Public domain (weather.gov/disclaimer, credited in `nws.py:76-78`); NWEMs are sent by "Federal, state, local, tribal and territorial public safety officials … through FEMA IPAWS" (weather.gov/dsb/nonweatheralerts) | Real time; `/alerts` keeps about 7 days. Both NWEMs seen this week had `geometry: null`, `affectedZones: []`, SAME codes only | **Thin:** only 122 of 2,233 FRW/EVI (2024-26) left the NWEM channel open (~5%) |
| OpenFEMA "IPAWS Archived Alerts" v1 `fema.gov/api/open/v1/IpawsArchivedAlerts` | **Past days** | OpenFEMA terms (Jan 22, 2025): notice "This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA"; no FEMA/DHS logos. Dataset page: "published with a twenty-four (24) hour delay"; "FEMA does not validate the content of each message" | ~24 h (newest 2026-10-21T20:49Z at 21:00Z); full CAP, polygons in ~84% of fire FRW/EVI | All IPAWS messages, including the ~95% never relayed live. Nested filters are slow (15-60 s; one 503) |
| IPAWS public feed (All-Hazards Information Feed) | **Not used** (no registration) | fema.gov page (updated June 9, 2026): "free of charge"; "Please register for an account on the IPAWS User Portal"; no advertising; "cannot stress IPAWS servers"; "active on the feed for 30 minutes or until they expire". No agreement or MOA is mentioned (re-checked) | Real time | – |

Fire messages, OpenFEMA, `status eq 'Actual'`, 2024-01-01 to 2026-10-21:
- 2,233 unique FRW + EVI. Fire-related outside California: 1,213 (2024: 293, 2025: 341, 2026: 579) in 38 states.
- Top states: WA 266, OR 179, ID 106, CO 96, OK 93, TX 65, NM 51, UT 49, NV 46, WY 41. Arizona in 2026: 7 (Cochise
  County 4 in March-April; Coconino County 3 in June, including EVI "Pumpkin Center 141" on 2026-06-27).
- Caveats in the data:
  - 5 "TEST" texts sent as `Actual`, and burn bans and Red Flag notices sent as FRW: show the text verbatim, never
    classify it;
  - 53% have an empty `description` (the text is in `CMAMtext`/`CMAMlongtext`), and only 6% carry a `web` link;
  - `senderName` is free text, 18% a platform name ("Public Alert System"), while `sender` is an operator email:
    never show it;
  - one CEM is stamped `+01:00` with `timezone: EST` for Los Angeles: convert the instant, never show the raw offset.

### 2.3 Searched and not usable

- **Arizona** (AZ DEMA, owner `SitUnit_AZDEMA`):
  - The authoritative statewide layer is `services6.arcgis.com/l7uujk4hHifqabRB/…/Arizona_Evacuation_Zones/FeatureServer/0`
    (item `282118c1fe054a749fa91dcb2079bed9`).
    - Its rows are 4,252 zones in the Ready-Set-Go structure: Status "None" 4,240, Set 6, Go 5, Planning 1 (a "TEST"
      incident). The 11 Set and Go zones are Coconino North Rim and Kaibab zones left over from 2025.
    - `dataLastEditDate` is 2026-02-12, with no edits during the 2026 season.
  - Other 2026 items are views or exports of the same layer:
    - `Emergency_Evacuation_Zones_View_Only` has the same edits and counts;
    - "Emergency Evacuation Zones_7 (YCU-2567 layer)" and the county items (Cochise, Gila, Tempe) point at the same
      service;
    - "…_03july2026_export" has 4,252 rows, all "None".
  - Its licence is a planning caveat ("created using publicly available data … limited or no direct input from …
    stakeholders"), not display terms. It has `SubmitByName`/`SubmitByEmail` columns.
  - The older `Evacuations_active_public` has 14 inactive rows edited 2020-06-15..08-31; the layer itself last changed
    2023-11-16.
  - The AZGeo "Arizona Evacuations Project" aims "to provide statewide, public, and near-real-time evacuation data". A
    launch was not found.
  - Verdict: **none (planning layer; status not maintained in the 2026 season)**. R10 re-checks in season.
- **North Carolina** NCEM `ReadyNC_PROD_Mandatory_Evacuations_180` (coastal hurricane zones and WebEOC): every query
  errors. Know Your Zone is hurricane-only.
- **Colorado** DHSEM: only per-fire layers (17 items), plus a large-fire map and a fire-restriction map.
- **Missouri** SEMA "NoticesAndEvacuations": 10 placeholder rows "No Evacuation Order", `publicview = No`. Showing them
  would be a false all-clear.
- **New Mexico** DHSEM `EM3628_Evacuations`: one declaration only.
- **North Dakota** DES "firemonitor": active fires with size and containment; its release does not mention
  evacuations.
- **Oklahoma** OEM situation updates and **Pennsylvania** PEMA daily reports list evacuations as text or PDF. Those are
  not machine-readable, and scraping is excluded.
- **Static hurricane, nuclear or planning zones:** MD, VA, SC, NC, CT, RI, DE, MA, ME, MS, AL, LA, NY.
- **County-only systems** (out of scope): St. Louis and Lake MN, Spokane WA, Coconino AZ, Blaine ID (planned). Many
  western counties use Genasys Protect (CONTRACT §12.6, needs agreements); Perimeter, Watch Duty and firerisk.ai are
  not official sources.

## 3. Gaps

| # | Gap | Grade | Evidence |
|---|---|---|---|
| G1 | Outside California the backend still queries Cal OES and answers `available` with zero zones and the Cal OES caveats | **BLOCKER** | `extras.py:633-669`; offline run for a Reno bbox: 2 Cal OES calls, `status` available, `coverage` [], both Cal OES caveats |
| G2 | No "not available in this state". The California rectangle (`model.ts:166-168`) sends point queries for 11 non-California places, which then read "No evacuation order or warning listed here · Cal OES · not an all-clear" (`location/official.ts:98`); farther points read "Cal OES lists evacuation zones in California only" (`:209`) | **BLOCKER** (decision 4) | offline run of today's model (section 10): Reno, Carson City, Stateline, Las Vegas, Klamath Falls, Ashland, Brookings, Yuma, Lake Havasu City, Bullhead City, Tijuana `none-listed`; Medford, Boise, Bozeman `not-checked` |
| G3 | No state lookup for a fire, bbox or point; `IncidentSummary` has no `state` | MISSING | `contracts.py:62-82`; backend.md R2/R3 add it |
| G4 | Cal OES wording hard-coded: 85 lines in 19 files, plus 57 test lines in 13 files | INCOMPLETE | section 1 |
| G5 | No Oregon adapter | MISSING | 2.1 |
| G6 | No local-officials' messages: `nws.py` reads only RFW/FWW in CA; no OpenFEMA | MISSING | `nws.py:50, :445` |
| G7 | Personal data in new sources (OR `Editor_*`, `created_user`, `last_edited_user`; AZ `SubmitBy*`; IPAWS `sender`); today `outFields=*` | INCOMPLETE (privacy) | `extras.py:610` |
| G8 | Times: one `retrieved_ms`/`source_updated_ms` per response misattributes a merged CA+OR or OR+WA answer; OR and WA give state-layer times, not issue times; WA manual rows are date-only (07:00Z = local midnight); several US zones | INCOMPLETE | CONTRACT §12.1; 2.1 |
| G9 | Washington: incomplete server chain (fix known), indemnity terms, 68 Active rows without a level, editable layer, daily lag | INCOMPLETE | 2.1 |
| G10 | Per-source behaviour hard-coded: limiter "Cal OES ArcGIS" (`:271`), confirm-drop re-query (`:613-617`), `issuing_authority` (`:625-626`), rebuild caveat (`:666`), `NOT_FIRE_SPECIFIC` (`evacuation.ts:263`) | INCOMPLETE | section 1 |
| G11 | Status mapping: `evac_status_key("No Evacuation Order") == "order"` (WA has 5 such rows, MO's template 10); null status → `unknown` → drawn as "other" | INCOMPLETE (must fix before any new source) | offline run; `style.ts:26-31` |
| G12 | `reason_code: not_covered` means "a California county not in the statewide layer"; "not available in this state" has no code of its own | MISSING | `extras.py:642-646`; `types.ts:6` |
| G13 | Border fires: OEM's `County` domain includes "Del Norte" (CA), so the same zone could come from two sources; no per-zone state, no dedup rule | MISSING (rare: 0 rows in 2026) | 2.1 |
| G14 | Docs and credits name Cal OES only: README `:81, :100-101, :123, :572-574, :666`; SPEC §2 (no evacuation row; NWS row `area=CA`), §6 `:309`; CONTRACT §12.1, §12.5, §12.6 | INCOMPLETE | CLAUDE.md "credit every source" |
| G15 | No way to exercise non-California evacuations: every local bundle is in California and the OR layer is empty until next season | MISSING (verification) | `data/incidents` |

## 4. One adapter shape (additive to CONTRACT §12.1 and the brief-2 I5 shape)

Keep `GET /api/extras/evacuations` and its envelope. Every change is additive, and California answers stay as they are.

```python
# backend/fire3d/sources/evacuations.py (new; extras.py keeps the route and calls it)
@dataclass(frozen=True)
class EvacAdapter:
    id: str                          # 'caloes_evacuations' | 'or_oem_evacuations' | 'wa_seoc_evacuations'
    home_state: str                  # 'CA' | 'OR' | 'WA'
    enabled: bool                    # WA: False until the user accepts its terms (Q-A) and the count check passes
    availability: Literal['available', 'partial']
    query_url: str
    out_fields: tuple[str, ...]      # explicit whitelist, never '*'
    where: str                       # WA: "status = 'Active' AND evactype IN ('Level 1 - Ready','Level 2 - Be Set','Level 3 - Go')"
    ttl_s: float                     # CA 120, OR 120, WA 1800
    limiter: fhttp.RateLimiter       # per host: services.arcgis.com (CA, OR) shared; wise.wamil.us its own
    tls_extra_ca: str | None         # WA: bundled DigiCert intermediate PEM, used for this host only
    confirm_drop: bool               # CA only (the 5-minute rebuild, extras.py:613-617)
    source: dict                     # SOURCES entry + 'credit' (the visible attribution text)
    issuing_authority: str           # replaces the literal at extras.py:625-626
    aggregator: str                  # 'Cal OES' | 'Oregon OEM' | 'Washington SEOC'
    standing_caveats: tuple[str, ...]   # CA: the rebuild caveat; WA: "Updated daily, may be out of date."
    normalize: Callable[[dict], dict | None]   # -> EvacZoneProps, or None to drop the row
    status_key: Callable[[dict], str]          # per-source mapping, unit-tested
    zone_state: Callable[[dict], str | None]   # county -> state; else regions.state_at(representative point)

STATE_AVAILABILITY: dict[str, dict]  # 48 + DC: {state, name, availability: 'available'|'partial'|'not_available',
                                     #  adapter_ids, note, audited: '2026-10-22', links: [{label, url}]}
# FL: not_available, note "Florida's state EOC lists county-level hurricane status only; not shown".
```

State lookup: backend.md R3's `fire3d/regions.py` (`states_in_bbox`, `state_at`) and
`backend/fire3d/data/us_states.geojson`. No second state file; the root `data/` is gitignored (`.gitignore:1`).

Response additions:
- `states: { state, name, availability, checked, source_ids, note, links }[]`: every state the bbox touches.
- Per-source fields in `sources[]`: `retrieved_ms`, `updated_ms`, `status` (`available` | `unavailable`), `reason`,
  `home_state`, `credit`.
  - The envelope `retrieved_ms`/`source_updated_ms` stay as they are when one zone source answered (every California
    answer).
  - They are `null` when several answered, and the UI then reads `sources[]`. Each issuer's times stay with it.
- `reason_code` gains `'state_not_available'`. Use the same code for the CAL FIRE record (backend R10) and cameras
  (backend R16). `not_covered` keeps its California-county meaning.
- Zone props:
  - `state`, `source_id`;
  - `status_verbatim` (false when Fire-3d renders the source's number), `status_raw`, `status_label`,
    `status_label_source`;
  - `incident_name` (the source's text; a name match is not proof that it is this fire), `hazard_type`;
  - `listed_ms` (the zone entered the state layer);
  - `time_basis`: `'issuer' | 'state_layer_added' | 'state_layer_edit' | 'date_only' | 'none'`.

Rules:
- The bbox touches no enabled adapter's state: `status: 'unavailable'`, `reason_code: 'state_not_available'`, reason
  "Official evacuation zones are not available in this state (Montana). Follow local officials." No upstream request.
  Outside the lower 48, the reason follows web W9's coverage wording.
- Mixed states (OR/CA, WA/ID, CA/NV): fetch each enabled adapter whose state the bbox touches and merge the features.
  Each uncovered state adds the caveat "Nevada: official evacuation zones are not available in this state". A failed
  source is `unavailable` in `sources[]` and never turns into "none".
- Partial (WA): standing caveat "Washington's state layer is updated daily and may be out of date; it can lag county
  orders." Show the required credit whenever WA zones are drawn.
- No zones in a checked state: the per-source "not an all-clear" caveat, never the source's own "no evacuations"
  sentence.
- Dedup: each zone gets its state from `zone_state`. If a zone's state has its own enabled adapter that answered for
  this bbox, keep that source's copy and drop the other. If that source failed, keep the other copy with its own
  source.
- Hazards: keep every hazard type, as Cal OES does today (no `EVENT_TYPE` filter). Show the type when it is not fire
  ("Evacuation for: Other, as recorded by Oregon OEM").
- Past dates: unchanged (`not_available_for_past_dates`), unless Q-B says otherwise.

Web (I5, `official/model.ts`):
- Add `EvacuationOfficial.state: 'not-available'` with `reason` "Not available in this state (Nevada)" and `links`.
- Remove `insideCalifornia` from the evacuation paths (`:160`, `:209`). For a point outside the fire's area, at the
  current time, always ask the backend. It answers from the registry with no upstream request, so the web holds no
  second copy of state boundaries.
- Issuer, aggregator, credit and `NOT_FIRE_SPECIFIC` ("<aggregator> does not say which fire this is for") come from
  `sources[]`. Times come from per-source fields.

| Zone prop | CA Cal OES (today) | OR OEM | WA SEOC |
|---|---|---|---|
| zone_id | `ZONE_ID` | `GlobalID` | `id` (else `objectid`) |
| zone_name | `ZONE_NAME` | `Evac_Area_Name` | – |
| status | `STATUS` (verbatim) | `"Level " + Fire_Evacuation_Level`, `status_verbatim: false`, `status_raw` the integer | `evactype` (verbatim) |
| status_label | – | OEM's definition (BE READY / BE SET / GO NOW – Leave Immediately!) + press-release URL | – (inside `evactype`) |
| status_key | `evac_status_key` (fixed, G11) | level 1/2/3 → advisory/warning/order | `evac_status_key(evactype)` |
| county | `COUNTY` | `County` + " County" (null in 2%: state from geometry) | `county`, "Asotin_County" → "Asotin County" |
| incident_name | – | `Fire_Name` (null in 51%) | `incidentna` |
| hazard / event_type | `EVENT_TYPE` | `HazardType` | – |
| notes | `NOTES`, `PUBLIC_INFO`, `CRITICAL_INFO` | – | – (`comments` is system text; at most a "compiled from the county layer" link) |
| link | inventory `Reference_App` | – | `incident_link` (https only; a bare InciWeb home page is not this zone's link) |
| status_updated_ms | `EDIT_DATE` (issuer) | null: OR gives no issue time | `level_<n>_active_date` for the current level, else null |
| listed_ms | `EditDate` (`aggregated_ms`) | `created_date` ("added to the Oregon state layer") | manual rows: `date_added`, `date_only` when it is local midnight; automated rows: null |
| layer edit | – | `last_edited_date` ("state layer recalculated") | `dateedited` ("state layer compiled") |
| never request | – | `Editor_Name`, `Editor_Email`, `Editor_Phone`, `created_user`, `last_edited_user` | anything not listed |

**Local officials' messages: a separate official kind, never zones (R7, per decision 5).**
- `GET /api/official/local-alerts?incident=&at_ms=` with the I7 envelope (`kind: 'local_alerts'`).
- Channels:
  - `nws_api`: live and the last 7 days, NWS NWEM event types;
  - `openfema_archive`: past days of 24 h or more. Prefetched in the background after a fire is prepared, cached on
    disk, never on the request path.
- `alerts[]` fields:
  - `id`, `channel`, `archived`;
  - `event`, `event_code`, `msg_type`, `references`;
  - `sender_name` (verbatim) and `sender_is_platform`;
  - `sent_ms`, `effective_ms`, `onset_ms`, `expires_ms`;
  - verbatim `headline`, `description`, `instruction`, `wea_text`, `wea_long_text`;
  - `web` (https only), `area_desc`, `same_codes`, `polygon | null`, `covers_reported_location`, `nearest_km`.
  - Never `sender`.
- Matching to a fire: by polygon when one is present. Otherwise by SAME county codes against the counties the fire's
  area touches, which needs a Census county boundary file (public domain) next to backend R3's states.
- Scope: FRW, EVI, SPW and CDW always; CEM and LAE only when the text mentions fire or evacuation.
- Card wording:
  - live: "Alert from <issuer>: "<verbatim text>" · sent <time in the fire's zone> · relayed by the National Weather
    Service · <link>";
  - then: "Fire-3d lists only the local alerts the National Weather Service relays; most are not relayed (about 1 in
    20 fire and evacuation alerts in 2024-26). No alert here is not an all-clear: follow local officials."
  - archived: "Archived copy from FEMA (OpenFEMA, published about a day later); FEMA does not validate message
    content", plus the required OpenFEMA notice. Replays can therefore list more than was visible live, and they say so.

## 5. Recommended changes

| # | Change | Value | Effort | Risk | Files | Priority |
|---|---|---|---|---|---|---|
| R1 | State registry + "not available in this state": backend makes no upstream call for uncovered states; `states[]`, `state_not_available`, per-source times; web `not-available` state; the rectangle removed from the evacuation paths | Fixes G1-G3, G8 (times), G12; decision 4 | M | Low; depends on backend R3 (`regions.py`, `fire3d/data/us_states.geojson`) | `backend/fire3d/sources/evacuations.py` (new), `api/extras.py`, `contracts.py`, `tests/test_extras.py`; `web/src/extras/types.ts`, `official/model.ts`(+test), `official/hooks.ts`, `location/official.ts`(+test), `ui/feed/OfficialNow.tsx`, `ui/shell/dataStatus.ts`, `ui/shell/officialSummary.ts` | **P0** |
| R2 | Oregon OEM adapter: mapping above, field whitelist, level rendering flagged non-verbatim, hazard labels, `created_date` vs `last_edited_date` wording, credit | The only live statewide feed outside CA | S-M | Low; empty off-season (recorded fixtures, section 6) | `sources/evacuations.py`, `tests/data/official/or_oem_*.json` (new) + `PROVENANCE.md`, tests | **P0** |
| R3 | Source-neutral wording from `sources[]`: every evacuation line of section 1 (17 non-test files; camera lines stay CA) and the 13 test/fixture files; California snapshots unchanged | Correct credit and issuer outside CA | M | Medium: many strings | section 1 list; overlaps web W7 | **P0** |
| R4 | Privacy: explicit `outFields` per adapter; never `sender`; a test asserts no key matching `email|phone|user|editor|creator|submit` leaves the backend | Keeps operators' personal data out | S | Low | `sources/evacuations.py`, `api/extras.py:610`, tests | **P0** |
| R5 | Fire-local time zone for zone and alert times; `time_basis` wording ("added to the Oregon state layer", "Washington state layer compiled", date-only "added Sep 30") | Brief 3 time rule; issuer times not overstated | S-M | Low (backend R2 `time_zone`, web.md 3.1) | `extras/evacuation.ts`, `official/model.ts`, `location/official.ts`, `extras/format.ts` | **P0** |
| R6 | Status mapping hardening, before any new source: negations ("no …", "not …") never map to order, warning or advisory; adapters drop placeholder and null-level rows; regression tests for "No Evacuation Order", "Not Reporting", "Level 1 - Ready", "Level 2 - Be Set", "Level 3 - Go", "Level 3", "Planning Zone", null | No false orders, no blank zones | S | Low | `api/extras.py:525-544` (or `sources/evacuations.py`), tests | **P0** |
| R7 | Local officials' messages (section 4): NWS NWEM live, OpenFEMA archive for past days; separate official kind; county matching by SAME | Covers part of the 45 states with no feed; decision 5 | M | Medium: thin live coverage (~5%), slow archive, noisy event codes | `sources/nws.py` (event list; national with backend R9), `sources/openfema.py` (new), `api/official.py`, `contracts.py`, `fire3d/data/us_counties*` (new, public domain), `web/src/official/*`, `ui/feed/*` | P1 |
| R8 | Docs and credits: README table and "Evacuation data" limits (`:572-574`, `:666`); SPEC §2 rows (OEM, WA SEOC, NWS NWEM, OpenFEMA) and §6 `:309`; CONTRACT §12.1 (new fields and code), §12.5 (OEM "Public"; WA attribution and indemnity; OpenFEMA notice), §12.6 (AZ planning layer, FL SERT, IPAWS feed, county systems), §14 | Every source credited (CLAUDE.md) | S | Low | `README.md`, `SPEC.md`, `docs/redesign/CONTRACT.md` | **P0** (with R1-R2) |
| R9 | Border rules: per-zone `state`, home-source dedup, tests for an OR/CA bbox at Brookings and a WA/ID bbox at Clarkston | No double zones at borders | S | Low | `sources/evacuations.py`, tests | P1 |
| R10 | Washington SEOC adapter, only if Q-A is "accept". TLS: a host-scoped trust with the bundled DigiCert intermediate (`backend/fire3d/data/certs/`), never verification off. Filter as section 4; label; credit; check again when the leaf renews (2026-11-26) | WA has the most fire alerts outside CA (266) | S-M | Medium: daily lag, editable layer, stale manual rows | `fire3d/http.py` (backend owner), `sources/evacuations.py`, tests | P1 |
| R11 | `backend/scripts/audit_evacuation_sources.py`: count-only check per registry source (reachable with verification on, `dataLastEditDate`, counts); AZ re-check in its May-July season | Keeps "available" honest | S | Low | `backend/scripts/` (new) | P2 |
| R12 | Oregon zones for past dates from OEM's history layer (only if Q-B is yes), labelled archived | Replay of 2026 Oregon fires | M | Medium: no licence text on that item, 5-min snapshots | `sources/evacuations.py`, tests | P2 |

No new dependency: httpx, certifi (already pulled in by httpx), shapely and orjson are present, and CAP parses with the
standard library. New bundled data: the DigiCert intermediate (1.2 KB) and a county boundary file for R7.

## 6. Verification path for builders (FIRE3D_LIVE=0, no Oregon bundle)

FIRE3D_LIVE=0 only stops the live loop. The extras routes still query their sources, so:
- **Backend tests** (offline):
  - Serve recorded samples through `fire3d.http._transport = httpx.MockTransport(...)`, or monkeypatch
    `_arcgis_features`.
  - Assert: Reno, Carson City, Las Vegas, Klamath Falls, Yuma and a Montana bbox make no upstream request and return
    `state_not_available`; a California interior bbox is unchanged; a Brookings OR/CA bbox merges and dedups; WA
    filters null-level rows; no personal keys appear.
- **Oregon fixture recipe** (history layer, a real season snapshot): `…/2026_Wildfire_Evac_History/FeatureServer/0/query?
  where=Fire_Name IN ('Fielders Mountain','HWY 229 Landslide') AND Date >= TIMESTAMP '2026-08-15 12:00:00' AND Date <
  TIMESTAMP '2026-08-15 12:05:00'&outFields=GlobalID,Fire_Name,Fire_Evacuation_Level,County,Evac_Area_Name,HazardType,
  created_date,last_edited_date,Date&outSR=4326&geometryPrecision=5&f=geojson`.
  - Tested: HTTP 200, 28 KB, 11 zones (levels 1/2/3; Jackson, Josephine and Lincoln counties; one non-fire hazard), bbox
    -123.974, 42.419, -123.131, 44.813.
  - Drop `Date` for a live-layer-shaped sample. Add a `Fire_Name` null case from the same snapshot.
- **Washington fixture** (if R10): `where` as section 4, the field whitelist, `f=geojson`, through the
  intermediate-aware client.
- **Web unit tests:** fixture responses in `extras/__fixtures__/samples.ts` (OR, WA, `state_not_available`, mixed CA+OR)
  and border-point tests in `official/model.test.ts` and `location/official.test.ts`. The scratch test in section 10
  is a template.
- **Browser** (count non-GET requests; never press "Prepare analysis"):
  - an address in Reno and one in Montana through the national Census address search: "not available in this state";
  - a Brookings point: OEM checked live, 0 zones off-season, "No evacuation order or warning listed here · Oregon OEM ·
    not an all-clear";
  - Oregon zones with content: an `extras-dev.html` preset fed by the recorded sample (dev page only), because the
    live layer stays empty until next season;
  - California regression: the Eaton and fixture screens against `docs/screenshots/audit3-web-official-eaton-command-desktop.png`.

## 7. Cross-references

- backend.md: R2 (`state`, `time_zone`), R3 (`regions.py`, `/api/geo/lookup`), R9 (national NWS), R10/R16 (CAL FIRE
  record and cameras answer "not available in this state": share `state_not_available`).
- web.md: G5/W7 (official UI outside CA, NWS rectangle gates `:393`, `:425`), W9 (coverage outside the lower 48),
  W10 (cameras), 3.1 (time zones).

## 8. Questions only the user can answer

Answered in round 2 (BRIEF-3): IPAWS registration → no (decision 5); past dates → OpenFEMA archive, labelled
(decision 5); Washington → yes if reliable, "updated daily, may be out of date" (decision 6); Florida → not shown
(decision 6); county feeds → out of scope (defaults). Still open:

1. **Q-A: Washington's terms.** By using the layer, "the user agrees to hold harmless, defend, and indemnify the State
   of Washington, the SEOC, participating counties …"; the data is "as-is". This is a legal promise made by whoever
   runs Fire-3d, and I cannot judge it for you.
   - (a) I accept these terms. Washington zones are shown, labelled "updated daily, may be out of date", with the
     required credit.
   - (b) I do not accept. Washington says "not available in this state"; its local officials' alerts still show (R7).
   - (c) Decide later. The adapter is built and tested offline but switched off, so Washington says "not available in
     this state" until you choose (a).
   - **Recommendation: (c) unless you are comfortable with (a).** It is also the default if there is no answer: no
     agreement is accepted for you.
2. **Q-B: Oregon zones for past dates.** OEM keeps a 5-minute history of its layer for 2026 (since July 1), but that
   item has no licence text at all.
   - (a) Yes: replay shows Oregon's past zones, labelled "archived copy from Oregon OEM's history layer".
   - (b) Not now: evacuation zones stay current-only everywhere (as in California); past days show the archived
     official alerts (decision 5).
   - **Recommendation and default: (b).** The terms are thinner than the live layer's, and replay of zones adds work to
     the build for one state.

## 9. Per-state table (47 states; California excluded)

Verdicts:
- **available**: official, statewide, public, machine-readable current status, with display allowed by its terms or
  licence, tested.
- **partial**: the same, but limited (daily cadence or county level).
- **none**: no such feed found. County or vendor systems, static planning zones, text or PDF reports and per-incident
  layers are noted in the evidence column.

Evidence for each row:
- `AGOL n`: hits from an ArcGIS Online search of public services for `(evacuation OR evacuations) AND "<State>"`;
- a keyword and owner review (sections 2.1 and 2.3);
- for 44 states, a logged web search for the state agency's map (section 10). OR, WA and FL were researched through
  their layers directly.

`IPAWS` counts fire-related FRW/EVI messages from 2024 to Oct 21, 2026 touching the state (OpenFEMA).

| State | Verdict | Evidence (2026-10-22) | IPAWS |
|---|---|---|---|
| Alabama | none | AGOL 21; Alabama EMA: hurricane zones/routes only | 1 |
| Arizona | none | DEMA EEZ planning layer, no edits after 2026-02-12, 11 stale Set/Go zones (2.3) | 34 |
| Arkansas | none | AGOL 12; ADEM: no map | 1 |
| Colorado | none | DHSEM: 17 per-fire layers, large-fire and restriction maps | 96 |
| Connecticut | none | AGOL 10; DEMHS: shoreline Know Your Zone, Millstone REP | 0 |
| Delaware | none | AGOL 18; DEMA: Know Your Zone locator (zones A-D) | 1 |
| Florida | partial, **not shown** (decision 6) | FDEM SERT county-level status, 87 rows "Not Reporting"; KYZ `STATUS` blank | 22 |
| Georgia | none | AGOL 25; GEMA: no map (news of Apr 2026 fires) | 24 |
| Idaho | none | AGOL 8; Idaho OEM: Ready-Set-Go adopted May 2026, sheriffs order; Blaine County map planned | 106 |
| Illinois | none | AGOL 21; IEMA: Ready Illinois only | 2 |
| Indiana | none | AGOL 6; IDHS: county travel-status map only | 1 |
| Iowa | none | AGOL 10; HSEMD: Alert Iowa, proclamations | 0 |
| Kansas | none | AGOL 6; KDEM: SEOC news; county orders | 16 |
| Kentucky | none | AGOL 15; KYEM: EM region map only | 0 |
| Louisiana | none | AGOL 27; GOHSEP: static hurricane plan maps | 1 |
| Maine | none | AGOL unrelated; MEMA: hurricane evacuation dashboard (static) | 2 |
| Maryland | none | MDEM Know Your Zone (hurricane zones A-C), no live status | 1 |
| Massachusetts | none | AGOL 35; MEMA: hurricane zones A-C | 0 |
| Michigan | none | AGOL 8; MSP EMHSD: no map | 1 |
| Minnesota | none | AGOL 16; HSEM: none; county maps (St. Louis 1,600 zones; Lake) | 13 |
| Mississippi | none | AGOL 19; MEMA: hurricane guides, MDOT routes | 2 |
| Missouri | none | SEMA template, 10 rows "No Evacuation Order", `publicview = No` | 0 |
| Montana | none | AGOL 9; DES: no map | 24 |
| Nebraska | none | AGOL 3; NEMA coordinates; county orders (Mar 2026) | 19 |
| Nevada | none | AGOL 10; NDEM: wildfire info page; counties' zones in Genasys | 46 |
| New Hampshire | none | AGOL 21; HSEM: ReadyNH, NH Alerts | 2 |
| New Jersey | none | AGOL 30; NJOEM: no verified map | 0 |
| New Mexico | none | DHSEM `EM3628_Evacuations` (one declaration); no map | 51 |
| New York | none | AGOL 54; DHSES: none; NYC hurricane zones | 0 |
| North Carolina | none | NCEM KYZ (hurricane) layer errors on query; ReadyNC hub | 7 |
| North Dakota | none | AGOL 7; DES firemonitor (size, containment; no evacuations) | 4 |
| Ohio | none | AGOL 10; Ohio EMA: plans only | 4 |
| Oklahoma | none | AGOL 9; OEM: text situation updates; Oklahoma EM sends IPAWS alerts | 93 |
| Oregon | **available** | OEM "Evacuation Areas Public": HTTP 200, count 0 off-season, licence "Public"; 2026 history 5.18 M rows | 179 |
| Pennsylvania | none | AGOL 19; PEMA: daily PDF reports | 3 |
| Rhode Island | none | AGOL 15; RIEMA: 2012-13 hurricane zones | 0 |
| South Carolina | none | SCEMD: hurricane/REP zones; no map | 1 (+8 CEM/LAE 2025) |
| South Dakota | none | AGOL 3; SD OEM: no map | 29 |
| Tennessee | none | AGOL 10; TEMA: no map | 2 |
| Texas | none | AGOL 136 (research, regional); TDEM: no map | 65 |
| Utah | none | DEM: no map; county zones in Genasys Protect, a vendor system (Genasys release; KJZZ on Washington County) | 49 |
| Vermont | none | AGOL 1; VEM: VT-Alert only | 0 |
| Virginia | none | VDEM hurricane KYZ ("updated July 2020"); VDOF fire map | 4 |
| Washington | **partial** (Q-A) | WA SEOC layer: 583 rows, 73 Active (5 with a level), daily; incomplete TLS chain (fix in R10); indemnity terms | 266 |
| West Virginia | none | AGOL 4; WVEMD: none; Forestry daily fire report | 1 |
| Wisconsin | none | AGOL 13; WEM: WebEOC restricted (TLP) | 2 |
| Wyoming | none | AGOL 5 (Washakie county view); OHS: no map | 41 |

DC has no fires of list size. Alaska and Hawaii are out of scope (decision 1); Alaska's `AK_State_Authoritative_nifc`
"Unorganized Alaska Evacuation Zones" layer is noted for later.

## 10. Evidence log (2026-10-22 UTC; GET only; 0 non-GET; no browser runs; no secrets involved)

First pass (20:45-21:40):
- ArcGIS catalogue: 60 queries at 1 per second (3 by views, 47 per state, 7 keyword, 3 owner/org); item JSON for 17
  items.
- OR: item, service and layer JSON 200; `returnCountOnly` at 20:49:16Z `{"count":0}`; history levels 1/2/3 had
  1,554,704 / 1,719,348 / 1,906,717 rows.
- FL SERT: count 87, all "Not Reporting", last EditDate 2026-07-28; KYZ layer 46: 199 rows, `STATUS` blank.
- NC: MapServer 200, 4 layer queries error -2147467259. MO: count 10.
- NWS: `/alerts/types` 111 types; `/alerts/active` for the 7 types at 20:59:08Z: 0; `/alerts`: 2 in 7 days.
- IPAWS feed `recent/2026-10-22T00:00:00Z`: 200, 3 alerts, no key.
- OpenFEMA: `$top=1` 200 in 0.8 s, 4,870,228 rows; FRW+EVI since 2024: 10.6 MB in 14.7 s; one `any()` filter: 503
  after 60 s.

Revision pass (22:00-22:40):
- Code: `evac_status_key` run offline:
  - "No Evacuation Order" → order;
  - "Not Reporting", "Mandatory Evacuation", "Voluntary Evacuation", "Ready", "Set", "Go", "No Evacuation in Place"
    → other;
  - "Level 1 - Ready" → advisory, "Level 2 - Be Set" → warning, "Level 3 - Go" → order.
- Offline backend run for a Reno bbox (upstream mocked as empty): calls "Cal OES county inventory" and "Cal OES
  evacuation layer"; `available`, 0 zones, both Cal OES caveats.
- Offline web model run (scratch vitest outside the repo; the backend's real answer shape for a non-CA point):
  - 11 points inside the rectangle → `none-listed`, "No evacuation order or warning listed here" · "Cal OES, checked
    just now · not an all-clear", and `needsStatewideFireWeather` true;
  - Medford (42.33° N), Boise and Bozeman → `not-checked`, "Cal OES lists evacuation zones in California only.";
  - all 14 link "Cal OES".
- WA:
  - `openssl s_client` via the proxy: wise.wamil.us chain depth 0 only (verify error 20/21); services.arcgis.com: 2
    certificates, verify 0;
  - DigiCert intermediate from cacerts.digicert.com: 200, 1,228 B;
  - httpx with certifi: `CERTIFICATE_VERIFY_FAILED`; with certifi + intermediate: service 200 (layer 5
    "Evacuation_Zones_Level", 22 fields);
  - counts 583 (`1=1`) and 73 (`status='Active'`); grouped stats as 2.1; active rows read without geometry, whitelisted
    fields; item JSON 200 (full licence).
- OR:
  - item, KML, WFS and StoryMap JSON, 3 catalogue searches;
  - history item and layer JSON; count 5,180,769;
  - grouped queries: by fire since Sep 20 (1 fire, Grasshopper); by Date/level for 2026-08-15 12:00-12:05 (22
    groups); County null/empty 101,432; "Del Norte" 0; `Fire_Name` null 2,630,502; hazard "Other" 15,741. One
    whole-layer grouping timed out with a 400 after 56 s;
  - one 28 KB geojson sample (11 zones; scratch only);
  - live count 0 at 22:34:16Z.
- AZ: 4 catalogue searches; 3 item JSON; both services' layer JSON, grouped by Status; the 12 non-"None" rows; the July
  export (4,252 "None"); `Evacuations_active_public` (14 rows, EditDate 2020-06-15..08-31, layer edit 2023-11-16).
  OpenFEMA 2026 AZ fire messages: 7 (from the first pass's download).
- Web: 47 WebSearch queries (44 states as in section 9, OR terms, Oregon GEOHub terms, Hatch Grade Fire). WebFetch:
  fema.gov IPAWS feed page (no MOA; updated June 9, 2026), ndresponse.gov firemonitor release (no evacuations). Not
  reached: omls.oregon.gov (503 and a reset).
- No browser run: the role's ports 8714 and 5184 were held by another session's servers during this pass, so the
  border check used the offline model run instead. No servers were started, and nothing was written to `data/`.
- Scratch files (outside the repository): `reno_flow.py`, `vt/border.scratch.test.ts`, `wa_tls.py`, `wa_active.py`,
  `az2026.py`, `websearch_log.md`, `dl/`.

## 11. Revision notes (after the independent review)

- Questions rewritten: the round-2 answers are recorded, and the two open questions (Washington's indemnity terms;
  Oregon history) each have options, a recommendation and a default.
- Washington:
  - full licence quoted (indemnification, as-is, compiled from county websites and feeds);
  - TLS root cause found (missing intermediate in the server's own chain, not the proxy), with a fix that keeps
    verification on;
  - layer read live (583 / 73 / 5 with a level; 68 rows with no level must be filtered).
- California rectangle: added as part of G2, with 11 border places verified offline. Border tests are in R1 and
  section 6.
- Florida county shape removed: Florida is not shown (decision 6), so the adapter has no county level. The status
  mapping finding is recorded.
- Per-source times, per-source behaviour fields (`confirm_drop`, `issuing_authority`, `aggregator`,
  `standing_caveats`, `tls_extra_ca`), the reason code `state_not_available` and the border dedup rule are added.
- Doc and credit updates are now R8, the verification path is section 6, and the Oregon fixture source and a tested
  query recipe are given.
- Oregon:
  - terms basis stated as "Public" only;
  - `last_edited_date` corrected to a recalculation time;
  - level rendering flagged as not verbatim, with a hazard-type rule;
  - personal-field list extended (`created_user`, `last_edited_user`).
- Arizona: the authoritative layer identified, the 2026 items explained as views or exports, verdict "none" kept on
  firmer evidence. Count corrected (11 Set/Go + 1 Planning) and dates reconciled.
- Corrections:
  - `outFields` is at `extras.py:610`;
  - the state file comes from backend R3 (`backend/fire3d/data/`), not the gitignored `data/`;
  - the IPAWS MOA remark is removed (not on FEMA's page);
  - the Cal OES list is complete (85 lines / 19 files; tests 57 / 13 by the same regex; the reviewer counted 52);
  - "blocked" merged into "none" (Utah).
- R7 rescoped by decision 5: no IPAWS feed, so no poller or store, and effort M. The reviewer's last point was cut off
  in the input; the visible part (effort, scope, poller) is addressed. The latent `evac_status_key` bug became R6, P0.
- Where the reviewer was not quite right:
  - its caveat that the sandbox re-terminates TLS does not apply to this host: the chain seen carries DigiCert's
    issuer, and arcgis.com shows a full chain through the same proxy, so the result reflects the server;
  - Arizona's 2026 items did not change the verdict;
  - the Del Norte border duplicate is possible but did not occur in 2026 (0 rows).
