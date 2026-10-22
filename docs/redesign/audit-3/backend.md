# Audit 3: backend generalization from California to the lower 48 states

Role `audit-backend-us` (brief 3, stage A). Read-only: no project code changed, no fire built, no "Prepare analysis".
First pass 2026-10-22, **21:30-21:45 UTC** (45 GETs; a local API on port 8711 with `FIRE3D_LIVE=0`: 11 GETs, 0 non-GET,
stopped). Revision pass after an independent review, **22:45-22:56 UTC** (16 GETs, 4 web pages, 2 offline Python
checks; no API, no browser). Every request was a polite GET through `fire3d.http`; the evidence log is section 7 and the
changes are listed in section 8. Evacuation feeds are in `audit-3/evacuations.md` (cited as EV-R1 … EV-R10); the web
side and the accuracy regions are in `audit-3/web.md` (W…, 3.x) and `audit-3/validation.md` (V-G…, V-R…). They are
cross-referenced, not repeated. Round-2 decisions (BRIEF-3, "Decisions round 2") are cited as D2-1 … D2-8.

## 0. Summary

- **Every list, lookup and filter that decides "which fires exist" is California-only.** The catalog reads CAL FIRE only
  (`catalog.py:229-301`), FIRMS feeds are cut to the CA box (`firms.py:652, :687`), perimeters ask for `US-CA` only
  (`perimeters.py:80, :181, :326, :538`), NWS asks `area=CA` (`nws.py:445`), UTM is zone 10/11 (`grid.py:59-61`), and
  the official lookups find only CAL FIRE records (`api/official.py:147-184`).
- **NIFC WFIGS can replace CAL FIRE as the national list** (the IRWIN data the perimeters already use; public, no key,
  refreshed from IRWIN every 5 min). Measured:
  - **2026 wildfires >= 300 ac in the lower 48: 1,178** (CA 69, other states 1,109; OK 135, TX 119, FL 105, OR 85, ID 84).
  - **2025: 861** (CA 79; CAL FIRE lists 78). Alaska (25 in 2026, 122 in 2025) and Hawaii (1, 1) are filtered out.
  - **Active now: 241** (WFIGS "Current", lower 48, containment < 100 % or not reported). All are listed (D2-1):
    109 are <= 1 ac and 45 have no reported size.
  - 43 % of the 2026 fires >= 300 ac are in the Southern Area; only 48 % of those have a WFIGS perimeter.
- **California merge (D2-2), measured with the rule R1 recommends.** Of the 79 WFIGS-CA fires >= 300 ac in 2025, 69 are
  the same fire as a CAL FIRE record, 8 are members of complexes CAL FIRE lists as one fire, and 2 are not on CAL FIRE's
  list (Alpaugh, BLM; Big Cliff, USFS). Today 70 WFIGS-CA fires are active: 6 are CAL FIRE fires and **64 are not on
  CAL FIRE's lists** (41 without a size, 22 <= 1 ac). **Correction:** the Timber Fire (25,352 ac, 97 %) *is* on CAL
  FIRE's 2026 list; CAL FIRE marks it not active, so it is missing only from CAL FIRE's live list (question Q-A).
- **Silent wrong results outside CA** (BLOCKERs):
  - live fires get no FIRMS feed detections (never refreshed, never auto-built);
  - keyless historical builds get no archive detections;
  - fire weather asks NWS for California only, and answers 404 for a fire that is not on CAL FIRE's lists;
  - bundle and forecast text credit "CAL FIRE" for every fire's acres, start and containment;
  - LANDFIRE LF2025 (used for live fires) is **NoData** in the South, Central and East until its November 2026 release;
    a partly covered area passes the check with the NoData turned into non-burnable fuel.
- **Request budgets are weighted.** Open-Meteo counts a request by locations, variables, models and days: one live
  weather refresh (16 points, 14 series, <= 14 days) costs about 22 calls of the free 10,000 a day, not 1.
- **Time zone and state are computable offline** from public-domain files: BTS NTAD Time Zones (111 KB) plus the
  Navajo Nation and Hopi Reservation (55 KB), and Census state polygons (310 KB, 93 KB gzipped).
- **The gazetteer grows ~21x**: 31,553 places + 33,300 ZIP areas + 3,109 counties = 2.8 MB JSON (0.9 MB gzipped).

## 1. What exists (California assumptions, file:line; paths under `backend/fire3d/`)

| Area | Where | Assumption |
|---|---|---|
| Incident list | `catalog.py:39` `HISTORICAL_YEAR=2025` (also `api/app.py:453`); `:112-139` `summary_from_record` (CAL FIRE fields); `:242-263` live = CAL FIRE active; `:266-270` year = CAL FIRE year list; `:317-354` `get_summary` via CAL FIRE lists | Only CAL FIRE (`sources/calfire.py:33`); the default list is 2025, while the brief wants 2026 with 2025 behind a filter |
| Fire year | `catalog.py:117`, `sources/calfire.py:103`: year of the UTC start | WFIGS `UniqueFireIdentifier` ("2026-TXTXS-000006") carries the agency's fire year |
| CA outline | `catalog.py:62-66` `CA_OUTLINE`, `:147-152` `in_california`, `:253` state-wide total | `LiveStatus.detections_24h_ca` (`contracts.py:438-443`) |
| Ids | `catalog.py:83-85`, `build/pipeline.py:71-91` `spec_incident_id` / `is_catalog_incident` from `calfire_uid` | `IncidentSummary.calfire_uid: str` required (`contracts.py:67`; web `types.ts:14`) |
| Build gate | `build/pipeline.py:461-465`, `api/app.py:496` "not in the CAL FIRE catalog"; data source text `pipeline.py:515`; `:690` | Only CAL FIRE ids buildable |
| Issuer text in bundles | `build/observed.py:742, :785` "reported by CAL FIRE"; `:1331` "CAL FIRE start"; `:1366, :1373` "CAL FIRE incident point"; `:1721` "CAL FIRE (100% contained)"; `:2113` "Reported by CAL FIRE <time>"; `:2118` `ign_src="CAL FIRE"`; `spread/ensemble.py:674` "CAL FIRE reports N% containment"; `build/live_observation.py:138` veto "CAL FIRE reported N ac" | Every fire's official figures are credited to CAL FIRE |
| Official lookups | `api/official.py:104-129` `incident_ref`, `:147-159` `find_record` (CAL FIRE live and year lists), `:162-184` `fill_from_calfire` (mode from `is_active`, end from `extinguished_ms`), called by fire weather at `:323-324` | A fire with no bundle and no CAL FIRE record gets HTTP 404 |
| FIRMS | `config.py:109` `CA_BBOX`; `sources/firms.py:632-661` `load_live_ca`; `:667-719` `load_year_ca` caches `firms_ca_{year}.parquet` and reads the whole file on every call (`:680`) | Feeds and archive are already national (`firms.py:68-69`) but cut to CA |
| FIRMS users | `catalog.py:252, :416`; `api/live.py:124-167`; `build/pipeline.py:655` (`refresh_live`); `firms.py:744` (keyless path) | Non-CA fires see no feed rows |
| Perimeters | `sources/perimeters.py:80` `STATE="US-CA"` in `build_where` `:181`, `identity_filter` `:326`, spatial fallback `:538`; `_calfire_hint` `:553-567` | Name matching tuned to CAL FIRE names |
| UTM | `grid.py:59-61` `utm_epsg_for`: 32610 if lon < -120 else 32611; `scripts/check_bundle.py:139`; SPEC §4.1 | Zones 10/11 only (lower 48 needs 10-19) |
| Time zone | `build/observed.py:89, :199-201` labels "Jan 07, 18:18 PST" baked into bundle text (`:1337, :1349, :2113-2118`); `sources/overpass.py:50, :113-116`; `build/live_observation.py:74-75, :138-149, :240-243`; LFM month `spread/ensemble.py:70, :307`, `spread/behavior.py:32, :246`, `build/weather_bundle.py:520-526`; SPEC §4.2 | Pacific time everywhere |
| Fuel moisture | `config.py:163-180` CA monthly LFM table + Oct-1 water-year rule; `sources/weather.py:508-515`; `spread/moisture.py:109` | Mediterranean climate (V-G5) |
| LANDFIRE | `sources/landfire.py:55-57` `edition_for(mode)` (LF2025 live); `:95-98` raises only if < 0.5 % of the area has fuel codes; `:161` NoData → 99 (non-burnable); `build/aoi.py:282-291` other edition only on that error | LF2025 is complete only in the SW and NW GeoAreas (2.3) |
| NWS | `sources/nws.py:442-452` `active_alerts` `area=CA`; `:516-552` `place_live` loads the zones of every listed alert before the area test, and lists an alert whose zones fail as "unplaced" (`:545`); `NWS_LIMITER` 30/min (`:102`); `api/official.py:292-313` caveat "in California" | Fine for CA's short list, wrong with a national one (2.5) |
| Weather requests | `sources/weather.py:54-67, :368` 16 points × 7 variables × 2 models per request; `LIVE_TTL_S` 30 min (`:69`) | Open-Meteo counts weighted calls (2.5) |
| Live loop | `api/live.py:41-43` auto-build 4 fires >= 100 ac with 48 h detections; `:153-167` CAL FIRE + CA feed; `:337-361` candidates | CAL FIRE list and CA feed only |
| Search | `api/geocode.py:142` `gazetteer_ca.json`, `:148` CA state words, `:154-157` "California only"; `:304` `f"{name}, CA"`, `:315` `f"ZIP {zip}, CA"`; examples `:122, :436`; `scripts/build_gazetteer.py:36-47, :89` | Address lookup (Census Geocoder) is already national |
| Extras | cameras CA-only (`api/extras.py:72-75, :140-170, :791`); GOES-West only (`:1389, :1406, :1423`) | Eastern fires sit at the GOES-West limb |
| Aircraft | `config.py:349` `GEOID_UNDULATION_CA_M=-33` (`sources/aircraft.py:208`); CAL FIRE fleet patterns `config.py:284-315` | Geoid varies by tens of metres across the lower 48 |
| Test recorders | `scripts/record_test_samples_official.py:153` (`area=CA` URL, "California answer shape"); `scripts/record_test_samples_firedata.py:243-278` (`CA_BBOX`, `state="US-CA"`) | Recorded samples stay CA-only |

## 2. Findings

### 2.1 NIFC WFIGS as the national incident list
- **Layers** (`services3.arcgis.com/T4QMspbfLg3qTGWY`, owner `NIFC_Authoritative`): `WFIGS_Incident_Locations_Current`
  (active), `_YearToDate` (2026), `WFIGS_Incident_Locations` (all years). 97-98 fields, at most 2,000 rows per page.
  Request `outSR=4326`.
- **Fields**: `IncidentSize` (no `DailyAcres`; minimum 0.1), `PercentContained`, `FireDiscoveryDateTime`,
  `ContainmentDateTime`, `ControlDateTime`, `FireOutDateTime`, `ModifiedOnDateTime_dt`, `IncidentTypeCategory`
  (WF 37,396 / RX 5,799 / CX 13 in 2026), `POOState` ("US-OR"), `POOCounty`, `GACC`, `UniqueFireIdentifier`, `IrwinID`,
  `IsCpxChild`/`CpxName`/`CpxID`, `POOProtectingAgency`, `POOProtectingUnit`, `ICS209ReportDateTime`. No null
  `IrwinID`/UFI and no duplicate IRWIN ids among the 1,178.
- **No link field.** None of the 98 fields is a URL. A per-record page exists: the layer's REST query by `IrwinID` with
  `f=html` (checked for Timber: name, size, % contained, `ModifiedOnDateTime_dt`, protecting agency and unit).
- **Agency codes, not names.** `POOProtectingAgency` on the 293 Current lower-48 wildfires: DNR 76, USFS 68, C&L 39,
  BLM 21, BIA 20, FC 17, DOF 11, CAL FIRE 9, NPS 8, USFWS 7, then FFC, DVF, DNRC, SHP, DL, SF, INTER, USMC, TRIBE, SFS.
  The fields have no coded domain. NWCG's Unit Identifier system (UnitIDx) is the official code list; its terms were not
  checked.
- **"Current" is NIFC's own active rule** (item description): WF/RX/CX not declared contained, controlled or out,
  valid and not quarantined; fall-off when not edited for 3 days (< 10 ac), 8 days (10-100 ac) or 14 days (> 100 ac).
  Measured: 0 of 293 lower-48 WF rows have a containment or out date.
- **Terms**: the item licence is a disclaimer only (no use restriction); credit "NIFC WFIGS (IRWIN)" with the item's
  access line. Already used for perimeters (SPEC §2).
- **Field quality (2026, lower 48, >= 300 ac, n=1,178)**: `PercentContained` null 91 (8 %); `ContainmentDateTime` null
  523 (44 %); 437 say 100 % but have no containment time; 494 have neither containment nor out, of which 242 were last
  edited > 90 days ago, so **year-to-date rows without a containment date are not "active"**. 402 names are ALL CAPS;
  `FinalAcres` is set on 20 only, so use `IncidentSize`.
- **Active now (Current, WF, lower 48, % < 100 or null)**: 241. Size: <= 1 ac 109, 1-10 ac 24, 10-100 19, 100-300 10,
  300-1,000 7, 1,000-10,000 14, > 10,000 13, unknown 45.
- **Duplicates and complexes**: WFIGS repeats some fires under two IRWIN ids ("2-2" in CA 2025: 3,462 and 3,462.84 ac);
  2026 has 6 CX parents >= 300 ac and 21 WF children >= 300 ac.
- **State: `POOState` must decide, not the polygons.** Point-in-polygon against the TIGERweb states (0.005°):
  2026 WF >= 300 ac, 1 of 1,178 points falls outside every polygon (Paradise, OR, 20 m outside) and 2 fall in another
  state (Low Gap Hollow, WV → KY; Sharpe, CO → OK). Current WF: 2 of 293 outside (Zamora Bend, TX, 77 m outside at the
  Rio Grande; Paradise). Other `POOState` values: US-AK, US-HI, US-PR, US-GU, US-VI, MX-BN, CA-ON.

### 2.2 California: CAL FIRE vs WFIGS
- CAL FIRE `UniqueId` is **not** the IRWIN id (0 of 79 equal), so matching is by complex name, place, name and time.
- **The first-pass rule was too narrow.** It matched only fires >= 300 ac on both sides within ±3 days (68 of 78) and
  called 11 WFIGS rows "unmatched"; 8 of those are complex members or the same fire with a lagged start.
- **Revised rule (R1), run on 2025** (WFIGS-CA >= 300 ac, 79, against all 555 CAL FIRE fires of the year, any size):
  1. complex member, `CpxName` equals a CAL FIRE complex name: **8** (Butler → Orleans Complex; Peak → Swift Complex;
     2-2 twice, 2-7, 2-8, 6-2, 6-5 → TCU September Lightning Complex);
  2. same fire, with equal name tokens, <= 30 km and discovery -7 to +20 days from CAL FIRE's start, or any name within
     3 km and ±3 days: **69** (including Log at -6 days, Gianelli 374/372 ac, BDU/LAKE → Lake, Bradford Branch → Dale
     2.1 km apart on the same day, LAC-282478 → King);
  3. not on CAL FIRE's list: **2**. Alpaugh (BLM, 550 ac) is a true gap. Big Cliff (USFS, 973 ac) is 33 km and 21 days
     from the Orleans Complex, whose 22,153 ac ≈ Butler 21,058 + Big Cliff 973: probably counted inside CAL FIRE's complex,
     and a known edge case that would be listed twice.
- The "any name" arm needs the ±3 day bound: with +20 days it merged today's McCovey fire into the Marshall Fire,
  0.8 km away and 9 days earlier.
- **From CAL FIRE's side** (against WFIGS-CA >= 1 ac, 1,673 rows): 73 of 78 fires >= 300 ac find a WFIGS record (65 by
  name, 5 by place, 3 complexes). 5 have none (Lidia, Fort, Hudson, Paladino, Crow), all in counties that are OSCC only.
- **Today**: 70 active WFIGS-CA wildfires. 6 match CAL FIRE (Timber, Rocky, Norte, Cooley, Soda; Lost at +15.7 days)
  and 64 do not (41 no size, 22 <= 1 ac, 1 of 1-10 ac; C&L 28, BLM 13, USFS 12, CAL FIRE 7).
- **Timber**: CAL FIRE's 2026 list has it at 25,351.9 ac, 97 %, `IsActive=false`, `Final=false`, updated
  2026-10-21 03:41 UTC; WFIGS Current has 25,350 ac, 97 %. The first pass said CAL FIRE did not list it; that was wrong.
  Only CAL FIRE's live list leaves it out, so the open point is which agency's "active" decides (Q-A).
- **County → GACC** (WFIGS all years, CA WF >= 10 ac, 57 counties): 27 counties are ONCC only and 17 OSCC only. Of the
  12 with more than one GACC, only Stanislaus (OSCC 22 / ONCC 15), San Joaquin (12 / 8) and Alpine (OSCC 6, ONCC 2,
  GBCC 12) split North and South Ops; Imperial (SWCC 18 / OSCC 14), Mono (OSCC 24 / GBCC 17 / WBCC 4) and Sierra
  (ONCC 6 / GBCC 5) are mixed with neighbours; the other six are >= 80 % one GACC.

### 2.3 Build and display sources outside California
| Source | Coverage outside CA (checked) | Note |
|---|---|---|
| USGS 3DEP DEM | OK point 600.7 m | national |
| LANDFIRE LF2024 FBFM40 CONUS | FL 189, OK 102 | complete CONUS |
| LANDFIRE LF2025 + seasonal FA26 | **NoData** at OK and FL points | landfire.gov "LANDFIRE 2025 Update": SW released Apr, NW Jun 2026; SC, SE, NC, NE "November" |
| NAIP (USGS) | MT 2021, FL/GA 2023 tiles | vintages differ by state: record the year |
| Sentinel-2 dNBR (Earth Search) | Tampa area, Jun-Aug 2025: 23 scenes, **2** under the 20 % cloud filter | humid summers often degrade to "unavailable" |
| FIRMS 7d feed (keyless) | 11,799 SNPP rows: 10,484 in a lower-48 box, 812 in the CA box, 440 Hawaii | ~13x the CA rows |
| FIRMS area API (key) | Oregon box, 2 days: 129 rows, 1 request | national |
| NASA CMR passes | FL point, 24 h: 2 VIIRS SNPP NRT granules | national, same query |
| WFIGS perimeters | 822 of 1,178 2026 fires >= 300 ac (70 %). NWCC 94 %, GBCC 98 %, ONCC 94 %, RMCC 84 %, OSCC 80 %, NRCC 78 %, EACC 68 %, SWCC 66 %, SACC 48 % (TX/OK 66 %, Southeast 30 %) | detection-only burned areas are common in the South |
| Open-Meteo HRRR history + GFS ensemble | OK/FL: 48/48 h `gfs_hrrr`; MT: 31 members | terms: 600/min, 5,000/h, 10,000/day, non-commercial, CC BY 4.0; pricing page: 300,000/month (not enforced yet) and weighted counting (2.5) |
| NWS alerts | `area=` takes a 49-code list | zones: `/zones?id=` batch has no geometry; NWS fire zones are published as `fz16ap26.zip` (3,683 zones, valid 16 Apr 2026) and as layer 9 "Fire Weather Zone Forecasts" of `mapservices.weather.noaa.gov/.../nws_reference_map/MapServer` (GeoJSON query, so no shapefile reader is needed) |
| IEM VTEC archive | OK March 2025: FW.W x3 / FW.A x3; AZ July 2025: none | point-based, national |
| NASA GIBS GOES-East GeoColor | DescribeDomains 20:00-21:50 UTC every 10 min; z5 tile over Florida 143 KB PNG | same code path and credit as GOES-West |
| EGM96 geoid (NGA) | `cdn.proj.org/us_nga_egm96_15.tif` 2.7 MB | PROJ-data `us_nga` README: "License: Public Domain", source NGA |

### 2.4 Time zone and state, offline
- **Time zones**: USDOT BTS NTAD "Time Zones" (updated 2023-01-05): "a work of the United States government …
  available for unrestricted public use". Lower 48 at 0.005°: 4 polygons, 5,749 vertices, 111 KB. IANA mapping: Pacific
  → America/Los_Angeles, Mountain → America/Denver, Central → America/Chicago, Eastern → America/New_York, **except
  Arizona → America/Phoenix (no DST), the Navajo Nation → America/Denver (DST) and the Hopi Reservation inside it →
  America/Phoenix**. Census TIGERweb `AIANNHA/MapServer/2` ("Source: U.S. Census Bureau"): Navajo Nation Reservation
  2,796 vertices, Hopi Reservation 141, **55 KB** GeoJSON at 0.005°. The tz database's own `Navajo` alias resolves to
  MDT in July (Python `zoneinfo`), America/Phoenix to MST. The zone file is therefore ~170 KB. Off-reservation trust
  lands (layer 3) are left out; they are small and change little.
- **States**: Census TIGERweb `State_County/MapServer/0` (public domain) at 0.005°: 49 lower-48 + DC features, 310 KB
  (93 KB gzipped). Shapely STRtree assigned all 33,791 ZCTA points in 105 ms. No new dependency (shapely is present;
  build scripts use the ArcGIS GeoJSON output, not shapefiles).

### 2.5 Live loop, request budgets and alerts at national scale
- Runtimes from earlier reports: builds 47-192 s, forecasts 2-30 s; 4 CPUs here. `assign_detections`
  (`catalog.py:160-178`) builds dense detections × incidents arrays: 50k × 250 is ~100 MB per array. scipy 1.12 is
  installed, so a KD-tree needs no new dependency.
- **Open-Meteo counts weighted calls.** Pricing page: requests with "more than 10 weather variables or … more than 2
  weeks for a single location are considered multiple API calls … fractional counts are used" (15 variables × 2 weeks
  = 1.5 calls; 4 weeks = 3.0); the docs' cost note names "the number of locations, variables, or models". Ensemble
  members are not mentioned. With cost ≈ locations × max(1, series / 10) × max(1, days / 14):
  - a live weather refresh (16 points, 7 variables × 2 models, window <= 14 days) ≈ **22 calls**;
  - an ensemble forecast (16 points, 5 variables, gfs025) ≥ 16 calls, more if members count;
  - a historical build ≈ 50 calls per 31-day chunk, plus ERA5 and the water-year request (V-R5: 10-26).
  - Today a live bundle with new detections each cycle refetches weather every 30 min (`LIVE_TTL_S`): up to ~1,050
    calls a day for weather alone, so 4 auto-built fires can use about half the free 10,000. The cloud egress IP is
    shared, and the archive APIs already answered `429 Daily API request limit exceeded` at 22:21 UTC
    (orchestrator note).
- **NWS with a national list.** `place_live` loads the zones of every alert before testing the fire's area. Offline
  check: a Montana Red Flag Warning whose zones cannot load (the 30/min limit raises `SourceBusy`, caught as
  `SourceError`) is listed on a Florida fire's card as "could not be placed". On a busy Red Flag day the first
  requests would also spend the whole 30/min budget on zones in other states.
- **Official lookups.** Offline check: `fire_weather_payload("2026-sharpe-fire-abcdef")` with empty CAL FIRE lists
  raises HTTP 404 "unknown incident", so every non-CA fire without a bundle would fail.

## 3. Gaps

| # | Gap | Grade | Evidence |
|---|---|---|---|
| B1 | No national incident list; only CAL FIRE | **BLOCKER** | `catalog.py:229-301`; API on 8711: `mode=live` → 3 CA fires while WFIGS has 241 lower-48 active |
| B2 | FIRMS feed and archive cut to the CA box: non-CA live fires never get detections, no auto-build, `refresh_live` never sees new detections; keyless historical builds get no archive rows | **BLOCKER** | `firms.py:652, :687`; `pipeline.py:655`; `live.py:163` |
| B3 | NWS live alerts requested for CA only; a non-CA fire's card reports none | **BLOCKER** (official info) | `nws.py:445`; `audit3-backend-fireweather-ca-only.png` vs 3 MT/WY Red Flag Warnings |
| B4 | UTM zone 10/11 only: scale error 1.3 % Colorado, 4 % Oklahoma, 16 % Florida (areas 35 % too big) | **BLOCKER** | `grid.py:59-61`; `check_bundle.py:139` |
| B5 | Pacific time baked into bundle text and the month used for live fuel moisture | **BLOCKER** (brief rule) | `observed.py:199-201, :2113`; `live_observation.py:74`; `ensemble.py:307` |
| B6 | LANDFIRE LF2025 NoData outside SW/NW until Nov 2026; partial NoData becomes non-burnable 99 | **BLOCKER** (silent wrong fuels) | `landfire.py:95-98, :161`; OK/FL identify = NoData |
| B7 | Perimeters filter `US-CA`; non-CA fires get none | **BLOCKER** | `perimeters.py:80, :181, :326` |
| B8 | Ids, build gate and contract need a CAL FIRE UniqueId | **BLOCKER** | `pipeline.py:71-91, :461-465`; `contracts.py:67` |
| B9 | Bundle and forecast text credit CAL FIRE for any fire's acres, start, point and containment | **BLOCKER** (official info keeps its issuer) | §1 "Issuer text" row |
| B10 | Official lookups resolve CAL FIRE only: fire weather for a non-CA fire without a bundle is 404; mode and end come from CAL FIRE fields | **BLOCKER** | `official.py:147-184, :323-324`; offline check 2.5 |
| B11 | `place_live` loads every alert's zones before the area test; with a national list, other states' alerts appear on a fire's card | **BLOCKER** once alerts are national | `nws.py:516-552`; offline check 2.5 |
| I6 | CA live fuel moisture table applied everywhere | **BLOCKER** (validity; V-G5: February Oklahoma grass at 1.20/1.20) | `config.py:163-180` |
| I1 | No `state`, `time_zone`, GACC or region on `IncidentSummary`; no point lookup | MISSING | `contracts.py:62-82` |
| I2 | No official record card outside CA and no national change history | MISSING | `official.py:198-250`; `calfire_history.py` |
| I3 | Gazetteer CA-only; "Fire-3d covers California only"; matches end in ", CA" | MISSING | `geocode.py:154-157, :304, :315`; `audit3-backend-geocode-bozeman.png` |
| I4 | AK/HI not excluded anywhere (FIRMS feed includes Hawaii; Census geocoder answers AK/HI) | MISSING | 2.1 |
| I13 | No GACC for California fires without a WFIGS record (5 of 78 in 2025) | MISSING | 2.2 |
| I5 | Dense detection matching; live loop reads CAL FIRE and the CA feed | INCOMPLETE | `live.py:153-167`; `catalog.py:160-178` |
| I12 | Open-Meteo use is counted nowhere; weather refetched every 30 min per live fire | INCOMPLETE | 2.5 |
| I7 | GOES-West only for "recent imagery" | INCOMPLETE | `extras.py:1389` |
| I8 | Cameras CA-only, with no "not available in this state" answer | INCOMPLETE | `extras.py:791` |
| I9 | `/api/incidents` rows ~600 B uncompressed; a 2,000-row list is ~1.2 MB | INCOMPLETE | `app.py:425-455` |
| I10 | Aircraft: CA geoid constant, CAL FIRE-centric fleet patterns | INCOMPLETE (minor) | `config.py:284-349` |
| I11 | Tests and recorders encode CA | INCOMPLETE | 5 |
| I14 | README credits and SPEC §2 rows name only CA sources; default list year 2025 | INCOMPLETE | README "Data sources, licenses and credits"; SPEC §2, §6 |

## 4. Design and recommended changes

**Catalog (R1).** New `sources/wfigs.py`: `list_current()` (5-min cache), `list_year(year)` (YTD for the current year,
30 min; the all-years layer for past years, 24 h), server-side `IncidentTypeCategory='WF'` and, for year lists,
`IncidentSize>=300`, explicit `outFields`, `outSR=4326`. Normalize to the CAL FIRE record shape. Rules:
- **Lower 48** = `POOState` in the 48 + DC codes. `POOState` decides listing; a row is never dropped because its point
  misses the polygons. The polygons (R3, nearest state within 5 km) give the state only to points without a
  `POOState`; mismatches over 5 km are logged (3 rows in 2026). AK, HI, territories and foreign codes are excluded.
- **Active** = in Current, `PercentContained` null or < 100, **every size** (D2-1); year-to-date rows are never
  "active" on their own.
- **Years**: the default year list is the current year (2026), with `year=2025` as the filter (BRIEF-3 decision 2):
  `HISTORICAL_YEAR` becomes the current UTC year (`catalog.py:39`, `app.py:453`, SPEC §6). A WFIGS fire's year is its
  `UniqueFireIdentifier` year; CAL FIRE ids keep today's rule so existing ids still resolve.
- `contained_ms` = Containment, else Control, else FireOut; never inferred; `percent_contained` null = "not reported".
- **Complexes outside CA**: list WF members, not CX parents, each with "part of the X Complex" (D2 default). WFIGS
  duplicates (same name tokens and state, size within 1 %, <= 10 km, discovery <= 30 days apart): keep the most
  recently modified and log the dropped id.
- **California (D2-2)**: CAL FIRE is the record. A WFIGS-CA row is dropped when (1) its `CpxName` equals a CAL FIRE
  complex name (CAL FIRE's complex row stays, Q-B), or (2) it is the same fire as any CAL FIRE fire of that year or the
  year before (name tokens equal, <= 30 km, discovery -7/+20 days; or any name, <= 3 km, ±3 days). Its `IrwinID`, GACC
  and perimeters attach to the CAL FIRE row. (3) Otherwise it is added with `record_source: "wfigs"` (64 today).
  Whether a CAL FIRE row counts as active is Q-A.
- **Ids** keep SPEC §4.4: `{year}-{slug}-{uid6}`, uid6 from the IRWIN id without braces; `get_summary` resolves a WFIGS
  id with one cached `IrwinID LIKE '{ABCDEF%'` query on the all-years layer.
- Display `name` title-cased when the source is ALL CAPS; `source_name` keeps the verbatim name.

**Contract (R2, additive; names match `web.md` 3.7 and V §5).** `IncidentSummary` gains `state` (USPS), `time_zone`
(IANA), `uid` (CAL FIRE UniqueId or IRWIN id without braces), `record_source` ("calfire" | "wfigs"), `record_agency`
(R10), `record_agency_code`, `record_url`, `irwin_id`, `gacc` and `accuracy_region`; `name` and `source_name`.
`calfire_uid` stays a deprecated alias of `uid`. Old manifests: fill `state`/`time_zone` on read (CA bundles → "CA",
America/Los_Angeles). `LiveStatus` adds `detections_24h` (keep `_ca`). `/api/incidents` adds `state=` and gzip. New
`GET /api/geo/lookup?lon=&lat=` → `{state, state_name, time_zone, supported}` (W9, EV-R1). NWS `/points` was rejected
for the zone: one request per point, and an outage would leave a fire without a zone.

**Regions (R3).** `scripts/build_us_regions.py` writes `backend/fire3d/data/us_states.geojson` (310 KB) and
`us_timezones.geojson` (~170 KB with Navajo/Hopi); `fire3d/regions.py` gives `state_at`, `states_in_bbox`,
`time_zone_at` (fallback: nearest zone within 5 km, then the state's main zone) and `supported`.

**Official record outside CA (R10).** `GET /api/official/incident-record?incident=` (kind `incident_record`):
- source and issuer line: "NIFC WFIGS (IRWIN)", the publisher of the record; then "Protecting agency: <code verbatim>
  (<plain name>), <state>", for example "USFS (USDA Forest Service)", "C&L (county or local agency), Oregon". A small
  code → name table (`fire3d/data/nwcg_agency_codes.json`) covers the codes in use; an unknown code is shown verbatim.
  The table's wording must be checked against NWCG's code list before release;
- the record's own times: `ModifiedOnDateTime_dt` (update), discovery, containment, control, out, shown in the fire's
  time zone; size and containment verbatim;
- link: the all-years layer's query by `IrwinID` with `f=html` (a readable per-record page; the Current layer drops a
  fire 3-14 days after its last edit), plus the dataset page as "about this source";
- never merged with model output; no record is never an all-clear;
- `incident_ref`/`find_record`/`fill_from_calfire` become `fill_from_catalog`, which resolves any listed id through
  `catalog.get_summary` (CAL FIRE or WFIGS) and takes mode and end from the summary. `/api/official/calfire` answers
  `not_covered` for a WFIGS fire.

**NWS (R9, one owner with EV-R7).** One cached national request per cycle, `area=` the 49 codes, with the fire events
(RFW, FWW) and the local officials' events of EV-R7 (Fire Warning, Evacuation Immediate …) in one call, split in
code. Per fire: keep only alerts with a UGC whose state prefix is in `states_in_bbox(area + margin)` **before** any
zone is loaded; then the area test as today. The national overview takes zone outlines from the bundled fire-zone file
(R18) instead of 30 requests a minute. Caveat "in the lower 48 states".

**Fixes by area.**

| # | Change | Value | Effort | Risk | Files | Priority |
|---|---|---|---|---|---|---|
| R1 | WFIGS catalog + CA merge (above); default year 2026 | Brief items 1-2 | L | Medium: field quality, CA dedupe edge cases | `sources/wfigs.py` (new), `catalog.py`, `api/app.py:453`, samples `tests/data/firedata/wfigs_*` | **P0** |
| R2 | Contract additions; ids from `uid`; build gate text | Non-CA fires buildable | M | Medium: web types follow | `contracts.py`, `build/pipeline.py:71-91, :461-515, :690`, `api/app.py:496`, SPEC §4.4/§5/§6, CONTRACT §14, `web/src/api/types.ts` | **P0** |
| R22 | Issuer text from `record_source`/`record_agency` via one `issuer_label(summary)` in `BuildContext`: "Reported by CAL FIRE" in CA, "Reported by USFS via NIFC WFIGS" elsewhere; same for acres, point, start, containment, the forecast containment sentence and the veto | Official figures keep their issuer | S-M | Low; CA strings unchanged | `build/observed.py:742, :785, :1331, :1366, :1373, :1721, :2113, :2118`, `spread/ensemble.py:674`, `build/live_observation.py:138`, `build/pipeline.py:515`, tests | **P0** |
| R3 | Region data + lookup + `/api/geo/lookup` | Time zone, state, AK/HI, EV-R1 | M | Low | `fire3d/regions.py`, `backend/fire3d/data/us_*.geojson`, `scripts/build_us_regions.py`, `api/app.py` | **P0** |
| R4 | `utm_epsg_for = 32600 + floor((lon + 180) / 6) + 1` (same answer in CA) | Correct grids | S | Low | `grid.py:59-61`, `check_bundle.py:139`, SPEC §4.1 | **P0** |
| R5 | FIRMS `load_live_us` / `load_year_us` keep a **lower-48 box with a 0.5° margin** (border fires keep Canadian and Mexican detections); polygons only for national totals and state counts; `firms_us_{year}.parquet` so the CA cache is never reused; read with pyarrow `filters=` on lat/lon instead of the whole file per call; KD-tree `assign_detections` | Live and keyless builds work | S-M | Low; archive parquet up to ~10-15x the CA file (7-day sample 13x), measure on first build | `firms.py:632-719`, `catalog.py:160-263, :416`, `live.py:124-167`, `pipeline.py:655` | **P0** |
| R6 | Perimeters by IRWIN id when known (`attr_IrwinID` / `poly_IRWINID`), `STATE` from `summary.state`; no `_calfire_hint` outside CA | Perimeters for 70 % of fires | S-M | Low | `perimeters.py:80-182, :318-330, :536-640` | **P0** |
| R7 | Fire-local time zone for labels ("Jan 07, 18:18 MST") and the LFM month; `time_zone` in `BuildContext` | Brief rule | S | Low | `observed.py`, `overpass.py`, `live_observation.py`, `ensemble.py`, `behavior.py`, `weather_bundle.py` | **P0** |
| R8 | LANDFIRE: "land" = cells inside the R3 state polygons with valid DEM. If > 2 % of land cells are NoData in LF2025, use LF2024 for the whole bundle and warn "LANDFIRE 2025 is not released here yet; LANDFIRE 2024 used". Cells outside the US keep 99 but are counted and labelled "outside fuel data coverage: not modeled (unknown, not low)" | Correct fuels; no CA regression on coastal or border areas | S | Low | `landfire.py:95-98, :161`, `aoi.py:273-293`, tests (Palisades-like coast and San Diego border stay LF2025; OK/FL switch) | **P0** |
| R9 | NWS national request + UGC-prefix filter before zone loading (above), one owner with EV-R7 | Official alerts for every fire, never another state's | S-M | Low | `nws.py:442-552`, `official.py:292-313`, tests | **P0** |
| R10 | Official record outside CA + `fill_from_catalog` (above) | Official info per fire; no 404 | M | Low | `api/official.py`, `contracts.py`, `fire3d/data/nwcg_agency_codes.json`, CONTRACT §14 | **P0** |
| R12 | National gazetteer: place + ZCTA + county files (public domain), `state` per row, all LSADs, "Springfield, IL" parsing, AK/HI note; `matched_address` "<name>, <ST>"; national examples in errors | Search nationwide | M | Low; 2.8 MB | `scripts/build_gazetteer.py`, `api/geocode.py:122, :142-157, :304, :315, :436`, `backend/fire3d/data/gazetteer_us.json` (root `data/` is gitignored) | **P0** |
| R14 | Adopt V-R5: GSI live fuel moisture outside CA; CA keeps its table. No interim "CA rows" outside CA | Fixes I6 | M | Medium (physics; pre-registered by validation) | per V-R5 | **P0** (validation owns) |
| R24 | README credits and SPEC §2 rows: WFIGS Incident Locations, BTS NTAD Time Zones, Census TIGERweb states and AIANNH, the national Gazetteer, GOES-East via GIBS, NWS fire zones, EGM96 (if R20) | Credit every source | S | Low | `README.md` (Data sources section, geocode row), `SPEC.md` §2, §6 | **P0** |
| R11 | `sources/wfigs_history.py`: append-only `DATA_DIR/official/wfigs/<irwin>.jsonl` (keys: `ModifiedOnDateTime_dt`, size, %, containment/control/out) | Change history like CA | M | Low | new + `catalog.py` | P1 |
| R13 | Live loop: keep `AUTO_BUILD_MAX=4`, 100 ac and 48 h (D2-4), candidates from the whole lower 48 with today's scoring; refresh as today. Add a weighted Open-Meteo counter (2.5 formula) in `weather.py`; deterministic weather at most hourly per live bundle; above ~6,000 weighted calls a day, keep the last weather and say "weather not refreshed: daily request budget reached" | Bounded requests, no CA behaviour change | M | Medium | `live.py`, `sources/weather.py`, `config.py` | P1 |
| R15 | GOES-East GeoColor (checked: 10-min domain, tiles) for fires east of ~105°W | Usable imagery in the East | S | Low | `extras.py:1387-1423` | P1 |
| R16 | Cameras and other CA-only extras answer `not_covered` "not available in this state" outside CA | Honest wording | S | Low | `extras.py:790-860` | P1 |
| R17 | gzip `/api/incidents` in the handler when the client accepts it (as `bundle_file` does); `GzipCache` is keyed by file, so it does not fit; `GZipMiddleware` also works (Starlette 1.8 skips encoded responses) but touches every route | 1.2 MB → ~0.2 MB | S | Low | `api/app.py:118, :425-455` | P1 |
| R18 | Bundle NWS fire-zone outlines (layer 9 of the NWS reference map, GeoJSON, simplified; public domain) for the national overview and as the first lookup for alerts | Overview not throttled by 30 zone requests/min | M | Low | `nws.py`, `scripts/build_nws_zones.py`, `backend/fire3d/data/nws_fire_zones.geojson` | P1 |
| R23 | `accuracy_region` fallback for CA fires without a WFIGS record: a county → GACC table built from WFIGS (majority >= 80 %); ambiguous counties (Stanislaus, San Joaquin, Alpine, Imperial, Mono, Sierra) → "accuracy not yet tested here" | Defined fallback without the unverified GACC polygons | S | Low | `scripts/build_ca_county_gacc.py`, `backend/fire3d/data/ca_county_gacc.json`, `catalog.py` | P1 |
| R25 | Recorders record national samples (49-code NWS URL, lower-48 FIRMS rows, a non-CA WFIGS fire) | Tests cover the new paths | S | Low | `scripts/record_test_samples_official.py:153`, `record_test_samples_firedata.py:243-278` | P1 |
| R19 | LANDFIRE edition by fire year (2026 fires: LF2025 where released) | Fresher fuels | S | Low | `landfire.py:55-57` | P2 |
| R20 | Aircraft: geoid from a 1° EGM96 table built from `us_nga_egm96_15.tif` (public domain); USFS/BLM/state fleet patterns | Altitudes ±20 m | S | Low | `config.py`, `aircraft.py`, `backend/fire3d/data/egm96_l48.json` | P2 |
| R21 | Bundle retention (LRU for historical bundles, ~20 MB each) | Disk bounded | S | Low | `bundle.py`, `live.py` | P2 |

Cross-references: EV-R1 needs R3's `states_in_bbox`; EV-R7 and R9 share one NWS request and one owner; W1/W9 (time,
coverage) need R2/R3; W4 (record) uses R10's fields (`record_agency` is the plain name with the code); W3 needs R17;
V-R5 is R14; V §5's region assignment uses R2's `gacc` and R23's county table where WFIGS has no record.

## 5. Contracts and tests that assume California

- SPEC: §0 (scope), §2 rows (CAL FIRE, FIRMS archive, NWS `area=CA`), §4.1 (UTM), §4.2 (Pacific display), §4.4
  (`calfire_uid`), §5.1 `IncidentSummary`, §6 (incidents default 2025, geocode, official, live status), §8.1/§8.3
  (CAL FIRE point and start), §8.4 (CA LFM), §8.6 (CAL FIRE fleet), §8.7 (CAL FIRE live loop). CONTRACT §13 official
  kinds; §14 new. README: data sources and the geocode row.
- Tests to update (CA behaviour kept): `test_grid.py:32-35` (add zones 12-19), `test_firedata_firms.py:313-372`,
  `test_firedata_catalog.py:112, :158-161`, `test_firedata_perimeters.py:58`, `test_official_nws.py:430`,
  `test_geocode.py:301, :322`, `test_aircraft.py:172`; recorders (R25).
- New tests:
  - WFIGS normalisation and active rule; `POOState` mismatch kept (Paradise, Zamora Bend, Sharpe);
  - CA merge: Orleans/Butler/Big Cliff, TCU/2-2 ×2/2-7/2-8/6-2/6-5, Swift/Peak, Log (-6 d), Gianelli, Bradford
    Branch/Dale, McCovey vs Marshall (stay separate), Alpaugh (added), Timber (one row);
  - issuer text: a WFIGS summary yields no "CAL FIRE" in bundle warnings, sources, ignition or forecast text (R22);
  - `fill_from_catalog` resolves a WFIGS id with no bundle (no 404); NWS UGC-prefix filter (a Montana alert never
    reaches a Florida fire, and no zone is loaded for it); Open-Meteo weight formula and the budget path;
  - ids from IRWIN and UFI year; `time_zone_at` at El Paso TX (Mountain), Florida panhandle (Central), Malheur County
    OR (Mountain), Navajo Nation AZ (DST) vs Phoenix and Hopi (no DST), border points; UTM zones; LANDFIRE land mask
    (coast and border keep LF2025); gazetteer "Springfield, IL", ZIP state, AK note.

## 6. Questions for the user

**Answered in round 2 (no longer open).** Q1 California source → (b) CAL FIRE plus WFIGS gaps (D2-2). Q2 which
active fires → all of them, any size (D2-1); the first pass's "> 10 ac" recommendation is withdrawn. Q3 complexes →
member fires listed on their own (default), except in California (Q-B). Q4 auto-build → keep 4, chosen nationally
(D2-4); R13 now follows it. Q5 cameras → California only (default); the other option needed a vendor agreement, which
the standing rule already excludes, so it was never a real choice.

**Still open (both follow from D2-2 and the corrected Timber finding).**
- **Q-A. A California fire that one agency calls active and the other does not.** Timber is 97 % contained; NIFC lists
  it as active, CAL FIRE marks it not active.
  - **(a) Show it as active when either agency's record says so; the card shows each record with its own issuer,
    status and time (recommended: hiding a 25,000-acre fire that is still being contained reads like an all-clear).**
  - (b) CAL FIRE decides (Timber appears only in the 2026 list).
  - (c) NIFC decides, as in the other states.
- **Q-B. California complexes.** CAL FIRE lists a complex as one fire (TCU September Lightning Complex, 13,869 ac); NIFC
  lists its member fires (2-2, 2-7, 2-8, 6-2, 6-5).
  - **(a) Keep CAL FIRE's one complex row in California and name its member fires in the card; elsewhere list member
    fires as decided (recommended: follows "CAL FIRE stays the record").**
  - (b) Split California complexes into NIFC's member fires too (CAL FIRE's complex acreage then matches no marker).

## 7. Evidence log (2026-10-22 UTC; all GET; FIRMS key masked, count-only; 0 non-GET)

| Time | Status | Bytes | Request (no secrets) | Result |
|---|---|---|---|---|
| 21:30:38-39 | 200 | 30/29 KB | WFIGS `_Current` and `_YearToDate` layer `?f=json` | 97/98 fields; no URL field; `IncidentSize`, no `DailyAcres` |
| 21:31:14-36 | 200 | 1-3 KB | YTD stats by type; WF >= 300 by `POOState`; flags | WF 37,396; 1,203 (AK 25, HI 1); 21 children |
| 21:31:50 | 200 | 1.0 MB / 525 KB | YTD rows `WF,CX` >= 300; Current rows (all) | 1,210 rows; 638 (RX 342, WF 295, CX 1) |
| 21:32:50-59 | 200 | 3/115/24 KB | Current FeatureServer; services root; AGOL item `4181a117…` | active rule, licence, credit |
| 21:33:12-41 | 200 | 0.7-382 KB | all-years 2025 by state; CA 2025 >= 300; CAL FIRE 2025 list; CAL FIRE live | 861 L48; 79; 556 (78 >= 300); 3 |
| 21:34:40-41 | 200 | 378 B | YTD open on 2026-08-01 (>= 10 / >= 300 ac) | 180 / 68 |
| 21:35:09 | 200 | 271 KB | Interagency Perimeters YTD attrs (WF, >= 300) | 822 of 1,178 fires |
| 21:35:27-28 | 200 | 14 KB | NWS `alerts/active` RFW/FWW: no area; 49-code `area=` | 3 and 3 (WY, MT) |
| 21:35:49-50 | 200 | 3/4 KB | IEM `vtec_events_bypoint` OK, AZ | OK FW.W x3, FW.A x3; AZ none |
| 21:36:17 | 200 | 972 KB | FIRMS SNPP `USA_contiguous_and_Hawaii_7d.csv`; area API Oregon 2 days | 11,799 rows; 129 rows |
| 21:36:44-38:17 | 200 | 0.2-10 KB | NAIP MT/FL; LANDFIRE LF2024/LF2025/FA26 OK/FL; 3DEP OK; Open-Meteo OK/FL, MT | 2021/2023; 189, 102, NoData ×3; 600.7 m; 48/48 h, 31 members |
| 21:39:05-40:58 | 200 | 0.1-1.2 MB | BTS `NTAD_Time_Zones`; TIGERweb states; Census 2026 Gazetteer national files | public domain; 4 zones; 49+DC; 32,363 / 33,791 / 3,222 rows |
| 21:45:10 | 200 | 9 KB | NWS `/zones?id=<8 UGCs>&include_geometry=true` | no geometry |
| 22:50:54 | 200 | 5 KB | all-years CA WF >= 10 ac, count by `POOCounty,GACC` | 57 counties, 12 with > 1 GACC |
| 22:50:56 | 200 | 12 KB | Current query `IrwinID='{51374D2C…}'` `f=html` | Timber record page |
| 22:50:58 | 200 | 384 KB | CAL FIRE `List?inactive=true&year=2026` | Timber 25,351.9 ac, 97 %, IsActive false |
| 22:52:52-53:21 | 200/400/200 | 18 KB / 72 B / 55 KB | TIGERweb AIANNHA meta; layer 2 query (named fields: 400); retry `outFields=*` | Navajo 2,796 + Hopi 141 vertices |
| 22:52:54 | 200 | 28 KB | weather.gov/gis/FireZones | `fz16ap26.zip`, 3,683 zones |
| 22:52:56 | 200 | 331 KB | `cdn.proj.org/files.geojson` | `us_nga_egm96_15.tif` 2.7 MB |
| 22:53:43 | 200 | 13 KB | NWS reference map MapServer `?f=json` | layer 9 Fire Weather Zone Forecasts |
| 22:54:08-09 | 200 | 380 B / 143 KB | GIBS `GOES-East_ABI_GeoColor` DescribeDomains; z5 tile FL | every 10 min to 21:50; PNG |
| 22:54:11 | 200 | 4 KB | CMR `VNP14IMG_NRT` point FL, 24 h | 2 granules |
| 22:54:13 | 200 | 481 KB | Earth Search GET `/search` S2 L2A, Tampa box, Jun-Aug 2025 | 23 scenes, 2 < 20 % cloud |
| 22:55:27 | 200 | 464 KB | all-years CA WF >= 1 ac, 2024-12-20..2026-01-10 | 1,673 rows |
| web | – | – | landfire.gov/node/6129; open-meteo.com/en/terms, /en/pricing, /en/docs/ensemble-api; PROJ-data `us_nga_README.txt`; 1 search (NWCG unit ids) | LF2025 schedule; weighted counting; EGM96 public domain |

Local API (first pass, port 8711, `FIRE3D_LIVE=0`): `/api/geocode?q=Bozeman, MT` → no match, "No California city…"
(`docs/screenshots/audit3-backend-geocode-bozeman.png`); `/api/incidents?mode=live` → 3 CA fires;
`/api/official/fire-weather` → 0 alerts, "in effect in California" (`docs/screenshots/audit3-backend-fireweather-ca-only.png`).
Offline checks (revision, `FIRE3D_DATA_DIR` in the scratchpad): fire weather for a non-CAL FIRE id → HTTP 404; a
Montana alert with unloadable zones → listed for a Florida fire. Analysis scripts: scratchpad `audit-backend-us/rev/`.

## 8. Revision notes (after the independent review)

- **Corrected:** CA dedupe rerun with complex suppression, lag tolerance and all CAL FIRE sizes: 2 WFIGS gaps in 2025,
  not 11. **Timber is on CAL FIRE's 2026 list** (only its active flag differs); round-2 decision 2 cites it as an
  example of a fire CAL FIRE does not list, which came from this audit's error. `POOState` decides listing (polygons
  missed 3 real fires). FIRMS loaders keep a box with a margin; parquet growth "up to ~10-15x", not "3-4x". Gazetteer
  path `backend/fire3d/data/` (root `data/` is gitignored). Open-Meteo counting is documented and weighted.
- **Added:** B9 + R22 (CAL FIRE issuer text in bundles), B10 + `fill_from_catalog` (fire-weather 404), B11 + the
  UGC-prefix design for R9 (shared with EV-R7), R23 (county → GACC fallback, measured), R24 (README/SPEC credits),
  R25 (recorders), the WFIGS record link and agency-code handling (R10), the weighted request model (2.5), default
  year 2026 and UFI year (R1), ", CA" search strings (R12), I12-I14.
- **Strengthened:** R8 defines "land" and labels cells outside fuel coverage as unknown; R13 keeps 4 / 100 ac (D2-4)
  and adds a weighted budget; R14 adopts V-R5 and I6 is a BLOCKER; R17 names the in-handler gzip; R18 is P1 with a
  checked source; R15, R20 checked live.
- **Questions:** Q1-Q5 marked answered by round 2; two new ones (Q-A, Q-B) that follow from D2-2 and the Timber
  correction.
- **Critic points not adopted as stated:** R17 "reuse `_gzip_cache`": it is keyed by file path and mtime, so the
  handler should gzip the JSON body directly instead. The critic's "10 of 78 CAL FIRE fires have no GACC": matched
  against WFIGS fires of any size it is 5 of 78, all in OSCC-only counties.
