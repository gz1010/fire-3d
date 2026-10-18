// Runs the optional-source data hooks once for the Public/Command workspace and publishes them to useExtrasRuntime
// (owner: ui-integration; CONTRACT §12.3 item 1). Renders nothing. Each source is fetched only while its layer toggle
// is on, for the incident's area (analysis area + the source's margin) and the timeline position (extrasAtMs: current
// status only at / after the live NOW marker, otherwise "not available for past dates"; imagery up to the selected
// time). While the timeline plays, the query time is held so playback never fetches; it catches up on pause.
import { useEffect, useLayoutEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { nowMarkerMs, useStore } from '../state/store'
import { useWorkspace } from '../state/workspace'
import { useNow } from '../ui/hooks'
import { DEFAULT_MARGIN_KM, extrasAtMs, incidentAreaBbox, type AreaQuery } from './client'
import { useCameraFrame, useCameras, useEvacuations, useImagery } from './hooks'
import { pickDefaultImagery } from './imagery'
import { sameQueryState, useExtrasRuntime, type ExtrasRuntimeState } from './runtime'

interface QueryTimes {
  evac: number | null
  cams: number | null
  imgs: number | null
}

export function ExtrasSync() {
  const on = useWorkspace(useShallow((s) => ({ evacuation: s.mapLayers.evacuation, cameras: s.mapLayers.cameras, recentImagery: s.mapLayers.recentImagery })))
  const now = useNow(60_000)
  const { incidentId, summary, manifest, playing } = useStore(
    useShallow((s) => ({
      incidentId: s.incidentId,
      // the summary of the incident being shown (it can lag one render behind a switch)
      summary: s.summary && s.summary.id === s.incidentId ? s.summary : null,
      manifest: s.manifest?.status === 'ready' && s.manifest.id === s.incidentId ? s.manifest : null,
      playing: s.playing,
    })),
  )
  const at = useStore(
    useShallow((s): QueryTimes => {
      const mode = s.manifest?.mode ?? s.summary?.mode ?? s.mode
      const m = s.manifest?.status === 'ready' ? s.manifest : null
      const marker = nowMarkerMs(m, s.forecast)
      return {
        evac: extrasAtMs('evacuations', mode, s.timeMs, now, marker),
        cams: extrasAtMs('cameras', mode, s.timeMs, now, marker),
        imgs: extrasAtMs('imagery', mode, s.timeMs, now, marker),
      }
    }),
  )
  // hold the query times while playing (adjusting state during render: React's "previous render" pattern)
  const [held, setHeld] = useState<QueryTimes>(at)
  if (!playing && (held.evac !== at.evac || held.cams !== at.cams || held.imgs !== at.imgs)) setHeld(at)
  const times = playing ? held : at

  const query = (k: 'evacuations' | 'cameras' | 'imagery', atMs: number | null): AreaQuery | null => {
    const bbox = incidentAreaBbox(summary, manifest, DEFAULT_MARGIN_KM[k])
    return bbox && incidentId ? { bbox, incident: incidentId, atMs } : null
  }
  const evac = useEvacuations(query('evacuations', times.evac), on.evacuation)
  const cams = useCameras(query('cameras', times.cams), on.cameras)
  const imgs = useImagery(query('imagery', times.imgs), on.recentImagery)
  const frame = useCameraFrame()
  const productChoice = useExtrasRuntime((s) => s.productChoice)
  const product =
    productChoice === undefined ? pickDefaultImagery(imgs.data, summary?.started_ms ?? null) : productChoice ? (imgs.data?.products.find((p) => p.id === productChoice) ?? null) : null

  // a new incident: forget the selected camera, image and zone; drop a loaded camera image
  const clearFrame = frame.clear
  useEffect(() => {
    useExtrasRuntime.getState().resetChoices()
    clearFrame()
  }, [incidentId, clearFrame])

  useLayoutEffect(() => {
    const cur = useExtrasRuntime.getState()
    const patch: Partial<ExtrasRuntimeState> = {}
    if (!sameQueryState(cur.evac, evac)) patch.evac = evac
    if (!sameQueryState(cur.cams, cams)) patch.cams = cams
    if (!sameQueryState(cur.imgs, imgs)) patch.imgs = imgs
    const f = cur.frame
    if (f.cameraId !== frame.cameraId || f.frame !== frame.frame || f.loading !== frame.loading || f.error !== frame.error || f.request !== frame.request) patch.frame = frame
    if (cur.product !== product) patch.product = product
    if (Object.keys(patch).length) useExtrasRuntime.setState(patch)
  })

  // leaving the map workspace: the hooks abort; readers must not keep showing their last answers
  useEffect(
    () => () => {
      useExtrasRuntime.setState({ evac: { ...useExtrasRuntime.getState().evac, data: null, loading: false }, cams: { ...useExtrasRuntime.getState().cams, data: null, loading: false }, imgs: { ...useExtrasRuntime.getState().imgs, data: null, loading: false }, product: null })
    },
    [],
  )
  return null
}
