import { describe, expect, it } from 'vitest'
import type { Detection, Perimeter } from '../api/types'
import { fireReference, fireReferenceText } from './fire'

const GRID = { crs: 'EPSG:32611', utm_zone: 11, center_e: 399738, center_n: 3784875, extent_m: 23000, bbox_lonlat: [-118.2145, 34.0952, -117.9623, 34.3048] }
const manifest = { grid: GRID } as never
const det = (t: number, instrument: Detection['instrument'], lon = -118.1, lat = 34.2): Detection => ({ t_ms: t, lat, lon, x: 0, z: 0, frp: 1, satellite: 'N20', instrument, confidence: 'n', daynight: 'D', footprint_m: 375 })
const per = (t: number, h: number): Perimeter => ({ t_ms: t, acres: 1, source: 'x', rings: [[[-h, -h], [h, -h], [h, h], [-h, h]]] })

describe('fireReference', () => {
  it('uses the newest perimeter at or before the time, the detections up to it (not GOES) and the reported point', () => {
    const f = fireReference({ lat: 34.2, lon: -118.07 }, manifest, [per(100, 500), per(200, 900), per(300, 2000)], 250, [det(50, 'VIIRS'), det(60, 'GOES'), det(400, 'MODIS')])
    expect(f.perimeterMs).toBe(200)
    expect(f.rings).toHaveLength(1)
    expect(f.detections).toBe(1)
    expect(f.points).toEqual([[-118.07, 34.2], [-118.1, 34.2]])
    expect(f.aoi).toHaveLength(4)
    expect(fireReferenceText(f)).toBe("Distance measured to the nearest of the fire's newest mapped perimeter, satellite heat detections and reported location.")
  })

  it('thins many detections and works without a manifest', () => {
    const many = Array.from({ length: 1000 }, (_, i) => det(i, 'VIIRS'))
    const f = fireReference({ lat: 34.2, lon: -118.07 }, null, null, 5000, many)
    expect(f.detections).toBeLessThanOrEqual(300)
    expect(f.rings).toEqual([])
    expect(f.aoi).toBeNull()
    expect(fireReferenceText(fireReference({ lat: 34.2, lon: -118.07 }, null, null, 0))).toBe("Distance measured to the fire's reported location.")
    expect(fireReferenceText(fireReference(null, null, null, 0))).toBe('')
  })
})
