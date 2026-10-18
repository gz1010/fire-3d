"""api/live.py: auto-build selection, re-forecast rule, refresh scheduling and the asyncio loop (SPEC 8.7)."""

from __future__ import annotations

import asyncio
import time

import pandas as pd
import pytest

from fire3d import bundle, config
from fire3d.api import live
from fire3d.api.jobs import JobManager
from fire3d.build import pipeline
from fire3d.timeutil import HOUR_MS, now_ms
from test_pipeline_support import FakeBuild, make_summary

LIVE_A = "2026-alpha-fire-aaa111"
LIVE_B = "2026-bravo-fire-bbb222"
LIVE_C = "2026-charlie-fire-ccc333"
LIVE_TINY = "2026-tiny-fire-ddd444"
HIST = "2025-old-fire-eee555"


def _summaries():
    return [
        make_summary(LIVE_A, "live", name="Alpha Fire", lat=34.20, lon=-118.07, acres=900.0, detections_24h=10),
        make_summary(LIVE_B, "live", name="Bravo Fire", lat=37.00, lon=-120.50, acres=5000.0, detections_24h=2),
        make_summary(LIVE_C, "live", name="Charlie Fire", lat=40.00, lon=-122.00, acres=300.0, detections_24h=0),
        make_summary(LIVE_TINY, "live", name="Tiny Fire", lat=35.00, lon=-119.00, acres=40.0, detections_24h=9),
        make_summary(HIST, "historical", name="Old Fire", acres=10000.0),
    ]


@pytest.fixture
def fake(tmp_data_dir, monkeypatch) -> FakeBuild:
    monkeypatch.setattr(live, "STATE", live.LiveState())
    return FakeBuild(_summaries()).install(monkeypatch)


@pytest.fixture
def jm():
    m = JobManager()
    yield m
    m.shutdown()
    assert m.drain(30), "background jobs still running after the test"


def _dets(points):
    """points: (lat, lon, hours ago)."""
    t = now_ms()
    return pd.DataFrame({"lat": [p[0] for p in points], "lon": [p[1] for p in points], "t_ms": [t - int(p[2] * HOUR_MS) for p in points]})


def test_auto_build_candidates(fake):
    s = _summaries()
    dets = _dets([(34.21, -118.06, 2)] * 3 + [(37.01, -120.49, 30)] * 5 + [(40.0, -122.0, 70)] * 9 + [(35.0, -119.0, 1)] * 4)
    # Bravo (5 recent) > Alpha (3); Charlie's detections are older than 48 h; Tiny is < 100 ac; historical excluded
    assert live.auto_build_candidates(s, dets) == [LIVE_B, LIVE_A]
    assert live.auto_build_candidates(s, dets, limit=1) == [LIVE_B]
    # without the feed, the catalog's 24 h counts decide (Charlie has none)
    assert live.auto_build_candidates(s, None) == [LIVE_A, LIVE_B]


def test_needs_forecast():
    now = now_ms()
    before = {"stats": {"final_acres_observed": 1000.0}}
    fresh = {"stats": {"final_acres_observed": 1010.0}, "forecasts": [{"status": "ready", "issued_ms": now - HOUR_MS}]}
    assert live.needs_forecast(before, fresh, now) is False
    assert live.needs_forecast(before, dict(fresh, stats={"final_acres_observed": 1030.0}), now) is True
    old = dict(fresh, forecasts=[{"status": "ready", "issued_ms": now - 4 * HOUR_MS}, {"status": "error", "issued_ms": now}])
    assert live.needs_forecast(before, old, now) is True
    assert live.needs_forecast(before, dict(fresh, forecasts=[]), now) is True


def test_schedule_refreshes_and_reforecast(fake, jm):
    m = pipeline.build_incident(LIVE_A)
    w, s, e, n = m.grid.bbox_lonlat
    inside = ((s + n) / 2, (w + e) / 2)
    # nothing new -> nothing queued
    assert live.schedule_refreshes(jm, _summaries(), _dets([(inside[0], inside[1], 30)])) == []
    # a new detection inside the AOI -> refresh job; same burned area + fresh forecast -> no new forecast
    queued = live.schedule_refreshes(jm, _summaries(), _dets([(inside[0], inside[1], 0)]))
    assert queued == [LIVE_A]
    job = jm.list(LIVE_A)[-1]
    done = jm.wait(job.id, 15)
    assert done.kind == "refresh" and done.status == "done" and done.result["changed"] is True and done.result["forecast_job"] is None
    assert fake.calls["observed"] == 2 and fake.calls["forecast"] == 1
    # the fire grew > 2 %: the refresh queues a forecast job (forecast pool)
    fake.growth_h = 10.0
    live.schedule_refreshes(jm, _summaries(), _dets([(inside[0], inside[1], 0)]))
    done = jm.wait(jm.list(LIVE_A)[-1].id, 15)
    fx_id = done.result["forecast_job"]
    assert fx_id and jm.wait(fx_id, 15).result["run_id"] == "fx-002"
    # incidents that dropped off the live list are not refreshed
    assert live.schedule_refreshes(jm, [s_ for s_ in _summaries() if s_.id != LIVE_A], _dets([(inside[0], inside[1], 0)])) == []


def test_stale_bundles_refresh_without_new_detections(fake, jm):
    pipeline.build_incident(LIVE_A)
    bdir = bundle.bundle_dir(LIVE_A)
    bundle.update_manifest(bdir, lambda m: m.__setitem__("built_ms", now_ms() - 4 * HOUR_MS))
    assert live.schedule_refreshes(jm, _summaries(), None) == [LIVE_A]
    done = jm.wait(jm.list(LIVE_A)[-1].id, 15)
    assert done.result["changed"] is True and bundle.load_manifest(bdir)["built_ms"] > now_ms() - HOUR_MS


def test_loop_runs_cycles_and_auto_builds(fake, jm, monkeypatch):
    monkeypatch.setattr(config, "AUTO_BUILD_LIVE", True)
    monkeypatch.setattr(live, "AUTO_BUILD_POLL_S", 0.05)
    dets = _dets([(34.21, -118.06, 1)] * 4 + [(37.01, -120.49, 1)] * 2)
    cycles = {"n": 0}

    def fetch():
        cycles["n"] += 1
        if cycles["n"] == 2:
            raise ConnectionError("CAL FIRE down for a moment")
        return _summaries(), dets

    monkeypatch.setattr(live, "fetch_cycle_data", fetch)

    async def main():
        task = asyncio.create_task(live.live_refresh_loop(jm, interval_s=0.2))
        deadline = time.time() + 20
        while time.time() < deadline:
            await asyncio.sleep(0.05)
            built = [i for i in (LIVE_A, LIVE_B) if (bundle.load_manifest(bundle.bundle_dir(i)) or {}).get("status") == "ready"]
            if len(built) == 2 and cycles["n"] >= 3:
                break
        st = live.live_status()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return st

    st = asyncio.run(main())
    assert st.auto_build is True and st.next_refresh_ms is not None and st.active_incidents == 4
    assert st.detections_24h_ca == 1234 and st.last_refresh_ms is not None      # catalog's 24 h-feed total
    assert live.STATE.auto_build_ids == [LIVE_A, LIVE_B] and live.STATE.running is False
    assert cycles["n"] >= 3                                                 # survived the failing cycle
    for iid in (LIVE_A, LIVE_B):
        assert bundle.load_manifest(bundle.bundle_dir(iid))["status"] == "ready"
    assert live.live_status().next_refresh_ms is None


def test_live_status_without_loop(fake, monkeypatch):
    st = live.live_status()
    assert st.last_refresh_ms is None and st.next_refresh_ms is None and st.auto_build is False
    if live._counts_thread is not None:
        live._counts_thread.join(5)
    st = live.live_status()
    assert st.active_incidents == 4 and st.detections_24h_ca == 1234


def test_detections_24h_ca_fallbacks(monkeypatch):
    import fire3d.catalog as catalog

    monkeypatch.setattr(catalog, "live_detections_24h_total", lambda refresh=False: 77, raising=False)
    assert live.detections_24h_ca() == 77
    monkeypatch.setattr(catalog, "live_detections_24h_total", lambda refresh=False: None, raising=False)
    assert live.detections_24h_ca(_dets([(34.0, -118.0, 2), (34.0, -118.0, 30)])) == 1
