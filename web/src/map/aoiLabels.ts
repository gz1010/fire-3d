// Which "Outside modeled area" labels the map draws (brief 4 review DF-14). MapLibre places them at the midpoint of
// each side of the modeled area (overlayModel.ts aoiFeatures); where that puts one under the chrome (Command's
// readout or "Official now" column, whose text sits on edge gradients), it showed through next to the column's text.
// Pure screen geometry, tested in aoiLabels.test.ts: the controller projects the four anchors after the map settles and
// filters the layer to the sides whose label box stays inside the free map area (the safe area).
import { overflowPx, type ScreenBox } from './pinLabel'

export type AoiSide = 'n' | 's' | 'w' | 'e'

/** The label's box around its anchor, as layers.ts lays it out: text-anchor bottom / top / right / left for n / s / w /
 *  e with a 0.4 / 0.6 em offset, on two lines ("Outside" / "modeled area"; MapLibre wraps at 10 em). `size` = text-size
 *  in px; the width is an estimate for Noto Sans (≈ 12 characters × 0.62 em), rounded up. */
export function aoiLabelBox(side: AoiSide, x: number, y: number, size: number): ScreenBox {
  const w = Math.ceil(size * 7.6)
  const h = Math.ceil(size * 2.5)
  switch (side) {
    case 'n':
      return { left: x - w / 2, right: x + w / 2, top: y - 0.4 * size - h, bottom: y - 0.4 * size }
    case 's':
      return { left: x - w / 2, right: x + w / 2, top: y + 0.4 * size, bottom: y + 0.4 * size + h }
    case 'w':
      return { left: x - 0.6 * size - w, right: x - 0.6 * size, top: y - h / 2, bottom: y + h / 2 }
    default:
      return { left: x + 0.6 * size, right: x + 0.6 * size + w, top: y - h / 2, bottom: y + h / 2 }
  }
}

/** The sides whose label stays inside `free` (screen px of the map container); a label whose anchor is not on screen
 *  (null) is left to MapLibre (it is not drawn there anyway). */
export function aoiSidesInside(anchors: readonly { side: AoiSide; x: number; y: number }[], free: ScreenBox, size: number): AoiSide[] {
  return anchors.filter((a) => !Number.isFinite(a.x) || !Number.isFinite(a.y) || overflowPx(aoiLabelBox(a.side, a.x, a.y, size), free) === 0).map((a) => a.side)
}
