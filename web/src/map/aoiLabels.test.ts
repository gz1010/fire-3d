import { describe, expect, it } from 'vitest'
import { aoiLabelBox, aoiSidesInside } from './aoiLabels'

// Command at 1440 × 1000 (fixture-live): the free map between the readout and "Official now"
const FREE = { left: 472, top: 84, right: 1008, bottom: 790 }

describe('"Outside modeled area" labels kept off the chrome (review DF-14)', () => {
  it('lays the box out on the outer side of each edge, as the layer anchors it', () => {
    const e = aoiLabelBox('e', 900, 400, 10.5)
    expect(e.left).toBeGreaterThan(900)
    const w = aoiLabelBox('w', 500, 400, 10.5)
    expect(w.right).toBeLessThan(500)
    expect(aoiLabelBox('n', 700, 100, 10.5).bottom).toBeLessThan(100)
    expect(aoiLabelBox('s', 700, 700, 10.5).top).toBeGreaterThan(700)
  })

  it('hides the label that would run under the right column, keeps the others', () => {
    // fixture-live: the east edge at x 990 put "Outside modeled area" behind "View all updates"
    const anchors = [
      { side: 'n' as const, x: 750, y: 190 },
      { side: 's' as const, x: 745, y: 685 },
      { side: 'w' as const, x: 507, y: 437 },
      { side: 'e' as const, x: 990, y: 437 },
    ]
    expect(aoiSidesInside(anchors, FREE, 10.5)).toEqual(['n', 's'])
    // with the map panned left the east label has room again
    expect(aoiSidesInside([{ side: 'e', x: 800, y: 437 }], FREE, 10.5)).toEqual(['e'])
  })
})
