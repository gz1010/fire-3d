import { describe, expect, it } from 'vitest'
import { labelWidth, overlaps, pickAnchor, placeLeader } from './areaLabels'

const area = { left: 0, top: 0, right: 1000, bottom: 800 }

describe("Command's leader labels (brief 4)", () => {
  it('anchors on the outline point that scores highest inside the free map', () => {
    const pts = [
      { x: 100, y: 500 },
      { x: 600, y: 200 },
      { x: 1200, y: 100 }, // outside the free map
      { x: Number.NaN, y: 0 },
    ]
    expect(pickAnchor(pts, area, (p) => p.x - p.y)).toEqual({ x: 600, y: 200 })
    expect(pickAnchor([], area, (p) => p.x)).toBeNull()
  })

  it('places the label to the right of a diagonal and a run, else mirrored left, else drops it', () => {
    const shape = { dx: 50, dy: -48, run: 60 }
    const right = placeLeader({ x: 400, y: 300 }, 150, shape, area)!
    expect(right.side).toBe('right')
    expect(right.elbow).toEqual({ x: 450, y: 252 })
    expect(right.end).toEqual({ x: 510, y: 252 })
    expect(right.box).toEqual({ left: 514, right: 664, top: 236, bottom: 267 })
    // near the right edge: mirrored to the left, the text ending before the run
    const left = placeLeader({ x: 900, y: 300 }, 150, shape, area)!
    expect(left.side).toBe('left')
    expect(left.box.right).toBe(900 - 50 - 60 - 4)
    // no room on either side
    expect(placeLeader({ x: 500, y: 20 }, 150, shape, area)).toBeNull()
    // a box to avoid on the right: mirrored
    const avoided = placeLeader({ x: 400, y: 300 }, 150, shape, area, [right.box])!
    expect(avoided.side).toBe('left')
    expect(overlaps(avoided.box, right.box)).toBe(false)
  })

  it('estimates a label width from its longer line', () => {
    expect(labelWidth('Observed fire', 'OCT 22, 13:30 PDT')).toBe(Math.ceil(17 * 7.0) + 4)
    expect(labelWidth('A much longer label name', 'x')).toBe(Math.ceil(24 * 7.4) + 4)
  })
})
