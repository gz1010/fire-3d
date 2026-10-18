// Elevation-profile path (SPEC 9.3): store.profilePath drawn as a draped gold polyline with vertex markers and
// 1 km ticks (matching the Elevation Profile chart's distance axis). While store.drawingPath is true, clicks on the
// terrain (raycastHeightfield) add vertices — the first click starts a new path — with a dashed rubber-band preview
// to the cursor; Esc or double-click ends drawing (a path with < 2 points restores the previous one).
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { raycastHeightfield } from '../../lib/geo'
import { useStore } from '../../state/store'
import type { IncidentAssets } from '../assets'
import { GLSL_COMMON, GLSL_OUTPUT, GLSL_VERT, HEX, ORDER, fxUniforms, makeHeightSampler, useLayer } from './common'
import { GLSL_RIBBON_FRAG, GLSL_RIBBON_VERT, GLSL_SPRITE_VERT, drape, ribbonGeometry, spriteGeometry } from './lines'

const lineVert = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
${GLSL_RIBBON_VERT}
uniform float uWidth;
uniform float uOpacity;
varying float vAlpha;
void main() {
  gl_Position = fxRibbon(uWidth, 6.0, 0.0022);
  vec3 world = vec3(position.x, position.y * uExag, position.z);
  vAlpha = fxKeep(world) * uOpacity;
}
`

const lineFrag = /* glsl */ `
${GLSL_COMMON}
${GLSL_RIBBON_FRAG}
uniform vec3 uColor;
uniform float uDash;
varying float vAlpha;
void main() {
  float a = fxRibbonAlpha();
  float glow = fxRibbonGlow();
  float dash = uDash > 0.0 ? step(0.45, fract(vAlong / uDash)) : 1.0;
  gl_FragColor = vec4(uColor * (0.8 + 0.7 * glow), vAlpha * a * dash);
  ${GLSL_OUTPUT}
}
`

const markVert = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
${GLSL_SPRITE_VERT}
attribute vec4 iPos; // x, elevation (m), z, kind (0 vertex, 1 start, 2 end, 3 km tick)
uniform float uOpacity;
varying float vKind;
varying float vAlpha;
void main() {
  vec3 world = vec3(iPos.x, iPos.y * uExag + 6.0, iPos.z);
  vKind = iPos.w;
  float hp = iPos.w > 2.5 ? 2.6 : (iPos.w > 0.5 ? 6.0 : 4.5);
  gl_Position = fxSprite(world, hp * uPixelRatio, 0.003);
  vAlpha = fxKeep(world) * uOpacity;
}
`

const markFrag = /* glsl */ `
${GLSL_COMMON}
uniform vec3 uColor;
varying vec2 vQuad;
varying float vKind;
varying float vAlpha;
void main() {
  float r = length(vQuad);
  if (r > 1.0) discard;
  float a;
  if (vKind > 2.5) a = smoothstep(1.0, 0.6, r);                     // km tick: dot
  else if (vKind > 0.5) a = smoothstep(1.0, 0.82, r) * (r > 0.55 ? 1.0 : 0.85); // start/end: filled ring
  else a = smoothstep(1.0, 0.8, r) * smoothstep(0.45, 0.62, r);    // vertex: hollow ring
  gl_FragColor = vec4(uColor * 1.3, a * vAlpha);
  ${GLSL_OUTPUT}
}
`

function makeLineMaterial(width: number, dash: number, color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: lineVert,
    fragmentShader: lineFrag,
    uniforms: { ...fxUniforms, uWidth: { value: width }, uOpacity: { value: 1 }, uColor: { value: color }, uDash: { value: dash } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  })
}

export function ProfilePath({ assets }: { assets: IncidentAssets }) {
  const { visible, opacity } = useLayer('profilePath')
  const path = useStore((s) => s.profilePath)
  const drawing = useStore((s) => s.drawingPath)
  const { gl, camera } = useThree()
  const hs = useMemo(() => makeHeightSampler(assets.elevation, assets.extent), [assets.elevation, assets.extent])
  const maxSeg = Math.max(15, assets.extent / assets.elevation.width)

  const built = useMemo(() => {
    if (path.length < 1) return null
    const flat = new Float64Array(path.length * 2)
    path.forEach(([x, z], i) => {
      flat[i * 2] = x
      flat[i * 2 + 1] = z
    })
    const pts = drape(flat, hs, maxSeg, false)
    const line = path.length >= 2 ? ribbonGeometry([{ pts, constData: [0, 0, 0, 0] }]) : null
    const marks: number[] = []
    path.forEach(([x, z], i) => marks.push(x, hs(x, z), z, i === 0 ? 1 : i === path.length - 1 ? 2 : 0))
    let dist = 0
    let nextKm = 1000
    for (let i = 1; i < path.length; i++) {
      const [ax, az] = path[i - 1]
      const [bx, bz] = path[i]
      const len = Math.hypot(bx - ax, bz - az)
      while (dist + len >= nextKm && len > 0) {
        const f = (nextKm - dist) / len
        const x = ax + (bx - ax) * f
        const z = az + (bz - az) * f
        marks.push(x, hs(x, z), z, 3)
        nextKm += 1000
      }
      dist += len
    }
    const markGeo = spriteGeometry(marks.length / 4, { iPos: { array: new Float32Array(marks), size: 4 } })
    return { line, markGeo }
  }, [path, hs, maxSeg])
  useEffect(() => () => {
    built?.line?.dispose()
    built?.markGeo.dispose()
  }, [built])

  const mats = useMemo(() => {
    const gold = new THREE.Color(HEX.latticeCore)
    return {
      line: makeLineMaterial(2.4, 0, gold.clone().multiplyScalar(1.35)),
      preview: makeLineMaterial(1.6, 60, new THREE.Color(HEX.goldWhite)),
      mark: new THREE.ShaderMaterial({
        vertexShader: markVert,
        fragmentShader: markFrag,
        uniforms: { ...fxUniforms, uOpacity: { value: 1 }, uColor: { value: gold } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    }
  }, [])
  useEffect(() => () => {
    mats.line.dispose()
    mats.preview.dispose()
    mats.mark.dispose()
  }, [mats])

  // ---- click-to-draw
  const [preview, setPreview] = useState<THREE.BufferGeometry | null>(null)
  const previewRef = useRef<THREE.BufferGeometry | null>(null)
  useEffect(() => {
    if (!drawing) return
    const el = gl.domElement
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const hit = new THREE.Vector3()
    const before = useStore.getState().profilePath
    let started = false
    let down: { x: number; y: number; t: number } | null = null
    let raf = 0
    let lastMove: PointerEvent | null = null
    const prevCursor = el.style.cursor
    el.style.cursor = 'crosshair'

    const pick = (e: { clientX: number; clientY: number }): [number, number] | null => {
      const r = el.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      const p = raycastHeightfield(ray.ray.origin, ray.ray.direction, assets, useStore.getState().exaggeration, hit)
      return p ? [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10] : null
    }
    const setPreviewGeo = (g: THREE.BufferGeometry | null) => {
      previewRef.current?.dispose()
      previewRef.current = g
      setPreview(g)
    }
    const updatePreview = () => {
      raf = 0
      const e = lastMove
      const cur = useStore.getState().profilePath
      if (!e || !started || cur.length === 0) return setPreviewGeo(null)
      const p = pick(e)
      if (!p) return setPreviewGeo(null)
      const [ax, az] = cur[cur.length - 1]
      setPreviewGeo(ribbonGeometry([{ pts: drape([ax, az, p[0], p[1]], hs, maxSeg, false), constData: [0, 0, 0, 0] }]))
    }
    const finish = (dropDuplicate: boolean) => {
      let cur = useStore.getState().profilePath
      if (dropDuplicate && cur.length >= 2) {
        const [ax, az] = cur[cur.length - 2]
        const [bx, bz] = cur[cur.length - 1]
        if (Math.hypot(bx - ax, bz - az) < Math.max(25, assets.extent / 400)) cur = cur.slice(0, -1)
      }
      useStore.getState().setProfilePath(started && cur.length >= 2 ? cur : before)
      useStore.getState().setDrawingPath(false)
    }
    const onDown = (e: PointerEvent) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY, t: performance.now() }
    }
    const onUp = (e: PointerEvent) => {
      if (!down || e.button !== 0) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      const quick = performance.now() - down.t < 600
      down = null
      if (moved > 5 || !quick) return
      const p = pick(e)
      if (!p) return
      const cur = started ? useStore.getState().profilePath : []
      started = true
      useStore.getState().setProfilePath([...cur, p])
    }
    const onMove = (e: PointerEvent) => {
      lastMove = e
      if (!raf) raf = requestAnimationFrame(updatePreview)
    }
    const onDbl = (e: MouseEvent) => {
      e.preventDefault()
      finish(true)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(false)
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('dblclick', onDbl)
    window.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('dblclick', onDbl)
      window.removeEventListener('keydown', onKey)
      if (raf) cancelAnimationFrame(raf)
      el.style.cursor = prevCursor
      setPreviewGeo(null)
    }
  }, [drawing, gl, camera, assets, hs, maxSeg])

  useFrame(() => {
    const o = visible || drawing ? Math.max(opacity, drawing ? 1 : 0) : 0
    mats.line.uniforms.uOpacity.value = o
    mats.mark.uniforms.uOpacity.value = o
    mats.preview.uniforms.uOpacity.value = 0.9
  })

  if ((!visible && !drawing) || !built) return preview && drawing ? <mesh geometry={preview} material={mats.preview} frustumCulled={false} renderOrder={ORDER.profile} /> : null
  return (
    <>
      {built.line && <mesh geometry={built.line} material={mats.line} frustumCulled={false} renderOrder={ORDER.profile} />}
      <mesh geometry={built.markGeo} material={mats.mark} frustumCulled={false} renderOrder={ORDER.profile} />
      {preview && drawing && <mesh geometry={preview} material={mats.preview} frustumCulled={false} renderOrder={ORDER.profile} />}
    </>
  )
}
