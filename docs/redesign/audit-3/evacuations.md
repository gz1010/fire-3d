# Audit 3: official evacuation data for the lower 48 states

Role `audit-evacuations` (brief 3, stage A). Research only: no project code changed, no servers started, no fire built.
All requests were polite GETs (descriptive User-Agent, count-only or small queries) on **2026-10-22, 20:45-21:40 UTC**.
The evidence log is in section 8.

## 0. Summary

- **One state has a usable statewide feed today: Oregon.** Oregon Department of Emergency Management (OEM) runs
  "Evacuation Areas Public", a live statewide ArcGIS layer. It is fed by counties, Genasys Protect, Perimeter and
  Clackamas/Deschutes integrations every 5-15 min, and its licence field says "Public".
- **Two states are partial:**
  - Washington: the State EOC aggregates county levels into one layer, but it is "updated daily", and its server's TLS
    chain fails from this sandbox, so it is unverified.
  - Florida: the state EOC (FDEM SERT) lists evacuation status per county, not per zone. It is hurricane-oriented and
    every county reads "Not Reporting" today.
- **The other 44 states have none** (43 "none", Utah "blocked"): no state-run, public, machine-readable feed of
  current evacuation zones or orders. Some have only static hurricane "Know Your Zone" layers, dormant or stale layers, or per-incident
  layers. County zones in much of the West live in Genasys Protect, a vendor system that needs agreements (blocked).
- **The national channel that would cover most states is FEMA IPAWS:**
  - Local officials' "Fire Warning" and "Evacuation Immediate" messages are archived by OpenFEMA: 1,213 fire-related
    messages in 38 lower-48 states outside California, 2024 to Oct 21, 2026. About 84% carry a polygon.
  - Live, they appear on the IPAWS public feed. It answers without a key, but FEMA asks consumers to register: that
    is a user decision (question Q1).
  - The NWS API relays only about 5% of them: only messages whose senders leave the NWS channel open.
  - OpenFEMA's archive is published 24 h late, so it suits past dates only.
- **Blocker in today's code:** outside California the backend still queries Cal OES. It answers `available` with zero
  zones, and the UI then says "No orders or warnings are listed within 15 km of this fire … via Cal OES". For a fire in
  Montana that reads as a check that never happened. It must become "not available in this state" (section 3, G1).

## 1. What exists today (California only)

Backend (`backend/fire3d/api/extras.py`, offline tests in `backend/tests/test_extras.py`):
- Sources:
  - `:69-71`: the Cal OES layer `CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0` and the `County_Evacuation_Inventory_Public`.
  - `:113-137`: their `SOURCES` metadata (name, publisher, url, licence, terms_url, attribution, disclaimer, cadence).
  - `:83-84`: caching, 120 s for zones and 24 h for the inventory.
  - `:271`: one rate limiter `UP_ARCGIS` ("Cal OES ArcGIS", 60/min).
- `evac_status_key()` `:525-544` maps any wording to a styling key. It already understands "level 1/2/3", "go now",
  "be set" and "be ready", so Oregon and Washington wording maps without change. The wording itself stays verbatim.
- `normalize_zone()` `:553-582` reads these Cal OES fields: `STATUS`, `ZONE_ID`, `ZONE_NAME`, `COUNTY`, `CITY`,
  `EVENT_TYPE`, `NOTES`, `CRITICAL_INFO`, `PUBLIC_INFO`, `EDIT_DATE` (issuer edit) and `EditDate` (Cal OES copy).
- `_evac_zone_features()` `:604-620` caches per bbox and confirms a sudden drop in the count once, because of the
  5-minute rebuild.
- `evacuations_payload()` `:623-670`:
  - a past time or a historical fire gives `not_available_for_past_dates` (`:628`);
  - counties missing from the inventory give `unavailable`/`not_covered` (`:642`);
  - no zones gives `available` + "No orders or warnings are listed here right now. That is not an all-clear" (`:668`).
- Route: `GET /api/extras/evacuations` `:673`. Envelope and zone props are in CONTRACT §12.1. Terms are in §12.5, and
  Genasys is blocked in §12.6.

Web:
- Types:
  - `web/src/extras/types.ts:23-39` `ExtrasEnvelope`;
  - `:45-65` `EvacZoneProps`;
  - `:75-91` `EvacCountyCoverage` / `EvacuationsResponse`.
- `web/src/extras/ExtrasSync.tsx:61` fetches the incident query whatever the layer toggle says.
- I5 brief-2 official shape: `web/src/official/model.ts`.
  - `EvacuationOfficial` states are `listed | none-listed | not-checked | past-date | unavailable | loading`.
  - `evacuationNow()` `:114`.
  - `needsPointQuery()` `:158` and `insideCalifornia()` `:166`.
  - `evacuationAtPointState()` `:195` returns "Cal OES lists evacuation zones in California only." outside California
    (`:209`).
- "Cal OES" is hard-coded in 83 lines across 19 web files. Among them:
  - `extras/evacuation.ts` (15; `NOT_FIRE_SPECIFIC` `:263`, feed `source` `:410`);
  - `official/model.ts` (19);
  - `ui/feed/OfficialNow.tsx` (9, e.g. `:71` "via Cal OES", `:134`);
  - `location/official.ts` (9, e.g. `:98`, `:154`);
  - `ui/shell/dataStatus.ts` (6);
  - `extras/credits.ts:17`.
- NWS: `backend/fire3d/sources/nws.py:50` `FIRE_EVENTS` (Red Flag Warning, Fire Weather Watch only), and `:445`
  `area=CA`. It is the natural home for national alert types (section 2.2).

## 2. Findings

### 2.1 State feeds that exist

**Oregon: available.** OEM, "Evacuation Areas Public".
- Item `dd2bee51e3004dc4b1004df34fbd9e29`, owner `Oregon_OEM`; `accessInformation` "Oregon Department of Emergency
  Management"; `licenseInfo` "Public".
- Service: `https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/Fire_Evacuation_Areas_Public/FeatureServer/0`
  (polygons, maxRecordCount 1000).
- Description (quoted): "Statewide evacuation layer - showing current evacuations issued across Oregon. Data is
  entered by local/tribal/state GIS staff … Data updated as information is entered into the hosted feature service."
- Integrations: Clackamas and Deschutes "updates every 5 minutes"; Genasys "for zones not in a normal status, updates
  every 5 minutes"; Perimeter (synced); the OEM upload utility "updates every 15 minutes".
- Fields:
  - `Fire_Evacuation_Level` (integer 1-3, no wording);
  - `Fire_Name`, `Evac_Area_Name`, `County` (domain of 36 Oregon counties + "Del Norte", CA);
  - `HazardType` (Earthquake, Fire, Flood, Tsunami, Nuclear, Other);
  - `created_date`, `last_edited_date`;
  - `StructuresWithin`, `AddressesWithin`, `PopulationWithin`;
  - **`Editor_Name`, `Editor_Email`, `Editor_Phone`: personal data, never request them.**
- Test: count 0 today. `dataLastEditDate` 2026-09-29T18:42Z, a minute after the history layer's last snapshot
  (2026-09-29T18:41Z), so the season's last zones were most likely removed then.
- Proof of use: OEM's "2026 Wildfire Evac History" holds 5.18 M snapshot rows from 2026-07-01 to 09-29, with 61
  distinct fire names.
- Level wording: from OEM's own definitions (press release, May 28, 2024,
  `https://www.oregon.gov/oem/Documents/NR-052424-2024_Evacuation_Preparedness_Release_EN.pdf`):
  - "Level one (green on a map) means BE READY to evacuate";
  - "Level two (yellow on a map) means BE SET to evacuate";
  - "Level three (red on a map) means GO NOW – Leave Immediately!".
- Note: the item says "If there are no records in this dataset, there are no evacuations currently in place."
  Fire-3d must **not** repeat that: absence is never an all-clear.

**Washington: partial, unverified.** WA State EOC (Military Dept / EMD), "Evacuation_Zone_Level".
- Item `cee84395f08a4d32b2ae128e8f149cd3`, owner `waseocgis`.
- Service: `https://wise.wamil.us/bmw/rest/services/Hosted/Evacuation_Zone_Level/FeatureServer/5`. The public viewer
  map `834177125919449ba694c49518bc12e2` filters it with `status = 'Active'`.
- Cadence: the description says "processed and updated daily". The snippet, by contrast, says "near-real-time".
- Licence (quoted):
  - "there may be a temporary lag between an official county-level evacuation order and the representation on this
    layer";
  - "Do not rely solely on this map layer for immediate life-safety decisions";
  - "Users are permitted to view, request, share, and integrate this layer into public-facing applications, provided
    that the data source is properly credited";
  - required credit: "Washington State SEOC and Participating County Emergency Management Agencies";
  - "No Endorsement".
- Fields (from the state's viewer popup; the live service could not be read):
  - `id`, `incidentna`, `evactype` ("Level 1 - Ready" | "Level 2 - Be Set" | "Level 3 - Go"), `county`, `status`
    (Active | Inactive);
  - `date_added`, `dateedited`;
  - `level_{1,2,3}_active_date`, `level_{1,2,3}_inactive_date`, `level_{1,2,3}_reduction_date`;
  - `comments`, `incident_link`.
- Test: the TLS chain does not verify. curl gives error 60 "unable to get local issuer certificate", Python/httpx gives
  `CERTIFICATE_VERIFY_FAILED`, and WebFetch gives 503 (twice). The same proxy verifies arcgis.com, so the server's
  chain looks incomplete. Fire-3d must not disable TLS verification. It needs a check from the user's machine (Q2).

**Florida: partial (county-level, hurricane-oriented).** FDEM SERT, "SERT - Evacuations and Curfews".
- Item `c64b6755aee247c8aef0f258e6d2dd52`. Service:
  `https://services.arcgis.com/3wFbqsFPLeKqOlIK/arcgis/rest/services/SERT_EvacCurfew2026/FeatureServer/0`.
- It is "WebEOC-connected" and tracks "evacuation, curfew, and reentry order status".
- Fields:
  - `agency` (county), `evacuation_status`;
  - `evacuation_last_update`, a string such as "04/13/2026 10:05:54" with **no time zone** (Florida spans Eastern and
    Central);
  - `evacuation_info`, `evacuation_comments`, `url`, `incidentid`;
  - personal or internal: `subscribername`, `positionid`, `Creator`, `Editor`.
- Test: 87 rows, all `evacuation_status = "Not Reporting"`; last `EditDate` 2026-07-28.
- Licence (quoted): "intended for informational use only … not authoritative for navigation, engineering, legal …
  FDEM provides this data 'as is'".
- The polygons are whole counties, not zones.
- FDEM's "Know Your Zone" layer (`KYZ_ZL_Vector_Enriched_Calculated_20230608/FeatureServer/46`, 199 hurricane zones)
  has a `STATUS` ("Current Evacuation Order") field. It is blank everywhere, and its `Edit_Date` is the string
  "9/18/2015".

### 2.2 National official channels (they carry local officials' messages, not zone maps)

What such a message is:
- an official alert written by a local authority (sheriff, county emergency management, a state on its behalf), sent
  through FEMA IPAWS to phones (WEA), broadcasters (EAS), NOAA Weather Radio (via NWS) and the public feed;
- often with a drawn polygon.

What it is not:
- an evacuation-zone map, a complete list of orders (many are given by text, phone, door-to-door or county websites
  only), or anything Fire-3d wrote or checked;
- its absence is **not** an all-clear.

| Channel | Terms (official page) | Latency | Geometry | Issuer fields | Fit |
|---|---|---|---|---|---|
| **IPAWS public feed** (All-Hazards Information Feed), `apps.fema.gov/IPAWSOPEN_EAS_SERVICE/rest/public/recent/<ISO time>` | fema.gov "IPAWS All-Hazards Information Feed" (updated June 9, 2026): "Access … is free of charge"; "Please register for an account on the IPAWS User Portal"; "Alerts cannot be used for advertising purposes"; "Providers cannot stress IPAWS servers with excessive requests". Search summaries also mention an MOA. | Real time; "Alerts are active on the feed for 30 minutes or until they expire" → Fire-3d must poll (≈60-120 s) and keep its own store | CAP `<polygon>` in ~84% of fire FRW/EVI; SAME county codes always | `senderName` (free text: "Oklahoma Emergency Management", "201057,Public - Chelan County, WA,CHELAN COUNTY", or a platform name "Public Alert System" in 18%); `sender` is an operator email/username: **never show** | Best coverage: 98% of 2024-26 FRW/EVI did not block the PUBLIC channel. Test: HTTP 200, 3 alerts, no key. Needs the user's decision (Q1) |
| **NWS API** `api.weather.gov/alerts` (event types `Fire Warning`, `Evacuation Immediate`, `Civil Danger Warning`, `Civil Emergency Message`, `Shelter In Place Warning`, `Local Area Emergency`, `Law Enforcement Warning` exist in `/alerts/types`) | Public domain (weather.gov/disclaimer, already credited in `nws.py:76-78`); NWEMs are sent by "Federal, state, local, tribal and territorial public safety officials … through FEMA IPAWS" (weather.gov/dsb/nonweatheralerts) | Real time; history only about 7 days | None seen: both NWEMs this week had `geometry: null`, `affectedZones: []`, only SAME codes | `senderName` as IPAWS ("Public Alert System" for the LA County Bryson Fire CEM on 2026-10-16); `code: IPAWSv1.0` | Only ~5% of FRW/EVI (122 of 2,233) left the NWEM channel open, so it is a thin stopgap. Test: 0 active, 2 in the last 7 days (an LA County CEM about the Bryson Fire; an Indiana missing-child LAE) |
| **OpenFEMA "IPAWS Archived Alerts" v1** `fema.gov/api/open/v1/IpawsArchivedAlerts` | OpenFEMA terms (updated Jan 22, 2025): required notice "This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA"; no FEMA/DHS logos. Dataset page (updated Oct 22, 2026): "published with a twenty-four (24) hour delay"; "FEMA does not validate the content of each message"; "not intended to be an official federal report" | 24 h (latest record 2026-10-21T20:49Z at run 2026-10-22T21:00Z) | Full CAP incl. polygons | Same as the feed + `cogId`; `sender` emails present despite the "no personally identifiable information" claim | Past dates and validation only. Nested filters are slow (15-60 s; one 503 after 60 s) |

How often wildfires use these messages (OpenFEMA, `status eq 'Actual'`, Jan 1, 2024 to Oct 21, 2026):
- Totals: 2,233 unique Fire Warning (FRW) + Evacuation Immediate (EVI) messages. Fire-related, outside California:
  1,213 (2024: 293, 2025: 341, 2026: 579), in 38 states; 16 states had some in each year.
- Top states: WA 266, OR 179, ID 106, CO 96, OK 93, TX 65, NM 51, UT 49, NV 46, WY 41.
- 2025 Civil Emergency Message / Local Area Emergency add 33 wildfire evacuation messages (e.g. SC Greenville/Pickens,
  2025-03-26). Civil Danger Warning had none, and Shelter In Place Warning had 0 messages of any kind.

Real examples:
- 2024-02-27, Oklahoma Emergency Management, EVI "Slapout Beaver County Fire Evacuation".
- 2024-06-12, Washoe County NV, EVI "WILDFIRE in area North Valleys. EVACUATE NOW …".
- 2025-03-26, Polk County NC, EVI "Leave area NOW. Wildfire in this area.".
- 2025-03-20, El Paso County Sheriff CO: FRW "EVACUATION ORDER for FIRE near 27000 Sanborn Rd", then Cancel "… has
  been LIFTED".
- 2026-02-25, "IPAWS TSSF Alert on Behalf of CO Colorado Division of Homeland Security and Emergency Management", EVI
  "Sterling Fire. Immediate evac …".
- 2026-08-01, Madison County Sheriff ID, FRW "… GO Evacuate!".

Caveats seen in the data:
- 5 "TEST" texts sent as `Actual`.
- "Burn Ban" and "Red Flag Warning" texts sent as FRW. Event codes do not prove an evacuation: show the text verbatim
  and never class it.
- 53% have an empty `description`; the text is in `CMAMtext`/`CMAMlongtext` (WEA, 90/360 characters).
- Only 6% carry a `web` link.
- One CEM is stamped `+01:00` with `timezone: EST` for Los Angeles. Convert the instant to the fire's local zone; never
  show the raw offset.

### 2.3 Searched and not usable (detail in the table)

- **Arizona.** AZ DEMA `Evacuations_active_public`: 14 rows, all `activeincid = No`, edits from 2020. AZ DEMA statewide
  "Emergency Evacuation Zones": 4,252 zones; 12 zones still read "Go"/"Set" since 2025-09-25, and there is a "TEST"
  row. Its licence text is a planning caveat, not display terms, and it has `SubmitByEmail`/`SubmitByName` columns.
- **North Carolina.** NCEM `ReadyNC_PROD_Mandatory_Evacuations_180` (coastal hurricane zones joined to WebEOC): every
  layer answers "Invalid definition expression".
- **Colorado.** DHSEM: only per-fire layers (Willow, Aspen Acres, Gold Mountain, Leroux, 2025-26).
- **Missouri.** SEMA "NoticesAndEvacuations": 10 placeholder rows "No Evacuation Order", `publicview = No`; showing
  them would be a false all-clear.
- **New Mexico.** DHSEM `EM3628_Evacuations`: one declaration only.
- **Maryland, Virginia, South Carolina.** Static hurricane or nuclear-plant zones.
- **Vendors.** Genasys Protect (blocked, CONTRACT §12.6). Utah counties use it: Genasys press release and KJZZ news on
  Washington County. Perimeter (vendor), Watch Duty and firerisk.ai (not official) are not sources.

## 3. Gaps

| # | Gap | Grade | Evidence |
|---|---|---|---|
| G1 | Outside California the backend still queries Cal OES and answers `available` + zero zones. The UI then shows `none-listed`, "No orders or warnings are listed within 15 km of this fire right now … via Cal OES" (`official/model.ts:114-133`, `OfficialNow.tsx:71`). That is an implied check for a state nobody checked | **BLOCKER** | `extras.py:633-669` (empty inventory → `coverage == []` skips `:642`) |
| G2 | No "not available in this state" state or wording anywhere; points outside California read "Cal OES lists evacuation zones in California only." | **BLOCKER** (brief decision 4) | `official/model.ts:166, :209`; `location/official.ts:105` |
| G3 | No per-state availability metadata or state lookup for a fire, bbox or point; `IncidentSummary` has `county` but no `state` | MISSING | `contracts.py:62-82` |
| G4 | Source wording is Cal OES-specific (83 lines, 19 web files; credits, freshness, feed `source`, `NOT_FIRE_SPECIFIC`) | INCOMPLETE | section 1 |
| G5 | No adapter for Oregon (live, public) | MISSING | 2.1 |
| G6 | No national official-message channel (IPAWS / NWS NWEM); `nws.py` reads only Red Flag Warning / Fire Weather Watch in CA | MISSING | `nws.py:50, :445` |
| G7 | New sources carry personal data (OR `Editor_*`, AZ `SubmitBy*`, IPAWS `sender`, LAE missing-child texts); today's code requests `outFields=*` | INCOMPLETE (privacy) | `extras.py:609` |
| G8 | Times: OR/WA give editor or integration edit times, not issue times; FL gives zone-less strings; several US zones. Zone times must render in the fire's zone and say what the time is | INCOMPLETE | 2.1; brief 3 "never assume Pacific time" |
| G9 | Washington service cannot be verified from the cloud (TLS); its cadence is daily | INCOMPLETE | 2.1 |
| G10 | Rate limiter and caches are named and sized for one host (`UP_ARCGIS` "Cal OES ArcGIS") | INCOMPLETE | `extras.py:271` |

## 4. One adapter shape (matches CONTRACT §12.1 and the brief-2 I5 shape)

Keep `GET /api/extras/evacuations` and its envelope; every change is additive.

```python
# backend/fire3d/sources/evacuations.py (new; extras.py keeps the route and calls it)
@dataclass(frozen=True)
class EvacAdapter:
    id: str                      # 'caloes_evacuations' | 'or_oem_evacuations' | 'wa_seoc_evacuations' | 'fl_sert_evacuation_status'
    states: tuple[str, ...]      # USPS codes covered: ('CA',) / ('OR',) / ('WA',) / ('FL',)
    level: Literal['zone', 'county']
    query_url: str
    out_fields: tuple[str, ...]  # explicit whitelist: never '*', never editor/creator/email/phone/subscriber
    where: str                   # '1=1' | "status = 'Active'"
    ttl_s: float                 # CA 120, OR 120, WA 1800, FL 300
    limiter: fhttp.RateLimiter   # one per host (services.arcgis.com shared; wise.wamil.us its own)
    source: dict                 # today's SOURCES entry: name, publisher, url, license, terms_url, attribution, disclaimer, cadence
    normalize: Callable[[dict], dict | None]   # -> EvacZoneProps (+ additive props below)

STATE_AVAILABILITY: dict[str, dict]  # all 48 + DC: {state, name, availability: 'available'|'partial'|'not_available'|'unsupported',
                                     #  adapter_ids, note, audited: '2026-10-22', links: [{label, url}]}
```

Response additions (`EvacuationsResponse`, `web/src/extras/types.ts`):
- `states: { state, name, availability, checked: boolean, source_ids, note }[]`: every state the bbox touches. A
  bundled Census cartographic state boundary file (public domain) tells which states a bbox or point touches.
- Zone props, additive:
  - `state`, `source_id`;
  - `status_label` (OR only: OEM's own definition for the level number, with `status_label_source` = the OEM URL);
  - `incident_name` (the source's wording; a name match is not proof that it is this fire);
  - `hazard_type`;
  - `time_basis`: `'issuer' | 'source_edit' | 'none'`.

Status rules:
- The bbox is only in `not_available` states: `status: 'unavailable'`, `reason_code: 'not_covered'`, reason "Official
  evacuation zones are not available in this state (Montana). Follow local officials." Nothing is fetched.
- Mixed states (border fires, e.g. OR/CA, WA/ID): fetch each available adapter, merge the features (each keeps
  `source_id`), list each source in `sources`, and add the caveat "<State>: not available in this state." per
  uncovered state.
- `partial` adds its limit as a caveat:
  - WA: "Compiled daily by the Washington SEOC from county sources; it can lag county orders."
  - FL: "County-level status reported to the Florida state EOC, not zone maps."
- No zones in a checked state: today's "not an all-clear" caveat, never the source's own "no evacuations" sentence.
- Past dates: unchanged (`not_available_for_past_dates`).

Web (I5, `official/model.ts`):
- Add `EvacuationOfficial.state: 'not-available'` with `reason` "not available in this state (<State>)" and
  `links` (the state's official page, if any).
- Replace `insideCalifornia` by `states[]` from the response, or by the same state lookup for points.
- `issuer`/credit text come from `sources[].attribution`, not literals.

| Zone prop | CA Cal OES (today) | OR OEM | WA SEOC | FL SERT (county) |
|---|---|---|---|---|
| zone_id | `ZONE_ID` | `GlobalID` | `id` | `dataid` |
| zone_name | `ZONE_NAME` | `Evac_Area_Name` | – | `agency` |
| status (verbatim) | `STATUS` | `"Level " + Fire_Evacuation_Level` (the source gives a number only) | `evactype` | `evacuation_status` ("Not Reporting" → `unknown`, not drawn) |
| status_label | – | OEM: BE READY / BE SET / GO NOW – Leave Immediately! | – (inside `evactype`) | – |
| status_key | `evac_status_key()` | same (level 1/2/3 → advisory/warning/order) | same | same |
| county / jurisdiction | `COUNTY` | `County` (+ "County"; CA "Del Norte" possible) | `county` | `agency` |
| incident_name | – | `Fire_Name` | `incidentna` | `incidentid` |
| event_type | `EVENT_TYPE` | `HazardType` | – | – |
| notes / public_info | `NOTES`, `PUBLIC_INFO`, `CRITICAL_INFO` | – | `comments` | `evacuation_info`, `evacuation_comments` |
| link | inventory `Reference_App` | – | `incident_link` (https only) | `url` (https only) |
| status_updated_ms | `EDIT_DATE` (issuer) | `last_edited_date` (`time_basis: source_edit`: an editor or integration edit) | `level_<n>_active_date` for the current level, else `dateedited` | none: `evacuation_last_update` shown as text, zone not stated |
| aggregated_ms | `EditDate` | – | `date_added` | `EditDate` |
| filter | – | – | `status = 'Active'` | – |
| never request | – | `Editor_Name`, `Editor_Email`, `Editor_Phone`, `created_user`, `last_edited_user` | anything not listed | `subscribername`, `positionid`, `Creator`, `Editor` |

**National messages: a separate official kind, never zones.**
- `GET /api/official/local-alerts?incident=&at_ms=` with the I7 envelope (`kind: 'local_alerts'`).
- `alerts[]` fields:
  - `id`, `channel: 'ipaws_feed' | 'nws_api' | 'openfema_archive'`, `archived`;
  - `event`, `event_code` (SAME), `msg_type` (Alert / Update / Cancel), `references`;
  - `sender_name` (verbatim), plus `sender_is_platform` (true for names like "Public Alert System"; the UI then says
    "The sending system did not name the office; the message text names the issuer");
  - times: `sent_ms`, `effective_ms`, `onset_ms`, `expires_ms`;
  - text, verbatim: `headline`, `description`, `instruction`, `wea_text`, `wea_long_text`;
  - `web` (https only), `area_desc`, `same_codes`, `polygon | null`, `covers_reported_location`, `nearest_km`.
- Never return `sender`.
- Scope: FRW, EVI, SPW and CDW always. CEM and LAE only when the text mentions fire or evacuation. The panel says which
  types it lists.
- Live alerts come from the IPAWS feed, plus NWS NWEMs deduplicated by CAP identifier, sent time and sender. They are
  stored on arrival like `calfire_history`, because they leave the feed after 30 min. Past dates come from OpenFEMA,
  labelled "archived copy, published by FEMA 24 h later".
- Card line: "Alert from <issuer>: "<verbatim text>" · sent <time in the fire's zone> · via FEMA IPAWS · <link>".
  Then: "This is an official message, not an evacuation-zone map. Other notices may not be listed. No message here
  is not an all-clear: follow local officials."
- Links: the issuer's `web` when given, the NWS API record for NWS items, and the OpenFEMA record for archived items.
  The live IPAWS feed has no per-message public page (Q1).

## 5. Recommended changes

| # | Change | Value | Effort | Risk | Files | Priority |
|---|---|---|---|---|---|---|
| R1 | State availability registry + state lookup. Backend: no Cal OES call outside CA; `states[]`; "not available in this state". Web: `not-available` state replaces `insideCalifornia` | Fixes G1-G3; the brief's decision 4 | M | Low; needs a state boundary file (Census, public domain, ~100 KB) | `backend/fire3d/sources/evacuations.py` (new), `api/extras.py`, `data/us_states*.json` (new), `tests/test_extras.py`; `web/src/extras/types.ts`, `official/model.ts`(+test), `location/official.ts`, `ui/feed/OfficialNow.tsx`, `ui/shell/dataStatus.ts`; SPEC §6, CONTRACT §14 | **P0** |
| R2 | Oregon OEM adapter (mapping above, field whitelist, level labels quoted from OEM) | The only live statewide feed outside CA | S | Low; source empty off-season (test with recorded samples) | `sources/evacuations.py`, `tests/data/official/or_oem_*.json` (new), tests | **P0** |
| R3 | Source-neutral wording: issuer and aggregator from `sources[]`; `NOT_FIRE_SPECIFIC` per source ("<aggregator> does not say which fire this is for") | Correct credit outside CA | M | Medium: many strings; keep CA snapshots unchanged | the 19 web files of section 1, `extras/credits.ts`, `extras/evacuation.ts` | **P0** |
| R4 | Privacy: explicit `outFields`; drop IPAWS `sender`; tests assert that no `email`/`phone` key leaves the backend | Prevents publishing operators' personal data | S | Low | `sources/evacuations.py`, tests | **P0** |
| R5 | Fire-local time zone for zone and alert times + `time_basis` wording ("edited in the state layer", "time not stated") | Brief 3 time-zone rule | S-M | Low (shared with the web-us audit) | `extras/evacuation.ts`, `official/model.ts`, `location/official.ts`, `extras/format.ts` | **P0** |
| R6 | Washington SEOC adapter, after Q2 (TLS check on the user's machine; "compiled daily" caveat) | WA is the busiest non-CA state for alerts (266) | S | Medium: daily lag, editable layer, TLS | `sources/evacuations.py`, tests | P1 |
| R7 | National local-alert messages (IPAWS feed + NWS NWEM), separate official kind (section 4) | Covers the 38 states with no feed | L | Medium: registration (Q1), 30-min feed needs a poller and store, noisy event codes | `sources/ipaws.py` (new), `sources/nws.py` (event list, all states), `api/official.py`, `contracts.py`, `web/src/official/*`, `ui/feed/*` | P1 |
| R8 | Past dates (Q4): OpenFEMA IPAWS archive (all states) and OEM "Evac History" (OR) as labelled archived copies | Replay shows what officials said | M | Medium: slow queries; must never look current | `sources/ipaws.py`, `sources/evacuations.py`, `api/official.py` | P2 |
| R9 | Florida SERT as a text-only county list, no polygons (Q3) | Only state signal in FL | S | Medium: "Not Reporting" ≠ none; hurricane focus | `sources/evacuations.py`, web panel | P2 |
| R10 | `scripts/audit_evacuation_sources.py`: count-only check of each registry source (reachable, `dataLastEditDate`), run before releases | Keeps "available" honest | S | Low | `backend/scripts/` (new) | P2 |

No new dependency is needed. Shapely, httpx and orjson are already used, and CAP XML parses with the standard library.

## 6. Questions only the user can answer

1. **Q1: IPAWS public feed.** FEMA's page asks consumers to "register for an account on the IPAWS User Portal",
   although the endpoint answered without a key.
   - (a) You register (your name and organisation), then Fire-3d adds live IPAWS messages.
   - (b) No registration: use only the NWS relay (~5% of messages) live and the OpenFEMA archive (24 h late) for past
     dates.
   - (c) No national messages for now.
2. **Q2: Washington.** Its layer is compiled daily and its certificate chain fails from the cloud.
   - (a) Add it with a "compiled daily, may lag" label once it loads on your machine.
   - (b) Skip it and show "not available in this state".
3. **Q3: Florida.** County-level, hurricane-oriented status.
   - (a) Show it as a text list ("as reported to the Florida state EOC").
   - (b) Treat FL as "not available in this state".
4. **Q4: Past dates.** Evacuations are "current status only" today. Should replay show archived official messages
   (OpenFEMA, all states) and Oregon's evacuation history, clearly labelled as archived?
   - (a) Yes.
   - (b) No, keep "not available for past dates".
5. **Q5: County feeds.** Some counties publish public layers without agreements: Spokane WA, Boulder CO, Lake/Cook/St.
   Louis MN, Coconino AZ.
   - (a) Keep to state feeds, as the brief says.
   - (b) Research county feeds later as a separate brief.

## 7. Per-state table (47 states; California is excluded; DC is not relevant)

Verdicts: **available** = official statewide, public, machine-readable, display allowed, tested. **partial** = official
but limited. **none** = no state feed found. **blocked** = only vendor or agreement systems.

Evidence for every row:
- an ArcGIS Online catalogue search of public Feature/Map services, `(evacuation OR evacuations) AND "<State>"`, with
  the hit count given as `AGOL n`;
- a keyword and owner review (sections 2.1 and 2.3);
- a web search.

`IPAWS` = fire-related FRW/EVI messages 2024 to Oct 21, 2026 touching the state (OpenFEMA): how much the national
channel would carry there.

| State | Verdict | Official state source (owner) | Evidence (2026-10-22) | IPAWS |
|---|---|---|---|---|
| Alabama | none | – | AGOL 21: no state layer | 1 |
| Arizona | none | AZ DEMA layers unusable | 2020 layer dormant (14 rows inactive); statewide EEZ 4,252 zones with stale "Go"/"Set" (2025-09-25), TEST row, PII columns, no display terms | 34 |
| Arkansas | none | – | AGOL 12 | 1 |
| Colorado | none | DHSEM per-fire layers only | 17 DHSEM evac items, each one fire, no statewide feed or terms | 96 |
| Connecticut | none | – | AGOL 10 | 0 |
| Delaware | none | – | AGOL 18 | 1 |
| Florida | **partial** | FDEM SERT "Evacuations and Curfews" (county-level, WebEOC) | 87 rows, all "Not Reporting"; times without zone; KYZ `STATUS` blank; hurricane-oriented | 22 |
| Georgia | none | – | AGOL 25 | 24 |
| Idaho | none | – | AGOL 8; county zones (Blaine County map planned 2026, KMVT) | 106 |
| Illinois | none | – | AGOL 21 | 2 |
| Indiana | none | – | AGOL 6 | 1 |
| Iowa | none | – | AGOL 10 | 0 |
| Kansas | none | – | AGOL 6 | 16 |
| Kentucky | none | – | AGOL 15 | 0 |
| Louisiana | none | – | AGOL 27: hurricane/EPA items only | 1 |
| Maine | none | – | AGOL hits are unrelated | 2 |
| Maryland | none | MDEM static hurricane zones | `Maryland Evacuation Zones` items: planning zones, no status | 1 |
| Massachusetts | none | – | AGOL 35: planning layers | 0 |
| Michigan | none | – | AGOL 8 | 1 |
| Minnesota | none | – | AGOL 16: county layers only (Lake, Cook, St. Louis) | 13 |
| Mississippi | none | – | AGOL 19 | 2 |
| Missouri | none | SEMA template (not live) | 10 rows "No Evacuation Order", `publicview = No`, last edit 2025-02-12 | 0 |
| Montana | none | – | AGOL 9 | 24 |
| Nebraska | none | – | AGOL 3 | 19 |
| Nevada | none | – | AGOL 10; Washoe County alerts via IPAWS | 46 |
| New Hampshire | none | – | AGOL 21 | 2 |
| New Jersey | none | – | AGOL 30: research layers | 0 |
| New Mexico | none | DHSEM per-declaration layer | `EM3628_Evacuations` (one declaration) | 51 |
| New York | none | – | AGOL 54: NYC coastal planning | 0 |
| North Carolina | none | NCEM coastal KYZ (hurricane) | MapServer 200, every query errors "Invalid definition expression" | 7 |
| North Dakota | none | – | AGOL 7 | 4 |
| Ohio | none | – | AGOL 10 | 4 |
| Oklahoma | none | – | AGOL 9; Oklahoma EM sends IPAWS alerts | 93 |
| Oregon | **available** | OEM "Evacuation Areas Public" | HTTP 200, count 0 (off-season), last data edit 2026-09-29; licence "Public"; 2026 history 5.18 M rows / 61 fires | 179 |
| Pennsylvania | none | – | AGOL 19: nuclear-plant zones | 3 |
| Rhode Island | none | – | AGOL 15 | 0 |
| South Carolina | none | SCEMD hurricane/REP zones | static planning zones | 1 (+8 CEM/LAE 2025) |
| South Dakota | none | – | AGOL 3 | 29 |
| Tennessee | none | – | AGOL 10 | 2 |
| Texas | none | – | AGOL 136: research/regional layers; no TDEM feed | 65 |
| Utah | blocked | – | County zones in Genasys Protect (web search: Genasys release on Utah counties; KJZZ on Washington County); no state feed | 49 |
| Vermont | none | – | AGOL 1 | 0 |
| Virginia | none | VDEM hurricane KYZ (static) | "Data was updated July 2020", planning only | 4 |
| Washington | **partial** | WA SEOC "Evacuation_Zone_Level" | Terms allow public apps with credit; "updated daily"; TLS fails from the sandbox (curl 60, httpx verify error); fields from the viewer map | 266 |
| West Virginia | none | – | AGOL 4 | 1 |
| Wisconsin | none | – | AGOL 13 | 2 |
| Wyoming | none | – | AGOL 5: county view (Washakie) | 41 |

DC: no wildland fires of list size, so it is not relevant. Alaska and Hawaii are out of scope (brief 3 decision 1);
Alaska has an `AK_State_Authoritative_nifc` "Unorganized Alaska Evacuation Zones" layer for later.

## 8. Evidence log (2026-10-22 UTC; GET only; 0 non-GET requests; no browser runs; no secrets involved)

- ArcGIS catalogue (`arcgis.com/sharing/rest/search`): 60 queries at 1 per second (3 by views, 47 per state, 7 keyword,
  3 owner/org). Item JSON for 17 items.
- Oregon:
  - item, FeatureServer and layer JSON: 200;
  - `returnCountOnly` 20:49:16Z: `{"count":0}`;
  - grouped stats: `[]`;
  - history layer: 1,554,704 / 1,719,348 / 1,906,717 rows for levels 1/2/3; Date 2026-07-01..09-29; 61 distinct names.
- Washington: `wise.wamil.us` gave curl error 60 at 20:50:35Z, httpx `CERTIFICATE_VERIFY_FAILED`, and WebFetch 503
  (×2). Web map `834177125919449ba694c49518bc12e2/data`: 200.
- Florida:
  - SERT: count 87; grouped `evacuation_status` = [("Not Reporting", 87)]; last EditDate 2026-07-28;
  - KYZ layer 46: count 199; `STATUS` = [" " × 199].
- Arizona:
  - `Evacuations_active_public` L0: count 14, L1: 0, last edit 2023-11-16;
  - EEZ: count 4,252, statuses None 4,240 / Set 6 / Go 5 / Planning 1 (12 non-normal rows listed).
- North Carolina: MapServer 200; 4 layer queries return error -2147467259.
- Missouri: count 10. Colorado: org search 17 items.
- NWS:
  - `/alerts/types`: 200, 111 types;
  - `/alerts/active?event=<7 types>` at 20:59:08Z: 0 features;
  - `/alerts?event=…`: 2 features (the window is 7 days, even with `start=2026-08-01`).
- IPAWS public feed `recent/2026-10-22T00:00:00Z`: 200, `application/xml`, 36,726 B, 3 alerts (NWS weather), no key.
- OpenFEMA:
  - `$top=1`: 200 in 0.8 s, count 4,870,228, newest `sent` 2026-10-21T20:49Z;
  - FRW+EVI since 2024: 200 in 14.7 s, 10.6 MB, 2,233 unique identifiers;
  - 2025 counts: CEM 479, CDW 34, SPW 0, LAE 1,715 (CEM/CDW/LAE download 8.3 MB);
  - one `any()` filter attempt: 503 after 60 s.
- Analysis scripts and raw downloads stayed in the session scratchpad. Nothing was written to `data/`.
