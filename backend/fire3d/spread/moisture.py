"""Fuel moisture and fire-weather indices (SPEC 8.4). Owner: weather agent.

* :func:`emc` - equilibrium moisture content (%) from the Simard (1968) regressions on °F and RH %.
* :func:`dead_fuel_moisture` - hourly dead fuel moisture fractions: 1-h ≈ 1.03·EMC; 10-h and 100-h are first-order
  (exponential) lags of EMC with τ = 10 h / 100 h. Optional precipitation wets the fuels while it rains.
* :func:`live_fuel_moisture` - California monthly defaults from ``config.LIVE_FUEL_MOISTURE_BY_MONTH``, optionally
  drought-adjusted by the water-year precipitation (:func:`greenup_fraction`).
* :func:`daily_gsi` / :func:`gsi_mean` / :func:`gsi_live_fuel_moisture` - outside California, the NFDRS 2016 Growing
  Season Index (Jolly et al. 2005; NFDRS4 default parameters in ``config.GSI_*``) and its herb / woody mapping.
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


# ---------------------------------------------------------------------------------------------------------------
# NFDRS 2016 Growing Season Index (outside California; CONTRACT 14.12.10, docs/validation.md section 10.1)
# ---------------------------------------------------------------------------------------------------------------
# MT-CLIM day-length constants as in NFDRS4 (lib/NFDRS4/include/livefuelmoisture.h)
_SECPERRAD = 13750.9871        # seconds of day length per radian of hour angle
_RADPERDAY = 0.017214          # radians of Earth orbit per day
_RADPERDEG = 0.01745329
_MINDECL = -0.4092797          # declination at the winter solstice (rad)
_DAYSOFF = 10.25               # day-of-year offset of the winter solstice


def _ramp(x, lo: float, hi: float):
    """0 at ``lo`` .. 1 at ``hi``, linear and clamped (``lo > hi`` gives a falling ramp)."""
    x = np.asarray(x, dtype=np.float64)
    return np.clip((x - lo) / (hi - lo), 0.0, 1.0)


def saturation_vp_pa(temp_c):
    """Saturation vapour pressure (Pa) as in NFDRS4 ``CalcVP``: 610.7 · exp(17.38 · T / (239 + T)), T in °C."""
    t = np.asarray(temp_c, dtype=np.float64)
    return _scalar_out(610.7 * np.exp(17.38 * t / (239.0 + t)), temp_c)


def gsi_vpd_pa(tmax_c, rhmin_pct):
    """Daily vapour pressure deficit (Pa) of NFDRS4's default GSI (``CalcGSI``): es(Tmax) · (1 − RH / 100) with
    RH = max(daily minimum RH, 5 %), floored at 0."""
    rh = np.maximum(np.asarray(rhmin_pct, dtype=np.float64), config.GSI_RH_FLOOR_PCT)
    es = np.asarray(saturation_vp_pa(tmax_c), dtype=np.float64)
    return _scalar_out(np.maximum(es * (1.0 - rh / 100.0), 0.0), tmax_c, rhmin_pct)


def daylength_s(lat_deg, yday):
    """Day length (s) by the MT-CLIM formula NFDRS4 uses (``CalcDayl``): declination −0.4092797 · cos((yday + 10.25)
    · 0.017214) rad, sunset hour angle acos(−tan(lat) · tan(decl)), day length 2 · angle · 13750.9871 s."""
    lat = np.clip(np.asarray(lat_deg, dtype=np.float64) * _RADPERDEG, -1.5707, 1.5707)
    decl = _MINDECL * np.cos((np.asarray(yday, dtype=np.float64) + _DAYSOFF) * _RADPERDAY)
    coshss = np.clip(-(np.sin(lat) * np.sin(decl)) / (np.cos(lat) * np.cos(decl)), -1.0, 1.0)
    return _scalar_out(2.0 * np.arccos(coshss) * _SECPERRAD, lat_deg, yday)


def gsi_indicators(tmin_c, vpd_pa, dayl_s) -> tuple:
    """``(iTmin, iVPD, iDayl)`` of Jolly et al. (2005) with the NFDRS4 limits (``config.GSI_*``)."""
    t_lo, t_hi = config.GSI_TMIN_C
    v_lo, v_hi = config.GSI_VPD_PA
    d_lo, d_hi = config.GSI_DAYL_S
    it = _ramp(tmin_c, t_lo, t_hi)
    iv = 1.0 - _ramp(vpd_pa, v_lo, v_hi)
    idl = _ramp(dayl_s, d_lo, d_hi)
    return tuple(_scalar_out(a, tmin_c, vpd_pa, dayl_s) for a in (it, iv, idl))


def daily_gsi(tmin_c, tmax_c, rhmin_pct, lat_deg, yday):
    """Daily Growing Season Index iTmin · iVPD · iDayl (0..1) from the day's minimum and maximum temperature (°C),
    minimum relative humidity (%), the latitude and the day of year (1-366)."""
    it, iv, idl = gsi_indicators(tmin_c, gsi_vpd_pa(tmax_c, rhmin_pct), daylength_s(lat_deg, yday))
    out = np.asarray(it) * np.asarray(iv) * np.asarray(idl)
    return _scalar_out(out, tmin_c, tmax_c, rhmin_pct, lat_deg, yday)


def gsi_mean(daily_values) -> float | None:
    """The moving-average GSI: the mean of the given daily values (the caller passes the 21 days before a start),
    scaled by ``config.GSI_MAX`` and clamped to 0..1; None when any value is missing or the list is short."""
    raw = list(daily_values)
    v = [float(x) for x in raw if x is not None and np.isfinite(float(x))]
    if len(v) < int(config.GSI_MA_DAYS) or len(v) != len(raw):
        return None
    return float(np.clip(np.mean(v) / float(config.GSI_MAX), 0.0, 1.0))


def gsi_live_fuel_moisture(gsi: float) -> tuple[float, float]:
    """``(herb, woody)`` live fuel moisture fractions from the scaled GSI (NFDRS4 ``SetLFMParameters`` defaults):
    below the green-up threshold (0.5) the minimum (herb 30 %, woody 60 %); at or above it, linear up to the maximum at
    GSI 1 (herb 250 %, woody 200 %). The herb is treated as perennial (no annual curing state, no snow-day flag)."""
    g = float(np.clip(gsi, 0.0, 1.0))
    thr = float(config.GSI_GREENUP)
    out = []
    for lo, hi in (config.GSI_HERB_LFM, config.GSI_WOODY_LFM):
        lo, hi = float(lo), float(hi)
        out.append(lo if g < thr else lo + (g - thr) / (1.0 - thr) * (hi - lo))
    return float(out[0]), float(out[1])


def ffwi(temp_c, rh_pct, wind_ms):
    """Fosberg Fire Weather Index: ``η · sqrt(1 + U²) / 0.3002`` with U the wind speed in mph and
    ``η = 1 − 2(m/30) + 1.5(m/30)² − 0.5(m/30)³``, m = EMC % (capped at 30). 100 ≈ EMC 0 % with a 30 mph wind."""
    m = np.minimum(np.asarray(emc(temp_c, rh_pct), dtype=np.float64), 30.0) / 30.0
    eta = 1.0 - 2.0 * m + 1.5 * m * m - 0.5 * m ** 3
    u = np.maximum(np.asarray(wind_ms, dtype=np.float64), 0.0) * MS_TO_MPH
    out = np.maximum(eta, 0.0) * np.sqrt(1.0 + u * u) / 0.3002
    return _scalar_out(out, temp_c, rh_pct, wind_ms)
