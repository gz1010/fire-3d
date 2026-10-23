// Local officials' messages relayed by the National Weather Service, and FEMA's archive of them (brief 3, CONTRACT
// §14.7; owner: us-official). Round 2 item 5: no IPAWS registration. Live: the messages NWS relays (Fire Warning,
// Evacuation Immediate, …); past days: FEMA's public OpenFEMA archive, labelled as archived, with the OpenFEMA notice.
// Each message keeps its issuer (or "issuer not named" when it came through a platform), its own times (shown in its
// area's zone, else the fire's), its verbatim text and a link: the issuer's own `web` link when present, else the copy
// it was read from (`source_url`), so every line has one. Most messages are not relayed: no alert here is never an
// all-clear. An older backend without the endpoint (HTTP 404) is "not checked", never "none". Pure; tested in
// localAlerts.test.ts.
import type { IncidentManifest } from '../api/types'
import { NOT_FOUND_TEXT } from '../extras/format'
import { lonLatToLocal } from '../lib/reproject'
import { fmtAt, timeFmt, type TimeFmt } from '../lib/time'
import type { FeedItem, FeedItemStatus } from '../ui/feed/types'
import { geometriesBounds } from './geo'
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
  expiresMs: number | null
  /** IANA zone of its area (null = not known: the fire's zone is used). */
  timeZone: string | null
  phase: FeedItemStatus
  /** The issuer's link when present, else the record it was read from (always https). */
  link: { url: string; label: string }
  match: LocalAlert['match']
  coversReportedLocation: boolean | null
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

export function toLocalAlertItem(a: LocalAlert): LocalAlertItem | null {
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
    expiresMs: a.expires_ms,
    timeZone: a.time_zone,
    phase: PHASE[a.phase] ?? 'active',
    link,
    match: a.match,
    coversReportedLocation: a.covers_reported_location,
    bounds: a.polygon ? geometriesBounds([a.polygon as GeoPolygon]) : null,
  }
}

const ORDER: Record<FeedItemStatus, number> = { active: 0, upcoming: 1, expired: 2, cancelled: 3 }

/** The local alerts answer as an explicit state (never "none" where nothing was checked). */
export function localAlertsState(q: Pick<QueryState<LocalAlertsResponse>, 'data' | 'loading' | 'error'> | null, opts: { demo?: boolean } = {}): LocalAlertsOfficial {
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
  }
  if (d.status === 'not_available_for_past_dates') return { ...base, alerts: [], state: 'not-checked', reason: d.reason }
  if (d.status === 'unavailable') return { ...base, alerts: [], state: 'unavailable', reason: d.reason }
  const alerts = d.alerts
    .map(toLocalAlertItem)
    .filter((a): a is LocalAlertItem => a != null)
    .sort((a, b) => ORDER[a.phase] - ORDER[b.phase] || (b.sentMs ?? 0) - (a.sentMs ?? 0))
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

/** "relayed by the National Weather Service" / "FEMA archive". */
export function channelText(a: Pick<LocalAlertItem, 'archived'>): string {
  return a.archived ? 'FEMA archive' : 'relayed by the National Weather Service'
}

export interface LocalFeedContext {
  manifest: Pick<IncidentManifest, 'grid'> | null
  tf: TimeFmt
}

/** Feed rows (topic 'local-alert', kind official, key while in effect): one per message, with its issuer, own times,
 *  verbatim text, link, and the archive's notice. */
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
      a.match === 'county' ? 'Matched by county: the message covers a county this fire area touches; it does not say which fire it is about.' : null,
      LOCAL_STANDING_CAVEAT,
    ].filter((n): n is string => n != null)
    return {
      id: `local-alert:${a.id}`,
      topic: 'local-alert' as const,
      kind: 'official' as const,
      tMs: a.sentMs ?? 0,
      title: `${a.lead}: "${a.text}"`,
      detail: `${a.event} · ${[sentText(a, ctx.tf), channelText(a)].filter(Boolean).join(' · ')}`,
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
