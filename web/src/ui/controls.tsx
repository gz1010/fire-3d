// Shared minimal controls (SPEC 9.5): segmented control, switch, checkbox, gold slider, icon button, popover menu,
// dropdown select, collapsible card, progress bar and spinner. Popovers render in a portal so their glass blur
// samples the 3D scene behind them.
import { Check, ChevronDown } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { readStorage, writeStorage } from '../state/annotations'
import { useDismiss } from './hooks'

export interface SegOption<T extends string | number> {
  value: T
  label: ReactNode
  tip?: string
  disabled?: boolean
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = 'md',
  ariaLabel,
  className,
}: {
  value: T
  options: SegOption<T>[]
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  ariaLabel?: string
  className?: string
}) {
  return (
    <div className={`seg seg-${size} ${className ?? ''}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className="seg-btn"
          data-tip={o.tip}
          disabled={o.disabled}
          onClick={() => o.value !== value && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Switch({ checked, onChange, label, disabled, tip }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean; tip?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      data-tip={tip}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  )
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} className="check" disabled={disabled} onClick={() => onChange(!checked)}>
      {checked && <Check size={10} strokeWidth={3.2} />}
    </button>
  )
}

export function Slider({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  label,
  disabled,
  className,
}: {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
  label: string
  disabled?: boolean
  className?: string
}) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <input
      type="range"
      className={`slider ${className ?? ''}`}
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      style={{ ['--fill' as string]: `${Math.max(0, Math.min(100, fill))}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

export function IconButton({
  icon,
  label,
  onClick,
  active,
  disabled,
  className,
  tip,
  buttonRef,
  ariaExpanded,
}: {
  icon: ReactNode
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  className?: string
  tip?: string | null
  buttonRef?: RefObject<HTMLButtonElement | null>
  ariaExpanded?: boolean
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`icon-btn ${active ? 'is-active' : ''} ${className ?? ''}`}
      aria-label={label}
      aria-pressed={active}
      aria-expanded={ariaExpanded}
      data-tip={tip === null ? undefined : (tip ?? label)}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  )
}

type Placement = 'bottom-start' | 'bottom-end' | 'bottom' | 'top-start' | 'top-end' | 'top' | 'left-start'

/** Anchored floating panel (portal + fixed position), dismissed by outside pointer-down or Escape. */
export function Popover({
  anchor,
  open,
  onClose,
  placement = 'bottom-start',
  offset = 8,
  width,
  className,
  children,
  label,
}: {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  placement?: Placement
  offset?: number
  width?: number
  className?: string
  children: ReactNode
  label?: string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null)
  useDismiss(open, [ref, anchor], onClose)
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const a = anchor.current?.getBoundingClientRect()
      const el = ref.current
      if (!a || !el) return
      const w = el.offsetWidth
      const h = el.offsetHeight
      const vw = window.innerWidth
      const vh = window.innerHeight
      let left: number
      let top: number
      if (placement === 'left-start') {
        left = a.left - offset - w
        top = a.top
      } else {
        left = placement.endsWith('end') ? a.right - w : placement === 'bottom' || placement === 'top' ? a.left + a.width / 2 - w / 2 : a.left
        const below = a.bottom + offset
        const above = a.top - offset - h
        const wantTop = placement.startsWith('top')
        top = wantTop ? (above >= 8 ? above : below) : below + h <= vh - 8 || above < 8 ? below : above
      }
      left = Math.max(8, Math.min(left, vw - w - 8))
      const maxH = Math.max(160, vh - Math.max(8, top) - 12)
      top = Math.max(8, Math.min(top, vh - Math.min(h, maxH) - 8))
      setPos((p) => (p && Math.abs(p.top - top) < 0.5 && Math.abs(p.left - left) < 0.5 && Math.abs(p.maxH - maxH) < 0.5 ? p : { top, left, maxH }))
    }
    place()
    const ro = new ResizeObserver(place)
    if (ref.current) ro.observe(ref.current)
    window.addEventListener('resize', place)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [open, placement, offset, anchor])
  if (!open) return null
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={`popover ${className ?? ''}`}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, maxHeight: pos?.maxH, visibility: pos ? 'visible' : 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  )
}

export function MenuItem({
  icon,
  label,
  hint,
  onSelect,
  disabled,
  checked,
  tip,
  danger,
}: {
  icon?: ReactNode
  label: ReactNode
  hint?: ReactNode
  onSelect: () => void
  disabled?: boolean
  checked?: boolean
  tip?: string
  danger?: boolean
}) {
  return (
    <button type="button" className={`menu-item ${danger ? 'is-danger' : ''}`} role="menuitem" disabled={disabled} data-tip={tip} onClick={onSelect}>
      <span className="menu-icon">{checked != null ? checked ? <Check size={13} /> : null : icon}</span>
      <span className="menu-label">{label}</span>
      {hint != null && <span className="menu-hint">{hint}</span>}
    </button>
  )
}

export function MenuSection({ label, children, aside }: { label: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="menu-section">
      <div className="menu-section-head">
        <span className="eyebrow">{label}</span>
        {aside}
      </div>
      {children}
    </div>
  )
}

export function MenuSeparator() {
  return <div className="menu-sep" role="separator" />
}

export function ProgressBar({ value, tone = 'gold', label }: { value: number | null; tone?: 'gold' | 'fire' | 'danger'; label?: string }) {
  const pct = value == null ? null : Math.max(0, Math.min(1, value)) * 100
  return (
    <div
      className={`progress progress-${tone} ${pct == null ? 'is-indeterminate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct == null ? undefined : Math.round(pct)}
    >
      <div className="progress-fill" style={pct == null ? undefined : { width: `${pct}%` }} />
    </div>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden />
}

export interface SelectOption<T extends string | number> {
  value: T
  label: ReactNode
  hint?: ReactNode
  disabled?: boolean
  tip?: string
}

/** Compact dropdown (button + popover menu) used for speeds, ensembles and chart options. */
export function SelectMenu<T extends string | number>({
  value,
  options,
  onChange,
  label,
  display,
  placement = 'top-start',
  width = 168,
  className,
  tip,
  disabled,
}: {
  value: T
  options: SelectOption<T>[]
  onChange: (v: T) => void
  label: string
  display?: ReactNode
  placement?: Placement
  width?: number
  className?: string
  tip?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const current = options.find((o) => o.value === value)
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`select-btn ${open ? 'is-open' : ''} ${className ?? ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        data-tip={open ? undefined : (tip ?? label)}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="select-value">{display ?? current?.label ?? String(value)}</span>
        <ChevronDown size={12} className="caret" />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement={placement} width={width} label={label} className="menu-pop select-pop">
        <div role="listbox" aria-label={label}>
          {options.map((o) => (
            <MenuItem
              key={String(o.value)}
              label={o.label}
              hint={o.hint}
              checked={o.value === value}
              disabled={o.disabled}
              tip={o.tip}
              onSelect={() => {
                setOpen(false)
                if (o.value !== value) onChange(o.value)
              }}
            />
          ))}
        </div>
      </Popover>
    </>
  )
}

/** Glass card with a header row; optionally collapsible (state remembered in localStorage under `storageKey`). */
export function Card({
  title,
  sub,
  aside,
  children,
  className,
  collapsible,
  storageKey,
  defaultOpen = true,
  bodyClassName,
}: {
  title: ReactNode
  sub?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
  collapsible?: boolean
  storageKey?: string
  defaultOpen?: boolean
  bodyClassName?: string
}) {
  const [open, setOpenState] = useState(() => {
    if (!collapsible || !storageKey) return defaultOpen
    const v = readStorage(`fire3d:card:${storageKey}`)
    return v == null ? defaultOpen : v === '1'
  })
  const setOpen = (v: boolean) => {
    setOpenState(v)
    if (storageKey) writeStorage(`fire3d:card:${storageKey}`, v ? '1' : '0')
  }
  return (
    <section className={`glass card ${open ? '' : 'is-collapsed'} ${className ?? ''}`}>
      <header className="card-head">
        {collapsible ? (
          <button type="button" className="card-title card-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            <ChevronDown size={13} className="card-caret" />
            <span>{title}</span>
            {sub && <span className="card-sub">{sub}</span>}
          </button>
        ) : (
          <h2 className="card-title">
            <span>{title}</span>
            {sub && <span className="card-sub">{sub}</span>}
          </h2>
        )}
        {aside != null && <div className="card-aside">{aside}</div>}
      </header>
      {open && <div className={`card-body ${bodyClassName ?? ''}`}>{children}</div>}
    </section>
  )
}

/** Section inside a panel tab: eyebrow title, optional right-side content. */
export function Section({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`sec ${className ?? ''}`}>
      <header className="sec-head">
        <h3 className="eyebrow">{title}</h3>
        {aside != null && <div className="sec-aside">{aside}</div>}
      </header>
      {children}
    </section>
  )
}

/** Empty / unavailable state inside a panel. */
export function EmptyNote({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty-note">
      {icon && <span className="empty-icon">{icon}</span>}
      <div>
        <div className="empty-title">{title}</div>
        {children && <div className="empty-body">{children}</div>}
      </div>
    </div>
  )
}

/** Small corner registration marks (instrument / parametric motif) for cards. */
export function CornerMarks() {
  return (
    <span className="corner-marks" aria-hidden>
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}
