import { describe, expect, it } from 'vitest'
import { hintBox, placeHint, type Box } from './hintPlacement'

const box = (left: number, top: number, w: number, h: number): Box => ({ left, top, right: left + w, bottom: top + h })
const size = { w: 300, h: 96 }
const view = { w: 1440, h: 1000 }
const hits = (b: Box, o: Box) => b.left < o.right && o.left < b.right && b.top < o.bottom && o.top < b.bottom

describe('the one-time rotate hint never covers a readout, a panel or official text (brief 4 H3)', () => {
  it('Command: the bar sits bottom-left under the readout; the hint goes above it, slid right past the readout', () => {
    const ctl = box(40, 810, 545, 50)
    const readout = box(40, 100, 420, 690)
    const official = box(1020, 100, 380, 360)
    const legend = box(625, 810, 775, 50)
    const timeline = box(40, 880, 1360, 72)
    const p = placeHint(ctl, size, view, [readout, official, legend, timeline], 'above')
    expect(p).not.toBeNull()
    expect(p?.covered).toBe(0)
    expect(p?.side).toBe('above')
    const b = hintBox(p!.left, p!.top, size)
    for (const o of [readout, official, legend, timeline, ctl]) expect(hits(b, o)).toBe(false)
  })

  it('overview details: the bar at the top left; below it unless a location card is there', () => {
    const ctl = box(28, 160, 610, 50)
    const free = placeHint(ctl, size, view, [box(956, 160, 472, 740)], 'below')
    expect(free).toMatchObject({ side: 'below', left: 28, top: 218, covered: 0 })
    const card = box(28, 222, 360, 420)
    const p = placeHint(ctl, size, view, [card, box(956, 160, 472, 740)], 'below')
    expect(p?.covered).toBe(0)
    expect(hits(hintBox(p!.left, p!.top, size), card)).toBe(false)
  })

  it('stays inside the window; when nothing is free, takes the place that covers the least', () => {
    const ctl = box(8, 8, 200, 40)
    const p = placeHint(ctl, size, { w: 320, h: 160 }, [box(0, 60, 320, 100)], 'below')
    expect(p).not.toBeNull()
    const b = hintBox(p!.left, p!.top, size)
    expect(b.left).toBeGreaterThanOrEqual(8)
    expect(b.right).toBeLessThanOrEqual(312)
    expect(p!.covered).toBeGreaterThan(0)
    expect(placeHint(box(0, 0, 10, 10), { w: 2000, h: 50 }, view, [], 'below')).toBeNull()
  })
})
