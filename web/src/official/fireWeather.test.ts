import { describe, expect, it } from 'vitest'
import {
  alertPhase,
  alertSections,
  alertsAtPoint,
  alertTimeText,
  alertZones,
  fireWeatherCredits,
  fireWeatherDisplayData,
  fireWeatherFeedItems,
  fireWeatherLegend,
  isFireWeatherAlert,
  listedAlerts,
  senderText,
  shortAreaList,
  vtecKey,
} from './fireWeather'
import { FW_COOLEY_LIVE_QUIET, FW_EATON_ARCHIVE, NWS_LIVE_LOX_RFW } from './__fixtures__/samples'
import type { FireWeatherResponse, NwsAlert } from './types'

const H = 3_600_000
const REPLAY = 1736366400000 // Jan 8, 2025 12:00 PST
const RFW = FW_EATON_ARCHIVE.alerts.find((a) => a.event === 'Red Flag Warning')!
const FWW = FW_EATON_ARCHIVE.alerts.find((a) => a.event === 'Fire Weather Watch')!
const LIVE_AT = 1792260000000 // Oct 17, 2026 ~11:00 PDT
const liveResp = (alerts: NwsAlert[], zones: FireWeatherResponse['zones']['features'] = []): FireWeatherResponse => ({
  ...FW_COOLEY_LIVE_QUIET,
  alerts,
  zones: { type: 'FeatureCollection', features: zones },
})
const square = (x: number, y: number, s: number) => ({ type: 'Polygon' as const, coordinates: [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]] })

describe('NWS alert phases and wording', () => {
  it('keeps fire weather products only and groups CAP messages by VTEC event, zones of every message', () => {
    expect(isFireWeatherAlert(RFW)).toBe(true)
    expect(isFireWeatherAlert({ event: 'Beach Hazards Statement', vtec: { office: 'KSGX', phenomena: 'BH', significance: 'S', etn: 15, action: 'NEW' } })).toBe(false)
    expect(vtecKey(NWS_LIVE_LOX_RFW[0])).toBe('KLOX.FW.W.5')
    const listed = listedAlerts({ alerts: NWS_LIVE_LOX_RFW }, LIVE_AT)
    expect(listed).toHaveLength(1)
    expect(listed[0].merged_ids.sort()).toEqual(NWS_LIVE_LOX_RFW.map((a) => a.id).sort())
    expect(new Set(listed[0].ugcs)).toEqual(new Set(NWS_LIVE_LOX_RFW.flatMap((a) => a.ugcs)))
  })

  it('computes live phases from the clock; archived copies use the archive phase; CAN / UPG end an alert', () => {
    const a = NWS_LIVE_LOX_RFW[0]
    expect(alertPhase(a, LIVE_AT)).toBe('active')
    expect(alertPhase(a, a.ends_ms! + 1)).toBe('expired')
    expect(alertPhase({ ...a, onset_ms: LIVE_AT + H, effective_ms: LIVE_AT + H, sent_ms: LIVE_AT }, LIVE_AT)).toBe('upcoming')
    expect(alertPhase({ ...a, vtec: { ...a.vtec!, action: 'CAN' } }, LIVE_AT)).toBe('cancelled')
    expect(alertPhase({ ...a, vtec: { ...a.vtec!, action: 'UPG' } }, LIVE_AT)).toBe('cancelled')
    expect(alertPhase(RFW, REPLAY)).toBe('active')
    expect(alertPhase(FWW, REPLAY)).toBe('upcoming') // its archived end lies before its onset: the archive's phase wins
    expect(alertPhase({ ...a, dropped_ms: LIVE_AT - 1 }, LIVE_AT)).toBe('expired')
  })

  it('writes "until", "from … until", "Expired", "Cancelled" and "Replaced" in the NWS times', () => {
    expect(alertTimeText(RFW, 'active', REPLAY)).toBe('until Jan 10, 14:48 PST')
    expect(alertTimeText(FWW, 'upcoming', REPLAY)).toBe('from Jan 9, 18:00 PST (end time unclear in the archive)')
    const a = NWS_LIVE_LOX_RFW[0]
    expect(alertTimeText(a, 'expired', LIVE_AT + 48 * H)).toBe('Expired Oct 17, 20:00 PDT')
    expect(alertTimeText({ ...a, vtec: { ...a.vtec!, action: 'CAN' } }, 'cancelled', LIVE_AT)).toBe('Cancelled Oct 17, 09:11 PDT')
    expect(alertTimeText({ ...a, vtec: { ...a.vtec!, action: 'UPG' } }, 'cancelled', LIVE_AT)).toBe('Replaced by a newer NWS alert Oct 17, 09:11 PDT')
    expect(alertTimeText({ ...a, dropped_ms: LIVE_AT }, 'expired', LIVE_AT + H)).toBe('No longer in the NWS feed since Oct 17, 11:00 PDT')
    expect(senderText(a)).toBe('NWS Los Angeles/Oxnard CA')
    expect(senderText({ sender_name: null, vtec: { office: 'KSGX', phenomena: 'FW', significance: 'W', etn: 1, action: 'NEW' } })).toBe('NWS KSGX')
  })

  it('keeps an ended alert listed for 48 h, then drops it', () => {
    const a = NWS_LIVE_LOX_RFW[0]
    expect(listedAlerts({ alerts: [a] }, a.ends_ms! + 47 * H)).toHaveLength(1)
    expect(listedAlerts({ alerts: [a] }, a.ends_ms! + 49 * H)).toHaveLength(0)
  })

  it('splits the verbatim product into its parts, keeping the opening summary', () => {
    const s = alertSections(NWS_LIVE_LOX_RFW[0].description, NWS_LIVE_LOX_RFW[0].instruction)
    expect(s[0].label).toBe('Summary')
    expect(s[0].text).toMatch(/^\.\.\.RISK FOR RAPID FIRE GROWTH/)
    expect(s.map((x) => x.label)).toEqual(expect.arrayContaining(['Affected area', 'Timing', 'Winds', 'What to do (NWS)']))
    expect(s.find((x) => x.label === 'Timing')!.text).toBe('Until 8 PM PDT this evening.')
    expect(alertSections('* WHAT...Gusty winds.\n* WHERE...Ridges.\n* WHEN...Tonight.\n* IMPACTS...Rapid spread.').map((x) => `${x.label}: ${x.text}`)).toEqual([
      'What: Gusty winds.',
      'Where: Ridges.',
      'When: Tonight.',
      'Impacts: Rapid spread.',
    ])
    expect(alertSections('Plain text only.')).toEqual([{ label: 'Full text', text: 'Plain text only.' }])
    expect(alertSections(null, null)).toEqual([])
  })
})

describe('NWS zones, feed rows, map, legend and credits', () => {
  it('finds the alerts whose zones contain a point', () => {
    const r = liveResp(NWS_LIVE_LOX_RFW, [
      { type: 'Feature', geometry: square(0, 0, 1), properties: { ugc: 'CAZ288', name: 'Santa Clarita Valley', alert_ids: [NWS_LIVE_LOX_RFW[0].id] } },
      { type: 'Feature', geometry: square(5, 5, 1), properties: { ugc: 'CAZ999', name: 'Elsewhere', alert_ids: [] } },
    ])
    expect(alertsAtPoint(r, 0.5, 0.5).map((a) => a.id)).toContain(NWS_LIVE_LOX_RFW[0].id)
    expect(alertsAtPoint(r, 5.5, 5.5)).toEqual([])
    expect(alertZones(r, listedAlerts(r, LIVE_AT)[0]).map((z) => z.properties.ugc)).toEqual(['CAZ288'])
  })

  it('lists the archived Red Flag Warning verbatim, with its sender, link, archive label and area', () => {
    const items = fireWeatherFeedItems(FW_EATON_ARCHIVE, { mode: 'historical', refMs: REPLAY, manifest: { grid: { utm_zone: 11, center_e: 399738, center_n: 3784875 }, time_range: { start_ms: 1736298000000, end_ms: 1736535600000, now_ms: 1736535600000 } } as never })
    const rfw = items.find((i) => i.title.startsWith('Red Flag Warning'))!
    expect(rfw).toMatchObject({ title: 'Red Flag Warning until Jan 10, 14:48 PST', kind: 'official', automated: false, key: true, archived: true, status: 'active', issuer: 'National Weather Service Los Angeles/Oxnard CA', distanceKm: 0 })
    expect(rfw.source).toBe('National Weather Service Los Angeles/Oxnard CA (archived copy via Iowa Environmental Mesonet)')
    expect(rfw.detail).toBe(RFW.headline)
    expect(rfw.url).toBe(RFW.url)
    expect(rfw.seekable).toBe(false) // issued before the record starts
    expect(rfw.notes).toEqual(expect.arrayContaining(["The alert's area includes the fire's reported location.", expect.stringMatching(/^Archived copy of the NWS product/), 'A fire weather alert is a weather warning, not an evacuation order. Follow local officials.']))
    expect(rfw.highlight).toMatchObject({ kind: 'fire-weather', alertIds: [RFW.id] })
    expect(rfw.bounds).not.toBeNull()
    const fww = items.find((i) => i.title.startsWith('Fire Weather Watch'))!
    expect(fww.title).toBe('Fire Weather Watch from Jan 9, 18:00 PST (end time unclear in the archive)')
    expect(fww.status).toBe('upcoming')
    expect(fireWeatherFeedItems({ ...FW_EATON_ARCHIVE, status: 'not_available_for_past_dates' }, { mode: 'historical', refMs: REPLAY, manifest: null })).toEqual([])
  })

  it('shows the live NWS headline paragraph on demand and seeks only inside the record', () => {
    const r = liveResp(NWS_LIVE_LOX_RFW)
    const [it] = fireWeatherFeedItems(r, { mode: 'live', refMs: LIVE_AT, manifest: { grid: null, time_range: { start_ms: 0, end_ms: LIVE_AT, now_ms: LIVE_AT - 5 * H } } as never })
    expect(it.title).toBe('Red Flag Warning until Oct 17, 20:00 PDT')
    // two CAP segments (areas) of one event: each part's verbatim headline and text, on demand
    const parts = it.sections!.filter((x) => /^Part \d of 2/.test(x.label))
    expect(parts.map((p) => p.text).sort()).toEqual([
      'RED FLAG WARNING REMAINS IN EFFECT UNTIL 8 PM PDT THIS EVENING FOR GUSTY NORTHEAST TO EAST WINDS AND LOW RELATIVE HUMIDITY FOR MOST VALLEYS AND COASTS OF LOS ANGELES AND VENTURA COUNTIES',
      'RED FLAG WARNING REMAINS IN EFFECT UNTIL 8 PM PDT THIS EVENING FOR GUSTY NORTHEAST TO EAST WINDS AND LOW RELATIVE HUMIDITY FOR THE MOUNTAINS AND FOOTHILLS OF LOS ANGELES AND VENTURA COUNTIES',
    ])
    expect(it.sections!.filter((x) => x.label === 'Summary')).toHaveLength(2)
    expect(it.detail).toBe(NWS_LIVE_LOX_RFW[0].headline) // the event's own headline
    // one segment: its NWS headline paragraph when it differs from the event headline
    const [one] = fireWeatherFeedItems(liveResp([NWS_LIVE_LOX_RFW[0]]), { mode: 'live', refMs: LIVE_AT, manifest: null })
    expect(one.sections?.[0]).toEqual({ label: 'NWS headline', text: NWS_LIVE_LOX_RFW[0].nws_headline })
    expect(it.seekable).toBe(false) // sent after the latest observation
    expect(it.archived).toBe(false)
  })

  it('draws zones of alerts in effect (a warning wins over a watch), with a legend entry and the credit', () => {
    const fc = fireWeatherDisplayData(FW_EATON_ARCHIVE, REPLAY)
    expect(fc.features.length).toBe(FW_EATON_ARCHIVE.zones.features.length)
    expect(new Set(fc.features.map((f) => (f.properties as { kind: string }).kind))).toEqual(new Set(['warning']))
    expect((fc.features[0].properties as { label: string }).label).toBe('Red Flag Warning (NWS, archived)')
    const legend = fireWeatherLegend(FW_EATON_ARCHIVE, REPLAY)
    expect(legend).toHaveLength(1)
    expect(legend[0]).toMatchObject({ layer: 'fireWeather', label: 'Red Flag Warning (NWS, archived)', compact: 'Fire weather alert (NWS)', swatch: { kind: 'outline', line: 'dashed' } })
    expect(legend[0].detail).toMatch(/not an evacuation order$/)
    expect(fireWeatherCredits(FW_EATON_ARCHIVE, REPLAY)).toEqual([{ id: 'official-nws', text: 'Fire weather alerts: National Weather Service via Iowa Environmental Mesonet archive', href: 'https://mesonet.agron.iastate.edu/vtec/' }])
    // after both ended (more than 48 h), nothing is drawn or credited
    expect(fireWeatherDisplayData({ ...FW_EATON_ARCHIVE, alerts: FW_EATON_ARCHIVE.alerts.map((a) => ({ ...a, phase: 'ended' })) }, REPLAY).features).toEqual([])
    expect(fireWeatherCredits(FW_COOLEY_LIVE_QUIET, Date.now())).toEqual([])
  })
})

describe('NWS area lists', () => {
  it('shortens long zone lists in the facts and keeps the full verbatim list on demand', () => {
    expect(shortAreaList('A; B; C')).toBe('A; B; C')
    expect(shortAreaList('A; B; C; D; E; F')).toBe('A; B; C and 3 more zones')
    const [rfw] = fireWeatherFeedItems(FW_EATON_ARCHIVE, { mode: 'historical', refMs: REPLAY, manifest: null }).filter((i) => i.title.startsWith('Red Flag'))
    expect(rfw.facts?.find((f) => f.label === 'Area (NWS)')?.text).toMatch(/ and \d+ more zones$/)
    expect(rfw.sections?.find((x) => x.label === 'All areas (NWS)')?.text).toBe(RFW.area_desc)
  })
})

