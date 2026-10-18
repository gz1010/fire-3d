// Small lon/lat geometry for official areas (owner: official-web): point in polygon, distances between a point or a
// ring and a polygon (km, local equirectangular approximation: fine for the tens of km used here), polygon overlap and
// bounds. Pure, tested in geo.test.ts.
import type { GeoPolygon } from './types'

export type LonLat = [number, number]
export type BBox = [number, number, number, number]

const KM_PER_DEG_LAT = 110.574
const KM_PER_DEG_LON_EQ = 111.32

/** Outer rings + holes of a Polygon / MultiPolygon as a list of polygons (each = rings, outer first). */
export function polygonsOf(g: GeoPolygon | null | undefined): number[][][][] {
  if (!g) return []
  return g.type === 'Polygon' ? [g.coordinates] : g.coordinates
}

export function ringContains(ring: readonly number[][], lon: number, lat: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Inside the outer ring and not inside a hole. */
export function polygonContains(rings: readonly (readonly number[][])[], lon: number, lat: number): boolean {
  if (!rings.length || !ringContains(rings[0], lon, lat)) return false
  for (let k = 1; k < rings.length; k++) if (ringContains(rings[k], lon, lat)) return false
  return true
}

export function geometryContains(g: GeoPolygon | null | undefined, lon: number, lat: number): boolean {
  return polygonsOf(g).some((p) => polygonContains(p, lon, lat))
}

export function bboxContains(b: readonly number[] | null | undefined, lon: number, lat: number): boolean {
  return !!b && b.length === 4 && lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]
}

/** Local km coordinates of (lon, lat) around a reference latitude. */
function toKm(lon: number, lat: number, lat0: number): [number, number] {
  return [lon * KM_PER_DEG_LON_EQ * Math.cos((lat0 * Math.PI) / 180), lat * KM_PER_DEG_LAT]
}

function segDistKm(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** Distance (km) from a point to a polygon's boundary, 0 inside it. */
export function pointPolygonDistanceKm(g: GeoPolygon | null | undefined, lon: number, lat: number): number {
  const polys = polygonsOf(g)
  if (!polys.length) return Infinity
  if (polys.some((p) => polygonContains(p, lon, lat))) return 0
  const p = toKm(lon, lat, lat)
  let best = Infinity
  for (const rings of polys) {
    for (const ring of rings) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const d = segDistKm(p, toKm(ring[i][0], ring[i][1], lat), toKm(ring[i + 1][0], ring[i + 1][1], lat))
        if (d < best) best = d
      }
    }
  }
  return best
}

function segmentsCross(a: number[], b: number[], c: number[], d: number[]): boolean {
  const o = (p: number[], q: number[], r: number[]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  const o1 = o(a, b, c)
  const o2 = o(a, b, d)
  const o3 = o(c, d, a)
  const o4 = o(c, d, b)
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0
}

/** [w, s, e, n] of a ring. */
function ringBounds(ring: readonly (readonly number[])[]): BBox {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const [lon, lat] of ring) {
    if (lon < w) w = lon
    if (lon > e) e = lon
    if (lat < s) s = lat
    if (lat > n) n = lat
  }
  return [w, s, e, n]
}

const bboxesOverlap = (a: BBox, b: BBox) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]

/** Distance (km) from a point to a box, 0 inside: a lower bound of the distance to anything inside the box. */
export function bboxDistanceKm(b: BBox, lon: number, lat: number): number {
  const dLon = lon < b[0] ? b[0] - lon : lon > b[2] ? lon - b[2] : 0
  const dLat = lat < b[1] ? b[1] - lat : lat > b[3] ? lat - b[3] : 0
  return Math.hypot(dLon * KM_PER_DEG_LON_EQ * Math.cos((lat * Math.PI) / 180), dLat * KM_PER_DEG_LAT)
}

/** True when the polygon and the ring (e.g. the analysis area's corners, closed or not) overlap or touch. */
export function polygonOverlapsRing(g: GeoPolygon | null | undefined, ring: readonly LonLat[]): boolean {
  const polys = polygonsOf(g)
  if (!polys.length || ring.length < 3) return false
  const gb = geometriesBounds([g])
  if (gb && !bboxesOverlap(gb, ringBounds(ring))) return false
  const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring : [...ring, ring[0]]
  if (closed.some(([lon, lat]) => polys.some((p) => polygonContains(p, lon, lat)))) return true
  for (const rings of polys) {
    const outer = rings[0]
    if (outer.some(([lon, lat]) => ringContains(closed, lon, lat))) return true
    for (let i = 0; i + 1 < outer.length; i++) for (let j = 0; j + 1 < closed.length; j++) if (segmentsCross(outer[i], outer[i + 1], closed[j], closed[j + 1])) return true
  }
  return false
}

/**
 * Distance (km) from a polygon to the nearest of a set of fire reference points and rings (0 when one lies inside it,
 * or when a fire ring and the polygon overlap). Null when there is nothing to measure from.
 */
export function polygonFireDistanceKm(g: GeoPolygon | null | undefined, fire: { points: readonly LonLat[]; rings: readonly (readonly LonLat[])[] }): number | null {
  const polys = polygonsOf(g)
  if (!polys.length || (fire.points.length === 0 && fire.rings.length === 0)) return null
  const gb = geometriesBounds([g])
  if (!gb) return null
  for (const r of fire.rings) if (polygonOverlapsRing(g, r)) return 0
  // exact distances only for points whose distance to the polygon's box can still beat the best so far
  const pts = [...fire.rings.flat(), ...fire.points].map((p) => ({ p, lb: bboxDistanceKm(gb, p[0], p[1]) })).sort((a, b) => a.lb - b.lb)
  let best = Infinity
  for (const { p, lb } of pts) {
    if (lb >= best) break
    const d = pointPolygonDistanceKm(g, p[0], p[1])
    if (d < best) best = d
    if (best === 0) break
  }
  return Number.isFinite(best) ? best : null
}

/** [w, s, e, n] of the outer rings of a set of geometries; null when empty. */
export function geometriesBounds(gs: readonly (GeoPolygon | null | undefined)[]): BBox | null {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const g of gs) {
    for (const p of polygonsOf(g)) {
      for (const [lon, lat] of p[0] ?? []) {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
        if (lon < w) w = lon
        if (lon > e) e = lon
        if (lat < s) s = lat
        if (lat > n) n = lat
      }
    }
  }
  return Number.isFinite(w) ? [w, s, e, n] : null
}

/** Every `step`-th vertex (keeps the last one): enough for distances in km without scanning thousands of vertices. */
export function thinRing(ring: readonly LonLat[], max = 240): LonLat[] {
  if (ring.length <= max) return ring.slice()
  const step = Math.ceil(ring.length / max)
  const out: LonLat[] = []
  for (let i = 0; i < ring.length; i += step) out.push(ring[i])
  if (out[out.length - 1] !== ring[ring.length - 1]) out.push(ring[ring.length - 1])
  return out
}

/** "0.4 mi" / "17 mi" (US) or "0.6 km" / "27 km" (metric): one decimal under 10. */
export function distanceText(km: number, metric: boolean): string {
  const v = metric ? km : km / 1.609344
  const unit = metric ? 'km' : 'mi'
  if (v < 0.05) return metric ? 'under 0.1 km' : 'under 0.1 mi'
  return `${v < 10 ? (Math.round(v * 10) / 10).toString() : Math.round(v).toLocaleString('en-US')} ${unit}`
}
