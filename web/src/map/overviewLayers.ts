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
// Active and other fires never share a group, and active marks draw above other fires.
// Brief 4 (H3, HANDOFF "Fire markers", PLAN-4 decision e): every marker is a transparent circle (fill #ff8a3c at 10 %,
// a 1-1.2 px #ffc08a ring at 80 %) with a white-hot centre dot (#fff3dc); its size says its type, not its acreage:
// a small active fire (under 10 acres or no size reported) r7, an active fire r11, a large active fire (5,000 acres or
// more, the pinned ones) r15, a fire that is not active a hollow #f0d9b0 ring r4.5. A group is sized by how many
// fires it holds, 10 + 4.2·√n px capped at 36, with "28 FIRES" at its upper right after a short tick (MapLibre text:
// OpenFreeMap's glyphs have Noto Sans only). Sizes stay at the national zoom and grow to 1.2x by z10; a faint dark
// casing keeps the thin rings readable over bright photos.
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
  otherClusterDot: 'fx-overview-other-cluster-dot',
  otherCasing: 'fx-overview-other-casing',
  otherPoint: 'fx-overview-other-point',
  otherCount: 'fx-overview-other-count',
  activeCluster: 'fx-overview-active-cluster',
  activeClusterDot: 'fx-overview-active-cluster-dot',
  activeCasing: 'fx-overview-active-casing',
  activePoint: 'fx-overview-active-point',
  activeDot: 'fx-overview-active-dot',
  activeCount: 'fx-overview-active-count',
  pinnedCasing: 'fx-overview-pinned-casing',
  pinnedPast: 'fx-overview-pinned-past',
  pinnedLive: 'fx-overview-pinned-live',
  pinnedDot: 'fx-overview-pinned-dot',
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
  // the chips of the other fires near the view centre (chipTargets after the first): placed after the first fire's
  // chip, never over it (final fixes R8)
  otherChipNext: 'fx-overview-other-chip-next',
  activeChipNext: 'fx-overview-active-chip-next',
  pinnedChipNext: 'fx-overview-pinned-chip-next',
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
/** The "Spread not prepared yet" chips: the first target's (the fire nearest the view centre) and the others'. */
export const OVERVIEW_CHIP_LAYERS: readonly string[] = [OVR.pinnedChip, OVR.activeChip, OVR.otherChip, OVR.pinnedChipNext, OVR.activeChipNext, OVR.otherChipNext]
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
/** Marker radius by type (px, at z7 and wider; brief 4, HANDOFF): small active, active, large active (pinned), other. */
export const MARKER_PX = { small: 7, active: 11, large: 15, other: 4.5 } as const
export type MarkerKind = keyof typeof MARKER_PX
/** The white-hot centre dot's radius by type (px); fires that are not active have none (a hollow ring). */
export const DOT_PX = { small: 1.4, active: 2.2, large: 2.8, other: 0 } as const
/** Marker radius range (px). */
export const MARKER_MIN_PX = MARKER_PX.other
export const MARKER_MAX_PX = MARKER_PX.large
/** A group's radius: 10 + 4.2·√n px (HANDOFF; decision e), at most 36 px; its centre dot. */
export const GROUP_BASE_PX = 10
export const GROUP_PER_SQRT_PX = 4.2
export const GROUP_MAX_PX = 36
export const GROUP_DOT_PX = 2.6
/** Markers grow to this factor by z10 (no shrink at the national zoom of a desktop screen, about z3.9). */
export const ZOOM_GROWTH = 1.2
/** A phone shows the lower 48 at about z2: markers and groups are this much smaller there (full size from z3.5), so a
 *  group's circle does not cover a whole region of the country. */
export const SMALL_MAP_SCALE = 0.65
export const SMALL_MAP_ZOOM = 2
export const FULL_SIZE_ZOOM = 3.5
/** Smallest hit radius (px): a 22 px touch target. */
export const HIT_MIN_PX = 11

const HA_PER_ACRE = 0.40468564224

/** A fire's marker type (brief 4): not active → other; active under 10 acres or no size → small; active of 5,000
 *  acres or more → large (never grouped); else active. */
export function markerKind(s: Pick<IncidentSummary, 'mode' | 'is_active' | 'acres'>): MarkerKind {
  if (!isActiveFire(s)) return 'other'
  const a = acresOf(s)
  if (a < SMALL_MAX_ACRES) return 'small'
  return a >= PINNED_MIN_ACRES ? 'large' : 'active'
}

/** A marker's radius (px, at z7 and wider) by its type. */
export function markerRadius(s: Pick<IncidentSummary, 'mode' | 'is_active' | 'acres'>): number {
  return MARKER_PX[markerKind(s)]
}

/** A group's radius (px) for `n` fires: 10 + 4.2·√n, at most 36. */
export function groupRadius(n: number): number {
  const c = Number.isFinite(n) && n > 0 ? n : 0
  return Math.round(Math.min(GROUP_MAX_PX, GROUP_BASE_PX + GROUP_PER_SQRT_PX * Math.sqrt(c)) * 10) / 10
}

/** "Garnet · 59,844 ac" ("· 24,218 ha" in metric); the trailing " Fire" is left out to keep labels short; names stay
 *  verbatim otherwise ("Fd140011"). */
export function overviewLabel(name: string, acres: number | null | undefined, units: Units): string {
  const short = name.replace(/\s+fire$/i, '').trim() || name
  if (typeof acres !== 'number' || !Number.isFinite(acres) || acres <= 0) return short
  const v = units === 'metric' ? acres * HA_PER_ACRE : acres
  // small fires keep one decimal, as the fire card does ("Hulsey Bench · 0.1 ac", never "0 ac"; integration part 2)
  const n = v < 0.1 ? 'under 0.1' : v < 10 ? Number(v.toFixed(1)).toLocaleString('en-US') : Math.round(v).toLocaleString('en-US')
  return `${short} · ${n} ${units === 'metric' ? 'ha' : 'ac'}`
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

/** Where a fire lies across the lower 48, for the label anchors of a narrow map at the national zoom: far west
 *  (California, Oregon and Washington coasts), west, centre, east, far east. */
export type LabelSide = 'ww' | 'w' | 'c' | 'e' | 'ee'
export function labelSide(lon: number): LabelSide {
  if (lon < -116) return 'ww'
  if (lon < -105) return 'w'
  if (lon > -76) return 'ee'
  if (lon > -87) return 'e'
  return 'c'
}

/** A narrow map (a phone, under NARROW_PX) below this zoom shows most of the lower 48 across its width. */
export const NARROW_LABEL_MAX_ZOOM = 3
type Anchor = 'top' | 'bottom' | 'left' | 'right'
/** The label anchors tried, in order (MapLibre: 'left' puts the text to the right of the point). Everywhere but a
 *  narrow map's national view: below, above, left, right of the marker. There, a label grows towards the middle of
 *  the country, so a west-coast fire's label never runs off the screen's left edge (and an east-coast one off its
 *  right edge): a label that does not fit that way is left out, as any colliding label is. */
export const LABEL_ANCHORS: Readonly<Record<LabelSide, readonly Anchor[]>> = {
  ww: ['left'],
  w: ['left', 'top', 'bottom'],
  c: ['top', 'bottom', 'right', 'left'],
  e: ['right', 'top', 'bottom'],
  ee: ['right'],
}
/** The label's distance from the marker centre (ems) for a marker radius `r` (px), as the radial offset gives it. */
export const labelOffsetEm = (r: number): number => 0.45 + r / 12
/** MapLibre's anchor-offset list ("top", [0, 1.2], …) for some anchors at one marker radius. */
export function anchorOffsets(anchors: readonly Anchor[], r: number): (Anchor | [number, number])[] {
  const d = Math.round(labelOffsetEm(r) * 1000) / 1000
  const off: Record<Anchor, [number, number]> = { top: [0, d], bottom: [0, -d], left: [d, 0], right: [-d, 0] }
  return anchors.flatMap((a) => [a, off[a]])
}
/** `text-variable-anchor-offset` of a narrow map's labels: below NARROW_LABEL_MAX_ZOOM by the fire's `side`, else the
 *  default anchors; the offset follows the marker radius `r` as `text-radial-offset` does on wide maps. */
export function narrowLabelAnchorOffset(): unknown {
  const forSide = (side: LabelSide) => [
    'interpolate',
    ['linear'],
    ['get', 'r'],
    MARKER_MIN_PX,
    ['literal', anchorOffsets(LABEL_ANCHORS[side], MARKER_MIN_PX)],
    MARKER_MAX_PX,
    ['literal', anchorOffsets(LABEL_ANCHORS[side], MARKER_MAX_PX)],
  ]
  const bySide = ['match', ['get', 'side'], 'ww', forSide('ww'), 'w', forSide('w'), 'e', forSide('e'), 'ee', forSide('ee'), forSide('c')]
  return ['step', ['zoom'], bySide, NARROW_LABEL_MAX_ZOOM, forSide('c')]
}

/** One point feature per fire (agency coordinates); `pinned` features are labelled at every zoom. */
export function overviewFeatures(fires: readonly IncidentSummary[], units: Units, o: { pinned?: boolean } = {}): FeatureCollection {
  const features: Feature<Geometry>[] = []
  fires.forEach((s, i) => {
    if (!validPoint(s)) return
    const live = isActiveFire(s)
    const small = isSmallActive(s)
    const kind = markerKind(s)
    const r = MARKER_PX[kind]
    features.push({
      type: 'Feature',
      id: i,
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: {
        id: s.id,
        name: s.name,
        live,
        small: small && !o.pinned,
        kind,
        acres: acresOf(s),
        r,
        dot: DOT_PX[kind],
        hit: Math.max(HIT_MIN_PX, r + 3),
        sort: sortKey(s),
        lz: labelMinZoom(s, o.pinned),
        label: overviewLabel(s.name, s.acres, units),
        ready: s.bundle_status === 'ready',
        chip: chipText(s.bundle_status),
        start: s.started_ms,
        state: s.state ?? '',
        side: labelSide(s.lon),
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

/** Marker colours (brief 4, HANDOFF): the dark and aerial maps use the screens' values; the light road map darker
 *  equivalents so the thin rings still read. Mirrored by the legend's swatches (map/map.css .fxm-sw-*). */
export const PALETTE = {
  dark: {
    casing: 'rgba(5,7,3,0.38)',
    fill: 'rgba(255,138,60,0.10)',
    ring: 'rgba(255,192,138,0.8)',
    dot: '#fff3dc',
    otherRing: 'rgba(240,217,176,0.8)',
    // groups of fires that are not active: quieter than the active ones (the 2026 season lists about 1,200 of them)
    otherGroupRing: 'rgba(240,217,176,0.5)',
    otherFill: 'rgba(240,217,176,0.05)',
    otherDot: 'rgba(240,217,176,0.9)',
    count: '#ffe3bd',
    countUnit: '#ffb27a',
    otherCount: '#f0d9b0',
    tick: 'fx-group-tick-dark',
    ink: '#f0f0f0',
    halo: 'rgba(5,7,3,0.85)',
    sel: '#ffffff',
  },
  light: {
    casing: 'rgba(255,255,255,0.7)',
    fill: 'rgba(234,88,12,0.14)',
    ring: 'rgba(194,65,12,0.9)',
    dot: '#7c2d12',
    otherRing: 'rgba(133,92,20,0.9)',
    otherGroupRing: 'rgba(133,92,20,0.6)',
    otherFill: 'rgba(133,92,20,0.06)',
    otherDot: 'rgba(133,92,20,0.9)',
    count: '#7c2d12',
    countUnit: '#9a3412',
    otherCount: '#6b4a12',
    tick: 'fx-group-tick-light',
    ink: '#16202b',
    halo: 'rgba(255,255,255,0.95)',
    sel: '#16202b',
  },
} as const

/** The short tick between a group's circle and its "N FIRES" label (an icon image: device pixels at pixelRatio 2). */
export const GROUP_TICK_IMAGE: Record<'dark' | 'light', string> = { dark: PALETTE.dark.tick, light: PALETTE.light.tick }
export const GROUP_TICK_PX = { w: 6, h: 2 } as const
export function groupTickImage(theme: 'dark' | 'light'): { image: { width: number; height: number; data: Uint8Array }; options: { pixelRatio: number } } {
  const w = GROUP_TICK_PX.w * 2
  const h = GROUP_TICK_PX.h * 2
  const data = new Uint8Array(w * h * 4)
  const c = theme === 'dark' ? [255, 178, 122, 180] : [154, 52, 18, 220]
  // one 0.8 px line (two device rows at half strength) across the image
  for (let x = 0; x < w; x++)
    for (const y of [1, 2]) {
      const i = (y * w + x) * 4
      data[i] = c[0]
      data[i + 1] = c[1]
      data[i + 2] = c[2]
      data[i + 3] = Math.round(c[3] * (y === 1 ? 0.8 : 0.5))
    }
  return { image: { width: w, height: h, data }, options: { pixelRatio: 2 } }
}

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

/** The chip layers' filters: only `chips` (map/focus.ts chipTargets: unprepared fires zoomed in on, nearest the view
 *  centre first). The first chip (the fire the user is looking at) is always drawn; the others' layers are placed
 *  after it and give way (final fixes R8: two nearby chips overlapped and one read "…nalysis (1-3 min)"). */
export function overviewFilters(chips: readonly string[] = []): Record<string, Filter> {
  const only = (ids: readonly string[]) => ['all', ['!=', ['get', 'chip'], ''], ['in', ['get', 'id'], ['literal', [...ids]]]]
  const first = only(chips.slice(0, 1))
  const next = only(chips.slice(1))
  return {
    [OVR.pinnedChip]: first,
    [OVR.activeChip]: ['all', SINGLE, first],
    [OVR.otherChip]: ['all', SINGLE, first],
    [OVR.pinnedChipNext]: next,
    [OVR.activeChipNext]: ['all', SINGLE, next],
    [OVR.otherChipNext]: ['all', SINGLE, next],
  }
}

/** Where a chip of a fire after the first may go, in order: below its marker (as the first chip), above, right, left;
 *  `text-variable-anchor-offset` in ems (the chip is two lines of about 13 ems). */
export const CHIP_NEXT_ANCHORS: unknown[] = ['top', [0, 1.9], 'bottom', [0, -1.9], 'left', [1.4, 0], 'right', [-1.4, 0]]

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
  for (const id of [OVR.activeDot, OVR.pinnedDot, OVR.activeClusterDot, OVR.otherClusterDot]) out[id] = { 'circle-opacity': o }
  for (const id of [OVR.otherCount, OVR.activeCount, ...OVERVIEW_LABEL_LAYERS]) out[id] = { 'text-opacity': t, 'icon-opacity': t }
  for (const id of OVERVIEW_LABEL_LAYERS) out[id] = { 'text-opacity': t }
  return out
}

/** A radius that keeps its size at the national zoom and grows to 1.2x by z10; smaller on a phone's national view
 *  (top-level zoom interpolation, as MapLibre requires). */
const zoomed = (r: unknown): unknown => ['interpolate', ['linear'], ['zoom'], SMALL_MAP_ZOOM, ['*', SMALL_MAP_SCALE, r], FULL_SIZE_ZOOM, r, 7, r, 10, ['*', ZOOM_GROWTH, r]]

/** A group's radius from how many fires it holds (HANDOFF, decision e): 10 + 4.2·√n px, at most 36. */
const GROUP_R: unknown = ['min', GROUP_MAX_PX, ['+', GROUP_BASE_PX, ['*', GROUP_PER_SQRT_PX, ['sqrt', ['to-number', ['get', 'point_count'], 0]]]]]
/** The same, smaller on a phone's national view (groups exist up to z7 only). */
export const CLUSTER_RADIUS_EXPR: unknown = ['interpolate', ['linear'], ['zoom'], SMALL_MAP_ZOOM, ['*', SMALL_MAP_SCALE, GROUP_R], FULL_SIZE_ZOOM, GROUP_R]
/** The group label's size (px) and its unit's scale ("28" then "FIRES" smaller, as the screen's 13 / 8 px). */
export const GROUP_LABEL_PX = 13
export const GROUP_UNIT_SCALE = 0.62
/** Group sizes sampled for the label offsets (MapLibre cannot build an array from an expression; an interpolation
 *  between these counts follows 10 + 4.2·√n within a fraction of a pixel up to the 36 px cap at n ≈ 38). */
const GROUP_SAMPLES = [2, 3, 4, 5, 6, 8, 10, 13, 17, 22, 28, 34, 39]
/** An offset that follows the group's radius: `f(r)` evaluated at the sampled counts, at the phone's smaller scale up
 *  to SMALL_MAP_ZOOM and at full size from FULL_SIZE_ZOOM (as CLUSTER_RADIUS_EXPR). */
function byGroupRadius(f: (r: number) => [number, number]): unknown {
  const at = (scale: number) => ['interpolate', ['linear'], ['to-number', ['get', 'point_count'], 0], ...GROUP_SAMPLES.flatMap((n) => [n, ['literal', f(groupRadius(n) * scale).map((v) => Math.round(v * 1000) / 1000)]])]
  return ['interpolate', ['linear'], ['zoom'], SMALL_MAP_ZOOM, at(SMALL_MAP_SCALE), FULL_SIZE_ZOOM, at(1)]
}
/** The tick's start (px): the circle's upper-right edge at 45°. */
export const GROUP_TICK_OFFSET: unknown = byGroupRadius((r) => [r * Math.SQRT1_2, -r * Math.SQRT1_2])
/** The label's bottom-left corner (ems of GROUP_LABEL_PX): just past the tick's end. */
export const GROUP_TEXT_OFFSET: unknown = byGroupRadius((r) => [(r * Math.SQRT1_2 + GROUP_TICK_PX.w + 1) / GROUP_LABEL_PX, (-r * Math.SQRT1_2 + 3) / GROUP_LABEL_PX])
/** "28 FIRES": the count, then the unit in a smaller size and its own colour. */
export function groupLabelText(unitColor: string): unknown {
  return ['format', ['get', 'point_count_abbreviated'], {}, ' FIRES', { 'font-scale': GROUP_UNIT_SCALE, 'text-color': unitColor }]
}

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
export function overviewLayers(theme: MapTheme, o: { narrow?: boolean } = {}): LayerSpecification[] {
  const p = theme === 'light' ? PALETTE.light : PALETTE.dark
  const tone = theme === 'light' ? 'light' : 'dark'
  const S = OVERVIEW_SOURCES
  const circle = (id: string, source: string, filter: Filter | null, paint: Record<string, unknown>, sortKey = true): LayerSpecification =>
    ({
      id,
      type: 'circle',
      source,
      ...(filter ? { filter } : {}),
      ...(sortKey ? { layout: { 'circle-sort-key': ['get', 'sort'] } } : {}),
      paint: { 'circle-pitch-alignment': 'viewport', ...paint },
    }) as unknown as LayerSpecification
  // a faint dark ring just outside the marker's own ring: thin rings stay readable over bright photos
  const casing = (id: string, source: string, filter: Filter | null) =>
    circle(id, source, filter, { 'circle-radius': zoomed(['+', ['get', 'r'], 1.1]), 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': p.casing, 'circle-stroke-width': 1.4 })
  // a fire that is not active: a hollow ring
  const past = (id: string, source: string, filter: Filter | null) =>
    circle(id, source, filter, { 'circle-radius': zoomed(['get', 'r']), 'circle-color': p.otherFill, 'circle-stroke-color': p.otherRing, 'circle-stroke-width': 1.2 })
  // an active fire: the transparent orange circle (its centre dot is the next layer)
  const live = (id: string, source: string, filter: Filter | null) =>
    circle(id, source, filter, {
      'circle-radius': zoomed(['get', 'r']),
      'circle-color': p.fill,
      'circle-stroke-color': p.ring,
      'circle-stroke-width': ['case', ['==', ['get', 'kind'], 'large'], 1.2, 1],
    })
  const dot = (id: string, source: string, filter: Filter | null) =>
    circle(id, source, filter, { 'circle-radius': zoomed(['get', 'dot']), 'circle-color': p.dot })
  const cluster = (id: string, source: string, active: boolean) =>
    circle(
      id,
      source,
      CLUSTERED,
      { 'circle-radius': CLUSTER_RADIUS_EXPR, 'circle-color': active ? p.fill : p.otherFill, 'circle-stroke-color': active ? p.ring : p.otherGroupRing, 'circle-stroke-width': 1.2 },
      false,
    )
  const clusterDot = (id: string, source: string, active: boolean) =>
    circle(id, source, CLUSTERED, { 'circle-radius': active ? GROUP_DOT_PX : GROUP_DOT_PX - 0.6, 'circle-color': active ? p.dot : p.otherDot }, false)
  const count = (id: string, source: string, active: boolean): LayerSpecification =>
    ({
      // "28 FIRES" at the group's upper right, after a short tick from its edge (the screen's mono label; MapLibre
      // draws Noto Sans, the only family OpenFreeMap serves)
      id,
      type: 'symbol',
      source,
      filter: CLUSTERED,
      layout: {
        'text-field': groupLabelText(active ? p.countUnit : p.otherCount),
        'text-font': FONT_BOLD,
        'text-size': GROUP_LABEL_PX,
        'text-anchor': 'bottom-left',
        'text-offset': GROUP_TEXT_OFFSET,
        'text-letter-spacing': 0.04,
        'icon-image': p.tick,
        'icon-anchor': 'left',
        'text-allow-overlap': true,
        'icon-allow-overlap': true,
        'text-ignore-placement': true,
        'icon-ignore-placement': true,
        // both start at the circle's upper-right edge (45°): the tick there, the text just past its end
        'icon-offset': GROUP_TICK_OFFSET,
      },
      paint: {
        'text-color': active ? p.count : p.otherCount,
        'text-halo-color': p.halo,
        'text-halo-width': 1.4,
      },
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
        'text-variable-anchor': [...LABEL_ANCHORS.c],
        'text-radial-offset': ['+', 0.45, ['/', ['get', 'r'], 12]],
        // a narrow map's national view: labels grow towards the middle of the country (takes over the two above)
        ...(o.narrow ? { 'text-variable-anchor-offset': narrowLabelAnchorOffset() } : {}),
        'text-justify': 'auto',
        'text-max-width': 14,
        'text-allow-overlap': false,
        'text-optional': true,
        'symbol-sort-key': ['-', 0, ['get', 'sort']],
        'text-padding': 3,
      },
      paint: { 'text-color': p.ink, 'text-halo-color': p.halo, 'text-halo-width': 1.6, 'text-halo-blur': 0.3 },
    }) as unknown as LayerSpecification
  const chip = (id: string, source: string, filter: Filter, next = false): LayerSpecification =>
    ({
      // zoomed in near an unprepared fire: the prompt (on top: the labels avoid it); the controller limits it to the
      // fires near the view centre (chipTargets), none until then. The first fire's chip is always drawn and still
      // claims its place; a later fire's chip moves around its marker to a free place, else waits (final fixes R8)
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
        ...(next ? { 'text-variable-anchor-offset': CHIP_NEXT_ANCHORS, 'text-padding': 4 } : { 'text-anchor': 'top', 'text-offset': [0, 1.9] }),
        // two short lines rather than one wide pill (it must fit beside a phone's edge)
        'text-max-width': 13,
        'text-line-height': 1.25,
        'icon-allow-overlap': !next,
        'text-allow-overlap': !next,
      },
      paint: { 'text-color': tone === 'light' ? '#16202b' : '#f3f6f9' },
    }) as unknown as LayerSpecification
  const chips = overviewFilters([])
  return [
    // other fires (not active): groups and single hollow rings, below every active mark
    cluster(OVR.otherCluster, S.other, false),
    clusterDot(OVR.otherClusterDot, S.other, false),
    casing(OVR.otherCasing, S.other, SINGLE),
    past(OVR.otherPoint, S.other, SINGLE),
    count(OVR.otherCount, S.other, false),
    // active fires
    cluster(OVR.activeCluster, S.active, true),
    clusterDot(OVR.activeClusterDot, S.active, true),
    casing(OVR.activeCasing, S.active, SINGLE),
    live(OVR.activePoint, S.active, SINGLE),
    dot(OVR.activeDot, S.active, SINGLE),
    count(OVR.activeCount, S.active, true),
    // pinned fires (never grouped): large active fires and the fire whose card is open
    casing(OVR.pinnedCasing, S.pinned, null),
    past(OVR.pinnedPast, S.pinned, ['!', ['get', 'live']]),
    live(OVR.pinnedLive, S.pinned, ['get', 'live']),
    dot(OVR.pinnedDot, S.pinned, ['get', 'live']),
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
    // the chips of the fires after the first, then the first fire's on top: the top layers are placed first, so the
    // first chip claims its place and the others give way to it
    chip(OVR.otherChipNext, S.other, chips[OVR.otherChipNext], true),
    chip(OVR.activeChipNext, S.active, chips[OVR.activeChipNext], true),
    chip(OVR.pinnedChipNext, S.pinned, chips[OVR.pinnedChipNext], true),
    chip(OVR.otherChip, S.other, chips[OVR.otherChip]),
    chip(OVR.activeChip, S.active, chips[OVR.activeChip]),
    chip(OVR.pinnedChip, S.pinned, chips[OVR.pinnedChip]),
  ]
}
