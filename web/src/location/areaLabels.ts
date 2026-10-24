// Placement of Command's two map labels with leaders (brief 4, CommandView.dc.html: "Observed fire" and "Modeled
// spread"; PLAN-4 §3.2). Pure screen geometry, tested in areaLabels.test.ts: pick an anchor on the drawn outline, then
// a hairline leader (a diagonal, then a short horizontal run) to a two-line label, mirrored to the left when the right
// side does not fit, dropped when neither side fits inside the free map or it would cover another label.

export interface Pt {
  x: number
  y: number
}

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export interface LeaderPlan {
  anchor: Pt
  elbow: Pt
  end: Pt
  /** Which side of the leader the text sits on. */
  side: 'right' | 'left'
  /** The label's box (screen px). */
  box: Box
}

/** The leader's shape: `dx`, `dy` of the diagonal (dy < 0 goes up), then a horizontal run of `run` px. */
export interface LeaderShape {
  dx: number
  dy: number
  run: number
}

/** The label's first line sits above the run, its second line below it (the screen's two-line labels). */
const ABOVE = 16
const BELOW = 15
const GAP = 4

const inside = (p: Pt, a: Box) => p.x >= a.left && p.x <= a.right && p.y >= a.top && p.y <= a.bottom
const contains = (outer: Box, b: Box) => b.left >= outer.left && b.right <= outer.right && b.top >= outer.top && b.bottom <= outer.bottom
export const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** The point of `points` inside `area` that scores highest (null when none is inside). */
export function pickAnchor(points: readonly Pt[], area: Box, score: (p: Pt) => number): Pt | null {
  let best: Pt | null = null
  let bestScore = -Infinity
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !inside(p, area)) continue
    const s = score(p)
    if (s > bestScore) {
      best = p
      bestScore = s
    }
  }
  return best
}

function plan(anchor: Pt, w: number, shape: LeaderShape, side: 'right' | 'left'): LeaderPlan {
  const sx = side === 'right' ? 1 : -1
  const elbow = { x: anchor.x + sx * shape.dx, y: anchor.y + shape.dy }
  const end = { x: elbow.x + sx * shape.run, y: elbow.y }
  const left = side === 'right' ? end.x + GAP : end.x - GAP - w
  return { anchor, elbow, end, side, box: { left, right: left + w, top: end.y - ABOVE, bottom: end.y + BELOW } }
}

/** The leader and label for `anchor`: on the right when its box fits inside `area` and covers none of `avoid`, else
 *  mirrored to the left, else null. `w` is the label's width (px). */
export function placeLeader(anchor: Pt, w: number, shape: LeaderShape, area: Box, avoid: readonly Box[] = []): LeaderPlan | null {
  for (const side of ['right', 'left'] as const) {
    const p = plan(anchor, w, shape, side)
    if (contains(area, p.box) && !avoid.some((b) => overlaps(b, p.box))) return p
  }
  return null
}

/** The outline points inside `area`, best score first, at least `spacing` px apart (the candidates to anchor on). */
export function rankAnchors(points: readonly Pt[], area: Box, score: (p: Pt) => number, max = 12, spacing = 28): Pt[] {
  const scored = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && inside(p, area)).map((p) => ({ p, s: score(p) }))
  scored.sort((a, b) => b.s - a.s)
  const out: Pt[] = []
  for (const { p } of scored) {
    if (out.length >= max) break
    if (out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < spacing)) continue
    out.push(p)
  }
  return out
}

/** The first placement that fits: the anchors in order (best first), each with the shapes in order (each on the right,
 *  then mirrored left). Null when none fits inside `area` without covering `avoid`. */
export function placeAlong(anchors: readonly Pt[], w: number, shapes: readonly LeaderShape[], area: Box, avoid: readonly Box[] = []): LeaderPlan | null {
  for (const a of anchors)
    for (const shape of shapes) {
      const p = placeLeader(a, w, shape, area, avoid)
      if (p) return p
    }
  return null
}

/** Rough width (px) of a two-line label: the name in Inter 13 px, the meta in mono 10.5 px (uppercase). */
export function labelWidth(name: string, meta: string): number {
  return Math.ceil(Math.max(name.length * 7.4, meta.length * 7.0)) + 4
}
