import { describe, expect, it } from 'vitest'
import { CAMERAS_SAMPLE, EVAC_SAMPLE, IMAGERY_SAMPLE } from './__fixtures__/samples'
import { cameraCredits, evacuationCredits, imageryCredits } from './credits'
import { pickDefaultImagery } from './imagery'

describe('map credits for the optional sources', () => {
  it('credits official zones only while zones are shown', () => {
    expect(evacuationCredits(EVAC_SAMPLE)).toEqual([
      { id: 'extras-evacuations', text: 'Evacuation zones: local officials via Cal OES', href: 'https://gis.data.ca.gov/datasets/CalEMA::california-evacuation-aggregation-layer' },
    ])
    expect(evacuationCredits({ ...EVAC_SAMPLE, status: 'not_available_for_past_dates' })).toEqual([])
    expect(evacuationCredits({ ...EVAC_SAMPLE, zones: { type: 'FeatureCollection', features: [] } })).toEqual([])
    expect(evacuationCredits(null)).toEqual([])
  })

  it('names the camera networks on the map', () => {
    const c = cameraCredits(CAMERAS_SAMPLE)
    expect(c).toHaveLength(1)
    expect(c[0].text).toBe('Cameras: ALERTCalifornia | UC San Diego, Caltrans via Cal OES California Webcams')
    expect(c[0].href).toMatch(/^https:\/\//)
    expect(cameraCredits({ ...CAMERAS_SAMPLE, counts: { wildfire: 3 } })[0].text).toBe('Cameras: ALERTCalifornia | UC San Diego via Cal OES California Webcams')
    expect(cameraCredits({ ...CAMERAS_SAMPLE, status: 'unavailable' })).toEqual([])
  })

  it('credits the satellite image with the Copernicus notice and its year', () => {
    const p = pickDefaultImagery(IMAGERY_SAMPLE)
    expect(imageryCredits(p, IMAGERY_SAMPLE)[0].text).toBe('Contains modified Copernicus Sentinel data 2026 (Earth Search by Element 84)')
    expect(imageryCredits(null, IMAGERY_SAMPLE)).toEqual([])
  })
})
