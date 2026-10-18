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

/** The details that belong to `sel` (an address selection with the same matched address), else null. */
export function detailsFor(sel: SelectedLocation | null, d: AddressDetails | null): AddressDetails | null {
  return sel && d && sel.source === 'address' && (sel.matchedAddress ?? sel.label) === d.matchedAddress ? d : null
}
