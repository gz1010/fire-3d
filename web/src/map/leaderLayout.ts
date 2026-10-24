// Leader-line label layout (brief 4 decision e; HANDOFF "Map labels": hairline leaders from the feature to a two-line
// label). Pure and tested (leaderLayout.test.ts); map/LeaderLabels.tsx feeds it the overview's large named fires and
// draws the result, and the fire view (H4) may use the same pieces for its circle-to-point leader.
// Greedy: the items are placed in order (the caller sorts them, largest fire first); each takes the first candidate
// spot whose label box stays inside the free map, covers no chrome, no label already placed, no other marker and no
// leader already drawn, and whose own leader is no longer than `maxLen` and crosses no label or leader already placed,
// no other marker and no line obstacle (chrome, group counts; H3+H4 review DF-H34-2). Candidates, by where the fire lies in the
// free map: west of its first 30 % a right-aligned gutter column at the free map's left edge (the screen's west-coast
// column, sliding up and down to a free row), then the diagonals up-left / down-left / up-right / down-right at two
// lengths; elsewhere the diagonals to the right first (to the left first in the east). An item with no free spot is
// left out (its MapLibre label shows instead).

export interface Pt {
  x: number
  y: number
}

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Circle {
  x: number
  y: number
  r: number
  /** The marker's fire (its own label may touch it). */
  id?: string
}

export interface LeaderItem {
  id: string
  /** The marker centre (screen px). */
  at: Pt
  /** The marker radius (px). */
  r: number
  /** The label's size (px). */
  w: number
  h: number
}

export type LeaderSide = 'left' | 'right'
export type LeaderKind = 'diagonal' | 'gutter'

export interface LeaderSpot {
  id: string
  at: Pt
  /** Where the leader ends, beside the label's middle. */
  end: Pt
  box: Rect
  side: LeaderSide
  kind: LeaderKind
}

export interface LeaderOptions {
  /** The free map (the safe area). */
  free: Rect
  /** Chrome and other things a label must not cover. */
  obstacles?: readonly Rect[]
  /** Other markers (and groups) a label must not cover. */
  circles?: readonly Circle[]
  /** At most this many labels (decision e: 12). */
  max?: number
  /** Space kept around labels (px). */
  pad?: number
  /** Rectangles a leader line must not cross (chrome, the groups' "N FIRES"); place names may be crossed. */
  lineObstacles?: readonly Rect[]
  /** The longest leader (px; DF-H34-2: the screen's run 25-120 px). */
  maxLen?: number
}

export const LEADER_MAX = 12
/** Gap between a leader's end and its label's text (px). */
export const LEADER_GAP = 4
/** The diagonal lengths tried (px along x; y is 0.75 of it). */
export const DIAGONAL_RUNS = [30, 52, 80] as const
/** A gutter column is tried for fires within this share of the free map's width from its left edge. */
export const GUTTER_SHARE = 0.3
/** Rows tried above and below the fire's own height in the gutter column. */
export const GUTTER_STEPS = 6
/** How close a leader may pass another marker's or group's centre (px): its centre dot and a hair around it. */
export const LINE_CLEAR_PX = 4
/** The longest leader on a desktop map and on a phone's (px). */
export const LEADER_MAX_LEN = 140
export const LEADER_MAX_LEN_NARROW = 90

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

export function inflate(r: Rect, d: number): Rect {
  return { left: r.left - d, top: r.top - d, right: r.right + d, bottom: r.bottom + d }
}

export function inside(r: Rect, outer: Rect): boolean {
  return r.left >= outer.left && r.top >= outer.top && r.right <= outer.right && r.bottom <= outer.bottom
}

/** Does a circle touch a rectangle? */
export function circleHitsRect(c: Circle, r: Rect): boolean {
  const x = Math.max(r.left, Math.min(c.x, r.right))
  const y = Math.max(r.top, Math.min(c.y, r.bottom))
  return (c.x - x) ** 2 + (c.y - y) ** 2 < c.r * c.r
}

/** Does the segment a-b cross (or lie inside) the rectangle? (Liang–Barsky clipping.) */
export function segmentHitsRect(a: Pt, b: Pt, r: Rect): boolean {
  let t0 = 0
  let t1 = 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
    return true
  }
  return clip(-dx, a.x - r.left) && clip(dx, r.right - a.x) && clip(-dy, a.y - r.top) && clip(dy, r.bottom - a.y) && t0 <= t1
}

/** Do the segments a-b and c-d cross? (Touching at an end counts; collinear overlaps too.) */
export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const orient = (p: Pt, q: Pt, r: Pt) => {
    const v = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
    return Math.abs(v) < 1e-9 ? 0 : v > 0 ? 1 : -1
  }
  const onSeg = (p: Pt, q: Pt, r: Pt) => Math.min(p.x, r.x) - 1e-9 <= q.x && q.x <= Math.max(p.x, r.x) + 1e-9 && Math.min(p.y, r.y) - 1e-9 <= q.y && q.y <= Math.max(p.y, r.y) + 1e-9
  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)
  if (o1 !== o2 && o3 !== o4) return true
  return (o1 === 0 && onSeg(a, c, b)) || (o2 === 0 && onSeg(a, d, b)) || (o3 === 0 && onSeg(c, a, d)) || (o4 === 0 && onSeg(c, b, d))
}

/** Does the segment a-b pass within the circle? */
export function segmentHitsCircle(a: Pt, b: Pt, c: Circle): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2)) : 0
  const x = a.x + t * dx
  const y = a.y + t * dy
  return (c.x - x) ** 2 + (c.y - y) ** 2 < c.r * c.r
}

/** The label box for a leader ending at `end` on `side` (text after the gap, its middle on the leader's end). */
export function labelBox(end: Pt, size: { w: number; h: number }, side: LeaderSide): Rect {
  const left = side === 'right' ? end.x + LEADER_GAP : end.x - LEADER_GAP - size.w
  return { left, top: end.y - size.h / 2, right: left + size.w, bottom: end.y + size.h / 2 }
}

/** The candidate spots of one item, best first. `gutterX`: the right edge of the gutter column (null: none). */
export function leaderCandidates(item: LeaderItem, free: Rect, gutterX: number | null): Omit<LeaderSpot, 'id'>[] {
  const out: Omit<LeaderSpot, 'id'>[] = []
  const w = free.right - free.left
  const rel = w > 0 ? (item.at.x - free.left) / w : 0.5
  const diag = (sx: 1 | -1, sy: 1 | -1) => {
    for (const run of DIAGONAL_RUNS) {
      const len = run + item.r
      const end = { x: item.at.x + sx * len, y: item.at.y + sy * len * 0.75 }
      const side: LeaderSide = sx > 0 ? 'right' : 'left'
      out.push({ at: item.at, end, box: labelBox(end, item, side), side, kind: 'diagonal' })
    }
  }
  const gutter = () => {
    if (gutterX == null || item.at.x - gutterX < item.r + 16) return
    const step = item.h + 4
    for (let k = 0; k <= GUTTER_STEPS * 2; k++) {
      const dy = (k % 2 === 1 ? -1 : 1) * Math.ceil(k / 2) * step
      const end = { x: gutterX + LEADER_GAP, y: item.at.y + dy }
      // the text is right-aligned against the column's edge, the leader runs from the marker to it
      const box = { left: gutterX - item.w, top: end.y - item.h / 2, right: gutterX, bottom: end.y + item.h / 2 }
      out.push({ at: item.at, end, box, side: 'left', kind: 'gutter' })
    }
  }
  if (rel < GUTTER_SHARE) {
    gutter()
    diag(-1, -1)
    diag(-1, 1)
    diag(1, -1)
    diag(1, 1)
  } else if (rel > 1 - GUTTER_SHARE) {
    diag(-1, -1)
    diag(-1, 1)
    diag(1, -1)
    diag(1, 1)
  } else {
    diag(1, -1)
    diag(1, 1)
    diag(-1, -1)
    diag(-1, 1)
  }
  return out
}

/** The right edge of the gutter column: the free map's left edge plus the widest label of the items in its western
 *  share, at most a third of the free map. */
export function gutterEdge(items: readonly LeaderItem[], free: Rect, margin = 8): number | null {
  const w = free.right - free.left
  const west = items.filter((i) => i.at.x < free.left + GUTTER_SHARE * w)
  if (!west.length) return null
  const widest = Math.max(...west.map((i) => i.w))
  const x = free.left + margin + widest
  return x <= free.left + w / 3 ? x : null
}

/** Place the items (in the given order); see the header. */
export function layoutLeaders(items: readonly LeaderItem[], o: LeaderOptions): LeaderSpot[] {
  const pad = o.pad ?? 4
  const max = o.max ?? LEADER_MAX
  const maxLen = o.maxLen ?? LEADER_MAX_LEN
  const free = inflate(o.free, -4)
  const obstacles = o.obstacles ?? []
  const lineObstacles = o.lineObstacles ?? []
  const circles = o.circles ?? []
  const gx = gutterEdge(items, o.free)
  const placed: LeaderSpot[] = []
  for (const item of items) {
    if (placed.length >= max) break
    if (!(item.at.x >= o.free.left && item.at.x <= o.free.right && item.at.y >= o.free.top && item.at.y <= o.free.bottom)) continue
    // the other markers and group centres a leader must not run over (its own marker is where it starts)
    const others = circles.filter((m) => !(m.id === item.id || (Math.abs(m.x - item.at.x) < 0.5 && Math.abs(m.y - item.at.y) < 0.5)))
    for (const c of leaderCandidates(item, o.free, gx)) {
      const box = c.box
      const padded = inflate(box, pad)
      // a short leader: a long diagonal across the map reads as pointing at another fire
      if (Math.hypot(c.end.x - c.at.x, c.end.y - c.at.y) - item.r > maxLen) continue
      if (!inside(box, free)) continue
      if (obstacles.some((r) => rectsOverlap(padded, r))) continue
      if (placed.some((p) => rectsOverlap(padded, p.box) || segmentHitsRect(p.at, p.end, padded))) continue
      if (placed.some((p) => segmentHitsRect(c.at, c.end, inflate(p.box, 2)))) continue
      // leaders never cross each other (the gutter's rows keep the markers' order)
      if (placed.some((p) => segmentsCross(c.at, c.end, p.at, p.end))) continue
      // the leader runs over no other marker's centre dot or group centre (a thin ring may be crossed, as the screen's
      // are), no chrome and no group count
      if (others.some((m) => segmentHitsCircle(c.at, c.end, { ...m, r: Math.min(m.r, LINE_CLEAR_PX) }))) continue
      if (lineObstacles.some((r) => segmentHitsRect(c.at, c.end, r))) continue
      // other markers (and this one's own circle) stay uncovered
      if (circles.some((m) => circleHitsRect({ ...m, r: m.r + 1 }, box))) continue
      if (circleHitsRect({ x: item.at.x, y: item.at.y, r: item.r + 2 }, box)) continue
      placed.push({ id: item.id, ...c })
      break
    }
  }
  return placed
}

/** The basemap's place-name layers (the names a label should not sit on): every symbol layer of the OpenMapTiles
 *  "place" and "water_name" source layers in the current style, so the aerial style's label_city / label_town and the
 *  dark style's place_city / place_town / place_country_* are all covered (review DF-H34-5). */
export function placeLabelLayers(layers: readonly { id: string; type: string; 'source-layer'?: string }[]): string[] {
  return layers.filter((l) => l.type === 'symbol' && (l['source-layer'] === 'place' || l['source-layer'] === 'water_name')).map((l) => l.id)
}

/** "172,912 AC" (or "70,000 HA"): the label's second line. */
export function leaderAcres(acres: number, units: 'us' | 'metric'): string {
  const v = units === 'metric' ? acres * 0.40468564224 : acres
  return `${Math.round(v).toLocaleString('en-US')} ${units === 'metric' ? 'HA' : 'AC'}`
}
