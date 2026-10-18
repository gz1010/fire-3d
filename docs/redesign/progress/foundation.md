# Foundation agent progress log

## Done (complete)
- Read BRIEF, section-1 files, SPEC 4-6/9, module reports; baseline Forensic screenshot before touching App.tsx.
- Deps: maplibre-gl 5.24.0 (exact), vitest 5.0.3 (exact, dev); "test": "vitest run"; vitest config in vite.config.ts
  (node environment, src/**/*.test.ts).
- web/src/state/workspace.ts (+ workspace.test.ts): state slice, actions, URL sync, incident-switch subscription.
- web/src/data/rasters.ts (+ rasters.test.ts): three-free CPU raster loader/cache, raster sets + hook, sampling.
- Stubs at every owner path (map/, location/, ui/shell/, ui/timeline/, ui/feed/, lib/reproject|geodesy|plainLanguage);
  the MapView stub is a working minimal MapLibre map; LocationCard already samples real rasters.
- styles/map-tokens.css + styles/map-layout.css; App.tsx: workspace switch, Forensic unchanged + switch button,
  map-first layout with mount points; ui/shell/handoff.ts keeps the view centre across workspaces.
- docs/redesign/CONTRACT.md written.
- Verified: typecheck 0, vitest 18/18, lint exit 0 with the 55 baseline warnings (0 new), build 0; screenshots in
  docs/screenshots/redesign-foundation-*.png; servers on 8719/5189 stopped.

## Next
- Nothing; stage-2 agents (map-core, shell) take over.

## Decisions
- maplibre-gl 5.24.0 (newest 5.x >= 2 weeks old). npm audit: GHSA-jrc7-96c5-q579 (critical XSS bypass in
  DOM.sanitize, used only by AttributionControl; affects <= 6.4.0, no 5.x fix). Mitigation in CONTRACT §4.4:
  attributionControl false + text-only MapAttribution; never setHTML with external strings.
- Default workspace = 'map' (Public); Forensic via ?ws=forensic or the switch. Inactive workspace is unmounted.
- Selected location / view never written to the URL (privacy); ?view= / ?sel= read once at boot.
- Event selection does not replace the selected point (CONTRACT §8); "Check this location" may.
- data/ keeps its own decoded-array cache (three-free); Forensic's lib/raster cache is separate (ETag 304 on repeat).

## Open problems
- three.js still reaches the Public start-up bundle through ui/Charts.tsx -> lib/raster.ts (and lib/geo.ts);
  shell can lazy-load the Analysis drawer / Forensic workspace (CONTRACT §3).
