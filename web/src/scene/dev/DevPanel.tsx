// scene-dev debug panel: time slider + playback, visual style, lattice field, view / quality / DOF / exaggeration,
// forecast run, every layer (visibility + opacity), camera commands, FPS and the live probe.
import { useEffect } from 'react'
import { fmtAt } from '../../lib/time'
import { getTimeBounds, LAYER_KEYS, SPEEDS_HOURS_PER_SEC, useStore, type LatticeField, type Quality, type VisualStyle } from '../../state/store'
import { useTimeFormat } from '../../state/timeZone'
import { useSceneStore } from '../sceneStore'
import { selectForecastRun } from './loadBundle'

const HOUR = 3_600_000
const STYLES: VisualStyle[] = ['hybrid', 'realistic', 'parametric']
const FIELDS: LatticeField[] = ['activity', 'probability', 'elevation', 'slope', 'canopy']
const QUALITIES: Quality[] = ['high', 'medium', 'low']

/** rAF playback (the app's own playback hook lives in the UI layer; the dev page runs this one). */
export function useDevPlayback() {
  const playing = useStore((s) => s.playing)
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const s = useStore.getState()
      if (!s.playing) return
      const b = s.timeWindow ?? getTimeBounds(s)
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (!b) return
      let next = s.timeMs + dt * s.speedHoursPerSec * HOUR
      if (next >= b.endMs) next = b.startMs
      s.setTimeMs(next)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: T[]; onChange: (v: T) => void }) {
  return (
    <div className="sd-seg">
      {options.map((o) => (
        <button key={o} type="button" aria-pressed={o === value} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  )
}

export function DevPanel() {
  const s = useStore()
  const tf = useTimeFormat()
  const fps = useSceneStore((x) => x.fps)
  const probe = useSceneStore((x) => x.probe)
  const cam = useSceneStore((x) => x.camera)
  const issue = useSceneStore((x) => x.issueCameraCommand)
  const m = s.manifest
  const bounds = getTimeBounds(s)
  const origin = m?.time_origin_ms ?? 0
  return (
    <div className="glass sd-panel">
      <h3>scene-dev · {m?.id ?? (s.incidentLoading ? 'loading…' : 'no incident')}</h3>
      {s.incidentError && <div className="sd-err">{s.incidentError}</div>}
      <div className="sd-row">
        <span className="sd-time-sub">
          {fps.toFixed(1)} fps · {s.quality} · {cam ? `${Math.round(cam.distance)} m · ${Math.round(cam.bearingDeg)}°` : ''}
        </span>
      </div>

      <h3>Time</h3>
      {bounds && m && (
        <>
          <div className="sd-row">
            <span className="sd-time">{fmtAt(s.timeMs, tf)}</span>
            <span className="sd-time-sub">T{((s.timeMs - origin) / HOUR).toFixed(1)} h</span>
          </div>
          <input
            className="sd-range"
            type="range"
            min={bounds.startMs}
            max={bounds.endMs}
            step={5 * 60_000}
            value={s.timeMs}
            onChange={(e) => s.setTimeMs(Number(e.target.value))}
          />
          <div className="sd-btns">
            <button type="button" onClick={() => s.togglePlaying()}>
              {s.playing ? 'Pause' : 'Play'}
            </button>
            <button type="button" onClick={() => s.setTimeMs(s.timeMs - HOUR)}>
              −1 h
            </button>
            <button type="button" onClick={() => s.setTimeMs(s.timeMs + HOUR)}>
              +1 h
            </button>
            <button type="button" onClick={() => s.setTimeMs(m.time_range.now_ms)}>
              now
            </button>
            {s.forecast && (
              <button type="button" onClick={() => s.setTimeMs(s.forecast!.start_ms + 36 * HOUR)}>
                fc+36h
              </button>
            )}
            <select value={s.speedHoursPerSec} onChange={(e) => s.setSpeedHoursPerSec(Number(e.target.value))}>
              {SPEEDS_HOURS_PER_SEC.map((v) => (
                <option key={v} value={v}>
                  {v} h/s
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      <h3>Look</h3>
      <Seg value={s.visualStyle} options={STYLES} onChange={s.setVisualStyle} />
      <div className="sd-row">
        <label>lattice field</label>
        <select value={s.latticeField} onChange={(e) => s.setLatticeField(e.target.value as LatticeField)}>
          {FIELDS.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
      </div>

      <h3>View</h3>
      <Seg value={s.viewMode} options={['3d', '2d']} onChange={s.setViewMode} />
      <div className="sd-row">
        <label>quality</label>
        <select value={s.quality} onChange={(e) => s.setQuality(e.target.value as Quality)}>
          {QUALITIES.map((q) => (
            <option key={q}>{q}</option>
          ))}
        </select>
      </div>
      <div className="sd-row">
        <label>exaggeration</label>
        <select value={s.exaggeration} onChange={(e) => s.setExaggeration(Number(e.target.value))}>
          {[1, 1.5, 2, 3, 5].map((v) => (
            <option key={v} value={v}>
              {v}×
            </option>
          ))}
        </select>
      </div>
      <div className="sd-row">
        <label>tree scale {s.treeScale.toFixed(1)}</label>
        <input type="range" min={0.5} max={3} step={0.1} value={s.treeScale} onChange={(e) => s.setTreeScale(Number(e.target.value))} />
      </div>
      <div className="sd-row">
        <label>
          <input type="checkbox" checked={s.dof} onChange={(e) => s.setDof(e.target.checked)} /> depth of field
        </label>
      </div>
      <div className="sd-btns">
        <button type="button" onClick={() => issue('frame-fire')}>
          frame fire
        </button>
        <button type="button" onClick={() => issue('reset-north')}>
          north
        </button>
        <button type="button" onClick={() => issue('zoom-in')}>
          zoom +
        </button>
        <button type="button" onClick={() => issue('zoom-out')}>
          zoom −
        </button>
      </div>

      <h3>Forecast</h3>
      <div className="sd-row">
        <select value={s.forecastRunId ?? ''} onChange={(e) => void selectForecastRun(e.target.value || null)}>
          <option value="">none</option>
          {(m?.forecasts ?? [])
            .filter((f) => f.status === 'ready')
            .map((f) => (
              <option key={f.run_id} value={f.run_id}>
                {f.run_id} · {f.ensemble} ×{f.members}
              </option>
            ))}
        </select>
      </div>

      <h3>Layers</h3>
      {LAYER_KEYS.map((k) => (
        <div key={k} className="sd-layer">
          <input type="checkbox" checked={s.layers[k].visible} onChange={() => s.toggleLayer(k)} aria-label={k} />
          <span>{k}</span>
          <input type="range" min={0} max={1} step={0.05} value={s.layers[k].opacity} onChange={(e) => s.setLayerOpacity(k, Number(e.target.value))} />
          <span>{Math.round(s.layers[k].opacity * 100)}%</span>
        </div>
      ))}

      <h3>Probe</h3>
      <div className="sd-mono">
        {probe
          ? JSON.stringify(
              {
                lat: +probe.lat.toFixed(5),
                lon: +probe.lon.toFixed(5),
                elev: Math.round(probe.elev),
                fuel: probe.fuel,
                arrivalH: probe.arrivalH == null ? null : +probe.arrivalH.toFixed(2),
                pBurn: probe.pBurn == null ? null : +probe.pBurn.toFixed(2),
                pBurnNow: probe.pBurnNow == null ? null : +probe.pBurnNow.toFixed(2),
                slope: +probe.slope.toFixed(3),
              },
              null,
              1,
            )
          : 'hover the terrain'}
      </div>
    </div>
  )
}
