"""Fuel moisture and fire-weather indices (SPEC 8.4). Owner: weather agent.

* :func:`emc` - equilibrium moisture content (%) from the Simard (1968) regressions on °F and RH %.
* :func:`dead_fuel_moisture` - hourly dead fuel moisture fractions: 1-h ≈ 1.03·EMC; 10-h and 100-h are first-order
  (exponential) lags of EMC with τ = 10 h / 100 h. Optional precipitation wets the fuels while it rains.
* :func:`live_fuel_moisture` - California monthly defaults from ``config.LIVE_FUEL_MOISTURE_BY_MONTH``, optionally
  drought-adjusted by the water-year precipitation (:func:`greenup_fraction`).
* :func:`ffwi` - Fosberg (1978) Fire Weather Index from EMC (%) and wind speed (mph).

All functions broadcast like numpy; time runs along axis 0 and any trailing shape (e.g. ``(T, 4, 4)``) works.
Scalars in -> floats out.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import lfilter

from .. import config

MS_TO_MPH = 2.2369362920544025
TAU_10H = 10.0                 # h, 10-h fuel time lag
TAU_100H = 100.0               # h, 100-h fuel time lag
ONE_HOUR_FACTOR = 1.03         # 1-h fuel moisture ≈ 1.03 · EMC
SPINUP_INIT_H = 72             # init=None: lagged classes start at the mean EMC of the first 72 h (the spin-up)
RAIN_MM_PER_H = 0.25           # precipitation rate that counts as "raining" (per hour of dt)
WET_FUEL_MOISTURE = 0.35       # target moisture while raining (NFDRS convention: 1-h = 10-h = 35 %)
MIN_DEAD_FM = 0.02             # physical floor for dead fuel moisture (fraction); Simard EMC alone reaches <1 %


def _scalar_out(arr: np.ndarray, *inputs) -> float | np.ndarray:
    return float(arr) if all(np.ndim(x) == 0 for x in inputs) else arr


def emc(temp_c, rh_pct):
    """Equilibrium moisture content (%) after Simard (1968), from air temperature (°C, converted to °F) and
    relative humidity (%, clipped to 0..100)::

        RH < 10:        0.03229 + 0.281073·H − 0.000578·H·T
        10 ≤ RH < 50:   2.22749 + 0.160107·H − 0.01478·T
        RH ≥ 50:        21.0606 + 0.005565·H² − 0.00035·H·T − 0.483199·H
    """
    t_f = np.asarray(temp_c, dtype=np.float64) * 1.8 + 32.0
    h = np.clip(np.asarray(rh_pct, dtype=np.float64), 0.0, 100.0)
    lo = 0.03229 + 0.281073 * h - 0.000578 * h * t_f
    mid = 2.22749 + 0.160107 * h - 0.01478 * t_f
    hi = 21.0606 + 0.005565 * h * h - 0.00035 * h * t_f - 0.483199 * h
    out = np.maximum(np.where(h < 10.0, lo, np.where(h < 50.0, mid, hi)), 0.0)
    return _scalar_out(out, temp_c, rh_pct)


def _lag(target: np.ndarray, tau_h: float, dt_h: float, init: np.ndarray) -> np.ndarray:
    """First-order lag along axis 0: ``m[n] = m[n-1] + a·(target[n] − m[n-1])``, ``a = 1 − exp(−dt/τ)``."""
    a = 1.0 - np.exp(-dt_h / tau_h)
    zi = ((1.0 - a) * np.broadcast_to(init, target.shape[1:]))[np.newaxis]
    y, _ = lfilter([a], [1.0, -(1.0 - a)], target, axis=0, zi=zi)
    return y


def _init_pair(init, target: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if init is None:
        n = max(1, min(SPINUP_INIT_H, target.shape[0]))
        m0 = target[:n].mean(axis=0)
        return m0, m0
    if isinstance(init, (tuple, list)) and len(init) == 2:
        return np.asarray(init[0], dtype=np.float64), np.asarray(init[1], dtype=np.float64)
    v = np.asarray(init, dtype=np.float64)
    return v, v


def dead_fuel_moisture(temp_c, rh_pct, dt_h: float = 1.0, init=None, *, precip_mm=None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Dead fuel moisture fractions ``(fm1, fm10, fm100)`` for a time series (time on axis 0, step ``dt_h`` h).

    * 1-h = 1.03 · EMC (instantaneous); 10-h / 100-h = exponential lags of EMC with τ = 10 h / 100 h.
    * ``init``: starting state of the lagged classes as fractions: a scalar/array (both classes) or a
      ``(fm10, fm100)`` pair. ``None`` spins up from the mean EMC of the first 72 h, so pass a series that
      starts >= 72 h before the period of interest.
    * ``precip_mm`` (optional, per step): while it rains (>= 0.25 mm/h) the target moisture is raised to 35 %.
    * Outputs are floored at 2 % (``MIN_DEAD_FM``).
    """
    t = np.asarray(temp_c, dtype=np.float64)
    h = np.asarray(rh_pct, dtype=np.float64)
    t, h = np.broadcast_arrays(t, h)
    if t.ndim == 0:
        t, h = t.reshape(1), h.reshape(1)
    e = np.asarray(emc(t, h), dtype=np.float64) / 100.0
    fm1 = ONE_HOUR_FACTOR * e
    target = e
    if precip_mm is not None:
        p = np.broadcast_to(np.asarray(precip_mm, dtype=np.float64), e.shape)
        wet = np.nan_to_num(p, nan=0.0) >= RAIN_MM_PER_H * dt_h
        fm1 = np.where(wet, np.maximum(fm1, WET_FUEL_MOISTURE), fm1)
        target = np.where(wet, np.maximum(e, WET_FUEL_MOISTURE), e)
    i10, i100 = _init_pair(init, target)
    fm10 = _lag(target, TAU_10H, dt_h, i10)
    fm100 = _lag(target, TAU_100H, dt_h, i100)
    return tuple(np.maximum(a, MIN_DEAD_FM) for a in (fm1, fm10, fm100))  # type: ignore[return-value]


def greenup_fraction(precip_wy_mm: float | None) -> float | None:
    """0 (no green-up: cured herbs, dry-season shrubs) .. 1 (normal green-up) from the water-year precipitation
    (mm since Oct 1) at the fire; None when the precipitation is unknown."""
    if precip_wy_mm is None or not np.isfinite(precip_wy_mm):
        return None
    lo, hi = config.GREENUP_MIN_PRECIP_MM, config.GREENUP_FULL_PRECIP_MM
    return float(np.clip((float(precip_wy_mm) - lo) / max(hi - lo, 1e-9), 0.0, 1.0))


def live_fuel_moisture(month: int, precip_wy_mm: float | None = None) -> tuple[float, float]:
    """``(herb, woody)`` live fuel moisture fractions for ``month`` (1-12), from
    ``config.LIVE_FUEL_MOISTURE_BY_MONTH`` (California defaults; edit there to recalibrate).

    With ``precip_wy_mm`` (water-year precipitation at the fire, mm since Oct 1) the month's values are blended
    toward the dry-season values ``config.LIVE_FUEL_MOISTURE_DRY`` when the rains that drive the winter green-up
    have not come (:func:`greenup_fraction`); months that are already at or below the dry values are unchanged."""
    m = int(month)
    if m not in config.LIVE_FUEL_MOISTURE_BY_MONTH:
        raise ValueError(f"month must be 1..12, got {month!r}")
    herb, woody = (float(v) for v in config.LIVE_FUEL_MOISTURE_BY_MONTH[m])
    g = greenup_fraction(precip_wy_mm) if config.DROUGHT_ADJUSTED_LFM else None
    if g is not None:
        dry_h, dry_w = (float(v) for v in config.LIVE_FUEL_MOISTURE_DRY)
        herb = min(herb, dry_h + g * max(herb - dry_h, 0.0))
        woody = min(woody, dry_w + g * max(woody - dry_w, 0.0))
    return float(herb), float(woody)


def ffwi(temp_c, rh_pct, wind_ms):
    """Fosberg Fire Weather Index: ``η · sqrt(1 + U²) / 0.3002`` with U the wind speed in mph and
    ``η = 1 − 2(m/30) + 1.5(m/30)² − 0.5(m/30)³``, m = EMC % (capped at 30). 100 ≈ EMC 0 % with a 30 mph wind."""
    m = np.minimum(np.asarray(emc(temp_c, rh_pct), dtype=np.float64), 30.0) / 30.0
    eta = 1.0 - 2.0 * m + 1.5 * m * m - 0.5 * m ** 3
    u = np.maximum(np.asarray(wind_ms, dtype=np.float64), 0.0) * MS_TO_MPH
    out = np.maximum(eta, 0.0) * np.sqrt(1.0 + u * u) / 0.3002
    return _scalar_out(out, temp_c, rh_pct, wind_ms)
