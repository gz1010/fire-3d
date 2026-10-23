import { describe, expect, it } from 'vitest'
import type { GeoLookup } from '../api/types'
import { coverageText, isSupportedCoverage, lookupPlace, NOT_SUPPORTED_TEXT, OUTSIDE_US_TEXT } from './geoLookup'

const g = (over: Partial<GeoLookup>): GeoLookup => ({
  lon: -116.2,
  lat: 43.615,
  coverage: 'lower48',
  supported: true,
  state: 'ID',
  state_name: 'Idaho',
  county: { fips: '16001', name: 'Ada County' },
  time_zone: 'America/Boise',
  time_zone_name: 'Mountain Time',
  note: null,
  ...over,
})

describe('coverage at a point comes from /api/geo/lookup only (W9, §14.14)', () => {
  it('the lower 48: no coverage sentence', () => {
    expect(coverageText(g({}))).toBeNull()
    expect(coverageText(null)).toBeNull()
  })
  it('Alaska, Hawaii, territories: "not supported yet"; outside the US: "no data here"', () => {
    const off = { supported: false, state: null, state_name: null, county: null, time_zone: null, time_zone_name: null }
    expect(coverageText(g({ ...off, coverage: 'alaska' }))).toBe('Fire-3d does not support Alaska, Hawaii or US territories yet.')
    expect(coverageText(g({ ...off, coverage: 'hawaii' }))).toBe(NOT_SUPPORTED_TEXT)
    expect(coverageText(g({ ...off, coverage: 'territory' }))).toBe(NOT_SUPPORTED_TEXT)
    expect(coverageText(g({ ...off, coverage: 'outside_us' }))).toBe('Outside the United States: Fire-3d has no data here.')
    expect(OUTSIDE_US_TEXT).toBe('Outside the United States: Fire-3d has no data here.')
    // the server's own note wins when it has one
    expect(coverageText(g({ ...off, coverage: 'alaska', note: 'Fire-3d does not support Alaska, Hawaii or US territories yet.' }))).toBe(NOT_SUPPORTED_TEXT)
  })
  it('the place line', () => {
    expect(lookupPlace(g({}))).toBe('Ada County, ID')
    expect(lookupPlace(g({ county: null }))).toBe('Idaho')
    expect(lookupPlace(g({ state: null }))).toBeNull()
    expect(isSupportedCoverage('lower48')).toBe(true)
    expect(isSupportedCoverage('alaska')).toBe(false)
  })
})
