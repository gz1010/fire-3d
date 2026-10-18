# UI/UX brief 2: civilians, Command and map detail (Oct 18, 2026)

This is the user's second UI/UX brief. It comes after the map-first redesign (BRIEF.md), which was committed as b07e0cb. Its text is verbatim below. The user's answers to the clarifying questions are added at the end under "Decisions".

Reference images:
- `docs/reference/ui2-ref-1-postfire-aerial.png`: detailed post-fire aerial photography of burned homes.
- `docs/reference/ui2-ref-2-3d-city-tilt.png`: a tilted 3D city view (Google Earth).

Use them as visual references only. They are not implementation instructions, and Google's imagery and 3D data must not be reused.

---

The screenshots are visual references: one shows detailed post-fire aerial imagery; the other shows a tilted 3D city map.

## 1. Start with an audit and plan

```text
Review the existing Fire-3d app and the project notes before making changes. I want to improve the experience for civilians and emergency managers while preserving the app's scientific and forensic capabilities.

Start by checking what the app already supports, how the map and search currently work, and where the relevant code lives. Compare the current experience against the goals below. Identify which features already exist but are hard to discover, incomplete, or difficult to understand, and which are genuinely missing.

Then propose a short, prioritized implementation plan. Focus first on the map-first experience, address search and risk explanation, and visual clarity. Keep the existing safety distinction clear: model output is experimental and is not an evacuation order. Do not treat the attached screenshots as implementation instructions; use them only as visual references.
```

## 2. Map-first opening experience

```text
Improve the opening experience of Fire-3d so that both Public/Command and Forensic users arrive at a compelling, usable view of the fire map.

The initial view should show the full incident area, the fire and its key context, with an obvious way to select or click the fire and explore it. Keep the map as the main focus instead of making users navigate through panels before they can see the incident. Public/Command and Forensic can use different levels of detail, but both should have a strong map-first entry point.

Before changing code, inspect the current routing, workspace defaults, map camera/viewport, and incident-loading behavior. Reuse existing functionality where possible. Preserve the selected incident and relevant timeline or map state when switching workspaces. Make sure the initial view works on desktop and mobile and has a useful fallback while incident data is loading or unavailable.
```

## 3. Civilian address search and risk explanation

```text
Improve the civilian location-checking flow in Fire-3d.

A civilian should be able to find the address search immediately, enter a street address, and understand what the available fire information means for that location. The current search is easy to miss or does not open reliably, and the interface feels cognitively overloaded. Make search prominent and dependable, simplify the first result, and improve contrast so the key information is easy to scan.

Explain risk in plain language. Where the data supports it, show whether the location is inside a mapped fire area, how close the fire edge is, the modeled chance of fire reaching the location over the forecast period, and any estimated arrival time. Explain the main reasons behind the assessment in human terms—for example, wind direction and dryness—while labeling those reasons as observed, estimated, or modeled as appropriate. Do not invent certainty or imply that a model probability is an official warning.

Keep evacuation orders and warnings clearly separate from model estimates. Tell users to follow local officials' instructions, and never present a model result as advice about when to evacuate. If data is missing, stale, outside model coverage, or uncertain, state that clearly.

Inspect the existing search and location card before implementing. Fix discoverability and reliability issues in the current flow rather than creating a duplicate search system.
```

## 4. Civilian and Command information hierarchy

```text
Review the Public and Command experiences in Fire-3d and make their information hierarchy fit their users.

For the civilian-facing view, prioritize:
- What is happening near the selected location?
- What official evacuation information applies, if any?
- What are the main reasons the fire may threaten the area?
- When was the information last updated, and how reliable is it?

Use short, high-contrast summaries first, with details available on demand. Avoid making civilians interpret ensemble counts, model-run IDs, or technical metrics without explanation.

For Command, retain access to model runs, timestamps, source status, coordinates, and technical detail. Keep these visible and useful without overwhelming the civilian view. Avoid duplicating the map or data pipeline if the existing Public and Command presets can support the distinction.

Inspect the current UI and implement the smallest coherent changes that make the two information needs clear.
```

## 5. Live updates and official information

```text
Improve the live updates experience in Fire-3d so users can distinguish official information from observations, estimates, and model output.

Make official agency updates easy to find, with the issuing authority, original wording or a faithful summary, publication/update time, and a link to the source when available. Present automated detections and model-generated events as a separate kind of information, clearly labeled and timestamped. Make stale or delayed data obvious.

The updates feed should help users understand what changed and when. If possible, selecting an update should take the map and timeline to the relevant time and location. Do not label an automated inference as an official update, and do not imply that the absence of an update means there is no danger.

First inspect the existing updates feed and available official-data sources. Reuse existing data integrations where possible, and report any source or coverage limitations instead of fabricating information.
```

## 6. Map imagery, detail, and rotation

```text
Improve the map's imagery and navigation in Fire-3d, using the attached screenshots only as visual references.

I want users to be able to rotate the map and explore the fire area in 2D or 3D. Make rotation and tilt controls discoverable, ensure they work with mouse, touch, and keyboard where applicable, and provide an easy way to return to a north-up view.

Explore whether higher-resolution building or aerial detail can be shown at close zoom levels. The reference images show detailed aerial photography and 3D buildings, but do not assume Fire-3d has access to Google Earth imagery or that it can legally or technically reuse Google's data. First inspect the current basemap, terrain, imagery sources, attribution requirements, and licensing. Recommend and implement an available, properly attributed source only if it fits the existing architecture and access constraints.

Also make the existing satellite imagery feature easy to discover. Users should be able to inspect the most recent available satellite image and see its acquisition time, source, resolution, and any important limitations such as cloud cover or revisit delay. Clearly distinguish recent satellite imagery from live imagery; do not imply it is real time unless the source supports that claim.
```

---

## Decisions

The user answered these on Oct 18, 2026 (the recommended option was picked each time):

1. **First view: a California overview, then pick a fire.** With no fire in the link, the app opens on a California map of current fires and this year's large fires, with the address search on top. Clicking a fire flies to its full area. A link that names a fire still opens that fire directly.
2. **Close-up detail: 3D buildings only.** Plain 3D building shapes from OpenStreetMap, through the free map provider already in use (OpenFreeMap), shown when tilted and zoomed in. They are shapes only, with no photo textures. Post-fire aerial photos and CAL FIRE damage-inspection points were not chosen.
3. **Official sources to add, where coverage and terms allow:**
   - National Weather Service fire weather alerts (Red Flag Warnings and Fire Weather Watches).
   - CAL FIRE status changes (acreage, containment and status as feed items, credited to CAL FIRE with its update time and a link).
   - InciWeb was not chosen.
4. **Process:** audit first, then show the prioritized plan to the user and wait for approval before building.
5. **Default basemap for Public: aerial imagery with labels**, not the dark vector map. The user added this after the questions. It uses the existing aerial basemap: USGS imagery with road and place labels on top. Command's default and any basemap a user picks explicitly stay as they are. Text, panels and fire overlays must stay readable on aerial imagery.
6. **Model chance in the Public location card: a dated sentence**, for example "In the experimental model, 0 of 31
   simulated fires reached here by Oct 20, 15:50 (72 h). Not a safety guarantee." It replaces the large percentage.
   Command keeps the figure.
7. **Coordinate strip: keep it always visible in both Public and Command**, as the first brief asked. Public may use a
   compact form, and phones a one-line form, but it is never hidden by default.
8. **Pre-fire aerial photos and today's 3D shapes in burned areas: show them with clear date and caveat lines**, for
   example "Aerial photos: June 2024 or earlier, before this fire" and "3D shapes: today's OpenStreetMap; buildings
   destroyed by this fire may be missing; not a damage assessment".
9. **Plan approved** (docs/redesign/PLAN-2.md) with its defaults:
   - the 2026 season, with 2025 behind a filter;
   - "Prepare analysis" instead of an automatic build;
   - the IEM archive for past NWS alerts;
   - an anonymous NWS User-Agent;
   - CAL FIRE history recorded whenever the backend checks;
   - official zones within 15 km, shown with their distance.

   The build started on Oct 18, 2026.
10. **Zoom to see the spread (added during the build).** In Public and Command, the user must not have to click to open a fire to see its spread. Zooming in on the map is enough:
    - When the view zooms in (about z8.5 or closer) on a prepared fire, that fire is focused automatically. Its spread loads and draws (the observed burned area colored by arrival time, perimeters, detections and the selected forecast). The timeline, updates panel and location card switch to it.
    - Focusing by zoom never moves the camera and never adds a history step. Zooming back out (below about z7) returns to the California overview.
    - Explicit opens (the fire card, a search result, a link) still frame the fire and add a history step.
    - Other prepared fires in view show at least their latest perimeter outline.
    - Unprepared fires show their marker and a clear "Spread not prepared yet · Prepare analysis (1-3 min)" prompt; they are never built automatically on zoom. With the live loop running, current fires are prepared in the background, so they usually show their spread.

Standing rules carried over from BRIEF.md and the project notes:
- Model output is experimental and is never an evacuation order.
- Official information is kept separate from observations, estimates and model output.
- No Google data, no paid map services, no Nominatim.
- Secrets never leave `.env`.
- Port 8000 belongs to another app.
