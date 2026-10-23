# Provenance: `backend/tests/data/pipeline_us/`

Read by `backend/tests/test_us_pipeline_perimeters.py` (the California perimeter regression of CONTRACT 14.12.8).

- **Recorded:** 2026-10-23, about 01:03 UTC, with `cd backend && uv run python scripts/record_test_samples_official.py
  --only perimeters` (about 15 polite requests to the NIFC WFIGS ArcGIS services; no key involved), **before** the
  brief-3 IRWIN path was added to `sources/perimeters.py`.
- **What each `perimeters_<fire>.json` holds:**
  - `args`: the arguments the build passes to `perimeters.fetch_perimeters` for that CAL FIRE fire (CAL FIRE's own
    name, point, start, acres and containment from its 2025 list; `end_ms` = start + 120 days);
  - `attrs`: every attribute query the brief-2 code made (key `layer URL|where|extra parameters`), with the records
    WFIGS returned, verbatim;
  - `geoms`: the perimeter geometries the code downloaded (key `layer URL|OBJECTID`), simplified to about 80 m
    (0.0008°, 4 decimals; 0.0002°, 5 decimals for the few small polygons that the coarse step would empty) to keep
    the files small;
  - `recorded_object_ids`: the OBJECTIDs the brief-2 code selected from the live answers;
  - `expected_object_ids`: the OBJECTIDs the same code selects when replaying the stored (simplified) data. The two
    lists are equal for all four fires (the recorder checks this before writing).
- **Fires:** Eaton Fire (2025, 3 perimeters), Palisades Fire (2025, 1), Madre Fire (2025, 28) and the TCU September
  Lightning Complex (2025, a CAL FIRE complex matched through `attr_CpxName`, 18).
- **Set by hand:** nothing besides the geometry simplification above (applied offline to the recorded answers; the
  replay was re-checked after it).
- **Terms:** NIFC WFIGS open data (public; "NIFC WFIGS" credited in the app).

## `landfire_black_cove_lf2025_fbfm40.tif`, `landfire_black_cove_lf2024_fbfm40.tif`

Read by `tests/test_us_pipeline_build.py::test_recorded_black_cove_window_switches_lf2025_to_lf2024` (the fallback of
us-pipeline's cut-line item (c): no active Southern or Eastern fire of 1,000 ac or more existed on 2026-10-23).

- **Recorded:** 2026-10-23, about 01:45 UTC, with `uv run python scripts/record_test_samples_official.py --only
  landfire` (2 requests to `lfps.usgs.gov`, no key).
- **What:** the raw GeoTIFF answers of LANDFIRE's `exportImage` for FBFM40 of LF2025 and LF2024 on a 64 x 64 grid of
  30 m cells (1.92 km square, EPSG:32617) centred on the Black Cove Fire's NIFC WFIGS point of origin (35.2856 N,
  82.2975 W, Polk County, North Carolina), exactly as `landfire.fetch_layer` asks for them. LF2025 has no fuel code
  in any cell (LANDFIRE 2025 is not released there yet); LF2024 has a fuel code in every cell. Nothing was edited.
- **Terms:** LANDFIRE products are public domain (as credited in the app).
