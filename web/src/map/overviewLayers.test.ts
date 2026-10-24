import { createPropertyExpression, latest, validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { describe, expect, it } from 'vitest'
import type { IncidentSummary } from '../api/types'
import { overviewFires } from '../state/overview'
import {
  CHIP_IMAGE,
  CHIP_NEXT_ANCHORS,
  CHIP_TEXT,
  chipImage,
  chipText,
  CLUSTER,
  CLUSTER_CLICK_MAX_ZOOM,
  clusterClickZoom,
  clusterHoverText,
  DIM_OPACITY,
  DOT_PX,
  anchorOffsets,
  CARD_RING_PX,
  GROUP_TEXT_OFFSET,
  GROUP_TICK_IMAGE,
  GROUP_TICK_OFFSET,
  groupLabelText,
  groupRadius,
  groupTickImage,
  isPinned,
  isSmallActive,
  LABEL_ANCHORS,
  LABEL_R_MAX_PX,
  labelOffsetEm,
  labelRadialOffset,
  labelMinZoom,
  labelSide,
  NARROW_LABEL_MAX_ZOOM,
  narrowLabelAnchorOffset,
  markerKind,
  markerRadius,
  MARKER_MAX_PX,
  MARKER_MIN_PX,
  MARKER_PX,
  OVERVIEW_CHIP_LAYERS,
  OVERVIEW_CLUSTER_LAYERS,
  OVERVIEW_FIRE_LAYERS,
  OVERVIEW_GROUPS,
  OVERVIEW_HIT_LAYERS,
  OVERVIEW_SOURCES,
  overviewData,
  overviewFeatures,
  overviewFilters,
  overviewLabel,
  overviewLayers,
  overviewPaint,
  overviewSourceOptions,
  OVR,
  pickFireHit,
  selectedFilter,
  sortKey,
  splitOverview,
  ZOOM_GROWTH,
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
    uid: 'u',
    record_source: 'calfire',
    record_issuer: 'CAL FIRE',
    state: null,
    time_zone: 'America/Los_Angeles',
    ...over,
  }
}
const active = (id: string, acres: number | null, over: Partial<IncidentSummary> = {}) => fire({ id, mode: 'live', is_active: true, acres, percent_contained: null, ...over })

function style(layers: unknown[]) {
  const sources = Object.fromEntries(OVERVIEW_GROUPS.map((g) => [OVERVIEW_SOURCES[g], overviewSourceOptions(g, 1440)]))
  return { version: 8 as const, glyphs: 'https://example.com/{fontstack}/{range}.pbf', sources, layers }
}

describe('overview markers', () => {
  it('size says the type (brief 4, HANDOFF): small active r7, active r11, large active r15, not active r4.5', () => {
    expect(markerKind(active('a', 0))).toBe('small')
    expect(markerKind(active('a', null))).toBe('small')
    expect(markerKind(active('a', 9.9))).toBe('small')
    expect(markerKind(active('a', 10))).toBe('active')
    expect(markerKind(active('a', 4_999))).toBe('active')
    expect(markerKind(active('a', 5_000))).toBe('large')
    expect(markerKind(fire({ acres: 172_912 }))).toBe('other')
    expect([active('a', 1), active('a', 100), active('a', 172_912), fire({ acres: 60_000 })].map(markerRadius)).toEqual([7, 11, 15, 4.5])
    expect(MARKER_PX).toEqual({ small: 7, active: 11, large: 15, other: 4.5 })
    expect([MARKER_MIN_PX, MARKER_MAX_PX]).toEqual([4.5, 15])
    // the white-hot centre dot: active fires only (a fire that is not active is a hollow ring)
    expect(DOT_PX).toEqual({ small: 1.4, active: 2.2, large: 2.8, other: 0 })
  })

  it('features carry their type, radius and dot; the pinned source draws large fires at r15', () => {
    const fc = overviewFeatures([active('l', 172_912), active('s', 2), fire({ id: 'o', acres: 900 })], 'us')
    expect(fc.features.map((f) => [f.properties.kind, f.properties.r, f.properties.dot])).toEqual([
      ['large', 15, 2.8],
      ['small', 7, 1.4],
      ['other', 4.5, 0],
    ])
  })

  it('labels read "Name · acres" (no trailing "Fire"), hectares in metric, names verbatim otherwise', () => {
    expect(overviewLabel('Garnet Fire', 59_844, 'us')).toBe('Garnet · 59,844 ac')
    expect(overviewLabel('Cooley', 731.4, 'us')).toBe('Cooley · 731 ac')
    expect(overviewLabel('Garnet Fire', 59_844, 'metric')).toBe('Garnet · 24,218 ha')
    expect(overviewLabel('Unknown Fire', null, 'us')).toBe('Unknown')
    expect(overviewLabel('Fire', 10, 'us')).toBe('Fire · 10 ac')
    expect(overviewLabel('Fd140011', 3, 'us')).toBe('Fd140011 · 3 ac')
    // small fires: one decimal, never "0 ac" (Hulsey Bench, AZ, 0.1 ac)
    expect(overviewLabel('Hulsey Bench', 0.1, 'us')).toBe('Hulsey Bench · 0.1 ac')
    expect(overviewLabel('Pines 1', 6.04, 'us')).toBe('Pines 1 · 6 ac')
    expect(overviewLabel('Roper', 2.5, 'us')).toBe('Roper · 2.5 ac')
    expect(overviewLabel('Tiny', 0.01, 'us')).toBe('Tiny · under 0.1 ac')
    expect(overviewLabel('Tiny', 0.5, 'metric')).toBe('Tiny · 0.2 ha')
  })
})

describe('label zoom thresholds (§14.11)', () => {
  it('pinned fires at every zoom', () => {
    expect(labelMinZoom(active('p', 5_000), true)).toBe(0)
    expect(labelMinZoom(fire({ acres: 2 }), true)).toBe(0)
  })
  it('from z5: active fires of 300 ac or more, any fire of 20,000 ac or more', () => {
    expect(labelMinZoom(active('a', 300))).toBe(5)
    expect(labelMinZoom(active('a', 4_999))).toBe(5)
    expect(labelMinZoom(fire({ acres: 20_000 }))).toBe(5)
    expect(labelMinZoom(fire({ acres: 19_999 }))).toBe(7)
  })
  it('from z7: active fires of 10 ac or more, any fire of 1,000 ac or more', () => {
    expect(labelMinZoom(active('a', 10))).toBe(7)
    expect(labelMinZoom(active('a', 299))).toBe(7)
    expect(labelMinZoom(fire({ acres: 1_000 }))).toBe(7)
  })
  it('the rest from z9: small active fires (under 10 ac or no size) and smaller other fires', () => {
    expect(labelMinZoom(active('a', 9.9))).toBe(9)
    expect(labelMinZoom(active('a', null))).toBe(9)
    expect(labelMinZoom(active('a', 0))).toBe(9)
    expect(labelMinZoom(fire({ acres: 999 }))).toBe(9)
  })
  it('priority by acres; activity a bonus only at 300 ac or more (a tiny active fire never beats a large one)', () => {
    expect(sortKey(fire({ acres: 90_000 }))).toBeGreaterThan(sortKey(active('a', 0)))
    expect(sortKey(fire({ acres: 90_000 }))).toBeGreaterThan(sortKey(active('a', 299)))
    expect(sortKey(active('a', 300))).toBeGreaterThan(sortKey(fire({ acres: 90_000 })))
    expect(sortKey(fire({ acres: 2_000 }))).toBeGreaterThan(sortKey(fire({ acres: 1_000 })))
  })
  it('the label layers show a label only once the zoom reaches its threshold', () => {
    const lbl = overviewLayers('dark').find((l) => l.id === OVR.activeLabel) as unknown as { layout: Record<string, unknown> }
    const tf = lbl.layout['text-field'] as unknown[]
    expect(tf[0]).toBe('step')
    expect(tf[1]).toEqual(['zoom'])
    expect(tf.filter((x) => typeof x === 'number')).toEqual([5, 7, 9])
  })
})

describe('three sources (§14.11): pinned, active, other', () => {
  const rows = [
    active('big', 172_912),
    active('pin-edge', 5_000),
    active('mid', 4_999),
    active('tiny', 0.1),
    active('nosize', null),
    fire({ id: 'out', acres: 60_000, is_active: false }),
    fire({ id: 'past', acres: 400 }),
    fire({ id: 'bad', lat: Number.NaN }),
  ]
  it('splits active fires >= 5,000 ac to pinned, other active fires to active, the rest to other', () => {
    const s = splitOverview(rows)
    expect(s.pinned.map((f) => f.id)).toEqual(['big', 'pin-edge'])
    expect(s.active.map((f) => f.id)).toEqual(['mid', 'tiny', 'nosize'])
    expect(s.other.map((f) => f.id)).toEqual(['out', 'past'])
  })
  it('active and other fires never share a source', () => {
    const s = splitOverview(rows)
    expect(s.active.every((f) => f.is_active)).toBe(true)
    expect(s.other.every((f) => !f.is_active && f.mode !== 'live')).toBe(true)
  })
  it('the fire whose card is open moves to the pinned source (selection ring, label)', () => {
    const s = splitOverview(rows, { cardId: 'past' })
    expect(s.pinned.map((f) => f.id)).toContain('past')
    expect(s.other.map((f) => f.id)).toEqual(['out'])
    expect(isPinned(fire({ id: 'past' }), 'past')).toBe(true)
    expect(isPinned(fire({ id: 'past' }), null)).toBe(false)
  })
  it('hidden fires (the open one; in a replay, not started yet) are removed from the data, not filtered', () => {
    const s = splitOverview(rows, { hidden: ['big', 'tiny', 'out'] })
    const ids = [...s.pinned, ...s.active, ...s.other].map((f) => f.id)
    expect(ids).not.toContain('big')
    expect(ids).not.toContain('tiny')
    expect(ids).not.toContain('out')
    expect(ids).toHaveLength(4)
    const data = overviewData(s, 'us')
    expect(data.active.features.map((f) => f.properties.id)).toEqual(['mid', 'nosize'])
    // a hidden fire with an open card stays hidden
    expect(splitOverview(rows, { hidden: new Set(['past']), cardId: 'past' }).pinned.map((f) => f.id)).not.toContain('past')
  })
  it('features: pinned ones labelled at every zoom; small active fires flagged; hit radius >= 11 px', () => {
    const data = overviewData(splitOverview(rows), 'us')
    const pin = data.pinned.features.map((f) => f.properties)
    expect(pin.every((p) => p.lz === 0 && p.small === false)).toBe(true)
    const act = Object.fromEntries(data.active.features.map((f) => [f.properties.id, f.properties]))
    expect(act.tiny.small).toBe(true)
    expect(act.nosize.small).toBe(true)
    expect(act.mid.small).toBe(false)
    expect(act.mid.lz).toBe(5)
    for (const fc of Object.values(data)) for (const f of fc.features) expect(f.properties.hit as number).toBeGreaterThanOrEqual(11)
    expect(isSmallActive(active('a', 9.99))).toBe(true)
    expect(isSmallActive(active('a', 10))).toBe(false)
    expect(isSmallActive(fire({ acres: 1 }))).toBe(false)
  })
  it('draws exactly the shell overview set (season = live ∪ season, deduplicated)', () => {
    const live = [active('l1', 50)]
    const season = [fire({ id: 'l1', acres: 800 }), fire({ id: 's1', acres: 2000 })]
    const s = splitOverview(overviewFires({ live, season, historical: [] }, 'season'))
    expect([...s.pinned, ...s.active, ...s.other].map((f) => f.id).sort()).toEqual(['l1', 's1'])
  })
  it('unprepared fires carry the chip prompt; the start time and state ride along', () => {
    expect(chipText('ready')).toBe('')
    expect(chipText('none')).toBe(CHIP_TEXT)
    expect(chipText('error')).toBe(CHIP_TEXT)
    expect(chipText('building')).toMatch(/being prepared/)
    expect(CHIP_TEXT).toBe('Spread not prepared yet · Prepare analysis (1-3 min)')
    const fc = overviewFeatures([fire({ id: 'r', bundle_status: 'ready', started_ms: 5, state: 'CO' }), fire({ id: 'n', bundle_status: 'none' })], 'us')
    expect(fc.features.map((f) => [f.properties.ready, f.properties.chip !== '', f.properties.start, f.properties.state])).toEqual([
      [true, false, 5, 'CO'],
      [false, true, 0, ''],
    ])
  })
})

describe('groups (MapLibre clustering)', () => {
  it('source options: pinned never clustered; active radius 28 (44 under 500 px), z6; other radius 40, z7; min 3', () => {
    expect(overviewSourceOptions('pinned', 1440)).not.toHaveProperty('cluster')
    expect(overviewSourceOptions('active', 1440)).toMatchObject({ cluster: true, clusterRadius: 28, clusterMaxZoom: 6, clusterMinPoints: 3 })
    expect(overviewSourceOptions('active', 390)).toMatchObject({ clusterRadius: 44 })
    expect(overviewSourceOptions('other', 1440)).toMatchObject({ cluster: true, clusterRadius: 40, clusterMaxZoom: 7, clusterMinPoints: 3 })
    expect(overviewSourceOptions('other', 390)).toMatchObject({ clusterRadius: 40 })
    expect((overviewSourceOptions('active', 1440) as { clusterProperties: Record<string, unknown> }).clusterProperties).toEqual({
      max_acres: ['max', ['get', 'acres']],
      small: ['+', ['case', ['get', 'small'], 1, 0]],
    })
    expect(CLUSTER.active.maxZoom).toBeLessThan(CLUSTER.other.maxZoom)
  })
  it('a group click zooms to min(expansion zoom, 8), at least one level in, never out', () => {
    expect(clusterClickZoom(5, 3)).toBe(5)
    expect(clusterClickZoom(11, 6)).toBe(CLUSTER_CLICK_MAX_ZOOM)
    // at least one level in, even when the group's expansion zoom is at or under the view's (review R6)
    expect(clusterClickZoom(4, 5)).toBe(6)
    expect(clusterClickZoom(4, 3.92)).toBeCloseTo(4.92)
    expect(clusterClickZoom(9, 8.5)).toBe(8.5)
    expect(clusterClickZoom(Number.NaN, 3)).toBe(5)
    expect(CLUSTER_CLICK_MAX_ZOOM).toBeLessThan(8.5)
  })
  it('hover text: count, largest fire, small ones, click to zoom in', () => {
    expect(clusterHoverText({ group: 'active', count: 61, maxAcres: 606, small: 57 }, 'us')).toBe(
      '61 active fires · largest 606 ac · 57 under 10 ac or size not reported · click to zoom in',
    )
    expect(clusterHoverText({ group: 'other', count: 1203, maxAcres: 12_345.6, small: 0 }, 'us', 'other 2026 fires')).toBe(
      '1,203 other 2026 fires · largest 12,346 ac · click to zoom in',
    )
    expect(clusterHoverText({ group: 'active', count: 3, maxAcres: 0, small: 3 }, 'metric')).toBe('3 active fires · 3 under 10 ac or size not reported · click to zoom in')
  })
  it('groups are sized by how many fires they hold (brief 4, decision e): 10 + 4.2·√n px, at most 36', () => {
    expect(groupRadius(4)).toBeCloseTo(18.4, 5)
    expect(groupRadius(28)).toBeCloseTo(32.2, 1)
    expect(groupRadius(1000)).toBe(36)
    expect(groupRadius(0)).toBe(10)
    for (const id of [OVR.activeCluster, OVR.otherCluster]) {
      const c = overviewLayers('dark').find((l) => l.id === id) as unknown as { paint: Record<string, unknown> }
      const r = c.paint['circle-radius']
      expect(JSON.stringify(r)).toContain('point_count')
      expect(JSON.stringify(r)).not.toContain('max_acres')
      // evaluated as MapLibre does
      const spec = (latest as unknown as { paint_circle: Record<string, never> }).paint_circle['circle-radius']
      const parsed = createPropertyExpression(r as never, spec)
      expect(parsed.result).toBe('success')
      const expr = parsed.value as unknown as { evaluate: (g: { zoom: number }, f: unknown) => number }
      const at = (n: number) => expr.evaluate({ zoom: 4 }, { type: 'Point', properties: { point_count: n }, geometry: { type: 'Point', coordinates: [0, 0] } })
      expect(at(4)).toBeCloseTo(10 + 4.2 * 2, 5)
      expect(at(28)).toBeCloseTo(10 + 4.2 * Math.sqrt(28), 5)
      expect(at(500)).toBe(36)
    }
  })

  it('group labels: "28 FIRES" at the circle\'s upper right, after a short tick (Noto Sans; counts never overlap)', () => {
    const c = overviewLayers('dark').find((l) => l.id === OVR.activeCount) as unknown as { layout: Record<string, unknown>; paint: Record<string, unknown> }
    expect(c.layout['text-field']).toEqual(groupLabelText('#ffb27a'))
    expect(JSON.stringify(c.layout['text-field'])).toContain(' FIRES')
    expect(c.layout['text-font']).toEqual(['Noto Sans Bold'])
    expect(c.layout['icon-image']).toBe(GROUP_TICK_IMAGE.dark)
    // counts collide with each other (review DF-H34-1): the larger group is placed first, a blocked tick is optional
    expect(c.layout['text-allow-overlap']).toBe(false)
    expect(c.layout['icon-allow-overlap']).toBe(false)
    expect(c.layout['icon-optional']).toBe(true)
    expect(c.layout['symbol-sort-key']).toEqual(['-', 0, ['to-number', ['get', 'point_count'], 0]])
    expect(c.layout['icon-offset']).toBe(GROUP_TICK_OFFSET)
    expect(c.layout['text-offset']).toBe(GROUP_TEXT_OFFSET)
    // the tick starts on the circle's edge at 45° (up and to the right) for any group size
    const spec = (latest as unknown as { layout_symbol: Record<string, never> }).layout_symbol['icon-offset']
    const parsed = createPropertyExpression(GROUP_TICK_OFFSET as never, spec)
    expect(parsed.result).toBe('success')
    const expr = parsed.value as unknown as { evaluate: (g: { zoom: number }, f: unknown) => number[] }
    for (const n of [3, 10, 28, 39, 400]) {
      const [x, y] = expr.evaluate({ zoom: 4 }, { type: 'Point', properties: { point_count: n }, geometry: { type: 'Point', coordinates: [0, 0] } })
      expect(Math.hypot(x, y)).toBeCloseTo(groupRadius(Math.min(n, 39)), 0)
      expect(x).toBeGreaterThan(0)
      expect(y).toBeLessThan(0)
    }
    const tick = groupTickImage('dark')
    expect(tick.image.data.length).toBe(tick.image.width * tick.image.height * 4)
    expect(tick.options.pixelRatio).toBe(2)
  })
})

describe('layers', () => {
  it('chip filters: only the chip targets, single points only in the grouped sources', () => {
    const f = overviewFilters(['near'])
    expect(Object.keys(f).sort()).toEqual([...OVERVIEW_CHIP_LAYERS].sort())
    expect(f[OVR.pinnedChip]).toEqual(['all', ['!=', ['get', 'chip'], ''], ['in', ['get', 'id'], ['literal', ['near']]]])
    expect(f[OVR.activeChip]).toEqual(['all', ['!', ['has', 'point_count']], ['all', ['!=', ['get', 'chip'], ''], ['in', ['get', 'id'], ['literal', ['near']]]]])
    expect(f[OVR.pinnedChipNext]).toEqual(['all', ['!=', ['get', 'chip'], ''], ['in', ['get', 'id'], ['literal', []]]])
    expect(selectedFilter('a')).toEqual(['==', ['get', 'id'], 'a'])
    expect(selectedFilter(null)).toEqual(['==', ['get', 'id'], ''])
  })

  it('two nearby chips never overlap, and the chip of the fire nearest the view centre always shows (final fixes R8)', () => {
    // chipTargets lists the nearest fire first: its chip is in the "first" layers, the next fire's in the "next" ones
    const f = overviewFilters(['near', 'next'])
    const ids = (filter: unknown) => JSON.stringify(filter).match(/"literal",(\[[^\]]*\])/)?.[1]
    for (const id of [OVR.pinnedChip, OVR.activeChip, OVR.otherChip]) expect(ids(f[id])).toBe('["near"]')
    for (const id of [OVR.pinnedChipNext, OVR.activeChipNext, OVR.otherChipNext]) expect(ids(f[id])).toBe('["next"]')
    const layers = overviewLayers('dark')
    const layout = (id: string) => (layers.find((l) => l.id === id) as unknown as { layout: Record<string, unknown> }).layout
    // the first chip is always drawn (and still claims its place); the next ones give way and may move around their marker
    for (const id of [OVR.pinnedChip, OVR.activeChip, OVR.otherChip]) {
      expect(layout(id)['text-allow-overlap']).toBe(true)
      expect(layout(id)['text-ignore-placement']).toBeUndefined()
      expect(layout(id)['text-anchor']).toBe('top')
    }
    for (const id of [OVR.pinnedChipNext, OVR.activeChipNext, OVR.otherChipNext]) {
      expect(layout(id)['text-allow-overlap']).toBe(false)
      expect(layout(id)['icon-allow-overlap']).toBe(false)
      expect(layout(id)['text-variable-anchor-offset']).toEqual(CHIP_NEXT_ANCHORS)
      expect(layout(id)['icon-image']).toBe(CHIP_IMAGE.dark)
    }
    // MapLibre places the top symbol layers first: every "first" chip layer sits above every "next" one
    const order = layers.map((l) => l.id)
    const lowestFirst = Math.min(...[OVR.pinnedChip, OVR.activeChip, OVR.otherChip].map((id) => order.indexOf(id)))
    const highestNext = Math.max(...[OVR.pinnedChipNext, OVR.activeChipNext, OVR.otherChipNext].map((id) => order.indexOf(id)))
    expect(lowestFirst).toBeGreaterThan(highestNext)
    // and both sit above the labels, which give way to them
    expect(highestNext).toBeGreaterThan(order.indexOf(OVR.pinnedLabel))
    // a valid style (the variable anchors with their offsets included)
    expect(validateStyleMin(style(layers.map((l) => (l.id in f ? { ...l, filter: f[l.id] } : l))) as never)).toEqual([])
  })

  it('markers are lighter while a fire is open (rings, centre dots, groups, labels)', () => {
    expect(overviewPaint(false)[OVR.activePoint]['circle-opacity']).toBe(1)
    expect(overviewPaint(true)[OVR.activePoint]['circle-opacity']).toBe(DIM_OPACITY)
    expect(overviewPaint(true)[OVR.activeCluster]['circle-opacity']).toBe(DIM_OPACITY)
    for (const id of [OVR.activeDot, OVR.pinnedDot, OVR.activeClusterDot, OVR.otherClusterDot]) expect(overviewPaint(true)[id]['circle-opacity']).toBe(DIM_OPACITY)
    expect(overviewPaint(true)[OVR.pinnedLabel]['text-opacity']).toBeLessThan(1)
    expect(overviewPaint(true)[OVR.activeCount]['icon-opacity']).toBeLessThan(1)
  })

  it('the screens\' colours (brief 4): transparent orange circles, #ffc08a rings, white-hot dots, hollow #f0d9b0 rings', () => {
    const layers = overviewLayers('dark') as unknown as { id: string; paint: Record<string, unknown> }[]
    const paint = (id: string) => layers.find((l) => l.id === id)?.paint ?? {}
    expect(paint(OVR.activePoint)['circle-color']).toBe('rgba(255,138,60,0.10)')
    expect(paint(OVR.activePoint)['circle-stroke-color']).toBe('rgba(255,192,138,0.8)')
    expect(paint(OVR.activeDot)['circle-color']).toBe('#fff3dc')
    expect(paint(OVR.otherPoint)['circle-stroke-color']).toBe('rgba(240,217,176,0.8)')
    // full size at a desktop's national zoom (about z3.9) and to z7, 1.2x by z10, 0.65x on a phone's national view (z2)
    const spec = (latest as unknown as { paint_circle: Record<string, never> }).paint_circle['circle-radius']
    const parsed = createPropertyExpression(paint(OVR.activePoint)['circle-radius'] as never, spec)
    expect(parsed.result).toBe('success')
    const expr = parsed.value as unknown as { evaluate: (g: { zoom: number }, f: unknown) => number }
    const at = (zoom: number) => expr.evaluate({ zoom }, { type: 'Point', properties: { r: 11 }, geometry: { type: 'Point', coordinates: [0, 0] } })
    expect(at(3.9)).toBeCloseTo(11, 5)
    expect(at(7)).toBeCloseTo(11, 5)
    expect(at(10)).toBeCloseTo(13.2, 5)
    expect(at(2)).toBeCloseTo(11 * 0.65, 5)
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
    const chip = overviewLayers('dark').find((l) => l.id === OVR.pinnedChip) as unknown as { layout: Record<string, unknown> }
    expect(chip.layout['icon-image']).toBe(CHIP_IMAGE.dark)
  })

  it('valid MapLibre layers on every theme (with the chip filters set); hit layers exist and are invisible', () => {
    for (const theme of ['dark', 'light', 'aerial'] as const) {
      const f = overviewFilters(['a', 'b'])
      const layers = overviewLayers(theme).map((l) => (l.id in f ? { ...l, filter: f[l.id] } : l))
      expect(validateStyleMin(style(layers) as never)).toEqual([])
      const ids = layers.map((l) => l.id)
      for (const h of OVERVIEW_HIT_LAYERS) expect(ids).toContain(h)
      for (const id of [OVR.pinnedHit, OVR.activeHit, OVR.otherHit]) {
        const hit = layers.find((l) => l.id === id) as unknown as { paint: Record<string, unknown> }
        expect(hit.paint['circle-opacity']).toBe(0)
      }
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('narrow maps (phones): the labels grow towards the middle of the country at the national zoom (R7)', () => {
    // sides across the lower 48: the coasts of CA/OR/WA, the interior West, the middle, the East, the Atlantic coast
    expect([-122.4, -112, -98.6, -84.4, -71.1].map(labelSide)).toEqual(['ww', 'w', 'c', 'e', 'ee'])
    // a west-coast label is never placed to the left of its fire ('right' anchor), an east-coast one never to its right
    for (const side of ['ww', 'w'] as const) expect(LABEL_ANCHORS[side]).not.toContain('right')
    for (const side of ['e', 'ee'] as const) expect(LABEL_ANCHORS[side]).not.toContain('left')
    expect(anchorOffsets(['left', 'top'], 6)).toEqual(['left', [0.95, 0], 'top', [0, 0.95]])
    // only narrow maps carry the per-side anchors; wide maps keep the radial offset
    const label = (narrow: boolean) => (overviewLayers('dark', { narrow }).find((l) => l.id === OVR.pinnedLabel) as unknown as { layout: Record<string, unknown> }).layout
    expect(label(false)['text-variable-anchor-offset']).toBeUndefined()
    expect(label(false)['text-variable-anchor']).toEqual(['top', 'bottom', 'right', 'left'])
    expect(label(true)['text-variable-anchor-offset']).toEqual(narrowLabelAnchorOffset())
    for (const theme of ['dark', 'light', 'aerial'] as const) expect(validateStyleMin(style(overviewLayers(theme, { narrow: true })) as never)).toEqual([])
    // evaluated as MapLibre does: by side below z3, the default anchors from z3, the offset following the marker radius
    const spec = (latest as unknown as { layout_symbol: Record<string, never> }).layout_symbol['text-variable-anchor-offset']
    const parsed = createPropertyExpression(narrowLabelAnchorOffset() as never, spec)
    expect(parsed.result).toBe('success')
    const expr = parsed.value as unknown as { evaluate: (g: { zoom: number }, f: unknown) => { values: unknown[] } }
    const at = (zoom: number, side: string, lr: number) => expr.evaluate({ zoom }, { type: 'Point', properties: { side, lr }, geometry: { type: 'Point', coordinates: [0, 0] } }).values
    // (at the label-radius stops: the offsets in between are interpolated, as MapLibre does)
    expect(at(2.1, 'ww', LABEL_R_MAX_PX)).toEqual(anchorOffsets(['left'], LABEL_R_MAX_PX))
    expect(at(2.1, 'ee', MARKER_MIN_PX)).toEqual(anchorOffsets(['right'], MARKER_MIN_PX))
    expect(at(2.1, 'w', LABEL_R_MAX_PX)).toEqual(anchorOffsets(LABEL_ANCHORS.w, LABEL_R_MAX_PX))
    expect(at(2.1, 'c', LABEL_R_MAX_PX)).toEqual(anchorOffsets(LABEL_ANCHORS.c, LABEL_R_MAX_PX))
    expect(at(NARROW_LABEL_MAX_ZOOM, 'ww', LABEL_R_MAX_PX)).toEqual(anchorOffsets(LABEL_ANCHORS.c, LABEL_R_MAX_PX))
    // features carry their side
    const fc = overviewFeatures([fire({ id: 'a', lon: -121.5, lat: 40 })], 'us')
    expect(fc.features[0].properties?.side).toBe('ww')
  })

  it('labels keep clear of their marker when zoomed in, and of the card\'s selection ring', () => {
    const spec = (latest as unknown as { layout_symbol: Record<string, never> }).layout_symbol['text-radial-offset']
    const parsed = createPropertyExpression(labelRadialOffset() as never, spec)
    expect(parsed.result).toBe('success')
    const expr = parsed.value as unknown as { evaluate: (g: { zoom: number }, f: unknown) => number }
    const at = (zoom: number, lr: number) => expr.evaluate({ zoom }, { type: 'Point', properties: { lr }, geometry: { type: 'Point', coordinates: [0, 0] } })
    // 12 px text: the label starts this many px from the marker centre
    const px = (em: number) => em * 12
    expect(px(at(5, MARKER_PX.large))).toBeCloseTo(px(labelOffsetEm(MARKER_PX.large)))
    expect(px(at(10, MARKER_PX.large))).toBeGreaterThan(MARKER_PX.large * ZOOM_GROWTH + 4)
    // the card fire: its label radius covers the ring (r + 6, stroke 2.5) at every zoom
    const pinned = overviewFeatures([active('l', 172_912), active('s', 2)], 'us', { pinned: true, cardId: 's' }).features
    const lr = (id: string) => pinned.find((f) => f.properties?.id === id)?.properties?.lr as number
    expect(lr('l')).toBe(MARKER_PX.large)
    expect(lr('s')).toBe(MARKER_PX.small + CARD_RING_PX)
    expect(CARD_RING_PX).toBeGreaterThanOrEqual(6 + 2.5 / 2)
    for (const z of [5, 7, 8.5, 10]) expect(px(at(z, lr('s')))).toBeGreaterThan((MARKER_PX.small + 6) * (z >= 10 ? ZOOM_GROWTH : 1) + 1.25)
    expect(overviewData(splitOverview([active('s', 2)], { cardId: 's' }), 'us', 's').pinned.features[0].properties?.lr).toBe(MARKER_PX.small + CARD_RING_PX)
  })

  it('draw order: active marks above other fires, pinned above both; labels above markers, pinned labels placed first', () => {
    const ids = overviewLayers('dark').map((l) => l.id)
    const at = (id: string) => ids.indexOf(id)
    expect(at(OVR.activeCluster)).toBeGreaterThan(at(OVR.otherPoint))
    expect(at(OVR.activePoint)).toBeGreaterThan(at(OVR.otherCluster))
    expect(at(OVR.pinnedLive)).toBeGreaterThan(at(OVR.activeCluster))
    expect(at(OVR.otherLabel)).toBeGreaterThan(at(OVR.pinnedLive))
    // brief 4: the groups' "N FIRES" sit outside their circles, above the fire names, which are placed after them and
    // keep clear of them (the counts are placed first)
    expect(at(OVR.activeCount)).toBeGreaterThan(at(OVR.pinnedLabel))
    expect(at(OVR.otherCount)).toBeGreaterThan(at(OVR.pinnedLabel))
    expect(at(OVR.pinnedLabel)).toBeGreaterThan(at(OVR.activeLabel))
    expect(at(OVR.activeLabel)).toBeGreaterThan(at(OVR.otherLabel))
    // the selection ring reads only the pinned source (the open card's fire is always there)
    const sel = overviewLayers('dark').find((l) => l.id === OVR.selected) as unknown as { source: string }
    expect(sel.source).toBe(OVERVIEW_SOURCES.pinned)
  })

  it('fire layers and group layers are disjoint; single-fire layers in grouped sources exclude groups', () => {
    for (const id of OVERVIEW_CLUSTER_LAYERS) expect(OVERVIEW_FIRE_LAYERS).not.toContain(id)
    const layers = overviewLayers('dark') as unknown as { id: string; source: string; filter?: unknown }[]
    for (const l of layers)
      if (OVERVIEW_FIRE_LAYERS.includes(l.id) && l.source !== OVERVIEW_SOURCES.pinned) expect(JSON.stringify(l.filter)).toContain('"!",["has","point_count"]')
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
  })
})
