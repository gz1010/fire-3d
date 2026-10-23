"""Brief 3 evacuations across the lower 48 (CONTRACT §14.8; offline).

The state registry answers "not available in this state" without any upstream request; Oregon OEM is read next to
Cal OES; California answers keep every brief-2 key and value; personal fields never leave the backend. Upstream calls
go through fire3d.http with an httpx.MockTransport router that counts requests (the autouse conftest guard refuses any
real network access).
"""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from fire3d.api import extras as ex
from fire3d.sources import evacuations as evac
from test_extras import (  # noqa: F401 - fixtures `router` and `client` are used by name
    EVAC_FEATURES,
    INVENTORY_IMPERIAL,
    INVENTORY_LA,
    LA_BBOX,
    NOW,
    Router,
    client,
    evac_routes,
    geojson,
    router,
)

DATA = Path(__file__).parent / "data" / "evacuations"
OR_SAMPLE = json.loads((DATA / "or_oem_2026-08-15T1200Z.geojson").read_text())
OR_LAYER_INFO = json.loads((DATA / "or_oem_layer_info.json").read_text())
B2_EXPECTED = json.loads((DATA / "caloes_brief2_expected.json").read_text())["answers"]

OR_QUERY = "Fire_Evacuation_Areas_Public/FeatureServer/0/query"
OR_INFO = "Fire_Evacuation_Areas_Public/FeatureServer/0?"
PERSONAL = re.compile(r"email|phone|user|editor|creator|submit", re.I)
OEM_NONE_SENTENCE = "If there are no records in this dataset, there are no evacuations currently in place."

BBOXES_NOT_AVAILABLE = {
    "Reno NV": ("-119.9,39.45,-119.7,39.6", "Nevada"),
    "Carson City NV": ("-119.8,39.12,-119.7,39.2", "Nevada"),
    "Las Vegas NV": ("-115.3,36.1,-115.1,36.25", "Nevada"),
    "Yuma AZ": ("-114.6,32.64,-114.52,32.72", "Arizona"),
    "Bozeman MT": ("-111.1,45.62,-110.98,45.72", "Montana"),
    "Seattle WA": ("-122.4,47.55,-122.25,47.68", "Washington"),
    "Tampa FL": ("-82.55,27.9,-82.4,28.05", "Florida"),
}
KLAMATH_FALLS = "-121.83,42.18,-121.73,42.26"
BROOKINGS = "-124.32,41.95,-124.22,42.1"
MEDFORD = "-123.2,42.2,-122.6,42.6"          # around the recorded Fielders Mountain zones (Jackson County)


def or_routes(r: Router, features: list[dict] | None = None, status: int = 200) -> Router:
    r.add(OR_INFO, httpx.Response(200, json=OR_LAYER_INFO))
    if status != 200:
        r.add(OR_QUERY, httpx.Response(status, text="busy"))
    else:
        r.add(OR_QUERY, geojson(OR_SAMPLE["features"] if features is None else features))
    return r


def keys_deep(obj: Any) -> set[str]:
    out: set[str] = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.add(str(k))
            out |= keys_deep(v)
    elif isinstance(obj, list):
        for v in obj:
            out |= keys_deep(v)
    return out


def assert_superset(old: Any, new: Any, path: str = "") -> None:
    """Every key of ``old`` is in ``new`` with the same value (dicts compared key by key, lists item by item)."""
    if isinstance(old, dict):
        assert isinstance(new, dict), path
        for k, v in old.items():
            assert k in new, f"{path}.{k} missing"
            assert_superset(v, new[k], f"{path}.{k}")
    elif isinstance(old, list):
        assert isinstance(new, list) and len(new) == len(old), f"{path}: {new!r:.200} vs {old!r:.200}"
        for i, (a, b) in enumerate(zip(old, new)):
            assert_superset(a, b, f"{path}[{i}]")
    else:
        assert new == old, f"{path}: {new!r} != {old!r}"


# ------------------------------------------------------------------------------------------------------------------
# Registry
# ------------------------------------------------------------------------------------------------------------------
def test_registry_has_only_california_and_oregon() -> None:
    assert len(evac.STATE_AVAILABILITY) == 49                        # 48 states + DC
    available = sorted(s for s, v in evac.STATE_AVAILABILITY.items() if v["availability"] == "available")
    assert available == ["CA", "OR"]
    assert set(evac.ADAPTERS) == {"caloes_evacuations", "or_oem_evacuations"}
    for st in ("WA", "FL", "AZ", "NV", "MT"):
        reg = evac.STATE_AVAILABILITY[st]
        assert reg["availability"] == "not_available" and reg["adapter_ids"] == [] and reg["audited"] == "2026-10-22"
    assert evac.STATE_AVAILABILITY["AZ"]["note"] == ("Arizona's statewide zones are planning zones whose status was not "
                                                       "kept up to date in 2026; not shown.")
    for ad in evac.ADAPTERS.values():
        assert "*" not in ad.out_fields and ad.ttl_s == 120.0 and ad.limiter is evac.ARCGIS_LIMITER
        assert not any(PERSONAL.search(f) for f in ad.out_fields)
    assert evac.ADAPTERS["caloes_evacuations"].confirm_drop and not evac.ADAPTERS["or_oem_evacuations"].confirm_drop
    assert ex.UP_ARCGIS.limiter is evac.ARCGIS_LIMITER                # one limit for services.arcgis.com
    assert not any("wa_" in k or "washington" in k.lower() for k in ex.SOURCES)


@pytest.mark.parametrize("status,key", [
    ("No Evacuation Order", "other"), ("Not Reporting", "other"), ("NO EVACUATION ORDER", "other"), ("None", "other"),
    ("Level 1 - Ready", "advisory"), ("Level 2 - Be Set", "warning"), ("Level 3 - Go", "order"), ("Level 3", "order"),
    ("Planning Zone", "other"), (None, "unknown"), ("Evacuation Order", "order"), ("Evacuation Order Lifted", "lifted"),
])
def test_status_mapping_regressions(status, key) -> None:
    """EV-R6: a negation never maps to order, warning or advisory."""
    assert evac.evac_status_key(status) == key
    assert ex.evac_status_key(status) == key


def test_placeholder_rows_are_dropped() -> None:
    sq = {"type": "Polygon", "coordinates": [[[-118.8, 34.1], [-118.7, 34.1], [-118.7, 34.2], [-118.8, 34.1]]]}
    for s in ("No Evacuation Order", "Not Reporting"):
        assert evac.normalize_caloes({"geometry": sq, "properties": {"STATUS": s, "ZONE_ID": "X"}}) is None
    assert evac.normalize_caloes({"geometry": sq, "properties": {"STATUS": "Evacuation Warning", "ZONE_ID": "X"}}) is not None
    for lv in (None, 0, 4, "x"):
        assert evac.normalize_oregon({"geometry": sq, "properties": {"Fire_Evacuation_Level": lv, "County": "Lane"}}) is None


# ------------------------------------------------------------------------------------------------------------------
# Not available in this state: no upstream request
# ------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("place", sorted(BBOXES_NOT_AVAILABLE))
def test_state_not_available_makes_no_request(place: str, router: Router, client: TestClient) -> None:
    bbox, name = BBOXES_NOT_AVAILABLE[place]
    d = client.get("/api/extras/evacuations", params={"bbox": bbox}).json()
    assert router.calls == []                                   # 0 upstream requests
    assert d["status"] == "unavailable" and d["reason_code"] == "state_not_available"
    assert d["reason"] == f"Official evacuation zones are not available in this state ({name}). Follow local officials."
    assert d["zones"]["features"] == [] and d["counts"] == {} and d["sources"] == []
    assert [s["name"] for s in d["states"]] == [name]
    st = d["states"][0]
    assert st["availability"] == "not_available" and st["checked"] is False and st["source_ids"] == []


def test_state_not_available_also_for_past_dates_and_incidents(router: Router, client: TestClient, tmp_data_dir: Path) -> None:
    from test_extras import write_manifest

    d = client.get("/api/extras/evacuations", params={"bbox": BBOXES_NOT_AVAILABLE["Bozeman MT"][0], "at_ms": NOW - 3 * 86_400_000}).json()
    assert d["reason_code"] == "state_not_available"
    write_manifest(tmp_data_dir, "2026-test-fire-mt0001", "live", [-111.1, 45.62, -110.98, 45.72])
    d = client.get("/api/extras/evacuations", params={"incident": "2026-test-fire-mt0001"}).json()
    assert d["reason_code"] == "state_not_available" and "(Montana)" in d["reason"]
    assert router.calls == []


def test_outside_the_lower_48(router: Router, client: TestClient) -> None:
    ak = client.get("/api/extras/evacuations", params={"bbox": "-150.0,61.1,-149.8,61.25"}).json()
    assert ak["reason_code"] == "state_not_available" and ak["reason"] == "Fire-3d does not support Alaska, Hawaii or US territories yet."
    mx = client.get("/api/extras/evacuations", params={"bbox": "-117.1,32.45,-116.95,32.52"}).json()
    assert mx["reason"] == "Outside the United States: Fire-3d has no data here." and mx["states"] == []
    assert router.calls == []


# ------------------------------------------------------------------------------------------------------------------
# Oregon
# ------------------------------------------------------------------------------------------------------------------
def test_klamath_falls_checks_oregon_and_says_not_an_all_clear(router: Router, client: TestClient) -> None:
    or_routes(router, features=[])
    d = client.get("/api/extras/evacuations", params={"bbox": KLAMATH_FALLS}).json()
    assert d["status"] == "available" and d["reason_code"] is None
    assert d["zones"]["features"] == [] and d["counts"] == {}
    assert [s["id"] for s in d["sources"]] == ["or_oem_evacuations"]
    src = d["sources"][0]
    assert src["status"] == "available" and src["home_state"] == "OR"
    assert src["credit"] == "Oregon Department of Emergency Management"
    assert src["updated_ms"] == 1790707347957 and isinstance(src["retrieved_ms"], int)
    assert d["retrieved_ms"] == src["retrieved_ms"] and d["source_updated_ms"] == src["updated_ms"]  # one source
    assert d["states"] == [{"state": "OR", "name": "Oregon", "availability": "available", "checked": True,
                            "source_ids": ["or_oem_evacuations"], "note": None,
                            "links": [{"label": "Oregon OEM evacuation areas", "url": evac.OR_OEM_ITEM_URL}]}]
    assert any("not an all-clear" in c and "Oregon OEM" in c for c in d["caveats"])
    assert OEM_NONE_SENTENCE not in json.dumps(d)
    assert "Cal OES" not in json.dumps(d)                         # no Cal OES request, credit or caveat in Oregon
    assert router.count("CA_EVACUATIONS") == 0 and router.count(OR_QUERY) == 1
    # the query asks for the whitelisted fields only
    q = next(u for u in router.calls if OR_QUERY in u)
    assert "outFields=OBJECTID%2CGlobalID%2CFire_Name%2CFire_Evacuation_Level%2CCounty%2CEvac_Area_Name%2CHazardType%2Ccreated_date%2Clast_edited_date" in q


def test_recorded_oregon_sample_levels_labels_and_times(router: Router, client: TestClient) -> None:
    or_routes(router)
    d = client.get("/api/extras/evacuations", params={"bbox": MEDFORD}).json()
    zones = d["zones"]["features"]
    assert len(zones) == 12 and d["counts"] == {"order": 4, "warning": 2, "advisory": 6}
    by_name = {z["properties"]["zone_name"]: z["properties"] for z in zones}
    p = by_name["US-OR-JAC-JAC-043"]
    assert p["status"] == "Level 3" and p["status_verbatim"] is False and p["status_raw"] == 3
    assert p["status_label"] == "Level 3: GO NOW – Leave Immediately!" and p["status_key"] == "order"
    assert p["status_label_source"] == evac.OR_OEM_LEVELS_URL
    assert p["county"] == "Jackson County" and p["jurisdiction"] == "Jackson County" and p["state"] == "OR"
    assert p["incident_name"] == "Fielders Mountain" and p["hazard_type"] == "Fire"
    assert p["status_updated_ms"] is None and p["aggregated_ms"] is None             # OEM gives no issue time
    assert p["listed_ms"] == 1786666812468 and p["time_basis"] == "state_layer_added"  # created_date, never last edit
    assert 1786795206716 not in [v for z in zones for v in z["properties"].values()]   # last_edited_date never shown
    assert by_name["US-OR-JAC-JAC-044"]["status_label"] == "Level 1: BE READY to evacuate"
    assert by_name["US-OR-JAC-JAC-052-A"]["status_label"] == "Level 2: BE SET to evacuate"
    slide = by_name["HWY 229 Landslide"]
    assert slide["hazard_type"] == "Other" and slide["status"] == "Level 3" and slide["county"] == "Lincoln County"
    unnamed = by_name["US-OR-UMA-UMC-1406026"]
    assert unnamed["incident_name"] is None and unnamed["county"] == "Umatilla County"
    assert zones[0]["properties"]["status_key"] == "order"                            # most urgent first
    assert any("added to the Oregon state layer" in c for c in d["caveats"])
    assert not any("not an all-clear" in c for c in d["caveats"])                     # zones are listed


def test_oregon_failure_is_never_none(router: Router, client: TestClient) -> None:
    or_routes(router, status=503)
    d = client.get("/api/extras/evacuations", params={"bbox": KLAMATH_FALLS}).json()
    assert d["status"] == "unavailable" and d["reason_code"] == "upstream_error"
    assert "Oregon OEM ArcGIS services could not be reached (HTTP 503)" in d["reason"]
    assert d["sources"][0]["status"] == "unavailable" and d["states"][0]["checked"] is False


# ------------------------------------------------------------------------------------------------------------------
# Mixed states and borders
# ------------------------------------------------------------------------------------------------------------------
def _square(lon: float, lat: float, d: float = 0.01) -> dict:
    return {"type": "Polygon", "coordinates": [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]]}


def test_brookings_reads_both_states_with_one_copy_per_zone(router: Router, client: TestClient) -> None:
    ca_zone = {"type": "Feature", "id": 7, "geometry": _square(-124.2, 41.96),
               "properties": {"OBJECTID": 7, "COUNTY": "DEL NORTE", "ZONE_ID": "US-CA-XDN-SMI-001", "STATUS": "Evacuation Warning",
                              "EDIT_DATE": NOW - 3_600_000, "EditDate": NOW - 3_000_000}}
    # Oregon OEM's County domain includes "Del Norte": the same zone may also come from Oregon's layer
    or_copy = {"type": "Feature", "id": 70, "geometry": _square(-124.2, 41.96),
               "properties": {"OBJECTID": 70, "GlobalID": "{DN-COPY}", "Fire_Evacuation_Level": 2, "County": "Del Norte",
                              "Evac_Area_Name": "US-CA-XDN-SMI-001", "HazardType": "Fire", "created_date": NOW - 7_200_000}}
    or_zone = {"type": "Feature", "id": 71, "geometry": _square(-124.27, 42.05),
               "properties": {"OBJECTID": 71, "GlobalID": "{CURRY-1}", "Fire_Evacuation_Level": 1, "County": "Curry",
                              "Evac_Area_Name": "US-OR-CUR-BRK-001", "HazardType": "Fire", "created_date": NOW - 7_200_000}}
    evac_routes(router, zones=[ca_zone], inventory=[{"type": "Feature", "id": 8, "geometry": None, "properties": {"CountyName": "Del Norte", "Source": "County", "Reference_App": None, "DataInUse": "Yes", "DataAcqStatus": "Acquired"}}])
    or_routes(router, features=[or_copy, or_zone])
    d = client.get("/api/extras/evacuations", params={"bbox": BROOKINGS}).json()
    assert d["status"] == "available"
    assert [s["id"] for s in d["sources"]] == ["caloes_evacuations", "caloes_evacuation_inventory", "or_oem_evacuations"]
    assert all(s["status"] == "available" for s in d["sources"])
    assert {s["state"]: s["checked"] for s in d["states"]} == {"CA": True, "OR": True}
    ids = [z["id"] for z in d["zones"]["features"]]
    assert ids == ["US-CA-XDN-SMI-001", "{CURRY-1}"]          # the Del Norte zone once, from Cal OES
    srcs = {z["id"]: z["properties"]["source_id"] for z in d["zones"]["features"]}
    assert srcs == {"US-CA-XDN-SMI-001": "caloes_evacuations", "{CURRY-1}": "or_oem_evacuations"}
    assert d["retrieved_ms"] is None and d["source_updated_ms"] is None   # several sources: read sources[]
    assert "Cal OES aggregates" in d["issuing_authority"] and "Oregon OEM aggregates" in d["issuing_authority"]


def test_brookings_keeps_oregon_copy_when_cal_oes_fails(router: Router, client: TestClient) -> None:
    or_copy = {"type": "Feature", "id": 70, "geometry": _square(-124.2, 41.96),
               "properties": {"OBJECTID": 70, "GlobalID": "{DN-COPY}", "Fire_Evacuation_Level": 2, "County": "Del Norte",
                              "Evac_Area_Name": "US-CA-XDN-SMI-001", "HazardType": "Fire", "created_date": NOW - 7_200_000}}
    evac_routes(router, zones=httpx.Response(503, text="busy"), inventory=INVENTORY_LA)
    or_routes(router, features=[or_copy])
    d = client.get("/api/extras/evacuations", params={"bbox": BROOKINGS}).json()
    assert d["status"] == "available" and [z["id"] for z in d["zones"]["features"]] == ["{DN-COPY}"]
    assert d["zones"]["features"][0]["properties"]["state"] == "CA"
    ca = next(s for s in d["sources"] if s["id"] == "caloes_evacuations")
    assert ca["status"] == "unavailable" and "HTTP 503" in ca["reason"]
    assert any(c.startswith("California: Cal OES could not be checked") for c in d["caveats"])
    assert {s["state"]: s["checked"] for s in d["states"]} == {"CA": False, "OR": True}


def test_mixed_with_a_state_without_a_feed(router: Router, client: TestClient) -> None:
    """A CA/NV bbox near Lake Tahoe: Cal OES is read; Nevada adds its caveat."""
    evac_routes(router, zones=[], inventory=INVENTORY_LA)
    d = client.get("/api/extras/evacuations", params={"bbox": "-120.1,39.0,-119.9,39.2"}).json()
    assert d["status"] == "available"
    assert {s["state"]: (s["availability"], s["checked"]) for s in d["states"]} == {"CA": ("available", True), "NV": ("not_available", False)}
    assert "Nevada: official evacuation zones are not available in this state" in d["caveats"]
    assert router.count(OR_QUERY) == 0


# ------------------------------------------------------------------------------------------------------------------
# California: every brief-2 key keeps its value
# ------------------------------------------------------------------------------------------------------------------
CA_CASES = {
    "la_zones": (EVAC_FEATURES, INVENTORY_LA, LA_BBOX),
    "la_empty": ([], INVENTORY_LA, LA_BBOX),
    "imperial_not_covered": (EVAC_FEATURES, INVENTORY_IMPERIAL, "-115.7,32.7,-115.3,33.0"),
    "la_upstream_503": (httpx.Response(503, text="busy"), INVENTORY_LA, LA_BBOX),
}


@pytest.mark.parametrize("case", sorted(CA_CASES))
def test_california_answers_keep_every_brief2_value(case: str, router: Router, client: TestClient) -> None:
    zones, inventory, bbox = CA_CASES[case]
    evac_routes(router, zones=zones, inventory=inventory)
    d = client.get("/api/extras/evacuations", params={"bbox": bbox}).json()
    old = copy.deepcopy(B2_EXPECTED[case])
    if old["retrieved_ms"] == "<fetch time>":
        assert isinstance(d["retrieved_ms"], int)
        old.pop("retrieved_ms")
    assert_superset(old, d)
    # only the §14.8.2 keys are new
    assert set(d) - set(B2_EXPECTED[case]) == {"states"}
    added_src = {"retrieved_ms", "updated_ms", "status", "reason", "home_state", "credit"}
    for s_old, s_new in zip(B2_EXPECTED[case]["sources"], d["sources"]):
        assert set(s_new) - set(s_old) == added_src
    added_zone = {"state", "source_id", "status_verbatim", "status_raw", "status_label", "status_label_source",
                  "incident_name", "hazard_type", "listed_ms", "time_basis"}
    for z_old, z_new in zip(B2_EXPECTED[case]["zones"]["features"], d["zones"]["features"]):
        assert set(z_new["properties"]) - set(z_old["properties"]) == added_zone
        assert z_new["properties"]["state"] == "CA" and z_new["properties"]["status_verbatim"] is True
        assert z_new["properties"]["time_basis"] == "issuer"
    assert d["states"][0]["state"] == "CA" and d["states"][0]["availability"] == "available"


def test_california_query_requests_whitelisted_fields_only(router: Router, client: TestClient) -> None:
    evac_routes(router)
    client.get("/api/extras/evacuations", params={"bbox": LA_BBOX})
    q = next(u for u in router.calls if "CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0/query" in u)
    assert "outFields=%2A" not in q and "outFields=*" not in q
    assert "outFields=OBJECTID%2CSTATUS%2CZONE_ID" in q


# ------------------------------------------------------------------------------------------------------------------
# Privacy (EV-R4)
# ------------------------------------------------------------------------------------------------------------------
def test_no_personal_keys_in_any_answer(router: Router, client: TestClient) -> None:
    feats = copy.deepcopy(OR_SAMPLE["features"])
    for f in feats:     # even if the layer sent them, they would not be passed on
        f["properties"].update(Editor_Name="A Person", Editor_Email="a@example.org", Editor_Phone="555",
                               created_user="someone", last_edited_user="someone")
    ca = copy.deepcopy(EVAC_FEATURES)        # Cal OES rows carry Creator / Editor ("CalOES_Scripts")
    evac_routes(router, zones=ca)
    or_routes(router, features=feats)
    answers = [client.get("/api/extras/evacuations", params={"bbox": b}).json() for b in (LA_BBOX, MEDFORD, BROOKINGS, KLAMATH_FALLS)]
    answers.append(client.get("/api/extras/evacuations", params={"bbox": BBOXES_NOT_AVAILABLE["Reno NV"][0]}).json())
    for d in answers:
        bad = sorted(k for k in keys_deep(d) if PERSONAL.search(k))
        assert bad == [], bad
    assert "a@example.org" not in json.dumps(answers)


# ------------------------------------------------------------------------------------------------------------------
# Cameras (§14.8.6)
# ------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("bbox", [BBOXES_NOT_AVAILABLE["Reno NV"][0], KLAMATH_FALLS, BBOXES_NOT_AVAILABLE["Tampa FL"][0], "-150.0,61.1,-149.8,61.25"])
def test_cameras_outside_california(bbox: str, router: Router, client: TestClient) -> None:
    d = client.get("/api/extras/cameras", params={"bbox": bbox}).json()
    assert d["status"] == "unavailable" and d["reason_code"] == "state_not_available"
    assert d["reason"] == "Public cameras: California only (ALERTCalifornia, Caltrans). Not available in this state."
    assert d["cameras"]["features"] == [] and router.calls == []


def test_cameras_still_listed_at_the_california_border(router: Router, client: TestClient) -> None:
    router.add("CalOES_California_Webcams/FeatureServer/0/query", geojson([]))
    router.add("CalOES_California_Webcams/FeatureServer/0?", httpx.Response(200, json={"editingInfo": {"dataLastEditDate": 1}}))
    d = client.get("/api/extras/cameras", params={"bbox": BROOKINGS}).json()
    assert d["status"] == "available" and router.count("CalOES_California_Webcams") == 2
