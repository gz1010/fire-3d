// Bottom dock (SPEC 9.4), floating left of the right panel: the timeline across the top, the three charts below it
// and the Key Events list on the right spanning both rows.
import type { Ref } from 'react'
import { FireAreaChart, ProfileChart, RosChart } from './Charts'
import { KeyEvents } from './KeyEvents'
import { Timeline } from './Timeline'

export function BottomDock({ dockRef }: { dockRef?: Ref<HTMLElement> }) {
  return (
    <section className="dock glass" ref={dockRef} aria-label="Timeline, charts and key events">
      <div className="dock-main">
        <Timeline />
        <div className="charts">
          <FireAreaChart />
          <RosChart />
          <ProfileChart />
        </div>
      </div>
      <KeyEvents />
    </section>
  )
}
