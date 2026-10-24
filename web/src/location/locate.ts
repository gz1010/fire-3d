// "Use my location" (brief 4, Main.dc.html locate-me button; PLAN-4 §3.3 and decision i-7; CONTRACT §15.3). Pure parts,
// tested in locate.test.ts; the button is location/LocateButton.tsx. The browser's own geolocation is asked only when
// the user clicks the button (navigator.geolocation.getCurrentPosition; no outside location service). The answer
// becomes the workspace's `device` (memory only: never in the URL, never stored, never sent): the map flies there and
// marks it (map/DeviceMarker.tsx). Only "Check this spot" makes it the selected point ("Your location"), which the
// location card then checks like a map click; that sends the point to Fire-3d's server, and the prompt says so first
// (H3+H4 review R3: the check used to run at once while the tooltip said the point was not saved). Plain messages say
// why there is no answer.
import type { DeviceLocation, SelectedLocation } from '../state/workspace'

/** A fix less precise than this (metres) is marked approximate (the pin's dashed ring, the card's "approximate"). */
export const APPROXIMATE_OVER_M = 100
/** How long the browser may take before we say so (ms). */
export const LOCATE_TIMEOUT_MS = 15_000
/** A fix the browser already has may be this old (ms). */
export const LOCATE_MAX_AGE_MS = 60_000

export const LOCATE_LABEL = 'Use my location'
export const LOCATE_TIP =
  'Use my location: your browser finds it (only when you click) and the map shows it. It stays in this browser (not sent, saved or put in the link) unless you choose to check that spot.'
/** The prompt once the map shows the location (decision i-7: what a check sends, said before it is sent). */
export const LOCATE_FOUND = 'Your location from your browser is on the map. It stays in this browser.'
export const LOCATE_CHECK_LABEL = 'Check this spot'
export const LOCATE_CHECK_NOTE =
  "Checking sends this point to Fire-3d's server, which looks up the place and asks official sources (evacuation zones, alerts) about the area around it, as for a map click."
export const LOCATE_HIDE_LABEL = 'Stop showing my location'

export type LocateFailure = 'denied' | 'unavailable' | 'timeout' | 'unsupported' | 'insecure'

/** What we tell the user when there is no location (never a guess, never a default place). */
export const LOCATE_MESSAGES: Record<LocateFailure, string> = {
  denied: 'Location sharing is turned off for this site. To use it, allow location in your browser’s site settings, or search for an address.',
  unavailable: 'Your browser could not find your location right now. Try again, or search for an address.',
  timeout: 'Finding your location took too long. Try again, or search for an address.',
  unsupported: 'This browser cannot share its location. Search for an address instead.',
  insecure: 'Your browser shares its location only on a secure (https) page. Search for an address instead.',
}

/** GeolocationPositionError.code → our failure (1 denied, 2 unavailable, 3 timeout). */
export function locateFailure(code: number | null | undefined): LocateFailure {
  if (code === 1) return 'denied'
  if (code === 3) return 'timeout'
  return 'unavailable'
}

/** The browser's fix as the workspace's device location; null when the numbers are unusable. */
export function deviceFromPosition(p: { coords: { latitude: number; longitude: number; accuracy?: number | null }; timestamp?: number }, nowMs: number): DeviceLocation | null {
  const { latitude: lat, longitude: lon } = p.coords
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  const acc = p.coords.accuracy
  return { lat, lon, accuracyM: typeof acc === 'number' && Number.isFinite(acc) && acc >= 0 ? acc : null, tMs: typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? p.timestamp : nowMs }
}

/** The selected point for a device location: "Your location", approximate when the browser's accuracy is coarser than
 *  APPROXIMATE_OVER_M or unknown. */
export function deviceSelection(d: DeviceLocation): SelectedLocation {
  return { lat: d.lat, lon: d.lon, source: 'device', label: 'Your location', approximate: d.accuracyM == null || d.accuracyM > APPROXIMATE_OVER_M }
}

/** The map zoom for a device location: closer for a precise fix, wider for a coarse one (a city-wide guess). */
export function deviceZoom(accuracyM: number | null): number {
  if (accuracyM == null) return 11
  if (accuracyM <= 200) return 14
  if (accuracyM <= 1_000) return 13
  if (accuracyM <= 5_000) return 11
  return 9
}
