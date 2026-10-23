"""The national fire list (CONTRACT 14.1-14.2) on a synthetic world: CAL FIRE lists + WFIGS layers + FIRMS feeds,
served offline. The California merge on recorded samples is in ``test_us_catalog_samples.py``."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

import fire3d.http as fhttp
from fire3d import catalog, config
from fire3d.contracts import IncidentListResponse, IncidentSummary, contract_problems
from fire3d.sources import wfigs
from test_us_catalog_mock import WfigsServer, feature, feed_csv

NOW = "2026-10-22T18:00:00Z"


@pytest.fixture(autouse=True)
def _no_live_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    """``TestClient(app)`` runs the app's lifespan: never start the live loop (it would auto-build fires)."""
    from fire3d import config as _cfg

    monkeypatch.setattr(_cfg, "LIVE_ENABLED", False)
    monkeypatch.setattr(_cfg, "AUTO_BUILD_LIVE", False)


def cal(name: str, uid: str, lat: float, lon: float, started: str, *, active: bool, acres: float = 500.0,
        pct: float | None = 50.0, updated: str = "2026-10-21T03:41:00Z", typ: str = "Wildfire") -> dict:
    return {"Name": name, "UniqueId": uid, "Started": started, "Updated": updated, "AcresBurned": acres,
            "PercentContained": pct, "Latitude": lat, "Longitude": lon, "IsActive": active, "Final": False, "Type": typ,
            "County": "Somewhere", "Location": "Somewhere", "AdminUnit": "CAL FIRE Unit", "ExtinguishedDate": "",
            "Url": f"https://www.fire.ca.gov/incidents/{name.lower().replace(' ', '-')}/"}


COOLEY = cal("Cooley Fire", "c001e000-0000-4000-8000-000000000001", 40.10, -122.30, "2026-10-12T20:00:00Z", active=True, acres=1365)
TIMBER = cal("Timber Fire", "b7e4a30e-67ab-4964-882e-751da30b44e0", 36.2249, -121.7298, "2026-09-20T20:10:00Z",
             active=False, acres=25351.9, pct=97)
MARSHALL = cal("Marshall Fire", "aa11bb22-0000-4000-8000-000000000003", 38.00, -120.50, "2026-10-01T19:00:00Z", active=False, acres=400)
BIG_BEAR = cal("Big Bear Complex", "bb33cc44-0000-4000-8000-000000000004", 41.20, -123.40, "2026-08-20T19:00:00Z",
               active=False, acres=13000, pct=95)
CAL_LIVE = [COOLEY, cal("Garden Grove HAZMAT", "dd55ee66-0000-4000-8000-000000000005", 33.77, -117.94, "2026-10-20T19:00:00Z",
                        active=True, typ="Hazmat")]
CAL_2026 = [COOLEY, TIMBER, MARSHALL, BIG_BEAR]

ID = {k: f"{k}-0000-4000-8000-000000000000" for k in (
    "A1B2C3D4", "B1B2C3D4", "C1C2C3D4", "D1D2D3D4", "E1E2E3E4", "F1F2F3F4", "1A1A1A1A", "2B2B2B2B", "3C3C3C3C", "4D4D4D4D",
    "5E5E5E5E", "6F6F6F6F", "7A7A7A7A", "8B8B8B8B", "9C9C9C9C", "0D0D0D0D", "1E1E1E1E", "2F2F2F2F")}
CURRENT = [
    feature("TIMBER", ID["A1B2C3D4"], "US-CA", -121.7303, 36.2251, size=25350, pct=97, discovered="2026-09-20T20:30:00Z", gacc="ONCC"),
    feature("COOLEY", ID["B1B2C3D4"], "US-CA", -122.301, 40.101, size=1360, pct=100, discovered="2026-10-12T21:00:00Z", gacc="ONCC"),
    feature("MCCOVEY", ID["C1C2C3D4"], "US-CA", -120.4910, 38.0010, size=None, pct=None, discovered="2026-10-10T19:00:00Z", agency="C&L"),
    feature("RIDGE", ID["D1D2D3D4"], "US-CA", -123.35, 41.25, size=8000, pct=80, discovered="2026-08-21T19:00:00Z",
            cpx_name="BIG BEAR COMPLEX", cpx_child=1, gacc="ONCC"),
    feature("PINE", ID["E1E2E3E4"], "US-OR", -122.90, 42.40, size=1200, pct=40, gacc="NWCC"),
    feature("SHARPE", ID["F1F2F3F4"], "US-CO", -102.50, 36.90, size=900, pct=10, gacc="RMCC", agency=None),
    feature("NORTH FORK", ID["1A1A1A1A"], "US-MT", -114.30, 48.20, size=3000, pct=20, gacc="NRCC",
            cpx_name="MONTANA LIGHTNING COMPLEX", cpx_child=1),
    feature("BURN UNIT 4", ID["2B2B2B2B"], "US-TX", -97.50, 31.00, size=500, pct=0, typ="RX", gacc="SACC"),
    feature("MONTANA LIGHTNING COMPLEX", ID["3C3C3C3C"], "US-MT", -114.20, 48.10, size=9000, pct=10, typ="CX", gacc="NRCC"),
    feature("TANANA", ID["4D4D4D4D"], "US-AK", -147.70, 64.80, size=2000, pct=5, gacc="AICC"),
    feature("KOHALA", ID["5E5E5E5E"], "US-HI", -155.80, 20.00, size=300, pct=5, gacc=None),
    feature("BORDER 2", ID["6F6F6F6F"], "US-WA", -119.40, 48.90, size=1000, pct=30, modified="2026-10-22T10:00:00Z"),
    feature("BORDER 2", ID["7A7A7A7A"], "US-WA", -119.39, 48.91, size=1005, pct=30, modified="2026-10-22T12:00:00Z"),
    feature("SMOKE CHECK", ID["8B8B8B8B"], "US-WI", -89.50, 44.50, size=0.1, pct=None, agency="DNR", gacc="EACC"),
    feature("GLADES", ID["9C9C9C9C"], None, -81.30, 26.20, size=700, pct=50, gacc="SACC"),
    feature("DONE", ID["0D0D0D0D"], "US-ID", -116.00, 44.00, size=600, pct=100, gacc="GBCC"),
    feature("KICKAPOO CREEK", ID["1E1E1E1E"], "US-TX", -97.60, 31.00, size=15000, pct=25, gacc="SACC", agency="TXS"),
]
YTD = [f for f in CURRENT if f["attributes"]["IncidentSize"] and f["attributes"]["IncidentSize"] >= 300] + [
    feature("PARADISE", ID["2F2F2F2F"], "US-OR", -117.05, 45.95, size=2500, pct=100, discovered="2026-07-02T20:00:00Z",
            contained="2026-07-20T20:00:00Z", gacc="NWCC"),
]
FEED = feed_csv([(36.22, -121.73, NOW), (31.00, -97.60, NOW), (31.01, -97.61, NOW), (42.40, -122.90, NOW),
                 (21.30, -157.80, NOW), (34.20, -118.10, NOW)])


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path):
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)
    monkeypatch.setattr(catalog, "default_year", lambda: 2026)
    srv = WfigsServer(current=list(CURRENT), ytd=list(YTD), all_years=list(YTD))
    state = {"cal_down": False, "feeds_down": False, "srv": srv}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "incidents.fire.ca.gov" in url:
            if state["cal_down"]:
                return httpx.Response(503)
            q = dict(request.url.params)
            if q.get("inactive") == "false":
                return httpx.Response(200, json=CAL_LIVE)
            return httpx.Response(200, json=CAL_2026 if q.get("year") == "2026" else [])
        if "services3.arcgis.com" in url:
            return srv.handle(request)
        if "/data/active_fire/" in url:
            if state["feeds_down"]:
                return httpx.Response(503)
            return httpx.Response(200, text=FEED if "SUOMI_VIIRS_C2" in url else FEED.split("\n")[0] + "\n")
        return httpx.Response(404)

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    catalog.clear_cache()
    yield state
    catalog.clear_cache()


def _by_name(rows: list[IncidentSummary]) -> dict[str, IncidentSummary]:
    return {r.name: r for r in rows}


def test_live_list_national_rules(world) -> None:
    rows, sources = catalog.list_incidents("live")
    by = _by_name(rows)
    assert all(not contract_problems(IncidentSummary, r) for r in rows)
    # Timber: one row, CAL FIRE's record, active because NIFC says so (round 3 item 2)
    t = by["Timber Fire"]
    assert t.record_source == "calfire" and t.is_active and t.active_sources == ["wfigs"] and t.mode == "live"
    assert t.other_records[0].source == "wfigs" and t.other_records[0].is_active and t.irwin_id == ID["A1B2C3D4"]
    assert t.gacc == "ONCC" and t.accuracy_region == "ONCC" and t.acres == 25351.9                # CAL FIRE's numbers
    assert "Timber" not in by and "TIMBER" not in by
    # Cooley: CAL FIRE active, its NIFC record 100 % contained -> two records disagree
    c = by["Cooley Fire"]
    assert c.active_sources == ["calfire"] and c.other_records[0].is_active is False
    # McCovey (0.8 km, 9 days after Marshall) stays its own WFIGS row; Marshall (inactive) is not live
    m = by["Mccovey"]
    assert m.record_source == "wfigs" and m.record_issuer == "C&L via NIFC WFIGS" and m.state == "CA"
    assert "Marshall Fire" not in by
    # the California complex: CAL FIRE's one row, members named, no single member's IRWIN id
    bb = by["Big Bear Complex"]
    assert bb.irwin_id is None and bb.complex_members == ["RIDGE"] and [o.name for o in bb.other_records] == ["RIDGE"]
    assert bb.active_sources == ["wfigs"] and bb.acres == 13000 and "Ridge" not in by
    # outside California: complex members on their own, CX parents and RX never; AK/HI never; 100 % contained not live
    nf = by["North Fork"]
    assert nf.complex_name == "Montana Lightning Complex" and nf.state == "MT"
    assert not {"Burn Unit 4", "Montana Lightning Complex", "Tanana", "Kohala", "Done"} & set(by)
    assert by["Sharpe"].state == "CO"                                        # POOState decides (the point is in OK)
    assert by["Sharpe"].record_issuer == "NIFC WFIGS (IRWIN)"               # no agency code
    assert by["Glades"].state == "FL"                                        # missing POOState: from the polygons
    assert sum(1 for r in rows if r.name == "Border 2") == 1 and by["Border 2"].uid == ID["7A7A7A7A"]   # newer kept
    assert by["Smoke Check"].acres == 0.1                                    # every size
    assert by["Kickapoo Creek"].accuracy_region == "SACC-SP" and by["Glades"].accuracy_region == "SACC-SE"
    assert len({r.state for r in rows}) >= 8 and all(r.time_zone and r.record_issuer and r.uid for r in rows)
    assert all(r.state in __import__("fire3d.regions", fromlist=["L48"]).L48 for r in rows)
    assert by["Pine"].time_zone == "America/Los_Angeles" and by["Kickapoo Creek"].time_zone == "America/Chicago"
    assert by["Kickapoo Creek"].detections_24h == 2 and rows[0].name == "Kickapoo Creek"
    assert {s["id"]: s["status"] for s in sources} == {"calfire": "available", "wfigs": "available"}
    assert catalog.live_detections_24h_us_total() == 5 and catalog.live_detections_24h_total() == 2   # HI row dropped


def test_wfigs_ids_and_fields(world) -> None:
    by = _by_name(catalog.get_catalog("live"))
    p = by["Pine"]
    assert p.id == f"2026-pine-{ID['E1E2E3E4'][:6].lower()}" and p.calfire_uid == "" and p.uid == ID["E1E2E3E4"]
    assert p.irwin_id == ID["E1E2E3E4"] and p.unique_fire_id.startswith("2026-") and p.source_name == "PINE"
    assert p.url == wfigs.record_url(ID["E1E2E3E4"]) and p.url.startswith("https://") and "f=html" in p.url
    assert p.agency == "USDA Forest Service" and p.agency_code == "USFS" and p.record_issuer == "USFS via NIFC WFIGS"
    assert p.admin_unit == "XXUNF" and p.location is None and p.active_sources == ["wfigs"]
    nf = by["North Fork"]
    assert nf.id.startswith("2026-north-fork-1a1a1a")


def test_historical_list_and_state_filter(world) -> None:
    rows, sources = catalog.list_incidents("historical", year=2026)
    by = _by_name(rows)
    assert len({r.id for r in rows}) == len(rows)
    assert by["Timber Fire"].is_active and by["Timber Fire"].mode == "historical"           # "either" rule
    assert "Timber" not in by and by["Paradise"].is_active is False and by["Paradise"].contained_ms
    assert all((r.acres or 0) >= 300 for r in rows)
    assert {r.name for r in catalog.get_catalog("historical", year=2026, state="OR")} == {"Pine", "Paradise"}
    assert catalog.get_catalog("historical", year=2026, state="wy") == []
    assert {s["id"] for s in sources} == {"calfire", "wfigs"}


def test_wfigs_down_lists_california_only(world) -> None:
    world["srv"].down = True
    rows, sources = catalog.list_incidents("live")
    assert {r.name for r in rows} == {"Cooley Fire"} and rows[0].other_records == []
    wf = next(s for s in sources if s["id"] == "wfigs")
    assert wf["status"] == "unavailable" and wf["reason"] == catalog.WFIGS_DOWN


def test_calfire_down_lists_california_from_wfigs(world) -> None:
    world["cal_down"] = True
    rows, sources = catalog.list_incidents("live")
    ca = {r.name: r for r in rows if r.state == "CA"}
    assert "Timber" in ca and ca["Timber"].record_source == "wfigs" and "Cooley Fire" not in ca
    cf = next(s for s in sources if s["id"] == "calfire")
    assert cf["status"] == "unavailable" and cf["reason"] == catalog.CALFIRE_DOWN


def test_resolution(world, tmp_data_dir: Path) -> None:
    pine = catalog.get_catalog("live")
    pine_id = next(r.id for r in pine if r.name == "Pine")
    s = catalog.resolve_listed(pine_id)
    assert s is not None and s.record_source == "wfigs" and s.mode == "live" and s.bundle_status == "none"
    assert catalog.get_summary(pine_id).id == pine_id
    assert catalog.resolve_listed("fixture-demo") is None and catalog.resolve_listed("fixture-east") is None
    timber_wfigs_id = f"2026-timber-{ID['A1B2C3D4'][:6].lower()}"
    assert catalog.resolve_listed(timber_wfigs_id) is None                  # folded into CAL FIRE's Timber Fire
    assert catalog.resolve_listed("2026-pine-ffffff") is None and catalog.resolve_listed("2026-wrong-slug-e1e2e3") is None
    ak = catalog.resolve_listed(f"2026-tanana-{ID['4D4D4D4D'][:6].lower()}")
    assert ak is not None and ak.state == "AK" and not catalog.is_supported(ak) and ak.time_zone == "America/Anchorage"
    assert catalog.is_supported(s) and catalog.record_issuer(s) == "USFS via NIFC WFIGS"
    found = catalog.find_by_irwin("{" + ID["A1B2C3D4"].lower() + "}")
    assert found is not None and found.name == "Timber Fire"                # the CAL FIRE row carrying that record
    d = tmp_data_dir / "incidents" / "fixture-east"
    d.mkdir(parents=True)
    summ = catalog.get_catalog("live")[0].model_dump(mode="json") | {"id": "fixture-east"}
    (d / "manifest.json").write_text(json.dumps({"status": "ready", "built_ms": 5, "summary": summ}))
    assert catalog.is_bundle_only("fixture-east") and not catalog.is_bundle_only(pine_id)
    assert catalog.get_summary("fixture-east").id == "fixture-east"


def test_display_names_and_tokens() -> None:
    assert [catalog.display_name(x) for x in ("BIG CLIFF", "O'NEIL", "FD140011", "2ND STREET", "LAC-282478", "Timber", "2-2")] == [
        "Big Cliff", "O'Neil", "Fd140011", "2nd Street", "Lac-282478", "Timber", "2-2"]
    # possessives and contractions (review R2): a short run after an apostrophe stays lower case; "O'Neil" keeps its cap
    names = ("DEVIL'S CANYON", "0501 PAT'S CABIN", "JOHNSON'S", "DON'T", "WE'LL", "THEY'RE", "WE'VE", "SHE'D",
             "D'ANGELO", "O'DELL", "'S CANYON", "ROCK\u2019S")
    assert [catalog.display_name(x) for x in names] == [
        "Devil's Canyon", "0501 Pat's Cabin", "Johnson's", "Don't", "We'll", "They're", "We've", "She'd",
        "D'Angelo", "O'Dell", "'S Canyon", "Rock\u2019s"]
    assert catalog.make_incident_id(2026, catalog.display_name("DEVIL'S CANYON"), "23e897ab") == "2026-devil-s-canyon-23e897"
    assert catalog.name_tokens("Eaton Fire") == catalog.name_tokens("EATON") == frozenset({"eaton"})
    assert catalog.name_tokens("2-2") != catalog.name_tokens("2-7")
    assert catalog.norm_name("TCU SEPTEMBER LIGHTNING COMPLEX") == catalog.norm_name("TCU September Lightning Complex")
    assert catalog.accuracy_region_for("SACC", "OK") == "SACC-SP" and catalog.accuracy_region_for("SACC", "GA") == "SACC-SE"
    assert catalog.accuracy_region_for("AICC", "AK") is None and catalog.accuracy_region_for(None, "CA") is None
    assert catalog.issuer_for("USFS") == "USFS via NIFC WFIGS" and catalog.issuer_for(None) == "NIFC WFIGS (IRWIN)"
    assert wfigs.clean_irwin("{51374d2c-d96b-40f7-940b-6cb8e0a483a2}") == "51374D2C-D96B-40F7-940B-6CB8E0A483A2"
    assert wfigs.ufi_year("2026-TXTXS-000006") == 2026


def test_ufi_year_names_the_id() -> None:
    rec = wfigs.normalize(feature("NEW YEAR", "ABCDEF12-0000-4000-8000-000000000000", "US-TX", -98.0, 32.0,
                                  ufi="2025-TXTXS-000999", discovered="2026-01-01T02:00:00Z"))
    s = catalog.summary_from_wfigs(rec, "historical", set())
    assert s.year == 2025 and s.id == "2025-new-year-abcdef" and s.time_zone == "America/Chicago"


def test_api_list_gzip_state_and_detail(world) -> None:
    from fire3d.api.app import app

    with TestClient(app) as client:
        r = client.get("/api/incidents", params={"mode": "live"}, headers={"Accept-Encoding": "identity"})
        assert r.status_code == 200 and contract_problems(IncidentListResponse, r.content) == []
        plain = r.content
        body = r.json()
        assert {s["id"] for s in body["sources"]} == {"calfire", "wfigs"} and "content-encoding" not in r.headers
        assert "Accept-Encoding" in r.headers["vary"]
        raw = client.get("/api/incidents", params={"mode": "live"}, headers={"Accept-Encoding": "gzip"})
        assert raw.headers["content-encoding"] == "gzip" and raw.json()["incidents"] == body["incidents"]
        assert len(gzip.compress(plain)) < 0.3 * len(plain)
        ore = client.get("/api/incidents", params={"mode": "live", "state": "or"}).json()
        assert [x["state"] for x in ore["incidents"]] == ["OR"]
        assert client.get("/api/incidents", params={"mode": "live", "state": "Oregon"}).status_code == 422
        hist = client.get("/api/incidents", params={"mode": "historical"}).json()
        assert hist["year"] == 2026
        pine = next(x for x in body["incidents"] if x["name"] == "Pine")
        d = client.get(f"/api/incidents/{pine['id']}")
        assert d.status_code == 200 and d.json()["manifest"] is None and d.json()["summary"]["record_source"] == "wfigs"
        ak = client.post(f"/api/incidents/2026-tanana-{ID['4D4D4D4D'][:6].lower()}/build")
        assert ak.status_code == 422 and ak.json()["detail"] == "Fire-3d does not support Alaska, Hawaii or US territories yet."
        assert client.post("/api/incidents/2026-nothing-abcdef/build").status_code == 404


def test_build_gate_text_for_local_bundles(world, tmp_data_dir: Path) -> None:
    from fire3d.api.app import app

    d = tmp_data_dir / "incidents" / "fixture-east"
    d.mkdir(parents=True)
    summ = {"id": "fixture-east", "name": "Fixture East (synthetic)", "mode": "historical", "year": 2025, "calfire_uid": "",
            "started_ms": 1, "updated_ms": None, "contained_ms": None, "acres": 10.0, "percent_contained": None,
            "is_active": False, "county": None, "location": None, "admin_unit": None, "url": None, "lat": 35.29,
            "lon": -82.30, "detections_24h": None, "bundle_status": "ready", "bundle_built_ms": 5}
    (d / "manifest.json").write_text(json.dumps({"status": "ready", "built_ms": 5, "summary": summ}))
    with TestClient(app) as client:
        r = client.post("/api/incidents/fixture-east/build", params={"force": "true"})
        assert r.status_code == 409 and r.json()["detail"] == "'fixture-east' is a local or synthetic bundle; it cannot be rebuilt."
        assert "CAL FIRE catalog" not in r.text
        s = client.get("/api/incidents/fixture-east").json()["summary"]
        assert s["state"] == "NC" and s["time_zone"] == "America/New_York"


def test_lists_unreachable_answer_503_never_a_local_bundle(world, tmp_data_dir: Path) -> None:
    """us-pipeline review R8: when the source lists cannot be reached, a listed fire's id is "cannot tell now" (503 with
    one sentence), never "unknown" or "a local or synthetic bundle"; bundle-only ids never ask the lists."""
    from fire3d.api.app import app
    from fire3d.build import pipeline

    pine_id = f"2026-pine-{ID['E1E2E3E4'][:6].lower()}"
    world["cal_down"] = True
    world["srv"].down = True
    text = "The fire lists could not be reached right now; try again later."
    assert catalog.LISTS_UNAVAILABLE_TEXT == text
    with pytest.raises(catalog.ListsUnavailable) as ei:
        catalog.resolve_listed(pine_id)
    assert str(ei.value) == text and "NIFC WFIGS lookup" in ei.value.failed
    assert catalog.resolve_listed("fixture-demo") is None                   # never a list lookup: no outage to report
    with pytest.raises(catalog.ListsUnavailable):
        catalog.get_summary(pine_id)
    assert not catalog.is_bundle_only(pine_id) and catalog.find_by_irwin("{" + ID["E1E2E3E4"].lower() + "}") is None
    refused = pipeline.gate_refusal(pine_id, {"id": pine_id})
    assert refused.status == 503 and str(refused) == text
    with pytest.raises(pipeline.BuildRefused) as bi:
        pipeline.build_incident(pine_id)
    assert bi.value.status == 503 and str(bi.value) == text
    with TestClient(app) as client:
        for r in (client.post(f"/api/incidents/{pine_id}/build"), client.get(f"/api/incidents/{pine_id}"),
                  client.get("/api/official/incident-record", params={"incident": pine_id})):
            assert r.status_code == 503 and r.json()["detail"] == text, r.text
            assert "local or synthetic" not in r.text and "unknown incident" not in r.text
        # a bundle on disk still answers, and a forced rebuild of it is 503 (cannot tell), not "local or synthetic"
        d = tmp_data_dir / "incidents" / pine_id
        d.mkdir(parents=True)
        summ = {"id": pine_id, "name": "Pine", "mode": "live", "year": 2026, "calfire_uid": "", "started_ms": 1,
                "updated_ms": None, "contained_ms": None, "acres": 1200.0, "percent_contained": 40.0, "is_active": True,
                "county": None, "location": None, "admin_unit": None, "url": None, "lat": 42.4, "lon": -122.9,
                "detections_24h": None, "bundle_status": "ready", "bundle_built_ms": 5, "state": "OR",
                "record_source": "wfigs"}
        (d / "manifest.json").write_text(json.dumps({"id": pine_id, "status": "ready", "built_ms": 5, "summary": summ}))
        assert client.get(f"/api/incidents/{pine_id}").json()["summary"]["id"] == pine_id
        r = client.post(f"/api/incidents/{pine_id}/build", params={"force": "true"})
        assert r.status_code == 503 and r.json()["detail"] == text
        r = client.get("/api/official/incident-record", params={"incident": pine_id})
        assert r.status_code == 503 and "synthetic" not in r.text
    world["cal_down"] = False
    world["srv"].down = False
    catalog.clear_cache()
    assert catalog.resolve_listed(pine_id).id == pine_id                     # back: resolved again


def test_config_year_floor() -> None:
    assert catalog._wf_min(None) == 300 and catalog._wf_min(100) == 100 and catalog._wf_min(0) == catalog.WFIGS_YEAR_FLOOR_ACRES
    assert config.CA_BBOX


def test_id_pinning_keeps_the_bundle_id(world, tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """CONTRACT 14.2 "Id pinning": a fire built while it was WFIGS-only keeps its WFIGS id when CAL FIRE lists it later
    (before/after pair: the McCovey row of this world, then a CAL FIRE record of the same fire)."""
    from fire3d.api.app import app

    before = {r.name: r for r in catalog.get_catalog("live")}["Mccovey"]
    wid = before.id
    d = tmp_data_dir / "incidents" / wid
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"id": wid, "status": "ready", "built_ms": 7, "mode": "live",
                                                 "summary": before.model_dump(mode="json")}))
    mc = cal("McCovey Fire", "ee77ff88-0000-4000-8000-000000000009", 38.0011, -120.4909, "2026-10-10T19:30:00Z", active=True, acres=60)
    monkeypatch.setattr(__import__(__name__), "CAL_LIVE", CAL_LIVE + [mc])
    monkeypatch.setattr(__import__(__name__), "CAL_2026", CAL_2026 + [mc])
    catalog.clear_cache()
    after = {r.name: r for r in catalog.get_catalog("live", refresh=True)}          # refetch (the HTTP cache holds the old list)
    row = after["McCovey Fire"]
    cal_id = catalog.make_incident_id(2026, "McCovey Fire", "ee77ff88")
    assert row.record_source == "calfire" and row.id == wid and row.aliases == [cal_id]
    assert row.bundle_status == "ready" and "Mccovey" not in after
    assert catalog.resolve_listed(cal_id).id == wid and catalog.resolve_listed(wid).id == wid
    with TestClient(app) as client:
        r = client.post(f"/api/incidents/{cal_id}/build")
        assert r.status_code == 409 and r.json()["detail"] == f"'{cal_id}' is listed as '{wid}'."
        assert client.get(f"/api/incidents/{cal_id}").json()["summary"]["id"] == wid
    # the live loop's sync: the bundle summary becomes CAL FIRE's record whole (review R1: never CAL FIRE's acres, time
    # and link under "C&L via NIFC WFIGS" with the IRWIN uid); the id stays
    from fire3d import bundle
    from fire3d.api import live

    assert before.record_source == "wfigs" and before.record_issuer == "C&L via NIFC WFIGS" and before.uid == ID["C1C2C3D4"]
    assert live.sync_live_summaries(list(after.values())) == [wid]
    m = bundle.load_manifest(d)
    ms = m["summary"]
    assert ms["id"] == wid and ms["record_source"] == "calfire" and ms["record_issuer"] == "CAL FIRE"
    assert ms["uid"] == row.uid == mc["UniqueId"] and ms["calfire_uid"] == row.calfire_uid == mc["UniqueId"]
    assert ms["url"] == mc["Url"] and ms["acres"] == 60 and ms["name"] == "McCovey Fire" and ms["source_name"] == row.source_name
    assert ms["agency"] == row.agency and ms["agency_code"] == row.agency_code and ms["aliases"] == [cal_id]
    assert ms["irwin_id"] == ID["C1C2C3D4"] and ms["mode"] == "live" and m["built_ms"] == 7
    assert ms["started_ms"] == row.started_ms != before.started_ms and ms["year"] == row.year     # CAL FIRE's start
    assert not contract_problems(IncidentSummary, ms)
    assert live.sync_live_summaries(list(after.values())) == []                 # one record now: nothing more to copy
    shutil_rm = __import__("shutil").rmtree
    shutil_rm(d)
    catalog.clear_cache()
    plain = {r.name: r for r in catalog.get_catalog("live")}["McCovey Fire"]
    assert plain.id == cal_id and plain.aliases == []                     # without a bundle: the CAL FIRE id
