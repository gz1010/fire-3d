// App shell: two workspaces over one shared state (docs/redesign/CONTRACT.md §2-3; BRIEF §2, §6).
//   Public/Command the map-first workspace (default): one MapLibre map with floating chrome. Each region below is a
//                  slot for its owner's component (map-core, location, timeline-feed) or the shell's own panels.
//   Forensic       today's analytical UI, unchanged (SPEC 9.4), loaded lazily from ui/shell/ForensicWorkspace.tsx.
// Only the active workspace is mounted, so the inactive one never renders (its WebGL context is released).
// Initial selection: ?incident=<id>, else the largest live incident with a ready bundle (unless ?mode=historical),
// else the 2025 Eaton Fire, else the first catalog incident. ?t=<epoch ms> sets the time once the bundle is ready.
// Workspace URL state (?ws=&preset=&persp=&basemap=&units=) lives in state/workspace.ts.
// Each workspace publishes the map / canvas area its chrome leaves free as CSS vars --safe-top/right/bottom/left
// (Forensic from its panels; Public/Command from every [data-chrome] slot via ui/shell/useMapSafeArea.ts, which also
// feeds useWorkspace.safeInsets for MapLibre padding).
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { pickDefault, readUrlParams, useHotkeys, useLivePolling, usePlayback, useUrlSync } from './state/runtime'
import { useStore } from './state/store'
import { useWorkspace, useWorkspaceUrlSync, type PanelKey } from './state/workspace'
import { Spinner } from './ui/controls'
import { ErrorBanner, ForecastPill, NoLiveNotice, StatusOverlay, Toasts } from './ui/Overlays'
import { TooltipLayer } from './ui/Tooltip'
// Public/Command slots (owners in CONTRACT §1)
import { ExtrasSync } from './extras/ExtrasSync'
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
import { NARROW_QUERY, useMediaQuery } from './ui/shell/hooks'
import { LayersPanel } from './ui/shell/LayersPanel'
import { MapBoundary } from './ui/shell/MapBoundary'
import { MapHeader } from './ui/shell/MapHeader'
import { UpdatesPanel } from './ui/shell/UpdatesPanel'
import { useMapSafeArea } from './ui/shell/useMapSafeArea'
import { CompactTimeline } from './ui/timeline/CompactTimeline'
import './styles/map-tokens.css'
import './styles/map-fallbacks.css'
import './styles/map-layout.css'
import './styles/map-bridge.css'
import './extras/extras.css'

const MapView = lazy(() => import('./map/MapView'))
const ForensicWorkspace = lazy(() => import('./ui/shell/ForensicWorkspace'))

/** Catalog + initial selection; returns true once the URL may be kept in sync. */
function useBootstrap(): boolean {
  const [done, setDone] = useState(false)
  useEffect(() => {
    let cancelled = false
    let unsub: (() => void) | null = null
    const run = async () => {
      const q = readUrlParams()
      const st = useStore.getState()
      await st.loadCatalog()
      if (cancelled) return
      const { catalog } = useStore.getState()
      const id = q.incident ?? pickDefault(catalog.live, catalog.historical, q.mode)
      if (!id) {
        setDone(true)
        return
      }
      await useStore.getState().selectIncident(id, { autoBuild: true })
      if (cancelled) return
      const t = q.t
      if (t != null) {
        // apply ?t= once this incident's bundle is ready (it may still be building)
        const apply = () => {
          const s = useStore.getState()
          if (s.incidentId !== id) return true
          if (s.manifest?.status !== 'ready' || s.manifest.id !== id) return false
          s.setTimeMs(t)
          return true
        }
        if (!apply())
          unsub = useStore.subscribe(() => {
            if (apply() && unsub) {
              unsub()
              unsub = null
            }
          })
      }
      setDone(true)
    }
    void run()
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])
  return done
}

/** After bootstrap: if nothing is selected once a catalog arrives (e.g. after a failed first load + Retry), select
 *  the default incident. */
function useAutoSelect(booted: boolean) {
  const need = useStore((s) => booted && s.incidentId == null && !s.catalog.loading && s.catalog.live.length + s.catalog.historical.length > 0)
  useEffect(() => {
    if (!need) return
    const { catalog } = useStore.getState()
    const id = pickDefault(catalog.live, catalog.historical, readUrlParams().mode)
    if (id) void useStore.getState().selectIncident(id, { autoBuild: true })
  }, [need])
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
  const booted = useBootstrap()
  useAutoSelect(booted)
  usePlayback()
  useLivePolling()
  useUrlSync(booted)
  useWorkspaceUrlSync(booted)
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

/** Keyboard shortcuts past the header and the long updates list (visible on focus). */
function SkipLinks() {
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
      <a href="#mw-timeline" onClick={go('mw-timeline')}>
        Skip to timeline
      </a>
      <a href="#mw-map" onClick={go('mw-map')}>
        Skip to map
      </a>
    </nav>
  )
}

/** Public/Command: the map-first layout (styles/map-layout.css documents the regions). */
function MapWorkspace() {
  const root = useRef<HTMLDivElement | null>(null)
  const panels = useWorkspace((s) => s.panels)
  const preset = useWorkspace((s) => s.preset)
  const hasSelection = useWorkspace((s) => s.selection != null)
  const collapsed = useStore((s) => s.panelsCollapsed)
  const narrow = useMediaQuery(NARROW_QUERY)
  const extraItems = useExtrasFeedItems()
  useNarrowSheets(narrow)
  useEscapeClosesDrawers(narrow)
  useMapSafeArea(root, [panels.updates, panels.analysis, panels.layers, preset, hasSelection, collapsed, narrow])
  const sheetOpen = narrow && SHEETS.some((k) => panels[k])
  const cls = ['mw', collapsed && 'is-collapsed', panels.updates && 'has-updates', panels.analysis && 'has-drawer', panels.layers && 'has-layers', hasSelection && 'has-selection', sheetOpen && 'has-sheet']
  return (
    <div className={cls.filter(Boolean).join(' ')} ref={root}>
      <SkipLinks />
      <ExtrasSync />
      <header className="mw-header" data-chrome="header">
        <MapHeader />
      </header>
      <div className="mw-layers-slot" data-chrome="layers">
        <LayersPanel />
      </div>
      <div className="mw-drawer-slot" data-chrome="analysis">
        <AnalysisDrawer />
      </div>
      <div className="mw-top">
        <div className="mw-search" id="mw-search" data-chrome="search">
          <SearchBox />
        </div>
        <div className="mw-card" data-chrome="card">
          <LocationCard />
        </div>
        <div className="mw-controls" data-chrome="controls">
          <MapControls />
        </div>
        <aside className="mw-updates" data-chrome="updates" aria-label="Incident updates">
          <UpdatesPanel>
            <UpdatesFeed extraItems={extraItems} />
          </UpdatesPanel>
        </aside>
      </div>
      <div className="mw-scale-slot" data-chrome="scale">
        <ScaleBar />
      </div>
      <div className="mw-bottom">
        <CoordsSlot>
          <CoordinateStrip />
        </CoordsSlot>
        <div className="mw-timeline" id="mw-timeline" data-chrome="timeline">
          <CompactTimeline />
        </div>
        <div className="mw-legend-slot" data-chrome="legend">
          <MapLegend />
        </div>
        <p className="mw-note" data-chrome="note">
          Research prototype — not for operational use
        </p>
        <footer className="mw-footer">
          <div className="mw-footer-attrib" data-chrome="credits">
            <MapAttribution />
          </div>
        </footer>
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
