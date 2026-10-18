// Honest map states (owner: map-core; BRIEF §3, §4, §11): which public provider is failing and what still works, the
// modeled-area boundary when the view has left it, and overlay data that could not be loaded. Notices sit at the top
// of the visible map area (inside the shell's --safe-* insets); provider notices can be dismissed for the session.
import { X } from 'lucide-react'
import { useState } from 'react'
import { useStore } from '../state/store'
import { useWorkspace } from '../state/workspace'
import { useMapRuntime } from './mapStore'

interface Notice {
  id: string
  tone: 'warn' | 'info'
  text: string
  action?: { label: string; run: () => void }
  dismissible: boolean
}

export function MapNotices() {
  const providers = useMapRuntime((s) => s.providers)
  const aoiInView = useMapRuntime((s) => s.aoiInView)
  const observed = useMapRuntime((s) => s.overlays.observed)
  const forecast = useMapRuntime((s) => s.overlays.forecast)
  const basemap = useWorkspace((s) => s.basemap)
  const perspective = useWorkspace((s) => s.perspective)
  const returnToIncident = useWorkspace((s) => s.returnToIncident)
  const name = useStore((s) => s.summary?.name ?? null)
  const bundle = useStore((s) => s.manifest?.status ?? s.summary?.bundle_status ?? null)
  const hasIncident = useStore((s) => s.incidentId != null)
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({})

  const list: Notice[] = []
  if (providers.basemap.state === 'failed')
    list.push({ id: 'basemap', tone: 'warn', dismissible: true, text: 'Street map unavailable: OpenFreeMap did not respond, so roads and place names are missing. Wildfire layers still work.' })
  else if (providers.vector.state === 'failed')
    list.push({ id: 'vector', tone: 'warn', dismissible: true, text: 'Roads and place names unavailable: OpenFreeMap map tiles are not loading.' })
  if (basemap === 'aerial' && providers.imagery.state === 'failed')
    list.push({ id: 'imagery', tone: 'warn', dismissible: true, text: 'Aerial imagery unavailable: USGS The National Map is not responding. Roads, places and wildfire layers still show.' })
  if (providers.terrain.state === 'failed')
    list.push({
      id: 'terrain',
      tone: 'warn',
      dismissible: true,
      text: perspective === '3d' ? '3D terrain unavailable (Mapterhorn is not responding): showing a flat map.' : 'Terrain shading unavailable (Mapterhorn is not responding).',
    })
  if (hasIncident && bundle !== 'ready' && bundle != null)
    list.push({
      id: 'bundle',
      tone: 'info',
      dismissible: false,
      text: bundle === 'building' ? 'Model data for this incident is being prepared; the map shows its reported location for now.' : 'No model data for this incident; the map shows its reported location only.',
    })
  if (observed.status === 'error') list.push({ id: 'obs-error', tone: 'warn', dismissible: true, text: 'The observed fire layer could not be loaded.' })
  if (forecast.status === 'error') list.push({ id: 'fc-error', tone: 'warn', dismissible: true, text: 'The forecast layer could not be loaded.' })
  if (aoiInView === false)
    list.push({
      id: 'outside',
      tone: 'info',
      dismissible: false,
      text: `Outside the modeled area. Fire model results cover only the dashed area${name ? ` around the ${name}` : ''}; elsewhere they are unknown, not low.`,
      action: { label: 'Return to incident', run: returnToIncident },
    })

  const shown = list.filter((n) => !(n.dismissible && dismissed[n.id]))
  if (shown.length === 0) return null
  return (
    <div className="fxm-notices" role="status" aria-live="polite">
      {shown.map((n) => (
        <div key={n.id} className={`fxm-notice is-${n.tone}`}>
          <span>{n.text}</span>
          {n.action && (
            <button type="button" className="fxm-notice-action" onClick={n.action.run}>
              {n.action.label}
            </button>
          )}
          {n.dismissible && (
            <button type="button" className="fxm-notice-close" aria-label="Dismiss notice" onClick={() => setDismissed((d) => ({ ...d, [n.id]: true }))}>
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
