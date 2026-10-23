// Plain-language time and status text for the optional sources (owner: us-official in brief 3; earlier
// optional-sources). Times show in the fire's own zone (else the selected place's, else the viewer's) with the zone
// label and the preset's clock (CONTRACT §14.9; `getTimeFormat()` unless a `tf` is given); every text says which clock
// it refers to (issuer update, Fire-3d fetch, satellite acquisition, camera image).
import { fmtAt, type TimeFmt } from '../lib/time'
import { getTimeFormat } from '../state/timeZone'
import type { ExtrasEnvelope } from './types'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** "Oct 17, 13:05 PDT" / "Oct 17, 1:05 PM MDT" (the year is added when the local year differs from the reference
 *  year), in `tf`'s zone and clock (default `getTimeFormat()`: the open fire's zone and the preset's clock). */
export function fmtWhen(ms: number, refMs?: number, tf?: TimeFmt): string {
  return fmtAt(ms, tf ?? getTimeFormat(), { zone: true, year: refMs == null ? 'never' : 'auto', refMs })
}

/** Rounded duration: "45 s", "12 min", "5 h", "3 days". */
export function durationText(ms: number): string {
  const a = Math.abs(ms)
  if (a < MIN) return `${Math.max(1, Math.round(a / 1000))} s`
  if (a < HOUR) return `${Math.round(a / MIN)} min`
  if (a < 2 * DAY) {
    const h = a / HOUR
    return `${h < 10 ? Math.round(h * 10) / 10 : Math.round(h)} h`
  }
  return `${Math.round(a / DAY)} days`
}

/** "12 min ago" / "in 3 h" / "just now" relative to `nowMs`. */
export function agoText(ms: number, nowMs: number): string {
  const d = nowMs - ms
  if (Math.abs(d) < 30_000) return 'just now'
  return d > 0 ? `${durationText(d)} ago` : `in ${durationText(d)}`
}

/** "3 h before the selected time" / "2 days after the selected time" / "at the selected time". */
export function relativeToText(ms: number, refMs: number, refLabel = 'the selected time'): string {
  const d = refMs - ms
  if (Math.abs(d) < 5 * MIN) return `at ${refLabel}`
  return d > 0 ? `${durationText(d)} before ${refLabel}` : `${durationText(d)} after ${refLabel}`
}

export type Tone = 'ok' | 'info' | 'warn' | 'muted' | 'error'

export interface StatusLine {
  tone: Tone
  title: string
  detail: string | null
}

/** Headline for an envelope's explicit status (past dates and outages are never shown as "none"). */
export function envelopeStatusLine(env: (Pick<ExtrasEnvelope, 'status' | 'reason'> & Partial<Pick<ExtrasEnvelope, 'reason_code'>>) | null, what: string, error?: string | null): StatusLine {
  if (error) return { tone: 'error', title: `${what}: could not load`, detail: error }
  if (!env) return { tone: 'muted', title: `${what}: loading…`, detail: null }
  // brief 3 (CONTRACT §14.8): no source in this state; never "none" and never an outage
  if (env.reason_code === 'state_not_available') return { tone: 'muted', title: `${what}: not available in this state`, detail: env.reason }
  if (env.status === 'not_available_for_past_dates') return { tone: 'muted', title: `${what}: not available for past dates`, detail: env.reason }
  if (env.status === 'unavailable') return { tone: 'warn', title: `${what}: unavailable`, detail: env.reason }
  return { tone: 'ok', title: what, detail: null }
}

/** "Source updated 13:05 PDT · fetched 2 min ago". */
export function freshnessText(env: Pick<ExtrasEnvelope, 'source_updated_ms' | 'retrieved_ms'>, nowMs: number, updatedLabel = 'Source updated', tf?: TimeFmt): string {
  const parts: string[] = []
  if (env.source_updated_ms) parts.push(`${updatedLabel} ${fmtWhen(env.source_updated_ms, nowMs, tf)}`)
  if (env.retrieved_ms) parts.push(`fetched ${agoText(env.retrieved_ms, nowMs)}`)
  return parts.join(' · ')
}

/** The error text of an HTTP 404 (an endpoint or an id the server does not know). */
export const NOT_FOUND_TEXT = 'This incident is not known to the Fire-3d server.'

/** Error text for a failed request to the Fire-3d API (status codes from the backend contract). */
export function requestErrorText(e: unknown): string {
  const status = (e as { status?: number } | null)?.status
  if (status === 429) return 'Too many requests to this source right now. Try again in a minute.'
  if (status === 400) return 'The request was not valid for this source.'
  if (status === 404) return NOT_FOUND_TEXT
  if (status != null && status >= 500) return 'The Fire-3d server could not get data from this source.'
  if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'The request timed out.'
  return 'Could not reach the Fire-3d server.'
}
