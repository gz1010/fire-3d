import { describe, expect, it } from 'vitest'
import { NEVER } from '../api/types'
import { makeLayer, square } from './fixtures.testutil'
import { burnedFootprint, nearestOnRings, pointInRings, type Ring } from './geometry'

describe('pointInRings (even-odd over exteriors and holes)', () => {
  const outer = square(0, 0, 1000)
  const hole = square(200, 200, 100)
  const island = square(5000, 0, 300) // second part of a multi-polygon

  it('handles a simple square, its edges and corners', () => {
    expect(pointInRings(0, 0, [outer])).toBe(true)
    expect(pointInRings(999, -999, [outer])).toBe(true)
    expect(pointInRings(1001, 0, [outer])).toBe(false)
    expect(pointInRings(1000, 0, [outer])).toBe(true) // on the edge counts as inside
    expect(pointInRings(1000, 1000, [outer])).toBe(true) // corner
    expect(pointInRings(0, -1000.5, [outer])).toBe(false)
  })
  it('treats rings inside rings as holes and separate rings as more parts', () => {
    const rings = [outer, hole, island]
    expect(pointInRings(200, 200, rings)).toBe(false) // in the hole
    expect(pointInRings(400, 200, rings)).toBe(true)
    expect(pointInRings(5000, 100, rings)).toBe(true) // in the island
    expect(pointInRings(3000, 0, rings)).toBe(false)
  })
  it('works for a concave (L-shaped) ring regardless of winding', () => {
    const l: Ring = [
      [0, 0],
      [0, 300],
      [100, 300],
      [100, 100],
      [300, 100],
      [300, 0],
      [0, 0],
    ]
    const rev = [...l].reverse()
    for (const r of [l, rev]) {
      expect(pointInRings(50, 250, [r])).toBe(true)
      expect(pointInRings(250, 50, [r])).toBe(true)
      expect(pointInRings(250, 250, [r])).toBe(false) // the notch
    }
  })
  it('is false without rings', () => {
    expect(pointInRings(0, 0, [])).toBe(false)
  })
})

describe('nearestOnRings', () => {
  it('projects onto the nearest edge, including the closing edge and holes', () => {
    const outer = square(0, 0, 1000)
    expect(nearestOnRings(2000, 0, [outer])).toEqual({ x: 1000, z: 0, distance: 1000 })
    expect(nearestOnRings(2000, 2000, [outer])).toEqual({ x: 1000, z: 1000, distance: Math.hypot(1000, 1000) })
    const open: Ring = [
      [0, 0],
      [100, 0],
      [100, 100],
    ] // the closing edge (100,100) -> (0,0) is used too
    const n = nearestOnRings(0, 100, [open])!
    expect(n.distance).toBeCloseTo(Math.SQRT1_2 * 100, 9)
    const hole = square(200, 200, 100)
    expect(nearestOnRings(200, 200, [outer, hole])!.distance).toBe(100)
    expect(nearestOnRings(0, 0, [])).toBeNull()
  })
})

describe('burnedFootprint (reconstructed burned area from an arrival raster)', () => {
  // 10 x 10 grid over 1000 m (100 m cells, AOI x,z in [-500, 500]); cells (r 2..3, c 6..7) burned at 5 h, (r 3, c 8) at 9 h
  const n = 10
  const ext = 1000
  const arr = makeLayer('observed_arrival', n, (r, c) => (r >= 2 && r <= 3 && c >= 6 && c <= 7 ? 5 : r === 3 && c === 8 ? 9 : NEVER))

  it('counts burned cells up to the time and finds the nearest one', () => {
    // point at the centre of cell (r 5, c 2): x = -250, z = 50
    const fp = burnedFootprint(arr, ext, -250, 50, 6)!
    expect(fp.inside).toBe(false)
    expect(fp.cells).toBe(4)
    expect(fp.areaM2).toBe(40_000)
    expect(fp.latestArrivalH).toBe(5)
    // nearest burned cell (r 3, c 6) spans x [100, 200], z [-200, -100]: closest point (100, -100)
    expect(fp.nearest).toEqual({ x: 100, z: -100, distance: Math.hypot(350, 150) })
    expect(burnedFootprint(arr, ext, -250, 50, 9)!.cells).toBe(5)
  })
  it('reports inside with the distance to the nearest unburned cell', () => {
    // centre of cell (r 2, c 6): x = 150, z = -250; the unburned neighbour (r 1, c 6) starts at z = -300 -> 50 m
    const fp = burnedFootprint(arr, ext, 150, -250, 6)!
    expect(fp.inside).toBe(true)
    expect(fp.nearest.distance).toBe(0)
    expect(fp.edge!.distance).toBeCloseTo(50, 9)
  })
  it('is null before anything burned and ignores NEVER, NaN and nodata', () => {
    expect(burnedFootprint(arr, ext, 0, 0, 4.99)).toBeNull()
    const odd = makeLayer('observed_arrival', 4, (r, c) => (r === 0 && c === 0 ? Number.NaN : r === 0 && c === 1 ? -9999 : r === 1 && c === 1 ? 2 : NEVER), { nodata: -9999 })
    const fp = burnedFootprint(odd, 400, 0, 0, 10)!
    expect(fp.cells).toBe(1)
  })
  it('works for points outside the AOI (distance to the nearest burned cell)', () => {
    const fp = burnedFootprint(arr, ext, 900, -250, 6)!
    expect(fp.inside).toBe(false)
    expect(fp.nearest).toEqual({ x: 300, z: -250, distance: 600 }) // cell (r 2, c 7) spans x [200, 300]
  })
  it('gives the east and south AOI edges to the last column and row', () => {
    const corner = makeLayer('observed_arrival', n, (r, c) => (r === n - 1 && c === n - 1 ? 1 : NEVER))
    expect(burnedFootprint(corner, ext, 500, 500, 2)!.inside).toBe(true)
  })
})
