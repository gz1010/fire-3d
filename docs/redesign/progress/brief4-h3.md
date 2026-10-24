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
