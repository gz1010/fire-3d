// Official map layers (owner: official-web; CONTRACT §13 I6; mounted by map in mapController next to the extras
// layers): NWS fire weather zone outlines (Red Flag Warnings and Fire Weather Watches in effect at the reference time,
// outline only, with the NWS wording as a label; the open fire's alerts, or California's on the overview) and the
// highlight of a selected official item (its Cal OES zones or its NWS zones). Data comes from the stores (useOfficialRuntime, useExtrasRuntime, useStore): the module subscribes
// itself, re-adds its layers after basemap swaps (LayerGroupHandle) and never handles clicks.
// Stacking: NWS outlines, their labels and a selected NWS alert's outline below map-core's draped fire layers
// (`beforeId`); a selected evacuation zone's outline above the basemap labels but below map-core's top layers
// (`topBeforeId`).
import type { Feature, FeatureCollection, Geometry } from 'geojson'
import type { LayerSpecification, Map as MapLibreMap } from 'maplibre-gl'
import { EXTRAS_COLORS } from '../extras/style'
import { LayerGroupHandle, type BeforeId, type LayerGroup } from '../extras/mapLayers'
import { useExtrasRuntime } from '../extras/runtime'
import type { EvacuationsResponse } from '../extras/types'
import { isPastForCurrentSources } from '../extras/client'
import { nowMarkerMs, useStore } from '../state/store'
import { fireWeatherDisplayData } from './fireWeather'
import { forIncident } from './guard'
import { FW_LINE, FW_OPACITY, OFFICIAL_COLORS } from './style'
import { fireWeatherDataNow, useOfficialRuntime } from './runtime'
import type { FireWeatherResponse, OfficialHighlight } from './types'

export const OFFICIAL_SOURCES = { fireWeather: 'fx-official-fw', highlight: 'fx-official-hl' } as const
export const OFFICIAL_LAYERS = {
  fwCasing: 'fx-official-fw-casing',
  fwWarning: 'fx-official-fw-line-warning',
  fwWatch: 'fx-official-fw-line-watch',
  fwLabel: 'fx-official-fw-label',
  hlFill: 'fx-official-hl-fill',
  /** A selected NWS alert's zones: below the fire layers, like the outlines. */
  hlFwCasing: 'fx-official-hl-fw-casing',
  hlFwLine: 'fx-official-hl-fw-line',
  /** A selected evacuation zone: on top. */
  hlCasing: 'fx-official-hl-casing',
  hlLine: 'fx-official-hl-line',
} as const

const FONT = ['Noto Sans Regular']

/** The highlighted official area: Cal OES zones (by id) or NWS zones (by UGC / alert id). `kind` says how it is drawn:
 *  'evacuation' (white outline), 'warning' / 'watch' (an NWS alert: its own colour and a faint fill). */
export function highlightDisplayData(h: OfficialHighlight | null, evac: EvacuationsResponse | null, fw: FireWeatherResponse | null): FeatureCollection {
  const features: Feature[] = []
  if (h?.kind === 'evacuation' && evac?.status === 'available') {
    const ids = new Set(h.zoneIds)
    for (const z of evac.zones.features) if (ids.has(z.id)) features.push({ type: 'Feature', id: z.id, geometry: z.geometry as Geometry, properties: { id: z.id, kind: 'evacuation' } })
  } else if (h?.kind === 'fire-weather' && fw?.status === 'available') {
    const ugcs = new Set(h.ugcs)
    const alerts = new Set(h.alertIds)
    const picked = (fw.alerts ?? []).filter((a) => alerts.has(a.id))
    const kind = !picked.length || picked.some((a) => a.vtec?.significance === 'W' || /warning/i.test(a.event)) ? 'warning' : 'watch'
    for (const f of fw.zones?.features ?? []) {
      if (!f.geometry) continue
      if (ugcs.has(f.properties?.ugc) || (f.properties?.alert_ids ?? []).some((id) => alerts.has(id)))
        features.push({ type: 'Feature', id: f.properties.ugc, geometry: f.geometry as Geometry, properties: { id: f.properties.ugc, kind } })
    }
  }
  return { type: 'FeatureCollection', features }
}

/** Sources and layers for the current data (null = nothing to draw). */
export function officialLayerGroup(fw: FeatureCollection, hl: FeatureCollection): LayerGroup | null {
  if (!fw.features.length && !hl.features.length) return null
  const src = OFFICIAL_SOURCES
  const fwLine = (id: string, kind: 'warning' | 'watch'): LayerGroup['layers'][number] => ({
    placement: 'below-labels',
    spec: {
      id,
      type: 'line',
      source: src.fireWeather,
      filter: ['==', ['get', 'kind'], kind],
      layout: { 'line-join': 'round', 'line-cap': 'butt' },
      paint: {
        'line-color': kind === 'warning' ? OFFICIAL_COLORS.redFlag : OFFICIAL_COLORS.fireWeatherWatch,
        'line-width': FW_LINE[kind].width,
        'line-dasharray': FW_LINE[kind].dash,
        'line-opacity': FW_OPACITY as never,
      },
    } as LayerSpecification,
  })
  const hlKind = (evacuation: unknown, warning: unknown, watch: unknown) => ['match', ['get', 'kind'], 'warning', warning, 'watch', watch, evacuation] as never
  return {
    sources: { [src.fireWeather]: { type: 'geojson', data: fw }, [src.highlight]: { type: 'geojson', data: hl } },
    layers: [
      {
        placement: 'below-labels',
        spec: {
          id: OFFICIAL_LAYERS.hlFill,
          type: 'fill',
          source: src.highlight,
          paint: { 'fill-color': hlKind(OFFICIAL_COLORS.highlightFill, OFFICIAL_COLORS.fwHighlightFill, OFFICIAL_COLORS.fwWatchHighlightFill) },
        } as LayerSpecification,
      },
      {
        placement: 'below-labels',
        spec: {
          id: OFFICIAL_LAYERS.fwCasing,
          type: 'line',
          source: src.fireWeather,
          layout: { 'line-join': 'round' },
          paint: { 'line-color': OFFICIAL_COLORS.fwCasing, 'line-width': 3, 'line-opacity': FW_OPACITY as never },
        } as LayerSpecification,
      },
      fwLine(OFFICIAL_LAYERS.fwWatch, 'watch'),
      fwLine(OFFICIAL_LAYERS.fwWarning, 'warning'),
      // a selected NWS alert: its zones in the alert's own colour, solid, a little stronger than the quiet dashed
      // outlines, still below the fire layers (the fire stays the most prominent element)
      {
        placement: 'below-labels',
        spec: {
          id: OFFICIAL_LAYERS.hlFwCasing,
          type: 'line',
          source: src.highlight,
          filter: ['!=', ['get', 'kind'], 'evacuation'],
          layout: { 'line-join': 'round' },
          paint: { 'line-color': OFFICIAL_COLORS.casing, 'line-width': 3.6, 'line-opacity': 0.6 },
        } as LayerSpecification,
      },
      {
        placement: 'below-labels',
        spec: {
          id: OFFICIAL_LAYERS.hlFwLine,
          type: 'line',
          source: src.highlight,
          filter: ['!=', ['get', 'kind'], 'evacuation'],
          layout: { 'line-join': 'round' },
          paint: { 'line-color': ['match', ['get', 'kind'], 'watch', OFFICIAL_COLORS.fireWeatherWatch, OFFICIAL_COLORS.redFlag] as never, 'line-width': 1.8 },
        } as LayerSpecification,
      },
      // their labels sit below the fire layers too: where an outline crosses the fire, the fire covers its label
      {
        placement: 'below-labels',
        spec: {
          id: OFFICIAL_LAYERS.fwLabel,
          type: 'symbol',
          source: src.fireWeather,
          minzoom: 7,
          layout: {
            'symbol-placement': 'line',
            // sparse: about two labels per view along the large zones' outlines (zoomed out, the jagged simplified
            // outlines rarely fit one; the legend entry names them there)
            'symbol-spacing': 600,
            'text-field': ['get', 'label'] as never,
            'text-font': FONT,
            'text-size': ['interpolate', ['linear'], ['zoom'], 7, 10.5, 12, 12] as never,
            'text-max-angle': 45,
            'text-padding': 4,
          },
          paint: {
            'text-color': ['match', ['get', 'kind'], 'warning', '#ffc2e1', '#ffe9cc'] as never,
            'text-halo-color': EXTRAS_COLORS.halo,
            'text-halo-width': 1.6,
            'text-opacity': 0.9,
          },
        } as LayerSpecification,
      },
      // a selected evacuation zone (small): a white outline on top
      {
        placement: 'top',
        spec: {
          id: OFFICIAL_LAYERS.hlCasing,
          type: 'line',
          source: src.highlight,
          filter: ['==', ['get', 'kind'], 'evacuation'],
          layout: { 'line-join': 'round' },
          paint: { 'line-color': OFFICIAL_COLORS.casing, 'line-width': 6 },
        } as LayerSpecification,
      },
      {
        placement: 'top',
        spec: {
          id: OFFICIAL_LAYERS.hlLine,
          type: 'line',
          source: src.highlight,
          filter: ['==', ['get', 'kind'], 'evacuation'],
          layout: { 'line-join': 'round' },
          paint: { 'line-color': OFFICIAL_COLORS.highlight, 'line-width': 2.6 },
        } as LayerSpecification,
      },
    ],
  }
}

export interface OfficialLayerOptions {
  /** Below-labels layers go below this layer (map-core's lowest draped fire layer; candidates bottom-first). */
  beforeId?: BeforeId
  /** Labels and the highlight outline go below this layer (map-core's top layers). */
  topBeforeId?: BeforeId
}

export interface OfficialLayersHandle {
  /** Optional: the module follows its stores itself. `update()` re-syncs; `update({ visible: false })` hides every
   *  official layer (true shows them again); other values are ignored. */
  update(state?: unknown): void
  remove(): void
  /** Ids of the layers on the map (tests, queryRenderedFeatures). */
  layerIds(): string[]
}

/** The reference time of the outlines: now while the timeline stands for the present, else the timeline time. */
function referenceMs(): number {
  const s = useStore.getState()
  if (s.incidentId == null) return Date.now() // the overview: California's current alerts
  const m = s.manifest?.status === 'ready' ? s.manifest : null
  const mode = m?.mode ?? s.summary?.mode ?? s.mode
  const now = Date.now()
  return isPastForCurrentSources(mode, s.timeMs, now, nowMarkerMs(m, s.forecast)) ? s.timeMs : now
}

export function mountOfficialLayers(map: MapLibreMap, opts: OfficialLayerOptions = {}): OfficialLayersHandle {
  let fwFc: FeatureCollection = { type: 'FeatureCollection', features: [] }
  let hlFc: FeatureCollection = { type: 'FeatureCollection', features: [] }
  let group: LayerGroup | null = null
  let fwKey = ''
  let hlKey = ''
  const handle = new LayerGroupHandle(map, () => group, { beforeId: opts.beforeId ?? null, topBeforeId: opts.topBeforeId ?? null, visible: true })

  /** Rebuild only what changed (GeoJSON sources are updated in place by the handle). */
  const sync = (force = false) => {
    const fw = fireWeatherDataNow()
    const rt = useOfficialRuntime.getState()
    const evac = forIncident(useExtrasRuntime.getState().evac.data, useStore.getState().incidentId)
    const ref = referenceMs()
    const nextFw = fireWeatherDisplayData(fw, ref)
    const nextHl = highlightDisplayData(rt.highlight, evac, fw)
    const k1 = nextFw.features.map((f) => `${f.id}:${(f.properties as { label: string }).label}`).join('|') + `#${fw?.retrieved_ms ?? ''}`
    const k2 = `${rt.highlight?.id ?? ''}#${nextHl.features.length}#${evac?.retrieved_ms ?? ''}`
    if (!force && k1 === fwKey && k2 === hlKey) return
    if (k1 !== fwKey) fwFc = nextFw
    if (k2 !== hlKey) hlFc = nextHl
    fwKey = k1
    hlKey = k2
    group = officialLayerGroup(fwFc, hlFc)
    handle.sync()
  }
  sync(true)
  const unsubs = [
    useOfficialRuntime.subscribe((s, p) => {
      if (s.fireWeather.data !== p.fireWeather.data || s.statewide.data !== p.statewide.data || s.seen !== p.seen || s.highlight !== p.highlight) sync()
    }),
    useExtrasRuntime.subscribe((s, p) => {
      if (s.evac.data !== p.evac.data) sync()
    }),
    useStore.subscribe((s, p) => {
      // the replay time moves which alerts are in effect: re-check when the hour changes or the incident switches
      if (s.incidentId !== p.incidentId || Math.floor(s.timeMs / 3_600_000) !== Math.floor(p.timeMs / 3_600_000)) sync()
    }),
  ]
  // live alerts expire as the clock moves on
  const timer = typeof window !== 'undefined' ? window.setInterval(() => sync(), 60_000) : null
  let removed = false
  return {
    update(state?: unknown) {
      if (removed) return
      const v = (state as { visible?: unknown } | null | undefined)?.visible
      if (typeof v === 'boolean') handle.setVisible(v)
      sync(true)
    },
    remove() {
      if (removed) return
      removed = true
      for (const u of unsubs) u()
      if (timer != null) window.clearInterval(timer)
      handle.remove()
    },
    layerIds: () => handle.layerIds(),
  }
}
