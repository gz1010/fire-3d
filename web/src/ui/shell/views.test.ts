import { describe, expect, it } from 'vitest'
import { coordsVariant } from './coordsVariant'
import { buildFailed, needsBuild } from './fireActions'
import { VIEWS, viewOf, viewTarget } from './views'

describe('Public · Command · Forensic switch', () => {
  it('keeps the three names in order', () => {
    expect(VIEWS.map((v) => v.label)).toEqual(['Public', 'Command', 'Forensic'])
  })

  it('maps workspace + preset to one view and back; Forensic keeps the preset', () => {
    expect(viewOf('map', 'public')).toBe('public')
    expect(viewOf('map', 'command')).toBe('command')
    expect(viewOf('forensic', 'command')).toBe('forensic')
    expect(viewTarget('command', 'public')).toEqual({ workspace: 'map', preset: 'command' })
    expect(viewTarget('forensic', 'command')).toEqual({ workspace: 'forensic', preset: 'command' })
  })
})

describe('coordinate strip form (decision 7: always visible)', () => {
  it('full in Command, compact in Public, one line on phones until expanded', () => {
    expect(coordsVariant('command', false, false)).toBe('full')
    expect(coordsVariant('public', false, true)).toBe('compact')
    expect(coordsVariant('public', true, false)).toBe('line')
    expect(coordsVariant('command', true, false)).toBe('line')
    expect(coordsVariant('command', true, true)).toBe('full')
    expect(coordsVariant('public', true, true)).toBe('compact')
  })
})

describe('fire card build rules', () => {
  const job = (status: 'queued' | 'running' | 'done' | 'error') => ({ kind: 'build', status }) as never
  it('needs a build only when nothing usable exists and nothing is preparing it', () => {
    expect(needsBuild({ manifest: null, summary: null, job: null })).toBe(true)
    expect(needsBuild({ manifest: { status: 'ready' } as never, summary: null, job: null })).toBe(false)
    expect(needsBuild({ manifest: { status: 'building' } as never, summary: null, job: null })).toBe(false)
    expect(needsBuild({ manifest: null, summary: { bundle_status: 'building' } as never, job: null })).toBe(false)
    expect(needsBuild({ manifest: null, summary: null, job: job('running') })).toBe(false)
    expect(needsBuild({ manifest: { status: 'error' } as never, summary: null, job: null })).toBe(true)
  })

  it('treats a failed bundle or build job as a failed preparation', () => {
    expect(buildFailed({ manifest: { status: 'error' } as never, summary: null, job: null })).toBe(true)
    expect(buildFailed({ manifest: null, summary: { bundle_status: 'error' } as never, job: null })).toBe(true)
    expect(buildFailed({ manifest: null, summary: null, job: job('error') })).toBe(true)
    expect(buildFailed({ manifest: null, summary: null, job: job('queued') })).toBe(false)
    expect(buildFailed({ manifest: null, summary: { bundle_status: 'none' } as never, job: null })).toBe(false)
  })
})
