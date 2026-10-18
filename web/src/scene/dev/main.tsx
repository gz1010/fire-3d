// Scene isolation page (SPEC 10): mounts only <Scene/> full-screen and loads an incident into the store itself
// (api/client + setState, see loadBundle.ts). Debug panel on the right; window.__store / window.__sceneStore exposed.
// URL params: ?incident=<id> (default fixture-demo)  ?t=<epoch ms>  ?style=hybrid|realistic|parametric
//             ?quality=high|medium|low  ?view=2d|3d  ?exag=<n>  ?dof=0|1  ?panel=0 (hide the debug panel)
//             ?forecast=<run id>|none  ?layers=+fuels,-lattice (toggle layers by name)
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles/theme.css'
import { LAYER_KEYS, useStore, type LayerKey, type Quality, type ViewMode, type VisualStyle } from '../../state/store'
import { assetStore } from '../assets'
import { camState } from '../camera/cameraState'
import { look } from '../look'
import { Scene } from '../Scene'
import { useSceneStore } from '../sceneStore'
import { DevPanel, useDevPlayback } from './DevPanel'
import './dev.css'
import { loadIncidentIntoStore } from './loadBundle'

const q = new URLSearchParams(location.search)
const showPanel = q.get('panel') !== '0'

function applyUrlSettings() {
  const s = useStore.getState()
  const style = q.get('style') as VisualStyle | null
  if (style && ['hybrid', 'realistic', 'parametric'].includes(style)) s.setVisualStyle(style)
  const quality = q.get('quality') as Quality | null
  if (quality && ['high', 'medium', 'low'].includes(quality)) s.setQuality(quality)
  const view = q.get('view') as ViewMode | null
  if (view === '2d' || view === '3d') s.setViewMode(view)
  const exag = Number(q.get('exag'))
  if (exag > 0) s.setExaggeration(exag)
  if (q.get('dof') === '0') s.setDof(false)
  // "+name" arrives as " name" (a "+" in a query string decodes to a space): trim, then read the sign
  for (const raw of (q.get('layers') ?? '').split(',')) {
    const tok = raw.trim()
    if (!tok) continue
    const on = !tok.startsWith('-')
    const key = tok.replace(/^[+-]/, '') as LayerKey
    if (LAYER_KEYS.includes(key)) s.setLayerVisible(key, on)
  }
}

function DevApp() {
  const manifest = useStore((s) => s.manifest)
  const timeMs = useStore((s) => s.timeMs)
  useDevPlayback()
  useEffect(() => {
    applyUrlSettings()
    const fc = q.get('forecast')
    void loadIncidentIntoStore(q.get('incident') ?? 'fixture-demo', {
      timeMs: Number(q.get('t')) || null,
      forecastRunId: fc === 'none' ? null : fc ?? undefined,
    }).catch((e) => console.error('[scene-dev] load failed', e))
  }, [])
  return (
    <div className={`sd-root${showPanel ? ' sd-with-panel' : ''}`}>
      <Scene />
      {showPanel && (
        <div className="glass sd-badge">
          scene-dev · {manifest?.id ?? 'loading…'} · {new Date(timeMs).toISOString().slice(0, 16)}Z
        </div>
      )}
      {showPanel && <DevPanel />}
    </div>
  )
}

window.__store = useStore
window.__sceneStore = useSceneStore
// dev-only handles for scripted screenshots / measurements
Object.assign(window, { __assetStore: assetStore, __camState: camState, __look: look })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DevApp />
  </StrictMode>,
)
