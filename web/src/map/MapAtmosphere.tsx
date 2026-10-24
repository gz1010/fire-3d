// The map's atmosphere (brief 4 decision g; CONTRACT §15.1-15.2): mounted once by App.tsx's MapWorkspace (Public and
// Command only, never Forensic). One aria-hidden layer that never catches pointer events:
//   - the globe-like vignette: a circle centred on the safe area, radius half its shorter side, darker towards the
//     edges; its strength follows the zoom (--mw-vignette = clamp((zoom − 3) / 7, .25, 1)), written straight to the
//     element from a useMapRuntime subscription and only when it moves by .02 or more (no React render per frame);
//   - static per-view edge gradients behind the chrome's text, chosen by data-edges ("overview" top / bottom, "fire"
//     the left column, "command" left / right / bottom / top), with the screens' exact stops (styles/atmosphere.css).
// The layer sits inside the MapLibre map, right above the canvas: the map's own DOM overlays (the selection pin, hover
// text, other markers, popups and the provider notices) stay above the dimming and readable, and the chrome floats
// above all of it. It also applies the view's basemap tint (decision j) unless a chrome asks for another one through
// map/useMapTint.ts. Pure maths: map/atmosphere.ts.
import '../styles/atmosphere.css'
import { useEffect, useLayoutEffect, useState } from 'react'
import { useWorkspace } from '../state/workspace'
import { defaultTint, vignetteChanged, vignetteGeometry, vignetteStrength, type AtmosphereEdges } from './atmosphere'
import { useMapRuntime } from './mapStore'

export type { AtmosphereEdges } from './atmosphere'

function createLayer(): HTMLDivElement | null {
  if (typeof document === 'undefined') return null
  const el = document.createElement('div')
  el.className = 'mw-atmo'
  el.setAttribute('aria-hidden', 'true')
  return el
}

export function MapAtmosphere({ edges }: { edges: AtmosphereEdges }) {
  const [el] = useState(createLayer)
  const map = useMapRuntime((s) => s.map)
  const actions = useMapRuntime((s) => s.actions)
  const tintRequest = useMapRuntime((s) => s.tintRequest)

  // inside the map, directly above the canvas (below markers and popups, which MapLibre appends later)
  useLayoutEffect(() => {
    if (!el || !map) return
    map.getCanvas().after(el)
    return () => el.remove()
  }, [el, map])

  useLayoutEffect(() => {
    el?.setAttribute('data-edges', edges)
  }, [el, edges])

  // the vignette: strength from the zoom, centre and radius from the safe area and the map's size
  useEffect(() => {
    if (!el) return
    let strength: number | null = null
    let geo = ''
    const writeStrength = () => {
      const next = vignetteStrength(useMapRuntime.getState().camera?.zoom)
      if (!vignetteChanged(strength, next)) return
      strength = next
      el.style.setProperty('--mw-vignette', next.toFixed(3))
    }
    const writeGeometry = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (!w || !h) return
      const g = vignetteGeometry(w, h, useWorkspace.getState().safeInsets)
      const key = `${g.x}|${g.y}|${g.r}`
      if (key === geo) return
      geo = key
      el.style.setProperty('--mw-vig-x', `${g.x}px`)
      el.style.setProperty('--mw-vig-y', `${g.y}px`)
      el.style.setProperty('--mw-vig-r', `${g.r}px`)
    }
    writeStrength()
    writeGeometry()
    const unsubMap = useMapRuntime.subscribe((s, p) => {
      if (s.camera !== p.camera) writeStrength()
    })
    const unsubWs = useWorkspace.subscribe((s, p) => {
      if (s.safeInsets !== p.safeInsets) writeGeometry()
    })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(writeGeometry)
    ro?.observe(el)
    return () => {
      unsubMap()
      unsubWs()
      ro?.disconnect()
    }
  }, [el, map])

  // the basemap tint of this view, unless the chrome asked for another
  useEffect(() => {
    actions?.setTint(tintRequest ?? defaultTint(edges))
  }, [actions, tintRequest, edges])

  return null
}
