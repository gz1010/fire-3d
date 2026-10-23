import { afterEach, describe, expect, it } from 'vitest'
import { summaryFixture, wfigsSummaryFixture } from '../../api/fixtures.testutil'
import { useStore } from '../../state/store'
import { useWorkspace } from '../../state/workspace'
import { showFireCard } from './fireActions'

// Integration (brief 3): picking an unprepared fire's card from the list must not open a prepared fire whose analysis
// area the card's view covers (Little Giant, WA, next to the prepared Lower Sugarloaf Fire). The card's flight carries
// `source: 'fire-card'`, which holds the map's zoom focus (map/focus.ts FocusHold) until the user moves the map.
describe('showFireCard', () => {
  const unprepared = wfigsSummaryFixture({ id: '2026-little-giant-091081', name: 'Little Giant', state: 'WA', lat: 47.9, lon: -120.4, acres: 172912, bundle_status: 'none', bbox_lonlat: null })
  const prepared = summaryFixture({ id: '2025-lower-sugarloaf-569fb7', name: 'Lower Sugarloaf', bundle_status: 'ready', bbox_lonlat: [-120.7, 47.6, -120.3, 48.0] })
  const before = { catalog: useStore.getState().catalog, summary: useStore.getState().summary, ws: useWorkspace.getState() }
  afterEach(() => {
    useStore.setState({ catalog: before.catalog, summary: before.summary })
    useWorkspace.setState({ fireCardId: before.ws.fireCardId, mapFlyTo: before.ws.mapFlyTo, workspace: before.ws.workspace })
  })
  const seed = () => {
    useStore.setState({ summary: null, catalog: { ...useStore.getState().catalog, live: [unprepared], season: [], historical: [prepared] } })
    useWorkspace.setState({ workspace: 'map', fireCardId: null, mapFlyTo: null })
  }

  it("an unprepared fire's flight holds the zoom focus; its card stays open", () => {
    seed()
    showFireCard(unprepared.id)
    const ws = useWorkspace.getState()
    expect(ws.fireCardId).toBe(unprepared.id)
    expect(ws.mapFlyTo).toMatchObject({ source: 'fire-card', lon: unprepared.lon, lat: unprepared.lat })
  })

  it('a prepared fire is flown to as before (the zoom then opens it)', () => {
    seed()
    showFireCard(prepared.id)
    const fly = useWorkspace.getState().mapFlyTo
    expect(fly?.bounds).toEqual([-120.7, 47.6, -120.3, 48.0])
    expect(fly?.source).toBeUndefined()
  })
})
