// Compact Public/Command header (owner: shell, CONTRACT §3; BRIEF §2, §6; brief 2 O-R3, C-R8, U-R4): brand, then
// "United States · all fires" on the overview (brief 3: the lower 48) or "← All fires" + the incident picker inside a fire, the single
// "Public · Command · Forensic" switch, the demo badge and the toggles for the secondary panels (Analysis drawer, only
// inside a fire; Layers & settings). Command adds the incident identifier from 1280 px (narrower, the name keeps the
// room and the coordinate strip shows the identifier). Below 1024 px the switch moves into a menu; below 761 px the
// updates panel gets a labelled header toggle with a badge for active official orders, warnings and fire weather
// alerts (it is a bottom sheet there).
import { ArrowLeft, BarChart3, Check, Copy, Layers, ListChecks, Maximize2, Menu } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { ImageryChip } from '../../extras/ImageryChip'
import { useOfficialBadge } from '../../official/hooks'
import { agencyIdLine } from '../../lib/recordText'
import { useStore } from '../../state/store'
import { isDemoBundle, useWorkspace, type PanelKey } from '../../state/workspace'
import { Popover } from '../controls'
import { Logo } from '../Header'
import { IncidentPicker } from '../IncidentPicker'
import { goToOverview } from './fireActions'
import { useMediaQuery, WIDE_QUERY } from './hooks'
import { ViewSwitch } from './WorkspaceSwitch'

/** The overview header's tooltip (§14.11). */
export const LOWER48_TIP = 'Lower 48 states; Alaska and Hawaii are not supported yet'

/** Header button that opens / closes a workspace panel; `data-panel-toggle` lets drawers hand focus back to it. */
export function PanelToggle({
  panel,
  icon,
  label,
  tip,
  className,
  iconOnly,
  badge,
}: {
  panel: PanelKey
  icon: ReactNode
  label: string
  tip: string
  className?: string
  iconOnly?: boolean
  badge?: ReactNode
}) {
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
      {badge}
    </button>
  )
}

const BADGE_TEXT = { order: 'evacuation order', warning: 'evacuation warning', 'fire-weather': 'fire weather alert' } as const

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

/** Command: the incident identifier (Fire-3d id; the agency's incident ID in the tooltip, §14.5) with a copy button. */
function IncidentIdChip() {
  const id = useStore((s) => s.incidentId)
  const agencyId = useStore((s) => (s.summary && s.summary.id === s.incidentId ? agencyIdLine(s.summary) : null))
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
    <span className="mw-id-chip" data-tip={agencyId ?? 'Fire-3d incident identifier'}>
      <span className="mw-id-label">ID</span>
      <span className="mw-mono mw-id-value">{id}</span>
      <button type="button" className="mw-icon-btn is-sm" aria-label={copied ? 'Incident ID copied' : 'Copy incident ID'} onClick={copy}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </span>
  )
}

/** Compact screens: the view switch and the panel toggles in one menu. */
function HeaderMenu() {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const panels = useWorkspace((s) => s.panels)
  const togglePanel = useWorkspace((s) => s.togglePanel)
  const overview = useStore((s) => s.incidentId == null)
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
        aria-label="Menu: view and panels"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Menu size={16} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={300} className="mw-menu-pop" label="View menu">
        <div className="mw-menu">
          <div className="mw-menu-group">
            <span className="mw-menu-label">View</span>
            <ViewSwitch size="sm" className="mw-seg-fill" />
          </div>
          <div className="mw-menu-group">
            <span className="mw-menu-label">Panels</span>
            {item('updates', <ListChecks size={15} />, overview ? 'Fires (lower 48)' : 'Incident updates')}
            {item('layers', <Layers size={15} />, 'Layers, basemap & settings')}
            {!overview && item('analysis', <BarChart3 size={15} />, 'Analysis charts')}
          </div>
        </div>
      </Popover>
    </>
  )
}

/** Phones: the updates sheet toggle, labelled, with a badge while official orders, warnings or fire weather alerts
 *  are active near the fire (U-R4). The badge counts official items only; no badge is never an all-clear. */
function UpdatesToggle() {
  const { count, level } = useOfficialBadge()
  const badge =
    count > 0 && level ? (
      <span className={`mw-hdr-badge is-${level}`}>
        <span aria-hidden="true">{count}</span>
        <span className="mw-sr-only">
          {' '}
          ({count} official item{count === 1 ? '' : 's'} active, the most urgent a {BADGE_TEXT[level]})
        </span>
      </span>
    ) : null
  return <PanelToggle panel="updates" icon={<ListChecks size={15} />} label="Updates" tip="Incident updates and official information" className="mw-narrow-only mw-updates-toggle" badge={badge} />
}

export function MapHeader() {
  const demo = useStore((s) => isDemoBundle(s.incidentId, s.manifest))
  const overview = useStore((s) => s.incidentId == null)
  const command = useWorkspace((s) => s.preset === 'command')
  const collapsed = useStore((s) => s.panelsCollapsed)
  const loading = useStore((s) => s.incidentLoading || s.catalog.loading)
  // wide screens: the satellite chip sits in the bar, right above the map controls (it adds no chrome over the map);
  // narrower, App puts it in the top row next to the controls
  const wide = useMediaQuery(WIDE_QUERY)
  return (
    <div className="mw-hdr">
      <div className="mw-hdr-start">
        <span className="mw-brand">
          <Logo size={22} />
          <span className="mw-brand-name">Fire-3d</span>
        </span>
        <span className="mw-hdr-sep" aria-hidden="true" />
        {overview ? (
          <h1 className="mw-hdr-title" data-tip={LOWER48_TIP}>
            United States <span className="mw-hdr-title-sub">· all fires</span>
          </h1>
        ) : (
          <>
            <button type="button" className="mw-btn mw-allfires" onClick={goToOverview} data-tip="Back to the overview of all fires (lower 48 states)">
              <ArrowLeft size={14} />
              <span className="mw-btn-label">All fires</span>
            </button>
            <IncidentPicker />
            {command && <IncidentIdChip />}
          </>
        )}
      </div>
      <div className="mw-hdr-mid mw-wide-only">
        <ViewSwitch />
      </div>
      <div className="mw-hdr-end">
        {demo && <DemoBadge />}
        {wide && !overview && !collapsed && (
          <span className="mw-hdr-chip">
            <ImageryChip />
          </span>
        )}
        {collapsed && (
          <button type="button" className="mw-btn mw-hdr-toggle" onClick={() => useStore.getState().setPanelsCollapsed(false)} data-tip="Panels are hidden (H)">
            <Maximize2 size={14} />
            <span className="mw-btn-label">Show panels</span>
            <kbd>H</kbd>
          </button>
        )}
        <span className="mw-hdr-sep mw-wide-only" aria-hidden="true" />
        {!overview && <UpdatesToggle />}
        {!overview && <PanelToggle panel="analysis" icon={<BarChart3 size={15} />} label="Analysis" tip="Analysis charts: burned area, spread speed, terrain profile" className="mw-hide-narrow" />}
        <PanelToggle panel="layers" icon={<Layers size={15} />} label="Layers" tip="Layers, basemap, forecast run and units" className="mw-hide-narrow" />
        <span className="mw-compact-only">
          <HeaderMenu />
        </span>
      </div>
      <span className={`mw-hdr-loading ${loading ? 'is-on' : ''}`} aria-hidden="true" />
    </div>
  )
}
