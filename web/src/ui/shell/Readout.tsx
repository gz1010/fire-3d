// "value unit — LABEL" readout rows (brief 4, HANDOFF "Readouts"; CONTRACT §15.2, frozen after H2): the value in mono
// at 22 px (26 for a headline figure, 17 for long values such as coordinates and identifiers), the unit small and
// grey, the label in small uppercase grey after an em dash. Used by Command's readout and the Public fire view's
// facts. `tone` colours the value (stale amber, official green, alert pink); `sub` adds a line under the row (source,
// own time, link); `copy` adds a copy button for that text. Styles: styles/topbar.css (.ro-*).
import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import '../../styles/topbar.css'

export type ReadoutSize = 22 | 26 | 17
export type ReadoutTone = 'stale' | 'official' | 'alert'

/** The class list of a row. */
function readoutClass(size: ReadoutSize, tone?: ReadoutTone): string {
  return `ro-row ro-${size}${tone ? ` is-${tone}` : ''}`
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = () =>
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1400)
      })
      .catch(() => undefined)
  return (
    <button type="button" className="ro-copy" aria-label={copied ? `${label} copied` : `Copy ${label}`} data-tip={copied ? 'Copied' : `Copy ${label}`} onClick={copy}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

export function ReadoutRow({
  value,
  unit,
  label,
  size = 22,
  tone,
  sub,
  copy,
}: {
  value: ReactNode
  unit?: string
  label: string
  size?: ReadoutSize
  tone?: ReadoutTone
  sub?: ReactNode
  copy?: string
}) {
  return (
    <div className={readoutClass(size, tone)}>
      <span className="ro-value">
        {value}
        {unit ? <span className="ro-unit">{unit}</span> : null}
      </span>
      <span className="ro-label">— {label}</span>
      {copy ? <CopyButton text={copy} label={label.toLowerCase()} /> : null}
      {sub ? <div className="ro-sub">{sub}</div> : null}
    </div>
  )
}
