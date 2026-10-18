// The California overview's fire markers (brief 2, O-R2; owner: map). One marker per fire of the overview filter
// (state/overview.ts overviewFires: the same set as the shell's overview list), from CAL FIRE's official record only:
//   - a circle sized by the square root of the acreage, 4-13 px;
//   - active fires filled orange with a white ring, other fires hollow amber; a dark casing keeps both readable on
//     aerial photos and the dark map, darker strokes and ink on the light road map;
//   - labels "Name · acres" for active fires and fires of 20,000 acres or more, placed around the marker and dropped
//     where they would collide (dense Southern California), active and larger fires first;
//   - an invisible hit circle of at least 11 px radius (a 22 px touch target) under each marker.
// A click on a marker or its label opens the fire card (useWorkspace.setFireCard, I3), never a location select; when
// several markers overlap, the one whose centre is nearest the pointer wins (pickFireHit). Nothing here animates:
// features are rebuilt only when the list, the filter or the units change.
// Decision 10: the markers stay at every zoom. While a fire is open they are dimmed (overviewPaint), the open fire's own
// marker is left out (its reported-location ring shows it) and, in a replay, so are fires that had not started by the
// timeline time (overviewFilters). Zoomed in near an unprepared fire, a chip says "Spread not prepared yet · Prepare
// analysis (1-3 min)"; a click on it opens the fire card, never a build.
import type { LayerSpecification } from 'maplibre-gl'
import type { IncidentSummary } from '../api/types'
import { isActiveFire } from '../state/overview'
import type { Units } from '../state/workspace'
import type { MapTheme } from './layers'
import type { FeatureCollection, Feature, Geometry } from './overlayModel'

export const OVERVIEW_SRC = 'fx-overview-fires'

export const OVR = {
  casing: 'fx-overview-casing',
  past: 'fx-overview-past',
  live: 'fx-overview-live',
  selected: 'fx-overview-selected',
  hit: 'fx-overview-hit',
  label: 'fx-overview-label',
  chip: 'fx-overview-chip',
} as const

/** Layers a click or hover may hit (the hit circle, the markers and their labels). */
export const OVERVIEW_HIT_LAYERS: readonly string[] = [OVR.hit, OVR.live, OVR.past, OVR.label]

/** The "Spread not prepared yet" chip's layer minimum zoom (which fires get it: map/focus.ts chipTargets). */
export const CHIP_MINZOOM = 8.5
export const CHIP_TEXT = 'Spread not prepared yet · Prepare analysis (1-3 min)'
export const CHIP_TEXT_BUILDING = 'Spread being prepared (1-3 min)…'
/** Marker opacity while a fire is open (decision 10: lighter, still discoverable). */
export const DIM_OPACITY = 0.55

/** The chip prompt of a fire without a ready analysis ('' when it has one). */
export function chipText(status: IncidentSummary['bundle_status']): string {
  return status === 'ready' ? '' : status === 'building' ? CHIP_TEXT_BUILDING : CHIP_TEXT
}

/** Fires of at least this size get a label even when CAL FIRE no longer lists them as active. */
export const LABEL_MIN_ACRES = 20_000
/** Marker radius range (px). */
export const MARKER_MIN_PX = 4
export const MARKER_MAX_PX = 13
/** Smallest hit radius (px): a 22 px touch target. */
export const HIT_MIN_PX = 11

const HA_PER_ACRE = 0.40468564224

/** Circle radius by the square root of the acreage: 4 px for tiny fires, 7 px at 10,000 ac, 13 px from about
 *  130,000 ac (sqrt 360), linear in between (the audit's sketch, which read well on aerial at both widths). */
export function markerRadius(acres: number | null | undefined): number {
  const a = typeof acres === 'number' && Number.isFinite(acres) && acres > 0 ? acres : 0
  const s = Math.sqrt(a)
  const r = s <= 100 ? MARKER_MIN_PX + (s / 100) * 3 : 7 + ((Math.min(s, 360) - 100) / 260) * 6
  return Math.round(Math.min(MARKER_MAX_PX, Math.max(MARKER_MIN_PX, r)) * 10) / 10
}

/** "Garnet · 59,844 ac" ("· 24,218 ha" in metric); the trailing " Fire" is left out to keep labels short. */
export function overviewLabel(name: string, acres: number | null | undefined, units: Units): string {
  const short = name.replace(/\s+fire$/i, '').trim() || name
  if (typeof acres !== 'number' || !Number.isFinite(acres) || acres <= 0) return short
  const v = units === 'metric' ? acres * HA_PER_ACRE : acres
  return `${short} · ${Math.round(v).toLocaleString('en-US')} ${units === 'metric' ? 'ha' : 'ac'}`
}

/** Should this fire carry a label on the overview map? */
export function isLabelled(s: Pick<IncidentSummary, 'mode' | 'is_active' | 'acres'>): boolean {
  return isActiveFire(s) || (s.acres ?? 0) >= LABEL_MIN_ACRES
}

/** Draw / label priority: active fires above others, then by size. */
export function sortKey(s: Pick<IncidentSummary, 'mode' | 'is_active' | 'acres'>): number {
  return (isActiveFire(s) ? 1e7 : 0) + Math.min(9_999_999, Math.max(0, s.acres ?? 0))
}

/** One point feature per fire with a valid reported location (CAL FIRE's coordinates). */
export function overviewFeatures(fires: readonly IncidentSummary[], units: Units): FeatureCollection {
  const features: Feature<Geometry>[] = []
  fires.forEach((s, i) => {
    if (!Number.isFinite(s.lon) || !Number.isFinite(s.lat) || Math.abs(s.lat) > 90 || Math.abs(s.lon) > 180) return
    const r = markerRadius(s.acres)
    const live = isActiveFire(s)
    features.push({
      type: 'Feature',
      id: i,
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: {
        id: s.id,
        name: s.name,
        live,
        acres: s.acres ?? 0,
        r,
        hit: Math.max(HIT_MIN_PX, r + 3),
        sort: sortKey(s),
        label: isLabelled(s) ? overviewLabel(s.name, s.acres, units) : '',
        ready: s.bundle_status === 'ready',
        chip: chipText(s.bundle_status),
        start: s.started_ms,
      },
    })
  })
  return { type: 'FeatureCollection', features }
}

export interface FireHit {
  id: string
  live: boolean
  acres: number
  /** Distance from the pointer to the marker centre (px). */
  distPx: number
}

/** The fire a click means when markers overlap: the nearest centre; ties go to active, then larger fires. */
export function pickFireHit(hits: readonly FireHit[]): string | null {
  let best: FireHit | null = null
  for (const h of hits) {
    if (!best) {
      best = h
      continue
    }
    const d = h.distPx - best.distPx
    if (d < -0.5 || (Math.abs(d) <= 0.5 && (Number(h.live) - Number(best.live) || h.acres - best.acres) > 0)) best = h
  }
  return best?.id ?? null
}

const PALETTE = {
  dark: { casing: 'rgba(6,10,16,0.72)', liveFill: '#ff5a1f', liveRing: '#ffffff', pastFill: 'rgba(255,190,90,0.2)', pastRing: '#ffc46b', ink: '#ffffff', halo: 'rgba(4,7,11,0.9)', sel: '#ffffff' },
  light: { casing: 'rgba(255,255,255,0.85)', liveFill: '#ea4f12', liveRing: '#ffffff', pastFill: 'rgba(161,98,7,0.14)', pastRing: '#a16207', ink: '#16202b', halo: 'rgba(255,255,255,0.95)', sel: '#16202b' },
} as const

/** Fonts available from OpenFreeMap's glyph server. */
const FONT = ['Noto Sans Regular']

export const CHIP_IMAGE: Record<'dark' | 'light', string> = { dark: 'fx-chip-dark', light: 'fx-chip-light' }
const CHIP_PX = { w: 32, h: 24, r: 8, border: 2 } as const

/** A stretchable pill for the chip (device pixels at pixelRatio 2): rounded, amber-edged; dark or light inside. */
export function chipImage(theme: 'dark' | 'light'): {
  image: { width: number; height: number; data: Uint8Array }
  options: { pixelRatio: number; stretchX: [number, number][]; stretchY: [number, number][]; content: [number, number, number, number] }
} {
  const { w, h, r, border } = CHIP_PX
  const data = new Uint8Array(w * h * 4)
  const fill = theme === 'dark' ? [14, 21, 30, 236] : [255, 255, 255, 245]
  const edge = theme === 'dark' ? [245, 165, 36, 235] : [180, 83, 9, 235]
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // signed distance to the rounded rectangle's edge (negative inside)
      const qx = Math.max(Math.abs(x + 0.5 - w / 2) - (w / 2 - r), 0)
      const qy = Math.max(Math.abs(y + 0.5 - h / 2) - (h / 2 - r), 0)
      const d = Math.hypot(qx, qy) - r
      const a = Math.max(0, Math.min(1, 0.5 - d))
      const c = d > -border ? edge : fill
      const i = (y * w + x) * 4
      data[i] = c[0]
      data[i + 1] = c[1]
      data[i + 2] = c[2]
      data[i + 3] = Math.round(c[3] * a)
    }
  return {
    image: { width: w, height: h, data },
    options: { pixelRatio: 2, stretchX: [[r, w - r]], stretchY: [[r, h - r]], content: [r - 2, r - 3, w - r + 2, h - r + 3] },
  }
}

type Filter = unknown[]

/** Each marker layer's own filter. */
const BASE_FILTERS: Record<string, Filter | null> = {
  [OVR.casing]: null,
  [OVR.past]: ['!', ['get', 'live']],
  [OVR.live]: ['get', 'live'],
  [OVR.hit]: null,
  [OVR.label]: ['!=', ['get', 'label'], ''],
  [OVR.chip]: ['!=', ['get', 'chip'], ''],
}

/** Filters for every marker layer leaving out `hidden` fires (the open one; in a replay, those not started yet); the
 *  chip only for `chips` (map/focus.ts chipTargets: unprepared fires zoomed in on). The card ring (OVR.selected) is set
 *  separately. */
export function overviewFilters(hidden: readonly string[], chips: readonly string[] = []): Record<string, Filter> {
  const out: Record<string, Filter> = {}
  const keep = hidden.length ? ['!', ['in', ['get', 'id'], ['literal', [...hidden]]]] : null
  for (const [id, base] of Object.entries(BASE_FILTERS)) {
    const only = id === OVR.chip ? ['in', ['get', 'id'], ['literal', [...chips]]] : null
    const parts = [base, only, keep].filter((x): x is Filter => x != null)
    out[id] = parts.length === 0 ? ['boolean', true] : parts.length === 1 ? parts[0] : ['all', ...parts]
  }
  return out
}

/** Paint values for the markers: full on the overview, lighter while a fire is open. */
export function overviewPaint(dim: boolean): Record<string, Record<string, number>> {
  const o = dim ? DIM_OPACITY : 1
  return {
    [OVR.casing]: { 'circle-stroke-opacity': o },
    [OVR.past]: { 'circle-opacity': o, 'circle-stroke-opacity': o },
    [OVR.live]: { 'circle-opacity': o, 'circle-stroke-opacity': o },
    [OVR.label]: { 'text-opacity': dim ? 0.8 : 1 },
  }
}

/** The overview layers, bottom to top (added above the basemap labels, below the open fire's markers). */
export function overviewLayers(theme: MapTheme): LayerSpecification[] {
  const p = theme === 'light' ? PALETTE.light : PALETTE.dark
  const tone = theme === 'light' ? 'light' : 'dark'
  return [
    {
      id: OVR.casing,
      type: 'circle',
      source: OVERVIEW_SRC,
      layout: { 'circle-sort-key': ['get', 'sort'] },
      paint: {
        'circle-radius': ['+', ['get', 'r'], ['case', ['get', 'live'], 2, 0.8]],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': p.casing,
        'circle-stroke-width': 2,
        'circle-pitch-alignment': 'viewport',
      },
    },
    {
      id: OVR.past,
      type: 'circle',
      source: OVERVIEW_SRC,
      filter: ['!', ['get', 'live']],
      layout: { 'circle-sort-key': ['get', 'sort'] },
      paint: {
        'circle-radius': ['get', 'r'],
        'circle-color': p.pastFill,
        'circle-stroke-color': p.pastRing,
        'circle-stroke-width': 1.6,
        'circle-pitch-alignment': 'viewport',
      },
    },
    {
      id: OVR.live,
      type: 'circle',
      source: OVERVIEW_SRC,
      filter: ['get', 'live'],
      layout: { 'circle-sort-key': ['get', 'sort'] },
      paint: {
        'circle-radius': ['+', ['get', 'r'], 1],
        'circle-color': p.liveFill,
        'circle-stroke-color': p.liveRing,
        'circle-stroke-width': 2,
        'circle-pitch-alignment': 'viewport',
      },
    },
    {
      // the fire whose card is open (filter set by the controller)
      id: OVR.selected,
      type: 'circle',
      source: OVERVIEW_SRC,
      filter: ['==', ['get', 'id'], ''],
      paint: {
        'circle-radius': ['+', ['get', 'r'], 6],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': p.sel,
        'circle-stroke-width': 2.5,
        'circle-pitch-alignment': 'viewport',
      },
    },
    {
      // invisible touch target (>= 22 px across); queried by clicks and hovers only
      id: OVR.hit,
      type: 'circle',
      source: OVERVIEW_SRC,
      paint: { 'circle-radius': ['get', 'hit'], 'circle-color': '#000000', 'circle-opacity': 0, 'circle-pitch-alignment': 'viewport' },
    },
    {
      id: OVR.label,
      type: 'symbol',
      source: OVERVIEW_SRC,
      filter: ['!=', ['get', 'label'], ''],
      layout: {
        'text-field': ['get', 'label'],
        'text-font': FONT,
        'text-size': 12,
        'text-variable-anchor': ['top', 'bottom', 'right', 'left'],
        'text-radial-offset': ['+', 0.45, ['/', ['get', 'r'], 12]],
        'text-justify': 'auto',
        'text-max-width': 14,
        'text-allow-overlap': false,
        'text-optional': true,
        'symbol-sort-key': ['-', 0, ['get', 'sort']],
        'text-padding': 3,
      },
      paint: { 'text-color': p.ink, 'text-halo-color': p.halo, 'text-halo-width': 1.6, 'text-halo-blur': 0.3 },
    },
    {
      // zoomed in near an unprepared fire: the prompt (placed before the labels, which avoid it); the controller limits
      // it to the fires near the view centre (chipTargets), none until then
      id: OVR.chip,
      type: 'symbol',
      source: OVERVIEW_SRC,
      minzoom: CHIP_MINZOOM,
      filter: ['all', ['!=', ['get', 'chip'], ''], ['in', ['get', 'id'], ['literal', []]]],
      layout: {
        'icon-image': CHIP_IMAGE[tone],
        'icon-text-fit': 'both',
        'icon-text-fit-padding': [3, 7, 3, 7],
        'text-field': ['get', 'chip'],
        'text-font': FONT,
        'text-size': 11.5,
        'text-anchor': 'top',
        'text-offset': [0, 1.9],
        // two short lines rather than one wide pill (it must fit beside a phone's edge)
        'text-max-width': 13,
        'text-line-height': 1.25,
        'icon-allow-overlap': true,
        'text-allow-overlap': true,
      },
      paint: { 'text-color': tone === 'light' ? '#16202b' : '#f3f6f9' },
    },
  ]
}
