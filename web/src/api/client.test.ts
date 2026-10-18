import { describe, expect, it } from 'vitest'
import { incidentListQuery } from './client'

describe('incident list query (brief 2, I2)', () => {
  it('sends the year explicitly for historical lists only', () => {
    expect(incidentListQuery('historical', 300, 2026)).toBe('mode=historical&min_acres=300&year=2026')
    expect(incidentListQuery('historical', 100, 2025)).toBe('mode=historical&min_acres=100&year=2025')
    expect(incidentListQuery('historical')).toBe('mode=historical')
    expect(incidentListQuery('live', undefined, 2026)).toBe('mode=live')
  })
})
