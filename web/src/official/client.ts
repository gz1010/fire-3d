// Client for /api/official/* (owner: official-web; endpoints by official-backend, CONTRACT §13 I7). Pure URL and
// time helpers, tested in client.test.ts.
import { API_BASE } from '../api/client'
import type { IncidentSummary, Mode } from '../api/types'
import { extrasAtMs } from '../extras/client'

/** Refresh cadence while the answer is current: CAL FIRE edits its records by hand (the backend's list cache is
 *  10 min); NWS alerts are cached 2 min by the backend. Archived answers are never refreshed. */
export const OFFICIAL_REFRESH_MS = { calfire: 300_000, fireWeather: 120_000, local: 60_000 } as const

export function calfireUrl(incidentId: string): string {
  return `${API_BASE}/api/official/calfire?incident=${encodeURIComponent(incidentId)}`
}

/** NIFC WFIGS (IRWIN) record of a listed fire (CONTRACT §14.5; us-catalog's endpoint). */
export function incidentRecordUrl(incidentId: string): string {
  return `${API_BASE}/api/official/incident-record?incident=${encodeURIComponent(incidentId)}`
}

type RecordSummary = Pick<IncidentSummary, 'id'> & Partial<Pick<IncidentSummary, 'record_source' | 'irwin_id' | 'active_sources' | 'complex_members'>>

/** The fire's own record (CONTRACT §14.5): CAL FIRE's for `record_source 'calfire'` (or an older summary without it),
 *  NIFC WFIGS's for `'wfigs'`. */
export function recordUrl(summary: RecordSummary): string {
  return (summary.record_source ?? 'calfire') === 'wfigs' ? incidentRecordUrl(summary.id) : calfireUrl(summary.id)
}

/** The second record a California fire needs (round 3 item 2): its matched NIFC WFIGS record when the agencies
 *  disagree on whether it is active (`active_sources.length === 1`). Never for a CAL FIRE complex row (no `irwin_id`;
 *  its members come from the summary) and never for a WFIGS row. */
export function secondaryRecordUrl(summary: RecordSummary): string | null {
  if ((summary.record_source ?? 'calfire') !== 'calfire') return null
  if (!summary.irwin_id || (summary.complex_members?.length ?? 0) > 0) return null
  return summary.active_sources?.length === 1 ? incidentRecordUrl(summary.id) : null
}

/** Every current NWS fire weather alert the backend checks (no incident; `states_checked` says where: the lower 48
 *  once the national request is live): for points outside an open fire's area and the overview. */
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

/** Local officials' messages for a fire's area (CONTRACT §14.7): live (`atMs` null), or at a past time (NWS for the
 *  last 7 days, FEMA's OpenFEMA archive for times older than 24 h). */
export function localAlertsUrl(incidentId: string, atMs: number | null): string {
  const p = new URLSearchParams({ incident: incidentId })
  if (atMs != null && Number.isFinite(atMs)) p.set('at_ms', String(Math.max(0, Math.round(atMs))))
  return `${API_BASE}/api/official/local-alerts?${p.toString()}`
}

/** Local officials' messages at a point's small box, live only (the location card). */
export function localAlertsBboxUrl(b: readonly [number, number, number, number]): string {
  return `${API_BASE}/api/official/local-alerts?bbox=${b.map((v) => Math.round(v * 1e4) / 1e4).join(',')}`
}

/** Demo / fixture bundles have no CAL FIRE record or NWS area of their own. */
export function isFixtureIncident(id: string | null | undefined): boolean {
  return id != null && id.startsWith('fixture-')
}
