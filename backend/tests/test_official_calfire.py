"""CAL FIRE status history (sources/calfire_history.py), the catalog's recording hooks, the current-year list and
GET /api/official/calfire (offline; CAL FIRE samples in tests/data/firedata, recorded 2026-10-16)."""

from __future__ import annotations

import copy
import json
import threading
import warnings
from pathlib import Path

import httpx
import orjson
import pytest
from fastapi import FastAPI

with warnings.catch_warnings():     # the installed Starlette deprecates httpx in its TestClient (not our code)
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

import fire3d.http as fhttp
from fire3d import catalog, config
from fire3d.api import official
from fire3d.contracts import CalFireOfficialResponse, contract_problems
from fire3d.sources import calfire, calfire_history as hist
from fire3d.timeutil import DAY_MS, iso_to_ms, ms_to_dt, now_ms

DATA = Path(__file__).parent / "data" / "firedata"
LIVE = json.loads((DATA / "calfire_live.json").read_text())
Y2025 = json.loads((DATA / "calfire_2025.json").read_text())
FEED_HEADER = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight\n"
HENDERSON_ID = "2026-henderson-fire-3e3dfe"
HENDERSON_UID = "3e3dfee3-8214-4341-a777-6b0ad643c9af"
EATON_ID = "2025-eaton-fire-dbfa57"
EATON_UID = "dbfa574e-1b10-4467-b5e5-7d1c06ebc8dc"


def raw(name: str, records: list[dict] = LIVE) -> dict:
    return copy.deepcopy(next(r for r in records if r["Name"].strip() == name))


def rec(name: str = "Henderson Fire", **changes) -> dict:
    """A cleaned CAL FIRE record (sources.calfire.normalize_incident) with raw-key changes."""
    r = raw(name)
    r.update(changes)
    return calfire.normalize_incident(r)


class CalFire:
    """MockTransport handler: CAL FIRE's IncidentApi/List (live + year lists) and empty FIRMS 24 h feeds."""

    def __init__(self) -> None:
        self.live = copy.deepcopy(LIVE)
        self.years: dict[int, list[dict]] = {2025: copy.deepcopy(Y2025), 2026: [raw("Henderson Fire")]}
        self.down = False
        self.calls: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.calls.append(url)
        if "incidents.fire.ca.gov" in url:
            if self.down:
                return httpx.Response(503)
            q = dict(request.url.params)
            if q.get("inactive") == "false":
                return httpx.Response(200, json=self.live)
            return httpx.Response(200, json=self.years.get(int(q["year"]), []))
        if "/data/active_fire/" in url:
            return httpx.Response(200, text=FEED_HEADER)
        raise RuntimeError(f"unrouted request in test: {url}")

    def refresh(self) -> None:
        """Make the next list calls fetch again (as after the 10 / 30 min cache times)."""
        fhttp.evict_cache("GET", calfire.LIST_URL, {"inactive": "false"})
        for y in self.years:
            fhttp.evict_cache("GET", calfire.LIST_URL, {"inactive": "true", "year": y})
        catalog.clear_cache()


@pytest.fixture
def cal(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path) -> CalFire:
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", None)
    catalog.clear_cache()
    hist.reset_state()
    c = CalFire()
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(c))
    yield c
    catalog.clear_cache()
    hist.reset_state()


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(official.router)
    return TestClient(app)


def lines(uid: str) -> list[dict]:
    return [orjson.loads(x) for x in hist.history_path(uid).read_bytes().splitlines()]


# ----------------------------------------------------------------------------------------------------------------
# Snapshots and rules
# ----------------------------------------------------------------------------------------------------------------
def test_snapshot_fields() -> None:
    s = hist.snapshot(rec(), 1234, "live")
    assert s["uid"] == HENDERSON_UID and s["incident_id"] == HENDERSON_ID and s["name"] == "Henderson Fire"
    assert (s["acres"], s["percent_contained"], s["is_active"], s["final"]) == (2079.5, 20.0, True, False)
    assert s["updated_ms"] == iso_to_ms("2026-10-17T02:25:15Z") and s["seen_ms"] == 1234 and s["list"] == "live"
    assert s["url"] == "https://www.fire.ca.gov/incidents/2026/10/15/henderson-fire/" and s["agencies"] is None
    assert hist.valid_uid("../../etc") is None and hist.valid_uid(HENDERSON_UID.upper()) == HENDERSON_UID
    with pytest.raises(ValueError):
        hist.history_path("../x")


def test_dedupe_rules() -> None:
    a = hist.snapshot(rec(), 1, "live")
    assert hist.is_new(None, a)
    assert not hist.is_new(a, dict(a, seen_ms=99))                                        # same Updated and values
    assert hist.is_new(a, dict(a, updated_ms=a["updated_ms"] + 1))                        # new Updated, same values
    assert hist.is_new(a, dict(a, percent_contained=65.0))                                # same Updated, new values
    assert not hist.is_new(a, dict(a, updated_ms=a["updated_ms"] - 1, percent_contained=10.0))   # an older copy
    assert hist.is_new(dict(a, updated_ms=None), dict(a, updated_ms=None, acres=1.0))


def test_record_baseline_changes_and_stale_copies(tmp_data_dir: Path) -> None:
    hist.reset_state()
    first = rec()
    assert hist.record([first], list_name="live", seen_ms=100) == [HENDERSON_UID]
    assert hist.record([first], list_name="live", seen_ms=200) == []                     # unchanged: no line
    newer = rec(Updated="2026-10-18T15:01:09Z", AcresBurned=3160.0, PercentContained=65.0)
    assert hist.record([newer], list_name="live", seen_ms=300) == [HENDERSON_UID]
    stale = rec(Updated="2026-10-17T01:13:17Z", AcresBurned=2000.0, PercentContained=10.0)     # an old cached copy
    assert hist.record([stale], list_name="year:2026", seen_ms=400) == []
    bumped = rec(Updated="2026-10-18T16:00:00Z", AcresBurned=3160.0, PercentContained=65.0)    # only Updated changed
    assert hist.record([bumped], list_name="live", seen_ms=500) == [HENDERSON_UID]
    h = hist.read(HENDERSON_UID)
    assert [x["seen_ms"] for x in h] == [100, 300, 500]
    assert hist.changes(h) == [{"updated_ms": iso_to_ms("2026-10-18T15:01:09Z"), "seen_ms": 300,
                                "acres": [2079.5, 3160.0], "percent_contained": [20.0, 65.0]}]
    raw_bytes = hist.history_path(HENDERSON_UID).read_bytes()
    assert raw_bytes.endswith(b"\n") and len(raw_bytes.splitlines()) == 3
    assert not [p for p in hist.history_dir().iterdir() if p.name.endswith(".tmp")]       # atomic writes
    hist.reset_state()                                                                      # a new process
    assert hist.record([newer], list_name="live", seen_ms=600) == []


def test_record_scope(tmp_data_dir: Path) -> None:
    hist.reset_state()
    out = rec(IsActive=False)
    assert hist.record([out], list_name="year:2026") == []                                 # inactive, untracked
    assert hist.record([out], list_name="endpoint", track=True) == [HENDERSON_UID]          # asked for explicitly
    later = rec(IsActive=False, Updated="2026-10-20T00:00:00Z", PercentContained=100.0)
    assert hist.record([later], list_name="year:2026") == [HENDERSON_UID]                  # tracked from now on
    assert hist.record([{"uid": "", "is_active": True}, {"uid": "not a uid!", "is_active": True}], list_name="live") == []


def test_concurrent_writers_lose_nothing(tmp_data_dir: Path) -> None:
    hist.reset_state()
    base = iso_to_ms("2026-10-18T00:00:00Z")
    recs = [rec(Updated=f"2026-10-18T{h:02d}:00:00Z", AcresBurned=3000.0 + h) for h in range(12)]
    threads = [threading.Thread(target=hist.record, args=([r],), kwargs={"list_name": "live", "seen_ms": base + i})
               for i, r in enumerate(recs)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    h = hist.read(HENDERSON_UID)
    assert all(isinstance(x, dict) for x in h) and 1 <= len(h) <= 12
    assert [x["updated_ms"] for x in h] == sorted(x["updated_ms"] for x in h)            # never backwards
    assert h[-1]["acres"] == 3011.0                                                        # the newest record won


def test_missing_active_and_find_uid(tmp_data_dir: Path) -> None:
    hist.reset_state()
    hist.record([rec(), rec("Scales Fire")], list_name="live")
    assert hist.missing_active([HENDERSON_UID]) == {2026: {rec("Scales Fire")["uid"]}}
    assert hist.find_uid(HENDERSON_ID) == HENDERSON_UID and hist.find_uid("2026-other-fire-3e3dfe") is None
    assert hist.find_uid("fixture-demo") is None


# ----------------------------------------------------------------------------------------------------------------
# Catalog hooks and the current-year list
# ----------------------------------------------------------------------------------------------------------------
def test_catalog_records_active_fires(cal: CalFire) -> None:
    catalog.get_catalog("live")
    uids = hist.tracked_uids()
    names = {r["Name"].strip() for r in LIVE if r["UniqueId"].lower() in uids}
    assert names == {"Timber Fire", "Blue Fire", "Henderson Fire", "Gall Fire", "Scales Fire"}      # not the HAZMAT
    h = hist.read(HENDERSON_UID)
    assert len(h) == 1 and h[0]["seen_ms"] == calfire.fetched_ms("live") and h[0]["list"] == "live"
    catalog.get_catalog("historical")                                     # 2025: nothing active, nothing tracked
    assert hist.tracked_uids() == uids


def test_fire_leaving_the_live_list_gets_its_final_record(cal: CalFire) -> None:
    catalog.get_catalog("live")
    cal.live = [r for r in cal.live if r["Name"] != "Henderson Fire"]
    cal.years[2026] = [dict(raw("Henderson Fire"), IsActive=False, PercentContained=100.0, Final=True,
                            Updated="2026-10-19T18:00:00Z", ExtinguishedDate="2026-10-19T17:00:00Z")]
    cal.refresh()
    catalog.get_catalog("live", refresh=True)
    h = hist.read(HENDERSON_UID)
    assert [x["is_active"] for x in h] == [True, False] and h[-1]["list"] == "year:2026"
    assert hist.changes(h)[0]["is_active"] == [True, False] and hist.changes(h)[0]["final"] == [False, True]
    n = sum(1 for u in cal.calls if "year=2026" in u)
    catalog.clear_cache()
    catalog.get_catalog("live")
    assert sum(1 for u in cal.calls if "year=2026" in u) == n             # no longer missing: no more year lookups


def test_current_year_list_follows_the_live_list(cal: CalFire) -> None:
    cal.years[2026] = [dict(raw("Henderson Fire"), Updated="2026-10-16T10:00:00Z", AcresBurned=900.0, PercentContained=0.0),
                       dict(raw("Timber Fire"), IsActive=False)]
    rows = {s.name: s for s in catalog.get_catalog("historical", min_acres=0, year=2026)}
    assert rows["Henderson Fire"].acres == 2079.5 and rows["Henderson Fire"].percent_contained == 20.0     # live is newer
    assert rows["Timber Fire"].is_active is True                          # same Updated: the live record
    assert {"Scales Fire", "Gall Fire", "Blue Fire"} <= set(rows)          # live fires the year copy lacks
    assert "Garden Grove HAZMAT" not in rows
    assert all(s.mode == "historical" and s.year == 2026 and s.detections_24h is None for s in rows.values())
    assert [s.name for s in catalog.get_catalog("historical", year=2026)] == ["Timber Fire", "Henderson Fire"]  # >= 300 ac
    assert [s.id for s in catalog.get_catalog("historical", year=2025)][:1] == ["2025-gifford-fire-fb7c1c"]
    assert catalog.default_year() == ms_to_dt(now_ms()).year                 # brief 3: the current UTC year
    assert calfire.year_ttl_s(2026) == calfire.CURRENT_YEAR_TTL_S and calfire.year_ttl_s(2025) == calfire.YEAR_TTL_S


# ----------------------------------------------------------------------------------------------------------------
# Endpoint
# ----------------------------------------------------------------------------------------------------------------
def test_calfire_endpoint_for_a_live_fire(cal: CalFire, client: TestClient) -> None:
    r = client.get("/api/official/calfire", params={"incident": HENDERSON_ID})
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    assert contract_problems(CalFireOfficialResponse, r.content) == []
    d = r.json()
    assert d["kind"] == "calfire" and d["status"] == "available" and d["incident_id"] == HENDERSON_ID
    assert d["current"] == {"acres": 2079.5, "percent_contained": 20.0, "is_active": True, "final": False,
                            "updated_ms": iso_to_ms("2026-10-17T02:25:15Z"), "extinguished_ms": None}
    assert d["source"] == {"name": "CAL FIRE incident list", "url": d["incident_url"], "credit": "CAL FIRE"}
    assert d["incident_url"] == "https://www.fire.ca.gov/incidents/2026/10/15/henderson-fire/"
    assert d["changes"] == [] and d["recording_since_ms"] == d["retrieved_ms"] == calfire.fetched_ms("live")
    assert d["source_updated_ms"] == d["current"]["updated_ms"] and d["requested_at_ms"] is None
    assert any("only since it first checked" in c for c in d["caveats"])
    # CAL FIRE updates the record: the next check records the change
    cal.live = [dict(r, Updated="2026-10-18T15:01:09Z", AcresBurned=3160.0, PercentContained=65.0,
                     AgencyNames="United States Marine Corps, CAL FIRE") if r["Name"] == "Henderson Fire" else r for r in cal.live]
    cal.refresh()
    d2 = client.get("/api/official/calfire", params={"incident": HENDERSON_ID}).json()
    assert d2["current"]["percent_contained"] == 65.0 and d2["agencies"] == "United States Marine Corps, CAL FIRE"
    assert d2["changes"] == [{"updated_ms": iso_to_ms("2026-10-18T15:01:09Z"), "seen_ms": calfire.fetched_ms("live"),
                              "acres": [2079.5, 3160.0], "percent_contained": [20.0, 65.0]}]
    assert d2["recording_since_ms"] == d["recording_since_ms"]
    assert contract_problems(CalFireOfficialResponse, orjson.dumps(d2)) == []


def test_calfire_endpoint_for_a_past_fire(cal: CalFire, client: TestClient) -> None:
    d = client.get("/api/official/calfire", params={"incident": EATON_ID}).json()
    assert d["status"] == "available" and d["current"]["final"] is True and d["current"]["is_active"] is False
    assert d["current"]["extinguished_ms"] == iso_to_ms("2025-01-31T18:48:42Z") and d["changes"] == []
    assert d["agencies"].startswith(", LA County Mental Health")             # verbatim, as CAL FIRE publishes it
    assert any("history of a past fire is not available" in c and "final record" in c for c in d["caveats"])
    assert any("edited this record well after" in c for c in d["caveats"])  # Updated Aug 2026, contained Jan 2025
    assert hist.read(EATON_UID)[0]["list"] == "year:2025"                   # an explicit check is recorded


def test_calfire_endpoint_states(cal: CalFire, client: TestClient, tmp_data_dir: Path) -> None:
    d = tmp_data_dir / "incidents" / "fixture-demo"
    d.mkdir(parents=True)
    (d / "manifest.json").write_bytes(orjson.dumps({"id": "fixture-demo", "mode": "historical", "status": "ready",
                                                     "summary": {"calfire_uid": "00000000-f1e3-4d00-8000-00000000d3a0"}}))
    n = len(cal.calls)
    fx = client.get("/api/official/calfire", params={"incident": "fixture-demo"}).json()
    assert fx["status"] == "unavailable" and fx["reason_code"] == "not_covered" and len(cal.calls) == n   # no network
    assert contract_problems(CalFireOfficialResponse, orjson.dumps(fx)) == []
    assert client.get("/api/official/calfire", params={"incident": "2026-nothing-fire-abcdef"}).status_code == 404
    assert client.get("/api/official/calfire", params={"incident": "bad id"}).status_code == 400
    assert client.get("/api/official/calfire").status_code == 422
    assert HENDERSON_UID in hist.tracked_uids()          # the 404 lookup checked the live list: active fires recorded
    # CAL FIRE down and nothing recorded for this fire: unavailable, no numbers
    cal.down = True
    cal.refresh()
    for p in (tmp_data_dir / "cache").rglob("*"):
        if p.is_file():
            p.unlink()
    down = client.get("/api/official/calfire", params={"incident": EATON_ID}).json()
    assert down["status"] == "unavailable" and down["reason_code"] == "upstream_error" and down["current"] is None
    assert "could not be reached" in down["reason"]


def test_calfire_endpoint_shows_the_last_record_while_cal_fire_is_down(cal: CalFire, client: TestClient,
                                                                         tmp_data_dir: Path) -> None:
    client.get("/api/official/calfire", params={"incident": HENDERSON_ID})
    cal.down = True
    cal.refresh()
    for p in (tmp_data_dir / "cache").rglob("*"):
        if p.is_file():
            p.unlink()
    d = client.get("/api/official/calfire", params={"incident": HENDERSON_ID}).json()
    assert d["status"] == "unavailable" and d["reason_code"] == "upstream_error"
    assert "Showing the last record Fire-3d saw" in d["reason"] and d["current"]["percent_contained"] == 20.0
    assert d["retrieved_ms"] is None and d["recording_since_ms"] is not None
    assert contract_problems(CalFireOfficialResponse, orjson.dumps(d)) == []


def test_history_lives_outside_the_bundles(cal: CalFire, tmp_data_dir: Path) -> None:
    catalog.get_catalog("live")
    p = hist.history_path(HENDERSON_UID)
    assert p.is_file() and p.parent == tmp_data_dir / "official" / "calfire"
    assert not str(p).startswith(str(config.INCIDENTS_DIR))
    assert DAY_MS > 0


def test_live_loop_cycle_and_summary_sync_record_history(cal: CalFire, tmp_data_dir: Path) -> None:
    from fire3d.api import live

    summaries, _ = live.fetch_cycle_data()                  # the cycle's CAL FIRE refresh (catalog, refresh=True)
    assert {s.name for s in summaries} >= {"Henderson Fire"} and HENDERSON_UID in hist.tracked_uids()
    # a ready live bundle whose fire then left CAL FIRE's live list: the summary sync looks it up in its year's list
    d = tmp_data_dir / "incidents" / HENDERSON_ID
    d.mkdir(parents=True)
    summary = next(s for s in summaries if s.id == HENDERSON_ID).model_dump(mode="json")
    (d / "manifest.json").write_bytes(orjson.dumps({"id": HENDERSON_ID, "mode": "live", "status": "ready", "summary": summary}))
    cal.live = [r for r in cal.live if r["Name"] != "Henderson Fire"]
    cal.years[2026] = [dict(raw("Henderson Fire"), IsActive=False, PercentContained=100.0, Updated="2026-10-19T18:00:00Z")]
    cal.refresh()
    hist.reset_state()                                      # as in a fresh process: state comes from the files
    changed = live.sync_live_summaries([])                  # nothing listed: every live bundle is looked up
    assert changed == [HENDERSON_ID]
    h = hist.read(HENDERSON_UID)
    assert [x["percent_contained"] for x in h] == [20.0, 100.0] and h[-1]["is_active"] is False
