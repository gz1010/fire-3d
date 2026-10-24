import { describe, expect, it } from 'vitest'
import { CARRY_MS, freshCarry, type SearchCarry } from './searchUi'

// review H2-m2: a town search in Command flies away from the fire, zoom focus closes it and the next chrome mounts
// its own search box; the message ("Showing Monterey, CA. To check a spot, …") must come along
describe('search state handed over across a chrome swap', () => {
  const carry: SearchCarry = {
    text: 'Monterey',
    popover: { kind: 'message', tone: 'info', text: 'Showing Monterey, CA. To check a spot, enter a street address with a house number, or click the map.', lists: null, fix: null },
    atMs: 1000,
  }

  it('is taken by a box mounted right after (the next chrome)', () => {
    expect(freshCarry(carry, 1000)).toBe(carry)
    expect(freshCarry(carry, 1000 + CARRY_MS)).toBe(carry)
  })

  it('is not taken later (Command\'s search popover opened again) or when there is none', () => {
    expect(freshCarry(carry, 1001 + CARRY_MS)).toBeNull()
    expect(freshCarry(carry, 999)).toBeNull()
    expect(freshCarry(null, 1000)).toBeNull()
  })
})
