// The basemap tint a chrome asks for (brief 4 decision j; CONTRACT §15.3 MapActions.setTint). Each view already gets
// its tint from MapAtmosphere (the national overview greyer, a fire view and Command as the aerial look has been), so
// a chrome calls this only to differ from that: `useMapTint('overview' | 'fire' | 'none')` while it is mounted, `null`
// for the view's default. The tint is paint on the aerial photos only (basemapStyle.ts AERIAL_TINT); the fire,
// official and selection layers keep their colours.
import { useEffect } from 'react'
import type { TintLevel } from './basemapStyle'
import { useMapRuntime } from './mapStore'

export function useMapTint(level: TintLevel | null): void {
  useEffect(() => {
    if (level == null) return
    useMapRuntime.setState({ tintRequest: level })
    return () => {
      if (useMapRuntime.getState().tintRequest === level) useMapRuntime.setState({ tintRequest: null })
    }
  }, [level])
}
