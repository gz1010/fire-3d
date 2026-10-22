# Fire-3d: notes for Claude

Fire-3d is a research prototype: a wildfire app built on real data.
- **Backend:** FastAPI with Python 3.12 (uv), in `backend/`.
- **Web app:** React 19 with MapLibre and three.js (R3F), in `web/`.

For each fire it builds a "bundle":
- terrain and fuels;
- satellite observations and official perimeters;
- weather;
- ensemble spread forecasts made with pyretechnics.

The bundles show in two workspaces: Public/Command (map-first) and Forensic (3D).

Start with these:
- `README.md`: features, how to run, data sources and licences.
- `SPEC.md`: data and API contracts. Keep `SPEC.md`, `backend/fire3d/contracts.py` and `web/src/api/types.ts` consistent.
- `docs/redesign/CONTRACT.md`: the UI contract. §13 has the brief-2 interfaces, and new work appends a section.
- `docs/validation.md`: forecast skill and how it is measured.
- `docs/redesign/BRIEF*.md`: the user's briefs and decisions. The newest brief is the current task. `docs/redesign/RUNBOOK-3.md` runs brief 3 in a cloud session.
- `docs/redesign/reports/*.json`: what each earlier build agent did, with its known issues.

## Run and test

- Backend tests: `cd backend && uv run pytest -q`
- Web gates: `cd web && npm run typecheck && npm run lint && npm test && npm run build`. The lint baseline is 55 warnings, all in `src/scene`; add none.
- API: `cd backend && FIRE3D_LIVE=0 uv run uvicorn fire3d.api.app:app --port <api-port>`
- Web: `cd web && VITE_API_TARGET=http://localhost:<api-port> PORT=<vite-port> npm run dev`
- Locally, `./dev.sh --no-live` starts both. It uses API 8710 and web 5173.
- Screenshots: `cd web && node scripts/shot.mjs "<url>" out.png --wait 9000`. View every screenshot. In the cloud there is no GPU, so add `--backend swiftshader`.
- Fire data:
  - `data/` is gitignored. Fire bundles live in `data/incidents/`.
  - Test fixtures: `cd backend && uv run python scripts/make_fixture.py`
  - A real fire: `cd backend && uv run python -m fire3d.cli build <incident-id>`. It takes 1-3 minutes and makes many public downloads.

## Rules (strict)

- **Safety wording:**
  - Model output is experimental and never advice on when to evacuate ("Follow local officials").
  - Never say "safe" or "low risk". Outside the modeled area is unknown, not low.
  - Official information (evacuation orders, agency fire records, NWS alerts) keeps its issuer, its own times, its verbatim wording and a link. It is never merged with model output, and its absence is never an all-clear.
- **Data sources:**
  - No Google data, no paid map services, no Nominatim.
  - Credit every source, and check the terms of any new source on its official page.
  - Use polite request rates through `fire3d.http`, which caches.
- **Secrets:**
  - The only secret is `FIRMS_MAP_KEY`. It comes from the environment or the gitignored `.env`.
  - Never print, log, commit or copy it. Check for leaks with count-only scans.
- **Naming:** never use the name "FireTrace" (the name of the reference demo).
- **Git:** never commit `data/` or `.env`. Add a dependency only when it is clearly needed, and say why.
- **Running locally:**
  - Port 8000 belongs to another app: never use it.
  - Ports 8710, 5173 and 5180 are the user's own Fire-3d servers.
  - The user owns git: commit only when asked.
- **In cloud sessions:** commit your work to the session branch with clear messages and push it often. Never force-push.

## Working with this user

- The user is new to wildfire science and 3D maps. Explain in plain words, in small steps. Quality matters more than speed or cost.
- Before planning big work, ask a short round of multiple-choice questions. Then build in one pass, with no multi-week phases.
- During long multi-agent builds, keep chat updates short: milestones, decisions and problems.
