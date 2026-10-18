# backend-integration progress log

Role: backend-integration (API port 8711). Owns backend/** (except api/geocode.py, api/extras.py, tests/test_geocode.py), docs/validation.md, data/**.

## Done
- P1 (15:01): Eaton built into data/incidents/2025-eaton-fire-dbfa57 (ready, 69 s) + hindcast fc-20250108T0818-perturbed-1dbb (53 s).
- Built + validated (scripts/check_bundle.py, 0 problems): Madre 2025-madre-fire-01e7e8 (87 s), live Cooley 2026-cooley-fire-0c342f
  (185 s incl. gfs025 x31 forecast 110 s), Palisades 2025-palisades-fire-abfed7 (75 s). Quick-looks docs/screenshots/backend-*.
- pytest 389 passed (before science changes).
- Science (code in place, defaults NOT yet switched): drought-adjusted live fuel moisture (water-year precip, sim/antecedent.json),
  WUI surrogate for NB1 cells (engine.wui_mask), held inactive perimeter (ensemble.held_perimeter), decaying spread adjustment
  (engine.adjustment_series), historical skill window extends to containment (ensemble.data_end_ms).
- Experiments (scratchpad, deterministic member, Eaton 6/12/24 h, Madre 24/48, Palisades 6/12/24): drought LFM fixes early runs
  (Eaton +12 h growth 0.4x -> 0.9x observed); all variants over-predict later leads; best constant adj 0.25 (Sg mean 0.414 with hold).
- API on 8711: health, lists, detail, gzip+ETag/304, traversal 404, historical aircraft note, live status OK. adsb.lol unreachable (connect timeout).

## Next
- Finish decay experiment -> choose defaults -> tests -> official batch_hindcast grid -> final forecasts (Eaton, Madre, Palisades, Cooley gfs+ecmwf)
- POST build (Lidia, running) + POST forecast polling; live loop cycle; FIRMS usage; docs/validation.md; cleanup data/dev.

## Decisions
- Experiments in FIRE3D_DATA_DIR=data/dev/backend (relative to repo root!).

## Open problems
- adsb.lol API unreachable from this network (api.adsb.lol connect timeout; adsb.lol root OK).

## Attempt 3 (resumed 16:01, higher usage limit)
- State found: 406 tests pass; config FORECAST_* defaults switched to the exp3 best (adj 0.75, decay 12 h, floor 0.1,
  WUI on, hold on); bundles in data/incidents all "ready" (Lidia too, to be checked).
- 16:08-16:20 calibration re-run on PUBLISHED bundles (read-only; scratchpad cal/*.json, driver sci/experiment.py):
  S0 SPEC baseline best 0.390 @0.5; S1 +drought LFM 0.397 @0.25; S2 +WUI 0.380 @0.25 (WUI hurts: 22k ac of Eaton
  developed land made burnable, 10% of it burned); S4 WUI+hold+decay 0.404 @0.5. exp3's 0.420 is NOT reproducible
  with the current code (WUI/hold changed in attempt 2) -> do not trust exp1-3 numbers, use cal/*.json only.
- Eaton NB1 urban = 16% of the BURNED area (2,316 ac; 36% of the AOI); the WUI mask covers 96% of it.
- Aircraft: squawk 1255 = strong evidence; NON_FIRE_* vetoes (EMS/police/news/airlift, B1-B4) for low&slow only.
- dev.sh: --reload opt-in (auto-build off under reload); live.py FIRE3D_LIVE_INTERVAL_S knob.
- POST build test: 2025-camino-fire-c606c9 job-0001 on 8711 (poll log scratchpad logs/camino-build-poll.log).
- 16:26 DECISION (cal/*.json, 32 leads): operational = drought LFM + hold + decay(12 h, floor 0.1), multiplier 0.5,
  WUI OFF, spotting OFF. Deterministic Sg 0.422 (best of all); 31-member perturbed check 0.428 (0.75: 0.425;
  constant 0.25: 0.416). config.FORECAST_* updated; 439 tests pass.
- Final hindcasts published: Eaton fc-20250108T0818-perturbed-00ce (15 s), Madre fc-20250703T2007-perturbed-a95d
  (9 s), Palisades fc-20250108T0020-perturbed-7d3b (12 s); old Eaton/Madre runs removed; quick-looks regenerated.
- dNBR limited to each incident (+1 km) in Eaton/Madre/Palisades/Lidia (Gifford scar was in Madre's layer).
- Camino (2025-camino-fire-c606c9) built via POST /build on 8711: job done in 192 s, 0 problems.
- adsb.lol unreachable (TCP timeout); added adsb.fi open-data fallback (sources/aircraft.py) + tests.
- Next: live loop cycle (FIRE3D_LIVE=1, interval 240 s) -> Cooley refresh/auto-builds; POST forecast Cooley
  ecmwf_ifs025 + Lidia; remove old Cooley run; validation.md placeholders; cleanup data/dev; final pytest.
- 16:27-16:33 live loop on 8711 (FIRE3D_LIVE=1, interval 240 s): cycle 1 auto-built Henderson + Norte (gfs025
  forecasts inside the builds), cycle 2 at 16:31:45 clean; FIRMS 84/5000 tx per 10 min. POST forecasts: Lidia
  (perturbed, 2 s), Cooley ecmwf_ifs025 x51 (19 s, job states polled) and gfs025 (11 s); old Cooley run removed.
- adsb.fi fallback verified live: CFR110 (V10 = OV-10, added to the type table) + N416DF over Cooley.
- docs/validation.md written; data/dev deleted (data/ 509 MB); 478 tests pass; all 8 real bundles 0 problems.
- DONE. Open: live start = last detection (Henderson over-forecast, documented); fixture-demo fx-001 keeps
  pre-start arrivals (fixture only).
