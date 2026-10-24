import { describe, expect, it } from 'vitest'
import { COVERS_POINT_COST, COVERS_TEXT_COST, OVERFLOW_COST_PER_PX, overflowPx, pinLabelBox, pinLabelSide, type ScreenBox } from './pinLabel'

// a 1440 × 1000 map with Command's columns: the readout on the left, "Official now" on the right
const FREE: ScreenBox = { left: 472, top: 84, right: 1008, bottom: 790 }
const LABEL = { w: 180, h: 30 }

describe('selected point label placement', () => {
  it('puts the label up and to the right of the dot, as the screens', () => {
    expect(pinLabelBox(600, 400, 180, 30, 'up-right')).toEqual({ left: 642, top: 368, right: 822, bottom: 398 })
    expect(pinLabelSide({ x: 600, y: 400 }, LABEL, FREE, 'up-right')).toBe('up-right')
  })

  it('mirrors the boxes around the dot', () => {
    const r = pinLabelBox(600, 400, 180, 30, 'down-right')
    const l = pinLabelBox(600, 400, 180, 30, 'down-left')
    expect(r.top).toBeGreaterThan(400)
    expect(600 - l.right).toBe(r.left - 600)
    expect(l.top).toBe(r.top)
  })

  it('counts the pixels outside the free area', () => {
    expect(overflowPx({ left: 460, top: 80, right: 1020, bottom: 795 }, FREE)).toBe(12 + 4 + 12 + 5)
    expect(overflowPx({ left: 500, top: 100, right: 600, bottom: 120 }, FREE)).toBe(0)
  })

  it('flips to the left when the right side would run under the right column', () => {
    // dot at 803: up-right ends at 1025 > 1008, up-left starts at 581 > 472
    expect(pinLabelSide({ x: 803, y: 383 }, LABEL, FREE, 'up-right')).toBe('up-left')
  })

  it('flips to the right near the left column, and down near the top', () => {
    expect(pinLabelSide({ x: 520, y: 400 }, LABEL, FREE, 'up-left')).toBe('up-right')
    expect(pinLabelSide({ x: 600, y: 100 }, LABEL, FREE, 'up-right')).toBe('down-right')
  })

  it('moves off another label when a free corner is clean', () => {
    const fireLabel: ScreenBox = { left: 620, top: 360, right: 760, bottom: 400 }
    const hits = (b: ScreenBox) => (b.left < fireLabel.right && b.right > fireLabel.left && b.top < fireLabel.bottom && b.bottom > fireLabel.top ? COVERS_TEXT_COST : 0)
    expect(pinLabelSide({ x: 700, y: 400 }, LABEL, FREE, 'up-right', hits)).toBe('down-right')
  })

  it('weighs what it would hide: a few pixels under the chrome cost more than covering a dot, less than text', () => {
    // Command at 1440 px (fixture-live): up-right runs 17 px past the free area and over the fire's label, up-left
    // covers the fire's label, down-right runs 17 px past, down-left covers two key-event dots
    const covers = (_b: ScreenBox, side: string) =>
      ({ 'up-right': COVERS_TEXT_COST, 'up-left': COVERS_TEXT_COST, 'down-right': 0, 'down-left': COVERS_POINT_COST })[side] ?? 0
    expect(pinLabelSide({ x: 803, y: 383 }, LABEL, FREE, 'up-right', covers)).toBe('down-left')
    // 17 px under the chrome is worse than covering text; 10 px is not
    expect(OVERFLOW_COST_PER_PX * 17).toBeGreaterThan(COVERS_TEXT_COST)
    expect(OVERFLOW_COST_PER_PX * 10).toBeLessThan(COVERS_TEXT_COST)
    expect(COVERS_POINT_COST).toBeLessThan(COVERS_TEXT_COST)
  })

  it('keeps the current corner on a tie (no flip-flop while panning)', () => {
    expect(pinLabelSide({ x: 700, y: 400 }, LABEL, FREE, 'down-left')).toBe('down-left')
    // the two upper corners overflow by the same 10 px and the lower ones more: the current upper one stays, a lower
    // one moves to the first upper corner in preference order
    const even: ScreenBox = { left: 488, top: 84, right: 912, bottom: 420 }
    expect(overflowPx(pinLabelBox(700, 400, 180, 30, 'up-right'), even)).toBe(10)
    expect(overflowPx(pinLabelBox(700, 400, 180, 30, 'up-left'), even)).toBe(10)
    expect(pinLabelSide({ x: 700, y: 400 }, LABEL, even, 'up-left')).toBe('up-left')
    expect(pinLabelSide({ x: 700, y: 400 }, LABEL, even, 'down-right')).toBe('up-right')
  })

  it('prefers the least overflow when every corner overflows', () => {
    // a narrow free area: the right side overflows by 116 px, the left by 24 px
    const narrow: ScreenBox = { left: 360, top: 84, right: 664, bottom: 520 }
    expect(pinLabelSide({ x: 558, y: 270 }, LABEL, narrow, 'up-right')).toBe('up-left')
  })
})
