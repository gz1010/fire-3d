# Brief 3 planner progress

Single planner instance (the orchestrator stopped a duplicate instance and removed its §14 block; this file is
rewritten as this instance's own log).

## Done
- 2026-10-22 ~23:00 UTC: read BRIEF-3 (decisions 1-4, round 2), the four audit-3 files, CONTRACT §12-§13, SPEC §4-§6,
  PLAN-2, RUNBOOK-3, the orchestrator's progress; surveyed the backend and web layout, the 37 files importing
  `lib/time.ts`, and the cross-role web imports of the planned split.
- ~23:20: BRIEF-3 "Decisions round 3" read (Washington not built; CA active if either agency; CA complex = CAL FIRE
  row; Oregon past zones not now). Every Washington task, flag and certificate dropped.
- ~23:45: CONTRACT §14 (14.0-14.15) appended. New TS summary fields optional in wave 1 (integration makes 5 required).
- ~23:55: `docs/redesign/plan3-roles.json` generated (4 wave-1 roles + validation). Ownership check (glob → regex,
  `*` within a segment, `**` across, `[!x]` negation) over `git ls-files` + 58 planned new paths: wave 1 owns 457
  paths, 0 clashes; unowned: only the three package `__init__.py` files and wave-2-only new files.
- ~00:10: PLAN-3.md (with the ownership script as appendix B, rerun: 0 clashes) and the report written; committed.

## Decisions
- Wave 1 = 4 roles. First batch: `us-catalog` (8711/5181), `us-web` (8712/5182), `us-official` (8713/5183);
  4th: `us-pipeline` (8714/5184), the only role allowed to build (3 smoke fires outside CA). Wave 2: `validation`
  (8716), which also implements the pre-registered GSI live fuel moisture (V-R5) and the regional aggregation (V-R9).
- Contract files (`contracts.py`, `SPEC.md`, `web/src/api/**`) owned by `us-catalog`; official TS types stay in
  `official/types.ts` / `extras/types.ts` (`us-official`); geocode TS in `location/types.ts` (`us-web`).
- `lib/time.ts` and `state/timeZone.ts` owned by `us-web`; new API beside the deprecated Pacific API; each role
  migrates its own files; `web/scripts/check-time-api.mjs` measures it; the integration deletes the old API.
- CONTRACT.md is not edited in wave 1: as-built notes go to `docs/redesign/contract3/<label>.md`.
- Switches: `CA_ACTIVE_RULE = "either"`, `CA_COMPLEX_ROWS = "calfire"` (round 3); no Washington switch.
- Deferred to a later brief: WFIGS change history (B-R11), GOES-East (B-R15), bundled NWS zones (B-R18), B-R19/20/21,
  EV-R11, EV-R12, V-R12; to the integration: W16, renaming `statewide`, P1 leftovers below the cut lines.

- ~23:50-00:40 (revision pass): checked the 23 critic problems received (the list was cut off after item 23 of 41)
  against the code (contracts.py strict mode and the NWS tests, firms.py `_keyless`, pipeline.py build gate,
  app.py:184/496, test_api.py:241-244, CardParts.tsx, official.ts, nws.py:445, official.py:394-397, perimeters.py
  `identity_filter` / `_calfire_hint`, weather.py `WeatherError`, types.ts, shot.mjs, RUNBOOK-3:97): all 23 confirmed.
  Revised CONTRACT §14 (14.0 commits, gate attribution, defaulted fields, schedule, hand-offs; 14.1 naming and
  `OtherRecord.name`; 14.2 complex rows and the build gate; 14.4 status and fuel rules; 14.5 synthetic ids and the
  shared `records.ts` helpers; 14.6 `states_checked` / `alert_states`; 14.7 windows and card lines; 14.8.7 dev preset;
  14.9.3 script; 14.12.1/2/8/9/10/11), regenerated plan3-roles.json (cut lines in every role, schedule, reviews,
  validation `owns_bugfix_only`), updated PLAN-3.md (schedule, commits, reviews, cut lines, integration checklist,
  appendix B rerun, Revision notes). Ownership check: wave 1 466 paths, 0 clashes; wave 2 69 paths, 0 clashes.
- ~00:40-01:40 (second revision pass): received the critics' remaining 19 problems (items 23-41) in full. Checked
  each against the code: firms.py loaders and their callers (`pipeline.py:655`, `api/live.py:138/:163`), the live loop
  (`auto_build_done`, `auto_build`), weather.py (`ERA5_DELAY_DAYS`, `ENSEMBLE_URL`, the GFS fill at `:388-393`), the
  moisture fallbacks (`ensemble.py:307-315`, `weather_bundle.py:393-396`), the fixed ensemble seeds, `FireCard.tsx`
  `.fc-official`, `nws.py:418` (`@id`), V §3's relative starts and reserves, and the evacuations audit's 6 % `web`
  links. 2 were already fixed by the first pass (23, 28; small additions), 17 were fixed, none was rejected (34 partly
  wrong: auto-build runs once per loop start). Revised CONTRACT §14 (14.0 wording scan; 14.1 `aliases`; 14.2 complex
  and id pinning; 14.4 in-sample templates, `gfs_fill_hours`, the label outside `.fc-official`; 14.5 complex reason
  and member links; 14.7 `source_url`; 14.11/14.14 list absence; 14.12.1/2/7/10/11), plan3-roles.json (acceptance
  checks for FIRMS, RX/CX, quota, links, GSI, the California re-run; cut-line moves), and PLAN-3.md (revision notes,
  second pass). Ownership check: wave 1 475 paths, 0 clashes; wave 2 77 paths; no glob changed.

## Open problems
- Roles are sized at about 4.5-5 h each above their cut lines (us-catalog about 5 h), above the 3-4 h target; every
  role has an explicit cut line with fallbacks, and the overflow is on the integration checklist.
- Validation grew to about 6.5-8.5 h (the California re-run after GSI, the live GSI input).
- RUNBOOK-3 still shows a plain `git commit`; the orchestrator should use the pathspec form of CONTRACT §14.0.
