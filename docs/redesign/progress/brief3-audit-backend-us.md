# brief3 audit-backend-us progress

## Done
- (2026-10-22) read brief 3, CLAUDE.md, evacuations/web/validation audits; read backend CA assumptions.
- 45 polite live GETs (log summarized in audit-3/backend.md section 7; raw log in the session scratchpad).
- Local API on 8711 (FIRE3D_LIVE=0): 11 GETs, 0 non-GET; 2 screenshots; API stopped.
- Wrote docs/redesign/audit-3/backend.md; report docs/redesign/reports/brief3-audit-backend-us.json.

## Next
- none (stage A complete); planner consumes R1-R21 and Q1-Q5.

## Decisions
- No code changes (stage A); gates skipped (no code).
- Contract field names aligned with web.md 3.4 (`time_zone`, `record_source`, `uid`) and validation.md 5 (`gacc`,
  `accuracy_region`).
- Time zone: BTS NTAD polygons (public domain) + Arizona/Navajo/Hopi rule, not NWS /points.

## Open problems
- Navajo/Hopi AIANNH polygons not fetched (size unverified, expected small).
- Open-Meteo per-location counting of multi-point requests unclear on its pricing page; budget conservatively.
- LF2025 SC/SE/NC/NE release date (Nov 2026 per landfire.gov) may move.

## Revision pass (2026-10-22, after the independent critic)
- Started: verifying each critic point (10 missing, 5 wrong, 8 weak, question fixes) against code and data.
- Scratch: scratchpad/audit-backend-us/rev/.
