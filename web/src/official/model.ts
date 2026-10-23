// Pure model behind the official hooks (owner: official-web; CONTRACT §13 I5): turns the evacuation, NWS and CAL
// FIRE answers into explicit states for a point or for the open fire. Honesty rules (BRIEF-2 §3, §5):
// - "none listed" only where Fire-3d actually checked (inside the queried area, for the current time); elsewhere "not
//   checked"; past dates say so; outages say so. No state is ever an all-clear.
// - official wording, issuer and the issuer's own times are kept; Fire-3d's fetch time is only "checked".
// Tested in model.test.ts.
import type { ExtrasQueryState } from '../extras/hooks'
import {
  aggregatorOf,
  answeredNames,
  answeredSources,
  evacuationAtPoint,
  evacuationSourceUrl,
  hazardNote,
  incidentNameNote,
  notFireSpecific,
  sourceHomeState,
  statusLabel,
  statusLevelNote,
  statusText,
  zoneIssuer,
  zoneListedPhrase,
  zoneNearFire,
  zonesBounds,
  zonesNearFire,
  zoneSourceId,
  zoneTimes,
  type ZoneNearFire,
} from '../extras/evacuation'
import { evacStyleGroup } from '../extras/style'
import type { EvacStateEntry, EvacuationsResponse, EvacZoneFeature } from '../extras/types'
import type { FireReference } from './fire'
import { alertBounds, alertEndMs, alertPhase, alertsAtPoint, alertStartMs, alertTimeText, fireWeatherCredit, IEM_URL, listedAlerts, NWS_ALERTS_URL, senderText, type ListedAlert } from './fireWeather'
import { bboxContains, type BBox } from './geo'
import type { FireWeatherResponse } from './types'
import { stateName } from '../lib/usStates'
import { httpsUrl } from './url'
import type { CalFireStatus } from './calfire'
import type { RecordStatus } from './record'
import type { FeedItemStatus } from '../ui/feed/types'

export type { CalFireStatus } from './calfire'

// ---- evacuation ------------------------------------------------------------------------------------------------
/** 'not-available' (brief 3, CONTRACT §14.8.5): a state without an official, free, public, machine-readable evacuation
 *  feed ("Not available in this state (Nevada)"); never "none". */
export type EvacuationState = 'listed' | 'none-listed' | 'not-checked' | 'not-available' | 'past-date' | 'unavailable' | 'loading'

export interface OfficialZone {
  id: string
  /** Official status wording, verbatim ("Evacuation Order"); for Oregon, OEM's definition of its level ("Level 3: GO
   *  NOW – Leave Immediately!", see `levelNote`). */
  status: string
  /** Styling group of the status (colour / hatch only; the wording is `status`). */
  group: 'order' | 'warning' | 'other'
  /** The issuing jurisdiction as the source names it ("Orange County"), else the county, else "Local officials". */
  issuer: string
  /** The sources give no original issue time today: always absent. */
  issuedMs?: number
  /** The issuer's last edit of the zone. */
  updatedMs?: number
  /** When the state layer listed it (Cal OES's copy time; when it was added to the Oregon state layer), shown when the
   *  issuer gives no time. */
  listedMs?: number
  /** Distance from the zone to the fire, km (0 = touching; null = the fire's position is not known). */
  distanceKm: number | null
  /** The zone does not touch the fire's analysis area ("<aggregator> does not say which fire this is for"). */
  outsideAnalysisArea: boolean
  name: string | null
  /** The official public message, verbatim. */
  message: string | null
  // ---- brief 3 (optional: brief-2 shapes stay valid)
  /** Which source listed it ('caloes_evacuations', 'or_oem_evacuations'). */
  sourceId?: string
  /** "Cal OES", "Oregon OEM". */
  aggregator?: string
  /** What `listedMs` means: "listed by Cal OES", "added to the Oregon state layer". */
  listedPhrase?: string
  /** False when `status` is not the source's own text (Oregon's level number rendered by Fire-3d). */
  verbatim?: boolean
  /** Says so: '"Level 3" is Fire-3d's wording of Oregon OEM's level number; Oregon OEM defines it as "…"'. */
  levelNote?: string | null
  /** "Evacuation for: Other, as recorded by Oregon OEM" (not a fire). */
  hazardNote?: string | null
  /** "Fire name as recorded by Oregon OEM: …; a name match is not proof it is this fire". */
  incidentNote?: string | null
  /** USPS code of the zone's state. */
  state?: string | null
}

/** One evacuation source of the answer, with its own times (CONTRACT §14.8.2 `sources[]`). */
export interface EvacuationSourceInfo {
  id: string
  /** "Cal OES", "Oregon OEM". */
  aggregator: string
  /** Credit line ("Oregon Department of Emergency Management"). */
  credit: string
  /** Its data page (https). */
  url: string | null
  homeState: string | null
  answered: boolean
  /** When Fire-3d checked it. */
  checkedMs: number | null
  /** The layer's own last update. */
  updatedMs: number | null
  reason: string | null
}

export interface EvacuationOfficial {
  state: EvacuationState
  zones: OfficialZone[]
  /** When Fire-3d checked the source (null = not checked; several sources: the oldest check). */
  checkedMs: number | null
  /** The source's own last update of its statewide layer (one source only; else per source in `sources`). */
  sourceUpdatedMs: number | null
  /** The source's data page (https). */
  sourceUrl: string | null
  /** One plain sentence that always comes with the state ("That is not an all-clear: follow local officials."). */
  caveat: string
  /** Why the state is unavailable / not checked / not available / past-date, in plain words. */
  reason?: string | null
  /** Official links: the counties' own evacuation maps. */
  links?: { label: string; url: string }[]
  /** [w, s, e, n] of the listed zones (fit on the map). */
  bounds?: BBox | null
  /** The evacuation map layer is switched off (the data is still checked and listed here). */
  layerOff?: boolean
  // ---- brief 3
  /** The sources of the answer (zone layers only), each with its own times. */
  sources?: EvacuationSourceInfo[]
  /** "Cal OES", "Oregon OEM" or "Cal OES and Oregon OEM": who was checked (null = nobody). */
  checkedBy?: string | null
  /** The states without a feed that the area touches ("Nevada"). */
  notAvailableIn?: string[]
}

export const CAL_OES_URL = 'https://gis.data.ca.gov/datasets/CalEMA::california-evacuation-aggregation-layer'

/** Who the evacuation answer's sources are ("Cal OES", "Oregon OEM", "Cal OES and Oregon OEM"): the sources checked,
 *  else every source of the answer; a brief-2 answer: Cal OES; null for a state without a feed. */
export function evacuationWho(e: Pick<EvacuationOfficial, 'state' | 'checkedBy' | 'sources'>): string | null {
  if (e.state === 'not-available') return null
  if (e.checkedBy) return e.checkedBy
  const names = [...new Set((e.sources ?? []).map((s) => s.aggregator))]
  return names.length ? names.join(' and ') : e.sources ? null : 'Cal OES'
}
export const NOT_ALL_CLEAR = 'That is not an all-clear: follow local officials.'
const PAST_DATE_CAVEAT = 'Official evacuation status is published as current status only, so none is shown for past dates.'

function toOfficialZone(z: ZoneNearFire, d: Pick<EvacuationsResponse, 'sources'> | null): OfficialZone {
  const p = z.zone.properties
  const t = zoneTimes(p)
  const g = evacStyleGroup(p.status_key)
  const sourceId = zoneSourceId(p)
  const label = statusLabel(p)
  return {
    id: z.zone.id,
    status: label ?? statusText(p),
    group: g === 'hidden' ? 'other' : g,
    issuer: zoneIssuer(p),
    ...(t.issuerMs != null ? { updatedMs: t.issuerMs } : {}),
    ...(t.listedMs != null ? { listedMs: t.listedMs } : {}),
    distanceKm: z.distanceKm,
    outsideAnalysisArea: z.outsideAnalysisArea,
    name: p.zone_name,
    message: p.notes,
    sourceId,
    aggregator: aggregatorOf(d, sourceId),
    listedPhrase: zoneListedPhrase(p),
    verbatim: p.status_verbatim !== false,
    levelNote: statusLevelNote(p),
    hazardNote: hazardNote(p),
    incidentNote: incidentNameNote(p),
    state: p.state ?? null,
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

/** The answer's zone sources with their own times (an older backend: Cal OES with the envelope's times). */
export function evacuationSources(d: EvacuationsResponse): EvacuationSourceInfo[] {
  const answered = new Set(answeredSources(d).map((s) => s.id))
  return d.sources
    .filter((s) => s.id === 'caloes_evacuations' || s.id === 'or_oem_evacuations')
    .map((s) => ({
      id: s.id,
      aggregator: aggregatorOf(d, s.id),
      credit: s.credit ?? (s.id === 'caloes_evacuations' ? 'Cal OES' : s.publisher),
      url: httpsUrl(s.url),
      homeState: sourceHomeState(d, s.id),
      answered: answered.has(s.id),
      checkedMs: s.retrieved_ms !== undefined ? s.retrieved_ms : d.retrieved_ms,
      updatedMs: s.updated_ms !== undefined ? s.updated_ms : d.source_updated_ms,
      reason: s.reason ?? null,
    }))
}

/** "Nevada", "Nevada and Utah": the states without a feed that the area touches. */
function notAvailableStates(d: EvacuationsResponse): string[] {
  return (d.states ?? []).filter((x) => x.availability === 'not_available').map((x) => x.name)
}

/** "Not available in this state (Nevada)" (CONTRACT §14.8.5), else the backend's own reason (outside the lower 48). */
export function notAvailableReason(states: string[], fallback: string | null): string {
  if (states.length === 1) return `Not available in this state (${states[0]})`
  if (states.length > 1) return `Not available in these states (${states.join(', ')})`
  return withoutFollowText(fallback) ?? 'Not available here'
}

const withoutFollowText = (s: string | null | undefined): string | null => (s ? s.replace(/\s*Follow local officials\.?\s*$/i, '').trim() || null : null)

/** Shared fields of an answer: the sources, who was checked, their times, the data page. */
function answerBase(d: EvacuationsResponse) {
  const sources = evacuationSources(d)
  const ans = sources.filter((s) => s.answered)
  const checked = ans.map((s) => s.checkedMs).filter((t): t is number => t != null)
  return {
    sources,
    checkedBy: answeredNames(d),
    notAvailableIn: notAvailableStates(d),
    checkedMs: ans.length > 1 ? (checked.length ? Math.min(...checked) : null) : d.retrieved_ms,
    sourceUpdatedMs: ans.length === 1 ? ans[0].updatedMs : d.source_updated_ms,
    sourceUrl: evacuationSourceUrl(d) ?? (d.sources.length ? CAL_OES_URL : null),
  }
}

/** The state of an evacuation answer (no point): unavailable / not available / past / loading, or null when it is
 *  available. */
function envelopeState(q: Pick<ExtrasQueryState<EvacuationsResponse>, 'data' | 'loading' | 'error'> | null): EvacuationOfficial | null {
  const d = q?.data ?? null
  if (!d) {
    if (q?.error) return { state: 'unavailable', zones: [], checkedMs: null, sourceUpdatedMs: null, sourceUrl: null, caveat: 'Follow local officials.', reason: q.error }
    return { state: 'loading', zones: [], checkedMs: null, sourceUpdatedMs: null, sourceUrl: null, caveat: 'Follow local officials.' }
  }
  const base = { zones: [], ...answerBase(d) }
  if (d.status === 'unavailable' && d.reason_code === 'state_not_available')
    return { ...base, state: 'not-available', checkedMs: null, sourceUpdatedMs: null, sourceUrl: null, caveat: 'Follow local officials.', reason: notAvailableReason(base.notAvailableIn, d.reason), links: stateLinks(d) }
  if (d.status === 'not_available_for_past_dates') return { ...base, state: 'past-date', caveat: `${PAST_DATE_CAVEAT} Follow local officials.`, reason: d.reason }
  if (d.status === 'unavailable') return { ...base, state: 'unavailable', caveat: 'Follow local officials.', reason: d.reason, links: countyLinks(d) }
  if (q?.error) return { ...base, state: 'unavailable', caveat: 'Follow local officials.', reason: q.error }
  return null
}

/** Official links of the states the answer touches (https only). */
function stateLinks(d: EvacuationsResponse): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = []
  for (const st of d.states ?? []) for (const l of st.links ?? []) if (httpsUrl(l.url) && !out.some((x) => x.url === l.url)) out.push({ label: l.label, url: l.url })
  return out
}

/** Official evacuation zones near the open fire (the incident query: its area + the margin). */
export function evacuationNow(q: Pick<ExtrasQueryState<EvacuationsResponse>, 'data' | 'loading' | 'error'> | null, fire: FireReference | null, opts: { hasIncident: boolean; layerOn: boolean; marginKm: number }): EvacuationOfficial {
  if (!opts.hasIncident)
    return { state: 'not-checked', zones: [], checkedMs: null, sourceUpdatedMs: null, sourceUrl: null, caveat: 'Follow local officials.', reason: 'Zoom in on a fire or pick one to see the official evacuation zones near it, or check an address.' }
  const env = envelopeState(q)
  const layerOff = !opts.layerOn
  if (env) return { ...env, layerOff }
  const d = q!.data!
  const near = zonesNearFire(d, fire).sort(byUrgency)
  const zones = near.map((z) => toOfficialZone(z, d))
  const base = answerBase(d)
  const outsideAll = zones.length > 0 && zones.every((z) => z.outsideAnalysisArea)
  const notFire = [...new Set(zones.map((z) => z.aggregator ?? 'Cal OES'))].map(notFireSpecific).join(' ')
  return {
    state: zones.length ? 'listed' : 'none-listed',
    zones,
    ...base,
    caveat: zones.length ? (outsideAll ? `${notFire} Follow local officials.` : 'Follow local officials.') : `No orders or warnings are listed within ${opts.marginKm} km of this fire right now. ${NOT_ALL_CLEAR}`,
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
  /** The point's state (USPS, from /api/geo/lookup): undefined while unknown, null outside the lower 48 or when the
   *  lookup failed. Needed only when an answer covers several states that were not all checked (a border area). */
  pointState?: string | null
}

/** Does the point need its own query (outside the fire's checked area, current time)? Asked everywhere: the backend
 *  answers a state without a feed from its registry, without an upstream request (no client-side state boxes). */
export function needsPointQuery(i: Pick<EvacuationAtPointInput, 'lon' | 'lat' | 'incidentBbox' | 'past'> & { incidentData: EvacuationsResponse | null }): boolean {
  if (i.lon == null || i.lat == null || !Number.isFinite(i.lon) || !Number.isFinite(i.lat) || i.past) return false
  const b = i.incidentData?.bbox ?? i.incidentBbox
  return !bboxContains(b, i.lon, i.lat)
}

/** Rough bounds of California (+ a margin).
 *  @deprecated Brief 3: no evacuation or NWS path uses it any more (the backend's registry and `states_checked`
 *  decide); kept until the integration removes it. */
export function insideCalifornia(lon: number, lat: number): boolean {
  return lon >= -124.9 && lon <= -113.8 && lat >= 32.2 && lat <= 42.3
}

/** A small, cache-friendly query box around a point (±0.005°, centre rounded to 0.001°: it always contains the point). */
export function pointQueryBbox(lon: number, lat: number): BBox {
  const r = (v: number) => Math.round(v * 1000) / 1000
  const d = 0.005
  return [r(lon) - d, r(lat) - d, r(lon) + d, r(lat) + d].map((v) => Math.round(v * 1e4) / 1e4) as BBox
}

/** The point's own state in an answer that covers several states: its `states[]` entry, `'unknown'` while the point's
 *  state is not known (and it matters), or null when the answer covers one state (or none listed). */
function pointStateEntry(d: EvacuationsResponse, pointState: string | null | undefined): EvacStateEntry | 'unknown' | null {
  const states = d.states ?? []
  if (states.length <= 1) return states[0] ?? null
  if (states.every((x) => x.checked)) return null
  if (pointState === undefined) return 'unknown'
  return states.find((x) => x.state === pointState) ?? null
}

function atPoint(d: EvacuationsResponse, lon: number, lat: number, fire: FireReference | null, pointState: string | null | undefined): EvacuationOfficial | null {
  const r = evacuationAtPoint(d, lon, lat)
  if (!r.checked) return null
  const base = answerBase(d)
  const entry = pointStateEntry(d, pointState)
  if (entry === 'unknown') return { state: 'loading', zones: [], ...base, caveat: 'Follow local officials.' }
  if (entry && !entry.checked) {
    if (entry.availability === 'not_available')
      return { state: 'not-available', zones: [], ...base, checkedMs: null, sourceUpdatedMs: null, sourceUrl: null, caveat: 'Follow local officials.', reason: notAvailableReason([entry.name], null), links: [] }
    const src = base.sources.find((x) => x.homeState === entry.state)
    return { state: 'unavailable', zones: [], ...base, caveat: 'Follow local officials.', reason: src?.reason ?? `${entry.name}'s evacuation source could not be checked.` }
  }
  const shown = r.zones.filter((z) => evacStyleGroup(z.properties.status_key) !== 'hidden')
  const zones = shown.map((z: EvacZoneFeature) => toOfficialZone(zoneNearFire(z, fire), d))
  const notFire = [...new Set(zones.map((z) => z.aggregator ?? 'Cal OES'))].map(notFireSpecific).join(' ')
  return {
    state: zones.length ? 'listed' : 'none-listed',
    zones,
    ...base,
    // the point's own source when the area covers several (a border point): its check time and its name
    ...(entry && base.sources.length > 1 ? pointSource(base.sources, entry.state) : {}),
    caveat: zones.length ? (zones.some((z) => z.outsideAnalysisArea) && fire?.aoi ? `${notFire} Follow local officials.` : 'Follow local officials.') : `No orders or warnings are listed at this point right now. ${NOT_ALL_CLEAR}`,
    links: countyLinks(d),
    bounds: zonesBounds(shown),
  }
}

function pointSource(sources: EvacuationSourceInfo[], state: string): Partial<EvacuationOfficial> {
  const s = sources.find((x) => x.homeState === state && x.answered)
  return s ? { checkedBy: s.aggregator, checkedMs: s.checkedMs, sourceUpdatedMs: s.updatedMs, sourceUrl: s.url } : {}
}

/** Official evacuation status at a point (I5 `evacuation`). */
export function evacuationAtPointState(i: EvacuationAtPointInput): EvacuationOfficial {
  const notChecked = (reason: string): EvacuationOfficial => ({ state: 'not-checked', zones: [], checkedMs: null, sourceUpdatedMs: null, sourceUrl: null, caveat: 'Follow local officials.', reason })
  if (i.lon == null || i.lat == null || !Number.isFinite(i.lon) || !Number.isFinite(i.lat)) return notChecked('No location selected.')
  if (i.past)
    return { state: 'past-date', zones: [], checkedMs: null, sourceUpdatedMs: null, sourceUrl: null, caveat: `${PAST_DATE_CAVEAT} Follow local officials.`, reason: 'Official status is shown only for the current time.' }
  const inc = i.incident?.data ?? null
  if (inc && inc.status === 'available') {
    const r = atPoint(inc, i.lon, i.lat, i.fire, i.pointState)
    if (r) return r
  } else if (bboxContains(inc?.bbox ?? i.incidentBbox, i.lon, i.lat)) {
    // inside the fire's area: its answer decides (loading, not available in this state, past date, outage)
    const env = envelopeState(i.incident)
    if (env) return env
  }
  const env = envelopeState(i.point)
  if (env) return env
  const r = atPoint(i.point!.data!, i.lon, i.lat, i.fire, i.pointState)
  return r ?? notChecked('Not checked here: Fire-3d reads official evacuation zones only near the selected fire and the selected point.')
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
  // ---- brief 3
  /** "Cal OES", "Oregon OEM". */
  aggregator: string
  /** "listed by Cal OES", "added to the Oregon state layer". */
  listedPhrase: string
  /** False for Oregon's levels (Fire-3d's wording of OEM's level number, with OEM's definition). */
  verbatim: boolean
}

export function groupZones(zones: readonly OfficialZone[]): ZoneGroup[] {
  const m = new Map<string, ZoneGroup>()
  for (const z of zones) {
    const k = `${z.status}|${z.issuer}|${z.sourceId ?? ''}`
    const agg = z.aggregator ?? 'Cal OES'
    const g = m.get(k) ?? { status: z.status, issuer: z.issuer, group: z.group, zones: [], distanceKm: null, outsideAnalysisArea: true, updatedMs: null, listedMs: null, aggregator: agg, listedPhrase: z.listedPhrase ?? `listed by ${agg}`, verbatim: z.verbatim !== false }
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
      : `No Red Flag Warning or Fire Weather Watch is listed ${opts.statewide ? `in ${checkedScope(d) ?? 'the states checked'}` : 'near this fire'}. That is not an all-clear: follow local officials.`,
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
  /** The point's state (USPS, /api/geo/lookup): undefined while unknown, null outside the lower 48 (or the lookup
   *  failed). "Checked" is decided from the answer's `states_checked` and this state only. */
  pointState?: string | null
}

/** The 49 codes of the lower 48 states + DC (the national NWS request, CONTRACT §14.6). */
export const LOWER48_CODES: readonly string[] = [
  'AL', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
  'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]

/** The states an NWS answer covers: `states_checked`; missing (an older, California-only backend) → `["CA"]`. */
export function statesChecked(d: Pick<FireWeatherResponse, 'states_checked'> | null | undefined): string[] {
  const s = d?.states_checked
  return Array.isArray(s) ? s : ['CA']
}

/** The answer covers every one of the 49 lower-48 codes (only then may a quiet line say "the lower 48 states"). */
export function coversLower48(d: Pick<FireWeatherResponse, 'states_checked'> | null | undefined): boolean {
  const s = new Set(statesChecked(d))
  return LOWER48_CODES.every((c) => s.has(c))
}

/** Where an answer's quiet line says it looked: "the lower 48 states" (all 49 codes), "California" (one state), "these
 *  states (California, Oregon)", or null when nothing was checked. */
export function checkedScope(d: Pick<FireWeatherResponse, 'states_checked'> | null | undefined): string | null {
  const s = statesChecked(d)
  if (!s.length) return null
  if (coversLower48(d)) return 'the lower 48 states'
  const names = s.map((c) => stateName(c) ?? c)
  return names.length === 1 ? names[0] : `these states (${names.join(', ')})`
}

/** Does the point need the overview (national) answer: current time, outside the open fire's checked area? The
 *  answer's `states_checked` then decides whether the point was checked (no client-side state boxes). */
export function needsStatewideFireWeather(i: Pick<FireWeatherAtPointInput, 'lon' | 'lat' | 'hasIncident' | 'demo' | 'past' | 'fallbackArea'> & { incidentData: FireWeatherResponse | null }): boolean {
  if (i.lon == null || i.lat == null || !Number.isFinite(i.lon) || !Number.isFinite(i.lat) || i.demo) return false
  if (!i.hasIncident) return true
  if (i.past) return false
  return !bboxContains(i.incidentData?.area_bbox ?? i.fallbackArea, i.lon, i.lat)
}

/** "Not checked here" for a point whose state the answer does not cover (CONTRACT §14.6: decided from
 *  `states_checked` only), or loading while the point's state is not known yet; null when it is covered. */
function notCheckedAt(d: FireWeatherResponse, pointState: string | null | undefined): FireWeatherOfficial | null {
  const covered = statesChecked(d)
  if (pointState === undefined) {
    // the point's state is still being looked up; an answer that covers every state needs no lookup
    return coversLower48(d) ? null : { state: 'loading', alerts: [], ...fwBase(d), caveat: FW_CAVEAT }
  }
  if (pointState && covered.includes(pointState)) return null
  const where = pointState ? (stateName(pointState) ?? pointState) : null
  return {
    state: 'unavailable',
    alerts: [],
    ...fwBase(d),
    reasonCode: 'not_checked',
    reason: where ? `Fire-3d did not check NWS fire weather alerts in ${where} for this answer.` : 'Fire-3d checks NWS fire weather alerts in the lower 48 states only.',
    caveat: FW_CAVEAT,
  }
}

/**
 * NWS fire weather alerts at a point (I5 `fireWeather` of useOfficialAtPoint). Inside the open fire's checked area its
 * answer decides (live, or the archived copy for a past time); elsewhere the overview (national) answer (current time
 * only). "None" holds only where the answer's `states_checked` holds the point's state; elsewhere 'unavailable' with
 * reasonCode 'not_checked'. Past times outside the fire's area are 'past-date'.
 */
export function fireWeatherAtPointState(i: FireWeatherAtPointInput): FireWeatherOfficial {
  if (i.demo) return fwEnvelope(null, { demo: true, hasIncident: i.hasIncident })!
  if (i.lon == null || i.lat == null || !Number.isFinite(i.lon) || !Number.isFinite(i.lat))
    return { state: 'unavailable', alerts: [], ...fwBase(null), reasonCode: 'not_checked', reason: 'No location selected.', caveat: FW_CAVEAT }
  if (i.hasIncident) {
    const d = i.incident?.data ?? null
    if (bboxContains(d?.area_bbox ?? i.fallbackArea, i.lon, i.lat)) {
      const env = fwEnvelope(i.incident, { demo: false, hasIncident: true })
      return env ?? notCheckedAt(d!, i.pointState) ?? alertsHere(d!, i.lon, i.lat, i.refMs)
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
  const env = fwEnvelope(i.statewide, { demo: false, hasIncident: true })
  return env ?? notCheckedAt(i.statewide!.data!, i.pointState) ?? alertsHere(i.statewide!.data!, i.lon, i.lat, i.refMs)
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
/** The I5 `calfire` shape: the fire's agency record (brief 3: CAL FIRE's or NIFC WFIGS's, a RecordStatus; a brief-2
 *  CalFireStatus with only state, acres?, percentContained?, isActive?, updatedMs?, url? still fits). */
export type CalFireOfficial = CalFireStatus & Partial<Pick<RecordStatus, 'source' | 'issuer' | 'linkLabel' | 'blocks' | 'members' | 'complexName' | 'synthetic' | 'notChecked' | 'protectingUnit' | 'discoveredMs'>>

/** End of the hazard for display, used by the card line ("until …"). */
export const officialAlertEnd = (a: Pick<OfficialAlert, 'endsMs' | 'expiresMs'>): number | null => a.endsMs ?? a.expiresMs ?? null
