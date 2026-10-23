# brief 3 validation: progress

Role `validation` (wave 2). Ports: API 8716, no Vite. Scratch: session scratchpad `validation/`.

## Done
- 04:19Z read role entry, V audit, CONTRACT 14.4/14.12, docs/validation.md, us-pipeline as-built.

## Next
1. Pre-registration section in docs/validation.md (method, absolute UTC starts, replacement rule) and commit.
2. GSI implementation + tests.
3. Builds (Black Cove first), Madre baseline, California re-run.
4. Hindcasts, regional aggregation, regional_accuracy.json, docs.

## Decisions
- Warm-up builds: when historical-forecast answers but the archive is refused, a `--require-hrrr` build of a
  non-California fire still gets pure HRRR (`allow_era5=False` never asks the archive); it caches the expensive
  downloads (HRRR, FIRMS, LANDFIRE, 3DEP, WFIGS). Such a bundle is never scored: the scored bundle is the
  `--force` rebuild after GSI lands, with `overall ok`.

## Weather probe and build log (UTC)
| time | action | result |
|---|---|---|
| 04:19:30 | weather-probe | forecast ok, historical-forecast ok, archive daily_limit, ensemble ok; overall daily_limit |

## Open problems
- none yet
