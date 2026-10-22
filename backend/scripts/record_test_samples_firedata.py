"""Re-record the offline samples in ``backend/tests/data/firedata/``.

The samples are read by ``tests/test_firedata_calfire.py``, ``test_firedata_catalog.py``, ``test_official_calfire.py``,
``test_firedata_firms.py`` and ``test_firedata_perimeters.py``. Run it from ``backend/``::

    uv run python scripts/record_test_samples_firedata.py              # fetch, trim, check, write
    uv run python scripts/record_test_samples_firedata.py --dry-run    # fetch, trim, check, write nothing

About 10 polite requests, made through ``fire3d.http`` with its cache in a temporary folder (never ``data/``):

* CAL FIRE ``IncidentApi/List`` for 2025 and 2026 (2 requests).
* NASA FIRMS area API (5 requests; needs ``FIRMS_MAP_KEY`` from the environment or ``.env``; the key is never
  printed or written, FIRMS CSV bodies do not contain it).
* NASA FIRMS keyless 24h CSV feeds for Suomi NPP VIIRS and MODIS (2 requests; the 7d feeds only if the 24h ones
  cannot satisfy the tests).
* The NIFC WFIGS daily-perimeter layer description (1 request), for the real field names and types of the
  synthetic perimeter sample.

How each file is trimmed, and which values are reconstructed or synthetic, is written down in
``tests/data/firedata/PROVENANCE.md``. Every sample is checked against what the tests need before anything is
written; a failed check stops the script and leaves the existing files alone.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
OUT_DIR = BACKEND / "tests" / "data" / "firedata"

# The shared HTTP cache normally lives in data/cache; keep this script's cache out of data/. This must happen before
# fire3d is imported, because fire3d.config reads FIRE3D_CACHE_DIR at import time.
_TMP = tempfile.TemporaryDirectory(prefix="fire3d-record-firedata-")
os.environ["FIRE3D_CACHE_DIR"] = _TMP.name

from fire3d import config
from fire3d import http as fhttp
from fire3d.sources.perimeters import ATTR_FIELDS
from fire3d.timeutil import DAY_MS, HOUR_MS, iso_to_ms

config.USER_AGENT = "Fire-3d/0.1 test-sample recorder (research prototype; a few requests per run)"

CALFIRE_URL = "https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List"
FIRMS = "https://firms.modaps.eosdis.nasa.gov"
AREA = FIRMS + "/api/area/csv/{key}/{product}/{bbox}/{days}/{day}"
FEED = FIRMS + "/data/active_fire/{dir}/csv/{prefix}_USA_contiguous_and_Hawaii_{window}.csv"
WFIGS_DAILY = ("https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/"
               "WFIGS_Daily_Perimeters_Public/FeatureServer/0")

EATON_BOX = "-118.25,34.10,-117.95,34.30"          # tests' EATON_BBOX, as fire3d formats it
LA_BOX = "-118.80,33.90,-117.80,34.40"             # bbox of test_detections_for_historical_with_key
KILAUEA_BOX = "-155.35,19.35,-155.20,19.45"         # Kilauea summit: real type-1 (volcano) VIIRS rows

# ------------------------------------------------------------------------------------------------------------------
# CAL FIRE
# ------------------------------------------------------------------------------------------------------------------
# calfire_2025.json: these 2025 records, in CAL FIRE's own list order, unchanged.
Y2025_UIDS = {
    "abfed7a3-794a-4294-9852-43176dcbc18a": "Palisades Fire",
    "dbfa574e-1b10-4467-b5e5-7d1c06ebc8dc": "Eaton Fire",
    "3b0d8af8": "Sunset Fire",                     # matched by prefix (a small fire < 100 ac)
    "460e65e4-366e-46d1-8729-7d1756fca41a": "Rosa Fire",        # the 105 ac January fire, not the 1,671 ac one
    "d49b7509-2632-4153-8252-ec4de0e385ff": "Eaton Flood",      # Type "Flood": not a fire
    "c59146ec-ab73-416a-b66f-e4b568f5208a": "Scout Fire",       # Type "Fire" (not "Wildfire")
    "01fa37af-7ca8-4d5a-bdfc-60888a4b444f": "Catlett Fire",
    "fb7c1cc7-8104-4776-b89e-fd27cb9b7be9": "Gifford Fire",
}
# calfire_live.json: CAL FIRE's live list as the original sample recorded it (2026-10-16, about 19:30 PDT). These
# records are taken from today's 2026 year list, in this order, and set back to the live-list state of that evening.
LIVE_UIDS = [
    "b7e4a30e-67ab-4964-882e-751da30b44e0",   # Timber Fire (Monterey)
    "e0b9c338-3d82-44c1-b5ac-be584e3a8c6b",   # Blue Fire (Shasta, Type "Fire")
    "3e3dfee3-8214-4341-a777-6b0ad643c9af",   # Henderson Fire (Camp Pendleton)
    "90bc47dd-3c58-422d-9374-039aa6ef4de2",   # Gall Fire (Siskiyou)
    "ec207bc6-a379-4462-8671-d2b99e271d3e",   # Scales Fire (Camp Pendleton)
    "4e779b08-433e-4492-9975-b76ff878b1c4",   # Garden Grove HAZMAT (Type "Hazmat")
]
# Every record was on the live list then: active, not final, not extinguished (the three small fires were
# extinguished about 2.5 h after the recording, Timber and Henderson later).
LIVE_STATE = {"IsActive": True, "Final": False, "ExtinguishedDate": "", "ExtinguishedDateOnly": ""}
# Henderson Fire's record at the recording, as the tests assert it (CAL FIRE has updated it since).
LIVE_OVERRIDES = {
    "3e3dfee3-8214-4341-a777-6b0ad643c9af": {"AcresBurned": 2079.5, "PercentContained": 20.0,
                                             "Updated": "2026-10-17T02:25:15Z", "AgencyNames": ""},
}


def calfire_list(year: int) -> list[dict]:
    resp = fhttp.request("GET", CALFIRE_URL, params={"inactive": "true", "year": year}, ttl_s=3600, timeout=60.0)
    data = resp.json()
    if not isinstance(data, list):
        raise SystemExit(f"CAL FIRE {year}: unexpected response")
    return data


def pick_uid(records: list[dict], uid: str) -> dict:
    hits = [r for r in records if str(r.get("UniqueId", "")).lower().startswith(uid)]
    if len(hits) != 1:
        raise SystemExit(f"CAL FIRE: {len(hits)} records for UniqueId {uid}")
    return hits[0]


def build_calfire() -> tuple[list[dict], list[dict]]:
    y2025 = calfire_list(2025)
    y2026 = calfire_list(2026)
    keep = {pick_uid(y2025, u)["UniqueId"] for u in Y2025_UIDS}
    past = [r for r in y2025 if r["UniqueId"] in keep]                     # CAL FIRE's own order
    live = []
    for uid in LIVE_UIDS:
        r = dict(pick_uid(y2026, uid))
        r.update(LIVE_STATE)
        r.update(LIVE_OVERRIDES.get(uid, {}))
        live.append(r)
    return live, past


def check_calfire(live: list[dict], past: list[dict]) -> None:
    names = [r["Name"].strip() for r in live]
    assert live[0]["Name"] == "Timber Fire " and names[1] == "Blue Fire", names
    assert live[0]["AcresBurned"] == 25351.9 and live[0]["County"] == "Monterey"
    assert live[0]["Started"] == "2026-08-09T03:35:00Z"
    fires = [r for r in live if r["Type"].lower() in ("wildfire", "fire")]
    assert sorted(r["Name"].strip() for r in fires) == ["Blue Fire", "Gall Fire", "Henderson Fire", "Scales Fire", "Timber Fire"]
    small = [r for r in fires if r["Name"].strip() not in ("Timber Fire", "Henderson Fire")]
    assert all(r["AcresBurned"] < 300 for r in small)
    blue, gall = (next(r for r in live if r["Name"].strip() == n) for n in ("Blue Fire", "Gall Fire"))
    assert blue["AcresBurned"] >= gall["AcresBurned"]
    assert all(r["Started"].startswith("2026-") for r in live)
    assert len(past) == 8 and past[1]["Name"] == "Eaton Fire"
    eaton = past[1]
    assert eaton["ExtinguishedDate"] == "2025-01-31T18:48:42Z" and eaton["Latitude"] == 34.203483
    assert eaton["AcresBurned"] == 14021.0 and eaton["Final"] is True and eaton["Updated"].startswith("2026-08")
    assert str(eaton["AgencyNames"]).startswith(", LA County Mental Health")
    acres = sorted(((r["AcresBurned"] or 0, r["Name"].strip()) for r in past if r["Type"].lower() in ("wildfire", "fire")), reverse=True)
    assert [n for a, n in acres if a >= 300] == ["Gifford Fire", "Palisades Fire", "Eaton Fire"]
    assert [n for a, n in acres if 100 <= a < 300] == ["Catlett Fire", "Rosa Fire"]
    assert len(acres) == 7 and any(r["Type"] == "Fire" and r["Name"].strip() == "Scout Fire" for r in past)


# ------------------------------------------------------------------------------------------------------------------
# FIRMS
# ------------------------------------------------------------------------------------------------------------------
def firms_text(url: str, label: str) -> str:
    try:
        body = fhttp.request("GET", url, ttl_s=3600, timeout=240.0, retries=2).content.decode("utf-8", "replace")
    except fhttp.HttpError as e:
        raise SystemExit(f"FIRMS {label}: {config.mask_secrets(e)}") from None
    if not body.lstrip().lower().startswith("latitude"):
        raise SystemExit(f"FIRMS {label}: not a detections CSV: {config.mask_secrets(body[:120])!r}")
    return body


def area(product: str, box: str, days: int, day: str) -> str:
    key = config.FIRMS_MAP_KEY
    if not key:
        raise SystemExit("FIRMS_MAP_KEY is not set (environment or .env): the area-API samples cannot be recorded")
    return firms_text(AREA.format(key=key, product=product, bbox=box, days=days, day=day), f"{product} {box} {day}+{days}d")


class Table:
    """A FIRMS CSV kept as its original text lines (so samples keep FIRMS' exact formatting)."""

    def __init__(self, text: str):
        lines = [ln for ln in text.strip("﻿\r\n").splitlines() if ln.strip()]
        self.header = lines[0]
        self.cols = next(csv.reader([lines[0]]))
        self.rows = [dict(zip(self.cols, next(csv.reader([ln])))) | {"_line": ln} for ln in lines[1:]]

    def first(self, **want) -> dict:
        for r in self.rows:
            if all(r.get(k) == v for k, v in want.items()):
                return r
        raise SystemExit(f"FIRMS: no row with {want}")


def hhmm(r: dict) -> str:
    return r["acq_date"] + r["acq_time"].zfill(4)


def write_csv(header: str, rows: list[dict]) -> str:
    return header + "\n" + "".join(r["_line"] + "\n" for r in rows)


def build_viirs_noaa20_sp() -> str:
    t = Table(area("VIIRS_NOAA20_SP", EATON_BOX, 5, "2025-01-07"))
    volcano = Table(area("VIIRS_NOAA20_SP", KILAUEA_BOX, 5, "2025-01-07")).first(type="1")
    rows = [
        t.first(type="2"),                                                       # a static heat source near Glendale
        t.first(acq_date="2025-01-08", acq_time="949", confidence="n", type="0"),
        t.first(acq_date="2025-01-08", acq_time="949", confidence="h", type="0"),
        t.first(acq_date="2025-01-08", acq_time="2108", confidence="l", type="0"),
        t.first(acq_date="2025-01-08", acq_time="2108", confidence="h", type="0"),
        t.first(acq_date="2025-01-09", acq_time="930", confidence="n", type="0"),
    ]
    offshore = dict(t.first(acq_date="2025-01-11", acq_time="852", type="0"))
    assert offshore["_line"].endswith(",0")
    offshore["_line"] = offshore["_line"][:-1] + "3"                             # EDITED: type 0 -> 3 (see PROVENANCE)
    rows.append(offshore)
    rows.append(volcano)
    rows.sort(key=hhmm)
    return write_csv(t.header, rows)


def build_modis_sp() -> str:
    t = Table(area("MODIS_SP", EATON_BOX, 5, "2025-01-07"))
    passes: list[str] = []
    rows = []
    for r in t.rows:                                    # the first type-0 row of each of the first five overpasses
        k = hhmm(r)
        if r["type"] == "0" and k not in passes and len(passes) < 5:
            passes.append(k)
            rows.append(r)
    return write_csv(t.header, rows)


def build_goes_nrt() -> str:
    t = Table(area("GOES_NRT", EATON_BOX, 1, "2025-01-09"))
    rows, frp = [], 0
    for r in t.rows:                                    # 00:00-00:40 UTC: every regular row, the first two *FRP rows
        if int(r["acq_time"]) > 40:
            break
        if r["satellite"].upper().endswith("FRP"):
            if frp == 2:
                continue
            frp += 1
        rows.append(r)
    return write_csv(t.header, rows)


def build_landsat_nrt() -> str:
    t = Table(area("LANDSAT_NRT", LA_BOX, 4, "2025-01-12"))
    rows = [r for r in t.rows if float(r["latitude"]) >= 34.0][:4]
    return write_csv(t.header, rows)


def in_ca_bbox(r: dict) -> bool:
    w, s, e, n = config.CA_BBOX
    return w <= float(r["longitude"]) <= e and s <= float(r["latitude"]) <= n


def build_feed(dir_: str, prefix: str, group: str, inside_per_group: int) -> tuple[str, str]:
    """(csv, window): the first rows of each ``group`` value inside the CA bbox and outside it, in feed order."""
    for window in ("24h", "7d"):
        t = Table(firms_text(FEED.format(dir=dir_, prefix=prefix, window=window), f"{prefix} {window} feed"))
        picked: list[dict] = []
        for r in t.rows:
            inside = in_ca_bbox(r)
            n_same = sum(1 for p in picked if in_ca_bbox(p) == inside and p[group] == r[group])
            if n_same < (inside_per_group if inside else 2):
                picked.append(r)
        groups = {r[group] for r in picked}
        want = {"low", "nominal", "high"} if group == "confidence" else {"T", "A"}
        if want <= groups and any(in_ca_bbox(r) for r in picked):
            return write_csv(t.header, picked), window
    raise SystemExit(f"FIRMS {prefix}: neither the 24h nor the 7d feed has the rows the tests need")


# ------------------------------------------------------------------------------------------------------------------
# WFIGS (synthetic "Test Fire" with the real field names and types of the daily-perimeter layer)
# ------------------------------------------------------------------------------------------------------------------
S = 1736301600000                       # CAL FIRE start of the synthetic fire: 2025-01-08T02:00Z (tests' S)
MIN = 60_000
LAT, LON = 34.20, -118.07               # tests' LAT, LON
MAIN = "{AAAAAAAA-0000-0000-0000-000000000001}"
DAILY = "Wildfire Daily Fire Perimeter"
FINAL = "Wildfire Final Fire Perimeter"
BULK_LOAD = iso_to_ms("2026-05-12T16:30:00Z")      # WFIGS re-dated finals in a bulk load (Eaton, Madre, Gifford)


def wfigs_record(oid: int, *, name: str = "Test", irwin: str = MAIN, cat: str = DAILY, acres: float | None, pdt: int | None,
                 dc: int | None, cd: int | None, state: str = "US-CA", disc: int | None = S, contain: int | None = S + 20 * DAY_MS,
                 cause: str | None = "Human", ilat: float | None = LAT, ilon: float | None = LON, kind: str = "WF") -> dict:
    a = {
        "OBJECTID": oid, "poly_IncidentName": name, "attr_IncidentName": name.upper(), "attr_CpxName": None,
        "attr_IsCpxChild": 0, "poly_FeatureCategory": cat, "poly_GISAcres": acres, "poly_PolygonDateTime": pdt,
        "poly_DateCurrent": dc, "poly_CreateDate": cd, "poly_IRWINID": irwin, "attr_IrwinID": irwin,
        "attr_POOState": state, "attr_FireDiscoveryDateTime": disc, "attr_ContainmentDateTime": contain,
        "attr_ControlDateTime": None, "attr_FireOutDateTime": None, "attr_FireCause": cause,
        "attr_InitialLatitude": ilat, "attr_InitialLongitude": ilon, "attr_IncidentTypeCategory": kind,
    }
    assert list(a) == ATTR_FIELDS.split(","), "keep the outFields order of fire3d.sources.perimeters.ATTR_FIELDS"
    return a


def wfigs_records() -> list[dict]:
    H, D = HOUR_MS, DAY_MS
    far_lat, far_lon = offset_point(LAT, LON, 90.0, 50_600.0)
    nv_lat, nv_lon = 39.55, -119.75
    rx_lat, rx_lon = offset_point(LAT, LON, 45.0, 8_000.0)
    cx_lat, cx_lon = offset_point(LAT, LON, 135.0, 25_000.0)
    return [
        # the fire: polygon time missing GISAcres (geodesic area used) ...
        wfigs_record(101, acres=None, pdt=S + 20 * H, dc=S + 20 * H + 15 * MIN, cd=S + 20 * H + 10 * MIN),
        # ... one polygon edited three times: a correction (102 -> 103, +2 ac) and a growth edit (104, +298 ac)
        wfigs_record(102, acres=500.0, pdt=S + 30 * H, dc=S + 31 * H, cd=S + 30 * H + 20 * MIN),
        wfigs_record(103, acres=502.0, pdt=S + 30 * H + 40_000, dc=S + 33 * H, cd=S + 33 * H - 5 * MIN),
        wfigs_record(104, acres=800.0, pdt=S + 30 * H, dc=S + 40 * H, cd=S + 30 * H + 25 * MIN),
        # ... and the final perimeter, re-dated to 2026 by a bulk load (retimed to the containment time)
        wfigs_record(105, cat=FINAL, acres=2300.0, pdt=BULK_LOAD, dc=BULK_LOAD + 2 * MIN, cd=BULK_LOAD),
        # look-alikes the matching must reject
        wfigs_record(106, irwin="{AAAAAAAA-0000-0000-0000-000000000006}", state="US-NV", acres=40.0, pdt=S + 10 * H,
                     dc=S + 11 * H, cd=S + 10 * H + 5 * MIN, disc=S + 3 * H, contain=S + 2 * D, cause="Undetermined",
                     ilat=nv_lat, ilon=nv_lon),
        wfigs_record(107, irwin="{AAAAAAAA-0000-0000-0000-000000000007}", cat="Prescribed Fire", kind="RX", acres=120.0,
                     pdt=S + 50 * H, dc=S + 51 * H, cd=S + 50 * H + 30 * MIN, disc=S + 48 * H, contain=S + 3 * D,
                     cause=None, ilat=rx_lat, ilon=rx_lon),
        wfigs_record(108, irwin="{AAAAAAAA-0000-0000-0000-000000000008}", acres=300.0, pdt=S + 25 * H, dc=S + 26 * H,
                     cd=S + 25 * H + 20 * MIN, disc=S + 5 * H, contain=S + 3 * D, cause="Undetermined",
                     ilat=far_lat, ilon=far_lon),
        wfigs_record(109, name="Contest", irwin="{AAAAAAAA-0000-0000-0000-000000000009}", acres=60.0, pdt=S + 54 * H,
                     dc=S + 55 * H, cd=S + 54 * H + 10 * MIN, disc=S + 2 * D, contain=S + 4 * D, cause="Natural",
                     ilat=cx_lat, ilon=cx_lon),
        wfigs_record(110, irwin="{AAAAAAAA-0000-0000-0000-000000000010}", acres=75.0, pdt=S - 399 * D,
                     dc=S - 399 * D + H, cd=S - 399 * D + 20 * MIN, disc=S - 400 * D, contain=S - 397 * D),
    ]


def offset_point(lat: float, lon: float, bearing_deg: float, dist_m: float) -> tuple[float, float]:
    from pyproj import Geod

    lo, la, _ = Geod(ellps="WGS84").fwd(lon, lat, bearing_deg, dist_m)
    return la, lo


def ring(lat0: float, lon0: float, pts_m: list[tuple[float, float]]) -> list[list[float]]:
    """Local (east, north) metre offsets around (lat0, lon0) -> a closed lon/lat ring, 6 decimals (as WFIGS serves)."""
    from pyproj import Transformer

    tr = Transformer.from_crs(f"+proj=aeqd +lat_0={lat0} +lon_0={lon0} +ellps=WGS84 +units=m", "EPSG:4326", always_xy=True)
    out = [[round(x, 6), round(y, 6)] for x, y in (tr.transform(e, n) for e, n in pts_m)]
    return out + [out[0]]


def ellipse(lat: float, lon: float, acres: float, ratio: float, bearing_deg: float, shift: float = 0.6) -> list[list[float]]:
    """An ellipse of ``acres`` whose major axis points along ``bearing_deg``; the centre is moved ``shift`` x the
    semi-major axis along that bearing, so (lat, lon) (the ignition point) sits inside, near the far end."""
    area = acres * config.ACRE_M2
    b = math.sqrt(area / (math.pi * ratio))
    a = ratio * b
    th = math.radians(bearing_deg)
    ux, uy = math.sin(th), math.cos(th)                      # unit vector of the major axis (east, north)
    vx, vy = -uy, ux
    cx, cy = shift * a * ux, shift * a * uy
    pts = []
    for k in range(32):                                       # counter-clockwise
        t = 2 * math.pi * k / 32
        p, q = a * math.cos(t), b * math.sin(t)
        pts.append((cx + p * ux + q * vx, cy + p * uy + q * vy))
    if (ux * vy - uy * vx) < 0:
        pts.reverse()
    return ring(lat, lon, pts)


def wfigs_geometries(records: list[dict]) -> dict:
    sw = 225.0                                                # Santa Ana winds: the fire grows to the south-west
    shapes = {
        101: ring(LAT, LON, [(-500.0, -500.0), (500.0, -500.0), (500.0, 500.0), (-500.0, 500.0)]),     # exactly 1 km2
        102: ellipse(LAT, LON, 500.0, 1.6, sw), 103: ellipse(LAT, LON, 502.0, 1.6, sw),
        104: ellipse(LAT, LON, 800.0, 1.8, sw), 105: ellipse(LAT, LON, 2300.0, 2.0, sw),
    }
    for r in records:
        oid = r["OBJECTID"]
        if oid not in shapes:
            shapes[oid] = ellipse(r["attr_InitialLatitude"] or LAT, r["attr_InitialLongitude"] or LON, r["poly_GISAcres"], 1.3, 0.0, 0.0)
    feats = [{"type": "Feature", "id": oid, "geometry": {"type": "Polygon", "coordinates": [shapes[oid]]},
              "properties": {"OBJECTID": oid}} for oid in sorted(shapes)]
    return {"type": "FeatureCollection", "features": feats}


def wfigs_fields() -> list[dict]:
    layer = fhttp.get_json(WFIGS_DAILY, {"f": "json"}, ttl_s=3600, timeout=60.0)
    by_name = {f["name"]: f for f in layer.get("fields") or []}
    out = []
    for name in ATTR_FIELDS.split(","):
        if name not in by_name:
            raise SystemExit(f"WFIGS daily layer has no field {name!r}: update fire3d.sources.perimeters.ATTR_FIELDS")
        f = by_name[name]
        out.append({k: f[k] for k in ("name", "type", "alias", "sqlType", "length", "domain", "defaultValue") if k in f})
    return out


def build_wfigs() -> tuple[dict, dict]:
    recs = wfigs_records()
    attrs = {"objectIdFieldName": "OBJECTID", "uniqueIdField": {"name": "OBJECTID", "isSystemMaintained": True},
             "globalIdFieldName": "GlobalID", "fields": wfigs_fields(), "features": [{"attributes": r} for r in recs]}
    return attrs, wfigs_geometries(recs)


def check_wfigs(geoms: dict) -> None:
    from shapely.geometry import shape
    from shapely.ops import unary_union

    from fire3d.sources.perimeters import distance_m, geodesic_acres

    g = {f["id"]: shape(f["geometry"]) for f in geoms["features"]}
    assert abs(geodesic_acres(g[101]) - 1e6 / config.ACRE_M2) < 0.5
    for oid, acres in ((102, 500.0), (103, 502.0), (104, 800.0), (105, 2300.0)):
        assert abs(geodesic_acres(g[oid]) - acres) / acres < 0.02, oid
    w, s, e, n = unary_union([g[i] for i in (101, 103, 104, 105)]).bounds
    assert w < LON < e and s < LAT < n and (e - w) < 0.05
    assert all(distance_m(g[i], LAT, LON) < 30_000 for i in (101, 102, 103, 104, 105))
    assert 49_000 < distance_m(g[108], LAT, LON) < 51_000


# ------------------------------------------------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=OUT_DIR, help="output folder (default: tests/data/firedata)")
    ap.add_argument("--dry-run", action="store_true", help="fetch, trim and check; write nothing")
    args = ap.parse_args()

    live, past = build_calfire()
    check_calfire(live, past)
    attrs, geoms = build_wfigs()
    check_wfigs(geoms)
    snpp, snpp_window = build_feed("suomi-npp-viirs-c2", "SUOMI_VIIRS_C2", "confidence", 2)
    modis_feed, modis_window = build_feed("modis-c6.1", "MODIS_C6_1", "satellite", 2)
    files = {
        "calfire_live.json": json.dumps(live, indent=1, ensure_ascii=True) + "\n",
        "calfire_2025.json": json.dumps(past, indent=1, ensure_ascii=True) + "\n",
        "viirs_noaa20_sp.csv": build_viirs_noaa20_sp(),
        "modis_sp.csv": build_modis_sp(),
        "goes_nrt.csv": build_goes_nrt(),
        "landsat_nrt.csv": build_landsat_nrt(),
        "viirs_snpp_feed.csv": snpp,
        "modis_feed.csv": modis_feed,
        "wfigs_attrs.json": json.dumps(attrs, indent=1) + "\n",
        "wfigs_geoms.geojson": "{\"type\": \"FeatureCollection\", \"features\": [\n"
                               + ",\n".join(json.dumps(f, separators=(",", ":")) for f in geoms["features"]) + "\n]}\n",
    }
    key = config.FIRMS_MAP_KEY
    if key and any(key in body for body in files.values()):
        raise SystemExit("the FIRMS key reached a sample: nothing written")
    print(f"feeds: SNPP {snpp_window}, MODIS {modis_window}")
    for name, body in files.items():
        print(f"{name}: {len(body.encode()):,} bytes")
    if args.dry_run:
        return 0
    args.out.mkdir(parents=True, exist_ok=True)
    for name, body in files.items():
        (args.out / name).write_text(body, encoding="utf-8")
    print(f"wrote {len(files)} files to {args.out}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        _TMP.cleanup()
