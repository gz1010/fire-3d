// Every way of picking a fire whose card should show goes through showFireCard (brief-3 integration review R1, R3):
// the overview list row and the header picker (fireActions), a map marker (mapController.openFireFromOverview), the
// search box's fire result (SearchBox) and the location card's nearest-fire rows (OverviewCard).
import { afterEach, describe, expect, it } from 'vitest'
import { summaryFixture, wfigsSummaryFixture } from '../api/fixtures.testutil'
import mapControllerSource from '../map/mapController.ts?raw'
import overviewCardSource from '../location/OverviewCard.tsx?raw'
import searchBoxSource from '../location/SearchBox.tsx?raw'
import { showFireCard } from './fireCard'
import { useStore } from './store'
import { useWorkspace } from './workspace'

const unprepared = wfigsSummaryFixture({ id: '2026-little-giant-091081', name: 'Little Giant', state: 'WA', lat: 47.9, lon: -120.4, acres: 172912, bundle_status: 'none', bbox_lonlat: null })
const prepared = summaryFixture({ id: '2025-lower-sugarloaf-569fb7', name: 'Lower Sugarloaf', bundle_status: 'ready', bbox_lonlat: [-120.7, 47.6, -120.3, 48.0] })
const open = wfigsSummaryFixture({ id: '2024-horse-gulch-889237', bundle_status: 'ready' })

const before = { st: useStore.getState(), ws: useWorkspace.getState() }
afterEach(() => {
  useStore.setState({ catalog: before.st.catalog, summary: before.st.summary, incidentId: before.st.incidentId, incidentSource: before.st.incidentSource })
  useWorkspace.setState({ fireCardId: before.ws.fireCardId, mapFlyTo: before.ws.mapFlyTo, workspace: before.ws.workspace })
})
const seed = (opts: { open?: boolean; workspace?: 'map' | 'forensic' } = {}) => {
  useStore.setState({
    incidentId: opts.open ? open.id : null,
    incidentSource: opts.open ? 'card' : null,
    summary: opts.open ? open : null,
    catalog: { ...useStore.getState().catalog, live: [unprepared], season: [], historical: [prepared] },
  })
  useWorkspace.setState({ workspace: opts.workspace ?? 'map', fireCardId: null, mapFlyTo: null })
}

describe('showFireCard: every path', () => {
  it('a map marker click (the id of a listed fire): the flight holds the zoom focus and the card stays', () => {
    seed()
    showFireCard(unprepared.id)
    const ws = useWorkspace.getState()
    expect(ws.fireCardId).toBe(unprepared.id)
    expect(ws.mapFlyTo).toMatchObject({ source: 'fire-card', lon: unprepared.lon, lat: unprepared.lat })
  })

  it("a search result or a location card row (the caller's own summary, not in the lists): the same hold", () => {
    seed()
    const searched = { ...unprepared, id: '2026-cottonwood-abc123', name: 'Cottonwood', lat: 41.2, lon: -101.7 }
    showFireCard(searched.id, searched)
    const ws = useWorkspace.getState()
    expect(ws.fireCardId).toBe(searched.id)
    expect(ws.mapFlyTo).toMatchObject({ source: 'fire-card', lon: searched.lon, lat: searched.lat })
  })

  it('a prepared fire is flown to without the hold (the zoom then opens it)', () => {
    seed()
    showFireCard(prepared.id, prepared)
    const fly = useWorkspace.getState().mapFlyTo
    expect(fly?.bounds).toEqual([-120.7, 47.6, -120.3, 48.0])
    expect(fly?.source).toBeUndefined()
  })

  it('another open fire closes first, so the header never describes it while the map shows the picked fire (R3)', () => {
    seed({ open: true })
    showFireCard(unprepared.id)
    expect(useStore.getState().incidentId).toBeNull()
    const ws = useWorkspace.getState()
    expect(ws.fireCardId).toBe(unprepared.id)
    expect(ws.mapFlyTo).toMatchObject({ source: 'fire-card' })
  })

  it('a prepared fire picked while another is open: the open fire stays until the zoom focuses the new one', () => {
    seed({ open: true })
    showFireCard(prepared.id)
    expect(useStore.getState().incidentId).toBe(open.id)
    expect(useWorkspace.getState().mapFlyTo?.source).toBeUndefined()
  })

  it('the open fire picked again keeps it open', () => {
    seed({ open: true })
    useStore.setState({ summary: { ...open, bundle_status: 'none' } })
    showFireCard(open.id)
    expect(useStore.getState().incidentId).toBe(open.id)
    expect(useWorkspace.getState().fireCardId).toBe(open.id)
  })

  it('Forensic: the card opens, the camera and the open fire stay', () => {
    seed({ open: true, workspace: 'forensic' })
    showFireCard(unprepared.id)
    expect(useStore.getState().incidentId).toBe(open.id)
    expect(useWorkspace.getState().fireCardId).toBe(unprepared.id)
    expect(useWorkspace.getState().mapFlyTo).toBeNull()
  })

  it('the marker, search and location-card paths call showFireCard, never their own flight', () => {
    const marker = /private openFireFromOverview\(id: string\): void \{([\s\S]*?)\n {2}\}/.exec(mapControllerSource)?.[1] ?? ''
    expect(marker).toContain('showFireCard(id)')
    expect(marker).not.toContain('requestMapFlyTo')
    for (const src of [searchBoxSource, overviewCardSource]) {
      expect(src).toContain("from '../state/fireCard'")
      expect(src).not.toMatch(/requestMapFlyTo\(\s*(req|fireFlyTo)/)
    }
  })
})
