"""Build the offline region files of ``fire3d.regions`` (brief 3, CONTRACT 14.3).

    cd backend && uv run python scripts/build_us_regions.py [--out-dir fire3d/data] [--dry-run]

Writes three GeoJSON FeatureCollections to ``backend/fire3d/data/`` (each with a top-level ``meta`` member naming its
sources, licences, retrieval date and simplification):

* ``us_states.geojson``: the 48 states + DC from Census TIGERweb ``State_County/MapServer/0`` (``STUSAB``, ``NAME``,
  ``GEOID``), generalized server-side to 0.005 degrees.
* ``us_counties.geojson``: the counties (and county equivalents) of the 48 states + DC from TIGERweb
  ``State_County/MapServer/1`` (``GEOID``, ``NAME``, ``STATE``), generalized to 0.01 degrees.
* ``us_timezones.geojson``: USDOT BTS NTAD "Time Zones" (Eastern, Central, Mountain, Pacific), generalized to 0.005
  degrees, plus the Navajo Nation Reservation and the Hopi Reservation from TIGERweb ``AIANNHA/MapServer/2`` (Federal
  American Indian Reservations). ``fire3d.regions`` maps them to IANA zones: Arizona is America/Phoenix except the
  Navajo Nation (America/Denver), and the Hopi Reservation inside it stays America/Phoenix.

Sources and terms (checked 2026-10-23):
* Census TIGERweb: a U.S. Government work in the public domain; the services carry "Source: U.S. Census Bureau".
  Credit "Boundaries: U.S. Census Bureau TIGERweb".
* USDOT BTS NTAD Time Zones: the layer's own description: "This NTAD dataset is a work of the United States
  government as defined in 17 U.S.C. § 101 and as such are not protected by any U.S. copyrights. This work is available
  for unrestricted public use." Credit "Time zones: USDOT BTS NTAD".

About 12 polite GETs through ``fire3d.http`` (identifying User-Agent; cache in a temporary folder, never ``data/``).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
_TMP = tempfile.TemporaryDirectory(prefix="fire3d-build-regions-")
os.environ.setdefault("FIRE3D_CACHE_DIR", _TMP.name)

from fire3d import config  # noqa: E402
from fire3d import http as fhttp  # noqa: E402

config.USER_AGENT = "Fire-3d/0.1 region builder (research prototype; a few requests per run)"

TIGER = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb"
STATES_URL = TIGER + "/State_County/MapServer/0/query"
COUNTIES_URL = TIGER + "/State_County/MapServer/1/query"
AIANNH_URL = TIGER + "/AIANNHA/MapServer/2/query"
NTAD_TZ_URL = "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Time_Zones/FeatureServer/0/query"

# USPS code and FIPS of the 48 states + DC
L48_FIPS = {
    "AL": "01", "AZ": "04", "AR": "05", "CA": "06", "CO": "08", "CT": "09", "DE": "10", "DC": "11", "FL": "12", "GA": "13",
    "ID": "16", "IL": "17", "IN": "18", "IA": "19", "KS": "20", "KY": "21", "LA": "22", "ME": "23", "MD": "24", "MA": "25",
    "MI": "26", "MN": "27", "MS": "28", "MO": "29", "MT": "30", "NE": "31", "NV": "32", "NH": "33", "NJ": "34", "NM": "35",
    "NY": "36", "NC": "37", "ND": "38", "OH": "39", "OK": "40", "OR": "41", "PA": "42", "RI": "44", "SC": "45", "SD": "46",
    "TN": "47", "TX": "48", "UT": "49", "VT": "50", "VA": "51", "WA": "53", "WV": "54", "WI": "55", "WY": "56",
}
TZ_IANA = {"Pacific": "America/Los_Angeles", "Mountain": "America/Denver", "Central": "America/Chicago",
           "Eastern": "America/New_York"}
TIGER_SOURCE = {"name": "U.S. Census Bureau TIGERweb", "credit": "Boundaries: U.S. Census Bureau TIGERweb",
                "license": "Public domain (U.S. Government work); 'Source: U.S. Census Bureau'"}
NTAD_SOURCE = {"name": "USDOT BTS NTAD Time Zones", "url": NTAD_TZ_URL.rsplit("/query", 1)[0], "credit": "Time zones: USDOT BTS NTAD",
               "license": "This work is available for unrestricted public use (17 U.S.C. § 101 government work)",
               "terms_checked": "the layer's copyrightText, 2026-10-23"}


def _query(url: str, params: dict[str, Any], page: int = 0) -> list[dict]:
    """All features of an ArcGIS ``query`` as GeoJSON (paged by ``resultOffset`` when ``page`` > 0)."""
    feats: list[dict] = []
    offset = 0
    while True:
        p = {"f": "geojson", "outSR": "4326", "returnGeometry": "true", **params}
        if page:
            p.update(resultOffset=str(offset), resultRecordCount=str(page))
        resp = fhttp.request("GET", url, params=p, ttl_s=86400.0, timeout=180.0)
        data = resp.json()
        if not isinstance(data, dict) or "features" not in data:
            raise SystemExit(f"{url}: unexpected answer {str(data)[:200]}")
        got = data["features"]
        feats += got
        print(f"  {url.split('/services/')[-1]} offset {offset}: {len(got)} features, {len(resp.content) / 1024:.0f} KB")
        if not page or len(got) < page:
            return feats
        offset += page
        time.sleep(0.5)


def _round_coords(geom: dict, nd: int = 4) -> dict:
    def r(c: Any) -> Any:
        return [round(float(c[0]), nd), round(float(c[1]), nd)] if c and isinstance(c[0], (int, float)) else [r(x) for x in c]

    return {"type": geom["type"], "coordinates": r(geom["coordinates"])}


def _fc(features: list[dict], meta: dict) -> dict:
    return {"type": "FeatureCollection", "meta": meta, "features": features}


def build_states() -> dict:
    where = "STUSAB IN (" + ",".join(f"'{s}'" for s in L48_FIPS) + ")"
    raw = _query(STATES_URL, {"where": where, "outFields": "STUSAB,NAME,GEOID", "maxAllowableOffset": "0.005",
                              "geometryPrecision": "4"})
    feats = []
    for f in raw:
        p = f.get("properties") or {}
        if p.get("STUSAB") in L48_FIPS and f.get("geometry"):
            feats.append({"type": "Feature", "properties": {"state": p["STUSAB"], "name": p["NAME"], "fips": p["GEOID"]},
                          "geometry": _round_coords(f["geometry"])})
    feats.sort(key=lambda f: f["properties"]["state"])
    if len(feats) != 49:
        raise SystemExit(f"states: expected 49 features (48 + DC), got {len(feats)}")
    return _fc(feats, {"source": {**TIGER_SOURCE, "url": STATES_URL.rsplit('/query', 1)[0]}, "retrieved": _today(),
                       "simplification_deg": 0.005, "features": "48 states + DC"})


def build_counties() -> dict:
    where = "STATE IN (" + ",".join(f"'{v}'" for v in sorted(L48_FIPS.values())) + ")"
    raw = _query(COUNTIES_URL, {"where": where, "outFields": "GEOID,NAME,STATE", "maxAllowableOffset": "0.01",
                                "geometryPrecision": "3", "orderByFields": "GEOID"}, page=400)
    by_fips = {v: k for k, v in L48_FIPS.items()}
    feats = []
    for f in raw:
        p = f.get("properties") or {}
        st = by_fips.get(str(p.get("STATE")))
        if st and f.get("geometry"):
            feats.append({"type": "Feature", "properties": {"fips": p["GEOID"], "name": p["NAME"], "state": st},
                          "geometry": _round_coords(f["geometry"], 3)})
    feats.sort(key=lambda f: f["properties"]["fips"])
    if len(feats) < 3000:
        raise SystemExit(f"counties: only {len(feats)} features")
    return _fc(feats, {"source": {**TIGER_SOURCE, "url": COUNTIES_URL.rsplit('/query', 1)[0]}, "retrieved": _today(),
                       "simplification_deg": 0.01, "features": "counties and equivalents of the 48 states + DC"})


def build_timezones() -> dict:
    raw = _query(NTAD_TZ_URL, {"where": "zone IN ('Eastern','Central','Mountain','Pacific')", "outFields": "zone,utc",
                               "maxAllowableOffset": "0.005", "geometryPrecision": "4"})
    feats = []
    for f in raw:
        z = (f.get("properties") or {}).get("zone")
        if z in TZ_IANA and f.get("geometry"):
            feats.append({"type": "Feature", "properties": {"kind": "ntad", "zone": z, "tz": TZ_IANA[z], "priority": 1},
                          "geometry": _round_coords(f["geometry"])})
    if len(feats) != 4:
        raise SystemExit(f"time zones: expected 4 NTAD zones, got {len(feats)}")
    res = _query(AIANNH_URL, {"where": "NAME LIKE 'Navajo Nation%' OR NAME LIKE 'Hopi%'", "outFields": "*",
                              "maxAllowableOffset": "0.005", "geometryPrecision": "4"})
    for f in res:
        p = f.get("properties") or {}
        name = str(p.get("NAME") or p.get("BASENAME") or "")
        if not f.get("geometry"):
            continue
        if name.startswith("Hopi"):
            props = {"kind": "reservation", "name": name, "geoid": p.get("GEOID"), "tz": "America/Phoenix", "priority": 3}
        elif name.startswith("Navajo Nation"):
            props = {"kind": "reservation", "name": name, "geoid": p.get("GEOID"), "tz": "America/Denver", "priority": 2}
        else:
            continue
        feats.append({"type": "Feature", "properties": props, "geometry": _round_coords(f["geometry"])})
    names = [f["properties"].get("name") for f in feats if f["properties"]["kind"] == "reservation"]
    if not any(str(n).startswith("Hopi") for n in names) or not any(str(n).startswith("Navajo") for n in names):
        raise SystemExit(f"time zones: Navajo Nation and Hopi Reservation expected, got {names}")
    return _fc(feats, {"sources": [NTAD_SOURCE, {**TIGER_SOURCE, "url": AIANNH_URL.rsplit('/query', 1)[0],
                                                 "layer": "Federal American Indian Reservations"}],
                       "retrieved": _today(), "simplification_deg": 0.005,
                       "iana": {**TZ_IANA, "Arizona": "America/Phoenix", "Navajo Nation": "America/Denver",
                                "Hopi Reservation": "America/Phoenix"},
                       "rule": "highest priority feature containing the point wins (Hopi 3 > Navajo 2 > NTAD 1); an NTAD "
                               "Mountain point in Arizona outside the Navajo Nation is America/Phoenix"})


def _today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _write(path: Path, fc: dict) -> None:
    lines = ['{"type": "FeatureCollection",', f'"meta": {json.dumps(fc["meta"], ensure_ascii=False)},', '"features": [']
    lines.append(",\n".join(json.dumps(f, ensure_ascii=False, separators=(",", ":")) for f in fc["features"]))
    lines.append("]}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {path} ({path.stat().st_size / 1024:.0f} KB, {len(fc['features'])} features)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out-dir", type=Path, default=BACKEND / "fire3d" / "data")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", choices=("states", "counties", "timezones"), action="append")
    a = ap.parse_args()
    todo = a.only or ["states", "counties", "timezones"]
    builders = {"states": ("us_states.geojson", build_states), "counties": ("us_counties.geojson", build_counties),
                "timezones": ("us_timezones.geojson", build_timezones)}
    for key in todo:
        name, fn = builders[key]
        print(f"{key}:")
        fc = fn()
        if not a.dry_run:
            _write(a.out_dir / name, fc)


if __name__ == "__main__":
    main()
