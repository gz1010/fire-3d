// The location card's official block (owner: us-official in brief 3; brief 2 C-R7). Pure. It words the I5 answers of
// useOfficialAtPoint (web/src/official/hooks.ts) for the card: always at least one evacuation line, in every state
// (listed / none listed where checked / not checked here / not available in this state / past date / unavailable /
// loading), on phones, in replay and with the map layer off; an NWS line only while an alert is in effect or upcoming
// at the point; and "Follow local officials" with the fire's agency record and the state evacuation source's page.
// Issuer, aggregator ("Cal OES", "Oregon OEM") and times come from the answer's sources. Official wording stays
// verbatim, with its issuer and its own times (Oregon's levels are flagged as Fire-3d's wording of OEM's level number,
// with OEM's definition); Fire-3d's fetch time is only ever called "checked". Nothing here is an all-clear.
import type { CalFireOfficial, EvacuationOfficial, FireWeatherOfficial, OfficialAlert, OfficialInfo, OfficialZone } from '../official/hooks'
import { area, distance } from '../lib/plainLanguage'
import { fmtAt, fmtRelative, type TimeFmt } from '../lib/time'
import { getTimeFormat } from '../state/timeZone'
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
  /** Zone and clock of the times (the fire's zone, else the point's; CONTRACT §14.9.6). Default `getTimeFormat()`. */
  tf?: TimeFmt
}

const CAL_OES_FALLBACK = 'https://gis.data.ca.gov/datasets/CalEMA::california-evacuation-aggregation-layer'

/** Links to the evacuation sources of the answer ("Cal OES", "Oregon OEM"); a brief-2 answer: Cal OES. */
function evacuationLinks(e: EvacuationOfficial): OfficialLink[] {
  if (e.state === 'not-available') return []
  const srcs = (e.sources ?? []).filter((s) => https(s.url))
  if (srcs.length) return srcs.map((s) => ({ label: s.aggregator, url: s.url as string }))
  // a brief-2 answer (no sources[]): its data page is Cal OES's
  const url = https(e.sourceUrl)
  return url ? [{ label: url === CAL_OES_FALLBACK ? 'Cal OES' : 'Evacuation zones source', url }] : []
}
const at = (ms: number, tf: TimeFmt) => fmtAt(ms, tf, { zone: true })
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

function zoneLine(z: OfficialZone, c: OfficialContext & { tf: TimeFmt }): OfficialLine {
  const agg = z.aggregator ?? 'Cal OES'
  const listed = z.listedPhrase ?? `listed by ${agg}`
  const when = z.updatedMs != null ? `updated ${at(z.updatedMs, c.tf)}` : z.listedMs != null ? `issuer time not given; ${listed} ${at(z.listedMs, c.tf)}` : 'issuer time not given'
  const far =
    z.outsideAnalysisArea && c.fireName
      ? `${z.distanceKm != null ? `${distance(z.distanceKm * 1000, c.units).text} from ${c.fireName}; ` : ''}${agg} does not say which fire this is for`
      : null
  // Oregon: "Level 3" is Fire-3d's wording of OEM's level number; OEM's definition is the line's text
  const level = z.verbatim === false ? `${agg} level; definition by ${agg}` : null
  // phones keep the issuer, the source's own time and, for a zone away from the fire, that the source does not name the fire
  const whenShort = z.updatedMs != null ? `updated ${at(z.updatedMs, c.tf)}` : z.listedMs != null ? `${listed} ${at(z.listedMs, c.tf)}` : null
  return {
    key: `zone-${z.id}`,
    text: z.status,
    sub: [z.issuer, level, when, far, z.hazardNote, z.incidentNote].filter(Boolean).join(' · '),
    subCompact: [z.issuer, level, whenShort, far].filter(Boolean).join(' · ') || null,
    official: true,
    tone: z.group === 'order' ? 'order' : z.group === 'warning' ? 'warning' : 'other',
    url: null,
  }
}

function evacuationLines(e: EvacuationOfficial, c: OfficialContext & { tf: TimeFmt }): OfficialLine[] {
  const checked = e.checkedMs != null ? `checked ${fmtRelative(e.checkedMs, c.nowMs)}` : null
  switch (e.state) {
    case 'listed':
      return e.zones.slice(0, c.maxZones ?? 2).map((z) => zoneLine(z, c))
    case 'none-listed': {
      // CONTRACT §14.8.5: "No evacuation order or warning listed here · {Oregon OEM}, checked {time} · not an all-clear"
      const who = e.checkedBy ?? 'Cal OES'
      return [
        { key: 'evac-none', text: 'No evacuation order or warning listed here', sub: `${who}${checked ? `, ${checked}` : ''} · not an all-clear`, subCompact: `${who} · not an all-clear`, official: true, tone: 'quiet', url: null },
      ]
    }
    case 'not-checked':
      return [
        {
          key: 'evac-unchecked',
          text: 'Evacuation zones: not checked here',
          sub: withoutFollow(e.reason)?.replace(/^Not checked here:\s*/i, '') ?? 'Fire-3d reads official evacuation zones only near the open fire and the selected point.',
          subCompact: null,
          official: false,
          tone: 'unknown',
          url: null,
        },
      ]
    case 'not-available':
      // CONTRACT §14.14 short form; the reason names the state ("Not available in this state (Nevada)"); outside the
      // lower 48 the backend's coverage sentence
      return [
        {
          key: 'evac-not-available',
          text: e.notAvailableIn && e.notAvailableIn.length === 0 && e.reason && !/state/i.test(e.reason) ? 'Evacuation zones: not available here' : 'Evacuation zones: not available in this state',
          sub: withoutFollow(e.reason) ?? null,
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

export function officialBlock(info: OfficialInfo, ctx: OfficialContext): OfficialBlock {
  const c = { ...ctx, tf: ctx.tf ?? getTimeFormat() }
  const evacuation = evacuationLines(info.evacuation, c)
  const fireWeather = alertsInEffect(info.fireWeather).map((a) => alertLine(a, info.fireWeather))
  const links: OfficialLink[] = []
  const cf = calfireUrl(info.calfire, c.incidentUrl)
  // the fire's agency record, labelled from its publisher ("CAL FIRE", "NIFC WFIGS"; CONTRACT §14.5)
  if (cf) links.push({ label: info.calfire.linkLabel && info.calfire.linkLabel !== 'Agency record' ? info.calfire.linkLabel : 'CAL FIRE', url: cf })
  // the state evacuation source(s) checked here; none for a state without a feed (never a Cal OES link outside California)
  for (const s of evacuationLinks(info.evacuation)) if (!links.some((x) => x.url === s.url)) links.push(s)
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

/** The dryness reason may cite an official threshold: the Red Flag Warning (or Fire Weather Watch) in effect here.
 *  `tf` (CONTRACT §14.9.6) is accepted for the shared signature; the note has no time in it today. */
export function officialFireWeatherNote(fw: FireWeatherOfficial, _tf?: TimeFmt): string | null {
  const a = alertsInEffect(fw).find((x) => x.phase === 'active')
  return a ? `NWS ${a.event} in effect` : null
}

/** The fire's agency record, one line ("CAL FIRE: 14,021 acres, 100% contained · updated Jan 31, 2025, 10:48 PST";
 *  "USFS (USDA Forest Service) via NIFC WFIGS: …"), labelled from the issuer. */
export function calfireLine(cf: CalFireOfficial, units: Units, tf: TimeFmt = getTimeFormat()): string | null {
  if (cf.state !== 'available') return null
  const issuer = cf.issuer && cf.issuer !== 'Agency record' ? cf.issuer : 'CAL FIRE'
  const parts = [cf.acres != null ? area(cf.acres, units).text : null, cf.percentContained != null ? `${Math.round(cf.percentContained)}% contained` : null]
  const facts = parts.filter(Boolean).join(', ')
  return facts ? `${issuer}: ${facts}${cf.updatedMs != null ? ` · updated ${at(cf.updatedMs, tf)}` : ''}` : null
}
