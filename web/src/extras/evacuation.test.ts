import { describe, expect, it } from 'vitest'
import { EVAC_SAMPLE } from './__fixtures__/samples'
import {
  EVAC_LAYERS,
  EVAC_PATTERN_IDS,
  evacDisplayData,
  evacStatusCounts,
  evacuationFeedItems,
  evacuationLayerGroup,
  evacuationLegend,
  statusText,
  zoneDetail,
  zonesAtPoint,
  zonesBounds,
  zonesCentre,
} from './evacuation'
import type { EvacuationsResponse, EvacZoneFeature, EvacZoneProps } from './types'

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

function withZones(features: EvacZoneFeature[], status: EvacuationsResponse['status'] = 'available'): EvacuationsResponse {
  return { ...EVAC_SAMPLE, status, zones: { type: 'FeatureCollection', features } }
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
    const z = zoneDetail(EVAC_SAMPLE.zones.features[0], EVAC_SAMPLE.now_ms)
    expect(z.status).toBe('Evacuation Order')
    expect(z.jurisdiction).toBe('Los Angeles County')
    expect(z.updatedText).toMatch(/^Updated by the issuer Oct 1[45], \d\d:\d\d PDT$/)
    expect(z.message).toBe(EVAC_SAMPLE.zones.features[0].properties.notes)
    const none = zoneDetail(zone('x', 'Evacuation Warning', 'warning', [square(0, 0, 1)]), EVAC_SAMPLE.now_ms)
    expect(none.updatedText).toBe('Update time not given by the issuer')
  })

  it('makes one official, non-seekable item per status and jurisdiction, located at the zones', () => {
    const grid = { center_e: 340000, center_n: 3775000, utm_zone: 11 }
    const items = evacuationFeedItems(EVAC_SAMPLE, { grid } as never)
    expect(items).toHaveLength(2)
    for (const it of items) {
      expect(it).toMatchObject({ topic: 'evacuation', kind: 'official', automated: false, seekable: false, eventId: null, approximate: true })
      expect(it.location).not.toBeNull()
      expect(it.detail).toContain('Current official status as of')
      expect(it.detail).toContain('not an evacuation instruction')
    }
    const order = items.find((i) => i.title.startsWith('Evacuation Order'))!
    expect(order.title).toBe('Evacuation Order: 1 zone (Los Angeles County)')
    expect(order.key).toBe(true)
    expect(order.tMs).toBe(EVAC_SAMPLE.zones.features[0].properties.status_updated_ms)
    expect(order.source).toBe('Los Angeles County via Cal OES')
    const noGrid = evacuationFeedItems(EVAC_SAMPLE, null)
    expect(noGrid.every((i) => i.location === null && i.approximate === false)).toBe(true)
  })
})
