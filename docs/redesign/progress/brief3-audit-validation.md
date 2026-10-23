# brief3 audit-validation progress

## Done
- Read BRIEF-3, docs/validation.md, validate.py, cli.py, catalog.py, pipeline.py, weather.py, landfire.py, terrain.py,
  grid.py, perimeters.py, firms.py, moisture.py, config.py, observed.py (parts), ensemble.py (parts).
- Data checks (scratch scripts and outputs in the session scratchpad audit-validation/): WFIGS lists and per-fire detail,
  extents, FIRMS NOAA-20 SP counts (1 request per fire), Open-Meteo HRRR (1 per fire), ERA5 water-year precip,
  LANDFIRE LF2023/24/25 samples inside burn scars, GACC layer.
- Wrote docs/redesign/audit-3/validation.md and docs/redesign/reports/brief3-audit-validation.json. Committed.
- Revision pass (22:00-22:20Z) after the independent review: every point re-checked (scratch audit-validation/rev/).
  Audit, report ("revision" key) and this file updated. Committed.

## Next
- Nothing (stage A done for this role).

## Decisions
- 12 fires (user decision round 2): 2 each in NW/NR/GB/SW/SP/SE, plus 5 reserves (none in the Southern Plains).
- Regions = WFIGS GACC, with Southern Area split TX/OK -> Southern Plains, rest -> Southeast; CA = ONCC/OSCC.
  Unknown GACC -> untested wording; no state-table fallback; no label without model output.
- Label metric = mean of per-fire mean growth Sørensen (31-member p50), leads 12-72 h, everywhere (OSCC 0.43);
  a score needs >= 2 fires and >= 16 leads. Public words + score one tap away; Command score.
- Fuel edition rule LF{federal FY(ignition) - 1}: Horse Gulch and Windy Deuce LF2023; all others incl. Rush LF2024.
- Windy Deuce starts moved to its first perimeter: 02-27 06:30Z, 12:30Z, 18:30Z.
- Stage D starts with Madre rebuilt and the California baseline re-measured.
- Smokehouse Creek: no code change (9.9 km away; historical truth clipped to the fire's own complete perimeter).

## Open problems
- Open-Meteo daily cap on the shared egress (daily-limit 429 at 21:50Z; historical host unreachable 22:02-22:03Z):
  stage D may have to wait for the reset (R7 P0; conditional user question, recommended: wait).
- CA live fuel moisture table makes Feb/Mar grass and SE fuels green (R5, pre-register before any score).
- LF2025 NoData in the South/East until Nov 2026 (G13; A1 B6/R8).
