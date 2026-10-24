import { describe, expect, it } from 'vitest'
import type { Perimeter } from '../api/types'
import { DEFAULT_MAP_LAYERS } from '../state/workspace'
import { mapProfileOf, newestPerimeter, perimeterStale, PERIMETER_STALE_MS, profileLayers, PUBLIC_FIRE_HIDDEN, ringPolygons } from './fireProfile'

const sq = (x: number, y: number, s: number): [number, number][] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
]

describe('the Public fire view map profile (decision a)', () => {
  it('applies in Public with a fire open only', () => {
    expect(mapProfileOf('public', true)).toBe('public-fire')
    expect(mapProfileOf('public', false)).toBe('full')
    expect(mapProfileOf('command', true)).toBe('full')
    expect(mapProfileOf('command', false)).toBe('full')
  })

  it('leaves out the model, the observed estimate, detections and events, and keeps the rest as the user set it', () => {
    const shown = profileLayers('public-fire', { ...DEFAULT_MAP_LAYERS, cameras: true })
    for (const k of PUBLIC_FIRE_HIDDEN) expect(shown[k]).toBe(false)
    expect(PUBLIC_FIRE_HIDDEN).toEqual(['observed', 'forecast', 'detections', 'events'])
    expect(shown.perimeters).toBe(true)
    expect(shown.evacuation).toBe(true)
    expect(shown.selection).toBe(true)
    expect(shown.cameras).toBe(true)
    // the full map changes nothing, and the user's choices are not touched
    const layers = { ...DEFAULT_MAP_LAYERS, perimeters: false }
    expect(profileLayers('full', layers)).toEqual(layers)
    profileLayers('public-fire', layers)
    expect(layers.observed).toBe(true)
  })

  it('picks the newest perimeter whatever the timeline time', () => {
    const p = (t: number, rings = [sq(0, 0, 1)]): Perimeter => ({ t_ms: t, acres: t, source: 'NIFC WFIGS', rings })
    expect(newestPerimeter(null)).toBeNull()
    expect(newestPerimeter([])).toBeNull()
    const list = [p(3), p(9), p(5)]
    expect(newestPerimeter(list)).toBe(list[1])
    // ties: the last one; a perimeter without rings is skipped
    const tie = [p(9), p(9), p(12, [])]
    expect(newestPerimeter(tie)).toBe(tie[1])
  })

  it('tags a live fire perimeter older than a day as stale, never a past fire', () => {
    const now = 1_000 * PERIMETER_STALE_MS
    expect(perimeterStale(now - PERIMETER_STALE_MS - 1, now, true)).toBe(true)
    expect(perimeterStale(now - PERIMETER_STALE_MS + 1, now, true)).toBe(false)
    expect(perimeterStale(now - 100 * PERIMETER_STALE_MS, now, false)).toBe(false)
  })

  it('groups unlabelled rings into polygons with their holes (even-odd)', () => {
    // two separate parts, the first with a hole that holds an island
    const rings = [sq(0, 0, 10), sq(2, 2, 6), sq(4, 4, 2), sq(20, 0, 5), [[0, 0], [1, 1]] as [number, number][]]
    const polys = ringPolygons(rings).map((p) => [...p])
    expect(polys).toHaveLength(3)
    expect(polys).toContainEqual([0, 1])
    expect(polys).toContainEqual([2])
    expect(polys).toContainEqual([3])
    // order of the rings does not matter
    const shuffled = [rings[2], rings[3], rings[1], rings[0]]
    expect(ringPolygons(shuffled)).toHaveLength(3)
    expect(ringPolygons(shuffled)).toContainEqual([3, 2])
  })
})
