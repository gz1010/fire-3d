"""National NWS alerts (CONTRACT 14.6) and the local officials' messages endpoint (14.7), offline.

Samples (tests/data/official, recorded 2026-10-23 by scripts/record_test_samples_official.py --only national):
* ``nws_alerts_national.json``: the real national ``/alerts/active`` answer for the 48 states + DC with the fire
  weather and local officials' events (three Red Flag Warnings, in Wyoming and Montana);
* ``nws_nwem_cem_la.json``: a real Los Angeles County Civil Emergency Message relayed by NWS (2026-10-16; its
  operator address replaced by a placeholder);
* ``openfema_window_frw.json``: a real OpenFEMA window (see test_openfema_parse.py).
The state, county and time zone lookups use a small stand-in for ``fire3d.regions`` (boxes), so these tests do not
depend on the regions data files.
"""

from __future__ import annotations

import copy
import json
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import orjson
import pytest
from fastapi import FastAPI

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

import fire3d.http as fhttp
from fire3d import catalog
from fire3d.api import official
from fire3d.contracts import FireWeatherResponse, IncidentSummary, LocalAlertsResponse, contract_problems
from fire3d.sources import calfire_history, nws, openfema
from fire3d.timeutil import DAY_MS, HOUR_MS, iso_to_ms

DATA = Path(__file__).parent / "data" / "official"
NATIONAL = json.loads((DATA / "nws_alerts_national.json").read_text())
NWEM = json.loads((DATA / "nws_nwem_cem_la.json").read_text())
FEMA = json.loads((DATA / "openfema_window_frw.json").read_text())

CEM_SENT = iso_to_ms("2026-10-16T01:23:59Z")            # stamped "02:23:59+01:00" by the sender
CEM_NOW = CEM_SENT + 20 * 60_000
LA_POINT = (-118.25, 34.30)
LA_AOI = [-118.40, 34.20, -118.10, 34.40]
FL_POINT = (-84.30, 30.45)                              # Tallahassee area
MT_ALERT_UGCS = {u for f in NATIONAL["features"] for u in f["properties"]["geocode"]["UGC"]}


# ----------------------------------------------------------------------------------------------------------------
# A stand-in for fire3d.regions (boxes)
# ----------------------------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class County:
    fips: str
    name: str
    state: str


STATE_BOXES = {"CA": (-124.5, 32.5, -114.1, 42.0), "MT": (-116.1, 44.3, -104.0, 49.0), "WY": (-111.1, 41.0, -104.05, 45.0),
               "FL": (-87.7, 24.5, -80.0, 31.0), "NC": (-84.4, 33.8, -75.4, 36.6), "NM": (-109.1, 31.3, -103.0, 37.0)}
ZONES = {"CA": "America/Los_Angeles", "MT": "America/Denver", "WY": "America/Denver", "FL": "America/New_York",
         "NC": "America/New_York", "NM": "America/Denver"}
COUNTY_BOXES = {County("06037", "Los Angeles County", "CA"): (-118.95, 33.70, -117.65, 34.85),
                County("06029", "Kern County", "CA"): (-120.20, 34.80, -117.60, 35.80),
                County("56033", "Sheridan County", "WY"): (-107.90, 44.50, -106.00, 45.00),
                County("12073", "Leon County", "FL"): (-84.70, 30.25, -84.00, 30.70)}


def _meets(a, b) -> bool:
    return a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]


class FakeRegions:
    L48 = nws.L48_CODES

    @staticmethod
    def states_in_bbox(bbox, margin_km: float = 0.0):
        return sorted(st for st, b in STATE_BOXES.items() if _meets(b, bbox))

    @staticmethod
    def counties_in_bbox(bbox, margin_km: float = 0.0):
        return [c for c, b in COUNTY_BOXES.items() if _meets(b, bbox)]

    @staticmethod
    def county_at(lon, lat):
        return next((c for c, b in COUNTY_BOXES.items() if _meets(b, (lon, lat, lon, lat))), None)

    @staticmethod
    def time_zone_at(lon, lat):
        st = next((s for s, b in STATE_BOXES.items() if _meets(b, (lon, lat, lon, lat))), None)
        return ZONES.get(st) if st else None

    @staticmethod
    def main_zone(state):
        return ZONES.get(state, "America/Chicago")


# ----------------------------------------------------------------------------------------------------------------
# Upstream
# ----------------------------------------------------------------------------------------------------------------
class Upstream:
    def __init__(self):
        self.active = copy.deepcopy(NATIONAL)
        self.past = {"type": "FeatureCollection", "features": [copy.deepcopy(NWEM)]}
        self.fema: dict = FEMA
        self.fema_gate: Any = None              # a threading.Event the OpenFEMA answer waits for
        self.calls: list[str] = []
        self.fail: set[str] = set()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.calls.append(url)
        if url.startswith("https://api.weather.gov/alerts/active"):
            return httpx.Response(503) if "active" in self.fail else httpx.Response(200, json=self.active)
        if url.startswith("https://api.weather.gov/alerts?"):
            return httpx.Response(503) if "past" in self.fail else httpx.Response(200, json=self.past)
        if url.startswith("https://api.weather.gov/zones/"):
            return httpx.Response(404, json={"title": "Not Found"})
        if url.startswith(openfema.API_URL):
            if self.fema_gate is not None:
                self.fema_gate.wait(10)
            return httpx.Response(503) if "fema" in self.fail else httpx.Response(200, json=self.fema)
        raise RuntimeError(f"unrouted request in test: {url}")

    def count(self, part: str) -> int:
        return sum(1 for u in self.calls if part in u)


@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path) -> Upstream:
    nws.reset_state()
    calfire_history.reset_state()
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)
    monkeypatch.setattr(nws, "NWS_LIMITER", fhttp.RateLimiter(1000, 60.0, "test"))
    monkeypatch.setattr(nws, "_regions", lambda: FakeRegions)
    monkeypatch.delenv("FIRE3D_NWS_CONTACT", raising=False)
    up = Upstream()
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(up))
    monkeypatch.setattr(catalog, "get_summary", lambda iid: None)
    monkeypatch.setattr(openfema, "OPENFEMA_LIMITER", fhttp.RateLimiter(1000, 60.0, "test"))
    openfema.reset_state()
    yield up
    if up.fema_gate is not None:
        up.fema_gate.set()
    nws.reset_state()
    openfema.reset_state()


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(official.router)
    return TestClient(app)


def write_manifest(data_dir: Path, iid: str, mode: str, point, aoi, started: str, **summary: Any) -> None:
    d = data_dir / "incidents" / iid
    d.mkdir(parents=True, exist_ok=True)
    t0 = iso_to_ms(started)
    (d / "manifest.json").write_bytes(orjson.dumps({
        "id": iid, "mode": mode, "status": "ready", "grid": {"bbox_lonlat": aoi},
        "time_range": {"start_ms": t0, "end_ms": t0 + 2 * DAY_MS, "now_ms": t0 + 2 * DAY_MS},
        "summary": {"id": iid, "mode": mode, "lon": point[0], "lat": point[1], "started_ms": t0,
                    "calfire_uid": "", "contained_ms": None, **summary}}))


def keys_anywhere(obj: Any) -> set[str]:
    out: set[str] = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.add(k)
            out |= keys_anywhere(v)
    elif isinstance(obj, list):
        for v in obj:
            out |= keys_anywhere(v)
    return out


def summary(iid: str, lon: float, lat: float, **kw) -> IncidentSummary:
    base = dict(id=iid, name="Test Fire", mode="historical", year=2025, calfire_uid="", started_ms=iso_to_ms("2025-03-20"),
                updated_ms=None, contained_ms=None, acres=4000.0, percent_contained=None, is_active=False, county=None,
                location=None, admin_unit=None, url=None, lat=lat, lon=lon, detections_24h=None, bundle_status="none",
                bundle_built_ms=None)
    base.update(kw)
    return IncidentSummary.model_validate(base)


# ----------------------------------------------------------------------------------------------------------------
# Parsing
# ----------------------------------------------------------------------------------------------------------------
def test_relayed_cem_parses_verbatim_without_the_operator_address() -> None:
    a = nws.normalize_local_nws(NWEM)
    assert a is not None and a["id"] == "v2-3.13.8-1556392-1792113838542" and a["channel"] == "nws_api"
    assert a["event"] == "Civil Emergency Message" and a["event_code"] == "CEM" and a["archived"] is False
    assert a["sender_name"] == "Public Alert System" and a["sender_is_platform"] is True
    assert a["sent_ms"] == CEM_SENT and a["expires_ms"] == CEM_SENT + HOUR_MS     # the +01:00 stamp is converted
    assert a["source_url"] == "https://api.weather.gov/alerts/v2-3.13.8-1556392-1792113838542"
    assert a["same_codes"] == ["006037"] and a["polygon"] is None and a["web"] is None
    assert a["description"] == NWEM["properties"]["description"].strip()
    assert "sender" not in a


def test_scope_rule_cem_lae_need_fire_words_frw_evi_always() -> None:
    off = copy.deepcopy(NWEM)
    off["properties"]["description"] = "Water main break on 5th Street. Get sandbags at Fire Station 7."
    off["properties"]["headline"] = "Alert from AlertLACounty"
    assert nws.normalize_local_nws(off) is None
    frw = copy.deepcopy(off)
    frw["properties"]["event"] = "Fire Warning"
    frw["properties"]["eventCode"] = {"SAME": ["FRW"]}
    assert nws.normalize_local_nws(frw)["event_code"] == "FRW"        # FRW always, its text shown as sent
    test = copy.deepcopy(frw)
    test["properties"]["status"] = "Test"
    assert nws.normalize_local_nws(test) is None
    rfw = NATIONAL["features"][0]
    assert nws.normalize_local_nws(rfw) is None and nws.normalize_alert(rfw) is not None
    assert nws.is_platform_sender("Public Alert System") and not nws.is_platform_sender("Kern County OES")


def test_national_request_names_49_codes_and_splits_the_answer(upstream: Upstream) -> None:
    upstream.active["features"].append(copy.deepcopy(NWEM))
    ans = nws.national_active()
    assert len(upstream.calls) == 1
    url = upstream.calls[0]
    area = url.split("area=")[1].split("&")[0].split(",")
    assert len(area) == 49 and set(area) == set(nws.L48_CODES) and "DC" in area and "AK" not in area and "HI" not in area
    for ev in ("Red%20Flag%20Warning", "Fire%20Weather%20Watch", "Fire%20Warning", "Evacuation%20Immediate",
               "Civil%20Emergency%20Message", "Local%20Area%20Emergency"):
        assert ev in url
    assert len(ans.fire) == 3 and [a["event"] for a in ans.fire] == ["Red Flag Warning"] * 3
    assert [a["id"] for a in ans.local] == [NWEM["properties"]["id"]]
    assert len(ans.states) == 49
    nws.national_active()
    assert len(upstream.calls) == 1                                    # one shared answer per 2-min cycle


def test_state_filter_runs_before_any_zone_is_loaded(upstream: Upstream) -> None:
    ans = nws.national_active()
    loaded: list[str] = []
    fl_states = nws.states_in_area((FL_POINT[0] - 0.3, FL_POINT[1] - 0.3, FL_POINT[0] + 0.3, FL_POINT[1] + 0.3))
    assert fl_states == ["FL"]
    mine = nws.in_states(ans.fire, fl_states)
    assert mine == []                                                  # the Montana / Wyoming alerts never reach it
    nws.place_live(mine, (-84.6, 30.2, -84.0, 30.7), FL_POINT, now=iso_to_ms("2026-10-23T00:40:00Z"),
                   zone_loader=lambda u, t: loaded.append(u))
    assert loaded == [] and upstream.count("/zones/") == 0
    assert set(nws.alert_states(ans.fire)) == {"MT", "WY"}
    mt = nws.in_states(ans.fire, ["MT"])
    assert mt and all(any(u.startswith("MT") for u in a["ugcs"]) for a in mt)


def test_place_local_by_polygon_and_by_county() -> None:
    parsed = {a["id"]: a for a in openfema.parse_records(FEMA["IpawsArchivedAlerts"])}
    kern = next(a for a in parsed.values() if a["event_code"] == "FRW" and a["_geom"] is not None)
    sheridan = next(a for a in parsed.values() if a["same_codes"] == ["056033"])
    inside = kern["_geom"].representative_point()
    area = (inside.x - 0.05, inside.y - 0.05, inside.x + 0.05, inside.y + 0.05)
    at = kern["sent_ms"] + 10 * 60_000
    out = nws.place_local([kern, sheridan], area, (inside.x, inside.y), ["06029"], at)
    assert [a["id"] for a in out] == [kern["id"]]
    a = out[0]
    assert a["match"] == "polygon" and a["covers_reported_location"] is True and a["nearest_km"] == 0.0
    assert a["phase"] == "in_effect" and "_geom" not in a and a["polygon"]["type"] in ("Polygon", "MultiPolygon")
    sh_area = (-107.2, 44.6, -106.8, 44.9)
    out = nws.place_local([kern, sheridan], sh_area, None, ["56033"], sheridan["sent_ms"])
    assert [x["match"] for x in out] == ["county"] and out[0]["covers_reported_location"] is None
    assert nws.place_local([sheridan], sh_area, None, ["56001"], sheridan["sent_ms"]) == []     # another county
    # phase follows the requested time, not the wall clock
    assert nws.local_phase(sheridan, sheridan["sent_ms"] - HOUR_MS) == "upcoming"
    assert nws.local_phase({**sheridan, "expires_ms": sheridan["sent_ms"] + HOUR_MS}, sheridan["sent_ms"] + 2 * HOUR_MS) == "ended"
    assert nws.local_phase({**sheridan, "message_type": "Cancel"}, sheridan["sent_ms"]) == "ended"


def test_merge_keeps_one_alert_per_cap_id_and_the_nws_copy() -> None:
    a = nws.normalize_local_nws(NWEM)
    arch = {**a, "channel": "openfema_archive", "archived": True, "source_url": openfema.record_url(a["id"])}
    other = {**arch, "id": "other-id"}
    nolink = {**arch, "id": "no-link", "source_url": "http://insecure.example/x"}
    for x in (a, arch, other, nolink):
        x.update(match="county", covers_reported_location=None, nearest_km=None, time_zone=None, phase="in_effect")
    merged, dropped = official.merge_local([a], [arch, other, nolink])
    assert sorted(m["id"] for m in merged) == sorted([a["id"], "other-id"]) and dropped == 1
    assert next(m for m in merged if m["id"] == a["id"])["channel"] == "nws_api"


# ----------------------------------------------------------------------------------------------------------------
# Endpoint: fire weather (14.6)
# ----------------------------------------------------------------------------------------------------------------
def test_overview_checks_the_lower_48(upstream: Upstream, client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(official, "now_ms", lambda: iso_to_ms("2026-10-23T00:41:00Z"))
    r = client.get("/api/official/fire-weather")
    assert r.status_code == 200 and contract_problems(FireWeatherResponse, r.content) == []
    d = r.json()
    assert len(d["states_checked"]) == 49 and set(d["alert_states"]) == {"MT", "WY"}
    assert len(d["alerts"]) == 3 and all(a["time_zone"] == "America/Denver" for a in d["alerts"])
    assert any(c.startswith("Checked: every National Weather Service") and "lower 48 states" in c for c in d["caveats"])
    assert any("could not be placed" in c for c in d["caveats"])       # outlines 404 here: listed, never dropped
    upstream.active = {"type": "FeatureCollection", "features": [], "updated": "2026-10-23T00:40:12+00:00"}
    nws.reset_state()
    fhttp.evict_cache("GET", nws.national_url())
    quiet = client.get("/api/official/fire-weather").json()
    assert any("in the lower 48 states right now. That is not an all-clear" in c for c in quiet["caveats"])
    assert not any("California" in c for c in quiet["caveats"])


def test_florida_fire_never_gets_the_montana_alerts(upstream: Upstream, client: TestClient, tmp_data_dir: Path,
                                                    monkeypatch) -> None:
    monkeypatch.setattr(official, "now_ms", lambda: iso_to_ms("2026-10-23T00:41:00Z"))
    write_manifest(tmp_data_dir, "2026-leon-fire-abc123", "live", FL_POINT, [-84.45, 30.35, -84.15, 30.55],
                   "2026-10-22T18:00:00Z", record_source="wfigs", state="FL")
    d = client.get("/api/official/fire-weather", params={"incident": "2026-leon-fire-abc123"}).json()
    assert d["states_checked"] == ["FL"] and d["alerts"] == [] and d["alert_states"] == []
    assert upstream.count("/zones/") == 0


def test_listed_wfigs_fire_without_a_bundle(upstream: Upstream, client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(official, "now_ms", lambda: iso_to_ms("2026-10-23T00:41:00Z"))
    s = summary("2026-sheridan-fire-4849b2", -107.0, 44.75, mode="live", is_active=True, year=2026,
                started_ms=iso_to_ms("2026-10-22T10:00:00Z"), record_source="wfigs", state="WY")
    monkeypatch.setattr(catalog, "get_summary", lambda iid: s if iid == s.id else None)
    r = client.get("/api/official/fire-weather", params={"incident": s.id})
    assert r.status_code == 200 and contract_problems(FireWeatherResponse, r.content) == []
    d = r.json()
    assert d["reported_location"] == [-107.0, 44.75] and "WY" in d["states_checked"]
    assert client.get("/api/official/fire-weather", params={"incident": "2026-nobody-fire-000000"}).status_code == 404
    cf = client.get("/api/official/calfire", params={"incident": s.id}).json()
    assert cf["status"] == "unavailable" and cf["reason_code"] == "not_covered"
    assert cf["reason"] == "CAL FIRE does not list this fire; its official record is published by NIFC WFIGS."


def test_calfire_endpoint_for_a_wfigs_bundle(upstream: Upstream, client: TestClient, tmp_data_dir: Path) -> None:
    write_manifest(tmp_data_dir, "2025-black-cove-95c3c8", "historical", (-82.298, 35.286),
                   [-82.40, 35.20, -82.20, 35.37], "2025-03-22T18:00:00Z", record_source="wfigs", state="NC")
    cf = client.get("/api/official/calfire", params={"incident": "2025-black-cove-95c3c8"}).json()
    assert cf["reason_code"] == "not_covered" and "NIFC WFIGS" in cf["reason"] and upstream.calls == []


# ----------------------------------------------------------------------------------------------------------------
# Endpoint: local alerts (14.7)
# ----------------------------------------------------------------------------------------------------------------
def test_local_alerts_live_near_a_fire(upstream: Upstream, client: TestClient, tmp_data_dir: Path, monkeypatch) -> None:
    monkeypatch.setattr(official, "now_ms", lambda: CEM_NOW)
    upstream.active["features"].append(copy.deepcopy(NWEM))
    write_manifest(tmp_data_dir, "2026-test-fire-abcdef", "live", LA_POINT, LA_AOI, "2026-10-15T20:00:00Z",
                   calfire_uid="abcdef00-0000-4000-8000-000000000000", state="CA")
    r = client.get("/api/official/local-alerts", params={"incident": "2026-test-fire-abcdef"})
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    assert contract_problems(LocalAlertsResponse, r.content) == []
    d = r.json()
    assert d["kind"] == "local_alerts" and d["status"] == "available"
    assert [c["id"] for c in d["channels"]] == ["nws_api", "openfema_archive"]
    assert d["channels"][0]["status"] == "available" and d["channels"][1]["status"] == "not_checked"
    assert d["source"]["credit"] == "National Weather Service (relayed local officials' messages)"
    assert [a["id"] for a in d["alerts"]] == [NWEM["properties"]["id"]]
    a = d["alerts"][0]
    assert a["match"] == "county" and a["covers_reported_location"] is None and a["phase"] == "in_effect"
    assert a["time_zone"] == "America/Los_Angeles" and a["source_url"].startswith("https://")
    assert {"fips": "06037", "name": "Los Angeles County", "state": "CA"} in d["counties"]
    assert "sender" not in keys_anywhere(d)
    assert d["caveats"][0].startswith("Fire-3d lists only the local alerts the National Weather Service relays")
    assert "not an all-clear" in d["caveats"][0]
    assert upstream.count("/alerts/active") == 1 and upstream.count("/alerts?") == 0


def test_local_alerts_12h_ago_use_the_past_request(upstream: Upstream, client: TestClient, tmp_data_dir: Path,
                                                   monkeypatch) -> None:
    monkeypatch.setattr(official, "now_ms", lambda: CEM_SENT + 12 * HOUR_MS)
    write_manifest(tmp_data_dir, "2026-test-fire-abcdef", "live", LA_POINT, LA_AOI, "2026-10-15T20:00:00Z", state="CA")
    d = client.get("/api/official/local-alerts", params={"incident": "2026-test-fire-abcdef", "at_ms": CEM_SENT + 5 * 60_000}).json()
    assert upstream.count("/alerts/active") == 0 and upstream.count("/alerts?") == 1
    past = next(u for u in upstream.calls if "/alerts?" in u)
    assert "start=2026-10-15T01:00:00Z" in past and "end=2026-10-16T02:00:00Z" in past and "area=CA" in past
    assert "Fire%20Warning" in past and "Red%20Flag" not in past
    assert [a["id"] for a in d["alerts"]] == [NWEM["properties"]["id"]] and d["alerts"][0]["phase"] == "in_effect"
    assert d["channels"][1]["status"] == "not_checked"                  # FEMA: under 24 h
    client.get("/api/official/local-alerts", params={"incident": "2026-test-fire-abcdef", "at_ms": CEM_SENT + 5 * 60_000})
    assert upstream.count("/alerts?") == 1                               # cached 10 min per incident window


def test_local_alerts_older_than_7_days(upstream: Upstream, client: TestClient, tmp_data_dir: Path, monkeypatch) -> None:
    monkeypatch.setattr(official, "now_ms", lambda: iso_to_ms("2026-10-23T00:41:00Z"))
    write_manifest(tmp_data_dir, "2025-black-cove-95c3c8", "historical", (-82.298, 35.286),
                   [-82.40, 35.20, -82.20, 35.37], "2025-03-22T18:00:00Z", record_source="wfigs", state="NC")
    r = client.get("/api/official/local-alerts", params={"incident": "2025-black-cove-95c3c8",
                                                         "at_ms": iso_to_ms("2025-03-23T18:00:00Z")})
    assert r.status_code == 200 and contract_problems(LocalAlertsResponse, r.content) == []
    d = r.json()
    nws_ch, fema_ch = d["channels"]
    assert nws_ch["status"] == "not_checked" and nws_ch["reason"] == "NWS keeps about 7 days of alerts."
    assert fema_ch["id"] == "openfema_archive" and fema_ch["status"] in ("not_checked", "pending", "available")
    assert d["alerts"] == [] or all(a["archived"] for a in d["alerts"])
    assert upstream.count("api.weather.gov") == 0


def test_local_alerts_bbox_form_and_bad_requests(upstream: Upstream, client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(official, "now_ms", lambda: CEM_NOW)
    upstream.active["features"].append(copy.deepcopy(NWEM))
    d = client.get("/api/official/local-alerts", params={"bbox": "-118.4,34.2,-118.1,34.4"}).json()
    assert d["incident_id"] is None and d["reported_location"] is None and [a["id"] for a in d["alerts"]] == [NWEM["properties"]["id"]]
    assert d["channels"][1]["status"] == "not_checked" and d["channels"][1]["reason"] == "The FEMA archive is checked for a chosen fire only."
    assert client.get("/api/official/local-alerts").status_code == 400
    assert client.get("/api/official/local-alerts", params={"bbox": "-118.4,34.2,-118.1,34.4", "incident": "x"}).status_code == 400
    assert client.get("/api/official/local-alerts", params={"bbox": "1,2,3"}).status_code == 400
    assert client.get("/api/official/local-alerts", params={"bbox": "-110,30,-90,45"}).status_code == 400
    assert client.get("/api/official/local-alerts", params={"incident": "2026-nobody-fire-000000"}).status_code == 404
    assert client.get("/api/official/local-alerts", params={"incident": "bad id"}).status_code == 400


def test_local_alerts_upstream_down_is_never_none(upstream: Upstream, client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(official, "now_ms", lambda: CEM_NOW)
    upstream.fail = {"active"}
    d = client.get("/api/official/local-alerts", params={"bbox": "-118.4,34.2,-118.1,34.4"}).json()
    assert d["status"] == "unavailable" and d["reason_code"] == "upstream_error" and d["alerts"] == []
    assert d["channels"][0]["status"] == "unavailable" and "does not mean there were none" in d["channels"][0]["reason"]


def test_local_alert_without_link_is_dropped_and_counted(upstream: Upstream, client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(official, "now_ms", lambda: CEM_NOW)
    bad = copy.deepcopy(NWEM)
    bad["properties"]["@id"] = None
    bad["id"] = "urn:not-a-link"
    bad["properties"]["id"] = "no-link-id"
    upstream.active["features"] += [copy.deepcopy(NWEM), bad]
    d = client.get("/api/official/local-alerts", params={"bbox": "-118.4,34.2,-118.1,34.4"}).json()
    assert [a["id"] for a in d["alerts"]] == [NWEM["properties"]["id"]]
    assert any(c == "1 alert(s) without a source link were not shown." for c in d["caveats"])


def fema_record(identifier: str, code: str, event: str, sent_iso: str, same: str, text: str) -> dict:
    """An OpenFEMA record in the recorded shape (no polygon: matched by county)."""
    return {"identifier": identifier, "sent": sent_iso, "msgType": "Alert", "status": "Actual", "originalMessage": "",
            "info": [{"language": "en-US", "event": event, "eventCode": [{"name": "SAME", "value": code}],
                      "senderName": "Public Alert System", "headline": "Alert from AlertLACounty", "description": text,
                      "expires": None, "parameter": [{"name": "CMAMtext", "value": text}],
                      "area": [{"areaDesc": "Los Angeles", "geocode": [{"name": "SAME", "value": same}]}]}]}


def test_local_alerts_30h_ago_from_both_channels_one_per_cap_id(upstream: Upstream, client: TestClient,
                                                               tmp_data_dir: Path, monkeypatch) -> None:
    at = CEM_SENT + 10 * 60_000
    monkeypatch.setattr(official, "now_ms", lambda: at + 30 * HOUR_MS)
    write_manifest(tmp_data_dir, "2026-test-fire-abcdef", "live", LA_POINT, LA_AOI, "2026-10-15T20:00:00Z", state="CA")
    same_id = NWEM["properties"]["id"]
    upstream.fema = {"metadata": {"count": 2}, "IpawsArchivedAlerts": [
        fema_record(same_id, "CEM", "Civil Emergency Message", "2026-10-16T01:23:59.000Z", "006037",
                    "Due to the Bryson Fire, wildfires burning in the area can spread."),
        fema_record("ARCH-ONLY-1", "FRW", "Fire Warning", "2026-10-15T23:30:00.000Z", "006037",
                    "Brush fire near the 5 freeway. Evacuate now."),
    ]}
    r = client.get("/api/official/local-alerts", params={"incident": "2026-test-fire-abcdef", "at_ms": at})
    assert r.status_code == 200 and contract_problems(LocalAlertsResponse, r.content) == []
    d = r.json()
    assert [c["status"] for c in d["channels"]] == ["available", "available"]
    by_id = {a["id"]: a for a in d["alerts"]}
    assert set(by_id) == {same_id, "ARCH-ONLY-1"} and len(d["alerts"]) == 2          # one alert per CAP id
    assert by_id[same_id]["channel"] == "nws_api" and by_id[same_id]["archived"] is False
    arch = by_id["ARCH-ONLY-1"]
    assert arch["channel"] == "openfema_archive" and arch["archived"] is True and arch["match"] == "county"
    assert arch["source_url"] == openfema.record_url("ARCH-ONLY-1") and arch["source_url"].startswith("https://")
    assert all(a["source_url"].startswith("https://") for a in d["alerts"])
    assert "sender" not in keys_anywhere(d)
    assert any(c.startswith("Archived copy from FEMA (OpenFEMA, published about a day later)") for c in d["caveats"])
    assert any(openfema.NOTICE in c for c in d["caveats"])
    assert upstream.count("/alerts/active") == 0 and upstream.count("/alerts?") == 1
    assert upstream.count("IpawsArchivedAlerts") == 2                      # the messages, then the updates' XML


def test_archive_path_answers_pending_within_5_s(upstream: Upstream, client: TestClient, tmp_data_dir: Path,
                                                 monkeypatch) -> None:
    import threading
    import time

    monkeypatch.setattr(official, "now_ms", lambda: iso_to_ms("2026-10-23T00:41:00Z"))
    write_manifest(tmp_data_dir, "2025-black-cove-95c3c8", "historical", (-82.298, 35.286),
                   [-82.40, 35.20, -82.20, 35.37], "2025-03-22T18:00:00Z", record_source="wfigs", state="NC")
    upstream.fema_gate = threading.Event()
    params = {"incident": "2025-black-cove-95c3c8", "at_ms": iso_to_ms("2025-03-23T18:00:00Z")}
    t0 = time.monotonic()
    d = client.get("/api/official/local-alerts", params=params).json()
    assert time.monotonic() - t0 < 5.0 and openfema.REQUEST_WAIT_S < 5.0
    assert d["channels"][1]["status"] == "pending" and d["alerts"] == []
    assert d["status"] == "available" and d["channels"][0]["status"] == "not_checked"      # read the channels
    assert d["channels"][1]["reason"] == "FEMA's archive is being fetched; ask again in a minute."
    upstream.fema_gate.set()
    for _ in range(100):
        if not openfema._running:
            break
        time.sleep(0.05)
    again = client.get("/api/official/local-alerts", params=params).json()
    assert again["channels"][1]["status"] == "available" and upstream.count("IpawsArchivedAlerts") == 2
