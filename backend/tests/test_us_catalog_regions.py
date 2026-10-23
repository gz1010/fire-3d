"""fire3d.regions (CONTRACT 14.3): state, county, time zone and coverage at the required test points, the bbox helpers,
``GET /api/geo/lookup`` and the IncidentSummary state / time zone defaults. Offline (bundled region files)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from fire3d import regions
from fire3d.contracts import GeoLookup, IncidentSummary, contract_problems

# (lon, lat), expected IANA zone (CONTRACT 14.3 "Required test points")
TZ_POINTS = {
    "El Paso TX": ((-106.4850, 31.7619), "TX", "America/Denver"),
    "Pensacola FL": ((-87.2169, 30.4213), "FL", "America/Chicago"),
    "Ontario OR (Malheur)": ((-116.9629, 44.0266), "OR", "America/Denver"),
    "Island Creek ID": ((-115.438, 46.036), "ID", "America/Los_Angeles"),
    "Phoenix AZ": ((-112.0740, 33.4484), "AZ", "America/Phoenix"),
    "Window Rock AZ (Navajo Nation)": ((-109.0526, 35.6803), "AZ", "America/Denver"),
    "Kykotsmovi AZ (Hopi)": ((-110.6265, 35.8714), "AZ", "America/Phoenix"),
    "Greer AZ": ((-109.4573, 34.0109), "AZ", "America/Phoenix"),
    "Bozeman MT": ((-111.0429, 45.6770), "MT", "America/Denver"),
    "Black Cove NC": ((-82.298, 35.286), "NC", "America/New_York"),
    "Altadena CA (Eaton)": ((-118.07, 34.20), "CA", "America/Los_Angeles"),
    "Boise ID": ((-116.2, 43.615), "ID", "America/Denver"),
    "Washington DC": ((-77.0365, 38.8977), "DC", "America/New_York"),
    "Shiprock NM (Navajo Nation)": ((-108.687, 36.785), "NM", "America/Denver"),
    "Tuba City AZ (Navajo Nation)": ((-111.24, 36.135), "AZ", "America/Denver"),
}
COVERAGE_POINTS = {
    "Anchorage": ((-149.9003, 61.2181), "alaska"),
    "Honolulu": ((-157.8583, 21.3069), "hawaii"),
    "San Juan PR": ((-66.1057, 18.4655), "territory"),
    "Tijuana MX": ((-117.0333, 32.5250), "outside_us"),
    "Windsor ON": ((-83.03, 42.30), "outside_us"),
    "Mexico City": ((-99.13, 19.43), "outside_us"),
    "Bozeman MT": ((-111.0429, 45.6770), "lower48"),
    "Key West FL": ((-81.78, 24.555), "lower48"),
}


@pytest.mark.parametrize("name", list(TZ_POINTS))
def test_state_and_time_zone_at_test_points(name: str) -> None:
    (lon, lat), state, tz = TZ_POINTS[name]
    assert regions.state_at(lon, lat) == state, name
    assert regions.time_zone_at(lon, lat) == tz, name
    assert regions.coverage_at(lon, lat) == "lower48"


@pytest.mark.parametrize("name", list(COVERAGE_POINTS))
def test_coverage_at(name: str) -> None:
    (lon, lat), cov = COVERAGE_POINTS[name]
    assert regions.coverage_at(lon, lat) == cov, name
    if cov != "lower48":
        assert regions.time_zone_at(lon, lat) is None or cov == "outside_us"


def test_point_just_outside_a_state_polygon_keeps_its_state() -> None:
    """Paradise, OR is 20 m outside its (simplified) polygon: the nearest state within 5 km answers. Here: a point
    20 m off the Oregon coast's polygon edge, outside every polygon."""
    from shapely.geometry import Point
    from shapely.ops import nearest_points

    lay = regions._layer("states")
    oregon = lay.geoms[[p["state"] for p in lay.props].index("OR")]
    off = Point(-124.30, 44.63)                                   # well off Newport, OR
    edge = nearest_points(oregon, off)[0]
    k = 20.0 / regions.KM_PER_DEG / 1000.0 / max(1e-9, edge.distance(off))
    p = (edge.x + (off.x - edge.x) * k, edge.y + (off.y - edge.y) * k)
    assert not any(g.contains(Point(*p)) for g in lay.geoms)
    assert regions.state_at(*p) == "OR"
    assert regions.time_zone_at(*p) == "America/Los_Angeles"
    assert regions.coverage_at(*p) == "lower48"
    assert regions.state_at(-130.0, 44.6) is None                 # 450 km offshore


def test_l48_and_names() -> None:
    assert len(regions.L48) == 49 and "DC" in regions.L48 and "AK" not in regions.L48 and "HI" not in regions.L48
    assert all(s in regions.STATE_NAMES for s in regions.L48)
    assert all(s in regions.MAIN_ZONE for s in regions.L48)
    assert regions.STATE_NAMES["OR"] == "Oregon"
    assert regions.main_zone("TX") == "America/Chicago" and regions.main_zone("AZ") == "America/Phoenix"
    assert regions.main_zone("XX") == "UTC"
    assert [regions.zone_name(z) for z in ("America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York")] == [
        "Pacific Time", "Mountain Time", "Central Time", "Eastern Time"]
    assert regions.is_supported_state("dc") and not regions.is_supported_state("AK")


def test_bbox_helpers() -> None:
    assert regions.states_in_bbox((-124.35, 41.95, -124.15, 42.10)) == ["CA", "OR"]        # Brookings OR / CA line
    assert regions.states_in_bbox((-119.9, 39.4, -119.7, 39.6)) == ["NV"]                  # Reno
    assert "CA" in regions.states_in_bbox((-119.9, 39.4, -119.7, 39.6), margin_km=15.0)
    cs = regions.counties_in_bbox((-122.95, 42.25, -122.75, 42.40))                       # Medford, OR
    assert any(c.fips == "41029" and c.name == "Jackson County" and c.state == "OR" for c in cs)
    assert regions.same_codes([regions.County("41029", "Jackson County", "OR")]) == ["041029"]
    c = regions.county_at(-116.2, 43.615)
    assert c == regions.County("16001", "Ada County", "ID")
    assert regions.county_at(-149.9, 61.2) is None


def test_lookup_shapes() -> None:
    boise = regions.lookup(-116.2, 43.615)
    assert contract_problems(GeoLookup, boise) == []
    assert boise["state"] == "ID" and boise["time_zone"] == "America/Denver" and boise["supported"] is True
    assert boise["county"] == {"fips": "16001", "name": "Ada County"} and boise["note"] is None
    anc = regions.lookup(-149.9003, 61.2181)
    assert anc["coverage"] == "alaska" and anc["supported"] is False and anc["time_zone"] is None and anc["state"] is None
    assert anc["note"] == "Fire-3d does not support Alaska, Hawaii or US territories yet."
    tj = regions.lookup(-117.0333, 32.525)
    assert tj["coverage"] == "outside_us" and tj["note"] == "Outside the United States: Fire-3d has no data here."
    assert contract_problems(GeoLookup, anc) == [] and contract_problems(GeoLookup, tj) == []


def test_region_files_credit_their_sources() -> None:
    meta = regions.sources_meta()
    assert "TIGERweb" in meta["states"]["source"]["name"] and meta["states"]["retrieved"]
    names = [s["name"] for s in meta["timezones"]["sources"]]
    assert "USDOT BTS NTAD Time Zones" in names
    assert "unrestricted public use" in meta["timezones"]["sources"][0]["license"]


def test_geo_lookup_endpoint() -> None:
    from fire3d.api.app import app

    with TestClient(app) as client:
        r = client.get("/api/geo/lookup", params={"lon": "-116.2", "lat": "43.615"})
        assert r.status_code == 200 and contract_problems(GeoLookup, r.content) == []
        assert r.json()["state"] == "ID" and r.json()["time_zone"] == "America/Denver"
        assert r.headers["cache-control"] == "public, max-age=86400"
        a = client.get("/api/geo/lookup", params={"lon": "-149.9003", "lat": "61.2181"}).json()
        assert a["coverage"] == "alaska" and a["supported"] is False
        for bad in ({"lon": "abc", "lat": "40"}, {"lon": "-100"}, {"lon": "-200", "lat": "40"}, {"lon": "nan", "lat": "40"}):
            assert client.get("/api/geo/lookup", params=bad).status_code == 400, bad


def test_summary_state_and_time_zone_from_location() -> None:
    base = {"id": "x", "name": "X", "mode": "historical", "year": 2025, "calfire_uid": "abc", "started_ms": 1,
            "updated_ms": None, "contained_ms": None, "acres": None, "percent_contained": None, "is_active": False,
            "county": None, "location": None, "admin_unit": None, "url": None, "detections_24h": None,
            "bundle_status": "none", "bundle_built_ms": None}
    eaton = IncidentSummary.model_validate({**base, "lat": 34.20, "lon": -118.07})
    assert (eaton.state, eaton.time_zone) == ("CA", "America/Los_Angeles")
    east = IncidentSummary.model_validate({**base, "lat": 35.29, "lon": -82.30})
    assert (east.state, east.time_zone) == ("NC", "America/New_York")
    offshore = IncidentSummary.model_validate({**base, "lat": 20.0, "lon": -140.0})
    assert offshore.state is None and offshore.time_zone == "UTC"        # never Pacific by default
    given = IncidentSummary.model_validate({**base, "lat": 34.2, "lon": -118.07, "state": "CA", "time_zone": "America/Denver"})
    assert given.time_zone == "America/Denver"                            # given fields are kept
