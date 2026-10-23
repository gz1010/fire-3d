// Search planning and state for the "Check an address" box (owner: us-web; CONTRACT §5.1, brief 2 C-R1/R3/R4/R5;
// brief 3 §14.10: every lower-48 state, "Town, ST" and "83702 ID", US wording). Pure. Order:
// 1. pasted coordinates (parsed locally, never sent anywhere);
// 2. an exact incident name ("Eaton Fire", or "Eaton" when no town of that name exists) opens that fire; other
//    incident matches are only listed, and an unprepared fire is never built without asking;
// 3. everything else goes to /api/geocode: a street address (house number first) to the Census Geocoder, a town or
//    ZIP code to the local Census Gazetteer index (no upstream call; the backend parses "Springfield, IL",
//    "Springfield IL", "83702 ID" and "ID 83702", and lists a bare "Springfield" across states with their state).
// No autocomplete, no POI search, no Nominatim. The state machine below gives every lookup a sequence number: Escape,
// edits, Clear, an outside click, a map click and a new selection cancel it, and a reply with an old number is dropped.
import type { IncidentSummary } from '../api/types'
import { LOWER48_BOX, parseLatLonDetailed, type ParsedLatLon } from '../lib/geodesy'
import { stateCode, stateName, stateWords } from '../lib/usStates'
import type { GeocodeMatch, GeocodeResponse } from './types'

export interface IncidentHit {
  summary: IncidentSummary
  score: number
  /** The whole incident name (or its id) was typed: "Eaton Fire", "2025-eaton-fire-dbfa57", "Eaton Fire 2025". */
  exact: boolean
  /** The name without its "Fire" suffix was typed ("Eaton"): exact unless a town has that name. */
  bare: boolean
}

export type SearchPlan =
  | { kind: 'empty' }
  | { kind: 'coords'; parsed: ParsedLatLon }
  /** One exact incident name: open it (built), say "Showing" (current) or ask before preparing (not built). */
  | { kind: 'incident'; hit: IncidentHit; incidents: IncidentHit[] }
  /** Ask /api/geocode; `candidate` is opened when the lookup finds no exact town of that name. */
  | { kind: 'lookup'; query: string; expect: 'address' | 'local'; incidents: IncidentHit[]; candidate: IncidentHit | null }
  /** Nothing to search for (digits that are not a ZIP code, punctuation). */
  | { kind: 'invalid'; message: string }

export const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** A US street address starts with a house number followed by a street word ("600 E Mariposa St, Altadena"),
 *  including grid styles such as "N1234 County Rd" or "100-12 Main St" (same rule as the backend). A ZIP code with a
 *  state ("91001 CA") is not an address. */
export function looksLikeAddress(text: string): boolean {
  if (looksLikeZip(text)) return false
  return /^\s*(?:[NSEW]\s?)?\d+[A-Z]?(?:[-/]\d+[A-Z]?)?\s+[A-Za-z0-9]/i.test(text) && /[A-Za-z]{2,}/.test(text)
}

/** "91001", "91001-1234", "CA 91001", "83702 ID", "ID 83702", "83702, Idaho", "87501 New Mexico". */
export function looksLikeZip(text: string): boolean {
  const w = stripStateWords(fold(text)).split(' ').filter(Boolean)
  return (w.length === 1 && /^\d{5}$/.test(w[0])) || (w.length === 2 && /^\d{5}$/.test(w[0]) && /^\d{4}$/.test(w[1]))
}

/** Every state word (codes, names, common abbreviations; folded) plus "us" / "usa", longest first. */
const STATE_PHRASES: readonly string[] = [...new Set([...stateWords().map(fold), 'usa', 'us', 'united states'])].filter(Boolean).sort((a, b) => b.length - a.length)

/** The folded text without leading or trailing state words ("83702 id" → "83702", "new mexico 87501" → "87501"). */
export function stripStateWords(folded: string): string {
  let t = ` ${folded} `
  let changed = true
  while (changed) {
    changed = false
    for (const p of STATE_PHRASES) {
      if (t.startsWith(` ${p} `)) {
        t = t.slice(p.length + 1)
        changed = true
      }
      if (t.endsWith(` ${p} `)) {
        t = t.slice(0, t.length - p.length - 1)
        changed = true
      }
    }
  }
  return t.trim()
}

/** "Boise, ID" / "Springfield IL" / "Raleigh, North Carolina": the state the query names at its end, else null (a
 *  bare "Springfield"). A two-letter code without a comma must be upper case ("Boise ID"), so "fire in" is not
 *  Indiana. */
export function queryState(text: string): string | null {
  const t = text.trim()
  const comma = t.lastIndexOf(',')
  if (comma >= 0) return stateCode(t.slice(comma + 1).trim())
  const words = t.split(/\s+/)
  if (words.length < 2) return null
  for (const n of [2, 1]) {
    if (words.length <= n) continue
    const tail = words.slice(-n).join(' ')
    if (n === 1 && tail.length === 2 && tail !== tail.toUpperCase()) continue
    const code = stateCode(tail)
    if (code) return code
  }
  return null
}

/** Incident matches: every query word must start a word of the name, county, location, unit, id or year. Ranked:
 *  exact name > name prefix > all words in the name > other fields; then active first, then size. */
export function searchIncidents(text: string, pool: readonly IncidentSummary[], limit = 6): IncidentHit[] {
  const q = fold(text)
  if (!q) return []
  const words = q.split(' ')
  const seen = new Set<string>()
  const hits: IncidentHit[] = []
  for (const s of pool) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    const name = fold(s.name)
    const nameWords = name.split(' ')
    const other = fold([s.county, s.location, s.admin_unit, s.id, String(s.year), s.state, stateName(s.state), s.source_name].filter(Boolean).join(' ')).split(' ')
    const all = [...nameWords, ...other]
    if (!words.every((w) => all.some((t) => t.startsWith(w)))) continue
    // "eaton fire 2025": a trailing year that is the incident's own year is part of an exact name
    const qy = q.endsWith(` ${s.year}`) ? q.slice(0, -5) : q
    const exact = name === q || name === qy || fold(s.id) === q
    const bare = !exact && (name === `${q} fire` || name === `${qy} fire`)
    let score = 40
    if (exact) score = 100
    else if (bare) score = 90
    else if (name.startsWith(q)) score = 80
    else if (words.every((w) => nameWords.some((t) => t.startsWith(w)))) score = 60
    hits.push({ summary: s, score, exact, bare })
  }
  return hits
    .sort((a, b) => b.score - a.score || Number(b.summary.is_active) - Number(a.summary.is_active) || (b.summary.acres ?? 0) - (a.summary.acres ?? 0))
    .slice(0, limit)
}

export function planSearch(text: string, pool: readonly IncidentSummary[]): SearchPlan {
  const q = text.trim().replace(/\s+/g, ' ')
  if (!q) return { kind: 'empty' }
  const parsed = parseLatLonDetailed(q)
  if (parsed) return { kind: 'coords', parsed }
  const incidents = searchIncidents(q, pool)
  const exact = incidents.filter((h) => h.exact)
  // one whole incident name: act on it; the same name in several years is listed instead
  if (exact.length === 1) return { kind: 'incident', hit: exact[0], incidents }
  if (looksLikeAddress(q)) return { kind: 'lookup', query: q, expect: 'address', incidents, candidate: null }
  if (!looksLikeZip(q) && !/[A-Za-zÀ-ɏ]/.test(q))
    return { kind: 'invalid', message: 'Enter a street address with a house number, a US town ("Boise, ID") or a ZIP code, or paste coordinates.' }
  const bare = exact.length ? [] : incidents.filter((h) => h.bare)
  return { kind: 'lookup', query: q, expect: 'local', incidents, candidate: bare.length === 1 ? bare[0] : null }
}

/** A positive (east) longitude that would be inside the lower-48 box if negated: the minus sign was probably dropped
 *  ("34.2, 118.1", "33.75, 84.39"). The box is a parsing heuristic, never a coverage claim. */
export function likelyMissingWestSign(p: { lat: number; lon: number }): boolean {
  const [w, s, e, n] = LOWER48_BOX
  return p.lat >= s && p.lat <= n && p.lon >= -e && p.lon <= -w
}

/** CONTRACT §14.10 / §14.14 search messages. */
export const NOT_SUPPORTED_NOTE = 'Fire-3d does not support Alaska, Hawaii or US territories yet.'
export const OUTSIDE_LOWER48_WARNING = 'This point is outside the area Fire-3d covers (the lower 48 states).'
export const SEARCH_EXAMPLES = 'e.g. 600 E Mariposa St, Altadena; Boise, ID; 83702'
export const noPlaceMessage = (q: string) => `No US city, town, county or ZIP code matches “${q}”.`

// ------------------------------------------------------------------------------------------------- incidents
/** Whether an incident's analysis can be opened now. Only 'ready' (or a build in progress) opens without asking. */
export type Readiness = 'ready' | 'building' | 'not-prepared' | 'failed'

export function readiness(s: Pick<IncidentSummary, 'bundle_status'>): Readiness {
  switch (s.bundle_status) {
    case 'ready':
      return 'ready'
    case 'building':
      return 'building'
    case 'error':
      return 'failed'
    default:
      return 'not-prepared'
  }
}

export const READINESS_LABEL: Record<Readiness, string> = {
  ready: 'Analysis ready',
  building: 'Being prepared',
  'not-prepared': 'Data not prepared',
  failed: 'Preparation failed',
}

/** What to do with an incident the user picked (or typed exactly). Never a build: an unprepared fire asks first. */
export type IncidentAction = 'show-current' | 'open' | 'ask-prepare'

export function incidentAction(s: Pick<IncidentSummary, 'id' | 'bundle_status'>, currentId: string | null): IncidentAction {
  if (s.id === currentId) return 'show-current'
  const r = readiness(s)
  return r === 'ready' || r === 'building' ? 'open' : 'ask-prepare'
}

// ------------------------------------------------------------------------------------------------- decisions
export interface ResultLists {
  addresses: GeocodeMatch[]
  places: GeocodeMatch[]
  zips: GeocodeMatch[]
  incidents: IncidentHit[]
}

export type Decision =
  /** One street address and nothing else: select it (approximate, adjustable). */
  | { kind: 'address'; match: GeocodeMatch }
  /** A town or ZIP area: fly there and ask for a street address or a map click; `others` stay listed. */
  | { kind: 'area'; match: GeocodeMatch; others: ResultLists }
  /** The bare incident name, with no town of that name: act on the incident. */
  | { kind: 'incident'; hit: IncidentHit }
  | { kind: 'list'; lists: ResultLists; message: string | null }
  | { kind: 'none'; message: string }

const kindOf = (m: GeocodeMatch) => m.kind ?? 'address'

export function splitMatches(res: GeocodeResponse, incidents: IncidentHit[], exclude?: GeocodeMatch): ResultLists {
  const ms = res.matches.filter((m) => m !== exclude)
  return { addresses: ms.filter((m) => kindOf(m) === 'address'), places: ms.filter((m) => kindOf(m) === 'place'), zips: ms.filter((m) => kindOf(m) === 'zip'), incidents }
}

export const listCount = (l: ResultLists) => l.addresses.length + l.places.length + l.zips.length + l.incidents.length

/** The action after a lookup reply (plan.kind === 'lookup'). */
export function decide(plan: Extract<SearchPlan, { kind: 'lookup' }>, res: GeocodeResponse): Decision {
  const { incidents, candidate } = plan
  const ms = res.matches
  if (plan.expect === 'address') {
    if (ms.length === 1 && !incidents.length) return { kind: 'address', match: ms[0] }
    if (!ms.length && !incidents.length) return { kind: 'none', message: `No US street address matched “${plan.query}”. Check the house number, street and town or ZIP code.` }
    const total = res.total_matches ?? ms.length
    const more = total > ms.length ? ` (the first ${ms.length} of ${total})` : ''
    const message = !ms.length ? `No street address matched “${plan.query}”. Fires that match are listed.` : ms.length === 1 ? 'One address matches: choose it, or a fire below.' : `${ms.length} addresses match${more}: choose one.`
    return { kind: 'list', lists: splitMatches(res, incidents), message }
  }
  const exact = ms.filter((m) => m.exact)
  if (candidate && !exact.length) return { kind: 'incident', hit: candidate }
  if (!ms.length && !incidents.length) return { kind: 'none', message: res.note ?? noPlaceMessage(plan.query) }
  // one match, or one exact name whose other matches are only partial: go there and keep the rest listed
  const go = ms.length === 1 ? ms[0] : exact.length === 1 ? exact[0] : null
  if (go && (!incidents.length || !candidate)) return { kind: 'area', match: go, others: splitMatches(res, incidents, go) }
  const message = ms.length ? null : `${noPlaceMessage(plan.query)} Fires that match are listed.`
  return { kind: 'list', lists: splitMatches(res, incidents), message }
}

/** A match's display name with its state: "Boise, ID" (the backend's own name when it carries the state). */
export function placeName(m: Pick<GeocodeMatch, 'name' | 'matched_address' | 'state'>): string {
  const name = (m.name ?? m.matched_address ?? '').trim()
  if (!m.state || new RegExp(`,\\s*${m.state}$`).test(name)) return name
  return `${name}, ${m.state}`
}

/** "Boise, ID (town center, approximate)", "ZIP 83702, ID near Boise (ZIP area, approximate)". */
export function areaLabel(m: GeocodeMatch): string {
  if (kindOf(m) === 'zip') {
    const zip = m.zip ?? (m.name ?? '').replace(/^ZIP\s+/i, '').replace(/,\s*[A-Z]{2}$/, '')
    return `ZIP ${zip}${m.state ? `, ${m.state}` : ''}${m.near ? ` near ${m.near}` : ''} (ZIP area, approximate)`
  }
  return `${placeName(m)} (town center, approximate)`
}

/** Sub-line of a town or ZIP result: "city · Ada County · town center, approximate" or "ZIP area near Boise"; a match
 *  in Alaska, Hawaii or a territory keeps its row and says Fire-3d does not support it yet (§14.10). */
export function areaSub(m: GeocodeMatch): string {
  const note = m.supported === false ? NOT_SUPPORTED_NOTE : null
  if (kindOf(m) === 'zip') return [`ZIP area${m.near ? ` near ${m.near}` : ''} · approximate`, note].filter(Boolean).join(' · ')
  return [m.place_type_label ?? 'place', m.county ?? null, m.near ? `near ${m.near}` : null, 'town center, approximate', note].filter(Boolean).join(' · ')
}

/** Map view for a town or ZIP area: a box about the size of its land area (at least 3 km, at most 50 km across). */
export function areaBounds(m: Pick<GeocodeMatch, 'lat' | 'lon' | 'land_km2'>): [number, number, number, number] {
  const rKm = Math.min(25, Math.max(1.5, Math.sqrt(Math.max(0, m.land_km2 ?? 0) / Math.PI) * 1.2))
  const dLat = rKm / 111.2
  const dLon = rKm / (111.32 * Math.max(0.2, Math.cos((m.lat * Math.PI) / 180)))
  return [m.lon - dLon, m.lat - dLat, m.lon + dLon, m.lat + dLat]
}

// ------------------------------------------------------------------------------------------------- state machine
export type Tone = 'info' | 'ok' | 'warn' | 'error'

export type Popover =
  | { kind: 'closed' }
  /** Focus in an empty box: what can be searched. */
  | { kind: 'hint' }
  | { kind: 'busy'; text: string }
  | { kind: 'message'; tone: Tone; text: string; lists: ResultLists | null; fix: { lat: number; lon: number } | null; credit?: string | null }
  | { kind: 'results'; message: string | null; lists: ResultLists; response: GeocodeResponse | null }

export interface SearchState {
  /** Sequence number of the latest lookup; replies with another number are dropped. */
  seq: number
  /** The lookup in flight (null = none). */
  pending: number | null
  popover: Popover
}

export const INITIAL_SEARCH: SearchState = { seq: 0, pending: null, popover: { kind: 'closed' } }

export type SearchEvent =
  | { type: 'focus'; empty: boolean }
  | { type: 'blur' }
  | { type: 'edit'; empty: boolean; focused: boolean }
  /** A lookup starts (its number is state.seq + 1). */
  | { type: 'lookup'; text: string }
  | { type: 'reply'; seq: number; popover: Popover }
  | { type: 'show'; popover: Popover }
  /** Escape, Clear, an outside click, a map click, a new selection or incident, a pick: close and cancel. */
  | { type: 'close' }

export function searchReducer(s: SearchState, e: SearchEvent): SearchState {
  switch (e.type) {
    case 'focus':
      return s.popover.kind === 'closed' && e.empty && s.pending == null ? { ...s, popover: { kind: 'hint' } } : s
    case 'blur':
      return s.popover.kind === 'hint' ? { ...s, popover: { kind: 'closed' } } : s
    case 'edit':
      // typing cancels the lookup and clears the old answer
      return { ...s, pending: null, popover: e.empty && e.focused ? { kind: 'hint' } : { kind: 'closed' } }
    case 'lookup': {
      const seq = s.seq + 1
      return { seq, pending: seq, popover: { kind: 'busy', text: e.text } }
    }
    case 'reply':
      return e.seq === s.pending && e.seq === s.seq ? { ...s, pending: null, popover: e.popover } : s
    case 'show':
      return { ...s, pending: null, popover: e.popover }
    case 'close':
      return s.popover.kind === 'closed' && s.pending == null ? s : { ...s, pending: null, popover: { kind: 'closed' } }
  }
}

/** The lookup that a transition cancelled (its AbortController must be aborted), else null. */
export function cancelledLookup(prev: SearchState, next: SearchState): number | null {
  return prev.pending != null && next.pending !== prev.pending ? prev.pending : null
}
