// Focus by zooming (brief 2 decision 10; owner: map). In Public and Command the map itself decides which prepared fire
// is open: zooming in on one focuses it (useStore.focusIncidentFromMap, shell), zooming back out returns to the
// California overview. Focusing never moves the camera. Pure (focus.test.ts); MapController evaluates it once the
// camera has settled (moveend + FOCUS_DEBOUNCE_MS, never during a gesture or the opening flight).
//   enter  zoom >= FOCUS_IN_ZOOM: the prepared fire (a built bundle's area, list rows' bbox_lonlat) whose area meets
//          the central part of the view (CENTRAL_FRACTION of its width and height) and lies nearest the view centre.
//          Every prepared fire of the live, 2026 and 2025 lists can be focused, whatever the overview filter (which
//          only decides the markers and the panel list);
//   stay   the open fire stays while zoom >= FOCUS_OUT_ZOOM and its area (or, without one, its reported point) is in
//          view, unless the user panned it out of the central part onto another prepared fire that qualifies to enter,
//          or centred the view inside another prepared fire's area and outside the open fire's own area (neighbouring
//          fires' analysis areas overlap: Henderson and Norte);
//   leave  zoom < FOCUS_OUT_ZOOM, or the open fire left the view and no other fire qualifies: back to the overview.
// The gap between the two zoom thresholds and between "central part" (enter) and "in view" (stay) is the hysteresis:
// a fire never flaps on and off while the user zooms or pans around a threshold.
import type { IncidentSummary } from '../api/types'
import type { LonLatBox } from '../lib/fireBounds'

export const FOCUS_IN_ZOOM = 8.5
export const FOCUS_OUT_ZOOM = 7
/** Share of the view's width and height (around its centre) that counts as its central part. */
export const CENTRAL_FRACTION = 0.5
/** Wait this long after the camera settles before (re)focusing (a new move cancels it). */
export const FOCUS_DEBOUNCE_MS = 300

/** A prepared fire the map may focus: its analysis area. */
export interface FocusFire {
  id: string
  bbox: LonLatBox
}

/** The open fire (however it was opened): its area when known, else its reported point. */
export interface FocusCurrent {
  id: string
  bbox: LonLatBox | null
  point: [number, number] | null
}

export interface FocusView {
  zoom: number
  /** The view centre (the camera centre: the middle of the visible map area). */
  center: [number, number]
  /** The visible map area. */
  view: LonLatBox
  /** Its central part. */
  central: LonLatBox
}

const validBox = (b: unknown): b is LonLatBox =>
  Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && Number.isFinite(v)) && b[2] > b[0] && b[3] > b[1]

export function boxesIntersect(a: LonLatBox, b: LonLatBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

export function boxContains(b: LonLatBox, p: [number, number]): boolean {
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]
}

/** Approximate distance (km) from a point to a box (0 inside it); equirectangular, fine at fire scale. */
export function distanceToBoxKm(p: [number, number], b: LonLatBox): number {
  const kx = 111.32 * Math.cos((p[1] * Math.PI) / 180)
  const dx = p[0] < b[0] ? b[0] - p[0] : p[0] > b[2] ? p[0] - b[2] : 0
  const dy = p[1] < b[1] ? b[1] - p[1] : p[1] > b[3] ? p[1] - b[3] : 0
  return Math.hypot(dx * kx, dy * 110.57)
}

function distanceToCenterKm(p: [number, number], b: LonLatBox): number {
  const kx = 111.32 * Math.cos((p[1] * Math.PI) / 180)
  return Math.hypot(((b[0] + b[2]) / 2 - p[0]) * kx, ((b[1] + b[3]) / 2 - p[1]) * 110.57)
}

/** The central part of a view box (a 2D helper; the controller unprojects the screen's central rectangle in 3D). */
export function centralBox(view: LonLatBox, center: [number, number], fraction = CENTRAL_FRACTION): LonLatBox {
  const hw = ((view[2] - view[0]) * fraction) / 2
  const hh = ((view[3] - view[1]) * fraction) / 2
  return [center[0] - hw, center[1] - hh, center[0] + hw, center[1] + hh]
}

/** Every prepared fire the map may focus: all three incident lists, whatever the overview filter (a fire listed in
 *  several lists counts once). */
export function allFocusCandidates(catalog: {
  live: readonly Pick<IncidentSummary, 'id' | 'bundle_status' | 'bbox_lonlat'>[]
  season: readonly Pick<IncidentSummary, 'id' | 'bundle_status' | 'bbox_lonlat'>[]
  historical: readonly Pick<IncidentSummary, 'id' | 'bundle_status' | 'bbox_lonlat'>[]
}): FocusFire[] {
  return focusCandidates([...catalog.live, ...catalog.season, ...catalog.historical])
}

/** Prepared fires with an area, from list rows (built bundles only carry bbox_lonlat). */
export function focusCandidates(rows: readonly Pick<IncidentSummary, 'id' | 'bundle_status' | 'bbox_lonlat'>[]): FocusFire[] {
  const out: FocusFire[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (r.bundle_status !== 'ready' || !validBox(r.bbox_lonlat) || seen.has(r.id)) continue
    seen.add(r.id)
    out.push({ id: r.id, bbox: r.bbox_lonlat })
  }
  return out
}

/** The prepared fire nearest the view centre among those meeting its central part (deterministic ties). */
export function nearestCentral(v: FocusView, fires: readonly FocusFire[]): FocusFire | null {
  let best: FocusFire | null = null
  let bd = Infinity
  let bc = Infinity
  for (const f of fires) {
    if (!boxesIntersect(f.bbox, v.central)) continue
    const d = distanceToBoxKm(v.center, f.bbox)
    const c = distanceToCenterKm(v.center, f.bbox)
    if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && (c < bc - 1e-9 || (Math.abs(c - bc) <= 1e-9 && best != null && f.id < best.id)))) {
      best = f
      bd = d
      bc = c
    }
  }
  return best
}

/** The "Spread not prepared yet" chip shows from this zoom, for unprepared fires near the view centre. */
export const CHIP_ZOOM = 9
/** At most this many chips at once. */
export const CHIP_MAX = 2

/** Unprepared fires zoomed in on (reported point in the central part of the view, zoom >= CHIP_ZOOM), nearest the
 *  centre first: the ones that get the chip. */
export function chipTargets(
  v: FocusView,
  rows: readonly Pick<IncidentSummary, 'id' | 'bundle_status' | 'lon' | 'lat'>[],
  hidden: readonly string[] = [],
  max = CHIP_MAX,
): string[] {
  if (!(v.zoom >= CHIP_ZOOM)) return []
  const out: { id: string; d: number }[] = []
  for (const r of rows) {
    if (r.bundle_status === 'ready' || hidden.includes(r.id) || !Number.isFinite(r.lon) || !Number.isFinite(r.lat)) continue
    const p: [number, number] = [r.lon, r.lat]
    if (!boxContains(v.central, p)) continue
    out.push({ id: r.id, d: distanceToBoxKm(v.center, [r.lon, r.lat, r.lon, r.lat]) })
  }
  out.sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))
  return out.slice(0, max).map((x) => x.id)
}

/** Showing an official area (a `MapFlyTo` with `source: 'official'`: an evacuation zone, an NWS alert's zones) must not
 *  change which fire is open, however close another prepared fire is: fitting Henderson's Orange County zone must not
 *  focus the Norte Fire it touches, nor return to the overview. The focus rule is held from that flight until the user
 *  moves the map again (a gesture or the zoom buttons), another explicit flight or framing, or the open fire changes.
 *  Orbit moves (rotate, tilt, north up) keep the hold. */
export class FocusHold {
  private held = false
  /** The focus rule is held: keep what is open. */
  get active(): boolean {
    return this.held
  }
  /** An explicit map flight starts: an official one holds the focus, any other releases it. */
  flight(source: string | null | undefined): void {
    this.held = source === 'official'
  }
  /** The user moved the map, the map was framed, or the open fire changed. */
  release(): void {
    this.held = false
  }
}

/** focusTarget, unless the focus is held (FocusHold): then what is open stays (an id, or null on the overview). */
export function focusUnlessHeld(v: FocusView, fires: readonly FocusFire[], current: FocusCurrent | null, hold: Pick<FocusHold, 'active'>): string | null {
  return hold.active ? (current?.id ?? null) : focusTarget(v, fires, current)
}

/** Which fire the map should have open for this view: an id, or null for the overview (see the header). */
export function focusTarget(v: FocusView, fires: readonly FocusFire[], current: FocusCurrent | null): string | null {
  if (!(v.zoom >= FOCUS_OUT_ZOOM)) return null
  const best = v.zoom >= FOCUS_IN_ZOOM ? nearestCentral(v, fires) : null
  if (current) {
    const inView = current.bbox ? boxesIntersect(current.bbox, v.view) : current.point ? boxContains(v.view, current.point) : false
    if (inView) {
      const central = current.bbox ? boxesIntersect(current.bbox, v.central) : current.point ? boxContains(v.central, current.point) : false
      if (!best || best.id === current.id) return current.id
      // the view is centred on another prepared fire's area, away from the open fire's own area: that fire is meant
      const centredOnOther = boxContains(best.bbox, v.center) && !(current.bbox && boxContains(current.bbox, v.center))
      if (central && !centredOnOther) return current.id
      return best.id
    }
  }
  return best?.id ?? null
}
