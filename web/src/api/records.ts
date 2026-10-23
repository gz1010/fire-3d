// Shared fire-record helpers (brief 3, CONTRACT 14.5). Both web roles import these, so the issuer label and the
// disagreement rule are written once:
// - recordIssuerLabel: who published a fire's record ("CAL FIRE", "USFS (USDA Forest Service) via NIFC WFIGS").
// - recordBlocks: the fire's own record first, then every other agency record whose active status differs from it
//   (round 3 item 2: a California fire is active when either agency says so, and the card shows each record with its
//   own issuer, status and time). A complex member keeps its own name; no member ever stands in for the complex.
import type { IncidentSummary, OtherRecord, RecordSource } from './types'

/** One agency record of a fire, as the fire card and the official panels show it. */
export interface RecordBlock {
  source: RecordSource
  issuer: string // the issuer label (recordIssuerLabel rules)
  name: string | null // the record's own name, verbatim; null for the row's own record (its name is the heading)
  is_active: boolean // that agency's own active status
  updated_ms: number | null // that record's own update time
  url: string | null // that record's page (https), null when unknown
}

/** "USFS (USDA Forest Service) via NIFC WFIGS": the issuer with the plain agency name added after the verbatim code,
 *  when the name is known and says more than the code. Anything else is returned unchanged. */
function withAgencyName(issuer: string, code: string | null | undefined, agency: string | null | undefined): string {
  if (!code || !agency || agency.trim() === '' || agency.trim().toUpperCase() === code.trim().toUpperCase()) return issuer
  const prefix = `${code} via `
  return issuer.startsWith(prefix) ? `${code} (${agency})${issuer.slice(code.length)}` : issuer
}

/** The issuer label of a fire's own record (CONTRACT 14.5): `record_issuer` with the plain agency name added when
 *  known ("USFS (USDA Forest Service) via NIFC WFIGS"; "CAL FIRE"; "NIFC WFIGS (IRWIN)"). Old fixtures without
 *  `record_issuer` read "CAL FIRE" only when `calfire_uid` is non-empty, else "Agency record". */
export function recordIssuerLabel(summary: IncidentSummary): string {
  const issuer = summary.record_issuer?.trim()
  if (!issuer) return summary.calfire_uid?.trim() ? 'CAL FIRE' : 'Agency record'
  if ((summary.record_source ?? 'calfire') !== 'wfigs') return issuer
  return withAgencyName(issuer, summary.agency_code, summary.agency)
}

/** The issuer label of another agency's record (an `other_records` entry), by the same rule. */
export function otherRecordIssuerLabel(rec: OtherRecord): string {
  const issuer = rec.issuer?.trim() || (rec.source === 'calfire' ? 'CAL FIRE' : 'NIFC WFIGS (IRWIN)')
  return rec.source === 'wfigs' ? withAgencyName(issuer, rec.agency_code, rec.agency) : issuer
}

/** Whether the fire's own record calls it active: `active_sources.includes(record_source)`; old fixtures without
 *  `active_sources` use `is_active`. */
export function ownRecordActive(summary: IncidentSummary): boolean {
  const own: RecordSource = summary.record_source ?? 'calfire'
  return summary.active_sources ? summary.active_sources.includes(own) : summary.is_active
}

/** The fire's records to show (CONTRACT 14.5): its own record first, then every `other_records` entry whose
 *  `is_active` differs from it (a complex member keeps its `name`). One block when the agencies agree. */
export function recordBlocks(summary: IncidentSummary): RecordBlock[] {
  const own: RecordBlock = {
    source: summary.record_source ?? 'calfire',
    issuer: recordIssuerLabel(summary),
    name: null,
    is_active: ownRecordActive(summary),
    updated_ms: summary.updated_ms ?? null,
    url: summary.url ?? null,
  }
  const others = (summary.other_records ?? [])
    .filter((o) => o.is_active !== own.is_active)
    .map<RecordBlock>((o) => ({
      source: o.source,
      issuer: otherRecordIssuerLabel(o),
      name: o.name ?? null,
      is_active: o.is_active,
      updated_ms: o.updated_ms ?? null,
      url: o.url ?? null,
    }))
  return [own, ...others]
}
