// Display text for a fire's agency record (brief 3, CONTRACT §14.5) that is not the shared issuer / disagreement rule
// (those live in api/records.ts: recordIssuerLabel, recordBlocks, which this file never re-implements).
import { otherRecordIssuerLabel, ownRecordActive, recordIssuerLabel, type RecordBlock } from '../api/records'
import type { IncidentSummary } from '../api/types'
import { fireStatus, type FireStatusKey } from '../state/overview'
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

/** The status of the fire's own record (§14.5, round 3 item 2): that agency's own active flag (`ownRecordActive`),
 *  never the merged listing's (Fire-3d lists a fire as active when either agency does). A record that is not active
 *  reads "Contained" at 100 % or with a containment date; when another agency still lists the fire as active it reads
 *  "Not listed as active" (the agency said no more than that), else the listing's word ("Out"). */
export function recordStatus(s: IncidentSummary): { key: FireStatusKey; label: string; ownActive: boolean } {
  const ownActive = ownRecordActive(s)
  if (ownActive) return { ...fireStatus(s), ownActive }
  if ((s.percent_contained ?? 0) >= 100 || s.contained_ms != null) return { key: 'contained', label: 'Contained', ownActive }
  // the merged row is active only because another agency lists the fire: this agency's record says no more than that
  if (s.mode === 'live' || s.is_active) return { key: 'out', label: 'Not listed as active', ownActive }
  return { ...fireStatus(s), ownActive }
}

/** What a summary's `contained_ms` is ("contained", "controlled", "declared out"; §14.17), or null when no date may be
 *  shown: none given, or an older NIFC WFIGS summary without `contained_kind`, whose date may be its control or
 *  fire-out time (a fire-out date is never shown as the containment date). CAL FIRE's date is its containment date. */
export function containedLabel(s: Pick<IncidentSummary, 'contained_ms' | 'contained_kind' | 'record_source'>): 'contained' | 'controlled' | 'declared out' | null {
  if (s.contained_ms == null || !Number.isFinite(s.contained_ms)) return null
  const kind = s.contained_kind ?? ((s.record_source ?? 'calfire') === 'calfire' ? 'contained' : null)
  return kind === 'contained' ? 'contained' : kind === 'controlled' ? 'controlled' : kind === 'out' ? 'declared out' : null
}

/** Whether the fire's record section shows a plain agency name that Fire-3d added after an agency code
 *  ("USFS (USDA Forest Service) via NIFC WFIGS"), from the NWCG unit identifiers (credited next to it, §14.13): in the
 *  fire's own issuer label, or in another agency's record shown because it disagrees (the `recordBlocks` rule). */
export function agencyNameShown(fire: IncidentSummary): boolean {
  if (recordIssuerLabel(fire) !== recordIssuerLabel({ ...fire, agency: null })) return true
  const own = ownRecordActive(fire)
  return (fire.other_records ?? []).some((o) => o.is_active !== own && otherRecordIssuerLabel(o) !== otherRecordIssuerLabel({ ...o, agency: null }))
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
