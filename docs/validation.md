# Fire-3d forecast validation

Section 10 (outside California, brief 3) was added on 2026-10-23 by the brief-3 validation run. Sections 1-9: last updated 2026-10-17 (evening) by the backend follow-up run, which added the live forecast start (section 6);
sections 5.2, 5.3 and 6.3 were re-checked against the code and the published bundles on 2026-10-18. It
covers the spread forecast in `backend/fire3d/spread/` with the defaults in `backend/fire3d/config.py`
(`FORECAST_*`, `DROUGHT_ADJUSTED_LFM`, `LIVE_START_LATEST_PASS`). All numbers come from the published bundles in
`data/incidents/`.

## Summary

- **Method.** We tested the forecast by re-running ("hindcasting") three 2025 fires: Eaton, Madre and Palisades.
  Each run started from 8 past start times, and its output was compared with the fire spread reconstructed from
  satellite detections and perimeters. That gives 32 scores at 12, 24, 48 and 72 h after the start.
- **Skill is moderate.** For the operational settings, the mean *growth* Sørensen score is 0.43 (0.44 with the
  31-member ensemble; 0.42 before the burnout rule of section 6.6; scale below). This
  score compares only the area that burned after the forecast start; 0 means no overlap and 1 means a perfect
  match. Most growth was over by +48 h, and at +48 h and +72 h the mean is about 0.48. The *total-area* score is
  0.82, but it looks good partly because the area already burned at the start always overlaps.
- **Main error: too much late growth.** After the main wind-driven run ends, the model keeps spreading, because it
  does not simulate firefighting or fires dying down. In the median, the forecast grows about 1.85 times as much as the real fire.
  The other error is that the first hours of extreme runs are under-predicted (Eaton: about 30 % of the first 12 h of
  growth from ignition + 6 h).
- **Changes kept, because they improved the scores** (details in sections 3 and 4):
  1. Live fuel moisture adjusted for drought.
  2. Spread held along the quiet part of the perimeter.
  3. A spread-rate multiplier that starts at 0.5 and relaxes toward 0.05 as lead time grows.
- **Changes tested and left off, because they lowered the scores:**
  1. A treatment that lets developed land near wildland burn (WUI surrogate).
  2. Ember spotting.
- **Eaton.** Its old under-prediction came mainly from the January live fuel moisture table, not from urban fuel
  codes. Section 4 has the evidence.
- **Live forecasts start at the latest observation, not the last detection** (section 6). A satellite pass that
  looked at the fire and saw nothing is an observation too. A fire that went quiet now starts at the latest
  confirmed pass with its last mapped area, and the perimeter that stayed quiet is held. Henderson Fire: the old rule
  predicted 13,330 ac for the evening of Oct 17; the new forecast holds 3,228 ac; CAL FIRE reported 3,160 ac (50 %
  contained). On past fires re-run as if live, the new rule cut the late over-prediction (median 86x -> 2.6x) without
  changing historical hindcast skill.
- **Burnout is not spread** (section 6.6). Hot pixels on ground that burned more than 12 h earlier no longer keep
  the perimeter active. Growth Sørensen: hindcasts 0.422 -> 0.432; pseudo-live 0.227 -> 0.234, with mean error
  6,932 -> 6,434 ac. No fire got worse. Small, actively burning fires (Cooley) remain an open question.
- **Outside California (section 10, brief 3).** The model was re-run on 12 past fires, two in each of six regions,
  with starts and a regional live fuel moisture method (the NFDRS 2016 Growing Season Index) fixed in advance. Mean
  growth Sørensen per region (two fires each, so rough: two fires of a region differ by about 0.1 on average):
  Northwest 0.26, Northern Rockies 0.34, Great Basin 0.25, Southwest
  0.35, Southern Plains 0.39, Southeast 0.19, against 0.43 in Southern California, where the settings were fitted.
  Outside California the model usually forecasts too little new growth (8 of 12 fires), the opposite of California;
  a faster spread setting would help those fires but makes California worse, so nothing was changed. Rocky
  Mountain, Eastern and Northern California have no test fire ("accuracy not yet tested here").
- Treat forecasts as experimental guidance. They are not evacuation advice. Burn probabilities describe the
  model ensemble, not real-world odds.

**Sørensen score:** 2|F∩O| / (|F| + |O|), where F is the forecast burned area (the ensemble median, p50) and O is
the observed burned area at the same time.

## 1. What the forecast is compared against

There is no measured hour-by-hour fire map. The "observed" spread is reconstructed by `build/observed.py`:

- **Inputs.** VIIRS and MODIS satellite fire detections, Landsat where available, and NIFC daily perimeters.
- **Interpolation.** Arrival times are filled in between snapshots by distance.
- **Timing.** GOES activity is used to warp time within each interval.

Checks:

| check | result |
|---|---|
| Synthetic fire with a known arrival-time field (`tests/test_observed.py` scenario, re-measured today) | median absolute timing error **1.29 h**, median bias −0.68 h (reconstruction slightly early), 90th percentile 4.3 h; final area 1.000 × truth |
| Final area vs CAL FIRE | Eaton 14,115 / 14,021 ac (1.007), Madre 81,938 / 80,779 (1.014), Palisades 23,457 / 23,448 (1.000) |
| dNBR (Sentinel-2) vs observed extent | burn-severity edges line up with the reconstructed extent and the WFIGS perimeter in the quick-looks (`docs/screenshots/backend-*-dnbr-perimeter.png`) |

Known biases of the truth, which matter for the scores:

- **VIIRS bloat in the first hours.** VIIRS flags pixels around very hot small fires, so the reconstruction runs
  ahead of reported growth. Palisades shows about 2,300 ac at 13:00 PST on Jan 7 against roughly 800 reported.
  Madre shows 12.8k ac at 22:49Z on Jul 2 against an 8.4k ac perimeter 22 min later. This makes the observed early
  growth larger and later growth smaller than reality, which penalises early-lead under-prediction slightly.
- **Snapshot spacing.** Passes are a few hours apart, so timing within a 12 h lead is uncertain by about 1–3 h.

## 2. Method

- **Forecast model.** pyretechnics 2026.8.10 (Rothermel surface spread, Van Wagner crown fire, eulerian level set).
  - Fuels: LANDFIRE LF2024 FBFM40 and canopy.
  - Terrain: USGS 3DEP.
  - Grid: 512² fire grid at 45 m (Eaton), 98 m (Madre) and 59 m (Palisades).
- **Weather.** Open-Meteo *historical-forecast* HRRR, a series stitched from the first hours of each HRRR run.
  Hindcasts therefore get almost-perfect weather. A real-time forecast must use 1–3-day-old model forecasts, so
  **real-time skill will be lower than these hindcast scores.**
- **Start times and leads.**
  - Start times: Eaton and Palisades at ignition + 6, 12 and 24 h; Madre at ignition + 24 and 48 h. Madre starts
    later because its reconstruction already holds 60 % of the final area by ignition + 12 h, partly VIIRS bloat
    (see section 1).
  - Leads: 12, 24, 48 and 72 h. All 32 leads fall before containment, so the final burned area is the truth there.
  - Each start uses the observed burned area at that time as the ignition (SPEC 8.5).
- **Calibration runs.** These use the deterministic member (`ensemble="none"`). Each candidate configuration was run
  over a grid of start multipliers. The grid is the SPEC's {0.5, 0.75, 1, 1.5, 2}, extended down to 0.15–0.35
  because every configuration without the decay peaked at or below 0.5.
- **Selection rule.** The highest mean growth-only Sørensen over the 32 leads (`validate.summarize_hindcast`).
  Total-area Sørensen is reported but not used: the area already burned at the start inflates it.
- **Ensemble check.** The chosen settings were re-run with the operational 31-member perturbed ensemble (section 5).

## 3. Model changes and their effect (ablation)

Each row adds one change; the multiplier is the best value of the grid for that row. The scores are the mean growth
Sørensen; the per-fire and per-lead columns are means of the same 32 runs.

| configuration | best multiplier | growth Sørensen (mean of 32) | Eaton | Madre | Palisades | +12 h | +24 h | +48 h | +72 h | growth ratio fc/obs (median) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| SPEC 8.4/8.5 as written (month-table live moisture, constant multiplier) | 0.5 | 0.390 | 0.429 | 0.207 | 0.473 | 0.274 | 0.402 | 0.451 | 0.434 | 2.30 |
| + drought-adjusted live fuel moisture | 0.25 | 0.397 | 0.400 | 0.271 | 0.478 | 0.284 | 0.415 | 0.458 | 0.432 | 2.18 |
| + drought LFM + WUI surrogate | 0.25 | 0.380 | 0.361 | 0.271 | 0.473 | 0.296 | 0.399 | 0.428 | 0.398 | 2.95 |
| + drought LFM + held inactive perimeter | 0.25 | 0.414 | 0.405 | 0.332 | 0.478 | 0.312 | 0.429 | 0.472 | 0.445 | 1.81 |
| + drought LFM + WUI + held perimeter | 0.15 | 0.400 | 0.385 | 0.349 | 0.449 | 0.284 | 0.386 | 0.459 | 0.472 | 1.43 |
| + drought LFM + held perimeter + lead-time decay (**operational**) | 0.5 | 0.422 | 0.432 | 0.353 | 0.458 | 0.332 | 0.415 | 0.466 | 0.475 | 2.01 |
| + drought LFM + WUI + held perimeter + lead-time decay | 0.5 | 0.404 | 0.383 | 0.353 | 0.458 | 0.336 | 0.400 | 0.437 | 0.443 | 2.42 |
| + drought LFM + WUI + held perimeter + decay + ember spotting | 0.75 | 0.189 | 0.116 | 0.107 | 0.317 | 0.239 | 0.209 | 0.168 | 0.141 | 15.49 |

Full grids: mean growth Sørensen, with the median growth ratio (forecast / observed) in brackets; the best value
of each row is bold.

| configuration | 0.15 | 0.25 | 0.35 | 0.5 | 0.75 | 1 | 1.5 | 2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SPEC as written | – | 0.370 (1.3×) | – | **0.390 (2.3×)** | 0.378 (3.4×) | 0.358 (4.6×) | 0.318 (6.5×) | 0.293 (7.6×) |
| drought LFM | – | **0.397 (2.2×)** | – | 0.352 (4.1×) | 0.306 (6.1×) | 0.276 (7.5×) | 0.232 (10.0×) | 0.207 (11.8×) |
| drought LFM + WUI | – | **0.380 (2.9×)** | – | 0.327 (5.5×) | 0.278 (8.1×) | 0.245 (10.5×) | 0.198 (14.7×) | 0.172 (16.7×) |
| drought LFM + hold | 0.408 (1.2×) | **0.414 (1.8×)** | 0.398 (2.5×) | 0.366 (3.5×) | 0.317 (5.2×) | 0.285 (6.6×) | 0.237 (9.5×) | 0.210 (11.3×) |
| drought LFM + WUI + hold | **0.400 (1.4×)** | 0.399 (2.4×) | 0.377 (3.4×) | 0.341 (4.5×) | 0.290 (6.5×) | 0.254 (8.3×) | 0.204 (11.7×) | 0.175 (14.7×) |
| drought LFM + hold + decay (**operational**) | – | 0.363 (1.1×) | 0.398 (1.5×) | **0.422 (2.0×)** | 0.420 (2.9×) | 0.408 (3.7×) | 0.375 (5.3×) | 0.327 (6.7×) |
| drought LFM + WUI + hold + decay | – | 0.364 (1.3×) | 0.392 (1.8×) | **0.404 (2.4×)** | 0.390 (3.5×) | 0.371 (4.5×) | 0.336 (6.5×) | 0.293 (8.2×) |
| ... + decay + WUI + spotting | – | – | – | – | **0.189 (15.5×)** | 0.183 (16.4×) | – | – |

### 3.1 Drought-adjusted live fuel moisture (on)

SPEC 8.4's month table gives January 120 % herbaceous and 120 % woody live moisture. That assumes the winter rains
have greened up the vegetation. The 2024–25 water year was extremely dry in Los Angeles. ERA5 precipitation at the
ignition points from Oct 1 to the fire start was:

- Eaton: **12 mm** by Jan 7
- Palisades: **9 mm** by Jan 6
- Madre: 207 mm by Jul 1 (July is already at the dry-season values)

Chaparral had not greened up, so the table overstated live moisture and the model under-predicted the early runs.

`spread/moisture.live_fuel_moisture` now blends the month's values toward the dry-season row (herb 30 %, woody 70 %,
SPEC's Jul–Oct values). The blend depends on water-year precipitation P:

- P ≤ 25 mm (no germinating rain): full dry-season values.
- P ≥ 100 mm: the table as before.
- In between: a linear blend.

The bundle stores P in `sim/antecedent.json` (ERA5 archive via Open-Meteo).

Effect at multiplier 1, Eaton from ignition + 6 h, first 12 h of growth: **0.39×** the observed growth with the
table, **0.88×** with the adjustment. Because the model then spreads faster everywhere, the best constant multiplier
drops from 0.5 to 0.25, and the mean growth Sørensen rises only a little (0.390 → 0.397). We keep it because it is
the right fuel state for a rainless winter. The remaining multiplier then stands for processes the model lacks,
not for a wrong vegetation state.

### 3.2 Held inactive perimeter (on)

A forecast starts from the whole burned area. Real fires spread only from their active edges; quiet flanks are
burned out or held by crews. `ensemble.held_perimeter` makes a 2-cell band along the perimeter non-burnable where
both of these hold:

- nothing burned within 1 km in the 12 h before the start (from the observed arrival field);
- no VIIRS, MODIS or Landsat detection of new burning within 1 km in those 12 h. Since 2026-10-18 a detection on
  ground that burned before the window counts as burnout, not activity (section 6.6). This raised the calibration
  score from 0.422 to 0.432 (Madre 0.353 -> 0.392; Eaton and Palisades unchanged).

GOES pixels are too coarse for this. This is observation-informed, not tuned to the scores.

It mainly helps forecasts started after the main run, on Madre: 0.271 → 0.332. Mean: 0.397 → 0.414. The share
of perimeter held is printed in each forecast's warnings.

### 3.3 Lead-time decay of the spread-rate multiplier (on)

The multiplier is m(t) = a · (0.1 + 0.9 · e^(−lead/12 h)), with a = 0.5 at the start. It falls to:

| lead | multiplier |
|---:|---:|
| 6 h | 0.32 |
| 12 h | 0.22 |
| 24 h | 0.11 |
| 72 h | 0.05 |

This is a statistical, lead-time-dependent bias correction, in the same spirit as model output statistics in
weather forecasting. It stands in for processes the model does not have: suppression, fires dying down after a
wind event, fuel and weather details. It is fitted to only three fires and eight starts.

Results:

- Mean growth Sørensen: 0.414 with the best constant multiplier (0.25) against **0.422** with the decay.
- 12 h skill: 0.312 against 0.332.
- 72 h skill: 0.445 against 0.475.

The two are statistically indistinguishable on this sample.

**Risk to know about.** Because the multiplier falls with lead time, a *renewed* wind event 2–3 days after the
start will be under-predicted.
- Each forecast's warnings state the multiplier schedule.
- `FORECAST_ADJUSTMENT_DECAY_H = 0` with `FORECAST_SPREAD_ADJUSTMENT = 0.25` restores the constant alternative.

### 3.4 WUI surrogate for developed land (tested, off)

LANDFIRE codes towns as non-burnable NB1 (91), so a modelled fire stops at every town edge. Real wind-driven fires
spread through neighbourhoods by embers and house-to-house exposure.

`engine.wui_mask` selects the developed cells of the wildland-urban interface:

- within 2.4 km of a ≥ 5 km² block of ≥ 75 % wildland vegetation (the SILVIS interface definition of Radeloff et
  al. 2005);
- in a settlement that is ≥ 25 % developed within 1 km, so isolated roads through wildland stay non-burnable.

Those cells burn as TU5 (165).

Evidence on Eaton:

- 16 % of the area that actually burned is NB1 (2,316 ac). The often-quoted "35 % urban" is the share of the
  whole modelled area, not of the burn.
- The mask covers **96 %** of the developed land that burned.
- But it makes 22,031 ac of developed land burnable, and only 10 % of that burned.

Effect: in the model, fire runs along the whole foothill interface; the orange area in
`docs/screenshots/backend-eaton-direction-check.png` shows this. The surrogate lowered the mean growth Sørensen
in every configuration:

| configuration | without WUI | with WUI |
|---|---:|---:|
| drought LFM only | 0.397 | 0.380 |
| with held perimeter | 0.414 | 0.400 |
| with held perimeter and decay | 0.422 | 0.404 |

The reason is that the model already over-predicts after the first hours. The surrogate stays in the code
(`SpreadSettings.wui`, `validate hindcast --wui`) and is **off** by default (`FORECAST_WUI = False`).

### 3.5 Ember spotting (tested, off; SPEC default)

pyretechnics' stochastic firebrand model was tested with the parameters of the pyretechnics documentation example
(`engine.SPOT_CONFIG_DEFAULTS`), on top of the WUI, hold and decay settings. It spotted far too much:

- median growth ratio **15×**;
- mean growth Sørensen 0.19, against 0.39 without spotting.

Calibrating the firebrand parameters would need fires with mapped spot fires. Spotting stays off.

## 4. Why Eaton under-predicted, and what changed

The spread module's first trial lit only the CAL FIRE ignition cell, because no observed reconstruction existed
yet. It gave a median of 3,677 ac at +24 h against about 10,600 ac published. Two causes were suspected: urban
non-burnable fuel and spotting being off. The evidence above shows:

1. **Live fuel moisture was the main cause.** The January table assumed green vegetation after a near-rainless
   autumn. The drought adjustment raised the first-12-h growth from 0.39× to 0.88× of the observed growth.
2. **Urban fuel codes matter less than they appeared.** NB1 is 36 % of the modelled area but 16 % of the burned
   area. Making it burnable mostly added false growth (3.4).
3. **Spotting with untuned parameters is far worse** (3.5).

What remains for Eaton under the operational settings, starting at ignition + 6 h (section 5): the first 12 h of
growth is under-predicted, because the multiplier that best fits all three fires slows the initial run. Growth
over 72 h is close to observed. The Altadena part of the burn (developed land) cannot be reproduced while NB1 is
non-burnable.

**Direction check** (`docs/screenshots/backend-eaton-direction-check.png`, from ignition + 6 h, 12 h):
- The mean HRRR wind blew from 68° (ENE) at 27 km/h.
- With developed land burnable, the modelled growth centroid moved **219°** (SW, downwind) into Altadena.
- With the default settings, growth goes mainly north (bearing 6°), upslope into the San Gabriels, because the
  land downwind is non-burnable NB1.
- The observed growth in the same 12 h went west and northwest along the foothills and into the mountains
  (centroid bearing 314°).

The wind (FROM), aspect and row conventions are correct. They are also covered by unit tests:
`tests/test_spread_engine.py` (fire runs east under a west wind, and uphill).

## 5. Operational configuration and ensemble hindcasts

Operational settings (`config.FORECAST_*`, used by the CLI, API, live loop and pipeline):

| setting | value |
|---|---|
| live fuel moisture | month table with the drought adjustment (`DROUGHT_ADJUSTED_LFM = True`) |
| held inactive perimeter | on (`FORECAST_HOLD_INACTIVE`; 12 h window, 1 km; only growth-coincident detections count, `FORECAST_ACTIVE_GROWTH_ONLY`, section 6.6) |
| spread-rate multiplier | 0.5 at the start (`FORECAST_SPREAD_ADJUSTMENT`), × (0.1 + 0.9 e^(−lead/12 h)) (`FORECAST_ADJUSTMENT_DECAY_H`, `FORECAST_ADJUSTMENT_FLOOR`) |
| WUI surrogate | off (`FORECAST_WUI`) |
| crown fire / spotting | on / off (SPEC 8.5) |
| ensemble | historical: 31 perturbed members (SPEC 8.4); live: GFS 31 or ECMWF IFS 51 members |
| live start | latest observation incl. confirmed quiet satellite passes (`LIVE_START_LATEST_PASS`, section 6) |
| live hold extras | activity markers; at least CAL FIRE's contained share held (`FORECAST_HOLD_CONTAINED`) |
| live decay clock | from the last sign of activity when the start is a quiet pass (`FORECAST_DECAY_FROM_LAST_ACTIVITY`) |

`ForecastManifest.model.spread_adjustment` reports the start multiplier (0.5). The decay schedule, the held
share of the perimeter and the live fuel moisture used are written to each forecast's `warnings`.

### 5.1 Check with the operational 31-member ensemble

The calibration used the deterministic member. Re-running the best candidates as 31-member perturbed ensembles
(scoring the p50 map, as the app shows it) confirms the choice:

| configuration | growth Sørensen | Eaton | Madre | Palisades | +12 h | +24 h | +48 h | +72 h | growth ratio (median) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| hold (growth-coincident detections, 6.6) + decay, multiplier 0.5 (**operational**) | **0.438** | 0.438 | 0.395 | 0.467 | 0.349 | 0.432 | 0.481 | 0.490 | 1.85 |
| hold + decay, multiplier 0.5 (operational until 2026-10-18) | 0.428 | 0.438 | 0.355 | 0.467 | 0.340 | 0.422 | 0.470 | 0.480 | 2.02 |
| hold + decay, multiplier 0.75 | 0.425 | 0.426 | 0.318 | 0.494 | 0.354 | 0.429 | 0.460 | 0.456 | 2.90 |
| hold, constant multiplier 0.25 | 0.416 | 0.405 | 0.333 | 0.483 | 0.319 | 0.434 | 0.471 | 0.441 | 1.81 |

### 5.2 Published hindcasts (in the bundles, shown in the app)

Scores are against the observed reconstruction, computed from each bundle's published p50 and observed arrival with
`validate.skill_from_arrays` (re-checked 2026-10-18). The *total* score is the contract's `skill` field. *Growth* counts
only the area that burned after the start; *fc* is the p50 forecast.

| fire, run | start | lead | observed / fc total ac | total Sørensen | observed / fc growth ac | growth Sørensen |
|---|---|---:|---:|---:|---:|---:|
| Eaton `fc-20250108T0818-perturbed-00ce` | Jan 8 00:18 PST (ignition + 6 h) | 12 h | 11,749 / 7,511 | 0.754 | 6,204 / 1,966 | 0.42 |
| | | 24 h | 12,400 / 8,583 | 0.785 | 6,854 / 3,038 | 0.54 |
| | | 72 h | 14,115 / 11,010 | 0.800 | 8,570 / 5,465 | 0.64 |
| Madre `fc-20250703T2007-perturbed-a95d` | Jul 3 13:07 PDT (ignition + 24 h) | 12 h | 72,276 / 87,688 | 0.835 | 10,390 / 25,802 | 0.27 |
| | | 24 h | 77,091 / 93,481 | 0.817 | 15,205 / 31,595 | 0.33 |
| | | 72 h | 81,938 / 107,401 | 0.791 | 20,052 / 45,515 | 0.40 |
| Palisades `fc-20250108T0020-perturbed-7d3b` | Jan 7 16:20 PST (ignition + 6 h) | 12 h | 18,690 / 9,878 | 0.686 | 11,778 / 2,967 | 0.39 |
| | | 24 h | 19,530 / 10,953 | 0.711 | 12,619 / 4,042 | 0.47 |
| | | 72 h | 22,761 / 12,725 | 0.706 | 15,849 / 5,813 | 0.52 |

Reading these:

- The Eaton and Palisades runs start during the main wind-driven runs (Eaton at night, Palisades in the late
  afternoon).
  - They catch where the fire went: about half of the observed growth is covered at +24 h.
  - They miss how fast it went: only 25–45 % of the growth arrives in the first 12–24 h. Part of the observed early
    growth is VIIRS bloat (section 1), and part is neighbourhood burning that the model cannot do.
- The Madre run starts after the main run and forecasts 2.1–2.5 times the observed late growth, which is the
  over-prediction described above.
- The quick-looks `docs/screenshots/backend-{eaton,madre,palisades}-forecast-*.png` show the burn probability, the
  p50 fronts at +12/24/48/72 h, the start area and the final observed outline.

### 5.3 All 32 calibration leads for the operational setting (deterministic member)

Re-run on 2026-10-18 with the operational code, including the growth-only hold of section 6.6 (`validate hindcast`
with `--adjustments 0.5`, section 9). The Madre rows changed with that rule; the Eaton and Palisades rows did not.

| fire | start (h after ignition) | lead (h) | observed growth (ac) | forecast growth (ac) | growth Sørensen | total Sørensen |
|---|---:|---:|---:|---:|---:|---:|
| Eaton | 6 | 12 | 6,204 | 1,790 | 0.39 | 0.74 |
| Eaton | 6 | 24 | 6,854 | 2,855 | 0.52 | 0.78 |
| Eaton | 6 | 48 | 8,570 | 4,357 | 0.58 | 0.77 |
| Eaton | 6 | 72 | 8,570 | 5,320 | 0.63 | 0.80 |
| Eaton | 12 | 12 | 2,623 | 4,345 | 0.39 | 0.84 |
| Eaton | 12 | 24 | 2,823 | 5,657 | 0.41 | 0.82 |
| Eaton | 12 | 48 | 4,458 | 6,942 | 0.55 | 0.83 |
| Eaton | 12 | 72 | 4,458 | 7,801 | 0.54 | 0.82 |
| Eaton | 24 | 12 | 200 | 2,843 | 0.12 | 0.90 |
| Eaton | 24 | 24 | 1,835 | 4,565 | 0.35 | 0.87 |
| Eaton | 24 | 48 | 1,835 | 6,276 | 0.35 | 0.84 |
| Eaton | 24 | 72 | 1,835 | 7,179 | 0.34 | 0.82 |
| Madre | 24 | 12 | 10,390 | 26,038 | 0.27 | 0.83 |
| Madre | 24 | 24 | 15,205 | 31,170 | 0.34 | 0.82 |
| Madre | 24 | 48 | 20,052 | 38,174 | 0.40 | 0.81 |
| Madre | 24 | 72 | 20,052 | 42,517 | 0.41 | 0.80 |
| Madre | 48 | 12 | 4,805 | 8,623 | 0.49 | 0.96 |
| Madre | 48 | 24 | 4,848 | 11,137 | 0.46 | 0.95 |
| Madre | 48 | 48 | 4,848 | 14,363 | 0.40 | 0.93 |
| Madre | 48 | 72 | 4,848 | 16,331 | 0.37 | 0.92 |
| Palisades | 6 | 12 | 11,778 | 2,856 | 0.38 | 0.68 |
| Palisades | 6 | 24 | 12,619 | 3,903 | 0.46 | 0.71 |
| Palisades | 6 | 48 | 14,584 | 4,899 | 0.49 | 0.70 |
| Palisades | 6 | 72 | 15,849 | 5,572 | 0.50 | 0.70 |
| Palisades | 12 | 12 | 8,244 | 3,458 | 0.48 | 0.82 |
| Palisades | 12 | 24 | 8,929 | 4,895 | 0.55 | 0.83 |
| Palisades | 12 | 48 | 11,383 | 6,210 | 0.56 | 0.80 |
| Palisades | 12 | 72 | 12,558 | 7,214 | 0.57 | 0.79 |
| Palisades | 24 | 12 | 686 | 5,002 | 0.20 | 0.90 |
| Palisades | 24 | 24 | 1,397 | 6,962 | 0.32 | 0.88 |
| Palisades | 24 | 48 | 3,335 | 8,847 | 0.48 | 0.87 |
| Palisades | 24 | 72 | 4,483 | 10,113 | 0.51 | 0.86 |

## 6. Live forecasts

Live forecasts use the real GFS (31 members) or ECMWF IFS (51 members) ensemble from Open-Meteo, bias-corrected to
HRRR while HRRR is available, with the operational settings of section 5. They cannot be verified like hindcasts;
section 6.4 compares them with CAL FIRE's reported acreage.

### 6.1 Where a live forecast starts (changed 2026-10-17)

**The problem.** A live forecast used to start at the last satellite *detection* (`time_range.now_ms`). A fire that
has gone quiet produces no detections, so its forecast started at its last active moment and grew it for 72 h from
there. Henderson Fire: the last detection was Oct 16 14:48 PDT, while the fire was still growing. Thirteen satellite
passes over the next 25 h saw nothing, CAL FIRE reported 3,132 ac and 35 % containment, and the forecast still
predicted about 12,000 ac a day after its start.

**The rule now** (`build/live_observation.py`, `sources/overpass.py`; SPEC 5.1, 6, 8.3, 8.5):

1. **The burned area is known up to the last detection** or mapped perimeter (`time_range.last_detection_ms`).
   Nothing is invented after it: the observed arrival is clipped there.
2. **Passes that saw nothing are observations too.** NASA's CMR lists the granules of the same VIIRS (Suomi NPP,
   NOAA-20, NOAA-21) and MODIS (Terra, Aqua) active-fire products FIRMS is made from; a granule containing the fire's
   centroid is a pass over it. A pass counts only when it is *confirmed*: its granule was published at least 30 min
   before our FIRMS data of the same satellite were fetched, so any detection it made is in our data. A confirmed
   pass after the last detection therefore saw no fire above the detection limit. `time_range.now_ms`, the latest
   observation and the default forecast start, becomes the newest confirmed pass (`time_range.last_pass_ms`).
3. **Unless CAL FIRE says the fire grew unseen.** When CAL FIRE acreage reported after the last detection exceeds
   1.25 x the mapped area + 100 ac (clouds or smoke can hide a growing fire), the start stays at the last detection,
   with a warning. Without CMR (outage) the start also stays at the last detection, with a warning.
4. **The quiet perimeter is held** by the calibrated rule of section 3.2: perimeter with no burning and no detection
   within 1 km in the 12 h before the start. With a start 12 h or more after the last detection, the whole
   perimeter is held and the forecast shows no growth. Its warning says that this does not mean the fire is out.
5. **Weak activity keeps the nearby perimeter active.** Low-confidence VIIRS/MODIS pixels within 1 km of the burned
   area, and GOES detections of the fire on at least 2 scans within 1 h, are too weak or coarse to map burned area.
   After the last detection they never move the start, but the perimeter near them (GOES: within a 1 km disk around
   the pixel centre, plus 1 km) is not held. This also applies to activity seen after the start.
6. **Official containment sets a minimum.** At least CAL FIRE's contained share of the perimeter is held, the part
   farthest from recent activity first; where the contained lines are is not published. This uses information from
   the issue time (it can be reported a few hours after the start), as an issued forecast would.
7. **The decay clock starts at the last activity.** The calibrated multiplier decays with lead time (section 3.3)
   because fires die down after their runs. When the start is a quiet pass, its lead is counted from the last sign
   of activity, as if the forecast had started there (Henderson: 0.11 instead of 0.5 at the start).
8. **Official perimeters** newer than the last detection already counted as observations (SPEC 8.3) and still do:
   Norte starts at the NIFC perimeter mapped Oct 17 17:42 PDT (570 ac).

Why this is defensible:
- **Physically:** VIIRS detects fires of a few hundred square metres at night and is designed to see active flame
  fronts. Several consecutive passes without a detection mean there is no active front, the same evidence the hold
  rule already used in the calibration.
- **Statistically:** the rule never changes a start while detections continue. In the pseudo-live re-runs (6.2) it
  improved every scored measure except growth Sørensen, which stayed the same. Historical hindcasts are unchanged
  (6.3).

The `NASA CMR satellite passes` data source of each live bundle says what was decided, in plain words.
`sim/activity.json` keeps the confirmed passes (with their detection counts) and the markers for audit.

### 6.2 Pseudo-live check on past fires

`validate live-start` re-issues forecasts on the published historical bundles as if they were live:
- **Issue times:** every 6 h from ignition + 6 h to the bundle's `end_ms` (detections are complete up to there).
- **What is known at issue time τ:** polar detections and satellite passes up to τ − 1 h (the archive granules from
  NASA CMR), and the burned area only up to the last detection (the reconstruction is clipped there).
- **Settings:** each variant runs the deterministic member with the operational settings, using GOES markers after
  the last detection.
- **Scoring:** the full reconstruction at the same valid times τ + 12/24/48 h. *Growth* counts only area beyond
  what was known at τ.

There are 51 issue times on Eaton, Palisades, Madre, Lidia and Camino. In 14 of them the latest pass came after the
last detection ("quiet"); in the other 37 all variants are the same run.

All numbers use the operational hold (growth-coincident detections, section 6.6). The previous hold gave the same
picture: quiet issues 0.360 -> 0.666 total Sørensen, error 4,954 -> 2,278 ac.

| quiet issues (30 scored leads) | total Sørensen | growth Sørensen | forecast growth (mean ac) | observed growth (mean ac) | mean abs. error (ac) | growth ratio (median) |
|---|---:|---:|---:|---:|---:|---:|
| start at the last detection (old rule) | 0.362 | 0.135 | 5,475 | 676 | 4,799 | 85.7x |
| start at the latest pass, decay from the start | 0.644 | 0.130 | 3,174 | 676 | 2,537 | 2.63x |
| start at the latest pass, decay from the last activity (**operational**) | **0.669** | 0.134 | 2,766 | 676 | **2,128** | **2.57x** |

By how long the fire had been quiet at the start:

| quiet for | issues | old rule: total Sørensen / error | operational: total Sørensen / error |
|---|---:|---:|---:|
| < 12 h (the last detections are still inside the hold window) | 7 | 0.552 / 4,074 ac | 0.596 / 3,328 ac |
| >= 12 h | 7 | 0.114 / 5,747 ac | 0.764 / 560 ac |

All 51 issues (141 scored leads):

| rule | total Sørensen | growth Sørensen | mean abs. error | growth ratio (median) |
|---|---:|---:|---:|---:|
| old | 0.752 | 0.2340 | 7,002 ac | 3.53x |
| operational | **0.818** | 0.2339 | **6,434 ac** | **2.66x** |

Reading these:
- **Growth Sørensen hardly moves.** When the observed growth is near zero, it scores every forecast as about 0: the
  old 5,800 ac and the new 0 ac alike. Total Sørensen and the acreage error show the difference.
- **Small, one-sided sample.** The quiet issues come mostly from Lidia (9 of 14; the >= 12 h group is all Lidia).
  Big fires keep producing mop-up detections on most passes until `end_ms`, and the archived bundles hold no
  detections after it, so later quiet periods cannot be tested.
- **Assumptions:** a 1 h data latency, and the reconstruction as truth (section 1). Archived bundles keep no
  low-confidence pixels, so only GOES markers were used.
- **No containment history** exists for past fires, so the containment minimum (6.1, item 6) is physically
  motivated but not hindcast-tested.

### 6.3 Historical hindcasts do not regress

The live start rule does not touch hindcasts: historical bundles have no `sim/activity.json`, no live start and no
containment input. Re-running the calibration set of section 5.3 with the new code:

| check | result |
|---|---|
| 32 leads, deterministic member, multiplier 0.5, previous hold | mean growth Sørensen **0.422**, total 0.822, median growth ratio 2.01 (unchanged) |
| per fire, previous hold | Eaton 0.432, Madre 0.353, Palisades 0.458 (unchanged) |
| same, with the growth-only hold adopted in 6.6 | **0.432**, total 0.825, ratio 1.85; Eaton 0.432, Madre 0.392, Palisades 0.458 |
| per lead, growth-only hold (re-run 2026-10-18) | +12 h 0.341, +24 h 0.425, +48 h 0.476, +72 h 0.485 |

### 6.4 Live fires on Oct 17 (before and after)

The live loop on port 8711 refreshed the three live bundles at 20:49 PDT and forecast them with the new defaults
(GFS x31; Cooley also ECMWF x51 through `POST /forecast`). CAL FIRE reports and p50 areas:

| incident | CAL FIRE (report time, PDT) | old run: start -> p50 at ~20:49 PDT | new run: start -> p50 at 20:49 PDT / +24 h / +72 h |
|---|---|---|---|
| Henderson | 3,160 ac, 50 % (19:24) | Oct 16 14:48 -> **13,004 ac** (published `fc-20261016T2148-gfs025-dfe4`); old rule on today's data 13,330 ac (p10–p90 13,017–13,626) | Oct 17 15:50 (latest pass, 13 quiet passes) -> **3,228** / 3,228 / 3,228 ac (`fc-20261017T2250-gfs025-3df2`) |
| Norte | 570 ac, 25 % (19:42) | Oct 16 14:48 -> **1,328 ac** (`fc-20261016T2148-gfs025-3a21`) | Oct 17 17:42 (NIFC perimeter) -> **571** / 571 / 571 ac (`fc-20261018T0042-gfs025-f995`) |
| Cooley | 731 ac, 5 % (19:49) | Oct 17 04:06 -> **2,015 ac** (`fc-20261017T1106-gfs025-9bc0`) | Oct 17 15:52 (last detection = latest pass, still active) -> **1,474** / 2,100 / 2,390 ac (`fc-20261017T2252-gfs025-0228`); ECMWF x51 similar (`fc-20261017T2252-ecmwf_ifs025-8ccd`) |

How each fire changed:
- **Henderson.** The fix itself: same data, same model, a start 25 h later at the latest pass with the quiet
  perimeter held.
- **Norte.** It already starts at its newer NIFC perimeter (an existing rule, now refreshed), and its 27 quiet hours
  hold the perimeter.
- **Cooley.** Still active, so the rule does not change its start. It now grows from the 730 ac NIFC perimeter
  instead of the VIIRS-bloated 1,010 ac. It still over-predicts: CAL FIRE reports no growth since the 13:06 PDT
  perimeter. The 1 km activity radius marks the whole perimeter of a small fire active whenever any pixel inside it
  is still hot (section 8).

The old runs were removed from the live bundles (their manifests list only the new runs). On Oct 17 at 21:19 PDT
the new runs were re-made through the API with the growth-only hold of section 6.6; their areas are identical.
Quick-looks:
`docs/screenshots/redesign-backend-followups-{henderson,norte,cooley}-forecast-*.png`.

### 6.5 Ensemble spread

The ensemble spread of live forecasts is narrow. The p10–p90 area range is only about 2–4 % of the area, because the
members differ only in weather. It understates the real uncertainty (section 8).

### 6.6 Activity on small, burning fires (tested 2026-10-18)

**The question.** On Oct 17, Cooley's forecast grew from its 730 ac NIFC perimeter to 1,474 ac by 20:49 PDT and
2,100 ac at +24 h, while CAL FIRE showed 731 ac. The suspicion was that the 1 km activity radius marks the whole
perimeter of a small fire active whenever any pixel inside it is hot.

**What the data show** (Cooley at its 15:52 PDT start):
- **The hot pixels are at the edge, not inside.** Burned area 730 ac (equivalent radius 970 m, deepest cell 594 m from
  the unburned land). The 45 detections of the 12 h window lie at a median depth of 105 m (90th percentile 267 m).
  A rule that ignores interior activity cannot change Cooley.
- **Many of them are on old ground.** 30 of the 45 detections lie on ground that burned before the window
  (burnout); the other 15 lie on newly burned or outside ground all around the edge. So the whole perimeter stays
  active under every rule tested.
- **CAL FIRE's 731.4 ac (updated 19:49 PDT) equals the 13:06 PDT NIFC perimeter (730 ac).** It repeats the last
  mapping; it does not show that the fire stopped growing. Cooley's over-prediction is therefore not established.
  Only the next mapped perimeter can verify it.

**Variants tested** (`validate hindcast` on the 32 calibration leads, `validate live-start` on the 51 pseudo-live
issues with the operational start rule; same settings otherwise):

| activity rule | hindcast growth Sørensen (32 leads) | Eaton / Madre / Palisades | pseudo-live total / growth Sørensen (141 leads) | mean growth error | quiet issues growth Sørensen | small fires growth error |
|---|---:|---:|---:|---:|---:|---:|
| 1 km radius, all detections (previous setting) | 0.4219 | 0.432 / 0.353 / 0.458 | 0.812 / 0.2270 | 6,932 ac | 0.1271 | 1,447 ac |
| ignore activity > 375 m inside | 0.4229 | 0.432 / 0.357 / 0.458 | 0.812 / 0.2281 | 6,850 ac | 0.1273 | 1,447 ac |
| ignore activity > 750 m inside | 0.4219 | 0.432 / 0.353 / 0.458 | 0.812 / 0.2271 | 6,928 ac | 0.1271 | 1,447 ac |
| 500 m radius | 0.4244 | 0.420 / 0.381 / 0.458 | 0.816 / 0.2297 | 6,382 ac | 0.1291 | 1,430 ac |
| 750 m radius | 0.4248 | 0.429 / 0.368 / 0.458 | 0.814 / 0.2297 | 6,638 ac | 0.1283 | 1,447 ac |
| growth-coincident detections only (**adopted**) | 0.4317 | 0.432 / 0.392 / 0.458 | 0.818 / 0.2339 | 6,434 ac | 0.1342 | 1,447 ac |
| growth-only + 375 m edge filter | 0.4320 | 0.432 / 0.394 / 0.458 | 0.818 / 0.2343 | 6,419 ac | 0.1342 | 1,447 ac |

- **Edge filters** (ignore activity deeper than 375 m or 750 m inside the burned area) hardly matter. Activity
  deeper than 1 km never reached the perimeter anyway, and the hot pixels of these fires are near the edge.
- **A 500 m or 750 m radius** lowers the error but costs Eaton growth skill (0.432 -> 0.420 at 500 m).
- **Counting a detection only where it coincides with growth** (its cell burned in the window, or lies outside
  the burned area) improves every measure, on both test sets, with no fire worse.
  - Gains: hindcast 0.4219 -> 0.4317, all from Madre (0.353 -> 0.392), the forecast started after the main run;
    pseudo-live total 0.812 -> 0.818, growth 0.2270 -> 0.2339, error 6,932 -> 6,434 ac.
  - The physical reading: a hot pixel on ground that burned more than 12 h earlier is burnout or smouldering inside
    the fire, not spread.
  - Adding the 375 m edge filter on top changes almost nothing (0.4320; 6,419 ac), so it stays off.

**Decision.**
- `FORECAST_ACTIVE_GROWTH_ONLY = True` is the operational setting (SPEC 8.5); the 1 km radius and the edge filter are
  unchanged.
- It does not change today's live forecasts. Henderson and Norte stay fully held. Cooley still has 15
  growth-coincident detections all around its edge, so 0 % is held by observation (plus 6 % for containment).
- **Small, actively burning fires remain an open question.** The archived small fires (Lidia, Camino) produce so
  few detections that 32 of 33 issue times on a 2-hourly schedule were quiet. The one active issue (Camino) grew
  1,696 ac in the forecast against 0 observed. Their over-prediction in quiet issues (mean growth error about
  1,450 ac against about 50 ac observed) most likely comes from spread from edges that crews had already stopped
  (both fires stayed under 400 ac). The model does not represent suppression; only the containment minimum (live)
  partly captures it.
- **31-member check** (5.1), re-run with the adopted rule: growth Sørensen 0.428 -> **0.438**. Eaton (0.438) and
  Palisades (0.467) are unchanged; Madre rises 0.355 -> 0.395; every lead improves (+12 h 0.340 -> 0.349, +72 h
  0.480 -> 0.490); median growth ratio 2.02 -> 1.85.
- The published historical hindcasts (5.2) were made before this switch and were not re-made, so that the bundles
  under test by the UI stay stable. Eaton and Palisades are unaffected; Madre's would improve.

## 7. Runtime (SPEC 8.5 target: < 5 min for 31 members × 72 h at M ≤ 512)

All runs used 10 worker processes on the 12-core M3 Pro, with no ×2 downsampling fallback triggered. Every run was
far under the 5-minute target:

| run | grid | members | runtime |
|---|---|---:|---:|
| Eaton hindcast | 512² at 45 m | 31 | 15.0 s |
| Madre hindcast | 512² at 98 m | 31 | 9.4 s |
| Palisades hindcast | 512² at 59 m | 31 | 12.0 s |
| Cooley GFS | 512² at 33 m | 31 | 11.2 s |
| Cooley ECMWF | 512² at 33 m | 51 | 19.0 s |
| Henderson GFS (inside the auto-build) | 512² at 43 m | 31 | 14.7 s |
| Lidia hindcast (API) | 272² at 29 m | 31 | 2.3 s |
| Henderson GFS, new start (live loop, Oct 17 20:49 PDT; perimeter fully held) | 512² at 43 m | 31 | 5.4 s |
| Norte GFS, new start (live loop; perimeter fully held) | 512² at 37 m | 31 | 4.6 s |
| Cooley GFS / ECMWF, new start (live loop / `POST /forecast`; re-made 21:19 PDT: 13.0 s / 16.8 s) | 512² at 33 m | 31 / 51 | 12.2 s / 23.1 s |

These runtimes include the weather member setup. With the earlier settings (multiplier 1, no hold or decay) the
same grids took 50–110 s, because more fire meant more front cells per step.

Each calibration grid point covers 8 starts × 72 h on the deterministic member and took 10–30 s. The 31-member
ensemble check of two candidate multipliers took 4.3 min.

## 8. Limitations

- **Three fires.** All are Southern/Central California and two are the same Santa Ana event. They are coastal
  chaparral and grass; there is no timber fire. The calibration (multiplier 0.5, 12 h decay) may not transfer to
  other fuel types or regimes.
- **No suppression, no structures, no spotting in the model.** The decaying multiplier and the held perimeter
  stand in for some of this statistically. Neighbourhood burning (Altadena, Pacific Palisades) is not modelled.
- **Hindcast weather is near-perfect** (stitched HRRR short-range forecasts). Live forecasts will do worse.
- **The truth has errors.** VIIRS bloat early on; perimeter timing; about 1.3 h median timing error.
- **Fuels are pre-fire LANDFIRE LF2024** for 2025 fires and LF2025 (seasonal) for live fires. Recent burn scars and
  fuel treatments may be missing.
- **The AOI edge.** Fire is not simulated beyond the modelled square, so burn probability near the edge is
  underestimated. Forecasts warn when members reach the edge.
- **Ensemble spread is from weather only.** Wind ×lognormal(0.25), direction ±20°, RH ±6 %, T ±1.5 °C for past fires;
  the real GFS or ECMWF members for live fires. Fuel and model uncertainty are not sampled, so the 10–90 %
  arrival range is too narrow.
- **Live start (section 6).**
  - A pass "saw no fire" only above its detection limit: smouldering or a fire under thick cloud can be missed.
    Swath-edge geometry is not checked.
  - The pass is looked up at the fire's centroid, so a very large fire can lie partly outside a granule.
  - A fully held perimeter means no modelled growth, not "the fire is out".
  - The containment minimum guesses where the contained lines are.
  - The 1 km activity radius makes every interior hot pixel of a small fire (< ~1,000 ac) mark the whole perimeter
    active, so actively burning small fires are still over-predicted (Cooley, 6.4).

## 9. Reproduce

```bash
cd backend
# calibration grid (deterministic member), operational structure, SPEC multipliers
uv run python -m fire3d.spread.validate hindcast 2025-eaton-fire-dbfa57:6,12,24 2025-madre-fire-01e7e8:24,48 \
    2025-palisades-fire-abfed7:6,12,24 --adjustments 0.25 0.35 0.5 0.75 1 1.5 2 --json rows.json
# ablations: --lfm table|drought, --hold/--no-hold, --decay-h 0, --wui, --spotting
# operational hindcasts (31 perturbed members, written into the bundle)
uv run python -m fire3d.cli hindcast 2025-eaton-fire-dbfa57 --start 2025-01-08T08:18:00Z --ensemble perturbed
# pseudo-live check of the live start (section 6.2; NASA CMR archive passes, nothing written to the bundles)
uv run python -m fire3d.spread.validate live-start 2025-eaton-fire-dbfa57 2025-palisades-fire-abfed7 \
    2025-madre-fire-01e7e8 2025-lidia-fire-83adc9 2025-camino-fire-c606c9 --every 6 --first 6 --latency 1 \
    --leads 12 24 48 --json live-start.json
```

## 10. Outside California (brief 3)

Section 10.1 was written and committed on 2026-10-23, before any hindcast of a fire outside California (protocol of
`docs/redesign/audit-3/validation.md` §4-§5, CONTRACT §14.4 and §14.12.10). Nothing in it is changed after the first
score outside California; later sections report the results against it.

### 10.1 Pre-registration (written before any score outside California)

**Fires.** The 12 fires of `docs/redesign/audit-3/validation.md` §3, two per region (BRIEF-3 round 2, item 3), by
their proposed ids. Regions are the WFIGS GACC of the incident record, with the Southern Area split into Southern
Plains (`SACC-SP`, TX and OK) and Southeast (`SACC-SE`). California (`OSCC`: Eaton, Madre, Palisades) is the
baseline, re-measured in this session; Rocky Mountain, Eastern and Northern California have no test fire.

**Starts (absolute UTC).** Label starts are the audit's times; for Horse Gulch, Greer and Rush (listed there as
"ignition + 6, 12, 24 h", Greer also 72 h) they are the WFIGS `FireDiscoveryDateTime` plus those offsets, written
out here. The ignition-relative secondary score uses WFIGS discovery + 6, 12 and 24 h for every fire, also written
out. No start depends on a built bundle's `ignition.t_ms`. Local times are in each fire's own zone (IANA zone of the
point of origin; Island Creek, Idaho, is on Pacific time; Arizona has no daylight time). The same data are in
`backend/scripts/validate_us_fires.py` (`FIRES`), which the runs read.

| # | fire (state, region) | WFIGS discovery (UTC) | label starts (UTC; local) | ignition + 6/12/24 h (UTC) |
|---|---|---|---|---|
| 1 | Emigrant (OR, NWCC) | 2025-08-24T19:30Z (Aug 24 12:30 PDT) | 2025-08-25T19:30Z (Aug 25 12:30 PDT)<br>2025-08-26T19:30Z (Aug 26 12:30 PDT)<br>2025-08-28T19:30Z (Aug 28 12:30 PDT) | 2025-08-25T01:30Z, 2025-08-25T07:30Z, 2025-08-25T19:30Z |
| 2 | Lower Sugarloaf (WA, NWCC) | 2025-09-01T16:21Z (Sep 01 09:21 PDT) | 2025-09-16T16:00Z (Sep 16 09:00 PDT)<br>2025-09-17T16:00Z (Sep 17 09:00 PDT)<br>2025-09-18T16:00Z (Sep 18 09:00 PDT) | 2025-09-01T22:21Z, 2025-09-02T04:21Z, 2025-09-02T16:21Z |
| 3 | Island Creek (ID, NRCC) | 2025-08-01T05:36Z (Jul 31 22:36 PDT) | 2025-08-19T06:00Z (Aug 18 23:00 PDT)<br>2025-08-20T06:00Z (Aug 19 23:00 PDT)<br>2025-08-21T06:00Z (Aug 20 23:00 PDT) | 2025-08-01T11:36Z, 2025-08-01T17:36Z, 2025-08-02T05:36Z |
| 4 | Horse Gulch (MT, NRCC) | 2024-07-09T19:32Z (Jul 09 13:32 MDT) | 2024-07-10T01:32Z (Jul 09 19:32 MDT)<br>2024-07-10T07:32Z (Jul 10 01:32 MDT)<br>2024-07-10T19:32Z (Jul 10 13:32 MDT) | 2024-07-10T01:32Z, 2024-07-10T07:32Z, 2024-07-10T19:32Z |
| 5 | France Canyon (UT, GBCC) | 2025-06-11T22:05Z (Jun 11 16:05 MDT) | 2025-06-16T22:00Z (Jun 16 16:00 MDT)<br>2025-06-18T22:00Z (Jun 18 16:00 MDT)<br>2025-06-20T22:00Z (Jun 20 16:00 MDT) | 2025-06-12T04:05Z, 2025-06-12T10:05Z, 2025-06-12T22:05Z |
| 6 | Cottonwood Peak (NV, GBCC) | 2025-08-16T02:02Z (Aug 15 19:02 PDT) | 2025-08-16T14:00Z (Aug 16 07:00 PDT)<br>2025-08-17T02:00Z (Aug 16 19:00 PDT)<br>2025-08-18T02:00Z (Aug 17 19:00 PDT)<br>2025-08-19T02:00Z (Aug 18 19:00 PDT) | 2025-08-16T08:02Z, 2025-08-16T14:02Z, 2025-08-17T02:02Z |
| 7 | Trout (NM, SWCC) | 2025-06-12T13:24Z (Jun 12 07:24 MDT) | 2025-06-13T13:30Z (Jun 13 07:30 MDT)<br>2025-06-14T13:30Z (Jun 14 07:30 MDT)<br>2025-06-15T13:30Z (Jun 15 07:30 MDT)<br>2025-06-17T13:30Z (Jun 17 07:30 MDT) | 2025-06-12T19:24Z, 2025-06-13T01:24Z, 2025-06-13T13:24Z |
| 8 | Greer (AZ, SWCC) | 2025-05-13T17:47:56Z (May 13 10:47 MST) | 2025-05-13T23:47:56Z (May 13 16:47 MST)<br>2025-05-14T05:47:56Z (May 13 22:47 MST)<br>2025-05-14T17:47:56Z (May 14 10:47 MST)<br>2025-05-16T17:47:56Z (May 16 10:47 MST) | 2025-05-13T23:47:56Z, 2025-05-14T05:47:56Z, 2025-05-14T17:47:56Z |
| 9 | Windy Deuce (TX, SACC-SP) | 2024-02-27T00:23:16Z (Feb 26 18:23 CST) | 2024-02-27T06:30Z (Feb 27 00:30 CST)<br>2024-02-27T12:30Z (Feb 27 06:30 CST)<br>2024-02-27T18:30Z (Feb 27 12:30 CST) | 2024-02-27T06:23:16Z, 2024-02-27T12:23:16Z, 2024-02-28T00:23:16Z |
| 10 | Table Rock (SC, SACC-SE) | 2025-03-22T13:26Z (Mar 22 09:26 EDT) | 2025-03-25T13:30Z (Mar 25 09:30 EDT)<br>2025-03-26T13:30Z (Mar 26 09:30 EDT)<br>2025-03-27T13:30Z (Mar 27 09:30 EDT) | 2025-03-22T19:26Z, 2025-03-23T01:26Z, 2025-03-23T13:26Z |
| 11 | Rush (OK, SACC-SP) | 2024-10-24T20:17Z (Oct 24 15:17 CDT) | 2024-10-25T02:17Z (Oct 24 21:17 CDT)<br>2024-10-25T08:17Z (Oct 25 03:17 CDT)<br>2024-10-25T20:17Z (Oct 25 15:17 CDT) | 2024-10-25T02:17Z, 2024-10-25T08:17Z, 2024-10-25T20:17Z |
| 12 | Black Cove (NC, SACC-SE) | 2025-03-19T19:00Z (Mar 19 15:00 EDT) | 2025-03-20T19:00Z (Mar 20 15:00 EDT)<br>2025-03-22T19:00Z (Mar 22 15:00 EDT)<br>2025-03-23T19:00Z (Mar 23 15:00 EDT) | 2025-03-20T01:00Z, 2025-03-20T07:00Z, 2025-03-20T19:00Z |

Windy Deuce's starts are moved to its first perimeter (65 % of the final area already burned, audit §3.1): it tests
the second day of a plains grass fire only. Rush's +6 h and +12 h starts begin before its first perimeter (46 %), so
their first leads are timed by VIIRS; Lower Sugarloaf's run (no perimeter from Sep 17 16:00 to Sep 21 17:48 UTC) is
timed by VIIRS at every lead.

**Scoring** (as docs/validation.md §2 and §5): operational settings (`config.FORECAST_*`, spread multiplier 0.5 with
the 12 h decay, held inactive perimeter, growth-coincident activity); leads 12, 24, 48 and 72 h, each scored only when
`start + lead` is before the bundle's `data_end_ms`; truth = the observed reconstruction. The label value is the
**31-member perturbed p50** growth Sørensen; the deterministic member is reported beside it. Per fire: the mean over
its scored leads. Per region: the **mean of the fire means** (`mean_of_fire_means`), with the pooled mean over all
leads, the per-lead means (`by_lead` "12"/"24"/"48"/"72"), the min-max range of the fire means, the median growth
ratio (forecast / observed growth) and the ignition-relative value (WFIGS discovery + 6/12/24 h, the same p50 metric,
never in the label). Status (CONTRACT §14.4): `tested` with >= 2 fires and >= 16 scored leads; otherwise `limited`
with at least 1 fire; `untested` with none. Pseudo-live checks (`validate live-start`) are reported where FIRMS and
NASA CMR allow, never in the label. Ablation, outside the label: the fires outside California re-run with
California's month table (`lfm_method` forced to `ca_month_table`), to show what GSI changed.

**Live fuel moisture outside California: the NFDRS 2016 Growing Season Index** (pre-registered method; CONTRACT
§14.12.10, audit V-R5).
- **Switch.** `summary.state`: `"CA"` keeps today's method exactly (the month table with the water-year drought
  adjustment, `lfm_method` `ca_month_table_drought`; `ca_month_table` when the bundle has no water-year total). Any
  other state uses GSI (`gsi_nfdrs2016`).
- **Method.** The Growing Season Index of Jolly, Nemani and Running (2005), *A generalized, bioclimatic index to
  predict foliar phenology in response to climate*, Global Change Biology 11: 619-632
  (doi:10.1111/j.1365-2486.2005.00930.x), as implemented for the US National Fire Danger Rating System 2016 in the
  US Forest Service Missoula Fire Sciences Laboratory's reference code NFDRS4 (`github.com/firelab/NFDRS4`,
  `lib/NFDRS4/src/livefuelmoisture.cpp`, its default parameters; read on 2026-10-23). For each local day D (the
  fire's IANA zone):
  - daily inputs: Tmin and Tmax = the minimum and maximum hourly 2 m temperature of D, RHmin = the minimum hourly 2 m
    relative humidity of D;
  - vapour pressure deficit VPD = es(Tmax) · (1 − max(RHmin, 5 %) / 100), es(T) = 610.7 · exp(17.38 · T / (239 + T))
    Pa (T in °C), NFDRS4's default (`CalcGSI`: maximum temperature and minimum RH);
  - day length: NFDRS4's `CalcDayl` (MT-CLIM) at the fire's latitude and the day of year (declination −0.4092797 ·
    cos((yday + 10.25) · 0.017214) rad; day length = 2 · acos(−tan(lat) · tan(decl)) · 13750.9871 s);
  - indicators, each linear between its limits and clamped to 0..1: iTmin = 0 at −2 °C .. 1 at 5 °C; iVPD = 1 at
    900 Pa .. 0 at 4100 Pa; iDayl = 0 at 36,000 s (10 h) .. 1 at 39,600 s (11 h); no precipitation indicator
    (NFDRS4 default `UseRTPrecip` false);
  - daily GSI = iTmin · iVPD · iDayl.
- **GSI at a forecast start t** = the mean of the daily GSI of the 21 local days before the day of t (NFDRS4's
  21-day moving average, `MAPeriod` 21), all 21 days required; scaled by `MaxGSI` = 1.0 (NFDRS4 default) and clamped to
  0..1.
- **Herb and woody mapping** (NFDRS4 defaults, `SetLFMParameters`, green-up threshold 0.5): below 0.5, herb 30 %
  and woody 60 %; at or above it, linear to the maximum at GSI 1: herb = 30 + (GSI − 0.5) / 0.5 · 220 % (250 % at 1),
  woody = 60 + (GSI − 0.5) / 0.5 · 140 % (200 % at 1). Passed to the model as fractions (herb 0.30-2.50, woody
  0.60-2.00), held constant over a forecast, as the California values are. Simplifications, stated: the herb is
  treated as perennial (NFDRS4's annual-curing state, which needs a full year of daily values, is not used) and there is
  no snow-day flag. The 2016 overview by the Eastern Area (gacc.nifc.gov/eacc, "Overview of NFDRS2016") gives the
  woody minimum as 50 %; the reference code's 60 % is used.
- **Inputs** (start − 28 d to start, and on to the end of the bundle's weather window, so every hindcast start inside
  the window has its 21 days): hourly `temperature_2m` and `relative_humidity_2m` at the fire point, local days
  (`timezone` = the fire's zone), plus daily `daylight_duration` stored for audit (the method uses `CalcDayl`).
  - **historical builds:** the Open-Meteo archive host (`archive-api.open-meteo.com/v1/archive`, `models=era5`: ERA5
    reanalysis, Hersbach et al. 2020, Copernicus Climate Change Service), one request per bundle (about 3-6 weighted
    call units), ending at least 6 days before the request (`ERA5_DELAY_DAYS`);
  - **live builds:** the same hourly variables from the forecast host (`api.open-meteo.com/v1/forecast`) with
    `past_days=28` (ERA5 lags about 6 days), re-fetched on each live weather refresh.
  - The series is stored in the bundle as the backend-only `sim/lfm_gsi.json` (`method: "gsi_nfdrs2016"`, `source`,
    the daily values); hindcasts never fetch.
- **Never silent.** A bundle outside California without the series (request refused or failed, or fewer than 21 days
  before a start) uses California's values with the warning "Live fuel moisture outside California uses California's
  seasonal values until a regional method is tested; experimental." and the moisture note "Live fuel moisture:
  California's seasonal values (GSI series unavailable); experimental." (`lfm_method` `ca_month_table` or
  `ca_month_table_drought`). With `--require-hrrr` (every validation build) a refused or failed GSI series fails the
  build. California's (herb, woody) values and notes are unchanged (unit test on Eaton, Palisades, Madre and
  `fixture-demo`), and the California hindcasts are re-run after the GSI code lands (they must equal the baseline:
  |Δ| < 0.001 per fire and over the 32 leads).
- No GSI parameter is fitted to these fires.

**Bundle checks before any score** (protocol step 2, recorded per fire): observed final area / WFIGS `IncidentSize`
within 0.8-1.25; perimeters used and how many fall in the growth window; the fire inside the AOI; `fuels_edition` as
listed in the audit (LF2023 for Horse Gulch and Windy Deuce, LF2024 for the other ten) with no fallback note; the UTM
zone listed there; weather source `open-meteo:historical-forecast:gfs_hrrr` with 0 ERA5 hours (any GFS fill hours
are reported with where they fall relative to the scored windows); no observed pixel more than 2 km outside the
fire's own final WFIGS perimeter; `sim/lfm_gsi.json` present with `method` `gsi_nfdrs2016`.

**Replacement rule.** A fire is replaced only when it fails a bundle check, before any of its scores exist, by the
next reserve of the same region in the audit's order (Southwest: South Fork; Great Basin: Monroe Canyon, then
Forsyth; Northwest: Pioneer; Northern Rockies: Daly); the failed check is recorded (`replaced` in
`backend/fire3d/data/regional_accuracy.json`). The Southern Plains has no reserve: if Windy Deuce or Rush fails, that
region is `limited` (or `untested`). A weather quota refusal is not a failed check: the build waits and is retried.
Nothing else justifies a replacement, and no fire is dropped after it has a score.

**No tuning to these fires.** Any change tried after the first score outside California is reported with its
values on every fire and on California's 32 leads; a change is adopted only if it also improves the California
result, and then every region whose fires informed it is marked `in_sample: true`.

### 10.2 California baseline (re-measured 2026-10-23)

Madre (`2025-madre-fire-01e7e8`) was rebuilt here with `--require-hrrr` (06:36-06:43 UTC, 394 s, after a weather
probe said `overall ok`): 225 h of HRRR, 0 GFS-filled and 0 ERA5 hours; observed final area 81,938 ac (CAL FIRE
80,779 ac, ratio 1.014, the same as section 1); water-year precipitation 207 mm in `sim/antecedent.json` (section
3.1's value); LANDFIRE LF2024; UTM 11; 7 WFIGS perimeters. Eaton and Palisades are the bundles rebuilt earlier in this
session (full HRRR, LF2024).

The 31-member p50 hindcasts at section 5.1's starts (Eaton and Palisades ignition + 6/12/24 h: Jan 8 08:18, 14:18 and
Jan 9 02:18 UTC = Jan 8 00:18, 06:18 and 18:18 PST; Jan 8 00:20, 06:20 and 18:20 UTC = Jan 7 16:20, 22:20 and Jan 8
10:20 PST; Madre ignition + 24/48 h: Jul 3 and Jul 4 20:07 UTC = 13:07 PDT), operational settings, multiplier 0.5:

| run | Eaton | Madre | Palisades | 32 leads | +12 h | +24 h | +48 h | +72 h | growth ratio (median) | total Sørensen |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| section 5.1 (2026-10-18, the user's local bundles) | 0.438 | 0.395 | 0.467 | 0.438 | 0.349 | 0.432 | 0.481 | 0.490 | 1.85 | – |
| **step 1**: brief-3 wave-1 code before GSI (commit 29f0e2d, a separate worktree on the same bundles) | 0.4379 | 0.3949 | 0.4670 | 0.4381 | 0.3491 | 0.4319 | 0.4809 | 0.4904 | 1.85 | 0.827 |
| **step 2**: with the GSI code (commit 3283526 and later) | 0.4379 | 0.3949 | 0.4670 | 0.4381 | 0.3491 | 0.4319 | 0.4809 | 0.4904 | 1.85 | 0.827 |

- Step 1 equals section 5.1 to the third decimal: brief 3's changes (perimeters by IRWIN id outside California,
  issuer text, fire-local time zones, LANDFIRE editions, weather quota handling) did not change California's scores.
- Step 2 equals step 1 exactly on every one of the 32 leads (largest difference 0.0 in growth and total Sørensen; the
  seeds are fixed). California's live fuel moisture is unchanged by the GSI code: herb 30 %, woody 70 % at every start
  (Eaton and Palisades: the January drought adjustment with 12 mm and 9 mm of water-year rain; Madre: the July row,
  207 mm), `lfm_method` `ca_month_table_drought`; `backend/tests/test_gsi.py` checks the values and notes against a
  frozen copy of the pre-GSI code on the three bundles and `fixture-demo`.
- These scores stay **in-sample**: the multiplier and its decay were fitted on these three fires (section 3.3).

### 10.3 Builds and bundle checks (protocol step 2)

Thirteen bundles were used: Madre (section 10.2) and the 12 test fires, each built here with `fire3d.cli build <id>
--require-hrrr` (`--force` where a bundle existed), one at a time, each after a weather probe
(`fire3d.cli weather-probe`). Open-Meteo's hosts on this shared cloud address answered only intermittently all
morning (a host would refuse with the daily-limit answer, or not answer, and work again minutes later). So the build
queue started a build when at least one of the two hosts a historical build uses (historical-forecast for HRRR,
archive for ERA5) answered, instead of waiting for `overall ok`; `--require-hrrr` then made a build **fail** rather
than fill: any hour without HRRR/GFS, or a refused GSI request, stopped it, and the queue retried later from the cache
(successful answers are cached for 30 days, so each attempt kept what it had fetched). Every bundle below therefore
has 0 ERA5-filled hours, 0 GFS-filled hours and an ERA5 GSI series. All 12 fires pass every check; **no fire was
replaced**. Times UTC.

| # | fire | final build (UTC end, duration) | weather probe before it | AOI, fire grid | weather hours: HRRR / GFS fill / ERA5 | observed / WFIGS ac (ratio) | perimeters (in growth) | fuels, UTM | cells > 2 km outside the final perimeter | GSI series (ERA5 days) | burned-area fuel groups |
|---|---|---|---|---|---|---|---|---|---:|---|---|
| 1 | Emigrant | 08:16:39Z (539 s) | 08:07:40Z: hist.-forecast ok, archive ok, forecast ok | 37 km, 72.3 m | 424 / 0 / 0 | 33,129 / 33,500 (0.989) | 11 (8) | LF2024, 10 | 0 | 2025-07-24..2025-09-08 (47) | timber |
| 2 | Lower Sugarloaf | 08:22:48Z (364 s) | 08:16:44Z: hist.-forecast ok, archive ok, forecast ok | 42 km, 82.0 m | 967 / 0 / 0 | 43,216 / 42,958 (1.006) | 36 (29) | LF2024, 10 | 0 | 2025-08-01..2025-10-08 (69) | timber |
| 3 | Island Creek | 07:03:21Z (1099 s) | 06:45:01Z: hist.-forecast ok, archive no answer, forecast ok | 28 km, 54.7 m | 937 / 0 / 0 | 15,068 / 14,943 (1.008) | 23 (19) | LF2024, 11 | 0 | 2025-06-30..2025-09-05 (68) | timber |
| 4 | Horse Gulch | 08:57:37Z (52 s) | 08:56:45Z: hist.-forecast ok, archive ok, forecast ok | 20 km, 39.1 m | 346 / 0 / 0 | 15,321 / 15,167 (1.01) | 20 (12) | LF2023, 12 | 0 | 2024-06-08..2024-07-20 (43) | grass, shrub |
| 5 | France Canyon | 07:26:06Z (1346 s) | 07:03:39Z: hist.-forecast no answer, archive ok, forecast ok | 26 km, 50.8 m | 529 / 0 / 0 | 35,251 / 34,943 (1.009) | 16 (11) | LF2024, 12 | 0 | 2025-05-11..2025-06-30 (51) | grass, timber |
| 6 | Cottonwood Peak | 08:29:59Z (427 s) | 08:22:52Z: hist.-forecast ok, archive ok, forecast ok | 52 km, 101.6 m | 332 / 0 / 0 | 134,127 / 132,603 (1.011) | 11 (8) | LF2024, 11 | 0 | 2025-07-15..2025-08-26 (43) | grass, shrub |
| 7 | Trout | 08:33:33Z (196 s) | 08:30:17Z: hist.-forecast ok, archive ok, forecast no answer | 33 km, 64.5 m | 363 / 0 / 0 | 47,685 / 47,294 (1.008) | 16 (12) | LF2024, 12 | 0 | 2025-05-12..2025-06-24 (44) | grass, shrub, timber |
| 8 | Greer | 08:34:52Z (74 s) | 08:33:37Z: hist.-forecast ok, archive ok, forecast ok | 22 km, 43.0 m | 270 / 0 / 0 | 21,045 / 20,308 (1.036) | 11 (7) | LF2024, 12 | 0 | 2025-04-12..2025-05-21 (40) | grass |
| 9 | Windy Deuce | 08:07:36Z (145 s) | 08:05:11Z: hist.-forecast no answer, archive ok, forecast no answer | 60 km, 117.2 m | 214 / 0 / 0 | 149,031 / 143,302 (1.04) | 9 (1) | LF2023, 14 | 0 | 2024-01-26..2024-03-03 (38) | grass |
| 10 | Table Rock | 08:37:30Z (135 s) | 08:35:16Z: hist.-forecast ok, archive no answer, forecast ok | 20 km, 39.1 m | 341 / 0 / 0 | 13,912 / 13,845 (1.005) | 15 (8) | LF2024, 17 | 0 | 2025-02-19..2025-04-02 (43) | timber |
| 11 | Rush | 08:02:59Z (99 s) | 08:01:20Z: hist.-forecast ok, archive no answer, forecast ok | 18 km, 35.2 m | 230 / 0 / 0 | 12,592 / 12,403 (1.015) | 5 (3) | LF2024, 14 | 0 | 2024-09-23..2024-10-31 (39) | grass |
| 12 | Black Cove | 06:29:03Z (30 s) | 06:28:33Z: hist.-forecast ok, archive ok, forecast no answer | 20 km, 39.1 m | 339 / 0 / 0 | 3,772 / 3,502 (1.077) | 17 (6) | LF2024, 17 | 0 | 2025-02-16..2025-03-30 (43) | timber |

Notes on the builds:
- **Earlier attempts** (all logged in the progress file): a Black Cove build at 04:20-04:22 with the code before GSI
  (cache warm-up only, replaced); Emigrant 04:39 (historical-forecast refused part-way), Black Cove 04:40 (the GSI
  request refused 16 s after an ok probe) and Emigrant 06:30 (one HRRR chunk answered with a body that was not JSON)
  failed and were retried; Lower Sugarloaf, Cottonwood Peak, Trout, Greer, Windy Deuce, Emigrant and Table Rock were
  first built before the AOI bug fix of section 10.9 and rebuilt after it (the table shows the final builds).
- **Horse Gulch** was rebuilt at 08:01 by another session on this machine (with the GSI code); for a clean record it
  was rebuilt here at 08:56-08:57 into a scratch data directory and moved into place with two renames, so the bundle
  other sessions were reading never showed an error state. Both builds passed every check.
- **Perimeters in the growth window** (to the time the observed area reached 95 % of its final area): Windy Deuce has
  1, Rush 3 of 5 (its first two starts come before its first perimeter at Oct 25 12:09). Lower Sugarloaf's run has
  perimeters on Sep 17, 18 and 19, then none until Sep 22 20:15, so its later leads are timed by VIIRS (the audit saw
  a longer gap; the perimeter reader dates re-edited polygons by their edit time).
- **Windy Deuce differs from the audit's reading.** The audit timed a 93,622 ac WFIGS polygon at Feb 27 06:23 UTC
  (65 % of the final area) and moved the starts there. The perimeter reader (`sources/perimeters.py`) dates that
  polygon by its later edit time (Feb 28 18:50, "re-edited polygon"), so the bundle's only perimeter in the run is
  7,532 ac at Feb 27 06:23 and the run is timed by 8 VIIRS passes: at the first start (06:30) the reconstruction
  holds 8,786 ac. The starts therefore fall early in the run, not on its second day. Which timing is right cannot be
  settled from WFIGS alone; it is reported here, not changed after the scores.
- **Fuel groups** are the LANDFIRE FBFM40 families of each fire's final burned area with at least 25 % of it (grass,
  shrub, timber; grass-shrub models count half to each).

### 10.4 Results per fire (the label run: 31-member p50 at the pre-registered starts)

Growth Sørensen compares only the area that burned after each start (0 = no overlap, 1 = perfect); it is the headline metric of sections 2-5. *Deterministic* is the unperturbed member at the same starts; *ignition + 6/12/24 h* is the fixed California rule from the WFIGS discovery time (secondary, never in the label); *California table* is the GSI ablation of section 10.6 (deterministic). The growth ratio is forecast / observed new growth (1 = right amount; below 1 = too little). GSI is the 21-day mean index at each label start, with the resulting herb / woody live fuel moisture.

| # | fire (state, region; zone) | starts / scored leads | p50 growth Sørensen | deterministic | ignition + 6/12/24 h (p50) | California table (det.) | total Sørensen (p50) | obs / fc growth, mean ac | growth ratio (median) | GSI at the starts | herb / woody |
|---|---|---|---:|---:|---:|---:|---:|---|---:|---|---|
| 1 | Emigrant (OR, NWCC; America/Los_Angeles) | 3 / 12 | **0.279** | 0.277 | 0.135 | 0.270 | 0.790 | 7,437 / 2,039 | 0.20 | 0.48, 0.47, 0.45 | 30%/60%, 30%/60%, 30%/60% |
| 2 | Lower Sugarloaf (WA, NWCC; America/Los_Angeles) | 3 / 12 | **0.231** | 0.228 | 0.198 | 0.264 | 0.949 | 2,826 / 981 | 0.40 | 0.61, 0.63, 0.64 | 77%/90%, 88%/97%, 90%/98% |
| 3 | Island Creek (ID, NRCC; America/Los_Angeles) | 3 / 12 | **0.189** | 0.188 | 0.134 | 0.205 | 0.774 | 3,565 / 1,270 | 0.63 | 0.59, 0.59, 0.61 | 68%/84%, 71%/86%, 79%/91% |
| 4 | Horse Gulch (MT, NRCC; America/Denver) | 3 / 12 | **0.492** | 0.490 | 0.492 | 0.495 | 0.643 | 6,529 / 9,460 | 1.78 | 0.59, 0.55, 0.55 | 70%/86%, 54%/75%, 54%/75% |
| 5 | France Canyon (UT, GBCC; America/Denver) | 3 / 12 | **0.218** | 0.219 | 0.246 | 0.209 | 0.815 | 6,216 / 3,796 | 1.03 | 0.57, 0.57, 0.55 | 60%/79%, 60%/79%, 52%/74% |
| 6 | Cottonwood Peak (NV, GBCC; America/Los_Angeles) | 4 / 16 | **0.275** | 0.274 | 0.180 | 0.261 | 0.620 | 40,821 / 27,567 | 0.83 | 0.18, 0.18, 0.18, 0.18 | 30%/60%, 30%/60%, 30%/60%, 30%/60% |
| 7 | Trout (NM, SWCC; America/Denver) | 4 / 16 | **0.355** | 0.348 | 0.207 | 0.318 | 0.731 | 11,249 / 11,100 | 1.39 | 0.25, 0.24, 0.23, 0.19 | 30%/60%, 30%/60%, 30%/60%, 30%/60% |
| 8 | Greer (AZ, SWCC; America/Phoenix) | 4 / 16 | **0.348** | 0.347 | 0.400 | 0.396 | 0.652 | 6,563 / 20,045 | 3.76 | 0.38, 0.38, 0.40, 0.40 | 30%/60%, 30%/60%, 30%/60%, 30%/60% |
| 9 | Windy Deuce (TX, SACC-SP; America/Chicago) | 3 / 12 | **0.299** | 0.302 | 0.304 | 0.021 | 0.456 | 101,472 / 56,228 | 0.59 | 0.16, 0.16, 0.16 | 30%/60%, 30%/60%, 30%/60% |
| 10 | Table Rock (SC, SACC-SE; America/New_York) | 3 / 12 | **0.212** | 0.208 | 0.170 | 0.208 | 0.792 | 4,016 / 786 | 0.22 | 0.62, 0.62, 0.61 | 82%/93%, 84%/94%, 79%/91% |
| 11 | Rush (OK, SACC-SP; America/Chicago) | 3 / 12 | **0.490** | 0.486 | 0.490 | 0.486 | 0.655 | 6,819 / 7,953 | 0.90 | 0.36, 0.36, 0.36 | 30%/60%, 30%/60%, 30%/60% |
| 12 | Black Cove (NC, SACC-SE; America/New_York) | 3 / 12 | **0.174** | 0.173 | 0.111 | 0.176 | 0.853 | 701 / 273 | 0.46 | 0.59, 0.59, 0.58 | 70%/86%, 68%/84%, 66%/83% |

Reading these:
- **Outside California the model usually forecasts too little new growth**: the median growth ratio is below 1 for
  8 of the 12 fires (Emigrant, Lower Sugarloaf, Island Creek, Cottonwood Peak, Windy Deuce, Table Rock, Rush, Black Cove). In California it forecasts too much (1.85×, section 5.1). The
  settings were fitted on three Southern California fires: the spread multiplier starts at 0.5 and falls to 0.05 by
  +72 h, and quiet perimeter is held. Fires here that ran again after a quiet spell (Island Creek's run after an
  18-day smoulder; Emigrant's and Lower Sugarloaf's later runs) are exactly the case section 3.3 warns about: a renewed
  run days after the start is under-predicted.
- The exceptions are the wind-driven runs in cured or curing grass and timber: Greer (gusts to 108 km/h, ratio 3.8),
  Horse Gulch (1.8) and Trout (1.4) grew too much, as California's fires do; France Canyon was about right (1.0).
  Horse Gulch and Rush, two-day runs scored from their first hours, have the best scores (0.49).
- The lowest scores are the two Appalachian hardwood-litter fires (Black Cove 0.17, Table Rock 0.21), where the
  model forecast about a fifth to a half of the real growth (growth ratio 0.46 and 0.22), and Island Creek's run
  after a quiet spell (0.19).
- The 31 weather members barely move the median: the p50 and the deterministic member differ by at most
  0.006 on any fire.
- Starting from the WFIGS discovery time (ignition + 6/12/24 h) scores lower than the label starts on most fires, as
  expected: the first hours are hard and are timed by satellites only.

All scored leads (label run; *burned at the start* is the observed area at the start, which the forecast starts from):

| fire | start (UTC; local) | burned at the start (ac) | lead (h) | observed growth (ac) | forecast growth p50 (ac) | growth Sørensen | total Sørensen |
|---|---|---:|---:|---:|---:|---:|---:|
| Emigrant | 2025-08-25T19:30Z (Aug 25 12:30 PDT) | 5,832 | 12 | 10,156 | 1,581 | 0.10 | 0.55 |
| Emigrant | 2025-08-25T19:30Z (Aug 25 12:30 PDT) | 5,832 | 24 | 12,585 | 2,181 | 0.18 | 0.54 |
| Emigrant | 2025-08-25T19:30Z (Aug 25 12:30 PDT) | 5,832 | 48 | 14,350 | 2,734 | 0.26 | 0.56 |
| Emigrant | 2025-08-25T19:30Z (Aug 25 12:30 PDT) | 5,832 | 72 | 16,430 | 3,082 | 0.27 | 0.54 |
| Emigrant | 2025-08-26T19:30Z (Aug 26 12:30 PDT) | 18,416 | 12 | 578 | 1,710 | 0.26 | 0.96 |
| Emigrant | 2025-08-26T19:30Z (Aug 26 12:30 PDT) | 18,416 | 24 | 1,765 | 2,378 | 0.41 | 0.94 |
| Emigrant | 2025-08-26T19:30Z (Aug 26 12:30 PDT) | 18,416 | 48 | 3,846 | 3,017 | 0.41 | 0.91 |
| Emigrant | 2025-08-26T19:30Z (Aug 26 12:30 PDT) | 18,416 | 72 | 7,732 | 3,455 | 0.35 | 0.85 |
| Emigrant | 2025-08-28T19:30Z (Aug 28 12:30 PDT) | 22,262 | 12 | 3,091 | 672 | 0.28 | 0.94 |
| Emigrant | 2025-08-28T19:30Z (Aug 28 12:30 PDT) | 22,262 | 24 | 3,887 | 977 | 0.31 | 0.93 |
| Emigrant | 2025-08-28T19:30Z (Aug 28 12:30 PDT) | 22,262 | 48 | 7,259 | 1,254 | 0.24 | 0.88 |
| Emigrant | 2025-08-28T19:30Z (Aug 28 12:30 PDT) | 22,262 | 72 | 7,571 | 1,432 | 0.26 | 0.88 |
| Lower Sugarloaf | 2025-09-16T16:00Z (Sep 16 09:00 PDT) | 24,975 | 12 | 2,599 | 552 | 0.10 | 0.95 |
| Lower Sugarloaf | 2025-09-16T16:00Z (Sep 16 09:00 PDT) | 24,975 | 24 | 2,868 | 748 | 0.16 | 0.94 |
| Lower Sugarloaf | 2025-09-16T16:00Z (Sep 16 09:00 PDT) | 24,975 | 48 | 4,222 | 950 | 0.22 | 0.93 |
| Lower Sugarloaf | 2025-09-16T16:00Z (Sep 16 09:00 PDT) | 24,975 | 72 | 5,258 | 1,056 | 0.20 | 0.91 |
| Lower Sugarloaf | 2025-09-17T16:00Z (Sep 17 09:00 PDT) | 27,844 | 12 | 1,147 | 579 | 0.32 | 0.98 |
| Lower Sugarloaf | 2025-09-17T16:00Z (Sep 17 09:00 PDT) | 27,844 | 24 | 1,354 | 728 | 0.33 | 0.98 |
| Lower Sugarloaf | 2025-09-17T16:00Z (Sep 17 09:00 PDT) | 27,844 | 48 | 2,389 | 878 | 0.38 | 0.97 |
| Lower Sugarloaf | 2025-09-17T16:00Z (Sep 17 09:00 PDT) | 27,844 | 72 | 4,746 | 999 | 0.26 | 0.93 |
| Lower Sugarloaf | 2025-09-18T16:00Z (Sep 18 09:00 PDT) | 29,197 | 12 | 640 | 820 | 0.22 | 0.98 |
| Lower Sugarloaf | 2025-09-18T16:00Z (Sep 18 09:00 PDT) | 29,197 | 24 | 1,036 | 1,131 | 0.26 | 0.97 |
| Lower Sugarloaf | 2025-09-18T16:00Z (Sep 18 09:00 PDT) | 29,197 | 48 | 3,392 | 1,518 | 0.17 | 0.94 |
| Lower Sugarloaf | 2025-09-18T16:00Z (Sep 18 09:00 PDT) | 29,197 | 72 | 4,263 | 1,808 | 0.16 | 0.92 |
| Island Creek | 2025-08-19T06:00Z (Aug 18 23:00 PDT) | 4,334 | 12 | 67 | 329 | 0.06 | 0.96 |
| Island Creek | 2025-08-19T06:00Z (Aug 18 23:00 PDT) | 4,334 | 24 | 622 | 475 | 0.04 | 0.89 |
| Island Creek | 2025-08-19T06:00Z (Aug 18 23:00 PDT) | 4,334 | 48 | 4,963 | 615 | 0.01 | 0.61 |
| Island Creek | 2025-08-19T06:00Z (Aug 18 23:00 PDT) | 4,334 | 72 | 6,680 | 708 | 0.01 | 0.55 |
| Island Creek | 2025-08-20T06:00Z (Aug 19 23:00 PDT) | 4,957 | 12 | 1,042 | 647 | 0.17 | 0.88 |
| Island Creek | 2025-08-20T06:00Z (Aug 19 23:00 PDT) | 4,957 | 24 | 4,341 | 1,024 | 0.14 | 0.70 |
| Island Creek | 2025-08-20T06:00Z (Aug 19 23:00 PDT) | 4,957 | 48 | 6,058 | 1,321 | 0.14 | 0.63 |
| Island Creek | 2025-08-20T06:00Z (Aug 19 23:00 PDT) | 4,957 | 72 | 8,214 | 1,551 | 0.13 | 0.57 |
| Island Creek | 2025-08-21T06:00Z (Aug 20 23:00 PDT) | 9,298 | 12 | 1,122 | 1,383 | 0.41 | 0.93 |
| Island Creek | 2025-08-21T06:00Z (Aug 20 23:00 PDT) | 9,298 | 24 | 1,717 | 1,937 | 0.41 | 0.90 |
| Island Creek | 2025-08-21T06:00Z (Aug 20 23:00 PDT) | 9,298 | 48 | 3,872 | 2,444 | 0.35 | 0.84 |
| Island Creek | 2025-08-21T06:00Z (Aug 20 23:00 PDT) | 9,298 | 72 | 4,079 | 2,804 | 0.38 | 0.83 |
| Horse Gulch | 2024-07-10T01:32Z (Jul 09 19:32 MDT) | 702 | 12 | 3,981 | 2,233 | 0.35 | 0.47 |
| Horse Gulch | 2024-07-10T01:32Z (Jul 09 19:32 MDT) | 702 | 24 | 4,977 | 3,496 | 0.55 | 0.62 |
| Horse Gulch | 2024-07-10T01:32Z (Jul 09 19:32 MDT) | 702 | 48 | 11,259 | 4,288 | 0.51 | 0.55 |
| Horse Gulch | 2024-07-10T01:32Z (Jul 09 19:32 MDT) | 702 | 72 | 12,162 | 4,882 | 0.52 | 0.56 |
| Horse Gulch | 2024-07-10T07:32Z (Jul 10 01:32 MDT) | 4,013 | 12 | 1,106 | 4,708 | 0.21 | 0.67 |
| Horse Gulch | 2024-07-10T07:32Z (Jul 10 01:32 MDT) | 4,013 | 24 | 3,849 | 8,652 | 0.43 | 0.65 |
| Horse Gulch | 2024-07-10T07:32Z (Jul 10 01:32 MDT) | 4,013 | 48 | 8,285 | 10,404 | 0.71 | 0.79 |
| Horse Gulch | 2024-07-10T07:32Z (Jul 10 01:32 MDT) | 4,013 | 72 | 8,852 | 11,708 | 0.72 | 0.80 |
| Horse Gulch | 2024-07-10T19:32Z (Jul 10 13:32 MDT) | 5,119 | 12 | 2,743 | 12,472 | 0.34 | 0.61 |
| Horse Gulch | 2024-07-10T19:32Z (Jul 10 13:32 MDT) | 5,119 | 24 | 5,609 | 14,772 | 0.48 | 0.65 |
| Horse Gulch | 2024-07-10T19:32Z (Jul 10 13:32 MDT) | 5,119 | 48 | 7,699 | 17,203 | 0.55 | 0.68 |
| Horse Gulch | 2024-07-10T19:32Z (Jul 10 13:32 MDT) | 5,119 | 72 | 7,824 | 18,706 | 0.54 | 0.67 |
| France Canyon | 2025-06-16T22:00Z (Jun 16 16:00 MDT) | 9,840 | 12 | 1,547 | 3,335 | 0.24 | 0.85 |
| France Canyon | 2025-06-16T22:00Z (Jun 16 16:00 MDT) | 9,840 | 24 | 2,508 | 4,514 | 0.24 | 0.80 |
| France Canyon | 2025-06-16T22:00Z (Jun 16 16:00 MDT) | 9,840 | 48 | 3,286 | 5,484 | 0.26 | 0.77 |
| France Canyon | 2025-06-16T22:00Z (Jun 16 16:00 MDT) | 9,840 | 72 | 3,883 | 6,209 | 0.36 | 0.78 |
| France Canyon | 2025-06-18T22:00Z (Jun 18 16:00 MDT) | 13,125 | 12 | 43 | 608 | 0.09 | 0.98 |
| France Canyon | 2025-06-18T22:00Z (Jun 18 16:00 MDT) | 13,125 | 24 | 597 | 871 | 0.04 | 0.95 |
| France Canyon | 2025-06-18T22:00Z (Jun 18 16:00 MDT) | 13,125 | 48 | 5,813 | 1,176 | 0.01 | 0.79 |
| France Canyon | 2025-06-18T22:00Z (Jun 18 16:00 MDT) | 13,125 | 72 | 14,582 | 1,427 | 0.00 | 0.62 |
| France Canyon | 2025-06-20T22:00Z (Jun 20 16:00 MDT) | 18,939 | 12 | 6,469 | 3,433 | 0.28 | 0.85 |
| France Canyon | 2025-06-20T22:00Z (Jun 20 16:00 MDT) | 18,939 | 24 | 8,768 | 5,213 | 0.38 | 0.83 |
| France Canyon | 2025-06-20T22:00Z (Jun 20 16:00 MDT) | 18,939 | 48 | 13,223 | 6,328 | 0.36 | 0.78 |
| France Canyon | 2025-06-20T22:00Z (Jun 20 16:00 MDT) | 18,939 | 72 | 13,870 | 6,952 | 0.36 | 0.77 |
| Cottonwood Peak | 2025-08-16T14:00Z (Aug 16 07:00 PDT) | 5,098 | 12 | 19,802 | 8,814 | 0.23 | 0.43 |
| Cottonwood Peak | 2025-08-16T14:00Z (Aug 16 07:00 PDT) | 5,098 | 24 | 29,725 | 12,171 | 0.21 | 0.36 |
| Cottonwood Peak | 2025-08-16T14:00Z (Aug 16 07:00 PDT) | 5,098 | 48 | 54,057 | 14,184 | 0.17 | 0.28 |
| Cottonwood Peak | 2025-08-16T14:00Z (Aug 16 07:00 PDT) | 5,098 | 72 | 85,968 | 16,848 | 0.13 | 0.21 |
| Cottonwood Peak | 2025-08-17T02:00Z (Aug 16 19:00 PDT) | 24,900 | 12 | 9,923 | 15,283 | 0.14 | 0.71 |
| Cottonwood Peak | 2025-08-17T02:00Z (Aug 16 19:00 PDT) | 24,900 | 24 | 26,164 | 21,059 | 0.16 | 0.59 |
| Cottonwood Peak | 2025-08-17T02:00Z (Aug 16 19:00 PDT) | 24,900 | 48 | 59,060 | 30,041 | 0.26 | 0.52 |
| Cottonwood Peak | 2025-08-17T02:00Z (Aug 16 19:00 PDT) | 24,900 | 72 | 85,002 | 36,655 | 0.29 | 0.50 |
| Cottonwood Peak | 2025-08-18T02:00Z (Aug 17 19:00 PDT) | 51,064 | 12 | 8,090 | 20,019 | 0.12 | 0.81 |
| Cottonwood Peak | 2025-08-18T02:00Z (Aug 17 19:00 PDT) | 51,064 | 24 | 32,896 | 43,204 | 0.30 | 0.70 |
| Cottonwood Peak | 2025-08-18T02:00Z (Aug 17 19:00 PDT) | 51,064 | 48 | 58,838 | 58,094 | 0.40 | 0.68 |
| Cottonwood Peak | 2025-08-18T02:00Z (Aug 17 19:00 PDT) | 51,064 | 72 | 70,395 | 65,611 | 0.43 | 0.67 |
| Cottonwood Peak | 2025-08-19T02:00Z (Aug 18 19:00 PDT) | 83,960 | 12 | 7,106 | 9,668 | 0.31 | 0.94 |
| Cottonwood Peak | 2025-08-19T02:00Z (Aug 18 19:00 PDT) | 83,960 | 24 | 25,942 | 23,174 | 0.41 | 0.87 |
| Cottonwood Peak | 2025-08-19T02:00Z (Aug 18 19:00 PDT) | 83,960 | 48 | 37,499 | 30,729 | 0.43 | 0.83 |
| Cottonwood Peak | 2025-08-19T02:00Z (Aug 18 19:00 PDT) | 83,960 | 72 | 42,671 | 35,524 | 0.43 | 0.82 |
| Trout | 2025-06-13T13:30Z (Jun 13 07:30 MDT) | 6,729 | 12 | 2,307 | 4,629 | 0.20 | 0.73 |
| Trout | 2025-06-13T13:30Z (Jun 13 07:30 MDT) | 6,729 | 24 | 4,019 | 6,309 | 0.23 | 0.67 |
| Trout | 2025-06-13T13:30Z (Jun 13 07:30 MDT) | 6,729 | 48 | 13,924 | 8,262 | 0.26 | 0.54 |
| Trout | 2025-06-13T13:30Z (Jun 13 07:30 MDT) | 6,729 | 72 | 19,978 | 9,594 | 0.28 | 0.50 |
| Trout | 2025-06-14T13:30Z (Jun 14 07:30 MDT) | 10,748 | 12 | 3,879 | 7,471 | 0.18 | 0.72 |
| Trout | 2025-06-14T13:30Z (Jun 14 07:30 MDT) | 10,748 | 24 | 9,905 | 10,715 | 0.21 | 0.61 |
| Trout | 2025-06-14T13:30Z (Jun 14 07:30 MDT) | 10,748 | 48 | 15,959 | 13,640 | 0.28 | 0.59 |
| Trout | 2025-06-14T13:30Z (Jun 14 07:30 MDT) | 10,748 | 72 | 24,605 | 16,068 | 0.35 | 0.57 |
| Trout | 2025-06-15T13:30Z (Jun 15 07:30 MDT) | 20,653 | 12 | 2,703 | 5,409 | 0.36 | 0.89 |
| Trout | 2025-06-15T13:30Z (Jun 15 07:30 MDT) | 20,653 | 24 | 6,054 | 7,289 | 0.51 | 0.88 |
| Trout | 2025-06-15T13:30Z (Jun 15 07:30 MDT) | 20,653 | 48 | 14,700 | 9,901 | 0.52 | 0.82 |
| Trout | 2025-06-15T13:30Z (Jun 15 07:30 MDT) | 20,653 | 72 | 24,402 | 12,097 | 0.45 | 0.74 |
| Trout | 2025-06-17T13:30Z (Jun 17 07:30 MDT) | 35,352 | 12 | 4,500 | 11,573 | 0.37 | 0.88 |
| Trout | 2025-06-17T13:30Z (Jun 17 07:30 MDT) | 35,352 | 24 | 9,702 | 15,385 | 0.49 | 0.87 |
| Trout | 2025-06-17T13:30Z (Jun 17 07:30 MDT) | 35,353 | 48 | 11,487 | 18,353 | 0.50 | 0.85 |
| Trout | 2025-06-17T13:30Z (Jun 17 07:30 MDT) | 35,353 | 72 | 11,862 | 20,899 | 0.48 | 0.84 |
| Greer | 2025-05-13T23:47Z (May 13 16:47 MST) | 3,716 | 12 | 7,145 | 8,240 | 0.63 | 0.75 |
| Greer | 2025-05-13T23:47Z (May 13 16:47 MST) | 3,716 | 24 | 11,424 | 16,519 | 0.55 | 0.64 |
| Greer | 2025-05-13T23:47Z (May 13 16:47 MST) | 3,716 | 48 | 11,992 | 20,531 | 0.55 | 0.63 |
| Greer | 2025-05-13T23:47Z (May 13 16:47 MST) | 3,716 | 72 | 14,272 | 22,792 | 0.54 | 0.62 |
| Greer | 2025-05-14T05:47Z (May 13 22:47 MST) | 7,595 | 12 | 5,445 | 22,476 | 0.34 | 0.57 |
| Greer | 2025-05-14T05:47Z (May 13 22:47 MST) | 7,595 | 24 | 7,662 | 27,363 | 0.38 | 0.57 |
| Greer | 2025-05-14T05:47Z (May 13 22:47 MST) | 7,595 | 48 | 8,194 | 29,924 | 0.40 | 0.57 |
| Greer | 2025-05-14T05:47Z (May 13 22:47 MST) | 7,595 | 72 | 10,537 | 31,803 | 0.45 | 0.60 |
| Greer | 2025-05-14T17:47Z (May 14 10:47 MST) | 13,040 | 12 | 2,217 | 16,499 | 0.21 | 0.67 |
| Greer | 2025-05-14T17:47Z (May 14 10:47 MST) | 13,040 | 24 | 2,413 | 19,878 | 0.20 | 0.63 |
| Greer | 2025-05-14T17:47Z (May 14 10:47 MST) | 13,040 | 48 | 3,868 | 24,828 | 0.23 | 0.60 |
| Greer | 2025-05-14T17:47Z (May 14 10:47 MST) | 13,040 | 72 | 7,103 | 27,925 | 0.33 | 0.61 |
| Greer | 2025-05-16T17:47Z (May 16 10:47 MST) | 16,908 | 12 | 1,224 | 6,685 | 0.22 | 0.85 |
| Greer | 2025-05-16T17:47Z (May 16 10:47 MST) | 16,908 | 24 | 3,235 | 9,866 | 0.19 | 0.77 |
| Greer | 2025-05-16T17:47Z (May 16 10:47 MST) | 16,908 | 48 | 4,138 | 16,009 | 0.18 | 0.69 |
| Greer | 2025-05-16T17:47Z (May 16 10:47 MST) | 16,908 | 72 | 4,138 | 19,389 | 0.17 | 0.66 |
| Windy Deuce | 2024-02-27T06:30Z (Feb 27 00:30 CST) | 8,786 | 12 | 34,749 | 22,410 | 0.21 | 0.40 |
| Windy Deuce | 2024-02-27T06:30Z (Feb 27 00:30 CST) | 8,786 | 24 | 103,566 | 40,779 | 0.19 | 0.28 |
| Windy Deuce | 2024-02-27T06:30Z (Feb 27 00:30 CST) | 8,786 | 48 | 140,151 | 44,974 | 0.18 | 0.25 |
| Windy Deuce | 2024-02-27T06:30Z (Feb 27 00:30 CST) | 8,786 | 72 | 140,246 | 46,409 | 0.18 | 0.25 |
| Windy Deuce | 2024-02-27T12:30Z (Feb 27 06:30 CST) | 23,873 | 12 | 47,268 | 45,394 | 0.30 | 0.54 |
| Windy Deuce | 2024-02-27T12:30Z (Feb 27 06:30 CST) | 23,873 | 24 | 118,707 | 60,557 | 0.24 | 0.40 |
| Windy Deuce | 2024-02-27T12:30Z (Feb 27 06:30 CST) | 23,873 | 48 | 125,158 | 65,528 | 0.27 | 0.42 |
| Windy Deuce | 2024-02-27T12:30Z (Feb 27 06:30 CST) | 23,873 | 72 | 125,158 | 66,173 | 0.27 | 0.42 |
| Windy Deuce | 2024-02-27T18:30Z (Feb 27 12:30 CST) | 43,535 | 12 | 68,816 | 62,440 | 0.41 | 0.65 |
| Windy Deuce | 2024-02-27T18:30Z (Feb 27 12:30 CST) | 43,535 | 24 | 102,850 | 68,531 | 0.43 | 0.62 |
| Windy Deuce | 2024-02-27T18:30Z (Feb 27 12:30 CST) | 43,535 | 48 | 105,496 | 75,766 | 0.45 | 0.63 |
| Windy Deuce | 2024-02-27T18:30Z (Feb 27 12:30 CST) | 43,535 | 72 | 105,496 | 75,776 | 0.45 | 0.63 |
| Table Rock | 2025-03-25T13:30Z (Mar 25 09:30 EDT) | 4,178 | 12 | 511 | 311 | 0.30 | 0.94 |
| Table Rock | 2025-03-25T13:30Z (Mar 25 09:30 EDT) | 4,178 | 24 | 2,763 | 434 | 0.14 | 0.76 |
| Table Rock | 2025-03-25T13:30Z (Mar 25 09:30 EDT) | 4,178 | 48 | 5,681 | 554 | 0.10 | 0.62 |
| Table Rock | 2025-03-25T13:30Z (Mar 25 09:30 EDT) | 4,178 | 72 | 8,545 | 624 | 0.09 | 0.52 |
| Table Rock | 2025-03-26T13:30Z (Mar 26 09:30 EDT) | 6,941 | 12 | 1,937 | 753 | 0.29 | 0.88 |
| Table Rock | 2025-03-26T13:30Z (Mar 26 09:30 EDT) | 6,942 | 24 | 2,918 | 1,032 | 0.29 | 0.84 |
| Table Rock | 2025-03-26T13:30Z (Mar 26 09:30 EDT) | 6,942 | 48 | 5,782 | 1,285 | 0.23 | 0.74 |
| Table Rock | 2025-03-26T13:30Z (Mar 26 09:30 EDT) | 6,942 | 72 | 6,766 | 1,462 | 0.27 | 0.73 |
| Table Rock | 2025-03-27T13:30Z (Mar 27 09:30 EDT) | 9,859 | 12 | 2,520 | 500 | 0.16 | 0.89 |
| Table Rock | 2025-03-27T13:30Z (Mar 27 09:30 EDT) | 9,859 | 24 | 2,864 | 681 | 0.20 | 0.88 |
| Table Rock | 2025-03-27T13:30Z (Mar 27 09:30 EDT) | 9,859 | 48 | 3,849 | 862 | 0.23 | 0.85 |
| Table Rock | 2025-03-27T13:30Z (Mar 27 09:30 EDT) | 9,859 | 72 | 4,053 | 929 | 0.24 | 0.85 |
| Rush | 2024-10-25T02:17Z (Oct 24 21:17 CDT) | 980 | 12 | 6,004 | 2,131 | 0.34 | 0.47 |
| Rush | 2024-10-25T02:17Z (Oct 24 21:17 CDT) | 980 | 24 | 7,123 | 4,568 | 0.44 | 0.52 |
| Rush | 2024-10-25T02:17Z (Oct 24 21:17 CDT) | 979 | 48 | 10,906 | 6,342 | 0.57 | 0.61 |
| Rush | 2024-10-25T02:17Z (Oct 24 21:17 CDT) | 980 | 72 | 11,613 | 7,045 | 0.57 | 0.61 |
| Rush | 2024-10-25T08:17Z (Oct 25 03:17 CDT) | 3,291 | 12 | 4,375 | 4,079 | 0.39 | 0.66 |
| Rush | 2024-10-25T08:17Z (Oct 25 03:17 CDT) | 3,291 | 24 | 6,880 | 5,955 | 0.53 | 0.69 |
| Rush | 2024-10-25T08:17Z (Oct 25 03:17 CDT) | 3,291 | 48 | 9,299 | 7,713 | 0.55 | 0.67 |
| Rush | 2024-10-25T08:17Z (Oct 25 03:17 CDT) | 3,291 | 72 | 9,301 | 8,834 | 0.56 | 0.68 |
| Rush | 2024-10-25T20:17Z (Oct 25 15:17 CDT) | 7,666 | 12 | 2,505 | 9,202 | 0.41 | 0.75 |
| Rush | 2024-10-25T20:17Z (Oct 25 15:17 CDT) | 7,666 | 24 | 3,964 | 11,360 | 0.51 | 0.75 |
| Rush | 2024-10-25T20:17Z (Oct 25 15:17 CDT) | 7,666 | 48 | 4,926 | 13,158 | 0.53 | 0.74 |
| Rush | 2024-10-25T20:17Z (Oct 25 15:17 CDT) | 7,666 | 72 | 4,926 | 15,046 | 0.48 | 0.71 |
| Black Cove | 2025-03-20T19:00Z (Mar 20 15:00 EDT) | 1,361 | 12 | 5 | 145 | 0.04 | 0.95 |
| Black Cove | 2025-03-20T19:00Z (Mar 20 15:00 EDT) | 1,361 | 24 | 604 | 210 | 0.16 | 0.81 |
| Black Cove | 2025-03-20T19:00Z (Mar 20 15:00 EDT) | 1,361 | 48 | 1,461 | 284 | 0.11 | 0.65 |
| Black Cove | 2025-03-20T19:00Z (Mar 20 15:00 EDT) | 1,361 | 72 | 1,916 | 332 | 0.11 | 0.60 |
| Black Cove | 2025-03-22T19:00Z (Mar 22 15:00 EDT) | 2,822 | 12 | 440 | 213 | 0.13 | 0.91 |
| Black Cove | 2025-03-22T19:00Z (Mar 22 15:00 EDT) | 2,822 | 24 | 455 | 288 | 0.19 | 0.91 |
| Black Cove | 2025-03-22T19:00Z (Mar 22 15:00 EDT) | 2,822 | 48 | 878 | 347 | 0.17 | 0.85 |
| Black Cove | 2025-03-22T19:00Z (Mar 22 15:00 EDT) | 2,822 | 72 | 905 | 386 | 0.22 | 0.85 |
| Black Cove | 2025-03-23T19:00Z (Mar 23 15:00 EDT) | 3,277 | 12 | 423 | 184 | 0.18 | 0.93 |
| Black Cove | 2025-03-23T19:00Z (Mar 23 15:00 EDT) | 3,277 | 24 | 423 | 240 | 0.21 | 0.93 |
| Black Cove | 2025-03-23T19:00Z (Mar 23 15:00 EDT) | 3,277 | 48 | 450 | 304 | 0.28 | 0.93 |
| Black Cove | 2025-03-23T19:00Z (Mar 23 15:00 EDT) | 3,277 | 72 | 450 | 342 | 0.30 | 0.92 |

### 10.5 Results per region (`backend/fire3d/data/regional_accuracy.json`)

Region value = the mean of the fire means (each fire counts once, whatever its number of starts); *pooled* = the mean over all leads; status by the CONTRACT 14.4 rule (>= 2 fires and >= 16 leads: `tested`). The ignition-relative value uses the same metric at ignition + 6/12/24 h (California: bundle ignition; elsewhere WFIGS discovery).

| region | status | fires (leads) | growth Sørensen | fires' range | pooled | +12 h | +24 h | +48 h | +72 h | growth ratio (median) | ignition-relative | fuel groups | fuels | live fuel moisture |
|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| NWCC Northwest | tested | 2 (24) | **0.255** | 0.231-0.279 | 0.255 | 0.214 | 0.277 | 0.279 | 0.251 | 0.26 | 0.167 | timber | LF2024 | gsi_nfdrs2016 |
| NRCC Northern Rockies | tested | 2 (24) | **0.341** | 0.189-0.492 | 0.341 | 0.258 | 0.341 | 0.380 | 0.384 | – (pooled 0.73; fires 0.63 and 1.78) | 0.313 | grass, shrub, timber | LF2023, LF2024 | gsi_nfdrs2016 |
| GBCC Great Basin | tested | 2 (28) | **0.247** | 0.218-0.275 | 0.251 | 0.202 | 0.247 | 0.268 | 0.286 | 0.83 | 0.213 | grass, shrub, timber | LF2024 | gsi_nfdrs2016 |
| SWCC Southwest | tested | 2 (32) | **0.351** | 0.348-0.355 | 0.351 | 0.313 | 0.345 | 0.365 | 0.382 | 1.84 | 0.304 | grass, shrub, timber | LF2024 | gsi_nfdrs2016 |
| SACC-SP Southern Plains | tested | 2 (24) | **0.394** | 0.299-0.490 | 0.394 | 0.344 | 0.390 | 0.423 | 0.419 | 0.69 | 0.397 | grass | LF2023, LF2024 | gsi_nfdrs2016 |
| SACC-SE Southeast | tested | 2 (24) | **0.193** | 0.174-0.212 | 0.193 | 0.184 | 0.198 | 0.187 | 0.203 | 0.35 | 0.140 | timber | LF2024 | gsi_nfdrs2016 |
| RMCC Rocky Mountain | untested | 0 | – | – | – | – | – | – | – | – | – | – | – | – |
| EACC Eastern | untested | 0 | – | – | – | – | – | – | – | – | – | – | – | – |
| ONCC Northern California | untested | 0 | – | – | – | – | – | – | – | – | – | – | – | – |
| OSCC Southern California | tested (in-sample) | 3 (32) | **0.433** | 0.395-0.467 | 0.438 | 0.349 | 0.432 | 0.481 | 0.490 | 1.85 | 0.403 | grass, shrub | LF2024 | ca_month_table_drought |

Reading these:
- **All six test regions are `tested`** (2 fires and 24-32 scored leads each). Rocky Mountain, Eastern and Northern
  California have no test fire: the app says "Accuracy not yet tested here".
- **Outside California the scores are lower than California's**: from 0.19 (Southeast) to 0.39 (Southern Plains),
  against 0.43 in Southern California. California's value is in-sample (the settings were fitted there, a best case);
  these are not (`in_sample: false`: nothing was fitted to them).
- **Two fires are a small sample.** In the Northern Rockies the two fires differ by 0.30 (Island Creek 0.19, Horse
  Gulch 0.49), so the region value says little about the next fire there. Measured on these results (corrected after
  review; the earlier "about ±0.05" was the audit's guess from before any score): two fires of the same region differ
  by about 0.1 on average (0.01 to 0.30; pooled standard deviation between fires of a region 0.09, from the 15 fire
  means), so a two-fire value is uncertain by about ±0.07 (one standard error), about ±0.13 at 95 %, and about ±0.15
  (one standard error) in the Northern Rockies alone. Each region's caveat in the file states its two fires' scores
  ("Two fires only: a rough value (the two fires scored 0.19 and 0.49)."). Command shows the range; Public shows it
  under "How was it tested?" (the location card shows the one-line label only).
- **Growth ratio.** The region's growth ratio is the median over all its leads. In the Northern Rockies the two fires
  erred in opposite directions (Horse Gulch ×1.78 too much growth, Island Creek ×0.63 too little; 11 of the 24 leads
  too much), so the pooled 0.73 would read as a steady under-forecast. The file therefore gives no region ratio there
  (`growth_ratio_median` null) and a caveat names each fire's; the rule (`validate.growth_split`): a region ratio is
  given unless the fires err in opposite directions and no majority errs the pooled way. Southern California keeps its
  1.85 (Eaton ×1.74 and Madre ×2.2 too much, Palisades ×0.57 too little; its caveat says so).
- **The Southern Plains value depends on Windy Deuce's timing** (section 10.3): WFIGS's own polygon time puts about
  65 % of its area before the first start, while the satellite reconstruction puts most of the growth after it (6 %
  burned at the first start). Its score (0.30, one of the two fire means behind the region's 0.39) measures the run
  as VIIRS timed it, and that timing is uncertain by up to a day. Nothing was changed after the scores; the file's caveat says this.
- **Fuels tested** are those of these fires only (timber in the Northwest and the Southeast, grass in the Southern
  Plains, mixed elsewhere); a region's other fuels are untested, and the app adds that sentence.
- These re-runs started during the fires' main growth with archived HRRR weather; live forecasts use forecast weather
  and start from the latest satellite pass, so they usually do worse (section 10.8).

### 10.6 What GSI changed (ablation, outside the label)

The same label starts with the deterministic member, once with GSI (the method above) and once with California's rule forced (`validate hindcast --lfm california`: the month table with the water-year drought adjustment, what the code did before GSI). Live fuel moisture at the starts: GSI's values from section 10.4; California's from its table.

| fire | GSI (deterministic) | California table (deterministic) | difference | California's herb / woody at the starts |
|---|---:|---:|---:|---|
| Emigrant | 0.277 | 0.270 | +0.007 | 30%/70% |
| Lower Sugarloaf | 0.228 | 0.264 | -0.036 | 30%/70% |
| Island Creek | 0.188 | 0.205 | -0.017 | 30%/70% |
| Horse Gulch | 0.490 | 0.495 | -0.005 | 30%/70% |
| France Canyon | 0.219 | 0.209 | +0.011 | 60%/100% |
| Cottonwood Peak | 0.274 | 0.261 | +0.013 | 30%/70% |
| Trout | 0.348 | 0.318 | +0.030 | 60%/100% |
| Greer | 0.347 | 0.396 | -0.049 | 60%/100% |
| Windy Deuce | 0.302 | 0.021 | +0.281 | 120%/120% |
| Table Rock | 0.208 | 0.208 | +0.001 | 120%/120% |
| Rush | 0.486 | 0.486 | +0.000 | 30%/70% |
| Black Cove | 0.173 | 0.176 | -0.003 | 120%/120% |

Reading these (no setting was changed; GSI was pre-registered and stays):
- **GSI removes the one large failure of the California table**: Windy Deuce burned in February, when California's
  table assumes green winter grass (herb and woody 120 %). With that table the model barely spreads (0.021); with GSI
  (index 0.16: cold, short days, so cured grass at herb 30 %) it scores 0.302. This is the failure the audit predicted
  (gap G5).
- **Elsewhere the two methods are close** (within ±0.05 on every other fire, and equal on average without Windy
  Deuce). GSI is wetter than California's dry-season row for late-summer timber in the Northwest and Northern Rockies
  (Lower Sugarloaf, Island Creek), which slows fires that were already under-predicted; it is drier than California's
  May row for Greer (cured at 30 % / 60 % instead of 60 % / 100 %), which speeds a fire that was already
  over-predicted. Table Rock and Black Cove (March, Southeast) get herb 66-84 % from GSI against 120 % from the table,
  with almost no effect on the score: their timber-litter fuel models carry little or no live fuel.
- GSI estimates green-up from weather alone; it knows nothing about local plant species, and no measured live fuel
  moisture was used.

### 10.7 Spread multiplier sensitivity (tried, not adopted)

To see how much of the under-prediction comes from the California-fitted multiplier, the deterministic member was re-run at start multipliers 0.5 (operational), 1 and 2 (same 12 h decay), on California's 32 leads and on every label start. This is a check, not a tuning: the rule of section 10.1 adopts a change only if California improves too.

| fire | ×0.5 (operational) | ×1 | ×2 | median growth ratio at ×0.5 / ×1 / ×2 |
|---|---:|---:|---:|---|
| Eaton (CA) | 0.432 | 0.399 | 0.274 | 1.704 / 3.196 / 6.056 |
| Madre (CA) | 0.392 | 0.308 | 0.195 | 2.209 / 4.152 / 7.316 |
| Palisades (CA) | 0.458 | 0.505 | 0.482 | 0.547 / 0.935 / 1.923 |
| Emigrant | 0.277 | 0.378 | 0.461 | 0.201 / 0.413 / 0.849 |
| Lower Sugarloaf | 0.228 | 0.288 | 0.271 | 0.387 / 0.762 / 1.846 |
| Island Creek | 0.188 | 0.245 | 0.258 | 0.621 / 1.125 / 2.065 |
| Horse Gulch | 0.490 | 0.433 | 0.298 | 1.768 / 3.419 / 6.627 |
| France Canyon | 0.219 | 0.228 | 0.174 | 1.014 / 2.145 / 4.386 |
| Cottonwood Peak | 0.274 | 0.320 | 0.309 | 0.814 / 1.636 / 3.099 |
| Trout | 0.348 | 0.347 | 0.239 | 1.363 / 3.353 / 8.231 |
| Greer | 0.347 | 0.260 | 0.186 | 3.657 / 6.381 / 9.689 |
| Windy Deuce | 0.302 | 0.388 | 0.396 | 0.595 / 1.213 / 2.604 |
| Table Rock | 0.208 | 0.338 | 0.478 | 0.220 / 0.414 / 0.835 |
| Rush | 0.486 | 0.460 | 0.368 | 0.916 / 1.862 / 3.617 |
| Black Cove | 0.173 | 0.251 | 0.329 | 0.451 / 0.881 / 1.850 |

| deterministic member | ×0.5 (operational) | ×1 | ×2 |
|---|---:|---:|---:|
| California, 32 leads (pooled) | **0.432** | 0.416 | 0.332 |
| the 12 fires outside California (mean of fire means) | 0.295 | **0.328** | 0.314 |

Reading these:
- A faster start multiplier helps most fires outside California, above all the ones that were under-predicted:
  Table Rock 0.21 → 0.48 and Emigrant 0.28 → 0.46 at ×2, Black Cove 0.17 → 0.33. It hurts the fires that were already
  about right or too fast (Greer, Horse Gulch, Rush; Trout and France Canyon at ×2) and California as a whole
  (0.432 → 0.416 at ×1; Eaton and Madre drop, Palisades rises).
- By the pre-registered rule nothing is adopted: no change improved California too, so the label uses the operational
  setting and every region outside California stays `in_sample: false`.
- What it shows: much of the gap between California and the rest is the California-fitted spread speed, which is too
  slow for most timber and hardwood fires (and for Windy Deuce) and about right or too fast for the wind-driven runs
  of the Southwest, Horse Gulch and Rush. A regional setting would need its own,
  larger set of fires to fit and a separate set to test it; with two fires per region it would only fit noise.

### 10.8 Pseudo-live check (outside the label)

`validate live-start` re-issued forecasts on each bundle as if live (section 6.2): issue times every 6 h from ignition + 6 h to + 96 h, data known up to 1 h before each issue (FIRMS detections and NASA CMR passes), the deterministic member with the operational live start rule, scored at +12/24/48 h against the full reconstruction.

| fire | issues (quiet) | scored leads | growth Sørensen (operational rule) | total Sørensen | growth ratio (median) | mean growth error (ac) |
|---|---:|---:|---:|---:|---:|---:|
| Emigrant | 16 (2) | 48 | 0.274 | 0.755 | 0.28 | 4,952 |
| Lower Sugarloaf | 13 (4) | 39 | 0.204 | 0.715 | 1.43 | 4,345 |
| Island Creek | 16 (12) | 48 | 0.165 | 0.529 | 0.56 | 476 |
| Horse Gulch | 16 (3) | 48 | 0.339 | 0.727 | 3.94 | 6,140 |
| France Canyon | 15 (5) | 45 | 0.158 | 0.612 | 1.38 | 3,046 |
| Cottonwood Peak | 16 (2) | 48 | 0.335 | 0.672 | 1.10 | 17,948 |
| Trout | 15 (2) | 45 | 0.287 | 0.703 | 0.89 | 3,724 |
| Greer | 16 (1) | 48 | 0.232 | 0.739 | 5.08 | 10,149 |
| Windy Deuce | 10 (3) | 30 | 0.235 | 0.784 | 0.73 | 20,567 |
| Table Rock | 15 (6) | 45 | 0.118 | 0.761 | 0.37 | 1,813 |
| Rush | 13 (0) | 39 | 0.303 | 0.767 | 3.01 | 4,359 |
| Black Cove | 16 (5) | 48 | 0.131 | 0.736 | 0.21 | 727 |

Reading these (12 fires, 177 issue times, 531 scored leads; 45 issues were "quiet", the latest pass after the last
detection):
- The mean growth Sørensen of the pseudo-live forecasts is **0.23** (mean of the fire means), below the label runs'
  0.30 for the same fires, and close to California's pseudo-live 0.234 (section 6.2, which used a longer issue
  schedule). Issue times here start at ignition + 6 h, when the fires are small and the truth is timed by satellites
  only, which is part of the drop.
- The growth ratio swings both ways (0.2 to 5×): a live forecast starts from the last mapped area and the latest
  observation, so whether a run is caught depends on the timing of passes.
- These are still re-runs with archived HRRR weather. A real live forecast uses 1-3-day-old model forecasts, so it
  will usually do worse again. None of this enters the label.

### 10.9 Bug fix during validation (before / after for every fire)

**The bug.** The AOI of a build is sized from the fire's largest WFIGS perimeter plus the connected VIIRS detections
(`catalog.estimate_fire_bbox`). That function still asked for perimeters the California way (CAL FIRE name, state
`US-CA`), so outside California it found none and sized the AOI from VIIRS alone. Windy Deuce, a grass fire that VIIRS
saw on only 8 passes, got a 36 km AOI that cut the fire off: observed area 0.78 of WFIGS, 1,138 burned cells on the
AOI edge, so it failed two bundle checks before any score existed. **The fix** (`backend/fire3d/catalog.py`, commit
b501d96, regression test `test_estimate_fire_bbox_matches_a_wfigs_fire_by_irwin_id`) matches a WFIGS fire by its IRWIN
id, as the observed reconstruction already did; California rows are unchanged. Windy Deuce was rebuilt and passed
every check, so it was **not replaced**: a build bug is not a property of the fire.

**Before / after for every fire** (AOI from `estimate_fire_bbox` with the old and the fixed code; label scores where a
run existed before the fix; fires whose AOI did not change were not rebuilt, so their scores are identical by
construction):

| fire | AOI before → after | label p50 before | after | note |
|---|---|---:|---:|---|
| Emigrant | 34 → 37 km | 0.282 | 0.279 | rebuilt |
| Lower Sugarloaf | 42 km, centre moved 156 m | 0.228 | 0.231 | rebuilt |
| Island Creek | unchanged (28 km) | 0.189 | 0.189 | not rebuilt |
| Horse Gulch | unchanged (20 km) | – | 0.492 | no run before the fix |
| France Canyon | unchanged (26 km) | 0.218 | 0.218 | not rebuilt |
| Cottonwood Peak | 52 km, centre moved 59 m | 0.268 | 0.275 | rebuilt |
| Trout | 33 km, centre moved 268 m | – | 0.355 | rebuilt; its first run was stopped unfinished |
| Greer | 22 km, centre moved 129 m | – | 0.348 | rebuilt before any run |
| Windy Deuce | 36 → 60 km | – (failed checks) | 0.299 | rebuilt; area ratio 0.78 → 1.04 |
| Table Rock | 19 → 20 km | – | 0.212 | rebuilt before any run |
| Rush | unchanged (18 km) | – | 0.490 | built after the fix |
| Black Cove | unchanged (20 km) | 0.174 | 0.174 | not rebuilt |
| Eaton, Madre, Palisades | unchanged (California path) | 0.438 / 0.395 / 0.467 | same | the fix does not touch CAL FIRE rows |

The changes on the three rebuilt fires that had scores (−0.003 to +0.007) are the size of the noise from a slightly
different grid.

### 10.10 Caveats

- **Small samples.** Two fires per region and 12-16 leads per fire. A two-fire value is rough: two fires of a region
  differ by about 0.1 on average (section 10.5: about ±0.07 as one standard error, ±0.13 at 95 %), and the Northern
  Rockies' two fires differ by 0.30. Command shows the fires' range; Public shows it under "How was it tested?" (the
  location card shows the one-line label only).
- **Starts during the main growth, archived weather.** The label starts were chosen from the perimeter record before
  any run, during each fire's main growth, and the weather is archived HRRR (a near-perfect forecast). Live forecasts
  start from the latest observation with forecast weather and usually do worse (section 10.8; section 2).
- **The truth has errors.** It is the reconstruction of section 1 (VIIRS, MODIS, Landsat, WFIGS perimeters, GOES
  timing). Where perimeters are sparse the timing comes from satellite passes: Windy Deuce (one perimeter during its
  run, and WFIGS's own polygon time a day earlier than the reconstruction, see 10.3 and 10.5), Rush's first two starts (before its first perimeter), Lower Sugarloaf's later leads (no perimeter
  from Sep 19 to Sep 22). The perimeter reader dates re-edited WFIGS polygons by their edit time, which changes the
  timing of some fires compared with the audit's reading.
- **Fuels.** LANDFIRE LF2023 for the two federal fiscal year 2024 fires (Horse Gulch, Windy Deuce) and LF2024 for
  the rest: the pre-fire editions. Helene's 2024 blowdown in the Southern Appalachians (Table Rock, Black Cove) may be
  missing from LF2024. Each region's label lists the fuel groups its two fires burned; other fuels there are untested.
- **California settings.** The spread multiplier, its decay and the held perimeter were fitted on three Southern
  California fires. Outside California they slow most fires too much (section 10.7). Nothing was re-fitted.
- **GSI.** The NFDRS 2016 index with its default parameters, a perennial herb and no snow-day flag; it is driven by
  weather alone (section 10.6).
- **What the label is not.** It describes hindcast skill of model output on past fires. It is not a forecast of
  accuracy for a given fire, and it is never a statement about safety. Outside the modeled area is unknown, not low.
  Experimental: follow local officials.

### 10.11 Review fixes (2026-10-23, after the scores; no score changed)

An independent review of this section found these; each was checked against the code and the stored outputs first.
- **Fire behaviour charts outside California** (`spread/behavior.py`). The hourly flame-length and spread-potential
  annotation took each local day's GSI, but a live bundle's series ends today while its weather runs to +96 h (and a
  historical one ends 5 days before now), so from about +48 h it quietly used California's month table (herb and
  woody 120 % in February in Texas instead of 30 % / 60 %), with no warning. Now days after the series hold its latest
  21-day value, as a forecast holds live fuel moisture over its run (`gsi_at(..., hold_last=True)`); any hour that
  still has no GSI value (no series, or a gap inside it) uses California's values and the manifest says so ("Fire
  behaviour charts (dates, hours): live fuel moisture uses California's seasonal values (GSI series unavailable);
  experimental."). The forecasts and every score here were not affected: forecasts take the GSI at their start, and
  the 12 scored bundles' series cover their whole weather windows.
- **Hindcasts never fetch the series** (section 10.1). `member_weathers` fetched a missing series for any bundle; it now
  fetches it for a live bundle only, so the code matches 10.1 (the 12 scored bundles all had their series).
- **Region caveats** (`regional_accuracy.json`, regenerated from the stored per-fire rows with `validate regional`, no
  re-run): the guessed "about ±0.05" became each region's two scores (section 10.5); Windy Deuce's caveat names its
  timing problem; the Northern Rockies' growth ratio is null with a caveat naming each fire's (section 10.5).
- Section 10.4: the two Appalachian growth ratios were listed in the wrong order (Black Cove 0.46, Table Rock 0.22).

### 10.12 Reproduce (outside California)

```bash
cd backend
uv run python -m fire3d.cli weather-probe                       # before every build
uv run python -m fire3d.cli build 2025-emigrant-241e2b --require-hrrr --force
uv run python scripts/validate_us_fires.py starts               # the pre-registered starts (section 10.1)
uv run python scripts/validate_us_fires.py checks --out checks.json            # protocol step 2, all 12 fires
uv run python scripts/validate_us_fires.py hindcast 2025-emigrant-241e2b --what main --out-dir runs   # label (p50)
#   --what main_det | ignition | ablation_det | sens_det           (deterministic, ignition + 6/12/24 h, GSI ablation,
#                                                                    multipliers 0.5 / 1 / 2)
uv run python -m fire3d.spread.validate live-start 2025-emigrant-241e2b --every 6 --first 6 --latency 1 --until 96 \
    --leads 12 24 48 --json runs/2025-emigrant-241e2b.live.json
uv run python scripts/validate_us_fires.py collect --runs runs --checks checks.json --out fires.json
uv run python -m fire3d.spread.validate regional fires.json --out fire3d/data/regional_accuracy.json
uv run python scripts/validate_us_fires.py tables --runs runs --checks checks.json   # the tables of 10.4
```

The label run of a large fire takes 2-60 min with 3 worker processes on this 4-vCPU cloud machine (Greer, the
slowest, 61 min while other jobs shared the CPU).
