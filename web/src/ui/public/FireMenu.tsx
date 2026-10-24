// The fire view's menu below 1024 px (brief 4 H4; PLAN-4 decision h: "bar: X, place/date (small), menu"): the view
// switch and the Layers drawer of the wide top-right cluster (its search button stays in the bar). The shared
// HeaderMenu (ui/shell/topBarItems.tsx) lists the Updates and Analysis panels, which the fire view does not have.
import { Check, Layers, Menu } from 'lucide-react'
import { useRef, useState } from 'react'
import { useWorkspace } from '../../state/workspace'
import { Popover } from '../controls'
import { IconPill } from '../shell/TopBar'
import { ViewSwitch } from '../shell/WorkspaceSwitch'

export function FireMenu() {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const layers = useWorkspace((s) => s.panels.layers)
  return (
    <span className="mw-compact-only">
      <IconPill
        ref={anchor}
        icon={<Menu size={16} />}
        label="Menu: view and layers"
        tip="View and layers"
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
            <span className="mw-menu-label">Map</span>
            <button
              type="button"
              className={`mw-menu-item ${layers ? 'is-active' : ''}`}
              aria-pressed={layers}
              onClick={() => {
                useWorkspace.getState().togglePanel('layers')
                setOpen(false)
              }}
            >
              <Layers size={15} />
              <span>Layers, basemap &amp; settings</span>
              {layers && <Check size={13} className="mw-menu-check" />}
            </button>
          </div>
        </div>
      </Popover>
    </span>
  )
}
