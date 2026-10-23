// Deterministic opening camera (brief 2, O-R4; owner: map). Pure: MapController feeds it what happened (incident
// changes, data that became ready, moves that ended, user input) and does what it answers (issue a fit). The audit
// (audit-2 opening-map G2) reproduced three causes of "the same link opens different views":
//   1. the first selection (null -> id) was treated as a switch, so a deep-linked or restored view was discarded;
//   2. the camera moved in stages as data arrived (z5 placeholder -> reported point -> analysis area);
//   3. a fire was marked framed before its fit ran, so any other camera call during the flight left it off target.
// Rules here:
//   - null -> id is a first load: a view restored at mount (deep link ?view=, workspace hand-off) is kept;
//   - one flight per target, issued when its goal is ready (goalFor: the ready bundle's fire bounds once the fire
//     rasters are in, a building bundle's grid, or the agency's point and acreage for a fire without a bundle);
//   - a target counts as framed only when its fit completes (the camera reached the fit's camera);
//   - a fit that a non-user call interrupts is issued again (at most MAX_REISSUES times); a user gesture or an
//     explicit navigation request (search, feed item, fire card, "Incident") ends the opening framing;
//   - a provisional goal (point / acreage estimate, building bundle) is replaced by a better one only while the user
//     has not moved the camera;
//   - a fire focused by the map itself (zooming in on it, decision 10) or the overview reached by zooming out is never
//     framed: the camera stays where the user put it (setTarget with keepCamera).
import type { IncidentManifest, IncidentSummary, Perimeter } from '../api/types'
import { fireBounds, type FireRaster, type LonLatBox } from '../lib/fireBounds'

/** The lower 48 states, [w, s, e, n] (brief 3, CONTRACT §14.11): the overview's frame. Alaska, Hawaii and the
 *  territories are not supported yet. */
export const LOWER48_BOUNDS: LonLatBox = [-124.85, 24.4, -66.89, 49.38]
/** Where the map starts before anything is framed: the middle of the lower 48, about z3 (§14.11). */
export const LOWER48_START = { lon: -98.6, lat: 39.8, zoom: 3 } as const

/** Re-issue an interrupted fit at most this many times (guards against a camera that can never match exactly). */
export const MAX_REISSUES = 4

export type FramingPhase =
  /** nothing to frame */
  | 'idle'
  /** the target is known; its goal is not ready yet */
  | 'waiting'
  /** a fit was issued and has not completed */
  | 'flying'
  /** the target was framed (its fit completed) or a restored view was kept */
  | 'done'
  /** the user took the camera: never re-framed for this target */
  | 'user'

export interface CameraPose {
  lon: number
  lat: number
  zoom: number
  bearing: number
  pitch: number
}

export interface FrameGoal {
  /** Identifies what the goal was computed from; a provisional goal is replaced when the key changes. */
  key: string
  kind: 'overview' | 'fire' | 'area'
  /** Point / acreage estimate or a building bundle: better data may re-frame while the user has not moved. */
  provisional: boolean
  /** Fit these bounds ... */
  bounds?: LonLatBox
  /** ... or go to this view (the overview as the user left it). */
  view?: { lon: number; lat: number; zoom: number }
}

/** What the controller must do: issue (or re-issue) a fit to `goal`. */
export interface FitCommand {
  type: 'fit'
  goal: FrameGoal
  reissue: boolean
}

export interface FramingInit {
  incidentId: string | null
  /** A view was restored at mount (workspace view: deep link or hand-off). */
  restoredView: boolean
  /** The incident named in the address bar at mount (?incident=). */
  urlIncident: string | null
}

/** Do two camera poses match (the fit completed)? Tolerances are loose on purpose: an interrupted flight stops far
 *  off target, while terrain settling may nudge a completed one slightly. */
export function poseMatches(a: CameraPose, b: CameraPose): boolean {
  const z = Math.max(a.zoom, b.zoom)
  // Web Mercator distance in CSS pixels at the larger zoom (512 px world)
  const world = 512 * Math.pow(2, z)
  const mx = (lon: number) => (180 + lon) / 360
  const my = (lat: number) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360
  const dx = (mx(a.lon) - mx(b.lon)) * world
  const dy = (my(a.lat) - my(b.lat)) * world
  const db = Math.abs((((a.bearing - b.bearing) % 360) + 540) % 360 - 180)
  return Math.hypot(dx, dy) <= 24 && Math.abs(a.zoom - b.zoom) <= 0.15 && db <= 2 && Math.abs(a.pitch - b.pitch) <= 2
}

/** Zoom that fits `bounds` into a width x height px viewport with `margin` px on each side (MapLibre's 512 px world);
 *  the fallback when MapLibre's cameraForBounds cannot fit (it returns undefined when padding leaves no room). */
export function zoomForBounds(bounds: LonLatBox, width: number, height: number, margin = 0, maxZoom = 22): number {
  const [w, s, e, n] = bounds
  const my = (lat: number) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360
  const dx = Math.max(1e-9, (e - w) / 360)
  const dy = Math.max(1e-9, my(s) - my(n))
  const aw = Math.max(1, width - 2 * margin)
  const ah = Math.max(1, height - 2 * margin)
  const z = Math.log2(Math.min(aw / (dx * 512), ah / (dy * 512)))
  return Math.max(0, Math.min(maxZoom, z))
}

/** Centre of a lon/lat box (Mercator-correct latitude). */
export function boundsCenter(b: LonLatBox): [number, number] {
  const my = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  const lat = ((2 * Math.atan(Math.exp((my(b[1]) + my(b[3])) / 2)) - Math.PI / 2) * 180) / Math.PI
  return [(b[0] + b[2]) / 2, lat]
}

// ------------------------------------------------------------------------------------------------- goals
export interface GoalInput {
  /** The framing target: an incident id, or null for the national overview. */
  target: string | null
  incidentId: string | null
  /** selectIncident is still fetching the incident or its bundle files. */
  incidentLoading: boolean
  summary: Pick<IncidentSummary, 'id' | 'lat' | 'lon' | 'acres' | 'bundle_status'> | null
  manifest: Pick<IncidentManifest, 'id' | 'status' | 'grid'> | null
  /** The ready bundle's fire rasters: still loading, loaded (or failed), or not waited for any longer. */
  rasters: 'pending' | 'settled' | 'expired'
  burned: FireRaster | null
  p90: FireRaster | null
  perimeters: readonly Pick<Perimeter, 't_ms' | 'rings'>[] | null
  /** The overview as the user last left it (restored by "← All fires"), else the lower 48. */
  overviewView: { lon: number; lat: number; zoom: number } | null
}

/** The newest perimeter (any time: the framing shows the whole fire, not the timeline time). */
export function latestPerimeter<P extends { t_ms: number }>(ps: readonly P[] | null | undefined): P | null {
  let best: P | null = null
  for (const p of ps ?? []) if (!best || p.t_ms > best.t_ms) best = p
  return best
}

/** What to frame for the target now, or null while its data is not ready (the camera then stays where it is). */
export function goalFor(i: GoalInput): FrameGoal | null {
  if (i.target == null) {
    return i.overviewView
      ? { key: `overview:${i.overviewView.lon.toFixed(4)},${i.overviewView.lat.toFixed(4)},${i.overviewView.zoom.toFixed(2)}`, kind: 'overview', provisional: false, view: i.overviewView }
      : { key: 'overview', kind: 'overview', provisional: false, bounds: LOWER48_BOUNDS }
  }
  const id = i.target
  if (i.incidentId !== id) return null
  const sum = i.summary && i.summary.id === id ? i.summary : null
  const m = i.manifest && i.manifest.id === id ? i.manifest : null
  const point = sum && Number.isFinite(sum.lat) && Number.isFinite(sum.lon) ? { lon: sum.lon, lat: sum.lat } : null
  if (m && m.status === 'ready') {
    // the fire's own extent needs the rasters: wait for them (bounded by the controller's timeout)
    if (i.rasters === 'pending') return null
    const bounds = fireBounds({ grid: m.grid, burned: i.burned, p90: i.p90, perimeter: latestPerimeter(i.perimeters), point, acres: sum?.acres })
    return bounds ? { key: `fire:${id}:ready`, kind: 'fire', provisional: false, bounds } : null
  }
  // a building bundle already has its grid (step 1 of the build): frame the acreage estimate inside it
  if (m && m.status === 'building' && m.grid) {
    const bounds = fireBounds({ grid: m.grid, point, acres: sum?.acres })
    return bounds ? { key: `fire:${id}:building`, kind: 'fire', provisional: true, bounds } : null
  }
  if (!sum) return null
  // the ready bundle's manifest and files are on their way: one flight when they are in
  if (i.incidentLoading && (sum.bundle_status === 'ready' || sum.bundle_status === 'building')) return null
  // no bundle (or it failed, or its files did not load): the agency's reported point and acreage
  const bounds = fireBounds({ point, acres: sum.acres })
  return bounds ? { key: `fire:${id}:point`, kind: 'fire', provisional: true, bounds } : null
}

// ------------------------------------------------------------------------------------------------- state machine
export class Framing {
  /** Incident id, or null for the overview. */
  target: string | null
  phase: FramingPhase
  /** The goal being flown to or last framed. */
  goal: FrameGoal | null = null
  /** The camera the current fit is expected to end at. */
  pose: CameraPose | null = null
  /** Times the current goal was re-issued after an interruption. */
  reissues = 0
  /** A view restored at mount that belongs to the incident named in the link (kept on its first load). */
  private held: string | null = null

  constructor(init: FramingInit) {
    this.target = init.incidentId
    if (init.restoredView) {
      this.phase = 'done'
      if (init.incidentId == null && init.urlIncident) this.held = init.urlIncident
    } else this.phase = 'waiting'
  }

  /** The incident changed (null = back to the overview). `keepCamera`: the map focused it by zooming (decision 10), so
   *  the camera belongs to the user and the target is never framed. */
  setTarget(next: string | null, opts: { keepCamera?: boolean } = {}): void {
    if (next === this.target) return
    const prev = this.target
    const keep = prev == null && next != null && this.held === next
    this.held = null
    this.target = next
    this.goal = null
    this.pose = null
    this.reissues = 0
    // a first load of the incident the restored view was made for keeps that view
    this.phase = opts.keepCamera ? 'user' : keep ? 'done' : 'waiting'
  }

  /** Offer the current goal for the target; returns a fit when the camera should move. */
  offer(goal: FrameGoal | null): FitCommand | null {
    if (!goal) return null
    if (this.phase === 'waiting') return { type: 'fit', goal, reissue: false }
    if ((this.phase === 'flying' || this.phase === 'done') && this.goal?.provisional && goal.key !== this.goal.key) return { type: 'fit', goal, reissue: false }
    return null
  }

  /** The controller issued a fit expected to end at `pose` (`reissue`: the same goal again after an interruption). */
  started(goal: FrameGoal, pose: CameraPose, reissue = false): void {
    if (reissue && this.goal?.key === goal.key) this.reissues++
    else this.reissues = 0
    this.goal = goal
    this.pose = pose
    this.phase = 'flying'
  }

  /** A camera move ended. Returns a re-issue when a non-user call stopped the fit off target (the controller issues it
   *  once the camera is free again; MAX_REISSUES issued re-issues at most, then the target counts as framed). */
  moveEnd(byUser: boolean, now: CameraPose): FitCommand | null {
    if (byUser) {
      this.userTook()
      return null
    }
    if (this.phase !== 'flying' || !this.goal || !this.pose) return null
    if (poseMatches(now, this.pose) || this.reissues >= MAX_REISSUES) {
      this.phase = 'done'
      return null
    }
    return { type: 'fit', goal: this.goal, reissue: true }
  }

  /** The user started a gesture on the map (pointer, wheel, touch, key). */
  userGesture(): void {
    this.userTook()
  }

  /** An explicit navigation request (search, feed item, fire card, return-to) took the camera. */
  explicit(): void {
    this.userTook()
  }

  /** "Incident" / "All states" controls: frame this goal now, tracked like an opening fit (interruptions re-issue
   *  it; data arriving later never replaces it). */
  request(goal: FrameGoal): FitCommand {
    this.held = null
    return { type: 'fit', goal: { ...goal, provisional: false }, reissue: false }
  }

  /** The kind of the last completed framing while the camera is still there (for the toggle), else null. */
  framedKind(): FrameGoal['kind'] | null {
    return this.phase === 'done' && this.goal ? this.goal.kind : null
  }

  /** May the settled view be saved (workspace view)? Not while waiting for or flying to a goal. */
  viewIsSettled(): boolean {
    return this.phase === 'done' || this.phase === 'user' || this.phase === 'idle'
  }

  private userTook(): void {
    this.held = null
    if (this.phase !== 'idle') this.phase = 'user'
  }
}
