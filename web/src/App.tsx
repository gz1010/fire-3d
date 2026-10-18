// App shell: two workspaces over one shared state (docs/redesign/CONTRACT.md §2-3, §13; BRIEF §2, §6; BRIEF-2).
//   Public/Command the map-first workspace (default): one MapLibre map with floating chrome. Each region below is a
//                  slot for its owner's component (map, location, official-web) or the shell's own panels.
//   Forensic       today's analytical UI (SPEC 9.4), loaded lazily from ui/shell/ForensicWorkspace.tsx.
// Only the active workspace is mounted, so the inactive one never renders (its WebGL context is released).
// Start-up (brief 2, decision 1): no ?incident= opens the California overview (no incident, no default pick, no build);
// ?incident=<id> opens that fire directly, loading in parallel with CAL FIRE's lists; an unknown id falls back to the
// overview with a notice. ?t=<epoch ms> sets the time once the bundle is ready. Opening and leaving fires are history
// entries (state/history.ts), so Back returns to the overview. Workspace URL state (?ws=&preset=&persp=&basemap=&units=)
// lives in state/workspace.ts.
// Each workspace publishes the map / canvas area its chrome leaves free as CSS vars --safe-top/right/bottom/left
// (Forensic from its panels; Public/Command from every [data-chrome] slot via ui/shell/useMapSafeArea.ts, which also
// feeds useWorkspace.safeInsets for MapLibre padding).
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { applyTimeWhenReady, useHistorySync } from './state/history'
import { readUrlParams, useHotkeys, useLivePolling, usePlayback, useUrlSync } from './state/runtime'
import { useStore } from './state/store'
import { useWorkspace, useWorkspaceUrlSync, type PanelKey } from './state/workspace'
import { Spinner } from './ui/controls'
import { ErrorBanner, ForecastPill, StatusOverlay, Toasts } from './ui/Overlays'
import { TooltipLayer } from './ui/Tooltip'
// Public/Command slots (owners in CONTRACT §1)
import { ExtrasSync } from './extras/ExtrasSync'
import { ImageryChip } from './extras/ImageryChip'
import { useExtrasFeedItems } from './extras/runtime'
import { CoordinateStrip } from './location/CoordinateStrip'
import { LocationCard } from './location/LocationCard'
import { SearchBox } from './location/SearchBox'
import { MapAttribution, ScaleBar } from './map/MapAttribution'
import { MapControls } from './map/MapControls'
import { MapLegend } from './map/MapLegend'
import { UpdatesFeed } from './ui/feed/UpdatesFeed'
import { AnalysisDrawer } from './ui/shell/AnalysisDrawer'
import { CoordsSlot } from './ui/shell/CoordsSlot'
import { FireCard } from './ui/shell/FireCard'
import { buildFailed, needsBuild, openFire } from './ui/shell/fireActions'
import { NARROW_QUERY, useMediaQuery, WIDE_QUERY } from './ui/shell/hooks'
import { LayersPanel } from './ui/shell/LayersPanel'
import { MapBoundary } from './ui/shell/MapBoundary'
import { MapHeader } from './ui/shell/MapHeader'
import { MissingFireNotice, OverviewPanel } from './ui/shell/OverviewPanel'
import { UpdatesPanel } from './ui/shell/UpdatesPanel'
import { useMapSafeArea } from './ui/shell/useMapSafeArea'
import { usePinAboveSheet } from './ui/shell/usePinAboveSheet'
import { CompactTimeline } from './ui/timeline/CompactTimeline'
import './styles/map-tokens.css'
import './styles/map-fallbacks.css'
import './styles/map-layout.css'
import './styles/map-bridge.css'
import './styles/overview.css'
import './extras/extras.css'

const MapView = lazy(() => import('./map/MapView'))
const ForensicWorkspace = lazy(() => import('./ui/shell/ForensicWorkspace'))

/** Started once per page (StrictMode runs effects twice in development). */
let bootstrapped = false

/** CAL FIRE's lists and the linked fire, in parallel. No link = the California overview: nothing is picked and
 *  nothing is built. Runs before the URL sync effects (declared first), so they start from the linked incident. */
function useBootstrap(): void {
  useEffect(() => {
    if (bootstrapped) return
    bootstrapped = true
    const q = readUrlParams()
    const st = useStore.getState()
    void st.loadCatalog()
    const id = q.incident
    const t = q.t
    // never a build from a link: an unprepared fire shows its "Prepare analysis" notice
    if (id) void st.selectIncident(id, { source: 'link' }).then(() => t != null && applyTimeWhenReady(id, t))
  }, [])
}

function useDocumentTitle() {
  const name = useStore((s) => s.summary?.name ?? null)
  const live = useStore((s) => s.summary?.mode === 'live')
  useEffect(() => {
    document.title = name ? `${name}${live ? ' · live' : ''} · Fire-3d` : 'Fire-3d · Wildfire Forensics & Forecast'
  }, [name, live])
}

/** <html data-workspace data-preset data-perspective>: scopes the map tokens (styles/map-tokens.css). */
function useWorkspaceAttributes() {
  const workspace = useWorkspace((s) => s.workspace)
  const preset = useWorkspace((s) => s.preset)
  const perspective = useWorkspace((s) => s.perspective)
  useLayoutEffect(() => {
    const d = document.documentElement.dataset
    d.workspace = workspace
    d.preset = preset
    d.perspective = perspective
  }, [workspace, preset, perspective])
}

export default function App() {
  const workspace = useWorkspace((s) => s.workspace)
  useBootstrap()
  useHistorySync()
  usePlayback()
  useLivePolling({ aircraft: workspace === 'forensic' })
  useUrlSync(true)
  useWorkspaceUrlSync(true)
  useHotkeys()
  useDocumentTitle()
  useWorkspaceAttributes()
  if (workspace === 'forensic')
    return (
      <Suspense
        fallback={
          <div className="app">
            <div className="scene-placeholder">
              <span className="mono muted">
                <Spinner size={12} /> loading Forensic workspace…
              </span>
            </div>
          </div>
        }
      >
        <ForensicWorkspace />
      </Suspense>
    )
  return <MapWorkspace />
}

const SHEETS: PanelKey[] = ['updates', 'layers', 'analysis']

/** Phones: the updates panel starts closed (it would cover most of the map) and only one bottom sheet is open at a
 *  time. Back on a wide screen, an updates panel closed here for space is reopened. */
function useNarrowSheets(narrow: boolean) {
  const autoClosed = useRef(false)
  useLayoutEffect(() => {
    const ws = useWorkspace.getState()
    if (!narrow) {
      if (autoClosed.current && !ws.panels.updates) ws.setPanel('updates', true)
      autoClosed.current = false
      return
    }
    if (ws.panels.updates) {
      ws.setPanel('updates', false)
      autoClosed.current = true
    }
    for (const k of SHEETS.filter((x) => useWorkspace.getState().panels[x]).slice(1)) ws.setPanel(k, false)
    return useWorkspace.subscribe((s, p) => {
      const opened = SHEETS.find((k) => s.panels[k] && !p.panels[k])
      if (!opened) return
      if (opened === 'updates') autoClosed.current = false
      for (const k of SHEETS) if (k !== opened && s.panels[k]) s.setPanel(k, false)
    })
  }, [narrow])
}

/** Escape closes the most recently opened drawer (Layers, Analysis; on phones also the updates sheet). It leaves
 *  Escape to an open popover (incident picker, menus), to text fields and to an active path drawing. */
function useEscapeClosesDrawers(narrow: boolean) {
  useEffect(() => {
    const order: PanelKey[] = []
    const unsub = useWorkspace.subscribe((s, p) => {
      for (const k of SHEETS) {
        const i = order.indexOf(k)
        if (i >= 0 && s.panels[k] !== p.panels[k]) order.splice(i, 1)
        if (s.panels[k] && !p.panels[k]) order.push(k)
      }
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      // an open popover handles its own Escape; so does a profile path being drawn (useHotkeys stops it first)
      if (document.querySelector('.popover') || useStore.getState().drawingPath) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const ws = useWorkspace.getState()
      const closable = (k: PanelKey) => ws.panels[k] && (k !== 'updates' || narrow)
      const key = [...order].reverse().find(closable) ?? (['layers', 'analysis', 'updates'] as PanelKey[]).find(closable)
      if (!key) return
      ws.setPanel(key, false)
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      unsub()
      window.removeEventListener('keydown', onKey)
    }
  }, [narrow])
}

/** Escape closes an open fire card first (capture phase, ahead of the drawers' handler). It leaves Escape to an open
 *  popover and to text fields. */
function useEscapeClosesFireCard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (useWorkspace.getState().fireCardId == null || document.querySelector('.popover')) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      useWorkspace.getState().setFireCard(null)
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

/** Keyboard shortcuts past the header and the long updates list (visible on focus). */
function SkipLinks({ overview }: { overview: boolean }) {
  const go = (id: string) => (e: ReactMouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    const slot = document.getElementById(id)
    const target = slot?.querySelector<HTMLElement>('input, button, [tabindex]:not([tabindex="-1"]), a[href], select') ?? slot
    target?.focus()
  }
  return (
    <nav className="mw-skip" aria-label="Skip links">
      <a href="#mw-search" onClick={go('mw-search')}>
        Skip to search
      </a>
      {overview ? (
        <a href="#mw-updates" onClick={go('mw-updates')}>
          Skip to the fire list
        </a>
      ) : (
        <a href="#mw-timeline" onClick={go('mw-timeline')}>
          Skip to timeline
        </a>
      )}
      <a href="#mw-map" onClick={go('mw-map')}>
        Skip to map
      </a>
    </nav>
  )
}

/** The map credits. Phones (brief 2 C-R2): folded with the research note into one line, behind a labelled "© Credits"
 *  toggle that opens the full credits above the bottom row (like MapLibre's compact attribution on narrow maps). */
function CreditsFooter({ narrow }: { narrow: boolean }) {
  const [open, setOpen] = useState(false)
  const folded = narrow && !open
  return (
    <footer className={`mw-footer${narrow ? ' is-narrow' : ''}${open ? ' is-open' : ''}`}>
      {narrow && (
        <button type="button" className="mw-credits-toggle" aria-expanded={open} aria-controls="mw-credits" data-chrome="credits-toggle" onClick={() => setOpen((o) => !o)}>
          © Credits
        </button>
      )}
      <div className="mw-footer-attrib" id="mw-credits" data-chrome="credits" hidden={folded}>
        <MapAttribution />
      </div>
    </footer>
  )
}

/** An open fire without Fire-3d's analysis: a short notice (top centre) instead of a card over the map. */
function useNotPrepared(): { name: string; failed: boolean } | null {
  const s = useStore(
    useShallow((st) => ({
      id: st.incidentId,
      name: st.summary?.name ?? null,
      hasSummary: st.summary != null,
      manifest: st.manifest,
      summary: st.summary,
      job: st.job,
      loading: st.incidentLoading,
      error: st.incidentError,
    })),
  )
  if (!s.id || !s.hasSummary || s.loading || s.error) return null
  if (!needsBuild(s)) return null
  return { name: s.name ?? 'this fire', failed: buildFailed(s) }
}

function NotPreparedNotice({ name, failed }: { name: string; failed: boolean }) {
  const id = useStore((s) => s.incidentId)
  if (!id) return null
  return (
    <div className="banner banner-info mw-notprepared" role="status">
      <span className="banner-text">
        {failed ? `The last preparation of the ${name} analysis failed.` : `Fire-3d has not prepared an analysis of the ${name} yet.`} The map shows CAL FIRE's reported
        location and official information.
      </span>
      <button type="button" className="btn btn-sm btn-gold" onClick={() => void openFire(id, 'prepare')}>
        {failed ? 'Prepare again (1-3 min)' : 'Prepare analysis (1-3 min)'}
      </button>
    </div>
  )
}

/** Public/Command: the map-first layout (styles/map-layout.css documents the regions). No incident = the California
 *  overview: the fire list takes the right column, the timeline is hidden and the header reads "California · all
 *  fires". */
function MapWorkspace() {
  const root = useRef<HTMLDivElement | null>(null)
  const panels = useWorkspace((s) => s.panels)
  const preset = useWorkspace((s) => s.preset)
  const hasSelection = useWorkspace((s) => s.selection != null)
  const hasFireCard = useWorkspace((s) => s.fireCardId != null)
  const overview = useStore((s) => s.incidentId == null)
  const collapsed = useStore((s) => s.panelsCollapsed)
  const narrow = useMediaQuery(NARROW_QUERY)
  const wide = useMediaQuery(WIDE_QUERY)
  const extraItems = useExtrasFeedItems()
  const notPrepared = useNotPrepared()
  useNarrowSheets(narrow)
  useEscapeClosesDrawers(narrow)
  useEscapeClosesFireCard()
  usePinAboveSheet(narrow)
  useMapSafeArea(root, [panels.updates, panels.analysis, panels.layers, preset, hasSelection, hasFireCard, overview, collapsed, narrow])
  const sheetOpen = narrow && SHEETS.some((k) => panels[k])
  const cls = [
    'mw',
    overview && 'is-overview',
    collapsed && 'is-collapsed',
    panels.updates && 'has-updates',
    panels.analysis && !overview && 'has-drawer',
    panels.layers && 'has-layers',
    hasSelection && 'has-selection',
    hasFireCard && 'has-firecard',
    sheetOpen && 'has-sheet',
  ]
  return (
    <div className={cls.filter(Boolean).join(' ')} ref={root}>
      <SkipLinks overview={overview} />
      <ExtrasSync />
      <header className="mw-header" data-chrome="header">
        <MapHeader />
      </header>
      <div className="mw-layers-slot" data-chrome="layers">
        <LayersPanel />
      </div>
      {!overview && (
        <div className="mw-drawer-slot" data-chrome="analysis">
          <AnalysisDrawer />
        </div>
      )}
      <div className="mw-top">
        <div className="mw-search" id="mw-search" data-chrome="search">
          <SearchBox />
        </div>
        <div className="mw-firecard" data-chrome="firecard">
          <FireCard />
        </div>
        <div className="mw-card" data-chrome="card">
          <LocationCard />
        </div>
        {/* the satellite chip: in the header bar on wide screens (MapHeader), else here next to the map controls */}
        <div className="mw-imagery" data-chrome="imagery">
          {!wide && <ImageryChip />}
        </div>
        <div className="mw-controls" data-chrome="controls">
          <MapControls />
        </div>
        <aside className="mw-updates" id="mw-updates" data-chrome="updates" aria-label={overview ? 'California fires' : 'Incident updates'}>
          {overview ? (
            <OverviewPanel />
          ) : (
            <UpdatesPanel>
              <UpdatesFeed extraItems={extraItems} />
            </UpdatesPanel>
          )}
        </aside>
      </div>
      <div className="mw-scale-slot" data-chrome="scale">
        <ScaleBar />
      </div>
      <div className="mw-bottom">
        <CoordsSlot>
          <CoordinateStrip />
        </CoordsSlot>
        {!overview && (
          <div className="mw-timeline" id="mw-timeline" data-chrome="timeline">
            <CompactTimeline />
          </div>
        )}
        <div className="mw-legend-slot" data-chrome="legend">
          <MapLegend />
        </div>
        <p className="mw-note" data-chrome="note">
          Research prototype — not for operational use
        </p>
        <CreditsFooter narrow={narrow} />
      </div>
      {/* the map is drawn underneath (z-index) but comes after the chrome in the tab order */}
      <main className="mw-map" id="mw-map" aria-label="Wildfire map">
        <MapBoundary>
          <Suspense
            fallback={
              <div className="mw-map-loading">
                <Spinner size={14} /> Loading map…
              </div>
            }
          >
            <MapView />
          </Suspense>
        </MapBoundary>
      </main>
      {/* the overview panel shows the lists' loading / error / empty states; an unprepared fire gets a short notice */}
      {!overview && !notPrepared && <StatusOverlay />}
      <div className="top-center">
        <MissingFireNotice />
        <ErrorBanner />
        {notPrepared && <NotPreparedNotice name={notPrepared.name} failed={notPrepared.failed} />}
        <ForecastPill />
      </div>
      <Toasts />
      <TooltipLayer />
    </div>
  )
}
