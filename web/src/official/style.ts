// Colours and line styles of the official map layers (owner: official-web), shared by the map layer and the legend.
// MapLibre paint cannot read CSS variables, so they are literals here.

/** NWS-style colours (Red Flag Warning pink: the handoff's alert colour #ee7aa0 = --m-alert, brief 4; Fire Weather
 *  Watch navajo white), lightened for dark basemaps and drawn as outlines only, so they never read as an evacuation
 *  zone (cross-hatched fill) or as fire. */
export const OFFICIAL_COLORS = {
  redFlag: '#ee7aa0', // --m-alert
  fireWeatherWatch: '#ffdcae',
  casing: 'rgba(10,10,10,0.85)',
  /** The light casing under the unselected NWS outlines: just enough to keep a thin line legible on aerial photos. */
  fwCasing: 'rgba(10,10,10,0.5)',
  highlight: '#ffffff',
  highlightFill: 'rgba(255,255,255,0.10)',
  /** A selected NWS alert's zones: its own colour, faintly filled (never a heavy white outline over a large zone). */
  fwHighlightFill: 'rgba(238,122,160,0.07)',
  fwWatchHighlightFill: 'rgba(255,220,174,0.07)',
} as const

/** Outline styles (map + legend): warnings dashed, watches dotted. Thin: NWS fire weather zones are large (a Red Flag
 *  Warning can cover a whole county), so their outlines cross the map and must stay quieter than the fire layers. */
export const FW_LINE = {
  warning: { width: 1.4, dash: [4, 3] as number[], style: 'dashed' as const },
  watch: { width: 1.2, dash: [1.5, 2.2] as number[], style: 'dotted' as const },
}

/** Opacity of the unselected NWS outlines by zoom: legible on the overview, fading as the view closes in on a fire
 *  (the fire layers stay the most prominent element). A selected alert is drawn at full strength. */
export const FW_OPACITY = ['interpolate', ['linear'], ['zoom'], 6, 0.85, 9, 0.7, 12, 0.5, 14, 0.4] as const
