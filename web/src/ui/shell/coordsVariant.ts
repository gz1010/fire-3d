// Form of the always-visible coordinate strip (brief 2 decision 7, C-R2, C-R8; CONTRACT §13 shell). The slot
// (CoordsSlot.tsx) decides, the strip's content (location/CoordinateStrip.tsx) follows through useCoordsVariant():
//   'full'    Command wider than 760 px: DMS, UTM, incident id, record and selected times, datum;
//   'compact' Public wider than 760 px: decimal degrees only (reported location and selected point, copy buttons);
//   'line'    phones, both presets: ONE line (<= 32 px): the selected point, else the reported location, else a hint.
// On phones the slot's toggle shows the preset's desktop form until it is closed again. Never hidden by default.
import { createContext, useContext } from 'react'
import type { Preset } from '../../state/workspace'

export type CoordsVariant = 'full' | 'compact' | 'line'

export function coordsVariant(preset: Preset, narrow: boolean, expanded: boolean): CoordsVariant {
  const wide: CoordsVariant = preset === 'command' ? 'full' : 'compact'
  if (!narrow) return wide
  return expanded ? wide : 'line'
}

export const CoordsVariantContext = createContext<CoordsVariant>('compact')

/** The strip's form for the slot it renders in ('compact' outside the slot). */
export function useCoordsVariant(): CoordsVariant {
  return useContext(CoordsVariantContext)
}
