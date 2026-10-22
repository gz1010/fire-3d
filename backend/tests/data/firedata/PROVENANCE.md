# Where the firedata test samples come from

These files are read by:
- `tests/test_firedata_calfire.py`
- `tests/test_firedata_catalog.py`
- `tests/test_official_calfire.py`
- `tests/test_firedata_firms.py`
- `tests/test_firedata_perimeters.py`

The originals were recorded on 2026-10-16. They were never committed, because an unanchored `data/` rule in
`.gitignore` hid this folder. They were re-recorded on **2026-10-22** by `backend/scripts/record_test_samples_firedata.py`
from the same public sources. The tests were not changed.

To re-record, run `cd backend && uv run python scripts/record_test_samples_firedata.py`. The script:
- makes about 10 requests through `fire3d.http`, with its cache in a temporary folder;
- reads `FIRMS_MAP_KEY` from the environment or `.env`, and never prints or writes it;
- checks every sample against what the tests need before it writes anything.

Live data changes over time, so a later run picks different feed rows and today's version of each CAL FIRE record.
The selection rules below stay the same.

In the tables, "Real" means the rows are FIRMS', CAL FIRE's or WFIGS' own text, unchanged unless the file's section says otherwise.

## CAL FIRE (credit: CAL FIRE, https://www.fire.ca.gov/incidents)

### `calfire_2025.json`: real, unchanged

| | |
|---|---|
| Source | `https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=true&year=2025` (556 records) |
| Recorded | 2026-10-22 |
| Trimming | 8 records, chosen by UniqueId, kept in CAL FIRE's own list order |

The 8 records:
- Palisades Fire (23,448 ac)
- Eaton Fire (14,021 ac). Final, extinguished 2025-01-31T18:48:42Z, record updated 2026-08-06. Its AgencyNames starts with ", LA County Mental Health", verbatim.
- Sunset Fire (42.8 ac). Its name has a trailing space.
- Rosa Fire (105 ac, January). The 1,671 ac Rosa Fire of August is not included.
- Eaton Flood (Type "Flood", not a fire).
- Scout Fire (Type "Fire", 39 ac). The 2 ac "Wildfire" Scout Fire is not included.
- Catlett Fire (175 ac)
- Gifford Fire (131,612 ac, contained 2025-10-14T15:00:00Z)

That gives the tests:
- 3 fires of at least 300 ac;
- 2 fires between 100 and 300 ac;
- 7 fires in all, plus one non-fire;
- Eaton second in the list.

### `calfire_live.json`: real records, status set back to the 2026-10-16 live list

| | |
|---|---|
| Source | `https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=true&year=2026` (566 records) |
| Recorded | 2026-10-22 |
| Original | CAL FIRE's live list (`?inactive=false`), recorded on the evening of 2026-10-16 (after 02:25 UTC on 10-17). That list has changed since: today it holds Norte, Cooley and Soda. |

The six records the tests name are taken from the 2026 year list by UniqueId. They are kept in this order:
1. Timber Fire (Monterey)
2. Blue Fire (Shasta, Type "Fire")
3. Henderson Fire (Camp Pendleton)
4. Gall Fire
5. Scales Fire
6. Garden Grove HAZMAT (Type "Hazmat")

Values changed so the records match the live list of that evening:
- **All six:** `IsActive: true`, `Final: false`, `ExtinguishedDate: ""` and `ExtinguishedDateOnly: ""`. Blue, Gall and Scales were extinguished at 04:57 UTC on 10-17, about 2.5 h after the original recording. Timber and Henderson were extinguished later.
- **Garden Grove HAZMAT:** today's 2026 list shows it inactive. The tests check that it is filtered out of the live catalog as a non-fire incident, so it was active on the original live list.
- **Henderson Fire:** `AcresBurned: 2079.5`, `PercentContained: 20.0`, `Updated: "2026-10-17T02:25:15Z"` and `AgencyNames: ""`. These are the values the tests assert from the original recording. Today it shows 3,260 ac, 100 % contained and a list of agencies.

Values that may be newer than the original recording:
- the `Updated` and `PercentContained` of Timber, Blue, Gall and Scales;
- Gall's `AgencyNames`.

They are kept as recorded on 2026-10-22, because the values of 10-16 are unknown and no test reads them.

Everything else is CAL FIRE's text, unchanged. This includes Henderson's `Location`, which contains a U+2028 character.

## NASA FIRMS (credit: NASA FIRMS / LANCE / EOSDIS, https://firms.modaps.eosdis.nasa.gov)

These files are FIRMS' own CSV lines, unchanged unless the file's section says otherwise. FIRMS data are open (NASA Earth
Science Data and Information Policy), and the source must be acknowledged.

The area-API URLs below take `{MAP_KEY}` from the environment. The key is not recorded anywhere.
- `AREA` = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}`
- `FEED` = `https://firms.modaps.eosdis.nasa.gov/data/active_fire`

### Real, unchanged

| File | Source (recorded 2026-10-22) | Trimming |
|---|---|---|
| `modis_sp.csv` | `AREA/MODIS_SP/-118.25,34.10,-117.95,34.30/5/2025-01-07` (Eaton bbox, 123 rows) | 5 rows: the first type-0 row of each of the first five Terra/Aqua overpasses. The first row is 2025-01-08 `441` (04:41 UTC). Confidence values are numeric: 100, 100, 0, 81, 38. |
| `goes_nrt.csv` | `AREA/GOES_NRT/-118.25,34.10,-117.95,34.30/1/2025-01-09` (976 rows) | 9 rows from 00:00 to 00:40 UTC. Every regular G16/G18 row is kept (fire-mask code 30.0000), plus only the first two `G18FRP`/`G16FRP` rows. The first regular row is `20`, which is 00:20 UTC. |
| `landsat_nrt.csv` | `AREA/LANDSAT_NRT/-118.80,33.90,-117.80,34.40/4/2025-01-12` (40 rows) | The first 4 rows north of 34.0 N, from the Landsat 9 pass of 2025-01-14 18:28 UTC. Confidence values are M, M, L, H. There is no FRP column, and scan/track are pixel indices. |
| `viirs_snpp_feed.csv` | `FEED/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv` (2,877 rows) | 10 rows: the first 2 of each confidence word (`low`, `nominal`, `high`) inside `config.CA_BBOX` and the first 2 of each outside it, in feed order. The CA bbox rows include one in Nevada. |
| `modis_feed.csv` | `FEED/modis-c6.1/csv/MODIS_C6_1_USA_contiguous_and_Hawaii_24h.csv` (586 rows) | 8 rows: the first 2 `T` and the first 2 `A` rows inside the CA bbox, and the same outside it, in feed order. |

### `viirs_noaa20_sp.csv`: real rows, one value edited

Sources (recorded 2026-10-22):
- `AREA/VIIRS_NOAA20_SP/-118.25,34.10,-117.95,34.30/5/2025-01-07` (Eaton bbox, 538 rows);
- `AREA/VIIRS_NOAA20_SP/-155.35,19.35,-155.20,19.45/5/2025-01-07` (Kilauea summit).

The file holds 8 rows, sorted by time:
- the first type-2 row: a real static source near Glendale, 2025-01-07 10:07;
- the first rows of 2025-01-08 `949` with confidence n and h (09:49 UTC: an `acq_time` shorter than 4 digits);
- the first rows of 2025-01-08 `2108` with confidence l and h;
- the first row of 2025-01-09 `930` with confidence n;
- the first type-0 row of 2025-01-11 `852`;
- the first type-1 (volcano) row at Kilauea, 2025-01-07 11:53.

The one edited value is the `type` of the 2025-01-11 `852` row, changed from 0 to 3 ("offshore"). It is the only synthetic value in the FIRMS files. `test_fetch_area_requests_limiter_and_cache` needs every kept row inside the Eaton bbox, which is on land, so no real offshore detection can be there.

## NIFC WFIGS: synthetic

`wfigs_attrs.json` and `wfigs_geoms.geojson` hold a **synthetic** "Test Fire", as the docstring of
`test_firedata_perimeters.py` says.

The field names, types, aliases and lengths are real. They are copied from the WFIGS daily-perimeter layer description
(`https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Daily_Perimeters_Public/FeatureServer/0?f=json`,
fetched 2026-10-22). The attributes follow `fire3d.sources.perimeters.ATTR_FIELDS`. The files mimic an ArcGIS `f=json`
attribute query and an `f=geojson` geometry query.

Times are given relative to S = 2025-01-08T02:00Z.

The fire itself (IRWIN `{AAAAAAAA-0000-0000-0000-000000000001}`, discovered at S, contained at S + 20 d, cause Human):

| Record | Polygon time | Acres | What it shows |
|---|---|---|---|
| 101 | S + 20 h | no GISAcres | Exactly a 1 km² square around the CAL FIRE point (34.20, -118.07), so the geodesic area is used |
| 102 and 103 | S + 30 h | 500 and 502 | A correction: 103 wins and keeps the time |
| 104 | S + 30 h, edited at S + 40 h | 800 | A growth edit: a new observation at S + 40 h |
| 105 | 2026-05-12, a bulk-load date | 2300 | The final perimeter, re-dated to the containment time |

Records 102 to 105 are ellipses that grow to the south-west from the point.

Look-alikes that the matching must reject:

| Record | Why it is rejected |
|---|---|
| 106 | In Nevada (`US-NV`) |
| 107 | Prescribed (`RX`) |
| 108 | Another "Test" fire 50 km east. It is downloaded, then dropped for being more than 30 km away. |
| 109 | "Contest": matches `LIKE '%TEST%'` but not as a whole token |
| 110 | A "Test" fire discovered 400 days earlier |
