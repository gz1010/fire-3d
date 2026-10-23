"""NASA FIRMS active-fire detections (SPEC 2, 8.3). Owner: firedata agent.

Every loader returns a pandas DataFrame with exactly :data:`FIRMS_COLUMNS`, one row per detection:

=============  ========  =====================================================================================
column         dtype     meaning
=============  ========  =====================================================================================
``t_ms``       int64     acquisition time, epoch ms UTC (``acq_date`` + ``acq_time.zfill(4)``; "949" = 09:49)
``lat``        float64   degrees
``lon``        float64   degrees
``frp``        float64   fire radiative power, MW (NaN when the product has none: LANDSAT)
``satellite``  str       "N" (Suomi NPP), "N20", "N21", "Terra", "Aqua", "G16", "G17", "G18", "G19", "L8", "L9"
``instrument`` str       "VIIRS" | "MODIS" | "GOES" | "LANDSAT"
``confidence`` str       VIIRS "l"/"n"/"h"; MODIS "0".."100"; LANDSAT "l"/"m"/"h"; GOES "0".."100" (see below)
``daynight``   str       "D" | "N" (GOES: recomputed from the solar elevation, FIRMS marks every GOES row "D")
``scan``       float64   pixel size along scan, km (VIIRS ~0.32-0.8, MODIS 1-4.8; GOES 2.0 and LANDSAT 0.03 assumed)
``track``      float64   pixel size along track, km (same conventions)
``type``       int64     0 vegetation, 2 static land source, 3 offshore; -1 = not reported by this product
``source``     str       FIRMS product id: "VIIRS_SNPP_SP", "VIIRS_NOAA20_NRT", "MODIS_SP", "GOES_NRT", ...
=============  ========  =====================================================================================

Filters applied here: ``type == 1`` (volcano) is dropped (real fire pixels can be type 2/3), and the GOES
``G18FRP``-style rows are dropped (a second FIRMS GOES stream with integer confidence; the kept rows are the regular
``G16``/``G18``/``G19`` ones). Confidence thresholds (SPEC 8.3) are NOT applied: use :func:`quality_mask`.

GOES confidence: FIRMS' regular GOES rows carry the ABI FDC fire-mask category ("10.0000" processed fire pixel,
"30.0000" the same after temporal filtering, i.e. *both are the best category*; 11/31 saturated, 12/32 cloud
contaminated, 13/33 high, 14/34 medium, 15/35 low probability). It is mapped to a nominal percentage with
:data:`GOES_MASK_CONFIDENCE` (processed/saturated 100, high 80, cloudy 60, medium 40, low 20) so that the SPEC rule
"drop GOES confidence < 50" keeps processed, saturated, high-probability and cloud-contaminated pixels.

Network: everything goes through :mod:`fire3d.http` (the area API is rate limited there; cache hits are free).
The MAP_KEY only ever appears inside request URLs; messages are passed through ``config.mask_secrets``.
DataFrames returned by :func:`detections_for` / :func:`fetch_area` / :func:`load_live_us` carry
``df.attrs["sources"]`` (what was fetched, how) and ``df.attrs["warnings"]``.

Brief 3 (CONTRACT 14.12.1): the keyless loaders are national. :func:`load_live_us` and :func:`load_year_us` keep the
lower-48 box with a 0.5-degree margin (:data:`L48_FIRMS_BOX`; border fires keep their Canadian and Mexican
detections; Hawaii and Alaska rows are dropped); the yearly archive is cached as ``firms_us_{year}.parquet`` (sorted
by longitude) and read with pyarrow ``filters=`` on lon/lat.
"""

from __future__ import annotations

import io
import logging
import math
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np
import pandas as pd

from .. import config
from .. import http as fhttp
from ..timeutil import DAY_MS, HOUR_MS, now_ms
from .calfire import evict_http_cache

log = logging.getLogger(__name__)

FIRMS_COLUMNS = ("t_ms", "lat", "lon", "frp", "satellite", "instrument", "confidence", "daynight", "scan", "track", "type", "source")

FIRMS_HOST = "https://firms.modaps.eosdis.nasa.gov"
AREA_URL = FIRMS_HOST + "/api/area/csv/{key}/{source}/{bbox}/{days}/{date}"
AVAILABILITY_URL = FIRMS_HOST + "/api/data_availability/csv/{key}/ALL"
MAPKEY_STATUS_URL = FIRMS_HOST + "/mapserver/mapkey_status/"
LIVE_FEED_URL = FIRMS_HOST + "/data/active_fire/{dir}/csv/{prefix}_USA_contiguous_and_Hawaii_{window}.csv"
YEARLY_URL = FIRMS_HOST + "/data/country/{product}/{year}/{product}_{year}_United_States.csv"

TTL_IMMUTABLE_S = 30 * 86400.0       # SP and past-dated responses
TTL_RECENT_NRT_S = 15 * 60.0         # NRT responses touching the last 48 h
TTL_UNCERTAIN_S = 86400.0            # SP chunks when the availability is unknown (data may still be processed)
TTL_AVAILABILITY_S = 86400.0         # /api/data_availability: once per day
TTL_LIVE_FEED_S = 10 * 60.0          # keyless 24h/48h/7d CSV feeds
RECENT_WINDOW_MS = 48 * HOUR_MS
MAX_WORKERS = 4                      # fire3d.http allows 4 requests in flight
REQUEST_TIMEOUT_S = 90.0
GOES_TIMEOUT_S = 180.0               # archived GOES queries are slow server-side
GOES_ARCHIVE_AGE_MS = 30 * DAY_MS    # GOES days older than this: 1-day requests (~5 s each vs 30-65 s for 2 days)

GOES_FOOTPRINT_KM = 2.0              # SPEC 2: GOES scan/track are not km; assume a 2 km pixel
LANDSAT_FOOTPRINT_KM = 0.03
NOMINAL_PIXEL_KM = {"VIIRS": 0.375, "MODIS": 1.0, "GOES": GOES_FOOTPRINT_KM, "LANDSAT": LANDSAT_FOOTPRINT_KM}

# ABI FDC fire-mask category -> nominal confidence % (see module doc). Temporally filtered codes (30-35) = same class.
GOES_MASK_CONFIDENCE = {10: 100, 11: 100, 12: 60, 13: 80, 14: 40, 15: 20, 30: 100, 31: 100, 32: 60, 33: 80, 34: 40, 35: 20}
# SPEC 8.3 confidence filters, used by quality_mask()
MIN_CONFIDENCE = {"MODIS": 30, "GOES": 50}
VIIRS_DROP_CONFIDENCE = {"l"}


class FirmsError(RuntimeError):
    """A FIRMS request failed or returned something that is not a detections CSV (message is secret-free)."""

    def __init__(self, message: str):
        super().__init__(config.mask_secrets(message))


class FirmsKeyMissing(FirmsError):
    """No FIRMS_MAP_KEY configured: the area API is unavailable (use the keyless loaders)."""


@dataclass(frozen=True)
class SourceInfo:
    id: str
    instrument: str          # VIIRS | MODIS | GOES | LANDSAT
    family: str              # SNPP | NOAA20 | NOAA21 | MODIS | GOES | LANDSAT
    kind: str                # SP | NRT
    max_days: int            # DAY_RANGE limit of the area API
    satellite: str           # default satellite code when a row has none


SOURCES: dict[str, SourceInfo] = {s.id: s for s in (
    SourceInfo("VIIRS_SNPP_SP", "VIIRS", "SNPP", "SP", 5, "N"),
    SourceInfo("VIIRS_NOAA20_SP", "VIIRS", "NOAA20", "SP", 5, "N20"),
    SourceInfo("VIIRS_NOAA21_SP", "VIIRS", "NOAA21", "SP", 5, "N21"),
    SourceInfo("MODIS_SP", "MODIS", "MODIS", "SP", 5, ""),
    SourceInfo("VIIRS_SNPP_NRT", "VIIRS", "SNPP", "NRT", 5, "N"),
    SourceInfo("VIIRS_NOAA20_NRT", "VIIRS", "NOAA20", "NRT", 5, "N20"),
    SourceInfo("VIIRS_NOAA21_NRT", "VIIRS", "NOAA21", "NRT", 5, "N21"),
    SourceInfo("MODIS_NRT", "MODIS", "MODIS", "NRT", 5, ""),
    SourceInfo("GOES_NRT", "GOES", "GOES", "NRT", 2, ""),
    SourceInfo("LANDSAT_NRT", "LANDSAT", "LANDSAT", "NRT", 5, ""),
)}
POLAR_FAMILIES = ("SNPP", "NOAA20", "NOAA21", "MODIS")       # have SP (archive) + NRT products
FAMILY_SOURCES = {f: (f"VIIRS_{f}_SP" if f != "MODIS" else "MODIS_SP", f"VIIRS_{f}_NRT" if f != "MODIS" else "MODIS_NRT") for f in POLAR_FAMILIES}

# Coverage observed on 2026-10-16 (SPEC 2): used only when /api/data_availability cannot be fetched.
# None as the end = "up to today". SP ends move forward over time.
DEFAULT_AVAILABILITY: dict[str, tuple[str, str | None]] = {
    "VIIRS_SNPP_SP": ("2012-01-20", "2026-06-30"), "VIIRS_NOAA20_SP": ("2018-04-01", "2026-06-30"),
    "VIIRS_NOAA21_SP": ("2023-03-01", "2026-06-30"), "MODIS_SP": ("2000-11-01", "2026-07-31"),
    "VIIRS_SNPP_NRT": ("2026-07-01", None), "VIIRS_NOAA20_NRT": ("2026-07-01", None),
    "VIIRS_NOAA21_NRT": ("2024-01-17", None), "MODIS_NRT": ("2026-08-01", None),
    "GOES_NRT": ("2022-08-09", None), "LANDSAT_NRT": ("2022-06-20", None),
}

# Keyless live feeds: (directory, file prefix, FIRMS product id of the rows)
LIVE_FEEDS: tuple[tuple[str, str, str], ...] = (
    ("suomi-npp-viirs-c2", "SUOMI_VIIRS_C2", "VIIRS_SNPP_NRT"),
    ("noaa-20-viirs-c2", "J1_VIIRS_C2", "VIIRS_NOAA20_NRT"),
    ("noaa-21-viirs-c2", "J2_VIIRS_C2", "VIIRS_NOAA21_NRT"),
    ("modis-c6.1", "MODIS_C6_1", "MODIS_NRT"),
)
# Keyless yearly country archives: (product directory, product-id prefix). NOAA-20/21 yearly files do not exist.
YEARLY_PRODUCTS: tuple[tuple[str, str], ...] = (("viirs-snpp", "VIIRS_SNPP"), ("modis", "MODIS"))

_SATELLITE_ALIASES = {
    "T": "Terra", "TERRA": "Terra", "A": "Aqua", "AQUA": "Aqua",
    "N": "N", "NPP": "N", "SNPP": "N", "SUOMI NPP": "N", "SUOMI-NPP": "N",
    "N20": "N20", "1": "N20", "J1": "N20", "NOAA-20": "N20", "NOAA20": "N20",
    "N21": "N21", "2": "N21", "J2": "N21", "NOAA-21": "N21", "NOAA21": "N21",
    "G16": "G16", "G17": "G17", "G18": "G18", "G19": "G19",
    "L8": "L8", "L9": "L9", "LANDSAT-8": "L8", "LANDSAT-9": "L9", "LANDSAT 8": "L8", "LANDSAT 9": "L9",
}
_FAMILY_SATELLITES = {"SNPP": ("N",), "NOAA20": ("N20",), "NOAA21": ("N21",), "MODIS": ("Terra", "Aqua"),
                      "GOES": ("G16", "G17", "G18", "G19"), "LANDSAT": ("L8", "L9")}
_VIIRS_CONF = {"l": "l", "low": "l", "n": "n", "nominal": "n", "h": "h", "high": "h"}
_LANDSAT_CONF = {"l": "l", "low": "l", "m": "m", "medium": "m", "h": "h", "high": "h"}

_year_lock = threading.Lock()


# ------------------------------------------------------------------------------------------------------------------
# Normalisation
# ------------------------------------------------------------------------------------------------------------------
def empty_frame() -> pd.DataFrame:
    """A zero-row DataFrame with the normalised columns and dtypes."""
    return pd.DataFrame({
        "t_ms": pd.Series(dtype="int64"), "lat": pd.Series(dtype="float64"), "lon": pd.Series(dtype="float64"),
        "frp": pd.Series(dtype="float64"), "satellite": pd.Series(dtype="object"), "instrument": pd.Series(dtype="object"),
        "confidence": pd.Series(dtype="object"), "daynight": pd.Series(dtype="object"), "scan": pd.Series(dtype="float64"),
        "track": pd.Series(dtype="float64"), "type": pd.Series(dtype="int64"), "source": pd.Series(dtype="object"),
    })


def solar_elevation_deg(t_ms, lat, lon) -> np.ndarray:
    """Approximate solar elevation (degrees, ~0.1 deg accuracy; NOAA low-precision formulas). Vectorised."""
    n = np.asarray(t_ms, dtype=np.float64) / 86_400_000.0 + 2440587.5 - 2451545.0     # days since J2000.0
    mean_lon = (280.460 + 0.9856474 * n) % 360.0
    g = np.radians((357.528 + 0.9856003 * n) % 360.0)
    ecl_lon = np.radians(mean_lon + 1.915 * np.sin(g) + 0.020 * np.sin(2.0 * g))
    eps = np.radians(23.439 - 4e-7 * n)
    dec = np.arcsin(np.sin(eps) * np.sin(ecl_lon))
    ra = np.arctan2(np.cos(eps) * np.sin(ecl_lon), np.cos(ecl_lon))
    gmst = np.radians((280.46061837 + 360.98564736629 * n) % 360.0)
    ha = gmst + np.radians(np.asarray(lon, dtype=np.float64)) - ra
    la = np.radians(np.asarray(lat, dtype=np.float64))
    return np.degrees(np.arcsin(np.clip(np.sin(la) * np.sin(dec) + np.cos(la) * np.cos(dec) * np.cos(ha), -1.0, 1.0)))


def _source_info(source: str) -> SourceInfo:
    info = SOURCES.get(source)
    if info is not None:
        return info
    s = source.upper()
    inst = next((i for i in ("VIIRS", "MODIS", "GOES", "LANDSAT") if i in s), "VIIRS")
    return SourceInfo(source, inst, inst, "NRT" if "NRT" in s else "SP", 5, "")


def _num(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce")


def normalize_frame(raw: pd.DataFrame, source: str) -> pd.DataFrame:
    """Raw FIRMS CSV rows (area API / live feed / yearly archive, any product) -> :data:`FIRMS_COLUMNS`."""
    if raw is None or len(raw) == 0:
        return empty_frame()
    info = _source_info(source)
    df = raw.rename(columns=lambda c: str(c).strip().lower())
    for col in ("latitude", "longitude", "acq_date", "acq_time"):
        if col not in df.columns:
            raise FirmsError(f"FIRMS {source}: column {col!r} missing (got {list(df.columns)[:12]})")

    def text(col: str) -> pd.Series:
        if col not in df.columns:
            return pd.Series([""] * len(df), index=df.index, dtype="object")
        return df[col].astype(str).str.strip().replace({"nan": "", "None": ""})

    sat_raw = text("satellite")
    keep = ~sat_raw.str.upper().str.endswith("FRP")                  # GOES *FRP duplicate stream
    if "type" in df.columns:
        typ = _num(df["type"]).fillna(-1).astype("int64")
        keep &= typ != 1                                             # volcano
    else:
        typ = pd.Series(-1, index=df.index, dtype="int64")
    lat, lon = _num(df["latitude"]), _num(df["longitude"])
    hhmm = text("acq_time").str.replace(":", "", regex=False).str.split(".").str[0].str.zfill(4)
    t = pd.to_datetime(text("acq_date") + " " + hhmm, format="%Y-%m-%d %H%M", utc=True, errors="coerce")
    keep &= lat.between(-90, 90) & lon.between(-180, 180) & t.notna()
    if not keep.any():
        return empty_frame()
    idx = keep[keep].index
    lat, lon, typ, sat_raw = lat[idx], lon[idx], typ[idx], sat_raw[idx]
    t_ms = t[idx].values.astype("datetime64[ms]").astype("int64")

    inst_col = text("instrument")[idx].str.upper()
    instrument = inst_col.where(inst_col.isin(["VIIRS", "MODIS", "GOES", "LANDSAT"]), info.instrument)
    satellite = sat_raw.str.upper().map(_SATELLITE_ALIASES).fillna(sat_raw)
    satellite = satellite.where(satellite != "", info.satellite)

    frp = _num(df["frp"][idx]) if "frp" in df.columns else pd.Series(np.nan, index=idx)
    frp = frp.where(frp >= 0)                                        # -999 / negative -> NaN

    conf_raw = text("confidence")[idx]
    conf_num = _num(conf_raw)
    confidence = conf_raw.copy()
    is_v, is_m = instrument == "VIIRS", instrument == "MODIS"
    is_g, is_l = instrument == "GOES", instrument == "LANDSAT"
    confidence[is_v] = conf_raw[is_v].str.lower().map(_VIIRS_CONF).fillna(conf_raw[is_v].str.lower())
    confidence[is_l] = conf_raw[is_l].str.lower().map(_LANDSAT_CONF).fillna(conf_raw[is_l].str.lower())
    m_ok = is_m & conf_num.notna()
    confidence[m_ok] = conf_num[m_ok].round().clip(0, 100).astype("int64").astype(str)
    g_ok = is_g & conf_num.notna()
    if g_ok.any():
        codes = conf_num[g_ok].round().astype("int64")
        confidence[g_ok] = codes.map(GOES_MASK_CONFIDENCE).fillna(codes.clip(0, 100)).astype("int64").astype(str)

    nominal = instrument.map(NOMINAL_PIXEL_KM).astype("float64")
    scan = _num(df["scan"][idx]) if "scan" in df.columns else pd.Series(np.nan, index=idx)
    track = _num(df["track"][idx]) if "track" in df.columns else pd.Series(np.nan, index=idx)
    fixed = is_g | is_l                                              # GOES/LANDSAT scan/track are pixel indices
    scan = scan.where(~fixed & (scan > 0) & (scan < 20), nominal)
    track = track.where(~fixed & (track > 0) & (track < 20), nominal)

    dn = text("daynight")[idx].str.upper().str[:1]
    recompute = is_g | ~dn.isin(["D", "N"])
    if recompute.any():
        el = solar_elevation_deg(t_ms[recompute.to_numpy()], lat[recompute].to_numpy(), lon[recompute].to_numpy())
        dn[recompute] = np.where(el > 0.0, "D", "N")

    out = pd.DataFrame({
        "t_ms": t_ms, "lat": lat.to_numpy(dtype="float64"), "lon": lon.to_numpy(dtype="float64"),
        "frp": frp.to_numpy(dtype="float64"), "satellite": satellite.to_numpy(dtype=object),
        "instrument": instrument.to_numpy(dtype=object), "confidence": confidence.to_numpy(dtype=object),
        "daynight": dn.to_numpy(dtype=object), "scan": scan.to_numpy(dtype="float64"),
        "track": track.to_numpy(dtype="float64"), "type": typ.to_numpy(dtype="int64"),
        "source": np.full(len(idx), info.id, dtype=object),
    })
    return out.reset_index(drop=True)


def parse_firms_csv(content: str | bytes, source: str) -> pd.DataFrame:
    """Parse one FIRMS CSV (area API, live feed or yearly archive) and normalise it.

    Raises :class:`FirmsError` when the body is not a detections CSV (FIRMS reports errors such as
    "Invalid MAP_KEY" or "Invalid day range" as plain text)."""
    raw = content.decode("utf-8", errors="replace") if isinstance(content, bytes) else content
    body = raw.lstrip("\ufeff \r\n\t")
    if not body.lower().startswith("latitude"):
        snippet = " ".join(body[:160].split())
        raise FirmsError(f"FIRMS {source}: not a detections CSV: {snippet or '<empty>'}")
    frame = pd.read_csv(io.StringIO(body), dtype=str, keep_default_na=False)
    return normalize_frame(frame, source)


def concat_frames(frames: Iterable[pd.DataFrame]) -> pd.DataFrame:
    """Concatenate normalised frames, drop exact duplicates (same source/time/position), sort by time."""
    parts = [f for f in frames if f is not None and len(f)]
    if not parts:
        return empty_frame()
    df = pd.concat(parts, ignore_index=True)
    df = df.drop_duplicates(subset=["source", "satellite", "t_ms", "lat", "lon"])
    return df.sort_values(["t_ms", "source"], kind="stable").reset_index(drop=True)


def filter_bbox_time(df: pd.DataFrame, bbox: Sequence[float] | None = None, start_ms: int | None = None, end_ms: int | None = None) -> pd.DataFrame:
    """Rows inside ``bbox`` (w, s, e, n; inclusive) and ``start_ms <= t_ms <= end_ms`` (None = unbounded)."""
    if len(df) == 0:
        return df
    m = pd.Series(True, index=df.index)
    if bbox is not None:
        w, s, e, n = (float(v) for v in bbox)
        m &= df["lon"].between(w, e) & df["lat"].between(s, n)
    if start_ms is not None:
        m &= df["t_ms"] >= int(start_ms)
    if end_ms is not None:
        m &= df["t_ms"] <= int(end_ms)
    return df[m].reset_index(drop=True)


def quality_mask(df: pd.DataFrame) -> pd.Series:
    """SPEC 8.3 confidence filter as a boolean mask: drops VIIRS "l", MODIS < 30 and GOES < 50 (GOES confidence is
    the normalised percentage, see module doc). LANDSAT rows are all kept."""
    if len(df) == 0:
        return pd.Series(dtype=bool)
    inst = df["instrument"]
    conf = df["confidence"].astype(str)
    num = pd.to_numeric(conf, errors="coerce")
    bad = (inst == "VIIRS") & conf.str.lower().isin(VIIRS_DROP_CONFIDENCE)
    for name, lo in MIN_CONFIDENCE.items():
        bad |= (inst == name) & (num.isna() | (num < lo))
    return ~bad


def _with_attrs(df: pd.DataFrame, sources: list[dict], warnings: list[str]) -> pd.DataFrame:
    df.attrs["sources"] = sources
    df.attrs["warnings"] = [config.mask_secrets(w) for w in warnings]
    return df


# ------------------------------------------------------------------------------------------------------------------
# Area API (key)
# ------------------------------------------------------------------------------------------------------------------
def _utc_date(ms: int) -> date:
    return datetime.fromtimestamp(int(ms) / 1000.0, tz=timezone.utc).date()


def _date_ms(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp() * 1000)


def format_bbox(bbox: Sequence[float]) -> str:
    """``w,s,e,n`` rounded outward to 0.01 deg (stable cache keys, never smaller than requested)."""
    w, s, e, n = (float(v) for v in bbox)
    if not (w < e and s < n):
        raise ValueError(f"invalid bbox (w, s, e, n): {bbox}")
    f = lambda v: math.floor(v * 100.0 + 1e-9) / 100.0
    c = lambda v: math.ceil(v * 100.0 - 1e-9) / 100.0
    w, s, e, n = max(f(w), -180.0), max(f(s), -90.0), min(c(e), 180.0), min(c(n), 90.0)
    return f"{w:.2f},{s:.2f},{e:.2f},{n:.2f}"


def day_chunks(start_ms: int, end_ms: int, max_days: int) -> list[tuple[str, int]]:
    """Split the UTC days touched by [start_ms, end_ms] into ``(YYYY-MM-DD, DAY_RANGE)`` requests of at most
    ``max_days`` days each (a request covers DAY_RANGE days starting at the date)."""
    if end_ms < start_ms:
        return []
    d, last = _utc_date(start_ms), _utc_date(end_ms)
    out: list[tuple[str, int]] = []
    while d <= last:
        n = min(int(max_days), (last - d).days + 1)
        out.append((d.isoformat(), n))
        d += timedelta(days=n)
    return out


def data_availability(refresh: bool = False) -> dict[str, tuple[date, date]]:
    """``{source: (first_date, last_date)}`` from ``/api/data_availability`` (cached 24 h). ``{}`` without a key or
    when the endpoint fails."""
    key = config.FIRMS_MAP_KEY
    if not key:
        return {}
    url = AVAILABILITY_URL.format(key=key)
    try:
        text = fhttp.get_text(url, ttl_s=1e-6 if refresh else TTL_AVAILABILITY_S, timeout=30.0, retries=2)
    except fhttp.HttpError as e:
        log.warning("FIRMS data_availability unavailable: %s", e)
        return {}
    out: dict[str, tuple[date, date]] = {}
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines or not lines[0].lower().startswith("data_id"):
        evict_http_cache(url)
        log.warning("FIRMS data_availability: unexpected response %r", config.mask_secrets(text[:120]))
        return {}
    for ln in lines[1:]:
        parts = [p.strip() for p in ln.split(",")]
        if len(parts) >= 3:
            try:
                out[parts[0]] = (date.fromisoformat(parts[1]), date.fromisoformat(parts[2]))
            except ValueError:
                continue
    return out


def mapkey_status() -> dict | None:
    """Current MAP_KEY usage (``{transaction_limit, current_transactions, transaction_interval}``), uncached.
    None without a key or on failure. Does not count against the area-API limiter."""
    key = config.FIRMS_MAP_KEY
    if not key:
        return None
    try:
        data = fhttp.get_json(MAPKEY_STATUS_URL, {"MAP_KEY": key}, ttl_s=0, timeout=20.0, retries=1)
    except (fhttp.HttpError, ValueError) as e:
        log.warning("FIRMS mapkey_status unavailable: %s", config.mask_secrets(e))
        return None
    return data if isinstance(data, dict) else None


def _availability_window(source: str, availability: dict[str, tuple[date, date]] | None) -> tuple[int, int | None, bool]:
    """(first_ms, last_ms_exclusive | None, known) for a source. NRT products are open-ended (their reported last
    date is just the newest day at the time of the availability request, which is cached for a day)."""
    nrt = _source_info(source).kind == "NRT"
    if availability and source in availability:
        a, b = availability[source]
        return _date_ms(a), (None if nrt else _date_ms(b) + DAY_MS), True
    first, last = DEFAULT_AVAILABILITY.get(source, ("2000-01-01", None))
    return _date_ms(date.fromisoformat(first)), (_date_ms(date.fromisoformat(last)) + DAY_MS if last and not nrt else None), False


def plan_sources(start_ms: int, end_ms: int, mode: str = "historical", availability: dict[str, tuple[date, date]] | None = None,
                 instruments: Iterable[str] | None = None, families: Iterable[str] | None = None) -> list[tuple[str, int, int]]:
    """Which FIRMS products cover [start_ms, end_ms] (SPEC 8.3): ``[(source, seg_start_ms, seg_end_ms), ...]``.

    Historical: the SP archive of each polar family (VIIRS SNPP/NOAA-20/NOAA-21, MODIS), NRT only after the SP
    coverage ends. Live: the NRT products, SP only for days before the NRT coverage starts. Both: GOES_NRT and
    LANDSAT_NRT. ``instruments`` limits the instruments (e.g. ``("VIIRS",)``), ``families`` the satellites
    (``"SNPP"``, ``"NOAA20"``, ``"NOAA21"``, ``"MODIS"``, ``"GOES"``, ``"LANDSAT"``)."""
    want = {i.upper() for i in instruments} if instruments else {"VIIRS", "MODIS", "GOES", "LANDSAT"}
    fams = {f.upper() for f in families} if families else None
    plan: list[tuple[str, int, int]] = []

    def add(source: str, a: int, b: int) -> None:
        lo, hi, _ = _availability_window(source, availability)
        a2, b2 = max(a, lo), (min(b, hi - 1) if hi is not None else b)
        if a2 <= b2:
            plan.append((source, a2, b2))

    for fam in POLAR_FAMILIES:
        sp, nrt = FAMILY_SOURCES[fam]
        if SOURCES[sp].instrument not in want or (fams is not None and fam not in fams):
            continue
        _, sp_hi, _ = _availability_window(sp, availability)
        nrt_lo, _, _ = _availability_window(nrt, availability)
        if mode == "live":
            add(nrt, start_ms, end_ms)
            if start_ms < nrt_lo:
                add(sp, start_ms, min(end_ms, nrt_lo - 1))
        else:
            add(sp, start_ms, end_ms)
            if sp_hi is not None and end_ms >= sp_hi:
                add(nrt, max(start_ms, sp_hi), end_ms)
    for src in ("GOES_NRT", "LANDSAT_NRT"):
        if SOURCES[src].instrument in want and (fams is None or SOURCES[src].family in fams):
            add(src, start_ms, end_ms)
    return plan


@dataclass(frozen=True)
class _Chunk:
    source: str
    day: str
    days: int
    bbox: str
    ttl_s: float


def _chunk_ttl(info: SourceInfo, day: str, days: int, known: bool, now: int) -> float:
    chunk_end = _date_ms(date.fromisoformat(day)) + days * DAY_MS
    if info.kind == "SP":
        return TTL_IMMUTABLE_S if known else TTL_UNCERTAIN_S
    return TTL_RECENT_NRT_S if chunk_end > now - RECENT_WINDOW_MS else TTL_IMMUTABLE_S


def area_chunks(source: str, bbox: Sequence[float], start_ms: int, end_ms: int, availability: dict[str, tuple[date, date]] | None = None) -> list[_Chunk]:
    """The area-API requests covering [start_ms, end_ms] for one source, clipped to its availability: DAY_RANGE
    chunks of 5 days (GOES_NRT: 2; archived GOES older than 30 days: 1, which FIRMS answers much faster)."""
    info = _source_info(source)
    lo, hi, known = _availability_window(source, availability)
    a, b = max(int(start_ms), lo), (min(int(end_ms), hi - 1) if hi is not None else int(end_ms))
    now = now_ms()
    b = min(b, now + DAY_MS)
    if b < a:
        return []
    box = format_bbox(bbox)
    plan = day_chunks(a, b, info.max_days)        # anchored at the window start: URLs stay stable (cache hits)
    if info.family == "GOES":
        # archived GOES chunks are split into 1-day requests (FIRMS answers those much faster)
        split = _date_ms(_utc_date(now - GOES_ARCHIVE_AGE_MS))
        plan = [piece for d, n in plan for piece in
                ([((date.fromisoformat(d) + timedelta(days=i)).isoformat(), 1) for i in range(n)]
                 if n > 1 and _date_ms(date.fromisoformat(d)) + n * DAY_MS <= split else [(d, n)])]
    return [_Chunk(source, d, n, box, _chunk_ttl(info, d, n, known, now)) for d, n in plan]


def _fetch_chunk(ch: _Chunk) -> pd.DataFrame:
    """One area-API chunk; ``df.attrs["fetched_ms"]`` = when FIRMS served it (older than now for cache hits)."""
    key = config.FIRMS_MAP_KEY
    if not key:
        raise FirmsKeyMissing("FIRMS_MAP_KEY is not set")
    url = AREA_URL.format(key=key, source=ch.source, bbox=ch.bbox, days=ch.days, date=ch.day)
    try:
        timeout = GOES_TIMEOUT_S if ch.source == "GOES_NRT" else REQUEST_TIMEOUT_S
        resp = fhttp.request("GET", url, ttl_s=ch.ttl_s, timeout=timeout, retries=3)
    except fhttp.HttpError as e:
        raise FirmsError(f"FIRMS {ch.source} {ch.day}+{ch.days}d: {e}") from None
    try:
        df = parse_firms_csv(resp.content, ch.source)
    except FirmsError:
        evict_http_cache(url)                    # error text arrived with status 200: never keep it cached
        raise
    df.attrs["fetched_ms"] = int(resp.fetched_ms)
    return df


def _run_chunks(chunks: list[_Chunk], max_workers: int = MAX_WORKERS) -> tuple[list[pd.DataFrame], list[tuple[_Chunk, str]]]:
    """Fetch the chunks (4 at a time); each frame keeps its ``attrs["fetched_ms"]`` and gets ``attrs["chunk"]``."""
    frames: list[pd.DataFrame] = []
    errors: list[tuple[_Chunk, str]] = []
    if not chunks:
        return frames, errors

    def run(ch: _Chunk):
        try:
            return ch, _fetch_chunk(ch), None
        except FirmsError as e:
            return ch, None, str(e)

    if len(chunks) == 1 or max_workers <= 1:
        results = [run(c) for c in chunks]
    else:
        with ThreadPoolExecutor(max_workers=min(max_workers, len(chunks)), thread_name_prefix="firms") as ex:
            results = list(ex.map(run, chunks))
    for ch, df, err in results:
        if err is not None:
            errors.append((ch, err))
        else:
            df.attrs["chunk"] = ch
            frames.append(df)
    return frames, errors


def _fetched_by_source(frames: Iterable[pd.DataFrame]) -> dict[str, int]:
    """Oldest response time per source (``attrs["fetched_ms"]``): the data are at least that current."""
    out: dict[str, int] = {}
    for f in frames:
        ch, t = f.attrs.get("chunk"), f.attrs.get("fetched_ms")
        if ch is not None and t is not None:
            out[ch.source] = min(int(t), out.get(ch.source, int(t)))
    return out


def _summarise(chunks: list[_Chunk], frames_by_source: dict[str, int], errors: list[tuple[_Chunk, str]], via: str,
               fetched_by_source: dict[str, int] | None = None) -> list[dict]:
    """Per-source request summary. ``fetched_ms`` = the oldest response of that source (FIRMS data are at least that
    current; cache hits are older than the call), now when unknown."""
    now = now_ms()
    fetched_by_source = fetched_by_source or {}
    out: list[dict] = []
    for src in dict.fromkeys(c.source for c in chunks):
        cs = [c for c in chunks if c.source == src]
        n_err = sum(1 for c, _ in errors if c.source == src)
        out.append({"source": src, "via": via, "requests": len(cs), "failed": n_err, "rows": int(frames_by_source.get(src, 0)),
                    "first_day": cs[0].day, "last_day": cs[-1].day, "fetched_ms": int(fetched_by_source.get(src, now))})
    return out


def data_times_by_satellite(df: pd.DataFrame | None, kinds: Iterable[str] = ("NRT",)) -> dict[str, int]:
    """When the FIRMS data behind ``df`` were fetched, per satellite code (``"N"``, ``"N20"``, ``"N21"``,
    ``"Terra"``, ``"Aqua"``, ...): the oldest ``fetched_ms`` of that satellite's ``df.attrs["sources"]`` entries of
    the given product ``kinds`` (NRT: the recent days; archive chunks can be old cache hits). A satellite with any
    failed request, or without a source entry, is left out: its detections may be missing, so nothing may be
    concluded from their absence. Detections acquired before this time (minus FIRMS' ingest delay) are in ``df``."""
    want = {k.upper() for k in kinds}
    out: dict[str, int] = {}
    bad: set[str] = set()
    for s in (df.attrs.get("sources") if df is not None else None) or []:
        info = SOURCES.get(str(s.get("source") or ""))
        if info is None or info.kind not in want:
            continue
        sats = _FAMILY_SATELLITES.get(info.family, ())
        if s.get("failed") or not s.get("fetched_ms"):
            bad.update(sats)
            continue
        for sat in sats:
            out[sat] = min(int(s["fetched_ms"]), out.get(sat, int(s["fetched_ms"])))
    return {k: v for k, v in out.items() if k not in bad}


def fetch_area(source: str, bbox: Sequence[float], start_ms: int, end_ms: int, *, availability: dict[str, tuple[date, date]] | None = None,
               max_workers: int = MAX_WORKERS) -> pd.DataFrame:
    """Detections of one FIRMS product over ``bbox`` (w, s, e, n) for [start_ms, end_ms] from the keyed area API,
    in DAY_RANGE chunks (5 days; GOES_NRT 2, or 1 for archived days), cached per chunk (SP/past 30 d, NRT touching
    the last 48 h 15 min).

    Raises :class:`FirmsKeyMissing` without a key and :class:`FirmsError` when every chunk failed; partial failures
    are reported in ``df.attrs["warnings"]``."""
    if source not in SOURCES:
        raise ValueError(f"unknown FIRMS source {source!r} (one of {sorted(SOURCES)})")
    if not config.FIRMS_MAP_KEY:
        raise FirmsKeyMissing("FIRMS_MAP_KEY is not set; use load_live_us / load_year_us")
    if availability is None:
        availability = data_availability()
    chunks = area_chunks(source, bbox, start_ms, end_ms, availability)
    frames, errors = _run_chunks(chunks, max_workers)
    if chunks and len(errors) == len(chunks):
        raise FirmsError(f"FIRMS {source}: all {len(chunks)} requests failed; first error: {errors[0][1]}")
    fetched = _fetched_by_source(frames)
    df = filter_bbox_time(concat_frames(frames), bbox, start_ms, end_ms)
    counts = df["source"].value_counts().to_dict() if len(df) else {}
    return _with_attrs(df, _summarise(chunks, counts, errors, "area_api", fetched), [e for _, e in errors])


# ------------------------------------------------------------------------------------------------------------------
# Keyless loaders
# ------------------------------------------------------------------------------------------------------------------
def _live_window(days: float) -> str:
    return "24h" if days <= 1 else "48h" if days <= 2 else "7d"


# The lower 48 with a 0.5-degree margin (w, s, e, n): Hawaii (lat < 23) and Alaska (lat > 51) fall outside.
L48_FIRMS_BOX: tuple[float, float, float, float] = (-125.4, 23.9, -66.4, 49.9)
YEARLY_ROW_GROUP = 50_000


def load_live_us(days: float = 7, *, refresh: bool = False) -> pd.DataFrame:
    """Lower-48 detections (:data:`L48_FIRMS_BOX`) from the keyless live CSV feeds (Suomi NPP, NOAA-20, NOAA-21
    VIIRS and MODIS "USA_contiguous_and_Hawaii"; one request per feed, cached 10 min): the 24h feed for ``days <= 1``,
    48h for ``<= 2``, else 7d (feeds hold at most 7 days; other ``days`` values are trimmed to the last ``days * 24``
    h). Raises :class:`FirmsError` only when every feed failed."""
    return _load_live(days, L48_FIRMS_BOX, refresh)


LIVE_FEED_TIMEOUT_S = 30.0     # read timeout; the live list's request path must stay under the web's 30 s
LIVE_FEED_CONNECT_S = 5.0
LIVE_FEED_RETRIES = 1
FEEDS_KEY = "firms-feeds"
feeds_down_memo = fhttp.DownMemo("FIRMS live feeds")   # a host that failed is not asked again for 60 s (CONTRACT 14.16)


def _load_live(days: float, bbox: Sequence[float], refresh: bool) -> pd.DataFrame:
    window = _live_window(days)
    frames, sources, warnings = [], [], []
    for dir_, prefix, source in LIVE_FEEDS:
        url = LIVE_FEED_URL.format(dir=dir_, prefix=prefix, window=window)
        try:
            hit = None if refresh else fhttp.peek_cache("GET", url, None, TTL_LIVE_FEED_S)
            if hit is None and feeds_down_memo.down(FEEDS_KEY):
                warnings.append(f"FIRMS live feed {prefix}_{window}: the FIRMS feeds could not be reached a moment ago")
                continue
            try:
                resp = hit or fhttp.request("GET", url, ttl_s=1e-6 if refresh else TTL_LIVE_FEED_S, timeout=LIVE_FEED_TIMEOUT_S,
                                            retries=LIVE_FEED_RETRIES, connect_timeout=LIVE_FEED_CONNECT_S)
            except fhttp.HttpError as e:
                if e.status is None:          # connection error or timeout: the host, not one feed
                    feeds_down_memo.mark(FEEDS_KEY)
                raise
            feeds_down_memo.clear(FEEDS_KEY)
            fetched = int(resp.fetched_ms)
            df = parse_firms_csv(resp.content, source)
        except FirmsError as e:
            evict_http_cache(url)
            warnings.append(str(e))
            continue
        except fhttp.HttpError as e:
            warnings.append(f"FIRMS live feed {prefix}_{window}: {e}")
            continue
        df = filter_bbox_time(df, bbox)
        frames.append(df)
        sources.append({"source": source, "via": f"csv_feed_{window}", "requests": 1, "failed": 0, "rows": int(len(df)), "fetched_ms": fetched})
    if not frames:
        raise FirmsError("all FIRMS live feeds failed: " + "; ".join(warnings))
    df = concat_frames(frames)
    if days not in (1, 2, 7):
        df = filter_bbox_time(df, None, now_ms() - int(days * DAY_MS), None)
    return _with_attrs(df, sources, warnings)


def _yearly_parquet(year: int) -> Path:
    return Path(config.CACHE_DIR) / "firms" / f"firms_us_{int(year)}.parquet"


def _year_frame(path: Path, year: int, bbox: Sequence[float] | None) -> pd.DataFrame:
    """Read the yearly parquet, keeping only ``bbox`` rows (pyarrow ``filters=``: row groups outside are skipped)."""
    filters = None
    if bbox is not None:
        w, s, e, n = (float(v) for v in bbox)
        filters = [("lon", ">=", w), ("lon", "<=", e), ("lat", ">=", s), ("lat", "<=", n)]
    df = pd.read_parquet(path, engine="pyarrow", filters=filters).reset_index(drop=True)
    return _with_attrs(df, [{"source": s_, "via": "yearly_archive", "rows": int(n_), "year": year}
                            for s_, n_ in df["source"].value_counts().items()], [])


def load_year_us(year: int, bbox: tuple | None = None) -> pd.DataFrame:
    """Lower-48 detections of ``year`` from the keyless yearly archives (Suomi NPP VIIRS + MODIS only; SPEC 2),
    optionally only those inside ``bbox`` (w, s, e, n).

    The two national CSVs (~46 MB for 2025) are downloaded once, cut to :data:`L48_FIRMS_BOX`, sorted by longitude
    and cached as ``CACHE_DIR/firms/firms_us_{year}.parquet`` (row groups of 50,000; the raw CSVs are then deleted).
    Reads use pyarrow ``filters=`` on lon/lat, so a fire's bbox never loads the whole year. ``source`` is
    "VIIRS_SNPP_SP" / "MODIS_SP" for standard-processing rows and ``*_NRT`` for rows the archive still holds as NRT.
    Only completed years exist (raises :class:`FirmsError` otherwise, or when the download fails)."""
    year = int(year)
    if year >= _utc_date(now_ms()).year:
        raise FirmsError(f"FIRMS yearly archive {year}: only completed years are published")
    path = _yearly_parquet(year)
    with _year_lock:
        if path.is_file():
            return _year_frame(path, year, bbox)
        raw_dir = path.parent / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)
        frames: list[pd.DataFrame] = []
        downloaded: list[Path] = []
        w, s, e, n = L48_FIRMS_BOX
        for product, prefix in YEARLY_PRODUCTS:
            url = YEARLY_URL.format(product=product, year=year)
            dest = raw_dir / f"{product}_{year}_United_States.csv"
            try:
                fhttp.stream_download(url, dest, timeout=600.0)
            except fhttp.HttpError as e_:
                raise FirmsError(f"FIRMS yearly archive {product} {year} unavailable: {e_}") from None
            downloaded.append(dest)
            t0 = time.time()
            for part in pd.read_csv(dest, dtype=str, keep_default_na=False, chunksize=250_000):
                part = part.rename(columns=lambda c: str(c).strip().lower())
                la, lo = pd.to_numeric(part["latitude"], errors="coerce"), pd.to_numeric(part["longitude"], errors="coerce")
                part = part[la.between(s, n) & lo.between(w, e)]
                if not len(part):
                    continue
                if "version" in part.columns:
                    nrt = part["version"].astype(str).str.upper().str.contains("NRT", regex=False)
                    frames.append(normalize_frame(part[~nrt], f"{prefix}_SP"))
                    frames.append(normalize_frame(part[nrt], f"{prefix}_NRT"))
                else:
                    frames.append(normalize_frame(part, f"{prefix}_SP"))
            log.info("FIRMS yearly %s %d: lower-48 rows parsed in %.1f s", product, year, time.time() - t0)
        df = concat_frames(frames)
        df = df.sort_values(["lon", "t_ms"], kind="stable").reset_index(drop=True)
        tmp = path.with_suffix(".parquet.tmp")
        df.to_parquet(tmp, index=False, engine="pyarrow", row_group_size=YEARLY_ROW_GROUP)
        os.replace(tmp, path)
        for p_ in downloaded:                     # keep data/ small: the parquet holds everything we use
            try:
                p_.unlink()
            except FileNotFoundError:
                pass
    return _year_frame(path, year, bbox)


# ------------------------------------------------------------------------------------------------------------------
# Detections for one fire
# ------------------------------------------------------------------------------------------------------------------
def _keyless(bbox: Sequence[float], start_ms: int, end_ms: int, mode: str, instruments: set[str] | None) -> tuple[list[pd.DataFrame], list[dict], list[str]]:
    """Yearly archive (historical days) and/or the 7d feeds (last 7 days), already cut to bbox + window."""
    frames: list[pd.DataFrame] = []
    sources: list[dict] = []
    warnings: list[str] = []
    now = now_ms()
    live_covered_from = now - 7 * DAY_MS
    want_archive = mode != "live" or start_ms < live_covered_from
    if want_archive:
        for year in range(_utc_date(start_ms).year, _utc_date(min(end_ms, now)).year + 1):
            try:
                df = load_year_us(year, tuple(bbox))
            except FirmsError as e:
                warnings.append(f"keyless yearly archive {year} unavailable ({e})")
                continue
            frames.append(filter_bbox_time(df, bbox, start_ms, end_ms))
            sources += df.attrs.get("sources", [])
    if end_ms >= live_covered_from:
        try:
            df = load_live_us(7)
            frames.append(filter_bbox_time(df, bbox, start_ms, end_ms))
            sources += df.attrs.get("sources", [])
            warnings += df.attrs.get("warnings", [])
        except FirmsError as e:
            warnings.append(str(e))
    if start_ms < live_covered_from and not any(s.get("via") == "yearly_archive" for s in sources):
        warnings.append("keyless FIRMS feeds only cover the last 7 days; earlier detections are missing")
    if instruments:
        frames = [f[f["instrument"].isin(instruments)] for f in frames]
    return frames, sources, warnings


def detections_for(bbox: Sequence[float], start_ms: int, end_ms: int, mode: str = "historical", *,
                   instruments: Iterable[str] | None = None, families: Iterable[str] | None = None,
                   use_key: bool | None = None, max_workers: int = MAX_WORKERS) -> pd.DataFrame:
    """All detections over ``bbox`` (w, s, e, n lon/lat) with ``start_ms <= t_ms <= end_ms`` (SPEC 8.3 step 1).

    With the key: the area API for every product :func:`plan_sources` selects for ``mode`` ("historical": VIIRS
    SNPP/NOAA-20/NOAA-21 SP + MODIS_SP + GOES_NRT + LANDSAT_NRT; "live": the NRT products, SP before NRT coverage),
    chunked and fetched 4 at a time. Without the key, or when every area request fails: the yearly archive
    (historical; SNPP + MODIS) and/or the 7-day feeds (recent days). Normalised columns (module doc); type 1 and GOES
    ``*FRP`` rows dropped, confidence NOT filtered (see :func:`quality_mask`). ``df.attrs["sources"]`` lists what was
    used (``via``: "area_api" | "yearly_archive" | "csv_feed_7d"), ``df.attrs["warnings"]`` any gaps.
    ``instruments`` / ``families`` restrict the products (see :func:`plan_sources`; keyless rows are filtered too)."""
    start_ms, end_ms = int(start_ms), int(end_ms)
    inst = {i.upper() for i in instruments} if instruments else None
    warnings: list[str] = []
    if end_ms < start_ms:
        return _with_attrs(empty_frame(), [], ["empty time window"])
    keyed = bool(config.FIRMS_MAP_KEY) if use_key is None else (use_key and bool(config.FIRMS_MAP_KEY))
    if keyed:
        availability = data_availability()
        if not availability:
            warnings.append("FIRMS data_availability unavailable; using the coverage table from SPEC 2")
        plan = plan_sources(start_ms, end_ms, mode, availability, inst, families)
        chunks = [c for src, a, b in plan for c in area_chunks(src, bbox, a, b, availability)]
        frames, errors = _run_chunks(chunks, max_workers)
        if chunks and len(errors) < len(chunks):
            fetched = _fetched_by_source(frames)
            df = filter_bbox_time(concat_frames(frames), bbox, start_ms, end_ms)
            counts = df["source"].value_counts().to_dict() if len(df) else {}
            warnings += [e for _, e in errors[:10]]
            if len(errors) > 10:
                warnings.append(f"... and {len(errors) - 10} more failed FIRMS requests")
            return _with_attrs(df, _summarise(chunks, counts, errors, "area_api", fetched), warnings)
        if chunks:
            warnings.append(f"FIRMS area API failed for all {len(chunks)} requests ({errors[0][1]}); using the keyless feeds")
        else:
            return _with_attrs(empty_frame(), [], warnings + ["no FIRMS product covers the requested window"])
    elif not config.FIRMS_MAP_KEY:
        warnings.append("no FIRMS_MAP_KEY: keyless feeds only (VIIRS SNPP + MODIS yearly archive, 7-day live feeds)")
    else:
        warnings.append("keyless feeds requested: VIIRS SNPP + MODIS yearly archive, 7-day live feeds")
    frames, sources, more = _keyless(bbox, start_ms, end_ms, mode, inst)
    if families:
        sats = {s for f in families for s in _FAMILY_SATELLITES.get(f.upper(), ())}
        frames = [f[f["satellite"].isin(sats)] for f in frames]
    df = filter_bbox_time(concat_frames(frames), bbox, start_ms, end_ms)
    return _with_attrs(df, sources, warnings + more)
