"""LANDFIRE fuels, canopy and vegetation (SPEC 2, 8.2). Owner: terrain agent.

* :func:`fetch_landfire` (contract) returns raw int16 rasters on a grid (nearest neighbour, server-side
  reprojection from EPSG:5070). Raw units: FBFM40 code, CC percent, CH/CBH metres x 10, CBD kg/m³ x 100;
  nodata is -9999. :func:`fetch_landfire_info` adds provenance and the live seasonal FBFM40 option.
* :func:`scale_landfire` applies SPEC 8.2: nodata/negative -> non-burnable 99 for the simulation fuel model
  (``fuel.bin`` keeps 0 = nodata), 0 for canopy; CH/CBH / 10, CBD / 100, CC / 100.
* Vegetation for rendering trees (optional layers): EVT physiognomy from LANDFIRE's EVT attribute CSV (conifer vs
  hardwood vs shrubland) and EVC lifeform-coded cover (1xx tree, 2xx shrub, 3xx herb -> shrub cover).
"""

from __future__ import annotations

import csv
import io
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np

from .. import http
from ..grid import Grid
from .terrain import FetchInfo, RasterFetchError, export_params, fetch_export, read_geotiff

log = logging.getLogger(__name__)

LF_SERVICES = "https://lfps.usgs.gov/arcgis/rest/services"
# Codes are stable across editions; LANDFIRE publishes no LF2024 CSV at the matching path (404), so LF2025's
# table serves both editions (unknown codes simply fall back to the FBFM40 tree rule).
EVT_CSV_URL = "https://landfire.gov/sites/default/files/CSV/LF2025/LF2025_EVT.csv"
EDITIONS = ("LF2024", "LF2025")
CORE_LAYERS = ("FBFM40", "CC", "CH", "CBH", "CBD")
VEG_LAYERS = ("EVT", "EVC")
NODATA = -9999
LF_TIMEOUT_S = 120.0
LF_RETRIES = 3

# Live incidents may use LANDFIRE's seasonal FBFM40 (LF2025 Seasonal Fuels 2026, services SP26/ES26/SU26/FA26):
# month -> product code (spring, early summer, summer, fall). Outside these months the base LF2025 FBFM40 is used.
SEASONAL_FBFM40_YEAR = 2026
SEASONAL_FBFM40_BY_MONTH = {3: "SP26", 4: "SP26", 5: "SP26", 6: "ES26", 7: "SU26", 8: "SU26", 9: "FA26", 10: "FA26", 11: "FA26"}

# Valid FBFM40 codes (Scott & Burgan 2005 + non-burnable 91-99).
FBFM40_CODES = frozenset(
    [91, 92, 93, 98, 99]
    + list(range(101, 110)) + list(range(121, 125)) + list(range(141, 150))
    + list(range(161, 166)) + list(range(181, 190)) + list(range(201, 205))
)
NONBURNABLE_FILL = 99


def edition_for(mode: str) -> str:
    """LANDFIRE edition per SPEC 8.2: LF2024 (pre-2025-fire fuels) for historical, LF2025 for live."""
    return "LF2025" if mode == "live" else "LF2024"


def seasonal_fbfm40(ms: int | None) -> str | None:
    """Seasonal FBFM40 product (e.g. "FA26") for a live incident at time ``ms``, or None outside 2026 seasons."""
    if ms is None:
        return None
    d = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
    if d.year != SEASONAL_FBFM40_YEAR:
        return None
    return SEASONAL_FBFM40_BY_MONTH.get(d.month)


def service_url(edition: str, layer: str, seasonal: str | None = None) -> str:
    """exportImage URL of a LANDFIRE layer (``seasonal`` only applies to FBFM40 of LF2025)."""
    if edition not in EDITIONS:
        raise ValueError(f"unknown LANDFIRE edition {edition!r}")
    if seasonal and layer == "FBFM40":
        return f"{LF_SERVICES}/Landfire_LF2025_Seasonal_Fuels_{SEASONAL_FBFM40_YEAR}/LF2025_FBFM40_{seasonal}/ImageServer/exportImage"
    return f"{LF_SERVICES}/Landfire_{edition}/{edition}_{layer}_CONUS/ImageServer/exportImage"


def layer_params(grid: Grid) -> dict:
    return export_params(grid, "tiff", interpolation="RSP_NearestNeighbor", renderingRule='{"rasterFunction":"None"}')


def fetch_layer(grid: Grid, edition: str, layer: str, seasonal: str | None = None) -> tuple[np.ndarray, FetchInfo]:
    """One raw LANDFIRE layer on ``grid`` as int16 (nodata -9999) plus provenance."""
    what = f"LANDFIRE {edition} {layer}" + (f" ({seasonal})" if seasonal and layer == "FBFM40" else "")
    content, info = fetch_export(service_url(edition, layer, seasonal), layer_params(grid), kind="tiff", what=what,
                                 timeout=LF_TIMEOUT_S, retries=LF_RETRIES)
    arr, nodata = read_geotiff(content, grid, what=what)
    a = arr[0]
    if a.dtype.kind not in "iu":
        raise RasterFetchError(f"{what}: expected integer codes, got {a.dtype}")
    out = np.clip(a.astype(np.int64), -32768, 32767).astype(np.int16)
    if nodata is not None and np.isfinite(nodata) and nodata != NODATA:
        out[a == nodata] = NODATA
    if layer == "FBFM40":
        valid = np.isin(out, list(FBFM40_CODES))
        if valid.mean() < 0.005:
            raise RasterFetchError(f"{what}: no fuel codes in the AOI (outside LANDFIRE CONUS coverage?)")
    return out, info


def fetch_landfire_info(
    grid: Grid, edition: str, layers: tuple[str, ...] = CORE_LAYERS, seasonal: str | None = None,
) -> tuple[dict[str, np.ndarray], dict[str, FetchInfo], list[str]]:
    """Like :func:`fetch_landfire` plus provenance per layer and notes. With ``seasonal`` (live), FBFM40 comes
    from the seasonal product, falling back to the edition's base FBFM40 (noted) if that fails."""
    notes: list[str] = []

    def one(name: str) -> tuple[np.ndarray, FetchInfo]:
        if name == "FBFM40" and seasonal:
            try:
                return fetch_layer(grid, edition, name, seasonal)
            except RasterFetchError as e:
                notes.append(f"seasonal FBFM40 {seasonal} unavailable ({e}); used base {edition} FBFM40")
        return fetch_layer(grid, edition, name)

    with ThreadPoolExecutor(max_workers=min(4, max(1, len(layers))), thread_name_prefix="landfire") as pool:
        futs = {name: pool.submit(one, name) for name in layers}
        res = {name: f.result() for name, f in futs.items()}
    return {k: v[0] for k, v in res.items()}, {k: v[1] for k, v in res.items()}, notes


def fetch_landfire(grid: Grid, edition: str, layers: tuple[str, ...] = ("FBFM40", "CC", "CH", "CBH", "CBD", "EVT")) -> dict[str, np.ndarray]:
    """LANDFIRE ``layers`` of ``edition`` ("LF2024" | "LF2025") on ``grid`` (nearest neighbour), raw int16
    arrays keyed by layer name (CH/CBH are m x 10, CBD kg/m³ x 100, CC percent)."""
    return fetch_landfire_info(grid, edition, tuple(layers))[0]


# ----------------------------------------------------------------------------------------------------------------
# Scaling (SPEC 8.2)
# ----------------------------------------------------------------------------------------------------------------
@dataclass
class Fuels:
    """LANDFIRE fuels/canopy on the fire grid, in model units."""

    fuel_code: np.ndarray       # uint8 FBFM40 code, 0 = nodata (fuel.bin)
    fuel_model: np.ndarray      # int16 FBFM40 code, nodata -> 99 non-burnable (sim/static.npz)
    cc_pct: np.ndarray          # uint8 canopy cover percent (canopy_cover.bin)
    cc_frac: np.ndarray         # float32 0-1
    ch_m: np.ndarray            # float32 canopy height, m
    cbh_m: np.ndarray           # float32 canopy base height, m
    cbd_kg_m3: np.ndarray       # float32 canopy bulk density, kg/m³
    nodata_cells: int           # fuel cells without a valid FBFM40 code
    fixes: dict[str, int]       # canopy consistency fixes applied (counts)


def _nonneg(raw: np.ndarray, scale: float) -> np.ndarray:
    a = np.asarray(raw).astype(np.float32)
    return np.where(a > 0, a * np.float32(scale), np.float32(0.0)).astype(np.float32)


def scale_landfire(raw: dict[str, np.ndarray]) -> Fuels:
    """Raw int16 LANDFIRE rasters -> :class:`Fuels` (SPEC 8.2 scaling and nodata rules).

    Canopy consistency for the crown-fire model: canopy exists where CC > 0; elsewhere CH/CBH/CBD are 0, and
    CBH never exceeds CH.
    """
    f = np.asarray(raw["FBFM40"]).astype(np.int32)
    valid = np.isin(f, list(FBFM40_CODES))
    fuel_code = np.where(valid, f, 0).astype(np.uint8)
    fuel_model = np.where(valid, f, NONBURNABLE_FILL).astype(np.int16)
    shape = f.shape
    zeros = np.zeros(shape, np.int16)
    cc = np.clip(np.asarray(raw.get("CC", zeros)).astype(np.int32), 0, 100)       # nodata/negative -> 0
    ch = _nonneg(raw.get("CH", zeros), 0.1)
    cbh = _nonneg(raw.get("CBH", zeros), 0.1)
    cbd = _nonneg(raw.get("CBD", zeros), 0.01)
    has_canopy = cc > 0
    fixes = {
        "canopy_attrs_without_cover": int(((ch > 0) | (cbh > 0) | (cbd > 0))[~has_canopy].sum()),
        "cbh_above_ch": int(((cbh > ch) & (ch > 0) & has_canopy).sum()),
    }
    ch = np.where(has_canopy, ch, 0.0).astype(np.float32)
    cbh = np.where(has_canopy, np.where(ch > 0, np.minimum(cbh, ch), cbh), 0.0).astype(np.float32)
    cbd = np.where(has_canopy, cbd, 0.0).astype(np.float32)
    return Fuels(
        fuel_code=fuel_code,
        fuel_model=fuel_model,
        cc_pct=cc.astype(np.uint8),
        cc_frac=(cc.astype(np.float32) / 100.0).astype(np.float32),
        ch_m=ch,
        cbh_m=cbh,
        cbd_kg_m3=cbd,
        nodata_cells=int((~valid).sum()),
        fixes=fixes,
    )


def fuel_histogram(fuel_code: np.ndarray) -> dict[int, int]:
    """{code: cells}, most common first."""
    u, c = np.unique(np.asarray(fuel_code), return_counts=True)
    order = np.argsort(-c)
    return {int(u[i]): int(c[i]) for i in order}


# ----------------------------------------------------------------------------------------------------------------
# Vegetation for rendering (optional): EVT physiognomy -> tree kind, EVC lifeform cover -> shrub cover
# ----------------------------------------------------------------------------------------------------------------
LIFEFORM_NONE, LIFEFORM_TREE, LIFEFORM_SHRUB, LIFEFORM_HERB = 0, 1, 2, 3
EVT_KIND_UNKNOWN, EVT_KIND_CONIFER, EVT_KIND_BROADLEAF, EVT_KIND_SHRUB, EVT_KIND_MIXED = -1, 0, 1, 2, 3
EVT_PHYS_KIND = {               # EVT_PHYS -> tree kind used for rendering (see build.aoi.generate_trees)
    "conifer": EVT_KIND_CONIFER,
    "hardwood": EVT_KIND_BROADLEAF,
    "conifer-hardwood": EVT_KIND_MIXED,
    "riparian": EVT_KIND_BROADLEAF,           # willow, cottonwood, sycamore, alder
    "exotic tree-shrub": EVT_KIND_BROADLEAF,  # eucalyptus, tamarisk ...
    "agricultural": EVT_KIND_BROADLEAF,       # orchards / vineyards
    "shrubland": EVT_KIND_SHRUB,
}


def fetch_evt_physiognomy() -> tuple[dict[int, tuple[str, str]], FetchInfo]:
    """EVT code -> (EVT_PHYS, EVT_LF) from LANDFIRE's EVT attribute CSV (cached 180 days)."""
    t0 = time.monotonic()
    try:
        resp = http.request("GET", EVT_CSV_URL, ttl_s=180 * 86400.0, timeout=120.0, retries=2)
    except http.HttpError as e:
        raise RasterFetchError(f"LANDFIRE EVT attribute table: {e}") from None
    text = resp.content.decode("utf-8-sig", errors="replace")
    table: dict[int, tuple[str, str]] = {}
    for row in csv.DictReader(io.StringIO(text)):
        r = {str(k).strip().upper(): (v or "").strip() for k, v in row.items() if k is not None}
        try:
            code = int(float(r.get("VALUE", "")))
        except ValueError:
            continue
        table[code] = (r.get("EVT_PHYS", ""), r.get("EVT_LF", ""))
    if len(table) < 100:
        raise RasterFetchError(f"LANDFIRE EVT attribute table: only {len(table)} rows parsed")
    return table, FetchInfo(resp.url, resp.fetched_ms, resp.from_cache, time.monotonic() - t0)


def evt_tree_kind(evt: np.ndarray, table: dict[int, tuple[str, str]]) -> np.ndarray:
    """Per-cell render kind from EVT physiognomy: int8 -1 unknown, 0 conifer, 1 broadleaf, 2 shrub, 3 mixed.
    Developed classes count as broadleaf (urban trees); grass, sparse, water, snow and nodata stay unknown."""
    codes = np.asarray(evt).astype(np.int32)
    u, inv = np.unique(codes, return_inverse=True)
    lut = np.full(len(u), EVT_KIND_UNKNOWN, np.int8)
    for i, code in enumerate(u):
        phys = table.get(int(code), ("", ""))[0].strip().lower()
        if phys.startswith("developed"):
            lut[i] = EVT_KIND_BROADLEAF
        else:
            lut[i] = EVT_PHYS_KIND.get(phys, EVT_KIND_UNKNOWN)
    return lut[inv].reshape(codes.shape)


def lifeform_value(code: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Split an EVC/EVH code raster into (lifeform uint8: 0 none, 1 tree, 2 shrub, 3 herb, value int16) where
    value = code - 100 * lifeform (EVC: cover %, EVH: tree m or shrub/herb dm)."""
    c = np.asarray(code).astype(np.int32)
    life = np.where((c >= 101) & (c <= 399), c // 100, 0).astype(np.uint8)
    val = np.where(life > 0, c - 100 * life.astype(np.int32), 0).astype(np.int16)
    return life, val


def evc_shrub_cover(evc: np.ndarray) -> np.ndarray:
    """Shrub cover fraction 0-1 from EVC (shrub-lifeform cells only; 0 elsewhere)."""
    life, val = lifeform_value(evc)
    return np.where(life == LIFEFORM_SHRUB, np.clip(val, 0, 100) / 100.0, 0.0).astype(np.float32)
