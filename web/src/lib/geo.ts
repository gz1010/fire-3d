// Local-coordinate helpers (SPEC 4.1): x east+, z south+, y = elevation (m) x exaggeration in the scene.
// Plane UV: u = x/extent + 0.5, v = 0.5 - z/extent (v = 1 at the north edge). Raster row 0 = north edge.
import * as THREE from 'three'
import type { ManifestGrid } from '../api/types'

export function localToUv(x: number, z: number, extent: number): [number, number] {
  return [x / extent + 0.5, 0.5 - z / extent]
}

export function uvToLocal(u: number, v: number, extent: number): [number, number] {
  return [(u - 0.5) * extent, (0.5 - v) * extent]
}

/** Continuous pixel coordinates of local (x, z): pixel (r, c) centre is at integer (r, c) here. */
export function localToPixel(x: number, z: number, extent: number, width: number, height: number): [number, number] {
  return [((z + extent / 2) / extent) * height - 0.5, ((x + extent / 2) / extent) * width - 0.5]
}

/** Bilinear sample of a row-major raster (row 0 = north) at local (x, z); edges clamp. `nodata` values are skipped
 *  (re-weighted); returns NaN if all four neighbours are nodata. */
export function sampleBilinear(
  data: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  z: number,
  extent: number,
  nodata?: number,
): number {
  const [pr, pc] = localToPixel(x, z, extent, width, height)
  const r = Math.min(Math.max(pr, 0), height - 1)
  const c = Math.min(Math.max(pc, 0), width - 1)
  const r0 = Math.floor(r)
  const c0 = Math.floor(c)
  const r1 = Math.min(r0 + 1, height - 1)
  const c1 = Math.min(c0 + 1, width - 1)
  const fr = r - r0
  const fc = c - c0
  const v00 = data[r0 * width + c0]
  const v01 = data[r0 * width + c1]
  const v10 = data[r1 * width + c0]
  const v11 = data[r1 * width + c1]
  if (nodata === undefined) {
    return (v00 * (1 - fc) + v01 * fc) * (1 - fr) + (v10 * (1 - fc) + v11 * fc) * fr
  }
  let acc = 0
  let wsum = 0
  const add = (v: number, w: number) => {
    if (v !== nodata && w > 0) {
      acc += v * w
      wsum += w
    }
  }
  add(v00, (1 - fc) * (1 - fr))
  add(v01, fc * (1 - fr))
  add(v10, (1 - fc) * fr)
  add(v11, fc * fr)
  return wsum > 0 ? acc / wsum : Number.NaN
}

/** Nearest-pixel sample (categorical data, arrival times). */
export function sampleNearest(data: ArrayLike<number>, width: number, height: number, x: number, z: number, extent: number): number {
  const [pr, pc] = localToPixel(x, z, extent, width, height)
  const r = Math.min(Math.max(Math.round(pr), 0), height - 1)
  const c = Math.min(Math.max(Math.round(pc), 0), width - 1)
  return data[r * width + c]
}

export interface ElevationGrid {
  data: Float32Array
  width: number
  height: number
  min: number
  max: number
}

/** Terrain elevation (m, not exaggerated) at local (x, z). */
export function sampleElevation(elev: ElevationGrid, x: number, z: number, extent: number): number {
  return sampleBilinear(elev.data, elev.width, elev.height, x, z, extent)
}

/** Slope (rise/run) at local (x, z) from central differences over `step` metres (default one render pixel). */
export function slopeAt(elev: ElevationGrid, x: number, z: number, extent: number, step = extent / elev.width): number {
  const dx = (sampleElevation(elev, x + step, z, extent) - sampleElevation(elev, x - step, z, extent)) / (2 * step)
  const dz = (sampleElevation(elev, x, z + step, extent) - sampleElevation(elev, x, z - step, extent)) / (2 * step)
  return Math.hypot(dx, dz)
}

/** Anything with an extent, elevation grid and heightAt (scene/assets.ts IncidentAssets satisfies this). */
export interface Heightfield {
  extent: number
  elevation: ElevationGrid
  heightAt(x: number, z: number): number
}

/** Ray vs. displaced terrain (world y = elevation x exaggeration): conservative ray-march + bisection.
 *  Returns the hit point in world coordinates (y exaggerated), or null when the ray misses the AOI. */
export function raycastHeightfield(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  assets: Heightfield,
  exaggeration: number,
  target: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 | null {
  const len = Math.hypot(dir.x, dir.y, dir.z)
  if (len === 0) return null
  const dx = dir.x / len
  const dy = dir.y / len
  const dz = dir.z / len
  const half = assets.extent / 2
  const yMin = assets.elevation.min * exaggeration - 1
  const yMax = assets.elevation.max * exaggeration + 1
  let t0 = 0
  let t1 = Number.POSITIVE_INFINITY
  const slab = (o: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < 1e-12) return o >= lo && o <= hi
    let ta = (lo - o) / d
    let tb = (hi - o) / d
    if (ta > tb) [ta, tb] = [tb, ta]
    t0 = Math.max(t0, ta)
    t1 = Math.min(t1, tb)
    return t0 <= t1
  }
  if (!slab(origin.x, dx, -half, half) || !slab(origin.y, dy, yMin, yMax) || !slab(origin.z, dz, -half, half)) return null
  const clearance = (t: number) => origin.y + dy * t - assets.heightAt(origin.x + dx * t, origin.z + dz * t) * exaggeration
  const res = assets.extent / assets.elevation.width
  const horiz = Math.sqrt(Math.max(0, 1 - dy * dy))
  const maxRise = Math.abs(dy) + 2.5 * exaggeration * horiz // bound on clearance lost per metre of ray
  let prevT = t0
  let prevH = clearance(t0)
  if (prevH <= 0) return null // ray enters the box below the surface
  let t = t0
  while (t < t1) {
    const step = Math.max(res * 0.35, (prevH / maxRise) * 0.9)
    t = Math.min(t + step, t1)
    const h = clearance(t)
    if (h <= 0) {
      let a = prevT
      let b = t
      for (let i = 0; i < 26; i++) {
        const m = (a + b) / 2
        if (clearance(m) > 0) a = m
        else b = m
      }
      const th = (a + b) / 2
      const x = origin.x + dx * th
      const z = origin.z + dz * th
      return target.set(x, assets.heightAt(x, z) * exaggeration, z)
    }
    prevT = t
    prevH = h
  }
  return null
}

// ------------------------------------------------------------------------------------------- UTM <-> lon/lat
// Krüger series (WGS84, mm accuracy within a zone); northern hemisphere UTM as used by the bundles.
const A_WGS = 6378137
const F_WGS = 1 / 298.257223563
const N_ = F_WGS / (2 - F_WGS)
const A_RECT = (A_WGS / (1 + N_)) * (1 + (N_ * N_) / 4 + (N_ ** 4) / 64)
const K0 = 0.9996
const ALPHA = [N_ / 2 - (2 / 3) * N_ ** 2 + (5 / 16) * N_ ** 3, (13 / 48) * N_ ** 2 - (3 / 5) * N_ ** 3, (61 / 240) * N_ ** 3]
const BETA = [N_ / 2 - (2 / 3) * N_ ** 2 + (37 / 96) * N_ ** 3, (1 / 48) * N_ ** 2 + (1 / 15) * N_ ** 3, (17 / 480) * N_ ** 3]
const DELTA = [2 * N_ - (2 / 3) * N_ ** 2 - 2 * N_ ** 3, (7 / 3) * N_ ** 2 - (8 / 5) * N_ ** 3, (56 / 15) * N_ ** 3]
const DEG = Math.PI / 180

/** UTM (northern hemisphere) -> [lon, lat] degrees. */
export function utmToLonLat(e: number, n: number, zone: number): [number, number] {
  const xi = n / (K0 * A_RECT)
  const eta = (e - 500000) / (K0 * A_RECT)
  let xiP = xi
  let etaP = eta
  for (let j = 1; j <= 3; j++) {
    xiP -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta)
    etaP -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta)
  }
  const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP))
  let phi = chi
  for (let j = 1; j <= 3; j++) phi += DELTA[j - 1] * Math.sin(2 * j * chi)
  const lon0 = (zone * 6 - 183) * DEG
  const lam = lon0 + Math.atan2(Math.sinh(etaP), Math.cos(xiP))
  return [lam / DEG, phi / DEG]
}

/** [lon, lat] degrees -> UTM (northern hemisphere) [e, n] in the given zone. */
export function lonLatToUtm(lon: number, lat: number, zone: number): [number, number] {
  const phi = lat * DEG
  const dLam = lon * DEG - (zone * 6 - 183) * DEG
  const c = (2 * Math.sqrt(N_)) / (1 + N_)
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - c * Math.atanh(c * Math.sin(phi)))
  const xiP = Math.atan2(t, Math.cos(dLam))
  const etaP = Math.atanh(Math.sin(dLam) / Math.sqrt(1 + t * t))
  let e = etaP
  let n = xiP
  for (let j = 1; j <= 3; j++) {
    e += ALPHA[j - 1] * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP)
    n += ALPHA[j - 1] * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP)
  }
  return [500000 + K0 * A_RECT * e, K0 * A_RECT * n]
}

/** Local (x, z) -> [lon, lat] for a manifest grid. */
export function localToLonLat(x: number, z: number, grid: Pick<ManifestGrid, 'center_e' | 'center_n' | 'utm_zone'>): [number, number] {
  return utmToLonLat(grid.center_e + x, grid.center_n - z, grid.utm_zone)
}

/** [lon, lat] -> local (x, z) for a manifest grid. */
export function lonLatToLocal(lon: number, lat: number, grid: Pick<ManifestGrid, 'center_e' | 'center_n' | 'utm_zone'>): [number, number] {
  const [e, n] = lonLatToUtm(lon, lat, grid.utm_zone)
  return [e - grid.center_e, -(n - grid.center_n)]
}

/** Horizontal distance (m) between two local points. */
export function dist2d(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(bx - ax, bz - az)
}
