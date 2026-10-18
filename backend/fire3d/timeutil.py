"""Time helpers. All JSON timestamps are integer epoch milliseconds UTC (SPEC 4.2)."""

from __future__ import annotations

import time
from datetime import date, datetime, timezone
from typing import overload

import numpy as np

HOUR_MS = 3_600_000
DAY_MS = 24 * HOUR_MS


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
