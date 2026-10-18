// Wind (SPEC 9.3): ~3000 particle streaks advected by the 4x4 u/v weather grid at the current timeline time
// (time-compressed so flow reads at kilometre scale). Fully GPU: each streak respawns at a hashed position every
// cycle, flows along the bilinear wind, floats ~45 m above the terrain (elevation texture) and fades in/out; length
// and brightness grow with speed. Gold-white in parametric, faint white otherwise; additive.
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useStore, type Quality } from '../../state/store'
import type { IncidentAssets } from '../assets'
import { GLSL_COMMON, GLSL_OUTPUT, GLSL_VERT, GLSL_WIND, HEX, ORDER, fxUniforms, hash01, useLayer } from './common'
import { spriteGeometry } from './lines'
import { fxShared } from './state'

const STREAKS: Record<Quality, number> = { high: 3000, medium: 2200, low: 1400 }

const vertexShader = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
${GLSL_WIND}
attribute vec4 iSeed; // x, z seeds, phase, speed jitter (0..1)
uniform sampler2D uElev;
uniform float uOpacity;
uniform float uLife;
varying float vAlpha;
varying float vAlong;
varying float vSide;
vec3 lifted(vec2 xz) { return vec3(xz.x, texture2D(uElev, fxUv(xz)).r * uExag + 45.0, xz.y); }
void main() {
  float clk = uClock * (0.8 + 0.4 * iSeed.w) + iSeed.z * uLife;
  float cycle = floor(clk / uLife);
  float age = clk - cycle * uLife;
  vec2 p0 = (vec2(fxHash12(iSeed.xy * 97.0 + cycle * 1.37), fxHash12(iSeed.yx * 89.0 + cycle * 2.11)) - 0.5) * uExtent * 0.94;
  vec2 v = fxWindWorld(p0);
  float sp = length(v);
  float k = 34.0 / (1.0 + sp / 20.0);
  vec2 head = p0 + v * k * age;
  vec2 tail = head - v * k * (0.55 + 0.45 * iSeed.w);
  vec3 wt = lifted(tail);
  vec3 wh = lifted(head);
  vec4 ct = projectionMatrix * fxViewPos(wt, 0.0);
  vec4 ch = projectionMatrix * fxViewPos(wh, 0.0);
  vAlong = position.x * 0.5 + 0.5;
  vSide = position.y;
  vec4 c = mix(ct, ch, vAlong);
  if (ct.w < 1.0 || ch.w < 1.0 || sp < 0.2) { vAlpha = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 d = (ch.xy / ch.w - ct.xy / ct.w) * uViewport;
  vec2 dir = length(d) > 1.0e-3 ? normalize(d) : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  c.xy += nrm * position.y * (1.4 * uPixelRatio / uViewport) * c.w;
  float life = sin(3.14159 * clamp(age / uLife, 0.0, 1.0));
  vec3 mid = 0.5 * (wt + wh);
  vAlpha = life * clamp(sp / 8.0, 0.35, 1.0) * fxKeep(mid) * uOpacity;
  gl_Position = c;
}
`

const fragmentShader = /* glsl */ `
${GLSL_COMMON}
uniform vec3 uColor;
varying float vAlpha;
varying float vAlong;
varying float vSide;
void main() {
  float a = vAlpha * vAlong * vAlong * (1.0 - abs(vSide));
  gl_FragColor = vec4(uColor, a);
  ${GLSL_OUTPUT}
}
`

export function Wind({ assets }: { assets: IncidentAssets }) {
  const { visible, opacity } = useLayer('wind')
  const quality = useStore((s) => s.quality)
  const n = STREAKS[quality]
  const geometry = useMemo(() => {
    const seeds = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
      seeds[i * 4] = hash01(i * 4 + 1)
      seeds[i * 4 + 1] = hash01(i * 4 + 2)
      seeds[i * 4 + 2] = hash01(i * 4 + 3)
      seeds[i * 4 + 3] = hash01(i * 4 + 4)
    }
    return spriteGeometry(n, { iSeed: { array: seeds, size: 4 } })
  }, [n])
  useEffect(() => () => geometry.dispose(), [geometry])
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: { ...fxUniforms, uElev: { value: null }, uOpacity: { value: 0.7 }, uLife: { value: 5 }, uColor: { value: new THREE.Color() } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  )
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => {
    material.uniforms.uElev.value = assets.textures.elevation
  }, [assets.textures.elevation, material])
  const gold = useMemo(() => new THREE.Color(HEX.goldWhite).multiplyScalar(0.95), [])
  const white = useMemo(() => new THREE.Color(0.8, 0.85, 0.85).multiplyScalar(0.75), [])

  useFrame(() => {
    if (!visible) return
    const parametric = useStore.getState().visualStyle === 'parametric'
    material.uniforms.uColor.value.copy(parametric ? gold : white)
    material.uniforms.uOpacity.value = fxShared.wind.valid ? opacity : 0
  })

  if (!visible) return null
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={ORDER.wind} />
}
