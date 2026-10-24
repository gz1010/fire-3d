import { describe, expect, it } from 'vitest'
import { angleDelta, dragHeading, headingLabel, isRotated, normalizeDeg, pointerBearing, signedDeg, stepDeg } from './compass'

describe('compass maths', () => {
  it('normalizeDeg wraps any heading into [0, 360)', () => {
    expect(normalizeDeg(0)).toBe(0)
    expect(normalizeDeg(360)).toBe(0)
    expect(normalizeDeg(-0)).toBe(0)
    expect(Object.is(normalizeDeg(-360), 0)).toBe(true)
    expect(normalizeDeg(-15)).toBe(345)
    expect(normalizeDeg(725)).toBe(5)
    expect(normalizeDeg(-725)).toBe(355)
    expect(normalizeDeg(Number.NaN)).toBe(0)
    expect(normalizeDeg(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('signedDeg uses MapLibre’s (-180, 180] range', () => {
    expect(signedDeg(180)).toBe(180)
    expect(signedDeg(-180)).toBe(180)
    expect(signedDeg(181)).toBe(-179)
    expect(signedDeg(345)).toBe(-15)
    expect(signedDeg(-195)).toBe(165)
  })

  it('angleDelta is the shortest signed turn, across north too', () => {
    expect(angleDelta(10, 20)).toBe(10)
    expect(angleDelta(20, 10)).toBe(-10)
    expect(angleDelta(350, 10)).toBe(20)
    expect(angleDelta(10, 350)).toBe(-20)
    expect(angleDelta(0, 180)).toBe(180)
  })

  it('stepDeg turns by exactly one step from any heading (Q / E, ⟲ ⟳)', () => {
    expect(stepDeg(0, 15)).toBe(15)
    expect(stepDeg(0, -15)).toBe(-15)
    expect(stepDeg(7, 15)).toBe(22)
    expect(stepDeg(175, 15)).toBe(-170)
    expect(stepDeg(-170, -15)).toBe(175)
    // 24 presses make a full turn back to north
    let h = 0
    for (let i = 0; i < 24; i++) h = stepDeg(h, 15)
    expect(Math.abs(h)).toBeLessThan(1e-9)
  })

  it('pointerBearing reads the pointer around the centre as a compass bearing (screen y down)', () => {
    const c = [100, 100] as const
    expect(pointerBearing(c[0], c[1], 100, 80)).toBe(0) // straight up = north
    expect(pointerBearing(c[0], c[1], 120, 100)).toBe(90) // right = east
    expect(pointerBearing(c[0], c[1], 100, 120)).toBe(180)
    expect(pointerBearing(c[0], c[1], 80, 100)).toBe(270)
    expect(pointerBearing(c[0], c[1], 110, 90)).toBeCloseTo(45, 9)
    // too close to the centre for a stable angle
    expect(pointerBearing(c[0], c[1], 101, 101, 3)).toBeNull()
    expect(pointerBearing(c[0], c[1], 100, 100)).toBeNull()
  })

  it('dragHeading: the needle follows the pointer, so a clockwise drag turns the heading back', () => {
    expect(dragHeading(0, 30)).toBe(-30)
    expect(dragHeading(40, -50)).toBe(90)
    expect(dragHeading(10, 370)).toBe(0) // more than a full turn
  })

  it('headingLabel and isRotated', () => {
    expect(headingLabel(0)).toBe('000°')
    expect(headingLabel(-15)).toBe('345°')
    expect(headingLabel(45.4)).toBe('045°')
    expect(headingLabel(359.6)).toBe('000°')
    expect(isRotated(0.4)).toBe(false)
    expect(isRotated(-0.6)).toBe(true)
    expect(isRotated(359.8)).toBe(false)
  })
})
