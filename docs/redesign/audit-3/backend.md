# Audit 3: backend generalization from California to the lower 48 states

Role `audit-backend-us` (brief 3, stage A). Read-only: no project code changed, no fire built, no "Prepare analysis".
Live checks were polite GETs through `fire3d.http` (identifying User-Agent, disk cache) on **2026-10-22, 21:30-21:45 UTC**;
the evidence log is section 7. A local API ran on port 8711 with `FIRE3D_LIVE=0` (11 GETs, 0 non-GET) and was stopped.
Evacuation feeds are covered by `audit-3/evacuations.md` (cited as EV-R1 … EV-R10); the web side and the
accuracy regions by `audit-3/web.md` and `audit-3/validation.md`. They are cross-referenced, not repeated.

## 0. Summary

- **Every list, lookup and filter that decides "which fires exist" is California-only.** The catalog reads CAL FIRE only
  (`catalog.py:229-301`), FIRMS feeds are cut to the CA box (`firms.py:652, :687`), perimeters ask for `US-CA` only
  (`perimeters.py:80, :181, :326, :538`), NWS asks `area=CA` (`nws.py:445`), UTM is zone 10/11 (`grid.py:59-61`).
- **NIFC WFIGS can replace CAL FIRE as the national list** (same IRWIN data the perimeters already use; public, no key,
  refreshed from IRWIN every 5 min). Measured today:
  - **2026 wildfires >= 300 ac in the lower 48: 1,178** (CA 69, other states 1,109; OK 135, TX 119, FL 105, OR 85, ID 84).
  - **2025: 861** (CA 79; CAL FIRE lists 78). Alaska (25 in 2026, 122 in 2025) and Hawaii (1, 1) are filtered out.
  - **Active now: 241** wildfires in WFIGS "Current" (lower 48, containment < 100 %); only **63 are > 10 ac**, 109 are
    <= 1 ac and 45 have no size. A rough summer estimate (open on Aug 1, 2026; containment dates are often missing):
    about 180 fires >= 10 ac, 68 >= 300 ac.
  - 43 % of the 2026 fires >= 300 ac are in the Southern Area (501); only 48 % of those have a WFIGS perimeter
    (TX/OK 66 %, the Southeast 30 %), against 94-98 % in the Northwest and Great Basin.
- **Silent wrong results today outside CA** (BLOCKERs): live fires get zero FIRMS feed detections (never refreshed,
  never auto-built); keyless historical builds get zero archive detections; a Montana fire's fire-weather card asks
  NWS for California alerts only (at 21:35 UTC NWS had 3 Red Flag Warnings in MT/WY while Fire-3d said none in CA);
  LANDFIRE LF2025 (used for live fires) is **NoData** in the South/Central/East until its November 2026 release, and a
  partly covered AOI passes the check with NoData turned into non-burnable fuel.
- **Time zone and state are computable offline from two small public-domain files**: USDOT BTS NTAD Time Zones
  (111 KB GeoJSON for the 4 zones) and Census state boundaries (49 features, 310 KB, 93 KB gzipped).
- **Gazetteer grows ~21x**: 31,553 places + 33,300 ZIP areas + 3,109 counties = 2.8 MB JSON (0.9 MB gzipped).

## 1. What exists (California assumptions, file:line)

| Area | Where | Assumption |
|---|---|---|
| Incident list | `catalog.py:39` `HISTORICAL_YEAR=2025`; `:112-139` `summary_from_record` (CAL FIRE fields); `:242-263` live = CAL FIRE active; `:266-270` year = CAL FIRE year list; `:317-354` `get_summary` via CAL FIRE lists | Only CAL FIRE (`calfire.py:33` `incidents.fire.ca.gov`) |
| CA outline | `catalog.py:62-66` `CA_OUTLINE`, `:147-152` `in_california`, `:253` state-wide total | `LiveStatus.detections_24h_ca` (`contracts.py:438-443`) |
| Ids | `catalog.py:83-85`, `pipeline.py:71-91` `spec_incident_id` / `is_catalog_incident` from `calfire_uid` | `IncidentSummary.calfire_uid: str` required (`contracts.py:67`; web `types.ts:14`) |
| Build gate | `pipeline.py:461-465`, `app.py:496` "not in the CAL FIRE catalog"; data source text `pipeline.py:515` | Only CAL FIRE ids buildable |
| FIRMS | `config.py:109` `CA_BBOX`; `firms.py:632-661` `load_live_ca` filters the US feed to the CA box; `:667-719` `load_year_ca` caches `firms_ca_{year}.parquet` (CA box) | Feeds and archive are already national (`firms.py:68-69`) but cut to CA |
| FIRMS users | `catalog.py:252, :416`; `live.py:124-167` (cycle data, 24 h total); `pipeline.py:655` (`refresh_live` new-detection test); `firms.py:744` (keyless path) | Non-CA fires see no feed rows |
| Perimeters | `perimeters.py:80` `STATE="US-CA"` in `build_where` `:181`, `identity_filter` `:326`, spatial fallback `:538`; `_calfire_hint` `:553-567` | Name matching tuned to CAL FIRE names |
| UTM | `grid.py:59-61` `utm_epsg_for`: 32610 if lon < -120 else 32611; `scripts/check_bundle.py:139` same rule; SPEC §4.1 | Zones 10/11 only (lower 48 needs 10-19) |
| Time zone | `observed.py:89, :199-201` labels "Jan 07, 18:18 PST" baked into bundle text (`:1337, :1349, :2113-2118`); `overpass.py:50, :113-116`; `live_observation.py:74-75, :138-149, :240-243`; month for live fuel moisture `ensemble.py:70, :307`, `behavior.py:32, :246`, `weather_bundle.py:520-526`; SPEC §4.2 "UI displays America/Los_Angeles" | Pacific time everywhere |
| Fuel moisture | `config.py:163-180` CA monthly LFM table + Oct-1 water-year green-up; `weather.py:508-515`; `moisture.py:109` | Mediterranean climate (cross-ref `audit-3/validation.md`) |
| LANDFIRE | `landfire.py:55-57` `edition_for(mode)` (LF2025 live); `:95-98` raises only if < 0.5 % of the AOI has fuel codes; `aoi.py:282-291` falls back to the other edition only on that error | LF2025 is complete only in the SW and NW GeoAreas (section 2.3) |
| NWS / IEM | `nws.py:4-5, :442-460` `area=CA`; `official.py:292-313` overview caveat "in California"; IEM (`nws.py:876`) is point-based | Live alerts CA-only; archive already national |
| Official record | `official.py:43-44, :104-185, :198-250` CAL FIRE record + `calfire_history.py` (`DATA_DIR/official/calfire/<UniqueId>.jsonl`) | No national equivalent |
| Live loop | `live.py:41-43` auto-build 4 fires >= 100 ac with 48 h detections; `:153-167` CAL FIRE + CA feed; `:337-361` candidates | Sized for ~5-20 CA fires |
| Search | `geocode.py:142` `gazetteer_ca.json`, `:148` state words CA only, `:154-157` "California only" notes; `scripts/build_gazetteer.py:36-47, :89` CA place file, CA ZIP regex, CA box | Address lookup (Census Geocoder) is already national |
| Extras | cameras CA-only (`extras.py:72-75, :140-170, :791`); GOES-West only (`extras.py:1389, :1406, :1423`) | Eastern fires are at the GOES-West limb |
| Aircraft | `config.py:349` `GEOID_UNDULATION_CA_M=-33` (`aircraft.py:208`); CAL FIRE fleet patterns `config.py:284-315` | Geoid varies by tens of metres across the lower 48 |

## 2. Findings

### 2.1 NIFC WFIGS as the national incident list
- **Layers** (`services3.arcgis.com/T4QMspbfLg3qTGWY`, owner `NIFC_Authoritative`): `WFIGS_Incident_Locations_Current`
  (active), `_YearToDate` (2026), `WFIGS_Incident_Locations` (all years; used for 2025). 97 fields, max 2,000 rows per
  page. Points in NAD83 by default: request `outSR=4326`.
- **Fields present**: `IncidentSize` (there is **no `DailyAcres`** any more; minimum 0.1), `PercentContained`,
  `FireDiscoveryDateTime`, `ContainmentDateTime`, `ControlDateTime`, `FireOutDateTime`, `ModifiedOnDateTime_dt`,
  `IncidentTypeCategory` (WF 37,396 / RX 5,799 / CX 13 in 2026), `POOState` ("US-OR"), `POOCounty`, `GACC`,
  `UniqueFireIdentifier` ("2026-TXTXS-000006"), `IrwinID` ("{88F4…}"), `IsCpxChild`/`CpxName`/`CpxID`,
  `POOProtectingAgency`, `ICS209ReportDateTime`, `IncidentManagementOrganization`. No null `IrwinID`/UFI, no duplicate
  IRWIN ids among the 1,178.
- **"Current" is NIFC's own active rule** (item description): WF/RX/CX not declared contained, controlled or out, not
  certified, valid and not quarantined; fall-off when not edited for 3 days (< 10 ac), 8 days (10-100 ac) or 14 days
  (> 100 ac); refreshed from IRWIN every 5 min. Measured: 0 of 293 lower-48 WF rows have a containment or out date;
  all edited within 14 days.
- **Terms**: item licence is a disclaimer only (no use restriction); credit "NIFC WFIGS (IRWIN)" with the item's
  access line: "US Department of Interior Office of Wildland Fire: IRWIN, USDA Forest Service, NPS, FWS, BIA, BLM,
  National Association of State Foresters, US Fire Administration, NWCG". Already used for perimeters (SPEC §2).
- **Field quality (2026, lower 48, >= 300 ac, n=1,178)**: `PercentContained` null 91 (8 %); `ContainmentDateTime`
  null 523 (44 %); `FireOutDateTime` null 770 (65 %); 437 say 100 % contained but have no containment time; 76 have a
  containment time but < 100 %. 494 have neither containment nor out, of which 242 were last edited > 90 days ago:
  **YTD rows without a containment date are not "active"**. 402 names are ALL CAPS ("LITTLE GIANT"); 2 carry odd
  text ("BUCKET SHOP (53)~"). `FinalAcres` set on 20 only: use `IncidentSize`.
- **Active now (Current, WF, lower 48, % < 100 or null)**: 241. Size: <= 1 ac 109, 1-10 ac 24, 10-100 19,
  100-300 10, 300-1,000 7, 1,000-10,000 14, > 10,000 13, unknown 45. `PercentContained` null for 203 of 293.
- **Duplicates and complexes**: WFIGS repeats some fires under two IRWIN ids ("2-2" in CA 2025: 3,462 and 3,462.84 ac,
  5 km and 23 days apart); 2026 has 6 CX parents >= 300 ac and 21 WF children >= 300 ac (`IsCpxChild=1`).
- **AK/HI and others**: `POOState` values seen: US-AK, US-HI, US-PR, US-GU, US-VI, US-DC, MX-BN, CA-ON. All 1,178
  lower-48 rows by state also fall inside a lower-48 box.

### 2.2 California: CAL FIRE vs WFIGS (dedupe)
- CAL FIRE `UniqueId` is **not** the IRWIN id (0 of 79 equal), so matching must be spatial/name/time.
- 2025, >= 300 ac: CAL FIRE 78, WFIGS-CA 79. Rule "same name tokens or <= 3 km, <= 15 km and discovery within 3 days"
  matched **68** (62 by name, median 0.6 km). Unmatched CAL FIRE: complexes (Orleans Complex ↔ Butler + Big Cliff;
  TCU September Lightning Complex ↔ 2-2/2-7/2-8), a 6-day start lag (Log), sizes below 300 in the other list.
  Unmatched WFIGS: federal fires CAL FIRE does not list (Butler 21,058 ac USFS, Alpaugh BLM) and duplicates.
- **Now**: CAL FIRE's live list has 3 fires; WFIGS Current has 77 CA wildfires (10 >= 10 ac), including Timber
  (USFS, 25,350 ac, 97 %), which the CAL FIRE list does not show.

### 2.3 Build sources outside California
| Source | Coverage outside CA (checked) | Note |
|---|---|---|
| USGS 3DEP DEM | OK point 600.7 m | national |
| LANDFIRE LF2024 FBFM40 CONUS | FL 189, OK 102 | complete CONUS |
| LANDFIRE LF2025 + seasonal FA26 | **NoData** at OK and FL points | landfire.gov "LANDFIRE 2025 Update": SW released Apr, NW Jun 2026; SC, SE, NC, NE "November" |
| NAIP (USGS) | MT 2021, FL/GA 2023 tiles | vintages differ by state (2-4 years old): record the year |
| Sentinel-2 dNBR (Earth Search) | global | humid Southeast summers: fewer scenes under the 20 % cloud filter (degrades to "unavailable") |
| FIRMS 7d feed (keyless) | 11,799 SNPP rows: 10,484 in a lower-48 box, 812 in the CA box, 440 Hawaii | ~13x the CA rows |
| FIRMS area API (key) | Oregon box, 2 days: 129 rows, 1 request | national |
| WFIGS perimeters | 822 of 1,178 2026 fires >= 300 ac (70 %). By GACC: NWCC 94 %, GBCC 98 %, ONCC 94 %, RMCC 84 %, OSCC 80 %, NRCC 78 %, EACC 68 %, SWCC 66 %, SACC 48 % (TX/OK 66 %, Southeast 30 %); OK 57/135, FL 26/105; 18 of 221 fires >= 5,000 ac lack one | detection-only burned areas are common in the South |
| Open-Meteo HRRR history + GFS ensemble | OK/FL: 48/48 h for `gfs_hrrr`; MT: 31 members | free API: 600/min, 5,000/h, 10,000/day (open-meteo.com/en/terms); CC BY 4.0 |
| NWS alerts | `area=` takes a 49-code list (same 3 alerts as no-area) | zone polygons: `/zones?id=` batch has no geometry, so one request per zone |
| IEM VTEC archive | OK March 2025: FW.W x3 / FW.A x3 (OUN); AZ July 2025: no FW | point-based, national |
| CMR passes | point query (`overpass.py:185`) | national |

### 2.4 Time zone and state, offline
- **Time zones**: USDOT BTS NTAD "Time Zones" (ArcGIS `NTAD_Time_Zones`, updated 2023-01-05): "a work of the United
  States government … available for unrestricted public use". 9 zones with `zone`/`utc` only (no DST). Lower 48 at
  0.005° (~500 m): 4 polygons, 5,749 vertices, 111 KB GeoJSON. IANA mapping: Pacific → America/Los_Angeles,
  Mountain → America/Denver, Central → America/Chicago, Eastern → America/New_York, **except Arizona → America/Phoenix
  (no DST), with the Navajo Nation → America/Denver and the Hopi Reservation inside it → America/Phoenix** (Census
  AIANNH polygons, public domain; not fetched in this audit). Idaho/Indiana/Kentucky/Michigan aliases have identical rules since 2007.
- **States**: Census TIGERweb `State_County/MapServer/0` ("Source: U.S. Census Bureau", public domain) at 0.005°:
  49 lower-48 + DC features, 310 KB (93 KB gzipped). Shapely STRtree assigned all 33,791 ZCTA points in 105 ms
  (0 unassigned). No new dependency (shapely is present; no shapefile reader is installed, so the build script should
  use the ArcGIS GeoJSON output, not the cb_*.zip shapefiles).

### 2.5 Live loop at national scale
- Runtimes from earlier reports: builds 47-192 s, forecasts 2-30 s (live refresh time not measured); 4 CPUs here.
- `assign_detections` (`catalog.py:160-178`) builds dense detections x incidents arrays (8 B each, several
  temporaries): 50k detections x 250 fires is ~100 MB per array; summer peaks (100k x 1,000) would not fit.
- Request budgets that matter: Open-Meteo 10,000/day (free terms), FIRMS key 5,000/10 min (Fire-3d caps at 150),
  NWS 30/min client limit (`nws.py:102`), CMR 60/min (extras) + `overpass` limiter.

## 3. Gaps

| # | Gap | Grade | Evidence |
|---|---|---|---|
| B1 | No national incident list; only CAL FIRE | **BLOCKER** | `catalog.py:229-301`; API on 8711: `mode=live` → 3 CA fires while WFIGS has 241 lower-48 active |
| B2 | FIRMS feed and archive cut to the CA box: non-CA live fires never get detections, so no `detections_24h`, no auto-build, `refresh_live` never sees new detections; keyless historical builds get no archive rows | **BLOCKER** | `firms.py:652, :687`; `pipeline.py:655`; `live.py:163` |
| B3 | NWS live alerts requested for CA only; a non-CA fire's card reports none | **BLOCKER** (official info) | `nws.py:445`; screenshot `audit3-backend-fireweather-ca-only.png` vs 3 MT/WY RFWs |
| B4 | UTM zone 10/11 only: every AOI east of 120°W uses zone 11. Scale error (pyproj): 1.3 % Colorado, 4 % Oklahoma, 16 % Florida (areas 35 % too big), so pixel sizes, spread rates and acres drift | **BLOCKER** | `grid.py:59-61`; `check_bundle.py:139` |
| B5 | Pacific time baked into bundle text and the month used for live fuel moisture | **BLOCKER** (brief: never assume Pacific) | `observed.py:199-201, :2113`; `live_observation.py:74`; `ensemble.py:307` |
| B6 | LANDFIRE LF2025 NoData outside SW/NW until Nov 2026; a partly covered AOI keeps NoData as non-burnable 99 | **BLOCKER** (silent wrong fuels) | `landfire.py:95-98`; OK/FL identify = NoData |
| B7 | Perimeters filter `US-CA`; non-CA fires get none | **BLOCKER** | `perimeters.py:80, :181, :326` |
| B8 | Ids, build gate and contract need a CAL FIRE UniqueId | **BLOCKER** | `pipeline.py:71-91, :461-465`; `contracts.py:67` |
| I1 | No `state`, `time_zone` or GACC on `IncidentSummary`; no point lookup | MISSING | `contracts.py:62-82` |
| I2 | No official record card outside CA (CAL FIRE only) and no national change history | MISSING | `official.py:198-250`; `calfire_history.py` |
| I3 | Gazetteer CA-only; notes say "Fire-3d covers California only" | MISSING | `geocode.py:154-157`; screenshot `audit3-backend-geocode-bozeman.png` |
| I4 | AK/HI not excluded anywhere (FIRMS feed includes Hawaii; Census geocoder answers AK/HI addresses) | MISSING | 2.1 |
| I5 | Live loop caps sized for CA; dense detection matching | INCOMPLETE | `live.py:41-43`; `catalog.py:160-178` |
| I6 | CA live fuel moisture table applied everywhere | INCOMPLETE (accuracy) | `config.py:163-180`; see `audit-3/validation.md` |
| I7 | GOES-West only for "recent imagery" | INCOMPLETE | `extras.py:1389` |
| I8 | Cameras CA-only, with no "not available in this state" answer | INCOMPLETE | `extras.py:791` |
| I9 | `/api/incidents` rows are ~600 B uncompressed JSON; a 2,000-row list is ~1.2 MB | INCOMPLETE | `app.py:425-455` |
| I10 | Aircraft: CA geoid constant, CAL FIRE-centric fleet patterns | INCOMPLETE (minor) | `config.py:284-349` |
| I11 | Tests encode CA (CA box, `US-CA` where-clause, `area=CA` URL, 1,622 CA places, "California only" notes, geoid -33) | INCOMPLETE | 5 |

## 4. Design and recommended changes

**Catalog (R1).** New `sources/wfigs.py`: `list_current()` (5-min cache), `list_year(year)` (YTD for the current year,
30 min; all-years layer for past years, 24 h), server-side `IncidentTypeCategory='WF'` and, for year lists,
`IncidentSize>=300`, explicit `outFields`, `outSR=4326`. Normalize to the CAL FIRE record shape. Rules:
- lower 48 = `POOState` in the 48 + DC codes **and** the point inside the state polygons (else dropped and logged);
- active = in Current, `PercentContained` null or < 100 (CAL FIRE `IsActive` in CA); the overview threshold is Q2;
- `contained_ms` = Containment, else Control, else FireOut; never inferred; `percent_contained` null means "not reported";
- complexes: list WF children, not CX parents (Q3); WFIGS duplicates: same name tokens and state, size within 1 %,
  <= 10 km and discovery <= 30 days apart → keep the most recently modified (log the dropped id);
- California (Q1): CAL FIRE stays the record; matched WFIGS rows (perimeter rules: tokens, -7/+20 d, 30 km, `CpxName`)
  add `irwin_id`; unmatched CA WFIGS fires (federal) are added with `record_source: "wfigs"`;
- ids keep SPEC §4.4: `{year}-{slug}-{uid6}`, uid6 from the IRWIN id without braces for WFIGS fires (existing CA ids
  and bundles unchanged); `get_summary` resolves a WFIGS id with one cached `IrwinID LIKE '{ABCDEF%'` query;
- display `name` title-cased when the source is ALL CAPS; `source_name` keeps the verbatim name.

**Contract (R2, additive; names match `audit-3/web.md` 3.4 and `audit-3/validation.md` 5).** `IncidentSummary`
gains `state` (USPS), `time_zone` (IANA), `uid` (CAL FIRE UniqueId or IRWIN id without braces), `record_source`
("calfire" | "wfigs"), `record_agency` (CAL FIRE, or WFIGS `POOProtectingAgency`), `record_url` (https or null),
`irwin_id`, `gacc` (WFIGS `GACC`) and `accuracy_region` (validation: `SACC-SP` = SACC in TX/OK, `SACC-SE` the rest);
`name` is the display name and `source_name` the verbatim one. `calfire_uid` stays a deprecated alias of `uid`
(string, not breaking), so the UI must stop calling it "CAL FIRE UID" (`MapHeader.tsx:74-86`,
`IncidentOverview.tsx:87`; `official/calfire.ts:89` must check `record_source`). Old manifests: fill `state`/
`time_zone` on read (CA bundles → "CA", America/Los_Angeles). `LiveStatus` adds `detections_24h` (keep `_ca`).
`/api/incidents` adds `state=` and gzip. New `GET /api/geo/lookup?lon=&lat=` → `{state, state_name, time_zone,
supported}` for the location card and EV-R1. `spec_incident_id` uses `uid`. NWS `/points` `timeZone` was considered
for the zone and rejected: one request per point and an outage would leave a fire without a zone.

**Regions (R3).** `scripts/build_us_regions.py` writes `fire3d/data/us_states.geojson` (310 KB) and
`us_timezones.geojson` (~120 KB incl. Navajo/Hopi) from the public-domain services above; `fire3d/regions.py` gives
`state_at`, `states_in_bbox`, `time_zone_at` (fallback: nearest zone within 5 km, then the state's main zone), `supported`.

**Fixes by area.**

| # | Change | Value | Effort | Risk | Files | Priority |
|---|---|---|---|---|---|---|
| R1 | WFIGS catalog + CA merge (above) | Brief items 1-2 | L | Medium: field quality, dedupe | `sources/wfigs.py` (new), `catalog.py`, recorded samples `tests/data/firedata/wfigs_*` | **P0** |
| R2 | Contract additions; ids from `uid`; build gate text | Non-CA fires buildable | M | Medium: web types follow | `contracts.py`, `pipeline.py:71-91, :461-515`, `app.py:496`, SPEC §4.4/§5/§6, CONTRACT §14, `web/src/api/types.ts` | **P0** |
| R3 | Region data + lookup + `/api/geo/lookup` | Time zone, state, AK/HI, EV-R1 | M | Low | `fire3d/regions.py`, `fire3d/data/us_*.geojson`, `scripts/build_us_regions.py`, `api/app.py` | **P0** |
| R4 | `utm_epsg_for = 32600 + floor((lon + 180) / 6) + 1` (zones 10-19; same answer for CA) | Correct grids | S | Low | `grid.py:59-61`, `check_bundle.py:139`, SPEC §4.1 | **P0** |
| R5 | FIRMS: `load_live_us` / `load_year_us` (lower-48 box, then state polygons), parquet renamed `firms_us_{year}` so the CA cache is not reused; KD-tree `assign_detections` | Live and keyless builds work | S-M | Low; archive parquet ~3-4x bigger | `firms.py:632-719`, `catalog.py:160-263, :416`, `live.py:124-167`, `pipeline.py:655` | **P0** |
| R6 | Perimeters by IRWIN id when known (`attr_IrwinID` / `poly_IRWINID`), `STATE` from `summary.state`; no `_calfire_hint` outside CA | Perimeters for 70 % of fires | S-M | Low | `perimeters.py:80-182, :318-330, :536-640` | **P0** |
| R7 | Fire-local time zone for labels ("Jan 07, 18:18 MST") and the LFM month; `time_zone` passed through `BuildContext` | Brief rule | S | Low | `observed.py`, `overpass.py`, `live_observation.py`, `ensemble.py`, `behavior.py`, `weather_bundle.py` | **P0** |
| R8 | LANDFIRE: fall back to (or fill from) LF2024 when > 2 % of land cells are NoData; note it in warnings | Correct fuels until LF2025 completes | S | Low | `landfire.py:95-98`, `aoi.py:273-293` | **P0** |
| R9 | NWS: `area=` the 49 codes; overview caveat "in the lower 48 states"; `state=` option | Official alerts for every fire | S | Low | `nws.py:442-460`, `official.py:292-313`, tests | **P0** |
| R10 | Official record outside CA: `GET /api/official/incident-record` (kind `incident_record`, WFIGS/IRWIN fields verbatim with their own times, issuer = protecting agency, link = public WFIGS record page); `/api/official/calfire` answers `not_covered` outside CA | Official info per fire | M | Low | `api/official.py`, `contracts.py`, CONTRACT §14 | **P0** |
| R11 | `sources/wfigs_history.py`: append-only `DATA_DIR/official/wfigs/<irwin>.jsonl`, same rules as `calfire_history` (keys: `ModifiedOnDateTime_dt`, size, %, containment/control/out) | Change history like CA | M | Low | new + `catalog.py` | P1 |
| R12 | National gazetteer: place + ZCTA + county national files (public domain), `state` per row (ZIP state by point-in-state), all LSADs (city, town, village, borough, CDP …), "Springfield, IL" parsing, AK/HI "not supported yet" note | Search nationwide | M | Low; 2.8 MB file | `scripts/build_gazetteer.py`, `api/geocode.py`, `data/gazetteer_us.json` | **P0** |
| R13 | Live loop: candidates = active, >= 300 ac, detections in 48 h; at most 1 new auto-build per cycle, 6 auto-built and 12 tracked live bundles (env-configurable); stop refreshing fires that left Current or had no detection for 72 h; Open-Meteo daily counter (stop at 6,000/day), weather refresh at most hourly | Bounded CPU and requests | M | Medium | `live.py`, `config.py`, `http.py` limiter | P1 |
| R14 | Regional live fuel moisture tables keyed by `accuracy_region` (CA rows until calibrated); validation G5 grades this a BLOCKER for SP/SE/SW validity and owns the values | Accuracy outside CA | M | Medium | `config.py`, `moisture.py` | P0 (with validation) |
| R15 | GOES-East GeoColor (GIBS `GOES-East_ABI_GeoColor`) for fires east of ~105°W | Usable 10-min imagery in the East | S | Low | `extras.py:1387-1423` | P1 |
| R16 | Cameras and other CA-only extras answer `unavailable/not_covered` "not available in this state" outside CA | Honest wording | S | Low | `extras.py:790-860` | P1 |
| R17 | gzip JSON (Starlette `GZipMiddleware`, no new dependency) for `/api/incidents` | 1.2 MB → ~0.2 MB | S | Low | `app.py` | P1 |
| R18 | NWS fire-zone polygons for a busy national overview: bundle a simplified NWS fire-zone file (public domain) or fetch zones in the background | Overview not throttled by 30 zone requests/min | M | Low | `nws.py`, script | P2 |
| R19 | LANDFIRE edition by fire year (2026 fires: LF2025 where released) | Fresher fuels | S | Low | `landfire.py:55-57` | P2 |
| R20 | Aircraft: geoid from a coarse EGM96 table; add USFS/BLM/state fleet patterns | Altitudes ±20 m | S | Low | `config.py`, `aircraft.py` | P2 |
| R21 | Bundle retention (LRU for historical bundles, ~20 MB each) | Disk bounded with thousands of fires | S | Low | `bundle.py`, `live.py` | P2 |

Cross-references: EV-R1 (state availability) needs R3's `states_in_bbox`; web.md 3.1 (time) and 3.2 (overview) need R2's `time_zone`
and R17; validation's region file needs R2's `gacc`/`accuracy_region` (its GACC-polygon fallback has unverified terms).

## 5. Contracts and tests that assume California

- SPEC: §0 (scope), §2 rows (CAL FIRE, FIRMS archive, NWS `area=CA`), §4.1 (UTM), §4.2 (Pacific display), §4.4
  (`calfire_uid`), §5.1 `IncidentSummary`, §6 (incidents, geocode, official, live status), §8.1/§8.3 (CAL FIRE point
  and start), §8.4 (CA LFM), §8.6 (CAL FIRE fleet), §8.7 (CAL FIRE live loop). CONTRACT §13 official kinds; §14 new.
- Tests to update (behaviour kept for CA): `test_grid.py:32-35` (still pass with R4; add zones 12-19),
  `test_firedata_firms.py:313-372` (CA box → lower-48), `test_firedata_catalog.py:112, :158-161` (CA total/outline),
  `test_firedata_perimeters.py:58` (`US-CA` where), `test_official_nws.py:430` (`area=CA` URL),
  `test_geocode.py:301, :322` (CA counts, "California only"), `test_aircraft.py:172` (geoid -33).
- New tests: WFIGS normalisation and active rule (recorded Current/YTD samples), CA dedupe (Eaton/Palisades/Log/
  Orleans cases), duplicates and complexes, AK/HI exclusion, ids from IRWIN, `time_zone_at` at El Paso TX (Mountain),
  Florida panhandle (Central), Malheur County OR (Mountain), Navajo Nation AZ (DST) vs Phoenix (no DST), Hopi,
  border points; UTM zones; LANDFIRE partial-NoData fallback; NWS 49-code URL; gazetteer "Springfield, IL", ZIP
  state, AK note.

## 6. Questions only the user can answer

1. **Q1 California source.** (a) CAL FIRE only, as today (misses federal fires such as Timber, 25,350 ac, active);
   **(b) CAL FIRE stays the record, WFIGS adds the CA fires CAL FIRE does not list (recommended)**; (c) WFIGS everywhere.
2. **Q2 Which active fires to list** (241 now; the year list stays >= 300 ac). (a) all, including 109 fires <= 1 ac;
   **(b) > 10 ac (63 now), plus those of the 45 unknown-size fires that have satellite detections (recommended)**;
   (c) >= 100 ac (about 44); (d) >= 300 ac (34).
3. **Q3 Complexes.** **(a) list each fire of a complex with "part of the X Complex" (recommended)**; (b) one row per
   complex, hiding its fires.
4. **Q4 Auto-built live fires.** (a) keep 4; **(b) up to 6 auto-built, 12 kept current (recommended)**; (c) none,
   build on request only.
5. **Q5 Cameras outside California.** **(a) say "not available in this state" (recommended)**; (b) research
   ALERTWildfire/ALERTWest access (terms not published; likely an agreement).

## 7. Evidence log (2026-10-22 UTC; all GET; FIRMS key masked, count-only; 0 non-GET)

| Time | Status | Bytes | Request (no secrets) | Result |
|---|---|---|---|---|
| 21:30:38-39 | 200 | 30/29 KB | WFIGS `_Current` and `_YearToDate` layer `?f=json` | 97/98 fields; `IncidentSize`, no `DailyAcres` |
| 21:31:14 | 200 | 847 B | YTD stats by `IncidentTypeCategory` | WF 37,396, RX 5,799, CX 13 |
| 21:31:15 | 200 | 2.7 KB | YTD `WF AND IncidentSize>=300` by `POOState` | 1,203 (AK 25, HI 1) |
| 21:31:35-36 | 200 | 3 KB | YTD WF by state; >= 300 by `IsValid/IsQuarantined/IsCpxChild` | 53 state codes incl. PR, GU, VI, MX-BN, CA-ON; 21 children |
| 21:31:50 | 200 | 1.0 MB | YTD rows `WF,CX` >= 300 (27 fields, `outSR=4326`) | 1,210 rows |
| 21:31:50 | 200 | 525 KB | Current rows (all) | 638: RX 342, WF 295, CX 1 |
| 21:32:50-59 | 200 | 3/115/24 KB | Current FeatureServer; services root; AGOL item `4181a117…` | active rule, licence, credit |
| 21:33:12 | 200 | 3 KB / 693 B | all-years 2025 `WF >= 300` by state; all 2025 WF | 984 (L48 861, AK 122, HI 1); 41,731 |
| 21:33:39-41 | 200 | 43/382/2 KB | all-years CA 2025 >= 300; CAL FIRE 2025 list; CAL FIRE live | 79; 555 fire types (78 >= 300); 3 |
| 21:34:40-41 | 200 | 378 B | YTD open on 2026-08-01 (>= 10 / >= 300 ac) | 180 / 68 |
| 21:35:09 | 200 | 271 KB | Interagency Perimeters YTD attrs (WF, >= 300) | 853 records; 822 of 1,178 fires |
| 21:35:27-28 | 200 | 14 KB | NWS `alerts/active` RFW/FWW: no area; 49-code `area=` | 3 and 3 (WY, MT) |
| 21:35:49-50 | 200 | 3/4 KB | IEM `vtec_events_bypoint` OK 2025-03-10..20; AZ 2025-07-04..20 | OK FW.W x3, FW.A x3; AZ none |
| 21:36:17 | 200 | 972 KB | FIRMS SNPP `USA_contiguous_and_Hawaii_7d.csv` | 11,799 rows (10,484 L48 box, 812 CA box, 440 HI) |
| 21:36:17 | 200 | – | FIRMS area API `VIIRS_SNPP_NRT` Oregon box, 2 days (+ `data_availability`) | 129 rows |
| 21:36:44-51 | 200 | 7 KB | NAIP `identify` MT, FL | MT 2021; GA/FL 2023 |
| 21:37:06-38:02 | 200 | ~220 B | LANDFIRE `identify`: LF2024 FL/OK; LF2025 OK/FL; LF2025 metadata; FA26 OK; 3DEP OK | 189, 102; NoData, NoData; CONUS extent; NoData; 600.7 m |
| 21:38:16-17 | 200 | 6/10 KB | Open-Meteo historical-forecast OK+FL 2025-03-14..15; ensemble gfs025 MT | 48/48 h HRRR; 31 members |
| 21:39:05-33 | 200 | 11 KB/2 KB/111 KB | BTS `NTAD_Time_Zones` meta, attributes, 4 L48 zones at 0.005° | public domain; 4 polygons |
| 21:40:08-38 | 200 | 21/363 KB | TIGERweb `State_County` meta; states at 0.005° | 56 features; L48+DC 310 KB |
| 21:40:56-58 | 200 | 1.2/1.0/0.1 MB | Census 2026 Gazetteer place, ZCTA, county national zips | 32,363 / 33,791 / 3,222 rows |
| 21:45:10 | 200 | 9 KB | NWS `/zones?id=<8 UGCs>&include_geometry=true` | 8 zones, no geometry |
| web | – | – | landfire.gov/node/6129; open-meteo.com/en/terms and /en/pricing | LF2025 schedule; 10,000 calls/day, CC BY 4.0 |

Local API (port 8711, `FIRE3D_LIVE=0`): `/api/geocode?q=Bozeman, MT` → no match, "No California city…"
(`docs/screenshots/audit3-backend-geocode-bozeman.png`); `/api/incidents?mode=live` → 3 CA fires;
`/api/official/fire-weather` → 0 alerts, "in effect in California" (`docs/screenshots/audit3-backend-fireweather-ca-only.png`).
