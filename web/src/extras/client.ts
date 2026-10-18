// Typed client for /api/extras/* (owner: optional-sources; CONTRACT "Optional sources"). Pure URL / area / time
// helpers are exported for tests and for the hooks in hooks.ts.
import { API_BASE, fetchJson, type FetchOptions } from '../api/client'
import type { IncidentManifest, IncidentSummary, Mode } from '../api/types'
import type {
  CameraFrameResponse,
  CamerasResponse,
  EvacuationsResponse,
  ExtrasSourcesResponse,
  ImageryFamily,
  ImageryResponse,
} from './types'

export type BBox = [number, number, number, number]

export interface AreaQuery {
  /** [w, s, e, n] in degrees. When absent the backend uses the incident's analysis area + `marginKm`. */
  bbox?: BBox | null
  incident?: string | null
  /** A past time (replay) from `extrasAtMs`; null / absent = now. */
  atMs?: number | null
  marginKm?: number | null
}

export interface ImageryQuery extends AreaQuery {
  families?: ImageryFamily[] | null
}

export type ExtrasKind = 'evacuations' | 'cameras' | 'imagery'

/** Same tolerance as the backend (`PAST_TOLERANCE_MS`) and the timeline's STALE_AFTER_MS. */
export const EXTRAS_PAST_TOLERANCE_MS = 6 * 3_600_000
const HOUR = 3_600_000
const HALF_HOUR = 1_800_000

const fmt = (v: number) => (Math.round(v * 1e4) / 1e4).toString()

/** Query string for an area query (stable parameter order, rounded coordinates: cache friendly). */
export function areaParams(q: ImageryQuery): URLSearchParams {
  const p = new URLSearchParams()
  if (q.bbox) p.set('bbox', q.bbox.map(fmt).join(','))
  if (q.incident) p.set('incident', q.incident)
  if (q.atMs != null && Number.isFinite(q.atMs)) p.set('at_ms', String(Math.max(0, Math.round(q.atMs))))
  if (q.marginKm != null && Number.isFinite(q.marginKm)) p.set('margin_km', String(q.marginKm))
  if (q.families?.length) p.set('families', q.families.join(','))
  return p
}

export function extrasUrl(kind: ExtrasKind, q: ImageryQuery): string {
  return `${API_BASE}/api/extras/${kind}?${areaParams(q).toString()}`
}

/** Absolute URL for a relative API path returned by the backend (frame and image URLs). */
export function apiPath(rel: string): string {
  return rel.startsWith('/') ? `${API_BASE}${rel}` : rel
}

/**
 * True when a live timeline position stands for the present: within the past tolerance of now, or at / after the
 * timeline's NOW marker (`liveNowMs` = `nowMarkerMs(manifest, forecast)`, the latest observation, which can be older
 * than the tolerance when the incident data is stale), which includes the forecast future.
 */
function isPresent(mode: Mode, timeMs: number, nowMs: number, liveNowMs: number | null | undefined, toleranceMs: number): boolean {
  if (mode !== 'live') return false
  return timeMs >= nowMs - toleranceMs || (liveNowMs != null && Number.isFinite(liveNowMs) && timeMs >= liveNowMs)
}

/**
 * The `at_ms` to send for the current timeline position, quantised so playback does not refetch every frame:
 * - evacuations / cameras (current status only): null (= now) while the live timeline stands for the present (see
 *   `isPresent`); otherwise the hour, and the backend answers "not available for past dates". Historical replay is
 *   always past.
 * - imagery (archived): null for the live present; otherwise the time floored to 30 minutes (images acquired up to
 *   then, never later than now).
 */
export function extrasAtMs(kind: ExtrasKind, mode: Mode, timeMs: number, nowMs: number, liveNowMs?: number | null): number | null {
  if (!Number.isFinite(timeMs)) return null
  if (kind === 'imagery') {
    if (isPresent(mode, timeMs, nowMs, liveNowMs, HALF_HOUR)) return null
    return Math.floor(Math.min(timeMs, nowMs) / HALF_HOUR) * HALF_HOUR
  }
  return isPresent(mode, timeMs, nowMs, liveNowMs, EXTRAS_PAST_TOLERANCE_MS) ? null : Math.floor(timeMs / HOUR) * HOUR
}

/** True when current-only sources (evacuations, cameras) cannot be shown for this timeline position. */
export function isPastForCurrentSources(mode: Mode, timeMs: number, nowMs: number, liveNowMs?: number | null): boolean {
  return !isPresent(mode, timeMs, nowMs, liveNowMs, EXTRAS_PAST_TOLERANCE_MS)
}

export function expandBbox(b: BBox, km: number): BBox {
  const lat = ((b[1] + b[3]) / 2) * (Math.PI / 180)
  const dLat = km / 111.32
  const dLon = km / (111.32 * Math.max(0.2, Math.cos(lat)))
  return [Math.max(-180, b[0] - dLon), Math.max(-85, b[1] - dLat), Math.min(180, b[2] + dLon), Math.min(85, b[3] + dLat)]
}

/**
 * The area to query around an incident: the analysis area (manifest grid bbox) plus a margin, else the reported
 * location +- (10 km + margin). Null without either.
 */
export function incidentAreaBbox(summary: Pick<IncidentSummary, 'lat' | 'lon'> | null, manifest: Pick<IncidentManifest, 'grid'> | null, marginKm: number): BBox | null {
  const bb = manifest?.grid?.bbox_lonlat
  if (bb && bb.length === 4 && bb.every(Number.isFinite)) return expandBbox([bb[0], bb[1], bb[2], bb[3]], marginKm)
  if (summary && Number.isFinite(summary.lat) && Number.isFinite(summary.lon)) return expandBbox([summary.lon, summary.lat, summary.lon, summary.lat], 10 + marginKm)
  return null
}

/** Default margins per source (km beyond the analysis area): zones near the fire, cameras on surrounding peaks,
 *  imagery just around the area (renders stay small). */
export const DEFAULT_MARGIN_KM: Record<ExtrasKind, number> = { evacuations: 15, cameras: 25, imagery: 5 }

export function fetchEvacuations(q: AreaQuery, opts?: FetchOptions): Promise<EvacuationsResponse> {
  return fetchJson<EvacuationsResponse>(extrasUrl('evacuations', q), { timeoutMs: 30_000, ...opts })
}

export function fetchCameras(q: AreaQuery, opts?: FetchOptions): Promise<CamerasResponse> {
  return fetchJson<CamerasResponse>(extrasUrl('cameras', q), { timeoutMs: 30_000, ...opts })
}

export function fetchImagery(q: ImageryQuery, opts?: FetchOptions): Promise<ImageryResponse> {
  return fetchJson<ImageryResponse>(extrasUrl('imagery', q), { timeoutMs: 60_000, ...opts })
}

/** Fetch one camera's latest image now. Call only on an explicit user action. */
export function fetchCameraFrame(cameraId: string, opts?: FetchOptions): Promise<CameraFrameResponse> {
  return fetchJson<CameraFrameResponse>(`${API_BASE}/api/extras/cameras/latest?id=${encodeURIComponent(cameraId)}`, { timeoutMs: 30_000, ...opts })
}

export function fetchExtrasSources(opts?: FetchOptions): Promise<ExtrasSourcesResponse> {
  return fetchJson<ExtrasSourcesResponse>(`${API_BASE}/api/extras/sources`, { timeoutMs: 15_000, ...opts })
}
