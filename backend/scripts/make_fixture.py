#!/usr/bin/env python
"""Write synthetic, contract-complete incident bundles into ``DATA_DIR/incidents`` (the default run writes the first two):

* ``fixture-demo``  historical (2025), 12 km AOI near Altadena (EPSG:32611): ~5 days to ~12,000 ac, a wind event,
  a spot fire across the creek, containment; hindcast ``fx-001`` launched 24 h after ignition (perturbed x31).
* ``fixture-live``  live, 16 km AOI in the Santa Lucia Range (EPSG:32610): "now" is ~2/3 through the observed
  period, nothing is observed after now, and forecast ``fx-001`` (gfs025 x31) starts at now. Dates are relative to
  the moment this script runs.
* ``fixture-east``  (``--only east``, brief 3) historical (2025), 12 km AOI near Black Cove, NC (EPSG:32617,
  America/New_York): a synthetic NIFC WFIGS-style fire (``state`` "NC", ``record_source`` "wfigs", ``record_issuer``
  "NIFC WFIGS (IRWIN)", ``irwin_id`` null, ``calfire_uid`` ""), for browser checks of Eastern time and UTM 17 without a
  build. It is bundle-only: never buildable, and it has no agency record (CONTRACT 14.12.9).

Everything is procedural (numpy/scipy/Pillow, fixed seeds): ridged-fBm terrain with a carved river valley, FBFM40
fuels by elevation/aspect/slope, canopy, a NAIP-like aerial photo, sky-view AO, water, ~60k trees, an anisotropic
(wind + slope + fuel) arrival-time field from a 16-neighbour Dijkstra, satellite detections sampled from it, perimeters,
hourly series, events, diurnal weather with a wind event, and an ensemble forecast. Every JSON file is validated
strictly against ``fire3d.contracts``. The spread here is NOT pyretechnics output: it only has to look plausible.

Usage: ``uv run python scripts/make_fixture.py [--data-dir DIR] [--only demo|live|east] [--members 31] [--quicklook DIR]``
"""

from __future__ import annotations

import argparse
import io
import math
import shutil
import sys
import time
import warnings
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
from PIL import Image
from scipy import ndimage, special
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree
from shapely.geometry import LineString
from skimage import measure
from skimage.transform import resize

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fire3d import bundle, config  # noqa: E402
from fire3d.contracts import (  # noqa: E402
    DetectionsFile,
    EventsFile,
    ForecastManifest,
    IncidentManifest,
    PerimetersFile,
    TimeseriesFile,
    WeatherFile,
    validate_strict,
)
from fire3d.grid import Grid, fire_grid_size, manifest_grid, slope_aspect, transformer, utm_epsg_for, weather_axes  # noqa: E402
from fire3d.timeutil import DAY_MS, HOUR_MS, floor_hour_ms, now_ms, time_origin_for  # noqa: E402

LA = ZoneInfo("America/Los_Angeles")      # the zone of the scenario being built (set by build_fixture; demo/live: Pacific)
NEVER = config.NEVER
ACRE = config.ACRE_M2
CHAIN = config.CHAIN_M
NB_CODES = (91, 92, 93, 98, 99)
PYRETECHNICS_VERSION = "2026.8.10"

# land-cover classes used for fuels + imagery
SH5, SH7, GS2, GR2, TU5, TL8, RIP, BAR, URB, WAT = range(10)
CLASS_FBFM = np.array([145, 147, 122, 102, 165, 188, 122, 99, 91, 98], np.uint8)
CLASS_SPEED = np.array([1.5, 1.8, 2.2, 2.9, 0.55, 0.30, 0.8, 0.0, 0.0, 0.035], np.float32)  # relative; water = slow "spotting" crossing
CLASS_FLAME_M = np.array([3.6, 5.2, 2.0, 1.3, 2.8, 0.9, 1.6, 0.0, 0.0, 0.0], np.float32)


# =================================================================================================================
# Noise
# =================================================================================================================
class Perlin:
    """Vectorized 2-D gradient noise (~[-1, 1])."""

    def __init__(self, seed: int):
        rng = np.random.default_rng(seed)
        p = rng.permutation(256)
        self.perm = np.concatenate([p, p]).astype(np.int64)
        ang = rng.uniform(0.0, 2 * np.pi, 256)
        self.gx, self.gy = np.cos(ang), np.sin(ang)

    def __call__(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        x0, y0 = np.floor(x), np.floor(y)
        xf, yf = x - x0, y - y0
        xi, yi = x0.astype(np.int64) & 255, y0.astype(np.int64) & 255
        p = self.perm
        a, b = p[xi], p[xi + 1]
        h00, h01, h10, h11 = p[a + yi], p[a + yi + 1], p[b + yi], p[b + yi + 1]
        gx, gy = self.gx, self.gy
        n00 = gx[h00] * xf + gy[h00] * yf
        n10 = gx[h10] * (xf - 1) + gy[h10] * yf
        n01 = gx[h01] * xf + gy[h01] * (yf - 1)
        n11 = gx[h11] * (xf - 1) + gy[h11] * (yf - 1)
        u = xf * xf * xf * (xf * (xf * 6 - 15) + 10)
        v = yf * yf * yf * (yf * (yf * 6 - 15) + 10)
        nx0 = n00 + u * (n10 - n00)
        nx1 = n01 + u * (n11 - n01)
        return (nx0 + v * (nx1 - nx0)) * 1.4142


def fbm(noise: Perlin, x, y, octaves: int, lac: float = 2.0, gain: float = 0.5) -> np.ndarray:
    total, amp, freq, norm = 0.0, 1.0, 1.0, 0.0
    for i in range(octaves):
        total = total + amp * noise(x * freq + 17.31 * i, y * freq - 9.13 * i)
        norm += amp
        amp *= gain
        freq *= lac
    return total / norm


def ridged(noise: Perlin, x, y, octaves: int, lac: float = 2.0, gain: float = 2.0, h: float = 0.9) -> np.ndarray:
    """Musgrave ridged multifractal."""
    total, weight, freq = 0.0, 1.0, 1.0
    for i in range(octaves):
        n = noise(x * freq + 31.7 * i, y * freq + 12.9 * i)
        signal = (1.0 - np.abs(n)) ** 2 * weight
        weight = np.clip(signal * gain, 0.0, 1.0)
        total = total + signal * freq ** (-h)
        freq *= lac
    return total


def eroded_fbm(noise: Perlin, x, y, octaves: int, step: float, gain: float = 0.5) -> np.ndarray:
    """Gradient-damped fBm (I. Quilez "elevated" style): octaves are attenuated where the accumulated slope is
    high, which gives smooth valleys and crisp ridges. ``step`` = noise units per pixel at frequency 1."""
    total = np.zeros_like(x)
    dx = np.zeros_like(x)
    dy = np.zeros_like(x)
    amp, freq = 1.0, 1.0
    for i in range(octaves):
        n = noise(x * freq + 17.31 * i, y * freq - 9.13 * i)
        g_r, g_c = np.gradient(n, step * freq)
        dx += g_c / freq
        dy += g_r / freq
        total += amp * n / (1.0 + 0.9 * (dx * dx + dy * dy))
        amp *= gain
        freq *= 2.0
    return total


def value_fbm(rng: np.random.Generator, shape: tuple[int, int], cells: float, octaves: int = 3, gain: float = 0.55) -> np.ndarray:
    """Fast smooth noise: bicubic-upsampled white noise, summed over octaves; zero mean, unit std (float32)."""
    h, w = shape
    out = np.zeros(shape, np.float32)
    amp, c = 1.0, float(cells)
    for _ in range(octaves):
        gh = max(4, int(round(c * h / max(h, w))) + 3)
        gw = max(4, int(round(c * w / max(h, w))) + 3)
        g = rng.standard_normal((gh, gw)).astype(np.float32)
        z = ndimage.zoom(g, (h / gh, w / gw), order=3, mode="reflect", grid_mode=True)
        out += amp * z[:h, :w]
        amp *= gain
        c *= 2.0
    out -= out.mean()
    out /= out.std() + 1e-9
    return out


def smoothstep(e0: float, e1: float, x) -> np.ndarray:
    t = np.clip((np.asarray(x, dtype=np.float64) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def smin(a: np.ndarray, b: np.ndarray, k: float) -> np.ndarray:
    """Smooth minimum (log-sum-exp), k in the same units as a/b."""
    m = np.minimum(a, b)
    return m - k * np.log1p(np.exp(-np.abs(a - b) / k))


# =================================================================================================================
# Scenarios
# =================================================================================================================
@dataclass
class WindEvent:
    t_h: float          # hours after ignition
    spread_amp: float   # extra relative spread rate at the peak
    width_h: float
    wind_peak_ms: float


@dataclass
class Scenario:
    id: str
    name: str
    mode: str
    seed: int
    center_lon: float
    center_lat: float
    extent_m: float
    started_ms: int
    wind_from: float                       # dominant FROM direction while the fire runs (deg)
    ignition_uv: tuple[float, float]       # (u west->east, w north->south) in 0..1
    river_u0: float
    river_amp: float
    river_phase: float
    river_top_m: float
    town: tuple[float, float, float, float]   # u0, u1, w0, w1
    events: list[WindEvent]
    spot_h: float
    target_acres: float
    target_at_h: float | None              # None: final area; else area at that hour after ignition
    contain_h: tuple[float, float] | None   # growth decays to 0 between these hours (historical)
    t_mean: float
    t_amp: float
    rh_mean: float
    rh_amp: float
    county: str
    location: str
    admin_unit: str
    calfire_uid: str
    fuels_edition: str
    percent_contained: float
    now_ms: int | None = None              # live: wall-clock "now" used to cut observations
    forecast_events: list[WindEvent] = field(default_factory=list)
    tz: str = "America/Los_Angeles"        # the fire's own zone (local hours, labels); brief 3
    tz_abbr: str = "PT"                    # zone word in event text
    issuer: str = "CAL FIRE"               # who "reported" the synthetic fire (event and ignition text)
    summary_extra: dict = field(default_factory=dict)   # brief-3 summary fields written explicitly (east)


def demo_scenario() -> Scenario:
    started = int(datetime(2025, 8, 14, 21, 26, tzinfo=timezone.utc).timestamp() * 1000)   # 14:26 PDT
    return Scenario(
        id="fixture-demo", name="Ridgeview Fire", mode="historical", seed=7,
        center_lon=-118.07, center_lat=34.20, extent_m=12000.0, started_ms=started,
        wind_from=203.0, ignition_uv=(0.43, 0.76),
        river_u0=0.53, river_amp=0.085, river_phase=0.15, river_top_m=1080.0,
        town=(0.0, 0.40, 0.835, 1.0),
        events=[WindEvent(2.5, 0.9, 3.5, 10.0), WindEvent(26.0, 2.3, 6.5, 20.6), WindEvent(49.5, 0.8, 4.5, 12.0)],
        spot_h=27.0, target_acres=12000.0, target_at_h=None, contain_h=(74.0, 104.0),
        t_mean=27.0, t_amp=7.5, rh_mean=30.0, rh_amp=15.0,
        county="Los Angeles", location="San Gabriel Mountains foothills (synthetic fixture)",
        admin_unit="Synthetic fixture (Angeles NF)", calfire_uid="00000000-f1e3-4d00-8000-00000000d3a0",
        fuels_edition="LF2024", percent_contained=100.0,
    )


def live_scenario() -> Scenario:
    real_now = now_ms()
    started = (real_now - int(79.4 * HOUR_MS)) // 60000 * 60000
    return Scenario(
        id="fixture-live", name="Cedar Canyon Fire", mode="live", seed=23,
        center_lon=-121.45, center_lat=36.20, extent_m=16000.0, started_ms=started,
        wind_from=32.0, ignition_uv=(0.60, 0.27),
        river_u0=0.42, river_amp=0.10, river_phase=0.62, river_top_m=1000.0,
        town=(0.64, 1.0, 0.86, 1.0),
        events=[WindEvent(1.5, 0.3, 3.0, 8.0), WindEvent(30.0, 1.1, 5.0, 14.0), WindEvent(54.0, 1.9, 6.0, 18.0)],
        spot_h=55.0, target_acres=7000.0, target_at_h=(real_now - started) / HOUR_MS, contain_h=None,
        t_mean=24.0, t_amp=8.0, rh_mean=28.0, rh_amp=14.0,
        county="Monterey", location="Santa Lucia Range, Los Padres NF (synthetic fixture)",
        admin_unit="Synthetic fixture (Los Padres NF)", calfire_uid="00000000-f1e3-4d00-8000-0000000011fe",
        fuels_edition="LF2025", percent_contained=18.0, now_ms=real_now,
        forecast_events=[WindEvent((real_now - started) / HOUR_MS + 26.0, 0.7, 6.0, 13.0)],
    )


def east_scenario() -> Scenario:
    """Brief 3 (CONTRACT 14.12.9): a synthetic historical fire near Black Cove, NC (35.29, -82.30), UTM 17, Eastern
    time (EDT on these dates), with a NIFC WFIGS-style record that matches no real record (``irwin_id`` null)."""
    started = int(datetime(2025, 3, 22, 18, 10, tzinfo=timezone.utc).timestamp() * 1000)   # 14:10 EDT
    return Scenario(
        id="fixture-east", name="Fixture East (synthetic)", mode="historical", seed=31,
        center_lon=-82.30, center_lat=35.29, extent_m=12000.0, started_ms=started,
        wind_from=250.0, ignition_uv=(0.38, 0.55),
        river_u0=0.62, river_amp=0.07, river_phase=0.4, river_top_m=700.0,
        town=(0.70, 1.0, 0.80, 1.0),
        events=[WindEvent(3.0, 0.8, 3.5, 9.0), WindEvent(25.0, 1.8, 6.0, 16.0), WindEvent(47.0, 0.6, 4.0, 10.0)],
        spot_h=26.0, target_acres=4000.0, target_at_h=None, contain_h=(70.0, 100.0),
        t_mean=16.0, t_amp=8.0, rh_mean=34.0, rh_amp=14.0,
        county="Polk", location="Blue Ridge escarpment (synthetic fixture)",
        admin_unit="Synthetic fixture (North Carolina)", calfire_uid="",
        fuels_edition="LF2024", percent_contained=100.0,
        tz="America/New_York", tz_abbr="ET", issuer="NIFC WFIGS (IRWIN)",
        summary_extra={
            "uid": "", "record_source": "wfigs", "record_issuer": "NIFC WFIGS (IRWIN)", "state": "NC",
            "time_zone": "America/New_York", "agency": None, "agency_code": None, "irwin_id": None,
            "unique_fire_id": None, "source_name": "Fixture East (synthetic)", "gacc": None, "accuracy_region": None,
            "active_sources": [], "other_records": [], "complex_name": None, "complex_members": [], "aliases": [],
        },
    )


def _use_zone(tz: str) -> None:
    """Point the module's local-time helpers (local hours, wall times, labels) at the scenario's zone."""
    global LA
    LA = ZoneInfo(tz)


# =================================================================================================================
# Terrain
# =================================================================================================================
@dataclass
class Terrain:
    dem: np.ndarray            # render grid float32 m
    river_xz: np.ndarray       # (K, 2) centerline local coords
    river_w: np.ndarray        # (K,) along-course parameter 0 (north) .. 1 (south)
    river_tree: cKDTree
    river_d: np.ndarray        # render grid distance to centerline (m)
    river_wn: np.ndarray       # render grid along-course parameter of the nearest centerline point


def make_terrain(sc: Scenario, render: Grid) -> Terrain:
    X, Z = render.cell_centers_local()
    ext = render.extent_m
    u, w = X / ext + 0.5, Z / ext + 0.5
    pn = Perlin(sc.seed)
    f = 3.1 * ext / 12000.0                       # major ridge systems ~4 km apart
    sx, sy = u * f, w * f
    wx = fbm(pn, sx * 0.5 + 3.1, sy * 0.5 + 7.7, 3)
    wy = fbm(pn, sx * 0.5 - 5.3, sy * 0.5 + 1.9, 3)
    big = ridged(pn, sx + 0.45 * wx, sy + 0.45 * wy, 5, h=1.0)
    big = (big - big.min()) / (np.ptp(big) + 1e-9)
    fe = 6.0 * ext / 12000.0
    ero = eroded_fbm(pn, u * fe + 0.6 * wx + 50.0, w * fe + 0.6 * wy - 20.0, 8, step=fe / render.width)
    ero = (ero - ero.min()) / (np.ptp(ero) + 1e-9)
    region = fbm(pn, u * 1.3 + 101.0, w * 1.3 + 57.0, 2)
    north = smoothstep(1.02, 0.15, w)
    h = 0.24 * (1 - w) ** 1.25 + (0.55 * big + 0.42 * ero) * (0.25 + 0.75 * north) + 0.04 * region
    lo, hi = np.percentile(h, [0.3, 99.9])
    elev = 380.0 + (np.clip(h, lo, hi) - lo) / (hi - lo) * (1800.0 - 380.0)
    # southern basin: a gently sloping alluvial plain with low relief
    ripple = fbm(pn, u * 14.0 + 7.0, w * 14.0 + 3.0, 4)
    basin = 350.0 + 120.0 * (1.0 - w) + 10.0 * ripple
    bw = smoothstep(0.80, 0.96, w)
    elev = elev * (1 - 0.92 * bw) + basin * 0.92 * bw
    # meandering river from the north edge to the south edge in a V-shaped valley with textured walls
    ws = np.linspace(-0.03, 1.03, 3000)
    ur = sc.river_u0 + sc.river_amp * np.sin(2 * np.pi * (0.9 * ws + sc.river_phase)) + 0.032 * np.sin(2 * np.pi * (2.6 * ws + 0.4 + sc.river_phase))
    river_xz = np.c_[(ur - 0.5) * ext, (ws - 0.5) * ext]
    tree = cKDTree(river_xz)
    d, idx = tree.query(np.c_[X.ravel(), Z.ravel()], workers=-1)
    d = d.reshape(X.shape)
    wn = np.clip(ws[idx].reshape(X.shape), 0, 1)
    zr = 335.0 + (sc.river_top_m - 335.0) * (1.0 - wn) ** 1.35
    wall = fbm(pn, u * 22.0 - 3.0, w * 22.0 + 11.0, 4)
    highpass = elev - ndimage.gaussian_filter(elev, 6.0, mode="nearest")     # carry gullies onto the valley walls
    floor = zr + 560.0 * (np.clip(d - 45.0, 0, None) / 850.0) ** 1.1 + (40.0 * wall + 0.9 * highpass) * smoothstep(60.0, 350.0, d)
    floor = np.where(d < 24.0, zr - 3.0 * (1.0 - d / 24.0), floor)
    elev = smin(elev, floor, 30.0)
    elev = np.clip(elev, 300.0, 1800.0)
    return Terrain(elev.astype(np.float32), river_xz, ws, tree, d.astype(np.float32), wn.astype(np.float32))


def sky_view_factor(dem: np.ndarray, res: float, n_az: int = 16, max_dist: float = 1500.0, n_steps: int = 18) -> np.ndarray:
    """Horizon-based sky-view factor: mean over azimuths of cos²(horizon angle), 0..1."""
    h, w = dem.shape
    max_off = int(math.ceil(max_dist / res)) + 2
    pad = np.pad(dem.astype(np.float32), max_off, mode="edge")
    dists = np.geomspace(res, max_dist, n_steps)
    svf = np.zeros(dem.shape, np.float32)
    for k in range(n_az):
        az = 2 * math.pi * k / n_az
        de, dn = math.sin(az), math.cos(az)
        max_tan = np.zeros(dem.shape, np.float32)
        seen: set[tuple[int, int]] = set()
        for dist in dists:
            dc, dr = int(round(de * dist / res)), int(round(-dn * dist / res))
            if (dr, dc) in seen or (dr, dc) == (0, 0):
                continue
            seen.add((dr, dc))
            real = math.hypot(dr, dc) * res
            sh = pad[max_off + dr: max_off + dr + h, max_off + dc: max_off + dc + w]
            np.maximum(max_tan, (sh - dem) / real, out=max_tan)
        svf += 1.0 / (1.0 + max_tan * max_tan)
    return svf / n_az


# =================================================================================================================
# Fuels, canopy
# =================================================================================================================
@dataclass
class Fuels:
    cls: np.ndarray            # fire grid land-cover class
    fuel: np.ndarray           # uint8 FBFM40
    cc: np.ndarray             # uint8 %
    ch: np.ndarray             # float32 m
    cbh: np.ndarray            # float32 m
    cbd: np.ndarray            # float32 kg/m³
    elev: np.ndarray           # fire-grid elevation
    slope: np.ndarray
    aspect: np.ndarray
    tpi: np.ndarray


def mode_filter(cls: np.ndarray, n_classes: int, size: int = 3, keep: tuple[int, ...] = ()) -> np.ndarray:
    counts = np.stack([ndimage.uniform_filter((cls == c).astype(np.float32), size=size, mode="nearest") for c in range(n_classes)])
    out = counts.argmax(axis=0).astype(cls.dtype)
    for c in keep:
        out[cls == c] = c
    return out


def make_fuels(sc: Scenario, fire: Grid, terr: Terrain, rng: np.random.Generator) -> Fuels:
    m = fire.width
    elev = resize(terr.dem, (m, m), order=1, anti_aliasing=True, preserve_range=True).astype(np.float32)
    slope, aspect = slope_aspect(elev, fire.res_m)
    tpi = elev - ndimage.gaussian_filter(elev, 500.0 / fire.res_m / 2.0, mode="nearest")
    X, Z = fire.cell_centers_local()
    u, w = X / fire.extent_m + 0.5, Z / fire.extent_m + 0.5
    d_river, _ = terr.river_tree.query(np.c_[X.ravel(), Z.ravel()], workers=-1)
    d_river = d_river.reshape(m, m)
    n1 = value_fbm(rng, (m, m), 10, 3)
    n2 = value_fbm(rng, (m, m), 22, 3)
    asp = np.radians(aspect)
    facing_n = np.cos(asp)
    facing_sw = np.cos(asp - np.radians(225))
    cls = np.full((m, m), SH5, np.uint8)
    cls[(facing_sw > -0.15) & (slope > 0.28) & (elev > 640) & (elev < 1520) & (n1 > -0.25)] = SH7
    cls[elev < 830 + 110 * n2] = GS2
    cls[((elev < 640 + 90 * n1) & (slope < 0.5)) | ((elev < 780) & (np.cos(asp - np.pi) > 0.45) & (n2 > 0.55))] = GR2
    timber = (facing_n > 0.2) & (elev > 1060 + 150 * n2)
    cls[timber] = TU5
    cls[(timber & (elev > 1380 + 90 * n1)) | (elev > 1610 + 70 * n2)] = TL8
    cls[(d_river < 105 + 75 * n1) & (elev < 1250)] = RIP
    cls[((slope > 0.95) & (n2 > 0.1)) | ((tpi > 50) & (elev > 1450) & (n1 > 0.45))] = BAR
    u0, u1, w0, w1 = sc.town
    town = (u >= u0 + 0.035 * n1) & (u <= u1 + 0.035 * n1) & (w >= w0 + 0.02 * n2) & (w <= w1) & (slope < 0.28) & (d_river > 160)
    cls[town] = URB
    cls[d_river < 34.0] = WAT
    cls = mode_filter(cls, 10, 3, keep=(WAT, URB))
    fuel = CLASS_FBFM[cls]

    cc = np.zeros((m, m), np.float32)
    ch = np.zeros((m, m), np.float32)
    cbh = np.zeros((m, m), np.float32)
    cbd = np.zeros((m, m), np.float32)
    nz = value_fbm(rng, (m, m), 40, 2)

    def setv(c: int, cc_mu: float, cc_sd: float, ch_mu: float, ch_sd: float, cbh_mu: float, cbd_mu: float) -> None:
        sel = cls == c
        cc[sel] = np.clip(cc_mu + cc_sd * nz[sel], 0, 95)
        ch[sel] = np.clip(ch_mu + ch_sd * n2[sel], 2.0, 40.0)
        cbh[sel] = np.clip(cbh_mu * (1 + 0.3 * n1[sel]), 0.5, 10.0)
        cbd[sel] = np.clip(cbd_mu * (1 + 0.25 * nz[sel]), 0.01, 0.35)

    setv(TU5, 58, 14, 16, 4, 2.5, 0.14)
    setv(TL8, 66, 13, 24, 5, 4.0, 0.10)
    setv(RIP, 60, 12, 13, 3, 3.0, 0.07)
    setv(URB, 18, 8, 9, 2.5, 3.0, 0.03)
    oaks = ((cls == SH5) | (cls == GS2)) & (nz > 1.1)          # scattered oak woodland in chaparral / grass-shrub
    cc[oaks] = np.clip(14 + 10 * (nz[oaks] - 1.1), 5, 45)
    ch[oaks] = np.clip(7 + 2 * n2[oaks], 4, 12)
    cbh[oaks] = 2.0
    cbd[oaks] = 0.05
    cc = np.round(cc).astype(np.uint8)
    none = cc == 0
    ch[none] = cbh[none] = cbd[none] = 0.0
    return Fuels(cls, fuel, cc, ch.astype(np.float32), cbh.astype(np.float32), cbd.astype(np.float32), elev, slope, aspect, tpi.astype(np.float32))


# =================================================================================================================
# Spread (synthetic): anisotropic travel time on a 16-neighbour graph + a separable time profile
# =================================================================================================================
OFFSETS = [(0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1),
           (1, 2), (1, -2), (-1, 2), (-1, -2), (2, 1), (2, -1), (-2, 1), (-2, -1)]


class SpreadGraph:
    """Directed graph whose edge weights are travel 'effort' = length / (fuel x slope x wind factor)."""

    def __init__(self, fu: Fuels, res: float, rng: np.random.Generator, lb_ratio: float = 1.9):
        m = fu.cls.shape[0]
        self.m = m
        burnable = CLASS_SPEED[fu.cls] > 0
        edge = np.minimum.reduce([np.arange(m)[:, None] + np.zeros((1, m)), (m - 1 - np.arange(m))[:, None] + np.zeros((1, m)),
                                  np.arange(m)[None, :] + np.zeros((m, 1)), (m - 1 - np.arange(m))[None, :] + np.zeros((m, 1))]) * res
        speed = CLASS_SPEED[fu.cls] * np.exp(0.5 * value_fbm(rng, (m, m), 26, 3)) * (0.03 + 0.97 * smoothstep(150.0, 900.0, edge))
        idx = np.arange(m * m).reshape(m, m)
        src_l, dst_l, len_l, th_l, base_l = [], [], [], [], []
        for dr, dc in OFFSETS:
            r0, r1, c0, c1 = max(0, -dr), m - max(0, dr), max(0, -dc), m - max(0, dc)
            ok = burnable[r0:r1, c0:c1] & burnable[r0 + dr:r1 + dr, c0 + dc:c1 + dc]
            if abs(dr) == 1 and abs(dc) == 1:
                ok &= burnable[r0 + dr:r1 + dr, c0:c1] & burnable[r0:r1, c0 + dc:c1 + dc]
            elif abs(dr) == 2:
                hr = dr // 2
                ok &= burnable[r0 + hr:r1 + hr, c0:c1] & burnable[r0 + hr:r1 + hr, c0 + dc:c1 + dc]
            elif abs(dc) == 2:
                hc = dc // 2
                ok &= burnable[r0:r1, c0 + hc:c1 + hc] & burnable[r0 + dr:r1 + dr, c0 + hc:c1 + hc]
            length = res * math.hypot(dr, dc)
            rise = (fu.elev[r0 + dr:r1 + dr, c0 + dc:c1 + dc] - fu.elev[r0:r1, c0:c1]) / length
            f_s = np.where(rise > 0, np.minimum(1.0 + 4.0 * rise * rise, 6.0), 1.0 / (1.0 + 1.2 * np.abs(rise)))
            base = np.sqrt(speed[r0:r1, c0:c1] * speed[r0 + dr:r1 + dr, c0 + dc:c1 + dc]) * f_s
            src_l.append(idx[r0:r1, c0:c1][ok])
            dst_l.append(idx[r0 + dr:r1 + dr, c0 + dc:c1 + dc][ok])
            len_l.append(np.full(int(ok.sum()), length))
            th_l.append(np.full(int(ok.sum()), math.degrees(math.atan2(dc, -dr)) % 360.0))
            base_l.append(base[ok])
        self.src = np.concatenate(src_l)
        dst = np.concatenate(dst_l)
        self.length = np.concatenate(len_l)
        self.theta = np.radians(np.concatenate(th_l))
        self.base = np.concatenate(base_l)
        n = m * m
        self.csr = csr_matrix((np.arange(1, len(self.src) + 1, dtype=np.float64), (self.src, dst)), shape=(n, n))
        self.perm = (self.csr.data - 1).astype(np.int64)
        self.ecc = math.sqrt(1.0 - 1.0 / (lb_ratio * lb_ratio))
        self.omega_noise = 16.0 * value_fbm(rng, (m, m), 6, 2).ravel()
        self.burnable = burnable

    def solve(self, sources: np.ndarray, wind_from: float) -> np.ndarray:
        """Effort-to-reach every cell from ``sources`` (flat indices); inf where unreachable. (M, M) float64."""
        omega = np.radians((wind_from + 180.0 + self.omega_noise[self.src]) % 360.0)
        e = self.ecc
        f_w = (1.0 - e) / (1.0 - e * np.cos(self.theta - omega))
        cost = self.length / (self.base * f_w)
        self.csr.data = cost[self.perm]
        d = dijkstra(self.csr, directed=True, indices=np.atleast_1d(sources), min_only=True)
        return d.reshape(self.m, self.m)


def local_hour(ms) -> np.ndarray:
    """Local (America/Los_Angeles) hour of day (float) for epoch-ms timestamps."""
    ms = np.asarray(ms, dtype=np.int64)
    uniq, inv = np.unique(ms // HOUR_MS, return_inverse=True)
    offs = np.array([datetime.fromtimestamp(int(h) * 3600, tz=LA).utcoffset().total_seconds() / 3600.0 for h in uniq])
    return (ms / HOUR_MS + offs[inv].reshape(ms.shape)) % 24.0


def la_ms(day: date, hour_local: float) -> int:
    """Epoch ms of a local (America/Los_Angeles) wall-clock time."""
    hh = int(hour_local) % 24
    mm = int(round((hour_local - int(hour_local)) * 60)) % 60
    return int(datetime(day.year, day.month, day.day, hh, mm, tzinfo=LA).timestamp() * 1000)


def diurnal(hl: np.ndarray, peak: float = 15.0) -> np.ndarray:
    return ((1.0 + np.cos(2 * np.pi * (hl - peak) / 24.0)) / 2.0) ** 1.5


def event_sum(t_h: np.ndarray, events: list[WindEvent], attr: str = "spread_amp") -> np.ndarray:
    out = np.zeros_like(t_h, dtype=np.float64)
    for ev in events:
        out += getattr(ev, attr) * np.exp(-(((t_h - ev.t_h) / ev.width_h) ** 2))
    return out


def spread_rate_profile(sc: Scenario, t_h: np.ndarray, events: list[WindEvent], contain: tuple[float, float] | None) -> np.ndarray:
    """Relative spread rate over time (hours after ignition): diurnal x wind events x containment."""
    hl = local_hour(sc.started_ms + (t_h * HOUR_MS).astype(np.int64))
    s = (0.15 + 0.85 * diurnal(hl)) * (1.0 + event_sum(t_h, events))
    if contain is not None:
        a, b = contain
        s = s * np.clip(1.0 - (t_h - a) / (b - a), 0.0, 1.0) ** 1.5
    return s


def cumulative(t_h: np.ndarray, s: np.ndarray) -> np.ndarray:
    dt = np.diff(t_h, prepend=t_h[0])
    c = np.cumsum(s * dt)
    return c + np.arange(len(c)) * 1e-9          # strictly increasing for interpolation


@dataclass
class TruthFire:
    arrival_h: np.ndarray       # hours since time_origin (fire grid), NEVER where unburned
    k: float
    t_grid: np.ndarray
    S: np.ndarray
    spot_xz: tuple[float, float]
    spot_rc: tuple[int, int]
    ign_rc: tuple[int, int]
    tau_main: np.ndarray
    tau_spot: np.ndarray


def nearest_burnable(burnable: np.ndarray, r: int, c: int) -> tuple[int, int]:
    if burnable[r, c]:
        return r, c
    rr, cc = np.nonzero(burnable)
    i = int(np.argmin((rr - r) ** 2 + (cc - c) ** 2))
    return int(rr[i]), int(cc[i])


def simulate_truth(sc: Scenario, fire: Grid, fu: Fuels, graph: SpreadGraph, terr: Terrain) -> TruthFire:
    m = fire.width
    origin = time_origin_for(sc.started_ms)
    ign_off_h = (sc.started_ms - origin) / HOUR_MS
    r0, c0 = int(sc.ignition_uv[1] * m), int(sc.ignition_uv[0] * m)
    ign = nearest_burnable(graph.burnable, r0, c0)
    t_grid = np.arange(0.0, 240.0, 1.0 / 12.0)
    S = cumulative(t_grid, spread_rate_profile(sc, t_grid, sc.events, sc.contain_h))
    lim_h = sc.target_at_h if sc.target_at_h is not None else t_grid[-1]
    s_lim = float(np.interp(lim_h, t_grid, S))
    res2 = fire.res_m**2
    target_px = sc.target_acres * ACRE / res2

    tau_main = graph.solve(np.array([ign[0] * m + ign[1]]), sc.wind_from)

    def calibrate(tau_eff_fn) -> float:
        lo, hi = -12.0, 12.0
        for _ in range(70):
            mid = (lo + hi) / 2
            k = 10.0**mid
            area = np.count_nonzero(tau_eff_fn(k) / k <= s_lim)
            lo, hi = (mid, hi) if area < target_px else (lo, mid)
        return 10.0 ** ((lo + hi) / 2)

    k1 = calibrate(lambda k: tau_main)
    # spot fire: downwind of the main front at spot time, across the river when the front is near it
    s_spot = float(np.interp(sc.spot_h, t_grid, S))
    front = np.argwhere((tau_main / k1 <= s_spot) & (tau_main / k1 > float(np.interp(sc.spot_h - 3, t_grid, S))))
    if len(front) == 0:
        front = np.argwhere(tau_main / k1 <= s_spot)
    toward = np.radians((sc.wind_from + 180.0) % 360.0)
    dir_e, dir_s = math.sin(toward), -math.cos(toward)          # x east, z south
    fx = (front[:, 1] + 0.5) * fire.res_m - fire.extent_m / 2
    fz = (front[:, 0] + 0.5) * fire.res_m - fire.extent_m / 2
    lead = int(np.argmax(fx * dir_e + fz * dir_s))
    spot = None
    for dist in np.arange(450.0, 1500.0, 30.0):
        sx, sz = fx[lead] + dir_e * dist, fz[lead] + dir_s * dist
        rr, cc = int((sz + fire.extent_m / 2) / fire.res_m), int((sx + fire.extent_m / 2) / fire.res_m)
        if not (0 <= rr < m and 0 <= cc < m):
            break
        d_r, _ = terr.river_tree.query([sx, sz])
        if graph.burnable[rr, cc] and fu.cls[rr, cc] != WAT and d_r > 120 and tau_main[rr, cc] / k1 > s_spot + 1e-6:
            spot = (rr, cc)
            if dist > 650:
                break
    if spot is None:
        spot = nearest_burnable(graph.burnable, int(np.clip(front[lead][0] - 20 * dir_s, 0, m - 1)), int(np.clip(front[lead][1] + 20 * dir_e, 0, m - 1)))
    tau_spot = graph.solve(np.array([spot[0] * m + spot[1]]), sc.wind_from)

    def eff(k: float) -> np.ndarray:
        return np.minimum(tau_main, k * s_spot + tau_spot)

    k = calibrate(eff)
    sigma = eff(k) / k
    burned = sigma <= s_lim
    t_since = np.interp(np.where(burned, sigma, 0.0), S, t_grid)
    arrival = np.where(burned & (fu.cls != WAT), ign_off_h + t_since, NEVER).astype(np.float32)
    arrival[ign] = ign_off_h
    sx = (spot[1] + 0.5) * fire.res_m - fire.extent_m / 2
    sz = (spot[0] + 0.5) * fire.res_m - fire.extent_m / 2
    return TruthFire(arrival, k, t_grid, S, (sx, sz), spot, ign, tau_main, tau_spot)


# =================================================================================================================
# Observations derived from the arrival field
# =================================================================================================================
def ms_of(origin: int, h: float | np.ndarray):
    return origin + np.round(np.asarray(h) * HOUR_MS).astype(np.int64)


def make_detections(sc: Scenario, fire: Grid, arrival_h: np.ndarray, origin: int, end_ms: int, rng: np.random.Generator) -> list[dict]:
    """VIIRS (3 sats) + MODIS (Terra/Aqua) passes, GOES every 10 min, one Landsat pass; sampled from the arrival field."""
    rr, cc = np.nonzero(arrival_h < NEVER)
    a = arrival_h[rr, cc].astype(np.float64)
    px = (cc + 0.5) * fire.res_m - fire.extent_m / 2
    pz = (rr + 0.5) * fire.res_m - fire.extent_m / 2
    start_ms = sc.started_ms - 2 * HOUR_MS
    out: list[dict] = []
    half = fire.extent_m / 2

    def emit(t_ms: int, x: float, z: float, frp: float | None, sat: str, inst: str, conf: str, foot: float) -> None:
        lon, lat = fire.local_to_lonlat(x, z)
        hl = float(local_hour(np.array([t_ms]))[0])
        out.append({
            "t_ms": int(t_ms), "lat": round(lat, 6), "lon": round(lon, 6), "x": round(float(x), 1), "z": round(float(z), 1),
            "frp": None if frp is None else round(float(frp), 2), "satellite": sat, "instrument": inst,
            "confidence": conf, "daynight": "D" if 6.0 <= hl < 19.0 else "N", "footprint_m": foot,
        })

    def cells(t_ms: int, size: float, tau_h: float, window_h: float):
        th = (t_ms - origin) / HOUR_MS
        sel = (a <= th) & (a > th - window_h)
        if not sel.any():
            return None
        wgt = np.exp(-(th - a[sel]) / tau_h)
        ox, oz = rng.uniform(0, size, 2)
        ci = np.floor((px[sel] + half + ox) / size).astype(np.int64)
        cj = np.floor((pz[sel] + half + oz) / size).astype(np.int64)
        n = int(math.ceil((fire.extent_m + size) / size)) + 1
        key = cj * n + ci
        tot = np.bincount(key, weights=wgt, minlength=n * n)
        per_cell = (size / fire.res_m) ** 2
        frac = tot / per_cell
        hit = np.nonzero(frac > 0)[0]
        xs = (hit % n + 0.5) * size - half - ox
        zs = (hit // n + 0.5) * size - half - oz
        return frac[hit], xs, zs

    # polar orbiters: (satellite, instrument, local day hour, local night hour, cell size m, conf style)
    polar = [("N", "VIIRS", 13.5, 1.5, 375.0), ("N20", "VIIRS", 12.7, 0.7, 375.0), ("N21", "VIIRS", 13.1, 1.1, 375.0),
             ("Terra", "MODIS", 10.5, 22.5, 1000.0), ("Aqua", "MODIS", 13.5, 1.5, 1000.0)]
    day = datetime.fromtimestamp(start_ms / 1000, tz=LA).date() - timedelta(days=1)
    last_day = datetime.fromtimestamp(end_ms / 1000, tz=LA).date() + timedelta(days=1)
    while day <= last_day:
        for sat, inst, h_day, h_night, size in polar:
            for hloc in (h_day, h_night):
                t = int(la_ms(day, hloc) + rng.normal(0, 0.45) * HOUR_MS)
                if not (start_ms <= t <= end_ms):
                    continue
                res = cells(t, size, 1.5, 6.0)
                if res is None:
                    continue
                frac, xs, zs = res
                thr = 0.02 if inst == "VIIRS" else 0.025
                for f, x, z in zip(frac, xs, zs):
                    if f < thr or rng.random() > 0.36 * min(0.9, 0.2 + 9 * f):
                        continue
                    jx, jz = rng.normal(0, 0.15 * size, 2)
                    if inst == "VIIRS":
                        frp = 1.0 + 260.0 * f * rng.lognormal(0, 0.45)
                        conf = "h" if f > 0.12 else "n"
                    else:
                        frp = 4.0 + 1100.0 * f * rng.lognormal(0, 0.45)
                        conf = str(int(np.clip(55 + 220 * f, 30, 100)))
                    emit(t, x + jx, z + jz, frp, sat, inst, conf, size)
        day += timedelta(days=1)
    # Landsat: one daytime pass near the middle of the observed period
    t_land = la_ms(datetime.fromtimestamp((sc.started_ms + 0.45 * (end_ms - sc.started_ms)) / 1000, tz=LA).date(), 10.75)
    if start_ms <= t_land <= end_ms:
        th = (t_land - origin) / HOUR_MS
        sel = np.nonzero((a <= th) & (a > th - 2.0))[0]
        if len(sel):
            for i in rng.choice(sel, size=min(36, len(sel)), replace=False):
                emit(t_land, px[i] + rng.normal(0, 8), pz[i] + rng.normal(0, 8), None, "L9", "LANDSAT", "H" if rng.random() < 0.7 else "M", 30.0)
    # GOES-18 every 10 min, 2 km cells (already "thinned": <= 1 per 10 min per cell)
    t = (start_ms // (10 * 60000) + 1) * 10 * 60000
    while t <= end_ms:
        res = cells(t, 2000.0, 1.2, 4.0)
        if res is not None:
            frac, xs, zs = res
            for f, x, z in zip(frac, xs, zs):
                if f < 0.01 or rng.random() > min(0.75, 0.15 + 10 * f):
                    continue
                emit(t, x + rng.normal(0, 300), z + rng.normal(0, 300), 12.0 + 3800.0 * f * rng.lognormal(0, 0.35), "G18", "GOES", f"{min(100.0, 30.0 + 600.0 * f):.1f}", 2000.0)
        t += 10 * 60000
    out.sort(key=lambda r: (r["t_ms"], r["instrument"]))
    return out


def mask_rings(mask: np.ndarray, fire: Grid, max_vertices: int = 1500) -> list[list[list[float]]]:
    padded = np.pad(mask.astype(np.float32), 1)
    contours = measure.find_contours(padded, 0.5)
    rings = []
    for cnt in contours:
        if len(cnt) < 8:
            continue
        r = cnt[:, 0] - 1.0
        c = cnt[:, 1] - 1.0
        xs = (c + 0.5) * fire.res_m - fire.extent_m / 2
        zs = (r + 0.5) * fire.res_m - fire.extent_m / 2
        rings.append(np.c_[xs, zs])
    tol = fire.res_m * 0.4
    while True:
        simp = []
        for ring in rings:
            ls = LineString(ring).simplify(tol, preserve_topology=False)
            coords = np.asarray(ls.coords)
            if len(coords) >= 4:
                if not np.allclose(coords[0], coords[-1]):
                    coords = np.vstack([coords, coords[:1]])
                simp.append(coords)
        if sum(len(s) for s in simp) <= max_vertices:
            break
        tol *= 1.5
    return [[[round(float(x), 1), round(float(z), 1)] for x, z in s] for s in simp]


def make_perimeters(sc: Scenario, fire: Grid, arrival_h: np.ndarray, origin: int, end_ms: int, last_growth_ms: int) -> list[dict]:
    out = []
    t = sc.started_ms + 8 * HOUR_MS
    # align to 08:00 / 20:00 local
    hl = float(local_hour(np.array([t]))[0])
    t += int(((8.0 - hl) % 12.0) * HOUR_MS)
    t = t // 60000 * 60000
    times = []
    while t <= end_ms:
        times.append(t)
        t += 12 * HOUR_MS
    if sc.mode == "historical" and (not times or times[-1] < last_growth_ms):
        times.append(min(end_ms, last_growth_ms + 6 * HOUR_MS))
    prev_acres = 0.0
    for i, t in enumerate(times):
        th = (t - origin) / HOUR_MS
        mask = arrival_h <= th
        acres = float(mask.sum()) * fire.res_m**2 / ACRE
        if acres < 5 or acres < prev_acres * 0.999 and i > 0:
            continue
        prev_acres = acres
        final = sc.mode == "historical" and i == len(times) - 1
        out.append({"t_ms": int(t), "acres": round(acres, 1), "source": "NIFC WFIGS " + ("final" if final else "daily") + " perimeter (fixture)", "rings": mask_rings(mask, fire)})
    return out


def ros_series(arrival_h: np.ndarray, res: float, hours: np.ndarray) -> np.ndarray:
    """90th percentile of 1/|grad T| (m/h -> chains/h) over pixels that burned in (t-1, t]."""
    a = np.where(arrival_h < NEVER, arrival_h, np.nan).astype(np.float64)
    gy, gx = np.gradient(a, res)
    g = np.hypot(gx, gy)
    speed = np.where(g > 1e-6, 1.0 / g, np.nan)
    speed = np.minimum(speed, 400 * CHAIN)
    flat_a, flat_s = a.ravel(), speed.ravel()
    order = np.argsort(np.nan_to_num(flat_a, nan=np.inf))
    sa, ss = flat_a[order], flat_s[order]
    out = np.zeros(len(hours))
    lo = np.searchsorted(sa, hours - 1.0, side="right")
    hi = np.searchsorted(sa, hours, side="right")
    for i, (l, h) in enumerate(zip(lo, hi)):
        if h > l:
            v = ss[l:h]
            v = v[np.isfinite(v)]
            if len(v):
                out[i] = np.percentile(v, 90) / CHAIN
    return out


def make_timeseries(fire: Grid, arrival_h: np.ndarray, origin: int, start_ms: int, now_ms_: int, detections: list[dict]) -> dict:
    t_ms = np.arange(start_ms, floor_hour_ms(now_ms_) + 1, HOUR_MS, dtype=np.int64)
    hours = (t_ms - origin) / HOUR_MS
    burned = np.sort(arrival_h[arrival_h < NEVER].ravel())
    area = np.searchsorted(burned, hours, side="right") * fire.res_m**2 / ACRE
    growth = np.diff(area, prepend=0.0)
    ros = ros_series(arrival_h, fire.res_m, hours)
    det_t = np.array([d["t_ms"] for d in detections], dtype=np.int64)
    det_n = np.searchsorted(np.sort(det_t), t_ms, side="right") - np.searchsorted(np.sort(det_t), t_ms - HOUR_MS, side="right")
    goes = [(d["t_ms"], d["frp"] or 0.0) for d in detections if d["instrument"] == "GOES"]
    frp = np.zeros(len(t_ms))
    if goes:
        gt = np.array([g[0] for g in goes], dtype=np.int64)
        gf = np.array([g[1] for g in goes])
        for i, t in enumerate(t_ms):
            sel = (gt > t - HOUR_MS) & (gt <= t)
            frp[i] = gf[sel].sum() / 6.0         # 6 scans per hour; scans without detections count as 0
    return {
        "step_h": 1,
        "t_ms": [int(v) for v in t_ms],
        "area_acres": [round(float(v), 2) for v in area],
        "growth_acres_per_h": [round(float(v), 2) for v in growth],
        "ros_ch_per_h": [round(float(v), 2) for v in ros],
        "detections_per_h": [int(v) for v in det_n],
        "frp_mw_per_h": [round(float(v), 2) for v in frp],
    }


# =================================================================================================================
# Weather
# =================================================================================================================
def emc_pct(temp_c: np.ndarray, rh: np.ndarray) -> np.ndarray:
    t = temp_c * 9 / 5 + 32
    h = rh
    return np.where(h < 10, 0.03229 + 0.281073 * h - 0.000578 * h * t,
                    np.where(h < 50, 2.22749 + 0.160107 * h - 0.01478 * t, 21.0606 + 0.005565 * h * h - 0.00035 * h * t - 0.483199 * h))


def ffwi(temp_c: np.ndarray, rh: np.ndarray, wind_ms: np.ndarray) -> np.ndarray:
    m = np.clip(emc_pct(temp_c, rh), 0, 30) / 30.0
    eta = 1 - 2 * m + 1.5 * m**2 - 0.5 * m**3
    u = wind_ms * 2.236936
    return eta * np.sqrt(1 + u * u) / 0.3002


def lagged(x: np.ndarray, tau_h: float, init: float) -> np.ndarray:
    out = np.empty_like(x)
    a = 1 - math.exp(-1.0 / tau_h)
    v = init
    for i, xi in enumerate(x):
        v = v + a * (xi - v)
        out[i] = v
    return out


def wind_dir_series(sc: Scenario, t_h: np.ndarray, hl: np.ndarray, noise: np.ndarray, events: list[WindEvent]) -> np.ndarray:
    night = 1.0 - diurnal(hl, 15.0)
    ev = np.clip(event_sum(t_h, events, "spread_amp"), 0, 1)
    return (sc.wind_from - 48.0 * night * (1 - ev) + 9.0 * noise + 8.0 * ev) % 360.0


def make_weather(sc: Scenario, render: Grid, terr: Terrain, origin: int, obs_end_ms: int, rng: np.random.Generator) -> tuple[dict, dict]:
    w0 = origin - 72 * HOUR_MS
    w1 = floor_hour_ms(obs_end_ms) + 96 * HOUR_MS
    t_ms = np.arange(w0, w1 + 1, HOUR_MS, dtype=np.int64)
    n = len(t_ms)
    t_h = (t_ms - sc.started_ms) / HOUR_MS
    hl = local_hour(t_ms)
    events = sc.events + sc.forecast_events
    g = np.zeros(n)
    peak_extra = np.zeros(n)
    for ev in events:
        ge = np.exp(-(((t_h - ev.t_h) / ev.width_h) ** 2))
        g = np.maximum(g, ge * min(1.0, ev.spread_amp))
        peak_extra = np.maximum(peak_extra, ge * ev.wind_peak_ms)
    slow = np.convolve(rng.normal(0, 1, n + 48), np.ones(24) / 24, mode="same")[24:24 + n] * 3.0
    temp = sc.t_mean + sc.t_amp * np.cos(2 * np.pi * (hl - 15.0) / 24.0) + 3.0 * g + 0.8 * slow
    rh = np.clip(sc.rh_mean - sc.rh_amp * np.cos(2 * np.pi * (hl - 15.0) / 24.0) - 10.0 * g - 2.0 * slow + rng.normal(0, 1.2, n), 4.0, 98.0)
    gamma = np.log(rh / 100.0) + 17.625 * temp / (243.04 + temp)
    dew = 243.04 * gamma / (17.625 - gamma)
    base = 1.8 + 4.2 * diurnal(hl, 16.0) + np.abs(rng.normal(0, 0.5, n))
    speed = np.where(peak_extra > base, peak_extra * (0.97 + 0.03 * rng.random(n)), base)
    noise = np.convolve(rng.normal(0, 1, n + 12), np.ones(6) / 6, mode="same")[6:6 + n] * 2.0
    wdir = wind_dir_series(sc, t_h, hl, noise, events)
    gust = speed * (1.32 + 0.08 * rng.random(n)) + 1.2
    emc = emc_pct(temp, rh)
    fm1 = 1.03 * emc
    fm10 = lagged(emc, 10.0, float(emc[:72].mean()))
    fm100 = lagged(emc, 100.0, float(emc[:72].mean()) + 2.0)
    fwi = ffwi(temp, rh, speed)
    mph = speed * 2.236936
    ros_pot = (6.0 + 1.9 * mph**1.45) * np.clip(1.45 - fm1 / 9.0, 0.15, 1.4)
    flame_ft = 1.9 * ros_pot**0.5
    # 4 x 4 grid: terrain-modulated speed and direction offsets per cell
    xs, zs = weather_axes(render)
    cell_elev = np.zeros((4, 4))
    for j in range(4):
        for i in range(4):
            r, c = render.local_to_rowcol(xs[i], zs[j])
            cell_elev[j, i] = terr.dem[int(r), int(c)]
    s_fac = 1.0 + 0.16 * (cell_elev - cell_elev.mean()) / (cell_elev.std() + 1e-9)
    d_off = rng.normal(0, 9.0, (4, 4))
    sp = speed[:, None, None] * s_fac[None]
    dr = np.radians(wdir[:, None, None] + d_off[None])
    u = -sp * np.sin(dr)
    v = -sp * np.cos(dr)
    forecast_from = None if sc.mode == "historical" else int(floor_hour_ms(obs_end_ms) + HOUR_MS)
    weather = {
        "source": "fixture:synthetic (shaped like open-meteo:" + ("historical-forecast:gfs_hrrr)" if sc.mode == "historical" else "gfs_hrrr+gfs_seamless)"),
        "t_ms": [int(v_) for v_ in t_ms],
        "at_fire": {
            "temp_c": np.round(temp, 2).tolist(), "rh_pct": np.round(rh, 1).tolist(), "dewpoint_c": np.round(dew, 2).tolist(),
            "wind_speed_ms": np.round(speed, 2).tolist(), "wind_dir_deg": np.round(wdir, 1).tolist(),
            "wind_gust_ms": np.round(gust, 2).tolist(), "precip_mm": [0.0] * n,
            "fm1_pct": np.round(fm1, 2).tolist(), "fm10_pct": np.round(fm10, 2).tolist(), "fm100_pct": np.round(fm100, 2).tolist(),
            "ffwi": np.round(fwi, 1).tolist(),
            "flame_length_ft": np.round(flame_ft, 1).tolist(), "ros_ch_per_h_potential": np.round(ros_pot, 1).tolist(),
        },
        "grid": {"nx": 4, "ny": 4, "x": [float(x) for x in xs], "z": [float(z) for z in zs],
                 "u_ms": np.round(u, 2).ravel().tolist(), "v_ms": np.round(v, 2).ravel().tolist()},
        "forecast_from_ms": forecast_from,
    }
    aux = {"t_ms": t_ms, "speed": speed, "gust": gust, "dir": wdir}
    return weather, aux


# =================================================================================================================
# Events
# =================================================================================================================
def cardinal(deg: float) -> str:
    names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return names[int((deg % 360) / 22.5 + 0.5) % 16]


def la_label(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=LA).strftime("%b %d, %H:%M")


def make_events(sc: Scenario, fire: Grid, fu: Fuels, truth: TruthFire, arrival_h: np.ndarray, origin: int, ts: dict,
                weather_aux: dict, obs_end_ms: int, contained_ms: int | None) -> list[dict]:
    ev: list[dict] = []
    X, Z = fire.cell_centers_local()

    def centroid(sel: np.ndarray) -> tuple[float, float]:
        return float(X[sel].mean()), float(Z[sel].mean())

    ix, iz = fire.pixel_center_local(*truth.ign_rc)
    ev.append({"type": "ignition", "t_ms": sc.started_ms, "title": "Ignition (est.)",
               "detail": f"Reported by {sc.issuer}; fixture ignition at {la_label(sc.started_ms)} {sc.tz_abbr}.", "x": round(ix, 1), "z": round(iz, 1),
               "confidence": "estimated", "source": f"{sc.issuer} (fixture)"})
    growth = np.array(ts["growth_acres_per_h"])
    t_arr = np.array(ts["t_ms"])
    pos = growth[growth > 0]
    if len(pos):
        thr = max(250.0, 3.0 * float(np.median(pos)))
        picked: list[int] = []
        for i in np.argsort(-growth):
            if growth[i] < thr or len(picked) >= 3:
                break
            if all(abs(int(t_arr[i]) - int(t_arr[j])) >= 12 * HOUR_MS for j in picked):
                picked.append(int(i))
        for i in picked:
            th = (t_arr[i] - origin) / HOUR_MS
            sel = (arrival_h > th - 1) & (arrival_h <= th)
            cx, cz = centroid(sel)
            ev.append({"type": "rapid_growth", "t_ms": int(t_arr[i]) - HOUR_MS // 2, "title": "Rapid growth",
                       "detail": f"+{growth[i]:,.0f} ac/h; front ROS {ts['ros_ch_per_h'][i]:.0f} ch/h", "x": round(cx, 1), "z": round(cz, 1),
                       "confidence": "observed", "source": "Observed arrival (fixture)"})
    spot_t = int(ms_of(origin, float(arrival_h[truth.spot_rc])))
    if spot_t <= obs_end_ms:
        ev.append({"type": "spot_fire", "t_ms": spot_t, "title": "Spot fire (prob.)",
                   "detail": "New detection ~0.7 km ahead of the front, across the creek.", "x": round(truth.spot_xz[0], 1),
                   "z": round(truth.spot_xz[1], 1), "confidence": "probable", "source": "FIRMS VIIRS (fixture)"})
    ridge = (fu.tpi > 40) & (arrival_h < NEVER)
    if ridge.any():
        burned_t = arrival_h[ridge]
        lo, hi = np.percentile(burned_t, [20, 80])
        cand = ridge & (arrival_h >= lo) & (arrival_h <= hi)
        if cand.any():
            r, c = np.unravel_index(np.argmax(np.where(cand, fu.tpi, -1e9)), fu.tpi.shape)
            x, z = fire.pixel_center_local(r, c)
            ev.append({"type": "ridge_crossing", "t_ms": int(ms_of(origin, float(arrival_h[r, c]))), "title": "Ridge crossing",
                       "detail": f"Front crossed a ridge at {fu.elev[r, c]:,.0f} m (TPI +{fu.tpi[r, c]:.0f} m).", "x": round(x, 1), "z": round(z, 1),
                       "confidence": "estimated", "source": "Terrain + observed arrival (fixture)"})
    wt = weather_aux["t_ms"]
    grow_sel = np.isin(wt, t_arr[growth > 1.0])
    if grow_sel.any():
        i = int(np.argmax(np.where(grow_sel, weather_aux["gust"], -1)))
        th = (int(wt[i]) - origin) / HOUR_MS
        sel = (arrival_h > th - 3) & (arrival_h <= th)
        cx, cz = centroid(sel) if sel.any() else (ix, iz)
        ev.append({"type": "peak_wind", "t_ms": int(wt[i]), "title": "Peak wind",
                   "detail": f"Gust {weather_aux['gust'][i]:.1f} m/s ({weather_aux['gust'][i] * 2.236936:.0f} mph) from {cardinal(weather_aux['dir'][i])}.",
                   "x": round(cx, 1), "z": round(cz, 1), "confidence": "observed", "source": "Open-Meteo HRRR (fixture)"})
    if contained_ms is not None:
        ev.append({"type": "containment", "t_ms": contained_ms, "title": "Containment",
                   "detail": "100% contained (WFIGS ContainmentDateTime).", "confidence": "observed", "source": "WFIGS (fixture)"})
    ev = [e for e in ev if e["t_ms"] <= obs_end_ms]
    ev.sort(key=lambda e: e["t_ms"])
    for i, e in enumerate(ev):
        e["id"] = f"ev-{i + 1:02d}"
    return [{k: e[k] for k in ("id", "type", "t_ms", "title", "detail", "x", "z", "confidence", "source") if k in e} for e in ev]


# =================================================================================================================
# Forecast (synthetic ensemble)
# =================================================================================================================
def make_forecast(sc: Scenario, fire: Grid, fu: Fuels, graph: SpreadGraph, truth: TruthFire, observed_h: np.ndarray, origin: int,
                  start_ms: int, horizon_h: int, ensemble: str, members: int, weather_aux: dict, rng: np.random.Generator,
                  data_end_ms: int | None) -> tuple[dict, dict[str, np.ndarray]]:
    t0 = time.time()
    m = fire.width
    start_h = (start_ms - origin) / HOUR_MS
    start_ign = (start_ms - sc.started_ms) / HOUR_MS
    burned0 = observed_h <= start_h
    sources = np.flatnonzero(burned0)
    if len(sources) == 0:
        sources = np.array([truth.ign_rc[0] * m + truth.ign_rc[1]])
        burned0 = np.zeros_like(burned0)
        burned0.flat[sources] = True
    events = [e for e in sc.events + sc.forecast_events if e.t_h > start_ign - 12]
    t_grid = np.arange(0.0, horizon_h + 1e-9, 1.0 / 12.0)
    arrivals = np.empty((members, m, m), np.float32)
    flames = np.zeros((members, m, m), np.float32)
    wind_t = weather_aux["t_ms"]
    wind_mph = np.interp(start_ms + t_grid * HOUR_MS, wind_t, weather_aux["speed"]) * 2.236936
    flame_noise = np.exp(0.25 * value_fbm(rng, (m, m), 40, 2))
    for k in range(members):
        if k == 0:
            kf, dd, amp, shift = 1.0, 0.0, 1.0, 0.0
        else:
            kf = float(rng.lognormal(0.0, 0.22))
            dd = float(rng.normal(0.0, 12.0))
            amp = float(rng.uniform(0.6, 1.4))
            shift = float(rng.normal(0.0, 2.5))
        evs = [WindEvent(e.t_h - start_ign + shift, e.spread_amp * amp, e.width_h, e.wind_peak_ms) for e in events]
        s = spread_rate_profile(sc, t_grid + start_ign, [], None) * (1.0 + event_sum(t_grid, evs))
        S = cumulative(t_grid, s)
        tau = graph.solve(sources, sc.wind_from + dd) / (truth.k * kf)
        reach = tau <= S[-1]
        th = np.interp(np.where(reach, tau, 0.0), S, t_grid)
        arr = np.where(reach & (fu.cls != WAT), start_h + th, NEVER).astype(np.float32)
        arr[burned0] = observed_h[burned0]
        arrivals[k] = arr
        fl = CLASS_FLAME_M[fu.cls] * (0.55 + 0.035 * np.interp(np.clip(th, 0, horizon_h), t_grid, wind_mph)) * flame_noise * (1 + 0.6 * np.clip(fu.slope, 0, 1))
        fl = np.where(fu.cc > 40, fl * 1.8, fl)
        flames[k] = np.where(reach & ~burned0, fl, 0.0)
    srt = np.sort(arrivals, axis=0)

    def q(p: float) -> np.ndarray:
        return srt[int(math.ceil(p / 100.0 * members)) - 1]

    p10, p50, p90 = q(10), q(50), q(90)
    end_h = start_h + horizon_h
    prob = (arrivals <= end_h).mean(axis=0).astype(np.float32)
    fl_masked = np.where(flames > 0, flames, np.nan)
    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        fl50 = np.nan_to_num(np.nanmedian(fl_masked, axis=0), nan=0.0).astype(np.float32)
    hours = np.arange(0, horizon_h + 1)
    t_series = [int(start_ms + h * HOUR_MS) for h in hours]
    res2 = fire.res_m**2 / ACRE
    areas = np.stack([[np.count_nonzero(arrivals[k] <= start_h + h) * res2 for h in hours] for k in range(members)])
    ros = np.stack([ros_series(arrivals[k], fire.res_m, start_h + hours) for k in range(min(members, 15))])
    a10, a50, a90 = np.percentile(areas, [10, 50, 90], axis=0)
    fx = {
        "run_id": "fx-001", "incident_id": sc.id, "status": "ready", "issued_ms": 0, "start_ms": int(start_ms), "horizon_h": int(horizon_h),
        "time_origin_ms": int(origin),
        "model": {"engine": "pyretechnics", "version": PYRETECHNICS_VERSION, "surface_lw_ratio_model": "behave", "crown": True,
                  "spotting": False, "spread_adjustment": 1.0, "grid_res_m": fire.res_m},
        "weather": {"source": "fixture:synthetic-" + ensemble, "ensemble": ensemble, "members": members},
        "layers": {},
        "series": {"t_ms": t_series, "area_acres_p10": np.round(a10, 1).tolist(), "area_acres_p50": np.round(a50, 1).tolist(),
                   "area_acres_p90": np.round(a90, 1).tolist(), "ros_ch_per_h_p50": np.round(np.median(ros, axis=0), 1).tolist()},
        "runtime_s": 0.0,
        "warnings": ["Synthetic fixture forecast: generated by scripts/make_fixture.py, not by pyretechnics."],
    }
    if data_end_ms is not None:
        skill = []
        for lead in (12, 24, 48, 72):
            t = start_ms + lead * HOUR_MS
            if lead > horizon_h or t > data_end_ms:
                continue
            th = start_h + lead
            obs = observed_h <= th
            fc = p50 <= th
            denom = obs.sum() + fc.sum()
            sor = 1.0 if denom == 0 else 2.0 * np.count_nonzero(obs & fc) / denom
            skill.append({"lead_h": lead, "sorensen": round(float(sor), 4), "observed_acres": round(float(obs.sum() * res2), 1),
                          "forecast_acres_p50": round(float(fc.sum() * res2), 1)})
        fx["skill"] = skill
    fx["runtime_s"] = round(time.time() - t0, 2)
    return fx, {"arrival_p10": p10, "arrival_p50": p50, "arrival_p90": p90, "burn_probability": prob, "flame_length_p50": fl50}


# =================================================================================================================
# Imagery, water, trees
# =================================================================================================================
PALETTE = {  # class: (base = gaps between plants, clump = plant crowns, clump density) in sRGB 0..1
    SH5: ((0.52, 0.48, 0.38), (0.22, 0.25, 0.16), 0.58),
    SH7: ((0.47, 0.44, 0.35), (0.18, 0.21, 0.14), 0.74),
    GS2: ((0.64, 0.58, 0.44), (0.27, 0.30, 0.19), 0.30),
    GR2: ((0.74, 0.66, 0.49), (0.58, 0.51, 0.37), 0.30),
    TU5: ((0.36, 0.36, 0.27), (0.12, 0.16, 0.11), 0.66),
    TL8: ((0.41, 0.38, 0.30), (0.10, 0.14, 0.10), 0.72),
    RIP: ((0.45, 0.45, 0.33), (0.14, 0.21, 0.12), 0.62),
    BAR: ((0.64, 0.62, 0.57), (0.47, 0.45, 0.41), 0.30),
    URB: ((0.56, 0.54, 0.50), (0.22, 0.27, 0.17), 0.22),
    WAT: ((0.60, 0.57, 0.50), (0.45, 0.43, 0.38), 0.25),     # wash floor around the channel
}


def river_half_width(wn: np.ndarray) -> np.ndarray:
    """Wetted half-width (m) of the fixture river along its course (wider downstream)."""
    return 13.0 + 10.0 * wn


def make_naip(render: Grid, terr: Terrain, fu: Fuels, svf: np.ndarray, rng: np.random.Generator, size: int = 2048) -> bytes:
    """A NAIP-like summer aerial photo (sRGB JPEG) from terrain, fuels and canopy."""
    S = size
    res = render.extent_m / S

    def up(a: np.ndarray, order: int = 1) -> np.ndarray:
        return ndimage.zoom(a.astype(np.float32), S / a.shape[0], order=order, grid_mode=True, mode="nearest")[:S, :S]

    elev = up(terr.dem, 1)
    gy, gx = np.gradient(elev, res)
    nrm = np.sqrt(gx * gx + gy * gy + 1.0)
    sun_az, sun_alt = math.radians(140.0), math.radians(52.0)
    se, sn, su = math.sin(sun_az) * math.cos(sun_alt), math.cos(sun_az) * math.cos(sun_alt), math.sin(sun_alt)
    shade = (-gx * se + gy * sn + su) / nrm
    slope2 = np.sqrt(gx * gx + gy * gy)
    svf2 = up(svf, 1)
    river_d = up(terr.river_d, 1)
    wn2 = up(terr.river_wn, 1)
    cc2 = np.clip(up(fu.cc.astype(np.float32), 1) / 100.0, 0, 1)
    # organic class boundaries: blurred one-hot + noise, argmax
    best = np.full((S, S), -1e9, np.float32)
    cls = np.zeros((S, S), np.uint8)
    edge_noise = value_fbm(rng, (S, S), S / 10.0, 3, 0.6)
    for c in range(10):
        sel = fu.cls == c
        if not sel.any():
            continue
        f = ndimage.gaussian_filter(up(sel.astype(np.float32), 1), 1.8)
        f += 0.20 * edge_noise * (0.6 + 0.4 * math.sin(c * 1.7))
        better = f > best
        best[better] = f[better]
        cls[better] = c
    base = np.array([PALETTE[c][0] for c in range(10)], np.float32)
    clump = np.array([PALETTE[c][1] for c in range(10)], np.float32)
    dens = np.array([PALETTE[c][2] for c in range(10)], np.float32)[cls]
    canopy_cls = np.isin(cls, (TU5, TL8, RIP, URB))
    dens = np.where(canopy_cls, np.clip(0.12 + 0.85 * cc2, 0, 0.92), np.maximum(dens, 0.85 * cc2))
    # multi-scale clumps (shrub patches, tree groups) + fine crowns
    blobs = 0.62 * value_fbm(rng, (S, S), S / 5.0, 2, 0.5) + 0.38 * value_fbm(rng, (S, S), S / 16.0, 2, 0.5)
    blobs /= blobs.std() + 1e-9
    crowns = value_fbm(rng, (S, S), S / 2.4, 1)
    field = np.where(canopy_cls, 0.55 * blobs + 0.65 * crowns, 0.85 * blobs + 0.3 * crowns)
    field /= field.std() + 1e-9
    thr = special.ndtri(np.clip(1.0 - dens, 1e-4, 1 - 1e-4))
    clm = smoothstep(-0.18, 0.18, field - thr).astype(np.float32)
    img = base[cls] * (1 - clm[..., None]) + clump[cls] * clm[..., None]
    # crown shadows cast to the north-west (sun in the south-east)
    shadow = np.clip(np.roll(clm, (-1, -1), axis=(0, 1)) + 0.6 * np.roll(clm, (-2, -2), axis=(0, 1)) - clm, 0, 1)
    img *= (1 - 0.32 * shadow)[..., None]
    var = 1.0 + 0.09 * value_fbm(rng, (S, S), 40, 3) + 0.05 * value_fbm(rng, (S, S), 260, 2)
    hue = 0.04 * value_fbm(rng, (S, S), 28, 2)
    img *= var[..., None]
    img[..., 0] *= 1 + hue
    img[..., 2] *= 1 - 0.8 * hue
    # rock on steep slopes, with fractures
    rocky = smoothstep(0.75, 1.25, slope2) * (0.5 + 0.5 * smoothstep(-0.6, 0.9, value_fbm(rng, (S, S), 110, 2)))
    rock = (rocky * ~np.isin(cls, (WAT, URB))).astype(np.float32)
    frac = 1.0 - 0.25 * smoothstep(0.55, 0.95, np.abs(value_fbm(rng, (S, S), 180, 2)))
    rock_col = np.array([0.63, 0.61, 0.56], np.float32) * ((1 + 0.12 * value_fbm(rng, (S, S), 300, 2)) * frac)[..., None]
    img = img * (1 - rock[..., None]) + rock_col * rock[..., None]
    # river: braided gravel wash, sand bars, a thin wetted channel
    n_w = value_fbm(rng, (S, S), 90, 2)
    hw = river_half_width(wn2) * (1 + 0.22 * n_w)
    wash_w = hw * 2.1 + 28.0 + 30.0 * value_fbm(rng, (S, S), 260, 2)
    wash = smoothstep(wash_w, wash_w - 26.0, river_d).astype(np.float32)
    braid = 0.5 + 0.5 * smoothstep(-0.4, 0.6, value_fbm(rng, (S, S), 420, 2))
    bars = (smoothstep(0.7, 1.3, value_fbm(rng, (S, S), 360, 2)) * (river_d > hw + 8.0)).astype(np.float32)
    sand = np.array([0.71, 0.66, 0.56], np.float32) * (0.86 + 0.16 * braid)[..., None]
    k_w = (0.85 * wash * (1.0 - 0.8 * bars))[..., None]
    img = img * (1 - k_w) + sand * k_w
    wet = smoothstep(hw + 4.0, hw - 4.0, river_d).astype(np.float32)
    depth = np.clip(1.0 - river_d / np.maximum(hw, 1.0), 0, 1)
    wcol = np.array([0.30, 0.34, 0.30], np.float32) * (1 - depth[..., None]) + np.array([0.11, 0.16, 0.17], np.float32) * depth[..., None]
    img = img * (1 - wet[..., None]) + wcol * wet[..., None]
    # town: street grid, roofs, yards with street trees
    urb = (cls == URB).astype(np.float32)
    if urb.any():
        jj, ii = np.meshgrid(np.arange(S), np.arange(S))
        block = max(14, int(round(125.0 / res)))
        street = ((ii % block) < 2) | ((jj % block) < 2)
        lot = max(4, int(round(31.0 / res)))
        lot_id = (ii // lot) * 100003 + (jj // lot)
        lot_rand = (np.sin(lot_id * 12.9898) * 43758.5453) % 1.0
        roof_cols = np.array([[0.69, 0.46, 0.36], [0.78, 0.77, 0.73], [0.46, 0.45, 0.43], [0.60, 0.56, 0.50], [0.36, 0.38, 0.40]], np.float32)
        roof = roof_cols[(lot_rand * 5).astype(int) % 5]
        li, lj = ii % lot, jj % lot
        inner = (li > 0) & (lj > 0) & (li < lot - 1) & (lj < lot - 2) & (lot_rand > 0.12)
        town = np.where(inner[..., None], roof, img)
        town = np.where(street[..., None], np.array([0.38, 0.38, 0.37], np.float32), town)
        trees = (crowns > 1.0) & ~inner
        town = np.where(trees[..., None], np.array([0.17, 0.22, 0.14], np.float32), town)
        img = img * (1 - urb[..., None]) + town * urb[..., None]
    light = 0.40 + 0.78 * np.clip(shade, 0, 1)
    img *= (light * (0.72 + 0.28 * svf2))[..., None]
    img = img * 0.94 + np.array([0.020, 0.024, 0.032], np.float32)
    img += rng.normal(0, 0.008, (S, S, 1)).astype(np.float32) + rng.normal(0, 0.003, (S, S, 3)).astype(np.float32)
    img = np.clip(img, 0, 1)
    img = img + 0.12 * (img - 0.45) * (1 - np.abs(img - 0.45) * 2)     # gentle S-curve
    out = (np.clip(img, 0, 1) ** (1 / 1.04) * 255 + 0.5).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(out, "RGB").save(buf, "JPEG", quality=88, optimize=True, progressive=True)
    return buf.getvalue()


def make_water(render: Grid, terr: Terrain, fu: Fuels) -> np.ndarray:
    hw = river_half_width(terr.river_wn)
    fine = np.clip((hw + 5.0 - terr.river_d) / 10.0, 0, 1)
    w98 = (fu.fuel == 98).astype(np.float32)
    up98 = resize(w98, (render.height, render.width), order=0, anti_aliasing=False)
    up98 = ndimage.gaussian_filter(up98, 2.0) * 0.5
    return (np.maximum(fine, up98) * 255 + 0.5).astype(np.uint8)


def make_trees(fire: Grid, render: Grid, terr: Terrain, fu: Fuels, rng: np.random.Generator, target: int = 60000) -> np.ndarray:
    ccf = fu.cc.astype(np.float64) / 100.0
    shrub_cover = np.select([fu.cls == SH7, fu.cls == SH5, fu.cls == GS2], [0.8, 0.6, 0.3], 0.0)
    fuel = fu.fuel.astype(int)
    shrub_lambda = shrub_cover * (ccf == 0) * 0.30
    n_shrub_exp = shrub_lambda.sum()
    k = max(0.1, (target - n_shrub_exp) / max(ccf.sum(), 1e-9))
    lam = ccf * k
    n_tree = rng.poisson(lam)
    n_sh = rng.poisson(shrub_lambda)
    rr, cc = np.nonzero(n_tree)
    tr, tc = np.repeat(rr, n_tree[rr, cc]), np.repeat(cc, n_tree[rr, cc])
    code = fuel[tr, tc]
    conifer = ((code >= 161) & (code <= 165)) | ((code >= 181) & (code <= 189))
    t_kind = np.where(conifer, 0, np.where(fu.ch[tr, tc] >= 5, 1, 2))
    t_h = np.maximum(fu.ch[tr, tc] * rng.uniform(0.7, 1.1, len(tr)), 3.0)
    rr, cc = np.nonzero(n_sh)
    sr, scol = np.repeat(rr, n_sh[rr, cc]), np.repeat(cc, n_sh[rr, cc])
    rows_a = np.concatenate([tr, sr]).astype(np.float64)
    cols_a = np.concatenate([tc, scol]).astype(np.float64)
    kind = np.concatenate([t_kind, np.full(len(sr), 2)]).astype(np.float32)
    h = np.concatenate([t_h, rng.uniform(1.2, 3.2, len(sr))]).astype(np.float32)
    jr = rng.random(len(rows_a))
    jc = rng.random(len(rows_a))
    x = (cols_a + jc) * fire.res_m - fire.extent_m / 2
    z = (rows_a + jr) * fire.res_m - fire.extent_m / 2
    rr_c, cc_c = render.local_to_rowcol(x, z)
    y = ndimage.map_coordinates(terr.dem, [rr_c - 0.5, cc_c - 0.5], order=1, mode="nearest")
    crown = np.clip(0.28 * h, 1.5, 9.0)
    return np.c_[x, y, z, h, crown, kind].astype(np.float32)


# =================================================================================================================
# Bundle assembly
# =================================================================================================================
def build_fixture(sc: Scenario, data_dir: Path, members: int, quicklook: Path | None) -> dict:
    t_start = time.time()
    _use_zone(sc.tz)
    rng = np.random.default_rng(sc.seed)
    built = now_ms()
    epsg = utm_epsg_for(sc.center_lon)
    ce, cn = transformer(4326, epsg).transform(sc.center_lon, sc.center_lat)
    render = Grid(epsg, float(round(ce)), float(round(cn)), sc.extent_m, config.RENDER_SIZE, config.RENDER_SIZE)
    fire = render.with_size(fire_grid_size(sc.extent_m), fire_grid_size(sc.extent_m))
    origin = time_origin_for(sc.started_ms)
    print(f"[{sc.id}] grid EPSG:{epsg} extent {sc.extent_m:.0f} m, fire {fire.width}² @ {fire.res_m:.2f} m", flush=True)

    terr = make_terrain(sc, render)
    svf = sky_view_factor(terr.dem, render.res_m)
    fu = make_fuels(sc, fire, terr, rng)
    graph = SpreadGraph(fu, fire.res_m, rng)
    truth = simulate_truth(sc, fire, fu, graph, terr)
    full_arrival = truth.arrival_h
    if sc.mode == "live":
        assert sc.now_ms is not None
        cut_h = (sc.now_ms - origin) / HOUR_MS
        observed = np.where(full_arrival <= cut_h, full_arrival, NEVER).astype(np.float32)
        obs_cut_ms = sc.now_ms
    else:
        observed = full_arrival
        burned_t = np.sort(full_arrival[full_arrival < NEVER])
        t99 = float(burned_t[int(0.99 * (len(burned_t) - 1))])
        obs_cut_ms = int(ms_of(origin, min(t99 + 24.0, 45 * 24.0)))
    last_growth_ms = int(ms_of(origin, float(observed[observed < NEVER].max())))
    detections = make_detections(sc, fire, observed, origin, obs_cut_ms, rng)
    if sc.mode == "live":
        now_ = max(d["t_ms"] for d in detections)          # latest observation
        end_ = now_
        contained_ms = None
        observed = np.where(full_arrival <= (now_ - origin) / HOUR_MS, full_arrival, NEVER).astype(np.float32)
        last_growth_ms = int(ms_of(origin, float(observed[observed < NEVER].max())))
    else:
        now_ = end_ = obs_cut_ms
        contained_ms = int(last_growth_ms + 20 * HOUR_MS)
        contained_ms = min(contained_ms, end_)
    start_ = origin
    perimeters = make_perimeters(sc, fire, observed, origin, end_, last_growth_ms)
    ts = make_timeseries(fire, observed, origin, start_, now_, detections)
    weather, waux = make_weather(sc, render, terr, origin, end_, rng)
    events = make_events(sc, fire, fu, truth, observed, origin, ts, waux, end_, contained_ms)
    final_acres = float((observed < NEVER).sum()) * fire.res_m**2 / ACRE

    # ---------------------------------------------------------------- write bundle into a temp dir, then swap in
    inc = data_dir / "incidents"
    tmp = inc / f".{sc.id}.tmp-{built}"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    bundle.write_layer(tmp, "elevation", terr.dem, "render", "m", "USGS 3DEP-like synthetic DEM (fixture)")
    bundle.write_layer(tmp, "fuel", fu.fuel, "fire", "FBFM40", "LANDFIRE-like FBFM40 fuel model codes (fixture); 0 = nodata", nodata=0)
    bundle.write_layer(tmp, "canopy_cover", fu.cc, "fire", "%", "Canopy cover, percent (fixture)")
    bundle.write_layer(tmp, "canopy_height", fu.ch, "fire", "m", "Canopy height (fixture)")
    if sc.mode == "historical":
        dn = np.where(observed < NEVER, np.clip(0.18 + 0.12 * CLASS_FLAME_M[fu.cls] / 2 + 0.25 * value_fbm(rng, fu.cls.shape, 30, 3), 0.05, 1.1), 0.0)
        dn = dn + rng.normal(0, 0.035, dn.shape)
        dn = np.where(fu.cls == WAT, -9999.0, dn).astype(np.float32)
        bundle.write_layer(tmp, "burn_severity", dn, "fire", "dNBR", "Sentinel-2-like dNBR (fixture)", nodata=-9999.0)
    bundle.write_layer(tmp, "observed_arrival", observed, "fire", "h", "Observed arrival, hours since time_origin_ms; NEVER = 1e6 (fixture)")
    water = make_water(render, terr, fu)
    naip = make_naip(render, terr, fu, svf, rng)
    bundle.write_image_layer(tmp, "naip", naip, 2048, 2048, "NAIP-like aerial photo (procedural fixture)")
    bundle.write_layer(tmp, "sky_view", (np.clip(svf, 0, 1) * 255 + 0.5).astype(np.uint8), "render", "0-255", "Sky-view factor (horizon AO), 255 = open sky")
    bundle.write_layer(tmp, "water", water, "render", "0-255", "Water mask (river + FBFM40 98), soft edges")
    trees = make_trees(fire, render, terr, fu, rng)
    bundle.write_layer(tmp, "trees", trees, "points", "m", "Trees: x, y(ground m), z, height_m, crown_radius_m, kind (0 conifer, 1 broadleaf, 2 shrub)")
    bundle.write_npz(tmp / bundle.STATIC_NPZ, fuel_model=fu.fuel.astype(np.int16), slope=fu.slope, aspect=fu.aspect,
                     canopy_cover=(fu.cc.astype(np.float32) / 100.0), canopy_height=fu.ch, canopy_base_height=fu.cbh,
                     canopy_bulk_density=fu.cbd, elevation=fu.elev, res_m=np.float64(fire.res_m))
    bundle.write_json(tmp / "detections.json", {"detections": detections})
    bundle.write_json(tmp / "perimeters.json", {"perimeters": perimeters})
    bundle.write_json(tmp / "timeseries.json", ts)
    bundle.write_json(tmp / "events.json", {"events": events})
    bundle.write_json(tmp / "weather.json", weather)

    # forecast
    if sc.mode == "historical":
        f_start = floor_hour_ms(sc.started_ms + 24 * HOUR_MS)
        ensemble, data_end = "perturbed", end_
    else:
        f_start, ensemble, data_end = now_, "gfs025", None
    fx, fx_layers = make_forecast(sc, fire, fu, graph, truth, observed, origin, f_start, 72, ensemble, members, waux, rng, data_end)
    fdir = f"forecasts/{fx['run_id']}"
    desc = {
        "arrival_p10": "Arrival time, 10th percentile across members (hours since time_origin_ms; NEVER = 1e6)",
        "arrival_p50": "Arrival time, median across members (hours since time_origin_ms; NEVER = 1e6)",
        "arrival_p90": "Arrival time, 90th percentile across members (hours since time_origin_ms; NEVER = 1e6)",
        "burn_probability": "Fraction of members burned by start + horizon",
        "flame_length_p50": "Median flame length over members that burned the pixel",
    }
    units = {"arrival_p10": "h", "arrival_p50": "h", "arrival_p90": "h", "burn_probability": "fraction", "flame_length_p50": "m"}
    for name, arr in fx_layers.items():
        fx["layers"][name] = bundle.write_layer(tmp, name, arr, "fire", units[name], desc[name], rel_dir=fdir, register=False)
    fx["issued_ms"] = int(built if sc.mode == "historical" else now_ + 4 * 60000)
    validate_strict(ForecastManifest, fx)
    bundle.write_json(tmp / fdir / "forecast.json", fx, indent=True)

    ign_x, ign_z = fire.pixel_center_local(*truth.ign_rc)
    ign_lon, ign_lat = fire.local_to_lonlat(ign_x, ign_z)
    burned = observed < NEVER
    X, Z = fire.cell_centers_local()
    cx, cz = float(X[burned].mean()), float(Z[burned].mean())
    dvec = np.array([cx - ign_x, cz - ign_z])
    dvec /= np.linalg.norm(dvec) + 1e-9
    proj = (X[burned] - ign_x) * dvec[0] + (Z[burned] - ign_z) * dvec[1]
    far = int(np.argmax(proj))
    profile = [[round(ign_x, 1), round(ign_z, 1)], [round(float(X[burned][far]), 1), round(float(Z[burned][far]), 1)]]
    det_24h = sum(1 for d in detections if d["t_ms"] > now_ - DAY_MS and d["instrument"] != "GOES") if sc.mode == "live" else None
    summary = {
        "id": sc.id, "name": sc.name, "mode": sc.mode, "year": datetime.fromtimestamp(sc.started_ms / 1000, tz=timezone.utc).year,
        "calfire_uid": sc.calfire_uid, "started_ms": sc.started_ms, "updated_ms": int(now_ if sc.mode == "live" else contained_ms),
        "contained_ms": contained_ms, "acres": round(final_acres, 1), "percent_contained": sc.percent_contained,
        "is_active": sc.mode == "live", "county": sc.county, "location": sc.location, "admin_unit": sc.admin_unit, "url": None,
        "lat": round(ign_lat, 6), "lon": round(ign_lon, 6), "detections_24h": det_24h, "bundle_status": "ready", "bundle_built_ms": built,
        **sc.summary_extra,
    }
    sources = [
        ("Terrain (synthetic)", "Ridged-fBm DEM with a carved river valley, 1024² render grid"),
        ("Fuels & canopy (synthetic)", f"FBFM40 by elevation/aspect/slope ({sc.fuels_edition}-like), canopy cover/height"),
        ("Imagery (synthetic)", "Procedural NAIP-like aerial photo, 2048 px"),
        ("Fire observations (synthetic)", "VIIRS/MODIS/GOES/Landsat detections and 12-hourly perimeters sampled from a synthetic arrival field"),
        ("Weather (synthetic)", weather["source"]),
    ]

    def finish(mf: dict) -> dict:
        mf.update({
            "schema_version": 1, "id": sc.id, "name": sc.name, "mode": sc.mode, "status": "ready", "summary": summary,
            "time_origin_ms": int(origin), "time_range": {"start_ms": int(start_), "end_ms": int(end_), "now_ms": int(now_)},
            "grid": manifest_grid(render, fire, float(terr.dem.min()), float(terr.dem.max())),
            "ignition": {"x": round(ign_x, 1), "z": round(ign_z, 1), "lat": round(ign_lat, 6), "lon": round(ign_lon, 6), "t_ms": sc.started_ms,
                         "source": f"{sc.issuer} incident point (fixture)"},
            "default_profile_path": profile, "fuels_edition": sc.fuels_edition,
            "data_sources": [{"name": n, "detail": d, "fetched_ms": built} for n, d in sources],
            "stats": {"final_acres_observed": round(final_acres, 1), "detections": len(detections), "perimeters": len(perimeters)},
            "forecasts": [{"run_id": fx["run_id"], "status": "ready", "issued_ms": fx["issued_ms"], "start_ms": fx["start_ms"],
                           "horizon_h": fx["horizon_h"], "ensemble": ensemble, "members": members, "file": f"{fdir}/forecast.json"}],
            "warnings": ["Synthetic fixture bundle generated by scripts/make_fixture.py: not real data."]
            + ([] if sc.mode == "historical" else ["burn_severity unavailable: no post-fire Sentinel-2 scene yet (fixture)."]),
            "built_ms": built,
        })
        order = list(IncidentManifest.model_fields)
        return {k: mf[k] for k in order}

    manifest = bundle.update_manifest(tmp, finish)
    validate_strict(IncidentManifest, manifest)
    for name, model in (("detections.json", DetectionsFile), ("perimeters.json", PerimetersFile), ("timeseries.json", TimeseriesFile),
                        ("events.json", EventsFile), ("weather.json", WeatherFile)):
        validate_strict(model, (tmp / name).read_bytes())
    (tmp / bundle.LOCK_NAME).unlink(missing_ok=True)

    final = inc / sc.id
    old = inc / f".{sc.id}.old-{built}"
    if final.exists():
        final.rename(old)
    tmp.rename(final)
    if old.exists():
        shutil.rmtree(old)

    n_by = {}
    for d in detections:
        n_by[d["instrument"]] = n_by.get(d["instrument"], 0) + 1
    info = {
        "id": sc.id, "acres": round(final_acres), "detections": n_by, "perimeters": len(perimeters), "events": [e["type"] for e in events],
        "trees": int(len(trees)), "hours": len(ts["t_ms"]), "weather_hours": len(weather["t_ms"]),
        "forecast_p50_final_acres": fx["series"]["area_acres_p50"][-1], "skill": fx.get("skill"), "seconds": round(time.time() - t_start, 1),
    }
    print(f"[{sc.id}] {info}", flush=True)
    if quicklook is not None:
        write_quicklooks(quicklook, sc.id, terr, svf, fu, observed, fx_layers, naip)
    return info


def write_quicklooks(out: Path, name: str, terr: Terrain, svf: np.ndarray, fu: Fuels, arrival: np.ndarray, fx: dict[str, np.ndarray], naip: bytes) -> None:
    """Small PNGs for eyeballing (not part of the bundle)."""
    out.mkdir(parents=True, exist_ok=True)

    def hillshade(z: np.ndarray, res: float) -> np.ndarray:
        gy, gx = np.gradient(z, res)
        return np.clip((-gx * 0.6 + gy * 0.6 + 1) / np.sqrt(gx * gx + gy * gy + 1) * 0.75, 0, 1)

    def save(a: np.ndarray, fname: str, nearest: bool = False) -> None:
        im = Image.fromarray(a.astype(np.uint8))
        im.resize((512, 512), Image.NEAREST if nearest else Image.BILINEAR).save(out / f"{name}-{fname}.png")

    save(hillshade(terr.dem, 12.0) * 255, "hillshade")
    save(np.clip(svf, 0, 1) * 255, "skyview")
    pal = np.array([[150, 110, 60], [120, 80, 40], [200, 190, 90], [235, 220, 120], [60, 140, 80], [30, 90, 60],
                    [90, 170, 120], [140, 140, 140], [200, 200, 210], [60, 120, 220]], np.uint8)
    save(pal[fu.cls], "fuels", True)
    hs = hillshade(fu.elev, 30.0)[..., None] * np.array([110, 110, 110])
    a = np.where(arrival < NEVER, arrival, np.nan)
    t = (a - np.nanmin(a)) / (np.nanmax(a) - np.nanmin(a) + 1e-9)
    col = np.stack([255 * np.ones_like(t), 60 + 180 * (1 - t), 40 * np.ones_like(t)], -1)
    save(np.where(np.isnan(t)[..., None], hs, col), "arrival", True)
    p = fx["burn_probability"][..., None]
    save(hs * (1 - p) + p * np.array([255, 170, 60]), "burnprob", True)
    Image.open(io.BytesIO(naip)).save(out / f"{name}-naip.jpg", quality=90)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data-dir", type=Path, default=None, help="data dir (default: FIRE3D_DATA_DIR or <repo>/data)")
    ap.add_argument("--only", choices=("demo", "live", "east"), default=None,
                    help="one fixture; the default run writes demo + live (east only with --only east)")
    ap.add_argument("--members", type=int, default=31)
    ap.add_argument("--quicklook", type=Path, default=None, help="also write quick-look PNGs to this directory")
    args = ap.parse_args(argv)
    data_dir = (args.data_dir or config.DATA_DIR).resolve()
    scenarios = []
    if args.only in (None, "demo"):
        scenarios.append(demo_scenario())
    if args.only in (None, "live"):
        scenarios.append(live_scenario())
    if args.only == "east":
        scenarios.append(east_scenario())
    for sc in scenarios:
        build_fixture(sc, data_dir, args.members, args.quicklook)
    print(f"fixtures written to {data_dir / 'incidents'} and validated against fire3d.contracts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
