// The three Forensic charts for the Analysis drawer (owner: shell). A separate module so the drawer can load them on
// first open: ui/Charts.tsx pulls in d3 and lib/raster.ts (three.js) which the Public start-up bundle does not need.
import { FireAreaChart, ProfileChart, RosChart } from '../Charts'

export default function AnalysisCharts() {
  return (
    <div className="charts mw-drawer-charts">
      <FireAreaChart />
      <RosChart />
      <ProfileChart />
    </div>
  )
}
