// recordStatus (CONTRACT §14.5, round 3 item 2): the status of a fire's own record comes from that agency's own active
// flag, never from the merged listing (which is active when either agency says so).
import { describe, expect, it } from 'vitest'
import { otherRecordFixture, summaryFixture, wfigsSummaryFixture } from '../api/fixtures.testutil'
import { agencyNameShown, recordStatus } from './recordText'

const live = { mode: 'live' as const, year: 2026, is_active: true }

describe('recordStatus', () => {
  it('the own record active: the listing word', () => {
    expect(recordStatus(summaryFixture({ ...live, active_sources: ['calfire'] }))).toEqual({ key: 'active', label: 'Active', ownActive: true })
    expect(recordStatus(summaryFixture({ ...live, active_sources: ['calfire', 'wfigs'] })).label).toBe('Active')
  })

  it('only the other agency lists it as active (the Timber Fire): "Not listed as active", never "Active"', () => {
    const timber = summaryFixture({ ...live, percent_contained: 97, active_sources: ['wfigs'], other_records: [otherRecordFixture()] })
    expect(recordStatus(timber)).toEqual({ key: 'out', label: 'Not listed as active', ownActive: false })
  })

  it('a contained own record reads "Contained" (at 100 % or with a containment date)', () => {
    expect(recordStatus(summaryFixture({ ...live, percent_contained: 100, active_sources: ['wfigs'] })).label).toBe('Contained')
    expect(recordStatus(summaryFixture({ ...live, percent_contained: 80, contained_ms: Date.UTC(2026, 9, 1), active_sources: ['wfigs'] })).label).toBe('Contained')
  })

  it('a NIFC WFIGS record that CAL FIRE alone lists as active', () => {
    const s = wfigsSummaryFixture({ ...live, percent_contained: 20, active_sources: ['calfire'] })
    expect(recordStatus(s).label).toBe('Not listed as active')
    expect(recordStatus({ ...s, active_sources: ['wfigs'] }).label).toBe('Active')
  })

  it('a past fire neither agency lists: the listing word ("Out", "Contained")', () => {
    expect(recordStatus(summaryFixture({ percent_contained: 40 })).label).toBe('Out')
    expect(recordStatus(summaryFixture({ percent_contained: 100 })).label).toBe('Contained')
  })

  it('old rows without active_sources use is_active', () => {
    expect(recordStatus(summaryFixture({ ...live, active_sources: undefined })).label).toBe('Active')
    expect(recordStatus(summaryFixture({ mode: 'historical', is_active: false, active_sources: undefined, percent_contained: 50 })).label).toBe('Out')
  })
})

describe('agencyNameShown (§14.13 credit)', () => {
  it('true when a plain agency name is added after a NIFC WFIGS code', () => {
    expect(agencyNameShown(wfigsSummaryFixture())).toBe(true)
    expect(agencyNameShown(wfigsSummaryFixture({ agency: null }))).toBe(false)
    expect(agencyNameShown(wfigsSummaryFixture({ agency: 'USFS' }))).toBe(false) // the name says no more than the code
    expect(agencyNameShown(summaryFixture())).toBe(false)
  })

  it('counts another record only when the card shows it (it disagrees)', () => {
    const named = otherRecordFixture({ agency: 'USDA Forest Service', is_active: true })
    expect(agencyNameShown(summaryFixture({ ...live, active_sources: ['wfigs'], other_records: [named] }))).toBe(true)
    expect(agencyNameShown(summaryFixture({ ...live, active_sources: ['calfire', 'wfigs'], other_records: [named] }))).toBe(false)
  })
})
