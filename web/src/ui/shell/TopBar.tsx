// The floating top bar of every view (brief 4, HANDOFF "Top bar, floating"; CONTRACT §15.2, frozen after H2). No
// full-width bar: three slots float over the dimmed map: left (back, logo, event name + LIVE, place in grey), centre
// (the Public · Command · Forensic pill) and right (data-source status in mono, round icon buttons). The sides are
// `flex: 1 1 0`, so the centre pill stays centred whatever the sides hold. The bar lets map drags through the empty
// space between its items. Styles: styles/topbar.css (exact values from handoff-4/screens/*.dc.html).
//   TopBar        the bar (a <header>); extra props (data-chrome, id, ...) go to its root
//   TopBarBrand   logo + "Fire-3d"
//   ViewPill      the view switch (views.ts applyView): radio buttons, the active one accent orange with dark ink
//   BackButton    36 px round glass button, "Back to all fires"
//   LiveDot       "● LIVE" in mono, or the fire's year as a chip
//   IconPill      36 px round glass icon button; its label is the accessible name (visually hidden) and the tooltip
//   TopBarStatus  mono status text ("VIIRS NOAA · 375 M · 6.2 H AGO"), the stale part amber
//   TopBarPlace   the place (and optional date) in grey
import { Fragment, type HTMLAttributes, type ReactNode, type Ref } from 'react'
import { useWorkspace } from '../../state/workspace'
import { Logo } from '../Logo'
import { statusSegments } from './topBarText'
import { applyView, VIEWS, viewOf } from './views'
import '../../styles/topbar.css'

export type TopBarInset = 'map' | 'forensic'

/** The floating bar. `inset` sets the side margin (map 28 px, Forensic 20 px; phones 8 px). */
export function TopBar({
  left,
  centre,
  right,
  className,
  inset = 'map',
  ...rest
}: { left: ReactNode; centre?: ReactNode; right?: ReactNode; className?: string; inset?: TopBarInset } & Omit<HTMLAttributes<HTMLElement>, 'children'>) {
  return (
    <header className={`tb tb-inset-${inset}${className ? ` ${className}` : ''}`} {...rest}>
      <div className="tb-side tb-left">{left}</div>
      {centre != null && <div className="tb-centre">{centre}</div>}
      <div className="tb-side tb-right">{right}</div>
    </header>
  )
}

/** Logo + "Fire-3d" (overview and Forensic; the screens omit it inside a fire on the map). */
export function TopBarBrand({ size = 24 }: { size?: number }) {
  return (
    <span className="tb-brand">
      <Logo size={size} />
      <span className="tb-brand-name">Fire-3d</span>
    </span>
  )
}

/** The Public · Command · Forensic switch: a 32 px pill (sm: 28 px), the active view accent orange with dark ink. */
export function ViewPill({ size = 'md', className }: { size?: 'sm' | 'md'; className?: string }) {
  const value = useWorkspace((s) => viewOf(s.workspace, s.preset))
  return (
    <div className={`tb-view tb-view-${size}${className ? ` ${className}` : ''}`} role="radiogroup" aria-label="View: Public, Command or Forensic">
      {VIEWS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className="tb-view-btn"
          data-tip={o.tip}
          onClick={(e) => {
            if (o.value === value) return
            // the switch swaps the chrome (and with it this pill): keep keyboard focus on the new pill's active view
            const hadFocus = e.currentTarget === document.activeElement
            applyView(o.value)
            if (hadFocus) requestAnimationFrame(() => document.querySelector<HTMLElement>('.tb-view-btn[aria-checked="true"]')?.focus({ preventScroll: true }))
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M15 5 L8 12 L15 19" />
    </svg>
  )
}

/** 36 px round glass "back" button (event views). */
export function BackButton({ onClick, label = 'Back to all fires', tip }: { onClick: () => void; label?: string; tip?: string }) {
  return (
    <button type="button" className="tb-icon tb-back" aria-label={label} data-tip={tip ?? label} onClick={onClick}>
      <ChevronLeftIcon />
    </button>
  )
}

/** "● LIVE" (mono, orange dot) for a live fire, else its year as a chip; nothing when neither is known. */
export function LiveDot({ live, year }: { live: boolean; year?: number | null }) {
  if (live)
    return (
      <span className="tb-live">
        <i className="tb-live-dot" aria-hidden="true" />
        LIVE
      </span>
    )
  if (year == null) return null
  return <span className="tb-year">{year}</span>
}

/** 36 px round glass icon button. `label` is its accessible name (visually hidden text, so a badge's own hidden text
 *  joins it) and, unless `tip` says more, its tooltip. `pressed` / `expanded` mark it on (accent). Other button props
 *  (data-panel-toggle, aria-haspopup, ref, className) pass through. */
export function IconPill({
  icon,
  label,
  tip,
  pressed,
  expanded,
  onClick,
  badge,
  className,
  ref,
  ...rest
}: {
  icon: ReactNode
  label: string
  tip?: string
  pressed?: boolean
  expanded?: boolean
  onClick: () => void
  badge?: ReactNode
  className?: string
  ref?: Ref<HTMLButtonElement>
} & Omit<HTMLAttributes<HTMLButtonElement>, 'onClick' | 'children' | 'className'>) {
  const on = pressed === true || expanded === true
  return (
    <button
      ref={ref}
      type="button"
      className={`tb-icon${on ? ' is-on' : ''}${className ? ` ${className}` : ''}`}
      aria-pressed={pressed}
      aria-expanded={expanded}
      data-tip={tip ?? label}
      onClick={onClick}
      {...rest}
    >
      {icon}
      <span className="tb-label">{label}</span>
      {badge}
    </button>
  )
}

/** Mono status text in the bar's right slot; the parts from `staleFrom` on are amber (stale data age). A button when
 *  `onClick` is given. */
export function TopBarStatus({ parts, staleFrom, tip, onClick }: { parts: string[]; staleFrom?: number; tip?: string; onClick?: () => void }) {
  const segs = statusSegments(parts, staleFrom)
  if (segs.length === 0) return null
  const body = segs.map((s, i) => (
    <Fragment key={i}>
      {i > 0 && <span className="tb-status-sep"> · </span>}
      <span className={s.stale ? 'is-stale' : undefined}>{s.text}</span>
    </Fragment>
  ))
  return onClick ? (
    <button type="button" className="tb-status is-button" data-tip={tip} onClick={onClick}>
      {body}
    </button>
  ) : (
    <span className="tb-status" data-tip={tip}>
      {body}
    </span>
  )
}

/** The place (and an optional date range) in grey after the event name. */
export function TopBarPlace({ place, date, tip }: { place: string | null; date?: string | null; tip?: string }) {
  if (!place && !date) return null
  return (
    <span className="tb-place" data-tip={tip}>
      {place}
      {place && date ? ' · ' : null}
      {date ? <span className="tb-date">{date}</span> : null}
    </span>
  )
}
