import { describe, expect, it } from 'vitest'
import { lonLatToUtm } from '../lib/reproject'
import { coordinateLine, nearSentence, recordIssuer, selectedLabel } from './readoutText'

describe("Command readout text (brief 4)", () => {
  it('writes the coordinate line: DMS, UTM with the zone, the datum', () => {
    const [e, n] = lonLatToUtm(-121.43, 36.215, 10)
    expect(coordinateLine(36.215, -121.43, 10)).toBe(`36°12′54.0″ N · 121°25′48.0″ W · UTM 10N ${Math.round(e)} E ${Math.round(n)} N · WGS84`)
    // no bundle grid: DMS and the datum only
    expect(coordinateLine(36.215, -121.43, null)).toBe('36°12′54.0″ N · 121°25′48.0″ W · WGS84')
  })

  it('says the near-here line as one sentence, the estimate and the edge distance kept', () => {
    expect(nearSentence({ text: 'Inside the mapped fire area', burned: 'Burned around Oct 21, 02:11 PDT (estimate)', edge: '0.2 mi from the edge' })).toBe(
      'Inside the mapped fire area. Burned around Oct 21, 02:11 PDT (estimate), 0.2 mi from the edge.',
    )
    expect(nearSentence({ text: 'Inside the estimated burned area', burned: null, edge: '0.3 mi from its edge' })).toBe('Inside the estimated burned area, 0.3 mi from its edge.')
    expect(nearSentence({ text: '0.8 mi east of the mapped fire edge', burned: null, edge: null })).toBe('0.8 mi east of the mapped fire edge.')
    // a line still loading keeps its ellipsis
    expect(nearSentence({ text: 'Checking the fire perimeter…', burned: null, edge: null })).toBe('Checking the fire perimeter…')
  })

  it('names what was selected', () => {
    const base = { lat: 1, lon: 2 }
    expect(selectedLabel({ ...base, source: 'click' })).toBe('Selected point')
    expect(selectedLabel({ ...base, source: 'click', adjusted: true })).toBe('Selected point · moved')
    expect(selectedLabel({ ...base, source: 'coords' })).toBe('Entered point')
    expect(selectedLabel({ ...base, source: 'address' })).toBe('Selected address · approximate')
    expect(selectedLabel({ ...base, source: 'event', approximate: true })).toBe('Event location · estimated')
    expect(selectedLabel({ ...base, source: 'device' })).toBe('Your location (from your browser)')
  })

  it('names the record issuer only when the bundle used that agency record, never for demo or local data (review H2-B3)', () => {
    const calfire = [{ name: 'CAL FIRE incidents' }, { name: 'NASA FIRMS active fire detections' }]
    const wfigs = [{ name: 'NIFC WFIGS incident record (IRWIN)' }, { name: 'NIFC WFIGS fire perimeters' }]
    const synthetic = [{ name: 'Terrain (synthetic)' }, { name: 'Fire observations (synthetic)' }]
    expect(recordIssuer('CAL FIRE', calfire, false)).toBe('CAL FIRE')
    expect(recordIssuer('USFS via NIFC WFIGS', wfigs, false)).toBe('USFS via NIFC WFIGS')
    // fixture-live: a demo bundle with synthetic sources, whose summary still names an agency
    expect(recordIssuer('CAL FIRE', synthetic, true)).toBeNull()
    expect(recordIssuer('CAL FIRE', synthetic, false)).toBeNull()
    // perimeters alone are not the incident record; no manifest yet; no issuer
    expect(recordIssuer('NIFC WFIGS', [{ name: 'NIFC WFIGS fire perimeters' }], false)).toBeNull()
    expect(recordIssuer('CAL FIRE', null, false)).toBeNull()
    expect(recordIssuer(null, calfire, false)).toBeNull()
    expect(recordIssuer('CAL FIRE', calfire, true)).toBeNull()
  })
})

