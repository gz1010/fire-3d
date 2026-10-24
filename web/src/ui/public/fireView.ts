// The Public fire view's words and figures (brief 4 H4, FireView.dc.html; PLAN-4 §3.4, decisions a and i; CONTRACT
// §15.4-15.5). Pure and tested (fireView.test.ts); the components in this folder only draw them.
//   title          the place, and "JUN 28 2026 — PRESENT" (active) or the record's own end with its label
//   hazard circle  "WILDFIRE · ACTIVE" from the agency record only (never the model), the name fitted to the circle
//   distance chip  from the browser's location (after a click): to the newest perimeter's nearest edge, else to the
//                  reported location, always saying which
//   facts          "value — LABEL" rows from the agency record and the official answers (useOfficialNow), verbatim,
//                  each with its own time; quiet states are never an all-clear and never "N/A"
//   key            "Latest perimeter · <source> · <its own time> (<age>)", Stale on a live fire's day-old perimeter
import type { IncidentSummary, Perimeter } from '../../api/types'
import { bearingDeg, distanceM } from '../../lib/geodesy'
import { directionWord, distance } from '../../lib/plainLanguage'
import { containedLabel, recordStatus as summaryRecordStatus } from '../../lib/recordText'
import { localToLonLat, lonLatToLocal, type UtmGrid } from '../../lib/reproject'
import { fmtAt, fmtClock, fmtDayDate, fmtRelative, MONTHS, wallParts, type TimeFmt } from '../../lib/time'
import { nearestOnRings, pointInRings } from '../../location/geometry'
import { perimeterStale } from '../../map/fireProfile'
import type { CalFireOfficial, EvacuationOfficial, FireWeatherOfficial } from '../../official/model'
import { evacuationWho, groupZones } from '../../official/model'
import { recordEndTimes } from '../../official/record'
import type { SummaryLine } from '../shell/officialSummary'

// ------------------------------------------------------------------------------------------------ fixed wording
/** The location card's model block in the fire view, and the Layers drawer's note (decision a). */
export const MODEL_IN_COMMAND = 'The experimental spread model for this spot is in Command'
export const LAYERS_IN_COMMAND =
  'Modeled spread (experimental), the burned-area estimate from satellite detections, the detections and event locations are in Command'
/** An unprepared fire (decision a): under the facts, in place of the top notice. */
export const NOT_PREPARED = "Fire-3d has not prepared this fire's map data yet."
export const PREPARE_LABEL = 'Prepare map data (1-3 min)'
export const PREPARE_FAILED = "Fire-3d's last preparation of this fire's map data failed."
export const PREPARE_AGAIN_LABEL = 'Prepare again (1-3 min)'
export const PREPARING = "Preparing this fire's map data (1-3 min)"
/** A bundle without a perimeter (decision a): the observed raster is an estimate and is not put in its place. */
export const NO_PERIMETER = 'No perimeter published yet'
export const ESTIMATE_IN_COMMAND = 'Estimated burned area from satellite detections: in Command'
export const SHARE_PROMPT = 'Share your location to see how far you are'

// ------------------------------------------------------------------------------------------------ title
export type EndLabel = 'contained' | 'controlled' | 'declared out'
export interface FireEnd {
  label: EndLabel
  ms: number
}

/** The record's end, each time with its own meaning (§14.17): the record endpoint's latest stage (declared out, then
 *  controlled, then contained), else the list row's dated containment (`containedLabel`); null when none is given. */
export function fireEnd(summary: Pick<IncidentSummary, 'contained_ms' | 'contained_kind' | 'record_source'> | null, record?: Pick<CalFireOfficial, 'containedMs' | 'controlledMs' | 'outMs'> | null): FireEnd | null {
  const ends = record ? recordEndTimes({ contained: record.containedMs, controlled: record.controlledMs, out: record.outMs }) : []
  if (ends.length) return ends[ends.length - 1]
  if (!summary) return null
  const label = containedLabel(summary)
  return label && summary.contained_ms != null ? { label, ms: summary.contained_ms } : null
}

/** Whether the fire's own agency record lists it as active (never the model; recordText.recordStatus). */
export function recordActive(summary: IncidentSummary | null): boolean {
  return summary != null && summaryRecordStatus(summary).ownActive
}

/** "JUN 28 2026" in the fire's zone. */
export function upperDay(ms: number, tz: string): string {
  const p = wallParts(ms, tz)
  return `${MONTHS[p.month - 1].toUpperCase()} ${p.day} ${p.year}`
}

/** "JUN 28 2026 — PRESENT" (listed active), "SEP 1 2025 — CONTAINED NOV 14 2025" (the record's end with its label),
 *  or the start alone when the record gives no end. */
export function fireDateLine(startMs: number | null, active: boolean, end: FireEnd | null, tz: string): string | null {
  if (startMs == null || !Number.isFinite(startMs)) return null
  const start = upperDay(startMs, tz)
  if (active) return `${start} — PRESENT`
  return end ? `${start} — ${end.label.toUpperCase()} ${upperDay(end.ms, tz)}` : start
}

// ------------------------------------------------------------------------------------------------ hazard circle
export interface HazardStatus {
  /** "WILDFIRE · ACTIVE" */
  line: string
  /** active: the hot glow; quiet: a darker ember (contained, out, not listed); unknown: loading or no record. */
  tone: 'active' | 'quiet' | 'demo' | 'unknown'
  /** What the word means, from the record (the circle's description). */
  meaning: string
}

/** The circle's status words, from the agency record only (decision i-10): "ACTIVE" only while the record lists the
 *  fire as active; "CONTAINED" / "CONTROLLED" / "DECLARED OUT" with its own time; otherwise "NOT LISTED AS ACTIVE". */
export function hazardStatus(summary: IncidentSummary | null, end: FireEnd | null, demo: boolean, issuer: string | null, tz: string): HazardStatus {
  if (demo) return { line: 'SIMULATED FIRE · DEMO', tone: 'demo', meaning: 'Demo data: a simulated fire, not an agency record.' }
  if (!summary) return { line: 'WILDFIRE', tone: 'unknown', meaning: 'Loading the agency record.' }
  const who = issuer ? `The ${issuer} record` : 'The agency record'
  if (recordActive(summary)) return { line: 'WILDFIRE · ACTIVE', tone: 'active', meaning: `${who} lists the fire as active.` }
  const when = end ? fmtDayDate(end.ms, tz, { year: 'always' }) : null
  if (end?.label === 'declared out') return { line: 'WILDFIRE · DECLARED OUT', tone: 'quiet', meaning: `${who} gives a fire-out time: ${when}.` }
  if (end?.label === 'controlled') return { line: 'WILDFIRE · CONTROLLED', tone: 'quiet', meaning: `${who} gives a control time: ${when}.` }
  if (end?.label === 'contained' || (summary.percent_contained ?? 0) >= 100)
    return { line: 'WILDFIRE · CONTAINED', tone: 'quiet', meaning: `${who} lists the fire as contained${when ? ` (${when})` : ''}. Contained is not out.` }
  return { line: 'WILDFIRE · NOT LISTED AS ACTIVE', tone: 'quiet', meaning: `${who} does not list the fire as active.` }
}

export interface FittedName {
  lines: string[]
  px: number
}

/** The name in the circle: 72 px on one line when it fits `maxWidth`, else the largest size down to 40 px on one line
 *  or two (two lines win when 8 px or more larger); a name too long even then keeps 40 px and two lines (the circle
 *  clips the end; the full name is the button's accessible name). `measure(text, px)` gives a text's width. */
export function fitName(name: string, measure: (text: string, px: number) => number, maxWidth = 256, maxPx = 72, minPx = 40): FittedName {
  const text = name.trim().replace(/\s+/g, ' ')
  const fits = (lines: string[], px: number) => lines.every((l) => measure(l, px) <= maxWidth)
  const best = (lines: string[]): number | null => {
    for (let px = maxPx; px >= minPx; px -= 2) if (fits(lines, px)) return px
    return null
  }
  const one = best([text])
  // two lines: every break after a space or a hyphen, the most even first
  const splits: string[][] = []
  for (let i = 1; i < text.length; i++) {
    if (text[i - 1] === ' ') splits.push([text.slice(0, i - 1), text.slice(i)])
    else if (text[i - 1] === '-') splits.push([text.slice(0, i), text.slice(i)])
  }
  let two: { lines: string[]; px: number } | null = null
  for (const s of splits) {
    const px = best(s)
    if (px != null && (!two || px > two.px)) two = { lines: s, px }
  }
  if (one != null && (!two || two.px < one + 8)) return { lines: [text], px: one }
  if (two) return two
  if (splits.length) {
    const even = [...splits].sort((a, b) => Math.max(measure(a[0], 1), measure(a[1], 1)) - Math.max(measure(b[0], 1), measure(b[1], 1)))[0]
    return { lines: even, px: minPx }
  }
  return { lines: [text], px: minPx }
}

// ------------------------------------------------------------------------------------------------ distance chip
export interface DistanceToFire {
  meters: number
  /** Bearing from the viewer to the fire (degrees clockwise from true north). */
  bearing: number
  /** The viewer is inside the newest perimeter. */
  inside: boolean
  /** What was measured: the perimeter's nearest edge, or the reported location. */
  to: 'edge' | 'reported'
}

/** The distance and direction from the viewer to the fire: to the newest perimeter's nearest edge (planar in the
 *  fire's UTM grid, then geodesic between the viewer and that point, as the location check does), else to the
 *  reported location; null without either. */
export function distanceToFire(
  me: { lat: number; lon: number },
  fire: { perimeter: Pick<Perimeter, 'rings'> | null; grid: UtmGrid | null; reported: { lat: number; lon: number } | null },
): DistanceToFire | null {
  if (!Number.isFinite(me.lat) || !Number.isFinite(me.lon)) return null
  if (fire.perimeter && fire.grid && fire.perimeter.rings.length) {
    const [x, z] = lonLatToLocal(me.lon, me.lat, fire.grid)
    const rings = fire.perimeter.rings
    const near = nearestOnRings(x, z, rings)
    if (near) {
      const [lon, lat] = localToLonLat(near.x, near.z, fire.grid)
      const inside = pointInRings(x, z, rings)
      return { meters: inside ? 0 : distanceM(me, { lat, lon }), bearing: bearingDeg(me, { lat, lon }), inside, to: 'edge' }
    }
  }
  const r = fire.reported
  if (r && Number.isFinite(r.lat) && Number.isFinite(r.lon)) return { meters: distanceM(me, r), bearing: bearingDeg(me, r), inside: false, to: 'reported' }
  return null
}

export interface DistanceChipText {
  /** "20" */
  value: string
  /** "mi" */
  unit: string
  /** "northeast of you" */
  direction: string
  /** What it measures: "to the mapped edge, Oct 23 perimeter" / "to the reported location, not its edge". */
  measures: string
  /** The whole sentence (the button's accessible name). */
  spoken: string
}

/** The chip's words (decision i-7: what it measures, never a word or colour of safety). */
export function distanceChipText(d: DistanceToFire, units: 'us' | 'metric', perimeterDay: string | null): DistanceChipText {
  const measures = d.to === 'edge' ? `to the mapped edge${perimeterDay ? `, ${perimeterDay} perimeter` : ''}` : 'to the reported location, not its edge'
  if (d.inside) {
    const where = `inside the mapped fire area${perimeterDay ? ` (${perimeterDay} perimeter)` : ''}`
    return { value: 'Inside', unit: '', direction: 'the mapped fire area', measures: perimeterDay ? `${perimeterDay} perimeter` : 'mapped perimeter', spoken: `Your location is ${where}.` }
  }
  const t = distance(d.meters, units).text
  const cut = t.lastIndexOf(' ')
  const value = cut > 0 ? t.slice(0, cut) : t
  const unit = cut > 0 ? t.slice(cut + 1) : ''
  const direction = `${directionWord(d.bearing)} of you`
  return { value, unit, direction, measures, spoken: `The fire is ${t} ${direction}, ${measures}.` }
}

// ------------------------------------------------------------------------------------------------ key
export interface PerimeterKey {
  /** "Latest perimeter · NIFC WFIGS daily perimeters" */
  text: string
  /** Its own time: "Oct 23, 2:30 PM MDT" (the year when it differs from now's). */
  time: string
  /** "(6 h ago)" for a live fire; null for a past fire (an archive: the date says it). */
  age: string | null
  stale: boolean
}

export function perimeterKey(p: Pick<Perimeter, 't_ms' | 'source'>, nowMs: number, live: boolean, tf: TimeFmt): PerimeterKey {
  return {
    text: `Latest perimeter · ${p.source}`,
    time: fmtAt(p.t_ms, tf, { zone: true, year: 'auto', refMs: nowMs }),
    age: live ? fmtRelative(p.t_ms, nowMs) : null,
    stale: perimeterStale(p.t_ms, nowMs, live),
  }
}

// ------------------------------------------------------------------------------------------------ facts
export interface FactRow {
  key: 'burned' | 'contained' | 'started' | 'reported' | 'fire-weather' | 'evacuation' | 'local' | 'updated'
  value: string
  unit?: string
  /** "BURNED", "RED FLAG WARNING (NWS)" (upper-cased by the row's style). */
  label: string
  /** 26 for figures, 22 for coordinates and dates, 17 for words (decision i-1/2). */
  size: 26 | 22 | 17
  tone?: 'alert' | 'stale'
  /** The source, its own time and what a quiet answer means. */
  sub?: string | null
  link?: { url: string; label: string } | null
  copy?: string
}

export interface FactsInput {
  summary: IncidentSummary | null
  record: CalFireOfficial
  evacuation: EvacuationOfficial
  fireWeather: FireWeatherOfficial
  /** The local officials' line while a message is in effect (officialSummary.localAlertsLine), else null. */
  local: SummaryLine | null
  demo: boolean
  tf: TimeFmt
  nowMs: number
}

const num = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)
const checked = (ms: number | null | undefined, nowMs: number) => (num(ms) ? `checked ${fmtRelative(ms, nowMs)}` : null)
const join = (parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ') || null
const https = (u: string | null | undefined) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null)
const shortSender = (s: string) => s.replace(/^National Weather Service\b\s*/i, 'NWS ').trim()

/** The record's numbers: the record endpoint's answer when it has them, else the list row (the same agency's record,
 *  read with the fire list), each with the update time of what it came from. */
export function recordFigures(i: Pick<FactsInput, 'summary' | 'record'>): { acres: number | null; contained: number | null; updatedMs: number | null } {
  const r = i.record
  const fromRecord = r.state === 'available' && (num(r.acres) || num(r.percentContained))
  if (fromRecord) return { acres: num(r.acres) ? r.acres : null, contained: num(r.percentContained) ? r.percentContained : null, updatedMs: num(r.updatedMs) ? r.updatedMs : null }
  const s = i.summary
  return { acres: s && num(s.acres) ? s.acres : null, contained: s && num(s.percent_contained) ? s.percent_contained : null, updatedMs: s && num(s.updated_ms) ? s.updated_ms : null }
}

function fireWeatherRow(f: FireWeatherOfficial, nowMs: number): FactRow {
  const base = { key: 'fire-weather' as const, label: 'Red Flag Warning (NWS)', size: 17 as const }
  const nws = f.archived ? 'NWS, archived copy' : 'NWS'
  const live = f.alerts.filter((a) => a.phase === 'active' || a.phase === 'upcoming')
  const a = live[0]
  if (f.state === 'active' && a) {
    const more = live.length > 1 ? `+${live.length - 1} more` : null
    return {
      ...base,
      // the alert's own words and times: "In effect — RED FLAG WARNING (NWS)", "until Oct 20, 18:00 PDT · NWS Boise ID"
      value: a.phase === 'upcoming' ? 'Starting soon' : 'In effect',
      label: `${a.event} (NWS)`,
      tone: 'alert',
      sub: join([a.timeText, shortSender(a.senderName), a.archived || f.archived ? 'archived copy' : null, more, 'a weather warning, not an evacuation order']),
      link: https(a.url) ? { url: a.url as string, label: 'NWS alert' } : null,
    }
  }
  switch (f.state) {
    case 'loading':
      return { ...base, value: 'Checking…' }
    case 'past-date':
      return { ...base, value: 'Not available for this time', sub: f.reason ?? null }
    case 'unavailable':
      if (f.reasonCode === 'demo') return { ...base, value: 'Not checked', sub: f.reason ?? 'Demo data: NWS alerts are not checked for simulated incidents.' }
      return { ...base, value: 'Unavailable right now', sub: f.reason ?? null }
    default:
      // none listed (or only expired ones): never an all-clear
      return { ...base, value: 'None in effect', sub: join(['No Red Flag Warning or Fire Weather Watch listed', nws, checked(f.checkedMs, nowMs), 'not an all-clear']) }
  }
}

function evacuationRow(e: EvacuationOfficial, state: string | null, nowMs: number, tf: TimeFmt): FactRow {
  const base = { key: 'evacuation' as const, label: `Evacuation zones${state ? ` (${state})` : ''}`, size: 17 as const }
  const who = evacuationWho(e)
  switch (e.state) {
    case 'loading':
      return { ...base, value: 'Checking…' }
    case 'not-available': {
      const l = e.links?.[0]
      // §14.14 short form, never "N/A"; the state's own pages when the backend names them
      return { ...base, value: 'Not available in this state', sub: join([e.reason && e.reason !== 'Not available in this state' ? e.reason : null, 'follow local officials']), link: l && https(l.url) ? { url: l.url, label: l.label } : null }
    }
    case 'none-listed':
      return { ...base, value: 'None listed', sub: join([`No order or warning listed near this fire`, who, checked(e.checkedMs, nowMs), 'not an all-clear']) }
    case 'past-date':
      return { ...base, value: 'Not available for past dates', sub: 'Official evacuation status is published as current status only' }
    case 'not-checked':
      return { ...base, value: 'Not checked', sub: e.reason ?? null }
    case 'unavailable':
      return { ...base, value: 'Unavailable right now', sub: e.reason ?? null }
    default: {
      const g = groupZones(e.zones)[0]
      if (!g) return { ...base, value: 'Listed near this fire', tone: 'alert', sub: join([who, checked(e.checkedMs, nowMs)]) }
      const more = e.zones.length > g.zones.length ? `+${e.zones.length - g.zones.length} other zone${e.zones.length - g.zones.length === 1 ? '' : 's'}` : null
      const z = g.zones[0]
      const own = z.updatedMs ?? z.listedMs
      const ownText = num(own) ? `${z.updatedMs != null ? 'updated' : (z.listedPhrase ?? 'listed')} ${fmtAt(own, tf, { zone: true, year: 'auto', refMs: nowMs })}` : null
      const src = e.sourceUrl ? https(e.sourceUrl) : null
      return {
        ...base,
        // the issuer's own status wording, verbatim ("Evacuation Order")
        value: g.status,
        tone: 'alert',
        sub: join([`${g.zones.length} zone${g.zones.length === 1 ? '' : 's'}`, g.issuer, ownText, more, who ? `via ${who}` : null]),
        link: src ? { url: src, label: who ?? 'Source' } : null,
      }
    }
  }
}

/** The facts rows (decision i): record figures, the start, the reported location, NWS fire weather, evacuation zones,
 *  local officials' alerts (only while one is in effect) and the record's update time. */
export function fireFacts(i: FactsInput): FactRow[] {
  const s = i.summary
  const tz = i.tf.tz
  const fig = recordFigures(i)
  const rows: FactRow[] = [
    { key: 'burned', value: fig.acres != null ? Math.round(fig.acres).toLocaleString('en-US') : 'Not given', unit: fig.acres != null ? 'ac' : undefined, label: 'Burned', size: fig.acres != null ? 26 : 17 },
    { key: 'contained', value: fig.contained != null ? String(Math.round(fig.contained)) : 'Not given', unit: fig.contained != null ? '%' : undefined, label: 'Contained', size: fig.contained != null ? 26 : 17 },
  ]
  const startMs = s && num(s.started_ms) ? s.started_ms : null
  if (startMs != null) rows.push({ key: 'started', value: fmtDayDate(startMs, tz, { year: 'auto', refMs: i.nowMs }), label: 'Started', size: 26 })
  if (s && num(s.lat) && num(s.lon)) {
    const lat = `${Math.abs(s.lat).toFixed(3)}°${s.lat >= 0 ? 'N' : 'S'}`
    const lon = `${Math.abs(s.lon).toFixed(3)}°${s.lon >= 0 ? 'E' : 'W'}`
    rows.push({ key: 'reported', value: `${lat}, ${lon}`, label: 'Reported', size: 22, copy: `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}` })
  }
  rows.push(fireWeatherRow(i.fireWeather, i.nowMs))
  rows.push(evacuationRow(i.evacuation, s?.state ?? null, i.nowMs, i.tf))
  if (i.local) rows.push({ key: 'local', value: "Alert in effect", label: "Local officials' alert", size: 17, tone: 'alert', sub: i.local.text, link: i.local.link ?? null })
  if (fig.updatedMs != null)
    rows.push({ key: 'updated', value: fmtDayDate(fig.updatedMs, tz, { year: 'auto', refMs: i.nowMs }), unit: fmtClock(fig.updatedMs, i.tf, { zone: true }), label: 'Last official update', size: 26 })
  else rows.push({ key: 'updated', value: 'No update time given', label: 'Last official update', size: 17 })
  return rows
}

export interface FactsSource {
  /** OFFICIAL when the agency record is the fire's (never for demo or synthetic data). */
  badge: 'official' | 'demo' | null
  /** "USFS via NIFC WFIGS · NWS · checked 2 min ago" */
  line: string
  /** The record's own page, labelled by its publisher ("NIFC WFIGS", "CAL FIRE"). */
  link: { url: string; label: string } | null
}

/** The line under the facts: who published them and when Fire-3d last checked (decision i-2: the sources named). */
export function factsSource(i: FactsInput): FactsSource {
  const s = i.summary
  if (i.demo) return { badge: 'demo', line: 'Demo data: a simulated fire, not an agency record', link: null }
  const issuer = s?.record_issuer || (i.record.issuer && i.record.issuer !== 'Agency record' ? i.record.issuer : null)
  const who = evacuationWho(i.evacuation)
  const checks = [i.record.checkedMs, i.fireWeather.checkedMs, i.evacuation.checkedMs].filter(num)
  const latest = checks.length ? Math.max(...checks) : null
  const line = join([issuer, 'NWS', who, latest != null ? `checked ${fmtRelative(latest, i.nowMs)}` : null]) ?? 'Agency record'
  const url = https(i.record.url) ?? https(s?.url)
  const label = (s?.record_source ?? i.record.source) === 'wfigs' ? 'NIFC WFIGS' : (s?.record_source ?? i.record.source) === 'calfire' ? 'CAL FIRE' : 'Agency record'
  return { badge: issuer ? 'official' : null, line, link: url ? { url, label } : null }
}
