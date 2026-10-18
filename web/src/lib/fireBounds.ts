// Fire bounds (brief 2, I4; owner: map): the lon/lat box that frames a fire itself rather than its square analysis
// area (AOI), where the fire covers only 0.6-13 % of the view (audit-2 opening-map G3).
//   burned area (observed_arrival)  ∪  latest perimeter  ∪  P90 reach (forecast arrival_p90)  ∪  reported point,
//   grown by 40 % (20 % of the span on each side), at least 3 km on each axis and never larger than the AOI.
// The box is built in the incident's local metres (x east, z south, the UTM grid of the bundle), so it is exactly the
// fire's extent on the analysis grid; its four corners are then converted to lon/lat (a UTM box is slightly rotated in
// lon/lat, so the returned box contains it). Raster scans follow scene/frame.ts: a pixel belongs to the fire when its
// arrival time is finite (NEVER = 1e6 and nodata / NaN are not fire).
// Without anything mapped (an unbuilt fire, or a bundle still being prepared) the box is CAL FIRE's acreage as a
// circle around the reported point, 2.5 times its radius, at least 3 km across; with an AOI it is kept inside it.
import type { ManifestGrid, Perimeter } from '../api/types'
import { localToLonLat, lonLatToLocal } from './reproject'

/** [west, south, east, north] in degrees. */
export type LonLatBox = [number, number, number, number]

/** A raster on the fire grid (row 0 = north, col 0 = west; same layout as data/rasters.ts LoadedLayer). */
export interface FireRaster {
  data: ArrayLike<number>
  width: number
  height: number
}

export interface FireBoundsInput {
  /** The bundle's analysis grid (ready or still building); null or absent for a fire without a bundle. */
  grid?: Pick<ManifestGrid, 'utm_zone' | 'center_e' | 'center_n' | 'extent_m'> | null
  /** observed_arrival: hours since the time origin; every finite value is burned at some time. */
  burned?: FireRaster | null
  /** The selected forecast's arrival_p90: finite where at least 90 % of the model runs reached the pixel. */
  p90?: FireRaster | null
  /** The latest agency perimeter (local metres rings). */
  perimeter?: Pick<Perimeter, 'rings'> | null
  /** CAL FIRE's reported location. */
  point?: { lon: number; lat: number } | null
  /** CAL FIRE's acreage: sizes the box when nothing is mapped. */
  acres?: number | null
}

/** Growth of the mapped box: 40 % of its span in total (20 % on each side). */
export const FIRE_PAD = 0.4
/** Minimum span of the box on each axis (m). */
export const FIRE_MIN_SPAN_M = 3000
/** Without mapped data: the box is this many acreage-circle radii from the reported point on each side. */
export const ACREAGE_RADII = 2.5
/** Arrival times at or above this many hours are not fire (NEVER = 1e6; scene/frame.ts uses the same limit). */
const FINITE_H = 50_000
const SQ_M_PER_ACRE = 4046.8564224
const M_PER_DEG_LAT = 111_320

/** Local metres box: x east, z south. */
export interface LocalBox {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

const emptyBox = (): LocalBox => ({ minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity })
const isEmpty = (b: LocalBox) => !(b.maxX >= b.minX && b.maxZ >= b.minZ)

function addPoint(b: LocalBox, x: number, z: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return
  if (x < b.minX) b.minX = x
  if (x > b.maxX) b.maxX = x
  if (z < b.minZ) b.minZ = z
  if (z > b.maxZ) b.maxZ = z
}

function addBox(b: LocalBox, o: LocalBox | null): boolean {
  if (!o || isEmpty(o)) return false
  addPoint(b, o.minX, o.minZ)
  addPoint(b, o.maxX, o.maxZ)
  return true
}

/** Box of the raster's fire pixels (pixel edges, not centres), or null when none. Same scan as scene/frame.ts. */
export function rasterFireBox(r: FireRaster, extentM: number): LocalBox | null {
  const { data, width: w, height: h } = r
  if (!(w > 0 && h > 0) || data.length < w * h) return null
  let minC = w
  let maxC = -1
  let minR = h
  let maxR = -1
  for (let row = 0; row < h; row++) {
    const o = row * w
    for (let c = 0; c < w; c++) {
      const a = data[o + c]
      if (!(a < FINITE_H)) continue
      if (c < minC) minC = c
      if (c > maxC) maxC = c
      if (row < minR) minR = row
      if (row > maxR) maxR = row
    }
  }
  if (maxC < 0) return null
  const resX = extentM / w
  const resZ = extentM / h
  const half = extentM / 2
  return { minX: minC * resX - half, maxX: (maxC + 1) * resX - half, minZ: minR * resZ - half, maxZ: (maxR + 1) * resZ - half }
}

/** Box of a perimeter's rings (local metres), or null when it has no vertices. */
export function perimeterBox(p: Pick<Perimeter, 'rings'>): LocalBox | null {
  const b = emptyBox()
  for (const ring of p.rings) for (const [x, z] of ring) addPoint(b, x, z)
  return isEmpty(b) ? null : b
}

/** Radius (m) of a circle with the fire's acreage; 0 without a usable acreage. */
export function acreageRadiusM(acres: number | null | undefined): number {
  return acres != null && Number.isFinite(acres) && acres > 0 ? Math.sqrt((acres * SQ_M_PER_ACRE) / Math.PI) : 0
}

/** Half-size (m) of the box around a reported point without mapped data. */
function pointHalfM(acres: number | null | undefined): number {
  return Math.max(FIRE_MIN_SPAN_M / 2, ACREAGE_RADII * acreageRadiusM(acres))
}

/** Grow a box by `pad` of its span (half on each side) and to at least `minSpan` on each axis, around its centre. */
export function growBox(b: LocalBox, pad = FIRE_PAD, minSpan = FIRE_MIN_SPAN_M): LocalBox {
  const grow = (lo: number, hi: number): [number, number] => {
    const c = (lo + hi) / 2
    const half = Math.max(((hi - lo) * (1 + pad)) / 2, minSpan / 2)
    return [c - half, c + half]
  }
  const [minX, maxX] = grow(b.minX, b.maxX)
  const [minZ, maxZ] = grow(b.minZ, b.maxZ)
  return { minX, maxX, minZ, maxZ }
}

/** Keep a box inside the AOI square [-extent/2, extent/2]: a span larger than the AOI becomes the AOI, a smaller one
 *  is shifted inside without shrinking. */
export function clampToAoi(b: LocalBox, extentM: number): LocalBox {
  const h = extentM / 2
  const fit = (lo: number, hi: number): [number, number] => {
    if (hi - lo >= 2 * h) return [-h, h]
    if (lo < -h) return [-h, -h + (hi - lo)]
    if (hi > h) return [h - (hi - lo), h]
    return [lo, hi]
  }
  const [minX, maxX] = fit(b.minX, b.maxX)
  const [minZ, maxZ] = fit(b.minZ, b.maxZ)
  return { minX, maxX, minZ, maxZ }
}

/** The lon/lat box containing a local box (all four corners converted). */
export function localBoxToLonLat(b: LocalBox, grid: Pick<ManifestGrid, 'utm_zone' | 'center_e' | 'center_n'>): LonLatBox {
  const corners = [
    localToLonLat(b.minX, b.minZ, grid),
    localToLonLat(b.maxX, b.minZ, grid),
    localToLonLat(b.maxX, b.maxZ, grid),
    localToLonLat(b.minX, b.maxZ, grid),
  ]
  const lons = corners.map((c) => c[0])
  const lats = corners.map((c) => c[1])
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
}

/** A box of `halfM` metres on each side of a lon/lat point (equirectangular; fine at fire scale). */
export function lonLatBoxAround(lon: number, lat: number, halfM: number): LonLatBox {
  const dLat = halfM / M_PER_DEG_LAT
  const dLon = halfM / (M_PER_DEG_LAT * Math.max(0.01, Math.cos((lat * Math.PI) / 180)))
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat]
}

const validPoint = (p: FireBoundsInput['point']): p is { lon: number; lat: number } =>
  !!p && Number.isFinite(p.lon) && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180

/** Does the input hold anything mapped (burned area, perimeter or P90 reach)? Without it the box is a provisional
 *  acreage-based estimate around the reported point. */
export function hasMappedFire(input: FireBoundsInput): boolean {
  const g = input.grid
  if (!g) return false
  return !!((input.burned && rasterFireBox(input.burned, g.extent_m)) || (input.p90 && rasterFireBox(input.p90, g.extent_m)) || (input.perimeter && perimeterBox(input.perimeter)))
}

/** The fire's framing box [w, s, e, n] (see the header), or null when there is nothing to frame. */
export function fireBounds(input: FireBoundsInput): LonLatBox | null {
  const g = input.grid
  const point = validPoint(input.point) ? input.point : null
  if (!g || !(g.extent_m > 0)) return point ? lonLatBoxAround(point.lon, point.lat, pointHalfM(input.acres)) : null
  const box = emptyBox()
  let mapped = false
  if (input.burned) mapped = addBox(box, rasterFireBox(input.burned, g.extent_m)) || mapped
  if (input.p90) mapped = addBox(box, rasterFireBox(input.p90, g.extent_m)) || mapped
  if (input.perimeter) mapped = addBox(box, perimeterBox(input.perimeter)) || mapped
  const local = point ? lonLatToLocal(point.lon, point.lat, g) : null
  let out: LocalBox
  if (mapped) {
    if (local) addPoint(box, local[0], local[1])
    out = growBox(box)
  } else if (local) {
    const h = pointHalfM(input.acres)
    out = { minX: local[0] - h, maxX: local[0] + h, minZ: local[1] - h, maxZ: local[1] + h }
  } else {
    // nothing mapped and no reported point: the analysis area itself
    const h = g.extent_m / 2
    out = { minX: -h, maxX: h, minZ: -h, maxZ: h }
  }
  return localBoxToLonLat(clampToAoi(out, g.extent_m), g)
}

/** The AOI as a lon/lat box (its true UTM square's corners). */
export function aoiBounds(grid: Pick<ManifestGrid, 'utm_zone' | 'center_e' | 'center_n' | 'extent_m'>): LonLatBox {
  const h = grid.extent_m / 2
  return localBoxToLonLat({ minX: -h, maxX: h, minZ: -h, maxZ: h }, grid)
}
