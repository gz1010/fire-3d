# Fire-3d forecast validation

Last updated 2026-10-17 (evening) by the backend follow-up run, which added the live forecast start (section 6);
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
