# Audit 3 (A4): forecast validation outside California

Role `audit-validation`, 2026-10-22. Read-only for the project: no bundle builds, no servers. All times are UTC unless a
time zone is named. Data checks were small, polite requests through `fire3d.http`, which caches:
- about 75 NIFC WFIGS queries;
- 22 FIRMS requests (one area request per fire, plus availability);
- 19 Open-Meteo HRRR requests (one per fire) and 10 ERA5 requests;
- about 20 LANDFIRE requests.

Scratch scripts and raw outputs are in the session scratchpad, folder `audit-validation/` (not committed).

## Summary

- **Today no fire outside California can be built** (the build only knows CAL FIRE incidents, G1). **Four more
  blockers would make the scores wrong even after that is fixed:**
  - perimeters are filtered to `US-CA`;
  - the UTM zone is always 10 or 11;
  - 2024 fires get fuels that already contain their own burn scar;
  - the live fuel moisture table is California's, so it makes February Texas grass and March Appalachian fuels "green".
- **Proposed test set: 10 fires in the six regions, plus 2 "second fires" for the Southern Plains and the Southeast
  if the user allows 12, plus 5 reserves.** Every primary fire has 12 to 35 dated perimeters (Windy Deuce: 12 times
  over 8 days), 280 to 1,955 good VIIRS NOAA-20 detections in its main 5 days, and complete archived HRRR weather.
- **Accuracy label:** one number per region: the mean growth Sørensen of the hindcasts (the docs/validation.md
  headline metric), with the number of fires. Regions follow the official interagency coordination areas (GACCs),
  with the Southern Area split into Southern Plains (TX, OK) and Southeast. A number is shown only with at least
  2 fires and 16 scored leads. Otherwise the label says "Accuracy not yet tested here".

## 1. What exists

- **Validation protocol** (docs/validation.md §2, §5): 3 Southern California fires (Eaton, Madre, Palisades, all 2025).
  - 8 starts (ignition + 6/12/24 h; Madre + 24/48 h) and leads of 12/24/48/72 h give 32 scored leads.
  - Truth is the observed reconstruction (`build/observed.py`; VIIRS/MODIS/Landsat + NIFC perimeters + GOES timing).
  - Headline: mean **growth** Sørensen 0.432 for the deterministic member, 0.438 for the 31-member p50, with a
    median growth ratio of 1.85×. Total-area Sørensen is reported but inflated (§2).
  - Pseudo-live check: 0.234 growth Sørensen (§6.2).
- **Code**:
  - `spread/validate.py:47` `sorensen`; `:69` `skill_from_arrays` (growth with `growth=True`, `:104-108`).
  - `:150` `batch_hindcast`: starts are offsets after the bundle ignition (`:178-183`); there is no write to bundles.
  - `:221` `summarize_hindcast`: means per spread multiplier only, with no per-fire or per-region aggregation.
  - `:519-613` CLI (`hindcast id:6,12,24 --adjustments 0.5 --ensemble perturbed --json`).
  - Scored leads stop at `data_end_ms`: containment, else the end of growth + 7 d (`spread/ensemble.py:196-209`).
- **Build identity**:
  - `cli.py:75-109` resolves an id or a fuzzy name against the CAL FIRE catalog only (`catalog.py:242-301`, `:317-354`).
  - `build/pipeline.py:466-469` raises "not in the CAL FIRE catalog".
  - `pipeline.py:71-91` requires the id `{year}-{slug}-{calfire_uid[:6]}` (SPEC.md:146-149).
- **Sources a past fire would use**:
  - weather: Open-Meteo historical-forecast `gfs_hrrr` + `gfs_seamless`, with an ERA5 fallback (`sources/weather.py:48-50,
    337-438`);
  - terrain: 3DEP (`sources/terrain.py:31`, national);
  - fuels: LANDFIRE `Landfire_{ED}/{ED}_{LAYER}_CONUS` with ED ∈ {LF2024, LF2025} (`sources/landfire.py:34,55-76`);
  - detections: FIRMS area API by bbox with the key (`sources/firms.py:757-803`, national);
  - perimeters: WFIGS daily perimeters (`sources/perimeters.py:73-80`).
- **The app shows no regional accuracy today.** It shows only a per-run skill table (`web/src/ui/AnalysisTab.tsx:282-320`)
  and the "Experimental… Follow local officials" caveat (`web/src/lib/plainLanguage.ts:62`).

## 2. Gaps

| # | Gap | Kind | Evidence |
|---|---|---|---|
| G1 | Non-CA fires cannot be resolved or built. | BLOCKER | `cli.py:96-109`, `catalog.py:317-354`, `pipeline.py:466-469`; `HISTORICAL_YEAR = 2025` (`catalog.py:39`), and 2024 fires are needed. |
| G2 | Perimeters are filtered to California. | BLOCKER | `perimeters.py:80` `STATE = "US-CA"`, used in `:181,326,538`; matching is by name within 30 km of the "CAL FIRE point". Without perimeters the truth is VIIRS-only (inflated early, docs/validation.md §1). |
| G3 | Only UTM zones 10/11 are used. | BLOCKER (correctness) | `grid.py:59-61` and SPEC.md:119-120. Measured with pyproj for the chosen fires in EPSG:32611: Trout scale 1.008, convergence 4.8°; Windy Deuce 1.023 / 9.0°; Table Rock **1.127 / 21.4°** (area ×1.27). Grid north is treated as true north, so the wind is rotated by the convergence. |
| G4 | 2024 fires get post-fire fuels. | BLOCKER (validity) | Historical builds always use LF2024 (`landfire.py:55-57`, `pipeline.py:568`, SPEC.md:63,494). LF2024 covers disturbances "up through Fiscal Year 2024" (Oct 2023 to Sep 2024; [landfire.gov/data/lf2024](https://www.landfire.gov/data/lf2024)). Measured at 40 interior points (`getSamples`): Horse Gulch FBFM40 differs LF2023→LF2024 at **38/40** (GS2→GS1/GR1, canopy 8 %→3 %); Windy Deuce at **39/40** (GR2→GR1). The rule also holds the other way: Emigrant (Aug 2025) is already burned in LF2025 (39/40 differ, canopy 52 %→38 %), so LF2024 is right for 2025 fires. `Landfire_LF2023/LF2023_{FBFM40,CC,CH,CBH,CBD,EVT,EVC}_CONUS` all exist. |
| G5 | The live fuel moisture is California's month table, with an Oct-1 water-year drought rule. | BLOCKER (validity, SP/SE/SW) | `config.py:163-180`, `moisture.py:109-125`, `ensemble.py:307`, `weather.py:508-513`. Values the code would use (water-year precipitation from ERA5): **Windy Deuce (Feb 27) herb 1.20 / woody 1.20**, so dormant cured grass is treated as fully green. Table Rock (Mar 25): 1.20/1.20. Trout, Greer and France Canyon (May-Jun, the pre-monsoon dry peak): 0.60/1.00, the curing row. PNW/NR/GB in Jul-Sep: 0.30/0.70 (plausible). |
| G6 | The month and the labels use America/Los_Angeles. | INCOMPLETE | `ensemble.py:70,307`, `behavior.py:32,246`, `weather_bundle.py:520-525` (month only, so it matters at month edges); "PST/PDT" labels in `observed.py:89,200-201` and `overpass.py:50,115`. Island Creek (Idaho, north of the Salmon River) is on Pacific time, Greer (AZ) on MST with no DST: the time zone must come from the location, not the state. |
| G7 | The keyless FIRMS fallback is California-only. | INCOMPLETE | `firms.py:632-652,667-716` cut to `CA_BBOX`. Without the key a non-CA fire silently gets zero detections. The validation role must run with the key (it is set in this environment; checked by count only). |
| G8 | Observed and ignition text, and acreage calibration, say "CAL FIRE". | INCOMPLETE | `observed.py:21-25,122,742,785,1326-1373,2113-2118`. The logic only needs `summary.acres/started_ms/lat/lon/contained_ms`, which WFIGS supplies (`IncidentSize`, `FireDiscoveryDateTime`, `ContainmentDateTime`). The issuer text must name the real issuer. |
| G9 | No regional aggregation or data file. | MISSING | There is no per-fire or per-region summary in `validate.py`, `IncidentSummary` has no state or GACC (`contracts.py`), and no accuracy file or endpoint exists. |
| G10 | Bad Open-Meteo bodies are cached for 30 days. | INCOMPLETE | Observed today: after four 429s, historical-forecast answered **HTTP 200 with the text "Unexpected error while streaming data: timeoutReached"**, and `fire3d.http` cached it. `weather.py:371-376` only warns, so HRRR hours fall back to ERA5 on every rebuild for 30 days. (I evicted my own bad entry.) Two of my 19 requests met 429 bursts, and a single retry for Daly 20 min later got 429 five times again (shared cloud egress). Validation builds may silently get ERA5 instead of HRRR. |
| G11 | The AOI is capped at 60 km. | INCOMPLETE | `config.py:120`: Windy Deuce needs about 61 km (slightly clipped, 117 m grid). Falls (OR 2024, 56 km wide) and Smokehouse Creek (150 km) were rejected for this reason. |
| G12 | Single-perimeter fires in the Plains and the Southeast. | INCOMPLETE (data) | WFIGS holds **one** polygon time for Windmill, Crabapple, High Lonesome (TX 2025), Johnson and The 344 (FL 2025). Johnson had **0** NOAA-20 detections in its 5 days. Tested fires in these regions will be the unusually well-mapped ones; the label must say so. |

## 3. Proposed test fires

Evidence columns:
- **perims**: WFIGS daily-perimeter records / distinct polygon times / days.
- **VIIRS**: NOAA-20 SP detections in 5 days after the SPEC 8.3 confidence filter / distinct scan times.
- **HRRR**: complete hours of 120 in the same 5 days, max 10 m wind, min RH.
- **LFM now**: herb/woody live moisture the current code would use.

Exact queries are listed in §8.

| # | Fire, state (GACC) region | Discovery → main growth → containment | Final ac | Fuel (WFIGS / notes) | perims | VIIRS | HRRR | LFM now | AOI |
|---|---|---|---:|---|---|---|---|---|---|
| 1 | Emigrant, OR (NWCC) Northwest timber | 08-24-2025 19:30 → Aug 25-Sep 6 (1.2k→32.3k) → 12-16 | 33,500 | logging slash; LF2024 mostly TL5, canopy 52 % | 46/26/24 | 1,955/16 | 120 h, 19 km/h, 18 % | .30/.70 | 30 km, 59 m |
| 2 | Lower Sugarloaf, WA (NWCC) | 09-01-2025 16:21 → run Sep 17-21 (22.2k→39.2k) → 11-14 | 42,958 | timber, grass understory | 111/26/19 | 1,048/16 | 120 h, 35 km/h, 21 % | .30/.70 | 40 km, 78 m |
| 3 | Island Creek, ID (NRCC) Northern Rockies | 08-01-2025 05:36 → run Aug 19-24 (1.7k→10.7k) → 12-04 | 14,943 | closed timber litter | 53/35/35 | 1,205/16 | 120 h, 18 km/h, 15 % | .30/.70 | 25 km, 49 m |
| 4 | Horse Gulch, MT (NRCC) | 07-09-2024 19:32 → Jul 10-12 (530→11.5k) → 07-27 | 15,167 | timber with grass | 25/23/10 | 280/11 | 120 h, 33 km/h, 12 % | .30/.70 | 19 km, 37 m |
| 5 | France Canyon, UT (GBCC) Great Basin | 06-11-2025 22:05 → Jun 16-27 (2.2k→32.1k) → 07-23 | 34,943 | timber litter | 27/26/23 | 1,034/13 | 120 h, 44 km/h, 8 % | .60/1.0 | 25 km, 49 m |
| 6 | Cottonwood Peak, NV (GBCC) | 08-16-2025 02:02 → Aug 17-23 (22.2k→131.9k) → 09-22 | 132,603 | sagebrush and grass rangeland | 22/17/12 | 1,203/16 | 120 h, 28 km/h, 9 % | .30/.70 | 51 km, 99 m |
| 7 | Trout, NM (SWCC) Southwest | 06-12-2025 13:24 → Jun 13-18 (4.1k→44.6k) → 07-19 | 47,294 | grass and conifer (Gila) | 42/18/12 | 1,097/12 | 120 h, 40 km/h, 5 % | .60/1.0 | 33 km, 64 m |
| 8 | Greer, AZ (SWCC) | 05-13-2025 17:47 → May 13-18 (6.4k→20.8k) → 05-27 | 20,308 | grass and pine, WUI | 18/12/7 | 611/12 | 120 h, **63 km/h (gust 108)**, 7 % | .60/1.0 | 21 km, 40 m |
| 9 | Windy Deuce, TX (SACC) Southern Plains | 02-27-2024 00:23 → Feb 26-28 (93.6k→142.3k) → 03-17 | 143,302 | short grass | 17/12/8 | 309/8 | 120 h, 62 km/h, 11 % | **1.2/1.2** | 60 km cap, 117 m |
| 10 | Table Rock, SC (SACC) Southeast | 03-22-2025 13:26 → Mar 25-Apr 2 (1.1k→13.8k) → none listed | 13,845 | hardwood litter and pine | 23/22/10 | 375/9 | 120 h, 22 km/h, 16 % | **1.2/1.2** | 27 km, 53 m |
| S1 | Rush, OK (SACC) Southern Plains, 2nd | 10-24-2024 20:17 → Oct 25-27 (5.7k→12.5k) → 11-08 | 12,403 | grass and oak (Wichita Mtns) | 14/5/5 | 416/10 | 120 h, 42 km/h, 22 % | – | 16 km, 31 m |
| S2 | Black Cove, NC (SACC) Southeast, 2nd | 03-19-2025 19:00 → Mar 20-30 (1.1k→3.5k) → none listed | 3,502 | hardwood litter | 27/25/11 | 156/9 | 120 h, 55 km/h, 13 % | – | 12 km, 30 m |

**Why each is a good test, and its difficulties.**

| # | Why it is a good test | Difficulties |
|---|---|---|
| 1 Emigrant | First Cascade timber test; daily perimeters through 9 days of growth in several runs | Long managed tail after Sep 6; smoke may thin VIIRS |
| 2 Lower Sugarloaf | East-Cascades wind run after two quiet weeks (tests the held perimeter) | No perimeter Sep 18-20 (run timed by VIIRS); Labor Mountain 12.6 km south, outside the AOI |
| 3 Island Creek | Closed-timber run after an 18-day smoulder | Pacific time inside Idaho; long record, but its growth ends inside the 45-day cap (`observed.py:94`) |
| 4 Horse Gulch | Classic two-day Montana run; Mountain time | **Needs LF2023 (G4)**; only 11 VIIRS scan times |
| 5 France Canyon | Steady timber growth over 11 days, a perimeter almost daily | Likely burnout operations; G5 |
| 6 Cottonwood Peak | The grass and shrub test, at Great Basin rangeland scale; grew 5× in 4 days | 132k ac gives a coarse 99 m grid |
| 7 Trout | Pre-monsoon Gila run, a perimeter each day | G5 (June moisture too wet); Mountain time with DST |
| 8 Greer | Extreme winds; Arizona MST with no DST | G5; only 7 perimeter days |
| 9 Windy Deuce | One-day plains grass run | **Needs LF2023**; G5 severe (green grass). VIIRS saw 118 detections on Feb 26 UTC, before the listed discovery, so the GOES-timed ignition will be earlier. **Smokehouse Creek** is about 10 km east, inside the AOI: keep its pixels out of the truth. AOI slightly clipped |
| 10 Table Rock | Steep Appalachian terrain, daily perimeters; Eastern time | G5 where fuel models carry live shrubs or grass; Helene blowdown (late Sep 2024) may be missing from LF2024; hardwood canopy and burnout |
| S1 Rush | A second plains test | Only 5 perimeters; needs LF2023 |
| S2 Black Cove | A second Southeast test | Small fire, where the model over-predicts (docs/validation.md §6.6); Helene fuels |

**Reserves** (measured the same way):
- **South Fork**, NM 2024 (SWCC): 25 perimeter times, all on Jun 17-18; 705 VIIRS / 7 scans; needs LF2023.
- **Monroe Canyon**, UT 2025 (GBCC): brush; 38 times; run Jul 26-Aug 3; 1,974 VIIRS / 15 scans; AOI 42 km.
- **Forsyth**, UT 2025 (GBCC): timber and WUI; 21 times; 1k→12k on Jun 21-22; 520 VIIRS / 12 scans.
- **Pioneer**, WA 2024 (NWCC): 51 times; slow for 2 months; 590 VIIRS / 18 scans; needs LF2023.
- **Daly**, MT 2024 (NRCC): Bitterroot timber; 26 times; slow; 124 VIIRS / 17 scans; HRRR not confirmed (G10).

**Rejected:** Smokehouse Creek (1.06M ac, over the 60 km cap); Flat, OR 2025 (2 polygon times); Falls, OR 2024 (clipped
AOI); Windmill, Crabapple, High Lonesome, Johnson and The 344 (1 polygon time each; Johnson 0 VIIRS); Buck, NM 2025
(2 times); Gwen, ID 2024 (5 records); Dragon Bravo, AZ 2025 (a managed fire lasting 2 months).

**Build identity.** None of these resolves today (G1). Proposed id on SPEC 4.4's pattern:
`{UTC year of discovery}-{slug(IncidentName)}-{IrwinID hex[:6]}`. A non-CA fire needs its **IRWIN id** to fetch the
incident record (`WFIGS_Incident_Locations`) and its perimeters (`attr_IrwinID = '{…}'`, which is more robust than name
matching).
- The point below is that record's geometry.
- The model window is discovery − 12 h to containment + 1 d.
- Hindcast starts are pre-registered (UTC). Run them as offsets from the bundle's `ignition.t_ms`.

| # | proposed id | IrwinID | UniqueFireIdentifier | point (lat, lon) | hindcast starts (UTC) |
|---|---|---|---|---|---|
| 1 | 2025-emigrant-241e2b | 241E2B4C-AB2C-42E6-A901-396E1DBC974B | 2025-ORWIF-250322 | 43.4688, −122.2416 | 08-25 19:30, 08-26 19:30, 08-28 19:30 |
| 2 | 2025-lower-sugarloaf-569fb7 | 569FB7BD-BA9B-4706-9D42-F05C7C6AC148 | 2025-WAOWF-000797 | 47.7533, −120.5496 | 09-16 16:00, 09-17 16:00, 09-18 16:00 |
| 3 | 2025-island-creek-ff270c | FF270CFC-CADF-4402-B633-49DB89CB1403 | 2025-IDNCF-000495 | 46.0355, −115.4375 | 08-19 06:00, 08-20 06:00, 08-21 06:00 |
| 4 | 2024-horse-gulch-889237 | 889237AA-38DC-45D4-A8D0-B70D8990F5B7 | 2024-MTHLF-000367 | 46.6887, −111.6961 | ignition + 6, 12, 24 h |
| 5 | 2025-france-canyon-7d16d1 | 7D16D16F-4B11-4E71-A81B-FBCED2AE4C65 | 2025-UTDIF-000223 | 37.5483, −112.3818 | 06-16 22:00, 06-18 22:00, 06-20 22:00 |
| 6 | 2025-cottonwood-peak-a3ba9f | A3BA9F0A-424A-43F3-9DDD-6C37B411CA7C | 2025-NVEKD-010319 | 41.3899, −116.2093 | 08-16 14:00, 08-17 02:00, 08-18 02:00, 08-19 02:00 |
| 7 | 2025-trout-4fd248 | 4FD24826-A2AB-4A78-A290-76A14185F7B5 | 2025-NMGNF-000384 | 32.9794, −108.2327 | 06-13 13:30, 06-14 13:30, 06-15 13:30, 06-17 13:30 |
| 8 | 2025-greer-a746c6 | A746C681-F72F-4D72-942E-116E3629A264 | 2025-AZASF-000213 | 34.0223, −109.4535 | ignition + 6, 12, 24, 72 h |
| 9 | 2024-windy-deuce-b972cf | B972CFFD-155A-421E-B86B-969AF75E1880 | 2024-TXTXS-240324 | 35.6311, −101.8511 | ignition + 6, 12, 24 h |
| 10 | 2025-table-rock-20616f | 20616F64-CA32-4E0F-920D-95FEB034CFBA | 2025-SCSCS-000123 | 35.0367, −82.7106 | 03-25 13:30, 03-26 13:30, 03-27 13:30 |
| S1 | 2024-rush-641e3e | 641E3E69-A4ED-4D7C-B46E-C113EB0C5C48 | 2024-OKWMR-002793 | 34.7426, −98.6054 | ignition + 6, 12, 24 h |
| S2 | 2025-black-cove-95c3c8 | 95C3C8D3-BA4E-435B-A996-D469B449DEF5 | 2025-NCNCS-250019 | 35.2856, −82.2975 | 03-20 19:00, 03-22 19:00, 03-23 19:00 |

Reserve IrwinIDs:
- South Fork: E0B77E6D-BE30-4A7B-9875-0E8F1BDFD8D7
- Monroe Canyon: A60CFA6A-C332-4BDD-802B-6E37DC0BBD3E
- Forsyth: A0E0393C-0265-4AC1-8F6A-10C02C2F5BBA
- Pioneer: 03FE65C0-435C-4116-A78E-AFEFE1ADC9A7
- Daly: BDB7328D-8B59-45E4-93BF-664A9403534C

## 4. Validation protocol (for the wave-2 `validation` role)

1. **Before any score, check each bundle and record the results:**
   - observed final area / WFIGS `IncidentSize` within 0.8-1.25 (California: 1.000-1.014);
   - number of perimeters used;
   - the fire is inside the AOI;
   - `fuels_edition` = LF2023 for 2024 fires, LF2024 for 2025 fires;
   - the correct UTM zone;
   - HRRR hours used, and no ERA5 fill (G10);
   - for Windy Deuce, no Smokehouse Creek pixels in the truth.
2. **Hindcasts at the pre-registered starts**, operational settings (`config.FORECAST_*`), `--adjustments 0.5`:
   - the deterministic member, for comparison with docs/validation.md §5.3;
   - the 31-member perturbed p50 for the label.
   - Leads 12/24/48/72 h before `data_end_ms`.
3. **No tuning to these fires** (RUNBOOK-3 §7). Any change tried must be reported with the California 32-lead result.
4. **Report** per fire, per lead and per region: growth Sørensen, total Sørensen, observed and forecast growth (ac),
   and the median growth ratio. Times in UTC plus local time (IANA zone from the location).
5. **Pseudo-live** (`validate live-start`) where FIRMS and CMR allow. Report it, but keep it out of the label.

## 5. Per-region accuracy label

**Regions.** Use the incident's GACC, the official interagency geographic area, which WFIGS gives as `attr_GACC` /
`GACC` on every record queried here.
- The Southern Area (SACC) runs from Texas grass to Appalachian hardwoods and Florida marsh, so it is split by point
  of origin: **Southern Plains** = SACC ∩ {TX, OK}, **Southeast** = the rest of SACC.
- Region ids: `NWCC` Northwest, `NRCC` Northern Rockies, `GBCC` Great Basin, `SWCC` Southwest, `SACC-SP` Southern
  Plains, `SACC-SE` Southeast, `RMCC` Rocky Mountain, `EACC` Eastern, `ONCC` Northern California, `OSCC` Southern
  California.
- Fallback when a fire has no WFIGS record: point-in-polygon on a simplified copy of the NIFC/NWCG
  `DMP_NationalGACCBoundaries_Public` layer, then a state table.
  - The layer credits NWCG and NIFC but states no licence; verify the terms on its NIFC Open Data item before
    bundling it.
- Why GACCs: computable from data we already fetch; they name what fire agencies themselves use; and they follow
  fuel and weather regimes better than state lines (Idaho and Wyoming are each split).
- **California keeps its two GACCs.** Eaton, Palisades and Madre are all `OSCC` (checked), so Northern California is untested.

**Computation** (validation role, written to the data file):
- Per fire, the mean growth Sørensen of the 31-member p50 over all its scored leads.
- The region value is the **mean of the per-fire means**, so one fire with more starts cannot dominate. Also report
  the min-max range across fires, the per-lead means and the median growth ratio.
- Minimum to show a number: **≥ 2 fires and ≥ 16 scored leads.** In California, per-fire scores differed by about
  0.07 (Madre 0.392 vs Palisades 0.458), so one fire cannot separate the fire from the region.
- Below the minimum the status is `limited` (1 fire) or `untested` (0 fires).

**Wording** (Public; Command adds the numbers in brackets). No words that suggest certainty or an all-clear
(CLAUDE.md safety rules; also not "accurate" or "reliable"):
- *Tested*: "Model check: re-run on {n} past fires in the {region} ({years}), the predicted new spread matched the
  real new spread with a score of {0.41} out of 1 (1 = perfect match, 0 = none). It usually predicted about {2}× too
  much growth" (when the ratio is below 1: "about {half} of the real growth"). "Live forecasts usually do worse than
  these re-runs. Experimental: follow local officials."
  - [growth Sørensen {0.41}, fires {0.33-0.48}, n = {2} fires / {24} leads, +12-72 h, HRRR analysis weather.]
- *Limited*: "Accuracy not yet tested here: only one past fire in the {region} has been checked, too few for a number."
- *Untested*: "Accuracy not yet tested here: the model has not been checked against past fires in the {region}."
- *California south* (OSCC): "Model check: re-run on 3 past fires in Southern California (2025, chaparral and grass):
  score 0.44 out of 1, about 1.9× too much growth." *North* (ONCC): the untested text.
- Below the number, always: "Outside the modeled area is unknown, not low."

**Data file**: `backend/fire3d/data/regional_accuracy.json`, written only by the validation tooling. The backend
serves it, for example `GET /api/accuracy-regions`, plus `accuracy_region` on `IncidentSummary`; the planner fixes this
in CONTRACT §14. The web keeps the wording templates in `web/src/lib/plainLanguage.ts`.

```json
{ "schema_version": 1, "generated_ms": 0, "model": {"engine": "pyretechnics 2026.8.10", "settings": "config.FORECAST_* @ <git sha>"},
  "method": {"metric": "growth_sorensen", "forecast": "p50 of 31 perturbed members", "leads_h": [12, 24, 48, 72],
             "aggregate": "mean_of_fire_means", "min_fires": 2, "min_leads": 16, "weather": "archived HRRR (hindcast)"},
  "assignment": {"by": "WFIGS GACC", "split": {"SACC-SP": ["TX", "OK"]}, "fallback": "GACC polygons, then state"},
  "regions": [ {"id": "NWCC", "name": "Northwest", "status": "tested", "n_fires": 2, "n_leads": 24,
     "growth_sorensen": 0.41, "range": [0.33, 0.48], "by_lead": {"12": 0.3, "24": 0.4, "48": 0.45, "72": 0.47},
     "growth_ratio_median": 2.1, "years": [2025], "caveats": ["timber only"],
     "fires": [{"id": "2025-emigrant-241e2b", "name": "Emigrant", "state": "OR", "n_leads": 12, "growth_sorensen": 0.44}]},
     {"id": "RMCC", "name": "Rocky Mountain", "status": "untested", "n_fires": 0} ] }
```

## 6. Recommended changes

| # | Change | Value | Effort | Risk | Files | Pri |
|---|---|---|---|---|---|---|
| R1 | Build a past national fire by IRWIN id (2024+2025): summary from WFIGS incident locations; the id rule above | Unblocks G1 | M | Id collisions with CAL FIRE fires (dedupe in CA) | `catalog.py`, `cli.py`, `build/pipeline.py`, `contracts.py`, SPEC 4.4 | P0 |
| R2 | Perimeters by `attr_IrwinID` (name and state fallback per the fire's own state) | Unblocks G2 | S | Mislinked IRWIN polygons (keep the size check) | `sources/perimeters.py` | P0 |
| R3 | UTM zone from longitude, `326{zone}` | Fixes G3 | S | Web tests only 10/11 (A2 audit) | `grid.py`, SPEC 4.1, web reprojection tests | P0 |
| R4 | `EDITIONS += LF2023`; historical edition = `LF{FY(ignition) − 1}`, clamped to LF2023-LF2025 | Fixes G4 | S | None found: services checked | `sources/landfire.py`, `pipeline.py:568`, SPEC 8.2 | P0 |
| R5 | Live fuel moisture outside CA: NFDRS 2016 GSI method (Jolly et al. 2005) from daily min temperature, VPD and day length (ERA5/HRRR, already fetched); CA keeps its table and drought rule, so its scores stay unchanged | Fixes G5 | M | Parameters must be checked against the NFDRS docs; it is a physics change, not tuning | `spread/moisture.py`, `config.py`, `ensemble.py`, `behavior.py`, `weather_bundle.py`, SPEC 8.4 | P0 |
| R6 | Local month and labels from the fire's IANA zone (one shared helper) | Fixes G6 | S | The helper must cover every lower-48 zone | `ensemble.py`, `behavior.py`, `weather_bundle.py`, `observed.py`, `overpass.py` | P1 |
| R7 | Evict the cache on unparsable Open-Meteo bodies (as `firms.py`/`calfire` do); longer 429 backoff | Fixes G10 | S | – | `sources/weather.py`, maybe `http.py` | P1 |
| R8 | Issuer-neutral observed and ignition text ("NIFC WFIGS (IRWIN) incident record") | G8 | S | Wording only | `build/observed.py` | P1 |
| R9 | `validate regional`: per-fire and per-region aggregation, JSON writer, tests; starts given as UTC | G9 | M | – | `spread/validate.py`, `tests/test_validate*.py`, `fire3d/data/regional_accuracy.json` | P0 |
| R10 | `accuracy_region` on summaries, endpoint, label UI (Public and Command) | Brief decision 3 | M | Wording review | `contracts.py`, `api/app.py`, `web/src/api/types.ts`, UI | P1 |
| R11 | Keyless FIRMS: a national bbox, or a clear "key needed outside California" warning | G7 | S | Size of the yearly archive | `sources/firms.py` | P2 |
| R12 | Later: a reference forecast (for example, uniform growth at the observed mean rate), so the score has a baseline | Meaning of the number | M | – | `spread/validate.py` | P2 |

## 7. Questions only the user can answer

1. **10 or 12 fires?**
   - With 10, the Southern Plains and the Southeast each have one fire, so they would read "accuracy not yet tested
     here (only one past fire checked)".
   - With 12 (add Rush and Black Cove), all six regions can show a number. Recommended: 12.
2. **Rocky Mountain (CO, WY, SD, NE, KS), Eastern (20 states) and Northern California fall outside the brief's six
   regions.** Label them "accuracy not yet tested here", or add a Colorado fire (for example Lee, 2025, 36
   perimeter times) and a Northern California timber fire?
3. Should Public show the number (0.41 out of 1), or only "tested on N fires" with the number in Command?

## 8. Evidence log (2026-10-22, 21:05-21:35 UTC)

- **WFIGS** `services3.arcgis.com/T4QMspbfLg3qTGWY/…/WFIGS_Daily_Perimeters_Public/FeatureServer/0/query`:
  - lists: `outStatistics` (count, max `poly_GISAcres`, min `attr_FireDiscoveryDateTime`) grouped by
    `attr_IrwinID,poly_IncidentName,attr_POOState`, filtered by year, `attr_IncidentTypeCategory='WF'`, state or GACC;
  - per fire: `attr_IrwinID='{…}' OR poly_IRWINID='{…}'`, with time = `poly_PolygonDateTime` → `DateCurrent` →
    `CreateDate` (distinct minutes); extents with `returnExtentOnly`;
  - incident records: `WFIGS_Incident_Locations/FeatureServer/0` `IrwinID IN (…)` (17 of 17 found).
- **FIRMS**: `fire3d.sources.firms.fetch_area("VIIRS_NOAA20_SP", perimeter bbox ± 0.05°, 5 days)`. Counts only; the key
  is never printed.
- **Open-Meteo**: `historical-forecast-api…/v1/forecast?models=gfs_hrrr,gfs_seamless`, one point for 5 days. HRRR is
  archived from 2018-01-01 and GFS from 2021-03-23 ([docs](https://open-meteo.com/en/docs/historical-forecast-api)).
  ERA5 via `sources.weather.water_year_precip`.
- **LANDFIRE**: `getSamples` at 40 random interior points of the largest perimeter. **pyproj**: `get_factors` in EPSG:32611.
