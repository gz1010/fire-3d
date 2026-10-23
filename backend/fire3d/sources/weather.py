"""Weather sources behind a pluggable interface (SPEC 2, 8.4). Owner: weather agent.

:class:`WeatherSource` is the contract every provider implements; :class:`OpenMeteoSource` is the v1 provider.
A future ``WeatherNext3Source`` (Google WeatherNext 3 with its 64-member ensemble; out of scope until access is
granted, see SPEC 0/11) implements the same protocol and plugs into ``build_weather`` / ``member_weathers`` through
their ``source=`` argument. It is intentionally not implemented here.

Return shapes. All series are hourly UTC on ``t_ms`` = int64 epoch ms from ``floor_hour(start_ms)`` to
``ceil_hour(end_ms)`` inclusive; P = ``len(points)``; points are ``(lat, lon)``; wind direction is the
meteorological FROM direction in degrees clockwise from north; wind in m/s.

``deterministic(points, start_ms, end_ms)`` -> dict
    source            "open-meteo:gfs_hrrr+gfs_seamless" (live), "open-meteo:historical-forecast:gfs_hrrr" (past), ...
    t_ms              (T,) int64
    temp_c, rh_pct, dewpoint_c, wind_speed_ms, wind_dir_deg, wind_gust_ms, precip_mm    (T, P) float64, gap-free
    hrrr              (T,) bool: hours where HRRR itself had values at every point (before any filling)
    forecast_from_ms  first hour that is forecast rather than (re)analysis; None when the window is all past
    fetched_ms, warnings, era5 (bool: ERA5 filled some hours)

Note: Open-Meteo's ``gfs_seamless`` equals ``gfs_hrrr`` wherever HRRR exists, so filling HRRR's null hours
(beyond ~48 h of forecast) with it is seamless up to the model change itself.

``ensemble(points, start_ms, end_ms, model)`` -> dict, or None when the model has no data for the window
(Open-Meteo keeps only ~the last 90 days plus the forecast, so every 2025 date returns None)
    source            "open-meteo:ensemble:gfs025" | "open-meteo:ensemble:ecmwf_ifs025"
    model, t_ms (T,), members ["control", "member01", ...] (N labels)
    temp_c, rh_pct, wind_speed_ms, wind_dir_deg, precip_mm    (N, T, P) float64, gap-free
    fetched_ms, warnings

Every request goes through :mod:`fire3d.http` (disk cache, retries, 4 concurrent): one multi-location request per
<= 31-day chunk for all points. TTL: 30 min for live/forecast data, 30 days for archived data.

Quota (CONTRACT 14.12.2). Open-Meteo's free API has a daily, hourly and per-minute request limit per IP, counted per
host. Its "Daily API request limit exceeded" answer (HTTP 429) raises :class:`WeatherQuotaExceeded` with no retries
and blocks that host in this process until the reset (00:00 UTC; the next hour or minute for the shorter limits):
a later request to a blocked host is answered from the disk cache or raises at once, without a network call, except
that a daily block is re-checked with one tiny probe request at most once an hour (:func:`recheck_daily_block`;
a shared IP's daily-limit answer can be transient) and lifted when the host answers.
A refused HRRR / forecast request fails :meth:`OpenMeteoSource.deterministic` (no silent ERA5 fill);
:func:`probe_open_meteo` asks each host once, uncached, for ``fire3d.cli weather-probe``.
"""

from __future__ import annotations

import logging
import re
import threading
from datetime import timedelta
from typing import Any, Protocol, Sequence, runtime_checkable
from urllib.parse import urlsplit

import numpy as np

from .. import http
from ..timeutil import DAY_MS, HOUR_MS, floor_hour_ms, iso_to_ms, ms_to_dt, ms_to_iso, now_ms

log = logging.getLogger(__name__)

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
HISTORICAL_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
ENSEMBLE_URL = "https://ensemble-api.open-meteo.com/v1/ensemble"

# Open-Meteo hourly variable -> our field name
VARS: dict[str, str] = {
    "temperature_2m": "temp_c",
    "relative_humidity_2m": "rh_pct",
    "dew_point_2m": "dewpoint_c",
    "wind_speed_10m": "wind_speed_ms",
    "wind_direction_10m": "wind_dir_deg",
    "wind_gusts_10m": "wind_gust_ms",
    "precipitation": "precip_mm",
}
FIELDS: tuple[str, ...] = tuple(VARS.values())
ENSEMBLE_VARS: tuple[str, ...] = ("temperature_2m", "relative_humidity_2m", "wind_speed_10m", "wind_direction_10m", "precipitation")
ENSEMBLE_FIELDS: tuple[str, ...] = tuple(VARS[v] for v in ENSEMBLE_VARS)
ENSEMBLE_SIZES: dict[str, int] = {"gfs025": 31, "ecmwf_ifs025": 51}   # control + perturbed members
DETERMINISTIC_MODELS = ("gfs_hrrr", "gfs_seamless")                    # primary, fill

LIVE_TTL_S = 30 * 60.0
HISTORICAL_TTL_S = 30 * 86400.0
CHUNK_DAYS = 31
# Hours older than this come from the historical-forecast API, newer ones (and the future) from the forecast API.
# Checked 2026-10-16: api.open-meteo.com accepts start_date up to 92 days back, but returns gfs_hrrr only for the
# last ~31 days (gfs_seamless ~46 days), while historical-forecast-api has gfs_hrrr right up to the present.
FORECAST_PAST_DAYS = 21
ENSEMBLE_PAST_DAYS = 88            # ensemble-api keeps ~90 days (2026-07-16.. on 2026-10-16)
ENSEMBLE_FUTURE_DAYS = 14          # beyond this a start is certainly out of every ensemble's range
ERA5_DELAY_DAYS = 6                # ERA5(T) in the archive API lags real time by ~5 days
BLEND_H = 6.0                      # hours over which a fill source is blended in/out around gaps (bias offset decay)
REQUEST_TIMEOUT_S = 120.0
_ESSENTIAL = ("temp_c", "rh_pct", "wind_speed_ms", "wind_dir_deg")
_MEMBER_KEY = re.compile(r"^(?P<base>[a-z0-9_]+?)(?:_member(?P<num>\d+))?$")


class WeatherError(RuntimeError):
    """No usable weather could be obtained for the requested points/window."""


# ---------------------------------------------------------------------------------------------------------------
# Open-Meteo request limits (CONTRACT 14.12.2)
# ---------------------------------------------------------------------------------------------------------------
HOSTS: dict[str, str] = {           # probe / block label -> base URL
    "forecast": FORECAST_URL,
    "historical-forecast": HISTORICAL_URL,
    "archive": ARCHIVE_URL,
    "ensemble": ENSEMBLE_URL,
}
OVERALL_HOSTS = ("forecast", "historical-forecast", "archive")    # what historical and validation builds need
LIVE_HOSTS = ("forecast", "ensemble")                             # what live builds need
QUOTA_DAILY_MESSAGE = "Open-Meteo daily request limit reached; retry after the reset (00:00 UTC)"
PROBE_TIMEOUT_S = 20.0


def quota_message(period: str = "daily", until_ms: int | None = None) -> str:
    """The user-facing sentence for a refused request (the daily one is fixed by CONTRACT 14.12.2)."""
    if period == "hourly":
        at = ms_to_dt(until_ms).strftime("%H:%M") if until_ms else "the next hour"
        return f"Open-Meteo hourly request limit reached; retry after the reset ({at} UTC)"
    if period == "minutely":
        return "Open-Meteo per-minute request limit reached; retry in a minute"
    return QUOTA_DAILY_MESSAGE


class WeatherQuotaExceeded(WeatherError):
    """Open-Meteo refused a request because a request limit is reached (``period`` "daily" | "hourly" |
    "minutely"); ``host`` is the label of :data:`HOSTS`, ``until_ms`` when this process asks that host again."""

    def __init__(self, host: str, period: str = "daily", until_ms: int | None = None, detail: str = ""):
        self.host = host
        self.period = period
        self.until_ms = until_ms
        self.detail = detail
        super().__init__(quota_message(period, until_ms))


_blocks: dict[str, tuple[int, str]] = {}     # host label -> (blocked until epoch ms, period); per process
_blocks_lock = threading.Lock()
_checked: dict[str, int] = {}                 # host label -> when its block was set or last re-checked (epoch ms)
# A daily block is re-checked with one tiny probe request at most this often (deviation from CONTRACT 14.12.2,
# review round 1 R3): on a shared IP Open-Meteo's "daily limit" answer was transient (02:04Z refused, 02:13Z
# answered on 2026-10-23), and a long-running API must not refuse every build on that host until 00:00 UTC.
DAILY_RECHECK_S = 3600.0


def host_label(url: str) -> str:
    """The :data:`HOSTS` label of an Open-Meteo URL (the host name itself for anything else)."""
    host = (urlsplit(url).hostname or url).lower()
    for label, base in HOSTS.items():
        if host == urlsplit(base).hostname:
            return label
    return host


def quota_reset_ms(period: str, now: int) -> int:
    """When a refused ``period`` limit opens again: the next 00:00 UTC, the next whole hour or minute."""
    if period == "minutely":
        return (int(now) // 60_000 + 1) * 60_000
    if period == "hourly":
        return floor_hour_ms(now) + HOUR_MS
    return (int(now) // DAY_MS + 1) * DAY_MS


def block_host(label: str, period: str = "daily", now: int | None = None) -> int:
    """Mark ``label`` refused until its reset; returns that time (epoch ms)."""
    t = now_ms() if now is None else int(now)
    until = quota_reset_ms(period, t)
    with _blocks_lock:
        cur = _blocks.get(label)
        if cur is None or cur[0] < until:
            _blocks[label] = (until, period)
        _checked[label] = t
    log.warning("weather: %s refused by Open-Meteo (%s limit); no requests to it until %s", label, period, ms_to_iso(until))
    return until


def host_block(label: str, now: int | None = None) -> tuple[int, str] | None:
    """``(until_ms, period)`` while ``label`` is blocked, else None (an expired block is dropped)."""
    t = now_ms() if now is None else int(now)
    with _blocks_lock:
        cur = _blocks.get(label)
        if cur is not None and cur[0] <= t:
            del _blocks[label]
            cur = None
    return cur


def blocked_hosts(now: int | None = None) -> dict[str, int]:
    """Every currently blocked host label -> blocked until (epoch ms)."""
    return {lab: blk[0] for lab in list(_blocks) if (blk := host_block(lab, now)) is not None}


def clear_host_blocks() -> None:
    """Forget every block (tests, or after a successful probe)."""
    with _blocks_lock:
        _blocks.clear()
        _checked.clear()


def _lift(label: str) -> None:
    with _blocks_lock:
        _blocks.pop(label, None)
        _checked.pop(label, None)


def recheck_daily_block(label: str, now: int | None = None) -> bool:
    """For a host under a *daily* block: at most once per :data:`DAILY_RECHECK_S` since the block was set or last
    re-checked, send one tiny uncached probe request (one location, one variable, one day; no retries). An answer
    lifts the block (True); a limit answer renews it; anything else keeps it. Without a due re-check, no network
    call (False)."""
    t = now_ms() if now is None else int(now)
    url = HOSTS.get(label)
    with _blocks_lock:
        cur = _blocks.get(label)
        if url is None or cur is None or cur[1] != "daily" or cur[0] <= t:
            return False
        if t - _checked.get(label, t) < DAILY_RECHECK_S * 1000.0:
            return False
        _checked[label] = t                   # one re-check per period, even with concurrent callers
    try:
        record_usage(1.0, t)
        resp = http.request("GET", url, params=_probe_params(label, t), ttl_s=0, timeout=PROBE_TIMEOUT_S, retries=0)
    except http.HttpError as e:
        period = http.quota_period(e.message) if e.status == 429 else None
        if period is not None:
            block_host(label, period, t)
        else:
            log.info("weather: re-check of %s failed (%s); block kept", label, e.status or "no response")
        return False
    if http.is_error_body(resp.content, resp.content_type):
        return False
    _lift(label)
    log.warning("weather: %s answers again (hourly re-check); block lifted", label)
    return True


def raise_if_blocked(labels: Sequence[str], now: int | None = None) -> None:
    """Raise :class:`WeatherQuotaExceeded` when one of ``labels`` is blocked (no network call, except the hourly
    re-check of a daily block, :func:`recheck_daily_block`)."""
    for lab in labels:
        blk = host_block(lab, now)
        if blk is not None and not recheck_daily_block(lab, now):
            raise WeatherQuotaExceeded(lab, blk[1], blk[0])


def deterministic_hosts(start_ms: int, end_ms: int, now: int | None = None) -> list[str]:
    """The hosts :meth:`OpenMeteoSource.deterministic` asks for HRRR over ``[start_ms, end_ms]`` (ERA5 aside)."""
    t_now = now_ms() if now is None else int(now)
    live_floor = floor_hour_ms(t_now) - FORECAST_PAST_DAYS * DAY_MS
    out = []
    if floor_hour_ms(start_ms) < live_floor:
        out.append("historical-forecast")
    if ceil_hour_ms(end_ms) >= live_floor:
        out.append("forecast")
    return out


# ---------------------------------------------------------------------------------------------------------------
# Weighted daily usage (CONTRACT 14.12.2, us-pipeline cut-line item b)
# ---------------------------------------------------------------------------------------------------------------
USAGE_FILE = "open_meteo_usage.json"          # in config.CACHE_DIR (data/cache): {"date", "weighted_calls"}
_usage_lock = threading.Lock()


def request_cost(params: dict | None) -> float:
    """Open-Meteo's weighting of one request (its terms: more than 10 variables or 2 weeks, or several locations,
    count as several calls): locations x max(1, series / 10) x max(1, days / 14), series = variables x models."""
    p = dict(params or {})
    locations = max(1, len([v for v in str(p.get("latitude", "")).split(",") if v.strip()]))
    variables = [v for key in ("hourly", "daily") for v in str(p.get(key, "")).split(",") if v.strip()]
    models = max(1, len([m for m in str(p.get("models", "")).split(",") if m.strip()]))
    series = max(1, len(variables)) * models
    days = 1.0
    if p.get("start_date") and p.get("end_date"):
        try:
            days = (iso_to_ms(str(p["end_date"])) - iso_to_ms(str(p["start_date"]))) / DAY_MS + 1.0
        except ValueError:
            days = 1.0
    elif p.get("forecast_days") or p.get("past_days"):
        days = float(p.get("forecast_days") or 7) + float(p.get("past_days") or 0)
    return float(locations * max(1.0, series / 10.0) * max(1.0, days / 14.0))


def _usage_path():
    from pathlib import Path

    from .. import config

    return Path(config.CACHE_DIR) / USAGE_FILE


def open_meteo_usage(now: int | None = None) -> dict:
    """``{"date": "YYYY-MM-DD" (UTC), "weighted_calls": float}`` of today's Open-Meteo requests from this machine
    (cache hits are free; persisted in ``data/cache/open_meteo_usage.json``)."""
    import orjson

    today = ms_to_iso(now_ms() if now is None else int(now))[:10]
    try:
        doc = orjson.loads(_usage_path().read_bytes())
    except (OSError, ValueError):
        doc = {}
    if not isinstance(doc, dict) or doc.get("date") != today:
        return {"date": today, "weighted_calls": 0.0}
    return {"date": today, "weighted_calls": float(doc.get("weighted_calls") or 0.0)}


def record_usage(cost: float, now: int | None = None) -> dict:
    """Add ``cost`` weighted calls to today's count (a new UTC day starts at 0). Never raises."""
    import orjson

    with _usage_lock:
        u = open_meteo_usage(now)
        u["weighted_calls"] = round(u["weighted_calls"] + float(cost), 2)
        try:
            http.atomic_write_bytes(_usage_path(), orjson.dumps(u))
        except OSError as e:
            log.warning("weather: could not store the Open-Meteo usage count: %s", e)
    return u


def over_soft_cap(now: int | None = None) -> bool:
    """True when today's weighted Open-Meteo calls exceed ``config.OPEN_METEO_DAILY_SOFT_CAP``."""
    from .. import config

    return open_meteo_usage(now)["weighted_calls"] > float(config.OPEN_METEO_DAILY_SOFT_CAP)


MINUTELY_WAIT_MAX_S = 65.0          # a per-minute refusal is waited out once (Open-Meteo: "try again in one minute")


def _sleep(seconds: float) -> None:          # tests replace this
    import time

    time.sleep(seconds)


def om_request(url: str, params: dict, ttl_s: float | None, timeout: float = 120.0, *,
               wait_minutely: bool = True) -> http.Response:
    """GET an Open-Meteo URL through :mod:`fire3d.http`, honouring the per-host block: a blocked host answers from
    the disk cache or raises :class:`WeatherQuotaExceeded` without a network call (a daily block is re-checked at
    most once an hour, :func:`recheck_daily_block`, and the request goes ahead when the host answers again); a daily
    or hourly limit answer blocks the host and raises it (never retried). A per-minute limit answer (other tenants of a shared IP can use up
    the 600 calls a minute) is waited out once, until the next minute, then asked again; a second refusal raises."""
    label = host_label(url)
    for attempt in (0, 1):
        blk = host_block(label)
        if blk is not None:
            hit = http.peek_cache("GET", url, params, ttl_s)
            if hit is not None:
                return hit
            if blk[1] == "minutely" and wait_minutely and attempt == 0:
                _sleep(min(MINUTELY_WAIT_MAX_S, max(0.0, (blk[0] - now_ms()) / 1000.0) + 1.0))
                continue
            if not recheck_daily_block(label):
                raise WeatherQuotaExceeded(label, blk[1], blk[0])
        try:
            resp = http.request("GET", url, params=params, ttl_s=ttl_s, timeout=timeout)
        except http.HttpError as e:
            if e.status is not None:
                record_usage(request_cost(params))
            period = http.quota_period(e.message) if e.status == 429 else None
            if period is None:
                raise
            until = block_host(label, period)
            if period == "minutely" and wait_minutely and attempt == 0:
                _sleep(min(MINUTELY_WAIT_MAX_S, max(0.0, (until - now_ms()) / 1000.0) + 1.0))
                continue
            raise WeatherQuotaExceeded(label, period, until, e.message) from None
        if not resp.from_cache:
            record_usage(request_cost(params))
        return resp
    raise WeatherQuotaExceeded(label, "minutely", quota_reset_ms("minutely", now_ms()))   # pragma: no cover


def _probe_params(label: str, now: int) -> dict[str, str]:
    base = {"latitude": "39.7392", "longitude": "-104.9903", "hourly": "temperature_2m", "timeformat": "unixtime"}
    if label == "historical-forecast":
        d = ms_to_iso(now - 30 * DAY_MS)[:10]
        return {**base, "models": DETERMINISTIC_MODELS[0], "start_date": d, "end_date": d}
    if label == "archive":
        d = ms_to_iso(now - (ERA5_DELAY_DAYS + 4) * DAY_MS)[:10]
        return {**base, "start_date": d, "end_date": d}
    if label == "ensemble":
        return {**base, "models": "gfs025", "forecast_days": "1"}
    return {**base, "forecast_days": "1"}


def _combine(statuses: Sequence[str]) -> str:
    if all(s == "ok" for s in statuses):
        return "ok"
    return "daily_limit" if "daily_limit" in statuses else "unreachable"


def probe_open_meteo(timeout: float = PROBE_TIMEOUT_S) -> dict:
    """One uncached tiny request to each Open-Meteo host (one location, one variable, one day).

    Returns ``{"overall": s, "live": s, "hosts": {"forecast": s, "historical-forecast": s, "archive": s,
    "ensemble": s}, "detail": {host: text}}`` with ``s`` in ``ok`` / ``daily_limit`` (any request-limit answer) /
    ``unreachable``. ``overall`` (historical and validation builds) is ok only when forecast, historical-forecast
    and archive are; ``live`` (live builds) only when forecast and ensemble are. A limit answer blocks the host;
    an ok answer lifts this process's block."""
    now = now_ms()
    hosts: dict[str, str] = {}
    detail: dict[str, str] = {}
    for label, url in HOSTS.items():
        try:
            record_usage(1.0, now)
            resp = http.request("GET", url, params=_probe_params(label, now), ttl_s=0, timeout=timeout, retries=0)
            if http.is_error_body(resp.content, resp.content_type):
                hosts[label], detail[label] = "unreachable", "error body: " + resp.text[:120]
                continue
            hosts[label], detail[label] = "ok", f"HTTP {resp.status}"
            _lift(label)
        except http.HttpError as e:
            period = http.quota_period(e.message) if e.status == 429 else None
            if period is not None:
                block_host(label, period, now)
                hosts[label], detail[label] = "daily_limit", f"HTTP 429 {period} limit: {e.message[:120]}"
            else:
                hosts[label] = "unreachable"
                detail[label] = f"HTTP {e.status}: {e.message[:120]}" if e.status else e.message[:120]
    return {"overall": _combine([hosts[h] for h in OVERALL_HOSTS]), "live": _combine([hosts[h] for h in LIVE_HOSTS]),
            "hosts": hosts, "detail": detail}


@runtime_checkable
class WeatherSource(Protocol):
    """Hourly weather at a list of (lat, lon) points (shapes in the module docstring).

    Implementations: :class:`OpenMeteoSource`. A future ``WeatherNext3Source`` implements this same protocol."""

    name: str

    def deterministic(self, points: Sequence[tuple[float, float]], start_ms: int, end_ms: int) -> dict:
        """Deterministic hourly series per point for [start_ms, end_ms]."""
        ...

    def ensemble(self, points: Sequence[tuple[float, float]], start_ms: int, end_ms: int, model: str) -> dict | None:
        """Ensemble members per point (``model`` "gfs025" | "ecmwf_ifs025"), or None if unavailable."""
        ...


# ---------------------------------------------------------------------------------------------------------------
# Small numeric helpers (shared with build/weather_bundle.py)
# ---------------------------------------------------------------------------------------------------------------
def ceil_hour_ms(ms: int | float) -> int:
    """Ceil an epoch-ms timestamp to a whole UTC hour."""
    return -(-int(ms) // HOUR_MS) * HOUR_MS


def hourly_axis(start_ms: int | float, end_ms: int | float) -> np.ndarray:
    """int64 hourly epoch-ms axis from ``floor_hour(start)`` to ``ceil_hour(end)`` inclusive."""
    a, b = floor_hour_ms(start_ms), ceil_hour_ms(end_ms)
    if b < a:
        raise ValueError("end_ms is before start_ms")
    return np.arange(a, b + HOUR_MS, HOUR_MS, dtype=np.int64)


def wind_to_uv(speed, dir_from_deg) -> tuple[np.ndarray, np.ndarray]:
    """FROM-direction wind -> (u east+, v north+): ``u = −S·sin(dir)``, ``v = −S·cos(dir)``."""
    s = np.asarray(speed, dtype=np.float64)
    d = np.radians(np.asarray(dir_from_deg, dtype=np.float64))
    return -s * np.sin(d), -s * np.cos(d)


def uv_to_wind(u, v) -> tuple[np.ndarray, np.ndarray]:
    """(u, v) -> (speed, FROM direction in [0, 360)). Calm winds get direction 0; NaN stays NaN."""
    u = np.asarray(u, dtype=np.float64)
    v = np.asarray(v, dtype=np.float64)
    s = np.hypot(u, v)
    d = np.degrees(np.arctan2(-u, -v)) % 360.0
    return s, np.where(s > 1e-9, d, np.where(np.isfinite(s), 0.0, np.nan))


def rh_from_dewpoint(temp_c, dewpoint_c) -> np.ndarray:
    """Relative humidity (%) from temperature and dew point (Magnus, 17.625 / 243.04 °C)."""
    t = np.asarray(temp_c, dtype=np.float64)
    td = np.asarray(dewpoint_c, dtype=np.float64)
    return np.clip(100.0 * np.exp(17.625 * td / (243.04 + td) - 17.625 * t / (243.04 + t)), 0.0, 100.0)


def dewpoint_from_rh(temp_c, rh_pct) -> np.ndarray:
    """Dew point (°C) from temperature and relative humidity (Magnus)."""
    t = np.asarray(temp_c, dtype=np.float64)
    rh = np.clip(np.asarray(rh_pct, dtype=np.float64), 0.5, 100.0)
    g = np.log(rh / 100.0) + 17.625 * t / (243.04 + t)
    return 243.04 * g / (17.625 - g)


def blend_offsets(diff: np.ndarray, have: np.ndarray, blend_h: float = BLEND_H) -> np.ndarray:
    """Per-column offset series along axis 0 (hourly): ``diff`` where ``have``; linear interpolation across interior
    gaps; beyond the first/last valid hour the edge value decays linearly to 0 over ``blend_h`` hours.

    Used to merge a fill source into a primary one without steps (``primary ≈ fill + offset``) and to blend
    bias-corrected ensemble members back to raw members after HRRR ends. ``have`` broadcasts against ``diff``."""
    d = np.asarray(diff, dtype=np.float64)
    T = d.shape[0]
    hv = np.broadcast_to(np.asarray(have, dtype=bool).reshape((T,) + (1,) * (d.ndim - 1)) if np.ndim(have) == 1 else have, d.shape)
    flat = d.reshape(T, -1)
    ok = hv.reshape(T, -1) & np.isfinite(flat)
    out = np.zeros_like(flat)
    tt = np.arange(T, dtype=np.float64)
    for c in range(flat.shape[1]):
        idx = np.flatnonzero(ok[:, c])
        if idx.size == 0:
            continue
        col = np.interp(tt, idx.astype(np.float64), flat[idx, c])
        lead, trail = tt < idx[0], tt > idx[-1]
        if blend_h > 0:
            col[lead] *= np.clip(1.0 - (idx[0] - tt[lead]) / blend_h, 0.0, 1.0)
            col[trail] *= np.clip(1.0 - (tt[trail] - idx[-1]) / blend_h, 0.0, 1.0)
        else:
            col[lead | trail] = 0.0
        out[:, c] = col
    return out.reshape(d.shape)


def fill_gaps(a: np.ndarray) -> np.ndarray:
    """Linear interpolation of NaNs along axis 0 per column; edges hold the nearest value; all-NaN columns stay NaN."""
    arr = np.array(a, dtype=np.float64, copy=True)
    T = arr.shape[0]
    flat = arr.reshape(T, -1)
    tt = np.arange(T, dtype=np.float64)
    bad = ~np.isfinite(flat)
    for c in np.flatnonzero(bad.any(axis=0)):
        good = ~bad[:, c]
        if good.any():
            flat[:, c] = np.interp(tt, tt[good], flat[good, c])
    return flat.reshape(arr.shape)


def _blend_scalar(primary: np.ndarray, fill: np.ndarray, blend_h: float) -> np.ndarray:
    have = np.isfinite(primary)
    off = blend_offsets(primary - fill, have & np.isfinite(fill), blend_h)
    return np.where(have, primary, fill + off)


def merge_fields(primary: dict[str, np.ndarray], fill: dict[str, np.ndarray], blend_h: float = BLEND_H) -> dict[str, np.ndarray]:
    """Primary values where present, else fill + a blended offset (wind merged in u/v space, precipitation raw)."""
    out: dict[str, np.ndarray] = {}
    pu, pv = wind_to_uv(primary["wind_speed_ms"], primary["wind_dir_deg"])
    fu, fv = wind_to_uv(fill["wind_speed_ms"], fill["wind_dir_deg"])
    out["wind_speed_ms"], out["wind_dir_deg"] = uv_to_wind(_blend_scalar(pu, fu, blend_h), _blend_scalar(pv, fv, blend_h))
    for f in ("temp_c", "rh_pct", "dewpoint_c", "wind_gust_ms"):
        if f in primary and f in fill:
            out[f] = _blend_scalar(primary[f], fill[f], blend_h)
    if "rh_pct" in out:
        out["rh_pct"] = np.clip(out["rh_pct"], 0.0, 100.0)
    if "wind_gust_ms" in out:
        out["wind_gust_ms"] = np.maximum(out["wind_gust_ms"], 0.0)
    if "precip_mm" in primary and "precip_mm" in fill:
        out["precip_mm"] = np.where(np.isfinite(primary["precip_mm"]), primary["precip_mm"], fill["precip_mm"])
    return out


def complete_hours(fields: dict[str, np.ndarray]) -> np.ndarray:
    """(T,) True where every essential field (T, RH, wind speed/direction) is finite at every point."""
    ok = None
    for f in _ESSENTIAL:
        a = np.isfinite(fields[f]).reshape(fields[f].shape[0], -1).all(axis=1)
        ok = a if ok is None else ok & a
    assert ok is not None
    return ok


def finalize_fields(fields: dict[str, np.ndarray], warnings: list[str], what: str = "weather") -> dict[str, np.ndarray]:
    """Gap-fill (time interpolation, wind in u/v), derive RH/dew point from each other, default gusts/precip.
    Raises :class:`WeatherError` if an essential field has no data at all."""
    f = {k: np.array(v, dtype=np.float64, copy=True) for k, v in fields.items()}
    T = f["temp_c"].shape[0]
    if "dewpoint_c" in f:
        need = ~np.isfinite(f["rh_pct"]) & np.isfinite(f["temp_c"]) & np.isfinite(f["dewpoint_c"])
        f["rh_pct"][need] = rh_from_dewpoint(f["temp_c"][need], f["dewpoint_c"][need])
    holes = int((~complete_hours(f)).sum())
    if holes:
        warnings.append(f"{what}: {holes} of {T} h had missing values; interpolated in time")
    u, v = wind_to_uv(f["wind_speed_ms"], f["wind_dir_deg"])
    # speed is interpolated as a scalar (u/v averaging would damp it); direction comes from interpolated u/v
    series = {"u": u, "v": v, "wind_speed_ms": f["wind_speed_ms"], "temp_c": f["temp_c"], "rh_pct": f["rh_pct"]}
    for k, a in series.items():
        a = fill_gaps(a)
        flat = a.reshape(T, -1)
        col_bad = ~np.isfinite(flat).all(axis=0)
        if col_bad.all():
            raise WeatherError(f"{what}: no {k} data")
        if col_bad.any():   # a point with no data at all: use the mean of the other points
            flat[:, col_bad] = np.mean(flat[:, ~col_bad], axis=1, keepdims=True)
            warnings.append(f"{what}: {int(col_bad.sum())} point(s) had no {k}; used the mean of the others")
        series[k] = a
    _, f["wind_dir_deg"] = uv_to_wind(series["u"], series["v"])
    f["wind_speed_ms"] = np.maximum(series["wind_speed_ms"], 0.0)
    f["temp_c"] = series["temp_c"]
    f["rh_pct"] = np.clip(series["rh_pct"], 0.0, 100.0)
    if "dewpoint_c" in f:
        f["dewpoint_c"] = fill_gaps(f["dewpoint_c"])
        bad = ~np.isfinite(f["dewpoint_c"])
        f["dewpoint_c"][bad] = dewpoint_from_rh(f["temp_c"][bad], f["rh_pct"][bad])
    if "wind_gust_ms" in f:
        g = fill_gaps(f["wind_gust_ms"])
        bad = ~np.isfinite(g)
        if bad.any():
            warnings.append(f"{what}: wind gusts unavailable for {int(bad.reshape(T, -1).any(axis=1).sum())} h; estimated as 1.5 x wind speed")
            g[bad] = 1.5 * f["wind_speed_ms"][bad]
        f["wind_gust_ms"] = np.maximum(g, f["wind_speed_ms"])
    if "precip_mm" in f:
        p = f["precip_mm"]
        p[~np.isfinite(p)] = 0.0
        f["precip_mm"] = np.maximum(p, 0.0)
    return f


# ---------------------------------------------------------------------------------------------------------------
# Request helpers
# ---------------------------------------------------------------------------------------------------------------
def _norm_points(points: Sequence[tuple[float, float]]) -> list[tuple[float, float]]:
    pts = [(round(float(la), 4), round(float(lo), 4)) for la, lo in points]
    if not pts:
        raise ValueError("no weather points")
    for la, lo in pts:
        if not (-90.0 <= la <= 90.0 and -180.0 <= lo <= 180.0):
            raise ValueError(f"invalid (lat, lon): {(la, lo)}")
    return pts


def _coord_params(pts: list[tuple[float, float]]) -> dict[str, str]:
    return {"latitude": ",".join(f"{la:.4f}" for la, _ in pts), "longitude": ",".join(f"{lo:.4f}" for _, lo in pts)}


def date_chunks(start_ms: int, end_ms: int, max_days: int = CHUNK_DAYS) -> list[tuple[str, str]]:
    """UTC calendar-date windows (inclusive ``YYYY-MM-DD`` pairs) of at most ``max_days`` days covering the range."""
    d0, d1 = ms_to_dt(start_ms).date(), ms_to_dt(end_ms).date()
    out: list[tuple[str, str]] = []
    cur = d0
    while cur <= d1:
        nxt = min(d1, cur + timedelta(days=max_days - 1))
        out.append((cur.isoformat(), nxt.isoformat()))
        cur = nxt + timedelta(days=1)
    return out


def _locations(payload: Any, n: int) -> list[dict]:
    """The per-location ``hourly`` dicts of a (multi-)location response, in request order."""
    items = payload if isinstance(payload, list) else [payload]
    if len(items) != n:
        raise WeatherError(f"Open-Meteo returned {len(items)} locations for {n} points")
    out = []
    for it in items:
        if not isinstance(it, dict) or not isinstance(it.get("hourly"), dict):
            raise WeatherError(f"unexpected Open-Meteo response: {str(it)[:200]}")
        out.append(it["hourly"])
    return out


def _place(hourly: dict, key: str, t_axis: np.ndarray, out: np.ndarray, p: int) -> bool:
    """Copy ``hourly[key]`` onto ``out[:, p]`` aligned to ``t_axis`` (unix seconds -> ms). False if the key is absent."""
    vals = hourly.get(key)
    times = hourly.get("time")
    if vals is None or times is None:
        return False
    tt = np.asarray(times, dtype=np.int64) * 1000
    vv = np.array(vals, dtype=np.float64)       # None -> NaN
    rel = tt - t_axis[0]
    idx = rel // HOUR_MS
    ok = (rel % HOUR_MS == 0) & (idx >= 0) & (idx < len(t_axis))
    out[idx[ok], p] = vv[ok]
    return True


def _empty(T: int, P: int, fields: Sequence[str] = FIELDS) -> dict[str, np.ndarray]:
    return {f: np.full((T, P), np.nan) for f in fields}


class OpenMeteoSource:
    """Open-Meteo provider (SPEC 2): HRRR + GFS seamless fill (live forecast API), archived HRRR from the
    historical-forecast API with an ERA5 archive fallback (past), and the GFS / ECMWF ensembles (live only)."""

    name = "open-meteo"

    def __init__(self, blend_h: float = BLEND_H, *, allow_era5: bool = True):
        self.blend_h = float(blend_h)
        self.allow_era5 = bool(allow_era5)      # False (``--require-hrrr``): a past hour without HRRR/GFS fails
        self.last_error: str | None = None      # why the last ensemble() call returned None

    # --- deterministic -----------------------------------------------------------------------------------------
    def deterministic(self, points: Sequence[tuple[float, float]], start_ms: int, end_ms: int) -> dict:
        """Hourly series at ``points`` for [start_ms, end_ms] (see the module docstring for the shape)."""
        pts = _norm_points(points)
        t = hourly_axis(start_ms, end_ms)
        T, P = len(t), len(pts)
        now = now_ms()
        warnings: list[str] = []
        hrrr, gfs = _empty(T, P), _empty(T, P)
        endpoints: list[str] = []
        fetched: list[int] = []
        live_floor = floor_hour_ms(now) - FORECAST_PAST_DAYS * DAY_MS
        segments: list[tuple[str, int, int]] = []
        if t[0] < live_floor:
            segments.append(("historical-forecast", int(t[0]), int(min(t[-1], live_floor - HOUR_MS))))
        if t[-1] >= live_floor:
            segments.append(("forecast", int(max(t[0], live_floor)), int(t[-1])))
        hourly_list = ",".join(VARS)
        for kind, a, b in segments:
            url = HISTORICAL_URL if kind == "historical-forecast" else FORECAST_URL
            for d0, d1 in date_chunks(a, b):
                archived = kind == "historical-forecast" and now - (iso_to_ms(d1) + DAY_MS) > 7 * DAY_MS
                params = {**_coord_params(pts), "hourly": hourly_list, "models": ",".join(DETERMINISTIC_MODELS),
                          "wind_speed_unit": "ms", "timeformat": "unixtime", "start_date": d0, "end_date": d1}
                try:
                    resp = om_request(url, params, HISTORICAL_TTL_S if archived else LIVE_TTL_S, REQUEST_TIMEOUT_S)
                    locs = _locations(resp.json(), P)
                except WeatherQuotaExceeded:
                    raise                     # refused HRRR: fail, never fill silently with ERA5 (CONTRACT 14.12.2)
                except (http.HttpError, WeatherError, ValueError) as e:
                    msg = getattr(e, "message", str(e))
                    warnings.append(f"open-meteo {kind} {d0}..{d1} failed ({msg[:160]})")
                    log.warning("weather: %s %s..%s failed: %s", kind, d0, d1, msg[:200])
                    continue
                for p, hourly in enumerate(locs):
                    for om, f in VARS.items():
                        _place(hourly, f"{om}_{DETERMINISTIC_MODELS[0]}", t, hrrr[f], p)
                        _place(hourly, f"{om}_{DETERMINISTIC_MODELS[1]}", t, gfs[f], p)
                endpoints.append(kind)
                fetched.append(resp.fetched_ms)
        hrrr_mask = complete_hours(hrrr)
        merged = merge_fields(hrrr, gfs, self.blend_h)
        used: list[str] = []
        if np.isfinite(hrrr["temp_c"]).any():
            used.append("gfs_hrrr")
        if (~np.isfinite(hrrr["temp_c"]) & np.isfinite(gfs["temp_c"])).any():
            used.append("gfs_seamless")
            n_fill = int((~hrrr_mask & complete_hours(gfs)).sum())
            if "forecast" not in endpoints and n_fill:
                warnings.append(f"HRRR missing for {n_fill} h; filled with GFS")
        holes = ~complete_hours(merged)
        era5_used = False
        if holes.any():
            past = t[holes & (t < now - ERA5_DELAY_DAYS * DAY_MS)]
            if past.size and not self.allow_era5:
                raise WeatherError(f"HRRR and GFS are missing for {past.size} past hour(s); ERA5 filling is not allowed "
                                   "(--require-hrrr)")
            if past.size:
                era = _empty(T, P)
                got = False
                for d0, d1 in date_chunks(int(past.min()), int(past.max())):
                    params = {**_coord_params(pts), "hourly": hourly_list, "wind_speed_unit": "ms", "timeformat": "unixtime",
                              "start_date": d0, "end_date": d1}
                    try:
                        resp = om_request(ARCHIVE_URL, params, HISTORICAL_TTL_S, REQUEST_TIMEOUT_S)
                        locs = _locations(resp.json(), P)
                    except WeatherQuotaExceeded as e:
                        warnings.append(f"open-meteo ERA5 archive {d0}..{d1} refused ({e}); {past.size} h without "
                                        "HRRR/GFS interpolated in time")
                        break
                    except (http.HttpError, WeatherError, ValueError) as e:
                        msg = getattr(e, "message", str(e))
                        warnings.append(f"open-meteo ERA5 archive {d0}..{d1} failed ({msg[:160]})")
                        continue
                    for p, hourly in enumerate(locs):
                        for om, f in VARS.items():
                            _place(hourly, om, t, era[f], p)
                    fetched.append(resp.fetched_ms)
                    got = True
                if got:
                    merged = merge_fields(merged, era, self.blend_h)
                    filled = int((holes & complete_hours(merged)).sum())
                    if filled:
                        era5_used = True
                        used.append("era5")
                        warnings.append(f"ERA5 reanalysis used for {filled} h where HRRR/GFS were unavailable")
        if not np.isfinite(merged["temp_c"]).any():
            raise WeatherError("no weather data from Open-Meteo for the requested window: " + "; ".join(warnings)[:400])
        final = finalize_fields(merged, warnings)
        if used == ["era5"]:
            source = "open-meteo:archive:era5"
        else:
            kinds = [k for k in ("historical-forecast", "forecast") if k in endpoints]
            prefix = "open-meteo:" + ("" if kinds == ["forecast"] else "+".join(kinds) + ":")
            source = prefix + "+".join(used)
        ff = floor_hour_ms(now) + HOUR_MS
        forecast_from = int(max(ff, t[0])) if t[-1] >= ff else None
        out: dict[str, Any] = {"source": source, "t_ms": t}
        out.update({f: final[f] for f in FIELDS})
        out.update({"hrrr": hrrr_mask, "forecast_from_ms": forecast_from, "fetched_ms": max(fetched) if fetched else now,
                    "warnings": warnings, "era5": era5_used})
        return out

    # --- ensemble ----------------------------------------------------------------------------------------------
    def ensemble(self, points: Sequence[tuple[float, float]], start_ms: int, end_ms: int, model: str) -> dict | None:
        """All members of ``model`` ("gfs025" 31, "ecmwf_ifs025" 51) at ``points``; None if out of range/failed
        (the reason is kept in :attr:`last_error`)."""
        if model not in ENSEMBLE_SIZES:
            raise ValueError(f"unknown ensemble model {model!r} (use one of {sorted(ENSEMBLE_SIZES)})")
        pts = _norm_points(points)
        t = hourly_axis(start_ms, end_ms)
        T, P = len(t), len(pts)
        now = now_ms()
        self.last_error = None
        if t[0] < now - ENSEMBLE_PAST_DAYS * DAY_MS or t[0] > now + ENSEMBLE_FUTURE_DAYS * DAY_MS:
            self.last_error = f"{model} ensemble only covers ~the last {ENSEMBLE_PAST_DAYS} days plus the forecast"
            return None
        raw: dict[str, dict[str, np.ndarray]] = {}
        fetched: list[int] = []
        for d0, d1 in date_chunks(int(t[0]), int(t[-1])):
            params = {**_coord_params(pts), "hourly": ",".join(ENSEMBLE_VARS), "models": model, "wind_speed_unit": "ms",
                      "timeformat": "unixtime", "start_date": d0, "end_date": d1}
            try:
                resp = om_request(ENSEMBLE_URL, params, LIVE_TTL_S, REQUEST_TIMEOUT_S)
                locs = _locations(resp.json(), P)
            except (http.HttpError, WeatherError, ValueError) as e:
                msg = getattr(e, "message", str(e))
                self.last_error = f"{model} ensemble unavailable ({msg[:200]})"
                log.warning("weather: %s", self.last_error)
                return None
            fetched.append(resp.fetched_ms)
            for p, hourly in enumerate(locs):
                for key in hourly:
                    m = _MEMBER_KEY.match(key)
                    if m is None or m.group("base") not in ENSEMBLE_VARS:
                        continue
                    label = "control" if m.group("num") is None else f"member{int(m.group('num')):02d}"
                    field = VARS[m.group("base")]
                    arr = raw.setdefault(label, {}).setdefault(field, np.full((T, P), np.nan))
                    _place(hourly, key, t, arr, p)
        labels = sorted(raw, key=lambda s: -1 if s == "control" else int(s[6:]))
        warnings: list[str] = []
        kept: list[str] = []
        cols: dict[str, list[np.ndarray]] = {f: [] for f in ENSEMBLE_FIELDS}
        for lab in labels:
            fields = raw[lab]
            if any(f not in fields or not np.isfinite(fields[f]).any() for f in _ESSENTIAL):
                warnings.append(f"{model} {lab}: missing essential variables; dropped")
                continue
            fields.setdefault("precip_mm", np.zeros((T, P)))
            w: list[str] = []
            fin = finalize_fields(fields, w, what=f"{model} {lab}")
            if w and lab == "control":
                warnings.extend(w)
            kept.append(lab)
            for f in ENSEMBLE_FIELDS:
                cols[f].append(fin[f])
        if not kept:
            self.last_error = f"{model} ensemble returned no usable members"
            return None
        if len(kept) < ENSEMBLE_SIZES[model]:
            warnings.append(f"{model}: {len(kept)} of {ENSEMBLE_SIZES[model]} members available")
        out: dict[str, Any] = {"source": f"open-meteo:ensemble:{model}", "model": model, "t_ms": t, "members": kept}
        out.update({f: np.stack(cols[f]) for f in ENSEMBLE_FIELDS})
        out.update({"fetched_ms": max(fetched) if fetched else now, "warnings": warnings})
        return out


# ---------------------------------------------------------------------------------------------------------------
# Antecedent precipitation (drives the drought adjustment of live fuel moisture, spread/moisture.py)
# ---------------------------------------------------------------------------------------------------------------
def water_year_start_ms(t_ms: int) -> int:
    """Oct 1, 00:00 UTC of the water year containing ``t_ms`` (the California rainy-season reference)."""
    d = ms_to_dt(int(t_ms))
    year = d.year if d.month >= 10 else d.year - 1
    return iso_to_ms(f"{year}-10-01T00:00:00Z")


def water_year_precip(lat: float, lon: float, start_ms: int) -> dict:
    """Total precipitation (mm) at (lat, lon) from the water-year start (Oct 1) to the day before ``start_ms``.

    Daily ``precipitation_sum`` from the Open-Meteo ERA5 archive (``ARCHIVE_URL``, ~5 day latency); the most recent
    days that the archive does not have yet come from the forecast API (archived model analyses). Returns
    ``{precip_mm, from, to, days, source, fetched_ms, warnings, refused}``; ``precip_mm`` is None when any part
    could not be fetched (a partial total would understate the rain), with the reason in ``warnings``;
    ``refused`` is True when Open-Meteo's request limit refused a part. Never raises for provider failures."""
    wy0 = water_year_start_ms(start_ms)
    end = floor_hour_ms(int(start_ms)) - DAY_MS
    now = now_ms()
    out: dict[str, Any] = {"precip_mm": None, "from": ms_to_iso(wy0)[:10], "to": ms_to_iso(end)[:10], "days": 0,
                           "source": "", "fetched_ms": now, "warnings": [], "refused": False}
    if end < wy0:                          # the fire starts on Oct 1: nothing has fallen yet this water year
        out.update(precip_mm=0.0, source="water year not started")
        return out
    archive_end = min(end, now - ERA5_DELAY_DAYS * DAY_MS)
    segments: list[tuple[str, int, int]] = []
    if archive_end >= wy0:
        segments.append((ARCHIVE_URL, wy0, archive_end))
    if end > archive_end:
        segments.append((FORECAST_URL, max(wy0, archive_end + DAY_MS), end))
    total, days, sources, fetched, failed = 0.0, 0, [], [], False
    for url, a, b in segments:
        params = {"latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}", "daily": "precipitation_sum", "timezone": "GMT",
                  "start_date": ms_to_iso(a)[:10], "end_date": ms_to_iso(b)[:10]}
        try:
            resp = om_request(url, params, HISTORICAL_TTL_S if url == ARCHIVE_URL else LIVE_TTL_S, REQUEST_TIMEOUT_S)
            daily = (resp.json() or {}).get("daily") or {}
            vals = [float(v) for v in daily.get("precipitation_sum") or [] if v is not None]
        except WeatherQuotaExceeded as e:
            out["refused"] = failed = True
            out["warnings"].append(f"water-year precipitation {ms_to_iso(a)[:10]}..{ms_to_iso(b)[:10]} refused ({e})")
            continue
        except (http.HttpError, WeatherError, ValueError, TypeError, AttributeError) as e:
            failed = True
            out["warnings"].append(f"water-year precipitation {ms_to_iso(a)[:10]}..{ms_to_iso(b)[:10]} unavailable "
                                   f"({getattr(e, 'message', str(e))[:120]})")
            continue
        total += sum(vals)
        days += len(vals)
        sources.append("era5-archive" if url == ARCHIVE_URL else "forecast-api")
        fetched.append(resp.fetched_ms)
    if days and not failed:
        out.update(precip_mm=round(total, 1), days=days, source="open-meteo:" + "+".join(sources),
                   fetched_ms=max(fetched))
    return out
