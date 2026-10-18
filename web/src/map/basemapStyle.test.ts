import type { LayerSpecification, StyleSpecification } from 'maplibre-gl'
import { describe, expect, it } from 'vitest'
import { deriveAerial, deriveDark, deriveRoads, fallbackStyle, guardComparisons, HILLSHADE_LAYER, HILLSHADE_SOURCE, IMAGERY_LAYER, IMAGERY_SOURCE, isStyle, labelsLast, TERRAIN_SOURCE } from './basemapStyle'

const vec = (id: string, type: 'fill' | 'line' | 'symbol', paint: Record<string, unknown> = {}): LayerSpecification =>
  ({ id, type, source: 'openmaptiles', 'source-layer': 'x', paint }) as LayerSpecification

/** A miniature of OpenFreeMap's styles (real layer ids and order, trimmed). */
function base(): StyleSpecification {
  return {
    version: 8,
    sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': 'rgb(12,12,12)' } },
      vec('water', 'fill'),
      vec('landuse_residential', 'fill'),
      vec('landcover_wood', 'fill', { 'fill-pattern': 'wood-pattern', 'fill-color': 'rgb(32,32,32)' }),
      vec('landuse_park', 'fill'),
      vec('waterway', 'line'),
      vec('water_name', 'symbol'),
      vec('building', 'fill'),
      vec('road_minor_casing', 'line'),
      vec('road_minor', 'line'),
      vec('road_major_rail_hatching', 'line'),
      vec('highway_name_other', 'symbol'),
      vec('boundary_state', 'line'),
      vec('place_city', 'symbol'),
    ],
  }
}

const ids = (s: StyleSpecification) => s.layers.map((l) => l.id)

describe('basemap styles', () => {
  it('labelsLast keeps order and reports the first label layer', () => {
    const { layers, labelLayerId } = labelsLast(base().layers)
    expect(labelLayerId).toBe('water_name')
    expect(layers.slice(-3).map((l) => l.id)).toEqual(['water_name', 'highway_name_other', 'place_city'])
    expect(layers.filter((l) => l.type !== 'symbol').map((l) => l.id)[0]).toBe('background')
  })

  it('dark: navy palette, terrain shading above land areas and below water lines / roads, labels last', () => {
    const b = base()
    const d = deriveDark(b)
    const order = ids(d.style)
    expect(order.indexOf(HILLSHADE_LAYER)).toBe(order.indexOf('landuse_park') + 1)
    expect(order.indexOf(HILLSHADE_LAYER)).toBeLessThan(order.indexOf('waterway'))
    expect(order.indexOf(HILLSHADE_LAYER)).toBeLessThan(order.indexOf('road_minor'))
    expect(d.labelLayerId).toBe('water_name')
    expect(order.slice(-3)).toEqual(['water_name', 'highway_name_other', 'place_city'])
    const wood = d.style.layers.find((l) => l.id === 'landcover_wood') as { paint: Record<string, unknown> }
    expect(wood.paint['fill-pattern']).toBeUndefined() // missing sprite image in OpenFreeMap's sprite
    const bg = d.style.layers[0] as { paint: Record<string, unknown> }
    expect(bg.paint['background-color']).toBe('#0b1119')
    expect(d.style.sources[HILLSHADE_SOURCE]).toMatchObject({ type: 'raster-dem', encoding: 'terrarium', tileSize: 512 })
    expect(d.style.sources[TERRAIN_SOURCE]).toMatchObject({ type: 'raster-dem', encoding: 'terrarium' })
    expect(d.style.sources[HILLSHADE_SOURCE]).not.toBe(d.style.sources[TERRAIN_SOURCE])
    expect(d.vector).toBe(true)
    // the input is not modified
    expect(ids(b)).toEqual(ids(base()))
  })

  it('roads: liberty unchanged apart from shading, DEM sources and label order', () => {
    const r = deriveRoads(base())
    expect(ids(r.style).filter((i) => i !== HILLSHADE_LAYER).sort()).toEqual(ids(base()).sort())
    expect(r.style.sources[TERRAIN_SOURCE]).toBeDefined()
  })

  it('aerial: imagery right above the background, area fills / casings / hatching dropped, roads and labels kept', () => {
    const a = deriveAerial(base())
    const order = ids(a.style)
    expect(order[0]).toBe('background')
    expect(order[1]).toBe(IMAGERY_LAYER)
    for (const dropped of ['water', 'landuse_residential', 'landcover_wood', 'landuse_park', 'building', 'road_minor_casing', 'road_major_rail_hatching'])
      expect(order).not.toContain(dropped)
    for (const kept of ['road_minor', 'boundary_state', 'water_name', 'highway_name_other', 'place_city']) expect(order).toContain(kept)
    expect(a.style.sources[IMAGERY_SOURCE]).toMatchObject({ type: 'raster', tileSize: 256, maxzoom: 16 })
    const img = a.style.layers[1] as unknown as { paint: Record<string, number> }
    expect(img.paint['raster-saturation']).toBeLessThan(0)
    expect(img.paint['raster-brightness-max']).toBeLessThan(1)
    const label = a.style.layers.find((l) => l.id === 'place_city') as { paint: Record<string, unknown> }
    expect(label.paint['text-halo-width']).toBeGreaterThan(1)
  })

  it('fallback keeps a usable map without OpenFreeMap (no labels, says so via vector: false)', () => {
    for (const b of ['dark', 'roads', 'aerial'] as const) {
      const f = fallbackStyle(b)
      expect(f.vector).toBe(false)
      expect(f.labelLayerId).toBeNull()
      expect(Object.keys(f.style.sources)).not.toContain('openmaptiles')
      expect(f.style.sources[TERRAIN_SOURCE]).toBeDefined()
      expect(ids(f.style).includes(IMAGERY_LAYER)).toBe(b === 'aerial')
    }
  })

  it('guards ordering comparisons on possibly missing properties (no null warnings, same result)', () => {
    const f = ['all', ['match', ['geometry-type'], ['Point'], true, false], ['>=', ['get', 'rank'], 7], ['<', ['get', 'rank'], 20], ['==', ['get', 'class'], 'x']]
    expect(guardComparisons(f)).toEqual([
      'all',
      ['match', ['geometry-type'], ['Point'], true, false],
      ['all', ['has', 'rank'], ['>=', ['get', 'rank'], 7]],
      ['all', ['has', 'rank'], ['<', ['get', 'rank'], 20]],
      ['==', ['get', 'class'], 'x'],
    ])
  })

  it('isStyle checks the document shape', () => {
    expect(isStyle(base())).toBe(true)
    expect(isStyle({ version: 7, layers: [], sources: {} })).toBe(false)
    expect(isStyle(null)).toBe(false)
  })
})
