// CAL FIRE incident record (owner: official-web; BRIEF-2 decision 3, PLAN-2 U-R6): the current record, the changes
// Fire-3d has recorded since it started checking, and their feed rows ("CAL FIRE: 65 % contained (was 50 %)"), each
// with CAL FIRE's own update time and the incident page. Past fires only have CAL FIRE's final record: the app says
// so. Values are CAL FIRE's (acres as published); nothing is interpolated. Pure, tested in calfire.test.ts.
import type { IncidentManifest, IncidentSummary, Mode } from '../api/types'
import { fmtWhen } from '../extras/format'
import { lonLatToLocal } from '../lib/reproject'
import { fmtDateTimeYear, tzLabel } from '../lib/time'
import type { FeedItem } from '../ui/feed/types'
import type { QueryState } from './query'
import type { CalFireChange, CalFireResponse } from './types'
import { httpsUrl } from './url'

export const CALFIRE_ISSUER = 'CAL FIRE'
export const CALFIRE_SOURCE = 'CAL FIRE incident record'
/** CAL FIRE's public incident list (fallback link when the record names no page). */
export const CALFIRE_INCIDENTS_URL = 'https://www.fire.ca.gov/incidents'

export interface CalFireStatus {
  state: 'available' | 'unavailable' | 'loading'
  acres?: number
  percentContained?: number
  isActive?: boolean
  /** CAL FIRE marks the record final (the fire is over). */
  final?: boolean
  /** CAL FIRE's own update time of the record. */
  updatedMs?: number
  /** The incident page (https). */
  url?: string
  agencies?: string
  /** When Fire-3d last checked CAL FIRE. */
  checkedMs?: number
  /** When Fire-3d started recording changes for this fire (null = not recording). */
  recordingSinceMs?: number | null
  /** Plain-language reason when unavailable. */
  reason?: string
  /** Unavailable because CAL FIRE or the Fire-3d server could not be reached (not because no record exists). */
  unreachable?: boolean
  /** Containment date from CAL FIRE's record (past fires). */
  containedMs?: number
  /** The backend's plain notes (e.g. "CAL FIRE edited this record well after the fire was contained; …"). */
  caveats?: string[]
}

/** The backend note worth showing next to the record: an update time that is a late edit, not news. */
export function laggedEditNote(s: Pick<CalFireStatus, 'caveats'>): string | null {
  return s.caveats?.find((c) => /edited this record well after/i.test(c)) ?? null
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export function agenciesText(a: CalFireResponse['agencies'] | undefined): string | undefined {
  if (!a) return undefined
  // CAL FIRE's AgencyNames string, verbatim except stray separators at the ends (", LA County …" in some records)
  const list = Array.isArray(a) ? a : [a]
  const s = list
    .map((x) => String(x).trim().replace(/^[,;\s]+|[,;\s]+$/g, ''))
    .filter(Boolean)
    .join(', ')
  return s || undefined
}

/**
 * The record to show: the endpoint's answer when available, else the incident summary (it also comes from CAL
 * FIRE's list: acres, containment, active flag, CAL FIRE's update time and page). Demo bundles have no record.
 */
export function calfireStatus(q: Pick<QueryState<CalFireResponse>, 'data' | 'loading' | 'error'> | null, summary: IncidentSummary | null, demo: boolean): CalFireStatus {
  if (demo) return { state: 'unavailable', reason: 'Demo data: this simulated incident has no CAL FIRE record.' }
  const d = q?.data
  // 'unavailable' with a record = CAL FIRE could not be reached (or dropped the fire): the last record Fire-3d saw
  if (d && d.current && d.status !== 'not_available_for_past_dates') {
    const c = d.current
    return {
      ...(d.status !== 'available' && d.reason ? { reason: d.reason } : {}),
      caveats: d.caveats ?? [],
      state: 'available',
      acres: num(c.acres),
      percentContained: num(c.percent_contained),
      isActive: c.is_active ?? undefined,
      final: c.final ?? undefined,
      updatedMs: num(c.updated_ms),
      url: httpsUrl(d.incident_url) ?? httpsUrl(summary?.url) ?? undefined,
      agencies: agenciesText(d.agencies),
      checkedMs: num(d.retrieved_ms),
      recordingSinceMs: num(d.recording_since_ms) ?? null,
      containedMs: num(c.extinguished_ms) ?? num(summary?.contained_ms),
    }
  }
  if (summary && summary.calfire_uid) {
    return {
      state: 'available',
      acres: num(summary.acres),
      percentContained: num(summary.percent_contained),
      isActive: summary.is_active,
      updatedMs: num(summary.updated_ms),
      url: httpsUrl(summary.url) ?? undefined,
      recordingSinceMs: null,
      containedMs: num(summary.contained_ms),
    }
  }
  if (q?.loading && !d) return { state: 'loading' }
  if (d && d.status !== 'available')
    return { state: 'unavailable', reason: d.reason ?? 'CAL FIRE has no record for this fire right now.', ...(d.reason_code === 'upstream_error' ? { unreachable: true } : {}) }
  if (q?.error) return { state: 'unavailable', reason: q.error, unreachable: true }
  return { state: 'unavailable', reason: 'No CAL FIRE record is linked to this fire.' }
}

const pct = (v: number | null | undefined) => (v == null ? 'not stated' : `${Math.round(v)} %`)
/** CAL FIRE's acreage as published (up to one decimal), so an edit such as 1,036.8 -> 1,037 never reads "1,037 (was 1,037)". */
const acresNum = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 1 })
const acresText = (v: number | null | undefined) => (v == null ? 'not stated' : `${acresNum(v)} acres`)
const activeText = (v: boolean | null | undefined) => (v == null ? 'not stated' : v ? 'active' : 'not active')

/** "65 % contained (was 50 %) · 2,150 acres (was 1,800)": the changed fields in CAL FIRE's terms. */
export function changeTitleParts(c: CalFireChange): string[] {
  const parts: string[] = []
  if (c.percent_contained) parts.push(`${pct(c.percent_contained[1])} contained (was ${pct(c.percent_contained[0])})`)
  if (c.acres) parts.push(`${acresText(c.acres[1])} (was ${c.acres[0] == null ? 'not stated' : acresNum(c.acres[0])})`)
  if (c.is_active) parts.push(c.is_active[1] === false ? 'no longer listed as active' : c.is_active[1] ? 'listed as active again' : `status ${activeText(c.is_active[1])}`)
  if (c.final && c.final[1]) parts.push('record marked final')
  return parts
}

export interface CalFireFeedContext {
  mode: Mode
  manifest: Pick<IncidentManifest, 'grid' | 'time_range'> | null
  summary: Pick<IncidentSummary, 'lat' | 'lon' | 'url' | 'contained_ms'> | null
}

function reportedLocation(ctx: CalFireFeedContext): FeedItem['location'] {
  const s = ctx.summary
  const g = ctx.manifest?.grid
  if (!s || !g || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return null
  const [x, z] = lonLatToLocal(s.lon, s.lat, g)
  return { lon: s.lon, lat: s.lat, x, z }
}

/** Official rows seek only inside the observed record (never into a forecast period). */
export function officialSeekable(tMs: number, manifest: Pick<IncidentManifest, 'time_range'> | null): boolean {
  const tr = manifest?.time_range
  return !!tr && Number.isFinite(tMs) && tMs >= tr.start_ms && tMs <= tr.now_ms
}

/** "Jan 31, 2025 10:48 PST": past records always name the year. */
const fmtWhenYear = (ms: number) => `${fmtDateTimeYear(ms)} ${tzLabel(ms)}`

const RECORDING_NOTE = (since: number | null | undefined) =>
  since != null ? `Fire-3d records CAL FIRE's changes since ${fmtWhenYear(since)}; earlier changes are not available.` : "Fire-3d has not recorded CAL FIRE's changes for this fire."

/**
 * Feed rows: one per recorded change (official, not automated, key), timed at CAL FIRE's update time (else when
 * Fire-3d first saw it, said so). Past fires (historical, or a final record) get one "CAL FIRE final record" row
 * with the note that CAL FIRE's update-by-update history is not available for past fires.
 */
export function calfireFeedItems(d: CalFireResponse | null, ctx: CalFireFeedContext): FeedItem[] {
  if (!d || !d.current || d.status === 'not_available_for_past_dates') return []
  const url = httpsUrl(d.incident_url) ?? httpsUrl(ctx.summary?.url) ?? null
  const location = reportedLocation(ctx)
  const base = {
    topic: 'calfire' as const,
    kind: 'official' as const,
    source: CALFIRE_SOURCE,
    automated: false,
    confidence: null,
    location,
    eventId: null,
    approximate: location != null,
    locationLabel: location ? "CAL FIRE's reported location" : null,
    url,
    issuer: CALFIRE_ISSUER,
    issuedMs: null,
    expiresMs: null,
    checkedMs: d.retrieved_ms,
    status: null,
  }
  const items: FeedItem[] = []
  const changes = [...(d.changes ?? [])].sort((a, b) => (a.updated_ms ?? a.seen_ms) - (b.updated_ms ?? b.seen_ms))
  for (const c of changes) {
    const parts = changeTitleParts(c)
    if (!parts.length) continue
    // the row's time is CAL FIRE's own update time; when Fire-3d saw the change is only "checked" (backend note g)
    const t = c.updated_ms ?? c.seen_ms
    const notes = [c.updated_ms == null ? 'CAL FIRE gives no update time for this change.' : null].filter((n): n is string => n != null)
    items.push({
      ...base,
      checkedMs: c.seen_ms,
      timeNotGiven: c.updated_ms == null,
      id: `calfire:${t}:${parts.join('|')}`,
      tMs: t,
      title: `CAL FIRE: ${parts.join(' · ')}`,
      detail: `CAL FIRE updated its incident record${c.updated_ms != null ? ` at ${fmtWhen(c.updated_ms)}` : ''}. Values as published by CAL FIRE.`,
      key: true,
      seekable: officialSeekable(t, ctx.manifest),
      updatedMs: c.updated_ms,
      notes,
      facts: [
        ...(c.percent_contained ? [{ label: 'Containment', text: `${pct(c.percent_contained[1])} (was ${pct(c.percent_contained[0])})`, scientific: null }] : []),
        ...(c.acres ? [{ label: 'Area (CAL FIRE)', text: `${acresText(c.acres[1])} (was ${acresText(c.acres[0])})`, scientific: null }] : []),
        ...(c.is_active ? [{ label: 'Status', text: `${activeText(c.is_active[1])} (was ${activeText(c.is_active[0])})`, scientific: null }] : []),
      ],
    })
  }
  const cur = d.current
  const past = ctx.mode === 'historical' || cur?.final === true
  if (past && cur) {
    const t = cur.updated_ms ?? d.source_updated_ms ?? null
    const facts = [
      { label: 'Area (CAL FIRE)', text: acresText(cur.acres), scientific: null },
      { label: 'Containment', text: pct(cur.percent_contained), scientific: null },
      ...((cur.extinguished_ms ?? ctx.summary?.contained_ms) ? [{ label: 'Contained', text: fmtWhenYear((cur.extinguished_ms ?? ctx.summary?.contained_ms) as number), scientific: null }] : []),
    ]
    items.push({
      ...base,
      id: 'calfire:final',
      tMs: t ?? d.retrieved_ms ?? d.now_ms,
      title: `CAL FIRE final record: ${acresText(cur.acres)}, ${pct(cur.percent_contained)} contained`,
      detail: "CAL FIRE's update-by-update history is not available for past fires; this is its final record.",
      key: true,
      seekable: false,
      updatedMs: t,
      timeNotGiven: t == null,
      notes: [
        t != null ? `CAL FIRE last edited this record ${fmtWhenYear(t)}${ctx.manifest && t > ctx.manifest.time_range.end_ms ? ', after the end of the record shown here' : ''}.` : 'CAL FIRE gives no update time for this record.',
        RECORDING_NOTE(d.recording_since_ms),
      ],
      facts,
    })
  }
  return items
}

/** The note shown under the CAL FIRE status: what history exists. */
export function calfireHistoryNote(s: CalFireStatus, mode: Mode): string | null {
  if (s.state !== 'available') return null
  if (mode === 'historical' || s.final) return `CAL FIRE's update-by-update history is not available for past fires. ${RECORDING_NOTE(s.recordingSinceMs)}`
  return s.recordingSinceMs != null ? RECORDING_NOTE(s.recordingSinceMs) : null
}
