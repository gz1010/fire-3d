import { describe, expect, it } from 'vitest'
import { localToLonLat, lonLatToLocal } from './reproject'
import { acreageRadiusM, aoiBounds, clampToAoi, FIRE_MIN_SPAN_M, fireBounds, growBox, hasMappedFire, lonLatBoxAround, perimeterBox, rasterFireBox, type LonLatBox } from './fireBounds'

/** Node's fs without @types/node (tests run in Node; the app never imports this). */
interface FsLike {
  existsSync(p: string): boolean
  readdirSync(p: string): string[]
  readFileSync(p: string, enc?: string): string | Uint8Array
}
const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as FsLike

const NEVER = 1e6
/** A 12 km AOI near Altadena (zone 11) with a 100 x 100 fire grid: 120 m pixels. */
const GRID = { utm_zone: 11, center_e: 401418.0, center_n: 3784849.0, extent_m: 12000 }
const N = 100
const RES = GRID.extent_m / N

/** A raster that is NEVER everywhere except the given [row, col] cells (value 5 h). */
function raster(cells: [number, number][], fill = NEVER): { data: Float32Array; width: number; height: number } {
  const data = new Float32Array(N * N).fill(fill)
  for (const [r, c] of cells) data[r * N + c] = 5
  return { data, width: N, height: N }
}

/** Local-metre extent of a lon/lat box, measured at its centre (for readable assertions). */
function spanM(b: LonLatBox): { x: number; z: number } {
  const [w, s, e, n] = b
  const [x0] = lonLatToLocal(w, (s + n) / 2, GRID)
  const [x1] = lonLatToLocal(e, (s + n) / 2, GRID)
  const [, z0] = lonLatToLocal((w + e) / 2, n, GRID)
  const [, z1] = lonLatToLocal((w + e) / 2, s, GRID)
  return { x: x1 - x0, z: z1 - z0 }
}

const contains = (b: LonLatBox, lon: number, lat: number) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]

describe('raster and perimeter boxes', () => {
  it('scans finite arrivals by pixel edges; NEVER, NaN and nodata-as-NaN are not fire', () => {
    const r = raster([
      [10, 20],
      [30, 25],
    ])
    r.data[0] = Number.NaN
    r.data[5] = NEVER
    const b = rasterFireBox(r, GRID.extent_m)!
    expect(b.minX).toBeCloseTo(20 * RES - 6000)
    expect(b.maxX).toBeCloseTo(26 * RES - 6000)
    expect(b.minZ).toBeCloseTo(10 * RES - 6000)
    expect(b.maxZ).toBeCloseTo(31 * RES - 6000)
    expect(rasterFireBox(raster([]), GRID.extent_m)).toBeNull()
    expect(rasterFireBox({ data: new Float32Array(3), width: 4, height: 4 }, GRID.extent_m)).toBeNull()
  })

  it('perimeter box spans every ring vertex', () => {
    expect(perimeterBox({ rings: [[[-100, 50], [300, -20]], [[0, 900]]] })).toEqual({ minX: -100, maxX: 300, minZ: -20, maxZ: 900 })
    expect(perimeterBox({ rings: [] })).toBeNull()
  })

  it('grows by 40 % in total and to at least 3 km per axis; clamps into the AOI without shrinking', () => {
    const g = growBox({ minX: 0, maxX: 5000, minZ: 0, maxZ: 100 })
    expect(g.maxX - g.minX).toBeCloseTo(7000)
    expect((g.minX + g.maxX) / 2).toBeCloseTo(2500)
    expect(g.maxZ - g.minZ).toBeCloseTo(FIRE_MIN_SPAN_M)
    expect(clampToAoi({ minX: 4000, maxX: 8000, minZ: -9000, maxZ: 9000 }, 12000)).toEqual({ minX: 2000, maxX: 6000, minZ: -6000, maxZ: 6000 })
    expect(clampToAoi({ minX: -7000, maxX: -5000, minZ: 0, maxZ: 1 }, 12000)).toEqual({ minX: -6000, maxX: -4000, minZ: 0, maxZ: 1 })
  })
})

describe('fireBounds', () => {
  it('frames the burned area + 40 %, not the AOI', () => {
    // burned block: rows 40-59, cols 30-49 -> 2.4 km square west of centre
    const cells: [number, number][] = []
    for (let r = 40; r < 60; r++) for (let c = 30; c < 50; c++) cells.push([r, c])
    const b = fireBounds({ grid: GRID, burned: raster(cells) })!
    const s = spanM(b)
    expect(s.x).toBeGreaterThan(2400 * 1.39)
    expect(s.x).toBeLessThan(2400 * 1.45) // + the UTM -> lon/lat corner rotation
    expect(s.z).toBeGreaterThan(2400 * 1.39)
    const [cx, cz] = lonLatToLocal((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, GRID)
    expect(cx).toBeCloseTo(-1200, -1)
    expect(cz).toBeCloseTo(0, -1)
    const aoi = aoiBounds(GRID)
    expect(b[0]).toBeGreaterThanOrEqual(aoi[0])
    expect(b[2]).toBeLessThanOrEqual(aoi[2])
  })

  it('takes the union of burned area, latest perimeter, P90 reach and the reported point', () => {
    const burned = raster([[50, 50]])
    const p90 = raster([[50, 70]]) // 2.4 km east
    const perimeter = { rings: [[[0, -2000], [100, -2000]]] as [number, number][][] }
    const [plon, plat] = localToLonLat(-1500, 1000, GRID)
    const b = fireBounds({ grid: GRID, burned, p90, perimeter, point: { lon: plon, lat: plat } })!
    for (const [x, z] of [
      [0, 0],
      [2460, 0],
      [50, -2000],
      [-1500, 1000],
    ]) {
      const [lon, lat] = localToLonLat(x, z, GRID)
      expect(contains(b, lon, lat)).toBe(true)
    }
    expect(hasMappedFire({ grid: GRID, p90 })).toBe(true)
    expect(hasMappedFire({ grid: GRID, burned: raster([]) })).toBe(false)
  })

  it('a tiny fire still gets at least 3 km on each axis', () => {
    const s = spanM(fireBounds({ grid: GRID, burned: raster([[50, 50]]) })!)
    expect(s.x).toBeGreaterThanOrEqual(FIRE_MIN_SPAN_M - 1)
    expect(s.z).toBeGreaterThanOrEqual(FIRE_MIN_SPAN_M - 1)
    expect(s.x).toBeLessThan(FIRE_MIN_SPAN_M * 1.02)
  })

  it('never exceeds the AOI: a fire filling the grid frames the AOI', () => {
    const cells: [number, number][] = []
    for (let r = 0; r < N; r += 9) for (let c = 0; c < N; c += 9) cells.push([r, c])
    cells.push([99, 99])
    const b = fireBounds({ grid: GRID, burned: raster(cells) })!
    const aoi = aoiBounds(GRID)
    for (let i = 0; i < 4; i++) expect(b[i]).toBeCloseTo(aoi[i], 9)
  })

  it('a fire at the AOI edge is shifted inside, keeping its grown size', () => {
    const b = fireBounds({ grid: GRID, burned: raster([[0, 99]]) })!
    const aoi = aoiBounds(GRID)
    expect(b[2]).toBeLessThanOrEqual(aoi[2] + 1e-9)
    expect(b[3]).toBeLessThanOrEqual(aoi[3] + 1e-9)
    const s = spanM(b)
    expect(s.x).toBeGreaterThanOrEqual(FIRE_MIN_SPAN_M - 1)
  })

  it('without mapped data: 2.5 acreage radii around the reported point, at least 3 km, inside the AOI', () => {
    const [lon, lat] = localToLonLat(1000, -500, GRID)
    const r = acreageRadiusM(1000) // ~1.1 km
    expect(r).toBeCloseTo(Math.sqrt((1000 * 4046.8564224) / Math.PI), 6)
    const b = fireBounds({ grid: GRID, point: { lon, lat }, acres: 1000 })!
    const s = spanM(b)
    // the lon/lat box contains the slightly rotated UTM square (grid convergence): within 2 %
    expect(s.x).toBeGreaterThan(2 * 2.5 * r - 1)
    expect(s.x).toBeLessThan(2 * 2.5 * r * 1.02)
    const small = spanM(fireBounds({ grid: GRID, point: { lon, lat }, acres: 3 })!)
    expect(small.x).toBeGreaterThan(FIRE_MIN_SPAN_M - 1)
    expect(small.x).toBeLessThan(FIRE_MIN_SPAN_M * 1.02)
    // huge acreage around a point near the edge: clipped to the AOI
    const big = fireBounds({ grid: GRID, point: { lon, lat }, acres: 500_000 })!
    const aoi = aoiBounds(GRID)
    for (let i = 0; i < 4; i++) expect(big[i]).toBeCloseTo(aoi[i], 9)
  })

  it('without a bundle: a lon/lat box around the point; nothing to frame -> null', () => {
    const b = fireBounds({ point: { lon: -120.5, lat: 38.2 }, acres: 731 })!
    const half = 2.5 * acreageRadiusM(731)
    expect(b).toEqual(lonLatBoxAround(-120.5, 38.2, half))
    expect((b[3] - b[1]) * 111_320).toBeCloseTo(2 * half, 3)
    // unknown acreage: the 3 km minimum
    expect(fireBounds({ point: { lon: -120.5, lat: 38.2 }, acres: null })).toEqual(lonLatBoxAround(-120.5, 38.2, 1500))
    expect(fireBounds({ point: null })).toBeNull()
    expect(fireBounds({ point: { lon: Number.NaN, lat: 1 } })).toBeNull()
    // a grid without a point or mapped data: the AOI
    expect(fireBounds({ grid: GRID })).toEqual(aoiBounds(GRID))
  })
})

// Real bundles (skipped when the data folder is absent): the fire box is a small part of the AOI and holds every
// burned pixel and the reported point.
const base = new URL('../../../data/incidents/', import.meta.url)
const path = (u: URL) => decodeURIComponent(u.pathname)
for (const id of ['2025-eaton-fire-dbfa57', '2026-norte-fire-87ebb8']) {
  const dir = new URL(`${id}/`, base)
  const have = fs.existsSync(path(new URL('manifest.json', dir))) && fs.existsSync(path(new URL('layers/observed_arrival.bin', dir)))
  it.skipIf(!have)(`real ${id}: frames the fire inside the AOI`, () => {
    const m = JSON.parse(String(fs.readFileSync(path(new URL('manifest.json', dir)), 'utf8'))) as {
      grid: { utm_zone: number; center_e: number; center_n: number; extent_m: number; fire: { width: number; height: number } }
      summary: { lat: number; lon: number; acres: number | null }
    }
    const bytes = fs.readFileSync(path(new URL('layers/observed_arrival.bin', dir))) as Uint8Array
    const data = new Float32Array(new Uint8Array(bytes).buffer)
    const burned = { data, width: m.grid.fire.width, height: m.grid.fire.height }
    const b = fireBounds({ grid: m.grid, burned, point: { lon: m.summary.lon, lat: m.summary.lat }, acres: m.summary.acres })!
    const aoi = aoiBounds(m.grid)
    const area = (x: LonLatBox) => (x[2] - x[0]) * (x[3] - x[1])
    expect(area(b)).toBeLessThan(area(aoi))
    expect(contains(b, m.summary.lon, m.summary.lat)).toBe(true)
    const fb = rasterFireBox(burned, m.grid.extent_m)!
    for (const [x, z] of [
      [fb.minX, fb.minZ],
      [fb.maxX, fb.maxZ],
    ]) {
      const [lon, lat] = localToLonLat(x, z, m.grid)
      expect(contains(b, lon, lat)).toBe(true)
    }
  })
}
