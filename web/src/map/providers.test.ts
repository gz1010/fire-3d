import { describe, expect, it } from 'vitest'
import { activeCredits, BASEMAP_STYLE, USGS_IMAGERY_MAXZOOM, USGS_IMAGERY_TILE_SIZE, USGS_IMAGERY_TILES } from './providers'

const ids = (...a: Parameters<typeof activeCredits>) => activeCredits(...a).map((c) => c.id)

describe('provider configuration', () => {
  it('uses the documented endpoints', () => {
    expect(BASEMAP_STYLE.dark).toBe('https://tiles.openfreemap.org/styles/dark')
    expect(BASEMAP_STYLE.roads).toBe('https://tiles.openfreemap.org/styles/liberty')
    expect(USGS_IMAGERY_TILES).toBe('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}')
    expect(USGS_IMAGERY_TILE_SIZE).toBe(256)
    expect(USGS_IMAGERY_MAXZOOM).toBe(16)
  })
})

describe('activeCredits', () => {
  it('credits OpenFreeMap / OpenMapTiles / OSM, terrain shading and MapLibre on the vector basemaps', () => {
    expect(ids('dark', '2d')).toEqual(['openfreemap', 'openmaptiles', 'osm', 'mapterhorn', 'maplibre'])
    expect(ids('roads', '3d')).toEqual(['openfreemap', 'openmaptiles', 'osm', 'mapterhorn', 'maplibre'])
  })
  it('credits USGS imagery on the aerial basemap and Mapterhorn only when 3D terrain is drawn', () => {
    expect(ids('aerial', '2d')).toEqual(['openfreemap', 'openmaptiles', 'osm', 'usgs', 'maplibre'])
    expect(ids('aerial', '3d')).toEqual(['openfreemap', 'openmaptiles', 'osm', 'usgs', 'mapterhorn', 'maplibre'])
  })
  it('drops the credits of failed providers (they draw nothing) but always keeps MapLibre', () => {
    expect(ids('dark', '3d', { terrainOk: false })).toEqual(['openfreemap', 'openmaptiles', 'osm', 'maplibre'])
    expect(ids('aerial', '2d', { imageryOk: false })).toEqual(['openfreemap', 'openmaptiles', 'osm', 'maplibre'])
    expect(ids('dark', '2d', { vectorOk: false, terrainOk: false })).toEqual(['maplibre'])
  })
  it('names the terrain sources and the imagery provider', () => {
    const all = activeCredits('aerial', '3d')
    expect(all.find((c) => c.id === 'mapterhorn')?.text).toMatch(/Mapterhorn.*USGS 3DEP.*Copernicus/)
    expect(all.find((c) => c.id === 'usgs')?.text).toMatch(/USDA, USGS/)
    for (const c of all) if (c.href) expect(c.href).toMatch(/^https:\/\//)
  })
})
