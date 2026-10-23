"""The official endpoints on the real bundles in data/incidents with every upstream unreachable (the conftest guard
blocks fire3d.http): each answers 200 with an honest degraded status that matches contracts.py, never a 500, never
"no alerts" for a past date, and never the FIRMS key (count-only check). History writes go to a temp DATA_DIR."""

from __future__ import annotations

import warnings

import orjson
import pytest
from fastapi import FastAPI

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

from fire3d import catalog, config
from fire3d.api import official
from fire3d.contracts import CalFireOfficialResponse, FireWeatherResponse, contract_problems
from fire3d.sources import calfire_history, nws

REAL_ROOT = config.REPO_ROOT / "data" / "incidents"


def _ready() -> list[tuple[str, dict]]:
    out = []
    if REAL_ROOT.is_dir():
        for d in sorted(REAL_ROOT.iterdir()):
            m = d / "manifest.json"
            if m.is_file():
                try:
                    man = orjson.loads(m.read_bytes())
                except (OSError, orjson.JSONDecodeError):
                    continue
                if man.get("status") == "ready":
                    out.append((d.name, man))
    return out


BUNDLES = _ready()
pytestmark = pytest.mark.skipif(not BUNDLES, reason="no bundles in data/incidents")


@pytest.fixture
def client(tmp_data_dir, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(config, "INCIDENTS_DIR", REAL_ROOT)           # read-only; history + cache in the temp dir
    monkeypatch.setattr(catalog, "get_summary", lambda iid: None)
    catalog.clear_cache()
    calfire_history.reset_state()
    nws.reset_state()
    app = FastAPI()
    app.include_router(official.router)
    return TestClient(app)


def _clean(body: bytes) -> None:
    key = config.FIRMS_MAP_KEY
    if key:
        assert body.count(key.encode()) == 0, "FIRMS key in a response"


@pytest.mark.parametrize("iid,man", BUNDLES, ids=[b[0] for b in BUNDLES])
def test_official_endpoints_degrade_honestly(client: TestClient, iid: str, man: dict) -> None:
    r = client.get("/api/official/calfire", params={"incident": iid})
    assert r.status_code == 200 and contract_problems(CalFireOfficialResponse, r.content) == []
    _clean(r.content)
    d = r.json()
    assert d["status"] == "unavailable" and d["reason_code"] in ("upstream_error", "not_covered")
    wfigs = (man.get("summary") or {}).get("record_source") == "wfigs"       # brief 3: NIFC WFIGS's record, not CAL FIRE's
    assert (d["reason_code"] == "not_covered") == (iid.startswith("fixture") or wfigs)
    if wfigs and not iid.startswith("fixture"):
        assert d["reason"] == "CAL FIRE does not list this fire; its official record is published by NIFC WFIGS."
    tr = man["time_range"]
    at = (tr["start_ms"] + tr["end_ms"]) // 2
    for params in ({"incident": iid}, {"incident": iid, "at_ms": at}):
        w = client.get("/api/official/fire-weather", params=params)
        assert w.status_code == 200 and contract_problems(FireWeatherResponse, w.content) == []
        _clean(w.content)
        f = w.json()
        assert f["alerts"] == [] and f["reported_location"] == [man["summary"]["lon"], man["summary"]["lat"]]
        past = man["mode"] == "historical" or "at_ms" in params
        assert f["status"] == ("not_available_for_past_dates" if past else "unavailable")
        assert not any("No Red Flag Warning" in c for c in f["caveats"])  # an unreachable source is never "none"
