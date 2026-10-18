"""api/live.py housekeeping: manifest summaries follow CAL FIRE each cycle; live forecasts are pruned."""

from __future__ import annotations

import os
import time

from fire3d import bundle
from fire3d.api import live
from fire3d.contracts import IncidentSummary
from fire3d.timeutil import HOUR_MS, now_ms
from test_spread_support import make_bundle

UPDATED = 1_792_000_000_000


def _summary(iid: str, **kw) -> IncidentSummary:
    base = dict(id=iid, name="Spread Test Fire", mode="live", year=2026, calfire_uid="abc", started_ms=1, updated_ms=UPDATED,
                contained_ms=None, acres=3160.0, percent_contained=50.0, is_active=True, county="San Diego",
                location="x", admin_unit="y", url=None, lat=33.3, lon=-117.4, detections_24h=0, bundle_status="ready",
                bundle_built_ms=123)
    base.update(kw)
    return IncidentSummary(**base)


def test_sync_live_summaries(tmp_data_dir) -> None:
    root = tmp_data_dir / "incidents"
    a = make_bundle(root, iid="2026-alpha-fire-aaa111", mode="live")
    b = make_bundle(root, iid="2026-bravo-fire-bbb222", mode="live")
    h = make_bundle(root, iid="2025-old-fire-ccc333", mode="historical")
    for d in (a, b, h):
        bundle.update_manifest(d, lambda m: m["summary"].update(acres=3132.0, percent_contained=35.0, is_active=True))
    built_before = bundle.load_manifest(a)["built_ms"]
    looked: list[str] = []

    def lookup(iid):
        looked.append(iid)
        return _summary(iid, is_active=False, percent_contained=100.0, contained_ms=now_ms())

    changed = live.sync_live_summaries([_summary("2026-alpha-fire-aaa111")], lookup=lookup)
    assert sorted(changed) == ["2026-alpha-fire-aaa111", "2026-bravo-fire-bbb222"] and looked == ["2026-bravo-fire-bbb222"]
    ma, mb, mh = (bundle.load_manifest(d) for d in (a, b, h))
    assert ma["summary"]["acres"] == 3160.0 and ma["summary"]["percent_contained"] == 50.0 and ma["summary"]["county"] == "San Diego"
    assert ma["summary"]["mode"] == "live" and ma["summary"]["name"] == "Spread Test Fire" and ma["built_ms"] == built_before
    assert mb["summary"]["is_active"] is False and mb["summary"]["percent_contained"] == 100.0 and mb["mode"] == "live"
    assert mh["summary"]["acres"] == 3132.0                         # historical bundles are never touched
    # nothing new: no writes
    mtime = os.stat(bundle.manifest_path(a)).st_mtime_ns
    assert live.sync_live_summaries([_summary("2026-alpha-fire-aaa111")], lookup=lambda i: None) == []
    assert os.stat(bundle.manifest_path(a)).st_mtime_ns == mtime
    # a failing lookup is skipped, not raised
    assert live.sync_live_summaries([], lookup=lambda i: (_ for _ in ()).throw(RuntimeError("down"))) == []


def _add_run(bdir, run_id: str, issued: int, status: str = "ready") -> None:
    d = bdir / bundle.FORECASTS_DIR / run_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "forecast.json").write_text("{}")
    entry = {"run_id": run_id, "status": status, "issued_ms": issued, "start_ms": issued, "horizon_h": 72,
             "ensemble": "gfs025", "members": 31, "file": f"forecasts/{run_id}/forecast.json"}
    bundle.update_manifest(bdir, lambda m: m.update(forecasts=sorted([*m.get("forecasts", []), entry],
                                                                     key=lambda f: -f["issued_ms"])))


def test_prune_live_forecasts(tmp_data_dir) -> None:
    root = tmp_data_dir / "incidents"
    bdir = make_bundle(root, iid="2026-alpha-fire-aaa111", mode="live")
    now = now_ms()
    for i in range(7):                                             # fc-0 newest ... fc-6 oldest, 3 h apart
        _add_run(bdir, f"fc-{i}", now - i * 3 * HOUR_MS)
    _add_run(bdir, "fc-err", now - 30 * HOUR_MS, status="error")
    _add_run(bdir, "fc-running", now - 40 * HOUR_MS, status="running")
    gone = live.prune_live_forecasts("2026-alpha-fire-aaa111", now=now, grace_s=3600)
    ids = [f["run_id"] for f in bundle.load_manifest(bdir)["forecasts"]]
    assert ids == ["fc-0", "fc-1", "fc-2", "fc-3", "fc-running"]   # 4 newest + running; old ready and error runs dropped
    assert sorted(gone) == ["fc-4", "fc-5", "fc-6", "fc-err"]
    # their directories survive the grace period (an open view keeps working), then go
    assert (bdir / "forecasts" / "fc-6").is_dir()
    old = time.time() - 7200
    for rid in ("fc-4", "fc-5", "fc-6", "fc-err"):
        os.utime(bdir / "forecasts" / rid, (old, old))
    live.prune_live_forecasts("2026-alpha-fire-aaa111", now=now, grace_s=3600)
    left = sorted(p.name for p in (bdir / "forecasts").iterdir())
    assert left == ["fc-0", "fc-1", "fc-2", "fc-3", "fc-running"]
    # runs issued in the last 6 h are kept even beyond 4 (fc-1, fc-2); fc-3 (9 h old) goes once 3 newer runs exist
    for i in range(3):
        _add_run(bdir, f"fc-new{i}", now - 60_000 * (i + 1))
    assert live.prune_live_forecasts("2026-alpha-fire-aaa111", now=now) == ["fc-3"]
    kept = {f["run_id"] for f in bundle.load_manifest(bdir)["forecasts"]}
    assert kept == {"fc-0", "fc-new0", "fc-new1", "fc-new2", "fc-1", "fc-2", "fc-running"}
    hist = make_bundle(root, iid="2025-old-fire-ccc333", mode="historical")
    for i in range(6):
        _add_run(hist, f"fc-h{i}", now - i * 10 * HOUR_MS)
    assert live.prune_live_forecasts("2025-old-fire-ccc333", now=now) == []
    assert len(bundle.load_manifest(hist)["forecasts"]) == 6


def test_sync_skips_unreadable_manifests(tmp_data_dir) -> None:
    root = tmp_data_dir / "incidents"
    a = make_bundle(root, iid="2026-alpha-fire-aaa111", mode="live")
    bad = root / "2026-broken-fire-fff999"
    bad.mkdir()
    (bad / "manifest.json").write_text("{broken")
    assert live.sync_live_summaries([_summary("2026-alpha-fire-aaa111")], lookup=lambda i: None) == ["2026-alpha-fire-aaa111"]
    assert bundle.load_manifest(a)["summary"]["percent_contained"] == 50.0


def test_new_detections_are_counted_after_the_latest_observation() -> None:
    """With now_ms at a quiet pass, detections up to it were already in the data; only later ones trigger a refresh."""
    import pandas as pd

    from fire3d.build import pipeline

    m = {"grid": {"bbox_lonlat": [-118.0, 34.0, -117.0, 35.0]}, "time_range": {"now_ms": 1_000_000_000, "last_detection_ms": 900_000_000}}
    inside_before = pd.DataFrame({"lon": [-117.5], "lat": [34.5], "t_ms": [950_000_000]})
    inside_after = pd.DataFrame({"lon": [-117.5], "lat": [34.5], "t_ms": [1_000_000_000 + 120_000]})
    outside = pd.DataFrame({"lon": [-119.5], "lat": [34.5], "t_ms": [1_000_000_000 + 120_000]})
    assert not pipeline.has_new_detections(m, inside_before)
    assert pipeline.has_new_detections(m, inside_after)
    assert not pipeline.has_new_detections(m, outside) and not pipeline.has_new_detections(m, None)
