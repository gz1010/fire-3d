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
  uid: id,
  record_source: 'calfire',
  record_issuer: 'CAL FIRE',
  state: 'CA',
  time_zone: 'America/Los_Angeles',
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

// ------------------------------------------------------------------------------------------------- brief 3 (§14.11, §14.14)
import {
  CALFIRE_LIST_DOWN,
  countyWords,
  EMPTY_VIEW,
  emptyListText,
  firesInView,
  fireWhere,
  inBox,
  inViewLabel,
  LIST_ABSENCE,
  LIST_ABSENCE_SHORT,
  listSourceNotices,
  NIFC_LIST_DOWN,
  overviewCounts,
  pickerMatches,
  pickerWhere,
} from './overview'

describe('state on rows, cards, hovers and the picker', () => {
  it('"Garfield Co., CO": the same county name in two states reads apart', () => {
    expect(fireWhere({ county: 'Garfield', location: null, admin_unit: null, state: 'CO' })).toBe('Garfield Co., CO')
    expect(fireWhere({ county: 'Garfield', location: null, admin_unit: null, state: 'MT' })).toBe('Garfield Co., MT')
    expect(fireWhere({ county: 'Los Angeles', location: 'Altadena', admin_unit: null, state: 'CA' })).toBe('Los Angeles Co., CA')
  })
  it('Louisiana parishes, names that already say what they are, no county, no state', () => {
    expect(countyWords('Calcasieu', 'LA')).toBe('Calcasieu Parish')
    expect(countyWords('Calcasieu Parish', 'LA')).toBe('Calcasieu Parish')
    expect(countyWords('Carson City', 'NV')).toBe('Carson City')
    expect(fireWhere({ county: null, location: 'Big Sur', admin_unit: null, state: 'CA' })).toBe('Big Sur, CA')
    expect(fireWhere({ county: null, location: null, admin_unit: 'IDBOD', state: 'ID' })).toBe('IDBOD, ID')
    expect(fireWhere({ county: null, location: null, admin_unit: null, state: 'TX' })).toBe('TX')
    expect(fireWhere({ county: 'Mendocino', location: null, admin_unit: null })).toBe('Mendocino Co.')
    expect(fireWhere({ county: null, location: 'Near Bend, OR', admin_unit: null, state: 'OR' })).toBe('Near Bend, OR')
    expect(fireWhere({ county: null, location: null, admin_unit: null })).toBe('')
  })
})

describe('the list in this view (§14.11)', () => {
  const rows = [row('a', { lon: -105, lat: 40 }), row('b', { lon: -80, lat: 35 }), row('c', { lon: -122, lat: 47 }), row('bad', { lon: Number.NaN, lat: 1 })]
  it('inBox and firesInView', () => {
    expect(inBox(rows[0], [-110, 35, -100, 45])).toBe(true)
    expect(inBox(rows[1], [-110, 35, -100, 45])).toBe(false)
    expect(inBox(rows[3], [-180, -90, 180, 90])).toBe(false)
    expect(inBox({ lon: 179, lat: 0 }, [170, -10, -170, 10])).toBe(true) // across the antimeridian
    expect(firesInView(rows, [-125, 30, -100, 50]).map((r) => r.id)).toEqual(['a', 'c'])
    expect(firesInView(rows, null).map((r) => r.id)).toEqual(['a', 'b', 'c', 'bad'])
  })
  it('the counts line', () => {
    expect(inViewLabel(312, 1334)).toEqual({ inView: '312 fires in this view', all: 'Show all 1,334' })
    expect(inViewLabel(1, 2).inView).toBe('1 fire in this view')
  })
  it('counts per filter', () => {
    const live = [row('l', { mode: 'live', is_active: true })]
    const season = [row('l'), row('s')]
    expect(overviewCounts({ live, season, historical: [row('h')] })).toEqual({ active: 1, season: 2, past: 1 })
  })
})

describe('never an all-clear (§14.14)', () => {
  it('fixed wording', () => {
    expect(LIST_ABSENCE).toBe('Only fires reported to CAL FIRE or NIFC are listed; a place with no marker is not an all-clear. Follow local officials.')
    expect(LIST_ABSENCE_SHORT).toBe('Only reported fires are listed · not an all-clear')
    expect(EMPTY_VIEW).toBe('No listed fires in this view.')
    expect(NIFC_LIST_DOWN).toBe('The national fire list (NIFC) is unavailable right now; only California fires (CAL FIRE) are listed.')
    expect(CALFIRE_LIST_DOWN).toBe("CAL FIRE's list is unavailable right now; California fires are listed from NIFC WFIGS.")
  })
  it('empty filters never say "no fires" without who lists them', () => {
    for (const f of ['active', 'season', 'past'] as const) {
      const t = emptyListText(f, 300)
      expect(t).toMatch(/list|listed/)
      expect(t).not.toMatch(/\bsafe\b|low risk/i)
    }
  })
  it('source notices from sources[] (deduplicated over the lists)', () => {
    const ok = { id: 'calfire' as const, name: 'CAL FIRE', status: 'available' as const, retrieved_ms: 1, reason: null }
    const nifcDown = { id: 'wfigs' as const, name: 'NIFC WFIGS (IRWIN)', status: 'unavailable' as const, retrieved_ms: null, reason: 'timeout' }
    const calDown = { ...ok, status: 'unavailable' as const }
    expect(listSourceNotices([[ok], null, undefined])).toEqual([])
    expect(listSourceNotices([[ok, nifcDown], [nifcDown]])).toEqual([NIFC_LIST_DOWN])
    expect(listSourceNotices([[calDown], [nifcDown]])).toEqual([NIFC_LIST_DOWN, CALFIRE_LIST_DOWN])
  })
})

describe('picker rows and search (W5)', () => {
  it('place line and state-aware search', () => {
    const r = row('2026-pine-gulch-1', { name: 'Pine Gulch', county: 'Garfield', location: 'Near Rifle', state: 'CO' })
    expect(pickerWhere(r)).toBe('Garfield Co., CO · Near Rifle')
    expect(pickerWhere(row('x', { county: null, location: null, admin_unit: null }))).toBe('—')
    expect(pickerMatches(r, 'colorado')).toBe(true)
    expect(pickerMatches(r, 'co')).toBe(true)
    expect(pickerMatches(r, 'garfield co., co')).toBe(true)
    expect(pickerMatches(r, 'montana')).toBe(false)
    expect(pickerMatches(row('y', { name: 'Big Dry', source_name: 'BIG DRY', state: 'MT' }), 'montana')).toBe(true)
  })
})

describe('list windowing (W11)', () => {
  it('lists of 150 rows or fewer render every row', async () => {
    const { listWindow, LIST_WINDOW_MIN } = await import('./overview')
    expect(LIST_WINDOW_MIN).toBe(150)
    expect(listWindow(150, 2000, 600, 50)).toEqual({ start: 0, end: 150 })
    expect(listWindow(0, 0, 600, 50)).toEqual({ start: 0, end: 0 })
  })
  it('1,334 rows: the visible rows and the overscan only; the ends clamp', async () => {
    const { listWindow, LIST_OVERSCAN } = await import('./overview')
    // top of the list: rows 0-11 visible in 600 px at 50 px each, plus 10
    expect(listWindow(1334, 0, 600, 50)).toEqual({ start: 0, end: 12 + LIST_OVERSCAN })
    // scrolled to row 500
    expect(listWindow(1334, 25_000, 600, 50)).toEqual({ start: 490, end: 522 })
    // the end (End key): never past the last row
    expect(listWindow(1334, 1334 * 50 - 600, 600, 50)).toEqual({ start: 1312, end: 1334 })
    // a zero row height never divides by zero
    expect(listWindow(1334, 100, 600, 0).end).toBeLessThanOrEqual(1334)
  })
  it('scrollToRow: a step scrolls by the overflow; a visible row keeps the position', async () => {
    const { scrollToRow } = await import('./overview')
    expect(scrollToRow(5, 50, 0, 600)).toBe(0)
    expect(scrollToRow(12, 50, 0, 600)).toBe(50)
    expect(scrollToRow(3, 50, 400, 600)).toBe(150)
    expect(scrollToRow(1333, 50, 0, 600)).toBe(1334 * 50 - 600)
    expect(scrollToRow(0, 50, 9000, 600)).toBe(0)
  })
})
