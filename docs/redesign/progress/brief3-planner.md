# Brief 3 planner progress

## Done
- 2026-10-22 ~23:00 UTC: read BRIEF-3 (incl. round 2), the four audit-3 files, CONTRACT §12-§13, SPEC §4-§6,
  PLAN-2, RUNBOOK-3, orchestrator progress; surveyed backend/web file layout, time.ts call sites, official imports.

## Next
- Write CONTRACT §14, plan3-roles.json, PLAN-3.md; run the ownership-disjointness script; report; commit.

## Decisions
- Wave 1 = 4 roles: us-catalog (backend list/contracts/regions/records/NWS/local alerts), us-pipeline (build
  anywhere, quota, GSI, smoke builds), us-official (evacuations backend + all official web), us-web (time formatter
  + migration, overview, search incl. gazetteer backend, accuracy label). Validation = wave 2.
- Contract files (contracts.py, SPEC.md, web/src/api/types.ts, api/client.ts) all owned by us-catalog.
- lib/time.ts owned by us-web; new API added beside the deprecated Pacific API; integration removes the old one.
- New TS IncidentSummary fields optional, pydantic fields defaulted (no cross-role fixture breakage).
- GSI live fuel moisture in us-pipeline (wave 1) with pre-registration in docs/validation.md before any score.
- Q-A/Q-B/WA defaults as constants with env overrides; both branches tested.
- Deferred: R15 GOES-East, R18 NWS zone bundle, R19-R21, EV-R11, EV-R12, V-R12, W16 (integration if time).

## Open problems
- none
- 23:45 CONTRACT §14 appended (14.0-14.15). Roles: us-catalog, us-web, us-official (first batch), us-pipeline (4th),
  validation (wave 2). New TS fields optional in wave 1 (integration makes 5 required).
- Next: plan3-roles.json, ownership script, PLAN-3.md, report, commit.
- 23:55 plan3-roles.json generated (5 roles); ownership check: wave 1 457 paths, 0 clashes; unowned only the
  package __init__ files and wave-2-only new files. Next: PLAN-3.md, report, commit.
