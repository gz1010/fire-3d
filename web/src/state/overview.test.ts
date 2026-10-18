import { describe, expect, it } from 'vitest'
import type { IncidentSummary } from '../api/types'
import { analysisState, findFire, FIRE_VIEW_MIN_M, fireFlyTo, fireStatus, fireViewRadiusM, isActiveFire, newestRecordMs, overviewFires, preparedFires, SEASON_YEAR } from './overview'

const row = (id: string, over: Partial<IncidentSummary> = {}): IncidentSummary => ({
  id,
  name: id,
  mode: 'historical',
  year: SEASON_YEAR,
  calfire_uid: id,
  started_ms: Date.UTC(2026, 6, 1),
  updated_ms: null,
  contained_ms: null,
  acres: 1000,
  percent_contained: 100,
  is_active: false,
  county: null,
  location: null,
  admin_unit: null,
  url: null,
  lat: 34,
  lon: -118,
  detections_24h: null,
  bundle_status: 'none',
  bundle_built_ms: null,
  ...over,
})

describe('overviewFires', () => {
  const live = [row('2026-a', { mode: 'live', is_active: true, acres: 500, percent_contained: 10 }), row('2026-b', { mode: 'live', is_active: true, acres: 9000 })]
  const season = [row('2026-b', { acres: 8000 }), row('2026-c', { acres: 20000 }), row('2026-d', { acres: 300 })]
  const historical = [row('2025-x', { year: 2025, acres: 100 }), row('2025-y', { year: 2025, acres: 14000 })]
  const catalog = { live, season, historical }

  it('active: the live list, largest first', () => {
    expect(overviewFires(catalog, 'active').map((s) => s.id)).toEqual(['2026-b', '2026-a'])
  })

  it('season: live ∪ season without duplicates (the live row wins), active fires first', () => {
    const rows = overviewFires(catalog, 'season')
    expect(rows.map((s) => s.id)).toEqual(['2026-b', '2026-a', '2026-c', '2026-d'])
    expect(rows[0].mode).toBe('live')
    expect(rows[0].acres).toBe(9000)
  })

  it('past: the 2025 list by acres', () => {
    expect(overviewFires(catalog, 'past').map((s) => s.id)).toEqual(['2025-y', '2025-x'])
  })

  it('sorts unknown acreage last and never mutates the lists', () => {
    const rows = overviewFires({ live: [], season: [row('n', { acres: null }), row('m', { acres: 1 })], historical: [] }, 'season')
    expect(rows.map((s) => s.id)).toEqual(['m', 'n'])
    expect(season.map((s) => s.id)).toEqual(['2026-b', '2026-c', '2026-d'])
  })

  it('finds a fire in the summary, then the lists', () => {
    const summary = row('2026-c', { acres: 1 })
    expect(findFire('2026-c', summary, catalog)?.acres).toBe(1)
    expect(findFire('2026-b', null, catalog)?.mode).toBe('live')
    expect(findFire('2025-y', null, catalog)?.year).toBe(2025)
    expect(findFire('nope', null, catalog)).toBeNull()
    expect(findFire(null, summary, catalog)).toBeNull()
  })
})

describe('preparedFires (zoom focus candidates)', () => {
  it('takes every ready fire with an area from all three lists, whatever the filter', () => {
    const box: [number, number, number, number] = [-118.3, 34.1, -118.0, 34.4]
    const catalog = {
      live: [row('2026-a', { mode: 'live', bundle_status: 'ready', bbox_lonlat: box }), row('2026-b', { mode: 'live' })],
      season: [row('2026-a', { bundle_status: 'ready', bbox_lonlat: box }), row('2026-c', { bundle_status: 'building', bbox_lonlat: box })],
      historical: [row('2025-e', { year: 2025, bundle_status: 'ready', bbox_lonlat: box }), row('2025-f', { year: 2025, bundle_status: 'ready', bbox_lonlat: null })],
    }
    const ids = preparedFires(catalog).map((s) => s.id)
    expect(ids).toEqual(['2026-a', '2025-e'])
    expect(preparedFires(catalog)[0].mode).toBe('live')
  })
})

describe('CAL FIRE status words', () => {
  it('reads the record flags, never a model', () => {
    expect(fireStatus(row('a', { mode: 'live', is_active: true, percent_contained: 40 }))).toEqual({ key: 'active', label: 'Active' })
    expect(fireStatus(row('a', { percent_contained: 100 })).key).toBe('contained')
    expect(fireStatus(row('a', { percent_contained: 80, contained_ms: 1 })).key).toBe('contained')
    expect(fireStatus(row('a', { percent_contained: 80 })).key).toBe('out')
    expect(fireStatus(row('a', { percent_contained: 80, is_active: true })).key).toBe('active')
    expect(isActiveFire(row('a', { mode: 'live' }))).toBe(true)
    expect(isActiveFire(row('a'))).toBe(false)
  })

  it('maps the bundle status to the analysis state', () => {
    expect(analysisState(row('a', { bundle_status: 'ready' }))).toBe('ready')
    expect(analysisState(row('a', { bundle_status: 'building' }))).toBe('building')
    expect(analysisState(row('a', { bundle_status: 'error' }))).toBe('error')
    expect(analysisState(row('a'))).toBe('none')
  })

  it("takes the newest CAL FIRE record time, not the list's fetch time", () => {
    expect(newestRecordMs([row('a', { updated_ms: 5 }), row('b', { updated_ms: 9 }), row('c')])).toBe(9)
    expect(newestRecordMs([row('a')])).toBeNull()
  })
})

describe('fireFlyTo', () => {
  it("uses the built bundle's area when the row has one", () => {
    expect(fireFlyTo(row('a', { bbox_lonlat: [-118.3, 34.1, -118.0, 34.4] }))).toEqual({ lon: -118.15, lat: 34.25, bounds: [-118.3, 34.1, -118.0, 34.4] })
  })

  it('else a box of 2.5x the acreage radius around the reported point, at least 3 km', () => {
    expect(fireViewRadiusM(null)).toBe(FIRE_VIEW_MIN_M)
    expect(fireViewRadiusM(10)).toBe(FIRE_VIEW_MIN_M)
    const r = fireViewRadiusM(14021) // Eaton: a circle of 14,021 ac has a 4.25 km radius
    expect(r).toBeGreaterThan(10_500)
    expect(r).toBeLessThan(10_700)
    const f = fireFlyTo(row('a', { acres: 14021, lat: 34.2, lon: -118.1, bbox_lonlat: null }))
    expect(f?.lon).toBe(-118.1)
    const [w, s, e, n] = f?.bounds ?? [0, 0, 0, 0]
    expect((n - s) * 111_320).toBeCloseTo(2 * r, -1)
    expect((e - w) * 111_320 * Math.cos((34.2 * Math.PI) / 180)).toBeCloseTo(2 * r, -1)
  })

  it('ignores broken boxes and invalid points', () => {
    expect(fireFlyTo(row('a', { bbox_lonlat: [-118, 34, -119, 35] }))?.bounds?.[0]).toBeLessThan(-118)
    expect(fireFlyTo(row('a', { lat: Number.NaN }))).toBeNull()
  })
})
