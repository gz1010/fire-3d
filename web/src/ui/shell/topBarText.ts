// Pure text helpers of the top bar (brief 4; tests in TopBar.test.ts): the place shown in grey after a fire's name, and
// the parts of the mono status line with their stale flag.
import type { IncidentSummary } from '../../api/types'
import { stateName } from '../../lib/usStates'

/** The record's own location text when it has one, else "<County> County, <State name>", else the state's name
 *  (PLAN-4 §3.1). */
export function placeLine(s: Pick<IncidentSummary, 'location' | 'county' | 'state'> | null | undefined): string | null {
  if (!s) return null
  const loc = s.location?.trim()
  if (loc) return loc
  const state = s.state ? (stateName(s.state) ?? s.state) : null
  const county = s.county?.trim()
  if (county) return state ? `${county} County, ${state}` : `${county} County`
  return state
}

/** One status part and whether it is shown as stale (amber). */
export interface StatusSegment {
  text: string
  stale: boolean
}

/** Pure: the parts of a status line, marking every part from `staleFrom` on as stale. Empty parts are dropped. */
export function statusSegments(parts: readonly string[], staleFrom?: number | null): StatusSegment[] {
  const out: StatusSegment[] = []
  parts.forEach((text, i) => {
    if (text.trim() === '') return
    out.push({ text, stale: staleFrom != null && staleFrom >= 0 && i >= staleFrom })
  })
  return out
}
