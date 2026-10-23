import { describe, expect, it } from 'vitest'
import type { IncidentSummary } from '../api/types'
import { catalogApply, catalogFail, catalogPatch, catalogPending, EMPTY_CATALOG, listsForModes } from './catalog'

const row = (id: string, year: number, over: Partial<IncidentSummary> = {}): IncidentSummary =>
  ({ id, name: id, year, mode: 'historical', bundle_status: 'none', acres: 1, lat: 34, lon: -118, ...over }) as IncidentSummary

describe('catalog lists', () => {
  it('maps the older modes option to lists', () => {
    expect(listsForModes(['live'])).toEqual(['live'])
    expect(listsForModes(['historical'])).toEqual(['historical'])
    expect(listsForModes(['live', 'historical'])).toEqual(['live', 'historical'])
  })

  it('tracks loading per list and in total', () => {
    let c = catalogPending(EMPTY_CATALOG, ['live', 'season'], 300)
    expect(c.listLoading).toEqual({ live: true, season: true, historical: false })
    expect(c.loading).toBe(true)
    c = catalogApply(c, 'live', { incidents: [row('2026-a', 2026, { mode: 'live' })], updated_ms: 10 })
    expect(c.live).toHaveLength(1)
    expect(c.updatedMs.live).toBe(10)
    expect(c.loading).toBe(true)
    c = catalogApply(c, 'season', { incidents: [row('2026-a', 2026), row('2025-z', 2025)], updated_ms: 11 })
    expect(c.loading).toBe(false)
    // a server that ignores ?year= answers the 2025 list: those rows never enter the season
    expect(c.season.map((s) => s.id)).toEqual(['2026-a'])
  })

  it("keeps each answer's sources[] per list (brief 3, §14.1); a missing field reads null", () => {
    const wfigsDown = [
      { id: 'calfire' as const, name: 'CAL FIRE', status: 'available' as const, retrieved_ms: 5, reason: null },
      { id: 'wfigs' as const, name: 'NIFC WFIGS (IRWIN)', status: 'unavailable' as const, retrieved_ms: null, reason: 'NIFC did not answer' },
    ]
    let c = catalogApply(EMPTY_CATALOG, 'live', { incidents: [], updated_ms: 1, sources: wfigsDown })
    expect(c.sources.live).toEqual(wfigsDown)
    expect(c.sources.season).toBeNull()
    c = catalogApply(c, 'season', { incidents: [], updated_ms: 1 })
    expect(c.sources.season).toBeNull()
    expect(c.sources.live).toEqual(wfigsDown)
  })

  it('keeps the last rows on failure and joins the errors', () => {
    let c = catalogApply(EMPTY_CATALOG, 'historical', { incidents: [row('2025-a', 2025)], updated_ms: 1 })
    c = catalogPending(c, ['historical', 'live'], 100)
    expect(c.minAcres).toBe(100)
    c = catalogFail(c, 'historical', 'Server error (HTTP 502)')
    c = catalogFail(c, 'live', 'Server error (HTTP 502)')
    expect(c.historical).toHaveLength(1)
    expect(c.error).toBe('Server error (HTTP 502)')
    expect(c.listErrors.live).toBe('Server error (HTTP 502)')
    c = catalogApply(c, 'live', { incidents: [], updated_ms: 2 })
    expect(c.listErrors.live).toBeNull()
    expect(c.error).toBe('Server error (HTTP 502)')
  })

  it('patches a fresh summary into every list, keeping list-only fields', () => {
    let c = catalogApply(EMPTY_CATALOG, 'live', { incidents: [row('2026-a', 2026, { mode: 'live', bbox_lonlat: [1, 2, 3, 4] })], updated_ms: 1 })
    c = catalogApply(c, 'season', { incidents: [row('2026-a', 2026, { bbox_lonlat: [1, 2, 3, 4] })], updated_ms: 1 })
    c = catalogPatch(c, row('2026-a', 2026, { mode: 'live', bundle_status: 'ready', acres: 50 }))
    expect(c.live[0]).toMatchObject({ bundle_status: 'ready', acres: 50, bbox_lonlat: [1, 2, 3, 4] })
    expect(c.season[0].bundle_status).toBe('ready')
    expect(catalogPatch(c, row('other', 2026)).live).toBe(c.live)
  })
})
