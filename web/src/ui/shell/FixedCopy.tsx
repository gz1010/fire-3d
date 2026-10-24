// The disclaimer every view keeps (brief 4; CONTRACT §15.2, frozen after H2), in the view's style:
//   line    Main: "RESEARCH PROTOTYPE · Not for operational use. " + the list-absence sentence, centred
//   corner  Command: mono caps in the bottom-left corner, + "Not an all-clear. Follow local officials."
//   bar     fire view: mono in the bottom bar
//   pill    Forensic: a small glass pill, + "Not an all-clear. Follow local officials."
// `extra` replaces the variant's default follow-up text (fixedCopy.ts defaultExtra); null = none. Styles:
// styles/topbar.css (.fxc-*). Positioning belongs to the view's chrome.
import { fixedCopyExtra, PROTOTYPE_LEAD, PROTOTYPE_LINE, PROTOTYPE_TAIL, type FixedCopyVariant } from './fixedCopy'
import '../../styles/topbar.css'

export function FixedCopy({ variant, extra, className }: { variant: FixedCopyVariant; extra?: string | null; className?: string }) {
  const e = fixedCopyExtra(variant, extra)
  const cls = `fxc fxc-${variant}${className ? ` ${className}` : ''}`
  if (variant === 'line')
    return (
      <p className={cls}>
        <span className="fxc-lead">{PROTOTYPE_LEAD}</span> · {PROTOTYPE_TAIL}
        {e ? ` ${e}` : null}
      </p>
    )
  return (
    <p className={cls}>
      {PROTOTYPE_LINE}
      {e ? (
        <>
          <span className="fxc-sep"> · </span>
          {e}
        </>
      ) : null}
    </p>
  )
}
