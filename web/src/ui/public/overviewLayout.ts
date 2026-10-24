// Breakpoints of the national overview's details layout (brief 4 H3; styles/view-public.css keeps the same values).
//   below 1200 px wide          the legend moves into the Layers panel (the fire list keeps the height)
//   below 1080 px high (or 1200-1279 px wide)  the legend sits left of the fire list, which runs down to the
//                               disclaimer (the scale bar gives way below 1400 px wide there, and below 1280 px)
//   otherwise                   Main.dc.html: the legend under the fire list
export const OVERVIEW_LEGEND_IN_PANEL_QUERY = '(max-width: 1199px)'
