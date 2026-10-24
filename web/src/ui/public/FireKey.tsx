// The fire view's map key (brief 4 H4, FireView.dc.html "Map key"; PLAN-4 §3.4, decisions a and i-3): what the map
// shows, with its source and own time, and the scale. An old perimeter is never "now": "Latest perimeter · <source> ·
// <its time> (<age>)" with a Stale tag on a live fire's day-old perimeter (ui/public/fireView.ts perimeterKey). A fire
// Fire-3d has not prepared: "No mapped perimeter yet · reported location (<issuer>)"; prepared without a perimeter:
// "No perimeter published yet" (the burned-area estimate is not put in its place). "Legend details" opens the map
// legend's details for this view (map/MapLegend.tsx variant "key").
import { useShallow } from 'zustand/react/shallow'
import { ScaleBar } from '../../map/MapAttribution'
import { MapLegend } from '../../map/MapLegend'
import { newestPerimeter } from '../../map/fireProfile'
import { useStore } from '../../state/store'
import { useTimeFormat } from '../../state/timeZone'
import { useWorkspace } from '../../state/workspace'
import { useNow } from '../hooks'
import { NO_PERIMETER, perimeterKey } from './fireView'

export function FireKey({ details = true }: { details?: boolean }) {
  const s = useStore(
    useShallow((st) => {
      const ready = st.manifest?.status === 'ready' && st.manifest.id === st.incidentId
      const summary = st.summary && st.summary.id === st.incidentId ? st.summary : null
      return {
        ready,
        live: (ready ? st.manifest?.mode : summary?.mode) === 'live',
        perimeters: ready ? (st.perimeters?.perimeters ?? null) : null,
        issuer: summary?.record_issuer || null,
        hasSummary: summary != null,
        loading: st.incidentLoading,
      }
    }),
  )
  const perimetersOn = useWorkspace((w) => w.mapLayers.perimeters)
  const tf = useTimeFormat()
  const nowMs = useNow(60_000)
  const newest = s.ready ? newestPerimeter(s.perimeters) : null
  const k = newest ? perimeterKey(newest, nowMs, s.live, tf) : null
  let body
  if (k)
    body = (
      <span className="pfv-key-item">
        <span className="fxm-sw fxm-sw-fire-area" aria-hidden="true" />
        <span className="pfv-key-text">
          {k.text}
          {!perimetersOn && <span className="pfv-key-off"> (hidden in Layers)</span>} <span className="pfv-key-time">· {k.time}</span>
          {k.age && <span className="pfv-key-time"> ({k.age})</span>}
          {k.stale && (
            <span className="mw-chip mw-chip-stale pfv-key-stale" data-tip="This perimeter is more than a day old: the fire may have changed since">
              Stale
            </span>
          )}
        </span>
      </span>
    )
  else if (s.ready)
    body = (
      <span className="pfv-key-item">
        <span className="fxm-sw fxm-sw-reported" aria-hidden="true" />
        <span className="pfv-key-text">{NO_PERIMETER}</span>
      </span>
    )
  else if (s.hasSummary && !s.loading)
    body = (
      <span className="pfv-key-item">
        <span className="fxm-sw fxm-sw-reported" aria-hidden="true" />
        <span className="pfv-key-text">
          No mapped perimeter yet · reported location{s.issuer ? ` (${s.issuer})` : ''}
        </span>
      </span>
    )
  else
    body = (
      <span className="pfv-key-item">
        <span className="pfv-key-text">Loading the map data…</span>
      </span>
    )
  return (
    <div className="pfv-key" role="group" aria-label="Map key">
      {body}
      <span className="pfv-key-sep" aria-hidden="true" />
      <span className="pfv-key-scale">
        <ScaleBar />
      </span>
      {details && (
        <span className="pfv-key-legend">
          <MapLegend variant="key" />
        </span>
      )}
    </div>
  )
}
