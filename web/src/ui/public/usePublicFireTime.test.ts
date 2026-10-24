import { describe, expect, it } from 'vitest'
import { publicFireTime } from './usePublicFireTime'

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
