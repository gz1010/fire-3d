// Analysis drawer (owner: shell, CONTRACT §3; BRIEF §6): the existing burned-area, rate-of-spread and elevation-profile
// charts, closed by default and opened from the header. It is a detail view, so the charts keep their scientific
// units (as in Forensic, where they stay visible in the dock). Charts load on first open (AnalysisCharts.tsx).
// Drawing a new profile path needs the Forensic 3D terrain; the drawer says so instead of waiting for clicks the map
// does not deliver. The incident's data sources and their credits sit under the charts.
import { Box, PenLine, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef } from 'react'
import { useStore } from '../../state/store'
import { useWorkspace } from '../../state/workspace'
import { Spinner } from '../controls'
import { DataSourcesNote } from '../DataCredits'
import { switchWorkspace } from './handoff'
import { useDrawerFocus } from './hooks'

const AnalysisCharts = lazy(() => import('./AnalysisCharts'))

function DrawPathNotice() {
  return (
    <div className="mw-drawer-notice" role="status">
      <PenLine size={14} aria-hidden="true" />
      <span>Drawing a profile path works on the 3D terrain in the Forensic workspace.</span>
      <button type="button" className="mw-btn is-sm is-primary" onClick={() => switchWorkspace('forensic')}>
        Draw in Forensic
      </button>
      <button type="button" className="mw-btn is-sm" onClick={() => useStore.getState().setDrawingPath(false)}>
        Cancel
      </button>
    </div>
  )
}

export function AnalysisDrawer() {
  const open = useWorkspace((s) => s.panels.analysis)
  const setPanel = useWorkspace((s) => s.setPanel)
  const drawing = useStore((s) => s.drawingPath)
  const heading = useRef<HTMLHeadingElement | null>(null)
  useDrawerFocus(open, heading, 'analysis')
  // a path drawing started here cannot finish on the map: stop it when the drawer closes
  useEffect(() => {
    if (!open && useStore.getState().drawingPath && useWorkspace.getState().workspace === 'map') useStore.getState().setDrawingPath(false)
  }, [open])
  if (!open) return null
  return (
    <section className="mw-drawer" aria-labelledby="mw-analysis-title" data-drawer="analysis">
      <span className="mw-sheet-handle" aria-hidden="true" />
      <header className="mw-panel-head">
        <h2 id="mw-analysis-title" ref={heading} tabIndex={-1}>
          Analysis
        </h2>
        <p className="mw-drawer-sub">
          Detail charts in scientific units: area in acres, spread speed as rate of spread in chains per hour (1 ch/h ≈ 66 ft per hour), elevation in
          metres.
        </p>
        <button type="button" className="mw-btn is-sm mw-hide-narrow" onClick={() => switchWorkspace('forensic')} data-tip="Charts, replay, model re-runs on past weather and forecast controls with the 3D scene">
          <Box size={13} /> Open Forensic
        </button>
        <button type="button" className="mw-icon-btn" aria-label="Close analysis" data-tip="Close (Esc)" onClick={() => setPanel('analysis', false)}>
          <X size={15} />
        </button>
      </header>
      {drawing && <DrawPathNotice />}
      <Suspense
        fallback={
          <div className="mw-drawer-loading">
            <Spinner size={14} /> Loading charts…
          </div>
        }
      >
        <AnalysisCharts />
      </Suspense>
      <DataSourcesNote className="mw-drawer-credits" inline />
    </section>
  )
}
