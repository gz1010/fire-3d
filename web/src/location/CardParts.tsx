// Pieces shared by the location card and the overview card (owner: location): kind tags, the card frame (header,
// close / centre actions, yielding to the search popover) and the official block (brief 2 C-R7).
import { Crosshair, ExternalLink, MapPin, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { useWorkspace, type SelectedLocation } from '../state/workspace'
import type { LineKind } from './describe'
import type { OfficialBlock, OfficialLine } from './official'
import { cardYield, useSearchUi } from './searchUi'
import { useNarrow } from './useNarrow'

export function KindTag({ kind }: { kind: LineKind }) {
  if (!kind) return null
  return <span className={`loc-kind is-${kind.toLowerCase().replace(/\s+/g, '-')}`}>{kind}</span>
}

/** The card moves out of the search popover's way (searchUi.ts): pushed down on desktop, a shorter sheet on phones. */
function useYieldToSearch(ref: RefObject<HTMLElement | null>, sheet: boolean): CSSProperties | undefined {
  const pop = useSearchUi((s) => s.popover)
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined)
  useLayoutEffect(() => {
    const el = ref.current
    const slot = el?.parentElement
    if (!el || !slot || !pop) {
      setStyle(undefined)
      return
    }
    const r = slot.getBoundingClientRect()
    const y = cardYield(pop, { top: r.top, bottom: r.bottom }, el.scrollHeight, sheet)
    setStyle(!y ? undefined : 'marginTop' in y ? { marginTop: y.marginTop } : 'maxHeight' in y ? { maxHeight: y.maxHeight } : { visibility: 'hidden' })
  }, [pop, sheet, ref])
  return style
}

/** Header, close / centre actions and the yielding behaviour shared by the fire card and the overview card. */
/** The point's coordinates are not repeated here: the coordinate strip always shows them, with copy buttons. */
export function CardFrame(props: { sel: SelectedLocation; title: string; titleIsCoords: boolean; type: string; approximate: boolean; command: boolean; children: ReactNode }) {
  const { sel, title, titleIsCoords, type, approximate, command, children } = props
  const clear = useWorkspace((s) => s.clearSelection)
  const narrow = useNarrow()
  const ref = useRef<HTMLElement | null>(null)
  const style = useYieldToSearch(ref, narrow)
  const center = () => useWorkspace.getState().requestMapFlyTo({ lon: sel.lon, lat: sel.lat })
  return (
    <section ref={ref} className={`mw-panel loc-card${command ? ' is-command' : ''}`} style={style} aria-label="Location check">
      <div className="mw-sheet-handle" aria-hidden="true" />
      <header className="loc-card-head">
        <MapPin size={16} className="loc-card-pin" aria-hidden="true" />
        <div className="loc-card-titles">
          <h2 className={`loc-card-title${titleIsCoords ? ' mw-mono' : ''}`}>{title}</h2>
          {/* the pin's own label says "approximate · drag to adjust" */}
          <p className="loc-card-type">
            {approximate && <span className="loc-kind is-approximate">Approximate</span>} {type}
          </p>
        </div>
        <div className="loc-card-actions">
          <button type="button" className="mw-icon-btn is-sm" aria-label="Center the map on this location" title="Center the map here" onClick={center}>
            <Crosshair size={13} />
          </button>
          <button type="button" className="mw-icon-btn is-sm" aria-label="Close the location check" title="Close" onClick={clear}>
            <X size={14} />
          </button>
        </div>
      </header>
      {children}
    </section>
  )
}

/** Brief 3 (§14.14): the point is not covered (Alaska, Hawaii, territories, outside the US), from /api/geo/lookup. */
export function CoverageNotice({ text }: { text: string }) {
  return (
    <p className="loc-coverage" role="note">
      {text}
    </p>
  )
}

/** "Issuer's link" from a line's `urlLabel` ("issuer's link", "source record (NWS)", "source record (FEMA archive)"),
 *  else "Read it". */
function officialLinkLabel(l: Pick<OfficialLine, 'urlLabel'>): string {
  const t = l.urlLabel?.trim()
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Read it'
}

/** Block 2: official information. Always at least one evacuation line; then `block.fireWeather` as it is, which since
 *  brief 3 (CONTRACT §14.7) carries the NWS status line at every point (alerts in effect here, "none in effect here" or
 *  "not checked here") followed by the local officials' alert lines (relayed by NWS or archived by FEMA). Each line
 *  keeps its issuer, its own time and its link, labelled by what it is (`urlLabel`). */
export function OfficialSection({ block, compact }: { block: OfficialBlock; compact: boolean }) {
  const evac = compact ? block.evacuation.slice(0, 1) : block.evacuation
  return (
    <section className="loc-block loc-official" aria-label="Official information">
      <h3 className="loc-block-title">Official information</h3>
      <ul className="loc-official-list">
        {[...evac, ...block.fireWeather].map((l) => (
          <li key={l.key} className={`loc-official-line is-${l.tone}`}>
            <p className="loc-official-text">
              {l.official && <KindTag kind="Official" />} <span>{l.text}</span>
            </p>
            {/* phones keep the issuer, the source's own time, the caveats and the source link */}
            {(compact ? l.subCompact || l.url : l.sub || l.url) && (
              <p className="loc-official-sub">
                {compact ? l.subCompact : l.sub}
                {l.url && (
                  <>
                    {(compact ? l.subCompact : l.sub) ? ' · ' : ''}
                    <a className="loc-link" href={l.url} target="_blank" rel="noopener noreferrer">
                      {officialLinkLabel(l)} <ExternalLink size={11} aria-hidden="true" />
                    </a>
                  </>
                )}
              </p>
            )}
          </li>
        ))}
        {block.moreZones > 0 && !compact && <li className="loc-official-more">+{block.moreZones} more zones listed here (see Updates)</li>}
      </ul>
      <p className="loc-follow">
        <strong>{block.follow}</strong>{' '}
        {block.links.slice(0, compact ? 2 : 3).map((l, i) => (
          <span key={l.url}>
            {i > 0 && ' · '}
            <a className="loc-link" href={l.url} target="_blank" rel="noopener noreferrer">
              {l.label}
            </a>
          </span>
        ))}
      </p>
    </section>
  )
}

export function StaleChip() {
  return (
    <span className="loc-stale" title="The newest fire observation is more than 6 hours old: check the time before relying on it">
      Stale
    </span>
  )
}
