"""The national FIRMS feeds (CONTRACT 14.12.1) and the live loop's national list (14.12.12), offline."""

from __future__ import annotations

from pathlib import Path

import httpx
import numpy as np
import pandas as pd
import pytest

import fire3d.http as fhttp
from fire3d import config
from fire3d.api import live
from fire3d.contracts import IncidentSummary
from fire3d.sources import firms
from fire3d.timeutil import DAY_MS, HOUR_MS, iso_to_ms, now_ms

DATA = Path(__file__).parent / "data" / "firedata"
FEED_HEADER = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight\n"
YEAR_HEADER = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type\n"

# (lat, lon, place): kept by the lower-48 box with its 0.5-degree margin, or dropped
KEEP = [(29.95, -98.40, "TX"), (27.10, -81.40, "FL"), (45.20, -68.90, "ME"), (49.30, -114.60, "BC/AB 0.3 deg north of MT"),
        (31.10, -108.70, "Chihuahua 0.2 deg south of NM"), (34.20, -118.10, "CA")]
DROP = [(19.40, -155.30, "HI"), (21.30, -157.80, "HI Oahu"), (64.80, -147.70, "AK"), (50.40, -114.60, "AB 1.4 deg north"),
        (23.50, -106.40, "Sinaloa")]


def _feed(rows) -> str:
    return FEED_HEADER + "".join(f"{la:.5f},{lo:.5f},330.0,0.4,0.4,2026-10-22,1830,N,nominal,2.0NRT,300.0,5.0,D\n" for la, lo, _ in rows)


@pytest.fixture
def route(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path):
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)
    state = {"calls": [], "routes": []}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        state["calls"].append(url)
        for pat, body in state["routes"]:
            if pat in url:
                return body if isinstance(body, httpx.Response) else httpx.Response(200, text=body)
        return httpx.Response(404)

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    return state


def test_load_live_us_keeps_the_lower48_box(route) -> None:
    route["routes"] = [("SUOMI_VIIRS_C2", _feed(KEEP + DROP)), ("/data/active_fire/", FEED_HEADER)]
    df = firms.load_live_us(1)
    got = {(round(a, 2), round(b, 2)) for a, b in zip(df["lat"], df["lon"])}
    assert got == {(la, lo) for la, lo, _ in KEEP}
    w, s, e, n = firms.L48_FIRMS_BOX
    assert (w, s, e, n) == (-125.4, 23.9, -66.4, 49.9)


def test_load_year_us_reads_the_national_parquet_with_filters(route, monkeypatch: pytest.MonkeyPatch) -> None:
    def year_rows(rows) -> str:
        return YEAR_HEADER + "".join(f"{la:.5f},{lo:.5f},330,0.4,0.4,2025-07-22,2015,N,VIIRS,n,2,290,9.5,D,0\n" for la, lo, _ in rows)

    mt = [(46.62, -111.80, "MT Horse Gulch"), (46.63, -111.79, "MT"), (46.64, -111.78, "MT")]
    route["routes"] = [("/data/country/viirs-snpp/2025/", year_rows(KEEP + DROP + mt)), ("/data/country/modis/2025/", YEAR_HEADER)]
    seen: list[dict] = []
    real = pd.read_parquet

    def spy(path, *a, **k):
        seen.append({"path": str(path), "filters": k.get("filters")})
        return real(path, *a, **k)

    monkeypatch.setattr(pd, "read_parquet", spy)
    allrows = firms.load_year_us(2025)
    assert len(allrows) == len(KEEP) + len(mt)
    box = (-112.0, 46.5, -111.6, 46.8)
    part = firms.load_year_us(2025, box)
    assert len(part) == 3 and set(part["source"]) == {"VIIRS_SNPP_SP"}
    assert all(Path(s["path"]).name == "firms_us_2025.parquet" for s in seen)
    assert seen[-1]["filters"] == [("lon", ">=", -112.0), ("lon", "<=", -111.6), ("lat", ">=", 46.5), ("lat", "<=", 46.8)]
    assert not list((Path(config.CACHE_DIR) / "firms").glob("firms_ca_*"))
    # keyless historical detections for a Montana fire come from the national yearly file
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", None)
    df = firms.detections_for(box, iso_to_ms("2025-07-20T00:00:00Z"), iso_to_ms("2025-07-25T00:00:00Z"), "historical")
    assert len(df) == 3 and any(s_["via"] == "yearly_archive" for s_ in df.attrs["sources"])
    assert len([u for u in route["calls"] if "/data/country/" in u]) == 2                       # downloaded once


def _summary(iid: str, lat: float, lon: float, acres: float | None, **kw) -> IncidentSummary:
    base = dict(id=iid, name=iid, mode="live", year=2026, calfire_uid="", started_ms=now_ms() - 3 * DAY_MS, updated_ms=None,
                contained_ms=None, acres=acres, percent_contained=None, is_active=True, county=None, location=None,
                admin_unit=None, url=None, lat=lat, lon=lon, detections_24h=0, bundle_status="none", bundle_built_ms=None,
                record_source="wfigs")
    base.update(kw)
    return IncidentSummary(**base)


def test_auto_build_candidates_national() -> None:
    now = now_ms()
    fires = [_summary("2026-kickapoo-creek-1e1e1e", 31.0, -97.6, 15000), _summary("2026-pine-e1e2e3", 42.4, -122.9, 1200),
             _summary("2026-east-fork-aaaaaa", 44.9, -115.4, 30000), _summary("2026-cooley-fire-c001e0", 40.1, -122.3, 1365,
                                                                               record_source="calfire"),
             _summary("2026-glades-9c9c9c", 26.2, -81.3, 700), _summary("2026-small-bbbbbb", 35.0, -90.0, 99.0),
             _summary("2026-quiet-cccccc", 38.0, -100.0, 5000)]
    rows = []
    for f, n, age_h in ((fires[0], 9, 2), (fires[1], 3, 5), (fires[2], 12, 1), (fires[3], 1, 10), (fires[4], 2, 3),
                        (fires[5], 20, 1), (fires[6], 8, 60)):
        rows += [{"t_ms": now - age_h * HOUR_MS, "lat": f.lat + 0.001 * i, "lon": f.lon} for i in range(n)]
    dets = pd.DataFrame(rows)
    cands = live.auto_build_candidates(fires, dets)
    assert len(cands) == 4 == live.AUTO_BUILD_MAX
    assert cands == ["2026-east-fork-aaaaaa", "2026-kickapoo-creek-1e1e1e", "2026-pine-e1e2e3", "2026-glades-9c9c9c"]
    assert "2026-small-bbbbbb" not in cands                    # 99 ac: under the 100 ac rule
    assert "2026-quiet-cccccc" not in cands                    # every detection older than 48 h
    assert any(f.record_source == "wfigs" for f in fires if f.id in cands)


def test_cycle_uses_the_national_feeds(monkeypatch: pytest.MonkeyPatch) -> None:
    import fire3d.catalog as catalog

    calls: list[tuple[str, float]] = []
    feed = pd.DataFrame({"t_ms": [now_ms() - HOUR_MS] * 3, "lat": [31.0, 21.3, 34.2], "lon": [-97.6, -157.8, -118.1]})

    def fake_us(days=7, **k):
        calls.append(("us", days))
        return feed

    monkeypatch.setattr(firms, "load_live_us", fake_us)
    monkeypatch.setattr(catalog, "get_catalog", lambda *a, **k: [_summary("2026-x-abcdef", 31.0, -97.6, 500)])
    monkeypatch.setattr(catalog, "live_detections_24h_us_total", lambda refresh=False: None)
    monkeypatch.setattr(catalog, "live_detections_24h_total", lambda refresh=False: None)
    summaries, dets = live.fetch_cycle_data()
    assert calls == [("us", 7)] and dets is feed and summaries[0].id == "2026-x-abcdef"
    assert live.detections_24h_us(dets) == 2                    # TX + CA inside the state polygons; HI not
    assert live.detections_24h_ca(dets) == 1
    assert live.detections_24h_us() == 2 and calls[-1] == ("us", 1)
    monkeypatch.setattr(catalog, "live_detections_24h_us_total", lambda refresh=False: 140)
    assert live.detections_24h_us() == 140


def test_live_status_reports_national_count(monkeypatch: pytest.MonkeyPatch) -> None:
    from fire3d.contracts import LiveStatus, contract_problems, dump

    monkeypatch.setattr(live.STATE, "detections_24h", 140)
    monkeypatch.setattr(live.STATE, "detections_24h_ca", 12)
    monkeypatch.setattr(live.STATE, "counts_ms", now_ms())
    st = live.live_status()
    assert st.detections_24h == 140 and st.detections_24h_ca == 12
    assert contract_problems(LiveStatus, dump(st)) == []


def test_assign_detections_national_timing() -> None:
    import time

    from fire3d import catalog

    rng = np.random.default_rng(3)
    inc = [(float(rng.uniform(25, 49)), float(rng.uniform(-124, -67)), 8000.0) for _ in range(300)]
    lat, lon = rng.uniform(25, 49, 20000), rng.uniform(-124, -67, 20000)
    t = time.perf_counter()
    c = catalog.assign_detections(inc, lat, lon)
    assert time.perf_counter() - t < 2.0 and c.sum() <= 20000
