// React hooks for the optional sources (owner: optional-sources). Each hook fetches when its query changes (keyed by
// URL, so quantised `at_ms` values from `extrasAtMs` avoid refetching during playback), keeps the previous answer
// while refreshing, refreshes on the source's cadence while the data is current, and aborts on unmount.
import { useCallback, useEffect, useRef, useState } from 'react'
import { extrasUrl, fetchCameraFrame, type AreaQuery, type ExtrasKind, type ImageryQuery } from './client'
import { fetchJson } from '../api/client'
import { requestErrorText } from './format'
import type { CameraFrameResponse, CamerasResponse, EvacuationsResponse, ImageryResponse } from './types'

/** Refresh cadence while the data is current (matched to the sources' update cadence and the backend caches). */
export const REFRESH_MS: Record<ExtrasKind, number> = {
  evacuations: 120_000, // Cal OES rebuilds every ~5 min; backend cache 2 min
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

interface Settled<T> {
  /** `${url}#${tick}` of the request this answer belongs to. */
  key: string
  url: string
  data: T | null
  error: string | null
}

function useExtrasQuery<T extends { status: string }>(kind: ExtrasKind, query: (ImageryQuery & AreaQuery) | null, enabled: boolean): ExtrasQueryState<T> {
  const url = query && enabled ? extrasUrl(kind, query) : null
  const [tick, setTick] = useState(0)
  const [settled, setSettled] = useState<Settled<T> | null>(null)
  const refresh = useCallback(() => setTick((n) => n + 1), [])
  const key = url ? `${url}#${tick}` : null

  useEffect(() => {
    if (!url || !key) return
    const ctrl = new AbortController()
    fetchJson<T>(url, { signal: ctrl.signal, timeoutMs: kind === 'imagery' ? 60_000 : 30_000 })
      .then((data) => setSettled({ key, url, data, error: null }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return
        // keep the previous answer for the same area/time; report the failure next to it
        setSettled((s) => ({ key, url, data: s?.url === url ? s.data : null, error: requestErrorText(e) }))
      })
    return () => ctrl.abort()
  }, [url, key, kind])

  const same = settled != null && settled.url === url
  const data = same ? settled.data : null
  // periodic refresh only while the answer is current (past dates do not change)
  const current = data != null && data.status !== 'not_available_for_past_dates'
  useEffect(() => {
    if (!url || !current) return
    const id = window.setInterval(refresh, REFRESH_MS[kind])
    return () => window.clearInterval(id)
  }, [url, current, kind, refresh])

  return { data, loading: url != null && settled?.key !== key, error: same ? settled.error : null, refresh }
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
