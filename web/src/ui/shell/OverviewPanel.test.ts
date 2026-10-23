// The national overview list (§14.11) and the list-absence line of §14.14 in the legend, the list footer, the empty
// view and the phone peek (server-rendered markup; no DOM needed).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { summaryFixture, wfigsSummaryFixture } from '../../api/fixtures.testutil'
import { MapLegend } from '../../map/MapLegend'
import { useMapRuntime } from '../../map/mapStore'
import { EMPTY_CATALOG } from '../../state/catalog'
import { EMPTY_VIEW, LIST_ABSENCE, LIST_ABSENCE_SHORT, NIFC_LIST_DOWN } from '../../state/overview'
import { useStore } from '../../state/store'
import { useWorkspace } from '../../state/workspace'
import { restoreSsrState, ssrState } from '../ssr.testutil'
import { OverviewList, PeekBar } from './OverviewPanel'

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const has = (html: string, text: string) => html.includes(esc(text)) || html.includes(text)

const garfieldCO = wfigsSummaryFixture({ id: '2026-garfield-co-111111', name: 'Pine Gulch', county: 'Garfield', state: 'CO', lon: -108.5, lat: 39.5, mode: 'live', is_active: true, year: 2026, updated_ms: Date.now() - 5 * 60_000 })
const garfieldMT = wfigsSummaryFixture({ id: '2026-garfield-mt-222222', name: 'Big Dry', county: 'Garfield', state: 'MT', lon: -106.9, lat: 47.3, mode: 'live', is_active: true, year: 2026 })
const eaton = summaryFixture({ id: '2026-ca-333333', name: 'Coast', year: 2026, acres: 900, county: 'Los Angeles', state: 'CA', lon: -118.1, lat: 34.2 })

function setLists(live = [garfieldCO, garfieldMT], season = [eaton]) {
  ssrState(useStore, { incidentId: null, catalog: { ...EMPTY_CATALOG, live, season, updatedMs: { live: 1, season: 1, historical: null } } })
}

afterEach(() => {
  restoreSsrState()
  useStore.setState({ incidentId: null, catalog: EMPTY_CATALOG })
  useMapRuntime.setState({ viewBox: null })
  useWorkspace.setState({ overviewFilter: 'season', overviewShowAll: false })
})

describe('overview list (§14.11)', () => {
  it('rows carry the county and state ("Garfield Co., CO" vs "Garfield Co., MT")', () => {
    setLists()
    const html = renderToStaticMarkup(createElement(OverviewList, { onPick: () => undefined }))
    expect(has(html, 'Garfield Co., CO')).toBe(true)
    expect(has(html, 'Garfield Co., MT')).toBe(true)
    expect(has(html, 'Los Angeles Co., CA')).toBe(true)
  })

  it('"N fires in this view · Show all M": only the fires in the map view, unless Show all', () => {
    setLists()
    ssrState(useMapRuntime, { viewBox: [-112, 36, -100, 42] }) // Colorado only
    let html = renderToStaticMarkup(createElement(OverviewList, { onPick: () => undefined }))
    expect(has(html, '1 fire in this view')).toBe(true)
    expect(has(html, 'Show all 3')).toBe(true)
    expect(html.match(/data-row=/g)?.length).toBe(1)
    expect(has(html, 'Pine Gulch')).toBe(true)
    expect(has(html, 'Big Dry')).toBe(false)
    ssrState(useWorkspace, { overviewShowAll: true })
    html = renderToStaticMarkup(createElement(OverviewList, { onPick: () => undefined }))
    expect(html.match(/data-row=/g)?.length).toBe(3)
    expect(has(html, 'Show the fires in this view')).toBe(true)
  })

  it('W11: above 150 rows only the rows near the view render; every row keeps its place in the whole list', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      wfigsSummaryFixture({ id: `2026-many-${String(i).padStart(6, '0')}`, name: `Fire ${i}`, lon: -110 + (i % 40) * 0.2, lat: 40 + Math.floor(i / 40) * 0.2, mode: 'live', is_active: true, year: 2026, acres: 10_000 - i }),
    )
    setLists(many, [])
    ssrState(useWorkspace, { overviewFilter: 'active', overviewShowAll: true })
    const html = renderToStaticMarkup(createElement(OverviewList, { onPick: () => undefined }))
    const rendered = html.match(/data-row=/g)?.length ?? 0
    expect(rendered).toBeGreaterThan(10)
    expect(rendered).toBeLessThan(40)
    expect(html).toContain('class="ov-list is-windowed"')
    expect(html).toContain('aria-setsize="400"')
    expect(html).toContain('aria-posinset="1"')
    expect(html).not.toContain('data-row="399"')
    // the rows not rendered keep their room (the scroller's height is the whole list's)
    expect(html).toMatch(/padding-bottom:\s*\d{4,}px/)
    // 150 rows or fewer: every row, no window
    setLists(many.slice(0, 150), [])
    const all = renderToStaticMarkup(createElement(OverviewList, { onPick: () => undefined }))
    expect(all.match(/data-row=/g)?.length).toBe(150)
    expect(all).not.toContain('is-windowed')
    expect(all).toContain('aria-setsize="150"')
  })

  it('the list footer carries the list-absence line', () => {
    setLists()
    const html = renderToStaticMarkup(createElement(OverviewList, { onPick: () => undefined }))
    const foot = html.slice(html.indexOf('<footer'))
    expect(has(foot, LIST_ABSENCE)).toBe(true)
  })

  it('a view with no listed fire says "No listed fires in this view." and the line (never "no fires")', () => {
    setLists()
    ssrState(useMapRuntime, { viewBox: [-75, 40, -70, 44] }) // nothing listed there
    const html = renderToStaticMarkup(createElement(OverviewList, { onPick: () => undefined }))
    const body = html.slice(html.indexOf('ov-body'))
    expect(has(body, EMPTY_VIEW)).toBe(true)
    expect(has(body, LIST_ABSENCE)).toBe(true)
    expect(body).not.toMatch(/no fires/i)
    // said once: the footer does not repeat the line under the empty view
    expect(html.split(esc(LIST_ABSENCE)).length - 1).toBe(1)
    expect(html).not.toContain('<footer')
  })

  it('an empty filter says who lists nothing, with the line', () => {
    setLists([], [])
    ssrState(useWorkspace, { overviewFilter: 'active' })
    const html = renderToStaticMarkup(createElement(OverviewList, { onPick: () => undefined }))
    const body = html.slice(html.indexOf('ov-body'))
    expect(has(body, 'CAL FIRE and NIFC list no active fires right now.')).toBe(true)
    expect(has(body, LIST_ABSENCE)).toBe(true)
  })

  it('a list source reported unavailable shows the §14.14 notice', () => {
    setLists()
    ssrState(useStore, {
      catalog: { ...useStore.getState().catalog, sources: { live: [{ id: 'wfigs', name: 'NIFC WFIGS (IRWIN)', status: 'unavailable', retrieved_ms: null, reason: 'down' }], season: null, historical: null } },
    })
    const html = renderToStaticMarkup(createElement(OverviewList, { onPick: () => undefined }))
    expect(has(html, NIFC_LIST_DOWN)).toBe(true)
  })
})

describe('phone peek and legend', () => {
  it('the peek: "N active fires · records updated 5 min ago" and the short absence line', () => {
    setLists()
    const html = renderToStaticMarkup(createElement(PeekBar))
    expect(html).toMatch(/2 active fires<\/b> · records updated \d+ min ago/)
    expect(has(html, LIST_ABSENCE_SHORT)).toBe(true)
    expect(html).not.toMatch(/\d\d:\d\d/) // relative, never a bare clock time in some zone
  })

  it('the legend (overview) carries the group entries and the list-absence line', () => {
    setLists()
    const html = renderToStaticMarkup(createElement(MapLegend as (p: { inline?: boolean }) => ReturnType<typeof MapLegend>, { inline: true }))
    for (const t of [
      'Group of active fires (number = how many)',
      'Group of other 2026 fires',
      'Small active fire (under 10 acres or size not reported)',
      'Fires (CAL FIRE in California, NIFC WFIGS elsewhere; official records)',
      LIST_ABSENCE,
    ])
      expect(has(html, t), t).toBe(true)
  })
})
