"""Shared dataclasses passed between backend modules (SPEC 7.1, Contract)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal

import numpy as np

from .contracts import IncidentSummary
from .grid import Grid

ProgressFn = Callable[[str, float, str], None]   # (step, fraction 0..1 within the step, message)


def no_progress(step: str, fraction: float, message: str) -> None:
    """A ProgressFn that ignores updates."""


@dataclass
class BuildContext:
    summary: IncidentSummary            # pydantic model from contracts.py
    bundle_dir: Path
    render_grid: Grid
    fire_grid: Grid
    time_origin_ms: int
    mode: Literal["live", "historical"]
    progress: ProgressFn                # (step, fraction 0..1 within step, message)
    fire_bbox_lonlat: tuple[float, float, float, float] | None = None
    end_ms: int | None = None           # time_range.end_ms once known
    now_ms: int | None = None


@dataclass
class StaticInputs:                     # fire grid; loaded from sim/static.npz
    fuel_model: np.ndarray              # int16 FBFM40 codes
    slope: np.ndarray                   # float32 rise/run
    aspect: np.ndarray                  # float32 deg clockwise from N, the direction the slope FACES (downslope)
    canopy_cover: np.ndarray            # float32 0-1
    canopy_height: np.ndarray           # float32 m
    canopy_base_height: np.ndarray      # float32 m
    canopy_bulk_density: np.ndarray     # float32 kg/m³
    elevation: np.ndarray               # float32 m
    res_m: float
    fuel_adjustment: np.ndarray | None = None   # float32 per-cell spread-rate multiplier (WUI cells), set by
                                                # spread.engine.prepare_static; None = 1 everywhere


@dataclass
class MemberWeather:                    # one ensemble member; hourly on the 4x4 weather grid
    t_ms: np.ndarray                    # (T,) int64 hourly
    wind_speed_10m_kmh: np.ndarray      # (T, 4, 4)
    upwind_dir_deg: np.ndarray          # (T, 4, 4) FROM direction, deg clockwise from N
    temp_c: np.ndarray                  # (T, 4, 4)
    rh_pct: np.ndarray                  # (T, 4, 4)
    fm1: np.ndarray                     # (T, 4, 4) kg/kg (fractions)
    fm10: np.ndarray                    # (T, 4, 4) kg/kg
    fm100: np.ndarray                   # (T, 4, 4) kg/kg
    fm_live_herb: float                 # kg/kg
    fm_live_woody: float                # kg/kg
    foliar_moisture: float              # kg/kg
    label: str                          # "control", "member07", "perturbed-03" ...


@dataclass
class SpreadSettings:
    spread_adjustment: float = 1.0
    surface_lw_ratio_model: str = "behave"
    crown: bool = True
    spotting: bool = False
    max_cells_per_timestep: float = 0.4
    # Developed land in the wildland-urban interface (spread/engine.py, docs/validation.md): LANDFIRE codes
    # settlements as non-burnable 91; with ``wui`` they burn as ``wui_fuel_model`` at ``wui_spread_adjustment`` x
    # its rate. ``wui_buffer_m`` is the interface distance from large wildland-vegetation blocks.
    wui: bool = False
    wui_fuel_model: int = 165
    wui_spread_adjustment: float = 1.0
    wui_buffer_m: float = 2400.0
    # Observation-informed start (spread/ensemble.py): perimeter segments with no burning in the ``active_window_h``
    # before the start and no satellite detection within ``active_radius_m`` are held (contained or burned out).
    hold_inactive: bool = False
    active_window_h: float = 12.0
    active_radius_m: float = 1000.0
    # Activity filters (docs/validation.md 6.6): ``active_growth_only`` counts a detection only where it coincides with
    # growth (its cell burned in the window, or lies outside the burned area), not on ground that burned before the
    # window (operational: on, config.FORECAST_ACTIVE_GROWTH_ONLY); ``active_edge_m`` > 0 ignores activity deeper than
    # this inside the burned area (tested, off).
    active_edge_m: float = 0.0
    active_growth_only: bool = False
    # Spread-rate multiplier relaxing with forecast lead time: spread_adjustment x (floor + (1 - floor) e^(-lead/tau))
    # with lead = hours since the simulation start; tau 0 keeps it constant (spread/engine.py, docs/validation.md).
    adjustment_decay_h: float = 0.0
    adjustment_floor: float = 1.0
    # When set, the lead of the decay counts from this time instead of the simulation start (live forecasts that
    # start at a satellite pass after the last detection: the decay clock starts at the last activity).
    adjustment_origin_ms: int | None = None


@dataclass
class MemberResult:
    label: str
    arrival_h: np.ndarray               # float32 (M, M) hours since time_origin, NEVER = 1e6
    flame_length_m: np.ndarray          # float32 (M, M), 0 where unburned
    fire_type: np.ndarray               # uint8 (M, M) 0 unburned, 1 surface, 2 passive crown, 3 active crown
    runtime_s: float


STATIC_NPZ_KEYS = (
    "fuel_model", "slope", "aspect", "canopy_cover", "canopy_height", "canopy_base_height", "canopy_bulk_density", "elevation",
)
