// Local officials' messages relayed by the National Weather Service, and FEMA's archive of them (brief 3, CONTRACT
// §14.7; owner: us-official). Round 2 item 5: no IPAWS registration. Live: the messages NWS relays (Fire Warning,
// Evacuation Immediate, …); past days: FEMA's public OpenFEMA archive, labelled as archived, with the OpenFEMA notice.
// Each message keeps its issuer (or "issuer not named" when it came through a platform), its own times (shown in its
// area's zone, else the fire's), its verbatim text and a link: the issuer's own `web` link when present, else the copy
// it was read from (`source_url`), so every line has one. Most messages are not relayed: no alert here is never an
// all-clear. An older backend without the endpoint (HTTP 404) is "not checked", never "none". Every line says where
// the message's area lies (review round 1, R1): "area covers the fire's reported location" or "area 1.7 mi from the
// fire's reported location · may be about another fire" (the location card measures from its point instead), and the
// messages are listed in effect first, then the area covering the location, then the nearest, then the newest. The
// feed shows that phrase in full on every collapsed row (`FeedItem.place`; review round 2, N1). At the location card's
// point, "none here" needs the point's state: Fire-3d checks the lower 48 only (N2), and the live box answer's left-out
// messages are its own, never "the fire's" (N3). Pure; tested in localAlerts.test.ts.
import type { IncidentManifest } from '../api/types'
import { NOT_FOUND_TEXT } from '../extras/format'
import { lonLatToLocal } from '../lib/reproject'
import { fmtAt, timeFmt, type TimeFmt } from '../lib/time'
import type { FeedItem, FeedItemStatus } from '../ui/feed/types'
import { distanceText, geometriesBounds, geometryContains, pointPolygonDistanceKm } from './geo'
import type { QueryState } from './query'
import type { GeoPolygon, LocalAlert, LocalAlertsResponse, LocalChannelStatus } from './types'
import { httpsUrl } from './url'

export const LOCAL_STANDING_CAVEAT =
  'Fire-3d lists only the local alerts the National Weather Service relays; most are not relayed (about 1 in 20 fire and evacuation alerts in 2024-26). No alert here is not an all-clear: follow local officials.'
export const ARCHIVE_CAVEAT = 'Archived copy from FEMA (OpenFEMA, published about a day later); FEMA does not validate message content. Replays can list more than was visible live.'
/** Required by the OpenFEMA terms (https://www.fema.gov/about/openfema/terms-conditions); no FEMA or DHS logos. The
 *  exact text of CONTRACT §14.7 (no full stop: add one in a sentence). */
export const OPENFEMA_NOTICE = "This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA"
export const LIVE_CREDIT = "National Weather Service (relayed local officials' messages)"
export const ARCHIVE_CREDIT = 'FEMA IPAWS archive via OpenFEMA'
export const OPENFEMA_TERMS_URL = 'https://www.fema.gov/about/openfema/terms-conditions'
export const NWS_LOCAL_URL = 'https://www.weather.gov/dsb/nonweatheralerts'
/** Why a line says "may be about another fire" (Official now's "More", the feed's notes). */
export const LOCAL_PLACE_NOTE =
  "Fire-3d ties a message to this fire only by where its area lies; it does not read which fire the message is about, so a message near this fire may be about another one."

export type LocalAlertsState = 'listed' | 'none' | 'not-checked' | 'unavailable' | 'loading'

/** One message, worded for the panels (official text verbatim). */
export interface LocalAlertItem {
  id: string
  archived: boolean
  channel: LocalAlert['channel']
  /** Verbatim event ("Fire Warning", "Civil Emergency Message"). */
  event: string
  /** The issuer verbatim, or null when the message came through a platform ("issuer not named"). */
  issuer: string | null
  /** "Alert from Kern County OES" / "Alert, issuer not named"; archived: "Archived alert from …". */
  lead: string
  /** The message's own words: its WEA text, else its headline, else its description (verbatim; long text cut with
   *  "…"). */
  text: string
  /** Its full verbatim texts (headline, WEA, description, instruction), for "More". */
  full: { label: string; text: string }[]
  sentMs: number | null
  /** The issuer's onset time, else its effective time, verbatim (null when it gave neither). */
  onsetMs: number | null
  expiresMs: number | null
  /** A CAP "Cancel" message: ended whatever its times. */
  cancelled: boolean
  /** IANA zone of its area (null = not known: the fire's zone is used). */
  timeZone: string | null
  /** Its phase at the time the panel is for (`LocalAlertsOfficial.refMs`), decided from its own times
   *  (`localPhaseAt`; review round 4), never from the backend's hour-level hint. */
  phase: FeedItemStatus
  /** The issuer's link when present, else the record it was read from (always https). */
  link: { url: string; label: string }
  match: LocalAlert['match']
  coversReportedLocation: boolean | null
  /** km from the fire's reported location to the message's area (0 = covers it); null for a county match or an
   *  answer without a reported location (`?bbox=`). */
  nearestKm: number | null
  /** Where the area lies, measured from the fire's reported location (the fire's answer) or from the selected point
   *  (the location card, `localAlertsAtPoint`); `covers` / `km` are null for a county match. */
  where: { from: 'fire' | 'point'; covers: boolean | null; km: number | null }
  /** The message's area (polygon matches), for measuring from a point. */
  polygon: GeoPolygon | null
  /** Its SAME county codes ("006037"), for a county match at a point. */
  sameCodes: string[]
  bounds: [number, number, number, number] | null
}

export interface LocalAlertsOfficial {
  state: LocalAlertsState
  alerts: LocalAlertItem[]
  /** Each channel's own state ("pending": FEMA's archive is being fetched). */
  channels: LocalChannelStatus[]
  /** The archive channel was consulted: show the OpenFEMA notice and the archive caveat. */
  archive: boolean
  /** The archive channel is still being fetched (ask again in a minute). */
  archivePending: boolean
  /** Why it is not checked / unavailable, in plain words. */
  reason: string | null
  /** When Fire-3d checked the live channel (NWS). */
  checkedMs: number | null
  /** The answer's caveats (always the standing one first). */
  caveats: string[]
  /** "National Weather Service (relayed local officials' messages)" and, with the archive, "FEMA IPAWS archive via
   *  OpenFEMA". */
  credits: string[]
  /** At a point (`localAlertsAtPoint`) of the fire's own answer: the fire's messages whose area lies elsewhere in its
   *  area (not shown there; listed in Updates). */
  elsewhere?: number
  /** At a point (`localAlertsAtPoint`) of the live `?bbox=` answer for the point's small box (review round 2, N3): the
   *  messages of that box that do not reach the point, by why (a county match for a neighbouring county; an area that
   *  does not reach it). Never the fire's messages, and not listed in Updates. */
  nearby?: { county: number; area: number }
  /** Which answer `localAlertsAtPoint` filtered: the open fire's own answer (its other messages are in Updates) or the
   *  live `?bbox=` answer for the point's box (its messages are not in Updates, so the card lists them all). */
  pointSource?: 'fire' | 'box'
  /** The time the phases and the order were decided at (review round 4): the panel's own time (the replay time on
   *  screen, or now when live) when the hooks give it, else the answer's `requested_at_ms`, else its `now_ms`. A
   *  message sent after it reads "sent N min after this time" and is never counted as active (review round 3, N4).
   *  `localAlertsAt` re-decides them at another time. */
  refMs?: number | null
}

const PHASE: Record<LocalAlert['phase'], FeedItemStatus> = { upcoming: 'upcoming', in_effect: 'active', ended: 'expired' }
const MAX_TEXT = 220

function cut(t: string): string {
  const s = t.replace(/\s+/g, ' ').trim()
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1).trimEnd()}…` : s
}

/** The message's own words to quote: WEA text (the short message people received), else headline, else description. */
export function localAlertText(a: Pick<LocalAlert, 'wea_text' | 'headline' | 'description' | 'event'>): string {
  const t = [a.wea_text, a.headline, a.description].find((x) => x && x.trim())
  return t ? cut(t) : a.event
}

/** The link on every line (CONTRACT §14.7): the issuer's own `web` link, else where this copy was read. */
export function localAlertLink(a: Pick<LocalAlert, 'web' | 'source_url' | 'archived' | 'channel'>): { url: string; label: string } | null {
  const web = httpsUrl(a.web)
  if (web) return { url: web, label: "issuer's link" }
  const src = httpsUrl(a.source_url)
  if (!src) return null
  return { url: src, label: a.archived || a.channel === 'openfema_archive' ? 'source record (FEMA archive)' : 'source record (NWS)' }
}

/**
 * A local message's phase at `refMs` (the time the panel is for: the replay time on screen, or now when live), from
 * its own times only (review round 4; CONTRACT 14.7 as built): ended once cancelled or from its expiry; "upcoming"
 * while it was not sent yet (a replay lists the hour after the answer's time: "sent N min after this time", never
 * current) or its onset (else effective) time is still ahead; in effect otherwise. So a message is in effect from
 * max(sent, onset else effective) until its expiry: an issuer can give an onset earlier than its sent time (Horse
 * Gulch, MT: sent 5:45 PM MDT, effective 5:00 PM), and the message is in effect from 5:45 PM, never before and never
 * "not yet in effect" after. The backend's `nws.local_phase` applies the same rule at the answer's hour; the web
 * decides at the panel's minute, so it never depends on that hint.
 */
export function localPhaseAt(a: Pick<LocalAlertItem, 'cancelled' | 'sentMs' | 'onsetMs' | 'expiresMs'>, refMs: number): FeedItemStatus {
  if (a.cancelled) return 'expired'
  if (a.sentMs != null && refMs < a.sentMs) return 'upcoming'
  if (a.onsetMs != null && refMs < a.onsetMs) return 'upcoming'
  if (a.expiresMs != null && refMs >= a.expiresMs) return 'expired'
  return 'active'
}

const finiteMs = (t: number | null | undefined): t is number => t != null && Number.isFinite(t)

/** One message for the panels, its phase decided at `refMs` (the panel's time; `localPhaseAt`). Without a time (an
 *  answer without `now_ms`) the backend's phase is the hint, never in effect before it was sent (review round 3, N4). */
export function toLocalAlertItem(a: LocalAlert, refMs?: number | null): LocalAlertItem | null {
  const link = localAlertLink(a)
  if (!link) return null // never shown without a link (the backend drops these too)
  const issuer = a.sender_is_platform ? null : a.sender_name?.trim() || null
  const who = issuer ? `Alert from ${issuer}` : 'Alert, issuer not named'
  const full: { label: string; text: string }[] = []
  if (a.headline?.trim()) full.push({ label: 'Headline', text: a.headline.trim() })
  if (a.wea_text?.trim()) full.push({ label: 'Phone alert text (WEA)', text: a.wea_text.trim() })
  if (a.wea_long_text?.trim() && a.wea_long_text.trim() !== a.wea_text?.trim()) full.push({ label: 'Long phone alert text (WEA)', text: a.wea_long_text.trim() })
  if (a.description?.trim()) full.push({ label: 'Message', text: a.description.trim() })
  if (a.instruction?.trim()) full.push({ label: 'What to do', text: a.instruction.trim() })
  return {
    id: a.id,
    archived: a.archived,
    channel: a.channel,
    event: a.event,
    issuer,
    lead: a.archived ? `Archived ${who[0].toLowerCase()}${who.slice(1)}` : who,
    text: localAlertText(a),
    full,
    sentMs: a.sent_ms,
    onsetMs: a.onset_ms ?? a.effective_ms ?? null,
    expiresMs: a.expires_ms,
    cancelled: a.message_type === 'Cancel',
    timeZone: a.time_zone,
    phase: finiteMs(refMs)
      ? localPhaseAt({ cancelled: a.message_type === 'Cancel', sentMs: a.sent_ms, onsetMs: a.onset_ms ?? a.effective_ms ?? null, expiresMs: a.expires_ms }, refMs)
      : a.phase === 'in_effect' && sentAfter({ sentMs: a.sent_ms }, refMs)
        ? 'upcoming'
        : (PHASE[a.phase] ?? 'active'),
    link,
    match: a.match,
    coversReportedLocation: a.covers_reported_location,
    nearestKm: a.nearest_km,
    where: { from: 'fire', covers: a.covers_reported_location, km: a.match === 'polygon' ? a.nearest_km : null },
    polygon: a.polygon ? (a.polygon as GeoPolygon) : null,
    sameCodes: a.same_codes ?? [],
    bounds: a.polygon ? geometriesBounds([a.polygon as GeoPolygon]) : null,
  }
}

const ORDER: Record<FeedItemStatus, number> = { active: 0, upcoming: 1, expired: 2, cancelled: 3 }

/** Most relevant first (review round 1, R1): in effect, then upcoming, then ended; within a phase the area covering
 *  the location, then the nearest area (county matches, with no distance, after those with one), then the newest. */
export function localAlertOrder(a: Pick<LocalAlertItem, 'phase' | 'where' | 'sentMs'>, b: Pick<LocalAlertItem, 'phase' | 'where' | 'sentMs'>): number {
  const cov = (x: typeof a) => (x.where.covers ? 0 : 1)
  const km = (x: typeof a) => (x.where.covers ? 0 : (x.where.km ?? Infinity))
  return ORDER[a.phase] - ORDER[b.phase] || cov(a) - cov(b) || km(a) - km(b) || (b.sentMs ?? 0) - (a.sentMs ?? 0)
}

/**
 * The answer with every message's phase and the order decided at `refMs`, the time the panel is for (the replay time
 * on screen, or now when live; review round 4): the panels (Official now, Public's short line, the location card) and
 * the phone badge call it with their own time, so "in effect", the order, the short line and the count agree with the
 * clock on screen. The query stays hour-quantised: the answer at an hour lists every message sent up to the end of
 * that hour (the replay window is the answer's time + 1 h), so any minute of the hour is decided from it without a
 * refetch. Unchanged (the same object) without a time, when it is not a list, or when decided at that time already.
 */
export function localAlertsAt<T extends Pick<LocalAlertsOfficial, 'state' | 'alerts' | 'refMs'>>(l: T, refMs: number | null | undefined): T {
  if (!finiteMs(refMs) || l.refMs === refMs || l.state !== 'listed') return l
  const alerts = l.alerts
    .map((a) => {
      const phase = localPhaseAt(a, refMs)
      return phase === a.phase ? a : { ...a, phase }
    })
    .sort(localAlertOrder)
  return { ...l, alerts, refMs }
}

/**
 * Where the message's area lies, in the words of every line (Official now, the feed, the location card): "area
 * covers the fire's reported location"; "area 1.7 mi from the fire's reported location · may be about another fire"
 * (Fire-3d never reads which fire a message is about); "matched by county, not by an exact area · may be about
 * another fire". Measured from the selected point on the card ("area covers this point", "area 0.2 mi from this
 * point"; "may be about another fire" only while a fire is open). Units from the viewer's setting.
 */
export function localAlertPlace(a: Pick<LocalAlertItem, 'match' | 'where'>, opts: { metric: boolean; fireOpen?: boolean }): string {
  const w = a.where
  const atPoint = w.from === 'point'
  const other = !atPoint || opts.fireOpen ? 'may be about another fire' : null
  if (a.match === 'county') return ['matched by county, not by an exact area', other].filter(Boolean).join(' · ')
  if (w.covers) return atPoint ? 'area covers this point' : "area covers the fire's reported location"
  const far = w.km != null ? `area ${distanceText(w.km, opts.metric)} from ${atPoint ? 'this point' : "the fire's reported location"}` : null
  return [far, other].filter(Boolean).join(' · ')
}

/** Area match radius at a point for the fire's (past) answer: about the live card's `?bbox=` box (±0.005°). */
export const POINT_NEAR_KM = 1

export interface LocalAtPointOptions {
  /** 5-digit county FIPS of the point (from /api/geo/lookup); county matches elsewhere are not kept. */
  countyFips?: string | null
  /** Which answer is filtered: 'fire' (default) = the open fire's own answer (past time, point inside its area): the
   *  messages left out are counted in `elsewhere` ("… of the fire's local alerts are for other places in its area");
   *  'box' = the live `?bbox=` answer for the point's small box: they are counted in `nearby` (review round 2, N3). */
  source?: 'fire' | 'box'
}

/**
 * The local alerts seen from a point of the location card (review round 1, R1): each area measured from the point
 * (covers it / km away), only the messages whose area reaches the point (polygon within POINT_NEAR_KM; a county match
 * in the point's county, or every county match while the county is unknown), most relevant first. The rest are counted
 * in `elsewhere` for the fire's own answer, or in `nearby` for the live `?bbox=` answer, whose box (±0.005°) can touch
 * a neighbouring county (review round 2, N3). Not an all-clear either way.
 */
export function localAlertsAtPoint(l: LocalAlertsOfficial, lon: number, lat: number, opts: LocalAtPointOptions = {}): LocalAlertsOfficial {
  if (l.state !== 'listed' || !Number.isFinite(lon) || !Number.isFinite(lat)) return l
  const fips = opts.countyFips && /^\d{5}$/.test(opts.countyFips) ? opts.countyFips : null
  const measured = l.alerts.map((a): LocalAlertItem => {
    if (a.match !== 'polygon' || !a.polygon) return { ...a, where: { from: 'point', covers: null, km: null } }
    const covers = geometryContains(a.polygon, lon, lat)
    const d = covers ? 0 : pointPolygonDistanceKm(a.polygon, lon, lat)
    return { ...a, where: { from: 'point', covers, km: Number.isFinite(d) ? Math.round(d * 10) / 10 : null } }
  })
  const byCounty = (a: LocalAlertItem) => a.match === 'county' || !a.polygon
  const near = (a: LocalAlertItem) =>
    byCounty(a) ? fips == null || a.sameCodes.some((c) => c.slice(-5) === fips) : a.where.covers === true || (a.where.km != null && a.where.km <= POINT_NEAR_KM)
  const alerts = measured.filter(near).sort(localAlertOrder)
  const left = measured.filter((a) => !near(a))
  const counts: Pick<LocalAlertsOfficial, 'elsewhere' | 'nearby' | 'pointSource'> =
    opts.source === 'box'
      ? { nearby: { county: left.filter(byCounty).length, area: left.filter((a) => !byCounty(a)).length }, pointSource: 'box' }
      : { elsewhere: left.length, pointSource: 'fire' }
  if (alerts.length) return { ...l, alerts, ...counts }
  // the area was checked, and no message's area reaches this point: "none here", never an all-clear
  return { ...l, alerts: [], state: 'none', reason: null, ...counts }
}

export const LOCAL_LOWER48_REASON = "Fire-3d checks local officials' alerts in the lower 48 states only."
export const LOCAL_LOOKUP_FAILED_REASON = 'Fire-3d could not tell which state this point is in.'

/**
 * Local alerts at a point, gated by the point's state (review round 2, N2; as for NWS fire weather, R2): Fire-3d's
 * national request covers the lower 48 only, so while the point's state is being looked up (`pointState` undefined)
 * the answer is "loading", and where it has none (outside the lower 48, or the lookup failed: null) "none here"
 * becomes "not checked", never "none". Messages listed there stay listed (their area reaches the point).
 */
export function localAlertsForPointState(l: LocalAlertsOfficial, s: { pointState: string | null | undefined; lookupFailed?: boolean }): LocalAlertsOfficial {
  if (l.state !== 'listed' && l.state !== 'none') return l
  if (s.pointState === undefined) return { ...l, alerts: [], state: 'loading', reason: null, elsewhere: undefined, nearby: undefined }
  if (s.pointState === null && l.state === 'none')
    return { ...l, state: 'not-checked', reason: s.lookupFailed ? LOCAL_LOOKUP_FAILED_REASON : LOCAL_LOWER48_REASON, elsewhere: undefined, nearby: undefined }
  return l
}

export interface LocalAtSelectedPointInput {
  lon: number | null
  lat: number | null
  demo?: boolean
  /** The current time: the live `?bbox=` answer for the point's small box (localAlertsState of it); else null. */
  live: LocalAlertsOfficial | null
  /** A past time, the point inside the open fire's area: the fire's own answer; else null. */
  fire: LocalAlertsOfficial | null
  countyFips?: string | null
  /** The point's state (`placeState`): undefined while looked up, null outside the lower 48 or when the lookup failed. */
  pointState: string | null | undefined
  /** The lookup failed (rather than the point lying outside the lower 48). */
  lookupFailed?: boolean
}

/**
 * Local officials' alerts at the location card's point (useOfficialAtPoint): the live box answer, else the fire's own
 * answer for a point in its area at a past time, else "not checked" (past times elsewhere). Measured from the point
 * (`localAlertsAtPoint`, counting what it leaves out as the box's `nearby` or the fire's `elsewhere`; N3) and gated
 * by the point's state (`localAlertsForPointState`; N2). Pure, so the hook's choices are tested.
 */
export function localAlertsAtSelectedPoint(i: LocalAtSelectedPointInput): LocalAlertsOfficial {
  if (i.demo) return localAlertsState(null, { demo: true })
  if (i.lon == null || i.lat == null || !Number.isFinite(i.lon) || !Number.isFinite(i.lat)) return localAlertsState(null)
  const where = { pointState: i.pointState, lookupFailed: i.lookupFailed }
  if (i.live) return localAlertsForPointState(localAlertsAtPoint(i.live, i.lon, i.lat, { countyFips: i.countyFips, source: 'box' }), where)
  if (i.fire) return localAlertsForPointState(localAlertsAtPoint(i.fire, i.lon, i.lat, { countyFips: i.countyFips, source: 'fire' }), where)
  return { ...localAlertsState(null), reason: "Past local alerts are checked for the selected fire's area only." }
}

/** The local alerts answer as an explicit state (never "none" where nothing was checked). `opts.refMs`: the time the
 *  panel is for (the official context's `refMs`: the replay time on screen, or now when live); each message's phase
 *  and the order are decided at it (else at the answer's `requested_at_ms`, else its `now_ms`; review round 4). */
export function localAlertsState(
  q: Pick<QueryState<LocalAlertsResponse>, 'data' | 'loading' | 'error'> | null,
  opts: { demo?: boolean; refMs?: number | null } = {},
): LocalAlertsOfficial {
  const empty = { alerts: [], channels: [], archive: false, archivePending: false, checkedMs: null, caveats: [LOCAL_STANDING_CAVEAT], credits: [LIVE_CREDIT] }
  if (opts.demo) return { ...empty, state: 'not-checked', reason: 'Demo data: local alerts are not checked for simulated incidents.' }
  if (!q) return { ...empty, state: 'not-checked', reason: null }
  const d = q.data
  if (!d) {
    if (q.error === NOT_FOUND_TEXT) return { ...empty, state: 'not-checked', reason: 'This Fire-3d server does not check local alerts.' }
    if (q.error) return { ...empty, state: 'unavailable', reason: q.error }
    return { ...empty, state: 'loading', reason: null }
  }
  const channels = d.channels ?? []
  const refMs = [opts.refMs, d.requested_at_ms, d.now_ms].find(finiteMs) ?? null
  const arch = channels.find((c) => c.id === 'openfema_archive')
  const live = channels.find((c) => c.id === 'nws_api')
  const archive = arch != null && (arch.status === 'available' || arch.status === 'pending')
  const caveats = [...new Set([LOCAL_STANDING_CAVEAT, ...(d.caveats ?? [])])]
  const base = {
    channels,
    archive,
    archivePending: arch?.status === 'pending',
    checkedMs: live?.retrieved_ms ?? d.retrieved_ms ?? null,
    caveats,
    credits: archive ? [LIVE_CREDIT, ARCHIVE_CREDIT] : [LIVE_CREDIT],
    refMs,
  }
  if (d.status === 'not_available_for_past_dates') return { ...base, alerts: [], state: 'not-checked', reason: d.reason }
  // outside the lower 48 nothing is checked (the backend answers state_not_available): "not checked", not an outage
  if (d.status === 'unavailable' && d.reason_code === 'state_not_available') return { ...base, alerts: [], state: 'not-checked', reason: d.reason }
  if (d.status === 'unavailable') return { ...base, alerts: [], state: 'unavailable', reason: d.reason }
  const alerts = d.alerts
    .map((a) => toLocalAlertItem(a, refMs))
    .filter((a): a is LocalAlertItem => a != null)
    .sort(localAlertOrder)
  const answered = channels.some((c) => c.status === 'available')
  if (alerts.length) return { ...base, alerts, state: 'listed', reason: null }
  // nothing listed: "none" only when a channel actually answered (a pending archive alone is not a check)
  if (answered) return { ...base, alerts: [], state: 'none', reason: null }
  return { ...base, alerts: [], state: 'not-checked', reason: channels.map((c) => c.reason).filter(Boolean).join(' ') || d.reason }
}

/** The zone of a message's times: its area's own zone, else `tf`'s (the fire's or the point's), same clock. */
export function alertTimeFormat(a: Pick<LocalAlertItem, 'timeZone'>, tf: TimeFmt): TimeFmt {
  return a.timeZone ? timeFmt(a.timeZone, tf.clock) : tf
}

/** "sent Oct 9, 3:01 PM PDT" in the message's own zone. */
export function sentText(a: Pick<LocalAlertItem, 'sentMs' | 'timeZone'>, tf: TimeFmt): string | null {
  return a.sentMs != null ? `sent ${fmtAt(a.sentMs, alertTimeFormat(a, tf), { zone: true, year: 'auto' })}` : null
}

const MINUTE_MS = 60_000
const minuteCut = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS

/** How long after the reference time a message was sent, from both times cut to the minute as they are shown ("sent
 *  2:45 PM" at 2:20 PM: "25 min"; integration part 2): "less than a minute" in the same minute, "32 min", "1 h 5 min". */
export function afterSpan(sentMs: number, refMs: number): string {
  const min = Math.round((minuteCut(sentMs) - minuteCut(refMs)) / MINUTE_MS)
  if (min < 1) return 'less than a minute'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
}

/** When a local message joins a replay's feed: the start of the minute after it was sent, so it is listed exactly when
 *  the panels' time (the replay minute, `useOfficialPanelTime`) reaches it, never "not yet in effect" for the seconds
 *  in between (integration part 2: one time for the feed and the panels). */
export function localFeedMs(sentMs: number): number {
  return Math.ceil(sentMs / MINUTE_MS) * MINUTE_MS
}

/**
 * A message's phase in the words of its line (integration review UX-m2): null while in effect; "ended"; a message sent
 * after the reference time (a replay's +1 h window, §14.7) "sent 32 min after this time", never "upcoming" (a "leave
 * now" order is not a scheduled one); another message not yet in effect (sent, its onset still ahead) "not yet in
 * effect". A message sent after the reference time says so whatever its phase (review round 3, N4). `refMs` must be
 * the time the phase was decided at (`localAlertsAt` the panel's time first; review round 4), so an already-sent,
 * already-effective message never reads "not yet in effect".
 */
export function localPhaseText(a: Pick<LocalAlertItem, 'phase' | 'sentMs'>, refMs?: number | null): string | null {
  if (sentAfter(a, refMs)) return `sent ${afterSpan(a.sentMs!, refMs!)} after this time`
  if (a.phase === 'expired' || a.phase === 'cancelled') return 'ended'
  if (a.phase !== 'upcoming') return null
  return 'not yet in effect'
}

/** The message was sent after `refMs` (the time the panel or the answer is for): it did not exist yet there. */
export function sentAfter(a: Pick<LocalAlertItem, 'sentMs'>, refMs: number | null | undefined): boolean {
  return a.sentMs != null && refMs != null && Number.isFinite(refMs) && a.sentMs > refMs
}

/** Which channels answered, for a line that says none were found (integration review UX-m3): "relayed by NWS" (the
 *  live channel), "FEMA archive" (a past time older than NWS keeps: only the archive was read), or "NWS, FEMA
 *  archive". */
export function answeredChannelsText(l: Pick<LocalAlertsOfficial, 'channels'>): 'relayed by NWS' | 'FEMA archive' | 'NWS, FEMA archive' {
  const ok = (id: LocalChannelStatus['id']) => l.channels.some((c) => c.id === id && c.status === 'available')
  if (ok('openfema_archive')) return ok('nws_api') ? 'NWS, FEMA archive' : 'FEMA archive'
  return 'relayed by NWS'
}

/** "relayed by the National Weather Service" / "FEMA archive". */
export function channelText(a: Pick<LocalAlertItem, 'archived'>): string {
  return a.archived ? 'FEMA archive' : 'relayed by the National Weather Service'
}

export interface LocalFeedContext {
  manifest: Pick<IncidentManifest, 'grid'> | null
  tf: TimeFmt
  /** Distances in km (else miles); default false. */
  metric?: boolean
}

/** Feed rows (topic 'local-alert', kind official, key while in effect): one per message, with its issuer, own times,
 *  verbatim text, link, and the archive's notice. Where its area lies is the row's `place` ("area 18 mi from the
 *  fire's reported location · may be about another fire"), which the feed shows in full on the collapsed row, never
 *  clamped like `detail` (review round 2, N1). */
export function localAlertFeedItems(l: LocalAlertsOfficial | null, ctx: LocalFeedContext): FeedItem[] {
  if (!l || l.state !== 'listed') return []
  return l.alerts.map((a) => {
    let location: FeedItem['location'] = null
    if (a.bounds && ctx.manifest?.grid) {
      const lon = (a.bounds[0] + a.bounds[2]) / 2
      const lat = (a.bounds[1] + a.bounds[3]) / 2
      const [x, z] = lonLatToLocal(lon, lat, ctx.manifest.grid)
      location = { lon, lat, x, z }
    }
    const notes = [
      a.archived ? ARCHIVE_CAVEAT : null,
      a.archived ? `${ARCHIVE_CREDIT}: ${OPENFEMA_NOTICE}.` : null,
      a.match === 'county' ? "Matched by county: the message covers a county this fire's area touches, not an exact area." : null,
      a.where.covers ? null : LOCAL_PLACE_NOTE,
      LOCAL_STANDING_CAVEAT,
    ].filter((n): n is string => n != null)
    return {
      id: `local-alert:${a.id}`,
      topic: 'local-alert' as const,
      kind: 'official' as const,
      tMs: a.sentMs ?? 0,
      // listed from the minute after it was sent: the panels decide its phase at the replay minute (one time for both)
      ...(a.sentMs != null ? { seekMs: localFeedMs(a.sentMs) } : {}),
      sentAfterRef: sentAfter(a, l.refMs),
      title: `${a.lead}: "${a.text}"`,
      place: localAlertPlace(a, { metric: ctx.metric ?? false }),
      detail: [a.event, sentText(a, ctx.tf), channelText(a)].filter(Boolean).join(' · '),
      source: a.archived ? `${a.issuer ?? 'Issuer not named'} (${ARCHIVE_CREDIT})` : `${a.issuer ?? 'Issuer not named'} (relayed by the National Weather Service)`,
      automated: false,
      key: a.phase === 'active',
      confidence: null,
      location,
      seekable: false,
      eventId: null,
      approximate: location != null,
      locationLabel: location ? "Center of the message's area" : null,
      facts: [{ label: 'Event (verbatim)', text: a.event, scientific: null }],
      url: a.link.url,
      issuer: a.issuer ?? 'Issuer not named',
      issuedMs: a.sentMs,
      updatedMs: null,
      expiresMs: a.expiresMs,
      checkedMs: l.checkedMs,
      status: a.phase,
      bounds: a.bounds,
      archived: a.archived,
      sections: a.full,
      notes,
      timeNotGiven: a.sentMs == null,
    }
  })
}

/** Map credits while local officials' alerts are shown (review round 1, R4): the National Weather Service when its
 *  channel answered or a relayed message is listed; FEMA's archive, with the OpenFEMA notice its terms require (no
 *  FEMA or DHS logo), when the archive answered or an archived message is listed. Nothing while not checked. */
export function localAlertCredits(l: LocalAlertsOfficial | null | undefined): { id: string; text: string; href?: string }[] {
  if (!l || (l.state !== 'listed' && l.state !== 'none')) return []
  const answered = (id: LocalChannelStatus['id']) => l.channels.some((c) => c.id === id && c.status === 'available')
  const out: { id: string; text: string; href?: string }[] = []
  if (answered('nws_api') || l.alerts.some((a) => !a.archived)) out.push({ id: 'official-local-nws', text: `Local officials' alerts: ${LIVE_CREDIT}`, href: NWS_LOCAL_URL })
  if (answered('openfema_archive') || l.alerts.some((a) => a.archived))
    out.push({ id: 'official-local-openfema', text: `Local officials' alerts: ${ARCHIVE_CREDIT}. ${OPENFEMA_NOTICE}.`, href: OPENFEMA_TERMS_URL })
  return out
}
