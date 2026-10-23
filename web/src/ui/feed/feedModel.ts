// Updates feed model (owner: official-web since brief 2, earlier timeline-feed; CONTRACT §8, BRIEF §10): events.json
// + annotations (Key Events) plus, when given, agency perimeters, satellite passes, the selected forecast run and items
// from the optional and official sources (`extra`), as plain-language feed items in chronological order; and the one
// selection action shared by the feed, map markers and timeline markers.
// Wording rules: every item says what kind of information it is; automated items (Fire-3d event detection, model
// output, satellite sensors) are flagged `automated` and never worded as human reporting; estimated positions are
// flagged `approximate`; the producer's original wording (scientific units) is kept in `original`. Official items keep
// their issuer, own times and link; they fit and highlight their area when selected and never seek into a forecast.
import type { Detection, FireEvent, ForecastManifest, IncidentManifest, Perimeter, TimeseriesFile, WeatherFile } from '../../api/types'
import { cardinal, satelliteName } from '../../lib/format'
import {
  area,
  cardinalWord,
  distance,
  elevation,
  ensemblePhrase,
  fireWeatherSeverity,
  forecastPeriod,
  growthRate,
  keepUnits,
  sourceName,
  spreadSpeed,
  windSpeed,
  windSummary,
} from '../../lib/plainLanguage'
import { localToLonLat } from '../../lib/reproject'
import { fmtAt, fmtClock, fmtDayDate, startOfLocalDay, type TimeFmt } from '../../lib/time'
import { fitOfficialBounds } from '../../official/select'
import { useOfficialRuntime } from '../../official/runtime'
import type { Annotation } from '../../state/annotations'
import { getTimeBounds, useStore } from '../../state/store'
import { getTimeFormat } from '../../state/timeZone'
import { useWorkspace, type Preset, type Units } from '../../state/workspace'
import type { FeedFact, FeedItem, FeedKind, FeedTopic } from './types'

const HOUR = 3_600_000
/** Detections of one satellite closer than this belong to the same overpass. */
export const PASS_GAP_MS = 30 * 60_000
/** A perimeter within this of a perimeter_update event is the same update (listed once). */
const SAME_TIME_MS = 60_000

export interface FeedInput {
  manifest: IncidentManifest | null
  events: FireEvent[]
  annotations: Annotation[]
  // ---- additions (optional): richer plain-language details and the non-key updates
  timeseries?: TimeseriesFile | null
  weather?: WeatherFile | null
  /** Agency perimeters (listed when no perimeter_update event already covers them). */
  perimeters?: Perimeter[] | null
  /** Satellite detections, summarised as one item per VIIRS / MODIS / Landsat overpass (GOES is continuous: skipped). */
  detections?: Detection[] | null
  /** The selected forecast run (listed as model output). */
  forecast?: ForecastManifest | null
  units?: Units
  /** Items made by other producers in FeedItem form (the optional sources: official evacuation status, public
   *  cameras, recently acquired imagery), merged in time order as given; repeated ids and invalid times are dropped. */
  extra?: readonly FeedItem[] | null
  // ---- additions (official-web, brief 2)
  /** Public uses plain words ("model re-run on past weather"); Command keeps the technical terms. Default public. */
  preset?: Preset
  /** Live: one row per day for the satellite passes ("Satellite passes today: 9"), each pass in its details. */
  groupPasses?: boolean
  /** The current time (live "today" wording and the quiet-period row); quantise it to limit rebuilds. */
  wallMs?: number
  // ---- additions (brief 3, CONTRACT §14.9.6)
  /** Zone and clock of every time in the items (the fire's zone; 12-hour in Public, 24-hour in Command and Forensic).
   *  Required since the brief-3 integration (CONTRACT §14.9.6); components pass `useTimeFormat()`. */
  tf: TimeFmt
}

function locate(m: IncidentManifest | null, x?: number, z?: number): FeedItem['location'] {
  if (!m || x == null || z == null || !Number.isFinite(x) || !Number.isFinite(z)) return null
  const [lon, lat] = localToLonLat(x, z, m.grid)
  return { lon, lat, x, z }
}

const num = (s: string | undefined) => (s == null ? null : Number(s.replace(/,/g, '')))
const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v)

/** Index of `t` in an hourly series (exact within a minute), else -1. */
function hourIndex(ts: readonly number[], t: number): number {
  let lo = 0
  let hi = ts.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (ts[mid] < t - SAME_TIME_MS) lo = mid + 1
    else if (ts[mid] > t + SAME_TIME_MS) hi = mid - 1
    else return mid
  }
  return -1
}

interface Ctx {
  manifest: IncidentManifest | null
  tf: TimeFmt
  units: Units
  timeseries: TimeseriesFile | null
  weather: WeatherFile | null
  perimeters: Perimeter[]
}

interface Copy {
  title: string
  detail: string | null
  facts?: FeedFact[]
  kind?: FeedKind
  automated?: boolean
  approximate?: boolean
  locationLabel?: string | null
}

/** Growth and spread speed of a rapid_growth event: the timeseries hour it was detected in (the event sits half an
 *  hour before the end of that hour), else the numbers in the producer's own detail text. */
function growthAt(e: FireEvent, ts: TimeseriesFile | null): { growth: number | null; ros: number | null } {
  if (ts) {
    const i = hourIndex(ts.t_ms, e.t_ms + HOUR / 2)
    if (i >= 0) return { growth: ts.growth_acres_per_h[i] ?? null, ros: ts.ros_ch_per_h[i] ?? null }
  }
  return { growth: num(e.detail.match(/\+?([\d,.]+)\s*ac\/h/)?.[1]), ros: num(e.detail.match(/ROS\s*([\d,.]+)\s*ch\/h/)?.[1]) }
}

/** UTC offsets (hours) of the US zone abbreviations the backend writes into event details. */
const ABBR_OFFSET_H: Record<string, number> = {
  UTC: 0, GMT: 0, EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7, AKST: -9, AKDT: -8, HST: -10,
}
const MONTH_INDEX: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
const DETAIL_TIME = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{1,2}):(\d{2}) (UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|AKST|AKDT|HST)\b/g

/**
 * The times the build writes into an event's text ("Reported by DFR via NIFC WFIGS Mar 19, 15:00 EDT", 24-hour and
 * zero-padded) in the panel's own clock and zone (CONTRACT §14.9.1, round 2 decision 8: Public reads "Mar 19, 3:00 PM
 * EDT"; integration review UX-M3). The token has no year: the one nearest `nearMs` (the event's time) is used. A
 * token with an unknown abbreviation stays as written.
 */
export function localizeDetailTimes(text: string, tf: TimeFmt, nearMs: number): string {
  return text.replace(DETAIL_TIME, (tok, mon: string, day: string, hh: string, mm: string, abbr: string) => {
    const off = ABBR_OFFSET_H[abbr]
    const base = new Date(Number.isFinite(nearMs) ? nearMs : Date.now()).getUTCFullYear()
    let best: number | null = null
    for (const y of [base - 1, base, base + 1]) {
      const ms = Date.UTC(y, MONTH_INDEX[mon], Number(day), Number(hh), Number(mm)) - off * HOUR
      if (best == null || Math.abs(ms - nearMs) < Math.abs(best - nearMs)) best = ms
    }
    return best == null || !Number.isFinite(best) ? tok : fmtAt(best, tf, { zone: true })
  })
}

function eventCopy(e: FireEvent, c: Ctx): Copy {
  const u = c.units
  const estimated = e.confidence !== 'observed'
  switch (e.type) {
    case 'ignition': {
      // the build's own times in the panel's clock and the fire's zone (review UX-M3)
      const text = localizeDetailTimes(e.detail, c.tf, e.t_ms)
      // Only CAL FIRE's reported start, unchanged and not confirmed by a satellite (backend ignition_time): an agency
      // report, not something Fire-3d inferred. The start area is still Fire-3d's estimate (approximate location).
      if (estimated && /^CAL FIRE\b/.test(e.source) && !/\+|GOES|FIRMS/.test(e.source) && !/Ignition estimated/.test(e.detail))
        return {
          title: 'Fire start reported',
          detail: `${text} Not confirmed by satellite heat detections.`,
          kind: 'official',
          automated: false,
          approximate: true,
          locationLabel: 'Estimated start area, not an exact ignition point',
        }
      return {
        title: estimated ? 'Fire started (estimated time)' : 'Fire started',
        detail: text
          .replace(/persistent (GOES[-\w]*) detection/g, 'repeated $1 satellite heat detection')
          .replace(/^Ignition estimated/, 'Start time estimated')
          .replace(/\. Ignition estimated/g, '. Start time estimated'),
        kind: estimated ? 'estimate' : 'observation',
        approximate: true,
        locationLabel: 'Estimated start area, not an exact ignition point',
      }
    }
    case 'rapid_growth': {
      const { growth, ros } = growthAt(e, c.timeseries)
      const g = growthRate(growth, u)
      const s = spreadSpeed(ros, u)
      const parts: string[] = []
      if (finite(growth)) parts.push(`The burned area grew by about ${area(growth, u).text} in one hour.`)
      if (finite(ros) && ros > 0) parts.push(`Spread speed reached about ${s.text} at the fastest-moving parts of the edge.`)
      if (estimated) parts.push('Timing estimated between satellite observations.')
      const facts: FeedFact[] = []
      if (g.value != null) facts.push({ label: 'Growth', text: g.text, scientific: g.scientific })
      if (s.value != null) facts.push({ label: 'Spread speed (fastest 10% of the edge)', text: s.text, scientific: s.scientific && `${s.scientific}, 90th percentile of the front` })
      return { title: 'Rapid growth', detail: parts.join(' ') || e.detail, facts, approximate: true, locationLabel: 'Center of the area that burned in that hour' }
    }
    case 'spot_fire': {
      const km = num(e.detail.match(/([\d.]+)\s*km/)?.[1])
      const d = finite(km) ? ` about ${distance(km * 1000, u).text}` : ''
      return {
        title: 'Possible spot fire',
        detail: `A satellite saw heat${d} beyond the mapped fire edge, which suggests embers may have started a new fire ahead of the main front. Not confirmed on the ground.`,
        kind: 'estimate',
        approximate: true,
        locationLabel: 'Satellite detection (pixel center)',
      }
    }
    case 'ridge_crossing': {
      const m = num(e.detail.match(/at\s+([\d,]+)\s*m\b/)?.[1])
      const head = e.detail.match(/moving\s+([NSEW]{1,3})\b/)?.[1]
      const where = finite(m) ? ` at about ${elevation(m, u).text}` : ''
      return {
        title: 'Fire crossed a ridge (estimated)',
        detail: `The reconstructed spread moved over a ridge${where}${head ? `, heading ${cardinalWord(head)}` : ''}. Estimated from terrain and satellite data.`,
        kind: 'estimate',
        approximate: true,
        locationLabel: 'Estimated crossing point',
      }
    }
    case 'peak_wind': {
      const w = c.weather
      const i = w ? hourIndex(w.t_ms, e.t_ms) : -1
      if (!w || i < 0) return { title: 'Peak wind', detail: e.detail, kind: 'model', approximate: true }
      const a = w.at_fire
      const dir = a.wind_dir_deg[i]
      const gust = windSpeed(a.wind_gust_ms[i], u)
      const speed = windSpeed(a.wind_speed_ms[i], u)
      const sum = windSummary(a.wind_speed_ms[i], dir, null, u)
      const ffwi = fireWeatherSeverity(a.ffwi[i])
      const facts: FeedFact[] = []
      if (sum.value != null) facts.push({ label: 'Wind', text: sum.text, scientific: sum.scientific })
      if (gust.value != null) facts.push({ label: 'Gusts', text: gust.text, scientific: gust.scientific })
      if (ffwi.value != null) facts.push({ label: 'Fire weather severity', text: ffwi.text, scientific: ffwi.scientific })
      const from = finite(dir) ? ` from the ${cardinalWord(cardinal(dir))}` : ''
      const lead = gust.value != null ? `: ${gust.text}${from}` : from ? `: wind${from}` : ''
      // the producer picks the strongest gust during hours the fire grew; say "while growing" only when it did grow
      const ti = c.timeseries ? hourIndex(c.timeseries.t_ms, e.t_ms) : -1
      const grew = ti >= 0 ? c.timeseries?.growth_acres_per_h[ti] : null
      const when = finite(grew) && grew > 0 ? ` while the fire was growing about ${area(grew, u).text} per hour` : " during the fire's active period"
      return {
        title: gust.value != null ? `Peak wind: gusts ${gust.text}` : 'Peak wind',
        detail: `Strongest gust at the fire${when}${lead}${speed.value != null ? ` (sustained ${speed.text})` : ''}. From weather-model data, not a wind station.`,
        facts,
        kind: 'model',
        approximate: true,
        locationLabel: 'Center of the area burning at that hour',
      }
    }
    case 'wind_shift':
      return {
        title: 'Spread direction changed (inferred)',
        detail: e.detail.replace(/\s*->\s*/g, ' → ').replace(/toward ([NSEW]{1,3})\b/g, (_, d: string) => `toward the ${cardinalWord(d)}`),
        kind: 'estimate',
        approximate: true,
        locationLabel: 'Where the direction change was inferred',
      }
    case 'perimeter_update': {
      const p = c.perimeters.find((q) => Math.abs(q.t_ms - e.t_ms) <= SAME_TIME_MS)
      const acres = p?.acres ?? num(e.detail.match(/cumulative\s+([\d,.]+)\s*ac/)?.[1] ?? e.detail.match(/([\d,.]+)\s*ac/)?.[1])
      const a = area(acres, u)
      const first = /first/i.test(e.title)
      return {
        title: `${first ? 'First fire perimeter mapped' : 'Fire perimeter updated'}${a.value != null ? `: ${a.text}` : ''}`,
        detail: `Perimeter mapped by fire agencies${a.value != null ? `; it encloses about ${a.text} in total` : ''}.`,
        facts: a.value != null ? [{ label: 'Area inside the perimeter', text: a.text, scientific: a.scientific }] : [],
        kind: 'observation',
        automated: false,
        approximate: true,
        locationLabel: 'Center of the mapped perimeter',
      }
    }
    case 'containment':
      return { title: 'Fire 100% contained', detail: `Reported by ${sourceName(e.source)}.`, kind: 'official', automated: false }
    default:
      return { title: e.title, detail: e.detail || null }
  }
}

function eventItem(e: FireEvent, c: Ctx): FeedItem {
  const copy = eventCopy(e, c)
  const location = locate(c.manifest, e.x, e.z)
  return {
    id: e.id,
    topic: e.type,
    kind: copy.kind ?? (e.confidence === 'observed' ? 'observation' : 'estimate'),
    tMs: e.t_ms,
    title: copy.title,
    detail: copy.detail,
    source: sourceName(e.source),
    automated: copy.automated ?? true,
    key: true,
    confidence: e.confidence,
    location,
    seekable: true,
    eventId: e.id,
    // the producer's own wording, with the times the build wrote into it in the panel's clock and the fire's zone like
    // the row's text (Public's expanded row shows it as "Original"; review round 2, N2)
    original: { title: e.title, detail: e.detail ? localizeDetailTimes(e.detail, c.tf, e.t_ms) : null, source: e.source },
    facts: copy.facts ?? [],
    approximate: location ? (copy.approximate ?? e.confidence !== 'observed') : false,
    locationLabel: location ? (copy.locationLabel ?? null) : null,
  }
}

/** Area-weighted centroid of the largest ring (local metres), else the vertex mean. */
export function ringCentroid(rings: [number, number][][]): [number, number] | null {
  let best: { a: number; cx: number; cz: number } | null = null
  let sx = 0
  let sz = 0
  let n = 0
  for (const r of rings) {
    let a = 0
    let cx = 0
    let cz = 0
    for (let i = 0; i < r.length; i++) {
      const [x0, z0] = r[i]
      const [x1, z1] = r[(i + 1) % r.length]
      const k = x0 * z1 - x1 * z0
      a += k
      cx += (x0 + x1) * k
      cz += (z0 + z1) * k
      sx += x0
      sz += z0
      n++
    }
    if (Math.abs(a) > 1e-6 && (!best || Math.abs(a) > Math.abs(best.a))) best = { a, cx: cx / (3 * a), cz: cz / (3 * a) }
  }
  if (best) return [best.cx, best.cz]
  return n ? [sx / n, sz / n] : null
}

function perimeterItem(p: Perimeter, c: Ctx): FeedItem {
  const a = area(p.acres, c.units)
  const final = /final extent/i.test(p.source)
  const mapped = p.source.match(/mapped (\d{4}-\d{2}-\d{2})/)?.[1]
  const cen = ringCentroid(p.rings)
  const location = cen ? locate(c.manifest, cen[0], cen[1]) : null
  return {
    id: `perimeter:${p.t_ms}`,
    topic: 'perimeter',
    kind: 'observation',
    tMs: p.t_ms,
    title: `${final ? 'Final mapped extent' : 'Fire perimeter mapped'}: ${a.text}`,
    detail: final
      ? `Final burned extent mapped by fire agencies${mapped ? ` on ${mapped}` : ''}, shown at the end of the record; it encloses about ${a.text}.`
      : `Perimeter mapped by fire agencies; it encloses about ${a.text} in total.`,
    source: sourceName(p.source),
    automated: false,
    key: false,
    confidence: 'observed',
    location,
    seekable: true,
    eventId: null,
    original: { title: 'Perimeter', detail: `${a.scientific ?? ''}`, source: p.source },
    facts: [{ label: 'Area inside the perimeter', text: a.text, scientific: a.scientific }],
    approximate: location != null,
    locationLabel: location ? 'Center of the mapped perimeter' : null,
  }
}

/** Satellite overpasses: detections of one polar-orbiting satellite (VIIRS, MODIS) or Landsat grouped while less
 *  than PASS_GAP_MS apart. GOES (geostationary, every few minutes) is left out to keep the feed readable. */
export function satellitePasses(dets: readonly Detection[]): { satellite: string; instrument: Detection['instrument']; tMs: number; endMs: number; dets: Detection[] }[] {
  const bySat = new Map<string, Detection[]>()
  for (const d of dets) {
    if (d.instrument === 'GOES' || !Number.isFinite(d.t_ms)) continue
    const k = `${d.instrument}|${d.satellite}`
    const list = bySat.get(k)
    if (list) list.push(d)
    else bySat.set(k, [d])
  }
  const out: ReturnType<typeof satellitePasses> = []
  for (const list of bySat.values()) {
    list.sort((a, b) => a.t_ms - b.t_ms)
    let cur: Detection[] = []
    const flush = () => {
      if (cur.length) out.push({ satellite: cur[0].satellite, instrument: cur[0].instrument, tMs: cur[0].t_ms, endMs: cur[cur.length - 1].t_ms, dets: cur })
      cur = []
    }
    for (const d of list) {
      if (cur.length && d.t_ms - cur[cur.length - 1].t_ms > PASS_GAP_MS) flush()
      cur.push(d)
    }
    flush()
  }
  return out.sort((a, b) => a.tMs - b.tMs || a.satellite.localeCompare(b.satellite))
}

function passItem(p: ReturnType<typeof satellitePasses>[number], c: Ctx): FeedItem {
  const n = p.dets.length
  const sat = satelliteName(p.satellite)
  let sx = 0
  let sz = 0
  for (const d of p.dets) {
    sx += d.x
    sz += d.z
  }
  const location = locate(c.manifest, sx / n, sz / n)
  const fp = distance(p.dets[0].footprint_m, c.units)
  const night = p.dets.every((d) => d.daynight === 'N')
  return {
    id: `pass:${p.satellite}:${p.tMs}`,
    topic: 'detection',
    kind: 'observation',
    tMs: p.tMs,
    title: `Satellite pass: ${n.toLocaleString('en-US')} heat detection${n === 1 ? '' : 's'}`,
    detail: `${p.instrument} on ${sat} saw heat in ${n.toLocaleString('en-US')} pixel${n === 1 ? '' : 's'} (each about ${fp.text} across)${night ? ' during a night pass' : ''}. Detections show where heat was seen, not the exact fire edge.`,
    source: `NASA FIRMS (${p.instrument}, ${sat})`,
    automated: true,
    key: false,
    confidence: 'observed',
    location,
    seekable: true,
    eventId: null,
    original: { title: `${p.instrument} ${p.satellite}`, detail: `${n} detections, footprint ${p.dets[0].footprint_m} m`, source: `FIRMS ${p.instrument} ${p.satellite}` },
    facts: [{ label: 'Heat detections', text: n.toLocaleString('en-US'), scientific: null }],
    approximate: location != null,
    locationLabel: location ? 'Center of the detections' : null,
  }
}

/** Public wording of the ensemble: "31 simulated fires, each with different weather" (no ensemble names). */
export function plainRuns(members: number, ensemble: ForecastManifest['weather']['ensemble']): string {
  if (ensemble === 'none' || members <= 1) return members === 1 ? 'one simulated fire with one weather series' : `${members} simulated fires with one weather series`
  return `${members} simulated fires, each with slightly different weather`
}

function forecastItem(f: ForecastManifest, m: IncidentManifest, preset: Preset, tf: TimeFmt): FeedItem {
  const live = m.mode === 'live'
  const command = preset === 'command'
  const runs = command ? ensemblePhrase(f.weather.ensemble, f.weather.members) : plainRuns(f.weather.members, f.weather.ensemble)
  return {
    id: `forecast:${f.run_id}`,
    topic: 'forecast',
    kind: 'model',
    // live: listed when it was issued; replay: a hindcast belongs at the start of the period it re-runs
    tMs: live ? f.issued_ms : f.start_ms,
    seekMs: f.start_ms,
    title: keepUnits(live ? `Spread forecast issued (${f.horizon_h} h)` : command ? `Hindcast starts (${f.horizon_h} h)` : `Model re-run on past weather starts (${f.horizon_h} h)`),
    detail: live
      ? `Covers ${keepUnits(forecastPeriod(f, tf))}: ${runs}. Shows where model runs spread the fire; experimental, not an official prediction.`
      : command
        ? `The forecast model was re-run on ${fmtAt(f.issued_ms, tf, { year: 'always', zone: true })} for ${keepUnits(forecastPeriod(f, tf))} (${runs}), to compare with what happened.`
        : `Fire-3d re-ran its experimental spread model on the weather of ${keepUnits(forecastPeriod(f, tf))} (${runs}), after the fire, to compare with what happened.`,
    source: 'Fire-3d spread model',
    automated: true,
    key: false,
    confidence: null,
    location: null,
    seekable: true,
    eventId: null,
    // the run id and ensemble name are Command detail (C-R8: no run ids in the Public feed)
    original: command ? { title: f.run_id, detail: `${f.weather.ensemble}, ${f.weather.members} members, ${f.horizon_h} h, engine ${f.model?.engine ?? 'unknown'}`, source: f.weather.source } : null,
    facts: [],
    approximate: false,
    locationLabel: null,
  }
}

/** A day's satellite passes as one row (live): "Satellite passes today: 9", each pass selectable in its details.
 *  Days with a single pass keep the pass row itself. */
export function groupPassesByDay(passes: readonly FeedItem[], wallMs: number | null, tf: TimeFmt = getTimeFormat()): FeedItem[] {
  const byDay = new Map<number, FeedItem[]>()
  for (const p of passes) {
    const d = startOfLocalDay(p.tMs, tf.tz)
    byDay.set(d, [...(byDay.get(d) ?? []), p])
  }
  const out: FeedItem[] = []
  for (const [day, list] of byDay) {
    if (list.length === 1) {
      out.push(list[0])
      continue
    }
    const sorted = list.slice().sort((a, b) => a.tMs - b.tMs)
    const newest = sorted[sorted.length - 1]
    const dets = sorted.reduce((n, p) => n + (Number(p.facts?.find((f) => f.label === 'Heat detections')?.text.replace(/,/g, '')) || 0), 0)
    const today = wallMs != null && startOfLocalDay(wallMs, tf.tz) === day
    const sats = [...new Set(sorted.map((p) => p.source.replace(/^NASA FIRMS \(|\)$/g, '')))]
    out.push({
      id: `passes:${day}`,
      topic: 'detection',
      kind: 'observation',
      tMs: newest.tMs,
      title: `Satellite passes ${today ? 'today' : `on ${fmtDayDate(day, tf.tz)}`}: ${sorted.length}`,
      detail: `${dets ? `${dets.toLocaleString('en-US')} heat detections in ` : ''}${sorted.length} passes (${sats.join('; ')}), newest ${fmtClock(newest.tMs, tf, { zone: true })}. Detections show where heat was seen, not the exact fire edge.`,
      source: 'NASA FIRMS',
      automated: true,
      key: false,
      confidence: 'observed',
      location: newest.location,
      seekable: true,
      eventId: null,
      original: null,
      facts: [],
      approximate: newest.location != null,
      locationLabel: newest.location ? "Center of the newest pass's detections" : null,
      children: sorted.slice().reverse(),
    })
  }
  return out
}

/** Live quiet-period row: no new heat seen by satellites since the latest detection (later passes saw none), or the
 *  newest detection is old. Never worded as "out" or "safe". Null when there is nothing to say. */
export function quietItem(m: Pick<IncidentManifest, 'mode' | 'time_range'>, wallMs: number, staleAfterMs = 6 * HOUR, tf: TimeFmt = getTimeFormat()): FeedItem | null {
  if (m.mode !== 'live') return null
  const det = m.time_range.last_detection_ms
  const pass = m.time_range.last_pass_ms
  if (det == null || !Number.isFinite(det)) return null
  const later = pass != null && Number.isFinite(pass) && pass > det + 10 * 60_000
  const old = wallMs - det > staleAfterMs
  if (!later && !old) return null
  const when = fmtAt(det, tf, { zone: true })
  return {
    id: `quiet:${det}`,
    topic: 'quiet',
    kind: 'observation',
    tMs: later ? (pass as number) : det,
    title: later ? `No new heat seen by satellites since ${when}` : `No new satellite heat detection since ${when}`,
    detail: later
      ? `Later satellite passes (the newest at ${fmtAt(pass as number, tf, { zone: true })}) saw no new heat over the fire. Smoke, cloud or smoldering can hide fire; this is not an all-clear.`
      : 'Satellites pass over only a few times a day, so gaps are normal. Smoke, cloud or smoldering can hide fire; this is not an all-clear.',
    source: 'NASA FIRMS and satellite pass times',
    automated: true,
    key: false,
    confidence: 'observed',
    location: null,
    seekable: false,
    eventId: null,
    original: null,
    facts: [],
    approximate: false,
    locationLabel: null,
  }
}

const TOPIC_ORDER: Partial<Record<FeedTopic, number>> = { ignition: 0, forecast: 1, perimeter_update: 2, perimeter: 3, detection: 9, quiet: 9, annotation: 10 }

/** Feed items, oldest first (the panel may render newest first). Key Events always; perimeters, satellite passes and
 *  the forecast run only when their inputs are given. */
export function buildFeedItems(input: FeedInput): FeedItem[] {
  const { manifest, events, annotations } = input
  const tf = input.tf
  const c: Ctx = {
    manifest,
    tf,
    units: input.units ?? 'us',
    timeseries: input.timeseries ?? null,
    weather: input.weather ?? null,
    perimeters: input.perimeters ?? [],
  }
  const items: FeedItem[] = events.map((e) => eventItem(e, c))
  for (const a of annotations) {
    const location = locate(manifest, a.x, a.z)
    items.push({
      id: a.id,
      topic: 'annotation',
      kind: 'annotation',
      tMs: a.t_ms,
      title: a.title,
      detail: a.detail ?? null,
      source: 'You (saved in this browser)',
      automated: false,
      key: true,
      confidence: null,
      location,
      seekable: true,
      eventId: a.id,
      original: null,
      facts: [],
      approximate: false,
      locationLabel: location ? 'Where the note was pinned' : null,
    })
  }
  const eventTimes = events.filter((e) => e.type === 'perimeter_update').map((e) => e.t_ms)
  for (const p of c.perimeters) if (!eventTimes.some((t) => Math.abs(t - p.t_ms) <= SAME_TIME_MS)) items.push(perimeterItem(p, c))
  if (input.detections?.length) {
    const passes = satellitePasses(input.detections).map((p) => passItem(p, c))
    items.push(...(input.groupPasses ? groupPassesByDay(passes, input.wallMs ?? null, tf) : passes))
  }
  const f = input.forecast
  if (f && manifest && f.incident_id === manifest.id && f.status === 'ready') items.push(forecastItem(f, manifest, input.preset ?? 'public', tf))
  if (manifest && input.wallMs != null) {
    const q = quietItem(manifest, input.wallMs, undefined, tf)
    if (q) items.push(q)
  }
  if (input.extra?.length) {
    const ids = new Set(items.map((i) => i.id))
    for (const x of input.extra) {
      if (!Number.isFinite(x.tMs) || ids.has(x.id)) continue
      ids.add(x.id)
      items.push(x)
    }
  }
  return items.sort((p, q) => p.tMs - q.tMs || (TOPIC_ORDER[p.topic] ?? 5) - (TOPIC_ORDER[q.topic] ?? 5) || p.id.localeCompare(q.id))
}

export type FeedFilter = 'official' | 'all' | 'key'

/** Official: official items only (agencies' own updates). Key events: events.json, notes and any key item. */
export function filterFeed(items: readonly FeedItem[], filter: FeedFilter): FeedItem[] {
  if (filter === 'all') return items.slice()
  if (filter === 'official') return items.filter((i) => i.kind === 'official')
  return items.filter((i) => i.key)
}

export interface FeedView {
  /** Items to list, newest first. */
  listed: FeedItem[]
  /** Items after the timeline time, newest first (replay: listed only on request). */
  later: FeedItem[]
  /** Replay: the newest item at or before the timeline time (null in live mode, which lists the present). */
  currentId: string | null
}

/** An item after the timeline time (dimmed, "later"). Live current-status items (not seekable, e.g. today's official
 *  evacuation status) describe the present, not a point on the timeline, so they are never "later" there. */
/** The status chip of a row: "Expired", "Cancelled", "Upcoming". A local officials' message is never "Upcoming" (a
 *  "leave now" order is not a scheduled one): one sent after the replay time says "Sent after this time", one whose
 *  onset is later "Not yet in effect" (integration review UX-m2). */
export function feedStatusLabel(item: Pick<FeedItem, 'status' | 'topic'>, later: boolean): string | undefined {
  if (item.status === 'upcoming' && item.topic === 'local-alert') return later ? 'Sent after this time' : 'Not yet in effect'
  return item.status ? FEED_STATUS_LABEL[item.status] : undefined
}
const FEED_STATUS_LABEL: Partial<Record<NonNullable<FeedItem['status']>, string>> = { expired: 'Expired', cancelled: 'Cancelled', upcoming: 'Upcoming' }

export function isLaterItem(item: Pick<FeedItem, 'seekMs' | 'tMs' | 'seekable'>, tMs: number, live: boolean): boolean {
  return feedCompareMs(item) > tMs && (item.seekable || !live)
}

/** What the panel lists at timeline time tMs. Live: everything, newest first (later items are only dimmed). Replay:
 *  what had happened by tMs, newest first; later items (also current-status items, which are not historical facts)
 *  only when `showLater`. `items` are chronological. */
export function feedView(items: readonly FeedItem[], tMs: number, live: boolean, showLater: boolean): FeedView {
  const newestFirst = items.slice().reverse()
  const later = newestFirst.filter((it) => isLaterItem(it, tMs, live))
  const done = newestFirst.filter((it) => feedCompareMs(it) <= tMs)
  return { listed: live || showLater ? newestFirst : done, later, currentId: live ? null : (done[0]?.id ?? null) }
}

/** Topics that load separately from the incident bundle (optional sources): their first batch joins the baseline, so
 *  a slow first load is not shown as "New"; later arrivals are. */
export const LATE_TOPICS: ReadonlySet<FeedTopic> = new Set<FeedTopic>(['evacuation', 'camera', 'imagery', 'weather'])

/** What the feed listed when it first showed an incident (live "New" marks are relative to it). */
export interface FeedBaseline {
  incidentId: string
  ids: ReadonlySet<string>
  /** Newest forecast run listed then (another run is "new" only when issued later). */
  forecastT: number
  /** LATE_TOPICS already seen (their first batch is in `ids`). */
  lateTopics: ReadonlySet<FeedTopic>
}

/** Ids of the items and of the passes grouped inside them. */
const allIds = (items: readonly FeedItem[]) => items.flatMap((i) => [i.id, ...(i.children?.map((c) => c.id) ?? [])])

export function feedBaseline(incidentId: string, items: readonly FeedItem[]): FeedBaseline {
  return {
    incidentId,
    ids: new Set(allIds(items)),
    forecastT: items.reduce((m, i) => (i.topic === 'forecast' ? Math.max(m, i.tMs) : m), -Infinity),
    lateTopics: new Set(items.filter((i) => LATE_TOPICS.has(i.topic)).map((i) => i.topic)),
  }
}

/** The baseline plus the first batch of each late-loading topic seen for the first time; null when unchanged. */
export function extendFeedBaseline(b: FeedBaseline, items: readonly FeedItem[]): FeedBaseline | null {
  const first = items.filter((i) => LATE_TOPICS.has(i.topic) && !b.lateTopics.has(i.topic))
  if (!first.length) return null
  return { ...b, ids: new Set([...b.ids, ...allIds(first)]), lateTopics: new Set([...b.lateTopics, ...first.map((i) => i.topic)]) }
}

/** Live only: an item that arrived after the baseline (a data refresh added it). Notes are never "new"; a day of
 *  satellite passes is new when it holds a new pass. */
export function isNewFeedItem(b: FeedBaseline | null, incidentId: string | null, item: FeedItem, live: boolean): boolean {
  if (!live || !b || b.incidentId !== incidentId || item.kind === 'annotation') return false
  if (item.children?.length) return item.children.some((c) => !b.ids.has(c.id))
  if (b.ids.has(item.id)) return false
  return item.topic !== 'forecast' || item.tMs > b.forecastT
}

// ------------------------------------------------------------------------------------------------- keyboard
/** Roving focus over `count` feed rows (one Tab stop for the whole list): the row a key moves to from `index`, or
 *  null when the key is not a list-navigation key. */
export function rovingIndex(key: string, index: number, count: number): number | null {
  if (count <= 0 || index < 0) return null
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, index + 1)
    case 'ArrowUp':
      return Math.max(0, index - 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** The row that holds the list's Tab stop: the first of `preferred` (last focused, selected, replay-current) that is
 *  listed, else the first row. */
export function rovingTabStop(ids: readonly string[], preferred: readonly (string | null | undefined)[]): string | null {
  for (const p of preferred) if (p != null && ids.includes(p)) return p
  return ids[0] ?? null
}

/** The time an item belongs to on the timeline (where selecting it moves the timeline). */
export const feedCompareMs = (item: Pick<FeedItem, 'seekMs' | 'tMs'>): number => item.seekMs ?? item.tMs

/** The id the feed and the markers use for "selected": the event / annotation id, else the item id. */
export const selectionId = (item: Pick<FeedItem, 'eventId' | 'id'>): string => item.eventId ?? item.id

/** Where selecting an item moves the timeline: its time clamped to the timeline; official items only inside the
 *  observed record (never into a forecast period); null = no seek. */
export function seekTarget(item: Pick<FeedItem, 'seekable' | 'seekMs' | 'tMs' | 'kind'>, bounds: { startMs: number; endMs: number } | null, observed: { startMs: number; endMs: number } | null): number | null {
  if (!item.seekable) return null
  const target = item.seekMs ?? item.tMs
  if (item.kind === 'official') {
    if (!observed || target < observed.startMs || target > observed.endMs) return null
    return target
  }
  return bounds ? Math.min(bounds.endMs, Math.max(bounds.startMs, target)) : target
}

/** Move the timeline and the map to an item without selecting it (a pass inside a day's group of passes). */
export function focusFeedItem(item: FeedItem): void {
  const s = useStore.getState()
  s.setPlaying(false)
  const m = s.manifest?.status === 'ready' ? s.manifest : null
  const target = seekTarget(item, getTimeBounds(s), m ? { startMs: m.time_range.start_ms, endMs: m.time_range.now_ms } : null)
  if (target != null) s.setTimeMs(target)
  if (item.location) s.requestFlyTo(item.location.x, item.location.z)
}

/** Select an item: pause, seek (see seekTarget), select it, highlight its official area, and fly there: official
 *  areas are fitted on the map; other geolocated items use the existing store.flyTo nonce (local x/z), which the
 *  Forensic camera and the map both follow. Items without coordinates stay selectable; nothing invents a target. */
export function selectFeedItem(item: FeedItem): void {
  const s = useStore.getState()
  s.setPlaying(false)
  const m = s.manifest?.status === 'ready' ? s.manifest : null
  const target = seekTarget(item, getTimeBounds(s), m ? { startMs: m.time_range.start_ms, endMs: m.time_range.now_ms } : null)
  if (target != null) s.setTimeMs(target)
  s.setSelectedEventId(selectionId(item))
  useOfficialRuntime.getState().setHighlight(item.highlight ?? null)
  if (item.bounds && useWorkspace.getState().workspace === 'map') fitOfficialBounds(item.bounds)
  else if (item.location) s.requestFlyTo(item.location.x, item.location.z)
}
