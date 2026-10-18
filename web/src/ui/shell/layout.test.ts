import { describe, expect, it } from 'vitest'
import { clipRect, MIN_VISIBLE_PX, parseDockSide, pointHidden, safeInsetsFor, unionArea, unobstructedShare, type ChromeRect } from './layout'

const rect = (left: number, top: number, w: number, h: number, side: ChromeRect['side'] = 'none'): ChromeRect => ({ left, top, right: left + w, bottom: top + h, side })

describe('parseDockSide', () => {
  it('accepts the four sides and maps anything else to none', () => {
    expect(parseDockSide(' bottom ')).toBe('bottom')
    expect(parseDockSide('left')).toBe('left')
    expect(parseDockSide('')).toBe('none')
    expect(parseDockSide(null)).toBe('none')
    expect(parseDockSide('centre')).toBe('none')
  })
})

describe('clipRect', () => {
  it('clips to the viewport and drops empty rectangles', () => {
    expect(clipRect({ left: -10, top: 5, right: 50, bottom: 2000 }, 100, 100)).toEqual({ left: 0, top: 5, right: 50, bottom: 100 })
    expect(clipRect({ left: 120, top: 0, right: 200, bottom: 50 }, 100, 100)).toBeNull()
    expect(clipRect({ left: 10, top: 10, right: 10, bottom: 50 }, 100, 100)).toBeNull()
  })
})

describe('safeInsetsFor', () => {
  const W = 1440
  const H = 900
  it('is just the gap when nothing is docked', () => {
    expect(safeInsetsFor([], W, H, 12)).toEqual({ top: 12, right: 12, bottom: 12, left: 12 })
  })
  it('takes the deepest reach per side and ignores undocked and empty chrome', () => {
    const items = [
      rect(0, 0, W, 52, 'top'), // header
      rect(12, 64, 400, 40, 'top'), // search row
      rect(W - 332, 116, 320, 360, 'right'), // updates panel
      rect(410, H - 82, 620, 70, 'bottom'), // timeline
      rect(12, H - 58, 360, 46, 'bottom'), // coordinates
      rect(12, 116, 300, 220, 'none'), // a floating card that should not move the map centre
      rect(500, 500, 0, 0, 'left'), // collapsed / hidden
    ]
    expect(safeInsetsFor(items, W, H, 12)).toEqual({ top: 116, right: 344, bottom: 94, left: 12 })
  })
  it('clips chrome that extends past the viewport', () => {
    expect(safeInsetsFor([rect(-50, -20, 200, 100, 'left')], 800, 600, 10).left).toBe(160)
  })
  it('keeps a minimum visible map area by shrinking the larger opposing inset', () => {
    const ins = safeInsetsFor([rect(0, 0, 390, 300, 'top'), rect(0, 400, 390, 444, 'bottom')], 390, 844, 12)
    expect(844 - ins.top - ins.bottom).toBeGreaterThanOrEqual(MIN_VISIBLE_PX)
    expect(ins.top).toBe(312) // the smaller inset is kept
    const wide = safeInsetsFor([rect(0, 0, 300, 800, 'left'), rect(250, 0, 140, 800, 'right')], 390, 844, 12)
    expect(390 - wide.left - wide.right).toBeGreaterThanOrEqual(MIN_VISIBLE_PX)
    expect(wide.right).toBe(152)
  })
})

describe('unionArea / unobstructedShare', () => {
  it('counts overlapping rectangles once', () => {
    expect(unionArea([rect(0, 0, 10, 10), rect(5, 5, 10, 10)], 100, 100)).toBe(175)
    expect(unionArea([rect(0, 0, 10, 10), rect(0, 0, 10, 10)], 100, 100)).toBe(100)
  })
  it('handles nested, disjoint and off-screen rectangles', () => {
    expect(unionArea([rect(0, 0, 50, 50), rect(10, 10, 5, 5), rect(60, 60, 10, 10), rect(200, 200, 10, 10)], 100, 100)).toBe(2600)
    expect(unionArea([rect(90, 90, 50, 50)], 100, 100)).toBe(100)
  })
  it('reports the free share of the viewport', () => {
    expect(unobstructedShare([], 1440, 900)).toBe(1)
    expect(unobstructedShare([rect(0, 0, 1440, 225)], 1440, 900)).toBeCloseTo(0.75, 10)
    expect(unobstructedShare([rect(0, 0, 10, 10)], 0, 900)).toBe(0)
  })
})

describe('pointHidden (pin above the phone sheet)', () => {
  const ins = { top: 110, right: 8, bottom: 300, left: 8 }
  it('flags points under the chrome or within the margin of it', () => {
    expect(pointHidden({ x: 195, y: 400 }, 390, 844, ins)).toBe(false)
    expect(pointHidden({ x: 195, y: 600 }, 390, 844, ins)).toBe(true) // under the bottom sheet
    expect(pointHidden({ x: 195, y: 520 }, 390, 844, ins, 36)).toBe(true) // its label would be
    expect(pointHidden({ x: 195, y: 90 }, 390, 844, ins)).toBe(true) // under the search box
    expect(pointHidden({ x: 2, y: 400 }, 390, 844, ins)).toBe(true)
    expect(pointHidden({ x: Number.NaN, y: 400 }, 390, 844, ins)).toBe(false)
  })
})
