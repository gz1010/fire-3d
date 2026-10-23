// Header menus (SPEC 9.4): View (style, lattice field, 2D/3D, exaggeration, tree scale, DOF, quality), Analysis,
// Share (copies ?incident=&t=&mode=) and Settings.
import {
  BarChart3,
  ChevronDown,
  Crosshair,
  Database,
  Eye,
  Flame,
  Hammer,
  Keyboard,
  Link2,
  LocateFixed,
  Route,
  RotateCcw,
  Settings,
  Share2,
  SlidersHorizontal,
  TrendingUp,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getHealth } from '../api/client'
import type { HealthResponse } from '../api/types'
import { fmtNumber } from '../lib/format'
import { activeCountText } from '../state/overview'
import { fmtRelative, zoneLine } from '../lib/time'
import { shareUrl } from '../state/runtime'
import { peakGrowth } from '../state/selectors'
import { useStore, type Quality, type ViewMode } from '../state/store'
import { useTimeFormat, useZoneSource } from '../state/timeZone'
import { MenuItem, MenuSection, MenuSeparator, Popover, Segmented, Slider, Switch } from './controls'
import { useNow } from './hooks'
import { EXAGGERATIONS, LATTICE_FIELDS, STYLE_OPTIONS } from './options'
import { toast } from './toast'

function MenuButton({ label, icon, open, setOpen, anchor }: { label: string; icon: React.ReactNode; open: boolean; setOpen: (v: boolean) => void; anchor: React.RefObject<HTMLButtonElement | null> }) {
  return (
    <button ref={anchor} type="button" className={`hdr-menu-btn ${open ? 'is-open' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      {icon}
      <span>{label}</span>
      <ChevronDown size={12} className="caret" />
    </button>
  )
}


export function ViewMenu() {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const st = useStore(
    useShallow((s) => ({
    visualStyle: s.visualStyle,
    latticeField: s.latticeField,
    viewMode: s.viewMode,
    exaggeration: s.exaggeration,
    treeScale: s.treeScale,
    dof: s.dof,
    quality: s.quality,
    hasForecast: s.forecast != null,
  })),
  )
  const set = useStore.getState
  return (
    <>
      <MenuButton label="View" icon={<Eye size={14} />} open={open} setOpen={setOpen} anchor={anchor} />
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={320} label="View options" className="menu-pop">
        <MenuSection label="Visual style">
          <div className="style-cards">
            {STYLE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`style-card style-${o.value}`}
                aria-pressed={st.visualStyle === o.value}
                onClick={() => set().setVisualStyle(o.value)}
                data-tip={o.desc}
              >
                <span className="style-swatch" aria-hidden />
                <span>{o.label}</span>
              </button>
            ))}
          </div>
        </MenuSection>
        <MenuSection label="Lattice field">
          <div className="radio-list">
            {LATTICE_FIELDS.map((f) => {
              const disabled = f.value === 'probability' && !st.hasForecast
              return (
                <button
                  key={f.value}
                  type="button"
                  className="radio-row"
                  role="radio"
                  aria-checked={st.latticeField === f.value}
                  disabled={disabled}
                  onClick={() => set().setLatticeField(f.value)}
                >
                  <span className="radio-dot" />
                  <span>{f.label}</span>
                  <span className="muted radio-desc">{disabled ? 'needs a forecast' : f.desc}</span>
                </button>
              )
            })}
          </div>
        </MenuSection>
        <MenuSection label="Camera">
          <div className="menu-grid">
            <span className="label">Projection</span>
            <Segmented<ViewMode>
              size="sm"
              value={st.viewMode}
              onChange={(v) => set().setViewMode(v)}
              options={[
                { value: '2d', label: '2D' },
                { value: '3d', label: '3D' },
              ]}
            />
            <span className="label">Exaggeration</span>
            <Segmented<number>
              size="sm"
              value={EXAGGERATIONS.includes(st.exaggeration) ? st.exaggeration : 1.5}
              onChange={(v) => set().setExaggeration(v)}
              options={EXAGGERATIONS.map((v) => ({ value: v, label: `${v}×` }))}
            />
            <span className="label">Tree scale</span>
            <span className="slider-row">
              <Slider label="Tree scale" min={0.5} max={3} step={0.1} value={st.treeScale} onChange={(v) => set().setTreeScale(v)} />
              <span className="mono slider-val">{st.treeScale.toFixed(1)}×</span>
            </span>
            <span className="label">Depth of field</span>
            <span>
              <Switch checked={st.dof} onChange={(v) => set().setDof(v)} label="Depth of field" tip={st.viewMode === '2d' ? 'DOF is off in 2D' : undefined} />
            </span>
            <span className="label">Quality</span>
            <Segmented<Quality>
              size="sm"
              value={st.quality}
              onChange={(v) => set().setQuality(v)}
              options={[
                { value: 'high', label: 'High' },
                { value: 'medium', label: 'Med' },
                { value: 'low', label: 'Low' },
              ]}
            />
          </div>
        </MenuSection>
        <MenuSeparator />
        <MenuItem icon={<SlidersHorizontal size={14} />} label="Hide panels (cinematic)" hint={<kbd>H</kbd>} onSelect={() => (setOpen(false), set().setPanelsCollapsed(true))} />
      </Popover>
    </>
  )
}

export function AnalysisMenu() {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const s = useStore(
    useShallow((st) => ({
    manifest: st.manifest,
    mode: st.mode,
    timeseries: st.timeseries,
    job: st.job,
    profileLen: st.profilePath.length,
    drawing: st.drawingPath,
  })),
  )
  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  const st = useStore.getState
  const m = s.manifest
  const peak = peakGrowth(s.timeseries)
  const busy = s.job != null && (s.job.status === 'queued' || s.job.status === 'running')
  return (
    <>
      <MenuButton label="Analysis" icon={<BarChart3 size={14} />} open={open} setOpen={setOpen} anchor={anchor} />
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={292} label="Analysis" className="menu-pop">
        <MenuSection label="Forecast">
          <MenuItem
            icon={<Flame size={14} />}
            label={s.mode === 'live' ? 'Run forecast from now…' : 'Run hindcast from timeline time…'}
            disabled={!m || m.status !== 'ready'}
            onSelect={run(() => st().setRightTab('analysis'))}
          />
          <MenuItem icon={<BarChart3 size={14} />} label="Forecast runs & skill" hint={m ? <span className="mono">{m.forecasts.length}</span> : undefined} disabled={!m} onSelect={run(() => st().setRightTab('analysis'))} />
        </MenuSection>
        <MenuSection label="Navigate">
          <MenuItem
            icon={<Crosshair size={14} />}
            label="Jump to ignition"
            disabled={!m?.ignition}
            onSelect={run(() => {
              const ig = m?.ignition
              if (!ig) return
              st().setPlaying(false)
              st().setTimeMs(ig.t_ms)
              st().requestFlyTo(ig.x, ig.z)
            })}
          />
          <MenuItem
            icon={<TrendingUp size={14} />}
            label="Jump to peak growth"
            hint={peak ? <span className="mono">{fmtNumber(peak.acresPerH)} ac/h</span> : undefined}
            disabled={!peak}
            onSelect={run(() => {
              if (!peak) return
              st().setPlaying(false)
              st().setTimeMs(peak.tMs)
            })}
          />
          <MenuItem
            icon={<LocateFixed size={14} />}
            label={s.mode === 'live' ? 'Jump to now' : 'Jump to end of observations'}
            disabled={!m}
            onSelect={run(() => {
              if (!m) return
              st().setPlaying(false)
              st().setTimeMs(m.time_range.now_ms)
            })}
          />
        </MenuSection>
        <MenuSection label="Profile path">
          <MenuItem
            icon={<Route size={14} />}
            label={s.drawing ? 'Drawing… (click map, Esc to end)' : 'Draw elevation profile path'}
            disabled={!m}
            onSelect={run(() => {
              st().setLayerVisible('profilePath', true)
              st().setDrawingPath(!s.drawing)
            })}
          />
          <MenuItem icon={<RotateCcw size={14} />} label="Reset to default path" disabled={!m?.default_profile_path?.length} onSelect={run(() => st().setProfilePath(m?.default_profile_path ?? []))} />
        </MenuSection>
        <MenuSection label="Bundle">
          <MenuItem icon={<Database size={14} />} label="Evidence & data sources" disabled={!m} onSelect={run(() => st().setRightTab('evidence'))} />
          <MenuItem
            icon={<Hammer size={14} />}
            label="Rebuild bundle"
            tip="Re-download sources and rebuild every layer (minutes)"
            disabled={busy || !st().incidentId}
            onSelect={run(() => void st().startBuild(true))}
          />
        </MenuSection>
      </Popover>
    </>
  )
}

export function ShareButton() {
  const id = useStore((s) => s.incidentId)
  const copy = async () => {
    const url = shareUrl()
    try {
      await navigator.clipboard.writeText(url)
      toast('Link copied: incident, time and mode', 'ok')
    } catch {
      window.prompt('Copy this link', url)
    }
  }
  return (
    <button type="button" className="hdr-menu-btn" onClick={() => void copy()} disabled={!id} data-tip="Copy a link to this incident at the current time">
      <Share2 size={14} />
      <span>Share</span>
    </button>
  )
}

export function SettingsMenu() {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`icon-btn hdr-icon ${open ? 'is-active' : ''}`}
        aria-label="Settings"
        aria-expanded={open}
        data-tip={open ? undefined : 'Settings'}
        onClick={() => setOpen(!open)}
      >
        <Settings size={15} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={330} label="Settings" className="menu-pop">
        {open && <SettingsBody />}
      </Popover>
    </>
  )
}

function SettingsBody() {
  const autoBuild = useStore((s) => s.autoBuild)
  const liveStatus = useStore((s) => s.liveStatus)
  const [health, setHealth] = useState<HealthResponse | null | 'error'>(null)
  const now = useNow(15_000)
  const tf = useTimeFormat()
  const zoneSource = useZoneSource()
  useEffect(() => {
    let alive = true
    getHealth({ timeoutMs: 8000 })
      .then((h) => alive && setHealth(h))
      .catch(() => alive && setHealth('error'))
    void useStore.getState().refreshLiveStatus()
    return () => {
      alive = false
    }
  }, [])
  const st = useStore.getState
  return (
    <>
      <MenuSection label="Behaviour">
        <div className="menu-grid">
          {/* brief 2: off by default; only the Forensic incident picker uses it (the map's fire card asks instead) */}
          <span className="label" data-tip="Off: picking a fire without an analysis shows its Build button. Building takes 1-3 min.">
            Prepare analysis when I pick an unprepared fire
          </span>
          <span>
            <Switch checked={autoBuild} onChange={(v) => st().setAutoBuild(v)} label="Prepare analysis when I pick an unprepared fire" />
          </span>
        </div>
        <MenuItem icon={<RotateCcw size={14} />} label="Reset layers to defaults" onSelect={() => st().resetLayers()} />
      </MenuSection>
      <MenuSection label="Service">
        <dl className="kv">
          <dt>API</dt>
          <dd className="mono">
            {health === null ? 'checking…' : health === 'error' ? <span className="danger">unreachable</span> : <span className="ok">● online · v{health.version}</span>}
          </dd>
          <dt>Live refresh</dt>
          <dd className="mono">{liveStatus?.last_refresh_ms ? fmtRelative(liveStatus.last_refresh_ms, now) : '—'}</dd>
          <dt>Next refresh</dt>
          <dd className="mono">{liveStatus?.next_refresh_ms ? fmtRelative(liveStatus.next_refresh_ms, now) : '—'}</dd>
          <dt>Active (lower 48)</dt>
          <dd className="mono">
            {liveStatus ? `${activeCountText(liveStatus.active_incidents)} · ${fmtNumber(liveStatus.detections_24h)} det/24 h` : '—'}
          </dd>
          <dt>Auto-build</dt>
          <dd className="mono">{liveStatus ? (liveStatus.auto_build ? 'on' : 'off') : '—'}</dd>
          <dt>Times</dt>
          <dd className="mono">{zoneLine(tf, now, zoneSource).replace(/^Times: /, '')}</dd>
        </dl>
      </MenuSection>
      <MenuSection label="Keyboard" aside={<Keyboard size={13} className="muted" />}>
        <dl className="kv kv-keys">
          <dt>
            <kbd>H</kbd>
          </dt>
          <dd>Hide / show panels</dd>
          <dt>
            <kbd>Space</kbd>
          </dt>
          <dd>Play / pause</dd>
          <dt>
            <kbd>←</kbd> <kbd>→</kbd>
          </dt>
          <dd>Step 1 h (Shift: 6 h)</dd>
          <dt>
            <kbd>Esc</kbd>
          </dt>
          <dd>Close menus, stop drawing</dd>
        </dl>
      </MenuSection>
      <div className="menu-foot muted">
        <Link2 size={12} /> Fire-3d · research prototype — not for operational use
      </div>
    </>
  )
}
