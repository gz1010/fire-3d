# Provenance: `backend/tests/data/terrain/`

This file is read by `backend/tests/test_terrain_sentinel.py`.

- **Recorded:** 2026-10-22.
- **Why again:** the first copy was never committed. An unanchored `data/` rule in `.gitignore` hid this folder. The
  tests were not changed.
- **How to re-record:** `cd backend && uv run python scripts/record_test_samples_official.py`. The same script
  re-records `tests/data/official/`, using one request for this file. It checks the item before writing.

## `stac_item_s2_11SLT_20250102.json`

- **Source:** `https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/S2A_11SLT_20250102_0_L2A`.
  This is Element 84 Earth Search STAC v1, collection `sentinel-2-l2a`.
- **What it is:** the real STAC item, real and unchanged apart from formatting (re-written as indented JSON). No
  value was set by hand.
- **Contents:**
  - every asset, including the JP2 copies;
  - the footprint geometry;
  - the links.
- **Key values:**

  | Field | Value |
  |---|---|
  | Satellite | Sentinel-2A |
  | Tile | MGRS 11SLT |
  | `datetime` | `2025-01-02T18:45:02.738000Z` |
  | `eo:cloud_cover` | 3.015763 |
  | `earthsearch:boa_offset_applied` | true |
  | Processing baseline | 05.11 |
  | `B08`, `B12` `raster:bands` | scale 0.0001, offset -0.1, nodata 0 |

- **Checked before writing:** the item parses with `fire3d.sources.sentinel.parse_scene`, and its footprint covers the
  whole Eaton Fire test grid (coverage 1.0).
- **No pixel data:** the recording holds no imagery. The tests use in-memory arrays and a local COG written at test
  time.

## Licence and credit

- **Imagery:** Sentinel-2 data falls under the
  [Copernicus Sentinel data legal notice](https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice),
  which gives free, full and open access with modification allowed. The item's own `license` link points to the same
  notice. Credit: "Contains modified Copernicus Sentinel data 2025".
- **Metadata:** the STAC metadata comes from Earth Search by Element 84, a free public STAC API.
