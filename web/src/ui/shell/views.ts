// The three views of the header switch (brief 2 C-R8): Public and Command (the map workspace's presets) and Forensic.
// Pure mapping (views.test.ts) plus the switch action.
import { useWorkspace, type Preset, type Workspace } from '../../state/workspace'
import { switchWorkspace } from './handoff'

export type View = 'public' | 'command' | 'forensic'

export const VIEWS: { value: View; label: string; tip: string }[] = [
  { value: 'public', label: 'Public', tip: 'Map of the fire in plain language: location checks, official information and updates' },
  { value: 'command', label: 'Command', tip: 'Denser map view: model runs, coordinates, identifiers and source times up front' },
  { value: 'forensic', label: 'Forensic', tip: '3D analytical scene: charts, scientific units, replay, model re-runs on past weather and forecast controls' },
]

export function viewOf(workspace: Workspace, preset: Preset): View {
  return workspace === 'forensic' ? 'forensic' : preset
}

/** What a view needs: the workspace, and the preset (Forensic keeps the current one). */
export function viewTarget(view: View, preset: Preset): { workspace: Workspace; preset: Preset } {
  return view === 'forensic' ? { workspace: 'forensic', preset } : { workspace: 'map', preset: view }
}

export function applyView(view: View): void {
  const ws = useWorkspace.getState()
  const t = viewTarget(view, ws.preset)
  if (t.preset !== ws.preset) ws.setPreset(t.preset)
  switchWorkspace(t.workspace)
}
