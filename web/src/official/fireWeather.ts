// NWS fire weather alerts (owner: official-web; BRIEF-2 decision 3, PLAN-2 U-R7): Red Flag Warnings and Fire Weather
// Watches near the fire, from the live NWS feed or, for past dates, an archived copy from the Iowa Environmental
// Mesonet (IEM). The wording is kept verbatim (event, headline, WHAT / WHERE / WHEN / IMPACTS); a Red Flag Warning is
// a weather warning, never an evacuation order. Expired alerts stay listed for 48 h as "Expired <time>". Pure,
// tested in fireWeather.test.ts.
import type { Feature, FeatureCollection, Geometry } from 'geojson'
import type { IncidentManifest, Mode } from '../api/types'
import { fmtWhen } from '../extras/format'
import { timeFmt, type TimeFmt } from '../lib/time'
import { getTimeFormat } from '../state/timeZone'
import { lonLatToLocal } from '../lib/reproject'
import type { FeedItem, FeedItemStatus } from '../ui/feed/types'
import { officialSeekable } from './calfire'
import { distanceText, geometriesBounds, geometryContains, type BBox } from './geo'
import type { FireWeatherResponse, GeoPolygon, NwsAlert, NwsZoneFeature } from './types'
import { httpsUrl } from './url'
import { FW_LINE, OFFICIAL_COLORS } from './style'
import type { ExtrasLegendEntry } from '../extras/legend'

const HOUR = 3_600_000
/** Expired alerts stay listed this long after they end (U-R7). */
export const EXPIRED_KEEP_MS = 48 * HOUR

export const NWS_NAME = 'National Weather Service'
export const IEM_NAME = 'Iowa Environmental Mesonet'
export const NWS_ALERTS_URL = 'https://www.weather.gov/'
export const IEM_URL = 'https://mesonet.agron.iastate.edu/vtec/'

/** Only the fire weather products this layer is about (the backend already filters; this keeps the UI honest). */
export function isFireWeatherAlert(a: Pick<NwsAlert, 'event' | 'vtec'>): boolean {
  if (a.vtec?.phenomena === 'FW') return true
  return /red flag warning|fire weather watch/i.test(a.event ?? '')
}

export const alertStartMs = (a: Pick<NwsAlert, 'onset_ms' | 'effective_ms' | 'sent_ms'>): number | null => a.onset_ms ?? a.effective_ms ?? a.sent_ms ?? null
/** When the hazard ends ("until"): NWS `ends`, else the message's `expires`. */
export const alertEndMs = (a: Pick<NwsAlert, 'ends_ms' | 'expires_ms'>): number | null => a.ends_ms ?? a.expires_ms ?? null

/** The hazard's end when it is usable: archived watches sometimes list an end before their onset (IEM quirk). */
function usableEndMs(a: Pick<NwsAlert, 'ends_ms' | 'expires_ms' | 'onset_ms' | 'effective_ms' | 'sent_ms'>): number | null {
  const end = alertEndMs(a)
  const start = alertStartMs(a)
  return end != null && start != null && end < start ? null : end
}

const BACKEND_PHASE: Record<string, FeedItemStatus> = { in_effect: 'active', upcoming: 'upcoming', ended: 'expired' }

/** Where an alert stands at `refMs` (now, or the replay time). Archived copies use the backend's phase, computed from
 *  the archive's per-zone times at the requested time; live alerts are re-checked against the clock. */
export function alertPhase(
  a: Pick<NwsAlert, 'vtec' | 'message_type' | 'onset_ms' | 'effective_ms' | 'sent_ms' | 'ends_ms' | 'expires_ms' | 'dropped_ms'> & Partial<Pick<NwsAlert, 'archived' | 'phase'>>,
  refMs: number,
): FeedItemStatus {
  const action = a.vtec?.action?.toUpperCase()
  // cancelled (CAN) or replaced by another product (UPG, e.g. a watch upgraded to a warning)
  if (action === 'CAN' || action === 'UPG' || /^cancel/i.test(a.message_type ?? '')) return 'cancelled'
  if (a.archived && a.phase && BACKEND_PHASE[a.phase]) return BACKEND_PHASE[a.phase]
  const end = usableEndMs(a)
  if (action === 'EXP' || (end != null && end <= refMs) || (a.dropped_ms != null && a.dropped_ms <= refMs)) return 'expired'
  const start = alertStartMs(a)
  if (start != null && start > refMs) return 'upcoming'
  return 'active'
}

/** One row per VTEC event (office, phenomenon, significance, event number): the newest message wins. */
export function vtecKey(a: Pick<NwsAlert, 'vtec' | 'id'>): string {
  const v = a.vtec
  return v ? `${v.office}.${v.phenomena}.${v.significance}.${v.etn}` : a.id
}

/** One CAP message's own wording (NWS sends one message per segment: areas with their own text). */
export interface AlertSegment {
  area: string | null
  nwsHeadline: string | null
  description: string | null
  instruction: string | null
}

/** An alert as listed: one VTEC event, its newest message's times, the zones of all its messages and every distinct
 *  segment's verbatim text. */
export type ListedAlert = NwsAlert & { merged_ids: string[]; segments: AlertSegment[] }

const segmentOf = (a: NwsAlert): AlertSegment => ({ area: a.area_desc ?? null, nwsHeadline: a.nws_headline ?? null, description: a.description ?? null, instruction: a.instruction ?? null })
const sameSegment = (x: AlertSegment, y: AlertSegment) => x.description === y.description && x.nwsHeadline === y.nwsHeadline && x.instruction === y.instruction

/** Alerts worth listing at `refMs`: fire weather products, one per VTEC event (newest message; zones of every
 *  message), not ended more than 48 h before `refMs`. */
export function listedAlerts(d: Pick<FireWeatherResponse, 'alerts'> | null, refMs: number): ListedAlert[] {
  const byEvent = new Map<string, ListedAlert>()
  for (const a of d?.alerts ?? []) {
    if (!a || !isFireWeatherAlert(a)) continue
    const k = vtecKey(a)
    const prev = byEvent.get(k)
    if (!prev) {
      byEvent.set(k, { ...a, ugcs: [...(a.ugcs ?? [])], merged_ids: [a.id], segments: [segmentOf(a)] })
      continue
    }
    const ugcs = [...new Set([...prev.ugcs, ...(a.ugcs ?? [])])]
    const ids = [...prev.merged_ids, a.id]
    const seg = segmentOf(a)
    const newer = (a.sent_ms ?? 0) > (prev.sent_ms ?? 0)
    // a newer message replaces the wording; messages sent together are segments of one product: keep each one's text
    const segments = newer ? [seg] : prev.segments.some((x) => sameSegment(x, seg)) ? prev.segments : [...prev.segments, seg]
    byEvent.set(k, newer ? { ...a, ugcs, merged_ids: ids, segments } : { ...prev, ugcs, merged_ids: ids, segments })
  }
  return [...byEvent.values()].filter((a) => {
    const end = a.dropped_ms ?? alertEndMs(a)
    return end == null || end > refMs - EXPIRED_KEEP_MS
  })
}

export interface AlertSection {
  label: string
  text: string
}

const SECTION_LABEL: Record<string, string> = {
  WHAT: 'What',
  WHERE: 'Where',
  WHEN: 'When',
  IMPACTS: 'Impacts',
  'ADDITIONAL DETAILS': 'Additional details',
}

/**
 * The verbatim "* WHAT...", "* WHERE...", "* WHEN...", "* IMPACTS..." parts of an NWS product (text after the
 * label, whitespace joined). Text that does not follow that layout is returned whole as "Full text".
 */
export function alertSections(description: string | null | undefined, instruction?: string | null): AlertSection[] {
  const out: AlertSection[] = []
  const text = (description ?? '').replace(/\r\n?/g, '\n').trim()
  if (text) {
    const re = /^\*\s*([A-Z][A-Z ]+?)\.\.\.([\s\S]*?)(?=^\*\s*[A-Z][A-Z ]+?\.\.\.|(?![\s\S]))/gm
    let m: RegExpExecArray | null
    let found = false
    const first = text.search(/^\*\s*[A-Z][A-Z ]+?\.\.\./m)
    if (first > 0) {
      const pre = text.slice(0, first).replace(/\s+/g, ' ').trim()
      if (pre) out.push({ label: 'Summary', text: pre })
    }
    while ((m = re.exec(text))) {
      found = true
      const key = m[1].trim()
      const body = m[2].replace(/\s+/g, ' ').trim()
      if (body) out.push({ label: SECTION_LABEL[key] ?? key[0] + key.slice(1).toLowerCase(), text: body })
    }
    if (!found) out.push({ label: 'Full text', text: text.replace(/[ \t]+/g, ' ') })
  }
  const ins = (instruction ?? '').replace(/\s+/g, ' ').trim()
  if (ins) out.push({ label: 'What to do (NWS)', text: ins })
  return out
}

/** NWS's "Zone A; Zone B; …" area list, shortened to its first three zones and a count when longer. */
export function shortAreaList(areaDesc: string): string {
  const parts = areaDesc.split(';').map((x) => x.trim()).filter(Boolean)
  if (parts.length <= 4) return areaDesc
  return `${parts.slice(0, 3).join('; ')} and ${parts.length - 3} more zones`
}

/** The verbatim text of every segment, on demand: the NWS headline paragraph, then WHAT / WHERE / WHEN / IMPACTS
 *  (or the product's own parts). Several segments are labelled "Part n of N (areas)". */
export function segmentSections(a: Pick<ListedAlert, 'segments' | 'headline'>): AlertSection[] {
  const many = a.segments.length > 1
  const cap = (t: string) => (t.length > 90 ? `${t.slice(0, 87).trimEnd()}…` : t)
  return a.segments.flatMap((seg, i) => {
    const head = seg.nwsHeadline?.replace(/\s+/g, ' ').trim() ?? ''
    const out: AlertSection[] = []
    if (many) out.push({ label: `Part ${i + 1} of ${a.segments.length}${seg.area ? ` (${cap(seg.area)})` : ''}`, text: head || 'No NWS headline for this part.' })
    else if (head && head !== a.headline?.trim()) out.push({ label: 'NWS headline', text: head })
    return [...out, ...alertSections(seg.description, seg.instruction)]
  })
}

/** The zone and clock of an alert's own times: its area's zone (`time_zone`, brief 3), else `tf`'s; `tf`'s clock. */
export function alertTimeFmt(a: Pick<NwsAlert, 'time_zone'>, tf: TimeFmt = getTimeFormat()): TimeFmt {
  return a.time_zone ? timeFmt(a.time_zone, tf.clock) : tf
}

/** "until Oct 20, 18:00 PDT" / "from Oct 19, 10:00 PDT until Oct 20, 18:00 PDT" / "Expired Oct 17, 18:00 PDT", in the
 *  alert's own zone (CONTRACT §14.6) with `tf`'s clock. */
export function alertTimeText(a: NwsAlert, phase: FeedItemStatus, refMs: number, tf?: TimeFmt): string {
  const z = alertTimeFmt(a, tf)
  const w = (ms: number) => fmtWhen(ms, refMs, z)
  const end = usableEndMs(a)
  const start = alertStartMs(a)
  if (phase === 'cancelled') {
    const at = a.sent_ms != null ? ` ${w(a.sent_ms)}` : ''
    return a.vtec?.action?.toUpperCase() === 'UPG' ? `Replaced by a newer NWS alert${at}` : `Cancelled${at}`
  }
  if (phase === 'expired' && a.dropped_ms != null && (end == null || end > a.dropped_ms)) return `No longer in the NWS feed since ${w(a.dropped_ms)}`
  if (phase === 'expired') return end != null ? `Expired ${w(end)}` : 'Expired'
  const open = alertEndMs(a) != null ? '(end time unclear in the archive)' : 'until further notice'
  if (phase === 'upcoming') return `${start != null ? `from ${w(start)} ` : ''}${end != null ? `until ${w(end)}` : open}`
  return end != null ? `until ${w(end)}` : open
}

/** The sender as NWS names it ("NWS Los Angeles/Oxnard CA"), else the office code. */
export function senderText(a: Pick<NwsAlert, 'sender_name' | 'vtec'>): string {
  const s = a.sender_name?.trim()
  if (s) return s
  return a.vtec?.office ? `NWS ${a.vtec.office}` : NWS_NAME
}

/** Zones of an alert: those naming one of its messages, or one of its UGC codes. */
export function alertZones(d: Pick<FireWeatherResponse, 'zones'> | null, a: Pick<NwsAlert, 'id' | 'ugcs'> & { merged_ids?: string[] }): NwsZoneFeature[] {
  const ids = new Set(a.merged_ids ?? [a.id])
  const ugcs = new Set(a.ugcs ?? [])
  return (d?.zones?.features ?? []).filter((f) => ugcs.has(f.properties?.ugc) || (f.properties?.alert_ids ?? []).some((id) => ids.has(id)))
}

export function alertBounds(d: Pick<FireWeatherResponse, 'zones'> | null, a: Pick<NwsAlert, 'id' | 'ugcs'> & { merged_ids?: string[] }): BBox | null {
  return geometriesBounds(alertZones(d, a).map((f) => f.geometry as GeoPolygon | null))
}

/** Alerts whose zones contain the point (the response must have listed their zones). */
export function alertsAtPoint(d: Pick<FireWeatherResponse, 'zones' | 'alerts'> | null, lon: number, lat: number): NwsAlert[] {
  if (!d || !Number.isFinite(lon) || !Number.isFinite(lat)) return []
  const ids = new Set<string>()
  const ugcs = new Set<string>()
  for (const f of d.zones?.features ?? []) {
    if (!geometryContains(f.geometry, lon, lat)) continue
    for (const id of f.properties?.alert_ids ?? []) ids.add(id)
    if (f.properties?.ugc) ugcs.add(f.properties.ugc)
  }
  return (d.alerts ?? []).filter((a) => isFireWeatherAlert(a) && (ids.has(a.id) || (a.ugcs ?? []).some((u) => ugcs.has(u))))
}

/** "National Weather Service" or "National Weather Service via Iowa Environmental Mesonet archive". */
export function fireWeatherCredit(archived: boolean): string {
  return archived ? `${NWS_NAME} via ${IEM_NAME} archive` : NWS_NAME
}

export interface FireWeatherFeedContext {
  mode: Mode
  /** Now (live) or the replay time: what "in effect" and "expired" refer to. */
  refMs: number
  manifest: Pick<IncidentManifest, 'grid' | 'time_range'> | null
  metric?: boolean
  /** Zone and clock (the fire's; each alert uses its own area's zone when known). Default `getTimeFormat()`. */
  tf?: TimeFmt
}

function zonesCentreLocation(zones: NwsZoneFeature[], manifest: FireWeatherFeedContext['manifest']): FeedItem['location'] {
  const b = geometriesBounds(zones.map((z) => z.geometry as GeoPolygon | null))
  if (!b || !manifest?.grid) return null
  const lon = (b[0] + b[2]) / 2
  const lat = (b[1] + b[3]) / 2
  const [x, z] = lonLatToLocal(lon, lat, manifest.grid)
  return { lon, lat, x, z }
}

/**
 * Feed rows: one per VTEC event, kind official, not automated, key. Title "<event verbatim> until <ends>" (or
 * "Expired <time>" / "Cancelled"), detail = the NWS headline verbatim, WHAT / WHERE / WHEN / IMPACTS on demand,
 * source = the sender, link to the product. Archived copies say so. Seekable only inside the observed record.
 */
export function fireWeatherFeedItems(d: FireWeatherResponse | null, ctx: FireWeatherFeedContext): FeedItem[] {
  if (!d || d.status !== 'available') return []
  const items: FeedItem[] = []
  for (const a of listedAlerts(d, ctx.refMs)) {
    const phase = alertPhase(a, ctx.refMs)
    const when = alertTimeText(a, phase, ctx.refMs, ctx.tf)
    const zones = alertZones(d, a)
    const bounds = geometriesBounds(zones.map((z) => z.geometry as GeoPolygon | null))
    const t = a.sent_ms ?? a.effective_ms ?? alertStartMs(a) ?? d.source_updated_ms ?? null
    const sender = senderText(a)
    const archived = a.archived === true
    const notes: string[] = []
    if (a.covers_reported_location) notes.push("The alert's area includes the fire's reported location.")
    else if (a.nearest_km != null) notes.push(`The nearest alert zone is ${a.nearest_km === 0 ? 'at' : `${distanceText(a.nearest_km, !!ctx.metric)} from`} the fire.`)
    if (archived) notes.push(`Archived copy of the NWS product from the ${IEM_NAME}; NWS itself keeps no archive of past alerts.`)
    notes.push('A fire weather alert is a weather warning, not an evacuation order. Follow local officials.')
    const id = `fire-weather:${vtecKey(a)}`
    items.push({
      id,
      topic: 'fire-weather',
      kind: 'official',
      tMs: t ?? d.retrieved_ms ?? d.now_ms,
      title: phase === 'active' || phase === 'upcoming' ? `${a.event} ${when}` : `${a.event}: ${when}`,
      detail: a.headline?.trim() || null,
      source: archived ? `${sender} (archived copy via ${IEM_NAME})` : sender,
      automated: false,
      key: true,
      confidence: null,
      location: zonesCentreLocation(zones, ctx.manifest),
      seekable: t != null && officialSeekable(t, ctx.manifest),
      eventId: null,
      approximate: true,
      locationLabel: 'Center of the alert zones',
      facts: [
        { label: 'NWS product', text: a.event, scientific: a.vtec ? `VTEC ${a.vtec.action}.${a.vtec.office}.${a.vtec.phenomena}.${a.vtec.significance}.${String(a.vtec.etn).padStart(4, '0')}` : null },
        ...(a.area_desc ? [{ label: 'Area (NWS)', text: shortAreaList(a.area_desc), scientific: null }] : []),
      ],
      url: httpsUrl(a.url),
      issuer: sender,
      issuedMs: a.sent_ms,
      updatedMs: null,
      expiresMs: alertEndMs(a),
      checkedMs: d.retrieved_ms,
      bounds,
      status: phase,
      distanceKm: a.covers_reported_location ? 0 : a.nearest_km,
      highlight: { kind: 'fire-weather', id, ugcs: a.ugcs ?? [], alertIds: a.merged_ids },
      // the full verbatim zone list goes with the official text when the fact above had to shorten it
      sections: [...segmentSections(a), ...(a.area_desc && shortAreaList(a.area_desc) !== a.area_desc ? [{ label: 'All areas (NWS)', text: a.area_desc }] : [])],
      archived,
      notes,
      timeNotGiven: t == null,
    })
  }
  return items
}

/** Zones of the alerts in effect (or upcoming) at `refMs`, one feature per zone with the most urgent alert's wording. */
export function fireWeatherDisplayData(d: FireWeatherResponse | null, refMs: number): FeatureCollection {
  const features: Feature[] = []
  if (d?.status !== 'available') return { type: 'FeatureCollection', features }
  const shown = listedAlerts(d, refMs).filter((a) => {
    const p = alertPhase(a, refMs)
    return p === 'active' || p === 'upcoming'
  })
  if (!shown.length) return { type: 'FeatureCollection', features }
  const byId = new Map(shown.flatMap((a) => a.merged_ids.map((id) => [id, a] as const)))
  const byUgc = new Map<string, typeof shown>()
  for (const a of shown) for (const u of a.ugcs ?? []) byUgc.set(u, [...(byUgc.get(u) ?? []), a])
  for (const f of d.zones?.features ?? []) {
    if (!f.geometry) continue
    const ids = f.properties?.alert_ids ?? []
    const alerts = ids.map((id) => byId.get(id)).filter((a): a is (typeof shown)[number] => a != null)
    const list = alerts.length ? alerts : (byUgc.get(f.properties?.ugc) ?? [])
    if (!list.length) continue
    const warning = list.find((a) => a.vtec?.significance === 'W' || /warning/i.test(a.event))
    const top = warning ?? list[0]
    const kind = warning ? 'warning' : 'watch'
    const archived = top.archived === true
    features.push({
      type: 'Feature',
      id: f.properties.ugc,
      geometry: f.geometry as Geometry,
      properties: { ugc: f.properties.ugc, name: f.properties.name ?? '', kind, label: `${top.event} (NWS${archived ? ', archived' : ''})`, alertId: top.id },
    })
  }
  return { type: 'FeatureCollection', features }
}

/** Legend entries for the outlines drawn at `refMs` (NWS wording verbatim; outline only). */
export function fireWeatherLegend(d: FireWeatherResponse | null, refMs: number): ExtrasLegendEntry[] {
  const fc = fireWeatherDisplayData(d, refMs)
  const out: ExtrasLegendEntry[] = []
  for (const kind of ['warning', 'watch'] as const) {
    const f = fc.features.find((x) => (x.properties as { kind: string }).kind === kind)
    if (!f) continue
    const label = String((f.properties as { label: string }).label)
    const archived = /archived\)$/.test(label)
    out.push({
      id: `fw-${kind}`,
      layer: 'fireWeather',
      label,
      detail: `official weather alert · outline only${archived ? ' · archived copy (Iowa Environmental Mesonet)' : ''} · not an evacuation order`,
      swatch: { kind: 'outline', color: kind === 'warning' ? OFFICIAL_COLORS.redFlag : OFFICIAL_COLORS.fireWeatherWatch, line: FW_LINE[kind].style },
      compact: 'Fire weather alert (NWS)',
    })
  }
  return out
}

/** Map credit while outlines are drawn: "Fire weather alerts: National Weather Service" (+ the IEM archive). */
export function fireWeatherCredits(d: FireWeatherResponse | null, refMs: number): { id: string; text: string; href?: string }[] {
  const fc = fireWeatherDisplayData(d, refMs)
  if (!fc.features.length) return []
  const archived = fc.features.some((f) => /archived\)$/.test(String((f.properties as { label: string }).label)))
  return [{ id: 'official-nws', text: `Fire weather alerts: ${fireWeatherCredit(archived)}`, href: archived ? IEM_URL : NWS_ALERTS_URL }]
}
