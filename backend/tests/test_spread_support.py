"""Synthetic inputs shared by the spread tests (helpers only; this module holds no tests).

Everything is small (48-64 cells at 30 m, a few hours) so the spread tests stay fast and offline.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from fire3d import bundle, config
from fire3d.grid import weather_axes, Grid
from fire3d.types import MemberWeather, StaticInputs

H = config.MS_PER_H
ORIGIN = 1_755_000_000_000 // H * H          # an hour boundary (2025-08-12)


def make_static(m: int = 48, fuel=102, slope: float = 0.0, aspect: float = 0.0, res: float = 30.0,
                canopy_cover: float = 0.0, canopy_height: float = 0.0, cbh: float = 0.0, cbd: float = 0.0) -> StaticInputs:
    """Uniform static inputs (``fuel`` may be a code or an (m, m) array)."""
    f = np.full((m, m), fuel, np.int16) if np.ndim(fuel) == 0 else np.asarray(fuel, np.int16)

    def full(v):
        return np.full((m, m), v, np.float32)

    return StaticInputs(fuel_model=f, slope=full(slope), aspect=full(aspect), canopy_cover=full(canopy_cover),
                        canopy_height=full(canopy_height), canopy_base_height=full(cbh), canopy_bulk_density=full(cbd),
                        elevation=full(500.0), res_m=res)


def make_weather(t0: int = ORIGIN, hours: int = 24, speed_kmh: float = 0.0, from_deg: float = 270.0, fm1: float = 0.06,
                 fm10: float = 0.08, fm100: float = 0.10, herb: float = 0.3, woody: float = 0.7, label: str = "control",
                 temp: float = 25.0, rh: float = 20.0) -> MemberWeather:
    """Spatially uniform hourly member starting at ``t0``."""
    t = t0 + np.arange(hours, dtype=np.int64) * H

    def f(v):
        return np.full((hours, 4, 4), v, np.float64)

    return MemberWeather(t_ms=t, wind_speed_10m_kmh=f(speed_kmh), upwind_dir_deg=f(from_deg), temp_c=f(temp), rh_pct=f(rh),
                         fm1=f(fm1), fm10=f(fm10), fm100=f(fm100), fm_live_herb=herb, fm_live_woody=woody,
                         foliar_moisture=1.0, label=label)


def extents(arrival: np.ndarray, r: int, c: int) -> dict:
    """Burned extent (cells) north/south/west/east of (r, c)."""
    b = arrival < config.NEVER * 0.999
    rows, cols = np.nonzero(b)
    return {"N": r - rows.min(), "S": rows.max() - r, "W": c - cols.min(), "E": cols.max() - c, "n": int(b.sum())}


def observed_field(m: int, center: tuple[int, int], t_ign_h: float, speed_cells_h: tuple[float, float],
                   final_h: float) -> np.ndarray:
    """Synthetic observed arrival (hours since origin): an ellipse growing from ``center`` faster eastward
    (``speed_cells_h`` = (east, other) cells/h) until ``final_h``; NEVER outside."""
    rr, cc = np.mgrid[0:m, 0:m].astype(np.float64)
    dr, dc = rr - center[0], cc - center[1]
    ve, vo = speed_cells_h
    tt = t_ign_h + np.sqrt((dc / np.where(dc > 0, ve, vo)) ** 2 + (dr / vo) ** 2)
    return np.where(tt <= final_h, tt, config.NEVER).astype(np.float32)


def weather_json(t0: int, hours: int, grid: Grid, speed_ms: float = 4.0, from_deg: float = 270.0) -> dict:
    """A contract-valid WeatherFile dict with a diurnal cycle."""
    t = [int(t0 + k * H) for k in range(hours)]
    ph = np.arange(hours) * 2 * np.pi / 24.0
    temp = 24.0 + 6.0 * np.sin(ph)
    rh = 30.0 - 12.0 * np.sin(ph)
    spd = speed_ms * (1.0 + 0.5 * np.sin(ph))
    u = -spd * np.sin(np.radians(from_deg))
    v = -spd * np.cos(np.radians(from_deg))
    xs, zs = weather_axes(grid)

    def lst(a):
        return [round(float(x), 3) for x in a]

    return {
        "source": "test:synthetic",
        "t_ms": t,
        "at_fire": {
            "temp_c": lst(temp), "rh_pct": lst(rh), "dewpoint_c": lst(temp - 15.0), "wind_speed_ms": lst(spd),
            "wind_dir_deg": [float(from_deg)] * hours, "wind_gust_ms": lst(spd * 1.6), "precip_mm": [0.0] * hours,
            "fm1_pct": lst(4.0 + 0.1 * rh), "fm10_pct": lst(6.0 + 0.05 * rh), "fm100_pct": [9.0] * hours,
            "ffwi": [30.0] * hours,
        },
        "grid": {"nx": 4, "ny": 4, "x": xs, "z": zs, "u_ms": lst(np.repeat(u, 16)), "v_ms": lst(np.repeat(v, 16))},
        "forecast_from_ms": None,
    }


def make_bundle(root: Path, iid: str = "spread-test", m: int = 48, res: float = 30.0, mode: str = "historical",
                fuel=102, observed: np.ndarray | None = None, ignition_rc: tuple[int, int] = (24, 16),
                t_ign_h: float = 2.0, data_end_h: float = 60.0, weather_hours: int = 200, static_kwargs: dict | None = None) -> Path:
    """A minimal bundle (manifest + sim/static.npz + observed_arrival + weather.json) for spread tests.

    ``observed`` defaults to an eastward-growing ellipse from ``ignition_rc`` (2 cells/h east, 0.7 cells/h
    otherwise) observed until ``data_end_h``. The weather starts 72 h before the origin.
    """
    bdir = Path(root) / iid
    bdir.mkdir(parents=True, exist_ok=True)
    extent = m * res
    grid = Grid(32611, 400000.0, 3780000.0, extent, m, m)
    st = make_static(m, fuel=fuel, res=res, **(static_kwargs or {}))
    bundle.write_npz(bdir / bundle.STATIC_NPZ, **{k: getattr(st, k) for k in
                     ("fuel_model", "slope", "aspect", "canopy_cover", "canopy_height", "canopy_base_height",
                      "canopy_bulk_density", "elevation")}, res_m=np.float64(res))
    if observed is None:
        observed = observed_field(m, ignition_rc, t_ign_h, (2.0, 0.7), data_end_h)
    r, c = ignition_rc
    x, z = grid.pixel_center_local(r, c)
    lon, lat = grid.local_to_lonlat(x, z)
    t_ign = int(ORIGIN + t_ign_h * H)
    end = int(ORIGIN + data_end_h * H)
    manifest = {
        "schema_version": 1, "id": iid, "name": "Spread Test Fire", "mode": mode, "status": "ready",
        "summary": {"id": iid, "name": "Spread Test Fire", "mode": mode, "started_ms": t_ign},
        "time_origin_ms": ORIGIN,
        "time_range": {"start_ms": ORIGIN, "end_ms": end, "now_ms": end},
        "grid": {"crs": "EPSG:32611", "utm_zone": 11, "center_e": grid.center_e, "center_n": grid.center_n,
                 "extent_m": extent, "bbox_lonlat": list(grid.bbox_lonlat()),
                 "render": {"width": 1024, "height": 1024, "res_m": extent / 1024},
                 "fire": {"width": m, "height": m, "res_m": res}, "elev_min_m": 500.0, "elev_max_m": 500.0},
        "layers": {},
        "ignition": {"x": float(x), "z": float(z), "lat": float(lat), "lon": float(lon), "t_ms": t_ign, "source": "test"},
        "forecasts": [], "warnings": [], "built_ms": ORIGIN,
    }
    bundle.save_manifest(bdir, manifest)
    bundle.write_layer(bdir, "observed_arrival", observed, "fire", "h", "test observed arrival")
    bundle.write_json(bdir / "weather.json", weather_json(ORIGIN - 72 * H, weather_hours, grid))
    return bdir
