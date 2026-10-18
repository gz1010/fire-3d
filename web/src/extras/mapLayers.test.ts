import { describe, expect, it } from 'vitest'
import { EVAC_SAMPLE } from './__fixtures__/samples'
import { evacuationLayerGroup, EVAC_LAYERS, EVAC_SOURCE, mountEvacuationLayer } from './evacuation'
import { firstSymbolLayerId, LayerGroupHandle, resolveBeforeId } from './mapLayers'

/** Minimal stand-in for the parts of maplibre-gl's Map the handles use. */
class FakeMap {
  layers: { id: string; type: string; source?: string; layout?: Record<string, unknown> }[] = [
    { id: 'background', type: 'background' },
    { id: 'roads', type: 'line', source: 'ofm' },
    { id: 'place-labels', type: 'symbol', source: 'ofm' },
  ]
  sources = new Map<string, { type: string; data?: unknown; setData?: (d: unknown) => void }>([['ofm', { type: 'vector' }]])
  images = new Set<string>()
  loaded = true
  handlers = new Map<string, Set<() => void>>()
  setDataCalls = 0

  getStyle() {
    return this.loaded ? { version: 8, sources: {}, layers: this.layers } : undefined
  }
  getSource(id: string) {
    return this.sources.get(id)
  }
  addSource(id: string, spec: { type: string; data?: unknown }) {
    if (this.sources.has(id)) throw new Error(`source ${id} exists`)
    const src = { ...spec, setData: (d: unknown) => {
      src.data = d
      this.setDataCalls++
    } }
    this.sources.set(id, src)
  }
  removeSource(id: string) {
    if (this.layers.some((l) => l.source === id)) throw new Error(`source ${id} in use`)
    this.sources.delete(id)
  }
  getLayer(id: string) {
    return this.layers.find((l) => l.id === id)
  }
  addLayer(spec: { id: string; type: string; source?: string; layout?: Record<string, unknown> }, before?: string) {
    if (this.getLayer(spec.id)) throw new Error(`layer ${spec.id} exists`)
    const i = before ? this.layers.findIndex((l) => l.id === before) : -1
    if (i >= 0) this.layers.splice(i, 0, spec)
    else this.layers.push(spec)
  }
  removeLayer(id: string) {
    this.layers = this.layers.filter((l) => l.id !== id)
  }
  moveLayer(id: string, before?: string) {
    const l = this.getLayer(id)!
    this.removeLayer(id)
    this.addLayer(l, before)
  }
  setLayoutProperty(id: string, k: string, v: unknown) {
    const l = this.getLayer(id)!
    l.layout = { ...l.layout, [k]: v }
  }
  hasImage(id: string) {
    return this.images.has(id)
  }
  addImage(id: string) {
    this.images.add(id)
  }
  removeImage(id: string) {
    this.images.delete(id)
  }
  on(t: string, f: () => void) {
    if (!this.handlers.has(t)) this.handlers.set(t, new Set())
    this.handlers.get(t)!.add(f)
  }
  off(t: string, f: () => void) {
    this.handlers.get(t)?.delete(f)
  }
  fire(t: string) {
    for (const f of [...(this.handlers.get(t) ?? [])]) f()
  }
  /** setStyle: everything custom disappears, then style.load. */
  swapStyle() {
    this.layers = this.layers.filter((l) => l.source === 'ofm' || l.type === 'background')
    for (const id of [...this.sources.keys()]) if (id !== 'ofm') this.sources.delete(id)
    this.images.clear()
    this.fire('style.load')
  }
}

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

  it('keeps top layers below the given top layers (incident, events, selection) when present', () => {
    const map = new FakeMap()
    map.layers.push({ id: 'fx-events-circle', type: 'circle' }, { id: 'fx-incident-label', type: 'symbol' })
    const h = mountEvacuationLayer(map as never, { topBeforeId: ['fx-aoi-line', 'fx-events-circle', 'fx-incident-label'] })
    h.setData(EVAC_SAMPLE)
    expect(ids(map).slice(-3)).toEqual([EVAC_LAYERS.label, 'fx-events-circle', 'fx-incident-label'])
  })
})
