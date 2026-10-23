"""Bundle weather and forecast weather members (SPEC 5, 7.1, 8.4). Owner: weather agent.

* :func:`build_weather` writes ``weather.json`` (WeatherFile: hourly at-fire series with dead fuel moisture and FFWI,
  plus the 4 x 4 u/v grid) and the backend-only ``sim/weather.npz`` (the full deterministic 4 x 4 fields and the
  HRRR mask), which :func:`member_weathers` reuses. Window: historical ``[start − 72 h, end + 72 h]``; live
  ``[max(start, now − 7 d) − 72 h, now + 96 h]``. ``at_fire`` is bilinearly interpolated from the 4 x 4 grid at
  ``manifest.ignition`` (else the AOI centre).
* :func:`member_weathers` builds forecast members on the 4 x 4 grid:

  - ``gfs025`` / ``ecmwf_ifs025`` (live): Open-Meteo ensemble members bias-corrected to HRRR while HRRR exists,
    ``x_i = x_hrrr + (x_i − mean_ens)`` in u/v/T/RH space, blended back to the raw members over 6 h after HRRR ends;
  - ``perturbed``: AR(1) perturbations (τ = 8 h) of the deterministic series; member 0 is unperturbed;
  - ``none``: the deterministic series.

  Dead fuel moisture is recomputed per member after a 72 h spin-up. Output is hourly on
  ``[floor_hour(start), ceil_hour(start + horizon)]``, wind in km/h, RH clamped to 1..100 %.

Both accept ``source=`` (any :class:`~fire3d.sources.weather.WeatherSource`; default :class:`OpenMeteoSource`).
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, replace
from datetime import timedelta
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np
from scipy.signal import lfilter

from .. import bundle, config
from ..contracts import WeatherFile, contract_problems
from ..grid import grids_from_manifest, weather_axes, weather_points
from ..sources.weather import (BLEND_H, OpenMeteoSource, WeatherError, WeatherSource, blend_offsets, ceil_hour_ms, hourly_axis,
                               uv_to_wind, water_year_precip, water_year_start_ms, wind_to_uv)
from ..spread.moisture import dead_fuel_moisture, ffwi, greenup_fraction, live_fuel_moisture
from ..timeutil import DAY_MS, HOUR_MS, floor_hour_ms, ms_to_dt, ms_to_iso, now_ms
from ..types import BuildContext, MemberWeather

log = logging.getLogger(__name__)

N = config.WEATHER_GRID_N                 # 4 x 4 weather grid
WEATHER_JSON = "weather.json"
WEATHER_NPZ = "sim/weather.npz"           # backend-only deterministic 4 x 4 fields (like sim/static.npz)
ANTECEDENT_JSON = "sim/antecedent.json"   # backend-only water-year precipitation at the fire start (live moisture)
SPINUP_H = 72                             # fuel-moisture spin-up before a forecast start
HIST_PAD_H = 72                           # historical window: [start - 72 h, end + 72 h]
LIVE_PAST_DAYS = 7                        # live window: [max(start, now - 7 d) - 72 h, now + 96 h]
LIVE_FUTURE_H = 96
HIST_MAX_DAYS = 45                        # cap on the fallback historical end (SPEC 8.3 time_range rule)

ENSEMBLE_KINDS = ("gfs025", "ecmwf_ifs025", "perturbed", "none")
DEFAULT_MEMBERS = {"gfs025": 31, "ecmwf_ifs025": 51, "perturbed": 31, "none": 1}
PERTURB_TAU_H = 8.0                       # AR(1) decorrelation time
PERTURB_SPEED_SIGMA = 0.25                # wind speed x exp(0.25 z): lognormal, median 1
PERTURB_DIR_SD = 20.0                     # deg
PERTURB_RH_SD = 6.0                       # % RH
PERTURB_TEMP_SD = 1.5                     # °C
PERTURB_SEED = 84_2025                    # member k uses default_rng([PERTURB_SEED, k])
RH_MIN, RH_MAX = 1.0, 100.0
MS_TO_KMH = 3.6
DATA_SOURCE_NAME = "Weather"
WARN_PREFIX = "Weather: "                 # manifest warnings written here (replaced on every rebuild)

_FIELDS = ("temp_c", "rh_pct", "dewpoint_c", "wind_speed_ms", "wind_dir_deg", "wind_gust_ms", "precip_mm")


# ---------------------------------------------------------------------------------------------------------------
# Deterministic weather on the 4 x 4 grid
# ---------------------------------------------------------------------------------------------------------------
@dataclass
class GridWeather:
    """Deterministic hourly weather on the 4 x 4 grid: fields are (T, 4, 4) ``[t][j][i]`` (j row north->south,
    i column west->east), ``t_ms`` (T,) int64, ``hrrr`` (T,) True where HRRR itself had data."""

    t_ms: np.ndarray
    temp_c: np.ndarray
    rh_pct: np.ndarray
    dewpoint_c: np.ndarray
    wind_speed_ms: np.ndarray
    wind_dir_deg: np.ndarray            # FROM, deg clockwise from N
    wind_gust_ms: np.ndarray
    precip_mm: np.ndarray
    hrrr: np.ndarray
    source: str
    forecast_from_ms: int | None = None
    fetched_ms: int | None = None

    @property
    def synthetic(self) -> bool:
        """True for the procedural fixture bundles (never mixed with real fetched data)."""
        return self.source.startswith("fixture")

    @classmethod
    def from_source(cls, res: dict) -> "GridWeather":
        """From a :meth:`WeatherSource.deterministic` result (fields (T, 16), points row-major from the NW)."""
        t = np.asarray(res["t_ms"], dtype=np.int64)
        T = len(t)
        f = {}
        for k in _FIELDS:
            a = np.asarray(res[k], dtype=np.float64)
            if a.shape != (T, N * N):
                raise WeatherError(f"weather field {k} has shape {a.shape}, expected ({T}, {N * N})")
            f[k] = a.reshape(T, N, N)
        hrrr = np.asarray(res.get("hrrr", np.zeros(T, dtype=bool)), dtype=bool).reshape(T)
        ff = res.get("forecast_from_ms")
        fetched = res.get("fetched_ms")
        return cls(t_ms=t, hrrr=hrrr, source=str(res.get("source", "unknown")),
                   forecast_from_ms=None if ff is None else int(ff), fetched_ms=None if fetched is None else int(fetched), **f)

    @classmethod
    def from_weather_json(cls, d: dict) -> "GridWeather":
        """From a WeatherFile dict: wind from the 4 x 4 u/v grid; the other fields are only stored at the fire, so
        they are spread uniformly over the grid. HRRR hours are unknown (all False)."""
        t = np.asarray(d["t_ms"], dtype=np.int64)
        T = len(t)
        g = d["grid"]
        ny, nx = int(g.get("ny", N)), int(g.get("nx", N))
        if (ny, nx) != (N, N):
            raise WeatherError(f"weather.json grid is {ny}x{nx}, expected {N}x{N}")
        u = np.asarray(g["u_ms"], dtype=np.float64).reshape(T, N, N)
        v = np.asarray(g["v_ms"], dtype=np.float64).reshape(T, N, N)
        speed, wdir = uv_to_wind(u, v)
        af = d["at_fire"]

        def spread(name: str) -> np.ndarray:
            return np.repeat(np.repeat(np.asarray(af[name], dtype=np.float64).reshape(T, 1, 1), N, 1), N, 2)

        return cls(t_ms=t, temp_c=spread("temp_c"), rh_pct=spread("rh_pct"), dewpoint_c=spread("dewpoint_c"),
                   wind_speed_ms=speed, wind_dir_deg=wdir, wind_gust_ms=np.maximum(spread("wind_gust_ms"), speed),
                   precip_mm=spread("precip_mm"), hrrr=np.zeros(T, dtype=bool), source=str(d.get("source", WEATHER_JSON)),
                   forecast_from_ms=d.get("forecast_from_ms"))

    def window(self, a_ms: int, b_ms: int) -> tuple["GridWeather", int]:
        """Re-index onto the hourly axis ``[a, b]``. Hours the data lack take the nearest available hour (wind
        held in u/v); returns ``(weather, number of such hours)``."""
        t = hourly_axis(a_ms, b_ms)
        st = self.t_ms
        pos = np.clip(np.searchsorted(st, t), 0, len(st) - 1)
        prev = np.clip(pos - 1, 0, len(st) - 1)
        idx = np.where(np.abs(t - st[prev]) <= np.abs(st[pos] - t), prev, pos)
        exact = st[idx] == t
        f = {k: getattr(self, k)[idx] for k in _FIELDS}
        return replace(self, t_ms=t, hrrr=self.hrrr[idx] & exact, **f), int((~exact).sum())


def save_grid_weather(bdir: Path, gw: GridWeather) -> None:
    """Write ``sim/weather.npz`` (float32 fields, int64 axis, the HRRR mask and provenance)."""
    arrays: dict[str, Any] = {k: np.asarray(getattr(gw, k), dtype=np.float32) for k in _FIELDS}
    bundle.write_npz(Path(bdir) / WEATHER_NPZ, t_ms=np.asarray(gw.t_ms, dtype=np.int64), hrrr=np.asarray(gw.hrrr, dtype=bool),
                     source=np.array(gw.source), forecast_from_ms=np.int64(-1 if gw.forecast_from_ms is None else gw.forecast_from_ms),
                     fetched_ms=np.int64(-1 if gw.fetched_ms is None else gw.fetched_ms), **arrays)


def load_grid_weather(bdir: Path) -> GridWeather | None:
    """The bundle's deterministic grid weather: ``sim/weather.npz`` if present, else derived from ``weather.json``
    (e.g. the fixtures); None if the bundle has neither."""
    bdir = Path(bdir)
    npz = bdir / WEATHER_NPZ
    if npz.is_file():
        try:
            z = bundle.read_npz(npz)
            ff, fetched = int(z["forecast_from_ms"]), int(z["fetched_ms"])
            return GridWeather(t_ms=z["t_ms"].astype(np.int64), hrrr=z["hrrr"].astype(bool), source=str(z["source"]),
                               forecast_from_ms=None if ff < 0 else ff, fetched_ms=None if fetched < 0 else fetched,
                               **{k: z[k].astype(np.float64) for k in _FIELDS})
        except (OSError, KeyError, ValueError) as e:
            log.warning("weather: unreadable %s (%s); falling back to %s", npz, e, WEATHER_JSON)
    wj = bdir / WEATHER_JSON
    if wj.is_file():
        try:
            return GridWeather.from_weather_json(bundle.read_json(wj))
        except (OSError, KeyError, ValueError) as e:
            log.warning("weather: unreadable %s (%s)", wj, e)
    return None


# ---------------------------------------------------------------------------------------------------------------
# Interpolation at the fire
# ---------------------------------------------------------------------------------------------------------------
def _axis_weights(axis: Sequence[float], v: float) -> tuple[int, int, float]:
    """(i0, i1, w) for linear interpolation along an increasing axis, clamped to the end cells."""
    ax = np.asarray(axis, dtype=np.float64)
    if v <= ax[0]:
        return 0, 0, 0.0
    if v >= ax[-1]:
        return len(ax) - 1, len(ax) - 1, 0.0
    i1 = int(np.searchsorted(ax, v, side="right"))
    i0 = i1 - 1
    return i0, i1, float((v - ax[i0]) / (ax[i1] - ax[i0]))


def bilinear_at(field: np.ndarray, xs: Sequence[float], zs: Sequence[float], x: float, z: float) -> np.ndarray:
    """Bilinear interpolation of a (T, ny, nx) cell-centre field (rows at ``zs`` north->south, columns at ``xs``
    west->east) at local (x, z); outside the centre hull the edge cells are used. Returns (T,)."""
    a = np.asarray(field, dtype=np.float64)
    j0, j1, wz = _axis_weights(zs, z)
    i0, i1, wx = _axis_weights(xs, x)
    return ((1 - wz) * ((1 - wx) * a[:, j0, i0] + wx * a[:, j0, i1])
            + wz * ((1 - wx) * a[:, j1, i0] + wx * a[:, j1, i1]))


def at_fire_series(gw: GridWeather, xs: Sequence[float], zs: Sequence[float], x: float, z: float) -> dict[str, np.ndarray]:
    """WeatherFile ``at_fire`` arrays at local (x, z): bilinear T/RH/dew point/speed/gust/precip, direction from
    bilinear u/v, then dead fuel moisture (%, spun up from the series start) and FFWI."""
    out = {k: bilinear_at(getattr(gw, k), xs, zs, x, z) for k in ("temp_c", "rh_pct", "dewpoint_c", "wind_speed_ms", "wind_gust_ms", "precip_mm")}
    u, v = wind_to_uv(gw.wind_speed_ms, gw.wind_dir_deg)
    _, out["wind_dir_deg"] = uv_to_wind(bilinear_at(u, xs, zs, x, z), bilinear_at(v, xs, zs, x, z))
    out["rh_pct"] = np.clip(out["rh_pct"], 0.0, 100.0)
    out["wind_speed_ms"] = np.maximum(out["wind_speed_ms"], 0.0)
    out["wind_gust_ms"] = np.maximum(out["wind_gust_ms"], out["wind_speed_ms"])
    out["precip_mm"] = np.maximum(out["precip_mm"], 0.0)
    fm1, fm10, fm100 = dead_fuel_moisture(out["temp_c"], out["rh_pct"], precip_mm=out["precip_mm"])
    out["fm1_pct"], out["fm10_pct"], out["fm100_pct"] = fm1 * 100.0, fm10 * 100.0, fm100 * 100.0
    out["ffwi"] = np.asarray(ffwi(out["temp_c"], out["rh_pct"], out["wind_speed_ms"]), dtype=np.float64)
    return out


def _rounded(a: np.ndarray, nd: int) -> list[float]:
    return [float(x) for x in np.round(np.asarray(a, dtype=np.float64), nd)]


def weather_file_dict(gw: GridWeather, xs: Sequence[float], zs: Sequence[float], x: float, z: float) -> dict:
    """The WeatherFile dict for ``gw`` with ``at_fire`` at local (x, z)."""
    af = at_fire_series(gw, xs, zs, x, z)
    digits = {"temp_c": 2, "rh_pct": 1, "dewpoint_c": 2, "wind_speed_ms": 2, "wind_dir_deg": 1, "wind_gust_ms": 2, "precip_mm": 2,
              "fm1_pct": 2, "fm10_pct": 2, "fm100_pct": 2, "ffwi": 1}
    u, v = wind_to_uv(gw.wind_speed_ms, gw.wind_dir_deg)       # (T, 4, 4) -> flattened [t][j][i]
    return {
        "source": gw.source,
        "t_ms": [int(t) for t in gw.t_ms],
        "at_fire": {k: _rounded(af[k], nd) for k, nd in digits.items()},
        "grid": {"nx": N, "ny": N, "x": [float(v_) for v_ in xs], "z": [float(v_) for v_ in zs],
                 "u_ms": _rounded(u.ravel(), 2), "v_ms": _rounded(v.ravel(), 2)},
        "forecast_from_ms": None if gw.forecast_from_ms is None else int(gw.forecast_from_ms),
    }


# ---------------------------------------------------------------------------------------------------------------
# build_weather
# ---------------------------------------------------------------------------------------------------------------
def weather_window(mode: str, start_ms: int, end_ms: int | None, now: int) -> tuple[int, int]:
    """Hour-aligned weather.json window: historical ``[start − 72 h, end + 72 h]``; live
    ``[max(start, now − 7 d) − 72 h, now + 96 h]``."""
    if mode == "live":
        a = max(int(start_ms), now - LIVE_PAST_DAYS * DAY_MS) - HIST_PAD_H * HOUR_MS
        b = now + LIVE_FUTURE_H * HOUR_MS
    else:
        end = int(end_ms if end_ms is not None else start_ms)
        a = int(start_ms) - HIST_PAD_H * HOUR_MS
        b = max(end, int(start_ms)) + HIST_PAD_H * HOUR_MS
    return floor_hour_ms(a), ceil_hour_ms(max(a, b))


def _historical_end(ctx: BuildContext, manifest: dict, start: int, now: int) -> int:
    """time_range.end_ms when known, else a best guess from the CAL FIRE dates (capped at start + 45 d)."""
    end = ctx.end_ms or (manifest.get("time_range") or {}).get("end_ms")
    if end:
        return int(end)
    s = ctx.summary
    cand = [int(v) for v in (getattr(s, "contained_ms", None), getattr(s, "updated_ms", None)) if v and int(v) > start]
    guess = min(cand) if cand else start + 7 * DAY_MS
    return int(min(guess, start + HIST_MAX_DAYS * DAY_MS, max(now, start)))


def _at_fire_xz(manifest: dict, extent_m: float) -> tuple[float, float, str]:
    ign = manifest.get("ignition")
    h = extent_m / 2.0
    if isinstance(ign, dict) and ign.get("x") is not None and ign.get("z") is not None:
        return float(np.clip(ign["x"], -h, h)), float(np.clip(ign["z"], -h, h)), "ignition"
    return 0.0, 0.0, "AOI centre"


# ---------------------------------------------------------------------------------------------------------------
# Live fuel moisture with the drought adjustment (water-year precipitation, spread/moisture.py)
# ---------------------------------------------------------------------------------------------------------------
def _fire_lonlat(manifest: dict) -> tuple[float, float]:
    ign = manifest.get("ignition")
    if isinstance(ign, dict) and ign.get("lat") is not None:
        return float(ign["lon"]), float(ign["lat"])
    s = manifest.get("summary") or {}
    if s.get("lat") is not None:
        return float(s["lon"]), float(s["lat"])
    w, so, e, n = (manifest.get("grid") or {}).get("bbox_lonlat") or (0.0, 0.0, 0.0, 0.0)
    return (w + e) / 2.0, (so + n) / 2.0


def fetch_antecedent(bdir: Path, manifest: dict, start_ms: int | None = None, *,
                     problems: list[str] | None = None) -> dict | None:
    """Fetch the water-year precipitation at the fire up to the fire start and store it as ``sim/antecedent.json``.
    Returns the stored dict, or None when no precipitation could be fetched; the reasons are appended to
    ``problems`` when given (a refused request says so)."""
    start = int(start_ms if start_ms is not None else
                ((manifest.get("ignition") or {}).get("t_ms") or (manifest.get("summary") or {}).get("started_ms")
                 or manifest.get("time_origin_ms") or now_ms()))
    lon, lat = _fire_lonlat(manifest)
    r = water_year_precip(lat, lon, start)
    for w in r.get("warnings") or []:
        log.warning("antecedent precipitation: %s", w)
    if r.get("precip_mm") is None:
        if problems is not None:
            problems.extend(str(w) for w in r.get("warnings") or [])
        return None
    doc = {"precip_wy_mm": float(r["precip_mm"]), "from": r["from"], "to": r["to"], "days": int(r["days"]),
           "to_ms": int(floor_hour_ms(start) - DAY_MS), "lat": round(lat, 5), "lon": round(lon, 5),
           "source": r["source"], "fetched_ms": int(r["fetched_ms"])}
    try:
        bundle.write_json(Path(bdir) / ANTECEDENT_JSON, doc, indent=True)
    except OSError as e:   # read-only bundle: the value is still used for this run
        log.warning("could not write %s: %s", ANTECEDENT_JSON, e)
    return doc


def load_antecedent(bdir: Path) -> dict | None:
    p = Path(bdir) / ANTECEDENT_JSON
    if not p.is_file():
        return None
    try:
        d = bundle.read_json(p)
        return d if isinstance(d, dict) and d.get("precip_wy_mm") is not None else None
    except (OSError, ValueError):
        return None


def precip_to(bdir: Path, manifest: dict, t_ms: int, gw: GridWeather | None = None, *, fetch: bool = True) -> tuple[float | None, str]:
    """Water-year precipitation (mm) at the fire up to ``t_ms``: the stored pre-fire total plus the bundle's hourly
    precipitation (mean of the 4 x 4 grid) after it. ``(None, reason)`` when unknown (fixtures, offline)."""
    ante = load_antecedent(bdir)
    if ante is None:
        stored = gw if gw is not None else load_grid_weather(bdir)
        if (stored is not None and stored.synthetic) or not fetch:
            return None, "no antecedent precipitation (synthetic or offline bundle)"
        try:
            ante = fetch_antecedent(bdir, manifest)
        except Exception as e:   # provider failure: the plain month table is used
            log.warning("antecedent precipitation unavailable: %s", config.mask_secrets(e))
            ante = None
        if ante is None:
            return None, "antecedent precipitation unavailable"
    base_to = int(ante.get("to_ms") or 0)
    total = float(ante["precip_wy_mm"])
    wy = water_year_start_ms(int(t_ms))
    if wy > base_to:             # a new water year began after the stored total: count only its own rain
        total, base_to = 0.0, wy - HOUR_MS
    g = gw if gw is not None else load_grid_weather(bdir)
    if g is not None and int(t_ms) > base_to + DAY_MS:
        sel = (g.t_ms > base_to + DAY_MS) & (g.t_ms <= int(t_ms))
        if sel.any():
            total += float(np.nansum(np.nanmean(g.precip_mm[sel].reshape(int(sel.sum()), -1), axis=1)))
    return round(total, 1), str(ante.get("source") or "open-meteo")


def live_moisture_for(bdir: Path, manifest: dict, start_ms: int, gw: GridWeather | None = None, *, fetch: bool = True) -> tuple[float, float, str]:
    """``(herb, woody, note)``: the month's live fuel moisture with the drought adjustment for a forecast or hour
    starting at ``start_ms`` (plain month table when the water-year precipitation is unknown)."""
    month = _local_month(int(start_ms))
    p, why = precip_to(bdir, manifest, int(start_ms), gw, fetch=fetch)
    herb, woody = live_fuel_moisture(month, p)
    base = live_fuel_moisture(month)
    if p is None:
        return herb, woody, f"live fuel moisture: month table (herb {base[0]:.0%}, woody {base[1]:.0%}); {why}"
    g = greenup_fraction(p)
    adj = "" if (herb, woody) == base else f" (month table {base[0]:.0%}/{base[1]:.0%}; green-up {g:.0%})"
    return herb, woody, (f"live fuel moisture herb {herb:.0%}, woody {woody:.0%}{adj}: water-year precipitation "
                         f"{p:.0f} mm by {ms_to_iso(int(start_ms))[:10]} ({why})")


def is_california(summary: Any) -> bool:
    """The California rule switch (CONTRACT 14.12.10): ``summary.state == "CA"``; without a state (before the
    regions data), a CAL FIRE record (``calfire_uid`` set)."""
    state = getattr(summary, "state", None) if not isinstance(summary, dict) else summary.get("state")
    if state:
        return str(state).upper() == "CA"
    uid = getattr(summary, "calfire_uid", None) if not isinstance(summary, dict) else summary.get("calfire_uid")
    return bool(uid)


def build_weather(ctx: BuildContext, source: WeatherSource | None = None) -> None:
    """Fetch hourly weather for the bundle's 4 x 4 points and write ``weather.json`` + ``sim/weather.npz``;
    records a "Weather" data source and any warnings in the manifest. Raises :class:`WeatherError` when no
    weather could be obtained, :class:`~fire3d.sources.weather.WeatherQuotaExceeded` when Open-Meteo refused the
    HRRR / forecast request (nothing is written then), and with ``ctx.require_hrrr`` a :class:`WeatherError` for any
    ERA5-filled hour or, for a California fire, a missing water-year precipitation total."""
    require = bool(getattr(ctx, "require_hrrr", False))
    src = source if source is not None else OpenMeteoSource(allow_era5=not require)
    ctx.progress("weather", 0.0, "Fetching hourly weather")
    bdir = Path(ctx.bundle_dir)
    manifest = bundle.load_manifest(bdir) or {}
    now = now_ms()
    start = int((manifest.get("time_range") or {}).get("start_ms") or ctx.time_origin_ms)
    end = None if ctx.mode == "live" else _historical_end(ctx, manifest, start, now)
    a, b = weather_window(ctx.mode, start, end, now)
    grid = ctx.fire_grid
    res = src.deterministic(weather_points(grid), a, b)
    if require and res.get("era5"):
        raise WeatherError("ERA5 reanalysis filled hours where HRRR/GFS were unavailable; --require-hrrr refuses them")
    gw = GridWeather.from_source(res)
    ctx.progress("weather", 0.6, f"Fuel moisture and FFWI for {len(gw.t_ms)} h")
    xs, zs = weather_axes(grid)
    x, z, where = _at_fire_xz(manifest, grid.extent_m)
    data = weather_file_dict(gw, xs, zs, x, z)
    problems = contract_problems(WeatherFile, data)
    if problems:
        raise WeatherError("weather.json violates the WeatherFile contract: " + "; ".join(problems[:5]))
    bundle.write_json(bdir / WEATHER_JSON, data)
    save_grid_weather(bdir, gw)
    warnings = [str(w) for w in res.get("warnings", [])]
    if not gw.synthetic:
        problems: list[str] = []
        try:
            if fetch_antecedent(bdir, bundle.load_manifest(bdir) or manifest, problems=problems) is None:
                why = f" ({problems[0][:160]})" if problems else ""
                problems.insert(0, "water-year precipitation unavailable: live fuel moisture uses the month table" + why)
        except Exception as e:   # never fail the build for the drought adjustment (except with --require-hrrr)
            problems.insert(0, f"water-year precipitation unavailable ({config.mask_secrets(e)[:120]})")
        if problems:
            if require and is_california(ctx.summary):
                raise WeatherError(f"{problems[0]}; --require-hrrr needs it for California's drought adjustment")
            warnings.append(problems[0])
    fire_start = int((manifest.get("ignition") or {}).get("t_ms") or start)
    _, _, moist_note = live_moisture_for(bdir, bundle.load_manifest(bdir) or manifest, fire_start, gw, fetch=False)
    detail = (f"{gw.source}; 4x4 points, {len(gw.t_ms)} h {ms_to_iso(int(gw.t_ms[0]))} .. {ms_to_iso(int(gw.t_ms[-1]))}; "
              f"at_fire = {where}; {moist_note}")
    fetched = int(gw.fetched_ms or now)

    def record(m: dict) -> None:
        ds = [d for d in m.get("data_sources", []) if not (isinstance(d, dict) and d.get("name") == DATA_SOURCE_NAME)]
        ds.append({"name": DATA_SOURCE_NAME, "detail": detail, "fetched_ms": fetched})
        m["data_sources"] = ds
        ws = [w for w in m.get("warnings", []) if not str(w).startswith(WARN_PREFIX)]
        m["warnings"] = ws + [WARN_PREFIX + w for w in warnings]

    bundle.update_manifest(bdir, record)
    af = data["at_fire"]
    ctx.progress("weather", 1.0, f"Weather ready: {len(gw.t_ms)} h, max gust {max(af['wind_gust_ms']):.1f} m/s, min RH {min(af['rh_pct']):.0f} %")


# ---------------------------------------------------------------------------------------------------------------
# Forecast members
# ---------------------------------------------------------------------------------------------------------------
class MemberList(list):
    """``list[MemberWeather]`` with provenance: ``source`` (for ForecastManifest.weather.source), ``ensemble`` (the
    kind actually used, after any fallback) and ``warnings``."""

    def __init__(self, items: Iterable[MemberWeather] = (), *, source: str = "", ensemble: str = "none", warnings: Sequence[str] = ()):
        super().__init__(items)
        self.source = source
        self.ensemble = ensemble
        self.warnings = list(warnings)


def ar1_series(rng: np.random.Generator, n: int, tau_h: float = PERTURB_TAU_H) -> np.ndarray:
    """Stationary unit-variance AR(1) series on hourly steps (lag-1 correlation ``exp(−1/τ)``)."""
    e = rng.standard_normal(n)
    if n < 2:
        return e
    phi = math.exp(-1.0 / tau_h)
    rest, _ = lfilter([math.sqrt(1.0 - phi * phi)], [1.0, -phi], e[1:], zi=[phi * e[0]])
    return np.concatenate([e[:1], rest])


def _member_fields(gw: GridWeather) -> dict[str, np.ndarray]:
    return {"temp_c": gw.temp_c.copy(), "rh_pct": gw.rh_pct.copy(), "wind_speed_ms": gw.wind_speed_ms.copy(),
            "wind_dir_deg": gw.wind_dir_deg.copy(), "precip_mm": gw.precip_mm.copy()}


def perturbed_members(gw: GridWeather, n: int) -> list[tuple[str, dict[str, np.ndarray]]]:
    """``n`` members around ``gw``: member 0 unperturbed; member k >= 1 gets spatially uniform AR(1) perturbations
    (τ = 8 h): speed x exp(0.25 z), direction + 20° z, RH + 6 % z, T + 1.5 °C z, from ``default_rng([seed, k])``."""
    T = len(gw.t_ms)
    out = []
    for k in range(n):
        f = _member_fields(gw)
        if k > 0:
            rng = np.random.default_rng([PERTURB_SEED, k])
            zs, zd, zr, zt = (ar1_series(rng, T)[:, None, None] for _ in range(4))
            f["wind_speed_ms"] = f["wind_speed_ms"] * np.exp(PERTURB_SPEED_SIGMA * zs)
            f["wind_dir_deg"] = (f["wind_dir_deg"] + PERTURB_DIR_SD * zd) % 360.0
            f["rh_pct"] = f["rh_pct"] + PERTURB_RH_SD * zr
            f["temp_c"] = f["temp_c"] + PERTURB_TEMP_SD * zt
        out.append((f"perturbed-{k:02d}", f))
    return out


def bias_corrected_members(gw: GridWeather, ens: dict, n: int, warnings: list[str]) -> list[tuple[str, dict[str, np.ndarray]]]:
    """The first ``n`` ensemble members, shifted by the blended offset ``x_hrrr − mean_ens`` (u, v, T, RH): the full
    offset where HRRR exists, decaying linearly to 0 over 6 h after HRRR ends (``blend_offsets``)."""
    T = len(gw.t_ms)
    if not np.array_equal(np.asarray(ens["t_ms"], dtype=np.int64), gw.t_ms):
        raise WeatherError("ensemble and deterministic time axes differ")
    labels = list(ens["members"])
    M = len(labels)

    def grid(name: str) -> np.ndarray:
        a = np.asarray(ens[name], dtype=np.float64)
        if a.shape != (M, T, N * N):
            raise WeatherError(f"ensemble field {name} has shape {a.shape}, expected ({M}, {T}, {N * N})")
        return a.reshape(M, T, N, N)

    temp, rh, spd, wdir, pr = (grid(k) for k in ("temp_c", "rh_pct", "wind_speed_ms", "wind_dir_deg", "precip_mm"))
    eu, ev = wind_to_uv(spd, wdir)
    du, dv = wind_to_uv(gw.wind_speed_ms, gw.wind_dir_deg)
    have = np.asarray(gw.hrrr, dtype=bool)
    if not have.any():
        warnings.append("no HRRR hours in the forecast window: ensemble members are not bias-corrected")
    off = {k: blend_offsets(det - mem.mean(axis=0), have, BLEND_H)
           for k, det, mem in (("u", du, eu), ("v", dv, ev), ("t", gw.temp_c, temp), ("rh", gw.rh_pct, rh))}
    out = []
    for i in range(min(n, M)):
        s, d = uv_to_wind(eu[i] + off["u"], ev[i] + off["v"])
        out.append((labels[i], {"temp_c": temp[i] + off["t"], "rh_pct": rh[i] + off["rh"], "wind_speed_ms": s,
                                "wind_dir_deg": d, "precip_mm": np.maximum(pr[i], 0.0)}))
    return out


def deterministic_grid(bdir: Path, manifest: dict, a_ms: int, b_ms: int, source: WeatherSource, warnings: list[str],
                       *, prefer_fresh: bool = False) -> GridWeather:
    """Deterministic 4 x 4 weather on ``[a, b]``: the bundle's stored weather when it covers the window (always for
    the synthetic fixtures), else a fetch through ``source`` (cached); falls back to the stored weather with the
    nearest hour held if the fetch fails. ``prefer_fresh`` (live) fetches even when the stored data cover it."""
    stored = load_grid_weather(bdir)
    covers = stored is not None and int(stored.t_ms[0]) <= a_ms and int(stored.t_ms[-1]) >= b_ms
    if stored is not None and (stored.synthetic or (covers and not prefer_fresh)):
        gw, held = stored.window(a_ms, b_ms)
        if held:
            warnings.append(f"bundle weather misses {held} h of {ms_to_iso(a_ms)} .. {ms_to_iso(b_ms)}; nearest hour held")
        return gw
    _, fire = grids_from_manifest(manifest)
    try:
        res = source.deterministic(weather_points(fire), a_ms, b_ms)
        gw, held = GridWeather.from_source(res).window(a_ms, b_ms)
        warnings.extend(str(w) for w in res.get("warnings", []))
        return gw
    except Exception as e:   # network/provider failure of any kind: degrade to the stored weather
        msg = config.mask_secrets(getattr(e, "message", None) or str(e))[:200]
        if stored is None:
            raise WeatherError(f"no weather for {ms_to_iso(a_ms)} .. {ms_to_iso(b_ms)}: {msg}") from e
        gw, held = stored.window(a_ms, b_ms)
        warnings.append(f"weather fetch failed ({msg}); using the bundle weather" + (f" with {held} h held from the nearest hour" if held else ""))
        return gw


def _local_month(ms: int) -> int:
    try:
        from zoneinfo import ZoneInfo

        return ms_to_dt(ms).astimezone(ZoneInfo("America/Los_Angeles")).month
    except Exception:   # no tz database: PST is close enough for a monthly table
        return (ms_to_dt(ms) - timedelta(hours=8)).month


def resolve_ensemble(ensemble: str, mode: str) -> str:
    """``"auto"`` -> gfs025 (live) / perturbed (historical); validates the kind."""
    kind = ("gfs025" if mode == "live" else "perturbed") if ensemble == "auto" else ensemble
    if kind not in ENSEMBLE_KINDS:
        raise ValueError(f"unknown ensemble {ensemble!r} (use auto, {', '.join(ENSEMBLE_KINDS)})")
    return kind


def member_weathers(bundle_dir: Path, start_ms: int, horizon_h: int, ensemble: str, members: int | None = None,
                    *, source: WeatherSource | None = None) -> MemberList:
    """Hourly weather members on the 4 x 4 grid for a forecast from ``start_ms`` over ``horizon_h`` hours.

    ``ensemble``: "gfs025" | "ecmwf_ifs025" (live; falls back to perturbed with a warning when unavailable, e.g. for
    2025), "perturbed", "none" or "auto". ``members``: how many (default 31 perturbed, all 31 / 51 ensemble members;
    "none" is always 1). Each member's ``t_ms`` runs hourly from ``floor_hour(start_ms)`` to
    ``ceil_hour(start_ms + horizon_h)``; fuel moisture is spun up over the 72 h before. Returns a :class:`MemberList`
    (a list whose ``.source`` / ``.ensemble`` / ``.warnings`` say what was actually used)."""
    bdir = Path(bundle_dir)
    manifest = bundle.load_manifest(bdir)
    if not manifest or "grid" not in manifest:
        raise WeatherError(f"{bdir}: a manifest with a grid is required")
    mode = str(manifest.get("mode", "historical"))
    kind = resolve_ensemble(ensemble, mode)
    if not horizon_h or horizon_h <= 0:
        raise ValueError("horizon_h must be positive")
    if members is not None and int(members) < 1:
        raise ValueError("members must be >= 1")
    t0 = floor_hour_ms(start_ms)
    t1 = ceil_hour_ms(int(start_ms) + float(horizon_h) * HOUR_MS)
    a = t0 - SPINUP_H * HOUR_MS
    src = source if source is not None else OpenMeteoSource()
    warnings: list[str] = []
    gw = deterministic_grid(bdir, manifest, a, t1, src, warnings, prefer_fresh=(mode == "live"))
    want = int(members) if members is not None else DEFAULT_MEMBERS[kind]
    raw: list[tuple[str, dict[str, np.ndarray]]] = []
    label_source = gw.source
    if kind in ("gfs025", "ecmwf_ifs025"):
        ens = None
        reason = "synthetic fixture bundle"
        if not gw.synthetic:
            try:
                _, fire = grids_from_manifest(manifest)
                ens = src.ensemble(weather_points(fire), a, t1, kind)
                reason = getattr(src, "last_error", None) or "no data for this window"
            except Exception as e:   # provider failure: fall back to perturbed members
                reason = config.mask_secrets(getattr(e, "message", None) or str(e))[:200]
        if ens is None:
            want = int(members) if members is not None else DEFAULT_MEMBERS["perturbed"]
            warnings.append(f"{kind} ensemble unavailable ({reason}); using {want} perturbed members instead")
            kind = "perturbed"
        else:
            warnings.extend(str(w) for w in ens.get("warnings", []))
            raw = bias_corrected_members(gw, ens, want, warnings)
            if len(raw) < want:
                warnings.append(f"{kind}: {len(raw)} members available (asked for {want})")
            corrected = "bias-corrected to " + gw.source if gw.hrrr.any() else "raw"
            label_source = f"{ens.get('source', 'open-meteo:ensemble:' + kind)} ({corrected})"
    if kind == "perturbed":
        raw = perturbed_members(gw, want)
        label_source = f"{gw.source} + perturbed AR(1)"
    elif kind == "none":
        raw = [("deterministic", _member_fields(gw))]
    k0 = int((t0 - a) // HOUR_MS)
    herb, woody, moist_note = live_moisture_for(bdir, manifest, int(start_ms), gw)
    warnings.append(moist_note)
    out = MemberList(source=label_source, ensemble=kind, warnings=warnings)
    t_out = gw.t_ms[k0:].copy()
    for label, f in raw:
        rh = np.clip(f["rh_pct"], RH_MIN, RH_MAX)
        fm1, fm10, fm100 = dead_fuel_moisture(f["temp_c"], rh, precip_mm=f["precip_mm"])
        out.append(MemberWeather(
            t_ms=t_out.copy(),
            wind_speed_10m_kmh=np.maximum(f["wind_speed_ms"][k0:], 0.0) * MS_TO_KMH,
            upwind_dir_deg=np.mod(f["wind_dir_deg"][k0:], 360.0),
            temp_c=f["temp_c"][k0:].copy(),
            rh_pct=rh[k0:].copy(),
            fm1=fm1[k0:].copy(), fm10=fm10[k0:].copy(), fm100=fm100[k0:].copy(),
            fm_live_herb=herb, fm_live_woody=woody, foliar_moisture=float(config.FOLIAR_MOISTURE),
            label=label,
        ))
    for w in warnings:
        log.warning("weather members: %s", w)
    return out
