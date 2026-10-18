// Alignment proof for the UTM -> Web Mercator overlays (BRIEF §4, §12; CONTRACT §4.3), in both UTM zones used by the
// bundles. References: lib/geo.ts (the Forensic conversions), data/rasters.ts pixelAt / pixelCenter (the location
// check sampling rule), the backend's bbox_lonlat (pyproj) and maplibre-gl's image-corner rounding.
import { describe, expect, it } from 'vitest'
import { pixelAt, pixelCenter } from '../data/rasters'
import * as geo from './geo'
import {
  aoiCornersLonLat,
  aoiMercatorBounds,
  aoiRingLonLat,
  buildOverlayMapping,
  gatherOverlay,
  imageTileZoom,
  insideAoiLonLat,
  latFromMercatorY,
  localToLonLat,
  lonFromMercatorX,
  lonLatToLocal,
  lonLatToUtm,
  MAPLIBRE_TILE_EXTENT,
  mercatorX,
  mercatorY,
  overlayMapping,
  overlayMappingCacheSize,
  overlayPixelOf,
  overlayPlacement,
  snapToImageTileGrid,
  utmToLonLat,
  type AoiGrid,
} from './reproject'

interface Case {
  name: string
  grid: AoiGrid
  w: number
  h: number
  /** manifest.grid.bbox_lonlat as written by the backend (pyproj) */
  bbox: [number, number, number, number]
}

// Copied from data/incidents/*/manifest.json (grid + fire grid size).
const CASES: Case[] = [
  {
    name: 'fixture-demo (EPSG:32611)',
    grid: { utm_zone: 11, center_e: 401418.0, center_n: 3784849.0, extent_m: 12000 },
    w: 400,
    h: 400,
    bbox: [-118.13583714201495, 34.1453099569298, -118.00424317746887, 34.254650417433155],
  },
  {
    name: 'fixture-live (EPSG:32610)',
    grid: { utm_zone: 10, center_e: 639349.0, center_n: 4007245.0, extent_m: 16000 },
    w: 512,
    h: 512,
    bbox: [-121.5403004508976, 36.12671761523128, -121.35954581318828, 36.273219255306735],
  },
  {
    name: '2025-eaton-fire-dbfa57 (EPSG:32611)',
    grid: { utm_zone: 11, center_e: 399738.0, center_n: 3784875.0, extent_m: 23000 },
    w: 512,
    h: 512,
    bbox: [-118.21451875868382, 34.095208180595876, -117.96225325627583, 34.30481289440777],
  },
  {
    // real zone-10 bundle
    name: '2026-cooley-fire-0c342f (EPSG:32610)',
    grid: { utm_zone: 10, center_e: 482910.0, center_n: 4298401.0, extent_m: 17000 },
    w: 512,
    h: 512,
    bbox: [-123.29515347766291, 38.757438427126885, -123.09886491130226, 38.91096487262208],
  },
  {
    // 50 km AOI straddling 120° W: its western part lies in zone 10's band but the grid stays zone 11
    name: '2025-madre-fire-01e7e8 (EPSG:32611, across 120° W)',
    grid: { utm_zone: 11, center_e: 238133.0, center_n: 3890615.0, extent_m: 50000 },
    w: 512,
    h: 512,
    bbox: [-120.15637464121401, 34.8924576094069, -119.59246594600481, 35.35575176119798],
  },
  {
    // small zone-10 grid that is not 512 px
    name: '2025-camino-fire-c606c9 (EPSG:32610, 272 px)',
    grid: { utm_zone: 10, center_e: 724301.0, center_n: 4181873.0, extent_m: 8000 },
    w: 272,
    h: 272,
    bbox: [-120.50042089960083, 37.71968774646396, -120.40722063759327, 37.79368393151623],
  },
]

/** Reference: source index of the pixel containing [lon, lat] via lib/geo.ts + data/rasters.ts pixelAt. */
function referenceIndex(c: Case, lon: number, lat: number): number {
  const [x, z] = geo.lonLatToLocal(lon, lat, c.grid)
  const px = pixelAt(x, z, c.grid.extent_m, c.w, c.h)
  return px ? px.index : -1
}

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('UTM conversions (three-free) match lib/geo.ts', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const r = rng(c.grid.utm_zone * 1000 + c.w)
      const h = c.grid.extent_m / 2
      for (let k = 0; k < 2000; k++) {
        // the AOI plus a 50 % margin on every side
        const x = (r() * 2 - 1) * h * 1.5
        const z = (r() * 2 - 1) * h * 1.5
        const a = localToLonLat(x, z, c.grid)
        const b = geo.localToLonLat(x, z, c.grid)
        expect(Math.abs(a[0] - b[0])).toBeLessThan(1e-12)
        expect(Math.abs(a[1] - b[1])).toBeLessThan(1e-12)
        const [x2, z2] = lonLatToLocal(a[0], a[1], c.grid)
        expect(Math.hypot(x2 - x, z2 - z)).toBeLessThan(1e-3) // round trip < 1 mm
        const u = lonLatToUtm(a[0], a[1], c.grid.utm_zone)
        const g = geo.lonLatToUtm(a[0], a[1], c.grid.utm_zone)
        expect(Math.hypot(u[0] - g[0], u[1] - g[1])).toBeLessThan(1e-6)
        // the 3-term Krüger series is a mm-accurate pair, not an exact inverse: 1e-8 deg ≈ 1 mm
        const ll = utmToLonLat(u[0], u[1], c.grid.utm_zone)
        expect(Math.abs(ll[0] - a[0]) + Math.abs(ll[1] - a[1])).toBeLessThan(1e-8)
        const g2 = geo.utmToLonLat(u[0], u[1], c.grid.utm_zone)
        expect(Math.abs(ll[0] - g2[0]) + Math.abs(ll[1] - g2[1])).toBeLessThan(1e-12)
      }
    })
  }
})

describe('AOI geometry', () => {
  for (const c of CASES) {
    it(`${c.name}: the true quadrilateral spans the backend bbox and is not axis-aligned`, () => {
      const ring = aoiRingLonLat(c.grid, 64)
      const lons = ring.map((p) => p[0])
      const lats = ring.map((p) => p[1])
      // the backend's bbox_lonlat (pyproj) is the lon/lat envelope of the same square (agreement ~1e-6 deg = 0.1 m)
      expect(Math.abs(Math.min(...lons) - c.bbox[0])).toBeLessThan(2e-6)
      expect(Math.abs(Math.min(...lats) - c.bbox[1])).toBeLessThan(2e-6)
      expect(Math.abs(Math.max(...lons) - c.bbox[2])).toBeLessThan(2e-6)
      expect(Math.abs(Math.max(...lats) - c.bbox[3])).toBeLessThan(2e-6)
      const [nw, ne, se, sw] = aoiCornersLonLat(c.grid)
      // UTM grid convergence rotates the square in lon/lat: the north edge is not a parallel
      expect(Math.abs(nw[1] - ne[1])).toBeGreaterThan(1e-4)
      expect(Math.abs(sw[0] - nw[0])).toBeGreaterThan(1e-4)
      // corners are exactly the UTM corners
      const h = c.grid.extent_m / 2
      const expectAt = (p: [number, number], x: number, z: number) => {
        const [px, pz] = geo.lonLatToLocal(p[0], p[1], c.grid)
        expect(Math.hypot(px - x, pz - z)).toBeLessThan(1e-3)
      }
      expectAt(nw, -h, -h)
      expectAt(ne, h, -h)
      expectAt(se, h, h)
      expectAt(sw, -h, h)
      expect(insideAoiLonLat(...localToLonLat(0, 0, c.grid), c.grid)).toBe(true)
      expect(insideAoiLonLat(...localToLonLat(h + 1, 0, c.grid), c.grid)).toBe(false)
    })
  }
})

describe('overlay placement matches maplibre-gl corner rounding', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const p = overlayPlacement(c.grid, c.w, c.h)
      // the snapped rectangle contains the whole AOI
      const b = aoiMercatorBounds(c.grid)
      expect(p.minX).toBeLessThanOrEqual(b.minX)
      expect(p.minY).toBeLessThanOrEqual(b.minY)
      expect(p.maxX).toBeGreaterThanOrEqual(b.maxX)
      expect(p.maxY).toBeGreaterThanOrEqual(b.maxY)
      // maplibre-gl: tileID = getCoordinatesCenterTileID(corners); tileCoords = round((coord · 2^z − tile) · 8192)
      const xs = p.coordinates.map(([lon]) => mercatorX(lon))
      const ys = p.coordinates.map(([, lat]) => mercatorY(lat))
      const bounds = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
      const z = imageTileZoom(bounds)
      expect(z).toBe(p.tileZoom)
      const n = Math.pow(2, z)
      const tx = Math.floor(((bounds.minX + bounds.maxX) / 2) * n)
      const ty = Math.floor(((bounds.minY + bounds.maxY) / 2) * n)
      for (let k = 0; k < 4; k++) {
        const u = (xs[k] * n - tx) * MAPLIBRE_TILE_EXTENT
        const v = (ys[k] * n - ty) * MAPLIBRE_TILE_EXTENT
        expect(Math.abs(u - Math.round(u))).toBeLessThan(1e-6)
        expect(Math.abs(v - Math.round(v))).toBeLessThan(1e-6)
        // MapLibre's int16 vertex range
        expect(Math.abs(Math.round(u))).toBeLessThan(32768)
        expect(Math.abs(Math.round(v))).toBeLessThan(32768)
      }
      // corner order TL, TR, BR, BL
      expect(p.coordinates[0][1]).toBeGreaterThan(p.coordinates[3][1])
      expect(p.coordinates[1][0]).toBeGreaterThan(p.coordinates[0][0])
      // about 2 output pixels per source pixel
      const outPerSrc = (p.width * (b.maxX - b.minX)) / (p.maxX - p.minX) / c.w
      expect(outPerSrc).toBeGreaterThan(1.9)
      expect(outPerSrc).toBeLessThan(2.2)
    })
  }

  it('snapping that widens the bounds past a tile size lowers the tile zoom', () => {
    const unit10 = Math.pow(2, 10) * MAPLIBRE_TILE_EXTENT
    const b = { minX: 0.3 + 0.25 / unit10, minY: 0.4, maxX: 0.3 + 0.25 / unit10 + Math.pow(2, -10) - 0.1 / unit10, maxY: 0.4 + 1e-4 }
    expect(imageTileZoom(b)).toBe(10)
    const s = snapToImageTileGrid(b)
    expect(s.tileZoom).toBe(9)
    expect(s.minX).toBeLessThanOrEqual(b.minX)
    expect(s.maxX).toBeGreaterThanOrEqual(b.maxX)
    const unit9 = Math.pow(2, 9) * MAPLIBRE_TILE_EXTENT
    expect(Number.isInteger(Math.round(s.minX * unit9 * 1e6) / 1e6)).toBe(true)
  })
})

describe('per-pixel inverse mapping', () => {
  it('fixture-demo: every output pixel equals the lib/geo.ts + pixelAt reference', () => {
    const c = CASES[0]
    const m = buildOverlayMapping(c.grid, c.w, c.h)
    const dx = (m.maxX - m.minX) / m.width
    const dy = (m.maxY - m.minY) / m.height
    let mismatches = 0
    for (let j = 0; j < m.height; j++) {
      const lat = latFromMercatorY(m.minY + (j + 0.5) * dy)
      for (let i = 0; i < m.width; i++) {
        const lon = lonFromMercatorX(m.minX + (i + 0.5) * dx)
        if (m.index[j * m.width + i] !== referenceIndex(c, lon, lat)) mismatches++
      }
    }
    expect(mismatches).toBe(0)
  })

  for (const c of CASES) {
    it(`${c.name}: sampled output pixels equal the reference, outside the AOI is −1`, () => {
      const m = overlayMapping(c.grid, c.w, c.h)
      const dx = (m.maxX - m.minX) / m.width
      const dy = (m.maxY - m.minY) / m.height
      let checked = 0
      let outside = 0
      for (let j = 0; j < m.height; j += 3) {
        const lat = latFromMercatorY(m.minY + (j + 0.5) * dy)
        for (let i = (j * 7) % 5; i < m.width; i += 5) {
          const lon = lonFromMercatorX(m.minX + (i + 0.5) * dx)
          const ref = referenceIndex(c, lon, lat)
          expect(m.index[j * m.width + i]).toBe(ref)
          if (ref < 0) outside++
          checked++
        }
      }
      // every 3rd row and 5th column: about 1/15 of the output pixels
      expect(checked).toBeGreaterThan((m.width * m.height) / 16)
      expect(outside).toBeGreaterThan(0) // the rotated square leaves the canvas corners empty
    })

    it(`${c.name}: source pixel centres at interior points, all four edges and corners map back to themselves`, () => {
      const m = overlayMapping(c.grid, c.w, c.h)
      const rows = [0, 1, Math.floor(c.h / 3), Math.floor(c.h / 2), c.h - 2, c.h - 1]
      const cols = [0, 1, Math.floor(c.w / 4), Math.floor(c.w / 2), c.w - 2, c.w - 1]
      for (const r of rows) {
        for (const col of cols) {
          const { x, z } = pixelCenter(r, col, c.grid.extent_m, c.w, c.h)
          const [lon, lat] = geo.localToLonLat(x, z, c.grid)
          const px = overlayPixelOf(m, lon, lat)
          expect(px).not.toBeNull()
          expect(m.index[px!.j * m.width + px!.i]).toBe(r * c.w + col)
        }
      }
    })

    it(`${c.name}: points one source pixel beyond each edge and corner are transparent`, () => {
      const m = overlayMapping(c.grid, c.w, c.h)
      const h = c.grid.extent_m / 2
      const d = c.grid.extent_m / c.w // one source pixel
      const probes: [number, number][] = []
      for (const f of [-1, -0.5, 0, 0.5, 1]) {
        const t = f * (h - d / 2)
        probes.push([t, -h - d], [t, h + d], [-h - d, t], [h + d, t]) // north, south, west, east
      }
      probes.push([-h - d, -h - d], [h + d, -h - d], [h + d, h + d], [-h - d, h + d])
      for (const [x, z] of probes) {
        const [lon, lat] = geo.localToLonLat(x, z, c.grid)
        const px = overlayPixelOf(m, lon, lat)
        if (px) expect(m.index[px.j * m.width + px.i]).toBe(-1)
      }
      // half a source pixel inside each edge (on a pixel centre line) the edge pixel shows: an output pixel's centre
      // lies within 0.36 source pixels of any point it contains, so it stays inside that edge pixel
      const mid = pixelCenter(Math.floor(c.h / 2), Math.floor(c.w / 2), c.grid.extent_m, c.w, c.h)
      for (const [x, z, row, col] of [
        [mid.x, -h + d / 2, 0, Math.floor(c.w / 2)],
        [mid.x, h - d / 2, c.h - 1, Math.floor(c.w / 2)],
        [-h + d / 2, mid.z, Math.floor(c.h / 2), 0],
        [h - d / 2, mid.z, Math.floor(c.h / 2), c.w - 1],
      ] as const) {
        const [lon, lat] = geo.localToLonLat(x, z, c.grid)
        const px = overlayPixelOf(m, lon, lat)!
        expect(m.index[px.j * m.width + px.i]).toBe(row * c.w + col)
      }
    })

    it(`${c.name}: every source pixel is shown at least once (no data dropped)`, () => {
      const m = overlayMapping(c.grid, c.w, c.h)
      const seen = new Uint8Array(c.w * c.h)
      for (let k = 0; k < m.index.length; k++) if (m.index[k] >= 0) seen[m.index[k]] = 1
      let missing = 0
      for (let k = 0; k < seen.length; k++) if (!seen[k]) missing++
      expect(missing).toBe(0)
    })
  }

  it('caches mappings per grid and builds a 512 x 512 mapping quickly', () => {
    const c = CASES[2]
    const t0 = performance.now()
    const a = buildOverlayMapping(c.grid, c.w, c.h)
    const ms = performance.now() - t0
    console.info(`buildOverlayMapping ${c.w}x${c.h} -> ${a.width}x${a.height}: ${ms.toFixed(0)} ms`)
    expect(ms).toBeLessThan(2000)
    const b = overlayMapping(c.grid, c.w, c.h)
    expect(overlayMapping(c.grid, c.w, c.h)).toBe(b)
    let diff = 0
    for (let k = 0; k < a.index.length; k++) if (a.index[k] !== b.index[k]) diff++
    expect(diff).toBe(0)
    expect(overlayMappingCacheSize()).toBeGreaterThan(0)
  })

  it('gathers per-source colours without changing them', () => {
    const src = new Uint32Array([11, 22, 33, 44])
    const out = new Uint32Array(5)
    gatherOverlay({ index: new Int32Array([3, -1, 0, 2, 1]) }, src, out)
    expect(Array.from(out)).toEqual([44, 0, 11, 33, 22])
  })
})
