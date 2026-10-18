// Visual-style presets (SPEC 9.0): one "look" per visualStyle (hybrid / realistic / parametric) that the terrain
// shader, sky dome, lights, fog and post-processing all read, so the whole frame changes style coherently.
// Colours are authored as sRGB hex and converted to linear working space. A single mutable `look` blackboard holds
// the current (possibly mid-transition) values; <LookDriver/> animates it and publishes sceneStore.env.
import * as THREE from 'three'
import type { VisualStyle } from '../state/store'

export type Vec3 = [number, number, number]
export type ToneMap = 'agx' | 'aces'

/** Authoring form of a look (sRGB hex colours, degrees). */
export interface LookPreset {
  /** Direction the sunlight comes FROM: compass bearing (deg clockwise from north) and elevation above horizon. */
  sunAzimuthDeg: number
  sunElevationDeg: number
  sunColor: string
  sunIntensity: number
  skyAmbient: string
  skyAmbientIntensity: number
  groundAmbient: string
  groundAmbientIntensity: number
  /** Sky dome gradient + glow around the sun direction. */
  skyZenith: string
  skyHorizon: string
  skyGround: string
  sunGlowColor: string
  sunGlow: number
  /** Aerial perspective: horizontal 1/e visibility at the valley floor as a multiple of the AOI extent, the
   *  exponential height scale of the haze (m) and a tint multiplied onto the sky colour used as fog colour. */
  fogVisibility: number
  fogHeightM: number
  fogTint: string
  /** 1 for the realistic look: forecast as a heat wash, fire emphasised, data lines tinted (0 otherwise). */
  realistic: number
  /** Terrain: 0 photographic .. 1 dark parametric relief; gain of luminous lines; NAIP grade; micro-detail. */
  reliefMix: number
  lineGain: number
  naipSaturation: number
  naipTint: string
  naipGain: number
  /** 0..1 hue shift of the photo from straw/tan toward olive-moss. */
  naipGreen: number
  detail: number
  waterGlint: number
  /** Filmic grade (applied after tone mapping, in display space). */
  exposure: number
  toneMapping: ToneMap
  lift: string // added to shadows (display sRGB of the lifted black)
  liftAmount: number
  gain: string // highlight tint
  saturation: number
  contrast: number
  bloomIntensity: number
  bloomThreshold: number
  vignette: number
  grain: number
  bokeh: number
}

/** Numeric (linear, interpolatable) form. */
export interface LookValues {
  sunDir: Vec3
  sunColor: Vec3 // premultiplied by intensity
  skyAmbient: Vec3
  groundAmbient: Vec3
  skyZenith: Vec3
  skyHorizon: Vec3
  skyGround: Vec3
  sunGlowColor: Vec3
  sunGlow: number
  fogVisibility: number
  fogHeightM: number
  fogTint: Vec3
  realistic: number
  reliefMix: number
  lineGain: number
  naipSaturation: number
  naipTint: Vec3
  naipGain: number
  naipGreen: number
  detail: number
  waterGlint: number
  exposure: number
  agx: number // 1 = AgX, 0 = ACES (blended during transitions)
  lift: Vec3
  liftAmount: number
  gain: Vec3
  saturation: number
  contrast: number
  bloomIntensity: number
  bloomThreshold: number
  vignette: number
  grain: number
  bokeh: number
}

export const LOOKS: Record<VisualStyle, LookPreset> = {
  // Default: the art-direction "digital twin": photographic moss/olive terrain in a deep green-black atmosphere,
  // low warm side light, luminous data on top.
  hybrid: {
    sunAzimuthDeg: 252,
    sunElevationDeg: 25,
    sunColor: '#FFE6C8',
    sunIntensity: 2.6,
    skyAmbient: '#5E8A72',
    skyAmbientIntensity: 0.3,
    groundAmbient: '#3A3524',
    groundAmbientIntensity: 0.16,
    skyZenith: '#050807',
    skyHorizon: '#1B281F',
    skyGround: '#0A0F0C',
    sunGlowColor: '#C9935A',
    sunGlow: 0.55,
    fogVisibility: 1.35,
    fogHeightM: 1300,
    fogTint: '#B8D4C0',
    realistic: 0,
    reliefMix: 0,
    lineGain: 1,
    naipSaturation: 0.85,
    naipTint: '#B4D2A6',
    naipGain: 0.6,
    naipGreen: 1,
    detail: 1,
    waterGlint: 1,
    exposure: 1.05,
    toneMapping: 'agx',
    lift: '#0B140F',
    liftAmount: 1,
    gain: '#FFF1DA',
    saturation: 1.12,
    contrast: 1.12,
    bloomIntensity: 0.9,
    bloomThreshold: 0.92,
    vignette: 0.62,
    grain: 0.32,
    bokeh: 3.2,
  },
  // Natural golden-hour light, sky gradient with a warm sun glow; data lines dimmed, fire and smoke emphasised.
  realistic: {
    sunAzimuthDeg: 284,
    sunElevationDeg: 18,
    sunColor: '#FFE1BF',
    sunIntensity: 3.7,
    skyAmbient: '#93A9B2',
    skyAmbientIntensity: 0.55,
    groundAmbient: '#3B3426',
    groundAmbientIntensity: 0.22,
    skyZenith: '#17232B',
    skyHorizon: '#5A6663',
    skyGround: '#1C221F',
    sunGlowColor: '#FFB46E',
    sunGlow: 1.4,
    fogVisibility: 2.4,
    fogHeightM: 1600,
    fogTint: '#E6DCC6',
    realistic: 1,
    reliefMix: 0,
    lineGain: 0.6,
    naipSaturation: 0.88,
    naipTint: '#ECE8D8',
    naipGain: 0.62,
    naipGreen: 0.25,
    detail: 1,
    waterGlint: 1.2,
    exposure: 1.0,
    toneMapping: 'aces',
    lift: '#0D110F',
    liftAmount: 0.7,
    gain: '#FFF4E6',
    saturation: 0.94,
    contrast: 1.08,
    bloomIntensity: 0.8,
    bloomThreshold: 1.0,
    vignette: 0.5,
    grain: 0.26,
    bokeh: 2.6,
  },
  // Pure digital twin: near-black relief with a faint hillshade; everything else is glowing points and lines.
  parametric: {
    sunAzimuthDeg: 300,
    sunElevationDeg: 38,
    sunColor: '#F2E6CC',
    sunIntensity: 1.6,
    skyAmbient: '#3B5446',
    skyAmbientIntensity: 0.2,
    groundAmbient: '#1A1D16',
    groundAmbientIntensity: 0.08,
    skyZenith: '#030504',
    skyHorizon: '#0E1611',
    skyGround: '#050807',
    sunGlowColor: '#4A3F28',
    sunGlow: 0.25,
    fogVisibility: 1.6,
    fogHeightM: 1500,
    fogTint: '#A9C2B2',
    realistic: 0,
    reliefMix: 1,
    lineGain: 1.45,
    naipSaturation: 0.5,
    naipTint: '#C9DDB0',
    naipGain: 0.6,
    naipGreen: 1,
    detail: 0.6,
    waterGlint: 0.5,
    exposure: 1.1,
    toneMapping: 'agx',
    lift: '#08100C',
    liftAmount: 1,
    gain: '#FFF2DC',
    saturation: 1.1,
    contrast: 1.12,
    bloomIntensity: 1.05,
    bloomThreshold: 0.85,
    vignette: 0.66,
    grain: 0.3,
    bokeh: 3.2,
  },
}

const _c = new THREE.Color()
/** sRGB hex -> linear RGB. */
export function linear(hex: string, scale = 1): Vec3 {
  _c.set(hex) // THREE.ColorManagement converts sRGB input to the linear working space
  return [_c.r * scale, _c.g * scale, _c.b * scale]
}

/** sRGB hex -> display (sRGB-encoded) RGB 0..1, for values used after tone mapping. */
function display(hex: string): Vec3 {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Unit vector pointing toward the sun in world space (x east, y up, z south) from bearing + elevation. */
export function sunDirection(azimuthDeg: number, elevationDeg: number): Vec3 {
  const az = (azimuthDeg * Math.PI) / 180
  const el = (elevationDeg * Math.PI) / 180
  // bearing az: east = sin(az), north = cos(az); world z is south+
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)]
}

export function resolveLook(p: LookPreset): LookValues {
  return {
    sunDir: sunDirection(p.sunAzimuthDeg, p.sunElevationDeg),
    sunColor: linear(p.sunColor, p.sunIntensity),
    skyAmbient: linear(p.skyAmbient, p.skyAmbientIntensity),
    groundAmbient: linear(p.groundAmbient, p.groundAmbientIntensity),
    skyZenith: linear(p.skyZenith),
    skyHorizon: linear(p.skyHorizon),
    skyGround: linear(p.skyGround),
    sunGlowColor: linear(p.sunGlowColor),
    sunGlow: p.sunGlow,
    fogVisibility: p.fogVisibility,
    fogHeightM: p.fogHeightM,
    fogTint: linear(p.fogTint),
    realistic: p.realistic,
    reliefMix: p.reliefMix,
    lineGain: p.lineGain,
    naipSaturation: p.naipSaturation,
    naipTint: linear(p.naipTint),
    naipGain: p.naipGain,
    naipGreen: p.naipGreen,
    detail: p.detail,
    waterGlint: p.waterGlint,
    exposure: p.exposure,
    agx: p.toneMapping === 'agx' ? 1 : 0,
    lift: display(p.lift),
    liftAmount: p.liftAmount,
    gain: display(p.gain),
    saturation: p.saturation,
    contrast: p.contrast,
    bloomIntensity: p.bloomIntensity,
    bloomThreshold: p.bloomThreshold,
    vignette: p.vignette,
    grain: p.grain,
    bokeh: p.bokeh,
  }
}

export const LOOK_VALUES: Record<VisualStyle, LookValues> = {
  hybrid: resolveLook(LOOKS.hybrid),
  realistic: resolveLook(LOOKS.realistic),
  parametric: resolveLook(LOOKS.parametric),
}

export function cloneLook(v: LookValues): LookValues {
  const out = { ...v } as LookValues
  for (const k of Object.keys(v) as (keyof LookValues)[]) {
    const x = v[k]
    if (Array.isArray(x)) (out as unknown as Record<string, unknown>)[k] = [x[0], x[1], x[2]]
  }
  return out
}

/** out = a + (b - a) t for every field (sun direction re-normalised). Allocation-free. */
export function lerpLook(a: LookValues, b: LookValues, t: number, out: LookValues): LookValues {
  const o = out as unknown as Record<string, number | Vec3>
  const ra = a as unknown as Record<string, number | Vec3>
  const rb = b as unknown as Record<string, number | Vec3>
  for (const k of Object.keys(ra)) {
    const x = ra[k]
    const y = rb[k]
    if (Array.isArray(x) && Array.isArray(y)) {
      const dst = o[k] as Vec3
      dst[0] = x[0] + (y[0] - x[0]) * t
      dst[1] = x[1] + (y[1] - x[1]) * t
      dst[2] = x[2] + (y[2] - x[2]) * t
    } else {
      o[k] = (x as number) + ((y as number) - (x as number)) * t
    }
  }
  const s = out.sunDir
  const len = Math.hypot(s[0], s[1], s[2]) || 1
  s[0] /= len
  s[1] /= len
  s[2] /= len
  return out
}

/** Mutable blackboard of the current look (written by <LookDriver/> at the start of every frame). */
export const look = {
  style: 'hybrid' as VisualStyle,
  /** Current (interpolated) values. */
  current: cloneLook(LOOK_VALUES.hybrid),
  /** Values the current transition heads to, and its progress 0..1 (1 = settled). */
  from: cloneLook(LOOK_VALUES.hybrid),
  target: cloneLook(LOOK_VALUES.hybrid),
  progress: 1,
  /** Increments whenever a transition starts (consumers re-bake style-dependent resources). */
  version: 0,
}

/** Smoothstep easing. */
export const ease = (t: number) => t * t * (3 - 2 * t)
