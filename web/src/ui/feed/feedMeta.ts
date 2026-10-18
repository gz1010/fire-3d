// Feed vocabulary (owner: timeline-feed): icon + colour per topic (events reuse eventMeta) and the label, glyph and
// one-line meaning of each kind of information. Kinds are told apart by text and glyph, never by colour alone.
import { Camera, CircleDashed, Cpu, Eye, Hexagon, ImageIcon, Landmark, PenLine, Satellite, Sigma, TriangleAlert, Wind, type LucideIcon } from 'lucide-react'
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
  official: { label: 'Official update', Icon: Landmark, meaning: 'A status published by a fire agency, quoted from its data.' },
  annotation: { label: 'Your note', Icon: PenLine, meaning: 'A note you added; it is saved only in this browser.' },
}

export const AUTOMATED_NOTE = 'Generated automatically by Fire-3d from the listed data; not reported by a person.'
