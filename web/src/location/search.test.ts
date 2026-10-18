import { describe, expect, it } from 'vitest'
import type { IncidentSummary } from '../api/types'
import { addressRange } from './addressStore'
import { likelyMissingWestSign, looksLikeAddress, planSearch, searchIncidents } from './search'

const inc = (id: string, name: string, over: Partial<IncidentSummary> = {}): IncidentSummary =>
  ({ id, name, year: 2025, county: 'Los Angeles', location: null, admin_unit: null, acres: 1000, is_active: false, ...over }) as IncidentSummary

const POOL = [
  inc('2025-eaton-fire-dbfa57', 'Eaton Fire', { acres: 14021, location: 'Altadena' }),
  inc('2025-palisades-fire-abfed7', 'Palisades Fire', { acres: 23448 }),
  inc('2025-madre-fire-01e7e8', 'Madre Fire', { acres: 80779, county: 'San Luis Obispo' }),
  inc('2026-cooley-fire-0c342f', 'Cooley Fire', { year: 2026, acres: 300, is_active: true, county: 'Monterey' }),
  inc('2024-easton-fire-111111', 'Easton Fire', { year: 2024, acres: 120 }),
  inc('2025-lidia-fire-83adc9', 'Lidia Fire', { acres: 350, location: 'Agua Dulce' }),
]

describe('looksLikeAddress (house number first)', () => {
  it.each(['600 E Mariposa St, Altadena, CA 91001', '1 Rose Bowl Dr, Pasadena', '100-12 Main St', 'N1234 County Rd K, WI', '1600 Pennsylvania Ave NW, Washington, DC', '42B Baker St'])('%s', (t) => {
    expect(looksLikeAddress(t)).toBe(true)
  })
  it.each(['Eaton', 'Eaton Fire 2025', 'Altadena, CA', '91001', '34.2, -118.1', 'Main St 100', ''])('not: %s', (t) => {
    expect(looksLikeAddress(t)).toBe(false)
  })
})

describe('searchIncidents (local catalog only)', () => {
  it('matches word prefixes across name, county, place, id and year, best first', () => {
    expect(searchIncidents('eaton', POOL).map((h) => h.summary.id)).toEqual(['2025-eaton-fire-dbfa57'])
    expect(searchIncidents('Eaton Fire', POOL)[0].score).toBe(100)
    expect(searchIncidents('eat', POOL).map((h) => h.summary.name)).toEqual(['Eaton Fire'])
    expect(searchIncidents('eas', POOL).map((h) => h.summary.name)).toEqual(['Easton Fire'])
    expect(searchIncidents('altadena', POOL).map((h) => h.summary.name)).toEqual(['Eaton Fire'])
    expect(searchIncidents('monterey', POOL).map((h) => h.summary.name)).toEqual(['Cooley Fire'])
    expect(searchIncidents('fire 2026', POOL).map((h) => h.summary.name)).toEqual(['Cooley Fire'])
    expect(searchIncidents('agua dulce', POOL).map((h) => h.summary.name)).toEqual(['Lidia Fire'])
    expect(searchIncidents('MÁDRE', POOL).map((h) => h.summary.name)).toEqual(['Madre Fire']) // accents / case folded
  })
  it('ranks active, then larger fires among equal matches, and dedupes', () => {
    const r = searchIncidents('fire', [...POOL, POOL[0]])
    expect(r[0].summary.name).toBe('Cooley Fire') // the only active one
    expect(r.slice(1, 3).map((h) => h.summary.name)).toEqual(['Madre Fire', 'Palisades Fire'])
    expect(new Set(r.map((h) => h.summary.id)).size).toBe(r.length)
    expect(r.length).toBe(6)
  })
  it('needs every word to match', () => {
    expect(searchIncidents('eaton madre', POOL)).toEqual([])
    expect(searchIncidents('', POOL)).toEqual([])
  })
})

describe('planSearch', () => {
  it('reads coordinates first and never sends them anywhere', () => {
    const p = planSearch('34.2048, -118.1027', POOL)
    expect(p.kind).toBe('coords')
    if (p.kind === 'coords') expect(p.parsed).toMatchObject({ lat: 34.2048, lon: -118.1027 })
    expect(planSearch(`34°12'17"N 118°6'10"W`, POOL).kind).toBe('coords')
  })
  it('uses incident names locally and geocodes only house-number addresses', () => {
    expect(planSearch('Eaton', POOL)).toMatchObject({ kind: 'incidents' })
    expect(planSearch('600 E Mariposa St, Altadena, CA 91001', POOL)).toMatchObject({ kind: 'address', query: '600 E Mariposa St, Altadena, CA 91001' })
    // an address that also matches an incident place lists both
    const both = planSearch('600 Eaton Canyon Dr, Altadena', POOL)
    expect(both.kind).toBe('address')
    expect(planSearch('Altadena Library', POOL)).toMatchObject({ kind: 'nothing' }) // not POI search
    expect(planSearch('   ', POOL)).toEqual({ kind: 'empty' })
  })
})

describe('likelyMissingWestSign', () => {
  it('flags California latitudes with an east longitude', () => {
    expect(likelyMissingWestSign({ lat: 34.2, lon: 118.1 })).toBe(true)
    expect(likelyMissingWestSign({ lat: 34.2, lon: -118.1 })).toBe(false)
    expect(likelyMissingWestSign({ lat: -33.9, lon: 151.2 })).toBe(false)
  })
})

describe('addressRange', () => {
  it('lists house numbers in ascending order', () => {
    expect(addressRange('144', '100')).toBe('100–144')
    expect(addressRange('600', '628')).toBe('600–628')
    expect(addressRange('12A', '2')).toBe('12A–2')
    expect(addressRange(null, '2')).toBeNull()
  })
})
