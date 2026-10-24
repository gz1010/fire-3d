// Where the search popover is on screen (owner: location). The search box publishes its popover's box while it is
// open; the location card moves out of its way (desktop: pushed down; phones: the bottom sheet gets shorter), so a
// message or result list never covers the card's title or close button (civilian audit G3). Memory only.
// Brief 4 (review H2-m2): the map chromes each mount their own search box, and opening or closing a fire swaps the
// chrome. When a fire opens or closes or the preset changes, a box with a message or a result list open hands its
// text and popover over (`carry`); the box the next chrome mounts right after takes them (within CARRY_MS), so
// "Showing Monterey, CA. To check a spot, …" survives the fire closing behind a town search.
import { create } from 'zustand'
import type { Popover } from './search'

/** What a search box hands to the next one: its text and an open message or result list. */
export interface SearchCarry {
  text: string
  popover: Extract<Popover, { kind: 'message' } | { kind: 'results' }>
  atMs: number
}

/** A chrome swap mounts the next box at once; a later mount (Command's popover opened again) starts fresh. */
export const CARRY_MS = 1500

/** The carried state for a box mounting at `nowMs` (null when none or stale). Pure. */
export function freshCarry(c: SearchCarry | null, nowMs: number): SearchCarry | null {
  return c && nowMs - c.atMs >= 0 && nowMs - c.atMs <= CARRY_MS ? c : null
}

export interface PopoverBox {
  /** Viewport px. */
  top: number
  bottom: number
}

interface SearchUi {
  popover: PopoverBox | null
  setPopover: (box: PopoverBox | null) => void
  /** Brief 4, Command: the search sits behind the top bar's "Check an address" button (location/CommandSearch.tsx);
   *  true while its popover is open. Other layouts show the box all the time and ignore it. */
  searchOpen: boolean
  setSearchOpen: (open: boolean) => void
  /** Handed over between search boxes across a chrome swap (see the header). */
  carry: SearchCarry | null
  setCarry: (c: SearchCarry | null) => void
}

export const useSearchUi = create<SearchUi>()((set) => ({
  carry: null,
  setCarry: (carry) => set({ carry }),
  searchOpen: false,
  setSearchOpen: (open) => set((s) => (s.searchOpen === open ? s : { searchOpen: open })),
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

/** Phones: how far (px) the map controls slide down so the search message or result list above them stays readable
 *  (W15, audit G12a; 0 when nothing overlaps). `controlsTop` is the controls' own top in viewport px, before the
 *  shift. The controls slide with a transform, so the safe area and the map framing do not change with it. */
export function controlsShift(popover: PopoverBox | null, controlsTop: number, gapPx = 6): number {
  if (!popover) return 0
  const overlap = popover.bottom + gapPx - controlsTop
  return overlap > 0 ? Math.ceil(overlap) : 0
}
