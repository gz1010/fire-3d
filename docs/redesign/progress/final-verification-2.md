# final-verification-2 progress (role: final verification after brief 2; API 8718, Vite 5187; live loop allowed)

Only agent on the repo. Prompt: scratchpad v7/prompts/final-verification.md.
Report: docs/redesign/reports/final-verification.json. User preview 5180/8710 and port 8000: never touch.

## Done
- 2026-10-18: read the prompt and brief2-integration.json (notes_for_integrator = TODO list).
- 15:45 Read BRIEF-2, PLAN-2, BRIEF, all brief2-* reports, readme / backend-followups / ui-integration reports,
  CONTRACT §13, SPEC §5-8, validation.md, README. Scripts copied to scratchpad fv2/ (js, map, shell, loc; BASE 5187).
- 15:46 Baseline gates: tsc 0; lint 55 warnings (all src/scene); vitest 56 files / 680; pytest 601 passed (37 s).
- 15:46 User preview 8710/5180 runs FIRE3D_LIVE=0 (no competing live loop). Dry run of the startup auto-build:
  candidates Cooley, Norte, Henderson, all already prepared -> builds nothing (so the default auto-build stays on).
- 15:47 API 8718 (FIRE3D_LIVE=1) + Vite 5187. First cycle: CAL FIRE summaries synced (Cooley 1,036.8 ac, Henderson
  65 %, Norte 50 %), 3 refreshes queued, new forecasts 2503 / 011e / fa71 (7.6 / 29.5 / 10.1 s), unlisted old runs
  pruned (f6cf, 1c75, 4fde, 6842). CAL FIRE history: my dry run (a check) appended Cooley 1,036.8 ac and Norte's new
  update time at 15:45; the cycle at 15:46:58 found no new change (no duplicate line).
- 15:48 Opening (opening.mjs): Public aerial z5.15, 85 markers / 7 active, 25 label layers, Official now California
  quiet; filters Active 7 / 2026 season 85 / 2025 78; Henderson marker -> card + flight z10.72; Timber card offers
  Prepare (not pressed); Command dark z5.23; phone z4.57 peek. 0 errors, 0 non-GET.
- 15:52 Prepared ONE fire from its card: 2026-cyrus-fire-880d63 (live, 543 ac, 96 %): 1 POST, 159 s, 0 errors;
  framed z13.55, 2,242 burned px, 541 ac observed vs CAL FIRE 543, 40 detections, 1 WFIGS perimeter, first forecast
  fc-20261018T1700-gfs025-5b49 (6.2 s). Progress card seen (screenshots fv2/out/prep-*.png).
- 15:58 Decision 10 live (zoom.mjs): Eaton by wheel (z9.83 unchanged, 28,307 px, no history step), drag -> Palisades,
  z6.6 -> overview unchanged, Henderson (7,076 px, nearby 1), Cooley (8,524 px), Timber chip -> card; Cyrus by wheel
  (zoomcyrus.mjs) focused, camera unchanged, 2,242 px, out -> overview. 0 errors, 0 non-GET.

## Next
- Nothing for this role: report docs/redesign/reports/final-verification.json is the hand-off.

## Decisions
- Live loop with the default startup auto-build: the dry run showed every candidate already prepared (no build).
- The one fire prepared from its card: 2026 Cyrus Fire (small, live, 2026).
- DoF frame rate: measured and reported, not optimised (no identical-image change found; a lower pixel budget or
  medium quality would change the image).
- "Malibu" -> Bryson via zoom focus is decision-10 behaviour (the search itself opens and builds nothing); documented.
- validation.md corrected to the code's outputs (5.2 from the published bundles, 5.3 Madre rows from the operational
  re-run); README per-lead scores filled from the same re-run.
- The whole-API-down "Checking…" state is documented, not fixed (edge case; banner explains; would touch several
  official model functions).

- 16:00 Forecast from the UI (Forensic > Analysis > Run 48 h forecast) on Cyrus: 1 POST, fc-20261018T1700-gfs025-e149
  in 7.9 s, auto-selected; map timeline +72h disabled, legend "by Oct 20, 10:00 PDT". Aircraft: Cooley none (adsb.fi),
  Henderson 1 "low & slow", Cyrus honest outage note, Eaton "live incidents only".
- 16:05 Search + card (loc/flows.mjs, search2.mjs, malibu.mjs, card.mjs): address, ZIP 91001, Altadena, coordinates,
  "Eaton Fire" (explicit open, Back), overview nearest fires, Escape/edit/click cancel, 504 plain words; "Malibu" never
  opens or builds: the only incident change is a zoom focus 5 s later (src zoom, no history, no card; decision 10).
  Official-line states listed / none listed / not checked / past date / unavailable; strip full / compact / line.
- 16:08 Official now + feed (official.mjs): Henderson order 14 mi, Cooley "1,037 acres (was 731)", Norte "50 % (was
  25 %)", Eaton archived RFW + FWW, 15 outlines, IEM credit; filters; phone badges 1 / 2 / none.
- 16:12 Sweep (sweep.mjs): 2 presets x 2 perspectives x 3 basemaps x 2 viewports + Forensic 3D/2D: 0 errors, 0 non-GET.
- 16:15 Outages (outage.mjs, outage2.mjs): OpenFreeMap style / tiles, Mapterhorn (flat map), USGS (dark + Try aerial
  again), Cal OES, NWS, IEM, CAL FIRE record and lists, missing bundle files, whole API down: honest states, 0 errors.
- 16:20 validation.md vs code: 5.1 (31 members) and 6.2 (pseudo-live) reproduced exactly; 6.3 reproduced (0.432 /
  0.825 / 1.85); FIXED 5.2 (+24/+72 h rows did not match the published bundles) and 5.3 (8 Madre rows predated the
  growth-only hold); added the per-lead values of the current single run (0.341 / 0.425 / 0.476 / 0.485).
- 16:22 FIXES: forecast warning formula text "0.5 x (floor 0.1 + e^..)" -> "0.5 x (0.1 + 0.9 x e^(-lead/12 h))"
  (spread/ensemble.py + test); Official now compact CAL FIRE line said "No record for this fire." during outages
  -> "Unavailable right now." (official/calfire.ts unreachable flag, officialSummary.ts + tests); aircraft polled only
  in Forensic (state/runtime.ts, App.tsx); build cards say "Preparing the analysis" / "Prepare analysis (1-3 min)"
  (ui/Overlays.tsx).

- 16:28 Rendering/UX: Forensic DoF fps at DPR 2, 1440x900 (doffps.mjs; hybrid default look, Eaton): uncapped
  high+DoF 55.6 (17.9 ms median), high 66.7, medium+DoF 68.0, medium 82.6, low 158; capped (60 Hz) high+DoF 50, all
  others 60. Realistic look: high+DoF 37.4, high 50.9, medium+DoF 44-56, medium 85.6, low 153.6 (uncapped). No
  optimisation: nothing found that keeps the image identical (decision: report only). Map (mapfps.mjs, Eaton, DPR 1,
  uncapped): 2D 372 fps (1.5 ms render), 3D 105-107, playback 114, 0 idle renders. Keyboard (keys.mjs, keys2.mjs) OK;
  reduced motion same view (3 vs 83 move events); contrast min 6.30 (Public roads) .. 7.20; open map 75.7-77.5 % on
  all 13 bundles (Eaton/Palisades 75.7).
- 16:35 Contracts/security: live answers of 8718 validated against contracts.py (16 endpoints incl. official live,
  archive, statewide, lists, Cyrus detail): 0 problems, 0 key; count-only key scan 8,112 file entries: 0.
  FIXES: credits in the app now include NASA CMR (live pass times) and pyretechnics (engine, version, EPL-2.0) in the
  "Data sources" note (lib/dataCredits.ts, ui/DataCredits.tsx + test); compact legend row "3D shapes: today's OSM,
  not a damage assessment" with the full caveat as tooltip (map/MapLegend.tsx); CAL FIRE change rows keep CAL
  FIRE's precision ("1,037 acres (was 1,036.8)", seen live on Cooley) (official/calfire.ts + test).
- 16:37 Live loop: cycles 15:47, 16:02, 16:17, 16:32 clean; Cooley summary synced twice; CAL FIRE history appends
  only on changes (Cooley 6 lines incl. 1,036.8 -> 1,037.0 at 16:17).

- 16:48 README updated (not rewritten): intro, screenshots (hero brief2-final-zoom-focus-eaton-1440, Command
  brief2-final-card-eaton-burned-home-command-1440, Forensic brief2-final-forensic-key-events-1440), "Start on the
  California map" (overview, zoom to see the spread, fire card + Prepare analysis), Public (aerial default + photo
  date, 3D buildings caveat, search kinds, four-part card, Official now, satellite chip), Command, Forensic, first run,
  settings (FIRE3D_NWS_CONTACT, data/official/calfire, gazetteer rebuild), address-bar options, data flow, API table
  (/api/official/*, year=, geocode towns/ZIPs), architecture tables, per-lead scores, limitations, troubleshooting,
  data sources (NWS, IEM, Census Gazetteer; OSM buildings); all 3 remaining verify markers resolved (CAL FIRE via the
  State of California conditions of use; WFIGS ArcGIS item licence = NIFC disclaimer; LANDFIRE). 0 verify left.
- 16:51 Retook docs/screenshots/brief2-final-3d-buildings-1440.png (new legend wording). Opening probe with delayed
  bundle JSON (+2 s), rasters (+3 s) and lists (+1.5 s): same camera z11.58 in 2/2 runs (plain 2/2).

- 16:55 CONTRACT §13 "final verification" sub-heading (the small changes); SPEC §6 gained pointer rows for
  /api/geocode (towns/ZIPs) and /api/extras (no contract change). Lint 55 (src/scene). Phone decision 10 (zoom.mjs
  390x844): same results, 0 stale frames. Credits note verified in the Analysis drawer (Henderson: + NASA Earthdata CMR,
  + pyretechnics 2026.8.10 EPL-2.0) and Forensic Evidence (Eaton), 3 lines, fits.

- 16:59 Final gates (after the last code edit): tsc 0; lint 55 (0 outside src/scene); vitest 56 files / 681; build OK
  (main 439.11 kB, 0 WebGLRenderer); pytest 603 passed (41 s; +2 = Cyrus cases of the real-bundle walks). Key scan
  8,128 file entries incl. the new web/dist: 0. Map fps at DPR 2 (mapfps2.mjs): 2D 263, 3D 60-70, playback 78-96.
- 17:08 Cadence (cadence.mjs, 11 min each): overview live list 0/300/600 s, statewide NWS every 2 min, live status 60 s;
  Henderson NWS + evacuations 2 min, CAL FIRE + live list 5 min, detail 60 s, imagery once, no aircraft requests in the
  map workspace; 0 non-GET, 0 errors. Servers 8718 / 5187 stopped (clean shutdown, live loop stopped); 5180 / 8710
  untouched; data/ 768 MB; CAL FIRE history 15 files / 27 lines. Report written.

## Findings to fix (collected; fix in order a-e)
- (fixed) build card wording; CAL FIRE outage line; aircraft polling; multiplier formula text; validation 5.2/5.3.
- open: with the whole Fire-3d API down, Official now keeps "Checking…" for evacuations / NWS (banner says the API is
  unreachable); documented, not fixed.

## Open problems
- No live Red Flag Warning in California during the test (live NWS on screen not seen; covered by samples + archive).
- Forensic high + DoF at DPR 2: ~50 fps (hybrid), ~37 uncapped (realistic).
