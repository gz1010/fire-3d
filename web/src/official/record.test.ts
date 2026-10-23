// Agency fire records, source-neutral (brief 3, CONTRACT §14.5).
import { describe, expect, it } from 'vitest'
import { summaryFixture, wfigsSummaryFixture } from '../api/fixtures.testutil'
import type { OtherRecord } from '../api/types'
import { NOT_FOUND_TEXT } from '../extras/format'
import { timeFmt } from '../lib/time'
import { buildDataStatus } from '../ui/shell/dataStatus'
import { calfireLine as summaryRecordLine } from '../ui/shell/officialSummary'
import { calfireStatus } from './calfire'
import { calfireUrl, incidentRecordUrl, recordUrl, secondaryRecordUrl } from './client'
import { partOfComplex, recordBlockText, recordStatus, wfigsRecordFeedItems, RECORD_NOT_CHECKED_REASON, SYNTHETIC_RECORD_REASON } from './record'
import type { IncidentRecordResponse } from './types'

const ok = <T,>(data: T | null, extra: { loading?: boolean; error?: string | null } = {}) => ({ data, loading: false, error: null, ...extra })
const NOW = Date.UTC(2026, 9, 22, 18, 0)

const HORSE_GULCH_RECORD: IncidentRecordResponse = {
  kind: 'incident_record',
  status: 'available',
  reason_code: null,
  reason: null,
  source: { name: 'NIFC WFIGS (IRWIN)', url: 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations/FeatureServer/0/query?f=html', credit: 'NIFC WFIGS (IRWIN)' },
  retrieved_ms: NOW - 60_000,
  source_updated_ms: Date.UTC(2024, 7, 2, 15, 30),
  requested_at_ms: null,
  now_ms: NOW,
  incident_id: '2024-horse-gulch-889237',
  record_source: 'wfigs',
  irwin_id: '889237AB-0000-0000-0000-000000000000',
  unique_fire_id: '2024-MTHLF-000123',
  publisher: 'NIFC WFIGS (IRWIN)',
  agency_code: 'USFS',
  agency: 'USDA Forest Service',
  protecting_unit: 'MTHLF',
  state: 'MT',
  county: 'Lewis and Clark',
  time_zone: 'America/Denver',
  incident_url: 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations/FeatureServer/0/query?where=x&f=html',
  dataset_url: 'https://data-nifc.opendata.arcgis.com/datasets/nifc::wfigs-incident-locations',
  current: {
    name: 'HORSE GULCH',
    acres: 9450,
    percent_contained: 100,
    is_active: false,
    discovered_ms: Date.UTC(2024, 6, 21, 21, 0),
    contained_ms: Date.UTC(2024, 7, 1, 1, 0),
    controlled_ms: null,
    out_ms: null,
    updated_ms: Date.UTC(2024, 7, 2, 15, 30),
    ics209_report_ms: null,
  },
  complex: null,
  changes: [],
  recording_since_ms: null,
  caveats: ["These are the protecting agency's numbers as published by NIFC WFIGS (IRWIN), with the record's own update time. Fire-3d does not record changes to this record yet."],
}

describe('which record to fetch (recordUrl)', () => {
  it('CAL FIRE rows ask CAL FIRE; WFIGS rows ask the NIFC WFIGS record endpoint', () => {
    expect(recordUrl(summaryFixture())).toBe(calfireUrl('2025-test-fire-abc123'))
    expect(recordUrl({ id: 'x' })).toBe(calfireUrl('x')) // an older summary
    expect(recordUrl(wfigsSummaryFixture())).toBe(incidentRecordUrl('2024-horse-gulch-889237'))
    expect(incidentRecordUrl('a b')).toMatch(/\/api\/official\/incident-record\?incident=a%20b$/)
  })
  it('a California fire active per one agency only fetches both records; a complex row never the incident record', () => {
    const timber = summaryFixture({ irwin_id: 'T1', active_sources: ['wfigs'] })
    expect(secondaryRecordUrl(timber)).toBe(incidentRecordUrl(timber.id))
    expect(secondaryRecordUrl(summaryFixture({ irwin_id: 'T1', active_sources: ['calfire', 'wfigs'] }))).toBeNull() // they agree
    expect(secondaryRecordUrl(summaryFixture({ irwin_id: null, active_sources: ['calfire'], complex_members: ['2-2', '2-7'] }))).toBeNull()
    expect(secondaryRecordUrl(wfigsSummaryFixture({ active_sources: ['wfigs'] }))).toBeNull()
  })
})

describe('the record of a NIFC WFIGS fire (Horse Gulch, MT)', () => {
  const s = wfigsSummaryFixture()
  const st = recordStatus({ calfire: null, record: ok(HORSE_GULCH_RECORD), summary: s, demo: false, hasIncident: true })
  it("is labelled from its issuer, with the agency's own numbers, times and link", () => {
    expect(st).toMatchObject({ state: 'available', source: 'wfigs', issuer: 'USFS (USDA Forest Service) via NIFC WFIGS', linkLabel: 'NIFC WFIGS', acres: 9450, percentContained: 100, isActive: false })
    expect(st.updatedMs).toBe(Date.UTC(2024, 7, 2, 15, 30))
    expect(st.url).toBe(HORSE_GULCH_RECORD.incident_url)
    expect(st.agencies).toBe('USFS (USDA Forest Service)')
    expect(st.protectingUnit).toBe('MTHLF')
  })
  it('never yields the words "CAL FIRE" in record, feed, summary or data-status output', () => {
    const feed = wfigsRecordFeedItems(HORSE_GULCH_RECORD, { mode: 'historical', manifest: null, summary: s, tf: timeFmt('America/Denver', '24h') })
    expect(feed).toHaveLength(1)
    expect(feed[0]).toMatchObject({ topic: 'record', kind: 'official', issuer: 'USFS (USDA Forest Service) via NIFC WFIGS', source: 'USFS (USDA Forest Service) via NIFC WFIGS incident record', updatedMs: Date.UTC(2024, 7, 2, 15, 30) })
    expect(feed[0].title).toBe('USFS (USDA Forest Service) via NIFC WFIGS record: 9,450 acres, 100 % contained, not listed as active')
    expect(feed[0].notes?.[0]).toBe('USFS (USDA Forest Service) via NIFC WFIGS last updated this record Aug 2, 09:30 MDT.')
    const rows = buildDataStatus({ summary: s, manifest: null, perimeters: null, detections: null, forecast: null, weather: null, official: { calfire: st } }, NOW)
    const rec = rows.find((r) => r.key === 'record')!
    expect(rec.label).toBe('Agency record')
    expect(rec.detail).toBe('Last edit of USFS (USDA Forest Service) via NIFC WFIGS’s record · 9,450 ac · 100% contained')
    const line = summaryRecordLine(st, NOW)
    expect(line.label).toBe('USFS (USDA Forest Service) via NIFC WFIGS')
    expect(JSON.stringify([st, feed, rec, line])).not.toMatch(/CAL FIRE/)
  })
  it('the CAL FIRE summary fallback is used for CAL FIRE rows only (calfire.ts:89 mislabel fixed)', () => {
    expect(calfireStatus(null, s, false).state).toBe('unavailable')
    expect(calfireStatus(null, summaryFixture(), false)).toMatchObject({ state: 'available', acres: 1234 })
  })
  it('loading, an outage and an older backend (HTTP 404) are said as such, never as "no record"', () => {
    expect(recordStatus({ calfire: null, record: ok(null, { loading: true }), summary: s, demo: false, hasIncident: true }).state).toBe('loading')
    const down = recordStatus({ calfire: null, record: ok({ ...HORSE_GULCH_RECORD, status: 'unavailable', reason_code: 'upstream_error', reason: 'NIFC WFIGS could not be reached; the agency record is not shown.', current: null }), summary: s, demo: false, hasIncident: true })
    expect(down).toMatchObject({ state: 'unavailable', unreachable: true, reason: 'NIFC WFIGS could not be reached; the agency record is not shown.' })
    const old = recordStatus({ calfire: null, record: ok(null, { error: NOT_FOUND_TEXT }), summary: s, demo: false, hasIncident: true })
    expect(old).toMatchObject({ state: 'unavailable', notChecked: true, reason: RECORD_NOT_CHECKED_REASON })
    expect(summaryRecordLine(old, NOW).text).toBe('Agency record not checked.')
  })
  it('a member fire outside California says "Part of the X Complex" without doubling "Complex"', () => {
    expect(recordStatus({ calfire: null, record: ok(HORSE_GULCH_RECORD), summary: wfigsSummaryFixture({ complex_name: 'Rice Ridge Complex' }), demo: false, hasIncident: true }).complexName).toBe('Rice Ridge Complex')
    expect(partOfComplex('Rice Ridge Complex')).toBe('Part of the Rice Ridge Complex')
    expect(partOfComplex('Rice Ridge')).toBe('Part of the Rice Ridge Complex')
    expect(partOfComplex(null)).toBeNull()
  })
})

describe('synthetic or local data', () => {
  it('a demo or fixture bundle: "not available: synthetic or local data", nothing fetched', () => {
    const st = recordStatus({ calfire: null, record: null, summary: summaryFixture({ id: 'fixture-east', calfire_uid: '' }), demo: true, hasIncident: true })
    expect(st).toMatchObject({ state: 'unavailable', synthetic: true, reason: SYNTHETIC_RECORD_REASON, source: null })
    expect(summaryRecordLine(st, NOW).text).toBe('Not available: synthetic or local data.')
    expect(buildDataStatus({ summary: null, manifest: null, perimeters: null, detections: null, forecast: null, weather: null, official: { calfire: st } }, NOW).find((r) => r.key === 'record')).toBeUndefined()
  })
  it("the record endpoint's not_covered answer for local data reads the same", () => {
    const local = { ...HORSE_GULCH_RECORD, status: 'unavailable' as const, reason_code: 'not_covered', reason: 'This is synthetic or local data; it has no agency record.', current: null }
    expect(recordStatus({ calfire: null, record: ok(local), summary: wfigsSummaryFixture(), demo: false, hasIncident: true })).toMatchObject({ synthetic: true, reason: SYNTHETIC_RECORD_REASON })
  })
})

describe('California fires: disagreement and complexes (round 3 items 2 and 3)', () => {
  const wfigsTimber: OtherRecord = { source: 'wfigs', id: 'T1', name: 'Timber', issuer: 'USFS via NIFC WFIGS', agency: 'USDA Forest Service', agency_code: 'USFS', acres: 520, percent_contained: 30, is_active: true, updated_ms: Date.UTC(2026, 9, 22, 16, 5), url: 'https://nifc.example/timber' }
  it('Timber: active in NIFC WFIGS, not in CAL FIRE: each record with its own issuer, status and time', () => {
    const s = summaryFixture({ name: 'Timber Fire', irwin_id: 'T1', active_sources: ['wfigs'], is_active: true, other_records: [wfigsTimber], updated_ms: Date.UTC(2026, 9, 20, 15, 0) })
    const st = recordStatus({ calfire: null, record: null, summary: s, demo: false, hasIncident: true })
    expect(st.issuer).toBe('CAL FIRE')
    expect(st.blocks?.map((b) => [b.issuer, b.isActive])).toEqual([
      ['CAL FIRE', false],
      ['USFS (USDA Forest Service) via NIFC WFIGS', true],
    ])
    const tf = timeFmt('America/Los_Angeles', '12h')
    expect(recordBlockText(st.blocks![1], tf)).toBe('Active (USFS (USDA Forest Service) via NIFC WFIGS, updated Oct 22, 9:05 AM PDT)')
    expect(recordBlockText(st.blocks![0], tf)).toBe('Not listed as active (CAL FIRE, updated Oct 20, 8:00 AM PDT)')
    // the fetched WFIGS record refreshes its own block
    const fresh = recordStatus({ calfire: null, record: ok({ ...HORSE_GULCH_RECORD, current: { ...HORSE_GULCH_RECORD.current!, is_active: true, updated_ms: Date.UTC(2026, 9, 22, 17, 0) } }), summary: s, demo: false, hasIncident: true })
    expect(fresh.blocks?.[1].updatedMs).toBe(Date.UTC(2026, 9, 22, 17, 0))
  })
  it('a CAL FIRE complex row shows its named members and never a member record as the complex', () => {
    const members: OtherRecord[] = [
      { ...wfigsTimber, id: 'M1', name: '2-2', acres: 99999, is_active: true, url: 'https://nifc.example/2-2' },
      { ...wfigsTimber, id: 'M2', name: '2-7', acres: 88888, is_active: true, url: 'https://nifc.example/2-7' },
    ]
    const s = summaryFixture({ name: 'June Lightning Complex', irwin_id: null, acres: 1500, percent_contained: 20, active_sources: ['calfire', 'wfigs'], is_active: true, complex_members: ['2-2', '2-7'], other_records: members })
    expect(secondaryRecordUrl(s)).toBeNull() // never /api/official/incident-record
    const st = recordStatus({ calfire: null, record: null, summary: s, demo: false, hasIncident: true })
    expect(st.members).toEqual([
      { name: '2-2', url: 'https://nifc.example/2-2' },
      { name: '2-7', url: 'https://nifc.example/2-7' },
    ])
    expect(st).toMatchObject({ issuer: 'CAL FIRE', acres: 1500, percentContained: 20 })
    expect(JSON.stringify(st)).not.toMatch(/99999|88888/)
    expect(st.blocks).toBeUndefined()
  })
})
