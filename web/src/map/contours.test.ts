import { describe, expect, it } from 'vitest'
import { lonLatToLocal } from '../lib/reproject'
import { maskGeometry, maskRings, pointInRing, ringArea, ringsToPolygons, ringToLonLat } from './contours'

/** Mask from rows of '#' (inside) and '.' (outside). */
function mask(rows: string[]): { m: Uint8Array; w: number; h: number } {
  const h = rows.length
  const w = rows[0].length
  const m = new Uint8Array(w * h)
  rows.forEach((row, r) => [...row].forEach((ch, c) => (m[r * w + c] = ch === '#' ? 1 : 0)))
  return { m, w, h }
}

const GRID = { utm_zone: 11, center_e: 401418.0, center_n: 3784849.0, extent_m: 12000 }

describe('maskRings', () => {
  it('a single pixel gives a diamond through the midpoints to its neighbours (outer ring: negative area)', () => {
    const { m, w, h } = mask(['...', '.#.', '...'])
    const rings = maskRings(m, w, h)
    expect(rings).toHaveLength(1)
    expect(rings[0].area).toBeCloseTo(-0.5)
    const pts = rings[0].pts
    const xs = pts.filter((_, i) => i % 2 === 0)
    const ys = pts.filter((_, i) => i % 2 === 1)
    expect(Math.min(...xs)).toBe(0.5)
    expect(Math.max(...xs)).toBe(1.5)
    expect(Math.min(...ys)).toBe(0.5)
    expect(Math.max(...ys)).toBe(1.5)
  })

  it('a block follows the pixel-block edge with chamfered corners and drops collinear vertices', () => {
    const { m, w, h } = mask(['....', '.##.', '.##.', '....'])
    const rings = maskRings(m, w, h)
    expect(rings).toHaveLength(1)
    expect(rings[0].area).toBeCloseTo(-(4 - 4 * 0.125))
    expect(rings[0].pts.length / 2).toBe(8) // octagon: 4 straight sides + 4 chamfers
  })

  it('closes rings along the grid edge (padding counts as outside)', () => {
    const { m, w, h } = mask(['##', '##'])
    const rings = maskRings(m, w, h)
    expect(rings).toHaveLength(1)
    const xs = rings[0].pts.filter((_, i) => i % 2 === 0)
    expect(Math.min(...xs)).toBe(-0.5) // the west edge of column 0 = the AOI edge
    expect(Math.max(...xs)).toBe(1.5)
  })

  it('treats diagonal neighbours as connected', () => {
    const { m, w, h } = mask(['....', '.#..', '..#.', '....'])
    expect(maskRings(m, w, h)).toHaveLength(1)
  })

  it('finds holes (positive area) and assigns them to the right outer ring, also when nested', () => {
    const { m, w, h } = mask([
      '.........',
      '.#######.',
      '.#.....#.',
      '.#.###.#.',
      '.#.#.#.#.',
      '.#.###.#.',
      '.#.....#.',
      '.#######.',
      '.........',
    ])
    const rings = maskRings(m, w, h)
    expect(rings.filter((r) => r.area < 0)).toHaveLength(2)
    expect(rings.filter((r) => r.area > 0)).toHaveLength(2)
    const polys = ringsToPolygons(rings)
    expect(polys).toHaveLength(2)
    const big = polys.find((p) => -p[0].area > 20)!
    const small = polys.find((p) => -p[0].area < 20)!
    expect(big).toHaveLength(2) // outer square + the ring-shaped gap
    expect(small).toHaveLength(2) // inner square + its centre hole
    expect(pointInRing(4, 4, small[1].pts)).toBe(true)
  })

  it('drops small outer rings with minArea', () => {
    const { m, w, h } = mask(['#....', '.....', '..###', '..###'])
    expect(ringsToPolygons(maskRings(m, w, h))).toHaveLength(2)
    expect(ringsToPolygons(maskRings(m, w, h), 1)).toHaveLength(1)
  })

  it('ringArea is the shoelace area', () => {
    expect(ringArea([0, 0, 2, 0, 2, 1, 0, 1])).toBe(2)
  })
})

describe('lon/lat geometry', () => {
  it('outer rings are counter-clockwise in lon/lat and sit on the pixel-block edges in local metres', () => {
    const w = 400
    const h = 400
    const m = new Uint8Array(w * h)
    for (let r = 100; r < 150; r++) for (let c = 0; c < 60; c++) m[r * w + c] = 1
    const { polygons, lines } = maskGeometry(m, w, h, GRID)
    expect(polygons).toHaveLength(1)
    expect(lines).toHaveLength(1)
    const ring = polygons[0][0]
    expect(ring[0]).toEqual(ring[ring.length - 1])
    const flat = ring.slice(0, -1).flat()
    expect(ringArea(flat)).toBeGreaterThan(0)
    // west side on the AOI edge (x = -6000), north side between rows 99 and 100: z = -6000 + 100 * 30
    const local = ring.map(([lon, lat]) => lonLatToLocal(lon, lat, GRID))
    const xs = local.map((p) => p[0])
    const zs = local.map((p) => p[1])
    expect(Math.min(...xs)).toBeCloseTo(-6000, 2)
    expect(Math.max(...xs)).toBeCloseTo(-6000 + 60 * 30, 2)
    expect(Math.min(...zs)).toBeCloseTo(-6000 + 100 * 30, 2)
    expect(Math.max(...zs)).toBeCloseTo(-6000 + 150 * 30, 2)
  })

  it('ringToLonLat closes the ring', () => {
    const out = ringToLonLat([0.5, 0, 1, 0.5, 0.5, 1, 0, 0.5], GRID, 10, 10)
    expect(out).toHaveLength(5)
    expect(out[4]).toEqual(out[0])
  })
})
