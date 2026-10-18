# Audit 2: civilian location check and Public vs Command (audit-civilian)

Scope: BRIEF-2 §3 (address search and risk explanation), §4 (Public vs Command) and visual clarity. Checked on
2026-10-18 at commit b07e0cb with the API on 8712 (`FIRE3D_LIVE=0`), Vite on 5182 and Playwright Chrome at 1440x900
and 390x844 (touch), on Eaton (2025 hindcast) and Henderson (live; data 17 h old). Slow and failed geocoder replies
were simulated by intercepting `/api/geocode`; one real Census lookup took 1.3 s. Evidence:
`docs/screenshots/audit2-civilian-flow-*.png`. No project code was changed.

## 1. What exists today

**Search** (`web/src/location/SearchBox.tsx`, `search.ts`, `geocodeClient.ts`; `backend/fire3d/api/geocode.py`).
- One box at the top left (380 px; full width on phones). Its only label is the placeholder "Address, coordinates or
  incident".
- `planSearch` tries, in order: pasted coordinates (read in the browser); incident names, matched on name, county,
  location text, unit, id and year (one hit switches the incident); then text starting with a house number, sent to
  the Census proxy (10 s timeout, 1 retry, 30-day cache).
- One address match is selected at once; several are listed. The pin is "Approximate" and draggable.
- "/" focuses the box, Escape closes the list or status, Clear aborts. On focus a hint shows the Eaton example on
  every incident; a one-line status shows busy, warning and error.

**Location card** (`LocationCard.tsx`, `describe.ts`, `locationCheck.ts`). First view for 600 E Mariposa St,
Altadena, a home that burned (Eaton, desktop Public, `audit2-civilian-flow-card-burned-home-0pct.png`):
1. Title in capitals; "APPROXIMATE Street address · interpolated along house numbers 600–628, not a rooftop position";
   coordinates; "Drag the pin…".
2. Headline: "Inside the estimated burned area", "ESTIMATE 198 ft from its edge · estimated from satellite detections
   for Jan 8, 19:40 PST (at the selected time)", "ESTIMATE Burned around Jan 8, 07:39 PST".
3. "MODEL HINDCAST (PAST WEATHER)", a large orange **0%**, "None of the 31 model runs burned this spot by Jan 11, 00:18
   PST, the end of the 72-hour hindcast", then "The fire reached this spot …, but none of the model runs did".
4. "Wind at the fire 12 mph from the northeast, gusts 15 mph · 1,312 ft, 7% slope, faces southwest".
5. "Details, sources and uncertainty" (fire, nearest detection, period, arrival quantiles, wind here, terrain, fuel,
   caveats, sources; Command adds "Scientific values").

About 130 words, 15 numbers, 5 timestamps and 4 kind tags (9.5 px uppercase). On phones the card is a short bottom
sheet: the headline, the first forecast line and "More about this location".

**Jargon.** First view: "model runs", "hindcast", "estimated burned area", "at the selected time", "interpolated
along house numbers", "% slope", "faces southwest". Details: "Arrival-time quantiles … 10%, 50% and 90% of the runs",
"the model's weather grid (cells about 3.6 mi wide)", "VIIRS on NOAA-21", "Scott & Burgan 40". Command: run ID
`fc-20261017T2250-gfs025-3df2`, `burn_probability 0.000`, `arrival_p10/p50/p90: NEVER`.

**Official zones at the point** (`EvacuationAtPoint` in `LocationCard.tsx`; `extras/evacuation.ts`). Shown only while
the Evacuation map layer is on (the default) and Cal OES data is current. Lists each zone's status in the official
wording with an "Official" tag, or says "None listed at this point (Cal OES, checked …). That is not an all-clear."

**Presets** (Henderson, point selected: `audit2-civilian-flow-public.png`, `audit2-civilian-flow-command.png`)

| Element | Public | Command adds |
|---|---|---|
| Header | incident picker; "Public / Command \| Forensic" and "Public \| Command" side by side; Analysis; Layers | ID chip |
| Card | as above | nothing in the summary; technical values in the closed details |
| Coordinate strip | reported location and selected point (decimal), copy buttons | DMS, UTM, incident ID, CAL FIRE update, selected time, datum |
| Updates panel | 16 items, "+ Note"; model items name the ensemble | Data status block: per-source times, STALE, run ID, members |
| Timeline | "Observed · hindcast +19 h", "Latest observation … STALE" | segment labels, years |
| Open map with a point (1440x900) | 63.4 % | 52.5 % |

**What the data already supports, with honest labels** (code: `locationCheck.ts`, `api/types.ts`)

| Statement | Data | Label | In the card today |
|---|---|---|---|
| Inside the latest mapped perimeter, or distance and direction to its edge (bearing from the edge to the point) | agency perimeters | Mapped, with its time | headline |
| Inside the reconstructed burned area; when this spot burned | `observed_arrival` | Estimate | yes (the burn time is hidden on phones) |
| Nearest satellite detection (a hot pixel, not the edge) | FIRMS detections | Observed | details |
| Chance of burning by the end of the period (start + horizon, e.g. 72 h to Oct 20 15:50 PDT) | `burn_probability` | Model, experimental | yes, as a large % |
| Modeled arrival times (quantiles, not scenarios) | `arrival_p10/50/90` | Model | when reached |
| Wind at the fire and at the point (the direction it blows FROM) | `weather.json` (Open-Meteo) | Model, not station data | one short line |
| Whether the wind blows from the fire toward the point | wind direction vs the edge-to-point bearing | Model (derived) | **missing** |
| Dryness: humidity, 1/10/100-h fuel moisture, FFWI | `weather.at_fire` | Model | **missing** (only the Forensic `ui/WeatherCard.tsx` uses it) |
| Slope, facing, elevation, fuel; uphill of the fire edge | elevation and fuel rasters | Reference (uphill: derived) | numbers only; uphill **missing** |
| Freshness | perimeter, detection, forecast-issue, weather, CAL FIRE and Cal OES times; `STALE_AFTER_MS` = 6 h | facts | 11 px sub-lines; STALE only in the timeline |
| Outside coverage, no forecast, no data | `ModelGap` | Unknown, not low | yes |

## 2. Gaps

**Search: "easy to miss or does not open reliably"**
- **G1 BROKEN. Escape and editing do not cancel a lookup.** Submit an address and press Escape within a few seconds:
  the reply still selects it and flies the map to zoom 15. Typing "1 Main St" during a lookup lets the old reply select
  600 E Mariposa. Escape (`SearchBox.tsx` L182-188) and `onChange` (L225-228) never abort `reqRef`.
- **G2 BROKEN on phones. Results open behind an open sheet.** At 390 px, open Layers and search "Los Angeles": the list
  renders fully hidden (`audit2-civilian-flow-phone-results-behind-layers.png`). `.loc-search-below` is z 3 inside
  `.mw-top` (z 10), but the sheets are z 15 (`location.css` L69-75; `map-layout.css` L800-812, L1188-1196). A pick is
  invisible too, because `.mw.has-sheet .mw-card` is `display: none` (L1237).
- **G3 BROKEN. Warnings and errors cover the card's title and close button**
  (`audit2-civilian-flow-status-over-card-aerial.png`). They stay "until the next edit" (L69-74), and an outside click
  closes only the result list (L76-84). The focus hint overlaps the same way. Errors read "Server error: … (HTTP 504)".
- **G4 HARD TO UNDERSTAND / BROKEN. Town names switch the incident and can start a build.** Matching includes the
  location text (`search.ts` L49), and one hit switches with `autoBuild: true` (`SearchBox.tsx` L104, L142;
  `store.ts` L618). "Malibu" opened the Bryson Fire, which has no bundle, and started a multi-minute terrain, NAIP and
  LANDFIRE build (`audit2-civilian-flow-malibu-starts-build.png`; the audit stopped it and removed the partial bundle).
  "Altadena" silently flies back to Eaton and clears the box. "Los Angeles" lists 6 incidents without marking the 4
  that have no data.
- **G5 MISSING. Towns, ZIP codes and places.** "91001" and "Pasadena City Hall" both get "No incident matches …",
  which is wrong for a ZIP code (`looksLikeAddress` in `search.ts` L32 needs a number followed by a street).
- **G6 HIDDEN. The search does not stand out.** It has the same dark panel as everything else and no "Check an
  address" label, and its placeholder fails AA contrast on the aerial and roads basemaps (G19).
- **G7 INCOMPLETE.** After a pick the input keeps focus, so on a real phone the keyboard probably covers the card (not
  checked on a device). Escape in an empty box does nothing.

**Card and risk explanation**
- **G8 HARD TO UNDERSTAND. The model percentage dominates.** A 24 px "0%" is the largest element both for a home that
  burned and 0.8 mi from a live fire whose data is 17 h old (`audit2-civilian-flow-phone-live-card.png`). It reads as
  "safe".
- **G9 INCOMPLETE. The phone card drops essentials:** the official line when no zones are listed (`LocationCard.tsx`
  L72-73), the data age (L211), the burn time, and the "model missed" line (L229).
- **G10 MISSING. No reasons in human terms.** The wind is given only "at the fire", with no relation to the point.
  Nothing covers dryness or "uphill of the fire". The terrain numbers are not explained.
- **G11 INCOMPLETE. No single "last updated, how reliable" line.** The card never says STALE.
- **G12 HARD TO UNDERSTAND. Jargon and density** (see §1).

**Official information versus model output**
- **G13 BROKEN (honesty). "None listed … checked just now" also appears for places that were never checked.** Cal OES
  is queried only for the incident area plus 15 km, yet a point in Irvine, 32 mi from Henderson, gets the line.
  `zonesAtPoint` ignores the response `bbox` (`extras/evacuation.ts` L226; `extras/types.ts` L35).
- **G14 INCOMPLETE. The official line silently disappears** for past dates (`not_available_for_past_dates`, L70), when
  the Evacuation layer is off (L59-62), and on phones when no zones are listed. "None" cannot be told from "not
  checked".
- **G15 MISSING. No links to official sources.** `summary.url` (the CAL FIRE incident page) and `sources[].url` (Cal
  OES) are not linked. "Follow local officials" appears only inside the "none listed" sentence. NWS Red Flag Warnings
  are not built yet (decision 3).

**Public vs Command**
- **G16 INCOMPLETE. The Command card equals the Public card.** The run ID, issue time, members and quantiles stay
  hidden in the closed details.
- **G17 HARD TO UNDERSTAND. Public carries Command detail.** The coordinate strip is always on, so the point's
  coordinates appear 3 times (card, pin label, strip). Feed items say "31 model runs, each driven by a different member
  of NOAA's GFS weather ensemble". "+ Note" and "hindcast +19 h" are visible. Two neighbouring switches both say
  "Public … Command".
- **G18 (map-first) On a phone with a point selected, only about 100-150 px of map is visible.** The bottom stack takes
  344 px (41 %) and the card 242 px.

**G19 BROKEN. Contrast below WCAG AA (4.5:1).** Method: computed CSS colours, with the translucent panels composited
over the real basemap pixels behind each text; ranges run from the mean pixel to the 90th-percentile bright pixel
(Eaton, zoom 14, 1440x900).

| Text | Colour | Dark | Aerial | Roads |
|---|---|---|---|---|
| Search placeholder (13 px) | `--m-text-3` #74818f | 4.59-4.62 | **3.84-4.02** | **3.45-3.63** |
| Card heading "MODEL HINDCAST…" (13 px) | text-3 | 4.58-4.61 | **3.84-4.08** | **3.42-3.65** |
| Coordinate labels (10.5 px) | text-3 | **4.50**-4.59 | **4.08-4.31** | **3.38-3.45** |
| Feed source and meta (11 px) | text-3 | 4.57-4.61 | **4.01-4.15** | **3.71-3.77** |
| "Research prototype — not for operational use" (10.5 px) | text-2 on a translucent chip | 8.1-8.5 | 5.2-6.5 | **3.35-3.62** |
| Card body text (12-13 px) | `--m-text` | ≥ 14 | ≥ 11.7 | pass |
| Kind tags (9.5 px) | per kind | 9.3 | 8.0-8.3 | 7.1-7.2 (contrast passes; the size is too small) |

Text-3 is also used for the card's labels and details, the sources list and every `.mw-eyebrow` heading. On Roads the
map credits are nearly invisible (`audit2-civilian-flow-roads-contrast.png`).

## 3. Recommended changes

These rules apply to every change: model output is experimental and never advice on when to evacuate; official
information gets its own block and an "Official" tag; no "safe" or "low risk" wording; outside coverage stays
"unknown, not low". Effort: S < 2 h, M 2-4 h, L > 4 h of agent time.

**Map-first**
- **R1 (P0, S). Make search the obvious first action.** Value: a civilian finds the address box within a second.
  Add a visible label ("Check an address"), a stronger border and an example placeholder. The box leads the California
  overview (decision 1) and keeps its place on incident views. On phones, focusing it closes any open sheet
  (`setPanel`), and a pick blurs the input. Files: `location/SearchBox.tsx`, `location/location.css` (placement on the
  overview goes with the map-first work). Risk: low.
- **R2 (P1, M). Keep the map visible on phones while the card is open.** Value: the pin and the fire stay in view.
  Fold the coordinates into the card, put the note and credits on one line, compact the timeline, and pan so the pin
  sits above the sheet. Files: `styles/map-layout.css`, `ui/shell/CoordsSlot.tsx`, `App.tsx`. Depends on R8. Risk:
  low.

**Search and risk explanation**
- **R3 (P0, M). Make the search dependable (G1-G4, G7).** Value: it does what was asked, every time.
  - Abort lookups on Escape, edit, Clear and a new selection, and drop late replies.
  - Use one popover state that closes on outside clicks, map clicks and new selections and never covers the card.
    Write errors in plain words.
  - Switch incidents only on an exact incident name. List other matches, mark unbuilt bundles "data not prepared" and
    ask before building. When the current incident is picked, say "Showing the Eaton Fire".
  - Files: `location/SearchBox.tsx`, `location/search.ts` (+ tests), `location/location.css`. Risk: low.
- **R4 (P0, S). Honest messages for ZIP codes and town names** until R5 lands: "ZIP codes and town names are not
  searchable yet. Enter a street address with a house number, or click the map." Files: `search.ts`, `SearchBox.tsx`.
- **R5 (P1, M). Town and ZIP search from the 2026 Census Gazetteer.** Value: "Altadena" and "91001" work, with no
  Nominatim, no key and no upstream calls.
  - Data: 1,622 California places (462 cities, 21 towns, 1,139 census-designated places) and 1,802 California ZIP areas
    (ZCTAs). An index from each name or ZIP to an interior point measured 117 KB (42 KB gzipped).
  - Terms: a U.S. government work (17 U.S.C. §105); Census open data is free to reuse. Credit "U.S. Census Bureau
    Gazetteer Files".
  - Served as local `place` or `zip` matches from `/api/geocode`. It flies to the place and asks for a street address
    or a map click (Q1), labelled "town centre" or "ZIP area, approximate". ZCTAs only approximate ZIP codes, and
    PO-box-only ZIPs are missing.
  - Files: `backend/fire3d/api/geocode.py` and its tests, new `backend/fire3d/data/gazetteer_ca.json` with a build
    script, `location/search.ts`, `SearchBox.tsx`, `types.ts`, README credits. Depends on R3 and R4. Risk: low.
- **R6 (P0, L). A new first summary in the card (G8-G12).** Four short blocks answer the brief's four questions; the
  details stay one tap away.
  1. Near here: inside the fire area, or the distance and direction to it, tagged Mapped or Estimate, with its age.
  2. Official evacuation information: always one line (R7), plus "Follow local officials" with links.
  3. Main reasons, at most 3, each tagged:
     - wind from the fire toward, away from or across this point [Model];
     - dryness: humidity and fine-fuel moisture in plain words, with qualitative words only behind a cited threshold
       such as an NWS Red Flag Warning [Model, or Official];
     - "uphill of the nearest edge" [terrain data];
     - the model as a sentence, never a large %: "In the experimental model, 0 of 31 simulated fires reached here by
       Oct 20, 15:50 (72 h). Not a safety guarantee." [Model]
  4. Updated and reliability: "Fire position 17 h old (stale)", the model run's issue time, and "Research prototype;
     not an evacuation order". Arrival quantiles and sources move to the details.
  - Files: `location/describe.ts`, `location/locationCheck.ts` (+ tests), `location/types.ts`,
    `location/LocationCard.tsx`, `location/location.css`. Depends on R7 (same agent). Risk: medium: the semantics must
    stay exact, and the user should review the wording.
- **R7 (P0, M). Official information that is honest and always present (G13-G15).**
  - Say "none listed" only inside the response `bbox`; elsewhere say "Not checked here: Fire-3d reads zones only near
    this fire".
  - Show the line on phones and in replay ("Official status is shown only for the current time"). Fetch zones for the
    card even when the map layer is off. Link the CAL FIRE incident page and Cal OES.
  - Files: `location/LocationCard.tsx`, `extras/evacuation.ts` (+ test), `extras/runtime.ts`,
    `extras/ExtrasSync.tsx`. No dependencies; NWS Red Flag Warnings can be added later (decision 3). Risk: low.
- **R8 (P1, M). The smallest coherent Public/Command split (G16-G17).**
  - Public: the R6 summary; the coordinate strip hidden by default, with copy available in the card (Q3); plain
    timeline and feed words (for example "model re-run on past weather" instead of "hindcast"); no "+ Note".
  - Command: a "Model run" line in the summary (run ID, issue time, members, ensemble, period) and the arrival
    quantiles; technical values visible without opening the details; the Data status block stays.
  - Header: one "Public · Command" switch, plus "3D analysis" for Forensic (Q4).
  - Files: `describe.ts`, `LocationCard.tsx`, `location/CoordinateStrip.tsx`, `ui/shell/WorkspaceSwitch.tsx`,
    `MapHeader.tsx`, `CoordsSlot.tsx`, labels in `ui/timeline/*` and `ui/feed/*`. Depends on R6. Risk: medium (it
    changes CONTRACT §5.1, "coordinate strip always visible").

**Visual clarity**
- **R9 (P0, S). Contrast and text size (G19).** Change `--m-text-3` to about #98a4b2, which gives at least 4.5:1 on all
  three basemaps at today's panel opacity, and use `--m-text-2` for any text that carries information. Raise Public
  panel opacity to 0.94. Set minimum sizes of 13 px for body text, 12 px for meta, 11 px for tags and headings. Put the
  safety note and the credits on an opaque chip, then re-measure the open-map share. Files: `styles/map-tokens.css`,
  `styles/map-layout.css`, `location/location.css`. Risk: low.
- **R10 (P2, S). Search polish:** a local example in the hint, listbox roles, and Escape blurs an empty box.

**Suggested split by file ownership** (no shared files):
- Location agent (`web/src/location/**`, `extras/evacuation.ts`, `extras/runtime.ts`, `extras/ExtrasSync.tsx`): R1
  search, R3, R4, the R5 frontend, R6, R7, the card and strip parts of R8, the `location.css` part of R9, R10.
- Backend agent: the R5 backend.
- Shell agent (`styles/**`, `ui/shell/**`, `App.tsx`): R1 overview placement, R2, the R8 header, R9 tokens and layout.
- Timeline-feed agent: the R8 wording.

## 4. Open questions for the user

1. **Town and ZIP search:** add the Census index (42 KB)? When someone picks a town or ZIP, should the map only move
   there and ask for a street address or a click (recommended), or also check the town centre?
2. **Model percentage:** drop the large percentage from the Public first view, keeping it as a dated, labelled sentence
   (recommended), and keep the figure in Command?
3. **Coordinates in Public:** hide the coordinate strip by default in Public, with copy in the card and Command
   unchanged? This reverses the first redesign's "always visible" rule.
4. **Header naming:** replace "Public / Command | Forensic" plus "Public | Command" with one "Public · Command" switch
   plus "3D analysis"?
