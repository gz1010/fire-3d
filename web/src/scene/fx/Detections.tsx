// Satellite detections (SPEC 9.3), shown for t_ms <= timeline time:
//  - hybrid/parametric: true-size footprint squares (VIIRS 375 m, MODIS 1 km, Landsat 30 m) draped on the terrain,
//    outlined gold/orange; bright while <= 12 h old, then dimming (a faint trace stays as forensic history);
//  - realistic: small hot glows sized by FRP that fade within ~12 h;
//  - GOES: faint 2 km halos for the last ~90 min, only when zoomed out.
// Static geometry per detections file; the time filter and age colouring run in the shaders.
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { Detection } from '../../api/types'
import { useStore } from '../../state/store'
import type { IncidentAssets } from '../assets'
import { GLSL_COMMON, GLSL_OUTPUT, GLSL_VERT, HEX, HOUR_MS, ORDER, fxUniforms, hash01, makeHeightSampler, useLayer } from './common'
import { GLSL_RIBBON_FRAG, GLSL_RIBBON_VERT, GLSL_SPRITE_VERT, drape, ribbonGeometry, spriteGeometry, type RibbonLine } from './lines'

const INST = { VIIRS: 0, MODIS: 1, GOES: 2, LANDSAT: 3 } as const

const footVert = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
${GLSL_RIBBON_VERT}
uniform float uOpacity;
uniform vec3 uRecent;
uniform vec3 uHot;
uniform vec3 uOld;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float age = uTimeH - aData.x;
  float inst = aData.z;
  float width = inst > 2.5 ? 0.8 : (inst > 0.5 ? 0.9 : 1.05);
  gl_Position = fxRibbon(width, 3.0, 0.0016);
  float show = step(0.0, age) * step(0.5, abs(uStyle - 1.0));
  float bright = age <= 12.0 ? 0.7 - 0.35 * smoothstep(1.0, 12.0, age) : 0.35 * (1.0 - smoothstep(12.0, 30.0, age));
  vec3 c = mix(uOld, uRecent, smoothstep(18.0, 3.0, age));
  c = mix(c, uHot, smoothstep(1.5, 0.0, age) * 0.6);
  vColor = c * (0.6 + 0.8 * smoothstep(6.0, 0.0, age)) * uLineGain;
  vec3 world = vec3(position.x, position.y * uExag, position.z);
  vAlpha = show * bright * 0.5 * fxKeep(world) * uOpacity;
  if (vAlpha < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`

const footFrag = /* glsl */ `
${GLSL_COMMON}
${GLSL_RIBBON_FRAG}
varying vec3 vColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(vColor, vAlpha * fxRibbonAlpha());
  ${GLSL_OUTPUT}
}
`

// Glows (realistic: FRP-sized hot pixels) and GOES halos share one sprite shader; aKind 0 glow, 1 halo.
const spriteVert = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
${GLSL_SPRITE_VERT}
attribute vec4 iPos;  // x, elevation (m), z, t (hours since origin)
attribute vec4 iInfo; // frp (MW), kind (0 glow, 1 GOES halo), rand, unused
uniform float uOpacity;
uniform float uZoomOut;
uniform vec3 uHot;
uniform vec3 uFire;
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
void main() {
  float age = uTimeH - iPos.w;
  vec3 world = vec3(iPos.x, iPos.y * uExag + 4.0, iPos.z);
  vec4 mv = viewMatrix * vec4(world, 1.0);
  float depth = max(-mv.z, 1.0);
  float pxm = fxPxPerMeter(depth);
  float frp = max(iInfo.x, 1.0);
  vKind = iInfo.y;
  float halfPx;
  if (iInfo.y < 0.5) {
    float realistic = step(0.5, uStyle) * step(uStyle, 1.5);
    float hybridHot = step(uStyle, 0.5) * smoothstep(3.0, 0.0, age) * 0.35;
    float a = step(0.0, age) * exp(-max(age, 0.0) / 4.0) * max(realistic, hybridHot);
    float radius = min(200.0, 24.0 + 4.0 * sqrt(frp)) * mix(0.6, 1.0, realistic);
    halfPx = max(radius * pxm, 1.6 * uPixelRatio);
    float flick = 0.85 + 0.15 * sin(uClock * 6.0 + iInfo.z * 40.0);
    vColor = mix(uFire, uHot, smoothstep(2.0, 0.0, age) * 0.35) * (0.55 + 0.18 * log(frp)) * flick;
    a *= 0.75;
    vAlpha = a * fxKeep(world) * uOpacity;
  } else {
    float a = step(0.0, age) * (1.0 - smoothstep(0.2, 1.0, age)) * uZoomOut;
    halfPx = 1000.0 * pxm;
    vColor = mix(uFire, uHot, 0.35) * uLineGain;
    vAlpha = a * 0.1 * fxKeep(world) * uOpacity;
  }
  gl_Position = fxSprite(world, halfPx, 0.002);
  if (vAlpha < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`

const spriteFrag = /* glsl */ `
${GLSL_COMMON}
varying vec2 vQuad;
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
void main() {
  float r = length(vQuad);
  if (r > 1.0) discard;
  float prof;
  if (vKind < 0.5) prof = exp(-r * r * 5.0) + 0.35 * exp(-r * r * 22.0);
  else { float e = (r - 0.92) / 0.03; prof = exp(-e * e) + 0.1 * (1.0 - r); }
  gl_FragColor = vec4(vColor, vAlpha * prof);
  ${GLSL_OUTPUT}
}
`

interface DetectionGeometry {
  foot: THREE.BufferGeometry | null
  sprites: THREE.InstancedBufferGeometry | null
}

function build(dets: Detection[], assets: IncidentAssets): DetectionGeometry {
  const hs = makeHeightSampler(assets.elevation, assets.extent)
  const origin = assets.manifest.time_origin_ms
  const half = assets.extent / 2
  const lines: RibbonLine[] = []
  const spritePos: number[] = []
  const spriteInfo: number[] = []
  const sq = new Float32Array(8)
  for (const d of dets) {
    if (!Number.isFinite(d.x) || !Number.isFinite(d.z) || Math.abs(d.x) > half * 1.2 || Math.abs(d.z) > half * 1.2) continue
    const tH = (d.t_ms - origin) / HOUR_MS
    const inst = INST[d.instrument] ?? 0
    const frp = d.frp != null && Number.isFinite(d.frp) ? d.frp : 0
    const y = hs(d.x, d.z)
    if (inst === INST.GOES) {
      spritePos.push(d.x, y, d.z, tH)
      spriteInfo.push(frp, 1, hash01(spriteInfo.length + 3), 0)
      continue
    }
    const fp = d.footprint_m > 0 ? d.footprint_m : inst === INST.MODIS ? 1000 : inst === INST.LANDSAT ? 30 : 375
    const h = fp / 2
    sq[0] = d.x - h
    sq[1] = d.z - h
    sq[2] = d.x + h
    sq[3] = d.z - h
    sq[4] = d.x + h
    sq[5] = d.z + h
    sq[6] = d.x - h
    sq[7] = d.z + h
    const pts = drape(sq, hs, Math.max(30, fp / 6), true)
    lines.push({ pts, closed: true, constData: [tH, frp, inst, 0] })
    spritePos.push(d.x, y, d.z, tH)
    spriteInfo.push(frp, 0, hash01(spriteInfo.length + 5), 0)
  }
  const nS = spritePos.length / 4
  return {
    foot: lines.length ? ribbonGeometry(lines) : null,
    sprites: nS
      ? spriteGeometry(nS, { iPos: { array: new Float32Array(spritePos), size: 4 }, iInfo: { array: new Float32Array(spriteInfo), size: 4 } })
      : null,
  }
}

export function Detections({ assets }: { assets: IncidentAssets }) {
  const { visible, opacity } = useLayer('detections')
  const detections = useStore((s) => s.detections)
  const geo = useMemo(() => build(detections?.detections ?? [], assets), [detections, assets.elevation, assets.extent, assets.manifest.time_origin_ms]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    geo.foot?.dispose()
    geo.sprites?.dispose()
  }, [geo])
  const mats = useMemo(
    () => ({
      foot: new THREE.ShaderMaterial({
        vertexShader: footVert,
        fragmentShader: footFrag,
        uniforms: {
          ...fxUniforms,
          uOpacity: { value: 0.9 },
          uRecent: { value: new THREE.Color('#F4C27A') },
          uHot: { value: new THREE.Color(HEX.fire) },
          uOld: { value: new THREE.Color(HEX.latticeFalloff).multiplyScalar(0.8) },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
      sprite: new THREE.ShaderMaterial({
        vertexShader: spriteVert,
        fragmentShader: spriteFrag,
        uniforms: {
          ...fxUniforms,
          uOpacity: { value: 0.9 },
          uZoomOut: { value: 0 },
          uHot: { value: new THREE.Color(HEX.fireHot) },
          uFire: { value: new THREE.Color(HEX.fire) },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    }),
    [],
  )
  useEffect(() => () => {
    mats.foot.dispose()
    mats.sprite.dispose()
  }, [mats])

  useFrame(() => {
    if (!visible) return
    mats.foot.uniforms.uOpacity.value = opacity
    mats.sprite.uniforms.uOpacity.value = opacity
    const ratio = fxUniforms.uCamDist.value / assets.extent
    mats.sprite.uniforms.uZoomOut.value = Math.min(1, Math.max(0, (ratio - 1.15) / 0.5))
  })

  if (!visible) return null
  return (
    <>
      {geo.foot && <mesh geometry={geo.foot} material={mats.foot} frustumCulled={false} renderOrder={ORDER.detections} />}
      {geo.sprites && <mesh geometry={geo.sprites} material={mats.sprite} frustumCulled={false} renderOrder={ORDER.detections} />}
    </>
  )
}
