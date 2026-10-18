// Public map providers for Public/Command (BRIEF §3): replaceable public services without API keys or billing, every
// endpoint overridable with a VITE_* variable. None of them publishes a numeric request allowance for this use, so
// the map treats each as fallible and says so when one fails (provider health in map/mapStore.ts, notices in
// map/MapNotices.tsx). Attribution is plain text + links rendered by MapAttribution; MapLibre's own
// AttributionControl stays off (it injects provider HTML, see CONTRACT §4.4).
import type { Basemap } from '../state/workspace'

const env = (key: string, fallback: string): string => {
  const v = (import.meta.env as Record<string, string | undefined>)[key]
  return v && v.trim() ? v.trim().replace(/\/$/, '') : fallback
}
const envInt = (key: string, fallback: number): number => {
  const n = Number(env(key, String(fallback)))
  return Number.isInteger(n) && n >= 0 && n <= 24 ? n : fallback
}

/** OpenFreeMap styles (vector roads, places, landmarks; vector tiles to z14). The three basemaps derive from these. */
export const OPENFREEMAP_STYLE_BASE = env('VITE_OPENFREEMAP_STYLE_BASE', 'https://tiles.openfreemap.org/styles')
export const OPENFREEMAP_STYLES = {
  liberty: `${OPENFREEMAP_STYLE_BASE}/liberty`,
  dark: `${OPENFREEMAP_STYLE_BASE}/dark`,
  positron: `${OPENFREEMAP_STYLE_BASE}/positron`,
  bright: `${OPENFREEMAP_STYLE_BASE}/bright`,
} as const

/** Glyphs for map labels (the OpenFreeMap styles use Noto Sans Regular / Bold / Italic). */
export const OPENFREEMAP_GLYPHS = env('VITE_OPENFREEMAP_GLYPHS', 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf')

/** Mapterhorn terrain TileJSON (Terrarium-encoded raster-dem, 512 px webp tiles). */
export const MAPTERHORN_TILEJSON = env('VITE_MAPTERHORN_TILEJSON', 'https://tiles.mapterhorn.com/tilejson.json')
export const MAPTERHORN_ENCODING = 'terrarium' as const
export const MAPTERHORN_TILE_SIZE = 512
/** The TileJSON gives no maxzoom. Tiles exist to z16 across California (USGS 3DEP 1 m; checked 2026-10-17 near
 *  Altadena, the Santa Lucia Range and Yosemite: z16 200, z17 404), so higher zooms overzoom z16. */
export const MAPTERHORN_MAXZOOM = envInt('VITE_MAPTERHORN_MAXZOOM', 16)
export const MAPTERHORN_ATTRIBUTION_URL = 'https://mapterhorn.com/attribution/'

/** USGS The National Map "Imagery Only" (Web Mercator, 256 px tiles; dated orthoimagery, never live satellite). */
export const USGS_IMAGERY_SERVICE = env('VITE_USGS_IMAGERY_SERVICE', 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer')
export const USGS_IMAGERY_TILES = `${USGS_IMAGERY_SERVICE}/tile/{z}/{y}/{x}`
export const USGS_IMAGERY_TILE_SIZE = 256
/** MapServer metadata (2026-10-17): the cache lists 24 levels but the service is "visible to the 1:9,028 zoom
 *  scale" (maxScale 9027.977), which is level 16; deeper levels overzoom it. */
export const USGS_IMAGERY_MAXZOOM = envInt('VITE_USGS_IMAGERY_MAXZOOM', 16)
/** The service's copyright text (MapServer copyrightText). */
export const USGS_IMAGERY_CREDIT = 'USDA, USGS The National Map: Orthoimagery'
/** When the photos were taken, at the latest. Source: the same MapServer's copyrightText, "USDA, USGS The National
 *  Map: Orthoimagery. Data refreshed June, 2024.v1.2" (audit-2 opening-map, read 2026-10-17 and again 2026-10-18; its
 *  description adds "NAIP Data is from 2017-2021 for CONUS"). Every fire in Fire-3d started later, so the photos show
 *  the land before the fire: intact roofs can appear inside a burned area. */
export const USGS_PHOTOS_LATEST_MS = Date.UTC(2024, 5, 30, 23, 59)
export const USGS_PHOTOS_DATE_TEXT = 'June 2024 or earlier'

/** The honest date line for the aerial photos (legend and basemap menu; brief 2 decision 8, O-R11). */
export function aerialPhotoLine(fireStartedMs: number | null | undefined): string {
  const base = `Aerial photos: USDA/USGS, ${USGS_PHOTOS_DATE_TEXT}`
  if (fireStartedMs == null || !Number.isFinite(fireStartedMs)) return `${base}: taken before the recent fires`
  return fireStartedMs > USGS_PHOTOS_LATEST_MS ? `${base}: taken before this fire` : `${base}: they may predate or follow this fire`
}

/** Starting OpenFreeMap style per basemap choice (map/basemapStyle.ts restyles it). */
export const BASEMAP_STYLE: Record<Basemap, string> = {
  dark: OPENFREEMAP_STYLES.dark,
  roads: OPENFREEMAP_STYLES.liberty,
  aerial: OPENFREEMAP_STYLES.liberty,
}

export const BASEMAP_LABEL: Record<Basemap, string> = {
  dark: 'Dark',
  roads: 'Roads',
  aerial: 'Aerial + labels',
}

/** Labels for narrow screens. */
export const BASEMAP_SHORT: Record<Basemap, string> = {
  dark: 'Dark',
  roads: 'Roads',
  aerial: 'Aerial',
}

export const BASEMAP_DESCRIPTION: Record<Basemap, string> = {
  dark: 'Subdued dark map with roads, places and terrain shading',
  roads: 'Road map (OpenFreeMap Liberty) with terrain shading',
  aerial: `Aerial photos (USDA/USGS, ${USGS_PHOTOS_DATE_TEXT}), desaturated, with road and place labels; not live satellite`,
}

/** Map features that bring their own credits. */
export type CreditFeature = 'basemap' | 'terrain' | 'hillshade' | 'imagery' | 'software'

export interface AttributionItem {
  id: string
  text: string
  href?: string
  /** Shown while this feature is on the map. */
  when: CreditFeature
}

/** Required credits, worded as the providers publish them (OpenFreeMap TileJSON, Mapterhorn attribution list, USGS
 *  MapServer copyrightText). Mapterhorn's California tiles come from USGS 3DEP and Copernicus GLO-30. */
export const ATTRIBUTION: AttributionItem[] = [
  { id: 'openfreemap', text: 'OpenFreeMap', href: 'https://openfreemap.org', when: 'basemap' },
  { id: 'openmaptiles', text: '© OpenMapTiles', href: 'https://www.openmaptiles.org/', when: 'basemap' },
  { id: 'osm', text: '© OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright', when: 'basemap' },
  { id: 'usgs', text: `Imagery: ${USGS_IMAGERY_CREDIT}`, href: USGS_IMAGERY_SERVICE, when: 'imagery' },
  {
    id: 'mapterhorn',
    text: 'Terrain: © Mapterhorn, USGS 3DEP, Copernicus GLO-30 (© DLR e.V. 2010–2014, © Airbus DS GmbH 2014–2018, EU/ESA)',
    href: MAPTERHORN_ATTRIBUTION_URL,
    when: 'terrain',
  },
  { id: 'maplibre', text: 'MapLibre', href: 'https://maplibre.org/', when: 'software' },
]

/** Which providers are failing (a failed provider draws nothing, so it needs no credit). */
export interface CreditHealth {
  vectorOk?: boolean
  terrainOk?: boolean
  imageryOk?: boolean
}

/** Credits for what is on the map: OpenFreeMap whenever its style is used, Mapterhorn for terrain shading (dark,
 *  roads) and 3D terrain, USGS for the aerial basemap. */
export function activeCredits(basemap: Basemap, perspective: '2d' | '3d', health: CreditHealth = {}): AttributionItem[] {
  const { vectorOk = true, terrainOk = true, imageryOk = true } = health
  const on = new Set<CreditFeature>(['software'])
  if (vectorOk) on.add('basemap')
  if (basemap === 'aerial' && imageryOk) on.add('imagery')
  if ((basemap !== 'aerial' || perspective === '3d') && terrainOk) on.add('terrain')
  return ATTRIBUTION.filter((a) => on.has(a.when))
}

/** Development only: ?mapfail=basemap,vector,terrain,imagery points those providers at an unreachable host so the
 *  failure notices can be checked without touching the real services. Ignored in production builds. */
export function devProviderFailures(): Set<'basemap' | 'vector' | 'terrain' | 'imagery'> {
  const out = new Set<'basemap' | 'vector' | 'terrain' | 'imagery'>()
  if (!import.meta.env.DEV || typeof window === 'undefined') return out
  const v = new URLSearchParams(window.location.search).get('mapfail')
  for (const k of (v ?? '').split(',')) if (k === 'basemap' || k === 'vector' || k === 'terrain' || k === 'imagery') out.add(k)
  return out
}

/** A URL on the reserved .invalid TLD (RFC 6761): never resolves. */
export const UNREACHABLE = 'https://provider-check.invalid'
