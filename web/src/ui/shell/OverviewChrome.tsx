// The map workspace's chrome with no fire open: the national overview of the lower 48, in both presets (brief 4 H2a;
// CONTRACT §15.2). H2a moved today's overview layout here verbatim and converted its header to the floating top bar
// (logo, "United States · all fires", the view pill, Layers, the compact menu). H3+H4 restyle it (Public minimal /
// details, Command overview). The map, credits component, status overlays, banners, toasts and tooltips stay in
// App.tsx's MapWorkspace; every floating region keeps [data-chrome] and --chrome-side (CONTRACT §3.1).
import type { ReactNode } from 'react'
import { ImageryChip } from '../../extras/ImageryChip'
import { CoordinateStrip } from '../../location/CoordinateStrip'
import { LocationCard } from '../../location/LocationCard'
import { SearchBox } from '../../location/SearchBox'
import { ScaleBar } from '../../map/MapAttribution'
import { MapControls } from '../../map/MapControls'
import { MapLegend } from '../../map/MapLegend'
import { CoordsSlot } from './CoordsSlot'
import { FireCard } from './FireCard'
import { FixedCopy } from './FixedCopy'
import { useMediaQuery, WIDE_QUERY } from './hooks'
import { LayersPanel } from './LayersPanel'
import { OverviewPanel } from './OverviewPanel'
import { TopBar, TopBarBrand, ViewPill } from './TopBar'
import { CompactMenu, LayersPill, LOWER48_TIP, ShowPanelsPill } from './topBarItems'

export function OverviewChrome({ credits }: { credits: ReactNode }) {
  const wide = useMediaQuery(WIDE_QUERY)
  return (
    <>
      <TopBar
        className="mw-header"
        data-chrome="header"
        left={
          <>
            <TopBarBrand />
            <span className="tb-sep" aria-hidden="true" />
            <h1 className="mw-hdr-title" data-tip={LOWER48_TIP}>
              United States <span className="mw-hdr-title-sub">· all fires</span>
            </h1>
          </>
        }
        centre={<ViewPill className="mw-wide-only" />}
        right={
          <>
            <ShowPanelsPill />
            <LayersPill />
            <CompactMenu />
          </>
        }
      />
      <div className="mw-layers-slot" data-chrome="layers">
        <LayersPanel />
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
        {/* the satellite chip: in the top bar on wide screens (fire chromes), else here next to the map controls */}
        <div className="mw-imagery" data-chrome="imagery">
          {!wide && <ImageryChip />}
        </div>
        <div className="mw-controls" data-chrome="controls">
          <MapControls />
        </div>
        <aside className="mw-updates" id="mw-updates" data-chrome="updates" aria-label="Fires in the lower 48">
          <OverviewPanel />
        </aside>
      </div>
      <div className="mw-scale-slot" data-chrome="scale">
        <ScaleBar />
      </div>
      <div className="mw-bottom">
        <CoordsSlot>
          <CoordinateStrip />
        </CoordsSlot>
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
