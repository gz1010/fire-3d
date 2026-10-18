# brief2-official-backend progress

Role: official-backend (BRIEF-2 build). API port 8714. Status: DONE (2026-10-18), report in
docs/redesign/reports/brief2-official-backend.json.

## Done
- Read prompt, BRIEF-2, PLAN-2, updates-official audit, opening-map audit, CONTRACT §12/13, SPEC §2/§6.
- Recorded samples politely (NWS: CA active alerts (none), recent LOX Red Flag Warnings, 5 fire zones; IEM: Eaton
  bypoint, LOX FW.W/FW.A #1-#2 2025 details, FW.W #1 polygons) -> trimmed fixtures in backend/tests/data/official.
- U-R6: sources/calfire_history.py (append-only JSONL per UniqueId under data/official/calfire, atomic + fcntl,
  stale-copy guard), hooks in catalog (live list, year lists, tracked fires that left the live list), endpoint.
- U-R7: sources/nws.py (live statewide alerts 2 min, zones 30 d simplified, covers/nearest; IEM archive with
  per-zone phase, statement text/times as issued by at_ms, upgraded-watch quirk), endpoint (+ statewide mode).
- O-R8: /api/incidents year=YYYY (historical), IncidentListRow.bbox_lonlat; current-year list 30 min + live overlay.
- api/official.py router (+ include in app.py); contracts models; SPEC §2 rows + §6 rows and TS shapes;
  CONTRACT §13 "official-backend" sub-heading.
- Tests: test_official_nws.py, test_official_calfire.py, test_official_real_bundles.py, test_api.py (+2).
  Backend 597 passed. Web gates pass (typecheck, lint exit 0, 555 vitest, build).
- Smoke on 8714 (FIRE3D_LIVE=0): CAL FIRE Henderson/Cooley baseline recorded; Henderson fire weather none (not an
  all-clear); Eaton Jan 8 2025 -> IEM Red Flag Warning LOX FW.W #1 in effect + FW.A #1 upcoming; year=2026 list
  (83 rows, 5 active, 3 with bbox); secret scan 181 files, 0 hits. Evidence page screenshots
  docs/screenshots/brief2-official-backend-smoke-{1440,1440-lists,390}.png. Server stopped.

## Decisions
- Year lists keep row mode "historical"; is_active is CAL FIRE's status; detail resolves live.
- History keyed by full CAL FIRE UniqueId; never goes backwards; records active + tracked + asked-for incidents.
- NWS alerts per CAP message (group by vtec); area = AOI (or point +-10 km) + 15 km.
- Archive: 5 sample points; window = whole record of a historical fire, else day of at_ms -14 d/+2 d; phase from
  per-zone times; onset/ends + text from the latest statement by at_ms; expires_ms null; ended alerts listed 48 h.

## Open problems
- None blocking. See known_issues in the report (history starts today; archive sampling; simplified outlines).
