# Plan for brief 3: fires across the lower 48 states (Oct 22, 2026)

Built from the four audits in `docs/redesign/audit-3/` (backend, web, evacuations, validation; all revised after an
independent review) against `docs/redesign/BRIEF-3.md`: decisions 1-4, "Decisions round 2" and "Decisions round 3".
Audit IDs are kept: B- = backend.md, W = web.md, EV- = evacuations.md, V- = validation.md. Priorities: P0 is needed
for the brief, P1 should be done in the same build, P2 or "deferred" waits for a later brief. The shared interfaces
are fixed in `docs/redesign/CONTRACT.md` §14; the roles and their files are in `docs/redesign/plan3-roles.json`.

## Decisions this plan follows

- **Coverage**: the lower 48 states and DC now; Alaska, Hawaii and territories are not listed and say "not supported
  yet" (decision 1).
- **Fire list**: every currently active wildfire in the lower 48, whatever its size (round 2 item 1); the 2026 list
  and the 2025 filter at 300 acres or more (decision 2); wildfires only. California: CAL FIRE is the record and NIFC
  WFIGS adds only the fires CAL FIRE does not list (round 2 item 2).
  - A California fire is active when **either** agency says so, and the card shows each record with its own issuer,
    status and time (round 3 item 2; the Timber Fire is the example).
  - A California complex keeps **CAL FIRE's one row**, with its member fires named on the card (round 3 item 3).
    Elsewhere member fires are listed on their own, "part of the X Complex" (round 2 default).
- **Auto-built live fires**: keep 4, chosen from the whole country (round 2 item 4).
- **Accuracy**: 12 past fires outside California, two per region, plus a California baseline (round 2 item 3); words
  in Public with the score one tap away, the score in Command (round 2 item 7); "Accuracy not yet tested here" for
  Rocky Mountain, Eastern and Northern California and anything unassigned (round 2 default).
- **Evacuations**: state feeds only. **Oregon** is the only state feed besides Cal OES. **Washington is not built**
  (round 3 item 1: its terms' indemnification clause was declined), so it says "not available in this state" like
  Florida and every other state without a feed. Oregon zones stay current-only (round 3 item 4).
- **Local officials' messages**: no IPAWS registration; live, the messages the NWS relays (Fire Warning, Evacuation
  Immediate and similar); past days, FEMA's OpenFEMA archive, labelled archived (round 2 item 5). They show in every
  state, Washington included.
- **Clock**: 12-hour in Public ("3:40 PM MDT"), 24-hour in Command and Forensic ("15:40 MDT"), always in the fire's
  own time zone (round 2 item 8); never Pacific by default.
- **Defaults kept**: active fires group only with active fires; the national list shows the fires in the map view
  with "Show all"; phones open on the whole lower 48; cameras stay California-only ("not available in this state");
  county evacuation feeds are out of scope.

## What the audits found (short)

- **Every "which fires exist" path is California-only**: the catalog reads CAL FIRE only, FIRMS is cut to a CA box,
  perimeters ask for `US-CA`, NWS asks `area=CA`, UTM is zone 10 or 11, official lookups find only CAL FIRE records.
- **NIFC WFIGS can be the national list**: 1,178 wildfires of 300 ac or more in 2026 (35 states), 861 in 2025, 241
  active now (109 of 1 acre or less). The California merge rule leaves 2 true gaps in 2025 and 64 active WFIGS-only
  fires today.
- **Silent wrong results outside California**: no detections for live non-CA fires, Pacific labels baked into
  bundles, "CAL FIRE" credited for every fire's acres and containment, LANDFIRE 2025 NoData across the South and East
  turned into non-burnable fuel, UTM areas up to 35 % too big in Florida, California's live fuel moisture table
  applied to February Texas grass.
- **The web is California-shaped**: the frame and wording, `lib/time.ts` fixed to America/Los_Angeles (214 call
  sites in 43 files), no clustering (an amber blob with 1,334 fires), search limited to California towns, a lat/lon
  guess that sends eastern points to the Southern Ocean, and a record fallback that would label a Montana fire's
  numbers "CAL FIRE".
- **Evacuations**: Oregon OEM publishes a live statewide layer ("Public" licence); 44 other states have none; today's
  web treats a rectangle as California and claims "Cal OES checked" in Reno and Yuma.
- **Validation**: 12 well-mapped test fires exist (V §3), but the biggest schedule risk is Open-Meteo's daily cap on
  this shared cloud IP (429 "Daily API request limit exceeded" today), and Madre must be rebuilt as the California
  baseline.

## Work, by priority

**1. The national fire list, and preparing fires anywhere in the lower 48 (P0)**
- B-R1 + B-R2 (`us-catalog`): WFIGS catalog with the California merge (switch constants `CA_ACTIVE_RULE = "either"`,
  `CA_COMPLEX_ROWS = "calfire"`), every active fire, ids from IRWIN, any id resolvable, the new summary fields
  (state, time zone, issuer, region, other records), the 2026 default year; gzip on the lists (B-R17).
- B-R3 + B-R4 (`us-catalog`): offline state, county, time zone and coverage (`fire3d/regions.py`, public-domain BTS
  and Census files), `GET /api/geo/lookup`, the standard UTM zone (California unchanged).
- B-R5 + B-R13 list part (`us-catalog`): national FIRMS feed and archive loaders, every caller in its files switched
  to them (the keyless path of `firms.detections_for`, `catalog.py`, `api/live.py`), the live loop's 4 auto-builds
  chosen nationally, each proved by an acceptance check (the box, the yearly file, the candidates, `detections_24h`;
  `us-pipeline` proves `refresh_live` and detections in its smoke builds); the KD-tree match is below its cut line.
- Build anywhere (`us-pipeline`): build gate by any id a source list knows (bundle-only ids stay unbuildable);
  perimeters by IRWIN id for WFIGS fires, California's path unchanged (B-R6); LANDFIRE editions by federal fiscal year
  with LF2023 added and no forward fallback (V-R4), the LF2025 NoData switch to LF2024 with an honest warning (B-R8);
  issuer text from the record (B-R22); the Open-Meteo quota made explicit (V-R7: no silent ERA5 fill, no cached error
  bodies, a per-host probe, `--require-hrrr`; the weighted daily counter is below the cut line); 2 smoke builds, a 3rd
  below the cut line.
- Overview (`us-web`): the lower-48 frame and wording (W2); three MapLibre sources with size-aware groups, pinned big
  active fires and zoom-aware labels (W3); state on rows, cards and hovers (W5); the list "in this view · Show all".
- Fire records (`us-catalog` endpoint and the shared web helpers `recordIssuerLabel` / `recordBlocks`, `us-pipeline`
  CAL FIRE endpoint, `us-official` panels, `us-web` fire card): `GET /api/official/incident-record` (B-R10) with the
  protecting agency and the record's own times, no 404 for a listed fire without a bundle, the `calfire.ts:89`
  mislabel fixed, every record shown when the agencies disagree; a California complex keeps CAL FIRE's row with its
  members named and linked (no single member's record stands for the complex; its incident record answers "This is a
  CAL FIRE complex; NIFC WFIGS lists its member fires separately."). Below `us-catalog`'s cut line: id pinning, so a
  bundle built while a California fire was WFIGS-only is not orphaned when CAL FIRE lists it later (§14.2).
- The list never reads as an all-clear: legend, list footer, empty view and phone peek say "Only fires reported to
  CAL FIRE or NIFC are listed; a place with no marker is not an all-clear. Follow local officials." (`us-web`, §14.14).

**2. Time zones and search (P0)**
- W1 (`us-web` owns the formatter; `us-official` and `us-web` migrate their own files): one formatter with a zone and
  a clock in every call (CONTRACT §14.9), `useTimeFormat()`, the panel line "Times: Mountain Time (MDT), the fire's
  local time", years in the local zone; the backend's labels and the live-moisture month in the fire's zone (B-R7,
  `us-pipeline`).
- National search: the Census Gazetteer for every state (B-R12, `us-catalog`), "Town, ST" and "83702 ID" parsing and
  US wording (W6, `us-web`), the lat/lon order fix (W8), coverage messages from `/api/geo/lookup` (W9).
- Reprojection tests for UTM zones 10-19 (W14, `us-web`) and `fixture-east`, a synthetic North Carolina fire in UTM
  17 and Eastern time for browser checks without a build (`us-catalog`).

**3. State evacuation feeds, official information and per-region accuracy labels (P0)**
- Evacuations (`us-official`, both ends): the status-mapping fix first (EV-R6), one adapter shape and a state
  registry (EV-R1) with Cal OES and Oregon OEM (EV-R2) only, "not available in this state" with no upstream request,
  field whitelists and a privacy test (EV-R4), border dedup (EV-R9), source-neutral wording from `sources[]` (EV-R3),
  issuer and state-layer times in the right zone (EV-R5); cameras say "not available in this state" outside
  California (B-R16, W12); imagery labels from each product's platform (W13).
- NWS nationally (B-R9, `us-pipeline`; W7, `us-official`): one national request, alerts filtered by state before any
  zone loads, `states_checked` so the web says "checked" only where the request really looked, "Official now · lower
  48 states", the location card always stating the NWS status ("not checked" where it was not).
- Local officials' messages (EV-R7, `us-pipeline` backend, `us-official` UI): live NWS-relayed messages, NWS's own
  last 7 days, and the OpenFEMA archive for past days (one alert per CAP id), with the required FEMA notice, matched
  by polygon or county codes. Every message carries a link (`source_url`: NWS's own alert URL, or the OpenFEMA record
  query), because the issuer's own `web` link is on only about 6 % of messages. The archive's background prefetch is
  below `us-pipeline`'s cut line (fallback: the archive says "not checked").
- Accuracy (`us-catalog` seeds and serves, `validation` measures, `us-web` shows): `regional_accuracy.json`,
  `GET /api/accuracy-regions`, `accuracy_region` on every fire (GACC, Southern Area split, a California county table),
  the Public and Command wording of V §5, the per-run skill table relabelled (V-R13).
- Validation (wave 2, `validation`): the Madre baseline, the pre-registered GSI live fuel moisture outside California
  (V-R5; switched on `summary.state`, historical inputs from ERA5 and live inputs from the forecast host, never a
  silent fallback, California re-run after it lands and required to be unchanged), absolute UTC starts and a
  replacement rule fixed before any score, 12 builds and hindcasts, the regional aggregation (V-R9),
  `docs/validation.md`.

**4. Below each role's cut line (done if time allows; otherwise the integration does them)**
- `us-catalog`: ZIP (ZCTA) and county rows of the gazetteer; `ca_county_gacc.json`; the FIRMS KD-tree; SPEC prose
  (§0, §2, §4.1, §4.2, §4.4, §8.7); `nwcg_agency_codes.json` (fallback: agency codes shown verbatim); id pinning
  (fallback: an orphaned bundle stays reachable by its old link).
- `us-web`: the accuracy line in the Analysis drawer, the Forensic Analysis tab and the location card's model block
  (the fire card has it above the line); W11 windowing of long lists (above 150 rows); W15 phone fixes; the
  `rasters.test.ts` carry-over; W14 reprojection tests for zones 12-19 (fallback: overlay alignment checked in the
  `fixture-east` and smoke-fire screenshots).
- `us-official`: W12 cameras panel wording; W13 imagery labels from each product's platform.
- `us-pipeline`: the OpenFEMA background prefetch and disk cache; the weighted Open-Meteo counter, its soft cap and
  hourly live weather; the 3rd smoke build (or a test on a recorded LF2025 NoData window); the
  `SkillEntry.growth_sorensen` writer (V-R13, P1; fallback: the per-run table shows the relabelled total).

**Deferred to a later brief (said here so nothing is silently dropped)**
- B-R11 WFIGS change history outside California: the record card says "Fire-3d does not record changes to this
  record yet" (California keeps its CAL FIRE history).
- B-R15 GOES-East imagery (eastern fires keep GOES-West, labelled by platform); B-R18 a bundled NWS fire-zone file
  (overview outlines may lag on busy days, with today's verbatim caveat); B-R19 LANDFIRE edition for live fires by
  fire year; B-R20 aircraft geoid; B-R21 bundle retention; EV-R11 the evacuation-source audit script; EV-R12 Oregon
  history (round 3 item 4 says not now); V-R12 a reference forecast; renaming the `statewide` identifiers.
- To the integration: W16 comment clean-up, removing the deprecated time API, making the five (R) summary fields
  required, and any P1 left below a cut line.

## How the build runs

Four wave-1 roles with disjoint files, then one validation role, then the runbook's integration and final check.

| Role | Ports (API / Vite) | Starts | Owns (short) | Work |
|---|---|---|---|---|
| `us-catalog` | 8711 / 5181 | first batch | `contracts.py`, `SPEC.md`, `web/src/api/**` (incl. the new `records.ts` helpers), `catalog.py`, new `regions.py`, `sources/wfigs.py`, `firms.py`, `grid.py`, `api/app.py`, `api/live.py`, new `api/records.py`, `api/geocode.py`, region / gazetteer / accuracy data, fixtures script | contracts first, regions, UTM, national list and merge, FIRMS feed and its callers, live list, records endpoint, accuracy seed and endpoint, national gazetteer (places) |
| `us-web` | 8712 / 5182 | first batch | `web/src` except `api/**` and the official files below: `lib/**` (incl. `lib/time.ts`), `state/**`, `map/**`, `scene/**`, `styles/**`, `ui/` (most), `location/` (most), `data/**`, `App.tsx`, `index.html`, `web/scripts/**` | the formatter first, the national overview, the time migration of its files, fire card records, accuracy labels, search and coverage, UTM tests |
| `us-official` | 8713 / 5183 | first batch | backend `api/extras.py`, new `sources/evacuations.py`; web `official/**`, `extras/**`, `ui/feed/**`, `ui/shell/{officialSummary,dataStatus}*`, `UpdatesPanel.tsx`, `LayersPanel.tsx`, `location/official*` | time shims first, evacuations (CA + OR, not available elsewhere), cameras (backend), source-neutral records, NWS and local-alerts UI with the honest wave-1 states, the Official dev preset, the time migration of its files |
| `us-pipeline` | 8714 / 5184 | the first free slot | `build/**`, `spread/**`, build sources, `nws.py`, new `openfema.py`, `api/official.py`, `api/jobs.py`, `cli.py`, `config.py`, `http.py`, `bundle.py`, `types.py`, `timeutil.py` | quota handling first (historical and live builds, per-host block), build anywhere (after `us-catalog` M3), NWS national, local alerts, **2 smoke builds outside California** (a 3rd below the cut line) |
| `validation` (wave 2) | 8716 / none | after wave 1 is reviewed and fixed | `spread/**`, `weather_bundle.py`, `weather.py`, `config.py`, `regional_accuracy.json`, `docs/validation.md`; bug fixes only in `build/**`, `landfire.py`, `perimeters.py`, `terrain.py`, `firms.py`, `catalog.py`, `cli.py`, `types.py` | Madre baseline, pre-registration (GSI, absolute starts, replacement rule), GSI, California re-run, 12 builds and hindcasts, regional file, docs |

- **Schedule** (at most 3 agents at once; CONTRACT §14.0). `us-catalog`, `us-web` and `us-official` start together.
  The first free slot goes to `us-pipeline`, the critical path to validation. Its M1 (the weather quota) needs nothing
  from the others; it starts building-anywhere only after the commit `brief 3 us-catalog: M3` is in `git log` (until
  then it does the NWS and local-alerts milestone, which needs only `us-catalog` M1 and M2). Reviewers and fixers take
  the later free slots, one agent per slot, in the order the roles finished; there is never a 4th agent. Validation
  starts when every wave-1 role is reviewed and its fixes are committed.
- **Why this order.** `us-catalog` is the foundation (contracts, regions, the list) and `us-web` owns the formatter
  that `us-official` must use; the two web roles run side by side so their cross-calls (the `tf` shims) can be agreed
  in the first hour. `us-pipeline` starts 4th: by then the contracts and regions exist and usually the national list
  too, and the web was built against §14, so its NWS and local-alerts backend only has to match the contract.
  Validation needs the reviewed pipeline, so it waits for the whole of wave 1 anyway.
- **Day-one deliverables** (CONTRACT §14.0): `us-catalog` M1 contracts of §14.1-14.7 and §14.12, every addition to an
  existing response model defaulted, plus the `records.ts` helpers (60-75 min), and M2 regions + UTM + `fixture-east`
  (about 2 h); `us-web` M1 the formatter and the migration script (60 min); `us-official` M1 the shims (within 60 min
  of `us-web` M1). Everyone else codes against §14 until these land.
- **Ownership.** One owner per file (0 clashes, appendix B). `CONTRACT.md` is not edited in wave 1: each role writes
  `docs/redesign/contract3/<label>.md` (this replaces the runbook's "append to §14", so the orchestrator should use
  that wording in the role prompts). `README.md` is final verification's (from the credits table §14.13). An export
  another role imports never changes signature in wave 1 (add a new one; the integration removes the old). Hand-offs
  are sequential: `us-pipeline` may update the build-gate tests in `test_api.py` only after `us-catalog`'s review and
  fixes are committed; validation may fix bugs in the build code it exercises (with a regression test each).
- **Commits in one shared checkout.** Milestone commits are named `brief 3 <label>: M<n> <what>` and use a pathspec:
  `git add -- <new own paths> && git commit -m "..." -- <own paths>`. A plain `git commit` after `git add` (the
  runbook's wording) would also commit whatever another agent has staged at that moment, so the orchestrator should
  give the pathspec form in the role prompts. A gate failure confined to another role's file is recorded (file, test)
  and rerun after that role's next commit.
- **Builds.** Only `us-pipeline` (2 smoke fires: Horse Gulch MT 2024 and Black Cove NC 2025; below its cut line a
  3rd, an active non-CA fire of 1,000 ac or more in the South or East, or any active non-CA fire of that size where
  LF2025 is NoData, else a test on a recorded LF2025 NoData window) and `validation`. Each build only after
  `fire3d.cli weather-probe` says `overall: ok` (the live 3rd also `live: ok`). When refused, nobody holds a slot
  waiting for the reset (about 00:00 UTC): `us-pipeline` waits only if the reset is less than 1 h away, else it
  reports its smoke builds "pending (quota)" and finishes; its fixer runs them after the reset, or validation builds
  them first (it rebuilds both anyway) and takes over their checks (CONTRACT §14.12.11). No browser run presses
  "Prepare analysis"; every browser run counts its non-GET requests from the API's access log (`grep -cE
  '"(POST|PUT|PATCH|DELETE) ' <api log>`, must be 0).
- **Size and cut lines.** The lower 48 is a bigger change than brief 2 (about 45 audit items). After deferring the P2
  items and moving overflow below the cut lines, each wave-1 role is about **4-5 hours above its cut line** for one
  strong agent, a little above the 3-4 hour target. Every role's tasks are ordered P0 first and end with an explicit
  cut line that names the items below it and the fallback each one leaves (section 4 above). What is not done goes to
  the integration checklist below and is listed in the role's report. Validation is about 6.5-8.5 hours, mostly
  builds, hindcasts, the California re-run after GSI and possible quota waits.
- **Reviews.** After each wave-1 role, an independent reviewer reruns that role's acceptance checks in
  `plan3-roles.json` in a clean worktree, so other roles' half-edited files cannot affect the result:
  `git worktree add <scratch>/review-<label> HEAD`, symlink `web/node_modules` from the main checkout, `uv sync
  --offline` in `backend/`, and `FIRE3D_DATA_DIR` / `FIRE3D_CACHE_DIR` pointing at the main checkout's `data/` (read
  only; nothing is built). It uses the finished role's ports and writes its own evidence:
  `docs/redesign/reports/review3-<label>.json` and `docs/screenshots/review3-<label>-*.png` (never the role's
  `brief3-<label>-*` paths). Screenshots a role recorded as deferred (a commit it needed had not landed) are taken by
  the reviewer once the commit is in. A fixer then applies the verified issues inside that role's globs, with
  pathspec commits.

## Integration checklist (stage E, after validation)

1. Fold `docs/redesign/contract3/*.md` into CONTRACT §14 as "as built" sub-headings; apply `us-pipeline`'s SPEC §8
   text and validation's SPEC §8.4 GSI paragraph.
2. Pass `tf` at every remaining cross-role call (§14.9.6), make the shims' `tf` required, run
   `node web/scripts/check-time-api.mjs web/src` (0 and 0), then delete the deprecated time API (§14.9.3); typecheck
   clean.
3. Make the (R) fields required: the five `IncidentSummary` fields and `IncidentListResponse.sources` in
   `web/src/api/types.ts` (update fixtures with `summaryFixture()`), and in `contracts.py` the wave-1 defaults of
   §14.0 (`FireWeatherResponse.states_checked` / `alert_states`, `FireWeatherAlert.time_zone`,
   `LiveStatus.detections_24h`, `IncidentListResponse.sources`) once every producer sends them; optionally rename
   `OfficialBlock.fireWeather` to `lines` (§14.7). Extend the contracts ↔ TS parity test (`us-catalog` covers the
   shapes in `web/src/api/types.ts`) to the official shapes in `web/src/official/types.ts`: `IncidentRecordResponse`,
   `LocalAlertsResponse` / `LocalAlert` (incl. `source_url`) and the `FireWeatherResponse` / `FireWeatherAlert`
   additions.
4. Every item a role left below its cut line (section 4 above; each report lists them), with these first: the
   OpenFEMA background prefetch (until then the archive says "not checked"), W12 cameras wording, the ZIP and county
   gazetteer rows, `ca_county_gacc.json`, `nwcg_agency_codes.json`, id pinning, the `growth_sorensen` writer, and
   SPEC prose. Then the carry-over (W14 reprojection tests, the location card's accuracy line, W11 windowing, W15
   phone fixes, the three `rasters.test.ts` tests: reload on key change, a single layer above the 256 MiB cap stays
   cached, two names sharing one URL keep their own names), then W16 if time allows.
4a. Wording scan over the whole brief (CONTRACT §14.0): the added lines of `git diff 1c500b1 -- web/src backend/fire3d`
   (non-test files) searched for `\bsafe\b|low risk|all[- ]clear|Fire[T]race`; every hit justified (negations such as
   "not an all-clear", CSS "safe area", comments) or fixed. Final verification repeats it.
5. The live-endpoint views that wave 1 could not show (they need `us-pipeline`'s backend, which `us-official`'s web
   was built before): the overview's "Official now · lower 48 states" against the real national NWS answer; a Reno
   address with "Fire weather alerts (NWS): checked, none in effect here" (or the alert line) and the local-alerts
   line; Black Cove's local-alerts row with the archive channel; any screenshot a role or reviewer recorded as
   deferred.
6. Verify the brief end to end per RUNBOOK-3 §8: the overview with a few thousand markers at 1440x900 and 390x844 in
   Public and Command; fires in several states, including validation fires in UTM 12-17 with aligned overlays; local
   time zones; search in several states; Oregon (dev preset and live) and "not available in this state" elsewhere;
   NWS and local alerts; accuracy labels per region; California regression on Eaton and Palisades; keyboard and
   reduced motion. Frame rate is checked later on the user's Mac (no GPU here).

Final verification (stage F) then runs one national live-loop cycle (4 auto-builds cap, after `weather-probe` reports
`live: ok`), prepares at most one new fire from its card, repeats the wording scan of item 4a, and writes the README
rows from §14.13 (US coverage, new sources and licences, limitations: Alaska and Hawaii not yet, accuracy by region,
evacuation coverage by state, GOES-East and WFIGS history deferred).

## Testing

- **Unit tests for all new logic.** Backend (pytest, offline with recorded samples through `fire3d.http`): the
  California merge regression set, the WFIGS active rule and state rule, ids, regions at the named test points, UTM
  zones 10-19, gzip, records, the quota paths, LANDFIRE editions, issuer and time-zone text, the NWS state filter,
  local alerts (time windows, dedup by CAP id) and the archive's non-blocking path, evacuations (0 upstream requests
  for states without a feed, Oregon mapping, border dedup, privacy), the California perimeter regression (identical
  `OBJECTID` sets), the national FIRMS feed (the lower-48 box, the yearly file read with `filters=`, the live-loop
  candidates with a fire outside California, `detections_24h`, `refresh_live`) and its keyless path, prescribed
  burns and CX parents never listed, the Alaska build gate (422 with the §14.14 sentence), the quota paths of live
  builds and refreshes, a link on every local alert, GSI reference values, California (herb, woody) values unchanged
  by GSI, and the regional aggregation. Web (vitest): the formatter in both clocks and six zones with DST days,
  clusters and labels, in-view lists and the list-absence line, search parsing, lat/lon order, accuracy wording (no
  banned words; OSCC numbers from the file) and the label outside `.fc-official`, the shared record helpers
  (disagreement and complexes; a complex never shows a member's record as its own), the NWS "checked" rule against a
  California-only and a national answer, border points and card lines (every local alert with a link).
- **California unchanged**: `us-web` takes before-and-after screenshots of Eaton and Palisades in Command and of Eaton
  in Forensic; validation re-runs the California hindcasts after GSI and requires the step 1 values (|Δ| < 0.001).
- **Wording scan**: every role, the integration and final verification (CONTRACT §14.0, integration item 4a).
- **Gates** for every role: `cd backend && uv run pytest -q`; `cd web && npm run typecheck && npm run lint && npm
  test && npm run build` (lint stays at 55 warnings, all in `src/scene`).
- **In the app** (swiftshader screenshots, each viewed; names in each role's checks): the national overview desktop
  and phone, Public and Command; a non-CA fire card; `fixture-east` and the smoke fires with local times and aligned
  overlays; Eaton in both presets (California regression); search; Alaska coverage; Reno and Brookings official lines
  with the honest wave-1 states; the Official dev preset (national NWS, local alerts, archive, Oregon zones). The
  live national official views come in the integration (checklist item 5).
- **Secrets**: count-only key scans of every log.

## Risks

- **Open-Meteo's daily cap on the shared cloud IP** (the biggest schedule risk). Mitigation: quota handling is
  `us-pipeline`'s first milestone (historical and live builds fail with a clear message, a blocked host is not asked
  again until the reset, live refreshes keep the last weather with a warning); every build waits for a successful
  probe; no slot is held waiting for a reset (the smoke builds' stop rule); no ERA5 fill for validation builds; if the
  block lasts more than a day, the orchestrator asks the user (V §7: wait, use ERA5 with labels, or drop fires).
- **LANDFIRE 2025** stays NoData in the South and East until its November release: live builds there switch to
  LF2024 with a warning; validation fires do not need LF2025.
- **WFIGS field quality** (sizes missing, ALL CAPS names, duplicates, stale year-to-date rows): rules fixed in §14.2;
  the list says when NIFC is down.
- **Time migration breadth** (43 files across two roles): the deprecation script makes progress measurable and the
  integration removes the old API only when it reports 0.
- **Live fuel moisture outside California** is California's table until validation lands GSI; non-CA bundles say so
  in a warning, and every forecast's notes name the method used. After GSI lands, live builds take their GSI days
  from the forecast host (ERA5 lags about 6 days), a missing series is never a silent fallback, validation builds
  fail instead, and the label reports only GSI-based scores outside California. A GSI bug that touched California
  is caught by the required re-run of Eaton, Madre and Palisades.
- **OpenFEMA is slow** (15-60 s queries): never on the request path; a `pending` state with the background
  prefetch, or "not checked" if the prefetch stays below `us-pipeline`'s cut line.
- **Three agents in one checkout**: pathspec commits, milestone commit names that others can wait for, gate failures
  attributed to their owner, and reviews in a clean worktree (§14.0, "Reviews" above).
- **Overview performance** with about 1,500 markers: clustering runs in MapLibre's worker; frame rate is checked
  later on a machine with a GPU.

## Estimated time

- Wave 1: three roles in parallel, about 4.5-5 h each above their cut lines; `us-pipeline` (about 4.5-5 h plus 2
  smoke builds) takes the first free slot, and the three reviews and fixes share the other two slots; about 10-11 h
  of wall time, plus the fourth review.
- Wave 2 validation: about 6.5-8.5 h (longer if the weather quota is blocked).
- Integration about 2 h, final verification about 1.5 h.

## Appendix A. Audit item → role

| Role | Items |
|---|---|
| `us-catalog` | B-R1, B-R2 (contract, SPEC; id pinning below the cut line), B-R3, B-R4, B-R5 (incl. the keyless path; KD-tree below the cut line), B-R10 (endpoint, shared web helpers; `nwcg_agency_codes.json` below the cut line), B-R12 (places; ZIP and county rows below the cut line), B-R13 (live list), B-R17, B-R23, B-R24 (SPEC rows; prose below the cut line), B-R25 (firedata recorder), V-R10 (endpoint, seed; `ca_county_gacc.json` below the cut line), V-R3 |
| `us-pipeline` | B-R2 (build gate), B-R6, B-R7, B-R8, B-R9, B-R10 (`fill_from_catalog`, CAL FIRE endpoint), B-R13 (weather budget, below the cut line), B-R22, B-R25 (official recorder), EV-R7 (backend; archive prefetch below the cut line), V-R1, V-R2, V-R4, V-R6, V-R7, V-R8, V-R13 (backend, below the cut line) |
| `us-official` | EV-R1, EV-R2, EV-R3, EV-R4, EV-R5, EV-R6, EV-R7 (web), EV-R8 (app credits), EV-R9, B-R16, W4, W7, W12 (backend; panel wording below the cut line), W13 (below the cut line) |
| `us-web` | W1 (formatter + its files), W2, W3, W5, W6, W8, W9, W10 (drawer, Forensic tab and location card below the cut line), W11 (P1), W14 (P1, below the cut line), W15 (P1), V-R13 (web), carry-over `rasters.test.ts` (P1) |
| `validation` | V-R5 = B-R14 (GSI, pre-registered), V-R9, V-R14, protocol steps 0-7, `docs/validation.md`, `regional_accuracy.json`, bug fixes in the build code it exercises |
| deferred | B-R11, B-R15, B-R18, B-R19, B-R20, B-R21, EV-R10 (Washington: not built, round 3), EV-R11, EV-R12, V-R11 (covered by B-R5), V-R12, W16 (integration) |

## Appendix B. Ownership check

Run from the repository root with an optional file listing planned new paths (one per line). It turns each glob into a
regular expression (`*` and `?` stay inside one path segment, `**` crosses `/`, `[!x]` excludes a first character),
counts each role's `owns` plus validation's bug-fix-only `owns_bugfix_only`, and reports clashes and globs that match
nothing, per wave.

```python
import json, re, subprocess, sys
def rx(g):
    out, i = "", 0
    while i < len(g):
        if g.startswith("**", i): out += ".*"; i += 2; continue
        c = g[i]
        if c == "*": out += "[^/]*"
        elif c == "?": out += "[^/]"
        elif c == "[":
            j = g.index("]", i); b = g[i + 1:j]
            out += "[^/" + re.escape(b[1:]) + "]" if b.startswith("!") else "[" + re.escape(b) + "]"; i = j
        else: out += re.escape(c)
        i += 1
    return re.compile(out + r"\Z")
roles = json.load(open("docs/redesign/plan3-roles.json"))["roles"]
extra = [l.strip() for l in open(sys.argv[1]) if l.strip() and l[0] != "#"] if len(sys.argv) > 1 else []
paths = sorted(set(subprocess.check_output(["git", "ls-files"], text=True).split()) | set(extra))
for wave in sorted({r["wave"] for r in roles}):
    owner, clashes, empty, per = {}, [], [], {}
    for r in (r for r in roles if r["wave"] == wave):
        for g in r["owns"] + r.get("owns_bugfix_only", []):
            hits = [p for p in paths if rx(g).match(p)]
            if not hits: empty.append((r["label"], g))
            for p in hits:
                if owner.setdefault(p, r["label"]) != r["label"]: clashes.append((p, owner[p], r["label"]))
        per[r["label"]] = sum(1 for o in owner.values() if o == r["label"])
    print(f"wave {wave}: {len(owner)} paths owned {per}, {len(clashes)} clashes, {len(empty)} empty globs", *clashes, *empty, sep="\n  ")
code = [p for p in paths if p.startswith(("backend/fire3d/", "web/src/", "backend/scripts/")) and p.endswith((".py", ".ts", ".tsx", ".mjs"))]
w1 = [rx(g) for r in roles if r["wave"] == 1 for g in r["owns"]]
print("code paths without a wave-1 owner:", [p for p in code if not any(x.match(p) for x in w1)])
```

Result after the second revision (2026-10-23, 861 tracked files plus the 78 new paths named in CONTRACT §14 and the
role tasks: 58 from the first plan, 9 added by the first revision such as `web/src/api/records.ts`, and 11 added by
the second, such as `backend/tests/test_us_catalog_live.py`, the national FIRMS and RX/CX samples, the recorded
LF2025 NoData window, `web/src/ui/shell/FireCard.test.tsx` and the `brief3-us-web-baseline-*` screenshots). No glob
changed in the second pass; every new path falls under an existing glob of its role:

```
wave 1: 475 paths owned {'us-catalog': 71, 'us-web': 219, 'us-official': 99, 'us-pipeline': 86}, 0 clashes, 0 empty globs
wave 2: 77 paths owned {'validation': 77}, 0 clashes, 0 empty globs
code paths without a wave-1 owner: ['backend/fire3d/__init__.py', 'backend/fire3d/api/__init__.py', 'backend/fire3d/sources/__init__.py', 'backend/scripts/validate_regional.py']
```

The three package `__init__.py` files are edited by nobody; `validate_regional.py` is a wave-2-only new file.
Validation reuses paths that wave-1 roles owned, which causes no conflict because it runs alone. The hand-off of
`backend/tests/test_api.py` (from `us-catalog` to `us-pipeline`, after `us-catalog`'s review) is sequential and is not
a glob, so it never makes two owners at once.

## Revision notes (2026-10-22/23, after two independent critics)

### First pass (2026-10-22/23, the critics' items 1-23)

The planner checked each reported problem against the code and the plan before changing anything. The problem list
handed to this pass was cut off after the 23rd item (its fix text stops mid-sentence) although it announced 41; items
24-41 were not received, so they are neither applied nor rejected here (the planner report says so). All 23 received
problems were confirmed; none was rejected. What changed:

1. **Defaults for added response fields** (ownership, major). Confirmed: `contract_problems` is strict and
   `test_official_nws.py:403,423,442,476` and `test_official_real_bundles.py:74` would fail on a required
   `states`/`time_zone` that `nws.py` does not emit yet. §14.0 now requires `Optional_()` defaults, marked (R), for every
   field added to an existing response model; `us-catalog` proves it by running those tests at its M1 commit.
2. **FIRMS keyless path** (major). Confirmed: `firms._keyless` (`firms.py:736`, `:744`) is in `us-catalog`'s file. It
   moves to `us-catalog` M3 with `catalog.py` and `api/live.py` callers, plus a Montana test; `us-pipeline` keeps only
   `pipeline.py:655` (§14.12.1).
3. **Cut lines** (major). Confirmed (only `us-web` had one). Every wave-1 role now ends with a named cut line and a
   fallback per item; section 4 lists them and the integration checklist takes what is left.
4. **Schedule and the 3-agent cap** (major). Confirmed. The first free slot goes to `us-pipeline`; its M1 needs
   nothing; build-anywhere waits for the `brief 3 us-catalog: M3` commit; reviewers and fixers queue for later slots.
5. **Index races in one checkout** (major). Confirmed (RUNBOOK-3 line 97 uses a plain `git commit`). Pathspec commits,
   milestone commit names, a gate-attribution rule, and reviews in a clean worktree (§14.0, "Reviews").
6. **`states` meant two things** (major). Confirmed (`nws.py:445` asks `area=CA`; the endpoint has no bbox). Split into
   `states_checked` and `alert_states`; "checked" only from `states_checked`; a missing field is read as `["CA"]`
   (today's backend), so Reno says "not checked" and the lower-48 line needs all 49 codes (§14.6).
7. **Local-alert windows** (major). Confirmed (`/alerts/active` has no past). Live, past 7 days (`/alerts?start&end`),
   and archive windows; `id` = CAP identifier; dedup with the NWS copy winning; `phase` relative to `at_ms`;
   `incident` xor `bbox` (§14.7).
8. **Acceptance screenshots that could not pass** (major). Confirmed. A national Official dev preset (§14.8.7); the
   honest wave-1 rendering ("not checked") for a 404 or California-only backend; live views moved to integration item
   5; `fixture-east` has `irwin_id: null` and gets a "synthetic or local data" record answer, unknown ids 404; `us-web`
   takes national screenshots after `us-catalog` M3 or records a deferral.
9. **Location-card lines had no renderer** (major). Confirmed (`CardParts.tsx:70-110` draws only the existing arrays).
   Took the critic's alternative: `us-official` puts the NWS status and local-alert lines into the existing `fireWeather`
   array via `useOfficialAtPoint`, so no `us-web` change or new argument is needed (§14.7, §14.9.6).
10. **Build gate** (major). Confirmed (`pipeline.py:77-90`, `app.py:184/496`, `test_api.py:241-244`). Buildable only via
    `catalog.resolve_listed` (never a manifest); bundle-only ids keep 409 with new wording; `is_catalog_incident` keeps
    its signature; a sequential hand-off lets `us-pipeline` update `test_api.py` after `us-catalog`'s review (§14.2).
11. **Validation could not fix what it exercises** (major). Confirmed. Bug-fix-only ownership (`owns_bugfix_only`) of
    the build code, each fix with a regression test; the interim warning lives in `build/weather_bundle.py`; the SPEC
    §8.4 GSI paragraph goes to `notes_for_integrator`.
12. **TS names** (minor). Confirmed (`types.ts:320-326`, `:270`). `incidents: IncidentSummary[]`; the inline skill items
    gain `growth_sorensen?`.
13. **Quota error base class and probe result** (minor). Confirmed (`weather.py:85` has `WeatherError`; `SourceError`
    lives elsewhere). `WeatherQuotaExceeded(WeatherError)`; the probe returns per-host statuses plus `overall`.
14. **Migration script could never reach 0** (minor). Confirmed. It skips `lib/time.ts`, counts imports only, takes
    `--role <label>`, and counts `America/Los_Angeles` literals per role instead of a repo-wide grep (§14.9.3).
15. **California evacuation check contradicted §14.8.2** (minor). Confirmed; reworded to "every pre-existing key keeps
    its value".
16. **Accuracy rule gaps** (minor). Confirmed. "Otherwise `limited`"; the fuel caveat shows whenever
    `fuel_groups_tested` is non-empty (no field lists a region's fuels); `by_lead` keys "12"/"24"/"48"/"72".
17. **Day-one list and M1's regions dependency** (minor). Confirmed. §14.0 lists §14.6/§14.7 models; until M2 the
    before-validator leaves `state`/`time_zone` unset (viewer's zone, labelled; never Pacific).
18. **Naming** (minor). Confirmed. `agency`/`agency_code` everywhere (summary, `OtherRecord`, incident record);
    `message_type` (as in brief 2); `useZoneSource` gains `'place'`.
19. **Issuer label written twice** (minor). Confirmed. `us-catalog` M1 adds `recordIssuerLabel` and `recordBlocks` in
    `web/src/api/records.ts` with tests; both web roles import them (§14.5).
20. **Reviewer evidence paths and the non-GET count** (minor). Confirmed (`shot.mjs` counts no methods). Reviewers write
    `review3-<label>` files; non-GET requests are counted from the uvicorn access log.
21. **3rd smoke build and the area ratio** (minor). Confirmed. A named fallback (else skip with the reason); the ratio is
    a reported value with an explanation, not pass/fail; the 3rd build is below `us-pipeline`'s cut line.
22. **California perimeters would change** (coverage, major). Confirmed (`perimeters.py:318-345`, `:582`). California
    rows keep today's name/CpxName/hint path, IRWIN only as a tiebreak; regression test on Eaton, Palisades, Madre and
    TCU; a Madre difference caused by brief-3 code is a regression to fix in validation step 1 (§14.12.8).
23. **What a California complex row carries** (coverage, major; the fix text was cut off). Confirmed. A complex row has
    `irwin_id: null`, one named `other_records` entry per member (`OtherRecord.name` added), the members' GACC when they
    agree, `'wfigs'` in `active_sources` when any member is active, and never fetches the incident record; `recordBlocks`
    shows a member's block, with its name, when its status differs from CAL FIRE's (§14.2, §14.5).

Sizes after the first pass: `us-catalog`, `us-web` and `us-official` about 4.5-5 h above their cut lines, `us-pipeline`
about 4-4.5 h plus 2 smoke builds; validation unchanged (6-8 h).

### Second pass (2026-10-23, the critics' items 23-41)

The remaining 19 problems (5 major, 14 minor; items 23-41 of the 41) were received in full this time. Item 23 was
the one the first pass had received cut off. The planner checked each one against the code, the audits and the
plan before changing anything. Results: 2 already fixed by the first pass, with small additions; 17 fixed now;
none rejected outright. Item 34 was partly wrong: the live loop auto-builds only once per loop start, so it does not
retry each cycle. Its other points were confirmed. No role, port or start order changed. Four items moved below cut
lines to keep the roles near their size target (marked "cut line" below). What changed:

23. **What a California complex row carries** (major). Already fixed by the first pass (item 23: `irwin_id` null,
    named `other_records`, no incident-record fetch, the TCU test with 5 named records). Added now: the endpoint
    answers a complex row with its own reason, "This is a CAL FIRE complex; NIFC WFIGS lists its member fires
    separately.", and never with one member's record. The card lists the members under "Includes (NIFC WFIGS
    names)", each linked to its record, while the heading and numbers stay CAL FIRE's. Tests in `us-catalog`,
    `us-web` and `us-official` check that a complex never shows a member's record or numbers as its own (§14.2,
    §14.5).
24. **No acceptance check for the national FIRMS feed** (major). Confirmed (`pipeline.py:655`, `api/live.py:138`,
    `:163` still use `load_live_ca`; the only FIRMS check was the keyless Montana bbox). New checks:
    - `us-catalog`, on a recorded national feed sample: the lower-48 box (TX, FL and ME kept, rows within 0.5° beyond
      the borders kept, HI and AK dropped); `load_year_us` reads `firms_us_{year}` with `filters=` and never a CA
      file; the live-loop candidates include a fire outside California, at most 4, with the 100 ac and 48 h rules
      unchanged; `detections_24h` is served by `/api/live/status`; the KD-tree equals the old matching if done.
    - `us-pipeline`: `refresh_live` uses `load_live_us`, and each smoke build has more than 0 detections, with their
      source reported (§14.12.1).
25. **Live fuel moisture outside California** (major). Confirmed (`ERA5_DELAY_DAYS = 6`; `ensemble.py:307-315` and
    `weather_bundle.py:393-396` fall back with only a warning or silently). §14.12.10 now fixes these points:
    - the switch is `summary.state` (old bundles get it from the before-validator);
    - the inputs are pre-registered for both paths: ERA5 for historical builds, the forecast host with
      `past_days=28` for live builds;
    - a missing series is never silent (California's values, the warning and a moisture note naming the method);
    - `require_hrrr` fails a validation build on a refused GSI series or water-year total (the water-year part is
      `us-pipeline` M1);
    - until GSI lands, bundles carry the interim warning, and every forecast's notes name the method used.
    Acceptance: every fire outside California has `lfm_method: "gsi_nfdrs2016"`, and Madre's bundle has
    `precip_wy_mm`. No label change was needed: the Command line describes the hindcasts, and §14.4 now says so.
26. **California results after the GSI change** (major). Confirmed (step 1 ran before the GSI code; nothing re-ran
    California after it). Step 2 now ends with a re-run of Eaton, Madre and Palisades. It must equal step 1
    (|Δ| < 0.001 per fire and over the 32 leads; the seeds are fixed, `ensemble.py:325`), and the two runs are
    reported side by side. A unit test also checks that the (herb, woody) values for Eaton, Palisades, Madre and
    `fixture-demo` are unchanged. OSCC in the file uses the re-run.
27. **A link on every local officials' message** (major). Confirmed (`web` is present on about 6 % of messages,
    evacuations audit §2.2). `LocalAlert.source_url` is always set, over https:
    - NWS alerts: their `@id`, the same link brief 2's alerts use (`nws.py:418`);
    - archived alerts: the OpenFEMA query by `identifier`.
    The card shows `web` when present, else `source_url`. An alert without an https link is dropped and counted in a
    caveat. Tests in `us-pipeline` and `us-official` (§14.7).
28. **The `nws_api` channel between now and 7 days back** (minor). Already fixed by the first pass (item 7: the
    `/alerts?start=&end=` window for anything older than 2 h). Added now: `us-pipeline` tests an `at_ms` 12 h ago
    (never `/alerts/active`) and one 30 h ago (both channels, one alert per CAP id).
29. **Rules with no runnable check** (minor). Confirmed (list rows carry no incident type). New offline `us-catalog`
    tests on recorded rows: RX and CX are never listed, and a complex member outside California is listed with
    `complex_name`. The curl check no longer claims "0 prescribed burns". The Alaska build gate (422 with the
    §14.14 sentence) is tested through both the CLI and `POST /api/incidents/{id}/build` (`us-pipeline`).
30. **Relative starts** (minor). Confirmed (V §3 rows 4, 8 and 11). The pre-registration commit lists absolute UTC
    starts for all 12 fires. Horse Gulch, Greer and Rush get WFIGS `FireDiscoveryDateTime` plus their offsets. The
    ignition-relative secondary times are computed the same way, so no start depends on a bundle's computed ignition.
31. **Replacements, in-sample labels and the build count** (minor). Confirmed. Three changes:
    - a pre-registered replacement rule: only for a failed bundle check, before any of that fire's scores exist,
      using the next reserve of the same region; Southern Plains has none, so it becomes `limited`;
    - `replaced` is recorded per fire;
    - an adopted change sets `in_sample: true` for every region its fires informed.
    The count now reads "13 builds (Madre + the 12, Horse Gulch and Black Cove among them as `--force` rebuilds)".
32. **Literal OSCC numbers** (minor). Confirmed. The OSCC lines are the general templates, filled from the file. One
    fixed sentence is added for any region with `in_sample: true`. A `us-web` test checks that changing the
    fixture's numbers changes the label (§14.4).
33. **The accuracy label inside the official section** (minor). Confirmed (`FireCard.tsx` `.fc-official`, labelled
    "CAL FIRE official record"). §14.4 now places the label outside `.fc-official`, next to `.fc-note`, and a DOM test
    checks this.
34. **Quota for live builds; the ensemble host** (minor). Partly confirmed. Auto-build runs once per loop start
    (`STATE.auto_build_done`, `api/live.py:430`), so it does not retry each cycle. But the remaining candidates would
    each try, live builds had no rule, and the probe skipped `ENSEMBLE_URL`. §14.12.2 now adds:
    - a per-host block until the reset, with no network call to a blocked host;
    - live builds fail their job with the quota message;
    - a refused live refresh keeps the last weather, with a warning;
    - the refused ensemble keeps today's fallback to perturbed members, with the reason;
    - the probe reports `ensemble` and a separate `live` status, and its exit code still follows `overall`.
    All of this is in `us-pipeline`'s files, so `api/live.py` needs no change.
35. **Smoke builds blocked by the quota** (minor). Confirmed. New stop rule: wait only if the reset is less than 1 h
    away; otherwise report "pending (quota)", and the fixer or validation builds them later (validation rebuilds both
    anyway). Reviewers never build. The 3rd build falls back to a unit test on a recorded LF2025 NoData window, and
    the report says which was used (cut line).
36. **GFS fill hours** (minor). Confirmed (`weather.py:388-393`; the source becomes `…gfs_hrrr+gfs_seamless`).
    `AccuracyFire` gains `gfs_fill_hours`, `weather_source` and `replaced`. Validation records them for every fire,
    and any fill hours are reported and justified. The smoke builds report them too.
37. **Parity test coverage** (minor). Confirmed. `us-catalog`'s test now covers every shape in
    `web/src/api/types.ts`: the summary (with `aliases`), `OtherRecord`, `ListSource`, the list, `LiveStatus`,
    `GeoLookup` and the accuracy shapes. The official shapes live in `us-official`'s `official/types.ts`; they are
    checked by the integration (checklist item 3), as the critic allowed, so no cross-role test fails during wave 1.
38. **Thin California visual checks** (minor). Confirmed. `us-web` takes baselines before its first change (Eaton
    and Palisades Command, Eaton Forensic) and compares the after-shots. New shots: Palisades Command, Eaton
    Forensic (24-hour PST) and `fixture-east` Forensic (24-hour EDT).
39. **Unstable ids when CAL FIRE lists a fire late** (minor). Confirmed (a WFIGS-only California row is dropped by
    rule (2) once CAL FIRE lists it, and its bundle would be orphaned). New "id pinning" rule: an existing bundle
    keeps its id, the CAL FIRE id becomes an alias, both ids resolve, and a build by the alias gets a 409 (§14.2).
    This is below `us-catalog`'s cut line (cut line); its fallback keeps the old link working.
40. **Banned words beyond the accuracy templates** (minor). Confirmed. A wording scan of the lines each role added
    (`\bsafe\b|low risk|all[- ]clear|Fire[T]race`, every hit justified) is now in every role's gates, in integration
    item 4a and in final verification. It looks only at added lines, because the existing code already uses "safe
    area" for layout.
41. **The list could read as "no fires here"** (minor). Confirmed. §14.14 adds "Only fires reported to CAL FIRE or
    NIFC are listed; a place with no marker is not an all-clear. Follow local officials." It goes in the legend, the
    list footer and the empty view; the phone peek gets a short form (§14.11, `us-web` M2 and tests).

Cut-line moves that keep the roles near their size target (cut line):
- `us-catalog`: `nwcg_agency_codes.json` (codes shown verbatim until then) and id pinning.
- `us-web`: W14 reprojection tests (P1; alignment is still checked in screenshots) and the location card's accuracy
  line (the fire card keeps it).
- `us-pipeline`: the `growth_sorensen` writer (V-R13, P1).
All of these are on the integration checklist.

Sizes after the second pass, above the cut lines:
- `us-catalog` about 5 h;
- `us-web` and `us-official` about 4.5-5 h;
- `us-pipeline` about 4.5-5 h plus 2 smoke builds (its M1 grows to about 60 min);
- validation about 6.5-8.5 h (the California re-run, the live GSI input and the per-fire weather records).

Ownership check: 78 planned new paths, 0 clashes, no glob changed (appendix B).
