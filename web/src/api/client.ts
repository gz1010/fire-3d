// Typed helpers for the Fire-3d HTTP API (SPEC 6). All paths are relative to VITE_API_BASE ('' = same origin;
// the Vite dev server proxies /api to the backend).
import type {
  AircraftResponse,
  ForecastRequest,
  HealthResponse,
  IncidentDetailResponse,
  IncidentListResponse,
  JobStatus,
  LiveStatus,
  Mode,
} from './types'

export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')

export class ApiError extends Error {
  readonly status: number
  readonly url: string
  readonly body: string

  constructor(status: number, url: string, body: string) {
    super(`API ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`)
    this.name = 'ApiError'
    this.status = status
    this.url = url
    this.body = body
  }
}

export interface FetchOptions extends RequestInit {
  /** Abort after this many ms (default 30 s). */
  timeoutMs?: number
}

/** fetch + JSON parse with a timeout; throws ApiError on non-2xx. */
export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { timeoutMs = 30_000, signal, ...init } = opts
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs)
  const onAbort = () => ctrl.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    if (!res.ok) throw new ApiError(res.status, url, await res.text().catch(() => ''))
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Binary fetch (bundle rasters) with the same error handling. */
export async function fetchArrayBuffer(url: string, opts: FetchOptions = {}): Promise<ArrayBuffer> {
  const { timeoutMs = 120_000, signal, ...init } = opts
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs)
  const onAbort = () => ctrl.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    if (!res.ok) throw new ApiError(res.status, url, await res.text().catch(() => ''))
    return await res.arrayBuffer()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

const api = (path: string) => `${API_BASE}/api${path}`
const enc = encodeURIComponent

export const getHealth = (opts?: FetchOptions) => fetchJson<HealthResponse>(api('/health'), opts)

/** GET /api/incidents?mode=&min_acres= (historical default min_acres = 300 server-side). */
export function getIncidents(mode: Mode, minAcres?: number, opts?: FetchOptions) {
  const q = new URLSearchParams({ mode })
  if (minAcres != null) q.set('min_acres', String(minAcres))
  return fetchJson<IncidentListResponse>(api(`/incidents?${q}`), opts)
}

export const getIncident = (id: string, opts?: FetchOptions) => fetchJson<IncidentDetailResponse>(api(`/incidents/${enc(id)}`), opts)

export function postBuild(id: string, force = false, opts?: FetchOptions) {
  return fetchJson<JobStatus>(api(`/incidents/${enc(id)}/build?force=${force}`), { ...opts, method: 'POST' })
}

export function postForecast(id: string, req: ForecastRequest = {}, opts?: FetchOptions) {
  return fetchJson<JobStatus>(api(`/incidents/${enc(id)}/forecast`), {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
}

export const getJob = (jobId: string, opts?: FetchOptions) => fetchJson<JobStatus>(api(`/jobs/${enc(jobId)}`), opts)

export function getAircraft(id: string, all = false, opts?: FetchOptions) {
  return fetchJson<AircraftResponse>(api(`/incidents/${enc(id)}/aircraft?all=${all ? 1 : 0}`), opts)
}

export const getLiveStatus = (opts?: FetchOptions) => fetchJson<LiveStatus>(api('/live/status'), opts)

/** URL of a bundle file; `v` (manifest.built_ms) busts caches when the bundle is rebuilt. */
export function bundleUrl(id: string, path: string, v?: number | string | null): string {
  const p = path.replace(/^\/+/, '').split('/').map(enc).join('/')
  return api(`/bundles/${enc(id)}/${p}`) + (v != null ? `?v=${enc(String(v))}` : '')
}

/** True for an ApiError with HTTP 404. */
export function isNotFound(e: unknown): boolean {
  return e instanceof ApiError && e.status === 404
}

/** Short, user-facing description of a failed request (HTTP detail, timeout, unreachable API). */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    let detail = ''
    try {
      const body = JSON.parse(e.body) as { detail?: unknown; error?: unknown; message?: unknown }
      const d = body.detail ?? body.error ?? body.message
      if (typeof d === 'string') detail = d
      else if (Array.isArray(d)) detail = d.map((x) => (typeof x === 'object' && x && 'msg' in x ? String((x as { msg: unknown }).msg) : String(x))).join('; ')
    } catch {
      detail = e.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
    }
    const what = e.status === 404 ? 'Not found' : e.status >= 500 ? 'Server error' : `Request failed`
    return `${what}${detail ? `: ${detail}` : ''} (HTTP ${e.status})`
  }
  if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'The request timed out'
  if (e instanceof TypeError && /fetch|network|load/i.test(e.message)) return 'Cannot reach the Fire-3d API'
  return e instanceof Error ? e.message : String(e)
}
