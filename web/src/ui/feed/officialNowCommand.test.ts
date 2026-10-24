import { describe, expect, it } from 'vitest'
import { NOT_ALL_CLEAR } from '../shell/fixedCopy'
import { NOT_AN_ORDER } from './feedMeta'
import { COMMAND_OFFICIAL_FOOT } from './OfficialNow'

describe("Command's Official now foot (brief 4, decision i-8)", () => {
  it('says the model is not an order and not an all-clear, with "Follow local officials." once', () => {
    expect(COMMAND_OFFICIAL_FOOT).toBe("Fire-3d's modeled spread is experimental and is not an evacuation order. Not an all-clear. Follow local officials.")
    expect(COMMAND_OFFICIAL_FOOT.endsWith(NOT_ALL_CLEAR)).toBe(true)
    expect(COMMAND_OFFICIAL_FOOT.startsWith(NOT_AN_ORDER.replace(/\s*Follow local officials\.$/, ''))).toBe(true)
    expect(COMMAND_OFFICIAL_FOOT.match(/Follow local officials\./g)).toHaveLength(1)
  })
})
