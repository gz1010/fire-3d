import { afterEach, describe, expect, it, vi } from 'vitest'
import { geoLookupQuery, getAccuracyRegions, getGeoLookup, incidentListQuery } from './client'

describe('incident list query (brief 2, I2)', () => {
  it('sends the year explicitly for historical lists only', () => {
    expect(incidentListQuery('historical', 300, 2026)).toBe('mode=historical&min_acres=300&year=2026')
    expect(incidentListQuery('historical', 100, 2025)).toBe('mode=historical&min_acres=100&year=2025')
    expect(incidentListQuery('historical')).toBe('mode=historical')
    expect(incidentListQuery('live', undefined, 2026)).toBe('mode=live')
  })

  it('filters by state in both modes (brief 3, CONTRACT 14.1)', () => {
    expect(incidentListQuery('historical', 300, 2026, 'OR')).toBe('mode=historical&min_acres=300&year=2026&state=OR')
    expect(incidentListQuery('live', undefined, undefined, ' mt ')).toBe('mode=live&state=MT')
    expect(incidentListQuery('live', undefined, undefined, '')).toBe('mode=live')
  })
})

describe('brief 3 fetchers (CONTRACT 14.3, 14.4)', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubFetch(body: unknown) {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
    )
    return calls
  }

  it('rounds the lookup point to about 1 m', () => {
    expect(geoLookupQuery(-116.2, 43.615)).toBe('lon=-116.2&lat=43.615')
    expect(geoLookupQuery(-84.3879512, 33.7489954)).toBe('lon=-84.38795&lat=33.749')
  })

  it('getGeoLookup asks /api/geo/lookup with lon then lat', async () => {
    const body = { lon: -116.2, lat: 43.615, coverage: 'lower48', supported: true, state: 'ID', state_name: 'Idaho', county: null, time_zone: 'America/Denver', time_zone_name: 'Mountain Time', note: null }
    const calls = stubFetch(body)
    const r = await getGeoLookup(-116.2, 43.615)
    expect(calls).toEqual(['/api/geo/lookup?lon=-116.2&lat=43.615'])
    expect(r.state).toBe('ID')
  })

  it('getAccuracyRegions asks /api/accuracy-regions', async () => {
    const calls = stubFetch({ schema_version: 1, regions: [] })
    const r = await getAccuracyRegions()
    expect(calls).toEqual(['/api/accuracy-regions'])
    expect(r.schema_version).toBe(1)
  })
})
