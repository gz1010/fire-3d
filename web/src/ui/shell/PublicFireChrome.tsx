// The map workspace's chrome inside a fire in the Public preset (brief 4 H2a; CONTRACT §15.2). H2a moved today's
// Public-in-a-fire layout here verbatim and converted its header to the floating top bar (back, the fire's name as
// the incident picker, LIVE / year, place; the view pill; the satellite chip, Updates (phones), Analysis, Layers and
// the compact menu). H3+H4 rebuild it as the fire view (FireView.dc.html). The map, credits component, status
// overlays, banners, toasts and tooltips stay in App.tsx's MapWorkspace; every floating region keeps [data-chrome]
// and --chrome-side (CONTRACT §3.1).
import type { ReactNode } from 'react'
import { ImageryChip } from '../../extras/ImageryChip'
import { useExtrasFeedItems } from '../../extras/runtime'
import { CoordinateStrip } from '../../location/CoordinateStrip'
import { LocationCard } from '../../location/LocationCard'
import { SearchBox } from '../../location/SearchBox'
import { ScaleBar } from '../../map/MapAttribution'
import { MapControls } from '../../map/MapControls'
import { MapLegend } from '../../map/MapLegend'
import { useStore } from '../../state/store'
import { UpdatesFeed } from '../feed/UpdatesFeed'
import { IncidentPicker } from '../IncidentPicker'
import { CompactTimeline } from '../timeline/CompactTimeline'
import { AnalysisDrawer } from './AnalysisDrawer'
import { CoordsSlot } from './CoordsSlot'
import { useFireBarInfo } from './fireBarInfo'
import { FireCard } from './FireCard'
import { FixedCopy } from './FixedCopy'
import { useMediaQuery, WIDE_QUERY } from './hooks'
import { LayersPanel } from './LayersPanel'
import { LiveDot, TopBar, TopBarPlace, ViewPill } from './TopBar'
import { AllFiresBack, AnalysisPill, CompactMenu, DemoBadge, LayersPill, ShowPanelsPill, UpdatesToggle } from './topBarItems'
import { UpdatesPanel } from './UpdatesPanel'

export function PublicFireChrome({ credits }: { credits: ReactNode }) {
  const wide = useMediaQuery(WIDE_QUERY)
  const collapsed = useStore((s) => s.panelsCollapsed)
  const extraItems = useExtrasFeedItems()
  const bar = useFireBarInfo()
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
          </>
        }
        centre={<ViewPill className="mw-wide-only" />}
        right={
          <>
            {bar.demo && <DemoBadge />}
            {wide && !collapsed && (
              <span className="mw-hdr-chip">
                <ImageryChip />
              </span>
            )}
            <ShowPanelsPill />
            <UpdatesToggle />
            <AnalysisPill />
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
      <div className="mw-top">
        <div className="mw-search" id="mw-search" data-chrome="search">
          <SearchBox />
        </div>
        <div className="mw-firecard" data-chrome="firecard">
          <FireCard />
        </div>
        <div className="mw-card" data-chrome="card">
          <LocationCard />
        </div>
        {/* the satellite chip: in the top bar on wide screens, else here next to the map controls */}
        <div className="mw-imagery" data-chrome="imagery">
          {!wide && <ImageryChip />}
        </div>
        <div className="mw-controls" data-chrome="controls">
          {/* the fire view's compact cluster (brief 4 H3, CONTRACT 15.5: zoom ±, ⟲ compass ⟳); H4 places it */}
          <MapControls variant="compact" />
        </div>
        <aside className="mw-updates" id="mw-updates" data-chrome="updates" aria-label="Incident updates">
          <UpdatesPanel>
            <UpdatesFeed extraItems={extraItems} />
          </UpdatesPanel>
        </aside>
      </div>
      <div className="mw-scale-slot" data-chrome="scale">
        <ScaleBar />
      </div>
      <div className="mw-bottom">
        <CoordsSlot>
          <CoordinateStrip />
        </CoordsSlot>
        <div className="mw-timeline" id="mw-timeline" data-chrome="timeline">
          <CompactTimeline />
        </div>
        <div className="mw-legend-slot" data-chrome="legend">
          <MapLegend />
        </div>
        <div className="mw-note" data-chrome="note">
          <FixedCopy variant="pill" extra={null} />
        </div>
        {credits}
      </div>
    </>
  )
}
