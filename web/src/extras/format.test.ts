import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import { agoText, durationText, envelopeStatusLine, fmtWhen, freshnessText, relativeToText, requestErrorText } from './format'

describe('time text', () => {
  it('formats durations', () => {
    expect(durationText(4_000)).toBe('4 s')
    expect(durationText(12 * 60_000)).toBe('12 min')
    expect(durationText(3.82 * 3_600_000)).toBe('3.8 h')
    expect(durationText(30 * 3_600_000)).toBe('30 h')
    expect(durationText(4.05 * 86_400_000)).toBe('4 days')
  })

  it('relative times name their reference', () => {
    const now = Date.UTC(2026, 9, 17, 20, 0)
    expect(agoText(now - 10_000, now)).toBe('just now')
    expect(agoText(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(agoText(now + 2 * 3_600_000, now)).toBe('in 2 h')
    expect(relativeToText(now - 2 * 86_400_000, now)).toBe('2 days before the selected time')
    expect(relativeToText(now + 3_600_000, now)).toBe('1 h after the selected time')
    expect(relativeToText(now - 60_000, now)).toBe('at the selected time')
  })

  it('shows Los Angeles time with the zone, and the year only when it differs', () => {
    expect(fmtWhen(Date.UTC(2026, 9, 17, 20, 28), Date.UTC(2026, 9, 17))).toBe('Oct 17, 13:28 PDT')
    expect(fmtWhen(Date.UTC(2025, 0, 8, 4, 30), Date.UTC(2026, 9, 17))).toBe('Jan 7, 2025 20:30 PST')
  })

  it('freshness says whose clock each time is', () => {
    const now = Date.UTC(2026, 9, 17, 20, 30)
    expect(freshnessText({ source_updated_ms: Date.UTC(2026, 9, 17, 19, 1), retrieved_ms: now - 120_000 }, now, 'Cal OES data last changed')).toBe(
      'Cal OES data last changed Oct 17, 12:01 PDT · fetched 2 min ago',
    )
    expect(freshnessText({ source_updated_ms: null, retrieved_ms: null }, now)).toBe('')
  })
})

describe('status lines', () => {
  it('never turns a past date or an outage into "none"', () => {
    expect(envelopeStatusLine({ status: 'not_available_for_past_dates', reason: 'r' }, 'Official evacuation zones')).toEqual({
      tone: 'muted',
      title: 'Official evacuation zones: not available for past dates',
      detail: 'r',
    })
    expect(envelopeStatusLine({ status: 'unavailable', reason: 'x' }, 'Cameras').tone).toBe('warn')
    expect(envelopeStatusLine(null, 'Cameras').title).toBe('Cameras: loading…')
    expect(envelopeStatusLine(null, 'Cameras', 'boom')).toEqual({ tone: 'error', title: 'Cameras: could not load', detail: 'boom' })
    expect(envelopeStatusLine({ status: 'available', reason: null }, 'Cameras').tone).toBe('ok')
  })

  it('explains request failures without upstream bodies', () => {
    expect(requestErrorText(new ApiError(429, '/api/extras/x', 'limit'))).toMatch(/Too many requests/)
    expect(requestErrorText(new ApiError(502, '/api/extras/x', 'secret upstream text'))).toBe('The Fire-3d server could not get data from this source.')
    expect(requestErrorText(new TypeError('fetch failed'))).toBe('Could not reach the Fire-3d server.')
  })
})
