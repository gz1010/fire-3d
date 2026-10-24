// The map workspace's chrome inside a fire in the Command preset (brief 4, CommandView.dc.html; PLAN-4 §3.2; CONTRACT
// §15.2, frozen after H2). No panels on the map by default: text on the edge gradients (map/MapAtmosphere.tsx).
//   top bar      back, the fire's name (the incident picker), LIVE / year, place, demo badge · the view pill · the
//                satellite status line, "Show panels", Updates (phones), Analysis, Check an address (the search in a
//                popover), Layers, the compact menu (< 1024 px)
//   left         the readout (location/CommandReadout.tsx): the selected point, its check, the record rows; the fire
//                card of another fire floats in its place while open
//   right        "Official now" as one-line rows that expand; "View all updates" opens the full panel
//   bottom       the map controls bar (left) and the legend chips with the scale (right), the slim full-width timeline,
//                the fixed copy and the credits
// Phones: the readout is a bottom sheet with a one-line peek, "Official now" the Updates sheet, the timeline full width,
// the legend in the Layers sheet and the map controls under the bar as before. The map, the credits component, status
// overlays, banners, toasts and tooltips stay in App.tsx's MapWorkspace; every floating region keeps [data-chrome] and
// --chrome-side (CONTRACT §3.1). Positions: styles/view-command.css.
import type { ReactNode } from 'react'
import { ImageryChip } from '../../extras/ImageryChip'
import { useExtrasFeedItems } from '../../extras/runtime'
import { CommandReadout } from '../../location/CommandReadout'
import { CommandSearch } from '../../location/CommandSearch'
import { ScaleBar } from '../../map/MapAttribution'
import { MapControls } from '../../map/MapControls'
import { MapLegend } from '../../map/MapLegend'
import { useStore } from '../../state/store'
import { UpdatesFeed } from '../feed/UpdatesFeed'
import { IncidentPicker } from '../IncidentPicker'
import { CompactTimeline } from '../timeline/CompactTimeline'
import { AnalysisDrawer } from './AnalysisDrawer'
import { useFireBarInfo } from './fireBarInfo'
import { FireCard } from './FireCard'
import { FixedCopy } from './FixedCopy'
import { NARROW_QUERY, useMediaQuery, useOverflowing } from './hooks'
import { LayersPanel } from './LayersPanel'
import { LiveDot, TopBar, TopBarPlace, ViewPill } from './TopBar'
import { AllFiresBack, AnalysisPill, CompactMenu, DemoBadge, LayersPill, ShowPanelsPill, UpdatesToggle } from './topBarItems'
import { UpdatesPanel } from './UpdatesPanel'
import '../../styles/view-command.css'

export function CommandFireChrome({ credits }: { credits: ReactNode }) {
  const narrow = useMediaQuery(NARROW_QUERY)
  const collapsed = useStore((s) => s.panelsCollapsed)
  const extraItems = useExtrasFeedItems()
  const bar = useFireBarInfo()
  // the readout scrolls on short windows: its bottom edge fades while more is below
  const [cardRef, cardOver] = useOverflowing<HTMLDivElement>(!narrow)
  return (
    <>
      <TopBar
        className="mw-header"
        data-chrome="header"
        left={
          <>
            <AllFiresBack />
            <IncidentPicker variant="title" />
            <LiveDot live={bar.live} year={bar.year} />
            <TopBarPlace place={bar.place} />
            {bar.demo && <DemoBadge />}
          </>
        }
        centre={<ViewPill className="mw-wide-only" />}
        right={
          <>
            {!narrow && !collapsed && (
              <span className="cmd-status">
                <ImageryChip variant="status" />
              </span>
            )}
            <ShowPanelsPill />
            <UpdatesToggle />
            <AnalysisPill />
            <CommandSearch />
            <LayersPill />
            <CompactMenu />
          </>
        }
      />
      <div className="mw-layers-slot" data-chrome="layers">
        <LayersPanel />
      </div>
      <div className="mw-drawer-slot" data-chrome="analysis">
        <AnalysisDrawer />
      </div>
      <div className="mw-top cmd-top">
        <div className="mw-firecard" data-chrome="firecard">
          <FireCard />
        </div>
        <div ref={cardRef} className={`mw-card cmd-readout-slot${cardOver && !narrow ? ' is-overflowing' : ''}`} data-chrome="card">
          <CommandReadout />
        </div>
        {narrow && (
          <>
            <div className="mw-imagery" data-chrome="imagery">
              <ImageryChip variant="status" />
            </div>
            <div className="mw-controls" data-chrome="controls">
              <MapControls />
            </div>
          </>
        )}
        <aside className="mw-updates" id="mw-updates" data-chrome="updates" aria-label="Incident updates">
          <UpdatesPanel>
            <UpdatesFeed extraItems={extraItems} />
          </UpdatesPanel>
        </aside>
      </div>
      {narrow && (
        <div className="mw-scale-slot" data-chrome="scale">
          <ScaleBar />
        </div>
      )}
      <div className="mw-bottom cmd-bottom">
        {!narrow && (
          <div className="cmd-row">
            <div className="mw-controls cmd-controls" data-chrome="controls">
              <MapControls />
            </div>
            <div className="mw-legend-slot cmd-legend" data-chrome="legend">
              <MapLegend variant="chips" />
            </div>
          </div>
        )}
        <div className="mw-timeline cmd-timeline" id="mw-timeline" data-chrome="timeline">
          <CompactTimeline variant="slim" />
        </div>
        <div className="cmd-foot">
          <div className="mw-note cmd-note" data-chrome="note">
            <FixedCopy variant="corner" />
          </div>
          {credits}
        </div>
      </div>
    </>
  )
}
