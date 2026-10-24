# Brief 4 H3 progress (Public overview, Command overview, click to fire view, markers, locate-me)

Ports: API 8733, Vite 5193. Builder started 2026-10-24.

## Plan (order)
1. Overview chrome: Public minimal / details (ShowDetailsPill), centred search + LocateButton, fixed copy line,
   top-bar date + N ACTIVE, controls compact / bar, rotate hint placement, top edge gradient.
2. Markers in MapLibre (overviewLayers.ts PALETTE, sizes, centre dot, groups 10 + 4.2·sqrt(n) cap 36, "N FIRES").
3. Click -> fire view in Public (openFireView / pickFire), zoom focus off in Public, history.
4. Command overview (details always, no pill).
5. Phones.
6. P1 leader labels (map/LeaderLabels.tsx + map/leaderLayout.ts).
7. Screenshots, contrast, gates, CONTRACT 15.5 H3 paragraph, report, commit, push.

## Log
- Read BRIEF-4, PLAN-4, CONTRACT 15, HANDOFF, H2 report, Main screen + renders.
- WIP 1: overview chrome rebuilt (Public minimal / details, Command overview), ShowDetailsPill, OverviewStatus,
  LocateButton (+ locate.ts tests), SearchBox pill variant, list panel restyle, legend swatches, markers restyled
  (type sizes, centre dots, groups 10 + 4.2·√n, "N FIRES" + tick, smaller on phones' national view), pickFire /
  openFireView (Public opens the fire view), zoom focus and chips off in Public, overview map stays still when panels
  change, top plates behind the bar. Gates: typecheck ok, lint 55, tests 1318 + 2 skipped.
- WIP 2: leader-line labels (map/leaderLayout.ts pure + tests, map/LeaderLabels.tsx; MapLibre labels of named and
  past-the-cap fires hidden through useMapRuntime.leaderIds), the rotate hint placed beside the controls in the free
  map area (map/hintPlacement.ts + tests; marked seen after 2.5 s on screen), group counts above the names, medium /
  short screens (legend left of the list below 1080 px high, in the Layers panel below 1200 px), device wording fixed
  ("not saved or added to the link"), browser checks: clicks 9/9, locate-me 7/7, contrast >= 4.94:1.
- Final: leader labels recompute only on moveend / resize / chrome / units and once idle after new marker data (the
  idle feedback with basemap place names made them flicker); below z5 the MapLibre labels of every candidate are hidden
  (named or not), documented as a deviation from decision e's fallback. map/useMapAnchor.ts for H4 (lint clean).
  Labels keep clear of their marker when zoomed in and of the card's selection ring (feature property `lr`,
  `labelRadialOffset()`, CARD_RING_PX 8; tests). Screenshots retaken and viewed (Public minimal / details 1440x1144
  with the renders side by side, 1440x1000, 1024, Command overview, clicks, rotate hint, locate-me and denied, phones).
  Unobstructed at 1440x1000: Public minimal 0.90, details 0.55, Command overview 0.56. Gates: typecheck ok, lint 55
  (all src/scene), tests 96 files 1338 passed + 2 skipped, build ok. FIRMS key count-only scan 0. CONTRACT 15.5 "H3"
  paragraph and reports/brief4-h3.json written.
