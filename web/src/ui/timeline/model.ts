// Compact timeline model (owner: timeline-feed; CONTRACT §7, BRIEF §7): past observations, NOW (live) or the
// hindcast start (replay), and +24/+48/+72 h only where the selected forecast covers them. Unavailable hours are
// disabled with a reason, never filled with invented data. Pure functions (tested in model.test.ts).
//
// Live data freshness: the latest observation (manifest.time_range.now_ms: newest detection, mapped perimeter or
// confirmed satellite pass that saw no new fire) is "stale" when it is more than STALE_AFTER_MS older than the actual
// current time. 6 h is a plain-language "check the time" flag, not an outage alarm: polar-orbiting satellites (VIIRS,
// MODIS) pass over California only a few times a day, so gaps of several hours can be normal at night, under cloud, or
// when the fire is quiet. While stale, the NOW stop is labelled "Latest data" so a many-hours-old observation is never
// called "now".
import type { ForecastManifest, IncidentManifest, Mode } from '../../api/types'
import { nowMarkerMs } from '../../state/store'

const HOUR = 3_600_000
/** Live: a latest observation older than this (vs. the actual current time) is flagged stale (see header). */
export const STALE_AFTER_MS = 6 * HOUR
/** Forecast stops (hours after the forecast start). */
export const STOP_HOURS = [24, 48, 72] as const
/** Nominal forecast window drawn after the anchor when hours are unavailable (no forecast / shorter horizon). */
export const NOMINAL_FORECAST_H = 72

export type StopId = 'past' | 'now' | 'h24' | 'h48' | 'h72'

export interface TimelineStop {
  id: StopId
  /** "Past" | "NOW" / "Latest data" (live, stale) | "Forecast start" (replay) | "+24h" | "+48h" | "+72h". */
  label: string
  /** Time the stop jumps to (null when unavailable). */
  tMs: number | null
  kind: 'observation' | 'now' | 'forecast'
  available: boolean
  /** Why a stop is disabled (no forecast, shorter horizon, ...). */
  reason: string | null
  /** Addition: where the stop sits on the drawn track, also for unavailable forecast hours (null: not on the track). */
  posMs: number | null
  /** Addition: longer accessible description ("24 h after the forecast start: Jan 9, 00:18 PST"). Times are
   *  formatted by the component; this holds the plain sentence without times. */
  description: string
}

export interface TimelineSegment {
  kind: 'observed' | 'forecast'
  startMs: number
  endMs: number
}

/** ready: a forecast is selected; unselected: runs exist but none is selected; loading: the selected run's file is
 *  loading; running: a run is in progress; failed: only failed runs; none: no run at all. */
export type ForecastAvailability = 'ready' | 'unselected' | 'loading' | 'running' | 'failed' | 'none'

export interface CompactTimelineModel {
  mode: Mode
  /** Track start (first observation hour). */
  startMs: number
  /** Last time with data: max(observed end, forecast end). The scrubber never goes beyond it. */
  endMs: number
  segments: TimelineSegment[]
  /** Latest observation in the bundle (manifest.time_range.now_ms). */
  latestObservationMs: number
  /** Live: the latest observation; replay: the selected hindcast's start (else null). */
  nowMarkerMs: number | null
  /** Actual current time (distinct from the latest observation). */
  wallClockMs: number
  forecast: { runId: string; issuedMs: number; startMs: number; endMs: number; horizonH: number } | null
  stops: TimelineStop[]
  /** Live only: wall clock minus latest observation against STALE_AFTER_MS. */
  stale: { isStale: boolean; ageMs: number; thresholdMs: number }
  /** store.timeMs and whether it shows observations or the forecast ("valid time"). */
  currentMs: number
  currentKind: 'observation' | 'forecast' | 'beyond'

  // ---- additions (timeline-feed)
  /** End of the drawn track: endMs plus unavailable forecast hours drawn as a disabled zone. */
  trackEndMs: number
  /** Forecast hours drawn but disabled (live without a forecast, or a horizon shorter than 72 h). */
  unavailable: { startMs: number; endMs: number; reason: string } | null
  /** Where the forecast part of the track starts (forecast start, or the latest observation without one). */
  anchorMs: number
  /** currentMs lies inside the selected forecast's period (also in replay, where observations overlap it). */
  inForecastPeriod: boolean
  /** Hours since the forecast start at currentMs (inside the period), else null. */
  leadH: number | null
  forecastStatus: ForecastAvailability
  /** Honest notes about the selected forecast (older than the latest observation, period already over, ...). */
  forecastNotes: string[]
  /** Bundle build time (live: when the data was last refreshed). */
  checkedMs: number
}

export interface TimelineOptions {
  /** store.forecastRunId (null = no run selected; undefined = unknown, a ready run is assumed to be loading). */
  forecastRunId?: string | null
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function hoursText(ms: number): string {
  const h = ms / HOUR
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`
  if (h < 48) return `${Math.round(h)} h`
  return `${Math.round(h / 24)} days`
}

function availability(manifest: IncidentManifest, forecast: ForecastManifest | null, runId: string | null | undefined): ForecastAvailability {
  if (forecast) return 'ready'
  const runs = manifest.forecasts ?? []
  const ready = runs.some((r) => r.status === 'ready')
  if (runId && runs.some((r) => r.run_id === runId && r.status === 'ready')) return 'loading'
  if (runs.some((r) => r.status === 'running')) return 'running'
  if (ready) return runId === null ? 'unselected' : 'loading'
  if (runs.some((r) => r.status === 'error')) return 'failed'
  return 'none'
}

function missingReason(status: ForecastAvailability, live: boolean): string {
  switch (status) {
    case 'loading':
      return 'The forecast is still loading'
    case 'unselected':
      return 'No forecast run is selected'
    case 'running':
      return 'A forecast run is in progress'
    case 'failed':
      return 'The forecast run failed'
    default:
      return live ? 'No forecast has been run for this fire yet' : 'The model has not been re-run on the weather of this replay'
  }
}

export function buildCompactTimeline(
  manifest: IncidentManifest,
  forecast: ForecastManifest | null,
  timeMs: number,
  wallClockMs: number,
  opts: TimelineOptions = {},
): CompactTimelineModel {
  const tr = manifest.time_range
  const live = manifest.mode === 'live'
  const f = forecast && forecast.incident_id === manifest.id ? forecast : null
  const fc = f ? { runId: f.run_id, issuedMs: f.issued_ms, startMs: f.start_ms, endMs: f.start_ms + f.horizon_h * HOUR, horizonH: f.horizon_h } : null
  const status = availability(manifest, f, opts.forecastRunId)
  const latest = tr.now_ms
  const nowMark = nowMarkerMs(manifest, f)
  const endMs = Math.max(tr.end_ms, latest, fc?.endMs ?? -Infinity)
  const anchorMs = fc ? fc.startMs : latest

  const segments: TimelineSegment[] = [{ kind: 'observed', startMs: tr.start_ms, endMs: latest }]
  if (fc) segments.push({ kind: 'forecast', startMs: fc.startMs, endMs: fc.endMs })

  // forecast hours drawn but unavailable: live without a forecast (the next 72 h after the latest observation) or a
  // forecast shorter than 72 h. A replay without a hindcast has no "forecast start" to measure from: no zone.
  let unavailable: CompactTimelineModel['unavailable'] = null
  if (fc && fc.horizonH < NOMINAL_FORECAST_H) unavailable = { startMs: fc.endMs, endMs: fc.startMs + NOMINAL_FORECAST_H * HOUR, reason: `This forecast covers ${fc.horizonH} h` }
  else if (!fc && live) unavailable = { startMs: latest, endMs: latest + NOMINAL_FORECAST_H * HOUR, reason: missingReason(status, true) }
  const trackEndMs = Math.max(endMs, unavailable?.endMs ?? -Infinity)

  const ageMs = Math.max(0, wallClockMs - latest)
  const isStale = live && ageMs > STALE_AFTER_MS

  const stops: TimelineStop[] = [
    { id: 'past', label: 'Past', tMs: tr.start_ms, kind: 'observation', available: true, reason: null, posMs: tr.start_ms, description: 'Start of the record' },
  ]
  if (live) {
    stops.push({
      id: 'now',
      label: isStale ? 'Latest data' : 'NOW',
      tMs: latest,
      kind: 'now',
      available: true,
      reason: null,
      posMs: latest,
      description: isStale ? `Latest observation, ${hoursText(ageMs)} before the current time` : 'Latest observation',
    })
  } else {
    stops.push({
      id: 'now',
      label: 'Forecast start',
      tMs: fc ? fc.startMs : null,
      kind: 'now',
      available: fc != null,
      reason: fc ? null : missingReason(status, false),
      posMs: fc ? fc.startMs : null,
      description: 'Start of the model re-run on past weather',
    })
  }
  for (const h of STOP_HOURS) {
    const covered = fc != null && fc.horizonH >= h
    const nominal = fc ? fc.startMs + h * HOUR : live ? latest + h * HOUR : null
    stops.push({
      id: `h${h}` as StopId,
      label: `+${h}h`,
      tMs: covered && fc ? fc.startMs + h * HOUR : null,
      kind: 'forecast',
      available: covered,
      reason: covered ? null : fc ? `This forecast covers ${fc.horizonH} h` : missingReason(status, live),
      posMs: nominal,
      description: `${h} h after the forecast start`,
    })
  }

  const notes: string[] = []
  if (fc && live) {
    if (latest - fc.startMs > HOUR) notes.push(`This forecast starts ${hoursText(latest - fc.startMs)} before the latest observation, so it does not include the newest data.`)
    if (wallClockMs > fc.endMs) notes.push(`This forecast period ended ${hoursText(wallClockMs - fc.endMs)} ago.`)
  }

  const { currentKind, inForecastPeriod, leadH } = describeTime({ startMs: tr.start_ms, latestObservationMs: latest, forecast: fc }, timeMs)

  return {
    mode: manifest.mode,
    startMs: tr.start_ms,
    endMs,
    segments,
    latestObservationMs: latest,
    nowMarkerMs: nowMark,
    wallClockMs,
    forecast: fc,
    stops,
    stale: { isStale, ageMs, thresholdMs: STALE_AFTER_MS },
    currentMs: timeMs,
    currentKind,
    trackEndMs,
    unavailable,
    anchorMs,
    inForecastPeriod,
    leadH,
    forecastStatus: status,
    forecastNotes: notes,
    checkedMs: manifest.built_ms,
  }
}

export interface TimeDescription {
  currentKind: CompactTimelineModel['currentKind']
  inForecastPeriod: boolean
  leadH: number | null
}

/** What the timeline shows at tMs: observations (inside the record), forecast only (after the latest observation,
 *  inside the forecast) or nothing ('beyond'); plus the forecast lead time when tMs is inside its period. */
export function describeTime(m: Pick<CompactTimelineModel, 'startMs' | 'latestObservationMs' | 'forecast'>, tMs: number): TimeDescription {
  const fc = m.forecast
  const inForecastPeriod = fc != null && tMs >= fc.startMs && tMs <= fc.endMs
  let currentKind: CompactTimelineModel['currentKind'] = 'beyond'
  if (tMs >= m.startMs && tMs <= m.latestObservationMs) currentKind = 'observation'
  else if (fc && inForecastPeriod && tMs > m.latestObservationMs) currentKind = 'forecast'
  return { currentKind, inForecastPeriod, leadH: inForecastPeriod && fc ? (tMs - fc.startMs) / HOUR : null }
}

/** Clamp a time into the part of the track that has data (never into unavailable hours). */
export function clampToData(m: Pick<CompactTimelineModel, 'startMs' | 'endMs'>, tMs: number): number {
  return clamp(tMs, m.startMs, m.endMs)
}

/** The stop whose time is within `toleranceMs` of tMs (the "active" stop), else null. */
export function activeStop(m: Pick<CompactTimelineModel, 'stops'>, tMs: number, toleranceMs = 30 * 60_000): TimelineStop | null {
  let best: TimelineStop | null = null
  for (const s of m.stops) {
    if (!s.available || s.tMs == null) continue
    const d = Math.abs(s.tMs - tMs)
    if (d <= toleranceMs && (best == null || d < Math.abs((best.tMs as number) - tMs))) best = s
  }
  return best
}

/** Centre positions for labels of the given widths, kept in order, `gap` apart and inside [lo, hi] where the space
 *  allows (labels near their wanted centres; used for the stop labels under the track). */
export function spreadLabels(centers: readonly number[], widths: readonly number[], lo: number, hi: number, gap = 4): number[] {
  const n = centers.length
  const c = centers.map((x, i) => clamp(x, lo + widths[i] / 2, Math.max(lo + widths[i] / 2, hi - widths[i] / 2)))
  for (let i = 1; i < n; i++) c[i] = Math.max(c[i], c[i - 1] + (widths[i - 1] + widths[i]) / 2 + gap)
  if (n) c[n - 1] = Math.min(c[n - 1], Math.max(lo + widths[n - 1] / 2, hi - widths[n - 1] / 2))
  for (let i = n - 2; i >= 0; i--) c[i] = Math.min(c[i], c[i + 1] - (widths[i] + widths[i + 1]) / 2 - gap)
  return c
}

/** True when every spread label still covers the point it marks (used to fall back to short stop labels). */
export function labelsCoverPoints(points: readonly number[], centers: readonly number[], widths: readonly number[]): boolean {
  return centers.every((c, i) => Math.abs(c - points[i]) <= widths[i] / 2 + 0.5)
}

// ------------------------------------------------------------------------------------------------- track scale
export interface TrackZone {
  kind: 'past' | 'forecast' | 'after'
  startMs: number
  endMs: number
  /** Fraction of the track width [f0, f1]. */
  f0: number
  f1: number
}

export interface TrackScale {
  zones: TrackZone[]
  /** Time -> fraction of the track width (clamped to [0, 1]). */
  toFrac: (tMs: number) => number
  /** Fraction -> time (clamped to the track). */
  toTime: (frac: number) => number
}

/** Minimum share of the track width per zone (past / forecast / after the forecast). */
export const ZONE_MIN = { past: 0.22, forecast: 0.42, after: 0.12 } as const

/** Fractions proportional to `durations`, raised to `mins` where needed (zero-length zones get 0). */
export function allocateFractions(durations: number[], mins: number[]): number[] {
  const n = durations.length
  const fixed = new Array<boolean>(n).fill(false)
  let out = new Array<number>(n).fill(0)
  for (let iter = 0; iter <= n; iter++) {
    const freeDur = durations.reduce((a, d, i) => a + (fixed[i] || d <= 0 ? 0 : d), 0)
    const fixedSum = out.reduce((a, v, i) => a + (fixed[i] ? v : 0), 0)
    const rest = Math.max(0, 1 - fixedSum)
    out = out.map((v, i) => (fixed[i] ? v : durations[i] > 0 && freeDur > 0 ? (durations[i] / freeDur) * rest : 0))
    let changed = false
    for (let i = 0; i < n; i++) {
      if (!fixed[i] && durations[i] > 0 && out[i] < mins[i]) {
        fixed[i] = true
        out[i] = mins[i]
        changed = true
      }
    }
    if (!changed) break
  }
  const sum = out.reduce((a, v) => a + v, 0)
  return sum > 0 ? out.map((v) => v / sum) : out
}

/** Piecewise-linear track scale: the record before the forecast, the forecast period (incl. unavailable hours) and
 *  any record after it get readable shares of the width, each linear inside. A 30-day record therefore does not
 *  squeeze the +24/+48/+72 h stops into a few pixels; the zone edges are drawn so the change of scale stays visible. */
export function trackScale(m: Pick<CompactTimelineModel, 'startMs' | 'trackEndMs' | 'anchorMs' | 'forecast' | 'unavailable'>): TrackScale {
  const t0 = m.startMs
  const t3 = Math.max(m.trackEndMs, t0 + 1)
  const a = clamp(m.anchorMs, t0, t3)
  const fEnd = Math.max(m.forecast?.endMs ?? a, m.unavailable?.endMs ?? a)
  const b = clamp(fEnd > a ? fEnd : t3, a, t3)
  const spans: [TrackZone['kind'], number, number][] = [
    ['past', t0, a],
    ['forecast', a, b],
    ['after', b, t3],
  ]
  const fr = allocateFractions(
    spans.map(([, s, e]) => e - s),
    spans.map(([k]) => ZONE_MIN[k]),
  )
  const zones: TrackZone[] = []
  let acc = 0
  spans.forEach(([kind, s, e], i) => {
    if (e > s) zones.push({ kind, startMs: s, endMs: e, f0: acc, f1: acc + fr[i] })
    acc += fr[i]
  })
  if (zones.length) zones[zones.length - 1].f1 = 1
  const toFrac = (t: number) => {
    const tc = clamp(t, t0, t3)
    for (const z of zones) if (tc <= z.endMs) return z.f0 + ((tc - z.startMs) / (z.endMs - z.startMs)) * (z.f1 - z.f0)
    return 1
  }
  const toTime = (fr0: number) => {
    const f = clamp(fr0, 0, 1)
    for (const z of zones) if (f <= z.f1) return z.startMs + ((f - z.f0) / Math.max(1e-9, z.f1 - z.f0)) * (z.endMs - z.startMs)
    return t3
  }
  return { zones, toFrac, toTime }
}

/** "forecast" (live), "hindcast" (Command replay) or "model re-run" (Public replay: plain words, brief 2 C-R8). */
export function forecastWord(mode: Mode, command: boolean): string {
  return mode === 'live' ? 'forecast' : command ? 'hindcast' : 'model re-run'
}
