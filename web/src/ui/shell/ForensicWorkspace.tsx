// Forensic workspace (owner: shell, CONTRACT §3; BRIEF §2B): today's analytical UI, unchanged in behaviour (SPEC 9.4):
// the full-bleed R3F scene with floating dark-glass panels (header, right column, bottom dock with timeline, charts
// and Key Events), overlays, tooltips and toasts, plus the workspace switch back to the map and the demo badge for
// synthetic fixtures. Loaded lazily, so the
// Public/Command start-up bundle does not carry the Forensic panels; unmounting it disposes the WebGL renderer.
// VITE_SCENE=off renders a placeholder instead of the scene.
import { lazy, Suspense, useLayoutEffect, useRef, type RefObject } from 'react'
import { useStore } from '../../state/store'
import { isDemoBundle } from '../../state/workspace'
import { BottomDock } from '../BottomDock'
import { Header } from '../Header'
import { ErrorBanner, ForecastPill, NoLiveNotice, SceneBoundary, StatusOverlay, Toasts } from '../Overlays'
import { RightPanel } from '../RightPanel'
import { TooltipLayer } from '../Tooltip'
import { parseDockSide, safeInsetsFor, type ChromeRect, type DockSide } from './layout'
import { WorkspaceSwitch } from './WorkspaceSwitch'
import '../../styles/forensic-narrow.css'

const sceneOff = import.meta.env.VITE_SCENE === 'off'
const Scene = lazy(() => import('../../scene/Scene'))

/** Publish the uncovered canvas area as CSS vars (measured from the panels, so it follows responsive sizes; the scene
 *  reads them into sceneStore.viewInsets for camera framing and positions its overlays with them). Each panel docks
 *  to the edge its --chrome-side names (styles/forensic-narrow.css: the right column docks to the bottom on phones). */
function useSafeArea(collapsed: boolean, refs: { header: RefObject<HTMLElement | null>; right: RefObject<HTMLElement | null>; dock: RefObject<HTMLElement | null> }) {
  useLayoutEffect(() => {
    const root = document.documentElement
    const update = () => {
      const gap = parseFloat(getComputedStyle(root).getPropertyValue('--gap')) || 12
      const items: ChromeRect[] = []
      const add = (el: HTMLElement | null | undefined, fallback: DockSide) => {
        if (!el) return
        const r = el.getBoundingClientRect()
        const side = parseDockSide(getComputedStyle(el).getPropertyValue('--chrome-side'))
        items.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, side: side === 'none' ? fallback : side })
      }
      add(refs.header.current, 'top')
      if (!collapsed) {
        add(refs.right.current, 'right')
        add(refs.dock.current, 'bottom')
      }
      const ins = safeInsetsFor(items, window.innerWidth, window.innerHeight, gap)
      root.style.setProperty('--safe-top', `${ins.top}px`)
      root.style.setProperty('--safe-right', `${ins.right}px`)
      root.style.setProperty('--safe-bottom', `${ins.bottom}px`)
      root.style.setProperty('--safe-left', `${ins.left}px`)
    }
    update()
    const ro = new ResizeObserver(update)
    for (const r of [refs.header, refs.right, refs.dock]) if (r.current) ro.observe(r.current)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [collapsed, refs.header, refs.right, refs.dock])
}

export default function ForensicWorkspace() {
  const collapsed = useStore((s) => s.panelsCollapsed)
  const demo = useStore((s) => isDemoBundle(s.incidentId, s.manifest))
  const header = useRef<HTMLDivElement | null>(null)
  const right = useRef<HTMLDivElement | null>(null)
  const dock = useRef<HTMLElement | null>(null)
  useSafeArea(collapsed, { header, right, dock })
  return (
    <div className={`app ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="app-canvas">
        {sceneOff ? (
          <div className="scene-placeholder">
            <span className="mono">3D scene disabled (VITE_SCENE=off)</span>
          </div>
        ) : (
          <SceneBoundary>
            <Suspense
              fallback={
                <div className="scene-placeholder">
                  <span className="mono muted">loading 3D scene…</span>
                </div>
              }
            >
              <Scene />
            </Suspense>
          </SceneBoundary>
        )}
      </div>
      <div className="app-header" ref={header}>
        <Header />
      </div>
      {!collapsed && (
        <>
          <RightPanel panelRef={right} />
          <BottomDock dockRef={dock} />
        </>
      )}
      <div className="fx-ws">
        <nav className="fx-ws-switch glass" aria-label="Switch workspace">
          <span className="fx-ws-label eyebrow" aria-hidden="true">
            Workspace
          </span>
          <WorkspaceSwitch size="sm" />
        </nav>
        {demo && (
          <span className="fx-demo-badge" role="note" data-tip="Development fixture: terrain, fuels, fire and weather are synthetic, not a real incident">
            Demo · simulated data
          </span>
        )}
      </div>
      <StatusOverlay />
      <div className="top-center">
        <ErrorBanner />
        <NoLiveNotice />
        <ForecastPill />
      </div>
      <Toasts />
      <TooltipLayer />
    </div>
  )
}
