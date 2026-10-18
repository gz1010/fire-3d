import { describe, expect, it } from 'vitest'
import { officialPast } from './context'

const H = 3_600_000
const NOW = Date.UTC(2026, 9, 18, 17, 0, 0)

describe('officialPast (minute-quantised timeline vs the NOW marker)', () => {
  it('treats a live fire shown at a NOW marker of hh:mm:41 as the present, not a past date', () => {
    const marker = Date.UTC(2026, 9, 18, 0, 42, 41) // Norte's latest observation (00:42:41Z), 16 h before now
    const minuteTime = Math.floor(marker / 60_000) * 60_000 // the timeline at the marker, floored to 00:42:00
    expect(officialPast('live', minuteTime, NOW, marker)).toBe(false)
    expect(officialPast('live', minuteTime + 60_000, NOW, marker)).toBe(false) // in the forecast period
    expect(officialPast('live', minuteTime - 60_000, NOW, marker)).toBe(true) // a minute before the marker: past
  })

  it('keeps the other rules: within 6 h of now is the present; replay is always past', () => {
    expect(officialPast('live', NOW - 2 * H, NOW, NOW - 20 * H)).toBe(false)
    expect(officialPast('live', NOW - 30 * H, NOW, NOW - 20 * H)).toBe(true)
    expect(officialPast('live', NOW - 30 * H, NOW, null)).toBe(true)
    expect(officialPast('historical', NOW, NOW, NOW)).toBe(true)
  })
})
