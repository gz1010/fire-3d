// Where the satellite caption goes (owner: official-web): the shell decides where the chip sits (the header on
// desktop, under the map controls on phones), so the caption is placed by measurement next to the chip at the first
// spot that stays on screen and covers no floating chrome (search, controls, panels, card…). Pure, tested.

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

const area = (r: Rect) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top)
function overlap(a: Rect, b: Rect): number {
  return area({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) })
}

/**
 * The caption's top-left corner (fixed coordinates): below the chip, hanging to its left, else right-aligned under it,
 * else left-aligned under it; the first candidate inside the viewport that overlaps no obstacle wins, else the one
 * with the least overlap. `gap` is the space between chip and caption.
 */
export function chooseCaptionPlacement(chip: Rect, size: { w: number; h: number }, obstacles: readonly Rect[], viewport: { w: number; h: number }, gap = 6): { left: number; top: number } {
  const top = chip.bottom + gap
  const candidates = [chip.left + 40 - size.w, chip.right - size.w, chip.left].map((left) => ({ left: Math.round(left), top: Math.round(top) }))
  let best = candidates[1]
  let bestCost = Infinity
  for (const c of candidates) {
    const r: Rect = { left: c.left, top: c.top, right: c.left + size.w, bottom: c.top + size.h }
    const outside = r.left < 8 || r.right > viewport.w - 8 || r.bottom > viewport.h - 8
    const cost = obstacles.reduce((s, o) => s + overlap(r, o), 0) + (outside ? 1e9 : 0)
    if (cost === 0) return c
    if (cost < bestCost) {
      bestCost = cost
      best = c
    }
  }
  return best
}
