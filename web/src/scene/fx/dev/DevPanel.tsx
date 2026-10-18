// FX dev debug panel: time slider + play, visual style, lattice field, quality, exaggeration, tree scale, DOF,
// profile-path drawing, FPS and layer toggles. Plain glass HTML over the canvas (?panel=0 hides it).
import type { CSSProperties } from 'react'
import { getTimeBounds, LAYER_KEYS, SPEEDS_HOURS_PER_SEC, useStore, type LatticeField, type Quality, type VisualStyle } from '../../../state/store'
import { fmtDateTime } from '../../../lib/time'
import { useSceneStore } from '../../sceneStore'
import { fxStore } from '../state'

const STYLES: VisualStyle[] = ['hybrid', 'realistic', 'parametric']
const FIELDS: LatticeField[] = ['activity', 'probability', 'elevation', 'slope', 'canopy']
const QUALITIES: Quality[] = ['high', 'medium', 'low']

const row: CSSProperties = { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }

function Seg<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div style={row}>
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className="mono"
          style={{
            fontSize: 10,
            padding: '3px 7px',
            borderRadius: 5,
            cursor: 'pointer',
            border: `1px solid ${o === value ? 'var(--gold)' : 'var(--hairline)'}`,
            background: o === value ? 'var(--gold-faint)' : 'transparent',
            color: o === value ? 'var(--gold-bright)' : 'var(--text-2)',
          }}
        >
          {o}
        </button>
      ))}
    </div>
  )
}

export function DevPanel() {
  // re-render on discrete changes and every 5 min of sim time (not every playback frame)
  useStore((st) => Math.floor(st.timeMs / 300_000))
  useStore((st) => st.playing)
  useStore((st) => st.layers)
  useStore((st) => `${st.visualStyle}|${st.latticeField}|${st.quality}|${st.exaggeration}|${st.treeScale}|${st.dof}|${st.drawingPath}|${st.speedHoursPerSec}|${st.forecastRunId}|${st.manifest?.id}`)
  const s = useStore.getState()
  const fps = useSceneStore((st) => st.fps)
  const fronts = fxStore((st) => st.fronts)
  fxStore((st) => Math.floor(st.frontsVersion / 4))
  const b = getTimeBounds(s)
  const m = s.manifest
  if (new URLSearchParams(location.search).get('panel') === '0') return null
  const nowH = m ? (s.timeMs - m.time_origin_ms) / 3.6e6 : 0
  return (
    <div
      className="glass"
      style={{ position: 'absolute', left: 12, top: 12, width: 330, padding: '10px 12px', fontSize: 11, color: 'var(--text-2)', maxHeight: 'calc(100vh - 24px)', overflow: 'auto' }}
    >
      <div className="mono" style={{ color: 'var(--gold)', fontSize: 11 }}>
        fx-dev · {m?.id ?? 'loading…'} · {fps} fps
      </div>
      {m && b && (
        <>
          <div className="mono" style={{ marginTop: 6, color: 'var(--text)' }}>
            {fmtDateTime(s.timeMs)} · t={nowH.toFixed(2)} h
          </div>
          <input
            type="range"
            min={b.startMs}
            max={b.endMs}
            step={60_000}
            value={s.timeMs}
            onChange={(e) => s.setTimeMs(Number(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--gold)' }}
          />
          <div style={row}>
            <button className="mono" onClick={() => s.togglePlaying()} style={{ fontSize: 10, padding: '3px 8px' }}>
              {s.playing ? 'pause' : 'play'}
            </button>
            <select value={s.speedHoursPerSec} onChange={(e) => s.setSpeedHoursPerSec(Number(e.target.value))} className="mono" style={{ fontSize: 10 }}>
              {SPEEDS_HOURS_PER_SEC.map((v) => (
                <option key={v} value={v}>
                  {v} h/s
                </option>
              ))}
            </select>
            <button className="mono" onClick={() => s.setDrawingPath(!s.drawingPath)} style={{ fontSize: 10, padding: '3px 8px' }}>
              {s.drawingPath ? 'drawing… (Esc)' : 'draw path'}
            </button>
          </div>
          <div className="mono" style={{ marginTop: 4, fontSize: 10 }}>
            fronts: {fronts ? `${fronts.clusters.length} clusters · ${(fronts.totalLengthM / 1000).toFixed(1)} km · ${fronts.source}` : '—'}
          </div>
        </>
      )}
      <Seg value={s.visualStyle} options={STYLES} onChange={s.setVisualStyle} />
      <Seg value={s.latticeField} options={FIELDS} onChange={s.setLatticeField} />
      <Seg value={s.quality} options={QUALITIES} onChange={s.setQuality} />
      <div style={row}>
        <span>exag</span>
        <Seg value={String(s.exaggeration)} options={['1', '1.5', '2', '3']} onChange={(v) => s.setExaggeration(Number(v))} />
      </div>
      <div style={row}>
        <span>trees ×{s.treeScale.toFixed(1)}</span>
        <input type="range" min={0.5} max={4} step={0.1} value={s.treeScale} onChange={(e) => s.setTreeScale(Number(e.target.value))} style={{ flex: 1, accentColor: 'var(--gold)' }} />
        <label>
          <input type="checkbox" checked={s.dof} onChange={(e) => s.setDof(e.target.checked)} /> dof
        </label>
      </div>
      <div style={{ ...row, marginTop: 8 }}>
        {LAYER_KEYS.map((k) => (
          <label key={k} className="mono" style={{ fontSize: 10, minWidth: 96, color: s.layers[k].visible ? 'var(--text)' : 'var(--text-3)' }}>
            <input type="checkbox" checked={s.layers[k].visible} onChange={() => s.toggleLayer(k)} /> {k}
          </label>
        ))}
      </div>
      {m && m.forecasts.length > 0 && (
        <div style={row}>
          <label className="mono" style={{ fontSize: 10 }}>
            <input type="checkbox" checked={s.forecastRunId != null} onChange={(e) => void s.selectForecast(e.target.checked ? m.forecasts[0].run_id : null)} /> forecast{' '}
            {m.forecasts[0].run_id}
          </label>
        </div>
      )}
    </div>
  )
}
