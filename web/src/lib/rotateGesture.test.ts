// Safari's trackpad twist, driven with synthetic GestureEvents (Node's EventTarget and Event). The real gesture cannot
// be produced in the cloud (Chrome has no rotate gesture): the user tries it in Safari.
import { describe, expect, it } from 'vitest'
import { attachRotateGesture, ROTATE_THRESHOLD_DEG } from './rotateGesture'

function gesture(type: string, rotation?: number): Event {
  const e = new Event(type, { cancelable: true })
  if (rotation !== undefined) Object.defineProperty(e, 'rotation', { value: rotation })
  return e
}

function rig(threshold?: number) {
  const el = new EventTarget()
  const log: string[] = []
  const deltas: number[] = []
  let heading = 30
  let start = 0
  const detach = attachRotateGesture(
    el,
    {
      start: () => {
        log.push('start')
        start = heading
      },
      rotate: (d, ev) => {
        expect(ev.type).toBe('gesturechange')
        deltas.push(d)
        // the view's rule: heading = heading at start − twist
        heading = start - d
      },
      end: () => log.push('end'),
    },
    threshold === undefined ? {} : { thresholdDeg: threshold },
  )
  return { el, log, deltas, detach, heading: () => heading }
}

describe('attachRotateGesture (Safari trackpad rotation)', () => {
  it('stops Safari’s page zoom on every gesture event', () => {
    const r = rig()
    for (const e of [gesture('gesturestart'), gesture('gesturechange', 1), gesture('gestureend')]) {
      r.el.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(true)
    }
  })

  it('a pinch with little twist does not turn the view', () => {
    const r = rig()
    r.el.dispatchEvent(gesture('gesturestart'))
    r.el.dispatchEvent(gesture('gesturechange', 1.5))
    r.el.dispatchEvent(gesture('gesturechange', -3))
    r.el.dispatchEvent(gesture('gestureend'))
    expect(r.log).toEqual([])
    expect(r.deltas).toEqual([])
    expect(r.heading()).toBe(30)
  })

  it('a twist past the threshold turns the view from where it is, with the fingers (heading = start − rotation)', () => {
    const r = rig()
    r.el.dispatchEvent(gesture('gesturestart'))
    r.el.dispatchEvent(gesture('gesturechange', ROTATE_THRESHOLD_DEG)) // crossing: no jump
    r.el.dispatchEvent(gesture('gesturechange', ROTATE_THRESHOLD_DEG + 20)) // fingers turned clockwise
    expect(r.log).toEqual(['start'])
    expect(r.deltas).toEqual([0, 20])
    expect(r.heading()).toBe(10)
    r.el.dispatchEvent(gesture('gesturechange', -ROTATE_THRESHOLD_DEG - 10)) // back past the start, anticlockwise
    expect(r.deltas.at(-1)).toBe(-10 - 2 * ROTATE_THRESHOLD_DEG)
    r.el.dispatchEvent(gesture('gestureend'))
    expect(r.log).toEqual(['start', 'end'])
  })

  it('anticlockwise twists measure from the negative threshold', () => {
    const r = rig(5)
    r.el.dispatchEvent(gesture('gesturestart'))
    r.el.dispatchEvent(gesture('gesturechange', -5))
    r.el.dispatchEvent(gesture('gesturechange', -35))
    expect(r.deltas).toEqual([0, -30])
    expect(r.heading()).toBe(60)
  })

  it('ignores changes outside a gesture and events without a rotation; a new gesture starts afresh', () => {
    const r = rig(0)
    r.el.dispatchEvent(gesture('gesturechange', 40)) // no gesturestart
    r.el.dispatchEvent(gesture('gesturestart'))
    r.el.dispatchEvent(gesture('gesturechange'))
    r.el.dispatchEvent(gesture('gesturechange', Number.NaN))
    expect(r.deltas).toEqual([])
    r.el.dispatchEvent(gesture('gesturechange', 10))
    r.el.dispatchEvent(gesture('gestureend'))
    r.el.dispatchEvent(gesture('gesturestart'))
    r.el.dispatchEvent(gesture('gesturechange', 3))
    expect(r.deltas).toEqual([10, 3])
    expect(r.log).toEqual(['start', 'end', 'start'])
  })

  it('detaching removes the listeners and ends a gesture in progress', () => {
    const r = rig(0)
    r.el.dispatchEvent(gesture('gesturestart'))
    r.el.dispatchEvent(gesture('gesturechange', 12))
    r.detach()
    expect(r.log).toEqual(['start', 'end'])
    const e = gesture('gesturechange', 50)
    r.el.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(r.deltas).toEqual([12])
  })
})
