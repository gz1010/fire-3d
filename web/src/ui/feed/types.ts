// Updates feed item (owner: official-web since brief 2, earlier timeline-feed; agreed in CONTRACT §8, BRIEF §10). The
// optional fields are additions; existing consumers can ignore them.
import type { OfficialHighlight } from '../../official/types'
import type { EventKind } from '../eventMeta'

/** What kind of information an item is (shown on every item; automated items are never presented as human reports). */
export type FeedKind = 'observation' | 'estimate' | 'model' | 'official' | 'annotation'

/** What the item is about: events.json types + annotations, plus feed-only topics. */
export type FeedTopic =
  | EventKind
  | 'detection'
  | 'perimeter'
  | 'forecast'
  | 'evacuation'
  | 'weather'
  | 'imagery'
  | 'camera'
  // brief 2 (official-web): CAL FIRE record changes, NWS fire weather alerts, the live "no new heat" quiet row
  | 'calfire'
  | 'fire-weather'
  | 'quiet'

/** One plain-language fact with the original scientific value kept next to it. */
export interface FeedFact {
  label: string
  text: string
  scientific: string | null
}

/** Lifecycle of an official item at the time it is shown. */
export type FeedItemStatus = 'active' | 'upcoming' | 'expired' | 'cancelled'

export interface FeedItem {
  /** Stable id: the events.json / annotation id, else "<topic>:<t_ms>[:n]". */
  id: string
  topic: FeedTopic
  kind: FeedKind
  /** Event time (epoch ms UTC). Official items: the issuer's time, else the source's own time (never Fire-3d's
   *  fetch time; see `timeNotGiven`). */
  tMs: number
  /** Plain-language title. */
  title: string
  detail: string | null
  /** Who / what produced it, e.g. "NASA FIRMS (VIIRS, NOAA-20)", "Fire-3d reconstruction (...)", "You". */
  source: string
  /** Machine-generated (event detection, model output) rather than reported by a person or agency. */
  automated: boolean
  /** Promoted Key Event (events.json + annotations). */
  key: boolean
  confidence: 'observed' | 'estimated' | 'probable' | null
  /** Geolocated items: WGS84 + incident-local metres (both, so 2D/3D map and Forensic can fly there). */
  location: { lon: number; lat: number; x: number; z: number } | null
  /** Selecting it moves the timeline to tMs (false for current-status items such as live evacuation status). */
  seekable: boolean
  /** store.selectedEventId value for timeline-marker sync (events.json / annotation id), else null. */
  eventId: string | null

  // ---- additions (timeline-feed)
  /** Timeline target when it differs from tMs (a live forecast is listed when issued but starts earlier). */
  seekMs?: number
  /** The producer's own wording (scientific units) for details and Forensic. */
  original?: { title: string; detail: string | null; source: string } | null
  /** Plain-language facts with the scientific value kept alongside. */
  facts?: FeedFact[]
  /** The location is approximate (estimated position, centre of an area or of a detection pass). */
  approximate?: boolean
  /** What the location represents, e.g. "Center of the detections". */
  locationLabel?: string | null

  // ---- additions (official-web, brief 2 U-R2): authority, own times and a link on every official row
  /** The source's own page for this item (https only; shown as "Open source"). */
  url?: string | null
  /** Who issued it: "Orange County" (local officials), "NWS Los Angeles/Oxnard CA", "CAL FIRE". */
  issuer?: string | null
  /** The issuer's times (null / absent = not given by the issuer). */
  issuedMs?: number | null
  updatedMs?: number | null
  expiresMs?: number | null
  /** When Fire-3d last checked the source ("Checked by Fire-3d …"). */
  checkedMs?: number | null
  /** [w, s, e, n] the map fits when the item is selected (its official area). */
  bounds?: [number, number, number, number] | null
  status?: FeedItemStatus | null
  /** Distance from the item's area to the fire, km (0 = touching). */
  distanceKm?: number | null
  /** The official area the map highlights while the item is selected. */
  highlight?: OfficialHighlight | null
  /** Further official links, e.g. the county's own evacuation map. */
  links?: { label: string; url: string }[]
  /** Verbatim parts shown on demand (NWS WHAT / WHERE / WHEN / IMPACTS / instructions). */
  sections?: { label: string; text: string }[]
  /** An archived copy (Iowa Environmental Mesonet) of an official product, not the live source. */
  archived?: boolean
  /** Short notes for the details, e.g. "Cal OES does not say which fire this is for." */
  notes?: string[]
  /** No issuer or source time exists: the time column says so (tMs only orders the list). */
  timeNotGiven?: boolean
  /** A day's satellite passes grouped into one row: the passes it holds (each selectable in the details). */
  children?: FeedItem[]
}
