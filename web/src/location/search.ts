// Search planning for the location search box (owner: location; CONTRACT §5.1). Pure. Order: pasted coordinates
// (parsed locally, never sent anywhere) -> local incident names from the loaded catalog -> an explicitly submitted US
// street address (Census Geocoder through /api/geocode) only when the text starts with a house number. No
// autocomplete, no place-name / POI search (the Census Geocoder does not do either) and no Nominatim.
import type { IncidentSummary } from '../api/types'
import { parseLatLonDetailed, type ParsedLatLon } from '../lib/geodesy'

export interface IncidentHit {
  summary: IncidentSummary
  score: number
}

export type SearchPlan =
  | { kind: 'empty' }
  | { kind: 'coords'; parsed: ParsedLatLon }
  /** Local incident matches only (the text is not a street address). */
  | { kind: 'incidents'; incidents: IncidentHit[] }
  /** Look the address up; `incidents` are shown alongside when the text also matches incident names. */
  | { kind: 'address'; query: string; incidents: IncidentHit[] }
  | { kind: 'nothing'; incidents: [] }

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** A US street address starts with a house number followed by a street word ("600 E Mariposa St, Altadena"),
 *  including grid styles such as "N1234 County Rd" or "100-12 Main St". */
export function looksLikeAddress(text: string): boolean {
  return /^\s*(?:[NSEW]\s?)?\d+[A-Z]?(?:[-/]\d+[A-Z]?)?\s+[A-Za-z0-9]/i.test(text) && /[A-Za-z]{2,}/.test(text)
}

/** Incident matches: every query word must start a word of the name, county, location, unit, id or year.
 *  Ranked: exact name > name prefix > all words in the name > other fields; then active first, then size. */
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
    const other = fold([s.county, s.location, s.admin_unit, s.id, String(s.year)].filter(Boolean).join(' ')).split(' ')
    const all = [...nameWords, ...other]
    if (!words.every((w) => all.some((t) => t.startsWith(w)))) continue
    let score = 40
    if (name === q || name === `${q} fire`) score = 100
    else if (name.startsWith(q)) score = 80
    else if (words.every((w) => nameWords.some((t) => t.startsWith(w)))) score = 60
    hits.push({ summary: s, score })
  }
  return hits
    .sort((a, b) => b.score - a.score || Number(b.summary.is_active) - Number(a.summary.is_active) || (b.summary.acres ?? 0) - (a.summary.acres ?? 0))
    .slice(0, limit)
}

export function planSearch(text: string, pool: readonly IncidentSummary[]): SearchPlan {
  const q = text.trim()
  if (!q) return { kind: 'empty' }
  const parsed = parseLatLonDetailed(q)
  if (parsed) return { kind: 'coords', parsed }
  const incidents = searchIncidents(q, pool)
  if (looksLikeAddress(q)) return { kind: 'address', query: q.replace(/\s+/g, ' '), incidents }
  if (incidents.length) return { kind: 'incidents', incidents }
  return { kind: 'nothing', incidents: [] }
}

/** California-looking latitude with a positive (east) longitude that would be in California if negated: the minus
 *  sign was probably dropped ("34.2, 118.1"). */
export function likelyMissingWestSign(p: { lat: number; lon: number }): boolean {
  return p.lat >= 32 && p.lat <= 42.5 && p.lon >= 113.5 && p.lon <= 125
}
