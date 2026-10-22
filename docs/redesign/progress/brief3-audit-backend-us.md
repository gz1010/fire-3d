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
- Verified (22:45-22:56 UTC): all 10 "missing" points confirmed; 5 "wrong" points confirmed (dedupe rerun: 2025
  -> 69 same fire, 8 complex children, 2 gaps; Timber IS on CAL FIRE's 2026 list, only IsActive=false);
  weak points accepted except R17 detail (GzipCache is file-keyed, so gzip in the JSON helper instead).
- 16 new polite GETs (rev/out/evidence.log): CA county->GACC, WFIGS per-record f=html, CAL FIRE 2026, AIANNH
  meta + Navajo/Hopi (55 KB), NWS FireZones page + reference map, PROJ CDN index (EGM96 2.7 MB, public domain),
  GIBS GOES-East domain + tile, CMR FL, Earth Search FL summer (23 items, 2 < 20 % cloud), WFIGS CA 2025 >= 1 ac.
  Web: Open-Meteo pricing + ensemble docs, PROJ-data us_nga README; 1 web search (NWCG unit ids).
- Offline checks: fire-weather 404 for a non-CAL FIRE id; Montana RFW listed "unplaced" for a Florida fire.
- Next: rewrite audit sections 0-8, report JSON (revision key), commit.
- Done (revision): audit rewritten (400 lines; sections 0-8, revision notes in 8); report JSON has a "revision" key;
  secret count-only scan 0. Committed with `brief 3 audit-backend-us: revise ...`.

## Next (after revision)
- none; planner consumes R1-R25 (14 P0) and open questions Q-A, Q-B. Orchestrator: BRIEF-3 D2-2 cites Timber wrongly.

## Open problems (revision)
- Big Cliff double-listing edge case; Open-Meteo ensemble member weighting unknown; NWCG code table wording unchecked.
