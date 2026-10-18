import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearQueryCache, loadQuery, MAX_ENTRIES, peekQuery, releaseQuery, retainQuery, shouldFetch } from './jsonQuery'

type Pending = { url: string; resolve: (v: unknown) => void; reject: (e: unknown) => void; signal: AbortSignal | undefined }
let pending: Pending[] = []
function stubFetch() {
  pending = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    new Promise((resolve, reject) => {
      const p: Pending = { url, signal: init?.signal ?? undefined, resolve: (v) => resolve({ ok: true, status: 200, json: async () => v, text: async () => '' }), reject }
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      pending.push(p)
    }),
  )
}
const flush = () => new Promise((r) => setTimeout(r, 0))
const OPTS = { force: false, freshMs: 120_000, timeoutMs: 30_000 }

afterEach(() => {
  clearQueryCache()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('shouldFetch', () => {
  it('never doubles a running request; refetches only stale answers unless forced', () => {
    expect(shouldFetch({ loading: true, storedMs: 0 }, 1e6, 1000, true)).toBe(false)
    expect(shouldFetch({ loading: false, storedMs: 0 }, 1e6, 1000, false)).toBe(true)
    expect(shouldFetch({ loading: false, storedMs: 1e6 - 500 }, 1e6, 1000, false)).toBe(false)
    expect(shouldFetch({ loading: false, storedMs: 1e6 - 1500 }, 1e6, 1000, false)).toBe(true)
    expect(shouldFetch({ loading: false, storedMs: 1e6 - 500 }, 1e6, 1000, true)).toBe(false) // just refreshed by another reader
    expect(shouldFetch({ loading: false, storedMs: 1e6 - 6000 }, 1e6, 60_000, true)).toBe(true)
  })
})

describe('the shared query cache (fire changes: brief 2 decision 10)', () => {
  it('shares one request per URL and reuses a fresh answer when a fire is re-focused', async () => {
    stubFetch()
    retainQuery('/a')
    loadQuery('/a', OPTS)
    retainQuery('/a')
    loadQuery('/a', OPTS) // a second reader: no second request
    expect(pending).toHaveLength(1)
    expect(peekQuery('/a')).toMatchObject({ loading: true, data: null })
    pending[0].resolve({ incident_id: 'a', n: 1 })
    await flush()
    expect(peekQuery('/a')).toMatchObject({ loading: false, data: { incident_id: 'a', n: 1 }, error: null })
    releaseQuery('/a')
    releaseQuery('/a')
    // re-focus: the answer is still there and fresh, so nothing is fetched
    retainQuery('/a')
    loadQuery('/a', OPTS)
    expect(pending).toHaveLength(1)
    expect(peekQuery('/a')?.data).toEqual({ incident_id: 'a', n: 1 })
  })

  it('aborts a request nobody reads any more and never stores its late answer', async () => {
    stubFetch()
    retainQuery('/old')
    loadQuery('/old', OPTS)
    const req = pending[0]
    releaseQuery('/old') // the fire changed before it answered
    expect(req.signal?.aborted).toBe(true)
    expect(peekQuery('/old')).toMatchObject({ loading: false, data: null, error: null })
    await flush()
    expect(peekQuery('/old')?.data).toBeNull()
  })

  it('keeps the previous answer when a refresh fails, and says why', async () => {
    stubFetch()
    retainQuery('/b')
    loadQuery('/b', OPTS)
    pending[0].resolve({ v: 1 })
    await flush()
    const stored = peekQuery('/b')!.storedMs
    vi.useFakeTimers({ now: stored + 10_000 })
    loadQuery('/b', { ...OPTS, force: true })
    expect(pending).toHaveLength(2)
    pending[1].reject(Object.assign(new Error('x'), { status: 503 }))
    await vi.runAllTimersAsync()
    expect(peekQuery('/b')).toMatchObject({ data: { v: 1 }, loading: false, error: 'The Fire-3d server could not get data from this source.' })
  })

  it('stays bounded, dropping unused entries first', async () => {
    stubFetch()
    for (let i = 0; i < MAX_ENTRIES + 10; i++) {
      loadQuery(`/u${i}`, OPTS)
      pending[pending.length - 1].resolve({ i })
    }
    await flush()
    expect(peekQuery('/u0')).toBeUndefined()
    expect(peekQuery(`/u${MAX_ENTRIES + 9}`)?.data).toEqual({ i: MAX_ENTRIES + 9 })
  })
})
