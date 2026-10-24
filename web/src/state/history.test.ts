import { describe, expect, it } from 'vitest'
import { historyWrite, incidentParam, isHistoryEntry, navigationUrl } from './history'

describe('history rules', () => {
  it('pushes every navigation, replaces the not-found fallback, skips what the address bar already says', () => {
    expect(historyWrite(null, '2026-a', false)).toBe('push') // overview -> fire
    expect(historyWrite('2026-a', '2025-b', false)).toBe('push') // fire -> fire
    expect(historyWrite('2026-a', null, false)).toBe('push') // "All fires"
    expect(historyWrite('2026-a', '2026-a', false)).toBe('none') // deep link, Back / Forward
    expect(historyWrite(null, null, false)).toBe('none')
    expect(historyWrite('bad-id', null, true)).toBe('replace') // unknown link: Back never leads to it
  })

  it('records zoom focus changes in place (decision 10: Back steps through explicit opens only)', () => {
    expect(historyWrite(null, '2026-a', false, true)).toBe('replace') // zoom in on a fire
    expect(historyWrite('2026-a', null, false, true)).toBe('replace') // zoom back out
    expect(historyWrite('2026-a', '2026-b', false, true)).toBe('replace') // pan to another fire
    expect(historyWrite('2026-a', '2026-a', false, true)).toBe('none')
  })

  it('brief 4: the Public fire view is an explicit open (one push from the overview); zooming out never rewrites it', () => {
    // openFireView selects with source 'card' (state/fireCard.ts), never 'zoom': Public has no zoom focus
    expect(historyWrite(null, '2026-a', false, false)).toBe('push')
    expect(historyWrite('2026-a', '2026-b', false, false)).toBe('push') // another fire from the open fire view
    expect(historyWrite('2026-a', null, false, false)).toBe('push') // "Back to all fires" when not opened from the overview
  })

  it('builds the address of a navigation: drops the previous fire\'s t / mode and the one-shot params', () => {
    const href = 'http://x/app/?ws=map&incident=2026-a&mode=live&t=123&preset=command&basemap=roads&view=1,2,3&sel=1,2#h'
    expect(navigationUrl(href, '2025-b')).toBe('/app/?ws=map&incident=2025-b&preset=command&basemap=roads#h')
    expect(navigationUrl(href, null)).toBe('/app/?ws=map&preset=command&basemap=roads#h')
  })

  it('reads the incident parameter and recognises its own entries', () => {
    expect(incidentParam('?ws=map&incident=2026-a')).toBe('2026-a')
    expect(incidentParam('?incident=')).toBeNull()
    expect(incidentParam('')).toBeNull()
    expect(isHistoryEntry({ fire3d: 1, incident: null, fromOverview: false })).toBe(true)
    expect(isHistoryEntry(null)).toBe(false)
    expect(isHistoryEntry({ fire3d: 2 })).toBe(false)
  })
})
