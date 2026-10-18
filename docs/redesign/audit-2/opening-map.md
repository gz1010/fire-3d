# Audit 2: opening experience and the map (audit-opening)

Scope: BRIEF-2 §1 (map-first), §2 (opening) and §6 (rotation, close-up detail, recent imagery), plus decisions 1, 2
and 5. Method (2026-10-18, code at b07e0cb): API 8711 (`FIRE3D_LIVE=0`) and Vite 5181 on the 10 bundles in
`data/incidents`, at 1440×900 and 390×844. I used `scripts/shot.mjs` plus a Playwright probe in the session scratchpad
(`v6/opening/probe.mjs`): it traces every camera call, delays or aborts API responses and measures tile traffic. It
served the OpenFreeMap style from memory after the first fetch. Throughout: model output is experimental and never an
evacuation order, and official information stays separate from observations, estimates and model output.

## 1. What exists today

**Routing and defaults.**
- URL: `incident`, `t`, `mode` (`state/runtime.ts`). `ws` is always written; `preset`, `persp`, `basemap` and `units`
  only when not the default. `view=` and `sel=` are read once, then dropped (`state/workspace.ts` L150-196).
- Defaults: workspace `map`, preset `public`, 2D, basemap `dark`, independent of the preset (`workspace.ts` L214-225,
  CONTRACT §2).
- `App.tsx` `useBootstrap` (L48-93) awaits **both** CAL FIRE lists, even when the link names a fire (L56). It then
  calls `selectIncident(q.incident ?? pickDefault(…), { autoBuild: true })`.
  - `pickDefault` (`runtime.ts` L180-186): the largest built live fire, else 2025 Eaton, else the first entry.
    `?mode=live` takes `live[0]` even if it is not built.
  - `useAutoSelect` (L97-105) re-picks after a failed load. A fresh clone builds Eaton (1-3 min) on first open.
- Load order (`store.ts` L593-627, L358-403): lists → `/api/incidents/{id}` (summary) → 5 bundle JSON files plus the
  forecast → manifest, set in one update. Unbuilt fires start a build job with a progress card.

**First visit** (`audit2-opening-map-first-visit-1440.png`, `audit2-opening-map-first-visit-390.png`). With no link
the app opens one fire: Henderson, live (STALE here, live loop off). The URL becomes
`?ws=map&incident=2026-henderson-fire-3e3dfe&mode=live`. The camera fits the model's square analysis area (AOI): a
dashed box with four "Outside modeled area" labels. Unobstructed map (`__mapChrome()`): 75.8 % on desktop, 53.4 % on
the phone. The phone's bottom stack (timeline, coordinates, note, 5 lines of credits) takes about 40 % of the height.
Search sits on top; the map controls sit top-right.

**Loading, error and empty states.** While the lists load, a z5 view centred on (-119.4, 37.2) shows Oregon to
Arizona, with "Loading CAL FIRE incidents…". With the API down: "Cannot load incidents · Retry" over a usable basemap.
An unknown id (`audit2-opening-map-unknown-link-1440.png`) gives a 404 banner whose Retry cannot help, the empty z5
view and a strip stuck on "Loading…". A building fire shows its reported location with a "being prepared" notice.

**Initial camera** (`map/mapController.ts`).
- Constructor (L139-143): the restored `view`, else the summary point at z11, else California at z5.
- `frameIncident` (L337-344) uses `incidentFlyTo` (`workspace.ts` L206-211): the AOI bbox when the manifest is ready,
  else the reported point at z12. `fly` (L358-376) is a 1.1 s `fitBounds` (padding 28, maxZoom 15). A safe-area
  change restarts the flight (L380-391).
- In steady conditions the result is deterministic. Eaton Public 2D ended at z10.69 in 10 of 10 loads (3 of them cold
  `shot.mjs` runs, 3 with delays). Command z10.45, 3D z10.76, phone z9.79, Henderson z10.74-10.78.

**Data for an overview** (`GET /api/incidents?mode=live|historical`).
- Rows: CAL FIRE's reported `lat/lon`, `acres`, `percent_contained`, `is_active`, `started_ms`, `updated_ms`, `url`,
  `county`, `location`, `bundle_status`, `detections_24h`.
- Counts: 9 live fires (3 built) and 78 fires of 2025 at ≥300 ac (5 built). The past list is fixed at
  `HISTORICAL_YEAR = 2025` (`backend/fire3d/catalog.py` L34), though `calfire.list_year(year)` accepts any year.
- No row has an area: the AOI box needs one `/api/incidents/{id}` request per fire. Perimeters (local metres) exist
  for 5 of 8 real bundles.
- The fire covers only 0.6-13 % of its AOI (Norte 0.6, Cooley 1.0, Henderson 2.6, Eaton 10.7, Madre 13.1 %).
- A building manifest already has the AOI grid from step 1, but framing ignores non-ready manifests.
- The picker (`ui/IncidentPicker.tsx`): Live / 2025 tabs, search, a ≥100 ac switch, status and bundle chips. Picking
  an unbuilt fire builds it.

**The fire as an object.** Any click, on the fire or its marker included, selects that point for the location card
(`onClick` L538-557). The marker has only a hover popup (nothing on touch). CAL FIRE's link exists only in Forensic.

**Forensic entry.** `CameraRig.tsx` L147-161 frames burned area ∪ P90 reach (`scene/frame.ts`) from the
south-south-east. Desktop panels leave the scene about 1080×560 px. On phones the Layers sheet is open over the lower
half (`audit2-opening-map-forensic-390.png`). There is a hover probe but no click-to-select or search, and the map's
selected point is not drawn. With no incident the scene is empty.

**Workspace switch** (`ui/shell/handoff.ts`). Eaton map → Forensic → map kept the incident, time (moved −5 h),
forecast run, selection and view (z10.67 → z10.67).

**Rotation and tilt** (`map/MapControls.tsx`, MapLibre handlers at their defaults). Controls: 2D/3D (2D = pitch 0,
north up), a compass (resets bearing only; shows pitch in 3D), zoom and "Incident". Tested: Shift+←/→ rotates 15°
(also in 2D) and Shift+↑/↓ tilts 10° in 3D. Right-drag or Ctrl-drag, two-finger twist and (in 3D) two-finger drag
also work; touch was not exercisable headless. The canvas label mentions only arrows and +/−.

**3D buildings today** (`map/basemapStyle.ts`). Roads (OpenFreeMap Liberty) keeps `building-3d`, a light
fill-extrusion from z14 using `render_height` and `render_min_height` (L208-217). So 3D buildings appear in Roads + 3D
only. Dark has flat footprints from z12; Aerial drops buildings (`AERIAL_DROP` L219). Tiles are OpenMapTiles z14
(overzoomed above) with `render_height`, `render_min_height` and `colour`.

**Recent satellite imagery** (`ui/shell/LayersPanel.tsx`, `extras/ImageryPanel.tsx`;
`audit2-opening-map-recent-imagery-1440.png`). The path is Layers → "Official and optional sources" → a toggle that is
off by default. The panel sits about 1,520 px down the drawer: 2 clicks plus scrolling on desktop, 3 taps plus
scrolling on phones. The panel itself is complete: acquisition time, age, latency, pixel size, coverage, cloud, credit
and "not live". But for Cooley the auto-pick drew a blurry 375 m VIIRS image with no caption on the map. The compact
legend says only "Satellite image", and the list opens on Sentinel-2 scenes "before the fire".

**Aerial basemap today** (decision 5).
- USGS Imagery Only: 256 px JPEG tiles, max z16 (1:9,028; the map allows z18.5, so the photo is upscaled above z16).
  Desaturated, with Liberty roads and labels on top.
- The service reports "Data refreshed June, 2024", so its photos predate every fire in the app. The UI says only
  "Dated aerial imagery".
- Cold first view: desktop 40 tiles, 711 KB (median 18 KB), first tile 0.9 s, idle 1.9 s. Phone at 3×: 53 tiles,
  1.48 MB, idle 2.8 s. Aerial also loads the Liberty label tiles; the dark default totals 2.06 MB.
- On failure (`?mapfail=imagery`, `audit2-opening-map-aerial-fallback-1440.png`) there is only a dismissible notice.
  "Aerial + labels" stays selected over a bare navy map (roads and labels; no water or shading), and failed tiles keep
  being requested (59 errors).

## 2. Gaps

- **G1 MISSING: no California overview.** One fire is picked for the visitor and, in a fresh clone, built automatically
  (`runtime.ts` L180-186, `App.tsx` L59-64).
- **G2 BROKEN/UNRELIABLE: the opening camera.** Three causes explain the reported z5 / z12 / z10.3 results:
  1. **The first selection counts as an incident switch.** `mapController.ts` L209-217 resets `framed` on any
     `incidentId` change, null → id included. If the map mounts before `selectIncident` runs (slow lists), a
     `?view=` or hand-off view is discarded. Repro: live list delayed 1.5 s; `?view=-118.10,34.19,13.5` ends at z10.69
     instead of z13.5 (z13.5 in 4 of 4 runs without the delay).
  2. **A staged opening.** The camera goes from the z5 placeholder to the reported point at z12 (summary only,
     `incidentFlyTo` L209) to the AOI (all bundle files in). A capture at a fixed time shows whichever stage was
     reached. A cold CAL FIRE or FIRMS cache (45 s timeout) or a busy live loop stretches the z5 and z12 stages.
  3. **`framed` is set before the fit (L342) and never checked.** Any other camera call in the 1.1 s flight stops it
     off target, and nothing re-frames. Repro: switch Eaton → Palisades, click the compass 250 ms later. The map stops
     at -118.224, 34.168 z10.32, about 34 km east of the Palisades fit (z10.31). The zoom buttons, 2D/3D and a search
     fly do the same, and `fitBounds` silently does nothing when MapLibre's `cameraForBounds` fails.
  - Also: a cut-off padding ease leaves the padding off the safe area (110/139 vs 108/150 after a cold aerial load),
    and the restarts save intermediate views (L437-440).
- **G3 HARD TO UNDERSTAND: it frames the model square, not the fire.** The fire is 0.6-13 % of the framed area, and
  the dashed box and its labels dominate.
- **G4 BROKEN: a bad or old fire link is a dead end.** No fallback list, a pointless Retry, a stale "Loading…".
- **G5 INCOMPLETE: the loading fallback.** The western US at z5, with no fires, for as long as both lists take.
- **G6 MISSING: the fire is not clickable as a fire.** No card with CAL FIRE status, time and link on the map, and no
  touch equivalent of the hover popup.
- **G7 INCOMPLETE: Forensic is not map-first.** The phone sheet covers half the screen, and desktop panels take about
  half. The shared selection is not drawn, and there is no click-to-select.
- **G8 INCOMPLETE: history.** Switching keeps the state, but every URL write is `replaceState`, so Back cannot return
  to an overview or a previous fire. From an overview with no fire, Forensic would be empty.
- **G9 HIDDEN: rotation and tilt.** The gestures work, but nothing teaches them. "Top-down" exists only as 2D, which
  also resets north.
- **G10 HIDDEN, and an honesty risk: 3D buildings.** They show only on Roads + 3D, in Liberty's bright colour. Today's
  OpenStreetMap lacks most homes destroyed in 2025: west Altadena between Woodbury Rd and Montana St, and the
  Palisades grid around Bashford, Carey and Drummond Streets, have almost no shapes. Only 74 and 83 shapes were in
  the loaded tiles (`audit2-opening-map-3d-buildings-palisades.png`,
  `audit2-opening-map-3d-buildings-aerial-altadena.png`). Empty blocks can read as empty land.
- **G11 HIDDEN: recent satellite imagery.** It is deep in a drawer, with no map caption and no time in the compact
  legend, and the newest image of the fire is not listed first.
- **G12 INCOMPLETE (decision 5): Public's default is dark.** The basemap ignores the preset, and the URL rule "omit
  when dark" (`workspace.ts` L187-188) would be wrong per preset.
- **G13 HARD TO UNDERSTAND (honesty): the aerial photos are pre-fire** (June 2024 or older). Intact roofs show under
  the burned-area overlay, with no date.
- **G14 INCOMPLETE: aerial legibility at close zoom.**
  - Fine at overview and incident zoom: fire layers, labels, pin and chips read well
    (`audit2-opening-map-aerial-overview-sketch-1440.png`, `audit2-opening-map-aerial-incident-1440.png`).
  - At z15-16 in 2D, the observed fill plus yellow detection squares hide the photo
    (`audit2-opening-map-aerial-close-1440.png`).
  - In 3D the older-burn tint blends into the brown photo, so only the edge line separates burned from unburned
    (hiding the imagery confirmed the tint is drawn).
  - The 1.4 px dashed AOI line and 10.5 px area labels are weak on bright photos, and major roads (0.62 alpha) compete
    with the fire edge at z10-11.
  - `--m-text-3` measures 3.8-4.3:1 on aerial (civilian audit); that token fix is shell's (civilian R9).
- **G15 BROKEN for an aerial default: no fallback when USGS fails.** A bare map that keeps retrying, and no timeout
  for a slow first paint.
- **G16 INCOMPLETE: aerial cost and limits.** 0.7-1.5 MB of JPEG plus label tiles for the first view. The 256 px
  tiles look soft on high-DPI phones, and blurry above z16.
- **G17 MISSING: "this year's large fires".** In 2026 only the 9 active 2026 fires are listed; contained or out 2026
  fires are absent, and the past list is 2025.
- **G18 INCOMPLETE: overview data.** No area in list rows. Unbuilt fires (6 of 9 live, 73 of 78 past) have only a point
  and acres, and a click on one would start a multi-minute build that downloads from many public services.

## 3. Recommended changes

Effort: S < 2 h, M 2-4 h, L > 4 h of agent time. Ordered by the brief: map-first, then search and risk, then visual
clarity. Safety rules for all: the overview shows only CAL FIRE's official record, labelled "CAL FIRE (official) ·
updated <time>" with a link. Model output appears only inside a fire, labelled "Model · experimental · not an
evacuation order". "No active fires listed" is never an all-clear.

**Map-first**
- **R1 (P0, M, risk med): overview routing and states.** Value: with no link, everyone starts on California.
  - No `incident` means no default pick, no `useAutoSelect` and no build. Add `closeIncident()` (additive).
  - Opening a fire uses `pushState`, so Back returns to the overview. A named fire loads in parallel with the lists.
  - An unknown id falls back to the overview with a notice. In the overview, Forensic says "Open a fire first".
  - Files: `App.tsx`, `state/runtime.ts`, `state/store.ts`, `state/workspace.ts`, `ui/shell/WorkspaceSwitch.tsx`,
    `ui/shell/handoff.ts`; tests for the URL and history rules.
- **R2 (P0, M, risk med): the overview map.** Value: current and recent fires at a glance, each clickable.
  - New `map/overviewLayers.ts`: one point per fire, circles by √acres (4-13 px). Live fires filled orange with a
    white ring, past fires hollow amber. Labels "Name · acres" for live fires and those ≥ 20,000 ac, 22 px touch
    targets, and clustering or decluttering in SoCal.
  - Camera: fit California ([-124.48, 32.53, -114.13, 42.01]) in the safe area (about z5.2 desktop, z4.5 phone).
  - Click: open the fire and fly to its AOI (or the R5 fire bounds). For an unbuilt fire, fly to 2.5× its acreage
    circle (≥ 3 km), then to the AOI once the building manifest arrives, unless the user has moved.
  - The sketch with the real lists reads well on aerial at both widths.
  - Files: `map/overviewLayers.ts` (+test), `map/mapController.ts`, `map/layers.ts`, `map/MapLegend.tsx`,
    `map/MapControls.tsx`, `map/map.css`. Deps: R1.
- **R3 (P0, M, risk low): the overview panel and header.** Value: an accessible list and a clear way back.
  - New `ui/shell/OverviewPanel.tsx`: right column on desktop, peek sheet on phones ("9 active fires · CAL FIRE,
    updated 11:14"). Filters per Q1, picker rows, loading / error / empty states.
  - The overview hides the timeline and incident chips. Header: "California · all fires", and "← All fires" inside a
    fire.
  - Files: `ui/shell/OverviewPanel.tsx`, `ui/shell/MapHeader.tsx`, `ui/IncidentPicker.tsx`, `App.tsx`,
    `styles/map-layout.css`. Deps: R1. The NWS statewide layer (updates audit R7) fits here later.
- **R4 (P0, S-M, risk low-med): a deterministic opening camera (G2).** Value: the same link always opens the same
  view, in one flight.
  - Treat null → id as a first load, keeping a restored or deep-linked view. Mark a fire framed only when its fit
    completes.
  - Re-issue fits interrupted by non-user calls (a user gesture ends framing). Fall back to `easeTo` when
    `cameraForBounds` fails, and restore the padding.
  - Fly once, when the manifest (or the building manifest's grid) is ready.
  - Files: `map/mapController.ts` plus a pure `map/framing.ts` (+test); `App.tsx` for the parallel load. Add a
    delayed-response check like the probe.
- **R5 (P1, M, risk low): frame the fire, not the model square (G3).** Value: the fire fills the opening view.
  - Fit burned area ∪ latest perimeter ∪ P90 reach ∪ reported point, +40 %, between 3 km and the AOI; keep the AOI box
    visible. "Incident" toggles between the fire and the modeled area.
  - New `lib/fireBounds.ts` (+test) ports the pure `scan()` from `scene/frame.ts`. Files: `map/mapController.ts`,
    `map/MapControls.tsx`, a one-line hook in `incidentFlyTo`. Deps: R4.
- **R6 (P1, M, risk low): a fire card (G6).** Value: an obvious "click the fire".
  - The marker or label opens a card: name; CAL FIRE (official) acres, containment, status, time and link; "Analysis
    ready" or "Prepare analysis (1-3 min)"; Play spread / Check a location / Open in 3D.
  - Files: `map/mapController.ts` (hit-test), new `ui/shell/FireCard.tsx`, `styles/map-layout.css`. Deps: R2, Q2.
- **R7 (P1, M, risk low-med): a map-first Forensic entry (G7).** Value: the 3D scene leads.
  - Phones open with the sheet collapsed; desktop opens with a timeline-only dock and a labelled "Frame fire".
  - Draw `useWorkspace.selection` as a scene pin, and let a click set it.
  - Files: `ui/shell/ForensicWorkspace.tsx`, `styles/forensic-narrow.css`, `ui/RightPanel.tsx`, `ui/BottomDock.tsx`;
    small scene additions in `scene/probe/ProbeDriver.tsx` and a new `scene/overlays/SelectionPin.tsx`.
- **R8 (P1, S, risk low): backend support for the overview (G17, G18).** Value: real areas and this year's fires.
  - `bbox_lonlat` for built bundles in list rows (`_overlay`), and `year=` on `mode=historical` so 2026 is reachable.
  - Files: `backend/fire3d/api/app.py`, `catalog.py`, tests, `web/src/api/types.ts`. Deps: Q1.

**Address search and risk** (search reliability itself is civilian R1/R3)
- **R9 (P0, S, risk low): search from the overview.** Value: "is my address near a fire?" works before any fire is
  open.
  - The pin plus the nearest fires, with distance from CAL FIRE's reported point. Inside a built AOI, offer "Open the
    Eaton Fire analysis". Never a risk statement from distance alone.
  - Files: `location/SearchBox.tsx`, `location/LocationCard.tsx`. Deps: R1, R2, civilian R1/R3.

**Visual clarity and navigation**
- **R10 (P0, S, risk low): aerial as Public's default (decision 5).**
  - Effective basemap = the user's explicit pick, else dark in Command and aerial in Public. The store keeps
    `basemapPick`, set only by the menu, Layers or `?basemap=`. A preset switch follows the new default unless the
    user picked one.
  - The URL writes `basemap` only when it differs from that default (`?basemap=dark` becomes valid). Old Public links
    now open aerial; Command stays dark. The R12 fallback never counts as a pick.
  - Files: `state/workspace.ts` (+test), `map/MapControls.tsx`, `ui/shell/LayersPanel.tsx`, CONTRACT §2, README.
- **R11 (P0, M, risk med): aerial legibility and an honest photo date (G13, G14).** Value: fire and text read on
  photos, and nobody mistakes 2024 roofs for today.
  - An aerial theme: a 3 px dark casing under the AOI and perimeter lines, 12 px area labels with a 1.6 px halo, major
    roads at about 0.45 alpha. From z13, a lighter fill (edge kept bright) and outline-only, fainter detection squares.
  - Menu and legend line: "Aerial photos: USDA/USGS, June 2024 or earlier, taken before this fire".
  - Files: `map/layers.ts`, `map/overlayModel.ts`, `map/basemapStyle.ts`, `map/providers.ts`, `map/MapLegend.tsx`.
    Deps: R10; tokens via civilian R9.
- **R12 (P0, S, risk low): USGS limits and fallback (G15, G16).** Value: Public never opens on a broken map.
  - On failure (4 errors and no tile, or no tile within 8 s), switch to dark and stop requesting, with the notice
    "Aerial photos are not loading (USGS); showing the street map. Try aerial again".
  - Cap aerial at z17, or say "photo detail ends here" above z16. Keep the phone first view near 1.5 MB.
  - Files: `map/mapController.ts`, `map/MapNotices.tsx`. Deps: R10.
- **R13 (P1, S-M, risk low): 3D buildings (decision 2).** Value: shape and scale when tilted, without hiding fire
  information.
  - One muted fill-extrusion per basemap, replacing Liberty's: dark #4a5566, roads a warm grey, aerial #c3c9d1.
    Opacity 0.55-0.65, vertical gradient, 3D only, from z15 (fade from z14.5), below the labels. Never coloured by
    fire state.
  - Verified on 5.24 with terrain: extrusions draw after the draped fire layers, hide only their own footprint, and
    ran at about 60 fps. The z16+ "cannot calculate elevation" warning appears without them too.
  - Existing OSM / OpenMapTiles / OpenFreeMap credits cover it. Legend: "3D shapes: today's OpenStreetMap; buildings
    destroyed by this fire may be missing; not a damage assessment".
  - Files: `map/basemapStyle.ts` (+test), `map/mapController.ts`, `map/MapLegend.tsx`. Deps: Q3; check on a real
    phone.
- **R14 (P1, S, risk low): rotation and tilt (G9).** Value: users find rotate, tilt, north-up and top-down.
  - In 3D, an orbit group by the compass: ⟲ ⟳ 15°, tilt ±10°, "Top-down" (pitch 0, terrain kept), and "North up".
  - A one-time gesture hint, and Shift+arrows added to the canvas label.
  - Files: `map/MapControls.tsx`, `map/map.css`, `map/mapController.ts`.
- **R15 (P1, M, risk low): make recent satellite imagery visible (G11).** Value: one tap to the newest image of the
  fire, never mistaken for live.
  - A "Satellite" chip on the map ("Newest: VIIRS NOAA-21 · Oct 17 14:30 PDT (18 h ago) · 375 m"). While shown, a
    caption gives platform, time, age, pixel size, cloud and "not live".
  - The panel moves to its own popover, newest post-start images first. The compact legend gets platform and time.
  - Files: new `extras/ImageryChip.tsx`, `extras/ImageryPanel.tsx`, `extras/imagery.ts`, `extras/runtime.ts`,
    `extras/extras.css`, `ui/shell/LayersPanel.tsx`, a slot in `map/MapControls.tsx`.

**Split by owner, with no shared files.**
- Map agent: R2, the R4 map part, R5, the R6 hit-test, R11-R14 and the R15 slot. Every `mapController.ts`,
  `layers.ts` and `basemapStyle.ts` edit stays with one agent.
- Shell agent: R1, R3, the R4 `App.tsx` part, the R6 card, the R7 non-scene parts and R10 (it owns `workspace.ts` and
  `store.ts`).
- Location agent: R9. Extras agent: R15. Backend agent: R8. Scene: two small R7 files.
- Order: R1 → R2 and R3 → R6; R4 → R5; R10 → R11 and R12.

## 4. Open questions for the user

1. **"This year's large fires" in October 2026.** Show the 2026 season by default (active fires plus 2026 fires
   ≥ 300 ac, a small backend change), with 2025 behind a filter (recommended)? Or only the 2025 list the app has today?
2. **Clicking an unbuilt fire on the overview.** Today it builds at once (1-3 min, many public downloads). Show its
   card with "Prepare the analysis" instead (recommended), perhaps auto-building active fires only?
3. **Burn scars on aerial and in 3D.** Show today's OSM shapes and the June 2024 photos with clear date and caveat
   lines (recommended)? Or hide 3D buildings inside the fire's mapped area?
