// The selected-location pin (owner: map-core; CONTRACT §4.1; brief 4: the handoff's simple marker): a light-blue dot
// with a soft halo and a hairline leader to a plain mono label (the selection's label or its coordinates, then
// "SELECTED" and any notes), as in handoff-4/screens/CommandView.dc.html. A dashed halo + "approximate" when the position
// is approximate (interpolated address, estimated event location); draggable only when the selection is adjustable
// (dragend -> moveSelection). DOM text only (no HTML strings). A MapLibre Marker follows the terrain in 3D.
// The label sits up and to the right of the dot, as the screens; it moves to another corner (the leader mirrored) when
// that one would leave the free map area (the part the chrome leaves open) or cover the fire's own label
// (map/pinLabel.ts pinLabelLayout); where no corner has room for one line it stacks the coordinates (latitude, then
// longitude), as at 1024 px in Command or on a phone.
import { Marker, type Map as MapLibreMap } from 'maplibre-gl'
import type { SelectedLocation } from '../state/workspace'
import { pinLabelLayout, type PinLayout, type PinSide, type ScreenBox } from './pinLabel'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** "34.19210° N" (latitude) or "118.11234° W" (longitude). */
function fmtAxis(v: number, pos: string, neg: string, digits: number): string {
  return `${Math.abs(v).toFixed(digits)}° ${v >= 0 ? pos : neg}`
}

/** "34.19210° N, 118.11234° W" (`sep` ", "); the selected point's map label uses " · ", as the screens. */
export function fmtLatLon(lat: number, lon: number, digits = 5, sep = ', '): string {
  return `${fmtAxis(lat, 'N', 'S', digits)}${sep}${fmtAxis(lon, 'E', 'W', digits)}`
}

/** The dot, its halo and the leader to the label (24 px left of the label box), drawn around the marker's centre. */
function pinSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '84')
  svg.setAttribute('height', '84')
  svg.setAttribute('viewBox', '-42 -42 84 84')
  svg.setAttribute('aria-hidden', 'true')
  const el = (tag: string, attrs: Record<string, string>) => {
    const n = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
    return n
  }
  svg.append(
    el('circle', { r: '16', class: 'fxm-pin-halo' }),
    el('path', { d: 'M5.5 -5 L24 -23 H40', class: 'fxm-pin-leader' }),
    el('circle', { r: '6', class: 'fxm-pin-body' }),
  )
  return svg
}

export class SelectionPin {
  private readonly marker: Marker
  private readonly root: HTMLDivElement
  private readonly label: HTMLSpanElement
  private readonly note: HTMLSpanElement
  private readonly chip: HTMLDivElement
  private onMove: ((lat: number, lon: number) => void) | null = null
  private shown = false
  private layout: PinLayout = { side: 'up-right', stacked: false }
  /** the label is the coordinates (it can stack), not an address or a name */
  private coordsLabel = false

  constructor() {
    const root = document.createElement('div')
    root.className = 'fxm-pin'
    root.setAttribute('role', 'img')
    const chip = document.createElement('div')
    chip.className = 'fxm-pin-chip'
    this.label = document.createElement('span')
    this.label.className = 'fxm-pin-label'
    this.note = document.createElement('span')
    this.note.className = 'fxm-pin-note'
    chip.append(this.label, this.note)
    root.append(pinSvg(), chip)
    this.root = root
    this.chip = chip
    this.marker = new Marker({ element: root, anchor: 'center', draggable: false, opacityWhenCovered: '0.35' })
    this.marker.on('dragend', () => {
      const ll = this.marker.getLngLat()
      this.onMove?.(ll.lat, ll.lng)
    })
  }

  /** Show / update / hide the pin for a selection. */
  update(map: MapLibreMap, sel: SelectedLocation | null, visible: boolean, onMove: (lat: number, lon: number) => void): void {
    this.onMove = onMove
    if (!sel || !visible) {
      if (this.shown) this.marker.remove()
      this.shown = false
      return
    }
    const coords = fmtLatLon(sel.lat, sel.lon)
    this.coordsLabel = sel.label == null
    if (sel.label != null) this.label.textContent = sel.label
    else {
      // "39.23708° N · 106.43677° W" (the screens' separator); two parts so the label can stack them
      const lat = document.createElement('span')
      lat.className = 'fxm-pin-lat'
      lat.textContent = fmtAxis(sel.lat, 'N', 'S', 5)
      const dot = document.createElement('span')
      dot.className = 'fxm-pin-sep'
      dot.textContent = ' · '
      const lon = document.createElement('span')
      lon.className = 'fxm-pin-lon'
      lon.textContent = fmtAxis(sel.lon, 'E', 'W', 5)
      this.label.replaceChildren(lat, dot, lon)
    }
    if (!this.coordsLabel && this.layout.stacked) this.setLayout({ ...this.layout, stacked: false })
    const notes: string[] = []
    if (sel.approximate) notes.push('approximate')
    if (sel.adjusted) notes.push('adjusted')
    if (sel.adjustable && !sel.adjusted) notes.push('drag to adjust')
    this.note.textContent = ['selected', ...notes].join(' · ')
    this.root.classList.toggle('is-approx', !!sel.approximate)
    this.root.classList.toggle('is-draggable', !!sel.adjustable)
    this.root.setAttribute('aria-label', `Selected location: ${sel.label ? `${sel.label}, ` : ''}${coords}${sel.approximate ? ' (approximate)' : ''}`)
    this.root.title = sel.adjustable ? 'Drag to correct the position' : coords
    this.marker.setDraggable(!!sel.adjustable)
    this.marker.setLngLat([sel.lon, sel.lat])
    if (!this.shown) this.marker.addTo(map)
    this.shown = true
  }

  /** Put the label in the corner (one line, or the coordinates stacked) that stays inside `free` (screen px of the map
   *  container) and hides the least (`covers`: pinLabel.ts costs); call when the map settles, the safe area changes or
   *  the selection changes. */
  place(map: MapLibreMap, free: ScreenBox, covers?: (box: ScreenBox, side: PinSide) => number): void {
    if (!this.shown) return
    const was = this.layout.stacked
    const size = (stacked: boolean) => {
      this.root.classList.toggle('is-stacked', stacked)
      return { w: this.chip.offsetWidth, h: this.chip.offsetHeight }
    }
    const wide = size(false)
    const stacked = this.coordsLabel ? size(true) : null
    this.root.classList.toggle('is-stacked', was)
    if (!wide.w || !wide.h) return
    const c = map.getContainer()
    const p = map.project(this.marker.getLngLat())
    const view = { left: 0, top: 0, right: c.clientWidth, bottom: c.clientHeight }
    this.setLayout(pinLabelLayout({ x: p.x, y: p.y }, { wide, stacked }, free, this.layout, covers, view))
  }

  private setLayout(l: PinLayout): void {
    if (l.side === this.layout.side && l.stacked === this.layout.stacked) return
    this.layout = l
    this.root.classList.toggle('is-left', l.side.endsWith('left'))
    this.root.classList.toggle('is-down', l.side.startsWith('down'))
    this.root.classList.toggle('is-stacked', l.stacked)
  }

  remove(): void {
    this.marker.remove()
    this.shown = false
  }
}
