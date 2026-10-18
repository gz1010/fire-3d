import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import type { IncidentSummary } from '../api/types'
import { addressRange } from './addressStore'
import { plainSearchError } from './geocodeClient'
import { incidentPool, nearestFires, rowBbox } from './incidents'
import {
  INITIAL_SEARCH,
  areaBounds,
  areaLabel,
  areaSub,
  cancelledLookup,
  decide,
  incidentAction,
  likelyMissingWestSign,
  looksLikeAddress,
  looksLikeZip,
  planSearch,
  readiness,
  searchIncidents,
  searchReducer,
  type Popover,
  type SearchPlan,
  type SearchState,
} from './search'
import { cardYield } from './searchUi'
import type { GeocodeMatch, GeocodeResponse } from './types'

const inc = (id: string, name: string, over: Partial<IncidentSummary> = {}): IncidentSummary =>
  ({ id, name, year: 2025, county: 'Los Angeles', location: null, admin_unit: null, acres: 1000, is_active: false, bundle_status: 'ready', lat: 34.2, lon: -118.1, ...over }) as IncidentSummary

const POOL = [
  inc('2025-eaton-fire-dbfa57', 'Eaton Fire', { acres: 14021, location: 'Altadena', lat: 34.2052, lon: -118.0838 }),
  inc('2025-palisades-fire-abfed7', 'Palisades Fire', { acres: 23448, lat: 34.0726, lon: -118.5427 }),
  inc('2025-madre-fire-01e7e8', 'Madre Fire', { acres: 80779, county: 'San Luis Obispo' }),
  inc('2026-cooley-fire-0c342f', 'Cooley Fire', { year: 2026, acres: 300, is_active: true, county: 'Monterey' }),
  inc('2024-easton-fire-111111', 'Easton Fire', { year: 2024, acres: 120 }),
  inc('2025-lidia-fire-83adc9', 'Lidia Fire', { acres: 350, location: 'Agua Dulce' }),
  inc('2025-bryson-fire-000001', 'Bryson Fire', { acres: 600, location: 'Malibu', bundle_status: 'none' }),
  inc('2025-paradise-fire-000002', 'Paradise Fire', { acres: 400, bundle_status: 'none' }),
  inc('2024-twin-fire-000003', 'Twin Fire', { year: 2024 }),
  inc('2025-twin-fire-000004', 'Twin Fire', { year: 2025 }),
]

const res = (matches: Partial<GeocodeMatch>[], over: Partial<GeocodeResponse> = {}): GeocodeResponse => ({
  query: 'q',
  matches: matches.map((m) => ({ matched_address: m.name ?? 'X', lat: 34.19, lon: -118.13, tiger_line_id: null, side: null, ...m })),
  benchmark: null,
  source: 'U.S. Census Bureau Gazetteer Files',
  attribution: '',
  cached: false,
  fetched_ms: 0,
  ...over,
})
const lookupPlan = (text: string): Extract<SearchPlan, { kind: 'lookup' }> => {
  const p = planSearch(text, POOL)
  if (p.kind !== 'lookup') throw new Error(`expected a lookup for ${text}, got ${p.kind}`)
  return p
}

describe('looksLikeAddress / looksLikeZip', () => {
  it.each(['600 E Mariposa St, Altadena, CA 91001', '1 Rose Bowl Dr, Pasadena', '100-12 Main St', 'N1234 County Rd K, WI', '1600 Pennsylvania Ave NW, Washington, DC', '42B Baker St'])('address: %s', (t) => {
    expect(looksLikeAddress(t)).toBe(true)
  })
  it.each(['Eaton', 'Eaton Fire 2025', 'Altadena, CA', '91001', '91001 CA', '34.2, -118.1', 'Main St 100', ''])('not an address: %s', (t) => {
    expect(looksLikeAddress(t)).toBe(false)
  })
  it.each(['91001', '91001-1234', 'CA 91001', '91001, California', ' 91001 '])('ZIP: %s', (t) => expect(looksLikeZip(t)).toBe(true))
  it.each(['9100', '910011', 'Altadena 91001', '600 Main St'])('not a ZIP: %s', (t) => expect(looksLikeZip(t)).toBe(false))
})

describe('searchIncidents (local catalog only)', () => {
  it('matches word prefixes across name, county, place, id and year, best first', () => {
    expect(searchIncidents('eaton', POOL).map((h) => h.summary.id)).toEqual(['2025-eaton-fire-dbfa57'])
    expect(searchIncidents('eat', POOL).map((h) => h.summary.name)).toEqual(['Eaton Fire'])
    expect(searchIncidents('eas', POOL).map((h) => h.summary.name)).toEqual(['Easton Fire'])
    expect(searchIncidents('altadena', POOL).map((h) => h.summary.name)).toEqual(['Eaton Fire'])
    expect(searchIncidents('monterey', POOL).map((h) => h.summary.name)).toEqual(['Cooley Fire'])
    expect(searchIncidents('fire 2026', POOL).map((h) => h.summary.name)).toEqual(['Cooley Fire'])
    expect(searchIncidents('agua dulce', POOL).map((h) => h.summary.name)).toEqual(['Lidia Fire'])
    expect(searchIncidents('MÁDRE', POOL).map((h) => h.summary.name)).toEqual(['Madre Fire']) // accents / case folded
  })
  it('marks exact names (also with the year or the id) and bare names without "Fire"', () => {
    const [full] = searchIncidents('Eaton Fire', POOL)
    expect(full).toMatchObject({ exact: true, bare: false, score: 100 })
    expect(searchIncidents('eaton fire 2025', POOL)[0]).toMatchObject({ exact: true })
    expect(searchIncidents('2025-eaton-fire-dbfa57', POOL)[0]).toMatchObject({ exact: true })
    expect(searchIncidents('Eaton', POOL)[0]).toMatchObject({ exact: false, bare: true, score: 90 })
    expect(searchIncidents('altadena', POOL)[0]).toMatchObject({ exact: false, bare: false })
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
  it('opens a fire only on its exact name; the same name in two years is listed', () => {
    expect(planSearch('Eaton Fire', POOL)).toMatchObject({ kind: 'incident', hit: { summary: { id: '2025-eaton-fire-dbfa57' } } })
    expect(planSearch('Twin Fire', POOL)).toMatchObject({ kind: 'lookup', expect: 'local', candidate: null })
    expect(planSearch('twin fire 2024', POOL)).toMatchObject({ kind: 'incident', hit: { summary: { id: '2024-twin-fire-000003' } } })
  })
  it('sends town names to the local lookup; a bare fire name is only a candidate', () => {
    expect(lookupPlan('Eaton')).toMatchObject({ expect: 'local', candidate: { summary: { id: '2025-eaton-fire-dbfa57' } } })
    // "Malibu" matched the Bryson Fire's location text and used to switch fires and start a build: now it is a town
    const malibu = lookupPlan('Malibu')
    expect(malibu).toMatchObject({ expect: 'local', candidate: null })
    expect(malibu.incidents.map((h) => h.summary.name)).toEqual(['Bryson Fire'])
    expect(lookupPlan('Altadena')).toMatchObject({ expect: 'local', candidate: null })
    expect(lookupPlan('91001')).toMatchObject({ expect: 'local' })
    expect(lookupPlan('Pasadena City Hall')).toMatchObject({ expect: 'local', incidents: [] })
  })
  it('sends house-number addresses to the Census lookup', () => {
    expect(lookupPlan('600 E Mariposa St, Altadena, CA 91001')).toMatchObject({ expect: 'address', query: '600 E Mariposa St, Altadena, CA 91001' })
    expect(lookupPlan('600   E Mariposa St')).toMatchObject({ query: '600 E Mariposa St' })
  })
  it('explains input it cannot search, and ignores blanks', () => {
    expect(planSearch('9100', POOL)).toMatchObject({ kind: 'invalid' })
    expect(planSearch('#!?', POOL)).toMatchObject({ kind: 'invalid' })
    expect(planSearch('   ', POOL)).toEqual({ kind: 'empty' })
  })
})

describe('incidents: readiness and actions (never a build without asking)', () => {
  it('maps bundle status to plain readiness', () => {
    expect(['ready', 'building', 'none', 'error'].map((b) => readiness({ bundle_status: b as IncidentSummary['bundle_status'] }))).toEqual(['ready', 'building', 'not-prepared', 'failed'])
  })
  it('opens built or building fires, asks before preparing the others, and shows the current one', () => {
    expect(incidentAction(POOL[0], '2025-eaton-fire-dbfa57')).toBe('show-current')
    expect(incidentAction(POOL[1], '2025-eaton-fire-dbfa57')).toBe('open')
    expect(incidentAction({ id: 'x', bundle_status: 'building' }, null)).toBe('open')
    expect(incidentAction(POOL[6], null)).toBe('ask-prepare')
    expect(incidentAction({ id: 'y', bundle_status: 'error' }, null)).toBe('ask-prepare')
  })
})

describe('decide (after the lookup)', () => {
  it('selects a single street address and lists several', () => {
    const p = lookupPlan('600 E Mariposa St, Altadena')
    expect(decide(p, res([{ kind: 'address', name: '600 E MARIPOSA ST' }])).kind).toBe('address')
    const many = decide(p, res([{ kind: 'address', name: 'A' }, { kind: 'address', name: 'B' }], { total_matches: 50 }))
    expect(many).toMatchObject({ kind: 'list', message: '2 addresses match (the first 2 of 50): choose one.' })
    expect(decide(p, res([]))).toMatchObject({ kind: 'none' })
  })
  it('goes to a single town or an exact town name, keeping the other matches listed', () => {
    const one = decide(lookupPlan('La Canada'), res([{ kind: 'place', name: 'La Cañada Flintridge', exact: false }]))
    expect(one).toMatchObject({ kind: 'area', match: { name: 'La Cañada Flintridge' } })
    const la = decide(lookupPlan('Los Angeles'), res([{ kind: 'place', name: 'Los Angeles', exact: true }, { kind: 'place', name: 'East Los Angeles', exact: false }]))
    expect(la).toMatchObject({ kind: 'area', match: { name: 'Los Angeles' } })
    if (la.kind === 'area') expect(la.others.places.map((m) => m.name)).toEqual(['East Los Angeles'])
    // "Malibu": the town, and the Bryson Fire (whose location says Malibu) stays listed, never opened or built
    const malibu = decide(lookupPlan('Malibu'), res([{ kind: 'place', name: 'Malibu', exact: true }]))
    expect(malibu).toMatchObject({ kind: 'area', others: { incidents: [{ summary: { name: 'Bryson Fire' } }] } })
  })
  it('opens a bare fire name only when no town has that name', () => {
    expect(decide(lookupPlan('Eaton'), res([]))).toMatchObject({ kind: 'incident', hit: { summary: { name: 'Eaton Fire' } } })
    const both = decide(lookupPlan('Paradise'), res([{ kind: 'place', name: 'Paradise', exact: true }, { kind: 'place', name: 'Paradise', exact: true }]))
    expect(both).toMatchObject({ kind: 'list' })
    if (both.kind === 'list') expect(both.lists.incidents.map((h) => h.summary.name)).toEqual(['Paradise Fire'])
  })
  it('lists several towns, and says why nothing matched', () => {
    const two = decide(lookupPlan('Alta'), res([{ kind: 'place', name: 'Alta Sierra', exact: false }, { kind: 'place', name: 'Altadena', exact: false }]))
    expect(two).toMatchObject({ kind: 'list', message: null })
    const none = decide(lookupPlan('Pasadena City Hall'), res([], { note: 'No California city, town or census-designated place matches.' }))
    expect(none).toEqual({ kind: 'none', message: 'No California city, town or census-designated place matches.' })
  })
})

describe('area labels and view', () => {
  const town: GeocodeMatch = { kind: 'place', matched_address: 'Paradise, CA', name: 'Paradise', place_type: 'town', place_type_label: 'town', near: 'Chico', lat: 39.75, lon: -121.6, land_km2: 47, tiger_line_id: null, side: null }
  const zip: GeocodeMatch = { kind: 'zip', matched_address: 'ZIP 91001, CA', name: '91001', zip: '91001', near: 'Altadena', lat: 34.19, lon: -118.14, land_km2: 21, tiger_line_id: null, side: null }
  it('labels towns and ZIP areas as approximate', () => {
    expect(areaLabel(town)).toBe('Paradise (town center, approximate)')
    expect(areaLabel(zip)).toBe('ZIP 91001 near Altadena (ZIP area, approximate)')
    expect(areaSub(town)).toBe('town · near Chico · town center, approximate')
    expect(areaSub(zip)).toBe('ZIP area near Altadena · approximate')
  })
  it('frames about the area, between 3 and 50 km across', () => {
    const [w, s, e, n] = areaBounds(town)
    expect(n - s).toBeGreaterThan(0.08)
    expect(e - w).toBeGreaterThan(n - s) // degrees of longitude are shorter
    const tiny = areaBounds({ lat: 34, lon: -118, land_km2: 0.01 })
    expect((tiny[3] - tiny[1]) * 111.2).toBeCloseTo(3, 1)
    const huge = areaBounds({ lat: 34, lon: -118, land_km2: 5000 })
    expect((huge[3] - huge[1]) * 111.2).toBeCloseTo(50, 1)
  })
})

describe('search state machine: cancellation and late replies', () => {
  const results: Popover = { kind: 'message', tone: 'info', text: 'done', lists: null, fix: null }
  const start = (s: SearchState = INITIAL_SEARCH) => searchReducer(s, { type: 'lookup', text: 'Looking up…' })
  it('numbers lookups and accepts only the latest reply', () => {
    const a = start()
    expect(a).toMatchObject({ seq: 1, pending: 1, popover: { kind: 'busy' } })
    const b = start(a) // a new submit supersedes the first
    expect(b).toMatchObject({ seq: 2, pending: 2 })
    expect(cancelledLookup(a, b)).toBe(1)
    expect(searchReducer(b, { type: 'reply', seq: 1, popover: results })).toBe(b) // late reply dropped
    expect(searchReducer(b, { type: 'reply', seq: 2, popover: results })).toMatchObject({ pending: null, popover: { text: 'done' } })
  })
  it.each([
    ['Escape / Clear / outside click / map click / new selection', { type: 'close' } as const],
    ['an edit', { type: 'edit', empty: false, focused: true } as const],
  ])('%s cancels the lookup and drops its reply', (_, ev) => {
    const a = start()
    const b = searchReducer(a, ev)
    expect(b.pending).toBeNull()
    expect(b.popover.kind).toBe('closed')
    expect(cancelledLookup(a, b)).toBe(1)
    expect(searchReducer(b, { type: 'reply', seq: 1, popover: results })).toBe(b)
  })
  it('shows the hint only in an empty, idle box and closes it on blur', () => {
    const h = searchReducer(INITIAL_SEARCH, { type: 'focus', empty: true })
    expect(h.popover.kind).toBe('hint')
    expect(searchReducer(INITIAL_SEARCH, { type: 'focus', empty: false })).toBe(INITIAL_SEARCH)
    expect(searchReducer(h, { type: 'blur' }).popover.kind).toBe('closed')
    expect(searchReducer(start(), { type: 'blur' }).popover.kind).toBe('busy') // a lookup outlives the blur
    expect(searchReducer(h, { type: 'edit', empty: true, focused: true }).popover.kind).toBe('hint')
  })
  it('close is a no-op when nothing is open', () => {
    expect(searchReducer(INITIAL_SEARCH, { type: 'close' })).toBe(INITIAL_SEARCH)
    expect(cancelledLookup(INITIAL_SEARCH, INITIAL_SEARCH)).toBeNull()
  })
})

describe('cardYield: the popover never covers the card', () => {
  it('pushes the desktop card down by the overlap', () => {
    expect(cardYield({ top: 100, bottom: 300 }, { top: 160, bottom: 800 }, 400, false)).toEqual({ marginTop: 148 })
    expect(cardYield({ top: 100, bottom: 140 }, { top: 160, bottom: 800 }, 400, false)).toBeNull()
    expect(cardYield(null, { top: 160, bottom: 800 }, 400, false)).toBeNull()
  })
  it('shortens a phone sheet so it ends below the popover, or hides it when too little room is left', () => {
    expect(cardYield({ top: 110, bottom: 400 }, { top: 300, bottom: 780 }, 480, true)).toEqual({ maxHeight: 372 })
    expect(cardYield({ top: 110, bottom: 200 }, { top: 500, bottom: 780 }, 280, true)).toBeNull()
    expect(cardYield({ top: 110, bottom: 720 }, { top: 300, bottom: 780 }, 480, true)).toEqual({ hidden: true })
  })
})

describe('plainSearchError', () => {
  const api = (status: number, body = '') => new ApiError(status, '/api/geocode', body)
  it('never shows status codes or server jargon', () => {
    for (const s of [429, 500, 502, 503, 504, 404]) expect(plainSearchError(api(s))).not.toMatch(/HTTP|\d{3}|server error/i)
    expect(plainSearchError(api(504))).toMatch(/did not answer in time/)
    expect(plainSearchError(api(400, '{"detail":"This looks like coordinates."}'))).toBe('This looks like coordinates.')
    expect(plainSearchError(api(503, '{"detail":"Town and ZIP search is not available on this server (HTTP 503)."}'))).toBe('Town and ZIP search is not available on this server.')
    expect(plainSearchError(new TypeError('Failed to fetch'))).toMatch(/Cannot reach the Fire-3d server/)
    expect(plainSearchError(new DOMException('timeout', 'TimeoutError'))).toMatch(/took too long/)
  })
})

describe('incident pool and nearest fires (overview search)', () => {
  it('collects every catalog list once, the open incident first', () => {
    const pool = incidentPool({ summary: POOL[1], catalog: { live: [POOL[3]], historical: [POOL[0], POOL[1]], season: [POOL[2]], loading: false, error: null, updatedMs: { live: 1 } } })
    expect(pool.map((s) => s.name)).toEqual(['Palisades Fire', 'Cooley Fire', 'Eaton Fire', 'Madre Fire'])
  })
  it('measures from CAL FIRE reported points and puts a containing built area first', () => {
    const here = { lat: 34.1896, lon: -118.1374 } // 600 E Mariposa St, Altadena
    const near = nearestFires(POOL.slice(0, 2), here.lat, here.lon)
    expect(near.map((f) => f.summary.name)).toEqual(['Eaton Fire', 'Palisades Fire'])
    expect(near[0].distanceM).toBeGreaterThan(4000)
    expect(near[0].distanceM).toBeLessThan(6000)
    expect(near[0].insideArea).toBe(false) // no bbox in the row
    const withArea = { ...POOL[1], bbox_lonlat: [-118.2, 34.1, -118.0, 34.3] } as IncidentSummary
    const r = nearestFires([POOL[0], withArea], here.lat, here.lon)
    expect(r[0]).toMatchObject({ insideArea: true, summary: { name: 'Palisades Fire' } })
    expect(rowBbox({ ...POOL[0], bbox_lonlat: [1, 2, 0, 3] } as IncidentSummary)).toBeNull()
    // an unbuilt fire's box never offers "Open the analysis"
    expect(nearestFires([{ ...withArea, bundle_status: 'none' }], here.lat, here.lon)[0].insideArea).toBe(false)
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

describe('prettyAddress (Census capitals for display)', () => {
  it('title-cases words, keeps directions, state, numbers and ordinals readable', async () => {
    const { prettyAddress } = await import('./addressStore')
    expect(prettyAddress('600 E MARIPOSA ST, ALTADENA, CA, 91001')).toBe('600 E Mariposa St, Altadena, CA 91001')
    expect(prettyAddress('100 W 1ST ST, LOS ANGELES, CA, 90012')).toBe('100 W 1st St, Los Angeles, CA 90012')
    expect(prettyAddress("12 O'NEILL-SMITH RD NW, LA CANADA FLINTRIDGE, CA, 91011-1234")).toBe("12 O'Neill-Smith Rd NW, La Canada Flintridge, CA 91011-1234")
    expect(prettyAddress('N1234 COUNTY RD K, WI, 53000')).toBe('N1234 County Rd K, WI 53000')
    expect(prettyAddress('600 E Mariposa St, Altadena')).toBe('600 E Mariposa St, Altadena') // not all capitals: unchanged
  })
})

describe('overviewNearby', () => {
  it('lists the nearest fires, adds the nearest active one, and the built area containing the point', async () => {
    const { overviewNearby } = await import('./incidents')
    const here = { lat: 34.1896, lon: -118.1374 }
    const pool = [
      inc('a', 'Eaton Fire', { lat: 34.2052, lon: -118.0838, bbox_lonlat: [-118.2145, 34.0952, -117.9623, 34.3048] } as Partial<IncidentSummary>),
      inc('b', 'Near One Fire', { lat: 34.25, lon: -118.15 }),
      inc('c', 'Near Two Fire', { lat: 34.3, lon: -118.2 }),
      inc('d', 'Far Active Fire', { lat: 36.5, lon: -121.5, is_active: true }),
    ]
    const n = overviewNearby(pool, here.lat, here.lon, (s) => s.is_active)
    expect(n.fires.map((f) => f.summary.name)).toEqual(['Eaton Fire', 'Near One Fire', 'Near Two Fire'])
    expect(n.inside?.summary.name).toBe('Eaton Fire')
    expect(n.active?.summary.name).toBe('Far Active Fire')
    expect(overviewNearby(pool.slice(0, 3), here.lat, here.lon, (s) => s.is_active).active).toBeNull()
    expect(overviewNearby([], here.lat, here.lon, () => true)).toEqual({ fires: [], active: null, inside: null })
  })
})
