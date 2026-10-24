// The selected-location pin (owner: map-core; CONTRACT §4.1; brief 4: the handoff's simple marker): a light-blue dot
// with a soft halo and a hairline leader to a plain mono label (the selection's label or its coordinates, then
// "SELECTED" and any notes), as in handoff-4/screens/CommandView.dc.html. A dashed halo + "approximate" when the position
// is approximate (interpolated address, estimated event location); draggable only when the selection is adjustable
// (dragend -> moveSelection). DOM text only (no HTML strings). A MapLibre Marker follows the terrain in 3D.
import { Marker, type Map as MapLibreMap } from 'maplibre-gl'
import type { SelectedLocation } from '../state/workspace'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** "34.19210° N, 118.11234° W" */
export function fmtLatLon(lat: number, lon: number, digits = 5): string {
  return `${Math.abs(lat).toFixed(digits)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(digits)}° ${lon >= 0 ? 'E' : 'W'}`
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
  private onMove: ((lat: number, lon: number) => void) | null = null
  private shown = false

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
    this.label.textContent = sel.label ?? coords
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

  remove(): void {
    this.marker.remove()
    this.shown = false
  }
}
