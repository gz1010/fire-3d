// Shared CPU rasters (CONTRACT §10): URLs and cache-busting versions (checked against the Forensic loader
// lib/raster.ts), decoding, the LRU cache with byte accounting, raster sets (never-rejecting loads, 'missing' slots,
// pending sets, stable keys, ignored forecasts), the hook's first render, and nearest-pixel sampling in
// incident-local metres (x east, z south; edges belong to the last row / column; NEVER and nodata).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bundleUrl } from '../api/client'
import { NEVER, type ForecastManifest, type IncidentManifest, type LayerInfo } from '../api/types'
import * as forensic from '../lib/raster'
import {
  clearCpuRasterCache,
  cpuRasterCacheStats,
  forecastRasterUrl,
  HOUR_MS,
  incidentRasterUrl,
  insideAoi,
  loadForecastRaster,
  loadIncidentRaster,
  loadRasterSet,
  NEVER_MIN,
  pendingRasterSet,
  pixelAt,
  pixelCenter,
  rasterSetKey,
  sampleArrival,
  sampleLayer,
  useRasterSet,
  type LoadedLayer,
  type RasterRequest,
  type RasterSet,
} from './rasters'
import rastersSource from './rasters.ts?raw'

// useRasterSet reads the store through a selector; a plain object stands in for it (the hook's first render is
// checked with react-dom/server, where effects do not run)
const store = vi.hoisted(() => ({ state: { manifest: null as unknown, forecast: null as unknown } }))
vi.mock('../state/store', () => ({ useStore: (sel: (s: typeof store.state) => unknown) => sel(store.state) }))

const ORIGIN = Date.UTC(2025, 0, 7, 17, 0)
const BUILT = ORIGIN + 200 * HOUR_MS
const MiB = 1024 * 1024

function info(file: string, n: number, extra: Partial<LayerInfo> = {}): LayerInfo {
  return { file, grid: 'fire', dtype: 'float32', width: n, height: n, description: file, ...extra }
}

/** Minimal ready manifest (only the fields the CPU rasters read are realistic). */
function manifest(over: Partial<IncidentManifest> = {}, n = 4): IncidentManifest {
  return {
    id: 'test-fire',
    status: 'ready',
    time_origin_ms: ORIGIN,
    built_ms: BUILT,
    grid: { extent_m: 1200, fire: { width: n, height: n, res_m: 1200 / n } },
    layers: {
      observed_arrival: info('layers/observed_arrival.bin', n, { units: 'h' }),
      fuel: info('layers/fuel.bin', n, { dtype: 'uint8', nodata: 0 }),
      burn_severity: info('layers/burn_severity.bin', n, { nodata: -9999 }),
      elevation: info('layers/elevation.bin', n * 2, { grid: 'render' }),
      naip: info('layers/naip.jpg', 8, { grid: 'image', dtype: 'jpeg' }),
      trees: { file: 'layers/trees.bin', grid: 'points', dtype: 'float32', count: 3, description: 'trees' },
    },
    forecasts: [],
    ...over,
  } as unknown as IncidentManifest
}

function forecast(m: IncidentManifest, over: Partial<ForecastManifest> = {}): ForecastManifest {
  const n = m.grid.fire.width
  const dir = `forecasts/${over.run_id ?? 'fc-1'}`
  return {
    run_id: 'fc-1',
    incident_id: m.id,
    status: 'ready',
    issued_ms: ORIGIN + 30 * HOUR_MS,
    start_ms: ORIGIN + 24 * HOUR_MS,
    horizon_h: 72,
    time_origin_ms: ORIGIN + 6 * HOUR_MS,
    weather: { source: 'test', ensemble: 'perturbed', members: 31 },
    layers: {
      arrival_p10: info(`${dir}/arrival_p10.bin`, n),
      arrival_p50: info(`${dir}/arrival_p50.bin`, n),
      arrival_p90: info(`${dir}/arrival_p90.bin`, n),
      burn_probability: info(`${dir}/burn_probability.bin`, n),
      flame_length_p50: info(`${dir}/flame_length_p50.bin`, n),
    },
    ...over,
  } as unknown as ForecastManifest
}

/** A loaded layer for the sampling tests (row-major, row 0 = north). */
function layer(width: number, height: number, fill: (r: number, c: number) => number, extra: Partial<LayerInfo> = {}): LoadedLayer {
  const data = new Float32Array(width * height)
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) data[r * width + c] = fill(r, c)
  return { name: 't', url: 'test://t', info: info('t.bin', width, { width, height, ...extra }), data, width, height }
}

// ------------------------------------------------------------------------------------------------- fetch mock
type Answer = { ok: boolean; status: number; buf?: ArrayBuffer; body?: string } | Error
let calls: string[] = []
let answer: (url: string) => Answer | Promise<Answer>

/** Bytes of a typed array (what the API serves for a .bin file). */
const bytes = (a: ArrayBufferView): ArrayBuffer => a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength) as ArrayBuffer

/** Default answers: every file of a 4 x 4 grid as float32 r * 10 + c (uint8 for the fuel, 8 x 8 elevation). */
function defaultAnswer(url: string): Answer {
  const path = url.split('?')[0]
  if (path.endsWith('fuel.bin')) return { ok: true, status: 200, buf: bytes(Uint8Array.from({ length: 16 }, (_, i) => (i === 5 ? 0 : 102))) }
  if (path.endsWith('elevation.bin')) return { ok: true, status: 200, buf: bytes(Float32Array.from({ length: 64 }, (_, i) => 500 + i)) }
  if (path.endsWith('trees.bin')) return { ok: true, status: 200, buf: bytes(new Float32Array(18)) }
  return { ok: true, status: 200, buf: bytes(Float32Array.from({ length: 16 }, (_, i) => Math.floor(i / 4) * 10 + (i % 4))) }
}

beforeEach(() => {
  clearCpuRasterCache()
  forensic.clearRasterCache()
  calls = []
  answer = defaultAnswer
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push(url)
    if (init?.signal?.aborted) throw init.signal.reason
    const a = await answer(url)
    if (a instanceof Error) throw a
    return { ok: a.ok, status: a.status, arrayBuffer: async () => a.buf ?? new ArrayBuffer(0), text: async () => a.body ?? '' }
  })
  store.state = { manifest: null, forecast: null }
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearCpuRasterCache()
})

// ------------------------------------------------------------------------------------------------- module rules
describe('module', () => {
  it('is three.js-free: only types come from lib/raster.ts', () => {
    expect(rastersSource).not.toMatch(/from 'three'/)
    const fromForensic = rastersSource.split('\n').filter((l: string) => l.includes("from '../lib/raster'"))
    expect(fromForensic.length).toBeGreaterThan(0)
    for (const l of fromForensic) expect(l).toMatch(/^(import|export) type /)
  })

  it('has the contract constants (NEVER = 1e6 is at or above NEVER_MIN)', () => {
    expect(NEVER_MIN).toBe(999000)
    expect(HOUR_MS).toBe(3_600_000)
    expect(NEVER).toBeGreaterThanOrEqual(NEVER_MIN)
  })
})

// ------------------------------------------------------------------------------------------------- URLs
describe('URLs (same files and cache-busting versions as lib/raster.ts)', () => {
  const m = manifest()
  const f = forecast(m)

  it('incident layers use ?v=built_ms; absent layers have no URL', () => {
    expect(incidentRasterUrl(m, 'observed_arrival')).toBe(bundleUrl('test-fire', 'layers/observed_arrival.bin', BUILT))
    expect(incidentRasterUrl(m, 'observed_arrival')).toBe(`/api/bundles/test-fire/layers/observed_arrival.bin?v=${BUILT}`)
    expect(incidentRasterUrl(m, 'canopy_cover')).toBeNull()
  })

  it('forecast layers use ?v=built_ms-issued_ms; another incident or an absent layer has no URL', () => {
    expect(forecastRasterUrl(m, f, 'arrival_p50')).toBe(`/api/bundles/test-fire/forecasts/fc-1/arrival_p50.bin?v=${BUILT}-${f.issued_ms}`)
    expect(forecastRasterUrl(m, { ...f, incident_id: 'other-fire' }, 'arrival_p50')).toBeNull()
    const noFlame = { ...f, layers: { ...f.layers, flame_length_p50: undefined } } as unknown as ForecastManifest
    expect(forecastRasterUrl(m, noFlame, 'flame_length_p50')).toBeNull()
  })

  it('downloads the same URL and decodes the same values as the Forensic loader', async () => {
    const pairs: [LoadedLayer, LoadedLayer][] = [
      [await loadIncidentRaster(m, 'observed_arrival'), await forensic.loadLayer(m, 'observed_arrival')],
      [await loadIncidentRaster(m, 'fuel'), await forensic.loadLayer(m, 'fuel')],
      [await loadIncidentRaster(m, 'trees'), await forensic.loadLayer(m, 'trees')],
      [await loadForecastRaster(m, f, 'burn_probability'), await forensic.loadForecastLayer(m, f, 'burn_probability')],
    ]
    for (const [cpu, ref] of pairs) {
      expect(cpu.url).toBe(ref.url)
      expect(cpu.data).toEqual(ref.data)
      expect(cpu.data.constructor).toBe(ref.data.constructor)
      expect([cpu.width, cpu.height, cpu.name]).toEqual([ref.width, ref.height, ref.name])
    }
    expect(pairs[2][0]).toMatchObject({ width: 6, height: 3 }) // points: values per point x count
  })
})

// ------------------------------------------------------------------------------------------------- single loads
describe('loadIncidentRaster / loadForecastRaster', () => {
  const m = manifest()

  it('decodes each dtype as stored (row 0 = north) and keeps the LayerInfo', async () => {
    const obs = await loadIncidentRaster(m, 'observed_arrival')
    expect(obs.data).toBeInstanceOf(Float32Array)
    expect([obs.width, obs.height, obs.data[0], obs.data[7]]).toEqual([4, 4, 0, 13])
    expect(obs.info).toBe(m.layers.observed_arrival)
    const fuel = await loadIncidentRaster(m, 'fuel')
    expect(fuel.data).toBeInstanceOf(Uint8Array)
    const ints: LayerInfo[] = [info('layers/a.bin', 2, { dtype: 'int16' }), info('layers/b.bin', 2, { dtype: 'uint16' })]
    const mi = manifest({ layers: { a: ints[0], b: ints[1] } })
    answer = (url) => ({ ok: true, status: 200, buf: url.includes('/a.bin') ? bytes(Int16Array.of(-3, 2, 1, 0)) : bytes(Uint16Array.of(65535, 2, 1, 0)) })
    expect(Array.from((await loadIncidentRaster(mi, 'a')).data)).toEqual([-3, 2, 1, 0])
    expect((await loadIncidentRaster(mi, 'b')).data).toBeInstanceOf(Uint16Array)
    expect((await loadIncidentRaster(mi, 'b')).data[0]).toBe(65535)
  })

  it('rejects absent layers, other incidents, images and files of the wrong size', async () => {
    await expect(loadIncidentRaster(m, 'canopy_cover')).rejects.toThrow(/not in the manifest/)
    await expect(loadForecastRaster(m, forecast(m, { incident_id: 'other-fire' }), 'arrival_p50')).rejects.toThrow(/belongs to other-fire/)
    await expect(loadIncidentRaster(m, 'naip')).rejects.toThrow(/jpeg is not a raster/)
    answer = () => ({ ok: true, status: 200, buf: new ArrayBuffer(12) })
    await expect(loadIncidentRaster(m, 'burn_severity')).rejects.toThrow(/expected 4x4, got 3 values/)
    answer = () => ({ ok: true, status: 200, buf: new ArrayBuffer(6) })
    await expect(loadIncidentRaster(m, 'observed_arrival')).rejects.toThrow(/whole number of float32/)
    expect(calls.some((u) => u.includes('canopy_cover') || u.includes('other-fire') || u.includes('naip'))).toBe(false)
  })

  it('an aborted caller stops waiting while the shared download completes and stays cached', async () => {
    let release!: () => void
    answer = (url) => new Promise((resolve) => (release = () => resolve(defaultAnswer(url))))
    const ctrl = new AbortController()
    const mine = loadIncidentRaster(m, 'observed_arrival', { signal: ctrl.signal })
    const other = loadIncidentRaster(m, 'observed_arrival')
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    ctrl.abort()
    await expect(mine).rejects.toMatchObject({ name: 'AbortError' })
    release()
    expect((await other).data[5]).toBe(11)
    expect(cpuRasterCacheStats()).toEqual({ entries: 1, bytes: 64 })
    const pre = new AbortController()
    pre.abort()
    await expect(loadIncidentRaster(m, 'observed_arrival', { signal: pre.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

// ------------------------------------------------------------------------------------------------- cache
describe('decoded-layer cache (LRU by URL, 256 MB)', () => {
  const m = manifest()

  it('fetches each URL once (concurrent requests share the download) and counts decoded bytes', async () => {
    const [a, b] = await Promise.all([loadIncidentRaster(m, 'observed_arrival'), loadIncidentRaster(m, 'observed_arrival')])
    expect(a).toBe(b)
    expect(await loadIncidentRaster(m, 'observed_arrival')).toBe(a)
    await loadIncidentRaster(m, 'fuel')
    expect(calls).toHaveLength(2)
    expect(cpuRasterCacheStats()).toEqual({ entries: 2, bytes: 64 + 16 })
    // a rebuilt bundle (new built_ms) is a new URL
    await loadIncidentRaster(manifest({ built_ms: BUILT + 1 }), 'observed_arrival')
    expect(calls).toHaveLength(3)
    expect(calls[2]).toMatch(new RegExp(`\\?v=${BUILT + 1}$`))
  })

  it('does not cache failures, so the next request retries', async () => {
    answer = () => ({ ok: false, status: 500, body: 'boom' })
    await expect(loadIncidentRaster(m, 'observed_arrival')).rejects.toThrow(/500/)
    expect(cpuRasterCacheStats()).toEqual({ entries: 0, bytes: 0 })
    answer = defaultAnswer
    expect((await loadIncidentRaster(m, 'observed_arrival')).data[15]).toBe(33)
    expect(calls).toHaveLength(2)
  })

  it('clearCpuRasterCache(match) drops the matching URLs only; no argument drops everything', async () => {
    const other = manifest({ id: 'other-fire' })
    await loadIncidentRaster(m, 'observed_arrival')
    await loadIncidentRaster(m, 'fuel')
    await loadIncidentRaster(other, 'observed_arrival')
    expect(cpuRasterCacheStats()).toEqual({ entries: 3, bytes: 64 + 16 + 64 })
    clearCpuRasterCache('/bundles/other-fire/')
    expect(cpuRasterCacheStats()).toEqual({ entries: 2, bytes: 80 })
    clearCpuRasterCache('fuel.bin')
    expect(cpuRasterCacheStats()).toEqual({ entries: 1, bytes: 64 })
    await loadIncidentRaster(m, 'observed_arrival')
    expect(calls).toHaveLength(3) // still cached
    clearCpuRasterCache()
    expect(cpuRasterCacheStats()).toEqual({ entries: 0, bytes: 0 })
    await loadIncidentRaster(m, 'observed_arrival')
    expect(calls).toHaveLength(4)
  })

  it('a layer that lands after the cache was cleared is returned but not counted', async () => {
    let release!: () => void
    answer = (url) => new Promise((resolve) => (release = () => resolve(defaultAnswer(url))))
    const p = loadIncidentRaster(m, 'observed_arrival')
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(cpuRasterCacheStats()).toEqual({ entries: 1, bytes: 0 }) // in flight
    clearCpuRasterCache()
    release()
    expect((await p).width).toBe(4)
    expect(cpuRasterCacheStats()).toEqual({ entries: 0, bytes: 0 })
  })

  it('evicts the least recently used layers above 256 MB, never the newest', async () => {
    // nine 32 MiB float32 layers (4096 x 2048); buffers are never written, so they cost no real memory
    const big = (i: number) => info(`layers/big${i}.bin`, 0, { width: 4096, height: 2048 })
    const layers: Record<string, LayerInfo> = {}
    for (let i = 0; i < 9; i++) layers[`big${i}`] = big(i)
    layers.huge = info('layers/huge.bin', 0, { width: 8192, height: 8192 }) // 256 MiB on its own
    const mb = manifest({ layers })
    answer = (url) => ({ ok: true, status: 200, buf: new ArrayBuffer(url.includes('huge') ? 256 * MiB : 32 * MiB) })
    for (let i = 0; i < 8; i++) await loadIncidentRaster(mb, `big${i}`)
    expect(cpuRasterCacheStats()).toEqual({ entries: 8, bytes: 256 * MiB }) // at the limit: nothing evicted
    await loadIncidentRaster(mb, 'big0') // touch: big1 is now the least recently used
    await loadIncidentRaster(mb, 'big8')
    expect(cpuRasterCacheStats()).toEqual({ entries: 8, bytes: 256 * MiB })
    expect(calls).toHaveLength(9)
    await loadIncidentRaster(mb, 'big0')
    expect(calls).toHaveLength(9) // big0 kept
    await loadIncidentRaster(mb, 'big1')
    expect(calls).toHaveLength(10) // big1 was evicted (and big2 now makes room for it)
    expect(cpuRasterCacheStats().bytes).toBeLessThanOrEqual(256 * MiB)
    await loadIncidentRaster(mb, 'huge')
    expect(cpuRasterCacheStats()).toEqual({ entries: 1, bytes: 256 * MiB }) // only the newest is left
  })
})

// ------------------------------------------------------------------------------------------------- raster sets
describe('raster sets', () => {
  const m = manifest()
  const f = forecast(m)
  const REQ: RasterRequest = { incident: ['observed_arrival', 'elevation', 'fuel'], forecast: ['burn_probability', 'arrival_p10', 'arrival_p50', 'arrival_p90'] }
  const statuses = (s: RasterSet) => ({
    incident: Object.fromEntries(Object.entries(s.incident).map(([k, v]) => [k, v.status])),
    forecast: Object.fromEntries(Object.entries(s.forecastLayers).map(([k, v]) => [k, v?.status])),
  })

  it('rasterSetKey is stable: same bundle version, run and names (any order, duplicates) give the same key', () => {
    const k = rasterSetKey(m, f, REQ)
    expect(rasterSetKey(manifest(), forecast(manifest()), { incident: ['fuel', 'observed_arrival', 'elevation', 'fuel'], forecast: ['arrival_p90', 'arrival_p50', 'arrival_p10', 'burn_probability'] })).toBe(k)
    expect(rasterSetKey(manifest({ built_ms: BUILT + 1 }), forecast(m), REQ)).not.toBe(k)
    expect(rasterSetKey(m, forecast(m, { run_id: 'fc-2' }), REQ)).not.toBe(k)
    expect(rasterSetKey(m, forecast(m, { issued_ms: f.issued_ms + 1 }), REQ)).not.toBe(k)
    expect(rasterSetKey(m, f, { ...REQ, incident: ['observed_arrival'] })).not.toBe(k)
    expect(rasterSetKey(m, f, { incident: REQ.incident })).not.toBe(k)
    // ignored forecasts (another incident, not ready) and unready bundles key like their absence
    expect(rasterSetKey(m, forecast(m, { incident_id: 'other-fire' }), REQ)).toBe(rasterSetKey(m, null, REQ))
    expect(rasterSetKey(m, forecast(m, { status: 'running' }), REQ)).toBe(rasterSetKey(m, null, REQ))
    expect(rasterSetKey(manifest({ status: 'building' }), f, REQ)).toBe(rasterSetKey(null, null, REQ))
    expect(rasterSetKey(m, f, {})).toBe(rasterSetKey(m, f, { incident: [], forecast: [] }))
  })

  it('pendingRasterSet: loading for the layers the bundle and run have, missing for the rest', () => {
    const p = pendingRasterSet(m, f, { incident: ['observed_arrival', 'canopy_cover'], forecast: ['arrival_p50'] })
    expect(statuses(p)).toEqual({ incident: { observed_arrival: 'loading', canopy_cover: 'missing' }, forecast: { arrival_p50: 'loading' } })
    expect(p.loading).toBe(true)
    expect(p.key).toBe(rasterSetKey(m, f, { incident: ['canopy_cover', 'observed_arrival'], forecast: ['arrival_p50'] }))
    expect([p.manifest, p.forecast]).toEqual([m, f])
    for (const s of [...Object.values(p.incident), ...Object.values(p.forecastLayers)]) expect([s?.layer, s?.error]).toEqual([null, null])
    const none = pendingRasterSet(m, null, REQ)
    expect(Object.values(none.forecastLayers).map((s) => s?.status)).toEqual(['missing', 'missing', 'missing', 'missing'])
    const unready = pendingRasterSet(manifest({ status: 'building' }), f, REQ)
    expect(unready.loading).toBe(false)
    expect([unready.manifest, unready.forecast]).toEqual([null, null])
    expect(new Set([...Object.values(unready.incident), ...Object.values(unready.forecastLayers)].map((s) => s?.status))).toEqual(new Set(['missing']))
  })

  it('loadRasterSet loads every requested layer once and resolves ready slots with the stored arrays', async () => {
    const set = await loadRasterSet(m, f, REQ)
    expect(statuses(set)).toEqual({
      incident: { elevation: 'ready', fuel: 'ready', observed_arrival: 'ready' },
      forecast: { arrival_p10: 'ready', arrival_p50: 'ready', arrival_p90: 'ready', burn_probability: 'ready' },
    })
    expect(set.loading).toBe(false)
    expect(set.key).toBe(rasterSetKey(m, f, REQ))
    expect(set.incident.elevation.layer).toMatchObject({ width: 8, height: 8, name: 'elevation' })
    expect(set.forecastLayers.arrival_p90?.layer?.url).toBe(forecastRasterUrl(m, f, 'arrival_p90'))
    expect([...calls].sort()).toEqual([...REQ.incident!.map((n) => incidentRasterUrl(m, n)), ...REQ.forecast!.map((n) => forecastRasterUrl(m, f, n))].sort())
    await loadRasterSet(m, f, REQ)
    expect(calls).toHaveLength(7) // the second set comes from the cache
  })

  it('never rejects: failures become error slots next to the ready ones', async () => {
    answer = (url) => (url.includes('arrival_p50') ? { ok: false, status: 500, body: '' } : url.includes('fuel') ? new TypeError('Failed to fetch') : defaultAnswer(url))
    const set = await loadRasterSet(m, f, { ...REQ, incident: [...REQ.incident!, 'naip'] })
    expect(set.forecastLayers.arrival_p50).toEqual({ status: 'error', layer: null, error: 'Server error (HTTP 500)' })
    expect(set.incident.fuel).toEqual({ status: 'error', layer: null, error: 'Cannot reach the Fire-3d API' })
    expect(set.incident.naip.status).toBe('error')
    expect(set.incident.naip.error).toMatch(/not a raster/)
    expect(set.incident.observed_arrival.status).toBe('ready')
    expect(set.forecastLayers.arrival_p10?.status).toBe('ready')
    const aborted = new AbortController()
    aborted.abort()
    const a = await loadRasterSet(m, f, REQ, { signal: aborted.signal })
    expect(new Set(Object.values(a.incident).map((s) => s.status))).toEqual(new Set(['error']))
    const broken = { ...m, layers: null } as unknown as IncidentManifest
    const b = await loadRasterSet(broken, f, REQ)
    expect(b.loading).toBe(false)
    expect(Object.values(b.incident).every((s) => s.status === 'error' && s.error)).toBe(true)
  })

  it('gives missing slots, without downloads, for unready bundles, absent layers and missing or ignored forecasts', async () => {
    for (const [mm, ff] of [
      [null, null],
      [manifest({ status: 'building' }), f],
      [manifest({ status: 'error' }), null],
    ] as const) {
      const set = await loadRasterSet(mm, ff, REQ)
      expect(new Set([...Object.values(set.incident), ...Object.values(set.forecastLayers)].map((s) => s?.status))).toEqual(new Set(['missing']))
      expect([set.manifest, set.forecast, set.loading]).toEqual([null, null, false])
    }
    // a forecast of another incident (store switch in progress) and a run that is not ready are ignored
    for (const ff of [forecast(m, { incident_id: 'other-fire' }), forecast(m, { status: 'running' }), null]) {
      const set = await loadRasterSet(m, ff, REQ)
      expect(set.forecast).toBeNull()
      expect(Object.values(set.forecastLayers).map((s) => s?.status)).toEqual(['missing', 'missing', 'missing', 'missing'])
      expect(set.incident.observed_arrival.status).toBe('ready')
    }
    const absent = await loadRasterSet(m, f, { incident: ['canopy_cover'] })
    expect(absent.incident.canopy_cover).toEqual({ status: 'missing', layer: null, error: null })
    expect(calls.some((u) => u.includes('forecasts/') || u.includes('canopy_cover'))).toBe(false)
  })
})

// ------------------------------------------------------------------------------------------------- hook
describe('useRasterSet (first render)', () => {
  const m = manifest()
  const f = forecast(m)
  const REQ: RasterRequest = { incident: ['observed_arrival'], forecast: ['arrival_p50'] }
  function render(req: RasterRequest): RasterSet {
    let out: RasterSet | null = null
    const keep = (s: RasterSet) => {
      out = s
    }
    const Probe = ({ report }: { report: (s: RasterSet) => void }) => {
      report(useRasterSet(req))
      return null
    }
    renderToStaticMarkup(createElement(Probe, { report: keep }))
    const set = out as RasterSet | null
    if (!set) throw new Error('not rendered')
    return set
  }

  it('reads the store: pending while loading, missing without a ready bundle, forecasts of another incident ignored', () => {
    store.state = { manifest: m, forecast: f }
    const p = render(REQ)
    expect(p.loading).toBe(true)
    expect([p.incident.observed_arrival.status, p.forecastLayers.arrival_p50?.status]).toEqual(['loading', 'loading'])
    expect(p.key).toBe(rasterSetKey(m, f, REQ))
    store.state = { manifest: m, forecast: forecast(m, { incident_id: 'other-fire' }) }
    expect(render(REQ).forecastLayers.arrival_p50?.status).toBe('missing')
    store.state = { manifest: manifest({ status: 'building' }), forecast: f }
    const u = render(REQ)
    expect([u.incident.observed_arrival.status, u.loading]).toEqual(['missing', false])
    expect(calls).toHaveLength(0) // rendering alone never downloads (effects load)
  })

  it('returns ready slots at once when every layer is already decoded in the cache', async () => {
    await loadRasterSet(m, f, REQ)
    store.state = { manifest: m, forecast: f }
    const s = render(REQ)
    expect(s.loading).toBe(false)
    expect(s.incident.observed_arrival.layer).toBe(await loadIncidentRaster(m, 'observed_arrival'))
    expect(s.forecastLayers.arrival_p50?.status).toBe('ready')
    clearCpuRasterCache('arrival_p50')
    expect(render(REQ).incident.observed_arrival.status).toBe('loading') // all or nothing
  })
})

// ------------------------------------------------------------------------------------------------- sampling
describe('sampling in incident-local metres (x east, z south)', () => {
  const EXT = 1200
  const H = EXT / 2

  it('insideAoi includes the edges and nothing beyond', () => {
    for (const [x, z] of [[0, 0], [-H, -H], [H, H], [H, -H], [-H, H], [H, 0]]) expect(insideAoi(x, z, EXT)).toBe(true)
    for (const [x, z] of [[H + 1e-9, 0], [0, -H - 1e-9], [-H - 0.01, H], [Number.NaN, 0]]) expect(insideAoi(x, z, EXT)).toBe(false)
  })

  it('pixelAt: row 0 north, col 0 west, corners, edges to the last row / column, null outside', () => {
    expect(pixelAt(-H, -H, EXT, 4, 4)).toEqual({ row: 0, col: 0, index: 0 }) // north-west corner
    expect(pixelAt(H, -H, EXT, 4, 4)).toEqual({ row: 0, col: 3, index: 3 }) // north-east
    expect(pixelAt(-H, H, EXT, 4, 4)).toEqual({ row: 3, col: 0, index: 12 }) // south-west
    expect(pixelAt(H, H, EXT, 4, 4)).toEqual({ row: 3, col: 3, index: 15 }) // south-east
    expect(pixelAt(0, 0, EXT, 4, 4)).toEqual({ row: 2, col: 2, index: 10 }) // the centre is a pixel corner: south-east pixel
    expect(pixelAt(-H + 300, -H + 299.999, EXT, 4, 4)).toEqual({ row: 0, col: 1, index: 1 }) // an inner boundary belongs to the next pixel
    expect(pixelAt(H - 1e-9, H - 1e-9, EXT, 4, 4)).toEqual({ row: 3, col: 3, index: 15 })
    expect(pixelAt(100, -100, EXT, 8, 2)).toEqual({ row: 0, col: 4, index: 4 }) // non-square grids
    expect(pixelAt(H + 0.001, 0, EXT, 4, 4)).toBeNull()
    expect(pixelAt(0, -H - 0.001, EXT, 4, 4)).toBeNull()
  })

  it('pixelCenter is the centre of the pixel, and pixelAt maps every centre back to its pixel', () => {
    expect(pixelCenter(0, 0, EXT, 4, 4)).toEqual({ x: -450, z: -450 })
    expect(pixelCenter(3, 3, EXT, 4, 4)).toEqual({ x: 450, z: 450 })
    expect(pixelCenter(0, 7, EXT, 8, 2)).toEqual({ x: 525, z: -300 })
    for (const [w, h, ext] of [[4, 4, EXT], [400, 400, 12000], [512, 512, 16000], [1024, 1024, 15360], [7, 3, 999.5]]) {
      for (let r = 0; r < h; r += Math.max(1, Math.floor(h / 37))) {
        for (let c = 0; c < w; c += Math.max(1, Math.floor(w / 41))) {
          const { x, z } = pixelCenter(r, c, ext, w, h)
          expect(pixelAt(x, z, ext, w, h)).toEqual({ row: r, col: c, index: r * w + c })
        }
        const { x, z } = pixelCenter(r, w - 1, ext, w, h)
        expect(pixelAt(x, z, ext, w, h)?.col).toBe(w - 1)
      }
    }
  })

  it('sampleLayer: nearest pixel without interpolation; nodata from LayerInfo or NaN; outside is unknown', () => {
    const l = layer(4, 4, (r, c) => (r === 1 && c === 2 ? -9999 : r === 2 && c === 1 ? Number.NaN : r * 10 + c + 0.5), { nodata: -9999 })
    expect(sampleLayer(l, -H + 1, -H + 1, EXT)).toEqual({ kind: 'value', value: 0.5, row: 0, col: 0 })
    expect(sampleLayer(l, -H + 299, -H + 1, EXT)).toEqual({ kind: 'value', value: 0.5, row: 0, col: 0 }) // no blending towards col 1
    expect(sampleLayer(l, H, H, EXT)).toEqual({ kind: 'value', value: 33.5, row: 3, col: 3 })
    expect(sampleLayer(l, 150, -150, EXT)).toEqual({ kind: 'nodata', row: 1, col: 2 })
    expect(sampleLayer(l, -150, 150, EXT)).toEqual({ kind: 'nodata', row: 2, col: 1 })
    expect(sampleLayer(l, H + 1, 0, EXT)).toEqual({ kind: 'outside' })
    const fuel: LoadedLayer = { ...layer(2, 2, () => 0), data: Uint8Array.of(0, 102, 165, 91), info: info('fuel.bin', 2, { dtype: 'uint8', nodata: 0 }) }
    expect(sampleLayer(fuel, -1, -1, EXT)).toEqual({ kind: 'nodata', row: 0, col: 0 })
    expect(sampleLayer(fuel, 1, -1, EXT)).toEqual({ kind: 'value', value: 102, row: 0, col: 1 })
    const noNodata = layer(2, 2, () => 0)
    expect(sampleLayer(noNodata, 0, 0, EXT)).toEqual({ kind: 'value', value: 0, row: 1, col: 1 }) // 0 is a value without LayerInfo.nodata
  })

  it('sampleArrival: hours and epoch ms from the given time origin; NEVER and above = never; nodata; outside', () => {
    const vals = [4, 29.25, NEVER, NEVER_MIN, NEVER_MIN - 1, Number.NaN, -1, Number.POSITIVE_INFINITY, 0]
    const l = layer(3, 3, (r, c) => vals[r * 3 + c], { nodata: -1 })
    const at = (i: number) => pixelCenter(Math.floor(i / 3), i % 3, EXT, 3, 3)
    const s = (i: number, origin = ORIGIN) => sampleArrival(l, at(i).x, at(i).z, EXT, origin)
    expect(s(0)).toEqual({ kind: 'arrival', hours: 4, ms: ORIGIN + 4 * HOUR_MS, row: 0, col: 0 })
    expect(s(1)).toEqual({ kind: 'arrival', hours: 29.25, ms: ORIGIN + 29.25 * HOUR_MS, row: 0, col: 1 })
    expect(s(2)).toEqual({ kind: 'never', row: 0, col: 2 })
    expect(s(3)).toEqual({ kind: 'never', row: 1, col: 0 })
    expect(s(4)).toMatchObject({ kind: 'arrival', hours: NEVER_MIN - 1 })
    expect(s(5)).toEqual({ kind: 'nodata', row: 1, col: 2 })
    expect(s(6)).toEqual({ kind: 'nodata', row: 2, col: 0 })
    expect(s(7)).toEqual({ kind: 'never', row: 2, col: 1 })
    expect(s(8)).toEqual({ kind: 'arrival', hours: 0, ms: ORIGIN, row: 2, col: 2 })
    expect(sampleArrival(l, 0, H + 5, EXT, ORIGIN)).toEqual({ kind: 'outside' })
    // forecast rasters count from forecast.time_origin_ms, incident rasters from manifest.time_origin_ms
    const fOrigin = forecast(manifest()).time_origin_ms
    expect(s(0, fOrigin)).toMatchObject({ kind: 'arrival', hours: 4, ms: fOrigin + 4 * HOUR_MS })
  })

  it('samples a loaded layer where the location check and the map expect it (row 0 = north = negative z)', async () => {
    const m = manifest()
    const obs = await loadIncidentRaster(m, 'observed_arrival') // value = row * 10 + col
    const ext = m.grid.extent_m
    expect(sampleArrival(obs, -ext / 2 + 10, -ext / 2 + 10, ext, m.time_origin_ms)).toMatchObject({ kind: 'arrival', hours: 0, row: 0, col: 0 })
    expect(sampleArrival(obs, ext / 2 - 10, -ext / 2 + 10, ext, m.time_origin_ms)).toMatchObject({ hours: 3, row: 0, col: 3 }) // north-east
    expect(sampleArrival(obs, -ext / 2 + 10, ext / 2 - 10, ext, m.time_origin_ms)).toMatchObject({ hours: 30, row: 3, col: 0 }) // south-west
    const elev = await loadIncidentRaster(m, 'elevation') // the render grid is finer than the fire grid
    expect(sampleLayer(elev, ext / 2, ext / 2, ext)).toEqual({ kind: 'value', value: 563, row: 7, col: 7 })
  })
})
