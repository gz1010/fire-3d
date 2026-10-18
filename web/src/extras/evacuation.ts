// Official evacuation zones (owner: optional-sources; BRIEF §11, CONTRACT "Optional sources"). Pure helpers for the
// map layers, legend, panel, feed and location checks, plus a MapLibre layer handle. Rules:
// - current status only: past timeline positions get "not available for past dates" from the backend; nothing here
//   ever turns current status into a historical statement;
// - the official status wording is shown verbatim; the styling class only picks colour, hatch density and outline;
// - every zone names its issuing jurisdiction and the time the issuer last updated it (or says it was not given);
// - "no zones listed" is never presented as an all-clear.
import type { Feature, FeatureCollection, Geometry } from 'geojson'
import type { DataDrivenPropertyValueSpecification, LayerSpecification, Map as MapLibreMap } from 'maplibre-gl'
import type { IncidentManifest } from '../api/types'
import { lonLatToLocal } from '../lib/reproject'
import type { FeedItem } from '../ui/feed/types'
import { fmtWhen } from './format'
import type { ExtrasLegendEntry } from './legend'
import { LayerGroupHandle, type BeforeId, type LayerGroup, type LayerHandleOptions } from './mapLayers'
import {
  crossHatchImage,
  EVAC_GROUP_COLOR,
  EVAC_GROUP_HATCH,
  EVAC_GROUP_LINE,
  EVAC_STATUS_ORDER,
  evacStyleGroup,
  EXTRAS_COLORS,
  type EvacStyleGroup,
} from './style'
import type { EvacStatusKey, EvacuationsResponse, EvacZoneFeature, EvacZoneProps } from './types'

export const EVAC_SOURCE = 'fx-extras-evac'
export const EVAC_LAYERS = {
  tint: 'fx-extras-evac-tint',
  hatch: 'fx-extras-evac-hatch',
  lineOrder: 'fx-extras-evac-line-order',
  lineWarning: 'fx-extras-evac-line-warning',
  lineOther: 'fx-extras-evac-line-other',
  label: 'fx-extras-evac-label',
} as const
export const EVAC_PATTERN_IDS: Record<Exclude<EvacStyleGroup, 'hidden'>, string> = {
  order: 'fx-extras-evac-hatch-order',
  warning: 'fx-extras-evac-hatch-warning',
  other: 'fx-extras-evac-hatch-other',
}
const FONT = ['Noto Sans Regular']
const PIXEL_RATIO = 2

/** Official wording, or an explicit placeholder when the source gives none (never invented). */
export function statusText(p: Pick<EvacZoneProps, 'status'>): string {
  return p.status?.trim() || 'Status not stated by the source'
}

export interface EvacStatusCount {
  status: string
  key: EvacStatusKey
  group: EvacStyleGroup
  count: number
}

/** Zones per official status wording, most urgent first (hidden statuses last). */
export function evacStatusCounts(data: EvacuationsResponse | null): EvacStatusCount[] {
  if (!data || data.status !== 'available') return []
  const m = new Map<string, EvacStatusCount>()
  for (const f of data.zones.features) {
    const status = statusText(f.properties)
    const c = m.get(status) ?? { status, key: f.properties.status_key, group: evacStyleGroup(f.properties.status_key), count: 0 }
    c.count++
    m.set(status, c)
  }
  return [...m.values()].sort((a, b) => EVAC_STATUS_ORDER.indexOf(a.key) - EVAC_STATUS_ORDER.indexOf(b.key) || a.status.localeCompare(b.status))
}

/** GeoJSON drawn on the map: shown zones only, with style group, verbatim label and a short sub-label. */
export function evacDisplayData(data: EvacuationsResponse | null): FeatureCollection {
  const features: Feature[] = []
  if (data?.status === 'available') {
    for (const f of data.zones.features) {
      const group = evacStyleGroup(f.properties.status_key)
      if (group === 'hidden') continue
      features.push({
        type: 'Feature',
        id: f.id,
        geometry: f.geometry as Geometry,
        properties: {
          id: f.id,
          group,
          label: statusText(f.properties),
          sublabel: f.properties.zone_name || f.properties.zone_id,
        },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

function groupMatch<T>(values: Record<Exclude<EvacStyleGroup, 'hidden'>, T>, fallback: T): DataDrivenPropertyValueSpecification<T> {
  return ['match', ['get', 'group'], 'order', values.order, 'warning', values.warning, values.other ?? fallback] as unknown as DataDrivenPropertyValueSpecification<T>
}

/** Sources, images and layers for the current response (null = nothing to draw). */
export function evacuationLayerGroup(data: EvacuationsResponse | null): LayerGroup | null {
  const fc = evacDisplayData(data)
  if (fc.features.length === 0) return null
  const images: LayerGroup['images'] = {}
  for (const g of ['order', 'warning', 'other'] as const) {
    const h = EVAC_GROUP_HATCH[g]
    images[EVAC_PATTERN_IDS[g]] = { ...crossHatchImage(EVAC_GROUP_COLOR[g], h.spacing, h.width, h.alpha, PIXEL_RATIO), pixelRatio: PIXEL_RATIO }
  }
  const line = (id: string, g: Exclude<EvacStyleGroup, 'hidden'>) => ({
    placement: 'below-labels' as const,
    spec: {
      id,
      type: 'line',
      source: EVAC_SOURCE,
      filter: ['==', ['get', 'group'], g],
      layout: { 'line-join': 'round', 'line-cap': EVAC_GROUP_LINE[g].style === 'dotted' ? 'round' : 'butt' },
      paint: {
        'line-color': EVAC_GROUP_COLOR[g],
        'line-width': EVAC_GROUP_LINE[g].width,
        ...(EVAC_GROUP_LINE[g].dash ? { 'line-dasharray': EVAC_GROUP_LINE[g].dash as number[] } : {}),
      },
    } as LayerSpecification,
  })
  return {
    sources: { [EVAC_SOURCE]: { type: 'geojson', data: fc } },
    images,
    layers: [
      {
        placement: 'below-labels',
        spec: { id: EVAC_LAYERS.tint, type: 'fill', source: EVAC_SOURCE, paint: { 'fill-color': groupMatch(EVAC_GROUP_COLOR, EXTRAS_COLORS.evacOther), 'fill-opacity': 0.12 } },
      },
      {
        placement: 'below-labels',
        spec: {
          id: EVAC_LAYERS.hatch,
          type: 'fill',
          source: EVAC_SOURCE,
          paint: { 'fill-pattern': groupMatch(EVAC_PATTERN_IDS, EVAC_PATTERN_IDS.other) as never, 'fill-opacity': 0.9 },
        },
      },
      line(EVAC_LAYERS.lineOther, 'other'),
      line(EVAC_LAYERS.lineWarning, 'warning'),
      line(EVAC_LAYERS.lineOrder, 'order'),
      {
        placement: 'top',
        spec: {
          id: EVAC_LAYERS.label,
          type: 'symbol',
          source: EVAC_SOURCE,
          minzoom: 9,
          layout: {
            'text-field': ['step', ['zoom'], ['get', 'label'], 12.5, ['format', ['get', 'label'], {}, '\n', {}, ['get', 'sublabel'], { 'font-scale': 0.82 }]] as never,
            'text-font': FONT,
            'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10.5, 14, 13] as never,
            'text-max-width': 9,
            'text-padding': 6,
            'symbol-placement': 'point',
          },
          paint: {
            'text-color': ['match', ['get', 'group'], 'order', '#ff9ccd', 'warning', '#d6c8ff', '#c4d6ff'] as never,
            'text-halo-color': EXTRAS_COLORS.halo,
            'text-halo-width': 1.6,
          },
        },
      },
    ],
  }
}

export interface EvacuationLayerHandle {
  setData(data: EvacuationsResponse | null): void
  setVisible(visible: boolean): void
  setBeforeId(id: BeforeId): void
  layerIds(): string[]
  remove(): void
}

/** Mount the evacuation layers on a map (wire `setVisible` to the `evacuation` MapLayerKey). */
export function mountEvacuationLayer(map: MapLibreMap, opts: LayerHandleOptions = {}): EvacuationLayerHandle {
  let data: EvacuationsResponse | null = null
  const h = new LayerGroupHandle(map, () => evacuationLayerGroup(data), opts)
  return {
    setData(d) {
      data = d
      h.sync()
    },
    setVisible: (v) => h.setVisible(v),
    setBeforeId: (id) => h.setBeforeId(id),
    layerIds: () => h.layerIds(),
    remove: () => h.remove(),
  }
}

/** Legend entries for the statuses present (official wording) + an explanation when none can be shown. */
export function evacuationLegend(data: EvacuationsResponse | null): ExtrasLegendEntry[] {
  return evacStatusCounts(data)
    .filter((c) => c.group !== 'hidden')
    .map((c) => {
      const g = c.group as Exclude<EvacStyleGroup, 'hidden'>
      return {
        id: `evac-${c.key}-${c.status}`,
        layer: 'evacuation' as const,
        label: c.status,
        detail: `official · ${c.count} zone${c.count === 1 ? '' : 's'} · current status`,
        swatch: { kind: 'hatch' as const, color: EVAC_GROUP_COLOR[g], spacing: EVAC_GROUP_HATCH[g].spacing, line: EVAC_GROUP_LINE[g].style },
      }
    })
}

// ---- geometry --------------------------------------------------------------------------------------------------

function ringContains(ring: number[][], lon: number, lat: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function polygonContains(rings: number[][][], lon: number, lat: number): boolean {
  if (!rings.length || !ringContains(rings[0], lon, lat)) return false
  for (let k = 1; k < rings.length; k++) if (ringContains(rings[k], lon, lat)) return false
  return true
}

/** Official zones (any status) containing a point: for location checks ("inside an Evacuation Warning zone"). */
export function zonesAtPoint(data: EvacuationsResponse | null, lon: number, lat: number): EvacZoneFeature[] {
  if (!data || data.status !== 'available') return []
  return data.zones.features
    .filter((f) => {
      const g = f.geometry
      return g.type === 'Polygon' ? polygonContains(g.coordinates, lon, lat) : g.coordinates.some((p) => polygonContains(p, lon, lat))
    })
    .sort((a, b) => EVAC_STATUS_ORDER.indexOf(a.properties.status_key) - EVAC_STATUS_ORDER.indexOf(b.properties.status_key))
}

/** [w, s, e, n] around a set of zones (outer rings), for "Show on map" (fitBounds); null when empty. */
export function zonesBounds(features: EvacZoneFeature[]): [number, number, number, number] | null {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const f of features) {
    const rings = f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map((p) => p[0])
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
        w = Math.min(w, lon)
        e = Math.max(e, lon)
        s = Math.min(s, lat)
        n = Math.max(n, lat)
      }
    }
  }
  return Number.isFinite(w) ? [w, s, e, n] : null
}

/** Approximate centre (mean of outer-ring vertices, lon/lat) of a set of zones. */
export function zonesCentre(features: EvacZoneFeature[]): [number, number] | null {
  let sx = 0
  let sy = 0
  let n = 0
  for (const f of features) {
    const rings = f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map((p) => p[0])
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        sx += ring[i][0]
        sy += ring[i][1]
        n++
      }
    }
  }
  return n ? [sx / n, sy / n] : null
}

// ---- panel and feed --------------------------------------------------------------------------------------------

export interface ZoneDetail {
  id: string
  status: string
  group: EvacStyleGroup
  title: string
  jurisdiction: string
  updatedText: string
  message: string | null
  extra: string[]
}

/** Text for one zone in the panel (official wording verbatim; times labelled by who set them). */
export function zoneDetail(f: EvacZoneFeature, nowMs: number): ZoneDetail {
  const p = f.properties
  const extra: string[] = []
  if (p.critical_info) extra.push(p.critical_info)
  if (p.public_info) extra.push(p.public_info)
  if (p.event_type) extra.push(`Event type: ${p.event_type}`)
  return {
    id: f.id,
    status: statusText(p),
    group: evacStyleGroup(p.status_key),
    title: p.zone_name ? `${p.zone_name} (${p.zone_id})` : p.zone_id,
    jurisdiction: p.jurisdiction ?? 'Jurisdiction not stated',
    updatedText: p.status_updated_ms ? `Updated by the issuer ${fmtWhen(p.status_updated_ms, nowMs)}` : 'Update time not given by the issuer',
    message: p.notes,
    extra,
  }
}

/**
 * Feed items: one per (official status, jurisdiction), at the issuer's latest update time, kind 'official', not
 * seekable (current status, never a point on the replay timeline). Located at the approximate centre of the zones.
 */
export function evacuationFeedItems(data: EvacuationsResponse | null, manifest: Pick<IncidentManifest, 'grid'> | null): FeedItem[] {
  if (!data || data.status !== 'available') return []
  const groups = new Map<string, EvacZoneFeature[]>()
  for (const f of data.zones.features) {
    if (evacStyleGroup(f.properties.status_key) === 'hidden') continue
    const k = `${statusText(f.properties)}|${f.properties.jurisdiction ?? ''}`
    groups.set(k, [...(groups.get(k) ?? []), f])
  }
  const asOf = data.retrieved_ms ?? data.now_ms
  const items: FeedItem[] = []
  for (const [k, zones] of groups) {
    const [status, jurisdiction] = k.split('|')
    const times = zones.map((z) => z.properties.status_updated_ms).filter((t): t is number => t != null)
    const centre = zonesCentre(zones)
    let location: FeedItem['location'] = null
    if (centre && manifest?.grid) {
      const [x, z] = lonLatToLocal(centre[0], centre[1], manifest.grid)
      location = { lon: centre[0], lat: centre[1], x, z }
    }
    const key = zones[0].properties.status_key
    items.push({
      id: `evacuation:${key}:${jurisdiction || 'unknown'}:${status}`,
      topic: 'evacuation',
      kind: 'official',
      tMs: times.length ? Math.max(...times) : asOf,
      title: `${status}: ${zones.length} zone${zones.length === 1 ? '' : 's'}${jurisdiction ? ` (${jurisdiction})` : ''}`,
      detail: `Current official status as of ${fmtWhen(asOf)}. Issued by local officials${jurisdiction ? ` in ${jurisdiction}` : ''}; listed by Cal OES. Fire-3d's modeled spread is not an evacuation instruction.`,
      source: `${jurisdiction || 'Local officials'} via Cal OES`,
      automated: false,
      key: key === 'order' || key === 'shelter',
      confidence: null,
      location,
      seekable: false,
      eventId: null,
      approximate: location != null,
      locationLabel: location ? 'Centre of the zones (approximate)' : null,
      facts: [
        { label: 'Official wording', text: status, scientific: null },
        { label: 'Zones', text: zones.map((z) => z.properties.zone_name || z.properties.zone_id).join(', '), scientific: null },
      ],
    })
  }
  return items.sort((a, b) => a.tMs - b.tMs || a.id.localeCompare(b.id))
}
