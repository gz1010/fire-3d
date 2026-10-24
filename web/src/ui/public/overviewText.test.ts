import { describe, expect, it } from 'vitest'
import { LIST_ABSENCE } from '../../state/overview'
import { ACTIVE_COUNT_TIP, activeCountPart, barDate, detailsPillLabel } from './overviewText'

describe('overview top bar status (brief 4, Main.dc.html)', () => {
  it('the local date in mono capitals', () => {
    expect(barDate(Date.UTC(2026, 9, 24, 18), 'America/Denver')).toBe('OCT 24 2026')
    expect(barDate(Date.UTC(2026, 9, 25, 3), 'America/Los_Angeles')).toBe('OCT 24 2026')
    expect(barDate(Date.UTC(2026, 9, 25, 3), 'UTC')).toBe('OCT 25 2026')
  })

  it('counts listed active fires; never a 0 when the lists could not be read (§14.16)', () => {
    const base = { count: 203, loaded: true, loading: false, failed: false, allDown: false }
    expect(activeCountPart(base)).toEqual({ text: '203 ACTIVE', tone: 'count' })
    expect(activeCountPart({ ...base, count: 1234 }).text).toBe('1,234 ACTIVE')
    expect(activeCountPart({ ...base, loaded: false, loading: true }).text).toBe('LOADING FIRES')
    expect(activeCountPart({ ...base, loaded: false, failed: true }).text).toBe('FIRE LIST UNAVAILABLE')
    expect(activeCountPart({ ...base, count: 0, allDown: true }).text).toBe('FIRE LISTS UNAVAILABLE')
    expect(activeCountPart({ ...base, count: 0 }).text).toBe('0 ACTIVE')
  })

  it('the tooltip says whose list it is and carries the list-absence line verbatim (decision i-4)', () => {
    expect(ACTIVE_COUNT_TIP).toContain('CAL FIRE')
    expect(ACTIVE_COUNT_TIP).toContain('NIFC')
    expect(ACTIVE_COUNT_TIP.endsWith(LIST_ABSENCE)).toBe(true)
  })
})

describe('"Show details" pill (decision d)', () => {
  it('names the list and its size', () => {
    expect(detailsPillLabel(false, 203)).toEqual({ text: 'Show details', aria: 'Show details: list of 203 fires' })
    expect(detailsPillLabel(true, 1)).toEqual({ text: 'Hide details', aria: 'Hide details (list of 1 fire)' })
    expect(detailsPillLabel(false, null).aria).toMatch(/loading/)
    expect(detailsPillLabel(false, 1363).aria).toBe('Show details: list of 1,363 fires')
  })
})
