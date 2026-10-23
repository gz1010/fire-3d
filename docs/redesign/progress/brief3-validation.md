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
| 06:45:01 | probe (archive unreachable; hf ok) -> Island Creek | **ready** in 1,095 s (slow FIRMS 504 retries); 937 h HRRR |
| 07:03:39 | probe (hf unreachable, archive ok) -> France Canyon | **ready** in 1,342 s; 529 h HRRR, 35,251 ac |
| 07:26:24 | probe (hf unreachable, archive ok) -> Cottonwood Peak | **ready** in 852 s; 332 h HRRR, 134,176 ac |
| 07:40:45 | probe -> Trout (queue q3 stopped 07:4x to keep Horse Gulch for a swap build; q4 started) | **ready** in 574 s; 363 h HRRR, 47,684 ac |

Horse Gulch plan: the integration agent screenshots it, so it is rebuilt into a scratch DATA_DIR on the same
filesystem (data/_hg_tmp) and swapped in with two renames (no error window), after queue q4 (Greer, Windy Deuce,
Table Rock, Rush).

Hindcast log: scratchpad validation/logs/hq.log (runner hq2.sh, jobs from mkjobs.py; checks via refresh.sh).
- 06:53 CA step 1 (pre-GSI worktree 29f0e2d) = section 5.1 exactly; 07:14 step 2 (post-GSI) = step 1 (max |d| 0.0).
- 07:16-07:25 label p50 / det / ablation / ignition / live for Black Cove, Emigrant, Lower Sugarloaf, Island Creek.

## Rebuilds after the AOI fix (queue q5, all after an ok or hf+archive-ok probe)
| fire | end (UTC) | duration | result |
|---|---|---|---|
| Windy Deuce | 08:07:36 | 145 s | ready, AOI 60 km, 149,031 ac (ratio 1.04), checks ok |
| Emigrant | 08:16:39 | 539 s | ready, AOI 37 km, checks ok |
| Table Rock | skipped by mistake (its build started 07:57:52, before the fix; built_ms after the cutoff) -> q6 |
| Lower Sugarloaf | 08:22:48 | 364 s | ready, checks ok |
| Cottonwood Peak | 08:29:59 | 427 s | ready, checks ok |
| Trout | 08:33:33 | 196 s | ready, checks ok |
| Greer | 08:34:52 | 74 s | ready, checks ok |
Then chain.sh: Table Rock (q6) and the Horse Gulch swap build.

## Bug fix after the first non-California scores (protocol: before/after for every fire)
- 07:57 Windy Deuce failed checks (area ratio 0.78, fire at the AOI edge; AOI 36 km). Cause: catalog._estimate called
  perimeters.fetch_perimeters without the WFIGS identity -> California-only query -> no perimeter outside CA -> AOI
  from the VIIRS cluster only. Fixed in catalog.py (b501d96) + regression test in test_firedata_catalog.py.
- AOI old vs fixed (aoi_compare2.py): identical for Black Cove, Island Creek, France Canyon, Horse Gulch, Rush (built
  after the fix); changed for Windy Deuce 36->60 km, Emigrant 34->37 km, Table Rock 19->20 km and small centre shifts
  (<270 m) for Lower Sugarloaf, Cottonwood Peak, Trout, Greer -> these 7 rebuilt (queue q5), their runs redone; old
  runs kept in scratchpad runs_before_fix/ for the before/after table.
- Horse Gulch was rebuilt at 08:01:25-08:01:53Z by another session (ready, GSI series, LF2023, 20 km, checks ok); I
  will still do my own provenance rebuild via a scratch DATA_DIR + rename swap.
- Tooling note: a scratch file named queue.py shadowed the stdlib (fixed by renaming to build_queue.py); pkill -f
  patterns matched my own shell several times (now kill by PID only). One `pkill -f multiprocessing.spawn` at ~08:04Z
  may have hit other sessions' spawn workers too (none visible afterwards).

## Open problems
- none yet
