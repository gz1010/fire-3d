// The per-region accuracy label (CONTRACT §14.4): every number from the regional file, the in-sample sentence, the
// fuel caveat, a clause left out when the file lacks its value, and no banned words.
import { describe, expect, it } from 'vitest'
import type { AccuracyRegionsResponse } from '../api/types'
import { findRegion } from '../state/accuracy'
import fixtureText from './fixtures/regional_accuracy.fixture.json?raw'
import { ACCURACY_ALWAYS, accuracyLabel, lfmMethodWords, listWords, yearsWords } from './plainLanguage'

const file = (): AccuracyRegionsResponse => JSON.parse(fixtureText) as AccuracyRegionsResponse
const label = (f: AccuracyRegionsResponse, id: Parameters<typeof findRegion>[1]) => accuracyLabel(findRegion(f, id), f.method)

describe('accuracy label (§14.4)', () => {
  it('OSCC from the seed values: the exact Public and Command lines, in-sample', () => {
    const l = label(file(), 'OSCC')
    expect(l.status).toBe('tested')
    expect(l.publicLine).toBe(
      "Tested on 3 past fires in this region (2025; chaparral and grass fires). The model's settings were tuned on these same fires, so this is a best case.",
    )
    expect(l.commandLine).toBe(
      'Hindcast growth score 0.43 (fires 0.40-0.47; 3 fires, 32 leads, +12-72 h; growth ×1.85; live fuel moisture California seasonal values, drought-adjusted; in-sample: settings fitted on these fires).',
    )
    expect(l.fuelCaveat).toBe('Tested on chaparral and grass fires only; other fuels here are untested.')
    expect(l.always).toBe('Outside the modeled area is unknown, not low.')
    // Public's score, one tap away: one decimal, always the range
    expect(l.publicDetail).toBe(
      'When re-run on these fires, the predicted new spread matched the real new spread with a score of about 0.4 out of 1 (1 = perfect, 0 = none; the fires ranged 0.4-0.5). It usually predicted about 1.9× too much growth. These re-runs used archived weather, so live forecasts usually do worse. Experimental: follow local officials.',
    )
  })

  it('changing the OSCC numbers in the file changes both lines (no number is written into a template)', () => {
    const f = file()
    const oscc = findRegion(f, 'OSCC')!
    Object.assign(oscc, { n_fires: 4, n_leads: 40, growth_sorensen: 0.51, range: [0.44, 0.58], growth_ratio_median: 1.3, years: [2024, 2025] })
    const l = label(f, 'OSCC')
    expect(l.publicLine).toMatch(/^Tested on 4 past fires in this region \(2024-2025; chaparral and grass fires\)\./)
    expect(l.commandLine).toMatch(/^Hindcast growth score 0\.51 \(fires 0\.44-0\.58; 4 fires, 40 leads, \+12-72 h; growth ×1\.3;/)
    expect(l.publicDetail).toContain('a score of about 0.5 out of 1 (1 = perfect, 0 = none; the fires ranged 0.4-0.6)')
    expect(l.publicLine).not.toContain('0.43')
    expect(l.commandLine).not.toContain('0.43')
  })

  it('a tested region outside California: years, fuels, lead span from by_lead, GSI, fuel editions; main growth from the method', () => {
    const f = file()
    f.method.starts = 'pre-registered, during main growth'
    const l = label(f, 'NWCC')
    expect(l.publicLine).toBe('Tested on 2 past fires in this region (2024-2025; timber fires).')
    expect(l.commandLine).toBe(
      'Hindcast growth score 0.41 (fires 0.33-0.48; 2 fires, 24 leads, +12-72 h; growth ×2.1; starts during main growth; live fuel moisture GSI; fuels LF2023, LF2024).',
    )
    expect(l.publicDetail).toContain('It usually predicted about 2.1× too much growth.')
    expect(l.publicDetail).toContain("These re-runs started during the fires' main growth and used archived weather")
    expect(l.fuelCaveat).toBe('Tested on timber fires only; other fuels here are untested.')
  })

  it('a clause whose value the file lacks is left out (no fuels, no editions, no leads: no guess)', () => {
    const l = label(file(), 'SWCC')
    expect(l.publicLine).toBe('Tested on 2 past fires in this region (2024).')
    expect(l.commandLine).toBe('Hindcast growth score 0.30 (fires 0.25-0.36; 2 fires, 20 leads, +12-72 h; growth ×0.6; live fuel moisture GSI).')
    expect(l.fuelCaveat).toBeNull()
    expect(l.publicDetail).toContain('It usually predicted about 60% of the real growth.')
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

  it('no template says "accurate", "reliable", "safe" or "low risk"', () => {
    const f = file()
    f.method.starts = 'during main growth'
    for (const r of f.regions) {
      const l = label(f, r.id)
      for (const t of [l.publicLine, l.publicDetail ?? '', l.commandLine, l.fuelCaveat ?? '', l.always]) expect(t).not.toMatch(/\baccurate\b|\breliable\b|\bsafe\b|low risk/i)
    }
  })

  it('helpers', () => {
    expect(lfmMethodWords('gsi_nfdrs2016')).toBe('GSI')
    expect(lfmMethodWords('ca_month_table_drought')).toBe('California seasonal values, drought-adjusted')
    expect(lfmMethodWords('ca_month_table')).toBe('California seasonal values')
    expect(lfmMethodWords(null)).toBeNull()
    expect(listWords(['timber'])).toBe('timber')
    expect(listWords(['timber', 'grass', 'shrub'])).toBe('timber, grass and shrub')
    expect(yearsWords([2025, 2024, 2025])).toBe('2024-2025')
    expect(yearsWords([])).toBeNull()
  })
})
