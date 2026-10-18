// The selected-location pin (owner: map-core; CONTRACT §4.1): cyan, labelled with the selection's label or its
// coordinates, a dashed ring + "approximate" when the position is approximate (interpolated address, estimated event
// location), draggable only when the selection is adjustable (dragend -> moveSelection). DOM text only (no HTML
// strings). A MapLibre Marker follows the terrain in 3D.
import { Marker, type Map as MapLibreMap } from 'maplibre-gl'
import type { SelectedLocation } from '../state/workspace'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** "34.19210° N, 118.11234° W" */
export function fmtLatLon(lat: number, lon: number, digits = 5): string {
  return `${Math.abs(lat).toFixed(digits)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(digits)}° ${lon >= 0 ? 'E' : 'W'}`
}

function pinSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '26')
  svg.setAttribute('height', '34')
  svg.setAttribute('viewBox', '0 0 26 34')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', 'M13 1.5C6.6 1.5 1.5 6.5 1.5 12.8c0 8.3 9.6 18 10.7 19.1a1.1 1.1 0 0 0 1.6 0c1.1-1.1 10.7-10.8 10.7-19.1C24.5 6.5 19.4 1.5 13 1.5z')
  path.setAttribute('class', 'fxm-pin-body')
  const dot = document.createElementNS(SVG_NS, 'circle')
  dot.setAttribute('cx', '13')
  dot.setAttribute('cy', '12.8')
  dot.setAttribute('r', '4.2')
  dot.setAttribute('class', 'fxm-pin-dot')
  svg.append(path, dot)
  return svg
}

export class SelectionPin {
  private readonly marker: Marker
  private readonly root: HTMLDivElement
  private readonly label: HTMLSpanElement
  private readonly note: HTMLSpanElement
  private onMove: ((lat: number, lon: number) => void) | null = null
  private shown = false

  constructor() {
    const root = document.createElement('div')
    root.className = 'fxm-pin'
    root.setAttribute('role', 'img')
    const ring = document.createElement('div')
    ring.className = 'fxm-pin-ring'
    const chip = document.createElement('div')
    chip.className = 'fxm-pin-chip'
    this.label = document.createElement('span')
    this.label.className = 'fxm-pin-label'
    this.note = document.createElement('span')
    this.note.className = 'fxm-pin-note'
    chip.append(this.label, this.note)
    root.append(ring, pinSvg(), chip)
    this.root = root
    this.marker = new Marker({ element: root, anchor: 'bottom', offset: [0, 2], draggable: false, opacityWhenCovered: '0.35' })
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
    this.label.textContent = sel.label ?? coords
    const notes: string[] = []
    if (sel.approximate) notes.push('approximate')
    if (sel.adjusted) notes.push('adjusted')
    if (sel.adjustable && !sel.adjusted) notes.push('drag to adjust')
    this.note.textContent = notes.length ? notes.join(' · ') : ''
    this.note.hidden = notes.length === 0
    this.root.classList.toggle('is-approx', !!sel.approximate)
    this.root.classList.toggle('is-draggable', !!sel.adjustable)
    this.root.setAttribute('aria-label', `Selected location: ${sel.label ? `${sel.label}, ` : ''}${coords}${sel.approximate ? ' (approximate)' : ''}`)
    this.root.title = sel.adjustable ? 'Drag to correct the position' : coords
    this.marker.setDraggable(!!sel.adjustable)
    this.marker.setLngLat([sel.lon, sel.lat])
    if (!this.shown) this.marker.addTo(map)
    this.shown = true
  }

  remove(): void {
    this.marker.remove()
    this.shown = false
  }
}
