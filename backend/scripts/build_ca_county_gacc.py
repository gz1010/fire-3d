"""Build ``fire3d/data/ca_county_gacc.json``: the GACC of each California county, for CAL FIRE fires that no NIFC
WFIGS record matches (brief 3, CONTRACT 14.4; audit B-R23).

    cd backend && uv run python scripts/build_ca_county_gacc.py [--min-acres 10] [--share 0.8] [--dry-run]

One polite GET through ``fire3d.http``: the WFIGS all-years layer's statistics of California wildfires of 10 ac or
more, counted by ``POOCounty`` and ``GACC``. A county whose fires are >= 80 % one GACC gets that GACC; any other county
gets null ("accuracy not yet tested here"): CONTRACT 14.4 names Stanislaus, San Joaquin, Alpine, Imperial, Mono and
Sierra. No GACC polygons are used (their terms are unverified) and no county borrows a neighbour's GACC.

Source: NIFC WFIGS Incident Locations (all years), credit "NIFC WFIGS (IRWIN)"; the item licence is a disclaimer only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
_TMP = tempfile.TemporaryDirectory(prefix="fire3d-build-gacc-")
os.environ.setdefault("FIRE3D_CACHE_DIR", _TMP.name)

from fire3d import config  # noqa: E402
from fire3d import http as fhttp  # noqa: E402
from fire3d.sources import wfigs  # noqa: E402

config.USER_AGENT = "Fire-3d/0.1 county GACC builder (research prototype; one request per run)"
OUT = BACKEND / "fire3d" / "data" / "ca_county_gacc.json"


def county_key(name: str) -> str:
    """"Los Angeles County" / "LOS ANGELES" -> "los angeles" (the table's key)."""
    s = " ".join(str(name or "").lower().replace("county", " ").split())
    return s


def fetch_counts(min_acres: float) -> list[dict]:
    params = {
        "where": f"IncidentTypeCategory='WF' AND POOState='US-CA' AND IncidentSize>={min_acres:g}",
        "groupByFieldsForStatistics": "POOCounty,GACC",
        "outStatistics": json.dumps([{"statisticType": "count", "onStatisticField": "OBJECTID", "outStatisticFieldName": "n"}]),
        "f": "json",
    }
    data = fhttp.request("GET", wfigs.ALL_YEARS_URL, params=params, ttl_s=3600.0, timeout=120.0).json()
    if "features" not in data:
        raise SystemExit(f"WFIGS statistics: unexpected answer {str(data)[:200]}")
    return [f["attributes"] for f in data["features"]]


def build(rows: list[dict], share: float) -> dict[str, dict]:
    by_county: dict[str, dict[str, int]] = {}
    names: dict[str, str] = {}
    for r in rows:
        c, g, n = r.get("POOCounty"), r.get("GACC"), int(r.get("n") or 0)
        if not c or not g:
            continue
        k = county_key(c)
        names.setdefault(k, " ".join(str(c).split()).title())
        by_county.setdefault(k, {})[g] = by_county.get(k, {}).get(g, 0) + n
    out: dict[str, dict] = {}
    for k, counts in sorted(by_county.items()):
        total = sum(counts.values())
        top, n = max(counts.items(), key=lambda t: t[1])
        out[k] = {"name": names[k], "gacc": top if n >= share * total else None, "fires": total,
                  "counts": dict(sorted(counts.items(), key=lambda t: -t[1]))}
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--min-acres", type=float, default=10.0)
    ap.add_argument("--share", type=float, default=0.8)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    table = build(fetch_counts(a.min_acres), a.share)
    body = {
        "meta": {"source": "NIFC WFIGS Incident Locations (all years), statistics by POOCounty and GACC",
                 "url": wfigs.ALL_YEARS_URL, "credit": "NIFC WFIGS (IRWIN)", "retrieved": time.strftime("%Y-%m-%d", time.gmtime()),
                 "rule": f"California wildfires of {a.min_acres:g} ac or more; a county whose fires are >= {a.share:.0%} one "
                         "GACC gets it, any other county null (accuracy not yet tested here); no polygons, no neighbours",
                 "key": "county name, lower case, without 'County'"},
        "counties": table,
    }
    ambiguous = [v["name"] for v in table.values() if v["gacc"] is None]
    print(f"{len(table)} counties, {len(ambiguous)} without a GACC: {', '.join(ambiguous)}")
    if not a.dry_run:
        a.out.write_text(json.dumps(body, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {a.out}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        _TMP.cleanup()
