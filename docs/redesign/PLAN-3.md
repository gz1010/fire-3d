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
- B-R5 + B-R13 list part (`us-catalog`): national FIRMS feed and archive loaders, a KD-tree match, the live loop's
  4 auto-builds chosen nationally.
- Build anywhere (`us-pipeline`): build gate by any listed id; perimeters by IRWIN id (B-R6); LANDFIRE editions by
  federal fiscal year with LF2023 added and no forward fallback (V-R4), the LF2025 NoData switch to LF2024 with an
  honest warning (B-R8); issuer text from the record (B-R22); the Open-Meteo quota made explicit (V-R7: no silent ERA5
  fill, no cached error bodies, a probe, `--require-hrrr`, a weighted daily counter); at most 3 smoke builds.
- Overview (`us-web`): the lower-48 frame and wording (W2); three MapLibre sources with size-aware groups, pinned big
  active fires and zoom-aware labels (W3); state on rows, cards and hovers (W5); the list "in this view · Show all".
- Fire records (`us-catalog` endpoint, `us-pipeline` CAL FIRE endpoint, `us-official` panels, `us-web` fire card):
  `GET /api/official/incident-record` (B-R10) with the protecting agency and the record's own times, no 404 for a
  listed fire without a bundle, the `calfire.ts:89` mislabel fixed, both records shown when the agencies disagree.

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
  zone loads, "Official now · lower 48 states", the location card always stating the NWS status.
- Local officials' messages (EV-R7, `us-pipeline` backend, `us-official` UI): live NWS-relayed messages and the
  OpenFEMA archive for past days, with the required FEMA notice, matched by polygon or county codes.
- Accuracy (`us-catalog` seeds and serves, `validation` measures, `us-web` shows): `regional_accuracy.json`,
  `GET /api/accuracy-regions`, `accuracy_region` on every fire (GACC, Southern Area split, a California county table),
  the Public and Command wording of V §5, the per-run skill table relabelled (V-R13).
- Validation (wave 2, `validation`): the Madre baseline, the pre-registered GSI live fuel moisture outside California
  (V-R5), 12 builds and hindcasts, the regional aggregation (V-R9), `docs/validation.md`.

**4. Polish (P1, below each role's cut line)**
- W11 windowing of long lists (above 150 rows), W15 phone fixes, the `rasters.test.ts` carry-over (`us-web`).
- The weighted Open-Meteo counter's soft cap and hourly live weather (`us-pipeline`; in M1 because of the quota).

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
| `us-catalog` | 8711 / 5181 | first batch | `contracts.py`, `SPEC.md`, `web/src/api/**`, `catalog.py`, new `regions.py`, `sources/wfigs.py`, `firms.py`, `grid.py`, `api/app.py`, `api/live.py`, new `api/records.py`, `api/geocode.py`, region / gazetteer / accuracy data, fixtures script | contracts first, regions, UTM, national list and merge, FIRMS feed, live list, records endpoint, accuracy seed and endpoint, national gazetteer, SPEC |
| `us-web` | 8712 / 5182 | first batch | `web/src` except `api/**` and the official files below: `lib/**` (incl. `lib/time.ts`), `state/**`, `map/**`, `scene/**`, `styles/**`, `ui/` (most), `location/` (most), `data/**`, `App.tsx`, `index.html`, `web/scripts/**` | the formatter first, the national overview, the time migration of its files, fire card records, accuracy labels, search and coverage, UTM tests |
| `us-official` | 8713 / 5183 | first batch | backend `api/extras.py`, new `sources/evacuations.py`; web `official/**`, `extras/**`, `ui/feed/**`, `ui/shell/{officialSummary,dataStatus}*`, `UpdatesPanel.tsx`, `LayersPanel.tsx`, `location/official*` | time shims first, evacuations (CA + OR, not available elsewhere), cameras, source-neutral records, NWS and local-alerts UI, the time migration of its files |
| `us-pipeline` | 8714 / 5184 | 4th, when a first-batch role finishes | `build/**`, `spread/**`, build sources, `nws.py`, new `openfema.py`, `api/official.py`, `api/jobs.py`, `cli.py`, `config.py`, `http.py`, `bundle.py`, `types.py`, `timeutil.py` | quota handling first, build anywhere, NWS national, local alerts and the FEMA archive, **at most 3 smoke builds outside California** |
| `validation` (wave 2) | 8716 / none | after wave 1 is reviewed and fixed | `spread/**`, `weather_bundle.py`, `weather.py`, `config.py`, `regional_accuracy.json`, `docs/validation.md` | Madre baseline, GSI (pre-registered), 12 builds and hindcasts, regional file, docs |

- **Why this order.** `us-catalog` is the foundation (contracts, regions, the list) and `us-web` owns the formatter
  that `us-official` must use; the two web roles run side by side so their cross-calls (the `tf` shims) can be agreed
  in the first hour. `us-pipeline` starts 4th: by then the catalog resolves WFIGS ids, the regions exist, and the web
  is built against §14, so its NWS and local-alerts backend only has to match the contract. Validation needs the
  reviewed pipeline, so it waits for the whole of wave 1 anyway.
- **Day-one deliverables** (CONTRACT §14.0): `us-catalog` M1 contracts (60 min) and M2 regions + UTM + `fixture-east`
  (about 2 h); `us-web` M1 the formatter (60 min); `us-official` M1 the shims (within 60 min of `us-web` M1). Everyone
  else codes against §14 until these land.
- **Ownership.** One owner per file (0 clashes, appendix B). `CONTRACT.md` is not edited in wave 1: each role writes
  `docs/redesign/contract3/<label>.md` (this replaces the runbook's "append to §14", so the orchestrator should use
  that wording in the role prompts). `README.md` is final verification's (from the credits table §14.13). An export
  another role imports never changes signature in wave 1 (add a new one; the integration removes the old).
- **Builds.** Only `us-pipeline` (3 smoke fires: Horse Gulch MT 2024, Black Cove NC 2025, one active non-CA fire of
  1,000 ac or more in the South or East) and `validation`. Each build only after `fire3d.cli weather-probe` says ok;
  when refused, wait for the reset (about 00:00 UTC). No browser run presses "Prepare analysis"; every browser run
  counts its non-GET requests.
- **Size.** The lower 48 is a bigger change than brief 2 (about 45 audit items). After deferring the P2 items and the
  items above, each wave-1 role is about **4-5 hours** of P0 work for one strong agent, a little above the 3-4 hour
  target; each role's tasks are ordered P0 first and end with a cut line, and what falls below it goes to the
  integration. Validation is about 6-8 hours, mostly builds, hindcasts and possible quota waits.
- **Reviews.** After each wave-1 role, an independent reviewer reruns that role's acceptance checks in
  `plan3-roles.json` (commands, counts, named swiftshader screenshots) and a fixer applies verified issues.

## Integration checklist (stage E, after validation)

1. Fold `docs/redesign/contract3/*.md` into CONTRACT §14 as "as built" sub-headings; apply `us-pipeline`'s SPEC §8 text.
2. Pass `tf` at every remaining cross-role call (§14.9.6), make the shims' `tf` required, run
   `node web/scripts/check-time-api.mjs web/src` (0), then delete the deprecated time API (§14.9.3); typecheck clean.
3. Make the five (R) `IncidentSummary` fields required in `web/src/api/types.ts` and update fixtures.
4. The carry-over and any P1 left below a cut line (W11 windowing, W15 phone fixes, the three `rasters.test.ts`
   tests: reload on key change, a single layer above the 256 MiB cap stays cached, two names sharing one URL keep
   their own names), then W16 if time allows.
5. Verify the brief end to end per RUNBOOK-3 §8: the overview with a few thousand markers at 1440x900 and 390x844 in
   Public and Command; fires in several states, including validation fires in UTM 12-17 with aligned overlays; local
   time zones; search in several states; Oregon (dev preset) and "not available in this state" elsewhere; NWS and
   local alerts; accuracy labels per region; California regression on Eaton and Palisades; keyboard and reduced
   motion. Frame rate is checked later on the user's Mac (no GPU here).

Final verification (stage F) then runs one national live-loop cycle (4 auto-builds cap), prepares at most one new
fire from its card, and writes the README rows from §14.13 (US coverage, new sources and licences, limitations:
Alaska and Hawaii not yet, accuracy by region, evacuation coverage by state, GOES-East and WFIGS history deferred).

## Testing

- **Unit tests for all new logic.** Backend (pytest, offline with recorded samples through `fire3d.http`): the
  California merge regression set, the WFIGS active rule and state rule, ids, regions at the named test points, UTM
  zones 10-19, gzip, records, the quota paths, LANDFIRE editions, issuer and time-zone text, the NWS state filter,
  local alerts and the archive's non-blocking path, evacuations (0 upstream requests for states without a feed,
  Oregon mapping, border dedup, privacy), GSI reference values and the regional aggregation. Web (vitest): the
  formatter in both clocks and six zones with DST days, clusters and labels, in-view lists, search parsing, lat/lon
  order, reprojection zones 10-19, accuracy wording (no banned words), the record disagreement rule, border points
  and card lines.
- **Gates** for every role: `cd backend && uv run pytest -q`; `cd web && npm run typecheck && npm run lint && npm
  test && npm run build` (lint stays at 55 warnings, all in `src/scene`).
- **In the app** (swiftshader screenshots, each viewed; names in each role's checks): the national overview desktop
  and phone, Public and Command; a non-CA fire card; `fixture-east` and the smoke fires with local times and aligned
  overlays; Eaton in both presets (California regression); search; Alaska coverage; Reno and Brookings official lines;
  the Oregon dev preset.
- **Secrets**: count-only key scans of every log.

## Risks

- **Open-Meteo's daily cap on the shared cloud IP** (the biggest schedule risk). Mitigation: quota handling is
  `us-pipeline`'s first milestone; every build waits for a successful probe; no ERA5 fill for validation builds; if
  the block lasts more than a day, the orchestrator asks the user (V §7: wait, use ERA5 with labels, or drop fires).
- **LANDFIRE 2025** stays NoData in the South and East until its November release: live builds there switch to
  LF2024 with a warning; validation fires do not need LF2025.
- **WFIGS field quality** (sizes missing, ALL CAPS names, duplicates, stale year-to-date rows): rules fixed in §14.2;
  the list says when NIFC is down.
- **Time migration breadth** (43 files across two roles): the deprecation script makes progress measurable and the
  integration removes the old API only when it reports 0.
- **Live fuel moisture outside California** is California's table until validation lands GSI; non-CA bundles say so
  in a warning, and the label only reports GSI-based scores.
- **OpenFEMA is slow** (15-60 s queries): never on the request path; a `pending` state instead.
- **Overview performance** with about 1,500 markers: clustering runs in MapLibre's worker; frame rate is checked
  later on a machine with a GPU.

## Estimated time

- Wave 1: three roles in parallel, about 4-5 h each, then `us-pipeline` about 4.5 h plus smoke builds; with reviews
  and fixes about 10-11 h of wall time.
- Wave 2 validation: about 6-8 h (longer if the weather quota is blocked).
- Integration about 2 h, final verification about 1.5 h.

## Appendix A. Audit item → role

| Role | Items |
|---|---|
| `us-catalog` | B-R1, B-R2 (contract, SPEC), B-R3, B-R4, B-R5, B-R10 (endpoint), B-R12, B-R13 (live list), B-R17, B-R23, B-R24 (SPEC rows), B-R25 (firedata recorder), V-R10 (endpoint, seed), V-R3 |
| `us-pipeline` | B-R2 (build gate), B-R6, B-R7, B-R8, B-R9, B-R10 (`fill_from_catalog`, CAL FIRE endpoint), B-R13 (weather budget), B-R22, B-R25 (official recorder), EV-R7 (backend), V-R1, V-R2, V-R4, V-R6, V-R7, V-R8, V-R13 (backend) |
| `us-official` | EV-R1, EV-R2, EV-R3, EV-R4, EV-R5, EV-R6, EV-R7 (web), EV-R8 (app credits), EV-R9, B-R16, W4, W7, W12, W13 |
| `us-web` | W1 (formatter + its files), W2, W3, W5, W6, W8, W9, W10, W11 (P1), W14, W15 (P1), V-R13 (web), carry-over `rasters.test.ts` (P1) |
| `validation` | V-R5 = B-R14 (GSI, pre-registered), V-R9, V-R14, protocol steps 0-7, `docs/validation.md`, `regional_accuracy.json` |
| deferred | B-R11, B-R15, B-R18, B-R19, B-R20, B-R21, EV-R10 (Washington: not built, round 3), EV-R11, EV-R12, V-R11 (covered by B-R5), V-R12, W16 (integration) |

## Appendix B. Ownership check

Run from the repository root with an optional file listing planned new paths (one per line). It turns each glob into a
regular expression (`*` and `?` stay inside one path segment, `**` crosses `/`, `[!x]` excludes a first character)
and reports clashes per wave.

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
    owner, clashes = {}, []
    for r in (r for r in roles if r["wave"] == wave):
        for g in r["owns"]:
            for p in (p for p in paths if rx(g).match(p)):
                if owner.setdefault(p, r["label"]) != r["label"]: clashes.append((p, owner[p], r["label"]))
    print(f"wave {wave}: {len(owner)} paths owned, {len(clashes)} clashes", *clashes, sep="\n  ")
```

Result on 2026-10-22 (tracked files plus the 58 new paths named in CONTRACT §14 and the role tasks): wave 1 owns 457
paths (`us-catalog` 62, `us-web` 217, `us-official` 98, `us-pipeline` 80) with **0 clashes**; every glob matches at
least one path. Code paths without a wave-1 owner: the three package `__init__.py` files (nobody edits them) and three
wave-2-only new files. Wave 2 (`validation` alone) owns 26 paths, 0 clashes; it reuses paths wave-1 roles owned,
which causes no conflict because it runs alone.
