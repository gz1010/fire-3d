# brief3 audit-validation progress

## Done
- Read BRIEF-3, docs/validation.md, validate.py, cli.py, catalog.py, pipeline.py, weather.py, landfire.py, terrain.py,
  grid.py, perimeters.py, firms.py, moisture.py, config.py, observed.py (parts), ensemble.py (parts).
- Data checks (scratch scripts and outputs in the session scratchpad audit-validation/): WFIGS lists and per-fire detail,
  extents, FIRMS NOAA-20 SP counts (1 request per fire), Open-Meteo HRRR (1 per fire), ERA5 water-year precip,
  LANDFIRE LF2023/24/25 samples inside burn scars, GACC layer.
- Wrote docs/redesign/audit-3/validation.md and docs/redesign/reports/brief3-audit-validation.json. Committed.

## Next
- Nothing (stage A done for this role).

## Decisions
- 10 primary fires (2 each NW/NR/GB/SW, 1 each SP/SE) + 2 stretch (Rush, Black Cove) + 5 reserves.
- Regions = WFIGS GACC, with Southern Area split TX/OK -> Southern Plains, rest -> Southeast; CA = ONCC/OSCC.
- Label metric = mean of per-fire mean growth Sørensen (31-member p50), leads 12-72 h; number shown at >= 2 fires and >= 16 leads.
- Fuel edition rule LF{FY(ignition)-1}: 2024 fires need LF2023 (verified: LF2024 already holds the 2024 burn scars).

## Open problems
- CA live fuel moisture table makes Feb/Mar grass and SE fuels green (1.2/1.2): blocker for SP/SE validity (R5).
- Open-Meteo 429s on the shared egress; a 200-with-error body gets cached 30 days (R7).
