// Two-finger trackpad rotation in Safari (brief 4 decision f; CONTRACT §15.3). Safari on a Mac reports a trackpad
// twist only as its own GestureEvent (gesturestart / gesturechange / gestureend, `rotation` in degrees, clockwise
// positive); MapLibre 5.24 and three.js ignore those events, and Chrome on a Mac has no rotate gesture at all. This
// helper listens on one element, stops Safari's page zoom (preventDefault) and reports the twist as a turn since the
// gesture began, once it passes a small threshold so a plain pinch does not turn the view. The view applies it as
// `heading = headingAtStart − deltaDeg` (the content turns with the fingers). Other browsers never fire these events,
// so attaching is harmless everywhere. Pure DOM, no React (lib/rotateGesture.test.ts drives it with synthetic events).

export interface RotateGestureHandlers {
  /** The twist passed the threshold: remember the current heading. */
  start(): void
  /** The fingers have turned `deltaDeg` (clockwise positive) since start() (threshold excluded, so no jump); `event`
   *  is Safari's gesturechange, for a view that marks the move as the user's (MapLibre's originalEvent). */
  rotate(deltaDeg: number, event: Event): void
  /** The gesture ended (only after start()). */
  end(): void
}

export interface RotateGestureOptions {
  /** Degrees of twist before the view starts turning (default 4). */
  thresholdDeg?: number
}

/** Safari's GestureEvent, reduced to what is read here (not in TypeScript's DOM library). */
interface GestureLike extends Event {
  rotation?: number
}

export const ROTATE_THRESHOLD_DEG = 4

/** Listen for Safari's trackpad rotation on `el`; returns the function that removes the listeners. */
export function attachRotateGesture(el: EventTarget, h: RotateGestureHandlers, opts: RotateGestureOptions = {}): () => void {
  const threshold = Math.max(0, opts.thresholdDeg ?? ROTATE_THRESHOLD_DEG)
  let active = false
  let started = false
  let offset = 0

  const onStart = (e: Event) => {
    e.preventDefault()
    active = true
    started = false
    offset = 0
  }
  const onChange = (e: Event) => {
    e.preventDefault()
    const rot = (e as GestureLike).rotation
    if (!active || typeof rot !== 'number' || !Number.isFinite(rot)) return
    if (!started) {
      if (Math.abs(rot) < threshold) return
      started = true
      // measured from the threshold, so the view starts turning from where it is
      offset = Math.sign(rot) * threshold
      h.start()
    }
    h.rotate(rot - offset, e)
  }
  const onEnd = (e: Event) => {
    e.preventDefault()
    const was = started
    active = false
    started = false
    offset = 0
    if (was) h.end()
  }
  // not passive: preventDefault stops Safari zooming the whole page
  const opt = { passive: false } as AddEventListenerOptions
  el.addEventListener('gesturestart', onStart, opt)
  el.addEventListener('gesturechange', onChange, opt)
  el.addEventListener('gestureend', onEnd, opt)
  return () => {
    el.removeEventListener('gesturestart', onStart, opt)
    el.removeEventListener('gesturechange', onChange, opt)
    el.removeEventListener('gestureend', onEnd, opt)
    if (started) h.end()
    active = started = false
  }
}
