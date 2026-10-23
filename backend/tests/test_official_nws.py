"""sources/nws.py and GET /api/official/fire-weather (offline).

Samples in tests/data/official were recorded on 2026-10-18 and trimmed (scratchpad make_fixtures.py):
* NWS: two real NWS Los Angeles/Oxnard Red Flag Warning messages (FW.W #5, CON, Oct 17 2026 09:11 PDT; the
  collection's "updated" is set to 16:20 UTC as if fetched while they were active), the real empty California answer
  of Oct 18, and five real fire weather zones (CAZ243 Henderson, CAZ288, CAZ362, CAZ369, CAZ370; simplified).
* IEM: the real bypoint answer at the Eaton Fire (Jan 5-12 2025), LOX FW.W #1 / FW.A #1 / FW.W #2 / FW.A #2 of 2025
  (per-zone rows, a few of their products), and FW.W #1's zone polygons (simplified; also served for FW.A #1 here).
Upstream calls go through fire3d.http with an httpx.MockTransport (the conftest guard refuses real network access).
"""

from __future__ import annotations

import copy
import json
import warnings
from pathlib import Path

import httpx
import orjson
import pytest
from fastapi import FastAPI
from shapely.geometry import shape

with warnings.catch_warnings():     # the installed Starlette deprecates httpx in its TestClient (not our code)
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

import fire3d.http as fhttp
from fire3d import catalog
from fire3d.api import official
from fire3d.contracts import FireWeatherResponse, contract_problems
from fire3d.sources import calfire_history, nws
from fire3d.timeutil import DAY_MS, HOUR_MS, iso_to_ms

DATA = Path(__file__).parent / "data" / "official"


def load(name: str):
    return json.loads((DATA / name).read_text())


LOX = load("nws_alerts_lox_rfw.json")
EMPTY = load("nws_alerts_ca_empty.json")
ZONES = load("nws_zones_fire.json")
BYPOINT = load("iem_bypoint_eaton.json")
IEM_EVENTS = {("W", "1"): load("iem_event_lox_fw_w_1.json"), ("A", "1"): load("iem_event_lox_fw_a_1.json"),
              ("W", "2"): load("iem_event_lox_fw_w_2.json"), ("A", "2"): load("iem_event_lox_fw_a_2.json")}
IEM_GEO = load("iem_geojson_lox_fw_w_1.json")

LOX_NOW = iso_to_ms("2026-10-17T16:20:00Z")          # both LOX messages in effect (09:11 -> 20:00 PDT)
NOW = iso_to_ms("2026-10-18T16:00:00Z")
EATON_AT = iso_to_ms("2025-01-08T20:00:00Z")         # Jan 8 2025, noon PST
PALISADES = (-118.54453, 34.07022)                   # in CAZ370 (Eastern Santa Monica Mountains)
HENDERSON = (-117.41451, 33.3445584)                 # in CAZ243 (San Diego County Coastal Areas)
EATON = (-118.069155, 34.203483)                     # IEM: zone CAZ380 (Eastern San Gabriel Mountains)
EATON_AOI = [-118.2145, 34.0952, -117.9623, 34.3048]
PALISADES_AOI = [-118.7566, 33.9459, -118.4265, 34.2206]
HENDERSON_AOI = [-117.5666, 33.2254, -117.3292, 33.4247]


def trimmed_lox() -> dict:
    """The LOX messages with their zone lists cut to the zones recorded here (so every zone has a polygon)."""
    d = copy.deepcopy(LOX)
    for f in d["features"]:
        p = f["properties"]
        p["geocode"]["UGC"] = [u for u in p["geocode"]["UGC"] if u in ZONES]
        p["affectedZones"] = [z for z in p["affectedZones"] if z.rsplit("/", 1)[-1] in ZONES]
    return d


class Upstream:
    """MockTransport handler for api.weather.gov and IEM; counts requests and records headers."""

    def __init__(self, alerts: dict | None = None):
        self.alerts = alerts if alerts is not None else EMPTY
        self.calls: list[str] = []
        self.headers: list[httpx.Headers] = []
        self.fail: set[str] = set()          # "alerts" | "zones" | "bypoint" | "bypoint-corners" | "event"

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.calls.append(url)
        self.headers.append(request.headers)
        q = dict(request.url.params)
        if url.startswith("https://api.weather.gov/alerts/active"):
            return httpx.Response(503) if "alerts" in self.fail else httpx.Response(200, json=self.alerts)
        if url.startswith("https://api.weather.gov/zones/"):
            ugc = url.rsplit("/", 1)[-1]
            if "zones" in self.fail:
                return httpx.Response(500)
            return httpx.Response(200, json=ZONES[ugc]) if ugc in ZONES else httpx.Response(404, json={"title": "Not Found"})
        if "vtec_events_bypoint.py" in url:
            corner = abs(float(q["lat"]) - EATON[1]) > 1e-3
            if "bypoint" in self.fail and not corner or "bypoint-corners" in self.fail and corner:
                return httpx.Response(503)
            return httpx.Response(200, json=BYPOINT)
        if "/geojson/vtec_event.py" in url:
            return httpx.Response(200, json=IEM_GEO)
        if "/json/vtec_event.py" in url:
            if "event" in self.fail:
                return httpx.Response(503)
            d = IEM_EVENTS.get((q["significance"], q["etn"]))
            return httpx.Response(200, json=d) if d else httpx.Response(200, json={"event_exists": False})
        raise RuntimeError(f"unrouted request in test: {url}")

    def count(self, part: str) -> int:
        return sum(1 for u in self.calls if part in u)


@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path) -> Upstream:
    nws.reset_state()
    calfire_history.reset_state()
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)
    monkeypatch.setattr(nws, "NWS_LIMITER", fhttp.RateLimiter(1000, 60.0, "test"))
    monkeypatch.setattr(nws, "IEM_LIMITER", fhttp.RateLimiter(1000, 60.0, "test"))
    monkeypatch.delenv("FIRE3D_NWS_CONTACT", raising=False)
    up = Upstream()
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(up))
    monkeypatch.setattr(catalog, "get_summary", lambda iid: None)
    yield up
    nws.reset_state()


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(official.router)
    return TestClient(app)


def write_manifest(data_dir: Path, iid: str, mode: str, point: tuple[float, float], aoi: list[float], started: str,
                   end: str | None = None, uid: str = "00000000-0000-4000-8000-000000000000") -> None:
    d = data_dir / "incidents" / iid
    d.mkdir(parents=True, exist_ok=True)
    t0 = iso_to_ms(started)
    t1 = iso_to_ms(end) if end else t0 + 2 * DAY_MS
    (d / "manifest.json").write_bytes(orjson.dumps({
        "id": iid, "mode": mode, "status": "ready", "grid": {"bbox_lonlat": aoi},
        "time_range": {"start_ms": t0, "end_ms": t1, "now_ms": t1},
        "summary": {"id": iid, "mode": mode, "lon": point[0], "lat": point[1], "started_ms": t0, "calfire_uid": uid,
                    "contained_ms": t1 if mode == "historical" else None}}))


# ----------------------------------------------------------------------------------------------------------------
# Parsing
# ----------------------------------------------------------------------------------------------------------------
def test_user_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FIRE3D_NWS_CONTACT", raising=False)
    assert nws.user_agent() == "Fire-3d/0.1 (research prototype)"            # no personal data by default
    monkeypatch.setenv("FIRE3D_NWS_CONTACT", "ops@example.org\r\nX-Evil: 1 (x)")
    ua = nws.user_agent()
    assert ua == "Fire-3d/0.1 (research prototype; ops@example.orgX-Evil: 1 x)" and "\n" not in ua


def test_parse_vtec_and_ugc_blocks() -> None:
    v = nws.parse_vtec("/O.CON.KLOX.FW.W.0005.000000T0000Z-261018T0300Z/ /O.NEW.KCYS.FW.A.0046.261017T1624Z-261018T0100Z/")
    assert [(x["action"], x["office"], x["phenomena"], x["significance"], x["etn"]) for x in v] == [
        ("CON", "KLOX", "FW", "W", 5), ("NEW", "KCYS", "FW", "A", 46)]
    assert v[0]["begin_ms"] is None and v[0]["end_ms"] == iso_to_ms("2026-10-18T03:00:00Z")
    assert v[1]["begin_ms"] == iso_to_ms("2026-10-17T16:24:00Z")
    assert nws.expand_ugcs("CAZ362-369-370-372>374-548-110100-") == [
        "CAZ362", "CAZ369", "CAZ370", "CAZ372", "CAZ373", "CAZ374", "CAZ548"]
    assert nws.expand_ugcs("CAZ375-\n379-380-110100-") == ["CAZ375", "CAZ379", "CAZ380"]
    assert nws.expand_ugcs("CAZALL-ORZ621-110100-") == ["ORZ621"]


def test_normalize_real_red_flag_warning() -> None:
    a = nws.normalize_alert(LOX["features"][0])
    p = LOX["features"][0]["properties"]
    assert a is not None and a["event"] == "Red Flag Warning" and a["archived"] is False
    assert a["vtec"] == {"office": "KLOX", "phenomena": "FW", "significance": "W", "etn": 5, "action": "CON"}
    assert a["sender_name"] == "NWS Los Angeles/Oxnard CA" and a["office_url"] == "https://www.weather.gov/lox"
    assert a["url"] == p["@id"] and a["url"].startswith("https://api.weather.gov/alerts/urn:oid:")
    assert a["headline"] == p["headline"]                                   # verbatim
    assert a["description"] == p["description"].strip() and a["instruction"].startswith("A Red Flag Warning means")
    assert a["nws_headline"].startswith("RED FLAG WARNING REMAINS IN EFFECT UNTIL 8 PM PDT")
    assert a["onset_ms"] == iso_to_ms("2026-10-17T09:11:00-07:00") and a["ends_ms"] == iso_to_ms("2026-10-17T20:00:00-07:00")
    assert a["ugcs"][0] == "CAZ288" and len(a["ugcs"]) == 12 and a["message_type"] == "Update"
    other = copy.deepcopy(LOX["features"][0])
    other["properties"]["event"] = "Beach Hazards Statement"               # not a fire weather alert
    assert nws.normalize_alert(other) is None
    test_msg = copy.deepcopy(LOX["features"][0])
    test_msg["properties"]["status"] = "Test"
    assert nws.normalize_alert(test_msg) is None


def test_live_phase() -> None:
    a = nws.normalize_alert(LOX["features"][0])
    assert nws.live_phase(a, LOX_NOW) == "in_effect"
    assert nws.live_phase(a, a["onset_ms"] - 1) == "upcoming"
    assert nws.live_phase(a, a["ends_ms"]) == "ended"
    assert nws.live_phase({**a, "vtec": {**a["vtec"], "action": "CAN"}}, LOX_NOW) == "ended"
    assert nws.live_phase({**a, "ends_ms": None}, LOX_NOW + 30 * DAY_MS) == "in_effect"     # until further notice


def test_product_segments_of_a_real_statement() -> None:
    det = nws.parse_event_detail(IEM_EVENTS[("W", "1")])
    prod = next(p for p in det.products if p["valid_ms"] == iso_to_ms("2025-01-07T22:37:00Z"))
    segs = det.segments(prod)
    seg = next(s for s in segs if "CAZ380" in s["ugcs"])
    assert seg["ugcs"] == ["CAZ375", "CAZ379", "CAZ380"]
    assert [(v["action"], v["significance"], v["etn"]) for v in seg["vtec"]] == [("CON", "W", 1), ("CON", "A", 1)]
    assert seg["headline"].startswith("...RED FLAG WARNING REMAINS IN EFFECT UNTIL 6 PM PST THURSDAY FOR THE "
                                      "FOLLOWING AREAS: SAN GABRIEL MOUNTAINS AND SANTA SUSANA MOUNTAINS")
    assert seg["description"].startswith("* WINDS...Very strong/damaging north to northeast winds")
    assert "\n" in seg["description"] and "PRECAUTIONARY" not in seg["description"]       # line breaks kept
    assert seg["instruction"].startswith("A Red Flag Warning means that critical fire weather conditions")
    assert "&&" not in seg["instruction"] and "$$" not in seg["instruction"]
    assert nws.product_sender(prod["text"]) == "National Weather Service Los Angeles/Oxnard CA"
    assert sum(len(s["ugcs"]) for s in segs) >= 20


def test_segment_at_follows_the_requested_time() -> None:
    det = nws.parse_event_detail(IEM_EVENTS[("W", "1")])
    ev = nws.ArchiveEvent("LOX", 2025, "FW", "W", 1, None)
    valid = lambda t: nws.segment_at(det, "CAZ380", ev, iso_to_ms(t))[0]["valid_ms"]  # noqa: E731
    assert valid("2025-01-07T12:00:00Z") == iso_to_ms("2025-01-05T22:40:00Z")   # the first product
    assert valid("2025-01-08T20:00:00Z") == iso_to_ms("2025-01-07T22:37:00Z")   # the latest statement by then
    assert valid("2025-01-11T00:00:00Z") == iso_to_ms("2025-01-10T22:48:00Z")   # the cancellation
    _, seg = nws.segment_at(det, "CAZ380", ev, iso_to_ms("2025-01-11T00:00:00Z"))
    assert any(v["action"] == "CAN" for v in seg["vtec"])


def test_zone_phase_and_the_upgraded_watch_quirk() -> None:
    rows = nws.parse_event_detail(IEM_EVENTS[("A", "1")]).zone_rows
    r = next(x for x in rows if x["ugc"] == "CAZ380")
    assert r["expire_ms"] < r["issue_ms"]                                   # cancelled before it began
    assert nws.zone_phase(r, EATON_AT) == "upcoming"
    assert nws.zone_phase(r, iso_to_ms("2025-01-09T06:00:00Z")) == "ended"
    w = next(x for x in nws.parse_event_detail(IEM_EVENTS[("W", "1")]).zone_rows if x["ugc"] == "CAZ380")
    assert nws.zone_phase(w, EATON_AT) == "in_effect"
    assert nws.zone_phase(w, iso_to_ms("2025-01-07T11:00:00Z")) == "upcoming"


def test_headlines_and_stated_times() -> None:
    para = ("...RED FLAG WARNING REMAINS IN EFFECT UNTIL 6 PM PST THURSDAY FOR THE FOLLOWING AREAS: SAN GABRIEL "
            "MOUNTAINS...RED FLAG WARNING IN EFFECT FOR ALL OTHER TIMES... ...FIRE WEATHER WATCH REMAINS IN EFFECT FROM "
            "THURSDAY EVENING...")
    assert nws.split_headlines(para) == [
        "...RED FLAG WARNING REMAINS IN EFFECT UNTIL 6 PM PST THURSDAY FOR THE FOLLOWING AREAS: SAN GABRIEL "
        "MOUNTAINS...RED FLAG WARNING IN EFFECT FOR ALL OTHER TIMES...",
        "...FIRE WEATHER WATCH REMAINS IN EFFECT FROM THURSDAY EVENING..."]
    assert nws.event_headline(para, "Fire Weather Watch").startswith("...FIRE WEATHER WATCH")
    assert nws.event_headline("...WIND ADVISORY...", "Red Flag Warning") == "...WIND ADVISORY..."
    assert nws.split_headlines(None) == [] and nws.event_headline(None, "Red Flag Warning") is None
    row = {"issue_ms": 1000, "expire_ms": 5000}
    assert nws.stated_times({"begin_ms": None, "end_ms": 4000}, row, "in_effect", 2000) == (1000, 4000)
    assert nws.stated_times({"begin_ms": 3000, "end_ms": 4500}, row, "upcoming", 2000) == (3000, 4500)
    assert nws.stated_times({"begin_ms": 1500, "end_ms": 4500}, row, "upcoming", 2000) == (1000, 4500)   # disagrees
    assert nws.stated_times({"begin_ms": None, "end_ms": 1800}, row, "in_effect", 2000) == (1000, 5000)  # extended later
    assert nws.stated_times({"begin_ms": None, "end_ms": 9000}, row, "ended", 6000) == (1000, 5000)
    assert nws.stated_times(None, row, "in_effect", 2000) == (1000, 5000)


def test_simplified_zone_outline_is_small_and_valid() -> None:
    g = shape(ZONES["CAZ243"]["geometry"])
    out = nws.simplified(g)
    assert shape(out).is_valid and len(json.dumps(out)) < len(json.dumps(ZONES["CAZ243"]["geometry"]))
    assert shape(out).covers(shape({"type": "Point", "coordinates": list(HENDERSON)}))


# ----------------------------------------------------------------------------------------------------------------
# Placing live alerts
# ----------------------------------------------------------------------------------------------------------------
def zone_stub(ugc: str, zone_type: str = "fire") -> nws.Zone | None:
    f = ZONES.get(ugc)
    return nws.Zone(ugc, f["properties"]["name"], shape(f["geometry"])) if f else None


def test_place_live_covers_and_distances() -> None:
    alerts = [nws.normalize_alert(f) for f in trimmed_lox()["features"]]
    area = (PALISADES_AOI[0] - 0.15, PALISADES_AOI[1] - 0.15, PALISADES_AOI[2] + 0.15, PALISADES_AOI[3] + 0.15)
    out, fc, cav = nws.place_live(alerts, area, PALISADES, now=LOX_NOW, zone_loader=zone_stub)
    assert cav == [] and len(out) == 2
    here, near = out                                                        # sorted: covering alert first
    assert here["ugcs"] == ["CAZ369", "CAZ370"] and here["covers_reported_location"] is True and here["nearest_km"] == 0.0
    assert near["covers_reported_location"] is False and 0 < near["nearest_km"] < 10        # Malibu Coast next door
    assert here["phase"] == near["phase"] == "in_effect"
    assert not any(k.startswith("_") for k in here)
    ids = {f["id"]: f["properties"] for f in fc["features"]}
    assert {"CAZ369", "CAZ370", "CAZ362"} <= set(ids)
    assert ids["CAZ370"] == {"ugc": "CAZ370", "name": "Eastern Santa Monica Mountains Recreational Area", "alert_ids": [here["id"]]}
    far = nws.place_live(alerts, (-117.6, 33.2, -117.3, 33.5), HENDERSON, now=LOX_NOW, zone_loader=zone_stub)
    assert far[0] == [] and far[1]["features"] == []                        # LA alerts are not near Henderson


def test_place_live_never_drops_an_alert_it_cannot_place() -> None:
    alerts = [nws.normalize_alert(f) for f in LOX["features"]]              # full zone lists: most are not recorded

    def failing(ugc: str, zone_type: str = "fire") -> nws.Zone | None:
        raise nws.SourceError("The National Weather Service zone service could not be reached (HTTP 500)", 500)

    out, fc, cav = nws.place_live(alerts, (-118.8, 33.9, -118.3, 34.3), PALISADES, now=LOX_NOW, zone_loader=failing)
    assert len(out) == 2 and all(a["covers_reported_location"] is None and a["nearest_km"] is None for a in out)
    assert fc["features"] == [] and "could not be placed" in cav[0]
    partial, _, cav2 = nws.place_live(alerts, (-118.8, 33.9, -118.3, 34.3), PALISADES, now=LOX_NOW, zone_loader=zone_stub)
    covering = next(a for a in partial if "CAZ370" in a["ugcs"])
    assert covering["covers_reported_location"] is True                       # one loaded zone covers the point
    other = next(a for a in partial if "CAZ370" not in a["ugcs"])
    assert other["covers_reported_location"] is None and other["nearest_km"] is None    # a missing zone could cover it
    assert any("did not load" in c for c in cav2)


# ----------------------------------------------------------------------------------------------------------------
# Archive
# ----------------------------------------------------------------------------------------------------------------
def eaton_samples() -> list[tuple[float, float]]:
    b = EATON_AOI
    return [EATON, (b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])]


def eaton_area() -> tuple[float, float, float, float]:
    return (EATON_AOI[0] - 0.17, EATON_AOI[1] - 0.14, EATON_AOI[2] + 0.17, EATON_AOI[3] + 0.14)


def test_archive_for_eaton_on_jan_8_2025(upstream: Upstream) -> None:
    window = official.archive_window(EATON_AT, "historical", iso_to_ms("2025-01-08T02:18:00Z"), iso_to_ms("2025-01-10T19:40:00Z"))
    res = nws.archive_for_area(eaton_area(), EATON, eaton_samples(), EATON_AT, window, now=NOW)
    ids = [a["id"] for a in res["alerts"]]
    assert ids == ["2025-KLOX-FW-W-0001", "2025-KLOX-FW-A-0001"]           # issued later: FW.W #2 and FW.A #2 left out
    rfw, watch = res["alerts"]
    assert rfw["event"] == "Red Flag Warning" and rfw["phase"] == "in_effect" and rfw["archived"] is True
    assert rfw["covers_reported_location"] is True and rfw["nearest_km"] == 0.0
    assert rfw["vtec"] == {"office": "KLOX", "phenomena": "FW", "significance": "W", "etn": 1, "action": "CON"}
    assert rfw["sent_ms"] == iso_to_ms("2025-01-07T22:37:00Z")              # the latest statement by Jan 8, noon
    # times as that statement gave them ("until 6 PM PST Thursday"), not the later extension and cancellation
    assert rfw["onset_ms"] == iso_to_ms("2025-01-07T12:00:00Z") and rfw["ends_ms"] == iso_to_ms("2025-01-10T02:00:00Z")
    assert rfw["expires_ms"] is None
    assert rfw["sender_name"] == "National Weather Service Los Angeles/Oxnard CA"
    assert rfw["headline"].startswith("...RED FLAG WARNING REMAINS IN EFFECT UNTIL 6 PM PST THURSDAY")
    assert rfw["url"] == "https://mesonet.agron.iastate.edu/vtec/?year=2025&wfo=KLOX&phenomena=FW&significance=W&eventid=0001"
    assert rfw["message_type"] is None and "CAZ380" in rfw["ugcs"] and "Eastern San Gabriel Mountains" in rfw["area_desc"]
    assert watch["event"] == "Fire Weather Watch" and watch["phase"] == "upcoming"
    assert watch["onset_ms"] == iso_to_ms("2025-01-10T02:00:00Z") and watch["ends_ms"] == iso_to_ms("2025-01-11T01:00:00Z")
    assert watch["headline"].startswith("...FIRE WEATHER WATCH REMAINS IN EFFECT FROM THURSDAY EVENING")
    assert watch["nws_headline"].startswith("...RED FLAG WARNING REMAINS") and watch["headline"] in watch["nws_headline"]
    assert rfw["headline"].startswith("...RED FLAG WARNING REMAINS") and "FIRE WEATHER WATCH" not in rfw["headline"]
    zones = {f["id"]: f["properties"] for f in res["zones"]["features"]}
    assert "CAZ380" in zones and set(zones["CAZ380"]["alert_ids"]) == {"2025-KLOX-FW-W-0001", "2025-KLOX-FW-A-0001"}
    assert res["caveats"] == [] and res["retrieved_ms"] is not None
    assert upstream.count("geojson/vtec_event.py") == 2                     # polygons only for events issued by then
    assert all("user-agent" in h and "Fire-3d/0.1" in h["user-agent"] for h in upstream.headers)


def test_archive_lists_ended_alerts_for_48_hours(upstream: Upstream) -> None:
    window = official.archive_window(EATON_AT, "historical", iso_to_ms("2025-01-08T02:18:00Z"), iso_to_ms("2025-01-10T19:40:00Z"))
    after = iso_to_ms("2025-01-11T12:00:00Z")                               # FW.W #1 cancelled Jan 10 22:48 UTC
    res = nws.archive_for_area(eaton_area(), EATON, eaton_samples(), after, window, now=NOW)
    rfw = next(a for a in res["alerts"] if a["id"] == "2025-KLOX-FW-W-0001")
    assert rfw["phase"] == "ended" and rfw["vtec"]["action"] == "CAN"
    assert rfw["ends_ms"] == iso_to_ms("2025-01-10T22:48:00Z")             # when it was cancelled (known by then)
    late = nws.archive_for_area(eaton_area(), EATON, eaton_samples(), iso_to_ms("2025-01-13T12:00:00Z"), window, now=NOW)
    assert "2025-KLOX-FW-W-0001" not in [a["id"] for a in late["alerts"]]


def clear_http_cache(data_dir: Path) -> None:
    for p in (data_dir / "cache").rglob("*"):
        if p.is_file():
            p.unlink()


def test_archive_failures(upstream: Upstream, tmp_data_dir: Path) -> None:
    window = (EATON_AT - 14 * DAY_MS, EATON_AT + 2 * DAY_MS)
    upstream.fail = {"bypoint"}
    with pytest.raises(nws.SourceError, match="Iowa Environmental Mesonet"):
        nws.archive_for_area(eaton_area(), EATON, eaton_samples(), EATON_AT, window, now=NOW)
    nws.reset_state()
    upstream.fail = {"bypoint-corners"}
    res = nws.archive_for_area(eaton_area(), EATON, eaton_samples(), EATON_AT, window, now=NOW)
    assert res["alerts"] and any("could not be searched" in c for c in res["caveats"])
    nws.reset_state()
    clear_http_cache(tmp_data_dir)
    upstream.fail = {"event"}
    res = nws.archive_for_area(eaton_area(), EATON, eaton_samples(), EATON_AT, window, now=NOW)
    rfw = next(a for a in res["alerts"] if a["id"].endswith("FW-W-0001"))
    assert rfw["phase"] == "in_effect" and rfw["description"] is None       # the archive's times only
    assert any("could not be loaded" in c for c in res["caveats"])


def test_archive_window() -> None:
    start, end = iso_to_ms("2025-01-08T02:18:00Z"), iso_to_ms("2025-01-10T19:40:00Z")
    lo, hi = official.archive_window(EATON_AT, "historical", start, end)
    assert lo == start - 14 * DAY_MS and hi == start + 3 * DAY_MS + 2 * DAY_MS   # one window for the whole replay
    long_fire = official.archive_window(EATON_AT, "historical", start, start + 20 * DAY_MS)
    assert long_fire == (lo, start + 22 * DAY_MS)
    assert official.archive_window(EATON_AT + DAY_MS, "historical", start, end) == (lo, hi)
    live = official.archive_window(iso_to_ms("2026-10-17T05:00:00Z"), "live", None, None)
    assert live == (iso_to_ms("2026-10-03T00:00:00Z"), iso_to_ms("2026-10-19T00:00:00Z"))
    assert nws.archive_ttl_s(live[1], NOW) == nws.IEM_RECENT_TTL_S and nws.archive_ttl_s(hi, NOW) == nws.IEM_PAST_TTL_S


# ----------------------------------------------------------------------------------------------------------------
# Endpoint
# ----------------------------------------------------------------------------------------------------------------
def test_endpoint_live_none_is_not_an_all_clear(upstream: Upstream, client: TestClient, tmp_data_dir: Path,
                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(official, "now_ms", lambda: NOW)
    write_manifest(tmp_data_dir, "2026-henderson-fire-3e3dfe", "live", HENDERSON, HENDERSON_AOI, "2026-10-15T21:35:52Z")
    r = client.get("/api/official/fire-weather", params={"incident": "2026-henderson-fire-3e3dfe"})
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    assert contract_problems(FireWeatherResponse, r.content) == []
    d = r.json()
    assert d["kind"] == "fire_weather" and d["status"] == "available" and d["alerts"] == []
    assert d["source"]["name"] == "National Weather Service" and d["source"]["credit"] == "National Weather Service"
    assert d["source_updated_ms"] == iso_to_ms("2026-10-18T16:09:10+00:00") and d["retrieved_ms"] is not None
    assert d["reported_location"] == list(HENDERSON) and d["area_bbox"][0] < HENDERSON_AOI[0]
    assert any("not an all-clear" in c for c in d["caveats"]) and any("not an evacuation order" in c for c in d["caveats"])
    ua = [h for h, u in zip(upstream.headers, upstream.calls) if "api.weather.gov" in u]
    assert ua and all(h["user-agent"] == "Fire-3d/0.1 (research prototype)" and h["accept"] == "application/geo+json" for h in ua)
    n = upstream.count("alerts/active")
    client.get("/api/official/fire-weather", params={"incident": "2026-henderson-fire-3e3dfe"})
    assert upstream.count("alerts/active") == n                            # one statewide answer, cached 2 min


def test_endpoint_live_alert_near_a_fire(upstream: Upstream, client: TestClient, tmp_data_dir: Path,
                                         monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(official, "now_ms", lambda: LOX_NOW)
    upstream.alerts = trimmed_lox()
    write_manifest(tmp_data_dir, "2026-test-fire-abcdef", "live", PALISADES, PALISADES_AOI, "2026-10-17T10:00:00Z")
    r = client.get("/api/official/fire-weather", params={"incident": "2026-test-fire-abcdef"})
    assert contract_problems(FireWeatherResponse, r.content) == []
    d = r.json()
    assert [a["covers_reported_location"] for a in d["alerts"]] == [True, False]
    assert d["alerts"][0]["phase"] == "in_effect" and not any("No Red Flag Warning" in c for c in d["caveats"])
    assert {f["id"] for f in d["zones"]["features"]} >= {"CAZ369", "CAZ370", "CAZ362"}
    upstream.fail = {"alerts"}
    nws.reset_state()
    fhttp.evict_cache("GET", nws.national_url())
    down = client.get("/api/official/fire-weather", params={"incident": "2026-test-fire-abcdef"}).json()
    assert down["status"] == "unavailable" and down["reason_code"] == "upstream_error" and down["alerts"] == []
    assert "could not be reached" in down["reason"]


def test_endpoint_archive_for_a_past_fire(upstream: Upstream, client: TestClient, tmp_data_dir: Path,
                                          monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(official, "now_ms", lambda: NOW)
    write_manifest(tmp_data_dir, "2025-eaton-fire-dbfa57", "historical", EATON, EATON_AOI, "2025-01-08T02:18:00Z",
                   "2025-01-10T19:40:00Z", uid="dbfa574e-1b10-4467-b5e5-7d1c06ebc8dc")
    r = client.get("/api/official/fire-weather", params={"incident": "2025-eaton-fire-dbfa57", "at_ms": EATON_AT})
    assert r.status_code == 200 and contract_problems(FireWeatherResponse, r.content) == []
    d = r.json()
    assert d["status"] == "available" and d["requested_at_ms"] == EATON_AT
    assert d["source"]["name"] == "NWS products, archived copy: Iowa Environmental Mesonet"
    assert [a["id"] for a in d["alerts"]][:1] == ["2025-KLOX-FW-W-0001"] and all(a["archived"] for a in d["alerts"])
    assert any("Iowa Environmental Mesonet" in c and "not an official NWS source" in c for c in d["caveats"])
    assert upstream.count("api.weather.gov") == 0                          # NWS has no archive: never asked
    # no replay time for a past fire: past-date status, never today's alerts
    nt = client.get("/api/official/fire-weather", params={"incident": "2025-eaton-fire-dbfa57"}).json()
    assert nt["status"] == "not_available_for_past_dates" and nt["reason_code"] == "past_date" and nt["alerts"] == []
    # the archive is down: past-date status with the reason, never an empty "available"
    nws.reset_state()
    upstream.fail = {"bypoint"}
    clear_http_cache(tmp_data_dir)
    down = client.get("/api/official/fire-weather", params={"incident": "2025-eaton-fire-dbfa57", "at_ms": EATON_AT}).json()
    assert down["status"] == "not_available_for_past_dates" and down["reason_code"] == "upstream_error"
    assert down["alerts"] == [] and "does not mean there were none" in down["reason"]


def test_endpoint_live_fire_at_a_past_time_uses_the_archive(upstream: Upstream, client: TestClient, tmp_data_dir: Path,
                                                            monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(official, "now_ms", lambda: EATON_AT + 2 * DAY_MS)
    write_manifest(tmp_data_dir, "2025-live-fire-abcdef", "live", EATON, EATON_AOI, "2025-01-08T02:18:00Z")
    d = client.get("/api/official/fire-weather", params={"incident": "2025-live-fire-abcdef", "at_ms": EATON_AT}).json()
    assert d["source"]["name"].startswith("NWS products, archived copy") and d["alerts"][0]["archived"] is True
    now = client.get("/api/official/fire-weather", params={"incident": "2025-live-fire-abcdef",
                                                          "at_ms": EATON_AT + 2 * DAY_MS - HOUR_MS}).json()
    assert now["source"]["name"] == "National Weather Service"              # within 6 h of now: the live list


def test_endpoint_statewide_and_errors(upstream: Upstream, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(official, "now_ms", lambda: LOX_NOW)
    upstream.alerts = trimmed_lox()
    r = client.get("/api/official/fire-weather")
    assert contract_problems(FireWeatherResponse, r.content) == []
    d = r.json()
    assert d["incident_id"] is None and len(d["alerts"]) == 2 and d["area_bbox"] is None
    assert all(a["covers_reported_location"] is None for a in d["alerts"]) and len(d["zones"]["features"]) == 4
    past = client.get("/api/official/fire-weather", params={"at_ms": LOX_NOW - 2 * DAY_MS}).json()
    assert past["status"] == "not_available_for_past_dates" and past["alerts"] == []
    assert client.get("/api/official/fire-weather", params={"incident": "bad id"}).status_code == 400
    assert client.get("/api/official/fire-weather", params={"incident": "nothing-here"}).status_code == 404
    assert client.get("/api/official/fire-weather", params={"incident": "x", "margin_km": 99}).status_code == 422


def test_endpoint_rate_limit(upstream: Upstream, client: TestClient, tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(official, "now_ms", lambda: NOW)
    monkeypatch.setattr(nws, "NWS_LIMITER", fhttp.RateLimiter(1, 60.0, "test"))
    assert nws.NWS_LIMITER.try_acquire()
    write_manifest(tmp_data_dir, "2026-henderson-fire-3e3dfe", "live", HENDERSON, HENDERSON_AOI, "2026-10-15T21:35:52Z")
    r = client.get("/api/official/fire-weather", params={"incident": "2026-henderson-fire-3e3dfe"})
    assert r.status_code == 429 and "request limit" in r.json()["detail"]
