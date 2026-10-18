# Plan for UI/UX brief 2 (Oct 18, 2026)

Built from the three audits in `docs/redesign/audit-2/` (opening-map, civilian-flow, updates-official) against
`docs/redesign/BRIEF-2.md` and its decisions. The audits' IDs are kept as O-, C- and U- prefixes. Priorities: P0 is
needed for the brief, P1 should be done in the same build, P2 is optional. The order follows the brief: the map-first
experience, then search and risk explanation, then visual clarity.

## What the audits found (short)

- **Opening:**
  - There is no California overview; the app picks and even auto-builds a fire for you.
  - The opening camera is unreliable, with three causes reproduced:
    - the first fire selection is treated as a switch between fires;
    - the view moves in stages as data arrives;
    - a fit cut short is marked as done.
  - It frames the model's square, where the fire is 0.6-13% of the view.
  - A bad link is a dead end, and the fire itself is not clickable.
- **Search:**
  - Escape and edits don't cancel a lookup.
  - On phones the results hide behind sheets.
  - Errors cover the card.
  - Town names silently switch fires and can start a multi-minute build ("Malibu" → Bryson).
  - ZIP codes and towns can't be searched.
- **Location card:**
  - A big model "0%" is the largest element, even for a home that burned.
  - It gives no human reasons (wind toward or away, dryness, uphill) and never says the data is stale.
  - Its official line claims "none listed" in places never checked, and silently disappears in replay and on phones.
- **Official info:**
  - It is rare and buried among satellite passes.
  - One evacuation item shows the fetch time as its issue time and belongs to a neighbouring fire.
  - CAL FIRE changes are overwritten, with no history; NWS alerts don't exist yet.
- **Clarity:**
  - Grey text fails WCAG AA on aerial and roads.
  - The Public and Command cards are identical, and Public shows Command-level detail.
  - On a phone with a point selected, only 100-150 px of map is visible.
- **Aerial default (decision 5):**
  - The USGS photos are from June 2024 or earlier, before every fire, and no date is shown.
  - At close zoom the fire layers hide the photo.
  - There is no fallback when USGS fails.

## Work, by priority

**1. Map-first opening (P0)**
- O-R1: California overview routing.
  - No default fire, and no auto-build.
  - Opening a fire adds a history step, so Back returns to the overview.
  - A link that names a fire opens it directly and loads in parallel; an unknown link falls back to the overview with
    a notice.
- O-R2/R3: the overview map and panel.
  - Current fires and this year's large fires as markers sized by acreage, with an accessible list (peek sheet on
    phones).
  - CAL FIRE's official record and link on each.
  - Clicking a fire flies to it.
- O-R8 (P1): backend support.
  - The 2026 season, with the 2025 fires behind a filter.
  - Fire areas in the list rows.
- O-R6 (P1): a fire card when the fire is clicked.
  - It shows CAL FIRE status, a "Prepare analysis (1-3 min)" button for unbuilt fires instead of an automatic build,
    Play spread, Check a location and Open in 3D.
- O-R4: a deterministic opening camera: one flight, the same view every time, and robust to clicks during the flight.
- O-R5 (P1): frame the fire itself, not the model square; the "Incident" button toggles fire and modeled area.
- O-R7 (P1): a map-first Forensic entry. The phone sheet starts collapsed, the selected point is drawn in 3D, and
  clicking selects a point.

**2. Search and risk explanation (P0)**
- C-R1/R3/R4: dependable search.
  - A labelled "Check an address" box that leads the overview.
  - Lookups are cancelled on Escape or edit, there is one popover state, and results are never hidden behind sheets.
  - Plain error text.
  - A fire switch happens only on an exact fire name, never with an auto-build.
- C-R5 (P1): towns and ZIP codes from the public-domain Census Gazetteer (42 KB, no key). Picking one moves the map
  and asks for an address or a map click.
- O-R9: search from the overview shows the nearest fires with distances. It never makes a risk statement from distance
  alone.
- C-R6: a new 4-part first summary in the location card. Details stay one tap away.
  1. Near here: inside the fire area, or the distance and direction to it, tagged Mapped or Estimate, with its age.
  2. Official evacuation information: always one line, plus "Follow local officials" with links.
  3. Up to 3 main reasons, each tagged observed, estimated or modeled: wind from the fire toward or away from here;
     dryness (humidity and fuel moisture); uphill of the fire edge.
  4. Updated and reliability: the data age and a STALE flag, the model's issue time, and "not an evacuation order".
- C-R7 + U-R1: honest official information at a point.
  - "None listed" is shown only inside the area actually checked; elsewhere it says "not checked here".
  - It is shown on phones and in replay, with a reason when it is unavailable.
  - Real issuer and Cal OES times, never the fetch time.
  - The distance to the fire, and "Cal OES does not say which fire this is for".
- NWS line in the card: "Fire weather alert here: Red Flag Warning (NWS ...) until ...".

**3. Official information (P0)**
- U-R2/R3/R4/R8: an "Official now" block pinned at the top of the updates panel and the phone sheet.
  - Rows: evacuations, CAL FIRE status, NWS fire weather.
  - Each row has its issuer, issued/updated/expires times, a source link and an explicit quiet state ("not an
    all-clear").
  - The phone Updates button gets a label and a badge.
  - The empty and quiet wording is fixed so that silence never reads as safety.
- U-R6: CAL FIRE status changes.
  - The backend records every change of acres, containment and status, with CAL FIRE's own update time, in an
    append-only history outside the bundles.
  - A new `/api/official/calfire` endpoint serves it.
  - Feed rows read like "CAL FIRE: 65% contained (was 50%)", with a link.
  - Past fires get only CAL FIRE's final record, and the app says so.
- U-R7: NWS Red Flag Warnings and Fire Weather Watches.
  - One cached statewide request covers live fires.
  - The Iowa Environmental Mesonet public-domain archive covers replays; it is labelled as an archived copy.
  - The NWS wording is kept verbatim.
  - The alert zones are drawn as outlines on the map, with a legend entry, a feed row, the card line and the credit
    "National Weather Service".
- U-R5/R10 (P1): official rows fit and highlight their area on click, and never seek into the forecast. An "Official"
  filter is added, and the day's satellite passes are grouped into one row.

**4. Visual clarity and Public vs Command**
- C-R9 (P0): contrast and text sizes.
  - The grey text token is raised to at least 4.5:1 on all three basemaps, and Public panels are more opaque.
  - Minimum text sizes are set.
  - The safety note and the credits get an opaque chip.
- O-R10 (P0): Public opens on aerial with labels, and Command stays dark. A basemap the user picks always wins, and
  the URL rules are updated.
- O-R11/R12 (P0): legibility on aerial.
  - Casings on the fire lines and a lighter fill at close zoom.
  - An honest photo-date line: "USGS photos, June 2024 or earlier: before this fire".
  - If USGS fails, the map falls back to the dark map with a notice and stops retrying.
- C-R8 (P1): the Public/Command split.
  - Public is calm: plain words, no run IDs, and "+ Note" is hidden.
  - Command shows the model run, its issue time, the number of runs, quantiles and source status up front.
  - The header gets one "Public · Command · Forensic" switch (the names are kept).
- C-R2 (P1): phones keep the map visible while the card is open.
- U-R9 (P1): one freshness rule everywhere: "updated <source time> · checked <ago>", plus a Stale, Delayed,
  Unavailable or Not-for-past-dates chip. Public gets one line about source freshness.

**5. Map detail and navigation (P1)**
- O-R13: muted 3D buildings (OpenStreetMap shapes through OpenFreeMap) in 3D from zoom 15, on every basemap, below
  the labels and never coloured by fire. A legend caveat says: "today's OpenStreetMap; buildings destroyed by this
  fire may be missing; not a damage assessment".
- O-R14: rotate and tilt buttons in 3D (⟲ ⟳, tilt ±, Top-down, North up), a one-time gesture hint, and the keyboard
  shortcuts listed.
- O-R15: a "Satellite" chip on the map, for example "Newest: VIIRS · Oct 17 14:30 PDT (18 h ago) · 375 m".
  - The image on the map gets a caption: platform, time, age, pixel size, cloud cover, "not live".
  - The newest image of the fire after its start is listed first.

**Not in this build:** post-fire aerial photos and CAL FIRE damage inspections (not chosen), InciWeb (not chosen), and
the optional Forensic restyle. P2 items (U-R11 Forensic kind glyphs, U-R12 statewide NWS outlines on the overview,
C-R10 search polish) are done only if time allows.

## Defaults (change any of them before the build starts)

- **"This year's large fires":** the 2026 season (active fires and 2026 fires of 300 ac or more), with 2025 behind a
  filter.
- **Unbuilt fire on the overview:** a card with "Prepare analysis (1-3 min)", never an automatic build.
- **Past NWS alerts in replay:** from the Iowa Environmental Mesonet archive (public domain), labelled as an archived
  copy of NWS products.
- **NWS User-Agent:** "Fire-3d/0.1 (research prototype)", with no personal contact. An optional setting can add one
  later.
- **CAL FIRE history:** recorded whenever the backend checks CAL FIRE. History starts now; nothing earlier exists.
- **Official zones "near this fire":** within 15 km, always labelled with their distance.

## Decisions (answered Oct 18)

1. **Model percentage in Public:** a dated sentence replaces the big "0%". Command keeps the figure.
2. **Coordinate strip:** it stays **always visible** in Public and Command, as the first brief asked. C-R8 and C-R2
   therefore use a compact Public strip and a one-line phone strip; they never hide it.
3. **Pre-fire photos and today's 3D shapes:** shown, with clear date and caveat lines.
4. **Build:** approved; started Oct 18.

## Change after approval (Oct 18, 12:30): zoom to see the spread (BRIEF-2 decision 10)

The overview and a fire's view become one continuous map:
- Zooming in on a prepared fire focuses it automatically, with no click and no camera move; zooming out returns to the overview.
- Map: the viewport logic (focus thresholds with hysteresis; the built fire nearest the center whose area is in view) and outlines for other prepared fires in view.
- Shell: a store action `focusIncidentFromMap(id | null)`. It loads the fire without an auto-build, history push or framing flight, and keeps loaded fires cached.
- The focus time defaults to the latest observation, so the whole spread is visible; Play animates it.

Estimated extra time: 30-45 min.

## How the build runs

Five agents in parallel, each owning separate files, then one integration check, then the final check:

| Agent | Owns | Work |
|---|---|---|
| map | `web/src/map/**`, new `lib/fireBounds.ts` | overview layer, camera, fire framing, fire hit-test, aerial legibility and fallback, 3D buildings, rotate/tilt, the mount point for NWS outlines and the satellite chip |
| shell | `App.tsx`, `ui/shell/**`, `styles/**`, `state/**`, `ui/IncidentPicker.tsx` | overview routing and panel, fire card, the Forensic entry (non-scene parts), the aerial default, contrast tokens, header, phone layout, the coordinate-strip default, the phone Updates badge |
| location | `web/src/location/**`, backend `api/geocode.py` + Gazetteer data | search reliability, towns and ZIP codes, overview search, the new card summary, official info at the point (through the official hooks) |
| official-backend | new `backend/fire3d/sources/calfire_history.py`, `sources/nws.py`, `api/official.py`, `catalog.py`, `contracts.py`, tests | CAL FIRE history, NWS live and archive with zones, the 2026 season and fire areas in the lists |
| official-web | `web/src/ui/feed/**`, new `web/src/official/**`, `web/src/extras/**`, `ui/KeyEvents.tsx`, `ui/eventMeta.ts`, wording in `lib/plainLanguage.ts` and `ui/timeline/**` | the Official-now block, feed wording, filters and jumps, honest evacuation times and the zone-at-point check, CAL FIRE and NWS rows, the NWS map layer module, the satellite chip, and a `useOfficialAtPoint()` hook for the card |

- **Shared interfaces** are written into CONTRACT.md first:
  - the official hooks and their envelope;
  - the overview state in the workspace store;
  - the fire-bounds helper.
- **Scene:** one small addition in `web/src/scene` (the selection pin), handled by the shell agent with care.
- **Then:**
  1. An integration agent wires the pieces together and reruns every check.
  2. The paused final-verification agent runs once on the result (full live test, review, README and final
     screenshots).

## Testing

- **Unit tests for all new logic:**
  - web (vitest): camera framing (including delayed responses and clicks during the flight), fire bounds, the search
    state machine and cancellation, Gazetteer matching, the card's semantics, freshness, and official-row building;
  - backend (pytest, offline with recorded samples): NWS parsing and IEM, the CAL FIRE change log, and the endpoints.
- **Gates:** typecheck, lint (no new warnings), the web build and the full backend suite must pass.
- **In the app:**
  - real fires (Eaton, Palisades, Madre, Cooley, Henderson, Norte) at 1440×900 and 390×844;
  - the earlier section 12 scripts are rerun: overlay alignment (0 mismatched pixels), the scenario flow and coverage;
  - a contrast measurement on all three basemaps (all key text ≥ 4.5:1);
  - the opening camera checked with slow and failing responses;
  - keyboard and reduced motion;
  - a count-only secret scan.
- **Final check:** the full stack with the live loop on, and every screenshot viewed.

## Estimated time

- **The 5 build agents in parallel:** about 3-4 h. The longest jobs are the card summary and NWS end to end.
- **Integration check:** about 1-1.5 h.
- **Final check:** about 1-1.5 h.
- **Total after approval:** about 5-7 h. Usage limits or pauses add to that.
