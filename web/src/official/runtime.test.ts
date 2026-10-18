import { describe, expect, it } from 'vitest'
import { fireWeatherFor, rememberAlerts, withRememberedAlerts } from './runtime'
import { FW_COOLEY_LIVE_QUIET, FW_EATON_ARCHIVE, NWS_LIVE_LOX_RFW } from './__fixtures__/samples'
import type { FireWeatherResponse } from './types'

const H = 3_600_000
const [A, B] = NWS_LIVE_LOX_RFW
const live = (alerts = NWS_LIVE_LOX_RFW, extra: Partial<FireWeatherResponse> = {}): FireWeatherResponse => ({ ...FW_COOLEY_LIVE_QUIET, alerts, ...extra })

describe('remembered live alerts', () => {
  it('keeps the newest message per CAP id per event and drops alerts ended more than 48 h ago; archived copies are not remembered', () => {
    const r = rememberAlerts([], NWS_LIVE_LOX_RFW, A.sent_ms!)
    expect(r).toHaveLength(1) // two segments of one VTEC event
    expect(rememberAlerts(r, [], A.ends_ms! + 49 * H)).toEqual([])
    expect(rememberAlerts([], FW_EATON_ARCHIVE.alerts, Date.now())).toEqual([])
  })

  it('lists an alert that left the live feed: expired at its end, or "no longer in the feed" when it left early', () => {
    const now = A.sent_ms! + H
    const quiet = live([], { retrieved_ms: now, now_ms: now })
    const early = withRememberedAlerts(quiet, [A])!
    expect(early.alerts).toHaveLength(1)
    expect(early.alerts[0].dropped_ms).toBe(now)
    const after = withRememberedAlerts(live([], { retrieved_ms: A.ends_ms! + H, now_ms: A.ends_ms! + H }), [A])!
    expect(after.alerts[0].dropped_ms).toBeUndefined()
    // still in the feed: nothing added; archived / past answers are left alone
    expect(withRememberedAlerts(live([B]), [A])!.alerts).toHaveLength(1)
    expect(withRememberedAlerts(FW_EATON_ARCHIVE, [A])).toBe(FW_EATON_ARCHIVE)
  })

  it("serves only the open fire's answer, and California's on the overview", () => {
    const eaton = FW_EATON_ARCHIVE
    expect(fireWeatherFor('2025-eaton-fire-dbfa57', eaton, null, [])).toBe(eaton)
    expect(fireWeatherFor('2026-cooley-fire-0c342f', eaton, null, [])).toBeNull() // another fire's answer, one render late
    const statewide = live([A], { incident_id: null, area_bbox: null })
    expect(fireWeatherFor(null, eaton, null, [], statewide)).toBe(statewide)
    expect(fireWeatherFor(null, eaton, null, [], null)).toBeNull()
    expect(fireWeatherFor(null, null, null, [], eaton)).toBeNull() // a fire's answer is never "statewide"
  })
})

describe('officialTimeReady (fire switches)', () => {
  it("waits for the open fire's own timeline; a fire without a ready bundle is asked for the present", async () => {
    const { officialTimeReady } = await import('./runtime')
    const m = (id: string) => ({ id, status: 'ready' })
    const sum = (id: string, bundle_status: string) => ({ id, bundle_status })
    expect(officialTimeReady({ incidentId: 'b', manifest: m('a'), summary: sum('b', 'ready') })).toBeNull() // the old fire's manifest
    expect(officialTimeReady({ incidentId: 'b', manifest: m('b'), summary: sum('b', 'ready') })).toBe('timeline')
    expect(officialTimeReady({ incidentId: 'b', manifest: null, summary: sum('b', 'none') })).toBe('present')
    expect(officialTimeReady({ incidentId: 'b', manifest: null, summary: sum('b', 'building') })).toBe('present')
    expect(officialTimeReady({ incidentId: 'b', manifest: null, summary: sum('a', 'none') })).toBeNull()
    expect(officialTimeReady({ incidentId: null, manifest: null, summary: null })).toBeNull()
  })
})
