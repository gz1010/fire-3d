// Tiny toast queue ("Link copied", "Forecast ready", errors). Rendered by <Toasts/> in ui/Overlays.tsx.
import { create } from 'zustand'

export type ToastTone = 'info' | 'ok' | 'warn' | 'error'

export interface Toast {
  id: number
  text: string
  tone: ToastTone
}

interface ToastState {
  toasts: Toast[]
  dismiss: (id: number) => void
}

let nextId = 1

export const useToasts = create<ToastState>()((set) => ({
  toasts: [],
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

/** Show a toast for `ms` milliseconds (max 4 visible). */
export function toast(text: string, tone: ToastTone = 'info', ms = 3200): void {
  const id = nextId++
  useToasts.setState((s) => ({ toasts: [...s.toasts.filter((t) => t.text !== text), { id, text, tone }].slice(-4) }))
  window.setTimeout(() => useToasts.getState().dismiss(id), ms)
}
