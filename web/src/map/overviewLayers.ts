// The national overview's fire markers (brief 3, CONTRACT §14.11, audit-3 web W3; owner: us-web). One marker per fire
// of the overview filter (state/overview.ts overviewFires: the same set as the shell's overview list), from the
// agencies' official records only (CAL FIRE in California, NIFC WFIGS elsewhere). With every active fire of the lower
// 48 listed (a few hundred, many under 1 acre) and about 1,300 fires a year, the markers are split into three MapLibre
// GeoJSON sources so the map stays readable (MapLibre's own clustering, in its worker; no new dependency):
//   - fx-overview-pinned: never grouped: active fires of 5,000 acres or more, plus the fire whose card is open. The
//     card's selection ring reads only this source;
//   - fx-overview-active: the other active fires, grouped when 3 or more are close (radius 28 px, 44 on screens under
//     500 px) up to z6;
//   - fx-overview-other: fires that are not active, grouped the same way (radius 40 px) up to z7.
// Active and other fires never share a group, and active marks draw above other fires. A group's bubble is sized by
// the largest fire in it (log of its acres), not by the count, which is its label; a small active fire (under 10 acres
// or no size reported) is a small orange dot without the white ring. Single markers are sized by the square root of the
// acreage and grow with the zoom (0.6x at z3 to 1x at z7).
// Labels "Name · acres", by acres with zoom thresholds (labelMinZoom): pinned fires at every zoom; from z5 active fires
// of 300 acres or more and any fire of 20,000 or more; from z7 active fires of 10 acres or more and any fire of 1,000
// or more; the rest from z9 (and on hover). Activity is a bonus only at 300 acres or more, so a tiny active fire never
// wins a label over a large contained one.
// A click on a marker or its label opens the fire card (useWorkspace.setFireCard, I3), never a location select; a click
// on a group zooms in to min(expansion zoom, 8). Fires hidden from the map (the open fire; in a replay, fires that had
// not started) are removed from the data, keyed on the hidden set (layer filters would not change group counts).
// Decision 10 (brief 2): the markers stay at every zoom, lighter while a fire is open; zoomed in near an unprepared
// fire, a chip says "Spread not prepared yet · Prepare analysis (1-3 min)" and opens the fire card, never a build.
import type { LayerSpecification } from 'maplibre-gl'
import type { IncidentSummary } from '../api/types'
import { isActiveFire } from '../state/overview'
import type { Units } from '../state/workspace'
import type { MapTheme } from './layers'
import type { Feature, FeatureCollection, Geometry } from './overlayModel'

export type OverviewGroup = 'pinned' | 'active' | 'other'
export const OVERVIEW_GROUPS: readonly OverviewGroup[] = ['pinned', 'active', 'other']

/** The three sources (§14.11). */
export const OVERVIEW_SOURCES: Record<OverviewGroup, string> = {
  pinned: 'fx-overview-pinned',
  active: 'fx-overview-active',
  other: 'fx-overview-other',
}

export const OVR = {
  otherCluster: 'fx-overview-other-cluster',
  otherCasing: 'fx-overview-other-casing',
  otherPoint: 'fx-overview-other-point',
  otherCount: 'fx-overview-other-count',
  activeCluster: 'fx-overview-active-cluster',
  activeCasing: 'fx-overview-active-casing',
  activePoint: 'fx-overview-active-point',
  activeCount: 'fx-overview-active-count',
  pinnedCasing: 'fx-overview-pinned-casing',
  pinnedPast: 'fx-overview-pinned-past',
  pinnedLive: 'fx-overview-pinned-live',
  selected: 'fx-overview-selected',
  otherHit: 'fx-overview-other-hit',
  activeHit: 'fx-overview-active-hit',
  pinnedHit: 'fx-overview-pinned-hit',
  otherLabel: 'fx-overview-other-label',
  activeLabel: 'fx-overview-active-label',
  pinnedLabel: 'fx-overview-pinned-label',
  otherChip: 'fx-overview-other-chip',
  activeChip: 'fx-overview-active-chip',
  pinnedChip: 'fx-overview-pinned-chip',
} as const

/** Layers whose features are single fires (a click or hover means that fire). */
export const OVERVIEW_FIRE_LAYERS: readonly string[] = [
  OVR.pinnedHit,
  OVR.activeHit,
  OVR.otherHit,
  OVR.pinnedLive,
  OVR.pinnedPast,
  OVR.activePoint,
  OVR.otherPoint,
  OVR.pinnedLabel,
  OVR.activeLabel,
  OVR.otherLabel,
]
/** Label layers (a click on a label means its fire when no marker is hit). */
export const OVERVIEW_LABEL_LAYERS: readonly string[] = [OVR.pinnedLabel, OVR.activeLabel, OVR.otherLabel]
/** Group bubbles (a click zooms in). */
export const OVERVIEW_CLUSTER_LAYERS: readonly string[] = [OVR.activeCluster, OVR.otherCluster]
/** The "Spread not prepared yet" chips. */
export const OVERVIEW_CHIP_LAYERS: readonly string[] = [OVR.pinnedChip, OVR.activeChip, OVR.otherChip]
/** Layers a click or hover may hit (markers, labels, groups). */
export const OVERVIEW_HIT_LAYERS: readonly string[] = [...OVERVIEW_FIRE_LAYERS, ...OVERVIEW_CLUSTER_LAYERS]

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

/** Active fires of at least this size are pinned: never grouped, labelled at every zoom (§14.11). */
export const PINNED_MIN_ACRES = 5_000
/** Active fires under this size (or with no size) are small dots (§14.11). */
export const SMALL_MAX_ACRES = 10
/** Any fire of at least this size is labelled from z5 (and active fires of 300 acres or more). */
export const LABEL_MIN_ACRES = 20_000
export const LABEL_ACTIVE_Z5_ACRES = 300
/** From z7: active fires of 10 acres or more and any fire of 1,000 or more. */
export const LABEL_Z7_ACRES = 1_000
/** Group settings (§14.11, audit-3 web 3.2). */
export const CLUSTER = {
  active: { radius: 28, radiusNarrow: 44, maxZoom: 6, minPoints: 3 },
  other: { radius: 40, radiusNarrow: 40, maxZoom: 7, minPoints: 3 },
} as const
/** Screens narrower than this get the wider active grouping radius. */
export const NARROW_PX = 500
/** A click on a group zooms in at most to this zoom (below the focus zoom 8.5, so it never opens a prepared fire). */
export const CLUSTER_CLICK_MAX_ZOOM = 8
/** Marker radius range (px). */
export const MARKER_MIN_PX = 4
export const MARKER_MAX_PX = 13
/** A small active fire's dot radius (px). */
export const SMALL_DOT_PX = 2.5
/** Smallest hit radius (px): a 22 px touch target. */
export const HIT_MIN_PX = 11

const HA_PER_ACRE = 0.40468564224

/** Circle radius by the square root of the acreage: 4 px for tiny fires, 7 px at 10,000 ac, 13 px from about
 *  130,000 ac (sqrt 360), linear in between (at z7 and closer; smaller at the national zoom). */
export function markerRadius(acres: number | null | undefined): number {
  const a = typeof acres === 'number' && Number.isFinite(acres) && acres > 0 ? acres : 0
  const s = Math.sqrt(a)
  const r = s <= 100 ? MARKER_MIN_PX + (s / 100) * 3 : 7 + ((Math.min(s, 360) - 100) / 260) * 6
  return Math.round(Math.min(MARKER_MAX_PX, Math.max(MARKER_MIN_PX, r)) * 10) / 10
}

/** "Garnet · 59,844 ac" ("· 24,218 ha" in metric); the trailing " Fire" is left out to keep labels short; names stay
 *  verbatim otherwise ("Fd140011"). */
export function overviewLabel(name: string, acres: number | null | undefined, units: Units): string {
  const short = name.replace(/\s+fire$/i, '').trim() || name
  if (typeof acres !== 'number' || !Number.isFinite(acres) || acres <= 0) return short
  const v = units === 'metric' ? acres * HA_PER_ACRE : acres
  return `${short} · ${Math.round(v).toLocaleString('en-US')} ${units === 'metric' ? 'ha' : 'ac'}`
}

const acresOf = (s: Pick<IncidentSummary, 'acres'>) => (typeof s.acres === 'number' && Number.isFinite(s.acres) && s.acres > 0 ? s.acres : 0)

/** A small active fire (under 10 acres, or no size reported): a dot, labelled only from z9. */
export function isSmallActive(s: Pick<IncidentSummary, 'mode' | 'is_active' | 'acres'>): boolean {
  return isActiveFire(s) && !(typeof s.acres === 'number' && Number.isFinite(s.acres) && s.acres >= SMALL_MAX_ACRES)
}

/** The zoom from which a fire's label shows (§14.11): 0 pinned; 5 active >= 300 ac or any >= 20,000 ac; 7 active
 *  >= 10 ac or any >= 1,000 ac; else 9. */
export function labelMinZoom(s: Pick<IncidentSummary, 'mode' | 'is_active' | 'acres'>, pinned = false): number {
  if (pinned) return 0
  const a = acresOf(s)
  const active = isActiveFire(s)
  if ((active && a >= LABEL_ACTIVE_Z5_ACRES) || a >= LABEL_MIN_ACRES) return 5
  if ((active && a >= SMALL_MAX_ACRES) || a >= LABEL_Z7_ACRES) return 7
  return 9
}

/** Label priority (higher first): acres, with activity a bonus only at 300 acres or more. */
export function sortKey(s: Pick<IncidentSummary, 'mode' | 'is_active' | 'acres'>): number {
  const a = Math.min(9_999_999, acresOf(s))
  return (isActiveFire(s) && a >= LABEL_ACTIVE_Z5_ACRES ? 1e7 : 0) + a
}

/** Is this fire pinned (never grouped)? Active fires of 5,000 acres or more, and the fire whose card is open. */
export function isPinned(s: Pick<IncidentSummary, 'id' | 'mode' | 'is_active' | 'acres'>, cardId: string | null = null): boolean {
  return s.id === cardId || (isActiveFire(s) && acresOf(s) >= PINNED_MIN_ACRES)
}

export interface OverviewSplit {
  pinned: IncidentSummary[]
  active: IncidentSummary[]
  other: IncidentSummary[]
}

const validPoint = (s: Pick<IncidentSummary, 'lat' | 'lon'>) => Number.isFinite(s.lon) && Number.isFinite(s.lat) && Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180

/** Split the overview set into the three sources (§14.11): hidden fires (the open fire; in a replay, fires not started
 *  yet) are left out of the data altogether, so group counts never include them. */
export function splitOverview(fires: readonly IncidentSummary[], o: { hidden?: ReadonlySet<string> | readonly string[]; cardId?: string | null } = {}): OverviewSplit {
  const hidden = o.hidden instanceof Set ? o.hidden : new Set(o.hidden ?? [])
  const out: OverviewSplit = { pinned: [], active: [], other: [] }
  for (const s of fires) {
    if (hidden.has(s.id) || !validPoint(s)) continue
    if (isPinned(s, o.cardId ?? null)) out.pinned.push(s)
    else if (isActiveFire(s)) out.active.push(s)
    else out.other.push(s)
  }
  return out
}

/** One point feature per fire (agency coordinates); `pinned` features are labelled at every zoom. */
export function overviewFeatures(fires: readonly IncidentSummary[], units: Units, o: { pinned?: boolean } = {}): FeatureCollection {
  const features: Feature<Geometry>[] = []
  fires.forEach((s, i) => {
    if (!validPoint(s)) return
    const live = isActiveFire(s)
    const small = isSmallActive(s)
    const r = markerRadius(s.acres)
    features.push({
      type: 'Feature',
      id: i,
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: {
        id: s.id,
        name: s.name,
        live,
        small: small && !o.pinned,
        acres: acresOf(s),
        r,
        hit: Math.max(HIT_MIN_PX, r + 3),
        sort: sortKey(s),
        lz: labelMinZoom(s, o.pinned),
        label: overviewLabel(s.name, s.acres, units),
        ready: s.bundle_status === 'ready',
        chip: chipText(s.bundle_status),
        start: s.started_ms,
        state: s.state ?? '',
      },
    })
  })
  return { type: 'FeatureCollection', features }
}

/** The three sources' data for a split. */
export function overviewData(split: OverviewSplit, units: Units): Record<OverviewGroup, FeatureCollection> {
  return {
    pinned: overviewFeatures(split.pinned, units, { pinned: true }),
    active: overviewFeatures(split.active, units),
    other: overviewFeatures(split.other, units),
  }
}

/** GeoJSON source options of one group (§14.11): the pinned source is never clustered. */
export function overviewSourceOptions(group: OverviewGroup, containerWidthPx: number): Record<string, unknown> {
  const base = { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, tolerance: 0.2 }
  if (group === 'pinned') return base
  const c = CLUSTER[group]
  return {
    ...base,
    cluster: true,
    clusterRadius: containerWidthPx < NARROW_PX ? c.radiusNarrow : c.radius,
    clusterMaxZoom: c.maxZoom,
    clusterMinPoints: c.minPoints,
    clusterProperties: {
      max_acres: ['max', ['get', 'acres']],
      small: ['+', ['case', ['get', 'small'], 1, 0]],
    },
  }
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

/** A group bubble under the pointer. */
export interface ClusterHit {
  group: 'active' | 'other'
  clusterId: number
  lon: number
  lat: number
  count: number
  maxAcres: number
  small: number
}

/** What a group's hover says: "61 active fires · largest 606 ac · 57 under 10 ac or size not reported · click to zoom
 *  in" (`otherLabel`: "other 2026 fires", "2025 fires"). */
export function clusterHoverText(c: Pick<ClusterHit, 'group' | 'count' | 'maxAcres' | 'small'>, units: Units, otherLabel = 'other fires'): string {
  const what = c.group === 'active' ? `${c.count.toLocaleString('en-US')} active fires` : `${c.count.toLocaleString('en-US')} ${otherLabel}`
  const parts = [what]
  if (c.maxAcres > 0) {
    const v = units === 'metric' ? c.maxAcres * HA_PER_ACRE : c.maxAcres
    parts.push(`largest ${Math.round(v).toLocaleString('en-US')} ${units === 'metric' ? 'ha' : 'ac'}`)
  }
  if (c.group === 'active' && c.small > 0) parts.push(`${c.small.toLocaleString('en-US')} under 10 ac or size not reported`)
  parts.push('click to zoom in')
  return parts.join(' · ')
}

/** The zoom a group click goes to: its expansion zoom, at most CLUSTER_CLICK_MAX_ZOOM, and never out. */
export function clusterClickZoom(expansionZoom: number, currentZoom: number): number {
  const z = Number.isFinite(expansionZoom) ? expansionZoom : currentZoom + 2
  return Math.max(currentZoom, Math.min(CLUSTER_CLICK_MAX_ZOOM, z))
}

const PALETTE = {
  dark: { casing: 'rgba(6,10,16,0.72)', liveFill: '#ff5a1f', liveRing: '#ffffff', pastFill: 'rgba(255,190,90,0.2)', pastRing: '#ffc46b', groupPastFill: 'rgba(255,190,90,0.3)', ink: '#ffffff', halo: 'rgba(4,7,11,0.9)', liveHalo: 'rgba(120,30,0,0.9)', sel: '#ffffff' },
  light: { casing: 'rgba(255,255,255,0.85)', liveFill: '#ea4f12', liveRing: '#ffffff', pastFill: 'rgba(161,98,7,0.14)', pastRing: '#a16207', groupPastFill: 'rgba(255,228,180,0.85)', ink: '#16202b', halo: 'rgba(255,255,255,0.95)', liveHalo: 'rgba(120,30,0,0.9)', sel: '#16202b' },
} as const

/** Fonts available from OpenFreeMap's glyph server. */
const FONT = ['Noto Sans Regular']
const FONT_BOLD = ['Noto Sans Bold']

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
const CLUSTERED: Filter = ['has', 'point_count']
const SINGLE: Filter = ['!', ['has', 'point_count']]

/** The chip layers' filters: only `chips` (map/focus.ts chipTargets: unprepared fires zoomed in on). */
export function overviewFilters(chips: readonly string[] = []): Record<string, Filter> {
  const only = ['all', ['!=', ['get', 'chip'], ''], ['in', ['get', 'id'], ['literal', [...chips]]]]
  return {
    [OVR.pinnedChip]: only,
    [OVR.activeChip]: ['all', SINGLE, only],
    [OVR.otherChip]: ['all', SINGLE, only],
  }
}

/** The selection ring's filter: the fire whose card is open (always in the pinned source). */
export function selectedFilter(cardId: string | null): Filter {
  return ['==', ['get', 'id'], cardId ?? '']
}

/** Paint values for the markers: full on the overview, lighter while a fire is open. */
export function overviewPaint(dim: boolean): Record<string, Record<string, number>> {
  const o = dim ? DIM_OPACITY : 1
  const t = dim ? 0.8 : 1
  const out: Record<string, Record<string, number>> = {}
  for (const id of [OVR.otherCasing, OVR.activeCasing, OVR.pinnedCasing]) out[id] = { 'circle-stroke-opacity': o }
  for (const id of [OVR.otherPoint, OVR.activePoint, OVR.pinnedPast, OVR.pinnedLive, OVR.otherCluster, OVR.activeCluster]) out[id] = { 'circle-opacity': o, 'circle-stroke-opacity': o }
  for (const id of [OVR.otherCount, OVR.activeCount, ...OVERVIEW_LABEL_LAYERS]) out[id] = { 'text-opacity': t }
  return out
}

/** A radius that grows with the zoom: 0.6x at z3, 1x from z7 (top-level zoom interpolation, as MapLibre requires). */
const zoomed = (r: unknown): unknown => ['interpolate', ['linear'], ['zoom'], 3, ['*', 0.6, r], 7, r]

/** A group bubble's radius from its largest fire: 8 px (no size) to 15 px (100,000 ac), by the log of the acres. */
export const CLUSTER_RADIUS_EXPR: unknown = ['interpolate', ['linear'], ['ln', ['max', 1, ['to-number', ['get', 'max_acres'], 0]]], 0, 8, 6.9, 10, 9.2, 12.5, 11.5, 15]

/** The label text at the current zoom: the fire's label once the zoom reaches its `lz`, else '' (no symbol). */
const LABEL_TEXT: unknown = [
  'step',
  ['zoom'],
  ['case', ['<', ['get', 'lz'], 5], ['get', 'label'], ''],
  5,
  ['case', ['<', ['get', 'lz'], 7], ['get', 'label'], ''],
  7,
  ['case', ['<', ['get', 'lz'], 9], ['get', 'label'], ''],
  9,
  ['get', 'label'],
]

/** The overview layers, bottom to top (added above the basemap labels, below the open fire's markers). */
export function overviewLayers(theme: MapTheme): LayerSpecification[] {
  const p = theme === 'light' ? PALETTE.light : PALETTE.dark
  const tone = theme === 'light' ? 'light' : 'dark'
  const S = OVERVIEW_SOURCES
  const casing = (id: string, source: string, filter: Filter | null, extra: unknown): LayerSpecification =>
    ({
      id,
      type: 'circle',
      source,
      ...(filter ? { filter } : {}),
      layout: { 'circle-sort-key': ['get', 'sort'] },
      paint: {
        'circle-radius': zoomed(extra),
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': p.casing,
        'circle-stroke-width': 2,
        'circle-pitch-alignment': 'viewport',
      },
    }) as unknown as LayerSpecification
  const past = (id: string, source: string, filter: Filter | null): LayerSpecification =>
    ({
      id,
      type: 'circle',
      source,
      ...(filter ? { filter } : {}),
      layout: { 'circle-sort-key': ['get', 'sort'] },
      paint: {
        'circle-radius': zoomed(['get', 'r']),
        'circle-color': p.pastFill,
        'circle-stroke-color': p.pastRing,
        'circle-stroke-width': 1.6,
        'circle-pitch-alignment': 'viewport',
      },
    }) as unknown as LayerSpecification
  const live = (id: string, source: string, filter: Filter | null): LayerSpecification =>
    ({
      id,
      type: 'circle',
      source,
      ...(filter ? { filter } : {}),
      layout: { 'circle-sort-key': ['get', 'sort'] },
      paint: {
        // small active fires: a fixed dot without the white ring
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, ['case', ['get', 'small'], SMALL_DOT_PX, ['*', 0.6, ['+', ['get', 'r'], 1]]], 7, ['case', ['get', 'small'], SMALL_DOT_PX, ['+', ['get', 'r'], 1]]],
        'circle-color': p.liveFill,
        'circle-stroke-color': p.liveRing,
        'circle-stroke-width': ['case', ['get', 'small'], 0, 2],
        'circle-pitch-alignment': 'viewport',
      },
    }) as unknown as LayerSpecification
  const cluster = (id: string, source: string, active: boolean): LayerSpecification =>
    ({
      id,
      type: 'circle',
      source,
      filter: CLUSTERED,
      paint: {
        'circle-radius': CLUSTER_RADIUS_EXPR,
        'circle-color': active ? p.liveFill : p.groupPastFill,
        'circle-stroke-color': active ? p.liveRing : p.pastRing,
        'circle-stroke-width': active ? 2 : 1.6,
        'circle-pitch-alignment': 'viewport',
      },
    }) as unknown as LayerSpecification
  const count = (id: string, source: string, active: boolean): LayerSpecification =>
    ({
      id,
      type: 'symbol',
      source,
      filter: CLUSTERED,
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': FONT_BOLD,
        'text-size': 11,
        'text-allow-overlap': true,
      },
      paint: { 'text-color': active || tone === 'dark' ? '#ffffff' : p.ink, 'text-halo-color': active ? p.liveHalo : p.halo, 'text-halo-width': 1.1 },
    }) as unknown as LayerSpecification
  const hit = (id: string, source: string, filter: Filter | null): LayerSpecification =>
    ({
      // invisible touch target (>= 22 px across); queried by clicks and hovers only
      id,
      type: 'circle',
      source,
      ...(filter ? { filter } : {}),
      paint: { 'circle-radius': ['get', 'hit'], 'circle-color': '#000000', 'circle-opacity': 0, 'circle-pitch-alignment': 'viewport' },
    }) as unknown as LayerSpecification
  const label = (id: string, source: string, filter: Filter | null): LayerSpecification =>
    ({
      id,
      type: 'symbol',
      source,
      ...(filter ? { filter } : {}),
      layout: {
        'text-field': LABEL_TEXT,
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
    }) as unknown as LayerSpecification
  const chip = (id: string, source: string, filter: Filter): LayerSpecification =>
    ({
      // zoomed in near an unprepared fire: the prompt (on top: the labels avoid it); the controller limits it to the
      // fires near the view centre (chipTargets), none until then
      id,
      type: 'symbol',
      source,
      minzoom: CHIP_MINZOOM,
      filter,
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
    }) as unknown as LayerSpecification
  const chips = overviewFilters([])
  return [
    // other fires (not active): groups and single markers, below every active mark
    cluster(OVR.otherCluster, S.other, false),
    casing(OVR.otherCasing, S.other, SINGLE, ['+', ['get', 'r'], 0.8]),
    past(OVR.otherPoint, S.other, SINGLE),
    count(OVR.otherCount, S.other, false),
    // active fires
    cluster(OVR.activeCluster, S.active, true),
    casing(OVR.activeCasing, S.active, SINGLE, ['case', ['get', 'small'], SMALL_DOT_PX - 1, ['+', ['get', 'r'], 2]]),
    live(OVR.activePoint, S.active, SINGLE),
    count(OVR.activeCount, S.active, true),
    // pinned fires (never grouped): large active fires and the fire whose card is open
    casing(OVR.pinnedCasing, S.pinned, null, ['case', ['get', 'live'], ['+', ['get', 'r'], 2], ['+', ['get', 'r'], 0.8]]),
    past(OVR.pinnedPast, S.pinned, ['!', ['get', 'live']]),
    live(OVR.pinnedLive, S.pinned, ['get', 'live']),
    {
      // the fire whose card is open (filter set by the controller; it is always in the pinned source)
      id: OVR.selected,
      type: 'circle',
      source: S.pinned,
      filter: selectedFilter(null),
      paint: {
        'circle-radius': zoomed(['+', ['get', 'r'], 6]),
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': p.sel,
        'circle-stroke-width': 2.5,
        'circle-pitch-alignment': 'viewport',
      },
    } as unknown as LayerSpecification,
    hit(OVR.otherHit, S.other, SINGLE),
    hit(OVR.activeHit, S.active, SINGLE),
    hit(OVR.pinnedHit, S.pinned, null),
    // labels: the top layer is placed first, so pinned labels win collisions, then active, then other fires
    label(OVR.otherLabel, S.other, SINGLE),
    label(OVR.activeLabel, S.active, SINGLE),
    label(OVR.pinnedLabel, S.pinned, null),
    chip(OVR.otherChip, S.other, chips[OVR.otherChip]),
    chip(OVR.activeChip, S.active, chips[OVR.activeChip]),
    chip(OVR.pinnedChip, S.pinned, chips[OVR.pinnedChip]),
  ]
}
