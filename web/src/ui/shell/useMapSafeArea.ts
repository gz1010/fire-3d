// Safe area of the Public/Command map (owner: shell, CONTRACT §3): the part of the map not covered by floating UI.
// Every floating region of the map workspace is a [data-chrome] slot; CSS assigns its docking side with the custom
// property --chrome-side (top | right | bottom | left | none), so phones and desktops dock panels differently without
// code changes. The result is published twice, re-measured on resize and whenever a slot changes size (panels opening,
// collapsing, content loading):
//   - CSS vars --safe-top/right/bottom/left on <html> (the names the Forensic shell uses: tooltips, popups, overlays);
//   - useWorkspace.safeInsets (MapLibre padding for framing and fly-to).
// It also sets --mw-bottom-stack (height of the bottom row: timeline, coordinates, legend) and --mw-drawer-space (open
// Analysis drawer + gap) on the workspace root so other panels can stay clear of them.
// Dev builds expose window.__mapChrome() -> { insets, unobstructed, items } for layout checks (BRIEF §6: >= 75 %).
import { useLayoutEffect, type RefObject } from 'react'
import { useWorkspace } from '../../state/workspace'
import { parseDockSide, safeInsetsFor, unobstructedShare, type ChromeRect, type Insets } from './layout'

export interface ChromeItem extends ChromeRect {
  name: string
}

export interface ChromeReport {
  viewport: { width: number; height: number }
  gap: number
  insets: Insets
  /** Share of the viewport not covered by any visible chrome (0..1). */
  unobstructed: number
  items: ChromeItem[]
}

/** Visible [data-chrome] regions inside `root` with their docking side. */
export function measureChrome(root: HTMLElement): ChromeItem[] {
  const out: ChromeItem[] = []
  root.querySelectorAll<HTMLElement>('[data-chrome]').forEach((el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return
    out.push({ name: el.dataset.chrome || 'chrome', left: r.left, top: r.top, right: r.right, bottom: r.bottom, side: parseDockSide(cs.getPropertyValue('--chrome-side')) })
  })
  return out
}

export function chromeReport(root: HTMLElement): ChromeReport {
  const W = window.innerWidth
  const H = window.innerHeight
  const gap = parseFloat(getComputedStyle(root).getPropertyValue('--m-gap')) || 12
  const items = measureChrome(root)
  return { viewport: { width: W, height: H }, gap, insets: safeInsetsFor(items, W, H, gap), unobstructed: unobstructedShare(items, W, H), items }
}

/** Measure and publish the safe area of the map workspace rooted at `root`. `deps` re-collect the observed slots
 *  (pass the panel / preset state that mounts or unmounts slots). */
export function useMapSafeArea(root: RefObject<HTMLElement | null>, deps: readonly unknown[] = []): void {
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const html = document.documentElement
    let raf = 0
    const setVar = (name: string, px: number): boolean => {
      const v = `${px}px`
      if (el.style.getPropertyValue(name) === v) return false
      el.style.setProperty(name, v)
      return true
    }
    const publish = () => {
      raf = 0
      // layout vars first (other slots size themselves from them), then measure the result
      const stack = el.querySelector<HTMLElement>('.mw-bottom')?.getBoundingClientRect()
      setVar('--mw-bottom-stack', stack && stack.height > 0 ? Math.max(0, Math.round(window.innerHeight - stack.top)) : 0)
      const rep = chromeReport(el)
      const drawer = rep.items.find((i) => i.name === 'analysis')
      // the card and the updates panel shrink above an open drawer: measure again once they have
      if (setVar('--mw-drawer-space', drawer ? Math.round(drawer.bottom - drawer.top + rep.gap) : 0)) schedule()
      const { top, right, bottom, left } = rep.insets
      html.style.setProperty('--safe-top', `${top}px`)
      html.style.setProperty('--safe-right', `${right}px`)
      html.style.setProperty('--safe-bottom', `${bottom}px`)
      html.style.setProperty('--safe-left', `${left}px`)
      useWorkspace.getState().setSafeInsets(rep.insets)
    }
    function schedule() {
      if (!raf) raf = requestAnimationFrame(publish)
    }
    publish()
    const ro = new ResizeObserver(schedule)
    el.querySelectorAll<HTMLElement>('[data-chrome], .mw-bottom').forEach((c) => ro.observe(c))
    window.addEventListener('resize', schedule)
    if (import.meta.env.DEV) window.__mapChrome = () => chromeReport(el)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      if (import.meta.env.DEV && window.__mapChrome) delete window.__mapChrome
    }
    // deps re-collect the observed slots; root is a stable ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, ...deps])
}

declare global {
  interface Window {
    /** Dev handle: current chrome layout of the map workspace (scripts/shot.mjs --eval). */
    __mapChrome?: () => ChromeReport
  }
}
