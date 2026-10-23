"""Surface fire behaviour (Rothermel via pyretechnics) and the at-fire weather annotation (SPEC 7.3). Owner: spread agent.

* :func:`surface_behavior` - head-fire surface behaviour of one fuel model under given moisture, 10 m wind and
  slope, computed with ``pyretechnics.burn_cells.burn_cell_as_head_fire`` on 1 x 1 x 1 constant cubes with the
  wind blowing straight upslope (the maximum-spread "potential" case) and crowning disabled.
* :func:`annotate_weather_with_behavior` - adds ``at_fire.flame_length_ft`` and ``at_fire.ros_ch_per_h_potential``
  to ``weather.json``: for every hour, the behaviour of the dominant burnable fuel within 2 km of the fire front
  (centroid of the pixels that burned in the previous hour of ``observed_arrival``, else the most recently burned
  pixels, else the ignition point), with that zone's median slope and canopy sheltering, the hour's at-fire wind
  and dead fuel moisture, and the month's live fuel moisture.
"""

from __future__ import annotations

import logging
import math
from pathlib import Path

import numpy as np

from .. import bundle as fbundle
from .. import config
from ..timeutil import local_month, zone_of
from . import engine, moisture

log = logging.getLogger(__name__)

ZONE_RADIUS_M = 2000.0           # dominant-fuel search radius around the front
RECENT_PIXELS = 50               # pixels used for the front location when nothing burned in the last hour
M_PER_FT = 0.3048


def _live_moisture_by_hour(bdir: Path, man: dict, tz: str | None, precip_wy: float | None):
    """``f(t_ms) -> (herb, woody)``: outside California the NFDRS 2016 GSI of that local day (``sim/lfm_gsi.json``,
    CONTRACT 14.12.10), else (California, or no series / no 21 days: the never-silent fallback whose note the
    manifest and every forecast carry) the month table with the drought adjustment, as before brief 3."""
    gsi_doc = None
    try:
        from ..build.weather_bundle import gsi_at, is_california, load_lfm_gsi

        if not is_california(man.get("summary") or {}) and not config.LFM_FORCE_CALIFORNIA:
            gsi_doc = load_lfm_gsi(bdir)
    except Exception as e:  # noqa: BLE001 - the month table is the documented fallback
        log.info("annotate_weather_with_behavior: no GSI series (%s)", e)
    by_day: dict = {}

    def f(t_ms: int) -> tuple[float, float]:
        if gsi_doc is not None:
            from ..timeutil import local_dt

            day = local_dt(int(t_ms), tz).date()
            if day not in by_day:
                g = gsi_at(gsi_doc, int(t_ms))
                by_day[day] = None if g is None else moisture.gsi_live_fuel_moisture(g["gsi"])
            if by_day[day] is not None:
                return by_day[day]
        return moisture.live_fuel_moisture(local_month(int(t_ms), tz), precip_wy)

    return f


def _clip(v: float, lo: float, hi: float) -> float:
    v = float(v)
    if not math.isfinite(v):
        return lo
    return min(max(v, lo), hi)


def surface_behavior(
    fuel_code: int,
    fm1: float,
    fm10: float,
    fm100: float,
    fm_live_herb: float,
    fm_live_woody: float,
    wind_10m_kmh: float,
    slope: float,
    *,
    canopy_cover: float = 0.0,
    canopy_height_m: float = 0.0,
    spread_adjustment: float = 1.0,
    surface_lw_ratio_model: str = "behave",
) -> dict:
    """Head-fire surface behaviour for one fuel model and conditions.

    Moistures are fractions (kg/kg), ``wind_10m_kmh`` the 10 m wind, ``slope`` rise/run; wind and slope are
    aligned (head fire). ``canopy_cover`` (0-1) / ``canopy_height_m`` only shelter the midflame wind. Unknown and
    non-burnable codes give zero behaviour. Returns ``fuel_code``, ``burnable``, ``fire_type``, ``ros_m_per_min``,
    ``ros_ch_per_h``, ``flame_length_m``, ``flame_length_ft`` and ``fireline_intensity_kw_m``.
    """
    from pyretechnics.burn_cells import burn_cell_as_head_fire
    from pyretechnics.space_time_cube import SpaceTimeCube

    shape = (1, 1, 1)
    code = int(engine.sanitize_fuel_codes(np.array([fuel_code]))[0])

    def cube(v: float) -> SpaceTimeCube:
        return SpaceTimeCube(shape, float(v))

    cubes = {
        "slope": cube(_clip(slope, 0.0, engine.MAX_SLOPE)),
        "aspect": cube(0.0),                                  # faces north: upslope points south
        "fuel_model": cube(code),
        "canopy_cover": cube(_clip(canopy_cover, 0.0, 1.0)),
        "canopy_height": cube(_clip(canopy_height_m, 0.0, 100.0)),
        "canopy_base_height": cube(engine.NO_CROWN_CBH_M),    # surface fire only
        "canopy_bulk_density": cube(0.0),
        "wind_speed_10m": cube(_clip(wind_10m_kmh, 0.0, 250.0)),
        "upwind_direction": cube(0.0),                        # from the north, blowing south = upslope
        "fuel_moisture_dead_1hr": cube(_clip(fm1, 0.01, 0.6)),
        "fuel_moisture_dead_10hr": cube(_clip(fm10, 0.01, 0.6)),
        "fuel_moisture_dead_100hr": cube(_clip(fm100, 0.01, 0.6)),
        "fuel_moisture_live_herbaceous": cube(_clip(fm_live_herb, 0.3, 3.0)),
        "fuel_moisture_live_woody": cube(_clip(fm_live_woody, 0.3, 3.0)),
        "foliar_moisture": cube(config.FOLIAR_MOISTURE),
    }
    if spread_adjustment != 1.0:
        cubes["weather_spread_adjustment"] = cube(max(0.0, float(spread_adjustment)))
    b = burn_cell_as_head_fire(cubes, (0, 0, 0), surface_lw_ratio_model=surface_lw_ratio_model)
    ros = float(b["spread_rate"])
    flame = float(b["flame_length"])
    return {
        "fuel_code": code,
        "burnable": bool(engine.is_burnable_code(np.array([code]))[0]),
        "fire_type": int(b["fire_type"]),
        "ros_m_per_min": ros,
        "ros_ch_per_h": ros * 60.0 / config.CHAIN_M,
        "flame_length_m": flame,
        "flame_length_ft": flame / M_PER_FT,
        "fireline_intensity_kw_m": float(b["fireline_intensity"]),
    }


# ----------------------------------------------------------------------------------------------------------------
# Front location and fuel zone
# ----------------------------------------------------------------------------------------------------------------
def _default_cell(manifest: dict, shape: tuple[int, int], res: float) -> tuple[float, float]:
    ign = manifest.get("ignition") or {}
    x, z = float(ign.get("x", 0.0)), float(ign.get("z", 0.0))
    rows, cols = shape
    r = (z + rows * res / 2.0) / res - 0.5
    c = (x + cols * res / 2.0) / res - 0.5
    return float(np.clip(r, 0, rows - 1)), float(np.clip(c, 0, cols - 1))


def front_cells(manifest: dict, observed: np.ndarray | None, shape: tuple[int, int], res: float, t_ms: np.ndarray) -> np.ndarray:
    """(T, 2) float (row, col) of the fire front at each hour: centroid of the pixels with arrival in (t - 1 h, t],
    else of the most recently burned pixels before t, else the ignition point."""
    t_ms = np.asarray(t_ms, dtype=np.int64)
    out = np.tile(np.array(_default_cell(manifest, shape, res)), (t_ms.size, 1))
    origin = manifest.get("time_origin_ms")
    if observed is None or origin is None or observed.shape != tuple(shape):
        return out
    burned = observed < config.NEVER * 0.999
    if not burned.any():
        return out
    rr, cc = np.nonzero(burned)
    a = observed[burned].astype(np.float64)
    order = np.argsort(a, kind="stable")
    a, rr, cc = a[order], rr[order].astype(np.float64), cc[order].astype(np.float64)
    cr = np.concatenate([[0.0], np.cumsum(rr)])
    ccum = np.concatenate([[0.0], np.cumsum(cc)])
    th = (t_ms - int(origin)) / config.MS_PER_H
    hi = np.searchsorted(a, th + 1e-6, side="right")
    lo = np.searchsorted(a, th - 1.0 + 1e-6, side="right")
    lo = np.where(hi - lo > 0, lo, np.maximum(0, hi - RECENT_PIXELS))
    ok = hi > 0
    cnt = np.maximum(hi - lo, 1)
    out[ok, 0] = (cr[hi] - cr[lo])[ok] / cnt[ok]
    out[ok, 1] = (ccum[hi] - ccum[lo])[ok] / cnt[ok]
    return out


def fuel_zone(static, row: float, col: float, radius_m: float | None = None) -> dict | None:
    """Dominant burnable FBFM code within ``radius_m`` (default :data:`ZONE_RADIUS_M`) of (row, col), the zone's
    median slope over burnable cells and the median canopy cover/height of the dominant fuel's cells; None if
    nothing burnable is in range."""
    fuel = static.fuel_model
    h, w = fuel.shape
    rad = float(radius_m if radius_m is not None else ZONE_RADIUS_M) / float(static.res_m)
    r0, r1 = max(0, int(math.floor(row - rad))), min(h, int(math.ceil(row + rad)) + 1)
    c0, c1 = max(0, int(math.floor(col - rad))), min(w, int(math.ceil(col + rad)) + 1)
    if r0 >= r1 or c0 >= c1:
        return None
    yy, xx = np.mgrid[r0:r1, c0:c1]
    disk = (yy - row) ** 2 + (xx - col) ** 2 <= rad * rad
    codes = engine.sanitize_fuel_codes(fuel[r0:r1, c0:c1])[disk]
    burn = engine.is_burnable_code(codes)
    if not burn.any():
        return None
    vals, counts = np.unique(codes[burn], return_counts=True)
    dom = int(vals[int(np.argmax(counts))])
    same = codes == dom
    return {
        "fuel_code": dom,
        "share": float(counts.max() / burn.sum()),
        "slope": float(np.median(np.asarray(static.slope[r0:r1, c0:c1])[disk][burn])),
        "canopy_cover": float(np.median(np.asarray(static.canopy_cover[r0:r1, c0:c1])[disk][same])),
        "canopy_height": float(np.median(np.asarray(static.canopy_height[r0:r1, c0:c1])[disk][same])),
    }


def _series(af: dict, key: str, n: int) -> np.ndarray | None:
    v = af.get(key)
    if v is None or len(v) != n:
        return None
    a = np.array([np.nan if x is None else float(x) for x in v], dtype=np.float64)
    return engine.fill_nan_time(a, np.nan) if np.isfinite(a).any() else None


def annotate_weather_with_behavior(bundle_dir: Path) -> None:
    """Add ``at_fire.flame_length_ft`` and ``at_fire.ros_ch_per_h_potential`` to the bundle's weather.json.

    Needs ``weather.json`` (at-fire wind; dead fuel moisture or temperature/RH) and ``sim/static.npz``; the
    front follows ``observed_arrival`` when present. Missing inputs leave the file unchanged (logged warning).
    """
    bdir = Path(bundle_dir)
    wpath = bdir / "weather.json"
    if not wpath.is_file():
        log.warning("annotate_weather_with_behavior: %s has no weather.json", bdir)
        return
    try:
        static = engine.load_static_inputs(bdir)
    except (OSError, ValueError) as e:
        log.warning("annotate_weather_with_behavior: no static inputs (%s)", e)
        return
    raw = wpath.read_bytes()
    w = fbundle.read_json(wpath)
    t = np.asarray(w.get("t_ms") or [], dtype=np.int64)
    n = int(t.size)
    af = w.get("at_fire") or {}
    wind = _series(af, "wind_speed_ms", n)
    if n == 0 or wind is None:
        log.warning("annotate_weather_with_behavior: weather.json has no at-fire wind")
        return
    fms = [_series(af, k, n) for k in ("fm1_pct", "fm10_pct", "fm100_pct")]
    if any(f is None for f in fms):
        temp = _series(af, "temp_c", n)
        rh = _series(af, "rh_pct", n)
        if temp is None or rh is None:
            log.warning("annotate_weather_with_behavior: weather.json has neither fuel moisture nor temperature/RH")
            return
        fm1, fm10, fm100 = (np.asarray(x) for x in moisture.dead_fuel_moisture(temp, rh))
    else:
        fm1, fm10, fm100 = (np.asarray(f) / 100.0 for f in fms)
    man = fbundle.load_manifest(bdir) or {}
    tz = zone_of(man)                 # the live fuel moisture month follows the fire's own zone (CONTRACT 14.9.7)
    observed = None
    if "observed_arrival" in (man.get("layers") or {}):
        try:
            observed = fbundle.read_layer(bdir, "observed_arrival", man)
        except (OSError, ValueError, KeyError) as e:
            log.warning("annotate_weather_with_behavior: observed_arrival unreadable (%s)", e)
    shape = static.fuel_model.shape
    cells = front_cells(man, observed, shape, float(static.res_m), t)
    whole = fuel_zone(static, shape[0] / 2.0, shape[1] / 2.0, radius_m=float(static.res_m) * max(shape))
    zones: dict[tuple[int, int], dict | None] = {}
    precip_wy = None
    try:   # drought-adjusted live fuel moisture (water-year precipitation stored by build_weather)
        from ..build.weather_bundle import precip_to

        precip_wy, _ = precip_to(bdir, man, int(t[0]), fetch=False)
    except Exception as e:  # noqa: BLE001 - the plain month table is a safe fallback
        log.info("annotate_weather_with_behavior: no water-year precipitation (%s)", e)
    live_fm = _live_moisture_by_hour(bdir, man, tz, precip_wy)
    flame_ft = np.zeros(n)
    ros_ch = np.zeros(n)
    for k in range(n):
        key = (int(cells[k, 0]) // 4, int(cells[k, 1]) // 4)
        if key not in zones:
            zones[key] = fuel_zone(static, float(cells[k, 0]), float(cells[k, 1])) or whole
        z = zones[key]
        if z is None:
            continue
        herb, woody = live_fm(int(t[k]))
        b = surface_behavior(z["fuel_code"], fm1[k], fm10[k], fm100[k], herb, woody, float(wind[k]) * 3.6, z["slope"],
                             canopy_cover=z["canopy_cover"], canopy_height_m=z["canopy_height"])
        flame_ft[k] = b["flame_length_ft"]
        ros_ch[k] = b["ros_ch_per_h"]
    af["flame_length_ft"] = [round(float(v), 2) if math.isfinite(v) else 0.0 for v in flame_ft]
    af["ros_ch_per_h_potential"] = [round(float(v), 2) if math.isfinite(v) else 0.0 for v in ros_ch]
    w["at_fire"] = af
    fbundle.write_json(wpath, w, indent=raw[:400].count(b"\n") > 2)
    log.info("weather.json annotated: %d hours, %d fuel zone(s)", n, len(zones))
