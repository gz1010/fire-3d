import { describe, expect, it } from 'vitest'
import { azimuthOfHeading, headingOfAzimuth, turnedAzimuth, TwistTracker, TWIST_THRESHOLD_DEG } from './heading'

const DEG = Math.PI / 180

describe('Forensic heading <-> orbit azimuth', () => {
  it('a camera south of its target looks north; heading = −azimuth', () => {
    expect(headingOfAzimuth(0)).toBe(0)
    // the default oblique view: camera SSE (azimuth 22.5°), looking NNW
    expect(headingOfAzimuth(22.5 * DEG)).toBeCloseTo(337.5, 9)
    // camera east of the target looks west
    expect(headingOfAzimuth(90 * DEG)).toBeCloseTo(270, 9)
    expect(headingOfAzimuth(-90 * DEG)).toBeCloseTo(90, 9)
  })

  it('round-trips through the compass heading (any input heading, also negative or above 360)', () => {
    for (const h of [0, 15, 90, 180, 270, 345, -50, 410]) expect(headingOfAzimuth(azimuthOfHeading(h))).toBeCloseTo(((h % 360) + 360) % 360, 9)
  })

  it('a turn by +deg (clockwise, "turn right") raises the heading by deg', () => {
    const az = azimuthOfHeading(30)
    expect(headingOfAzimuth(turnedAzimuth(az, 15))).toBeCloseTo(45, 9)
    expect(headingOfAzimuth(turnedAzimuth(az, -45))).toBeCloseTo(345, 9)
  })
})

describe('TwistTracker (two-finger twist on a touch screen)', () => {
  /** Two fingers 200 px apart through (cx, cy), the line between them at `deg` (screen angle, clockwise). */
  const fingers = (deg: number, cx = 300, cy = 300, r = 100) => {
    const a = deg * DEG
    return [
      [cx - Math.cos(a) * r, cy - Math.sin(a) * r],
      [cx + Math.cos(a) * r, cy + Math.sin(a) * r],
    ] as const
  }

  it('reports nothing with one finger, and nothing until the twist passes the threshold', () => {
    const t = new TwistTracker()
    const [a, b] = fingers(0)
    t.down(1, a[0], a[1])
    expect(t.move(1, a[0] + 20, a[1])).toBeNull()
    t.down(2, b[0], b[1])
    const [a2, b2] = fingers(TWIST_THRESHOLD_DEG - 1)
    t.move(1, a2[0], a2[1])
    expect(t.move(2, b2[0], b2[1])).toBeNull()
    expect(t.twisting).toBe(false)
  })

  it('starts once past the threshold without a jump, then follows the fingers (clockwise positive)', () => {
    const t = new TwistTracker()
    const [a, b] = fingers(0)
    t.down(1, a[0], a[1])
    t.down(2, b[0], b[1])
    let step = null
    for (let d = 2; d <= 10; d += 2) {
      const [a2, b2] = fingers(d)
      t.move(1, a2[0], a2[1])
      step = t.move(2, b2[0], b2[1]) ?? step
    }
    expect(step).not.toBeNull()
    expect(t.twisting).toBe(true)
    // 10° turned, minus the 4° threshold
    expect(step!.turned).toBeCloseTo(10 - TWIST_THRESHOLD_DEG, 6)
    // counter-clockwise back past the start
    const [a3, b3] = fingers(-20)
    t.move(1, a3[0], a3[1])
    const back = t.move(2, b3[0], b3[1])
    expect(back!.start).toBe(false)
    expect(back!.turned).toBeCloseTo(-20 - TWIST_THRESHOLD_DEG, 6)
  })

  it('a pinch (fingers moving apart on the same line) never turns the view', () => {
    const t = new TwistTracker()
    const [a, b] = fingers(30, 300, 300, 50)
    t.down(1, a[0], a[1])
    t.down(2, b[0], b[1])
    for (let r = 60; r <= 200; r += 20) {
      const [a2, b2] = fingers(30, 300, 300, r)
      expect(t.move(1, a2[0], a2[1])).toBeNull()
      expect(t.move(2, b2[0], b2[1])).toBeNull()
    }
  })

  it('lifting a finger ends the twist; a new pair starts afresh', () => {
    const t = new TwistTracker()
    const [a, b] = fingers(0)
    t.down(1, a[0], a[1])
    t.down(2, b[0], b[1])
    const [a2, b2] = fingers(20)
    t.move(1, a2[0], a2[1])
    t.move(2, b2[0], b2[1])
    expect(t.up(2)).toBe(true)
    expect(t.twisting).toBe(false)
    expect(t.up(2)).toBe(false)
    expect(t.move(1, a2[0] + 5, a2[1])).toBeNull()
  })
})
