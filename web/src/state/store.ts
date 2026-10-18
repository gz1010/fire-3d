// Global app state (SPEC 9.2, Contract). Large binary arrays never go in here (lib/raster.ts caches them by URL).
// During playback the scene reads time with useStore.getState() inside useFrame. Scene-only transient state
// (hover probe, FPS, focus distance) lives in scene/sceneStore.ts.
//
// Async actions are race-guarded: every incident switch bumps a token and late responses for an older selection
// are dropped. Jobs (build / forecast / refresh) are polled every second; on completion the manifest is re-fetched
// and bundle files are reloaded when `built_ms` changed (files are fetched with ?v=built_ms, so caches bust).
import { create } from 'zustand'
import { bundleUrl, describeError, fetchJson, getAircraft, getIncident, getIncidents, getJob, getLiveStatus, isNotFound, postBuild, postForecast } from '../api/client'
import type {
  Aircraft,
  DetectionsFile,
  EventsFile,
  ForecastManifest,
  ForecastRequest,
  IncidentManifest,
  IncidentSummary,
  JobStatus,
  LiveStatus,
  Mode,
  PerimetersFile,
  TimeseriesFile,
  WeatherFile,
} from '../api/types'

export type LayerKey =
  | 'terrain'
  | 'imagery'
  | 'trees'
  | 'fuels'
  | 'burnScar'
  | 'observedFire'
  | 'isochrones'
  | 'forecast'
  | 'detections'
  | 'perimeters'
  | 'smoke'
  | 'ignition'
  | 'lattice'
  | 'contours'
  | 'telemetry'
  | 'wind'
  | 'aircraft'
  | 'profilePath'

export interface LayerState {
  visible: boolean
  opacity: number // 0..1
}

export type VisualStyle = 'hybrid' | 'realistic' | 'parametric'
export type LatticeField = 'activity' | 'probability' | 'elevation' | 'slope' | 'canopy'
export type ViewMode = '3d' | '2d'
export type Quality = 'high' | 'medium' | 'low'
export type RightTab = 'layers' | 'analysis' | 'evidence' | 'notes'
/** Addition: timeline window presets (SPEC 9.4 "All / 7 d / 72 h + forecast"). */
export type WindowPreset = 'all' | '7d' | '72h'
/** Addition: header tabs "Incident" | "Aircraft (n)" (aircraft = live only). */
export type HeaderTab = 'incident' | 'aircraft'

export interface CatalogState {
  live: IncidentSummary[]
  historical: IncidentSummary[]
  loading: boolean
  error: string | null
  /** Addition: historical acreage threshold of the loaded list (server default 300; UI toggle 100). */
  minAcres: number
  /** Addition: server `updated_ms` of the last successful list per mode. */
  updatedMs: { live: number | null; historical: number | null }
}

export interface FlyTo {
  x: number
  z: number
  distance?: number
  nonce: number
}

export interface TimeWindow {
  startMs: number
  endMs: number
}

/** Addition: metadata of the last /aircraft poll (live incidents). */
export interface AircraftMeta {
  source: string | null
  radiusNm: number | null
  note: string | null
  error: string | null
  /** Wall-clock ms of the last poll attempt (success or failure). */
  polledMs: number | null
}

export const LAYER_KEYS: LayerKey[] = [
  'terrain', 'imagery', 'trees', 'fuels', 'burnScar',
  'observedFire', 'isochrones', 'forecast', 'detections', 'perimeters', 'smoke', 'ignition',
  'lattice', 'contours', 'telemetry',
  'wind', 'aircraft', 'profilePath',
]

/** SPEC 9.2 layer defaults. */
export const DEFAULT_LAYERS: Record<LayerKey, LayerState> = {
  terrain: { visible: true, opacity: 1 },
  imagery: { visible: true, opacity: 1 },
  trees: { visible: true, opacity: 1 },
  fuels: { visible: false, opacity: 0.7 },
  burnScar: { visible: false, opacity: 0.9 },
  observedFire: { visible: true, opacity: 1 },
  isochrones: { visible: true, opacity: 0.8 },
  forecast: { visible: true, opacity: 0.85 },
  detections: { visible: true, opacity: 0.9 },
  perimeters: { visible: true, opacity: 0.6 },
  smoke: { visible: true, opacity: 0.8 },
  ignition: { visible: true, opacity: 1 },
  lattice: { visible: true, opacity: 0.9 },
  contours: { visible: true, opacity: 0.35 },
  telemetry: { visible: true, opacity: 1 },
  wind: { visible: false, opacity: 0.7 },
  aircraft: { visible: true, opacity: 1 },
  profilePath: { visible: true, opacity: 1 },
}

export const SPEEDS_HOURS_PER_SEC = [0.5, 1, 3, 6, 12, 24] as const

const HOUR = 3_600_000
const DAY = 24 * HOUR
const JOB_POLL_MS = 1000

export interface AppState {
  mode: Mode
  catalog: CatalogState
  incidentId: string | null
  summary: IncidentSummary | null
  manifest: IncidentManifest | null
  job: JobStatus | null
  forecastRunId: string | null
  forecast: ForecastManifest | null
  timeseries: TimeseriesFile | null
  events: EventsFile | null
  weather: WeatherFile | null
  detections: DetectionsFile | null
  perimeters: PerimetersFile | null
  timeMs: number
  playing: boolean
  speedHoursPerSec: number
  timeWindow: TimeWindow | null // visible timeline window
  viewMode: ViewMode
  visualStyle: VisualStyle
  latticeField: LatticeField
  exaggeration: number
  treeScale: number
  dof: boolean
  quality: Quality
  panelsCollapsed: boolean // hide UI chrome for a cinematic view (key "H")
  layers: Record<LayerKey, LayerState>
  aircraft: Aircraft[]
  aircraftUpdatedMs: number | null // UI polls /aircraft every 10 s (live); scene renders
  profilePath: [number, number][]
  drawingPath: boolean
  selectedEventId: string | null
  flyTo: FlyTo | null
  rightTab: RightTab
  /** Addition: true while selectIncident is fetching the incident or its bundle files. */
  incidentLoading: boolean
  /** Addition: last error from selectIncident / refreshManifest / jobs (null when fine). */
  incidentError: string | null
  /** Addition: selected timeline window preset; timeWindow is derived from it. */
  windowPreset: WindowPreset
  /** Addition: header tab ("aircraft" only in live mode). */
  headerTab: HeaderTab
  /** Addition: request all ADS-B traffic (all=1), not only fire aircraft. */
  aircraftAll: boolean
  /** Addition: metadata/error of the last aircraft poll. */
  aircraftMeta: AircraftMeta
  /** Addition: /api/live/status (polled in live mode). */
  liveStatus: LiveStatus | null
  /** Addition: start a build automatically when an unbuilt incident is selected (SPEC 9.4). */
  autoBuild: boolean

  // ---- synchronous setters (one per field) + conveniences
  setMode: (mode: Mode) => void
  setCatalog: (catalog: Partial<CatalogState>) => void
  setIncidentId: (id: string | null) => void
  setSummary: (summary: IncidentSummary | null) => void
  setManifest: (manifest: IncidentManifest | null) => void
  setJob: (job: JobStatus | null) => void
  setForecastRunId: (runId: string | null) => void
  setForecast: (forecast: ForecastManifest | null) => void
  setTimeseries: (v: TimeseriesFile | null) => void
  setEvents: (v: EventsFile | null) => void
  setWeather: (v: WeatherFile | null) => void
  setDetections: (v: DetectionsFile | null) => void
  setPerimeters: (v: PerimetersFile | null) => void
  setTimeMs: (ms: number) => void
  setPlaying: (playing: boolean) => void
  togglePlaying: () => void
  setSpeedHoursPerSec: (v: number) => void
  setTimeWindow: (w: TimeWindow | null) => void
  setViewMode: (v: ViewMode) => void
  setVisualStyle: (v: VisualStyle) => void
  setLatticeField: (v: LatticeField) => void
  setExaggeration: (v: number) => void
  setTreeScale: (v: number) => void
  setDof: (v: boolean) => void
  setQuality: (v: Quality) => void
  setPanelsCollapsed: (v: boolean) => void
  togglePanelsCollapsed: () => void
  setLayers: (layers: Record<LayerKey, LayerState>) => void
  setLayer: (key: LayerKey, patch: Partial<LayerState>) => void
  setLayerVisible: (key: LayerKey, visible: boolean) => void
  setLayerOpacity: (key: LayerKey, opacity: number) => void
  toggleLayer: (key: LayerKey) => void
  resetLayers: () => void
  setAircraft: (aircraft: Aircraft[], updatedMs?: number | null) => void
  setAircraftUpdatedMs: (ms: number | null) => void
  setProfilePath: (path: [number, number][]) => void
  setDrawingPath: (v: boolean) => void
  setSelectedEventId: (id: string | null) => void
  setFlyTo: (f: FlyTo | null) => void
  /** Animate the camera to local (x, z); a fresh nonce is generated. */
  flyToLocal: (x: number, z: number, distance?: number) => void
  /** Alias of flyToLocal (UI wording). */
  requestFlyTo: (x: number, z: number, distance?: number) => void
  setRightTab: (t: RightTab) => void
  setIncidentError: (e: string | null) => void
  /** Addition: pick a window preset and derive timeWindow (time is clamped into the new window). */
  setWindowPreset: (p: WindowPreset) => void
  setHeaderTab: (t: HeaderTab) => void
  setAircraftAll: (v: boolean) => void
  setAutoBuild: (v: boolean) => void
  /** Addition: move the time by `deltaMs`, clamped to the incident's time bounds. */
  stepTime: (deltaMs: number) => void

  // ---- async loaders
  /** Fetch the catalogs (both modes by default; historical with `minAcres`, default 300). */
  loadCatalog: (opts?: { minAcres?: number; modes?: Mode[] }) => Promise<void>
  /** Load an incident: summary/manifest/job; when ready also timeseries/events/weather/detections/perimeters and
   *  the newest ready forecast. Sets time (live: now_ms; historical: start + 40 %) and the default profile path.
   *  `autoBuild` starts a build when the bundle is missing. */
  selectIncident: (id: string, opts?: { autoBuild?: boolean; keepTime?: boolean }) => Promise<void>
  /** POST build, then poll the job; refreshes the manifest when it finishes. */
  startBuild: (force?: boolean) => Promise<JobStatus | null>
  /** POST forecast (historical default start = current timeline time), poll, then select the new run. */
  startForecast: (req?: ForecastRequest) => Promise<JobStatus | null>
  /** Load forecasts/{runId}/forecast.json (null clears the selection). */
  selectForecast: (runId: string | null) => Promise<void>
  /** Re-fetch /api/incidents/{id}; refetch bundle files when built_ms changed. */
  refreshManifest: () => Promise<void>
  /** Addition: poll /api/incidents/{id}/aircraft once (live incidents) into `aircraft`. */
  refreshAircraft: () => Promise<void>
  /** Addition: fetch /api/live/status into `liveStatus`. */
  refreshLiveStatus: () => Promise<void>
}

const errMsg = describeError
let selectToken = 0
let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollJobId: string | null = null
let watchTimer: ReturnType<typeof setTimeout> | null = null
let aircraftSeq = 0

/** Visible time range of the current incident: [start, max(end, newest forecast end)] (null without manifest). */
export function getTimeBounds(s: Pick<AppState, 'manifest' | 'forecast'>): TimeWindow | null {
  const m = s.manifest
  if (!m) return null
  const fEnd = s.forecast ? s.forecast.start_ms + s.forecast.horizon_h * 3_600_000 : 0
  return { startMs: m.time_range.start_ms, endMs: Math.max(m.time_range.end_ms, fEnd) }
}

/** Default timeline time: live -> now_ms; historical -> start + 40 % of the observed range. */
export function defaultTimeFor(m: IncidentManifest): number {
  const tr = m.time_range
  return m.mode === 'live' ? tr.now_ms : Math.round(tr.start_ms + 0.4 * (tr.end_ms - tr.start_ms))
}

/** The "Now" marker: live -> latest observation; historical -> the selected hindcast's start (else null). */
export function nowMarkerMs(m: IncidentManifest | null, f: ForecastManifest | null): number | null {
  if (!m) return null
  if (m.mode === 'live') return m.time_range.now_ms
  return f ? f.start_ms : null
}

/** Timeline window for a preset (SPEC 9.4):
 *  all = [start, max(end, forecast end)];
 *  7d / 72h = that much history before the Now marker (live: now; historical: hindcast start) plus the forecast,
 *  or, for a historical replay without a forecast, the first 7 d / 72 h after the start. */
export function windowFor(preset: WindowPreset, m: IncidentManifest | null, f: ForecastManifest | null): TimeWindow | null {
  const b = getTimeBounds({ manifest: m, forecast: f })
  if (!b || !m || preset === 'all') return b
  const span = preset === '7d' ? 7 * DAY : 72 * HOUR
  const fEnd = f ? f.start_ms + f.horizon_h * HOUR : null
  const anchor = nowMarkerMs(m, f)
  let w: TimeWindow
  if (anchor == null) w = { startMs: b.startMs, endMs: b.startMs + span }
  else w = { startMs: anchor - span, endMs: Math.max(anchor, fEnd ?? anchor) }
  const startMs = Math.max(b.startMs, w.startMs)
  const endMs = Math.min(b.endMs, Math.max(w.endMs, startMs + 6 * HOUR))
  return endMs > startMs ? { startMs, endMs } : b
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const emptyAircraftMeta: AircraftMeta = { source: null, radiusNm: null, note: null, error: null, polledMs: null }

const perIncidentReset = {
  summary: null,
  manifest: null,
  job: null,
  forecastRunId: null,
  forecast: null,
  timeseries: null,
  events: null,
  weather: null,
  detections: null,
  perimeters: null,
  timeWindow: null,
  aircraft: [] as Aircraft[],
  aircraftUpdatedMs: null,
  aircraftMeta: emptyAircraftMeta,
  selectedEventId: null,
  flyTo: null,
  drawingPath: false,
  playing: false,
  incidentError: null,
}

/** Fetch a bundle JSON file; on failure log it, record its name in `failed` and return null. */
async function bundleJson<T>(url: string, name: string, failed: string[]): Promise<T | null> {
  try {
    return await fetchJson<T>(url)
  } catch (e) {
    console.warn('[store] bundle file failed', url, e)
    failed.push(name)
    return null
  }
}

async function fetchForecast(m: IncidentManifest, runId: string): Promise<ForecastManifest | null> {
  const fs = m.forecasts.find((f) => f.run_id === runId)
  if (!fs) return null
  return fetchJson<ForecastManifest>(bundleUrl(m.id, fs.file, `${m.built_ms}-${fs.issued_ms}`))
}

/** Replace one incident's summary inside the catalog lists (keeps bundle_status chips fresh). */
function patchCatalog(c: CatalogState, s: IncidentSummary): CatalogState {
  const patch = (list: IncidentSummary[]) => {
    const i = list.findIndex((x) => x.id === s.id)
    if (i < 0) return list
    const out = list.slice()
    out[i] = s
    return out
  }
  return { ...c, live: patch(c.live), historical: patch(c.historical) }
}

export const useStore = create<AppState>()((set, get) => {
  /** Fetch the bundle JSON files + newest ready forecast and apply them in one update. */
  async function loadBundleFiles(m: IncidentManifest, token: number, keepTime: boolean): Promise<void> {
    const v = m.built_ms
    const url = (p: string) => bundleUrl(m.id, p, v)
    const prevRun = keepTime ? get().forecastRunId : null
    const keepRun = prevRun ? m.forecasts.find((f) => f.run_id === prevRun && f.status === 'ready') : undefined
    const wanted = keepRun ?? m.forecasts.find((f) => f.status === 'ready') ?? null
    const failed: string[] = []
    const [timeseries, events, weather, detections, perimeters, forecast] = await Promise.all([
      bundleJson<TimeseriesFile>(url('timeseries.json'), 'timeseries.json', failed),
      bundleJson<EventsFile>(url('events.json'), 'events.json', failed),
      bundleJson<WeatherFile>(url('weather.json'), 'weather.json', failed),
      bundleJson<DetectionsFile>(url('detections.json'), 'detections.json', failed),
      bundleJson<PerimetersFile>(url('perimeters.json'), 'perimeters.json', failed),
      wanted
        ? fetchForecast(m, wanted.run_id).catch((e) => {
            console.warn('[store] forecast failed', e)
            failed.push(`forecast ${wanted.run_id}`)
            return null
          })
        : Promise.resolve(null),
    ])
    if (token !== selectToken) return
    const prev = get()
    const bounds = getTimeBounds({ manifest: m, forecast })
    const pm = prev.manifest
    // keep the time only when this incident was already displayed (a fresh build starts at the default time)
    const wasShown = pm != null && pm.id === m.id && pm.status === 'ready'
    const keep = keepTime && wasShown && bounds != null && prev.timeMs >= bounds.startMs && prev.timeMs <= bounds.endMs
    // live: a user parked at the previous "now" follows the new latest observation
    const followNow = keepTime && wasShown && m.mode === 'live' && Math.abs(prev.timeMs - pm.time_range.now_ms) < 60_000
    set({
      manifest: m,
      timeseries,
      events,
      weather,
      detections,
      perimeters,
      forecast,
      forecastRunId: forecast ? forecast.run_id : null,
      timeMs: followNow ? m.time_range.now_ms : keep ? prev.timeMs : defaultTimeFor(m),
      timeWindow: windowFor(prev.windowPreset, m, forecast),
      profilePath: keep && prev.profilePath.length ? prev.profilePath : (m.default_profile_path ?? []),
      // the five JSON files are part of every bundle (SPEC 5): a failure is worth a retry banner
      ...(failed.length ? { incidentError: `Some bundle files failed to load: ${failed.join(', ')}` } : {}),
    })
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
    pollJobId = null
  }

  function stopWatch() {
    if (watchTimer) clearTimeout(watchTimer)
    watchTimer = null
  }

  /** Poll a job every second until it finishes; then refresh the manifest (and run `onDone`). */
  function pollJob(jobId: string, incidentId: string, onDone?: (job: JobStatus) => void | Promise<void>) {
    stopPolling()
    pollJobId = jobId
    let failures = 0
    const tick = async () => {
      if (get().incidentId !== incidentId || pollJobId !== jobId) return
      try {
        const job = await getJob(jobId)
        if (get().incidentId !== incidentId || pollJobId !== jobId) return
        failures = 0
        set({ job })
        if (job.status === 'done' || job.status === 'error') {
          pollTimer = null
          pollJobId = null
          if (job.status === 'error') set({ incidentError: `${job.kind === 'forecast' ? 'Forecast' : job.kind === 'build' ? 'Build' : 'Refresh'} failed: ${job.error ?? job.message ?? 'unknown error'}` })
          await get().refreshManifest()
          if (job.status === 'done') await onDone?.(job)
          return
        }
      } catch (e) {
        failures++
        if (isNotFound(e)) {
          // The server forgot the job (e.g. it restarted): stop and resync from the manifest.
          pollTimer = null
          pollJobId = null
          set((s) => ({ job: s.job && s.job.id === jobId ? null : s.job }))
          await get().refreshManifest()
          return
        }
        console.warn('[store] job poll failed', e)
        if (failures >= 30) {
          pollTimer = null
          pollJobId = null
          set({ incidentError: `Lost contact with the ${get().job?.kind ?? ''} job: ${errMsg(e)}` })
          return
        }
      }
      pollTimer = setTimeout(tick, JOB_POLL_MS)
    }
    pollTimer = setTimeout(tick, 600)
  }

  /** A bundle reported as "building" without a job we can follow: re-check the manifest every 3 s. */
  function watchBuilding(incidentId: string, token: number, startedMs = Date.now()) {
    stopWatch()
    watchTimer = setTimeout(async () => {
      watchTimer = null
      if (token !== selectToken || get().incidentId !== incidentId || pollJobId) return
      await get().refreshManifest()
      const s = get()
      const building = s.manifest?.status === 'building' || s.summary?.bundle_status === 'building'
      if (building && token === selectToken && !pollJobId && Date.now() - startedMs < 30 * 60_000) watchBuilding(incidentId, token, startedMs)
    }, 3000)
  }

  /** After a forecast job: select the run it produced (or the newest ready run). */
  async function selectFinishedForecast(done: JobStatus) {
    const result = (done.result ?? null) as { run_id?: unknown } | null
    const runId = typeof result?.run_id === 'string' ? result.run_id : (get().manifest?.forecasts.find((f) => f.status === 'ready')?.run_id ?? null)
    if (runId) await get().selectForecast(runId)
  }

  return {
    mode: 'live',
    catalog: { live: [], historical: [], loading: false, error: null, minAcres: 300, updatedMs: { live: null, historical: null } },
    incidentId: null,
    ...perIncidentReset,
    timeMs: Date.now(),
    speedHoursPerSec: 1,
    viewMode: '3d',
    visualStyle: 'hybrid',
    latticeField: 'activity',
    exaggeration: 1.5,
    treeScale: 1,
    dof: true,
    quality: 'high',
    panelsCollapsed: false,
    layers: structuredClone(DEFAULT_LAYERS),
    profilePath: [],
    rightTab: 'layers',
    incidentLoading: false,
    windowPreset: 'all',
    headerTab: 'incident',
    aircraftAll: false,
    liveStatus: null,
    autoBuild: true,

    setMode: (mode) => set((s) => ({ mode, headerTab: mode === 'live' ? s.headerTab : 'incident' })),
    setCatalog: (c) => set((s) => ({ catalog: { ...s.catalog, ...c } })),
    setIncidentId: (incidentId) => set({ incidentId }),
    setSummary: (summary) => set({ summary }),
    setManifest: (manifest) => set({ manifest }),
    setJob: (job) => set({ job }),
    setForecastRunId: (forecastRunId) => set({ forecastRunId }),
    setForecast: (forecast) => set((s) => ({ forecast, timeWindow: windowFor(s.windowPreset, s.manifest, forecast) })),
    setTimeseries: (timeseries) => set({ timeseries }),
    setEvents: (events) => set({ events }),
    setWeather: (weather) => set({ weather }),
    setDetections: (detections) => set({ detections }),
    setPerimeters: (perimeters) => set({ perimeters }),
    setTimeMs: (timeMs) => set({ timeMs: Number.isFinite(timeMs) ? timeMs : get().timeMs }),
    setPlaying: (playing) => set({ playing }),
    togglePlaying: () => set((s) => ({ playing: !s.playing })),
    setSpeedHoursPerSec: (speedHoursPerSec) => set({ speedHoursPerSec }),
    setTimeWindow: (timeWindow) => set({ timeWindow }),
    setViewMode: (viewMode) => set({ viewMode }),
    setVisualStyle: (visualStyle) => set({ visualStyle }),
    setLatticeField: (latticeField) => set({ latticeField }),
    setExaggeration: (exaggeration) => set({ exaggeration }),
    setTreeScale: (treeScale) => set({ treeScale }),
    setDof: (dof) => set({ dof }),
    setQuality: (quality) => set({ quality }),
    setPanelsCollapsed: (panelsCollapsed) => set({ panelsCollapsed }),
    togglePanelsCollapsed: () => set((s) => ({ panelsCollapsed: !s.panelsCollapsed })),
    setLayers: (layers) => set({ layers }),
    setLayer: (key, patch) => set((s) => ({ layers: { ...s.layers, [key]: { ...s.layers[key], ...patch } } })),
    setLayerVisible: (key, visible) => get().setLayer(key, { visible }),
    setLayerOpacity: (key, opacity) => get().setLayer(key, { opacity: Math.min(1, Math.max(0, opacity)) }),
    toggleLayer: (key) => get().setLayer(key, { visible: !get().layers[key].visible }),
    resetLayers: () => set({ layers: structuredClone(DEFAULT_LAYERS) }),
    setAircraft: (aircraft, updatedMs) => set({ aircraft, aircraftUpdatedMs: updatedMs ?? Date.now() }),
    setAircraftUpdatedMs: (aircraftUpdatedMs) => set({ aircraftUpdatedMs }),
    setProfilePath: (profilePath) => set({ profilePath }),
    setDrawingPath: (drawingPath) => set({ drawingPath }),
    setSelectedEventId: (selectedEventId) => set({ selectedEventId }),
    setFlyTo: (flyTo) => set({ flyTo }),
    flyToLocal: (x, z, distance) => set((s) => ({ flyTo: { x, z, distance, nonce: (s.flyTo?.nonce ?? 0) + 1 } })),
    requestFlyTo: (x, z, distance) => get().flyToLocal(x, z, distance),
    setRightTab: (rightTab) => set({ rightTab }),
    setIncidentError: (incidentError) => set({ incidentError }),
    setWindowPreset: (windowPreset) =>
      set((s) => {
        const timeWindow = windowFor(windowPreset, s.manifest, s.forecast)
        const timeMs = timeWindow ? clamp(s.timeMs, timeWindow.startMs, timeWindow.endMs) : s.timeMs
        return { windowPreset, timeWindow, timeMs }
      }),
    setHeaderTab: (headerTab) => set({ headerTab }),
    setAircraftAll: (aircraftAll) => {
      set({ aircraftAll })
      void get().refreshAircraft()
    },
    setAutoBuild: (autoBuild) => set({ autoBuild }),
    stepTime: (deltaMs) =>
      set((s) => {
        const b = getTimeBounds(s)
        return b ? { timeMs: clamp(s.timeMs + deltaMs, b.startMs, b.endMs) } : {}
      }),

    loadCatalog: async (opts) => {
      const modes = opts?.modes ?? (['live', 'historical'] as Mode[])
      const minAcres = opts?.minAcres ?? get().catalog.minAcres
      set((s) => ({ catalog: { ...s.catalog, loading: true, error: null, minAcres } }))
      const [live, hist] = await Promise.allSettled([
        modes.includes('live') ? getIncidents('live') : Promise.resolve(null),
        modes.includes('historical') ? getIncidents('historical', minAcres) : Promise.resolve(null),
      ])
      const errors = [live, hist].filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => errMsg(r.reason))
      set((s) => {
        // a newer request for another threshold may have finished first: keep the latest threshold's list
        const histOk = hist.status === 'fulfilled' && hist.value && s.catalog.minAcres === minAcres
        return {
          catalog: {
            ...s.catalog,
            live: live.status === 'fulfilled' && live.value ? live.value.incidents : s.catalog.live,
            historical: histOk && hist.value ? hist.value.incidents : s.catalog.historical,
            loading: false,
            error: errors.length ? [...new Set(errors)].join('; ') : null,
            updatedMs: {
              live: live.status === 'fulfilled' && live.value ? live.value.updated_ms : s.catalog.updatedMs.live,
              historical: histOk && hist.value ? hist.value.updated_ms : s.catalog.updatedMs.historical,
            },
          },
        }
      })
    },

    selectIncident: async (id, opts) => {
      const token = ++selectToken
      stopPolling()
      stopWatch()
      const same = get().incidentId === id
      set({
        incidentId: id,
        incidentLoading: true,
        ...(same ? { incidentError: null } : { ...perIncidentReset, headerTab: 'incident' as HeaderTab }),
      })
      try {
        const detail = await getIncident(id)
        if (token !== selectToken) return
        set((s) => ({ summary: detail.summary, job: detail.job, mode: detail.summary.mode, catalog: patchCatalog(s.catalog, detail.summary) }))
        const m = detail.manifest
        if (m && m.status === 'ready') {
          await loadBundleFiles(m, token, Boolean(opts?.keepTime && same))
        } else {
          set({ manifest: m })
        }
        if (token !== selectToken) return
        const job = detail.job
        if (job && (job.status === 'queued' || job.status === 'running')) {
          pollJob(job.id, id, job.kind === 'forecast' ? (done) => selectFinishedForecast(done) : undefined)
        } else if ((!m || m.status === 'error') && detail.summary.bundle_status !== 'building') {
          if (opts?.autoBuild && get().autoBuild && !(m?.status === 'error')) void get().startBuild(false)
        } else if (m?.status === 'building' || detail.summary.bundle_status === 'building') {
          watchBuilding(id, token)
        }
      } catch (e) {
        if (token === selectToken) set({ incidentError: errMsg(e) })
      } finally {
        if (token === selectToken) set({ incidentLoading: false })
      }
    },

    startBuild: async (force = false) => {
      const id = get().incidentId
      if (!id) return null
      try {
        const job = await postBuild(id, force)
        if (get().incidentId !== id) return job
        set((s) => ({
          job,
          incidentError: null,
          summary: s.summary ? { ...s.summary, bundle_status: 'building' } : s.summary,
        }))
        if (job.status === 'done' || job.status === 'error') await get().refreshManifest()
        else pollJob(job.id, id)
        return job
      } catch (e) {
        if (get().incidentId === id) set({ incidentError: `Build failed to start: ${errMsg(e)}` })
        return null
      }
    },

    startForecast: async (req = {}) => {
      const s = get()
      const id = s.incidentId
      if (!id) return null
      const body: ForecastRequest = { ...req }
      if (body.start_ms == null && s.mode === 'historical' && s.manifest) {
        const tr = s.manifest.time_range
        const lo = Math.max(tr.start_ms, s.manifest.ignition?.t_ms ?? tr.start_ms)
        body.start_ms = Math.floor(clamp(s.timeMs, lo, tr.end_ms) / HOUR) * HOUR
      }
      try {
        const job = await postForecast(id, body)
        if (get().incidentId !== id) return job
        set({ job, incidentError: null })
        if (job.status === 'done') {
          await get().refreshManifest()
          await selectFinishedForecast(job)
        } else if (job.status === 'error') {
          set({ incidentError: `Forecast failed: ${job.error ?? job.message}` })
        } else {
          pollJob(job.id, id, (done) => selectFinishedForecast(done))
        }
        return job
      } catch (e) {
        if (get().incidentId === id) set({ incidentError: `Forecast failed to start: ${errMsg(e)}` })
        return null
      }
    },

    selectForecast: async (runId) => {
      const m = get().manifest
      if (!runId || !m) {
        set((s) => ({ forecastRunId: null, forecast: null, timeWindow: windowFor(s.windowPreset, s.manifest, null) }))
        return
      }
      set({ forecastRunId: runId })
      try {
        const forecast = await fetchForecast(m, runId)
        if (get().forecastRunId !== runId || get().manifest?.id !== m.id) return
        if (!forecast) {
          set({ forecastRunId: null, forecast: null, incidentError: `Forecast ${runId} is not in the bundle` })
          return
        }
        set((s) => ({ forecast, timeWindow: windowFor(s.windowPreset, s.manifest, forecast) }))
      } catch (e) {
        if (get().forecastRunId === runId) set({ forecastRunId: get().forecast?.run_id ?? null, incidentError: `Could not load forecast ${runId}: ${errMsg(e)}` })
      }
    },

    refreshManifest: async () => {
      const id = get().incidentId
      if (!id) return
      const token = selectToken
      try {
        const detail = await getIncident(id)
        if (token !== selectToken || get().incidentId !== id) return
        const prev = get().manifest
        const running = (j: JobStatus | null) => j != null && (j.status === 'queued' || j.status === 'running')
        set((s) => ({
          summary: detail.summary,
          // keep a job we are polling until its own poll reports the end; otherwise take the server's view
          job: running(s.job) && pollJobId === s.job?.id ? s.job : (detail.job ?? s.job),
          catalog: patchCatalog(s.catalog, detail.summary),
        }))
        if (!pollJobId && running(detail.job) && detail.job) {
          const j = detail.job
          pollJob(j.id, id, j.kind === 'forecast' ? (done) => selectFinishedForecast(done) : undefined)
        }
        const m = detail.manifest
        if (!m) return set({ manifest: null })
        if (m.status !== 'ready') return set({ manifest: m })
        if (!prev || prev.built_ms !== m.built_ms || prev.status !== 'ready') {
          set({ incidentLoading: true })
          try {
            await loadBundleFiles(m, token, true)
          } finally {
            if (token === selectToken) set({ incidentLoading: false })
          }
        } else {
          set({ manifest: m })
          const cur = get().forecastRunId
          const curSummary = cur ? m.forecasts.find((f) => f.run_id === cur) : undefined
          const newest = m.forecasts.find((f) => f.status === 'ready')
          if (cur && !curSummary) await get().selectForecast(newest?.run_id ?? null)
          else if (cur && curSummary && get().forecast && curSummary.issued_ms !== get().forecast?.issued_ms) await get().selectForecast(cur)
          else if (!cur && newest) await get().selectForecast(newest.run_id)
        }
      } catch (e) {
        if (token === selectToken) set({ incidentError: errMsg(e) })
      }
    },

    refreshAircraft: async () => {
      const s = get()
      const id = s.incidentId
      if (!id || s.mode !== 'live') return
      const seq = ++aircraftSeq
      try {
        const res = await getAircraft(id, s.aircraftAll, { timeoutMs: 15_000 })
        if (seq !== aircraftSeq || get().incidentId !== id) return
        set({
          aircraft: res.aircraft,
          aircraftUpdatedMs: res.updated_ms,
          aircraftMeta: { source: res.source, radiusNm: res.radius_nm, note: res.note ?? null, error: null, polledMs: Date.now() },
        })
      } catch (e) {
        if (seq !== aircraftSeq || get().incidentId !== id) return
        set((st) => ({ aircraftMeta: { ...st.aircraftMeta, error: errMsg(e), polledMs: Date.now() } }))
      }
    },

    refreshLiveStatus: async () => {
      try {
        const liveStatus = await getLiveStatus({ timeoutMs: 10_000 })
        set({ liveStatus })
      } catch (e) {
        console.warn('[store] live status failed', e)
      }
    },
  }
})

declare global {
  interface Window {
    /** Dev/test handle: window.__store.getState() / setState() (used by scripts/shot.mjs --eval). */
    __store?: typeof useStore
  }
}

if (typeof window !== 'undefined') window.__store = useStore
