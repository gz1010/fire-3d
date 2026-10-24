// Command's search (brief 4, CommandView.dc.html; PLAN-4 §3.2): the "Check an address" round button in the top bar
// opens the same search box (SearchBox.tsx: addresses, towns, ZIP codes, coordinates, fire names, the results and
// their messages) in a popover under the bar, right-aligned, 400 px wide. The button is the popover's toggle; "/" and
// fireActions.focusSearch() open it and focus the box; Escape (once the box has no message or result list open) and an
// outside click close it, focus going back to the button. The open state lives in searchUi.ts (searchOpen).
// Brief 4 H4: the Public fire view uses the same button in its top-right cluster with `variant="pill"`: the overview's
// centred search pill (SearchBox variant "pill") opens under the title instead of the right-aligned popover.
import { Search } from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { IconPill } from '../ui/shell/TopBar'
import { SearchBox } from './SearchBox'
import { useSearchUi } from './searchUi'
import './location.css'

const isTextField = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

export function CommandSearch({ variant = 'popover' }: { variant?: 'popover' | 'pill' } = {}) {
  const pill = variant === 'pill'
  const popId = pill ? 'pfv-search-pop' : 'cmd-search-pop'
  const open = useSearchUi((s) => s.searchOpen)
  const setOpen = useSearchUi((s) => s.setSearchOpen)
  const root = useRef<HTMLSpanElement | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)

  // leaving Command (or the fire) closes it, so the next Command view starts with the button
  useEffect(() => () => useSearchUi.getState().setSearchOpen(false), [])

  // opened: the box takes the focus (from the button, "/" or focusSearch)
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => root.current?.querySelector<HTMLInputElement>('.loc-search-input')?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open])

  // "/" opens the search while it is closed (the box's own "/" works while it is mounted)
  useEffect(() => {
    if (open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isTextField(e.target)) return
      e.preventDefault()
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  // an outside pointer-down (the map included) closes it
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open, setOpen])

  // Escape: the box closes its own message or result list first (SearchBox.tsx); with none open, the popover closes
  const onKeyDownCapture = (e: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== 'Escape' || !open || useSearchUi.getState().popover != null) return
    e.preventDefault()
    e.stopPropagation()
    setOpen(false)
    button.current?.focus()
  }

  return (
    <span ref={root} className="cmd-search" id="mw-search" onKeyDownCapture={onKeyDownCapture}>
      <IconPill
        ref={button}
        icon={<Search size={15} />}
        label="Check an address"
        tip="Check an address, town, ZIP code or coordinates (/)"
        expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? popId : undefined}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div className={pill ? 'pfv-search-pop' : 'cmd-search-pop'} id={popId} role="dialog" aria-label="Check an address" data-popover="">
          <SearchBox variant={pill ? 'pill' : undefined} />
        </div>
      )}
    </span>
  )
}
