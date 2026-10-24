// Placement of Command's two map labels with leaders (brief 4, CommandView.dc.html: "Observed fire" and "Modeled
// spread"; PLAN-4 §3.2). Pure screen geometry, tested in areaLabels.test.ts: pick an anchor on the drawn outline, then
// a hairline leader (a diagonal, then a short horizontal run) to a two-line label, mirrored to the left when the right
// side does not fit, dropped when neither side fits inside the free map or it would cover another label.
import { fmtNumber } from '../lib/format'
import { HA_PER_ACRE } from '../lib/plainLanguage'
import { interpAt } from '../state/selectors'
import type { Units } from '../state/workspace'

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

/** Something else on the map a label must not cover, tested per candidate box (Command: the map's own labels and points
 *  as MapLibre placed them, queryRenderedFeatures). */
export type Blocked = (box: Box) => boolean

/** The leader and label for `anchor`: on the right when its box fits inside `area`, covers none of `avoid` and is not
 *  `blocked`, else mirrored to the left, else null. `w` is the label's width (px). */
export function placeLeader(anchor: Pt, w: number, shape: LeaderShape, area: Box, avoid: readonly Box[] = [], blocked?: Blocked): LeaderPlan | null {
  for (const side of ['right', 'left'] as const) {
    const p = plan(anchor, w, shape, side)
    if (contains(area, p.box) && !avoid.some((b) => overlaps(b, p.box)) && !blocked?.(p.box)) return p
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
 *  then mirrored left). Null (the label is dropped) when none fits inside `area` without covering `avoid` or a
 *  `blocked` box. */
export function placeAlong(anchors: readonly Pt[], w: number, shapes: readonly LeaderShape[], area: Box, avoid: readonly Box[] = [], blocked?: Blocked): LeaderPlan | null {
  for (const a of anchors)
    for (const shape of shapes) {
      const p = placeLeader(a, w, shape, area, avoid, blocked)
      if (p) return p
    }
  return null
}

/** Rough width (px) of a two-line label: the name in Inter 13 px, the meta in mono 10.5 px (uppercase). */
export function labelWidth(name: string, meta: string): number {
  return Math.ceil(Math.max(name.length * 7.4, meta.length * 7.0)) + 4
}

/** Within this of the latest observation the timeline is "at" it (the timeline's own tolerance). */
const AT_LATEST_MS = 60_000

/** The "Observed fire" label's meta line (review H2-B1, DF-16): the reconstructed area ("≈6,875 ac": an estimate from
 *  satellite detections and mapped perimeters) and the time it shows. That time is the timeline's while it is at or
 *  before the latest observation; past it (the forecast part, a live fire's NOW) the map still shows the latest
 *  observation, so the label says "Latest · <its time>" and never carries a forecast or future time. */
export function observedLabelMeta(
  timeMs: number,
  latestMs: number | null,
  acres: (ms: number) => number | null,
  units: Units,
  fmt: (ms: number) => string,
): string {
  const past = latestMs != null && timeMs > latestMs + AT_LATEST_MS
  const at = past && latestMs != null ? latestMs : timeMs
  const a = acres(at)
  const area = a != null && Number.isFinite(a) && a > 0 ? (units === 'metric' ? `≈${fmtNumber(a * HA_PER_ACRE)} ha` : `≈${fmtNumber(a)} ac`) : null
  return [area, `${past ? 'Latest · ' : ''}${fmt(at)}`].filter((x) => x != null).join(' · ')
}

/** The reconstructed burned area (acres) at `ms` from the incident's hourly series (the Analysis "Fire Area" line):
 *  interpolated inside the series, else its last value when `ms` is at most one step (`maxGapMs`) after it (the
 *  series' last hour can sit just before the latest observation). Null otherwise. */
export function seriesAcresAt(series: { t_ms: ArrayLike<number>; area_acres: ArrayLike<number> } | null, ms: number, maxGapMs = 3_600_000): number | null {
  if (!series) return null
  const v = interpAt(series.t_ms, series.area_acres, ms)
  if (v != null) return v
  const n = Math.min(series.t_ms.length, series.area_acres.length)
  if (n === 0) return null
  const lastT = series.t_ms[n - 1]
  const last = series.area_acres[n - 1]
  return ms > lastT && ms - lastT <= maxGapMs && Number.isFinite(last) ? last : null
}
