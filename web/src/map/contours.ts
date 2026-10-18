// Outlines of raster classes as vector geometry (owner: map-core): marching squares on a binary mask over the lattice
// of pixel centres. Vertices sit halfway between an inside and an outside pixel centre, so a ring follows the edge of
// the nearest-neighbour pixel blocks drawn by the raster overlay (corners chamfered by half a pixel). The mask is padded
// with "outside", so rings always close (along the AOI edge where the class touches it). Diagonal neighbours count
// as connected (8-connectivity). Ring coordinates are pixel units: pixel (row r, col c) centre = (c, r).
// Orientation in (col, row) space (row down): outer rings have negative shoelace area, holes positive; after the
// conversion to lon/lat (north up) outers are counter-clockwise and holes clockwise (GeoJSON right-hand rule).
import { localToLonLat, type LonLat, type UtmGrid } from '../lib/reproject'

/** A closed ring (first vertex not repeated) as flat [x0, y0, x1, y1, ...] pixel coordinates plus its signed area. */
export interface Ring {
  pts: number[]
  area: number
}

// Segment table: for each case (bits TL=8, TR=4, BR=2, BL=1) the directed segments [from, to] between the cell's
// edge points (0 = top, 1 = right, 2 = bottom, 3 = left), oriented with the inside on the left (row down).
const T = 0
const R = 1
const B = 2
const L = 3
const SEGMENTS: number[][] = [
  [], // 0
  [B, L], // 1 BL
  [R, B], // 2 BR
  [R, L], // 3 BL BR
  [T, R], // 4 TR
  [T, L, B, R], // 5 TR BL (saddle, inside connected)
  [T, B], // 6 TR BR
  [T, L], // 7 TR BR BL
  [L, T], // 8 TL
  [B, T], // 9 TL BL
  [R, T, L, B], // 10 TL BR (saddle, inside connected)
  [R, T], // 11 TL BL BR
  [L, R], // 12 TL TR
  [B, R], // 13 TL TR BL
  [L, B], // 14 TL TR BR
  [], // 15
]

/** Signed shoelace area of a flat ring. */
export function ringArea(pts: ArrayLike<number>): number {
  let a = 0
  const n = pts.length
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n
    a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1]
  }
  return a / 2
}

/** Closed rings around the cells where `mask` is non-zero (w x h, row-major, row 0 = north). */
export function maskRings(mask: ArrayLike<number>, w: number, h: number): Ring[] {
  // lattice edges: H(r, c) joins pixel centres (r, c)-(r, c+1); V(r, c) joins (r, c)-(r+1, c); r in -1..h, c in -1..w
  const W2 = w + 2
  const edgeCount = (h + 2) * W2 * 2
  const next = new Int32Array(edgeCount).fill(-1)
  const hId = (r: number, c: number) => ((r + 1) * W2 + (c + 1)) * 2
  const vId = (r: number, c: number) => ((r + 1) * W2 + (c + 1)) * 2 + 1
  const at = (r: number, c: number) => (r >= 0 && r < h && c >= 0 && c < w && mask[r * w + c] ? 1 : 0)
  const starts: number[] = []
  for (let r = -1; r < h; r++) {
    for (let c = -1; c < w; c++) {
      const code = (at(r, c) << 3) | (at(r, c + 1) << 2) | (at(r + 1, c + 1) << 1) | at(r + 1, c)
      const segs = SEGMENTS[code]
      for (let k = 0; k < segs.length; k += 2) {
        const e = (side: number) => (side === T ? hId(r, c) : side === B ? hId(r + 1, c) : side === L ? vId(r, c) : vId(r, c + 1))
        const from = e(segs[k])
        next[from] = e(segs[k + 1])
        starts.push(from)
      }
    }
  }
  const visited = new Uint8Array(edgeCount)
  const rings: Ring[] = []
  for (const s of starts) {
    if (visited[s]) continue
    const raw: number[] = []
    let e = s
    while (e >= 0 && !visited[e]) {
      visited[e] = 1
      const cell = e >> 1
      const r = Math.floor(cell / W2) - 1
      const c = (cell % W2) - 1
      if (e & 1) raw.push(c, r + 0.5)
      else raw.push(c + 0.5, r)
      e = next[e]
    }
    const pts = dropCollinear(raw)
    if (pts.length >= 6) rings.push({ pts, area: ringArea(pts) })
  }
  return rings
}

/** Remove vertices where the ring continues in the same direction (contours move in 8 directions). */
function dropCollinear(raw: number[]): number[] {
  const n = raw.length / 2
  if (n < 3) return raw
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n
    const q = (i + 1) % n
    const ax = raw[2 * i] - raw[2 * p]
    const ay = raw[2 * i + 1] - raw[2 * p + 1]
    const bx = raw[2 * q] - raw[2 * i]
    const by = raw[2 * q + 1] - raw[2 * i + 1]
    if (Math.abs(ax * by - ay * bx) > 1e-12) out.push(raw[2 * i], raw[2 * i + 1])
  }
  return out
}

function bbox(pts: number[]): [number, number, number, number] {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < x0) x0 = pts[i]
    if (pts[i] > x1) x1 = pts[i]
    if (pts[i + 1] < y0) y0 = pts[i + 1]
    if (pts[i + 1] > y1) y1 = pts[i + 1]
  }
  return [x0, y0, x1, y1]
}

/** Even-odd point-in-ring test. */
export function pointInRing(x: number, y: number, pts: number[]): boolean {
  let inside = false
  const n = pts.length
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = pts[i]
    const yi = pts[i + 1]
    const xj = pts[j]
    const yj = pts[j + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Polygons (outer ring first, then its holes). Each hole goes to the smallest outer ring containing it. Outer rings
 *  smaller than `minArea` square pixels are dropped together with their holes. */
export function ringsToPolygons(rings: Ring[], minArea = 0): Ring[][] {
  const outers = rings.filter((r) => r.area < 0 && -r.area >= minArea).map((r) => ({ ring: r, box: bbox(r.pts), holes: [] as Ring[] }))
  for (const hole of rings) {
    if (hole.area <= 0) continue
    const x = hole.pts[0]
    const y = hole.pts[1]
    let best: (typeof outers)[number] | null = null
    for (const o of outers) {
      if (x < o.box[0] || x > o.box[2] || y < o.box[1] || y > o.box[3]) continue
      if (best && -o.ring.area >= -best.ring.area) continue
      if (pointInRing(x, y, o.ring.pts)) best = o
    }
    best?.holes.push(hole)
  }
  return outers.map((o) => [o.ring, ...o.holes])
}

/** Pixel-unit ring -> [lon, lat] ring (closed: first vertex repeated) for a grid of w x h pixels over the AOI. */
export function ringToLonLat(pts: number[], grid: UtmGrid & { extent_m: number }, w: number, h: number): LonLat[] {
  const ext = grid.extent_m
  const out: LonLat[] = []
  for (let i = 0; i < pts.length; i += 2) {
    const x = -ext / 2 + ((pts[i] + 0.5) / w) * ext
    const z = -ext / 2 + ((pts[i + 1] + 0.5) / h) * ext
    out.push(localToLonLat(x, z, grid))
  }
  if (out.length) out.push(out[0])
  return out
}

/** Outer rings and holes of `mask` as GeoJSON geometry in lon/lat: lines (closed rings, for outlines) and polygons
 *  (for pattern fills). Rings around fewer than `minArea` square pixels are dropped from both. */
export function maskGeometry(
  mask: ArrayLike<number>,
  w: number,
  h: number,
  grid: UtmGrid & { extent_m: number },
  minArea = 0,
): { lines: LonLat[][]; polygons: LonLat[][][] } {
  const polys = ringsToPolygons(maskRings(mask, w, h), minArea)
  const polygons = polys.map((p) => p.map((r) => ringToLonLat(r.pts, grid, w, h)))
  return { lines: polygons.flat(), polygons }
}
