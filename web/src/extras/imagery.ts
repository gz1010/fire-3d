// Recently acquired satellite imagery (owner: optional-sources; BRIEF §11, CONTRACT "Optional sources"):
// Sentinel-2 (10 m, rendered by the backend), Landsat 8/9 HLS (30 m), VIIRS daily (375 m) and GOES-West (10-min,
// 1-2 km). Every label carries the acquisition time and the sensor, keeping these images distinct from the dated
// USGS aerial basemap ("never live satellite"), from satellite fire detections and from camera images.
import type { Map as MapLibreMap, SourceSpecification } from 'maplibre-gl'
import type { FeedItem } from '../ui/feed/types'
import { apiPath } from './client'
import { agoText, durationText, fmtWhen, relativeToText } from './format'
import type { ExtrasLegendEntry } from './legend'
import { LayerGroupHandle, type BeforeId, type LayerGroup, type LayerHandleOptions } from './mapLayers'
import type { ExtrasSource, ImageryFamily, ImageryProduct, ImageryResponse } from './types'

export const IMAGERY_SOURCE = 'fx-extras-imagery'
export const IMAGERY_LAYER = 'fx-extras-imagery'
export const DEFAULT_IMAGERY_OPACITY = 0.9

/** How these images differ from the other imagery in the app (shown in the panel and the legend detail). */
export const IMAGERY_DISTINCTION =
  'Satellite images with their own acquisition time. Not the dated aerial basemap, not live fire detections and not camera views.'

export const FAMILY_LABEL: Record<ImageryFamily, string> = {
  'sentinel-2': 'Sentinel-2 (10 m)',
  landsat: 'Landsat 8/9 (30 m)',
  viirs: 'VIIRS daily (375 m)',
  goes: 'GOES-West, every 10 min (1-2 km)',
}
export const FAMILY_ORDER: ImageryFamily[] = ['sentinel-2', 'landsat', 'viirs', 'goes']

export function imagerySource(p: ImageryProduct): SourceSpecification | null {
  const d = p.display
  if (!p.available || !d) return null
  if (d.type === 'image') return { type: 'image', url: apiPath(d.url), coordinates: d.coordinates }
  return { type: 'raster', tiles: d.tiles, tileSize: d.tile_size, maxzoom: d.max_zoom, bounds: d.bounds }
}

export function imageryLayerGroup(p: ImageryProduct | null, opacity: number): LayerGroup | null {
  const src = p ? imagerySource(p) : null
  if (!src) return null
  return {
    sources: { [IMAGERY_SOURCE]: src },
    layers: [
      {
        placement: 'below-labels',
        spec: {
          id: IMAGERY_LAYER,
          type: 'raster',
          source: IMAGERY_SOURCE,
          paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
        },
      },
    ],
  }
}

export interface ImageryLayerHandle {
  setProduct(p: ImageryProduct | null): void
  setOpacity(opacity: number): void
  setVisible(visible: boolean): void
  setBeforeId(id: BeforeId): void
  layerIds(): string[]
  remove(): void
}

/** Mount the imagery layer (one product at a time; wire `setVisible` to the `recentImagery` MapLayerKey). Pass
 *  `beforeId` = map-core's lowest wildfire overlay so observed fire and forecasts stay above the image. */
export function mountImageryLayer(map: MapLibreMap, opts: LayerHandleOptions & { opacity?: number } = {}): ImageryLayerHandle {
  let product: ImageryProduct | null = null
  let opacity = opts.opacity ?? DEFAULT_IMAGERY_OPACITY
  const h = new LayerGroupHandle(map, () => imageryLayerGroup(product, opacity), opts)
  return {
    setProduct(p) {
      product = p
      h.sync()
    },
    setOpacity(v) {
      opacity = Math.max(0, Math.min(1, v))
      if (map.getLayer(IMAGERY_LAYER)) map.setPaintProperty(IMAGERY_LAYER, 'raster-opacity', opacity)
    },
    setVisible: (v) => h.setVisible(v),
    setBeforeId: (id) => h.setBeforeId(id),
    layerIds: () => h.layerIds(),
    remove: () => h.remove(),
  }
}

export function productsByFamily(data: ImageryResponse | null): Record<ImageryFamily, ImageryProduct[]> {
  const out: Record<ImageryFamily, ImageryProduct[]> = { 'sentinel-2': [], landsat: [], viirs: [], goes: [] }
  for (const p of data?.products ?? []) out[p.family]?.push(p)
  for (const k of FAMILY_ORDER) out[k].sort((a, b) => b.acquired_ms - a.acquired_ms || a.id.localeCompare(b.id))
  return out
}

/**
 * The image to show first ("clear" = Sentinel-2 / Landsat covering at least half of the area with at most 40 % scene
 * cloud cover):
 * 1. with a known fire start (`startedMs`): the newest clear scene acquired after it, else the newest VIIRS true-colour
 *    image after it (the fire as seen from space);
 * 2. otherwise the newest clear scene (before a known start: preferring one that covers ≥ 90 % of the area, as
 *    context), else the newest VIIRS true-colour image;
 * 3. GOES (1-2 km pixels, too coarse for an incident-scale default) only when nothing else can be shown.
 */
export function pickDefaultImagery(data: ImageryResponse | null, startedMs: number | null = null): ImageryProduct | null {
  const ok = (data?.products ?? []).filter((p) => p.available && p.display)
  const newest = (list: ImageryProduct[]) => [...list].sort((a, b) => b.acquired_ms - a.acquired_ms || a.id.localeCompare(b.id))[0] ?? null
  const clear = ok.filter((p) => (p.family === 'sentinel-2' || p.family === 'landsat') && (p.coverage_pct ?? 0) >= 50 && (p.cloud_cover_pct == null || p.cloud_cover_pct <= 40))
  const viirs = ok.filter((p) => p.family === 'viirs' && p.composite === 'true_color')
  if (startedMs != null && Number.isFinite(startedMs)) {
    const after = (p: ImageryProduct) => (p.acquired_end_ms ?? p.acquired_ms) >= startedMs
    const post = newest(clear.filter(after)) ?? newest(viirs.filter(after))
    if (post) return post
    const context = newest(clear.filter((p) => (p.coverage_pct ?? 0) >= 90))
    if (context) return context
  }
  return newest(clear) ?? newest(viirs) ?? newest(ok.filter((p) => p.family === 'goes'))
}

export interface ImageryTiming {
  /** "Acquired Oct 13, 12:13 PDT" or the pass list for daily images. */
  acquired: string
  /** "4 days before the selected time" (replay) or "4 days ago" (live). */
  relative: string
  /** Acquired before the fire was reported (shows the area before the fire). */
  beforeFire: boolean
  /** "Listed 3.8 h after acquisition" (null when the source gives no publication time). */
  latency: string | null
  /** Replay only: the source listed the image after the selected time, so it was not available yet then. */
  listedAfterRef: boolean
}

/** Catalogue entries created this long after acquisition are re-processed or re-ingested archive entries: their
 *  creation time says nothing about when the image first became available. */
export const REPROCESSED_AFTER_MS = 30 * 86_400_000

/** Timing text; `live` = the list is for now (relative times say "ago"), else for a selected replay time. */
export function imageryTiming(p: ImageryProduct, refMs: number, startedMs: number | null, live = false): ImageryTiming {
  const passes = p.pass_times_ms.length > 1 && p.family === 'viirs'
  const acquired = passes
    ? `Satellite passes ${p.pass_times_ms.map((t) => fmtWhen(t, refMs)).join(' and ')} (combined daily image)`
    : `Acquired ${fmtWhen(p.acquired_ms, refMs)}`
  const reprocessed = p.latency_ms != null && p.family !== 'goes' && p.latency_ms > REPROCESSED_AFTER_MS
  let latency: string | null = null
  if (p.latency_ms != null) {
    if (p.family === 'goes') latency = `Newest frame was ${durationText(p.latency_ms)} old when checked`
    else if (reprocessed && p.published_ms != null)
      latency = `Catalogue entry created ${fmtWhen(p.published_ms, refMs)} (${durationText(p.latency_ms)} after acquisition); an earlier version may have been available sooner`
    else if (p.family === 'landsat') latency = `Catalogued ${durationText(p.latency_ms)} after acquisition`
    else latency = `Listed ${durationText(p.latency_ms)} after acquisition`
  } else if (p.latency_note) {
    latency = p.latency_note[0].toUpperCase() + p.latency_note.slice(1)
  }
  return {
    acquired,
    relative: live ? agoText(p.acquired_ms, refMs) : relativeToText(p.acquired_ms, refMs),
    beforeFire: startedMs != null && (p.acquired_end_ms ?? p.acquired_ms) < startedMs,
    latency,
    listedAfterRef: !live && !reprocessed && p.family !== 'goes' && p.published_ms != null && p.published_ms > refMs,
  }
}

/** "0 % cloud (whole scene)" / "cloud not reported" etc. */
export function cloudText(p: ImageryProduct): string {
  if (p.cloud_cover_pct == null) return 'Cloud cover not reported (clouds and smoke are visible in the image)'
  return `${Math.round(p.cloud_cover_pct)} % cloud cover (whole scene, not just this area)`
}

export function coverageText(p: ImageryProduct): string {
  if (p.coverage_pct == null) return 'Coverage not reported'
  return p.coverage_pct >= 99.5 ? 'Covers the whole area' : `Covers ${Math.round(p.coverage_pct)} % of the area`
}

/** Ground size (m) the image is displayed at when the backend render is coarser than the sensor (large areas). */
export function shownPixelM(p: ImageryProduct): number | null {
  const d = p.display
  if (d?.type !== 'image' || d.pixel_m == null || !(d.pixel_m > p.resolution_m * 1.05)) return null
  return d.pixel_m
}

export function resolutionText(p: ImageryProduct): string {
  if (p.resolution_m >= 1000) return `About ${p.resolution_m / 1000 >= 2 ? '1-2' : '1'} km pixels`
  const shown = shownPixelM(p)
  return shown != null ? `${p.resolution_m} m pixels (shown at about ${Math.round(shown)} m over this area)` : `${p.resolution_m} m pixels`
}

export function imageryLegend(p: ImageryProduct | null, refMs: number): ExtrasLegendEntry[] {
  if (!p || !p.available) return []
  return [
    {
      id: `imagery-${p.id}`,
      layer: 'recentImagery',
      label: `Satellite image · ${p.platform}`,
      detail: `${p.family === 'viirs' && p.pass_times_ms.length > 1 ? 'passes from' : 'acquired'} ${fmtWhen(p.acquired_ms, refMs)} · ${resolutionText(p).toLowerCase()}`,
      swatch: { kind: 'raster' },
    },
  ]
}

export interface ImageryCredit {
  id: string
  text: string
  href?: string
}

/** Credits for the map attribution while a product is shown (plain text + links; see CONTRACT §4.4). */
export function imageryAttribution(p: ImageryProduct | null, sources: ExtrasSource[]): ImageryCredit[] {
  if (!p || !p.available) return []
  const src = sources.find((s) => s.id === p.source_id)
  const out: ImageryCredit[] = [{ id: `imagery-${p.source_id}`, text: p.attribution, href: src?.terms_url }]
  if (p.source_id.startsWith('nasa_')) out.push({ id: 'imagery-gibs', text: "NASA GIBS (ESDIS)", href: 'https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api' })
  return out
}

/**
 * Feed items for new high-resolution scenes (Sentinel-2, Landsat; latest 3): satellite observations at their
 * acquisition time; seekable only when that time lies on the incident timeline. With a known fire start
 * (`startedMs`) only scenes acquired after it are listed: older ones are context, not updates.
 */
export function imageryFeedItems(data: ImageryResponse | null, timeRange: [number, number] | null, startedMs: number | null = null): FeedItem[] {
  if (!data || data.status !== 'available') return []
  return data.products
    .filter((p) => p.available && (p.family === 'sentinel-2' || p.family === 'landsat'))
    .filter((p) => startedMs == null || !Number.isFinite(startedMs) || (p.acquired_end_ms ?? p.acquired_ms) >= startedMs)
    .sort((a, b) => b.acquired_ms - a.acquired_ms)
    .slice(0, 3)
    .map((p) => ({
      id: `imagery:${p.id}`,
      topic: 'imagery' as const,
      kind: 'observation' as const,
      tMs: p.acquired_ms,
      title: `Satellite image acquired: ${p.platform} (${p.resolution_m} m)`,
      detail: [coverageText(p), cloudText(p), imageryTiming(p, data.reference_ms, null, data.requested_at_ms == null).latency].filter(Boolean).join(' · '),
      source: p.family === 'sentinel-2' ? 'Copernicus Sentinel-2 via Earth Search' : 'NASA HLS (Landsat 8/9) via GIBS',
      automated: true,
      key: false,
      confidence: 'observed' as const,
      location: null,
      seekable: timeRange != null && p.acquired_ms >= timeRange[0] && p.acquired_ms <= timeRange[1],
      eventId: null,
    }))
}
