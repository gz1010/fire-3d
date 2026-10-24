# Brief 4 H2a (foundation) progress

Ports: API 8732, Vite 5192.

## Done (uncommitted until the gates + screenshots pass)
1. Tokens: map-tokens.css values + new tokens; re-pointing block orange; map-bridge.css / map-layout.css literals
   tokenised; TS mirrors (overlayModel TOKENS/OBSERVED_RGBA/FORECAST_RGBA, basemapStyle DARK + BUILDING_COLORS.dark,
   extras/style + cameras halo, official/style redFlag #ee7aa0); index.html Inter 800 + theme-color #0c0c0c. Small
   blue/cyan literal sweep in location.css, map.css, overview.css, extras.css; alert badge -> --m-alert.
2. Components: ui/Logo.tsx (+ Header.tsx re-export), ui/shell/TopBar.tsx (+ styles/topbar.css), fixedCopy.ts +
   FixedCopy.tsx, Readout.tsx, topBarText.ts (placeLine, statusSegments), fireBarInfo.ts, topBarItems.tsx (moved
   header items from the deleted MapHeader.tsx), IncidentPicker variant="title".
3. Split: App.tsx MapWorkspace + OverviewChrome / PublicFireChrome / CommandFireChrome; map/MapAtmosphere.tsx stub +
   styles/atmosphere.css; views.ts mapChromeOf / atmosphereEdgesOf; root data-view.
4. State: workspace overviewDetails/device/setters, SelectionSource 'device' (locationCheck text); store
   flyTo.bearingDeg + flyToLocal(x, z, distance?, bearingDeg?).
5. CSS moves -> forensic-entry.css.
6. shot.mjs --shot-timeout, --quality low.
Tests: TopBar.test.ts, fixedCopy.test.ts, Readout.test.ts, views/workspace/store additions, basemap test updated.

## Next
7. Run app (8732/5192), screenshots, compare with before/.
8. CONTRACT 15.5 H2a paragraph, report json, commit + push.
