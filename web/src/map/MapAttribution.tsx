// Required map credits as plain text links, and the scale bar (owner: map-core; CONTRACT §4.4). MapLibre's
// AttributionControl stays disabled: it injects provider HTML through a sanitizer with a known bypass
// (GHSA-jrc7-96c5-q579, maplibre-gl <= 6.4.0). Credits follow what is actually drawn (activeCredits), plus the
// optional sources while their layers show data (extras/credits.ts, CONTRACT §12.5), and "Weather data by
// Open-Meteo.com" (CC BY 4.0) while the incident's weather or forecast comes from Open-Meteo: the forecast overlay,
// the location card's wind and the updates feed all show values derived from it.
import { useExtrasCredits } from '../extras/runtime'
import { weatherCredits } from '../lib/dataCredits'
import { useStore } from '../state/store'
import { useWorkspace } from '../state/workspace'
import { metersPerPixel, useMapRuntime } from './mapStore'
import { activeCredits } from './providers'
import { niceScale } from './scale'

/** Scale bar at the map centre (its own slot on the map, so the credits keep a single line at 1440 px). */
export function ScaleBar() {
  const camera = useMapRuntime((s) => s.camera)
  const units = useWorkspace((s) => s.units)
  if (!camera) return null
  const s = niceScale(metersPerPixel(camera.lat, camera.zoom), units, 90)
  const tilted = camera.pitch > 1
  return (
    <span className="fxm-scale" title={tilted ? 'Scale at the map centre (the view is tilted)' : 'Scale'} aria-label={`Scale: ${s.label}${tilted ? ' at the map centre' : ''}`} role="img">
      <span className="fxm-scale-bar" style={{ width: `${Math.round(s.px)}px` }} aria-hidden="true" />
      <span className="fxm-scale-label mw-mono" aria-hidden="true">
        {s.label}
      </span>
    </span>
  )
}

export function MapAttribution() {
  const basemap = useWorkspace((s) => s.basemap)
  const perspective = useWorkspace((s) => s.perspective)
  const vectorOk = useMapRuntime((s) => s.providers.basemap.state !== 'failed')
  const terrainOk = useMapRuntime((s) => s.providers.terrain.state !== 'failed')
  const imageryOk = useMapRuntime((s) => s.providers.imagery.state !== 'failed')
  const extras = useExtrasCredits()
  const weatherSource = useStore((s) => (s.manifest?.status === 'ready' ? s.weather?.source : null) ?? null)
  const forecastWeather = useStore((s) => s.forecast?.weather.source ?? null)
  const items = [...activeCredits(basemap, perspective, { vectorOk, terrainOk, imageryOk }), ...weatherCredits(weatherSource, forecastWeather), ...extras]
  return (
    <div className="mw-attrib fxm-attrib">
      <span className="fxm-credits">
        {items.map((a, i) => (
          <span key={a.id}>
            {i > 0 && ' · '}
            {a.href?.startsWith('https://') ? (
              <a href={a.href} target="_blank" rel="noreferrer noopener">
                {a.text}
              </a>
            ) : (
              a.text
            )}
          </span>
        ))}
      </span>
    </div>
  )
}
