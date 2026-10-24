// Colours and generated map images for the optional sources (owner: optional-sources). MapLibre paint properties
// cannot read CSS variables, so the CONTRACT §9 tokens are mirrored here: keep them equal to styles/map-tokens.css.
// Official evacuation zones use magenta / violet / blue with CROSS-hatching (two directions) so they never look like
// the orange single-direction hatch of modeled spread; density and outline style differ per status (never colour
// alone). Patterns and icons are plain RGBA arrays (no DOM), so they are testable and work with map.addImage.
import type { CameraKind, EvacStatusKey } from './types'

export const EXTRAS_COLORS = {
  evacOrder: '#e0459b', // --m-evac-order
  evacWarning: '#a78bfa', // --m-evac-warning
  evacOther: '#7aa2f7', // --m-evac-other
  text: '#f0f0f0', // --m-text
  text2: '#cfcfcf', // --m-text-2
  bg: '#0c0c0c', // --m-bg
  select: '#9fd6ff', // --m-select
  /** --m-select-soft at .16: the selected camera's halo */
  selectSoft: 'rgba(159,214,255,0.16)',
  halo: 'rgba(10,10,10,0.92)',
} as const

/**
 * Map style group of an official status: urgent (orders and shelter-in-place: immediate threat to life), warning,
 * everything else that is shown ("other": advisories, lifted orders, unrecognised wording), or hidden (Normal and
 * Training zones need no action). The official wording is always shown next to the style.
 */
export type EvacStyleGroup = 'order' | 'warning' | 'other' | 'hidden'

export function evacStyleGroup(key: EvacStatusKey): EvacStyleGroup {
  if (key === 'order' || key === 'shelter') return 'order'
  if (key === 'warning') return 'warning'
  if (key === 'normal' || key === 'training') return 'hidden'
  return 'other'
}

export const EVAC_GROUP_COLOR: Record<Exclude<EvacStyleGroup, 'hidden'>, string> = {
  order: EXTRAS_COLORS.evacOrder,
  warning: EXTRAS_COLORS.evacWarning,
  other: EXTRAS_COLORS.evacOther,
}

/** Outline style per group (legend + map): order solid and thick, warning dashed, other dotted. */
export const EVAC_GROUP_LINE: Record<Exclude<EvacStyleGroup, 'hidden'>, { width: number; dash: number[] | null; style: 'solid' | 'dashed' | 'dotted' }> = {
  order: { width: 2.6, dash: null, style: 'solid' },
  warning: { width: 2, dash: [3, 2], style: 'dashed' },
  other: { width: 1.8, dash: [1, 1.6], style: 'dotted' },
}

/** Cross-hatch line spacing in CSS px: dense for orders, wider for warnings, sparse for other statuses. */
export const EVAC_GROUP_HATCH: Record<Exclude<EvacStyleGroup, 'hidden'>, { spacing: number; width: number; alpha: number }> = {
  order: { spacing: 6, width: 1.3, alpha: 0.85 },
  warning: { spacing: 9, width: 1.1, alpha: 0.75 },
  other: { spacing: 12, width: 1, alpha: 0.65 },
}

/** Display order of statuses (most urgent first). */
export const EVAC_STATUS_ORDER: EvacStatusKey[] = ['order', 'shelter', 'warning', 'advisory', 'lifted', 'other', 'unknown', 'training', 'normal']

export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array
}

export function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = Number.parseInt(v.slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * A seamless cross-hatch tile (both diagonals) in physical pixels: `tileCss` CSS px wide at `pixelRatio`, line
 * spacing `spacingCss` (the tile must hold a whole number of lines, so the spacing is adjusted to divide it).
 */
export function crossHatchImage(color: string, spacingCss: number, widthCss: number, alpha: number, pixelRatio = 2, tileCss = 24): RgbaImage {
  const size = Math.round(tileCss * pixelRatio)
  const lines = Math.max(1, Math.round(tileCss / spacingCss))
  const period = size / lines
  const half = (widthCss * pixelRatio) / 2
  const [r, g, b] = parseHex(color)
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // distance (px) to the nearest line of each diagonal family; lines repeat every `period` along x
      const d1 = dist(((x + 0.5 - (y + 0.5)) % period + period) % period, period) / Math.SQRT2
      const d2 = dist(((x + 0.5 + (y + 0.5)) % period + period) % period, period) / Math.SQRT2
      const d = Math.min(d1, d2)
      const cover = clamp01(half + 0.5 - d)
      const i = (y * size + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = Math.round(255 * alpha * cover)
    }
  }
  return { width: size, height: size, data }
}

function dist(m: number, period: number): number {
  return Math.min(m, period - m)
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * Camera pictogram (body + lens + mount) in physical pixels for a symbol layer: wildfire cameras filled light,
 * traffic cameras outlined, both with a dark halo so they read on dark and aerial basemaps.
 */
export function cameraIconImage(kind: CameraKind, pixelRatio = 2, selected = false): RgbaImage {
  const css = 18
  const size = Math.round(css * pixelRatio)
  const s = pixelRatio
  const data = new Uint8Array(size * size * 4)
  const fg = parseHex(selected ? EXTRAS_COLORS.select : EXTRAS_COLORS.text)
  const halo = parseHex(EXTRAS_COLORS.bg)
  // shapes in CSS px around the centre: rounded body 12x8, lens circle r 2.4, viewfinder bump on top
  const body = (x: number, y: number) => roundedRectDist(x, y, 9, 10, 12, 7.5, 1.6)
  const bump = (x: number, y: number) => roundedRectDist(x, y, 9, 5.6, 4.4, 2.4, 0.8)
  const lens = (x: number, y: number) => Math.hypot(x - 9, y - 10) - 2.5
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) / s
      const y = (py + 0.5) / s
      const shape = Math.min(body(x, y), bump(x, y))
      const outer = clamp01(0.5 - (shape - 1.6) * s) // halo ring 1.6 css px around the shape
      let fill: number
      if (kind === 'wildfire') {
        // solid body with a dark lens
        fill = clamp01(0.5 - shape * s) * (1 - clamp01(0.5 - lens(x, y) * s))
      } else {
        // outline body + outlined lens
        const ring = Math.abs(shape + 0.7) - 0.7
        const lensRing = Math.abs(lens(x, y)) - 0.6
        fill = Math.max(clamp01(0.5 - ring * s), clamp01(0.5 - lensRing * s))
      }
      const i = (py * size + px) * 4
      const a = Math.max(fill, outer * 0.9)
      const t = a > 0 ? fill / a : 0
      data[i] = Math.round(fg[0] * t + halo[0] * (1 - t))
      data[i + 1] = Math.round(fg[1] * t + halo[1] * (1 - t))
      data[i + 2] = Math.round(fg[2] * t + halo[2] * (1 - t))
      data[i + 3] = Math.round(255 * a)
    }
  }
  return { width: size, height: size, data }
}

/** Signed distance (CSS px) from (x, y) to a rounded rectangle centred at (cx, cy). */
function roundedRectDist(x: number, y: number, cx: number, cy: number, w: number, h: number, r: number): number {
  const qx = Math.abs(x - cx) - (w / 2 - r)
  const qy = Math.abs(y - cy) - (h / 2 - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

/** CSS background for a legend swatch that mirrors the map's cross-hatch (repeating gradients, no images). */
export function hatchSwatchCss(color: string, spacingCss: number): string {
  const s = Math.max(3, Math.round(spacingCss / 1.5))
  const c = `${color}cc`
  return [
    `repeating-linear-gradient(45deg, ${c} 0 1px, transparent 1px ${s}px)`,
    `repeating-linear-gradient(-45deg, ${c} 0 1px, transparent 1px ${s}px)`,
    `${color}22`,
  ].join(', ')
}
