// Geographic maths for the Public/Command map (owner: map-core; CONTRACT §4.3), without three.js.
//   - UTM <-> lon/lat (Krüger series, the same constants and formulas as lib/geo.ts, which pulls in three.js for its
//     terrain raycast) and incident-local metres (SPEC 4.1: x = e − center_e east+, z = −(n − center_n) south+).
//   - Web Mercator in MapLibre's world units (0..1, y down) with MapLibre's exact formulas.
//   - The AOI as its true quadrilateral (never the axis-aligned bbox_lonlat).
//   - Raster overlays: the bundle's UTM grids are shown in Web Mercator by per-pixel inverse mapping. Each output pixel
//     centre -> lon/lat -> incident UTM zone e/n -> local x/z -> the source pixel containing it (row 0 = north, col 0 =
//     west, the same rule as data/rasters.ts pixelAt), nearest neighbour, so displayed values are the stored values.
//     MapLibre rounds image/canvas source corners to 1/8192 of the tile that holds the image; the output rectangle is
//     snapped to that grid so the drawn placement equals the mapped placement exactly. Mappings are cached per grid.
import type { ManifestGrid } from '../api/types'

export type UtmGrid = Pick<ManifestGrid, 'center_e' | 'center_n' | 'utm_zone'>
export type AoiGrid = Pick<ManifestGrid, 'center_e' | 'center_n' | 'utm_zone' | 'extent_m'>
export type LonLat = [number, number]

// ------------------------------------------------------------------------------------------- UTM <-> lon/lat
// Krüger series (WGS84, mm accuracy within a zone); northern hemisphere UTM as used by the bundles.
const A_WGS = 6378137
const F_WGS = 1 / 298.257223563
const N_ = F_WGS / (2 - F_WGS)
const A_RECT = (A_WGS / (1 + N_)) * (1 + (N_ * N_) / 4 + N_ ** 4 / 64)
const K0 = 0.9996
const KA = K0 * A_RECT
const ALPHA = [N_ / 2 - (2 / 3) * N_ ** 2 + (5 / 16) * N_ ** 3, (13 / 48) * N_ ** 2 - (3 / 5) * N_ ** 3, (61 / 240) * N_ ** 3]
const BETA = [N_ / 2 - (2 / 3) * N_ ** 2 + (37 / 96) * N_ ** 3, (1 / 48) * N_ ** 2 + (1 / 15) * N_ ** 3, (17 / 480) * N_ ** 3]
const DELTA = [2 * N_ - (2 / 3) * N_ ** 2 - 2 * N_ ** 3, (7 / 3) * N_ ** 2 - (8 / 5) * N_ ** 3, (56 / 15) * N_ ** 3]
const C_CONF = (2 * Math.sqrt(N_)) / (1 + N_)
const DEG = Math.PI / 180

/** Central meridian of a UTM zone (radians). */
const lon0Rad = (zone: number) => (zone * 6 - 183) * DEG

/** UTM (northern hemisphere) -> [lon, lat] degrees. */
export function utmToLonLat(e: number, n: number, zone: number): LonLat {
  const xi = n / KA
  const eta = (e - 500000) / KA
  let xiP = xi
  let etaP = eta
  for (let j = 1; j <= 3; j++) {
    xiP -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta)
    etaP -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta)
  }
  const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP))
  let phi = chi
  for (let j = 1; j <= 3; j++) phi += DELTA[j - 1] * Math.sin(2 * j * chi)
  const lam = lon0Rad(zone) + Math.atan2(Math.sinh(etaP), Math.cos(xiP))
  return [lam / DEG, phi / DEG]
}

/** [lon, lat] degrees -> UTM (northern hemisphere) [e, n] in the given zone. */
export function lonLatToUtm(lon: number, lat: number, zone: number): [number, number] {
  const phi = lat * DEG
  const dLam = lon * DEG - lon0Rad(zone)
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - C_CONF * Math.atanh(C_CONF * Math.sin(phi)))
  const xiP = Math.atan2(t, Math.cos(dLam))
  const etaP = Math.atanh(Math.sin(dLam) / Math.sqrt(1 + t * t))
  let e = etaP
  let n = xiP
  for (let j = 1; j <= 3; j++) {
    e += ALPHA[j - 1] * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP)
    n += ALPHA[j - 1] * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP)
  }
  return [500000 + KA * e, KA * n]
}

/** Local (x, z) metres -> [lon, lat] for a manifest grid. */
export function localToLonLat(x: number, z: number, grid: UtmGrid): LonLat {
  return utmToLonLat(grid.center_e + x, grid.center_n - z, grid.utm_zone)
}

/** [lon, lat] -> local (x, z) metres for a manifest grid. */
export function lonLatToLocal(lon: number, lat: number, grid: UtmGrid): [number, number] {
  const [e, n] = lonLatToUtm(lon, lat, grid.utm_zone)
  return [e - grid.center_e, -(n - grid.center_n)]
}

// ------------------------------------------------------------------------------------------- Web Mercator
/** MapLibre world units (0..1 across the world, y = 0 at the north edge); same formulas as maplibre-gl. */
export const mercatorX = (lon: number): number => (180 + lon) / 360
export const mercatorY = (lat: number): number => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360
export const lonFromMercatorX = (x: number): number => x * 360 - 180
export function latFromMercatorY(y: number): number {
  const y2 = 180 - y * 360
  return (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90
}

/** Equatorial circumference of MapLibre's Web Mercator sphere (m). */
export const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6378137
/** Integer units per tile edge that MapLibre rounds image/canvas source corners to. */
export const MAPLIBRE_TILE_EXTENT = 8192

// ------------------------------------------------------------------------------------------- AOI
/** [lon, lat] of the AOI corners in order NW, NE, SE, SW: the true UTM square, a slightly rotated quadrilateral in
 *  lon/lat (never the axis-aligned bbox_lonlat). */
export function aoiCornersLonLat(grid: AoiGrid): [LonLat, LonLat, LonLat, LonLat] {
  const h = grid.extent_m / 2
  return [localToLonLat(-h, -h, grid), localToLonLat(h, -h, grid), localToLonLat(h, h, grid), localToLonLat(-h, h, grid)]
}

/** The AOI boundary as a closed ring (NW -> NE -> SE -> SW -> NW), each edge sampled at `perEdge` segments so the
 *  outline follows the UTM edges exactly at any zoom. */
export function aoiRingLonLat(grid: AoiGrid, perEdge = 16): LonLat[] {
  const h = grid.extent_m / 2
  const corners: [number, number][] = [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ]
  const ring: LonLat[] = []
  for (let k = 0; k < 4; k++) {
    const [ax, az] = corners[k]
    const [bx, bz] = corners[(k + 1) % 4]
    for (let s = 0; s < perEdge; s++) ring.push(localToLonLat(ax + ((bx - ax) * s) / perEdge, az + ((bz - az) * s) / perEdge, grid))
  }
  ring.push(ring[0])
  return ring
}

/** True when local (x, z) lies inside the square AOI (edges included; same rule as data/rasters.ts insideAoi). */
export function insideAoiLocal(x: number, z: number, extent: number): boolean {
  const h = extent / 2
  return x >= -h && x <= h && z >= -h && z <= h
}

/** True when [lon, lat] lies inside the incident's modeled area. */
export function insideAoiLonLat(lon: number, lat: number, grid: AoiGrid): boolean {
  const [x, z] = lonLatToLocal(lon, lat, grid)
  return insideAoiLocal(x, z, grid.extent_m)
}

// ------------------------------------------------------------------------------------------- overlay placement
export interface MercatorBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface OverlayPlacement extends MercatorBounds {
  /** Zoom of the MapLibre tile that holds the image (maplibre-gl getCoordinatesCenterTileID). */
  tileZoom: number
  /** Canvas size in pixels. */
  width: number
  height: number
  /** Corners for a MapLibre image/canvas source, [lon, lat] in order top-left, top-right, bottom-right, bottom-left. */
  coordinates: [LonLat, LonLat, LonLat, LonLat]
}

export interface OverlayOptions {
  /** Output pixels per source pixel along each axis (default 2: rotated pixel edges stay within 1/4 source pixel). */
  oversample?: number
  /** Largest canvas edge (default 4096, safe for WebGL texture limits). */
  maxSize?: number
}

/** Mercator bounds of the AOI (its edges sampled densely; UTM straight lines are very slightly curved in Mercator). */
export function aoiMercatorBounds(grid: AoiGrid, perEdge = 64): MercatorBounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [lon, lat] of aoiRingLonLat(grid, perEdge)) {
    const x = mercatorX(lon)
    const y = mercatorY(lat)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

/** maplibre-gl's choice of the image tile zoom for given bounds (getCoordinatesCenterTileID). */
export function imageTileZoom(b: MercatorBounds): number {
  const dMax = Math.max(b.maxX - b.minX, b.maxY - b.minY)
  return Math.max(0, Math.floor(-Math.log(dMax) / Math.LN2))
}

/** Expand bounds outward to MapLibre's corner-rounding grid (1 / (8192 · 2^z) world units) so the corners MapLibre
 *  stores are exact. Snapping can only lower the tile zoom; repeat until it is stable. */
export function snapToImageTileGrid(b: MercatorBounds): MercatorBounds & { tileZoom: number } {
  let z = imageTileZoom(b)
  for (;;) {
    const unit = Math.pow(2, z) * MAPLIBRE_TILE_EXTENT
    const s = {
      minX: Math.floor(b.minX * unit) / unit,
      minY: Math.floor(b.minY * unit) / unit,
      maxX: Math.ceil(b.maxX * unit) / unit,
      maxY: Math.ceil(b.maxY * unit) / unit,
    }
    const z2 = imageTileZoom(s)
    if (z2 === z) return { ...s, tileZoom: z }
    z = z2
  }
}

/** Where and how large the reprojected overlay of a srcW x srcH grid covering the AOI is drawn. */
export function overlayPlacement(grid: AoiGrid, srcW: number, srcH: number, opts: OverlayOptions = {}): OverlayPlacement {
  const oversample = opts.oversample ?? 2
  const maxSize = opts.maxSize ?? 4096
  const b = snapToImageTileGrid(aoiMercatorBounds(grid))
  // ground metres per world unit at the AOI centre (Mercator is conformal: the same in x and y)
  const latC = latFromMercatorY((b.minY + b.maxY) / 2)
  const groundPerWorld = EARTH_CIRCUMFERENCE_M * Math.cos(latC * DEG)
  const resM = grid.extent_m / Math.max(srcW, srcH)
  const pxWorld = resM / oversample / groundPerWorld
  let width = Math.max(1, Math.ceil((b.maxX - b.minX) / pxWorld))
  let height = Math.max(1, Math.ceil((b.maxY - b.minY) / pxWorld))
  const shrink = Math.max(width, height) / maxSize
  if (shrink > 1) {
    width = Math.max(1, Math.ceil(width / shrink))
    height = Math.max(1, Math.ceil(height / shrink))
  }
  const W = lonFromMercatorX(b.minX)
  const E = lonFromMercatorX(b.maxX)
  const N = latFromMercatorY(b.minY)
  const S = latFromMercatorY(b.maxY)
  return {
    minX: b.minX,
    minY: b.minY,
    maxX: b.maxX,
    maxY: b.maxY,
    tileZoom: b.tileZoom,
    width,
    height,
    coordinates: [
      [W, N],
      [E, N],
      [E, S],
      [W, S],
    ],
  }
}

// ------------------------------------------------------------------------------------------- per-pixel mapping
export interface OverlayMapping extends OverlayPlacement {
  key: string
  srcWidth: number
  srcHeight: number
  /** Per output pixel (row-major, row 0 = north): source index row·srcWidth + col, or −1 outside the AOI. */
  index: Int32Array
  /** Number of output pixels inside the AOI. */
  inside: number
}

export function overlayMappingKey(grid: AoiGrid, srcW: number, srcH: number, opts: OverlayOptions = {}): string {
  return `${grid.utm_zone}|${grid.center_e}|${grid.center_n}|${grid.extent_m}|${srcW}x${srcH}|${opts.oversample ?? 2}|${opts.maxSize ?? 4096}`
}

/** Build the per-pixel inverse mapping (exact Krüger series per pixel; latitude-only and longitude-only terms are
 *  computed once per row / column, the multiple-angle terms by recurrence). */
export function buildOverlayMapping(grid: AoiGrid, srcW: number, srcH: number, opts: OverlayOptions = {}): OverlayMapping {
  const p = overlayPlacement(grid, srcW, srcH, opts)
  const { width: W, height: H } = p
  const dx = (p.maxX - p.minX) / W
  const dy = (p.maxY - p.minY) / H
  const lon0 = lon0Rad(grid.utm_zone)
  const cosL = new Float64Array(W)
  const sinL = new Float64Array(W)
  for (let i = 0; i < W; i++) {
    const dLam = lonFromMercatorX(p.minX + (i + 0.5) * dx) * DEG - lon0
    cosL[i] = Math.cos(dLam)
    sinL[i] = Math.sin(dLam)
  }
  const ext = grid.extent_m
  const half = ext / 2
  const ce = grid.center_e
  const cn = grid.center_n
  const [a1, a2, a3] = ALPHA
  const index = new Int32Array(W * H)
  let inside = 0
  for (let j = 0; j < H; j++) {
    const s = Math.sin(latFromMercatorY(p.minY + (j + 0.5) * dy) * DEG)
    const t = Math.sinh(Math.atanh(s) - C_CONF * Math.atanh(C_CONF * s))
    const inv = 1 / Math.sqrt(1 + t * t)
    const row0 = j * W
    for (let i = 0; i < W; i++) {
      const xiP = Math.atan2(t, cosL[i])
      const etaP = Math.atanh(sinL[i] * inv)
      const c1 = Math.cos(2 * xiP)
      const s1 = Math.sin(2 * xiP)
      const ex = Math.exp(2 * etaP)
      const ch1 = (ex + 1 / ex) / 2
      const sh1 = (ex - 1 / ex) / 2
      const c2 = 2 * c1 * c1 - 1
      const s2 = 2 * s1 * c1
      const ch2 = 2 * ch1 * ch1 - 1
      const sh2 = 2 * sh1 * ch1
      const c3 = c1 * c2 - s1 * s2
      const s3 = s1 * c2 + c1 * s2
      const ch3 = ch1 * ch2 + sh1 * sh2
      const sh3 = sh1 * ch2 + ch1 * sh2
      const e = 500000 + KA * (etaP + a1 * c1 * sh1 + a2 * c2 * sh2 + a3 * c3 * sh3)
      const n = KA * (xiP + a1 * s1 * ch1 + a2 * s2 * ch2 + a3 * s3 * ch3)
      const x = e - ce
      const z = -(n - cn)
      if (x >= -half && x <= half && z >= -half && z <= half) {
        // identical arithmetic to data/rasters.ts pixelAt (edges belong to the last row / column)
        const col = Math.min(srcW - 1, Math.floor(((x + ext / 2) / ext) * srcW))
        const row = Math.min(srcH - 1, Math.floor(((z + ext / 2) / ext) * srcH))
        index[row0 + i] = row * srcW + col
        inside++
      } else {
        index[row0 + i] = -1
      }
    }
  }
  return { ...p, key: overlayMappingKey(grid, srcW, srcH, opts), srcWidth: srcW, srcHeight: srcH, index, inside }
}

const MAPPING_CACHE_MAX = 6
const mappingCache = new Map<string, OverlayMapping>()

/** Cached buildOverlayMapping (LRU by incident grid + source size). */
export function overlayMapping(grid: AoiGrid, srcW: number, srcH: number, opts: OverlayOptions = {}): OverlayMapping {
  const key = overlayMappingKey(grid, srcW, srcH, opts)
  const hit = mappingCache.get(key)
  if (hit) {
    mappingCache.delete(key)
    mappingCache.set(key, hit)
    return hit
  }
  const m = buildOverlayMapping(grid, srcW, srcH, opts)
  mappingCache.set(key, m)
  while (mappingCache.size > MAPPING_CACHE_MAX) mappingCache.delete(mappingCache.keys().next().value as string)
  return m
}

/** Cache statistics (tests, diagnostics). */
export function overlayMappingCacheSize(): number {
  return mappingCache.size
}

/** Output pixel (column, row) of the overlay that contains [lon, lat], or null outside the canvas. */
export function overlayPixelOf(p: OverlayPlacement, lon: number, lat: number): { i: number; j: number } | null {
  const i = Math.floor(((mercatorX(lon) - p.minX) / (p.maxX - p.minX)) * p.width)
  const j = Math.floor(((mercatorY(lat) - p.minY) / (p.maxY - p.minY)) * p.height)
  return i >= 0 && i < p.width && j >= 0 && j < p.height ? { i, j } : null
}

/** Fill `out` (RGBA, overlay size) from per-source-pixel RGBA colours through a mapping (0 = transparent). */
export function gatherOverlay(mapping: Pick<OverlayMapping, 'index'>, srcRgba: Uint32Array, out: Uint32Array): void {
  const idx = mapping.index
  for (let k = 0; k < idx.length; k++) {
    const s = idx[k]
    out[k] = s >= 0 ? srcRgba[s] : 0
  }
}
