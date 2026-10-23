// Test fixtures for the brief-3 IncidentSummary (CONTRACT 14.1). Tests build summaries here so that, when the
// integration makes the (R) fields required, only this file has to change. Not imported by app code.
import type { IncidentSummary, OtherRecord } from './types'

/** A complete CAL FIRE summary (every brief-3 field set), with `overrides` applied on top. The default is a
 *  historical California fire; pass `time_zone`, `state`, `record_source` etc. for other cases. */
export function summaryFixture(overrides: Partial<IncidentSummary> = {}): IncidentSummary {
  const base: IncidentSummary = {
    id: '2025-test-fire-abc123',
    name: 'Test Fire',
    mode: 'historical',
    year: 2025,
    calfire_uid: 'abc12345-0000-0000-0000-000000000000',
    started_ms: Date.UTC(2025, 6, 1, 20, 0),
    updated_ms: Date.UTC(2025, 6, 3, 18, 0),
    contained_ms: null,
    acres: 1234,
    percent_contained: 40,
    is_active: false,
    county: 'Los Angeles',
    location: null,
    admin_unit: null,
    url: 'https://www.fire.ca.gov/incidents/2025/7/1/test-fire',
    lat: 34.2,
    lon: -118.1,
    detections_24h: null,
    bundle_status: 'none',
    bundle_built_ms: null,
    uid: 'abc12345-0000-0000-0000-000000000000',
    record_source: 'calfire',
    record_issuer: 'CAL FIRE',
    state: 'CA',
    time_zone: 'America/Los_Angeles',
    agency: 'CAL FIRE',
    agency_code: null,
    irwin_id: null,
    unique_fire_id: null,
    source_name: 'Test Fire',
    gacc: null,
    accuracy_region: 'OSCC',
    active_sources: [],
    other_records: [],
    complex_name: null,
    complex_members: [],
    aliases: [],
  }
  return { ...base, ...overrides }
}

/** A complete NIFC WFIGS summary (a Montana fire protected by the USDA Forest Service), with `overrides` applied. */
export function wfigsSummaryFixture(overrides: Partial<IncidentSummary> = {}): IncidentSummary {
  return summaryFixture({
    id: '2024-horse-gulch-889237',
    name: 'Horse Gulch',
    year: 2024,
    calfire_uid: '',
    started_ms: Date.UTC(2024, 6, 21, 21, 0),
    updated_ms: Date.UTC(2024, 7, 2, 15, 30),
    acres: 9450,
    percent_contained: 100,
    county: 'Lewis and Clark',
    url: 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations/FeatureServer/0/query?where=IrwinID%3D%27%7B889237AB-0000-0000-0000-000000000000%7D%27&outFields=*&f=html',
    lat: 46.6,
    lon: -111.8,
    uid: '889237AB-0000-0000-0000-000000000000',
    record_source: 'wfigs',
    record_issuer: 'USFS via NIFC WFIGS',
    state: 'MT',
    time_zone: 'America/Denver',
    agency: 'USDA Forest Service',
    agency_code: 'USFS',
    irwin_id: '889237AB-0000-0000-0000-000000000000',
    unique_fire_id: '2024-MTHLF-000123',
    source_name: 'HORSE GULCH',
    gacc: 'NRCC',
    accuracy_region: 'NRCC',
    ...overrides,
  })
}

/** An `other_records` entry (a NIFC WFIGS record by default), with `overrides` applied. */
export function otherRecordFixture(overrides: Partial<OtherRecord> = {}): OtherRecord {
  return {
    source: 'wfigs',
    id: '51374D2C-0000-0000-0000-000000000000',
    name: 'TIMBER',
    issuer: 'USFS via NIFC WFIGS',
    agency: null,
    agency_code: 'USFS',
    acres: 25350,
    percent_contained: 97,
    is_active: true,
    updated_ms: Date.UTC(2026, 9, 22, 16, 5),
    url: 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations/FeatureServer/0/query?where=IrwinID%3D%27%7B51374D2C-0000-0000-0000-000000000000%7D%27&outFields=*&f=html',
    ...overrides,
  }
}
