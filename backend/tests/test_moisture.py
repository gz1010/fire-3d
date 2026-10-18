"""spread/moisture.py: Simard EMC, dead fuel moisture lags and spin-up, live fuel moisture, Fosberg FFWI."""

from __future__ import annotations

import math

import numpy as np
import pytest

from fire3d import config
from fire3d.spread import moisture as mo


def f_to_c(f: float) -> float:
    return (f - 32.0) / 1.8


# ----------------------------------------------------------------------------------------------------------------
# EMC (Simard 1968)
# ----------------------------------------------------------------------------------------------------------------
def test_emc_reference_values() -> None:
    # 80 °F / 20 % -> 2.22749 + 0.160107*20 - 0.01478*80 = 4.247 %
    assert mo.emc(f_to_c(80.0), 20.0) == pytest.approx(4.24723, abs=1e-4)
    assert 3.5 <= mo.emc(f_to_c(80.0), 20.0) <= 4.5
    # RH < 10 branch: 0.03229 + 0.281073*5 - 0.000578*5*80
    assert mo.emc(f_to_c(80.0), 5.0) == pytest.approx(1.206455, abs=1e-4)
    # RH >= 50 branch at 60 °F / 70 %
    assert mo.emc(f_to_c(60.0), 70.0) == pytest.approx(21.0606 + 0.005565 * 4900 - 0.00035 * 70 * 60 - 0.483199 * 70, abs=1e-4)
    assert isinstance(mo.emc(20.0, 30.0), float)


def test_emc_monotone_in_rh_and_temperature() -> None:
    rh = np.arange(0.0, 100.5, 0.5)
    for t in (-5.0, 10.0, 20.0, 30.0, 40.0):
        e = mo.emc(np.full_like(rh, t), rh)
        assert np.all(np.diff(e) >= 0.0), f"EMC not monotone in RH at {t} °C"
    temps = np.linspace(-10.0, 45.0, 56)
    for h in (5.0, 20.0, 45.0, 80.0):
        e = mo.emc(temps, np.full_like(temps, h))
        assert np.all(np.diff(e) <= 1e-12), f"EMC should not increase with temperature at RH {h}"
    assert np.all(mo.emc(temps, np.full_like(temps, 0.0)) >= 0.0)


def test_emc_broadcasts_and_clips() -> None:
    e = mo.emc(np.full((5, 4, 4), 25.0), 30.0)
    assert e.shape == (5, 4, 4)
    assert mo.emc(25.0, 140.0) == pytest.approx(mo.emc(25.0, 100.0))
    assert mo.emc(25.0, -5.0) == pytest.approx(mo.emc(25.0, 0.0))


# ----------------------------------------------------------------------------------------------------------------
# Dead fuel moisture
# ----------------------------------------------------------------------------------------------------------------
def test_one_hour_is_103_percent_of_emc_with_floor() -> None:
    t = np.array([20.0, 30.0, 26.0])
    h = np.array([40.0, 15.0, 70.0])
    fm1, _, _ = mo.dead_fuel_moisture(t, h)
    assert np.allclose(fm1, np.maximum(1.03 * mo.emc(t, h) / 100.0, mo.MIN_DEAD_FM))
    fm1_dry, fm10_dry, fm100_dry = mo.dead_fuel_moisture(np.full(10, 42.0), np.full(10, 2.0))
    assert np.all(fm1_dry == mo.MIN_DEAD_FM) and np.all(fm10_dry >= mo.MIN_DEAD_FM) and np.all(fm100_dry >= mo.MIN_DEAD_FM)


def test_lags_follow_exponential_response() -> None:
    T, n0 = 400, 50
    temp = np.full(T, f_to_c(80.0))
    rh = np.where(np.arange(T) < n0, 20.0, 60.0)
    e1, e2 = mo.emc(temp[0], 20.0) / 100.0, mo.emc(temp[0], 60.0) / 100.0
    fm1, fm10, fm100 = mo.dead_fuel_moisture(temp, rh, init=(e1, e1))
    assert np.allclose(fm10[:n0], e1) and np.allclose(fm100[:n0], e1)
    for k in (1, 5, 10, 30):
        assert fm10[n0 + k - 1] == pytest.approx(e2 + (e1 - e2) * math.exp(-k / 10.0), rel=1e-9)
    for k in (10, 100, 300):
        assert fm100[n0 + k - 1] == pytest.approx(e2 + (e1 - e2) * math.exp(-k / 100.0), rel=1e-9)
    # after one time constant the lagged classes have covered 1 - 1/e of the step; 1-h follows instantly
    assert (fm10[n0 + 9] - e1) / (e2 - e1) == pytest.approx(1 - math.exp(-1), abs=1e-9)
    assert (fm100[n0 + 99] - e1) / (e2 - e1) == pytest.approx(1 - math.exp(-1), abs=1e-9)
    assert fm1[n0] == pytest.approx(1.03 * e2)
    # 100-h responds more slowly than 10-h
    assert np.all(fm100[n0:n0 + 200] <= fm10[n0:n0 + 200] + 1e-12)


def test_dt_scales_the_lag() -> None:
    temp = np.full(20, 25.0)
    rh = np.concatenate([np.full(5, 15.0), np.full(15, 70.0)])
    e1, e2 = mo.emc(25.0, 15.0) / 100.0, mo.emc(25.0, 70.0) / 100.0
    _, f10_h, _ = mo.dead_fuel_moisture(temp, rh, dt_h=1.0, init=e1)
    _, f10_2h, _ = mo.dead_fuel_moisture(temp, rh, dt_h=2.0, init=e1)
    # two-hour steps move twice as far per step: 3 steps of 2 h == 6 steps of 1 h
    assert f10_2h[5 + 2] == pytest.approx(e2 + (e1 - e2) * math.exp(-6 / 10.0), rel=1e-9)
    assert f10_h[5 + 5] == pytest.approx(e2 + (e1 - e2) * math.exp(-6 / 10.0), rel=1e-9)


def test_spin_up_init_is_mean_emc_of_first_72h() -> None:
    T = 200
    hours = np.arange(T)
    temp = 22.0 + 8.0 * np.sin(2 * np.pi * hours / 24.0)
    rh = 35.0 - 15.0 * np.sin(2 * np.pi * hours / 24.0)
    _, fm10, fm100 = mo.dead_fuel_moisture(temp, rh)
    m0 = float(np.mean(mo.emc(temp[:72], rh[:72]) / 100.0))
    a10, a100 = 1 - math.exp(-0.1), 1 - math.exp(-0.01)
    e0 = mo.emc(temp[0], rh[0]) / 100.0
    assert fm10[0] == pytest.approx(m0 + a10 * (e0 - m0), rel=1e-9)
    assert fm100[0] == pytest.approx(m0 + a100 * (e0 - m0), rel=1e-9)
    # after the 72 h spin-up the diurnal cycle is damped: 100-h varies far less than 10-h, which varies less than 1-h
    fm1 = mo.dead_fuel_moisture(temp, rh)[0]
    sl = slice(72, T)
    assert np.ptp(fm100[sl]) < np.ptp(fm10[sl]) < np.ptp(fm1[sl])


def test_init_pair_and_grid_shapes() -> None:
    temp = np.full((30, 4, 4), 25.0)
    rh = np.full((30, 4, 4), 25.0)
    fm1, fm10, fm100 = mo.dead_fuel_moisture(temp, rh, init=(0.12, 0.2))
    assert fm1.shape == fm10.shape == fm100.shape == (30, 4, 4)
    e = mo.emc(25.0, 25.0) / 100.0
    assert np.allclose(fm10[0], 0.12 + (1 - math.exp(-0.1)) * (e - 0.12))
    assert np.allclose(fm100[0], 0.2 + (1 - math.exp(-0.01)) * (e - 0.2))
    one = mo.dead_fuel_moisture(25.0, 25.0)
    assert all(a.shape == (1,) for a in one)


def test_rain_wets_fuels() -> None:
    T = 48
    temp = np.full(T, 18.0)
    rh = np.full(T, 40.0)
    precip = np.zeros(T)
    precip[20:24] = 2.0
    dry = mo.dead_fuel_moisture(temp, rh)
    wet = mo.dead_fuel_moisture(temp, rh, precip_mm=precip)
    assert np.all(wet[0][20:24] >= mo.WET_FUEL_MOISTURE)
    assert wet[1][23] > dry[1][23] + 0.05      # 10-h wets up over 4 h of rain
    assert wet[2][23] > dry[2][23]             # 100-h a little
    assert np.allclose(wet[0][:20], dry[0][:20]) and np.allclose(wet[0][24:], dry[0][24:])   # 1-h recovers at once
    drizzle = precip.copy()
    drizzle[20:24] = 0.1                       # below 0.25 mm/h: no effect
    assert np.allclose(mo.dead_fuel_moisture(temp, rh, precip_mm=drizzle)[1], dry[1])


# ----------------------------------------------------------------------------------------------------------------
# Live fuel moisture
# ----------------------------------------------------------------------------------------------------------------
def test_live_fuel_moisture_by_month(monkeypatch: pytest.MonkeyPatch) -> None:
    assert mo.live_fuel_moisture(1) == (1.2, 1.2)
    assert mo.live_fuel_moisture(4) == (1.2, 1.2)
    assert mo.live_fuel_moisture(5) == (0.6, 1.0)
    assert mo.live_fuel_moisture(8) == (0.3, 0.7)
    assert mo.live_fuel_moisture(10) == (0.3, 0.7)
    assert mo.live_fuel_moisture(12) == (0.6, 0.9)
    for bad in (0, 13):
        with pytest.raises(ValueError):
            mo.live_fuel_moisture(bad)
    table = dict(config.LIVE_FUEL_MOISTURE_BY_MONTH)
    table[8] = (0.45, 0.8)
    monkeypatch.setattr(config, "LIVE_FUEL_MOISTURE_BY_MONTH", table)
    assert mo.live_fuel_moisture(8) == (0.45, 0.8)     # configurable


# ----------------------------------------------------------------------------------------------------------------
# FFWI (Fosberg 1978)
# ----------------------------------------------------------------------------------------------------------------
def test_ffwi_reference_values() -> None:
    mph = 1 / 2.2369362920544025                        # 1 mph in m/s
    # 80 °F, 20 % (EMC 4.247 %), 20 mph -> eta 0.74550 * sqrt(401) / 0.3002 = 49.73
    assert mo.ffwi(f_to_c(80.0), 20.0, 20 * mph) == pytest.approx(49.73, abs=0.02)
    # bone dry (RH 0) with 30 mph is ~100 by construction; calm is 1/0.3002 * eta
    assert mo.ffwi(f_to_c(80.0), 0.0, 30 * mph) == pytest.approx(99.77, abs=0.05)
    assert mo.ffwi(f_to_c(80.0), 0.0, 0.0) == pytest.approx(3.324, abs=0.002)
    # EMC capped at 30 % -> eta = 0
    assert mo.ffwi(20.0, 100.0, 5.0) >= 0.0


def test_ffwi_monotonicity_and_shapes() -> None:
    wind = np.linspace(0.0, 25.0, 26)
    f = mo.ffwi(np.full_like(wind, 25.0), np.full_like(wind, 15.0), wind)
    assert np.all(np.diff(f) > 0)
    rh = np.linspace(1.0, 99.0, 50)
    g = mo.ffwi(np.full_like(rh, 25.0), rh, np.full_like(rh, 8.0))
    assert np.all(np.diff(g) <= 1e-9)
    assert mo.ffwi(np.full((3, 4, 4), 25.0), 20.0, 10.0).shape == (3, 4, 4)
    assert isinstance(mo.ffwi(25.0, 20.0, 10.0), float)
    # Santa Ana-like conditions score far above a mild day
    assert mo.ffwi(18.0, 8.0, 15.0) > 60 > mo.ffwi(18.0, 60.0, 3.0)
