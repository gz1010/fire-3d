// Workspace (Public/Command | Forensic) and preset (Public | Command) switches (owner: shell, CONTRACT §3). Switching
// goes through switchWorkspace(), which hands the camera over; incident, forecast, time and selection live in the
// shared stores and are untouched.
import { Segmented } from '../controls'
import { useWorkspace, type Preset, type Workspace } from '../../state/workspace'
import { switchWorkspace } from './handoff'

const WORKSPACES: { value: Workspace; label: string; tip: string }[] = [
  { value: 'map', label: 'Public / Command', tip: 'Map of the fire with roads, places, forecast and location checks' },
  { value: 'forensic', label: 'Forensic', tip: '3D analytical scene: charts, scientific units, replay, hindcasts and forecast controls' },
]

const PRESETS: { value: Preset; label: string; tip: string }[] = [
  { value: 'public', label: 'Public', tip: 'Plain-language view' },
  { value: 'command', label: 'Command', tip: 'Denser view: coordinates, identifiers and source timestamps up front' },
]

export function WorkspaceSwitch({ className, size = 'md' }: { className?: string; size?: 'sm' | 'md' }) {
  const workspace = useWorkspace((s) => s.workspace)
  return <Segmented value={workspace} options={WORKSPACES} onChange={switchWorkspace} ariaLabel="Workspace" className={className} size={size} />
}

export function PresetSwitch({ className, size = 'md' }: { className?: string; size?: 'sm' | 'md' }) {
  const preset = useWorkspace((s) => s.preset)
  const setPreset = useWorkspace((s) => s.setPreset)
  return <Segmented value={preset} options={PRESETS} onChange={setPreset} ariaLabel="Preset" className={className} size={size} />
}
