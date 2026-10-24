// Compass heading of the Forensic camera (brief 4 decisions f, k; CONTRACT §15.3). Pure: CameraRig turns the camera
// with it, tests cover it (heading.test.ts).
//   The orbit azimuth is the spherical theta of the camera around its target: 0 = the camera south of the target
//   looking north, positive toward +X (east). The heading is the compass direction the view looks toward (clockwise
//   from north, as MapLibre's bearing and sceneStore CameraInfo.bearingDeg), so heading = −azimuth.
//   A two-finger twist on a touch screen turns the view with the fingers (three.js MapControls only knows pinch and a
//   two-finger drag); the tracker below reports the twist once it passes a small threshold, so a plain pinch never
//   turns the view.
import { angleDelta, normalizeDeg } from '../../lib/compass'

const RAD = Math.PI / 180

/** Compass heading (degrees, [0, 360)) of an orbit azimuth (radians). */
export function headingOfAzimuth(azimuth: number): number {
  return normalizeDeg(-azimuth / RAD)
}

/** Orbit azimuth (radians) that looks toward a compass heading (degrees). */
export function azimuthOfHeading(headingDeg: number): number {
  return -normalizeDeg(headingDeg) * RAD
}

/** The goal azimuth of a turn by `deg` (clockwise positive) from `fromAzimuth`. */
export function turnedAzimuth(fromAzimuth: number, deg: number): number {
  return fromAzimuth - deg * RAD
}

/** Degrees of twist before the view starts turning (as lib/rotateGesture.ts for Safari's trackpad). */
export const TWIST_THRESHOLD_DEG = 4

interface Pt {
  x: number
  y: number
}

/** What a twist step means: `start` once when the twist passes the threshold (remember the heading then), `turned`
 *  = the fingers' clockwise turn since that start (threshold excluded, so the view does not jump). */
export interface TwistStep {
  start: boolean
  turned: number
}

/** Tracks two touch points and reports their twist. Feed it pointer events of touch pointers only. */
export class TwistTracker {
  private pts = new Map<number, Pt>()
  private last: number | null = null
  private acc = 0
  private started = false
  private offset = 0
  private readonly threshold: number

  constructor(thresholdDeg = TWIST_THRESHOLD_DEG) {
    this.threshold = Math.max(0, thresholdDeg)
  }

  /** The screen angle of the line between the two fingers (degrees, clockwise with y down), or null. */
  private angle(): number | null {
    if (this.pts.size !== 2) return null
    const [a, b] = [...this.pts.values()]
    return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
  }

  private reset(): void {
    this.last = this.angle()
    this.acc = 0
    this.started = false
    this.offset = 0
  }

  down(id: number, x: number, y: number): void {
    this.pts.set(id, { x, y })
    this.reset()
  }

  /** A finger moved; the twist step when two fingers are down and the twist has passed the threshold, else null. */
  move(id: number, x: number, y: number): TwistStep | null {
    if (!this.pts.has(id)) return null
    this.pts.set(id, { x, y })
    const a = this.angle()
    if (a == null || this.last == null) return null
    this.acc += angleDelta(this.last, a)
    this.last = a
    if (!this.started) {
      if (Math.abs(this.acc) < this.threshold) return null
      this.started = true
      this.offset = Math.sign(this.acc) * this.threshold
      return { start: true, turned: this.acc - this.offset }
    }
    return { start: false, turned: this.acc - this.offset }
  }

  /** A finger lifted (or the pointer was cancelled); true when a started twist ended. */
  up(id: number): boolean {
    if (!this.pts.delete(id)) return false
    const was = this.started
    this.reset()
    return was
  }

  /** Two fingers are down and twisting the view. */
  get twisting(): boolean {
    return this.started
  }
}
