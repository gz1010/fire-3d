// Updates feed model (owner: timeline-feed; CONTRACT §8, BRIEF §10): events.json + annotations (Key Events) plus,
// when given, agency perimeters, satellite passes, the selected forecast run and items from the optional sources
// (`extra`), as plain-language feed items in chronological order; and the one selection action shared by the feed,
// map markers and timeline markers.
// Wording rules: every item says what kind of information it is; automated items (Fire-3d event detection, model
// output, satellite sensors) are flagged `automated` and never worded as human reporting; estimated positions are
// flagged `approximate`; the producer's original wording (scientific units) is kept in `original`.
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
import { fmtDateTimeYear, tzLabel } from '../../lib/time'
import type { Annotation } from '../../state/annotations'
import { getTimeBounds, useStore } from '../../state/store'
import type { Units } from '../../state/workspace'
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

function eventCopy(e: FireEvent, c: Ctx): Copy {
  const u = c.units
  const estimated = e.confidence !== 'observed'
  switch (e.type) {
    case 'ignition':
      // Only CAL FIRE's reported start, unchanged and not confirmed by a satellite (backend ignition_time): an agency
      // report, not something Fire-3d inferred. The start area is still Fire-3d's estimate (approximate location).
      if (estimated && /^CAL FIRE\b/.test(e.source) && !/\+|GOES|FIRMS/.test(e.source) && !/Ignition estimated/.test(e.detail))
        return {
          title: 'Fire start reported',
          detail: `${e.detail} Not confirmed by satellite heat detections.`,
          kind: 'official',
          automated: false,
          approximate: true,
          locationLabel: 'Estimated start area, not an exact ignition point',
        }
      return {
        title: estimated ? 'Fire started (estimated time)' : 'Fire started',
        detail: e.detail
          .replace(/persistent (GOES[-\w]*) detection/g, 'repeated $1 satellite heat detection')
          .replace(/^Ignition estimated/, 'Start time estimated')
          .replace(/\. Ignition estimated/g, '. Start time estimated'),
        kind: estimated ? 'estimate' : 'observation',
        approximate: true,
        locationLabel: 'Estimated start area, not an exact ignition point',
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
    original: { title: e.title, detail: e.detail || null, source: e.source },
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
    facts: [],
    approximate: location != null,
    locationLabel: location ? 'Center of the detections' : null,
  }
}

function forecastItem(f: ForecastManifest, m: IncidentManifest): FeedItem {
  const live = m.mode === 'live'
  const runs = ensemblePhrase(f.weather.ensemble, f.weather.members)
  return {
    id: `forecast:${f.run_id}`,
    topic: 'forecast',
    kind: 'model',
    // live: listed when it was issued; replay: a hindcast belongs at the start of the period it re-runs
    tMs: live ? f.issued_ms : f.start_ms,
    seekMs: f.start_ms,
    title: keepUnits(live ? `Spread forecast issued (${f.horizon_h} h)` : `Hindcast starts (${f.horizon_h} h)`),
    detail: live
      ? `Covers ${keepUnits(forecastPeriod(f))}: ${runs}. Shows where model runs spread the fire; experimental, not an official prediction.`
      : `The forecast model was re-run on ${fmtDateTimeYear(f.issued_ms)} ${tzLabel(f.issued_ms)} for ${keepUnits(forecastPeriod(f))} (${runs}), to compare with what happened.`,
    source: 'Fire-3d spread model',
    automated: true,
    key: false,
    confidence: null,
    location: null,
    seekable: true,
    eventId: null,
    original: { title: f.run_id, detail: `${f.weather.ensemble}, ${f.weather.members} members, ${f.horizon_h} h, engine ${f.model?.engine ?? 'unknown'}`, source: f.weather.source },
    facts: [],
    approximate: false,
    locationLabel: null,
  }
}

const TOPIC_ORDER: Partial<Record<FeedTopic, number>> = { ignition: 0, forecast: 1, perimeter_update: 2, perimeter: 3, detection: 9, annotation: 10 }

/** Feed items, oldest first (the panel may render newest first). Key Events always; perimeters, satellite passes and
 *  the forecast run only when their inputs are given. */
export function buildFeedItems(input: FeedInput): FeedItem[] {
  const { manifest, events, annotations } = input
  const c: Ctx = {
    manifest,
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
  if (input.detections?.length) for (const p of satellitePasses(input.detections)) items.push(passItem(p, c))
  const f = input.forecast
  if (f && manifest && f.incident_id === manifest.id && f.status === 'ready') items.push(forecastItem(f, manifest))
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

export type FeedFilter = 'key' | 'all'

export function filterFeed(items: readonly FeedItem[], filter: FeedFilter): FeedItem[] {
  return filter === 'all' ? items.slice() : items.filter((i) => i.key)
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

export function feedBaseline(incidentId: string, items: readonly FeedItem[]): FeedBaseline {
  return {
    incidentId,
    ids: new Set(items.map((i) => i.id)),
    forecastT: items.reduce((m, i) => (i.topic === 'forecast' ? Math.max(m, i.tMs) : m), -Infinity),
    lateTopics: new Set(items.filter((i) => LATE_TOPICS.has(i.topic)).map((i) => i.topic)),
  }
}

/** The baseline plus the first batch of each late-loading topic seen for the first time; null when unchanged. */
export function extendFeedBaseline(b: FeedBaseline, items: readonly FeedItem[]): FeedBaseline | null {
  const first = items.filter((i) => LATE_TOPICS.has(i.topic) && !b.lateTopics.has(i.topic))
  if (!first.length) return null
  return { ...b, ids: new Set([...b.ids, ...first.map((i) => i.id)]), lateTopics: new Set([...b.lateTopics, ...first.map((i) => i.topic)]) }
}

/** Live only: an item that arrived after the baseline (a data refresh added it). Notes are never "new". */
export function isNewFeedItem(b: FeedBaseline | null, incidentId: string | null, item: FeedItem, live: boolean): boolean {
  if (!live || !b || b.incidentId !== incidentId || item.kind === 'annotation' || b.ids.has(item.id)) return false
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

/** Select an item: pause, seek (when seekable, clamped to the timeline), select it, and fly there when geolocated.
 *  The fly uses the existing store.flyTo nonce (local x/z): the Forensic camera and the map both follow it. Items
 *  without coordinates stay selectable; nothing invents a target for them. */
export function selectFeedItem(item: FeedItem): void {
  const s = useStore.getState()
  s.setPlaying(false)
  if (item.seekable) {
    const target = item.seekMs ?? item.tMs
    const b = getTimeBounds(s)
    s.setTimeMs(b ? Math.min(b.endMs, Math.max(b.startMs, target)) : target)
  }
  s.setSelectedEventId(selectionId(item))
  if (item.location) s.requestFlyTo(item.location.x, item.location.z)
}
