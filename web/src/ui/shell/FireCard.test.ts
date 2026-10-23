// The fire card (CONTRACT §14.4, §14.5): the agency's record through recordIssuerLabel / recordBlocks, the records of
// both agencies when they disagree (the Timber Fire case), a CAL FIRE complex with its NIFC WFIGS members, the agency id
// line, times in the fire's own zone with the preset's clock, and the accuracy label outside the official record.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { otherRecordFixture, summaryFixture, wfigsSummaryFixture } from '../../api/fixtures.testutil'
import type { AccuracyRegionsResponse, IncidentSummary } from '../../api/types'
import fixtureText from '../../lib/fixtures/regional_accuracy.fixture.json?raw'
import { useAccuracyStore } from '../../state/accuracy'
import { EMPTY_CATALOG } from '../../state/catalog'
import { useStore } from '../../state/store'
import { useWorkspace } from '../../state/workspace'
import { restoreSsrState, ssrState } from '../ssr.testutil'
import { FireCard } from './FireCard'

const regions = JSON.parse(fixtureText) as AccuracyRegionsResponse
const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const text = (h: string) => decode(h.replace(/<[^>]+>/g, ''))

/** The card's markup, split into the official record section and everything else. */
function render(fire: IncidentSummary, preset: 'public' | 'command' = 'public') {
  ssrState(useStore, { incidentId: null, summary: null, catalog: { ...EMPTY_CATALOG, live: fire.mode === 'live' ? [fire] : [], season: fire.mode === 'live' ? [] : [fire] } })
  ssrState(useWorkspace, { fireCardId: fire.id, preset, workspace: 'map' })
  ssrState(useAccuracyStore, { status: 'ok', data: regions, error: null })
  const html = renderToStaticMarkup(createElement(FireCard))
  const a = html.indexOf('<section class="fc-official"')
  const b = html.indexOf('</section>', a)
  expect(a).toBeGreaterThan(-1)
  return { html, all: text(html), official: text(html.slice(a, b)), outside: text(html.slice(0, a) + html.slice(b)) }
}

afterEach(() => restoreSsrState())

describe('fire card record (§14.5)', () => {
  it('a NIFC WFIGS fire: issuer label with the agency name, its own zone, state, id line; never "CAL FIRE"', () => {
    // Horse Gulch, MT: updated Aug 2, 2024 15:30 UTC = 9:30 AM MDT
    const r = render(wfigsSummaryFixture())
    expect(r.official).toContain('USFS (USDA Forest Service) via NIFC WFIGS incident record')
    expect(r.official).toContain('USFS (USDA Forest Service) via NIFC WFIGS record last edited Aug 2, 2024 9:30 AM MDT')
    expect(r.official).toContain('Incident ID (NIFC WFIGS): 889237AB-0000-0000-0000-000000000000')
    expect(r.official).toContain('NIFC WFIGS record')
    expect(r.outside).toContain('Lewis and Clark Co., MT')
    expect(r.all).not.toMatch(/CAL FIRE incident|by CAL FIRE|CAL FIRE record/)
  })

  it('Command reads 24-hour in the same zone', () => {
    const r = render(wfigsSummaryFixture(), 'command')
    expect(r.official).toContain('record last edited Aug 2, 2024 09:30 MDT')
  })

  it('a California fire keeps "CAL FIRE incident record" and Pacific time (12-hour in Public)', () => {
    const r = render(summaryFixture({ year: 2026, started_ms: Date.UTC(2026, 6, 1, 20), updated_ms: Date.UTC(2026, 6, 3, 18, 0) }))
    expect(r.official).toContain('CAL FIRE incident record')
    expect(r.official).toMatch(/CAL FIRE record last edited Jul 3,( 2026)? 11:00 AM PDT/) // the year only when it is not this year
    expect(r.official).toContain('CAL FIRE incident page')
    expect(r.official).toContain('Incident ID (CAL FIRE): abc12345-0000-0000-0000-000000000000')
  })

  it('agencies that disagree: each record with its own issuer, status and time (the Timber Fire)', () => {
    const timber = summaryFixture({
      id: '2026-timber-fire-51374d',
      name: 'Timber Fire',
      mode: 'live',
      year: 2026,
      is_active: true,
      updated_ms: Date.UTC(2026, 9, 20, 17, 0),
      active_sources: ['wfigs'],
      irwin_id: '51374D2C-0000-0000-0000-000000000000',
      other_records: [otherRecordFixture({ is_active: true, updated_ms: Date.UTC(2026, 9, 22, 16, 5) })],
    })
    const r = render(timber)
    expect(r.official).toContain("The agencies' records differ on whether the fire is active")
    expect(r.official).toContain('Not listed as active (CAL FIRE, updated Oct 20, 10:00 AM PDT)')
    expect(r.official).toContain('Active (USFS via NIFC WFIGS, updated Oct 22, 9:05 AM PDT)')
    // agreeing agencies: one record, no split
    const agree = render({ ...timber, active_sources: ['calfire', 'wfigs'] })
    expect(agree.official).not.toContain('records differ')
  })

  it('a CAL FIRE complex: heading, acres and containment stay CAL FIRE’s; members named and linked under "Includes"', () => {
    const tcu = summaryFixture({
      id: '2026-tcu-lightning-complex-aaaaaa',
      name: 'TCU Lightning Complex',
      acres: 12_345,
      percent_contained: 85,
      year: 2026,
      complex_members: ['2-2', '2-7'],
      other_records: [
        otherRecordFixture({ name: '2-2', acres: 999_999, percent_contained: 3, is_active: false, url: 'https://example.org/2-2' }),
        otherRecordFixture({ id: 'B', name: '2-7', acres: 777_777, percent_contained: 1, is_active: false, url: 'https://example.org/2-7' }),
      ],
    })
    const r = render(tcu)
    expect(r.official).toContain('CAL FIRE incident record')
    expect(r.official).toContain('12,345 ac')
    expect(r.official).toContain('85%')
    expect(r.official).not.toMatch(/999,999|777,777|999999|777777/)
    expect(r.official).toContain('Includes (NIFC WFIGS names): 2-2, 2-7')
    expect(r.html).toContain('href="https://example.org/2-2"')
    expect(r.html).toContain('href="https://example.org/2-7"')
  })

  it('a member fire outside California says which complex it is part of (the name verbatim, "Complex" never twice)', () => {
    expect(render(wfigsSummaryFixture({ complex_name: 'Montana Lightning Complex' })).outside).toContain('Part of the Montana Lightning Complex')
    expect(render(wfigsSummaryFixture({ complex_name: 'Montana Lightning Complex' })).outside).not.toContain('Complex Complex')
    expect(render(wfigsSummaryFixture({ complex_name: 'Bear Creek' })).outside).toContain('Part of the Bear Creek Complex')
  })
})

describe('fire card accuracy label (§14.4)', () => {
  it('no accuracy text is inside .fc-official; the label sits next to the model note', () => {
    for (const preset of ['public', 'command'] as const) {
      const r = render(summaryFixture({ year: 2026 }), preset)
      expect(r.official).not.toMatch(/Tested on|Hindcast growth score|Accuracy not yet tested|unknown, not low/)
      expect(r.outside).toContain('Outside the modeled area is unknown, not low.')
      const acc = r.html.indexOf('fc-accuracy')
      const note = r.html.indexOf('fc-note')
      expect(acc).toBeGreaterThan(r.html.indexOf('</section>', r.html.indexOf('fc-official')))
      expect(note).toBeGreaterThan(acc)
    }
  })

  it('Public: the words and "How was it tested?"; Command: the score line', () => {
    const pub = render(summaryFixture({ year: 2026 }))
    expect(pub.outside).toContain("Tested on 3 past fires in this region (2025; chaparral and grass fires). The model's settings were tuned on these same fires, so this is a best case.")
    expect(pub.outside).toContain('How was it tested?')
    expect(pub.outside).not.toContain('Hindcast growth score')
    const cmd = render(summaryFixture({ year: 2026 }), 'command')
    expect(cmd.outside).toContain('Hindcast growth score 0.43 (fires 0.40-0.47; 3 fires, 32 leads, +12-72 h;')
    expect(cmd.outside).not.toContain('How was it tested?')
  })

  it('an untested or unassigned region: "Accuracy not yet tested here."', () => {
    expect(render(wfigsSummaryFixture({ accuracy_region: 'NRCC' })).outside).toContain('Accuracy not yet tested here.')
    expect(render(wfigsSummaryFixture({ accuracy_region: null })).outside).toContain('Accuracy not yet tested here.')
    expect(render(wfigsSummaryFixture({ accuracy_region: 'NRCC' }), 'command').outside).toContain('No past fires in the Northern Rockies region have been re-run.')
  })
})
