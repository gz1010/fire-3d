// Smoke plumes (SPEC 9.3): a CPU-simulated particle pool rendered as instanced soft billboards with a procedural
// noise atlas. Puffs are emitted from the active-front leading edge (density ~ active length) and from FRP-weighted
// recent satellite detections, rise with a buoyant plume (height ~ intensity) and drift with the interpolated 4x4
// wind (time-compressed so drift reads at kilometre scale), stronger aloft. Sun-lit from the scene env with a warm
// underglow near active fire; alpha-blended, sorted back to front, dim enough never to bloom. Fogged like the terrain.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useStore, type Quality } from '../../state/store'
import type { IncidentAssets } from '../assets'
import { GLSL_COMMON, GLSL_OUTPUT, ORDER, fxUniforms, makeHeightSampler, makeRng, useLayer } from './common'
import { spriteGeometry } from './lines'
import { fxShared, fxStore, type ActiveFronts } from './state'
import { getSmokeAtlas } from './textures'
import { sampleWind } from './wind'

const SMOKE_N: Record<Quality, number> = { high: 640, medium: 420, low: 240 }
const MEAN_LIFE = 21 // s of animation time
const WIND_K = 40 // visual time compression of the drift
const ANCHORS = 5

const vertexShader = /* glsl */ `
${GLSL_COMMON}
attribute vec4 iA; // x, y, z (world), size (m, half width)
attribute vec4 iB; // alpha, rotation, heat, atlas variant
uniform vec3 uSmoke;
varying vec2 vLc;
varying vec2 vCell;
varying vec2 vQ;
varying float vAlpha;
varying float vHeat;
varying vec3 vLit;   // sun-lit smoke colour (top of the puff), fogged
varying vec3 vShade; // shaded smoke colour (bottom of the puff), fogged
varying float vFog;
void main() {
  vec4 mv = viewMatrix * vec4(iA.xyz, 1.0);
  float fog = fxFog(iA.xyz);
  float sunUp = clamp(uSunDir.y, 0.05, 1.0);
  vec3 amb = uSmoke * uSkyAmbient * 1.5;
  vec3 sun = uSmoke * uSunColor * (0.3 + 0.7 * sunUp) * 0.55;
  vLit = mix(amb + sun * 1.05, uFogColor, fog);
  vShade = mix(amb + sun * 0.45, uFogColor, fog);
  vFog = fog;
  vec2 q = position.xy;
  mv.xy += q * iA.w;
  float c = cos(iB.y);
  float s = sin(iB.y);
  vec2 r = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  vLc = r * 0.5 + 0.5;
  vCell = vec2(mod(iB.w, 2.0), floor(iB.w * 0.5));
  vQ = q;
  vAlpha = iB.x * fxEdge(fxUv(iA.xz)) * (1.0 - 0.55 * fog);
  vHeat = iB.z * (1.0 - fog);
  gl_Position = projectionMatrix * mv;
}
`

const fragmentShader = /* glsl */ `
${GLSL_COMMON}
uniform sampler2D uTex;
uniform vec3 uGlow;
uniform float uOpacity;
varying vec2 vLc;
varying vec2 vCell;
varying vec2 vQ;
varying float vAlpha;
varying float vHeat;
varying vec3 vLit;
varying vec3 vShade;
varying float vFog;
void main() {
  if (vLc.x < 0.0 || vLc.y < 0.0 || vLc.x > 1.0 || vLc.y > 1.0) discard;
  float d = texture2D(uTex, (vCell + clamp(vLc, 0.004, 0.996)) * 0.5).r;
  float a = d * vAlpha * uOpacity;
  if (a < 0.003) discard;
  float up = vQ.y * 0.5 + 0.5;
  float low = (1.0 - up) * (1.0 - up);
  vec3 col = mix(vShade, vLit, up) * (0.78 + 0.44 * d) + uGlow * vHeat * low;
  gl_FragColor = vec4(col, a);
  ${GLSL_OUTPUT}
}
`

class SmokeSim {
  readonly n: number
  readonly x: Float32Array
  readonly y: Float32Array
  readonly z: Float32Array
  readonly gy: Float32Array // world y of the ground at spawn
  readonly age: Float32Array
  readonly life: Float32Array
  readonly s0: Float32Array
  readonly s1: Float32Array
  readonly rot: Float32Array
  readonly rotV: Float32Array
  readonly heat: Float32Array
  readonly dens: Float32Array
  readonly rise: Float32Array
  readonly tau: Float32Array
  readonly variant: Float32Array
  readonly alive: Uint8Array
  readonly free: Int32Array
  freeTop: number
  emitAcc = 0
  readonly rng: () => number
  readonly order: Int32Array
  readonly keys: Float32Array
  readonly byDepth: (a: number, b: number) => number
  readonly windTmp = { u: 0, v: 0 }
  // Persistent hot spots (plume columns): x, z, heat; one is re-picked every ~2 s, all when time jumps.
  readonly anchors = new Float32Array(ANCHORS * 3)
  anchorCount = 0
  anchorNext = 0
  anchorClock = 0
  anchorTH = Number.NaN

  constructor(n: number) {
    this.n = n
    const f = () => new Float32Array(n)
    this.x = f()
    this.y = f()
    this.z = f()
    this.gy = f()
    this.age = f()
    this.life = f()
    this.s0 = f()
    this.s1 = f()
    this.rot = f()
    this.rotV = f()
    this.heat = f()
    this.dens = f()
    this.rise = f()
    this.tau = f()
    this.variant = f()
    this.alive = new Uint8Array(n)
    this.free = new Int32Array(n)
    for (let i = 0; i < n; i++) this.free[i] = n - 1 - i
    this.freeTop = n
    this.rng = makeRng(0x5eed)
    this.order = new Int32Array(n)
    this.keys = new Float32Array(n)
    this.byDepth = (a: number, b: number) => this.keys[b] - this.keys[a]
  }

  /** Recency-weighted random leading-edge sample index. */
  private pickSample(fr: ActiveFronts): number {
    let k = 0
    for (let t = 0; t < 6; t++) {
      k = Math.floor(this.rng() * fr.sampleCount)
      if (this.rng() < 0.35 + 0.65 * fr.samples[k * 4 + 3]) break
    }
    return k
  }

  private updateAnchors(fr: ActiveFronts | null, dt: number): void {
    if (!fr || fr.sampleCount === 0) {
      this.anchorCount = 0
      return
    }
    // a timeline jump (not continuous playback) invalidates the hot spots
    if (!(Math.abs(fr.tH - this.anchorTH) < 1)) this.anchorCount = 0
    this.anchorTH = fr.tH
    this.anchorClock += dt
    if (this.anchorCount < ANCHORS || this.anchorClock > 2) {
      this.anchorClock = 0
      const slot = this.anchorCount < ANCHORS ? this.anchorCount++ : this.anchorNext++ % ANCHORS
      const k = this.pickSample(fr)
      this.anchors[slot * 3] = fr.samples[k * 4]
      this.anchors[slot * 3 + 1] = fr.samples[k * 4 + 1]
      this.anchors[slot * 3 + 2] = fr.samples[k * 4 + 3]
      if (this.anchorCount < ANCHORS) this.updateAnchors(fr, 0)
    }
  }

  private spawn(fr: ActiveFronts, fromFront: boolean, heightAt: (x: number, z: number) => number, exag: number, intensity: number): void {
    if (this.freeTop === 0) return
    const rng = this.rng
    let px = 0
    let pz = 0
    let heat = 0
    let rise = 0
    if (fromFront && fr.sampleCount > 0) {
      if (this.anchorCount > 0 && rng() < 0.72) {
        const a = Math.floor(rng() * this.anchorCount)
        px = this.anchors[a * 3] + (rng() - 0.5) * 260
        pz = this.anchors[a * 3 + 1] + (rng() - 0.5) * 260
        heat = 0.7 + 0.3 * this.anchors[a * 3 + 2]
        rise = 480 + 820 * Math.min(1, intensity)
      } else {
        const k = this.pickSample(fr)
        px = fr.samples[k * 4]
        pz = fr.samples[k * 4 + 1]
        heat = 0.5 + 0.4 * fr.samples[k * 4 + 3]
        rise = 300 + 500 * Math.min(1, intensity)
      }
    } else if (fr.detEmitterCount > 0) {
      let k = 0
      let maxW = 0
      for (let i = 0; i < fr.detEmitterCount; i++) maxW = Math.max(maxW, fr.detEmitters[i * 4 + 3])
      for (let t = 0; t < 8; t++) {
        k = Math.floor(rng() * fr.detEmitterCount)
        if (rng() * maxW <= fr.detEmitters[k * 4 + 3]) break
      }
      px = fr.detEmitters[k * 4]
      pz = fr.detEmitters[k * 4 + 1]
      const w = fr.detEmitters[k * 4 + 3]
      heat = Math.min(0.6, 0.08 * w)
      rise = 260 + 520 * Math.min(1, w / 12)
    } else return
    px += (rng() - 0.5) * 100
    pz += (rng() - 0.5) * 100
    const i = this.free[--this.freeTop]
    const s0 = 45 + 55 * rng()
    this.x[i] = px
    this.z[i] = pz
    this.gy[i] = heightAt(px, pz) * exag
    this.y[i] = this.gy[i] + 15 + s0 * 0.6
    this.age[i] = 0
    this.life[i] = MEAN_LIFE * (0.7 + 0.6 * rng())
    this.s0[i] = s0
    this.s1[i] = (190 + 300 * rng()) * (0.75 + 0.35 * Math.min(1, intensity))
    this.rot[i] = rng() * Math.PI * 2
    this.rotV[i] = (rng() - 0.5) * 0.22
    this.heat[i] = heat
    this.dens[i] = 0.2 + 0.18 * rng()
    this.rise[i] = rise * (0.75 + 0.5 * rng())
    this.tau[i] = 4 + 3.5 * rng()
    this.variant[i] = Math.floor(rng() * 4)
    this.alive[i] = 1
  }

  /** Advance the simulation; write sorted instance data; returns the number of live puffs. */
  step(dt: number, fr: ActiveFronts | null, heightAt: (x: number, z: number) => number, exag: number, camera: THREE.Camera, iA: Float32Array, iB: Float32Array, emit: boolean): number {
    this.updateAnchors(fr, dt)
    if (emit && fr) {
      const frontW = Math.min(1.6, fr.totalLengthM / 4000)
      const detW = Math.min(1, fr.detEmitterWeight / 60)
      const fc = fr.source === 'forecast' ? 0.6 : 1
      const rate = (frontW * 0.85 + detW * 0.45) * fc * (this.n / MEAN_LIFE)
      this.emitAcc = Math.min(this.emitAcc + rate * dt, 64)
      const pFront = frontW / Math.max(1e-6, frontW + detW * 0.6)
      while (this.emitAcc >= 1 && this.freeTop > 0) {
        this.emitAcc -= 1
        this.spawn(fr, this.rng() < pFront, heightAt, exag, frontW)
      }
    } else this.emitAcc = 0
    const w = fxShared.wind
    const tmp = this.windTmp
    const e = camera.matrixWorldInverse.elements
    let live = 0
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue
      const age = this.age[i] + dt
      if (age >= this.life[i]) {
        this.alive[i] = 0
        this.free[this.freeTop++] = i
        continue
      }
      this.age[i] = age
      sampleWind(w, this.x[i], this.z[i], tmp)
      const h = this.y[i] - this.gy[i]
      const speed = Math.hypot(tmp.u, tmp.v)
      const f = (WIND_K / (1 + speed / 15)) * (1 + 0.8 * Math.min(1, h / 900))
      const ph = this.rot[i] * 7
      this.x[i] += (tmp.u * f + Math.sin(age * 0.9 + ph) * 16) * dt
      this.z[i] += (-tmp.v * f + Math.cos(age * 0.7 + ph) * 16) * dt
      this.y[i] += ((this.rise[i] / this.tau[i]) * Math.exp(-age / this.tau[i]) + 5) * dt
      this.rot[i] += this.rotV[i] * dt
      // view depth for sorting (back to front)
      this.keys[i] = -(e[2] * this.x[i] + e[6] * this.y[i] + e[10] * this.z[i] + e[14])
      this.order[live++] = i
    }
    const ord = this.order.subarray(0, live)
    ord.sort(this.byDepth)
    for (let k = 0; k < live; k++) {
      const i = ord[k]
      const t = this.age[i] / this.life[i]
      const fadeIn = Math.min(1, t / 0.1)
      const fadeOut = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5
      iA[k * 4] = this.x[i]
      iA[k * 4 + 1] = this.y[i]
      iA[k * 4 + 2] = this.z[i]
      iA[k * 4 + 3] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.pow(t, 0.75)
      iB[k * 4] = this.dens[i] * fadeIn * fadeIn * fadeOut * fadeOut
      iB[k * 4 + 1] = this.rot[i]
      iB[k * 4 + 2] = this.heat[i] * Math.exp(-this.age[i] / 3)
      iB[k * 4 + 3] = this.variant[i]
    }
    return live
  }
}

export function Smoke({ assets }: { assets: IncidentAssets }) {
  const { visible, opacity } = useLayer('smoke')
  const quality = useStore((s) => s.quality)
  const camera = useThree((s) => s.camera)
  const N = SMOKE_N[quality]
  const sim = useMemo(() => new SmokeSim(N), [N])
  const buffers = useMemo(() => ({ iA: new Float32Array(N * 4), iB: new Float32Array(N * 4) }), [N])
  const geometry = useMemo(() => {
    const g = spriteGeometry(0, { iA: { array: buffers.iA, size: 4 }, iB: { array: buffers.iB, size: 4 } })
    ;(g.attributes.iA as THREE.InstancedBufferAttribute).setUsage(THREE.DynamicDrawUsage)
    ;(g.attributes.iB as THREE.InstancedBufferAttribute).setUsage(THREE.DynamicDrawUsage)
    return g
  }, [buffers])
  useEffect(() => () => geometry.dispose(), [geometry])
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          ...fxUniforms,
          uTex: { value: getSmokeAtlas() },
          uSmoke: { value: new THREE.Color('#72716c') },
          uGlow: { value: new THREE.Color(0.8, 0.26, 0.06) },
          uOpacity: { value: 0.8 },
        },
        transparent: true,
        depthWrite: false,
        depthTest: true,
      }),
    [],
  )
  useEffect(() => () => material.dispose(), [material])
  const heightAt = useMemo(() => makeHeightSampler(assets.elevation, assets.extent), [assets.elevation, assets.extent])

  useFrame(() => {
    if (!visible) return
    const s = useStore.getState()
    const styleMul = s.visualStyle === 'realistic' ? 1 : s.visualStyle === 'parametric' ? 0.35 : 0.85
    material.uniforms.uOpacity.value = opacity * styleMul
    const live = sim.step(fxShared.dt, fxStore.getState().fronts, heightAt, s.exaggeration, camera, buffers.iA, buffers.iB, true)
    geometry.instanceCount = live
    const a = geometry.attributes.iA as THREE.InstancedBufferAttribute
    const b = geometry.attributes.iB as THREE.InstancedBufferAttribute
    a.clearUpdateRanges()
    b.clearUpdateRanges()
    a.addUpdateRange(0, live * 4)
    b.addUpdateRange(0, live * 4)
    a.needsUpdate = true
    b.needsUpdate = true
  })

  if (!visible) return null
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={ORDER.smoke} />
}
