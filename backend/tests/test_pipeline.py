"""build/pipeline.py: build orchestration, weighted progress, error handling, peak wind, live refresh, locks."""

from __future__ import annotations

import threading

import numpy as np
import pandas as pd
import pytest

from fire3d import bundle, config
from fire3d.build import pipeline
from fire3d.contracts import IncidentManifest, contract_problems
from fire3d.timeutil import HOUR_MS, floor_hour_ms, now_ms
from test_pipeline_support import FAKE_KEY, FakeBuild, make_summary

HIST_ID = "2025-test-fire-abc123"
LIVE_ID = "2026-live-fire-def456"


@pytest.fixture
def fake(tmp_data_dir, monkeypatch) -> FakeBuild:
    fb = FakeBuild([make_summary(HIST_ID, "historical"), make_summary(LIVE_ID, "live", name="Live Fire", detections_24h=40)])
    return fb.install(monkeypatch)


def _collect():
    events: list[tuple[str, float, str]] = []
    return events, lambda step, f, msg="": events.append((step, f, msg))


def test_historical_build_end_to_end(fake):
    events, progress = _collect()
    m = pipeline.build_incident(HIST_ID, progress=progress)
    assert isinstance(m, IncidentManifest)
    assert m.status == "ready" and m.mode == "historical" and m.built_ms > 0
    assert m.summary.bundle_status == "ready" and m.summary.bundle_built_ms == m.built_ms
    raw = bundle.load_manifest(bundle.bundle_dir(HIST_ID))
    assert contract_problems(IncidentManifest, raw) == []
    assert {"elevation", "fuel", "canopy_cover", "canopy_height", "observed_arrival", "naip", "sky_view", "water", "trees"} <= set(m.layers)
    assert m.time_origin_ms == floor_hour_ms(m.summary.started_ms) - HOUR_MS
    assert m.fuels_edition == "LF2024" and m.forecasts == []            # no automatic forecast for historical builds
    assert any(ds.name == "CAL FIRE incidents" for ds in m.data_sources)
    # progress: monotone, every historical stage, ends at 1.0, no forecast stage
    fr = [f for _, f, _ in events]
    assert fr == sorted(fr) and fr[-1] == 1.0
    stages = {s for s, _, _ in events}
    assert set(pipeline.STATIC_STAGES) | {"catalog", "observations", "weather", "behavior"} <= stages
    assert "forecast" not in stages
    assert fake.calls["forecast"] == 0 and fake.calls["annotate"] == 1
    # static layers saw a preliminary end time (contained_ms) and no now_ms (= wall clock) before build_observed ran
    assert fake.ctx_end_ms[0] == make_summary(HIST_ID).contained_ms and fake.ctx_now_ms[0] is None


def test_peak_wind_event_uses_growth_hours(fake):
    pipeline.build_incident(HIST_ID)
    bdir = bundle.bundle_dir(HIST_ID)
    events = bundle.read_json(bdir / "events.json")["events"]
    peaks = [e for e in events if e["type"] == "peak_wind"]
    assert len(peaks) == 1
    ev = peaks[0]
    assert ev["t_ms"] == fake.peak_t                 # 22 m/s during growth, not the 35 m/s gust after the fire stopped
    assert "49 mph" in ev["detail"] and "NE" in ev["detail"]
    assert "x" in ev and "z" in ev and ev["confidence"] == "estimated"
    assert [e["t_ms"] for e in events] == sorted(e["t_ms"] for e in events)
    # re-running replaces the event instead of duplicating it
    pipeline.add_peak_wind_event(bdir)
    assert sum(e["type"] == "peak_wind" for e in bundle.read_json(bdir / "events.json")["events"]) == 1


def test_live_build_runs_forecast(fake):
    events, progress = _collect()
    m = pipeline.build_incident(LIVE_ID, progress=progress)
    assert m.status == "ready" and m.mode == "live" and m.fuels_edition == "LF2025"
    assert fake.calls["forecast"] == 1 and fake.forecast_args[0]["ensemble"] == "auto"
    assert abs(fake.ctx_now_ms[0] - now_ms()) < 60_000                    # live: wall clock before observed
    assert len(m.forecasts) == 1 and m.forecasts[0].ensemble == "gfs025"
    stages = [s for s, _, _ in events]
    assert "forecast" in stages and stages[-1] == "forecast"
    fr = [f for _, f, _ in events]
    assert fr == sorted(fr) and fr[-1] == 1.0
    # observed arrival never after now_ms in a live bundle
    bdir = bundle.bundle_dir(LIVE_ID)
    arr = bundle.read_layer(bdir, "observed_arrival")
    now_h = (m.time_range.now_ms - m.time_origin_ms) / HOUR_MS
    assert arr[arr < config.NEVER].max() <= now_h + 1e-3


def test_ready_bundle_is_not_rebuilt_without_force(fake):
    pipeline.build_incident(HIST_ID)
    calls = dict(fake.calls)
    events, progress = _collect()
    m = pipeline.build_incident(HIST_ID, progress=progress)
    assert m.status == "ready"
    assert fake.calls["static"] == calls["static"] and fake.calls["get_summary"] == calls["get_summary"]
    assert events and events[-1][1] == 1.0


def test_force_rebuild_clears_previous_outputs(fake):
    m1 = pipeline.build_incident(HIST_ID)
    bdir = bundle.bundle_dir(HIST_ID)
    stray = bdir / "layers" / "stale_layer.bin"
    stray.write_bytes(b"old")
    (bdir / "forecasts" / "fx-009").mkdir(parents=True)
    m2 = pipeline.build_incident(HIST_ID, force=True)
    assert m2.status == "ready" and m2.built_ms >= m1.built_ms
    assert not stray.exists() and not (bdir / "forecasts" / "fx-009").exists()
    assert fake.calls["static"] == 2


def test_required_step_failure_marks_error_and_masks_secrets(fake, monkeypatch):
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", FAKE_KEY)
    fake.fail["observed"] = RuntimeError(f"FIRMS failed: https://firms.modaps.eosdis.nasa.gov/api/area/csv/{FAKE_KEY}/VIIRS_SNPP_SP/1,2,3,4/5/2025-01-01")
    with pytest.raises(RuntimeError):
        pipeline.build_incident(HIST_ID)
    m = bundle.load_manifest(bundle.bundle_dir(HIST_ID))
    assert m["status"] == "error" and m["summary"]["bundle_status"] == "error"
    text = " ".join(m["warnings"])
    assert "Build failed" in text and "***" in text and FAKE_KEY not in text
    assert FAKE_KEY not in (bundle.bundle_dir(HIST_ID) / "manifest.json").read_text()


def test_optional_step_failures_only_warn(fake):
    fake.fail["annotate"] = ValueError("behaviour broke")
    fake.fail["forecast"] = RuntimeError("ensemble API down")
    m = pipeline.build_incident(LIVE_ID)
    assert m.status == "ready"
    assert any("behaviour annotation skipped" in w for w in m.warnings)
    assert any("Live forecast failed" in w and "ensemble API down" in w for w in m.warnings)


def test_bbox_failure_falls_back_to_acres(fake):
    fake.fail["bbox"] = ConnectionError("perimeter service down")
    m = pipeline.build_incident(HIST_ID)
    assert m.status == "ready" and any("Fire extent estimate failed" in w for w in m.warnings)
    assert m.grid.extent_m >= config.AOI_MIN_EXTENT_M["historical"]


def test_unknown_incident_raises_lookup(fake):
    with pytest.raises(LookupError):
        pipeline.build_incident("2025-nope-000000")
    with pytest.raises(ValueError):
        pipeline.build_incident("../etc")


def test_build_waits_for_lock_then_gives_up(fake, monkeypatch):
    monkeypatch.setattr(pipeline, "BUILD_LOCK_TIMEOUT_S", 0.5)
    bdir = bundle.bundle_dir(HIST_ID)
    events, progress = _collect()
    with pipeline.bundle_lock(bdir):
        assert pipeline.build_in_progress(bdir)
        with pytest.raises(pipeline.BundleBusy):
            pipeline.build_incident(HIST_ID, progress=progress)
    assert any("waiting for another build" in msg for _, _, msg in events)
    assert not pipeline.build_in_progress(bdir)


def test_build_progress_maps_static_substeps():
    seen: list[tuple[str, float]] = []
    prog = pipeline.BuildProgress(lambda s, f, m: seen.append((s, f)), pipeline._stage_weights("historical"))
    fn = prog.static_fn()
    for step in ("Fetching DEM", "sky-view factor", "LANDFIRE FBFM40", "NAIP imagery", "water mask", "tree placement", "Sentinel-2 dNBR", "mystery step"):
        fn(step, 1.0, "")
    stages = [s for s, _ in seen]
    assert stages[:7] == ["terrain", "terrain", "fuels", "imagery", "imagery", "trees", "burn_scar"]
    assert stages[7] == "burn_scar"                       # unknown names stay in the current stage
    assert [f for _, f in seen] == sorted(f for _, f in seen)
    total = sum(pipeline._stage_weights("historical").values())
    assert seen[-1][1] == pytest.approx(prog.start["burn_scar"] + prog.weights["burn_scar"], abs=1e-4)
    assert total == pytest.approx(1.0 - pipeline.STAGE_WEIGHTS["forecast"])


def test_refresh_live(fake):
    m0 = pipeline.build_incident(LIVE_ID)
    bdir = bundle.bundle_dir(LIVE_ID)
    lon, lat = (m0.grid.bbox_lonlat[0] + m0.grid.bbox_lonlat[2]) / 2, (m0.grid.bbox_lonlat[1] + m0.grid.bbox_lonlat[3]) / 2
    old = pd.DataFrame({"t_ms": [m0.time_range.now_ms - HOUR_MS], "lat": [lat], "lon": [lon]})
    assert pipeline.refresh_live(LIVE_ID, detections=old) is False
    far = pd.DataFrame({"t_ms": [now_ms()], "lat": [lat + 2.0], "lon": [lon]})
    assert pipeline.refresh_live(LIVE_ID, detections=far) is False
    new = pd.DataFrame({"t_ms": [now_ms()], "lat": [lat], "lon": [lon]})
    obs_before, fx_before = fake.calls["observed"], fake.calls["forecast"]
    events, progress = _collect()
    assert pipeline.refresh_live(LIVE_ID, progress=progress, detections=new) is True
    assert fake.calls["observed"] == obs_before + 1 and fake.calls["forecast"] == fx_before   # the live loop decides on forecasts
    m1 = bundle.load_manifest(bdir)
    assert m1["status"] == "ready" and m1["built_ms"] >= m0.built_ms and m1["summary"]["bundle_built_ms"] == m1["built_ms"]
    assert contract_problems(IncidentManifest, m1) == []
    assert [f for _, f, _ in events] == sorted(f for _, f, _ in events)
    # busy bundle, historical bundle and missing bundle are skipped
    with pipeline.bundle_lock(bdir, shared=True):
        assert pipeline.refresh_live(LIVE_ID, detections=new) is False
    pipeline.build_incident(HIST_ID)
    assert pipeline.refresh_live(HIST_ID, force=True) is False
    assert pipeline.refresh_live("2026-missing-000000", force=True) is False


def test_refresh_failure_keeps_bundle_ready(fake, monkeypatch):
    pipeline.build_incident(LIVE_ID)
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", FAKE_KEY)
    fake.fail["weather"] = RuntimeError(f"weather down MAP_KEY={FAKE_KEY}")
    with pytest.raises(RuntimeError):
        pipeline.refresh_live(LIVE_ID, force=True)
    m = bundle.load_manifest(bundle.bundle_dir(LIVE_ID))
    assert m["status"] == "ready"
    assert any(w.startswith("Live refresh failed") and FAKE_KEY not in w for w in m["warnings"])
    del fake.fail["weather"]                                    # the next successful refresh clears the warning
    assert pipeline.refresh_live(LIVE_ID, force=True) is True
    assert not any(w.startswith("Live refresh failed") for w in bundle.load_manifest(bundle.bundle_dir(LIVE_ID))["warnings"])


def test_run_forecast_locked_requires_ready_bundle(fake):
    with pytest.raises(RuntimeError):
        pipeline.run_forecast_locked(HIST_ID)
    pipeline.build_incident(HIST_ID)
    fm = pipeline.run_forecast_locked(HIST_ID, start_ms=None, horizon_h=24, ensemble="perturbed", members=5)
    assert fm.run_id == "fx-001" and fake.forecast_args[-1] == {"start_ms": None, "horizon_h": 24, "ensemble": "perturbed", "members": 5}


def test_forecast_waits_for_build_lock(fake, monkeypatch):
    pipeline.build_incident(HIST_ID)
    monkeypatch.setattr(pipeline, "FORECAST_LOCK_TIMEOUT_S", 0.3)
    with pipeline.bundle_lock(bundle.bundle_dir(HIST_ID)):
        with pytest.raises(pipeline.BundleBusy):
            pipeline.run_forecast_locked(HIST_ID)


def test_concurrent_builds_of_one_incident_are_serialised(fake):
    """Two threads building the same incident: one builds, the other waits and returns the ready bundle."""
    results: list[IncidentManifest] = []
    threads = [threading.Thread(target=lambda: results.append(pipeline.build_incident(HIST_ID))) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert len(results) == 2 and all(r.status == "ready" for r in results)
    assert fake.calls["static"] == 1


def test_short_error_masks_and_truncates(monkeypatch):
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", FAKE_KEY)
    msg = pipeline.short_error(RuntimeError(f"bad {FAKE_KEY} " + "x" * 500))
    assert FAKE_KEY not in msg and "***" in msg and len(msg) <= pipeline.ERROR_MAX_CHARS
    assert pipeline.short_error(LookupError("unknown incident 'x'")) == "unknown incident 'x'"


def test_stats_fallback_when_observed_omits_them(fake, monkeypatch):
    orig = fake.build_observed

    def observed_without_stats(ctx):
        orig(ctx)

        def drop(m: dict) -> None:
            m.pop("stats", None)

        bundle.update_manifest(ctx.bundle_dir, drop)

    import fire3d.build.observed as observed

    monkeypatch.setattr(observed, "build_observed", observed_without_stats)
    m = pipeline.build_incident(HIST_ID)
    arr = bundle.read_layer(bundle.bundle_dir(HIST_ID), "observed_arrival")
    expected = np.count_nonzero(arr < config.NEVER) * m.grid.fire.res_m ** 2 / config.ACRE_M2
    assert m.stats.final_acres_observed == pytest.approx(expected, rel=1e-3) and m.stats.detections == 1


def test_bundle_only_incidents_are_never_rebuilt(fake):
    """catalog.get_summary also answers from bundle manifests (fixtures): such ids must not be (re)built/refreshed."""
    pipeline.build_incident(LIVE_ID)
    bdir = bundle.bundle_dir(LIVE_ID)
    copy_id = "fixture-copy"
    cdir = bundle.bundle_dir(copy_id)
    cdir.mkdir(parents=True)
    m = bundle.load_manifest(bdir)
    m["id"] = m["summary"]["id"] = copy_id
    bundle.save_manifest(cdir, m)
    fake.summaries[copy_id] = make_summary(LIVE_ID, "live", name="Live Fire").model_copy(update={"id": copy_id})
    assert not pipeline.is_catalog_incident(copy_id, fake.summaries[copy_id])
    assert pipeline.is_catalog_incident(LIVE_ID, fake.summaries[LIVE_ID])
    with pytest.raises(LookupError, match="cannot be"):
        pipeline.build_incident(copy_id, force=True)
    assert pipeline.build_incident(copy_id).status == "ready"              # not forced: served as is
    assert pipeline.refresh_live(copy_id, force=True) is False
    assert bundle.load_manifest(cdir) == m
