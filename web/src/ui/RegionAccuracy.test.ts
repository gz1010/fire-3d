// The accuracy line of the Analysis drawer and the Forensic Analysis tab (§14.4, the Command line), from the regional
// file, for the open fire only.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { summaryFixture, wfigsSummaryFixture } from '../api/fixtures.testutil'
import type { AccuracyRegionsResponse } from '../api/types'
import fixtureText from '../lib/fixtures/regional_accuracy.fixture.json?raw'
import { useAccuracyStore } from '../state/accuracy'
import { useStore } from '../state/store'
import { RegionAccuracy } from './RegionAccuracy'
import { restoreSsrState, ssrState } from './ssr.testutil'

const regions = JSON.parse(fixtureText) as AccuracyRegionsResponse
const text = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')

afterEach(() => restoreSsrState())

describe('RegionAccuracy (§14.4)', () => {
  it('shows the Command line of the open fire, with the always line', () => {
    const s = summaryFixture({ id: 'f' })
    ssrState(useStore, { incidentId: 'f', summary: s })
    ssrState(useAccuracyStore, { status: 'ok', data: regions, error: null })
    const t = text(renderToStaticMarkup(createElement(RegionAccuracy)))
    expect(t).toContain('Hindcast growth score 0.43 of 1 in the Southern California region (fires 0.40-0.47; 3 fires, 32 leads, +12-72 h;')
    expect(t).toContain('Outside the modeled area is unknown, not low.')
  })
  it('Public (the Analysis drawer): the words, with the score one tap away (decision 7; review UX-m7)', () => {
    const s = summaryFixture({ id: 'f' })
    ssrState(useStore, { incidentId: 'f', summary: s })
    ssrState(useAccuracyStore, { status: 'ok', data: regions, error: null })
    const t = text(renderToStaticMarkup(createElement(RegionAccuracy, { words: true })))
    expect(t).toMatch(/Model accuracy here Tested on 3 past fires in the Southern California region/)
    expect(t).toContain('How was it tested?')
    // the score is behind the disclosure (closed on first render)
    expect(t).not.toContain('Hindcast growth score')
    expect(t).toContain('Outside the modeled area is unknown, not low.')
  })
  it('untested region: the untested words; no fire open: nothing', () => {
    const s = wfigsSummaryFixture({ id: 'g', accuracy_region: 'EACC' })
    ssrState(useStore, { incidentId: 'g', summary: s })
    ssrState(useAccuracyStore, { status: 'ok', data: regions, error: null })
    expect(text(renderToStaticMarkup(createElement(RegionAccuracy)))).toContain('Accuracy not yet tested here. No past fires in the Eastern region have been re-run.')
    ssrState(useStore, { incidentId: null, summary: null })
    expect(renderToStaticMarkup(createElement(RegionAccuracy))).toBe('')
  })
})
