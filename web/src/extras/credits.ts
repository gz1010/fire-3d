// Map attribution entries for the optional sources (owner: optional-sources). Plain text + an https link, rendered
// by MapAttribution as React text (CONTRACT §4.4: never HTML from a source). Credits appear only while a layer is
// shown with data, next to the basemap credits.
import { imageryAttribution } from './imagery'
import type { CamerasResponse, EvacuationsResponse, ImageryProduct, ImageryResponse } from './types'

export interface ExtrasCredit {
  id: string
  text: string
  href?: string
}

/** "Evacuation zones: local officials via Cal OES" while official zones are listed (none for past dates / outages). */
export function evacuationCredits(data: EvacuationsResponse | null): ExtrasCredit[] {
  if (!data || data.status !== 'available' || data.zones.features.length === 0) return []
  const src = data.sources.find((s) => s.id === 'caloes_evacuations')
  return [{ id: 'extras-evacuations', text: 'Evacuation zones: local officials via Cal OES', href: src?.url }]
}

/** Camera locations (Cal OES) and the networks shown; the image credit itself sits next to each image. */
export function cameraCredits(data: CamerasResponse | null): ExtrasCredit[] {
  if (!data || data.status !== 'available' || data.cameras.features.length === 0) return []
  const nets = [data.counts.wildfire ? 'ALERTCalifornia | UC San Diego' : null, data.counts.traffic ? 'Caltrans' : null].filter(Boolean)
  const src = data.sources.find((s) => s.id === 'caloes_webcams')
  return [{ id: 'extras-cameras', text: `Cameras: ${nets.join(', ')} via Cal OES California Webcams`, href: src?.url }]
}

/** Credits for the satellite image on the map (see `imageryAttribution`). */
export function imageryCredits(product: ImageryProduct | null, data: ImageryResponse | null): ExtrasCredit[] {
  return imageryAttribution(product, data?.sources ?? [])
}
