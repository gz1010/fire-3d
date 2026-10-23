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

- M3 national NWS + local alerts + openfema.py + samples (nws_alerts_national, nws_nwem_cem_la,
  openfema_window_frw) + tests (test_local_alerts_nws 16, test_openfema_parse 8). Full suite 737 passed.
  Archive channel answers not_checked until cut-line (a).

- Cut-line (a) done early: OpenFEMA incident windows, disk cache, background fetch, pending within 4 s, post-build
  prefetch. Full suite 743 passed.

- M2 build anywhere (us-catalog M3 landed 0acc032): build gate (resolve_listed + is_supported, BuildRefused
  404/409/422 texts), LANDFIRE editions + NoData switch + outside-coverage label, perimeters by IRWIN (CA regression
  on recorded Eaton/Palisades/Madre/TCU), fire-local time (timeutil.fmt_local/local_month/zone_of; no LA zone left),
  issuer text, record data source name, interim LFM warning, refresh_live on load_live_us. Full suite 809 passed.

## Next
- M4 smoke builds: weather-probe, then 2024-horse-gulch-889237 and 2025-black-cove-95c3c8 (one at a time).

## Decisions
- probe adds a `detail` key; any request-limit period maps to status `daily_limit`.
- water_year_precip: any failed segment -> precip_mm None (no partial totals).
- weather_preflight before clearing the bundle (in-memory block only, no network).

## Open problems
- historical-forecast host connect timeout on this IP at 00:36Z (not a 429). Re-probe before smoke builds.
