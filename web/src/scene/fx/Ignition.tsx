// Ignition marker (SPEC 9.3): a bright point with an additive cinematic flare (core, halo, six fine rays and a
// horizontal streak; blooms), three draped rings that pulse outward, and a monospace label. Before the ignition time
// the marker is a dim estimate. The label is drawn here in realistic mode or when telemetry is off; otherwise the
// telemetry ignition column carries it.
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { fmtAt } from '../../lib/time'
import { useStore } from '../../state/store'
import { useTimeFormat } from '../../state/timeZone'
import type { IncidentAssets } from '../assets'
import { GLSL_COMMON, GLSL_OUTPUT, GLSL_VERT, HEX, HOUR_MS, ORDER, fxUniforms, makeHeightSampler, prefersReducedMotion, useLayer } from './common'
import { GLSL_RIBBON_FRAG, GLSL_RIBBON_VERT, GLSL_SPRITE_VERT, drape, ribbonGeometry, spriteGeometry } from './lines'
import { fxShared } from './state'
import { InOverlay, ScreenLabel } from './text'

const flareVert = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
${GLSL_SPRITE_VERT}
attribute vec4 iPos; // x, elevation (m), z, unused
uniform float uHalfPx;
varying vec3 vWorld;
void main() {
  vec3 world = vec3(iPos.x, iPos.y * uExag + 6.0, iPos.z);
  vWorld = world;
  gl_Position = fxSprite(world, uHalfPx * uPixelRatio, 0.01);
}
`

const flareFrag = /* glsl */ `
${GLSL_COMMON}
varying vec2 vQuad;
varying vec3 vWorld;
uniform float uIntensity;
uniform float uOpacity;
uniform vec3 uHot;
uniform vec3 uFire;
void main() {
  vec2 q = vQuad;
  float r = length(q);
  if (r > 1.0) discard;
  float core = exp(-r * r * 160.0);
  float halo = exp(-r * r * 10.0) * 0.32 + exp(-r * r * 40.0) * 0.4;
  float ang = (r > 1.0e-4 ? atan(q.y, q.x) : 0.0) + 0.26; // atan(0, 0) is undefined (NaN on some GPUs)
  float rays = pow(abs(cos(ang * 3.0)), 90.0) * exp(-r * 4.0) * 0.55;
  float streak = exp(-abs(q.y) * 120.0) * exp(-abs(q.x) * 2.6) * 0.75;
  float pulse = 0.88 + 0.12 * sin(uClock * 2.1);
  vec3 col = uHot * core * 4.5 + mix(uFire, uHot, 0.35) * (halo + rays + streak) * 1.6;
  float a = pulse * uIntensity * uOpacity * fxKeep(vWorld) * smoothstep(1.0, 0.85, r);
  gl_FragColor = vec4(col, a);
  ${GLSL_OUTPUT}
}
`

const ringVert = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
${GLSL_RIBBON_VERT}
uniform float uIntensity;
uniform float uOpacity;
uniform float uMotion;
varying float vAlpha;
void main() {
  gl_Position = fxRibbon(1.25, 4.0, 0.002);
  float k = aData.x;                       // ring index 0..2
  float phase = fract(uClock * 0.28);
  float e = (phase * 3.2 - k) / 0.45; // squared by hand: pow() of a negative base is NaN on Metal
  float pulse = exp(-e * e);
  vec3 world = vec3(position.x, position.y * uExag, position.z);
  vAlpha = (0.22 + 0.6 * pulse * uMotion) * (1.0 - 0.22 * k) * uIntensity * uOpacity * uLineGain * fxKeep(world);
}
`

const ringFrag = /* glsl */ `
${GLSL_COMMON}
${GLSL_RIBBON_FRAG}
uniform vec3 uColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor, vAlpha * fxRibbonAlpha());
  ${GLSL_OUTPUT}
}
`

export function Ignition({ assets }: { assets: IncidentAssets }) {
  const { visible, opacity } = useLayer('ignition')
  const telemetry = useLayer('telemetry')
  const style = useStore((s) => s.visualStyle)
  const tf = useTimeFormat()
  const ign = assets.manifest.ignition
  const hs = useMemo(() => makeHeightSampler(assets.elevation, assets.extent), [assets.elevation, assets.extent])
  const elev = ign ? hs(ign.x, ign.z) : 0

  const flareGeo = useMemo(() => (ign ? spriteGeometry(1, { iPos: { array: new Float32Array([ign.x, elev, ign.z, 0]), size: 4 } }) : null), [ign, elev])
  const ringGeo = useMemo(() => {
    if (!ign) return null
    const lines = [90, 210, 360].map((r, k) => {
      const n = 72
      const xz = new Float64Array(n * 2)
      for (let i = 0; i < n; i++) {
        xz[i * 2] = ign.x + Math.cos((i / n) * Math.PI * 2) * r
        xz[i * 2 + 1] = ign.z + Math.sin((i / n) * Math.PI * 2) * r
      }
      return { pts: drape(xz, hs, 30, true), closed: true, constData: [k, 0, 0, 0] as const }
    })
    return ribbonGeometry(lines)
  }, [ign, hs])
  useEffect(() => () => {
    flareGeo?.dispose()
    ringGeo?.dispose()
  }, [flareGeo, ringGeo])

  const mats = useMemo(
    () => ({
      flare: new THREE.ShaderMaterial({
        vertexShader: flareVert,
        fragmentShader: flareFrag,
        uniforms: {
          ...fxUniforms,
          uHalfPx: { value: 70 },
          uIntensity: { value: 1 },
          uOpacity: { value: 1 },
          uHot: { value: new THREE.Color(HEX.fireHot) },
          uFire: { value: new THREE.Color(HEX.fireMid) },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      ring: new THREE.ShaderMaterial({
        vertexShader: ringVert,
        fragmentShader: ringFrag,
        uniforms: { ...fxUniforms, uIntensity: { value: 1 }, uOpacity: { value: 1 }, uMotion: { value: 1 }, uColor: { value: new THREE.Color(HEX.fireMid) } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    }),
    [],
  )
  useEffect(() => () => {
    mats.flare.dispose()
    mats.ring.dispose()
  }, [mats])

  useFrame(() => {
    if (!visible || !ign) return
    const tIgn = (ign.t_ms - assets.manifest.time_origin_ms) / HOUR_MS
    const since = fxShared.tH - tIgn
    const intensity = since < 0 ? 0.3 : 1
    const real = useStore.getState().visualStyle === 'realistic'
    mats.flare.uniforms.uIntensity.value = intensity
    mats.flare.uniforms.uOpacity.value = opacity
    mats.flare.uniforms.uHalfPx.value = real ? 60 : 72
    mats.ring.uniforms.uIntensity.value = intensity
    mats.ring.uniforms.uOpacity.value = opacity
    mats.ring.uniforms.uMotion.value = prefersReducedMotion() ? 0 : 1
  })

  const anchor = useMemo(
    () => (out: THREE.Vector3) => {
      if (!ign) return false
      out.set(ign.x, elev * useStore.getState().exaggeration + 6, ign.z)
      return true
    },
    [ign, elev],
  )

  if (!visible || !ign || !flareGeo || !ringGeo) return null
  const showLabel = style === 'realistic' || !telemetry.visible
  return (
    <>
      <mesh geometry={ringGeo} material={mats.ring} frustumCulled={false} renderOrder={ORDER.ignition} />
      <mesh geometry={flareGeo} material={mats.flare} frustumCulled={false} renderOrder={ORDER.ignition} />
      {showLabel && (
        <InOverlay>
        <ScreenLabel
          anchor={anchor}
          text={`IGNITION\n${fmtAt(ign.t_ms, tf, { zone: true })}`}
          offset={[18, 12]}
          fontPx={11.5}
          color="#F2E3BF"
          colorRanges={{ 0: '#FFD58A', 8: '#E9DFC8' }}
          opacity={0.9 * opacity}
          leader
        />
        </InOverlay>
      )}
    </>
  )
}
