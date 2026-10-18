// Pure model behind the official hooks (owner: official-web; CONTRACT §13 I5): turns the evacuation, NWS and CAL
// FIRE answers into explicit states for a point or for the open fire. Honesty rules (BRIEF-2 §3, §5):
// - "none listed" only where Fire-3d actually checked (inside the queried area, for the current time); elsewhere "not
//   checked"; past dates say so; outages say so. No state is ever an all-clear.
// - official wording, issuer and the issuer's own times are kept; Fire-3d's fetch time is only "checked".
// Tested in model.test.ts.
import type { ExtrasQueryState } from '../extras/hooks'
import { evacuationAtPoint, evacuationSourceUrl, NOT_FIRE_SPECIFIC, statusText, zoneIssuer, zoneNearFire, zonesBounds, zonesNearFire, zoneTimes, type ZoneNearFire } from '../extras/evacuation'
import { evacStyleGroup } from '../extras/style'
import type { EvacuationsResponse, EvacZoneFeature } from '../extras/types'
import type { FireReference } from './fire'
import { alertBounds, alertEndMs, alertPhase, alertsAtPoint, alertStartMs, alertTimeText, fireWeatherCredit, IEM_URL, listedAlerts, NWS_ALERTS_URL, senderText, type ListedAlert } from './fireWeather'
import { bboxContains, type BBox } from './geo'
import type { FireWeatherResponse } from './types'
import { httpsUrl } from './url'
import type { CalFireStatus } from './calfire'
import type { FeedItemStatus } from '../ui/feed/types'

export type { CalFireStatus } from './calfire'

// ---- evacuation ------------------------------------------------------------------------------------------------
export type EvacuationState = 'listed' | 'none-listed' | 'not-checked' | 'past-date' | 'unavailable' | 'loading'

export interface OfficialZone {
  id: string
  /** Official status wording, verbatim ("Evacuation Order"). */
  status: string
  /** Styling group of the status (colour / hatch only; the wording is `status`). */
  group: 'order' | 'warning' | 'other'
  /** The issuing jurisdiction as Cal OES names it ("Orange County"), else the county, else "Local officials". */
  issuer: string
  /** Cal OES gives no original issue time today: always absent. */
  issuedMs?: number
  /** The issuer's last edit of the zone. */
  updatedMs?: number
  /** When Cal OES copied it into the statewide layer (shown when the issuer gives no time). */
  listedMs?: number
  /** Distance from the zone to the fire, km (0 = touching; null = the fire's position is not known). */
  distanceKm: number | null
  /** The zone does not touch the fire's analysis area ("Cal OES does not say which fire this is for"). */
  outsideAnalysisArea: boolean
  name: string | null
  /** The official public message, verbatim. */
  message: string | null
}

export interface EvacuationOfficial {
  state: EvacuationState
  zones: OfficialZone[]
  /** When Fire-3d checked Cal OES (null = not checked). */
  checkedMs: number | null
  /** Cal OES's own last update of the statewide layer. */
  sourceUpdatedMs: number | null
  /** Cal OES's data page (https). */
  sourceUrl: string | null
  /** One plain sentence that always comes with the state ("That is not an all-clear: follow local officials."). */
  caveat: string
  /** Why the state is unavailable / not checked / past-date, in plain words. */
  reason?: string | null
  /** Official links: the counties' own evacuation maps. */
  links?: { label: string; url: string }[]
  /** [w, s, e, n] of the listed zones (fit on the map). */
  bounds?: BBox | null
  /** The evacuation map layer is switched off (the data is still checked and listed here). */
  layerOff?: boolean
}

export const CAL_OES_URL = 'https://gis.data.ca.gov/datasets/CalEMA::california-evacuation-aggregation-layer'
export const NOT_ALL_CLEAR = 'That is not an all-clear: follow local officials.'
const PAST_DATE_CAVEAT = 'Official evacuation status is published as current status only, so none is shown for past dates.'

function toOfficialZone(z: ZoneNearFire): OfficialZone {
  const p = z.zone.properties
  const t = zoneTimes(p)
  const g = evacStyleGroup(p.status_key)
  return {
    id: z.zone.id,
    status: statusText(p),
    group: g === 'hidden' ? 'other' : g,
    issuer: zoneIssuer(p),
    ...(t.issuerMs != null ? { updatedMs: t.issuerMs } : {}),
    ...(t.aggregatedMs != null ? { listedMs: t.aggregatedMs } : {}),
    distanceKm: z.distanceKm,
    outsideAnalysisArea: z.outsideAnalysisArea,
    name: p.zone_name,
    message: p.notes,
  }
}

function countyLinks(d: EvacuationsResponse): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = []
  for (const c of d.coverage ?? []) {
    const url = httpsUrl(c.reference_url)
    if (url && !out.some((l) => l.url === url)) out.push({ label: `${c.county} County evacuation map`, url })
  }
  return out
}

/** The state of an evacuation answer (no point): unavailable / past / loading, or null when it is available. */
function envelopeState(q: Pick<ExtrasQueryState<EvacuationsResponse>, 'data' | 'loading' | 'error'> | null): EvacuationOfficial | null {
  const d = q?.data ?? null
  if (!d) {
    if (q?.error) return { state: 'unavailable', zones: [], checkedMs: null, sourceUpdatedMs: null, sourceUrl: CAL_OES_URL, caveat: 'Follow local officials.', reason: q.error }
    return { state: 'loading', zones: [], checkedMs: null, sourceUpdatedMs: null, sourceUrl: CAL_OES_URL, caveat: 'Follow local officials.' }
  }
  const base = { zones: [], checkedMs: d.retrieved_ms, sourceUpdatedMs: d.source_updated_ms, sourceUrl: evacuationSourceUrl(d) ?? CAL_OES_URL }
  if (d.status === 'not_available_for_past_dates') return { ...base, state: 'past-date', caveat: `${PAST_DATE_CAVEAT} Follow local officials.`, reason: d.reason }
  if (d.status === 'unavailable') return { ...base, state: 'unavailable', caveat: 'Follow local officials.', reason: d.reason, links: countyLinks(d) }
  if (q?.error) return { ...base, state: 'unavailable', caveat: 'Follow local officials.', reason: q.error }
  return null
}

/** Official evacuation zones near the open fire (the incident query: its area + the margin). */
export function evacuationNow(q: Pick<ExtrasQueryState<EvacuationsResponse>, 'data' | 'loading' | 'error'> | null, fire: FireReference | null, opts: { hasIncident: boolean; layerOn: boolean; marginKm: number }): EvacuationOfficial {
  if (!opts.hasIncident)
    return { state: 'not-checked', zones: [], checkedMs: null, sourceUpdatedMs: null, sourceUrl: CAL_OES_URL, caveat: 'Follow local officials.', reason: 'Zoom in on a fire or pick one to see the official evacuation zones near it, or check an address.' }
  const env = envelopeState(q)
  const layerOff = !opts.layerOn
  if (env) return { ...env, layerOff }
  const d = q!.data!
  const near = zonesNearFire(d, fire).sort(byUrgency)
  const zones = near.map(toOfficialZone)
  return {
    state: zones.length ? 'listed' : 'none-listed',
    zones,
    checkedMs: d.retrieved_ms,
    sourceUpdatedMs: d.source_updated_ms,
    sourceUrl: evacuationSourceUrl(d) ?? CAL_OES_URL,
    caveat: zones.length ? (zones.every((z) => z.outsideAnalysisArea) ? `${NOT_FIRE_SPECIFIC} Follow local officials.` : 'Follow local officials.') : `No orders or warnings are listed within ${opts.marginKm} km of this fire right now. ${NOT_ALL_CLEAR}`,
    links: countyLinks(d),
    bounds: zonesBounds(near.map((n) => n.zone)),
    layerOff,
  }
}

const URGENCY: Record<OfficialZone['group'], number> = { order: 0, warning: 1, other: 2 }
function byUrgency(a: ZoneNearFire, b: ZoneNearFire): number {
  const ga = evacStyleGroup(a.zone.properties.status_key)
  const gb = evacStyleGroup(b.zone.properties.status_key)
  return URGENCY[ga === 'hidden' ? 'other' : ga] - URGENCY[gb === 'hidden' ? 'other' : gb] || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)
}

export interface EvacuationAtPointInput {
  lon: number | null
  lat: number | null
  /** The open fire's answer (its area + margin), when a fire is open. */
  incident: Pick<ExtrasQueryState<EvacuationsResponse>, 'data' | 'loading' | 'error'> | null
  /** The area the incident query covers (requested bbox), to decide before the answer arrives. */
  incidentBbox: BBox | null
  /** A query around the point itself (used when the point is outside the fire's area). */
  point: Pick<ExtrasQueryState<EvacuationsResponse>, 'data' | 'loading' | 'error'> | null
  /** The timeline position is in the past (historical replay or an earlier live time): current status only. */
  past: boolean
  fire: FireReference | null
}

/** Does the point need its own query (outside the fire's checked area, current time)? */
export function needsPointQuery(i: Pick<EvacuationAtPointInput, 'lon' | 'lat' | 'incidentBbox' | 'past'> & { incidentData: EvacuationsResponse | null }): boolean {
  if (i.lon == null || i.lat == null || !Number.isFinite(i.lon) || !Number.isFinite(i.lat) || i.past) return false
  if (!insideCalifornia(i.lon, i.lat)) return false
  const b = i.incidentData?.bbox ?? i.incidentBbox
  return !bboxContains(b, i.lon, i.lat)
}

/** Rough bounds of California (+ a margin): Cal OES lists zones in California only. */
export function insideCalifornia(lon: number, lat: number): boolean {
  return lon >= -124.9 && lon <= -113.8 && lat >= 32.2 && lat <= 42.3
}

/** A small, cache-friendly query box around a point (±0.005°, centre rounded to 0.001°: it always contains the point). */
export function pointQueryBbox(lon: number, lat: number): BBox {
  const r = (v: number) => Math.round(v * 1000) / 1000
  const d = 0.005
  return [r(lon) - d, r(lat) - d, r(lon) + d, r(lat) + d].map((v) => Math.round(v * 1e4) / 1e4) as BBox
}

function atPoint(d: EvacuationsResponse, lon: number, lat: number, fire: FireReference | null): EvacuationOfficial | null {
  const r = evacuationAtPoint(d, lon, lat)
  if (!r.checked) return null
  const shown = r.zones.filter((z) => evacStyleGroup(z.properties.status_key) !== 'hidden')
  const zones = shown.map((z: EvacZoneFeature) => toOfficialZone(zoneNearFire(z, fire)))
  return {
    state: zones.length ? 'listed' : 'none-listed',
    zones,
    checkedMs: d.retrieved_ms,
    sourceUpdatedMs: d.source_updated_ms,
    sourceUrl: evacuationSourceUrl(d) ?? CAL_OES_URL,
    caveat: zones.length ? (zones.some((z) => z.outsideAnalysisArea) && fire?.aoi ? `${NOT_FIRE_SPECIFIC} Follow local officials.` : 'Follow local officials.') : `No orders or warnings are listed at this point right now. ${NOT_ALL_CLEAR}`,
    links: countyLinks(d),
    bounds: zonesBounds(shown),
  }
}

/** Official evacuation status at a point (I5 `evacuation`). */
export function evacuationAtPointState(i: EvacuationAtPointInput): EvacuationOfficial {
  const notChecked = (reason: string): EvacuationOfficial => ({ state: 'not-checked', zones: [], checkedMs: null, sourceUpdatedMs: null, sourceUrl: CAL_OES_URL, caveat: 'Follow local officials.', reason })
  if (i.lon == null || i.lat == null || !Number.isFinite(i.lon) || !Number.isFinite(i.lat)) return notChecked('No location selected.')
  if (i.past)
    return { state: 'past-date', zones: [], checkedMs: null, sourceUpdatedMs: null, sourceUrl: CAL_OES_URL, caveat: `${PAST_DATE_CAVEAT} Follow local officials.`, reason: 'Official status is shown only for the current time.' }
  const inc = i.incident?.data ?? null
  if (inc && inc.status === 'available') {
    const r = atPoint(inc, i.lon, i.lat, i.fire)
    if (r) return r
  } else if (bboxContains(i.incidentBbox, i.lon, i.lat)) {
    // inside the fire's area: its answer decides (loading, past date, outage)
    const env = envelopeState(i.incident)
    if (env) return env
  }
  if (!insideCalifornia(i.lon, i.lat)) return notChecked('Cal OES lists evacuation zones in California only.')
  const env = envelopeState(i.point)
  if (env) return env
  const r = atPoint(i.point!.data!, i.lon, i.lat, i.fire)
  return r ?? notChecked("Not checked here: Fire-3d reads Cal OES zones only near the selected fire and the selected point.")
}

/** Zones grouped by (official wording, issuer), most urgent first. */
export interface ZoneGroup {
  status: string
  issuer: string
  group: OfficialZone['group']
  zones: OfficialZone[]
  /** Nearest zone of the group (km). */
  distanceKm: number | null
  outsideAnalysisArea: boolean
  updatedMs: number | null
  listedMs: number | null
}

export function groupZones(zones: readonly OfficialZone[]): ZoneGroup[] {
  const m = new Map<string, ZoneGroup>()
  for (const z of zones) {
    const k = `${z.status}|${z.issuer}`
    const g = m.get(k) ?? { status: z.status, issuer: z.issuer, group: z.group, zones: [], distanceKm: null, outsideAnalysisArea: true, updatedMs: null, listedMs: null }
    g.zones.push(z)
    if (z.distanceKm != null) g.distanceKm = g.distanceKm == null ? z.distanceKm : Math.min(g.distanceKm, z.distanceKm)
    g.outsideAnalysisArea = g.outsideAnalysisArea && z.outsideAnalysisArea
    if (z.updatedMs != null) g.updatedMs = Math.max(g.updatedMs ?? 0, z.updatedMs)
    if (z.listedMs != null) g.listedMs = Math.max(g.listedMs ?? 0, z.listedMs)
    m.set(k, g)
  }
  const rank = { order: 0, warning: 1, other: 2 }
  return [...m.values()].sort((a, b) => rank[a.group] - rank[b.group] || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9))
}

// ---- NWS fire weather ------------------------------------------------------------------------------------------
export type FireWeatherState = 'active' | 'none' | 'past-date' | 'unavailable' | 'loading'

export interface OfficialAlert {
  id: string
  /** NWS wording, verbatim ("Red Flag Warning"). */
  event: string
  senderName: string
  onsetMs?: number
  endsMs?: number
  expiresMs?: number
  /** The NWS headline, verbatim ('' when NWS gives none). */
  headline: string
  url: string | null
  archived: boolean
  // ---- additions
  /** Where the alert stands at the reference time (now, or the replay time). */
  phase: FeedItemStatus
  /** "until Oct 20, 18:00 PDT" / "Expired Oct 17, 18:00 PDT". */
  timeText: string
  sentMs?: number
  coversReportedLocation: boolean | null
  nearestKm: number | null
  ugcs: string[]
  /** [w, s, e, n] of its zones (fit on the map). */
  bounds: BBox | null
}

export interface FireWeatherOfficial {
  state: FireWeatherState
  /** Listed alerts, most relevant first: in effect, upcoming, then expired (48 h) and cancelled. */
  alerts: OfficialAlert[]
  checkedMs: number | null
  // ---- additions
  /** The answer is an archived copy (IEM) of NWS products. */
  archived: boolean
  /** "National Weather Service" or "National Weather Service via Iowa Environmental Mesonet archive". */
  credit: string
  sourceUrl: string
  /** 'not_checked' = outside the area Fire-3d checked (state 'unavailable'); 'demo'; or the backend's reason code. */
  reasonCode?: string | null
  reason?: string | null
  /** Always present: "A fire weather alert is a weather warning, not an evacuation order." etc. */
  caveat: string
}

const FW_CAVEAT = 'A fire weather alert is a weather warning, not an evacuation order. Follow local officials.'
const FW_NONE = 'No Red Flag Warning or Fire Weather Watch is listed here. That is not an all-clear: follow local officials.'

function toOfficialAlert(d: FireWeatherResponse, a: ListedAlert, refMs: number): OfficialAlert {
  const phase = alertPhase(a, refMs)
  const start = alertStartMs(a)
  const end = alertEndMs(a)
  return {
    id: a.id,
    event: a.event,
    senderName: senderText(a),
    ...(start != null ? { onsetMs: start } : {}),
    ...(a.ends_ms != null ? { endsMs: a.ends_ms } : end != null && a.expires_ms == null ? { endsMs: end } : {}),
    ...(a.expires_ms != null ? { expiresMs: a.expires_ms } : {}),
    ...(a.sent_ms != null ? { sentMs: a.sent_ms } : {}),
    headline: a.headline?.trim() ?? '',
    url: httpsUrl(a.url),
    archived: a.archived === true,
    phase,
    timeText: alertTimeText(a, phase, refMs),
    coversReportedLocation: a.covers_reported_location ?? null,
    nearestKm: a.nearest_km ?? null,
    ugcs: a.ugcs ?? [],
    bounds: alertBounds(d, a),
  }
}

const PHASE_ORDER: Record<FeedItemStatus, number> = { active: 0, upcoming: 1, expired: 2, cancelled: 3 }
const sortAlerts = (a: OfficialAlert, b: OfficialAlert) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || (b.sentMs ?? 0) - (a.sentMs ?? 0)

function fwBase(d: FireWeatherResponse | null): Pick<FireWeatherOfficial, 'checkedMs' | 'archived' | 'credit' | 'sourceUrl'> {
  const archived = !!d && (d.alerts.some((a) => a.archived) || /mesonet/i.test(d.source?.name ?? ''))
  return { checkedMs: d?.retrieved_ms ?? null, archived, credit: fireWeatherCredit(archived), sourceUrl: httpsUrl(d?.source?.url) ?? (archived ? IEM_URL : NWS_ALERTS_URL) }
}

function fwEnvelope(q: Pick<ExtrasQueryState<FireWeatherResponse>, 'data' | 'loading' | 'error'> | null, opts: { demo: boolean; hasIncident: boolean }): FireWeatherOfficial | null {
  if (opts.demo) return { state: 'unavailable', alerts: [], ...fwBase(null), reasonCode: 'demo', reason: 'Demo data: NWS alerts are not checked for simulated incidents.', caveat: FW_CAVEAT }
  if (!opts.hasIncident) return { state: 'unavailable', alerts: [], ...fwBase(null), reasonCode: 'not_checked', reason: 'Fire weather alerts are checked for a selected fire.', caveat: FW_CAVEAT }
  const d = q?.data ?? null
  if (!d) {
    if (q?.error) return { state: 'unavailable', alerts: [], ...fwBase(null), reasonCode: 'request_error', reason: q.error, caveat: FW_CAVEAT }
    return { state: 'loading', alerts: [], ...fwBase(null), caveat: FW_CAVEAT }
  }
  if (d.status === 'not_available_for_past_dates')
    return { state: 'past-date', alerts: [], ...fwBase(d), reasonCode: d.reason_code ?? 'past_date', reason: d.reason ?? 'Past NWS alerts are not available for this time.', caveat: FW_CAVEAT }
  if (d.status === 'unavailable') return { state: 'unavailable', alerts: [], ...fwBase(d), reasonCode: d.reason_code ?? 'upstream_error', reason: d.reason, caveat: FW_CAVEAT }
  return null
}

/** NWS fire weather alerts for the open fire (I5 `fireWeather` of useOfficialNow), or for all of California on the
 *  overview (`statewide`: the answer without an incident). */
export function fireWeatherNow(
  q: Pick<ExtrasQueryState<FireWeatherResponse>, 'data' | 'loading' | 'error'> | null,
  refMs: number,
  opts: { demo: boolean; hasIncident: boolean; statewide?: boolean },
): FireWeatherOfficial {
  const env = fwEnvelope(q, { demo: opts.demo, hasIncident: opts.hasIncident || !!opts.statewide })
  if (env) return env
  const d = q!.data!
  const alerts = listedAlerts(d, refMs)
    .map((a) => toOfficialAlert(d, a, refMs))
    .sort(sortAlerts)
  const inEffect = alerts.some((a) => a.phase === 'active' || a.phase === 'upcoming')
  return {
    state: inEffect ? 'active' : 'none',
    alerts,
    ...fwBase(d),
    caveat: inEffect
      ? FW_CAVEAT
      : `No Red Flag Warning or Fire Weather Watch is listed ${opts.statewide ? 'in California' : 'near this fire'}. That is not an all-clear: follow local officials.`,
  }
}

/** Alerts covering a point in one answer: 'active' when one is in effect or upcoming, else 'none'. */
function alertsHere(d: FireWeatherResponse, lon: number, lat: number, refMs: number): FireWeatherOfficial {
  const alerts = listedAlerts({ alerts: alertsAtPoint(d, lon, lat) }, refMs)
    .map((a) => toOfficialAlert(d, a, refMs))
    .filter((a) => a.phase === 'active' || a.phase === 'upcoming')
    .sort(sortAlerts)
  if (alerts.length) return { state: 'active', alerts, ...fwBase(d), caveat: FW_CAVEAT }
  return { state: 'none', alerts: [], ...fwBase(d), caveat: FW_NONE }
}

export interface FireWeatherAtPointInput {
  lon: number | null
  lat: number | null
  refMs: number
  /** The open fire's answer (live, or archived for a past time). */
  incident: Pick<ExtrasQueryState<FireWeatherResponse>, 'data' | 'loading' | 'error'> | null
  /** The statewide answer (current time only), for points outside the fire's area and the overview. */
  statewide: Pick<ExtrasQueryState<FireWeatherResponse>, 'data' | 'loading' | 'error'> | null
  hasIncident: boolean
  demo: boolean
  /** The timeline stands for a past time. */
  past: boolean
  /** The fire's checked area before its answer arrives (its analysis area + 15 km, like the backend's area_bbox). */
  fallbackArea: BBox | null
}

/** Does the point need the statewide answer (current time, outside the open fire's checked area, in California)? */
export function needsStatewideFireWeather(i: Pick<FireWeatherAtPointInput, 'lon' | 'lat' | 'hasIncident' | 'demo' | 'past' | 'fallbackArea'> & { incidentData: FireWeatherResponse | null }): boolean {
  if (i.lon == null || i.lat == null || !Number.isFinite(i.lon) || !Number.isFinite(i.lat) || i.demo) return false
  if (!insideCalifornia(i.lon, i.lat)) return false
  if (!i.hasIncident) return true
  if (i.past) return false
  return !bboxContains(i.incidentData?.area_bbox ?? i.fallbackArea, i.lon, i.lat)
}

/**
 * NWS fire weather alerts at a point (I5 `fireWeather` of useOfficialAtPoint). Inside the open fire's checked area its
 * answer decides (live, or the archived copy for a past time); elsewhere the statewide answer (current time only),
 * where "none" holds anywhere in California. Past times outside the fire's area, and points outside California, are
 * 'past-date' / 'unavailable' with reasonCode 'not_checked'.
 */
export function fireWeatherAtPointState(i: FireWeatherAtPointInput): FireWeatherOfficial {
  if (i.demo) return fwEnvelope(null, { demo: true, hasIncident: i.hasIncident })!
  if (i.lon == null || i.lat == null || !Number.isFinite(i.lon) || !Number.isFinite(i.lat))
    return { state: 'unavailable', alerts: [], ...fwBase(null), reasonCode: 'not_checked', reason: 'No location selected.', caveat: FW_CAVEAT }
  if (i.hasIncident) {
    const d = i.incident?.data ?? null
    if (bboxContains(d?.area_bbox ?? i.fallbackArea, i.lon, i.lat)) {
      const env = fwEnvelope(i.incident, { demo: false, hasIncident: true })
      return env ?? alertsHere(d!, i.lon, i.lat, i.refMs)
    }
    if (i.past)
      return {
        state: 'past-date',
        alerts: [],
        ...fwBase(d),
        reasonCode: 'past_date',
        reason: "Past fire weather alerts are shown only for the selected fire's area.",
        caveat: FW_CAVEAT,
      }
  }
  if (!insideCalifornia(i.lon, i.lat)) return { state: 'unavailable', alerts: [], ...fwBase(null), reasonCode: 'not_checked', reason: 'Fire-3d checks NWS fire weather alerts in California only.', caveat: FW_CAVEAT }
  const env = fwEnvelope(i.statewide, { demo: false, hasIncident: true })
  return env ?? alertsHere(i.statewide!.data!, i.lon, i.lat, i.refMs)
}

// ---- badge -----------------------------------------------------------------------------------------------------
export interface OfficialBadge {
  /** Active official items: evacuation (status, issuer) groups of orders / shelter / warnings near the fire, plus NWS
   *  alerts in effect (or upcoming) at the reference time. */
  count: number
  /** The most urgent: an order (or shelter in place), a warning, a fire weather alert, or none. */
  level: 'order' | 'warning' | 'fire-weather' | null
}

export function officialBadge(evac: EvacuationOfficial, fw: FireWeatherOfficial): OfficialBadge {
  const groups = new Set<string>()
  let level: OfficialBadge['level'] = null
  if (evac.state === 'listed') {
    for (const z of evac.zones) {
      if (z.group === 'other') continue
      groups.add(`${z.status}|${z.issuer}`)
      if (z.group === 'order') level = 'order'
      else if (level !== 'order') level = 'warning'
    }
  }
  const alerts = fw.state === 'active' ? fw.alerts.filter((a) => a.phase === 'active' || a.phase === 'upcoming').length : 0
  if (alerts && !level) level = 'fire-weather'
  return { count: groups.size + alerts, level }
}

// ---- CAL FIRE ---------------------------------------------------------------------------------------------------
/** The I5 `calfire` shape (CalFireStatus: state, acres?, percentContained?, isActive?, updatedMs?, url? + extras). */
export type CalFireOfficial = CalFireStatus

/** End of the hazard for display, used by the card line ("until …"). */
export const officialAlertEnd = (a: Pick<OfficialAlert, 'endsMs' | 'expiresMs'>): number | null => a.endsMs ?? a.expiresMs ?? null
