// Official information hooks (owner: official-web; CONTRACT §13 I5, brief 3 §14.6-14.8). Consumers: the location
// card (location), the "Official now" block, the phone Updates badge (shell). Each hook reads the shared runtime
// (official/runtime.ts, extras/runtime.ts), which ExtrasSync fills for the open fire whatever the map layers show;
// useOfficialAtPoint also asks the backend about a point outside the fire's area itself (the backend's state registry
// answers "not available in this state" without an upstream request) and looks up the point's state
// (/api/geo/lookup), which decides what was checked there. The states are explicit and never an all-clear
// (official/model.ts).
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { DEFAULT_MARGIN_KM } from '../extras/client'
import { useEvacuations } from '../extras/hooks'
import { useExtrasRuntime } from '../extras/runtime'
import type { Coverage } from '../api/types'
import { useGeoLookup } from '../location/geoLookup'
import { useStore } from '../state/store'
import { recordStatus, type RecordStatus } from './record'
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

/** The point's place from /api/geo/lookup (brief 3; CONTRACT §14.9.6): its state decides what was checked there. */
export interface OfficialPlace {
  /** 'loading' until the lookup answers; 'error' when it failed (then nothing is claimed as checked). */
  status: 'loading' | 'ok' | 'error'
  /** USPS code in the lower 48 (+ DC), else null. */
  state: string | null
  stateName: string | null
  /** IANA zone of the point (null outside the lower 48). */
  timeZone: string | null
  coverage: Coverage | null
}

/** The three official answers (I5), plus (brief 3, optional) the point's place. `calfire` is the fire's agency record
 *  (CAL FIRE's or NIFC WFIGS's: a RecordStatus; the field name stays until the integration). */
export interface OfficialInfo {
  evacuation: EvacuationOfficial
  fireWeather: FireWeatherOfficial
  calfire: CalFireOfficial
  place?: OfficialPlace | null
}

/** The point's state for the models: undefined while unknown, null outside the lower 48 or when the lookup failed. */
export function placeState(p: Pick<OfficialPlace, 'status' | 'state'> | null | undefined): string | null | undefined {
  if (!p || p.status === 'loading') return undefined
  return p.status === 'ok' ? p.state : null
}

function usePlace(lon: number | null, lat: number | null): OfficialPlace | null {
  const g = useGeoLookup(lon, lat)
  const valid = lon != null && lat != null && Number.isFinite(lon) && Number.isFinite(lat)
  return useMemo(() => {
    if (!valid) return null
    if (g.status === 'loading') return { status: 'loading', state: null, stateName: null, timeZone: null, coverage: null }
    if (g.status === 'error') return { status: 'error', state: null, stateName: null, timeZone: null, coverage: null }
    const d = g.data
    return { status: 'ok', state: d.supported ? d.state : null, stateName: d.supported ? d.state_name : null, timeZone: d.time_zone, coverage: d.coverage }
  }, [g, valid])
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

/** The open fire's agency record (CONTRACT §14.5): CAL FIRE's or NIFC WFIGS's, labelled from the issuer, with every
 *  record when the agencies disagree and a complex row's named members (official/record.ts). */
export function useRecord(ctx?: OfficialContext): RecordStatus {
  const own = useOfficialContext()
  const c = ctx ?? own
  const raw = useOfficialRuntime(
    useShallow((s) => ({ cf: s.calfire.data, cfLoading: s.calfire.loading, cfError: s.calfire.error, rec: s.record.data, recLoading: s.record.loading, recError: s.record.error })),
  )
  const summary = useStore((s) => (s.summary && s.summary.id === s.incidentId ? s.summary : null))
  return useMemo(() => {
    const cfData = forIncident(raw.cf, c.incidentId)
    const recData = forIncident(raw.rec, c.incidentId)
    const calfire = cfData === raw.cf ? { data: raw.cf, loading: raw.cfLoading, error: raw.cfError } : { data: cfData, loading: true, error: null }
    const record = recData === raw.rec ? { data: raw.rec, loading: raw.recLoading, error: raw.recError } : { data: recData, loading: true, error: null }
    // until the summary says whose record it is, nothing is fetched: say "checking"
    if (c.hasIncident && !c.demo && !summary) return { state: 'loading', source: null, issuer: 'Agency record', linkLabel: 'Agency record' }
    return recordStatus({ calfire, record, summary, demo: c.demo, hasIncident: c.hasIncident })
  }, [raw, summary, c.incidentId, c.hasIncident, c.demo])
}

/** @deprecated Brief 3: use `useRecord()` (the record is CAL FIRE's or NIFC WFIGS's). */
export const useCalfire = useRecord

/**
 * Official information at a point (I5): the state source's evacuation zones containing it (checked around the point
 * itself when it lies outside the open fire's area, current time only; "not available in this state" where no state
 * feed exists), NWS fire weather alerts covering it (only where the answer's `states_checked` holds the point's
 * state), the fire's agency record and the point's place. Pass null coordinates for "no point".
 */
export function useOfficialAtPoint(lon: number | null, lat: number | null): OfficialInfo {
  const ctx = useOfficialContext()
  const place = usePlace(lon, lat)
  const pointState = placeState(place)
  const incident = useIncidentEvac(ctx.incidentId)
  const wanted = needsPointQuery({ lon, lat, incidentBbox: ctx.evacBbox, past: ctx.past, incidentData: incident.data })
  const pq = useEvacuations(wanted && lon != null && lat != null ? { bbox: pointQueryBbox(lon, lat) } : null, wanted)
  const point = useMemo(() => ({ data: pq.data, loading: pq.loading, error: pq.error }), [pq.data, pq.loading, pq.error])
  const fw = useFireWeatherQuery()
  const swWanted = needsStatewideFireWeather({ lon, lat, hasIncident: ctx.hasIncident, demo: ctx.demo, past: ctx.past, fallbackArea: ctx.evacBbox, incidentData: fw.data })
  const swq = useJsonQuery<FireWeatherResponse>(swWanted ? fireWeatherStatewideUrl() : null, { refreshMs: OFFICIAL_REFRESH_MS.fireWeather, timeoutMs: 45_000, isCurrent: (d) => d.status === 'available' })
  const statewide = useMemo(() => ({ data: swq.data, loading: swq.loading, error: swq.error }), [swq.data, swq.loading, swq.error])
  const calfire = useRecord(ctx)
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
        pointState,
      }),
    [lon, lat, ctx, incident, wanted, point, pointState],
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
        pointState,
      }),
    [fw, statewide, swWanted, lon, lat, ctx, pointState],
  )
  return useMemo(() => ({ evacuation, fireWeather, calfire, place }), [evacuation, fireWeather, calfire, place])
}

/** Official information for the open fire (I5; the "Official now" block): zones near it, its NWS alerts, its record. */
export function useOfficialNow(): OfficialInfo {
  const ctx = useOfficialContext()
  const incident = useIncidentEvac(ctx.incidentId)
  const fw = useFireWeatherQuery()
  const calfire = useRecord(ctx)
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
