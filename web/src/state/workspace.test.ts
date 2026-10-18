import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from './store'
import { DEFAULT_MAP_LAYERS, incidentFlyTo, isDemoBundle, parseWorkspaceParams, useWorkspace, writeWorkspaceParams } from './workspace'

describe('workspace URL params', () => {
  it('parses valid values and ignores invalid ones', () => {
    const p = parseWorkspaceParams('?ws=forensic&preset=command&persp=3d&basemap=aerial&units=metric&view=-118.1,34.2,12.5,30,45&sel=34.25,-118.05')
    expect(p).toEqual({
      workspace: 'forensic',
      preset: 'command',
      perspective: '3d',
      basemap: 'aerial',
      units: 'metric',
      view: { centerLon: -118.1, centerLat: 34.2, zoom: 12.5, bearing: 30, pitch: 45 },
      selection: { lat: 34.25, lon: -118.05 },
    })
    const bad = parseWorkspaceParams('?ws=globe&preset=x&persp=4d&basemap=sat&units=imperial&view=500,1,2&sel=91,0')
    expect(Object.values(bad).every((v) => v === null)).toBe(true)
    expect(parseWorkspaceParams('?view=-118,34,40,0,120').view).toMatchObject({ zoom: 22, pitch: 85 })
  })

  it('writes non-default fields, keeps foreign params and drops one-shot view / sel', () => {
    const u = new URL('http://x/?incident=abc&mode=historical&view=1,2,3&sel=1,2')
    writeWorkspaceParams(u, { workspace: 'map', preset: 'command', perspective: '2d', basemap: 'dark', units: 'us' })
    expect(u.search).toBe('?incident=abc&mode=historical&ws=map&preset=command')
    writeWorkspaceParams(u, { workspace: 'forensic', preset: 'public', perspective: '3d', basemap: 'roads', units: 'metric' })
    expect(u.searchParams.get('preset')).toBeNull()
    expect(u.searchParams.get('persp')).toBe('3d')
    expect(u.searchParams.get('basemap')).toBe('roads')
    expect(u.searchParams.get('units')).toBe('metric')
  })
})

describe('workspace store', () => {
  beforeEach(() => {
    useWorkspace.setState({ selection: null, view: null, mapFlyTo: null, mapLayers: { ...DEFAULT_MAP_LAYERS } })
    useStore.setState({ incidentId: null })
  })

  it('defaults to the Public map in 2D with US units', () => {
    const s = useWorkspace.getState()
    expect([s.workspace, s.preset, s.perspective, s.basemap, s.units]).toEqual(['map', 'public', '2d', 'dark', 'us'])
    expect(s.mapLayers.cameras).toBe(false)
  })

  it('selects, flies only on request, and marks dragged pins as adjusted', () => {
    const ws = useWorkspace.getState()
    ws.selectLocation({ lat: 34.2, lon: -118.1, source: 'click' })
    expect(useWorkspace.getState().mapFlyTo).toBeNull()
    ws.selectLocation({ lat: 34.21, lon: -118.11, source: 'address', label: '1 Main St', approximate: true, adjustable: true }, { fly: true, zoom: 15 })
    const fly = useWorkspace.getState().mapFlyTo
    expect(fly).toMatchObject({ lon: -118.11, lat: 34.21, zoom: 15 })
    ws.requestMapFlyTo({ lon: 0, lat: 0 })
    expect(useWorkspace.getState().mapFlyTo?.nonce).toBe((fly?.nonce ?? 0) + 1)
    ws.moveSelection(34.215, -118.105)
    expect(useWorkspace.getState().selection).toMatchObject({ lat: 34.215, lon: -118.105, label: '1 Main St', adjusted: true, approximate: false, source: 'address' })
    ws.selectLocation({ lat: 123, lon: 0, source: 'coords' })
    expect(useWorkspace.getState().selection?.lat).toBe(34.215)
  })

  it('drops the view and incident-bound selections when the incident changes', () => {
    useStore.setState({ incidentId: 'a' })
    useWorkspace.setState({ view: { centerLon: 1, centerLat: 2, zoom: 3, bearing: 0, pitch: 0 } })
    useWorkspace.getState().selectLocation({ lat: 34, lon: -118, source: 'event', eventId: 'e1' })
    useStore.setState({ incidentId: 'b' })
    expect(useWorkspace.getState().view).toBeNull()
    expect(useWorkspace.getState().selection).toBeNull()
    useWorkspace.getState().selectLocation({ lat: 34, lon: -118, source: 'address' })
    useStore.setState({ incidentId: 'c' })
    expect(useWorkspace.getState().selection?.source).toBe('address')
  })

  it('frames incidents by AOI bounds, else by reported coordinates', () => {
    expect(incidentFlyTo({ lat: 34, lon: -118 }, { grid: { bbox_lonlat: [-118.2, 34.1, -118.0, 34.3] } as never })).toEqual({ lon: -118.1, lat: 34.2, bounds: [-118.2, 34.1, -118.0, 34.3] })
    expect(incidentFlyTo({ lat: 34, lon: -118 }, null)).toEqual({ lon: -118, lat: 34, zoom: 12 })
    expect(incidentFlyTo(null, null)).toBeNull()
  })

  it('flags synthetic fixtures as demo data', () => {
    expect(isDemoBundle('fixture-demo')).toBe(true)
    expect(isDemoBundle('2025-eaton-fire-dbfa57', { data_sources: [{ name: 'USGS 3DEP DEM', detail: '', fetched_ms: 0 }] })).toBe(false)
    expect(isDemoBundle('x', { data_sources: [{ name: 'Terrain (synthetic)', detail: '', fetched_ms: 0 }] })).toBe(true)
  })
})
