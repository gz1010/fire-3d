// The map's atmosphere layer (brief 4 decision g; CONTRACT §15.1-15.2): one aria-hidden, pointer-events:none layer
// mounted once by App.tsx's MapWorkspace between the map and the chrome. `edges` (chosen by the active chrome) selects
// the static per-view edge gradients behind text: "overview" (top / bottom + radial), "fire" (left column), "command"
// (left, right, bottom, top). The globe-like vignette that follows the zoom (--mw-vignette, --mw-vig-x/-y/-r on
// .mw-atmo) and the gradients themselves are styles/atmosphere.css.
// H2a (foundation) mounts this stub with no visual effect; H2c fills it in.
import '../styles/atmosphere.css'

export type AtmosphereEdges = 'overview' | 'fire' | 'command'

export function MapAtmosphere({ edges }: { edges: AtmosphereEdges }) {
  return <div className="mw-atmo" data-edges={edges} aria-hidden="true" />
}
