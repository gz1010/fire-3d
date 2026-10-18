// Shared JSON query cache for the optional and official sources (owner: official-web; CONTRACT §13, BRIEF-2
// decision 10: zooming in and out switches the open fire often). One entry per URL (the URL names the fire, area and
// time), shared by every hook that asks for it:
// - re-focusing a fire shows its last answer at once (no "loading" flash) and refetches only when that answer is
//   older than the source's cadence;
// - a request nobody needs any more (the fire changed before it answered) is aborted, and a late answer for another
//   URL can never be shown, because readers look answers up by their own URL;
// - concurrent readers of one URL share one request; a refresh keeps the previous answer meanwhile.
// The cache is in memory only (bounded LRU) and never persists anything.
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { fetchJson } from '../api/client'
import { requestErrorText } from './format'

export interface QueryEntry<T> {
  data: T | null
  error: string | null
  /** When `data` was stored (epoch ms); 0 = never. */
  storedMs: number
  loading: boolean
}

interface Slot {
  entry: QueryEntry<unknown>
  ctrl: AbortController | null
  /** Mounted readers of this URL. */
  users: number
}

export const MAX_ENTRIES = 64
const slots = new Map<string, Slot>()
const listeners = new Set<() => void>()
const EMPTY: QueryEntry<never> = { data: null, error: null, storedMs: 0, loading: false }

function emit(): void {
  for (const l of [...listeners]) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

function slot(url: string): Slot {
  let s = slots.get(url)
  if (!s) {
    s = { entry: EMPTY, ctrl: null, users: 0 }
    slots.set(url, s)
    trim()
  }
  return s
}

/** Drop the least recently stored unused entries beyond MAX_ENTRIES (Map order = insertion; refreshed on store). */
function trim(): void {
  if (slots.size <= MAX_ENTRIES) return
  for (const [url, s] of slots) {
    if (slots.size <= MAX_ENTRIES) break
    if (s.users === 0 && !s.entry.loading) slots.delete(url)
  }
}

function setEntry(url: string, s: Slot, patch: Partial<QueryEntry<unknown>>): void {
  s.entry = { ...s.entry, ...patch }
  if (patch.storedMs != null) {
    // most recently stored last (LRU order), then trim the oldest unused entries
    slots.delete(url)
    slots.set(url, s)
    trim()
  }
  emit()
}

/** Whether a reader should start a request: never while one is running; on a forced refresh unless an answer was
 *  stored in the last few seconds (another reader just refreshed); otherwise when there is no answer or it is older
 *  than `freshMs`. */
export function shouldFetch(e: Pick<QueryEntry<unknown>, 'loading' | 'storedMs'>, nowMs: number, freshMs: number, force: boolean): boolean {
  if (e.loading) return false
  if (force) return nowMs - e.storedMs > 5_000
  return e.storedMs === 0 || nowMs - e.storedMs >= freshMs
}

/** Start a request for `url` unless one is running or the stored answer is fresh (see shouldFetch). */
export function loadQuery(url: string, opts: { force: boolean; freshMs: number; timeoutMs: number }): void {
  const s = slot(url)
  if (!shouldFetch(s.entry, Date.now(), opts.freshMs, opts.force)) return
  const ctrl = new AbortController()
  s.ctrl = ctrl
  setEntry(url, s, { loading: true })
  fetchJson<unknown>(url, { signal: ctrl.signal, timeoutMs: opts.timeoutMs })
    .then((data) => {
      if (s.ctrl !== ctrl) return
      s.ctrl = null
      setEntry(url, s, { data, error: null, loading: false, storedMs: Date.now() })
    })
    .catch((e: unknown) => {
      if (s.ctrl !== ctrl) return
      s.ctrl = null
      // keep the previous answer for the same URL; report the failure next to it (an abort is not a failure)
      setEntry(url, s, { loading: false, error: ctrl.signal.aborted ? s.entry.error : requestErrorText(e) })
    })
}

/** A reader of `url` mounted. */
export function retainQuery(url: string): void {
  slot(url).users++
}

/** A reader is gone: abort its request when no other reader needs it (the fire changed before it answered). */
export function releaseQuery(url: string): void {
  const s = slots.get(url)
  if (!s) return
  s.users = Math.max(0, s.users - 1)
  if (s.users === 0 && s.ctrl) {
    const c = s.ctrl
    s.ctrl = null
    c.abort()
    setEntry(url, s, { loading: false })
  }
}

/** The cached entry of a URL (tests, non-React readers). */
export function peekQuery<T>(url: string): QueryEntry<T> | undefined {
  return slots.get(url)?.entry as QueryEntry<T> | undefined
}

/** Forget everything (tests; leaving the app). Running requests are aborted. */
export function clearQueryCache(): void {
  for (const s of slots.values()) s.ctrl?.abort()
  slots.clear()
  emit()
}

export interface CachedQueryState<T> {
  data: T | null
  loading: boolean
  error: string | null
  /** Refetch now (keeps the current answer meanwhile). */
  refresh: () => void
}

/**
 * `url` null = idle. `refreshMs`: the source's cadence: a cached answer younger than it is reused as is, and while
 * `isCurrent(data)` (a current-status answer, not an archived one) it is refetched on that cadence; 0 = no refresh.
 */
export function useCachedJsonQuery<T>(url: string | null, opts: { refreshMs: number; timeoutMs?: number; isCurrent?: (data: T) => boolean }): CachedQueryState<T> {
  const { refreshMs, timeoutMs = 30_000, isCurrent } = opts
  const freshMs = Math.max(refreshMs, 60_000)
  const entry = useSyncExternalStore(subscribe, () => (url ? ((slots.get(url)?.entry as QueryEntry<T> | undefined) ?? EMPTY) : EMPTY))

  useEffect(() => {
    if (!url) return
    retainQuery(url)
    loadQuery(url, { force: false, freshMs, timeoutMs })
    return () => releaseQuery(url)
  }, [url, freshMs, timeoutMs])

  const refresh = useCallback(() => {
    if (url) loadQuery(url, { force: true, freshMs, timeoutMs })
  }, [url, freshMs, timeoutMs])

  const current = entry.data != null && (isCurrent ? isCurrent(entry.data) : true)
  useEffect(() => {
    if (!url || !current || refreshMs <= 0) return
    const id = window.setInterval(refresh, refreshMs)
    return () => window.clearInterval(id)
  }, [url, current, refreshMs, refresh])

  return { data: entry.data, loading: url != null && (entry.loading || (entry.storedMs === 0 && entry.error == null)), error: entry.error, refresh }
}
