// Shared runtime of the optional sources in the Public/Command workspace (owner: official-web since brief 2, earlier
// ui-integration; CONTRACT §12.3, §13). ExtrasSync runs the data hooks once and publishes their answers here, next to
// the viewer's choices (selected camera, imagery product, zone, opacity). The map layers (map/extrasLayers.ts), the
// Layers panel, the legend, the credits, the updates feed, the location card and the official hooks all read this
// store, so each source is fetched only once. Official evacuation zones are fetched for the open fire whatever the
// layer toggle says (the toggle hides them on the map and in the legend only); cameras only while their layer is on.
// The legend, credit and feed helpers below also carry the official sources (NWS outlines, CAL FIRE and NWS rows).
import { useMemo } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { calfireFeedItems } from '../official/calfire'
import { wfigsRecordFeedItems } from '../official/record'
import { localAlertCredits, localAlertFeedItems, localAlertsState } from '../official/localAlerts'
import { useTimeFormat } from '../state/timeZone'
import { forIncident } from '../official/guard'
import { useOfficialContext } from '../official/context'
import { fireWeatherCredits, fireWeatherFeedItems, fireWeatherLegend } from '../official/fireWeather'
import { useFireWeatherData, useOfficialRuntime } from '../official/runtime'
import { useStore } from '../state/store'
import { useWorkspace } from '../state/workspace'
import type { FeedItem } from '../ui/feed/types'
import { cameraFeedItems, cameraLegend } from './cameras'
import { cameraCredits, evacuationCredits, imageryCredits, type ExtrasCredit } from './credits'
import { evacuationFeedItems, evacuationLegend } from './evacuation'
import { envelopeStatusLine, type StatusLine } from './format'
import { IDLE_QUERY, type CameraFrameState, type ExtrasQueryState } from './hooks'
import { DEFAULT_IMAGERY_OPACITY, imageryFeedItems, imageryLegend } from './imagery'
import type { ExtrasLayerKey, ExtrasLegendEntry } from './legend'
import type { CamerasResponse, EvacuationsResponse, ExtrasEnvelope, ImageryProduct, ImageryResponse } from './types'

const noop = () => {}

export { IDLE_QUERY, sameQueryState } from './hooks'
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

/** The optional-source answers for the layers that are switched on (null for a layer that is off). */
export function useVisibleExtras(): { evac: EvacuationsResponse | null; cams: CamerasResponse | null; imgs: ImageryResponse | null; product: ImageryProduct | null } {
  const on = useWorkspace(useShallow((s) => ({ evacuation: s.mapLayers.evacuation, cameras: s.mapLayers.cameras, recentImagery: s.mapLayers.recentImagery })))
  const incidentId = useStore((s) => s.incidentId)
  // only the open fire's answers (the fire changes as the user zooms; brief 2 decision 10)
  return useExtrasRuntime(
    useShallow((s) => {
      const imgs = on.recentImagery ? forIncident(s.imgs.data, incidentId) : null
      return {
        evac: on.evacuation ? forIncident(s.evac.data, incidentId) : null,
        cams: on.cameras ? forIncident(s.cams.data, incidentId) : null,
        imgs,
        product: imgs ? s.product : null,
      }
    }),
  )
}

/** Legend entries of the visible optional layers (official wording, camera kinds, the satellite image shown) and of
 *  the NWS fire weather outlines in effect at the reference time (now, or the replay time). */
export function useExtrasLegend(nowMs: number): ExtrasLegendEntry[] {
  const v = useVisibleExtras()
  const refMs = v.imgs?.reference_ms ?? nowMs
  const fw = useFireWeatherData()
  const fwRef = useOfficialContext().refMs
  return useMemo(
    () => [...evacuationLegend(v.evac), ...fireWeatherLegend(fw, fwRef), ...cameraLegend(v.cams), ...imageryLegend(v.product, refMs)],
    [v.evac, v.cams, v.product, refMs, fw, fwRef],
  )
}

/** Credits of the visible optional layers, of drawn NWS outlines and of the open fire's local officials' alerts
 *  (NWS; FEMA's archive with the OpenFEMA notice), as text (CONTRACT §4.4, §12.5, §14.7). */
export function useExtrasCredits(): ExtrasCredit[] {
  const v = useVisibleExtras()
  const fw = useFireWeatherData()
  const ctx = useOfficialContext()
  const fwRef = ctx.refMs
  const localData = useOfficialRuntime((s) => forIncident(s.local.data, ctx.incidentId))
  const demo = ctx.demo
  return useMemo(
    () => [
      ...evacuationCredits(v.evac),
      ...fireWeatherCredits(fw, fwRef),
      ...(demo ? [] : localAlertCredits(localAlertsState({ data: localData, loading: false, error: null }))),
      ...cameraCredits(v.cams),
      ...imageryCredits(v.product, v.imgs),
    ],
    [v.evac, v.cams, v.imgs, v.product, fw, fwRef, localData, demo],
  )
}

const NO_ITEMS: FeedItem[] = []

/**
 * Feed items for UpdatesFeed `extraItems` (memoised; CONTRACT §12.3 item 5, §13, §14.5): official evacuation status
 * (whatever the layer toggle says), the agency record (CAL FIRE's changes, or a NIFC WFIGS fire's record), NWS fire
 * weather alerts, and the camera / imagery items of their visible layers.
 */
export function useExtrasFeedItems(): FeedItem[] {
  const v = useVisibleExtras()
  const ctx = useOfficialContext()
  const evac = useExtrasRuntime((s) => forIncident(s.evac.data, ctx.incidentId))
  const calfire = useOfficialRuntime((s) => forIncident(s.calfire.data, ctx.incidentId))
  const record = useOfficialRuntime((s) => forIncident(s.record.data, ctx.incidentId))
  const localData = useOfficialRuntime((s) => forIncident(s.local.data, ctx.incidentId))
  const tf = useTimeFormat()
  const fw = useFireWeatherData()
  const metric = useWorkspace((s) => s.units === 'metric')
  const { manifest, summary, startMs, endMs, startedMs } = useStore(
    useShallow((s) => {
      const m = s.manifest?.status === 'ready' ? s.manifest : null
      const sum = s.summary && s.summary.id === s.incidentId ? s.summary : null
      return { manifest: m, summary: sum, startMs: m?.time_range.start_ms ?? null, endMs: m?.time_range.end_ms ?? null, startedMs: s.summary?.started_ms ?? null }
    }),
  )
  return useMemo(() => {
    const range: [number, number] | null = startMs != null && endMs != null ? [startMs, endMs] : null
    const mode = manifest?.mode ?? summary?.mode ?? 'live'
    const items = [
      ...evacuationFeedItems(evac, manifest, { fire: ctx.fire, metric, tf }),
      ...(ctx.demo ? [] : calfireFeedItems(calfire, { mode, manifest, summary, tf })),
      // a NIFC WFIGS fire's own record (a California fire's matched record stays on the card, not in the feed)
      ...(ctx.demo || (summary?.record_source ?? 'calfire') !== 'wfigs' ? [] : wfigsRecordFeedItems(record, { mode, manifest, summary, tf })),
      ...(ctx.demo ? [] : fireWeatherFeedItems(fw, { mode, refMs: ctx.refMs, manifest, metric, tf })),
      // local officials' messages relayed by NWS / archived by FEMA (CONTRACT §14.7)
      ...(ctx.demo ? [] : localAlertFeedItems(localAlertsState({ data: localData, loading: false, error: null }, { refMs: ctx.refMs }), { manifest, tf, metric })),
      ...cameraFeedItems(v.cams, tf),
      ...imageryFeedItems(v.imgs, range, startedMs),
    ]
    return items.length ? items : NO_ITEMS
  }, [evac, calfire, record, localData, tf, fw, ctx, metric, v.cams, v.imgs, manifest, summary, startMs, endMs, startedMs])
}

/** The optional layers, in legend order ('fireWeather' = the NWS outlines, which have no toggle). */
export const EXTRAS_LAYER_KEYS: readonly ExtrasLayerKey[] = ['evacuation', 'fireWeather', 'cameras', 'recentImagery']

const SOURCE_NAME: Record<ExtrasLayerKey, string> = {
  evacuation: 'Official evacuation zones',
  fireWeather: 'NWS fire weather alerts',
  cameras: 'Public cameras',
  recentImagery: 'Recent satellite imagery',
}
const COMPACT_LABEL: Record<ExtrasLayerKey, string> = {
  evacuation: 'Evacuation zones (official)',
  fireWeather: 'Fire weather alert (NWS)',
  cameras: 'Public cameras',
  recentImagery: 'Satellite image',
}

type Answer = { data: Pick<ExtrasEnvelope, 'status' | 'reason'> | null; error: string | null }

/**
 * Why a switched-on optional layer draws nothing: loading, error, not available for past dates, unavailable (with
 * the source's reason), or nothing listed in this area ("none listed" is never an all-clear). Layers that are off or
 * that draw something get no line.
 */
export function extrasStatusLines(
  on: Partial<Record<ExtrasLayerKey, boolean>>,
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

/** Why NWS outlines cannot be drawn for the open fire (past dates without the archive, outages); null otherwise
 *  (no alert in effect is said in "Official now", not as a legend line). */
export function fireWeatherStatusLine(d: { status: string; reason: string | null } | null, error: string | null, opts: { hasIncident: boolean; demo: boolean }): StatusLine | null {
  if (!opts.hasIncident || opts.demo) return null
  if (error && !d) return { tone: 'error', title: `${SOURCE_NAME.fireWeather}: could not load`, detail: error }
  if (!d) return null
  if (d.status === 'not_available_for_past_dates') return { tone: 'muted', title: `${SOURCE_NAME.fireWeather}: not available for this time`, detail: d.reason }
  if (d.status === 'unavailable') return { tone: 'warn', title: `${SOURCE_NAME.fireWeather}: unavailable`, detail: d.reason }
  return null
}

/** Status lines for the switched-on optional layers (see extrasStatusLines) and for the NWS outlines. */
export function useExtrasStatus(): Partial<Record<ExtrasLayerKey, StatusLine>> {
  const on = useWorkspace(useShallow((s) => ({ evacuation: s.mapLayers.evacuation, cameras: s.mapLayers.cameras, recentImagery: s.mapLayers.recentImagery })))
  const q = useExtrasRuntime(useShallow((s) => ({ evac: s.evac, cams: s.cams, imgs: s.imgs, product: s.product })))
  const fw = useOfficialRuntime(useShallow((s) => ({ data: s.fireWeather.data, error: s.fireWeather.error })))
  const ctx = useOfficialContext()
  return useMemo(() => {
    const out = extrasStatusLines(on, q, q.product)
    const l = fireWeatherStatusLine(fw.data, fw.error, { hasIncident: ctx.hasIncident, demo: ctx.demo })
    return l ? { ...out, fireWeather: l } : out
  }, [on, q, fw, ctx.hasIncident, ctx.demo])
}

/** One compact legend entry per optional layer that draws something: its first (most important) swatch, labelled
 *  by the entry's own compact label (the satellite image names its platform and time) or the layer's short name. */
export function compactExtrasLegend(entries: readonly ExtrasLegendEntry[]): { layer: ExtrasLayerKey; entry: ExtrasLegendEntry; label: string }[] {
  const out: { layer: ExtrasLayerKey; entry: ExtrasLegendEntry; label: string }[] = []
  for (const k of EXTRAS_LAYER_KEYS) {
    const first = entries.find((e) => e.layer === k)
    if (first) out.push({ layer: k, entry: first, label: first.compact ?? COMPACT_LABEL[k] })
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
