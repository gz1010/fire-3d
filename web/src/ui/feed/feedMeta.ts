// Feed vocabulary (owner: official-web since brief 2, earlier timeline-feed): icon + colour per topic (events reuse
// eventMeta) and the label, glyph and one-line meaning of each kind of information. Kinds are told apart by text and
// glyph, never by colour alone.
import { Camera, CircleDashed, Cpu, Eye, EyeOff, Flag, Hexagon, ImageIcon, Landmark, PenLine, Satellite, ShieldAlert, Sigma, TriangleAlert, Wind, type LucideIcon } from 'lucide-react'
import { EVENT_STYLE, type EventKind } from '../eventMeta'
import type { FeedKind, FeedTopic } from './types'

export interface TopicStyle {
  Icon: LucideIcon
  color: string
  label: string
}

const FEED_TOPICS: Record<Exclude<FeedTopic, EventKind>, TopicStyle> = {
  detection: { Icon: Satellite, color: 'var(--m-detection)', label: 'Satellite pass' },
  perimeter: { Icon: Hexagon, color: 'var(--m-perimeter)', label: 'Mapped perimeter' },
  forecast: { Icon: CircleDashed, color: 'var(--m-forecast)', label: 'Forecast run' },
  evacuation: { Icon: TriangleAlert, color: 'var(--m-evac-order)', label: 'Evacuation' },
  weather: { Icon: Wind, color: 'var(--ev-wind)', label: 'Weather' },
  imagery: { Icon: ImageIcon, color: 'var(--m-info)', label: 'Satellite image' },
  camera: { Icon: Camera, color: 'var(--m-info)', label: 'Camera' },
  calfire: { Icon: ShieldAlert, color: 'var(--m-official, #e8edf3)', label: 'CAL FIRE record' },
  'fire-weather': { Icon: Flag, color: 'var(--m-nws, #f472b6)', label: 'Fire weather alert' },
  quiet: { Icon: EyeOff, color: 'var(--m-text-2)', label: 'No new heat seen' },
}

export function topicStyle(topic: FeedTopic): TopicStyle {
  if (topic in EVENT_STYLE) {
    const s = EVENT_STYLE[topic as EventKind]
    return { Icon: s.Icon, color: s.color, label: s.plain }
  }
  return FEED_TOPICS[topic as Exclude<FeedTopic, EventKind>]
}

export interface KindMeta {
  label: string
  Icon: LucideIcon
  /** What this kind of information is, in one sentence. */
  meaning: string
}

export const KIND_META: Record<FeedKind, KindMeta> = {
  observation: {
    label: 'Observation',
    Icon: Eye,
    meaning: 'Observed or measured, not modeled: for example satellite heat detections or images, agency-mapped perimeters, public cameras, or growth measured between satellite observations.',
  },
  estimate: { label: 'Estimate', Icon: Sigma, meaning: 'Inferred by Fire-3d from observations (for example the reconstructed spread); it can be wrong.' },
  model: { label: 'Model output', Icon: Cpu, meaning: 'Computed by a weather or fire-spread model, not observed.' },
  official: {
    label: 'Official update',
    Icon: Landmark,
    meaning: "Published by an agency (fire, emergency-management or weather service) and quoted from its data; Fire-3d does not change the wording.",
  },
  annotation: { label: 'Your note', Icon: PenLine, meaning: 'A note you added; it is saved only in this browser.' },
}

export const AUTOMATED_NOTE = 'Generated automatically by Fire-3d from the listed data; not reported by a person.'

/** The standing line next to official information (BRIEF-2: model output is never an evacuation order). */
export const NOT_AN_ORDER = "Fire-3d's modeled spread is experimental and is not an evacuation order. Follow local officials."

/** Empty feed (live, or nothing loaded): silence is never presented as safety. */
export const EMPTY_FEED = "No updates from Fire-3d's sources yet. No update does not mean no danger; follow local officials."
/** Replay before the first item. */
export const EMPTY_REPLAY = 'No updates in the record before this time.'
