// Plain-language location card model (owner: location; BRIEF §8, brief 2 C-R6/C-R8). Turns a LocationReport into short
// sentences in everyday units, keeping the model semantics exact:
// - burn chance is the share of ensemble runs that burned the spot by the END of the forecast horizon, always stated
//   with that end time and horizon (never relabelled as a shorter period); in Public it is a dated sentence
//   ("In the experimental model, 0 of 31 simulated fires reached here by Oct 20, 15:50 (72 h)"), Command keeps the figure;
// - P10 / P50 / P90 are arrival-time quantiles ("1 in 10 simulated fires had reached here by ..."), never scenarios or a
//   worst case;
// - "at the selected time" uses only the exact statement arrival_pK <= t  <=>  at least K % of runs had reached it;
// - never-burned, missing forecast, nodata and outside-the-modeled-area are said as such (outside = unknown, not low);
// - no qualitative risk categories: dryness is given as numbers, and only an official threshold (an NWS Red Flag
//   Warning in effect) is cited as such.
// The first view has four short blocks (brief 2 decision 6): near here; official information (official.ts); up to three
// main reasons, each tagged, plus the model sentence; updated and reliability. Details stay one tap away.
import type { Mode } from '../api/types'
import { satelliteName } from '../lib/format'
import { area, directionWord, distance, elevation, ensemblePhrase, forecastPeriod, weatherSourceName, windSpeed } from '../lib/plainLanguage'
import { fmtAt, fmtRelative, type TimeFmt } from '../lib/time'
import { formatLat, formatLatLon, formatLon } from '../lib/geodesy'
import type { Preset, Units } from '../state/workspace'
import { STALE_AFTER_MS } from '../ui/timeline/model'
import type { ArrivalQuantile, LocationReport, ModelGap, ReportSource } from './types'

export type Tone = 'fire' | 'forecast' | 'detection' | 'select' | 'muted' | 'warn' | 'unknown'
/** What kind of statement a line is (shown as a small tag; never only by colour). */
export type LineKind = 'Mapped' | 'Estimate' | 'Observed' | 'Model' | 'Unknown' | 'Approximate' | 'Official' | 'Terrain data' | null

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

/** Block 1: what is happening near the selected location. */
export interface NearHere {
  /** "Inside the mapped fire area", "0.8 mi east of the mapped fire edge". */
  text: string
  /** Distance to the edge when inside, and the basis time with its age. */
  sub: string | null
  kind: LineKind
  tone: Tone
  /** "Burned around Jan 8, 07:39 PST" (an estimate) when the spot burned by the selected time. */
  burned: string | null
  /** Live data older than the timeline's stale threshold. */
  stale: boolean
}

/** Block 3: one main reason, tagged. */
export interface Reason {
  key: 'wind' | 'dryness' | 'terrain'
  label: string
  text: string
  kind: LineKind
  /** An official threshold cited with it (the NWS Red Flag Warning in effect here). */
  official: string | null
}

/** Block 3: the model. Public says it as a dated sentence; Command keeps the figure. */
export interface ModelSummary {
  text: string
  /** "1 in 10 simulated fires had reached here by …, half by …" (when runs reached the spot). */
  arrival: string | null
  /** The fire reached the spot during the run's period, but no run did. */
  missed: string | null
  /** Command: the burn share as a figure ("23%"); null in Public and for gaps. */
  figure: string | null
  kind: LineKind
  tone: Tone
}

/** Command: the model run and the arrival quantiles up front (C-R8). */
export interface CommandRun {
  run: string
  quantiles: string | null
}

/** Block 4: updated and reliability. */
export interface ReliabilityLine {
  key: 'fire-data' | 'model' | 'prototype'
  text: string
  stale: boolean
}

/** The card's always-visible part; the remaining lines go into the details disclosure. */
export interface CardSummary {
  near: NearHere
  reasons: Reason[]
  model: ModelSummary | null
  /** Command only. */
  run: CommandRun | null
  reliability: ReliabilityLine[]
  /** Keys of section lines the summary already states; the details keep only their notes. */
  keys: string[]
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
  /** The official fire weather threshold in effect at the point, e.g. "NWS Red Flag Warning in effect here." */
  fireWeatherNote?: string | null
  /** Brief 3 (§14.9): the zone (the fire's, else the place's, else the viewer's) and the preset's clock of every time. */
  tf: TimeFmt
}

// Every time in a card is formatted with the TimeFmt of the describeLocation call being run (set on entry, restored on
// exit; describeLocation is synchronous), so the many small helpers below need no extra argument.
let TF: TimeFmt = { tz: 'UTC', clock: '24h' }
const at = (ms: number) => fmtAt(ms, TF, { zone: true })
const atYear = (ms: number) => fmtAt(ms, TF, { year: 'always', zone: true })

/** Said in every card's reliability block. */
export const PROTOTYPE_NOTE = 'Research prototype, not an evacuation order'

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
    const mapped = p.basis === 'mapped'
    const kind: LineKind = mapped ? 'Mapped' : 'Estimate'
    if (p.inside) return { text: mapped ? 'Inside the mapped fire area' : 'Inside the estimated burned area', tone: 'fire', kind }
    const dir = p.directionDeg != null ? ` ${directionWord(p.directionDeg)}` : ''
    return { text: `${distance(p.distanceM, o.units).text}${dir} of ${mapped ? 'the mapped fire edge' : 'the estimated burned area'}`, tone: 'select', kind }
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
  // Public says "re-run" in plain words (brief 2 C-R8); Command keeps the technical "hindcast"
  const word = f.hindcast ? (o.preset === 'command' ? 'hindcast' : 'model re-run') : 'forecast'
  const period = forecastPeriod({ start_ms: f.startMs, horizon_h: f.horizonH }, TF)
  const endText = at(f.endMs)
  lines.push({
    key: 'period',
    label: f.hindcast ? (o.preset === 'command' ? 'Hindcast period' : 'Re-run period') : 'Forecast period',
    text: period,
    detail: f.hindcast
      ? `Re-run after the fact on archived weather${o.preset === 'command' ? ' (a hindcast)' : ''}, computed ${atYear(f.issuedMs)}. ${ensemblePhrase(f.ensemble, f.members)}.`
      : `Issued ${at(f.issuedMs)} (${fmtRelative(f.issuedMs, o.nowMs)}). ${ensemblePhrase(f.ensemble, f.members)}.`,
    technical: `Run ${f.runId} · ${f.model.engine} ${f.model.version} · ${Math.round(f.model.gridResM)} m grid · crown fire ${f.model.crown ? 'on' : 'off'} · spotting ${f.model.spotting ? 'on' : 'off'}`,
    tone: 'forecast',
    kind: 'Model',
  })
  // burn chance over the whole horizon
  let bpText: string
  if (f.burnedAtStart) bpText = `Already burned when the ${word} started (${at(f.startMs)})`
  else if (f.burnProbability.state === 'nodata') bpText = 'No burn-chance value for this spot (no data).'
  else {
    const fr = f.burnProbability.fraction
    const n = f.burnedMembers
    const by = `by ${endText}, the end of the ${f.horizonH}-hour ${word}`
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
  const run = word
  let atTime: string | null = null
  if (k === 90) atTime = `At least 90% of runs had reached this spot by ${at(t)}`
  else if (k === 50) atTime = `At least half (but fewer than 90%) of the runs had reached this spot by ${at(t)}`
  else if (k === 10) atTime = `At least 10% (but fewer than half) of the runs had reached this spot by ${at(t)}`
  else if (k === 0) atTime = `Fewer than 10% of runs had reached this spot by ${at(t)}`
  else if (t < f.startMs) atTime = `The selected time is before the ${run} starts.`
  else if (t > f.endMs) atTime = `The selected time is after the ${run} ends.`
  const noneReach = [f.arrival.p10, f.arrival.p50, f.arrival.p90].every((q) => q.state === 'not_reached') // said above
  if (!f.burnedAtStart && atTime && !(noneReach && k === 0)) lines.push({ key: 'at-time', label: 'At the selected time', text: atTime, detail: null, technical: null, tone: k == null ? 'muted' : 'forecast', kind: k == null ? null : 'Model' })
  return { key: 'forecast', title: f.hindcast ? (o.preset === 'command' ? 'Model hindcast (past weather)' : 'Model re-run on past weather') : 'Model forecast', lines }
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
  const dr = r.dryness
  if (dr.state === 'ok' && (dr.rhPct != null || dr.fm1Pct != null))
    lines.push({
      key: 'dryness',
      label: 'Dryness at the fire',
      text: [dr.rhPct != null ? `Air humidity ${Math.round(dr.rhPct)}%` : null, dr.fm1Pct != null ? `dead grass and twigs ${dr.fm1Pct.toFixed(1)}% moisture` : null].filter(Boolean).join(' · '),
      detail: `${at(dr.tMs)} · ${weatherSourceName(dr.source)}${dr.isForecast ? ' (forecast hour)' : ''}. The moisture of fine dead fuels (1-hour fuel moisture) is computed from temperature and humidity, not measured. No danger category is given unless an official warning applies.`,
      technical: `rh_pct ${dr.rhPct != null ? dr.rhPct.toFixed(0) : 'n/a'} · fm1_pct ${dr.fm1Pct != null ? dr.fm1Pct.toFixed(1) : 'n/a'}`,
      tone: 'muted',
      kind: 'Model',
    })
  const er = r.edgeRise
  if (er.state === 'ok') {
    const d = distance(er.distanceM, o.units).text
    const rise = Math.abs(er.riseM) < 10 ? `About level with the nearest fire edge (${d} away)` : `About ${elevation(Math.abs(er.riseM), o.units).text} ${er.riseM > 0 ? 'higher' : 'lower'} than the nearest fire edge (${d} away)`
    lines.push({
      key: 'edge-rise',
      label: 'Ground versus the fire edge',
      text: rise,
      detail: 'From the incident elevation model, at this spot and at the nearest point of the fire edge. Fire usually spreads faster uphill.',
      technical: `${Math.round(er.pointElevM)} m here · ${Math.round(er.edgeElevM)} m at the edge · rise ${Math.round(er.riseM)} m over ${Math.round(er.distanceM)} m`,
      tone: 'muted',
      kind: 'Terrain data',
    })
  }
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
        detail: o.preset === 'command' ? 'LANDFIRE fuel model (Scott & Burgan 40) used by the spread model.' : 'LANDFIRE vegetation map, as used by the spread model.',
        technical: `FBFM40 code ${g.fuelCode}`,
        tone: 'muted',
        kind: null,
      })
  } else if (g.gap !== 'no_bundle' && g.gap !== 'outside_modeled_area')
    lines.push({ key: 'terrain', label: 'Terrain', text: gapText(g.gap, 'terrain data'), detail: null, technical: null, tone: 'muted', kind: g.gap === 'loading' ? null : 'Unknown' })
  return { key: 'conditions', title: 'Conditions', lines }
}

// ------------------------------------------------------------------------------------------------- summary
/** One short line under the headline: distance to the edge when inside, and the basis time with its age (its source,
 *  area and latest detection are in the details). */
function perimeterSub(r: LocationReport, o: DescribeOptions): string | null {
  const p = r.perimeter
  if (p.state !== 'ok') return null
  const when = (ms: number) => {
    const a = age(ms, r, o)
    return a === 'at the selected time' ? at(ms) : `${at(ms)} (${a})`
  }
  const edge = p.inside ? `${distance(p.edgeDistanceM, o.units).text} from ${p.basis === 'mapped' ? 'the' : 'its'} edge · ` : ''
  const sub =
    p.basis === 'reconstructed'
      ? `${edge}from satellite detections${p.latestDetectionMs != null ? ` up to ${when(p.latestDetectionMs)}` : ''}`
      : `${edge}mapped ${when(p.perimeterTimeMs)}`
  return sub.charAt(0).toUpperCase() + sub.slice(1)
}

/** Live data whose latest observation is older than the timeline's threshold (one freshness rule everywhere). */
export function isStale(r: Pick<LocationReport, 'latestObservationMs'>, o: Pick<DescribeOptions, 'mode' | 'nowMs'>): boolean {
  return o.mode === 'live' && r.latestObservationMs != null && o.nowMs - r.latestObservationMs > STALE_AFTER_MS
}

function nearHere(r: LocationReport, o: DescribeOptions, h: LocationCardModel['headline']): NearHere {
  const f = r.observedFire
  return { text: h.text, sub: perimeterSub(r, o), kind: h.kind, tone: h.tone, burned: f.state === 'burned' ? `Burned around ${at(f.arrivalMs)} (estimate)` : null, stale: isStale(r, o) }
}

/** Wind relative to the point: the direction the wind blows TO against the bearing from the nearest fire edge to the
 *  point. Within 45° = toward, within 45° of the opposite = away, otherwise across. */
export type WindRelation = 'toward' | 'away' | 'across'
export function windRelation(fromDeg: number, edgeToPointDeg: number): WindRelation {
  const to = (((fromDeg + 180) % 360) + 360) % 360
  const d = Math.abs(((to - edgeToPointDeg + 540) % 360) - 180)
  return d <= 45 ? 'toward' : d >= 135 ? 'away' : 'across'
}

/** Below this the wind direction says little: "light wind". */
export const LIGHT_WIND_MS = 1.5
/** "Uphill of the nearest edge" needs at least this rise and this average grade between the edge and the point. */
export const UPHILL_MIN_RISE_M = 30
export const UPHILL_MIN_GRADE = 0.05

function windReason(r: LocationReport, o: DescribeOptions): Reason | null {
  const w = r.wind
  if (w.state !== 'ok') return null
  const speed = `${windSpeed(w.speedMs, o.units).text} from the ${directionWord(w.fromDeg)}${w.gustMs != null ? `, gusts ${windSpeed(w.gustMs, o.units).text}` : ''}`
  const where = w.where === 'fire' ? 'at the fire' : 'here'
  const p = r.perimeter
  let text: string
  if (w.speedMs < LIGHT_WIND_MS) text = `light ${where}, ${speed}`
  else if (p.state === 'ok' && !p.inside && p.directionDeg != null) {
    const rel = windRelation(w.fromDeg, p.directionDeg)
    text = rel === 'toward' ? `blowing from the fire toward here, ${speed}` : rel === 'away' ? `blowing from here toward the fire, not toward here, ${speed}` : `blowing across, not straight toward here, ${speed}`
  } else text = `${where}, ${speed}`
  return { key: 'wind', label: 'Wind', text, kind: 'Model', official: null }
}

function drynessReason(r: LocationReport, o: DescribeOptions): Reason | null {
  const d = r.dryness
  if (d.state !== 'ok') return null
  const parts: string[] = []
  if (d.rhPct != null) parts.push(`humidity ${Math.round(d.rhPct)}%`)
  if (d.fm1Pct != null) parts.push(`dead grass and twigs ${d.fm1Pct < 10 ? (Math.round(d.fm1Pct * 10) / 10).toString() : Math.round(d.fm1Pct)}% moisture`)
  if (!parts.length) return null
  const text = `${parts.join(', ')} (at the fire)`
  return { key: 'dryness', label: 'Dryness', text, kind: 'Model', official: o.fireWeatherNote ?? null }
}

function terrainReason(r: LocationReport, o: DescribeOptions): Reason | null {
  const e = r.edgeRise
  if (e.state !== 'ok' || e.riseM < UPHILL_MIN_RISE_M || e.distanceM <= 0 || e.riseM / e.distanceM < UPHILL_MIN_GRADE) return null
  return {
    key: 'terrain',
    label: 'Slope',
    text: `about ${elevation(e.riseM, o.units).text} uphill of the nearest fire edge (${distance(e.distanceM, o.units).text} away); fire usually spreads faster uphill`,
    kind: 'Terrain data',
    official: null,
  }
}

const runWord = (r: { hindcast: boolean }) => (r.hindcast ? 'the experimental model (re-run on past weather)' : 'the experimental model')

/** "1 in 10 simulated fires reach here by …, half of them by …" (exact: arrival_pK <= t; present tense, as the times
 *  can lie ahead in a live forecast). */
function arrivalSentence(f: Extract<LocationReport['forecast'], { state: 'ok' }>): string | null {
  const t = (q: ArrivalQuantile) => (q.state === 'time' && !q.atStart ? q.ms : null)
  const p10 = t(f.arrival.p10)
  if (p10 == null) return null
  const p50 = t(f.arrival.p50)
  const p90 = t(f.arrival.p90)
  return `1 in 10 simulated fires reach here by ${at(p10)}${p50 != null ? `, half of them by ${at(p50)}` : ''}${p90 != null ? `, 9 in 10 by ${at(p90)}` : ''}.`
}

function modelSummary(r: LocationReport, o: DescribeOptions): ModelSummary | null {
  const f = r.forecast
  const command = o.preset === 'command'
  if (f.state === 'gap') {
    switch (f.gap) {
      case 'no_bundle':
        return null
      case 'outside_modeled_area':
        return { text: 'The experimental model does not cover this spot (outside the modeled area). Unknown, not low.', arrival: null, missed: null, figure: null, kind: 'Unknown', tone: 'unknown' }
      case 'no_forecast':
        return { text: 'No experimental model run is available for this fire.', arrival: null, missed: null, figure: null, kind: 'Unknown', tone: 'unknown' }
      case 'loading':
        return { text: 'Loading the experimental model…', arrival: null, missed: null, figure: null, kind: null, tone: 'muted' }
      case 'error':
        return { text: 'The experimental model failed to load.', arrival: null, missed: null, figure: null, kind: 'Unknown', tone: 'unknown' }
      case 'nodata':
        return { text: 'The experimental model has no value for this spot.', arrival: null, missed: null, figure: null, kind: 'Unknown', tone: 'unknown' }
    }
  }
  const model = runWord(f)
  const by = `by ${at(f.endMs)} (${f.horizonH} h)`
  if (f.burnedAtStart)
    return { text: `In ${model}, this spot was already inside the burned area when the run started (${at(f.startMs)}).`, arrival: null, missed: null, figure: null, kind: 'Model', tone: 'forecast' }
  if (f.burnProbability.state === 'nodata') return { text: `${model.charAt(0).toUpperCase()}${model.slice(1)} has no burn value for this spot.`, arrival: null, missed: null, figure: null, kind: 'Unknown', tone: 'unknown' }
  const fr = f.burnProbability.fraction
  const n = f.burnedMembers
  const share = n != null ? `${n} of ${f.members}` : `about ${pct(fr)} of the ${f.members}`
  const text = command
    ? `${share} model runs burned this spot ${by}. Not a safety guarantee.`
    : `In ${model}, ${share} simulated fires reached here ${by}. Not a safety guarantee.`
  const obs = r.observedFire
  const missed = fr === 0 && obs.state === 'burned' && obs.arrivalMs > f.startMs && obs.arrivalMs <= f.endMs ? `The fire reached this spot around ${at(obs.arrivalMs)}, but none of the simulated fires did.` : null
  return { text, arrival: command ? null : arrivalSentence(f), missed, figure: command ? pct(fr) : null, kind: 'Model', tone: 'forecast' }
}

function commandRun(r: LocationReport): CommandRun | null {
  const f = r.forecast
  if (f.state !== 'ok') return null
  const period = forecastPeriod({ start_ms: f.startMs, horizon_h: f.horizonH }, TF)
  const run = `Run ${f.runId} · ${f.hindcast ? 'computed' : 'issued'} ${atYear(f.issuedMs)} · ${f.members} members (${ensemblePhrase(f.ensemble, f.members).replace(/^\d+ /, '')}) · ${period}`
  const q = (k: string, a: ArrivalQuantile) => `${k} ${a.state === 'time' ? (a.atStart ? 'at the start' : at(a.ms)) : a.state === 'not_reached' ? 'not reached' : 'no data'}`
  const quantiles = f.burnedAtStart ? null : `Arrival ${q('P10', f.arrival.p10)} · ${q('P50', f.arrival.p50)} · ${q('P90', f.arrival.p90)}`
  return { run, quantiles }
}

function reliability(r: LocationReport, o: DescribeOptions): ReliabilityLine[] {
  const out: ReliabilityLine[] = []
  const latest = r.latestObservationMs
  if (r.modeledArea !== 'no_bundle' && latest != null) {
    if (o.mode === 'live') out.push({ key: 'fire-data', text: `Latest fire observation ${at(latest)} (${fmtRelative(latest, o.nowMs)})`, stale: isStale(r, o) })
    else out.push({ key: 'fire-data', text: `Past fire, as of ${at(r.timeMs)}`, stale: false })
  }
  const f = r.forecast
  if (f.state === 'ok')
    out.push({
      key: 'model',
      text: f.hindcast ? `model re-run ${atYear(f.issuedMs)}` : `model issued ${at(f.issuedMs)} (${fmtRelative(f.issuedMs, o.nowMs)})`,
      stale: false,
    })
  out.push({ key: 'prototype', text: PROTOTYPE_NOTE, stale: false })
  return out
}

/** No run reached the spot: the model sentence already says so, so the arrival line stays in the details. */
function noRunReached(r: LocationReport): boolean {
  const f = r.forecast
  return f.state === 'ok' && [f.arrival.p10, f.arrival.p50, f.arrival.p90].every((q) => q.state === 'not_reached') && f.burnProbability.state === 'value' && f.burnProbability.fraction === 0
}

/** Summary lines whose detail (source, period, meaning) moves into the disclosure as a note of its own. */
const NOTE_KEYS = new Set(['perimeter', 'burn-chance', 'arrival', 'model-missed', 'wind'])

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

function summaryOf(r: LocationReport, o: DescribeOptions, h: LocationCardModel['headline'], present: Set<string>): CardSummary {
  const model = modelSummary(r, o)
  const command = o.preset === 'command'
  const reasons = [windReason(r, o), drynessReason(r, o), terrainReason(r, o)].filter((x): x is Reason => !!x).slice(0, 3)
  const f = r.forecast
  // the arrival line is said up front in Command (quantiles) and in Public when runs reached the spot
  const arrivalSaid = f.state === 'ok' && !f.burnedAtStart && (command || (model?.arrival != null && !noRunReached(r)))
  return {
    near: nearHere(r, o, h),
    reasons,
    model,
    run: command ? commandRun(r) : null,
    reliability: reliability(r, o),
    keys: [
      'perimeter',
      ...(r.observedFire.state === 'burned' ? ['observed'] : []),
      ...(f.state === 'gap' ? ['forecast-gap'] : []),
      ...(f.state === 'ok' ? ['burn-chance'] : []),
      ...(model?.missed ? ['model-missed'] : []),
      ...(arrivalSaid ? ['arrival'] : []),
      ...(reasons.some((x) => x.key === 'wind') ? ['wind'] : []),
    ].filter((k) => present.has(k)),
  }
}

// ------------------------------------------------------------------------------------------------- card
const KIND_WORD: Record<ReportSource['kind'], string> = { observation: 'Observation', estimate: 'Estimate', model: 'Model', official: 'Official', reference: 'Reference' }

export function describeLocation(r: LocationReport, o: DescribeOptions): LocationCardModel {
  const prev = TF
  TF = o.tf
  try {
    return describeWith(r, o)
  } finally {
    TF = prev
  }
}

function describeWith(r: LocationReport, o: DescribeOptions): LocationCardModel {
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
    areaNote: r.modeledArea === 'outside' ? 'Outside the modeled area: the model and the fire reconstruction do not cover this spot. Unknown, not low risk.' : null,
    sections,
    summary,
    details: detailsOf(sections, summary.keys),
    // with the year: source times can be far from the fire (a hindcast computed later, reference data fetched earlier)
    sources: r.sources.map((s) => ({ text: `${KIND_WORD[s.kind]}: ${s.name}${s.timeMs != null ? ` · ${atYear(s.timeMs)}` : ''}`, kind: s.kind })),
    caveats: r.caveats,
  }
}
