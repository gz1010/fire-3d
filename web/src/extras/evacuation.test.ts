import { describe, expect, it } from 'vitest'
import { EVAC_SAMPLE } from './__fixtures__/samples'
import {
  EVAC_LAYERS,
  EVAC_PATTERN_IDS,
  evacDisplayData,
  evacStatusCounts,
  evacuationAtPoint,
  evacuationFeedItems,
  evacuationLayerGroup,
  evacuationLegend,
  NOT_FIRE_SPECIFIC,
  statusText,
  zoneDetail,
  zoneIssuer,
  zonesAtPoint,
  zonesBounds,
  zonesCentre,
  zoneTimes,
} from './evacuation'
import type { FireReference } from '../official/fire'
import type { EvacuationsResponse, EvacZoneFeature, EvacZoneProps } from './types'
import { timeFmt } from '../lib/time'

const LA24 = timeFmt('America/Los_Angeles', '24h')

function zone(id: string, status: string | null, key: EvacZoneProps['status_key'], rings: number[][][], extra: Partial<EvacZoneProps> = {}): EvacZoneFeature {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Polygon', coordinates: rings },
    properties: {
      zone_id: id,
      zone_name: null,
      status,
      status_key: key,
      county: 'TEST',
      jurisdiction: 'Test County',
      city_code: null,
      event_type: null,
      notes: null,
      critical_info: null,
      public_info: null,
      status_updated_ms: null,
      aggregated_ms: null,
      ...extra,
    },
  }
}

const square = (x0: number, y0: number, s: number) => [
  [x0, y0],
  [x0 + s, y0],
  [x0 + s, y0 + s],
  [x0, y0 + s],
  [x0, y0],
]

function withZones(features: EvacZoneFeature[], status: EvacuationsResponse['status'] = 'available', bbox: EvacuationsResponse['bbox'] = [-1, -1, 60, 60]): EvacuationsResponse {
  return { ...EVAC_SAMPLE, status, bbox, zones: { type: 'FeatureCollection', features } }
}

describe('evacuation status and wording', () => {
  it('counts zones per verbatim official wording, most urgent first', () => {
    const counts = evacStatusCounts(EVAC_SAMPLE)
    expect(counts.map((c) => [c.status, c.count, c.group])).toEqual([
      ['Evacuation Order', 1, 'order'],
      ['Evacuation Warning', 2, 'warning'],
    ])
  })

  it('never invents a status: a missing one says so', () => {
    expect(statusText({ status: null })).toBe('Status not stated by the source')
    expect(statusText({ status: '  Evacuation Warning ' })).toBe('Evacuation Warning')
  })

  it('shows nothing and counts nothing for past dates or outages', () => {
    expect(evacStatusCounts(withZones(EVAC_SAMPLE.zones.features, 'not_available_for_past_dates'))).toEqual([])
    expect(evacDisplayData(withZones(EVAC_SAMPLE.zones.features, 'unavailable')).features).toEqual([])
    expect(evacuationLayerGroup(withZones([], 'available'))).toBeNull()
    expect(evacuationFeedItems(withZones(EVAC_SAMPLE.zones.features, 'not_available_for_past_dates'), null)).toEqual([])
  })

  it('hides Normal and Training zones on the map but keeps the official wording on shown ones', () => {
    const data = withZones([
      zone('a', 'Evacuation Order', 'order', [square(0, 0, 1)]),
      zone('b', 'Normal', 'normal', [square(2, 0, 1)]),
      zone('c', 'Training', 'training', [square(4, 0, 1)]),
      zone('d', 'Shelter in Place', 'shelter', [square(6, 0, 1)]),
      zone('e', 'Advisory', 'advisory', [square(8, 0, 1)]),
    ])
    const fc = evacDisplayData(data)
    expect(fc.features.map((f) => [f.properties?.id, f.properties?.group, f.properties?.label])).toEqual([
      ['a', 'order', 'Evacuation Order'],
      ['d', 'order', 'Shelter in Place'],
      ['e', 'other', 'Advisory'],
    ])
    expect(evacuationLegend(data).map((e) => e.label)).toEqual(['Evacuation Order', 'Shelter in Place', 'Advisory'])
  })
})

describe('evacuation map layers', () => {
  it('builds cross-hatched fills, styled outlines and verbatim labels', () => {
    const g = evacuationLayerGroup(EVAC_SAMPLE)!
    expect(Object.keys(g.images ?? {})).toEqual(Object.values(EVAC_PATTERN_IDS))
    const ids = g.layers.map((l) => l.spec.id)
    expect(ids).toEqual([EVAC_LAYERS.tint, EVAC_LAYERS.hatch, EVAC_LAYERS.lineOther, EVAC_LAYERS.lineWarning, EVAC_LAYERS.lineOrder, EVAC_LAYERS.label])
    expect(g.layers.filter((l) => l.placement === 'top').map((l) => l.spec.id)).toEqual([EVAC_LAYERS.label])
    const warning = g.layers.find((l) => l.spec.id === EVAC_LAYERS.lineWarning)!.spec as { paint: Record<string, unknown> }
    const order = g.layers.find((l) => l.spec.id === EVAC_LAYERS.lineOrder)!.spec as { paint: Record<string, unknown> }
    expect(warning.paint['line-dasharray']).toEqual([3, 2])
    expect(order.paint['line-dasharray']).toBeUndefined()
    expect(order.paint['line-color']).toBe('#e0459b')
    const img = g.images![EVAC_PATTERN_IDS.order]
    expect(img.pixelRatio).toBe(2)
    expect(img.data.length).toBe(img.width * img.height * 4)
  })

  it('legend entries say official, current and how many zones', () => {
    const l = evacuationLegend(EVAC_SAMPLE)
    expect(l[0]).toMatchObject({ layer: 'evacuation', label: 'Evacuation Order', detail: 'official · 1 zone · current status' })
    expect(l[0].swatch).toMatchObject({ kind: 'hatch', line: 'solid', color: '#e0459b' })
    expect(l[1].swatch).toMatchObject({ kind: 'hatch', line: 'dashed', color: '#a78bfa' })
  })
})

describe('zones at a point', () => {
  const data = withZones([
    zone('warn', 'Evacuation Warning', 'warning', [square(0, 0, 10), square(4, 4, 2)]), // with a hole
    zone('order', 'Evacuation Order', 'order', [square(5, 5, 4)]),
    {
      ...zone('multi', 'Advisory', 'advisory', []),
      geometry: { type: 'MultiPolygon', coordinates: [[square(20, 20, 1)], [square(30, 30, 1)]] },
    },
  ])

  it('handles holes, multipolygons and orders the result by urgency', () => {
    expect(zonesAtPoint(data, 1, 1).map((z) => z.id)).toEqual(['warn'])
    expect(zonesAtPoint(data, 4.5, 4.5).map((z) => z.id)).toEqual([]) // inside the hole of 'warn', outside 'order'
    expect(zonesAtPoint(data, 5.5, 5.5).map((z) => z.id)).toEqual(['order']) // hole of 'warn', inside 'order'
    expect(zonesAtPoint(data, 7, 7).map((z) => z.id)).toEqual(['order', 'warn'])
    expect(zonesAtPoint(data, 30.5, 30.5).map((z) => z.id)).toEqual(['multi'])
    expect(zonesAtPoint(data, 50, 50)).toEqual([])
    expect(zonesAtPoint(withZones(data.zones.features, 'not_available_for_past_dates'), 7, 7)).toEqual([])
  })

  it('says "not checked" outside the queried area, never "none listed" (brief 2 U-R1, G13)', () => {
    expect(evacuationAtPoint(data, 7, 7)).toMatchObject({ checked: true })
    expect(evacuationAtPoint(data, 50, 50)).toEqual({ checked: true, zones: [] }) // checked, nothing there
    expect(evacuationAtPoint(data, 70, 70)).toEqual({ checked: false, zones: [] }) // outside the bbox
    const small = withZones(data.zones.features, 'available', [0, 0, 5, 5])
    expect(evacuationAtPoint(small, 7, 7)).toEqual({ checked: false, zones: [] }) // a zone is there, but outside the bbox
    expect(zonesAtPoint(small, 7, 7)).toEqual([])
    expect(evacuationAtPoint(withZones(data.zones.features, 'not_available_for_past_dates'), 7, 7).checked).toBe(false)
    expect(evacuationAtPoint(withZones(data.zones.features, 'unavailable'), 7, 7).checked).toBe(false)
    expect(evacuationAtPoint(null, 7, 7).checked).toBe(false)
    expect(evacuationAtPoint(data, Number.NaN, 7).checked).toBe(false)
  })

  it('bounds zones for "Show on map" (outer rings, multipolygons)', () => {
    expect(zonesBounds(data.zones.features)).toEqual([0, 0, 31, 31])
    expect(zonesBounds([data.zones.features[1]])).toEqual([5, 5, 9, 9])
    expect(zonesBounds([])).toBeNull()
  })

  it('finds a real zone from the recorded Cal OES sample', () => {
    const z = EVAC_SAMPLE.zones.features[0]
    const c = zonesCentre([z])!
    expect(zonesAtPoint(EVAC_SAMPLE, c[0], c[1]).map((f) => f.id)).toContain(z.id)
  })
})

describe('panel details and feed items', () => {
  it('labels who set each time and keeps the official message verbatim', () => {
    const z = zoneDetail(EVAC_SAMPLE.zones.features[0], EVAC_SAMPLE.now_ms, LA24)
    expect(z.status).toBe('Evacuation Order')
    expect(z.jurisdiction).toBe('Los Angeles County')
    expect(z.updatedText).toMatch(/^Updated by the issuer Oct 1[45], \d\d:\d\d PDT$/)
    expect(z.message).toBe(EVAC_SAMPLE.zones.features[0].properties.notes)
    const none = zoneDetail(zone('x', 'Evacuation Warning', 'warning', [square(0, 0, 1)]), EVAC_SAMPLE.now_ms, LA24)
    expect(none.updatedText).toBe('Update time not given by the issuer')
  })

  it('makes one official, non-seekable item per status and jurisdiction, located at the zones', () => {
    const grid = { center_e: 340000, center_n: 3775000, utm_zone: 11 }
    const items = evacuationFeedItems(EVAC_SAMPLE, { grid } as never)
    expect(items).toHaveLength(2)
    for (const it of items) {
      expect(it).toMatchObject({ topic: 'evacuation', kind: 'official', automated: false, seekable: false, eventId: null, approximate: true, status: 'active' })
      expect(it.location).not.toBeNull()
      expect(it.detail).toContain('Issued by local officials; listed by Cal OES')
      expect(it.detail).toContain('not an evacuation instruction')
      expect(it.checkedMs).toBe(EVAC_SAMPLE.retrieved_ms)
      expect(it.url).toBe('https://gis.data.ca.gov/datasets/CalEMA::california-evacuation-aggregation-layer')
      expect(it.bounds).toEqual(zonesBounds(EVAC_SAMPLE.zones.features.filter((z) => it.highlight?.kind === 'evacuation' && it.highlight.zoneIds.includes(z.id))))
    }
    const order = items.find((i) => i.title.startsWith('Evacuation Order'))!
    expect(order.title).toBe('Evacuation Order: 1 zone (Los Angeles County)')
    expect(order.key).toBe(true) // no fire given: nothing says it lies outside the fire's area
    expect(order.tMs).toBe(EVAC_SAMPLE.zones.features[0].properties.status_updated_ms)
    expect(order.updatedMs).toBe(order.tMs)
    expect(order.issuer).toBe('Los Angeles County')
    expect(order.source).toBe('Los Angeles County via Cal OES')
    expect(order.timeNotGiven).toBe(false)
    const noGrid = evacuationFeedItems(EVAC_SAMPLE, null)
    expect(noGrid.every((i) => i.location === null && i.approximate === false)).toBe(true)
  })

  it("times an item by the issuer, else Cal OES's copy, else the layer's own time; never Fire-3d's fetch (U-R1)", () => {
    const a = zone('a', 'Evacuation Order', 'order', [square(0, 0, 1)], { aggregated_ms: 1_000 })
    const items = evacuationFeedItems(withZones([a]), null)
    expect(items[0].tMs).toBe(1_000)
    expect(items[0].updatedMs).toBeNull()
    expect(items[0].notes?.join(' ')).toMatch(/The issuer gives no time; Cal OES listed it/)
    const b = zone('b', 'Evacuation Order', 'order', [square(0, 0, 1)])
    const layerTime = evacuationFeedItems({ ...withZones([b]), source_updated_ms: 2_000, retrieved_ms: 9_000 }, null)
    expect(layerTime[0]).toMatchObject({ tMs: 2_000, timeNotGiven: false })
    const none = evacuationFeedItems({ ...withZones([b]), source_updated_ms: null, retrieved_ms: 9_000 }, null)
    expect(none[0]).toMatchObject({ tMs: 9_000, timeNotGiven: true, checkedMs: 9_000 })
    expect(zoneTimes({ status_updated_ms: 0, aggregated_ms: 5 })).toEqual({ issuerMs: null, aggregatedMs: 5 })
  })

  it('names the distance to the fire and says Cal OES does not name the fire outside its area (U-R1, G2)', () => {
    // fire around (0.5, 0.5); analysis area [0, 0]-[1, 1]; one zone 0.1° away, one far outside
    const fire: FireReference = { points: [[0.5, 0.5]], rings: [], aoi: [[0, 0], [1, 0], [1, 1], [0, 1]], perimeterMs: null, detections: 0 }
    const near = zone('near', 'Evacuation Order', 'order', [square(0.9, 0.9, 0.5)], { status_updated_ms: 5 })
    const far = zone('far', 'Evacuation Warning', 'warning', [square(3, 3, 0.5)], { jurisdiction: null, county: 'Orange', status_updated_ms: 6 })
    const items = evacuationFeedItems(withZones([near, far]), null, { fire, metric: true })
    const n = items.find((i) => i.id.includes('near') || i.title.startsWith('Evacuation Order'))!
    const f = items.find((i) => i.title.startsWith('Evacuation Warning'))!
    // ~63 km from the reported point (0.4° in each direction), but it overlaps the analysis area
    expect(n.distanceKm).toBeGreaterThan(60)
    expect(n.distanceKm).toBeLessThan(65)
    expect(n.key).toBe(true)
    expect(n.notes).not.toContain(NOT_FIRE_SPECIFIC)
    expect(f.issuer).toBe('Orange County')
    expect(f.title).toBe('Evacuation Warning: 1 zone (Orange County)')
    expect(f.distanceKm).toBeGreaterThan(250)
    expect(f.detail).toMatch(/^\d[\d,.]* km from the fire\. Cal OES does not say which fire this is for\./)
    expect(f.notes).toContain(NOT_FIRE_SPECIFIC)
    expect(f.highlight).toEqual({ kind: 'evacuation', id: f.id, zoneIds: ['far'] })
    // an order outside the fire's area is listed, but not as a key event of this fire
    const farOrder = evacuationFeedItems(withZones([{ ...far, properties: { ...far.properties, status: 'Evacuation Order', status_key: 'order' } }]), null, { fire })
    expect(farOrder[0].key).toBe(false)
  })

  it('names the issuer from the jurisdiction, else the county, else local officials', () => {
    expect(zoneIssuer({ jurisdiction: ' Ventura County ', county: 'Ventura' })).toBe('Ventura County')
    expect(zoneIssuer({ jurisdiction: null, county: 'Orange' })).toBe('Orange County')
    expect(zoneIssuer({ jurisdiction: '', county: 'Los Angeles County' })).toBe('Los Angeles County')
    expect(zoneIssuer({ jurisdiction: null, county: null })).toBe('Local officials')
  })

  it('links the county map (https only)', () => {
    const z = zone('c', 'Evacuation Order', 'order', [square(0, 0, 1)], { county: 'Ventura' })
    const cov = (url: string) => [{ county: 'Ventura', in_statewide_layer: true, acquisition_status: null, zone_source: null, reference_url: url }]
    expect(evacuationFeedItems({ ...withZones([z]), coverage: cov('https://ventura.example.gov/map') }, null)[0].links).toEqual([{ label: 'County evacuation map', url: 'https://ventura.example.gov/map' }])
    expect(evacuationFeedItems({ ...withZones([z]), coverage: cov('http://insecure.example.gov/map') }, null)[0].links).toEqual([])
    expect(evacuationFeedItems({ ...withZones([z]), coverage: cov('javascript:alert(1)') }, null)[0].links).toEqual([])
  })
})
