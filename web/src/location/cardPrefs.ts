// Location card display preferences (owner: location). Whether the details disclosure is open, per preset, so a
// user who opens it keeps it open for the next point. Memory only (session); never written to the URL or storage.
import { create } from 'zustand'
import type { Preset } from '../state/workspace'

interface CardPrefs {
  detailsOpen: Record<Preset, boolean>
  setDetailsOpen: (preset: Preset, open: boolean) => void
}

export const useCardPrefs = create<CardPrefs>()((set) => ({
  // collapsed by default in both presets: the summary keeps the map visible (BRIEF §6)
  detailsOpen: { public: false, command: false },
  setDetailsOpen: (preset, open) => set((s) => (s.detailsOpen[preset] === open ? s : { detailsOpen: { ...s.detailsOpen, [preset]: open } })),
}))
