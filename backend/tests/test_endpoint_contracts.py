"""Every SPEC 6 endpoint on the real bundles in data/incidents, validated against contracts.py (read-only, offline).

The catalog (CAL FIRE), aircraft (adsb.lol / adsb.fi) and every other upstream are unreachable in tests (conftest
blocks fire3d.http), so this also checks the honest degraded states: lists fall back to the bundles on disk, live
aircraft answer with an empty list and a note, and nothing crashes. No POST starts a job (only validation errors).
The FIRMS key, when configured, must not appear in any response (count-only check; the key is never printed).
"""

from __future__ import annotations

import warnings

import numpy as np
import orjson
import pytest

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

from fire3d import bundle, catalog, config
from fire3d.api import app as app_mod
from fire3d.api.jobs import JobManager, set_manager
from fire3d.contracts import (
    AircraftResponse, DetectionsFile, EventsFile, ForecastManifest, HealthResponse, IncidentDetailResponse,
    IncidentListResponse, IncidentManifest, LiveStatus, PerimetersFile, TimeseriesFile, WeatherFile, contract_problems,
)
from fire3d.sources import aircraft as acmod

REAL_ROOT = config.REPO_ROOT / "data" / "incidents"
JSON_FILES = {"detections.json": DetectionsFile, "perimeters.json": PerimetersFile, "timeseries.json": TimeseriesFile,
              "events.json": EventsFile, "weather.json": WeatherFile}
DTYPE_BYTES = {"float32": 4, "uint8": 1, "uint16": 2, "int16": 2}


def _real_ids() -> list[str]:
    out = []
    if REAL_ROOT.is_dir():
        for d in sorted(REAL_ROOT.iterdir()):
            m = d / "manifest.json"
            if m.is_file() and not d.name.startswith("fixture"):
                try:
                    if orjson.loads(m.read_bytes()).get("status") == "ready":
                        out.append(d.name)
                except (OSError, orjson.JSONDecodeError):
                    pass
    return out


IDS = _real_ids()
pytestmark = pytest.mark.skipif(not IDS, reason="no real bundles in data/incidents")


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    mp = pytest.MonkeyPatch()
    mp.setattr(config, "LIVE_ENABLED", False)
    mp.setattr(config, "INCIDENTS_DIR", REAL_ROOT)           # the published bundles, read-only
    # an empty HTTP cache: the answers must not depend on how fresh the developer's data/cache lists are (a fresh live
    # list plus a day-old cached WFIGS lookup turned the unknown id's 404 into a 503)
    mp.setattr(config, "CACHE_DIR", tmp_path_factory.mktemp("http-cache"))
    catalog.clear_cache()
    m = JobManager()
    set_manager(m)
    app_mod.AIRCRAFT_CACHE.clear()
    acmod.reset_limits()
    with TestClient(app_mod.app) as c:
        yield c
    m.shutdown()
    set_manager(None)
    mp.undo()
    catalog.clear_cache()


def _no_secret(body: bytes) -> None:
    key = config.FIRMS_MAP_KEY
    if key:
        assert body.count(key.encode()) == 0, "FIRMS key in a response"


def _get(client, url: str, **kw):
    r = client.get(url, **kw)
    _no_secret(r.content)
    return r


def test_health_lists_status_and_errors(client) -> None:
    r = _get(client, "/api/health")
    assert r.status_code == 200 and contract_problems(HealthResponse, r.content) == []
    for mode in ("live", "historical"):
        r = _get(client, f"/api/incidents?mode={mode}")
        assert r.status_code == 200 and contract_problems(IncidentListResponse, r.content) == []
        ids = {s["id"] for s in r.json()["incidents"]}
        want = {i for i in IDS if orjson.loads((REAL_ROOT / i / "manifest.json").read_bytes())["mode"] == mode}
        assert want <= ids or mode == "historical"            # catalog offline: live comes from the bundles on disk
    r = _get(client, "/api/live/status")
    assert r.status_code == 200 and contract_problems(LiveStatus, r.content) == []
    assert _get(client, "/api/jobs/job-does-not-exist").status_code == 404
    assert _get(client, "/api/incidents/2099-nope-fire-000000").status_code == 404
    assert _get(client, f"/api/bundles/{IDS[0]}/../manifest.json").status_code == 404
    assert _get(client, f"/api/bundles/{IDS[0]}/.build.lock").status_code == 404
    assert _get(client, f"/api/bundles/{IDS[0]}/forecasts/fc-missing/forecast.json").status_code == 404
    r = client.post(f"/api/incidents/{IDS[0]}/forecast", json={"horizon_h": 0})
    assert r.status_code == 422 and "horizon_h" in r.text      # validated before any job starts
    r = client.post(f"/api/incidents/{IDS[0]}/forecast", json={"start_ms": 1})
    assert r.status_code == 422


@pytest.mark.parametrize("iid", IDS)
def test_every_endpoint_and_file_of_a_real_bundle(client, iid: str) -> None:
    r = _get(client, f"/api/incidents/{iid}")
    assert r.status_code == 200
    assert contract_problems(IncidentDetailResponse, r.content) == []
    doc = r.json()
    man = doc["manifest"]
    assert man is not None and contract_problems(IncidentManifest, man) == []
    tr = man["time_range"]
    assert tr["start_ms"] <= tr["now_ms"] <= tr["end_ms"] + 1 and tr["start_ms"] == man["time_origin_ms"]
    if man["mode"] == "live":
        assert tr["now_ms"] == tr["end_ms"]
        if "last_detection_ms" in tr:
            assert tr["last_detection_ms"] <= tr["now_ms"]
    else:
        assert "last_detection_ms" not in tr and "last_pass_ms" not in tr
    # every layer: present, gzip-able, exact byte size for its dtype/shape
    for name, info in man["layers"].items():
        r = _get(client, f"/api/bundles/{iid}/{info['file']}", headers={"Accept-Encoding": "identity"})
        assert r.status_code == 200, (iid, name)
        if info["dtype"] in DTYPE_BYTES:
            n = info["count"] * 6 if info["grid"] == "points" else info["width"] * info["height"]
            assert len(r.content) == n * DTYPE_BYTES[info["dtype"]], (iid, name)
    # every JSON file against its contract model
    for fname, model in JSON_FILES.items():
        r = _get(client, f"/api/bundles/{iid}/{fname}")
        assert r.status_code == 200 and contract_problems(model, r.content) == [], (iid, fname)
    ts = orjson.loads(_get(client, f"/api/bundles/{iid}/timeseries.json").content)
    assert ts["t_ms"][0] >= tr["start_ms"] and ts["t_ms"][-1] <= tr["now_ms"]
    det = orjson.loads(_get(client, f"/api/bundles/{iid}/detections.json").content)["detections"]
    assert all(d["t_ms"] <= tr["now_ms"] for d in det)
    # forecasts: summary entries point at ready forecast.json files with exact-size layers and documented semantics
    for f in man["forecasts"]:
        r = _get(client, f"/api/bundles/{iid}/{f['file']}")
        if f["status"] != "ready":
            continue
        assert r.status_code == 200 and contract_problems(ForecastManifest, r.content) == [], (iid, f["run_id"])
        fm = r.json()
        assert fm["start_ms"] == f["start_ms"] and fm["horizon_h"] == f["horizon_h"] and fm["incident_id"] == iid
        assert fm["series"]["t_ms"][0] == fm["start_ms"] and len(fm["series"]["t_ms"]) == fm["horizon_h"] + 1
        assert "start + horizon" in fm["layers"]["burn_probability"]["description"]
        assert "percentile" in fm["layers"]["arrival_p10"]["description"]
        for lname, info in fm["layers"].items():
            rr = _get(client, f"/api/bundles/{iid}/{info['file']}", headers={"Accept-Encoding": "identity"})
            assert rr.status_code == 200 and len(rr.content) == info["width"] * info["height"] * 4, (iid, lname)
            if lname == "burn_probability":
                bp = np.frombuffer(rr.content, dtype="<f4")
                assert float(bp.min()) >= 0.0 and float(bp.max()) <= 1.0
            if lname.startswith("arrival_p"):
                a = np.frombuffer(rr.content, dtype="<f4")
                assert np.all((a == np.float32(config.NEVER)) | (a >= (fm["start_ms"] - fm["time_origin_ms"]) / 3.6e6 - 1e3))
        if fm.get("skill"):
            assert man["mode"] == "historical"
    # gzip + ETag round trip on one file
    r1 = client.get(f"/api/bundles/{iid}/events.json", headers={"Accept-Encoding": "gzip"})
    etag = r1.headers["etag"]
    r2 = client.get(f"/api/bundles/{iid}/events.json", headers={"Accept-Encoding": "gzip", "If-None-Match": etag})
    assert r2.status_code == 304
    # aircraft: historical -> empty with a note; live with every provider unreachable -> empty with a note
    r = _get(client, f"/api/incidents/{iid}/aircraft")
    assert r.status_code == 200 and contract_problems(AircraftResponse, r.content) == []
    a = r.json()
    assert a["aircraft"] == [] and a.get("note")


def test_bundle_files_never_contain_the_key() -> None:
    key = config.FIRMS_MAP_KEY
    if not key:
        pytest.skip("no FIRMS key configured")
    hits = 0
    for iid in IDS:
        for p in (REAL_ROOT / iid).rglob("*"):
            if p.is_file() and p.suffix in (".json", ".txt", ".md"):
                hits += p.read_bytes().count(key.encode())
    assert hits == 0
