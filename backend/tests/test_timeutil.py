"""timeutil.py."""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np

from fire3d import timeutil as tu

T = 1736299800000  # 2025-01-08T01:30:00Z


def test_iso_parsing_variants() -> None:
    assert tu.iso_to_ms("2025-01-08T01:30:00Z") == T
    assert tu.iso_to_ms("2025-01-08T01:30:00.000Z") == T
    assert tu.iso_to_ms("2025-01-08T01:30:00+00:00") == T
    assert tu.iso_to_ms("2025-01-07T17:30:00-08:00") == T
    assert tu.iso_to_ms("2025-01-08T01:30:00") == T            # naive = UTC
    assert tu.iso_to_ms("2025-01-08 01:30:00") == T
    assert tu.iso_to_ms("2025-01-08") == T - 90 * 60 * 1000
    assert tu.iso_to_ms(datetime(2025, 1, 8, 1, 30, tzinfo=timezone.utc)) == T


def test_round_trips_and_floors() -> None:
    assert tu.ms_to_iso(T) == "2025-01-08T01:30:00Z"
    assert tu.ms_to_iso(T + 5) == "2025-01-08T01:30:00.005Z"
    assert tu.ms_to_dt(T) == datetime(2025, 1, 8, 1, 30, tzinfo=timezone.utc)
    assert tu.floor_hour_ms(T) == T - 30 * 60 * 1000
    assert tu.time_origin_for(T) == T - 30 * 60 * 1000 - 3_600_000
    assert abs(tu.now_ms() - datetime.now(timezone.utc).timestamp() * 1000) < 5000


def test_hours_since() -> None:
    assert tu.hours_since(T + 5_400_000, T) == 1.5
    arr = tu.hours_since(np.array([T, T + 3_600_000], dtype=np.int64), T)
    assert arr.dtype == np.float64 and list(arr) == [0.0, 1.0]
    assert tu.hours_to_ms(2.5, T) == T + 9_000_000
