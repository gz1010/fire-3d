// Where the one-time "turn the map" hint goes (brief 4 H3; H2's known issue: the hint hung under or over the map
// controls and could cover Command's readout, the overview's location card or official text). Pure, tested in
// hintPlacement.test.ts; map/MapControls.tsx measures the controls, the hint and every visible chrome region
// ([data-chrome]) and places the hint (position: fixed) at the answer.
// Rule: beside the controls (above / below them, sliding sideways, or to their side, sliding up or down), inside the
// window, covering no chrome region; the side the controls face first. When no place is free, the one that covers the
// least (it closes by itself after 12 s and has a close button).

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export type HintSide = 'below' | 'above' | 'left' | 'right'

export interface HintPlace {
  left: number
  top: number
  side: HintSide
  /** Pixels of chrome the hint covers there (0 = free). */
  covered: number
}

/** How far the hint may slide sideways past the controls' own edges and still read as theirs (px). */
export const HINT_REACH_PX = 120

const overlap = (a: Box, b: Box): number => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))

/** The hint's box at a corner. */
export function hintBox(left: number, top: number, size: { w: number; h: number }): Box {
  return { left, top, right: left + size.w, bottom: top + size.h }
}

/** Every place considered, in order of preference (`prefer` first, then its opposite, then the two other sides). */
export function hintCandidates(ctl: Box, size: { w: number; h: number }, obstacles: readonly Box[], prefer: HintSide, gap = 8): { left: number; top: number; side: HintSide }[] {
  const order: HintSide[] =
    prefer === 'below' ? ['below', 'above', 'right', 'left'] : prefer === 'above' ? ['above', 'below', 'right', 'left'] : prefer === 'left' ? ['left', 'right', 'above', 'below'] : ['right', 'left', 'above', 'below']
  const out: { left: number; top: number; side: HintSide }[] = []
  const xs = [ctl.left, ctl.right - size.w, ...obstacles.map((o) => o.right + gap), ...obstacles.map((o) => o.left - gap - size.w)].filter(
    (x) => x + size.w > ctl.left - HINT_REACH_PX && x < ctl.right + HINT_REACH_PX,
  )
  const ys = [ctl.top, ctl.bottom - size.h, ...obstacles.map((o) => o.bottom + gap), ...obstacles.map((o) => o.top - gap - size.h)].filter(
    (y) => y + size.h > ctl.top - HINT_REACH_PX && y < ctl.bottom + HINT_REACH_PX,
  )
  for (const side of order) {
    if (side === 'below') for (const x of xs) out.push({ left: x, top: ctl.bottom + gap, side })
    else if (side === 'above') for (const x of xs) out.push({ left: x, top: ctl.top - gap - size.h, side })
    else if (side === 'right') for (const y of ys) out.push({ left: ctl.right + gap, top: y, side })
    else for (const y of ys) out.push({ left: ctl.left - gap - size.w, top: y, side })
  }
  return out
}

/** The hint's place: the first candidate inside the window (`margin` from its edges) that covers no obstacle, else the
 *  one inside the window that covers the least; null when none fits the window at all. */
export function placeHint(ctl: Box, size: { w: number; h: number }, view: { w: number; h: number }, obstacles: readonly Box[], prefer: HintSide, margin = 8): HintPlace | null {
  let best: HintPlace | null = null
  for (const c of hintCandidates(ctl, size, obstacles, prefer)) {
    const b = hintBox(c.left, c.top, size)
    if (b.left < margin || b.top < margin || b.right > view.w - margin || b.bottom > view.h - margin) continue
    // the controls themselves count too: the hint never covers them
    const covered = [...obstacles, ctl].reduce((s, o) => s + overlap(b, o), 0)
    if (covered === 0) return { ...c, covered }
    if (!best || covered < best.covered) best = { ...c, covered }
  }
  return best
}
