// Where the search popover is on screen (owner: location). The search box publishes its popover's box while it is
// open; the location card moves out of its way (desktop: pushed down; phones: the bottom sheet gets shorter), so a
// message or result list never covers the card's title or close button (civilian audit G3). Memory only.
import { create } from 'zustand'

export interface PopoverBox {
  /** Viewport px. */
  top: number
  bottom: number
}

interface SearchUi {
  popover: PopoverBox | null
  setPopover: (box: PopoverBox | null) => void
}

export const useSearchUi = create<SearchUi>()((set) => ({
  popover: null,
  setPopover: (box) =>
    set((s) => {
      const a = s.popover
      if (a === box || (a && box && Math.abs(a.top - box.top) < 0.5 && Math.abs(a.bottom - box.bottom) < 0.5)) return s
      return { popover: box ? { ...box } : null }
    }),
}))

/** How the card yields to an open popover. Desktop (the card sits below the search box): push it down by the
 *  overlap. Phones (the card is a bottom sheet): cap its height so it ends below the popover, hide it when less than
 *  `minPx` would remain. `slot` is the card slot's box (viewport px), `naturalPx` the card's full content height. */
export function cardYield(
  popover: PopoverBox | null,
  slot: { top: number; bottom: number } | null,
  naturalPx: number,
  sheet: boolean,
  gapPx = 8,
  minPx = 96,
): { marginTop: number } | { maxHeight: number } | { hidden: true } | null {
  if (!popover || !slot) return null
  if (!sheet) {
    const overlap = popover.bottom + gapPx - slot.top
    return overlap > 0 ? { marginTop: Math.ceil(overlap) } : null
  }
  const room = Math.floor(slot.bottom - popover.bottom - gapPx)
  if (naturalPx <= room) return null
  return room < minPx ? { hidden: true } : { maxHeight: room }
}
