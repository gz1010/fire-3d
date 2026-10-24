// Satellite chip on the map (owner: official-web; PLAN-2 O-R15, CONTRACT §13 I5; mounted by shell next to the map
// controls as a floating data-chrome element). It names the newest usable satellite image of the fire ("Newest: VIIRS
// NOAA-21 · Oct 17, 14:30 PDT (18 h ago) · 375 m"); one click shows it on the map, and while an image is shown a
// caption gives its platform, time, age, pixel size, cloud cover and "not live". "More images" opens the image list.
// Recent satellite images are archived snapshots, never live imagery.
// Brief 4: `variant="status"` is the same chip as the top bar's mono status line ("VIIRS NOAA-21 · 375 M · 6.2 H AGO",
// the age amber when a live image is older than the timeline's stale threshold), with the same actions: the line shows
// or hides the image, the small chevron opens "More images", the caption is the same.
import { ChevronDown, Satellite, X } from 'lucide-react'
import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../state/store'
import { useWorkspace } from '../state/workspace'
import { Popover } from '../ui/controls'
import { useNow } from '../ui/hooks'
import { imageryCaption, imageryChipParts, imageryChipText, imageryTiming, newestImagery } from './imagery'
import { ImageryPanel } from './ImageryPanel'
import { forIncident } from '../official/guard'
import { chooseCaptionPlacement } from './placement'
import { useExtrasRuntime } from './runtime'
import { statusSegments } from '../ui/shell/topBarText'
import { STALE_AFTER_MS } from '../ui/timeline/model'

/** Fixed position of the caption next to the chip, re-measured when the chrome changes (safe insets, panels) or the
 *  window resizes; hidden until measured. */
function useCaptionStyle(open: boolean, chip: RefObject<HTMLElement | null>, caption: RefObject<HTMLElement | null>): CSSProperties {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const insets = useWorkspace((s) => s.safeInsets)
  const panels = useWorkspace((s) => s.panels)
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const c = chip.current
      const cap = caption.current
      if (!c || !cap) return
      const own = c.closest('[data-chrome]')
      const obstacles = [...document.querySelectorAll<HTMLElement>('[data-chrome]')]
        .filter((el) => el !== own && !el.contains(c) && el.offsetParent !== null)
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
      const p = chooseCaptionPlacement(c.getBoundingClientRect(), { w: cap.offsetWidth, h: cap.offsetHeight }, obstacles, { w: window.innerWidth, h: window.innerHeight })
      setPos((prev) => (prev && prev.left === p.left && prev.top === p.top ? prev : p))
    }
    place()
    const ro = new ResizeObserver(place)
    if (caption.current) ro.observe(caption.current)
    if (chip.current) ro.observe(chip.current)
    window.addEventListener('resize', place)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [open, chip, caption, insets, panels])
  return pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0, visibility: 'hidden' }
}

export type ImageryChipVariant = 'chip' | 'status'

export function ImageryChip({ variant = 'chip' }: { variant?: ImageryChipVariant } = {}) {
  const now = useNow(60_000)
  const st = useStore(
    useShallow((s) => ({
      incidentId: s.incidentId,
      live: (s.manifest?.status === 'ready' ? s.manifest.mode : (s.summary?.mode ?? s.mode)) === 'live',
      startedMs: s.summary && s.summary.id === s.incidentId ? s.summary.started_ms : null,
      minute: Math.floor(s.timeMs / 60_000),
    })),
  )
  const on = useWorkspace((s) => s.mapLayers.recentImagery)
  const rt = useExtrasRuntime(useShallow((s) => ({ imgs: s.imgs, product: s.product, opacity: s.opacity })))
  const [open, setOpen] = useState(false)
  const [details, setDetails] = useState(false)
  const more = useRef<HTMLButtonElement | null>(null)
  const chipRef = useRef<HTMLElement | null>(null)
  const captionRef = useRef<HTMLDivElement | null>(null)
  const captionOpen = !!st.incidentId && on && !!rt.product && forIncident(rt.imgs.data, st.incidentId) != null
  const captionStyle = useCaptionStyle(captionOpen, chipRef, captionRef)
  if (!st.incidentId) return null

  const refMs = st.live ? now : st.minute * 60_000
  const data = forIncident(rt.imgs.data, st.incidentId)
  const newest = newestImagery(data, st.startedMs, st.live ? null : refMs)
  const shown = on && data ? rt.product : null
  const x = useExtrasRuntime.getState()
  const show = () => {
    if (shown) {
      useWorkspace.getState().setMapLayer('recentImagery', false)
      return
    }
    if (!newest) {
      setOpen(true)
      return
    }
    x.setProductChoice(newest.id)
    useWorkspace.getState().setMapLayer('recentImagery', true)
  }
  let text: string
  if (newest) text = `Newest image: ${imageryChipText(newest, refMs, st.live)}`
  else if (rt.imgs.error) text = 'Satellite images: could not load'
  else if (!data || rt.imgs.loading) text = 'Satellite images: checking…'
  else if (data.status !== 'available') text = 'Satellite images: unavailable'
  else text = 'No recent satellite image of this area'
  const parts = newest ? imageryChipParts(newest, refMs, st.live) : null
  const caption = shown ? imageryCaption(shown, refMs, st.live) : null
  const timing = shown ? imageryTiming(shown, refMs, st.startedMs, st.live) : null

  const label = `${text}. ${shown ? 'Hide the satellite image' : newest ? 'Show it on the map' : 'See the satellite images listed'}`
  const tip = shown ? 'Hide the satellite image' : newest ? `${text}. Show it on the map (an archived snapshot, not live)` : 'See the satellite images listed for this area'
  // the bar's status line: platform · pixel size · age (amber when a live image is older than the stale threshold)
  const statusParts = parts ? [parts.platform, parts.pixel, parts.age] : [text]
  const staleFrom = parts && newest && st.live && refMs - newest.acquired_ms > STALE_AFTER_MS ? 2 : undefined
  const segs = statusSegments(statusParts, staleFrom)

  return (
    <div className={variant === 'status' ? 'xs-statusbox' : 'xs-chipbox'}>
      {variant === 'status' ? (
        <span ref={chipRef} className={`xs-status${shown ? ' is-on' : ''}`}>
          <button type="button" className="tb-status is-button xs-status-main" aria-pressed={!!shown} onClick={show} aria-label={label} data-tip={tip}>
            <Satellite size={12} aria-hidden="true" className="xs-status-icon" />
            <span aria-hidden="true">
              {segs.map((seg, i) => (
                <Fragment key={i}>
                  {i > 0 && <span className="tb-status-sep"> · </span>}
                  <span className={seg.stale ? 'is-stale' : undefined}>{seg.text}</span>
                </Fragment>
              ))}
            </span>
          </button>
          <button ref={more} type="button" className="xs-status-more" aria-expanded={open} aria-haspopup="dialog" aria-label="More satellite images" data-tip="More images" onClick={() => setOpen((o) => !o)}>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        </span>
      ) : (
        <div ref={chipRef as RefObject<HTMLDivElement | null>} className={`xs-chip ${shown ? 'is-on' : ''}`}>
          <button type="button" className="xs-chip-main" aria-pressed={!!shown} onClick={show} aria-label={label} data-tip={tip}>
            <Satellite size={14} aria-hidden="true" />
            <span className="xs-chip-label">Satellite</span>
            {parts ? (
              <span className="xs-chip-text" aria-hidden="true">
                <span className="xs-chip-keep">
                  newest {parts.age} · {parts.pixel}
                </span>
                <span className="xs-chip-plat">&nbsp;· {parts.platform}</span>
                <span className="xs-chip-time">&nbsp;· {parts.time}</span>
              </span>
            ) : (
              <span className="xs-chip-text" aria-hidden="true">
                {text}
              </span>
            )}
          </button>
          <button ref={more} type="button" className="xs-chip-more" aria-expanded={open} aria-haspopup="dialog" aria-label="More satellite images" data-tip="More images" onClick={() => setOpen((o) => !o)}>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {caption &&
        shown &&
        createPortal(
          // compact (about 3 lines), placed next to the chip where it covers no other chrome; limits and credit on demand
          <div ref={captionRef} className="xs-caption" role="status" aria-live="polite" style={captionStyle}>
            <div className="xs-caption-head">
              <strong>{caption.title}</strong>
              <span className="xs-badge xs-badge-muted">not live</span>
              {timing?.beforeFire && <span className="xs-badge xs-badge-muted">before the fire</span>}
              <button type="button" className="xs-caption-more" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
                {details ? 'Less' : 'More'}
              </button>
              <button type="button" className="xs-icon-btn" aria-label="Hide the satellite image" onClick={() => useWorkspace.getState().setMapLayer('recentImagery', false)}>
                <X size={13} aria-hidden="true" />
              </button>
            </div>
            <p className="xs-caption-line">{caption.parts.join(' · ')}</p>
            {details && (
              <>
                {caption.limits.map((l) => (
                  <p key={l} className="xs-caption-line xs-dim">
                    {l}
                  </p>
                ))}
                <p className="xs-caption-line xs-dim">Credit: {shown.attribution}</p>
              </>
            )}
          </div>,
          document.body,
        )}
      <Popover anchor={more} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={340} label="Satellite images" className="xs-chip-pop">
        <ImageryPanel
          state={rt.imgs}
          selectedId={shown?.id ?? null}
          onSelect={(id) => {
            x.setProductChoice(id)
            useWorkspace.getState().setMapLayer('recentImagery', id != null)
          }}
          opacity={rt.opacity}
          onOpacity={x.setOpacity}
          startedMs={st.startedMs}
        />
      </Popover>
    </div>
  )
}
