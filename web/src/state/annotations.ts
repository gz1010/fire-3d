// Per-incident user annotations ("+ Add" in Key Events) and notes (Notes tab), kept in localStorage.
// Every storage access is guarded: private windows / blocked storage simply fall back to in-memory state.
import { create } from 'zustand'

export interface Annotation {
  id: string
  t_ms: number
  title: string
  detail?: string
  x?: number
  z?: number
  created_ms: number
}

const ANN_KEY = (id: string) => `fire3d:annotations:${id}`
const NOTES_KEY = (id: string) => `fire3d:notes:${id}`

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStorage(key: string, value: string | null): boolean {
  try {
    if (value == null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function parseAnnotations(raw: string | null): Annotation[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    return v
      .filter((a): a is Annotation => typeof a === 'object' && a != null && typeof (a as Annotation).id === 'string' && Number.isFinite((a as Annotation).t_ms))
      .map((a) => ({ ...a, title: String(a.title ?? 'Note') }))
  } catch {
    return []
  }
}

interface AnnotationsState {
  byIncident: Record<string, Annotation[]>
  ensure: (incidentId: string) => Annotation[]
  add: (incidentId: string, a: Omit<Annotation, 'id' | 'created_ms'>) => Annotation
  update: (incidentId: string, id: string, patch: Partial<Pick<Annotation, 'title' | 'detail' | 't_ms'>>) => void
  remove: (incidentId: string, id: string) => void
}

export const useAnnotations = create<AnnotationsState>()((set, get) => {
  const save = (incidentId: string, list: Annotation[]) => {
    writeStorage(ANN_KEY(incidentId), list.length ? JSON.stringify(list) : null)
    set((s) => ({ byIncident: { ...s.byIncident, [incidentId]: list } }))
  }
  return {
    byIncident: {},
    ensure: (incidentId) => {
      const have = get().byIncident[incidentId]
      if (have) return have
      const list = parseAnnotations(readStorage(ANN_KEY(incidentId)))
      set((s) => ({ byIncident: { ...s.byIncident, [incidentId]: list } }))
      return list
    },
    add: (incidentId, a) => {
      const ann: Annotation = { ...a, id: `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, created_ms: Date.now() }
      const list = [...get().ensure(incidentId), ann].sort((p, q) => p.t_ms - q.t_ms)
      save(incidentId, list)
      return ann
    },
    update: (incidentId, id, patch) => {
      const list = get()
        .ensure(incidentId)
        .map((x) => (x.id === id ? { ...x, ...patch } : x))
        .sort((p, q) => p.t_ms - q.t_ms)
      save(incidentId, list)
    },
    remove: (incidentId, id) => save(incidentId, get().ensure(incidentId).filter((x) => x.id !== id)),
  }
})

const EMPTY: Annotation[] = []

/** Annotations of an incident (loaded from storage on first use). */
export function useIncidentAnnotations(incidentId: string | null): Annotation[] {
  const list = useAnnotations((s) => (incidentId ? s.byIncident[incidentId] : undefined))
  if (incidentId && list === undefined) queueMicrotask(() => useAnnotations.getState().ensure(incidentId))
  return list ?? EMPTY
}

export function loadNotes(incidentId: string): string {
  return readStorage(NOTES_KEY(incidentId)) ?? ''
}

export function saveNotes(incidentId: string, text: string): boolean {
  return writeStorage(NOTES_KEY(incidentId), text.trim() ? text : null)
}
