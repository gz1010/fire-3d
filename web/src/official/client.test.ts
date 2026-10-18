import { describe, expect, it } from 'vitest'
import { calfireUrl, fireWeatherAtMs, fireWeatherStatewideUrl, fireWeatherUrl, isFixtureIncident } from './client'
import { forIncident } from './guard'
import { httpsUrl } from './url'

const H = 3_600_000
const NOW = 1792342686054

describe('official client', () => {
  it('builds the endpoint URLs', () => {
    expect(calfireUrl('2026-henderson-fire-3e3dfe')).toBe('/api/official/calfire?incident=2026-henderson-fire-3e3dfe')
    expect(fireWeatherUrl('a b', null)).toBe('/api/official/fire-weather?incident=a+b')
    expect(fireWeatherUrl('x', 1736366400000.4)).toBe('/api/official/fire-weather?incident=x&at_ms=1736366400000')
    expect(fireWeatherStatewideUrl()).toBe('/api/official/fire-weather')
  })

  it('asks for the live feed at the present and the hourly archive otherwise (historical: always at_ms)', () => {
    expect(fireWeatherAtMs('live', NOW - H, NOW, NOW - 2 * H)).toBeNull()
    expect(fireWeatherAtMs('live', NOW - 20 * H, NOW, NOW - 10 * H)).toBe(Math.floor((NOW - 20 * H) / H) * H)
    expect(fireWeatherAtMs('live', NOW - 20 * H, NOW, NOW - 30 * H)).toBeNull() // at / after a stale NOW marker
    expect(fireWeatherAtMs('historical', 1736366400123, NOW)).toBe(1736366400000)
  })

  it('knows demo bundles, https links and the open fire', () => {
    expect(isFixtureIncident('fixture-demo')).toBe(true)
    expect(isFixtureIncident('2025-eaton-fire-dbfa57')).toBe(false)
    expect(httpsUrl('https://www.fire.ca.gov/incidents/')).toBe('https://www.fire.ca.gov/incidents/')
    expect(httpsUrl('http://example.com')).toBeNull()
    expect(httpsUrl('javascript:alert(1)')).toBeNull()
    expect(httpsUrl('not a url')).toBeNull()
    expect(httpsUrl(null)).toBeNull()
    expect(forIncident({ incident_id: 'a' }, 'a')).toEqual({ incident_id: 'a' })
    expect(forIncident({ incident_id: 'a' }, 'b')).toBeNull()
    expect(forIncident({ incident_id: 'a' }, null)).toBeNull()
    expect(forIncident({ incident_id: null }, 'b')).toEqual({ incident_id: null })
    expect(forIncident(null, 'b')).toBeNull()
  })
})
