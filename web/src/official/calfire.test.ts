import { describe, expect, it } from 'vitest'
import type { IncidentSummary } from '../api/types'
import { agenciesText, calfireFeedItems, calfireHistoryNote, calfireStatus, changeTitleParts, laggedEditNote, officialSeekable } from './calfire'
import { CALFIRE_EATON_PAST, CALFIRE_HENDERSON_LIVE } from './__fixtures__/samples'
import type { CalFireResponse } from './types'

const H = 3_600_000
const q = (data: CalFireResponse | null, extra: { loading?: boolean; error?: string | null } = {}) => ({ data, loading: false, error: null, ...extra })
const SUMMARY = { id: 'x', calfire_uid: 'uid', acres: 100, percent_contained: 10, is_active: true, updated_ms: 5, url: 'https://www.fire.ca.gov/incidents/x', contained_ms: null, lat: 34, lon: -118 } as unknown as IncidentSummary
// Henderson with one recorded change (synthetic: the recording had not seen one yet when the fixture was taken)
const WITH_CHANGE: CalFireResponse = {
  ...CALFIRE_HENDERSON_LIVE,
  changes: [
    { updated_ms: CALFIRE_HENDERSON_LIVE.current!.updated_ms, seen_ms: CALFIRE_HENDERSON_LIVE.retrieved_ms!, percent_contained: [50, 65] },
    { updated_ms: null, seen_ms: CALFIRE_HENDERSON_LIVE.retrieved_ms! + H, acres: [3160, 3300], is_active: [true, false] },
  ],
}

describe('CAL FIRE status', () => {
  it("shows CAL FIRE's record with its own update time, page and agencies", () => {
    const s = calfireStatus(q(CALFIRE_HENDERSON_LIVE), null, false)
    expect(s).toMatchObject({ state: 'available', acres: 3160, percentContained: 65, isActive: true, final: false, updatedMs: 1792335669000, url: 'https://www.fire.ca.gov/incidents/2026/10/15/henderson-fire/' })
    expect(s.agencies).toMatch(/^United States Marine Corps, CAL FIRE/)
    expect(s.recordingSinceMs).toBe(CALFIRE_HENDERSON_LIVE.recording_since_ms)
    expect(s.reason).toBeUndefined()
  })

  it('keeps the last record Fire-3d saw when CAL FIRE is unreachable, with the reason', () => {
    const down = { ...CALFIRE_HENDERSON_LIVE, status: 'unavailable' as const, reason: "CAL FIRE's incident list could not be reached just now. Showing the last record Fire-3d saw." }
    expect(calfireStatus(q(down), null, false)).toMatchObject({ state: 'available', acres: 3160, reason: down.reason })
  })

  it('falls back to the incident summary (also CAL FIRE), never shows a record for demo data, and says why otherwise', () => {
    expect(calfireStatus(q(null, { error: 'Could not reach the Fire-3d server.' }), SUMMARY, false)).toMatchObject({ state: 'available', acres: 100, percentContained: 10, url: 'https://www.fire.ca.gov/incidents/x' })
    expect(calfireStatus(q(CALFIRE_HENDERSON_LIVE), SUMMARY, true)).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/^Demo data/) })
    expect(calfireStatus(q(null, { loading: true }), null, false)).toEqual({ state: 'loading' })
    expect(calfireStatus(q(null, { error: 'boom' }), null, false)).toEqual({ state: 'unavailable', reason: 'boom', unreachable: true })
    const down = { ...CALFIRE_HENDERSON_LIVE, status: 'unavailable' as const, reason_code: 'upstream_error', current: null, reason: 'CAL FIRE could not be reached.' }
    expect(calfireStatus(q(down), null, false)).toEqual({ state: 'unavailable', reason: 'CAL FIRE could not be reached.', unreachable: true })
    const none = { ...CALFIRE_HENDERSON_LIVE, status: 'unavailable' as const, current: null, reason: 'Not in the list.' }
    expect(calfireStatus(q(none), null, false)).toEqual({ state: 'unavailable', reason: 'Not in the list.' })
  })

  it("past fires: the final record, its containment date and the note that a late edit is not news", () => {
    const s = calfireStatus(q(CALFIRE_EATON_PAST), null, false)
    expect(s).toMatchObject({ state: 'available', acres: 14021, percentContained: 100, final: true, containedMs: 1738349322000 })
    expect(s.agencies?.startsWith('LA County Mental Health')).toBe(true) // the record's leading ", " is dropped
    expect(laggedEditNote(s)).toMatch(/edited this record well after the fire was contained/)
    expect(calfireHistoryNote(s, 'historical')).toMatch(/^CAL FIRE's update-by-update history is not available for past fires\. Fire-3d records CAL FIRE's changes since/)
    expect(calfireHistoryNote(calfireStatus(q(CALFIRE_HENDERSON_LIVE), null, false), 'live')).toMatch(/^Fire-3d records CAL FIRE's changes since/)
    expect(agenciesText(['A', ' B ', ''])).toBe('A, B')
    expect(agenciesText(null)).toBeUndefined()
  })
})

describe('CAL FIRE feed rows', () => {
  const live = { mode: 'live' as const, manifest: { grid: { utm_zone: 11, center_e: 450000, center_n: 3700000 }, time_range: { start_ms: 0, end_ms: 1792335669000 + H, now_ms: 1792335669000 + H } } as never, summary: { lat: 33.35, lon: -117.41, url: null, contained_ms: null } }

  it('says what changed in CAL FIRE terms, timed by CAL FIRE; when Fire-3d saw it is only "checked"', () => {
    const items = calfireFeedItems(WITH_CHANGE, live)
    expect(items.map((i) => i.title)).toEqual(['CAL FIRE: 65 % contained (was 50 %)', 'CAL FIRE: 3,300 acres (was 3,160) · no longer listed as active'])
    const [a, b] = items
    expect(a).toMatchObject({ topic: 'record', kind: 'official', automated: false, key: true, issuer: 'CAL FIRE', source: 'CAL FIRE incident record', tMs: 1792335669000, updatedMs: 1792335669000, checkedMs: WITH_CHANGE.changes[0].seen_ms, timeNotGiven: false, url: 'https://www.fire.ca.gov/incidents/2026/10/15/henderson-fire/', approximate: true })
    expect(a.seekable).toBe(true) // inside the observed record
    expect(a.location).not.toBeNull()
    expect(b).toMatchObject({ tMs: WITH_CHANGE.changes[1].seen_ms, timeNotGiven: true, updatedMs: null, seekable: false })
    expect(b.notes).toEqual(['CAL FIRE gives no update time for this change.'])
    expect(changeTitleParts({ seen_ms: 0, updated_ms: 0, final: [false, true] })).toEqual(['record marked final'])
    // CAL FIRE's own precision: a small edit (Cooley, Oct 18 2026) stays visible instead of "1,037 acres (was 1,037)"
    expect(changeTitleParts({ seen_ms: 0, updated_ms: 0, acres: [1036.8, 1037] })).toEqual(['1,037 acres (was 1,036.8)'])
    expect(changeTitleParts({ seen_ms: 0, updated_ms: 0, acres: [731.4, 1036.8] })).toEqual(['1,036.8 acres (was 731.4)'])
  })

  it('past fires get one "final record" row, after the record and not seekable', () => {
    const past = { mode: 'historical' as const, manifest: { grid: { utm_zone: 11, center_e: 399738, center_n: 3784875 }, time_range: { start_ms: 1736298000000, end_ms: 1736535600000, now_ms: 1736535600000 } } as never, summary: { lat: 34.2, lon: -118.07, url: null, contained_ms: null } }
    const [f, ...rest] = calfireFeedItems(CALFIRE_EATON_PAST, past)
    expect(rest).toEqual([])
    expect(f).toMatchObject({ id: 'calfire:final', title: 'CAL FIRE final record: 14,021 acres, 100 % contained', seekable: false, key: true, tMs: 1786038441000 })
    expect(f.detail).toBe("CAL FIRE's update-by-update history is not available for past fires; this is its final record.")
    expect(f.notes?.[0]).toMatch(/after the end of the record shown here\.$/)
    expect(f.facts?.find((x) => x.label === 'Contained')?.text).toMatch(/^Jan 31, 2025/)
    expect(calfireFeedItems({ ...CALFIRE_EATON_PAST, current: null }, past)).toEqual([])
  })

  it('seeks only inside the observed record', () => {
    const m = { time_range: { start_ms: 10, end_ms: 50, now_ms: 40 } } as never
    expect(officialSeekable(20, m)).toBe(true)
    expect(officialSeekable(45, m)).toBe(false) // after the latest observation: never into the forecast period
    expect(officialSeekable(5, m)).toBe(false)
    expect(officialSeekable(20, null)).toBe(false)
  })
})
