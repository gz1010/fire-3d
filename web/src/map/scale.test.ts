import { describe, expect, it } from 'vitest'
import { metersPerPixel } from './mapStore'
import { niceScale } from './scale'

describe('scale bar', () => {
  it('uses ft below a mile and mi above, metric m / km', () => {
    expect(niceScale(10, 'us', 90)).toMatchObject({ label: '0.5 mi' }) // 900 m max = 2,953 ft
    expect(niceScale(1, 'us', 90).label).toBe('250 ft') // 90 m = 295 ft
    expect(niceScale(50, 'us', 90).label).toBe('2.5 mi') // 4.5 km = 2.8 mi
    expect(niceScale(10, 'metric', 90).label).toBe('500 m')
    expect(niceScale(50, 'metric', 90).label).toBe('2.5 km')
  })
  it('never exceeds the maximum width and stays at least half of it', () => {
    for (const mpp of [0.3, 1.7, 9, 33, 120, 900]) {
      for (const u of ['us', 'metric'] as const) {
        const s = niceScale(mpp, u, 90)
        expect(s.px).toBeLessThanOrEqual(90 + 1e-9)
        expect(s.px).toBeGreaterThanOrEqual(90 / 2.5 - 1e-9)
        expect(s.meters / mpp).toBeCloseTo(s.px, 6)
      }
    }
  })
  it('metersPerPixel follows the 512 px Web Mercator world', () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(78271.517, 2)
    expect(metersPerPixel(60, 1)).toBeCloseTo(78271.517 / 4, 2)
  })
})
