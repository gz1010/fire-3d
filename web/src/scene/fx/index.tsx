// Scene effects (SPEC 9.0 + 9.3): the parametric signature (golden lattice, telemetry) and the physical fire effects
// (smoke, embers, charred trees), plus detections, perimeters, ignition, wind, profile path and aircraft.
// Rendered inside scene-core's <Canvas>; scene-core owns the terrain, sky, camera and post-processing.
// Every layer respects store.layers (visibility + opacity), visualStyle, exaggeration and quality. Lighting and fog
// follow sceneStore.env when scene-core publishes it (defaults otherwise).
import type { IncidentAssets } from '../assets'
import { useIncidentAssets } from '../assets'
import { Aircraft } from './Aircraft'
import { Detections } from './Detections'
import { FxDriver } from './driver'
import { Embers } from './Embers'
import { Ignition } from './Ignition'
import { Lattice } from './Lattice'
import { Perimeters } from './Perimeters'
import { ProfilePath } from './ProfilePath'
import { Smoke } from './Smoke'
import { Telemetry } from './Telemetry'
import { Trees } from './Trees'
import { Overlay } from './text'
import { Wind } from './WindStreaks'

function FxLayers({ assets }: { assets: IncidentAssets }) {
  return (
    <Overlay>
      <FxDriver assets={assets} />
      <Trees assets={assets} />
      <Lattice assets={assets} />
      <Detections assets={assets} />
      <Perimeters assets={assets} />
      <ProfilePath assets={assets} />
      <Wind assets={assets} />
      <Embers assets={assets} />
      <Smoke assets={assets} />
      <Ignition assets={assets} />
      <Aircraft assets={assets} />
      <Telemetry assets={assets} />
    </Overlay>
  )
}

/** All scene effects for the current incident (renders nothing until the shared assets are ready). */
export function SceneFx() {
  const assets = useIncidentAssets()
  if (!assets) return null
  return <FxLayers key={assets.manifest.id} assets={assets} />
}

export default SceneFx
