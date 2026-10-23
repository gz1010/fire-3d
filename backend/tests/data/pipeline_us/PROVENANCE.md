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
