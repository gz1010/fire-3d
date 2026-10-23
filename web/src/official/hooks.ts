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
import { timeFmt } from '../lib/time'
import { useStore } from '../state/store'
import { useTimeFormat } from '../state/timeZone'
import { recordStatus, type RecordStatus } from './record'
import { useOfficialContext, useOfficialPanelTime, type OfficialContext } from './context'
import { fireWeatherStatewideUrl, localAlertsBboxUrl, OFFICIAL_REFRESH_MS } from './client'
import { bboxContains } from './geo'
import { localAlertsAtSelectedPoint, localAlertsState, type LocalAlertsOfficial } from './localAlerts'
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
import type { FireWeatherResponse, LocalAlertsResponse } from './types'

export type { CalFireOfficial, EvacuationOfficial, FireWeatherOfficial, OfficialAlert, OfficialBadge, OfficialZone } from './model'
export { useOfficialContext, useOfficialPanelTime, type OfficialContext } from './context'

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
  /** 5-digit county FIPS of the point (local alerts matched by county), when known. */
  countyFips?: string | null
}

/** The three official answers (I5), plus (brief 3, optional) the point's place. `calfire` is the fire's agency record
 *  (CAL FIRE's or NIFC WFIGS's: a RecordStatus; the field name stays until the integration). */
export interface OfficialInfo {
  evacuation: EvacuationOfficial
  fireWeather: FireWeatherOfficial
  calfire: CalFireOfficial
  place?: OfficialPlace | null
  /** Local officials' messages relayed by NWS / archived by FEMA (brief 3, CONTRACT §14.7; optional for brief-2 shapes). */
  local?: LocalAlertsOfficial
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
    return { status: 'ok', state: d.supported ? d.state : null, stateName: d.supported ? d.state_name : null, timeZone: d.time_zone, coverage: d.coverage, countyFips: d.county?.fips ?? null }
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
  const tf = useTimeFormat()
  // local officials' messages: live at the point's small box; at a past time the fire's own (archive) answer when the
  // point lies in its area, else not checked. Either way measured from the point, keeping the messages whose area
  // reaches it, most relevant first (localAlertsAtPoint; review round 1, R1); the messages left out are the fire's
  // ("elsewhere") only for the fire's answer, else the box's ("nearby"; review round 2, N3). Like NWS fire weather,
  // the point's state decides what "none" means: loading while it is looked up, "not checked" outside the lower 48
  // or when the lookup failed (localAlertsForPointState; review round 2, N2)
  const localLive = !ctx.past && !ctx.demo && lon != null && lat != null && Number.isFinite(lon) && Number.isFinite(lat)
  const lq = useJsonQuery<LocalAlertsResponse>(localLive ? localAlertsBboxUrl(pointQueryBbox(lon as number, lat as number)) : null, {
    refreshMs: OFFICIAL_REFRESH_MS.local,
    timeoutMs: 45_000,
    isCurrent: () => true,
  })
  const incidentLocal = useIncidentLocal(ctx.incidentId)
  const countyFips = place?.countyFips ?? null
  const lookupFailed = place?.status === 'error'
  const local = useMemo(() => {
    const inFireArea = !localLive && ctx.hasIncident && lon != null && lat != null && bboxContains(incidentLocal.data?.area_bbox ?? ctx.evacBbox, lon, lat)
    return localAlertsAtSelectedPoint({
      lon,
      lat,
      demo: ctx.demo,
      // decided at the official time (now, or the replay minute); the card re-decides at its own (localAlertLines)
      live: localLive ? localAlertsState({ data: lq.data, loading: lq.loading, error: lq.error }, { refMs: ctx.refMs }) : null,
      fire: inFireArea ? localAlertsState(incidentLocal, { refMs: ctx.refMs }) : null,
      countyFips,
      pointState,
      lookupFailed,
    })
  }, [ctx, lon, lat, localLive, lq.data, lq.loading, lq.error, incidentLocal, countyFips, pointState, lookupFailed])
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
        tf: place?.timeZone && !ctx.hasIncident ? timeFmt(place.timeZone, tf.clock) : tf,
      }),
    [fw, statewide, swWanted, lon, lat, ctx, pointState, place, tf],
  )
  return useMemo(() => ({ evacuation, fireWeather, calfire, place, local }), [evacuation, fireWeather, calfire, place, local])
}

function useIncidentLocal(incidentId: string | null) {
  const q = useOfficialRuntime(useShallow((s) => ({ data: s.local.data, loading: s.local.loading, error: s.local.error })))
  return useMemo(() => {
    const data = forIncident(q.data, incidentId)
    return data === q.data ? q : { data, loading: true, error: null }
  }, [q, incidentId])
}

/** Official information for the open fire (I5; the "Official now" block): zones near it, its NWS alerts, its record. */
export function useOfficialNow(): OfficialInfo {
  const ctx = useOfficialContext()
  const incident = useIncidentEvac(ctx.incidentId)
  const fw = useFireWeatherQuery()
  const calfire = useRecord(ctx)
  const tf = useTimeFormat()
  const evacuation = useMemo(
    () => evacuationNow(ctx.hasIncident ? incident : null, ctx.fire, { hasIncident: ctx.hasIncident, layerOn: ctx.layerOn, marginKm: DEFAULT_MARGIN_KM.evacuations }),
    [ctx, incident],
  )
  // the overview (no fire open): the national answer's current NWS alerts (scope from states_checked); evacuation
  // zones, the agency record and local alerts need a fire
  const statewide = useOfficialRuntime(useShallow((s) => ({ data: s.statewide.data, loading: s.statewide.loading, error: s.statewide.error })))
  const fireWeather = useMemo(
    () =>
      ctx.hasIncident
        ? fireWeatherNow(fw, ctx.refMs, { demo: ctx.demo, hasIncident: true, tf })
        : fireWeatherNow(statewide, ctx.refMs, { demo: false, hasIncident: false, statewide: true, tf }),
    [fw, statewide, ctx, tf],
  )
  const incidentLocal = useIncidentLocal(ctx.incidentId)
  // local officials' messages: in effect, the order and the short line decided at the panel's own time (the replay
  // minute on screen, or now when live), from each message's own times; never at the query's hour (review round 4)
  const panelMs = useOfficialPanelTime()
  const local = useMemo(
    () =>
      ctx.hasIncident
        ? localAlertsState(incidentLocal, { demo: ctx.demo, refMs: panelMs })
        : { ...localAlertsState(null), reason: "Local officials' alerts are checked for a selected fire, or at an address." },
    [ctx, incidentLocal, panelMs],
  )
  return useMemo(() => ({ evacuation, fireWeather, calfire, local }), [evacuation, fireWeather, calfire, local])
}

/** The phone Updates badge (I5): active official items near the open fire (evacuation zones, NWS fire weather alerts
 *  and local officials' messages) and the most urgent level (none on the overview: the badge is about the open fire).
 *  Local messages are counted at the panel's own time (the replay minute, or now when live; review round 4), the time
 *  the Updates panel it opens lists them at. */
export function useOfficialBadge(): OfficialBadge {
  const { evacuation, fireWeather, local } = useOfficialNow()
  const panelMs = useOfficialPanelTime()
  const open = useStore((s) => s.incidentId != null)
  return useMemo(() => (open ? officialBadge(evacuation, fireWeather, local, panelMs) : { count: 0, level: null }), [open, evacuation, fireWeather, local, panelMs])
}
