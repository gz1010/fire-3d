// Pure text of Command's readout (brief 4, location/CommandReadout.tsx) and the coordinate strip: the coordinate line,
// the near-here sentence and what a selection is called. Tested in readoutText.test.ts.
import { formatDms } from '../lib/geodesy'
import { lonLatToUtm } from '../lib/reproject'
import type { SelectedLocation } from '../state/workspace'
import type { NearHere } from './describe'

/** "36°13′58.3″ N · 121°25′53.2″ W · UTM 10N 640958 E 4010917 N · WGS84". */
export function coordinateLine(lat: number, lon: number, zone: number | null): string {
  const parts = [formatDms(lat, lon).replace(', ', ' · ')]
  if (zone) {
    const utm = lonLatToUtm(lon, lat, zone)
    parts.push(`UTM ${zone}N ${Math.round(utm[0])} E ${Math.round(utm[1])} N`)
  }
  parts.push('WGS84')
  return parts.join(' · ')
}

/** The near-here line as one sentence: "Inside the mapped fire area. Burned around … (estimate), 0.2 mi from the
 *  edge." / "0.8 mi east of the mapped fire edge." */
export function nearSentence(n: Pick<NearHere, 'text' | 'burned' | 'edge'>): string {
  // a line still loading ("Checking the fire perimeter…") keeps its ellipsis
  if (/…\s*$/.test(n.text) && !n.burned && !n.edge) return n.text.trim()
  const head = n.text.replace(/[.\s]+$/, '')
  if (n.burned) return `${head}. ${n.burned}${n.edge ? `, ${n.edge}` : ''}.`
  return `${head}${n.edge ? `, ${n.edge}` : ''}.`
}

/** What the selected point is ("Selected point", "Selected address · approximate", "Entered point · moved", …). */
export function selectedLabel(sel: SelectedLocation): string {
  if (sel.source === 'address') return sel.adjusted ? 'Selected address · pin moved' : 'Selected address · approximate'
  if (sel.source === 'event') return sel.approximate ? 'Event location · estimated' : 'Event location'
  if (sel.source === 'incident') return 'Selected · incident reported location'
  if (sel.source === 'coords') return sel.adjusted ? 'Entered point · moved' : 'Entered point'
  if (sel.source === 'device') return 'Your location (from your browser)'
  return sel.adjusted ? 'Selected point · moved' : 'Selected point'
}
