// Seeds the stores read by the real official components for the `us-official` dev preset (fixtures only; called by
// extras/dev/main.tsx before the first render, so the page never asks the backend).
import { FW_NATIONAL_MT_WY } from '../../official/__fixtures__/national'
import { useOfficialRuntime } from '../../official/runtime'
import { useStore } from '../../state/store'

export function seedUsOfficialStores(): void {
  // the overview: no fire open; the national NWS answer in the official runtime
  useStore.setState({ incidentId: null, summary: null, manifest: null })
  useOfficialRuntime.setState({ statewide: { data: FW_NATIONAL_MT_WY, loading: false, error: null, refresh: () => {} } })
}
