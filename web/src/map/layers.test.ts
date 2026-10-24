import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { describe, expect, it } from 'vitest'
import { AERIAL_CASING, AERIAL_CLOSE_FILL_OPACITY, drapedLayers, incidentLabelField, LAYER_GROUPS, LYR, SRC, topLayers, type MapTheme } from './layers'

const THEMES: MapTheme[] = ['dark', 'light', 'aerial']

type Paint = Record<string, unknown>
const paint = (theme: MapTheme, id: string, top = false): Paint =>
  ((top ? topLayers(theme) : drapedLayers(theme)).find((l) => l.id === id) as unknown as { paint: Paint }).paint
const layout = (theme: MapTheme, id: string): Paint => (topLayers(theme).find((l) => l.id === id) as unknown as { layout: Paint }).layout

describe('wildfire layers', () => {
  it('are valid MapLibre layers on every theme', () => {
    for (const [theme, preset] of THEMES.flatMap((t) => [[t, 'public'], [t, 'command']] as const)) {
      const geo = { type: 'geojson' as const, data: { type: 'FeatureCollection' as const, features: [] } }
      const canvas = { type: 'canvas' as const, canvas: 'c', coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] }
      const sources: Record<string, unknown> = {}
      for (const id of Object.values(SRC)) sources[id] = id === SRC.observedRaster || id === SRC.forecastRaster ? canvas : geo
      const style = { version: 8, glyphs: 'https://example.com/{fontstack}/{range}.pbf', sprite: 'https://example.com/sprite', sources, layers: [...drapedLayers(theme), ...topLayers(theme, preset)] }
      const errors = validateStyleMin(style as never).filter((e) => !/canvas|sprite/i.test(e.message))
      expect(errors).toEqual([])
    }
  })

  it('aerial: dark casings directly under the perimeter and modeled-area lines; none on the other themes', () => {
    const ids = drapedLayers('aerial').map((l) => l.id)
    expect(ids.indexOf(LYR.perimetersCasing)).toBe(ids.indexOf(LYR.perimetersOld) - 1)
    expect(ids.indexOf(LYR.aoiCasing)).toBe(ids.indexOf(LYR.aoiLine) - 1)
    expect(paint('aerial', LYR.aoiCasing)['line-color']).toBe(AERIAL_CASING)
    expect(paint('aerial', LYR.aoiCasing)['line-width'] as number).toBeGreaterThan(paint('aerial', LYR.aoiLine)['line-width'] as number)
    for (const theme of ['dark', 'light'] as const) {
      const other = drapedLayers(theme).map((l) => l.id)
      expect(other).not.toContain(LYR.perimetersCasing)
      expect(other).not.toContain(LYR.aoiCasing)
    }
    // the casings follow the perimeter toggle, as do other fires' perimeter outlines (decision 10)
    expect(LAYER_GROUPS.perimeters).toContain(LYR.perimetersCasing)
    for (const id of [LYR.nearbyCasing, LYR.nearbyLine, LYR.nearbyLabel]) expect(LAYER_GROUPS.perimeters).toContain(id)
    expect(ids.indexOf(LYR.nearbyCasing)).toBe(ids.indexOf(LYR.nearbyLine) - 1)
    // other fires' outlines: lighter and dashed
    expect(paint('dark', LYR.nearbyLine)['line-dasharray']).toEqual([3, 2])
    expect(paint('dark', LYR.nearbyLine)['line-opacity']).toBeLessThan(1)
  })

  it('aerial: from z13 a lighter observed fill and outline-only, fainter footprints', () => {
    expect(paint('aerial', LYR.observedRaster)['raster-opacity']).toEqual(['interpolate', ['linear'], ['zoom'], 12.5, 1, 13.5, AERIAL_CLOSE_FILL_OPACITY])
    expect(paint('dark', LYR.observedRaster)['raster-opacity']).toBe(1)
    expect(paint('aerial', LYR.detectionsFill)['fill-opacity']).toBe(0)
    expect(paint('dark', LYR.detectionsFill)['fill-opacity']).toBe(0.08)
    const op = paint('aerial', LYR.detectionsLine)['line-opacity'] as unknown[]
    expect(op[3]).toBeLessThan(0.6)
    // the fire edge keeps its full strength
    expect(paint('aerial', LYR.observedEdge)).toEqual(paint('dark', LYR.observedEdge))
  })

  it('aerial: 12 px area and perimeter labels with wider halos', () => {
    expect(layout('aerial', LYR.aoiLabel)['text-size']).toBe(12)
    expect(paint('aerial', LYR.aoiLabel, true)['text-halo-width']).toBe(1.6)
    expect(layout('dark', LYR.aoiLabel)['text-size']).toBe(10.5)
    expect(layout('aerial', LYR.perimetersLabel)['text-size']).toBe(12)
  })

  it('the reported location has an invisible touch target of at least 22 px', () => {
    for (const theme of THEMES) {
      const hit = paint(theme, LYR.incidentHit, true)
      expect(hit['circle-opacity']).toBe(0)
      expect((hit['circle-radius'] as number) * 2).toBeGreaterThanOrEqual(22)
    }
  })

  it('labels the reported location "Reported location" in Public and "REPORTED" in Command (the screen)', () => {
    expect(incidentLabelField()).toEqual(incidentLabelField('public'))
    expect(JSON.stringify(incidentLabelField('public'))).toContain('"Reported location"')
    expect(JSON.stringify(incidentLabelField('command'))).toContain('"REPORTED"')
    const field = (preset: 'public' | 'command') => (topLayers('dark', preset).find((l) => l.id === LYR.incidentLabel) as unknown as { layout: Paint }).layout['text-field']
    expect(field('command')).toEqual(incidentLabelField('command'))
    expect(field('public')).toEqual(incidentLabelField('public'))
    // the fire's name comes first in both
    expect(incidentLabelField('command').slice(0, 2)).toEqual(['format', ['get', 'name']])
  })
})
