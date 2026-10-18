import { describe, expect, it } from 'vitest'
import { chooseCaptionPlacement } from './placement'

const VIEW = { w: 1440, h: 900 }
const chip = { left: 928, top: 5, right: 1225, bottom: 39 } // in the header, left of Analysis / Layers
const size = { w: 360, h: 70 }

describe('caption placement', () => {
  it('hangs left under a header chip when the controls and the panel are below its right part', () => {
    const controls = { left: 1015, top: 52, right: 1425, bottom: 92 }
    const panel = { left: 1125, top: 130, right: 1428, bottom: 740 }
    expect(chooseCaptionPlacement(chip, size, [controls, panel], VIEW)).toEqual({ left: 608, top: 45 })
  })

  it('goes right-aligned under the chip when hanging left would leave the screen, and left-aligned when that is free', () => {
    const phoneChip = { left: 82, top: 180, right: 382, bottom: 210 }
    expect(chooseCaptionPlacement(phoneChip, { w: 300, h: 60 }, [], { w: 390, h: 844 })).toEqual({ left: 82, top: 216 })
    expect(chooseCaptionPlacement({ left: 20, top: 5, right: 200, bottom: 39 }, { w: 300, h: 60 }, [{ left: 0, top: 40, right: 10, bottom: 50 }], VIEW)).toEqual({ left: 20, top: 45 })
  })

  it('takes the least covered spot when every spot touches something', () => {
    const everywhere = [{ left: 0, top: 40, right: 1440, bottom: 60 }]
    const p = chooseCaptionPlacement(chip, size, everywhere, VIEW)
    expect([608, 865, 928]).toContain(p.left)
  })
})
