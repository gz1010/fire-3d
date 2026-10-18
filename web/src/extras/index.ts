// Public API of the optional sources (owner: optional-sources; CONTRACT "Optional sources"): official evacuation
// zones, public cameras and recently acquired satellite imagery. Import panels from their .tsx files and the CSS
// from './extras.css' where they are mounted.
export * from './types'
export {
  apiPath,
  areaParams,
  DEFAULT_MARGIN_KM,
  EXTRAS_PAST_TOLERANCE_MS,
  expandBbox,
  extrasAtMs,
  extrasUrl,
  fetchCameraFrame,
  fetchCameras,
  fetchEvacuations,
  fetchExtrasSources,
  fetchImagery,
  incidentAreaBbox,
  isPastForCurrentSources,
  type AreaQuery,
  type BBox,
  type ExtrasKind,
  type ImageryQuery,
} from './client'
export { REFRESH_MS, useCameraFrame, useCameras, useEvacuations, useImagery, type CameraFrameState, type ExtrasQueryState } from './hooks'
export {
  EVAC_LAYERS,
  EVAC_SOURCE,
  evacStatusCounts,
  evacuationFeedItems,
  evacuationLegend,
  mountEvacuationLayer,
  statusText,
  zoneDetail,
  zonesAtPoint,
  zonesBounds,
  zonesCentre,
  type EvacuationLayerHandle,
} from './evacuation'
export {
  CAMERA_INTERACTIVE_LAYERS,
  CAMERA_LAYERS,
  cameraFeedItems,
  cameraLegend,
  cameraServiceText,
  cameraViewText,
  frameTimeText,
  mountCameraLayer,
  sortCameras,
  type CameraLayerHandle,
} from './cameras'
export {
  cloudText,
  coverageText,
  DEFAULT_IMAGERY_OPACITY,
  FAMILY_LABEL,
  IMAGERY_DISTINCTION,
  IMAGERY_LAYER,
  IMAGERY_SOURCE,
  imageryAttribution,
  imageryFeedItems,
  imageryLegend,
  imageryTiming,
  mountImageryLayer,
  pickDefaultImagery,
  productsByFamily,
  REPROCESSED_AFTER_MS,
  resolutionText,
  shownPixelM,
  type ImageryCredit,
  type ImageryLayerHandle,
} from './imagery'
export { firstSymbolLayerId, resolveBeforeId, type BeforeId, type LayerHandleOptions } from './mapLayers'
export { cameraCredits, evacuationCredits, imageryCredits, type ExtrasCredit } from './credits'
export type { ExtrasLayerKey, ExtrasLegendEntry, LegendSwatch } from './legend'
export { EXTRAS_COLORS } from './style'
