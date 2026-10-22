# Audit 3 (A4): forecast validation outside California

Role `audit-validation`, 2026-10-22 (revised the same day after an independent review; see "Revision notes").
Read-only for the project: no bundle builds, no servers. All times are UTC unless a time zone is named. Data checks
were small, polite requests, mostly through `fire3d.http`, which caches:
- about 80 NIFC WFIGS queries;
- 22 FIRMS requests (one area request per fire, plus availability);
- 19 Open-Meteo HRRR requests (one per fire), 10 ERA5 requests and 3 uncached probes;
- about 35 LANDFIRE requests.

Scratch scripts and raw outputs are in the session scratchpad, folder `audit-validation/` (not committed).

## Summary

- **Today no fire outside California can be built** (the build only knows CAL FIRE incidents, G1). **Four more
  blockers would make the scores wrong even after that is fixed:**
  - perimeters are filtered to `US-CA`;
  - the UTM zone is always 10 or 11;
  - fires that started in federal fiscal year 2024 (Oct 2023 to Sep 2024) get fuels that already contain their own
    burn scar; a failed fuels download can also fall forward to a newer edition;
  - the live fuel moisture table is California's, so it makes February Texas grass and March Appalachian fuels "green".
- **The biggest schedule risk is weather, not code.** Open-Meteo, the only HRRR-history source, applies a **daily**
  cap of 10,000 calls per IP, and this shared cloud egress has hit it today ("Daily API request limit exceeded").
  Backoff cannot beat it, and the ERA5 fallback uses the same provider (G10, R7 is now P0).
- **California baseline:** Madre is not in this session (only Eaton and Palisades were rebuilt). The validation role
  must rebuild it and re-measure the California numbers before any comparison (G14, R14).
- **Test set: 12 fires, two per region** (user decision, round 2, item 3): the 10 first-choice fires plus Rush (OK)
  and Black Cove (NC). Every fire has 5 to 35 dated perimeters, 156 to 1,955 good VIIRS NOAA-20 detections in its main
  5 days, and had complete archived HRRR weather when checked.
  - **But perimeters are not always inside the growth.** Windy Deuce's first perimeter already holds 65 % of the final
    area, and Rush's 46 %. Their hindcast starts are moved or flagged (§3.1).
- **Accuracy label:** one value per region: the mean over fires of each fire's mean growth Sørensen (the
  docs/validation.md headline metric). Regions are the official interagency coordination areas (GACCs), with the
  Southern Area split into Southern Plains (TX, OK) and Southeast. A score needs at least 2 fires and 16 scored leads.
  Public shows words ("Tested on 2 past fires in this region"), with the score one tap away; Command shows the score
  (user decision, round 2, item 7). Untested: "Accuracy not yet tested here".

## 1. What exists

- **Validation protocol** (docs/validation.md §2, §5): 3 Southern California fires (Eaton, Madre, Palisades, all 2025).
  - 8 starts (ignition + 6/12/24 h; Madre + 24/48 h) and leads of 12/24/48/72 h give 32 scored leads.
  - Truth is the observed reconstruction (`build/observed.py`; VIIRS/MODIS/Landsat + NIFC perimeters + GOES timing).
  - Headline: mean **growth** Sørensen 0.432 for the deterministic member, 0.438 for the 31-member p50 (a mean over
    all 32 leads), with a median growth ratio of 1.85×. Per fire (p50): Eaton 0.438, Madre 0.395, Palisades 0.467.
    Total-area Sørensen is reported but inflated (§2).
  - **These are in-sample scores.** The 0.5 multiplier and the 12 h decay were fitted on these same fires ("fitted to
    only three fires and eight starts", docs/validation.md §3.3).
  - Pseudo-live check: 0.234 growth Sørensen (§6.2).
- **Code**:
  - `spread/validate.py:47` `sorensen`; `:69` `skill_from_arrays` (growth with `growth=True`, `:104-108`).
  - `:150` `batch_hindcast`: starts are offsets after the bundle ignition (`:178-183`); there is no write to bundles.
  - `:221` `summarize_hindcast`: means per spread multiplier only, with no per-fire or per-region aggregation.
  - `:519-613` CLI (`hindcast id:6,12,24 --adjustments 0.5 --ensemble perturbed --json`).
  - Scored leads stop at `data_end_ms`: containment, else the end of growth + 7 d (`spread/ensemble.py:198`).
- **Build identity**:
  - `cli.py:75-109` resolves an id or a fuzzy name against the CAL FIRE catalog only (`catalog.py:242-301`, `:317-354`).
  - `build/pipeline.py:466-469` raises "not in the CAL FIRE catalog".
  - `pipeline.py:71-91` requires the id `{year}-{slug}-{calfire_uid[:6]}` (SPEC.md:146-149).
- **Sources a past fire would use**:
  - weather: Open-Meteo historical-forecast `gfs_hrrr` + `gfs_seamless` on a 4 × 4 point grid, with an ERA5
    fallback (`sources/weather.py:48-50, 337-438`); water-year precipitation from ERA5 (`:525-560`);
  - terrain: 3DEP (`sources/terrain.py:31`, national);
  - fuels: LANDFIRE `Landfire_{ED}/{ED}_{LAYER}_CONUS` with ED ∈ {LF2024, LF2025} (`sources/landfire.py:34,55-57`);
  - detections: FIRMS area API by bbox with the key (`sources/firms.py:757-803`, national);
  - perimeters: WFIGS daily perimeters (`sources/perimeters.py:73-80`).
- **The app shows no regional accuracy today.** It shows only a per-run skill table of *total* Sørensen, green
  ("ok") at 0.7 or more (`web/src/ui/AnalysisTab.tsx:282-320`; `SkillEntry` has no growth field, `contracts.py:336`),
  and the "Experimental… Follow local officials" caveat (`web/src/lib/plainLanguage.ts:62`).

## 2. Gaps

| # | Gap | Kind | Evidence |
|---|---|---|---|
| G1 | Non-CA fires cannot be resolved or built. | BLOCKER | `cli.py:96-109`, `catalog.py:317-354`, `pipeline.py:466-469`: the only record source is CAL FIRE. The year is **not** the blocker: `get_summary` already parses the id's year and looks up `year_records(year)` for years other than `HISTORICAL_YEAR` (`catalog.py:332-342`), so 2024 CA ids resolve. |
| G2 | Perimeters are filtered to California. | BLOCKER | `perimeters.py:80` `STATE = "US-CA"`, used in `:181,326,538`; matching is by name within 30 km of the "CAL FIRE point". Without perimeters the truth is VIIRS-only (inflated early, docs/validation.md §1). |
| G3 | Only UTM zones 10/11 are used. | BLOCKER (correctness) | `grid.py:59-61` and SPEC.md:119-120. Measured with pyproj in EPSG:32611: Trout scale 1.008, convergence 4.8°; Windy Deuce 1.023 / 9.0°; Table Rock **1.127 / 21.4°** (area ×1.27). Grid north is treated as true north, so the wind is rotated by the convergence. The standard zone `floor((lon+180)/6)+1` **leaves California unchanged**: it gives 10 below −120° and 11 from −120° to −114.13°, exactly `grid.py:61` (checked on the bundles: Eaton, Palisades, fixture-demo zone 11; fixture-live zone 10). Lower-48 zones are 10-19; the Norway/Svalbard exceptions do not apply. |
| G4 | Fires of federal FY2024 get post-fire fuels; a failed fetch can fall forward. | BLOCKER (validity) | Historical builds always use LF2024 (`landfire.py:55-57`, called with the mode only at `aoi.py:356`; written at `aoi.py:329`; default at `pipeline.py:568`; SPEC.md:63,494). LF2024 covers disturbances "up through Fiscal Year 2024" (Oct 2023 to Sep 2024; [landfire.gov/data/lf2024](https://www.landfire.gov/data/lf2024)). At 40 interior points: Horse Gulch (Jul 2024) FBFM40 differs LF2023→LF2024 at **38/40** (GS2→GS1/GR1, canopy 8 %→3 %); Windy Deuce (Feb 2024) at **39/40** (GR2→GR1). Emigrant (Aug 2025) is already burned in LF2025 (39/40, canopy 52 %→38 %), so LF2024 is right for FY2025 fires. **Rush (Oct 24 2024) is FY2025, so LF2024 is right**: LF2023→LF2024 differs at 16/40 there, but towards *more* grass load (GR1→GR2), not a burn signature. If the chosen edition fails, `aoi.py:285` tries `LF2025` for anything but LF2025, so a historical build silently gets a newer (post-fire) edition. `Landfire_LF2023/LF2023_{FBFM40,CC,CH,CBH,CBD,EVT,EVC}_CONUS` all exist. |
| G5 | The live fuel moisture is California's month table, with an Oct-1 water-year drought rule. | BLOCKER (validity, SP/SE/SW) | `config.py:163-180`, `moisture.py:109-125`, `ensemble.py:307-315`, `weather.py:508-513`. Values the code would use (water-year precipitation from ERA5): **Windy Deuce (Feb 27) herb 1.20 / woody 1.20**, so dormant cured grass is treated as fully green. Table Rock (Mar 25): 1.20/1.20. Trout, Greer and France Canyon (May-Jun, the pre-monsoon dry peak): 0.60/1.00, the curing row. PNW/NR/GB in Jul-Sep: 0.30/0.70 (plausible). |
| G6 | The month and the labels use America/Los_Angeles. | INCOMPLETE | `ensemble.py:70,307`, `behavior.py:32,246`, `weather_bundle.py:520-525` (month only, so it matters at month edges); "PST/PDT" labels in `observed.py:89,200-201` and `overpass.py:50,115`. Island Creek (Idaho, north of the Salmon River) is on Pacific time, Greer (AZ) on MST with no DST: the zone must come from the location, not the state. |
| G7 | The keyless FIRMS fallback is California-only. | INCOMPLETE | `firms.py:632-652,667-716` cut to `CA_BBOX`. Without the key a non-CA fire silently gets zero detections. The validation role must run with the key (it is set in this environment; checked by count only). |
| G8 | Observed and ignition text, and acreage calibration, say "CAL FIRE". | INCOMPLETE | `observed.py:21-25,122,742,785,1326-1373,2113-2118`. The logic only needs `summary.acres/started_ms/lat/lon/contained_ms`, which WFIGS supplies (`IncidentSize`, `FireDiscoveryDateTime`, `ContainmentDateTime`). The issuer text must name the real issuer. |
| G9 | No regional aggregation or data file. | MISSING | There is no per-fire or per-region summary in `validate.py`, `IncidentSummary` has no state or GACC (`contracts.py`), and no accuracy file or endpoint exists. |
| G10 | Open-Meteo: a **daily** quota on a shared IP, and bad bodies are cached. | **BLOCKER (validation schedule)** | Free terms: "Less than 10'000 API calls per day, 5'000 per hour and 600 per minute", applied "by IP addresses and application"; requests over 10 variables or 2 weeks count as several calls ([open-meteo.com/en/terms](https://open-meteo.com/en/terms), [/en/pricing](https://open-meteo.com/en/pricing)). Seen today: (1) at 21:50 the reviewer's HRRR request got **HTTP 429 `{"reason":"Daily API request limit exceeded. Please try again tomorrow.","error":true}`**; (2) at 22:02-22:03 `historical-forecast-api.open-meteo.com` did not connect (timeout, then `SSL_ERROR_SYSCALL`) while `api.open-meteo.com` answered 200; (3) earlier, after four 429s, an **HTTP 200 body "Unexpected error while streaming data: timeoutReached"**, which `fire3d.http` cached for 30 days (`weather.py:371-376` only warns; I evicted my entry). `fire3d.http` retries every 429 four times within about 25 s (`http.py:325-348`), which is useless against a daily cap. Outcomes for a build: if both HRRR and ERA5 are refused, it fails (`weather.py:424`, good); if only HRRR is refused, it silently gets ERA5 hours (`:395-421`); if the water-year request is refused, the drought rule is skipped (`:545-548`). Our own use is small (a 4 × 4 point grid over at most 45 days, `weather_bundle.py:258`: up to about 100 call units per build if each point counts as a call), so the cap is set by other tenants of this egress. |
| G11 | The AOI is capped at 60 km. | INCOMPLETE | `config.py:120`: Windy Deuce needs about 61 km (slightly clipped, 117 m grid). Falls (OR 2024, 56 km wide) and Smokehouse Creek (150 km) were rejected for this reason. |
| G12 | Single-perimeter fires in the Plains and the Southeast. | INCOMPLETE (data) | WFIGS holds **one** polygon time for Windmill, Crabapple, High Lonesome (TX 2025), Johnson and The 344 (FL 2025); Grape Vine Creek (TX 2024) has 4 records. Johnson had **0** NOAA-20 detections in its 5 days. Tested fires in these regions are the unusually well-mapped ones, and even they are thin (§3.1); the label must say so. |
| G13 | LF2025 is NoData in most of the South and East. | BLOCKER for FY2026 fires and live builds (shared with audit A1, B6) | LF2025 is released by GeoArea: SW in April, NW in June, "Full CONUS extent (SC, SE, NC, NE)" in November 2026 ([landfire.gov/data/lf2025](https://landfire.gov/data/lf2025)). Exports today: all NoData at Rush OK, Table Rock SC and Windy Deuce TX; valid at Emigrant OR, Trout NM, Island Creek ID, Horse Gulch MT, and Eaton and Redding CA. `getSamples` on LF2025 also answers HTTP 200 with an error body. None of the 12 test fires needs LF2025. |
| G14 | No California baseline in this session. | BLOCKER (stage D) | `data/incidents/` holds Eaton, Palisades and the fixtures; Madre (`2025-madre-fire-01e7e8`) is missing. RUNBOOK-3 §7 ("unless it improves the California results too") and this protocol need all 3 fires. The rebuilt Eaton and Palisades used full HRRR (manifest source `open-meteo:historical-forecast:gfs_hrrr`, no ERA5), but the docs/validation.md numbers came from the user's local bundles, so they must be re-measured here. |
| G15 | The per-run skill table will contradict a regional label. | INCOMPLETE (UI) | `AnalysisTab.tsx:282-283` colours *total* Sørensen green at ≥ 0.7. Next to a regional *growth* score of about 0.4 a reader sees "green 0.80" and "0.4" for the same model. |

## 3. Test fires (12, user decision round 2)

Evidence columns:
- **perims**: WFIGS daily-perimeter records / distinct polygon times / days.
- **VIIRS**: NOAA-20 SP detections in 5 days after the SPEC 8.3 confidence filter / distinct scan times.
- **HRRR**: complete hours of 120 in the same 5 days, max 10 m wind, min RH (checked 21:24-21:36).
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
| 11 | Rush, OK (SACC) Southern Plains | 10-24-2024 20:17 → Oct 25-27 (5.7k→12.5k) → 11-08 | 12,403 | grass and oak (Wichita Mtns) | 14/5/5 | 416/10 | 120 h, 42 km/h, 22 % | – | 16 km, 31 m |
| 12 | Black Cove, NC (SACC) Southeast | 03-19-2025 19:00 → Mar 20-30 (1.1k→3.5k) → none listed | 3,502 | hardwood litter | 27/25/11 | 156/9 | 120 h, 55 km/h, 13 % | – | 12 km, 30 m |

### 3.1 Perimeter timing inside the growth

Per distinct polygon time (largest polygon at that minute, the running maximum as "burned so far"):

| # | Fire | times up to 90 % of final | first perimeter: time (share of final) | burned at the first start | perimeter times in 72 h after the first start |
|---|---|---:|---|---:|---:|
| 1 | Emigrant | 8 | 08-25 16:04 (4 %) | 4 % | 2 |
| 2 | Lower Sugarloaf | 20 | 09-03 06:09 (2 %) | 43 % | 1, then none until 09-21 17:48 |
| 3 | Island Creek | 17 | 08-01 16:19 (0.5 %) | 8 % | 3 |
| 4 | Horse Gulch | 14 | 07-10 19:49 (4 %) | 0 % | 6 |
| 5 | France Canyon | 17 | 06-13 00:22 (6 %) | 6 % | 3 |
| 6 | Cottonwood Peak | 10 | 08-17 05:29 (17 %) | 0 % | 4 |
| 7 | Trout | 12 | 06-12 23:38 (0.1 %) | 2 % | 8 |
| 8 | Greer | 10 | 05-14 01:41 (8 %) | 0 % | 7 |
| 9 | Windy Deuce | **2** | 02-27 06:23 (**65 %**) | 65 % (old starts) | 1 during growth |
| 10 | Table Rock | 16 | 03-24 02:36 (2 %) | 8 % | 6 |
| 11 | Rush | **3** | 10-25 12:09 (**46 %**) | 0 % | 3 |
| 12 | Black Cove | 10 | 03-20 20:36 (31 %) | 0 % | 3 |

- **Windy Deuce:** 93,622 of 144,207 ac are already in the first polygon, about 6 h after the listed discovery. Only
  one later time (02-28 21:42, 142,308 ac) falls during growth; the other 10 come after growth stopped. Starts at
  ignition + 6/12/24 h would all begin with 65 % burned and score only the second day, timed by 8 VIIRS scans.
  - **Decision:** keep it (there is no better-mapped Southern Plains fire: G12), but move its starts to the first
    perimeter: **02-27 06:30, 12:30 and 18:30**. Describe it honestly as a test of the second day of a plains grass
    fire; the first-night run is not scorable against perimeters.
- **Rush:** the +6 and +12 h starts begin before the first perimeter, so their 12 h truth is VIIRS-timed. Keep them and
  report them, as California did for its first night.
- **Lower Sugarloaf:** no perimeter between 09-17 16:00 and 09-21 17:48, so the truth at every scored lead of its run
  starts is VIIRS-timed. Keep it and flag it in the per-fire report.

**Why each is a good test, and its difficulties.**

| # | Why it is a good test | Difficulties |
|---|---|---|
| 1 Emigrant | First Cascade timber test; daily perimeters through 9 days of growth in several runs | Long managed tail after Sep 6; smoke may thin VIIRS |
| 2 Lower Sugarloaf | East-Cascades wind run after two quiet weeks (tests the held perimeter) | Run timed by VIIRS only (§3.1); Labor Mountain 12.6 km south, outside the AOI |
| 3 Island Creek | Closed-timber run after an 18-day smoulder | Pacific time inside Idaho; growth ends inside the 45-day cap (`observed.py:94`); one final polygon is re-dated to 2026 |
| 4 Horse Gulch | Classic two-day Montana run; Mountain time | **Needs LF2023 (G4)**; only 11 VIIRS scan times |
| 5 France Canyon | Steady timber growth over 11 days, a perimeter almost daily | Likely burnout operations; G5 |
| 6 Cottonwood Peak | The grass and shrub test, at Great Basin rangeland scale; grew 5× in 4 days | 132k ac gives a coarse 99 m grid |
| 7 Trout | Pre-monsoon Gila run, a perimeter each day | G5 (June moisture too wet); Mountain time with DST |
| 8 Greer | Extreme winds; Arizona MST with no DST | G5; only 7 perimeter days |
| 9 Windy Deuce | Plains grass, wind-driven | **Needs LF2023**; G5 severe (green grass); first perimeter already 65 % (§3.1). VIIRS saw 118 detections on Feb 26 UTC, before the listed discovery. **Smokehouse Creek** is 9.9 km from its final perimeter (no overlap); only about 1,400 ac of it lies in a 60 km box around Windy Deuce. The 1.5 km clustering cannot join them, and with a complete perimeter the truth is clipped to Windy Deuce's own WFIGS perimeter (`observed.py:769-772`, snapshots `∩ F` at `:916`; late detections are added outside it only for live builds, `:1989`). The check in §4 stays. AOI slightly clipped |
| 10 Table Rock | Steep Appalachian terrain, daily perimeters; Eastern time | G5 where fuel models carry live shrubs or grass; Helene blowdown (late Sep 2024) may be missing from LF2024; hardwood canopy and burnout |
| 11 Rush | A second plains test, grass and oak | Only 5 perimeter times (3 in growth); first perimeter 46 %; LF2024 (FY2025 fire) |
| 12 Black Cove | A second Southeast test | Small fire, where the model over-predicts (docs/validation.md §6.6); Helene fuels |

**Reserves** (measured the same way; none is in the Southern Plains):
- **South Fork**, NM 2024 (SWCC): 25 perimeter times, all on Jun 17-18; 705 VIIRS / 7 scans; needs LF2023.
- **Monroe Canyon**, UT 2025 (GBCC): brush; 38 times; run Jul 26-Aug 3; 1,974 VIIRS / 15 scans; AOI 42 km.
- **Forsyth**, UT 2025 (GBCC): timber and WUI; 21 times; 1k→12k on Jun 21-22; 520 VIIRS / 12 scans.
- **Pioneer**, WA 2024 (NWCC): 51 times; slow for 2 months; 590 VIIRS / 18 scans; needs LF2023.
- **Daly**, MT 2024 (NRCC): Bitterroot timber; 26 times; slow; 124 VIIRS / 17 scans; HRRR not confirmed (G10).

**Rejected:** Smokehouse Creek (1.06M ac, over the 60 km cap); Flat, OR 2025 (2 polygon times); Falls, OR 2024 (clipped
AOI); Windmill, Crabapple, High Lonesome, Johnson and The 344 (1 polygon time each; Johnson 0 VIIRS); Grape Vine
Creek, TX 2024 (4 records); Buck, NM 2025 (2 times); Gwen, ID 2024 (5 records); Dragon Bravo, AZ 2025 (a managed fire
lasting 2 months).

**Build identity.** None of these resolves today (G1). Proposed id on SPEC 4.4's pattern:
`{UTC year of discovery}-{slug(IncidentName)}-{IrwinID hex[:6]}`. A non-CA fire needs its **IRWIN id** to fetch the
incident record (`WFIGS_Incident_Locations`) and its perimeters (`attr_IrwinID = '{…}'`, which is more robust than name
matching).
- The point below is that record's geometry.
- The model window is discovery − 12 h to containment + 1 d.
- Hindcast starts are pre-registered (UTC), chosen from the WFIGS perimeter series before any model run. Run them as
  offsets from the bundle's `ignition.t_ms`.
- **fuels** is the expected edition by the rule LF{federal FY of ignition − 1}; **UTM** is `floor((lon+180)/6)+1`.

| # | proposed id | IrwinID | UniqueFireIdentifier | point (lat, lon) | fuels | UTM | hindcast starts (UTC) |
|---|---|---|---|---|---|---|---|
| 1 | 2025-emigrant-241e2b | 241E2B4C-AB2C-42E6-A901-396E1DBC974B | 2025-ORWIF-250322 | 43.4688, −122.2416 | LF2024 | 10 | 08-25 19:30, 08-26 19:30, 08-28 19:30 |
| 2 | 2025-lower-sugarloaf-569fb7 | 569FB7BD-BA9B-4706-9D42-F05C7C6AC148 | 2025-WAOWF-000797 | 47.7533, −120.5496 | LF2024 | 10 | 09-16 16:00, 09-17 16:00, 09-18 16:00 |
| 3 | 2025-island-creek-ff270c | FF270CFC-CADF-4402-B633-49DB89CB1403 | 2025-IDNCF-000495 | 46.0355, −115.4375 | LF2024 | 11 | 08-19 06:00, 08-20 06:00, 08-21 06:00 |
| 4 | 2024-horse-gulch-889237 | 889237AA-38DC-45D4-A8D0-B70D8990F5B7 | 2024-MTHLF-000367 | 46.6887, −111.6961 | LF2023 | 12 | ignition + 6, 12, 24 h |
| 5 | 2025-france-canyon-7d16d1 | 7D16D16F-4B11-4E71-A81B-FBCED2AE4C65 | 2025-UTDIF-000223 | 37.5483, −112.3818 | LF2024 | 12 | 06-16 22:00, 06-18 22:00, 06-20 22:00 |
| 6 | 2025-cottonwood-peak-a3ba9f | A3BA9F0A-424A-43F3-9DDD-6C37B411CA7C | 2025-NVEKD-010319 | 41.3899, −116.2093 | LF2024 | 11 | 08-16 14:00, 08-17 02:00, 08-18 02:00, 08-19 02:00 |
| 7 | 2025-trout-4fd248 | 4FD24826-A2AB-4A78-A290-76A14185F7B5 | 2025-NMGNF-000384 | 32.9794, −108.2327 | LF2024 | 12 | 06-13 13:30, 06-14 13:30, 06-15 13:30, 06-17 13:30 |
| 8 | 2025-greer-a746c6 | A746C681-F72F-4D72-942E-116E3629A264 | 2025-AZASF-000213 | 34.0223, −109.4535 | LF2024 | 12 | ignition + 6, 12, 24, 72 h |
| 9 | 2024-windy-deuce-b972cf | B972CFFD-155A-421E-B86B-969AF75E1880 | 2024-TXTXS-240324 | 35.6311, −101.8511 | LF2023 | 14 | **02-27 06:30, 02-27 12:30, 02-27 18:30** (revised, §3.1) |
| 10 | 2025-table-rock-20616f | 20616F64-CA32-4E0F-920D-95FEB034CFBA | 2025-SCSCS-000123 | 35.0367, −82.7106 | LF2024 | 17 | 03-25 13:30, 03-26 13:30, 03-27 13:30 |
| 11 | 2024-rush-641e3e | 641E3E69-A4ED-4D7C-B46E-C113EB0C5C48 | 2024-OKWMR-002793 | 34.7426, −98.6054 | **LF2024** | 14 | ignition + 6, 12, 24 h |
| 12 | 2025-black-cove-95c3c8 | 95C3C8D3-BA4E-435B-A996-D469B449DEF5 | 2025-NCNCS-250019 | 35.2856, −82.2975 | LF2024 | 17 | 03-20 19:00, 03-22 19:00, 03-23 19:00 |

Reserve IrwinIDs:
- South Fork: E0B77E6D-BE30-4A7B-9875-0E8F1BDFD8D7
- Monroe Canyon: A60CFA6A-C332-4BDD-802B-6E37DC0BBD3E
- Forsyth: A0E0393C-0265-4AC1-8F6A-10C02C2F5BBA
- Pioneer: 03FE65C0-435C-4116-A78E-AFEFE1ADC9A7
- Daly: BDB7328D-8B59-45E4-93BF-664A9403534C

## 4. Validation protocol (for the wave-2 `validation` role)

0. **California baseline first.** Rebuild Madre (`2025-madre-fire-01e7e8`, a CA build that does not count towards
   the 12). Re-run the 31-member p50 hindcasts at the docs/validation.md starts on Eaton, Madre and Palisades with the
   code *before* any brief-3 physics change. Record the per-fire and 32-lead values next to docs/validation.md §5.1
   (Eaton 0.438, Madre 0.395, Palisades 0.467). Explain any difference over 0.02 (for example, a re-dated perimeter)
   before going on. This is the reference for every later comparison.
1. **Weather budget.** Before each build, send one tiny Open-Meteo probe. If it answers with the daily-limit body or
   does not connect, **wait for the quota to reset; do not build** (R7). Build one fire at a time; 13 builds stay
   far below 10,000 call units, but other tenants of this egress share the cap.
2. **Before any score, check each bundle and record the results:**
   - observed final area / WFIGS `IncidentSize` within 0.8-1.25 (California: 1.000-1.014);
   - number of perimeters used, and how many fall in the growth window (§3.1);
   - the fire is inside the AOI;
   - `fuels_edition` = LF{federal FY of ignition − 1} (the **fuels** column in §3), and no "used … instead" fallback note;
   - the UTM zone in the **UTM** column;
   - weather source `open-meteo:historical-forecast:gfs_hrrr` with **zero ERA5 hours**; any ERA5 fill fails the bundle
     (rebuild after the quota resets, after evicting the cache entry);
   - no observed pixel more than 2 km outside the fire's own final WFIGS perimeter (this catches neighbour fires such
     as Smokehouse Creek).
3. **Pre-register R5 before any score.** The live-fuel-moisture method for fires outside California (GSI, R5), its
   parameters and their source are written into docs/validation.md and committed before the first non-CA hindcast.
   After that, only bug fixes, each reported with before/after values for every fire.
4. **Hindcasts at the pre-registered starts** (§3), operational settings (`config.FORECAST_*`), `--adjustments 0.5`:
   - the deterministic member, for comparison with docs/validation.md §5.3;
   - the 31-member perturbed p50 for the label;
   - leads 12/24/48/72 h before `data_end_ms`.
   - **Also score the fixed California rule, ignition + 6/12/24 h, for every fire**, and report it next to the label
     value (not in it). It shows how much the hand-picked, during-the-run starts flatter the score.
   - Ablation, outside the label: the non-CA fires with the current California moisture table, to show what R5 changed.
5. **No tuning to these fires** (RUNBOOK-3 §7). Any other change tried is reported with the California 32-lead result
   from step 0.
6. **Report** per fire, per lead and per region: growth Sørensen, total Sørensen, observed and forecast growth (ac),
   and the median growth ratio. Times in UTC plus local time (IANA zone from the location).
7. **Pseudo-live** (`validate live-start`) where FIRMS and CMR allow. Report it, but keep it out of the label.

## 5. Per-region accuracy label

**Regions.** Use the incident's GACC, the official interagency geographic area, which WFIGS gives as `attr_GACC` /
`GACC` on every record queried here.
- The Southern Area (SACC) runs from Texas grass to Appalachian hardwoods and Florida marsh, so it is split by point
  of origin: **Southern Plains** = SACC ∩ {TX, OK}, **Southeast** = the rest of SACC.
- Region ids: `NWCC` Northwest, `NRCC` Northern Rockies, `GBCC` Great Basin, `SWCC` Southwest, `SACC-SP` Southern
  Plains, `SACC-SE` Southeast, `RMCC` Rocky Mountain, `EACC` Eastern, `ONCC` Northern California, `OSCC` Southern
  California. RMCC, EACC and ONCC say "accuracy not yet tested here" (user default, round 2).
- Why GACCs: computable from data we already fetch; they name what fire agencies themselves use; and they follow
  fuel and weather regimes better than state lines (Idaho and Wyoming are each split).
- **California keeps its two GACCs.** Eaton, Palisades and Madre are all `OSCC` (checked), so Northern California is untested.

**Assignment, decided.**
- A fire takes the GACC of its WFIGS record. A CAL FIRE fire takes it from the WFIGS record it is matched to
  (the CAL FIRE/WFIGS de-duplication of user decision round 2, item 2, audit A1).
- No WFIGS GACC: point-in-polygon on a simplified copy of the NIFC/NWCG `DMP_NationalGACCBoundaries_Public` layer,
  **only if** its terms are verified on its NIFC Open Data item (it credits NWCG and NIFC but states no licence).
  Otherwise, the "untested" wording. Never borrow a score from a neighbouring region; there is no state-table
  fallback, because split states (ID, WY, CA) cannot be resolved from the state.
- The label describes model output. A searched place with no modeled fire gets no accuracy label.

**Computation** (validation role, written to the data file):
- Per fire, the mean growth Sørensen of the 31-member p50 over all its scored leads.
- **One aggregate everywhere:** the region value is the **mean of the per-fire means**, so one fire with more starts
  cannot dominate. For California (OSCC) that is **0.43** (Eaton 0.438, Madre 0.395, Palisades 0.467), not the
  0.438 pooled over 32 leads; the file also stores the pooled value, labelled, for continuity with docs/validation.md.
- Also report the min-max range across fires, the per-lead means, the median growth ratio and the ignition-relative
  value (protocol step 4).
- Minimum for a score: **≥ 2 fires and ≥ 16 scored leads.** In California the per-fire p50 scores span 0.07 (Madre
  0.395 to Palisades 0.467), so one fire cannot separate the fire from the region.
- Below the minimum the status is `limited` (1 fire) or `untested` (0 fires).
- **Precision.** Two-fire values are rough (about ±0.05). Public's detail rounds to one decimal and always shows the
  range; Command shows two decimals with the range and the counts.

**Wording** (no words that suggest certainty or an all-clear, CLAUDE.md; also not "accurate" or "reliable").
Public shows the first line; the score is one tap away. Command shows the score line directly.
- *Tested*: "Tested on {2} past fires in this region ({2024-2025}; {grass} fires)."
  - Detail: "When re-run on these fires, the predicted new spread matched the real new spread with a score of about
    {0.4} out of 1 (1 = perfect, 0 = none; the fires ranged {0.3-0.5}). It usually predicted about {2}× too much
    growth" (below 1: "about {half} of the real growth"). "These re-runs started during the fires' main growth and
    used archived weather, so live forecasts usually do worse. Experimental: follow local officials."
  - Command: "Hindcast growth score {0.41} (fires {0.33-0.48}; {2} fires, {24} leads, +12-72 h; growth ×{2.1};
    starts during main growth; live fuel moisture {GSI}; fuels {LF2023, LF2024})."
- *Fuel caveat*, whenever the tested fires cover only some fuels (for example NWCC and NRCC: timber only, while those
  areas also hold eastern Oregon and Washington rangeland, and eastern Montana and North Dakota grassland): "Tested on
  {timber} fires only; other fuels here are untested."
- *Limited*: "Tested on only 1 past fire in this region: too few for a score." Command adds "[that fire {0.38},
  {12} leads; not a regional score]".
- *Untested*: "Accuracy not yet tested here." Command adds "No past fires in the {region} have been re-run."
- *Southern California* (OSCC): "Tested on 3 past fires in Southern California (2025; chaparral and grass). The
  model's settings were tuned on these same fires, so this is a best case." Command: "Hindcast growth score 0.43
  (fires 0.40-0.47; 3 fires, 32 leads; growth ×1.85; in-sample: settings fitted on these fires)." *North* (ONCC): the
  untested text.
- Below the label, always: "Outside the modeled area is unknown, not low."

**The per-run skill table** (G15, R13): show growth Sørensen as the main number, label total Sørensen "total-area
overlap (includes the area already burned at the start)", and drop the green/amber/red tone on it.

**Data file**: `backend/fire3d/data/regional_accuracy.json`, written only by the validation tooling. The backend
serves it, for example `GET /api/accuracy-regions`, plus `accuracy_region` on `IncidentSummary`; the planner fixes this
in CONTRACT §14. The web keeps the wording templates in `web/src/lib/plainLanguage.ts`.

```json
{ "schema_version": 1, "generated_ms": 0, "model": {"engine": "pyretechnics 2026.8.10", "settings": "config.FORECAST_* @ <git sha>"},
  "method": {"metric": "growth_sorensen", "forecast": "p50 of 31 perturbed members", "leads_h": [12, 24, 48, 72],
             "aggregate": "mean_of_fire_means", "min_fires": 2, "min_leads": 16, "weather": "archived HRRR (hindcast), no ERA5 fill",
             "starts": "pre-registered, during main growth", "secondary": "ignition + 6/12/24 h"},
  "assignment": {"by": "WFIGS GACC", "split": {"SACC-SP": ["TX", "OK"]}, "fallback": "GACC polygons if terms verified, else untested"},
  "regions": [ {"id": "NWCC", "name": "Northwest", "status": "tested", "in_sample": false, "n_fires": 2, "n_leads": 24,
     "growth_sorensen": 0.41, "range": [0.33, 0.48], "pooled_leads": 0.42, "ignition_relative": 0.30,
     "by_lead": {"12": 0.3, "24": 0.4, "48": 0.45, "72": 0.47}, "growth_ratio_median": 2.1, "years": [2025],
     "lfm_method": "gsi_nfdrs2016", "fuels_editions": ["LF2024"], "fuel_groups_tested": ["timber"],
     "caveats": ["timber only", "run timed by VIIRS only (Lower Sugarloaf)"],
     "fires": [{"id": "2025-emigrant-241e2b", "name": "Emigrant", "state": "OR", "n_leads": 12, "growth_sorensen": 0.44,
                "fuels_edition": "LF2024", "lfm_method": "gsi_nfdrs2016", "era5_hours": 0}]},
     {"id": "OSCC", "name": "Southern California", "status": "tested", "in_sample": true, "lfm_method": "ca_month_table_drought"},
     {"id": "RMCC", "name": "Rocky Mountain", "status": "untested", "n_fires": 0} ] }
```

(The numbers are placeholders except OSCC's inputs.)

## 6. Recommended changes

| # | Change | Value | Effort | Risk | Files | Pri |
|---|---|---|---|---|---|---|
| R1 | Build a past national fire by IRWIN id (2024+2025): summary from WFIGS incident locations; the id rule above | Unblocks G1 | M | Id collisions with CAL FIRE fires (dedupe in CA) | `catalog.py`, `cli.py`, `build/pipeline.py`, `contracts.py`, SPEC 4.4 | P0 |
| R2 | Perimeters by `attr_IrwinID` (name and state fallback per the fire's own state) | Unblocks G2 | S | Mislinked IRWIN polygons (keep the size check) | `sources/perimeters.py` | P0 |
| R3 | UTM zone `floor((lon+180)/6)+1`, EPSG `32600 + zone`. California is unchanged (G3), so its bundles and scores stay valid | Fixes G3 | S | Web tests cover only 10/11 (A2 audit); the web reprojects any zone (`reproject.ts:32`, lon0 = 6·zone − 183) | `grid.py`, SPEC 4.1, web reprojection tests | P0 |
| R4 | `EDITIONS += LF2023`; `edition_for(mode, started_ms)`: historical = LF{federal FY(ignition) − 1}, live = LF2025. Never fall *forward* for a historical fire: on failure, or where the edition is NoData (G13), use the next *older* edition with a warning. Refuse a fire before Oct 2023 (it would need LF2022) unless forced, with a warning that its fuels may include its own burn | Fixes G4 | S | **Behaviour change in California:** historical fires of FY2026 (from Oct 2025) move from LF2024 to LF2025, which is the right pre-fire state. Eaton, Palisades and Madre (FY2025) stay on LF2024 | `sources/landfire.py`; caller `build/aoi.py:356` (pass `ctx.summary.started_ms`) and fallback `:285`; default `pipeline.py:568`; tests `test_terrain.py:213-283,438`, `test_pipeline.py:42`, `test_pipeline_support.py:145`; SPEC 8.2 (SPEC.md:63,494) | P0 |
| R5 | Live fuel moisture outside California: the NFDRS 2016 GSI method (Jolly et al. 2005): a 21-day mean of a product of daily minimum temperature, vapour pressure deficit and day length, mapped to herb and woody moisture. California keeps its table and drought rule, so its scores stay unchanged. **Needs new input:** one daily ERA5 request per fire, start − 28 d to start (`temperature_2m_min/max`, `daylight_duration` and VPD or dew point; the VPD API name must be confirmed), about 2 call units; outside California it replaces the water-year request (about 10-26 units). Store the series in the bundle so hindcasts never fetch (as `precip_to(..., fetch=False)` does). Live fires use the forecast API's past days | Fixes G5 | M | A physics change: method and parameters taken from the NFDRS documentation and pre-registered (protocol step 3), not tuned | `spread/moisture.py`, `config.py`, `ensemble.py:307-315`, `behavior.py`, `build/weather_bundle.py`, `sources/weather.py`, SPEC 8.4 | P0 |
| R6 | Local month and labels from the fire's IANA zone (one shared helper) | Fixes G6 | S | Uses audit A1's offline lookup: USDOT BTS NTAD Time Zones ("available for unrestricted public use") plus Census AIANNH for the Navajo/Hopi split, in `fire3d/regions.py`; no new dependency (shapely is present) | `ensemble.py`, `behavior.py`, `weather_bundle.py`, `observed.py`, `overpass.py` (A1 R3/R7) | P1 |
| R7 | Open-Meteo quota handling: recognise the daily-limit 429 body and raise a distinct error with no retries; a historical or validation build then **fails** ("weather quota reached; retry after the reset") instead of filling with ERA5; a `--require-hrrr` build option (on for validation) fails on any ERA5 hour; evict the cache on unparsable or error bodies (as `firms.py` does). Contingency only if the block lasts days: NOAA's HRRR archive on AWS Open Data (GRIB2; needs a new reader and a terms check, effort L) | Fixes G10; makes stage D possible | S | – | `sources/weather.py`, `http.py`, `cli.py` | **P0** |
| R8 | Issuer-neutral observed and ignition text ("NIFC WFIGS (IRWIN) incident record") | G8 | S | Wording only | `build/observed.py` | P1 |
| R9 | `validate regional`: per-fire and per-region aggregation (mean of fire means; pooled and ignition-relative values too), JSON writer, tests; starts given as UTC | G9 | M | – | `spread/validate.py`, `tests/test_validate*.py`, `fire3d/data/regional_accuracy.json` | P0 |
| R10 | `accuracy_region` on summaries, endpoint, label UI (Public words + tap, Command score) | Brief decision 3; round 2 item 7 | M | Wording review | `contracts.py`, `api/app.py`, `web/src/api/types.ts`, UI | P1 |
| R11 | Keyless FIRMS: a national bbox, or a clear "key needed outside California" warning | G7 | S | Size of the yearly archive | `sources/firms.py` | P2 |
| R12 | Later: a reference forecast (for example, uniform growth at the observed mean rate), so the score has a baseline | Meaning of the number | M | – | `spread/validate.py` | P2 |
| R13 | Per-run skill table: add `growth_sorensen` (optional, additive) to `SkillEntry`, show it first, relabel total, drop its colour tone | G15 | S | Contract change (SPEC, `contracts.py`, `types.ts` together) | `contracts.py`, `spread/ensemble.py`, `web/src/ui/AnalysisTab.tsx`, `web/src/api/types.ts` | P1 |
| R14 | Stage D starts with the California baseline: rebuild Madre (one extra CA build) and re-measure all 3 fires (protocol step 0) | G14 | S | 1-3 min and a few dozen Open-Meteo call units | validation role, `docs/validation.md` | P0 |

## 7. Questions for the user

Round 2 answered all three earlier questions: 12 fires (item 3), "accuracy not yet tested here" for Rocky Mountain,
Eastern and Northern California (defaults), and words in Public with the score in Command (item 7). The reviewer's
new questions are technical, and this audit decides them, so nothing needs the user before stage B:
- **Madre:** rebuild it (R14). It is a California regression build, not one of the 12, and California quality is the
  brief's first condition.
- **Windy Deuce or Rush:** both stay, because the user asked for two per region and there is no better Southern Plains
  fire. Windy Deuce's starts move to its first perimeter (§3.1).

One question may come up during stage D, only if the weather quota stays blocked:

1. **Open-Meteo's daily limit blocks the validation weather. What should happen?**
   - **A. Wait for the reset and build then (recommended).** Same weather source as California; it may delay
     "validation done" by up to a day.
   - B. Build with ERA5 reanalysis weather where HRRR is refused, and label those fires. Faster, but they would be
     scored on different weather from California, and ERA5 shares the same quota.
   - C. Drop the affected fires and label their regions "accuracy not yet tested here".
   CLAUDE.md puts quality before speed, so the orchestrator can start with A and tell the user about the delay.

## 8. Evidence log (2026-10-22)

- **WFIGS** `services3.arcgis.com/T4QMspbfLg3qTGWY/…/WFIGS_Daily_Perimeters_Public/FeatureServer/0/query` (21:05-21:35,
  re-read from the cache at 22:00):
  - lists: `outStatistics` (count, max `poly_GISAcres`, min `attr_FireDiscoveryDateTime`) grouped by
    `attr_IrwinID,poly_IncidentName,attr_POOState`, filtered by year, `attr_IncidentTypeCategory='WF'`, state or GACC;
  - per fire: `attr_IrwinID='{…}' OR poly_IRWINID='{…}'`, with time = `poly_PolygonDateTime` → `DateCurrent` →
    `CreateDate` (distinct minutes); extents with `returnExtentOnly`; §3.1 uses the running maximum per time;
  - Windy Deuce vs Smokehouse Creek: the largest polygon of each (`f=geojson`, `maxAllowableOffset=0.001`), measured in
    EPSG:32614: 9.92 km apart, no overlap (22:05);
  - incident records: `WFIGS_Incident_Locations/FeatureServer/0` `IrwinID IN (…)` (17 of 17 found).
- **FIRMS**: `fire3d.sources.firms.fetch_area("VIIRS_NOAA20_SP", perimeter bbox ± 0.05°, 5 days)`. Counts only; the key
  is never printed.
- **Open-Meteo**: `historical-forecast-api…/v1/forecast?models=gfs_hrrr,gfs_seamless`, one point for 5 days. HRRR is
  archived from 2018-01-01 and GFS from 2021-03-23 ([docs](https://open-meteo.com/en/docs/historical-forecast-api)).
  ERA5 via `sources.weather.water_year_precip`. Probes (uncached curl): 22:02 historical-forecast timeout after 30 s,
  22:03 `SSL_ERROR_SYSCALL`; `api.open-meteo.com` forecast HTTP 200 in 0.6 s. The daily-limit body is the reviewer's
  saved 21:50 answer. Terms and pricing pages read at 22:10. Daily ERA5 variables from the historical-weather docs.
- **LANDFIRE**: `getSamples` at 40 random interior points of the largest perimeter. Rush: `exportImage` of FBFM40 over
  the perimeter for LF2023/24/25, sampled at the same 40 points (22:07), because LF2025 `getSamples` now answers with
  an error body (evicted from the cache). LF2025 NoData checks: 16 × 16 exports at nine points (22:08-22:15). Release
  schedule from landfire.gov/data/lf2025.
- **pyproj**: `get_factors` in EPSG:32611. **Bundles**: `manifest.json` `grid.utm_zone`, `fuels_edition` and the weather
  `data_sources` entry of the 4 local bundles.

## Revision notes

Changes after the independent review (each point re-checked; where the reviewer was wrong, the reason is given).
- **Added:** G10 is now a BLOCKER and R7 P0 (daily quota, confirmed on the terms page and in the saved body; the
  historical endpoint also failed to connect at 22:02-22:03). G13 (LF2025 NoData in the South and East, found while
  checking Rush). G14 and R14 (no Madre; re-measure the baseline). G15 and R13 (per-run table). §3.1 (perimeter
  timing; Windy Deuce starts moved; Rush and Lower Sugarloaf flagged). Per-fire fuels edition and UTM zone. Protocol
  steps 0, 1, 3 and the ignition-relative secondary score. In-sample caveat and flag, fuel caveat, method fields
  (`lfm_method`, `fuels_editions`, `fuel_groups_tested`) in the data file. The GACC fallback decision, and no label
  for searched places.
- **Corrected:** Rush gets LF2024, not LF2023 (it is a FY2025 fire; the edition check is by federal fiscal year, not
  calendar year). The OSCC value is 0.43 (mean of fire means), not 0.44. G1's blocker is the CAL FIRE-only record
  source, not `HISTORICAL_YEAR`. R4 names the real caller (`aoi.py:356`), the forward fallback (`aoi.py:285`), the
  tests and the California behaviour change. R5 states the new daily request and its cost. R6 names its time-zone
  source. The per-fire California spread now cites the p50 values (0.395-0.467). `ensemble.py:198`.
- **Reviewer not followed:** Smokehouse Creek needs no code change and Windy Deuce need not be demoted. The fires are
  9.9 km apart (beyond the 1.5 km clustering), and for a historical build with a complete perimeter the truth is
  clipped to the fire's own WFIGS perimeter; detections outside it are added only for live builds. The bundle check
  stays. The R5 extra request costs about 2 call units and replaces a larger one outside California, so it is not a
  quota problem.
- **User questions:** replaced. Round 2 answered the old three. The reviewer's Madre and Windy Deuce questions are
  technical and decided here. One conditional question remains (weather quota), with options and a recommendation.
