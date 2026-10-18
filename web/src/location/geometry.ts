// Planar geometry for location checks in incident-local metres (x east, z south; SPEC 4.1): point in perimeter
// rings, nearest perimeter point, and the reconstructed burned footprint of an arrival raster. Distances here are
// planar UTM metres; locationCheck converts the nearest point back to WGS84 and reports geodesic distance and true
// bearing, so UTM scale and grid convergence never reach the user.
import { NEVER_MIN, type LoadedLayer } from '../data/rasters'

export type Ring = readonly (readonly [number, number])[]

/** Even-odd rule over every ring, so holes and multi-part perimeters (rings = exteriors and holes, as written by
 *  the backend) work without knowing which ring is which. Points exactly on an edge count as inside. */
export function pointInRings(x: number, z: number, rings: readonly Ring[]): boolean {
  let inside = false
  for (const ring of rings) {
    const n = ring.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, zi] = ring[i]
      const [xj, zj] = ring[j]
      if (onSegment(x, z, xi, zi, xj, zj)) return true
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
    }
  }
  return inside
}

function onSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number): boolean {
  const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax)
  if (Math.abs(cross) > 1e-9 * Math.max(1, Math.hypot(bx - ax, bz - az))) return false
  return x >= Math.min(ax, bx) - 1e-9 && x <= Math.max(ax, bx) + 1e-9 && z >= Math.min(az, bz) - 1e-9 && z <= Math.max(az, bz) + 1e-9
}

export interface NearestPoint {
  x: number
  z: number
  /** Planar distance (m). */
  distance: number
}

/** Closest point on any ring edge (closing edge included). Null when no ring has an edge. */
export function nearestOnRings(x: number, z: number, rings: readonly Ring[]): NearestPoint | null {
  let best: NearestPoint | null = null
  for (const ring of rings) {
    const n = ring.length
    if (n < 2) continue
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [ax, az] = ring[j]
      const [bx, bz] = ring[i]
      const dx = bx - ax
      const dz = bz - az
      const len2 = dx * dx + dz * dz
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2)) : 0
      const px = ax + t * dx
      const pz = az + t * dz
      const d = Math.hypot(x - px, z - pz)
      if (!best || d < best.distance) best = { x: px, z: pz, distance: d }
    }
  }
  return best
}

export interface FootprintResult {
  /** The point's own cell burned by the time (only when the point is inside the AOI). */
  inside: boolean
  /** Outside: the closest point of the nearest burned cell (cell = res x res square). Inside: the point itself. */
  nearest: NearestPoint
  /** Inside only: the closest point of the nearest cell not burned by the time, i.e. the edge of the burned area
   *  (null when every cell burned). */
  edge: NearestPoint | null
  /** Burned cells by the time and their area (m²). */
  cells: number
  areaM2: number
  /** Latest arrival (hours since the raster's time origin) among cells burned by the time. */
  latestArrivalH: number
}

/** The reconstructed burned footprint of an arrival raster at `tHours` (cells with arrival <= tHours, NEVER and
 *  nodata excluded): whether the point's cell burned, the nearest burned cell (or, inside, the nearest unburned
 *  one), and the burned area. Null when no cell burned by then. One pass over the grid (512 x 512 = 0.26 M cells,
 *  about a millisecond). */
export function burnedFootprint(layer: LoadedLayer, extent: number, x: number, z: number, tHours: number): FootprintResult | null {
  const { width: w, height: h, data } = layer
  const nd = layer.info.nodata
  const resX = extent / w
  const resZ = extent / h
  const half = extent / 2
  const burnedAt = (v: number) => v < NEVER_MIN && v <= tHours + 1e-3 && (nd == null || v !== nd) // NaN -> false
  const inAoi = x >= -half && x <= half && z >= -half && z <= half // edges belong to the last row/col (pixelAt)
  const ownCol = inAoi ? Math.min(w - 1, Math.floor((x + half) / resX)) : -1
  const ownRow = inAoi ? Math.min(h - 1, Math.floor((z + half) / resZ)) : -1
  const inside = inAoi && burnedAt(data[ownRow * w + ownCol])
  let cells = 0
  let latest = Number.NEGATIVE_INFINITY
  let bestD2 = Number.POSITIVE_INFINITY
  let bx = 0
  let bz = 0
  for (let r = 0; r < h; r++) {
    const z0 = -half + r * resZ
    const z1 = z0 + resZ
    const cz = z < z0 ? z0 : z > z1 ? z1 : z
    const dz2 = (z - cz) * (z - cz)
    const row = r * w
    for (let c = 0; c < w; c++) {
      const v = data[row + c]
      const b = burnedAt(v)
      if (b) {
        cells++
        if (v > latest) latest = v
      }
      // outside the burned area look for the nearest burned cell, inside for the nearest unburned one
      if (b === inside || dz2 >= bestD2) continue
      const x0 = -half + c * resX
      const x1 = x0 + resX
      const cx = x < x0 ? x0 : x > x1 ? x1 : x
      const d2 = (x - cx) * (x - cx) + dz2
      if (d2 < bestD2) {
        bestD2 = d2
        bx = cx
        bz = cz
      }
    }
  }
  if (!cells) return null
  const found = Number.isFinite(bestD2) ? { x: bx, z: bz, distance: Math.sqrt(bestD2) } : null
  return {
    inside,
    nearest: inside ? { x, z, distance: 0 } : (found ?? { x, z, distance: 0 }),
    edge: inside ? found : null,
    cells,
    areaM2: cells * resX * resZ,
    latestArrivalH: latest,
  }
}
