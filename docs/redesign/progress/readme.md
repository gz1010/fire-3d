# readme agent: progress log

## Done
- 22:40 Started (fresh: no README.md, no earlier log). Read the full prompt.
- 23:05 Research done: BRIEF, CONTRACT (§1-5, §12), SPEC (§0-2, §6, §8.4-8.7, §9.1, §10-11), validation.md (all),
  module-reports (scaffold/terrain/firedata/api/scene/ui), progress logs, pyproject/package.json/vite.config/dev.sh/
  .gitignore/cli.py. CLI --help for all 5 commands + validate + dev.sh --help run (uv run --no-sync, no env changes).
- Licences checked on official pages (Open-Meteo terms+licence, OpenFreeMap + ToS, Mapterhorn + attribution.json,
  adsb.lol API docs, adsb.fi opendata, pyretechnics PyPI + installed LICENSE + GitHub LICENSE.md, USGS copyrights,
  OSM copyright, OpenMapTiles LICENSE, MapLibre LICENSE, FIRMS map_key, Census geocoder pages, NAIP/WFIGS metadata).
- Screenshots chosen (viewed): redesign-shell-public-1440-selected, redesign-shell-command-1440-3d,
  redesign-shell-forensic-1440.
- 22:50 README.md written (all 9 sections). Paused 22:51, resumed 23:27.
- 23:29 Fixes after code checks: unbuilt incidents auto-build (store.autoBuild default true; first open picks Eaton
  via pickDefault) instead of "Build button"; card tags (Mapped/Observed/Estimate/Model/Approximate/Unknown);
  hindcast growth wording; GOES 2-3 km; build-error row; extras API path. Verified: FIRMS keyless warning reaches
  manifest ("FIRMS: ..." in observed.py); no LICENSE file; uv.lock + package-lock.json exist.
- 23:33 Link check: 41 external URLs, all 200 except github.com 429 (rate limit; page read earlier) and fire.ca.gov 403
  (bot block; marked verify). Relative links/anchors OK. Markdown structure OK (16 fences, 7 verify comments, tables
  consistent). US spelling OK ("licence" only in an Open-Meteo URL, "Defence" in Airbus' name). FireTrace 0. FIRMS key
  count-only check: 0 occurrences in my files. pytest 478 passed 18.8 s (--no-sync); vitest 27 files / 401 passed.
- More fixes: incident-name search opens the fire (no card); fixture server has no geocode/extras; FIRMS keyless
  detail; NAIP terms link (USDA FSA policy); direction bullet honest about Eaton (north, downwind non-burnable);
  mermaid made conservative (nodes defined before links, no HTML entities); fixture URL must be opened directly.
- 23:36 Final: validation.md §6 is still the 16:32 text (backend-followups was editing ensemble.py at 23:32), so the
  README live paragraph matches it and stays verify-marked. Report: docs/redesign/reports/readme.json. DONE.

- Oct 18 00:07 New coordinator task: backend-followups finished the live-start fix. Read the updated
  validation.md (summary, 5-9), SPEC 2 (CMR row), 5.1, 6, 8.3, 8.7 and the backend-followups report. Every number in
  the suggested "Live forecasts" text checks out (validation 6.1, 6.2, 6.4).

- 00:20 Done: "Live forecasts" rewritten from validation 6.1/6.2/6.4 + SPEC 8.3 (suggested text checked number by
  number; US spelling; CAL FIRE 1.25x + 100 ac veto and CMR-outage fallback added; pseudo-live 0.360->0.666,
  85.7x->2.81x, 14 quiet issues, 9 Lidia; hindcast 0.422 unchanged). Cooley limitation (1,474 vs 731 ac; quiet rule
  0 % held, containment minimum 6 % per its forecast warnings) with a verify comment. "Lagging summaries" replaced by
  a "No fire seen has limits" item; data-flow step 5 now says the live loop copies CAL FIRE acres/containment/status
  each 15 min (SPEC 8.7). Added NASA CMR row (main table), overpass + live_observation modules, validate live-start,
  troubleshooting row "live forecast shows no growth", runtimes 2-25 s. Spot-checked Henderson bundle (start Oct 17
  15:50 PDT, 13 passes, p50 3,228 ac, summary 3,160 ac / 50 %). Checks: 44 URLs (3 new, all 200), fences 16, tables
  OK, 6 verify comments, FireTrace 0, key 0. Report overwritten.

- Oct 18 00:26 Third task: backend-followups round 2 (growth-only activity rule; validation summary, 3.2, 5, 6.2,
  6.3, 6.4, 6.6 and SPEC 8.5 changed). Re-copy skill numbers, drop the Cooley claim, add the suppression limitation.

- 00:40 Done: read validation.md (summary, 3, 3.2, 5, 5.1, 5.2, 6.1-6.6, 7, 8) and SPEC 8.5 + combined
  backend-followups report. README: held-perimeter item now says a detection counts as spread only where it
  coincides with growth (burnout > 12 h old is not spread); skill table re-copied (row 1 from sec 3 incl. per-fire;
  single run 0.432 with Eaton/Madre/Palisades 0.432/0.392/0.458 from 6.3, per-lead "-" because not published;
  ensemble 0.438 with 0.438/0.395/0.467 and 0.349/0.432/0.481/0.490 from 5.1); text 0.422->0.432 and 0.428->0.438 all
  via Madre; median growth ratio 1.85; published hindcasts predate the rule (6.6 last bullet). Pseudo-live now
  0.36->0.67, 86x->2.6x (6.2 + summary), "does not affect hindcasts". Cooley claim + verify removed; replaced by
  "small fires that crews stop early" (6.6: ~1,450 ac error vs ~50 ac observed, <400 ac fires, 1 of 33 active, Camino
  1,696 vs 0). Not-modeled bullet mentions initial attack + live containment minimum. Checks: 26 figures matched by
  regex against validation.md (0 missing); 44 URLs: 43 x 200 (usgs.gov 3DEP timed out once, 200 on retry),
  fire.ca.gov 403; fences 16, tables OK, 5 verify comments, Cooley 0, FireTrace 0, key 0. Report overwritten.

## Next
- (final-verification agent) resolve the 5 remaining <!-- verify --> markers; swap in redesign-final-* screenshots.

## Decisions
- pyretechnics: pinned 2026.8.10 is EPL-2.0 (PyPI + bundled LICENSE), but GitHub main now has a non-commercial
  "Community License" + paid commercial licence: README states both (upgrade caveat).
- Open-Meteo free API = non-commercial only (terms page) + CC BY 4.0 credit "Weather data by Open-Meteo.com".
- fire.ca.gov returns 403 to automated checks: CAL FIRE reuse terms marked <!-- verify -->. WFIGS layer has no
  licence metadata: marked <!-- verify -->. LANDFIRE public domain per USGS data catalog: marked <!-- verify -->.
- Forensic screenshot shows the removed "FFWI 37 moderate" label: marked for swap.
- Quick start leads with ./dev.sh --no-live (quiet first look); ./dev.sh and the other flags are in the table.

## Open problems
- UI shows Open-Meteo only as a data-status label, not as the CC BY credit link the licence asks for (report to final
  verification / ui-integration).
- Mermaid diagrams not render-tested locally (no renderer installed; installs not allowed): check the GitHub preview.
