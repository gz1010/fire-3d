import { describe, expect, it } from 'vitest'
import { CAMERAS_SAMPLE, EVAC_SAMPLE, IMAGERY_SAMPLE } from './__fixtures__/samples'
import { cameraLegend } from './cameras'
import { evacuationLegend } from './evacuation'
import { imageryLegend, pickDefaultImagery } from './imagery'
import { compactExtrasLegend, extrasStatusLines, IDLE_QUERY, sameQueryState } from './runtime'
import type { CamerasResponse, EvacuationsResponse } from './types'

const ALL_ON = { evacuation: true, cameras: true, recentImagery: true }
const ALL_OFF = { evacuation: false, cameras: false, recentImagery: false }
const ok = <T,>(data: T | null, error: string | null = null) => ({ data, error })
const past: EvacuationsResponse = { ...EVAC_SAMPLE, status: 'not_available_for_past_dates', reason: 'Evacuation status is current only.', reason_code: 'past_date', zones: { type: 'FeatureCollection', features: [] } }
const noZones: EvacuationsResponse = { ...EVAC_SAMPLE, zones: { type: 'FeatureCollection', features: [] } }
const camsDown: CamerasResponse = { ...CAMERAS_SAMPLE, status: 'unavailable', reason: 'Cal OES webcams layer did not answer.', reason_code: 'upstream_error' }

describe('extrasStatusLines', () => {
  it('says nothing for layers that are off', () => {
    expect(extrasStatusLines(ALL_OFF, { evac: ok(past), cams: ok(camsDown), imgs: ok(null) }, null)).toEqual({})
  })

  it('names past dates and outages with the source reason, never as "none"', () => {
    const s = extrasStatusLines(ALL_ON, { evac: ok(past), cams: ok(camsDown), imgs: ok(IMAGERY_SAMPLE) }, pickDefaultImagery(IMAGERY_SAMPLE, null))
    expect(s.evacuation).toMatchObject({ tone: 'muted', title: 'Official evacuation zones: not available for past dates', detail: 'Evacuation status is current only.' })
    expect(s.cameras).toMatchObject({ tone: 'warn', title: 'Public cameras: unavailable', detail: 'Cal OES webcams layer did not answer.' })
    expect(s.recentImagery).toBeUndefined()
  })

  it('says "none listed" (not an all-clear) for an available answer without zones, and nothing when zones are drawn', () => {
    const none = extrasStatusLines({ ...ALL_OFF, evacuation: true }, { evac: ok(noZones), cams: ok(null), imgs: ok(null) }, null)
    expect(none.evacuation?.title).toBe('Official evacuation zones: none listed in this area')
    expect(none.evacuation?.detail).toMatch(/not an all-clear/)
    const some = extrasStatusLines({ ...ALL_OFF, evacuation: true }, { evac: ok(EVAC_SAMPLE), cams: ok(null), imgs: ok(null) }, null)
    expect(some).toEqual({})
  })

  it('reports loading and request errors', () => {
    const s = extrasStatusLines(ALL_ON, { evac: ok(null), cams: ok(null, 'Could not reach the Fire-3d server.'), imgs: ok(null) }, null)
    expect(s.evacuation).toMatchObject({ tone: 'muted', title: 'Official evacuation zones: loading…' })
    expect(s.cameras).toMatchObject({ tone: 'error', detail: 'Could not reach the Fire-3d server.' })
    expect(s.recentImagery?.title).toBe('Recent satellite imagery: loading…')
  })

  it('explains an imagery answer with no image picked', () => {
    const s = extrasStatusLines({ ...ALL_OFF, recentImagery: true }, { evac: ok(null), cams: ok(null), imgs: ok(IMAGERY_SAMPLE) }, null)
    expect(s.recentImagery).toMatchObject({ tone: 'info', title: 'Recent satellite imagery: no image shown' })
  })
})

describe('compactExtrasLegend', () => {
  it('keeps one entry per drawn layer, in legend order, with its most important swatch', () => {
    const product = pickDefaultImagery(IMAGERY_SAMPLE, null)
    const entries = [...imageryLegend(product, IMAGERY_SAMPLE.reference_ms), ...cameraLegend(CAMERAS_SAMPLE), ...evacuationLegend(EVAC_SAMPLE)]
    const c = compactExtrasLegend(entries)
    expect(c.map((x) => x.layer)).toEqual(['evacuation', 'cameras', 'recentImagery'])
    expect(c.map((x) => x.label)).toEqual(['Evacuation zones (official)', 'Public cameras', 'Satellite image'])
    // the most urgent official wording comes first (orders before warnings)
    expect(c[0].entry.label).toBe('Evacuation Order')
    expect(c[0].entry.swatch.kind).toBe('hatch')
  })

  it('is empty when nothing optional is drawn', () => {
    expect(compactExtrasLegend([])).toEqual([])
  })
})

describe('sameQueryState', () => {
  it('compares answer, loading, error and refresh by identity', () => {
    const a = { ...IDLE_QUERY, data: EVAC_SAMPLE }
    expect(sameQueryState(a, { ...a })).toBe(true)
    expect(sameQueryState(a, { ...a, loading: true })).toBe(false)
    expect(sameQueryState(a, { ...a, data: { ...EVAC_SAMPLE } })).toBe(false)
    expect(sameQueryState(a, { ...a, error: 'x' })).toBe(false)
  })
})
