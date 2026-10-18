// Contract types mirroring SPEC 5.1 (bundle files) and SPEC 6 (HTTP API) exactly.
// The backend mirror is backend/fire3d/contracts.py. Times are epoch ms UTC; raster times are hours since
// manifest.time_origin_ms with NEVER = 1e6. Local coordinates: x east+, z south+, metres.

export type Mode = 'live' | 'historical'

export const NEVER = 1.0e6

export interface IncidentSummary {
  id: string
  name: string
  mode: Mode
  year: number
  calfire_uid: string
  started_ms: number
  updated_ms: number | null
  contained_ms: number | null
  acres: number | null
  percent_contained: number | null
  is_active: boolean
  county: string | null
  location: string | null
  admin_unit: string | null
  url: string | null
  lat: number
  lon: number
  detections_24h: number | null // live only
  bundle_status: 'none' | 'building' | 'ready' | 'error'
  bundle_built_ms: number | null
}

export type LayerGrid = 'render' | 'fire' | 'image' | 'points'
export type LayerDtype = 'float32' | 'uint8' | 'uint16' | 'int16' | 'jpeg'

export interface LayerInfo {
  file: string // path relative to the bundle dir
  grid: LayerGrid
  dtype: LayerDtype
  width?: number
  height?: number
  count?: number // count for points
  units?: string
  nodata?: number
  min?: number
  max?: number
  description: string
}

export type EnsembleKind = 'gfs025' | 'ecmwf_ifs025' | 'perturbed' | 'none'
export type RunStatus = 'running' | 'ready' | 'error'

export interface ForecastSummary {
  run_id: string
  status: RunStatus
  issued_ms: number
  start_ms: number
  horizon_h: number
  ensemble: EnsembleKind
  members: number
  file: string // "forecasts/{run_id}/forecast.json"
}

export interface TimeRange {
  start_ms: number
  end_ms: number
  /** Latest observation of the fire. Live: the newest of its detections, mapped perimeters and confirmed satellite passes over it that saw no new fire (SPEC 8.3); historical: end_ms. */
  now_ms: number
  /** Live: newest detection or mapped perimeter (the burned area is known up to here). */
  last_detection_ms?: number
  /** Live: newest confirmed VIIRS/MODIS pass over the fire, whatever it saw. */
  last_pass_ms?: number
}

export interface GridSize {
  width: number
  height: number
  res_m: number
}

export interface ManifestGrid {
  crs: string
  utm_zone: number
  center_e: number
  center_n: number
  extent_m: number
  bbox_lonlat: [number, number, number, number] // w, s, e, n
  render: GridSize
  fire: GridSize
  elev_min_m: number
  elev_max_m: number
}

export interface Ignition {
  x: number
  z: number
  lat: number
  lon: number
  t_ms: number
  source: string
}

export interface DataSource {
  name: string
  detail: string
  fetched_ms: number
}

export interface IncidentManifest {
  schema_version: 1
  id: string
  name: string
  mode: Mode
  status: 'building' | 'ready' | 'error'
  summary: IncidentSummary
  time_origin_ms: number
  time_range: TimeRange
  grid: ManifestGrid
  layers: Record<string, LayerInfo> // elevation fuel canopy_cover canopy_height burn_severity? observed_arrival naip sky_view water? trees
  ignition: Ignition | null
  default_profile_path: [number, number][] // local [x, z] polyline (ignition -> main run)
  fuels_edition: string // e.g. "LF2024"
  data_sources: DataSource[]
  stats: { final_acres_observed: number; detections: number; perimeters: number }
  forecasts: ForecastSummary[] // newest first
  warnings: string[]
  built_ms: number // also the cache-buster: fetch files with ?v={built_ms}
}

export type Instrument = 'VIIRS' | 'MODIS' | 'GOES' | 'LANDSAT'

export interface Detection {
  t_ms: number
  lat: number
  lon: number
  x: number
  z: number
  frp: number | null
  satellite: string
  instrument: Instrument
  confidence: string
  daynight: 'D' | 'N'
  footprint_m: number
}

// GOES rows are thinned to <= 1 per 10 min per ~2 km cell (keep max FRP) to keep the file small.
export interface DetectionsFile {
  detections: Detection[]
}

export interface Perimeter {
  t_ms: number
  acres: number
  source: string
  rings: [number, number][][] // local x,z; <= 1500 vertices each; cumulative/monotone
}

export interface PerimetersFile {
  perimeters: Perimeter[]
}

export interface TimeseriesFile {
  step_h: 1
  t_ms: number[] // hourly, time_range.start_ms .. now_ms
  area_acres: number[]
  growth_acres_per_h: number[]
  ros_ch_per_h: number[]
  detections_per_h: number[]
  frp_mw_per_h?: number[] // hourly mean total FRP (MW), GOES-based when available (else VIIRS/MODIS)
}

export type EventType =
  | 'ignition'
  | 'rapid_growth'
  | 'spot_fire'
  | 'ridge_crossing'
  | 'containment'
  | 'peak_wind'
  | 'wind_shift'
  | 'perimeter_update'

export interface FireEvent {
  id: string
  type: EventType
  t_ms: number
  title: string
  detail: string
  x?: number
  z?: number
  confidence: 'observed' | 'estimated' | 'probable'
  source: string
}

export interface EventsFile {
  events: FireEvent[]
}

export interface WeatherAtFire {
  temp_c: number[]
  rh_pct: number[]
  dewpoint_c: number[]
  wind_speed_ms: number[]
  wind_dir_deg: number[] // FROM direction
  wind_gust_ms: number[]
  precip_mm: number[]
  fm1_pct: number[]
  fm10_pct: number[]
  fm100_pct: number[]
  ffwi: number[] // Fosberg Fire Weather Index
  flame_length_ft?: number[] // added by spread/behavior.py
  ros_ch_per_h_potential?: number[]
}

export interface WeatherGrid {
  nx: 4
  ny: 4
  x: number[] // the 4 column-centre x (west -> east)
  z: number[] // the 4 row-centre z (north -> south)
  u_ms: number[] // flattened [t][j][i]; j row north->south; u east+
  v_ms: number[] // v north+
}

export interface WeatherFile {
  source: string // e.g. "open-meteo:gfs_hrrr"
  t_ms: number[] // hourly
  at_fire: WeatherAtFire
  grid: WeatherGrid
  forecast_from_ms: number | null // first hour that is forecast rather than (re)analysis
}

export interface ForecastLayers {
  arrival_p10: LayerInfo
  arrival_p50: LayerInfo
  arrival_p90: LayerInfo
  burn_probability: LayerInfo
  flame_length_p50: LayerInfo
}

export type ForecastLayerName = keyof ForecastLayers

export interface ForecastManifest {
  run_id: string
  incident_id: string
  status: RunStatus
  error?: string
  issued_ms: number
  start_ms: number
  horizon_h: number
  time_origin_ms: number
  model: {
    engine: 'pyretechnics'
    version: string
    surface_lw_ratio_model: string
    crown: boolean
    spotting: boolean
    spread_adjustment: number
    grid_res_m: number
  }
  weather: { source: string; ensemble: EnsembleKind; members: number }
  layers: ForecastLayers
  series: {
    t_ms: number[]
    area_acres_p10: number[]
    area_acres_p50: number[]
    area_acres_p90: number[]
    ros_ch_per_h_p50: number[]
  }
  skill?: { lead_h: number; sorensen: number; observed_acres: number; forecast_acres_p50: number }[] // historical runs only
  runtime_s: number
  warnings: string[]
}

// ---------------------------------------------------------------------------------------------- SPEC 6 HTTP API

export interface JobStatus {
  id: string
  kind: 'build' | 'forecast' | 'refresh'
  incident_id: string
  status: 'queued' | 'running' | 'done' | 'error'
  progress: number // 0..1
  step: string
  message: string
  created_ms: number
  started_ms: number | null
  finished_ms: number | null
  error: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any | null
}

export type AircraftCategory = 'airtanker' | 'helicopter' | 'air_attack' | 'lead_plane' | 'other_fire' | 'unknown'

export interface Aircraft {
  hex: string
  callsign: string | null
  registration: string | null
  type: string | null
  category: AircraftCategory
  is_fire_aircraft: boolean
  reason: string
  lat: number
  lon: number
  x: number
  z: number
  alt_m: number | null
  agl_m: number | null
  gs_kt: number | null
  track_deg: number | null
  seen_s: number
  on_ground: boolean
}

export interface HealthResponse {
  ok: boolean
  version: string
}

export interface IncidentListResponse {
  mode: Mode
  updated_ms: number
  incidents: IncidentSummary[]
}

export interface IncidentDetailResponse {
  summary: IncidentSummary
  manifest: IncidentManifest | null
  job: JobStatus | null
}

export type EnsembleRequest = 'auto' | EnsembleKind

export interface ForecastRequest {
  start_ms?: number
  horizon_h?: number // default 72
  ensemble?: EnsembleRequest // default "auto": live -> gfs025, historical -> perturbed
  members?: number
}

export interface AircraftResponse {
  updated_ms: number
  source: string // "adsb.lol", or "adsb.fi" when adsb.lol is unreachable
  radius_nm: number
  aircraft: Aircraft[]
  note?: string // e.g. why the list is empty (historical incident)
}

export interface LiveStatus {
  last_refresh_ms: number | null
  next_refresh_ms: number | null
  active_incidents: number
  detections_24h_ca: number | null
  auto_build: boolean
}
