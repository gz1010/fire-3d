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

- Cut-line (b) weighted counter/soft cap/hourly refetch and (d) growth_sorensen done; per-minute Open-Meteo
  refusals waited out once; OpenFEMA windows bounded to 22 d (refs in a 2nd query), request wait 3 s.
- Horse Gulch built 01:21-01:26Z (probe-3 ok): 322 s, UTM 12, LF2023, 346 h HRRR / 0 GFS fill / 0 ERA5,
  15,321 ac observed vs 15,167 IncidentSize, 2,937 detections (area_api), 20 perimeters, America/Denver,
  0 "CAL FIRE". Found: record data source removed by observed (fixed, rebuild pending).
- API 8714 checks done (fire-weather overview 49 states; Horse Gulch archived; Black Cove local alerts:
  nws not_checked 7-day reason, archive pending then available with 2 Polk Co evacuation CEMs; calfire not_covered).
- Web gates ok (typecheck 0, lint 55 all src/scene, 64 files 835 tests + 2 skipped, build ok).

- 02:01Z probe ok -> Horse Gulch rebuilt --force --require-hrrr (17 s, cached): data_sources[0] "NIFC WFIGS
  incident record (IRWIN)", check_bundle 0 problems, 0 "CAL FIRE".
- 02:04Z probe: historical-forecast daily_limit (reset 2026-10-24T00:00Z, 22 h) -> Black Cove **pending (quota)**
  (stop rule: no wait over 1 h).
- Screenshots (API 8714 restarted on current code, Vite 5184): horse-gulch-command (MDT, UTM 12N, aligned),
  horse-gulch-public (12-hour MDT), black-cove-public (unbuilt: official panel, NC/SC "not available in these
  states"; no timeline until the build). API log: 72 GET, 0 non-GET.
- Final gates: backend 870 passed; web typecheck 0, lint 55 (all src/scene), build ok; web tests 1028 passed,
  3 failed in us-official's uncommitted working-tree edits (evacuation.test.ts, model.test.ts; both pass on HEAD).
- Wording scan: 7 hits, all "not an all-clear" negations or `quote(..., safe=...)`. Key scan: 239 files, 0.

- Review round 1 (fixer, 02:55-04:05Z): R2 fixed (API build jobs only start the OpenFEMA fetch; CLI capped 15 s,
  no retry; drain waits for follow-ups), R3 fixed (hourly re-check of a daily Open-Meteo block; deviation), R4 fixed
  (LEW texts removed from the OpenFEMA sample; test loads the recorder by path), R1 still pending (quota): 7 probes
  02:57-03:59Z, none overall ok, so Black Cove was not built. Gates: backend 880 passed; web typecheck 0, lint 55
  (src/scene), tests 1107 passed / 2 skipped, build ok. Key scan 0, wording scan 0.

## Next
- Done except Black Cove (pending quota; validation builds it first). Whenever weather-probe says overall ok (or
  after 2026-10-24T00:00Z): build Black Cove
  --require-hrrr, check_bundle, Public screenshot with 12-hour EDT (steps in contract3/us-pipeline.md §14.12.11).

## Decisions
- probe adds a `detail` key; any request-limit period maps to status `daily_limit`.
- water_year_precip: any failed segment -> precip_mm None (no partial totals).
- weather_preflight before clearing the bundle (in-memory block only, no network).

## Open problems
- Open-Meteo on the shared IP: connect timeouts, a per-minute 429 (archive), an hourly 429 (historical-forecast,
  01:28Z) and the daily limit (historical-forecast, 02:04Z). Black Cove waits for the daily reset.
