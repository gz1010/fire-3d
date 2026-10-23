// The per-region accuracy of the experimental model for the open fire (brief 3, CONTRACT §14.4), outside the fire card:
// the Analysis drawer and the Forensic Analysis tab; the location card's model block shows one line (Public: the words,
// Command: the score). Round 2 decision 7 (integration review UX-m7): Public gets the words, with the score one tap
// away behind "How was it tested?" (the Analysis drawer in Public, as the fire card); Command and the Forensic Analysis
// tab show the score line directly. The wording is lib/plainLanguage.ts accuracyLabel; every number comes from the
// regional file. Model information only: never inside an official record.
import { ChevronDown } from 'lucide-react'
import { useId, useState } from 'react'
import { useOpenFireAccuracy } from '../state/accuracy'

/** "Model accuracy here": the Command line (or, with `words`, Public's line and the score behind "How was it
 *  tested?"), the fuel caveat and "Outside the modeled area is unknown, not low.". */
export function RegionAccuracy({ className, words = false }: { className?: string; /** Public: the words first, the score one tap away. */ words?: boolean }) {
  const { label, failed } = useOpenFireAccuracy()
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!label && !failed) return null
  const line = label ? (words ? label.publicLine : label.commandLine) : 'The accuracy of the model in this region could not be loaded right now.'
  return (
    <div className={`region-accuracy ${className ?? ''}`} aria-label="Model accuracy in this region">
      <p className="region-accuracy-line">
        <span className="region-accuracy-tag">Model accuracy here</span> {line}
      </p>
      {label?.fuelCaveat && <p className="region-accuracy-sub">{label.fuelCaveat}</p>}
      {!words && label && <Notes notes={label.notes} />}
      {words && label && label.publicLine !== label.commandLine && (
        <>
          <button type="button" className="mw-link-btn region-accuracy-more" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
            How was it tested? <ChevronDown size={12} aria-hidden="true" className={open ? 'is-open' : undefined} />
          </button>
          {open && (
            <div id={id}>
              {label.publicDetail && <p className="region-accuracy-sub">{label.publicDetail}</p>}
              <p className="region-accuracy-sub">{label.commandLine}</p>
              <Notes notes={label.notes} />
            </div>
          )}
        </>
      )}
      <p className="region-accuracy-sub">{label?.always ?? 'Outside the modeled area is unknown, not low.'}</p>
    </div>
  )
}

/** The region's caveats from the regional file, verbatim (validation review W-M3). */
function Notes({ notes }: { notes: string[] }) {
  if (!notes.length) return null
  return (
    <ul className="region-accuracy-notes">
      {notes.map((n) => (
        <li key={n} className="region-accuracy-sub">
          {n}
        </li>
      ))}
    </ul>
  )
}
