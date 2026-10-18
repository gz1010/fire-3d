// Compact Public/Command header (owner: shell, CONTRACT §3; BRIEF §2, §6): brand, incident picker, workspace switch,
// demo badge, preset switch and the toggles for the secondary panels (Analysis drawer, Layers & settings). Command
// adds the incident identifier from 1280 px (narrower, the name keeps the room and the coordinate strip shows the
// identifier). Below 1024 px the workspace and preset switches move into a menu; below 761 px the updates panel gets a
// header toggle too (it is a bottom sheet there).
import { BarChart3, Check, Copy, Layers, ListChecks, Maximize2, Menu } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { useStore } from '../../state/store'
import { isDemoBundle, useWorkspace, type PanelKey } from '../../state/workspace'
import { Popover } from '../controls'
import { Logo } from '../Header'
import { IncidentPicker } from '../IncidentPicker'
import { PresetSwitch, WorkspaceSwitch } from './WorkspaceSwitch'

/** Header button that opens / closes a workspace panel; `data-panel-toggle` lets drawers hand focus back to it. */
export function PanelToggle({ panel, icon, label, tip, className, iconOnly }: { panel: PanelKey; icon: ReactNode; label: string; tip: string; className?: string; iconOnly?: boolean }) {
  const open = useWorkspace((s) => s.panels[panel])
  const togglePanel = useWorkspace((s) => s.togglePanel)
  return (
    <button
      type="button"
      className={`mw-btn mw-hdr-toggle ${open ? 'is-active' : ''} ${iconOnly ? 'is-icon' : ''} ${className ?? ''}`}
      aria-expanded={open}
      data-tip={tip}
      data-panel-toggle={panel}
      onClick={() => togglePanel(panel)}
    >
      {icon}
      {/* visually hidden (not removed) when icon-only, so it stays the accessible name */}
      <span className="mw-btn-label">{label}</span>
    </button>
  )
}

function DemoBadge() {
  return (
    <span className="mw-demo-badge" role="note" data-tip="Development fixture: terrain, fuels, fire and weather are synthetic, not a real incident">
      <span className="mw-demo-long">Demo · simulated data</span>
      <span className="mw-demo-short" aria-hidden="true">
        Demo
      </span>
    </span>
  )
}

/** Command: the incident identifier (Fire-3d id; CAL FIRE UID in the tooltip) with a copy button. */
function IncidentIdChip() {
  const id = useStore((s) => s.incidentId)
  const uid = useStore((s) => s.summary?.calfire_uid ?? null)
  const [copied, setCopied] = useState(false)
  if (!id) return null
  const copy = () =>
    void navigator.clipboard
      ?.writeText(id)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1400)
      })
      .catch(() => undefined)
  return (
    <span className="mw-id-chip" data-tip={uid ? `CAL FIRE incident UID ${uid}` : 'Fire-3d incident identifier'}>
      <span className="mw-id-label">ID</span>
      <span className="mw-mono mw-id-value">{id}</span>
      <button type="button" className="mw-icon-btn is-sm" aria-label={copied ? 'Incident ID copied' : 'Copy incident ID'} onClick={copy}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </span>
  )
}

/** Compact screens: workspace, preset and panel toggles in one menu. */
function HeaderMenu() {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const panels = useWorkspace((s) => s.panels)
  const togglePanel = useWorkspace((s) => s.togglePanel)
  const item = (key: PanelKey, icon: ReactNode, label: string) => (
    <button
      type="button"
      className={`mw-menu-item ${panels[key] ? 'is-active' : ''}`}
      aria-pressed={panels[key]}
      onClick={() => {
        togglePanel(key)
        setOpen(false)
      }}
    >
      {icon}
      <span>{label}</span>
      {panels[key] && <Check size={13} className="mw-menu-check" />}
    </button>
  )
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`mw-btn mw-hdr-toggle is-icon mw-hdr-menu ${open ? 'is-active' : ''}`}
        aria-label="Menu: workspace, preset and panels"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Menu size={16} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={292} className="mw-menu-pop" label="Workspace menu">
        <div className="mw-menu">
          <div className="mw-menu-group">
            <span className="mw-menu-label">Workspace</span>
            <WorkspaceSwitch size="sm" className="mw-seg-fill" />
          </div>
          <div className="mw-menu-group">
            <span className="mw-menu-label">Preset</span>
            <PresetSwitch size="sm" className="mw-seg-fill" />
          </div>
          <div className="mw-menu-group">
            <span className="mw-menu-label">Panels</span>
            {item('updates', <ListChecks size={15} />, 'Incident updates')}
            {item('layers', <Layers size={15} />, 'Layers, basemap & settings')}
            {item('analysis', <BarChart3 size={15} />, 'Analysis charts')}
          </div>
        </div>
      </Popover>
    </>
  )
}

export function MapHeader() {
  const demo = useStore((s) => isDemoBundle(s.incidentId, s.manifest))
  const command = useWorkspace((s) => s.preset === 'command')
  const collapsed = useStore((s) => s.panelsCollapsed)
  const loading = useStore((s) => s.incidentLoading || s.catalog.loading)
  return (
    <div className="mw-hdr">
      <div className="mw-hdr-start">
        <span className="mw-brand">
          <Logo size={22} />
          <span className="mw-brand-name">Fire-3d</span>
        </span>
        <span className="mw-hdr-sep" aria-hidden="true" />
        <IncidentPicker />
        {command && <IncidentIdChip />}
      </div>
      <div className="mw-hdr-mid mw-wide-only">
        <WorkspaceSwitch />
      </div>
      <div className="mw-hdr-end">
        {demo && <DemoBadge />}
        <PresetSwitch className="mw-wide-only" />
        {collapsed && (
          <button type="button" className="mw-btn mw-hdr-toggle" onClick={() => useStore.getState().setPanelsCollapsed(false)} data-tip="Panels are hidden (H)">
            <Maximize2 size={14} />
            <span className="mw-btn-label">Show panels</span>
            <kbd>H</kbd>
          </button>
        )}
        <span className="mw-hdr-sep mw-wide-only" aria-hidden="true" />
        <PanelToggle panel="updates" icon={<ListChecks size={15} />} label="Updates" tip="Incident updates" className="mw-narrow-only" iconOnly />
        <PanelToggle panel="analysis" icon={<BarChart3 size={15} />} label="Analysis" tip="Analysis charts: burned area, spread speed, terrain profile" className="mw-hide-narrow" />
        <PanelToggle panel="layers" icon={<Layers size={15} />} label="Layers" tip="Layers, basemap, forecast run and units" className="mw-hide-narrow" />
        <span className="mw-compact-only">
          <HeaderMenu />
        </span>
      </div>
      <span className={`mw-hdr-loading ${loading ? 'is-on' : ''}`} aria-hidden="true" />
    </div>
  )
}
