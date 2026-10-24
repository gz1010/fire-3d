import { describe, expect, it } from 'vitest'
import { NEVER } from '../api/types'
import { timeFmt } from '../lib/time'
import { describeLocation, type DescribeOptions, type LocationCardModel } from './describe'
import { HOUR, ORIGIN, ZONE11, input, localLatLon, makeForecast, makeLayer, makeManifest, makeRasters, makeWeather, perimeter, ready, square } from './fixtures.testutil'
import { checkLocation, isModelCaveat, MODEL_EDGE_CAVEAT, MODEL_SPOTTING_CAVEAT, ensembleCaveat } from './locationCheck'
import { withoutModel } from './publicCard'

const m = makeManifest(ZONE11)
const f = makeForecast(m)
const n = ZONE11.n
const TF = timeFmt('America/Los_Angeles', '12h') // tz-ok: test
const PUBLIC: DescribeOptions = { units: 'us', preset: 'public', mode: 'historical', nowMs: ORIGIN + 400 * HOUR, tf: TF }

/** A card with every kind of line: a perimeter, the model, wind and dryness, terrain. */
function fullCard(): LocationCardModel {
  const pt = { ...localLatLon(m, 3000, 0), source: 'click' as const }
  const p = perimeter(ORIGIN + 20 * HOUR, [square(0, 0, 1000)])
  const rasters = makeRasters({
    burnProbability: ready(makeLayer('burn_probability', n, 0.3)),
    arrivalP10: ready(makeLayer('arrival_p10', n, 30)),
    arrivalP50: ready(makeLayer('arrival_p50', n, 44)),
    arrivalP90: ready(makeLayer('arrival_p90', n, NEVER)),
  })
  return describeLocation(checkLocation(input(m, pt, { perimeters: [p], forecast: f, timeMs: ORIGIN + 30 * HOUR, weather: makeWeather(m, { speedMs: 8, fromDeg: 270, gustMs: 14 }), rasters })), PUBLIC)
}

const text = (c: LocationCardModel) =>
  JSON.stringify([c.summary.reasons, c.summary.model, c.summary.run, c.summary.reliability, c.details, c.sources, c.caveats])

describe('the Public fire view’s card has no model output (decision a; review R4)', () => {
  it('the full card has model lines to leave out (the fixture is meaningful)', () => {
    const c = fullCard()
    expect(c.summary.model).not.toBeNull()
    expect(c.summary.reasons.some((r) => r.kind === 'Model')).toBe(true)
    expect(c.caveats.some(isModelCaveat)).toBe(true)
    expect(c.sources.some((s) => s.kind === 'model')).toBe(true)
  })

  it('leaves out the spread model, the weather-model wind and dryness, the forecast caveats and model sources', () => {
    const c = withoutModel(fullCard())
    expect(c.summary.model).toBeNull()
    expect(c.summary.run).toBeNull()
    expect(c.summary.reasons.some((r) => r.kind === 'Model')).toBe(false)
    expect(c.details.some((s) => s.key === 'forecast')).toBe(false)
    expect(c.details.flatMap((s) => s.lines).some((l) => l.kind === 'Model')).toBe(false)
    expect(c.sources.some((s) => s.kind === 'model')).toBe(false)
    expect(c.caveats.some(isModelCaveat)).toBe(false)
    expect(text(c)).not.toMatch(/model runs|weather grid|ember spotting|HRRR|Weather model data/i)
  })

  it('keeps what is mapped, official or terrain, and the safety lines', () => {
    const full = fullCard()
    const c = withoutModel(full)
    expect(c.summary.near).toEqual(full.summary.near)
    expect(c.caveats).toContain('One point check does not establish the safety of a route or an area.')
    expect(c.sources.some((s) => s.kind === 'official')).toBe(true)
  })

  it('recognises exactly the forecast’s own caveats', () => {
    expect(isModelCaveat(ensembleCaveat(31))).toBe(true)
    expect(isModelCaveat(MODEL_SPOTTING_CAVEAT)).toBe(true)
    expect(isModelCaveat(MODEL_EDGE_CAVEAT)).toBe(true)
    expect(isModelCaveat('Outside the modeled area: Fire-3d models only the incident’s analysis area, so the forecast and fire reconstruction say nothing about this spot. Its risk is unknown, not low.')).toBe(false)
    expect(isModelCaveat('One point check does not establish the safety of a route or an area.')).toBe(false)
  })
})
