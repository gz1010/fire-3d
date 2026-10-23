"""Perimeters by IRWIN id outside California, California unchanged (CONTRACT 14.12.8), offline.

``tests/data/pipeline_us/perimeters_<fire>.json`` hold the real WFIGS attribute answers and geometries (simplified to
about 80 m) that the brief-2 ``fetch_perimeters`` asked for, for Eaton, Palisades, Madre 2025 and the TCU September
Lightning Complex 2025 (recorded 2026-10-23 with ``scripts/record_test_samples_official.py --only perimeters``,
before the brief-3 change), with the OBJECTIDs that code selected. The replay answers only the exact queries that
were recorded, so a changed California query fails here too.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from shapely.geometry import Point, mapping, shape

from fire3d.sources import perimeters as P
from fire3d.timeutil import DAY_MS, iso_to_ms

DATA = Path(__file__).parent / "data" / "pipeline_us"


def _key(url: str, where: str, extra: dict | None) -> str:
    return f"{url}|{where}|{json.dumps(extra or {}, sort_keys=True)}"


def _replay(monkeypatch: pytest.MonkeyPatch, doc: dict, seen: list[str]) -> None:
    def q(url, where, ttl_s, extra=None):
        k = _key(url, where, extra)
        seen.append(k)
        if k not in doc["attrs"]:
            raise AssertionError(f"query not recorded (the California query changed?): {k[:300]}")
        return [dict(a) for a in doc["attrs"][k]]

    def g(url, ids, ttl_s):
        return {int(i): shape(doc["geoms"][f"{url}|{i}"]) for i in ids if f"{url}|{i}" in doc["geoms"]}

    monkeypatch.setattr(P, "query_attributes", q)
    monkeypatch.setattr(P, "fetch_geometries", g)


@pytest.mark.parametrize("fire", ["eaton", "palisades", "madre", "tcu"])
def test_california_perimeters_unchanged(fire: str, monkeypatch: pytest.MonkeyPatch) -> None:
    doc = json.loads((DATA / f"perimeters_{fire}.json").read_text())
    seen: list[str] = []
    _replay(monkeypatch, doc, seen)
    a = doc["args"]
    res = P.fetch_perimeters(a["name"], a["lat"], a["lon"], a["start_ms"], a["end_ms"], acres=a["acres"],
                             contained_ms=a["contained_ms"])
    assert sorted(p["object_id"] for p in res) == doc["expected_object_ids"] == doc["recorded_object_ids"]
    assert all("attr_POOState='US-CA'" in k for k in seen if "attr_POOState" in k)
    # the brief-3 keywords with a California record leave the query and the result alone
    seen2: list[str] = []
    _replay(monkeypatch, doc, seen2)
    res2 = P.fetch_perimeters(a["name"], a["lat"], a["lon"], a["start_ms"], a["end_ms"], acres=a["acres"],
                              contained_ms=a["contained_ms"], record_source="calfire", state="CA",
                              irwin_id="ABCDEF01-0000-4000-8000-000000000000")
    assert sorted(p["object_id"] for p in res2) == doc["expected_object_ids"] and seen2 == seen


# ----------------------------------------------------------------------------------------------------------------
# WFIGS rows: by IRWIN id, else name + state; no CAL FIRE hint
# ----------------------------------------------------------------------------------------------------------------
IRWIN = "8C5E8C3B-63B2-4C55-9E57-0F8D5C9A1B2C"
MT = (45.80, -111.30)                    # lat, lon (Montana)
START = iso_to_ms("2024-07-20T20:00:00Z")


def _mt_records() -> tuple[list[dict], dict[int, dict]]:
    lat, lon = MT
    ring = [(lon - 0.02, lat - 0.02), (lon + 0.02, lat - 0.02), (lon + 0.02, lat + 0.02), (lon - 0.02, lat + 0.02)]
    poly = {"type": "Polygon", "coordinates": [ring + [ring[0]]]}
    base = {"poly_IncidentName": "HORSE GULCH", "attr_IncidentName": "Horse Gulch", "attr_POOState": "US-MT",
            "poly_FeatureCategory": "Wildfire Daily Fire Perimeter", "attr_IncidentTypeCategory": "WF",
            "attr_FireDiscoveryDateTime": START, "attr_InitialLatitude": lat, "attr_InitialLongitude": lon,
            "poly_CreateDate": START + DAY_MS, "poly_DateCurrent": START + DAY_MS, "_layer": P.DAILY_URL}
    recs = [{**base, "OBJECTID": 11, "poly_PolygonDateTime": START + DAY_MS, "poly_GISAcres": 2400.0,
             "attr_IrwinID": "{" + IRWIN + "}", "poly_IRWINID": "{" + IRWIN.lower() + "}"},
            {**base, "OBJECTID": 12, "poly_PolygonDateTime": START + 2 * DAY_MS, "poly_GISAcres": 9000.0,
             "poly_DateCurrent": START + 2 * DAY_MS, "attr_IrwinID": "{" + IRWIN + "}", "poly_IRWINID": None}]
    return recs, {11: poly, 12: poly}


def test_wfigs_fire_queries_by_irwin_id(monkeypatch: pytest.MonkeyPatch) -> None:
    recs, geoms = _mt_records()
    wheres: list[str] = []

    def q(url, where, ttl_s, extra=None):
        wheres.append(where)
        return [dict(r) for r in recs] if url == P.DAILY_URL else []

    monkeypatch.setattr(P, "query_attributes", q)
    monkeypatch.setattr(P, "fetch_geometries", lambda url, ids, ttl: {int(i): shape(geoms[int(i)]) for i in ids})
    monkeypatch.setattr(P, "_calfire_hint", lambda *a: pytest.fail("no CAL FIRE hint outside California"))
    res = P.fetch_perimeters("Horse Gulch", MT[0], MT[1], START, START + 60 * DAY_MS, acres=None, contained_ms=None,
                             record_source="wfigs", state="MT", irwin_id=IRWIN)
    assert sorted(p["object_id"] for p in res) == [11, 12]
    assert wheres and all("attr_IrwinID" in w and IRWIN in w and "LIKE" not in w and "US-CA" not in w for w in wheres)
    assert all(p["irwin_id"].strip("{}").upper() == IRWIN for p in res)


def test_wfigs_fire_without_irwin_uses_name_and_state(monkeypatch: pytest.MonkeyPatch) -> None:
    recs, geoms = _mt_records()
    ca_twin = {**recs[0], "OBJECTID": 99, "attr_POOState": "US-CA"}          # same name, other state: never used
    wheres: list[str] = []

    def q(url, where, ttl_s, extra=None):
        wheres.append(where)
        return [dict(r) for r in recs + [ca_twin]] if url == P.DAILY_URL else []

    monkeypatch.setattr(P, "query_attributes", q)
    monkeypatch.setattr(P, "fetch_geometries", lambda url, ids, ttl: {int(i): shape(geoms.get(int(i), geoms[11])) for i in ids})
    monkeypatch.setattr(P, "_calfire_hint", lambda *a: pytest.fail("no CAL FIRE hint outside California"))
    res = P.fetch_perimeters("Horse Gulch Fire", MT[0], MT[1], START, START + 60 * DAY_MS, record_source="wfigs",
                             state="MT", irwin_id=None)
    assert sorted(p["object_id"] for p in res) == [11, 12]
    assert all("attr_POOState='US-MT'" in w for w in wheres)


def test_wfigs_size_check_stays(monkeypatch: pytest.MonkeyPatch) -> None:
    recs, geoms = _mt_records()
    monkeypatch.setattr(P, "query_attributes", lambda url, where, ttl, extra=None: [dict(r) for r in recs] if url == P.DAILY_URL else [])
    monkeypatch.setattr(P, "fetch_geometries", lambda url, ids, ttl: {int(i): shape(geoms[int(i)]) for i in ids})
    res = P.fetch_perimeters("Horse Gulch", MT[0], MT[1], START, START + 60 * DAY_MS, acres=1000.0,
                             record_source="wfigs", state="MT", irwin_id=IRWIN)
    assert [p["object_id"] for p in res] == [11]                    # 9,000 ac > 2 x 1,000 + 500: dropped
    assert any("larger than" in w for w in res.warnings)


def test_irwin_where_clause_forms() -> None:
    w = P.irwin_where(IRWIN.lower())
    assert f"'{{{IRWIN}}}'" in w and f"'{IRWIN}'" in w and "attr_IrwinID" in w and "poly_IRWINID" in w
    with pytest.raises(ValueError):
        P.irwin_where("x' OR 1=1 --")
    assert Point(0, 0).within(shape(mapping(Point(0, 0).buffer(1))))
