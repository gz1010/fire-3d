// Public cameras (owner: optional-sources; BRIEF §11, CONTRACT "Optional sources"): ALERTCalifornia wildfire
// cameras and Caltrans traffic cameras listed by Cal OES. Pure helpers for the map, legend, panel and feed, plus a
// MapLibre layer handle. Camera images are fetched only on an explicit user action (`fetchCameraFrame`), shown
// unmodified with the source credit and the image's own time, and video is never played automatically.
import type { Feature, FeatureCollection } from 'geojson'
import type { Map as MapLibreMap, MapLayerMouseEvent } from 'maplibre-gl'
import type { TimeFmt } from '../lib/time'
import type { FeedItem } from '../ui/feed/types'
import { agoText, fmtWhen } from './format'
import type { ExtrasLegendEntry } from './legend'
import { LayerGroupHandle, type LayerGroup, type LayerHandleOptions } from './mapLayers'
import { cameraIconImage, EXTRAS_COLORS } from './style'
import type { CameraFeature, CameraFrameResponse, CameraKind, CamerasResponse } from './types'

export const CAMERA_SOURCE = 'fx-extras-cameras'
export const CAMERA_DIR_SOURCE = 'fx-extras-camera-dirs'
export const CAMERA_LAYERS = {
  dir: 'fx-extras-camera-dir',
  ring: 'fx-extras-camera-selected',
  icon: 'fx-extras-camera-icon',
} as const
export const CAMERA_ICON_IDS: Record<CameraKind, string> = { wildfire: 'fx-extras-cam-wildfire', traffic: 'fx-extras-cam-traffic' }
/** Layers that select a camera when clicked: map click handlers should not also select a location there. */
export const CAMERA_INTERACTIVE_LAYERS = [CAMERA_LAYERS.icon]
const PIXEL_RATIO = 2
const EARTH_R = 6_371_008.8
const DIR_LENGTH_M = 2500

/** Points `lengthM` along a great circle from (lon, lat) toward `deg` (clockwise from north): a direction tick. */
export function azimuthLine(lon: number, lat: number, deg: number, lengthM = DIR_LENGTH_M): [number, number][] {
  const d = lengthM / EARTH_R
  const b = (deg * Math.PI) / 180
  const p1 = (lat * Math.PI) / 180
  const l1 = (lon * Math.PI) / 180
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b))
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2))
  return [
    [lon, lat],
    [(((l2 * 180) / Math.PI + 540) % 360) - 180, (p2 * 180) / Math.PI],
  ]
}

/** Great-circle distance (m) and initial bearing (deg) from a to b. */
export function distanceBearing(a: [number, number], b: [number, number]): { distanceM: number; bearingDeg: number } {
  const [l1, p1] = [(a[0] * Math.PI) / 180, (a[1] * Math.PI) / 180]
  const [l2, p2] = [(b[0] * Math.PI) / 180, (b[1] * Math.PI) / 180]
  const dl = l2 - l1
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  const distanceM = 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)))
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return { distanceM, bearingDeg: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 }
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
export function compassWord(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]
}

export interface CameraListItem {
  feature: CameraFeature
  distanceM: number | null
  bearingDeg: number | null
}

/** Cameras sorted wildfire first, then by distance from `centre` (lon, lat) when given, then name. */
export function sortCameras(data: CamerasResponse | null, centre: [number, number] | null): CameraListItem[] {
  if (!data || data.status !== 'available') return []
  const items = data.cameras.features.map((feature) => {
    if (!centre) return { feature, distanceM: null, bearingDeg: null }
    const { distanceM, bearingDeg } = distanceBearing(centre, feature.geometry.coordinates)
    return { feature, distanceM, bearingDeg }
  })
  return items.sort(
    (a, b) =>
      Number(a.feature.properties.kind !== 'wildfire') - Number(b.feature.properties.kind !== 'wildfire') ||
      (a.distanceM ?? 0) - (b.distanceM ?? 0) ||
      a.feature.properties.name.localeCompare(b.feature.properties.name),
  )
}

/** Direction ticks for pan-tilt-zoom cameras that report where they point. */
export function cameraDirections(data: CamerasResponse | null): FeatureCollection {
  const features: Feature[] = []
  if (data?.status === 'available') {
    for (const f of data.cameras.features) {
      const az = f.properties.azimuth_deg
      if (az == null) continue
      const [lon, lat] = f.geometry.coordinates
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: azimuthLine(lon, lat, az) }, properties: { id: f.properties.id } })
    }
  }
  return { type: 'FeatureCollection', features }
}

export function cameraPoints(data: CamerasResponse | null): FeatureCollection {
  const features: Feature[] = []
  if (data?.status === 'available') {
    for (const f of data.cameras.features) {
      features.push({
        type: 'Feature',
        id: f.properties.id,
        geometry: f.geometry,
        properties: { id: f.properties.id, kind: f.properties.kind, name: f.properties.name, out: f.properties.in_service === false },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

export function cameraLayerGroup(data: CamerasResponse | null, selectedId: string | null): LayerGroup | null {
  const pts = cameraPoints(data)
  if (pts.features.length === 0) return null
  return {
    sources: {
      [CAMERA_SOURCE]: { type: 'geojson', data: pts },
      [CAMERA_DIR_SOURCE]: { type: 'geojson', data: cameraDirections(data) },
    },
    images: {
      [CAMERA_ICON_IDS.wildfire]: { ...cameraIconImage('wildfire', PIXEL_RATIO), pixelRatio: PIXEL_RATIO },
      [CAMERA_ICON_IDS.traffic]: { ...cameraIconImage('traffic', PIXEL_RATIO), pixelRatio: PIXEL_RATIO },
    },
    layers: [
      {
        placement: 'top',
        spec: {
          id: CAMERA_LAYERS.dir,
          type: 'line',
          source: CAMERA_DIR_SOURCE,
          minzoom: 9,
          layout: { 'line-cap': 'round' },
          paint: { 'line-color': EXTRAS_COLORS.text, 'line-width': 1.6, 'line-opacity': 0.75, 'line-dasharray': [2, 1.5] },
        },
      },
      {
        placement: 'top',
        spec: {
          id: CAMERA_LAYERS.ring,
          type: 'circle',
          source: CAMERA_SOURCE,
          filter: ['==', ['get', 'id'], selectedId ?? ''],
          paint: { 'circle-radius': 13, 'circle-color': 'rgba(34,211,238,0.16)', 'circle-stroke-color': EXTRAS_COLORS.select, 'circle-stroke-width': 2 },
        },
      },
      {
        placement: 'top',
        spec: {
          id: CAMERA_LAYERS.icon,
          type: 'symbol',
          source: CAMERA_SOURCE,
          layout: {
            'icon-image': ['match', ['get', 'kind'], 'traffic', CAMERA_ICON_IDS.traffic, CAMERA_ICON_IDS.wildfire] as never,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 13, 1.1] as never,
          },
          paint: { 'icon-opacity': ['case', ['get', 'out'], 0.45, 1] as never },
        },
      },
    ],
  }
}

export interface CameraLayerHandle {
  setData(data: CamerasResponse | null): void
  setSelected(id: string | null): void
  setVisible(visible: boolean): void
  layerIds(): string[]
  remove(): void
}

/** Mount the camera layers; `onSelect(id)` fires when a camera icon is clicked (wire to the cameras panel). */
export function mountCameraLayer(map: MapLibreMap, opts: LayerHandleOptions & { onSelect?: (id: string) => void } = {}): CameraLayerHandle {
  let data: CamerasResponse | null = null
  let selected: string | null = null
  const h = new LayerGroupHandle(map, () => cameraLayerGroup(data, selected), opts)
  const onClick = (e: MapLayerMouseEvent) => {
    const id = e.features?.[0]?.properties?.id
    if (typeof id === 'string') opts.onSelect?.(id)
  }
  const onEnter = () => {
    map.getCanvas().style.cursor = 'pointer'
  }
  const onLeave = () => {
    map.getCanvas().style.cursor = ''
  }
  map.on('click', CAMERA_LAYERS.icon, onClick)
  map.on('mouseenter', CAMERA_LAYERS.icon, onEnter)
  map.on('mouseleave', CAMERA_LAYERS.icon, onLeave)
  return {
    setData(d) {
      data = d
      h.sync()
    },
    setSelected(id) {
      selected = id
      if (map.getLayer(CAMERA_LAYERS.ring)) map.setFilter(CAMERA_LAYERS.ring, ['==', ['get', 'id'], id ?? ''])
    },
    setVisible: (v) => h.setVisible(v),
    layerIds: () => h.layerIds(),
    remove() {
      map.off('click', CAMERA_LAYERS.icon, onClick)
      map.off('mouseenter', CAMERA_LAYERS.icon, onEnter)
      map.off('mouseleave', CAMERA_LAYERS.icon, onLeave)
      h.remove()
    },
  }
}

export function cameraLegend(data: CamerasResponse | null): ExtrasLegendEntry[] {
  if (!data || data.status !== 'available') return []
  const out: ExtrasLegendEntry[] = []
  if (data.counts.wildfire) out.push({ id: 'cam-wildfire', layer: 'cameras', label: 'Wildfire camera (ALERTCalifornia)', detail: 'live image on request', swatch: { kind: 'camera', variant: 'wildfire' } })
  if (data.counts.traffic) out.push({ id: 'cam-traffic', layer: 'cameras', label: 'Traffic camera (Caltrans)', detail: 'live image on request', swatch: { kind: 'camera', variant: 'traffic' } })
  if (data.cameras.features.some((f) => f.properties.azimuth_deg != null)) {
    out.push({ id: 'cam-dir', layer: 'cameras', label: 'Camera pointing direction', detail: 'as last reported', swatch: { kind: 'direction' } })
  }
  return out
}

/** One summary item (cameras are a resource, not an event): at the fetch time, not seekable. */
export function cameraFeedItems(data: CamerasResponse | null): FeedItem[] {
  if (!data || data.status !== 'available' || data.cameras.features.length === 0) return []
  const w = data.counts.wildfire ?? 0
  const t = data.counts.traffic ?? 0
  const parts = [w ? `${w} wildfire camera${w === 1 ? '' : 's'} (ALERTCalifornia)` : null, t ? `${t} traffic camera${t === 1 ? '' : 's'} (Caltrans)` : null].filter(Boolean)
  // timed by Cal OES's own update of the camera list, never by Fire-3d's fetch (brief 2 U-R1)
  const own = data.source_updated_ms != null && Number.isFinite(data.source_updated_ms) && data.source_updated_ms > 0 ? data.source_updated_ms : null
  return [
    {
      id: `camera:summary:${data.bbox.join(',')}`,
      topic: 'camera',
      kind: 'observation',
      tMs: own ?? data.retrieved_ms ?? data.now_ms,
      title: 'Public cameras near the fire',
      detail: `${parts.join(' and ')} in this area${own != null ? ` (Cal OES list updated ${fmtWhen(own)})` : ''}. Images open only when you ask for one.`,
      source: 'Cal OES California Webcams',
      automated: true,
      key: false,
      confidence: null,
      location: null,
      seekable: false,
      eventId: null,
      checkedMs: data.retrieved_ms,
      timeNotGiven: own == null,
    },
  ]
}

/** "Image file time 13:28 PDT (3 min ago)" with what the time means; never presented as an exact capture time. */
export function frameTimeText(frame: Pick<CameraFrameResponse, 'image_time_ms' | 'retrieved_ms'>, nowMs: number): string {
  if (frame.image_time_ms == null) return `Image time not reported by the camera server (fetched ${agoText(frame.retrieved_ms, nowMs)})`
  return `Image updated ${fmtWhen(frame.image_time_ms, nowMs)} (${agoText(frame.image_time_ms, nowMs)}) by the camera server's clock`
}

/** Plain description of a camera's direction / view. `tf` (CONTRACT §14.9.6) is accepted for the shared signature;
 *  the text has no time in it today. */
export function cameraViewText(f: CameraFeature, _tf?: TimeFmt): string {
  const p = f.properties
  if (p.azimuth_deg != null) return `Pan-tilt-zoom; pointing ${compassWord(p.azimuth_deg)} (${Math.round(p.azimuth_deg)}°) as last reported`
  if (p.view && p.kind === 'traffic') return `Fixed view looking ${p.view.toLowerCase()}`
  return p.view ?? 'View direction not reported'
}

/** Status line for a traffic camera's service state (null when the source does not report it). */
export function cameraServiceText(f: CameraFeature): string | null {
  const p = f.properties
  if (p.in_service === false) return 'Out of service (Caltrans)'
  if (p.in_service === true) return p.update_minutes ? `In service · new image about every ${p.update_minutes} min` : 'In service'
  return null
}
