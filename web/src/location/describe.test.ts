import { describe, expect, it } from 'vitest'
import { NEVER } from '../api/types'
import { distance } from '../lib/plainLanguage'
import { fmtAt, timeFmt } from '../lib/time'
import { describeLocation, span, windRelation, type DescribeOptions, type LocationCardModel } from './describe'
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
// Public reads 12-hour in the fire's zone (brief 3, §14.9): the fixture fire is in California
const TF = timeFmt('America/Los_Angeles', '12h') // tz-ok: test
const at = (ms: number) => fmtAt(ms, TF, { zone: true })
const END = f.start_ms + 72 * HOUR
const US: DescribeOptions = { units: 'us', preset: 'public', mode: 'historical', nowMs: ORIGIN + 400 * HOUR, tf: TF }

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
    expect(line(c, 'burn-chance')!.text).toBe(`7 of 31 model runs (23%) burned this spot by ${at(END)}, the end of the 72-hour model re-run`)
    // Command keeps the technical word; Public says "re-run" and shows no run ids or raw values in the details
    const cmd = card({ forecast: f, rasters: makeRasters(fc(7 / 31, 29, 44, NEVER)), timeMs: ORIGIN + 30 * HOUR }, { ...US, preset: 'command' })
    expect(line(cmd, 'burn-chance')!.text).toMatch(/the end of the 72-hour hindcast$/)
    expect(cmd.sections.find((x) => x.key === 'forecast')!.title).toBe('Model hindcast (past weather)')
    expect(c.sections.find((x) => x.key === 'forecast')!.title).toBe('Model re-run on past weather')
    expect(line(c, 'period')!.detail).not.toMatch(/hindcast/i)
    expect(line(c, 'burn-chance')!.label).toBe('Burn chance over 72 h')
    expect(line(c, 'period')!.text).toBe(`${fmtAt(f.start_ms, TF)} – ${fmtAt(END, TF, { zone: true })} (72 h)`)
    // Public is 12-hour (round 2 item 8): "Jan 8, 12:18 AM – Jan 11, 12:18 AM PST (72 h)"
    expect(line(c, 'period')!.text).toMatch(/^\w{3} \d{1,2}, \d{1,2}:\d\d [AP]M – \w{3} \d{1,2}, \d{1,2}:\d\d [AP]M P[SD]T \(72 h\)$/)
    // Command reads 24-hour in the same zone
    const cmd24 = card({ forecast: f, rasters: makeRasters(fc(7 / 31, 29, 44, NEVER)), timeMs: ORIGIN + 30 * HOUR }, { ...US, preset: 'command', tf: timeFmt(TF.tz, '24h') })
    expect(line(cmd24, 'period')!.text).toMatch(/^\w{3} \d{1,2}, \d\d:\d\d – \w{3} \d{1,2}, \d\d:\d\d P[SD]T \(72 h\)$/)
    // an Eastern fire's card reads Eastern time
    const east = card({ forecast: f, rasters: makeRasters(fc(7 / 31, 29, 44, NEVER)), timeMs: ORIGIN + 30 * HOUR }, { ...US, tf: timeFmt('America/New_York', '12h') })
    expect(line(east, 'period')!.text).toMatch(/E[SD]T \(72 h\)$/)
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
    expect(line(z, 'burn-chance')!.text).toBe(`None of the 31 model runs burned this spot by ${at(END)}, the end of the 72-hour model re-run`)
    expect(line(z, 'burn-chance')!.detail).toMatch(/not a guarantee/)
    expect(line(z, 'arrival')!.text).toBe(`No model run reached this spot by ${at(END)}`)
    expect(line(z, 'at-time')).toBeUndefined() // 'fewer than 10%' would understate 'none'
  })
  it('handles all runs, tiny shares and the burned-at-start case', () => {
    expect(line(card({ forecast: f, rasters: makeRasters(fc(1, 25, 26, 27)) }), 'burn-chance')!.text).toMatch(/^All 31 model runs burned this spot by/)
    expect(line(card({ forecast: { ...f, weather: { ...f.weather, members: 300 } }, rasters: makeRasters(fc(1 / 300, 60, NEVER, NEVER)) }), 'burn-chance')!.text).toMatch(/^1 of 300 model runs \(<1%\)/)
    const start = card({ forecast: f, rasters: makeRasters(fc(1, 24, 24, 24)) })
    expect(line(start, 'burn-chance')!.text).toBe(`Already burned when the model re-run started (${at(f.start_ms)})`)
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

describe('card summary: four short blocks', () => {
  const p = perimeter(ORIGIN + 20 * HOUR, [square(0, 0, 1000)], { acres: 988.4 })
  it('block 1, near here: the edge or the area, tagged, with its age; when the spot burned', () => {
    const c = card({ forecast: f, perimeters: [p], rasters: makeRasters(fc(7 / 31, 29, 44, NEVER)), timeMs: ORIGIN + 30 * HOUR }, US, [0, -3000])
    expect(c.summary.near).toMatchObject({ text: `${distance(2000.3, 'us').text} north of the mapped fire edge`, kind: 'Mapped', stale: false, burned: null })
    expect(c.summary.near.sub).toBe(`Mapped ${at(p.t_ms)} (10 h before the selected time)`)
    const obs = { observedArrival: ready(makeLayer('observed_arrival', n, 12)) }
    const ins = card({ forecast: f, perimeters: [p], rasters: makeRasters({ ...obs, ...fc(1, 24, 24, 24) }), timeMs: ORIGIN + 30 * HOUR })
    expect(ins.summary.near).toMatchObject({ text: 'Inside the mapped fire area', kind: 'Mapped', burned: `Burned around ${at(ORIGIN + 12 * HOUR)} (estimate)` })
    expect(ins.summary.near.sub).toBe(`${distance(1000, 'us').text} from the edge · mapped ${at(p.t_ms)} (10 h before the selected time)`)
  })
  it('block 3, the model as a dated sentence in Public, the figure in Command', () => {
    const zero = card({ forecast: f, rasters: makeRasters(fc(0, NEVER, NEVER, NEVER)) })
    expect(zero.summary.model).toMatchObject({ text: `In the experimental model (re-run on past weather), 0 of 31 simulated fires reached here by ${at(END)} (72 h). Not a safety guarantee.`, figure: null, kind: 'Model', arrival: null })
    const some = card({ forecast: f, rasters: makeRasters(fc(7 / 31, 29, 44, NEVER)) })
    expect(some.summary.model!.text).toMatch(/^In the experimental model \(re-run on past weather\), 7 of 31 simulated fires reached here by /)
    expect(some.summary.model!.arrival).toBe(`1 in 10 simulated fires reach here by ${at(ORIGIN + 29 * HOUR)}, half of them by ${at(ORIGIN + 44 * HOUR)}.`)
    const cmd = card({ forecast: f, rasters: makeRasters(fc(7 / 31, 29, 44, NEVER)) }, { ...US, preset: 'command' })
    expect(cmd.summary.model).toMatchObject({ figure: '23%', text: `7 of 31 model runs burned this spot by ${at(END)} (72 h). Not a safety guarantee.`, arrival: null })
    expect(cmd.summary.run!.run).toMatch(/^Run fc-test-1 · computed .+ · 31 members \(.+\) · .+\(72 h\)$/)
    expect(cmd.summary.run!.quantiles).toBe(`Arrival P10 ${at(ORIGIN + 29 * HOUR)} · P50 ${at(ORIGIN + 44 * HOUR)} · P90 not reached`)
    expect(cmd.summary.keys).toContain('arrival') // the quantiles are up front in Command
    expect(some.summary.run).toBeNull() // Public: no run ids
    const start = card({ forecast: f, rasters: makeRasters(fc(1, 24, 24, 24)) })
    expect(start.summary.model!.text).toBe(`In the experimental model (re-run on past weather), this spot was already inside the burned area when the run started (${at(f.start_ms)}).`)
    expect(card({ forecast: null }).summary.model).toMatchObject({ text: 'No experimental model run is available for this fire.', kind: 'Unknown' })
    const live = makeManifest(ZONE11, { mode: 'live' })
    const lr = checkLocation(input(live, { ...localLatLon(live, 0, 0), source: 'click' }, { forecast: makeForecast(live), rasters: makeRasters(fc(0.5, 30, 40, 50)) }))
    expect(describeLocation(lr, { ...US, mode: 'live' }).summary.model!.text).toMatch(/^In the experimental model, about 50% of the 31 simulated fires reached here by /)
  })
  it('says so when the fire reached a spot during the run that no model run reached', () => {
    const obs = (h: number) => ({ observedArrival: ready(makeLayer('observed_arrival', n, h)) })
    const none = fc(0, NEVER, NEVER, NEVER)
    const c = card({ forecast: f, rasters: makeRasters({ ...obs(30), ...none }), timeMs: ORIGIN + 40 * HOUR })
    expect(line(c, 'model-missed')).toMatchObject({ text: `The fire reached this spot around ${at(ORIGIN + 30 * HOUR)}, but none of the model runs did`, tone: 'warn', kind: 'Estimate' })
    expect(c.summary.model!.missed).toBe(`The fire reached this spot around ${at(ORIGIN + 30 * HOUR)}, but none of the simulated fires did.`)
    // "no run reached it" is said once (the model sentence); the arrival line waits in the details
    expect(c.summary.keys).toContain('model-missed')
    expect(c.summary.keys).not.toContain('arrival')
    expect(c.details.flatMap((s) => s.lines).map((l) => l.key)).toEqual(expect.arrayContaining(['model-missed-note', 'arrival']))
    // not before the fire got there, not for a burn before the run started or after it ended, not when runs reached it
    expect(card({ forecast: f, rasters: makeRasters({ ...obs(30), ...none }), timeMs: ORIGIN + 28 * HOUR }).summary.model!.missed).toBeNull()
    expect(card({ forecast: f, rasters: makeRasters({ ...obs(10), ...none }), timeMs: ORIGIN + 40 * HOUR }).summary.model!.missed).toBeNull()
    expect(card({ forecast: f, rasters: makeRasters({ ...obs(100), ...none }), timeMs: ORIGIN + 120 * HOUR }).summary.model!.missed).toBeNull()
    const some = card({ forecast: f, rasters: makeRasters({ ...obs(30), ...fc(3 / 31, 40, NEVER, NEVER) }), timeMs: ORIGIN + 40 * HOUR })
    expect(some.summary.model!.missed).toBeNull()
    expect(some.summary.keys).toContain('arrival')
  })
  it('keeps the summary short: sources, periods and meanings move into the details, nothing is said twice', () => {
    const never = { observedArrival: ready(makeLayer('observed_arrival', n, (r, c) => (r >= 190 && r < 210 && c >= 190 && c < 210 ? 12 : NEVER))) }
    const over = { forecast: f, perimeters: [p], detections: [detection(m, 800, 0, ORIGIN + 29 * HOUR)], timeMs: ORIGIN + 30 * HOUR }
    const out = card({ ...over, rasters: makeRasters({ ...never, ...fc(7 / 31, 29, 44, NEVER) }) }, US, [0, -3000])
    expect(out.summary.keys).toEqual(['perimeter', 'burn-chance', 'arrival'])
    const d = out.details.flatMap((s) => s.lines)
    const keys = d.map((l) => l.key)
    expect(keys).toEqual(['perimeter-note', 'observed', 'detection', 'period', 'burn-chance-note', 'arrival-note', 'at-time', 'wind', 'terrain'])
    expect(keys.filter((k) => out.summary.keys.includes(k))).toEqual([])
    expect(d[0]).toMatchObject({ label: 'Mapped perimeter', text: `NIFC WFIGS daily perimeters · mapped ${at(p.t_ms)} (10 h before the selected time) · 988 acres`, technical: null })
    expect(d.find((l) => l.key === 'burn-chance-note')!.text).toMatch(/^Share of the model runs, not a guarantee/)
    expect(line(out, 'perimeter')!.technical).toMatch(/geodesic distance \d+ m · bearing/)
  })
})

describe('main reasons (block 3), each tagged', () => {
  const p = perimeter(ORIGIN + 20 * HOUR, [square(0, 0, 1000)], { acres: 988.4 })
  const rn = n * 2
  const res = ZONE11.extent / rn
  const elev = makeLayer('elevation', rn, (_r, c) => 500 + 0.3 * (c + 0.5) * res, { grid: 'render' }) // rises eastward (30%)
  const reasons = (xz: [number, number], over: Partial<LocationCheckInput> = {}, opts: DescribeOptions = US) =>
    card({ perimeters: [p], timeMs: ORIGIN + 30 * HOUR, weather: makeWeather(m, { speedMs: 8, fromDeg: 270, gustMs: 14 }), rasters: makeRasters({ elevation: ready(elev) }), ...over }, opts, xz).summary.reasons
  it('wind relative to the point: from the fire toward, away from or across it (Model)', () => {
    // wind from the west blows east: toward a point east of the fire, away from a point west of it, across one north
    expect(reasons([3000, 0])[0]).toMatchObject({ key: 'wind', label: 'Wind', kind: 'Model', text: 'blowing from the fire toward here, 18 mph from the west, gusts 31 mph' })
    expect(reasons([-3000, 0])[0].text).toBe('blowing from here toward the fire, not toward here, 18 mph from the west, gusts 31 mph')
    expect(reasons([0, -3000])[0].text).toBe('blowing across, not straight toward here, 18 mph from the west, gusts 31 mph')
    expect(reasons([0, 0])[0].text).toBe('at the fire, 18 mph from the west, gusts 31 mph') // inside: no direction to the point
    const light = reasons([3000, 0], { weather: makeWeather(m, { speedMs: 1, fromDeg: 270, gustMs: 2 }) })
    expect(light[0].text).toMatch(/^light at the fire, 2 mph from the west/)
  })
  it('dryness as numbers, with no category unless an official warning applies', () => {
    const dry = reasons([3000, 0]).find((r) => r.key === 'dryness')!
    expect(dry).toMatchObject({ kind: 'Model', official: null, text: 'humidity 15%, dead grass and twigs 4% moisture (at the fire)' })
    const rfw = reasons([3000, 0], {}, { ...US, fireWeatherNote: 'NWS Red Flag Warning in effect' }).find((r) => r.key === 'dryness')!
    expect(rfw.official).toBe('NWS Red Flag Warning in effect')
  })
  it('uphill of the nearest edge (terrain data), only for a real rise', () => {
    const up = reasons([3000, 0]).find((r) => r.key === 'terrain')!
    expect(up).toMatchObject({ kind: 'Terrain data', label: 'Slope' })
    expect(up.text).toMatch(/^about [\d,]+ ft uphill of the nearest fire edge \([\d.]+ mi away\); fire usually spreads faster uphill$/)
    expect(reasons([-3000, 0]).some((r) => r.key === 'terrain')).toBe(false) // downhill: not a reason
    expect(reasons([0, 0]).some((r) => r.key === 'terrain')).toBe(false) // inside
    const flat = makeLayer('elevation', rn, 500, { grid: 'render' })
    expect(reasons([3000, 0], { rasters: makeRasters({ elevation: ready(flat) }) }).some((r) => r.key === 'terrain')).toBe(false)
    // the details give the comparison either way
    const c = card({ perimeters: [p], timeMs: ORIGIN + 30 * HOUR, rasters: makeRasters({ elevation: ready(elev) }) }, US, [-3000, 0])
    expect(line(c, 'edge-rise')!.text).toMatch(/^About [\d,]+ ft lower than the nearest fire edge \([\d.]+ mi away\)$/)
  })
  it('at most three reasons, and never risk words', () => {
    const c = card({ perimeters: [p], forecast: f, timeMs: ORIGIN + 30 * HOUR, weather: makeWeather(m, { fromDeg: 270 }), rasters: makeRasters({ elevation: ready(elev), ...fc(0, NEVER, NEVER, NEVER) }) }, US, [3000, 0])
    expect(c.summary.reasons.map((r) => r.key)).toEqual(['wind', 'dryness', 'terrain'])
    const text = [c.summary.near.text, ...c.summary.reasons.map((r) => r.text), c.summary.model!.text, ...c.summary.reliability.map((l) => l.text)].join(' ')
    expect(text).not.toMatch(/\bsafe\b|low risk|no risk|\b(low|moderate|high|extreme) (danger|chance)\b/i)
  })
})

describe('updated and reliability (block 4)', () => {
  it('live: the latest observation with its age and the stale flag; the model issue time; never an order', () => {
    const live = makeManifest(ZONE11, { mode: 'live', time_range: { start_ms: ORIGIN, end_ms: ORIGIN + 40 * HOUR, now_ms: ORIGIN + 40 * HOUR } })
    const pt = { ...localLatLon(live, 0, 0), source: 'click' as const }
    const fresh = describeLocation(checkLocation(input(live, pt, { nowMs: ORIGIN + 41 * HOUR, timeMs: ORIGIN + 41 * HOUR, forecast: makeForecast(live), rasters: makeRasters(fc(0.5, 30, 40, 50)) })), { ...US, mode: 'live', nowMs: ORIGIN + 41 * HOUR })
    expect(fresh.summary.reliability.map((l) => [l.key, l.stale])).toEqual([['fire-data', false], ['model', false], ['prototype', false]])
    expect(fresh.summary.reliability[0].text).toBe(`Latest fire observation ${at(ORIGIN + 40 * HOUR)} (1 h ago)`)
    expect(fresh.summary.reliability[1].text).toMatch(/^model issued .+ \(11 h ago\)$/)
    expect(fresh.summary.reliability[2].text).toBe('Research prototype, not an evacuation order')
    const old = describeLocation(checkLocation(input(live, pt, { nowMs: ORIGIN + 57 * HOUR })), { ...US, mode: 'live', nowMs: ORIGIN + 57 * HOUR })
    expect(old.summary.reliability[0]).toMatchObject({ stale: true, text: `Latest fire observation ${at(ORIGIN + 40 * HOUR)} (17 h ago)` })
    expect(old.summary.near.stale).toBe(true)
  })
  it('replay: the fire as of the selected time, the re-run date with its year', () => {
    const c = card({ forecast: f, rasters: makeRasters(fc(0.5, 30, 40, 50)) })
    expect(c.summary.reliability[0].text).toBe(`Past fire, as of ${at(ORIGIN + 30 * HOUR)}`)
    expect(c.summary.reliability[1].text).toMatch(/^model re-run .+20\d\d/)
    expect(c.summary.near.stale).toBe(false)
  })
})

describe('windRelation', () => {
  it.each([
    [270, 90, 'toward'],
    [270, 135, 'toward'],
    [270, 270, 'away'],
    [0, 0, 'away'],
    [0, 180, 'toward'],
    [270, 0, 'across'],
    [350, 10, 'away'],
  ] as const)('wind from %i°, point at %i° from the edge: %s', (from, bearing, rel) => {
    expect(windRelation(from, bearing)).toBe(rel)
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
    expect(t(10)).toBe('The selected time is before the model re-run starts.')
    expect(t(200)).toBe('The selected time is after the model re-run ends.')
  })
})

describe('unknown states are said as such', () => {
  it('missing forecast', () => {
    const c = card({ forecast: null })
    expect(line(c, 'forecast-gap')).toMatchObject({ text: 'No forecast is available for this incident.', kind: 'Unknown' })
  })
  it('outside the modeled area = unknown, not low', () => {
    const c = card({ forecast: f, rasters: makeRasters(fc(0.5, 30, 40, 50)), perimeters: [perimeter(ORIGIN + 20 * HOUR, [square(0, 0, 1000)])] }, US, [9000, 0])
    expect(c.areaNote).toMatch(/^Outside the modeled area/)
    expect(c.areaNote).toMatch(/Unknown, not low risk/)
    expect(line(c, 'forecast-gap')!.text).toBe('Not covered by the forecast: outside the modeled area, so unknown (not low).')
    expect(c.headline.text).toBe(`${distance(8000.0, 'us').text} east of the mapped fire edge`)
    expect(c.caveats[0]).toMatch(/unknown, not low/)
    expect(allText(c)).not.toMatch(/\d+% of model runs|burned this spot by/) // no numbers for an unmodeled spot
    // said once in the summary (the model line), not repeated in the details
    expect(c.summary.model).toMatchObject({ text: 'The experimental model does not cover this spot (outside the modeled area). Unknown, not low.', kind: 'Unknown' })
    expect(c.summary.keys).toEqual(['perimeter', 'forecast-gap'])
    expect(c.details.flatMap((s) => s.lines).map((l) => l.key)).not.toContain('forecast-gap')
    expect(c.summary.reasons.some((r) => r.key === 'terrain')).toBe(false)
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
    expect(inside.headline).toMatchObject({ text: 'Inside the mapped fire area', kind: 'Mapped', tone: 'fire' })
    expect(line(inside, 'perimeter')!.detail).toBe(`NIFC WFIGS daily perimeters · mapped ${at(p.t_ms)} (15 h before the selected time) · 988 acres`)
    const outside = card({ perimeters: [p], timeMs: ORIGIN + 35 * HOUR }, US, [0, -3000])
    expect(outside.headline.text).toBe(`${distance(2000.3, 'us').text} north of the mapped fire edge`)
    const arr = makeLayer('observed_arrival', n, (r, c) => (r >= 190 && r < 210 && c >= 190 && c < 210 ? 12 : NEVER))
    const rec = card({ rasters: makeRasters({ observedArrival: ready(arr) }), detections: [detection(m, 0, 0, ORIGIN + 13 * HOUR)], timeMs: ORIGIN + 15 * HOUR })
    expect(rec.headline).toMatchObject({ text: 'Inside the estimated burned area', kind: 'Estimate' })
    expect(line(rec, 'perimeter')).toMatchObject({ label: 'Estimated burned area', kind: 'Estimate' })
    // a reconstruction is as old as its latest detection, not "now"
    expect(rec.summary.near.sub).toMatch(new RegExp(`^[\\d.]+ (ft|mi) from its edge · from satellite detections up to ${at(ORIGIN + 13 * HOUR)} \\(2 h before the selected time\\)$`))
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
    expect(addr.locationType).toBe('Street address, interpolated (not a rooftop)')
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
