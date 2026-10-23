// The location card's official block (owner: us-official in brief 3; brief 2 C-R7). Pure. It words the I5 answers of
// useOfficialAtPoint (web/src/official/hooks.ts) for the card: always at least one evacuation line, in every state
// (listed / none listed where checked / not checked here / not available in this state / past date / unavailable /
// loading), on phones, in replay and with the map layer off; always the NWS status at the point (the alerts in effect,
// "checked, none in effect here" or "not checked here"; brief 3), then the local officials' alerts relayed by NWS or
// archived by FEMA; and "Follow local officials" with the fire's agency record and the state evacuation source's page.
// Issuer, aggregator ("Cal OES", "Oregon OEM") and times come from the answer's sources. Official wording stays
// verbatim, with its issuer and its own times (Oregon's levels are flagged as Fire-3d's wording of OEM's level number,
// with OEM's definition); Fire-3d's fetch time is only ever called "checked". Nothing here is an all-clear.
import type { CalFireOfficial, EvacuationOfficial, FireWeatherOfficial, OfficialAlert, OfficialInfo, OfficialZone } from '../official/hooks'
import { area, distance } from '../lib/plainLanguage'
import { fmtAt, fmtRelative, type TimeFmt } from '../lib/time'
import { getTimeFormat } from '../state/timeZone'
import type { Units } from '../state/workspace'
import { ARCHIVE_CREDIT, LOCAL_STANDING_CAVEAT, localAlertPlace, OPENFEMA_NOTICE, sentText, type LocalAlertsOfficial } from '../official/localAlerts'

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
  /** What the link is (brief 3, local alerts): "issuer's link", "source record (NWS)", "source record (FEMA archive)";
   *  renderers that show no label may ignore it. */
  urlLabel?: string
}

export interface OfficialLink {
  label: string
  url: string
}

export interface OfficialBlock {
  /** Always at least one line. */
  evacuation: OfficialLine[]
  /** Brief 3 (CONTRACT §14.6/§14.7): the NWS status line(s) at the point (always one: the alerts in effect, "checked,
   *  none in effect here", or "not checked here"), then the local officials' alert lines (the field name stays until
   *  the integration; us-web's OfficialSection renders the array as it is). */
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
  /** Zone and clock of the times (the fire's zone, else the point's; CONTRACT §14.9.6, required since the
   *  integration). */
  tf: TimeFmt
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
        // phones keep the check time too: "none" means something only with who checked and when
        { key: 'evac-none', text: 'No evacuation order or warning listed here', sub: `${who}${checked ? `, ${checked}` : ''} · not an all-clear`, subCompact: `${who}${checked ? `, ${checked}` : ''} · not an all-clear`, official: true, tone: 'quiet', url: null },
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

/**
 * The NWS status at the point, always (CONTRACT §14.6): the alert lines while one is in effect or upcoming, else
 * "Fire weather alerts (NWS): checked, none in effect here · Not an all-clear", or "… not checked here" where the
 * answer's `states_checked` does not hold the point's state; loading, past times and outages said as such.
 */
export function fireWeatherLines(fw: FireWeatherOfficial): OfficialLine[] {
  const alerts = alertsInEffect(fw)
  if (alerts.length) return alerts.map((a) => alertLine(a, fw))
  const line = (key: string, text: string, sub: string | null, tone: OfficialTone, official = false): OfficialLine => ({ key, text, sub, subCompact: sub, official, tone, url: null })
  switch (fw.state) {
    case 'loading':
      return [line('nws-loading', 'Checking NWS fire weather alerts…', null, 'loading')]
    case 'none':
    case 'active':
      return [line('nws-none', 'Fire weather alerts (NWS): checked, none in effect here', fw.archived ? 'Archived copy · not an all-clear' : 'Not an all-clear', 'quiet', true)]
    case 'past-date':
      return [line('nws-past', 'Fire weather alerts (NWS): not checked for this time', withoutFollow(fw.reason) ?? null, 'unknown')]
    default:
      if (fw.reasonCode === 'not_checked' || fw.reasonCode === 'demo') return [line('nws-unchecked', 'Fire weather alerts (NWS): not checked here', withoutFollow(fw.reason) ?? null, 'unknown')]
      return [line('nws-unavailable', 'Fire weather alerts (NWS): unavailable right now', withoutFollow(fw.reason) ?? null, 'unknown')]
  }
}

/**
 * Local officials' messages at the point (CONTRACT §14.7): "Alert from <issuer>: "<verbatim text>" · sent <time> ·
 * relayed by the National Weather Service", archived "Archived alert from <issuer> … (FEMA archive)" with the OpenFEMA
 * notice; every line links (the issuer's own link, else the record it was read from) and says where the message's
 * area lies, on phones too ("area covers this point", "area 0.2 mi from this point · may be about another fire";
 * review round 1, R1: useOfficialAtPoint measures from the point and keeps the messages whose area reaches it). None:
 * "Local officials' alerts relayed by NWS: none here · not an all-clear" with the standing caveat (and how many of the
 * fire's messages are for other places, or, for the live box answer, how many nearby ones are for a neighbouring
 * county: review round 2, N3); endpoint missing or failed, outside the lower 48 or the point's state unknown: "Local
 * officials' alerts: not checked", never "none" (N2).
 */
export function localAlertLines(l: LocalAlertsOfficial | undefined, tf: TimeFmt, max = 3, opts: { units?: Units; fireOpen?: boolean } = {}): OfficialLine[] {
  if (!l) return []
  const metric = opts.units === 'metric'
  const elsewhere = [
    // the fire's own answer: its messages for other places in its area are in Updates
    l.elsewhere ? `${l.elsewhere} of the fire's local alert${l.elsewhere === 1 ? ' is' : 's are'} for other places in its area (see Updates).` : null,
    // the live answer for the point's small box (review round 2, N3): never called the fire's, and not in Updates
    l.nearby?.county ? `${l.nearby.county} nearby local alert${l.nearby.county === 1 ? ' is' : 's are'} for a neighbouring county, not this point's county.` : null,
    l.nearby?.area ? `${l.nearby.area} nearby local alert${l.nearby.area === 1 ? ' is for an area that does' : 's are for areas that do'} not reach this point.` : null,
  ]
    .filter(Boolean)
    .join(' ') || null
  const status = (key: string, text: string, sub: string | null, tone: OfficialTone, official = false): OfficialLine => ({ key, text, sub, subCompact: sub, official, tone, url: null })
  switch (l.state) {
    case 'loading':
      return [status('local-loading', "Checking local officials' alerts…", null, 'loading')]
    case 'unavailable':
      return [status('local-unavailable', "Local officials' alerts: not checked", withoutFollow(l.reason) ? `${withoutFollow(l.reason)} That does not mean there were none.` : 'That does not mean there were none.', 'unknown')]
    case 'not-checked':
      return [status('local-unchecked', "Local officials' alerts: not checked", withoutFollow(l.reason) ?? null, 'unknown')]
    case 'none':
      return [
        {
          ...status('local-none', "Local officials' alerts relayed by NWS: none here · not an all-clear", [elsewhere, withoutFollow(LOCAL_STANDING_CAVEAT)].filter(Boolean).join(' '), 'quiet', true),
          subCompact: elsewhere ? `${elsewhere} Most local alerts are not relayed by NWS` : 'Most local alerts are not relayed by NWS',
        },
        ...(l.archivePending ? [status('local-pending', "FEMA's archive of local alerts: still being checked", 'Ask again in a minute.', 'loading')] : []),
      ]
    case 'listed': {
      const out = l.alerts.slice(0, max).map((a): OfficialLine => {
        const when = sentText(a, tf)
        const place = localAlertPlace(a, { metric, fireOpen: opts.fireOpen })
        const sub = [a.event, when, a.archived ? 'FEMA archive' : 'relayed by the National Weather Service', place, a.archived ? `${ARCHIVE_CREDIT}: ${OPENFEMA_NOTICE}` : null].filter(Boolean).join(' · ')
        const subCompact = [when, a.archived ? 'FEMA archive' : 'relayed by NWS', place].filter(Boolean).join(' · ')
        return {
          key: `local-${a.id}`,
          text: `${a.lead}: "${a.text}"`,
          sub,
          subCompact,
          official: true,
          tone: a.phase === 'active' || a.phase === 'upcoming' ? 'warning' : 'other',
          url: a.link.url,
          urlLabel: a.link.label,
        }
      })
      if (l.alerts.length > max) out.push(status('local-more', `+${l.alerts.length - max} more local alerts (see Updates)`, null, 'other'))
      if (elsewhere) out.push(status('local-elsewhere', elsewhere, null, 'other'))
      if (l.archivePending) out.push(status('local-pending', "FEMA's archive of local alerts: still being checked", 'Ask again in a minute.', 'loading'))
      return out
    }
  }
}

function calfireUrl(cf: CalFireOfficial, fallback: string | null): string | null {
  return https(cf.url) ?? https(fallback)
}

export function officialBlock(info: OfficialInfo, c: OfficialContext): OfficialBlock {
  const evacuation = evacuationLines(info.evacuation, c)
  const fireWeather = [...fireWeatherLines(info.fireWeather), ...localAlertLines(info.local, c.tf, 3, { units: c.units, fireOpen: c.fireName != null })]
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
 *  `tf` (CONTRACT §14.9.6, required since the integration) is part of the shared signature; the note has no time in
 *  it today. */
export function officialFireWeatherNote(fw: FireWeatherOfficial, _tf: TimeFmt): string | null {
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
