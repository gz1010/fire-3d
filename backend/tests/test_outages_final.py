"""Provider outages (brief 3 final verification; CONTRACT 14.16): a failed source list is remembered for a minute and
answered from its cached copy (marked stale) or as unavailable at once; the request path stays well under the web's
30 s timeout; oversized query times answer 422; broken region files answer 503; the live count is unknown, never 0."""

from __future__ import annotations

import json
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from test_us_catalog_list import (  # noqa: F401 - pytest fixtures
    CAL_LIVE,
    CURRENT,
    ID,
    _no_live_loop,
    world,
)
from test_us_catalog_mock import WfigsServer

import fire3d.http as fhttp
from fire3d import catalog, regions
from fire3d.api import live
from fire3d.contracts import IncidentListResponse, LiveStatus, contract_problems
from fire3d.sources import calfire, wfigs

WF_KEY = wfigs.list_key(wfigs.CURRENT_URL, wfigs.current_where())
PINE_ID = f"2026-pine-{ID['E1E2E3E4'][:6].lower()}"


def test_down_memo_holds_then_forgets() -> None:
    memo = fhttp.DownMemo("test", hold_s=0.05)
    assert not memo.down("a")
    memo.mark("a")
    assert memo.down("a") and memo.down("b", "a") and not memo.down("b")
    time.sleep(0.07)
    assert not memo.down("a")
    memo.mark("a")
    memo.clear("a")
    assert not memo.down("a")
    memo.mark("a")
    fhttp.reset_down_memos()
    assert not memo.down("a")


@pytest.fixture
def wf(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path):
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)
    srv = WfigsServer(current=list(CURRENT), ytd=list(CURRENT), all_years=list(CURRENT))
    state = {"mode": "ok", "calls": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        state["calls"] += 1
        if state["mode"] == "connect":
            raise httpx.ConnectError("simulated outage", request=request)
        if state["mode"] == "html":
            return httpx.Response(200, text="<html>maintenance</html>", headers={"content-type": "text/html"})
        return srv.handle(request)

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    return state


def test_wfigs_old_copy_is_marked_stale_and_a_dead_host_is_not_asked_again(wf) -> None:
    rows = wfigs.list_current()
    t0 = wfigs.fetched_ms(WF_KEY)
    assert rows and not wfigs.is_stale(WF_KEY) and wf["calls"] == 1
    wf["mode"] = "connect"
    assert len(wfigs.list_current(refresh=True)) == len(rows)        # the cached copy, at once (no retry: a copy exists)
    assert wfigs.is_stale(WF_KEY) and wfigs.fetched_ms(WF_KEY) == t0 and wf["calls"] == 2
    wfigs.list_current(refresh=True)                                  # remembered: WFIGS is not asked again
    with pytest.raises(wfigs.WfigsError):
        wfigs.list_year(2026)                                         # never cached; the whole source is down
    assert wf["calls"] == 2
    wf["mode"] = "ok"
    fhttp.reset_down_memos()
    wfigs.list_current(refresh=True)
    assert not wfigs.is_stale(WF_KEY) and wf["calls"] == 3


def test_wfigs_html_page_never_replaces_the_good_copy(wf) -> None:
    wfigs.list_current()
    wf["mode"] = "html"
    params = wfigs._params(wfigs.current_where(), 0)
    assert len(wfigs.list_current(refresh=True)) > 0 and wfigs.is_stale(WF_KEY)
    assert fhttp.has_cache("GET", wfigs.CURRENT_URL, params)        # the last good copy is still there
    assert fhttp.peek_cache("GET", wfigs.CURRENT_URL, params, None).json()["features"]


def test_calfire_503_is_remembered_per_list(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path) -> None:
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)
    state = {"down": False, "calls": []}

    def handler(request: httpx.Request) -> httpx.Response:
        state["calls"].append(dict(request.url.params))
        return httpx.Response(503) if state["down"] else httpx.Response(200, json=CAL_LIVE)

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    calfire.list_live()
    state["down"] = True
    assert len(calfire.list_live(refresh=True)) == len(CAL_LIVE) and calfire.is_stale("live")
    n = len(state["calls"])
    calfire.list_live(refresh=True)
    assert len(state["calls"]) == n                                   # the live list is remembered as failing
    with pytest.raises(calfire.CalFireError):
        calfire.list_year(2024)                                       # another list is still asked (a 503 is per list)
    assert len(state["calls"]) == n + 2                               # one retry when no copy is cached


def test_list_sources_say_when_a_copy_is_old(world) -> None:  # noqa: F811
    from fire3d.api.app import app

    rows, sources = catalog.list_incidents("live")
    fresh = {s["id"]: s for s in sources}
    assert fresh["wfigs"]["stale"] is False and fresh["wfigs"]["reason"] is None
    world["srv"].down = True                                           # 503: an old copy is served
    catalog.clear_cache()
    rows2, sources2 = catalog.list_incidents("live", refresh=True)
    src = {s["id"]: s for s in sources2}
    assert len(rows2) == len(rows)
    assert src["wfigs"]["status"] == "available" and src["wfigs"]["stale"] is True
    assert src["wfigs"]["reason"] == catalog.WFIGS_STALE and src["wfigs"]["retrieved_ms"] == fresh["wfigs"]["retrieved_ms"]
    assert src["calfire"]["stale"] is False
    with TestClient(app) as client:
        r = client.get("/api/incidents", params={"mode": "live"})
        assert r.status_code == 200 and contract_problems(IncidentListResponse, r.content) == []
        assert {s["id"]: s["stale"] for s in r.json()["sources"]} == {"calfire": False, "wfigs": True}


def _ready_bundle(tmp_data_dir: Path, iid: str) -> None:
    d = tmp_data_dir / "incidents" / iid
    d.mkdir(parents=True)
    summ = {"id": iid, "name": "Pine", "mode": "live", "year": 2026, "calfire_uid": "", "started_ms": 1, "updated_ms": None,
            "contained_ms": None, "acres": 1200.0, "percent_contained": 40.0, "is_active": True, "county": None,
            "location": None, "admin_unit": None, "url": None, "lat": 42.4, "lon": -122.9, "detections_24h": None,
            "bundle_status": "ready", "bundle_built_ms": 5, "state": "OR", "record_source": "wfigs"}
    (d / "manifest.json").write_text(json.dumps({"id": iid, "status": "ready", "built_ms": 5, "mode": "live", "summary": summ}))


def test_total_outage_answers_within_the_web_timeout(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path) -> None:
    """Panel F1 / SR-M2: every host refuses (real backoff, no sleep patch). A prepared fire opens in under 5 s, a
    listed fire without a bundle is 503 in under 10 s, and the next answers come at once (the failure is remembered)."""
    from fire3d.api.app import app

    monkeypatch.setattr(catalog, "default_year", lambda: 2026)

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("simulated outage", request=request)

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(refuse))
    catalog.clear_cache()
    _ready_bundle(tmp_data_dir, PINE_ID)
    with TestClient(app) as client:
        t = time.monotonic()
        r = client.get(f"/api/incidents/{PINE_ID}")
        first = time.monotonic() - t
        assert r.status_code == 200 and r.json()["summary"]["id"] == PINE_ID and first < 5.0, first
        t = time.monotonic()
        r = client.get("/api/incidents/2026-nonexistent-abcdef")
        assert r.status_code == 503 and r.json()["detail"] == catalog.LISTS_UNAVAILABLE_TEXT
        assert time.monotonic() - t < 10.0
        t = time.monotonic()
        lst = client.get("/api/incidents", params={"mode": "live"})
        assert client.get(f"/api/incidents/{PINE_ID}").status_code == 200
        assert time.monotonic() - t < 1.0                              # remembered: no host is asked again
        assert lst.status_code == 200 and contract_problems(IncidentListResponse, lst.content) == []
        body = lst.json()
        assert [s["id"] for s in body["incidents"]] == [PINE_ID]
        assert {s["status"] for s in body["sources"]} == {"unavailable"}
    catalog.clear_cache()


@pytest.mark.parametrize("path", ["/api/official/local-alerts", "/api/official/fire-weather", "/api/extras/evacuations",
                                  "/api/extras/cameras", "/api/extras/imagery"])
def test_oversized_at_ms_is_422(path: str) -> None:
    from fire3d.api.app import app

    with TestClient(app) as client:
        r = client.get(path, params={"bbox": "-121.4,44.0,-121.2,44.1", "at_ms": "99999999999999999999"})
        assert r.status_code == 422, r.text
        r = client.get(path, params={"bbox": "-121.4,44.0,-121.2,44.1", "at_ms": str(4_102_444_800_001)})
        assert r.status_code == 422, r.text


def test_live_count_is_unknown_when_the_lists_are_down(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(live.STATE, "active_incidents", 241)
    monkeypatch.setattr(live.STATE, "running", True)
    monkeypatch.setattr(catalog, "get_catalog", lambda *a, **k: (_ for _ in ()).throw(calfire.CalFireError("both down")))
    monkeypatch.setattr(live, "detections_24h_ca", lambda *a, **k: None)
    monkeypatch.setattr(live, "detections_24h_us", lambda *a, **k: None)
    live._refresh_counts()
    st = live.live_status()
    assert st.active_incidents is None
    assert contract_problems(LiveStatus, json.dumps(st.model_dump()).encode()) == []


def test_broken_region_files_answer_503_not_500(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from fire3d.api.app import app

    def clear() -> None:
        for f in (regions.state_at, regions.county_at, regions.time_zone_at, regions.coverage_at):
            clear_fn = getattr(f, "cache_clear", None)
            if clear_fn is not None:
                clear_fn()

    for name in ("STATES_FILE", "COUNTIES_FILE", "TIMEZONES_FILE"):
        monkeypatch.setattr(regions, name, tmp_path / "missing.geojson")
    monkeypatch.setattr(regions, "_layers", {})
    clear()
    try:
        with TestClient(app) as client:
            for path, params in (("/api/geo/lookup", {"lon": "-112.0", "lat": "46.6"}),
                                 ("/api/extras/evacuations", {"bbox": "-112.1,46.5,-111.9,46.7"})):
                r = client.get(path, params=params)
                assert r.status_code == 503 and r.json()["detail"] == regions.REGIONS_UNAVAILABLE_TEXT, (path, r.text)
                assert "internal error" not in r.text
    finally:
        clear()
