"""``GET /api/official/incident-record`` (CONTRACT 14.5) and ``GET /api/accuracy-regions`` (14.4), offline on the
synthetic world of ``test_us_catalog_list.py`` and the recorded samples."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from fire3d import catalog
from fire3d.api import records
from fire3d.contracts import AccuracyRegionsResponse, IncidentRecordResponse, contract_problems
from fire3d.sources import wfigs
from test_us_catalog_list import ID, world  # noqa: F401 - the shared fixture
from test_us_catalog_samples import recorded  # noqa: F401 - the shared fixture


@pytest.fixture(autouse=True)
def _no_live_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    from fire3d import config

    monkeypatch.setattr(config, "LIVE_ENABLED", False)
    monkeypatch.setattr(config, "AUTO_BUILD_LIVE", False)


@pytest.fixture
def client():
    from fire3d.api.app import app

    with TestClient(app) as c:
        yield c


def _record(client: TestClient, incident: str) -> dict:
    r = client.get("/api/official/incident-record", params={"incident": incident})
    assert r.status_code == 200, r.text
    assert contract_problems(IncidentRecordResponse, r.content) == [], r.text
    assert r.headers["cache-control"] == "no-store"
    d = r.json()
    assert d["kind"] == "incident_record" and d["publisher"] == "NIFC WFIGS (IRWIN)" and d["changes"] == []
    assert records.CAVEAT_NUMBERS in d["caveats"] and records.CAVEAT_NOT_ALL_CLEAR in d["caveats"]
    return d


def test_wfigs_row_record_available(world, client) -> None:
    pine = next(r for r in catalog.get_catalog("live") if r.name == "Pine")
    world["srv"].all_years = list(world["srv"].current)
    d = _record(client, pine.id)
    assert d["status"] == "available" and d["reason_code"] is None
    assert d["irwin_id"] == ID["E1E2E3E4"] and d["agency_code"] == "USFS" and d["agency"] is None
    assert d["incident_url"].startswith("https://") and "f=html" in d["incident_url"] and d["dataset_url"].startswith("https://")
    assert d["current"]["name"] == "PINE" and d["current"]["is_active"] is True and d["current"]["acres"] == 1200
    assert d["current"]["updated_ms"] and d["source_updated_ms"] == d["current"]["updated_ms"] and d["retrieved_ms"]
    assert d["state"] == "OR" and d["time_zone"] == "America/Los_Angeles" and d["protecting_unit"] == "XXUNF"


def test_calfire_rows(world, client) -> None:
    world["srv"].all_years = list(world["srv"].current)
    rows = {r.name: r for r in catalog.get_catalog("live")}
    timber = _record(client, rows["Timber Fire"].id)                     # matched to one WFIGS record
    assert timber["status"] == "available" and timber["irwin_id"] == ID["A1B2C3D4"] and timber["current"]["name"] == "TIMBER"
    cx = _record(client, rows["Big Bear Complex"].id)                    # a CAL FIRE complex: never one member's record
    assert cx["status"] == "unavailable" and cx["reason_code"] == "not_covered" and cx["reason"] == records.REASON_COMPLEX
    assert cx["current"] is None and cx["irwin_id"] is None
    hist = {r.name: r for r in catalog.get_catalog("historical", year=2026, min_acres=0)}
    marshall = _record(client, hist["Marshall Fire"].id)                 # CAL FIRE row without a WFIGS match
    assert marshall["reason_code"] == "not_covered" and marshall["reason"] == "NIFC WFIGS has no record matched to this fire."


def test_synthetic_unknown_and_down(world, client, tmp_data_dir: Path) -> None:
    d = tmp_data_dir / "incidents" / "fixture-east"
    d.mkdir(parents=True)
    summ = {"id": "fixture-east", "name": "Fixture East (synthetic)", "mode": "historical", "year": 2025, "calfire_uid": "",
            "started_ms": 1, "updated_ms": None, "contained_ms": None, "acres": 10.0, "percent_contained": None,
            "is_active": False, "county": None, "location": None, "admin_unit": None, "url": None, "lat": 35.29,
            "lon": -82.30, "detections_24h": None, "bundle_status": "ready", "bundle_built_ms": 5, "record_source": "wfigs",
            "record_issuer": "NIFC WFIGS (IRWIN)", "irwin_id": None}
    (d / "manifest.json").write_text(json.dumps({"status": "ready", "built_ms": 5, "summary": summ}))
    east = _record(client, "fixture-east")
    assert east["reason_code"] == "not_covered" and east["reason"] == "This is synthetic or local data; it has no agency record."
    assert east["time_zone"] == "America/New_York"
    assert client.get("/api/official/incident-record", params={"incident": "2026-nothing-abcdef"}).status_code == 404
    pine = next(r for r in catalog.get_catalog("live") if r.name == "Pine")
    world["srv"].down = True
    catalog.clear_cache()
    down = client.get("/api/official/incident-record", params={"incident": pine.id})
    assert down.status_code in (200, 404)                                # the id needs the list to resolve
    if down.status_code == 200:
        assert down.json()["reason_code"] == "upstream_error" and down.json()["current"] is None


def test_record_on_recorded_sample(recorded, client) -> None:
    d = _record(client, "2024-horse-gulch-889237")
    assert d["status"] == "available" and d["unique_fire_id"] == "2024-MTHLF-000367" and d["state"] == "MT"
    assert d["time_zone"] == "America/Denver" and d["current"]["is_active"] is False and d["current"]["name"] == "Horse Gulch"
    assert d["incident_url"] == wfigs.record_url("889237AA-38DC-45D4-A8D0-B70D8990F5B7")
    tcu = next(r for r in catalog.get_catalog("historical", year=2025) if r.name.startswith("TCU"))
    t = _record(client, tcu.id)
    assert t["reason"] == "This is a CAL FIRE complex; NIFC WFIGS lists its member fires separately." and t["current"] is None


# ------------------------------------------------------------------------------------------------------------------
# Accuracy regions
# ------------------------------------------------------------------------------------------------------------------
def test_accuracy_regions_seed(client) -> None:
    r = client.get("/api/accuracy-regions")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-cache"
    assert contract_problems(AccuracyRegionsResponse, r.content) == []
    d = r.json()
    assert [x["id"] for x in d["regions"]] == list(records.REGION_NAMES) and len(d["regions"]) == 10
    oscc = d["regions"][-1]
    assert oscc["id"] == "OSCC" and oscc["status"] == "tested" and oscc["in_sample"] is True and oscc["seed"] is True
    assert oscc["n_fires"] == 3 and oscc["n_leads"] == 32 and oscc["range"] == [0.395, 0.467]
    assert round(oscc["growth_sorensen"], 2) == 0.43 and oscc["pooled_leads"] == 0.438 and oscc["growth_ratio_median"] == 1.85
    assert oscc["lfm_method"] == "ca_month_table_drought" and "fuels_editions" not in oscc
    assert all(x["status"] == "untested" and x["n_fires"] == 0 for x in d["regions"][:-1])
    assert d["served_ms"] > 0 and d["schema_version"] == 1


def test_region_status_rule(tmp_path: Path) -> None:
    assert records.region_status({"n_fires": 2, "n_leads": 12}) == "limited"         # 2 fires, 12 leads
    assert records.region_status({"n_fires": 2, "n_leads": 16}) == "tested"
    assert records.region_status({"n_fires": 1, "n_leads": 40}) == "limited"
    assert records.region_status({"n_fires": 0}) == "untested"
    f = tmp_path / "acc.json"
    base = json.loads(records.ACCURACY_FILE.read_text())
    base["regions"] = [{"id": "NWCC", "name": "Northwest", "status": "tested", "n_fires": 2, "n_leads": 12}]
    f.write_text(json.dumps(base))
    d = records.accuracy_payload(f)
    assert len(d["regions"]) == 10 and d["regions"][0]["status"] == "limited"
    assert {x["status"] for x in d["regions"][1:]} == {"untested"}
    assert contract_problems(AccuracyRegionsResponse, d) == []
