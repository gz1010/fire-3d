import { describe, expect, it } from 'vitest'
import type { LonLatBox } from '../lib/fireBounds'
import { lonLatToLocal } from '../lib/reproject'
import { NearbyLoader, nearbyFires, nearbyPerimeterFeatures, NEARBY_MAX, shownPerimeterIndex, type NearbyBundle } from './nearbyPerimeters'

const EATON_BOX: LonLatBox = [-118.215, 34.095, -117.962, 34.305]
const PAL_BOX: LonLatBox = [-118.757, 33.946, -118.426, 34.221]
const row = (id: string, bbox: LonLatBox | null, over: Partial<{ bundle_status: 'ready' | 'none'; started_ms: number; bundle_built_ms: number }> = {}) => ({
  id,
  name: `${id} Fire`,
  bundle_status: 'ready' as 'ready' | 'none',
  bundle_built_ms: 1000,
  bbox_lonlat: bbox,
  started_ms: 0,
  ...over,
})
const VIEW: LonLatBox = [-119, 33.8, -117.8, 34.5]

describe('nearbyFires', () => {
  it('prepared fires in view, never the open one, nearest the centre first', () => {
    const rows = [row('eaton', EATON_BOX), row('pal', PAL_BOX), row('far', [-120.5, 37.7, -120.4, 37.8]), row('unbuilt', EATON_BOX, { bundle_status: 'none' }), row('nobox', null)]
    expect(nearbyFires(rows, VIEW, [-118.6, 34.1], null).map((f) => f.id)).toEqual(['pal', 'eaton'])
    expect(nearbyFires(rows, VIEW, [-118.6, 34.1], 'pal').map((f) => f.id)).toEqual(['eaton'])
  })

  it('in a replay, fires that had not started by the timeline time are left out', () => {
    const rows = [row('eaton', EATON_BOX, { started_ms: 100 }), row('pal', PAL_BOX, { started_ms: 50 })]
    expect(nearbyFires(rows, VIEW, [-118.6, 34.1], null, 60).map((f) => f.id)).toEqual(['pal'])
  })

  it('at most NEARBY_MAX', () => {
    const rows = Array.from({ length: NEARBY_MAX + 3 }, (_, i) => row(`f${i}`, [-118.5 + i * 0.01, 34, -118.49 + i * 0.01, 34.01]))
    expect(nearbyFires(rows, VIEW, [-118.5, 34], null)).toHaveLength(NEARBY_MAX)
  })
})

describe('perimeters shown for other fires', () => {
  const grid = { utm_zone: 11, center_e: 399738, center_n: 3784875 }
  const ring = (x: number): [number, number][] => [
    [x, 0],
    [x + 500, 0],
    [x + 500, 500],
  ]
  const bundle: NearbyBundle = {
    grid,
    perimeters: [
      { t_ms: 300, acres: 30, rings: [ring(200)] },
      { t_ms: 100, acres: 10, rings: [ring(0)] },
      { t_ms: 200, acres: 20, rings: [ring(100)] },
    ],
  }

  it('the newest perimeter, or the newest published by the timeline time', () => {
    expect(shownPerimeterIndex(bundle.perimeters, null)).toBe(0)
    expect(shownPerimeterIndex(bundle.perimeters, 250)).toBe(2)
    expect(shownPerimeterIndex(bundle.perimeters, 50)).toBe(-1)
    expect(shownPerimeterIndex([], null)).toBe(-1)
  })

  it('one closed outline per fire in lon/lat, labelled with the name and date; the key changes with what is shown', () => {
    const fire = { id: 'eaton', name: 'Eaton Fire', builtMs: 1, bbox: EATON_BOX, startedMs: 0 }
    const a = nearbyPerimeterFeatures([{ fire, bundle }], null)
    expect(a.fc.features).toHaveLength(1)
    const f = a.fc.features[0]
    expect(f.properties.id).toBe('eaton')
    expect(String(f.properties.label)).toMatch(/^Eaton Fire · perimeter /)
    const coords = (f.geometry as { coordinates: [number, number][][] }).coordinates[0]
    expect(coords).toHaveLength(4) // closed
    const [x, z] = lonLatToLocal(coords[0][0], coords[0][1], grid)
    expect(x).toBeCloseTo(200, 3)
    expect(z).toBeCloseTo(0, 3)
    const b = nearbyPerimeterFeatures([{ fire, bundle }], 250)
    expect(b.key).not.toBe(a.key)
    expect(nearbyPerimeterFeatures([{ fire, bundle }], 260).key).toBe(b.key)
    expect(nearbyPerimeterFeatures([{ fire, bundle }], 50).fc.features).toHaveLength(0)
  })
})

describe('NearbyLoader', () => {
  it('fetches each bundle version once (concurrent calls share it) and retries after a failure', async () => {
    const calls: string[] = []
    let fail = true
    const fetcher = async <T,>(url: string): Promise<T> => {
      calls.push(url)
      if (fail && url.includes('perimeters')) throw new Error('offline')
      return (url.includes('manifest') ? { grid: { utm_zone: 11, center_e: 1, center_n: 2 } } : { perimeters: [{ t_ms: 1, acres: 1, rings: [] }] }) as T
    }
    const loader = new NearbyLoader(fetcher, (id, file, v) => `/api/bundles/${id}/${file}?v=${v}`)
    const f = { id: 'eaton', builtMs: 7 }
    expect(await loader.load(f)).toBeNull()
    expect(loader.get(f)).toBeUndefined()
    fail = false
    const [x, y] = await Promise.all([loader.load(f), loader.load(f)])
    expect(x).toBe(y)
    expect(x?.perimeters).toHaveLength(1)
    expect(loader.get(f)).toBe(x)
    const n = calls.length
    await loader.load(f)
    expect(calls.length).toBe(n)
    expect(calls).toContain('/api/bundles/eaton/manifest.json?v=7')
    // a new bundle version is fetched again
    await loader.load({ id: 'eaton', builtMs: 8 })
    expect(calls.length).toBe(n + 2)
  })
})
