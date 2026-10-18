// Fire perimeters (SPEC 9.3): thin luminous lines draped on the terrain for every perimeter with t <= timeline time;
// older ones dimmer, the latest one <= t highlighted (wider, gold-white). One ribbon draw call for all perimeters;
// visibility and highlight run in the shader from the per-vertex perimeter time.
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useStore } from '../../state/store'
import type { IncidentAssets } from '../assets'
import { GLSL_COMMON, GLSL_OUTPUT, GLSL_VERT, HEX, HOUR_MS, ORDER, fxUniforms, makeHeightSampler, useLayer } from './common'
import { GLSL_RIBBON_FRAG, GLSL_RIBBON_VERT, drape, ribbonGeometry, type RibbonLine } from './lines'
import { fxShared } from './state'

const vertexShader = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
${GLSL_RIBBON_VERT}
uniform float uLatest;   // time (h) of the latest perimeter <= now, or -1e9
uniform float uOpacity;
uniform vec3 uNew;
uniform vec3 uOld;
varying vec3 vColor;
varying float vAlpha;
varying float vHi;
void main() {
  float t = aData.x;
  float hi = abs(t - uLatest) < 0.01 ? 1.0 : 0.0;
  vHi = hi;
  float realistic = step(0.5, uStyle) * step(uStyle, 1.5);
  float w = hi > 0.5 ? mix(1.6, 1.4, realistic) : 1.0;
  gl_Position = fxRibbon(w, 4.0, 0.0018);
  float age = max(uLatest - t, 0.0);
  float show = step(t, uTimeH + 1.0e-4);
  float a = hi > 0.5 ? 0.8 : 0.07 + 0.2 * exp(-age / 30.0);
  vColor = (hi > 0.5 ? uNew * 1.1 : mix(uOld, uNew, 0.4 * exp(-age / 30.0)) * 0.8) * uLineGain;
  vec3 world = vec3(position.x, position.y * uExag, position.z);
  vAlpha = show * a * fxKeep(world) * uOpacity;
  if (vAlpha < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`

const fragmentShader = /* glsl */ `
${GLSL_COMMON}
${GLSL_RIBBON_FRAG}
varying vec3 vColor;
varying float vAlpha;
varying float vHi;
void main() {
  float a = fxRibbonAlpha();
  float glow = fxRibbonGlow();
  gl_FragColor = vec4(vColor * (0.75 + 0.5 * glow * vHi), vAlpha * a);
  ${GLSL_OUTPUT}
}
`

export function Perimeters({ assets }: { assets: IncidentAssets }) {
  const { visible, opacity } = useLayer('perimeters')
  const perimeters = useStore((s) => s.perimeters)
  const built = useMemo(() => {
    const list = (perimeters?.perimeters ?? []).filter((p) => Number.isFinite(p.t_ms) && p.rings.length > 0).sort((a, b) => a.t_ms - b.t_ms)
    const origin = assets.manifest.time_origin_ms
    const hs = makeHeightSampler(assets.elevation, assets.extent)
    const maxSeg = Math.max(24, (assets.extent / assets.elevation.width) * 2)
    const lines: RibbonLine[] = []
    const times = new Float64Array(list.length)
    list.forEach((p, k) => {
      const tH = (p.t_ms - origin) / HOUR_MS
      times[k] = tH
      for (const ring of p.rings) {
        if (ring.length < 3) continue
        const flat = new Float64Array(ring.length * 2)
        ring.forEach(([x, z], i) => {
          flat[i * 2] = x
          flat[i * 2 + 1] = z
        })
        const n = ring.length
        const closedDup = ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]
        const pts = drape(closedDup ? flat.subarray(0, (n - 1) * 2) : flat, hs, maxSeg, true)
        lines.push({ pts, closed: true, constData: [tH, k, p.acres, 0] })
      }
    })
    return { geometry: lines.length ? ribbonGeometry(lines) : null, times }
  }, [perimeters, assets.elevation, assets.extent, assets.manifest.time_origin_ms])
  useEffect(() => () => built.geometry?.dispose(), [built])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          ...fxUniforms,
          uLatest: { value: -1e9 },
          uOpacity: { value: 0.6 },
          uNew: { value: new THREE.Color('#F0D296') },
          uOld: { value: new THREE.Color(HEX.latticeFalloff) },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    [],
  )
  useEffect(() => () => material.dispose(), [material])

  useFrame(() => {
    if (!visible) return
    const t = fxShared.tH
    let latest = -1e9
    const ts = built.times
    for (let k = 0; k < ts.length && ts[k] <= t + 1e-4; k++) latest = ts[k]
    material.uniforms.uLatest.value = latest
    material.uniforms.uOpacity.value = Math.min(1, opacity * 1.3)
  })

  if (!visible || !built.geometry) return null
  return <mesh geometry={built.geometry} material={material} frustumCulled={false} renderOrder={ORDER.perimeters} />
}
