import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { describe, expect, it } from 'vitest'
import type { IncidentSummary } from '../api/types'
import { overviewFires } from '../state/overview'
import {
  CHIP_IMAGE,
  CHIP_TEXT,
  chipImage,
  chipText,
  DIM_OPACITY,
  isLabelled,
  LABEL_MIN_ACRES,
  markerRadius,
  OVERVIEW_HIT_LAYERS,
  OVERVIEW_SRC,
  overviewFeatures,
  overviewFilters,
  overviewLabel,
  overviewLayers,
  overviewPaint,
  OVR,
  pickFireHit,
} from './overviewLayers'

function fire(over: Partial<IncidentSummary>): IncidentSummary {
  return {
    id: 'x',
    name: 'Test Fire',
    mode: 'historical',
    year: 2026,
    calfire_uid: 'u',
    started_ms: 0,
    updated_ms: null,
    contained_ms: null,
    acres: 500,
    percent_contained: 100,
    is_active: false,
    county: null,
    location: null,
    admin_unit: null,
    url: null,
    lat: 34.2,
    lon: -118.1,
    detections_24h: null,
    bundle_status: 'none',
    bundle_built_ms: null,
    ...over,
  }
}

describe('overview markers', () => {
  it('radius grows with the square root of the acreage, 4-13 px', () => {
    expect(markerRadius(0)).toBe(4)
    expect(markerRadius(null)).toBe(4)
    expect(markerRadius(-5)).toBe(4)
    expect(markerRadius(10_000)).toBe(7)
    expect(markerRadius(130_000)).toBeCloseTo(13, 0)
    expect(markerRadius(1_000_000)).toBe(13)
    const rs = [100, 1000, 5000, 20_000, 60_000].map(markerRadius)
    for (let i = 1; i < rs.length; i++) expect(rs[i]).toBeGreaterThan(rs[i - 1])
  })

  it('labels read "Name · acres" (no trailing "Fire"), hectares in metric', () => {
    expect(overviewLabel('Garnet Fire', 59_844, 'us')).toBe('Garnet · 59,844 ac')
    expect(overviewLabel('Cooley', 731.4, 'us')).toBe('Cooley · 731 ac')
    expect(overviewLabel('Garnet Fire', 59_844, 'metric')).toBe('Garnet · 24,218 ha')
    expect(overviewLabel('Unknown Fire', null, 'us')).toBe('Unknown')
    expect(overviewLabel('Fire', 10, 'us')).toBe('Fire · 10 ac')
  })

  it('labels active fires and those of 20,000 ac or more', () => {
    expect(isLabelled(fire({ mode: 'live', is_active: true, acres: 12 }))).toBe(true)
    expect(isLabelled(fire({ is_active: true, acres: 12 }))).toBe(true)
    expect(isLabelled(fire({ acres: LABEL_MIN_ACRES }))).toBe(true)
    expect(isLabelled(fire({ acres: LABEL_MIN_ACRES - 1 }))).toBe(false)
  })

  it('features: one per fire with a valid point, active ones flagged, hit radius >= 11 px, sorted keys', () => {
    const fc = overviewFeatures(
      [fire({ id: 'a', mode: 'live', is_active: true, acres: 731 }), fire({ id: 'b', acres: 60_000 }), fire({ id: 'c', lat: Number.NaN }), fire({ id: 'd', acres: 400 })],
      'us',
    )
    expect(fc.features.map((f) => f.properties.id)).toEqual(['a', 'b', 'd'])
    const [a, b, d] = fc.features.map((f) => f.properties)
    expect(a.live).toBe(true)
    expect(b.live).toBe(false)
    expect(a.label).toBe('Test · 731 ac')
    expect(b.label).toBe('Test · 60,000 ac')
    expect(d.label).toBe('')
    for (const p of [a, b, d]) expect(p.hit as number).toBeGreaterThanOrEqual(11)
    expect(a.sort as number).toBeGreaterThan(b.sort as number) // active above a larger past fire
  })

  it('draws exactly the shell overview set (season = live ∪ season, deduplicated)', () => {
    const live = [fire({ id: 'l1', mode: 'live', is_active: true })]
    const season = [fire({ id: 'l1', acres: 800 }), fire({ id: 's1', acres: 2000 })]
    const fc = overviewFeatures(overviewFires({ live, season, historical: [] }, 'season'), 'us')
    expect(fc.features.map((f) => f.properties.id)).toEqual(['l1', 's1'])
  })

  it('overlapping markers: the nearest centre wins, then active, then larger', () => {
    expect(pickFireHit([])).toBeNull()
    expect(
      pickFireHit([
        { id: 'far', live: true, acres: 1e5, distPx: 9 },
        { id: 'near', live: false, acres: 10, distPx: 3 },
      ]),
    ).toBe('near')
    expect(
      pickFireHit([
        { id: 'past', live: false, acres: 5e4, distPx: 4 },
        { id: 'live', live: true, acres: 10, distPx: 4.2 },
      ]),
    ).toBe('live')
    expect(
      pickFireHit([
        { id: 'small', live: false, acres: 10, distPx: 2 },
        { id: 'big', live: false, acres: 900, distPx: 2 },
      ]),
    ).toBe('big')
  })

  it('unprepared fires carry the chip prompt; prepared ones none; the start time rides along for replays', () => {
    expect(chipText('ready')).toBe('')
    expect(chipText('none')).toBe(CHIP_TEXT)
    expect(chipText('error')).toBe(CHIP_TEXT)
    expect(chipText('building')).toMatch(/being prepared/)
    expect(CHIP_TEXT).toBe('Spread not prepared yet · Prepare analysis (1-3 min)')
    const fc = overviewFeatures([fire({ id: 'r', bundle_status: 'ready', started_ms: 5 }), fire({ id: 'n', bundle_status: 'none' })], 'us')
    expect(fc.features.map((f) => [f.properties.ready, f.properties.chip !== '', f.properties.start])).toEqual([
      [true, false, 5],
      [false, true, 0],
    ])
  })

  it('filters leave out hidden fires on every marker layer and keep each layer\'s own filter', () => {
    const none = overviewFilters([])
    expect(none[OVR.live]).toEqual(['get', 'live'])
    expect(none[OVR.casing]).toEqual(['boolean', true])
    const f = overviewFilters(['open-fire', 'later-fire'])
    const keep = ['!', ['in', ['get', 'id'], ['literal', ['open-fire', 'later-fire']]]]
    expect(f[OVR.live]).toEqual(['all', ['get', 'live'], keep])
    expect(f[OVR.hit]).toEqual(keep)
    expect(f[OVR.chip]).toEqual(['all', ['!=', ['get', 'chip'], ''], ['in', ['get', 'id'], ['literal', []]], keep])
    expect(overviewFilters([], ['near'])[OVR.chip]).toEqual(['all', ['!=', ['get', 'chip'], ''], ['in', ['get', 'id'], ['literal', ['near']]]])
    expect(Object.keys(f)).not.toContain(OVR.selected)
    // valid expressions
    for (const theme of ['dark', 'light'] as const) {
      const layers = overviewLayers(theme).map((l) => (l.id in f ? { ...l, filter: f[l.id] } : l))
      const style = { version: 8 as const, glyphs: 'https://example.com/{fontstack}/{range}.pbf', sources: { [OVERVIEW_SRC]: { type: 'geojson' as const, data: { type: 'FeatureCollection' as const, features: [] } } }, layers }
      expect(validateStyleMin(style as never)).toEqual([])
    }
  })

  it('markers are lighter while a fire is open', () => {
    expect(overviewPaint(false)[OVR.live]['circle-opacity']).toBe(1)
    expect(overviewPaint(true)[OVR.live]['circle-opacity']).toBe(DIM_OPACITY)
    expect(overviewPaint(true)[OVR.label]['text-opacity']).toBeLessThan(1)
  })

  it('the chip pill: stretchable, transparent corners, opaque inside, amber edge', () => {
    for (const theme of ['dark', 'light'] as const) {
      const { image, options } = chipImage(theme)
      expect(image.data.length).toBe(image.width * image.height * 4)
      const a = (x: number, y: number) => image.data[(y * image.width + x) * 4 + 3]
      expect(a(0, 0)).toBe(0)
      expect(a(image.width / 2, image.height / 2)).toBeGreaterThan(220)
      expect(options.pixelRatio).toBe(2)
      expect(options.stretchX[0][0]).toBeLessThan(options.stretchX[0][1])
      const [x1, y1, x2, y2] = options.content
      expect(x2).toBeGreaterThan(x1)
      expect(y2).toBeGreaterThan(y1)
    }
    const chip = overviewLayers('dark').find((l) => l.id === OVR.chip) as unknown as { layout: Record<string, unknown> }
    expect(chip.layout['icon-image']).toBe(CHIP_IMAGE.dark)
  })

  it('layers are valid MapLibre style layers on every theme; hit layers exist; the hit circle is invisible', () => {
    for (const theme of ['dark', 'light'] as const) {
      const layers = overviewLayers(theme)
      const style = { version: 8 as const, glyphs: 'https://example.com/{fontstack}/{range}.pbf', sources: { [OVERVIEW_SRC]: { type: 'geojson' as const, data: { type: 'FeatureCollection' as const, features: [] } } }, layers }
      expect(validateStyleMin(style as never)).toEqual([])
      const ids = layers.map((l) => l.id)
      for (const h of OVERVIEW_HIT_LAYERS) expect(ids).toContain(h)
      const hit = layers.find((l) => l.id === OVR.hit) as { paint: Record<string, unknown> }
      expect(hit.paint['circle-opacity']).toBe(0)
      // label above the markers
      expect(ids.indexOf(OVR.label)).toBeGreaterThan(ids.indexOf(OVR.live))
    }
  })
})
