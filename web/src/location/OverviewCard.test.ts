// The overview location card credits the offline lookup that gives the point's state, county and time zone
// (CONTRACT §14.13: "Boundaries: U.S. Census Bureau TIGERweb", "Time zones: USDOT BTS NTAD").
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OfficialInfo } from '../official/hooks'
import { restoreSsrState, ssrState } from '../ui/ssr.testutil'
import { useWorkspace, type SelectedLocation } from '../state/workspace'
import { lookupPoint } from './geoLookup'
import { OverviewCard } from './OverviewCard'

const ATLANTA = { lon: -84.39, lat: 33.75 }
const lookup = {
  ...ATLANTA,
  coverage: 'lower48',
  supported: true,
  state: 'GA',
  state_name: 'Georgia',
  county: { fips: '13121', name: 'Fulton County' },
  time_zone: 'America/New_York',
  time_zone_name: 'Eastern Time',
  note: null,
}

// loading official sources: the card's other blocks are not under test here
const official = {
  evacuation: { state: 'loading', zones: [], checkedMs: null, sourceUpdatedMs: null, sourceUrl: null },
  fireWeather: { state: 'loading', alerts: [], checkedMs: null, archived: false },
  calfire: { state: 'loading' },
} as unknown as OfficialInfo

const sel = { ...ATLANTA, source: 'map' } as unknown as SelectedLocation

afterEach(() => {
  restoreSsrState()
  vi.unstubAllGlobals()
})

describe('OverviewCard credits (§14.13)', () => {
  it('names TIGERweb and NTAD next to the place and the time zone line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(lookup), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    await lookupPoint(ATLANTA.lon, ATLANTA.lat) // the card reads the cached answer while rendering
    ssrState(useWorkspace, { preset: 'public' })
    const html = renderToStaticMarkup(createElement(OverviewCard, { sel, official }))
    const t = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    expect(t).toContain('Place: Fulton County, GA')
    expect(t).toContain('Boundaries: U.S. Census Bureau TIGERweb · Time zones: USDOT BTS NTAD')
    expect(t).toMatch(/E[DS]T/)
  })

  it('no lookup answer yet: no lookup credit', () => {
    ssrState(useWorkspace, { preset: 'public' })
    const html = renderToStaticMarkup(createElement(OverviewCard, { sel: { ...sel, lon: -100.5, lat: 40.5 }, official }))
    expect(html).not.toContain('TIGERweb')
  })
})
