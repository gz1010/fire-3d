// Display text for a fire's agency record (brief 3, CONTRACT §14.5) that is not the shared issuer / disagreement rule
// (those live in api/records.ts: recordIssuerLabel, recordBlocks, which this file never re-implements).
import type { IncidentSummary } from '../api/types'

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
