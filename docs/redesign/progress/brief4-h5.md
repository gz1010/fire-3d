# Brief 4 H5 (Forensic restyle and rotation): progress

- 2026-10-24: started. Read BRIEF-4, PLAN-4 (all, §11), CONTRACT §15 (H2 as built), HANDOFF, H2 report, ForensicView
  screen + render, before/after-H2 shots. No earlier H5 attempt found (no progress file, tree clean at 3640341).
- Tokens: theme.css greys + `--gold*` = orange accent family, `--accent-ink`, `--text-body`, `--link`, `--fire-3`,
  chart colours; layout vars `--bar-top 20`, `--header-h 40`, `--edge 16`, `--panel-w 336`. Global golds replaced in
  controls.css / theme.css / header.css / overlays.css (map-bridge keeps the map's look; menu icons grey only in
  Forensic; range sliders grey only in Forensic via `--range-fill`).
- Header.tsx → H2 TopBar (back = map overview, logo, picker pill, place · dates, ViewPill centre, Incident | Aircraft,
  IconPill menus, Hide panels); MiniBar restyled with a small ViewPill; Menus.tsx buttons → IconPill; Settings lists
  Q / E / N. `.fx-ws-switch` removed; entry controls under the compass; FixedCopy pill; 120 px top fade.
- Right panel 336 px / top 76 / radius 16, tabs, layer rows, Incident Overview collapsed by default, weather grid as
  the screen (flame length #ff9a5a); dock 16 / 368 / 16, timeline restyle (accent play, range tabs, knob with ring,
  amber forecast hatch, orange played hatch).
- Rotation: sceneStore `rotate` / `set-heading` commands; CameraRig: 2D rotates (polar clamped), heading kept 2D↔3D,
  frame-fire keeps the heading, RotationTarget registered, Safari gesture + touch twist (scene/camera/heading.ts,
  TwistTracker), flyTo.bearingDeg applied. Compass: 60 px grey dial, orange N, drag via useCompassDrag, ⟲ ⟳ beside.
- First screenshots (fixture-live 1440, phone) viewed; phone fixes (dial 48, view pill row, dock selects hidden on
  phones as they are in View options, timeline row).
