import { afterEach, describe, expect, it } from 'vitest'
import { popoverOpen, POPOVER_SELECTOR, registerRotation, ROTATE_STEP_DEG, rotateView, rotationKey, rotationTarget, runRotationKey, viewNorthUp, type RotationTarget } from './rotation'

function target(name: string, log: string[]): RotationTarget {
  let h = 0
  return {
    rotateBy: (d) => {
      h += d
      log.push(`${name} rotate ${d}`)
    },
    northUp: () => {
      h = 0
      log.push(`${name} north`)
    },
    setBearing: (d) => {
      h = d
      log.push(`${name} set ${d}`)
    },
    bearing: () => h,
  }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

describe('rotation registry (one view at a time)', () => {
  it('without a view, nothing takes the rotation', () => {
    expect(rotationTarget()).toBeNull()
    expect(rotateView(15)).toBe(false)
    expect(viewNorthUp()).toBe(false)
  })

  it('routes Q / E / N to the visible view: the most recently registered one', () => {
    const log: string[] = []
    const map = target('map', log)
    const forensic = target('forensic', log)
    const offMap = registerRotation(map)
    cleanups.push(offMap)
    expect(rotateView(-15)).toBe(true)
    // a workspace switch mounts Forensic before the map unmounts: Forensic is the visible view
    const offForensic = registerRotation(forensic)
    cleanups.push(offForensic)
    expect(runRotationKey('right')).toBe(true)
    expect(runRotationKey('north')).toBe(true)
    offMap()
    expect(rotationTarget()).toBe(forensic)
    offForensic()
    expect(rotationTarget()).toBeNull()
    expect(log).toEqual(['map rotate -15', 'forensic rotate 15', 'forensic north'])
  })

  it('unregistering twice or out of order leaves the others in place', () => {
    const log: string[] = []
    const a = target('a', log)
    const b = target('b', log)
    const offA = registerRotation(a)
    const offB = registerRotation(b)
    cleanups.push(offA, offB)
    offA()
    offA()
    expect(rotationTarget()).toBe(b)
    expect(rotateView(Number.NaN)).toBe(false)
  })

  it('keys: Q left, E right, N north up, either case; modified keys are not shortcuts', () => {
    expect(rotationKey({ key: 'q' })).toBe('left')
    expect(rotationKey({ key: 'Q' })).toBe('left')
    expect(rotationKey({ key: 'e' })).toBe('right')
    expect(rotationKey({ key: 'N' })).toBe('north')
    expect(rotationKey({ key: 'h' })).toBeNull()
    expect(rotationKey({ key: 'q', ctrlKey: true })).toBeNull()
    expect(rotationKey({ key: 'e', metaKey: true })).toBeNull()
    expect(rotationKey({ key: 'n', altKey: true })).toBeNull()
    expect(ROTATE_STEP_DEG).toBe(15)
  })

  it('an open popover, or a key from inside a dialog, menu or list box, keeps its letters', () => {
    const doc = (hit: boolean) => ({ querySelector: (s: string) => (s === POPOVER_SELECTOR && hit ? ({} as Element) : null) })
    expect(popoverOpen(doc(false))).toBe(false)
    expect(popoverOpen(doc(true))).toBe(true)
    expect(popoverOpen(null)).toBe(false)
    const inMenu = { closest: (s: string) => (s.includes('[role="listbox"]') ? ({} as Element) : null) }
    const onButton = { closest: () => null }
    expect(popoverOpen(doc(false), inMenu as unknown as EventTarget)).toBe(true)
    expect(popoverOpen(doc(false), onButton as unknown as EventTarget)).toBe(false)
    for (const sel of ['.popover', '[data-popover]', '.loc-results', '.fxm-legend-pop']) expect(POPOVER_SELECTOR).toContain(sel)
  })
})
