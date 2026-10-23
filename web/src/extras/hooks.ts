// React hooks for the optional sources (owner: official-web since brief 2, earlier optional-sources). Each hook reads
// the shared per-URL cache (jsonQuery.ts; quantised `at_ms` values from `extrasAtMs` avoid refetching during
// playback): a URL answered recently is shown at once, the previous answer stays while refreshing, current answers
// refresh on the source's cadence, and a request nobody reads any more is aborted.
import { useCallback, useEffect, useRef, useState } from 'react'
import { extrasUrl, fetchCameraFrame, type AreaQuery, type ExtrasKind, type ImageryQuery } from './client'
import { requestErrorText } from './format'
import { useCachedJsonQuery } from './jsonQuery'
import type { CameraFrameResponse, CamerasResponse, EvacuationsResponse, ImageryResponse } from './types'

/** Refresh cadence while the data is current (matched to the sources' update cadence and the backend caches). */
export const REFRESH_MS: Record<ExtrasKind, number> = {
  evacuations: 120_000, // Cal OES rebuilds every ~5 min, Oregon OEM every 15 min; backend cache 2 min
  cameras: 300_000, // camera list; frames are fetched on request only
  imagery: 1_800_000, // new scenes appear a few times a day at most
}

export interface ExtrasQueryState<T> {
  data: T | null
  loading: boolean
  error: string | null
  /** Refetch now (keeps the current data meanwhile). */
  refresh: () => void
}

export const IDLE_QUERY: ExtrasQueryState<never> = { data: null, loading: false, error: null, refresh: () => {} }

/** Same answer, loading flag and error: publishing it again would only re-render the readers. */
export function sameQueryState<T>(a: ExtrasQueryState<T>, b: ExtrasQueryState<T>): boolean {
  return a.data === b.data && a.loading === b.loading && a.error === b.error && a.refresh === b.refresh
}

function useExtrasQuery<T extends { status: string }>(kind: ExtrasKind, query: (ImageryQuery & AreaQuery) | null, enabled: boolean): ExtrasQueryState<T> {
  const url = query && enabled ? extrasUrl(kind, query) : null
  // shared per-URL cache (jsonQuery.ts): a re-focused fire shows its last answer at once; past dates do not change
  return useCachedJsonQuery<T>(url, {
    refreshMs: REFRESH_MS[kind],
    timeoutMs: kind === 'imagery' ? 60_000 : 30_000,
    isCurrent: (d) => d.status !== 'not_available_for_past_dates',
  })
}

export function useEvacuations(query: AreaQuery | null, enabled = true): ExtrasQueryState<EvacuationsResponse> {
  return useExtrasQuery<EvacuationsResponse>('evacuations', query, enabled)
}

export function useCameras(query: AreaQuery | null, enabled = true): ExtrasQueryState<CamerasResponse> {
  return useExtrasQuery<CamerasResponse>('cameras', query, enabled)
}

export function useImagery(query: ImageryQuery | null, enabled = true): ExtrasQueryState<ImageryResponse> {
  return useExtrasQuery<ImageryResponse>('imagery', query, enabled)
}

export interface CameraFrameState {
  cameraId: string | null
  frame: CameraFrameResponse | null
  loading: boolean
  error: string | null
  /** Fetch the camera's latest image now (call from a click / key press only). */
  request: (cameraId: string) => void
  clear: () => void
}

/** Explicit-action camera image loader: nothing is fetched until `request(id)` is called. */
export function useCameraFrame(): CameraFrameState {
  const [s, setS] = useState<Omit<CameraFrameState, 'request' | 'clear'>>({ cameraId: null, frame: null, loading: false, error: null })
  const ctrl = useRef<AbortController | null>(null)
  const request = useCallback((cameraId: string) => {
    ctrl.current?.abort()
    const c = new AbortController()
    ctrl.current = c
    setS({ cameraId, frame: null, loading: true, error: null })
    fetchCameraFrame(cameraId, { signal: c.signal })
      .then((frame) => {
        if (!c.signal.aborted) setS({ cameraId, frame, loading: false, error: null })
      })
      .catch((e: unknown) => {
        if (!c.signal.aborted) setS({ cameraId, frame: null, loading: false, error: requestErrorText(e) })
      })
  }, [])
  const clear = useCallback(() => {
    ctrl.current?.abort()
    setS({ cameraId: null, frame: null, loading: false, error: null })
  }, [])
  useEffect(() => () => ctrl.current?.abort(), [])
  return { ...s, request, clear }
}
