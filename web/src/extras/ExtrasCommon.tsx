// Shared presentational pieces of the optional-source panels (owner: optional-sources): the explicit status notice
// (loading / unavailable / not available for past dates / error), legend swatches and source footers.
import { Info, RefreshCw, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import type { StatusLine } from './format'
import type { ExtrasLegendEntry } from './legend'
import { hatchSwatchCss } from './style'
import type { ExtrasSource } from './types'

export function ExtrasNotice({ line, onRetry, children }: { line: StatusLine; onRetry?: () => void; children?: ReactNode }) {
  const Icon = line.tone === 'error' || line.tone === 'warn' ? TriangleAlert : Info
  return (
    <div className={`xs-notice xs-tone-${line.tone}`} role={line.tone === 'error' ? 'alert' : 'status'}>
      <Icon size={15} aria-hidden="true" className="xs-notice-icon" />
      <div className="xs-notice-body">
        <div className="xs-notice-title">{line.title}</div>
        {line.detail && <div className="xs-notice-detail">{line.detail}</div>}
        {children}
      </div>
      {onRetry && (
        <button type="button" className="xs-icon-btn" onClick={onRetry} aria-label="Try again">
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

export function LegendSwatch({ entry }: { entry: ExtrasLegendEntry }) {
  const s = entry.swatch
  if (s.kind === 'hatch') {
    return (
      <span
        className="xs-swatch"
        aria-hidden="true"
        style={{ background: hatchSwatchCss(s.color, s.spacing), border: `2px ${s.line} ${s.color}` }}
      />
    )
  }
  if (s.kind === 'outline') return <span className="xs-swatch xs-swatch-outline" aria-hidden="true" style={{ border: `2px ${s.line} ${s.color}` }} />
  if (s.kind === 'camera') return <CameraGlyph variant={s.variant} />
  if (s.kind === 'direction') return <span className="xs-swatch xs-swatch-dir" aria-hidden="true" />
  return <span className="xs-swatch xs-swatch-raster" aria-hidden="true" />
}

/** The camera pictogram used on the map (wildfire filled, traffic outlined). */
export function CameraGlyph({ variant, size = 18 }: { variant: 'wildfire' | 'traffic'; size?: number }) {
  const filled = variant === 'wildfire'
  return (
    <svg className="xs-cam-glyph" width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <rect x="2.2" y="5.4" width="13.6" height="9.3" rx="2.2" fill="#0c0c0c" />
      <rect x="6.2" y="3" width="5.6" height="3.8" rx="1" fill="#0c0c0c" />
      <rect x="3" y="6.25" width="12" height="7.5" rx="1.6" fill={filled ? '#f0f0f0' : 'none'} stroke="#f0f0f0" strokeWidth={filled ? 0 : 1.3} />
      <rect x="6.8" y="4.4" width="4.4" height="2.4" rx="0.8" fill={filled ? '#f0f0f0' : 'none'} stroke="#f0f0f0" strokeWidth={filled ? 0 : 1.1} />
      <circle cx="9" cy="10" r="2.4" fill={filled ? '#0c0c0c' : 'none'} stroke="#f0f0f0" strokeWidth={filled ? 0 : 1.1} />
    </svg>
  )
}

export function ExtrasLegend({ entries, title }: { entries: ExtrasLegendEntry[]; title?: string }) {
  if (entries.length === 0) return null
  return (
    <ul className="xs-legend" aria-label={title ?? 'Legend'}>
      {entries.map((e) => (
        <li key={e.id}>
          <LegendSwatch entry={e} />
          <span className="xs-legend-text">
            <span className="xs-legend-label">{e.label}</span>
            {e.detail && <span className="xs-legend-detail">{e.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Source credits, licence and disclaimer as text and links (never HTML from a source). */
export function SourceFooter({ sources, extra }: { sources: ExtrasSource[]; extra?: ReactNode }) {
  if (sources.length === 0 && !extra) return null
  return (
    <footer className="xs-foot">
      {sources.map((s) => (
        <p key={s.id}>
          <a href={s.url} target="_blank" rel="noreferrer noopener">
            {s.name}
          </a>{' '}
          · {s.publisher} · {s.license}
          {s.disclaimer ? <span className="xs-foot-disclaimer"> {s.disclaimer}</span> : null}{' '}
          <a href={s.terms_url} target="_blank" rel="noreferrer noopener">
            Terms
          </a>
        </p>
      ))}
      {extra}
    </footer>
  )
}
