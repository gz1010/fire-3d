"""sources/perimeters.py: name matching, record selection, timestamp fixes, dedupe and the full fetch against a
mocked ArcGIS service (tests/data/firedata/wfigs_*.json: a synthetic "Test Fire" with WFIGS field names)."""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest
from pyproj import Transformer
from shapely.geometry import box
from shapely.ops import unary_union

import fire3d.http as fhttp
from fire3d import config
from fire3d.sources import perimeters as P

DATA = Path(__file__).parent / "data" / "firedata"
S = 1736301600000              # CAL FIRE start of the synthetic fire: 2025-01-08T02:00Z
H, D = 3_600_000, 86_400_000
LAT, LON = 34.20, -118.07


def rec(oid: int, pdt=None, dc=None, cd=None, acres=None, key="A", layer=P.DAILY_URL, cat="Wildfire Daily Fire Perimeter", **kw) -> dict:
    r = {"OBJECTID": oid, "poly_PolygonDateTime": pdt, "poly_DateCurrent": dc, "poly_CreateDate": cd, "poly_GISAcres": acres,
         "attr_IrwinID": "{" + key + "}", "poly_FeatureCategory": cat, "attr_POOState": "US-CA", "_layer": layer,
         "attr_FireDiscoveryDateTime": S, "poly_IncidentName": "Test", "attr_IncidentName": "TEST"}
    r.update(kw)
    return r


# ------------------------------------------------------------------------------------------------------------------
# Names
# ------------------------------------------------------------------------------------------------------------------
def test_name_core_and_tokens() -> None:
    assert P.name_core("Eaton Fire") == "EATON"
    assert P.name_core("Orleans Complex ") == "ORLEANS"
    assert P.name_core("TCU September Lightning Complex") == "TCU SEPTEMBER LIGHTNING"
    assert P.name_tokens("6-5 Fire") == ["6", "5"]
    assert P.name_tokens("12th St / B St Fire") == ["12TH", "ST", "B", "ST"]
    assert P.name_tokens("Fire") == []


@pytest.mark.parametrize("core,cand,ok", [
    ("Eaton Fire", "EATON", True), ("Eaton Fire", "KEATON", False), ("La Porte Fire", "LAPORTE", True),
    ("Ranch Fire", "BDU/RANCH", True), ("6-5 Fire", "6-5", True), ("6-5 Fire", "5-4", False),
    ("TCU September Lightning Complex", "TCU SEPTEMBER LIGHTNING COMPLEX", True), ("Palisades Fire", "PALISADES ROAD", True),
    ("Gifford Fire", "Gifford ", True), ("Salt Fire", "SALT 14-2", True), ("Oak Fire", "OAKLAND", False),
])
def test_name_matches(core: str, cand: str, ok: bool) -> None:
    assert P.name_matches(P.name_tokens(core), cand) is ok


def test_build_where() -> None:
    w = P.build_where("Eaton Fire", S)
    assert "attr_POOState='US-CA'" in w and "UPPER(poly_IncidentName) LIKE '%EATON%'" in w
    assert "UPPER(attr_IncidentName) LIKE '%EATON%'" in w and "attr_CpxName" not in w
    assert "TIMESTAMP '2024-12-09 02:00:00'" in w and "TIMESTAMP '2025-02-07 02:00:00'" in w
    assert "attr_CpxName" in P.build_where("Orleans Complex", S, include_complex=True)
    assert "'%O%NEIL%'" in P.build_where("O'Neil Fire", S)          # no quote reaches the SQL
    with pytest.raises(ValueError):
        P.build_where("Fire", S)


# ------------------------------------------------------------------------------------------------------------------
# Selection + timestamps (pure)
# ------------------------------------------------------------------------------------------------------------------
def test_identity_filter() -> None:
    recs = [rec(1), rec(2, attr_POOState="US-WA"), rec(3, poly_IncidentName="Keaton", attr_IncidentName="KEATON"),
            rec(4, attr_FireDiscoveryDateTime=S - 400 * D), rec(5, cat="Prescribed Fire"),
            rec(6, attr_InitialLatitude=36.5, attr_InitialLongitude=-121.0), rec(7, attr_FireDiscoveryDateTime=None),
            rec(8, poly_IncidentName="Butler", attr_IncidentName="BUTLER", attr_CpxName="Test Complex")]
    assert [r["OBJECTID"] for r in P.identity_filter(recs, "Test Fire", LAT, LON, S)] == [1, 7]
    assert 8 in [r["OBJECTID"] for r in P.identity_filter(recs, "Test Complex", LAT, LON, S)]   # complex children


def test_polygon_time_missing_uses_date_current() -> None:
    (o,) = P.assign_times([rec(1, dc=S + 20 * H, cd=S + 19 * H)], S)
    assert o.t_ms == S + 20 * H and o.t_field == "poly_DateCurrent"
    (o,) = P.assign_times([rec(1, cd=S + 19 * H)], S)
    assert o.t_ms == S + 19 * H and o.t_field == "poly_CreateDate"


def test_corrections_dedupe_and_growth_edits() -> None:
    recs = [rec(2, pdt=S + 30 * H, dc=S + 31 * H, acres=500), rec(3, pdt=S + 30 * H + 40_000, dc=S + 33 * H, acres=502),
            rec(4, pdt=S + 30 * H, dc=S + 40 * H, acres=800), rec(5, pdt=S + 30 * H, dc=S + 41 * H, acres=801)]
    obs = P.assign_times(recs, S)
    assert [(o.t_ms, o.rec["OBJECTID"]) for o in obs] == [(S + 30 * H, 3), (S + 40 * H, 5)]
    assert obs[1].t_field.startswith("poly_DateCurrent (re-edited")


def test_polygon_times_minutes_apart_are_separate() -> None:
    obs = P.assign_times([rec(2, pdt=S + 30 * H, dc=S + 31 * H, acres=500), rec(3, pdt=S + 30 * H + 5 * 60_000, dc=S + 31 * H + 1, acres=520)], S)
    assert len(obs) == 2


def test_stale_after_edit_and_before_start_rules() -> None:
    stale, = P.assign_times([rec(1, pdt=S + 20 * H, dc=S + 300 * H, acres=900)], S)           # Palisades-like
    assert stale.t_ms == S + 300 * H and "stale" in stale.t_field
    after, = P.assign_times([rec(1, pdt=S + 30 * H, dc=S + 26 * H, acres=900)], S)             # Madre-like
    assert after.t_ms == S + 26 * H and "after its last edit" in after.t_field
    before, = P.assign_times([rec(1, pdt=S - 5 * H, dc=S + 2 * H, acres=90)], S)               # local time typed as UTC
    assert before.t_ms == S + 2 * H and "before the fire start" in before.t_field
    ok, = P.assign_times([rec(1, pdt=S + 30 * H, dc=S + 33 * H, acres=900)], S)
    assert ok.t_ms == S + 30 * H and ok.t_field == "poly_PolygonDateTime"


def test_bulk_edit_times_are_ignored() -> None:
    recs = [rec(1, pdt=S + 20 * H, dc=S + 200 * H, acres=100), rec(2, pdt=S + 40 * H, dc=S + 200 * H, acres=300)]
    assert [o.t_ms for o in P.assign_times(recs, S)] == [S + 20 * H, S + 40 * H]
    # the "current" layer repeating the newest daily record is not a bulk edit: the stale rule still applies
    copies = [rec(1, pdt=S + 20 * H, dc=S + 200 * H, acres=900), rec(9, pdt=S + 20 * H, dc=S + 200 * H, acres=900, layer=P.CURRENT_URL)]
    assert [o.t_ms for o in P.assign_times(copies, S)] == [S + 200 * H]


def test_out_of_order_polygon_moves_to_creation_time() -> None:
    recs = [rec(1, pdt=S + 10 * H, dc=S + 11 * H, cd=S + 10 * H, acres=1000),
            rec(2, pdt=S + 13 * H, dc=S + 21 * H, cd=S + 20 * H, acres=5000),      # local time typed as UTC
            rec(3, pdt=S + 15 * H, dc=S + 16 * H, cd=S + 15 * H, acres=3000)]
    obs = P.assign_times(recs, S)
    assert [(o.rec["OBJECTID"], o.t_ms) for o in obs] == [(1, S + 10 * H), (3, S + 15 * H), (2, S + 20 * H)]
    assert "out-of-order" in obs[2].t_field


def test_daily_wins_over_current_layer_at_same_time() -> None:
    recs = [rec(1, pdt=S + 30 * H, dc=S + 31 * H, acres=500, layer=P.CURRENT_URL), rec(2, pdt=S + 30 * H, dc=S + 31 * H, acres=500)]
    (o,) = P.assign_times(recs, S)
    assert o.rec["_layer"] == P.DAILY_URL


def test_backfilled_record_keeps_its_polygon_time() -> None:
    (o,) = P.assign_times([rec(1, pdt=S + 9 * H, dc=S + 200 * D, cd=S + 200 * D, acres=852)], S)     # Dias-like
    assert o.t_ms == S + 9 * H and o.t_field == "poly_PolygonDateTime"


def test_late_perimeters_are_redated_to_containment() -> None:
    none_cat = P.Observation(S + 176 * D, "poly_PolygonDateTime", rec(1, cat=None, attr_ContainmentDateTime=S + 9 * D), "A")    # Hughes
    daily_late = P.Observation(S + 30 * D, "poly_PolygonDateTime", rec(2, attr_ContainmentDateTime=S + 7 * D), "B")              # Silver
    daily_ok = P.Observation(S + 10 * D, "poly_PolygonDateTime", rec(3, attr_ContainmentDateTime=S + 7 * D), "C")                # within 7 d
    calfire_only = P.Observation(S + 97 * D, "poly_PolygonDateTime", rec(4, cat=None), "D")                                       # Kenneth
    out = {o.rec["OBJECTID"]: o for o in P.retime_finals([none_cat, daily_late, daily_ok, calfire_only], S, S + 120 * D, contained_ms=S + 3 * D)}
    assert out[1].t_ms == S + 9 * D and out[1].t_field.startswith("attr_ContainmentDateTime (final perimeter")
    assert out[2].t_ms == S + 7 * D and "dated after containment" in out[2].t_field
    assert out[3].t_ms == S + 10 * D
    assert out[4].t_ms == S + 3 * D and out[4].t_field.startswith("CAL FIRE containment")


def test_earlier_discovery_widens_the_window() -> None:
    o = P.Observation(S - 4 * D, "poly_DateCurrent", rec(1), "A")                     # Log-like: IRWIN discovery 6 d earlier
    assert P.retime_finals([o], S, S + 30 * D) == []
    assert len(P.retime_finals([P.Observation(S - 4 * D, "poly_DateCurrent", rec(1), "A")], S, S + 30 * D, earliest_ms=S - 6 * D)) == 1


def test_retime_finals_and_window() -> None:
    final = P.Observation(S + 480 * D, "poly_PolygonDateTime", rec(5, cat="Wildfire Final Fire Perimeter", attr_ContainmentDateTime=S + 20 * D), "A")
    late_final = P.Observation(S + 480 * D, "poly_PolygonDateTime", rec(6, cat="Wildfire Final Fire Perimeter"), "A")
    early = P.Observation(S - 3 * D, "poly_PolygonDateTime", rec(7), "A")
    beyond = P.Observation(S + 50 * D, "poly_PolygonDateTime", rec(8), "A")
    out = P.retime_finals([early, final, late_final, beyond], S, S + 30 * D)
    assert [o.rec["OBJECTID"] for o in out] == [5, 6]
    assert out[0].t_ms == S + 20 * D and out[0].t_field.startswith("attr_ContainmentDateTime")
    assert out[1].t_ms == S + 32 * D and "window end" in out[1].t_field          # clamped to end + 2 d


# ------------------------------------------------------------------------------------------------------------------
# Geometry helpers
# ------------------------------------------------------------------------------------------------------------------
def test_geodesic_acres_and_distance() -> None:
    to_utm = Transformer.from_crs(4326, 32611, always_xy=True)
    to_ll = Transformer.from_crs(32611, 4326, always_xy=True)
    cx, cy = to_utm.transform(LON, LAT)
    xs, ys = to_ll.transform([cx - 500, cx + 500, cx + 500, cx - 500], [cy - 500, cy - 500, cy + 500, cy + 500])
    from shapely.geometry import Polygon

    sq = Polygon(zip(xs, ys))                                         # 1 km x 1 km in UTM ~ 247.1 ac
    assert abs(P.geodesic_acres(sq) - 1e6 / config.ACRE_M2) / (1e6 / config.ACRE_M2) < 0.003
    holed = sq.difference(sq.centroid.buffer(0.002))
    assert P.geodesic_acres(holed) < P.geodesic_acres(sq)
    assert P.distance_m(sq, LAT, LON) == 0.0
    assert 49_000 < P.distance_m(box(LON + 0.55, LAT - 0.005, LON + 0.56, LAT + 0.005), LAT, LON) < 52_000
    bow = Polygon([(0, 0), (1, 1), (1, 0), (0, 1)])                   # self-intersecting ring gets repaired
    assert P.clean_geometry(bow).is_valid


# ------------------------------------------------------------------------------------------------------------------
# Full fetch against a mocked ArcGIS service
# ------------------------------------------------------------------------------------------------------------------
class ArcGIS:
    def __init__(self, attrs: dict, geoms: dict, error: dict | None = None):
        self.attrs, self.geoms, self.error = attrs, geoms, error
        self.attr_queries: list[dict] = []
        self.geometry_ids: list[int] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        q = {k: v[0] for k, v in parse_qs(request.url.query.decode()).items()}
        if self.error is not None:
            return httpx.Response(200, json=self.error)
        if q.get("f") == "geojson":
            ids = {int(i) for i in q["objectIds"].split(",")}
            self.geometry_ids += sorted(ids)
            feats = [f for f in self.geoms["features"] if f["id"] in ids]
            return httpx.Response(200, json={"type": "FeatureCollection", "features": feats})
        self.attr_queries.append(q)
        return httpx.Response(200, json=self.attrs)        # the mock ignores `where`: client-side filters must hold


@pytest.fixture
def arcgis(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path):
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)
    attrs = json.loads((DATA / "wfigs_attrs.json").read_text())
    geoms = json.loads((DATA / "wfigs_geoms.geojson").read_text())

    def install(error: dict | None = None) -> ArcGIS:
        svc = ArcGIS(attrs, geoms, error)
        monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(svc))
        return svc

    return install


def test_fetch_perimeters_end_to_end(arcgis) -> None:
    svc = arcgis()
    res = P.fetch_perimeters("Test Fire", LAT, LON, S, S + 120 * D, acres=2300.0)
    assert isinstance(res, list) and isinstance(res, P.PerimeterList)
    assert [p["t_ms"] for p in res] == [S + 20 * H, S + 30 * H, S + 40 * H, S + 20 * D]
    assert [p["object_id"] for p in res] == [101, 103, 104, 105]
    assert set(res[0]) == {"t_ms", "acres", "geometry", "source", "category", "irwin_id", "containment_ms", "cause",
                           "name", "t_field", "object_id", "date_current_ms", "discovery_ms"}
    assert res[0]["discovery_ms"] == S
    assert abs(res[0]["acres"] - 1e6 / config.ACRE_M2) < 1.0             # GISAcres missing -> geodesic area
    assert [p["acres"] for p in res[1:]] == [502.0, 800.0, 2300.0]
    assert res[3]["category"] == "Wildfire Final Fire Perimeter" and res[3]["containment_ms"] == S + 20 * D
    assert res[3]["cause"] == "Human" and res[0]["source"] == "NIFC WFIGS daily perimeters"
    assert res[0]["irwin_id"] == "{AAAAAAAA-0000-0000-0000-000000000001}"
    w, s, e, n = unary_union([p["geometry"] for p in res]).bounds
    assert w < LON < e and s < LAT < n and (e - w) < 0.05                # lon/lat, around the CAL FIRE point
    assert sorted(set(svc.geometry_ids)) == [101, 103, 104, 105, 108]    # never downloads excluded records
    assert any("30 km" in x for x in res.warnings)                       # 108 is 50 km away
    q = svc.attr_queries[0]
    assert q["returnGeometry"] == "false" and "LIKE '%TEST%'" in q["where"] and q["resultOffset"] == "0"
    assert len(svc.attr_queries) == 1                                    # historical fire: no "current" layer query


def test_fetch_perimeters_end_window_and_pagination(arcgis, monkeypatch: pytest.MonkeyPatch) -> None:
    svc = arcgis()
    attrs = svc.attrs
    first = {**attrs, "features": attrs["features"][:3], "exceededTransferLimit": True}
    rest = {**attrs, "features": attrs["features"][3:]}
    pages: list[str] = []

    def paged(request: httpx.Request) -> httpx.Response:
        q = {k: v[0] for k, v in parse_qs(request.url.query.decode()).items()}
        if q.get("f") == "geojson":
            return svc(request)
        pages.append(q["resultOffset"])
        return httpx.Response(200, json=first if q["resultOffset"] == "0" else rest)

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(paged))
    res = P.fetch_perimeters("Test Fire", LAT, LON, S, S + 35 * H, acres=2300.0)
    assert pages == ["0", "3"]
    # window = [S - 2 d, end + 2 d]: 104 (S+40 h) is inside; the final (contained S+20 d) is clamped to the window end
    assert [p["object_id"] for p in res] == [101, 103, 104, 105]
    assert res[-1]["t_ms"] == S + 35 * H + 2 * D and "window end" in res[-1]["t_field"]


def test_arcgis_error_json_with_status_200(arcgis) -> None:
    arcgis(error={"error": {"code": 400, "message": "Unable to perform query.", "details": []}})
    res = P.fetch_perimeters("Test Fire", LAT, LON, S, S + 120 * D, acres=2300.0)
    assert res == [] and res.warnings and "Unable to perform query" in res.warnings[0]
    assert not list((Path(config.CACHE_DIR) / "http").rglob("*.bin"))   # the error was not cached


def test_unmatched_name_uses_spatial_fallback(arcgis, monkeypatch: pytest.MonkeyPatch) -> None:
    svc = arcgis()
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        q = {k: v[0] for k, v in parse_qs(request.url.query.decode()).items()}
        if q.get("f") == "geojson":
            return svc(request)
        calls.append(q)
        if "geometry" in q:                                              # spatial query: return the Test records
            return httpx.Response(200, json=svc.attrs)
        return httpx.Response(200, json={"features": []})                # nothing named "Other"

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    res = P.fetch_perimeters("Other Fire", LAT, LON, S, S + 120 * D, acres=2300.0)
    assert len(calls) == 2 and calls[1]["units"] == "esriSRUnit_Kilometer" and calls[1]["distance"] == "10.0"
    assert res and any("matched by place and discovery time" in w for w in res.warnings)


def test_placeholder_oversize_and_complex_children(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path) -> None:
    def a(oid, name, acres, cpx=None, irwin="X"):
        return {"attributes": {"OBJECTID": oid, "poly_IncidentName": name, "attr_IncidentName": name.upper(), "attr_CpxName": cpx,
                               "poly_FeatureCategory": "Wildfire Daily Fire Perimeter", "poly_GISAcres": acres, "poly_PolygonDateTime": S + oid * H,
                               "poly_DateCurrent": S + oid * H + 60_000, "poly_CreateDate": S + oid * H, "attr_IrwinID": "{" + irwin + "}",
                               "attr_POOState": "US-CA", "attr_FireDiscoveryDateTime": S}}
    attrs = {"features": [a(1, "Test", 0.1, irwin="T"), a(2, "Test", 9000.0, irwin="T"), a(3, "Test", 800.0, irwin="T"),
                          a(4, "Child", 300.0, cpx="TEST COMPLEX", irwin="C1"), a(5, "Kid", 200.0, cpx="TEST COMPLEX", irwin="C2")]}
    sq = lambda dx, side: box(LON + dx - side, LAT - side, LON + dx + side, LAT + side).__geo_interface__
    geoms = {1: sq(0, 0.0001), 2: sq(0, 0.05), 3: sq(0, 0.01), 4: sq(0.45, 0.01), 5: sq(0.9, 0.01)}     # 4: ~41 km east, 5: ~83 km

    def handler(request: httpx.Request) -> httpx.Response:
        q = {k: v[0] for k, v in parse_qs(request.url.query.decode()).items()}
        if q.get("f") == "geojson":
            ids = [int(i) for i in q["objectIds"].split(",")]
            return httpx.Response(200, json={"type": "FeatureCollection", "features": [{"type": "Feature", "id": i, "geometry": geoms[i], "properties": {"OBJECTID": i}} for i in ids]})
        return httpx.Response(200, json=attrs)

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    res = P.fetch_perimeters("Test Fire", LAT, LON, S, S + 30 * D, acres=1000.0)
    assert [p["object_id"] for p in res] == [3]
    assert any("placeholder" in w for w in res.warnings) and any("larger than 2 x" in w for w in res.warnings)
    cpx = P.fetch_perimeters("Test Complex", LAT, LON, S, S + 30 * D, acres=1000.0)
    assert [p["object_id"] for p in cpx] == [3, 4]                    # child 41 km away kept, 83 km dropped
    assert any("more than 30 km" in w for w in cpx.warnings)
