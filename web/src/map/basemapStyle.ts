// The three Public/Command basemaps (BRIEF §3, §5), derived at runtime from OpenFreeMap's published styles:
//   dark    OpenFreeMap "dark" restyled to the chrome's navy palette (Image 1): subdued land, water and roads,
//           brighter place labels with halos, plus light terrain shading from Mapterhorn.
//   roads   OpenFreeMap "liberty" (road / navigation style) with the same terrain shading.
//   aerial  USGS Imagery Only (dated orthoimagery), desaturated and darkened (Image 2), with liberty's roads as thin
//           translucent lines and its road / place / water labels in white with dark halos.
// Every derived style also carries the Mapterhorn raster-dem source used for 3D terrain (two separate DEM sources:
// MapLibre advises against sharing one between hillshade and terrain). Symbol layers are moved after all other basemap
// layers (stable order), so wildfire overlays can be inserted directly below the labels and stay above roads.
// 3D buildings (brief 2, O-R13, decision 2): one muted fill-extrusion of OpenStreetMap's building shapes (OpenMapTiles
// `building` layer: render_height / render_min_height) per basemap, replacing liberty's bright one, directly below the
// labels and hidden until the map controller shows it in 3D. Shapes only, never coloured by fire state, and today's
// OpenStreetMap: buildings destroyed by a fire may be missing (the legend says so). Wildfire overlays are inserted
// below the extrusion (`overlayBeforeId`), so in 3D the draped layers stay in one render-to-texture stack and the
// buildings stand on top of them.
import type { LayerSpecification, SourceSpecification, StyleSpecification } from 'maplibre-gl'
import type { Basemap } from '../state/workspace'
import {
  BASEMAP_STYLE,
  MAPTERHORN_ENCODING,
  MAPTERHORN_MAXZOOM,
  MAPTERHORN_TILE_SIZE,
  MAPTERHORN_TILEJSON,
  OPENFREEMAP_GLYPHS,
  USGS_IMAGERY_MAXZOOM,
  USGS_IMAGERY_TILE_SIZE,
  USGS_IMAGERY_TILES,
} from './providers'

export const VECTOR_SOURCE = 'openmaptiles'
export const TERRAIN_SOURCE = 'fx-terrain-dem'
export const HILLSHADE_SOURCE = 'fx-hillshade-dem'
export const IMAGERY_SOURCE = 'fx-usgs-imagery'
export const HILLSHADE_LAYER = 'fx-hillshade'
export const IMAGERY_LAYER = 'fx-usgs-imagery'
export const BUILDINGS_3D_LAYER = 'fx-buildings-3d'

/** 3D buildings appear from this zoom (fading in over the half zoom level before it). */
export const BUILDINGS_MINZOOM = 15
const BUILDINGS_FADE_FROM = 14.5
/** Muted building colours per basemap (never coloured by fire state) and their opacity. */
export const BUILDING_COLORS: Record<Basemap, string> = { dark: '#4a5566', roads: '#a8a095', aerial: '#c3c9d1' }
export const BUILDING_OPACITY = 0.6

/** The legend caveat for today's OpenStreetMap shapes over a burned area (brief 2, decision 8). */
export function buildingsCaveat(hasFire: boolean): string {
  return `3D shapes: today's OpenStreetMap; buildings destroyed by ${hasFire ? 'this fire' : 'a fire'} may be missing; not a damage assessment`
}

/** Navy palette of the dark basemap (kept close to the --m-bg / --m-text tokens in styles/map-tokens.css). */
export const DARK = {
  background: '#0b1119',
  water: '#0c2134',
  waterway: '#12304a',
  waterLabel: '#6f8fb3',
  residential: '#131c27',
  wood: '#0e1915',
  park: '#0f1c18',
  building: '#17202b',
  buildingOutline: '#212c39',
  aeroway: '#18222e',
  path: '#253244',
  minor: '#212c3a',
  majorCasing: 'rgba(72,88,108,0.85)',
  majorInner: '#2a3647',
  motorwayCasing: 'rgba(92,108,128,0.9)',
  motorwayInner: '#394656',
  rail: '#263140',
  boundary: '#3d4c5e',
  roadLabel: '#98a5b3',
  motorwayLabel: '#b9c4cf',
  halo: 'rgba(8,12,18,0.92)',
  cityLabel: '#e6ebf1',
  townLabel: '#cfd8e2',
  villageLabel: '#b7c3cf',
  minorPlaceLabel: '#9aa8b7',
} as const

export interface DerivedStyle {
  style: StyleSpecification
  /** First label (symbol) layer. Null when the style has no labels. */
  labelLayerId: string | null
  /** Draped wildfire overlays go directly below this layer: the 3D buildings when present, else the first label. */
  overlayBeforeId: string | null
  /** True when OpenFreeMap's style loaded; false = fallback without roads and labels (the map says so). */
  vector: boolean
}

type AnyLayer = LayerSpecification & { paint?: Record<string, unknown>; layout?: Record<string, unknown>; 'source-layer'?: string }

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export function demSource(): SourceSpecification {
  return { type: 'raster-dem', url: MAPTERHORN_TILEJSON, encoding: MAPTERHORN_ENCODING, tileSize: MAPTERHORN_TILE_SIZE, maxzoom: MAPTERHORN_MAXZOOM }
}

export function imagerySource(): SourceSpecification {
  return { type: 'raster', tiles: [USGS_IMAGERY_TILES], tileSize: USGS_IMAGERY_TILE_SIZE, maxzoom: USGS_IMAGERY_MAXZOOM }
}

function hillshadeLayer(kind: 'dark' | 'light'): LayerSpecification {
  return {
    id: HILLSHADE_LAYER,
    type: 'hillshade',
    source: HILLSHADE_SOURCE,
    paint:
      kind === 'dark'
        ? {
            'hillshade-exaggeration': 0.5,
            'hillshade-shadow-color': 'rgba(0,0,0,0.6)',
            'hillshade-highlight-color': 'rgba(150,178,208,0.13)',
            'hillshade-accent-color': 'rgba(0,0,0,0.2)',
          }
        : {
            'hillshade-exaggeration': 0.32,
            'hillshade-shadow-color': 'rgba(70,58,44,0.4)',
            'hillshade-highlight-color': 'rgba(255,255,255,0.3)',
            'hillshade-accent-color': 'rgba(70,58,44,0.15)',
          },
  }
}

function setPaint(l: AnyLayer, props: Record<string, unknown>): void {
  l.paint = { ...(l.paint ?? {}), ...props }
}

/** Symbol layers last (stable), so overlays can sit between the basemap's fills / lines and its labels. */
export function labelsLast(layers: LayerSpecification[]): { layers: LayerSpecification[]; labelLayerId: string | null } {
  const other = layers.filter((l) => l.type !== 'symbol')
  const labels = layers.filter((l) => l.type === 'symbol')
  return { layers: [...other, ...labels], labelLayerId: labels[0]?.id ?? null }
}

/** The muted 3D buildings layer of a basemap (hidden until the map shows it in 3D). */
export function buildingsLayer(basemap: Basemap): LayerSpecification {
  return {
    id: BUILDINGS_3D_LAYER,
    type: 'fill-extrusion',
    source: VECTOR_SOURCE,
    'source-layer': 'building',
    minzoom: BUILDINGS_FADE_FROM,
    filter: ['!', ['to-boolean', ['get', 'hide_3d']]],
    layout: { visibility: 'none' },
    paint: {
      'fill-extrusion-color': BUILDING_COLORS[basemap],
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 0],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], BUILDINGS_FADE_FROM, 0, BUILDINGS_MINZOOM, BUILDING_OPACITY],
      'fill-extrusion-vertical-gradient': true,
    },
  }
}

/** Put the 3D buildings directly below the labels (layers already in labels-last order). */
function withBuildings(layers: LayerSpecification[], labelLayerId: string | null, basemap: Basemap): LayerSpecification[] {
  const b = buildingsLayer(basemap)
  return labelLayerId ? insertBefore(layers, b, (l) => l.id === labelLayerId) : [...layers, b]
}

/** Insert `layer` before the first layer matching `pred` (or at the end). */
function insertBefore(layers: LayerSpecification[], layer: LayerSpecification, pred: (l: LayerSpecification) => boolean): LayerSpecification[] {
  const i = layers.findIndex(pred)
  return i < 0 ? [...layers, layer] : [...layers.slice(0, i), layer, ...layers.slice(i)]
}

/** Insert `layer` after the last layer matching `pred` (or after the first layer when none matches). */
function insertAfterLast(layers: LayerSpecification[], layer: LayerSpecification, pred: (l: LayerSpecification) => boolean): LayerSpecification[] {
  let i = -1
  layers.forEach((l, k) => {
    if (pred(l)) i = k
  })
  const at = i < 0 ? Math.min(1, layers.length) : i + 1
  return [...layers.slice(0, at), layer, ...layers.slice(at)]
}

/** Terrain shading goes above land cover / land use areas and below water lines, buildings, roads and labels. */
const isLandArea = (l: LayerSpecification) => (l.type === 'fill' || l.type === 'raster') && /^(natural_earth|landuse|landcover|park|water$)/.test(l.id)

/** OpenFreeMap "dark" in the navy palette. Unknown layers are kept as published. */
export function deriveDark(base: StyleSpecification): DerivedStyle {
  const s = clone(base)
  const layers = (s.layers as AnyLayer[]).map((l) => {
    const id = l.id
    if (id === 'background') setPaint(l, { 'background-color': DARK.background })
    else if (id === 'water') setPaint(l, { 'fill-color': DARK.water })
    else if (id === 'waterway') setPaint(l, { 'line-color': DARK.waterway })
    else if (id.startsWith('landcover_ice') || id.startsWith('landcover_glacier')) setPaint(l, { 'fill-color': DARK.residential })
    else if (id === 'landuse_residential') setPaint(l, { 'fill-color': DARK.residential, 'fill-opacity': 0.7 })
    else if (id === 'landcover_wood') {
      // the published 'wood-pattern' sprite image does not exist in OpenFreeMap's sprite
      if (l.paint) delete l.paint['fill-pattern']
      setPaint(l, { 'fill-color': DARK.wood })
    } else if (id === 'landuse_park') setPaint(l, { 'fill-color': DARK.park })
    else if (id === 'building') setPaint(l, { 'fill-color': DARK.building, 'fill-outline-color': DARK.buildingOutline })
    else if (id.startsWith('aeroway')) setPaint(l, l.type === 'fill' ? { 'fill-color': DARK.aeroway } : { 'line-color': DARK.aeroway })
    else if (id === 'highway_path') setPaint(l, { 'line-color': DARK.path })
    else if (id === 'highway_minor' || id === 'highway_motorway_subtle' || id === 'highway_major_subtle') setPaint(l, { 'line-color': DARK.minor })
    else if (id === 'highway_major_casing') setPaint(l, { 'line-color': DARK.majorCasing })
    else if (id === 'highway_major_inner') setPaint(l, { 'line-color': DARK.majorInner })
    else if (id === 'highway_motorway_casing') setPaint(l, { 'line-color': DARK.motorwayCasing })
    else if (id === 'highway_motorway_inner') setPaint(l, { 'line-color': DARK.motorwayInner })
    else if (id.startsWith('railway')) setPaint(l, { 'line-color': id.endsWith('dashline') ? DARK.background : DARK.rail })
    else if (id.startsWith('road_area') || id === 'road_pier') setPaint(l, l.type === 'fill' ? { 'fill-color': DARK.background } : { 'line-color': DARK.background })
    else if (id.startsWith('boundary')) setPaint(l, { 'line-color': DARK.boundary })
    else if (l.type === 'symbol') {
      const halo = { 'text-halo-color': DARK.halo, 'text-halo-width': 1.4, 'text-halo-blur': 0.4 }
      if (id === 'water_name') setPaint(l, { ...halo, 'text-color': DARK.waterLabel })
      else if (id === 'highway_name_other') setPaint(l, { ...halo, 'text-color': DARK.roadLabel })
      else if (id === 'highway_name_motorway') setPaint(l, { ...halo, 'text-color': DARK.motorwayLabel })
      else if (id === 'place_city' || id === 'place_city_large' || id.startsWith('place_country') || id === 'place_state')
        setPaint(l, { ...halo, 'text-color': DARK.cityLabel })
      else if (id === 'place_town') setPaint(l, { ...halo, 'text-color': DARK.townLabel })
      else if (id === 'place_village') setPaint(l, { ...halo, 'text-color': DARK.villageLabel })
      else if (id.startsWith('place_')) setPaint(l, { ...halo, 'text-color': DARK.minorPlaceLabel })
    }
    return l
  })
  s.sources = { ...s.sources, [HILLSHADE_SOURCE]: demSource(), [TERRAIN_SOURCE]: demSource() }
  const withShade = insertAfterLast(layers, hillshadeLayer('dark'), isLandArea)
  const { layers: ordered, labelLayerId } = labelsLast(withShade)
  s.layers = withBuildings(ordered, labelLayerId, 'dark')
  return { style: s, labelLayerId, overlayBeforeId: BUILDINGS_3D_LAYER, vector: true }
}

/** Fill-extrusion heights read feature properties that some buildings lack: default them to 0 (no null warnings). */
function safeExtrusions(layers: AnyLayer[]): void {
  for (const l of layers) {
    if (l.type !== 'fill-extrusion' || !l.paint) continue
    for (const k of ['fill-extrusion-height', 'fill-extrusion-base']) {
      const v = l.paint[k]
      if (Array.isArray(v) && v[0] === 'get') l.paint[k] = ['coalesce', v, 0]
    }
  }
}

/** Ordering comparisons on a feature property that some features lack (liberty: POI and country 'rank') evaluate to
 *  null and log a warning per feature; MapLibre then treats the filter as false. Guard them with 'has' instead (same
 *  result, no warnings). */
export function guardComparisons(expr: unknown): unknown {
  if (!Array.isArray(expr)) return expr
  const [op, a, b] = expr as unknown[]
  if ((op === '<' || op === '<=' || op === '>' || op === '>=') && expr.length === 3 && Array.isArray(a) && a[0] === 'get' && a.length === 2 && typeof a[1] === 'string' && typeof b === 'number')
    return ['all', ['has', a[1]], expr]
  return expr.map((e) => guardComparisons(e))
}

function guardFilters(layers: AnyLayer[]): void {
  for (const l of layers) if ('filter' in l && l.filter) (l as { filter: unknown }).filter = guardComparisons(l.filter)
}

/** OpenFreeMap "liberty" (road / navigation style) with terrain shading. Its bright `building-3d` extrusion is replaced
 *  by the muted one, and its flat footprints (z13-14 in liberty) are kept at every zoom for the 2D map. */
export function deriveRoads(base: StyleSpecification): DerivedStyle {
  const s = clone(base)
  s.layers = (s.layers as AnyLayer[]).filter((l) => l.type !== 'fill-extrusion')
  for (const l of s.layers as AnyLayer[]) if (l.id === 'building' && l.type === 'fill') delete (l as { maxzoom?: number }).maxzoom
  safeExtrusions(s.layers as AnyLayer[])
  guardFilters(s.layers as AnyLayer[])
  s.sources = { ...s.sources, [HILLSHADE_SOURCE]: demSource(), [TERRAIN_SOURCE]: demSource() }
  const withShade = insertAfterLast(s.layers, hillshadeLayer('light'), isLandArea)
  const { layers, labelLayerId } = labelsLast(withShade)
  s.layers = withBuildings(layers, labelLayerId, 'roads')
  return { style: s, labelLayerId, overlayBeforeId: BUILDINGS_3D_LAYER, vector: true }
}

/** Liberty layers dropped over imagery: area fills, the low-zoom shaded relief, waterway lines, rail hatching and
 *  road casings (the imagery shows land cover; casings would read as heavy outlines). */
const AERIAL_DROP = /^(natural_earth|park|landuse|landcover|water$|aeroway_fill|road_area_pattern|building|waterway_(tunnel|river|other)$)|_hatching$|_casing$/

/** Major road colour over the aerial photos: about 0.45 alpha, so they do not compete with the fire edge at z10-11
 *  (audit-2 opening-map G14; was 0.62). */
export const AERIAL_MAJOR_ROAD = 'rgba(255,238,205,0.45)'
export const AERIAL_MINOR_ROAD = 'rgba(236,241,247,0.34)'

/** USGS imagery, desaturated and darkened, with liberty's roads and labels on top. The photos have no 2D building
 *  footprints of their own (roofs are in the photo); the muted 3D buildings show in 3D only. */
export function deriveAerial(base: StyleSpecification): DerivedStyle {
  const s = clone(base)
  guardFilters(s.layers as AnyLayer[])
  const kept: AnyLayer[] = []
  for (const l of s.layers as AnyLayer[]) {
    if (l.id === 'background') {
      setPaint(l, { 'background-color': DARK.background })
      kept.push(l)
      continue
    }
    if (AERIAL_DROP.test(l.id)) continue
    if (l.type === 'line' && /^(road|tunnel|bridge)_/.test(l.id)) {
      const major = /motorway|trunk|primary|secondary/.test(l.id)
      setPaint(l, { 'line-color': major ? AERIAL_MAJOR_ROAD : AERIAL_MINOR_ROAD })
      if (l.id.startsWith('tunnel_')) setPaint(l, { 'line-opacity': 0.5 })
    } else if (l.type === 'line' && l.id.startsWith('boundary')) {
      setPaint(l, { 'line-color': 'rgba(232,237,243,0.55)' })
    } else if (l.type === 'line' && l.id.startsWith('aeroway')) {
      setPaint(l, { 'line-color': 'rgba(236,241,247,0.35)' })
    } else if (l.type === 'symbol') {
      const water = l.id.startsWith('water')
      setPaint(l, { 'text-color': water ? '#bcd7f2' : '#f3f6f9', 'text-halo-color': 'rgba(4,7,11,0.9)', 'text-halo-width': 1.6, 'text-halo-blur': 0.5 })
    }
    kept.push(l)
  }
  s.sources = { ...s.sources, [IMAGERY_SOURCE]: imagerySource(), [TERRAIN_SOURCE]: demSource() }
  const imagery: LayerSpecification = {
    id: IMAGERY_LAYER,
    type: 'raster',
    source: IMAGERY_SOURCE,
    paint: { 'raster-saturation': -0.6, 'raster-brightness-max': 0.68, 'raster-contrast': 0.06, 'raster-fade-duration': 150 },
  }
  const withImagery = insertBefore(kept, imagery, (l) => l.id !== 'background')
  const { layers, labelLayerId } = labelsLast(withImagery)
  s.layers = withBuildings(layers, labelLayerId, 'aerial')
  return { style: s, labelLayerId, overlayBeforeId: BUILDINGS_3D_LAYER, vector: true }
}

/** Without OpenFreeMap: navy background (+ the imagery for aerial, + terrain shading otherwise). Overlays still work. */
export function fallbackStyle(basemap: Basemap): DerivedStyle {
  const layers: LayerSpecification[] = [{ id: 'background', type: 'background', paint: { 'background-color': DARK.background } }]
  const sources: Record<string, SourceSpecification> = { [TERRAIN_SOURCE]: demSource() }
  if (basemap === 'aerial') {
    sources[IMAGERY_SOURCE] = imagerySource()
    layers.push({ id: IMAGERY_LAYER, type: 'raster', source: IMAGERY_SOURCE, paint: { 'raster-saturation': -0.6, 'raster-brightness-max': 0.68 } })
  } else {
    sources[HILLSHADE_SOURCE] = demSource()
    layers.push(hillshadeLayer(basemap === 'dark' ? 'dark' : 'light'))
  }
  return { style: { version: 8, glyphs: OPENFREEMAP_GLYPHS, sources, layers }, labelLayerId: null, overlayBeforeId: null, vector: false }
}

export function deriveBasemap(basemap: Basemap, base: StyleSpecification): DerivedStyle {
  return basemap === 'dark' ? deriveDark(base) : basemap === 'roads' ? deriveRoads(base) : deriveAerial(base)
}

/** Minimal shape check of a fetched style document. */
export function isStyle(v: unknown): v is StyleSpecification {
  const s = v as StyleSpecification | null
  return !!s && s.version === 8 && Array.isArray(s.layers) && typeof s.sources === 'object' && s.sources !== null
}

const styleCache = new Map<string, Promise<StyleSpecification>>()

/** Fetch an OpenFreeMap style document once per URL (a failed fetch is retried next time). */
export function fetchStyle(url: string): Promise<StyleSpecification> {
  let p = styleCache.get(url)
  if (!p) {
    p = fetch(url, { credentials: 'omit' }).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const json: unknown = await r.json()
      if (!isStyle(json)) throw new Error('not a MapLibre style')
      return json
    })
    styleCache.set(url, p)
    p.catch(() => styleCache.delete(url))
  }
  return p
}

/** The derived style for a basemap, or the fallback (vector: false) when OpenFreeMap's style cannot be loaded. */
export async function loadBasemap(basemap: Basemap, styleUrl: string = BASEMAP_STYLE[basemap]): Promise<DerivedStyle> {
  try {
    return deriveBasemap(basemap, await fetchStyle(styleUrl))
  } catch {
    return fallbackStyle(basemap)
  }
}
