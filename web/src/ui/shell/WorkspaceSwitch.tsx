// One "Public · Command · Forensic" switch (owner: shell, CONTRACT §3; brief 2 C-R8): Public and Command are the two
// presets of the map workspace, Forensic is the 3D workspace. Switching goes through switchWorkspace(), which hands
// the camera over; incident, forecast, time and selection live in the shared stores and are untouched. Forensic keeps
// the preset, so going back returns to the same Public or Command view.
import { useWorkspace } from '../../state/workspace'
import { Segmented } from '../controls'
import { applyView, VIEWS, viewOf } from './views'

export function ViewSwitch({ className, size = 'md' }: { className?: string; size?: 'sm' | 'md' }) {
  const value = useWorkspace((s) => viewOf(s.workspace, s.preset))
  return <Segmented value={value} options={VIEWS} onChange={applyView} ariaLabel="View: Public, Command or Forensic" className={className} size={size} />
}
