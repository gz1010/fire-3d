import { describe, expect, it } from 'vitest'
import {
  bboxContains,
  bboxDistanceKm,
  distanceText,
  geometriesBounds,
  geometryContains,
  pointPolygonDistanceKm,
  polygonContains,
  polygonFireDistanceKm,
  polygonOverlapsRing,
  thinRing,
  type LonLat,
} from './geo'
import type { GeoPolygon } from './types'

const sq = (x: number, y: number, s: number): number[][] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
]
const poly = (...rings: number[][][]): GeoPolygon => ({ type: 'Polygon', coordinates: rings })

describe('point in polygon', () => {
  it('respects holes and multipolygons', () => {
    const withHole = [sq(0, 0, 1), sq(0.4, 0.4, 0.2)]
    expect(polygonContains(withHole, 0.1, 0.1)).toBe(true)
    expect(polygonContains(withHole, 0.5, 0.5)).toBe(false)
    const multi: GeoPolygon = { type: 'MultiPolygon', coordinates: [[sq(0, 0, 1)], [sq(5, 5, 1)]] }
    expect(geometryContains(multi, 5.5, 5.5)).toBe(true)
    expect(geometryContains(multi, 3, 3)).toBe(false)
    expect(geometryContains(null, 0, 0)).toBe(false)
  })

  it('checks boxes', () => {
    expect(bboxContains([0, 0, 1, 1], 0.5, 1)).toBe(true)
    expect(bboxContains([0, 0, 1, 1], 1.01, 0.5)).toBe(false)
    expect(bboxContains(null, 0, 0)).toBe(false)
  })
})

describe('distances (km, local approximation)', () => {
  it('is 0 inside and about 111 km per degree of latitude outside', () => {
    const g = poly(sq(-118.2, 34, 0.1))
    expect(pointPolygonDistanceKm(g, -118.15, 34.05)).toBe(0)
    expect(pointPolygonDistanceKm(g, -118.15, 35.1)).toBeCloseTo(110.6, 0)
    expect(bboxDistanceKm([-118.2, 34, -118.1, 34.1], -118.15, 35.1)).toBeCloseTo(110.6, 0)
  })

  it('measures a zone to the nearest fire point or ring, 0 when they overlap, and prunes without changing the answer', () => {
    const zone = poly(sq(0, 0, 0.1))
    const far: LonLat[] = Array.from({ length: 50 }, (_, i) => [1 + i * 0.01, 1] as LonLat)
    const near: LonLat = [0.15, 0.05]
    const d = polygonFireDistanceKm(zone, { points: [...far, near], rings: [] })!
    expect(d).toBeCloseTo(0.05 * 111.32, 1)
    // brute force over the same points gives the same minimum
    const brute = Math.min(...[...far, near].map(([x, y]) => pointPolygonDistanceKm(zone, x, y)))
    expect(d).toBeCloseTo(brute, 9)
    expect(polygonFireDistanceKm(zone, { points: [], rings: [[[0.05, 0.05], [0.3, 0.05], [0.3, 0.3], [0.05, 0.3]]] })).toBe(0)
    expect(polygonFireDistanceKm(zone, { points: [], rings: [] })).toBeNull()
  })

  it('tells overlap from separation, including a zone inside a ring and a ring inside a zone', () => {
    const zone = poly(sq(0, 0, 1))
    expect(polygonOverlapsRing(zone, [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.4]])).toBe(true) // ring inside zone
    expect(polygonOverlapsRing(poly(sq(0.2, 0.2, 0.1)), [[0, 0], [1, 0], [1, 1], [0, 1]])).toBe(true) // zone inside ring
    expect(polygonOverlapsRing(zone, [[2, 2], [3, 2], [3, 3], [2, 3]])).toBe(false)
    expect(polygonOverlapsRing(zone, [[0.5, -1], [0.6, -1], [0.6, 2], [0.5, 2]])).toBe(true) // edges cross only
  })
})

describe('helpers', () => {
  it('bounds outer rings and thins long rings', () => {
    expect(geometriesBounds([poly(sq(0, 0, 1)), { type: 'MultiPolygon', coordinates: [[sq(5, 5, 1)]] }, null])).toEqual([0, 0, 6, 6])
    expect(geometriesBounds([])).toBeNull()
    const ring = Array.from({ length: 1000 }, (_, i) => [i, 0] as LonLat)
    const t = thinRing(ring, 100)
    expect(t.length).toBeLessThanOrEqual(101)
    expect(t[t.length - 1]).toEqual([999, 0])
  })

  it('writes distances in miles or kilometres', () => {
    expect(distanceText(27, false)).toBe('17 mi')
    expect(distanceText(1.2, false)).toBe('0.7 mi')
    expect(distanceText(27, true)).toBe('27 km')
    expect(distanceText(0.01, true)).toBe('under 0.1 km')
  })
})
