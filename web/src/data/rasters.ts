// Shared CPU rasters for the Public/Command map and the location check (CONTRACT §10; owner: map-core).
// Three.js-free: only types come from lib/raster.ts (the Forensic loader, which keeps its own cache). The files, URLs
// and cache-busting versions are the same as lib/raster.ts (`?v=built_ms` for bundle layers,
// `?v=built_ms-issued_ms` for forecast layers), so a second download of a file is an ETag 304. Values are the
// stored scientific arrays (SPEC 4.1-4.3: raw little-endian, row 0 = north edge, col 0 = west edge; arrival rasters
// in hours since a time origin, NEVER = 1e6), never display images.
//   - Loading: decoded layers are cached by URL (LRU, 256 MB of decoded bytes); concurrent requests share one fetch;
//     failed loads are not cached, so the next request retries.
//   - Raster sets: the slots ('loading' | 'ready' | 'missing' | 'error') of the layers a view needs. Unready bundles
//     and absent layers give 'missing'; a forecast of another incident (store switch in progress) or one that is not
//     ready is ignored (its slots are 'missing'). loadRasterSet never rejects: failures become 'error' slots.
//   - Sampling in incident-local metres (x east, z south): nearest pixel, no interpolation; the AOI square includes
//     its edges and the east / south edges belong to the last column / row. Outside the AOI = unknown (never "low").
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { bundleUrl, describeError, fetchArrayBuffer, type FetchOptions } from '../api/client'
import type { ForecastLayerName, ForecastManifest, IncidentManifest, LayerInfo } from '../api/types'
import type { LoadedLayer, RasterArray } from '../lib/raster'
import { useStore } from '../state/store'

export type { LoadedLayer, RasterArray } from '../lib/raster'
export type { FetchOptions } from '../api/client'

/** Arrival values at or above this are NEVER (stored NEVER = 1e6): never burned / not reached. */
export const NEVER_MIN = 999000
export const HOUR_MS = 3_600_000

/** Upper bound of the decoded-layer cache (bytes of decoded arrays). */
const MAX_CACHE_BYTES = 256 * 1024 * 1024

// ------------------------------------------------------------------------------------------------- URLs
/** URL of an incident raster (`manifest.layers[name]`, `?v=built_ms`); null when the bundle does not have it. */
export function incidentRasterUrl(manifest: IncidentManifest, name: string): string | null {
  const info = manifest.layers[name]
  return info ? bundleUrl(manifest.id, info.file, manifest.built_ms) : null
}

/** URL of a forecast raster (`?v=built_ms-issued_ms`); null when the run lacks the layer or belongs to another incident. */
export function forecastRasterUrl(manifest: IncidentManifest, forecast: ForecastManifest, name: ForecastLayerName): string | null {
  if (forecast.incident_id !== manifest.id) return null
  const info = forecast.layers?.[name]
  return info ? bundleUrl(manifest.id, info.file, `${manifest.built_ms}-${forecast.issued_ms}`) : null
}

// ------------------------------------------------------------------------------------------------- decoding
const BYTES_PER: Partial<Record<LayerInfo['dtype'], number>> = { float32: 4, uint8: 1, uint16: 2, int16: 2 }

function typedArray(name: string, info: LayerInfo, buf: ArrayBuffer): RasterArray {
  const size = BYTES_PER[info.dtype]
  if (!size) throw new Error(`layer ${name}: dtype ${info.dtype} is not a raster`)
  if (buf.byteLength % size !== 0) throw new Error(`layer ${name}: ${buf.byteLength} bytes is not a whole number of ${info.dtype} values`)
  switch (info.dtype) {
    case 'float32':
      return new Float32Array(buf)
    case 'uint8':
      return new Uint8Array(buf)
    case 'uint16':
      return new Uint16Array(buf)
    default:
      return new Int16Array(buf)
  }
}

/** Decode a downloaded file exactly like lib/raster.ts (points layers: width = values per point, height = count). */
function decode(name: string, url: string, info: LayerInfo, buf: ArrayBuffer): LoadedLayer {
  const data = typedArray(name, info, buf)
  if (info.grid === 'points') {
    const count = info.count ?? 0
    if (count <= 0 || data.length % count !== 0) throw new Error(`layer ${name}: ${data.length} values for ${count} points`)
    return { name, url, info, data, width: data.length / count, height: count }
  }
  const width = info.width ?? 0
  const height = info.height ?? 0
  if (width <= 0 || height <= 0 || data.length !== width * height) throw new Error(`layer ${name}: expected ${width}x${height}, got ${data.length} values`)
  return { name, url, info, data, width, height }
}

// ------------------------------------------------------------------------------------------------- cache (LRU by URL)
interface CacheEntry {
  promise: Promise<LoadedLayer>
  /** Decoded layer once loaded (synchronous reads, e.g. useRasterSet's first render). */
  layer: LoadedLayer | null
  /** Decoded bytes, counted once the layer is in. */
  bytes: number
}

const cache = new Map<string, CacheEntry>()
let cachedBytes = 0

function evict(keep: string): void {
  for (const [url, e] of cache) {
    if (cachedBytes <= MAX_CACHE_BYTES) break
    if (url === keep || !e.layer) continue // never the newest layer; pending downloads hold no bytes yet
    cache.delete(url)
    cachedBytes -= e.bytes
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

/** `promise`, or a rejection when `signal` aborts first (the shared download itself carries on and stays cached). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

function loadCached(name: string, url: string, info: LayerInfo, opts: FetchOptions = {}): Promise<LoadedLayer> {
  const { signal, ...init } = opts
  // nothing to download for an image layer or a caller that already gave up
  if (!BYTES_PER[info.dtype]) return Promise.reject(new Error(`layer ${name}: dtype ${info.dtype} is not a raster`))
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  let entry = cache.get(url)
  if (entry) {
    cache.delete(url) // LRU: most recently used last
    cache.set(url, entry)
  } else {
    const e: CacheEntry = { promise: fetchArrayBuffer(url, init).then((buf) => decode(name, url, info, buf)), layer: null, bytes: 0 }
    entry = e
    cache.set(url, e)
    e.promise.then(
      (layer) => {
        if (cache.get(url) !== e) return // cleared while downloading
        e.layer = layer
        e.bytes = layer.data.byteLength
        cachedBytes += e.bytes
        evict(url)
      },
      () => {
        if (cache.get(url) === e) cache.delete(url) // failures are not cached: the next request retries
      },
    )
  }
  const named = entry.promise.then((l) => (l.name === name ? l : { ...l, name }))
  return untilAborted(named, signal)
}

/** The decoded layer of `url` when it is already in the cache (no fetch, no LRU update). */
function peekCached(url: string): LoadedLayer | null {
  return cache.get(url)?.layer ?? null
}

/** Drop cached layers: all, or those whose URL contains `match` (e.g. an incident id after a rebuild). */
export function clearCpuRasterCache(match?: string): void {
  for (const [url, e] of cache) {
    if (match && !url.includes(match)) continue
    cache.delete(url)
    cachedBytes -= e.bytes
  }
  if (cache.size === 0) cachedBytes = 0
}

/** Cache entries (including downloads in flight) and decoded bytes held. */
export function cpuRasterCacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: cachedBytes }
}

// ------------------------------------------------------------------------------------------------- single layers
/** Load `manifest.layers[name]` as stored (cached by URL). Rejects when the bundle lacks the layer or the load fails. */
export function loadIncidentRaster(manifest: IncidentManifest, name: string, opts?: FetchOptions): Promise<LoadedLayer> {
  const info = manifest.layers[name]
  const url = incidentRasterUrl(manifest, name)
  if (!info || !url) return Promise.reject(new Error(`layer ${name} is not in the manifest`))
  return loadCached(name, url, info, opts)
}

/** Load a forecast raster (arrival_p10/p50/p90, burn_probability, flame_length_p50) as stored (cached by URL). */
export function loadForecastRaster(manifest: IncidentManifest, forecast: ForecastManifest, name: ForecastLayerName, opts?: FetchOptions): Promise<LoadedLayer> {
  if (forecast.incident_id !== manifest.id) return Promise.reject(new Error(`forecast ${forecast.run_id} belongs to ${forecast.incident_id}, not ${manifest.id}`))
  const info = forecast.layers?.[name]
  const url = forecastRasterUrl(manifest, forecast, name)
  if (!info || !url) return Promise.reject(new Error(`forecast layer ${name} missing`))
  return loadCached(name, url, info, opts)
}

// ------------------------------------------------------------------------------------------------- raster sets
/** missing = not in this bundle / no (ready) forecast run / the bundle is not ready. */
export type SlotStatus = 'loading' | 'ready' | 'missing' | 'error'

export interface RasterSlot {
  status: SlotStatus
  layer: LoadedLayer | null
  error: string | null
}

export interface RasterRequest {
  incident?: readonly string[]
  forecast?: readonly ForecastLayerName[]
}

export interface RasterSet {
  key: string
  /** The ready manifest the slots come from (null: no ready bundle). */
  manifest: IncidentManifest | null
  /** The forecast run the forecast slots come from (null: none, not ready, or another incident's). */
  forecast: ForecastManifest | null
  incident: Record<string, RasterSlot>
  forecastLayers: Partial<Record<ForecastLayerName, RasterSlot>>
  /** True while any slot is 'loading'. */
  loading: boolean
}

const MISSING: RasterSlot = Object.freeze({ status: 'missing', layer: null, error: null }) as RasterSlot
const LOADING: RasterSlot = Object.freeze({ status: 'loading', layer: null, error: null }) as RasterSlot

const readyManifest = (m: IncidentManifest | null | undefined): IncidentManifest | null => (m && m.status === 'ready' ? m : null)

/** The forecast a set uses: ready and of the same incident as the ready manifest, else null. */
function usableForecast(m: IncidentManifest | null, f: ForecastManifest | null | undefined): ForecastManifest | null {
  return m && f && f.incident_id === m.id && f.status === 'ready' ? f : null
}

const names = <T extends string>(list: readonly T[] | undefined): T[] => [...new Set(list ?? [])].sort()

/** Stable identity of a set: the ready bundle version, the usable forecast run and the requested layer names
 *  (order and duplicates do not matter). Equal keys mean equal slots. */
export function rasterSetKey(manifest: IncidentManifest | null | undefined, forecast: ForecastManifest | null | undefined, req: RasterRequest): string {
  const m = readyManifest(manifest)
  const f = usableForecast(m, forecast)
  const mk = m ? `${m.id}@${m.built_ms}` : '-'
  const fk = f ? `${f.run_id}@${f.issued_ms}` : '-'
  return `${mk}|${fk}|i:${names(req.incident).join(',')}|f:${names(req.forecast).join(',')}`
}

type SlotOf = (url: string, kind: 'incident' | 'forecast', name: string) => RasterSlot

function buildSet(manifest: IncidentManifest | null | undefined, forecast: ForecastManifest | null | undefined, req: RasterRequest, slotOf: SlotOf): RasterSet {
  const m = readyManifest(manifest)
  const f = usableForecast(m, forecast)
  const incident: Record<string, RasterSlot> = {}
  for (const name of names(req.incident)) {
    const url = m ? incidentRasterUrl(m, name) : null
    incident[name] = url ? slotOf(url, 'incident', name) : MISSING
  }
  const forecastLayers: Partial<Record<ForecastLayerName, RasterSlot>> = {}
  for (const name of names(req.forecast)) {
    const url = m && f ? forecastRasterUrl(m, f, name) : null
    forecastLayers[name] = url ? slotOf(url, 'forecast', name) : MISSING
  }
  const loading = [...Object.values(incident), ...Object.values(forecastLayers)].some((s) => s?.status === 'loading')
  return { key: rasterSetKey(m, f, req), manifest: m, forecast: f, incident, forecastLayers, loading }
}

/** The set before anything loaded: 'loading' for every layer the bundle / run has, 'missing' for the rest. */
export function pendingRasterSet(manifest: IncidentManifest | null | undefined, forecast: ForecastManifest | null | undefined, req: RasterRequest): RasterSet {
  return buildSet(manifest, forecast, req, () => LOADING)
}

/** The full set when every layer it needs is already decoded in the cache, else null (synchronous, no fetch). */
function cachedRasterSet(manifest: IncidentManifest | null | undefined, forecast: ForecastManifest | null | undefined, req: RasterRequest): RasterSet | null {
  let complete = true
  const set = buildSet(manifest, forecast, req, (url, _kind, name) => {
    const layer = peekCached(url)
    if (!layer) {
      complete = false
      return LOADING
    }
    return { status: 'ready', layer: layer.name === name ? layer : { ...layer, name }, error: null }
  })
  return complete ? set : null
}

async function settle(load: () => Promise<LoadedLayer>): Promise<RasterSlot> {
  try {
    return { status: 'ready', layer: await load(), error: null }
  } catch (e) {
    return { status: 'error', layer: null, error: describeError(e) }
  }
}

/** Load every requested layer of the ready manifest and the usable forecast. Never rejects: a failed layer becomes
 *  an 'error' slot; layers the bundle / run does not have (or no ready bundle / forecast) are 'missing'. */
export async function loadRasterSet(manifest: IncidentManifest | null | undefined, forecast: ForecastManifest | null | undefined, req: RasterRequest, opts?: FetchOptions): Promise<RasterSet> {
  try {
    const m = readyManifest(manifest)
    const f = usableForecast(m, forecast)
    const jobs: Promise<void>[] = []
    const loaded = new Map<string, RasterSlot>()
    const pending = buildSet(m, f, req, (_url, kind, name) => {
      const job =
        kind === 'incident' ? settle(() => loadIncidentRaster(m!, name, opts)) : settle(() => loadForecastRaster(m!, f!, name as ForecastLayerName, opts))
      jobs.push(job.then((slot) => void loaded.set(`${kind}:${name}`, slot)))
      return LOADING
    })
    await Promise.all(jobs)
    const incident: Record<string, RasterSlot> = {}
    for (const [name, slot] of Object.entries(pending.incident)) incident[name] = loaded.get(`incident:${name}`) ?? slot
    const forecastLayers: Partial<Record<ForecastLayerName, RasterSlot>> = {}
    for (const [name, slot] of Object.entries(pending.forecastLayers)) forecastLayers[name as ForecastLayerName] = loaded.get(`forecast:${name}`) ?? slot
    return { ...pending, incident, forecastLayers, loading: false }
  } catch (e) {
    // defensive: a malformed manifest must not reject the promise; every requested layer reports the error
    const error = describeError(e)
    const slot: RasterSlot = { status: 'error', layer: null, error }
    const incident: Record<string, RasterSlot> = {}
    for (const name of names(req.incident)) incident[name] = slot
    const forecastLayers: Partial<Record<ForecastLayerName, RasterSlot>> = {}
    for (const name of names(req.forecast)) forecastLayers[name] = slot
    let key = '-'
    try {
      key = rasterSetKey(manifest, forecast, req)
    } catch {
      // keep '-'
    }
    return { key, manifest: null, forecast: null, incident, forecastLayers, loading: false }
  }
}

/** Raster set of the store's ready manifest and selected forecast run. Pending ('loading') until loaded; reloads
 *  when the bundle version, the run or the requested names change (pass a stable `req`, e.g. a module constant). */
export function useRasterSet(req: RasterRequest): RasterSet {
  const manifest = useStore((s) => s.manifest)
  const forecast = useStore((s) => s.forecast)
  const key = rasterSetKey(manifest, forecast, req)
  // the latest inputs for the loading effect, which runs per key only: the key identifies everything the set
  // depends on (bundle version, usable run, requested names), so a new manifest object of the same bundle version
  // or a new `req` object with the same names does not reload
  const inputs = useRef({ manifest, forecast, req })
  useLayoutEffect(() => {
    inputs.current = { manifest, forecast, req }
  })
  const [loaded, setLoaded] = useState<RasterSet | null>(null)
  useEffect(() => {
    let live = true
    const { manifest: m, forecast: f, req: r } = inputs.current
    void loadRasterSet(m, f, r).then((set) => {
      if (live) setLoaded(set)
    })
    return () => {
      live = false
    }
  }, [key])
  // before the load answers: the decoded layers already in the cache, else 'loading' slots
  const fallback = useMemo(() => cachedRasterSet(manifest, forecast, req) ?? pendingRasterSet(manifest, forecast, req), [manifest, forecast, req])
  return loaded && loaded.key === key ? loaded : fallback
}

// ------------------------------------------------------------------------------------------------- sampling
/** True when local (x, z) lies inside the square AOI of side `extent` (edges included). */
export function insideAoi(x: number, z: number, extent: number): boolean {
  const h = extent / 2
  return x >= -h && x <= h && z >= -h && z <= h
}

/** The pixel of a `width` x `height` grid covering the AOI that contains local (x, z) (row 0 = north, col 0 = west);
 *  the east and south edges belong to the last column / row. Null outside the AOI. Same arithmetic as
 *  lib/reproject.ts overlay mapping. */
export function pixelAt(x: number, z: number, extent: number, width: number, height: number): { row: number; col: number; index: number } | null {
  if (!insideAoi(x, z, extent) || !(width > 0) || !(height > 0)) return null
  const col = Math.min(width - 1, Math.floor(((x + extent / 2) / extent) * width))
  const row = Math.min(height - 1, Math.floor(((z + extent / 2) / extent) * height))
  return { row, col, index: row * width + col }
}

/** Local (x, z) of the centre of pixel (row, col). */
export function pixelCenter(row: number, col: number, extent: number, width: number, height: number): { x: number; z: number } {
  return { x: -extent / 2 + ((col + 0.5) / width) * extent, z: -extent / 2 + ((row + 0.5) / height) * extent }
}

export type LayerSample = { kind: 'outside' } | { kind: 'nodata'; row: number; col: number } | { kind: 'value'; value: number; row: number; col: number }

export type ArrivalSample =
  | { kind: 'outside' }
  | { kind: 'nodata'; row: number; col: number }
  | { kind: 'never'; row: number; col: number }
  | { kind: 'arrival'; hours: number; ms: number; row: number; col: number }

/** The stored value of the pixel containing local (x, z): outside the AOI, nodata (NaN or LayerInfo.nodata), or a value. */
export function sampleLayer(layer: LoadedLayer, x: number, z: number, extent: number): LayerSample {
  const px = pixelAt(x, z, extent, layer.width, layer.height)
  if (!px) return { kind: 'outside' }
  const v = layer.data[px.index]
  const nd = layer.info.nodata
  if (v === undefined || Number.isNaN(v) || (nd != null && v === nd)) return { kind: 'nodata', row: px.row, col: px.col }
  return { kind: 'value', value: v, row: px.row, col: px.col }
}

/** An arrival raster (hours since `timeOriginMs`; values >= NEVER_MIN = never burned / not reached) at local (x, z).
 *  Forecast rasters use forecast.time_origin_ms, incident rasters manifest.time_origin_ms. */
export function sampleArrival(layer: LoadedLayer, x: number, z: number, extent: number, timeOriginMs: number): ArrivalSample {
  const s = sampleLayer(layer, x, z, extent)
  if (s.kind !== 'value') return s
  const { value: hours, row, col } = s
  if (hours >= NEVER_MIN) return { kind: 'never', row, col }
  if (!Number.isFinite(hours)) return { kind: 'nodata', row, col }
  return { kind: 'arrival', hours, ms: timeOriginMs + hours * HOUR_MS, row, col }
}
