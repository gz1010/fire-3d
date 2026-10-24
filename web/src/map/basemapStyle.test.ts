import type { LayerSpecification, StyleSpecification } from 'maplibre-gl'
import { describe, expect, it } from 'vitest'
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import {
  AERIAL_MAJOR_ROAD,
  AERIAL_TINT,
  aerialTintPaint,
  BUILDING_COLORS,
  BUILDINGS_3D_LAYER,
  BUILDINGS_MINZOOM,
  buildingsCaveat,
  deriveAerial,
  deriveDark,
  deriveRoads,
  fallbackStyle,
  guardComparisons,
  HILLSHADE_LAYER,
  HILLSHADE_SOURCE,
  IMAGERY_LAYER,
  IMAGERY_SOURCE,
  isStyle,
  labelsLast,
  TERRAIN_SOURCE,
} from './basemapStyle'

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
      { ...vec('building', 'fill'), minzoom: 13, maxzoom: 14 } as LayerSpecification,
      { id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14, paint: { 'fill-extrusion-color': 'hsl(35,8%,85%)', 'fill-extrusion-height': ['get', 'render_height'] } } as LayerSpecification,
      vec('road_minor_casing', 'line'),
      vec('road_major_primary', 'line'),
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

  it('dark: neutral grey palette, terrain shading above land areas and below water lines / roads, labels last', () => {
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
    expect(bg.paint['background-color']).toBe('#0c0c0c')
    expect(d.style.sources[HILLSHADE_SOURCE]).toMatchObject({ type: 'raster-dem', encoding: 'terrarium', tileSize: 512 })
    expect(d.style.sources[TERRAIN_SOURCE]).toMatchObject({ type: 'raster-dem', encoding: 'terrarium' })
    expect(d.style.sources[HILLSHADE_SOURCE]).not.toBe(d.style.sources[TERRAIN_SOURCE])
    expect(d.vector).toBe(true)
    // the input is not modified
    expect(ids(b)).toEqual(ids(base()))
  })

  it('roads: liberty apart from shading, DEM sources, label order and the muted 3D buildings', () => {
    const r = deriveRoads(base())
    expect(ids(r.style).filter((i) => i !== HILLSHADE_LAYER && i !== BUILDINGS_3D_LAYER).sort()).toEqual(ids(base()).filter((i) => i !== 'building-3d').sort())
    expect(r.style.sources[TERRAIN_SOURCE]).toBeDefined()
    // liberty's bright extrusion is replaced; its flat footprints stay at every zoom for the 2D map
    expect(r.style.layers.filter((l) => l.type === 'fill-extrusion').map((l) => l.id)).toEqual([BUILDINGS_3D_LAYER])
    expect((r.style.layers.find((l) => l.id === 'building') as { maxzoom?: number }).maxzoom).toBeUndefined()
  })

  it('3D buildings: one muted, hidden extrusion per basemap directly below the labels; overlays go below it', () => {
    for (const [name, d] of [
      ['dark', deriveDark(base())],
      ['roads', deriveRoads(base())],
      ['aerial', deriveAerial(base())],
    ] as const) {
      const order = ids(d.style)
      const i = order.indexOf(BUILDINGS_3D_LAYER)
      expect(i).toBeGreaterThan(0)
      expect(order[i + 1]).toBe(d.labelLayerId)
      expect(d.overlayBeforeId).toBe(BUILDINGS_3D_LAYER)
      const b = d.style.layers[i] as unknown as { minzoom: number; layout: Record<string, unknown>; paint: Record<string, unknown>; source: string }
      expect(b.layout.visibility).toBe('none')
      expect(b.source).toBe('openmaptiles')
      expect(b.paint['fill-extrusion-color']).toBe(BUILDING_COLORS[name])
      // fades in from z14.5 to full (0.6) at z15
      expect(b.minzoom).toBe(14.5)
      expect(b.paint['fill-extrusion-opacity']).toEqual(['interpolate', ['linear'], ['zoom'], 14.5, 0, BUILDINGS_MINZOOM, 0.6])
      expect(b.paint['fill-extrusion-height']).toEqual(['coalesce', ['get', 'render_height'], 0])
      expect(validateStyleMin({ ...d.style, glyphs: 'https://example.com/{fontstack}/{range}.pbf' } as never)).toEqual([])
    }
    expect(BUILDING_COLORS).toEqual({ dark: '#555555', roads: '#a8a095', aerial: '#c3c9d1' })
    expect(buildingsCaveat(true)).toBe("3D shapes: today's OpenStreetMap; buildings destroyed by this fire may be missing; not a damage assessment")
    expect(buildingsCaveat(false)).toContain('destroyed by a fire may be missing')
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
    // the default tint is today's fire-view look (brief 4 decision j)
    expect(img.paint['raster-saturation']).toBe(-0.6)
    expect(img.paint['raster-brightness-max']).toBe(0.68)
    const label = a.style.layers.find((l) => l.id === 'place_city') as { paint: Record<string, unknown> }
    expect(label.paint['text-halo-width']).toBeGreaterThan(1)
    // major roads at about 0.45 alpha so they do not compete with the fire edge
    const major = a.style.layers.find((l) => l.id === 'road_major_primary') as { paint: Record<string, unknown> }
    expect(major.paint['line-color']).toBe(AERIAL_MAJOR_ROAD)
    expect(AERIAL_MAJOR_ROAD).toMatch(/0\.45\)$/)
    expect(order).not.toContain('building-3d')
  })

  it('tint (brief 4 decision j): paint on the photo layer only, greyer on the national overview, none = as published', () => {
    expect(AERIAL_TINT.overview.saturation).toBeLessThanOrEqual(-0.8)
    expect(AERIAL_TINT.fire).toEqual({ saturation: -0.6, brightnessMax: 0.68 })
    expect(AERIAL_TINT.none).toEqual({ saturation: 0, brightnessMax: 1 })
    expect(aerialTintPaint('overview')).toEqual({ 'raster-saturation': AERIAL_TINT.overview.saturation, 'raster-brightness-max': AERIAL_TINT.overview.brightnessMax })
    for (const level of ['overview', 'fire', 'none'] as const) {
      const a = deriveAerial(base(), level)
      const img = a.style.layers.find((l) => l.id === IMAGERY_LAYER) as unknown as { paint: Record<string, number> }
      expect(img.paint).toMatchObject(aerialTintPaint(level))
      expect(img.paint['raster-contrast']).toBe(0.06)
      // only the photos carry the tint: no other layer's colour depends on it
      const others = a.style.layers.filter((l) => l.id !== IMAGERY_LAYER)
      expect(JSON.stringify(others)).toBe(JSON.stringify(deriveAerial(base(), 'fire').style.layers.filter((l) => l.id !== IMAGERY_LAYER)))
      const f = fallbackStyle('aerial', level).style.layers.find((l) => l.id === IMAGERY_LAYER) as unknown as { paint: Record<string, number> }
      expect(f.paint).toEqual(aerialTintPaint(level))
    }
    // the dark and road maps have no photo layer to tint (dark is neutral grey already; Roads stay as published)
    expect(ids(deriveDark(base()).style)).not.toContain(IMAGERY_LAYER)
    expect(ids(deriveRoads(base()).style)).not.toContain(IMAGERY_LAYER)
  })

  it('fallback keeps a usable map without OpenFreeMap (no labels, says so via vector: false)', () => {
    for (const b of ['dark', 'roads', 'aerial'] as const) {
      const f = fallbackStyle(b)
      expect(f.vector).toBe(false)
      expect(f.labelLayerId).toBeNull()
      expect(f.overlayBeforeId).toBeNull()
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
