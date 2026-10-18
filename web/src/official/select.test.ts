import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkspace } from '../state/workspace'
import { useOfficialRuntime } from './runtime'
import { fitOfficialBounds, showOfficialArea } from './select'

// Cal OES's Orange County order listed near the Henderson Fire (it lies inside the Norte Fire's area).
const ZONE: [number, number, number, number] = [-117.6631, 33.4742, -117.6364, 33.4886]

describe('official area fits (integration: MapFlyTo.source)', () => {
  beforeEach(() => {
    useWorkspace.setState({ workspace: 'map', mapFlyTo: null })
    useOfficialRuntime.getState().setHighlight(null)
  })

  it('marks the flight official, so the map keeps the open fire', () => {
    fitOfficialBounds(ZONE)
    const f = useWorkspace.getState().mapFlyTo
    expect(f).toMatchObject({ bounds: ZONE, source: 'official' })
    expect(f?.lon).toBeCloseTo(-117.64975, 5)
    expect(f?.lat).toBeCloseTo(33.4814, 5)
  })

  it('showOfficialArea highlights and fits the same way; a second toggle clears without flying', () => {
    expect(showOfficialArea({ kind: 'evacuation', id: 'z1', zoneIds: ['US-CA-Orange3975'] }, ZONE, { toggle: true })).toBe(true)
    const first = useWorkspace.getState().mapFlyTo
    expect(first?.source).toBe('official')
    expect(useOfficialRuntime.getState().highlight?.id).toBe('z1')
    expect(showOfficialArea({ kind: 'evacuation', id: 'z1', zoneIds: ['US-CA-Orange3975'] }, ZONE, { toggle: true })).toBe(false)
    expect(useOfficialRuntime.getState().highlight).toBeNull()
    expect(useWorkspace.getState().mapFlyTo?.nonce).toBe(first?.nonce)
  })

  it('does nothing in Forensic or without finite bounds', () => {
    useWorkspace.setState({ workspace: 'forensic' })
    fitOfficialBounds(ZONE)
    expect(useWorkspace.getState().mapFlyTo).toBeNull()
    useWorkspace.setState({ workspace: 'map' })
    fitOfficialBounds([Number.NaN, 0, 1, 1])
    fitOfficialBounds(null)
    expect(useWorkspace.getState().mapFlyTo).toBeNull()
  })
})
