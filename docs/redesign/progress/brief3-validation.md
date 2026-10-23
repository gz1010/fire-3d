# brief 3 validation: progress

Role `validation` (wave 2). Ports: API 8716, no Vite. Scratch: session scratchpad `validation/`.

## Done
- 04:19Z read role entry, V audit, CONTRACT 14.4/14.12, docs/validation.md, us-pipeline as-built.
- M1 pre-registration committed (29f0e2d): docs/validation.md 10.1 + backend/scripts/validate_us_fires.py (FIRES).
- GSI code (moisture.py, weather.py gsi_inputs, weather_bundle.py series/fallback/require, behavior.py, ensemble.py,
  config GSI_*), tests/test_gsi.py; regional aggregation + absolute starts in spread/validate.py (checkpointed by the
  orchestrator in 3283b7d at the usage limit). test_us_pipeline_quota water-year test adapted to GSI.
- California (herb, woody, note) identical before/after GSI on Eaton, Palisades, fixture-demo (Madre pending build).

## Next
1. Commit GSI + aggregation (M2) after tests for the aggregation.
2. Builds via scratchpad queue.py (q2 started 06:28Z): 12 fires + Madre + Horse Gulch (--force, only on overall ok).
3. Madre baseline + California re-run (step 1 = with GSI code in place; California path is bit-identical, proven
   by test_gsi + frozen copy) -> compare with 5.1.
4. Bundle checks, hindcasts (p50 + deterministic + ignition + ablation), regional file, docs, report.

## Decisions
- Warm-up builds: when historical-forecast answers but the archive is refused, a `--require-hrrr` build of a
  non-California fire still gets pure HRRR (`allow_era5=False` never asks the archive); it caches the expensive
  downloads (HRRR, FIRMS, LANDFIRE, 3DEP, WFIGS). Such a bundle is never scored: the scored bundle is the
  `--force` rebuild after GSI lands, with `overall ok`.

## Weather probe and build log (UTC)
| time | action | result |
|---|---|---|
| 04:19:30 | weather-probe | forecast ok, historical-forecast ok, archive daily_limit, ensemble ok; overall daily_limit |
| 04:20-04:22 | Black Cove warm-up build (pre-GSI code) | ready in 119 s, 339 h HRRR, 0 GFS, 0 ERA5 (not scored; later --force) |
| 04:26:26 | probe (driver w1) | historical-forecast daily_limit, archive ok |
| 04:36:44 | probe | historical-forecast ok, archive daily_limit -> Emigrant build |
| 04:39:21 | Emigrant build | failed: historical-forecast refused mid-build (bundle error) |
| 04:39:24 | probe | historical-forecast and archive daily_limit |
| 04:40:13 | probe (queue q1) | historical-forecast daily_limit, archive ok -> Black Cove --force |
| 04:40:29 | Black Cove build | failed: GSI request refused (archive) 16 s after an ok probe (bundle error) |
| 04:40:33 | probe | forecast ok, historical-forecast and archive daily_limit; then the usage limit stopped the session |
| 06:27:23 | probe | forecast and historical-forecast unreachable (connect timeout), archive ok, ensemble ok |
| 06:28 | queue q2 started | log: scratchpad validation/logs/queue_q2.log |
| 06:28:33 | probe | forecast unreachable, historical-forecast ok, archive ok -> Black Cove --force |
| 06:29:03 | Black Cove build | **ready** in 28 s (GSI series ERA5 2025-02-16..03-30); checks ok (ratio 1.077) |
| 06:29:08 | probe overall ok -> Emigrant | failed in 65 s: one HRRR chunk answered a non-JSON body (424 h missing, no ERA5 allowed) |
| 06:30:32 | probe (archive, hf ok) -> Lower Sugarloaf | **ready** in 370 s; checks ok (ratio 1.006) |
| 06:36:56 | probe overall ok -> Madre (CA) | **ready** in 394 s; 225 h HRRR, antecedent 207 mm, 81,938 ac |
| 06:43:52 | probe (hf, archive ok) -> Emigrant | **ready** in 48 s; 424 h HRRR, 33,132 ac |

## Open problems
- none yet
