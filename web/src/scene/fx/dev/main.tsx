// FX isolation page (web/fx-dev.html): a minimal Canvas with a simple displaced terrain + <SceneFx/> + bloom/DOF,
// independent of scene-core's Scene. Loads an incident into the store itself.
// URL params: ?incident=<id> (default fixture-demo); time: ?t=<epoch ms> | ?th=<hours since origin> | ?tf=<0..1 of
// the range>; ?style=hybrid|realistic|parametric; ?field=activity|...; ?quality=high|medium|low; ?exag=1.5;
// ?trees=<treeScale>; ?layers=+wind,-trees; ?dof=0|1; ?play=1&speed=3; ?cam=px,py,pz,tx,ty,tz; ?panel=0.
// window.__fxDev: { measureFps(ms) -> {fps, p95Ms, frames}, setCamera(px,py,pz,tx,ty,tz) } for scripts/shot.mjs.
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { StrictMode, useEffect, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import '../../../styles/theme.css'
import { useLivePolling, usePlayback } from '../../../state/runtime'
import { getTimeBounds, LAYER_KEYS, useStore, type LatticeField, type LayerKey, type Quality, type VisualStyle } from '../../../state/store'
import { SceneFx } from '../index'
import { fxShared, fxStore } from '../state'
import { DevPanel } from './DevPanel'
import { DevPost } from './DevPost'
import { DevWorld } from './DevWorld'

const DPR: Record<Quality, [number, number]> = { high: [1, 2], medium: [1, 1.5], low: [1, 1] }

declare global {
  interface Window {
    __fxStore?: typeof fxStore
    __fxScene?: THREE.Scene
    __fxShared?: typeof fxShared
    __fxDev?: {
      measureFps: (ms?: number) => Promise<{ fps: number; p95Ms: number; frames: number }>
      setCamera: (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => void
      /** Mean GPU time (ms) of the whole frame over the last `frames` measured frames (timer queries). */
      gpuMs: (frames?: number) => number | null
    }
  }
}

/** GPU time of the whole frame (scene + post + label overlay) via EXT_disjoint_timer_query_webgl2. */
const gpuSamples: number[] = []
function GpuTimer() {
  const gl = useThree((s) => s.gl)
  const st = useMemo(() => {
    const ctx = gl.getContext() as WebGL2RenderingContext
    const ext = ctx.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null
    return { ctx, ext, pending: [] as WebGLQuery[], active: null as WebGLQuery | null }
  }, [gl])
  useFrame(() => {
    const { ctx, ext } = st
    if (!ext || st.active) return
    st.active = ctx.createQuery()
    if (st.active) ctx.beginQuery(ext.TIME_ELAPSED_EXT, st.active)
  }, 0.5)
  useFrame(() => {
    const { ctx, ext } = st
    if (!ext || !st.active) return
    ctx.endQuery(ext.TIME_ELAPSED_EXT)
    st.pending.push(st.active)
    st.active = null
    while (st.pending.length) {
      const q = st.pending[0]
      if (!ctx.getQueryParameter(q, ctx.QUERY_RESULT_AVAILABLE)) break
      const disjoint = ctx.getParameter(ext.GPU_DISJOINT_EXT)
      const ns = ctx.getQueryParameter(q, ctx.QUERY_RESULT) as number
      if (!disjoint) gpuSamples.push(ns / 1e6)
      if (gpuSamples.length > 600) gpuSamples.shift()
      ctx.deleteQuery(q)
      st.pending.shift()
    }
  }, 1000)
  return null
}

function DevHandle() {
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  useEffect(() => {
    window.__fxScene = scene
  }, [scene])
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null
  useEffect(() => {
    window.__fxDev = {
      measureFps: (ms = 4000) =>
        new Promise((resolve) => {
          const times: number[] = []
          let last = performance.now()
          const t0 = last
          const tick = (now: number) => {
            times.push(now - last)
            last = now
            if (now - t0 < ms) requestAnimationFrame(tick)
            else {
              const sorted = times.slice(1).sort((a, b) => a - b)
              const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)
              resolve({ fps: Math.round(1000 / mean), p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10, frames: sorted.length })
            }
          }
          requestAnimationFrame(tick)
        }),
      gpuMs: (frames = 120) => {
        const a = gpuSamples.slice(-frames)
        return a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 : null
      },
      setCamera: (px, py, pz, tx, ty, tz) => {
        camera.position.set(px, py, pz)
        camera.lookAt(tx, ty, tz)
        if (controls) {
          controls.target.set(tx, ty, tz)
          controls.update()
        }
      },
    }
  }, [camera, controls])
  return null
}

window.__fxStore = fxStore
window.__fxShared = fxShared

function applyParams(q: URLSearchParams) {
  const s = useStore.getState()
  const style = q.get('style') as VisualStyle | null
  if (style) s.setVisualStyle(style)
  const field = q.get('field') as LatticeField | null
  if (field) s.setLatticeField(field)
  const quality = q.get('quality') as Quality | null
  if (quality) s.setQuality(quality)
  if (q.get('exag')) s.setExaggeration(Number(q.get('exag')))
  if (q.get('trees')) s.setTreeScale(Number(q.get('trees')))
  if (q.get('dof')) s.setDof(q.get('dof') === '1')
  // "+" decodes to a space in query strings: " wind" means "+wind"
  for (const raw of (q.get('layers') ?? '').split(',')) {
    const tok = raw.trim()
    if (!tok) continue
    const key = tok.replace(/^[+-]/, '') as LayerKey
    if (LAYER_KEYS.includes(key)) s.setLayerVisible(key, !tok.startsWith('-'))
  }
}

function applyTime(q: URLSearchParams) {
  const s = useStore.getState()
  const m = s.manifest
  if (!m) return
  const b = getTimeBounds(s)
  if (q.get('t')) s.setTimeMs(Number(q.get('t')))
  else if (q.get('th')) s.setTimeMs(m.time_origin_ms + Number(q.get('th')) * 3.6e6)
  else if (q.get('tf') && b) s.setTimeMs(b.startMs + Number(q.get('tf')) * (b.endMs - b.startMs))
  if (q.get('speed')) s.setSpeedHoursPerSec(Number(q.get('speed')))
  if (q.get('play') === '1') s.setPlaying(true)
}

function FxDevApp() {
  usePlayback()
  useLivePolling()
  const quality = useStore((s) => s.quality)
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    applyParams(q)
    void useStore
      .getState()
      .selectIncident(q.get('incident') ?? 'fixture-demo')
      .then(() => {
        applyTime(q)
        if (useStore.getState().mode === 'live') void useStore.getState().refreshAircraft()
      })
  }, [])
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#060a08' }}>
      <Canvas
        dpr={DPR[quality]}
        flat
        shadows
        gl={{ antialias: false, powerPreference: 'high-performance', stencil: false }}
        camera={{ fov: 38, near: 5, far: 250000, position: [3000, 7000, 11000] }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <color attach="background" args={['#060a08']} />
        <DevWorld />
        <SceneFx />
        <DevPost />
        <DevHandle />
        <GpuTimer />
      </Canvas>
      <DevPanel />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FxDevApp />
  </StrictMode>,
)
