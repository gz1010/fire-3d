# Brief 3 orchestrator progress (cloud session)

Branch: `claude/cool-mayer-ki7to6`. Runbook: `docs/redesign/RUNBOOK-3.md`.

## Done
- Setup (2026-10-22): deps installed (log ends `done`, no `!!`), FIRMS key set (count-only), network OK for NWS,
  LFPS, FIRMS, Open-Meteo, ArcGIS; Chrome 156 installed (shot.mjs works with `--backend swiftshader`).
- Found a setup gap: the unanchored `data/` rule in `.gitignore` had kept `backend/tests/data/` (recorded samples)
  and `web/src/data/` (`rasters.ts` source + test) out of git, so a fresh clone failed typecheck/build and ~70
  backend tests. Fixed the rule to `/data/` (8d87f45) and recreated the files:
  - `web/src/data/rasters.ts` + `rasters.test.ts` from CONTRACT §10 and every importer (85bae50);
  - `backend/tests/data/firedata/*` re-recorded from CAL FIRE / FIRMS, synthetic WFIGS "Test Fire" (170e66a);
  - `backend/tests/data/official/*` and `terrain/*` re-recorded from NWS / IEM / Earth Search (910fe45, 630f9eb).
  - Each was reviewed by an independent skeptic: no existing test edited, no blocking issue; key scan 0.
  - The user must back up their local `backend/tests/data/` and `web/src/data/` before merging (git overwrites
    ignored files).
- Reference fires built in the cloud: 2025-eaton-fire-dbfa57 (60 s), 2025-palisades-fire-abfed7 (50 s).
- Audit A3 evacuations done (6670f47).

## Carry-over items for later stages (integration unless a role owns the file)
- `web/src/data/rasters.test.ts`: add tests for (a) useRasterSet reloading when the key changes (needs an
  effect-running harness; no new dependency), (b) a single layer larger than the 256 MiB cap stays cached,
  (c) two layer names sharing one URL each keep their own name. (minor, from the restore skeptic)
- Baseline counts after restore: see "Gates" below.

## User questions
- Asked and answered 2026-10-22 ~21:50 UTC (8 questions from the four audits); recorded in BRIEF-3.md
  "Decisions round 2", with the defaults taken. Validation is now 12 fires (task D).

## Gates
- After restore (2026-10-22): backend 585 passed (your Mac ~605: test_official_real_bundles and test_endpoint_contracts run once per bundle in data/incidents; the cloud has 4 bundles); web 56 files, 694 passed + 2 skipped; typecheck 0; lint 55 warnings, all in src/scene; build OK.

## Risks
- **Open-Meteo daily cap on the shared cloud egress (found 2026-10-22).** Archive (ERA5) and historical-forecast
  (HRRR) answered `429 Daily API request limit exceeded. Please try again tomorrow.` at 22:21 UTC; the live
  forecast API still answered. Builds at 20:40 worked. Our own use is small (Eaton + Palisades: 32 cached
  Open-Meteo requests), so other cloud users sharing the IP exhaust the 10,000/day cap. Plan: the pipeline role
  makes daily-limit refusals explicit (no silent ERA5 fill, no cached error bodies, a quota probe, `--require-hrrr`);
  smoke and validation builds run after a quota probe succeeds; if the cap blocks validation for long, consider a
  NOAA HRRR (AWS Open Data) fallback or finishing validation on the user's Mac.
