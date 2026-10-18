# Audit 2: live updates and official information (BRIEF-2 §5)

Role: audit-updates, Oct 18, 2026. Checked on API 8713 (`FIRE3D_LIVE=0`) and Vite 5183 with Henderson, Cooley, Norte
(live), Eaton, Palisades, Madre, Lidia and Camino (replay), at 1440x900 and 390x844. A few polite live requests were
made to api.weather.gov and the Iowa Environmental Mesonet (IEM). No project file was changed except this file and
`docs/screenshots/audit2-updates-official-*.png`.

**Verdict.** The feed's mechanics are solid: kinds, "Automated", sources, keyboard use and map/timeline jumps all work.
But official information is thin and easy to miss. Most feeds have no official item at all. The one official item on
Henderson is a neighbouring fire's evacuation order, stamped with Fire-3d's fetch time as if it had just been issued.
CAL FIRE's acreage and containment changes never become updates (no history is kept), and there is no NWS fire
weather integration.

## 1. What exists today

**Feed (Public/Command).** `web/src/ui/feed/feedModel.ts` builds `FeedItem`s (`types.ts`) from events.json, notes,
agency perimeters, satellite passes (VIIRS/MODIS/Landsat; GOES skipped) and the selected forecast run. It also takes
`extraItems` from the optional sources (`extras/runtime.ts useExtrasFeedItems`, mounted in `App.tsx`).
`UpdatesFeed.tsx` renders it in the shell's `ui/shell/UpdatesPanel.tsx`:
- Each row has a title, a 2-line detail, a kind chip (Observation, Estimate, Model output, Official update, Your note,
  from `feedMeta.ts KIND_META`), an "Automated" chip (tooltip: "Generated automatically by Fire-3d…"), the source,
  and a time column. Public live shows "08:14 / just now" (the zone only in a tooltip); Command adds the zone. Replay
  shows "12:30 / Jan 8".
- Filters: "All" / "Key events" only (default All for live, Key events for replay). Newest first. "+ Note".
- Replay lists what had happened by the timeline time, plus "Show N later updates after the replay time".
- "New" marks (live only) are relative to what the page showed when it loaded. The first batch of a separately
  loaded topic is not marked. The app polls the manifest every 60 s (`state/runtime.ts`).
- Desktop: the compact panel (212 px) shows 1–2 items; "View all updates" shows about 4 at 900 px height. Phone: the
  panel is closed by default and opens as a bottom sheet from an icon-only header toggle (`MapHeader.tsx`, `iconOnly`)
  that has no label and no badge.
- Selecting a row (`selectFeedItem`) pauses playback, seeks when the item is `seekable` (clamped to the timeline),
  selects it and flies the map or Forensic camera when it has a location. The details show the kind's meaning, the
  source, the original wording, coordinates with a copy button, "Show on map" and "Check this location".

| Item | Kind | Seekable | Location on select |
|---|---|---|---|
| events.json (start, growth, spot, ridge, wind, perimeter, containment) | by type and confidence | yes | approximate point (fly) |
| Perimeter / satellite pass | observation | yes | centroid (fly) |
| Forecast run | model output | yes (to its start) | none |
| Evacuation (Cal OES) | **official** | no (current status) | zones' centre (fly, no zone highlight) |
| Cameras summary / imagery | observation, automated | no / when on the timeline | none |

**Official items actually present** (All filter, later items included, evacuation layer on by default):

| Incident | Items | Official | What |
|---|---|---|---|
| Henderson (live) | 16 | 1 | Cal OES "Evacuation Order: 1 zone (Orange County)": 27 km from Henderson, **1.6 km from the Norte Fire** |
| Norte (live) | 9 | 1 | the same order |
| Cooley (live) | 17 | 0 | none (11 of the 17 are satellite passes) |
| Eaton / Palisades / Madre (replay) | 40 / 64 / 51 | 0 | none |
| Lidia / Camino (replay) | 6 / 5 | 1 / 2 | "Fire 100% contained" (CAL FIRE); Camino also "Fire start reported" |

**Forensic** (`ui/KeyEvents.tsx`). Key events and notes only: raw titles ("Ignition", "Ridge crossing") and times.
The kind and "automated" appear only in the hover tooltip. There are no evacuation, CAL FIRE or NWS items. The CAL
FIRE incident link exists only here (`IncidentOverview.tsx`, `EvidenceTab.tsx`).

**CAL FIRE (backend).** `backend/fire3d/sources/calfire.py` reads `IncidentApi/List` (live list cached 10 min) and
keeps every raw key: `Updated`→`updated_ms`, `AcresBurned`, `PercentContained`, `IsActive`, `Final`,
`ExtinguishedDate`→`contained_ms`, `Url`, plus `AgencyNames` and `CalFireIncident` (`ControlStatement` was null for
all 9 live fires today). `api/live.py sync_live_summaries` copies `SUMMARY_SYNC_FIELDS` into each ready live
bundle's `manifest.summary` every 15 min, **overwriting in place**: no history is kept, only a log line naming the
incidents. The UI shows acres and containment only in the incident picker table (`IncidentPicker.tsx`) and Forensic.
Command's data status shows "CAL FIRE record <time>" without values. Build-time events add "Fire start reported"
(only CAL FIRE's unchanged start) and "Fire 100% contained" (historical bundles only, and only inside the record:
Eaton's Jan 31 containment falls after its Jan 10 record end, so it is not listed).

**NWS.** Nothing exists (no code, layer or feed item).

**Freshness today.** There are at least six phrasings and no shared rule:
- the timeline: "Latest observation … (16 h ago) STALE" plus "Current time", 6 h threshold (`ui/timeline/model.ts
  STALE_AFTER_MS`); its tooltip says "check the time, not the fire is out";
- Command's "Data status" (`ui/shell/dataStatus.ts`), Command only: absolute times and ages, with a Stale chip only on
  "Last observation";
- the Layers drawer: "Cal OES data last changed Oct 17, 18:01 PDT · fetched 46 s ago" and "Updated by the issuer …" /
  "Update time not given by the issuer";
- imagery acquisition and latency notes; "Image updated … by the camera server's clock"; aircraft "updated x ago";
- the picker: "CAL FIRE active wildfires · updated just now" (the list fetch time, not CAL FIRE's per-fire time).

The feed itself has no freshness line. Public has no data status at all.

## 2. Gaps

- **G1 BROKEN/UNRELIABLE: official time = Fire-3d's fetch time.** `extras/evacuation.ts evacuationFeedItems` uses
  `tMs: times.length ? Math.max(...times) : asOf`, with `asOf = retrieved_ms`. The Henderson order has no issuer time,
  so it reads "08:14 just now", is re-stamped on every 2-min refresh and floats to the top. Cal OES's own
  `source_updated_ms`/`aggregated_ms` (Oct 17, 18:01 PDT) are ignored. `cameras.ts` does the same for its summary. The
  test covers only the issuer-time case. Evidence: `audit2-updates-official-henderson-feed.png`, `…-henderson-phone.png`.
- **G2 HARD TO UNDERSTAND: wrong-fire attribution.** Henderson's top "Incident update" is an Orange County order 27 km
  away (1.6 km from Norte), pulled in by the 15 km query margin (CONTRACT §12.1). Nothing says how far away it is or
  that Cal OES does not name the incident. Clicking it flies to a zone flagged "Outside the modeled area"
  (`…-henderson-order-zone.png`).
- **G3 MISSING: official quiet states.** Cooley's feed says nothing about evacuations, although the API answered
  "No orders or warnings are listed here right now. That is not an all-clear: follow local officials." That text is
  only in the Layers drawer. Replays never say "official status is not available for past dates"
  (`…-cooley-feed.png`, `…-eaton-phone.png`).
- **G4 HIDDEN: official info is not prioritised.** It sits in one chronological list dominated by automated satellite
  passes (Henderson 8/16, Cooley 11/17), and only 1–2 rows show. There is no "Official" filter, and the phone toggle
  has no label or badge. Switching off the evacuation map layer silently removes the official items from the feed
  (`extras/runtime.ts useVisibleExtras`).
- **G5 MISSING: CAL FIRE status changes.** CAL FIRE moved Henderson from 50 to 65 % contained (record updated Oct 18,
  08:01 PDT). The API detail shows 65 % and the bundle still says 50 % (live loop off), but the change appears nowhere
  as an update and cannot be recovered. Public sees containment only in the picker dropdown, and there is no CAL FIRE
  link outside Forensic (`…-calfire-picker.png`, `…-henderson-command.png`).
- **G6 MISSING: NWS Red Flag Warnings and Fire Weather Watches** (map, feed and location card).
- **G7 MISSING: source links.** `FeedItem` has no `url`, so no row links to CAL FIRE, Cal OES or a county map, and
  official rows show one time instead of issued / updated / expires.
- **G8 HARD TO UNDERSTAND: wording risks.**
  - `KIND_META.official` says "published by a fire agency", but evacuations come from local officials and NWS is a
    weather service.
  - The empty states "No updates for this fire yet." and (replay) "Nothing had happened yet at the replay time" can
    read as "nothing is happening".
  - No quiet-period line for live fires: Henderson's feed jumps from the forecast to a 2-day-old pass. The fact that
    no new heat seen is not "out" is explained only in the timeline tooltip and Command.
  - Eaton's Command row reads "CAL FIRE record Aug 6, 10:47 PDT". That is a record edit 19 months after the fire,
    shown without the year or an explanation.
- **G9 INCOMPLETE: freshness.** See the phrasings above: Stale applies only to satellite observations, official rows
  have no "checked" time in the feed, and typical source delays (FIRMS 1–3 h, CAL FIRE's manual updates) are not
  explained anywhere.
- **G10 INCOMPLETE: jumps for official items.** The evacuation row flies to a centre point but does not fit or
  highlight the zone (`zoneId` stays null). There is also a constraint for new official rows timed after the latest
  observation: `isLaterItem` would dim them as "later" in live mode, and `selectFeedItem` would seek into the
  forecast period, putting model output next to an official update. A simulated arrival on Cooley showed "NEW" and
  "later" together.
- **G11 HARD TO UNDERSTAND (Forensic, minor):** the kind and automated status are only in tooltips, and there are no
  official items.

## 3. Recommended changes

Order: A = the map-first screen, B = official information that explains risk at a place, C = visual clarity. Every
official block keeps the standing line: "Fire-3d's modeled spread is experimental and is not an evacuation order.
Follow local officials." Official text stays verbatim and credited, and is never merged with observations, estimates
or model output. A Red Flag Warning is described as a weather warning, not an evacuation order.

### A. Official information easy to find on the map-first screen

| ID | Change | User value | Effort | Risk | Files | Deps | Pri |
|---|---|---|---|---|---|---|---|
| R1 | Honest official times and attribution: use the issuer time; else "Issuer time not given", with the item timed at Cal OES `aggregated_ms` (never `retrieved_ms`); add the distance to the fire and "Cal OES does not say which incident this is for" when the zone is outside the analysis area; same fix for the camera summary | An old or neighbouring order never reads as "just issued for this fire" | S | low | `web/src/extras/evacuation.ts` (+test), `extras/cameras.ts` | – | P0 |
| R2 | `FeedItem` additions: `url`, `issuer`, `issuedMs`, `updatedMs`, `expiresMs`, `checkedMs`, `bounds`, `status` (active / expired / cancelled), `distanceKm`. Details show "Issued by …", the times, an "Open source" link (https, React text) and "Checked by Fire-3d …" | Authority, time and link on every official row | S | low | `web/src/ui/feed/types.ts`, `UpdatesFeed.tsx` (FeedDetails), CONTRACT §8 | – | P0 |
| R3 | "Official now" block pinned above the chronological list (desktop panel and phone sheet). Rows: evacuation status or an explicit quiet / past / unavailable line ("not an all-clear"); CAL FIRE status (acres, containment, active, CAL FIRE's update time, agencies, incident link); NWS fire weather (R7). It shows even when the evacuation map layer is off (the row says so). | Official status is the first thing seen, never buried under satellite passes | M | low | new `web/src/ui/feed/OfficialNow.tsx` (+`updatesFeed.css`), `ui/shell/UpdatesPanel.tsx`, `extras/runtime.ts` (unfiltered official data) | R1, R2 | P0 |
| R4 | Phone: a visible "Updates" label, a badge when an official order, warning or Red Flag Warning is active, and the sheet opening on "Official now" | Phone users find official information without hunting | S | low | `web/src/ui/shell/MapHeader.tsx`, shell CSS | R3 | P0 |
| R5 | Jumps for official rows: fit to the zone bounds and highlight the zone or alert (`zoneId` / alert id). Status rows never seek. Replay rows seek only inside the observed record, never into the forecast. Live rows after the latest observation are not dimmed "later". | Clicking an alert shows its area, and the timeline never shows model output as if it were the official moment | M | med (shared map code) | `ui/feed/feedModel.ts` (`selectFeedItem`, `isLaterItem`, +test), `extras/runtime.ts`, `map/extrasLayers.ts` | R2 | P1 |

### B. Official sources that explain risk at a place

**R6 (P0): CAL FIRE status changes.** Backend M, web S, risk low–med (a write path in the live loop).
- Backend: new `backend/fire3d/sources/calfire_history.py`, a recorder called where the live list is refreshed
  (`api/live.py sync_live_summaries`; also `catalog.py`, see Q3). It appends one JSON line per change of acres,
  containment, active, final or extinguished, keyed by CAL FIRE `UniqueId`. Each line holds CAL FIRE's `Updated`,
  Fire-3d's seen time, `Url`, `AgencyNames` and the first snapshot as a baseline.
- Storage: write atomically under `data/official/calfire/`, outside the bundles, so rebuilds (`_clear_outputs`)
  never wipe it. A changed `Updated` with the same values is not a feed item.
- Endpoint: `GET /api/official/calfire?incident=<id>` → extras-style envelope + `{incident_url, agencies, current,
  changes: [{updated_ms, seen_ms, acres?: [old, new], percent_contained?: [old, new], is_active?: …}],
  recording_since_ms, caveats}`. It lives in a new router module, `backend/fire3d/api/official.py`, with one include
  line in `app.py`, plus `contracts.py` models and `backend/tests/test_official_calfire.py`.
- Web: `web/src/official/calfire.ts` (+test) → rows of kind official, not automated, key, for example "CAL FIRE: 65 %
  contained (was 50 %)". Source "CAL FIRE incident record", time = CAL FIRE's `Updated`, link = incident page; the
  location is the reported point (approximate).
- Past fires: CAL FIRE's list has only the final record (Eaton: 14,021 ac, 100 %, contained Jan 31, 2025 10:48 PST;
  record edited Aug 6, 2026). They get one "CAL FIRE final record" row plus "CAL FIRE's update-by-update history is
  not available for past fires; Fire-3d records changes only since <date>". No free official history was found.

**R7 (P0): NWS Red Flag Warnings and Fire Weather Watches.** L in total (backend M, web M), risk medium.
- Live: new `backend/fire3d/sources/nws.py` through `fire3d.http` (User-Agent required; RateLimiter 30/min).
  - One statewide request, `/alerts/active?area=CA&event=Red Flag Warning,Fire Weather Watch`, cached 2 min, serves
    every incident and the California overview.
  - The `/zones/fire/{UGC}` polygons are cached 30 days and simplified server-side. The backend intersects them with
    the incident area, flags `covers_reported_location` and `nearest_km`, and exposes the result at
    `GET /api/official/fire-weather?incident=&at_ms=` in `api/official.py`.
- Response: the extras envelope + `alerts[]` with `{id, url, event, vtec{office, phenomena, significance, etn,
  action}, sender_name, sent_ms, effective_ms, onset_ms, expires_ms, ends_ms, headline, description, instruction,
  area_desc, ugcs, message_type, status, updates[]}` (wording verbatim) + `zones` (FeatureCollection).
- Past (replay, or `at_ms` older than now − 6 h): the IEM VTEC archive (Q1), labelled "NWS product, archived copy:
  Iowa Environmental Mesonet". Without IEM, or when it fails, the answer is `not_available_for_past_dates`. NWS
  itself keeps no archive and answers an empty 200, which must never read as "no alerts".
- Feed: one row per VTEC event, kind official, not automated, key, title "<event verbatim> until <ends>", detail =
  the NWS headline, with WHAT/WHERE/WHEN/IMPACTS on demand, source = `senderName`, link. Expired alerts stay listed
  as "Expired <time>" for 48 h. Seekable only in replay.
- Map: outline-only labelled zones (fire weather zones are county-sized), distinct from the evacuation hatching and
  the fire colours, with a legend entry and the credit "National Weather Service" (or "… via IEM").
- Location card: one line "Fire weather alert here: Red Flag Warning (NWS San Diego) until …". This must be
  coordinated with the owner of `web/src/location/LocationCard.tsx`.
- Web files: new `web/src/official/fireWeather.ts` (+test) and a layer handle mounted the way `bindExtrasLayers` is.
- Deps: R2, R3.

**R8 (P0, S, low): wording and quiet states.**
- Official kind meaning: "Published by an agency (fire, emergency-management or weather service) and quoted from its
  data; Fire-3d does not change the wording."
- Empty feed: "No updates from Fire-3d's sources yet. No update does not mean no danger; follow local officials."
  Replay: "No updates in the record before this time."
- A live quiet-period row from `time_range.last_detection_ms` / `last_pass_ms`: "No new heat seen by satellites since
  <time> (later passes saw none). Smoke, cloud or smouldering can hide fire; this is not an all-clear."
- Forensic gets the same empty text.
- Files: `ui/feed/feedMeta.ts`, `UpdatesFeed.tsx`, `feedModel.ts` (+test), `ui/KeyEvents.tsx`.

### C. Visual clarity

| ID | Change | User value | Effort | Risk | Files | Deps | Pri |
|---|---|---|---|---|---|---|---|
| R9 | One freshness pattern: `web/src/lib/freshness.ts` (+test) with per-source cadence and threshold. Every source reads "<Updated by source> <time> · checked <relative>" plus one chip: Stale, Delayed (known latency), Unavailable (shows the last good answer) or Not available for past dates. Public gets a one-line "Sources checked 2 min ago · satellite data 16 h old" with details. Command's data status adds Cal OES, NWS and CAL FIRE values, and fixes the historical CAL FIRE row. | "How old is this?" has one answer everywhere | M | low–med (touches shell, extras, timeline) | `lib/freshness.ts`, `ui/shell/dataStatus.ts` (+test), `UpdatesPanel.tsx`, `extras/ExtrasCommon.tsx`, `ui/timeline/CompactTimeline.tsx` (wording) | R6, R7 rows | P1 |
| R10 | Filters "Official · All · Key events"; group live satellite passes per day ("Satellite passes today: 9"); show the time zone in Public | Less automated noise; official items one tap away | S | low | `UpdatesFeed.tsx`, `feedModel.ts` (+test) | R3 | P1 |
| R11 | Forensic: a visible kind glyph and "auto" mark on Key Events rows; CAL FIRE and NWS rows (with links) in the Evidence tab | Analysts can tell official from automated without hovering | S | low | `ui/KeyEvents.tsx`, `ui/EvidenceTab.tsx` | R6, R7 | P2 |
| R12 | California overview (Decision 1): statewide Red Flag / Fire Weather Watch outlines and "CAL FIRE changed in the last 24 h" marks on the fire list | Statewide context on the first screen | S | low | the overview owner's files | R6, R7, overview | P2 |

Suggested split without file conflicts:
- backend agent: R6 + R7 backend (new modules, a live.py hook, the `app.py` include);
- extras/web agent: R1, then R6/R7 web producers, map layer and credits;
- feed/shell agent: R2, R3, R4, R8, R10, then R5;
- R9 last.

P0 total is about 18–24 h of agent time.

## 4. Live checks and sources (evidence)

- **NWS** (`api.weather.gov`, Oct 18, 08:15–08:25 PDT).
  - Henderson point: one alert, a "Beach Hazards Statement" from NWS San Diego CA, `geometry: null`, zones
    CAZ043/CAZ552, VTEC `/O.NEW.KSGX.BH.S.0015…/`. Fields as listed in R7.
  - Cooley point: none. All California: no Red Flag Warning or Fire Weather Watch today.
  - `/points`: Henderson lies in fire zone CAZ243 "San Diego County Coastal Areas" (a 113 KB polygon).
  - Past query, Jan 6–9, 2025: HTTP 200 with 0 alerts, during a Red Flag Warning.
  - Terms: "open data, free to use for any purpose"; "A User Agent is required…; if you include contact information
    (website or email), we can contact you". The rate limit is not public.
- **IEM**: `json/vtec_events_bypoint.py` at Eaton returned 12 events, including Red Flag Warning LOX FW.W #1 (Jan 7
  04:00 → Jan 10 14:48 PST, zone CAZ380) and two Fire Weather Watches.
  - `json/vtec_event.py` gives the original text ("URGENT - FIRE WEATHER MESSAGE / National Weather Service Los
    Angeles/Oxnard CA"), 9 follow-up statements and per-zone times. `geojson/vtec_event.py` gives 28 zone polygons.
  - Terms (disclaimer.php): "in the public domain and may be used freely by anyone for any lawful purpose", with
    attribution appreciated and no warranty. Quirk: some watch rows list `issue` after `expire`, so use the per-zone
    times.
- **Screenshots** (`docs/screenshots/`): `audit2-updates-official-henderson-feed.png`, `-henderson-order-zone.png`,
  `-henderson-phone.png`, `-cooley-feed.png`, `-calfire-picker.png`, `-henderson-command.png`, `-eaton-phone.png`.

## 5. Open questions for the user

1. **Past fire-weather alerts:** use the IEM archive (public domain, unofficial copy of NWS products, labelled as
   such)? Recommended. The alternative is "not available for past dates".
2. **NWS User-Agent contact:** NWS recommends a website or email in the User-Agent. Which should go there, or keep the
   current anonymous "Fire-3d/0.1 (research prototype)"?
3. **CAL FIRE recording scope:** record whenever the API runs (including `FIRE3D_LIVE=0`) and for every listed live
   fire? Recommended. Or only in the live loop for built bundles?
4. **"Near this fire":** keep the 15 km margin for official zones with a distance label? Recommended. Or list only
   zones that touch the fire's analysis area?
