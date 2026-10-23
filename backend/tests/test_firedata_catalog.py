"""catalog.py: ids/slugs, historical + live catalogs (detections_24h), bundle status, get_summary fallbacks,
detection clustering and estimate_fire_bbox (offline; CAL FIRE samples + synthetic FIRMS feeds)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import httpx
import numpy as np
import pandas as pd
import pytest
from shapely.geometry import box

import fire3d.http as fhttp
from fire3d import catalog, config
from fire3d.contracts import IncidentSummary, contract_problems
from fire3d.sources import firms, perimeters
from fire3d.timeutil import DAY_MS, HOUR_MS, iso_to_ms, now_ms

DATA = Path(__file__).parent / "data" / "firedata"
LIVE = json.loads((DATA / "calfire_live.json").read_text())
Y2025 = json.loads((DATA / "calfire_2025.json").read_text())
FEED_HEADER = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight\n"


def feed_row(lat: float, lon: float) -> str:
    return f"{lat:.5f},{lon:.5f},330.0,0.4,0.4,2026-10-16,2100,N,nominal,2.0NRT,300.0,5.0,D\n"


KM_LAT = 1 / 111.32
SNPP_24H = FEED_HEADER + "".join([
    feed_row(33.3445, -117.4145), feed_row(33.3500, -117.4100), feed_row(33.3400, -117.4200),   # Henderson
    feed_row(33.3500, -117.5250),                                                              # Scales
    feed_row(36.224857 + 8 * KM_LAT, -121.72983),                                              # Timber, 8 km north (r = 11.4 km)
    feed_row(35.0, -119.0),                                                                    # California, no incident nearby
    feed_row(40.9, -117.85),                                                                   # Nevada: outside the CA bbox
])


@pytest.fixture(autouse=True)
def _isolate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", "0123456789abcdef0123456789abcdef")
    catalog.clear_cache()
    yield
    catalog.clear_cache()


@pytest.fixture
def services(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path):
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)
    state: dict = {"calls": [], "feeds_down": False}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        state["calls"].append(url)
        if "incidents.fire.ca.gov" in url:
            q = dict(request.url.params)
            if q.get("inactive") == "false":
                return httpx.Response(200, json=LIVE)
            return httpx.Response(200, json=Y2025 if q.get("year") == "2025" else [dict(LIVE[0], IsActive=False)])
        if "/data/active_fire/" in url:
            if state["feeds_down"]:
                return httpx.Response(503)
            return httpx.Response(200, text=SNPP_24H if "SUOMI_VIIRS_C2" in url else FEED_HEADER)
        return httpx.Response(404)

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    return state


# ------------------------------------------------------------------------------------------------------------------
# Ids
# ------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("name,slug", [("Eaton Fire", "eaton-fire"), ("Timber Fire ", "timber-fire"),
                                       ("12th St / B St Fire", "12th-st-b-st-fire"), ("  --Orleans  Complex--", "orleans-complex"),
                                       ("6-5 Fire", "6-5-fire"), ("O'Neil Fire", "o-neil-fire")])
def test_slugify(name: str, slug: str) -> None:
    assert catalog.slugify(name) == slug


def test_incident_ids() -> None:
    assert catalog.make_incident_id(2025, "Eaton Fire", "DBFA574E-1A4C-4F14") == "2025-eaton-fire-dbfa57"
    assert catalog.parse_incident_id("2025-eaton-fire-dbfa57") == (2025, "eaton-fire", "dbfa57")
    assert catalog.parse_incident_id("2025-6-5-fire-85af75") == (2025, "6-5-fire", "85af75")
    assert catalog.parse_incident_id("fixture-demo") is None


# ------------------------------------------------------------------------------------------------------------------
# Catalogs
# ------------------------------------------------------------------------------------------------------------------
def test_historical_catalog(services) -> None:
    rows = catalog.get_catalog("historical", year=2025)     # brief 3: the default year is the current UTC year
    assert [s.id for s in rows] == ["2025-gifford-fire-fb7c1c", "2025-palisades-fire-abfed7", "2025-eaton-fire-dbfa57"]
    assert all(s.mode == "historical" and s.detections_24h is None and s.bundle_status == "none" for s in rows)
    assert rows[0].name == "Gifford Fire" and rows[0].contained_ms == iso_to_ms("2025-10-14T15:00:00Z")
    assert [s.name for s in catalog.get_catalog("historical", min_acres=100, year=2025)][3:] == ["Catlett Fire", "Rosa Fire"]
    everything = catalog.get_catalog("historical", min_acres=0, year=2025)
    assert len(everything) == 7 and "Eaton Flood" not in {s.name for s in everything}       # not a fire type
    assert "Scout Fire" in {s.name for s in everything}                                     # Type "Fire" counts
    assert all(not contract_problems(IncidentSummary, s) for s in everything)


def test_live_catalog_detections_and_order(services) -> None:
    rows = catalog.get_catalog("live")
    assert [(s.name, s.detections_24h) for s in rows] == [
        ("Henderson Fire", 3), ("Timber Fire", 1), ("Scales Fire", 1), ("Blue Fire", 0), ("Gall Fire", 0)]
    assert "Garden Grove HAZMAT" not in {s.name for s in rows}
    assert rows[0].id == "2026-henderson-fire-3e3dfe" and rows[0].mode == "live" and rows[0].is_active
    assert all(not contract_problems(IncidentSummary, s) for s in rows)
    assert catalog.live_detections_24h_total() == 6                     # inside California (the Nevada row is in the bbox)
    n = len(services["calls"])
    catalog.get_catalog("live")
    assert len(services["calls"]) == n                                   # in-memory cache
    catalog.get_catalog("live", refresh=True)
    assert len(services["calls"]) > n


def test_live_catalog_without_feeds(services) -> None:
    services["feeds_down"] = True
    rows = catalog.get_catalog("live")
    assert len(rows) == 5 and all(s.detections_24h is None for s in rows)
    assert [s.name for s in rows][:2] == ["Timber Fire", "Henderson Fire"]    # then by acres
    assert catalog.live_detections_24h_total() is None


def test_bundle_status_from_manifest(services, tmp_data_dir: Path) -> None:
    d = tmp_data_dir / "incidents" / "2025-eaton-fire-dbfa57"
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"status": "ready", "built_ms": 1234567}))
    b = tmp_data_dir / "incidents" / "2025-gifford-fire-fb7c1c"
    b.mkdir(parents=True)
    (b / "manifest.json").write_text(json.dumps({"status": "building", "built_ms": 99}))
    rows = {s.id: s for s in catalog.get_catalog("historical", year=2025)}
    assert (rows["2025-eaton-fire-dbfa57"].bundle_status, rows["2025-eaton-fire-dbfa57"].bundle_built_ms) == ("ready", 1234567)
    assert (rows["2025-gifford-fire-fb7c1c"].bundle_status, rows["2025-gifford-fire-fb7c1c"].bundle_built_ms) == ("building", None)
    assert rows["2025-palisades-fire-abfed7"].bundle_status == "none"


def test_get_summary_fallbacks(services, tmp_data_dir: Path) -> None:
    assert catalog.get_summary("2026-henderson-fire-3e3dfe").mode == "live"
    eaton = catalog.get_summary("2025-eaton-fire-dbfa57")
    assert eaton is not None and eaton.mode == "historical" and eaton.acres == 14021.0
    assert catalog.get_summary("2025-catlett-fire-01fa37") is not None          # below 300 ac still resolves
    assert catalog.get_summary("2024-timber-fire-b7e4a3") is not None           # other year -> CAL FIRE year list
    assert catalog.get_summary("2024-timber-fire-b7e4a3").mode == "historical"
    assert catalog.get_summary("2025-nothing-fire-abcdef") is None
    # a bundle on disk that no catalog lists (e.g. the fixture): the manifest's summary
    summ = _summary(id="fixture-demo", name="Fixture Fire")
    d = tmp_data_dir / "incidents" / "fixture-demo"
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"status": "ready", "built_ms": 5, "summary": summ.model_dump(mode="json")}))
    fx = catalog.get_summary("fixture-demo")
    assert fx is not None and fx.id == "fixture-demo" and fx.bundle_status == "ready" and fx.bundle_built_ms == 5


def test_in_california_outline() -> None:
    lat = np.array([34.2, 40.9, 32.6, 33.3, 41.0, 36.5, 33.95])
    lon = np.array([-118.1, -117.85, -115.5, -114.3, -121.5, -116.9, -119.75])   # LA, NV, Mexicali, AZ, Shasta, Death Valley, Santa Cruz Is.
    assert list(catalog.in_california(lat, lon)) == [True, False, False, False, True, True, True]


def test_assign_detections_counts_each_detection_once() -> None:
    incidents = [(34.0, -118.0, 5000.0), (34.0, -117.9, 5000.0)]       # ~9.2 km apart
    lat = np.array([34.0, 34.0, 34.0, 34.0])
    lon = np.array([-118.0, -117.955, -117.945, -117.5])               # A, shared (closer to A), shared (closer to B), none
    assert list(catalog.assign_detections(incidents, lat, lon)) == [2, 1]
    assert catalog.detection_radius_m(20) == 5000.0
    assert math.isclose(catalog.detection_radius_m(25351.9), 2 * math.sqrt(25351.9 * config.ACRE_M2 / math.pi))
    assert catalog.detection_radius_m(1e7) == catalog.DET_RADIUS_MAX_M


# ------------------------------------------------------------------------------------------------------------------
# Fire bbox
# ------------------------------------------------------------------------------------------------------------------
def test_cluster_detections_space_time() -> None:
    x = np.array([0.0, 1000.0, 2000.0, 3000.0, 20000.0, 21000.0, 4000.0])
    y = np.zeros(7)
    t = np.array([0, 1, 2, 3, 0, 1, 10]) * HOUR_MS
    t[6] = 10 * DAY_MS                                                  # adjacent in space, 10 days later
    seeds = np.array([True, False, False, False, False, False, False])
    keep = catalog.cluster_detections(x, y, t, seeds)
    assert list(keep) == [True, True, True, True, False, False, False]
    assert not catalog.cluster_detections(x, y, t, np.zeros(7, dtype=bool)).any()


def _summary(**kw) -> IncidentSummary:
    base = dict(id="2025-test-fire-abcdef", name="Test Fire", mode="historical", year=2025, calfire_uid="abcdef", started_ms=iso_to_ms("2025-01-08T02:00:00Z"),
                updated_ms=None, contained_ms=iso_to_ms("2025-01-20T00:00:00Z"), acres=5000.0, percent_contained=100.0, is_active=False,
                county=None, location=None, admin_unit=None, url=None, lat=34.20, lon=-118.07, detections_24h=None, bundle_status="none", bundle_built_ms=None)
    base.update(kw)
    return IncidentSummary(**base)


def _dets(points: list[tuple[float, float, int]]) -> pd.DataFrame:
    df = firms.empty_frame()
    rows = [{"t_ms": t, "lat": la, "lon": lo, "frp": 5.0, "satellite": "N", "instrument": "VIIRS", "confidence": "n", "daynight": "D",
             "scan": 0.4, "track": 0.4, "type": 0, "source": "VIIRS_SNPP_SP"} for la, lo, t in points]
    return pd.concat([df, pd.DataFrame(rows)], ignore_index=True) if rows else df


def test_estimate_fire_bbox_perimeter_and_connected_cluster(monkeypatch: pytest.MonkeyPatch) -> None:
    s = _summary()
    t0 = s.started_ms
    perim = perimeters.PerimeterList([{"t_ms": t0 + DAY_MS, "acres": 4000.0, "geometry": box(-118.09, 34.18, -118.05, 34.22)}])
    chain = [(34.20, -118.05 + 0.01 * i, t0 + i * HOUR_MS) for i in range(1, 6)]     # runs east of the perimeter
    far = [(34.20, -117.70, t0 + HOUR_MS), (34.205, -117.705, t0 + 2 * HOUR_MS)]      # another fire 30+ km east
    calls = {}

    def fake_perims(name, lat, lon, start_ms, end_ms, **kw):
        calls["perim"] = (name, start_ms, end_ms, kw)
        return perim

    def fake_dets(bbox, start_ms, end_ms, mode, **kw):
        calls["det"] = (bbox, start_ms, end_ms, mode, kw)
        return _dets(chain + far)

    monkeypatch.setattr(perimeters, "fetch_perimeters", fake_perims)
    monkeypatch.setattr(firms, "detections_for", fake_dets)
    w, so, e, n = catalog.estimate_fire_bbox(s)
    assert w <= -118.09 and so <= 34.18 and n >= 34.22                 # the perimeter
    assert -118.0 < e < -117.98                                        # + the connected chain (to -118.00 + pad)
    assert e < -117.8                                                  # not the far fire
    assert calls["perim"][3] == {"acres": 5000.0, "contained_ms": s.contained_ms}
    bbox, start_ms, end_ms, mode, kw = calls["det"]
    assert mode == "historical" and start_ms == t0 - 12 * HOUR_MS
    assert end_ms == iso_to_ms("2025-01-21T00:00:00Z")                 # containment + 1 d
    assert kw == {"instruments": ("VIIRS",), "families": ("SNPP", "NOAA20")}
    assert bbox[0] < -118.07 < bbox[2]


def test_estimate_fire_bbox_fallback_circle(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*a, **k):
        raise RuntimeError("network down")

    monkeypatch.setattr(perimeters, "fetch_perimeters", boom)
    s = _summary(acres=5000.0)                                         # circle of 5,000 ac: radius ~ 2.54 km
    w, so, e, n = catalog.estimate_fire_bbox(s)
    r = math.sqrt(5000 * config.ACRE_M2 / math.pi)
    assert math.isclose((n - so) / 2 * 111_320.0, r, rel_tol=1e-6)
    assert w < s.lon < e and so < s.lat < n
    for acres in (None, 640.0):                                        # 640 ac -> 908 m: the 1 km minimum applies
        small = catalog.estimate_fire_bbox(_summary(acres=acres))
        assert math.isclose((small[3] - small[1]) / 2 * 111_320.0, 1000.0, rel_tol=1e-6)


def test_estimate_fire_bbox_live_uses_feeds(monkeypatch: pytest.MonkeyPatch) -> None:
    now = now_ms()
    s = _summary(mode="live", is_active=True, started_ms=now - 3 * DAY_MS, contained_ms=None)
    monkeypatch.setattr(perimeters, "fetch_perimeters", lambda *a, **k: perimeters.PerimeterList([]))
    monkeypatch.setattr(firms, "load_live_us", lambda days=7, **k: _dets([(34.20, -118.07, now - DAY_MS), (34.20, -118.06, now - DAY_MS + HOUR_MS)]))
    monkeypatch.setattr(firms, "detections_for", lambda *a, **k: pytest.fail("live bbox must use the keyless feeds"))
    w, so, e, n = catalog.estimate_fire_bbox(s)
    assert w <= -118.07 and e >= -118.06
