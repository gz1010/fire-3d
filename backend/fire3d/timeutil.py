"""Time helpers. All JSON timestamps are integer epoch milliseconds UTC (SPEC 4.2).

Fire-local labels (CONTRACT 14.9.7): backend text that names a time uses the fire's own IANA zone
(``summary.time_zone``, :func:`zone_of`), never an assumed Pacific time: :func:`fmt_local` ("Jan 07, 18:18 MST",
24-hour with the zone abbreviation) and :func:`local_month` (the live fuel moisture month).
"""

from __future__ import annotations

import time
from datetime import date, datetime, timezone, tzinfo
from functools import lru_cache
from typing import Any, overload

import numpy as np

HOUR_MS = 3_600_000
DAY_MS = 24 * HOUR_MS
# The latest time a query parameter may name (2100-01-01T00:00:00Z): larger values answer 422, never a 500 from an
# integer that overflows a datetime or a 64-bit field (final verification, panel F5).
MAX_QUERY_MS = 4_102_444_800_000


def now_ms() -> int:
    """Current time in epoch milliseconds UTC."""
    return int(time.time() * 1000)


def floor_hour_ms(ms: int | float) -> int:
    """Floor an epoch-ms timestamp to the start of its UTC hour."""
    return int(ms) // HOUR_MS * HOUR_MS


def time_origin_for(started_ms: int | float) -> int:
    """``time_origin_ms = floor_to_hour(started_ms) - 1 h`` (SPEC 4.2)."""
    return floor_hour_ms(started_ms) - HOUR_MS


def iso_to_ms(s: str | datetime | date) -> int:
    """Parse ISO-8601 (``Z`` or offset suffix, fractional seconds, date-only) to epoch ms. Naive -> UTC."""
    if isinstance(s, datetime):
        dt = s
    elif isinstance(s, date):
        dt = datetime(s.year, s.month, s.day)
    else:
        txt = s.strip()
        if txt.endswith(("Z", "z")):
            txt = txt[:-1] + "+00:00"
        if " " in txt and "T" not in txt:
            txt = txt.replace(" ", "T", 1)
        dt = datetime.fromisoformat(txt)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(round(dt.timestamp() * 1000))


def ms_to_dt(ms: int | float) -> datetime:
    """Epoch ms -> timezone-aware UTC datetime."""
    return datetime.fromtimestamp(int(ms) / 1000.0, tz=timezone.utc)


def ms_to_iso(ms: int | float) -> str:
    """Epoch ms -> ``YYYY-MM-DDTHH:MM:SSZ`` (milliseconds kept only when non-zero)."""
    dt = ms_to_dt(ms)
    if int(ms) % 1000:
        return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(ms) % 1000:03d}Z"
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


@overload
def hours_since(t_ms: int | float, origin_ms: int | float) -> float: ...
@overload
def hours_since(t_ms: np.ndarray, origin_ms: int | float) -> np.ndarray: ...
def hours_since(t_ms, origin_ms):
    """Hours from ``origin_ms`` to ``t_ms`` (vectorized for numpy arrays; float64)."""
    if isinstance(t_ms, np.ndarray):
        return (t_ms.astype(np.float64) - float(origin_ms)) / HOUR_MS
    return (float(t_ms) - float(origin_ms)) / HOUR_MS


def hours_to_ms(hours: float, origin_ms: int | float) -> int:
    """Inverse of :func:`hours_since` for scalars: origin + hours, rounded to whole ms."""
    return int(round(float(origin_ms) + float(hours) * HOUR_MS))


# ----------------------------------------------------------------------------------------------------------------
# Fire-local time (CONTRACT 14.9.7)
# ----------------------------------------------------------------------------------------------------------------
@lru_cache(maxsize=64)
def zone(tz: str | None) -> tzinfo:
    """The ``ZoneInfo`` of an IANA name; UTC for None, "UTC" or an unknown name (never an assumed Pacific time)."""
    if not tz or str(tz).upper() == "UTC":
        return timezone.utc
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(str(tz))
    except Exception:  # noqa: BLE001 - unknown zone or no tz database
        return timezone.utc


def local_dt(ms: int | float, tz: str | None) -> datetime:
    """Epoch ms -> aware datetime in ``tz``."""
    return datetime.fromtimestamp(int(ms) / 1000.0, tz=zone(tz))


def fmt_local(ms: int | float, tz: str | None, *, year: bool = False) -> str:
    """``"Jan 07, 18:18 MST"`` (24-hour, the zone's abbreviation; ``year``: ``"Jan 07, 2025, 18:18 MST"``) in the
    fire's zone ``tz``. Backend text only; the web never re-parses it."""
    d = local_dt(ms, tz)
    name = d.strftime("%Z") or "UTC"
    return d.strftime("%b %d, %Y, %H:%M ") + name if year else d.strftime("%b %d, %H:%M ") + name


def fmt_local_short(ms: int | float, tz: str | None) -> str:
    """``"Oct 17 14:24 PDT"`` (satellite pass labels: day without a leading zero, no comma)."""
    d = local_dt(ms, tz)
    return f"{d.strftime('%b')} {d.day} {d.strftime('%H:%M')} {d.strftime('%Z') or 'UTC'}"


def local_month(ms: int | float, tz: str | None) -> int:
    """The calendar month (1-12) of ``ms`` in the fire's zone ``tz``."""
    return local_dt(ms, tz).month


def zone_of(summary: Any) -> str:
    """The fire's IANA zone: ``summary.time_zone`` (model or dict, also a whole manifest with a ``summary``), else
    the zone at its reported location (``fire3d.regions``), else its state's main zone, else "UTC"."""
    if isinstance(summary, dict) and isinstance(summary.get("summary"), dict):
        summary = summary["summary"]
    get = summary.get if isinstance(summary, dict) else (lambda k, d=None: getattr(summary, k, d))
    tz = get("time_zone")
    if isinstance(tz, str) and tz:
        return tz
    try:
        from . import regions

        lon, lat = get("lon"), get("lat")
        if lon is not None and lat is not None:
            found = regions.time_zone_at(float(lon), float(lat))
            if found:
                return found
        st = get("state")
        if st:
            return regions.main_zone(str(st))
    except Exception:  # noqa: BLE001 - no regions data: UTC labels, never Pacific by default
        pass
    return "UTC"
