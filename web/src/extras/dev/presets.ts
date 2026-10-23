// Dev page presets (extras-dev.html only; never part of the app). Real incidents: the live Cooley bundle, the Eaton
// and Palisades 2025 replays, and the area of the live Bryson Fire (no Fire-3d bundle; reported location from the
// CAL FIRE active-incident list on 2026-10-17) to show current official evacuation zones.

export interface DevTime {
  label: string
  /** Absolute time (replay) ... */
  atMs?: number
  /** ... or an offset (live) from the wall clock, or from the timeline's NOW marker when `fromMarker`. */
  offsetMs?: number
  /** Offset from the NOW marker (= the bundle's latest observation, `nowMarkerMs` in state/store.ts). */
  fromMarker?: boolean
}

/** Brief 3 (CONTRACT §14.8.7): the fixture-only official preset, rendered by UsOfficialPreset.tsx instead of the map
 *  page (extras-dev.html?preset=us-official): the national NWS answer, local officials' alerts (live, archived,
 *  pending) and the location card at a Jackson County, OR point with Oregon OEM's zones. No backend request. */
export const US_OFFICIAL_PRESET_ID = 'us-official'

export interface DevPreset {
  id: string
  label: string
  mode: 'live' | 'historical'
  incidentId: string | null
  /** Rendered by its own fixture-only page (no map, no backend): the button reloads the page with ?preset=<id>. */
  standalone?: boolean
  /** For presets without a bundle: the reported incident location. */
  point?: { lat: number; lon: number; name: string; startedMs: number; note: string }
  times: DevTime[]
}

const H = 3_600_000

export const DEV_PRESETS: DevPreset[] = [
  {
    id: US_OFFICIAL_PRESET_ID,
    label: 'US official (fixtures, no backend)',
    mode: 'live',
    incidentId: null,
    standalone: true,
    times: [{ label: 'Now', offsetMs: 0 }],
  },
  {
    id: 'cooley',
    label: 'Cooley Fire (live)',
    mode: 'live',
    incidentId: '2026-cooley-fire-0c342f',
    times: [
      { label: 'NOW (latest observation)', fromMarker: true, offsetMs: 0 },
      { label: '+24 h forecast', fromMarker: true, offsetMs: 24 * H },
      { label: '12 h before NOW', fromMarker: true, offsetMs: -12 * H },
    ],
  },
  {
    id: 'bryson',
    label: 'Bryson Fire area (live, no bundle)',
    mode: 'live',
    incidentId: null,
    point: {
      lat: 34.092387,
      lon: -118.840668,
      name: 'Bryson Fire',
      startedMs: Date.UTC(2026, 9, 15, 23, 41),
      note: 'CAL FIRE reported location (active-incident list, 2026-10-17)',
    },
    times: [{ label: 'Now', offsetMs: 0 }],
  },
  {
    id: 'eaton',
    label: 'Eaton Fire (2025 replay)',
    mode: 'historical',
    incidentId: '2025-eaton-fire-dbfa57',
    times: [
      { label: 'Jan 7, 20:30 PST', atMs: Date.UTC(2025, 0, 8, 4, 30) },
      { label: 'Jan 8, 12:00 PST', atMs: Date.UTC(2025, 0, 8, 20, 0) },
      { label: 'Jan 9, 15:00 PST', atMs: Date.UTC(2025, 0, 9, 23, 0) },
    ],
  },
  {
    id: 'palisades',
    label: 'Palisades Fire (2025 replay)',
    mode: 'historical',
    incidentId: '2025-palisades-fire-abfed7',
    times: [
      { label: 'Jan 7, 14:00 PST', atMs: Date.UTC(2025, 0, 7, 22, 0) },
      { label: 'Jan 8, 12:00 PST', atMs: Date.UTC(2025, 0, 8, 20, 0) },
    ],
  },
]

/** The preset time in epoch ms; marker-relative times fall back to the wall clock until the bundle has loaded. */
export function resolveTime(t: DevTime, nowMs: number, markerMs: number | null): number {
  if (t.atMs != null) return t.atMs
  return (t.fromMarker && markerMs != null ? markerMs : nowMs) + (t.offsetMs ?? 0)
}
