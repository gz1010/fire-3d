// Pure layout maths for the Public/Command shell (CONTRACT §3): map padding ("safe insets") from the floating chrome
// docked to each side, and the share of the viewport the chrome leaves unobstructed (BRIEF §6 target: >= 75 % at
// 1440x900 with no drawer open). Every floating region is a [data-chrome] slot; CSS says which side it docks to with
// the custom property --chrome-side (top | right | bottom | left | none), so the docking can change per breakpoint.

export type DockSide = 'top' | 'right' | 'bottom' | 'left' | 'none'

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface ChromeRect extends Rect {
  side: DockSide
}

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

/** The smallest map area (px) the insets may leave on each axis; beyond that the larger opposing inset gives way, so
 *  framing never collapses on a phone with a tall panel open. */
export const MIN_VISIBLE_PX = 120

export function parseDockSide(v: string | null | undefined): DockSide {
  const s = (v ?? '').trim()
  return s === 'top' || s === 'right' || s === 'bottom' || s === 'left' ? s : 'none'
}

const isEmpty = (r: Rect) => !(r.right - r.left > 0.5 && r.bottom - r.top > 0.5)

/** Clip a rectangle to the viewport (null when nothing is left). */
export function clipRect(r: Rect, W: number, H: number): Rect | null {
  const c = { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(W, r.right), bottom: Math.min(H, r.bottom) }
  return isEmpty(c) ? null : c
}

/** Map padding: for each side the deepest reach of the chrome docked there, plus `gap` (also when nothing is docked). */
export function safeInsetsFor(items: readonly ChromeRect[], W: number, H: number, gap: number): Insets {
  let top = 0
  let right = 0
  let bottom = 0
  let left = 0
  for (const it of items) {
    const r = clipRect(it, W, H)
    if (!r) continue
    if (it.side === 'top') top = Math.max(top, r.bottom)
    else if (it.side === 'right') right = Math.max(right, W - r.left)
    else if (it.side === 'bottom') bottom = Math.max(bottom, H - r.top)
    else if (it.side === 'left') left = Math.max(left, r.right)
  }
  const out = { top: Math.round(top + gap), right: Math.round(right + gap), bottom: Math.round(bottom + gap), left: Math.round(left + gap) }
  // keep a usable centre: shrink the larger of two opposing insets until MIN_VISIBLE_PX remains
  const fit = (a: number, b: number, size: number): [number, number] => {
    const excess = a + b - Math.max(0, size - MIN_VISIBLE_PX)
    if (excess <= 0) return [a, b]
    if (a >= b) return [Math.max(Math.round(gap), a - excess), b]
    return [a, Math.max(Math.round(gap), b - excess)]
  }
  ;[out.left, out.right] = fit(out.left, out.right, W)
  ;[out.top, out.bottom] = fit(out.top, out.bottom, H)
  return out
}

/** Exact area of the union of rectangles inside the W x H viewport (coordinate compression; fine for dozens). */
export function unionArea(rects: readonly Rect[], W: number, H: number): number {
  const rs = rects.map((r) => clipRect(r, W, H)).filter((r): r is Rect => r != null)
  if (rs.length === 0) return 0
  const xs = [...new Set(rs.flatMap((r) => [r.left, r.right]))].sort((a, b) => a - b)
  const ys = [...new Set(rs.flatMap((r) => [r.top, r.bottom]))].sort((a, b) => a - b)
  let area = 0
  for (let i = 0; i + 1 < xs.length; i++) {
    const cx = (xs[i] + xs[i + 1]) / 2
    for (let j = 0; j + 1 < ys.length; j++) {
      const cy = (ys[j] + ys[j + 1]) / 2
      if (rs.some((r) => cx > r.left && cx < r.right && cy > r.top && cy < r.bottom)) area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j])
    }
  }
  return area
}

/** Share of the viewport (0..1) not covered by any of the rectangles. */
export function unobstructedShare(rects: readonly Rect[], W: number, H: number): number {
  if (W <= 0 || H <= 0) return 0
  return 1 - unionArea(rects, W, H) / (W * H)
}

/** Is a screen point (px, map container coordinates) under the chrome described by `insets`, or within `margin` of
 *  it? Used to keep a clicked pin out from under a phone's bottom sheet (brief 2 C-R2). */
export function pointHidden(p: { x: number; y: number }, W: number, H: number, insets: Insets, margin = 0): boolean {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false
  return p.y > H - insets.bottom - margin || p.y < insets.top + margin || p.x < insets.left + margin || p.x > W - insets.right - margin
}
