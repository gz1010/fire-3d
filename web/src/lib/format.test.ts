// Compact acreage (final verification, panel SR-m4): the overview list and the picker follow the units preference, as
// the map's overview labels do.
import { describe, expect, it } from 'vitest'
import { fmtAcresShort } from './format'

describe('fmtAcresShort', () => {
  it('acres by default', () => {
    expect(fmtAcresShort(173_000)).toBe('173k ac')
    expect(fmtAcresShort(12_500)).toBe('12.5k ac')
    expect(fmtAcresShort(1_365)).toBe('1,365 ac')
    expect(fmtAcresShort(0.1)).toBe('0.1 ac')
    expect(fmtAcresShort(null)).toBe('—')
  })
  it('hectares in metric', () => {
    expect(fmtAcresShort(173_000, 'metric')).toBe('70.0k ha')
    expect(fmtAcresShort(300_000, 'metric')).toBe('121k ha')
    expect(fmtAcresShort(1_365, 'metric')).toBe('552 ha')
    expect(fmtAcresShort(1, 'metric')).toBe('0.4 ha')
    expect(fmtAcresShort(undefined, 'metric')).toBe('—')
  })
})
