"""api/app.py: every SPEC 6 route via TestClient with faked modules; bundle serving against fixture-demo."""

from __future__ import annotations

import gzip
import shutil
import threading
import time
import warnings

import orjson
import pytest

with warnings.catch_warnings():     # the installed Starlette deprecates httpx in its TestClient (not our code)
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

import fire3d.build.aoi as aoi
import fire3d.catalog as catalog
import fire3d.spread.ensemble as ensemble
from fire3d import bundle, config
from fire3d.api import app as app_mod
from fire3d.api import live
from fire3d.api.jobs import JobManager, set_manager
from fire3d.build import pipeline
from fire3d.contracts import (
    AircraftResponse, HealthResponse, IncidentDetailResponse, IncidentListResponse, IncidentListRow, IncidentManifest,
    IncidentSummary, JobStatus, LiveStatus, contract_problems,
)
from fire3d.sources import aircraft as acmod
from fire3d.timeutil import HOUR_MS
from test_pipeline_support import FAKE_KEY, FakeBuild, make_summary

FIXTURE_ROOT = config.REPO_ROOT / "data" / "incidents"
HIST = "2025-alpha-fire-aaa111"
HIST_SMALL = "2025-small-fire-bbb222"
LIVE = "2026-live-fire-ccc333"
LIVE_NOBUNDLE = "2026-new-fire-ddd444"


@pytest.fixture
def jm(monkeypatch):
    monkeypatch.setattr(config, "LIVE_ENABLED", False)
    m = JobManager()
    set_manager(m)
    app_mod.AIRCRAFT_CACHE.clear()
    acmod.reset_limits()
    yield m
    m.shutdown()
    assert m.drain(30), "background jobs still running after the test"
    set_manager(None)


@pytest.fixture
def client(jm):
    with TestClient(app_mod.app) as c:
        yield c


@pytest.fixture
def fake(tmp_data_dir, monkeypatch) -> FakeBuild:
    fb = FakeBuild([
        make_summary(HIST, "historical", name="Alpha Fire", acres=5000.0),
        make_summary(HIST_SMALL, "historical", name="Small Fire", acres=200.0),
        make_summary(LIVE, "live", name="Live Fire", acres=900.0, detections_24h=55),
        make_summary(LIVE_NOBUNDLE, "live", name="New Fire", acres=150.0, detections_24h=3, lat=36.5, lon=-121.5),
    ])
    return fb.install(monkeypatch)


@pytest.fixture
def fixtures_dir(monkeypatch):
    """Serve the read-only fixture bundles (GET endpoints only)."""
    if not (FIXTURE_ROOT / "fixture-demo" / "manifest.json").is_file():
        pytest.skip("fixture bundles missing: run scripts/make_fixture.py")
    monkeypatch.setattr(config, "INCIDENTS_DIR", FIXTURE_ROOT)
    monkeypatch.setattr(catalog, "get_summary", lambda iid: None)
    return FIXTURE_ROOT


def wait_job(client, job_id, timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        st = client.get(f"/api/jobs/{job_id}").json()
        if st["status"] in ("done", "error"):
            return st
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish")


# ------------------------------------------------------------------------------------------------ basics
def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json() == {"ok": True, "version": config.VERSION}
    assert contract_problems(HealthResponse, r.content) == []


def test_incident_lists(client, fake):
    pipeline.build_incident(HIST)
    r = client.get("/api/incidents", params={"mode": "historical"})
    assert r.status_code == 200 and contract_problems(IncidentListResponse, r.content) == []
    body = r.json()
    assert body["mode"] == "historical" and body["updated_ms"] > 0
    assert [s["id"] for s in body["incidents"]] == [HIST]                     # default min_acres 300 hides the 200 ac fire
    assert body["incidents"][0]["bundle_status"] == "ready" and body["incidents"][0]["bundle_built_ms"]
    rows = client.get("/api/incidents", params={"mode": "historical", "min_acres": 100}).json()["incidents"]
    assert [s["id"] for s in rows] == [HIST, HIST_SMALL] and rows[1]["bundle_status"] == "none"
    live_rows = client.get("/api/incidents", params={"mode": "live"}).json()["incidents"]
    assert [s["id"] for s in live_rows] == [LIVE, LIVE_NOBUNDLE]
    assert client.get("/api/incidents", params={"mode": "bogus"}).status_code == 422
    assert client.get("/api/incidents", params={"min_acres": -5}).status_code == 422


def test_incident_list_year_and_bbox(client, fake):
    """BRIEF-2 O-R8: ``year=`` reaches other years (brief 3: default the current UTC year); rows carry the ready
    bundle's area."""
    pipeline.build_incident(HIST)
    pipeline.build_incident(LIVE)
    body = client.get("/api/incidents", params={"mode": "historical"}).json()
    assert body["year"] == catalog.default_year() and [s["id"] for s in body["incidents"]] == [HIST]
    m = bundle.load_manifest(bundle.bundle_dir(HIST))
    assert body["incidents"][0]["bbox_lonlat"] == list(m["grid"]["bbox_lonlat"])
    r = client.get("/api/incidents", params={"mode": "historical", "year": 2026, "min_acres": 0})
    assert r.status_code == 200 and contract_problems(IncidentListResponse, r.content) == []
    season = r.json()
    assert season["year"] == 2026 and {s["id"] for s in season["incidents"]} == {LIVE, LIVE_NOBUNDLE}
    assert all(s["mode"] == "historical" for s in season["incidents"])           # the list's mode; see is_active
    rows = {s["id"]: s for s in season["incidents"]}
    assert rows[LIVE]["is_active"] and rows[LIVE]["bbox_lonlat"] == list(bundle.load_manifest(bundle.bundle_dir(LIVE))["grid"]["bbox_lonlat"])
    assert rows[LIVE_NOBUNDLE]["bbox_lonlat"] is None and rows[LIVE_NOBUNDLE]["bundle_status"] == "none"
    live = client.get("/api/incidents", params={"mode": "live", "year": 2025}).json()   # year applies to historical only
    assert "year" not in live and {s["id"] for s in live["incidents"]} == {LIVE, LIVE_NOBUNDLE}
    assert all("bbox_lonlat" in s for s in live["incidents"])
    assert client.get("/api/incidents", params={"mode": "historical", "year": 1999}).status_code == 422


def _fallback_dir(tmp_data_dir, monkeypatch):
    """A data dir with fixture-demo / fixture-live (synthetic) and copies of their manifests under listed-form ids
    (``2025-demo-fire-aaaaaa``, ``2026-live-fire-bbbbbb``), as on a server with prepared real fires."""
    import shutil

    if not (FIXTURE_ROOT / "fixture-demo" / "manifest.json").is_file():
        pytest.skip("fixture bundles missing: run scripts/make_fixture.py")
    inc = tmp_data_dir / "incidents"
    for name, real in (("fixture-demo", "2025-demo-fire-aaaaaa"), ("fixture-live", "2026-live-fire-bbbbbb")):
        (inc / name).mkdir()
        shutil.copy(FIXTURE_ROOT / name / "manifest.json", inc / name / "manifest.json")
        m = orjson.loads((FIXTURE_ROOT / name / "manifest.json").read_bytes())
        m["summary"]["id"] = real
        m["summary"]["year"] = int(real[:4])
        (inc / real).mkdir()
        (inc / real / "manifest.json").write_bytes(orjson.dumps(m))
    monkeypatch.setattr(catalog, "get_catalog", lambda *a, **k: (_ for _ in ()).throw(ConnectionError("CAL FIRE unreachable")))
    return inc


def test_incident_list_year_fallback_uses_bundles_of_that_year(client, tmp_data_dir, monkeypatch):
    _fallback_dir(tmp_data_dir, monkeypatch)
    y2026 = client.get("/api/incidents", params={"mode": "historical", "year": 2026}).json()["incidents"]
    assert [s["id"] for s in y2026] == ["2026-live-fire-bbbbbb"] and all(s["year"] == 2026 for s in y2026)
    assert all(s["bbox_lonlat"] and len(s["bbox_lonlat"]) == 4 for s in y2026)
    y2025 = client.get("/api/incidents", params={"mode": "historical", "year": 2025}).json()["incidents"]
    assert [s["id"] for s in y2025] == ["2025-demo-fire-aaaaaa"]


def test_incident_list_falls_back_to_bundles(client, tmp_data_dir, monkeypatch):
    """Both lists down: only prepared fires of listed ids are listed (never a synthetic fixture as an agency's fire;
    final verification, panel SR-B1), each source says why, and a historical list without a year is the default
    year's (panel F6)."""
    _fallback_dir(tmp_data_dir, monkeypatch)
    r = client.get("/api/incidents", params={"mode": "historical"})
    assert r.status_code == 200 and contract_problems(IncidentListResponse, r.content) == []
    body = r.json()
    assert body["year"] == catalog.default_year()
    assert all(s["year"] == catalog.default_year() for s in body["incidents"])
    assert {x["status"] for x in body["sources"]} == {"unavailable"}
    assert all("only fires prepared on this server are listed" in x["reason"] for x in body["sources"])
    live = client.get("/api/incidents", params={"mode": "live"}).json()
    assert [s["id"] for s in live["incidents"]] == ["2026-live-fire-bbbbbb"]
    for b in (body, live):
        assert not any(s["id"].startswith("fixture-") for s in b["incidents"])
        for s in b["incidents"]:
            m = bundle.load_manifest(bundle.bundle_dir(s["id"]))
            assert m is not None and s["bundle_status"] == m["summary"]["bundle_status"], s["id"]
    # the synthetic bundles themselves still open by id (read-only)
    assert client.get("/api/incidents/fixture-live").json()["summary"]["id"] == "fixture-live"


def test_incident_detail(client, fake):
    pipeline.build_incident(HIST)
    r = client.get(f"/api/incidents/{HIST}")
    assert r.status_code == 200 and contract_problems(IncidentDetailResponse, r.content) == []
    d = r.json()
    assert d["summary"]["id"] == HIST and d["summary"]["bundle_status"] == "ready"
    assert d["manifest"]["status"] == "ready" and d["job"] is None
    nob = client.get(f"/api/incidents/{HIST_SMALL}").json()
    assert nob["manifest"] is None and nob["summary"]["bundle_status"] == "none"
    assert client.get("/api/incidents/2025-unknown-000000").status_code == 404
    assert client.get("/api/incidents/bad%20id").status_code == 404
    assert client.get("/api/incidents/..%2F..%2Fetc").status_code == 404


def test_fixture_bundle_detail_without_catalog(client, fixtures_dir):
    d = client.get("/api/incidents/fixture-demo").json()
    assert d["summary"]["id"] == "fixture-demo" and d["manifest"]["status"] == "ready"
    assert contract_problems(IncidentManifest, d["manifest"]) == []


def test_stale_and_failed_manifests(client, fake):
    fake.fail["observed"] = RuntimeError("observations exploded")
    with pytest.raises(RuntimeError):
        pipeline.build_incident(HIST)
    d = client.get(f"/api/incidents/{HIST}").json()
    assert d["manifest"]["status"] == "error" and d["summary"]["bundle_status"] == "error"
    assert any("observations exploded" in w for w in d["manifest"]["warnings"])
    assert contract_problems(IncidentManifest, d["manifest"]) == []           # placeholders keep the contract shape
    # a "building" manifest nobody is building (killed process) is reported as an interrupted build
    bdir = bundle.bundle_dir(HIST)
    bundle.update_manifest(bdir, lambda m: m.__setitem__("status", "building"))
    d = client.get(f"/api/incidents/{HIST}").json()
    assert d["manifest"]["status"] == "error" and d["summary"]["bundle_status"] == "error"
    assert any("interrupted" in w for w in d["manifest"]["warnings"])
    with pipeline.bundle_lock(bdir):                                             # e.g. a CLI build in another process
        d = client.get(f"/api/incidents/{HIST}").json()
        assert d["manifest"]["status"] == "building" and d["summary"]["bundle_status"] == "building"


# ------------------------------------------------------------------------------------------------ build jobs
def test_build_job_flow(client, fake, monkeypatch):
    gate = threading.Event()
    orig = fake.build_static_layers

    def slow_static(ctx):
        gate.wait(10)
        orig(ctx)

    monkeypatch.setattr(aoi, "build_static_layers", slow_static)
    r = client.post(f"/api/incidents/{HIST}/build")
    assert r.status_code == 200 and contract_problems(JobStatus, r.content) == []
    job = r.json()
    assert job["kind"] == "build" and job["incident_id"] == HIST and job["status"] in ("queued", "running")
    assert client.post(f"/api/incidents/{HIST}/build").json()["id"] == job["id"]          # deduped
    deadline = time.time() + 5
    while client.get(f"/api/jobs/{job['id']}").json()["status"] != "running" and time.time() < deadline:
        time.sleep(0.02)
    rows = client.get("/api/incidents", params={"mode": "historical"}).json()["incidents"]
    assert rows[0]["bundle_status"] == "building"
    assert client.get(f"/api/incidents/{HIST}").json()["job"]["id"] == job["id"]
    gate.set()
    done = wait_job(client, job["id"])
    assert done["status"] == "done" and done["progress"] == 1.0 and done["result"]["status"] == "ready"
    d = client.get(f"/api/incidents/{HIST}").json()
    assert d["manifest"]["status"] == "ready" and d["job"]["status"] == "done"
    assert d["summary"]["bundle_built_ms"] == d["manifest"]["built_ms"] == done["result"]["built_ms"]
    # not forced: a ready bundle is returned untouched; forced: rebuilt
    again = wait_job(client, client.post(f"/api/incidents/{HIST}/build").json()["id"])
    assert again["status"] == "done" and fake.calls["static"] == 1
    forced = wait_job(client, client.post(f"/api/incidents/{HIST}/build", params={"force": "true"}).json()["id"])
    assert forced["status"] == "done" and fake.calls["static"] == 2


def test_build_failure_is_masked(client, fake, monkeypatch):
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", FAKE_KEY)
    fake.fail["weather"] = RuntimeError(f"weather failed at https://firms.modaps.eosdis.nasa.gov/api/area/csv/{FAKE_KEY}/x")
    st = wait_job(client, client.post(f"/api/incidents/{HIST}/build").json()["id"])
    assert st["status"] == "error" and FAKE_KEY not in st["error"] and "***" in st["error"]
    d = client.get(f"/api/incidents/{HIST}").json()
    assert d["manifest"]["status"] == "error" and FAKE_KEY not in str(d)


def test_build_unknown_and_non_catalog(client, fixtures_dir):
    """The 14.2 build gate at the API, with its exact texts (brief-3 hand-off from us-catalog to us-pipeline, done by
    the integration; the CLI and the Alaska 422 are in test_us_pipeline_build.py)."""
    r = client.post("/api/incidents/2025-unknown-000000/build")
    assert r.status_code == 404 and r.json()["detail"] == "unknown incident '2025-unknown-000000'"
    for local in ("fixture-demo", "fixture-east"):
        if not (FIXTURE_ROOT / local / "manifest.json").is_file():
            continue
        r = client.post(f"/api/incidents/{local}/build", params={"force": "true"})
        assert r.status_code == 409 and r.json()["detail"] == f"'{local}' is a local or synthetic bundle; it cannot be rebuilt."
        assert "CAL FIRE" not in r.json()["detail"]
    st = wait_job(client, client.post("/api/incidents/fixture-demo/build").json()["id"])
    assert st["status"] == "done" and st["result"]["status"] == "ready"   # ready fixture returned untouched


def test_build_gate_alias_and_unsupported_state(client, fixtures_dir, monkeypatch):
    """An id the lists know under another id is an alias (409 'is listed as'); a listed fire in Alaska, Hawaii or a
    territory is 422 with the 14.14 sentence; no job is started for either."""
    listed = make_summary("2024-horse-gulch-889237", "historical").model_copy(update={"state": "MT", "record_source": "wfigs"})
    monkeypatch.setattr(catalog, "resolve_listed", lambda iid: listed)
    r = client.post("/api/incidents/fixture-demo/build", params={"force": "true"})
    assert r.status_code == 409 and r.json()["detail"] == "'fixture-demo' is listed as '2024-horse-gulch-889237'."
    ak = listed.model_copy(update={"id": "fixture-demo", "state": "AK"})
    monkeypatch.setattr(catalog, "resolve_listed", lambda iid: ak)
    r = client.post("/api/incidents/fixture-demo/build", params={"force": "true"})
    assert r.status_code == 422 and r.json()["detail"] == "Fire-3d does not support Alaska, Hawaii or US territories yet."
    assert app_mod._jobs().active_for("fixture-demo", "build") is None


# ------------------------------------------------------------------------------------------------ forecast jobs
def test_forecast_defaults_and_validation(client, fake):
    m = pipeline.build_incident(HIST)
    url = f"/api/incidents/{HIST}/forecast"
    st = wait_job(client, client.post(url, json={}).json()["id"])
    assert st["status"] == "done" and st["kind"] == "forecast" and st["result"]["run_id"] == "fx-001"
    expected = m.ignition.t_ms + 24 * HOUR_MS                              # resolved by run_forecast (SPEC 6)
    assert fake.forecast_args[-1] == {"start_ms": None, "horizon_h": 72, "ensemble": "auto", "members": None}
    assert st["result"]["start_ms"] == expected and st["result"]["ensemble"] == "perturbed"
    start = m.time_range.start_ms + 30 * HOUR_MS
    st = wait_job(client, client.post(url, json={"start_ms": start, "horizon_h": 24, "ensemble": "perturbed", "members": 7}).json()["id"])
    assert st["result"]["run_id"] == "fx-002" and fake.forecast_args[-1] == {"start_ms": start, "horizon_h": 24, "ensemble": "perturbed", "members": 7}
    st = wait_job(client, client.post(url).json()["id"])                   # no body at all -> defaults
    assert st["status"] == "done" and st["result"]["start_ms"] == expected
    assert client.post(url, json={"start_ms": m.time_range.start_ms - 5 * HOUR_MS}).status_code == 422
    assert client.post(url, json={"horizon_h": 0}).status_code == 422
    assert client.post(url, json={"members": 500}).status_code == 422
    assert client.post(url, json={"ensemble": "weathernext"}).status_code == 422
    d = client.get(f"/api/incidents/{HIST}").json()
    assert [f["run_id"] for f in d["manifest"]["forecasts"]] == ["fx-003", "fx-002", "fx-001"]


def test_forecast_live_default_and_errors(client, fake):
    m = pipeline.build_incident(LIVE)                                         # the live build ran fx-001 itself
    st = wait_job(client, client.post(f"/api/incidents/{LIVE}/forecast", json={}).json()["id"])
    assert st["result"]["run_id"] == "fx-002" and st["result"]["start_ms"] == m.time_range.now_ms
    assert st["result"]["ensemble"] == "gfs025"
    assert client.post(f"/api/incidents/{HIST_SMALL}/forecast", json={}).status_code == 409   # not built
    assert client.post("/api/incidents/2025-unknown-000000/forecast", json={}).status_code == 404


def test_forecast_dedupe_and_build_conflict(client, fake, monkeypatch):
    pipeline.build_incident(HIST)
    gate = threading.Event()
    orig = fake.run_forecast

    def slow(*a, **k):
        gate.wait(10)
        return orig(*a, **k)

    monkeypatch.setattr(ensemble, "run_forecast", slow)
    a = client.post(f"/api/incidents/{HIST}/forecast", json={}).json()
    b = client.post(f"/api/incidents/{HIST}/forecast", json={"horizon_h": 24}).json()
    assert a["id"] == b["id"]
    gate.set()
    assert wait_job(client, a["id"])["status"] == "done"
    assert client.get("/api/jobs/job-does-not-exist").status_code == 404
    # a forecast requested while a build of the same incident runs -> 409 "build running"
    gate2 = threading.Event()
    orig_static = fake.build_static_layers
    monkeypatch.setattr(aoi, "build_static_layers", lambda ctx: (gate2.wait(10), orig_static(ctx)))
    job = client.post(f"/api/incidents/{HIST_SMALL}/build").json()
    r = client.post(f"/api/incidents/{HIST_SMALL}/forecast", json={})
    assert r.status_code == 409 and "build" in r.json()["detail"] and "running" in r.json()["detail"]
    gate2.set()
    assert wait_job(client, job["id"])["status"] == "done"


# ------------------------------------------------------------------------------------------------ bundle files
def test_bundle_files(client, fixtures_dir):
    root = fixtures_dir / "fixture-demo"
    r = client.get("/api/bundles/fixture-demo/manifest.json", params={"v": 123})
    assert r.status_code == 200 and r.headers["content-encoding"] == "gzip"
    assert r.headers["cache-control"] == "no-cache" and r.headers["etag"].startswith('W/"')
    assert r.headers["content-type"].startswith("application/json") and r.content == (root / "manifest.json").read_bytes()
    assert client.get("/api/bundles/fixture-demo/manifest.json", headers={"If-None-Match": r.headers["etag"]}).status_code == 304
    with client.stream("GET", "/api/bundles/fixture-demo/layers/elevation.bin") as s:
        raw = b"".join(s.iter_raw())
    assert gzip.decompress(raw) == (root / "layers" / "elevation.bin").read_bytes() and len(raw) < (root / "layers" / "elevation.bin").stat().st_size
    plain = client.get("/api/bundles/fixture-demo/layers/fuel.bin", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers and plain.content == (root / "layers" / "fuel.bin").read_bytes()
    jpg = client.get("/api/bundles/fixture-demo/layers/naip.jpg")
    assert jpg.headers["content-type"] == "image/jpeg" and "content-encoding" not in jpg.headers
    assert jpg.content[:2] == b"\xff\xd8"
    assert client.get("/api/bundles/fixture-demo/forecasts/fx-001/forecast.json").status_code == 200


@pytest.mark.parametrize("path", [
    "..%2F..%2Fetc%2Fpasswd", "%2E%2E/%2E%2E/README", "layers/..%2F..%2Ffixture-live%2Fmanifest.json", "%2Fetc%2Fpasswd",
    ".manifest.lock", "layers", "layers/", "nope.json", "layers/.hidden.bin", "sim/..%2F..%2F..%2F.env",
])
def test_bundle_traversal_is_404(client, fixtures_dir, path):
    assert client.get(f"/api/bundles/fixture-demo/{path}").status_code == 404


def test_bundle_unknown_incident(client, fixtures_dir):
    assert client.get("/api/bundles/no-such-incident/manifest.json").status_code == 404
    assert client.get("/api/bundles/..%2Fdata/manifest.json").status_code == 404


# ------------------------------------------------------------------------------------------------ aircraft
def _raw_aircraft(lat, lon):
    return [
        {"hex": "a10001", "flight": "TNKR910 ", "r": "N612AX", "t": "DC10", "category": "A5", "lat": lat, "lon": lon, "alt_baro": 4500, "gs": 170.0, "track": 80.0, "seen": 0.5},
        {"hex": "a10002", "flight": "CFR301", "r": "N481DF", "t": "H60", "category": "A7", "lat": lat + 0.01, "lon": lon, "alt_baro": 3200, "gs": 60.0, "track": 200.0, "seen": 1.0},
        {"hex": "a10003", "flight": "N5512Q", "r": "N5512Q", "t": "C172", "category": "A1", "lat": lat, "lon": lon + 0.005, "alt_baro": 4000, "gs": 92.0, "seen": 2.0},
        {"hex": "a10004", "flight": "UAL2494 ", "r": "N54525", "t": "A21N", "category": "A3", "lat": lat, "lon": lon, "alt_baro": 3500, "gs": 160.0, "seen": 0.1},
        {"hex": "a10005", "flight": "SWA1", "t": "B38M", "category": "A3", "lat": lat + 0.4, "lon": lon, "alt_baro": 35000, "gs": 450.0, "seen": 0.3},
    ]


def test_aircraft_live_incident(client, fake, monkeypatch):
    m = pipeline.build_incident(LIVE)
    lon, lat = (m.grid.bbox_lonlat[0] + m.grid.bbox_lonlat[2]) / 2, (m.grid.bbox_lonlat[1] + m.grid.bbox_lonlat[3]) / 2
    calls = []

    def fake_fetch(qlat, qlon, radius):
        calls.append((qlat, qlon, radius))
        return _raw_aircraft(lat, lon), 1792201743500

    monkeypatch.setattr(acmod, "fetch_point", fake_fetch)
    r = client.get(f"/api/incidents/{LIVE}/aircraft")
    assert r.status_code == 200 and contract_problems(AircraftResponse, r.content) == []
    body = r.json()
    assert body["source"] == "adsb.lol" and body["radius_nm"] == 40 and body["updated_ms"] == 1792201743500
    by_hex = {a["hex"]: a for a in body["aircraft"]}
    assert set(by_hex) == {"a10001", "a10002", "a10003"}
    assert by_hex["a10001"]["category"] == "airtanker" and by_hex["a10002"]["category"] == "helicopter"
    assert by_hex["a10003"]["category"] == "other_fire" and by_hex["a10003"]["reason"].startswith("low & slow")
    assert by_hex["a10001"]["agl_m"] is not None and abs(by_hex["a10001"]["x"]) < 50
    allr = client.get(f"/api/incidents/{LIVE}/aircraft", params={"all": 1}).json()
    assert {a["hex"] for a in allr["aircraft"]} == {"a10001", "a10002", "a10003", "a10004", "a10005"}
    assert len(calls) == 1                                                  # 10 s response cache
    assert calls[0][2] == config.AIRCRAFT_RADIUS_NM and abs(calls[0][0] - lat) < 0.01

    # adsb.lol failing: the last good list is served (with a note) while it is < 2 min old
    monkeypatch.setattr(config, "AIRCRAFT_RESPONSE_CACHE_S", 0.0)

    def failing(*a):
        raise acmod.AircraftUnavailable("adsb.lol rate limit (HTTP 429); pausing requests for 30 s")

    monkeypatch.setattr(acmod, "fetch_point", failing)
    stale = client.get(f"/api/incidents/{LIVE}/aircraft").json()
    assert len(stale["aircraft"]) == 3 and "429" in stale["note"] and "s ago" in stale["note"]
    app_mod.AIRCRAFT_CACHE.clear()
    empty = client.get(f"/api/incidents/{LIVE}/aircraft").json()
    assert empty["aircraft"] == [] and empty["note"].startswith("Live aircraft unavailable")


def test_aircraft_historical_unknown_and_unbuilt(client, fake, monkeypatch):
    pipeline.build_incident(HIST)
    h = client.get(f"/api/incidents/{HIST}/aircraft").json()
    assert h["aircraft"] == [] and "live incidents only" in h["note"]
    assert client.get("/api/incidents/2025-unknown-000000/aircraft").status_code == 404
    monkeypatch.setattr(acmod, "fetch_point", lambda la, lo, r: ([{"hex": "b1", "flight": "CFR74", "r": "N439DF", "t": "S2P",
                                                                  "lat": la, "lon": lo, "alt_baro": 2500, "gs": 150.0}], None))
    u = client.get(f"/api/incidents/{LIVE_NOBUNDLE}/aircraft").json()      # no bundle: AOI around the CAL FIRE point
    assert [a["hex"] for a in u["aircraft"]] == ["b1"] and u["aircraft"][0]["agl_m"] is None
    assert abs(u["aircraft"][0]["x"]) < 1 and abs(u["aircraft"][0]["z"]) < 1


# ------------------------------------------------------------------------------------------------ live status, errors, CORS
def test_live_status(client, fake, monkeypatch):
    monkeypatch.setattr(live, "STATE", live.LiveState())
    r = client.get("/api/live/status")                                       # first call waits for the lazy counts
    assert r.status_code == 200 and contract_problems(LiveStatus, r.content) == []
    body = r.json()
    assert body["active_incidents"] == 2 and body["detections_24h_ca"] == 1234
    assert body["next_refresh_ms"] is None and body["auto_build"] is False


def test_unhandled_errors_are_masked(client, monkeypatch):
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", FAKE_KEY)

    def broken(*a, **k):
        raise RuntimeError(f"secret {FAKE_KEY} leaked")

    monkeypatch.setattr(app_mod, "_resolve", broken)
    r = client.get("/api/incidents/2025-x-000000")
    assert r.status_code == 500 and FAKE_KEY not in r.text and "***" in r.json()["detail"]


def test_cors_localhost_only(client):
    ok = client.options("/api/health", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    bad = client.options("/api/health", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in bad.headers


def test_summary_rows_validate(client, fake):
    rows = client.get("/api/incidents", params={"mode": "live"}).json()["incidents"]
    for row in rows:
        assert contract_problems(IncidentListRow, row) == []
        summary = {k: v for k, v in row.items() if k != "bbox_lonlat"}     # a row is a summary + bbox_lonlat
        assert contract_problems(IncidentSummary, summary) == []


def test_copied_fixture_bundle_build_is_noop(client, tmp_data_dir, monkeypatch):
    """A ready bundle the catalog does not know (copied fixture) can be read and 'built' without changes."""
    src = FIXTURE_ROOT / "fixture-live" / "manifest.json"
    if not src.is_file():
        pytest.skip("fixture bundles missing")
    monkeypatch.setattr(catalog, "get_summary", lambda iid: None)
    dst = tmp_data_dir / "incidents" / "fixture-live"
    dst.mkdir(parents=True)
    shutil.copy(src, dst / "manifest.json")
    st = wait_job(client, client.post("/api/incidents/fixture-live/build").json()["id"])
    assert st["status"] == "done" and (dst / "manifest.json").read_bytes() == src.read_bytes()


def test_catalog_bundle_fallback_is_read_only(client, fixtures_dir, monkeypatch):
    """The real catalog.get_summary answers from manifests on disk; such incidents still cannot be rebuilt."""
    def from_manifest(iid):
        m = bundle.load_manifest(bundle.bundle_dir(iid))
        return IncidentSummary.model_validate(m["summary"]) if m else None

    monkeypatch.setattr(catalog, "get_summary", from_manifest)
    assert client.get("/api/incidents/fixture-demo").json()["summary"]["id"] == "fixture-demo"
    assert client.post("/api/incidents/fixture-demo/build", params={"force": "true"}).status_code == 409


def test_log_formatter_masks_tracebacks(monkeypatch):
    import io
    import logging

    monkeypatch.setattr(config, "FIRMS_MAP_KEY", FAKE_KEY)
    buf = io.StringIO()
    h = logging.StreamHandler(buf)
    h.setFormatter(app_mod.MaskingFormatter(app_mod.LOG_FORMAT))
    lg = logging.getLogger("fire3d.test-masking")
    lg.addHandler(h)
    try:
        try:
            raise RuntimeError(f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{FAKE_KEY}/VIIRS_SNPP_NRT/x")
        except RuntimeError:
            lg.exception("request failed for MAP_KEY=%s", FAKE_KEY)
    finally:
        lg.removeHandler(h)
    out = buf.getvalue()
    assert "Traceback" in out and FAKE_KEY not in out and out.count("***") >= 2
