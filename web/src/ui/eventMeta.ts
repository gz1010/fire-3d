// Visual vocabulary of key events (icon + colour per type), shared by Key Events, timeline markers, charts, the
// Public/Command updates feed and map markers. `hex` mirrors the --ev-* tokens in styles/theme.css for consumers that
// cannot read CSS variables (MapLibre paint); keep both in sync. `plain` is the everyday label for Public/Command.
import { CircleDot, Flame, Hexagon, Mountain, Navigation2, ShieldCheck, StickyNote, Triangle, Wind, type LucideIcon } from 'lucide-react'
import type { EventType } from '../api/types'

export type EventKind = EventType | 'annotation'

export interface EventStyle {
  Icon: LucideIcon
  color: string // CSS colour (var)
  label: string
  /** marker glyph on the timeline track */
  glyph: 'dot' | 'triangle' | 'diamond' | 'square' | 'flame' | 'tick'
  /** Everyday label (Public/Command). */
  plain: string
  /** The same colour as a literal (MapLibre paint cannot read CSS variables). */
  hex: string
}

export const EVENT_STYLE: Record<EventKind, EventStyle> = {
  ignition: { Icon: CircleDot, color: 'var(--ev-ignition)', label: 'Ignition', glyph: 'dot', plain: 'Fire start', hex: '#e5483a' },
  rapid_growth: { Icon: Flame, color: 'var(--ev-rapid)', label: 'Rapid growth', glyph: 'flame', plain: 'Rapid growth', hex: '#ff6a2b' },
  spot_fire: { Icon: Triangle, color: 'var(--ev-spot)', label: 'Spot fire', glyph: 'triangle', plain: 'Possible spot fire', hex: '#f0a35e' },
  ridge_crossing: { Icon: Mountain, color: 'var(--ev-ridge)', label: 'Ridge crossing', glyph: 'triangle', plain: 'Ridge crossing', hex: '#e2be72' },
  containment: { Icon: ShieldCheck, color: 'var(--ev-containment)', label: 'Containment', glyph: 'square', plain: 'Containment', hex: '#8fa8bf' },
  peak_wind: { Icon: Wind, color: 'var(--ev-wind)', label: 'Peak wind', glyph: 'diamond', plain: 'Peak wind', hex: '#9cc9d9' },
  wind_shift: { Icon: Navigation2, color: 'var(--ev-wind)', label: 'Wind shift', glyph: 'diamond', plain: 'Spread direction change', hex: '#9cc9d9' },
  perimeter_update: { Icon: Hexagon, color: 'var(--ev-perimeter)', label: 'Perimeter', glyph: 'tick', plain: 'Mapped perimeter', hex: '#b9a27a' },
  annotation: { Icon: StickyNote, color: 'var(--ev-note)', label: 'Annotation', glyph: 'diamond', plain: 'Your note', hex: '#c9b8e8' },
}

export const CONFIDENCE_LABEL: Record<string, string> = {
  observed: 'Observed',
  estimated: 'Estimated',
  probable: 'Probable',
}
