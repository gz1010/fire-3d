# Brief 4: UI restyle from the design handoff (Oct 24, 2026)

The user sent a design handoff (`fire3d-handoff.zip`) and a list of UI and UX changes. They asked to focus on the handoff's UI changes first and to prioritise them. Other items in the same list (a second prediction model, search suggestions, a globe intro page) come later and are listed at the end.

Starting point: commit f318347, brief 3 (fires across the lower 48 states), all working.

The handoff is saved in `docs/redesign/handoff-4/`:
- `HANDOFF.md`: the design system and the per-view rules. It is the spec.
- `screens/*.dc.html`: one design-canvas file per view. The inline styles carry the exact px values, colours and fonts. `FloodView` is out of scope.
- `assets/*.jpg`: map backgrounds (screenshots of the app with the old panels painted out) and the Command concept image.
- `renders/*.jpg`: the screens rendered at 1440 px wide (Oct 24, 2026), for side-by-side comparison. `Main-details.jpg` is the main view after "Show details".

## The request (user's words, lightly cleaned)

> Read HANDOFF.md and the files in screens/. Restyle our app to match, one view at a time, starting with the Command view. Keep all existing data, map rendering and logic; change only styling and layout.

**Public**
1. General view: simplicity. "There's some discrepancy of the map where the right side looks cut off. Don't do that, just keep the map as it is, with the other components shown in the UI file."
   - Click on a fire → the fire view.
2. Fire view: "don't show the predicted fire, just the fire perimeter as the most recent update."

**Command:** "keep what we have now in Command (in terms of data, what you can do, dashboard, etc.) but for design change to the attached."

**Forensic:** "change the design to the attached." (Searching for a fire or picking a state in Forensic comes later; see below.)

**Direction:** "I still cannot turn the map as I wanted. I want to be able to do this in all 3 modes." Turning means rotating the compass heading (confirmed).

**Globe-like dimming:** "As you zoom in, the surrounding dims, and the map focuses on the central location. Central is bright and the surrounding dims. It should feel more like a globe, so the dimming part is like the perimeter of a circle."

## Decisions (Oct 24, 2026)

1. **Scope now: the handoff restyle**, plus map rotation in all three modes and the globe-like dimming. The order follows the handoff: shared look and top bar, then Command, then the Public overview, then the Public fire view, then Forensic.
2. **Lighter review process.** Each view gets one independent review, and its findings are fixed. There are no repeated re-check rounds and no review panel at the end. A final check runs the gates and takes screenshots.
3. **Keep the real map.** MapLibre and the 3D terrain stay as they are. Only overlay styling (panels, markers, labels, tint, dimming) comes from the screens. The mock map images are placeholders, and the Main mockup's cut-off right edge must not be copied.
4. **Flood view: skip.**
5. **Street-address suggestions: not now.** "Forget this for now: which source to use for street-address suggestions, if any." The locate-me button in the Main design uses the browser's own location only, with no outside service.
6. **Rotation means compass heading.** It must be possible in Public, Command and Forensic, in 2D as well as 3D.

## Standing rules (unchanged)

- Model output is experimental and never advice on when to evacuate ("Follow local officials"). Never use "safe" or "low risk". Outside the modeled area is unknown, not low.
- Official information keeps its issuer, its own times, its verbatim wording and a link. It is never merged with model output, and its absence is never an all-clear.
- Every view keeps "Research prototype — not for operational use" and "Not an all-clear. Follow local officials." (HANDOFF.md, fixed copy).
- Every animation stops under `prefers-reduced-motion: reduce`.
- No Google data, no paid map services, no Nominatim. Credit every source.
- The only secret is `FIRMS_MAP_KEY`. Never print, log, commit or copy it.
- Never use the name "FireTrace". Never commit `data/` or `.env`. Add a dependency only when it is clearly needed, and say why.
- Web gates: `npm run typecheck && npm run lint && npm test && npm run build`. The lint baseline is 55 warnings, all in `src/scene`; add none.

## Later (from the same list; not part of this brief)

- **Search suggestions:** towns, ZIP codes, counties and fire names as you type, plus "use my location". The source for street-address suggestions is still open.
- **Forensic:** search for a fire, or pick a state.
- **Globe intro page** (`Intro.dc.html`, a separate zip): a dotted globe with orbits, and zooming in hands over to the US map. Satellites use option 1: decorative orbits, with no live positions and no next-pass countdowns presented as real.
- **Wildfire-FM** (RAI-Lab, MIT, California 5 km weights) as an alternative experimental model. Option A or B, PyTorch and two new data sources are not decided yet.
