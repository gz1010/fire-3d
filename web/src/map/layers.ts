// Wildfire and context layers of the Public/Command map (owner: map-core). Distinguishable by colour AND line style or
// fill pattern (BRIEF §5, §9): observed fire = solid fill + solid glowing edge; modeled spread = diagonal hatch +
// dashed / dotted outlines; agency perimeters = thin solid (latest) or dashed (earlier) lines with time labels;
// satellite detections = true-size sensor footprints (outlined squares, filled only when recent; GOES dashed),
// drawn beneath the fire edges; modeled area = dashed light line with "Outside modeled area" labels outside it;
// events = white dots; reported location = ring + label.
// Fills, rasters and lines go directly below the basemap's first label layer (draped on terrain in 3D); point markers
// and our own labels go on top of the basemap labels.
import type { LayerSpecification } from 'maplibre-gl'
import { TOKENS } from './overlayModel'

export const SRC = {
  observedRaster: 'fx-observed-raster',
  forecastRaster: 'fx-forecast-raster',
  observedEdge: 'fx-observed-edge',
  forecastLines: 'fx-forecast-lines',
  forecastHatch: 'fx-forecast-hatch',
  perimeters: 'fx-perimeters',
  detections: 'fx-detections',
  detectionPoints: 'fx-detection-points',
  aoi: 'fx-aoi',
  aoiLabels: 'fx-aoi-labels',
  events: 'fx-events',
  incident: 'fx-incident',
} as const

export const LYR = {
  forecastRaster: 'fx-forecast-raster',
  observedRaster: 'fx-observed-raster',
  forecastHatch: 'fx-forecast-hatch',
  forecastLine10: 'fx-forecast-line-10',
  forecastLine50: 'fx-forecast-line-50',
  observedGlow: 'fx-observed-glow',
  observedEdge: 'fx-observed-edge',
  perimetersOld: 'fx-perimeters-old',
  perimetersLatest: 'fx-perimeters-latest',
  detectionsFill: 'fx-detections-fill',
  detectionsLine: 'fx-detections-line',
  detectionsGoes: 'fx-detections-goes',
  detectionsDot: 'fx-detections-dot',
  aoiLine: 'fx-aoi-line',
  eventsCircle: 'fx-events-circle',
  incidentCircle: 'fx-incident-circle',
  perimetersLabel: 'fx-perimeters-label',
  aoiLabel: 'fx-aoi-label',
  eventsLabel: 'fx-events-label',
  incidentLabel: 'fx-incident-label',
} as const

export const HATCH_IMAGE = 'fx-hatch'

/** Label / line colours for our layers: 'light' text on the dark and aerial basemaps, 'dark' text on the road map. */
export type MapTheme = 'dark' | 'light'

const THEME = {
  dark: { ink: TOKENS.text, halo: 'rgba(8,12,18,0.92)', aoi: TOKENS.aoi, aoiText: 'rgba(232,237,243,0.82)', perimText: '#ffc2a6', marker: TOKENS.text, eventStroke: TOKENS.textInverse },
  light: { ink: '#16202b', halo: 'rgba(255,255,255,0.92)', aoi: 'rgba(22,32,43,0.72)', aoiText: '#26313d', perimText: '#9a3412', marker: '#16202b', eventStroke: '#16202b' },
} as const

/** Below this zoom detections are dots at the pixel centre; from it on, true-size sensor footprints. */
export const FOOTPRINT_MINZOOM = 13

/** Fonts available from OpenFreeMap's glyph server. */
const FONT_REGULAR = ['Noto Sans Regular']
const FONT_BOLD = ['Noto Sans Bold']

/** Layers that may be toggled per workspace layer key. */
export const LAYER_GROUPS = {
  observed: [LYR.observedRaster, LYR.observedGlow, LYR.observedEdge],
  forecast: [LYR.forecastRaster, LYR.forecastHatch, LYR.forecastLine10, LYR.forecastLine50],
  perimeters: [LYR.perimetersOld, LYR.perimetersLatest, LYR.perimetersLabel],
  detections: [LYR.detectionsFill, LYR.detectionsLine, LYR.detectionsGoes, LYR.detectionsDot],
  events: [LYR.eventsCircle, LYR.eventsLabel],
} as const

/** Draped layers (inserted below the basemap labels), bottom to top. */
export function drapedLayers(theme: MapTheme = 'dark'): LayerSpecification[] {
  const t = THEME[theme]
  return [
    {
      id: LYR.forecastRaster,
      type: 'raster',
      source: SRC.forecastRaster,
      paint: { 'raster-resampling': 'nearest', 'raster-fade-duration': 0, 'raster-opacity': 1 },
    },
    {
      id: LYR.observedRaster,
      type: 'raster',
      source: SRC.observedRaster,
      paint: { 'raster-resampling': 'nearest', 'raster-fade-duration': 0, 'raster-opacity': 1 },
    },
    {
      id: LYR.detectionsFill,
      type: 'fill',
      source: SRC.detections,
      minzoom: FOOTPRINT_MINZOOM,
      filter: ['==', ['get', 'age'], 0],
      // footprints overlap heavily on large fires (hundreds per pass): a light wash and thin outlines keep the fire,
      // the forecast and the roads readable underneath
      paint: { 'fill-color': TOKENS.detection, 'fill-opacity': 0.08 },
    },
    {
      id: LYR.detectionsLine,
      type: 'line',
      source: SRC.detections,
      minzoom: FOOTPRINT_MINZOOM,
      filter: ['!=', ['get', 'age'], 2],
      paint: {
        'line-color': ['match', ['get', 'age'], 0, TOKENS.detection, TOKENS.detectionOld],
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 14, 1.2],
        'line-opacity': ['match', ['get', 'age'], 0, 0.6, 0.25],
      },
    },
    {
      id: LYR.detectionsGoes,
      type: 'line',
      source: SRC.detections,
      minzoom: FOOTPRINT_MINZOOM,
      filter: ['==', ['get', 'age'], 2],
      paint: { 'line-color': TOKENS.detection, 'line-width': 1, 'line-opacity': 0.4, 'line-dasharray': [2, 2] },
    },
    {
      id: LYR.detectionsDot,
      type: 'circle',
      source: SRC.detectionPoints,
      maxzoom: FOOTPRINT_MINZOOM,
      paint: {
        // recent detections read first; the older ones stay smaller and dimmer so they do not crowd the fire
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, ['match', ['get', 'age'], 2, 3.5, 0, 1.6, 1.1], FOOTPRINT_MINZOOM, ['match', ['get', 'age'], 2, 3.5, 0, 3, 2.1]],
        'circle-color': ['match', ['get', 'age'], 0, TOKENS.detection, 1, TOKENS.detectionOld, 'rgba(0,0,0,0)'],
        'circle-opacity': ['match', ['get', 'age'], 0, 0.9, 0.45],
        'circle-stroke-color': ['match', ['get', 'age'], 2, TOKENS.detection, TOKENS.detectionStroke],
        'circle-stroke-width': ['match', ['get', 'age'], 2, 1, 0.6],
        'circle-stroke-opacity': ['match', ['get', 'age'], 2, 0.6, 0, 0.8, 0.45],
        'circle-pitch-alignment': 'map',
      },
    },
    {
      id: LYR.forecastHatch,
      type: 'fill',
      source: SRC.forecastHatch,
      paint: { 'fill-pattern': HATCH_IMAGE, 'fill-opacity': 0.9 },
    },
    {
      id: LYR.forecastLine10,
      type: 'line',
      source: SRC.forecastLines,
      filter: ['==', ['get', 'k'], 10],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': TOKENS.forecast, 'line-width': 1.4, 'line-opacity': 0.85, 'line-dasharray': [0.1, 2.2] },
    },
    {
      id: LYR.forecastLine50,
      type: 'line',
      source: SRC.forecastLines,
      filter: ['==', ['get', 'k'], 50],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': TOKENS.forecast, 'line-width': 2.2, 'line-dasharray': [3, 2] },
    },
    {
      id: LYR.observedGlow,
      type: 'line',
      source: SRC.observedEdge,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': TOKENS.fireObservedGlow, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 8], 'line-blur': 4 },
    },
    {
      id: LYR.observedEdge,
      type: 'line',
      source: SRC.observedEdge,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': TOKENS.fireObserved, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.2, 14, 2.2] },
    },
    {
      id: LYR.perimetersOld,
      type: 'line',
      source: SRC.perimeters,
      filter: ['!', ['get', 'latest']],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': TOKENS.perimeterOld, 'line-width': 1, 'line-dasharray': [2, 2] },
    },
    {
      id: LYR.perimetersLatest,
      type: 'line',
      source: SRC.perimeters,
      filter: ['get', 'latest'],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': TOKENS.perimeter, 'line-width': 1.6 },
    },
    {
      id: LYR.aoiLine,
      type: 'line',
      source: SRC.aoi,
      paint: { 'line-color': t.aoi, 'line-width': 1.4, 'line-dasharray': [4, 3] },
    },
  ]
}

/** Point markers and our labels (added after the basemap labels). */
export function topLayers(theme: MapTheme = 'dark'): LayerSpecification[] {
  const t = THEME[theme]
  return [
    {
      id: LYR.eventsCircle,
      type: 'circle',
      source: SRC.events,
      paint: {
        'circle-radius': ['case', ['get', 'selected'], 7, 5],
        'circle-color': TOKENS.event,
        'circle-stroke-color': ['case', ['get', 'selected'], TOKENS.fireObserved, t.eventStroke],
        'circle-stroke-width': ['case', ['get', 'selected'], 3, 1.5],
        'circle-pitch-alignment': 'map',
      },
    },
    {
      id: LYR.incidentCircle,
      type: 'circle',
      source: SRC.incident,
      paint: {
        'circle-radius': 7,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': t.marker,
        'circle-stroke-width': 2.5,
        'circle-pitch-alignment': 'map',
      },
    },
    {
      id: LYR.perimetersLabel,
      type: 'symbol',
      source: SRC.perimeters,
      filter: ['get', 'latest'],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 420,
        'text-field': ['get', 'label'],
        'text-font': FONT_REGULAR,
        'text-size': 11,
        'text-offset': [0, -0.8],
        'text-max-angle': 30,
      },
      paint: { 'text-color': t.perimText, 'text-halo-color': t.halo, 'text-halo-width': 1.4 },
    },
    {
      id: LYR.aoiLabel,
      type: 'symbol',
      source: SRC.aoiLabels,
      minzoom: 10,
      layout: {
        'text-field': 'Outside modeled area',
        'text-font': FONT_REGULAR,
        'text-size': 10.5,
        'text-anchor': ['match', ['get', 'side'], 'n', 'bottom', 's', 'top', 'w', 'right', 'left'],
        'text-offset': ['match', ['get', 'side'], 'n', ['literal', [0, -0.4]], 's', ['literal', [0, 0.4]], 'w', ['literal', [-0.6, 0]], ['literal', [0.6, 0]]],
        'text-letter-spacing': 0.04,
        'text-optional': true,
      },
      paint: { 'text-color': t.aoiText, 'text-halo-color': t.halo, 'text-halo-width': 1.2 },
    },
    {
      id: LYR.eventsLabel,
      type: 'symbol',
      source: SRC.events,
      minzoom: 12,
      layout: {
        'text-field': ['get', 'title'],
        'text-font': FONT_REGULAR,
        'text-size': 11,
        'text-anchor': 'left',
        'text-offset': [0.9, 0],
        'text-optional': true,
        'text-max-width': 14,
      },
      paint: { 'text-color': t.ink, 'text-halo-color': t.halo, 'text-halo-width': 1.3 },
    },
    {
      id: LYR.incidentLabel,
      type: 'symbol',
      source: SRC.incident,
      layout: {
        'text-field': ['format', ['get', 'name'], { 'font-scale': 1, 'text-font': ['literal', FONT_BOLD] }, '\n', {}, 'Reported location', { 'font-scale': 0.82 }],
        'text-font': FONT_REGULAR,
        'text-size': 12.5,
        'text-anchor': 'top',
        'text-offset': [0, 0.9],
        'text-allow-overlap': false,
      },
      paint: { 'text-color': t.ink, 'text-halo-color': t.halo, 'text-halo-width': 1.5 },
    },
  ]
}

/** Diagonal hatch (45°) for modeled spread, as RGBA pixels for map.addImage (pixelRatio 2: 6 CSS px period). */
export function hatchImage(): { width: number; height: number; data: Uint8Array } {
  const size = 12
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // distance to the nearest anti-diagonal line x + y = k·size (tileable)
      const d = Math.abs(((x + y + 0.5) % size) - size / 2) - (size / 2 - 1.6)
      const a = Math.max(0, Math.min(1, d))
      const i = (y * size + x) * 4
      data[i] = 245
      data[i + 1] = 165
      data[i + 2] = 36
      data[i + 3] = Math.round(a * 0.75 * 255)
    }
  }
  return { width: size, height: size, data }
}
