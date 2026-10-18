// Shared runtime of the optional sources in the Public/Command workspace (owner: ui-integration; CONTRACT §12.3).
// ExtrasSync runs the three data hooks once and publishes their answers here, next to the viewer's choices (selected
// camera, imagery product, zone, opacity). The map layers (map/extrasLayers.ts), the Layers panel, the legend, the
// credits, the updates feed and the location card all read this store, so each source is fetched only once and only
// while its layer toggle is on.
import { useMemo } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../state/store'
import { useWorkspace } from '../state/workspace'
import type { FeedItem } from '../ui/feed/types'
import { cameraFeedItems, cameraLegend } from './cameras'
import { cameraCredits, evacuationCredits, imageryCredits, type ExtrasCredit } from './credits'
import { evacuationFeedItems, evacuationLegend } from './evacuation'
import { envelopeStatusLine, type StatusLine } from './format'
import type { CameraFrameState, ExtrasQueryState } from './hooks'
import { DEFAULT_IMAGERY_OPACITY, imageryFeedItems, imageryLegend } from './imagery'
import type { ExtrasLayerKey, ExtrasLegendEntry } from './legend'
import type { CamerasResponse, EvacuationsResponse, ExtrasEnvelope, ImageryProduct, ImageryResponse } from './types'

const noop = () => {}

export const IDLE_QUERY: ExtrasQueryState<never> = { data: null, loading: false, error: null, refresh: noop }
export const IDLE_FRAME: CameraFrameState = { cameraId: null, frame: null, loading: false, error: null, request: noop, clear: noop }

export interface ExtrasRuntimeState {
  evac: ExtrasQueryState<EvacuationsResponse>
  cams: ExtrasQueryState<CamerasResponse>
  imgs: ExtrasQueryState<ImageryResponse>
  /** The explicit-action camera image loader (nothing is fetched until frame.request(id)). */
  frame: CameraFrameState
  /** The satellite image drawn on the map: the viewer's pick, else pickDefaultImagery(). */
  product: ImageryProduct | null
  /** undefined = automatic choice; null = no image; else a product id. */
  productChoice: string | null | undefined
  cameraId: string | null
  zoneId: string | null
  opacity: number
  setProductChoice: (id: string | null | undefined) => void
  setCameraId: (id: string | null) => void
  setZoneId: (id: string | null) => void
  setOpacity: (v: number) => void
  /** Forget the viewer's choices (a new incident). */
  resetChoices: () => void
}

export const useExtrasRuntime = create<ExtrasRuntimeState>()((set) => ({
  evac: IDLE_QUERY,
  cams: IDLE_QUERY,
  imgs: IDLE_QUERY,
  frame: IDLE_FRAME,
  product: null,
  productChoice: undefined,
  cameraId: null,
  zoneId: null,
  opacity: DEFAULT_IMAGERY_OPACITY,
  setProductChoice: (productChoice) => set({ productChoice }),
  setCameraId: (cameraId) => set({ cameraId }),
  setZoneId: (zoneId) => set({ zoneId }),
  setOpacity: (v) => set({ opacity: Math.min(1, Math.max(0, v)) }),
  resetChoices: () => set({ productChoice: undefined, cameraId: null, zoneId: null }),
}))

/** Same answer, loading flag and error: publishing it again would only re-render the readers. */
export function sameQueryState<T>(a: ExtrasQueryState<T>, b: ExtrasQueryState<T>): boolean {
  return a.data === b.data && a.loading === b.loading && a.error === b.error && a.refresh === b.refresh
}

/** The optional-source answers for the layers that are switched on (null for a layer that is off). */
export function useVisibleExtras(): { evac: EvacuationsResponse | null; cams: CamerasResponse | null; imgs: ImageryResponse | null; product: ImageryProduct | null } {
  const on = useWorkspace(useShallow((s) => ({ evacuation: s.mapLayers.evacuation, cameras: s.mapLayers.cameras, recentImagery: s.mapLayers.recentImagery })))
  return useExtrasRuntime(
    useShallow((s) => ({
      evac: on.evacuation ? s.evac.data : null,
      cams: on.cameras ? s.cams.data : null,
      imgs: on.recentImagery ? s.imgs.data : null,
      product: on.recentImagery ? s.product : null,
    })),
  )
}

/** Legend entries of the visible optional layers (official wording, camera kinds, the satellite image shown). */
export function useExtrasLegend(nowMs: number): ExtrasLegendEntry[] {
  const v = useVisibleExtras()
  const refMs = v.imgs?.reference_ms ?? nowMs
  return useMemo(() => [...evacuationLegend(v.evac), ...cameraLegend(v.cams), ...imageryLegend(v.product, refMs)], [v.evac, v.cams, v.product, refMs])
}

/** Credits of the visible optional layers, as text (CONTRACT §4.4, §12.5). */
export function useExtrasCredits(): ExtrasCredit[] {
  const v = useVisibleExtras()
  return useMemo(() => [...evacuationCredits(v.evac), ...cameraCredits(v.cams), ...imageryCredits(v.product, v.imgs)], [v.evac, v.cams, v.imgs, v.product])
}

const NO_ITEMS: FeedItem[] = []

/** Feed items of the visible optional layers for UpdatesFeed `extraItems` (memoised; CONTRACT §12.3 item 5). */
export function useExtrasFeedItems(): FeedItem[] {
  const v = useVisibleExtras()
  const { manifest, startMs, endMs, startedMs } = useStore(
    useShallow((s) => {
      const m = s.manifest?.status === 'ready' ? s.manifest : null
      return { manifest: m, startMs: m?.time_range.start_ms ?? null, endMs: m?.time_range.end_ms ?? null, startedMs: s.summary?.started_ms ?? null }
    }),
  )
  return useMemo(() => {
    const range: [number, number] | null = startMs != null && endMs != null ? [startMs, endMs] : null
    const items = [...evacuationFeedItems(v.evac, manifest), ...cameraFeedItems(v.cams), ...imageryFeedItems(v.imgs, range, startedMs)]
    return items.length ? items : NO_ITEMS
  }, [v.evac, v.cams, v.imgs, manifest, startMs, endMs, startedMs])
}

/** The optional layers, in legend order. */
export const EXTRAS_LAYER_KEYS: readonly ExtrasLayerKey[] = ['evacuation', 'cameras', 'recentImagery']

const SOURCE_NAME: Record<ExtrasLayerKey, string> = { evacuation: 'Official evacuation zones', cameras: 'Public cameras', recentImagery: 'Recent satellite imagery' }
const COMPACT_LABEL: Record<ExtrasLayerKey, string> = { evacuation: 'Evacuation zones (official)', cameras: 'Public cameras', recentImagery: 'Satellite image' }

type Answer = { data: Pick<ExtrasEnvelope, 'status' | 'reason'> | null; error: string | null }

/**
 * Why a switched-on optional layer draws nothing: loading, error, not available for past dates, unavailable (with
 * the source's reason), or nothing listed in this area ("none listed" is never an all-clear). Layers that are off or
 * that draw something get no line.
 */
export function extrasStatusLines(
  on: Record<ExtrasLayerKey, boolean>,
  q: { evac: Answer & { data: EvacuationsResponse | null }; cams: Answer & { data: CamerasResponse | null }; imgs: Answer },
  product: ImageryProduct | null,
): Partial<Record<ExtrasLayerKey, StatusLine>> {
  const out: Partial<Record<ExtrasLayerKey, StatusLine>> = {}
  const base = (k: ExtrasLayerKey, a: Answer) => envelopeStatusLine(a.data, SOURCE_NAME[k], a.error)
  if (on.evacuation) {
    const l = base('evacuation', q.evac)
    const d = q.evac.data
    const shown = d?.status === 'available' ? d.zones.features.filter((f) => !['normal', 'training'].includes(f.properties.status_key)).length : 0
    if (l.tone !== 'ok') out.evacuation = l
    else if (shown === 0) out.evacuation = { tone: 'info', title: 'Official evacuation zones: none listed in this area', detail: 'That is not an all-clear. Follow local officials.' }
  }
  if (on.cameras) {
    const l = base('cameras', q.cams)
    if (l.tone !== 'ok') out.cameras = l
    else if (q.cams.data?.status === 'available' && q.cams.data.cameras.features.length === 0) out.cameras = { tone: 'info', title: 'Public cameras: none listed in this area', detail: null }
  }
  if (on.recentImagery) {
    const l = base('recentImagery', q.imgs)
    if (l.tone !== 'ok') out.recentImagery = l
    else if (!product) out.recentImagery = { tone: 'info', title: 'Recent satellite imagery: no image shown', detail: 'No usable image of this area up to the selected time, or none picked in Layers.' }
  }
  return out
}

/** Status lines for the switched-on optional layers (see extrasStatusLines). */
export function useExtrasStatus(): Partial<Record<ExtrasLayerKey, StatusLine>> {
  const on = useWorkspace(useShallow((s) => ({ evacuation: s.mapLayers.evacuation, cameras: s.mapLayers.cameras, recentImagery: s.mapLayers.recentImagery })))
  const q = useExtrasRuntime(useShallow((s) => ({ evac: s.evac, cams: s.cams, imgs: s.imgs, product: s.product })))
  return useMemo(() => extrasStatusLines(on, q, q.product), [on, q])
}

/** One compact legend entry per optional layer that draws something: its first (most important) swatch. */
export function compactExtrasLegend(entries: readonly ExtrasLegendEntry[]): { layer: ExtrasLayerKey; entry: ExtrasLegendEntry; label: string }[] {
  const out: { layer: ExtrasLayerKey; entry: ExtrasLegendEntry; label: string }[] = []
  for (const k of EXTRAS_LAYER_KEYS) {
    const first = entries.find((e) => e.layer === k)
    if (first) out.push({ layer: k, entry: first, label: COMPACT_LABEL[k] })
  }
  return out
}

declare global {
  interface Window {
    /** Dev/test handle (like __mapRuntime): window.__extrasRuntime.getState() for screenshot and check scripts. */
    __extrasRuntime?: typeof useExtrasRuntime
  }
}

if (typeof window !== 'undefined') window.__extrasRuntime = useExtrasRuntime
