// The map workspace's chrome inside a fire in the Public preset: the fire view (brief 4 H4, FireView.dc.html; PLAN-4
// §3.4, decisions a, h and i; CONTRACT §15.5 "H4"). The map shows only the fire area now (map/fireProfile.ts: the
// newest perimeter, the reported location, the official layers and the other fires, dimmed); no modeled spread,
// timeline, Analysis drawer, updates feed or incident picker (all in Command: "MORE IN COMMAND ›" and the view pill).
//   top left     the round close button (X): back to all fires (history-aware, fireActions.goToOverview)
//   top centre   the place and the dates (ui/public/FireTitle.tsx), the distance chip under them
//   top right    a small cluster: the view pill, "Check an address" (the overview's centred search pill opens under
//                the title) and Layers; below 1024 px the view switch and Layers move into a menu
//   left         the hazard circle (ui/public/HazardCircle.tsx) with a leader to the reported point
//                (ui/public/ReportedPoint.tsx), then the official facts (ui/public/FireFacts.tsx) and, for a fire
//                Fire-3d has not prepared, "Prepare map data (1-3 min)" (it replaces the top notice in Public)
//   right        the location card of a picked point (its model block replaced by the Command link), the compact map
//                controls, and the map key with the scale (ui/public/FireKey.tsx)
//   bottom       a 30 px bar: the research-prototype line (left) and the credits (right, every text kept)
// Phones (decision h): bar = X, the place and dates small, search, menu; a strip with a 120 px circle and the distance
// chip; the facts in a bottom sheet whose peek shows the acres, the containment and the official line (the key inside
// it). On entry the time is the latest observation (ui/public/usePublicFireTime.ts). The map, the credits component,
// status overlays, banners, toasts and tooltips stay in App.tsx's MapWorkspace; every floating region keeps
// [data-chrome] and --chrome-side (CONTRACT §3.1). Layout: styles/view-public.css (.mw[data-view='public-fire']).
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { ImageryChip } from '../../extras/ImageryChip'
import { CommandSearch } from '../../location/CommandSearch'
import { LocationCard } from '../../location/LocationCard'
import { MapControls } from '../../map/MapControls'
import { useStore } from '../../state/store'
import { useWorkspace } from '../../state/workspace'
import { FireFacts, MapDataState } from '../public/FireFacts'
import { FireKey } from '../public/FireKey'
import { FireMenu } from '../public/FireMenu'
import { FireTitle } from '../public/FireTitle'
import { HazardCircle } from '../public/HazardCircle'
import { DistanceChip } from '../public/DistanceChip'
import { ReportedPoint } from '../public/ReportedPoint'
import { usePublicFireTime } from '../public/usePublicFireTime'
import { goToOverview } from './fireActions'
import { FixedCopy } from './FixedCopy'
import { NARROW_QUERY, useMediaQuery } from './hooks'
import { LayersPanel } from './LayersPanel'
import { TopBar, ViewPill } from './TopBar'
import { LayersPill, ShowPanelsPill } from './topBarItems'
import '../../styles/view-public.css'

/** The screen's close button: 44 px round glass with an X (the fire view has no back arrow). Back to all fires. */
function CloseFire() {
  const close = () => {
    // focus that was on the button moves to the overview's bar once it shows (keyboard users keep their place)
    const had = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('pfv-close')
    goToOverview()
    if (had)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => document.querySelector<HTMLElement>('.mw-header .tb-view-btn[aria-checked="true"], .mw-header .mw-hdr-menu')?.focus({ preventScroll: true })),
      )
  }
  return (
    <button type="button" className="tb-icon pfv-close" aria-label="Back to all fires" data-tip="Back to the overview of all fires (lower 48 states)" onClick={close}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M5 5 L19 19 M19 5 L5 19" />
      </svg>
    </button>
  )
}

/** Phones: the facts as a bottom sheet; the peek shows the acres, the containment and the official line (keyed by the
 *  fire: a new fire starts with the peek). */
function FactsSheet() {
  const [open, setOpen] = useState(false)
  return (
    <section className={`pfv-sheet${open ? ' is-open' : ''}`} data-chrome="facts" aria-label="Official information">
      <button type="button" className="pfv-sheet-toggle" aria-expanded={open} aria-controls="pfv-sheet-body" onClick={() => setOpen((o) => !o)}>
        <span className="mw-sheet-handle" aria-hidden="true" />
        <span className="mw-sr-only">{open ? 'Show less' : 'Show all official facts and the map key'}</span>
        {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}
      </button>
      <div className="pfv-sheet-body" id="pfv-sheet-body">
        {open ? (
          <>
            <FireFacts />
            <FireKey details={false} />
          </>
        ) : (
          <>
            <FireFacts peek />
            <MapDataState />
          </>
        )}
      </div>
    </section>
  )
}

export function PublicFireChrome({ credits }: { credits: ReactNode }) {
  const narrow = useMediaQuery(NARROW_QUERY)
  const wideStatus = useMediaQuery('(min-width: 1280px)')
  const collapsed = useStore((s) => s.panelsCollapsed)
  const hasSelection = useWorkspace((s) => s.selection != null)
  const incidentId = useStore((s) => s.incidentId)
  const circle = useRef<HTMLButtonElement | null>(null)
  usePublicFireTime()
  return (
    <>
      <TopBar
        className="mw-header pfv-bar"
        data-chrome="header"
        left={
          <>
            <CloseFire />
            {narrow && <FireTitle chip={false} compact />}
          </>
        }
        right={
          <>
            <ShowPanelsPill />
            <ViewPill size="sm" className="mw-wide-only" />
            <CommandSearch variant="pill" />
            <LayersPill />
            <FireMenu />
          </>
        }
      />
      {!narrow && (
        <div className="pfv-title-slot" data-chrome="title">
          <FireTitle />
        </div>
      )}
      {/* the reported point and the circle's leader: over the map, under the chrome */}
      <ReportedPoint circle={circle} leader={!narrow && !collapsed} />
      <div className="mw-layers-slot" data-chrome="layers">
        <LayersPanel />
      </div>
      <div className="mw-top pfv-top">
        {narrow ? (
          <div className="pfv-strip" data-chrome="strip">
            <HazardCircle ref={circle} compact />
            <DistanceChip compact />
          </div>
        ) : (
          <div className="pfv-left">
            <div className="pfv-circle-slot" data-chrome="circle">
              <HazardCircle ref={circle} />
            </div>
            <div className="pfv-facts-slot" data-chrome="facts">
              <FireFacts />
            </div>
          </div>
        )}
        <div className="pfv-right">
          {/* the newest satellite image's status line (the same actions as Command's), under the cluster */}
          {wideStatus && !collapsed && (
            <div className="pfv-status" data-chrome="imagery">
              <ImageryChip variant="status" />
            </div>
          )}
          <div className={`mw-card pfv-card${hasSelection ? '' : ' is-empty'}`} data-chrome="card">
            <LocationCard />
          </div>
        </div>
        <div className="pfv-right-bottom">
          <div className="mw-controls pfv-cluster" data-chrome="controls">
            <MapControls variant="compact" />
          </div>
          {!narrow && (
            <div className="pfv-key-slot" data-chrome="key">
              <FireKey />
            </div>
          )}
        </div>
      </div>
      <div className="mw-bottom pfv-bottom">
        {narrow && <FactsSheet key={incidentId ?? ''} />}
        <div className="pfv-foot">
          <div className="mw-note pfv-note" data-chrome="note">
            {/* the bar's line alone: the facts (and the phones' peek) end with "Not an all-clear. Follow local officials." */}
            <FixedCopy variant="bar" />
          </div>
          {credits}
        </div>
      </div>
    </>
  )
}
