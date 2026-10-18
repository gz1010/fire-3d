import { describe, expect, it } from 'vitest'
import { EVAC_SAMPLE } from './__fixtures__/samples'
import { evacuationLayerGroup, EVAC_LAYERS, EVAC_SOURCE, mountEvacuationLayer } from './evacuation'
import { firstSymbolLayerId, LayerGroupHandle, resolveBeforeId } from './mapLayers'
import { FakeMap } from './__fixtures__/fakeMap'

const ids = (m: FakeMap) => m.layers.map((l) => l.id)

describe('layer handles', () => {
  it('finds the first label layer', () => {
    expect(firstSymbolLayerId(new FakeMap() as never)).toBe('place-labels')
  })

  it('draws fills and lines below the labels and its own labels on top', () => {
    const map = new FakeMap()
    const h = mountEvacuationLayer(map as never)
    h.setData(EVAC_SAMPLE)
    expect(ids(map)).toEqual([
      'background',
      'roads',
      EVAC_LAYERS.tint,
      EVAC_LAYERS.hatch,
      EVAC_LAYERS.lineOther,
      EVAC_LAYERS.lineWarning,
      EVAC_LAYERS.lineOrder,
      'place-labels',
      EVAC_LAYERS.label,
    ])
    expect(map.images.size).toBe(3)
  })

  it('updates data in place, toggles visibility, survives a basemap swap and removes cleanly', () => {
    const map = new FakeMap()
    const h = mountEvacuationLayer(map as never, { visible: false })
    h.setData(EVAC_SAMPLE)
    expect(map.getLayer(EVAC_LAYERS.tint)!.layout).toMatchObject({ visibility: 'none' })
    h.setVisible(true)
    expect(map.getLayer(EVAC_LAYERS.label)!.layout).toMatchObject({ visibility: 'visible' })
    h.setData({ ...EVAC_SAMPLE, zones: { ...EVAC_SAMPLE.zones, features: EVAC_SAMPLE.zones.features.slice(0, 1) } })
    expect(map.setDataCalls).toBe(1)
    map.swapStyle()
    expect(map.getSource(EVAC_SOURCE)).toBeDefined()
    expect(ids(map).filter((i) => i.startsWith('fx-extras-'))).toHaveLength(6)
    expect(map.getLayer(EVAC_LAYERS.tint)!.layout).toMatchObject({ visibility: 'visible' })
    h.setData(null)
    expect(map.getSource(EVAC_SOURCE)).toBeUndefined()
    expect(ids(map).some((i) => i.startsWith('fx-extras-'))).toBe(false)
    h.setData(EVAC_SAMPLE)
    h.remove()
    expect(ids(map)).toEqual(['background', 'roads', 'place-labels'])
    expect(map.images.size).toBe(0)
    map.swapStyle() // no listener left
    expect(map.getSource(EVAC_SOURCE)).toBeUndefined()
  })

  it('waits for the style before adding and honours beforeId', () => {
    const map = new FakeMap()
    map.loaded = false
    let data: typeof EVAC_SAMPLE | null = EVAC_SAMPLE
    const h = new LayerGroupHandle(map as never, () => evacuationLayerGroup(data), { beforeId: 'roads' })
    expect(map.getSource(EVAC_SOURCE)).toBeUndefined()
    map.loaded = true
    map.fire('style.load')
    expect(ids(map).indexOf(EVAC_LAYERS.tint)).toBe(ids(map).indexOf('roads') - 5)
    data = null
    h.sync()
    expect(map.getSource(EVAC_SOURCE)).toBeUndefined()
  })

  it('uses the lowest present candidate as beforeId, re-resolved after a style swap', () => {
    const map = new FakeMap()
    // map-core-like draped layers (bottom to top); the forecast raster exists only with a forecast
    map.layers.splice(2, 0, { id: 'fx-observed-raster', type: 'raster' }, { id: 'fx-observed-edge', type: 'line' })
    const draped = ['fx-forecast-raster', 'fx-observed-raster', 'fx-observed-edge']
    expect(resolveBeforeId(map as never, draped)).toBe('fx-observed-raster')
    expect(resolveBeforeId(map as never, 'missing')).toBeUndefined()
    expect(resolveBeforeId(map as never, null)).toBeUndefined()
    const h = mountEvacuationLayer(map as never, { beforeId: draped })
    h.setData(EVAC_SAMPLE)
    expect(ids(map).indexOf(EVAC_LAYERS.lineOrder)).toBe(ids(map).indexOf('fx-observed-raster') - 1)
    expect(ids(map).indexOf(EVAC_LAYERS.label)).toBe(ids(map).length - 1) // official wording on top
    // after a basemap swap only the vector layers come back first: fall back below the labels
    map.swapStyle()
    expect(ids(map).indexOf(EVAC_LAYERS.lineOrder)).toBe(ids(map).indexOf('place-labels') - 1)
  })

  it('restores its place below the fire layers after a basemap load (styledata fires before style.load)', () => {
    // a basemap with 3D buildings below its labels; map-core puts its draped fire layers below the buildings
    const map = new FakeMap()
    map.layers.splice(2, 0, { id: 'buildings', type: 'fill-extrusion', source: 'ofm' })
    const draped = ['fx-observed-raster', 'fx-observed-edge']
    const addFireLayers = () => {
      map.addLayer({ id: 'fx-observed-raster', type: 'raster' }, 'buildings')
      map.addLayer({ id: 'fx-observed-edge', type: 'line' }, 'buildings')
    }
    addFireLayers()
    const h = mountEvacuationLayer(map as never, { beforeId: draped })
    h.setData(EVAC_SAMPLE)
    const below = () => ids(map).indexOf(EVAC_LAYERS.lineOrder) < ids(map).indexOf('fx-observed-raster')
    expect(below()).toBe(true)
    // MapLibre's order on setStyle: the new style replaces every custom layer, 'styledata' (the handle re-adds itself:
    // no fire layer yet, so below the labels), map-core re-adds its fire layers on 'style.load' (registered first),
    // then the handle's own 'style.load'
    map.layers = map.layers.filter((l) => l.source === 'ofm' || l.type === 'background')
    for (const id of [...map.sources.keys()]) if (id !== 'ofm') map.sources.delete(id)
    map.images.clear()
    map.fire('styledata')
    expect(ids(map).indexOf(EVAC_LAYERS.lineOrder)).toBe(ids(map).indexOf('place-labels') - 1)
    addFireLayers()
    map.fire('style.load')
    expect(below()).toBe(true)
    // the group keeps its own order, and its label stays on top
    expect(ids(map).slice(ids(map).indexOf(EVAC_LAYERS.tint), ids(map).indexOf(EVAC_LAYERS.lineOrder) + 1)).toEqual([
      EVAC_LAYERS.tint,
      EVAC_LAYERS.hatch,
      EVAC_LAYERS.lineOther,
      EVAC_LAYERS.lineWarning,
      EVAC_LAYERS.lineOrder,
    ])
    expect(ids(map).indexOf(EVAC_LAYERS.label)).toBe(ids(map).length - 1)
  })

  it('keeps top layers below the given top layers (incident, events, selection) when present', () => {
    const map = new FakeMap()
    map.layers.push({ id: 'fx-events-circle', type: 'circle' }, { id: 'fx-incident-label', type: 'symbol' })
    const h = mountEvacuationLayer(map as never, { topBeforeId: ['fx-aoi-line', 'fx-events-circle', 'fx-incident-label'] })
    h.setData(EVAC_SAMPLE)
    expect(ids(map).slice(-3)).toEqual([EVAC_LAYERS.label, 'fx-events-circle', 'fx-incident-label'])
  })
})
