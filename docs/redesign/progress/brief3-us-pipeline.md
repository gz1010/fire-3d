# brief3 us-pipeline progress

Role: backend, prepare fires anywhere in the lower 48 + national NWS / local alerts (CONTRACT §14.2, §14.5 CAL FIRE
endpoint, §14.6, §14.7, §14.9.7, §14.12.2/3/5/6/7/8/10/11). Ports API 8714, Vite 5184. As-built note:
`docs/redesign/contract3/us-pipeline.md`.

## Done
- Baseline backend tests before any change: 585 passed.
- M1 weather quota (§14.12.2): http quota no-retry + error bodies never cached/evicted; WeatherQuotaExceeded,
  per-host block, om_request, probe_open_meteo, CLI weather-probe, build --require-hrrr, weather_preflight,
  refused refresh keeps weather. Tests: tests/test_us_pipeline_quota.py (34). Full suite 638 passed.
- Real probe 2026-10-23T00:36Z: forecast ok, historical-forecast unreachable (ConnectTimeout), archive ok,
  ensemble ok -> overall unreachable, live ok (exit 1).

## Next
- M3 (NWS + local alerts) before M2 unless `brief 3 us-catalog: M3` is in git log.

## Decisions
- probe adds a `detail` key; any request-limit period maps to status `daily_limit`.
- water_year_precip: any failed segment -> precip_mm None (no partial totals).
- weather_preflight before clearing the bundle (in-memory block only, no network).

## Open problems
- historical-forecast host connect timeout on this IP at 00:36Z (not a 429). Re-probe before smoke builds.
