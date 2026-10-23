// Display text for a fire's agency record (brief 3, CONTRACT §14.5) that is not the shared issuer / disagreement rule
// (those live in api/records.ts: recordIssuerLabel, recordBlocks, which this file never re-implements).
import type { RecordBlock } from '../api/records'
import type { IncidentSummary } from '../api/types'
import { fmtAt, type TimeFmt } from './time'

/** Which agency's identifier a summary carries: CAL FIRE's UniqueId or NIFC WFIGS's IRWIN id. */
export function agencyIdSource(s: Pick<IncidentSummary, 'record_source'>): 'CAL FIRE' | 'NIFC WFIGS' {
  return (s.record_source ?? 'calfire') === 'wfigs' ? 'NIFC WFIGS' : 'CAL FIRE'
}

/** The agency's own incident identifier ('' when the row has none). */
export function agencyId(s: Pick<IncidentSummary, 'record_source' | 'uid' | 'calfire_uid' | 'irwin_id'>): string {
  if ((s.record_source ?? 'calfire') === 'wfigs') return (s.uid || s.irwin_id || '').trim()
  return (s.uid || s.calfire_uid || '').trim()
}

/** "Incident ID (CAL FIRE): <UniqueId>" / "Incident ID (NIFC WFIGS): <IRWIN id>" (§14.5), or null without an id. */
export function agencyIdLine(s: Pick<IncidentSummary, 'record_source' | 'uid' | 'calfire_uid' | 'irwin_id'>): string | null {
  const id = agencyId(s)
  return id ? `Incident ID (${agencyIdSource(s)}): ${id}` : null
}

/** An https link (records and pages are linked only over https). */
export const isHttps = (u: string | null | undefined): u is string => typeof u === 'string' && /^https:\/\//.test(u)

/** "Active (NIFC WFIGS, updated Oct 22, 9:05 AM PDT)" / "Not listed as active (CAL FIRE, updated …)": one agency's own
 *  status with its issuer and its own time, in the fire's zone (§14.5, the Timber Fire case). */
export function recordBlockText(b: RecordBlock, tf: TimeFmt, refMs?: number): string {
  const when = b.updated_ms != null ? `updated ${fmtAt(b.updated_ms, tf, { zone: true, year: 'auto', refMs })}` : 'no update time given'
  return `${b.is_active ? 'Active' : 'Not listed as active'} (${b.issuer}, ${when})`
}

/** A CAL FIRE complex's member names (NIFC WFIGS names, verbatim), each with its own record link (its `other_records`
 *  entry, matched by name); a member's numbers never stand in for the complex's (§14.2, §14.5). */
export function complexMembers(fire: Pick<IncidentSummary, 'complex_members' | 'other_records'>): { name: string; url: string | null }[] {
  const recs = fire.other_records ?? []
  return (fire.complex_members ?? []).map((name) => {
    const r = recs.find((o) => o.name === name) ?? recs.find((o) => o.name.trim().toLowerCase() === name.trim().toLowerCase())
    return { name, url: r && isHttps(r.url) ? r.url : null }
  })
}

/** "Part of the Montana Lightning Complex" (§14.5): the WFIGS complex name verbatim, "Complex" added only when the name
 *  does not already say it. */
export function partOfComplex(name: string): string {
  const n = name.trim()
  return /\bcomplex$/i.test(n) ? `Part of the ${n}` : `Part of the ${n} Complex`
}
