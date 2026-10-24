// Scene-only transient state (SPEC 9.2): hover probe, FPS, DOF focus distance, terrain readiness.
// Kept out of the app store so per-frame updates never re-render the UI tree.
//
// Additions (scene-core): the current lighting/atmosphere `env` (so scene-fx materials can match the terrain
// shading and fog), a camera summary for the HTML overlays, the baked terrain sun-shadow texture, a shadow-map
// refresh request, the quality suggestion, view insets (screen area hidden by UI panels) and camera commands.
import type * as THREE from 'three'
import { create } from 'zustand'
import type { Quality, VisualStyle } from '../state/store'

export interface Probe {
  x: number
  z: number
  lat: number
  lon: number
  elev: number // m
  fuel: number // FBFM40 code (0 = nodata)
  arrivalH: number | null // observed arrival, hours since time_origin (null = unburned)
  pBurn: number | null // forecast burn probability 0..1 (null without a forecast)
  slope: number // rise/run
  /** Addition: cursor position in CSS px relative to the scene element. */
  screenX?: number
  screenY?: number
  /** Addition: canopy cover percent (null when unknown). */
  canopyPct?: number | null
  /** Addition: forecast median arrival, hours since time_origin (null = not reached / no forecast). */
  arrivalP50H?: number | null
  /** Addition: forecast P(burned by the current timeline time) 0..1 (null without a forecast). */
  pBurnNow?: number | null
}

/** Current lighting + atmosphere in world space, linear RGB (premultiplied by intensity where noted). Published by
 *  scene-core every time the visual style changes, so other scene materials can match the terrain look. */
export interface SceneEnv {
  style: VisualStyle
  /** Unit vector pointing TOWARD the sun (world: x east, y up, z south). */
  sunDir: [number, number, number]
  /** Sun radiance colour x intensity as used by the terrain shader (outgoing = albedo * sunColor * N.L). */
  sunColor: [number, number, number]
  /** Hemisphere sky / ground ambient colour x intensity. */
  skyAmbient: [number, number, number]
  groundAmbient: [number, number, number]
  /** Sky dome gradient (linear). */
  skyZenith: [number, number, number]
  skyHorizon: [number, number, number]
  skyGround: [number, number, number]
  /** Aerial perspective: density per metre (at the base height) and exponential height falloff per metre. */
  fogColor: [number, number, number]
  fogDensity: number
  fogFalloff: number
  fogBaseY: number // world y (exaggerated) where the density applies
  /** 0 photographic terrain .. 1 dark parametric relief. */
  reliefMix: number
  /** Gain for luminous parametric lines (hybrid 1, realistic ~0.6, parametric ~1.4). */
  lineGain: number
}

/** Camera summary for overlays (updated at most ~15 Hz and only when it changes). */
export interface CameraInfo {
  /** View bearing: compass direction the camera looks toward, degrees clockwise from north. */
  bearingDeg: number
  /** Angle from straight down (0 = top-down 2D). */
  polarDeg: number
  /** Distance camera -> orbit target (m). */
  distance: number
  /** Metres per CSS pixel at the orbit target. */
  metersPerPixel: number
  target: [number, number, number]
}

/** Screen area (CSS px) covered by floating UI on each side; the camera centres the view in what remains. */
export interface ViewInsets {
  top: number
  right: number
  bottom: number
  left: number
}

/** One-time scan sweep when an incident loads (SPEC 9.0): a gold ring expanding from the fire centre that reveals the
 *  parametric overlays. Times are performance.now() ms; radius in metres. */
export interface ScanSweep {
  startedAt: number
  durationMs: number
  cx: number
  cz: number
  radius: number
}

/** One-shot camera commands. Brief 4 (decision f): 'rotate' turns the heading by `deg` (clockwise positive; Q / E,
 *  the ⟲ ⟳ buttons, ← → on the compass), 'set-heading' sets it to `deg` at once (compass drag, Safari and touch
 *  twists); 'reset-north' is heading 0 (N, a compass click). Both work in 2D and 3D. */
export type CameraCommandKind = 'reset-north' | 'frame-fire' | 'zoom-in' | 'zoom-out' | 'rotate' | 'set-heading'
export interface CameraCommand {
  kind: CameraCommandKind
  /** 'rotate': degrees to turn; 'set-heading': the compass heading in degrees. */
  deg?: number
  nonce: number
}

export interface SceneState {
  probe: Probe | null
  fps: number
  focusDistance: number
  terrainReady: boolean
  setProbe: (p: Probe | null) => void
  setFps: (fps: number) => void
  setFocusDistance: (d: number) => void
  setTerrainReady: (v: boolean) => void

  /** Addition: lighting/atmosphere (null until the scene mounted). */
  env: SceneEnv | null
  setEnv: (env: SceneEnv) => void
  /** Addition: camera summary for the compass / scale bar. */
  camera: CameraInfo | null
  setCamera: (c: CameraInfo) => void
  /** Addition: baked terrain sun-visibility texture (R channel 0 shadow .. 1 lit), plane UV; matches env.sunDir and
   *  the current exaggeration. Trees etc. can sample it at their ground UV to sit in ridge shadows. */
  terrainShadow: THREE.Texture | null
  setTerrainShadow: (t: THREE.Texture | null) => void
  /** Addition: bump to re-render the (static) shadow map, e.g. after trees changed. */
  shadowVersion: number
  requestShadowUpdate: () => void
  /** Addition: suggested lower quality after sustained low FPS (null = none). */
  qualitySuggestion: Quality | null
  setQualitySuggestion: (q: Quality | null) => void
  /** Addition: screen insets hidden by UI panels (CSS px). */
  viewInsets: ViewInsets
  setViewInsets: (v: ViewInsets) => void
  /** Addition: one-shot camera commands (compass click and drag, turn buttons, frame fire, zoom buttons). */
  cameraCommand: CameraCommand | null
  issueCameraCommand: (kind: CameraCommandKind, deg?: number) => void
  /** Addition: true while the user drags/orbits the camera (overlays hide the probe). */
  interacting: boolean
  setInteracting: (v: boolean) => void
  /** Addition: the current scan sweep (null when none ran / reduced motion). */
  sweep: ScanSweep | null
  setSweep: (s: ScanSweep | null) => void
}

export const useSceneStore = create<SceneState>()((set) => ({
  probe: null,
  fps: 0,
  focusDistance: 8000,
  terrainReady: false,
  setProbe: (probe) => set({ probe }),
  setFps: (fps) => set({ fps }),
  setFocusDistance: (focusDistance) => set({ focusDistance }),
  setTerrainReady: (terrainReady) => set({ terrainReady }),

  env: null,
  setEnv: (env) => set({ env }),
  camera: null,
  setCamera: (camera) => set({ camera }),
  terrainShadow: null,
  setTerrainShadow: (terrainShadow) => set({ terrainShadow }),
  shadowVersion: 0,
  requestShadowUpdate: () => set((s) => ({ shadowVersion: s.shadowVersion + 1 })),
  qualitySuggestion: null,
  setQualitySuggestion: (qualitySuggestion) => set({ qualitySuggestion }),
  viewInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  setViewInsets: (v) =>
    set((s) =>
      s.viewInsets.top === v.top && s.viewInsets.right === v.right && s.viewInsets.bottom === v.bottom && s.viewInsets.left === v.left
        ? s
        : { viewInsets: v },
    ),
  cameraCommand: null,
  issueCameraCommand: (kind, deg) =>
    set((s) => ({ cameraCommand: { kind, ...(deg != null && Number.isFinite(deg) ? { deg } : {}), nonce: (s.cameraCommand?.nonce ?? 0) + 1 } })),
  interacting: false,
  setInteracting: (interacting) => set({ interacting }),
  sweep: null,
  setSweep: (sweep) => set({ sweep }),
}))

declare global {
  interface Window {
    /** Dev/test handle: window.__sceneStore.getState() (probe, fps, camera, env, ...). */
    __sceneStore?: typeof useSceneStore
  }
}

if (typeof window !== 'undefined') window.__sceneStore = useSceneStore
