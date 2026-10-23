// The per-region accuracy of the experimental model for the open fire (brief 3, CONTRACT §14.4), outside the fire card:
// the Analysis drawer and the Forensic Analysis tab show the Command line (the score with its counts); the location
// card's model block shows one line (Public: the words, Command: the score). The wording is lib/plainLanguage.ts
// accuracyLabel; every number comes from the regional file. Model information only: never inside an official record.
import { useOpenFireAccuracy } from '../state/accuracy'

/** "Model accuracy in this region": the Command line, the fuel caveat and "Outside the modeled area is unknown, not
 *  low." (the Analysis drawer and the Forensic Analysis tab). */
export function RegionAccuracy({ className }: { className?: string }) {
  const { label, failed } = useOpenFireAccuracy()
  if (!label && !failed) return null
  return (
    <div className={`region-accuracy ${className ?? ''}`} aria-label="Model accuracy in this region">
      <p className="region-accuracy-line">
        <span className="region-accuracy-tag">Model accuracy here</span> {label ? label.commandLine : 'The accuracy of the model in this region could not be loaded right now.'}
      </p>
      {label?.fuelCaveat && <p className="region-accuracy-sub">{label.fuelCaveat}</p>}
      <p className="region-accuracy-sub">{label?.always ?? 'Outside the modeled area is unknown, not low.'}</p>
    </div>
  )
}
