// The fire's agency record, source-neutral (brief 3, CONTRACT §14.5; owner: us-official). A fire's own record is
// CAL FIRE's (`record_source 'calfire'`, /api/official/calfire) or NIFC WFIGS's (`'wfigs'`, the protecting agency's
// numbers published by NIFC, /api/official/incident-record). The issuer label and the disagreement rule come from
// web/src/api/records.ts (recordIssuerLabel, recordBlocks): a California fire active per one agency only shows each
// record with its own issuer, status and time (round 3 item 2). A CAL FIRE complex row shows CAL FIRE's record and
// its named member fires, never one member's numbers as the complex's (round 3 item 3). Synthetic or local data has
// no record ("not available: synthetic or local data"); an older backend without the record endpoint (HTTP 404) is
// "agency record not checked". Values are the agency's as published; nothing is merged with model output, and no
// record is ever an all-clear. Pure, tested in record.test.ts.
import type { IncidentManifest, IncidentSummary, Mode, RecordSource } from '../api/types'
import { otherRecordIssuerLabel, recordBlocks, recordIssuerLabel } from '../api/records'
import { fmtWhen, NOT_FOUND_TEXT } from '../extras/format'
import { lonLatToLocal } from '../lib/reproject'
import { fmtAt, type TimeFmt } from '../lib/time'
import type { FeedItem } from '../ui/feed/types'
import { calfireStatus, type CalFireStatus } from './calfire'
import type { QueryState } from './query'
import type { CalFireResponse, IncidentRecordResponse } from './types'
import { httpsUrl } from './url'

/** One agency record when the agencies disagree on whether the fire is active (each as published). */
export interface RecordBlockStatus {
  source: RecordSource
  /** "CAL FIRE", "USFS (USDA Forest Service) via NIFC WFIGS". */
  issuer: string
  /** The record's own name when it is not the fire's (a member fire), else null. */
  name: string | null
  isActive: boolean
  updatedMs: number | null
  url: string | null
}

/** The agency record of the open fire (`OfficialInfo.calfire`; a superset of the brief-2 CAL FIRE status). */
export interface RecordStatus extends CalFireStatus {
  /** Whose record it is (null: none: synthetic data, nothing selected). */
  source: RecordSource | null
  /** Who published it (recordIssuerLabel): "CAL FIRE", "USFS (USDA Forest Service) via NIFC WFIGS", "Agency record". */
  issuer: string
  /** Short label for its link and tag: "CAL FIRE", "NIFC WFIGS". */
  linkLabel: string
  /** Every record (own first) when the agencies disagree on whether the fire is active; absent when they agree. */
  blocks?: RecordBlockStatus[]
  /** A CAL FIRE complex row: its member fires as NIFC WFIGS names them (verbatim), each with its record link. */
  members?: { name: string; url: string | null }[]
  /** A member fire: "Part of the X Complex" (the name as recorded; never "Complex Complex"). */
  complexName?: string | null
  /** Synthetic or local data: no agency record exists. */
  synthetic?: boolean
  /** The record could not be checked at all (an older backend without the endpoint). */
  notChecked?: boolean
  /** The protecting unit as WFIGS names it ("MTCES"). */
  protectingUnit?: string | null
  /** The record's own discovery time (WFIGS). */
  discoveredMs?: number
}

export const SYNTHETIC_RECORD_REASON = 'Not available: synthetic or local data.'
export const RECORD_NOT_CHECKED_REASON = 'Agency record not checked: this Fire-3d server does not offer it.'

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** "CAL FIRE" / "NIFC WFIGS": the short name of a record's publisher (links, tags). */
export function recordLinkLabel(source: RecordSource | null | undefined): string {
  return source === 'wfigs' ? 'NIFC WFIGS' : source === 'calfire' ? 'CAL FIRE' : 'Agency record'
}

/** "Part of the X Complex": `complex_name` already ends in "Complex" most of the time (never added twice). */
export function partOfComplex(name: string | null | undefined): string | null {
  const n = name?.trim()
  if (!n) return null
  return `Part of the ${/\bcomplex$/i.test(n) ? n : `${n} Complex`}`
}

type Q<T> = Pick<QueryState<T>, 'data' | 'loading' | 'error'> | null

export interface RecordInput {
  calfire: Q<CalFireResponse>
  record: Q<IncidentRecordResponse>
  summary: IncidentSummary | null
  demo: boolean
  hasIncident: boolean
}

/** The NIFC WFIGS record of a WFIGS fire (its own record). */
function wfigsStatus(q: Q<IncidentRecordResponse>, summary: IncidentSummary | null): Omit<RecordStatus, 'issuer' | 'linkLabel' | 'source'> {
  const d = q?.data ?? null
  if (d?.current && d.status === 'available') {
    const c = d.current
    return {
      state: 'available',
      acres: num(c.acres),
      percentContained: num(c.percent_contained),
      isActive: c.is_active,
      updatedMs: num(c.updated_ms),
      url: httpsUrl(d.incident_url) ?? httpsUrl(summary?.url) ?? undefined,
      agencies: d.agency ? `${d.agency_code ? `${d.agency_code} (${d.agency})` : d.agency}` : (d.agency_code ?? undefined),
      checkedMs: num(d.retrieved_ms),
      recordingSinceMs: null,
      containedMs: num(c.contained_ms) ?? num(c.controlled_ms) ?? num(c.out_ms),
      discoveredMs: num(c.discovered_ms),
      protectingUnit: d.protecting_unit,
      caveats: d.caveats ?? [],
    }
  }
  if (q?.loading && !d) return { state: 'loading' }
  if (d && d.reason_code === 'not_covered' && /synthetic or local/i.test(d.reason ?? '')) return { state: 'unavailable', reason: SYNTHETIC_RECORD_REASON, synthetic: true }
  if (d) return { state: 'unavailable', reason: d.reason ?? 'NIFC WFIGS has no record for this fire right now.', ...(d.reason_code === 'upstream_error' ? { unreachable: true } : {}) }
  if (q?.error === NOT_FOUND_TEXT) return { state: 'unavailable', reason: RECORD_NOT_CHECKED_REASON, notChecked: true }
  if (q?.error) return { state: 'unavailable', reason: q.error, unreachable: true }
  return { state: 'loading' }
}

/**
 * The open fire's agency record (CONTRACT §14.5): CAL FIRE's (with the summary fallback for CAL FIRE rows only) or
 * NIFC WFIGS's, labelled from recordIssuerLabel; every record block when the agencies disagree; a complex row's named
 * members; synthetic data and a missing endpoint said as such.
 */
export function recordStatus(i: RecordInput): RecordStatus {
  const s = i.summary
  if (!i.hasIncident) return { state: 'unavailable', reason: 'No fire selected.', source: null, issuer: 'Agency record', linkLabel: 'Agency record' }
  if (i.demo) return { state: 'unavailable', reason: SYNTHETIC_RECORD_REASON, synthetic: true, source: null, issuer: 'Agency record', linkLabel: 'Agency record' }
  const source: RecordSource = s?.record_source ?? 'calfire'
  const issuer = s ? recordIssuerLabel(s) : 'CAL FIRE'
  const complexName = s?.complex_name ?? null
  if (source === 'wfigs') {
    return { ...wfigsStatus(i.record, s), source, issuer, linkLabel: recordLinkLabel(source), complexName }
  }
  const cf = calfireStatus(i.calfire, s, false)
  const base: RecordStatus = { ...cf, source, issuer, linkLabel: recordLinkLabel(source), complexName }
  if (cf.state === 'unavailable' && /synthetic or local/i.test(cf.reason ?? '')) Object.assign(base, { reason: SYNTHETIC_RECORD_REASON, synthetic: true })
  if (!s) return base
  // a CAL FIRE complex row: its members by name (NIFC WFIGS names), never a member's numbers
  if ((s.complex_members?.length ?? 0) > 0) {
    const others = s.other_records ?? []
    base.members = (s.complex_members ?? []).map((name) => ({ name, url: httpsUrl(others.find((o) => o.name === name)?.url) }))
    return base
  }
  // agencies disagree on whether it is active: every record block, the matched WFIGS one refreshed from its endpoint
  const blocks = recordBlocks(s)
  if (blocks.length > 1) {
    const w = i.record?.data?.status === 'available' ? i.record.data : null
    base.blocks = blocks.map((b, k) => {
      const other = k > 0 ? s.other_records?.find((o) => o.source === b.source && (b.name == null || o.name === b.name)) : null
      const fresh = k > 0 && b.source === 'wfigs' && w?.current ? w.current : null
      return {
        source: b.source,
        issuer: other ? otherRecordIssuerLabel(other) : b.issuer,
        name: b.name,
        isActive: fresh ? fresh.is_active : b.is_active,
        updatedMs: fresh?.updated_ms ?? b.updated_ms,
        url: httpsUrl(fresh && w ? w.incident_url : null) ?? httpsUrl(b.url),
      }
    })
    if (cf.state === 'available') base.blocks[0] = { ...base.blocks[0], isActive: cf.isActive ?? base.blocks[0].isActive, updatedMs: cf.updatedMs ?? base.blocks[0].updatedMs }
  }
  return base
}

/** "Active (USFS via NIFC WFIGS, updated Oct 22, 9:05 AM PDT)" / "Not listed as active (CAL FIRE, updated …)". */
export function recordBlockText(b: RecordBlockStatus, tf: TimeFmt): string {
  const when = b.updatedMs != null ? `, updated ${fmtAt(b.updatedMs, tf, { zone: true, year: 'auto' })}` : ''
  return `${b.isActive ? 'Active' : 'Not listed as active'} (${b.name ? `${b.name}: ` : ''}${b.issuer}${when})`
}

export interface RecordFeedContext {
  mode: Mode
  manifest: Pick<IncidentManifest, 'grid' | 'time_range'> | null
  summary: (Pick<IncidentSummary, 'lat' | 'lon' | 'url'> & Partial<Pick<IncidentSummary, 'record_issuer' | 'record_source' | 'calfire_uid' | 'agency' | 'agency_code'>>) | null
  tf?: TimeFmt
}

/**
 * Feed row of a NIFC WFIGS record (kind 'official', topic 'record'): one row with the record's own numbers and its own
 * update time, labelled from the issuer. Its changes are not recorded yet (the endpoint's `changes` is always []).
 */
export function wfigsRecordFeedItems(d: IncidentRecordResponse | null, ctx: RecordFeedContext): FeedItem[] {
  if (!d || d.status !== 'available' || !d.current) return []
  const s = ctx.summary
  const issuer = s ? recordIssuerLabel(s as IncidentSummary) : 'NIFC WFIGS (IRWIN)'
  const c = d.current
  const t = c.updated_ms ?? d.source_updated_ms ?? null
  let location: FeedItem['location'] = null
  if (s && ctx.manifest?.grid && Number.isFinite(s.lat) && Number.isFinite(s.lon)) {
    const [x, z] = lonLatToLocal(s.lon, s.lat, ctx.manifest.grid)
    location = { lon: s.lon, lat: s.lat, x, z }
  }
  const acres = c.acres != null ? `${c.acres.toLocaleString('en-US', { maximumFractionDigits: 1 })} acres` : 'area not stated'
  const pct = c.percent_contained != null ? `${Math.round(c.percent_contained)} % contained` : 'containment not stated'
  return [
    {
      id: `record:wfigs:${d.irwin_id ?? 'record'}`,
      topic: 'record',
      kind: 'official',
      tMs: t ?? d.retrieved_ms ?? d.now_ms,
      title: `${issuer} record: ${acres}, ${pct}${c.is_active ? '' : ', not listed as active'}`,
      detail: `The protecting agency's numbers as published by NIFC WFIGS (IRWIN), with the record's own update time. Fire-3d does not record changes to this record yet.`,
      source: `${issuer} incident record`,
      automated: false,
      key: true,
      confidence: null,
      location,
      seekable: false,
      eventId: null,
      approximate: location != null,
      locationLabel: location ? "The record's reported location" : null,
      original: null,
      facts: [
        { label: `Area (${issuer})`, text: acres, scientific: null },
        { label: 'Containment', text: pct, scientific: null },
        ...(c.discovered_ms != null ? [{ label: 'Discovered', text: fmtWhen(c.discovered_ms, ctx.mode === 'live' ? d.now_ms : undefined, ctx.tf), scientific: null }] : []),
      ],
      url: httpsUrl(d.incident_url),
      issuer,
      issuedMs: null,
      updatedMs: t,
      expiresMs: null,
      checkedMs: d.retrieved_ms,
      status: null,
      timeNotGiven: t == null,
      notes: [t != null ? `${issuer} last updated this record ${fmtWhen(t, undefined, ctx.tf)}.` : 'The record gives no update time.'],
    },
  ]
}
