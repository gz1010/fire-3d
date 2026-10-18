// Small MapLibre helper for the optional-source layers (owner: optional-sources). A handle owns one group of
// sources, layers and images on a map: it updates data in place, toggles visibility, re-adds everything after a
// basemap swap (`setStyle` drops custom sources, layers and images), and removes itself cleanly. Only types are
// imported from maplibre-gl, so these modules add nothing to bundles that never mount them.
import type { LayerSpecification, Map as MapLibreMap, SourceSpecification } from 'maplibre-gl'
import type { RgbaImage } from './style'

export interface PlacedLayer {
  spec: LayerSpecification
  /** 'below-labels': under the basemap's labels (or `beforeId`); 'top': above the labels (markers, own labels), below
   *  `topBeforeId` when given. */
  placement: 'below-labels' | 'top'
}

export interface LayerGroup {
  sources: Record<string, SourceSpecification>
  layers: PlacedLayer[]
  images?: Record<string, RgbaImage & { pixelRatio: number }>
}

/** A layer id, or candidate ids in stacking order (bottom first): the first one present on the map is used. */
export type BeforeId = string | readonly string[] | null

export interface LayerHandleOptions {
  /** Insert 'below-labels' layers below this layer when it exists, e.g. map-core's draped wildfire layers bottom to
   *  top (`drapedLayers().map((l) => l.id)`, some exist only with data) so fire information stays on top; resolved
   *  again on every (re)add. Without one present: below the style's first symbol (label) layer. */
  beforeId?: BeforeId
  /** Insert 'top' layers (icons, official wording) below this layer when present, e.g. map-core's top layers
   *  (`topLayers().map((l) => l.id)`) so the incident, events and selection stay above; otherwise on top. */
  topBeforeId?: BeforeId
  /** Initial visibility (the MapLayerKey toggle). */
  visible?: boolean
}

/** The first candidate present on the map (see `BeforeId`), else undefined. */
export function resolveBeforeId(map: MapLibreMap, before: BeforeId | undefined): string | undefined {
  if (!before) return undefined
  const list = typeof before === 'string' ? [before] : before
  return list.find((id) => !!map.getLayer(id))
}

/** Id of the first symbol (label) layer of the current style, if any. */
export function firstSymbolLayerId(map: MapLibreMap): string | undefined {
  try {
    return map.getStyle()?.layers?.find((l) => l.type === 'symbol')?.id
  } catch {
    return undefined
  }
}

/**
 * Generic handle: `build()` returns the group for the current data (or null to show nothing). Sources whose spec is
 * GeoJSON are updated with setData; any other source change (raster tiles, image URL) is re-created.
 */
export class LayerGroupHandle {
  private map: MapLibreMap
  private build: () => LayerGroup | null
  private beforeId: BeforeId
  private topBeforeId: BeforeId
  private visible: boolean
  private current: LayerGroup | null = null
  private removed = false
  private syncing = false
  private readonly onStyle = () => this.sync(true)
  /** A diffing setStyle (or another owner) can drop our sources without a 'style.load': re-add them. */
  private readonly onStyleData = () => {
    if (this.syncing || this.removed || !this.current) return
    const first = Object.keys(this.current.sources)[0]
    if (first && styleReady(this.map) && !this.map.getSource(first)) this.sync(true)
  }

  constructor(map: MapLibreMap, build: () => LayerGroup | null, opts: LayerHandleOptions = {}) {
    this.map = map
    this.build = build
    this.beforeId = opts.beforeId ?? null
    this.topBeforeId = opts.topBeforeId ?? null
    this.visible = opts.visible ?? true
    map.on('style.load', this.onStyle)
    map.on('styledata', this.onStyleData)
    this.sync()
  }

  /** Re-run build() and apply it (call after the data changed). */
  sync(force = false): void {
    if (this.removed || this.syncing) return
    this.syncing = true
    try {
      this.apply(force)
    } finally {
      this.syncing = false
    }
  }

  private apply(force: boolean): void {
    const next = this.build()
    const map = this.map
    if (!styleReady(map)) {
      this.current = next
      return
    }
    const prev = force ? null : this.current
    // remove what is no longer wanted
    if (this.current) {
      const keepLayers = new Set(next?.layers.map((l) => l.spec.id) ?? [])
      for (const l of this.current.layers) if (!keepLayers.has(l.spec.id) && map.getLayer(l.spec.id)) map.removeLayer(l.spec.id)
      const keepSources = new Set(Object.keys(next?.sources ?? {}))
      for (const id of Object.keys(this.current.sources)) {
        if (!keepSources.has(id) && map.getSource(id)) {
          for (const l of this.current.layers) if ((l.spec as { source?: string }).source === id && map.getLayer(l.spec.id)) map.removeLayer(l.spec.id)
          map.removeSource(id)
        }
      }
    }
    this.current = next
    if (!next) return
    for (const [id, img] of Object.entries(next.images ?? {})) {
      if (!map.hasImage(id)) map.addImage(id, { width: img.width, height: img.height, data: img.data }, { pixelRatio: img.pixelRatio })
    }
    for (const [id, spec] of Object.entries(next.sources)) {
      const existing = map.getSource(id) as { type?: string; setData?: (d: unknown) => void } | undefined
      const prevSpec = prev?.sources[id]
      if (existing && spec.type === 'geojson' && existing.type === 'geojson' && existing.setData) {
        if (!prevSpec || prevSpec !== spec) existing.setData((spec as { data: unknown }).data)
        continue
      }
      if (existing && prevSpec && sameSource(prevSpec, spec)) continue
      if (existing) {
        for (const l of next.layers) if ((l.spec as { source?: string }).source === id && map.getLayer(l.spec.id)) map.removeLayer(l.spec.id)
        map.removeSource(id)
      }
      map.addSource(id, spec)
    }
    const before = this.resolveBefore()
    const top = resolveBeforeId(map, this.topBeforeId)
    for (const l of next.layers) {
      const target = l.placement === 'below-labels' ? before : top
      if (map.getLayer(l.spec.id)) {
        map.setLayoutProperty(l.spec.id, 'visibility', this.visible ? 'visible' : 'none')
        // After a style (re)load, restore the stacking: MapLibre fires 'styledata' (when this group re-adds itself, before
        // map-core's fire layers exist, so it falls back below the labels) before 'style.load' (when map-core re-adds its
        // fire layers below ours). Without the move, evacuation zones and NWS outlines end up above the fire.
        if (force && target !== l.spec.id) map.moveLayer(l.spec.id, target)
        continue
      }
      const spec = { ...l.spec, layout: { ...(l.spec as { layout?: object }).layout, visibility: this.visible ? 'visible' : 'none' } } as LayerSpecification
      map.addLayer(spec, target)
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (this.removed || !this.current || !styleReady(this.map)) return
    for (const l of this.current.layers) if (this.map.getLayer(l.spec.id)) this.map.setLayoutProperty(l.spec.id, 'visibility', visible ? 'visible' : 'none')
  }

  get isVisible(): boolean {
    return this.visible
  }

  /** Ids of the layers currently on the map (for click handling or queryRenderedFeatures). */
  layerIds(): string[] {
    return this.current?.layers.map((l) => l.spec.id) ?? []
  }

  setBeforeId(id: BeforeId): void {
    this.beforeId = id
    if (this.current && styleReady(this.map)) {
      const before = this.resolveBefore()
      for (const l of this.current.layers) if (l.placement === 'below-labels' && this.map.getLayer(l.spec.id)) this.map.moveLayer(l.spec.id, before)
    }
  }

  remove(): void {
    if (this.removed) return
    this.removed = true
    this.map.off('style.load', this.onStyle)
    this.map.off('styledata', this.onStyleData)
    const map = this.map
    if (!this.current || !styleReady(map)) return
    for (const l of this.current.layers) if (map.getLayer(l.spec.id)) map.removeLayer(l.spec.id)
    for (const id of Object.keys(this.current.sources)) if (map.getSource(id)) map.removeSource(id)
    for (const id of Object.keys(this.current.images ?? {})) if (map.hasImage(id)) map.removeImage(id)
    this.current = null
  }

  private resolveBefore(): string | undefined {
    return resolveBeforeId(this.map, this.beforeId) ?? firstSymbolLayerId(this.map)
  }
}

function styleReady(map: MapLibreMap): boolean {
  try {
    return !!map.getStyle()
  } catch {
    return false
  }
}

function sameSource(a: SourceSpecification, b: SourceSpecification): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
