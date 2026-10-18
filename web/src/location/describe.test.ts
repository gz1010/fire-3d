import { describe, expect, it } from 'vitest'
import { NEVER } from '../api/types'
import { distance } from '../lib/plainLanguage'
import { fmtDateTime, tzLabel } from '../lib/time'
import { describeLocation, span, type DescribeOptions, type LocationCardModel } from './describe'
import {
  HOUR,
  LOADING,
  ORIGIN,
  ZONE11,
  detection,
  input,
  localLatLon,
  makeForecast,
  makeLayer,
  makeManifest,
  makeRasters,
  makeWeather,
  perimeter,
  ready,
  square,
} from './fixtures.testutil'
import { checkLocation } from './locationCheck'
import type { LocationCheckInput } from './types'

const m = makeManifest(ZONE11)
const f = makeForecast(m) // ORIGIN + 24 h, 72 h, 31 members (hindcast: the manifest is historical)
const n = ZONE11.n
const at = (ms: number) => `${fmtDateTime(ms)} ${tzLabel(ms)}`
const END = f.start_ms + 72 * HOUR
const US: DescribeOptions = { units: 'us', preset: 'public', mode: 'historical', nowMs: ORIGIN + 400 * HOUR }

function fc(bp: number, p10: number, p50: number, p90: number) {
  return {
    burnProbability: ready(makeLayer('burn_probability', n, bp)),
    arrivalP10: ready(makeLayer('arrival_p10', n, p10)),
    arrivalP50: ready(makeLayer('arrival_p50', n, p50)),
    arrivalP90: ready(makeLayer('arrival_p90', n, p90)),
  }
}

function card(over: Partial<LocationCheckInput> = {}, opts: DescribeOptions = US, xz: [number, number] = [0, 0]): LocationCardModel {
  const pt = { ...localLatLon(m, xz[0], xz[1]), source: 'click' as const }
  return describeLocation(checkLocation(input(m, pt, over)), opts)
}

const allText = (c: LocationCardModel) =>
  [c.title, c.locationType, c.headline.text, c.areaNote ?? '', ...c.sections.flatMap((s) => [s.title, ...s.lines.flatMap((l) => [l.label, l.text, l.detail ?? '', l.technical ?? ''])]), ...c.caveats, ...c.sources.map((s) => s.text)].join('\n')
const line = (c: LocationCardModel, key: string) => c.sections.flatMap((s) => s.lines).find((l) => l.key === key)

describe('burn chance is stated for the full horizon only', () => {
  const c = card({ forecast: f, rasters: makeRasters(fc(7 / 31, 29, 44, NEVER)), timeMs: ORIGIN + 30 * HOUR })
  it('names the end time and horizon, with run counts', () => {
    expect(line(c, 'burn-chance')!.text).toBe(`7 of 31 model runs (23%) burned this spot by ${at(END)}, the end of the 72-hour hindcast`)
    expect(line(c, 'burn-chance')!.label).toBe('Burn chance over 72 h')
    expect(line(c, 'period')!.text).toBe(`${fmtDateTime(f.start_ms)} – ${fmtDateTime(END)} ${tzLabel(END)} (72 h)`)
    expect(line(c, 'burn-chance')!.technical).toMatch(/burn_probability 0\.226 \(fraction of 31 members burned by start \+ 72 h\)/)
  })
  it('never relabels it as a shorter period or a category', () => {
    const text = allText(c)
    expect(text).not.toMatch(/next 24|24 hours|next 48|today|tonight|tomorrow/i)
    expect(text).not.toMatch(/\b(low|moderate|high|extreme|very high) (risk|danger|chance)\b/i)
    expect(text).not.toMatch(/\bsafe\b/i)
  })
  it('says never-burn as "none of the runs" with a no-guarantee note', () => {
    const z = card({ forecast: f, rasters: makeRasters(fc(0, NEVER, NEVER, NEVER)) })
    expect(line(z, 'burn-chance')!.text).toBe(`None of the 31 model runs burned this spot by ${at(END)}, the end of the 72-hour hindcast`)
    expect(line(z, 'burn-chance')!.detail).toMatch(/not a guarantee/)
    expect(line(z, 'arrival')!.text).toBe(`No model run reached this spot by ${at(END)}`)
    expect(line(z, 'at-time')).toBeUndefined() // 'fewer than 10%' would understate 'none'
  })
  it('handles all runs, tiny shares and the burned-at-start case', () => {
    expect(line(card({ forecast: f, rasters: makeRasters(fc(1, 25, 26, 27)) }), 'burn-chance')!.text).toMatch(/^All 31 model runs burned this spot by/)
    expect(line(card({ forecast: { ...f, weather: { ...f.weather, members: 300 } }, rasters: makeRasters(fc(1 / 300, 60, NEVER, NEVER)) }), 'burn-chance')!.text).toMatch(/^1 of 300 model runs \(<1%\)/)
    const start = card({ forecast: f, rasters: makeRasters(fc(1, 24, 24, 24)) })
    expect(line(start, 'burn-chance')!.text).toBe(`Already burned when the hindcast started (${at(f.start_ms)})`)
    expect(line(start, 'arrival')).toBeUndefined()
  })
  it('labels live runs as forecasts with their issue time', () => {
    const live = makeManifest(ZONE11, { mode: 'live' })
    const r = checkLocation(input(live, { ...localLatLon(live, 0, 0), source: 'click' }, { forecast: makeForecast(live), rasters: makeRasters(fc(0.5, 30, 40, 50)) }))
    const c2 = describeLocation(r, { ...US, mode: 'live' })
    expect(c2.sections.find((s) => s.key === 'forecast')!.title).toBe('Model forecast')
    expect(line(c2, 'period')!.detail).toMatch(/^Issued /)
    expect(line(c2, 'burn-chance')!.text).toMatch(/the end of the 72-hour forecast$/)
  })
})

describe('card summary', () => {
  it('shows the figure once, with the full-horizon sentence and the perimeter time', () => {
    const p = perimeter(ORIGIN + 20 * HOUR, [square(0, 0, 1000)], { acres: 988.4 })
    const c = card({ forecast: f, perimeters: [p], rasters: makeRasters(fc(7 / 31, 29, 44, NEVER)), timeMs: ORIGIN + 30 * HOUR }, US, [0, -3000])
    expect(c.summary.burnFigure).toBe('23%')
    expect(c.summary.burnText).toBe(`7 of 31 model runs burned this spot by ${at(END)}, the end of the 72-hour hindcast`)
    expect(c.summary.perimeter.text).toBe(c.headline.text)
    expect(c.summary.perimeter.sub).toBe(`Mapped ${at(p.t_ms)} (10 h before the selected time)`)
    expect(c.summary.keys).toContain('burn-chance')
    const zero = card({ forecast: f, rasters: makeRasters(fc(0, NEVER, NEVER, NEVER)) })
    expect([zero.summary.burnFigure, zero.summary.burnText]).toEqual(['0%', `None of the 31 model runs burned this spot by ${at(END)}, the end of the 72-hour hindcast`])
    const start = card({ forecast: f, rasters: makeRasters(fc(1, 24, 24, 24)) })
    expect([start.summary.burnFigure, start.summary.burnText]).toEqual([null, null])
    expect(card({ forecast: null }).summary.burnFigure).toBeNull()
  })
  it('keeps the summary short: sources, periods and meanings move into the details, nothing is said twice', () => {
    const p = perimeter(ORIGIN + 20 * HOUR, [square(0, 0, 1000)], { acres: 988.4 })
    const never = { observedArrival: ready(makeLayer('observed_arrival', n, (r, c) => (r >= 190 && r < 210 && c >= 190 && c < 210 ? 12 : NEVER))) }
    const over = { forecast: f, perimeters: [p], detections: [detection(m, 800, 0, ORIGIN + 29 * HOUR)], timeMs: ORIGIN + 30 * HOUR }
    // outside the perimeter and not burned: the observed line would only repeat the headline
    const out = card({ ...over, rasters: makeRasters({ ...never, ...fc(7 / 31, 29, 44, NEVER) }) }, US, [0, -3000])
    expect(out.summary.keys).toEqual(['perimeter', 'burn-chance', 'arrival'])
    const d = out.details.flatMap((s) => s.lines)
    const keys = d.map((l) => l.key)
    expect(keys).toEqual(['perimeter-note', 'observed', 'detection', 'period', 'burn-chance-note', 'arrival-note', 'at-time', 'wind', 'terrain'])
    expect(keys.filter((k) => out.summary.keys.includes(k))).toEqual([])
    expect(d[0]).toMatchObject({ label: 'Mapped perimeter', text: `NIFC WFIGS daily perimeters · mapped ${at(p.t_ms)} (10 h before the selected time) · 988 acres`, technical: null })
    expect(d.find((l) => l.key === 'burn-chance-note')!.text).toMatch(/^Share of the model runs, not a guarantee/)
    expect(d.find((l) => l.key === 'arrival-note')!.text).toMatch(/^Arrival-time quantiles: .* not best- or worst-case scenarios\.$/)
    // the full lines (and their scientific values) stay available
    expect(line(out, 'perimeter')!.technical).toMatch(/geodesic distance \d+ m · bearing/)
    // inside: when the spot burned is part of the summary
    const ins = card({ ...over, rasters: makeRasters({ ...never, ...fc(1, 24, 24, 24) }) })
    expect(ins.summary.keys).toContain('observed')
    expect(ins.summary.perimeter.sub).toBe(`${distance(1000, 'us').text} from the edge · mapped ${at(p.t_ms)} (10 h before the selected time)`)
    expect(line(ins, 'observed')).toMatchObject({ text: `Burned around ${at(ORIGIN + 12 * HOUR)}`, kind: 'Estimate' })
    expect(ins.details.flatMap((s) => s.lines).map((l) => l.key)).not.toContain('observed')
  })
  it('says so when the fire reached a spot during the run that no model run reached', () => {
    const obs = (h: number) => ({ observedArrival: ready(makeLayer('observed_arrival', n, h)) })
    const none = fc(0, NEVER, NEVER, NEVER)
    const c = card({ forecast: f, rasters: makeRasters({ ...obs(30), ...none }), timeMs: ORIGIN + 40 * HOUR })
    expect(line(c, 'model-missed')).toMatchObject({ text: `The fire reached this spot around ${at(ORIGIN + 30 * HOUR)}, but none of the model runs did`, tone: 'warn', kind: 'Estimate' })
    // shown in the summary; "no run reached it" is said once (burn chance), the arrival line waits in the details
    expect(c.summary.keys).toContain('model-missed')
    expect(c.summary.keys).not.toContain('arrival')
    expect(c.details.flatMap((s) => s.lines).map((l) => l.key)).toEqual(expect.arrayContaining(['model-missed-note', 'arrival']))
    // not before the fire got there, not for a burn before the run started or after it ended, not when runs reached it
    expect(line(card({ forecast: f, rasters: makeRasters({ ...obs(30), ...none }), timeMs: ORIGIN + 28 * HOUR }), 'model-missed')).toBeUndefined()
    expect(line(card({ forecast: f, rasters: makeRasters({ ...obs(10), ...none }), timeMs: ORIGIN + 40 * HOUR }), 'model-missed')).toBeUndefined()
    expect(line(card({ forecast: f, rasters: makeRasters({ ...obs(100), ...none }), timeMs: ORIGIN + 120 * HOUR }), 'model-missed')).toBeUndefined()
    const some = card({ forecast: f, rasters: makeRasters({ ...obs(30), ...fc(3 / 31, 40, NEVER, NEVER) }), timeMs: ORIGIN + 40 * HOUR })
    expect(line(some, 'model-missed')).toBeUndefined()
    expect(some.summary.keys).toContain('arrival')
  })
  it('summarises conditions in one line and knows when the title is the coordinates', () => {
    const c = card({ weather: makeWeather(m, { speedMs: 8, fromDeg: 45, gustMs: 14 }) })
    expect(c.summary.conditions).toBe('Wind at the fire 18 mph from the northeast, gusts 31 mph')
    expect(c.titleIsCoords).toBe(true)
  })
})

describe('arrival-time quantiles', () => {
  it('reads as times by which shares of runs had arrived, never scenarios or a worst case', () => {
    const c = card({ forecast: f, rasters: makeRasters(fc(0.5, 29, 44, NEVER)) })
    const a = line(c, 'arrival')!
    expect(a.text).toBe(`10% of runs by ${at(ORIGIN + 29 * HOUR)} · 50% by ${at(ORIGIN + 44 * HOUR)} · 90%: not reached by the end`)
    expect(a.detail).toMatch(/^Arrival-time quantiles/)
    expect(a.detail).toMatch(/not best- or worst-case scenarios/)
    const text = allText(c).replace(/not best- or worst-case scenarios/g, '')
    expect(text).not.toMatch(/worst|best case|scenario|wind shift/i)
  })
  it('makes only exact statements at the selected time', () => {
    const t = (h: number) => line(card({ forecast: f, rasters: makeRasters(fc(0.5, 29, 44, 60)), timeMs: ORIGIN + h * HOUR }), 'at-time')!.text
    expect(t(26)).toBe(`Fewer than 10% of runs had reached this spot by ${at(ORIGIN + 26 * HOUR)}`)
    expect(t(30)).toBe(`At least 10% (but fewer than half) of the runs had reached this spot by ${at(ORIGIN + 30 * HOUR)}`)
    expect(t(50)).toBe(`At least half (but fewer than 90%) of the runs had reached this spot by ${at(ORIGIN + 50 * HOUR)}`)
    expect(t(61)).toBe(`At least 90% of runs had reached this spot by ${at(ORIGIN + 61 * HOUR)}`)
    expect(t(10)).toBe('The selected time is before the hindcast starts.')
    expect(t(200)).toBe('The selected time is after the hindcast ends.')
  })
})

describe('unknown states are said as such', () => {
  it('missing forecast', () => {
    const c = card({ forecast: null })
    expect(line(c, 'forecast-gap')).toMatchObject({ text: 'No forecast is available for this incident.', kind: 'Unknown' })
  })
  it('outside the modeled area = unknown, not low', () => {
    const c = card({ forecast: f, rasters: makeRasters(fc(0.5, 30, 40, 50)), perimeters: [perimeter(ORIGIN + 20 * HOUR, [square(0, 0, 1000)])] }, US, [9000, 0])
    expect(c.areaNote).toMatch(/^Outside modeled area/)
    expect(c.areaNote).toMatch(/Unknown, not low risk/)
    expect(line(c, 'forecast-gap')!.text).toBe('Not covered by the forecast: outside the modeled area, so unknown (not low).')
    expect(c.headline.text).toBe(`${distance(8000.0, 'us').text} east of the latest mapped fire perimeter`)
    expect(c.caveats[0]).toMatch(/unknown, not low/)
    expect(allText(c)).not.toMatch(/\d+% of model runs|burned this spot by/) // no numbers for an unmodeled spot
    expect(c.summary.keys).toEqual(['perimeter']) // the area note says it once in the summary; the gap line is in the details
    expect(c.details.flatMap((s) => s.lines).map((l) => l.key)).toContain('forecast-gap')
  })
  it('nodata, loading and error', () => {
    expect(line(card({ forecast: f, rasters: makeRasters(fc(Number.NaN, Number.NaN, Number.NaN, Number.NaN)) }), 'forecast-gap')!.text).toBe('No forecast value for this spot (no data).')
    expect(line(card({ forecast: f, rasters: makeRasters({ burnProbability: LOADING }) }), 'forecast-gap')).toMatchObject({ text: 'Loading forecast…', kind: null })
    const partial = card({ forecast: f, rasters: makeRasters({ ...fc(0.5, 30, NEVER, NEVER), burnProbability: ready(makeLayer('burn_probability', n, Number.NaN)) }) })
    expect(line(partial, 'burn-chance')!.text).toBe('No burn-chance value for this spot (no data).')
  })
  it('no bundle: only the point, no invented fire or forecast lines', () => {
    const c = describeLocation(checkLocation(input(null, { lat: 36.6, lon: -121.9, source: 'coords' })), US)
    expect(c.headline).toMatchObject({ text: 'No incident data loaded for this check', kind: 'Unknown' })
    expect(c.sections).toEqual([])
    expect(c.title).toBe('36.60000° N, 121.90000° W')
  })
  it('no perimeter or burned area yet', () => {
    const c = card({ perimeters: [perimeter(ORIGIN + 50 * HOUR, [square(0, 0, 1000)])], rasters: makeRasters({ observedArrival: ready(makeLayer('observed_arrival', n, NEVER)) }), timeMs: ORIGIN + 10 * HOUR })
    expect(c.headline.text).toBe('No mapped perimeter or estimated burned area by the selected time')
    expect(line(c, 'observed')!.text).toBe(`Not burned by ${at(ORIGIN + 10 * HOUR)}, as far as satellite observations show`)
  })
})

describe('fire lines', () => {
  it('mapped perimeter inside / outside with source, time and lag; reconstructed labelled as an estimate', () => {
    const p = perimeter(ORIGIN + 20 * HOUR, [square(0, 0, 1000)], { acres: 988.4 })
    const inside = card({ perimeters: [p], timeMs: ORIGIN + 35 * HOUR })
    expect(inside.headline).toMatchObject({ text: 'Inside the latest mapped fire perimeter', kind: 'Mapped', tone: 'fire' })
    expect(line(inside, 'perimeter')!.detail).toBe(`NIFC WFIGS daily perimeters · mapped ${at(p.t_ms)} (15 h before the selected time) · 988 acres`)
    const outside = card({ perimeters: [p], timeMs: ORIGIN + 35 * HOUR }, US, [0, -3000])
    expect(outside.headline.text).toBe(`${distance(2000.3, 'us').text} north of the latest mapped fire perimeter`)
    const arr = makeLayer('observed_arrival', n, (r, c) => (r >= 190 && r < 210 && c >= 190 && c < 210 ? 12 : NEVER))
    const rec = card({ rasters: makeRasters({ observedArrival: ready(arr) }), detections: [detection(m, 0, 0, ORIGIN + 13 * HOUR)], timeMs: ORIGIN + 15 * HOUR })
    expect(rec.headline).toMatchObject({ text: 'Inside the estimated burned area', kind: 'Estimate' })
    expect(line(rec, 'perimeter')).toMatchObject({ label: 'Estimated burned area', kind: 'Estimate' })
    expect(rec.summary.perimeter.sub).toMatch(/^[\d.]+ (ft|mi) from its edge · estimated from satellite detections for .+ \((at the selected time|\d+ (min|h) before the selected time)\)$/)
    expect(line(rec, 'observed')).toMatchObject({ text: `Burned around ${at(ORIGIN + 12 * HOUR)}`, kind: 'Estimate' })
  })
  it('nearest detection is context with its pixel size, never the fire front', () => {
    const c = card({ detections: [detection(m, 800, 0, ORIGIN + 29 * HOUR)], timeMs: ORIGIN + 30 * HOUR })
    const d = line(c, 'detection')!
    expect(d.text).toBe(`${distance(800.2, 'us').text} east, ${at(ORIGIN + 29 * HOUR)} (1 h before the selected time)`)
    expect(d.detail).toBe(`VIIRS on NOAA-20, pixel about ${distance(390, 'us').text} wide. A detection marks a hot pixel, not the fire's edge.`)
    expect(allText(c)).not.toMatch(/fire front|fire line is|exact edge/i)
  })
})

describe('conditions, units and labels', () => {
  it('wind uses the FROM convention and terrain uses everyday units', () => {
    const rn = n * 2
    const res = ZONE11.extent / rn
    const elev = makeLayer('elevation', rn, (_r, c) => 500 + 0.3 * (c + 0.5) * res, { grid: 'render' })
    const fuel = makeLayer('fuel', n, 91, { dtype: 'uint8', nodata: 0 })
    const c = card({ weather: makeWeather(m, { speedMs: 8, fromDeg: 45, gustMs: 14 }), rasters: makeRasters({ elevation: ready(elev), fuel: ready(fuel) }) })
    expect(line(c, 'wind')!.text).toBe('18 mph from the northeast, gusts 31 mph')
    expect(line(c, 'wind')!.detail).toMatch(/Direction is where the wind blows from\.$/)
    expect(line(c, 'wind-here')!.text).toBe('11 mph from the west') // grid u = +5 m/s
    expect(line(c, 'terrain')!.text).toBe(`${(Math.round((500 + 0.3 * (ZONE11.extent / 2 + res / 2)) * 3.280839895)).toLocaleString('en-US')} ft · 30% slope · faces west`)
    expect(line(c, 'fuel')!.text).toBe('Urban / developed (NB1): mapped as non-burnable fuel')
    const metric = describeLocation(checkLocation(input(m, { ...localLatLon(m, 0, 0), source: 'click' }, { weather: makeWeather(m), rasters: makeRasters({ elevation: ready(elev) }) })), { ...US, units: 'metric' })
    expect(line(metric, 'wind')!.text).toMatch(/km\/h from the northeast/)
    expect(line(metric, 'terrain')!.text).toMatch(/ m · 30% slope/)
  })
  it('labels approximate addresses and never calls the reported location the ignition point', () => {
    const addr = describeLocation(checkLocation(input(m, { ...localLatLon(m, 0, 0), source: 'address', label: '600 E MARIPOSA ST', matchedAddress: '600 E MARIPOSA ST', approximate: true, adjustable: true })), US)
    expect(addr.approximate).toBe(true)
    expect(addr.locationType).toBe("Street address · interpolated along the street's address range, not a rooftop position")
    const inc = describeLocation(checkLocation(input(m, { ...localLatLon(m, 0, 0), source: 'incident', label: 'Test Fire' })), US)
    expect(inc.locationType).not.toMatch(/ignition/i)
    expect(allText(inc)).not.toMatch(/ignition point/i)
  })
  it('lists sources with their kind and keeps the caveats', () => {
    const c = card({ forecast: f, rasters: makeRasters(fc(0.5, 30, 40, 50)), weather: makeWeather(m) })
    expect(c.sources.some((s) => s.text.startsWith('Model: Fire-3d spread model (pyretechnics 2026.8.10)'))).toBe(true)
    expect(c.caveats.join(' ')).toMatch(/describe 31 model runs/)
  })
  it('formats spans', () => {
    expect(span(30_000)).toBe('1 min')
    expect(span(15 * 60_000)).toBe('15 min')
    expect(span(15 * HOUR)).toBe('15 h')
    expect(span(72 * HOUR)).toBe('3 days')
  })
})
