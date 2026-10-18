// Synthetic incidents for the location tests (owner: location). Grid geometry follows SPEC 4.1; pixel centres are
// converted with lib/geo.ts (the Forensic UTM implementation) so the checks are verified against an independent
// conversion, not against the module under test. Not imported by app code.
import { NEVER, type Detection, type ForecastManifest, type IncidentManifest, type LayerInfo, type Perimeter, type WeatherFile } from '../api/types'
import type { LoadedLayer, RasterArray, RasterSlot } from '../data/rasters'
import { lonLatToUtm, utmToLonLat } from '../lib/geo'
import type { SelectedLocation } from '../state/workspace'
import type { LocationCheckInput, LocationRasters } from './types'

export const HOUR = 3_600_000
/** Jan 7 2025, 09:00 PST. */
export const ORIGIN = Date.UTC(2025, 0, 7, 17, 0)

export interface GridSpec {
  id: string
  zone: 10 | 11
  lon: number
  lat: number
  extent: number
  /** Fire-grid size (square). */
  n: number
}

/** Near Altadena (EPSG:32611), like fixture-demo. */
export const ZONE11: GridSpec = { id: 'test-zone11-fire', zone: 11, lon: -118.07, lat: 34.2, extent: 12000, n: 400 }
/** Santa Lucia Range (EPSG:32610), like fixture-live. */
export const ZONE10: GridSpec = { id: 'test-zone10-fire', zone: 10, lon: -121.5, lat: 36.2, extent: 16000, n: 512 }

export function makeManifest(spec: GridSpec, over: Partial<IncidentManifest> = {}): IncidentManifest {
  const [ce, cn] = lonLatToUtm(spec.lon, spec.lat, spec.zone)
  const h = spec.extent / 2
  const sw = utmToLonLat(ce - h, cn - h, spec.zone)
  const ne = utmToLonLat(ce + h, cn + h, spec.zone)
  const fireInfo = (file: string, extra: Partial<LayerInfo> = {}): LayerInfo => ({ file, grid: 'fire', dtype: 'float32', width: spec.n, height: spec.n, description: file, ...extra })
  return {
    schema_version: 1,
    id: spec.id,
    name: 'Test Fire',
    mode: 'historical',
    status: 'ready',
    summary: { id: spec.id, name: 'Test Fire', lat: spec.lat, lon: spec.lon } as IncidentManifest['summary'],
    time_origin_ms: ORIGIN,
    time_range: { start_ms: ORIGIN, end_ms: ORIGIN + 96 * HOUR, now_ms: ORIGIN + 96 * HOUR },
    grid: {
      crs: `EPSG:326${spec.zone}`,
      utm_zone: spec.zone,
      center_e: ce,
      center_n: cn,
      extent_m: spec.extent,
      bbox_lonlat: [sw[0], sw[1], ne[0], ne[1]],
      render: { width: spec.n * 2, height: spec.n * 2, res_m: spec.extent / (spec.n * 2) },
      fire: { width: spec.n, height: spec.n, res_m: spec.extent / spec.n },
      elev_min_m: 0,
      elev_max_m: 2000,
    },
    layers: {
      observed_arrival: fireInfo('layers/observed_arrival.bin', { units: 'h' }),
      fuel: fireInfo('layers/fuel.bin', { dtype: 'uint8', nodata: 0 }),
      elevation: { ...fireInfo('layers/elevation.bin', { units: 'm' }), grid: 'render', width: spec.n * 2, height: spec.n * 2 },
    },
    ignition: null,
    default_profile_path: [],
    fuels_edition: 'LF2024',
    data_sources: [
      { name: 'USGS 3DEP DEM', detail: '1/3 arc-second', fetched_ms: ORIGIN + 200 * HOUR },
      { name: 'LANDFIRE LF2024', detail: 'FBFM40', fetched_ms: ORIGIN + 200 * HOUR },
      { name: 'NASA FIRMS active fire detections', detail: 'VIIRS, MODIS, GOES', fetched_ms: ORIGIN + 200 * HOUR },
    ],
    stats: { final_acres_observed: 0, detections: 0, perimeters: 0 },
    forecasts: [],
    warnings: [],
    built_ms: ORIGIN + 200 * HOUR,
    ...over,
  }
}

/** A raster layer filled with `fill` (or a per-pixel function of row / col). */
export function makeLayer(name: string, n: number, fill: number | ((r: number, c: number) => number), opts: { dtype?: LayerInfo['dtype']; nodata?: number; grid?: LayerInfo['grid'] } = {}): LoadedLayer {
  const dtype = opts.dtype ?? 'float32'
  const data: RasterArray = dtype === 'uint8' ? new Uint8Array(n * n) : new Float32Array(n * n)
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) data[r * n + c] = typeof fill === 'number' ? fill : fill(r, c)
  const info: LayerInfo = { file: `${name}.bin`, grid: opts.grid ?? 'fire', dtype, width: n, height: n, description: name, ...(opts.nodata != null ? { nodata: opts.nodata } : {}) }
  return { name, url: `test://${name}`, info, data, width: n, height: n }
}

export const ready = (layer: LoadedLayer): RasterSlot => ({ status: 'ready', layer, error: null })
export const MISSING: RasterSlot = { status: 'missing', layer: null, error: null }
export const LOADING: RasterSlot = { status: 'loading', layer: null, error: null }
export const FAILED: RasterSlot = { status: 'error', layer: null, error: 'Server error (HTTP 500)' }

export function makeRasters(over: Partial<LocationRasters> = {}): LocationRasters {
  return { observedArrival: MISSING, elevation: MISSING, fuel: MISSING, burnProbability: MISSING, arrivalP10: MISSING, arrivalP50: MISSING, arrivalP90: MISSING, ...over }
}

/** WGS84 position of a fire-grid pixel centre (SPEC 4.1: e = minx + (c + .5) res, n = maxy - (r + .5) res). */
export function pixelLatLon(m: IncidentManifest, r: number, c: number, n = m.grid.fire.width): { lat: number; lon: number } {
  const res = m.grid.extent_m / n
  const e = m.grid.center_e - m.grid.extent_m / 2 + (c + 0.5) * res
  const no = m.grid.center_n + m.grid.extent_m / 2 - (r + 0.5) * res
  const [lon, lat] = utmToLonLat(e, no, m.grid.utm_zone)
  return { lat, lon }
}

/** WGS84 position of incident-local (x east, z south) metres. */
export function localLatLon(m: IncidentManifest, x: number, z: number): { lat: number; lon: number } {
  const [lon, lat] = utmToLonLat(m.grid.center_e + x, m.grid.center_n - z, m.grid.utm_zone)
  return { lat, lon }
}

export function makeForecast(m: IncidentManifest, over: Partial<ForecastManifest> = {}): ForecastManifest {
  const fl = (file: string): LayerInfo => ({ file, grid: 'fire', dtype: 'float32', width: m.grid.fire.width, height: m.grid.fire.height, description: file })
  return {
    run_id: 'fc-test-1',
    incident_id: m.id,
    status: 'ready',
    issued_ms: ORIGIN + 30 * HOUR,
    start_ms: ORIGIN + 24 * HOUR,
    horizon_h: 72,
    time_origin_ms: ORIGIN,
    model: { engine: 'pyretechnics', version: '2026.8.10', surface_lw_ratio_model: 'behave', crown: true, spotting: false, spread_adjustment: 1, grid_res_m: m.grid.fire.res_m },
    weather: { source: 'open-meteo:historical-forecast:gfs_hrrr + perturbed AR(1)', ensemble: 'perturbed', members: 31 },
    layers: {
      arrival_p10: fl('arrival_p10.bin'),
      arrival_p50: fl('arrival_p50.bin'),
      arrival_p90: fl('arrival_p90.bin'),
      burn_probability: fl('burn_probability.bin'),
      flame_length_p50: fl('flame_length_p50.bin'),
    },
    series: { t_ms: [], area_acres_p10: [], area_acres_p50: [], area_acres_p90: [], ros_ch_per_h_p50: [] },
    runtime_s: 50,
    warnings: [],
    ...over,
  }
}

/** Hourly weather from ORIGIN for `hours`, constant wind at the fire and a 4 x 4 grid of (u, v). */
export function makeWeather(m: IncidentManifest, opts: { hours?: number; speedMs?: number; fromDeg?: number; gustMs?: number; u?: number; v?: number; forecastFromMs?: number | null } = {}): WeatherFile {
  const hours = opts.hours ?? 120
  const t = Array.from({ length: hours }, (_, i) => ORIGIN + i * HOUR)
  const col = (v: number) => t.map(() => v)
  const step = m.grid.extent_m / 4
  const centres = [0, 1, 2, 3].map((i) => -m.grid.extent_m / 2 + (i + 0.5) * step)
  return {
    source: 'open-meteo:historical-forecast:gfs_hrrr',
    t_ms: t,
    at_fire: {
      temp_c: col(20),
      rh_pct: col(15),
      dewpoint_c: col(-8),
      wind_speed_ms: col(opts.speedMs ?? 8),
      wind_dir_deg: col(opts.fromDeg ?? 45),
      wind_gust_ms: col(opts.gustMs ?? 14),
      precip_mm: col(0),
      fm1_pct: col(4),
      fm10_pct: col(6),
      fm100_pct: col(9),
      ffwi: col(40),
    },
    grid: { nx: 4, ny: 4, x: centres, z: centres, u_ms: t.flatMap(() => Array(16).fill(opts.u ?? 5)), v_ms: t.flatMap(() => Array(16).fill(opts.v ?? 0)) },
    forecast_from_ms: opts.forecastFromMs ?? null,
  }
}

export function detection(m: IncidentManifest, x: number, z: number, tMs: number, over: Partial<Detection> = {}): Detection {
  const { lat, lon } = localLatLon(m, x, z)
  return { t_ms: tMs, lat, lon, x, z, frp: 20, satellite: 'N20', instrument: 'VIIRS', confidence: 'n', daynight: 'N', footprint_m: 390, ...over }
}

/** Axis-aligned square ring (local metres), closed. */
export function square(cx: number, cz: number, half: number): [number, number][] {
  return [
    [cx - half, cz - half],
    [cx + half, cz - half],
    [cx + half, cz + half],
    [cx - half, cz + half],
    [cx - half, cz - half],
  ]
}

export function perimeter(tMs: number, rings: [number, number][][], over: Partial<Perimeter> = {}): Perimeter {
  return { t_ms: tMs, acres: 988.4, source: 'NIFC WFIGS daily perimeters', rings, ...over }
}

export function input(m: IncidentManifest | null, point: SelectedLocation, over: Partial<LocationCheckInput> = {}): LocationCheckInput {
  return {
    point,
    timeMs: ORIGIN + 30 * HOUR,
    nowMs: ORIGIN + 400 * HOUR,
    summary: m?.summary ?? null,
    manifest: m,
    perimeters: [],
    detections: [],
    weather: null,
    forecast: null,
    rasters: makeRasters(),
    ...over,
  }
}

export const NEVER_H = NEVER
