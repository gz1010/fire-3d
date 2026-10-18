// Census details of the last geocoded address selection (owner: location). The workspace selection keeps only the
// label and flags; the card also shows the matched address range and benchmark, so they are kept here and matched to
// the selection by address and source. Memory only: never written to the URL or storage (privacy).
import { create } from 'zustand'
import type { SelectedLocation } from '../state/workspace'
import type { AddressDetails, GeocodeMatch, GeocodeResponse } from './types'

interface AddressState {
  details: AddressDetails | null
  setDetails: (d: AddressDetails | null) => void
}

export const useAddressDetails = create<AddressState>()((set) => ({
  details: null,
  setDetails: (details) => set({ details }),
}))

export function addressDetails(res: GeocodeResponse, m: GeocodeMatch): AddressDetails {
  return {
    query: res.query,
    matchedAddress: m.matched_address,
    lat: m.lat,
    lon: m.lon,
    fromAddress: m.from_address ?? null,
    toAddress: m.to_address ?? null,
    side: m.side,
    tigerLineId: m.tiger_line_id,
    benchmark: res.benchmark,
    source: res.source,
    fetchedMs: res.fetched_ms,
  }
}

/** "100–144": the TIGER/Line house-number range in ascending order (Census lists it along the edge direction). */
export function addressRange(from: string | null | undefined, to: string | null | undefined): string | null {
  if (!from || !to) return null
  const a = Number(from)
  const b = Number(to)
  return Number.isFinite(a) && Number.isFinite(b) && a > b ? `${to}–${from}` : `${from}–${to}`
}

const KEEP_UPPER = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'CA', 'US', 'PO', 'RR', 'HC', 'II', 'III', 'IV'])

/** Census writes addresses in capitals ("600 E MARIPOSA ST, ALTADENA, CA, 91001"); show "600 E Mariposa St, Altadena,
 *  CA 91001". Directions, state codes and house numbers keep their form; text that is not all capitals is left alone. */
export function prettyAddress(a: string): string {
  if (!a || a !== a.toUpperCase()) return a
  const parts = a.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length >= 2 && /^\d{5}(-\d{4})?$/.test(parts[parts.length - 1]) && /^[A-Z]{2}$/.test(parts[parts.length - 2])) {
    const zip = parts.pop()!
    parts[parts.length - 1] = `${parts[parts.length - 1]} ${zip}`
  }
  const word = (w: string) => {
    if (KEEP_UPPER.has(w) || /^\d+[A-Z]?$/.test(w) || /^[A-Z]\d/.test(w)) return w
    const ord = w.match(/^(\d+)(ST|ND|RD|TH)$/)
    if (ord) return `${ord[1]}${ord[2].toLowerCase()}`
    return w.toLowerCase().replace(/(^|[-'’/])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())
  }
  return parts.map((p, i) => (i === parts.length - 1 && /^[A-Z]{2}( \d{5}(-\d{4})?)?$/.test(p) ? p : p.split(/\s+/).map(word).join(' '))).join(', ')
}

/** The details that belong to `sel` (an address selection with the same matched address), else null. */
export function detailsFor(sel: SelectedLocation | null, d: AddressDetails | null): AddressDetails | null {
  return sel && d && sel.source === 'address' && (sel.matchedAddress ?? sel.label) === d.matchedAddress ? d : null
}
