// Frame-rate meter (sceneStore.fps, every 0.5 s) and the SPEC 9.6 auto-suggestion: after 5 s below 30 fps at
// high (or medium) quality, sceneStore.qualitySuggestion proposes the next lower level (the overlay shows it).
import { useFrame } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { useStore } from '../../state/store'
import { useSceneStore } from '../sceneStore'

const WINDOW_MS = 500
const SUSTAIN_MS = 5000
const WARMUP_MS = 6000

export function PerfMonitor() {
  const st = useRef({ frames: 0, t0: 0, lowSince: 0, mounted: 0 })
  const quality = useStore((s) => s.quality)

  useEffect(() => {
    st.current.mounted = performance.now()
    st.current.lowSince = 0
    useSceneStore.getState().setQualitySuggestion(null)
  }, [quality])

  useFrame(() => {
    const s = st.current
    const now = performance.now()
    if (s.t0 === 0) s.t0 = now
    s.frames++
    const dt = now - s.t0
    if (dt < WINDOW_MS) return
    const fps = (s.frames * 1000) / dt
    s.frames = 0
    s.t0 = now
    const ss = useSceneStore.getState()
    ss.setFps(Math.round(fps * 10) / 10)
    const q = useStore.getState().quality
    const hidden = typeof document !== 'undefined' && document.hidden
    if (hidden || q === 'low' || now - s.mounted < WARMUP_MS || !ss.terrainReady) {
      s.lowSince = 0
      return
    }
    if (fps < 30) {
      if (!s.lowSince) s.lowSince = now
      else if (now - s.lowSince >= SUSTAIN_MS && !ss.qualitySuggestion) ss.setQualitySuggestion(q === 'high' ? 'medium' : 'low')
    } else {
      s.lowSince = 0
    }
  })
  return null
}
