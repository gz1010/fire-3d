import { describe, expect, it } from 'vitest'
import { labelWidth, overlaps, pickAnchor, placeAlong, placeLeader, rankAnchors } from './areaLabels'

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

  it('ranks the anchor candidates best first, inside the free map and spaced apart', () => {
    const pts = [
      { x: 600, y: 200 },
      { x: 595, y: 205 }, // too close to the best one
      { x: 500, y: 300 },
      { x: 1200, y: 100 }, // outside
      { x: 100, y: 500 },
    ]
    expect(rankAnchors(pts, area, (p) => p.x - p.y)).toEqual([
      { x: 600, y: 200 },
      { x: 500, y: 300 },
      { x: 100, y: 500 },
    ])
    expect(rankAnchors(pts, area, (p) => p.x - p.y, 1)).toEqual([{ x: 600, y: 200 }])
  })

  it('tries the next anchor, then the flipped leader, when a label has no room', () => {
    const up = { dx: 50, dy: -48, run: 60 }
    const down = { dx: 50, dy: 48, run: 60 }
    // the best anchor sits under a box to avoid on both sides: the second anchor takes the label
    const avoid = [{ left: 0, top: 200, right: 1000, bottom: 280 }]
    const p = placeAlong([{ x: 500, y: 300 }, { x: 500, y: 600 }], 150, [up], area, avoid)!
    expect(p.anchor).toEqual({ x: 500, y: 600 })
    // at the top edge the upward leader leaves the map: the same anchor with the leader flipped down
    const flipped = placeAlong([{ x: 400, y: 20 }], 150, [up, down], area)!
    expect(flipped.anchor).toEqual({ x: 400, y: 20 })
    expect(flipped.elbow.y).toBe(68)
    expect(placeAlong([{ x: 400, y: 20 }], 150, [up], area)).toBeNull()
    expect(placeAlong([], 150, [up, down], area)).toBeNull()
  })

  it('estimates a label width from its longer line', () => {
    expect(labelWidth('Observed fire', 'OCT 22, 13:30 PDT')).toBe(Math.ceil(17 * 7.0) + 4)
    expect(labelWidth('A much longer label name', 'x')).toBe(Math.ceil(24 * 7.4) + 4)
  })
})
