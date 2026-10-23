// The per-region accuracy label (CONTRACT §14.4 and its integration part 2 amendment): every number from the regional
// file, the region and its test fires named, Public's first view in words (how the forecast did, no number), the score
// one tap away, the in-sample sentence, the fuel caveat, a clause left out when the file lacks its value, no banned
// words. The fixture checks the templates; the real file (validation's results) checks every region's lines.
import { describe, expect, it } from 'vitest'
import type { AccuracyRegionsResponse } from '../api/types'
import { findRegion } from '../state/accuracy'
import fixtureText from './fixtures/regional_accuracy.fixture.json?raw'
import realText from '../../../backend/fire3d/data/regional_accuracy.json?raw'
import { ACCURACY_ALWAYS, accuracyLabel, lfmMethodWords, listWords, yearsWords } from './plainLanguage'

const file = (): AccuracyRegionsResponse => JSON.parse(fixtureText) as AccuracyRegionsResponse
const real = (): AccuracyRegionsResponse => JSON.parse(realText) as AccuracyRegionsResponse
const label = (f: AccuracyRegionsResponse, id: Parameters<typeof findRegion>[1]) => accuracyLabel(findRegion(f, id), f.method)
const WEATHER = 'used the weather that really happened; live forecasts must use predicted weather and usually do worse. Experimental: follow local officials.'

describe('accuracy label (§14.4): templates on the fixture', () => {
  it('OSCC (seed: true, no per-fire ratios): region named, the outcome in words, in-sample; the score one tap away, two decimals', () => {
    const l = label(file(), 'OSCC')
    expect(l.status).toBe('tested')
    expect(l.publicLine).toBe(
      "Tested on 3 past fires in the Southern California region (2025). In those tests the forecast showed more new spread than really happened. The model's settings were tuned on these same fires, so this is a best case.",
    )
    expect(l.publicLine).not.toMatch(/\d\.\d/) // no score in Public's first view (round 2 decision 7)
    expect(l.commandLine).toBe(
      'Hindcast growth score 0.43 of 1 in the Southern California region (fires 0.40-0.47; 3 fires, 32 leads, +12-72 h; forecast/real growth ×1.85; live fuel moisture California seasonal values, drought-adjusted; in-sample: settings fitted on these fires).',
    )
    expect(l.fuelCaveat).toBe('Tested on chaparral and grass fires only; other fuels here are untested.')
    expect(l.always).toBe('Outside the modeled area is unknown, not low.')
    // the seed's starts were not pre-registered: no "main growth" clause
    expect(l.publicDetail).toBe(
      `When re-run on these fires, the predicted new spread matched the real new spread with a score of about 0.43 out of 1 (1 = perfect, 0 = none). The test fires scored Eaton, CA 0.44, Madre, CA 0.40 and Palisades, CA 0.47. It usually predicted about 1.9 times as much growth as really happened. These re-runs ${WEATHER}`,
    )
  })

  it('changing the OSCC numbers in the file changes every line (no number is written into a template)', () => {
    const f = file()
    const oscc = findRegion(f, 'OSCC')!
    Object.assign(oscc, { n_fires: 4, n_leads: 40, growth_sorensen: 0.51, range: [0.44, 0.58], growth_ratio_median: 0.4, years: [2024, 2025], fires: [] })
    const l = label(f, 'OSCC')
    expect(l.publicLine).toMatch(/^Tested on 4 past fires in the Southern California region \(2024-2025\)\. In those tests the forecast showed much less new spread than really happened\./)
    expect(l.commandLine).toMatch(/^Hindcast growth score 0\.51 of 1 in the Southern California region \(fires 0\.44-0\.58; 4 fires, 40 leads, \+12-72 h; forecast\/real growth ×0\.4;/)
    expect(l.publicDetail).toContain('a score of about 0.51 out of 1 (1 = perfect, 0 = none; the fires ranged 0.44-0.58)')
    expect(l.publicDetail).toContain('It usually predicted about 40% of the real growth.')
    for (const t of [l.publicLine, l.commandLine, l.publicDetail]) expect(t).not.toContain('0.43')
  })

  it('a tested region outside California: years, lead span from by_lead, GSI explained, fuel editions; main growth from the method', () => {
    const l = label(file(), 'NWCC')
    expect(l.publicLine).toBe('Tested on 2 past fires in the Northwest region (2024-2025). In those tests the forecast showed much more new spread than really happened.')
    expect(l.commandLine).toBe(
      'Hindcast growth score 0.41 of 1 in the Northwest region (fires 0.33-0.48; 2 fires, 24 leads, +12-72 h; forecast/real growth ×2.1; starts during main growth; live fuel moisture GSI (NFDRS growing-season index); fuels LF2023, LF2024).',
    )
    expect(l.publicDetail).toContain('It usually predicted about 2.1 times as much growth as really happened.')
    expect(l.publicDetail).toContain(`These re-runs started during the fires' main growth and ${WEATHER}`)
    expect(l.publicDetail).not.toContain('archived weather')
    expect(l.fuelCaveat).toBe('Tested on timber fires only; other fuels here are untested.')
  })

  it('a clause whose value the file lacks is left out (no fuels, no editions, no leads, no fires: no guess)', () => {
    const l = label(file(), 'SWCC')
    expect(l.publicLine).toBe('Tested on 2 past fires in the Southwest region (2024). In those tests the forecast showed less new spread than really happened.')
    expect(l.commandLine).toBe(
      'Hindcast growth score 0.30 of 1 in the Southwest region (fires 0.25-0.36; 2 fires, 20 leads, +12-72 h; forecast/real growth ×0.6; starts during main growth; live fuel moisture GSI (NFDRS growing-season index)).',
    )
    expect(l.publicDetail).toContain('(1 = perfect, 0 = none; the fires ranged 0.25-0.36)')
    // a method that does not say when the re-runs started: no such clause anywhere
    const f = file()
    f.method.starts = 'fixed per fire'
    const l2 = label(f, 'SWCC')
    expect(l2.commandLine).not.toContain('main growth')
    expect(l2.publicDetail).toContain(`These re-runs ${WEATHER}`)
    expect(l.fuelCaveat).toBeNull()
    expect(l.publicDetail).toContain('It usually predicted about 60% of the real growth.')
    // no growth ratio: no outcome sentence in Public's first view, no growth clause anywhere
    const f3 = file()
    Object.assign(findRegion(f3, 'SWCC')!, { growth_ratio_median: null })
    const l3 = label(f3, 'SWCC')
    expect(l3.publicLine).toBe('Tested on 2 past fires in the Southwest region (2024).')
    expect(l3.commandLine).not.toContain('growth ×')
    expect(l3.publicDetail).not.toContain('predicted about')
  })

  it('both ends of the range equal at two decimals: "both fires …" (review W-m2, never "0.2-0.2")', () => {
    const f = file()
    Object.assign(findRegion(f, 'SWCC')!, { growth_sorensen: 0.351, range: [0.348, 0.352] })
    const l = label(f, 'SWCC')
    expect(l.publicDetail).toContain('with a score of about 0.35 out of 1 (1 = perfect, 0 = none; both fires 0.35)')
    expect(l.commandLine).toContain('(both fires 0.35; 2 fires')
  })

  it('limited: words only in Public; Command adds that fire in brackets', () => {
    const l = label(file(), 'SACC-SP')
    expect(l.status).toBe('limited')
    expect(l.publicLine).toBe('Tested on only 1 past fire in this region: too few for a score.')
    expect(l.commandLine).toBe('Tested on only 1 past fire in this region: too few for a score. [that fire 0.38, 12 leads; not a regional score]')
    expect(l.publicDetail).toBeNull()
    expect(l.fuelCaveat).toBe('Tested on grass fires only; other fuels here are untested.')
  })

  it('untested, missing from the file, or null: "Accuracy not yet tested here."', () => {
    const f = file()
    expect(label(f, 'RMCC')).toMatchObject({ status: 'untested', publicLine: 'Accuracy not yet tested here.', commandLine: 'Accuracy not yet tested here. No past fires in the Rocky Mountain region have been re-run.' })
    expect(label(f, 'ONCC').commandLine).toBe('Accuracy not yet tested here. No past fires in the Northern California region have been re-run.')
    expect(label(f, null)).toMatchObject({ status: 'untested', publicLine: 'Accuracy not yet tested here.', commandLine: 'Accuracy not yet tested here.', fuelCaveat: null })
    f.regions = f.regions.filter((r) => r.id !== 'EACC')
    expect(label(f, 'EACC').publicLine).toBe('Accuracy not yet tested here.')
    expect(accuracyLabel(undefined).always).toBe(ACCURACY_ALWAYS)
  })

  it('helpers', () => {
    expect(lfmMethodWords('gsi_nfdrs2016')).toBe('GSI (NFDRS growing-season index)')
    expect(lfmMethodWords('ca_month_table_drought')).toBe('California seasonal values, drought-adjusted')
    expect(lfmMethodWords('ca_month_table')).toBe('California seasonal values')
    expect(lfmMethodWords(null)).toBeNull()
    expect(listWords(['timber'])).toBe('timber')
    expect(listWords(['timber', 'grass', 'shrub'])).toBe('timber, grass and shrub')
    expect(yearsWords([2025, 2024, 2025])).toBe('2024-2025')
    expect(yearsWords([])).toBeNull()
  })
})

describe('accuracy label on the real regional file (validation, 12 fires outside California; integration part 2)', () => {
  it('Northwest: much less new spread in words; the fires named with their scores behind the tap', () => {
    const l = label(real(), 'NWCC')
    expect(l.publicLine).toBe('Tested on 2 past fires in the Northwest region (2025). In those tests the forecast showed much less new spread than really happened.')
    expect(l.fuelCaveat).toBe('Tested on timber fires only; other fuels here are untested.')
    expect(l.publicDetail).toBe(
      `When re-run on these fires, the predicted new spread matched the real new spread with a score of about 0.26 out of 1 (1 = perfect, 0 = none). The test fires scored Emigrant, OR 0.28 and Lower Sugarloaf, WA 0.23. It usually predicted about 26% of the real growth (Emigrant: about 20%; Lower Sugarloaf: about 40%). These re-runs started during the fires' main growth and ${WEATHER}`,
    )
    expect(l.commandLine).toBe(
      'Hindcast growth score 0.26 of 1 in the Northwest region (fires 0.23-0.28; 2 fires, 24 leads, +12-72 h; forecast/real growth ×0.26; starts during main growth; live fuel moisture GSI (NFDRS growing-season index); fuels LF2024).',
    )
  })

  it('Northern Rockies: the fires erred both ways (no region ratio): said so, never "usually"; Command gives the ratio by fire', () => {
    const l = label(real(), 'NRCC')
    expect(l.publicLine).toBe(
      'Tested on 2 past fires in the Northern Rockies region (2024-2025; grass, shrub and timber fires). In those tests the forecast showed too much new spread on one fire and too little on the other.',
    )
    // every fuel group tested: "other fuels" would be empty (review W-m1)
    expect(l.fuelCaveat).toBe('Only 2 fires were tested here: most fuel and weather conditions in this region are untested.')
    expect(l.publicDetail).toContain('It predicted too much growth on Horse Gulch (about 1.8 times the real growth) and too little on Island Creek (about 63% of the real growth).')
    expect(l.publicDetail).not.toContain('usually predicted')
    expect(l.commandLine).toContain('Hindcast growth score 0.34 of 1 in the Northern Rockies region (fires 0.19-0.49;')
    expect(l.commandLine).toContain('forecast/real growth ×0.63-1.78 by fire;')
  })

  it('Great Basin, Southwest, Southern Plains, Southeast: the direction in words; Southeast never "0.2-0.2"', () => {
    const f = real()
    expect(label(f, 'GBCC').publicLine).toBe(
      'Tested on 2 past fires in the Great Basin region (2025; grass, shrub and timber fires). In those tests the forecast showed less new spread than really happened.',
    )
    expect(label(f, 'GBCC').publicDetail).toContain('Overall it predicted about 83% of the real growth (Cottonwood Peak: about 83%; France Canyon: about right).')
    expect(label(f, 'SWCC').publicLine).toBe(
      'Tested on 2 past fires in the Southwest region (2025; grass, shrub and timber fires). In those tests the forecast showed more new spread than really happened.',
    )
    expect(label(f, 'SWCC').publicDetail).toContain('The test fires scored Trout, NM 0.35 and Greer, AZ 0.35.')
    expect(label(f, 'SWCC').commandLine).toContain('(both fires 0.35; 2 fires, 32 leads')
    expect(label(f, 'SACC-SP').publicLine).toBe('Tested on 2 past fires in the Southern Plains region (2024). In those tests the forecast showed less new spread than really happened.')
    expect(label(f, 'SACC-SP').fuelCaveat).toBe('Tested on grass fires only; other fuels here are untested.')
    const se = label(f, 'SACC-SE')
    expect(se.publicLine).toBe('Tested on 2 past fires in the Southeast region (2025). In those tests the forecast showed much less new spread than really happened.')
    expect(se.publicDetail).toContain('a score of about 0.19 out of 1 (1 = perfect, 0 = none). The test fires scored Table Rock, SC 0.21 and Black Cove, NC 0.17.')
    expect(se.publicDetail).not.toContain('0.2-0.2')
  })

  it('Southern California (tuned, best case): two fires too much, one too little; the region ratio kept, "not on every fire"', () => {
    const l = label(real(), 'OSCC')
    expect(l.publicLine).toBe(
      "Tested on 3 past fires in the Southern California region (2025). In those tests the forecast showed too much new spread on 2 of the 3 fires and too little on the other. The model's settings were tuned on these same fires, so this is a best case.",
    )
    expect(l.publicDetail).toContain(
      'Overall it predicted about 1.9 times as much growth as really happened, but not on every fire: too much growth on Eaton Fire (about 1.7 times the real growth) and Madre Fire (about 2.2 times the real growth); too little on Palisades Fire (about 57% of the real growth).',
    )
    expect(l.commandLine).toBe(
      'Hindcast growth score 0.43 of 1 in the Southern California region (fires 0.40-0.47; 3 fires, 32 leads, +12-72 h; forecast/real growth ×1.85 (×0.57-2.2 by fire); starts during main growth; live fuel moisture California seasonal values, drought-adjusted; fuels LF2024; in-sample: settings fitted on these fires).',
    )
  })

  it('untested regions (Rocky Mountain, Eastern, Northern California): "Accuracy not yet tested here."', () => {
    for (const id of ['RMCC', 'EACC', 'ONCC'] as const) expect(label(real(), id)).toMatchObject({ status: 'untested', publicLine: 'Accuracy not yet tested here.', publicDetail: null })
  })

  it('no line says "accurate", "reliable", "safe" or "low risk"; Public\'s first view has no score', () => {
    for (const f of [file(), real()]) {
      f.method.starts = 'during main growth'
      for (const r of f.regions) {
        const l = label(f, r.id)
        for (const t of [l.publicLine, l.publicDetail ?? '', l.commandLine, l.fuelCaveat ?? '', l.always]) expect(t).not.toMatch(/\baccurate\b|\breliable\b|\bsafe\b|low risk/i)
        expect(l.publicLine).not.toMatch(/\b0\.\d/)
      }
    }
  })
})
