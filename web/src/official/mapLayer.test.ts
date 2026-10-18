import { afterEach, describe, expect, it } from 'vitest'
import { FakeMap } from '../extras/__fixtures__/fakeMap'
import { EVAC_SAMPLE } from '../extras/__fixtures__/samples'
import { useExtrasRuntime } from '../extras/runtime'
import { useStore } from '../state/store'
import { highlightDisplayData, mountOfficialLayers, OFFICIAL_LAYERS, OFFICIAL_SOURCES, officialLayerGroup } from './mapLayer'
import { fireWeatherDisplayData } from './fireWeather'
import { useOfficialRuntime } from './runtime'
import { FW_EATON_ARCHIVE } from './__fixtures__/samples'
import { OFFICIAL_COLORS } from './style'

const REPLAY = 1736366400000

afterEach(() => {
  useOfficialRuntime.setState({ fireWeather: { data: null, loading: false, error: null, refresh: () => {} }, highlight: null })
  useExtrasRuntime.setState({ evac: { data: null, loading: false, error: null, refresh: () => {} } })
})

describe('official map layer data', () => {
  it('highlights the selected Cal OES zones or NWS zones only', () => {
    const z = EVAC_SAMPLE.zones.features[0]
    expect(highlightDisplayData({ kind: 'evacuation', id: 'x', zoneIds: [z.id] }, EVAC_SAMPLE, null).features.map((f) => f.id)).toEqual([z.id])
    const fw = highlightDisplayData({ kind: 'fire-weather', id: 'y', ugcs: ['CAZ288'], alertIds: [] }, null, FW_EATON_ARCHIVE)
    expect(fw.features.map((f) => f.id)).toEqual(['CAZ288'])
    // drawn by kind: a selected NWS alert in its own colour below the fire layers; an evacuation zone in white on top
    expect(fw.features[0].properties).toMatchObject({ kind: 'warning' })
    expect(highlightDisplayData({ kind: 'evacuation', id: 'x', zoneIds: [z.id] }, EVAC_SAMPLE, null).features[0].properties).toMatchObject({ kind: 'evacuation' })
    const watchAlert = FW_EATON_ARCHIVE.alerts.find((a) => a.vtec?.significance === 'A')
    if (watchAlert) {
      const w = highlightDisplayData({ kind: 'fire-weather', id: 'w', ugcs: [], alertIds: [watchAlert.id] }, null, FW_EATON_ARCHIVE)
      expect(w.features.every((f) => (f.properties as { kind: string }).kind === 'watch')).toBe(true)
    }
    expect(highlightDisplayData(null, EVAC_SAMPLE, FW_EATON_ARCHIVE).features).toEqual([])
    expect(highlightDisplayData({ kind: 'evacuation', id: 'x', zoneIds: [z.id] }, { ...EVAC_SAMPLE, status: 'not_available_for_past_dates' }, null).features).toEqual([])
  })

  it('draws outlines below the labels (warning and watch styles differ by dash) and its labels on top', () => {
    const g = officialLayerGroup(fireWeatherDisplayData(FW_EATON_ARCHIVE, REPLAY), { type: 'FeatureCollection', features: [] })!
    expect(Object.keys(g.sources)).toEqual([OFFICIAL_SOURCES.fireWeather, OFFICIAL_SOURCES.highlight])
    expect(g.layers.filter((l) => l.placement === 'below-labels').map((l) => l.spec.id)).toEqual([
      OFFICIAL_LAYERS.hlFill,
      OFFICIAL_LAYERS.fwCasing,
      OFFICIAL_LAYERS.fwWatch,
      OFFICIAL_LAYERS.fwWarning,
      OFFICIAL_LAYERS.hlFwCasing,
      OFFICIAL_LAYERS.hlFwLine,
      OFFICIAL_LAYERS.fwLabel,
    ])
    expect(g.layers.filter((l) => l.placement === 'top').map((l) => l.spec.id)).toEqual([OFFICIAL_LAYERS.hlCasing, OFFICIAL_LAYERS.hlLine])
    const paint = (id: string) => (g.layers.find((l) => l.spec.id === id)!.spec as { paint: Record<string, unknown> }).paint
    const warn = paint(OFFICIAL_LAYERS.fwWarning)
    const watch = paint(OFFICIAL_LAYERS.fwWatch)
    expect(warn['line-dasharray']).not.toEqual(watch['line-dasharray'])
    // quiet (integration, coordinator's clarity note): NWS zones are large, so their unselected outlines are thin, dashed,
    // semi-transparent (fading as the view closes in on a fire) with a light casing, below the fire layers
    for (const p of [warn, watch]) {
      expect(p['line-width']).toBeLessThanOrEqual(1.5)
      expect(Array.isArray(p['line-opacity'])).toBe(true)
    }
    expect(paint(OFFICIAL_LAYERS.fwCasing)['line-width']).toBeLessThanOrEqual(3)
    expect(paint(OFFICIAL_LAYERS.fwCasing)['line-color']).toBe(OFFICIAL_COLORS.fwCasing)
    expect(officialLayerGroup({ type: 'FeatureCollection', features: [] }, { type: 'FeatureCollection', features: [] })).toBeNull()
  })
})

describe('mountOfficialLayers', () => {
  it('follows its stores, keeps below map-core layers, survives a basemap swap, hides and removes cleanly', () => {
    useStore.setState({ incidentId: '2025-eaton-fire-dbfa57', mode: 'historical', timeMs: REPLAY, manifest: null })
    useOfficialRuntime.setState({ fireWeather: { data: FW_EATON_ARCHIVE, loading: false, error: null, refresh: () => {} }, seen: { incidentId: null, alerts: [] } })
    const map = new FakeMap()
    map.layers.splice(2, 0, { id: 'fx-draped', type: 'fill', source: 'x' })
    const h = mountOfficialLayers(map as never, { beforeId: ['fx-draped'], topBeforeId: null })
    const order = () => map.layers.map((l) => l.id)
    expect(order().indexOf(OFFICIAL_LAYERS.fwWarning)).toBeLessThan(order().indexOf('fx-draped'))
    // NWS labels sit below the fire layers (where an outline crosses the fire, the fire covers its label)
    expect(order().indexOf(OFFICIAL_LAYERS.fwLabel)).toBeLessThan(order().indexOf('fx-draped'))
    // a highlight from a selected row appears; another fire's data is never drawn
    useOfficialRuntime.getState().setHighlight({ kind: 'fire-weather', id: 'r', ugcs: ['CAZ288'], alertIds: [] })
    const hl = map.getSource(OFFICIAL_SOURCES.highlight)!.data as { features: unknown[] }
    expect(hl.features).toHaveLength(1)
    useStore.setState({ incidentId: '2026-cooley-fire-0c342f' })
    expect(map.getLayer(OFFICIAL_LAYERS.fwWarning)).toBeUndefined()
    useStore.setState({ incidentId: '2025-eaton-fire-dbfa57' })
    expect(map.getLayer(OFFICIAL_LAYERS.fwWarning)).toBeDefined()
    // basemap swap: re-added
    map.swapStyle()
    expect(map.getLayer(OFFICIAL_LAYERS.fwWarning)).toBeDefined()
    h.update({ visible: false })
    expect(map.getLayer(OFFICIAL_LAYERS.fwWarning)?.layout?.visibility).toBe('none')
    h.update({ visible: true })
    expect(map.getLayer(OFFICIAL_LAYERS.fwWarning)?.layout?.visibility).toBe('visible')
    h.remove()
    expect(order().some((id) => id.startsWith('fx-official'))).toBe(false)
    expect(map.getSource(OFFICIAL_SOURCES.fireWeather)).toBeUndefined()
  })
})
