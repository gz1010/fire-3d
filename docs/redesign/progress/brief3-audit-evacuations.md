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

## Revision pass (critic review), started 2026-10-22 ~22:00 UTC
Done so far (evidence in the session scratchpad audit-evacuations/):
- Verified critic points in code: evac_status_key('No Evacuation Order') == 'order'; 'Not Reporting' / 'Mandatory
  Evacuation' -> 'other'; outFields at extras.py:610; insideCalifornia rectangle (model.ts:166-168) gates :160, :209,
  :393, :425; offline Reno flow -> 'available', 0 zones, Cal OES caveats; Cal OES strings 85 lines / 19 files.
- WA: server sends only its leaf certificate (openssl through the proxy shows the server's own DigiCert chain, depth 0
  only); with certifi + the public DigiCert G2 intermediate the service reads: 583 rows, 73 Active (68 with null
  evactype, automated), max dateedited 2026-10-22T22:03Z; full licence includes indemnification + as-is.
- OR: live item licence "Public" only; 2026 history item c8b3c502f58045269f32737fa8f5c025 (no licence text),
  5-min snapshots; sample query recipe tested (Fielders Mountain, 2026-08-15T12:01Z); last_edited_date is a
  recalculation time; Fire_Name null in 51% of history rows; one non-fire hazard (HWY 229 Landslide, Other).
- AZ: Emergency_Evacuation_Zones_View_Only is a view of Arizona_Evacuation_Zones (same edits/counts); no data edit
  after 2026-02-12 while Coconino/Cochise sent 7 fire IPAWS messages in 2026; July export all 'None'.
- IPAWS page: no MOA (remove the remark).
Next: per-state web searches (log them), Reno screenshot, rewrite the audit, report JSON, commit.
