// Brief 3 (us-official): /api/official/local-alerts answers for web tests and the us-official dev preset. The alerts
// are the recorded samples of backend/tests/data/official/ (nws_nwem_cem_la.json: a Los Angeles County Civil Emergency
// Message relayed by NWS on 2026-10-16; openfema_window_frw.json: real archived FEMA IPAWS messages, provenance in its
// PROVENANCE.md), parsed by the backend's own nws.normalize_local_nws / openfema.parse_records on 2026-10-23. Matching,
// phase and the envelopes are set by hand as us-pipeline's endpoint shapes them (CONTRACT §14.7); the incident ids of
// the archive answers are illustrative (no such bundles), Black Cove's is the real one with its archive still pending.
// LOCAL_ARCHIVE_EATON (at the end) is different: Fire-3d's own answer for the Eaton Fire (8 of its 33 messages), from the
// endpoint (review round 1, R1).
import type { LocalAlertsResponse } from '../types'

export const LOCAL_LIVE_LA_CEM: LocalAlertsResponse = {
  kind: 'local_alerts',
  status: 'available',
  reason_code: null,
  reason: null,
  source: {
    name: "National Weather Service (relayed local officials' messages)",
    url: 'https://www.weather.gov/dsb/nonweatheralerts',
    credit: "National Weather Service (relayed local officials' messages)",
  },
  retrieved_ms: 1792114439000,
  source_updated_ms: 1792113899000,
  requested_at_ms: null,
  now_ms: 1792115039000,
  incident_id: null,
  alerts: [
    {
      id: 'v2-3.13.8-1556392-1792113838542',
      channel: 'nws_api',
      archived: false,
      event: 'Civil Emergency Message',
      event_code: 'CEM',
      message_type: 'Alert',
      references: [],
      sender_name: 'Public Alert System',
      sender_is_platform: true,
      sent_ms: 1792113839000,
      effective_ms: 1792113839000,
      onset_ms: null,
      expires_ms: 1792117439000,
      headline: 'Alert from AlertLACounty',
      description:
        'This is an emergency message from the County of Los Angeles. Due to the Bryson Fire and Red Flag weather conditions, wildfires burning in the area can spread fast. Follow fire and law enforcement directions. Check on neighbors who may need assistance if able to safely do so. If you feel unsafe due to a fire nearby, do not wait for an official alert to leave. Visit AlertLA.org for more information. Call NINE ONE ONE for emergency help.',
      instruction: null,
      wea_text: null,
      wea_long_text: null,
      web: null,
      source_url: 'https://api.weather.gov/alerts/v2-3.13.8-1556392-1792113838542',
      area_desc: 'Los Angeles',
      same_codes: ['006037'],
      ugcs: [],
      polygon: null,
      match: 'county',
      covers_reported_location: null,
      nearest_km: null,
      time_zone: 'America/Los_Angeles', // tz-ok: recorded data, the message area's own zone
      phase: 'in_effect',
    },
  ],
  channels: [
    { id: 'nws_api', status: 'available', retrieved_ms: 1792114439000, source_updated_ms: 1792113899000, reason: null },
    {
      id: 'openfema_archive',
      status: 'not_checked',
      retrieved_ms: null,
      source_updated_ms: null,
      reason: 'The FEMA archive is checked for a chosen fire only.',
    },
  ],
  area_bbox: [-118.255, 34.295, -118.245, 34.305],
  reported_location: null,
  counties: [{ fips: '06037', name: 'Los Angeles County', state: 'CA' }],
  caveats: [
    'Fire-3d lists only the local alerts the National Weather Service relays; most are not relayed (about 1 in 20 fire and evacuation alerts in 2024-26). No alert here is not an all-clear: follow local officials.',
  ],
}

export const LOCAL_LIVE_NONE_RENO: LocalAlertsResponse = {
  kind: 'local_alerts',
  status: 'available',
  reason_code: null,
  reason: null,
  source: {
    name: "National Weather Service (relayed local officials' messages)",
    url: 'https://www.weather.gov/dsb/nonweatheralerts',
    credit: "National Weather Service (relayed local officials' messages)",
  },
  retrieved_ms: 1792114439000,
  source_updated_ms: 1792113899000,
  requested_at_ms: null,
  now_ms: 1792115039000,
  incident_id: null,
  alerts: [],
  channels: [
    { id: 'nws_api', status: 'available', retrieved_ms: 1792114439000, source_updated_ms: 1792113899000, reason: null },
    {
      id: 'openfema_archive',
      status: 'not_checked',
      retrieved_ms: null,
      source_updated_ms: null,
      reason: 'The FEMA archive is checked for a chosen fire only.',
    },
  ],
  area_bbox: [-119.82, 39.52, -119.8, 39.54],
  reported_location: null,
  counties: [{ fips: '32031', name: 'Washoe County', state: 'NV' }],
  caveats: [
    'Fire-3d lists only the local alerts the National Weather Service relays; most are not relayed (about 1 in 20 fire and evacuation alerts in 2024-26). No alert here is not an all-clear: follow local officials.',
  ],
}

export const LOCAL_ARCHIVE_KERN_FRW: LocalAlertsResponse = {
  kind: 'local_alerts',
  status: 'available',
  reason_code: null,
  reason: null,
  source: {
    name: "National Weather Service (relayed local officials' messages)",
    url: 'https://www.weather.gov/dsb/nonweatheralerts',
    credit: "National Weather Service (relayed local officials' messages)",
  },
  retrieved_ms: 1792717310000,
  source_updated_ms: null,
  requested_at_ms: 1791594110000,
  now_ms: 1792717310000,
  incident_id: '2026-cyrus-fire-demo01',
  alerts: [
    {
      id: '2781353712186803',
      channel: 'openfema_archive',
      archived: true,
      event: 'Fire Warning',
      event_code: 'FRW',
      message_type: 'Update',
      references: ['2780357279770323'],
      sender_name: 'Kern County OES',
      sender_is_platform: false,
      sent_ms: 1791583310000,
      effective_ms: null,
      onset_ms: null,
      expires_ms: 1791597710000,
      headline: 'Evacuation ORDER Update # 1 Cyrus Fire Fire 10-09-2026 3:01pm',
      description: null,
      instruction: null,
      wea_text: 'Kern County Sheriff: Cyrus Fire updated to an Evacuation Order. Leave NOW.',
      wea_long_text:
        'Kern County Sheriff: WILDFIRE Update # 1 Evacuation ORDER in effect for the Cyrus Fire. Genasys Protect Zone(s): KRN-761 Visibility in area will be reduced and roads/evacuation routes can become blocked; LEAVE now. CALL 9-1-1 if you or others have an emergency CHECK local media for updates.',
      web: null,
      source_url: 'https://www.fema.gov/api/open/v1/IpawsArchivedAlerts?$filter=identifier%20eq%20%272781353712186803%27',
      area_desc: 'Kern County Fire - OES',
      same_codes: ['006029'],
      ugcs: [],
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [-118.4168, 35.7207],
            [-118.417, 35.7314],
            [-118.4136, 35.7315],
            [-118.4121, 35.732],
            [-118.4098, 35.734],
            [-118.4064, 35.7336],
            [-118.4041, 35.732],
            [-118.4, 35.7312],
            [-118.3983, 35.7313],
            [-118.3953, 35.7301],
            [-118.3906, 35.7283],
            [-118.3877, 35.7279],
            [-118.3875, 35.7247],
            [-118.3847, 35.723],
            [-118.3819, 35.7197],
            [-118.377, 35.7151],
            [-118.3778, 35.7117],
            [-118.3784, 35.7099],
            [-118.3767, 35.7072],
            [-118.3763, 35.7042],
            [-118.38, 35.6977],
            [-118.3823, 35.6935],
            [-118.3908, 35.695],
            [-118.3931, 35.6948],
            [-118.3985, 35.6897],
            [-118.4008, 35.6878],
            [-118.4052, 35.6926],
            [-118.406, 35.6936],
            [-118.4086, 35.6929],
            [-118.4122, 35.6936],
            [-118.4151, 35.6952],
            [-118.417, 35.6953],
            [-118.4179, 35.6957],
            [-118.4199, 35.6974],
            [-118.4208, 35.6984],
            [-118.4215, 35.6997],
            [-118.4219, 35.7012],
            [-118.422, 35.702],
            [-118.423, 35.7022],
            [-118.4232, 35.7066],
            [-118.4193, 35.712],
            [-118.4168, 35.7207],
          ],
        ],
      },
      match: 'polygon',
      covers_reported_location: true,
      nearest_km: 0.0,
      time_zone: 'America/Los_Angeles', // tz-ok: recorded data, the message area's own zone
      phase: 'in_effect',
    },
  ],
  channels: [
    { id: 'nws_api', status: 'not_checked', retrieved_ms: null, source_updated_ms: null, reason: 'NWS keeps about 7 days of alerts.' },
    { id: 'openfema_archive', status: 'available', retrieved_ms: 1792717310000, source_updated_ms: null, reason: null },
  ],
  area_bbox: [-118.9, 35.2, -118.5, 35.5],
  reported_location: [-118.7, 35.35],
  counties: [{ fips: '06029', name: 'Kern County', state: 'CA' }],
  caveats: [
    'Fire-3d lists only the local alerts the National Weather Service relays; most are not relayed (about 1 in 20 fire and evacuation alerts in 2024-26). No alert here is not an all-clear: follow local officials.',
    'Archived copy from FEMA (OpenFEMA, published about a day later); FEMA does not validate message content. Replays can list more than was visible live.',
    "FEMA IPAWS archive via OpenFEMA: This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA",
  ],
}

export const LOCAL_ARCHIVE_SHERIDAN_WY: LocalAlertsResponse = {
  kind: 'local_alerts',
  status: 'available',
  reason_code: null,
  reason: null,
  source: {
    name: "National Weather Service (relayed local officials' messages)",
    url: 'https://www.weather.gov/dsb/nonweatheralerts',
    credit: "National Weather Service (relayed local officials' messages)",
  },
  retrieved_ms: 1792717310000,
  source_updated_ms: null,
  requested_at_ms: 1791594110000,
  now_ms: 1792717310000,
  incident_id: '2026-beckton-fire-demo02',
  alerts: [
    {
      id: 'AS-WY-4849b2e7-c698-4ae3-9f7c-ef8a0a17f71c',
      channel: 'openfema_archive',
      archived: true,
      event: 'Fire Warning',
      event_code: 'FRW',
      message_type: 'Alert',
      references: [],
      sender_name: 'Sheridan County WY',
      sender_is_platform: false,
      sent_ms: 1791594203000,
      effective_ms: 1791594203000,
      onset_ms: null,
      expires_ms: 1791608603000,
      headline: null,
      description: null,
      instruction:
        "SHERIDAN ALERTS- SET: WILDFIRE west of BECKTON. Be ready to leave at a moment's notice. Gather medications, medical devices, phones and chargers, keys, wallet or ID, important documents, water, clothing, and supplies for pets or livestock. Plan transportation and where you will go. Leave early if you need extra time. Keep roads clear for responders. Monitor official updates and see the exact mapped area at https://perimetermap.com",
      wea_text: "SHERIDAN ALERTS- SET: WILDFIRE west of BECKTON. Be ready to leave at a moment's notice.",
      wea_long_text:
        "SHERIDAN ALERTS- SET: WILDFIRE west of BECKTON. Areas west of Beckton are now in SET status. Be ready to leave at a moment's notice. Gather essential items, prepare pets and livestock, and leave early if you need extra time. Monitor official updates and see the exact mapped area at https://perimetermap.com.",
      web: null,
      source_url: 'https://www.fema.gov/api/open/v1/IpawsArchivedAlerts?$filter=identifier%20eq%20%27AS-WY-4849b2e7-c698-4ae3-9f7c-ef8a0a17f71c%27',
      area_desc: 'West Beckton',
      same_codes: ['056033'],
      ugcs: [],
      polygon: null,
      match: 'county',
      covers_reported_location: null,
      nearest_km: null,
      time_zone: 'America/Denver',
      phase: 'ended',
    },
  ],
  channels: [
    { id: 'nws_api', status: 'not_checked', retrieved_ms: null, source_updated_ms: null, reason: 'NWS keeps about 7 days of alerts.' },
    { id: 'openfema_archive', status: 'available', retrieved_ms: 1792717310000, source_updated_ms: null, reason: null },
  ],
  area_bbox: [-107.4, 44.7, -107.0, 44.9],
  reported_location: [-118.7, 35.35],
  counties: [{ fips: '56033', name: 'Sheridan County', state: 'WY' }],
  caveats: [
    'Fire-3d lists only the local alerts the National Weather Service relays; most are not relayed (about 1 in 20 fire and evacuation alerts in 2024-26). No alert here is not an all-clear: follow local officials.',
    'Archived copy from FEMA (OpenFEMA, published about a day later); FEMA does not validate message content. Replays can list more than was visible live.',
    "FEMA IPAWS archive via OpenFEMA: This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA",
  ],
}

export const LOCAL_ARCHIVE_PENDING_BLACK_COVE: LocalAlertsResponse = {
  kind: 'local_alerts',
  status: 'available',
  reason_code: null,
  reason: null,
  source: {
    name: "National Weather Service (relayed local officials' messages)",
    url: 'https://www.weather.gov/dsb/nonweatheralerts',
    credit: "National Weather Service (relayed local officials' messages)",
  },
  retrieved_ms: 1792268890000,
  source_updated_ms: null,
  requested_at_ms: 1742580000000,
  now_ms: 1792268900000,
  incident_id: '2025-black-cove-95c3c8',
  alerts: [],
  channels: [
    { id: 'nws_api', status: 'not_checked', retrieved_ms: null, source_updated_ms: null, reason: 'NWS keeps about 7 days of alerts.' },
    {
      id: 'openfema_archive',
      status: 'pending',
      retrieved_ms: null,
      source_updated_ms: null,
      reason: "FEMA's archive is being fetched; ask again in a minute.",
    },
  ],
  area_bbox: [-82.4, 35.1, -82.1, 35.4],
  reported_location: [-82.25, 35.25],
  counties: [{ fips: '37149', name: 'Polk County', state: 'NC' }],
  caveats: [
    'Fire-3d lists only the local alerts the National Weather Service relays; most are not relayed (about 1 in 20 fire and evacuation alerts in 2024-26). No alert here is not an all-clear: follow local officials.',
    'Archived copy from FEMA (OpenFEMA, published about a day later); FEMA does not validate message content. Replays can list more than was visible live.',
    "FEMA IPAWS archive via OpenFEMA: This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA",
  ],
}

/** Eaton Fire (2025-01-07, Los Angeles County) at the replay time 2025-01-09 03:40 UTC (at_ms 1736394000000): Fire-3d's
 *  own answer to GET /api/official/local-alerts?incident=2025-eaton-fire-dbfa57&at_ms=1736394000000 (FIRE3D_LIVE=0,
 *  FEMA's OpenFEMA archive window already on disk), recorded 2026-10-23 for review3-us-official R1. Real archived
 *  messages, verbatim: 8 of the answer's 33, in the backend's order (phase, then send time): the 3 newest are LA City's
 *  Sunset Fire and Runyon Canyon messages 26-30 km from Eaton's reported location; then LACo Fire's warning (12.7 km),
 *  LACo OEM's two nearest orders (2.7 km) and an order 3.1 km away, and La Canada Flintridge's ended message. Polygons
 *  rounded to 4 decimals; nothing else changed. */
export const LOCAL_ARCHIVE_EATON: LocalAlertsResponse = {
  "kind": "local_alerts",
  "status": "available",
  "reason_code": null,
  "reason": null,
  "source": {
    "name": "National Weather Service (relayed local officials' messages)",
    "url": "https://www.weather.gov/dsb/nonweatheralerts",
    "credit": "National Weather Service (relayed local officials' messages)",
    "license": "U.S. Government work in the public domain; api.weather.gov data is open data, free to use for any purpose",
    "terms_url": "https://www.weather.gov/disclaimer"
  },
  "retrieved_ms": 1792722982681,
  "source_updated_ms": null,
  "requested_at_ms": 1736394000000,
  "now_ms": 1792727304450,
  "incident_id": "2025-eaton-fire-dbfa57",
  "alerts": [
    {
      "id": "1891642646991604",
      "channel": "openfema_archive",
      "archived": true,
      "event": "Fire Warning",
      "event_code": "FRW",
      "message_type": "Alert",
      "references": [],
      "sender_name": "200277,LA City Public Alerts,City of Los Angeles",
      "sender_is_platform": false,
      "sent_ms": 1736389569000,
      "effective_ms": null,
      "onset_ms": null,
      "expires_ms": 1736403969000,
      "headline": "Wildfire Evacuation Warning-Sunset Fire",
      "description": null,
      "instruction": "LAFD:  Evacuation Warning for Sunset Fire at Sunset Fire burning area. Prepare to evacuate by gathering supplies, pets, and loved ones. Monitor local news, LAFD social media, and www.lafd.org/alerts for maps and info.\n\nLAFD: Preparese para evacuar el incendio Sunset Fire. Area con potencial de evacuacion de parte de Sunset Fire. Se aconseja que todos los presentes preparen para evacuar. Junten suministros y su familia. Escuche las noticias locales, las redes sociales de LAFD, y www.lafd.org/alerts para obtener mapas y informacion.",
      "wea_text": "LAFD: Wildfire evacuation warning for Sunset Fire. lafd.org/alerts",
      "wea_long_text": "LAFD: Evacuation Warning for Sunset Fire at Sunset Fire burning area. Prepare to evacuate by gathering supplies, pets, and loved ones. Monitor local news, LAFD social media, and www.lafd.org/alerts for maps and info.",
      "web": "https://www.lafd.org/alerts",
      "source_url": "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts?$filter=identifier%20eq%20%271891642646991604%27",
      "area_desc": "Los Angeles",
      "same_codes": [
        "006037"
      ],
      "ugcs": [],
      "polygon": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              -118.4128,
              34.0871
            ],
            [
              -118.4036,
              34.1266
            ],
            [
              -118.3784,
              34.1249
            ],
            [
              -118.3748,
              34.1165
            ],
            [
              -118.3729,
              34.1103
            ],
            [
              -118.3666,
              34.1044
            ],
            [
              -118.3658,
              34.098
            ],
            [
              -118.3923,
              34.0904
            ],
            [
              -118.4128,
              34.0871
            ]
          ]
        ]
      },
      "match": "polygon",
      "covers_reported_location": false,
      "nearest_km": 29.5,
      "time_zone": "America/Los_Angeles", // tz-ok: recorded data, the message area's own zone
      "phase": "in_effect"
    },
    {
      "id": "1892054963867730",
      "channel": "openfema_archive",
      "archived": true,
      "event": "Fire Warning",
      "event_code": "FRW",
      "message_type": "Alert",
      "references": [],
      "sender_name": "200277,LA City Public Alerts,Los Angeles Fire Department",
      "sender_is_platform": false,
      "sent_ms": 1736388797000,
      "effective_ms": null,
      "onset_ms": null,
      "expires_ms": 1736403197000,
      "headline": "Wildfire Evacuate Order: Sunset Fire Fire",
      "description": null,
      "instruction": "LAFD: Evacuate now. Evacuation order for Sunset Fire Fire for Runyon Canyon. All in that area must evacuate now. Gather people and pets and leave immediately.  All others shelter in place. Info & map: www.lafd.org/alerts\n\nLAFD: Evacue ahora. Orden de evacuacion para el incendio Sunset Fire. Runyon Canyon evacuan inmediatamente. Reuna personas y mascotas y salga inmediatamente. Todos afuera del area peligrosa deben refugiarse en lugar. Informacion y mapa: www.lafd.org/alerts",
      "wea_text": "LAFD: Evacuate now from wildfire: Runyon Canyon. Map: lafd.org/alerts",
      "wea_long_text": "LAFD: Evacuate now. Evacuation order for Sunset Fire Fire for Runyon Canyon. All in that area must evacuate now. Gather people and pets and leave immediately.  All others shelter in place. Info & map: www.lafd.org/alerts",
      "web": "https://www.lafd.org/alerts",
      "source_url": "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts?$filter=identifier%20eq%20%271892054963867730%27",
      "area_desc": "Los Angeles",
      "same_codes": [
        "006037"
      ],
      "ugcs": [],
      "polygon": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              -118.375,
              34.1126
            ],
            [
              -118.3783,
              34.1274
            ],
            [
              -118.3736,
              34.134
            ],
            [
              -118.3521,
              34.1324
            ],
            [
              -118.3256,
              34.1016
            ],
            [
              -118.3259,
              34.1016
            ],
            [
              -118.3656,
              34.1015
            ],
            [
              -118.375,
              34.1126
            ]
          ]
        ]
      },
      "match": "polygon",
      "covers_reported_location": false,
      "nearest_km": 26.2,
      "time_zone": "America/Los_Angeles", // tz-ok: recorded data, the message area's own zone
      "phase": "in_effect"
    },
    {
      "id": "1891677006756677",
      "channel": "openfema_archive",
      "archived": true,
      "event": "Fire Warning",
      "event_code": "FRW",
      "message_type": "Alert",
      "references": [],
      "sender_name": "200277,LA City Public Alerts,City of Los Angeles",
      "sender_is_platform": false,
      "sent_ms": 1736387927000,
      "effective_ms": null,
      "onset_ms": null,
      "expires_ms": 1736402327000,
      "headline": "Wildfire Alert: Sunset Fire",
      "description": null,
      "instruction": "Wildfire Alert- Sunset Fire\n\nLAFD: A wildfire is burning at Runyon Canyon. Those nearby should get set for a potential evacuation. Monitor local news, LAFD social media, and lafd.org/alerts for updates. Evacuation preparation info here: lafd.org/ready-set-go\n\nLAFD: Hay un incendio forestal a Runyon Canyon. Si estas en esta area preparese por posible evacuaciones. Escuche las noticias locales, los canales de redes sociales de LAFD y lafd.org/alerts. Para obtener recursos sobre como prepararse: lafd.org/ready-set-go",
      "wea_text": "LAFD:Wildfire- Runyon Canyon. Get set for possible evacuation. lafd.org/alerts",
      "wea_long_text": "LAFD: A wildfire is burning at Runyon Canyon. Those nearby should get set for a potential evacuation. Monitor local news, LAFD social media, and lafd.org/alerts for updates. Evacuation preparation info here: lafd.org/ready-set-go",
      "web": "https://www.lafd.org/alerts",
      "source_url": "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts?$filter=identifier%20eq%20%271891677006756677%27",
      "area_desc": "Los Angeles",
      "same_codes": [
        "006037"
      ],
      "ugcs": [],
      "polygon": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              -118.366,
              34.102
            ],
            [
              -118.3816,
              34.1289
            ],
            [
              -118.3563,
              34.134
            ],
            [
              -118.3362,
              34.1137
            ],
            [
              -118.3359,
              34.1014
            ],
            [
              -118.366,
              34.102
            ]
          ]
        ]
      },
      "match": "polygon",
      "covers_reported_location": false,
      "nearest_km": 26.5,
      "time_zone": "America/Los_Angeles", // tz-ok: recorded data, the message area's own zone
      "phase": "in_effect"
    },
    {
      "id": "test-lac-953437-1736378677038",
      "channel": "openfema_archive",
      "archived": true,
      "event": "Fire Warning",
      "event_code": "FRW",
      "message_type": "Alert",
      "references": [],
      "sender_name": "Public Alert System",
      "sender_is_platform": true,
      "sent_ms": 1736378677000,
      "effective_ms": 1736378677000,
      "onset_ms": null,
      "expires_ms": 1736465077000,
      "headline": "Lidia Fire Evacuation Warnings",
      "description": "LA COUNTY FIRE DEPARTMENT: FAST MOVING WILDFIRE IN YOUR AREA. AN EVACUATION ORDER HAS BEEN ISSUED FOR YOUR AREA. LEAVE NOW. Follow instructions from emergency personnel. Dial 9-1-1 for emergency help. Visit alertla.org for more information.",
      "instruction": "LA COUNTY FIRE DEPARTMENT: FAST MOVING WILDFIRE IN YOUR AREA. AN EVACUATION ORDER HAS BEEN ISSUED FOR YOUR AREA. LEAVE NOW. Follow instructions from emergency personnel. Dial 9-1-1 for emergency help. Visit alertla.org for more information.",
      "wea_text": "LACoFD: Fast Wildfire. EVACUATION WARNING. Prepare to leave. Alertla.org",
      "wea_long_text": "LA COUNTY FIRE DEPARTMENT: FAST MOVING WILDFIRE IN YOUR AREA. AN EVACUATION ORDER HAS BEEN ISSUED FOR YOUR AREA. LEAVE NOW. Follow instructions from emergency personnel. Dial 9-1-1 for emergency help. Visit alertla.org for more information.",
      "web": null,
      "source_url": "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts?$filter=identifier%20eq%20%27test-lac-953437-1736378677038%27",
      "area_desc": "Los Angeles",
      "same_codes": [
        "006037"
      ],
      "ugcs": [],
      "polygon": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              -118.1088,
              34.3349
            ],
            [
              -118.1263,
              34.3245
            ],
            [
              -118.1392,
              34.3085
            ],
            [
              -118.151,
              34.3059
            ],
            [
              -118.1476,
              34.2976
            ],
            [
              -118.1584,
              34.3009
            ],
            [
              -118.1607,
              34.297
            ],
            [
              -118.1735,
              34.2946
            ],
            [
              -118.1752,
              34.2964
            ],
            [
              -118.1864,
              34.2884
            ],
            [
              -118.1899,
              34.2965
            ],
            [
              -118.2014,
              34.3002
            ],
            [
              -118.1961,
              34.312
            ],
            [
              -118.2078,
              34.3208
            ],
            [
              -118.2196,
              34.3245
            ],
            [
              -118.2175,
              34.338
            ],
            [
              -118.226,
              34.3466
            ],
            [
              -118.2481,
              34.3507
            ],
            [
              -118.2648,
              34.3455
            ],
            [
              -118.2909,
              34.3517
            ],
            [
              -118.2985,
              34.3473
            ],
            [
              -118.3239,
              34.3477
            ],
            [
              -118.3386,
              34.3517
            ],
            [
              -118.352,
              34.3427
            ],
            [
              -118.3535,
              34.3515
            ],
            [
              -118.3828,
              34.3516
            ],
            [
              -118.3897,
              34.3577
            ],
            [
              -118.3923,
              34.3576
            ],
            [
              -118.3936,
              34.3609
            ],
            [
              -118.3911,
              34.3603
            ],
            [
              -118.3923,
              34.3608
            ],
            [
              -118.3876,
              34.3626
            ],
            [
              -118.3957,
              34.3654
            ],
            [
              -118.3981,
              34.3691
            ],
            [
              -118.3981,
              34.3786
            ],
            [
              -118.394,
              34.3765
            ],
            [
              -118.3981,
              34.3805
            ],
            [
              -118.3978,
              34.4093
            ],
            [
              -118.387,
              34.4091
            ],
            [
              -118.3867,
              34.4238
            ],
            [
              -118.3976,
              34.4238
            ],
            [
              -118.398,
              34.4323
            ],
            [
              -118.3721,
              34.4387
            ],
            [
              -118.353,
              34.4522
            ],
            [
              -118.3413,
              34.4656
            ],
            [
              -118.3297,
              34.4673
            ],
            [
              -118.3282,
              34.4609
            ],
            [
              -118.3333,
              34.455
            ],
            [
              -118.3325,
              34.4394
            ],
            [
              -118.334,
              34.4385
            ],
            [
              -118.323,
              34.427
            ],
            [
              -118.3102,
              34.4229
            ],
            [
              -118.2969,
              34.4101
            ],
            [
              -118.2966,
              34.4039
            ],
            [
              -118.2806,
              34.395
            ],
            [
              -118.273,
              34.3968
            ],
            [
              -118.2697,
              34.3933
            ],
            [
              -118.2701,
              34.3988
            ],
            [
              -118.2639,
              34.3999
            ],
            [
              -118.2529,
              34.3948
            ],
            [
              -118.2538,
              34.3935
            ],
            [
              -118.2504,
              34.3949
            ],
            [
              -118.2513,
              34.3826
            ],
            [
              -118.2472,
              34.379
            ],
            [
              -118.2532,
              34.3794
            ],
            [
              -118.2554,
              34.3765
            ],
            [
              -118.2412,
              34.376
            ],
            [
              -118.2326,
              34.3809
            ],
            [
              -118.2277,
              34.3762
            ],
            [
              -118.2205,
              34.38
            ],
            [
              -118.213,
              34.3755
            ],
            [
              -118.2102,
              34.3779
            ],
            [
              -118.2048,
              34.3764
            ],
            [
              -118.1899,
              34.3829
            ],
            [
              -118.1726,
              34.3732
            ],
            [
              -118.1722,
              34.3785
            ],
            [
              -118.1645,
              34.3761
            ],
            [
              -118.1644,
              34.3789
            ],
            [
              -118.1551,
              34.3806
            ],
            [
              -118.1435,
              34.3758
            ],
            [
              -118.1295,
              34.3832
            ],
            [
              -118.1212,
              34.3806
            ],
            [
              -118.1194,
              34.3862
            ],
            [
              -118.1026,
              34.4
            ],
            [
              -118.0905,
              34.4026
            ],
            [
              -118.0796,
              34.3999
            ],
            [
              -118.0798,
              34.3917
            ],
            [
              -118.0812,
              34.3917
            ],
            [
              -118.0826,
              34.3921
            ],
            [
              -118.0868,
              34.386
            ],
            [
              -118.0986,
              34.3851
            ],
            [
              -118.0954,
              34.3782
            ],
            [
              -118.1097,
              34.3578
            ],
            [
              -118.1099,
              34.3541
            ],
            [
              -118.1088,
              34.3349
            ]
          ]
        ]
      },
      "match": "polygon",
      "covers_reported_location": false,
      "nearest_km": 12.7,
      "time_zone": "America/Los_Angeles", // tz-ok: recorded data, the message area's own zone
      "phase": "in_effect"
    },
    {
      "id": "test-lac-951391-1736317607330",
      "channel": "openfema_archive",
      "archived": true,
      "event": "Evacuation Immediate",
      "event_code": "EVI",
      "message_type": "Alert",
      "references": [],
      "sender_name": "Public Alert System",
      "sender_is_platform": true,
      "sent_ms": 1736317607000,
      "effective_ms": 1736317607000,
      "onset_ms": null,
      "expires_ms": 1736404007000,
      "headline": "Alert from AlertLACounty",
      "description": "LA COUNTY OFFICE OF EMERGENCY MANAGEMENT: FAST MOVING WILDFIRE IN YOUR AREA. AN EVACUATION ORDER HAS BEEN ISSUED FOR THE YOUR AREA. LEAVE NOW. MORE INFO AT ALERTLA.ORG.",
      "instruction": "LA COUNTY OFFICE OF EMERGENCY MANAGEMENT: FAST MOVING WILDFIRE IN YOUR AREA. AN EVACUATION ORDER HAS BEEN ISSUED FOR THE YOUR AREA. LEAVE NOW. MORE INFO AT ALERTLA.ORG.",
      "wea_text": "LACo OEM: Fast moving wildfire. EVACUATION ORDER. LEAVE NOW. Alertla.org",
      "wea_long_text": "LA COUNTY OFFICE OF EMERGENCY MANAGEMENT: FAST MOVING WILDFIRE IN YOUR AREA. AN EVACUATION ORDER HAS BEEN ISSUED FOR THE YOUR AREA. LEAVE NOW. MORE INFO AT ALERTLA.ORG.",
      "web": null,
      "source_url": "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts?$filter=identifier%20eq%20%27test-lac-951391-1736317607330%27",
      "area_desc": "Los Angeles",
      "same_codes": [
        "006037"
      ],
      "ugcs": [],
      "polygon": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              -118.068,
              34.1619
            ],
            [
              -118.0681,
              34.1667
            ],
            [
              -118.055,
              34.1668
            ],
            [
              -118.0551,
              34.1707
            ],
            [
              -118.0522,
              34.1707
            ],
            [
              -118.0521,
              34.1709
            ],
            [
              -118.0521,
              34.171
            ],
            [
              -118.053,
              34.1709
            ],
            [
              -118.0539,
              34.1713
            ],
            [
              -118.0533,
              34.1757
            ],
            [
              -118.0656,
              34.1758
            ],
            [
              -118.0657,
              34.1793
            ],
            [
              -118.0301,
              34.1794
            ],
            [
              -118.0301,
              34.1712
            ],
            [
              -118.0304,
              34.1711
            ],
            [
              -118.0299,
              34.1707
            ],
            [
              -118.0303,
              34.1703
            ],
            [
              -118.0296,
              34.17
            ],
            [
              -118.0301,
              34.1698
            ],
            [
              -118.0301,
              34.169
            ],
            [
              -118.0294,
              34.1679
            ],
            [
              -118.0296,
              34.1669
            ],
            [
              -118.0385,
              34.1669
            ],
            [
              -118.0384,
              34.1619
            ],
            [
              -118.0408,
              34.1619
            ],
            [
              -118.068,
              34.1619
            ]
          ]
        ]
      },
      "match": "polygon",
      "covers_reported_location": false,
      "nearest_km": 2.7,
      "time_zone": "America/Los_Angeles", // tz-ok: recorded data, the message area's own zone
      "phase": "in_effect"
    },
    {
      "id": "test-lac-951328-1736314423280",
      "channel": "openfema_archive",
      "archived": true,
      "event": "Evacuation Immediate",
      "event_code": "EVI",
      "message_type": "Alert",
      "references": [],
      "sender_name": "Public Alert System",
      "sender_is_platform": true,
      "sent_ms": 1736314423000,
      "effective_ms": 1736314423000,
      "onset_ms": null,
      "expires_ms": 1736400823000,
      "headline": "Alert from AlertLACounty",
      "description": "LA COUNTY OFFICE OF EMERGENCY MANAGEMENT: FAST MOVING WILDFIRE IN YOUR AREA. AN EVACUATION ORDER HAS BEEN ISSUED FOR THE YOUR AREA. LEAVE NOW. MORE INFO AT ALERTLA.ORG.",
      "instruction": "LA COUNTY OFFICE OF EMERGENCY MANAGEMENT: FAST MOVING WILDFIRE IN YOUR AREA. AN EVACUATION ORDER HAS BEEN ISSUED FOR THE YOUR AREA. LEAVE NOW. MORE INFO AT ALERTLA.ORG.",
      "wea_text": "LACo OEM: Fast moving wildfire. EVACUATION ORDER. LEAVE NOW. Alertla.org",
      "wea_long_text": "LA COUNTY OFFICE OF EMERGENCY MANAGEMENT: FAST MOVING WILDFIRE IN YOUR AREA. AN EVACUATION ORDER HAS BEEN ISSUED FOR THE YOUR AREA. LEAVE NOW. MORE INFO AT ALERTLA.ORG.",
      "web": null,
      "source_url": "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts?$filter=identifier%20eq%20%27test-lac-951328-1736314423280%27",
      "area_desc": "Los Angeles",
      "same_codes": [
        "006037"
      ],
      "ugcs": [],
      "polygon": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              -118.0779,
              34.1716
            ],
            [
              -118.077,
              34.1739
            ],
            [
              -118.0777,
              34.1739
            ],
            [
              -118.078,
              34.1748
            ],
            [
              -118.0779,
              34.1751
            ],
            [
              -118.0775,
              34.1752
            ],
            [
              -118.0776,
              34.1755
            ],
            [
              -118.0778,
              34.1757
            ],
            [
              -118.0781,
              34.177
            ],
            [
              -118.0774,
              34.1777
            ],
            [
              -118.0773,
              34.1771
            ],
            [
              -118.0773,
              34.1775
            ],
            [
              -118.0768,
              34.1775
            ],
            [
              -118.0765,
              34.1772
            ],
            [
              -118.0759,
              34.1773
            ],
            [
              -118.0755,
              34.1769
            ],
            [
              -118.0746,
              34.1767
            ],
            [
              -118.0743,
              34.1765
            ],
            [
              -118.0743,
              34.1791
            ],
            [
              -118.0657,
              34.1793
            ],
            [
              -118.0656,
              34.1724
            ],
            [
              -118.0668,
              34.1724
            ],
            [
              -118.0682,
              34.173
            ],
            [
              -118.0684,
              34.1734
            ],
            [
              -118.0687,
              34.1731
            ],
            [
              -118.0708,
              34.1731
            ],
            [
              -118.0709,
              34.1734
            ],
            [
              -118.0717,
              34.1735
            ],
            [
              -118.0717,
              34.1732
            ],
            [
              -118.0722,
              34.1733
            ],
            [
              -118.0721,
              34.1735
            ],
            [
              -118.073,
              34.1741
            ],
            [
              -118.0731,
              34.1738
            ],
            [
              -118.0735,
              34.1738
            ],
            [
              -118.0736,
              34.1741
            ],
            [
              -118.0741,
              34.1741
            ],
            [
              -118.0743,
              34.174
            ],
            [
              -118.0751,
              34.1726
            ],
            [
              -118.0752,
              34.1726
            ],
            [
              -118.0751,
              34.1724
            ],
            [
              -118.0756,
              34.1718
            ],
            [
              -118.0762,
              34.1718
            ],
            [
              -118.0779,
              34.1716
            ]
          ]
        ]
      },
      "match": "polygon",
      "covers_reported_location": false,
      "nearest_km": 2.7,
      "time_zone": "America/Los_Angeles", // tz-ok: recorded data, the message area's own zone
      "phase": "in_effect"
    },
    {
      "id": "test-lac-951496-1736320054083",
      "channel": "openfema_archive",
      "archived": true,
      "event": "Evacuation Immediate",
      "event_code": "EVI",
      "message_type": "Alert",
      "references": [],
      "sender_name": "Public Alert System",
      "sender_is_platform": true,
      "sent_ms": 1736320054000,
      "effective_ms": 1736320054000,
      "onset_ms": null,
      "expires_ms": 1736406454000,
      "headline": "Alert from AlertLACounty",
      "description": "LA COUNTY OFFICE OF EMERGENCY MANAGEMENT: FAST MOVING WILDFIRE IN YOUR AREA. AN EVACUATION ORDER HAS BEEN ISSUED FOR THE YOUR AREA. LEAVE NOW. MORE INFO AT ALERTLA.ORG.",
      "instruction": "LA COUNTY OFFICE OF EMERGENCY MANAGEMENT: FAST MOVING WILDFIRE IN YOUR AREA. AN EVACUATION ORDER HAS BEEN ISSUED FOR THE YOUR AREA. LEAVE NOW. MORE INFO AT ALERTLA.ORG.",
      "wea_text": "LACo OEM: Fast moving wildfire. EVACUATION ORDER. LEAVE NOW. Alertla.org",
      "wea_long_text": "LA COUNTY OFFICE OF EMERGENCY MANAGEMENT: FAST MOVING WILDFIRE IN YOUR AREA. AN EVACUATION ORDER HAS BEEN ISSUED FOR THE YOUR AREA. LEAVE NOW. MORE INFO AT ALERTLA.ORG.",
      "web": null,
      "source_url": "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts?$filter=identifier%20eq%20%27test-lac-951496-1736320054083%27",
      "area_desc": "Los Angeles",
      "same_codes": [
        "006037"
      ],
      "ugcs": [],
      "polygon": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              -118.0681,
              34.1667
            ],
            [
              -118.0682,
              34.173
            ],
            [
              -118.0668,
              34.1724
            ],
            [
              -118.0656,
              34.1724
            ],
            [
              -118.0656,
              34.1759
            ],
            [
              -118.0532,
              34.1758
            ],
            [
              -118.0538,
              34.1714
            ],
            [
              -118.0529,
              34.1709
            ],
            [
              -118.0521,
              34.1711
            ],
            [
              -118.0521,
              34.1707
            ],
            [
              -118.0551,
              34.1707
            ],
            [
              -118.055,
              34.1668
            ],
            [
              -118.0575,
              34.1667
            ],
            [
              -118.0681,
              34.1667
            ]
          ]
        ]
      },
      "match": "polygon",
      "covers_reported_location": false,
      "nearest_km": 3.1,
      "time_zone": "America/Los_Angeles", // tz-ok: recorded data, the message area's own zone
      "phase": "in_effect"
    },
    {
      "id": "1899717185246783",
      "channel": "openfema_archive",
      "archived": true,
      "event": "Local Area Emergency",
      "event_code": "LAE",
      "message_type": "Alert",
      "references": [],
      "sender_name": "201723,La Canada Flintridge - Citizen Alert,City of La Canada Flintridge",
      "sender_is_platform": false,
      "sent_ms": 1736343217000,
      "effective_ms": null,
      "onset_ms": null,
      "expires_ms": 1736346817000,
      "headline": null,
      "description": null,
      "instruction": null,
      "wea_text": "La Canada Flintridge: An evacuation order has been issued for all of LCF.",
      "wea_long_text": null,
      "web": null,
      "source_url": "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts?$filter=identifier%20eq%20%271899717185246783%27",
      "area_desc": "Los Angeles County",
      "same_codes": [
        "006037"
      ],
      "ugcs": [],
      "polygon": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              -118.1837,
              34.2397
            ],
            [
              -118.1782,
              34.2308
            ],
            [
              -118.1705,
              34.2258
            ],
            [
              -118.1712,
              34.2224
            ],
            [
              -118.1705,
              34.2213
            ],
            [
              -118.162,
              34.2044
            ],
            [
              -118.1682,
              34.1924
            ],
            [
              -118.1666,
              34.1804
            ],
            [
              -118.2,
              34.1713
            ],
            [
              -118.2088,
              34.186
            ],
            [
              -118.2167,
              34.1992
            ],
            [
              -118.2375,
              34.2183
            ],
            [
              -118.2224,
              34.2454
            ],
            [
              -118.1837,
              34.2397
            ]
          ]
        ]
      },
      "match": "polygon",
      "covers_reported_location": false,
      "nearest_km": 8.5,
      "time_zone": "America/Los_Angeles", // tz-ok: recorded data, the message area's own zone
      "phase": "ended"
    }
  ],
  "channels": [
    {
      "id": "nws_api",
      "status": "not_checked",
      "retrieved_ms": null,
      "source_updated_ms": null,
      "reason": "NWS keeps about 7 days of alerts."
    },
    {
      "id": "openfema_archive",
      "status": "available",
      "retrieved_ms": 1792722982681,
      "source_updated_ms": null,
      "reason": null
    }
  ],
  "area_bbox": [
    -118.3774,
    33.9605,
    -117.7993,
    34.4396
  ],
  "reported_location": [
    -118.069155,
    34.203483
  ],
  "counties": [
    {
      "fips": "06037",
      "name": "Los Angeles County",
      "state": "CA"
    },
    {
      "fips": "06071",
      "name": "San Bernardino County",
      "state": "CA"
    }
  ],
  "caveats": [
    "Fire-3d lists only the local alerts the National Weather Service relays; most are not relayed (about 1 in 20 fire and evacuation alerts in 2024-26). No alert here is not an all-clear: follow local officials.",
    "Archived copy from FEMA (OpenFEMA, published about a day later); FEMA does not validate message content. Replays can list more than was visible live.",
    "FEMA IPAWS archive via OpenFEMA: This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA."
  ]
}

// Fire-3d's own answer for the Horse Gulch Fire (Montana, 2024) at Jul 10, 2024 6:00 PM MDT (`at_ms=1720656000000`), from
// the endpoint on 2026-10-23 (integration part 1 review, UX-M1): NWS keeps about 7 days, so only FEMA's archive answered;
// three in-effect messages from MTHelenaPoliceDepartment (two "Evacuation Immediate", one "Fire Warning"), the newest
// covering the fire's reported location. Montana has no state evacuation feed, so these are the only official
// evacuation messages Fire-3d can show for this fire.
export const LOCAL_ARCHIVE_HORSE_GULCH: LocalAlertsResponse = {
  "kind": "local_alerts",
  "status": "available",
  "reason_code": null,
  "reason": null,
  "source": {
    "name": "National Weather Service (relayed local officials' messages)",
    "url": "https://www.weather.gov/dsb/nonweatheralerts",
    "credit": "National Weather Service (relayed local officials' messages)",
    "license": "U.S. Government work in the public domain; api.weather.gov data is open data, free to use for any purpose",
    "terms_url": "https://www.weather.gov/disclaimer"
  },
  "retrieved_ms": 1792718813706,
  "source_updated_ms": null,
  "requested_at_ms": 1720656000000,
  "now_ms": 1792744732692,
  "incident_id": "2024-horse-gulch-889237",
  "caveats": [
    "Fire-3d lists only the local alerts the National Weather Service relays; most are not relayed (about 1 in 20 fire and evacuation alerts in 2024-26). No alert here is not an all-clear: follow local officials.",
    "Archived copy from FEMA (OpenFEMA, published about a day later); FEMA does not validate message content. Replays can list more than was visible live.",
    "FEMA IPAWS archive via OpenFEMA: This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA."
  ],
  "alerts": [
    {
      "id": "17206551120001381312434",
      "channel": "openfema_archive",
      "archived": true,
      "event": "Evacuation Immediate",
      "event_code": "EVI",
      "message_type": "Alert",
      "references": [],
      "sender_name": "MTHelenaPoliceDepartment",
      "sender_is_platform": false,
      "sent_ms": 1720655112000,
      "effective_ms": 1720652400000,
      "onset_ms": 1720652400000,
      "expires_ms": 1720662312000,
      "headline": null,
      "description": null,
      "instruction": "Urgent! The Lewis & Clark County Sheriff has issued an evacuation order for the Horse Gulch fire. Residences between Cave Gulch to Magpie Gulch north of Canyon Ferry must evacuate now. Please be aware of changing conditions and emergency vehicles in the area.",
      "wea_text": "Urgent! Evacuation for Horse Gulch Fire: Residences between Cave Gulch to Magpie Gulch",
      "wea_long_text": "Urgent! The Lewis & Clark County Sheriff has issued an evacuation order for the Horse Gulch fire. Residences between Cave Gulch to Magpie Gulch north of Canyon Ferry must evacuate now. Please be aware of changing conditions and emergency vehicles in the area.",
      "web": null,
      "source_url": "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts?$filter=identifier%20eq%20%2717206551120001381312434%27",
      "area_desc": "Horse Gulch Fire",
      "same_codes": [
        "030049"
      ],
      "ugcs": [],
      "polygon": {
        "type": "MultiPolygon",
        "coordinates": [
          [
            [
              [
                -111.6663,
                46.6513
              ],
              [
                -111.6741,
                46.6516
              ],
              [
                -111.6805,
                46.6481
              ],
              [
                -111.7047,
                46.6557
              ],
              [
                -111.7076,
                46.6588
              ],
              [
                -111.7069,
                46.6911
              ],
              [
                -111.7071,
                46.6911
              ],
              [
                -111.7071,
                46.6913
              ],
              [
                -111.6396,
                46.6925
              ],
              [
                -111.6408,
                46.6607
              ],
              [
                -111.6415,
                46.6465
              ],
              [
                -111.6663,
                46.6513
              ]
            ]
          ],
          [
            [
              [
                -111.7071,
                46.6911
              ],
              [
                -111.7076,
                46.6588
              ],
              [
                -111.721,
                46.6596
              ],
              [
                -111.7244,
                46.6908
              ],
              [
                -111.7071,
                46.6911
              ]
            ]
          ]
        ]
      },
      "match": "polygon",
      "covers_reported_location": true,
      "nearest_km": 0.0,
      "time_zone": "America/Denver",
      "phase": "in_effect"
    },
    {
      "id": "17206483950001381242600",
      "channel": "openfema_archive",
      "archived": true,
      "event": "Evacuation Immediate",
      "event_code": "EVI",
      "message_type": "Alert",
      "references": [],
      "sender_name": "MTHelenaPoliceDepartment",
      "sender_is_platform": false,
      "sent_ms": 1720648395000,
      "effective_ms": 1720643280000,
      "onset_ms": 1720643280000,
      "expires_ms": 1720677195000,
      "headline": null,
      "description": null,
      "instruction": "Residences on Cave Gulch are to evacuate immediately due to the Horse Gulch fire per order of the Sheriff.",
      "wea_text": "Urgent. A fire evacuation notice has been issued by the Sheriff for the Cave Gulch area.",
      "wea_long_text": "Urgent. The Lewis & Clark County Sheriff has issued an evacuation notice for the residences in the Cave Gulch area due to the Horse Gulch fire.",
      "web": null,
      "source_url": "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts?$filter=identifier%20eq%20%2717206483950001381242600%27",
      "area_desc": "Horse Gulch/Cave Gulch",
      "same_codes": [
        "030049"
      ],
      "ugcs": [],
      "polygon": null,
      "match": "county",
      "covers_reported_location": null,
      "nearest_km": null,
      "time_zone": "America/Denver",
      "phase": "in_effect"
    },
    {
      "id": "17206443300001381292441",
      "channel": "openfema_archive",
      "archived": true,
      "event": "Fire Warning",
      "event_code": "FRW",
      "message_type": "Alert",
      "references": [],
      "sender_name": "MTHelenaPoliceDepartment",
      "sender_is_platform": false,
      "sent_ms": 1720644330000,
      "effective_ms": 1720643280000,
      "onset_ms": 1720643280000,
      "expires_ms": 1720673130000,
      "headline": null,
      "description": null,
      "instruction": null,
      "wea_text": "Urgent. A fire pre-evacuation notice has been issued by the Sheriff for Horse Gulch area.",
      "wea_long_text": "Urgent. From the Helena-Lewis & Clark County 911 Center: The Lewis & Clark County Sheriff's Office has issued a pre-evacuation notice for the areas of Horse Gulch and Cave Gulch due to the wildfire. Please be aware of changing conditions and be prepared to evacuate.",
      "web": null,
      "source_url": "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts?$filter=identifier%20eq%20%2717206443300001381292441%27",
      "area_desc": "Horse Gulch/Cave Gulch",
      "same_codes": [
        "030049"
      ],
      "ugcs": [],
      "polygon": null,
      "match": "county",
      "covers_reported_location": null,
      "nearest_km": null,
      "time_zone": "America/Denver",
      "phase": "in_effect"
    }
  ],
  "channels": [
    {
      "id": "nws_api",
      "status": "not_checked",
      "retrieved_ms": null,
      "source_updated_ms": null,
      "reason": "NWS keeps about 7 days of alerts."
    },
    {
      "id": "openfema_archive",
      "status": "available",
      "retrieved_ms": 1792718813706,
      "source_updated_ms": null,
      "reason": null
    }
  ],
  "area_bbox": [
    -111.9973,
    46.4605,
    -111.3407,
    46.9115
  ],
  "reported_location": [
    -111.69614569201491,
    46.68870665301193
  ],
  "counties": [
    {
      "fips": "30007",
      "name": "Broadwater County",
      "state": "MT"
    },
    {
      "fips": "30043",
      "name": "Jefferson County",
      "state": "MT"
    },
    {
      "fips": "30049",
      "name": "Lewis and Clark County",
      "state": "MT"
    },
    {
      "fips": "30059",
      "name": "Meagher County",
      "state": "MT"
    }
  ]
}
