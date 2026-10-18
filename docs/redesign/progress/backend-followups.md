# backend-followups progress log

Role: backend-followups (API port 8711). Owns backend/** except api/geocode.py, api/extras.py and their tests;
SPEC.md, docs/validation.md, data/**. Never edit web/ (describe needed changes in the report).

## Done
- 19:36 PDT Oct 17: started fresh (no earlier attempt). Read prompt, BRIEF, CONTRACT, SPEC 4-8, validation.md,
  ensemble.py, live.py, pipeline.py.

- 20:00: sources/overpass.py written (CMR passes, confirmation, per-pass detection counts). firms.py: honest
  response fetch times per source (cache hits keep their original time) + data_times_by_satellite().
- 23:28 EDT (20:28 PDT): resumed after the user's pause; partial firms.py edit checked (imports OK, 64 tests pass).

- 20:30-21:10 PDT: build/live_observation.py (latest observation, veto, markers, sim/activity.json); observed.py
  live time_range (+ last_detection_ms / last_pass_ms, CMR data source); contracts TimeRange optional fields;
  ensemble: markers + containment minimum in held_perimeter, live_settings (decay from last activity), notes;
  engine.adjustment_series honours SpreadSettings.adjustment_origin_ms; config LIVE_START_LATEST_PASS,
  FORECAST_HOLD_CONTAINED, FORECAST_DECAY_FROM_LAST_ACTIVITY; live.py sync_live_summaries (issue 7) +
  prune_live_forecasts. Tests: test_overpass, test_live_observation, test_live_forecast, test_live_housekeeping;
  full suite 502 passed.
- Dry run on scratch copies (scratchpad bf/data): Henderson now_ms Oct 16 14:48 -> Oct 17 15:50 PDT (13 quiet
  confirmed passes, 9 VIIRS), full hold; Norte now = WFIGS perimeter Oct 17 17:42 (570 ac), full hold; Cooley active
  (detections 15:52 PDT), unchanged rule, 0 % held.

- 21:15 PDT: validate.live_start_check + CLI `live-start` (pseudo-live re-issue on past fires; scratch
  bf/livecheck.json): 51 issues on Eaton/Palisades/Madre/Lidia/Camino, 14 quiet. Quiet issues: total Sorensen
  0.360 -> 0.666, growth error 4,954 -> 2,278 ac, median growth ratio 85.7x -> 2.81x, growth Sorensen 0.128 ->
  0.127 (decay-from-start variant 0.123/0.641/2,686 ac -> keep FORECAST_DECAY_FROM_LAST_ACTIVITY=True).
  All issues: total 0.747 -> 0.812, ratio 3.74 -> 2.68, growth Sorensen 0.2271 -> 0.2270.
- Hindcast regression (32 leads, adj 0.5): growth Sorensen 0.4219, total 0.822, ratio 2.01; per fire
  0.432/0.353/0.458 = unchanged (bf/hindcast_regression.json).
- Review: tests/test_endpoint_contracts.py walks every SPEC 6 endpoint + every file on the 8 real bundles; found and
  fixed aircraft 500 on unexpected transport errors (aircraft._fetch_from). Secret scan (count-only, bf/secret_scan.py):
  0 key occurrences in 5,836 files.

- 20:49-21:00 PDT live cycle on 8711 (FIRE3D_LIVE=1, interval 3600, log bf/live8711.log): summaries synced (3),
  3 refreshes, forecasts Henderson fc-20261017T2250-gfs025-f6cf (start 15:50 latest pass, held 3,228 ac),
  Norte fc-20261018T0042-gfs025-6842 (start 17:42 NIFC perimeter, held 571 ac), Cooley fc-20261017T2252-gfs025-1c75
  (active, 730 -> 2,100 ac +24 h) + POST /forecast ECMWF fc-20261017T2252-ecmwf_ifs025-4fde (23 s). Old-rule runs
  unlisted from the 3 manifests (copies in bf/before); their directories to delete at the end. check_bundle 0 problems
  x3. Old rule on today's Henderson data (scratch copy): 13,330 ac now. Server stopped, 8711 free.
- SPEC 2/5.1/6/8.2/8.3/8.4/8.5/8.6/8.7 and docs/validation.md (summary, 5, 6.1-6.5, 7, 8, 9) updated.

- 21:30 PDT: a CMR outage now costs one timeout (early stop). check_bundle checks the live time_range and
  activity.json: all 8 real bundles have 0 problems; the fixtures keep the old fx-001 note. The superseded old-rule
  run directories were deleted (unlisted about 40 min earlier). Final pytest: 517 passed. Secret scan: 0 hits. No
  processes of mine are running.
- DONE: report in docs/redesign/reports/backend-followups.json.

## Next
- Nothing in progress. Follow-ups are the known issues in the report: over-prediction of active small fires (Cooley),
  a small pseudo-live sample, and the UI/README changes described in notes_for_integrator.

## Round 2 (00:07 EDT Oct 18): known issue 1, over-prediction of small active fires
- Diagnosis (Cooley, published bundle): window detections are at the edge (depth p50 105 m, p90 267 m; max burned depth
  594 m), so an edge filter cannot change Cooley; 30 of 45 window detections lie on ground burned before the window,
  15 on new/outside ground all around the edge (growth-only filter still holds 0 %). CAL FIRE's 731.4 ac at 19:49 PDT
  equals the 13:06 NIFC perimeter (730 ac): it repeats the last mapping, so Cooley's over-prediction is NOT established.
- Implemented as switchable settings (default off): SpreadSettings.active_edge_m, active_growth_only;
  config FORECAST_ACTIVE_EDGE_M / FORECAST_ACTIVE_GROWTH_ONLY / FORECAST_ACTIVE_RADIUS_M; CLI --edge-m, --growth-only,
  --radius-m on validate hindcast and live-start. Test: test_experimental_activity_filters.
- Adoption criterion (fixed before looking at results): hindcast growth Sorensen >= 0.4219 AND pseudo-live (all 51
  issues, operational rule) total Sorensen and mean abs. growth error no worse than base AND no issue group's growth
  Sorensen down by >= 0.01. Otherwise keep the current settings and document.
- Results (scratch bf/edge, table in docs/validation.md 6.6): hindcast growth Sorensen base 0.4219 | edge375 0.4229 |
  edge750 0.4219 | radius500 0.4244 (Eaton -0.012) | radius750 0.4248 | growth-only 0.4317 (Madre 0.353 -> 0.392,
  Eaton/Palisades =) | growth+edge375 0.4320. Pseudo-live (141 leads) total/growth/error: base 0.812/0.2270/6,932 ac;
  growth-only 0.818/0.2339/6,434 ac (quiet 0.1271 -> 0.1342); radius500 0.816/0.2297/6,382 ac. Small fires: no
  variant changes them (their hot pixels are at the edge); dense 2-hourly schedule on Lidia+Camino: 32 of 33 issues
  quiet, 1 active (Camino, 1,696 ac forecast vs 0 observed).
- DECISION 00:17 EDT: adopt FORECAST_ACTIVE_GROWTH_ONLY = True (meets the criterion; physically: hot pixels on ground
  burned > 12 h earlier are burnout). Radius stays 1 km, edge filter off. SPEC 8.5 + validation.md (summary, 3.2, 5,
  6.2, 6.3, 6.6) updated; 6.2 tables recomputed under the new hold.
- 00:18-00:20 EDT: live loop on 8711 (no refresh needed: nothing new, not stale) + POST /forecast: Henderson
  fc-20261017T2250-gfs025-3df2, Norte fc-20261018T0042-gfs025-f995, Cooley fc-20261017T2252-gfs025-0228 and
  fc-20261017T2252-ecmwf_ifs025-8ccd; areas identical to the 20:49 runs (holds unchanged); old 20:49 runs unlisted
  (directories deleted at the end of the session after a grace period). check_bundle 0 problems x3; pytest 518 passed;
  8711 stopped.

- 00:21-00:24 EDT: the 31-member perturbed check with the adopted rule gives 0.438 (was 0.428; Eaton 0.438 and
  Palisades 0.467 unchanged, Madre 0.355 -> 0.395; every lead up). validation.md 5.1, summary, 6.6 updated.
- The round-1 run directories (f6cf, 6842, 1c75, 4fde) are unlisted and left for the live loop's prune (unlisted runs
  more than 1 h old), so ui-integration's open views keep working.
- DONE (round 2) 00:25 EDT: combined report written to docs/redesign/reports/backend-followups.json; pytest 518 passed;
  check_bundle 0 problems; secret scan 0 hits (786 files); no processes of mine running; port 8711 free.

## Decisions
- Issue 1 design (19:55): time_range.now_ms (live) = latest observation of the fire INCLUDING confirmed polar passes
  that saw nothing (NASA CMR granules of VNP14IMG_NRT/VJ114IMG_NRT/VJ214IMG_NRT, MOD14/MYD14 6.1NRT over the fire
  centroid; confirmed when CMR `updated` + 30 min <= FIRMS data time). SPEC 6 default (live start = now_ms) stays,
  so the UI timeline (observed segment ends at now_ms, forecast starts there) needs no change. New optional
  time_range.last_detection_ms / last_pass_ms. Observed arrival clipped at the last detection (no growth after).
  Veto (keep last detection): CAL FIRE acres updated after the last detection > 1.25x observed. Activity markers
  (low-confidence polar + persistent GOES after the last detection) keep nearby perimeter un-held. Live-only extra
  hold: >= official containment fraction of the perimeter (quietest cells). Decay clock may start at the last
  detection (decide with the pseudo-live check). Historical/hindcast path unchanged.
- CMR facts (checked): FIRMS acq_time falls inside the granule [time_start, time_end]; MODIS NRT = MOD14/MYD14
  version 6.1NRT; archive = VNP14IMG/VJ114IMG/VJ214IMG v002, MOD14/MYD14 v061. Granule `updated` lags acquisition
  by ~0.75-3 h.

## Open problems
- Active small fires are still over-predicted: the 1 km activity radius covers their whole perimeter (Cooley).
