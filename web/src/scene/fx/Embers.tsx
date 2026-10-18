// Embers (SPEC 9.3): GPU points spawned along the active front's leading edge, lofting and drifting downwind with
// the interpolated wind, cooling from incandescent white-yellow to deep red, flickering; additive (they bloom).
// The CPU only respawns expired particles (birth position + time); motion is analytic in the vertex shader.
// Follows the observedFire layer (forecast layer when the fronts come from the live forecast).
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useStore, type Quality } from '../../state/store'
import type { IncidentAssets } from '../assets'
import { GLSL_COMMON, GLSL_OUTPUT, GLSL_VERT, GLSL_WIND, HEX, ORDER, fxUniforms, makeHeightSampler, makeRng, useLayer } from './common'
import { fxShared, fxStore } from './state'

const EMBER_N: Record<Quality, number> = { high: 3000, medium: 1800, low: 800 }

const vertexShader = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
${GLSL_WIND}
attribute vec4 aSpawn; // x, world y, z, birth clock
attribute vec4 aP;     // life, seed, size (css px), loft (m)
uniform float uOpacity;
uniform vec3 uHot;
uniform vec3 uMid;
uniform vec3 uFire;
uniform vec3 uEmber;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float age = uClock - aSpawn.w;
  float t = age / aP.x;
  if (t < 0.0 || t > 1.0 || uOpacity <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; return; }
  vec2 w = fxWindWorld(aSpawn.xz);
  float sp = length(w);
  vec2 drift = w * (14.0 / (1.0 + sp / 18.0)) * age;
  float seed = aP.y;
  vec2 swirl = vec2(sin(age * 2.1 + seed * 20.0), cos(age * 1.7 + seed * 31.0)) * (10.0 + 18.0 * seed) * t;
  float rise = aP.w * (1.0 - exp(-age * 1.25)) - 9.0 * t * t * aP.x;
  vec3 world = vec3(aSpawn.x + drift.x + swirl.x, aSpawn.y + rise, aSpawn.z + drift.y + swirl.y);
  vec4 mv = viewMatrix * vec4(world, 1.0);
  float depth = max(-mv.z, 1.0);
  float heat = 1.0 - t;
  float flick = 0.55 + 0.45 * sin(uClock * (13.0 + seed * 21.0) + seed * 50.0);
  vec3 c = mix(uEmber, uFire, smoothstep(0.0, 0.45, heat));
  c = mix(c, uMid, smoothstep(0.45, 0.8, heat));
  c = mix(c, uHot, smoothstep(0.8, 1.0, heat));
  vColor = c * (1.4 + 4.2 * heat * heat) * flick;
  vAlpha = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.65, 1.0, t)) * fxKeep(world) * uOpacity;
  gl_PointSize = max(aP.z * (0.6 + 0.6 * heat) * clamp(7000.0 / depth, 0.55, 2.2) * uPixelRatio, 1.0);
  gl_Position = projectionMatrix * mv;
}
`

const fragmentShader = /* glsl */ `
${GLSL_COMMON}
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vColor, vAlpha * exp(-r2 * 3.0));
  ${GLSL_OUTPUT}
}
`

export function Embers({ assets }: { assets: IncidentAssets }) {
  const fire = useLayer('observedFire')
  const fcLayer = useLayer('forecast')
  const quality = useStore((s) => s.quality)
  const N = EMBER_N[quality]
  const heightAt = useMemo(() => makeHeightSampler(assets.elevation, assets.extent), [assets.elevation, assets.extent])
  const state = useMemo(() => {
    const spawn = new Float32Array(N * 4)
    const p = new Float32Array(N * 4)
    for (let i = 0; i < N; i++) {
      spawn[i * 4 + 3] = -1e6 // expired
      p[i * 4] = 1
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3))
    g.setAttribute('aSpawn', new THREE.BufferAttribute(spawn, 4).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aP', new THREE.BufferAttribute(p, 4).setUsage(THREE.DynamicDrawUsage))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7)
    return { g, spawn, p, rng: makeRng(0xe1b3), acc: 0 }
  }, [N])
  useEffect(() => () => state.g.dispose(), [state])
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          ...fxUniforms,
          uOpacity: { value: 1 },
          uHot: { value: new THREE.Color(HEX.fireHot) },
          uMid: { value: new THREE.Color(HEX.fireMid) },
          uFire: { value: new THREE.Color(HEX.fire) },
          uEmber: { value: new THREE.Color(HEX.ember) },
        },
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
      }),
    [],
  )
  useEffect(() => () => material.dispose(), [material])

  useFrame(() => {
    const s = useStore.getState()
    const fr = fxStore.getState().fronts
    const layer = fr?.source === 'forecast' ? fcLayer : fire
    const styleMul = s.visualStyle === 'parametric' ? 0.55 : 1
    material.uniforms.uOpacity.value = layer.visible ? layer.opacity * styleMul : 0
    if (!layer.visible || !fr || fr.sampleCount === 0) return
    const rate = Math.min(N / 2.5, fr.totalLengthM * 0.22) * (fr.source === 'forecast' ? 0.5 : 1)
    state.acc = Math.min(state.acc + rate * fxShared.dt, N)
    if (state.acc < 1) return
    const clock = fxShared.clock
    const { spawn, p, rng } = state
    const exag = s.exaggeration
    let changed = false
    for (let i = 0; i < N && state.acc >= 1; i++) {
      if (clock - spawn[i * 4 + 3] < p[i * 4]) continue
      let k = 0
      for (let t = 0; t < 5; t++) {
        k = Math.floor(rng() * fr.sampleCount)
        if (rng() < 0.25 + 0.75 * fr.samples[k * 4 + 3]) break
      }
      const x = fr.samples[k * 4] + (rng() - 0.5) * 50
      const z = fr.samples[k * 4 + 1] + (rng() - 0.5) * 50
      spawn[i * 4] = x
      spawn[i * 4 + 1] = heightAt(x, z) * exag + 4
      spawn[i * 4 + 2] = z
      spawn[i * 4 + 3] = clock - rng() * 0.05
      p[i * 4] = 1.8 + 3.2 * rng()
      p[i * 4 + 1] = rng()
      p[i * 4 + 2] = 1.2 + 1.9 * rng()
      p[i * 4 + 3] = 40 + 190 * rng() * rng()
      state.acc -= 1
      changed = true
    }
    if (changed) {
      ;(state.g.attributes.aSpawn as THREE.BufferAttribute).needsUpdate = true
      ;(state.g.attributes.aP as THREE.BufferAttribute).needsUpdate = true
    }
  })

  return <points geometry={state.g} material={material} frustumCulled={false} renderOrder={ORDER.embers} />
}
