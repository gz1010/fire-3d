// Optional map sources (owner: optional-sources; BRIEF §11, CONTRACT "Optional sources"): response shapes of the
// /api/extras/* endpoints in backend/fire3d/api/extras.py (snake_case, mirrored 1:1).

/** Every response says explicitly whether it can be shown for the requested time. */
export type ExtrasStatus = 'available' | 'unavailable' | 'not_available_for_past_dates'
export type ExtrasReasonCode = 'past_date' | 'upstream_error' | 'not_covered' | null

export interface ExtrasSource {
  id: string
  name: string
  publisher: string
  url: string
  service_url?: string
  license: string
  terms_url: string
  /** Credit text to show with the data ("{year}" already filled in for imagery products). */
  attribution: string
  disclaimer: string | null
  cadence: string
}

/** Fields shared by the evacuation, camera and imagery responses. */
export interface ExtrasEnvelope {
  kind: 'evacuations' | 'cameras' | 'imagery'
  status: ExtrasStatus
  reason: string | null
  reason_code: ExtrasReasonCode
  /** When Fire-3d fetched the data from the source (cache time), epoch ms. */
  retrieved_ms: number | null
  /** The source's own last update time, epoch ms. */
  source_updated_ms: number | null
  requested_at_ms: number | null
  now_ms: number
  /** [w, s, e, n] WGS84 area the response covers. */
  bbox: [number, number, number, number]
  incident_id: string | null
  sources: ExtrasSource[]
  caveats: string[]
}

// ---- evacuations ----------------------------------------------------------------------------------------------
/** Styling class of an official status (the official wording itself is `status`, shown verbatim). */
export type EvacStatusKey = 'order' | 'shelter' | 'warning' | 'advisory' | 'lifted' | 'other' | 'training' | 'normal' | 'unknown'

export interface EvacZoneProps {
  zone_id: string
  zone_name: string | null
  /** Official status wording, verbatim (e.g. "Evacuation Order"). */
  status: string | null
  status_key: EvacStatusKey
  county: string | null
  /** "Los Angeles County": the issuing jurisdiction as named by the source. */
  jurisdiction: string | null
  city_code: string | null
  event_type: string | null
  /** Official public message, verbatim. */
  notes: string | null
  critical_info: string | null
  public_info: string | null
  /** When the issuing agency last edited this zone (null = not provided by the source). */
  status_updated_ms: number | null
  /** When Cal OES last copied it into the statewide layer. */
  aggregated_ms: number | null
}

export type GeoJsonPolygon = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] }

export interface EvacZoneFeature {
  type: 'Feature'
  id: string
  geometry: GeoJsonPolygon
  properties: EvacZoneProps
}

export interface EvacCountyCoverage {
  county: string
  /** The county's zones feed the statewide layer. */
  in_statewide_layer: boolean
  acquisition_status: string | null
  zone_source: string | null
  /** The county's own evacuation map (external link), when Cal OES lists one. */
  reference_url: string | null
}

export interface EvacuationsResponse extends ExtrasEnvelope {
  kind: 'evacuations'
  issuing_authority: string
  zones: { type: 'FeatureCollection'; features: EvacZoneFeature[] }
  counts: Partial<Record<EvacStatusKey, number>>
  coverage: EvacCountyCoverage[]
}

// ---- cameras --------------------------------------------------------------------------------------------------
export type CameraKind = 'wildfire' | 'traffic'

export interface CameraProps {
  /** "alertca:<slug>" or "caltrans:d<n>:<name>". */
  id: string
  name: string
  source_id: 'alertcalifornia' | 'caltrans_cctv'
  source_label: string
  kind: CameraKind
  /** "Pan-Tilt-Zoom" or a fixed view such as "South". */
  view: string | null
  /** Current pointing direction of a pan-tilt-zoom camera (degrees clockwise from north), when reported. */
  azimuth_deg: number | null
  viewer_url: string | null
  credit: string
  license: string
  district: number | null
  county: string | null
  nearby_place: string | null
  elevation_ft: number | null
  /** Caltrans district status (null = not reported). */
  in_service: boolean | null
  update_minutes: number | null
  status_record_ms: number | null
  streaming_video: boolean
  /** Relative API path that fetches the latest frame on request. */
  frame_endpoint: string
}

export interface CameraFeature {
  type: 'Feature'
  id: string
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: CameraProps
}

export interface CamerasResponse extends ExtrasEnvelope {
  kind: 'cameras'
  cameras: { type: 'FeatureCollection'; features: CameraFeature[] }
  counts: Partial<Record<CameraKind, number>>
  /** Cameras of networks whose terms Fire-3d has not verified (not listed), by network name. */
  excluded: Record<string, number>
}

export interface CameraFrameResponse {
  camera_id: string
  status: 'available' | 'unavailable'
  reason: string | null
  /** Relative API path of the image bytes (content-addressed; kept ~10 min). */
  image_url: string | null
  /** Last-Modified time of the image reported by the camera server (null = not reported). */
  image_time_ms: number | null
  image_time_basis?: string
  retrieved_ms: number
  age_ms?: number | null
  width?: number | null
  height?: number | null
  bytes?: number
  credit: string
  license: string
  viewer_url: string | null
  source: ExtrasSource
}

// ---- imagery --------------------------------------------------------------------------------------------------
export type ImageryFamily = 'sentinel-2' | 'landsat' | 'viirs' | 'goes'
export type ImageryComposite = 'true_color' | 'fire_false_color' | 'geocolor'

export type ImageryDisplay =
  | {
      type: 'image'
      url: string
      coordinates: [[number, number], [number, number], [number, number], [number, number]]
      bbox: [number, number, number, number]
      /** Ground size (m) of one pixel of the backend render (>= the sensor's resolution for large areas). */
      pixel_m?: number
    }
  | { type: 'raster'; tiles: string[]; tile_size: number; max_zoom: number; bounds: [number, number, number, number] }

export interface ImageryProduct {
  id: string
  family: ImageryFamily
  label: string
  composite: ImageryComposite
  platform: string
  sensor: string
  /** Acquisition time (first pass of the product), epoch ms. */
  acquired_ms: number
  acquired_end_ms: number | null
  pass_times_ms: number[]
  published_ms: number | null
  latency_ms: number | null
  latency_note: string | null
  resolution_m: number
  resolution_note: string | null
  cloud_cover_pct: number | null
  cloud_note: string | null
  coverage_pct: number | null
  coverage_note: string | null
  /** False while the image is listed but not displayable yet (reason in unavailable_reason). */
  available: boolean
  unavailable_reason: string | null
  display: ImageryDisplay | null
  attribution: string
  source_id: string
  notes: string[]
}

export interface ImageryFamilyStatus {
  family: ImageryFamily
  label: string
  source_id: string
  status: 'available' | 'none' | 'unavailable'
  reason: string | null
  count: number
}

export interface ImageryResponse extends ExtrasEnvelope {
  kind: 'imagery'
  /** The time images are listed for (the requested time, never later than now). */
  reference_ms: number
  products: ImageryProduct[]
  families: ImageryFamilyStatus[]
}

export interface ExtrasSourcesResponse {
  sources: Record<string, ExtrasSource>
  past_tolerance_ms: number
}
