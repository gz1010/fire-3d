import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncidentManifest, IncidentSummary } from '../api/types'
import { EMPTY_CATALOG } from './catalog'
import { playStartsOver } from './runtime'
import { cachedIncidentIds, clearIncidentCache, FOCUS_DEBOUNCE_MS, latestObservationMs, useStore } from './store'
import { useWorkspace } from './workspace'

const summary = (id: string, over: Partial<IncidentSummary> = {}): IncidentSummary =>
  ({ id, name: id, mode: 'live', year: 2026, bundle_status: 'none', acres: 10, lat: 34, lon: -118, started_ms: 0, updated_ms: null, is_active: true, ...over }) as IncidentSummary

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let calls: { url: string; method: string }[] = []
let handler: (url: string, method: string) => Promise<Response> | Response

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    return handler(url, method)
  })
  useStore.setState({ incidentId: null, summary: null, manifest: null, job: null, missingIncidentId: null, incidentError: null, catalog: EMPTY_CATALOG })
})

afterEach(() => {
  useStore.getState().closeIncident()
  vi.unstubAllGlobals()
})

describe('selectIncident / closeIncident (brief 2 overview)', () => {
  it('falls back to the overview with a notice when the id is unknown (404)', async () => {
    handler = () => json({ detail: 'Unknown incident' }, 404)
    await useStore.getState().selectIncident('2026-nope-000000')
    const s = useStore.getState()
    expect(s.incidentId).toBeNull()
    expect(s.missingIncidentId).toBe('2026-nope-000000')
    expect(s.incidentError).toBeNull()
    expect(s.incidentLoading).toBe(false)
  })

  it('never builds unless asked explicitly', async () => {
    handler = (url, method) => (method === 'POST' ? json({ id: 'j1', kind: 'build', incident_id: 'a', status: 'queued', progress: 0, step: 'queued', message: '', created_ms: 0, started_ms: null, finished_ms: null, error: null, result: null }) : json({ summary: summary('a'), manifest: null, job: null }))
    await useStore.getState().selectIncident('a')
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    useStore.getState().closeIncident()
    await useStore.getState().selectIncident('a', { autoBuild: true })
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/incidents/a/build?force=false']))
    expect(useStore.getState().missingIncidentId).toBeNull()
  })

  it('closeIncident clears the fire and drops a late answer for it', async () => {
    let release: () => void = () => undefined
    handler = () => new Promise<Response>((resolve) => (release = () => resolve(json({ summary: summary('slow'), manifest: null, job: null }))))
    const p = useStore.getState().selectIncident('slow')
    expect(useStore.getState().incidentId).toBe('slow')
    useStore.getState().closeIncident()
    release()
    await p
    const s = useStore.getState()
    expect(s.incidentId).toBeNull()
    expect(s.summary).toBeNull()
    expect(s.incidentLoading).toBe(false)
  })
})

describe('loadCatalog (brief 2 lists)', () => {
  it('asks for the 2026 season and the 2025 list explicitly and applies each list', async () => {
    handler = (url) => {
      if (url.includes('mode=live')) return json({ mode: 'live', updated_ms: 1, incidents: [summary('2026-a')] })
      if (url.includes('year=2026')) return json({ mode: 'historical', updated_ms: 2, incidents: [summary('2026-a', { mode: 'historical' }), summary('2026-b', { mode: 'historical', is_active: false })] })
      return json({ mode: 'historical', updated_ms: 3, incidents: [summary('2025-c', { mode: 'historical', year: 2025 })] })
    }
    await useStore.getState().loadCatalog()
    const urls = calls.map((c) => c.url).sort()
    expect(urls).toEqual(['/api/incidents?mode=historical&min_acres=300&year=2025', '/api/incidents?mode=historical&min_acres=300&year=2026', '/api/incidents?mode=live'])
    const c = useStore.getState().catalog
    expect([c.live.length, c.season.length, c.historical.length]).toEqual([1, 2, 1])
    expect(c.updatedMs).toEqual({ live: 1, season: 2, historical: 3 })
    expect(c.loading).toBe(false)
  })

  it('reloads one list on request and records its error without emptying the others', async () => {
    handler = () => json({ mode: 'live', updated_ms: 1, incidents: [summary('2026-a')] })
    await useStore.getState().loadCatalog({ lists: ['live'] })
    handler = () => json({ detail: 'down' }, 502)
    await useStore.getState().loadCatalog({ modes: ['live'] })
    const c = useStore.getState().catalog
    expect(c.live).toHaveLength(1)
    expect(c.listErrors.live).toMatch(/502/)
    expect(calls.every((x) => x.url === '/api/incidents?mode=live')).toBe(true)
  })
})

const H = 3_600_000
const manifest = (id: string, mode: 'live' | 'historical' = 'historical', built = 1): IncidentManifest =>
  ({
    id,
    name: id,
    mode,
    status: 'ready',
    built_ms: built,
    time_range: { start_ms: 0, end_ms: 100 * H, now_ms: mode === 'live' ? 90 * H : 100 * H },
    forecasts: [],
    default_profile_path: [],
    layers: {},
    grid: { bbox_lonlat: [-118.2, 34.1, -118.0, 34.3] },
    data_sources: [],
    warnings: [],
  }) as unknown as IncidentManifest

/** A fake API: two prepared fires (a, b) and one without an analysis (u). */
function api(url: string, method: string): Response {
  if (method === 'POST') return json({ detail: 'no builds in this test' }, 500)
  const m = /\/api\/incidents\/([^/?]+)$/.exec(url)
  if (m) {
    const id = decodeURIComponent(m[1])
    if (id === 'u') return json({ summary: summary('u', { bundle_status: 'none' }), manifest: null, job: null })
    return json({ summary: summary(id, { mode: 'historical', bundle_status: 'ready' }), manifest: manifest(id), job: null })
  }
  if (url.includes('/api/bundles/')) return json({})
  return json({ detail: 'unexpected' }, 404)
}

describe('focusIncidentFromMap (decision 10) vs explicit opens', () => {
  beforeEach(() => {
    clearIncidentCache()
    handler = api
    useStore.setState({
      catalog: { ...EMPTY_CATALOG, season: [summary('a', { bundle_status: 'ready' }), summary('b', { bundle_status: 'ready' }), summary('u', { bundle_status: 'none' })] },
      incidentSource: null,
    })
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const settle = async () => {
    await vi.advanceTimersByTimeAsync(FOCUS_DEBOUNCE_MS + 10)
    await vi.waitFor(() => expect(useStore.getState().incidentLoading).toBe(false))
  }

  it('focuses a prepared fire after the debounce, on its latest observation, without a build', async () => {
    useStore.getState().focusIncidentFromMap('a')
    expect(useStore.getState().incidentId).toBeNull() // debounced: nothing shown yet
    await settle()
    const s = useStore.getState()
    expect([s.incidentId, s.incidentSource]).toEqual(['a', 'zoom'])
    expect(s.timeMs).toBe(100 * H) // historical: the end of the observed record
    expect(s.focusTimeMs).toBe(100 * H)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('ignores fires without an analysis and quick zooms in and out', async () => {
    useStore.getState().focusIncidentFromMap('u')
    await settle()
    expect(useStore.getState().incidentId).toBeNull()
    useStore.getState().focusIncidentFromMap('a')
    await vi.advanceTimersByTimeAsync(FOCUS_DEBOUNCE_MS / 2)
    useStore.getState().focusIncidentFromMap(null) // zoomed back out before the focus applied
    await settle()
    expect(useStore.getState().incidentId).toBeNull()
    expect(calls.filter((c) => c.url.includes('/api/incidents/'))).toHaveLength(0)
  })

  it('returns to the overview on zoom-out, keeps the selection, and re-focuses from the cache without refetching files', async () => {
    useWorkspace.getState().selectLocation({ lat: 34.2, lon: -118.1, source: 'event', eventId: 'e1' })
    useStore.getState().focusIncidentFromMap('a')
    await settle()
    useStore.getState().focusIncidentFromMap(null)
    await settle()
    let s = useStore.getState()
    expect([s.incidentId, s.incidentSource, s.manifest]).toEqual([null, 'zoom', null])
    expect(cachedIncidentIds()).toEqual(['a'])
    expect(useWorkspace.getState().selection?.eventId).toBe('e1') // zoom transitions keep every selection
    calls = []
    useStore.getState().focusIncidentFromMap('a')
    await vi.advanceTimersByTimeAsync(FOCUS_DEBOUNCE_MS + 10)
    s = useStore.getState()
    expect(s.manifest?.id).toBe('a') // shown at once, from the cache
    await settle()
    expect(calls.filter((c) => c.url.includes('/api/bundles/'))).toHaveLength(0) // same build: no file refetch
    expect(calls.filter((c) => /\/api\/incidents\/a$/.test(c.url))).toHaveLength(1) // revalidated once
  })

  it('explicit opens use their own time rule and source, and cancel a pending focus', async () => {
    useStore.getState().focusIncidentFromMap('b')
    await useStore.getState().selectIncident('a', { source: 'card' })
    await settle()
    const s = useStore.getState()
    expect([s.incidentId, s.incidentSource]).toEqual(['a', 'card'])
    expect(s.timeMs).toBe(40 * H) // historical default: start + 40 %
    expect(s.focusTimeMs).toBeNull()
    useStore.getState().closeIncident()
    expect(useStore.getState().incidentSource).toBeNull()
  })

  it('keeps at most four fires cached, least recently used out first', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    useStore.setState({ catalog: { ...EMPTY_CATALOG, season: ids.map((id) => summary(id, { bundle_status: 'ready' })) } })
    for (const id of ids) {
      useStore.getState().focusIncidentFromMap(id)
      await settle()
    }
    useStore.getState().focusIncidentFromMap(null)
    await settle()
    expect(cachedIncidentIds()).toEqual(['b', 'c', 'd', 'e'])
  })
})

describe('latest observation and Play after a zoom focus', () => {
  it('uses the newest data: live now_ms, historical the end of the record', () => {
    expect(latestObservationMs(manifest('x', 'live'))).toBe(90 * H)
    expect(latestObservationMs(manifest('x'))).toBe(100 * H)
  })

  it('starts Play from the window start while the time is still the focus time', () => {
    const w = { startMs: 0, endMs: 172 * H }
    expect(playStartsOver(100 * H, w, 100 * H)).toBe(true)
    expect(playStartsOver(100 * H, w, null)).toBe(false)
    expect(playStartsOver(50 * H, w, 100 * H)).toBe(false) // the user moved the time
    expect(playStartsOver(172 * H, w, null)).toBe(true)
  })
})
