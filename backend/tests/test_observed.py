"""build/observed.py: observed fire progression (SPEC 8.3), offline.

Pure functions are tested on synthetic grids and snapshots. ``build_observed`` runs end to end on a synthetic fire: an
elliptical wind-driven spread sampled like VIIRS/MODIS/GOES, plus a distant second fire, a static hot spot and two
perimeters. FIRMS and WFIGS are monkeypatched; elevation comes from ``sim/static.npz``.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest
import shapely

from fire3d import bundle, config
from fire3d.build import observed as obs
from fire3d.contracts import (DetectionsFile, EventsFile, IncidentSummary, PerimetersFile, TimeseriesFile, contract_problems,
                              dump)
from fire3d.grid import Grid, make_aoi, manifest_grid
from fire3d.sources import firms
from fire3d.sources import perimeters as wfigs
from fire3d.timeutil import DAY_MS, HOUR_MS, iso_to_ms, time_origin_for
from fire3d.types import BuildContext

NEVER = config.NEVER


# ----------------------------------------------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------------------------------------------
def small_grid(n: int = 120, extent: float = 6000.0) -> Grid:
    return Grid(32611, 400_000.0, 3_785_000.0, extent, n, n)


def disc(grid: Grid, cx: float, cz: float, r: float) -> np.ndarray:
    X, Z = grid.cell_centers_local()
    return np.hypot(X - cx, Z - cz) <= r


def frame(rows: list[dict]) -> pd.DataFrame:
    """FIRMS-normalised DataFrame from dicts with t_ms, lon, lat, instrument (+ optional fields)."""
    defaults = {"frp": 10.0, "satellite": "N20", "confidence": "n", "daynight": "D", "scan": 0.4, "track": 0.4, "type": 0,
                "source": "VIIRS_NOAA20_SP"}
    out = []
    for r in rows:
        d = {**defaults, **r}
        if d["instrument"] == "GOES":
            d.setdefault("satellite", "G18")
            d.update(satellite=r.get("satellite", "G18"), confidence="100", scan=2.0, track=2.0, type=-1, source="GOES_NRT")
        elif d["instrument"] == "MODIS":
            d.update(satellite=r.get("satellite", "Terra"), confidence="80", scan=1.0, track=1.0, source="MODIS_SP")
        elif d["instrument"] == "LANDSAT":
            d.update(satellite="L9", confidence="h", scan=0.03, track=0.03, frp=np.nan, type=-1, source="LANDSAT_NRT")
        out.append(d)
    df = pd.DataFrame(out, columns=list(firms.FIRMS_COLUMNS)) if out else firms.empty_frame()
    return df.astype({"t_ms": "int64", "frp": "float64", "scan": "float64", "track": "float64", "type": "int64"})


def det_frame(grid: Grid, rows: list[dict]) -> pd.DataFrame:
    """Like :func:`frame` but rows give local x/z; returns prepared detections (local coords, footprints)."""
    full = []
    for r in rows:
        lon, lat = grid.local_to_lonlat(r["x"], r["z"])
        full.append({**{k: v for k, v in r.items() if k not in ("x", "z")}, "lon": lon, "lat": lat})
    return obs.prepare_detections(frame(full), grid)


# ----------------------------------------------------------------------------------------------------------------
# arrival interpolation
# ----------------------------------------------------------------------------------------------------------------
def test_interpolation_monotone_bounded_and_ignition_time():
    g = small_grid()
    radii = [600.0, 1200.0, 1900.0, 2600.0]
    times = [2.0, 5.0, 9.0, 14.0]
    masks = [disc(g, 0.0, 0.0, r) for r in radii]
    ign = tuple(int(v) for v in np.floor(g.local_to_rowcol(0.0, 0.0)))
    T, k = obs.interpolate_arrival(masks, times, ign, 0.5)
    assert T.dtype == np.float32
    assert T[ign] == pytest.approx(0.5)
    assert np.all(T[~masks[-1]] == NEVER) and np.all(k[~masks[-1]] == -1)
    bounds = [0.5] + times
    for i in range(len(times)):
        sel = k == i
        assert sel.any()
        assert T[sel].min() >= bounds[i] - 1e-4 and T[sel].max() <= bounds[i + 1] + 1e-4
    # monotone along a ray from the ignition and every snapshot is burned by its time
    row = T[ign[0], ign[1]:]
    row = row[row < NEVER]
    assert np.all(np.diff(row) >= -1e-4)
    for m, t in zip(masks, times):
        assert np.all(T[m] <= t + 1e-4)


def test_interpolation_warp_follows_activity():
    g = small_grid()
    masks = [disc(g, 0.0, 0.0, 2000.0)]
    ign = tuple(int(v) for v in np.floor(g.local_to_rowcol(0.0, 0.0)))
    t0 = 1_700_000_400_000                                             # on a 10-min boundary, like GOES scans
    goes = pd.DataFrame({"t_ms": t0 + np.arange(0, 3 * HOUR_MS, 10 * 60_000), "satellite": "G18", "frp": 0.0})
    goes.loc[goes["t_ms"] < t0 + 2 * HOUR_MS, "frp"] = 500.0          # all activity in the first 2 of 10 hours
    act = obs.Activity(goes, t0, t0 + 11 * HOUR_MS)
    assert act.available and act.satellite == "G18"
    warp = lambda ta, tb, r: act.warp(t0 + ta * HOUR_MS, t0 + tb * HOUR_MS, r)
    T_lin, _ = obs.interpolate_arrival(masks, [10.0], ign, 0.0)
    T_w, _ = obs.interpolate_arrival(masks, [10.0], ign, 0.0, warp)
    b = masks[0]
    assert np.median(T_w[b]) < np.median(T_lin[b]) - 2.0             # growth happens while the fire is active
    assert T_w[b].min() >= 0.0 and T_w[b].max() <= 10.0 + 1e-4
    # hourly mean FRP: 500 MW per scan in the first two hours, 0 later
    hrs = t0 + np.array([1, 2, 5]) * HOUR_MS
    assert act.hourly_mean_mw(hrs) == pytest.approx([500.0, 500.0, 0.0])
    assert np.all(np.diff(act.warp(t0, t0 + 10 * HOUR_MS, np.linspace(0, 1, 11))) >= 0)


def test_detached_spot_grows_from_its_core():
    g = small_grid()
    B0 = disc(g, -1500.0, 0.0, 500.0)
    spot = disc(g, 1500.0, 0.0, 400.0)
    B1 = B0 | spot
    ign = tuple(int(v) for v in np.floor(g.local_to_rowcol(-1500.0, 0.0)))
    T, k = obs.interpolate_arrival([B0, B1], [4.0, 10.0], ign, 0.0)
    core = tuple(int(v) for v in np.floor(g.local_to_rowcol(1500.0, 0.0)))
    assert T[spot].min() == pytest.approx(7.0, abs=1e-3)               # spots start mid-interval at their core
    assert T[core] < 7.6 and T[spot].max() <= 10.0 + 1e-4 and T[spot].max() > 9.0
    assert np.all(k[spot] == 1) and np.all(T[B0] <= 4.0 + 1e-4)
    # cones join a detached area to the earlier burned area when allowed
    F = disc(g, 0.0, 0.0, 2900.0)
    joined = obs.connect_detached(B0, B1, F, g.res_m, None)
    from scipy import ndimage

    assert ndimage.label(joined)[1] == 1 and joined.sum() > B1.sum()
    keep = np.zeros_like(B1)
    keep[core] = True
    assert np.array_equal(obs.connect_detached(B0, B1, F, g.res_m, None, keep_detached=keep), B1)


def test_fill_relax_sinks_and_smoothing():
    g = small_grid(80, 4000.0)
    X, Z = g.cell_centers_local()
    T = (np.hypot(X, Z) / 300.0).astype(np.float32)                    # 300 m/h circular spread
    F = np.hypot(X, Z) <= 1800.0
    T[~F] = NEVER
    hole = disc(g, 900.0, 0.0, 200.0)
    T2 = T.copy()
    T2[hole] = NEVER
    filled = obs.fill_unreached(T2, F, g.res_m, 300.0)
    assert np.all(filled[hole] < NEVER)
    assert np.abs(filled[hole] - T[hole]).max() < 0.35                  # Dijkstra ~ true distance / speed
    # an early island (2 h too early) inside later burning is filled; a 30 h early one is kept as real
    island = disc(g, -900.0, 400.0, 150.0)
    T3 = T.copy()
    T3[island] -= 2.0
    seeds = np.zeros(g.shape, bool)
    seeds[tuple(int(v) for v in np.floor(g.local_to_rowcol(0.0, 0.0)))] = True
    out, n = obs.fill_sinks(T3, seeds, g.res_m, 300.0)
    assert n > 0 and out[island].min() >= T[island].min() - 0.5
    big = T.copy()
    big[island] = np.maximum(T[island] - 40.0, 0.01)
    big[F & ~island] += 40.0
    big[seeds] = 0.0
    out2, _ = obs.fill_sinks(big, seeds, g.res_m, 300.0)
    assert np.allclose(out2[island], big[island])                      # raise would be > 12 h: real early burning
    # median + bilateral smoothing keep NEVER outside and roughly preserve times
    sm = obs.smooth_arrival(obs.median_arrival(T, g.res_m), g.res_m)
    assert np.all(sm[~F] == NEVER) and np.abs(sm[F] - T[F]).max() < 1.0


def test_relax_suspect_pulls_late_pixels_to_neighbours():
    g = small_grid(80, 4000.0)
    X, Z = g.cell_centers_local()
    T = (np.hypot(X, Z) / 300.0).astype(np.float32)
    F = np.hypot(X, Z) <= 1800.0
    T[~F] = NEVER
    bay = disc(g, 1000.0, 0.0, 250.0)
    late = T.copy()
    late[bay] = 40.0                                                    # perimeter-only area dated 40 h
    out = obs.relax_suspect(late, bay, g.res_m, 300.0)
    assert out[bay].max() < 6.0 and np.all(out[~bay] == late[~bay])


# ----------------------------------------------------------------------------------------------------------------
# detections: grouping, thinning, static sources, clustering, GOES
# ----------------------------------------------------------------------------------------------------------------
def test_pass_groups_chain_and_span():
    m = 60_000
    t = np.array([0, 10, 25, 50, 70, 200, 205, 400]) * m
    groups = obs.pass_groups(t)
    assert [list(gr) for gr in groups] == [[0, 1, 2, 3, 4], [5, 6], [7]]
    t2 = np.arange(0, 200, 20) * m                                      # chained every 20 min: split at 75 min
    assert all(t2[gr[-1]] - t2[gr[0]] <= 75 * m for gr in obs.pass_groups(t2))


def test_thin_goes_keeps_max_frp_per_cell_and_bin():
    g = small_grid()
    t0 = 1_700_000_400_000
    rows = [{"t_ms": t0, "x": 100, "z": 100, "frp": 5.0}, {"t_ms": t0 + 60_000, "x": 300, "z": 200, "frp": 50.0},
            {"t_ms": t0 + 2 * 60_000, "x": 2500, "z": 100, "frp": 7.0}, {"t_ms": t0 + 11 * 60_000, "x": 100, "z": 100, "frp": 1.0}]
    goes = det_frame(g, [{**r, "instrument": "GOES"} for r in rows])
    th = obs.thin_goes(goes)
    assert len(th) == 3 and 50.0 in th["frp"].tolist() and 5.0 not in th["frp"].tolist()


def test_static_sites_from_pre_fire_detections():
    g = small_grid()
    day = 1_735_000_000_000
    pre = det_frame(g, [
        {"t_ms": day, "x": 2500, "z": 2000, "instrument": "VIIRS"},
        {"t_ms": day + DAY_MS, "x": 2550, "z": 2000, "instrument": "VIIRS"},      # same site, 2nd day -> static
        {"t_ms": day, "x": -2500, "z": 2000, "instrument": "VIIRS"},              # one day only -> transient
        {"t_ms": day, "x": -2500, "z": -2000, "instrument": "VIIRS", "type": 2},  # FIRMS static land source
        {"t_ms": day, "x": 100, "z": 0, "instrument": "VIIRS", "type": 2},        # near the ignition: ignored
        {"t_ms": day + DAY_MS, "x": 120, "z": 0, "instrument": "VIIRS"},
    ])
    sites = obs.static_sites(pre, (0.0, 0.0))
    xs = sorted(round(float(x)) for x in sites[:, 0])
    assert len(sites) == 3 and all(abs(x) >= 2400 for x in xs)


def _fire_rows(started: int, ign=(0.0, 0.0), n_steps: int = 8) -> list[dict]:
    """A fire spreading east 150 m/h from ``ign``: VIIRS detections every 3 h along a widening front."""
    rows = []
    for k in range(n_steps):
        t = started + (k + 1) * 3 * HOUR_MS
        front = 150.0 * 3 * (k + 1)
        for dz in (-375.0, 0.0, 375.0):
            rows.append({"t_ms": t, "x": ign[0] + front, "z": ign[1] + dz, "instrument": "VIIRS"})
            rows.append({"t_ms": t, "x": ign[0] + front - 375.0, "z": ign[1] + dz, "instrument": "VIIRS"})
    return rows


def test_clustering_excludes_distant_fire_and_static_sources():
    g = Grid(32611, 400_000.0, 3_785_000.0, 16000.0, 400, 400)
    started = 1_735_000_000_000
    fire = _fire_rows(started, (-4000.0, 0.0))
    other = [{"t_ms": started + h * HOUR_MS, "x": 3000.0, "z": 6500.0, "instrument": "VIIRS"} for h in (5, 17, 29)]
    static = [{"t_ms": started + h * HOUR_MS, "x": -200.0, "z": 1100.0, "instrument": "VIIRS", "type": 2} for h in (4, 16, 28, 40)]
    goes = [{"t_ms": started + 20 * 60_000 * i, "x": -3500.0 + 150 * i, "z": 300.0, "instrument": "GOES", "frp": 80.0} for i in range(30)]
    goes += [{"t_ms": started + 5 * HOUR_MS, "x": 3100.0, "z": 6000.0, "instrument": "GOES", "frp": 50.0}]
    det = det_frame(g, fire + other + static + goes)
    pre = det_frame(g, [{"t_ms": started - d * DAY_MS, "x": -200.0, "z": 1100.0, "instrument": "VIIRS"} for d in (2, 3)])
    sites = obs.static_sites(pre, (-4000.0, 0.0))
    assert len(sites) == 2
    sel = obs.select_fire_detections(det, (-4000.0, 0.0), started, None, sites)
    sx = sel.spatial["x"].to_numpy()
    assert len(sel.spatial) == len(fire)
    assert not np.any(np.abs(sx - 3000.0) < 1.0) and not np.any(np.abs(sx + 200.0) < 1.0)
    assert sel.n_static == len(static)
    assert len(sel.goes) == 30                                          # the GOES pixel of the other fire is dropped
    # without the static screen the hot spot 1 km from the front would be clustered with this fire
    sel2 = obs.select_fire_detections(det, (-4000.0, 0.0), started, None, None)
    assert np.any(np.abs(sel2.spatial["x"].to_numpy() + 200.0) < 1.0)


def test_goes_rival_fire_takes_its_own_pixels():
    g = Grid(32611, 400_000.0, 3_785_000.0, 16000.0, 400, 400)
    started = 1_735_000_000_000
    fire = _fire_rows(started, (-4000.0, 0.0), 2)
    rival = [{"t_ms": started + 3 * HOUR_MS, "x": 1500.0, "z": 0.0, "instrument": "VIIRS"},
             {"t_ms": started + 4 * HOUR_MS, "x": 1600.0, "z": 0.0, "instrument": "VIIRS"}]
    goes = [{"t_ms": started + 3 * HOUR_MS, "x": 900.0, "z": 0.0, "instrument": "GOES"},       # nearer the rival
            {"t_ms": started + 3 * HOUR_MS, "x": -2500.0, "z": 0.0, "instrument": "GOES"}]   # nearer this fire
    det = det_frame(g, fire + rival + goes)
    sel = obs.select_fire_detections(det, (-4000.0, 0.0), started)
    assert sel.goes["x"].round().tolist() == [-2500.0]


# ----------------------------------------------------------------------------------------------------------------
# perimeters
# ----------------------------------------------------------------------------------------------------------------
def _lonlat_poly(grid: Grid, cx: float, cz: float, r: float, n: int = 64):
    a = np.linspace(0, 2 * np.pi, n, endpoint=False)
    lon, lat = grid.local_to_lonlat(cx + r * np.cos(a), cz + r * np.sin(a))
    return shapely.Polygon(np.c_[lon, lat])


def test_cumulative_perimeters_never_shrink_and_flag_shrinking():
    g = small_grid(200, 10_000.0)
    t0 = 1_735_000_000_000
    perims = [
        {"t_ms": t0 + 30 * HOUR_MS, "geometry": _lonlat_poly(g, 500, 0, 2500), "source": "NIFC WFIGS daily perimeters"},
        {"t_ms": t0 + 10 * HOUR_MS, "geometry": _lonlat_poly(g, 0, 0, 1000), "source": "NIFC WFIGS daily perimeters"},
        {"t_ms": t0 + 20 * HOUR_MS, "geometry": _lonlat_poly(g, 0, 0, 600), "source": "NIFC WFIGS daily perimeters"},   # shrinks
        {"t_ms": t0 + 25 * HOUR_MS, "geometry": _lonlat_poly(g, 800, 0, 1300), "source": "NIFC WFIGS daily perimeters"},
    ]
    steps, warns = obs.cumulative_perimeters(perims, g)
    assert [s.t_ms for s in steps] == sorted(s.t_ms for s in steps) and len(steps) == 3
    acres = [s.acres for s in steps]
    assert acres == sorted(acres)
    for a, b in zip(steps, steps[1:]):
        assert b.geom.buffer(1e-6).contains(a.geom)
    assert len(warns) == 1 and "20% smaller" in warns[0]
    # the union of the first two (different centres) is larger than either
    assert steps[1].acres > steps[1].own_acres - 1e-6
    rings = obs.simplify_rings(steps[-1].geom, g.res_m)
    assert rings and all(r[0] == r[-1] for r in rings)


def test_simplify_rings_vertex_budget_and_rasterize():
    g = small_grid(200, 10_000.0)
    a = np.linspace(0, 2 * np.pi, 6000, endpoint=False)
    r = 2000 + 150 * np.sin(8 * a) + 20 * np.sin(300 * a)
    star = shapely.Polygon(np.c_[r * np.cos(a), r * np.sin(a)])
    rings = obs.simplify_rings(star, g.res_m)
    assert sum(len(x) for x in rings) <= 1500
    m = obs.rasterize_local(star, g)
    ac = m.sum() * g.res_m ** 2
    assert ac == pytest.approx(star.area, rel=0.03)


def test_footprint_and_detection_masks():
    g = small_grid()
    m = obs.footprint_mask(np.array([0.0]), np.array([0.0]), np.array([500.0]), np.array([250.0]), g)
    rows, cols = np.nonzero(m)
    assert (cols.max() - cols.min() + 1) * g.res_m == pytest.approx(1000.0, abs=g.res_m)
    assert (rows.max() - rows.min() + 1) * g.res_m == pytest.approx(500.0, abs=g.res_m)
    tiny = obs.footprint_mask(np.array([10.0]), np.array([10.0]), np.array([1.0]), np.array([1.0]), g)
    assert tiny.sum() == 1
    # a 3 x 3 block of VIIRS pixels (375 m) shrunk by 1/3 is closed into one smooth blob
    rows_ = [{"t_ms": 0, "x": dx, "z": dz, "instrument": "VIIRS", "scan": 0.375, "track": 0.375}
             for dx in (-375, 0, 375) for dz in (-375, 0, 375)]
    det = det_frame(g, rows_)
    D = obs.detection_mask(det, g)
    from scipy import ndimage

    assert ndimage.label(D)[1] == 1
    ac = D.sum() * g.res_m ** 2
    assert 0.5 * (3 * 375) ** 2 < ac < (3 * 375) ** 2                      # smaller than the full footprints


def test_detection_only_area_calibrated_to_calfire_acres():
    g = Grid(32611, 400_000.0, 3_785_000.0, 12000.0, 300, 300)
    rows = [{"t_ms": 0, "x": dx, "z": dz, "instrument": "VIIRS", "scan": 0.375, "track": 0.375}
            for dx in np.arange(-1500, 1501, 375.0) for dz in np.arange(-750, 751, 375.0)]
    rows += [{"t_ms": 0, "x": 4000.0, "z": 4000.0, "instrument": "MODIS"}]           # unsupported MODIS pixel
    det = det_frame(g, rows)
    ca = obs.cell_acres(g.res_m)
    raw = obs.detection_mask(obs.supported_spatial(det), g).sum() * ca
    assert obs.detection_mask(det, g).sum() * ca > raw                              # the MODIS pixel alone adds area
    fm = obs.final_mask(None, det, g, 0.45 * raw)                                    # bloat: CAL FIRE says much less
    assert fm.method == "detections" and fm.notes and "eroded" in fm.notes[0]
    assert fm.mask.sum() * ca == pytest.approx(0.45 * raw, rel=0.15)
    X, Z = g.cell_centers_local()
    assert not fm.mask[(np.abs(X - 4000) < 400) & (np.abs(Z - 4000) < 400)].any()   # MODIS alone is not burned area
    stale = obs.final_mask(None, det, g, 0.45 * raw, allow_reduce=False)             # live acres older than detections
    assert stale.mask.sum() * ca == pytest.approx(raw, rel=0.01) and not stale.notes
    close = obs.final_mask(None, det, g, 1.1 * raw)                                  # within 20 %: untouched
    assert close.mask.sum() * ca == pytest.approx(raw, rel=0.01) and not close.notes


# ----------------------------------------------------------------------------------------------------------------
# events and ignition
# ----------------------------------------------------------------------------------------------------------------
def test_ignition_time_from_goes_and_polar():
    g = small_grid()
    started = 1_735_000_000_000
    origin = time_origin_for(started)
    goes_rows = [{"t_ms": started - 40 * 60_000 + 10 * 60_000 * i, "x": 500.0, "z": 0.0, "instrument": "GOES"} for i in range(4)]
    false_alarm = [{"t_ms": started - 3 * HOUR_MS, "x": 400.0, "z": 0.0, "instrument": "GOES"}]   # one scan only
    goes = det_frame(g, goes_rows + false_alarm)
    empty = det_frame(g, [])
    t, why, conf, tg, sat = obs.ignition_time(started, origin, (0.0, 0.0), goes, empty, started + 5 * HOUR_MS)
    assert tg == started - 40 * 60_000 and t == tg - 10 * 60_000 and conf == "observed" and sat == "G18"
    # a polar detection before the start moves it earlier, never before the timeline origin
    polar = det_frame(g, [{"t_ms": origin + 5 * 60_000, "x": 0.0, "z": 0.0, "instrument": "VIIRS"}])
    t2, *_ = obs.ignition_time(started, origin, (0.0, 0.0), goes, polar, started + 5 * HOUR_MS)
    assert t2 == origin
    # no GOES: CAL FIRE start, estimated
    t3, why3, conf3, *_ = obs.ignition_time(started, origin, (0.0, 0.0), empty, empty, started + 5 * HOUR_MS)
    assert t3 == started and conf3 == "estimated" and "CAL FIRE" in why3


def test_place_ignition_snaps_and_uses_centroid_when_far():
    g = small_grid()
    F = disc(g, 1000.0, 0.0, 600.0)
    x, z, rc, where, notes = obs.place_ignition(g, (0.0, 0.0), np.array([[900.0, 0.0], [1100.0, 50.0]]), F)
    assert F[rc] and "moved" in where and x > 300.0
    x2, z2, rc2, where2, _ = obs.place_ignition(g, (-2900.0, 2900.0), np.array([[900.0, 0.0], [1100.0, 0.0]]), F)
    assert "centroid" in where2 and F[rc2] and abs(x2 - 1000.0) < 200.0


def test_limit_events_priority_and_ids():
    ev = [obs._event("perimeter_update", 50, "p", "d", "observed", "s"), obs._event("ignition", 10, "i", "d", "estimated", "s")]
    ev += [obs._event("rapid_growth", 20 + i, "r", "d", "observed", "s") for i in range(3)]
    ev += [obs._event("spot_fire", 30 + i, "s", "d", "probable", "s") for i in range(3)]
    ev += [obs._event("ridge_crossing", 40 + i, "x", "d", "estimated", "s") for i in range(3)]
    out = obs.limit_events(ev, 8)
    assert len(out) == 8 and out[0]["type"] == "ignition"
    assert [e["id"] for e in out] == [f"ev-{i:02d}" for i in range(1, 9)]
    assert "perimeter_update" not in {e["type"] for e in out}
    assert [e["t_ms"] for e in out] == sorted(e["t_ms"] for e in out)


def test_ridge_crossing_event_on_synthetic_ridge():
    g = Grid(32611, 400_000.0, 3_785_000.0, 8000.0, 200, 200)
    X, Z = g.cell_centers_local()
    elev = (500.0 + 150.0 * np.exp(-X ** 2 / (2 * 250.0 ** 2))).astype(np.float32)   # N-S ridge at x = 0
    T = ((X + 3000.0) / 400.0).astype(np.float32)                                    # front moving east, 400 m/h
    F = (np.abs(Z) < 2000.0) & (X > -3000.0) & (X < 3000.0)
    T[~F] = NEVER
    ev = obs.ridge_crossing_events(T, F, elev, g, 0)
    assert ev and ev[0]["type"] == "ridge_crossing"
    assert abs(ev[0]["x"]) < 300.0 and "moving E" in ev[0]["detail"]
    assert ev[0]["t_ms"] == pytest.approx(7.5 * HOUR_MS, abs=0.6 * HOUR_MS)


def test_wind_shift_inferred_from_spread_direction():
    g = Grid(32611, 400_000.0, 3_785_000.0, 12000.0, 240, 240)
    X, Z = g.cell_centers_local()
    T = np.full(g.shape, NEVER, np.float32)
    east = (X >= 0) & (X < 4000) & (np.abs(Z) < 1500)
    T[east] = X[east] / 400.0                                           # 0-10 h: running east
    north = (Z <= -1500) & (Z > -5500) & (X > 2000) & (X < 4000)
    T[north] = 12.0 + (-Z[north] - 1500.0) / 400.0                      # 12-22 h: running north
    ev = obs.wind_shift_events(T, g, 0, float(obs.burned(T).sum() * obs.cell_acres(g.res_m)))
    assert len(ev) == 1 and "toward E" in ev[0]["detail"] and "toward N" in ev[0]["detail"]


# ----------------------------------------------------------------------------------------------------------------
# end to end
# ----------------------------------------------------------------------------------------------------------------
STARTED = iso_to_ms("2025-08-10T20:12:00Z")
HEAD, BACK, FLANK = 200.0, 40.0, 80.0          # m/h, toward the south-west (bearing 225)
WIND_TO = 225.0


def truth_time(grid: Grid, ign: tuple[float, float], t_ign_h: float) -> np.ndarray:
    X, Z = grid.cell_centers_local()
    b = math.radians(WIND_TO)
    ux, uz = math.sin(b), -math.cos(b)
    dx, dz = X - ign[0], Z - ign[1]
    along = dx * ux + dz * uz
    cross = -dx * uz + dz * ux
    a = np.where(along > 0, HEAD, BACK)
    return t_ign_h + np.sqrt((along / a) ** 2 + (cross / FLANK) ** 2)


def truth_polygon(grid: Grid, ign: tuple[float, float], tau_h: float):
    b = math.radians(WIND_TO)
    ux, uz = math.sin(b), -math.cos(b)
    th = np.linspace(0, 2 * np.pi, 180, endpoint=False)
    a = np.where(np.cos(th) > 0, HEAD, BACK)
    r = tau_h / np.sqrt((np.cos(th) / a) ** 2 + (np.sin(th) / FLANK) ** 2)
    along, cross = r * np.cos(th), r * np.sin(th)
    x = ign[0] + along * ux - cross * uz
    z = ign[1] + along * uz + cross * ux
    lon, lat = grid.local_to_lonlat(x, z)
    return shapely.Polygon(np.c_[lon, lat])


class Scenario:
    """Synthetic fire sampled like FIRMS + WFIGS, served through monkeypatched source functions."""

    def __init__(self, mode: str = "historical", hours: float = 30.0):
        self.mode = mode
        self.render, self.fire = make_aoi(-118.07, 34.20, (-118.13, 34.15, -118.03, 34.23), "historical")
        g = self.fire
        self.origin = time_origin_for(STARTED)
        self.ign = (2500.0, -2000.0)
        self.t_ign_h = (STARTED - self.origin) / HOUR_MS
        self.hours = hours
        T = truth_time(g, self.ign, self.t_ign_h)
        self.T = T
        rows: list[dict] = []
        X, Z = g.cell_centers_local()
        # VIIRS triplets twice a day + Terra MODIS; a footprint is hot when the band burned in the last 6 h crosses it
        def hot(x: float, z: float, half: float, t_h: float) -> bool:
            ts = [truth_time_at(self, x + dx, z + dz) for dx in (-half, 0.0, half) for dz in (-half, 0.0, half)]
            return min(ts) <= t_h and max(t for t in ts) > t_h - 6.0 and min(ts) < 1e8

        for base in np.arange(1.5, hours, 12.0):
            for j, sat in enumerate(("N21", "N20", "N")):
                t_h = self.t_ign_h + base + 0.4 * j
                for x in np.arange(-6000, 6000, 375.0):
                    for z in np.arange(-6000, 6000, 375.0):
                        if hot(x, z, 187.0, t_h):
                            rows.append({"t_ms": int(self.origin + t_h * HOUR_MS), "x": x + 40 * j, "z": z, "instrument": "VIIRS",
                                         "satellite": sat, "frp": 25.0, "scan": 0.39, "track": 0.37})
        for base in np.arange(7.0, hours, 12.0):
            t_h = self.t_ign_h + base
            for x in np.arange(-6000, 6000, 1000.0):
                for z in np.arange(-6000, 6000, 1000.0):
                    if hot(x, z, 300.0, t_h):
                        rows.append({"t_ms": int(self.origin + t_h * HOUR_MS), "x": x, "z": z, "instrument": "MODIS", "frp": 120.0})
        # GOES every 10 min on a 2 km lattice, FRP ~ active area
        cells = []
        for x in np.arange(-6000, 6000, 2000.0):
            for z in np.arange(-6000, 6000, 2000.0):
                near = (np.abs(X - x) < 1000) & (np.abs(Z - z) < 1000)
                vals = T[near]
                if (vals < self.t_ign_h + hours).any():
                    cells.append((x, z, vals))
        for i in range(int(hours * 6)):
            t_h = self.t_ign_h + 0.25 + i / 6.0
            for x, z, vals in cells:
                n_act = int(((vals > t_h - 1.0) & (vals <= t_h)).sum())
                if n_act >= 3:
                    rows.append({"t_ms": int(self.origin + t_h * HOUR_MS), "x": x + 300.0, "z": z - 200.0, "instrument": "GOES",
                                 "frp": float(n_act)})
        # a GOES-only hot pixel 3 km behind the ignition (no polar detection there): timing data, never burned area
        self.goes_only = (self.ign[0] + 2121.0, self.ign[1] - 2121.0)
        rows += [{"t_ms": int(STARTED + 2 * HOUR_MS + i * 10 * 60_000), "x": self.goes_only[0], "z": self.goes_only[1],
                  "instrument": "GOES", "frp": 30.0} for i in range(30)]
        # another fire far away and a static hot spot near the fire (hot before the fire too)
        rows += [{"t_ms": STARTED + h * HOUR_MS, "x": -5500.0, "z": -5500.0, "instrument": "VIIRS"} for h in (3, 15, 27)]
        rows += [{"t_ms": STARTED + h * HOUR_MS, "x": 4300.0, "z": -3800.0, "instrument": "VIIRS", "type": 2} for h in (2, 14, 26)]
        self.static_pre = [{"t_ms": STARTED - d * DAY_MS, "x": 4300.0, "z": -3800.0, "instrument": "VIIRS"} for d in (2, 4)]
        self.rows = rows
        self.calls: list[tuple] = []

    def frame_between(self, rows, start, end, instruments=None):
        df = det_frame(self.fire, rows)
        df = df[(df["t_ms"] >= start) & (df["t_ms"] <= end)]
        if instruments:
            df = df[df["instrument"].isin(instruments)]
        out = firms.concat_frames([df[list(firms.FIRMS_COLUMNS)]])
        out.attrs["sources"] = [{"source": "SYNTH", "via": "area_api", "rows": len(out), "fetched_ms": STARTED + 40 * DAY_MS}]
        out.attrs["warnings"] = []
        return out

    def detections_for(self, bbox, start_ms, end_ms, mode="historical", *, instruments=None, families=None, **kw):
        self.calls.append(("firms", start_ms, end_ms, instruments))
        rows = self.rows + (self.static_pre if instruments else [])
        return self.frame_between(rows, start_ms, end_ms, instruments)

    def fetch_perimeters(self, name, lat, lon, start_ms, end_ms, *, acres=None, contained_ms=None):
        self.calls.append(("perims", start_ms, end_ms))
        g = self.fire
        items = [{"t_ms": int(STARTED + 14 * HOUR_MS), "acres": 0.0, "geometry": truth_polygon(g, self.ign, 14.0 - 0.5),
                  "source": "NIFC WFIGS daily perimeters", "category": "Wildfire Daily Fire Perimeter", "irwin_id": "X",
                  "containment_ms": int(STARTED + 20 * DAY_MS), "cause": None, "name": "Synth", "t_field": "poly_PolygonDateTime"}]
        if self.mode == "historical":
            items.append({"t_ms": int(STARTED + 20 * DAY_MS), "acres": 0.0, "geometry": truth_polygon(g, self.ign, self.hours),
                          "source": "NIFC WFIGS daily perimeters", "category": "Wildfire Final Fire Perimeter", "irwin_id": "X",
                          "containment_ms": int(STARTED + 20 * DAY_MS), "cause": None, "name": "Synth",
                          "t_field": "attr_ContainmentDateTime (final perimeter re-dated)"})
        return wfigs.PerimeterList([p for p in items if p["t_ms"] <= end_ms + 2 * DAY_MS], [])

    def install(self, monkeypatch):
        monkeypatch.setattr(firms, "detections_for", self.detections_for)
        monkeypatch.setattr(wfigs, "fetch_perimeters", self.fetch_perimeters)
        return self

    def truth_acres(self) -> float:
        return float((self.T <= self.t_ign_h + self.hours).sum() * obs.cell_acres(self.fire.res_m))

    def context(self, now: int | None = None) -> BuildContext:
        live = self.mode == "live"
        iid = "2026-synth-fire-abc123" if live else "2025-synth-fire-abc123"
        lon, lat = self.fire.local_to_lonlat(*self.ign)
        acres = round(self.truth_acres())
        summary = IncidentSummary(
            id=iid, name="Synth Fire", mode=self.mode, year=2025, calfire_uid="abc12345-0000", started_ms=STARTED,
            updated_ms=None, contained_ms=None if live else STARTED + 20 * DAY_MS, acres=acres,
            percent_contained=None if live else 100.0, is_active=live, county=None, location=None, admin_unit=None, url=None,
            lat=float(lat), lon=float(lon), detections_24h=None, bundle_status="building", bundle_built_ms=None)
        bdir = bundle.bundle_dir(iid)
        initial = {"schema_version": 1, "id": iid, "name": summary.name, "mode": self.mode, "status": "building",
                   "summary": dump(summary), "time_origin_ms": self.origin, "grid": manifest_grid(self.render, self.fire, 0.0, 0.0),
                   "layers": {}, "data_sources": [{"name": "CAL FIRE incidents", "detail": "x", "fetched_ms": STARTED}],
                   "forecasts": [], "warnings": ["Terrain: kept"]}
        bundle.update_manifest(bdir, lambda m: initial)
        X, Z = self.fire.cell_centers_local()
        b = math.radians(WIND_TO)
        along = (X - self.ign[0]) * math.sin(b) + (Z - self.ign[1]) * -math.cos(b)
        elev = 400.0 + 200.0 * np.exp(-((along - 2400.0) ** 2) / (2 * 250.0 ** 2)) + 0.01 * X
        bundle.write_npz(bdir / bundle.STATIC_NPZ, elevation=elev.astype(np.float32))
        return BuildContext(summary=summary, bundle_dir=bdir, render_grid=self.render, fire_grid=self.fire,
                            time_origin_ms=self.origin, mode=self.mode, progress=lambda *a: None,
                            end_ms=None if live else STARTED + 20 * DAY_MS, now_ms=now)


def truth_time_at(sc: Scenario, x: float, z: float) -> float:
    b = math.radians(WIND_TO)
    ux, uz = math.sin(b), -math.cos(b)
    dx, dz = x - sc.ign[0], z - sc.ign[1]
    along = dx * ux + dz * uz
    cross = -dx * uz + dz * ux
    a = HEAD if along > 0 else BACK
    tt = sc.t_ign_h + math.sqrt((along / a) ** 2 + (cross / FLANK) ** 2)
    return tt if tt <= sc.t_ign_h + sc.hours else 1e9


@pytest.fixture
def scenario(tmp_data_dir, monkeypatch) -> Scenario:
    return Scenario().install(monkeypatch)


def test_build_observed_end_to_end_historical(scenario):
    sc = scenario
    ctx = sc.context()
    progress: list[tuple] = []
    ctx.progress = lambda step, f, msg: progress.append((step, f, msg))
    stats = obs.build_observed_stats(ctx)
    bdir = ctx.bundle_dir
    for name, model in (("detections.json", DetectionsFile), ("perimeters.json", PerimetersFile),
                        ("timeseries.json", TimeseriesFile), ("events.json", EventsFile)):
        assert contract_problems(model, (bdir / name).read_bytes()) == [], name
    m = bundle.load_manifest(bdir)
    tr = m["time_range"]
    assert tr["start_ms"] == sc.origin and tr["end_ms"] == tr["now_ms"] == ctx.end_ms == ctx.now_ms
    assert tr["end_ms"] <= STARTED + 45 * DAY_MS
    # area close to the truth and to the perimeter; final perimeter used for the extent only
    truth = sc.truth_acres()
    assert 0.85 * truth < m["stats"]["final_acres_observed"] < 1.15 * truth
    assert stats["perimeters_trusted"] == 1 and stats["perimeters_total"] == 2
    # arrival: ignition time at the ignition pixel, never before it, NEVER outside the fire
    T = bundle.read_layer(bdir, "observed_arrival", m)
    ign = m["ignition"]
    r, c = (int(v) for v in np.floor(sc.fire.local_to_rowcol(ign["x"], ign["z"])))
    t_ign_h = (ign["t_ms"] - sc.origin) / HOUR_MS
    assert T[r, c] == pytest.approx(t_ign_h, abs=1e-3)
    b = T < NEVER
    assert T[b].min() >= t_ign_h - 1e-3 and T[b].max() <= (tr["end_ms"] - sc.origin) / HOUR_MS + 1e-3
    assert m["layers"]["observed_arrival"]["grid"] == "fire" and m["layers"]["observed_arrival"]["units"] == "h"
    # timing roughly follows the truth (median absolute error, hours)
    err = np.abs(T[b & (sc.T < 1e8)] - sc.T[b & (sc.T < 1e8)])
    assert np.median(err) < 3.0
    # the static hot spot and the other fire are not this fire
    dets = bundle.read_json(bdir / "detections.json")["detections"]
    assert not any(abs(d["x"] - 4300.0) < 1 and abs(d["z"] + 3800.0) < 1 for d in dets)
    assert not any(abs(d["x"] + 5500.0) < 1 for d in dets)
    goes = [d for d in dets if d["instrument"] == "GOES"]
    assert goes and all(d["footprint_m"] == 2000.0 for d in goes)
    assert len([d for d in dets if d["instrument"] != "GOES"]) == stats["spatial"]
    # GOES never enters the spatial mask: the GOES-only hot pixel behind the fire is kept as this fire's GOES data
    # but its location never burns
    gx, gz = sc.goes_only
    assert any(abs(d["x"] - gx) < 1 and abs(d["z"] - gz) < 1 for d in goes)
    gr, gc = (int(v) for v in np.floor(sc.fire.local_to_rowcol(gx, gz)))
    assert T[gr, gc] == NEVER and not np.any(T[max(gr - 10, 0):gr + 10, max(gc - 10, 0):gc + 10] < NEVER)
    # timeseries: hourly from start to now; area non-decreasing; FRP from GOES
    ts = bundle.read_json(bdir / "timeseries.json")
    assert ts["t_ms"][0] == sc.origin and all(b2 - a2 == HOUR_MS for a2, b2 in zip(ts["t_ms"], ts["t_ms"][1:]))
    assert ts["t_ms"][-1] <= tr["now_ms"] < ts["t_ms"][-1] + HOUR_MS
    assert all(b2 >= a2 for a2, b2 in zip(ts["area_acres"], ts["area_acres"][1:]))
    assert max(ts["frp_mw_per_h"]) > 0 and sum(ts["detections_per_h"]) == sum(1 for d in dets if d["t_ms"] >= sc.origin)
    # events: few, ignition first, valid ids; a ridge crossing on the synthetic ridge; perimeters in the timeline
    events = bundle.read_json(bdir / "events.json")["events"]
    types = [e["type"] for e in events]
    assert types[0] == "ignition" and len(events) <= obs.MAX_EVENTS and "peak_wind" not in types
    assert "ridge_crossing" in types and set(types) <= set(obs.EVENT_PRIORITY)
    assert all(tr["start_ms"] <= e["t_ms"] <= tr["end_ms"] for e in events)
    assert len({e["id"] for e in events}) == len(events)
    perims = bundle.read_json(bdir / "perimeters.json")["perimeters"]
    assert [p["acres"] for p in perims] == sorted(p["acres"] for p in perims)
    assert all(sc.origin <= p["t_ms"] <= tr["end_ms"] for p in perims)
    assert "final extent" in perims[-1]["source"]
    # manifest bookkeeping
    names = [d["name"] for d in m["data_sources"]]
    assert names[0] == "CAL FIRE incidents" and "NASA FIRMS active fire detections" in names and "NIFC WFIGS fire perimeters" in names
    assert "Terrain: kept" in m["warnings"]
    assert len(m["default_profile_path"]) == 2 and m["ignition"]["source"]
    assert progress and progress[-1][1] == 1.0 and all(s == "observations" for s, _, _ in progress)
    assert [f for _, f, _ in progress] == sorted(f for _, f, _ in progress)
    # a second run (live-refresh style) replaces its own manifest entries instead of duplicating them
    obs.build_observed(ctx)
    m2 = bundle.load_manifest(bdir)
    assert [d["name"] for d in m2["data_sources"]] == names
    assert m2["warnings"].count("Terrain: kept") == 1
    assert len([w for w in m2["warnings"] if w.startswith(obs.WARNING_PREFIX)]) == len(
        [w for w in m["warnings"] if w.startswith(obs.WARNING_PREFIX)])


def test_build_observed_live_never_after_now(tmp_data_dir, monkeypatch):
    sc = Scenario(mode="live", hours=26.0).install(monkeypatch)
    now = STARTED + 26 * HOUR_MS
    monkeypatch.setattr(obs, "now_ms", lambda: now + 30 * 60_000)
    ctx = sc.context(now=now)
    obs.build_observed(ctx)
    m = bundle.load_manifest(ctx.bundle_dir)
    tr = m["time_range"]
    dets = bundle.read_json(ctx.bundle_dir / "detections.json")["detections"]
    latest_spatial = max(d["t_ms"] for d in dets if d["instrument"] != "GOES")
    assert tr["now_ms"] == tr["end_ms"] == latest_spatial and tr["now_ms"] <= now
    T = bundle.read_layer(ctx.bundle_dir, "observed_arrival", m)
    assert T[T < NEVER].max() <= (tr["now_ms"] - sc.origin) / HOUR_MS + 1e-3
    assert all(d["t_ms"] <= tr["now_ms"] for d in dets)
    events = bundle.read_json(ctx.bundle_dir / "events.json")["events"]
    assert "containment" not in {e["type"] for e in events}
    assert contract_problems(TimeseriesFile, (ctx.bundle_dir / "timeseries.json").read_bytes()) == []


def test_build_observed_without_any_data(tmp_data_dir, monkeypatch):
    sc = Scenario()
    sc.rows = []
    sc.static_pre = []
    sc.install(monkeypatch)
    monkeypatch.setattr(sc, "fetch_perimeters", lambda *a, **k: wfigs.PerimeterList([], ["service down"]))
    monkeypatch.setattr(wfigs, "fetch_perimeters", sc.fetch_perimeters)
    ctx = sc.context()
    obs.build_observed(ctx)
    m = bundle.load_manifest(ctx.bundle_dir)
    T = bundle.read_layer(ctx.bundle_dir, "observed_arrival", m)
    assert np.all(T == NEVER) and m["stats"]["final_acres_observed"] == 0.0
    assert m["ignition"] is not None and m["time_range"]["end_ms"] > m["time_range"]["start_ms"]
    assert any("no satellite detections or perimeters" in w for w in m["warnings"])
    assert [e["type"] for e in bundle.read_json(ctx.bundle_dir / "events.json")["events"]] == ["ignition"]
    for name, model in (("detections.json", DetectionsFile), ("perimeters.json", PerimetersFile),
                        ("timeseries.json", TimeseriesFile), ("events.json", EventsFile)):
        assert contract_problems(model, (ctx.bundle_dir / name).read_bytes()) == [], name
