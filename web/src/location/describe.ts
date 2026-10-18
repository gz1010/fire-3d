// Plain-language location card model (owner: location; BRIEF §8). Turns a LocationReport into short sentences in
// everyday units, keeping the model semantics exact:
// - burn chance is the share of ensemble runs that burned the spot by the END of the forecast horizon, always stated
//   with that end time and horizon (never relabelled as a shorter period);
// - P10 / P50 / P90 are arrival-time quantiles ("10 % of runs had reached it by ..."), never scenarios or a worst case;
// - "at the selected time" uses only the exact statement arrival_pK <= t  <=>  at least K % of runs had reached it;
// - never-burned, missing forecast, nodata and outside-the-modeled-area are said as such (outside = unknown, not low);
// - no qualitative risk categories (no defensible thresholds exist for them here).
import type { Mode } from '../api/types'
import { satelliteName } from '../lib/format'
import { area, directionWord, distance, elevation, ensemblePhrase, forecastPeriod, weatherSourceName, windSpeed } from '../lib/plainLanguage'
import { fmtDateTime, fmtDateTimeYearTz, fmtRelative, tzLabel } from '../lib/time'
import { formatLat, formatLatLon, formatLon } from '../lib/geodesy'
import type { Preset, Units } from '../state/workspace'
import type { ArrivalQuantile, LocationReport, ModelGap, ReportSource } from './types'

export type Tone = 'fire' | 'forecast' | 'detection' | 'select' | 'muted' | 'warn' | 'unknown'
/** What kind of statement a line is (shown as a small tag; never only by colour). */
export type LineKind = 'Mapped' | 'Estimate' | 'Observed' | 'Model' | 'Unknown' | 'Approximate' | null

export interface CardLine {
  key: string
  label: string
  text: string
  /** Secondary plain-language detail (source, exact time, period). */
  detail: string | null
  /** Original scientific values (shown in Command and in the details disclosure). */
  technical: string | null
  tone: Tone
  kind: LineKind
}

export interface CardSection {
  key: 'fire' | 'forecast' | 'conditions'
  title: string
  lines: CardLine[]
}

/** The card's always-visible part; the remaining lines go into the details disclosure. */
export interface CardSummary {
  /** Inside / distance from the latest perimeter (or estimated burned area), with its time (source in the details). */
  perimeter: { text: string; sub: string | null; tone: Tone; kind: LineKind }
  /** Keys of section lines shown in the summary as text only; the details list the others plus these lines' notes. */
  keys: string[]
  /** Burn chance as a short figure ("23%") when there is a value; null for gaps and burned-at-start. */
  burnFigure: string | null
  /** The burn-chance sentence to show next to the figure (no repeated percentage). */
  burnText: string | null
  /** "Wind 18 mph from the northeast · 1,520 ft, 30% slope, faces west". */
  conditions: string | null
}

export interface LocationCardModel {
  title: string
  /** The title is the coordinates themselves (no separate coordinate line needed). */
  titleIsCoords: boolean
  locationType: string
  approximate: boolean
  /** "34.18964° N", "118.13739° W". */
  lat: string
  lon: string
  headline: { text: string; tone: Tone; kind: LineKind }
  /** Second headline when the point is outside the modeled area (unknown, not low). */
  areaNote: string | null
  /** Every line in full (labels, details, scientific values). */
  sections: CardSection[]
  summary: CardSummary
  /** The details disclosure: lines not in the summary, plus the source / period / meaning notes of summary lines. */
  details: CardSection[]
  sources: { text: string; kind: ReportSource['kind'] }[]
  caveats: string[]
}

export interface DescribeOptions {
  units: Units
  preset: Preset
  /** Live or historical data context (relative times vs. times before the selected moment). */
  mode: Mode
  nowMs: number
}

const at = (ms: number) => `${fmtDateTime(ms)} ${tzLabel(ms)}`

/** "3 h", "45 min", "2 days". */
export function span(ms: number): string {
  const a = Math.abs(ms)
  if (a < 3_600_000) return `${Math.max(1, Math.round(a / 60_000))} min`
  if (a < 48 * 3_600_000) return `${Math.round(a / 3_600_000)} h`
  return `${Math.round(a / 86_400_000)} days`
}

/** How old a time is relative to the selected time (historical) or the wall clock (live). */
function age(ms: number, r: LocationReport, o: DescribeOptions): string {
  if (o.mode === 'live') return fmtRelative(ms, o.nowMs)
  const d = r.timeMs - ms
  if (Math.abs(d) < 60_000) return 'at the selected time'
  return d > 0 ? `${span(d)} before the selected time` : `${span(d)} after the selected time`
}

const pct = (f: number) => {
  const p = f * 100
  if (p > 0 && p < 1) return '<1%'
  if (p < 100 && p > 99) return '>99%'
  return `${Math.round(p)}%`
}

function gapText(gap: ModelGap, what: string): string {
  switch (gap) {
    case 'outside_modeled_area':
      return `Outside modeled area: no ${what} here. Unknown, not low.`
    case 'no_bundle':
      return 'Incident data not loaded.'
    case 'no_forecast':
      return 'No forecast is available for this incident.'
    case 'loading':
      return `Loading ${what}…`
    case 'error':
      return `The ${what} failed to load.`
    case 'nodata':
      return `No ${what} value for this spot (no data).`
  }
}

// ------------------------------------------------------------------------------------------------- headline
function headline(r: LocationReport, o: DescribeOptions): LocationCardModel['headline'] {
  const p = r.perimeter
  if (r.modeledArea === 'no_bundle' && p.state !== 'ok') return { text: 'No incident data loaded for this check', tone: 'muted', kind: 'Unknown' }
  if (p.state === 'ok') {
    const what = p.basis === 'mapped' ? 'the latest mapped fire perimeter' : 'the estimated burned area'
    const kind: LineKind = p.basis === 'mapped' ? 'Mapped' : 'Estimate'
    if (p.inside) return { text: `Inside ${what}`, tone: 'fire', kind }
    const dir = p.directionDeg != null ? ` ${directionWord(p.directionDeg)}` : ''
    return { text: `${distance(p.distanceM, o.units).text}${dir} of ${what}`, tone: 'select', kind }
  }
  switch (p.reason) {
    case 'loading':
      return { text: 'Checking the fire perimeter…', tone: 'muted', kind: null }
    case 'error':
      return { text: 'Fire perimeter data failed to load', tone: 'warn', kind: 'Unknown' }
    case 'no_perimeters':
      return { text: 'No mapped fire perimeter for this incident', tone: 'muted', kind: 'Unknown' }
    default:
      return { text: 'No mapped perimeter or estimated burned area by the selected time', tone: 'muted', kind: null }
  }
}

// ------------------------------------------------------------------------------------------------- fire
function fireSection(r: LocationReport, o: DescribeOptions): CardSection {
  const lines: CardLine[] = []
  const p = r.perimeter
  if (p.state === 'ok') {
    const mapped = p.basis === 'mapped'
    const text = p.inside
      ? `Inside${p.edgeDistanceM > 0 ? `, ${distance(p.edgeDistanceM, o.units).text} from the edge` : ', on the edge'}`
      : `${distance(p.distanceM, o.units).text}${p.directionDeg != null ? ` ${directionWord(p.directionDeg)}` : ''} of it`
    const detail = mapped
      ? `${p.perimeterSource} · mapped ${at(p.perimeterTimeMs)} (${age(p.perimeterTimeMs, r, o)}) · ${area(p.perimeterAcres, o.units).text}`
      : `${p.perimeterSource}, for ${at(p.perimeterTimeMs)} · ${area(p.perimeterAcres, o.units).text}${p.latestDetectionMs != null ? ` · latest detection ${at(p.latestDetectionMs)}` : ''}`
    lines.push({
      key: 'perimeter',
      label: mapped ? 'Mapped perimeter' : 'Estimated burned area',
      text,
      detail,
      technical: `Nearest edge point ${formatLat(p.nearest.lat)}, ${formatLon(p.nearest.lon)} · geodesic distance ${Math.round(p.inside ? p.edgeDistanceM : p.distanceM)} m${p.directionDeg != null ? ` · bearing ${p.directionDeg.toFixed(1)}° true` : ''}`,
      tone: p.inside ? 'fire' : 'select',
      kind: mapped ? 'Mapped' : 'Estimate',
    })
  } else if (p.reason !== 'no_bundle') {
    const text =
      p.reason === 'loading'
        ? 'Loading…'
        : p.reason === 'error'
          ? 'Failed to load.'
          : p.reason === 'no_perimeters'
            ? 'No mapped perimeter or burned-area estimate for this incident.'
            : `None mapped or estimated by ${at(r.timeMs)}.`
    lines.push({ key: 'perimeter', label: 'Fire perimeter', text, detail: null, technical: null, tone: 'muted', kind: p.reason === 'error' ? 'Unknown' : null })
  }
  const f = r.observedFire
  if (f.state === 'burned')
    lines.push({
      key: 'observed',
      label: 'This spot',
      text: `Burned around ${at(f.arrivalMs)}`,
      detail: 'Arrival time interpolated between satellite passes and mapped perimeters',
      technical: null,
      tone: 'fire',
      kind: 'Estimate',
    })
  else if (f.state === 'not_burned')
    lines.push({ key: 'observed', label: 'This spot', text: `Not burned by ${at(f.asOfMs)}, as far as satellite observations show`, detail: null, technical: null, tone: 'muted', kind: 'Estimate' })
  else if (f.gap !== 'outside_modeled_area' && f.gap !== 'no_bundle')
    lines.push({ key: 'observed', label: 'This spot', text: gapText(f.gap, 'fire reconstruction'), detail: null, technical: null, tone: 'unknown', kind: 'Unknown' })
  const d = r.nearestDetection
  if (d.state === 'ok')
    lines.push({
      key: 'detection',
      label: 'Nearest satellite detection',
      text: `${distance(d.distanceM, o.units).text} ${directionWord(d.directionDeg)}, ${at(d.tMs)} (${age(d.tMs, r, o)})`,
      detail: `${d.instrument} on ${satelliteName(d.satellite)}, pixel about ${distance(d.footprintM, o.units).text} wide. A detection marks a hot pixel, not the fire's edge.`,
      technical: `${d.count} detection${d.count === 1 ? '' : 's'} in the ${d.windowH} h before the selected time · bearing ${d.directionDeg.toFixed(1)}° true · ${Math.round(d.distanceM)} m`,
      tone: 'detection',
      kind: 'Observed',
    })
  else if (r.modeledArea !== 'no_bundle')
    lines.push({ key: 'detection', label: 'Nearest satellite detection', text: `None in the ${d.windowH} h before the selected time`, detail: null, technical: null, tone: 'muted', kind: null })
  return { key: 'fire', title: 'Fire', lines }
}

// ------------------------------------------------------------------------------------------------- forecast
/** "10% of runs by Jan 9, 14:53 PST", "90%: not reached by the end", "50%: no data". */
function quantileText(k: 10 | 50 | 90, q: ArrivalQuantile, first: boolean): string {
  const share = `${k}%${first ? ' of runs' : ''}`
  if (q.state === 'time') return `${share} by ${q.atStart ? 'the start' : at(q.ms)}`
  if (q.state === 'not_reached') return `${share}: not reached by the end`
  return `${share}: no data`
}

function forecastSection(r: LocationReport, o: DescribeOptions): CardSection {
  const f = r.forecast
  if (f.state === 'gap') {
    if (f.gap === 'no_bundle') return { key: 'forecast', title: 'Forecast', lines: [] }
    const text =
      f.gap === 'outside_modeled_area'
        ? 'Not covered by the forecast: outside the modeled area, so unknown (not low).'
        : f.gap === 'no_forecast'
          ? 'No forecast is available for this incident.'
          : gapText(f.gap, 'forecast')
    return { key: 'forecast', title: 'Forecast', lines: [{ key: 'forecast-gap', label: 'Model forecast', text, detail: null, technical: null, tone: f.gap === 'loading' ? 'muted' : 'unknown', kind: f.gap === 'loading' ? null : 'Unknown' }] }
  }
  const lines: CardLine[] = []
  const period = forecastPeriod({ start_ms: f.startMs, horizon_h: f.horizonH })
  const endText = at(f.endMs)
  lines.push({
    key: 'period',
    label: f.hindcast ? 'Hindcast period' : 'Forecast period',
    text: period,
    detail: f.hindcast
      ? `Re-run after the fact on archived weather (a hindcast), computed ${fmtDateTimeYearTz(f.issuedMs)}. ${ensemblePhrase(f.ensemble, f.members)}.`
      : `Issued ${at(f.issuedMs)} (${fmtRelative(f.issuedMs, o.nowMs)}). ${ensemblePhrase(f.ensemble, f.members)}.`,
    technical: `Run ${f.runId} · ${f.model.engine} ${f.model.version} · ${Math.round(f.model.gridResM)} m grid · crown fire ${f.model.crown ? 'on' : 'off'} · spotting ${f.model.spotting ? 'on' : 'off'}`,
    tone: 'forecast',
    kind: 'Model',
  })
  // burn chance over the whole horizon
  let bpText: string
  if (f.burnedAtStart) bpText = `Already burned when the ${f.hindcast ? 'hindcast' : 'forecast'} started (${at(f.startMs)})`
  else if (f.burnProbability.state === 'nodata') bpText = 'No burn-chance value for this spot (no data).'
  else {
    const fr = f.burnProbability.fraction
    const n = f.burnedMembers
    const by = `by ${endText}, the end of the ${f.horizonH}-hour ${f.hindcast ? 'hindcast' : 'forecast'}`
    if (fr === 0) bpText = `None of the ${f.members} model runs burned this spot ${by}`
    else if (fr === 1) bpText = `All ${f.members} model runs burned this spot ${by}`
    else bpText = `${n != null ? `${n} of ${f.members} model runs (${pct(fr)})` : `${pct(fr)} of model runs`} burned this spot ${by}`
  }
  lines.push({
    key: 'burn-chance',
    label: `Burn chance over ${f.horizonH} h`,
    text: bpText,
    detail: f.burnedAtStart
      ? 'The model starts from the burned area observed at the forecast start, so every run counts this spot as burned.'
      : f.burnProbability.state === 'value' && f.burnProbability.fraction === 0
        ? 'No run reaching it is not a guarantee: the model can miss spread it does not simulate.'
        : 'Share of the model runs, not a guarantee and not an official forecast.',
    technical: f.burnProbability.state === 'value' ? `burn_probability ${f.burnProbability.fraction.toFixed(3)} (fraction of ${f.members} members burned by start + ${f.horizonH} h)` : 'burn_probability: no data',
    tone: 'forecast',
    kind: 'Model',
  })
  // the observation contradicts the model: the fire reached the spot during the run's period (as observed by the
  // selected time) while no run did. Said plainly instead of leaving two conflicting statements side by side.
  const obs = r.observedFire
  if (!f.burnedAtStart && f.burnProbability.state === 'value' && f.burnProbability.fraction === 0 && obs.state === 'burned' && obs.arrivalMs > f.startMs && obs.arrivalMs <= f.endMs)
    lines.push({
      key: 'model-missed',
      label: 'Model and observation differ',
      text: `The fire reached this spot around ${at(obs.arrivalMs)}, but none of the model runs did`,
      detail: 'Real fires can spread in ways the model does not capture, such as embers and fire moving from building to building.',
      technical: null,
      tone: 'warn',
      kind: 'Estimate',
    })
  if (!f.burnedAtStart) {
    const qs = [f.arrival.p10, f.arrival.p50, f.arrival.p90]
    const allNever = qs.every((q) => q.state === 'not_reached')
    lines.push({
      key: 'arrival',
      label: 'Modeled arrival time',
      text: allNever
        ? `No model run reached this spot by ${endText}`
        : [quantileText(10, f.arrival.p10, true), quantileText(50, f.arrival.p50, false), quantileText(90, f.arrival.p90, false)].join(' · '),
      detail: 'Arrival-time quantiles: the times by which 10%, 50% and 90% of the runs had reached this spot. They are not best- or worst-case scenarios.',
      technical: `arrival_p10 / p50 / p90: ${qs.map((q) => (q.state === 'time' ? at(q.ms) : q.state === 'not_reached' ? 'NEVER' : 'nodata')).join(' / ')}`,
      tone: 'forecast',
      kind: 'Model',
    })
  }
  // the selected time: exact statements only (arrival_pK <= t  <=>  at least K % of runs had reached the spot)
  const t = r.timeMs
  const k = f.reachedShareAtTime
  const run = f.hindcast ? 'hindcast' : 'forecast'
  let atTime: string | null = null
  if (k === 90) atTime = `At least 90% of runs had reached this spot by ${at(t)}`
  else if (k === 50) atTime = `At least half (but fewer than 90%) of the runs had reached this spot by ${at(t)}`
  else if (k === 10) atTime = `At least 10% (but fewer than half) of the runs had reached this spot by ${at(t)}`
  else if (k === 0) atTime = `Fewer than 10% of runs had reached this spot by ${at(t)}`
  else if (t < f.startMs) atTime = `The selected time is before the ${run} starts.`
  else if (t > f.endMs) atTime = `The selected time is after the ${run} ends.`
  const noneReach = [f.arrival.p10, f.arrival.p50, f.arrival.p90].every((q) => q.state === 'not_reached') // said above
  if (!f.burnedAtStart && atTime && !(noneReach && k === 0)) lines.push({ key: 'at-time', label: 'At the selected time', text: atTime, detail: null, technical: null, tone: k == null ? 'muted' : 'forecast', kind: k == null ? null : 'Model' })
  return { key: 'forecast', title: f.hindcast ? 'Model hindcast (past weather)' : 'Model forecast', lines }
}

// ------------------------------------------------------------------------------------------------- conditions
function conditionsSection(r: LocationReport, o: DescribeOptions): CardSection {
  const lines: CardLine[] = []
  const w = r.wind
  if (w.state === 'ok') {
    const sp = windSpeed(w.speedMs, o.units)
    const gust = w.gustMs != null ? `, gusts ${windSpeed(w.gustMs, o.units).text}` : ''
    lines.push({
      key: 'wind',
      label: w.where === 'fire' ? 'Wind at the fire' : 'Wind here',
      text: `${sp.text} from the ${directionWord(w.fromDeg)}${gust}`,
      detail: `${at(w.tMs)} · ${weatherSourceName(w.source)}${w.isForecast ? ' (forecast hour)' : ''}. Direction is where the wind blows from.`,
      technical: `${w.speedMs.toFixed(1)} m/s from ${Math.round(w.fromDeg)}°${w.gustMs != null ? `, gusts ${w.gustMs.toFixed(1)} m/s` : ''}`,
      tone: 'muted',
      kind: 'Model',
    })
    if (w.atPoint && w.where === 'fire')
      lines.push({
        key: 'wind-here',
        label: 'Wind here',
        text: `${windSpeed(w.atPoint.speedMs, o.units).text} from the ${directionWord(w.atPoint.fromDeg)}`,
        detail: `Nearest cell of the model's weather grid (cells about ${distance(w.atPoint.cellSizeM, o.units).text} wide)`,
        technical: `${w.atPoint.speedMs.toFixed(1)} m/s from ${Math.round(w.atPoint.fromDeg)}°`,
        tone: 'muted',
        kind: 'Model',
      })
  } else if (r.modeledArea !== 'no_bundle') lines.push({ key: 'wind', label: 'Wind', text: 'No wind data for the selected time.', detail: null, technical: null, tone: 'muted', kind: 'Unknown' })
  const g = r.terrain
  if (g.state === 'ok') {
    const parts: string[] = []
    if (g.elevationM != null) parts.push(elevation(g.elevationM, o.units).text)
    if (g.slopePct != null) parts.push(g.slopePct < 1 ? 'flat' : `${Math.round(g.slopePct)}% slope`)
    if (g.aspectDeg != null) parts.push(`faces ${directionWord(g.aspectDeg)}`)
    if (parts.length)
      lines.push({
        key: 'terrain',
        label: 'Terrain',
        text: parts.join(' · '),
        detail: 'From the incident elevation model; slope and facing direction from neighbouring cells.',
        technical: `${g.elevationM != null ? `${Math.round(g.elevationM)} m` : ''}${g.slopePct != null ? ` · slope ${g.slopePct.toFixed(1)}%` : ''}${g.aspectDeg != null ? ` · aspect ${Math.round(g.aspectDeg)}° (downslope)` : ''}`,
        tone: 'muted',
        kind: null,
      })
    if (g.fuelCode != null)
      lines.push({
        key: 'fuel',
        label: 'Vegetation (fuel)',
        text: g.burnable === false ? `${g.fuelName} (${g.fuelLabel}): mapped as non-burnable fuel` : `${g.fuelName} (${g.fuelLabel})`,
        detail: 'LANDFIRE fuel model (Scott & Burgan 40) used by the spread model.',
        technical: `FBFM40 code ${g.fuelCode}`,
        tone: 'muted',
        kind: null,
      })
  } else if (g.gap !== 'no_bundle' && g.gap !== 'outside_modeled_area')
    lines.push({ key: 'terrain', label: 'Terrain', text: gapText(g.gap, 'terrain data'), detail: null, technical: null, tone: 'muted', kind: g.gap === 'loading' ? null : 'Unknown' })
  return { key: 'conditions', title: 'Conditions', lines }
}

// ------------------------------------------------------------------------------------------------- summary
/** One short line under the headline: distance to the edge when inside, and the perimeter's time (its source, area
 *  and latest detection are in the details). */
function perimeterSub(r: LocationReport, o: DescribeOptions): string | null {
  const p = r.perimeter
  if (p.state !== 'ok') return null
  const sub =
    p.basis === 'reconstructed'
      ? `${p.inside ? `${distance(p.edgeDistanceM, o.units).text} from its edge · ` : ''}estimated from satellite detections for ${at(p.perimeterTimeMs)} (${age(p.perimeterTimeMs, r, o)})`
      : `${p.inside ? `${distance(p.edgeDistanceM, o.units).text} from the edge · ` : ''}mapped ${at(p.perimeterTimeMs)} (${age(p.perimeterTimeMs, r, o)})`
  return sub.charAt(0).toUpperCase() + sub.slice(1)
}

/** The observed-fire line joins the summary unless it only repeats the headline (not burned, outside the perimeter). */
function observedInSummary(r: LocationReport): boolean {
  const p = r.perimeter
  return !(r.observedFire.state === 'not_burned' && p.state === 'ok' && !p.inside)
}

/** No run reached the spot: the burn-chance sentence already says so, so the arrival line stays in the details. */
function noRunReached(r: LocationReport): boolean {
  const f = r.forecast
  return f.state === 'ok' && [f.arrival.p10, f.arrival.p50, f.arrival.p90].every((q) => q.state === 'not_reached') && f.burnProbability.state === 'value' && f.burnProbability.fraction === 0
}

/** Summary lines whose detail (source, period, meaning) moves into the disclosure as a note of its own. */
const NOTE_KEYS = new Set(['perimeter', 'burn-chance', 'arrival', 'model-missed'])

function detailsOf(sections: CardSection[], keys: string[]): CardSection[] {
  return sections
    .map((s) => ({
      ...s,
      lines: s.lines.flatMap((l): CardLine[] => {
        if (!keys.includes(l.key)) return [l]
        return NOTE_KEYS.has(l.key) && l.detail ? [{ ...l, key: `${l.key}-note`, text: l.detail, detail: null, technical: null }] : []
      }),
    }))
    .filter((s) => s.lines.length)
}

function conditionsShort(r: LocationReport, o: DescribeOptions): string | null {
  const parts: string[] = []
  if (r.wind.state === 'ok')
    parts.push(
      `Wind ${r.wind.where === 'fire' ? 'at the fire' : 'here'} ${windSpeed(r.wind.speedMs, o.units).text} from the ${directionWord(r.wind.fromDeg)}${r.wind.gustMs != null ? `, gusts ${windSpeed(r.wind.gustMs, o.units).text}` : ''}`,
    )
  const g = r.terrain
  if (g.state === 'ok') {
    const t: string[] = []
    if (g.elevationM != null) t.push(elevation(g.elevationM, o.units).text)
    if (g.slopePct != null) t.push(g.slopePct < 1 ? 'flat' : `${Math.round(g.slopePct)}% slope`)
    if (g.aspectDeg != null) t.push(`faces ${directionWord(g.aspectDeg)}`)
    if (t.length) parts.push(t.join(', '))
  }
  return parts.length ? parts.join(' · ') : null
}

function summaryOf(r: LocationReport, o: DescribeOptions, h: LocationCardModel['headline'], present: Set<string>): CardSummary {
  const f = r.forecast
  const value = f.state === 'ok' && !f.burnedAtStart && f.burnProbability.state === 'value' ? f.burnProbability.fraction : null
  let burnText: string | null = null
  if (f.state === 'ok' && value != null) {
    const by = `by ${at(f.endMs)}, the end of the ${f.horizonH}-hour ${f.hindcast ? 'hindcast' : 'forecast'}`
    const n = f.burnedMembers
    burnText =
      value === 0
        ? `None of the ${f.members} model runs burned this spot ${by}`
        : value === 1
          ? `All ${f.members} model runs burned this spot ${by}`
          : n != null
            ? `${n} of ${f.members} model runs burned this spot ${by}`
            : `of model runs burned this spot ${by}`
  }
  return {
    perimeter: { ...h, sub: perimeterSub(r, o) },
    // outside the modeled area the area note already says the forecast does not cover the spot
    keys: [
      'perimeter',
      ...(observedInSummary(r) ? ['observed'] : []),
      ...(f.state === 'gap' && f.gap === 'outside_modeled_area' ? [] : ['forecast-gap']),
      'burn-chance',
      'model-missed',
      ...(noRunReached(r) ? [] : ['arrival']),
    ].filter((k) => present.has(k)),
    burnFigure: value != null ? pct(value) : null,
    burnText,
    conditions: conditionsShort(r, o),
  }
}

// ------------------------------------------------------------------------------------------------- card
const KIND_WORD: Record<ReportSource['kind'], string> = { observation: 'Observation', estimate: 'Estimate', model: 'Model', official: 'Official', reference: 'Reference' }

export function describeLocation(r: LocationReport, o: DescribeOptions): LocationCardModel {
  const sections = [fireSection(r, o), forecastSection(r, o), conditionsSection(r, o)].filter((s) => s.lines.length)
  const head = headline(r, o)
  const summary = summaryOf(r, o, head, new Set(sections.flatMap((s) => s.lines.map((l) => l.key))))
  return {
    title: r.point.label,
    titleIsCoords: !r.point.address && r.point.label === formatLatLon(r.point.lat, r.point.lon, 5),
    locationType: r.point.locationType,
    approximate: r.point.approximate,
    lat: formatLat(r.point.lat),
    lon: formatLon(r.point.lon),
    headline: head,
    areaNote: r.modeledArea === 'outside' ? 'Outside modeled area: the forecast and fire reconstruction do not cover this spot. Unknown, not low risk.' : null,
    sections,
    summary,
    details: detailsOf(sections, summary.keys),
    // with the year: source times can be far from the fire (a hindcast computed later, reference data fetched earlier)
    sources: r.sources.map((s) => ({ text: `${KIND_WORD[s.kind]}: ${s.name}${s.timeMs != null ? ` · ${fmtDateTimeYearTz(s.timeMs)}` : ''}`, kind: s.kind })),
    caveats: r.caveats,
  }
}
