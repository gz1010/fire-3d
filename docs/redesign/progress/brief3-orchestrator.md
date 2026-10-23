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

## Stage status
- Stage A audits: done and each revised after an independent critic (2026-10-22).
- User questions: round 2 (8 answers) and round 3 (4 answers) recorded in BRIEF-3.md.
- Stage B plan: done (e021731), reviewed by two critics (41 problems), revised twice (d0f82a7, 02a4e00).
- Stage C wave 1 started 2026-10-23 00:30 UTC. Schedule change from CONTRACT §14.0 (orchestrator decision, to
  shorten the critical path to validation by about 4 h): first batch = us-catalog, us-web, us-pipeline;
  us-official takes the first free slot; then review+fix per role in finish order, us-pipeline's first.
  Consequence: us-web does not pass tf to us-official's 14.9.6 shims (they do not exist yet); the call sites are
  listed in us-web's notes_for_integrator for the integration to wire.
- 01:40 UTC: us-catalog finished (73 min; 829 backend, 835 web tests). us-official started in its slot.
  Review order: us-catalog, then the others as they finish (us-pipeline first among those).
- ~02:15 UTC: us-pipeline finished (Horse Gulch MT smoke build ready; Black Cove NC pending quota, handed to its
  review fixer). ~02:25: us-web finished. Reviews: us-catalog running, us-pipeline running; us-official still building.
- Open-Meteo in the cloud: refusals are intermittent (daily-limit 429 at 02:04, success at 02:13); host blocks are
  in-process only, so a fresh CLI build can retry. Validation must re-probe every ~10 min, not wait for midnight.
- ~02:50 UTC: the container restarted. Nothing committed was lost; data/incidents survived; deps reinstalled.
  Reviews of us-catalog and us-pipeline had committed their review3 reports (2dfb78e, b28e7f9; both fix-needed);
  their fixers were interrupted with uncommitted edits. Resumed both workflows from their journals (the fixer
  prompt now tells a re-run fixer to review its predecessor's uncommitted edits) and us-official via SendMessage.
- ~03:20 UTC: all four wave-1 roles finished (us-official 878 backend / 1,079 web tests). Reviews: us-catalog pass
  (4e3c8d6); us-pipeline fixer round 1 committed (20f33d3), Black Cove build in progress; us-web and us-official
  reviews running.
- The user's usage limit resets 2:20 AM EDT (06:20 UTC). Wake-ups scheduled at 06:25 and 07:25 UTC to resume
  automatically (stopped workflows from their journals, stopped agents via SendMessage).
- ~04:15 UTC: us-pipeline review pass (20f33d3, eab069d); Black Cove still pending (7 probes 02:57-03:59 all
  daily_limit). For the integration: R6 dataStatus/Official now Pacific times (check after us-official M6), R7 contract
  LocalAlert.polygon MultiPolygon, R8 resolve_listed outage says 'local or synthetic', N1 SPEC §8.4 text after R2/R3,
  R3 hourly re-check of daily blocks departs from §14.12.2 (decide). R4: an OpenFEMA sample had a real LEW naming a
  private person; replaced, but it stays in branch history (b12dd1e, private repo); user decision (squash-merge keeps it
  out of main).
- 04:20 UTC: validation started (Agent-tool agent) while us-web and us-official reviews run.
- ~04:35 UTC: us-web review pass after fixes (94c978f; R1 blocker: CAL FIRE's own status on the card when agencies
  disagree). For the integration: N1 credit NWCG names and NTAD zones also when a fire is open; N2 stale statements in
  us-web's report/progress (us-official's pieces have landed).
- ~05:00 UTC: the user's session usage limit stopped validation and the us-official re-check (round 2 fixes
  14f126d were committed). Before it, validation committed its pre-registration (29f0e2d) and built Black Cove (NC)
  and Emigrant (MT).
- 06:25 UTC (wake-up): validation resumed; us-official review resumed for its last re-check; integration part 1
  started early (orchestrator decision: everything except validation's files, API 8715 / Vite 5185), part 2 after
  validation does the end-to-end checks on the validation fires.
- Lesson: never SendMessage a workflow agent (it starts a second copy); relay through files or Agent-tool agents.

## Carry-over items for later stages (integration unless a role owns the file)
- `web/src/data/rasters.test.ts`: add tests for (a) useRasterSet reloading when the key changes (needs an
  effect-running harness; no new dependency), (b) a single layer larger than the 256 MiB cap stays cached,
  (c) two layer names sharing one URL each keep their own name. (minor, from the restore skeptic)
- Baseline counts after restore: see "Gates" below.
- From the us-catalog review (pass after fix round 1, 4e3c8d6), for the integration:
  - N1: SPEC.md lags us-pipeline's commit 20f33d3 in two passages (Open-Meteo limits text; OpenFEMA prefetch now in
    the background for API jobs).
  - N2: the new "several records" reason reads like a glitch when the WFIGS records share the fire's name (Lucas
    Fire, 2026-lucas-fire-21bc39, matched to two WFIGS records both named LUCAS): merge or pick, don't show it.
  - R4/R5 (us-official files): Official now block headed "California" nationally, NWS issue times in Pacific; a
    Florida WFIGS fire showed "CAL FIRE · No record" at 1c14914 (check after us-official's M4-M6).
  - CONTRACT §14.5: add the several-records case.
  - Hand-off: us-pipeline may now update backend/tests/test_api.py build-gate tests (us-catalog's review is
    done); its fixer was told to wait, so the integration does it if still needed.

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
