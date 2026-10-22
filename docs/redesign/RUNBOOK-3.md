# Runbook: brief 3 (fires across the lower 48 states) in a Claude Code cloud session

You are the **orchestrator**. The user started this cloud session so the build can run while their Mac is closed. Follow this runbook from top to bottom, running stages through subagents.

The user's request and decisions are in `docs/redesign/BRIEF-3.md`; they are the authority.
- The user said "go for it": build straight through.
- Stop only for a decision only the user can make, or a missing setup item (section 0).
- Report at milestones: setup done, build done, validation done, final check done.
- Keep messages short and in plain words. The user is new to wildfire science and 3D maps.

## 0. Check the setup (before anything else)

1. Read `CLAUDE.md`, `docs/redesign/BRIEF-3.md` and this runbook fully.
2. **Dependencies.** The SessionStart hook `.claude/hooks/cloud_install.sh` installs them.
   - Read `/tmp/fire3d-cloud-install.log`: it must end with `done` and contain no `!!` lines.
   - If something failed, rerun the failing step yourself:
     - `cd backend && uv sync --frozen --python 3.12`
     - `cd web && npm ci`
3. **NASA FIRMS key, without printing it:**
   ```bash
   python3 -c "import os; print('FIRMS key set' if os.environ.get('FIRMS_MAP_KEY') else 'FIRMS key MISSING')"
   ```
   If it is missing, stop and ask the user to add `FIRMS_MAP_KEY` to the environment's variables (`docs/cloud/SETUP.md`, step 2).
4. **Network.** One quick request each to `https://api.weather.gov`, `https://lfps.usgs.gov`, `https://firms.modaps.eosdis.nasa.gov`, `https://api.open-meteo.com` and `https://services3.arcgis.com`.
   - If they are blocked, stop and ask the user to set **Network access: Full** (`docs/cloud/SETUP.md`, step 2).
5. **Chrome for screenshots.** Run `google-chrome --version`, or check that `node web/scripts/shot.mjs` launches.
   - If Chrome is missing, run `cd web && npx playwright install --with-deps chrome` (root may be required). Or point `scripts/shot.mjs` at Playwright's bundled Chromium as a fallback, and commit that change.
6. **Test fixtures and baseline gates** (`data/` is not in git):
   - `cd backend && uv run python scripts/make_fixture.py`
   - `cd backend && uv run pytest -q`
   - `cd web && npm run typecheck && npm run lint && npm test && npm run build`
   - Record the numbers. They should match the last local run (about 605 backend tests, 681 web tests, 55 lint warnings in src/scene). If they don't, investigate before building.
7. Tell the user one line: setup OK, starting the audit.

## 1. Rebuild reference fires (California regression set)

The cloud machine starts without the user's fire data. Build these with the CLI, one at a time, in the background:
- `cd backend && uv run python -m fire3d.cli build 2025-eaton-fire-dbfa57`
- `cd backend && uv run python -m fire3d.cli build 2025-palisades-fire-abfed7`

Each takes 1-3 minutes and makes many public downloads. The CLI also accepts names; check `uv run python -m fire3d.cli build --help`.

They give later stages known California fires to check that nothing regressed. Live California fires can be added later, through the API, by the stage that needs them.

## 2. How to run the stages

- **Subagents:** if the Workflow tool is available, encode stages A-F as a workflow. Otherwise spawn background general-purpose subagents with the Agent tool, and wait for their completion notifications.
- **Prompts:** each agent's prompt is the COMMON block (section 3) plus its role prompt (sections 4-9). Pass paths, not large pasted documents; agents read the files.
- **Concurrency:** the VM has about 4 vCPUs, 16 GB of RAM and no GPU. Run at most 3 agents at once.
- **Ports:** give each running agent its own ports. API 8711-8716 and Vite 5181-5186 are free in the cloud; never use 8000.
- **File ownership:** two agents never edit the same file. Ownership comes from the plan (stage B).
- **Git:**
  - Agents commit only their own files at milestones. The COMMON block says how.
  - After each stage, you check the reports exist, run the gates yourself if code changed, commit any leftovers (specific paths, never `data/` or `.env`), and **push**.
  - Push whenever you pause, so a rebuilt VM loses nothing.
  - Never force-push. Never merge into `main`. Don't open a pull request unless the user asks.
- **Usage limits:** agents fail with a message about the session or usage limit.
  1. Commit and push what exists.
  2. Tell the user in one line, with the reset time.
  3. Wait for "continue".
  4. Resume the stopped agents with SendMessage; they keep their context. If that's impossible, relaunch them with a note to continue from their progress log.
- **Problems:** if an agent reports something only the user can decide, ask the user, briefly, with your recommendation.

## 3. COMMON block (paste at the top of every agent prompt)

```text
You are one of several agents building brief 3 for "Fire-3d" in a Claude Code cloud session. The repository root is your working directory.

Fire-3d is a research prototype wildfire app:
- a FastAPI backend (backend/, Python 3.12, uv);
- a React + MapLibre web app (web/), with two workspaces: Public/Command (map-first, two presets) and Forensic (3D scene).
Today it covers California only. Brief 3 extends fire coverage to the lower 48 US states.

Read first:
- CLAUDE.md: project rules.
- docs/redesign/BRIEF-3.md: the user's request and four decisions. This is the authority.
- README.md, docs/redesign/CONTRACT.md (§13, and §14 once the planner writes it), SPEC.md and docs/validation.md.
- docs/redesign/BRIEF-2.md: standing UI decisions.
- The reports in docs/redesign/reports/*.json that are relevant to your files.

Rules (strict):
- Safety wording:
  - Model output is experimental and never advice on when to evacuate ("Follow local officials").
  - Never say "safe" or "low risk". Outside the modeled area is unknown, not low.
  - Official information keeps its issuer, its own times, verbatim wording and a link. It is never merged with model output, and its absence is never an all-clear.
  - Where a state has no official evacuation data, say "not available in this state".
- Sources:
  - No Google data, no paid map services, no Nominatim. Credit every source.
  - Verify the terms of any new source on its official page and cite it.
  - Polite request rates through fire3d.http, which caches.
- FIRMS_MAP_KEY comes from the environment. Never print, log, commit or copy it; use count-only checks.
- Never use the name "FireTrace".
- Fires now span several US time zones: never assume Pacific time.
- Ownership: edit only files your role owns. Read anything. If a file you don't own needs a change, describe it exactly in your report (notes_for_integrator).
- Dependencies: no new ones unless your role allows it; report the need instead.
- Git:
  - Commit only your own files: git add -- <paths> && git commit -m "brief 3 <role>: <what>".
  - Never git add -A, never commit data/ or .env, never push (the orchestrator pushes).
  - If git reports an index.lock, wait a few seconds and retry.
- Ports: use only the ones in your role prompt. Start APIs with FIRE3D_LIVE=0 unless your role allows the live loop. Kill every process you start before finishing.
- No GPU:
  - Take screenshots with: cd web && node scripts/shot.mjs "<url>" <out.png> --wait 12000 --backend swiftshader. View each one with the Read tool.
  - Frame-rate measurements are not meaningful here: say so instead of reporting numbers.
- Building fires:
  - Never trigger a fire build except where your role explicitly allows it.
  - In browser checks, never press "Prepare analysis" unless your role allows it.
  - Count non-GET requests in your browser runs.
- Gates before you report: cd web && npm run typecheck && npm run lint (no new warnings; baseline 55, all in src/scene) && npm test && npm run build, and cd backend && uv run pytest -q. Add unit tests for every new piece of logic.
- Usage hygiene that never lowers quality: keep tool output small, write big outputs to files, and run long jobs in the background.
- Interruptions: keep docs/redesign/progress/brief3-<role>.md (done / next / decisions / open problems) and update it after each milestone. If you are restarted, continue from it.
- Report: write your final report as JSON to docs/redesign/reports/brief3-<role>.json, then return the same JSON as your final message.
  - Keys: summary, files, verification (specific commands, numbers and screenshot paths), screenshots, contract_deviations, known_issues, notes_for_integrator.
```

## 4. Stage A: audits (read-only, 4 agents, at most 3 at once)

Each audit writes `docs/redesign/audit-3/<area>.md`, about 150-250 lines. Each one covers:
1. what exists, with file:line references;
2. gaps, each marked BLOCKER / INCOMPLETE / MISSING with evidence;
3. recommended changes, each with value, effort (S/M/L), risk, the files touched, and priority (P0/P1/P2);
4. questions only the user can answer.

They change no project files except their audit file and a few evidence screenshots (`docs/screenshots/audit3-<area>-*.png`).

**A1 `audit-backend-us`** (API 8711):
- Find every California-specific assumption in backend/ and SPEC.md that blocks lower-48 coverage, and design the generalization.
- National incident list:
  - Evaluate NIFC WFIGS: current and year-to-date incident locations, and perimeters.
  - Key fields: IncidentSize/DailyAcres, PercentContained, FireDiscoveryDateTime, IncidentTypeCategory (WF vs RX), POOState, UniqueFireIdentifier.
  - Also its terms, refresh cadence, field quality, and how California fires dedupe against CAL FIRE (keep CAL FIRE as the source for California?).
- Build sources and their coverage outside California: 3DEP, LANDFIRE (CONUS versions), NAIP, Sentinel-2 dNBR, FIRMS area queries, WFIGS perimeters, Open-Meteo HRRR history and forecasts plus ensembles, and CMR satellite passes.
- Hard-coded California assumptions: bounding boxes, UTM zones (only 10/11?), time zones (America/Los_Angeles?).
- The live loop at national scale: auto-build candidates and caps.
- Official sources:
  - Cal OES evacuations are California only.
  - The CAL FIRE history recorder needs a national equivalent from WFIGS.
  - NWS requests use `area=CA`; make them national. Also the IEM archive.
- Extras: cameras are California-only.
- The Gazetteer: grow it from California to all states (size, format, build script).
- Contracts, and tests that assume California.
- Make 2-3 polite live requests per new source to confirm fields and coverage.
- Write `audit-3/backend.md`.

**A2 `audit-web-us`** (API 8712 with FIRE3D_LIVE=0, Vite 5182):
- Find every California-specific assumption in web/:
  - the overview: bounds and fit, "California · all fires", the Active / 2026 / 2025 filters, marker sizing, labels and decluttering. The user chose fires of 300 acres or more nationally, so expect a few thousand markers a year: clustering and performance matter.
  - time handling: every place a time zone is shown or assumed (timeline, feed, card, charts, Forensic).
  - search: the town/ZIP Gazetteer covers California only; the Census geocoder is national; incident search must work across states.
  - official UI: Cal OES wording, "Official now · California", evacuation availability per state, and California-only cameras.
  - state names, the incident picker, URLs, legends and credits.
  - reprojection tests: only UTM zones 10 and 11 are tested so far.
- Write `audit-3/web.md`.

**A3 `audit-evacuations`** (research only, no servers):
- For each of the 47 other lower-48 states, find whether an official state or statewide agency publishes current evacuation zones or orders as a free, public, machine-readable service (ArcGIS FeatureServer, GeoJSON, CAP) whose terms allow display.
- Official sources only. Record for each:
  - URL and owner;
  - fields: status wording and update time;
  - coverage (statewide or partial) and refresh rate;
  - licence or terms, quoted.
  - Test each with one polite request.
- Vendor or county systems that need agreements (for example Genasys Protect) count as blocked.
- Design one adapter shape that matches the existing extras envelope (CONTRACT §12).
- Write `audit-3/evacuations.md`, with a table per state: available / partial / none / blocked.

**A4 `audit-validation`** (a few polite data checks; no bundle builds):
- Read docs/validation.md and backend/fire3d/spread/validate.py.
- Propose 8-10 past lower-48 fires outside California. Cover at least Pacific Northwest timber, the Northern Rockies, the Great Basin, the Southwest, the Southern Plains and the Southeast.
- Prefer 2024-2025 fires with:
  - several dated perimeters;
  - dense FIRMS detections;
  - a clear spread period;
  - HRRR weather history available (check Open-Meteo's archive dates).
- For each fire: dates, size, fuel, why it is a good test, data evidence, and difficulties.
- Define the per-region accuracy label the app should show: how it is computed, its sample size, and honest wording.
- Write `audit-3/validation.md`.

## 5. Stage B: plan (1 agent, `planner`)

Prompt: COMMON plus the following.

```text
ROLE: planner. No code changes; you write only the plan and contract docs.
Read the four audits in docs/redesign/audit-3/ fully, plus BRIEF-3.md.

Write docs/redesign/PLAN-3.md: a prioritized plan for lower-48 fire coverage that honors all four decisions. Order the work:
1. the national fire list, and preparing fires anywhere in the lower 48;
2. time zones and search;
3. state evacuation feeds and per-region accuracy labels;
4. polish.

Append "14. Brief 3 (US) interfaces" to docs/redesign/CONTRACT.md. Fix every shared interface between build roles (endpoint shapes, store fields, shared helpers such as one time-zone formatter, data files such as the regional accuracy file), so roles can work in parallel without editing the same files.

Define build roles in docs/redesign/plan3-roles.json:
{ "roles": [ { "label", "title", "wave", "owns": [globs], "tasks": "markdown with acceptance checks", "read": [paths] } ] }
- Wave 1: at most 4 roles with disjoint file ownership. Name the one backend role that owns the pipeline and may build at most 3 smoke-test fires outside California.
- Wave 2: exactly one role labelled "validation". It is backend only. It builds the 8-10 test fires after wave 1 lands, runs the validation protocol, and writes docs/validation.md and the regional accuracy data file.
- Cloud constraints: no GPU, 4 vCPUs. Plan screenshot checks with swiftshader, and leave frame-rate checks for a later local run.

Return a short summary.
```

Then check `PLAN-3.md`, `CONTRACT.md` §14 and `plan3-roles.json`. Commit and push.

## 6. Stage C: build wave 1 (at most 3 agents at once)

For each wave-1 role in `plan3-roles.json`, spawn an agent with COMMON plus:

```text
ROLE: <label>: <title>. Ports: API <871x>, Vite <518x>.
You own: <owns>. Read: <read>, docs/redesign/PLAN-3.md and docs/redesign/CONTRACT.md §14.
The §14 interfaces are fixed: implement or consume them exactly, and document what you built under your own sub-heading in §14 (append only).
Tasks:
<tasks>
Builds: only the pipeline role named in PLAN-3 may build fires, and at most 3 small smoke-test fires outside California. Nobody else builds.
```

If there are 4 roles, start the 4th when one finishes. Forward each finished agent's notes_for_integrator to the agents still running when they affect them, using SendMessage. When all have reported: run the gates, commit, push, and tell the user "build done" in one line.

## 7. Stage D: validation (1 agent, `validation`, API 8716)

COMMON plus the validation role from `plan3-roles.json`, plus:

```text
You may build fires with the CLI: the 8-10 test fires from docs/redesign/audit-3/validation.md, one at a time.
Run the validation protocol: hindcasts per fire and region, the same metrics as docs/validation.md, and pseudo-live checks where possible.
Write:
- a new docs/validation.md section with per-fire and per-region results, sample sizes and honest caveats;
- the regional accuracy data file defined in CONTRACT §14, with tests.
Regions with too few fires get "accuracy not yet tested here".
Don't tune the model to these fires unless it improves the California results too; report what you tried.
```

Commit, push, and tell the user "validation done" with the headline numbers.

## 8. Stage E: integration (1 agent, `integration`, API 8716, Vite 5186)

COMMON plus:

```text
ROLE: integration. You are now the only agent editing the repo. Read every docs/redesign/reports/brief3-*.json, plus PLAN-3.md and CONTRACT §14.
1. Resolve every notes_for_integrator item and every mismatch between the pieces.
2. Verify the whole brief on real data at 1440x900 and 390x844, in Public and Command:
   - the lower-48 overview: a few thousand markers, clustering, filters, wildfires only;
   - zooming in to see the spread on fires in several states: the validation fires plus California;
   - "Prepare analysis" cards for unprepared fires;
   - correct local time zones for fires outside the Pacific zone;
   - search (towns and ZIP codes in several states, addresses, fire names);
   - the location card and official information per state: evacuation feeds where available, "not available in this state" elsewhere, NWS everywhere;
   - per-region accuracy labels;
   - California regression on Eaton and Palisades, including overlay alignment in a non-10/11 UTM zone.
   Keyboard access and reduced motion still hold.
3. Gates pass. Take screenshots docs/screenshots/brief3-final-*.png and view each one.
```

Commit and push.

## 9. Stage F: final verification (1 agent, `final-verification`, API 8718, Vite 5188)

COMMON plus:

```text
ROLE: final-verification. You are the only agent; you may edit any file.
1. Full stack: the API with FIRE3D_LIVE=1 for one live-loop cycle nationally. Check that auto-build caps hold and that the official records history works nationally. Prepare at most ONE new fire from its card.
2. Review checklist, fixing what you find:
   a. science, units and time zones;
   b. safety wording, including per-state evacuation availability and accuracy labels;
   c. robustness: provider outages, including the new sources;
   d. contracts and security: the endpoint walk and a count-only key scan;
   e. credits and terms for every new source, in the app and the README.
3. Update the README: US coverage, the new sources and licences, limitations (Alaska and Hawaii not yet; accuracy by region; evacuation coverage by state). Update SPEC and docs where needed.
4. Gates pass. Write docs/redesign/reports/final-verification-3.json. Include "user_summary": a short plain-language summary of what changed, what was verified, and the remaining issues ranked by severity.
```

## 10. Finish

1. Run the gates once more.
2. Commit and push the session branch.
3. Post the final summary to the user: what changed, how it was verified, the remaining issues, the branch name, and how to get it locally ("merge the cloud branch", or `claude --teleport`).
4. Remind them that fire data built in the cloud stays in the cloud; locally, fires are prepared again with "Prepare analysis".
5. Leave `main` untouched.
