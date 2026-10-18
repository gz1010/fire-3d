// Point location check (owner: location; CONTRACT §5). Pure: same input -> same report. Every value comes from real
// geometry and the original scientific grids (data/rasters.ts nearest-pixel samples in incident-local metres), never
// from the reprojected display images. Distances and directions are geodesic on WGS84 between the point and the
// nearest edge point (found in the incident's planar UTM grid, then converted back to lon/lat), so they are relative
// to true north and free of UTM scale and grid-convergence error.
//
// Model semantics (CONTRACT §5.2, backend spread/ensemble.py): burn_probability = fraction of members burned by
// start + horizon (the whole horizon, never a shorter period); arrival_pK = K-th percentile order statistic of member
// arrival times with never-reached members as +infinity, so arrival_pK <= t exactly when at least K % of members had
// reached the pixel by t; pixels inside the observed burned area at the forecast start hold the start time.
import type { Detection, ForecastManifest, IncidentManifest, Perimeter, WeatherFile } from '../api/types'
import { HOUR_MS, insideAoi, pixelAt, sampleArrival, sampleLayer, type LoadedLayer, type RasterSlot } from '../data/rasters'
import { ACRE_M2 } from '../lib/format'
import { fuelInfo } from '../lib/fuels'
import { formatLatLon, geodesicInverse, type LatLon } from '../lib/geodesy'
import { localToLonLat, lonLatToLocal } from '../lib/reproject'
import { isDemoBundle, type SelectedLocation } from '../state/workspace'
import { addressRange } from './addressStore'
import { burnedFootprint, nearestOnRings, pointInRings } from './geometry'
import type {
  AddressDetails,
  ArrivalQuantile,
  DetectionCheck,
  DrynessContext,
  EdgeRiseContext,
  ForecastCheck,
  LocationCheckInput,
  LocationRasters,
  LocationReport,
  ModelGap,
  ObservedFireCheck,
  PerimeterCheck,
  PointInfo,
  ReportSource,
  TerrainContext,
  WindContext,
  WindReading,
} from './types'

/** Satellite detections considered for "nearest detection": the hours up to the timeline time. */
export const DETECTION_WINDOW_H = 24
/** The backend's TIME_TOL_H (1e-3 h) for "arrival <= t" on float32 hour rasters. */
export const TIME_TOL_MS = 3_600
/** Wind samples are hourly; farther than this from the timeline time there is no reading. */
export const WIND_MAX_GAP_MS = 90 * 60_000
/** Points closer than this to the edge of the modeled area get the edge caveat when runs reached the edge. */
export const EDGE_NEAR_M = 2_000

type ManifestGrid = IncidentManifest['grid']

const ll = (lonLat: readonly [number, number]): LatLon => ({ lon: lonLat[0], lat: lonLat[1] })
const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v)
const norm360 = (deg: number) => ((deg % 360) + 360) % 360

function slotGap(slot: RasterSlot): ModelGap | null {
  if (slot.status === 'loading') return 'loading'
  if (slot.status === 'error') return 'error'
  if (slot.status === 'missing' || !slot.layer) return 'nodata'
  return null
}

// ------------------------------------------------------------------------------------------------- point
function locationType(p: SelectedLocation): string {
  switch (p.source) {
    case 'address': {
      if (p.adjusted) return 'Street address, pin moved by you from the interpolated Census position'
      // the card's Approximate tag leads this line; the house-number range is in the details (caveats)
      return 'Street address, interpolated (not a rooftop)'
    }
    case 'coords':
      return p.adjusted ? 'Entered coordinates · pin moved by you' : 'Entered coordinates'
    case 'click':
      return p.adjusted ? 'Point picked on the map · pin moved by you' : 'Point picked on the map'
    case 'event':
      return p.approximate ? 'Event location (estimated)' : 'Event location'
    case 'incident':
      return 'Incident reported location (where the incident was reported, not necessarily where it started)'
  }
}

function pointInfo(p: SelectedLocation, address: AddressDetails | null): PointInfo {
  return {
    lat: p.lat,
    lon: p.lon,
    label: p.label ?? p.matchedAddress ?? formatLatLon(p.lat, p.lon, 5),
    source: p.source,
    locationType: locationType(p),
    approximate: p.approximate ?? false,
    adjusted: p.adjusted ?? false,
    address,
  }
}

// ------------------------------------------------------------------------------------------------- perimeter
/** Newest perimeter with t_ms <= timeMs (perimeters.json is cumulative; order is not assumed). */
export function latestPerimeter(perimeters: readonly Perimeter[], timeMs: number): Perimeter | null {
  let best: Perimeter | null = null
  for (const p of perimeters) if (p.t_ms <= timeMs && p.rings.length && (!best || p.t_ms >= best.t_ms)) best = p
  return best
}

function perimeterCheck(input: LocationCheckInput, grid: ManifestGrid | null, local: [number, number] | null): PerimeterCheck {
  const { manifest, timeMs, nowMs, point } = input
  if (!manifest || !grid || !local) return { state: 'none', reason: 'no_bundle' }
  const [x, z] = local
  const here: LatLon = { lat: point.lat, lon: point.lon }
  const latestDetectionMs = latestDetection(input.detections, timeMs)
  const fromEdge = (nx: number, nz: number) => geodesicInverse(ll(localToLonLat(nx, nz, grid)), here)
  const mapped = latestPerimeter(input.perimeters, timeMs)
  if (mapped) {
    const near = nearestOnRings(x, z, mapped.rings)
    if (near) {
      const inside = pointInRings(x, z, mapped.rings)
      const g = fromEdge(near.x, near.z)
      const nearestLL = ll(localToLonLat(near.x, near.z, grid))
      return {
        state: 'ok',
        basis: 'mapped',
        inside,
        distanceM: inside ? 0 : g.distanceM,
        directionDeg: inside || g.distanceM < 1 ? null : g.initialBearingDeg,
        edgeDistanceM: g.distanceM,
        nearest: nearestLL,
        perimeterTimeMs: mapped.t_ms,
        perimeterSource: mapped.source,
        perimeterAcres: mapped.acres,
        ageMs: nowMs - mapped.t_ms,
        lagMs: timeMs - mapped.t_ms,
        latestDetectionMs,
      }
    }
  }
  // no mapped perimeter by this time: the burned area reconstructed from detections (+ perimeters) as an estimate
  const slot = input.rasters.observedArrival
  if (slot.status === 'loading') return { state: 'none', reason: 'loading' }
  if (slot.status === 'error') return { state: 'none', reason: 'error' }
  if (!slot.layer) return { state: 'none', reason: input.perimeters.length ? 'none_before_time' : 'no_perimeters' }
  const fp = burnedFootprint(slot.layer, grid.extent_m, x, z, (timeMs - manifest.time_origin_ms) / HOUR_MS)
  if (!fp) return { state: 'none', reason: 'none_before_time' }
  const g = fromEdge(fp.nearest.x, fp.nearest.z)
  const edge = fp.inside && fp.edge ? fromEdge(fp.edge.x, fp.edge.z) : g
  return {
    state: 'ok',
    basis: 'reconstructed',
    inside: fp.inside,
    distanceM: fp.inside ? 0 : g.distanceM,
    directionDeg: fp.inside || g.distanceM < 1 ? null : g.initialBearingDeg,
    edgeDistanceM: fp.inside ? (fp.edge ? edge.distanceM : 0) : g.distanceM,
    nearest: ll(localToLonLat(fp.inside && fp.edge ? fp.edge.x : fp.nearest.x, fp.inside && fp.edge ? fp.edge.z : fp.nearest.z, grid)),
    perimeterTimeMs: timeMs,
    perimeterSource: input.perimeters.length
      ? 'Estimated burned area, reconstructed from satellite fire detections and mapped perimeters'
      : 'Estimated burned area, reconstructed from satellite fire detections',
    perimeterAcres: fp.areaM2 / ACRE_M2,
    ageMs: nowMs - timeMs,
    lagMs: 0,
    latestDetectionMs,
  }
}

function latestDetection(dets: readonly Detection[], timeMs: number): number | null {
  let best: number | null = null
  for (const d of dets) if (d.t_ms <= timeMs && (best == null || d.t_ms > best)) best = d.t_ms
  return best
}

// ------------------------------------------------------------------------------------------------- observed fire
function observedFireCheck(input: LocationCheckInput, local: [number, number] | null, areaGap: ModelGap | null): ObservedFireCheck {
  const { manifest, rasters, timeMs } = input
  const gap = areaGap ?? slotGap(rasters.observedArrival)
  if (gap || !local || !manifest || !rasters.observedArrival.layer) return { state: 'gap', gap: gap ?? 'nodata' }
  const s = sampleArrival(rasters.observedArrival.layer, local[0], local[1], manifest.grid.extent_m, manifest.time_origin_ms)
  if (s.kind === 'arrival' && s.ms <= timeMs + TIME_TOL_MS) return { state: 'burned', arrivalMs: s.ms }
  if (s.kind === 'arrival' || s.kind === 'never') return { state: 'not_burned', asOfMs: timeMs }
  return { state: 'gap', gap: s.kind === 'outside' ? 'outside_modeled_area' : 'nodata' }
}

// ------------------------------------------------------------------------------------------------- detections
function detectionCheck(input: LocationCheckInput, local: [number, number] | null): DetectionCheck {
  const { detections, timeMs, nowMs, point } = input
  const lo = timeMs - DETECTION_WINDOW_H * HOUR_MS
  const cosLat = Math.cos((point.lat * Math.PI) / 180)
  let best: Detection | null = null
  let bestD = Number.POSITIVE_INFINITY
  let count = 0
  for (const d of detections) {
    if (d.t_ms > timeMs || d.t_ms < lo) continue
    count++
    // rank in the planar grid (or a local equirectangular approximation); report the geodesic value below
    const dd = local ? Math.hypot(d.x - local[0], d.z - local[1]) : Math.hypot((d.lon - point.lon) * cosLat, d.lat - point.lat)
    if (dd < bestD) {
      bestD = dd
      best = d
    }
  }
  if (!best) return { state: 'none', windowH: DETECTION_WINDOW_H }
  const g = geodesicInverse({ lat: point.lat, lon: point.lon }, { lat: best.lat, lon: best.lon })
  return {
    state: 'ok',
    distanceM: g.distanceM,
    directionDeg: g.initialBearingDeg,
    tMs: best.t_ms,
    instrument: best.instrument,
    satellite: best.satellite,
    footprintM: best.footprint_m,
    ageMs: nowMs - best.t_ms,
    windowH: DETECTION_WINDOW_H,
    count,
  }
}

// ------------------------------------------------------------------------------------------------- forecast
function quantile(slot: RasterSlot, x: number, z: number, extent: number, f: ForecastManifest): ArrivalQuantile {
  if (slot.status !== 'ready' || !slot.layer) return { state: 'nodata' }
  const s = sampleArrival(slot.layer, x, z, extent, f.time_origin_ms)
  if (s.kind === 'never') return { state: 'not_reached' }
  if (s.kind !== 'arrival') return { state: 'nodata' }
  return { state: 'time', ms: s.ms, atStart: s.ms <= f.start_ms + TIME_TOL_MS }
}

/** Largest K with arrival_pK <= t (exact: at least K % of members had reached the point by t); 0 when fewer than
 *  10 %; null outside the forecast period or when a quantile has no value. */
export function reachedShare(arrival: { p10: ArrivalQuantile; p50: ArrivalQuantile; p90: ArrivalQuantile }, timeMs: number, startMs: number, endMs: number): 0 | 10 | 50 | 90 | null {
  if (timeMs < startMs - TIME_TOL_MS || timeMs > endMs + TIME_TOL_MS) return null
  const qs = [
    [90, arrival.p90],
    [50, arrival.p50],
    [10, arrival.p10],
  ] as const
  if (qs.some(([, q]) => q.state === 'nodata')) return null
  for (const [k, q] of qs) if (q.state === 'time' && q.ms <= timeMs + TIME_TOL_MS) return k
  return 0
}

const RELEVANT_WARNING = /boundary|edge of the|beyond it|downsampled|coarse/i

function forecastCheck(input: LocationCheckInput, local: [number, number] | null, areaGap: ModelGap | null): ForecastCheck {
  if (areaGap) return { state: 'gap', gap: areaGap }
  const { forecast: f, manifest, rasters, timeMs } = input
  if (!f || !manifest || !local) return { state: 'gap', gap: 'no_forecast' }
  if (f.incident_id !== manifest.id) return { state: 'gap', gap: 'loading' } // store switching incidents
  if (f.status !== 'ready') return { state: 'gap', gap: 'no_forecast' }
  const slots = [rasters.burnProbability, rasters.arrivalP10, rasters.arrivalP50, rasters.arrivalP90]
  if (slots.some((s) => s.status === 'loading')) return { state: 'gap', gap: 'loading' }
  if (rasters.burnProbability.status === 'error') return { state: 'gap', gap: 'error' }
  const [x, z] = local
  const ext = manifest.grid.extent_m
  const bpL = rasters.burnProbability.status === 'ready' ? rasters.burnProbability.layer : null
  const bpS = bpL ? sampleLayer(bpL, x, z, ext) : null
  const burnProbability = bpS?.kind === 'value' && Number.isFinite(bpS.value) ? { state: 'value' as const, fraction: Math.min(1, Math.max(0, bpS.value)) } : { state: 'nodata' as const }
  const members = f.weather.members
  let burnedMembers: number | null = null
  if (burnProbability.state === 'value' && members > 0) {
    const n = burnProbability.fraction * members
    if (Math.abs(n - Math.round(n)) < 1e-3) burnedMembers = Math.round(n)
  }
  const arrival = {
    p10: quantile(rasters.arrivalP10, x, z, ext, f),
    p50: quantile(rasters.arrivalP50, x, z, ext, f),
    p90: quantile(rasters.arrivalP90, x, z, ext, f),
  }
  const endMs = f.start_ms + f.horizon_h * HOUR_MS
  const burnedAtStart = [arrival.p10, arrival.p50, arrival.p90].every((q) => q.state === 'time' && q.atStart)
  if (burnProbability.state === 'nodata' && [arrival.p10, arrival.p50, arrival.p90].every((q) => q.state === 'nodata')) return { state: 'gap', gap: 'nodata' }
  return {
    state: 'ok',
    runId: f.run_id,
    issuedMs: f.issued_ms,
    startMs: f.start_ms,
    endMs,
    horizonH: f.horizon_h,
    members,
    ensemble: f.weather.ensemble,
    burnProbability,
    burnedMembers,
    arrival,
    reachedShareAtTime: reachedShare(arrival, timeMs, f.start_ms, endMs),
    burnedAtStart,
    hindcast: manifest.mode === 'historical',
    model: { engine: f.model.engine, version: f.model.version, crown: f.model.crown, spotting: f.model.spotting, gridResM: f.model.grid_res_m },
    weatherSource: f.weather.source,
    warnings: f.warnings.filter((w) => RELEVANT_WARNING.test(w)),
  }
}

// ------------------------------------------------------------------------------------------------- wind
function nearestIndex(ts: readonly number[], t: number): number {
  let lo = 0
  let hi = ts.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ts[mid] <= t) lo = mid
    else hi = mid
  }
  return Math.abs(ts[hi] - t) < Math.abs(ts[lo] - t) ? hi : lo
}

/** Wind of the weather-grid cell nearest local (x, z) at hour index i: u east+, v north+ (the direction the air
 *  moves TO) -> speed and meteorological FROM direction. */
export function gridWindAt(weather: WeatherFile, i: number, x: number, z: number): (WindReading & { cellSizeM: number }) | null {
  const g = weather.grid
  if (!g || !g.x?.length || !g.z?.length) return null
  const nearest = (arr: readonly number[], v: number) => arr.reduce((b, a, k) => (Math.abs(a - v) < Math.abs(arr[b] - v) ? k : b), 0)
  const ci = nearest(g.x, x)
  const rj = nearest(g.z, z)
  const k = i * g.nx * g.ny + rj * g.nx + ci
  const u = g.u_ms[k]
  const v = g.v_ms[k]
  if (!finite(u) || !finite(v)) return null
  const cellSizeM = g.x.length > 1 ? Math.abs(g.x[1] - g.x[0]) : 0
  return { speedMs: Math.hypot(u, v), fromDeg: norm360((Math.atan2(-u, -v) * 180) / Math.PI), cellSizeM }
}

function windContext(weather: WeatherFile | null, timeMs: number, local: [number, number] | null, inside: boolean): WindContext {
  if (!weather || !weather.t_ms?.length) return { state: 'none' }
  const i = nearestIndex(weather.t_ms, timeMs)
  const tMs = weather.t_ms[i]
  if (Math.abs(tMs - timeMs) > WIND_MAX_GAP_MS) return { state: 'none' }
  const af = weather.at_fire
  const sp = af?.wind_speed_ms?.[i]
  const dir = af?.wind_dir_deg?.[i]
  const gust = af?.wind_gust_ms?.[i]
  const atPoint = inside && local ? gridWindAt(weather, i, local[0], local[1]) : null
  const isForecast = weather.forecast_from_ms != null && tMs >= weather.forecast_from_ms
  if (finite(sp) && finite(dir)) return { state: 'ok', tMs, speedMs: sp, gustMs: finite(gust) ? gust : null, fromDeg: norm360(dir), isForecast, source: weather.source, where: 'fire', atPoint }
  if (atPoint) return { state: 'ok', tMs, speedMs: atPoint.speedMs, gustMs: null, fromDeg: atPoint.fromDeg, isForecast, source: weather.source, where: 'point', atPoint }
  return { state: 'none' }
}

/** Humidity and 1-h dead fuel moisture at the fire for the same hour as the wind reading (none without one). */
function drynessContext(weather: WeatherFile | null, timeMs: number): DrynessContext {
  if (!weather || !weather.t_ms?.length) return { state: 'none' }
  const i = nearestIndex(weather.t_ms, timeMs)
  const tMs = weather.t_ms[i]
  if (Math.abs(tMs - timeMs) > WIND_MAX_GAP_MS) return { state: 'none' }
  const rh = weather.at_fire?.rh_pct?.[i]
  const fm1 = weather.at_fire?.fm1_pct?.[i]
  if (!finite(rh) && !finite(fm1)) return { state: 'none' }
  const isForecast = weather.forecast_from_ms != null && tMs >= weather.forecast_from_ms
  return { state: 'ok', tMs, rhPct: finite(rh) ? rh : null, fm1Pct: finite(fm1) ? fm1 : null, isForecast, source: weather.source }
}

// ------------------------------------------------------------------------------------------------- terrain
/** Slope (%) and downslope aspect (degrees from true north) from the elevation grid's neighbouring pixels (central
 *  differences on the stored values, one-sided at the AOI edge). Aspect is null on ground flatter than 1 %. */
export function slopeAspect(layer: LoadedLayer, x: number, z: number, grid: Pick<ManifestGrid, 'extent_m' | 'center_e' | 'center_n' | 'utm_zone'>): { slopePct: number; aspectDeg: number | null } | null {
  const { width: w, height: h, data } = layer
  const ext = grid.extent_m
  const px = pixelAt(x, z, ext, w, h)
  if (!px) return null
  const nd = layer.info.nodata
  const at = (r: number, c: number) => {
    const v = data[r * w + c]
    return Number.isFinite(v) && (nd == null || v !== nd) ? v : Number.NaN
  }
  const cW = Math.max(0, px.col - 1)
  const cE = Math.min(w - 1, px.col + 1)
  const rN = Math.max(0, px.row - 1)
  const rS = Math.min(h - 1, px.row + 1)
  if (cE === cW || rS === rN) return null
  const dEdx = (at(px.row, cE) - at(px.row, cW)) / (((cE - cW) * ext) / w) // per metre east
  const dEdS = (at(rS, px.col) - at(rN, px.col)) / (((rS - rN) * ext) / h) // per metre south (rows run north -> south)
  if (!Number.isFinite(dEdx) || !Number.isFinite(dEdS)) return null
  const dEdN = -dEdS
  const slope = Math.hypot(dEdx, dEdN)
  const slopePct = slope * 100
  if (slopePct < 1) return { slopePct, aspectDeg: null }
  // downslope unit vector (east, north) in the UTM grid; its true bearing via two WGS84 points 50 m apart
  const ue = -dEdx / slope
  const un = -dEdN / slope
  const a = ll(localToLonLat(x, z, grid))
  const b = ll(localToLonLat(x + ue * 50, z - un * 50, grid))
  return { slopePct, aspectDeg: geodesicInverse(a, b).initialBearingDeg }
}

function terrainContext(rasters: LocationRasters, local: [number, number] | null, grid: ManifestGrid | null, areaGap: ModelGap | null): TerrainContext {
  if (areaGap) return { state: 'gap', gap: areaGap }
  if (!local || !grid) return { state: 'gap', gap: 'no_bundle' }
  const el = rasters.elevation.status === 'ready' ? rasters.elevation.layer : null
  const fu = rasters.fuel.status === 'ready' ? rasters.fuel.layer : null
  if (!el && !fu) return { state: 'gap', gap: slotGap(rasters.elevation) ?? slotGap(rasters.fuel) ?? 'nodata' }
  const [x, z] = local
  let elevationM: number | null = null
  let slopePct: number | null = null
  let aspectDeg: number | null = null
  if (el) {
    const s = sampleLayer(el, x, z, grid.extent_m)
    if (s.kind === 'value') {
      elevationM = s.value
      const sa = slopeAspect(el, x, z, grid)
      slopePct = sa?.slopePct ?? null
      aspectDeg = sa?.aspectDeg ?? null
    }
  }
  let fuelCode: number | null = null
  let fuelLabel: string | null = null
  let fuelName: string | null = null
  let burnable: boolean | null = null
  if (fu) {
    const s = sampleLayer(fu, x, z, grid.extent_m)
    if (s.kind === 'value' && s.value !== 0) {
      const info = fuelInfo(s.value)
      fuelCode = s.value
      fuelLabel = info.label
      fuelName = info.name
      burnable = info.burnable
    }
  }
  if (elevationM == null && fuelCode == null) return { state: 'gap', gap: 'nodata' }
  return { state: 'ok', elevationM, slopePct, aspectDeg, fuelCode, fuelLabel, fuelName, burnable }
}

/** Ground at the point versus at the nearest fire edge point (both sampled from the elevation model). */
function edgeRiseContext(perimeter: PerimeterCheck, rasters: LocationRasters, local: [number, number] | null, grid: ManifestGrid | null, areaGap: ModelGap | null): EdgeRiseContext {
  if (perimeter.state !== 'ok') return { state: 'none', reason: 'no_edge' }
  if (perimeter.inside) return { state: 'none', reason: 'inside' }
  if (areaGap || !local || !grid) return { state: 'none', reason: 'outside_modeled_area' }
  const el = rasters.elevation.status === 'ready' ? rasters.elevation.layer : null
  if (!el) return { state: 'none', reason: 'no_elevation' }
  const edge = lonLatToLocal(perimeter.nearest.lon, perimeter.nearest.lat, grid)
  if (!insideAoi(edge[0], edge[1], grid.extent_m)) return { state: 'none', reason: 'outside_modeled_area' }
  const a = sampleLayer(el, local[0], local[1], grid.extent_m)
  const b = sampleLayer(el, edge[0], edge[1], grid.extent_m)
  if (a.kind !== 'value' || b.kind !== 'value' || !Number.isFinite(a.value) || !Number.isFinite(b.value)) return { state: 'none', reason: 'no_elevation' }
  return { state: 'ok', pointElevM: a.value, edgeElevM: b.value, riseM: a.value - b.value, distanceM: perimeter.distanceM }
}

// ------------------------------------------------------------------------------------------------- sources, caveats
function dataSource(manifest: IncidentManifest | null, re: RegExp) {
  return manifest?.data_sources.find((d) => re.test(d.name)) ?? null
}

function sourcesFor(input: LocationCheckInput, r: Omit<LocationReport, 'sources' | 'caveats'>): ReportSource[] {
  const { manifest } = input
  const out: ReportSource[] = []
  const p = r.perimeter
  if (p.state === 'ok' && p.basis === 'mapped') out.push({ name: p.perimeterSource, kind: 'official', timeMs: p.perimeterTimeMs, detail: 'Mapped fire perimeter (agency data)' })
  if ((p.state === 'ok' && p.basis === 'reconstructed') || r.observedFire.state !== 'gap')
    out.push({ name: 'Fire-3d burned-area reconstruction', kind: 'estimate', timeMs: manifest?.built_ms ?? null, detail: 'Arrival times estimated from satellite detections (and mapped perimeters where available)' })
  const det = dataSource(manifest, /FIRMS|detection|Fire observations/i)
  if (r.nearestDetection.state === 'ok' || det)
    out.push({ name: det?.name ?? 'NASA FIRMS active fire detections', kind: 'observation', timeMs: r.nearestDetection.state === 'ok' ? r.nearestDetection.tMs : (p.state === 'ok' ? p.latestDetectionMs : null), detail: det?.detail ?? null })
  const f = r.forecast
  if (f.state === 'ok')
    out.push({ name: `Fire-3d spread model (${f.model.engine} ${f.model.version})`, kind: 'model', timeMs: f.issuedMs, detail: `Run ${f.runId}: ${f.members} runs, weather ${f.weatherSource}` })
  if (r.wind.state === 'ok') out.push({ name: `Weather model data (${r.wind.source})`, kind: 'model', timeMs: r.wind.tMs, detail: r.wind.isForecast ? 'Forecast hour' : 'Analysis / archived forecast hour' })
  if (r.terrain.state === 'ok') {
    const dem = dataSource(manifest, /3DEP|DEM|Terrain/i)
    const fuels = dataSource(manifest, /LANDFIRE|Fuels/i)
    if (r.terrain.elevationM != null) out.push({ name: dem?.name ?? 'Elevation model', kind: 'reference', timeMs: dem?.fetched_ms ?? null, detail: dem?.detail ?? null })
    if (r.terrain.fuelCode != null) out.push({ name: fuels?.name ?? `LANDFIRE ${manifest?.fuels_edition ?? ''} fuels`.trim(), kind: 'reference', timeMs: fuels?.fetched_ms ?? null, detail: 'Fuel model (FBFM40)' })
  }
  const a = r.point.address
  if (r.point.source === 'address') out.push({ name: `${a?.source ?? 'U.S. Census Bureau Geocoder'}${a?.benchmark ? ` (${a.benchmark})` : ''}`, kind: 'reference', timeMs: a?.fetchedMs ?? null, detail: 'Address position interpolated along the street address range' })
  return out
}

function caveatsFor(input: LocationCheckInput, r: Omit<LocationReport, 'sources' | 'caveats'>): string[] {
  const out: string[] = []
  if (isDemoBundle(input.manifest?.id ?? input.summary?.id, input.manifest)) out.push('Demo bundle with simulated data: this is not a real fire.')
  if (r.modeledArea === 'outside')
    out.push('Outside the modeled area: Fire-3d models only the incident’s analysis area, so the forecast and fire reconstruction say nothing about this spot. Its risk is unknown, not low.')
  if (r.point.source === 'address' && !r.point.adjusted) {
    const range = addressRange(r.point.address?.fromAddress, r.point.address?.toAddress)
    out.push(`The address position is interpolated along ${range ? `house numbers ${range} of the street` : 'the street’s address range'} by the U.S. Census Bureau Geocoder; it is approximate, not a rooftop location. Drag the pin to correct it.`)
  }
  if (r.perimeter.state === 'ok' && r.perimeter.basis === 'reconstructed')
    out.push('No mapped perimeter exists for this time, so the burned area is an estimate reconstructed from satellite detections.')
  if (r.observedFire.state !== 'gap') out.push('Burn times at this spot are estimates interpolated between satellite passes and mapped perimeters.')
  if (r.nearestDetection.state === 'ok') out.push('A satellite detection marks a hot pixel (hundreds of metres to kilometres wide); it is not the exact fire edge.')
  const f = r.forecast
  if (f.state === 'ok') {
    out.push(
      `Forecast numbers describe ${f.members} model runs (an ensemble with varied weather) of an experimental research model. They are not an official forecast or evacuation instruction; follow official orders.`,
    )
    if (!f.model.spotting) out.push('The model does not simulate ember spotting, and firefighting is not modeled, so real spread can differ.')
    if (f.warnings.some((w) => /boundary|edge of the|beyond it/i.test(w)) && r.edgeDistanceM != null && r.edgeDistanceM < EDGE_NEAR_M)
      out.push('This spot is near the edge of the modeled area, where model runs were cut off: burn chances here are underestimated.')
  }
  if (r.modeledArea !== 'no_bundle') out.push('One point check does not establish the safety of a route or an area.')
  return out
}

// ------------------------------------------------------------------------------------------------- report
export function checkLocation(input: LocationCheckInput): LocationReport {
  const { point, manifest, timeMs, nowMs } = input
  const grid = manifest?.grid ?? null
  const local = grid ? lonLatToLocal(point.lon, point.lat, grid) : null
  const extent = grid?.extent_m ?? 0
  const modeledArea: LocationReport['modeledArea'] = !manifest || !local ? 'no_bundle' : insideAoi(local[0], local[1], extent) ? 'inside' : 'outside'
  const areaGap: ModelGap | null = modeledArea === 'no_bundle' ? 'no_bundle' : modeledArea === 'outside' ? 'outside_modeled_area' : null
  const address = input.address && point.source === 'address' ? input.address : null
  const edgeDistanceM = modeledArea === 'inside' && local ? Math.min(extent / 2 - Math.abs(local[0]), extent / 2 - Math.abs(local[1])) : null
  const perimeter = perimeterCheck(input, grid, local)
  const base: Omit<LocationReport, 'sources' | 'caveats'> = {
    point: pointInfo(point, address),
    modeledArea,
    local: local ? { x: local[0], z: local[1] } : null,
    edgeDistanceM,
    perimeter,
    observedFire: observedFireCheck(input, local, areaGap),
    nearestDetection: detectionCheck(input, local),
    forecast: forecastCheck(input, local, areaGap),
    wind: windContext(input.weather, timeMs, local, modeledArea === 'inside'),
    terrain: terrainContext(input.rasters, local, grid, areaGap),
    dryness: drynessContext(input.weather, timeMs),
    edgeRise: edgeRiseContext(perimeter, input.rasters, local, grid, areaGap),
    latestObservationMs: manifest?.time_range?.now_ms ?? null,
    timeMs,
    computedAtMs: nowMs,
  }
  return { ...base, sources: sourcesFor(input, base), caveats: caveatsFor(input, base) }
}
