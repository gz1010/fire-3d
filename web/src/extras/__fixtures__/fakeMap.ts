// TEST FIXTURE ONLY: a minimal stand-in for the parts of maplibre-gl's Map that the layer handles use (extras and
// official map layers).
/** Minimal stand-in for the parts of maplibre-gl's Map the handles use. */
export class FakeMap {
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
