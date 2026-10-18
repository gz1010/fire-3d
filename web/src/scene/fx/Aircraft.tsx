// Live firefighting aircraft (SPEC 9.3): store.aircraft (polled every ~10 s) -> small glowing heading-oriented icons
// (fixed-wing / rotor glyphs) in category accents, a faint drop line to the ground, monospace callsign labels and
// 5-minute trails. Motion is smoothed: dead reckoning from ground speed + track between polls, eased toward each
// new report. Altitude is drawn at alt x exaggeration (consistent with the terrain). Dimmed when the timeline is
// away from "now". Wall-clock based (live data), independent of sim time.
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import type { Aircraft as AircraftT } from '../../api/types'
import { fmtNumber } from '../../lib/format'
import { useStore } from '../../state/store'
import type { IncidentAssets } from '../assets'
import { AIRCRAFT_HEX, GLSL_COMMON, GLSL_OUTPUT, GLSL_VERT, ORDER, fxUniforms, makeHeightSampler, useLayer } from './common'
import { GLSL_RIBBON_FRAG, GLSL_RIBBON_VERT, ribbonGeometry, spriteGeometry, type RibbonLine } from './lines'
import { fxShared } from './state'
import { getAircraftGlyphs } from './textures'
import { InOverlay, ScreenLabel } from './text'

const MAX_AC = 32
const TRAIL_S = 300
const TRAIL_STEP_S = 1
const KT = 0.514444

const iconVert = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
attribute vec4 iPos;  // x, altitude (m), z, heading (deg cw from north)
attribute vec4 iInfo; // r, g, b, kind (0 fixed wing, 1 rotor)
attribute vec4 iMisc; // alpha, size scale, ground elevation (m), unused
varying vec2 vQuad;
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
void main() {
  vec3 world = vec3(iPos.x, iPos.y * uExag, iPos.z);
  float h = radians(iPos.w);
  vec3 ahead = world + vec3(sin(h), 0.0, -cos(h)) * 60.0;
  vec4 c = projectionMatrix * viewMatrix * vec4(world, 1.0);
  vec4 ca = projectionMatrix * viewMatrix * vec4(ahead, 1.0);
  vQuad = position.xy;
  vColor = iInfo.rgb;
  vKind = iInfo.a;
  vAlpha = iMisc.x * fxEdge(fxUv(world.xz));
  if (c.w < 1.0 || iMisc.x <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 d = (ca.xy / max(ca.w, 1.0e-3) - c.xy / c.w) * uViewport;
  float ang = length(d) > 1.0e-3 ? atan(d.y, d.x) - 1.5707963 : 0.0;
  if (iInfo.a > 0.5) ang = 0.0;
  mat2 rot = mat2(cos(ang), sin(ang), -sin(ang), cos(ang));
  vec2 q = rot * position.xy;
  float halfPx = 13.0 * iMisc.y * uPixelRatio;
  c.xy += q * (halfPx * 2.0 / uViewport) * c.w;
  gl_Position = c;
}
`

const iconFrag = /* glsl */ `
${GLSL_COMMON}
uniform sampler2D uGlyphs;
varying vec2 vQuad;
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
void main() {
  vec2 uv = vec2((vKind + vQuad.x * 0.5 + 0.5) * 0.5, vQuad.y * 0.5 + 0.5);
  float g = texture2D(uGlyphs, uv).a;
  float r2 = dot(vQuad, vQuad);
  float halo = exp(-r2 * 3.2) * 0.32;
  vec3 col = vColor * (g * 2.2 + halo * 1.4) + vec3(1.0) * g * 0.35;
  float a = clamp(g + halo, 0.0, 1.0) * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
  ${GLSL_OUTPUT}
}
`

// Drop line: a 1 px vertical segment from the aircraft down to the ground, fading downward.
const dropVert = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
attribute vec4 iPos;
attribute vec4 iInfo;
attribute vec4 iMisc;
varying float vT;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float t = position.y * 0.5 + 0.5; // 0 ground .. 1 aircraft
  vec3 top = vec3(iPos.x, iPos.y * uExag, iPos.z);
  vec3 bot = vec3(iPos.x, iMisc.z * uExag, iPos.z);
  vec4 c = projectionMatrix * viewMatrix * vec4(mix(bot, top, t), 1.0);
  vT = t;
  vColor = iInfo.rgb;
  vAlpha = iMisc.x * 0.4 * fxEdge(fxUv(top.xz));
  if (c.w < 1.0 || iMisc.x <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  c.x += position.x * (0.6 * uPixelRatio * 2.0 / uViewport.x) * c.w;
  gl_Position = c;
}
`

const dropFrag = /* glsl */ `
${GLSL_COMMON}
varying float vT;
varying float vAlpha;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, vAlpha * vT * vT);
  ${GLSL_OUTPUT}
}
`

const trailVert = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
${GLSL_RIBBON_VERT}
uniform float uNowS;
uniform float uDim;
varying float vAlpha;
varying vec3 vColor;
void main() {
  gl_Position = fxRibbon(1.4, 0.0, 0.0);
  float age = uNowS - aData.x;
  vColor = aData.yzw;
  vec3 world = vec3(position.x, position.y * uExag, position.z);
  vAlpha = clamp(1.0 - age / ${TRAIL_S.toFixed(1)}, 0.0, 1.0) * 0.55 * uDim * fxEdge(fxUv(world.xz));
}
`

const trailFrag = /* glsl */ `
${GLSL_COMMON}
${GLSL_RIBBON_FRAG}
varying float vAlpha;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, vAlpha * vAlpha * fxRibbonAlpha());
  ${GLSL_OUTPUT}
}
`

interface Track {
  ac: AircraftT
  polledAt: number
  x: number
  y: number
  z: number
  vx: number
  vz: number
  dx: number
  dy: number
  dz: number
  heading: number
  ground: number
  trail: number[] // x, y, z, tSec per point
  lastTrail: number
  lastSeen: number
  color: THREE.Color
}

function altitudeOf(ac: AircraftT, ground: number, elevMin: number): number {
  if (ac.alt_m != null && Number.isFinite(ac.alt_m)) return ac.alt_m
  if (ac.agl_m != null && Number.isFinite(ac.agl_m)) return ground + ac.agl_m
  return Math.max(ground, elevMin) + 300
}

function labelFor(ac: AircraftT): string {
  const id = (ac.callsign?.trim() || ac.registration?.trim() || ac.hex).toUpperCase()
  const head = [id, ac.type].filter(Boolean).join(' · ')
  const parts: string[] = []
  if (ac.agl_m != null && Number.isFinite(ac.agl_m)) parts.push(`${fmtNumber(ac.agl_m)} m AGL`)
  else if (ac.alt_m != null && Number.isFinite(ac.alt_m)) parts.push(`${fmtNumber(ac.alt_m)} m`)
  if (ac.gs_kt != null && Number.isFinite(ac.gs_kt)) parts.push(`${fmtNumber(ac.gs_kt)} kt`)
  return parts.length ? `${head}\n${parts.join(' · ')}` : head
}

export function Aircraft({ assets }: { assets: IncidentAssets }) {
  const { visible, opacity } = useLayer('aircraft')
  const aircraft = useStore((s) => s.aircraft)
  const live = assets.manifest.mode === 'live'
  const hs = useMemo(() => makeHeightSampler(assets.elevation, assets.extent), [assets.elevation, assets.extent])
  const tracks = useRef(new Map<string, Track>())
  const trackList = useRef<Track[]>([])
  const [labels, setLabels] = useState<{ hex: string; text: string; color: string }[]>([])

  const buffers = useMemo(() => {
    const iPos = new Float32Array(MAX_AC * 4)
    const iInfo = new Float32Array(MAX_AC * 4)
    const iMisc = new Float32Array(MAX_AC * 4)
    const attrs = { iPos: { array: iPos, size: 4 }, iInfo: { array: iInfo, size: 4 }, iMisc: { array: iMisc, size: 4 } }
    const icons = spriteGeometry(0, attrs)
    const drops = spriteGeometry(0, attrs)
    const dyn: THREE.InstancedBufferAttribute[] = []
    for (const g of [icons, drops])
      for (const k of ['iPos', 'iInfo', 'iMisc']) {
        const a = g.attributes[k] as THREE.InstancedBufferAttribute
        a.setUsage(THREE.DynamicDrawUsage)
        dyn.push(a)
      }
    return { iPos, iInfo, iMisc, icons, drops, dyn }
  }, [])
  useEffect(() => () => {
    buffers.icons.dispose()
    buffers.drops.dispose()
  }, [buffers])
  const [trailGeo, setTrailGeo] = useState<THREE.BufferGeometry | null>(null)
  useEffect(() => () => trailGeo?.dispose(), [trailGeo])

  const mats = useMemo(
    () => ({
      icon: new THREE.ShaderMaterial({
        vertexShader: iconVert,
        fragmentShader: iconFrag,
        uniforms: { ...fxUniforms, uGlyphs: { value: getAircraftGlyphs() } },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
      drop: new THREE.ShaderMaterial({ vertexShader: dropVert, fragmentShader: dropFrag, uniforms: { ...fxUniforms }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      trail: new THREE.ShaderMaterial({
        vertexShader: trailVert,
        fragmentShader: trailFrag,
        uniforms: { ...fxUniforms, uNowS: { value: 0 }, uDim: { value: 1 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    }),
    [],
  )
  useEffect(() => () => {
    mats.icon.dispose()
    mats.drop.dispose()
    mats.trail.dispose()
  }, [mats])

  // New poll -> update targets (positions are reports at the poll time).
  useEffect(() => {
    const now = performance.now()
    const map = tracks.current
    const elevMin = assets.elevation.min
    for (const ac of aircraft.slice(0, MAX_AC)) {
      if (!Number.isFinite(ac.x) || !Number.isFinite(ac.z)) continue
      const ground = hs(ac.x, ac.z)
      const alt = altitudeOf(ac, ground, elevMin)
      const gs = (ac.gs_kt ?? 0) * KT
      const hdg = ((ac.track_deg ?? 0) * Math.PI) / 180
      let t = map.get(ac.hex)
      if (!t) {
        t = { ac, polledAt: now, x: ac.x, y: alt, z: ac.z, vx: 0, vz: 0, dx: ac.x, dy: alt, dz: ac.z, heading: ac.track_deg ?? 0, ground, trail: [], lastTrail: 0, lastSeen: now, color: new THREE.Color(AIRCRAFT_HEX[ac.category] ?? AIRCRAFT_HEX.unknown) }
        map.set(ac.hex, t)
      }
      t.ac = ac
      t.polledAt = now
      t.x = ac.x
      t.y = alt
      t.z = ac.z
      t.vx = ac.on_ground ? 0 : Math.sin(hdg) * gs
      t.vz = ac.on_ground ? 0 : -Math.cos(hdg) * gs
      t.ground = ground
      t.lastSeen = now
      t.color.set(AIRCRAFT_HEX[ac.category] ?? AIRCRAFT_HEX.unknown)
    }
    for (const [hex, t] of map) if (now - t.lastSeen > 90_000) map.delete(hex)
    trackList.current = [...map.values()].slice(0, MAX_AC)
    const fireX = fxShared.fireX
    const fireZ = fxShared.fireZ
    const list = [...map.values()]
      .filter((t) => now - t.lastSeen < 30_000)
      .sort((a, b) => Number(b.ac.is_fire_aircraft) - Number(a.ac.is_fire_aircraft) || Math.hypot(a.x - fireX, a.z - fireZ) - Math.hypot(b.x - fireX, b.z - fireZ))
      .slice(0, 10)
    setLabels(list.map((t) => ({ hex: t.ac.hex, text: labelFor(t.ac), color: AIRCRAFT_HEX[t.ac.category] ?? AIRCRAFT_HEX.unknown })))
  }, [aircraft, hs, assets.elevation.min])

  const trailClock = useRef(0)
  useFrame(() => {
    const now = performance.now()
    const nowS = now / 1000
    const s = useStore.getState()
    const m = assets.manifest
    const dim = Math.abs(s.timeMs - m.time_range.now_ms) > 30 * 60_000 ? 0.35 : 1
    const k = 1 - Math.exp(-Math.min(0.1, fxShared.dt || 0.016) / 0.6)
    let n = 0
    const list = trackList.current
    for (let li = 0; li < list.length; li++) {
      const t = list[li]
      const age = Math.min(20, (now - t.polledAt) / 1000)
      const tx = t.x + t.vx * age
      const tz = t.z + t.vz * age
      t.dx += (tx - t.dx) * k
      t.dz += (tz - t.dz) * k
      t.dy += (t.y - t.dy) * k
      const target = t.ac.track_deg ?? t.heading
      const dh = ((target - t.heading + 540) % 360) - 180
      t.heading = (t.heading + dh * k + 360) % 360
      if (nowS - t.lastTrail >= TRAIL_STEP_S) {
        t.trail.push(t.dx, t.dy, t.dz, nowS)
        t.lastTrail = nowS
        while (t.trail.length > 4 && nowS - t.trail[3] > TRAIL_S) t.trail.splice(0, 4)
      }
      const stale = Math.min(1, Math.max(0, 1 - (now - t.lastSeen - 30_000) / 30_000))
      const o = n * 4
      buffers.iPos[o] = t.dx
      buffers.iPos[o + 1] = t.dy
      buffers.iPos[o + 2] = t.dz
      buffers.iPos[o + 3] = t.heading
      buffers.iInfo[o] = t.color.r
      buffers.iInfo[o + 1] = t.color.g
      buffers.iInfo[o + 2] = t.color.b
      buffers.iInfo[o + 3] = t.ac.category === 'helicopter' ? 1 : 0
      buffers.iMisc[o] = (visible && live ? opacity : 0) * dim * stale * (t.ac.on_ground ? 0.5 : 1)
      buffers.iMisc[o + 1] = t.ac.is_fire_aircraft ? 1 : 0.8
      buffers.iMisc[o + 2] = hs(t.dx, t.dz)
      n++
    }
    buffers.icons.instanceCount = n
    buffers.drops.instanceCount = n
    for (let i = 0; i < buffers.dyn.length; i++) buffers.dyn[i].needsUpdate = true
    mats.trail.uniforms.uNowS.value = nowS
    mats.trail.uniforms.uDim.value = dim * opacity
    if (nowS - trailClock.current >= TRAIL_STEP_S && visible && live) {
      trailClock.current = nowS
      const lines: RibbonLine[] = []
      for (const t of list) {
        const pts = t.trail
        const np = pts.length / 4
        if (np < 2) continue
        const xyz = new Float32Array(np * 3 + 3)
        const data = new Float32Array(np * 4 + 4)
        for (let i = 0; i < np; i++) {
          xyz[i * 3] = pts[i * 4]
          xyz[i * 3 + 1] = pts[i * 4 + 1]
          xyz[i * 3 + 2] = pts[i * 4 + 2]
          data.set([pts[i * 4 + 3], t.color.r, t.color.g, t.color.b], i * 4)
        }
        xyz.set([t.dx, t.dy, t.dz], np * 3)
        data.set([nowS, t.color.r, t.color.g, t.color.b], np * 4)
        lines.push({ pts: xyz, data })
      }
      setTrailGeo(lines.length ? ribbonGeometry(lines) : null)
    }
  })

  // aircraft labels yield to telemetry columns (fade where they overlap one)
  const declutter = useMemo(() => new Map(labels.map((l) => [l.hex, { fade: { current: 1 }, screen: { x: 0, y: 0, visible: false }, w: Math.max(...l.text.split('\n').map((t) => t.length)) * 10.5 * 0.62, h: l.text.split('\n').length * 10.5 * 1.32 }])), [labels])
  const declutterList = useMemo(() => [...declutter.values()], [declutter])
  useFrame(() => {
    const r = fxShared.labelRects
    const n = fxShared.labelRectCount
    const k = Math.min(1, (fxShared.dt || 0.016) * 6)
    for (let i = 0; i < declutterList.length; i++) {
      const d = declutterList[i]
      const x0 = d.screen.x + 13
      const x1 = x0 + d.w
      const y0 = d.screen.y - d.h / 2
      const y1 = d.screen.y + d.h / 2
      let hit = false
      for (let q = 0; q < n; q++) if (x0 < r[q * 4 + 2] && x1 > r[q * 4] && y0 < r[q * 4 + 3] && y1 > r[q * 4 + 1]) hit = true
      d.fade.current += ((hit ? 0.12 : 1) - d.fade.current) * k
    }
  })

  const anchors = useMemo(() => {
    const out = new Map<string, (v: THREE.Vector3) => boolean>()
    for (const l of labels) {
      out.set(l.hex, (v: THREE.Vector3) => {
        const t = tracks.current.get(l.hex)
        if (!t || !live) return false
        v.set(t.dx, t.dy * useStore.getState().exaggeration, t.dz)
        return true
      })
    }
    return out
  }, [labels, live])

  if (!visible || !live) return null
  return (
    <>
      {trailGeo && <mesh geometry={trailGeo} material={mats.trail} frustumCulled={false} renderOrder={ORDER.aircraftTrail} />}
      <mesh geometry={buffers.drops} material={mats.drop} frustumCulled={false} renderOrder={ORDER.aircraftTrail} />
      <mesh geometry={buffers.icons} material={mats.icon} frustumCulled={false} renderOrder={ORDER.aircraft} />
      <InOverlay>
      {labels.map((l) => (
        <ScreenLabel
          key={l.hex}
          anchor={anchors.get(l.hex)!}
          text={l.text}
          offset={[17, 3]}
          anchorY="middle"
          fontPx={10.5}
          color="#E9E2CF"
          colorRanges={{ 0: l.color, [l.text.indexOf('\n') >= 0 ? l.text.indexOf('\n') : l.text.length]: '#C9C2AF' }}
          opacity={0.85 * opacity}
          fade={declutter.get(l.hex)?.fade}
          screen={declutter.get(l.hex)?.screen}
        />
      ))}
      </InOverlay>
    </>
  )
}
