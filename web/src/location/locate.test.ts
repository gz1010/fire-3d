import { describe, expect, it } from 'vitest'
import locateButtonSource from './LocateButton.tsx?raw'
import { APPROXIMATE_OVER_M, deviceFromPosition, deviceSelection, deviceZoom, LOCATE_MESSAGES, locateFailure } from './locate'

describe('use my location (brief 4)', () => {
  it('maps the browser error codes to plain messages; never a default place', () => {
    expect(locateFailure(1)).toBe('denied')
    expect(locateFailure(2)).toBe('unavailable')
    expect(locateFailure(3)).toBe('timeout')
    expect(locateFailure(undefined)).toBe('unavailable')
    for (const m of Object.values(LOCATE_MESSAGES)) {
      expect(m).toMatch(/search for an address/i)
      expect(m).not.toMatch(/\bsafe\b|low risk/i)
    }
  })

  it('a fix becomes the device location; unusable numbers are dropped', () => {
    const d = deviceFromPosition({ coords: { latitude: 47.42, longitude: -120.31, accuracy: 30 }, timestamp: 5 }, 9)
    expect(d).toEqual({ lat: 47.42, lon: -120.31, accuracyM: 30, tMs: 5 })
    expect(deviceFromPosition({ coords: { latitude: Number.NaN, longitude: 1 } }, 9)).toBeNull()
    expect(deviceFromPosition({ coords: { latitude: 95, longitude: 1 } }, 9)).toBeNull()
    expect(deviceFromPosition({ coords: { latitude: 1, longitude: 2, accuracy: null } }, 9)).toEqual({ lat: 1, lon: 2, accuracyM: null, tMs: 9 })
  })

  it('selects "Your location", approximate when coarser than 100 m or unknown', () => {
    expect(deviceSelection({ lat: 1, lon: 2, accuracyM: 30, tMs: 0 })).toEqual({ lat: 1, lon: 2, source: 'device', label: 'Your location', approximate: false })
    expect(deviceSelection({ lat: 1, lon: 2, accuracyM: APPROXIMATE_OVER_M + 1, tMs: 0 }).approximate).toBe(true)
    expect(deviceSelection({ lat: 1, lon: 2, accuracyM: null, tMs: 0 }).approximate).toBe(true)
  })

  it('zooms closer for a precise fix, wider for a coarse one', () => {
    expect(deviceZoom(20)).toBeGreaterThan(deviceZoom(800))
    expect(deviceZoom(800)).toBeGreaterThan(deviceZoom(3000))
    expect(deviceZoom(3000)).toBeGreaterThan(deviceZoom(50_000))
    expect(deviceZoom(null)).toBeLessThanOrEqual(deviceZoom(3000))
  })

  it('asks the browser only on a click, never watches, stores or sends the position itself', () => {
    const src = locateButtonSource
    expect(src).toContain('getCurrentPosition')
    expect(src).not.toMatch(/watchPosition|localStorage|sessionStorage|indexedDB|fetch\(|history\.(push|replace)State|URLSearchParams/)
    // the request sits inside the click handler, not an effect
    const handler = /const locate = \(\) => \{([\s\S]*?)\n {2}\}/.exec(src)?.[1] ?? ''
    expect(handler).toContain('getCurrentPosition')
  })
})
