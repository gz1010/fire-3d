// Items of the map workspace's top bar shared by the three chromes (brief 4 H2a; moved from the former MapHeader.tsx,
// behaviour unchanged): the panel toggles as round icon pills, the compact-screen menu (< 1024 px: the view switch
// and the panel toggles), the phones' labelled "Updates" toggle with its official badge, "Show panels (H)", the demo
// badge and Command's incident identifier. Not listed in any step of PLAN-4, so it is shared: change it only through
// the orchestrator (H2b and H3+H4 both use it).
import { BarChart3, Check, Copy, Layers, ListChecks, Maximize2, Menu } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { agencyIdLine } from '../../lib/recordText'
import { useOfficialBadge } from '../../official/hooks'
import { useStore } from '../../state/store'
import { useWorkspace, type PanelKey } from '../../state/workspace'
import { Popover } from '../controls'
import { goToOverview } from './fireActions'
import { BackButton, IconPill } from './TopBar'
import { ViewSwitch } from './WorkspaceSwitch'

/** The overview title's tooltip (§14.11). */
export const LOWER48_TIP = 'Lower 48 states; Alaska and Hawaii are not supported yet'

/** A top-bar icon pill that opens / closes a workspace panel; `data-panel-toggle` lets drawers hand focus back to it. */
export function PanelPill({ panel, icon, label, tip, className, badge }: { panel: PanelKey; icon: ReactNode; label: string; tip: string; className?: string; badge?: ReactNode }) {
  const open = useWorkspace((s) => s.panels[panel])
  const togglePanel = useWorkspace((s) => s.togglePanel)
  return <IconPill icon={icon} label={label} tip={tip} expanded={open} onClick={() => togglePanel(panel)} badge={badge} className={className} data-panel-toggle={panel} />
}

/** Analysis charts (inside a fire). */
export function AnalysisPill({ className = 'mw-hide-narrow' }: { className?: string }) {
  return <PanelPill panel="analysis" icon={<BarChart3 size={15} />} label="Analysis" tip="Analysis charts: burned area, spread speed, terrain profile" className={className} />
}

/** Layers, basemap, forecast run and units. */
export function LayersPill({ className = 'mw-hide-narrow' }: { className?: string }) {
  return <PanelPill panel="layers" icon={<Layers size={16} />} label="Layers" tip="Layers, basemap, forecast run and units" className={className} />
}

/** The bar's first useful focus target after a chrome swap: the active view in the pill, else the compact menu. */
function barFocusTarget(): HTMLElement | null {
  for (const sel of ['.mw-header .tb-view-btn[aria-checked="true"]', '.mw-header .mw-hdr-menu']) {
    const el = document.querySelector<HTMLElement>(sel)
    if (el && el.getClientRects().length > 0) return el
  }
  return null
}

/** Leaving a fire swaps the chrome (the back button goes away): once the overview is shown, move focus that was on the
 *  back button to the new bar, so keyboard users keep their place. History-aware leaving is asynchronous (Back). */
function keepFocusAfterLeaving(): void {
  let done = false
  const stop = () => {
    done = true
    unsub()
    window.clearTimeout(timer)
  }
  const unsub = useStore.subscribe((s) => {
    if (done || s.incidentId != null) return
    stop()
    requestAnimationFrame(() => barFocusTarget()?.focus({ preventScroll: true }))
  })
  const timer = window.setTimeout(stop, 3000)
}

/** "← All fires" as the bar's round back button: back to the overview of all fires (history-aware, fireActions.ts). */
export function AllFiresBack() {
  const back = () => {
    const btn = document.activeElement
    if (btn instanceof HTMLElement && btn.classList.contains('tb-back')) keepFocusAfterLeaving()
    goToOverview()
  }
  return <BackButton onClick={back} label="Back to all fires" tip="Back to the overview of all fires (lower 48 states)" />
}

export function DemoBadge() {
  return (
    <span className="mw-demo-badge" role="note" data-tip="Development fixture: terrain, fuels, fire and weather are synthetic, not a real incident">
      {/* the full wording is always the accessible text; the bar shows the long or the short form (Command's bar and
          medium widths: "Demo", so the place keeps its room; review DF-15) */}
      <span className="mw-sr-only">Demo · simulated data</span>
      <span className="mw-demo-long" aria-hidden="true">
        Demo · simulated data
      </span>
      <span className="mw-demo-short" aria-hidden="true">
        Demo
      </span>
    </span>
  )
}

/** Command: the incident identifier (Fire-3d id; the agency's incident ID in the tooltip, §14.5) with a copy button. */
export function IncidentIdChip() {
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

/** Compact screens (< 1024 px): the view switch and the panel toggles in one menu. */
export function HeaderMenu() {
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
      <IconPill
        ref={anchor}
        icon={<Menu size={16} />}
        label="Menu: view and panels"
        tip="View and panels"
        expanded={open}
        aria-haspopup="dialog"
        className="mw-hdr-menu"
        onClick={() => setOpen((o) => !o)}
      />
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

/** The menu, shown below 1024 px only. */
export function CompactMenu() {
  return (
    <span className="mw-compact-only">
      <HeaderMenu />
    </span>
  )
}

const BADGE_TEXT = { order: 'an evacuation order', warning: 'an evacuation warning', local: "a local officials' alert", 'fire-weather': 'a fire weather alert' } as const

/** Phones: the updates sheet toggle, labelled, with a badge while official orders, warnings or fire weather alerts
 *  are active near the fire (U-R4), and local officials' messages (brief 3, §14.7). The badge counts official items
 *  only; no badge is never an all-clear. */
export function UpdatesToggle() {
  const { count, level } = useOfficialBadge()
  const badge =
    count > 0 && level ? (
      <span className={`mw-hdr-badge is-${level}`}>
        <span aria-hidden="true">{count}</span>
        <span className="mw-sr-only">
          {' '}
          ({count} official item{count === 1 ? '' : 's'} active, the most urgent {BADGE_TEXT[level]})
        </span>
      </span>
    ) : null
  return <PanelPill panel="updates" icon={<ListChecks size={15} />} label="Updates" tip="Incident updates and official information" className="mw-narrow-only mw-updates-toggle has-label" badge={badge} />
}

/** "Show panels (H)" while the secondary panels are hidden. */
export function ShowPanelsPill() {
  const collapsed = useStore((s) => s.panelsCollapsed)
  if (!collapsed) return null
  return (
    <IconPill
      icon={<Maximize2 size={14} />}
      label="Show panels"
      tip="Panels are hidden (H)"
      className="has-label mw-show-panels"
      onClick={() => useStore.getState().setPanelsCollapsed(false)}
      badge={<kbd>H</kbd>}
    />
  )
}
