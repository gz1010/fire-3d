"""Re-record the offline Oregon evacuation samples in ``backend/tests/data/evacuations/``.

Read by ``tests/test_evacuations_sources.py`` (and the web dev preset through a hand copy in
``web/src/official/__fixtures__/samples.ts``). Run it from ``backend/``::

    uv run python scripts/record_test_samples_evacuations.py              # fetch, check, write
    uv run python scripts/record_test_samples_evacuations.py --dry-run    # fetch, check, write nothing

Four polite GET requests through ``fire3d.http`` (its cache in a temporary folder, never ``data/``):

* Oregon OEM "2026 Wildfire Evac History" (item c8b3c502f58045269f32737fa8f5c025), the snapshot of the live layer at
  2026-08-15 12:00-12:05 UTC (EV §6 recipe): the Fielders Mountain zones and the non-fire "HWY 229 Landslide" zone
  (2 requests: those names, then one zone of the same snapshot whose ``Fire_Name`` is null).
* The live layer "Evacuation Areas Public" description (fields, ``editingInfo``) and its ArcGIS item (licence field),
  1 request each, to check the field names and the terms basis again.

Only the fields of ``fire3d.sources.evacuations.OR_OEM_FIELDS`` are requested (plus the history layer's ``Date``,
dropped before writing, so the sample has the live layer's shape). The personal or account fields ``Editor_Name``,
``Editor_Email``, ``Editor_Phone``, ``created_user`` and ``last_edited_user`` are never requested; a check refuses to
write any sample that contains them. ``PROVENANCE.md`` next to the samples says what was recorded and when.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
OUT_DIR = BACKEND / "tests" / "data" / "evacuations"

_TMP = tempfile.TemporaryDirectory(prefix="fire3d-record-evacuations-")
os.environ["FIRE3D_CACHE_DIR"] = _TMP.name

from fire3d import config  # noqa: E402
from fire3d import http as fhttp  # noqa: E402
from fire3d.sources import evacuations as evac  # noqa: E402

config.USER_AGENT = "Fire-3d/0.1 test-sample recorder (research prototype; a few requests per run)"

HISTORY_URL = ("https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/2026_Wildfire_Evac_History/"
               "FeatureServer/0")
ITEM_JSON = "https://www.arcgis.com/sharing/rest/content/items/dd2bee51e3004dc4b1004df34fbd9e29"
SNAPSHOT = "Date >= TIMESTAMP '2026-08-15 12:00:00' AND Date < TIMESTAMP '2026-08-15 12:05:00'"
PERSONAL = re.compile(r"email|phone|user|editor|creator|submit", re.I)


def query(where: str, count: int | None = None) -> list[dict]:
    params = {"where": where, "outFields": ",".join(evac.OR_OEM_FIELDS + ("Date",)), "outSR": "4326",
              "geometryPrecision": "5", "orderByFields": "OBJECTID", "f": "geojson"}
    if count:
        params["resultRecordCount"] = str(count)
    data = fhttp.get_json(f"{HISTORY_URL}/query", params, ttl_s=3600, retries=1)
    if not isinstance(data, dict) or "error" in data:
        sys.exit(f"history layer error: {data!r:.300}")
    return data.get("features") or []


def live_shape(f: dict) -> dict:
    p = {k: v for k, v in (f.get("properties") or {}).items() if k in evac.OR_OEM_FIELDS}
    return {"type": "Feature", "id": f.get("id"), "geometry": f.get("geometry"), "properties": p}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    named = query(f"Fire_Name IN ('Fielders Mountain','HWY 229 Landslide') AND {SNAPSHOT}")
    unnamed = query(f"Fire_Name IS NULL AND Fire_Evacuation_Level IS NOT NULL AND {SNAPSHOT}", count=1)
    info = fhttp.get_json(evac.OR_OEM_LAYER_URL, {"f": "json"}, ttl_s=3600, retries=1)
    item = fhttp.get_json(ITEM_JSON, {"f": "json"}, ttl_s=3600, retries=1)
    feats = [live_shape(f) for f in named + unnamed]
    # checks before anything is written
    levels = sorted({f["properties"].get("Fire_Evacuation_Level") for f in feats} - {None})
    hazards = sorted({f["properties"].get("HazardType") for f in feats} - {None})
    nulls = sum(1 for f in feats if f["properties"].get("Fire_Name") is None)
    print(f"zones {len(feats)} (named {len(named)}, Fire_Name null {nulls}); levels {levels}; hazards {hazards}")
    print(f"live layer fields: {len(info.get('fields') or [])}; editingInfo {info.get('editingInfo')}")
    print(f"item licenseInfo {item.get('licenseInfo')!r}; accessInformation {item.get('accessInformation')!r}")
    if len(named) < 10 or nulls != 1 or levels != [1, 2, 3] or "Other" not in hazards:
        sys.exit("unexpected sample: nothing written")
    blob = json.dumps(feats)
    if any(PERSONAL.search(k) for f in feats for k in f["properties"]):
        sys.exit("personal field in the sample: nothing written")
    live_fields = {f["name"] for f in info.get("fields") or []}
    missing = [k for k in evac.OR_OEM_FIELDS if k not in live_fields]
    if missing:
        sys.exit(f"live layer lacks {missing}: nothing written")
    if a.dry_run:
        print("dry run: nothing written")
        return
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sample = {"type": "FeatureCollection", "features": feats}
    (OUT_DIR / "or_oem_2026-08-15T1200Z.geojson").write_text(json.dumps(sample, indent=1) + "\n")
    layer = {"name": info.get("name"), "objectIdField": info.get("objectIdField"),
             "maxRecordCount": info.get("maxRecordCount"), "editingInfo": info.get("editingInfo"),
             "field_count": len(live_fields), "whitelisted_fields_present": list(evac.OR_OEM_FIELDS)}
    (OUT_DIR / "or_oem_layer_info.json").write_text(json.dumps(layer, indent=1) + "\n")
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    print(f"wrote {len(feats)} zones ({len(blob)} bytes of JSON) at {stamp}")


if __name__ == "__main__":
    main()
