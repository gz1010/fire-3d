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
    assert d["irwin_id"] == ID["E1E2E3E4"] and d["agency_code"] == "USFS" and d["agency"] == "USDA Forest Service"
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


def test_calfire_row_with_several_records(world, client, monkeypatch: pytest.MonkeyPatch) -> None:
    """Review R3: a CAL FIRE row matched to several WFIGS records, none with its name (``irwin_id`` null): the reason
    names them, never "no record matched"; one record or none keeps the contract wording."""
    from fire3d.contracts import OtherRecord

    timber = next(r for r in catalog.get_catalog("live") if r.name == "Timber Fire")
    o = timber.other_records[0]
    two = [o, o.model_copy(update={"id": ID["9C9C9C9C"], "name": "BRADFORD BRANCH"})]
    assert isinstance(o, OtherRecord) and o.name == "TIMBER"
    row = timber.model_copy(update={"irwin_id": None, "unique_fire_id": None, "other_records": two})
    monkeypatch.setattr(catalog, "resolve_listed", lambda i: row if i == timber.id else None)
    d = _record(client, timber.id)
    assert d["status"] == "unavailable" and d["reason_code"] == "not_covered" and d["current"] is None
    assert d["reason"] == "NIFC WFIGS lists this fire under several records (TIMBER, BRADFORD BRANCH), so no single record is shown here."
    assert d["irwin_id"] is None and d["incident_url"] is None and records.several_reason(["A", "B"]).count("A, B") == 1
    row1 = row.model_copy(update={"other_records": []})
    monkeypatch.setattr(catalog, "resolve_listed", lambda i: row1 if i == timber.id else None)
    assert _record(client, timber.id)["reason"] == records.REASON_NO_MATCH


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
    assert down.status_code in (200, 503)                                # the id needs the list: never 404 (R8)
    if down.status_code == 200:
        assert down.json()["reason_code"] == "upstream_error" and down.json()["current"] is None
    else:
        assert down.json()["detail"] == catalog.LISTS_UNAVAILABLE_TEXT


def test_same_name_records_are_one_record() -> None:
    """us-catalog review N2: CAL FIRE's Lucas Fire matched two NIFC WFIGS records both named LUCAS (recorded live
    2026-10-23: one from each of two CAL FIRE units). They are one fire's records: the larger, then the newer, is the
    fire's record (irwin_id), so the record panel never says "several records (LUCAS, LUCAS)"; both stay listed."""
    from test_us_catalog_mock import feature

    def lucas(irwin: str, ufi: str, size: float, discovered: str, modified: str, pct: float | None) -> dict:
        f = feature("LUCAS", irwin, "US-CA", -122.80, 39.00, ufi=ufi, size=size, pct=pct, discovered=discovered,
                    modified=modified, agency="CAL FIRE", unit=ufi.split("-")[1], county="Lake", gacc="ONCC")
        return wfigs.normalize(f)

    meu = lucas("06749cfd-de8b-4cfa-8c11-075f7d8ab353", "2026-CAMEU-010693", 1099, "2026-09-11T14:18:08Z",
                "2026-09-12T00:46:35Z", None)
    lnu = lucas("0330e46b-236e-4706-8a32-04ac4a27ac1f", "2026-CALNU-016127", 4128, "2026-09-11T19:21:21Z",
                "2026-09-24T07:20:33Z", 100)
    cal = catalog.summary_from_record({"name": "Lucas Fire", "uid": "21bc39aa-0000-4000-8000-000000000001", "year": 2026,
                                       "started_ms": meu["started_ms"],
                                       "lat": 39.0, "lon": -122.8, "is_active": False, "acres": 4128.0, "type": "Wildfire"},
                                      "historical")
    assert cal is not None
    for order in ([meu, lnu], [lnu, meu]):
        row = catalog.enrich_calfire(cal, list(order), [], set())
        assert row.irwin_id == lnu["irwin_id"] and row.unique_fire_id == "2026-CALNU-016127"
        assert sorted(o.id for o in row.other_records) == sorted([meu["irwin_id"], lnu["irwin_id"]])
        assert row.complex_members in (None, [])
    same = dict(meu, acres=4128.0)                                         # equal sizes: the newer record
    assert catalog.enrich_calfire(cal, [same, lnu], [], set()).irwin_id == lnu["irwin_id"]
    other = dict(meu, source_name="BRADFORD BRANCH")                       # Dale rule unchanged: the same-name one
    assert catalog.enrich_calfire(cal, [other, lnu], [], set()).irwin_id == lnu["irwin_id"]
    nobody = [dict(meu, source_name="NORTH"), dict(lnu, source_name="SOUTH")]
    assert catalog.enrich_calfire(cal, nobody, [], set()).irwin_id is None   # none named like the fire: no single record


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
    # The us-catalog seed was replaced by the validation tooling (brief 3 wave 2; CONTRACT 14.4): OSCC re-measured
    # after the GSI code with the same values, no `seed` key, every status by the 14.4 rule.
    assert oscc["id"] == "OSCC" and oscc["status"] == "tested" and oscc["in_sample"] is True and "seed" not in oscc
    assert oscc["n_fires"] == 3 and oscc["n_leads"] == 32 and oscc["range"] == [0.395, 0.467]
    assert round(oscc["growth_sorensen"], 2) == 0.43 and oscc["pooled_leads"] == 0.438 and oscc["growth_ratio_median"] == 1.85
    assert oscc["lfm_method"] == "ca_month_table_drought"
    assert all(x["status"] == records.region_status(x) for x in d["regions"])
    assert {x["id"] for x in d["regions"] if x["status"] == "untested"} >= {"RMCC", "EACC", "ONCC"}
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


def test_california_county_gacc_fallback() -> None:
    import orjson

    raw = orjson.loads(catalog.CA_COUNTY_GACC_FILE.read_bytes())
    nulls = sorted(v["name"] for v in raw["counties"].values() if v["gacc"] is None)
    assert nulls == ["Alpine", "Imperial", "Mono", "San Joaquin", "Sierra", "Stanislaus"]
    assert raw["meta"]["credit"] == "NIFC WFIGS (IRWIN)" and raw["meta"]["retrieved"]
    assert catalog.ca_county_region(-118.07, 34.20) == "OSCC"          # Los Angeles County (Altadena)
    assert catalog.ca_county_region(-122.39, 40.59) == "ONCC"          # Shasta County (Redding)
    assert catalog.ca_county_region(-120.99, 37.64) is None            # Stanislaus County (Modesto): mixed
    assert catalog.ca_county_region(-116.2, 43.6) is None              # not California
    from fire3d.sources.calfire import normalize_incident

    rec = normalize_incident({"Name": "Test Fire", "UniqueId": "abcdef12-0000", "Started": "2026-07-01T20:00:00Z",
                              "Latitude": 34.2, "Longitude": -118.07, "IsActive": False, "Type": "Wildfire", "AcresBurned": 500})
    s = catalog.summary_from_record(rec, "historical")
    assert s.accuracy_region == "OSCC" and s.gacc is None              # region from the county table, no GACC claimed


def test_nwcg_agency_names() -> None:
    import orjson

    raw = orjson.loads(catalog.AGENCY_CODES_FILE.read_bytes())
    assert "PMS 931" in raw["meta"]["source"] and "public domain" in raw["meta"]["terms"] and raw["meta"]["checked"]
    assert catalog.agency_name("USFS") == "USDA Forest Service" and catalog.agency_name("C&L") == "County and Local"
    assert catalog.agency_name("DNR") == "Department of Natural Resources" and catalog.agency_name("BLM") == "Bureau of Land Management"
    assert catalog.agency_name("USMC") is None and catalog.agency_name(None) is None      # unknown: shown verbatim
    rows = [r for r in __import__("json").loads((__import__("pathlib").Path(__file__).parent / "data" / "firedata" /
                                                  "us_wfigs_current.json").read_text())["features"]]
    used = {r["attributes"]["POOProtectingAgency"] for r in rows if r["attributes"]["POOProtectingAgency"]}
    named = {c for c in used if catalog.agency_name(c)}
    assert len(named) >= 0.75 * len(used)                                 # most codes in use have a plain name
