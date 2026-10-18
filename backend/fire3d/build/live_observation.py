"""Latest observation of a live fire: satellite passes that saw nothing count too (SPEC 5.1, 8.3). Owner: backend.

:func:`latest_observation` sets ``time_range.now_ms`` of a live bundle, and with it the default forecast start
(SPEC 6), from:

* ``last_detection_ms``: the newest VIIRS/MODIS/Landsat detection or mapped perimeter of this fire. The burned
  area is known up to here.
* The polar-orbiter passes over the fire since then (:mod:`fire3d.sources.overpass`, NASA CMR). Only *confirmed*
  passes count: their granules were published in CMR at least 30 min before our FIRMS data of the same satellite
  were fetched, so any detection they made is in our data. A confirmed pass after ``last_detection_ms`` therefore
  saw no fire above the detection limit, and the burned area is unchanged up to it.
* A veto: CAL FIRE acreage reported after the last detection that is well above the mapped area
  (> :data:`VETO_RATIO` x + :data:`VETO_MIN_AC`) means the fire grew without being detected (clouds, smoke, a
  missed pass). The burned area at a later pass is then unknown, so ``now_ms`` stays at the last detection.

:func:`activity_markers` collects activity evidence that is too weak or coarse to map burned area:
low-confidence VIIRS/MODIS pixels within 1 km of the burned area and persistent GOES detections of this fire after
the last detection. They never move ``now_ms``; the forecast keeps the perimeter near them active
(``spread.ensemble.held_perimeter``). Everything is written to ``sim/activity.json`` (backend only).
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

import numpy as np
import pandas as pd

from .. import config
from ..sources import overpass
from ..timeutil import HOUR_MS

log = logging.getLogger(__name__)

LOOKBACK_MS = 24 * HOUR_MS            # passes reported before the last detection (context for the hold window)
VETO_RATIO = 1.25                     # CAL FIRE acres > 1.25 x mapped + 100 ac (reported after the last detection)
VETO_MIN_AC = 100.0
MARKER_NEAR_M = 1000.0                # low-confidence pixels within 1 km of the burned area
STATIC_EXCLUDE_M = 600.0              # ... and farther than this from a pre-fire static hot spot
GOES_MIN_SCANS = 2                    # GOES activity = >= 2 detections at different scan times within 1 h
GOES_PERSIST_MS = HOUR_MS
GOES_MARKER_RADIUS_M = 1000.0         # half a GOES pixel: the fire is somewhere inside it
MODIS_MARKER_RADIUS_M = 500.0
ACTIVITY_FILE = "activity.json"       # in the bundle's sim/ directory
SOURCE_NAME = "NASA CMR satellite passes"


@dataclass
class LiveObservation:
    """Result of :func:`latest_observation`."""

    now_ms: int
    last_detection_ms: int
    last_pass_ms: int | None                 # newest confirmed pass over the fire (whatever it saw)
    rule: str                                # "latest_pass" | "last_detection"
    note: str                                # one plain sentence for warnings / data_sources
    passes: list[dict] = field(default_factory=list)       # confirmed passes since last_detection - 24 h, newest first
    quiet_passes: int = 0                    # confirmed passes after the last detection (none saw this fire)
    source: dict | None = None               # data_sources entry
    warnings: list[str] = field(default_factory=list)
    vetoed: str | None = None

    def activity_doc(self, markers: Sequence[dict]) -> dict:
        """The ``sim/activity.json`` document."""
        return {"last_detection_ms": int(self.last_detection_ms), "now_ms": int(self.now_ms),
                "last_pass_ms": self.last_pass_ms, "rule": self.rule, "note": self.note,
                "quiet_passes": int(self.quiet_passes), "vetoed": self.vetoed,
                "passes": self.passes, "markers": list(markers)}


def _la(ms: int) -> str:
    return overpass.la_time(int(ms))


def _hours(ms: float) -> str:
    h = ms / HOUR_MS
    return f"{h:.0f} h" if h >= 2 else f"{max(1, round(ms / 60_000))} min"


def latest_observation(
    last_detection_ms: int,
    lonlat: tuple[float, float],
    det_t_ms: Sequence[int] | np.ndarray,
    det_satellite: Sequence[str] | np.ndarray,
    data_times: dict[str, int],
    wall_ms: int,
    *,
    official_acres: float | None = None,
    official_updated_ms: int | None = None,
    mapped_acres: float | None = None,
    fetch: Callable[..., overpass.PassList] | None = None,
) -> LiveObservation:
    """Decide ``now_ms`` of a live bundle (module doc). ``det_*``: this fire's polar detections (for the per-pass
    counts); ``data_times``: :func:`fire3d.sources.firms.data_times_by_satellite` of the FIRMS data used.
    Never raises: without pass data ``now_ms`` is the last detection, with a warning."""
    fetch = fetch or overpass.fetch_passes
    last = int(min(last_detection_ms, wall_ms))
    lon, lat = float(lonlat[0]), float(lonlat[1])
    try:
        found = fetch(lon, lat, last - LOOKBACK_MS, int(wall_ms), nrt=True)
    except Exception as e:  # noqa: BLE001 - a pass list is optional
        found = overpass.PassList([], [config.mask_secrets(f"{type(e).__name__}: {e}")])
    errors = list(getattr(found, "errors", []) or [])
    fetched_ms = getattr(found, "fetched_ms", None)
    conf = [p for p in found if p.satellite in data_times and overpass.is_confirmed(p, int(data_times[p.satellite]))]
    conf.sort(key=lambda q: (q.t_ms, q.satellite), reverse=True)
    counts = overpass.detections_per_pass(conf, det_t_ms, det_satellite)
    passes = [{**p.as_dict(), "detections": n} for p, n in zip(conf, counts)]
    after = [p for p in conf if p.t_ms > last]
    latest = conf[0] if conf else None
    obs = LiveObservation(now_ms=last, last_detection_ms=last, last_pass_ms=latest.t_ms if latest else None,
                          rule="last_detection", note="", passes=passes[:24], quiet_passes=len(after))
    products = "VIIRS 375 m (Suomi NPP, NOAA-20, NOAA-21) and MODIS (Terra, Aqua) active-fire granules, LANCE NRT"
    if not found and errors:
        obs.note = f"satellite pass times unavailable (NASA CMR: {errors[0]}); the latest observation is the last detection"
        obs.warnings.append(obs.note)
        obs.source = {"name": SOURCE_NAME, "detail": f"unavailable: {'; '.join(errors)[:300]}", "fetched_ms": int(wall_ms)}
        return obs
    missing = sorted(overpass.PRODUCT_BY_SATELLITE[s].label for s in overpass.PRODUCT_BY_SATELLITE if s not in data_times)
    detail_tail = f"{products}; confirmed = published in CMR >= 30 min before our FIRMS data of that satellite"
    if errors:
        detail_tail += f"; {len(errors)} product(s) failed: {'; '.join(errors)[:200]}"
    if missing:
        detail_tail += f"; no FIRMS data time for {', '.join(missing)} (their passes are not used)"
    if latest is None or latest.t_ms <= last:
        obs.note = "no confirmed satellite pass over the fire since the last detection or mapped perimeter"
        if latest is not None:
            obs.note += f" (newest confirmed pass: {latest.describe()})"
        obs.source = {"name": SOURCE_NAME, "detail": f"{obs.note}; {detail_tail}", "fetched_ms": int(fetched_ms or wall_ms)}
        return obs
    # a later confirmed pass exists: the fire was looked at and no new fire was seen
    if (official_acres is not None and mapped_acres is not None and official_updated_ms is not None
            and official_updated_ms > last + HOUR_MS
            and official_acres > VETO_RATIO * mapped_acres + VETO_MIN_AC):
        obs.vetoed = (f"CAL FIRE reported {official_acres:,.0f} ac at {_la(official_updated_ms)}, more than the "
                      f"{mapped_acres:,.0f} ac mapped from satellite data: the fire grew without being detected")
        obs.note = (f"{len(after)} satellite pass(es) since the last detection saw no new fire (latest {latest.describe()}), "
                    f"but {obs.vetoed}, so the latest observation stays at the last detection")
        obs.warnings.append(obs.note)
        obs.source = {"name": SOURCE_NAME, "detail": f"{obs.note}; {detail_tail}", "fetched_ms": int(fetched_ms or wall_ms)}
        return obs
    obs.now_ms = int(min(latest.t_ms, wall_ms))
    obs.rule = "latest_pass"
    n_v = sum(1 for p in after if p.instrument == "VIIRS")
    obs.note = (f"latest observation: {latest.describe()}, {_hours(obs.now_ms - last)} after the last detection "
                f"({_la(last)}); {len(after)} confirmed pass(es) since then ({n_v} VIIRS) saw no new fire, so the "
                "burned area is held at the last mapped extent")
    obs.source = {"name": SOURCE_NAME, "detail": f"{obs.note}; {detail_tail}", "fetched_ms": int(fetched_ms or wall_ms)}
    return obs


def activity_markers(
    all_det: pd.DataFrame | None,
    goes: pd.DataFrame | None,
    burned: np.ndarray,
    res_m: float,
    after_ms: int,
    until_ms: int,
    static_xy: np.ndarray | None = None,
    *,
    half_extent_m: float | None = None,
) -> list[dict]:
    """Activity evidence after ``after_ms`` (the last detection) up to ``until_ms``: low-confidence VIIRS/MODIS
    pixels within 1 km of the burned area (not at static hot spots) and persistent GOES detections of this fire.
    ``all_det`` are the AOI detections WITHOUT the confidence filter (``observed.prepare_detections(...,
    quality=False)``: columns t_ms, x, z, instrument, confidence, satellite); ``goes`` this fire's GOES rows.
    Returns ``[{x, z, t_ms, kind, radius_m, satellite}]`` sorted by time."""
    from scipy import ndimage
    from scipy.spatial import cKDTree

    from ..sources import firms

    out: list[dict] = []
    burned = np.asarray(burned, dtype=bool)
    n_rows, n_cols = burned.shape
    half = float(half_extent_m) if half_extent_m is not None else n_rows * float(res_m) / 2.0
    if all_det is not None and len(all_det) and burned.any():
        d = all_det[(all_det["t_ms"] > after_ms) & (all_det["t_ms"] <= until_ms)
                    & all_det["instrument"].isin(("VIIRS", "MODIS"))]
        if len(d):
            low = ~firms.quality_mask(d).to_numpy(dtype=bool)
            d = d[low]
        if len(d):
            dist = ndimage.distance_transform_edt(~burned) * float(res_m)
            x = d["x"].to_numpy(dtype=np.float64)
            z = d["z"].to_numpy(dtype=np.float64)
            r = np.clip(np.floor((z + half) / res_m).astype(int), 0, n_rows - 1)
            c = np.clip(np.floor((x + half) / res_m).astype(int), 0, n_cols - 1)
            keep = dist[r, c] <= MARKER_NEAR_M
            if static_xy is not None and len(static_xy) and keep.any():
                dd, _ = cKDTree(np.asarray(static_xy, dtype=np.float64)).query(np.c_[x, z])
                keep &= dd > STATIC_EXCLUDE_M
            for row, k in zip(d.itertuples(index=False), keep):
                if k:
                    modis = str(row.instrument) == "MODIS"
                    out.append({"x": round(float(row.x), 1), "z": round(float(row.z), 1), "t_ms": int(row.t_ms),
                                "kind": "modis_low_confidence" if modis else "viirs_low_confidence",
                                "radius_m": MODIS_MARKER_RADIUS_M if modis else 0.0, "satellite": str(row.satellite)})
    if goes is not None and len(goes):
        g = goes[(goes["t_ms"] > after_ms) & (goes["t_ms"] <= until_ms)].sort_values("t_ms", kind="stable")
        t = g["t_ms"].to_numpy(dtype=np.int64)
        if len(np.unique(t)) >= GOES_MIN_SCANS:
            # persistent: another scan time within GOES_PERSIST_MS
            for i, row in enumerate(g.itertuples(index=False)):
                others = t[(t != t[i]) & (np.abs(t - t[i]) <= GOES_PERSIST_MS)]
                if len(others) >= GOES_MIN_SCANS - 1:
                    out.append({"x": round(float(row.x), 1), "z": round(float(row.z), 1), "t_ms": int(row.t_ms),
                                "kind": "goes", "radius_m": GOES_MARKER_RADIUS_M, "satellite": str(row.satellite)})
    out.sort(key=lambda m: (m["t_ms"], m["kind"]))
    return out


def marker_array(doc: dict | None) -> np.ndarray | None:
    """(N, 4) float64 ``x, z, t_ms, radius_m`` of an activity document's markers (None when there are none)."""
    rows = [(float(m["x"]), float(m["z"]), float(m["t_ms"]), float(m.get("radius_m") or 0.0))
            for m in (doc or {}).get("markers") or [] if isinstance(m, dict)
            and all(math.isfinite(float(m.get(k, math.nan))) for k in ("x", "z", "t_ms"))]
    return np.asarray(rows, dtype=np.float64).reshape(-1, 4) if rows else None


def last_activity_ms(doc: dict | None) -> int | None:
    """The newest evidence of activity in an activity document: the last detection or a later marker."""
    if not doc or doc.get("last_detection_ms") is None:
        return None
    t = [int(doc["last_detection_ms"])] + [int(m["t_ms"]) for m in doc.get("markers") or [] if isinstance(m, dict) and "t_ms" in m]
    return max(t)


def describe_start(doc: dict | None, start_ms: int) -> str | None:
    """Forecast warning explaining a live start later than the last detection (None otherwise)."""
    if not doc or doc.get("last_detection_ms") is None:
        return None
    last = int(doc["last_detection_ms"])
    if start_ms <= last + 60_000:
        return None
    if doc.get("rule") == "latest_pass" and abs(int(doc.get("now_ms") or 0) - start_ms) <= 60_000:
        return (f"forecast starts at the latest satellite pass over the fire ({_la(start_ms)}), {_hours(start_ms - last)} "
                f"after the last detection; {int(doc.get('quiet_passes') or 0)} confirmed pass(es) in between saw no new fire, "
                "so the start keeps the last mapped burned area (see docs/validation.md)")
    return (f"forecast starts {_hours(start_ms - last)} after the last detection ({_la(last)}); the burned area is the "
            "last mapped extent")


def official_from(summary: Any) -> tuple[float | None, int | None]:
    """``(acres, updated_ms)`` of a summary (pydantic model or dict)."""
    get = summary.get if isinstance(summary, dict) else (lambda k, d=None: getattr(summary, k, d))
    a, u = get("acres"), get("updated_ms")
    return (float(a) if a is not None else None), (int(u) if u is not None else None)
