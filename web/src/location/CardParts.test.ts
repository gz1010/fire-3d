// The location card's official block (CONTRACT §14.7): every line of `fireWeather` is rendered as it is (the NWS
// status line and the local officials' alert lines), each link labelled by what it is (`urlLabel`), else "Read it".
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OfficialSection } from './CardParts'
import type { OfficialBlock, OfficialLine } from './official'

const line = (key: string, text: string, url: string | null, urlLabel?: string): OfficialLine => ({
  key,
  text,
  sub: `${text} source`,
  subCompact: `${text} short`,
  official: true,
  tone: 'other',
  url,
  ...(urlLabel ? { urlLabel } : {}),
})

const block: OfficialBlock = {
  evacuation: [line('evac', 'No evacuation order or warning listed here', null)],
  fireWeather: [
    line('nws', 'Red Flag Warning', 'https://api.weather.gov/alerts/urn:oid:1'),
    line('local-1', 'Evacuation Immediate', 'https://example.org/county', "issuer's link"),
    line('local-2', 'Shelter in place', 'https://api.weather.gov/alerts/urn:oid:2', 'source record (NWS)'),
    line('local-3', 'Civil Emergency Message', 'https://www.fema.gov/openfema-data-page/ipaws-archived-alerts-v1', 'source record (FEMA archive)'),
  ],
  follow: 'Follow local officials.',
  links: [],
  moreZones: 0,
}

const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ')

describe('OfficialSection (§14.7)', () => {
  it('renders the NWS line and the local alert lines with their own link labels', () => {
    for (const compact of [false, true]) {
      const t = text(renderToStaticMarkup(createElement(OfficialSection, { block, compact })))
      expect(t).toContain('Red Flag Warning')
      expect(t).toContain('Read it') // the NWS line has no label of its own
      expect(t).toContain("Issuer's link")
      expect(t).toContain('Source record (NWS)')
      expect(t).toContain('Source record (FEMA archive)')
      expect(t.match(/Read it/g)?.length).toBe(1)
      expect(t).toContain('Follow local officials.')
    }
  })
})
