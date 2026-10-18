// Updates feed item (owner: timeline-feed; agreed in CONTRACT §8, BRIEF §10). The optional fields at the end are
// additions (timeline-feed): richer plain-language details; existing consumers can ignore them.
import type { EventKind } from '../eventMeta'

/** What kind of information an item is (shown on every item; automated items are never presented as human reports). */
export type FeedKind = 'observation' | 'estimate' | 'model' | 'official' | 'annotation'

/** What the item is about: events.json types + annotations, plus feed-only topics. */
export type FeedTopic = EventKind | 'detection' | 'perimeter' | 'forecast' | 'evacuation' | 'weather' | 'imagery' | 'camera'

/** One plain-language fact with the original scientific value kept next to it. */
export interface FeedFact {
  label: string
  text: string
  scientific: string | null
}

export interface FeedItem {
  /** Stable id: the events.json / annotation id, else "<topic>:<t_ms>[:n]". */
  id: string
  topic: FeedTopic
  kind: FeedKind
  /** Event time (epoch ms UTC). */
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
  /** What the location represents, e.g. "Centre of the detections". */
  locationLabel?: string | null
}
