// Fixed copy every view keeps (brief 4, HANDOFF "Fixed copy"; CONTRACT §15.4, frozen after H2). Exact strings: tests
// and the views read them from here, never retype them.
import { LIST_ABSENCE } from '../../state/overview'

export const PROTOTYPE_LINE = 'Research prototype — not for operational use'
export const NOT_ALL_CLEAR = 'Not an all-clear. Follow local officials.'
/** Main's one-line disclaimer: "RESEARCH PROTOTYPE · Not for operational use. " + §14.14 LIST_ABSENCE. */
export const PROTOTYPE_LEAD = 'Research prototype'
export const PROTOTYPE_TAIL = 'Not for operational use.'

export type FixedCopyVariant = 'line' | 'corner' | 'bar' | 'pill'

/** What follows the prototype line when the caller does not say (`extra` undefined): Main's line ends with the
 *  list-absence sentence; Command (corner) and Forensic (pill) add "Not an all-clear" (decision i-8: their screens lack
 *  it); the fire view's bar has none (its facts end with NOT_ALL_CLEAR). `null` or '' = nothing after the line. */
export function defaultExtra(variant: FixedCopyVariant): string | null {
  if (variant === 'line') return LIST_ABSENCE
  if (variant === 'corner' || variant === 'pill') return NOT_ALL_CLEAR
  return null
}

/** The extra text actually shown: the caller's, else the variant's default. */
export function fixedCopyExtra(variant: FixedCopyVariant, extra?: string | null): string | null {
  const e = extra === undefined ? defaultExtra(variant) : extra
  return e && e.trim() ? e : null
}

/** The whole copy as one plain string (what a reader hears; tests). */
export function fixedCopyText(variant: FixedCopyVariant, extra?: string | null): string {
  const e = fixedCopyExtra(variant, extra)
  if (variant === 'line') return `${PROTOTYPE_LEAD} · ${PROTOTYPE_TAIL}${e ? ` ${e}` : ''}`
  return e ? `${PROTOTYPE_LINE} · ${e}` : PROTOTYPE_LINE
}
