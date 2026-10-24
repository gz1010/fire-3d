// Every way of picking a fire whose card should show goes through showFireCard (brief-3 integration review R1, R3):
// the overview list row and the header picker (fireActions), a map marker (mapController.openFireFromOverview), the
// search box's fire result (SearchBox) and the location card's nearest-fire rows (OverviewCard). Brief 4 (decision b):
// those paths go through pickFire, which opens the fire view directly in Public (openFireView: no card, one history
// entry, no build) and keeps the card in Command and Forensic.
import { afterEach, describe, expect, it } from 'vitest'
import { summaryFixture, wfigsSummaryFixture } from '../api/fixtures.testutil'
import mapControllerSource from '../map/mapController.ts?raw'
import overviewCardSource from '../location/OverviewCard.tsx?raw'
import searchBoxSource from '../location/SearchBox.tsx?raw'
import { openFireView, opensFireView, pickFire, showFireCard } from './fireCard'
import { useStore } from './store'
import { useWorkspace } from './workspace'

const unprepared = wfigsSummaryFixture({ id: '2026-little-giant-091081', name: 'Little Giant', state: 'WA', lat: 47.9, lon: -120.4, acres: 172912, bundle_status: 'none', bbox_lonlat: null })
const prepared = summaryFixture({ id: '2025-lower-sugarloaf-569fb7', name: 'Lower Sugarloaf', bundle_status: 'ready', bbox_lonlat: [-120.7, 47.6, -120.3, 48.0] })
const open = wfigsSummaryFixture({ id: '2024-horse-gulch-889237', bundle_status: 'ready' })

const before = { st: useStore.getState(), ws: useWorkspace.getState() }
afterEach(() => {
  useStore.setState({ catalog: before.st.catalog, summary: before.st.summary, incidentId: before.st.incidentId, incidentSource: before.st.incidentSource, selectIncident: before.st.selectIncident })
  useWorkspace.setState({ fireCardId: before.ws.fireCardId, mapFlyTo: before.ws.mapFlyTo, workspace: before.ws.workspace, preset: before.ws.preset })
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

  it('the marker, search and location-card paths call pickFire (the card, or the Public fire view), never their own flight', () => {
    const marker = /private openFireFromOverview\(id: string\): void \{([\s\S]*?)\n {2}\}/.exec(mapControllerSource)?.[1] ?? ''
    expect(marker).toContain('pickFire(id)')
    expect(marker).not.toContain('requestMapFlyTo')
    for (const src of [searchBoxSource, overviewCardSource]) {
      expect(src).toContain("from '../state/fireCard'")
      expect(src).toContain('pickFire(s.id, s)')
      expect(src).not.toMatch(/requestMapFlyTo\(\s*(req|fireFlyTo)/)
    }
  })
})

describe('Public: a picked fire opens the fire view (brief 4 decision b)', () => {
  const calls: { id: string; source: string | undefined }[] = []
  const seedPublic = (opts: { open?: boolean; preset?: 'public' | 'command'; workspace?: 'map' | 'forensic' } = {}) => {
    seed({ open: opts.open, workspace: opts.workspace })
    calls.length = 0
    useStore.setState({
      selectIncident: async (id: string, o?: { source?: string }) => {
        calls.push({ id, source: o?.source })
      },
    } as never)
    useWorkspace.setState({ preset: opts.preset ?? 'public' })
  }

  it('opens the fire directly: no card, no flight of its own, source "card" (one history entry), no build', () => {
    seedPublic()
    useWorkspace.setState({ fireCardId: 'other' })
    pickFire(unprepared.id)
    expect(calls).toEqual([{ id: unprepared.id, source: 'card' }])
    const ws = useWorkspace.getState()
    expect(ws.fireCardId).toBeNull()
    expect(ws.mapFlyTo).toBeNull()
  })

  it('a prepared fire, a search hit or a location-card row: the same direct open', () => {
    seedPublic()
    pickFire(prepared.id, prepared)
    const searched = { ...unprepared, id: '2026-cottonwood-abc123' }
    pickFire(searched.id, searched)
    expect(calls.map((c) => c.id)).toEqual([prepared.id, searched.id])
    expect(useWorkspace.getState().fireCardId).toBeNull()
  })

  it('the fire already open is framed again, not reopened', () => {
    seedPublic({ open: true })
    openFireView(open.id)
    expect(calls).toEqual([])
  })

  it('Command and Forensic keep the fire card', () => {
    seedPublic({ preset: 'command' })
    expect(opensFireView()).toBe(false)
    pickFire(unprepared.id)
    expect(calls).toEqual([])
    expect(useWorkspace.getState().fireCardId).toBe(unprepared.id)
    seedPublic({ workspace: 'forensic' })
    expect(opensFireView()).toBe(false)
    pickFire(unprepared.id)
    expect(calls).toEqual([])
    expect(useWorkspace.getState().fireCardId).toBe(unprepared.id)
  })

  it('Public has no zoom focus and no "Spread not prepared yet" chips; a pending focus change is cancelled', () => {
    const src = mapControllerSource.replace(/\s+/g, ' ')
    expect(src).toMatch(/const publicView = useWorkspace\.getState\(\)\.preset === 'public'/)
    expect(src).toMatch(/const chips = publicView \? \[\] : chipTargets\(/)
    expect(src).toMatch(/if \(publicView\) \{ this\.keepShownFocus\(\) return \}/)
    // a preset switch evaluates the view again (Command's focus and chips come back)
    expect(src).toMatch(/if \(s\.preset !== p\.preset\) this\.scheduleFocus\(\)/)
  })

  it('every other card path in the map controller follows the preset (chip, outline, own marker)', () => {
    const src = mapControllerSource.replace(/\s+/g, ' ')
    expect(src).toMatch(/if \(cardId\) \{ if \(opensFireView\(\)\) openFireView\(cardId\) else ws\.setFireCard\(cardId\)/)
    expect(src).toMatch(/if \(!opensFireView\(\)\) ws\.setFireCard\(incidentId\)/)
  })
})
