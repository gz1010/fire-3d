// Public's short "Official now" (owner: shell; brief 2 U-R3 / C-R9 / §4 "short summaries first, details on demand").
// On a desktop Public view the updates panel opens on three short official statuses (evacuations, CAL FIRE, fire
// weather) built from the same useOfficialNow() data as official-web's full block, which is one click away
// (OfficialNow.tsx, mounted at the top of the expanded panel, in Command and on phones). Statuses are the issuers'
// own words (zone status, NWS event), each line names its issuer, and every quiet state says it is not an all-clear.
// Pure (officialSummary.test.ts).
import { DEFAULT_MARGIN_KM } from '../../extras/client'
import { fmtWhen } from '../../extras/format'
import { distanceText } from '../../official/geo'
import { evacuationWho, groupZones, type CalFireOfficial, type EvacuationOfficial, type FireWeatherOfficial } from '../../official/model'
import { fmtAcres, fmtNumber } from '../../lib/format'
import { fmtAt, type TimeFmt } from '../../lib/time'
import { getTimeFormat } from '../../state/timeZone'

export type SummaryTone = 'order' | 'warning' | 'alert' | 'quiet' | 'muted'

export interface SummaryLine {
  key: 'evacuation' | 'calfire' | 'fire-weather'
  label: string
  text: string
  /** The issuer, shown after the text; null when the label already names it (CAL FIRE). */
  source: string | null
  tone: SummaryTone
}

/** The standing line under every official block (BRIEF-2: model output is never an evacuation order). */
export const SUMMARY_NOT_AN_ORDER = "Fire-3d's modeled spread is experimental and is not an evacuation order. Follow local officials."

export function evacuationLine(e: EvacuationOfficial, metric: boolean): SummaryLine {
  const base = { key: 'evacuation' as const, label: 'Evacuations', source: evacuationWho(e) }
  switch (e.state) {
    case 'loading':
      return { ...base, text: 'Checking…', tone: 'muted' }
    case 'past-date':
      return { ...base, text: 'Not available for past dates.', tone: 'muted' }
    case 'unavailable':
      return { ...base, text: 'Unavailable right now.', tone: 'muted' }
    case 'not-checked':
      return { ...base, text: 'Not checked.', tone: 'muted' }
    case 'not-available':
      return { ...base, source: null, text: 'Not available in this state.', tone: 'muted' }
    case 'none-listed':
      return { ...base, text: `None listed within ${DEFAULT_MARGIN_KM.evacuations} km. Not an all-clear.`, tone: 'quiet' }
    default: {
      const groups = groupZones(e.zones)
      const g = groups[0]
      if (!g) return { ...base, text: 'Listed near this fire.', tone: 'warning' }
      const where = g.distanceKm == null ? null : g.distanceKm === 0 ? 'touches the fire area' : `${distanceText(g.distanceKm, metric)} away`
      const more = groups.length > 1 ? ` · +${groups.length - 1} more` : ''
      return {
        ...base,
        source: g.issuer,
        text: `${g.status} · ${g.zones.length} zone${g.zones.length === 1 ? '' : 's'}${where ? `, ${where}` : ''}${more}`,
        tone: g.group === 'order' ? 'order' : g.group === 'warning' ? 'warning' : 'alert',
      }
    }
  }
}

export function calfireLine(c: CalFireOfficial, nowMs: number, tf?: TimeFmt): SummaryLine {
  // labelled from the record's issuer (CONTRACT §14.5): "CAL FIRE", "USFS (USDA Forest Service) via NIFC WFIGS"
  const base = { key: 'calfire' as const, label: c.issuer && c.issuer !== 'Agency record' ? c.issuer : 'Agency record', source: null }
  if (c.state === 'loading') return { ...base, text: 'Checking…', tone: 'muted' }
  if (c.synthetic) return { ...base, text: 'Not available: synthetic or local data.', tone: 'muted' }
  if (c.notChecked) return { ...base, text: 'Agency record not checked.', tone: 'muted' }
  // an outage is not "no record": say it could not be checked
  if (c.state === 'unavailable') return { ...base, text: c.unreachable ? 'Unavailable right now.' : 'No record for this fire.', tone: 'muted' }
  const parts = [
    c.acres != null ? fmtAcres(c.acres) : null,
    c.percentContained != null ? `${fmtNumber(c.percentContained)}% contained` : null,
    c.isActive !== true && c.final ? 'final record' : null,
    c.blocks && c.blocks.length > 1 ? 'the agencies differ on whether it is active' : null,
    // a record that is no longer active is often read in a replay of another year: its update time always carries the
    // year (as the Command row does), so "updated Apr 9" is never taken for the replay's year (integration)
    c.updatedMs != null ? `updated ${c.isActive === true ? fmtWhen(c.updatedMs, nowMs, tf) : fmtAt(c.updatedMs, tf ?? getTimeFormat(), { zone: true, year: 'always' })}` : null,
  ].filter(Boolean)
  return { ...base, text: parts.length ? parts.join(' · ') : 'Record without size or containment.', tone: 'quiet' }
}

export function fireWeatherLine(f: FireWeatherOfficial): SummaryLine {
  const base = { key: 'fire-weather' as const, label: 'Fire weather', source: f.archived ? 'NWS, archived' : 'NWS' }
  switch (f.state) {
    case 'loading':
      return { ...base, text: 'Checking…', tone: 'muted' }
    case 'past-date':
      return { ...base, text: 'Not available for this time.', tone: 'muted' }
    case 'unavailable':
      return { ...base, text: 'Unavailable right now.', tone: 'muted' }
    case 'none':
      return { ...base, text: 'No Red Flag Warning or Fire Weather Watch. Not an all-clear.', tone: 'quiet' }
    default: {
      const live = f.alerts.filter((a) => a.phase === 'active' || a.phase === 'upcoming')
      const a = live[0] ?? f.alerts[0]
      if (!a) return { ...base, text: 'An alert is in effect.', tone: 'alert' }
      const more = live.length > 1 ? ` · +${live.length - 1} more` : ''
      const sender = a.senderName ? a.senderName.replace(/^National Weather Service\b/, 'NWS') : 'NWS'
      return { ...base, source: f.archived ? `${sender}, archived copy` : sender, text: `${a.event} ${a.timeText}${more}`.trim(), tone: 'alert' }
    }
  }
}

export function officialSummary(info: { evacuation: EvacuationOfficial; calfire: CalFireOfficial; fireWeather: FireWeatherOfficial }, nowMs: number, metric: boolean, tf?: TimeFmt): SummaryLine[] {
  return [evacuationLine(info.evacuation, metric), calfireLine(info.calfire, nowMs, tf), fireWeatherLine(info.fireWeather)]
}
