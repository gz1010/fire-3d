// Client for /api/official/* (owner: official-web; endpoints by official-backend, CONTRACT §13 I7). Pure URL and
// time helpers, tested in client.test.ts.
import { API_BASE } from '../api/client'
import type { Mode } from '../api/types'
import { extrasAtMs } from '../extras/client'

/** Refresh cadence while the answer is current: CAL FIRE edits its records by hand (the backend's list cache is
 *  10 min); NWS alerts are cached 2 min by the backend. Archived answers are never refreshed. */
export const OFFICIAL_REFRESH_MS = { calfire: 300_000, fireWeather: 120_000 } as const

export function calfireUrl(incidentId: string): string {
  return `${API_BASE}/api/official/calfire?incident=${encodeURIComponent(incidentId)}`
}

/** Every NWS fire weather alert in California now (no incident): for points outside an open fire's area and the
 *  overview. The backend answers "not available for past dates" for any past time. */
export function fireWeatherStatewideUrl(): string {
  return `${API_BASE}/api/official/fire-weather`
}

export function fireWeatherUrl(incidentId: string, atMs: number | null): string {
  const p = new URLSearchParams({ incident: incidentId })
  if (atMs != null && Number.isFinite(atMs)) p.set('at_ms', String(Math.max(0, Math.round(atMs))))
  return `${API_BASE}/api/official/fire-weather?${p.toString()}`
}

/**
 * The `at_ms` for NWS fire weather alerts at a timeline position: null (= the live feed, now) while a live timeline
 * stands for the present (at / after the NOW marker, or within 6 h of now), else the hour (the backend answers from
 * the IEM archive, `archived: true`). Historical replay is always past. Hour-quantised, so playback never refetches.
 */
export function fireWeatherAtMs(mode: Mode, timeMs: number, nowMs: number, liveNowMs?: number | null): number | null {
  return extrasAtMs('evacuations', mode, timeMs, nowMs, liveNowMs)
}

/** Demo / fixture bundles have no CAL FIRE record or NWS area of their own. */
export function isFixtureIncident(id: string | null | undefined): boolean {
  return id != null && id.startsWith('fixture-')
}
