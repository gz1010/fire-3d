# Brief 3: fires across the lower 48 US states (Oct 22, 2026)

The user asked to extend Fire-3d from California to the rest of the United States. This was "option 2" in the expansion estimate. The other options, adding floods and earthquakes or building an all-hazards portal, come later.

Starting point: commit 1c500b1, the map-first redesign plus UI/UX brief 2, all working for California.

## The request

Bring the fire coverage Fire-3d has for California to the rest of the country:
- the national fire list and overview;
- preparing a fire anywhere (terrain, fuels, observations, weather, forecast);
- zoom to see the spread;
- search and the location card;
- official information and the forecast.

Keep everything that works in California working, and keep every standing rule from BRIEF.md and BRIEF-2.md.

## Decisions (answered Oct 22, 2026)

1. **Coverage: the lower 48 states now.** Alaska and Hawaii come later; they need different map handling and have patchier terrain and fuel data. Fires there are not listed, or are clearly marked as not supported yet.
2. **Fire list: the same rule as California, 300 acres or more.**
   - Every currently active fire, plus this year's (2026) fires of 300 acres or more nationally, with past years (2025) behind a filter.
   - Expect a few thousand markers a year, so the overview needs clustering or decluttering to stay readable.
   - Wildfires only: prescribed burns are not listed as wildfires.
3. **Accuracy: test the fire-spread model on 8-10 past fires outside California before launch.**
   - Cover forests, grasslands, the Southwest and the Southeast (Pacific Northwest timber, Northern Rockies, Great Basin, Southwest, Southern Plains, Southeast).
   - Show an honest accuracy label per region in the app.
   - Where untested, say "accuracy not yet tested here".
4. **Evacuations: add free, official state evacuation feeds where they exist.**
   - Research them and add every state with free, official, public, machine-readable evacuation data.
   - Everywhere else, say "not available in this state", never an all-clear.
   - No vendor or county systems that need agreements, and no scraping.

Process: the user said "go for it". Audit, plan and build straight through, stopping only for a decision that only the user can make. Report at the milestones (build done, validation done, final check done).

## Standing rules (unchanged)

- Model output is experimental and never advice on when to evacuate ("Follow local officials"). Never use "safe" or "low risk"; outside the modeled area is unknown, not low.
- Official information keeps its issuer, its own times, verbatim wording and a link. It is never merged with model output, and its absence is never an all-clear.
- No Google data, no paid map services, no Nominatim. Credit every source, and verify the terms of each new source on its official page.
- The NASA FIRMS key stays in `.env` and `backend/fire3d/config.py`: never print or copy it.
- Never use the name "FireTrace".
- Port 8000 belongs to another app. 8710, 5173 and 5180 are the user's own local servers.
- No git commands that change the repository; the user commits.
- Fires now span several US time zones: never assume Pacific time.

## Decisions round 2 (answered Oct 22, 2026, after the audits)

Asked in the cloud session after the four audits in `docs/redesign/audit-3/`. These refine decisions 1-4 above.

1. **Active fires on the national map: all of them.** Every currently active wildfire in the lower 48 is listed,
   whatever its size (241 on Oct 22, 2026, 109 of them 1 acre or less). The 2026 list (and 2025 behind a filter)
   stays at 300 acres or more. The overview must stay readable with many tiny fires (grouping, size-aware markers).
2. **California source: CAL FIRE plus WFIGS gaps.** CAL FIRE stays the record for California fires; WFIGS (NIFC)
   adds only the California fires CAL FIRE does not list (for example federal fires such as the Timber Fire).
3. **Accuracy test: 12 fires outside California**, two per region, so all six regions can show a result (the
   audit's 10 primary fires plus Rush, OK and Black Cove, NC, or replacements from its reserve list).
4. **Auto-built live fires: keep 4, as today**, chosen from the whole country. Other fires use "Prepare analysis".
5. **FEMA IPAWS: no registration.** Live, show the official local-officials' messages that the NWS relays
   (Fire Warning, Evacuation Immediate and similar). For past days, use FEMA's public OpenFEMA archive (about a day
   late), clearly labelled as archived, with issuer, its own times, verbatim wording and a link.
6. **Partial state evacuation data: Washington only**, labelled "updated daily, may be out of date", and only if it
   loads reliably. Florida is not shown ("not available in this state").
7. **Accuracy label: words in Public, score in Command.** Public says, for example, "Tested on 2 past fires in this
   region", with the score one tap away; Command shows the score directly. Untested: "accuracy not yet tested here".
8. **Clock: mixed.** 12-hour in Public ("3:40 PM MDT"), 24-hour in Command and Forensic ("15:40 MDT"). Every time
   shows the fire's own time zone.

Defaults taken without asking (the user can override):
- A fire that is part of a complex is listed on its own, with "part of the X Complex".
- Active fires group only with other active fires on the overview, never hidden among contained ones.
- The national list shows the fires in the current map view, with "Show all".
- On phones the overview opens on the whole lower 48 with grouped markers.
- Cameras stay California only; elsewhere "not available in this state".
- County evacuation feeds are out of scope (state feeds only, as decision 4 says); a later brief may research them.
- Areas outside the six tested regions (Rocky Mountain, Eastern, Northern California) say "accuracy not yet tested
  here".
