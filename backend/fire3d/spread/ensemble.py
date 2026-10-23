"""Ensemble forecast runs -> arrival quantiles + burn probability (SPEC 5.1, 8.5). Owner: spread agent.

:func:`run_forecast` = :func:`prepare_forecast` (start, ignition mask, weather members) -> :func:`run_member_tasks`
(one pyretechnics run per member in a spawn ``ProcessPoolExecutor``) -> :func:`aggregate` (quantile maps, burn
probability, flame length, hourly series) -> skill -> ``forecasts/{run_id}/`` + ``manifest.forecasts``.

* **Quantile semantics (SPEC 5.1):** ``arrival_pK`` is the K-th percentile of each pixel's arrival across members,
  members that never reach the pixel counting as +inf (NEVER). It is the order statistic of rank
  ``ceil(K/100 * N)`` (the inverted empirical CDF), so ``P(burned by t) >= K%`` exactly when ``arrival_pK <= t``.
  The hourly area/ROS series use the same definition across members.
* **Time budget (SPEC 8.5):** members get a wall-clock cap of ``budget / rounds`` (``FIRE3D_FORECAST_BUDGET_S``,
  default 240 s for all rounds) while they run in 12 h chunks. A member that exceeds it raises a shared flag; from
  then on every member runs on a x2 downsampled grid (results upsampled, nearest for arrival), members already
  finished at full resolution are re-run coarse for consistency, and a warning records it.
* **Workers:** ``min(10, cpu - 2)`` spawn processes (``FIRE3D_FORECAST_WORKERS`` overrides); serial when no pool can
  be started (e.g. inside a daemon process). Scripts that call :func:`run_forecast` need an
  ``if __name__ == "__main__":`` guard (spawn re-imports the main module).
* **Weather:** ``build.weather_bundle.member_weathers``; if that is unavailable or fails, a fallback built from the
  bundle's ``weather.json`` (deterministic member, or SPEC 8.4 AR(1) perturbations) is used, with a warning.
"""

from __future__ import annotations

import hashlib
import logging
import math
import multiprocessing as mp
import os
import shutil
import tempfile
import time
import warnings as pywarnings
from concurrent.futures import ProcessPoolExecutor, as_completed
from concurrent.futures.process import BrokenProcessPool
import dataclasses
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from .. import bundle as fbundle
from .. import config
from ..contracts import ForecastManifest, validate_strict
from ..timeutil import local_month, ms_to_dt, ms_to_iso, now_ms, zone_of
from ..types import MemberWeather, ProgressFn, SpreadSettings, StaticInputs, no_progress, record_issuer_of
from . import engine, moisture
from .validate import skill_entry, skill_from_arrays

log = logging.getLogger(__name__)

NEVER = config.NEVER
QUANTILES = (10, 50, 90)
LEAD_HOURS = (12, 24, 48, 72)
ENSEMBLES = ("gfs025", "ecmwf_ifs025", "perturbed", "none")
BUDGET_S = float(os.environ.get("FIRE3D_FORECAST_BUDGET_S", "240"))   # all members (SPEC target < 5 min in total)
MIN_MEMBER_CAP_S = 20.0
CHUNK_H = 12.0                   # simulated hours between wall-clock checks at full resolution
DOWNSAMPLE_FACTOR = 2
MAX_HORIZON_H = 240
STALE_RUNNING_MS = 3_600_000     # "running" entries older than this are left over from a dead process
SNAP_RADIUS_M = 1500.0           # fallback ignition: search radius for a burnable cell
TIME_TOL_H = 1e-3                # tolerance for "arrival <= t" on float32 rasters (3.6 s)
ROS_PERCENTILE = 90.0            # front ROS = p90 of the fire-normal spread rate of cells burning that hour
PERTURB_TAU_H = 8.0              # SPEC 8.4 perturbed ensemble (fallback implementation)
PERTURB_SIGMA = {"wind_log": 0.25, "dir_deg": 20.0, "rh_pct": 6.0, "temp_c": 1.5}
PERTURB_MEMBERS = 31


class ForecastError(RuntimeError):
    """A forecast run that could not be completed (the manifest entry is marked "error")."""


def default_workers() -> int:
    """``min(10, cpu - 2)`` worker processes (``FIRE3D_FORECAST_WORKERS`` overrides)."""
    env = os.environ.get("FIRE3D_FORECAST_WORKERS", "").strip()
    if env:
        return max(1, int(env))
    return max(1, min(10, (os.cpu_count() or 4) - 2))


# ----------------------------------------------------------------------------------------------------------------
# Statistics across members
# ----------------------------------------------------------------------------------------------------------------
def order_rank(n: int, q: float) -> int:
    """0-based index of the K-th percentile order statistic of n values: rank ``ceil(q/100 * n)`` (min 1)."""
    return max(1, min(n, math.ceil(q * n / 100.0 - 1e-9))) - 1


def quantile_maps(stack: np.ndarray, qs: Sequence[float] = QUANTILES) -> dict[float, np.ndarray]:
    """Per-pixel order-statistic percentiles of an (N, H, W) arrival stack (NEVER sorts last, i.e. counts as +inf)."""
    s = np.sort(np.asarray(stack, dtype=np.float32), axis=0)
    n = s.shape[0]
    return {q: np.ascontiguousarray(s[order_rank(n, q)]) for q in qs}


def series_quantile(values: np.ndarray, q: float) -> np.ndarray:
    """Order-statistic percentile across members (axis 0) of an (N, T) series."""
    v = np.sort(np.asarray(values, dtype=np.float64), axis=0)
    return v[order_rank(v.shape[0], q)]


def burned_mask(arrival: np.ndarray, t_h: float) -> np.ndarray:
    """Pixels burned by ``t_h`` (hours since origin)."""
    a = np.asarray(arrival)
    return (a < NEVER * 0.999) & (a <= t_h + TIME_TOL_H)


def burn_probability(stack: np.ndarray, end_h: float) -> np.ndarray:
    """Fraction of members burned by ``end_h``."""
    return burned_mask(stack, end_h).mean(axis=0).astype(np.float32)


def flame_length_p50(arrival_stack: np.ndarray, flame_stack: np.ndarray) -> np.ndarray:
    """Median flame length over the members that burned each pixel (0 where none did)."""
    burned = np.asarray(arrival_stack) < NEVER * 0.999
    vals = np.where(burned, np.asarray(flame_stack, dtype=np.float32), np.nan)
    with pywarnings.catch_warnings():
        pywarnings.simplefilter("ignore", RuntimeWarning)      # all-NaN pixels (never burned) -> NaN -> 0
        med = np.nanmedian(vals, axis=0)
    return np.nan_to_num(med, nan=0.0).astype(np.float32)


def hour_index(arrival: np.ndarray, start_h: float) -> np.ndarray:
    """Hour bucket k (arrival in (start + k - 1, start + k]) of each arrival; arrival <= start -> 0."""
    a = np.asarray(arrival, dtype=np.float64)
    return np.maximum(np.ceil(a - start_h - TIME_TOL_H), 0.0)


def area_acres_series(arrival: np.ndarray, start_h: float, hours: int, res_m: float) -> np.ndarray:
    """Burned area (acres) at ``start + k`` h for k = 0..hours of one member's arrival raster."""
    a = np.asarray(arrival)
    burned = a < NEVER * 0.999
    k = hour_index(a[burned], start_h).astype(np.int64)
    k = k[k <= hours]
    counts = np.cumsum(np.bincount(k, minlength=hours + 1)[: hours + 1])
    return counts * (res_m * res_m) / config.ACRE_M2


def ros_series_ch_h(arrival: np.ndarray, spread_rate_m_min: np.ndarray, ignition: np.ndarray, start_h: float,
                    hours: int) -> np.ndarray:
    """Front rate of spread (chains/h) per hour k = 0..hours: the p90 fire-normal spread rate of the cells that
    burned in (start + k - 1, start + k]; 0 when nothing burned; k = 0 repeats the first hour."""
    a = np.asarray(arrival)
    burned = (a < NEVER * 0.999) & ~np.asarray(ignition, dtype=bool)
    out = np.zeros(hours + 1, dtype=np.float64)
    if burned.any():
        k = np.clip(hour_index(a[burned], start_h).astype(np.int64), 1, hours)
        r = np.asarray(spread_rate_m_min)[burned].astype(np.float64)
        order = np.argsort(k, kind="stable")
        k, r = k[order], r[order]
        bounds = np.searchsorted(k, np.arange(1, hours + 2))
        for i in range(1, hours + 1):
            seg = r[bounds[i - 1]: bounds[i]]
            if seg.size:
                out[i] = np.percentile(seg, ROS_PERCENTILE)
        out *= 60.0 / config.CHAIN_M
    if hours >= 1:
        out[0] = out[1]
    return out


# ----------------------------------------------------------------------------------------------------------------
# Setup: start, ensemble, ignition, weather members
# ----------------------------------------------------------------------------------------------------------------
def resolve_ensemble(mode: str, ensemble: str) -> str:
    """``"auto"`` -> gfs025 (live) / perturbed (historical); other values are validated."""
    e = (ensemble or "auto").strip().lower()
    if e == "auto":
        return "gfs025" if mode == "live" else "perturbed"
    if e not in ENSEMBLES:
        raise ValueError(f"unknown ensemble {ensemble!r} (use auto, {', '.join(ENSEMBLES)})")
    return e


def default_start_ms(manifest: dict, observed: np.ndarray | None = None) -> int:
    """SPEC 6 default: live -> ``time_range.now_ms``; historical -> 24 h after ignition."""
    tr = manifest.get("time_range") or {}
    if manifest.get("mode") == "live":
        if tr.get("now_ms") is not None:
            return int(tr["now_ms"])
        if observed is not None and np.any(observed < NEVER * 0.999):
            return int(manifest["time_origin_ms"] + float(observed[observed < NEVER * 0.999].max()) * config.MS_PER_H)
        return now_ms()
    ign = manifest.get("ignition") or {}
    t0 = ign.get("t_ms") or (manifest.get("summary") or {}).get("started_ms")
    if t0 is None:
        t0 = int(manifest["time_origin_ms"]) + config.MS_PER_H
    return int(t0) + 24 * config.MS_PER_H


HISTORICAL_FINAL_MS = 7 * 24 * config.MS_PER_H   # without a containment date the final extent counts this long


def data_end_ms(manifest: dict) -> int | None:
    """Last time the observed arrival describes what had burned: ``now_ms`` (live). A historical bundle holds the
    complete record: ``end_ms`` is when growth stopped (99 % of the final area + 24 h), so the observed raster is the
    burned area at every later time too; it stays valid until containment (CAL FIRE), else ``end_ms`` + 7 days."""
    tr = manifest.get("time_range") or {}
    if manifest.get("mode") == "live":
        v = tr.get("now_ms")
        return int(v) if v is not None else None
    v = tr.get("end_ms", tr.get("now_ms"))
    if v is None:
        return None
    contained = (manifest.get("summary") or {}).get("contained_ms")
    return int(max(int(v), int(contained))) if contained else int(v) + HISTORICAL_FINAL_MS


def build_ignition(manifest: dict, observed: np.ndarray | None, static: StaticInputs, start_ms: int,
                   end_ms: int) -> tuple[np.ndarray, int, list[str]]:
    """Ignition mask = observed arrival <= start (SPEC 8.5). If that is empty, the ignition cell (snapped to the
    nearest burnable cell within 1.5 km) ignites at ``max(start, ignition time)``. Returns
    ``(mask, simulation_start_ms, warnings)``."""
    origin = int(manifest["time_origin_ms"])
    shape = static.fuel_model.shape
    start_h = (start_ms - origin) / config.MS_PER_H
    warnings: list[str] = []
    burnable = engine.is_burnable_code(static.fuel_model)
    if observed is not None and observed.shape == shape:
        mask = burned_mask(observed, start_h)
        if mask.any():
            grow = burnable & ~mask
            edge = np.zeros(shape, dtype=bool)
            edge[1:, :] |= mask[:-1, :]
            edge[:-1, :] |= mask[1:, :]
            edge[:, 1:] |= mask[:, :-1]
            edge[:, :-1] |= mask[:, 1:]
            if not (edge & grow).any():
                warnings.append("the observed burned area at the start has no burnable unburned neighbours: nothing can spread")
            return mask, int(start_ms), warnings
    elif observed is not None:
        warnings.append(f"observed_arrival has shape {observed.shape}, fire grid is {shape}: ignored")
    ign = manifest.get("ignition")
    m_rows, m_cols = shape
    res = float(static.res_m)
    if ign:
        x, z = float(ign["x"]), float(ign["z"])
        t_ign = int(ign["t_ms"])
    else:
        x = z = 0.0
        t_ign = int((manifest.get("summary") or {}).get("started_ms") or start_ms)
        warnings.append("bundle has no ignition point: using the AOI centre")
    row = int(math.floor((z + m_rows * res / 2.0) / res))
    col = int(math.floor((x + m_cols * res / 2.0) / res))
    snapped = engine.snap_to_burnable(static.fuel_model, row, col, SNAP_RADIUS_M / res)
    if snapped is None:
        raise ForecastError(f"no burnable fuel within {SNAP_RADIUS_M:.0f} m of the ignition point")
    if snapped != (min(max(row, 0), m_rows - 1), min(max(col, 0), m_cols - 1)):
        d = math.hypot(snapped[0] - row, snapped[1] - col) * res
        warnings.append(f"ignition cell is not burnable: moved {d:.0f} m to the nearest burnable cell")
    mask = np.zeros(shape, dtype=bool)
    mask[snapped] = True
    sim_start = max(int(start_ms), t_ign)
    if sim_start >= end_ms:
        raise ForecastError("the ignition time is after the forecast horizon")
    warnings.append(f"no observed burned area by the forecast start: ignited the ignition cell at {ms_to_iso(sim_start)}")
    return mask, sim_start, warnings


def _hourly_series(af: dict, key: str, n: int) -> np.ndarray | None:
    v = af.get(key)
    if v is None:
        return None
    a = np.array([np.nan if x is None else float(x) for x in v], dtype=np.float64)
    return a if a.size == n else None


def _broadcast4(a: np.ndarray) -> np.ndarray:
    return np.repeat(np.asarray(a, dtype=np.float64)[:, None, None], 4, axis=1).repeat(4, axis=2)


def _ar1(rng: np.random.Generator, n: int, tau_h: float) -> np.ndarray:
    phi = math.exp(-1.0 / tau_h)
    eps = rng.standard_normal(n)
    x = np.empty(n)
    x[0] = eps[0]
    s = math.sqrt(1.0 - phi * phi)
    for i in range(1, n):
        x[i] = phi * x[i - 1] + s * eps[i]
    return x


def members_from_weather_json(bundle_dir: Path, start_ms: int, horizon_h: int, ensemble: str,
                              members: int | None = None) -> tuple[list[MemberWeather], str]:
    """Fallback weather members built from the bundle's ``weather.json`` (4 x 4 u/v grid + at-fire series):
    one deterministic member, or for ``"perturbed"`` SPEC 8.4 AR(1) perturbations (tau 8 h: wind x lognormal
    sigma 0.25, direction + N(0, 20 deg), RH + N(0, 6 %), T + N(0, 1.5 C); member 0 unperturbed; seeds fixed)
    with dead fuel moisture recomputed per member. Returns ``(members, ensemble_kind)``."""
    w = fbundle.read_json(Path(bundle_dir) / "weather.json")
    t = np.asarray(w["t_ms"], dtype=np.int64)
    n = t.size
    if n == 0:
        raise ValueError("weather.json has no hours")
    g = w["grid"]
    u = np.asarray(g["u_ms"], dtype=np.float64).reshape(n, 4, 4)
    v = np.asarray(g["v_ms"], dtype=np.float64).reshape(n, 4, 4)
    af = w["at_fire"]
    temp = _hourly_series(af, "temp_c", n)
    rh = _hourly_series(af, "rh_pct", n)
    temp = engine.fill_nan_time(temp if temp is not None else np.full(n, 25.0), 25.0)
    rh = engine.fill_nan_time(rh if rh is not None else np.full(n, 30.0), 30.0)
    precip = _hourly_series(af, "precip_mm", n)
    man = fbundle.load_manifest(Path(bundle_dir)) or {}
    month = local_month(start_ms, zone_of(man))            # the fire's own zone (CONTRACT 14.9.7)
    try:   # California: the drought-adjusted month table; elsewhere the NFDRS 2016 GSI (CONTRACT 14.12.10)
        from ..build.weather_bundle import live_moisture_detail

        lm = live_moisture_detail(Path(bundle_dir), man, int(start_ms), fetch=False)
        herb, woody = float(lm["herb"]), float(lm["woody"])
    except Exception:  # noqa: BLE001 - the month table is a safe fallback
        herb, woody = moisture.live_fuel_moisture(month, None)
    lo = int(np.searchsorted(t, start_ms - 2 * config.MS_PER_H))
    hi = int(np.searchsorted(t, start_ms + (horizon_h + 2) * config.MS_PER_H)) + 1
    lo, hi = max(0, min(lo, n - 1)), max(lo + 1, min(hi, n))
    kind = "perturbed" if ensemble == "perturbed" else "none"
    count = (members or PERTURB_MEMBERS) if kind == "perturbed" else 1
    out: list[MemberWeather] = []
    for i in range(count):
        tt, hh, uu, vv = temp.copy(), rh.copy(), u.copy(), v.copy()
        if i > 0:
            rng = np.random.default_rng([20250101, i])
            f_w = np.exp(PERTURB_SIGMA["wind_log"] * _ar1(rng, n, PERTURB_TAU_H))
            d_dir = PERTURB_SIGMA["dir_deg"] * _ar1(rng, n, PERTURB_TAU_H)
            d_rh = PERTURB_SIGMA["rh_pct"] * _ar1(rng, n, PERTURB_TAU_H)
            d_t = PERTURB_SIGMA["temp_c"] * _ar1(rng, n, PERTURB_TAU_H)
            spd, wdir = engine.uv_to_wind(uu, vv)
            uu, vv = engine.wind_to_uv(spd * f_w[:, None, None], wdir + d_dir[:, None, None])
            hh = np.clip(hh + d_rh, 1.0, 100.0)
            tt = tt + d_t
        fm1, fm10, fm100 = moisture.dead_fuel_moisture(tt, hh, precip_mm=None if precip is None else np.nan_to_num(precip))
        spd, wdir = engine.uv_to_wind(uu, vv)
        sl = slice(lo, hi)
        out.append(MemberWeather(
            t_ms=t[sl].copy(),
            wind_speed_10m_kmh=spd[sl] * 3.6,
            upwind_dir_deg=wdir[sl],
            temp_c=_broadcast4(tt[sl]),
            rh_pct=_broadcast4(hh[sl]),
            fm1=_broadcast4(np.asarray(fm1)[sl]),
            fm10=_broadcast4(np.asarray(fm10)[sl]),
            fm100=_broadcast4(np.asarray(fm100)[sl]),
            fm_live_herb=herb,
            fm_live_woody=woody,
            foliar_moisture=float(config.FOLIAR_MOISTURE),
            label="control" if i == 0 else f"perturbed-{i:02d}",
        ))
    return out, kind


def _infer_ensemble(requested: str, members: list[MemberWeather]) -> str:
    labels = [str(m.label).lower() for m in members]
    if any(lb.startswith("perturbed") for lb in labels):
        return "perturbed"
    if requested in ("gfs025", "ecmwf_ifs025") and len(members) == 1:
        return "none"
    return requested


def load_member_weathers(bundle_dir: Path, start_ms: int, horizon_h: int, ensemble: str,
                         members: int | None = None) -> tuple[list[MemberWeather], str, str, list[str]]:
    """Weather members for the run: ``(members, ensemble_kind, weather_source, warnings)``."""
    bdir = Path(bundle_dir)
    warnings: list[str] = []
    det_source = "unknown"
    try:
        det_source = str(fbundle.read_json(bdir / "weather.json").get("source") or det_source)
    except (OSError, ValueError):
        pass
    mws: list[MemberWeather] | None = None
    kind = ensemble
    provided_source = None
    try:
        from ..build import weather_bundle

        res = weather_bundle.member_weathers(bdir, int(start_ms), int(horizon_h), ensemble, members)
        mws = list(res)
        if not mws:
            raise ValueError("no members returned")
        # weather_bundle returns a MemberList whose .ensemble/.source/.warnings say what was actually used
        kind = str(getattr(res, "ensemble", "") or _infer_ensemble(ensemble, mws))
        provided_source = getattr(res, "source", None) or None
        warnings += [f"weather: {config.mask_secrets(w)}" for w in (getattr(res, "warnings", None) or [])]
    except Exception as e:  # noqa: BLE001 - any failure falls back to weather.json
        msg = config.mask_secrets(f"{type(e).__name__}: {e}")
        log.warning("member_weathers(%s) failed: %s", ensemble, msg)
        fb_kind = "perturbed" if ensemble != "none" else "none"
        try:
            mws, kind = members_from_weather_json(bdir, start_ms, horizon_h, fb_kind, members)
        except Exception as e2:  # noqa: BLE001
            raise ForecastError(f"no weather for the forecast: member_weathers failed ({msg}); weather.json fallback failed "
                                f"({config.mask_secrets(e2)})") from e2
        warnings.append(f"ensemble weather {ensemble!r} unavailable ({msg[:160]}); used {kind} members built from weather.json")
        source = f"{det_source}+perturbed(fallback)" if kind == "perturbed" else f"{det_source}(fallback)"
        return mws[: members or len(mws)], kind, source, warnings
    if kind not in ENSEMBLES:
        kind = _infer_ensemble(ensemble, mws)
    if kind != ensemble and not any("instead" in w or "unavailable" in w for w in warnings):
        warnings.append(f"requested ensemble {ensemble!r}, the weather module provided {kind!r} members")
    if members and len(mws) > members:
        mws = mws[:members]
    if provided_source:
        source = str(provided_source)
    elif kind in ("gfs025", "ecmwf_ifs025"):
        source = f"open-meteo:ensemble:{kind}"
    elif kind == "perturbed":
        source = f"{det_source}+perturbed"
    else:
        source = det_source
    return mws, kind, source, warnings


@dataclass
class ForecastSetup:
    """Everything a forecast needs before the members run."""

    bundle_dir: Path
    incident_id: str
    mode: str
    manifest: dict
    time_origin_ms: int
    start_ms: int                 # forecast start (series origin, run id)
    sim_start_ms: int             # simulation start (later than start_ms only for a not-yet-ignited fire)
    horizon_h: int
    end_ms: int
    ensemble: str                 # ensemble kind actually used
    weather_source: str
    members: list[MemberWeather]
    ignition_mask: np.ndarray     # bool (M, M)
    observed: np.ndarray | None   # observed arrival (hours since origin) or None
    res_m: float
    data_end_ms: int | None
    warnings: list[str] = field(default_factory=list)
    detections: np.ndarray | None = None   # (N, 3) x, z, t_ms of polar-orbiter detections (VIIRS/MODIS/Landsat)
    activity: dict | None = None           # live: sim/activity.json (last detection, passes, activity markers)
    percent_contained: float | None = None  # live: the record's containment (manifest summary)
    issuer: str = "CAL FIRE"               # who published that record (summary.record_issuer, CONTRACT 14.12.5)
    time_zone: str | None = None           # the fire's zone, for the start note (CONTRACT 14.9.7)

    @property
    def start_h(self) -> float:
        return (self.start_ms - self.time_origin_ms) / config.MS_PER_H

    @property
    def sim_start_h(self) -> float:
        return (self.sim_start_ms - self.time_origin_ms) / config.MS_PER_H


def prepare_forecast(
    bundle_dir: Path,
    start_ms: int | None = None,
    horizon_h: int = 72,
    ensemble: str = "auto",
    members: int | None = None,
    progress: ProgressFn | None = None,
) -> ForecastSetup:
    """Resolve the start (SPEC 6 defaults), ensemble, ignition mask and weather members of a forecast."""
    progress = progress or no_progress
    bdir = Path(bundle_dir)
    man = fbundle.load_manifest(bdir)
    if not man:
        raise ForecastError(f"{bdir} has no manifest.json (build the incident first)")
    if "time_origin_ms" not in man:
        raise ForecastError("manifest has no time_origin_ms (the bundle is incomplete)")
    horizon = int(horizon_h)
    if not 1 <= horizon <= MAX_HORIZON_H:
        raise ValueError(f"horizon_h must be 1..{MAX_HORIZON_H}, got {horizon_h}")
    mode = str(man.get("mode") or (man.get("summary") or {}).get("mode") or "historical")
    origin = int(man["time_origin_ms"])
    static = engine.load_static_inputs(bdir)
    observed = None
    warnings: list[str] = []
    if "observed_arrival" in (man.get("layers") or {}):
        try:
            observed = fbundle.read_layer(bdir, "observed_arrival", man).astype(np.float32)
        except (OSError, ValueError, KeyError) as e:
            warnings.append(f"observed_arrival unreadable ({e}); using the ignition point")
    else:
        warnings.append("bundle has no observed_arrival layer; using the ignition point")
    activity = load_activity(bdir) if mode == "live" else None
    contained = (man.get("summary") or {}).get("percent_contained") if mode == "live" else None
    start = int(start_ms) if start_ms is not None else default_start_ms(man, observed)
    if start < origin:
        raise ValueError(f"start {ms_to_iso(start)} is before the bundle's time origin {ms_to_iso(origin)}")
    end = start + horizon * config.MS_PER_H
    kind = resolve_ensemble(mode, ensemble)
    mask, sim_start, w_ign = build_ignition(man, observed, static, start, end)
    warnings += w_ign
    progress("weather", 0.0, f"loading {kind} weather members")
    dets = load_polar_detections(bdir)
    mws, kind, source, w_wx = load_member_weathers(bdir, start, horizon, kind, members)
    warnings += w_wx
    progress("weather", 1.0, f"{len(mws)} {kind} member(s) ready")
    return ForecastSetup(
        bundle_dir=bdir,
        incident_id=str(man.get("id") or bdir.name),
        mode=mode,
        manifest=man,
        time_origin_ms=origin,
        start_ms=start,
        sim_start_ms=sim_start,
        horizon_h=horizon,
        end_ms=end,
        ensemble=kind,
        weather_source=source,
        members=mws,
        ignition_mask=mask,
        observed=observed,
        res_m=float(static.res_m),
        data_end_ms=data_end_ms(man),
        warnings=warnings,
        detections=dets,
        activity=activity,
        percent_contained=float(contained) if contained is not None else None,
        issuer=record_issuer_of(man.get("summary") or {}),
        time_zone=zone_of(man),
    )


# ----------------------------------------------------------------------------------------------------------------
# Observation-informed start: hold the inactive perimeter
# ----------------------------------------------------------------------------------------------------------------
HOLD_BAND_CELLS = 2
POLAR_INSTRUMENTS = ("VIIRS", "MODIS", "LANDSAT")


def load_activity(bundle_dir: Path) -> dict | None:
    """A live bundle's ``sim/activity.json`` (build/live_observation.py), or None."""
    from ..build import live_observation

    try:
        doc = fbundle.read_json(Path(bundle_dir) / "sim" / live_observation.ACTIVITY_FILE)
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def load_polar_detections(bundle_dir: Path) -> np.ndarray | None:
    """(N, 3) float64 ``x, z, t_ms`` of the bundle's VIIRS/MODIS/Landsat detections (GOES pixels are too coarse to
    say which part of a perimeter burns); None without detections.json."""
    try:
        doc = fbundle.read_json(Path(bundle_dir) / "detections.json")
    except (OSError, ValueError):
        return None
    rows = [(float(d["x"]), float(d["z"]), float(d["t_ms"])) for d in (doc or {}).get("detections") or []
            if d.get("instrument") in POLAR_INSTRUMENTS]
    return np.asarray(rows, dtype=np.float64).reshape(-1, 3)


def _mark_markers(active: np.ndarray, markers: np.ndarray, res_m: float) -> int:
    """Set ``active`` at marker cells (x, z, t_ms, radius_m rows), a disk where the radius exceeds half a cell.
    Returns how many markers fell inside the grid."""
    n_rows, n_cols = active.shape
    half = n_rows * res_m / 2.0
    n = 0
    for x, z, _t, rad in markers:
        r = int(math.floor((z + half) / res_m))
        c = int(math.floor((x + half) / res_m))
        k = int(math.ceil(max(float(rad), 0.0) / res_m))
        if r < -k or r >= n_rows + k or c < -k or c >= n_cols + k:
            continue
        n += 1
        if k == 0:
            if 0 <= r < n_rows and 0 <= c < n_cols:
                active[r, c] = True
            continue
        r0, r1, c0, c1 = max(0, r - k), min(n_rows, r + k + 1), max(0, c - k), min(n_cols, c + k + 1)
        rr, cc = np.mgrid[r0:r1, c0:c1]
        disk = np.hypot((rr - r) * res_m, (cc - c) * res_m) <= rad
        active[r0:r1, c0:c1] |= disk
    return n


def held_perimeter(observed: np.ndarray, start_h: float, res_m: float, time_origin_ms: int,
                   detections: np.ndarray | None = None, *, window_h: float = 12.0, radius_m: float = 1000.0,
                   band_cells: int = HOLD_BAND_CELLS, markers: np.ndarray | None = None,
                   min_held_fraction: float = 0.0, edge_m: float = 0.0,
                   growth_only: bool = False) -> tuple[np.ndarray | None, dict]:
    """Unburned cells along the inactive part of the perimeter at the start: perimeter cells farther than
    ``radius_m`` from both the area that burned in the ``window_h`` before the start and any VIIRS/MODIS/Landsat
    detection in that window or activity marker after its start (live: low-confidence pixels, persistent GOES seen
    up to the issue time; ``(N, 4)`` x, z, t_ms, radius_m), plus ``band_cells - 1`` cells outward. ``min_held_fraction`` (live: CAL FIRE containment) holds at
    least that share of the perimeter, taking the cells farthest from recent activity first. Experimental filters
    (off by default, docs/validation.md 6.6): ``growth_only`` drops detections on cells that burned before the window;
    ``edge_m`` > 0 drops activity deeper than that inside the burned area. Returns ``(mask or None, stats)``."""
    from scipy import ndimage

    burned = burned_mask(observed, start_h)
    if not burned.any():
        return None, {}
    shape = burned.shape
    active = burned & (np.asarray(observed) > start_h - window_h)
    t0 = time_origin_ms + (start_h - window_h) * config.MS_PER_H
    t1 = time_origin_ms + start_h * config.MS_PER_H
    n_det = 0
    if detections is not None and len(detections):
        d = detections[(detections[:, 2] > t0) & (detections[:, 2] <= t1)]
        half = shape[0] * res_m / 2.0
        r = np.floor((d[:, 1] + half) / res_m).astype(int)
        c = np.floor((d[:, 0] + half) / res_m).astype(int)
        ok = (r >= 0) & (r < shape[0]) & (c >= 0) & (c < shape[1])
        if growth_only:      # on ground that burned before the window: burnout / smouldering, not spread
            old_ground = burned & (np.asarray(observed) <= start_h - window_h)
            ok[ok] &= ~old_ground[r[ok], c[ok]]
        active[r[ok], c[ok]] = True
        n_det = int(ok.sum())
    n_mark = 0
    if markers is not None and len(markers):
        # activity seen after the start (before the forecast was issued) counts too: the fire is still burning there
        mk = np.asarray(markers, dtype=np.float64).reshape(-1, 4)
        n_mark = _mark_markers(active, mk[mk[:, 2] > t0], float(res_m))
    if edge_m and edge_m > 0 and active.any():
        active &= ~burned | (ndimage.distance_transform_edt(burned) * float(res_m) <= float(edge_m))
    ring = ndimage.binary_dilation(burned, structure=np.ones((3, 3), dtype=bool)) & ~burned
    n_ring = int(ring.sum())
    stats: dict = {"perimeter_cells": n_ring, "detections": n_det, "markers": n_mark}
    dist = ndimage.distance_transform_edt(~active) * float(res_m) if active.any() else np.full(shape, np.inf)
    near = dist <= float(radius_m)
    held = ring & ~near
    stats["held_fraction"] = round(float(held.sum()) / max(1, n_ring), 3)
    want = float(min(max(min_held_fraction, 0.0), 1.0))
    if n_ring and want > float(held.sum()) / n_ring + 1e-9:
        # containment: the needed share of the perimeter, farthest from recent activity first
        n_need = int(math.ceil(want * n_ring - 1e-9))
        thr = float(np.sort(dist[ring])[::-1][max(0, n_need - 1)])
        near = dist < thr
        held = ring & ~near
        stats["contained_fraction"] = round(want, 3)
        stats["held_fraction_with_containment"] = round(float(held.sum()) / n_ring, 3)
    seed = held
    if band_cells > 1 and seed.any():
        seed = ndimage.binary_dilation(seed, iterations=int(band_cells) - 1) & ~burned & ~near
    return (seed if seed.any() else None), stats


def forecast_settings(**overrides: Any) -> SpreadSettings:
    """The calibrated operational settings (``config.FORECAST_*``, docs/validation.md) with optional overrides."""
    st = SpreadSettings(spread_adjustment=config.FORECAST_SPREAD_ADJUSTMENT, wui=config.FORECAST_WUI,
                        hold_inactive=config.FORECAST_HOLD_INACTIVE, adjustment_decay_h=config.FORECAST_ADJUSTMENT_DECAY_H,
                        adjustment_floor=config.FORECAST_ADJUSTMENT_FLOOR,
                        active_radius_m=config.FORECAST_ACTIVE_RADIUS_M, active_edge_m=config.FORECAST_ACTIVE_EDGE_M,
                        active_growth_only=config.FORECAST_ACTIVE_GROWTH_ONLY)
    return dataclasses.replace(st, **overrides) if overrides else st


def adjustment_note(settings: SpreadSettings, start_ms: int | None = None) -> str | None:
    """Forecast warning describing a non-neutral spread-rate multiplier (None when it is 1 and constant)."""
    a = float(settings.spread_adjustment)
    tau, floor = float(settings.adjustment_decay_h or 0.0), float(min(max(settings.adjustment_floor, 0.0), 1.0))
    if tau > 0.0 and floor < 1.0:
        origin = getattr(settings, "adjustment_origin_ms", None)
        if origin is not None and start_ms is not None and int(origin) < int(start_ms):
            lead = (int(start_ms) - int(origin)) / config.MS_PER_H
            now_a = a * (floor + (1.0 - floor) * math.exp(-lead / tau))
            return (f"spread-rate multiplier {a:g} x ({floor:g} + {1.0 - floor:g} x e^(-lead/{tau:g} h)) with the lead counted from the last "
                    f"sign of activity ({ms_to_iso(int(origin))[:16]}Z, {lead:.0f} h before the start), so {now_a:.2g} at the "
                    f"start, relaxing toward {a * floor:.2g} (calibrated on 2025 hindcasts; it stands in for suppression and "
                    "the end of wind events, which the model does not simulate; see docs/validation.md)")
        return (f"spread-rate multiplier {a:g} at the start, relaxing toward {a * floor:.2g} with a {tau:g} h e-folding "
                "lead time (calibrated on 2025 hindcasts; it stands in for suppression and the end of wind events, "
                "which the model does not simulate; see docs/validation.md)")
    if a != 1.0:
        return f"spread-rate multiplier {a:g} (calibration, see docs/validation.md)"
    return None


def hold_note(stats: dict, settings: SpreadSettings, issuer: str = "CAL FIRE") -> str:
    det = ("no satellite detection of new burning (hot pixels on ground that burned earlier are burnout)"
           if getattr(settings, "active_growth_only", False) else "no satellite detection")
    text = (f"observation-informed start: {stats.get('held_fraction', 0.0):.0%} of the perimeter showed no burning in the "
            f"{settings.active_window_h:g} h before the start and {det}"
            f"{' or other sign of activity' if stats.get('markers') else ''} within {settings.active_radius_m / 1000:g} km, "
            "so it is held (treated as contained or burned out); spread starts from the active part (see docs/validation.md)")
    if "held_fraction_with_containment" in stats:
        text += (f"; {issuer} reports {stats['contained_fraction']:.0%} containment, so "
                 f"{stats['held_fraction_with_containment']:.0%} of the perimeter is held (the part farthest from recent "
                 "activity; where the contained lines are is not published)")
    if stats.get("held_fraction", 0.0) >= 0.999 or stats.get("held_fraction_with_containment", 0.0) >= 0.999:
        text += "; with the whole perimeter held the forecast shows no growth, which does not mean the fire is out"
    return text


def live_settings(setup: ForecastSetup, settings: SpreadSettings) -> SpreadSettings:
    """Live forecasts that start after the last sign of activity (a quiet satellite pass): the multiplier's decay
    clock starts at that activity (``config.FORECAST_DECAY_FROM_LAST_ACTIVITY``), as if the forecast had started
    there. Other forecasts are returned unchanged."""
    if (setup.mode != "live" or not config.FORECAST_DECAY_FROM_LAST_ACTIVITY or not setup.activity
            or getattr(settings, "adjustment_origin_ms", None) is not None or not settings.adjustment_decay_h):
        return settings
    from ..build import live_observation

    t_act = live_observation.last_activity_ms(setup.activity)
    if t_act is None or t_act >= setup.sim_start_ms - 60_000:
        return settings
    return dataclasses.replace(settings, adjustment_origin_ms=int(t_act))


# ----------------------------------------------------------------------------------------------------------------
# Member tasks (run in worker processes)
# ----------------------------------------------------------------------------------------------------------------
@dataclass
class MemberTask:
    """One pyretechnics run, self-contained so it can be pickled to a worker process."""

    index: int
    bundle_dir: str
    weather: MemberWeather
    ignition: np.ndarray          # bool (M, M)
    start_ms: int                 # simulation start
    horizon_h: float              # simulated hours from start_ms
    time_origin_ms: int
    settings: SpreadSettings
    series_start_h: float         # forecast start (hours since origin) for the hourly series
    series_hours: int
    group: Any = None             # caller's key (batch hindcasts)
    factor: int = 1               # 1 = native grid, 2 = x2 downsampled
    cap_s: float | None = None    # wall-clock cap at full resolution
    flag_path: str | None = None  # shared "switch to coarse" flag file
    chunk_h: float | None = None
    seed: int = 0
    hold: np.ndarray | None = None  # bool (M, M): held (non-burnable) cells along the inactive perimeter


_STATIC_CACHE: dict[tuple, StaticInputs] = {}


def _static_for(bundle_dir: str, settings: SpreadSettings, factor: int) -> StaticInputs:
    """Prepared (and optionally downsampled) static inputs, cached per worker process."""
    path = Path(bundle_dir) / fbundle.STATIC_NPZ
    key = (str(Path(bundle_dir).resolve()), path.stat().st_mtime_ns, bool(settings.crown), bool(settings.wui),
           int(settings.wui_fuel_model), float(settings.wui_spread_adjustment), float(settings.wui_buffer_m), int(factor))
    st = _STATIC_CACHE.get(key)
    if st is None:
        raw = engine.load_static_inputs(Path(bundle_dir))
        st = engine.prepare_static(raw if factor == 1 else engine.downsample_static(raw, factor), settings)
        if len(_STATIC_CACHE) > 8:
            _STATIC_CACHE.clear()
        _STATIC_CACHE[key] = st
    return st


def _touch(path: str | None) -> None:
    if path:
        try:
            with open(path, "a", encoding="utf-8"):
                pass
        except OSError:
            pass


def _with_hold(st: StaticInputs, hold: np.ndarray | None) -> StaticInputs:
    """``st`` with the held cells made non-burnable (NB9 bare ground)."""
    if hold is None or not np.any(hold):
        return st
    return dataclasses.replace(st, fuel_model=np.where(hold, np.int16(99), st.fuel_model).astype(np.int16))


def run_member_task(task: MemberTask) -> dict:
    """Run one member (worker entry point); returns arrays + per-member series and diagnostics."""
    t0 = time.perf_counter()
    fine = _with_hold(_static_for(task.bundle_dir, task.settings, 1), task.hold)
    aborted = False

    def coarse() -> engine.SimOutput:
        f = max(2, int(task.factor) if task.factor > 1 else DOWNSAMPLE_FACTOR)
        cs = _with_hold(_static_for(task.bundle_dir, task.settings, f),
                        None if task.hold is None else engine.downsample_mask(task.hold, f))
        return engine.simulate_downsampled(fine, task.weather, task.ignition, task.start_ms, task.horizon_h,
                                           task.time_origin_ms, task.settings, factor=f, coarse_static=cs, seed=task.seed)

    use_coarse = task.factor > 1 or bool(task.flag_path and os.path.exists(task.flag_path))
    if use_coarse:
        out = coarse()
    else:
        check = None
        if task.cap_s or task.flag_path:
            # Only the elapsed time counts: the cost of a run is often front-loaded (the most intense hours come
            # first), so extrapolating from the first chunks over-estimates and would downsample needlessly.
            def check(elapsed: float, sim_h: float) -> bool:
                if task.flag_path and os.path.exists(task.flag_path):
                    return False
                if task.cap_s and elapsed > task.cap_s:
                    _touch(task.flag_path)
                    return False
                return True
        try:
            out = engine.simulate(fine, task.weather, task.ignition, task.start_ms, task.horizon_h, task.time_origin_ms,
                                  task.settings, prepared=True, seed=task.seed,
                                  chunk_h=task.chunk_h if check is not None else None, check=check)
        except engine.SimulationAborted:
            aborted = True
            out = coarse()
    r = out.result
    arrival = r.arrival_h
    burned = arrival < NEVER * 0.999
    return {
        "index": task.index,
        "group": task.group,
        "label": r.label,
        "arrival_h": arrival,
        "flame_m": r.flame_length_m,
        "ros_ch_h": ros_series_ch_h(arrival, out.spread_rate_m_min, task.ignition, task.series_start_h, task.series_hours),
        "fire_type_counts": np.bincount(r.fire_type[burned & ~task.ignition], minlength=4)[:4].astype(np.int64),
        "runtime_s": time.perf_counter() - t0,
        "factor": int(out.factor),
        "sim_res_m": float(out.sim_res_m or fine.res_m * out.factor),
        "aborted_full": aborted,
        "reached_edge": engine.reached_edge(arrival),
        "stop_condition": out.stop_condition,
        "warnings": list(out.warnings),
    }


def run_member_tasks(tasks: list[MemberTask], workers: int | None = None, progress: ProgressFn | None = None,
                     step: str = "spread") -> tuple[list[dict], list[str]]:
    """Run tasks in a spawn ProcessPoolExecutor (serially when ``workers`` is 1 or no pool can be started).
    Returns ``(results sorted by task index, warnings)``."""
    progress = progress or no_progress
    n = len(tasks)
    results: dict[int, dict] = {}
    warnings: list[str] = []
    w = min(max(1, int(workers or default_workers())), n) if n else 1

    def done(r: dict) -> None:
        results[r["index"]] = r
        progress(step, len(results) / n, f"member {r['label']} done in {r['runtime_s']:.1f} s ({len(results)}/{n})")

    def serial(todo: list[MemberTask]) -> None:
        for t in todo:
            done(run_member_task(t))

    if w <= 1:
        serial(tasks)
        return [results[k] for k in sorted(results)], warnings
    for attempt in (1, 2):
        todo = [t for t in tasks if t.index not in results]
        if not todo:
            break
        ex = None
        try:
            ex = ProcessPoolExecutor(max_workers=min(w, len(todo)), mp_context=mp.get_context("spawn"))
            futures = [ex.submit(run_member_task, t) for t in todo]
        except (OSError, AssertionError, NotImplementedError) as e:
            # "daemonic processes are not allowed to have children" (AssertionError) or no semaphores (OSError).
            # A RuntimeError (spawn bootstrapping: a script without an ``if __name__ == "__main__"`` guard) propagates.
            if ex is not None:
                try:
                    ex.shutdown(wait=False, cancel_futures=True)
                except Exception:  # noqa: BLE001 - best effort on a half-started pool
                    pass
            warnings.append(f"process pool unavailable ({type(e).__name__}: {e}); members ran serially")
            serial(todo)
            break
        try:
            for f in as_completed(futures):
                done(f.result())
        except BrokenProcessPool as e:
            ex.shutdown(wait=True, cancel_futures=True)
            if attempt == 2:
                raise ForecastError(f"forecast worker processes crashed twice: {e}") from e
            warnings.append("a forecast worker process crashed; its members were re-run in a fresh pool")
            continue
        except BaseException:
            ex.shutdown(wait=True, cancel_futures=True)
            raise
        ex.shutdown(wait=True)
    return [results[k] for k in sorted(results)], warnings


def setup_hold(setup: ForecastSetup, settings: SpreadSettings) -> tuple[np.ndarray | None, dict]:
    """The held-perimeter mask of a forecast (None unless ``settings.hold_inactive`` and observations exist). Live:
    activity markers keep the nearby perimeter active and CAL FIRE containment sets a minimum held share."""
    if not settings.hold_inactive or setup.observed is None:
        return None, {}
    markers = None
    min_frac = 0.0
    if setup.mode == "live":
        from ..build import live_observation

        markers = live_observation.marker_array(setup.activity)
        if config.FORECAST_HOLD_CONTAINED and setup.percent_contained is not None and math.isfinite(setup.percent_contained):
            min_frac = float(min(max(setup.percent_contained / 100.0, 0.0), 1.0))
    return held_perimeter(setup.observed, setup.sim_start_h, setup.res_m, setup.time_origin_ms, setup.detections,
                          window_h=settings.active_window_h, radius_m=settings.active_radius_m, markers=markers,
                          min_held_fraction=min_frac, edge_m=float(getattr(settings, "active_edge_m", 0.0) or 0.0),
                          growth_only=bool(getattr(settings, "active_growth_only", False)))


def member_tasks(setup: ForecastSetup, settings: SpreadSettings, group: Any = None, index0: int = 0,
                 hold: np.ndarray | None = None) -> list[MemberTask]:
    """One :class:`MemberTask` per weather member of ``setup`` (``hold``: held cells, see :func:`setup_hold`)."""
    sim_h = (setup.end_ms - setup.sim_start_ms) / config.MS_PER_H
    if hold is None and settings.hold_inactive:
        hold, _ = setup_hold(setup, settings)
    return [
        MemberTask(
            index=index0 + i,
            bundle_dir=str(setup.bundle_dir),
            weather=mw,
            ignition=setup.ignition_mask,
            start_ms=setup.sim_start_ms,
            horizon_h=sim_h,
            time_origin_ms=setup.time_origin_ms,
            settings=settings,
            series_start_h=setup.start_h,
            series_hours=setup.horizon_h,
            group=group,
            seed=i,
            hold=hold,
        )
        for i, mw in enumerate(setup.members)
    ]


def run_members(setup: ForecastSetup, settings: SpreadSettings, workers: int | None = None,
                progress: ProgressFn | None = None, budget_s: float | None = None) -> tuple[list[dict], list[str]]:
    """Run every member of ``setup`` with the SPEC 8.5 time budget / x2 downsample fallback."""
    progress = progress or no_progress
    tasks = member_tasks(setup, settings)
    n = len(tasks)
    w = min(max(1, int(workers or default_workers())), n)
    budget = float(BUDGET_S if budget_s is None else budget_s)
    rounds = math.ceil(n / w)
    m = int(setup.ignition_mask.shape[0])
    can_coarsen = m % DOWNSAMPLE_FACTOR == 0 and m // DOWNSAMPLE_FACTOR >= 16
    cap = max(MIN_MEMBER_CAP_S, budget / rounds) if budget > 0 and can_coarsen else None
    tmp = tempfile.mkdtemp(prefix="fire3d-forecast-")
    flag = os.path.join(tmp, "coarse.flag")
    warnings: list[str] = []
    try:
        for t in tasks:
            t.cap_s, t.flag_path, t.chunk_h = cap, flag, CHUNK_H
        results, w1 = run_member_tasks(tasks, w, progress, "spread")
        warnings += w1
        if os.path.exists(flag):
            redo = [t for t, r in zip(tasks, results) if r["factor"] == 1]
            for t in redo:
                t.factor, t.cap_s, t.flag_path, t.chunk_h = DOWNSAMPLE_FACTOR, None, None, None
            if redo:
                progress("spread", 1.0, f"re-running {len(redo)} member(s) on the coarse grid")
                again, w2 = run_member_tasks(redo, w, progress, "spread-coarse")
                warnings += w2
                by_index = {r["index"]: r for r in again}
                results = [by_index.get(r["index"], r) for r in results]
            res = setup.res_m
            warnings.append(
                f"members exceeded the {cap:.0f} s per-member budget at {res:.1f} m: all {n} members ran on a x{DOWNSAMPLE_FACTOR} "
                f"downsampled grid ({res * DOWNSAMPLE_FACTOR:.1f} m) and were upsampled (nearest)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return results, warnings


# ----------------------------------------------------------------------------------------------------------------
# Aggregation
# ----------------------------------------------------------------------------------------------------------------
def aggregate(results: list[dict], start_h: float, horizon_h: int, res_m: float) -> dict:
    """Quantile maps, burn probability, flame length p50 and hourly series from member results."""
    if not results:
        raise ForecastError("no member results to aggregate")
    arr = np.stack([r["arrival_h"] for r in results]).astype(np.float32)
    end_h = start_h + horizon_h
    q = quantile_maps(arr, QUANTILES)
    out = {
        "arrival_p10": q[10],
        "arrival_p50": q[50],
        "arrival_p90": q[90],
        "burn_probability": burn_probability(arr, end_h),
        "flame_length_p50": flame_length_p50(arr, np.stack([r["flame_m"] for r in results])),
    }
    areas = np.stack([area_acres_series(a, start_h, horizon_h, res_m) for a in arr])
    ros = np.stack([np.asarray(r["ros_ch_h"], dtype=np.float64) for r in results])
    out["area_p10"] = series_quantile(areas, 10)
    out["area_p50"] = series_quantile(areas, 50)
    out["area_p90"] = series_quantile(areas, 90)
    out["ros_p50"] = series_quantile(ros, 50)
    out["areas"] = areas
    return out


# ----------------------------------------------------------------------------------------------------------------
# Writing
# ----------------------------------------------------------------------------------------------------------------
LAYER_SPECS = {
    "arrival_p10": ("h", "Arrival time, 10th percentile across members (hours since time_origin_ms; NEVER = 1e6)"),
    "arrival_p50": ("h", "Arrival time, median across members (hours since time_origin_ms; NEVER = 1e6)"),
    "arrival_p90": ("h", "Arrival time, 90th percentile across members (hours since time_origin_ms; NEVER = 1e6)"),
    "burn_probability": ("fraction", "Fraction of members burned by start + horizon"),
    "flame_length_p50": ("m", "Median flame length over members that burned the pixel"),
}


def make_run_id(start_ms: int, ensemble: str, salt: str) -> str:
    """``fc-YYYYmmddTHHMM-{ensemble}-{hash4}`` (UTC start)."""
    stamp = ms_to_dt(start_ms).strftime("%Y%m%dT%H%M")
    h = hashlib.sha1(f"{start_ms}|{ensemble}|{salt}".encode()).hexdigest()[:4]
    return f"fc-{stamp}-{ensemble}-{h}"


def _unique_run_id(bdir: Path, start_ms: int, ensemble: str, salt: str) -> str:
    existing = {f.get("run_id") for f in (fbundle.load_manifest(bdir) or {}).get("forecasts", [])}
    for k in range(1000):
        rid = make_run_id(start_ms, ensemble, f"{salt}|{k}")
        if rid not in existing and not (bdir / fbundle.FORECASTS_DIR / rid).exists():
            return rid
    raise ForecastError("could not allocate a forecast run id")


def _summary_entry(run_id: str, status: str, issued: int, setup: ForecastSetup, members: int) -> dict:
    return {
        "run_id": run_id,
        "status": status,
        "issued_ms": int(issued),
        "start_ms": int(setup.start_ms),
        "horizon_h": int(setup.horizon_h),
        "ensemble": setup.ensemble,
        "members": int(members),
        "file": f"{fbundle.FORECASTS_DIR}/{run_id}/forecast.json",
    }


def _put_entry(bdir: Path, entry: dict, issued: int) -> None:
    """Insert/replace ``entry`` in ``manifest.forecasts`` (newest first); stale "running" entries become "error"."""

    def fn(m: dict) -> None:
        fl = [f for f in (m.get("forecasts") or []) if isinstance(f, dict) and f.get("run_id") != entry["run_id"]]
        for f in fl:
            if f.get("status") == "running" and int(f.get("issued_ms") or 0) < issued - STALE_RUNNING_MS:
                f["status"] = "error"
        fl.append(entry)
        fl.sort(key=lambda f: int(f.get("issued_ms") or 0), reverse=True)
        m["forecasts"] = fl

    fbundle.update_manifest(bdir, fn)


def _layer_infos_placeholder(run_id: str, m: int) -> dict:
    return {
        name: {"file": f"{fbundle.FORECASTS_DIR}/{run_id}/{name}.bin", "grid": "fire", "dtype": "float32", "width": m,
               "height": m, "units": units, "description": f"{desc} (not written: the run failed)"}
        for name, (units, desc) in LAYER_SPECS.items()
    }


def _model_info(settings: SpreadSettings, res_m: float) -> dict:
    return {
        "engine": "pyretechnics",
        "version": engine.pyretechnics_version(),
        "surface_lw_ratio_model": str(settings.surface_lw_ratio_model),
        "crown": bool(settings.crown),
        "spotting": bool(settings.spotting),
        "spread_adjustment": float(settings.spread_adjustment),
        "grid_res_m": float(res_m),
    }


def run_forecast(
    bundle_dir: Path,
    start_ms: int | None = None,
    horizon_h: int = 72,
    ensemble: str = "auto",
    members: int | None = None,
    progress: ProgressFn | None = None,
    *,
    settings: SpreadSettings | None = None,
    workers: int | None = None,
    budget_s: float | None = None,
) -> ForecastManifest:
    """Run every member, write ``forecasts/{run_id}/`` (forecast.json + p10/p50/p90, burn_probability,
    flame_length_p50) and prepend its ForecastSummary to ``manifest.forecasts`` (running -> ready / error).

    Defaults (SPEC 6): live start = ``time_range.now_ms`` (the latest observation, which can be a confirmed satellite
    pass after the last detection), historical = ignition + 24 h; ``"auto"`` ensemble =
    gfs025 (live) / perturbed (historical). Keyword extras: ``settings`` (spread_adjustment, crown, ...),
    ``workers`` and ``budget_s`` (0 disables the downsample fallback).

    Errors while setting up (no bundle/static inputs, bad start or horizon, no weather) raise before any manifest
    entry exists; failures after that mark the entry and forecast.json "error" and raise :class:`ForecastError`.
    """
    progress = progress or no_progress
    settings = settings or forecast_settings()
    t_wall = time.perf_counter()
    issued = now_ms()
    bdir = Path(bundle_dir)
    setup = prepare_forecast(bdir, start_ms, horizon_h, ensemble, members, progress)
    settings = live_settings(setup, settings)
    t_setup = time.perf_counter() - t_wall
    run_id = _unique_run_id(bdir, setup.start_ms, setup.ensemble, f"{setup.incident_id}|{issued}|{os.getpid()}|{settings}")
    n = len(setup.members)
    try:
        wui_note = engine.wui_summary(engine.load_static_inputs(bdir), settings)
    except (OSError, ValueError) as e:
        wui_note = None
        log.warning("WUI summary unavailable: %s", e)
    if wui_note:
        setup.warnings.append(wui_note)
    if setup.mode == "live":
        from ..build import live_observation

        start_note = live_observation.describe_start(setup.activity, setup.start_ms, setup.time_zone)
        if start_note:
            setup.warnings.append(start_note)
    adj_note = adjustment_note(settings, setup.sim_start_ms)
    if adj_note:
        setup.warnings.append(adj_note)
    _, hold_stats = setup_hold(setup, settings)
    if hold_stats.get("held_fraction") or hold_stats.get("held_fraction_with_containment"):
        setup.warnings.append(hold_note(hold_stats, settings, setup.issuer))
    _put_entry(bdir, _summary_entry(run_id, "running", issued, setup, n), issued)
    rel_dir = f"{fbundle.FORECASTS_DIR}/{run_id}"
    fdir = fbundle.forecast_dir(bdir, run_id)
    m = int(setup.ignition_mask.shape[0])
    warnings = list(setup.warnings)
    try:
        progress("spread", 0.0, f"{n} member(s), {setup.horizon_h} h from {ms_to_iso(setup.start_ms)}")
        t1 = time.perf_counter()
        results, w_run = run_members(setup, settings, workers, progress, budget_s)
        t_members = time.perf_counter() - t1
        warnings += w_run
        for r in results:
            for wmsg in r["warnings"]:
                if wmsg not in warnings:
                    warnings.append(wmsg)
        progress("aggregate", 0.0, "arrival quantiles and burn probability")
        t2 = time.perf_counter()
        agg = aggregate(results, setup.start_h, setup.horizon_h, setup.res_m)
        edge = sum(1 for r in results if r["reached_edge"])
        if edge:
            warnings.append(f"{edge}/{n} members reached the AOI boundary: spread beyond it is not simulated, so burn "
                            "probability near the edge is underestimated")
        skill = None
        if setup.observed is not None and setup.data_end_ms is not None:
            data_end_h = (setup.data_end_ms - setup.time_origin_ms) / config.MS_PER_H
            rows = skill_from_arrays(agg["arrival_p50"], setup.observed, setup.start_h, setup.res_m, LEAD_HOURS,
                                     horizon_h=setup.horizon_h, data_end_h=data_end_h, growth=True)
            skill = [skill_entry(r) for r in rows] or None
        progress("write", 0.0, f"writing {rel_dir}")
        layers = {
            name: fbundle.write_layer(bdir, name, agg[name], "fire", units, desc, rel_dir=rel_dir, register=False)
            for name, (units, desc) in LAYER_SPECS.items()
        }
        sim_res = max(r["sim_res_m"] for r in results)
        runtimes = np.array([r["runtime_s"] for r in results])
        crown = np.sum([r["fire_type_counts"] for r in results], axis=0)
        t_agg = time.perf_counter() - t2
        warnings.append(
            f"timing: setup {t_setup:.1f} s, {n} members {t_members:.1f} s on {min(n, workers or default_workers())} "
            f"worker(s) (member median {np.median(runtimes):.1f} s, max {runtimes.max():.1f} s), aggregation+write {t_agg:.1f} s; "
            f"crown fire {100.0 * (crown[2] + crown[3]) / max(1, crown.sum()):.1f}% of newly burned cells")
        hours = np.arange(setup.horizon_h + 1)
        doc = {
            "run_id": run_id,
            "incident_id": setup.incident_id,
            "status": "ready",
            "issued_ms": int(issued),
            "start_ms": int(setup.start_ms),
            "horizon_h": int(setup.horizon_h),
            "time_origin_ms": int(setup.time_origin_ms),
            "model": _model_info(settings, sim_res),
            "weather": {"source": setup.weather_source, "ensemble": setup.ensemble, "members": int(n)},
            "layers": layers,
            "series": {
                "t_ms": [int(setup.start_ms + int(k) * config.MS_PER_H) for k in hours],
                "area_acres_p10": [round(float(v), 1) for v in agg["area_p10"]],
                "area_acres_p50": [round(float(v), 1) for v in agg["area_p50"]],
                "area_acres_p90": [round(float(v), 1) for v in agg["area_p90"]],
                "ros_ch_per_h_p50": [round(float(v), 2) for v in agg["ros_p50"]],
            },
            "runtime_s": round(time.perf_counter() - t_wall, 2),
            "warnings": warnings,
        }
        if skill:
            doc["skill"] = skill
        fm = validate_strict(ForecastManifest, doc)
        fbundle.write_json(fdir / "forecast.json", doc, indent=True)
        _put_entry(bdir, _summary_entry(run_id, "ready", issued, setup, n), issued)
        progress("write", 1.0, f"forecast {run_id} ready")
        log.info("forecast %s ready: %d members, %.1f s", run_id, n, doc["runtime_s"])
        return fm
    except Exception as e:
        err = config.mask_secrets(f"{type(e).__name__}: {e}")
        log.exception("forecast %s failed", run_id)
        try:
            doc = {
                "run_id": run_id, "incident_id": setup.incident_id, "status": "error", "error": err,
                "issued_ms": int(issued), "start_ms": int(setup.start_ms), "horizon_h": int(setup.horizon_h),
                "time_origin_ms": int(setup.time_origin_ms), "model": _model_info(settings, setup.res_m),
                "weather": {"source": setup.weather_source, "ensemble": setup.ensemble, "members": int(n)},
                "layers": _layer_infos_placeholder(run_id, m),
                "series": {"t_ms": [], "area_acres_p10": [], "area_acres_p50": [], "area_acres_p90": [], "ros_ch_per_h_p50": []},
                "runtime_s": round(time.perf_counter() - t_wall, 2), "warnings": warnings,
            }
            fbundle.write_json(fdir / "forecast.json", doc, indent=True)
        finally:
            _put_entry(bdir, _summary_entry(run_id, "error", issued, setup, n), issued)
        if isinstance(e, ForecastError):
            raise
        raise ForecastError(err) from e
