import { describe, expect, it } from 'vitest'
import {
  circleHitsRect,
  gutterEdge,
  labelBox,
  layoutLeaders,
  leaderAcres,
  LEADER_MAX,
  rectsOverlap,
  segmentHitsRect,
  type LeaderItem,
  type Rect,
} from './leaderLayout'

const free: Rect = { left: 12, top: 150, right: 1428, bottom: 1040 }
const item = (id: string, x: number, y: number, w = 90, h = 28, r = 15): LeaderItem => ({ id, at: { x, y }, r, w, h })

describe('geometry helpers', () => {
  it('rectangles, circles and segments', () => {
    expect(rectsOverlap({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 9, top: 9, right: 20, bottom: 20 })).toBe(true)
    expect(rectsOverlap({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false)
    expect(circleHitsRect({ x: 0, y: 0, r: 5 }, { left: 3, top: 3, right: 9, bottom: 9 })).toBe(true)
    expect(circleHitsRect({ x: 0, y: 0, r: 4 }, { left: 3, top: 3, right: 9, bottom: 9 })).toBe(false)
    const r = { left: 10, top: 10, right: 20, bottom: 20 }
    expect(segmentHitsRect({ x: 0, y: 15 }, { x: 30, y: 15 }, r)).toBe(true)
    expect(segmentHitsRect({ x: 0, y: 0 }, { x: 9, y: 30 }, r)).toBe(false)
    expect(segmentHitsRect({ x: 12, y: 12 }, { x: 14, y: 14 }, r)).toBe(true)
  })

  it('a label box sits after the leader, its middle on the leader end', () => {
    expect(labelBox({ x: 100, y: 50 }, { w: 80, h: 28 }, 'right')).toEqual({ left: 104, top: 36, right: 184, bottom: 64 })
    expect(labelBox({ x: 100, y: 50 }, { w: 80, h: 28 }, 'left')).toEqual({ left: 16, top: 36, right: 96, bottom: 64 })
  })

  it('acres in mono capitals', () => {
    expect(leaderAcres(172_912, 'us')).toBe('172,912 AC')
    expect(leaderAcres(172_912, 'metric')).toBe('69,975 HA')
  })
})

describe('layoutLeaders (decision e)', () => {
  it('a fire in the middle of the map: up and to the right, no overlap with its own marker', () => {
    const [s] = layoutLeaders([item('a', 600, 500)], { free })
    expect(s.side).toBe('right')
    expect(s.kind).toBe('diagonal')
    expect(s.end.y).toBeLessThan(500)
    expect(circleHitsRect({ x: 600, y: 500, r: 15 }, s.box)).toBe(false)
  })

  it('west-coast fires: a right-aligned gutter column at the free map\'s left edge, one row each', () => {
    const items = [item('a', 212, 357), item('b', 216, 387), item('c', 208, 400), item('d', 203, 459)]
    const spots = layoutLeaders(items, { free })
    expect(spots.map((s) => s.kind)).toEqual(['gutter', 'gutter', 'gutter', 'gutter'])
    const gx = gutterEdge(items, free)
    for (const s of spots) expect(s.box.right).toBe(gx)
    for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) expect(rectsOverlap(spots[i].box, spots[j].box)).toBe(false)
  })

  it('labels never overlap each other, other markers, chrome or leaders; at most 12', () => {
    const items = Array.from({ length: 30 }, (_, i) => item(`f${i}`, 300 + (i % 6) * 120, 300 + Math.floor(i / 6) * 110))
    const circles = items.map((i) => ({ x: i.at.x, y: i.at.y, r: 15, id: i.id }))
    const chrome = { left: 956, top: 160, right: 1428, bottom: 900 }
    const spots = layoutLeaders(items, { free, circles, obstacles: [chrome] })
    expect(spots.length).toBeLessThanOrEqual(LEADER_MAX)
    expect(spots.length).toBeGreaterThan(4)
    for (const s of spots) {
      expect(rectsOverlap(s.box, chrome)).toBe(false)
      for (const c of circles) expect(circleHitsRect(c, s.box)).toBe(false)
      for (const t of spots) if (t !== s) {
        expect(rectsOverlap(s.box, t.box)).toBe(false)
        expect(segmentHitsRect(t.at, t.end, s.box)).toBe(false)
      }
    }
  })

  it('a fire outside the free map, or with no free spot, is left out (its MapLibre label shows instead)', () => {
    expect(layoutLeaders([item('a', 5, 500)], { free })).toEqual([])
    const blocked = layoutLeaders([item('a', 600, 500)], { free, obstacles: [{ left: 400, top: 300, right: 800, bottom: 700 }] })
    expect(blocked).toEqual([])
  })
})
