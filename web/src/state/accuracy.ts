// Per-region accuracy of the experimental spread model (brief 3 decision 3, round 2 item 7; CONTRACT §14.4). The
// regional file is loaded once per page from GET /api/accuracy-regions (written by the validation role; us-catalog
// serves it) and read by the fire card, the analysis views and the location card. The wording lives in
// lib/plainLanguage.ts (accuracyLabel); this module loads the file, finds a fire's region in it and gives the open
// fire's label (useOpenFireAccuracy).
import { create } from 'zustand'
import { useEffect } from 'react'
import { getAccuracyRegions } from '../api/client'
import type { AccuracyRegion, AccuracyRegionId, AccuracyRegionsResponse } from '../api/types'
import { accuracyLabel, type AccuracyLabel } from '../lib/plainLanguage'
import { useStore } from './store'

export type AccuracyLoad = 'idle' | 'loading' | 'ok' | 'error'

interface AccuracyState {
  status: AccuracyLoad
  data: AccuracyRegionsResponse | null
  error: string | null
  /** Load the file once (later calls do nothing unless the last load failed). */
  load: () => Promise<void>
}

export const useAccuracyStore = create<AccuracyState>()((set, get) => ({
  status: 'idle',
  data: null,
  error: null,
  load: async () => {
    const st = get().status
    if (st === 'loading' || st === 'ok') return
    set({ status: 'loading', error: null })
    try {
      const data = await getAccuracyRegions()
      set({ status: 'ok', data, error: null })
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  },
}))

/** A region of the file by id; null for a null id or a region the file does not list. */
export function findRegion(data: Pick<AccuracyRegionsResponse, 'regions'> | null | undefined, id: AccuracyRegionId | null | undefined): AccuracyRegion | null {
  if (!data || !id) return null
  return data.regions.find((r) => r.id === id) ?? null
}

/** The regional file (loaded on first use) and the status of that load. */
export function useAccuracyRegions(): { status: AccuracyLoad; data: AccuracyRegionsResponse | null } {
  const status = useAccuracyStore((s) => s.status)
  const data = useAccuracyStore((s) => s.data)
  useEffect(() => {
    if (status === 'idle') void useAccuracyStore.getState().load()
  }, [status])
  return { status, data }
}

/** The open fire's accuracy label (null while the file loads, when it failed, or with no fire open). */
export function useOpenFireAccuracy(): { label: AccuracyLabel | null; failed: boolean } {
  const { status, data } = useAccuracyRegions()
  const region = useStore((s) => (s.summary && s.summary.id === s.incidentId ? (s.summary.accuracy_region ?? null) : undefined))
  if (region === undefined) return { label: null, failed: false }
  if (status === 'error') return { label: null, failed: true }
  if (status !== 'ok' || !data) return { label: null, failed: false }
  return { label: accuracyLabel(findRegion(data, region), data.method), failed: false }
}
