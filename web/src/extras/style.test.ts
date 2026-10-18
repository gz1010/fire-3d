import { describe, expect, it } from 'vitest'
import { cameraIconImage, crossHatchImage, evacStyleGroup, hatchSwatchCss, parseHex } from './style'

describe('evacuation style groups', () => {
  it('maps statuses to styles (wording stays verbatim elsewhere)', () => {
    expect(evacStyleGroup('order')).toBe('order')
    expect(evacStyleGroup('shelter')).toBe('order')
    expect(evacStyleGroup('warning')).toBe('warning')
    expect(evacStyleGroup('advisory')).toBe('other')
    expect(evacStyleGroup('lifted')).toBe('other')
    expect(evacStyleGroup('unknown')).toBe('other')
    expect(evacStyleGroup('normal')).toBe('hidden')
    expect(evacStyleGroup('training')).toBe('hidden')
  })
})

describe('generated images', () => {
  it('cross-hatch tiles are seamless, two-directional and use the colour', () => {
    const img = crossHatchImage('#e0459b', 6, 1.3, 0.85, 2, 24)
    expect(img.width).toBe(48)
    expect(img.data.length).toBe(48 * 48 * 4)
    const a = (x: number, y: number) => img.data[(y * img.width + x) * 4 + 3]
    const period = 48 / 4
    let lit = 0
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 48; x++) {
        expect(a(x, y)).toBe(a((x + period) % 48, y)) // periodic -> tiles without seams
        expect(a(x, y)).toBe(a(47 - x, y)) // both diagonals present (mirror symmetric)
        if (a(x, y) > 0) lit++
      }
    }
    expect(lit / (48 * 48)).toBeGreaterThan(0.2)
    expect(lit / (48 * 48)).toBeLessThan(0.8)
    expect(Math.max(...Array.from({ length: 48 * 48 }, (_, i) => img.data[i * 4 + 3]))).toBeLessThanOrEqual(Math.round(255 * 0.85))
    expect([img.data[0], img.data[1], img.data[2]]).toEqual(parseHex('#e0459b'))
  })

  it('denser hatching for orders than for other statuses', () => {
    const cover = (spacing: number) => {
      const img = crossHatchImage('#7aa2f7', spacing, 1.1, 1)
      let s = 0
      for (let i = 3; i < img.data.length; i += 4) s += img.data[i]
      return s
    }
    expect(cover(6)).toBeGreaterThan(cover(12) * 1.5)
  })

  it('camera icons: wildfire filled with a dark lens, traffic outlined', () => {
    const wf = cameraIconImage('wildfire', 2)
    const tr = cameraIconImage('traffic', 2)
    expect(wf.width).toBe(36)
    const px = (img: typeof wf, x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4))
    // a point on the body, left of the lens (css 5, 10)
    expect(px(wf, 10, 20)[0]).toBeGreaterThan(200)
    expect(px(tr, 10, 20)[3]).toBeLessThan(255) // interior not filled
    // lens centre (css 9, 10): dark on the filled icon
    expect(px(wf, 18, 20)[0]).toBeLessThan(60)
    expect(px(wf, 0, 0)[3]).toBe(0) // transparent corners
  })

  it('legend swatch CSS mirrors the cross-hatch', () => {
    const css = hatchSwatchCss('#a78bfa', 9)
    expect(css.match(/repeating-linear-gradient/g)).toHaveLength(2)
    expect(css).toContain('45deg')
    expect(css).toContain('-45deg')
  })
})
