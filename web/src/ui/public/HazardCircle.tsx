// The fire view's hazard circle (brief 4 H4, FireView.dc.html "Fire name dot"; PLAN-4 §3.4, decision i-10; HANDOFF
// "Fire view"): a 312 px round button with a thermal texture (an SVG feTurbulence smoky glow, brightest at the
// bottom left, slowly drifting; twinkling specks; film grain; no grid), the status words from the agency record
// ("WILDFIRE · ACTIVE"; ui/public/fireView.ts hazardStatus), the fire's name (72 px / 800, fitted down to 40 px over two
// lines, a long name down to 28 px over three; the full name is the button's accessible name and, when drawn small or
// cut, its tooltip) and "MORE IN COMMAND ›", which opens the Command view.
// Motion: the SMIL animations are left out under prefers-reduced-motion (the texture stands still) and paused while the
// tab is hidden (svg.pauseAnimations). Filter and gradient ids are unique per instance (useId). A fire that is not
// listed as active glows darker (the record's words say why); a demo fire says it is simulated.
import { useEffect, useId, useMemo, useRef, useSyncExternalStore, type CSSProperties, type Ref, type RefObject } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useRecord } from '../../official/hooks'
import { useStore } from '../../state/store'
import { useTimeFormat } from '../../state/timeZone'
import { isDemoBundle } from '../../state/workspace'
import { applyView } from '../shell/views'
import { fireEnd, fireLabel, fitName, hazardStatus } from './fireView'

/** The circle's size on the screen (px); its texture and text scale with the size it is drawn at. */
export const CIRCLE_PX = 312
/** The name's room inside the circle at 312 px (the chord at the name's height, less a margin). */
const NAME_ROOM = 256

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)'
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia?.(REDUCED_QUERY)
      m?.addEventListener('change', cb)
      return () => m?.removeEventListener('change', cb)
    },
    () => window.matchMedia?.(REDUCED_QUERY).matches === true,
    () => false,
  )
}

let measureCtx: CanvasRenderingContext2D | null | undefined
/** The name's width in Inter 800 at `px` with the screen's -0.03em tracking (an estimate without a canvas). */
function measureName(text: string, px: number): number {
  if (measureCtx === undefined) measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
  if (!measureCtx) return text.length * px * 0.62
  measureCtx.font = `800 ${px}px Inter, system-ui, sans-serif`
  return measureCtx.measureText(text).width - 0.03 * px * text.length
}

/** Pause the SVG's animations while the tab is hidden (and keep them paused under reduced motion). */
function usePausedWhenHidden(svg: RefObject<SVGSVGElement | null>, still: boolean) {
  useEffect(() => {
    const el = svg.current
    if (!el || typeof el.pauseAnimations !== 'function') return
    const apply = () => {
      if (still || document.hidden) el.pauseAnimations()
      else el.unpauseAnimations()
    }
    apply()
    document.addEventListener('visibilitychange', apply)
    return () => document.removeEventListener('visibilitychange', apply)
  }, [svg, still])
}

export function HazardCircle({ ref, compact = false }: { ref?: Ref<HTMLButtonElement>; compact?: boolean }) {
  const { summary, demo } = useStore(
    useShallow((s) => ({ summary: s.summary && s.summary.id === s.incidentId ? s.summary : null, demo: isDemoBundle(s.incidentId, s.manifest) })),
  )
  const record = useRecord()
  const tf = useTimeFormat()
  const still = useReducedMotion()
  const svg = useRef<SVGSVGElement | null>(null)
  usePausedWhenHidden(svg, still)
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const id = (k: string) => `hz${uid}${k}`
  const issuer = summary?.record_issuer || null
  const status = hazardStatus(summary, fireEnd(summary, record), demo, issuer, tf.tz)
  const name = summary?.name ?? ''
  const fitted = useMemo(() => (name ? fitName(name, measureName, NAME_ROOM) : { lines: [], px: 72 }), [name])
  // a long name drawn small or cut at its end: the tooltip gives it whole (the accessible name always does)
  const shortened = fitted.px < 40 || fitted.clamp === true
  const meaningId = id('m')
  return (
    <button
      ref={ref}
      type="button"
      className={`pfv-circle is-${status.tone}${compact ? ' is-compact' : ''}`}
      aria-label={`${name ? fireLabel(name) : 'This fire'}: ${status.line.replace(' · ', ', ').toLowerCase()}. More in Command view`}
      aria-describedby={meaningId}
      data-tip={`${shortened ? `${name}. ` : ''}Open this fire in the Command view: the timeline, the experimental model, coordinates and every source`}
      onClick={() => applyView('command')}
    >
      <svg ref={svg} className="pfv-circle-tex" width={CIRCLE_PX} height={CIRCLE_PX} viewBox={`0 0 ${CIRCLE_PX} ${CIRCLE_PX}`} aria-hidden="true">
        <defs>
          <radialGradient id={id('glow')} cx="0.3" cy="0.9" r="0.85">
            <stop offset="0" stopColor="#ff9a3c" />
            <stop offset="0.22" stopColor="#ee6a24" />
            <stop offset="0.48" stopColor="#9e2c0e" />
            <stop offset="0.74" stopColor="#3a0c05" />
            <stop offset="1" stopColor="#0b0302" />
          </radialGradient>
          <radialGradient id={id('maskg')} cx="0.3" cy="0.86" r="0.9">
            <stop offset="0" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.5" stopColor="#fff" stopOpacity="0.75" />
            <stop offset="1" stopColor="#fff" stopOpacity="0.12" />
          </radialGradient>
          <mask id={id('mask')}>
            <rect width={CIRCLE_PX} height={CIRCLE_PX} fill={`url(#${id('maskg')})`} />
          </mask>
          <filter id={id('cloud')} x="0" y="0" width={CIRCLE_PX} height="360" filterUnits="userSpaceOnUse">
            <feTurbulence type="fractalNoise" baseFrequency="0.011 0.02" numOctaves={4} seed={8}>
              {!still && <animate attributeName="baseFrequency" dur="16s" values="0.011 0.02;0.013 0.017;0.010 0.022;0.011 0.02" repeatCount="indefinite" />}
            </feTurbulence>
            <feOffset dx="0" dy="0">{!still && <animate attributeName="dy" dur="11s" values="0;-34;-12;0" repeatCount="indefinite" />}</feOffset>
            <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 0.46  0 0 0 0 0.15  2.6 0 0 0 -1.02" />
          </filter>
          <filter id={id('speck')} x="0" y="0" width={CIRCLE_PX} height={CIRCLE_PX} filterUnits="userSpaceOnUse">
            <feTurbulence type="turbulence" baseFrequency="0.5" numOctaves={1} seed={2}>
              {!still && <animate attributeName="seed" dur="1.6s" values="2;3;4;5;6;7" calcMode="discrete" repeatCount="indefinite" />}
            </feTurbulence>
            <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 0.58  0 0 0 0 0.22  9 0 0 0 -6.4" />
          </filter>
          <filter id={id('grain')} x="0" y="0" width={CIRCLE_PX} height={CIRCLE_PX} filterUnits="userSpaceOnUse">
            <feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves={2} seed={5}>
              {!still && <animate attributeName="seed" dur="0.5s" values="5;6;7;8;9" calcMode="discrete" repeatCount="indefinite" />}
            </feTurbulence>
            <feColorMatrix type="saturate" values="0" />
          </filter>
        </defs>
        <rect width={CIRCLE_PX} height={CIRCLE_PX} fill={`url(#${id('glow')})`} />
        <rect width={CIRCLE_PX} height={CIRCLE_PX} fill="#000" filter={`url(#${id('cloud')})`} mask={`url(#${id('mask')})`} opacity="0.9" style={{ mixBlendMode: 'screen' }} />
        <rect width={CIRCLE_PX} height={CIRCLE_PX} fill="#000" filter={`url(#${id('speck')})`} mask={`url(#${id('mask')})`} opacity="0.6" />
        <rect width={CIRCLE_PX} height={CIRCLE_PX} fill="#000" filter={`url(#${id('grain')})`} opacity="0.2" style={{ mixBlendMode: 'overlay' }} />
      </svg>
      <span className="pfv-circle-shade" aria-hidden="true" />
      <span className="pfv-circle-status" aria-hidden="true">
        {status.line.split(' · ').map((part, i) => (
          <span key={i} className="pfv-circle-part">
            {i > 0 && <span className="pfv-circle-dot"> · </span>}
            {part}
          </span>
        ))}
      </span>
      {fitted.lines.length > 0 && (
        <span className={`pfv-circle-name${fitted.clamp ? ' is-clamped' : ''}`} aria-hidden="true" style={{ '--pfv-name-px': `${fitted.px}px` } as CSSProperties}>
          {fitted.lines.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </span>
      )}
      <span className="pfv-circle-more" aria-hidden="true">
        More in Command
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
          <path d="M9 6 L15 12 L9 18" />
        </svg>
      </span>
      <span id={meaningId} className="mw-sr-only">
        {status.meaning}
      </span>
    </button>
  )
}
