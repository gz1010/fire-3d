"""build/live_observation.py: the latest observation of a live fire (quiet satellite passes), the CAL FIRE veto,
activity markers, and the forecast helpers built on them."""

from __future__ import annotations

import numpy as np
import pandas as pd

from fire3d.build import live_observation as lo
from fire3d.sources import overpass

H = 3_600_000
T0 = 1_792_000_000_000 // H * H
LAST = T0                                 # last detection
ALL_SATS = {"N": T0 + 30 * H, "N20": T0 + 30 * H, "N21": T0 + 30 * H, "Terra": T0 + 30 * H, "Aqua": T0 + 30 * H}


def _p(t_ms: int, sat: str = "N21", dn: str = "N", published: int | None = None) -> overpass.Pass:
    prod = overpass.PRODUCT_BY_SATELLITE[sat]
    return overpass.Pass(t_ms, t_ms + 6 * 60_000, sat, prod.instrument, prod.label, dn,
                         published if published is not None else t_ms + 2 * H, "test")


def _fetch(passes, errors=()):
    def fetch(lon, lat, start, end, nrt=True):
        assert nrt and start <= LAST - lo.LOOKBACK_MS + H
        return overpass.PassList([p for p in passes if start <= p.t_ms <= end], errors, T0 + 29 * H, "test")
    return fetch


def test_quiet_passes_move_the_latest_observation() -> None:
    passes = [_p(LAST, "N21", "D"), _p(LAST + 11 * H, "N20"), _p(LAST + 12 * H, "N"), _p(LAST + 23 * H, "N21", "D")]
    obs = lo.latest_observation(LAST + 3 * 60_000, (-117.4, 33.3), [LAST + 3 * 60_000], ["N21"], ALL_SATS, T0 + 30 * H,
                                fetch=_fetch(passes))
    assert obs.rule == "latest_pass" and obs.now_ms == LAST + 23 * H and obs.last_pass_ms == LAST + 23 * H
    assert obs.last_detection_ms == LAST + 3 * 60_000 and obs.quiet_passes == 3
    assert obs.passes[-1]["detections"] == 1 and obs.passes[0]["detections"] == 0       # newest first
    assert "23 h after the last detection" in obs.note and obs.source["name"] == lo.SOURCE_NAME and not obs.warnings
    doc = obs.activity_doc([])
    assert doc["rule"] == "latest_pass" and doc["now_ms"] == obs.now_ms and doc["markers"] == []


def test_unconfirmed_and_unknown_satellites_are_ignored() -> None:
    late = _p(LAST + 20 * H, "N", published=T0 + 29 * H + 30 * 60_000 + 1)   # published < 30 min before our FIRMS fetch
    no_data = _p(LAST + 22 * H, "Aqua", "D")                          # FIRMS data for Aqua failed / missing
    ok = _p(LAST + 10 * H, "N20")
    sats = {k: v for k, v in ALL_SATS.items() if k != "Aqua"}
    obs = lo.latest_observation(LAST, (-117.4, 33.3), [], [], sats, T0 + 30 * H, fetch=_fetch([late, no_data, ok]))
    assert obs.now_ms == LAST + 10 * H and obs.quiet_passes == 1
    assert "no FIRMS data time for Aqua MODIS" in obs.source["detail"]


def test_cmr_unavailable_keeps_the_last_detection() -> None:
    obs = lo.latest_observation(LAST, (-117.4, 33.3), [], [], ALL_SATS, T0 + 30 * H,
                                fetch=_fetch([], errors=["VNP14IMG_NRT v2: boom"] * 5))
    assert obs.rule == "last_detection" and obs.now_ms == LAST and obs.last_pass_ms is None
    assert obs.warnings and "unavailable" in obs.warnings[0] and obs.source["detail"].startswith("unavailable")

    def broken(*a, **k):
        raise RuntimeError("socket gone")

    obs2 = lo.latest_observation(LAST, (-117.4, 33.3), [], [], ALL_SATS, T0 + 30 * H, fetch=broken)
    assert obs2.now_ms == LAST and "socket gone" in obs2.note


def test_no_later_pass_or_pass_before_detection() -> None:
    obs = lo.latest_observation(LAST + 5 * 60_000, (-117.4, 33.3), [LAST + 5 * 60_000], ["N21"], ALL_SATS, T0 + 30 * H,
                                fetch=_fetch([_p(LAST, "N21", "D")]))
    assert obs.rule == "last_detection" and obs.now_ms == LAST + 5 * 60_000 and obs.last_pass_ms == LAST
    assert "no confirmed satellite pass over the fire since the last detection" in obs.note and not obs.warnings


def test_cal_fire_acreage_veto() -> None:
    passes = [_p(LAST + 12 * H, "N20")]
    kw = dict(fetch=_fetch(passes), mapped_acres=1000.0)
    grown = lo.latest_observation(LAST, (-117.4, 33.3), [], [], ALL_SATS, T0 + 30 * H, official_acres=1500.0,
                                  official_updated_ms=LAST + 5 * H, **kw)
    assert grown.rule == "last_detection" and grown.now_ms == LAST and grown.vetoed and grown.warnings
    assert "grew without being detected" in grown.note
    # older report, or acreage within 1.25 x + 100 ac: no veto
    old = lo.latest_observation(LAST, (-117.4, 33.3), [], [], ALL_SATS, T0 + 30 * H, official_acres=1500.0,
                                official_updated_ms=LAST - 2 * H, **kw)
    close = lo.latest_observation(LAST, (-117.4, 33.3), [], [], ALL_SATS, T0 + 30 * H, official_acres=1340.0,
                                  official_updated_ms=LAST + 5 * H, **kw)
    assert old.rule == close.rule == "latest_pass" and old.now_ms == LAST + 12 * H


def _frame(rows):
    return pd.DataFrame(rows, columns=["t_ms", "x", "z", "instrument", "confidence", "satellite"])


def test_activity_markers() -> None:
    m, res = 40, 50.0                                  # 2 km square, centre at (0, 0)
    burned = np.zeros((m, m), dtype=bool)
    burned[15:25, 15:25] = True                        # 500 m square around the centre
    half = m * res / 2
    near = (0.0 + 300.0, 0.0)                          # inside / next to the burned area
    far = (half - 10.0, half - 10.0)                   # ~1.2 km from it
    rows = [
        (LAST + H, *near, "VIIRS", "l", "N"),          # low confidence near the fire -> marker
        (LAST + H, *far, "VIIRS", "l", "N"),           # too far
        (LAST + H, *near, "VIIRS", "n", "N"),          # nominal: a real detection, not a marker
        (LAST - H, *near, "VIIRS", "l", "N"),          # before the last detection
        (LAST + 2 * H, 200.0, 0.0, "MODIS", "20", "Aqua"),   # low-confidence MODIS -> marker with 500 m radius
        (LAST + 2 * H, -450.0, -450.0, "VIIRS", "l", "N20"),  # at a static hot spot -> dropped
    ]
    goes = pd.DataFrame({"t_ms": [LAST + 3 * H, LAST + 3 * H + 10 * 60_000, LAST + 9 * H],
                         "x": [0.0, 50.0, 0.0], "z": [0.0, 0.0, 0.0], "satellite": ["G18"] * 3})
    out = lo.activity_markers(_frame(rows), goes, burned, res, LAST, LAST + 10 * H, np.array([[-450.0, -450.0]]))
    kinds = [(mk["kind"], mk["t_ms"]) for mk in out]
    assert kinds == [("viirs_low_confidence", LAST + H), ("modis_low_confidence", LAST + 2 * H),
                     ("goes", LAST + 3 * H), ("goes", LAST + 3 * H + 10 * 60_000)]   # lone GOES scan at +9 h dropped
    assert out[1]["radius_m"] == lo.MODIS_MARKER_RADIUS_M and out[2]["radius_m"] == lo.GOES_MARKER_RADIUS_M
    arr = lo.marker_array({"markers": out})
    assert arr.shape == (4, 4) and arr[0, 3] == 0.0
    assert lo.marker_array({"markers": []}) is None and lo.marker_array(None) is None
    doc = {"last_detection_ms": LAST, "markers": out}
    assert lo.last_activity_ms(doc) == LAST + 3 * H + 10 * 60_000 and lo.last_activity_ms(None) is None


def test_describe_start_and_official() -> None:
    doc = {"last_detection_ms": LAST, "rule": "latest_pass", "now_ms": LAST + 20 * H, "quiet_passes": 7}
    note = lo.describe_start(doc, LAST + 20 * H)
    assert "latest satellite pass" in note and "20 h after the last detection" in note and "7 confirmed" in note
    assert lo.describe_start(doc, LAST) is None and lo.describe_start(None, LAST) is None
    other = lo.describe_start({**doc, "rule": "last_detection"}, LAST + 5 * H)
    assert "5 h after the last detection" in other
    assert lo.official_from({"acres": 10, "updated_ms": 5}) == (10.0, 5)


def test_build_observed_live_with_quiet_passes(tmp_data_dir, monkeypatch):
    """End to end on the synthetic scenario: confirmed passes after the last detection move now_ms; the burned area
    stays at the last detection; sim/activity.json, the CMR data source and the new time_range fields are written."""
    from fire3d import bundle
    from fire3d.build import observed as obs
    from fire3d.contracts import TimeRange, TimeseriesFile, contract_problems
    from fire3d.sources import firms
    from test_observed import HOUR_MS, NEVER, STARTED, Scenario

    sc = Scenario(mode="live", hours=26.0).install(monkeypatch)
    now = STARTED + 40 * HOUR_MS                            # the fire stopped growing ~14 h before "now"
    monkeypatch.setattr(obs, "now_ms", lambda: now)
    seen: dict = {}

    def fetch(lon, lat, start, end, nrt=True):
        seen["args"] = (lon, lat, start, end)
        last = seen["last"] = start + lo.LOOKBACK_MS
        return overpass.PassList([_p(last + 6 * H, "N20"), _p(last + 9 * H, "N", "D"), _p(now - H, "N21", "D", published=now - 10 * 60_000)],
                                 [], now, "test")

    monkeypatch.setattr(overpass, "fetch_passes", fetch)
    monkeypatch.setattr(firms, "data_times_by_satellite", lambda df, kinds=("NRT",): {s: now for s in ALL_SATS})
    ctx = sc.context(now=now)
    obs.build_observed(ctx)
    bdir = ctx.bundle_dir
    m = bundle.load_manifest(bdir)
    tr = m["time_range"]
    dets = bundle.read_json(bdir / "detections.json")["detections"]
    last_spatial = max(d["t_ms"] for d in dets if d["instrument"] != "GOES")
    assert tr["last_detection_ms"] == last_spatial == seen["last"]
    assert tr["now_ms"] == tr["end_ms"] == last_spatial + 9 * H      # the N21 pass 1 h ago is not confirmed yet
    assert tr["last_pass_ms"] == tr["now_ms"]
    T = bundle.read_layer(bdir, "observed_arrival", m)
    assert T[T < NEVER].max() <= (last_spatial - sc.origin) / HOUR_MS + 1e-3     # no growth after the last detection
    ts = bundle.read_json(bdir / "timeseries.json")
    assert ts["t_ms"][-1] <= tr["now_ms"] < ts["t_ms"][-1] + HOUR_MS
    after = [a for t, a in zip(ts["t_ms"], ts["area_acres"]) if t >= last_spatial + HOUR_MS]
    assert len(after) >= 8 and max(after) == min(after)          # flat from the last detection to now
    act = bundle.read_json(bdir / "sim" / lo.ACTIVITY_FILE)
    assert act["rule"] == "latest_pass" and act["quiet_passes"] == 2 and act["now_ms"] == tr["now_ms"]
    src = [d for d in m["data_sources"] if d["name"] == lo.SOURCE_NAME]
    assert len(src) == 1 and "saw no new fire" in src[0]["detail"]
    assert contract_problems(TimeRange, tr) == []                    # the full manifest is completed by the pipeline
    assert contract_problems(TimeseriesFile, (bdir / "timeseries.json").read_bytes()) == []
    # a refresh replaces (not duplicates) the CMR source entry
    obs.build_observed(sc.context(now=now))
    m2 = bundle.load_manifest(bdir)
    assert sum(1 for d in m2["data_sources"] if d["name"] == lo.SOURCE_NAME) == 1


def test_build_observed_live_switch_off(tmp_data_dir, monkeypatch):
    from fire3d import bundle, config
    from fire3d.build import observed as obs
    from test_observed import HOUR_MS, STARTED, Scenario

    sc = Scenario(mode="live", hours=26.0).install(monkeypatch)
    now = STARTED + 40 * HOUR_MS
    monkeypatch.setattr(obs, "now_ms", lambda: now)
    monkeypatch.setattr(config, "LIVE_START_LATEST_PASS", False)
    monkeypatch.setattr(overpass, "fetch_passes", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no CMR call")))
    ctx = sc.context(now=now)
    obs.build_observed(ctx)
    tr = bundle.load_manifest(ctx.bundle_dir)["time_range"]
    assert "last_detection_ms" not in tr and tr["now_ms"] < now - 10 * HOUR_MS
    assert not (ctx.bundle_dir / "sim" / lo.ACTIVITY_FILE).exists()
