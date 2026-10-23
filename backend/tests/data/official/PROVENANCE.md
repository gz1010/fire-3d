# Provenance: `backend/tests/data/official/`

These files are read by `backend/tests/test_official_nws.py`. They are recorded copies of public National Weather
Service (NWS) and Iowa Environmental Mesonet (IEM) answers, cut down so the tests stay small and offline.

- **Recorded:** 2026-10-22.
- **Why again:** the first copies (recorded 2026-10-18) were never committed. An unanchored `data/` rule in
  `.gitignore` hid this folder. The tests were not changed. The new copies reproduce every value they assert.
- **How to re-record:** `cd backend && uv run python scripts/record_test_samples_official.py` (about 15 requests).
  The script trims the answers as described below. It checks each sample against what the tests need and writes
  nothing if a check fails. Add `--dry-run` to write nothing.
- **Requests:** made one at a time, at least a second apart, through `fire3d.http`. They send the User-Agent
  "Fire-3d/0.1 test-sample recorder (research prototype; a few requests per run)". No key is needed, and none is in
  these files (count-only scan).

## Real or set by hand

Everything here is real upstream data. Only two values were set by hand, and both are timestamps on the collection
wrapper:

- the `updated` value of `nws_alerts_lox_rfw.json`;
- the `updated` value of `nws_alerts_ca_empty.json`.

Nothing was rebuilt from the IEM archive, because NWS still serves the Oct 17 2026 messages.

## Files

### `nws_alerts_lox_rfw.json`

- **What it is:** two real CAP messages from NWS Los Angeles/Oxnard (LOX). They belong to Red Flag Warning FW.W #5,
  action CON, sent 2026-10-17 09:11 PDT (WMO header `WWUS86 KLOX 171611`).
- **Sources:**
  - `https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.471a752cfb304d358eb27b2608f7c2c48c784049.002.1`
  - `https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.471a752cfb304d358eb27b2608f7c2c48c784049.001.1`
- **Same messages in NWS's list:**
  `https://api.weather.gov/alerts?area=CA&event=Red%20Flag%20Warning&start=2026-10-17T00:00:00Z&end=2026-10-18T06:00:00Z`
  returns these two messages with identical content. This was checked by hand on 2026-10-22.
- **Order:** the same as NWS lists them.
  1. `.002.1` covers the valleys and coasts: 12 zones, starting with CAZ288 and including CAZ362.
  2. `.001.1` covers the mountains: 10 zones, starting with CAZ369 and CAZ370.
- **Messages kept as sent.** This includes the `replacedBy` and `replacedAt` fields. NWS added them when it replaced
  the messages at 17:56 PDT, and Fire-3d's parser ignores them. The only change: each feature's own `@context` was
  removed, because members of a collection carry none.
- **The wrapper copies `/alerts/active`:**
  - `@context` and `title` come from today's `/alerts/active?area=CA` answer.
  - `updated` is **set** to `2026-10-17T16:20:00+00:00`. This is the moment both messages were in effect (the tests'
    `LOX_NOW`), as if the active list had been fetched then.

### `nws_alerts_ca_empty.json`

- **Source:** `https://api.weather.gov/alerts/active?area=CA&event=Red%20Flag%20Warning,Fire%20Weather%20Watch`. This
  is the same request the app makes.
- **What it is:** NWS's real answer of 2026-10-22, which had no features. It is a real NWS "none in effect"
  FeatureCollection. If a future run finds alerts in effect, the script empties `features` and says so.
- **What was changed:**
  - `updated` is **set back** to `2026-10-18T16:09:10+00:00`. That was the value in the original Oct 18 recording,
    and `test_endpoint_live_none_is_not_an_all_clear` asserts it.
  - A `pagination` key would be removed. Today's answer had none.

### `nws_zones_fire.json`

- **What it is:** a map of `{UGC: zone Feature}`, as `/zones/fire/{UGC}` returns each zone.
- **Sources (real):**

  | Zone | Source | Name | Office |
  |---|---|---|---|
  | CAZ243 | `https://api.weather.gov/zones/fire/CAZ243` | San Diego County Coastal Areas | SGX |
  | CAZ288 | `https://api.weather.gov/zones/fire/CAZ288` | Santa Clarita Valley | LOX |
  | CAZ362 | `https://api.weather.gov/zones/fire/CAZ362` | Malibu Coast | LOX |
  | CAZ369 | `https://api.weather.gov/zones/fire/CAZ369` | Western Santa Monica Mountains Recreational Area | LOX |
  | CAZ370 | `https://api.weather.gov/zones/fire/CAZ370` | Eastern Santa Monica Mountains Recreational Area | LOX |

- **Kept unchanged:** `id`, `type` and `properties`. Each feature's `@context` was removed.
- **Geometry simplified:**
  - shapely `simplify(0.0002°)` (about 20 m), with the shape's topology kept;
  - coordinates snapped to 1e-5°.
- **Why this level:** the outline stays finer than the app's own 100 m display outline. The test
  `test_simplified_zone_outline_is_small_and_valid` relies on that.
- **Checked:**
  - the Henderson point lies in CAZ243;
  - the Palisades point lies in CAZ370 and not in CAZ362;
  - CAZ362 is 0 to 10 km from Palisades.
- **Size:** raw answers were 6 to 113 KB per zone. The recorded file is 30 KB.

### `iem_bypoint_eaton.json`

- **Source:**
  `https://mesonet.agron.iastate.edu/json/vtec_events_bypoint.py?lat=34.2035&lon=-118.0692&sdate=2025-01-05&edate=2025-01-12`
- **What it is:** the real answer at the Eaton Fire's reported location, which lies in zone CAZ380 (Eastern San
  Gabriel Mountains). It is unchanged.
- **Contents:** 12 events: FW.W #1 and #2, FW.A #1 and #2, plus High Wind and Wind Advisory events, which the app
  ignores.

### `iem_event_lox_fw_w_1.json`, `iem_event_lox_fw_a_1.json`, `iem_event_lox_fw_w_2.json`, `iem_event_lox_fw_a_2.json`

- **Source:** `https://mesonet.agron.iastate.edu/json/vtec_event.py?wfo=LOX&year=2025&phenomena=FW&significance=<W|A>&etn=<1|2>`.
- **What it is:** real IEM answers. The per-zone rows (`ugcs`), the `report` (each event's first product) and every
  other key are unchanged.
- **Trimmed:** only `svs` (the later statements) was cut, to the products listed below. The text of each kept
  product is verbatim.

| File | Products kept (UTC `valid`) | Left out |
|---|---|---|
| `fw_w_1` | report 2025-01-05 22:40 (NEW); 01-07 22:37 (CON: the statement in force at Jan 8 noon PST); 01-09 00:01 (EXT to Friday); 01-10 22:48 (CAN) | 01-06 19:55, 01-06 23:24, 01-09 04:17, 01-09 18:27, 01-10 00:25, 01-10 17:53 |
| `fw_a_1` | report 2025-01-03 22:19 (NEW); 01-07 22:37; 01-09 00:01 (CAN for the Eaton zones) | 01-04 18:29, 01-04 21:24, 01-05 18:27, 01-05 22:40, 01-06 19:55, 01-06 23:24 |
| `fw_w_2` | report 2025-01-11 21:16 (NEW); 01-16 01:41 (EXP) | the 14 other statements of 01-12 to 01-16 |
| `fw_a_2` | report 2025-01-10 22:48 (NEW); 01-11 21:16 (UPG) | none |

- **The rule:** keep each event's first product, the statement in force at the Eaton replay time, and the products
  that changed the event (an extension, cancellation, upgrade or expiry).
- **Why the Jan 6 statements of FW.W #1 are left out:** `test_segment_at_follows_the_requested_time` expects the first
  product to be the latest one with an Eaton (CAZ380) segment by 2025-01-07 12:00 UTC.
- **Size:** the raw answers were 12 to 117 KB each.

### `iem_geojson_lox_fw_w_1.json`

- **Source:** `https://mesonet.agron.iastate.edu/geojson/vtec_event.py?wfo=LOX&year=2025&phenomena=FW&significance=W&etn=1`
- **What it is:** the real zone polygons of FW.W #1. It has 28 features, in IEM's order and with IEM's properties.
  CAZ368 appears twice, as IEM sends it, and the parser merges the two.
- **Geometry simplified:**
  - shapely `simplify(0.001°)` (about 100 m, like the app's display outlines), with topology kept;
  - coordinates snapped to 1e-4°;
  - IEM's single-part MultiPolygon type kept.
- **Checked:**
  - every zone's area changed by less than 1 %;
  - only CAZ380 covers the Eaton point after simplification.
- **Use in the tests:** they serve this file for every `geojson/vtec_event.py` request, which includes FW.A #1.

## Licences and credit

- **NWS:** a U.S. Government work in the public domain ([NWS disclaimer](https://www.weather.gov/disclaimer)).
  Credit: National Weather Service.
- **IEM:** public domain ([IEM disclaimer](https://mesonet.agron.iastate.edu/disclaimer.php): "may be used freely by
  anyone for any lawful purpose"). It is an archived copy of NWS products, not an official NWS source. Credit:
  National Weather Service, archived copy via the Iowa Environmental Mesonet (Iowa State University).

## Brief 3 national samples (recorded 2026-10-23, about 00:58 UTC)

Re-record with `cd backend && uv run python scripts/record_test_samples_official.py --only national` (3 requests;
the relayed message below leaves NWS's 7-day list, so a later run will fail there and write nothing). Read by
`tests/test_local_alerts_nws.py` and `tests/test_openfema_parse.py`.

### `nws_alerts_national.json`

- **What it is:** the real national answer of
  `https://api.weather.gov/alerts/active?area=<the 48 states + DC>&event=Red Flag Warning,Fire Weather Watch,Fire
  Warning,Evacuation Immediate,Shelter In Place Warning,Civil Danger Warning,Civil Emergency Message,Local Area
  Emergency`, exactly the URL of `nws.national_url()`. Three Red Flag Warnings (Wyoming and Montana zones) and no
  local officials' message were in effect.
- **Set by hand:** nothing. `sender` values other than NWS's own `w-nws.webmaster@noaa.gov` would have been replaced
  by `redacted@example.invalid` (none were).

### `nws_nwem_cem_la.json`

- **What it is:** one real local officials' message relayed by NWS (a Non-Weather Emergency Message): Civil
  Emergency Message `v2-3.13.8-1556392-1792113838542`, Los Angeles County ("Public Alert System"; mentions the Bryson
  Fire), sent 2026-10-16 01:23:59 UTC but stamped `02:23:59+01:00` by the sender (the time-zone quirk the evacuations
  audit noted), from `https://api.weather.gov/alerts/v2-3.13.8-1556392-1792113838542`.
- **Set by hand:** the operator's `sender` address is replaced by `redacted@example.invalid`.

### `openfema_window_frw.json`

- **What it is:** a real OpenFEMA `IpawsArchivedAlerts` answer for `status eq 'Actual'` and `sent` from
  2026-10-09T21:00Z to 2026-10-10T03:00Z with the app's own `$select` (`openfema.window_params`). Kept: every
  message with an event code of `nws.LOCAL_CODES` (Kern County "Cyrus Fire" Fire Warnings with polygons, including an
  Update that references the first one; a Sheridan County WY Fire Warning without a polygon; a Sandoval County NM
  Shelter in Place Warning; Local Area Emergencies that are not about fire, including Long Beach's "Get sandbags-Fire
  Station 7"), plus one FFW, one TOR, one LEW and one Cancel to test the scope filter. 16 of the window's records.
- **Set by hand:** `sender` replaced by `redacted@example.invalid`; `originalMessage` cut to its `<references>`
  element with the sender addresses inside it replaced the same way; polygons rounded to 4 decimals;
  `metadata.count` set to the number kept and `metadata.rundate` removed. The LEW (Law Enforcement Warning) record
  is kept only for its event code: its WEA texts (`CMAMtext`, `CMAMlongtext`; its `description` is empty and it has
  no `headline` or `instruction`) are replaced by "Text removed by hand: a Law Enforcement Warning kept only for its
  event code (scope-filter test)." because the original named a private person (2026-10-23, review round 1). The
  recorder does the same (`TEXT_REMOVED_CODES`).
- **Terms:** OpenFEMA terms (https://www.fema.gov/about/openfema/terms-conditions): "This product uses the Federal
  Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA".
