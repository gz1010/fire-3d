// Official information hooks (owner: official-web; CONTRACT §13 I5). Consumers: the location card (location), the
// "Official now" block, the phone Updates badge (shell). Each hook reads the shared runtime (official/runtime.ts,
// extras/runtime.ts), which ExtrasSync fills for the open fire whatever the map layers show; useOfficialAtPoint also
// checks Cal OES around a point outside the fire's area itself. The states are explicit and never an all-clear
// (official/model.ts).
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { DEFAULT_MARGIN_KM } from '../extras/client'
import { useEvacuations } from '../extras/hooks'
import { useExtrasRuntime } from '../extras/runtime'
import { useStore } from '../state/store'
import { calfireStatus } from './calfire'
import { useOfficialContext, type OfficialContext } from './context'
import { fireWeatherStatewideUrl, OFFICIAL_REFRESH_MS } from './client'
import {
  evacuationAtPointState,
  evacuationNow,
  fireWeatherAtPointState,
  fireWeatherNow,
  needsPointQuery,
  needsStatewideFireWeather,
  officialBadge,
  pointQueryBbox,
  type CalFireOfficial,
  type EvacuationOfficial,
  type FireWeatherOfficial,
  type OfficialBadge,
} from './model'
import { forIncident } from './guard'
import { useJsonQuery } from './query'
import { useFireWeatherData, useOfficialRuntime } from './runtime'
import type { FireWeatherResponse } from './types'

export type { CalFireOfficial, EvacuationOfficial, FireWeatherOfficial, OfficialAlert, OfficialBadge, OfficialZone } from './model'
export { useOfficialContext, type OfficialContext } from './context'

/** The three official answers (I5). */
export interface OfficialInfo {
  evacuation: EvacuationOfficial
  fireWeather: FireWeatherOfficial
  calfire: CalFireOfficial
}

function useIncidentEvac(incidentId: string | null) {
  const q = useExtrasRuntime(useShallow((s) => ({ data: s.evac.data, loading: s.evac.loading, error: s.evac.error })))
  return useMemo(() => {
    const data = forIncident(q.data, incidentId)
    return data === q.data ? q : { data, loading: q.loading || (q.data != null && data == null), error: data ? q.error : null }
  }, [q, incidentId])
}

function useFireWeatherQuery() {
  const meta = useOfficialRuntime(useShallow((s) => ({ loading: s.fireWeather.loading, error: s.fireWeather.error })))
  const data = useFireWeatherData()
  return useMemo(() => ({ data, ...meta }), [data, meta])
}

function useCalfire(ctx: OfficialContext): CalFireOfficial {
  const raw = useOfficialRuntime(useShallow((s) => ({ data: s.calfire.data, loading: s.calfire.loading, error: s.calfire.error })))
  const q = useMemo(() => {
    const data = forIncident(raw.data, ctx.incidentId)
    return data === raw.data ? raw : { data, loading: true, error: null }
  }, [raw, ctx.incidentId])
  const summary = useStore((s) => (s.summary && s.summary.id === s.incidentId ? s.summary : null))
  return useMemo(() => (ctx.hasIncident ? calfireStatus(q, summary, ctx.demo) : { state: 'unavailable' as const, reason: 'No fire selected.' }), [q, summary, ctx.hasIncident, ctx.demo])
}

/**
 * Official information at a point (I5): Cal OES zones containing it (checked around the point itself when it lies
 * outside the open fire's area, current time only), NWS fire weather alerts covering it, and the fire's CAL FIRE
 * record. Pass null coordinates for "no point".
 */
export function useOfficialAtPoint(lon: number | null, lat: number | null): OfficialInfo {
  const ctx = useOfficialContext()
  const incident = useIncidentEvac(ctx.incidentId)
  const wanted = needsPointQuery({ lon, lat, incidentBbox: ctx.evacBbox, past: ctx.past, incidentData: incident.data })
  const pq = useEvacuations(wanted && lon != null && lat != null ? { bbox: pointQueryBbox(lon, lat) } : null, wanted)
  const point = useMemo(() => ({ data: pq.data, loading: pq.loading, error: pq.error }), [pq.data, pq.loading, pq.error])
  const fw = useFireWeatherQuery()
  const swWanted = needsStatewideFireWeather({ lon, lat, hasIncident: ctx.hasIncident, demo: ctx.demo, past: ctx.past, fallbackArea: ctx.evacBbox, incidentData: fw.data })
  const swq = useJsonQuery<FireWeatherResponse>(swWanted ? fireWeatherStatewideUrl() : null, { refreshMs: OFFICIAL_REFRESH_MS.fireWeather, timeoutMs: 45_000, isCurrent: (d) => d.status === 'available' })
  const statewide = useMemo(() => ({ data: swq.data, loading: swq.loading, error: swq.error }), [swq.data, swq.loading, swq.error])
  const calfire = useCalfire(ctx)
  const evacuation = useMemo(
    () =>
      evacuationAtPointState({
        lon,
        lat,
        incident: ctx.hasIncident ? incident : null,
        incidentBbox: ctx.evacBbox,
        point: wanted ? point : null,
        past: ctx.past,
        fire: ctx.fire,
      }),
    [lon, lat, ctx, incident, wanted, point],
  )
  const fireWeather = useMemo(
    () =>
      fireWeatherAtPointState({
        lon,
        lat,
        refMs: ctx.refMs,
        incident: ctx.hasIncident ? fw : null,
        statewide: swWanted ? statewide : null,
        hasIncident: ctx.hasIncident,
        demo: ctx.demo,
        past: ctx.past,
        fallbackArea: ctx.evacBbox,
      }),
    [fw, statewide, swWanted, lon, lat, ctx],
  )
  return useMemo(() => ({ evacuation, fireWeather, calfire }), [evacuation, fireWeather, calfire])
}

/** Official information for the open fire (I5; the "Official now" block): zones near it, its NWS alerts, its record. */
export function useOfficialNow(): OfficialInfo {
  const ctx = useOfficialContext()
  const incident = useIncidentEvac(ctx.incidentId)
  const fw = useFireWeatherQuery()
  const calfire = useCalfire(ctx)
  const evacuation = useMemo(
    () => evacuationNow(ctx.hasIncident ? incident : null, ctx.fire, { hasIncident: ctx.hasIncident, layerOn: ctx.layerOn, marginKm: DEFAULT_MARGIN_KM.evacuations }),
    [ctx, incident],
  )
  // the overview (no fire open): California's current NWS alerts; evacuation zones and CAL FIRE need a fire
  const statewide = useOfficialRuntime(useShallow((s) => ({ data: s.statewide.data, loading: s.statewide.loading, error: s.statewide.error })))
  const fireWeather = useMemo(
    () => (ctx.hasIncident ? fireWeatherNow(fw, ctx.refMs, { demo: ctx.demo, hasIncident: true }) : fireWeatherNow(statewide, ctx.refMs, { demo: false, hasIncident: false, statewide: true })),
    [fw, statewide, ctx],
  )
  return useMemo(() => ({ evacuation, fireWeather, calfire }), [evacuation, fireWeather, calfire])
}

/** The phone Updates badge (I5): active official items near the open fire and the most urgent level (none on the
 *  overview: the badge is about the open fire). */
export function useOfficialBadge(): OfficialBadge {
  const { evacuation, fireWeather } = useOfficialNow()
  const open = useStore((s) => s.incidentId != null)
  return useMemo(() => (open ? officialBadge(evacuation, fireWeather) : { count: 0, level: null }), [open, evacuation, fireWeather])
}
