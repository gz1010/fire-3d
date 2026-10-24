// Forensic workspace (owner: shell, CONTRACT §3; BRIEF §2B): today's analytical UI, unchanged in behaviour (SPEC 9.4):
// the full-bleed R3F scene with floating dark-glass panels (header, right column, bottom dock with timeline, charts
// and Key Events), overlays, tooltips and toasts, plus the view switch back to the map and the demo badge for
// synthetic fixtures. Loaded lazily, so the Public/Command start-up bundle does not carry the Forensic panels;
// unmounting it disposes the WebGL renderer. VITE_SCENE=off renders a placeholder instead of the scene.
// Brief 2 (O-R1, O-R7, decision 10): with no fire focused (the California overview) it says "Zoom in on a fire or pick
// one" and offers the fire list instead of an empty scene. A map-first entry: desktop opens with a timeline-only dock
// (charts and Key Events one click away) and a labelled "Frame fire"; phones open with the panel sheet collapsed.
// Brief 4 (H5, ForensicView.dc.html): the header is the floating top bar with the view pill in its centre (the floating
// "View" switch is gone); "Frame fire" and "Charts & key events" sit directly under the scene's compass (left 20), the
// demo badge under them; the disclaimer is a glass pill above the timeline (prototype line + "Not an all-clear"); a
// 120 px top gradient keeps the bar readable over the terrain (no vignette and no tint in Forensic).
import { BarChart3, Crosshair, Map as MapIcon, PanelBottomClose, PanelBottomOpen } from 'lucide-react'
import { lazy, Suspense, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { IncidentSummary } from '../../api/types'
import { useSceneStore } from '../../scene/sceneStore'
import { useStore } from '../../state/store'
import { isDemoBundle, useWorkspace } from '../../state/workspace'
import { BottomDock } from '../BottomDock'
import { Header } from '../Header'
import { ErrorBanner, ForecastPill, NoLiveNotice, SceneBoundary, StatusOverlay, Toasts } from '../Overlays'
import { RightPanel } from '../RightPanel'
import { TooltipLayer } from '../Tooltip'
import { FireCard } from './FireCard'
import { FixedCopy } from './FixedCopy'
import { NARROW_QUERY, useMediaQuery } from './hooks'
import { switchWorkspace } from './handoff'
import { parseDockSide, safeInsetsFor, type ChromeRect, type DockSide } from './layout'
import { OverviewList } from './OverviewPanel'
import { BackButton, TopBar, TopBarBrand, ViewPill } from './TopBar'
import '../../styles/forensic-narrow.css'
import '../../styles/forensic-entry.css'

const sceneOff = import.meta.env.VITE_SCENE === 'off'
const Scene = lazy(() => import('../../scene/Scene'))

/** Publish the uncovered canvas area as CSS vars (measured from the panels, so it follows responsive sizes; the scene
 *  reads them into sceneStore.viewInsets for camera framing and positions its overlays with them). Each panel docks
 *  to the edge its --chrome-side names (styles/forensic-narrow.css: the right column docks to the bottom on phones).
 *  `layoutKey` re-measures when a panel moves without resizing (the dock follows the phone sheet). */
function useSafeArea(collapsed: boolean, refs: { header: RefObject<HTMLElement | null>; right: RefObject<HTMLElement | null>; dock: RefObject<HTMLElement | null> }, layoutKey: string) {
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
  }, [collapsed, refs.header, refs.right, refs.dock, layoutKey])
}

/** No fire focused: Forensic shows one fire at a time, so it offers the map (zoom in on a fire) and the list (and the
 *  fire card) first. */
function OpenFireFirst() {
  const pick = (f: IncidentSummary) => useWorkspace.getState().setFireCard(f.id)
  const hasCard = useWorkspace((s) => s.fireCardId != null)
  return (
    <div className="mw fx-empty">
      <TopBar
        inset="forensic"
        className="fx-empty-head"
        left={
          <>
            <BackButton onClick={() => switchWorkspace('map')} label="Back to the map" tip="Back to the map of all fires" />
            <TopBarBrand size={22} />
            <span className="tb-sep" aria-hidden="true" />
            <span className="fx-empty-where">Forensic · 3D analysis</span>
          </>
        }
        centre={<ViewPill />}
      />
      <main className={`fx-empty-main${hasCard ? ' has-card' : ''}`}>
        <section className="mw-panel fx-empty-list" aria-labelledby="fx-empty-title">
          <header className="mw-panel-head">
            <h2 id="fx-empty-title">Zoom in on a fire or pick one</h2>
          </header>
          <p className="fx-empty-text">
            The 3D analysis shows one fire at a time. Zoom in on a fire on the map, or pick one here to see its agency record, then open it in 3D.
          </p>
          <div className="fx-empty-actions">
            <button type="button" className="mw-btn" onClick={() => switchWorkspace('map')}>
              <MapIcon size={14} /> Back to the map
            </button>
          </div>
          <OverviewList onPick={pick} />
        </section>
        {hasCard && (
          <div className="fx-empty-card">
            <FireCard />
          </div>
        )}
      </main>
      <TooltipLayer />
    </div>
  )
}

/** The labelled entry controls under the compass: frame the fire, show the charts (desktop) or the panels (phones). */
function EntryControls({ narrow, dockFull, onDock, sheetOpen, onSheet }: { narrow: boolean; dockFull: boolean; onDock: () => void; sheetOpen: boolean; onSheet: () => void }) {
  return (
    <div className="fx-entry glass" role="group" aria-label="3D view">
      <button type="button" className="fx-entry-btn" onClick={() => useSceneStore.getState().issueCameraCommand('frame-fire')} data-tip="Fit the whole fire in view">
        <Crosshair size={15} aria-hidden="true" /> Frame fire
      </button>
      {narrow ? (
        <button type="button" className="fx-entry-btn" aria-expanded={sheetOpen} onClick={onSheet}>
          {sheetOpen ? <PanelBottomClose size={15} aria-hidden="true" /> : <PanelBottomOpen size={15} aria-hidden="true" />} {sheetOpen ? 'Hide panels' : 'Layers & analysis'}
        </button>
      ) : (
        <button type="button" className="fx-entry-btn" aria-expanded={dockFull} onClick={onDock} data-tip="Fire area, spread speed and terrain charts, and the key events">
          <BarChart3 size={15} aria-hidden="true" /> {dockFull ? 'Hide charts' : 'Charts & key events'}
        </button>
      )}
    </div>
  )
}

export default function ForensicWorkspace() {
  const noFire = useStore((s) => s.incidentId == null)
  if (noFire) return <OpenFireFirst />
  return <ForensicScene />
}

function ForensicScene() {
  const collapsed = useStore((s) => s.panelsCollapsed)
  const demo = useStore((s) => isDemoBundle(s.incidentId, s.manifest))
  const narrow = useMediaQuery(NARROW_QUERY)
  // map-first entry: every visit starts with the scene leading (timeline-only dock / collapsed phone sheet)
  const [dockFull, setDockFull] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const header = useRef<HTMLDivElement | null>(null)
  const right = useRef<HTMLDivElement | null>(null)
  const dock = useRef<HTMLElement | null>(null)
  useSafeArea(collapsed, { header, right, dock }, `${narrow}|${dockFull}|${sheetOpen}`)
  const cls = ['app', collapsed && 'is-collapsed', !dockFull && 'fx-dock-min', narrow && !sheetOpen && 'fx-sheet-closed']
  return (
    <div className={cls.filter(Boolean).join(' ')}>
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
        {/* the screen's 120 px top gradient behind the floating bar (above the terrain, under the scene's controls) */}
        <div className="fx-topfade" aria-hidden="true" />
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
        {!collapsed && (
          <EntryControls narrow={narrow} dockFull={dockFull} onDock={() => setDockFull((v) => !v)} sheetOpen={sheetOpen} onSheet={() => setSheetOpen((v) => !v)} />
        )}
        {demo && (
          <span className="fx-demo-badge" role="note" data-tip="Development fixture: terrain, fuels, fire and weather are synthetic, not a real incident">
            Demo · simulated data
          </span>
        )}
      </div>
      <div className="fx-note">
        <FixedCopy variant="pill" />
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
