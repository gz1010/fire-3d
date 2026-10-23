# us-official: as built (brief 3, wave 1)

Role `us-official`: official information across the lower 48 (both ends). Oregon evacuations and "not available in
this state" elsewhere, cameras, source-neutral fire records, national NWS and local officials' alerts in the UI. This
note records what was built against CONTRACT §14 and every deviation; it is kept current at each milestone.

## 14.9.6 Cross-role shims (M1)

All optional; without `tf` each falls back to `getTimeFormat()` (`state/timeZone.ts`: the open fire's zone, else the
selected place's, else the viewer's, with the current workspace's clock).

| Export | File | Shim |
|---|---|---|
| `FeedInput.tf?: TimeFmt` | `ui/feed/feedModel.ts` | `buildFeedItems` words every time in `tf` (forecast re-run time, pass days and times, the quiet-period row); `groupPassesByDay(passes, wallMs, tf?)` and `quietItem(m, wallMs, staleAfterMs?, tf?)` group and word days in `tf.tz` |
| `OfficialContext.tf?: TimeFmt` | `location/official.ts` | `officialBlock(info, { …, tf })`: zone times in `tf`; `calfireLine(cf, units, tf?)` too |
| `officialFireWeatherNote(fw, tf?)` | `location/official.ts` | accepted; the note ("NWS Red Flag Warning in effect") has no time |
| `zoneDetail(zone, nowMs, tf?)` | `extras/evacuation.ts` | "Updated by the issuer …" / "listed by …" in `tf` (`zoneTimeText(p, nowMs, tf?)`, `fmtWhen(ms, refMs?, tf?)`) |
| `cameraViewText(cam, tf?)` | `extras/cameras.ts` | accepted; the text has no time |
| `fmtStatusTimeAt(ms, nowMs, tf)` | `ui/shell/dataStatus.ts` | new: `fmtAt(ms, tf, { zone: true, year: 'auto', refMs: nowMs })`; `fmtStatusTime` kept, `@deprecated` |

`EvacuationOfficial.state` (`official/model.ts`) gains `'not-available'` (§14.8.5). M1 renders it as "Evacuation
zones: not available in this state" (card, §14.14 short form, with the reason in `sub`), "Not available in this
state." (compact summary and Official now, no "Cal OES" source tag).

Call sites for `us-web` to pass `tf` (its files; listed in its report): `ui/KeyEvents.tsx` and
`ui/timeline/CompactTimeline.tsx` (`buildFeedItems`), `map/mapController.ts` (`buildFeedItems`, `zoneDetail`,
`cameraViewText`), `location/LocationCard.tsx` (`officialBlock`, `officialFireWeatherNote`), `location/OverviewCard.tsx`
(`officialBlock`).

## 14.8 Evacuations and cameras, backend (M2)

`backend/fire3d/sources/evacuations.py` (new; no requests of its own) and `backend/fire3d/api/extras.py` (route,
fetching, envelope).

- **Registry** (§14.8.1): `EvacAdapter` exactly as the contract (fields `id … zone_state`), plus three derived
  properties (no new fields): `upstream_name` ("Cal OES ArcGIS services" / "Oregon OEM ArcGIS services", used in error
  texts), `layer_what` ("Cal OES evacuation layer"), `none_caveat` (per-source "not an all-clear" line; Cal OES keeps
  its brief-2 sentence). `ADAPTERS` = `caloes_evacuations` (CA) and `or_oem_evacuations` (OR) only.
  `STATE_AVAILABILITY` covers `regions.L48` (48 states + DC): CA and OR `available`, every other `not_available`
  (WA, FL included), `audited: '2026-10-22'`, notes for AZ (the contract's sentence), FL and WA, links for CA and OR.
  `ARCGIS_LIMITER` (60/min) is the one limit for services.arcgis.com: `extras.UP_ARCGIS.limiter` is the same object.
- **Status mapping** (EV-R6): `evac_status_key` moved to the module (`extras.evac_status_key` is an alias); negations
  ("No …", "Not …", "None") map to `other`, never order/warning/advisory; placeholder rows ("No Evacuation Order",
  "Not Reporting") are dropped by both adapters, Oregon rows without a level 1-3 too. Null Cal OES status keeps brief
  2's `unknown` (California values unchanged).
- **Cal OES** behind the adapter: `normalize_caloes` (= brief-2 `normalize_zone`, alias kept) keeps every brief-2 prop
  and adds the §14.8.2 props (`state` "CA", `source_id`, `status_verbatim` true, `status_raw` = STATUS, `hazard_type`
  = EVENT_TYPE, `listed_ms` = EditDate, `time_basis` 'issuer' when EDIT_DATE is set, else 'state_layer_edit', else
  'none'). Explicit `outFields` (12 fields; `Creator`/`Editor` are no longer requested). The 2 s confirm-drop re-query
  stays Cal OES only. A regression test compares four California answers key by key with the brief-2 code's answers
  (`tests/data/evacuations/caloes_brief2_expected.json`): only `states`, the six per-source fields and the ten zone
  props are new.
- **Oregon** (§14.8.4): `normalize_oregon` as the contract; `jurisdiction` = `county` ("Jackson County"),
  `status_updated_ms` and `aggregated_ms` null, `listed_ms` = `created_date`, `time_basis` 'state_layer_added';
  `last_edited_date` is requested (whitelist) but never output. `zone_state`: "Del Norte" → CA, a county → OR, no county
  → `regions.state_at` of a representative point. Standing caveats: no issue time ("the time shown is when the zone was
  added to the Oregon state layer") and the levels being Fire-3d's rendering with OEM's definitions. OEM's "If there
  are no records … no evacuations" sentence is never repeated.
- **Route rules** (§14.8.3), in this order: `regions.states_in_bbox(bbox)`; no available state → `unavailable` +
  `state_not_available` with the §14.14 sentence (several states: "…not available in these states (Nevada, Utah)…";
  no state: `coverage_at` of the bbox centre → the Alaska/Hawaii/territories or outside-the-US sentence), `sources: []`,
  **no upstream request** (also for past dates); then past dates (unchanged, every `sources[]` entry `unavailable`);
  then each available adapter. A failed source is `unavailable` in `sources[]` with its reason and a caveat
  "{State}: {aggregator} could not be checked (…)"; all failed → `unavailable` (one source: its own code, so
  California's `not_covered` / `upstream_error` answers are unchanged). Uncovered states add "{Nevada}: official
  evacuation zones are not available in this state". Envelope `retrieved_ms` / `source_updated_ms` only when one zone
  source answered. Border dedup: `dedup_border_zones` drops a zone whose `state` is another answered source's home.
- **Response additions** (§14.8.2): `states[]` ({state, name, availability, checked, source_ids, note, links});
  `sources[]` entries are copies of `SOURCES` with `retrieved_ms`, `updated_ms`, `status`, `reason`, `home_state`,
  `credit` ("Cal OES" / "Oregon Department of Emergency Management"); `issuing_authority` joins the adapters' texts.
- **Cameras** (§14.8.6): a bbox that does not touch California → `unavailable` + `state_not_available`, reason "Public
  cameras: California only (ALERTCalifornia, Caltrans). Not available in this state." (`extras.CAMERAS_NOT_AVAILABLE`),
  no upstream request. A bbox touching California (Brookings OR/CA) still lists California cameras.
- **Sample**: `backend/scripts/record_test_samples_evacuations.py` recorded the 2026-08-15 12:00Z snapshot of OEM's
  history layer (11 named zones + 1 `Fire_Name` null zone; levels 1/2/3; hazard "Other") and the live layer's
  description into `backend/tests/data/evacuations/` with `PROVENANCE.md`. Terms re-read 2026-10-23: item
  `licenseInfo` "Public", `accessInformation` "Oregon Department of Emergency Management".
- Tests: `backend/tests/test_evacuations_sources.py` (40 cases) and `test_extras.py` unchanged.

## 14.8.5 Evacuations, web (M3)

- Types (`extras/types.ts`, optional until the integration): `ExtrasReasonCode` + `'state_not_available'`;
  `ExtrasSource` + the §14.8.2 per-source fields and **`aggregator`** ("Cal OES" / "Oregon OEM"; an additive backend
  field, see deviations); `EvacZoneProps` + the ten §14.8.2 props; `EvacStateEntry`, `EvacuationsResponse.states`.
- `extras/evacuation.ts` (source-neutral): `zoneSourceId`, `aggregatorOf`, `sourceHomeState`, `answeredSources`,
  `answeredNames`, `notFireSpecific(aggregator)` (`NOT_FIRE_SPECIFIC` kept, `@deprecated`), `statusLabel` (OEM's
  definition for a non-verbatim level), `statusLevelNote`, `hazardNote` ("Evacuation for: Other, as recorded by Oregon
  OEM"), `incidentNameNote` ("Fire name as recorded by Oregon OEM: …; a name match is not proof it is this fire"),
  `zoneTimes` (+ `listedMs`, `basis`), `zoneListedPhrase` ("listed by Cal OES" / "added to the Oregon state layer"),
  `zoneTimeText` and `zoneDetail` per `time_basis`, `evacuationSourceUrl` (first answered zone source), feed items
  "<issuer> via <aggregator>" with "Oregon OEM's level" facts; `evacuationCredits` per listed source ("Evacuation
  zones: local officials via Oregon Department of Emergency Management"); `EvacuationPanel` wording and per-source
  freshness; `envelopeStatusLine` → "<what>: not available in this state" for `state_not_available` (cameras too).
- `official/model.ts`: `EvacuationState` 'not-available' with `reason` "Not available in this state (Nevada)"
  (outside the lower 48: the backend's coverage sentence), `notAvailableIn`, `sources: EvacuationSourceInfo[]` (per
  source aggregator, credit, url, times, answered), `checkedBy` ("Oregon OEM", "Cal OES and Oregon OEM"),
  `evacuationWho`. `OfficialZone` + `sourceId`, `aggregator`, `listedPhrase`, `verbatim`, `levelNote`, `hazardNote`,
  `incidentNote`, `state` (all optional). **`insideCalifornia` left every path** (kept `@deprecated`, unused):
  `needsPointQuery` asks the backend for any point outside the fire's area at the current time; a border answer
  (several states, not all checked) decides by the point's state (`pointState` from `/api/geo/lookup`; `loading`
  while unknown). NWS: `needsStatewideFireWeather` has no state gate; `fireWeatherAtPointState` decides "checked"
  from `states_checked` (missing → `["CA"]`) and the point's state only (`statesChecked`, `coversLower48`,
  `checkedScope`, `LOWER48_CODES`); the overview quiet caveat names `checkedScope` ("California" today, "the lower 48
  states" with all 49 codes).
- `official/hooks.ts`: `useOfficialAtPoint` looks the point up (`useGeoLookup`, us-web's `location/geoLookup.ts`) and
  adds `place: OfficialPlace` to `OfficialInfo` (§14.9.6); `placeState`.
- Card lines (`location/official.ts`): none listed "No evacuation order or warning listed here · {Oregon OEM}, checked
  … · not an all-clear"; not available "Evacuation zones: not available in this state" (sub: the reason); Oregon zones
  show OEM's definition with "Oregon OEM level; definition by Oregon OEM" and "issuer time not given; added to the
  Oregon state layer <time>"; links are the answered sources' pages (no Cal OES link outside California).
- Official now, compact summary, data status: the source names, times and tips per source; not available rows use
  the §14.14 full sentence once (fixes us-pipeline's Horse Gulch note "Not available in this state. Not available in
  this state (Montana) Follow local officials."); reasons end with a full stop before "Follow local officials."
- Fixtures: `web/src/extras/__fixtures__/samplesUs.ts` (`OR_EVAC_MEDFORD` from the recorded OEM sample,
  `OR_EVAC_KLAMATH_NONE`, `EVAC_RENO_NOT_AVAILABLE`), generated offline from the backend with simplified outlines.

## 14.5 Official fire records, web (M4)

- Types (`official/types.ts`): `OfficialKind`, `OfficialReasonCode` (+ `state_not_available`), `IncidentRecordCurrent`,
  `IncidentRecordResponse` (exactly §14.5, plus the envelope `kind` / `incident_id` / `caveats` the backend sends).
- `official/client.ts`: `incidentRecordUrl(id)`, **`recordUrl(summary)`** (CAL FIRE for `record_source 'calfire'` or a
  summary without it; the incident record for `'wfigs'`) and `secondaryRecordUrl(summary)` (a California fire with
  `irwin_id` and `active_sources.length === 1`; never a complex row (`complex_members` non-empty or no `irwin_id`),
  never a WFIGS row).
- `official/runtime.ts`: `record: QueryState<IncidentRecordResponse>`; both queries wait for the open fire's summary;
  a WFIGS fire never asks `/api/official/calfire`.
- `official/record.ts` (new): `RecordStatus` (a superset of `CalFireStatus`: `source`, `issuer` from
  `recordIssuerLabel`, `linkLabel` "CAL FIRE" / "NIFC WFIGS", `blocks` from `recordBlocks` when the agencies
  disagree (the matched WFIGS block refreshed from its endpoint; CAL FIRE's block keeps CAL FIRE's own status, never
  the summary's merged flag; a block name equal to the fire's name is not repeated), `members` of a CAL FIRE complex
  row (names verbatim with their `other_records` links; the numbers stay CAL FIRE's), `complexName`, `synthetic`,
  `notChecked`), `recordStatus(...)`, `recordBlockText` ("Active (USFS (USDA Forest Service) via NIFC WFIGS, updated Oct
  22, 9:05 AM PDT)"), `partOfComplex` (never "Complex Complex"), `wfigsRecordFeedItems` (topic `'record'`, kind
  official, labelled from the issuer), `SYNTHETIC_RECORD_REASON` ("Not available: synthetic or local data."),
  `RECORD_NOT_CHECKED_REASON` (HTTP 404 from an older backend: "Agency record not checked: …").
- `official/hooks.ts`: **`useRecord()`** (exported) replaces the internal `useCalfire` (kept as a `@deprecated` alias);
  `OfficialInfo.calfire` holds the `RecordStatus` (field name kept for us-web's call sites; `CalFireOfficial` is the
  superset type). `calfireStatus` takes the summary fallback only when `record_source === 'calfire'` (the
  `calfire.ts:89` mislabel).
- Feed: `FeedTopic` + `'record'` (`'calfire'` kept, `@deprecated`) and `'local-alert'`; CAL FIRE rows use `'record'`;
  "Updated by <issuer>" in the details; the filter tip says "agency record changes".
- Official now: `RecordRow` (label = the issuer; "NIFC WFIGS record" link; protecting agency; "NIFC WFIGS publishes
  the current record only; Fire-3d does not record changes to it yet."; the disagreement blocks; "Includes (NIFC WFIGS
  names): …"; "Part of the X Complex"; synthetic and not-checked lines). Compact summary and data status rows are
  labelled from the issuer; a synthetic fire has no record row; the location card's record link is "NIFC WFIGS" for
  a WFIGS fire.
- Tests: `official/record.test.ts` (11), `location/official.test.ts` (record link/line). `calfire.test.ts`: one
  expectation changed by the contract (feed `topic: 'calfire'` → `'record'`); its California strings are unchanged.
