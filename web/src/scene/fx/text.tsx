// Monospace 3D labels for telemetry, ignition and aircraft: drei <Text> (troika SDF) in JetBrains Mono (bundled
// woff; troika's default font if it fails), billboarded to the camera and scaled every frame so one local unit is one
// CSS pixel (constant screen size). Optional hairline leader + anchor dot. useTicker() makes changed digits "tick"
// briefly before settling (SPEC 9.0: only when values change; off with prefers-reduced-motion).
import { Text } from '@react-three/drei'
import { createPortal, useFrame, useThree } from '@react-three/fiber'
import { Component, Suspense, createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import monoMediumUrl from './fonts/JetBrainsMono-Medium.woff?url'
import { ORDER, viewDepth, worldPerPixel } from './common'

export const MONO_FONT = monoMediumUrl

/** Characters preloaded into the SDF atlas (digits, units, punctuation used by the readouts). */
export const MONO_CHARS = ' 0123456789+-−–.,:;%°/()·×|<>=_#*ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** Font used by ScreenLabel (undefined -> troika's default font). */
const FontContext = createContext<string | undefined>(MONO_FONT)

interface FontBoundaryState {
  failed: boolean
}

/** Suspense boundary for labels (troika loads the font asynchronously). If the bundled font fails, the labels
 *  re-render with troika's default font. */
export class FontBoundary extends Component<{ children: ReactNode }, FontBoundaryState> {
  state: FontBoundaryState = { failed: false }
  static getDerivedStateFromError(): FontBoundaryState {
    return { failed: true }
  }
  componentDidCatch(err: unknown): void {
    console.warn('[scene-fx] telemetry font unavailable, using the default font', err)
  }
  render(): ReactNode {
    return (
      <FontContext.Provider value={this.state.failed ? undefined : MONO_FONT}>
        <Suspense fallback={null}>{this.props.children}</Suspense>
      </FontContext.Provider>
    )
  }
}

const OverlayContext = createContext<THREE.Scene | null>(null)

/** Overlay pass for labels: a separate scene drawn with the main camera AFTER the frame is rendered (after
 *  scene-core's post-processing), so depth of field, bloom and grain never blur the monospace readouts. If no other
 *  positive-priority render subscriber exists (no composer), it renders the main scene first. Wrap the fx tree. */
export function Overlay({ children }: { children: ReactNode }) {
  const [scene] = useState(() => new THREE.Scene())
  useFrame((state) => {
    const gl = state.gl
    if (state.internal.priority <= 1) gl.render(state.scene, state.camera)
    if (scene.children.length === 0) return
    const autoClear = gl.autoClear
    gl.autoClear = false
    gl.clearDepth()
    gl.render(scene, state.camera)
    gl.autoClear = autoClear
  }, 100)
  return <OverlayContext.Provider value={scene}>{children}</OverlayContext.Provider>
}

/** Render labels into the overlay pass (inline when there is no Overlay), inside a font Suspense boundary. */
export function InOverlay({ children }: { children: ReactNode }) {
  const scene = useContext(OverlayContext)
  const content = <FontBoundary>{children}</FontBoundary>
  return scene ? <>{createPortal(content, scene)}</> : content
}

function scramble(from: string, to: string, progress: number): string {
  const settle = Math.floor(to.length * progress)
  let out = ''
  for (let i = 0; i < to.length; i++) {
    const c = to.charCodeAt(i)
    if (i >= settle && c >= 48 && c <= 57 && from.charCodeAt(i) !== c) out += String.fromCharCode(48 + Math.floor(Math.random() * 10))
    else out += to[i]
  }
  return out
}

/** Displayed text for `target`: when it changes, differing digits scramble and settle left to right (~0.3 s).
 *  Rate-limited so continuous playback does not flicker constantly. */
export function useTicker(target: string, enabled: boolean): string {
  const [shown, setShown] = useState(target)
  const prev = useRef(target)
  const lastTick = useRef(0)
  useEffect(() => {
    const from = prev.current
    prev.current = target
    const now = performance.now()
    if (!enabled || from === target || now - lastTick.current < 700) {
      setShown(target)
      return
    }
    lastTick.current = now
    const steps = 7
    let k = 0
    setShown(scramble(from, target, 0))
    const id = window.setInterval(() => {
      k++
      if (k >= steps) {
        window.clearInterval(id)
        setShown(target)
      } else setShown(scramble(from, target, k / steps))
    }, 45)
    return () => window.clearInterval(id)
  }, [target, enabled])
  return shown
}

const unitPlane = new THREE.PlaneGeometry(1, 1)
const unitCircle = new THREE.CircleGeometry(1, 16)
/** Base material for every label: always on top (drawn last), never writes depth. */
const labelMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false })

export interface ScreenLabelProps {
  /** Fill `out` with the world anchor (exaggerated y); return false to hide the label this frame. */
  anchor: (out: THREE.Vector3) => boolean
  text: string
  /** Offset (CSS px) from the anchor to the text block's anchor point: x right, y up. */
  offset?: [number, number]
  fontPx?: number
  lineHeight?: number
  color?: THREE.ColorRepresentation
  /** Per-character colours (troika colorRanges: start index -> colour). */
  colorRanges?: Record<number, THREE.ColorRepresentation>
  opacity?: number
  /** Extra per-frame fade 0..1 (declutter), read every frame. */
  fade?: { current: number }
  anchorX?: 'left' | 'center' | 'right'
  anchorY?: 'top' | 'middle' | 'bottom' | 'bottom-baseline' | 'top-baseline'
  textAlign?: 'left' | 'right' | 'center'
  leader?: boolean
  dot?: boolean
  lineColor?: THREE.ColorRepresentation
  /** Screen position (CSS px, origin top-left) written every frame when visible, for declutter tests. */
  screen?: { x: number; y: number; visible: boolean }
  /** When true (read every frame) the block mirrors to the left of the anchor (e.g. near the right edge). */
  flip?: { current: boolean }
}

const _ndc = new THREE.Vector3()

export function ScreenLabel(p: ScreenLabelProps) {
  const group = useRef<THREE.Group>(null)
  const text = useRef<THREE.Mesh & { fillOpacity: number; outlineOpacity: number }>(null)
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const font = useContext(FontContext)
  const pos = useMemo(() => new THREE.Vector3(), [])
  const offset = p.offset ?? [0, 0]
  const lineMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: new THREE.Color(p.lineColor ?? p.color ?? '#E8C77E'), transparent: true, depthTest: false, depthWrite: false, opacity: 0.55, toneMapped: false }),
    [p.lineColor, p.color],
  )
  useEffect(() => () => lineMat.dispose(), [lineMat])
  const leaderRef = useRef<THREE.Mesh>(null)
  const flipped = useRef(false)
  const leader = useMemo(() => {
    const len = Math.hypot(offset[0], offset[1])
    return { len, angle: Math.atan2(offset[1], offset[0]), mid: [offset[0] / 2, offset[1] / 2] as [number, number] }
  }, [offset[0], offset[1]]) // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(() => {
    const g = group.current
    if (!g) return
    let ok = p.anchor(pos)
    let depth = 0
    if (ok) {
      depth = viewDepth(camera, pos.x, pos.y, pos.z)
      ok = depth > 1
    }
    const fade = (p.fade ? p.fade.current : 1) * (p.opacity ?? 0.72)
    g.visible = ok && fade > 0.01
    if (p.screen) p.screen.visible = g.visible
    if (!g.visible) return
    g.position.copy(pos)
    g.quaternion.copy(camera.quaternion)
    g.scale.setScalar(worldPerPixel(camera, size.height, depth))
    if (text.current) {
      text.current.fillOpacity = fade
      text.current.outlineOpacity = fade * 0.85
    }
    lineMat.opacity = fade * 0.6
    const wantFlip = p.flip?.current ?? false
    if (wantFlip !== flipped.current && text.current) {
      flipped.current = wantFlip
      const t = text.current as unknown as THREE.Mesh & { anchorX: string; sync: () => void }
      const sx = wantFlip ? -1 : 1
      t.anchorX = wantFlip ? 'right' : (p.anchorX ?? 'left')
      t.position.x = offset[0] * sx
      t.sync()
      const l = leaderRef.current
      if (l) {
        l.position.x = leader.mid[0] * sx
        l.rotation.z = Math.atan2(offset[1], offset[0] * sx)
      }
    }
    if (p.screen) {
      _ndc.copy(pos).project(camera)
      p.screen.x = (_ndc.x * 0.5 + 0.5) * size.width
      p.screen.y = (0.5 - _ndc.y * 0.5) * size.height
    }
  })

  return (
    <group ref={group} renderOrder={ORDER.telemetry}>
      <Text
        ref={text}
        font={font}
        characters={MONO_CHARS}
        fontSize={p.fontPx ?? 11}
        lineHeight={p.lineHeight ?? 1.32}
        letterSpacing={0.02}
        position={[offset[0], offset[1], 0]}
        anchorX={p.anchorX ?? 'left'}
        anchorY={p.anchorY ?? 'bottom'}
        textAlign={p.textAlign ?? 'left'}
        color={p.color ?? '#E8C77E'}
        {...({ colorRanges: p.colorRanges ?? null } as Record<string, unknown>)}
        material={labelMaterial}
        outlineWidth="18%"
        outlineBlur="60%"
        outlineColor="#030504"
        outlineOpacity={0.62}
        renderOrder={ORDER.telemetry}
        sdfGlyphSize={64}
      >
        {p.text}
      </Text>
      {p.leader && leader.len > 1 && (
        <mesh
          ref={leaderRef}
          geometry={unitPlane}
          material={lineMat}
          position={[leader.mid[0], leader.mid[1], 0]}
          rotation={[0, 0, leader.angle]}
          scale={[leader.len, 1, 1]}
          renderOrder={ORDER.telemetry}
        />
      )}
      {p.dot && <mesh geometry={unitCircle} material={lineMat} scale={[2.2, 2.2, 1]} renderOrder={ORDER.telemetry} />}
    </group>
  )
}
