import { describe, expect, it } from 'vitest'
import { leaveHold, publicFireTime } from './usePublicFireTime'

describe('the Public fire view time (decision a)', () => {
  const s = { id: 'f', timeMs: 100, latestMs: 900, defaultMs: 400 }
  it('shows the latest observation and holds an asked-for time for Command', () => {
    expect(publicFireTime(s, null)).toEqual({ timeMs: 900, held: { id: 'f', ms: 100 } })
  })
  it('does not hold the store’s opening default', () => {
    expect(publicFireTime({ ...s, timeMs: 400 }, null)).toEqual({ timeMs: 900, held: null })
  })
  it('keeps the first hold of the same fire, and drops another fire’s', () => {
    expect(publicFireTime({ ...s, timeMs: 250 }, { id: 'f', ms: 100 }).held).toEqual({ id: 'f', ms: 100 })
    expect(publicFireTime({ ...s, timeMs: 900 }, { id: 'f', ms: 100 }).held).toEqual({ id: 'f', ms: 100 })
    expect(publicFireTime({ ...s, timeMs: 900 }, { id: 'other', ms: 100 }).held).toBeNull()
  })
})

describe('leaving the fire view (review R7)', () => {
  const hold = { id: 'f', ms: 100 }
  it('gives the held time back on a switch to Command in the same fire', () => {
    expect(leaveHold(hold, { incidentId: 'f', preset: 'command' })).toEqual({ held: null, giveBackMs: 100 })
  })
  it('drops it when the fire closes (X or Back), so reopening it later never jumps to the old link time', () => {
    expect(leaveHold(hold, { incidentId: null, preset: 'public' })).toEqual({ held: null, giveBackMs: null })
    expect(leaveHold(hold, { incidentId: 'other', preset: 'public' })).toEqual({ held: null, giveBackMs: null })
    // X then the same fire again from the overview: the next view starts with no hold
    const afterX = leaveHold(hold, { incidentId: null, preset: 'public' }).held
    expect(publicFireTime({ id: 'f', timeMs: 900, latestMs: 900, defaultMs: 400 }, afterX).held).toBeNull()
  })
  it('keeps it while the same fire stays open in Public (a remount)', () => {
    expect(leaveHold(hold, { incidentId: 'f', preset: 'public' })).toEqual({ held: hold, giveBackMs: null })
    expect(leaveHold(null, { incidentId: 'f', preset: 'command' })).toEqual({ held: null, giveBackMs: null })
  })
})
