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
import { fmtDayDate, type TimeFmt } from '../lib/time'
import { stateName } from '../lib/usStates'
import { fireReferenceText, type FireReference } from '../official/fire'
import { bboxContains, distanceText, geometriesBounds, geometryContains, polygonFireDistanceKm, polygonOverlapsRing } from '../official/geo'
import type { GeoPolygon } from '../official/types'
import { httpsUrl } from '../official/url'
import { getTimeFormat } from '../state/timeZone'
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
import type { EvacStatusKey, EvacuationsResponse, EvacZoneFeature, EvacZoneProps, ExtrasSource } from './types'

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

/** Official wording, or an explicit placeholder when the source gives none (never invented). For Oregon this is
 *  Fire-3d's rendering of OEM's level number ("Level 3", `status_verbatim: false`). */
export function statusText(p: Pick<EvacZoneProps, 'status'>): string {
  return p.status?.trim() || 'Status not stated by the source'
}

// ---- sources (brief 3: Cal OES in California, Oregon OEM in Oregon; CONTRACT §14.8) ------------------------------
const AGGREGATOR_BY_ID: Readonly<Record<string, string>> = { caloes_evacuations: 'Cal OES', caloes_evacuation_inventory: 'Cal OES', or_oem_evacuations: 'Oregon OEM' }
const HOME_STATE_BY_ID: Readonly<Record<string, string>> = { caloes_evacuations: 'CA', caloes_evacuation_inventory: 'CA', or_oem_evacuations: 'OR' }
const ZONE_LAYERS = new Set(['caloes_evacuations', 'or_oem_evacuations'])

/** The source that listed a zone (brief-2 answers: Cal OES). */
export function zoneSourceId(p: Pick<EvacZoneProps, 'source_id'>): string {
  return p.source_id || 'caloes_evacuations'
}

/** Short name of a source in sentences ("Cal OES", "Oregon OEM"): the backend's `aggregator`, else a known id, else
 *  the publisher. */
export function aggregatorOf(data: Pick<EvacuationsResponse, 'sources'> | null, sourceId: string): string {
  const s = data?.sources.find((x) => x.id === sourceId)
  return s?.aggregator || AGGREGATOR_BY_ID[sourceId] || s?.publisher || 'the state source'
}

/** The source's home state (USPS code). */
export function sourceHomeState(data: Pick<EvacuationsResponse, 'sources'> | null, sourceId: string): string | null {
  return data?.sources.find((x) => x.id === sourceId)?.home_state || HOME_STATE_BY_ID[sourceId] || null
}

/** The zone layers that answered for this area (the inventory is not a zone layer). An older backend without
 *  per-source status: every listed zone layer of an available answer. */
export function answeredSources(data: Pick<EvacuationsResponse, 'sources' | 'status'> | null): ExtrasSource[] {
  if (!data) return []
  return data.sources.filter((s) => ZONE_LAYERS.has(s.id) && (s.status ?? (data.status === 'available' ? 'available' : 'unavailable')) === 'available')
}

/** "Cal OES" / "Oregon OEM" / "Cal OES and Oregon OEM": the sources that answered. */
export function answeredNames(data: Pick<EvacuationsResponse, 'sources' | 'status'> | null): string | null {
  const names = [...new Set(answeredSources(data).map((s) => aggregatorOf(data as EvacuationsResponse, s.id)))]
  return names.length ? names.join(' and ') : null
}

/** "<aggregator> does not say which fire this is for." (zones are listed by place, not by fire). */
export function notFireSpecific(aggregator: string): string {
  return `${aggregator} does not say which fire this is for.`
}

/** Fire-3d's wording of a level that is not the source's own text (Oregon), with the source's definition, else null. */
export function statusLabel(p: Pick<EvacZoneProps, 'status_verbatim' | 'status_label'>): string | null {
  return p.status_verbatim === false && p.status_label ? p.status_label : null
}

/** "Level 3 is Oregon OEM's level number; the words are OEM's definition of that level." for non-verbatim levels. */
export function statusLevelNote(p: Pick<EvacZoneProps, 'status_verbatim' | 'status_label' | 'source_id' | 'status'>): string | null {
  if (p.status_verbatim !== false) return null
  const agg = AGGREGATOR_BY_ID[zoneSourceId(p)] ?? 'the source'
  return `"${statusText(p)}" is Fire-3d's wording of ${agg}'s level number${p.status_label ? `; ${agg} defines it as "${p.status_label}"` : ''}.`
}

/** "Evacuation for: Other, as recorded by Oregon OEM" for a hazard that is not a fire, else null. */
export function hazardNote(p: Pick<EvacZoneProps, 'hazard_type' | 'source_id'>): string | null {
  const h = p.hazard_type?.trim()
  if (!h || /fire/i.test(h)) return null
  return `Evacuation for: ${h}, as recorded by ${AGGREGATOR_BY_ID[zoneSourceId(p)] ?? 'the source'}`
}

/** "Fire name as recorded by Oregon OEM: Fielders Mountain; a name match is not proof it is this fire", else null. */
export function incidentNameNote(p: Pick<EvacZoneProps, 'incident_name' | 'source_id'>): string | null {
  const n = p.incident_name?.trim()
  if (!n) return null
  return `Fire name as recorded by ${AGGREGATOR_BY_ID[zoneSourceId(p)] ?? 'the source'}: ${n}; a name match is not proof it is this fire`
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

/**
 * Whether the response checked this point, and the official zones (any status) containing it. Cal OES is queried only
 * for the response's `bbox` (the fire's area plus a margin): outside it nothing was checked, so the answer is "not
 * checked here", never "none listed" (also when the status is not `available`).
 */
export function evacuationAtPoint(data: EvacuationsResponse | null, lon: number, lat: number): { checked: boolean; zones: EvacZoneFeature[] } {
  if (!data || data.status !== 'available' || !Number.isFinite(lon) || !Number.isFinite(lat) || !bboxContains(data.bbox, lon, lat)) return { checked: false, zones: [] }
  const zones = data.zones.features
    .filter((f) => geometryContains(f.geometry, lon, lat))
    .sort((a, b) => EVAC_STATUS_ORDER.indexOf(a.properties.status_key) - EVAC_STATUS_ORDER.indexOf(b.properties.status_key))
  return { checked: true, zones }
}

/** Official zones (any status) containing a point: for location checks ("inside an Evacuation Warning zone"). Empty
 *  outside the checked `bbox`: use `evacuationAtPoint` to tell "none listed" from "not checked". */
export function zonesAtPoint(data: EvacuationsResponse | null, lon: number, lat: number): EvacZoneFeature[] {
  return evacuationAtPoint(data, lon, lat).zones
}

export type ZoneTimeBasis = NonNullable<EvacZoneProps['time_basis']>

/** The issuer's last edit of a zone and when the state layer listed it (Cal OES's copy time; when the zone was added to
 *  the Oregon state layer). Fire-3d's fetch time is never a zone's time. */
export function zoneTimes(p: Pick<EvacZoneProps, 'status_updated_ms' | 'aggregated_ms'> & Partial<Pick<EvacZoneProps, 'listed_ms' | 'time_basis'>>): {
  issuerMs: number | null
  aggregatedMs: number | null
  /** When the state layer listed it (`listed_ms`, else Cal OES's `aggregated_ms`). */
  listedMs: number | null
  basis: ZoneTimeBasis
} {
  const ok = (v: number | null | undefined) => (v != null && Number.isFinite(v) && v > 0 ? v : null)
  const issuerMs = ok(p.status_updated_ms)
  const listedMs = ok(p.listed_ms) ?? ok(p.aggregated_ms)
  const basis: ZoneTimeBasis = p.time_basis ?? (issuerMs != null ? 'issuer' : listedMs != null ? 'state_layer_edit' : 'none')
  return { issuerMs, aggregatedMs: ok(p.aggregated_ms), listedMs, basis }
}

/** What the state layer's time of a zone means: "listed by Cal OES", "added to the Oregon state layer", "added". */
export function zoneListedPhrase(p: Pick<EvacZoneProps, 'source_id'> & Partial<Pick<EvacZoneProps, 'time_basis' | 'state'>>): string {
  const id = zoneSourceId(p)
  if (p.time_basis === 'state_layer_added') return `added to the ${stateName(HOME_STATE_BY_ID[id] ?? p.state ?? null) ?? 'state'} state layer`
  if (p.time_basis === 'date_only') return 'added'
  return `listed by ${AGGREGATOR_BY_ID[id] ?? 'the state layer'}`
}

/** How a shown zone relates to the fire. */
export interface ZoneNearFire {
  zone: EvacZoneFeature
  /** Distance from the zone to the fire (km, 0 = touching); null when the fire's position is not known. */
  distanceKm: number | null
  /** The zone does not touch the fire's analysis area: Cal OES lists zones by place, not by fire. */
  outsideAnalysisArea: boolean
}

/** Shown zones (orders, warnings and other statuses; not Normal / Training) with their distance to the fire. */
export function zonesNearFire(data: EvacuationsResponse | null, fire: FireReference | null): ZoneNearFire[] {
  if (!data || data.status !== 'available') return []
  return data.zones.features
    .filter((f) => evacStyleGroup(f.properties.status_key) !== 'hidden')
    .map((zone) => zoneNearFire(zone, fire))
}

export function zoneNearFire(zone: EvacZoneFeature, fire: FireReference | null): ZoneNearFire {
  const g = zone.geometry as GeoPolygon
  const d = fire ? polygonFireDistanceKm(g, fire) : null
  const outside = fire?.aoi ? !polygonOverlapsRing(g, fire.aoi) : false
  return { zone, distanceKm: d, outsideAnalysisArea: outside }
}

/** "Cal OES does not say which fire this is for": shown for zones outside the fire's analysis area.
 *  @deprecated California-only wording: use `notFireSpecific(aggregatorOf(data, zoneSourceId(p)))`. */
export const NOT_FIRE_SPECIFIC = notFireSpecific('Cal OES')

/** [w, s, e, n] around a set of zones (outer rings), for "Show on map" (fitBounds); null when empty. */
export function zonesBounds(features: EvacZoneFeature[]): [number, number, number, number] | null {
  return geometriesBounds(features.map((f) => f.geometry as GeoPolygon))
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

/** "Updated by the issuer Oct 17, 18:01 PDT", else the state layer's time with "issuer time not given" ("listed by Cal
 *  OES …", "added to the Oregon state layer …"). */
export function zoneTimeText(p: Pick<EvacZoneProps, 'status_updated_ms' | 'aggregated_ms'> & Partial<Pick<EvacZoneProps, 'listed_ms' | 'time_basis' | 'source_id' | 'state'>>, nowMs: number, tf?: TimeFmt): string {
  const t = zoneTimes(p)
  if (t.issuerMs != null) return `Updated by the issuer ${fmtWhen(t.issuerMs, nowMs, tf)}`
  if (t.listedMs != null) return `Issuer time not given; ${zoneListedPhrase(p)} ${t.basis === 'date_only' ? fmtDayDate(t.listedMs, (tf ?? getTimeFormat()).tz) : fmtWhen(t.listedMs, nowMs, tf)}`
  return 'Update time not given by the issuer'
}

/** Text for one zone in the panel (official wording verbatim; times labelled by who set them). `tf` (CONTRACT
 *  §14.9.6): the zone and clock of the times, default `getTimeFormat()`. */
export function zoneDetail(f: EvacZoneFeature, nowMs: number, tf: TimeFmt = getTimeFormat()): ZoneDetail {
  const p = f.properties
  const extra: string[] = []
  if (p.critical_info) extra.push(p.critical_info)
  if (p.public_info) extra.push(p.public_info)
  if (p.event_type) extra.push(`Event type: ${p.event_type}`)
  for (const n of [statusLevelNote(p), hazardNote(p), incidentNameNote(p)]) if (n) extra.push(n)
  return {
    id: f.id,
    status: statusLabel(p) ?? statusText(p),
    group: evacStyleGroup(p.status_key),
    title: p.zone_name ? `${p.zone_name} (${p.zone_id})` : p.zone_id,
    jurisdiction: p.jurisdiction ?? 'Jurisdiction not stated',
    updatedText: zoneTimeText(p, nowMs, tf),
    message: p.notes,
    extra,
  }
}

/** The issuing jurisdiction as the source names it, else the county, else "Local officials". */
export function zoneIssuer(p: Pick<EvacZoneProps, 'jurisdiction' | 'county'>): string {
  const j = p.jurisdiction?.trim()
  if (j) return j
  const c = p.county?.trim()
  if (c) return /county$/i.test(c) ? c : `${c} County`
  return 'Local officials'
}

/** The county's own evacuation map for a zone (Cal OES coverage list), https only. */
function countyMapUrl(data: EvacuationsResponse, p: EvacZoneProps): string | null {
  const county = (p.county ?? '').replace(/\s+county$/i, '').trim().toLowerCase()
  if (!county) return null
  const c = data.coverage.find((x) => x.county.replace(/\s+county$/i, '').trim().toLowerCase() === county)
  return httpsUrl(c?.reference_url)
}

/** The data page of the evacuation layer (https): the first zone source that answered (Cal OES first in California),
 *  else the first one listed. */
export function evacuationSourceUrl(data: Pick<EvacuationsResponse, 'sources'> & Partial<Pick<EvacuationsResponse, 'status'>> | null): string | null {
  if (!data) return null
  const answered = answeredSources({ sources: data.sources, status: data.status ?? 'available' })
  return httpsUrl((answered[0] ?? data.sources.find((s) => ZONE_LAYERS.has(s.id)))?.url)
}

export interface EvacuationFeedOptions {
  /** Where the fire is (distances and "outside the analysis area"). */
  fire?: FireReference | null
  /** Distances in km (else miles). */
  metric?: boolean
  /** Zone and clock of the times (CONTRACT §14.9.5); default `getTimeFormat()`. */
  tf?: TimeFmt
}

/**
 * Feed items: one per (official status, issuer), kind 'official', not seekable (current status, never a point on the
 * replay timeline). The time is the issuer's latest edit, else Cal OES's copy time, else the layer's own update time;
 * never Fire-3d's fetch time (`timeNotGiven` when none exists). Each item names the issuer, its distance to the fire
 * and, for zones outside the fire's analysis area, that Cal OES does not say which fire it is for. Selecting it fits
 * the zones and highlights them (`bounds`, `highlight`). Key only for orders / shelter-in-place touching the area.
 */
export function evacuationFeedItems(data: EvacuationsResponse | null, manifest: Pick<IncidentManifest, 'grid'> | null, opts: EvacuationFeedOptions = {}): FeedItem[] {
  if (!data || data.status !== 'available') return []
  const fire = opts.fire ?? null
  const groups = new Map<string, ZoneNearFire[]>()
  for (const z of zonesNearFire(data, fire)) {
    const p = z.zone.properties
    const k = `${statusText(p)}|${zoneIssuer(p)}|${zoneSourceId(p)}`
    groups.set(k, [...(groups.get(k) ?? []), z])
  }
  const tf = opts.tf ?? getTimeFormat()
  const items: FeedItem[] = []
  for (const [k, near] of groups) {
    const [status, issuer, sourceId] = k.split('|')
    const aggregator = aggregatorOf(data, sourceId)
    const sourceUrl = httpsUrl(data.sources.find((s) => s.id === sourceId)?.url) ?? evacuationSourceUrl(data)
    const zones = near.map((n) => n.zone)
    const p0 = zones[0].properties
    const issuerTimes = zones.map((z) => zoneTimes(z.properties).issuerMs).filter((t): t is number => t != null)
    const aggTimes = zones.map((z) => zoneTimes(z.properties).listedMs).filter((t): t is number => t != null)
    const updatedMs = issuerTimes.length ? Math.max(...issuerTimes) : null
    const listedMs = aggTimes.length ? Math.max(...aggTimes) : null
    const ownMs = updatedMs ?? listedMs ?? data.source_updated_ms ?? null
    const centre = zonesCentre(zones)
    let location: FeedItem['location'] = null
    if (centre && manifest?.grid) {
      const [x, z] = lonLatToLocal(centre[0], centre[1], manifest.grid)
      location = { lon: centre[0], lat: centre[1], x, z }
    }
    const dists = near.map((n) => n.distanceKm).filter((d): d is number => d != null)
    const distanceKm = dists.length ? Math.min(...dists) : null
    const outside = near.every((n) => n.outsideAnalysisArea)
    const key = zones[0].properties.status_key
    const dist = distanceKm == null ? null : distanceKm === 0 ? 'touches the fire area' : `${distanceText(distanceKm, !!opts.metric)} from the fire`
    const notes: string[] = []
    const notFire = notFireSpecific(aggregator)
    if (outside) notes.push(notFire)
    if (updatedMs == null) notes.push(listedMs != null ? `The issuer gives no time; ${zoneListedPhrase(p0)} ${fmtWhen(listedMs, undefined, tf)}.` : 'The issuer gives no time for this status.')
    for (const n of [statusLevelNote(p0), hazardNote(p0)]) if (n) notes.push(n.endsWith('.') ? n : `${n}.`)
    if (fire && distanceKm != null) notes.push(fireReferenceText(fire))
    const links: { label: string; url: string }[] = []
    const county = countyMapUrl(data, zones[0].properties)
    if (county) links.push({ label: 'County evacuation map', url: county })
    const ids = zones.map((z) => z.id)
    const id = sourceId === 'caloes_evacuations' ? `evacuation:${key}:${issuer}:${status}` : `evacuation:${sourceId}:${key}:${issuer}:${status}`
    items.push({
      id,
      topic: 'evacuation',
      kind: 'official',
      tMs: ownMs ?? data.retrieved_ms ?? data.now_ms,
      title: `${status}: ${zones.length} zone${zones.length === 1 ? '' : 's'} (${issuer})`,
      detail: `${dist ? `${dist[0].toUpperCase()}${dist.slice(1)}. ` : ''}${outside ? `${notFire} ` : ''}Issued by local officials; listed by ${aggregator}. Fire-3d's modeled spread is not an evacuation instruction.`,
      source: `${issuer} via ${aggregator}`,
      automated: false,
      key: (key === 'order' || key === 'shelter') && !outside,
      confidence: null,
      location,
      seekable: false,
      eventId: null,
      approximate: location != null,
      locationLabel: location ? 'Center of the zones' : null,
      facts: [
        statusLabel(p0) ? { label: `${aggregator}'s level`, text: `${status} (${statusLabel(p0)})`, scientific: null } : { label: 'Official wording', text: status, scientific: null },
        { label: 'Zones', text: zones.map((z) => z.properties.zone_name || z.properties.zone_id).join(', '), scientific: null },
        ...(dist ? [{ label: 'Distance to the fire', text: dist, scientific: null }] : []),
      ],
      url: sourceUrl,
      issuer,
      issuedMs: null,
      updatedMs,
      expiresMs: null,
      checkedMs: data.retrieved_ms,
      bounds: zonesBounds(zones),
      status: 'active',
      distanceKm,
      highlight: { kind: 'evacuation', id, zoneIds: ids },
      links,
      notes,
      timeNotGiven: ownMs == null,
    })
  }
  return items.sort((a, b) => a.tMs - b.tMs || a.id.localeCompare(b.id))
}
