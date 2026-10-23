// Hover texts of the map that carry official information (owner: us-web; brief 3 CONTRACT §14.5, §14.8.5). Pure, so
// the issuer rules are unit-tested: a fire's record speaks with its own issuer, status and time (another agency's
// differing record gets its own line, never merged into it), and an evacuation zone names the state source it came
// through (Cal OES, Oregon OEM) from the answer's `sources[]`.
import { recordBlocks, recordIssuerLabel } from '../api/records'
import type { IncidentSummary } from '../api/types'
import { aggregatorOf, zoneDetail, zoneSourceId } from '../extras/evacuation'
import type { EvacuationsResponse, EvacZoneFeature } from '../extras/types'
import { area as areaText } from '../lib/plainLanguage'
import { recordBlockText, recordStatus } from '../lib/recordText'
import { fmtAt, type TimeFmt } from '../lib/time'
import { fireWhere } from '../state/overview'
import type { Units } from '../state/workspace'

/** One line of a map hover; `cls` is the tooltip's line class ("fxm-tip-title", "fxm-tip-hint"). */
export interface HoverLine {
  text: string
  cls?: string
}

/** A fire's agency record as hover lines, in the fire's own zone (`tf`): the place, "CAL FIRE (official): 25,352 ac ·
 *  97 % contained · Not listed as active" with the record's own status (never the merged listing's), its update time,
 *  then each other agency record whose active status differs, with its own issuer and time ("Timber: Active (USFS via
 *  NIFC WFIGS, updated …)"). Dates carry the year when it is not `nowMs`'s. */
export function recordHoverLines(s: IncidentSummary, units: Units, tf: TimeFmt, nowMs: number = Date.now()): HoverLine[] {
  const out: HoverLine[] = []
  const where = fireWhere(s)
  if (where) out.push({ text: where })
  const parts = [s.acres != null ? areaText(s.acres, units).text : 'size not reported']
  if (s.percent_contained != null) parts.push(`${Math.round(s.percent_contained)} % contained`)
  parts.push(recordStatus(s).label)
  out.push({ text: `${recordIssuerLabel(s)} (official): ${parts.join(' · ')}` })
  // the year when it is not this year's (a 2024 record never reads like a recent one)
  if (s.updated_ms) out.push({ text: `Updated ${fmtAt(s.updated_ms, tf, { zone: true, year: 'auto', refMs: nowMs })}`, cls: 'fxm-tip-hint' })
  for (const b of recordBlocks(s).slice(1)) out.push({ text: `${b.name ? `${b.name}: ` : ''}${recordBlockText(b, tf, nowMs)}` })
  return out
}

/** An evacuation zone's hover lines: the official status, the zone, its jurisdiction and own time, and the state source
 *  it came through, named from the answer's `sources[]` (§14.8.5: "via Cal OES", "via Oregon OEM"). */
export function zoneHoverLines(zone: EvacZoneFeature, data: Pick<EvacuationsResponse, 'sources'> | null, nowMs: number, tf: TimeFmt): HoverLine[] {
  const d = zoneDetail(zone, nowMs, tf)
  const via = aggregatorOf(data, zoneSourceId(zone.properties))
  return [
    { text: d.status, cls: 'fxm-tip-title' },
    { text: d.title },
    { text: `${d.jurisdiction} · ${d.updatedText}` },
    { text: `Official status from local officials via ${via}. Fire-3d forecasts are not evacuation instructions.`, cls: 'fxm-tip-hint' },
  ]
}
