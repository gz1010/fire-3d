// Honest map states (owner: map-core; BRIEF §3, §4, §11): which public provider is failing and what still works, the
// modeled-area boundary when the view has left it, and overlay data that could not be loaded. Notices sit at the top
// of the visible map area (inside the shell's --safe-* insets); provider notices can be dismissed for the session.
// Brief 2 (O-R12): when the USGS aerial photos fail, the map falls back to the dark street map (workspace
// basemapFallback) and says so here, with "Try aerial again"; past the photos' last zoom level it says the photo
// detail ends there (closer views only enlarge it).
import { X } from 'lucide-react'
import { useState } from 'react'
import { useStore } from '../state/store'
import { useWorkspace } from '../state/workspace'
import { useMapRuntime } from './mapStore'
import { USGS_IMAGERY_MAXZOOM } from './providers'

interface Notice {
  id: string
  tone: 'warn' | 'info'
  text: string
  action?: { label: string; run: () => void }
  dismissible: boolean
}

/** Zoom past which the aerial photos are only enlarged (USGS serves them to level 16). */
const PHOTO_DETAIL_END_ZOOM = USGS_IMAGERY_MAXZOOM + 0.5

export function MapNotices() {
  const providers = useMapRuntime((s) => s.providers)
  const aoiInView = useMapRuntime((s) => s.aoiInView)
  const observed = useMapRuntime((s) => s.overlays.observed)
  const forecast = useMapRuntime((s) => s.overlays.forecast)
  const actions = useMapRuntime((s) => s.actions)
  const pastPhotoDetail = useMapRuntime((s) => (s.camera?.zoom ?? 0) > PHOTO_DETAIL_END_ZOOM)
  const basemap = useWorkspace((s) => s.basemap)
  const fallback = useWorkspace((s) => s.basemapFallback)
  const perspective = useWorkspace((s) => s.perspective)
  const name = useStore((s) => s.summary?.name ?? null)
  const bundle = useStore((s) => s.manifest?.status ?? s.summary?.bundle_status ?? null)
  const hasIncident = useStore((s) => s.incidentId != null)
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({})

  const list: Notice[] = []
  if (providers.basemap.state === 'failed')
    list.push({ id: 'basemap', tone: 'warn', dismissible: true, text: 'Street map unavailable: OpenFreeMap did not respond, so roads and place names are missing. Wildfire layers still work.' })
  else if (providers.vector.state === 'failed')
    list.push({ id: 'vector', tone: 'warn', dismissible: true, text: 'Roads and place names unavailable: OpenFreeMap map tiles are not loading.' })
  if (fallback != null)
    list.push({
      id: 'aerial-fallback',
      tone: 'warn',
      dismissible: true,
      text: 'Aerial photos are not loading (USGS); showing the street map.',
      action: { label: 'Try aerial again', run: () => actions?.retryAerial() },
    })
  if (basemap === 'aerial' && pastPhotoDetail)
    list.push({ id: 'photo-detail', tone: 'info', dismissible: true, text: 'Photo detail ends here: the USGS aerial photos stop at this zoom, so closer views only enlarge them.' })
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
      action: { label: 'Return to incident', run: () => actions?.frameFire() },
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
