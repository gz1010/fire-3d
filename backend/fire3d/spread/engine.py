"""pyretechnics level-set spread for one ensemble member (SPEC 8.5). Owner: spread agent.

Conventions (verified by tests/test_spread_engine.py):

* pyretechnics indexes its space-time cubes ``(t, y, x)`` with **y increasing northward** (row 0 = SOUTH edge:
  ``eulerian_level_set.calc_dphi_dy_approx`` differentiates "south->north" along +y, wind/slope azimuths become
  (east, north) vectors, and the documentation plots every matrix with ``origin="lower"``). Bundle rasters have
  row 0 = NORTH, so every spatial input is flipped (``a[::-1]``) before it goes into a cube and every output is
  flipped back. Azimuths (aspect, wind FROM direction) are orientation-free and pass unchanged.
* Cube units: slope rise/run, aspect deg cw from N (downslope-facing), FBFM integer codes, canopy cover 0-1,
  canopy/base heights m, bulk density kg/m³, 10 m wind km/h, upwind (FROM) direction deg cw from N, moistures
  kg/kg, temperature °C (only needed for spotting), optional ``weather_spread_adjustment``.
* Static layers use a ``(1, M, M)`` base. Weather members come on the 4 x 4 grid ``[t][j][i]`` (j row north->south,
  i column west->east, like ``WeatherFile.grid``); u/v (and moisture) are bilinearly refined to a ``(T, W, W)`` base
  with ``W | M`` (W <= 32) so winds vary smoothly instead of in 4 km blocks with seams at the block edges.
* Bands are 60 min and centred on the hourly weather samples: the cube's temporal origin is
  ``weather.t_ms[0] - 30 min``, so band k holds sample k over ``[t_k - 30 min, t_k + 30 min)``. Missing hours
  (NaN) are filled from the nearest valid hour; a member that starts late or ends early is extended by
  persistence (with a warning).
* pyretechnics' fuel-model cache is a 300-slot C array holding only the codes in ``fuel_models.fuel_model_table``,
  and its frontier test treats every code outside 91-99 as burnable, so any other code (LANDFIRE nodata 0,
  94-97, garbage) would read uninitialised memory; such codes become non-burnable 99. Non-burnable codes 91, 92,
  93, 98 and 99 are passed as-is (pyretechnics never spreads into them).
* Crown fire: pyretechnics always evaluates Van Wagner initiation (canopy cover > 0.4). Cells without canopy fuel
  (canopy height <= 0 or bulk density <= 0) and every cell when ``settings.crown`` is False get a canopy base height
  of :data:`NO_CROWN_CBH_M`, which makes the critical fireline intensity unreachable while leaving the canopy's
  wind sheltering intact.
* ``time_of_arrival`` (minutes since the cube origin, NaN = unburned) becomes hours since ``time_origin_ms``; NaN
  becomes NEVER (1e6). Cells ignited at the start keep ``arrival = start`` (pyretechnics computes no behaviour for
  them: flame length 0, fire type reported as 1). No arrival is ever earlier than the start.
* Wildland-urban interface (``settings.wui``, docs/validation.md): LANDFIRE maps settlements as non-burnable NB1
  (91), so a modelled fire stops at every town edge although wind-driven fires spread through neighbourhoods by
  ember ignitions and structure-to-structure exposure. :func:`wui_mask` selects developed blocks within
  ``settings.wui_buffer_m`` (2.4 km, the SILVIS interface distance of Radeloff et al. 2005) of large wildland
  vegetation blocks (>= 75 % burnable within ~5 km²); isolated roads through wildland stay non-burnable. Those
  cells burn as ``settings.wui_fuel_model`` with their spread rate scaled by ``settings.wui_spread_adjustment``
  through pyretechnics' per-cell ``fuel_spread_adjustment`` cube. The mask covers 96 % of the developed land the
  2025 Eaton fire burned, but it opens ~10x more developed land than burned, and it lowered hindcast skill on
  Eaton, Madre and Palisades, so forecasts leave it off (``config.FORECAST_WUI``).
* :func:`run_member` makes exactly one ``spread_fire_with_phi_field`` call. :func:`simulate` can also run in chunks
  (``chunk_h``), resuming the same SpreadState, so a caller can watch the wall clock between chunks; chunked
  arrival times differ from a single call by well under a band (mean ~0.1 min for 24 h chunks, ~1 min for 6 h).
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Callable

import numpy as np

from .. import bundle as fbundle
from .. import config
from ..grid import slope_aspect
from ..types import STATIC_NPZ_KEYS, MemberResult, MemberWeather, SpreadSettings, StaticInputs

log = logging.getLogger(__name__)

NEVER = config.NEVER
BAND_MINUTES = 60.0
NONBURNABLE_CODES = (91, 92, 93, 98, 99)
NO_CROWN_CBH_M = 1000.0          # canopy base height that disables crowning (critical intensity ~5e6 kW/m)
MAX_WEATHER_GRID = 32            # finest weather base (W x W) used for the refined wind field
MAX_SLOPE = 4.0                  # rise/run cap (76 deg); LANDFIRE's slope range is 0-4
EARLY_EXIT_MIN = 1.0 / 60.0      # pyretechnics stops when less than 1 s of simulation time remains

# Spotting parameters (only used when SpreadSettings.spotting is True; SPEC: spotting off by default): the
# spot_config example of the pyretechnics documentation (section "How to Spread a Fire with Spotting").
SPOT_CONFIG_DEFAULTS: dict[str, float] = {
    "firebrands_per_unit_heat": 1e-6,       # firebrands/kJ
    "downwind_distance_mean": 10.0,         # m
    "fireline_intensity_exponent": 0.3,     # [-]
    "wind_speed_exponent": 0.55,            # [-]
    "downwind_variance_mean_ratio": 425.0,  # m²/m
    "crosswind_distance_stdev": 100.0,      # m
    "decay_distance": 200.0,                # m
}

# Wildland-urban interface (SPEC deviation documented in docs/validation.md)
WUI_CORE_RADIUS_M = 1262.0       # square window of ~5 km² (Radeloff et al. 2005: vegetated area >= 5 km²)
WUI_CORE_FRACTION = 0.75         # ... that is >= 75 % wildland vegetation
WUI_SETTLEMENT_RADIUS_M = 500.0  # settlement test window (1 km square) ...
WUI_SETTLEMENT_FRACTION = 0.25   # ... >= 25 % developed: towns incl. their streets, not isolated roads in wildland
DEVELOPED_CODE = 91              # FBFM40 NB1 urban/developed

_FUEL_CODES: np.ndarray | None = None


class SimulationAborted(RuntimeError):
    """Raised by :func:`simulate` when its ``check`` callback returns False between chunks."""


def _known_fuel_codes() -> np.ndarray:
    """Sorted fuel-model numbers present in pyretechnics' fuel_model_table."""
    global _FUEL_CODES
    if _FUEL_CODES is None:
        import pyretechnics.fuel_models as fm

        _FUEL_CODES = np.array(sorted(int(c) for c in fm.list_fuel_model_numbers()), dtype=np.int16)
    return _FUEL_CODES


def pyretechnics_version() -> str:
    """Installed pyretechnics version string."""
    try:
        from importlib.metadata import version

        return version("pyretechnics")
    except Exception:  # pragma: no cover - metadata always present in our env
        return "unknown"


def is_burnable_code(codes) -> np.ndarray:
    """True where an FBFM code is a burnable model known to pyretechnics."""
    c = np.asarray(codes).astype(np.int64)
    known = np.isin(c, _known_fuel_codes())
    return known & ~((c >= 91) & (c <= 99))


def sanitize_fuel_codes(codes) -> np.ndarray:
    """int16 FBFM codes with every code missing from pyretechnics' table (0 = nodata, 94-97, ...) set to 99."""
    c = np.nan_to_num(np.asarray(codes, dtype=np.float64), nan=0.0).astype(np.int64)
    out = np.where(np.isin(c, _known_fuel_codes()), c, 99)
    return out.astype(np.int16)


def snap_to_burnable(fuel_codes: np.ndarray, row: int, col: int, max_cells: float) -> tuple[int, int] | None:
    """The burnable cell nearest to (row, col) within ``max_cells`` (Euclidean, in cells), or None."""
    burn = is_burnable_code(fuel_codes)
    h, w = burn.shape
    row, col = int(np.clip(row, 0, h - 1)), int(np.clip(col, 0, w - 1))
    if burn[row, col]:
        return row, col
    r = int(math.ceil(max_cells))
    r0, r1, c0, c1 = max(0, row - r), min(h, row + r + 1), max(0, col - r), min(w, col + r + 1)
    rr, cc = np.nonzero(burn[r0:r1, c0:c1])
    if rr.size == 0:
        return None
    d2 = (rr + r0 - row) ** 2 + (cc + c0 - col) ** 2
    k = int(np.argmin(d2))
    if d2[k] > max_cells ** 2:
        return None
    return int(rr[k] + r0), int(cc[k] + c0)


def reached_edge(arrival_h: np.ndarray, width: int = 1) -> bool:
    """True if any pixel within ``width`` cells of the grid border burned."""
    b = np.asarray(arrival_h) < NEVER * 0.999
    return bool(b[:width].any() or b[-width:].any() or b[:, :width].any() or b[:, -width:].any())


def wui_mask(fuel_codes: np.ndarray, res_m: float, buffer_m: float = 2400.0) -> np.ndarray:
    """Developed (FBFM40 91) cells of the wildland-urban interface: in a settlement (>= 25 % developed within a 1 km
    square, so town streets count but isolated roads through wildland do not) and within ``buffer_m`` of the
    vegetation of a large wildland block (a ~5 km² square that is >= 75 % burnable; SILVIS interface definition)."""
    from scipy import ndimage

    codes = np.asarray(fuel_codes)
    developed = codes == DEVELOPED_CODE
    if not developed.any() or buffer_m <= 0:
        return np.zeros(codes.shape, dtype=bool)
    burnable = is_burnable_code(codes)
    k = max(3, 2 * int(round(WUI_CORE_RADIUS_M / float(res_m))) + 1)
    frac = ndimage.uniform_filter(burnable.astype(np.float32), size=k, mode="nearest")
    core = frac >= WUI_CORE_FRACTION                 # centres of qualifying ~5 km² blocks
    if not core.any():
        return np.zeros(codes.shape, dtype=bool)
    block = burnable & ndimage.maximum_filter(core, size=k, mode="constant")   # the vegetation of those blocks
    ks = max(3, 2 * int(round(WUI_SETTLEMENT_RADIUS_M / float(res_m))) + 1)
    settlement = developed & (ndimage.uniform_filter(developed.astype(np.float32), size=ks, mode="nearest") >= WUI_SETTLEMENT_FRACTION)
    dist = ndimage.distance_transform_edt(~block) * float(res_m)
    return settlement & (dist <= float(buffer_m))


# ----------------------------------------------------------------------------------------------------------------
# Static inputs
# ----------------------------------------------------------------------------------------------------------------
def load_static_inputs(bundle_dir: Path) -> StaticInputs:
    """Load ``sim/static.npz`` (fire grid) into :class:`StaticInputs`.

    ``res_m`` comes from the npz (optional scalar key) or else the manifest's ``grid.fire.res_m``.
    """
    bdir = Path(bundle_dir)
    path = bdir / fbundle.STATIC_NPZ
    if not path.is_file():
        raise FileNotFoundError(f"{path} is missing (build the incident's static layers first)")
    z = fbundle.read_npz(path)
    missing = [k for k in STATIC_NPZ_KEYS if k not in z]
    if missing:
        raise ValueError(f"{path} lacks keys {missing}")
    res = float(z["res_m"]) if "res_m" in z else None
    if res is None:
        m = fbundle.load_manifest(bdir) or {}
        try:
            res = float(m["grid"]["fire"]["res_m"])
        except (KeyError, TypeError) as e:
            raise ValueError(f"{path} has no res_m and the manifest has no grid.fire.res_m") from e
    shape = z["fuel_model"].shape
    for k in STATIC_NPZ_KEYS:
        if z[k].shape != shape or len(shape) != 2:
            raise ValueError(f"{path}: {k} has shape {z[k].shape}, expected {shape} (2-D)")
    f32 = {k: np.asarray(z[k], dtype=np.float32) for k in STATIC_NPZ_KEYS if k != "fuel_model"}
    return StaticInputs(
        fuel_model=np.nan_to_num(np.asarray(z["fuel_model"], dtype=np.float64), nan=0.0).astype(np.int16),
        res_m=float(res),
        **f32,
    )


def prepare_static(static: StaticInputs, settings: SpreadSettings | None = None) -> StaticInputs:
    """A cleaned copy of ``static``: unknown fuel codes -> 99, NaNs -> 0, ranges clamped, canopy base height set to
    :data:`NO_CROWN_CBH_M` where crowning is impossible (no canopy fuel) or disabled (``settings.crown`` False)."""
    settings = settings or SpreadSettings()

    def clean(a, lo, hi):
        return np.clip(np.nan_to_num(np.asarray(a, dtype=np.float32), nan=0.0, posinf=hi, neginf=lo), lo, hi).astype(np.float32)

    ch = clean(static.canopy_height, 0.0, 100.0)
    cbd = clean(static.canopy_bulk_density, 0.0, 2.0)
    cbh = clean(static.canopy_base_height, 0.0, 100.0)
    if settings.crown:
        cbh = np.where((ch <= 0.0) | (cbd <= 0.0), np.float32(NO_CROWN_CBH_M), cbh).astype(np.float32)
    else:
        cbh = np.full_like(cbh, NO_CROWN_CBH_M)
    aspect = np.mod(np.nan_to_num(np.asarray(static.aspect, dtype=np.float32), nan=0.0), 360.0).astype(np.float32)
    fuel = sanitize_fuel_codes(static.fuel_model)
    adjustment = None
    if settings.wui:
        wui = wui_mask(fuel, float(static.res_m), float(settings.wui_buffer_m))
        if wui.any():
            fuel = np.where(wui, np.int16(sanitize_fuel_codes(np.array([settings.wui_fuel_model]))[0]), fuel).astype(np.int16)
            adjustment = np.where(wui, np.float32(max(float(settings.wui_spread_adjustment), 0.0)), np.float32(1.0)).astype(np.float32)
    return StaticInputs(
        fuel_model=fuel,
        slope=clean(static.slope, 0.0, MAX_SLOPE),
        aspect=aspect,
        canopy_cover=clean(static.canopy_cover, 0.0, 1.0),
        canopy_height=ch,
        canopy_base_height=cbh,
        canopy_bulk_density=cbd,
        elevation=np.nan_to_num(np.asarray(static.elevation, dtype=np.float32), nan=0.0),
        res_m=float(static.res_m),
        fuel_adjustment=adjustment,
    )


def wui_summary(static: StaticInputs, settings: SpreadSettings) -> str | None:
    """One-line description of the WUI treatment for forecast warnings (None when it is off or finds no cells)."""
    if not settings.wui:
        return None
    raw = sanitize_fuel_codes(static.fuel_model)
    wui = wui_mask(raw, float(static.res_m), float(settings.wui_buffer_m))
    if not wui.any():
        return None
    ac = float(wui.sum()) * float(static.res_m) ** 2 / config.ACRE_M2
    dev = float(np.count_nonzero(raw == DEVELOPED_CODE)) * float(static.res_m) ** 2 / config.ACRE_M2
    return (f"WUI: {ac:,.0f} of {dev:,.0f} ac of developed land (LANDFIRE NB1) within {settings.wui_buffer_m / 1000:g} km "
            f"of wildland burns as FBFM {settings.wui_fuel_model} at {settings.wui_spread_adjustment:g} x its spread rate "
            "(structure/ember spread surrogate, see docs/validation.md)")


# ----------------------------------------------------------------------------------------------------------------
# Resolution changes (x2 downsample fallback, SPEC 8.5)
# ----------------------------------------------------------------------------------------------------------------
def _blocks(a: np.ndarray, f: int) -> np.ndarray:
    h, w = a.shape
    if h % f or w % f:
        raise ValueError(f"grid {a.shape} is not divisible by {f}")
    return a.reshape(h // f, f, w // f, f).swapaxes(1, 2).reshape(h // f, w // f, f * f)


def _block_mode(codes: np.ndarray, f: int) -> np.ndarray:
    """Most frequent value per f x f block (ties -> the earliest value in row-major block order)."""
    b = _blocks(codes, f)
    counts = (b[..., :, None] == b[..., None, :]).sum(axis=-1)
    idx = np.argmax(counts, axis=-1)
    return np.take_along_axis(b, idx[..., None], axis=-1)[..., 0]


def downsample_static(static: StaticInputs, factor: int = 2) -> StaticInputs:
    """Coarsen static inputs by ``factor``: fuel = block majority, canopy = block mean, elevation = block mean with
    slope/aspect recomputed from it (better than averaging angles)."""
    f = int(factor)
    if f == 1:
        return static

    def mean(a):
        return _blocks(np.asarray(a, dtype=np.float64), f).mean(axis=-1).astype(np.float32)

    elev = mean(static.elevation)
    res = float(static.res_m) * f
    slope, aspect = slope_aspect(elev, res)
    return StaticInputs(
        fuel_model=_block_mode(np.asarray(static.fuel_model, dtype=np.int16), f).astype(np.int16),
        slope=slope,
        aspect=aspect,
        canopy_cover=mean(static.canopy_cover),
        canopy_height=mean(static.canopy_height),
        canopy_base_height=mean(static.canopy_base_height),
        canopy_bulk_density=mean(static.canopy_bulk_density),
        elevation=elev,
        res_m=res,
    )


def downsample_mask(mask: np.ndarray, factor: int = 2) -> np.ndarray:
    """Coarse cell is set when any of its fine cells is (keeps single-pixel ignitions alive)."""
    if factor == 1:
        return np.asarray(mask, dtype=bool)
    return _blocks(np.asarray(mask, dtype=bool), factor).any(axis=-1)


def upsample_nearest(a: np.ndarray, factor: int = 2) -> np.ndarray:
    """Nearest-neighbour (block repeat) upsampling of a 2-D array."""
    if factor == 1:
        return a
    return np.repeat(np.repeat(a, factor, axis=0), factor, axis=1)


# ----------------------------------------------------------------------------------------------------------------
# Weather cubes
# ----------------------------------------------------------------------------------------------------------------
def weather_grid_size(m: int, max_w: int = MAX_WEATHER_GRID) -> int:
    """Largest W <= max_w dividing M (the refined weather base is W x W)."""
    for w in range(min(max_w, m), 0, -1):
        if m % w == 0:
            return w
    return 1


def _bilinear_matrix(n_out: int, n_in: int) -> np.ndarray:
    """(n_out, n_in) weights mapping n_in cell-centred samples onto n_out cell centres over the same extent
    (edge-clamped)."""
    pos = (np.arange(n_out) + 0.5) / n_out * n_in - 0.5
    pos = np.clip(pos, 0.0, n_in - 1)
    i0 = np.floor(pos).astype(int)
    i1 = np.minimum(i0 + 1, n_in - 1)
    w1 = pos - i0
    W = np.zeros((n_out, n_in))
    W[np.arange(n_out), i0] += 1.0 - w1
    W[np.arange(n_out), i1] += w1
    return W


def refine_weather_field(a: np.ndarray, w: int) -> np.ndarray:
    """Bilinear refinement of a (T, ny, nx) cell-centred field to (T, w, w) (row order preserved)."""
    a = np.asarray(a, dtype=np.float64)
    if a.ndim != 3:
        raise ValueError(f"weather field must be (T, ny, nx), got {a.shape}")
    _, ny, nx = a.shape
    Wy, Wx = _bilinear_matrix(w, ny), _bilinear_matrix(w, nx)
    return np.einsum("yj,tji,xi->tyx", Wy, a, Wx)


def fill_nan_time(a: np.ndarray, fill: float) -> np.ndarray:
    """Fill NaNs of a (T, ...) array from the nearest valid time step of the same cell; all-NaN cells -> ``fill``."""
    a = np.array(a, dtype=np.float64, copy=True)
    bad = ~np.isfinite(a)
    if not bad.any():
        return a
    t = a.shape[0]
    flat = a.reshape(t, -1)
    badf = bad.reshape(t, -1)
    idx = np.arange(t)
    for j in np.nonzero(badf.any(axis=0))[0]:
        ok = ~badf[:, j]
        if not ok.any():
            flat[:, j] = fill
            continue
        good = idx[ok]
        pos = np.clip(np.searchsorted(good, idx), 0, good.size - 1)
        prev = np.clip(pos - 1, 0, good.size - 1)
        nearest = np.where(np.abs(good[prev] - idx) <= np.abs(good[pos] - idx), good[prev], good[pos])
        flat[:, j] = flat[nearest, j]
    return flat.reshape(a.shape)


def wind_to_uv(speed, from_deg):
    """Meteorological (speed, FROM direction) -> (u east+, v north+)."""
    rad = np.radians(np.asarray(from_deg, dtype=np.float64))
    s = np.asarray(speed, dtype=np.float64)
    return -s * np.sin(rad), -s * np.cos(rad)


def uv_to_wind(u, v):
    """(u, v) -> (speed, FROM direction deg cw from N in [0, 360))."""
    u = np.asarray(u, dtype=np.float64)
    v = np.asarray(v, dtype=np.float64)
    return np.hypot(u, v), np.mod(np.degrees(np.arctan2(-u, -v)), 360.0)


@dataclass
class WeatherCubeBases:
    """Weather arrays in pyretechnics row order (y north+), plus the cube's time origin."""

    origin_ms: int                     # epoch ms of the cube's t = 0 (first band start)
    bands: int
    wind_speed_10m: np.ndarray         # (T, W, W) km/h
    upwind_direction: np.ndarray       # (T, W, W) deg
    fm1: np.ndarray
    fm10: np.ndarray
    fm100: np.ndarray
    temperature: np.ndarray
    padded_hours: int = 0              # hours appended by persistence to reach the horizon
    prepended_hours: int = 0           # hours prepended by persistence to reach the start


def weather_bases(weather: MemberWeather, m: int, end_ms: int | None = None, start_ms: int | None = None) -> WeatherCubeBases:
    """Turn a :class:`MemberWeather` into refined, north-up-flipped cube bases for an M x M grid. NaN hours are
    filled from the nearest valid hour; if ``start_ms`` precedes the first band or ``end_ms`` lies beyond the last
    one, the first/last hour is repeated (persistence)."""
    t = np.asarray(weather.t_ms, dtype=np.int64)
    if t.ndim != 1 or t.size == 0:
        raise ValueError("MemberWeather.t_ms must be a non-empty 1-D array")
    if t.size > 1 and np.any(np.diff(t) != config.MS_PER_H):
        raise ValueError("MemberWeather.t_ms must be strictly hourly")
    fields = {
        "speed": (weather.wind_speed_10m_kmh, 0.0),
        "dir": (weather.upwind_dir_deg, 0.0),
        "fm1": (weather.fm1, 0.08),
        "fm10": (weather.fm10, 0.10),
        "fm100": (weather.fm100, 0.12),
        "temp": (weather.temp_c, 20.0),
    }
    arrs = {}
    for k, (v, fill) in fields.items():
        a = np.asarray(v, dtype=np.float64)
        if a.ndim == 1:
            a = a[:, None, None]
        if a.ndim != 3 or a.shape[0] != t.size:
            raise ValueError(f"MemberWeather field {k} has shape {a.shape}, expected (T={t.size}, ny, nx)")
        arrs[k] = fill_nan_time(a, fill)
    # Interpolate direction through u/v so a NaN-filled or refined direction never averages 350 and 10 to 180.
    u, v = wind_to_uv(np.maximum(arrs["speed"], 0.0), arrs["dir"])
    arrs["u"], arrs["v"] = u, v
    del arrs["speed"], arrs["dir"]
    origin = int(t[0] - config.MS_PER_H // 2)
    prepended = 0
    if start_ms is not None and start_ms < origin:
        prepended = int(math.ceil((origin - int(start_ms)) / config.MS_PER_H))
        for k in arrs:
            arrs[k] = np.concatenate([np.repeat(arrs[k][:1], prepended, axis=0), arrs[k]], axis=0)
        origin -= prepended * config.MS_PER_H
    padded = 0
    bands = int(arrs["u"].shape[0])
    if end_ms is not None:
        need = int(math.ceil((int(end_ms) - origin) / config.MS_PER_H))
        if need > bands:
            padded = need - bands
            for k in arrs:
                arrs[k] = np.concatenate([arrs[k], np.repeat(arrs[k][-1:], padded, axis=0)], axis=0)
            bands = need
    w = weather_grid_size(m)
    spd, wdir = uv_to_wind(refine_weather_field(arrs["u"], w), refine_weather_field(arrs["v"], w))

    def ref(a, lo, hi):
        return np.clip(refine_weather_field(a, w), lo, hi)

    def flip(a):
        return np.ascontiguousarray(a[:, ::-1, :], dtype=np.float32)

    return WeatherCubeBases(
        origin_ms=origin,
        bands=bands,
        wind_speed_10m=flip(spd),
        upwind_direction=flip(wdir),
        fm1=flip(ref(arrs["fm1"], 0.01, 0.6)),
        fm10=flip(ref(arrs["fm10"], 0.01, 0.6)),
        fm100=flip(ref(arrs["fm100"], 0.01, 0.6)),
        temperature=flip(ref(arrs["temp"], -40.0, 55.0)),
        padded_hours=padded,
        prepended_hours=prepended,
    )


def _flip_static(a: np.ndarray) -> np.ndarray:
    return np.ascontiguousarray(np.asarray(a)[::-1, :], dtype=np.float32)[np.newaxis]


def adjustment_series(settings: SpreadSettings, origin_ms: int, bands: int, start_ms: int | None) -> np.ndarray | float:
    """Per-band weather spread adjustment: ``spread_adjustment`` x (floor + (1 - floor) exp(-lead / tau)), lead = hours
    from ``settings.adjustment_origin_ms`` (default ``start_ms``) to the band centre (>= 0); a float when constant."""
    adj = float(max(settings.spread_adjustment, 0.0))
    tau = float(settings.adjustment_decay_h or 0.0)
    anchor = settings.adjustment_origin_ms if getattr(settings, "adjustment_origin_ms", None) is not None else start_ms
    if tau <= 0.0 or anchor is None:
        return adj
    floor = float(min(max(settings.adjustment_floor, 0.0), 1.0))
    centre_h = (origin_ms + (np.arange(bands) + 0.5) * config.MS_PER_H - int(anchor)) / config.MS_PER_H
    lead = np.maximum(centre_h, 0.0)
    return (adj * (floor + (1.0 - floor) * np.exp(-lead / tau))).astype(np.float32)


def build_space_time_cubes(static: StaticInputs, wb: WeatherCubeBases, weather: MemberWeather,
                           settings: SpreadSettings, start_ms: int | None = None) -> tuple[dict, tuple[int, int, int]]:
    """The pyretechnics ``space_time_cubes`` dict (all inputs y-north-up flipped) and its cube shape.
    ``static`` must already be :func:`prepare_static`-ed; ``start_ms`` anchors a decaying spread adjustment."""
    from pyretechnics.space_time_cube import SpaceTimeCube

    m_rows, m_cols = static.fuel_model.shape
    shape = (int(wb.bands), int(m_rows), int(m_cols))
    cubes = {
        "slope": SpaceTimeCube(shape, _flip_static(static.slope)),
        "aspect": SpaceTimeCube(shape, _flip_static(static.aspect)),
        "fuel_model": SpaceTimeCube(shape, _flip_static(static.fuel_model)),
        "canopy_cover": SpaceTimeCube(shape, _flip_static(static.canopy_cover)),
        "canopy_height": SpaceTimeCube(shape, _flip_static(static.canopy_height)),
        "canopy_base_height": SpaceTimeCube(shape, _flip_static(static.canopy_base_height)),
        "canopy_bulk_density": SpaceTimeCube(shape, _flip_static(static.canopy_bulk_density)),
        "wind_speed_10m": SpaceTimeCube(shape, wb.wind_speed_10m),
        "upwind_direction": SpaceTimeCube(shape, wb.upwind_direction),
        "fuel_moisture_dead_1hr": SpaceTimeCube(shape, wb.fm1),
        "fuel_moisture_dead_10hr": SpaceTimeCube(shape, wb.fm10),
        "fuel_moisture_dead_100hr": SpaceTimeCube(shape, wb.fm100),
        "fuel_moisture_live_herbaceous": SpaceTimeCube(shape, float(np.clip(weather.fm_live_herb, 0.3, 3.0))),
        "fuel_moisture_live_woody": SpaceTimeCube(shape, float(np.clip(weather.fm_live_woody, 0.3, 3.0))),
        "foliar_moisture": SpaceTimeCube(shape, float(np.clip(weather.foliar_moisture, 0.5, 3.0))),
    }
    adj = adjustment_series(settings, wb.origin_ms, int(wb.bands), start_ms)
    if isinstance(adj, np.ndarray):
        cubes["weather_spread_adjustment"] = SpaceTimeCube(shape, np.ascontiguousarray(adj.reshape(-1, 1, 1), dtype=np.float32))
    elif adj != 1.0:
        cubes["weather_spread_adjustment"] = SpaceTimeCube(shape, float(adj))
    if static.fuel_adjustment is not None:
        cubes["fuel_spread_adjustment"] = SpaceTimeCube(shape, _flip_static(static.fuel_adjustment))
    if settings.spotting:
        cubes["temperature"] = SpaceTimeCube(shape, wb.temperature)
    return cubes, shape


# ----------------------------------------------------------------------------------------------------------------
# One member
# ----------------------------------------------------------------------------------------------------------------
@dataclass
class SimOutput:
    """Full output of one simulation (``result`` is the contract MemberResult)."""

    result: MemberResult
    spread_rate_m_min: np.ndarray        # float32 (M, M) fire-normal spread rate when each cell burned, 0 unburned
    fireline_intensity_kw_m: np.ndarray  # float32 (M, M)
    start_h: float                       # simulation start, hours since time_origin_ms
    end_h: float                         # simulation end
    stop_condition: str
    warnings: list[str] = field(default_factory=list)
    sim_res_m: float = 0.0               # resolution the simulation ran at
    factor: int = 1                      # downsample factor used (1 = native fire grid)


def simulate(
    static: StaticInputs,
    weather: MemberWeather,
    ignition_mask: np.ndarray,
    start_ms: int,
    horizon_h: float,
    time_origin_ms: int,
    settings: SpreadSettings | None = None,
    *,
    prepared: bool = False,
    seed: int | None = None,
    chunk_h: float | None = None,
    check: Callable[[float, float], bool] | None = None,
) -> SimOutput:
    """Run pyretechnics for one member (see :func:`run_member`) and also return spread-rate/intensity rasters.

    * ``prepared=True`` skips :func:`prepare_static` (callers that run many members prepare once).
    * ``chunk_h``: run in chunks of this many simulated hours, resuming the same SpreadState; between chunks
      ``check(elapsed_wall_s, simulated_h)`` is called and :class:`SimulationAborted` is raised if it returns False.
    """
    from pyretechnics.eulerian_level_set import SpreadState, spread_fire_with_phi_field

    settings = settings or SpreadSettings()
    wall0 = time.perf_counter()
    st = static if prepared else prepare_static(static, settings)
    mask = np.asarray(ignition_mask, dtype=bool)
    if mask.shape != st.fuel_model.shape:
        raise ValueError(f"ignition mask {mask.shape} does not match the fire grid {st.fuel_model.shape}")
    if not mask.any():
        raise ValueError("ignition mask is empty")
    if not horizon_h > 0:
        raise ValueError("horizon_h must be positive")
    m = int(st.fuel_model.shape[0])
    start_ms = int(start_ms)
    end_ms = int(round(start_ms + float(horizon_h) * config.MS_PER_H))
    wb = weather_bases(weather, m, end_ms=end_ms, start_ms=start_ms)
    warnings: list[str] = []
    if wb.prepended_hours:
        warnings.append(f"weather member {weather.label!r} starts {wb.prepended_hours} h after the simulation start; first hour held (persistence)")
    if wb.padded_hours:
        warnings.append(f"weather member {weather.label!r} ends {wb.padded_hours} h before the horizon; last hour held (persistence)")
    start_min = (start_ms - wb.origin_ms) / 60000.0
    stop_min = start_min + float(horizon_h) * 60.0
    cubes, shape = build_space_time_cubes(st, wb, weather, settings, start_ms)

    ss = SpreadState(shape)
    ign = np.where(mask[::-1, :], np.float32(-1.0), np.float32(1.0)).astype(np.float32)
    ss.ignite_cells((0, 0), np.ascontiguousarray(ign))
    spot_config = dict(SPOT_CONFIG_DEFAULTS, random_seed=int(seed if seed is not None else 0)) if settings.spotting else None
    spot_ignitions: dict = {}
    first = True
    t_min = start_min
    stop_condition = ""
    while True:
        remaining = stop_min - t_min
        duration = remaining if chunk_h is None else min(float(chunk_h) * 60.0, remaining)
        kwargs: dict = {
            "max_cells_per_timestep": float(settings.max_cells_per_timestep),
            "surface_lw_ratio_model": str(settings.surface_lw_ratio_model),
        }
        if spot_config is not None:
            kwargs["spot_config"] = spot_config
            kwargs["spot_ignitions"] = spot_ignitions
        # Later chunks resume the stored state; passing None avoids comparing float32-stored values with doubles.
        out = spread_fire_with_phi_field(
            cubes,
            ss,
            cube_resolution=(BAND_MINUTES, float(st.res_m), float(st.res_m)) if first else None,
            start_time=float(start_min) if first else None,
            max_duration=float(duration),
            **kwargs,
        )
        first = False
        ss = out["spread_state"]
        t_min = float(out["stop_time"])
        stop_condition = str(out.get("stop_condition", ""))
        if spot_config is not None:
            spot_ignitions = dict(out.get("spot_ignitions") or {})
        if stop_min - t_min <= EARLY_EXIT_MIN or stop_condition != "max duration reached":
            break
        if check is not None and not check(time.perf_counter() - wall0, (t_min - start_min) / 60.0):
            raise SimulationAborted(f"member {weather.label!r} stopped after {(t_min - start_min) / 60.0:.1f} simulated h")

    mats = ss.get_full_matrices(["time_of_arrival", "flame_length", "fire_type", "spread_rate", "fireline_intensity"])
    toa = np.asarray(mats["time_of_arrival"], dtype=np.float64)[::-1, :]
    burned = np.isfinite(toa)
    offset_h = (wb.origin_ms - int(time_origin_ms)) / config.MS_PER_H
    start_h = (start_ms - int(time_origin_ms)) / config.MS_PER_H
    end_h = start_h + float(horizon_h)
    arrival = np.full(toa.shape, NEVER, dtype=np.float64)
    arrival[burned] = np.clip(offset_h + toa[burned] / 60.0, start_h, end_h)
    arrival[mask] = start_h

    def grab(name, dtype):
        a = np.asarray(mats[name])[::-1, :]
        a = np.where(burned, np.nan_to_num(a, nan=0.0), 0).astype(dtype)
        return np.ascontiguousarray(a)

    flame = grab("flame_length", np.float32)
    fire_type = grab("fire_type", np.uint8)
    fire_type[mask & (fire_type == 0)] = 1
    ros = grab("spread_rate", np.float32)
    fli = grab("fireline_intensity", np.float32)
    runtime = time.perf_counter() - wall0
    result = MemberResult(
        label=str(weather.label),
        arrival_h=arrival.astype(np.float32),
        flame_length_m=flame,
        fire_type=fire_type,
        runtime_s=float(runtime),
    )
    return SimOutput(result, ros, fli, start_h, end_h, stop_condition, warnings, sim_res_m=float(st.res_m), factor=1)


def run_member(
    static: StaticInputs,
    weather: MemberWeather,
    ignition_mask: np.ndarray,
    start_ms: int,
    horizon_h: float,
    time_origin_ms: int,
    settings: SpreadSettings,
) -> MemberResult:
    """Spread from ``ignition_mask`` (bool (M, M)) at ``start_ms`` for ``horizon_h`` hours with one weather
    member; arrival in hours since ``time_origin_ms`` (NEVER = 1e6 where unburned)."""
    return simulate(static, weather, ignition_mask, start_ms, horizon_h, time_origin_ms, settings).result


def simulate_downsampled(
    static: StaticInputs,
    weather: MemberWeather,
    ignition_mask: np.ndarray,
    start_ms: int,
    horizon_h: float,
    time_origin_ms: int,
    settings: SpreadSettings | None = None,
    *,
    factor: int = 2,
    coarse_static: StaticInputs | None = None,
    seed: int | None = None,
) -> SimOutput:
    """:func:`simulate` on a grid coarsened by ``factor`` (SPEC 8.5 fallback), results brought back to the fine
    grid with :func:`upsample_output`. ``coarse_static`` may pass an already prepared coarse grid."""
    settings = settings or SpreadSettings()
    cs = coarse_static if coarse_static is not None else prepare_static(downsample_static(static, factor), settings)
    out = simulate(cs, weather, downsample_mask(ignition_mask, factor), start_ms, horizon_h, time_origin_ms, settings,
                   prepared=True, seed=seed)
    return upsample_output(out, factor, static, ignition_mask)


def upsample_output(out: SimOutput, factor: int, fine_static: StaticInputs, fine_ignition: np.ndarray) -> SimOutput:
    """Bring a coarse :class:`SimOutput` back to the fine grid: nearest-neighbour upsampling (SPEC: nearest for
    arrival), fine non-burnable pixels outside the ignition set to NEVER, fine ignition pixels = start."""
    if factor == 1:
        return out
    fine_ign = np.asarray(fine_ignition, dtype=bool)
    nb = ~is_burnable_code(fine_static.fuel_model) & ~fine_ign
    arr = upsample_nearest(out.result.arrival_h, factor).astype(np.float32)
    arr[nb] = NEVER
    arr[fine_ign] = np.float32(out.start_h)
    unb = arr >= NEVER * 0.999

    def up(a, dtype):
        b = upsample_nearest(a, factor).astype(dtype)
        b[unb] = 0
        return b

    ft = up(out.result.fire_type, np.uint8)
    ft[fine_ign & (ft == 0)] = 1
    res = replace(
        out.result,
        arrival_h=arr,
        flame_length_m=up(out.result.flame_length_m, np.float32),
        fire_type=ft,
    )
    return replace(out, result=res, spread_rate_m_min=up(out.spread_rate_m_min, np.float32),
                   fireline_intensity_kw_m=up(out.fireline_intensity_kw_m, np.float32), factor=int(factor) * out.factor)
