"""Check a built incident bundle against the contracts (SPEC 5) and write quick-look PNGs.

    cd backend && uv run python scripts/check_bundle.py <incident-id> [--quicklook DIR] [--prefix NAME]

Checks: strict pydantic validation of manifest.json, every JSON file and every forecast.json; manifest completeness
(required/optional layers, grid sizes, time origin, stats); every layer file against its LayerInfo (size, dtype,
min/max, NaN); sim/static.npz keys, shapes and ranges; timeseries/detections/perimeters/events/weather internals
(hourly axes, array lengths, GOES-based FRP series, vertex limits, monotone perimeters); forecast quantile ordering
and burn-probability consistency. Prints one line per problem and exits 1 when any check fails.

Quick-looks (``--quicklook``): hillshade x sky_view, fuels, water, dNBR (+ perimeter outline: an independent
alignment check, since Sentinel-2 is georeferenced separately from the perimeters), NAIP thumbnail (+ perimeter
and detections), observed arrival with perimeters/ignition/detections by instrument, and one map per forecast
(burn probability, p50 isochrones, start mask, final observed outline, mean wind arrow).
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fire3d import bundle, config  # noqa: E402
from fire3d.contracts import (  # noqa: E402
    DetectionsFile, EventsFile, ForecastManifest, IncidentManifest, PerimetersFile, TimeseriesFile, WeatherFile,
    contract_problems,
)
from fire3d.grid import fire_grid_size, grids_from_manifest  # noqa: E402
from fire3d.timeutil import HOUR_MS, time_origin_for  # noqa: E402
from fire3d.types import STATIC_NPZ_KEYS  # noqa: E402

REQUIRED_LAYERS = ("elevation", "fuel", "canopy_cover", "canopy_height", "observed_arrival", "naip", "sky_view", "trees")
OPTIONAL_LAYERS = ("burn_severity", "water")
LAYER_GRID = {"elevation": "render", "sky_view": "render", "water": "render", "fuel": "fire", "canopy_cover": "fire",
              "canopy_height": "fire", "burn_severity": "fire", "observed_arrival": "fire", "naip": "image", "trees": "points"}
LAYER_DTYPE = {"elevation": "float32", "sky_view": "uint8", "water": "uint8", "fuel": "uint8", "canopy_cover": "uint8",
               "canopy_height": "float32", "burn_severity": "float32", "observed_arrival": "float32", "naip": "jpeg",
               "trees": "float32"}
ITEMSIZE = {"float32": 4, "uint8": 1, "uint16": 2, "int16": 2}
NEVER = config.NEVER


class Report:
    def __init__(self) -> None:
        self.problems: list[str] = []
        self.notes: list[str] = []

    def bad(self, msg: str) -> None:
        self.problems.append(msg)

    def note(self, msg: str) -> None:
        self.notes.append(msg)

    def check(self, ok: bool, msg: str) -> bool:
        if not ok:
            self.bad(msg)
        return ok


def _strict(rep: Report, model, path: Path, label: str) -> dict | None:
    if not path.is_file():
        rep.bad(f"{label}: missing")
        return None
    raw = path.read_bytes()
    for p in contract_problems(model, raw)[:20]:
        rep.bad(f"{label}: {p}")
    try:
        return bundle.read_json(path)
    except ValueError as e:
        rep.bad(f"{label}: unreadable JSON ({e})")
        return None


def _check_layer(rep: Report, bdir: Path, name: str, info: dict) -> np.ndarray | None:
    path = bdir / info["file"]
    if not rep.check(path.is_file(), f"layer {name}: file {info['file']} missing"):
        return None
    exp_grid, exp_dtype = LAYER_GRID.get(name), LAYER_DTYPE.get(name)
    if exp_grid:
        rep.check(info.get("grid") == exp_grid, f"layer {name}: grid {info.get('grid')!r}, SPEC says {exp_grid!r}")
    if exp_dtype:
        rep.check(info.get("dtype") == exp_dtype, f"layer {name}: dtype {info.get('dtype')!r}, SPEC says {exp_dtype!r}")
    size = path.stat().st_size
    if info["dtype"] == "jpeg":
        from PIL import Image

        try:
            with Image.open(path) as im:
                rep.check(im.size == (info.get("width"), info.get("height")),
                          f"layer {name}: JPEG is {im.size}, LayerInfo says {info.get('width')}x{info.get('height')}")
                rep.check(max(im.size) <= 4000, f"layer {name}: JPEG larger than 4000 px")
        except OSError as e:
            rep.bad(f"layer {name}: undecodable JPEG ({e})")
        return None
    if info.get("grid") == "points":
        n = int(info.get("count") or 0)
        rep.check(size == n * 6 * 4, f"layer {name}: {size} bytes, expected count*6*4 = {n * 24}")
    else:
        exp = int(info["width"]) * int(info["height"]) * ITEMSIZE[info["dtype"]]
        if not rep.check(size == exp, f"layer {name}: {size} bytes, expected {exp}"):
            return None
    a = bundle.read_array(bdir, info)
    if a.dtype.kind == "f":
        nan = int(np.count_nonzero(~np.isfinite(a)))
        rep.check(nan == 0, f"layer {name}: {nan} NaN/inf values")
    if info.get("grid") != "points":
        lo, hi = bundle.layer_stats(a, info.get("nodata"))
        if lo is not None and info.get("min") is not None:
            rep.check(abs(lo - info["min"]) <= 1e-3 * max(1.0, abs(lo)) and abs(hi - info["max"]) <= 1e-3 * max(1.0, abs(hi)),
                      f"layer {name}: data range {lo:.4g}..{hi:.4g} != LayerInfo {info['min']:.4g}..{info['max']:.4g}")
    return a


def check_bundle(bdir: Path) -> tuple[Report, dict]:
    rep = Report()
    m = _strict(rep, IncidentManifest, bdir / bundle.MANIFEST_NAME, "manifest.json") or {}
    if not m:
        return rep, m
    rep.check(m.get("status") == "ready", f"manifest status {m.get('status')!r}")
    s = m.get("summary") or {}
    rep.check(s.get("bundle_status") == "ready", f"summary.bundle_status {s.get('bundle_status')!r}")
    rep.check(s.get("bundle_built_ms") == m.get("built_ms"), "summary.bundle_built_ms != built_ms")
    rep.check(m.get("time_origin_ms") == time_origin_for(int(s.get("started_ms", 0))),
              "time_origin_ms != floor_to_hour(started_ms) - 1 h")
    g = m["grid"]
    render, fire = grids_from_manifest(m)
    rep.check(g["render"]["width"] == 1024 == g["render"]["height"], "render grid is not 1024²")
    M = fire_grid_size(float(g["extent_m"]))
    rep.check(g["fire"]["width"] == M == g["fire"]["height"], f"fire grid {g['fire']['width']} != SPEC M {M}")
    rep.check(abs(g["fire"]["res_m"] - g["extent_m"] / M) < 1e-6, "fire res_m != extent/M")
    exp_epsg = 32610 if s.get("lon", 0) < -120 else 32611
    rep.check(g["crs"] == f"EPSG:{exp_epsg}", f"crs {g['crs']} but the incident longitude says EPSG:{exp_epsg}")
    lay = m.get("layers") or {}
    for k in REQUIRED_LAYERS:
        rep.check(k in lay, f"required layer {k!r} missing")
    for k in OPTIONAL_LAYERS:
        if k not in lay:
            rep.note(f"optional layer {k!r} absent")
    arrays: dict[str, np.ndarray] = {}
    for k, info in lay.items():
        a = _check_layer(rep, bdir, k, info)
        if a is not None:
            arrays[k] = a
    if "elevation" in arrays:
        e = arrays["elevation"]
        rep.check(abs(float(e.min()) - g["elev_min_m"]) < 1 and abs(float(e.max()) - g["elev_max_m"]) < 1,
                  "grid.elev_min_m/elev_max_m do not match the elevation layer")
    if "fuel" in arrays:
        f = arrays["fuel"]
        bad = np.setdiff1d(np.unique(f), np.r_[0, 91:100, 101:110, 121:125, 141:150, 161:166, 181:190, 201:205])
        rep.check(bad.size == 0, f"fuel: non-FBFM40 codes {bad[:10].tolist()}")
        rep.note(f"fuel: non-burnable (91-99) {np.isin(f, range(91, 100)).mean() * 100:.1f}%, urban 91 {np.mean(f == 91) * 100:.1f}%")
    if "trees" in arrays:
        t = arrays["trees"]
        half = g["extent_m"] / 2
        rep.check(bool(np.all(np.abs(t[:, 0]) <= half + 1) and np.all(np.abs(t[:, 2]) <= half + 1)), "trees outside the AOI")
        rep.check(set(np.unique(t[:, 5]).astype(int)) <= {0, 1, 2}, "trees: kind outside 0/1/2")
        rep.check(len(t) <= 120_000, f"trees: {len(t)} > 120,000")
    # sim/static.npz
    p = bdir / bundle.STATIC_NPZ
    if rep.check(p.is_file(), "sim/static.npz missing"):
        z = bundle.read_npz(p)
        for k in STATIC_NPZ_KEYS:
            if rep.check(k in z, f"static.npz: {k} missing"):
                rep.check(z[k].shape == (M, M), f"static.npz: {k} shape {z[k].shape}")
        if all(k in z for k in STATIC_NPZ_KEYS):
            rep.check(z["fuel_model"].dtype == np.int16, f"static.npz: fuel_model dtype {z['fuel_model'].dtype}")
            rep.check(float(np.nanmin(z["aspect"])) >= 0 and float(np.nanmax(z["aspect"])) <= 360, "static.npz: aspect outside 0..360")
            rep.check(float(np.nanmin(z["slope"])) >= 0, "static.npz: negative slope")
            rep.check(0 <= float(np.nanmin(z["canopy_cover"])) and float(np.nanmax(z["canopy_cover"])) <= 1, "static.npz: canopy_cover not 0..1")
            rep.check(float(np.nanmax(z["canopy_bulk_density"])) < 2, "static.npz: canopy_bulk_density > 2 kg/m³ (unscaled?)")
            rep.check(float(np.nanmax(z["canopy_base_height"])) < 100, "static.npz: canopy_base_height > 100 m (unscaled?)")
            if "fuel" in arrays:   # identical except nodata: 0 in fuel.bin, non-burnable 99 for the simulation (SPEC 8.2)
                fl, fz = arrays["fuel"].astype(np.int64), z["fuel_model"].astype(np.int64)
                rep.check(bool(np.all((fl == fz) | ((fl == 0) & (fz == 99)))), "static.npz fuel_model != layers/fuel.bin")
            # aspect convention spot check: downslope-facing (the direction of steepest descent)
            el = z["elevation"].astype(np.float64)
            res = float(g["fire"]["res_m"])
            dr, dc = np.gradient(el, res)
            de, dn = dc, -dr                                    # d(elev)/d(east), d(elev)/d(north)
            asp = np.degrees(np.arctan2(-de, -dn)) % 360        # direction of descent, cw from N
            steep = np.hypot(de, dn) > 0.2
            if steep.any():
                diff = np.abs(((asp - z["aspect"]) + 180) % 360 - 180)[steep]
                rep.check(float(np.median(diff)) < 10, f"static.npz: aspect is not downslope-facing (median diff {np.median(diff):.0f}°)")
    # JSON files
    tr = m.get("time_range") or {}
    if m.get("mode") == "live" and "last_detection_ms" in tr:
        # live start (SPEC 8.3): burned area known to last_detection_ms; now_ms may be a later confirmed quiet pass
        rep.check(tr["last_detection_ms"] <= tr["now_ms"] == tr["end_ms"], "time_range: live now_ms must equal end_ms and be >= last_detection_ms")
        if tr.get("last_pass_ms") is not None and tr["now_ms"] > tr["last_detection_ms"]:
            rep.check(tr["now_ms"] == tr["last_pass_ms"], "time_range: a now_ms after the last detection must be the last confirmed pass")
        try:
            act = json.loads((bdir / "sim" / "activity.json").read_text())
            rep.check(act.get("now_ms") == tr["now_ms"] and act.get("last_detection_ms") == tr["last_detection_ms"],
                      "sim/activity.json disagrees with time_range")
            rep.note(f"live start: {act.get('rule')}, {act.get('quiet_passes')} quiet pass(es), {len(act.get('markers') or [])} activity marker(s)")
        except (OSError, ValueError) as e:
            rep.check(False, f"sim/activity.json unreadable: {e}")
        try:
            obs_live = bundle.read_layer(bdir, "observed_arrival", m)
            hours = (tr["last_detection_ms"] - m["time_origin_ms"]) / HOUR_MS
            rep.check(float(obs_live[obs_live < 1e5].max(initial=0.0)) <= hours + 1e-3, "observed arrival after the last detection")
        except (KeyError, OSError, ValueError):
            pass
    elif m.get("mode") != "live":
        rep.check("last_detection_ms" not in tr and "last_pass_ms" not in tr, "time_range: live-only fields in a historical bundle")
    det = _strict(rep, DetectionsFile, bdir / "detections.json", "detections.json")
    per = _strict(rep, PerimetersFile, bdir / "perimeters.json", "perimeters.json")
    ts = _strict(rep, TimeseriesFile, bdir / "timeseries.json", "timeseries.json")
    ev = _strict(rep, EventsFile, bdir / "events.json", "events.json")
    wx = _strict(rep, WeatherFile, bdir / "weather.json", "weather.json")
    st = m.get("stats") or {}
    if det is not None:
        d = det["detections"]
        rep.check(st.get("detections") == len(d), f"stats.detections {st.get('detections')} != {len(d)}")
        by = {}
        for r in d:
            by[r["instrument"]] = by.get(r["instrument"], 0) + 1
        rep.note(f"detections by instrument: {by}")
        if d:
            t = np.array([r["t_ms"] for r in d])
            rep.check(bool(np.all(t >= tr["start_ms"] - 12 * HOUR_MS) and np.all(t <= tr["now_ms"] + HOUR_MS)) or m["mode"] == "historical",
                      "detections outside the time range")
    if per is not None:
        pp = per["perimeters"]
        rep.check(st.get("perimeters") == len(pp), f"stats.perimeters {st.get('perimeters')} != {len(pp)}")
        ts_ = [p["t_ms"] for p in pp]
        rep.check(ts_ == sorted(ts_), "perimeters not sorted by time")
        ac = [p["acres"] for p in pp]
        rep.check(all(b >= a * 0.999 for a, b in zip(ac, ac[1:])), f"perimeter acres not monotone: {ac}")
        for p in pp:
            nv = sum(len(r) for r in p["rings"])
            rep.check(nv <= 1500, f"perimeter at {p['t_ms']} has {nv} vertices > 1500")
    if ts is not None:
        t = np.asarray(ts["t_ms"], dtype=np.int64)
        rep.check(ts["step_h"] == 1 and bool(np.all(np.diff(t) == HOUR_MS)), "timeseries not hourly")
        if t.size:
            rep.check(int(t[0]) == tr["start_ms"] and int(t[-1]) <= tr["now_ms"] < int(t[-1]) + HOUR_MS,
                      "timeseries t_ms does not span time_range.start_ms..now_ms")
        for k in ("area_acres", "growth_acres_per_h", "ros_ch_per_h", "detections_per_h", "frp_mw_per_h"):
            if k == "frp_mw_per_h" and k not in ts:
                rep.bad("timeseries: frp_mw_per_h missing")
                continue
            rep.check(len(ts[k]) == t.size, f"timeseries: {k} has {len(ts[k])} values, t_ms {t.size}")
        if det is not None and "frp_mw_per_h" in ts:
            n_goes = sum(1 for r in det["detections"] if r["instrument"] == "GOES")
            rep.note(f"FRP series: max {max(ts['frp_mw_per_h'] or [0]):,.0f} MW, {n_goes} GOES detections in the bundle "
                     f"({'GOES-based' if n_goes else 'polar-orbiter based'})")
        a = np.asarray(ts["area_acres"])
        rep.check(bool(np.all(np.diff(a) >= -1e-6)), "timeseries area not monotone")
        if a.size and st.get("final_acres_observed"):
            rep.check(abs(a[-1] - st["final_acres_observed"]) <= 0.02 * st["final_acres_observed"] + 5,
                      f"timeseries final area {a[-1]:,.0f} != stats {st['final_acres_observed']:,.0f}")
    if ev is not None:
        e = ev["events"]
        rep.check(len(e) <= 12, f"{len(e)} events > 12")
        rep.check([x["t_ms"] for x in e] == sorted(x["t_ms"] for x in e), "events not chronological")
        rep.note("events: " + ", ".join(sorted({x['type'] for x in e})))
    if wx is not None:
        t = np.asarray(wx["t_ms"], dtype=np.int64)
        rep.check(bool(np.all(np.diff(t) == HOUR_MS)), "weather not hourly")
        for k, v in wx["at_fire"].items():
            rep.check(len(v) == t.size, f"weather.at_fire.{k}: {len(v)} values, t_ms {t.size}")
        for k in ("flame_length_ft", "ros_ch_per_h_potential"):
            rep.check(k in wx["at_fire"], f"weather.at_fire.{k} missing (behaviour annotation)")
        rep.check(len(wx["grid"]["u_ms"]) == t.size * 16 == len(wx["grid"]["v_ms"]), "weather grid u/v length != T*16")
        if t.size:
            rep.check(int(t[0]) <= tr["start_ms"] and int(t[-1]) >= tr["end_ms"], "weather does not cover the time range")
    if m.get("ignition"):
        ig = m["ignition"]
        rep.check(abs(ig["x"]) < g["extent_m"] / 2 and abs(ig["z"]) < g["extent_m"] / 2, "ignition outside the AOI")
        if "observed_arrival" in arrays:
            r, c = fire.local_to_rowcol(ig["x"], ig["z"])
            ri, ci = int(math.floor(r)), int(math.floor(c))
            a_ig = float(arrays["observed_arrival"][ri, ci])
            rep.check(a_ig < NEVER * 0.5, "ignition pixel never burns in observed_arrival")
            rep.check(abs(a_ig - (ig["t_ms"] - m["time_origin_ms"]) / HOUR_MS) < 0.05,
                      f"ignition pixel arrival {a_ig:.2f} h != ignition time")
    if "observed_arrival" in arrays and st.get("final_acres_observed"):
        a = arrays["observed_arrival"]
        ac = np.count_nonzero(a < NEVER * 0.5) * g["fire"]["res_m"] ** 2 / config.ACRE_M2
        rep.check(abs(ac - st["final_acres_observed"]) < 0.01 * ac + 1, "stats.final_acres_observed != observed_arrival area")
    # forecasts
    for f in m.get("forecasts") or []:
        check_forecast(rep, bdir, m, f)
    return rep, m


def check_forecast(rep: Report, bdir: Path, m: dict, f: dict) -> None:
    rid = f["run_id"]
    fm = _strict(rep, ForecastManifest, bdir / f["file"], f"forecast {rid}")
    if fm is None:
        return
    rep.check(fm["status"] == f["status"], f"forecast {rid}: forecast.json status {fm['status']} != manifest {f['status']}")
    if fm["status"] != "ready":
        rep.note(f"forecast {rid}: status {fm['status']} ({fm.get('error', '')[:80]})")
        return
    M = m["grid"]["fire"]["width"]
    arr = {}
    for k, info in fm["layers"].items():
        p = bdir / info["file"]
        if rep.check(p.is_file() and p.stat().st_size == M * M * 4, f"forecast {rid}: {k} file missing or wrong size"):
            arr[k] = bundle.read_array(bdir, info)
    if {"arrival_p10", "arrival_p50", "arrival_p90", "burn_probability"} <= set(arr):
        p10, p50, p90, bp = arr["arrival_p10"], arr["arrival_p50"], arr["arrival_p90"], arr["burn_probability"]
        rep.check(bool(np.all(p10 <= p50) and np.all(p50 <= p90)), f"forecast {rid}: quantiles not ordered p10<=p50<=p90")
        rep.check(float(bp.min()) >= 0 and float(bp.max()) <= 1, f"forecast {rid}: burn_probability outside 0..1")
        end_h = (fm["start_ms"] + fm["horizon_h"] * HOUR_MS - m["time_origin_ms"]) / HOUR_MS
        b50 = p50 <= end_h + 1e-3
        rep.check(bool(np.all(bp[b50] >= 0.5 - 1e-6)), f"forecast {rid}: p50 burned by the horizon where probability < 0.5")
        start_h = (fm["start_ms"] - m["time_origin_ms"]) / HOUR_MS
        rep.check(float(p10[p10 < NEVER * 0.5].min(initial=start_h)) >= start_h - 1e-3, f"forecast {rid}: arrival before the start")
    s = fm["series"]
    n = fm["horizon_h"] + 1
    for k in ("t_ms", "area_acres_p10", "area_acres_p50", "area_acres_p90", "ros_ch_per_h_p50"):
        rep.check(len(s[k]) == n, f"forecast {rid}: series {k} has {len(s[k])} values, expected {n}")
    rep.note(f"forecast {rid}: {fm['weather']['ensemble']} x{fm['weather']['members']}, start {fm['start_ms']}, "
             f"runtime {fm['runtime_s']:.0f} s, skill {[(x['lead_h'], round(x['sorensen'], 3)) for x in fm.get('skill') or []]}")


# ----------------------------------------------------------------------------------------------------------------
# Quick-looks
# ----------------------------------------------------------------------------------------------------------------
def _outline(mask: np.ndarray) -> np.ndarray:
    m = np.asarray(mask, dtype=bool)
    e = np.zeros_like(m)
    e[1:] |= m[1:] ^ m[:-1]
    e[:, 1:] |= m[:, 1:] ^ m[:, :-1]
    return e


def _up(a: np.ndarray, size: int) -> np.ndarray:
    k = size // a.shape[0]
    return np.repeat(np.repeat(a, k, axis=0), k, axis=1) if k > 1 else a


def write_quicklooks(bdir: Path, out: Path, prefix: str) -> list[Path]:
    from PIL import Image, ImageDraw

    from fire3d.build import aoi, observed
    from fire3d.sources import terrain

    out.mkdir(parents=True, exist_ok=True)
    m = bundle.load_manifest(bdir) or {}
    render, fire = grids_from_manifest(m)
    tmp = Path(tempfile.mkdtemp(prefix="fire3d-ql-"))
    paths: list[Path] = []
    try:
        aoi.write_quicklooks(bdir, tmp, "x")
        elev, _ = observed.fire_elevation(bdir, fire, m, allow_fetch=False)
        observed.write_quicklooks(bdir, tmp, "x", elev)
        for src, dst in (("hillshade-skyview.png", "hillshade-skyview.png"), ("fuels.png", "fuels.png"),
                         ("water.png", "water.png"), ("dnbr.png", "dnbr.png"), ("naip.jpg", "naip.jpg"),
                         ("naip-contours.png", "naip-contours.png"), ("arrival.png", "observed-arrival.png"),
                         ("series.png", "observed-series.png")):
            if (tmp / f"x-{src}").is_file():
                shutil.copy(tmp / f"x-{src}", out / f"{prefix}-{dst}")
                paths.append(out / f"{prefix}-{dst}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    S = 1024
    ext = float(m["grid"]["extent_m"])

    def px(x: float, z: float) -> tuple[float, float]:
        return ((x / ext + 0.5) * S, (z / ext + 0.5) * S)

    per = (bundle.read_json(bdir / "perimeters.json") or {}).get("perimeters") or []
    dem = bundle.read_layer(bdir, "elevation", m)
    hs = terrain.hillshade(dem, float(m["grid"]["render"]["res_m"]))
    obs = bundle.read_layer(bdir, "observed_arrival", m)
    obs_edge = _up(_outline(obs < NEVER * 0.5), S)
    # dNBR with the latest perimeter (white) and the observed final extent (cyan): independent georeferencing check
    lay = m.get("layers") or {}
    if "burn_severity" in lay:
        d = bundle.read_layer(bdir, "burn_severity", m)
        v = np.where(d <= -9000, np.nan, d)
        u = np.clip(np.nan_to_num(v, nan=0.0) / 0.8, 0, 1)
        base = terrain.nearest_resample(hs, d.shape) * 90 + 30
        rgb = np.stack([base + u * (255 - base), base * (1 - u * 0.6), base * (1 - u)], -1)
        rgb[np.isnan(v)] = [20, 40, 90]
        img = np.clip(_up(rgb, S), 0, 255).astype(np.uint8)
        img[obs_edge] = [60, 230, 255]
        im = Image.fromarray(img)
        dr = ImageDraw.Draw(im)
        if per:
            for ring in per[-1]["rings"]:
                dr.line([px(a, c) for a, c in ring], fill=(255, 255, 255), width=1)
        dr.text((8, 8), f"{m['name']}: Sentinel-2 dNBR (black->red 0..0.8), observed extent cyan, latest WFIGS perimeter white", fill=(255, 255, 255))
        p = out / f"{prefix}-dnbr-perimeter.png"
        im.save(p)
        paths.append(p)
    # NAIP thumbnail with the latest perimeter and detections
    if "naip" in lay:
        with Image.open(bdir / lay["naip"]["file"]) as im0:
            im = im0.convert("RGB").resize((S, S), Image.LANCZOS)
        dr = ImageDraw.Draw(im)
        if per:
            for ring in per[-1]["rings"]:
                dr.line([px(a, c) for a, c in ring], fill=(255, 80, 40), width=2)
        dets = (bundle.read_json(bdir / "detections.json") or {}).get("detections") or []
        for r in dets[:: max(1, len(dets) // 3000)]:
            if r["instrument"] in ("VIIRS", "LANDSAT"):
                X, Y = px(r["x"], r["z"])
                dr.point((X, Y), fill=(255, 230, 0))
        dr.text((8, 8), f"{m['name']}: NAIP, latest perimeter orange, VIIRS/Landsat detections yellow", fill=(255, 255, 255))
        p = out / f"{prefix}-naip-perimeter.png"
        im.save(p)
        paths.append(p)
    for f in m.get("forecasts") or []:
        if f.get("status") == "ready":
            paths.append(forecast_quicklook(bdir, m, f, out / f"{prefix}-forecast-{f['run_id']}.png", hs, obs))
    return paths


def forecast_quicklook(bdir: Path, m: dict, f: dict, path: Path, hs: np.ndarray, obs: np.ndarray) -> Path:
    from PIL import Image, ImageDraw

    from fire3d.sources import terrain

    fm = bundle.read_json(bdir / f["file"])
    M = m["grid"]["fire"]["width"]
    S = 1024
    origin = m["time_origin_ms"]
    start_h = (fm["start_ms"] - origin) / HOUR_MS
    bp = bundle.read_array(bdir, fm["layers"]["burn_probability"])
    p50 = bundle.read_array(bdir, fm["layers"]["arrival_p50"])
    base = terrain.nearest_resample(hs, (M, M)) * 110 + 30
    rgb = np.repeat(base[..., None], 3, axis=-1)
    u = np.clip(bp, 0, 1)[..., None]
    ramp = np.where(u < 0.5, np.array([230, 190, 90]) * (u * 2), np.array([230, 190, 90]) + (np.array([220, 40, 30]) - np.array([230, 190, 90])) * (u * 2 - 1))
    rgb = np.where(bp[..., None] > 0, rgb * (1 - 0.75 * np.minimum(1, u * 3)) + ramp * 0.75 * np.minimum(1, u * 3), rgb)
    img = np.clip(_up(rgb, S), 0, 255).astype(np.uint8)
    for lead, col in ((12, (255, 255, 255)), (24, (120, 255, 120)), (48, (90, 200, 255)), (72, (200, 120, 255))):
        if lead <= fm["horizon_h"]:
            img[_up(_outline(p50 <= start_h + lead), S)] = col
    img[_up(_outline(obs <= start_h), S)] = [0, 0, 0]
    img[_up(_outline(obs < NEVER * 0.5), S)] = [60, 230, 255]
    im = Image.fromarray(img)
    dr = ImageDraw.Draw(im)
    # mean wind over the forecast at the fire (FROM convention -> arrow points downwind)
    wx = bundle.read_json(bdir / "weather.json")
    t = np.asarray(wx["t_ms"])
    sel = (t >= fm["start_ms"]) & (t <= fm["start_ms"] + min(24, fm["horizon_h"]) * HOUR_MS)
    if sel.any():
        spd = np.asarray(wx["at_fire"]["wind_speed_ms"], dtype=float)[sel]
        dirs = np.radians(np.asarray(wx["at_fire"]["wind_dir_deg"], dtype=float)[sel])
        uu, vv = np.mean(-spd * np.sin(dirs)), np.mean(-spd * np.cos(dirs))
        frm = (math.degrees(math.atan2(-uu, -vv)) + 360) % 360
        L = 80
        cx, cy = 90, S - 90
        ex, ey = cx + uu / max(1e-6, math.hypot(uu, vv)) * L, cy - vv / max(1e-6, math.hypot(uu, vv)) * L
        dr.line([(cx, cy), (ex, ey)], fill=(255, 255, 255), width=4)
        dr.ellipse([ex - 6, ey - 6, ex + 6, ey + 6], fill=(255, 255, 255))
        dr.text((cx - 70, cy + 60), f"mean wind first 24 h: from {frm:.0f}° at {math.hypot(uu, vv):.1f} m/s (arrow = downwind)", fill=(255, 255, 255))
    sk = fm.get("skill") or []
    lines = [f"{m['name']} {fm['run_id']}: {fm['weather']['ensemble']} x{fm['weather']['members']}, adj {fm['model']['spread_adjustment']}, "
             f"spotting {fm['model']['spotting']}, {fm['runtime_s']:.0f} s",
             "burn probability gold->red; p50 front +12 white, +24 green, +48 blue, +72 violet; start mask black; observed final cyan",
             "skill: " + ", ".join(f"+{s['lead_h']:.0f}h S={s['sorensen']:.2f} ({s['forecast_acres_p50']:,.0f}/{s['observed_acres']:,.0f} ac)" for s in sk)]
    for i, line in enumerate(lines):
        dr.text((8, 8 + 14 * i), line, fill=(255, 255, 255))
    im.save(path)
    return path


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("incident")
    ap.add_argument("--quicklook", type=Path, default=None, help="directory for quick-look PNGs")
    ap.add_argument("--prefix", default=None, help="file prefix (default backend-<incident id>)")
    args = ap.parse_args(argv)
    bdir = bundle.bundle_dir(args.incident)
    rep, m = check_bundle(bdir)
    print(f"{args.incident}: {len(rep.problems)} problem(s)")
    for p in rep.problems:
        print(f"  PROBLEM {config.mask_secrets(p)}")
    for n in rep.notes:
        print(f"  note    {config.mask_secrets(n)}")
    if args.quicklook and m:
        for p in write_quicklooks(bdir, args.quicklook, args.prefix or f"backend-{args.incident}"):
            print(f"  quicklook {p}")
    return 1 if rep.problems else 0


if __name__ == "__main__":
    sys.exit(main())
