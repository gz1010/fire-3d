# Fire-3d UI redesign — handoff for Claude Code

This folder is a design reference for restyling the existing Fire-3d app. Apply the visual and layout changes to the real components; keep all existing data, logic and map rendering.

## What's in here

| Path | What it is |
|---|---|
| `screens/Main.dc.html` | US "all fires" general view (Public), minimal by default with a "Show details" toggle |
| `screens/FireView.dc.html` | Public fire view (Willow): hazard circle, facts list, distance chip |
| `screens/FloodView.dc.html` | Public flood view (Animas River), work in progress, mostly placeholder data |
| `screens/CommandView.dc.html` | Command view (Willow) |
| `screens/ForensicView.dc.html` | Forensic view (Willow), 3D terrain |
| `assets/*.jpg` | Map backgrounds (screenshots of the current app with old UI removed) |
| `assets/command-view-concept.png` | Rendered concept image of the Command view |

### How to read the `.dc.html` files

They are design-canvas sources, not production code:
- `{{name}}` is a template hole filled from `renderVals()` in the `<script type="text/x-dc">` block at the bottom.
- `<sc-for list=… as=…>` is a loop, and `<sc-if value=…>` is a conditional.
- `<x-dc>`, `<helmet>` and `support.js` belong to the canvas runtime and should be ignored.
- All styles are inline. Treat the exact px values, colours and fonts as the spec.

### Map images are placeholders

The map images are static screenshots with the old panels painted out. In the app, keep the real map (MapLibre / 3D terrain) and only take overlay styling from these files. The exceptions are marker and label styling on the US map and the overlays on the fire, flood and Command views.

## Design system

**Fonts**
- Inter for UI text.
- JetBrains Mono for every number, coordinate, timestamp and small uppercase label (letter-spacing 0.1–0.16em).

**Colour: greys plus hazard colour.** No gold or olive anywhere in the interface.

| Token | Value | Use |
|---|---|---|
| ground | `#0c0c0c` | page background |
| panel glass | `rgba(14,14,14,0.6–0.74)` + `backdrop-filter: blur(18–24px) saturate(140%)` | all panels, pills, buttons |
| hairline | `rgba(200,200,200,0.12–0.22)` | borders, dividers |
| text | `#f0f0f0` / `#e6e6e6` | primary |
| text-2 | `#cfcfcf` / `#bdbdbd` | secondary |
| text-3 | `#9a9a9a` / `#8a8a8a` | labels, meta |
| accent (selected state) | `#ff7a3d`, text on it `#1a0a03` | active view tab, 2D/3D, range tabs, checked layers, play |
| fire | `#ff6a2a`, `#ff8a3c`, `#ff9a5a`, `#ffb27a` | fire markers, perimeters, leaders |
| modeled / forecast | `#f5c060` (dashed or hatched) | forecast spread, forecast part of the timeline |
| stale | `#e8b04a` | stale data tags, the stale ring on the timeline handle, data age |
| official | `#8fd3a8` | OFFICIAL badge, "Official now" |
| selected point / distance | `#9fd6ff`, `rgba(143,208,255,…)` | selected pin, distance-from-you chip |
| alert | `#ee7aa0` | NWS Red Flag polygons |
| flood | `#2a8ce6` fill, `#7fd4ff` edge | flood extent |

**Map tint.** A `mix-blend-mode: color` overlay of `#333333` desaturates the basemap. It is 0.75 on the US map and 0.35 on the fire and Command views. The Forensic 3D view keeps its original green terrain and gold map graphics, so it has no tint.

**Dimming.** Radial and edge gradients of `rgba(12,12,12,…)` darken the map edges behind text so the hazard area stays lit.

## Shared layout rules (keep consistent across views)

- **Top bar, floating.** It has no full-width bar, just items on the dimmed map.
  - Left: back arrow (on event views), Fire-3d logo, event name with a LIVE dot, then the place and date in grey.
  - Centre: the Public / Command / Forensic switch, a pill with the active tab in accent orange.
  - Right: data-source status in mono (age in amber if stale), then round icon buttons.
- **Readouts use "number — LABEL" rows.** The value is in mono at 22–26px; the label is uppercase at 10.5–11px in grey.
- **Map labels.** Hairline leader lines (0.9px) from the feature to a two-line label: name in Inter 12–13px semibold, then meta in mono 10–10.5px in the feature's colour.
- **Fixed copy.** The disclaimer "Research prototype — not for operational use" and "Not an all-clear. Follow local officials." must stay on every view.
- **Reduced motion.** Every animation must stop under `prefers-reduced-motion: reduce`.

## Per-view changes

### US all fires (Main)
- Default state is minimal: top bar, a centred search pill with a separate locate-me button, edge dimming, a one-line disclaimer at the bottom centre, and a "Show details" pill at the bottom right showing the count of 203.
- "Show details" toggles the full set of panels: map controls, the "Fires in the lower 48" panel, the overview, the scale bar and the legend.
- Fire markers:
  - Every marker is a transparent circle: fill `#ff8a3c` at 10% opacity, a 1–1.2px stroke in `#ffc08a` at 80%, and a white-hot centre dot.
  - Circle size encodes the marker type: small fire r7, unnamed active fire r11, named fire r15, and groups `10 + 4.2·√n`.
  - Group counts are written as "28 FIRES" in mono with a short tick line.
  - Named large fires get leader-line labels with the name and "172,912 AC".
- Clicking a fire in the list opens the fire view.

### Fire view (Willow)
- Hazard circle, 312px:
  - Thermal texture: an `feTurbulence` smoky glow brightest at the bottom-left, slow drift, twinkling specks and film grain. There is no grid.
  - Text: "WILDFIRE · ACTIVE", then "Willow" at 72px/800, then "MORE IN COMMAND ›", which links to the Command view.
- Title: place and date centred at the top, with the distance chip below it (light blue, arrow, "20 mi | northeast of you"). The chip toggles to a "Share your location…" prompt.
- Official facts as "number — LABEL" rows on the left, plus the OFFICIAL badge and sources.
- Only the current fire area is shown on the map. There is no modeled spread and no timeline on this view.

### Flood view (work in progress)
- Same layout as the fire view.
- Hazard circle: muddy grey-green rushing water. Two stitched-noise current layers scroll sideways fast, with a mist band, slanted rain streaks and grain.
- All facts are placeholders.

### Command view (Willow)
- Left readout: selected point in mono at 30px; DMS, UTM and datum on one line; the "inside the mapped fire area" sentence with Mapped and Stale tags; the MODEL line; then "number — LABEL" rows.
- Right: "Official now" stack of one-line notices, each with a status dot, the title — verdict, and source/checked meta. Each notice expands to its full wording.
- Bottom: a slim timeline. The past is solid orange and the forecast dashed `#f5c060`. A tick marks "LATEST 14:30 · 6 H AGO". The handle is an orange dot with an amber ring when the data at that time is stale, and has a mono label above it.
- Legend chips and the scale bar sit above the timeline on the right.

### Forensic view (Willow)
- Keep the existing glassmorphism, density and 3D terrain colours.
- Recolour the UI only, to the greys plus accent above.
- Move the Public / Command / Forensic switch from the floating left box into the top bar centre.
- Frame fire and Charts & key events sit under the compass at the top left.
- Keep the right panel (Layers tabs, Base and Fire layer lists, Incident Overview, Weather & Fire Behavior) and the bottom timeline in place.
- Layer swatches keep their original data colours so they stay readable.
- The weather readings keep their icons; flame length is in orange.
