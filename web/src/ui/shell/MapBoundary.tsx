// Error boundary for the Public/Command map (owner: shell). If MapLibre or an overlay throws, the rest of the
// workspace (search, coordinates, location card, updates, timeline) keeps working and the map can be retried.
// Provider outages (tiles, terrain, imagery) are reported by the map itself; this only catches crashes.
import { RefreshCw } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'

export class MapBoundary extends Component<{ children: ReactNode }, { error: Error | null; attempt: number }> {
  state = { error: null as Error | null, attempt: 0 }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[map] crashed', error, info.componentStack)
  }
  render() {
    if (this.state.error)
      return (
        <div className="mw-map-error" role="alert">
          <div className="mw-map-error-card">
            <span className="mw-eyebrow">Map unavailable</span>
            <p className="mw-map-error-msg">{this.state.error.message}</p>
            <p className="mw-muted">Search, coordinates, location checks, updates and the timeline keep working.</p>
            <button type="button" className="mw-btn is-primary" onClick={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}>
              <RefreshCw size={13} /> Retry map
            </button>
          </div>
        </div>
      )
    return (
      <div key={this.state.attempt} className="mw-map-host">
        {this.props.children}
      </div>
    )
  }
}
