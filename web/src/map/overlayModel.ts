// What the wildfire overlays show at a timeline time (owner: map-core). Pure functions over the stored scientific
// arrays (data/rasters.ts); MapView only draws the results. Model semantics follow CONTRACT §5.2 exactly:
//   observed fire  observed_arrival <= t (reconstructed from perimeters and satellite detections). NEVER and nodata are
//                  never "burned".
//   forecast       share classes ">= K % of the model runs had burned this spot by X", K = 10, 50, 90, read from
//                  arrival_pK <= X (exact: the rasters are order statistics of rank ceil(K/100 · n)) when X is the
//                  timeline time, or from burn_probability >= K/100 when X is the end of the horizon. Nothing is
//                  interpolated between quantiles; spots reached by fewer than 10 % of runs are not shaded.
// Colours mirror styles/map-tokens.css (MapLibre paint and canvas pixels cannot read CSS variables).
import type { Detection, ForecastManifest, IncidentManifest, Perimeter } from '../api/types'
import { HOUR_MS, NEVER_MIN } from '../data/rasters'
import { localToLonLat, type LonLat, type UtmGrid } from '../lib/reproject'
import { fmtAt, type TimeFmt } from '../lib/time'

/** --m-* tokens used by map paint (keep equal to styles/map-tokens.css). */
export const TOKENS = {
  select: '#22d3ee',
  selectStrong: '#67e8f9',
  fireObserved: '#ff5a1f',
  fireObservedGlow: 'rgba(255,106,43,0.55)',
  fireFront: '#ffb066',
  perimeter: '#ff7849',
  perimeterOld: 'rgba(255,120,73,0.45)',
  forecast: '#f5a524',
  forecastHatch: 'rgba(245,165,36,0.6)',
  detection: '#ffd84a',
  detectionStroke: '#6b1f00',
  detectionOld: '#c27a3a',
  aoi: 'rgba(232,237,243,0.55)',
  event: '#f0f4f8',
  text: '#e8edf3',
  textInverse: '#0b1119',
  bg: '#0b1119',
} as const

/** Hours before the timeline time that count as "recently burned" (brighter fill). */
export const RECENT_H = 6
/** Polar-orbiter / Landsat detections older than this (relative to the timeline time) are hidden. */
export const DETECTION_WINDOW_H = 24
/** Age classes of those detections: up to 12 h ("recent"), 12-24 h. */
export const DETECTION_RECENT_H = 12
/** GOES (geostationary, ~2 km pixels, every 5-10 min) shows only its last passes, as outlines (like Forensic). */
export const GOES_WINDOW_H = 1.5
export const SHARE_LEVELS = [10, 50, 90] as const

// ------------------------------------------------------------------------------------------------- pixels
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d

/** One RGBA pixel (straight alpha 0..1) packed for a Uint32Array view of ImageData. */
export function rgba(r: number, g: number, b: number, a: number): number {
  const A = Math.round(Math.min(1, Math.max(0, a)) * 255)
  return LITTLE_ENDIAN ? ((A << 24) | (b << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (b << 8) | A) >>> 0
}

export const OBSERVED_RGBA = {
  burned: rgba(150, 36, 16, 0.45), // --m-fire-observed-fill
  recent: rgba(255, 90, 31, 0.62),
} as const

/** Forecast class tints: index 1 = 10-50 %, 2 = 50-90 %, 3 = >= 90 % of model runs. */
export const FORECAST_RGBA = [0, rgba(245, 165, 36, 0.14), rgba(245, 165, 36, 0.26), rgba(240, 130, 30, 0.4)] as const

const isNodata = (v: number, nodata: number | null | undefined) => Number.isNaN(v) || (nodata !== undefined && nodata !== null && v === nodata)

export interface ObservedCounts {
  burned: number
  recent: number
}

/** Observed fire at tH (hours since manifest.time_origin_ms): per-pixel colours and the burned mask (1 = burned). */
export function observedPixels(
  arr: ArrayLike<number>,
  nodata: number | null | undefined,
  tH: number,
  colors: Uint32Array,
  mask: Uint8Array,
  recentH = RECENT_H,
): ObservedCounts {
  let burned = 0
  let recent = 0
  const recentFrom = tH - recentH
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i]
    if (a <= tH && a < NEVER_MIN && !isNodata(a, nodata)) {
      mask[i] = 1
      burned++
      if (a > recentFrom) {
        colors[i] = OBSERVED_RGBA.recent
        recent++
      } else colors[i] = OBSERVED_RGBA.burned
    } else {
      mask[i] = 0
      colors[i] = 0
    }
  }
  return { burned, recent }
}

/** Mask of pixels observed burned by tH (e.g. the forecast start). */
export function burnedByMask(arr: ArrayLike<number>, nodata: number | null | undefined, tH: number, mask: Uint8Array): number {
  let n = 0
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i]
    const b = a <= tH && a < NEVER_MIN && !isNodata(a, nodata)
    mask[i] = b ? 1 : 0
    if (b) n++
  }
  return n
}

// ------------------------------------------------------------------------------------------------- forecast
/** auto: the full-horizon chance before the forecast starts, the spread by the timeline time once inside it. */
export type ForecastView = 'auto' | 'time' | 'horizon'

export interface ForecastFrame {
  /** time = share of runs that had reached each spot by byMs (arrival quantiles); horizon = by the end of the forecast
   *  (burn_probability); before-start = the timeline is before the forecast period (nothing modeled yet). */
  kind: 'time' | 'horizon' | 'before-start'
  byMs: number
  startMs: number
  endMs: number
  /** The timeline time is past the end of the horizon (classes shown as of the end). */
  clamped: boolean
}

export function forecastEndMs(f: Pick<ForecastManifest, 'start_ms' | 'horizon_h'>): number {
  return f.start_ms + f.horizon_h * HOUR_MS
}

export function forecastFrame(f: Pick<ForecastManifest, 'start_ms' | 'horizon_h'>, tMs: number, view: ForecastView): ForecastFrame {
  const startMs = f.start_ms
  const endMs = forecastEndMs(f)
  const base = { startMs, endMs }
  if (view === 'horizon' || (view === 'auto' && tMs < startMs + 60_000)) return { ...base, kind: 'horizon', byMs: endMs, clamped: false }
  if (tMs < startMs) return { ...base, kind: 'before-start', byMs: startMs, clamped: false }
  return { ...base, kind: 'time', byMs: Math.min(tMs, endMs), clamped: tMs > endMs }
}

export interface ForecastArrays {
  p10: { data: ArrayLike<number>; nodata?: number | null } | null
  p50: { data: ArrayLike<number>; nodata?: number | null } | null
  p90: { data: ArrayLike<number>; nodata?: number | null } | null
  prob: { data: ArrayLike<number>; nodata?: number | null } | null
}

/** float32 storage of k/n: compare with a margin far below 1/n so that e.g. 0.9 stored as 0.89999998 counts as 90 %. */
const PROB_EPS = 1e-6

/** Class per pixel: 0 = none / fewer than 10 % of runs, 1 = >= 10 %, 2 = >= 50 %, 3 = >= 90 % of runs burned by
 *  frame.byMs. Returns the pixel count per class (index 0..3) or null when the needed rasters are missing. */
export function forecastClasses(frame: ForecastFrame, a: ForecastArrays, forecastOriginMs: number, out: Uint8Array): number[] | null {
  const counts = [0, 0, 0, 0]
  if (frame.kind === 'before-start') {
    out.fill(0)
    counts[0] = out.length
    return counts
  }
  if (frame.kind === 'horizon') {
    const p = a.prob
    if (!p) return null
    for (let i = 0; i < out.length; i++) {
      const v = p.data[i]
      let c = 0
      if (!isNodata(v, p.nodata)) c = v >= 0.9 - PROB_EPS ? 3 : v >= 0.5 - PROB_EPS ? 2 : v >= 0.1 - PROB_EPS ? 1 : 0
      out[i] = c
      counts[c]++
    }
    return counts
  }
  const { p10, p50, p90 } = a
  if (!p10 || !p50 || !p90) return null
  const tH = (frame.byMs - forecastOriginMs) / HOUR_MS
  for (let i = 0; i < out.length; i++) {
    let c = 0
    const v90 = p90.data[i]
    if (v90 <= tH && !isNodata(v90, p90.nodata)) c = 3
    else {
      const v50 = p50.data[i]
      if (v50 <= tH && !isNodata(v50, p50.nodata)) c = 2
      else {
        const v10 = p10.data[i]
        if (v10 <= tH && !isNodata(v10, p10.nodata)) c = 1
      }
    }
    out[i] = c
    counts[c]++
  }
  return counts
}

/** Tints per pixel; pixels already observed burned when the forecast starts stay clear (the observed fill shows). */
export function forecastPixels(classes: Uint8Array, startBurned: Uint8Array | null, colors: Uint32Array): void {
  for (let i = 0; i < classes.length; i++) colors[i] = startBurned && startBurned[i] ? 0 : FORECAST_RGBA[classes[i]]
}

/** Mask of pixels with class >= minClass, optionally excluding `exclude` (1 = excluded). */
export function classMask(classes: Uint8Array, minClass: number, exclude: Uint8Array | null, out: Uint8Array): number {
  let n = 0
  for (let i = 0; i < classes.length; i++) {
    const v = classes[i] >= minClass && !(exclude && exclude[i]) ? 1 : 0
    out[i] = v
    n += v
  }
  return n
}

// ------------------------------------------------------------------------------------------------- vectors
type Props = Record<string, string | number | boolean | null>
export interface Feature<G> {
  type: 'Feature'
  id?: number
  geometry: G
  properties: Props
}
export interface FeatureCollection<G = Geometry> {
  type: 'FeatureCollection'
  features: Feature<G>[]
}
export type Geometry =
  | { type: 'Point'; coordinates: LonLat }
  | { type: 'LineString'; coordinates: LonLat[] }
  | { type: 'MultiLineString'; coordinates: LonLat[][] }
  | { type: 'Polygon'; coordinates: LonLat[][] }
  | { type: 'MultiPolygon'; coordinates: LonLat[][][] }

export const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

export function lines(rings: LonLat[][], props: Props = {}): FeatureCollection {
  return rings.length ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: rings }, properties: props }] } : EMPTY
}

export function polygons(polys: LonLat[][][], props: Props = {}): FeatureCollection {
  return polys.length ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: polys }, properties: props }] } : EMPTY
}

const ringCache = new WeakMap<Perimeter, LonLat[][]>()

function perimeterRings(p: Perimeter, grid: UtmGrid): LonLat[][] {
  let r = ringCache.get(p)
  if (!r) {
    r = p.rings.filter((ring) => ring.length >= 2).map((ring) => {
      const out = ring.map(([x, z]) => localToLonLat(x, z, grid))
      const [a, b] = [out[0], out[out.length - 1]]
      if (a[0] !== b[0] || a[1] !== b[1]) out.push(a)
      return out
    })
    ringCache.set(p, r)
  }
  return r
}

/** Agency perimeters published by tMs: the latest flagged `latest`, each labelled with its time (in `tf`: the fire's
 *  zone and the preset's clock), acres and source. */
export function perimeterFeatures(perimeters: readonly Perimeter[], grid: UtmGrid, tMs: number, tf: TimeFmt): { fc: FeatureCollection; latest: Perimeter | null } {
  const shown = perimeters.filter((p) => p.t_ms <= tMs).sort((a, b) => a.t_ms - b.t_ms)
  const latest = shown.length ? shown[shown.length - 1] : null
  const features: Feature<Geometry>[] = shown.map((p, i) => ({
    type: 'Feature',
    id: i,
    geometry: { type: 'MultiLineString', coordinates: perimeterRings(p, grid) },
    properties: {
      t: p.t_ms,
      latest: p === latest,
      label: `Perimeter ${fmtAt(p.t_ms, tf, { zone: true })} · ${Math.round(p.acres).toLocaleString('en-US')} ac`,
      source: p.source,
    },
  }))
  return { fc: { type: 'FeatureCollection', features }, latest }
}

const footprintCache = new WeakMap<Detection, LonLat[]>()

/** Fallback footprint when a row has none (VIIRS 375 m, MODIS 1 km, GOES 2 km, Landsat 30 m). */
export function footprintM(d: Pick<Detection, 'footprint_m' | 'instrument'>): number {
  if (d.footprint_m > 0) return d.footprint_m
  return d.instrument === 'MODIS' ? 1000 : d.instrument === 'GOES' ? 2000 : d.instrument === 'LANDSAT' ? 30 : 375
}

function footprint(d: Detection, grid: UtmGrid): LonLat[] {
  let f = footprintCache.get(d)
  if (!f) {
    const h = footprintM(d) / 2
    f = [
      localToLonLat(d.x - h, d.z - h, grid),
      localToLonLat(d.x + h, d.z - h, grid),
      localToLonLat(d.x + h, d.z + h, grid),
      localToLonLat(d.x - h, d.z + h, grid),
    ]
    f = [f[0], f[3], f[2], f[1], f[0]] // counter-clockwise in lon/lat (north up)
    footprintCache.set(d, f)
  }
  return f
}

/** Detections as true-size footprint squares (the sensor pixel, not a fire front) with an age class:
 *  0 = VIIRS / MODIS / Landsat in the last 12 h, 1 = those 12-24 h old, 2 = GOES in the last 1.5 h (coarse). */
export function detectionFeatures(
  detections: readonly Detection[],
  grid: UtmGrid,
  tMs: number,
): { fc: FeatureCollection; points: FeatureCollection; counts: [number, number, number] } {
  const counts: [number, number, number] = [0, 0, 0]
  const features: Feature<Geometry>[] = []
  const points: Feature<Geometry>[] = []
  detections.forEach((d, i) => {
    if (d.t_ms > tMs) return
    const ageH = (tMs - d.t_ms) / HOUR_MS
    let age: number
    if (d.instrument === 'GOES') {
      if (ageH > GOES_WINDOW_H) return
      age = 2
    } else {
      if (ageH > DETECTION_WINDOW_H) return
      age = ageH <= DETECTION_RECENT_H ? 0 : 1
    }
    counts[age]++
    const properties = { t: d.t_ms, age, inst: d.instrument, sat: d.satellite, fp: footprintM(d), frp: d.frp, conf: d.confidence, dn: d.daynight }
    features.push({ type: 'Feature', id: i, geometry: { type: 'Polygon', coordinates: [footprint(d, grid)] }, properties })
    points.push({ type: 'Feature', id: i, geometry: { type: 'Point', coordinates: localToLonLat(d.x, d.z, grid) }, properties })
  })
  // newest drawn last (on top)
  const byTime = (a: Feature<Geometry>, b: Feature<Geometry>) => (a.properties.t as number) - (b.properties.t as number)
  features.sort(byTime)
  points.sort(byTime)
  return { fc: { type: 'FeatureCollection', features }, points: { type: 'FeatureCollection', features: points }, counts }
}

/** The modeled area's boundary (true UTM square) and the "Outside modeled area" label points just outside each edge. */
export function aoiFeatures(manifest: Pick<IncidentManifest, 'grid'>): { outline: FeatureCollection; labels: FeatureCollection } {
  const g = manifest.grid
  const h = g.extent_m / 2
  const per = 16
  const ring: LonLat[] = []
  const corners: [number, number][] = [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ]
  for (let k = 0; k < 4; k++) {
    const [ax, az] = corners[k]
    const [bx, bz] = corners[(k + 1) % 4]
    for (let s = 0; s < per; s++) ring.push(localToLonLat(ax + ((bx - ax) * s) / per, az + ((bz - az) * s) / per, g))
  }
  ring.push(ring[0])
  // one label anchor per edge (its midpoint); `side` tells the layer which way "outside" is
  const pt = (x: number, z: number, side: string): Feature<Geometry> => ({ type: 'Feature', geometry: { type: 'Point', coordinates: localToLonLat(x, z, g) }, properties: { side } })
  const labels: Feature<Geometry>[] = [pt(0, -h, 'n'), pt(0, h, 's'), pt(-h, 0, 'w'), pt(h, 0, 'e')]
  return {
    outline: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: {} }] },
    labels: { type: 'FeatureCollection', features: labels },
  }
}

export interface MapEvent {
  id: string
  title: string
  tMs: number
  lon: number
  lat: number
  kind: string
  confidence: string | null
}

/** Geolocated events that have happened by tMs (later ones appear when the timeline reaches them). */
export function eventFeatures(events: readonly MapEvent[], tMs: number, selectedId: string | null): FeatureCollection {
  const features: Feature<Geometry>[] = events
    .filter((e) => e.tMs <= tMs)
    .map((e, i) => ({
      type: 'Feature',
      id: i,
      geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
      properties: { eid: e.id, title: e.title, kind: e.kind, conf: e.confidence, selected: e.id === selectedId, t: e.tMs },
    }))
  return { type: 'FeatureCollection', features }
}
