// Official sources (owner: official-web; BRIEF-2 §5, CONTRACT §13 "Brief 2 interfaces" I7): response shapes of the
// backend's /api/official/* endpoints (snake_case, mirrored 1:1; owner of the endpoints: official-backend). Every
// field the backend may leave out is optional or nullable here, and `normalize*` in calfire.ts / fireWeather.ts fill
// safe defaults, so a partial answer never crashes a panel and never reads as "nothing official".

/** Same meaning as the extras envelope: whether the answer can be shown for the requested time. */
export type OfficialStatus = 'available' | 'unavailable' | 'not_available_for_past_dates'

export interface OfficialSource {
  name: string
  url: string
  /** Credit text to show with the data. */
  credit: string
  /** Additive (backend): licence and terms page of the source. */
  license?: string
  terms_url?: string
}

/** Fields shared by the official responses (the extras envelope, I7). */
export interface OfficialEnvelope {
  status: OfficialStatus
  reason_code: string | null
  reason: string | null
  source: OfficialSource
  /** When Fire-3d fetched the data from the source (its check time), epoch ms. */
  retrieved_ms: number | null
  /** The source's own last update time, epoch ms. */
  source_updated_ms: number | null
  requested_at_ms: number | null
  now_ms: number
}

/**
 * The official area the map highlights (CONTRACT §13 official-web): set by selecting an official feed row or an
 * "Official now" row, read by the official map layer (mountOfficialLayers). `id` is the row's id.
 */
export type OfficialHighlight =
  | { kind: 'evacuation'; id: string; zoneIds: string[] }
  | { kind: 'fire-weather'; id: string; ugcs: string[]; alertIds: string[] }

// ---- CAL FIRE ---------------------------------------------------------------------------------------------------
export interface CalFireCurrent {
  acres: number | null
  percent_contained: number | null
  is_active: boolean | null
  final: boolean | null
  /** CAL FIRE's own "Updated" time of the record. */
  updated_ms: number | null
  /** Additive (backend): CAL FIRE's extinguished / contained time. */
  extinguished_ms?: number | null
}

/** One recorded change of the CAL FIRE record ([old, new] per changed field). */
export interface CalFireChange {
  /** CAL FIRE's "Updated" time of the new record (null = not given). */
  updated_ms: number | null
  /** When Fire-3d first saw the change. */
  seen_ms: number
  acres?: [number | null, number | null]
  percent_contained?: [number | null, number | null]
  is_active?: [boolean | null, boolean | null]
  final?: [boolean | null, boolean | null]
}

export interface CalFireResponse extends OfficialEnvelope {
  incident_url: string | null
  /** CAL FIRE's AgencyNames (one string, or a list). */
  agencies: string | string[] | null
  current: CalFireCurrent | null
  /** Oldest first (the endpoint's order is not relied on). */
  changes: CalFireChange[]
  /** When Fire-3d started recording this incident's changes (null = never recorded). */
  recording_since_ms: number | null
  caveats: string[]
  kind?: string
  incident_id?: string | null
}

// ---- agency fire records (brief 3, CONTRACT §14.5) -----------------------------------------------------------------
/** The I7 envelope kinds (brief 3 widens them). */
export type OfficialKind = 'calfire' | 'fire_weather' | 'incident_record' | 'local_alerts'
export type OfficialReasonCode = 'past_date' | 'upstream_error' | 'not_covered' | 'state_not_available' | null

export interface IncidentRecordCurrent {
  /** The record's name, verbatim. */
  name: string
  acres: number | null
  percent_contained: number | null
  is_active: boolean
  discovered_ms: number | null
  contained_ms: number | null
  controlled_ms: number | null
  out_ms: number | null
  /** ModifiedOnDateTime_dt: the record's own update time. */
  updated_ms: number | null
  ics209_report_ms: number | null
}

/** `GET /api/official/incident-record?incident=<id>`: the fire's NIFC WFIGS (IRWIN) record (us-catalog's endpoint). */
export interface IncidentRecordResponse extends OfficialEnvelope {
  kind?: 'incident_record'
  incident_id?: string | null
  record_source: 'wfigs'
  irwin_id: string | null
  unique_fire_id: string | null
  publisher: 'NIFC WFIGS (IRWIN)' | string
  /** Protecting-agency code, verbatim. */
  agency_code: string | null
  /** Its plain name (NWCG unit identifiers); null when the code is unknown. */
  agency: string | null
  protecting_unit: string | null
  state: string | null
  county: string | null
  time_zone: string
  /** The all-years layer's record page (https). */
  incident_url: string | null
  /** The NIFC Open Data item page ("about this source"). */
  dataset_url: string
  current: IncidentRecordCurrent | null
  complex: { name: string; id: string | null } | null
  /** History outside California is deferred: always []. */
  changes: []
  recording_since_ms: null
  caveats?: string[]
}

// ---- local officials' messages relayed by NWS, and the FEMA archive (brief 3, CONTRACT §14.7) ------------------
export type LocalChannel = 'nws_api' | 'openfema_archive'
export type LocalEventCode = 'FRW' | 'EVI' | 'SPW' | 'CDW' | 'CEM' | 'LAE' | string

export interface LocalAlert {
  /** The CAP identifier, verbatim (the same message has the same id in both channels). */
  id: string
  channel: LocalChannel
  archived: boolean
  /** Verbatim ("Fire Warning", "Evacuation Immediate"). */
  event: string
  event_code: LocalEventCode
  message_type: 'Alert' | 'Update' | 'Cancel' | null
  references: string[]
  /** Verbatim; never the operator's sender address. */
  sender_name: string | null
  /** The sender is a platform ("Public Alert System"): the card says "issuer not named". */
  sender_is_platform: boolean
  sent_ms: number | null
  effective_ms: number | null
  onset_ms: number | null
  expires_ms: number | null
  headline: string | null
  description: string | null
  instruction: string | null
  wea_text: string | null
  wea_long_text: string | null
  /** https only; the issuer's own link (present on only about 6 % of messages). */
  web: string | null
  /** Always set, https: where this copy of the message can be read (the NWS API record, or the OpenFEMA record). */
  source_url: string
  area_desc: string | null
  same_codes: string[]
  ugcs: string[]
  /** GeoJSON Polygon, or MultiPolygon when an archived message had several areas. */
  polygon: GeoPolygon | null
  match: 'polygon' | 'county'
  /** Polygon matches only (null for a county match: a county says nothing about the point). */
  covers_reported_location: boolean | null
  nearest_km: number | null
  /** IANA zone of its area. */
  time_zone: string | null
  phase: 'upcoming' | 'in_effect' | 'ended'
}

export interface LocalChannelStatus {
  id: LocalChannel
  status: 'available' | 'unavailable' | 'pending' | 'not_checked'
  retrieved_ms: number | null
  source_updated_ms: number | null
  reason: string | null
}

/** `GET /api/official/local-alerts?incident=<id>&at_ms=&margin_km=` or `?bbox=w,s,e,n` (us-pipeline's endpoint). */
export interface LocalAlertsResponse extends OfficialEnvelope {
  kind: 'local_alerts'
  alerts: LocalAlert[]
  channels: LocalChannelStatus[]
  area_bbox: [number, number, number, number] | null
  reported_location: [number, number] | null
  counties: { fips: string; name: string; state: string }[]
  caveats?: string[]
  incident_id?: string | null
}

// ---- NWS fire weather ------------------------------------------------------------------------------------------
export interface NwsVtec {
  office: string
  /** "FW" for fire weather products. */
  phenomena: string
  /** "W" warning, "A" watch. */
  significance: string
  etn: number
  /** NEW, CON, EXT, EXA, EXB, UPG, CAN, EXP, COR, ROU. */
  action: string
}

export interface NwsAlert {
  id: string
  /** The alert's own page (api.weather.gov, or the IEM archive page for archived copies). */
  url: string | null
  /** NWS wording, verbatim: "Red Flag Warning", "Fire Weather Watch". */
  event: string
  vtec: NwsVtec | null
  sender_name: string | null
  sent_ms: number | null
  effective_ms: number | null
  onset_ms: number | null
  expires_ms: number | null
  ends_ms: number | null
  headline: string | null
  /** Verbatim product text ("* WHAT...", "* WHERE...", ...). */
  description: string | null
  instruction: string | null
  area_desc: string | null
  ugcs: string[]
  message_type: string | null
  status: string | null
  /** The alert's zones contain the incident's reported location. */
  covers_reported_location: boolean | null
  /** Distance from the incident (its area or reported location) to the nearest alert zone, km (0 = touching). */
  nearest_km: number | null
  /** An archived copy (Iowa Environmental Mesonet) rather than the live NWS feed. */
  archived: boolean
  /** Additive (backend): the issuing office's page. */
  office_url?: string | null
  /** Additive (backend): NWS's own headline parameter ("RED FLAG WARNING IN EFFECT ..."). */
  nws_headline?: string | null
  /** Additive (backend): 'in_effect' | 'upcoming' | 'ended' at the request time (the web computes its own). */
  phase?: string | null
  /** Fire-3d only (never from the backend): the alert left the live NWS feed before its end time; when it was last
   *  checked missing. */
  dropped_ms?: number | null
  /** Brief 3 (CONTRACT §14.6): IANA zone of the alert's area (its first zone's outline, else its state's main zone). */
  time_zone?: string | null
}

export type GeoPolygon = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] }

export interface NwsZoneProps {
  ugc: string
  name: string | null
  /** Ids of the alerts (NwsAlert.id) that cover this zone. */
  alert_ids: string[]
}

export interface NwsZoneFeature {
  type: 'Feature'
  id?: string | number
  geometry: GeoPolygon | null
  properties: NwsZoneProps
}

export interface FireWeatherResponse extends OfficialEnvelope {
  alerts: NwsAlert[]
  /** Simplified fire weather zone outlines of the listed alerts. */
  zones: { type: 'FeatureCollection'; features: NwsZoneFeature[] }
  /** Additive (backend): the area checked ([w, s, e, n]: the analysis area or the reported point ± 10 km, + 15 km);
   *  null for the statewide answer (no incident), which lists every California alert. */
  area_bbox?: [number, number, number, number] | null
  reported_location?: [number, number] | null
  caveats?: string[]
  kind?: string
  incident_id?: string | null
  /** Brief 3 (CONTRACT §14.6): the states this answer actually covers (USPS codes; the overview: all 49 of the lower 48
   *  + DC once the national request is live). Missing (an older backend asking `area=CA`) is read as `["CA"]`;
   *  `[]` = nothing was checked (NWS could not be reached). */
  states_checked?: string[] | null
  /** Brief 3: the states with at least one alert in this answer. */
  alert_states?: string[] | null
}
