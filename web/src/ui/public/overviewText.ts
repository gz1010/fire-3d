// Words of the national overview's floating chrome (brief 4, Main.dc.html; PLAN-4 §3.3, decisions d and i-4). Pure,
// tested in overviewText.test.ts.
//   - the top bar's right side: the viewer's local date and the number of listed active fires ("OCT 24 2026 · 203
//     ACTIVE"); a count of fires the agencies list, never of all fires (the tooltip says so, LIST_ABSENCE), and never
//     "0" when the lists could not be read (§14.16);
//   - the "Show details" pill: what it opens and how many fires the map shows for the current filter.
import { LIST_ABSENCE } from '../../state/overview'

/** "OCT 24 2026": the viewer's own local date, in the bar's mono capitals. */
export function barDate(nowMs: number, timeZone?: string): string {
  const d = new Date(nowMs)
  const parts = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...(timeZone ? { timeZone } : {}) }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('month')} ${get('day')} ${get('year')}`.toUpperCase()
}

export interface ActiveCountInput {
  /** Active fires in the live list. */
  count: number
  /** The live list has answered at least once. */
  loaded: boolean
  loading: boolean
  /** The live list failed to load (and has no earlier answer). */
  failed: boolean
  /** Every agency source behind the live list is down (the server lists prepared fires only). */
  allDown: boolean
}

/** The count part of the bar's status: "203 ACTIVE", or why there is no count. `tone` 'count' is drawn in fire orange. */
export function activeCountPart(i: ActiveCountInput): { text: string; tone: 'count' | 'quiet' | 'warn' } {
  if (!i.loaded) return i.failed && !i.loading ? { text: 'FIRE LIST UNAVAILABLE', tone: 'warn' } : { text: 'LOADING FIRES', tone: 'quiet' }
  if (i.allDown) return { text: 'FIRE LISTS UNAVAILABLE', tone: 'warn' }
  return { text: `${i.count.toLocaleString('en-US')} ACTIVE`, tone: 'count' }
}

/** The status's tooltip (decision i-4): what the number counts and that a place without a marker is not an
 *  all-clear (§14.14 LIST_ABSENCE, verbatim). */
export const ACTIVE_COUNT_TIP = `Active fires listed by CAL FIRE (California) and NIFC WFIGS (elsewhere), lower 48 states. ${LIST_ABSENCE}`

/** The pill's visible text and accessible name (decision d): "Show details" / "Hide details", and the number of fires
 *  the map shows for the current filter (the list's "Show all N"). */
export function detailsPillLabel(open: boolean, count: number | null): { text: string; aria: string } {
  const text = open ? 'Hide details' : 'Show details'
  if (count == null) return { text, aria: `${text}: fire list loading` }
  const n = `${count.toLocaleString('en-US')} fire${count === 1 ? '' : 's'}`
  return { text, aria: open ? `Hide details (list of ${n})` : `Show details: list of ${n}` }
}
