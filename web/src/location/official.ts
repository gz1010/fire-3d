// The location card's official block (owner: location; brief 2 C-R7). Pure. It words the I5 answers of
// useOfficialAtPoint (official-web, web/src/official/hooks.ts) for the card: always at least one evacuation line, in
// every state (listed / none listed where checked / not checked here / past date / unavailable / loading), on phones,
// in replay and with the map layer off; an NWS line only while an alert is in effect or upcoming at the point; and
// "Follow local officials" with the CAL FIRE incident page and Cal OES. Official wording stays verbatim, with its
// issuer and its own times; Fire-3d's fetch time is only ever called "checked". Nothing here is an all-clear.
import type { CalFireOfficial, EvacuationOfficial, FireWeatherOfficial, OfficialAlert, OfficialInfo, OfficialZone } from '../official/hooks'
import { area, distance } from '../lib/plainLanguage'
import { fmtDateTime, fmtRelative, tzLabel } from '../lib/time'
import type { Units } from '../state/workspace'

export type OfficialTone = 'order' | 'warning' | 'other' | 'quiet' | 'unknown' | 'loading'

export interface OfficialLine {
  key: string
  /** Official wording verbatim (zone status, NWS event), or Fire-3d's plain statement about the check. */
  text: string
  /** Issuer, times, distance, caveat. */
  sub: string | null
  /** What must stay on a phone's short card too (a zone's issuer and own time, "not an all-clear", the NWS caveat),
   *  else null. */
  subCompact: string | null
  /** The line quotes an official source (shown as an "Official" tag). */
  official: boolean
  tone: OfficialTone
  /** The source's own page for this item (https). */
  url: string | null
}

export interface OfficialLink {
  label: string
  url: string
}

export interface OfficialBlock {
  /** Always at least one line. */
  evacuation: OfficialLine[]
  /** Fire weather alerts in effect or upcoming at the point (empty otherwise: no "none" line in the card). */
  fireWeather: OfficialLine[]
  /** "Follow local officials." */
  follow: string
  links: OfficialLink[]
  /** More zones than shown. */
  moreZones: number
}

export interface OfficialContext {
  nowMs: number
  units: Units
  /** The open fire ("the Eaton Fire") for distances; null on the overview. */
  fireName: string | null
  /** CAL FIRE incident page from the incident summary (when the CAL FIRE answer has none). */
  incidentUrl: string | null
  /** Zones shown before "+N more". */
  maxZones?: number
}

const CAL_OES_FALLBACK = 'https://gis.data.ca.gov/datasets/CalEMA::california-evacuation-aggregation-layer'
const at = (ms: number) => `${fmtDateTime(ms)} ${tzLabel(ms)}`
const https = (u: string | null | undefined) => (u && /^https:\/\//i.test(u) ? u : null)

/** "Follow local officials." is said once, in its own line: drop it from a caveat. */
export function withoutFollow(s: string | null | undefined): string | null {
  if (!s) return null
  const t = s
    .replace(/:\s*follow local officials\.?\s*$/i, '.')
    .replace(/\s*Follow local officials\.?\s*$/i, '')
    .trim()
  return t || null
}

function zoneLine(z: OfficialZone, c: OfficialContext): OfficialLine {
  const when = z.updatedMs != null ? `updated ${at(z.updatedMs)}` : z.listedMs != null ? `issuer time not given; listed by Cal OES ${at(z.listedMs)}` : 'issuer time not given'
  const far =
    z.outsideAnalysisArea && c.fireName
      ? `${z.distanceKm != null ? `${distance(z.distanceKm * 1000, c.units).text} from ${c.fireName}; ` : ''}Cal OES does not say which fire this is for`
      : null
  // phones keep the issuer, the source's own time and, for a zone away from the fire, that Cal OES does not name the fire
  const whenShort = z.updatedMs != null ? `updated ${at(z.updatedMs)}` : z.listedMs != null ? `listed by Cal OES ${at(z.listedMs)}` : null
  return {
    key: `zone-${z.id}`,
    text: z.status,
    sub: [z.issuer, when, far].filter(Boolean).join(' · '),
    subCompact: [z.issuer, whenShort, far].filter(Boolean).join(' · ') || null,
    official: true,
    tone: z.group === 'order' ? 'order' : z.group === 'warning' ? 'warning' : 'other',
    url: null,
  }
}

function evacuationLines(e: EvacuationOfficial, c: OfficialContext): OfficialLine[] {
  const checked = e.checkedMs != null ? `checked ${fmtRelative(e.checkedMs, c.nowMs)}` : null
  switch (e.state) {
    case 'listed':
      return e.zones.slice(0, c.maxZones ?? 2).map((z) => zoneLine(z, c))
    case 'none-listed':
      return [
        { key: 'evac-none', text: 'No evacuation order or warning listed here', sub: `Cal OES${checked ? `, ${checked}` : ''} · not an all-clear`, subCompact: 'Cal OES · not an all-clear', official: true, tone: 'quiet', url: null },
      ]
    case 'not-checked':
      return [
        {
          key: 'evac-unchecked',
          text: 'Evacuation zones: not checked here',
          sub: withoutFollow(e.reason)?.replace(/^Not checked here:\s*/i, '') ?? 'Fire-3d reads Cal OES zones only near the open fire and the selected point.',
          subCompact: null,
          official: false,
          tone: 'unknown',
          url: null,
        },
      ]
    case 'past-date':
      return [{ key: 'evac-past', text: 'Evacuation orders: not shown for past dates', sub: null, subCompact: null, official: false, tone: 'unknown', url: null }]
    case 'unavailable':
      return [{ key: 'evac-unavailable', text: 'Evacuation zones: unavailable right now', sub: withoutFollow(e.reason) ?? null, subCompact: null, official: false, tone: 'unknown', url: null }]
    case 'loading':
      return [{ key: 'evac-loading', text: 'Checking official evacuation zones…', sub: null, subCompact: null, official: false, tone: 'loading', url: null }]
  }
}

/** NWS alerts in effect (or starting soon) at the point, worded "Fire weather alert here: Red Flag Warning". */
export function alertsInEffect(fw: FireWeatherOfficial): OfficialAlert[] {
  if (fw.state !== 'active') return []
  return fw.alerts.filter((a) => a.phase === 'active' || a.phase === 'upcoming')
}

/** "National Weather Service Los Angeles/Oxnard CA" -> "NWS Los Angeles/Oxnard CA". */
const shortSender = (s: string) => s.replace(/^National Weather Service\b\s*/i, 'NWS ').trim()

function alertLine(a: OfficialAlert, fw: FireWeatherOfficial): OfficialLine {
  // the issuer, the archive label and the caveat stay on phones too (official items keep their issuer)
  const sub = [shortSender(a.senderName), a.archived || fw.archived ? 'archived copy' : null, 'a weather warning, not an evacuation order'].filter(Boolean).join(' · ')
  return {
    key: `nws-${a.id}`,
    text: `${a.phase === 'upcoming' ? 'Fire weather alert starting here' : 'Fire weather alert here'}: ${a.event} ${a.timeText}`.trim(),
    sub,
    subCompact: sub,
    official: true,
    tone: 'warning',
    url: https(a.url),
  }
}

function calfireUrl(cf: CalFireOfficial, fallback: string | null): string | null {
  return https(cf.url) ?? https(fallback)
}

export function officialBlock(info: OfficialInfo, c: OfficialContext): OfficialBlock {
  const evacuation = evacuationLines(info.evacuation, c)
  const fireWeather = alertsInEffect(info.fireWeather).map((a) => alertLine(a, info.fireWeather))
  const links: OfficialLink[] = []
  const cf = calfireUrl(info.calfire, c.incidentUrl)
  if (cf) links.push({ label: 'CAL FIRE', url: cf })
  links.push({ label: 'Cal OES', url: https(info.evacuation.sourceUrl) ?? CAL_OES_FALLBACK })
  for (const l of info.evacuation.links ?? []) if (https(l.url) && !links.some((x) => x.url === l.url)) links.push({ label: l.label, url: l.url })
  const shown = info.evacuation.state === 'listed' ? Math.min(info.evacuation.zones.length, c.maxZones ?? 2) : 0
  return {
    evacuation: evacuation.length ? evacuation : [{ key: 'evac-unknown', text: 'Official evacuation status: unknown here', sub: null, subCompact: null, official: false, tone: 'unknown', url: null }],
    fireWeather,
    follow: 'Follow local officials.',
    links,
    moreZones: info.evacuation.state === 'listed' ? info.evacuation.zones.length - shown : 0,
  }
}

/** The dryness reason may cite an official threshold: the Red Flag Warning (or Fire Weather Watch) in effect here. */
export function officialFireWeatherNote(fw: FireWeatherOfficial): string | null {
  const a = alertsInEffect(fw).find((x) => x.phase === 'active')
  return a ? `NWS ${a.event} in effect` : null
}

/** CAL FIRE's own record, one line ("CAL FIRE: 14,021 acres, 100% contained · updated Jan 31, 2025, 10:48 PST"). */
export function calfireLine(cf: CalFireOfficial, units: Units): string | null {
  if (cf.state !== 'available') return null
  const parts = [cf.acres != null ? area(cf.acres, units).text : null, cf.percentContained != null ? `${Math.round(cf.percentContained)}% contained` : null]
  const facts = parts.filter(Boolean).join(', ')
  return facts ? `CAL FIRE: ${facts}${cf.updatedMs != null ? ` · updated ${at(cf.updatedMs)}` : ''}` : null
}
