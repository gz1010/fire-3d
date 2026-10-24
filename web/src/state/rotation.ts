// One rotation target at a time (brief 4 decision f; CONTRACT §15.3): the mounted Public/Command map registers
// itself (map/mapController.ts), and the Forensic camera does the same (H5, scene/camera/CameraRig.tsx). Only one
// workspace is mounted at a time; when two targets overlap for a moment (a workspace switch mounting the new view
// before the old one unmounts), the most recently registered one is the visible view and gets the turn. The keyboard
// shortcuts Q / E (turn 15° left / right) and N (north up) in state/runtime.ts useHotkeys go through rotateView and
// viewNorthUp. They never fire while typing in a text field or while a popover is open (popoverOpen), so a menu's
// type-ahead or a search box keeps those letters.

export interface RotationTarget {
  /** Turn the heading by `deg` (clockwise when positive). */
  rotateBy(deg: number): void
  /** Heading 0 (north up). */
  northUp(): void
  /** Set the heading (compass degrees, clockwise from north). */
  setBearing(deg: number): void
  /** The current heading. */
  bearing(): number
}

/** Q and E turn the view by this many degrees (as the ⟲ ⟳ buttons). */
export const ROTATE_STEP_DEG = 15

const targets: RotationTarget[] = []

/** Register the visible view's rotation; returns the function that unregisters it. */
export function registerRotation(t: RotationTarget): () => void {
  targets.push(t)
  return () => {
    const i = targets.lastIndexOf(t)
    if (i >= 0) targets.splice(i, 1)
  }
}

/** The view that rotation commands go to (null when none is mounted). */
export function rotationTarget(): RotationTarget | null {
  return targets[targets.length - 1] ?? null
}

/** Turn the visible view by `deg`; false when no view takes rotation. */
export function rotateView(deg: number): boolean {
  const t = rotationTarget()
  if (!t || !Number.isFinite(deg)) return false
  t.rotateBy(deg)
  return true
}

/** North up in the visible view; false when no view takes rotation. */
export function viewNorthUp(): boolean {
  const t = rotationTarget()
  if (!t) return false
  t.northUp()
  return true
}

/** What counts as an open popover for the shortcuts: the shared Popover (ui/controls.tsx `.popover`, used by every
 *  menu, the incident picker and the satellite image list), the search results, the legend's details popup, and
 *  anything marked `data-popover`. */
export const POPOVER_SELECTOR = '.popover, [data-popover], .loc-results, .fxm-legend-pop'

/** A popover is open in `doc`, or the key came from inside a dialog, menu or list box. */
export function popoverOpen(doc: Pick<Document, 'querySelector'> | null = typeof document === 'undefined' ? null : document, target?: EventTarget | null): boolean {
  const el = target as (Element & { closest?: (s: string) => Element | null }) | null | undefined
  if (el?.closest?.('[role="dialog"], [role="menu"], [role="listbox"]')) return true
  return doc?.querySelector(POPOVER_SELECTOR) != null
}

/** The rotation shortcut a key press means (Q left, E right, N north up), else null. Modified keys are not shortcuts
 *  (Shift + Q is still Q: some keyboards need Shift for letters). */
export function rotationKey(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): 'left' | 'right' | 'north' | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  const k = e.key.toLowerCase()
  return k === 'q' ? 'left' : k === 'e' ? 'right' : k === 'n' ? 'north' : null
}

/** Apply a rotation shortcut to the visible view; false when nothing took it. */
export function runRotationKey(key: 'left' | 'right' | 'north'): boolean {
  return key === 'north' ? viewNorthUp() : rotateView(key === 'left' ? -ROTATE_STEP_DEG : ROTATE_STEP_DEG)
}
