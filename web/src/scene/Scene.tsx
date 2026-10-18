// Fire-3d 3D scene (SPEC 9.0 / 9.3 / 9.6): full-bleed R3F canvas + HTML overlays.
//   LookDriver   visualStyle -> shared look (lighting, sky, fog, grade), animated transitions, sceneStore.env
//   Sky          dark green-black dome (warm sun glow in the realistic look)
//   SunLights    sun (shadow map at high / medium quality) + hemisphere sky light for standard materials
//   Terrain      the one custom terrain shader (realistic / parametric relief, fire, isochrones, contours,
//                forecast, burn scar, fuels, aerial perspective, edge fade)
//   CameraRig    map controls, framing, 2D/3D, flyTo, camera commands, view insets
//   ProbeDriver  hover probe -> sceneStore.probe;  PerfMonitor  fps + quality suggestion
//   SceneFx      scene-fx agent: lattice, trees, smoke, embers, detections, telemetry, ...
//   PostFX       DOF (bokeh), bloom, filmic grade, vignette, SMAA, grain; renders the frame
// Quality (SPEC 9.6): high = DPR <= 2, 4096 shadows, DOF; medium = DPR <= 1.5, 2048 shadows, DOF; low = DPR 1, no
// shadows, no DOF. High / medium also respect a drawing-buffer pixel budget (4.6 / 3.2 MP), so a full-screen Retina
// window renders at a slightly lower ratio. Named + default export (App lazy-loads the default).
import { Canvas } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import * as THREE from 'three'
import { useStore, type Quality } from '../state/store'
import { useIncidentAssets } from './assets'
import { Sky } from './atmosphere/Sky'
import { SunLights } from './atmosphere/SunLights'
import { CameraRig } from './camera/CameraRig'
import { SceneFx } from './fx'
import { LookDriver } from './LookDriver'
import { SceneOverlays } from './overlays/SceneOverlays'
import { SelectionPin } from './overlays/SelectionPin'
import { PerfMonitor } from './perf/PerfMonitor'
import { PostFX } from './post/PostFX'
import { ProbeDriver } from './probe/ProbeDriver'
import { Terrain } from './terrain/Terrain'

const DPR_CAP: Record<Quality, number> = { high: 2, medium: 1.5, low: 1 }
/** Drawing-buffer pixel budget per quality: a large Retina window renders slightly below the device ratio (still
 *  <= the cap) so frame time stays bounded; small windows get the full ratio. */
const PIXEL_BUDGET: Record<Quality, number> = { high: 4.6e6, medium: 3.2e6, low: Number.POSITIVE_INFINITY }
const SHADOWS: Partial<THREE.WebGLShadowMap> = { enabled: true, type: THREE.PCFShadowMap, autoUpdate: false }

/** Device pixel ratio for a quality level and the scene element's CSS size (min 1, <= the SPEC 9.6 cap). */
export function qualityDpr(quality: Quality, cssWidth: number, cssHeight: number, device = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1): number {
  const fit = Math.sqrt(PIXEL_BUDGET[quality] / Math.max(1, cssWidth * cssHeight))
  return Math.round(Math.max(1, Math.min(device, DPR_CAP[quality], fit)) * 100) / 100
}

function useQualityDpr(quality: Quality, rootRef: RefObject<HTMLDivElement | null>): number {
  const [box, setBox] = useState(() => ({ w: typeof window !== 'undefined' ? window.innerWidth : 1600, h: typeof window !== 'undefined' ? window.innerHeight : 900, dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1 }))
  useEffect(() => {
    const el = rootRef.current
    const update = () => {
      const r = el?.getBoundingClientRect()
      const w = Math.round(r?.width || window.innerWidth)
      const h = Math.round(r?.height || window.innerHeight)
      const dpr = window.devicePixelRatio || 1
      setBox((b) => (b.w === w && b.h === h && b.dpr === dpr ? b : { w, h, dpr }))
    }
    update()
    const ro = el ? new ResizeObserver(update) : null
    if (el) ro?.observe(el)
    window.addEventListener('resize', update) // also fires when the window moves to a screen with another ratio
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [rootRef])
  return qualityDpr(quality, box.w, box.h, box.dpr)
}

export function Scene() {
  const quality = useStore((s) => s.quality)
  const rootRef = useRef<HTMLDivElement>(null)
  const dpr = useQualityDpr(quality, rootRef)
  const gl = useMemo(() => ({ antialias: false, alpha: false, stencil: false, depth: true, powerPreference: 'high-performance' as const }), [])
  const camera = useMemo(() => ({ fov: 35, near: 5, far: 200000, position: [2500, 9000, 12000] as [number, number, number] }), [])
  return (
    <div ref={rootRef} className="sc-root">
      <Canvas className="sc-canvas" dpr={dpr} gl={gl} flat shadows={quality === 'low' ? false : SHADOWS} camera={camera}>
        <SceneContent />
      </Canvas>
      <SceneOverlays rootRef={rootRef} />
    </div>
  )
}

export default Scene

function SceneContent() {
  const assets = useIncidentAssets()
  return (
    <>
      <LookDriver />
      <Sky />
      {assets && <SunLights extent={assets.extent} elevMin={assets.elevation.min} elevMax={assets.elevation.max} />}
      {assets && <Terrain assets={assets} />}
      <CameraRig assets={assets} />
      <ProbeDriver assets={assets} />
      {assets && <SelectionPin assets={assets} />}
      <PerfMonitor />
      <SceneFx />
      <PostFX />
    </>
  )
}
