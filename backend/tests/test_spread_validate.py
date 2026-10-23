"""spread/validate.py: Sørensen, skill entries, hindcast_skill on a written forecast, batch hindcast."""

from __future__ import annotations

import numpy as np
import pytest

import fire3d.build.weather_bundle as weather_bundle
from fire3d import config
from fire3d.spread import ensemble, validate
from test_spread_support import ORIGIN, H, make_bundle, make_weather

NEVER = np.float32(config.NEVER)


def test_sorensen() -> None:
    a = np.zeros((4, 4), bool)
    b = np.zeros((4, 4), bool)
    assert validate.sorensen(a, b) == 1.0
    a[0, :] = True
    assert validate.sorensen(a, b) == 0.0
    assert validate.sorensen(a, a) == 1.0
    b[0, :2] = True
    assert validate.sorensen(a, b) == pytest.approx(2 * 2 / (4 + 2))
    with pytest.raises(ValueError):
        validate.sorensen(a, np.zeros((3, 3), bool))


def test_skill_from_arrays() -> None:
    obs = np.full((10, 10), NEVER, np.float32)
    fc = np.full((10, 10), NEVER, np.float32)
    obs[:5, :] = 10.0          # 50 cells burned at 10 h
    obs[5:, :2] = 30.0         # 10 more at 30 h
    fc[:5, :] = 8.0
    fc[5:, :] = 20.0           # 50 more at 20 h
    rows = validate.skill_from_arrays(fc, obs, start_h=5.0, res_m=30.0, lead_hours=(12, 24, 48, 72),
                                      horizon_h=48, data_end_h=40.0, growth=True)
    assert [r["lead_h"] for r in rows] == [12.0, 24.0]                    # 48 h > data end, 72 h > horizon
    r12, r24 = rows
    cell = 900 / config.ACRE_M2
    assert r12["sorensen"] == 1.0 and r12["observed_acres"] == pytest.approx(round(50 * cell, 1))
    assert r24["forecast_acres_p50"] == pytest.approx(round(100 * cell, 1))
    assert r24["sorensen"] == pytest.approx(round(2 * 50 / (50 + 100), 4))
    # growth excludes the area burned by the start (nothing here: start 5 h < 8 h)
    assert r24["sorensen_growth"] == r24["sorensen"]
    plain = validate.skill_from_arrays(fc, obs, 5.0, 30.0)
    assert set(plain[0]) == {"lead_h", "sorensen", "observed_acres", "forecast_acres_p50"}
    assert validate.burned_by(np.array([1.0, 2.0, NEVER]), 2.0).tolist() == [True, True, False]


def test_hindcast_skill_reads_a_written_forecast(tmp_data_dir, monkeypatch) -> None:
    bdir = make_bundle(tmp_data_dir / "incidents", iid="hc-test", m=32, ignition_rc=(16, 8))
    monkeypatch.setattr(weather_bundle, "member_weathers",
                        lambda *a, **k: [make_weather(t0=ORIGIN - 72 * H, hours=300, speed_kmh=v, label=f"m{v}") for v in (5.0, 15.0, 25.0)])
    fm = ensemble.run_forecast(bdir, start_ms=ORIGIN + 6 * H, horizon_h=24, workers=1)
    obs = validate.fbundle.read_layer(bdir, "observed_arrival")
    man = validate.fbundle.load_manifest(bdir)
    rows = validate.hindcast_skill(bdir / "forecasts" / fm.run_id, obs, data_end_ms=man["time_range"]["end_ms"])
    assert [r["lead_h"] for r in rows] == [12.0, 24.0]
    assert rows == [s.model_dump() for s in fm.skill]
    shifted = validate.hindcast_skill(bdir / "forecasts" / fm.run_id, np.where(obs < NEVER, obs + 1.0, NEVER),
                                      time_origin_ms=ORIGIN - H, data_end_ms=man["time_range"]["end_ms"])
    assert shifted == rows                                                # a different origin is shifted back


def test_batch_hindcast_and_report(tmp_data_dir, monkeypatch) -> None:
    b1 = make_bundle(tmp_data_dir / "incidents", iid="fire-a", m=32, ignition_rc=(16, 8))
    b2 = make_bundle(tmp_data_dir / "incidents", iid="fire-b", m=32, ignition_rc=(16, 8), observed=np.full((32, 32), NEVER, np.float32))
    calls = []

    def fake(bundle_dir, start_ms, horizon_h, ens, members=None):
        calls.append(ens)
        return [make_weather(t0=ORIGIN - 72 * H, hours=300, speed_kmh=0.0)]

    monkeypatch.setattr(weather_bundle, "member_weathers", fake)
    rows = validate.batch_hindcast([b1, b2], start_offsets_h=(6.0,), adjustments=(0.5, 2.0), horizon_h=24,
                                   lead_hours=(12, 24), workers=1)
    assert set(calls) == {"none"}
    scored = [r for r in rows if "lead_h" in r and r["incident_id"] == "fire-a"]
    assert len(scored) == 4 and {r["spread_adjustment"] for r in scored} == {0.5, 2.0}
    by = {(r["spread_adjustment"], r["lead_h"]): r for r in scored}
    assert by[(2.0, 12.0)]["forecast_acres_p50"] > 1.5 * by[(0.5, 12.0)]["forecast_acres_p50"]
    assert all(0.0 <= r["sorensen_growth"] <= 1.0 and r["members"] == 1 and r["ensemble"] == "none" for r in scored)
    # fire-b has no burned area at the start: it ignites from its ignition point and is still scored
    assert any(r["incident_id"] == "fire-b" for r in rows)
    summary = validate.summarize_hindcast(rows)
    assert [s["spread_adjustment"] for s in summary] == [0.5, 2.0] and sum(s["best"] for s in summary) == 1
    md = validate.hindcast_markdown(rows, summary)
    assert "| spread_adjustment |" in md and "fire-a" in md and "(best)" in md
    bad = validate.batch_hindcast([tmp_data_dir / "incidents" / "missing"], (6.0,), (1.0,), workers=1)
    assert bad and "error" in bad[0]


def test_cli_parses(monkeypatch, capsys) -> None:
    seen = {}

    def fake_batch(bundles, offsets, adjustments, **kw):
        seen.update(bundles=bundles, offsets=offsets, adjustments=adjustments, **kw)
        return []

    monkeypatch.setattr(validate, "batch_hindcast", fake_batch)
    monkeypatch.setattr(validate, "_bundle_path", lambda ref: ref)
    assert validate.main(["hindcast", "a", "b", "--offsets", "12", "--adjustments", "1", "1.5", "--ensemble", "perturbed"]) == 0
    assert seen["bundles"] == ["a", "b"] and seen["offsets"] == [12.0] and seen["adjustments"] == [1.0, 1.5]
    assert seen["ensemble"] == "perturbed" and "# Hindcast calibration" in capsys.readouterr().out


def test_live_start_check_on_a_synthetic_fire(tmp_data_dir, monkeypatch) -> None:
    """Pseudo-live check: a fire that stops growing at 12 h; passes every 6 h. Issues after the growth stopped get the
    latest-pass variants; the old rule (start at the last detection) predicts more late growth than the new one."""
    import fire3d.build.weather_bundle as weather_bundle
    from fire3d import bundle
    from fire3d.sources import overpass
    from test_spread_support import ORIGIN, H, make_bundle, make_weather

    bdir = make_bundle(tmp_data_dir / "incidents", iid="pseudo-live", m=32, ignition_rc=(16, 10), t_ign_h=2.0, data_end_h=12.0)
    bundle.update_manifest(bdir, lambda m: m["time_range"].update(end_ms=ORIGIN + 30 * H, now_ms=ORIGIN + 30 * H))
    dets = [{"t_ms": ORIGIN + int(t * H), "lat": 0.0, "lon": 0.0, "x": 0.0, "z": 0.0, "frp": 1.0, "satellite": "N",
             "instrument": "VIIRS", "confidence": "n", "daynight": "D", "footprint_m": 375.0} for t in (3, 6, 9, 12)]
    bundle.write_json(bdir / "detections.json", {"detections": dets})
    monkeypatch.setattr(weather_bundle, "member_weathers", lambda *a, **k: [make_weather(t0=ORIGIN - 72 * H, hours=300, speed_kmh=30.0)])

    def passes(lon, lat, start, end, nrt=True):
        assert nrt is False
        ps = [overpass.Pass(ORIGIN + int(t * H), ORIGIN + int(t * H) + 360_000, "N", "VIIRS", "Suomi NPP VIIRS", "D", None, "x")
              for t in range(3, 40, 3)]
        return overpass.PassList(ps, [], None, "test")

    rows = validate.live_start_check([bdir], every_h=6.0, first_h=4.0, latency_h=1.0, leads=(6.0, 12.0), workers=1,
                                     passes_fn=passes)
    assert rows and not [r for r in rows if "error" in r]
    issues = sorted({r["issue_ms"] for r in rows})
    assert issues[0] == ORIGIN + 6 * H                    # ignition (2 h) + 4 h
    quiet = {r["issue_ms"] for r in rows if r["variant"] != "last_detection"}
    assert quiet and min(quiet) >= ORIGIN + 18 * H        # passes after the last detection (12 h) exist from issue 18 h on
    s = validate.summarize_live_check(rows)
    assert s["quiet_issues"] == len(quiet) and s["quiet"]["latest_pass_decay"]["n"] > 0
    q = s["quiet"]
    assert q["latest_pass_decay"]["forecast_growth_acres_mean"] <= q["last_detection"]["forecast_growth_acres_mean"]
    assert s["all"]["old"]["n"] == s["all"]["new"]["n"]


def test_batch_hindcast_absolute_starts_match_offsets(tmp_data_dir, monkeypatch) -> None:
    """Pre-registered absolute UTC starts (docs/validation.md 10.1) give the same runs as the equal offset."""
    from fire3d import bundle

    b1 = make_bundle(tmp_data_dir / "incidents", iid="fire-a", m=32, ignition_rc=(16, 8))

    def fake(bundle_dir, start_ms, horizon_h, ens, members=None):
        return [make_weather(t0=ORIGIN - 72 * H, hours=300, speed_kmh=5.0)]

    monkeypatch.setattr(weather_bundle, "member_weathers", fake)
    t_ign = (bundle.load_manifest(b1).get("ignition") or {}).get("t_ms") or bundle.load_manifest(b1)["summary"]["started_ms"]
    by_off = validate.batch_hindcast([b1], (6.0,), (0.5,), horizon_h=24, lead_hours=(12, 24), workers=1)
    by_abs = validate.batch_hindcast([b1], (), (0.5,), horizon_h=24, lead_hours=(12, 24), workers=1,
                                     start_times_ms=[int(t_ign + 6 * H)])
    strip = lambda rs: [{k: v for k, v in r.items()} for r in rs]
    assert strip(by_abs) == strip(by_off) and by_abs[0]["start_offset_h"] == 6.0


def test_cli_absolute_start_spec(monkeypatch) -> None:
    seen = []

    def fake_batch(bundles, offsets, adjustments, **kw):
        seen.append((bundles, tuple(offsets), kw.get("start_times_ms")))
        return []

    monkeypatch.setattr(validate, "batch_hindcast", fake_batch)
    monkeypatch.setattr(validate, "_bundle_path", lambda ref: ref)
    assert validate.main(["hindcast", "x@2025-08-25T19:30Z,2025-05-13T23:47:56Z", "--adjustments", "0.5"]) == 0
    assert seen == [(["x"], (), [1756150200000, 1747180076000])]
