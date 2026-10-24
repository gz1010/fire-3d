import { describe, expect, it } from 'vitest'
import { COVERS_POINT_COST, COVERS_TEXT_COST, OVERFLOW_COST_PER_PX, overflowPx, pinLabelBox, pinLabelLayout, pinLabelSide, STACKED_COST, type ScreenBox } from './pinLabel'

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

  describe('stacked coordinates and the map edge (review DF-2)', () => {
    const WIDE = { w: 180, h: 29 }
    const STACKED = { w: 96, h: 45 }

    it('stacks the coordinates when no one-line corner fits the free area (Command at 1024 px)', () => {
      // measured on Lower Sugarloaf at 1024 × 768: free 400-664 px wide, dot at 517; up-right ran 75 px under
      // "Official now", up-left 105 px under the readout
      const free: ScreenBox = { left: 400, top: 76, right: 664, bottom: 447 }
      const view: ScreenBox = { left: 0, top: 0, right: 1024, bottom: 768 }
      const covers = (_b: ScreenBox, side: string) => (side === 'up-left' ? COVERS_TEXT_COST : side === 'down-right' ? COVERS_POINT_COST : 0)
      const l = pinLabelLayout({ x: 517, y: 244 }, { wide: WIDE, stacked: STACKED }, free, { side: 'up-right', stacked: false }, covers, view)
      expect(l).toEqual({ side: 'up-right', stacked: true })
      expect(overflowPx(pinLabelBox(517, 244, STACKED.w, STACKED.h, 'up-right'), free)).toBe(0)
    })

    it('never leaves a dot within a label width of the right edge with its label cut off (phone)', () => {
      // 390 px phone: free 8-382, dot at 173 beside the fire's label on the left; one line up-right ends at 395 px
      const free: ScreenBox = { left: 8, top: 108, right: 382, bottom: 684 }
      const view: ScreenBox = { left: 0, top: 0, right: 390, bottom: 844 }
      const covers = (_b: ScreenBox, side: string) => (side === 'up-left' ? COVERS_TEXT_COST : side === 'down-right' ? COVERS_POINT_COST : 0)
      const l = pinLabelLayout({ x: 173, y: 369 }, { wide: WIDE, stacked: STACKED }, free, { side: 'up-right', stacked: false }, covers, view)
      const size = l.stacked ? STACKED : WIDE
      const box = pinLabelBox(173, 369, size.w, size.h, l.side)
      expect(overflowPx(box, view)).toBe(0)
      expect(overflowPx(box, free)).toBe(0)
      // a dot 100 px from the right edge with nothing to cover: the label goes left on one line
      const l2 = pinLabelLayout({ x: 290, y: 369 }, { wide: WIDE, stacked: STACKED }, free, { side: 'up-right', stacked: false }, () => 0, view)
      expect(l2).toEqual({ side: 'up-left', stacked: false })
    })

    it('keeps one line when it fits (the stacked label costs a little more)', () => {
      expect(pinLabelLayout({ x: 600, y: 400 }, { wide: WIDE, stacked: STACKED }, FREE, { side: 'up-right', stacked: false })).toEqual({ side: 'up-right', stacked: false })
      // already stacked, and one line fits again: back to one line (stacked costs STACKED_COST more)
      expect(STACKED_COST).toBeGreaterThan(0)
      expect(pinLabelLayout({ x: 600, y: 400 }, { wide: WIDE, stacked: STACKED }, FREE, { side: 'up-right', stacked: true })).toEqual({ side: 'up-right', stacked: false })
    })

    it('does not stack a label that cannot (an address)', () => {
      const free: ScreenBox = { left: 400, top: 76, right: 664, bottom: 447 }
      expect(pinLabelLayout({ x: 517, y: 244 }, { wide: WIDE, stacked: null }, free, { side: 'up-right', stacked: false }).stacked).toBe(false)
    })

    it('a pixel cut off by the screen costs more than a pixel under the chrome', () => {
      // free reaches the screen edge on the right; up-right runs 20 px off screen, up-left 20 px under the left column
      const free: ScreenBox = { left: 396, top: 0, right: 800, bottom: 600 }
      const view: ScreenBox = { left: 0, top: 0, right: 800, bottom: 600 }
      expect(overflowPx(pinLabelBox(598, 300, WIDE.w, WIDE.h, 'up-left'), free)).toBe(20)
      expect(overflowPx(pinLabelBox(598, 300, WIDE.w, WIDE.h, 'up-right'), view)).toBe(20)
      expect(pinLabelLayout({ x: 598, y: 300 }, { wide: WIDE }, free, { side: 'up-right', stacked: false }, () => 0, view).side).toBe('up-left')
    })
  })
})
