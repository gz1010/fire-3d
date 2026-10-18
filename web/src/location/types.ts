// Location-check and geocoding contract types (owner: location; agreed in docs/redesign/CONTRACT.md §5-6; fields
// marked "addition" extend the contract). Every model field has explicit "unknown" states: outside the modeled area,
// no bundle, missing forecast, nodata, never burned / never reached, loading, error. None of them may be shown as
// "low risk".
import type { Detection, EnsembleKind, ForecastManifest, IncidentManifest, IncidentSummary, Instrument, Perimeter, WeatherFile } from '../api/types'
import type { RasterSlot } from '../data/rasters'
import type { SelectedLocation, SelectionSource } from '../state/workspace'

/** Why a modeled value is unknown at the point. */
export type ModelGap =
  | 'no_bundle' // the incident has no ready bundle (yet)
  | 'outside_modeled_area' // outside the incident's analysis square (AOI): unknown, not low risk
  | 'no_forecast' // no ready forecast run is selected (missing forecast)
  | 'nodata' // the raster has no value here (LayerInfo.nodata / NaN)
  | 'loading' // rasters still loading
  | 'error' // a raster failed to load

/** CPU rasters for the check (data/rasters.ts slots, so loading / missing / error propagate). */
export interface LocationRasters {
  observedArrival: RasterSlot // layers/observed_arrival.bin (fire grid, hours since time_origin_ms, NEVER = 1e6)
  elevation: RasterSlot // layers/elevation.bin (render grid, m)
  fuel: RasterSlot // layers/fuel.bin (FBFM40 code, 0 = nodata)
  burnProbability: RasterSlot // forecast burn_probability (fraction of members burned by start + horizon)
  arrivalP10: RasterSlot // forecast arrival quantiles (hours since forecast.time_origin_ms, NEVER = not reached)
  arrivalP50: RasterSlot
  arrivalP90: RasterSlot
}

/** Addition: what the Census Geocoder returned for an address selection (kept by location/addressStore.ts). */
export interface AddressDetails {
  query: string
  matchedAddress: string
  lat: number
  lon: number
  /** House-number range of the TIGER/Line edge the position is interpolated along (e.g. "600" .. "628"). */
  fromAddress: string | null
  toAddress: string | null
  side: 'L' | 'R' | null
  tigerLineId: string | null
  /** Census benchmark (null when not reported). */
  benchmark: string | null
  source: string
  fetchedMs: number
}

export interface LocationCheckInput {
  point: SelectedLocation
  /** Timeline time: "latest perimeter" = newest perimeter with t_ms <= timeMs; observed fire as of timeMs. */
  timeMs: number
  /** Wall clock (freshness / ages). */
  nowMs: number
  summary: IncidentSummary | null
  /** Ready manifest of the selected incident, else null (-> 'no_bundle'). */
  manifest: IncidentManifest | null
  perimeters: Perimeter[]
  detections: Detection[]
  weather: WeatherFile | null
  /** Selected forecast run (null -> 'no_forecast'). */
  forecast: ForecastManifest | null
  rasters: LocationRasters
  /** Addition: Census details when the point is a geocoded address. */
  address?: AddressDetails | null
}

export interface PointInfo {
  lat: number
  lon: number
  /** Address / place label, else formatted WGS84 coordinates. */
  label: string
  source: SelectionSource
  /** Accurate plain-language type, e.g. "Address (interpolated along the street's address range)". */
  locationType: string
  approximate: boolean
  adjusted: boolean
  /** Addition: Census details for addresses (null otherwise or after the incident changed). */
  address: AddressDetails | null
}

export type PerimeterCheck =
  | { state: 'none'; reason: 'no_perimeters' | 'none_before_time' | 'no_bundle' | 'loading' | 'error' }
  | {
      state: 'ok'
      /** Addition: 'mapped' = newest perimeters.json polygon at or before the time; 'reconstructed' = no mapped
       *  perimeter by then, so the burned area estimated from the observed-arrival raster (arrival <= time). */
      basis: 'mapped' | 'reconstructed'
      inside: boolean
      /** 0 when inside; else geodesic distance (m) to the nearest perimeter / burned-area edge. */
      distanceM: number
      /** Direction of the point FROM the nearest perimeter point, degrees clockwise from true north (null inside). */
      directionDeg: number | null
      /** Addition: geodesic distance (m) to the edge also when inside (0 = on the edge). */
      edgeDistanceM: number
      /** Addition: WGS84 position of the nearest edge point. */
      nearest: { lat: number; lon: number }
      /** Mapped: the perimeter's time. Reconstructed: the timeline time the estimate describes. */
      perimeterTimeMs: number
      perimeterSource: string
      perimeterAcres: number
      /** nowMs - perimeterTimeMs. */
      ageMs: number
      /** Addition: timeMs - perimeterTimeMs (how much older the perimeter is than the selected time). */
      lagMs: number
      /** Addition: newest satellite detection at or before the time (freshness of a reconstruction). */
      latestDetectionMs: number | null
    }

/** Observed fire from the reconstructed arrival raster (an estimate from detections + perimeters). */
export type ObservedFireCheck =
  | { state: 'gap'; gap: ModelGap }
  | { state: 'not_burned'; asOfMs: number } // NEVER, or a reconstructed arrival after timeMs
  | { state: 'burned'; arrivalMs: number } // reconstructed arrival <= timeMs

/** Nearest satellite detection at or before timeMs: context only, never "the fire front". */
export type DetectionCheck =
  | { state: 'none'; windowH: number }
  | {
      state: 'ok'
      distanceM: number
      /** Direction of the detection FROM the point, degrees clockwise from true north. */
      directionDeg: number
      tMs: number
      instrument: Instrument
      satellite: string
      /** Pixel footprint (m): positional uncertainty of the detection. */
      footprintM: number
      ageMs: number
      /** Addition: only detections in the `windowH` hours up to timeMs are considered. */
      windowH: number
      /** Addition: detections in that window. */
      count: number
    }

/** One arrival-time quantile at the point: a time, or fewer than K % of members reached it within the horizon.
 *  `atStart` (addition): the time equals the forecast start, i.e. the pixel was already inside the observed burned
 *  area the forecast starts from. */
export type ArrivalQuantile = { state: 'time'; ms: number; atStart: boolean } | { state: 'not_reached' } | { state: 'nodata' }

export type ForecastCheck =
  | { state: 'gap'; gap: ModelGap }
  | {
      state: 'ok'
      runId: string
      issuedMs: number
      startMs: number
      /** start + horizon: the only period burn_probability describes. */
      endMs: number
      horizonH: number
      members: number
      ensemble: EnsembleKind
      /** Fraction (0..1) of ensemble members that burned the pixel by endMs; 0 = no member reached it. */
      burnProbability: { state: 'value'; fraction: number } | { state: 'nodata' }
      /** Addition: members that burned it (fraction x members) when that is a whole number, else null. */
      burnedMembers: number | null
      /** Arrival-time quantiles across members (not scenarios; P90 is not a "worst case"). */
      arrival: { p10: ArrivalQuantile; p50: ArrivalQuantile; p90: ArrivalQuantile }
      /** At timeMs: the largest K in {10, 50, 90} with arrival_pK <= timeMs, i.e. at least K % of members had reached
       *  the point (exact); 0 when fewer than 10 %; null when timeMs is outside [startMs, endMs]. */
      reachedShareAtTime: 0 | 10 | 50 | 90 | null
      /** Addition: already inside the burned area the forecast starts from (all quantiles at the start). */
      burnedAtStart: boolean
      /** Addition: historical run on past weather (a hindcast, issued after the fact) vs a live forecast. */
      hindcast: boolean
      model: { engine: string; version: string; crown: boolean; spotting: boolean; gridResM: number }
      weatherSource: string
      /** Addition: model warnings relevant to a point check (e.g. runs reaching the edge of the modeled area). */
      warnings: string[]
    }

export interface WindReading {
  speedMs: number
  /** Meteorological FROM direction, degrees clockwise from north. */
  fromDeg: number
}

export type WindContext =
  | { state: 'none' }
  | {
      state: 'ok'
      tMs: number
      speedMs: number
      gustMs: number | null
      /** Meteorological FROM direction, degrees clockwise from north. */
      fromDeg: number
      isForecast: boolean
      source: string
      /** 'fire' = weather.json at_fire series; 'point' = the 4x4 wind grid at the point. */
      where: 'fire' | 'point'
      /** Addition: the weather-grid cell nearest the point (inside the modeled area), besides the at-fire series. */
      atPoint: (WindReading & { cellSizeM: number }) | null
    }

export type TerrainContext =
  | { state: 'gap'; gap: ModelGap }
  | {
      state: 'ok'
      /** Null while the elevation layer is unavailable (fuel may still be known). */
      elevationM: number | null
      slopePct: number | null
      /** Downslope-facing aspect, degrees clockwise from true north (null on flat ground). */
      aspectDeg: number | null
      fuelCode: number | null
      fuelLabel: string | null
      /** Addition: FBFM40 model name, e.g. "High load, dry climate shrub". */
      fuelName: string | null
      burnable: boolean | null
    }

/** Addition (brief 2): air humidity and 1-h dead fuel moisture at the fire, at the wind's hour (weather.json at_fire,
 *  model weather; fuel moisture is derived from temperature and humidity, SPEC 8.4). */
export type DrynessContext =
  | { state: 'none' }
  | { state: 'ok'; tMs: number; rhPct: number | null; fm1Pct: number | null; isForecast: boolean; source: string }

/** Addition (brief 2): ground elevation at the point versus at the nearest fire edge point (elevation model). Only
 *  when the point is outside the fire area and both points are inside the modeled area. */
export type EdgeRiseContext =
  | { state: 'none'; reason: 'inside' | 'no_edge' | 'outside_modeled_area' | 'no_elevation' }
  | { state: 'ok'; pointElevM: number; edgeElevM: number; riseM: number; distanceM: number }

export interface ReportSource {
  name: string
  kind: 'observation' | 'estimate' | 'model' | 'official' | 'reference'
  /** Acquisition / issue / update time when known. */
  timeMs: number | null
  detail: string | null
}

export interface LocationReport {
  point: PointInfo
  modeledArea: 'inside' | 'outside' | 'no_bundle'
  /** Incident-local metres (x east, z south) or null without a bundle. */
  local: { x: number; z: number } | null
  /** Addition: distance (m) from the point to the edge of the modeled area when inside it. */
  edgeDistanceM: number | null
  perimeter: PerimeterCheck
  observedFire: ObservedFireCheck
  nearestDetection: DetectionCheck
  forecast: ForecastCheck
  wind: WindContext
  terrain: TerrainContext
  /** Addition (brief 2): dryness at the fire at the selected time. */
  dryness: DrynessContext
  /** Addition (brief 2): is the point uphill of the nearest fire edge. */
  edgeRise: EdgeRiseContext
  /** Addition (brief 2): the incident's latest observation (manifest.time_range.now_ms), for the stale flag. */
  latestObservationMs: number | null
  sources: ReportSource[]
  /** Plain-language uncertainty notes (model ensemble meaning, approximations, freshness). */
  caveats: string[]
  /** The timeline time the report describes. */
  timeMs: number
  computedAtMs: number
}

// ------------------------------------------------------------------------------------------------- geocoding
/** What a geocode match is: a Census street address (interpolated), or a local Gazetteer town / ZIP area (the
 *  area's internal point). Brief 2 addition; replies without `kind` are street addresses. */
export type GeocodeKind = 'address' | 'place' | 'zip'
export type PlaceType = 'city' | 'town' | 'cdp' | 'place'

/** GET /api/geocode?q=<street address | California town | ZIP code> (CONTRACT §6). JSON mirrors the backend. */
export interface GeocodeMatch {
  /** Addition (brief 2): absent on older replies = 'address'. */
  kind?: GeocodeKind
  /** Street addresses: Census matchedAddress; towns "Altadena, CA"; ZIP areas "ZIP 91001, CA". */
  matched_address: string
  lat: number
  lon: number
  /** Census TIGER/Line edge the position is interpolated along (not a rooftop position). */
  tiger_line_id: string | null
  side: 'L' | 'R' | null
  /** Addition: house-number range of that edge. */
  from_address?: string | null
  to_address?: string | null
  /** Addition (towns, ZIP areas): display name ("Altadena", "91001"). */
  name?: string
  place_type?: PlaceType
  /** "city", "town", "census-designated place". */
  place_type_label?: string
  zip?: string
  /** Land area of the town / ZIP area (sizes the map view). */
  land_km2?: number
  /** The whole name (or the name in parentheses, "Ventura") matched, not just a prefix. */
  exact?: boolean
  /** Nearest other place (same-named towns; the place a ZIP area lies in or near). */
  near?: string | null
  near_km?: number | null
}

export interface GeocodeResponse {
  query: string
  /** Addition (brief 2). */
  kind?: GeocodeKind
  /** Addition (brief 2): matched locally from the Census Gazetteer index (no upstream call). */
  local?: boolean
  matches: GeocodeMatch[]
  /** Addition: candidates before the proxy's limit (matches holds at most 10; towns 8). */
  total_matches?: number
  /** Census benchmark of street addresses; null for local replies. */
  benchmark: string | null
  /** Addition (local replies): Gazetteer vintage (year). */
  vintage?: number
  source: string
  attribution: string
  /** Addition: plain-language accuracy note (or why nothing matched). */
  note?: string
  cached: boolean
  fetched_ms: number
}
