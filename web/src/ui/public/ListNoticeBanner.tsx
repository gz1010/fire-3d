// The fire lists' notices while the list itself is not shown (Public minimal, phones with the sheet closed): "The
// national fire list (NIFC) is unavailable right now; only California fires (CAL FIRE) are listed.", "Could not load the
// 2026 list: …" (the panel's own §14.14 / §14.16 lines, ui/shell/useOverviewData.ts useListNotices). PLAN-4 §11 d: list-down
// banners stay visible; a whole region's fires missing with no reason given would read as an all-clear (review R2).
// Shown in App.tsx's top-centre slot with the other banners (a portal: App.tsx is frozen), dismissable; a changed
// notice shows again. Inside the details the panel shows them instead.
import { AlertTriangle, RefreshCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useListNotices } from '../shell/useOverviewData'

/** App.tsx's top-centre slot (the missing-fire notice, errors), once it is in the page. */
function useTopCentre(): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null)
  useEffect(() => {
    // after App.tsx has committed its slot (it comes after the chrome in the page)
    const raf = requestAnimationFrame(() => setEl(document.querySelector<HTMLElement>('.mw .top-center')))
    return () => cancelAnimationFrame(raf)
  }, [])
  return el
}

export function ListNoticeBanner() {
  const { lines, retry } = useListNotices()
  const key = lines.join('\n')
  const [dismissed, setDismissed] = useState<string | null>(null)
  const slot = useTopCentre()
  if (!lines.length || dismissed === key) return null
  const banner = (
    <div className="banner banner-info mw-list-notice" role="status">
      <AlertTriangle size={14} aria-hidden="true" />
      <span className="banner-text">
        {lines.map((l) => (
          <span key={l} className="mw-list-notice-line">
            {l}
          </span>
        ))}
      </span>
      {retry && (
        <button type="button" className="mw-btn is-sm" onClick={retry}>
          <RefreshCw size={12} aria-hidden="true" /> Retry
        </button>
      )}
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setDismissed(key)}>
        <X size={13} />
      </button>
    </div>
  )
  return slot ? createPortal(banner, slot) : banner
}
