// Map-first redesign state (docs/redesign/CONTRACT.md §2): workspace, preset, perspective, basemap, units, the
// selected location, the shared geographic view, map fly-to requests, panel flags and Public/Command layer visibility.
// It sits beside the main store (state/store.ts), which keeps the incident, the live/historical data context
// (`mode`), the forecast run and the timeline time; switching workspace, preset or perspective never touches those.
// URL: ?ws=map|forensic &preset=command &persp=3d &basemap=dark|roads|aerial &units=metric are read at start-up and
// kept in sync (replaceState); ?view=lon,lat,zoom[,bearing,pitch] and ?sel=lat,lon are read once (deep links /
// screenshots) and then dropped from the address bar, so shared links never carry a selected address or the user's view.
// Brief 2 (CONTRACT §13 shell): the fire card (fireCardId), the overview filter, and the basemap default per preset
// (Public aerial, Command dark) unless the user picked one; the map's own fallback never counts as a pick.
import { useEffect } from 'react'
import { create } from 'zustand'
import type { IncidentManifest, IncidentSummary } from '../api/types'
import { useMapRuntime } from '../map/mapStore'
import type { OverviewFilter } from './overview'
import { useStore } from './store'

export type Workspace = 'map' | 'forensic'
export type Preset = 'public' | 'command'
export type Perspective = '2d' | '3d'
export type Basemap = 'dark' | 'roads' | 'aerial'
export type Units = 'us' | 'metric'
export type SelectionSource = 'click' | 'coords' | 'address' | 'event' | 'incident'

/** The selected point (WGS84). Shown as the cyan pin, in the coordinate strip and in the location card. */
export interface SelectedLocation {
  lat: number
  lon: number
  source: SelectionSource
  /** Display label: the address as matched, an event title or the incident name (absent -> show coordinates). */
  label?: string
  /** Census "matchedAddress" (source 'address'). */
  matchedAddress?: string
  /** Position is approximate (Census address-range interpolation, estimated event location). */
  approximate?: boolean
  /** The pin may be dragged to correct the position (addresses). */
  adjustable?: boolean
  /** events.json / annotation id (source 'event'). */
  eventId?: string
  /** The user dragged the pin away from the original position (set by moveSelection). */
  adjusted?: boolean
}

/** Geographic view shared by 2D/3D and kept across workspace switches. bearing: degrees clockwise from north;
 *  pitch: degrees from straight down (0 = top-down). */
export interface GeoView {
  centerLon: number
  centerLat: number
  zoom: number
  bearing: number
  pitch: number
}

/** Who asked for a map flight (brief 2, decision 10): 'official' = showing an official area (an evacuation zone, an NWS
 *  alert's zones); the map's zoom focus skips the move it causes, so showing an area never opens another fire. */
export type MapFlySource = 'official'

/** One-shot request for the map camera (geographic). The map reacts to `nonce` changes only. */
export interface MapFlyTo {
  lon: number
  lat: number
  /** Target zoom (omitted: keep the current zoom, or fit `bounds`). */
  zoom?: number
  /** [west, south, east, north] to fit inside the safe area instead of a fixed zoom. */
  bounds?: [number, number, number, number]
  /** Optional origin of the request (see MapFlySource); absent = an ordinary flight. */
  source?: MapFlySource
  nonce: number
}

export type PanelKey = 'updates' | 'analysis' | 'layers'

export type MapLayerKey =
  | 'observed'
  | 'detections'
  | 'perimeters'
  | 'forecast'
  | 'selection'
  | 'events'
  | 'evacuation'
  | 'cameras'
  | 'recentImagery'

/** CSS px of the map covered by floating UI on each side (published by the shell; map padding / framing). */
export interface SafeInsets {
  top: number
  right: number
  bottom: number
  left: number
}

/** BRIEF §9 priorities: observed fire, detections, the selected forecast, selection and official evacuation
 *  information on; optional camera / recent-imagery sources off until the user asks for them. */
export const DEFAULT_MAP_LAYERS: Record<MapLayerKey, boolean> = {
  observed: true,
  detections: true,
  perimeters: true,
  forecast: true,
  selection: true,
  events: true,
  evacuation: true,
  cameras: false,
  recentImagery: false,
}

export const DEFAULT_PANELS: Record<PanelKey, boolean> = { updates: true, analysis: false, layers: false }

export interface WorkspaceState {
  workspace: Workspace
  preset: Preset
  perspective: Perspective
  /** The effective basemap every reader uses: basemapFallback ?? basemapPick ?? defaultBasemap(preset). */
  basemap: Basemap
  /** The user's explicit pick (basemap menu, Layers, ?basemap=); null = follow the preset's default. */
  basemapPick: Basemap | null
  /** Set by the map only while the effective basemap's provider fails (e.g. 'dark' when USGS aerial tiles fail). */
  basemapFallback: Basemap | null
  units: Units
  selection: SelectedLocation | null
  /** Last settled map view (written by the map on moveend); null = frame the incident when the map mounts. */
  view: GeoView | null
  mapFlyTo: MapFlyTo | null
  panels: Record<PanelKey, boolean>
  mapLayers: Record<MapLayerKey, boolean>
  safeInsets: SafeInsets
  /** Whose fire card is open (on the overview or inside a fire); null = none (brief 2, I3). */
  fireCardId: string | null
  /** The overview's list filter (brief 2, O-R3): Active / 2026 season / 2025. */
  overviewFilter: OverviewFilter
  /** Brief 3 (§14.11): the overview list shows every fire of the filter ("Show all") instead of those in the map view. */
  overviewShowAll: boolean

  setWorkspace: (w: Workspace) => void
  /** Switch preset; the effective basemap follows the new preset's default unless the user picked one. */
  setPreset: (p: Preset) => void
  setPerspective: (p: Perspective) => void
  togglePerspective: () => void
  /** The user's explicit basemap pick (menu, Layers); clears a fallback. */
  setBasemap: (b: Basemap) => void
  /** Map only: show `b` while the effective basemap's provider fails; null ends the fallback ("Try aerial again"). */
  setBasemapFallback: (b: Basemap | null) => void
  setUnits: (u: Units) => void
  /** Select a point; `fly` also requests a map fly-to (search results, coordinates, events), clicks do not fly. */
  selectLocation: (loc: SelectedLocation, opts?: { fly?: boolean; zoom?: number }) => void
  /** Drag of an adjustable pin: new position, keeps label / source, marks it adjusted (no longer interpolated). */
  moveSelection: (lat: number, lon: number) => void
  clearSelection: () => void
  setView: (v: GeoView) => void
  requestMapFlyTo: (req: Omit<MapFlyTo, 'nonce'>) => void
  /** Fly the map back to the selected incident: the fire itself through the mounted map (its "Incident" framing), else
   *  the AOI bounds, else its reported coordinates. */
  returnToIncident: () => void
  setPanel: (key: PanelKey, open: boolean) => void
  togglePanel: (key: PanelKey) => void
  setMapLayer: (key: MapLayerKey, visible: boolean) => void
  toggleMapLayer: (key: MapLayerKey) => void
  resetMapLayers: () => void
  setSafeInsets: (insets: SafeInsets) => void
  /** Open (id) or close (null) the fire card; never moves the camera. */
  setFireCard: (id: string | null) => void
  setOverviewFilter: (f: OverviewFilter) => void
  setOverviewShowAll: (all: boolean) => void
}

/** Basemap of a preset when the user has not picked one (decision 5: Public opens on aerial with labels). */
export function defaultBasemap(preset: Preset): Basemap {
  return preset === 'public' ? 'aerial' : 'dark'
}

/** The basemap shown: the map's fallback, else the user's pick, else the preset's default. */
export function effectiveBasemap(s: { basemapFallback?: Basemap | null; basemapPick: Basemap | null; preset: Preset }): Basemap {
  return s.basemapFallback ?? s.basemapPick ?? defaultBasemap(s.preset)
}

// ------------------------------------------------------------------------------------------------- URL state
export interface WorkspaceUrlParams {
  workspace: Workspace | null
  preset: Preset | null
  perspective: Perspective | null
  basemap: Basemap | null
  units: Units | null
  view: GeoView | null
  selection: { lat: number; lon: number } | null
}

const pick = <T extends string>(v: string | null, allowed: readonly T[]): T | null => (v != null && (allowed as readonly string[]).includes(v) ? (v as T) : null)

const validLat = (v: number) => Number.isFinite(v) && v >= -90 && v <= 90
const validLon = (v: number) => Number.isFinite(v) && v >= -180 && v <= 180

/** Parse the workspace query parameters (invalid values are ignored). */
export function parseWorkspaceParams(search: string): WorkspaceUrlParams {
  const q = new URLSearchParams(search)
  let view: GeoView | null = null
  const vp = q.get('view')?.split(',').map(Number)
  if (vp && vp.length >= 3 && validLon(vp[0]) && validLat(vp[1]) && Number.isFinite(vp[2])) {
    view = {
      centerLon: vp[0],
      centerLat: vp[1],
      zoom: Math.min(22, Math.max(0, vp[2])),
      bearing: Number.isFinite(vp[3]) ? vp[3] : 0,
      pitch: Number.isFinite(vp[4]) ? Math.min(85, Math.max(0, vp[4])) : 0,
    }
  }
  let selection: { lat: number; lon: number } | null = null
  const sp = q.get('sel')?.split(',').map(Number)
  if (sp && sp.length === 2 && validLat(sp[0]) && validLon(sp[1])) selection = { lat: sp[0], lon: sp[1] }
  return {
    workspace: pick(q.get('ws'), ['map', 'forensic'] as const),
    preset: pick(q.get('preset'), ['public', 'command'] as const),
    perspective: pick(q.get('persp'), ['2d', '3d'] as const),
    basemap: pick(q.get('basemap'), ['dark', 'roads', 'aerial'] as const),
    units: pick(q.get('units'), ['us', 'metric'] as const),
    view,
    selection,
  }
}

/** Write the workspace fields into `url` (defaults are omitted, except ws which is always explicit); drops the
 *  one-shot ?view= / ?sel= parameters. `basemap` is written only when the user's pick differs from the preset's
 *  default (a fallback is never written). Returns the same URL object. */
export function writeWorkspaceParams(
  url: URL,
  s: Pick<WorkspaceState, 'workspace' | 'preset' | 'perspective' | 'units'> & { basemapPick?: Basemap | null; basemap?: Basemap },
): URL {
  const p = url.searchParams
  p.set('ws', s.workspace)
  if (s.preset !== 'public') p.set('preset', s.preset)
  else p.delete('preset')
  if (s.perspective !== '2d') p.set('persp', s.perspective)
  else p.delete('persp')
  // callers without the pick field (older code, tests) pass the basemap they want kept
  const pick = s.basemapPick !== undefined ? s.basemapPick : (s.basemap ?? null)
  if (pick != null && pick !== defaultBasemap(s.preset)) p.set('basemap', pick)
  else p.delete('basemap')
  if (s.units !== 'us') p.set('units', s.units)
  else p.delete('units')
  p.delete('view')
  p.delete('sel')
  return url
}

const initialUrl = typeof window !== 'undefined' ? parseWorkspaceParams(window.location.search) : parseWorkspaceParams('')
/** The fire named by the start-up link: its first selection keeps a deep-linked ?view= (any later overview -> fire
 *  transition drops the overview's view so the map frames the fire). */
let linkedIncident: string | null = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('incident') || null : null

// ------------------------------------------------------------------------------------------------- selectors
/** Synthetic development fixtures ("DEMO · SIMULATED DATA" badge): fixture ids or synthetic data sources. */
export function isDemoBundle(id: string | null | undefined, manifest?: Pick<IncidentManifest, 'data_sources'> | null): boolean {
  if (id && id.startsWith('fixture-')) return true
  return manifest?.data_sources.some((d) => /synthetic/i.test(d.name)) ?? false
}

/** Fly-to request framing an incident: the AOI bounds when the bundle is known, else its reported coordinates. */
export function incidentFlyTo(summary: Pick<IncidentSummary, 'lat' | 'lon'> | null, manifest: Pick<IncidentManifest, 'grid'> | null): Omit<MapFlyTo, 'nonce'> | null {
  const b = manifest?.grid.bbox_lonlat
  if (b && b.every(Number.isFinite)) return { lon: (b[0] + b[2]) / 2, lat: (b[1] + b[3]) / 2, bounds: [b[0], b[1], b[2], b[3]] }
  if (summary && validLat(summary.lat) && validLon(summary.lon)) return { lon: summary.lon, lat: summary.lat, zoom: 12 }
  return null
}

// ------------------------------------------------------------------------------------------------- store
export const useWorkspace = create<WorkspaceState>()((set, get) => ({
  workspace: initialUrl.workspace ?? 'map',
  preset: initialUrl.preset ?? 'public',
  perspective: initialUrl.perspective ?? '2d',
  basemap: effectiveBasemap({ basemapPick: initialUrl.basemap, preset: initialUrl.preset ?? 'public' }),
  basemapPick: initialUrl.basemap,
  basemapFallback: null,
  units: initialUrl.units ?? 'us',
  selection: initialUrl.selection ? { ...initialUrl.selection, source: 'coords' } : null,
  view: initialUrl.view,
  mapFlyTo: null,
  panels: { ...DEFAULT_PANELS },
  mapLayers: { ...DEFAULT_MAP_LAYERS },
  safeInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  fireCardId: null,
  overviewFilter: 'season',
  overviewShowAll: false,

  setWorkspace: (workspace) => set({ workspace }),
  setPreset: (preset) => set((s) => ({ preset, basemap: effectiveBasemap({ ...s, preset }) })),
  setPerspective: (perspective) => set({ perspective }),
  togglePerspective: () => set((s) => ({ perspective: s.perspective === '2d' ? '3d' : '2d' })),
  setBasemap: (basemap) => set({ basemap, basemapPick: basemap, basemapFallback: null }),
  setBasemapFallback: (basemapFallback) => set((s) => ({ basemapFallback, basemap: effectiveBasemap({ ...s, basemapFallback }) })),
  setUnits: (units) => set({ units }),
  selectLocation: (loc, opts) => {
    if (!validLat(loc.lat) || !validLon(loc.lon)) return
    // one card at a time: a new point's location card replaces an open fire card
    set({ selection: { ...loc }, fireCardId: null })
    if (opts?.fly) get().requestMapFlyTo({ lon: loc.lon, lat: loc.lat, ...(opts.zoom != null ? { zoom: opts.zoom } : {}) })
  },
  moveSelection: (lat, lon) =>
    set((s) => (s.selection && validLat(lat) && validLon(lon) ? { selection: { ...s.selection, lat, lon, adjusted: true, approximate: false } } : {})),
  clearSelection: () => set({ selection: null }),
  setView: (view) => set({ view }),
  requestMapFlyTo: (req) => set((s) => ({ mapFlyTo: { ...req, nonce: (s.mapFlyTo?.nonce ?? 0) + 1 } })),
  returnToIncident: () => {
    // the mounted map frames the fire itself (burned area, perimeter, P90 reach); without it, the analysis area
    const actions = useMapRuntime.getState().actions
    if (actions && get().workspace === 'map' && useStore.getState().incidentId != null) {
      actions.frameFire()
      return
    }
    const { summary, manifest } = useStore.getState()
    const req = incidentFlyTo(summary, manifest)
    if (req) get().requestMapFlyTo(req)
  },
  setPanel: (key, open) => set((s) => ({ panels: { ...s.panels, [key]: open } })),
  togglePanel: (key) => set((s) => ({ panels: { ...s.panels, [key]: !s.panels[key] } })),
  setMapLayer: (key, visible) => set((s) => ({ mapLayers: { ...s.mapLayers, [key]: visible } })),
  toggleMapLayer: (key) => set((s) => ({ mapLayers: { ...s.mapLayers, [key]: !s.mapLayers[key] } })),
  resetMapLayers: () => set({ mapLayers: { ...DEFAULT_MAP_LAYERS } }),
  setSafeInsets: (safeInsets) =>
    set((s) => {
      const a = s.safeInsets
      return a.top === safeInsets.top && a.right === safeInsets.right && a.bottom === safeInsets.bottom && a.left === safeInsets.left ? {} : { safeInsets: { ...safeInsets } }
    }),
  setFireCard: (fireCardId) => set((s) => (s.fireCardId === fireCardId ? {} : { fireCardId })),
  setOverviewFilter: (overviewFilter) => set({ overviewFilter }),
  setOverviewShowAll: (overviewShowAll) => set({ overviewShowAll }),
}))

// Switching incidents (also overview -> fire and fire -> overview): the view belongs to the previous incident or the
// overview (the map frames the new one), and selections that point at the previous incident's events or reported
// location no longer apply. User-picked points are kept. The start-up link's first selection keeps a deep-linked view,
// and a zoom focus or zoom-out (decision 10) keeps the view and every selection: the camera did not move. A fire card
// closes unless it belongs to the incident now shown.
useStore.subscribe((s, p) => {
  if (s.incidentId === p.incidentId) return
  const ws = useWorkspace.getState()
  const card = ws.fireCardId != null && ws.fireCardId !== s.incidentId ? { fireCardId: null } : {}
  const firstLinked = p.incidentId == null && s.incidentId != null && s.incidentId === linkedIncident
  linkedIncident = null
  if (firstLinked || s.incidentSource === 'zoom') {
    if ('fireCardId' in card) useWorkspace.setState(card)
    return
  }
  const sel = ws.selection
  useWorkspace.setState({
    view: null,
    ...card,
    ...(sel && (sel.source === 'event' || sel.source === 'incident') ? { selection: null } : {}),
  })
})

/** Keep ?ws=&preset=&persp=&basemap=&units= in the address bar (replaceState, throttled like useUrlSync). */
export function useWorkspaceUrlSync(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    let timer: number | undefined
    const write = () => {
      timer = undefined
      const u = writeWorkspaceParams(new URL(window.location.href), useWorkspace.getState())
      const next = `${u.pathname}${u.search}${u.hash}`
      if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(window.history.state, '', next)
    }
    const schedule = () => {
      if (timer === undefined) timer = window.setTimeout(write, 300)
    }
    const unsub = useWorkspace.subscribe((s, p) => {
      if (s.workspace !== p.workspace || s.preset !== p.preset || s.perspective !== p.perspective || s.basemapPick !== p.basemapPick || s.units !== p.units) schedule()
    })
    schedule()
    return () => {
      unsub()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [enabled])
}

declare global {
  interface Window {
    /** Dev/test handle: window.__workspace.getState() / setState() (scripts/shot.mjs --eval). */
    __workspace?: typeof useWorkspace
  }
}

if (typeof window !== 'undefined') window.__workspace = useWorkspace
