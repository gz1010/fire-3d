# brief3-audit-evacuations progress

## Done
- Read BRIEF-3, CONTRACT §12 / brief-2 official sections, backend extras.py evacuation code, web official/model.ts.
- ArcGIS Online catalogue searches (per state + keyword) and polite tests (2026-10-22):
  - OR: OEM "Evacuation Areas Public" (statewide, live, count 0 today; last data edit 2026-09-29). AVAILABLE.
  - WA: SEOC "Evacuation_Zone_Level" on wise.wamil.us (statewide aggregation, "updated daily"); TLS chain fails
    from the sandbox (curl 60 / Python CERTIFICATE_VERIFY_FAILED); fields from the state's public web map. PARTIAL/UNVERIFIED.
  - FL: FDEM SERT county-level evacuation status (WebEOC, 87 rows, all "Not Reporting"), KYZ zones STATUS blank:
    hurricane-oriented. PARTIAL (county-level).
  - AZ: DEMA layers dormant (2020) or stale (12 zones Go/Set since 2025-09-25, TEST row, PII columns). NONE.
  - NC: NCEM coastal KYZ mandatory evacuations MapServer errors on query; hurricane only. NONE (wildfire).
  - CO: DHSEM per-fire ad-hoc layers only. MO: SEMA template, 10 placeholder rows. NM: per-declaration layer.
- National: NWS API (7-day window; only ~5% of IPAWS FRW/EVI reach NWEM channel), IPAWS public feed (works without key,
  FEMA asks to register), OpenFEMA IPAWS archive (24 h delay; 2,233 FRW/EVI 2024-2026; by state counts).
- Wrote docs/redesign/audit-3/evacuations.md (summary, what exists, findings, gaps G1-G10, adapter shape + field
  mapping, recommendations R1-R10, questions Q1-Q5, 47-row state table, evidence log).
- Wrote docs/redesign/reports/brief3-audit-evacuations.json.

## Next
- Commit the three files (audit, progress, report). Then done.

## Decisions
- No secrets involved. No servers started. No project code changed. Gates not run (no code changed).
- Classification: OR available; WA, FL partial; UT blocked (Genasys counties); 43 none.

## Open problems
- WA service unverifiable from the sandbox (TLS). Needs a check from the user's machine (Q2).
