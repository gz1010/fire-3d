import { afterEach, describe, expect, it } from 'vitest'
import type { IncidentSummary } from '../api/types'
import { fmtAt, viewerZone, zoneLine } from '../lib/time'
import { useStore } from './store'
import { clockFor, getTimeFormat, getZoneSource, usePlaceZone, zoneOf, zoneSourceOf } from './timeZone'
import { useWorkspace } from './workspace'

const summary = (id: string, time_zone?: string) => ({ id, name: 'X', time_zone }) as unknown as IncidentSummary

afterEach(() => {
  useStore.setState({ incidentId: null, summary: null })
  usePlaceZone.getState().setPlaceZone(null)
  useWorkspace.setState({ workspace: 'map', preset: 'public' })
})

describe('clockFor (§14.9.4)', () => {
  it('12-hour only in the map workspace Public preset', () => {
    expect(clockFor('map', 'public')).toBe('12h')
    expect(clockFor('map', 'command')).toBe('24h')
    expect(clockFor('forensic', 'public')).toBe('24h')
    expect(clockFor('forensic', 'command')).toBe('24h')
  })
})

describe('zone source', () => {
  it('fire, then place, then viewer', () => {
    expect(zoneSourceOf('America/Denver', 'America/Chicago')).toBe('fire')
    expect(zoneSourceOf(null, 'America/Chicago')).toBe('place')
    expect(zoneSourceOf(null, null)).toBe('viewer')
  })
  it('zoneOf keeps only valid zones', () => {
    expect(zoneOf({ time_zone: 'America/New_York' })).toBe('America/New_York')
    expect(zoneOf({ time_zone: 'Nowhere/Zone' })).toBeNull()
    expect(zoneOf({})).toBeNull()
    expect(zoneOf(null)).toBeNull()
  })
})

describe('getTimeFormat (non-hook read)', () => {
  it("uses the open fire's zone and the preset's clock", () => {
    useStore.setState({ incidentId: 'fixture-east', summary: summary('fixture-east', 'America/New_York') })
    expect(getTimeFormat()).toEqual({ tz: 'America/New_York', clock: '12h' })
    expect(getZoneSource()).toBe('fire')
    useWorkspace.setState({ preset: 'command' })
    expect(getTimeFormat()).toEqual({ tz: 'America/New_York', clock: '24h' })
    useWorkspace.setState({ workspace: 'forensic', preset: 'public' })
    expect(getTimeFormat().clock).toBe('24h')
  })

  it('a summary of another fire (stale) is ignored', () => {
    useStore.setState({ incidentId: 'b', summary: summary('a', 'America/New_York') })
    expect(getZoneSource()).toBe('viewer')
  })

  it('without a zone on the summary: the place zone, else the viewer zone — never Pacific by default', () => {
    useStore.setState({ incidentId: 'old', summary: summary('old') })
    expect(getTimeFormat().tz).toBe(viewerZone())
    expect(getZoneSource()).toBe('viewer')
    usePlaceZone.getState().setPlaceZone('America/Chicago')
    expect(getTimeFormat().tz).toBe('America/Chicago')
    expect(getZoneSource()).toBe('place')
    usePlaceZone.getState().setPlaceZone('bogus')
    expect(usePlaceZone.getState().placeZone).toBeNull()
  })

  it('Public reads 12-hour, Command 24-hour, both in the fire zone', () => {
    useStore.setState({ incidentId: 'f', summary: summary('f', 'America/Denver') })
    const ms = Date.UTC(2026, 9, 22, 21, 40)
    expect(fmtAt(ms, getTimeFormat(), { zone: true })).toBe('Oct 22, 3:40 PM MDT')
    useWorkspace.setState({ preset: 'command' })
    expect(fmtAt(ms, getTimeFormat(), { zone: true })).toBe('Oct 22, 15:40 MDT')
    expect(zoneLine(getTimeFormat(), ms, getZoneSource())).toBe("Times: Mountain Time (MDT), the fire's local time")
  })
})
