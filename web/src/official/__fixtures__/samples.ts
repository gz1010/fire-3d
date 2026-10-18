// TEST FIXTURES ONLY (never imported by app code). Recorded 2026-10-18 from the Fire-3d API (official-backend's
// /api/official/* on this repo) and the backend's recorded NWS sample; geometry is trimmed to a few vertices and
// rounded; wording, ids and times are the sources' own unless a comment says otherwise.
import type { CalFireResponse, FireWeatherResponse, NwsAlert } from '../types'

// Eaton Fire replay at Jan 8, 2025 12:00 PST: IEM archived copies (Red Flag Warning LOX FW.W #1 in effect, Fire Weather Watch FW.A #1 upcoming); 5 of the 10 zones
export const FW_EATON_ARCHIVE: FireWeatherResponse = {
 "kind": "fire_weather",
 "status": "available",
 "reason_code": null,
 "reason": null,
 "source": {
  "name": "NWS products, archived copy: Iowa Environmental Mesonet",
  "url": "https://mesonet.agron.iastate.edu/vtec/",
  "credit": "National Weather Service, archived copy via the Iowa Environmental Mesonet (Iowa State University)",
  "license": "Public domain (IEM: \"may be used freely by anyone for any lawful purpose\"); not an official NWS source",
  "terms_url": "https://mesonet.agron.iastate.edu/disclaimer.php"
 },
 "retrieved_ms": 1792341594694,
 "source_updated_ms": null,
 "requested_at_ms": 1736366400000,
 "now_ms": 1792341995194,
 "incident_id": "2025-eaton-fire-dbfa57",
 "caveats": [
  "Archived copy of NWS products from the Iowa Environmental Mesonet (Iowa State University), not an official NWS source. Times are the archive's per-zone times; the text is the latest NWS statement issued by the selected time.",
  "The archive was searched at the reported location and the corners of the analysis area.",
  "A Red Flag Warning or Fire Weather Watch is a weather alert about fire danger, not an evacuation order. Follow local officials."
 ],
 "alerts": [
  {
   "id": "2025-KLOX-FW-W-0001",
   "url": "https://mesonet.agron.iastate.edu/vtec/?year=2025&wfo=KLOX&phenomena=FW&significance=W&eventid=0001",
   "office_url": "https://www.weather.gov/lox",
   "event": "Red Flag Warning",
   "vtec": {
    "office": "KLOX",
    "phenomena": "FW",
    "significance": "W",
    "etn": 1,
    "action": "CON"
   },
   "sender_name": "National Weather Service Los Angeles/Oxnard CA",
   "sent_ms": 1736289420000,
   "effective_ms": 1736289420000,
   "onset_ms": 1736251200000,
   "expires_ms": 1736549280000,
   "ends_ms": 1736549280000,
   "headline": "...RED FLAG WARNING REMAINS IN EFFECT UNTIL 6 PM PST THURSDAY FOR THE FOLLOWING AREAS: SAN GABRIEL MOUNTAINS AND SANTA SUSANA MOUNTAINS...RED FLAG WARNING IN EFFECT FOR ALL OTHER TIMES FROM 4 AM TUESDAY TO 6 PM THURSDAY IN THESE SAME AREAS... ...FIRE WEATHER WATCH REMAINS IN EFFECT FROM THURSDAY EVENING THROUGH FRIDAY AFTERNOON FOR POTENTIAL WEAK TO MODERATE OFFSHORE WINDS AND LOW RELATIVE HUMIDITY FOR THE SAN GABRIEL MOUNTAINS AND SANTA SUSANA MOUNTAINS...",
   "nws_headline": "...RED FLAG WARNING REMAINS IN EFFECT UNTIL 6 PM PST THURSDAY FOR THE FOLLOWING AREAS: SAN GABRIEL MOUNTAINS AND SANTA SUSANA MOUNTAINS...RED FLAG WARNING IN EFFECT FOR ALL OTHER TIMES FROM 4 AM TUESDAY TO 6 PM THURSDAY IN THESE SAME AREAS... ...FIRE WEATHER WATCH REMAINS IN EFFECT FROM THURSDAY EVENING THROUGH FRIDAY AFTERNOON FOR POTENTIAL WEAK TO MODERATE OFFSHORE WINDS AND LOW RELATIVE HUMIDITY FOR THE SAN GABRIEL MOUNTAINS AND SANTA SUSANA MOUNTAINS...",
   "description": "* WINDS...Very strong/damaging north to northeast winds into\n  Wednesday, likely peaking in many areas between this evening\n  and early Wednesday afternoon when there is a high risk for\n  strong mountain wave wind activity. During this peak, sustained\n  winds of 40 to 60 mph and widespread damaging gusts of 70 to 100\n  mph can be expected. Moderate to locally strong north to\n  northeast winds will likely persist Thursday with gusts of 40 to\n  60 mph, with some weakening possible by Friday.\n\n* RELATIVE HUMIDITY...Falling to 10 to 20 percent by this evening.\n  Humidities will potentially fall to single digits in some areas\n  from Wednesday into Friday.\n\n* IMPACTS...If fire ignition occurs, conditions are favorable\n  for very rapid fire spread and extreme fire behavior,\n  including long range spotting, which would threaten life and\n  property. There will be the potential for downed trees and\n  powerlines, as well as power outages.",
   "instruction": "A Red Flag Warning means that critical fire weather conditions\nare either occurring now, or will shortly. Use extreme caution\nwith anything that can spark a wildfire. Residents near wildland\ninterfaces should be prepared to evacuate if a wildfire breaks\nout. See readyforwildfire.org and wildfirerisk.org for\ninformation.\n\nA Fire Weather Watch means that critical fire weather conditions\nare likely to occur in the coming days. Residents near wildland\ninterfaces should prepare now on what to do if a wildfire breaks\nout. See readyforwildfire.org and wildfirerisk.org for\ninformation.",
   "area_desc": "Malibu Coast; Western Santa Monica Mountains Recreational Area; Ventura County Inland Coast; Eastern San Gabriel Mountains; Eastern Santa Monica Mountains Recreational Area; Eastern San Fernando Valley; Calabasas and Agoura Hills; Western San Fernando Valley; Western San Gabriel Mountains and Highway 14 Corridor; Northern Ventura County Mountains; Los Angeles County Inland Coast including Downtown Los Angeles; Los Angeles County San Gabriel Valley; Central Ventura County Valleys; Santa Susana Mountains; Palos Verdes Hills; Catalina and Santa Barbara Islands; Ventura County Beaches; Southern Ventura County Mountains; Santa Clarita Valley; Interstate 5 Corridor; Southeastern Ventura County Valleys; Los Angeles County Beaches; Santa Ynez Mountains Eastern Range; Santa Barbara County Interior Mountains; Western Antelope Valley Foothills; Eastern Antelope Valley Foothills; Antelope Valley",
   "ugcs": [
    "CAZ362",
    "CAZ369",
    "CAZ355",
    "CAZ380",
    "CAZ370",
    "CAZ373",
    "CAZ371",
    "CAZ372",
    "CAZ379",
    "CAZ377",
    "CAZ368",
    "CAZ548",
    "CAZ358",
    "CAZ375",
    "CAZ367",
    "CAZ287",
    "CAZ354",
    "CAZ376",
    "CAZ288",
    "CAZ378",
    "CAZ374",
    "CAZ366",
    "CAZ352",
    "CAZ353",
    "CAZ381",
    "CAZ382",
    "CAZ383"
   ],
   "message_type": null,
   "status": "Actual",
   "covers_reported_location": true,
   "nearest_km": 0.0,
   "archived": true,
   "phase": "in_effect"
  },
  {
   "id": "2025-KLOX-FW-A-0001",
   "url": "https://mesonet.agron.iastate.edu/vtec/?year=2025&wfo=KLOX&phenomena=FW&significance=A&eventid=0001",
   "office_url": "https://www.weather.gov/lox",
   "event": "Fire Weather Watch",
   "vtec": {
    "office": "KLOX",
    "phenomena": "FW",
    "significance": "A",
    "etn": 1,
    "action": "CON"
   },
   "sender_name": "National Weather Service Los Angeles/Oxnard CA",
   "sent_ms": 1736289420000,
   "effective_ms": 1736289420000,
   "onset_ms": 1736474400000,
   "expires_ms": 1736380860000,
   "ends_ms": 1736380860000,
   "headline": "...RED FLAG WARNING REMAINS IN EFFECT UNTIL 6 PM PST THURSDAY FOR THE FOLLOWING AREAS: SAN GABRIEL MOUNTAINS AND SANTA SUSANA MOUNTAINS...RED FLAG WARNING IN EFFECT FOR ALL OTHER TIMES FROM 4 AM TUESDAY TO 6 PM THURSDAY IN THESE SAME AREAS... ...FIRE WEATHER WATCH REMAINS IN EFFECT FROM THURSDAY EVENING THROUGH FRIDAY AFTERNOON FOR POTENTIAL WEAK TO MODERATE OFFSHORE WINDS AND LOW RELATIVE HUMIDITY FOR THE SAN GABRIEL MOUNTAINS AND SANTA SUSANA MOUNTAINS...",
   "nws_headline": "...RED FLAG WARNING REMAINS IN EFFECT UNTIL 6 PM PST THURSDAY FOR THE FOLLOWING AREAS: SAN GABRIEL MOUNTAINS AND SANTA SUSANA MOUNTAINS...RED FLAG WARNING IN EFFECT FOR ALL OTHER TIMES FROM 4 AM TUESDAY TO 6 PM THURSDAY IN THESE SAME AREAS... ...FIRE WEATHER WATCH REMAINS IN EFFECT FROM THURSDAY EVENING THROUGH FRIDAY AFTERNOON FOR POTENTIAL WEAK TO MODERATE OFFSHORE WINDS AND LOW RELATIVE HUMIDITY FOR THE SAN GABRIEL MOUNTAINS AND SANTA SUSANA MOUNTAINS...",
   "description": "* WINDS...Very strong/damaging north to northeast winds into\n  Wednesday, likely peaking in many areas between this evening\n  and early Wednesday afternoon when there is a high risk for\n  strong mountain wave wind activity. During this peak, sustained\n  winds of 40 to 60 mph and widespread damaging gusts of 70 to 100\n  mph can be expected. Moderate to locally strong north to\n  northeast winds will likely persist Thursday with gusts of 40 to\n  60 mph, with some weakening possible by Friday.\n\n* RELATIVE HUMIDITY...Falling to 10 to 20 percent by this evening.\n  Humidities will potentially fall to single digits in some areas\n  from Wednesday into Friday.\n\n* IMPACTS...If fire ignition occurs, conditions are favorable\n  for very rapid fire spread and extreme fire behavior,\n  including long range spotting, which would threaten life and\n  property. There will be the potential for downed trees and\n  powerlines, as well as power outages.",
   "instruction": "A Red Flag Warning means that critical fire weather conditions\nare either occurring now, or will shortly. Use extreme caution\nwith anything that can spark a wildfire. Residents near wildland\ninterfaces should be prepared to evacuate if a wildfire breaks\nout. See readyforwildfire.org and wildfirerisk.org for\ninformation.\n\nA Fire Weather Watch means that critical fire weather conditions\nare likely to occur in the coming days. Residents near wildland\ninterfaces should prepare now on what to do if a wildfire breaks\nout. See readyforwildfire.org and wildfirerisk.org for\ninformation.",
   "area_desc": "Central Ventura County Valleys; Palos Verdes Hills; Los Angeles County Inland Coast including Downtown Los Angeles; Catalina and Santa Barbara Islands; Los Angeles County Beaches; Ventura County Beaches; Ventura County Inland Coast; Northern Ventura County Mountains; Malibu Coast; Eastern San Fernando Valley; Western Santa Monica Mountains Recreational Area; Southeastern Ventura County Valleys; Los Angeles County San Gabriel Valley; Santa Susana Mountains; Western San Gabriel Mountains and Highway 14 Corridor; Western San Fernando Valley; Eastern Santa Monica Mountains Recreational Area; Eastern San Gabriel Mountains; Santa Clarita Valley; Calabasas and Agoura Hills; Southern Ventura County Mountains; Interstate 5 Corridor",
   "ugcs": [
    "CAZ358",
    "CAZ367",
    "CAZ368",
    "CAZ287",
    "CAZ366",
    "CAZ354",
    "CAZ355",
    "CAZ377",
    "CAZ362",
    "CAZ373",
    "CAZ369",
    "CAZ374",
    "CAZ548",
    "CAZ375",
    "CAZ379",
    "CAZ372",
    "CAZ370",
    "CAZ380",
    "CAZ288",
    "CAZ371",
    "CAZ376",
    "CAZ378"
   ],
   "message_type": null,
   "status": "Actual",
   "covers_reported_location": true,
   "nearest_km": 0.0,
   "archived": true,
   "phase": "upcoming"
  }
 ],
 "zones": {
  "type": "FeatureCollection",
  "features": [
   {
    "type": "Feature",
    "id": "CAZ288",
    "geometry": {
     "type": "Polygon",
     "coordinates": [
      [
       [
        -118.591,
        34.555
       ],
       [
        -118.541,
        34.529
       ],
       [
        -118.523,
        34.513
       ],
       [
        -118.449,
        34.499
       ],
       [
        -118.384,
        34.458
       ],
       [
        -118.371,
        34.425
       ],
       [
        -118.422,
        34.384
       ],
       [
        -118.473,
        34.372
       ],
       [
        -118.545,
        34.362
       ],
       [
        -118.619,
        34.387
       ],
       [
        -118.714,
        34.515
       ],
       [
        -118.674,
        34.488
       ],
       [
        -118.653,
        34.541
       ],
       [
        -118.621,
        34.576
       ],
       [
        -118.591,
        34.555
       ]
      ]
     ]
    },
    "properties": {
     "ugc": "CAZ288",
     "name": "Santa Clarita Valley",
     "alert_ids": [
      "2025-KLOX-FW-W-0001",
      "2025-KLOX-FW-A-0001"
     ]
    }
   },
   {
    "type": "Feature",
    "id": "CAZ366",
    "geometry": {
     "type": "MultiPolygon",
     "coordinates": [
      [
       [
        [
         -118.392,
         33.979
        ],
        [
         -118.182,
         33.761
        ],
        [
         -118.193,
         33.733
        ],
        [
         -118.267,
         33.735
        ],
        [
         -118.258,
         33.759
        ],
        [
         -118.268,
         33.758
        ],
        [
         -118.275,
         33.746
        ],
        [
         -118.351,
         33.727
        ],
        [
         -118.419,
         33.76
        ],
        [
         -118.398,
         33.846
        ],
        [
         -118.441,
         33.977
        ],
        [
         -118.457,
         33.974
        ],
        [
         -118.497,
         34.01
        ],
        [
         -118.392,
         33.979
        ]
       ]
      ],
      [
       [
        [
         -118.182,
         33.76
        ],
        [
         -118.181,
         33.76
        ],
        [
         -118.181,
         33.76
        ],
        [
         -118.182,
         33.76
        ]
       ]
      ]
     ]
    },
    "properties": {
     "ugc": "CAZ366",
     "name": "Los Angeles County Beaches",
     "alert_ids": [
      "2025-KLOX-FW-W-0001",
      "2025-KLOX-FW-A-0001"
     ]
    }
   },
   {
    "type": "Feature",
    "id": "CAZ373",
    "geometry": {
     "type": "Polygon",
     "coordinates": [
      [
       [
        -118.388,
        34.221
       ],
       [
        -118.362,
        34.307
       ],
       [
        -118.303,
        34.285
       ],
       [
        -118.258,
        34.24
       ],
       [
        -118.191,
        34.172
       ],
       [
        -118.225,
        34.147
       ],
       [
        -118.233,
        34.118
       ],
       [
        -118.264,
        34.111
       ],
       [
        -118.288,
        34.117
       ],
       [
        -118.313,
        34.119
       ],
       [
        -118.358,
        34.122
       ],
       [
        -118.371,
        34.127
       ],
       [
        -118.386,
        34.121
       ],
       [
        -118.407,
        34.13
       ],
       [
        -118.388,
        34.221
       ]
      ]
     ]
    },
    "properties": {
     "ugc": "CAZ373",
     "name": "Eastern San Fernando Valley",
     "alert_ids": [
      "2025-KLOX-FW-W-0001",
      "2025-KLOX-FW-A-0001"
     ]
    }
   },
   {
    "type": "Feature",
    "id": "CAZ380",
    "geometry": {
     "type": "Polygon",
     "coordinates": [
      [
       [
        -118.138,
        34.274
       ],
       [
        -117.997,
        34.352
       ],
       [
        -118.0,
        34.475
       ],
       [
        -117.828,
        34.431
       ],
       [
        -117.657,
        34.425
       ],
       [
        -117.678,
        34.165
       ],
       [
        -117.703,
        34.152
       ],
       [
        -117.74,
        34.152
       ],
       [
        -117.793,
        34.138
       ],
       [
        -117.839,
        34.166
       ],
       [
        -117.861,
        34.186
       ],
       [
        -117.895,
        34.172
       ],
       [
        -117.954,
        34.161
       ],
       [
        -118.022,
        34.183
       ],
       [
        -118.134,
        34.206
       ],
       [
        -118.286,
        34.257
       ],
       [
        -118.138,
        34.274
       ]
      ]
     ]
    },
    "properties": {
     "ugc": "CAZ380",
     "name": "Eastern San Gabriel Mountains",
     "alert_ids": [
      "2025-KLOX-FW-W-0001",
      "2025-KLOX-FW-A-0001"
     ]
    }
   }
  ]
 },
 "area_bbox": [
  -118.3774,
  33.9605,
  -117.7993,
  34.4396
 ],
 "reported_location": [
  -118.069155,
  34.203483
 ]
}

// Cooley Fire, live: no Red Flag Warning or Fire Weather Watch in effect (Oct 18, 2026)
export const FW_COOLEY_LIVE_QUIET: FireWeatherResponse = {
 "kind": "fire_weather",
 "status": "available",
 "reason_code": null,
 "reason": null,
 "source": {
  "name": "National Weather Service",
  "url": "https://www.weather.gov/",
  "credit": "National Weather Service",
  "license": "U.S. Government work in the public domain; api.weather.gov data is open data, free to use for any purpose",
  "terms_url": "https://www.weather.gov/disclaimer"
 },
 "retrieved_ms": 1792343102962,
 "source_updated_ms": 1792342800000,
 "requested_at_ms": null,
 "now_ms": 1792343162755,
 "incident_id": "2026-cooley-fire-0c342f",
 "caveats": [
  "No Red Flag Warning or Fire Weather Watch from the National Weather Service is in effect near this fire right now. That is not an all-clear: follow local officials.",
  "A Red Flag Warning or Fire Weather Watch is a weather alert about fire danger, not an evacuation order. Follow local officials."
 ],
 "alerts": [],
 "zones": {
  "type": "FeatureCollection",
  "features": []
 },
 "area_bbox": [
  -123.4681,
  38.6227,
  -122.9259,
  39.0457
 ],
 "reported_location": [
  -123.205859,
  38.833351
 ]
}

// Live NWS Red Flag Warning LOX FW.W #5 (Oct 17, 2026): two CAP messages (segments) of one VTEC event, normalized by the backend's nws.normalize_alert; phase at Oct 17 11:00 PDT
export const NWS_LIVE_LOX_RFW: NwsAlert[] = [
 {
  "id": "urn:oid:2.49.0.1.840.0.471a752cfb304d358eb27b2608f7c2c48c784049.002.1",
  "url": "https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.471a752cfb304d358eb27b2608f7c2c48c784049.002.1",
  "office_url": "https://www.weather.gov/lox",
  "event": "Red Flag Warning",
  "vtec": {
   "office": "KLOX",
   "phenomena": "FW",
   "significance": "W",
   "etn": 5,
   "action": "CON"
  },
  "sender_name": "NWS Los Angeles/Oxnard CA",
  "sent_ms": 1792253460000,
  "effective_ms": 1792253460000,
  "onset_ms": 1792253460000,
  "expires_ms": 1792282500000,
  "ends_ms": 1792292400000,
  "headline": "Red Flag Warning issued October 17 at 9:11AM PDT until October 17 at 8:00PM PDT by NWS Los Angeles/Oxnard CA",
  "nws_headline": "RED FLAG WARNING REMAINS IN EFFECT UNTIL 8 PM PDT THIS EVENING FOR GUSTY NORTHEAST TO EAST WINDS AND LOW RELATIVE HUMIDITY FOR MOST VALLEYS AND COASTS OF LOS ANGELES AND VENTURA COUNTIES",
  "description": "...RISK FOR RAPID FIRE GROWTH AND EXTREME FIRE BEHAVIOR WITH ANY\nNEW FIRE STARTS TODAY, DUE TO GUSTY SANTA ANA WINDS WITH VERY WARM\nAND DRY CONDITIONS...\n\nOffshore winds are not as strong or widespread as the past couple\nof days, but will still create a risk for new fires to have rapid\ngrowth in wind prone areas of LA/Ventura counties due to the very\nwarm and dry conditions. By this afternoon, offshore winds may\nweaken sufficiently to allow some Red Flag Warning areas to be\ncancelled early.\n\n* AFFECTED AREA...Santa Clarita Valley, Ventura County Beaches,\nVentura County Inland Coast, Lake Casitas, Ojai Valley,\nCentral Ventura County Valleys, Malibu Coast, Calabasas and\nAgoura Hills, Western San Fernando Valley, Eastern San\nFernando Valley, Southeastern Ventura County Valleys and Los\nAngeles County San Gabriel Valley.\n\n* TIMING...Until 8 PM PDT this evening.\n\n* WINDS...Northeast to east 15 to 25 mph with gusts of 30 to 40\nmph, gradually diminishing in the afternoon. Strongest winds\nin Ventura county and eastern San Gabriel Valley foothills.\n\n* RELATIVE HUMIDITY...Minimums of 10 to 20 percent common.\n\n* IMPACTS...If fire ignition occurs, conditions are favorable\nfor extreme fire behavior which would threaten life and\nproperty.",
  "instruction": "A Red Flag Warning means that critical fire weather conditions\nare either occurring now, or will shortly. Use extreme caution\nwith anything that can spark a wildfire. Residents near wildland\ninterfaces should be prepared to evacuate if a wildfire breaks\nout. See readyforwildfire.org and wildfirerisk.org for\ninformation.",
  "area_desc": "Santa Clarita Valley; Ventura County Beaches; Ventura County Inland Coast; Lake Casitas; Ojai Valley; Central Ventura County Valleys; Malibu Coast; Calabasas and Agoura Hills; Western San Fernando Valley; Eastern San Fernando Valley; Southeastern Ventura County Valleys; Los Angeles County San Gabriel Valley",
  "ugcs": [
   "CAZ288",
   "CAZ354",
   "CAZ355",
   "CAZ356",
   "CAZ357",
   "CAZ358",
   "CAZ362",
   "CAZ371",
   "CAZ372",
   "CAZ373",
   "CAZ374",
   "CAZ548"
  ],
  "message_type": "Update",
  "status": "Actual",
  "archived": false,
  "phase": "in_effect",
  "covers_reported_location": null,
  "nearest_km": null
 },
 {
  "id": "urn:oid:2.49.0.1.840.0.471a752cfb304d358eb27b2608f7c2c48c784049.001.1",
  "url": "https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.471a752cfb304d358eb27b2608f7c2c48c784049.001.1",
  "office_url": "https://www.weather.gov/lox",
  "event": "Red Flag Warning",
  "vtec": {
   "office": "KLOX",
   "phenomena": "FW",
   "significance": "W",
   "etn": 5,
   "action": "CON"
  },
  "sender_name": "NWS Los Angeles/Oxnard CA",
  "sent_ms": 1792253460000,
  "effective_ms": 1792253460000,
  "onset_ms": 1792253460000,
  "expires_ms": 1792282500000,
  "ends_ms": 1792292400000,
  "headline": "Red Flag Warning issued October 17 at 9:11AM PDT until October 17 at 8:00PM PDT by NWS Los Angeles/Oxnard CA",
  "nws_headline": "RED FLAG WARNING REMAINS IN EFFECT UNTIL 8 PM PDT THIS EVENING FOR GUSTY NORTHEAST TO EAST WINDS AND LOW RELATIVE HUMIDITY FOR THE MOUNTAINS AND FOOTHILLS OF LOS ANGELES AND VENTURA COUNTIES",
  "description": "...RISK FOR RAPID FIRE GROWTH AND EXTREME FIRE BEHAVIOR WITH ANY\nNEW FIRE STARTS TODAY, DUE TO GUSTY SANTA ANA WINDS WITH VERY WARM\nAND DRY CONDITIONS...\n\nOffshore winds are not as strong or widespread as the past couple\nof days, but will still create a risk for new fires to have rapid\ngrowth in wind prone areas of LA/Ventura counties due to the very\nwarm and dry conditions. By this afternoon, offshore winds may\nweaken sufficiently to allow some Red Flag Warning areas to be\ncancelled early.\n\n* AFFECTED AREA...Western Santa Monica Mountains Recreational\nArea, Eastern Santa Monica Mountains Recreational Area, Santa\nSusana Mountains, Southern Ventura County Mountains, Northern\nVentura County Mountains, Interstate 5 Corridor, Western San\nGabriel Mountains and Highway 14 Corridor, Eastern San Gabriel\nMountains, Western Antelope Valley Foothills and Eastern\nAntelope Valley Foothills.\n\n* TIMING...Until 8 PM PDT this evening.\n\n* WINDS...Northeast to east 29 to 30 mph with gusts 35 to 45 mph,\ngradually diminishing in the afternoon.\n\n* RELATIVE HUMIDITY...Minimums of 10 to 25 percent common.\n\n* IMPACTS...If fire ignition occurs, conditions are favorable\nfor extreme fire behavior which would threaten life and\nproperty.",
  "instruction": "A Red Flag Warning means that critical fire weather conditions\nare either occurring now, or will shortly. Use extreme caution\nwith anything that can spark a wildfire. Residents near wildland\ninterfaces should be prepared to evacuate if a wildfire breaks\nout. See readyforwildfire.org and wildfirerisk.org for\ninformation.",
  "area_desc": "Western Santa Monica Mountains Recreational Area; Eastern Santa Monica Mountains Recreational Area; Santa Susana Mountains; Southern Ventura County Mountains; Northern Ventura County Mountains; Interstate 5 Corridor; Western San Gabriel Mountains and Highway 14 Corridor; Eastern San Gabriel Mountains; Western Antelope Valley Foothills; Eastern Antelope Valley Foothills",
  "ugcs": [
   "CAZ369",
   "CAZ370",
   "CAZ375",
   "CAZ376",
   "CAZ377",
   "CAZ378",
   "CAZ379",
   "CAZ380",
   "CAZ381",
   "CAZ382"
  ],
  "message_type": "Update",
  "status": "Actual",
  "archived": false,
  "phase": "in_effect",
  "covers_reported_location": null,
  "nearest_km": null
 }
]

// Eaton Fire: CAL FIRE's final record (edited Aug 6, 2026, long after containment)
export const CALFIRE_EATON_PAST: CalFireResponse = {
 "kind": "calfire",
 "status": "available",
 "reason_code": null,
 "reason": null,
 "source": {
  "name": "CAL FIRE incident list",
  "url": "https://www.fire.ca.gov/incidents/2025/1/7/eaton-fire/",
  "credit": "CAL FIRE"
 },
 "retrieved_ms": 1792288031120,
 "source_updated_ms": 1786038441000,
 "requested_at_ms": null,
 "now_ms": 1792343142333,
 "incident_id": "2025-eaton-fire-dbfa57",
 "caveats": [
  "These are CAL FIRE's own numbers and update time, quoted as published; they can lag what is happening on the ground.",
  "Fire-3d records CAL FIRE's changes only since it first checked this incident (recording_since_ms); earlier changes are not available. A new CAL FIRE update time without new numbers is not listed as a change.",
  "CAL FIRE's list keeps only the latest record, so the update-by-update history of a past fire is not available. This is CAL FIRE's final record.",
  "CAL FIRE edited this record well after the fire was contained; its update time is that edit, not news from the fire."
 ],
 "incident_url": "https://www.fire.ca.gov/incidents/2025/1/7/eaton-fire/",
 "agencies": ", LA County Mental Health, LA County Dept. Public Works, Pasadena Water and Power, LA County Medical Examiner, LA County Public Health, Southern California Edison, Sierra Madre Fire Department, Gabrieleno Band of Mission Indians - Kizh Nation, Arcadia Fire Department, Southern California Gas, California National Guard",
 "current": {
  "acres": 14021.0,
  "percent_contained": 100.0,
  "is_active": false,
  "final": true,
  "updated_ms": 1786038441000,
  "extinguished_ms": 1738349322000
 },
 "changes": [],
 "recording_since_ms": 1792288031120
}

// Henderson Fire, live: current record, recording just started (no changes yet)
export const CALFIRE_HENDERSON_LIVE: CalFireResponse = {
 "kind": "calfire",
 "status": "available",
 "reason_code": null,
 "reason": null,
 "source": {
  "name": "CAL FIRE incident list",
  "url": "https://www.fire.ca.gov/incidents/2026/10/15/henderson-fire/",
  "credit": "CAL FIRE"
 },
 "retrieved_ms": 1792342686054,
 "source_updated_ms": 1792335669000,
 "requested_at_ms": null,
 "now_ms": 1792343142364,
 "incident_id": "2026-henderson-fire-3e3dfe",
 "caveats": [
  "These are CAL FIRE's own numbers and update time, quoted as published; they can lag what is happening on the ground.",
  "Fire-3d records CAL FIRE's changes only since it first checked this incident (recording_since_ms); earlier changes are not available. A new CAL FIRE update time without new numbers is not listed as a change."
 ],
 "incident_url": "https://www.fire.ca.gov/incidents/2026/10/15/henderson-fire/",
 "agencies": "United States Marine Corps, CAL FIRE, US Forest Service - Cleveland National Forest, California Governor's Office of Emergency Services",
 "current": {
  "acres": 3160.0,
  "percent_contained": 65.0,
  "is_active": true,
  "final": false,
  "updated_ms": 1792335669000,
  "extinguished_ms": null
 },
 "changes": [],
 "recording_since_ms": 1792341466243
}
