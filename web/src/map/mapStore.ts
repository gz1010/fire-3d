// Runtime state of the Public/Command map shared by MapView and the separately mounted MapControls, MapLegend and
// MapAttribution (owner: map-core): the live MapLibre instance (null while unmounted), the camera for the compass and
// scale, provider health, the forecast display choice and what the overlays currently show (for the legend).
// Brief 2 adds the camera actions of the controls (orbit group, "Incident" toggle, "Try aerial again"), the framing
// state (dev handle / tests: wait for `framing === 'done'`) and the fire bounds (I4). The aerial fallback itself lives in
// the workspace store (basemapFallback, set by the controller).
import type { Map as MapLibreMap } from 'maplibre-gl'
import { create } from 'zustand'
import type { LonLatBox } from '../lib/fireBounds'
import type { FrameGoal, FramingPhase } from './framing'
import type { ForecastFrame, ForecastView } from './overlayModel'

export type ProviderId = 'basemap' | 'vector' | 'imagery' | 'terrain'
export type ProviderState = 'idle' | 'ok' | 'failed'

export interface ProviderStatus {
  state: ProviderState
  /** Short reason for a failure (never a URL with secrets; these providers need none). */
  detail: string | null
}

export interface CameraState {
  lon: number
  lat: number
  zoom: number
  bearing: number
  pitch: number
}

export type OverlayStatus = 'none' | 'loading' | 'ready' | 'missing' | 'error'

export interface OverlayInfo {
  observed: { status: OverlayStatus; asOfMs: number | null; burnedPx: number; recentPx: number; error: string | null }
  forecast: {
    status: OverlayStatus
    runId: string | null
    members: number | null
    issuedMs: number | null
    frame: ForecastFrame | null
    /** Pixel count per class (0 none, 1 >= 10 %, 2 >= 50 %, 3 >= 90 % of runs). */
    counts: number[] | null
    error: string | null
  }
  detections: { counts: [number, number, number]; total: number }
  perimeter: { latestMs: number | null; count: number }
  events: number
  /** Other prepared fires whose latest perimeter is outlined (decision 10). */
  nearby: number
}

export const EMPTY_OVERLAYS: OverlayInfo = {
  observed: { status: 'none', asOfMs: null, burnedPx: 0, recentPx: 0, error: null },
  forecast: { status: 'none', runId: null, members: null, issuedMs: null, frame: null, counts: null, error: null },
  detections: { counts: [0, 0, 0], total: 0 },
  perimeter: { latestMs: null, count: 0 },
  events: 0,
  nearby: 0,
}

const OK: ProviderStatus = { state: 'idle', detail: null }

/** Camera actions of the map controls, implemented by MapController (null while the map is unmounted). */
export interface MapActions {
  /** Frame the open fire (fire bounds, I4). */
  frameFire(): void
  /** Frame the open fire's modeled area (AOI). */
  frameArea(): void
  /** Frame the lower 48 (the overview). */
  frameOverview(): void
  /** Rotate by `deg` (clockwise), tilt by `deg` (3D), straight down (3D, terrain kept), north up. */
  rotateBy(deg: number): void
  tiltBy(deg: number): void
  topDown(): void
  northUp(): void
  /** Zoom in / out by `delta` levels (relative to the opening fit while it is still flying). */
  zoomBy(delta: number): void
  /** End the aerial fallback and load the USGS photos again. */
  retryAerial(): void
}
export interface MapRuntimeState {
  map: MapLibreMap | null
  camera: CameraState | null
  providers: Record<ProviderId, ProviderStatus>
  /** 3D terrain is drawn (3D perspective and the DEM provider works). */
  terrainOn: boolean
  /** How the selected forecast is shown (the legend offers the choice). */
  forecastView: ForecastView
  overlays: OverlayInfo
  /** Is any part of the modeled area on screen? null = no modeled area (no ready bundle). */
  aoiInView: boolean | null
  setForecastView: (v: ForecastView) => void
  actions: MapActions | null
  /** Opening-camera state (map/framing.ts). */
  framing: FramingPhase
  /** What the camera was last framed on and still shows (fire / modeled area / overview), else null. */
  framedKind: FrameGoal['kind'] | null
  /** The open fire's bounds (I4), once its data is in. */
  fireBounds: LonLatBox | null
  /** Brief 3 (§14.11): the visible map area inside the safe-area padding [w, s, e, n], updated when the camera settles
   *  (the overview list's "in this view"); null before the map has settled once. */
  viewBox: LonLatBox | null
}

export const useMapRuntime = create<MapRuntimeState>()((set) => ({
  map: null,
  camera: null,
  providers: { basemap: OK, vector: OK, imagery: OK, terrain: OK },
  terrainOn: false,
  forecastView: 'auto',
  overlays: EMPTY_OVERLAYS,
  aoiInView: null,
  setForecastView: (forecastView) => set({ forecastView }),
  actions: null,
  framing: 'idle',
  framedKind: null,
  fireBounds: null,
  viewBox: null,
}))

/** Set one provider's status (no-op when unchanged). */
export function setProvider(id: ProviderId, state: ProviderState, detail: string | null = null): void {
  const cur = useMapRuntime.getState().providers[id]
  if (cur.state === state && cur.detail === detail) return
  useMapRuntime.setState((s) => ({ providers: { ...s.providers, [id]: { state, detail } } }))
}

export function patchOverlays(patch: Partial<OverlayInfo>): void {
  useMapRuntime.setState((s) => ({ overlays: { ...s.overlays, ...patch } }))
}

/** Metres per CSS pixel at a latitude and zoom (MapLibre's 512 px world). */
export function metersPerPixel(lat: number, zoom: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * Math.pow(2, zoom))
}

/** Duration for camera moves: 0 when the user prefers reduced motion. */
export function motionMs(ms: number): number {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : ms
}

declare global {
  interface Window {
    /** Dev/test handle: window.__mapRuntime.getState().map (scripts/shot.mjs --eval). */
    __mapRuntime?: typeof useMapRuntime
  }
}

if (typeof window !== 'undefined') window.__mapRuntime = useMapRuntime
