// Where the selected point's label goes around its dot (brief 4; map/markers.ts SelectionPin). Pure, tested
// (pinLabel.test.ts). The screens put it up and to the right; it takes another corner, with the leader mirrored, when
// that one would leave the free map area (the part the chrome leaves open: the safe area) or cover another label.

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

/** Which corner the selection label takes: the cheapest by `OVERFLOW_COST_PER_PX` × the pixels outside the free map area
 *  plus `covers(box, side)` (what it would hide: COVERS_TEXT_COST, COVERS_POINT_COST or their sum). Ties keep the
 *  current corner (no flip-flop while panning), else the preference order. */
export function pinLabelSide(
  dot: { x: number; y: number },
  size: { w: number; h: number },
  free: ScreenBox,
  current: PinSide,
  covers: (box: ScreenBox, side: PinSide) => number = () => 0,
): PinSide {
  const cost = (side: PinSide) => {
    const b = pinLabelBox(dot.x, dot.y, size.w, size.h, side)
    return OVERFLOW_COST_PER_PX * overflowPx(b, free) + covers(b, side)
  }
  const costs = new Map(PIN_SIDES.map((s) => [s, cost(s)] as const))
  const best = Math.min(...costs.values())
  if ((costs.get(current) ?? Infinity) <= best) return current
  return PIN_SIDES.find((s) => costs.get(s) === best) ?? current
}
