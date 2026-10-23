import { describe, expect, it } from 'vitest'
import { otherRecordFixture, summaryFixture, wfigsSummaryFixture } from './fixtures.testutil'
import { ownRecordActive, recordBlocks, recordIssuerLabel } from './records'
import type { IncidentSummary } from './types'

const T_CALFIRE = Date.UTC(2026, 9, 21, 3, 41)
const T_WFIGS = Date.UTC(2026, 9, 22, 16, 5)

/** The Timber Fire on Oct 22, 2026: CAL FIRE lists it (25,351.9 ac, 97 %) as not active; NIFC WFIGS as active. */
function timberLike(): IncidentSummary {
  return summaryFixture({
    id: '2026-timber-fire-a1b2c3',
    name: 'Timber Fire',
    year: 2026,
    acres: 25351.9,
    percent_contained: 97,
    is_active: true, // CA_ACTIVE_RULE "either"
    updated_ms: T_CALFIRE,
    active_sources: ['wfigs'],
    irwin_id: '51374D2C-0000-0000-0000-000000000000',
    other_records: [otherRecordFixture({ name: 'TIMBER', is_active: true, updated_ms: T_WFIGS, agency: 'USDA Forest Service' })],
  })
}

describe('recordIssuerLabel (CONTRACT 14.5)', () => {
  it('names CAL FIRE for CAL FIRE rows', () => {
    expect(recordIssuerLabel(summaryFixture())).toBe('CAL FIRE')
  })

  it('adds the plain agency name after the verbatim code for WFIGS rows', () => {
    expect(recordIssuerLabel(wfigsSummaryFixture())).toBe('USFS (USDA Forest Service) via NIFC WFIGS')
  })

  it('shows the code verbatim when the plain name is unknown', () => {
    expect(recordIssuerLabel(wfigsSummaryFixture({ agency: null }))).toBe('USFS via NIFC WFIGS')
    expect(recordIssuerLabel(wfigsSummaryFixture({ agency: null, agency_code: 'C&L', record_issuer: 'C&L via NIFC WFIGS' }))).toBe(
      'C&L via NIFC WFIGS',
    )
  })

  it('keeps "NIFC WFIGS (IRWIN)" for a record without an agency code', () => {
    expect(recordIssuerLabel(wfigsSummaryFixture({ agency: null, agency_code: null, record_issuer: 'NIFC WFIGS (IRWIN)' }))).toBe(
      'NIFC WFIGS (IRWIN)',
    )
  })

  it('reads old fixtures without record_issuer as CAL FIRE only when calfire_uid is set', () => {
    const old = summaryFixture({ record_issuer: undefined, record_source: undefined, agency: undefined })
    expect(recordIssuerLabel(old)).toBe('CAL FIRE')
    expect(recordIssuerLabel({ ...old, calfire_uid: '' })).toBe('Agency record')
  })

  it('never yields "CAL FIRE" for a WFIGS summary', () => {
    const variants: IncidentSummary[] = [
      wfigsSummaryFixture(),
      wfigsSummaryFixture({ agency: null }),
      wfigsSummaryFixture({ record_issuer: undefined }),
      wfigsSummaryFixture({ record_issuer: '', agency_code: null, agency: null }),
    ]
    for (const s of variants) {
      expect(recordIssuerLabel(s)).not.toContain('CAL FIRE')
      for (const b of recordBlocks(s)) expect(b.issuer).not.toContain('CAL FIRE')
    }
  })
})

describe('recordBlocks (CONTRACT 14.5; round 3 items 2-3)', () => {
  it('gives one block when there is no other record', () => {
    const blocks = recordBlocks(wfigsSummaryFixture({ is_active: true, active_sources: ['wfigs'] }))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ source: 'wfigs', issuer: 'USFS (USDA Forest Service) via NIFC WFIGS', is_active: true, name: null })
  })

  it('gives one block when the agencies agree', () => {
    const s = summaryFixture({
      is_active: true,
      active_sources: ['calfire', 'wfigs'],
      other_records: [otherRecordFixture({ is_active: true })],
    })
    expect(recordBlocks(s)).toHaveLength(1)
    expect(recordBlocks(s)[0]).toMatchObject({ source: 'calfire', issuer: 'CAL FIRE', is_active: true })
  })

  it('shows both records of a Timber-like fire, each with its own issuer, status and time', () => {
    const blocks = recordBlocks(timberLike())
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({
      source: 'calfire',
      issuer: 'CAL FIRE',
      name: null,
      is_active: false,
      updated_ms: T_CALFIRE,
      url: 'https://www.fire.ca.gov/incidents/2025/7/1/test-fire',
    })
    expect(blocks[1]).toMatchObject({
      source: 'wfigs',
      issuer: 'USFS (USDA Forest Service) via NIFC WFIGS',
      name: 'TIMBER',
      is_active: true,
      updated_ms: T_WFIGS,
    })
    expect(blocks[1].url).toMatch(/^https:\/\//)
  })

  it("lists a complex's active member with its own name after CAL FIRE's block, never as the complex", () => {
    const complex = summaryFixture({
      id: '2025-tcu-september-lightning-complex-1a2b3c',
      name: 'TCU September Lightning Complex',
      acres: 13869,
      percent_contained: 95,
      is_active: true,
      active_sources: ['wfigs'],
      irwin_id: null,
      complex_members: ['2-2', '2-7', '6-5'],
      other_records: [
        otherRecordFixture({ id: 'A1', name: '2-2', acres: 3462, is_active: false }),
        otherRecordFixture({ id: 'A2', name: '2-7', acres: 1200, is_active: true }),
        otherRecordFixture({ id: 'A3', name: '6-5', acres: 900, is_active: false }),
      ],
    })
    const blocks = recordBlocks(complex)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ source: 'calfire', issuer: 'CAL FIRE', name: null, is_active: false })
    expect(blocks[1]).toMatchObject({ source: 'wfigs', name: '2-7', is_active: true })
    // The complex's own block carries CAL FIRE's time and link, never a member's.
    expect(blocks[0].updated_ms).toBe(complex.updated_ms)
    expect(blocks[0].url).toBe(complex.url)
  })

  it('reads old fixtures without active_sources from is_active', () => {
    const old = summaryFixture({ active_sources: undefined, is_active: true })
    expect(ownRecordActive(old)).toBe(true)
    expect(recordBlocks(old)).toHaveLength(1)
  })
})
