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

## Open problems
- Roles are sized at about 4-5 h each (above the 3-4 h target) after deferring P2 and some P1 items; each has a
  P0-first order and a cut line. Stated in PLAN-3.md.
