// Where the selected point's label goes around its dot (brief 4; map/markers.ts SelectionPin). Pure, tested
// (pinLabel.test.ts). The screens put it up and to the right; it takes another corner, with the leader mirrored, when
// that one would leave the free map area (the part the chrome leaves open: the safe area) or cover another label, and
// stacks the coordinates on two lines when no one-line corner fits (a narrow free area: Command at 1024 px, phones).

/** Where the label goes around the dot, in order of preference (the screens' up-right first). */
export type PinSide = 'up-right' | 'up-left' | 'down-right' | 'down-left'
export const PIN_SIDES: readonly PinSide[] = ['up-right', 'up-left', 'down-right', 'down-left']

export interface ScreenBox {
  left: number
  top: number
  right: number
  bottom: number
}

/** Leader geometry (CSS px from the dot's centre): the label box starts 42 px to the side; its first line is centred on
 *  the leader's end, 23 px above (or below) the dot. Matches map.css .fxm-pin-chip. */
const LABEL_DX = 42
const LABEL_UP_TOP = -32
const LABEL_DOWN_TOP = 15

/** The label's box on screen for one side, given the dot's screen position and the label's size. */
export function pinLabelBox(x: number, y: number, w: number, h: number, side: PinSide): ScreenBox {
  const left = side.endsWith('right') ? x + LABEL_DX : x - LABEL_DX - w
  const top = side.startsWith('up') ? y + LABEL_UP_TOP : y + LABEL_DOWN_TOP
  return { left, top, right: left + w, bottom: top + h }
}

/** Pixels of `b` outside `free`, summed over the four edges. */
export function overflowPx(b: ScreenBox, free: ScreenBox): number {
  return Math.max(0, free.left - b.left) + Math.max(0, b.right - free.right) + Math.max(0, free.top - b.top) + Math.max(0, b.bottom - free.bottom)
}

/** Costs: each pixel under the chrome (its text sits right there), covering another label's text, covering a dot. A
 *  label covering text costs as much as running ~13 px under the chrome; a dot only as much as 5 px. */
export const OVERFLOW_COST_PER_PX = 3
export const COVERS_TEXT_COST = 40
export const COVERS_POINT_COST = 15
/** Each pixel past the map's own edge (cut off by the screen, not just under the chrome) costs this much on top. */
export const OFFSCREEN_COST_PER_PX = 10
/** The stacked label (latitude, longitude and "SELECTED" on three lines) is narrower but taller; it costs this much on
 *  top, so the one-line label wins whenever it fits as well. */
export const STACKED_COST = 8

export interface PinLayout {
  side: PinSide
  /** coordinates on two lines (a narrow free area: Command at 1024 px, phones) */
  stacked: boolean
}

/** Where the selection label goes: the cheapest corner, one-line or stacked, by `OVERFLOW_COST_PER_PX` × the pixels
 *  outside the free map area, `OFFSCREEN_COST_PER_PX` × the pixels outside the map itself (`view`), `covers(box,
 *  side)` (what it would hide: COVERS_TEXT_COST, COVERS_POINT_COST or their sum) and `STACKED_COST` for the stacked
 *  label (`sizes.stacked`; null when the label cannot stack, as an address). Ties keep the current layout (no flip-flop
 *  while panning), else the preference order (one-line corners first). */
export function pinLabelLayout(
  dot: { x: number; y: number },
  sizes: { wide: { w: number; h: number }; stacked?: { w: number; h: number } | null },
  free: ScreenBox,
  current: PinLayout,
  covers: (box: ScreenBox, side: PinSide) => number = () => 0,
  view: ScreenBox | null = null,
): PinLayout {
  const options: PinLayout[] = [
    ...PIN_SIDES.map((side) => ({ side, stacked: false })),
    ...(sizes.stacked ? PIN_SIDES.map((side) => ({ side, stacked: true })) : []),
  ]
  const cost = (o: PinLayout) => {
    const size = o.stacked && sizes.stacked ? sizes.stacked : sizes.wide
    const b = pinLabelBox(dot.x, dot.y, size.w, size.h, o.side)
    return OVERFLOW_COST_PER_PX * overflowPx(b, free) + (view ? OFFSCREEN_COST_PER_PX * overflowPx(b, view) : 0) + covers(b, o.side) + (o.stacked ? STACKED_COST : 0)
  }
  const costs = options.map((o) => cost(o))
  const best = Math.min(...costs)
  const cur = options.findIndex((o) => o.side === current.side && o.stacked === current.stacked)
  if (cur >= 0 && costs[cur] <= best) return current
  return options[costs.indexOf(best)] ?? current
}

/** The corner alone for a one-line label (pinLabelLayout without stacking or the map's edge). */
export function pinLabelSide(
  dot: { x: number; y: number },
  size: { w: number; h: number },
  free: ScreenBox,
  current: PinSide,
  covers: (box: ScreenBox, side: PinSide) => number = () => 0,
): PinSide {
  return pinLabelLayout(dot, { wide: size }, free, { side: current, stacked: false }, covers).side
}
