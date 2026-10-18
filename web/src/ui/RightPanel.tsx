// Right column (SPEC 9.4): tabbed panel (Layers / Analysis / Evidence / Notes, or the aircraft list when the
// header's "Aircraft" tab is active), the Incident Overview card and the Weather & Fire Behavior card.
import type { Ref } from 'react'
import { useStore, type RightTab } from '../state/store'
import { AircraftPanel } from './AircraftPanel'
import { AnalysisTab } from './AnalysisTab'
import { EvidenceTab } from './EvidenceTab'
import { IncidentOverview } from './IncidentOverview'
import { LayersTab } from './LayersTab'
import { NotesTab } from './NotesTab'
import { WeatherCard } from './WeatherCard'

const TABS: [RightTab, string][] = [
  ['layers', 'Layers'],
  ['analysis', 'Analysis'],
  ['evidence', 'Evidence'],
  ['notes', 'Notes'],
]

function TabbedPanel() {
  const tab = useStore((s) => s.rightTab)
  const setTab = useStore((s) => s.setRightTab)
  const runs = useStore((s) => s.manifest?.forecasts.length ?? 0)
  const warnings = useStore((s) => s.manifest?.warnings.length ?? 0)
  const forecastBusy = useStore((s) => s.job?.kind === 'forecast' && (s.job.status === 'queued' || s.job.status === 'running'))
  return (
    <>
      <div className="tabs rp-tabs" role="tablist" aria-label="Panel">
        {TABS.map(([k, label]) => (
          <button key={k} id={`rp-tab-${k}`} type="button" className="tab" role="tab" aria-selected={tab === k} aria-controls={`rp-pane-${k}`} onClick={() => setTab(k)}>
            {label}
            {k === 'analysis' && (forecastBusy ? <span className="tab-busy" data-tip="Forecast running" /> : runs > 0 && <span className="tab-count mono">{runs}</span>)}
            {k === 'evidence' && warnings > 0 && <span className="tab-dot" data-tip={`${warnings} bundle warning${warnings > 1 ? 's' : ''}`} />}
          </button>
        ))}
      </div>
      <div className="rp-body" id={`rp-pane-${tab}`} role="tabpanel" aria-labelledby={`rp-tab-${tab}`}>
        {tab === 'layers' && <LayersTab />}
        {tab === 'analysis' && <AnalysisTab />}
        {tab === 'evidence' && <EvidenceTab />}
        {tab === 'notes' && <NotesTab />}
      </div>
    </>
  )
}

export function RightPanel({ panelRef }: { panelRef?: Ref<HTMLDivElement> }) {
  const aircraftView = useStore((s) => s.headerTab === 'aircraft' && s.mode === 'live')
  return (
    <aside className="rcol" ref={panelRef} aria-label="Incident panels">
      <section className="glass rp" aria-label={aircraftView ? 'Aircraft' : 'Incident panel'}>
        {aircraftView ? <AircraftPanel /> : <TabbedPanel />}
      </section>
      <IncidentOverview />
      <WeatherCard />
      <p className="rcol-foot">Research prototype — not for operational use</p>
    </aside>
  )
}
