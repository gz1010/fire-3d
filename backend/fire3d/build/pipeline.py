"""Bundle build orchestration and live refresh (SPEC 6, 7.3, 8.3, 8.7). Owner: api agent.

``build_incident`` runs the whole bundle build:

    catalog.get_summary -> catalog.estimate_fire_bbox -> grid.make_aoi -> initial manifest (status "building")
    -> build_static_layers -> build_observed -> build_weather -> peak_wind event
    -> spread.behavior.annotate_weather_with_behavior -> (live) spread.ensemble.run_forecast("auto")
    -> status "ready" + built_ms.

Progress goes to ``progress(step, overall_fraction, message)``: ``step`` is one of :data:`STAGES` and the fraction
is the weighted progress of the WHOLE build (0..1). Required steps (catalog, static layers, observed, weather)
turn the manifest into status "error" (masked message in ``warnings``) and re-raise; optional steps (peak_wind,
behaviour annotation, the live forecast) only add a warning.

Concurrency: builds and live refreshes hold an exclusive ``fcntl`` lock on ``<bundle>/.build.lock``, forecasts a
shared one (:func:`bundle_lock`), so a CLI build and the API never write the same bundle at once, and
:func:`build_in_progress` tells a live build from a stale "building" manifest left by a killed process.
Modules owned by other agents are imported lazily, so the API starts even while one of them is broken.
"""

from __future__ import annotations

import fcntl
import logging
import math
import os
import re
import shutil
import time
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Any, Iterator

import numpy as np

from .. import bundle, config
from ..contracts import ForecastManifest, IncidentManifest, IncidentSummary, contract_problems, dump
from ..grid import grids_from_manifest, make_aoi, manifest_grid
from ..timeutil import DAY_MS, HOUR_MS, now_ms, time_origin_for
from ..types import BuildContext, ProgressFn

log = logging.getLogger(__name__)

BUILD_LOCK_NAME = ".build.lock"
BUILD_LOCK_TIMEOUT_S = 3 * 3600.0          # wait this long for another process's build of the same bundle
FORECAST_LOCK_TIMEOUT_S = 3600.0
ERROR_MAX_CHARS = 300
BUNDLE_OUTPUTS = ("detections.json", "perimeters.json", "timeseries.json", "events.json", "weather.json")
BUNDLE_OUTPUT_DIRS = ("layers", "sim", "forecasts")

# Weighted build stages (SPEC: catalog, terrain, fuels, imagery, trees, burn_scar, observations, weather, behavior,
# forecast). Historical builds have no forecast stage; the weights are renormalised.
STAGE_WEIGHTS: dict[str, float] = {
    "catalog": 0.04, "terrain": 0.10, "fuels": 0.06, "imagery": 0.07, "trees": 0.04, "burn_scar": 0.08,
    "observations": 0.21, "weather": 0.09, "behavior": 0.03, "forecast": 0.28,
}
STAGES = tuple(STAGE_WEIGHTS)
STATIC_STAGES = ("terrain", "fuels", "imagery", "trees", "burn_scar")
# Sub-step names that build_static_layers may report -> our stage (substring match, first hit wins).
_STATIC_SYNONYMS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("burn_scar", ("burn", "dnbr", "sentinel", "severity", "scar")),
    ("trees", ("tree",)),
    ("imagery", ("naip", "imagery", "image", "photo", "water", "ndwi")),
    ("fuels", ("fuel", "landfire", "canopy", "fbfm")),
    ("terrain", ("terrain", "dem", "elevation", "relief", "slope", "sky")),
)
REFRESH_STAGES = {"observations": 0.6, "weather": 0.3, "behavior": 0.1}
REFRESH_FAILED_PREFIX = "Live refresh failed"


def spec_incident_id(summary: IncidentSummary) -> str:
    """SPEC 4.4 id of a summary: ``f"{year}-{slug(name)}-{calfire_uid[:6].lower()}"``."""
    slug = re.sub(r"[^a-z0-9]+", "-", str(summary.name or "").strip().lower()).strip("-") or "incident"
    return f"{int(summary.year)}-{slug}-{str(summary.calfire_uid).strip().lower()[:6]}"


def is_catalog_incident(incident_id: str, summary: IncidentSummary | dict | None) -> bool:
    """True when ``summary`` describes a real CAL FIRE incident with this id (its SPEC 4.4 id matches).

    ``catalog.get_summary`` also answers from bundle manifests on disk (e.g. ``fixture-demo``); such bundles are
    served read-only and must never be (re)built or refreshed from their own manifest.
    """
    if summary is None:
        return False
    if isinstance(summary, dict):
        try:
            summary = IncidentSummary.model_validate(summary)
        except ValueError:
            return False
    return summary.id == incident_id and spec_incident_id(summary) == incident_id


def short_error(exc: BaseException) -> str:
    """One-line, secret-masked description of an exception (for job errors and manifest warnings)."""
    msg = " ".join(str(exc).split()) or type(exc).__name__
    text = msg if isinstance(exc, (LookupError, BundleBusy)) else f"{type(exc).__name__}: {msg}"
    text = config.mask_secrets(text)
    return text if len(text) <= ERROR_MAX_CHARS else text[: ERROR_MAX_CHARS - 1] + "…"


# ----------------------------------------------------------------------------------------------------------------
# Bundle locks
# ----------------------------------------------------------------------------------------------------------------
class BundleBusy(RuntimeError):
    """The bundle's build lock could not be taken in time."""


@contextmanager
def bundle_lock(bdir: str | os.PathLike[str], *, shared: bool = False, timeout: float | None = None) -> Iterator[None]:
    """``fcntl`` lock on ``<bundle>/.build.lock``: exclusive for builds/refreshes, shared for forecasts.

    ``timeout=None`` waits forever, ``0`` fails at once; raises :class:`BundleBusy` when it cannot be taken.
    """
    d = Path(bdir)
    d.mkdir(parents=True, exist_ok=True)
    fd = os.open(d / BUILD_LOCK_NAME, os.O_RDWR | os.O_CREAT, 0o644)
    mode = fcntl.LOCK_SH if shared else fcntl.LOCK_EX
    deadline = None if timeout is None else time.monotonic() + max(0.0, timeout)
    try:
        while True:
            try:
                fcntl.flock(fd, mode | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if deadline is not None and time.monotonic() >= deadline:
                    raise BundleBusy(f"bundle {d.name} is busy (another build or refresh is running)") from None
                time.sleep(0.25)
        try:
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def build_in_progress(bdir: str | os.PathLike[str]) -> bool:
    """True when some process holds the bundle's exclusive build lock (a build or live refresh is running)."""
    try:
        fd = os.open(Path(bdir) / BUILD_LOCK_NAME, os.O_RDONLY)
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    else:
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


# ----------------------------------------------------------------------------------------------------------------
# Progress
# ----------------------------------------------------------------------------------------------------------------
class BuildProgress:
    """Maps module progress (step, fraction within step, message) onto weighted, monotone overall progress."""

    def __init__(self, outer: ProgressFn | None, weights: dict[str, float]):
        self.outer = outer
        total = sum(weights.values()) or 1.0
        self.weights = {k: v / total for k, v in weights.items()}
        self.start: dict[str, float] = {}
        acc = 0.0
        for k, w in self.weights.items():
            self.start[k] = acc
            acc += w
        self.value = 0.0
        self._static_stage = STATIC_STAGES[0]

    def report(self, stage: str, fraction: float, message: str = "") -> None:
        """Report ``fraction`` (0..1) of ``stage``."""
        if stage in self.weights:
            f = float(fraction) if math.isfinite(float(fraction)) else 0.0
            v = self.start[stage] + self.weights[stage] * min(max(f, 0.0), 1.0)
            self.value = max(self.value, min(v, 1.0))
        if self.outer is not None:
            try:
                self.outer(stage, round(self.value, 4), config.mask_secrets(message))
            except Exception:  # a broken progress sink must never break the build
                log.debug("progress callback failed", exc_info=True)

    def finish(self, stage: str, message: str = "") -> None:
        """Report the whole job as complete (1.0) under ``stage``."""
        self.value = 1.0
        self.report(stage, 1.0, message)

    def stage_fn(self, stage: str) -> ProgressFn:
        """A ProgressFn for a module whose whole run is one stage (sub-step names go into the message)."""

        def fn(step: str, fraction: float, message: str = "") -> None:
            text = message if not step or step == stage else (f"{step}: {message}" if message else str(step))
            self.report(stage, fraction, text)

        return fn

    def static_fn(self) -> ProgressFn:
        """ProgressFn for build_static_layers: sub-steps are mapped to terrain/fuels/imagery/trees/burn_scar."""

        def fn(step: str, fraction: float, message: str = "") -> None:
            low = str(step).lower()
            for stage, keys in _STATIC_SYNONYMS:
                if any(k in low for k in keys):
                    self._static_stage = stage     # unknown names stay in the current stage; report() is monotone
                    break
            text = message if low == self._static_stage else (f"{step}: {message}" if message else str(step))
            self.report(self._static_stage, fraction, text)

        return fn


def _stage_weights(mode: str) -> dict[str, float]:
    return {k: v for k, v in STAGE_WEIGHTS.items() if mode == "live" or k != "forecast"}


# ----------------------------------------------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------------------------------------------
def _load_json(path: Path) -> Any:
    try:
        return bundle.read_json(path)
    except (OSError, ValueError):
        return None


def _clear_outputs(bdir: Path) -> None:
    """Remove a previous build's outputs (layers, sim, forecasts, JSON files, stray temp files)."""
    for name in BUNDLE_OUTPUT_DIRS:
        shutil.rmtree(bdir / name, ignore_errors=True)
    for name in BUNDLE_OUTPUTS:
        (bdir / name).unlink(missing_ok=True)
    for p in bdir.glob(".*.tmp"):
        p.unlink(missing_ok=True)


def _preliminary_end(summary: IncidentSummary, now: int) -> int:
    """Best guess of time_range.end_ms before build_observed knows it (static layers use it for dNBR windows)."""
    if summary.mode == "live" or summary.is_active:
        return now
    for cand in (summary.contained_ms, summary.updated_ms):
        if cand and cand > summary.started_ms:
            return int(min(cand, summary.started_ms + 45 * DAY_MS, now))
    return int(min(summary.started_ms + 14 * DAY_MS, now))


def _summary_with(summary: IncidentSummary | dict, status: str, built_ms: int | None) -> dict:
    s = dump(summary) if isinstance(summary, IncidentSummary) else dict(summary)
    s["bundle_status"] = status
    s["bundle_built_ms"] = built_ms
    return s


def _stats_from_files(bdir: Path, m: dict) -> dict:
    """Fallback ``stats`` when build_observed did not set them."""
    acres = 0.0
    try:
        arr = bundle.read_layer(bdir, "observed_arrival", m)
        res = float(m["grid"]["fire"]["res_m"])
        acres = float(np.count_nonzero(arr < config.NEVER * 0.5)) * res * res / config.ACRE_M2
    except (KeyError, OSError, ValueError):
        pass
    det = _load_json(bdir / "detections.json") or {}
    per = _load_json(bdir / "perimeters.json") or {}
    return {"final_acres_observed": round(acres, 1), "detections": len(det.get("detections") or []), "perimeters": len(per.get("perimeters") or [])}


def _set_status_error(bdir: Path, exc: BaseException, prefix: str = "Build failed") -> None:
    msg = f"{prefix}: {short_error(exc)}"

    def fn(m: dict) -> None:
        m["status"] = "error"
        warnings = m.setdefault("warnings", [])
        if msg not in warnings:
            warnings.append(msg)
        if isinstance(m.get("summary"), dict):
            m["summary"]["bundle_status"] = "error"
            m["summary"]["bundle_built_ms"] = None

    try:
        bundle.update_manifest(bdir, fn)
    except Exception:  # pragma: no cover - disk full etc.; the original error matters more
        log.exception("could not mark %s as failed", bdir.name)


def add_warning(bdir: Path, message: str) -> None:
    """Append a (masked) warning to the manifest once."""
    msg = config.mask_secrets(message)

    def fn(m: dict) -> None:
        warnings = m.setdefault("warnings", [])
        if msg not in warnings:
            warnings.append(msg)

    bundle.update_manifest(bdir, fn)


def _cardinal(deg: float) -> str:
    names = ("N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW")
    return names[int(((deg % 360.0) + 11.25) // 22.5) % 16]


def add_peak_wind_event(bdir: str | os.PathLike[str]) -> dict | None:
    """Add the ``peak_wind`` event (SPEC 8.3): the max 10 m gust at the fire during hours the fire grew.

    Growth hours come from timeseries.json (``growth_acres_per_h > 0``; the observed period otherwise). The event is
    placed at the centroid of the pixels burning around that hour. Replaces an existing peak_wind event; returns
    the event or None when there is no usable weather.
    """
    bdir = Path(bdir)
    m = bundle.load_manifest(bdir) or {}
    weather = _load_json(bdir / "weather.json")
    events_doc = _load_json(bdir / "events.json")
    if not weather or not isinstance(events_doc, dict):
        return None
    at = weather.get("at_fire") or {}
    t_w = np.asarray(weather.get("t_ms") or [], dtype=np.int64)
    gust = np.asarray(at.get("wind_gust_ms") or [], dtype=np.float64)
    speed = np.asarray(at.get("wind_speed_ms") or [], dtype=np.float64)
    wdir = np.asarray(at.get("wind_dir_deg") or [], dtype=np.float64)
    if t_w.size == 0 or gust.size != t_w.size:
        return None
    if not np.isfinite(gust).any() and speed.size == t_w.size:
        gust = speed
    tr = m.get("time_range") or {}
    lo, hi = int(tr.get("start_ms", t_w[0])), int(tr.get("now_ms", tr.get("end_ms", t_w[-1])))
    mask = (t_w >= lo) & (t_w <= hi)
    growth_by_t: dict[int, float] = {}
    ts = _load_json(bdir / "timeseries.json")
    if isinstance(ts, dict) and ts.get("t_ms") and ts.get("growth_acres_per_h"):
        t_ts = np.asarray(ts["t_ms"], dtype=np.int64)
        growth = np.asarray(ts["growth_acres_per_h"], dtype=np.float64)
        if t_ts.size == growth.size:
            grow_t = t_ts[growth > 0]
            growth_by_t = {int(t): float(g) for t, g in zip(t_ts, growth)}
            if grow_t.size:
                in_growth = np.isin(t_w, grow_t)
                if not (in_growth & np.isfinite(gust)).any():   # misaligned hours: use the growth window
                    in_growth = (t_w >= grow_t.min()) & (t_w <= grow_t.max())
                mask &= in_growth
    cand = np.where(mask & np.isfinite(gust))[0]
    if cand.size == 0:
        return None
    i = int(cand[np.argmax(gust[cand])])
    t_peak, g = int(t_w[i]), float(gust[i])
    direction = float(wdir[i]) if wdir.size == t_w.size and np.isfinite(wdir[i]) else None

    x = z = None
    try:
        arr = bundle.read_layer(bdir, "observed_arrival", m)
        _, fire = grids_from_manifest(m)
        th = (t_peak - int(m["time_origin_ms"])) / HOUR_MS
        for window in (1.0, 3.0, 12.0):
            r, c = np.nonzero((arr > th - window) & (arr <= th + window))
            if r.size:
                x, z = fire.pixel_center_local(r, c)
                x, z = float(np.mean(x)), float(np.mean(z))
                break
    except (KeyError, OSError, ValueError, TypeError):
        pass
    if x is None and isinstance(m.get("ignition"), dict):
        x, z = float(m["ignition"]["x"]), float(m["ignition"]["z"])

    mph = g * 2.236936
    detail = f"Gust {mph:.0f} mph ({g:.1f} m/s)"
    if direction is not None:
        detail += f" from {_cardinal(direction)} ({direction:.0f}°)"
    grew = growth_by_t.get(t_peak)
    detail += f" while the fire grew {grew:,.0f} ac/h." if grew and grew > 0 else " during fire growth."
    source = str(weather.get("source") or "weather")
    event: dict[str, Any] = {
        "id": "ev-peak-wind", "type": "peak_wind", "t_ms": t_peak, "title": "Peak wind", "detail": detail,
        "confidence": "estimated", "source": f"{source} (10 m gust at the fire)",
    }
    if x is not None and z is not None:
        event["x"], event["z"] = round(x, 1), round(z, 1)
    events = [e for e in (events_doc.get("events") or []) if isinstance(e, dict) and e.get("type") != "peak_wind"]
    events.append(event)
    events.sort(key=lambda e: int(e.get("t_ms") or 0))
    events_doc["events"] = events
    bundle.write_json(bdir / "events.json", events_doc)
    return event


BURN_SEVERITY_MARGIN_M = 1000.0


def mask_burn_severity(bdir: str | os.PathLike[str], margin_m: float = BURN_SEVERITY_MARGIN_M) -> int:
    """Limit ``burn_severity`` (Sentinel-2 dNBR) to this incident: pixels farther than ``margin_m`` from its observed
    burned area become nodata. The post-fire composite can also show other fires' scars (Madre 2025's window holds
    the later Gifford fire) and harvested fields, which must not read as this fire's severity. Returns the number
    of pixels masked (0 when the layer or the observed arrival is missing)."""
    from scipy import ndimage

    bdir = Path(bdir)
    m = bundle.load_manifest(bdir) or {}
    lay = m.get("layers") or {}
    if "burn_severity" not in lay or "observed_arrival" not in lay:
        return 0
    from ..sources.sentinel import NODATA

    d = bundle.read_layer(bdir, "burn_severity", m).astype(np.float32)
    obs = bundle.read_layer(bdir, "observed_arrival", m)
    burned = obs < config.NEVER * 0.5
    if d.shape != burned.shape or not burned.any():
        return 0
    res = float(m["grid"]["fire"]["res_m"])
    near = ndimage.distance_transform_edt(~burned) * res <= margin_m
    drop = ~near & (d != NODATA)
    if not drop.any():
        return 0
    d[drop] = NODATA
    info = lay["burn_severity"]
    desc = str(info.get("description", ""))
    note = f"; limited to this incident's observed burned area + {margin_m / 1000:g} km (nodata elsewhere)"
    bundle.write_layer(bdir, "burn_severity", d, "fire", info.get("units", "dNBR"),
                       desc if note in desc else desc + note, nodata=NODATA)
    return int(drop.sum())


def has_new_detections(manifest: dict, detections: Any) -> bool:
    """True when ``detections`` (DataFrame with t_ms/lat/lon) has a detection inside the AOI after now_ms."""
    if detections is None or len(detections) == 0:
        return False
    try:
        w, s, e, n = manifest["grid"]["bbox_lonlat"]
        now = int((manifest.get("time_range") or {}).get("now_ms") or 0)
        sel = (detections["lon"] >= w) & (detections["lon"] <= e) & (detections["lat"] >= s) & (detections["lat"] <= n) & (detections["t_ms"] > now + 60_000)
        return bool(np.asarray(sel).any())
    except (KeyError, TypeError, ValueError):
        return False


def _validate(m: dict) -> IncidentManifest:
    problems = contract_problems(IncidentManifest, m)
    if problems:
        log.warning("manifest %s has %d contract problem(s): %s", m.get("id"), len(problems), "; ".join(problems[:8]))
    return IncidentManifest.model_validate(m)


# ----------------------------------------------------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------------------------------------------------
def build_incident(incident_id: str, progress: ProgressFn | None = None, force: bool = False) -> IncidentManifest:
    """Build (or with ``force`` rebuild) the bundle of ``incident_id``; returns the final manifest.

    Without ``force`` an already "ready" bundle is returned untouched. Raises ``LookupError`` for an incident the
    catalog does not know, :class:`BundleBusy` when another process keeps building it, and re-raises any build
    failure after marking the manifest "error".
    """
    bdir = bundle.bundle_dir(incident_id)
    prog = BuildProgress(progress, STAGE_WEIGHTS)
    existing = _read_manifest(bdir)
    if existing and existing.get("status") == "ready" and not force:
        prog.finish("catalog", "bundle already built (use force to rebuild)")
        return IncidentManifest.model_validate(existing)
    prog.report("catalog", 0.0, "looking up the incident")
    from .. import catalog

    summary = catalog.get_summary(incident_id)
    if isinstance(summary, dict):
        summary = IncidentSummary.model_validate(summary)
    if summary is None:
        raise LookupError(f"unknown incident {incident_id!r}: not in the CAL FIRE catalog")
    if not is_catalog_incident(incident_id, summary):
        raise LookupError(f"incident {incident_id!r} is not a CAL FIRE catalog incident (bundle-only), so it cannot be (re)built")
    with ExitStack() as stack:
        try:
            stack.enter_context(bundle_lock(bdir, timeout=0))
        except BundleBusy:
            prog.report("catalog", 0.0, "waiting for another build of this incident to finish")
            stack.enter_context(bundle_lock(bdir, timeout=BUILD_LOCK_TIMEOUT_S))
        existing = _read_manifest(bdir)
        if existing and existing.get("status") == "ready" and not force:     # built by someone else meanwhile
            prog.finish("catalog", "bundle already built")
            return IncidentManifest.model_validate(existing)
        return _build_locked(bdir, summary, BuildProgress(progress, _stage_weights(summary.mode)))


def _read_manifest(bdir: Path) -> dict | None:
    """The manifest dict, or None when missing or unreadable (a corrupt manifest is rebuilt)."""
    try:
        m = bundle.load_manifest(bdir) if bdir.is_dir() else None
    except (OSError, ValueError):
        return None
    return m if isinstance(m, dict) else None


def _build_locked(bdir: Path, summary: IncidentSummary, prog: BuildProgress) -> IncidentManifest:
    from .. import catalog
    from ..build.aoi import build_static_layers
    from ..build.observed import build_observed
    from ..build.weather_bundle import build_weather

    mode = summary.mode
    t_start = now_ms()
    warnings: list[str] = []
    prog.report("catalog", 0.3, "estimating the fire extent")
    bbox = None
    try:
        bbox = catalog.estimate_fire_bbox(summary)
    except Exception as e:  # sizing falls back to the acres circle
        log.warning("estimate_fire_bbox(%s) failed: %s", summary.id, config.mask_secrets(e))
        warnings.append(f"Fire extent estimate failed ({short_error(e)}); AOI sized from the reported acres.")
    render, fire = make_aoi(summary.lon, summary.lat, bbox, mode, acres=summary.acres)
    prog.report("catalog", 0.8, f"AOI {render.extent_m / 1000:g} km, fire grid {fire.width}², {render.crs}")

    _clear_outputs(bdir)
    time_origin = time_origin_for(summary.started_ms)
    building_summary = IncidentSummary.model_validate(_summary_with(summary, "building", None))
    initial = {
        "schema_version": 1, "id": summary.id, "name": summary.name, "mode": mode, "status": "building",
        "summary": dump(building_summary), "time_origin_ms": time_origin,
        "grid": manifest_grid(render, fire, 0.0, 0.0),
        "layers": {}, "data_sources": [
            {"name": "CAL FIRE incidents", "detail": "incidents.fire.ca.gov IncidentApi/List (incident point, acres, dates)", "fetched_ms": t_start},
        ],
        "forecasts": [], "warnings": warnings,
    }
    bundle.update_manifest(bdir, lambda m: initial)
    # Until build_observed sets time_range: end_ms = best guess (static layers use it for the post-fire dNBR window);
    # now_ms = wall clock for live and unset for historical (static layers clip imagery windows to it).
    prelim_end = _preliminary_end(summary, t_start)
    ctx = BuildContext(
        summary=building_summary, bundle_dir=bdir, render_grid=render, fire_grid=fire, time_origin_ms=time_origin,
        mode=mode, progress=prog.static_fn(), fire_bbox_lonlat=tuple(bbox) if bbox else None,
        end_ms=prelim_end, now_ms=t_start if mode == "live" else None,
    )
    prog.report("catalog", 1.0, "bundle initialised")
    try:
        prog.report("terrain", 0.0, "static layers: terrain, fuels, imagery, trees, burn scar")
        build_static_layers(ctx)
        prog.report("burn_scar", 1.0, "static layers done")

        ctx.progress = prog.stage_fn("observations")
        prog.report("observations", 0.0, "fire detections, perimeters, arrival time")
        build_observed(ctx)
        tr = (bundle.load_manifest(bdir) or {}).get("time_range")
        if not isinstance(tr, dict) or "end_ms" not in tr:
            raise RuntimeError("build_observed did not set time_range")
        ctx.end_ms, ctx.now_ms = int(tr["end_ms"]), int(tr.get("now_ms", tr["end_ms"]))
        try:
            mask_burn_severity(bdir)
        except Exception as e:  # the layer is optional
            log.warning("%s: burn severity masking failed: %s", bdir.name, config.mask_secrets(e))
        prog.report("observations", 1.0, "observed spread reconstructed")

        ctx.progress = prog.stage_fn("weather")
        prog.report("weather", 0.0, "weather and fuel moisture")
        build_weather(ctx)
        prog.report("weather", 1.0, "weather done")
    except BaseException as e:
        _set_status_error(bdir, e)
        raise

    try:
        _optional_steps(bdir, prog, mode)
        built = now_ms()

        def finalize(m: dict) -> None:
            m["status"] = "ready"
            m["built_ms"] = built
            m["summary"] = _summary_with(m.get("summary") or summary, "ready", built)
            m.setdefault("ignition", None)
            m.setdefault("default_profile_path", [])
            m.setdefault("data_sources", [])
            m.setdefault("forecasts", [])
            m.setdefault("warnings", [])
            m.setdefault("fuels_edition", "LF2025" if mode == "live" else "LF2024")
            if not isinstance(m.get("stats"), dict):
                m["stats"] = _stats_from_files(bdir, m)

        final = bundle.update_manifest(bdir, finalize)
        model = _validate(final)
    except BaseException as e:
        _set_status_error(bdir, e)
        raise
    prog.finish("forecast" if mode == "live" else "behavior", f"bundle ready in {(now_ms() - t_start) / 1000:.0f} s")
    return model


def _optional_steps(bdir: Path, prog: BuildProgress, mode: str, *, forecast: bool = True) -> None:
    """peak_wind event, behaviour annotation and (live) the forecast: failures only add warnings."""
    try:
        ev = add_peak_wind_event(bdir)
        if ev is None:
            log.info("%s: no peak_wind event (no weather or growth hours)", bdir.name)
    except Exception as e:
        log.warning("%s: peak_wind event failed: %s", bdir.name, config.mask_secrets(e))
        add_warning(bdir, f"Peak wind event skipped: {short_error(e)}")
    prog.report("behavior", 0.0, "fire behaviour potential at the fire")
    try:
        from ..spread.behavior import annotate_weather_with_behavior

        annotate_weather_with_behavior(bdir)
    except Exception as e:
        log.warning("%s: behaviour annotation failed: %s", bdir.name, config.mask_secrets(e))
        add_warning(bdir, f"Fire behaviour annotation skipped: {short_error(e)}")
    prog.report("behavior", 1.0, "behaviour done")
    if mode != "live" or not forecast or "forecast" not in prog.weights:
        return
    prog.report("forecast", 0.0, "72 h ensemble forecast")
    try:
        from ..spread.ensemble import run_forecast

        sub = _SubProgress(prog, "forecast")
        fm = run_forecast(bdir, start_ms=None, horizon_h=72, ensemble="auto", progress=sub)
        prog.report("forecast", 1.0, f"forecast {getattr(fm, 'run_id', '')} ready")
    except Exception as e:
        log.warning("%s: live forecast failed: %s", bdir.name, config.mask_secrets(e))
        add_warning(bdir, f"Live forecast failed: {short_error(e)}")


class _SubProgress:
    """Callee steps with unknown names inside one build stage: each new step takes half of what is left."""

    def __init__(self, prog: BuildProgress, stage: str):
        self.prog, self.stage = prog, stage
        self.steps: dict[str, tuple[float, float]] = {}
        self.last: str | None = None
        self.value = 0.0

    def __call__(self, step: str, fraction: float, message: str = "") -> None:
        step = str(step)
        rec = self.steps.get(step)
        if rec is None:
            prev = self.steps.get(self.last) if self.last else None
            base = max(self.value, prev[0] + prev[1]) if prev else self.value
            rec = self.steps[step] = (min(base, 0.98), (0.98 - min(base, 0.98)) * 0.5)
        self.last = step
        f = float(fraction) if math.isfinite(float(fraction)) else 0.0
        self.value = max(self.value, rec[0] + rec[1] * min(max(f, 0.0), 1.0))
        self.prog.report(self.stage, self.value, f"{step}: {message}" if message else step)


# ----------------------------------------------------------------------------------------------------------------
# Live refresh (SPEC 8.7) and forecasts
# ----------------------------------------------------------------------------------------------------------------
def refresh_live(incident_id: str, progress: ProgressFn | None = None, *, detections: Any = None, force: bool = False) -> bool:
    """Re-run observed + weather (+ peak wind, behaviour) for a ready live bundle when FIRMS has detections inside
    the AOI newer than ``time_range.now_ms`` (or always with ``force``). True when the bundle was refreshed.

    ``detections`` is a FIRMS DataFrame (t_ms, lat, lon); None loads the keyless 48 h feeds. A refresh never changes
    the AOI or time origin; it bumps ``built_ms`` so clients refetch the files. Skips (False) when the bundle is
    busy, not live, or not ready.
    """
    bdir = bundle.bundle_dir(incident_id)
    m = _read_manifest(bdir)
    if not m or m.get("mode") != "live" or m.get("status") != "ready":
        return False
    if not force:
        if detections is None:
            try:
                from ..sources import firms

                detections = firms.load_live_ca(days=2)
            except Exception as e:
                log.warning("refresh_live(%s): FIRMS live feeds unavailable: %s", incident_id, config.mask_secrets(e))
                return False
        if not has_new_detections(m, detections):
            return False
    with ExitStack() as stack:
        try:
            stack.enter_context(bundle_lock(bdir, timeout=0))
        except BundleBusy:
            log.info("refresh_live(%s): bundle busy, skipped", incident_id)
            return False
        return _refresh_locked(incident_id, bdir, progress)


def _refresh_locked(incident_id: str, bdir: Path, progress: ProgressFn | None) -> bool:
    from .. import catalog
    from ..build.observed import build_observed
    from ..build.weather_bundle import build_weather

    m = bundle.load_manifest(bdir) or {}
    if m.get("mode") != "live" or m.get("status") != "ready":
        return False
    summary: IncidentSummary | None = None
    try:
        summary = catalog.get_summary(incident_id)
    except Exception as e:
        log.warning("refresh_live(%s): catalog lookup failed: %s", incident_id, config.mask_secrets(e))
    if isinstance(summary, dict):
        summary = IncidentSummary.model_validate(summary)
    if summary is not None and summary.mode != "live":
        log.info("refresh_live(%s): incident is no longer live; not refreshed", incident_id)
        return False
    summary = summary or IncidentSummary.model_validate(m["summary"])
    if not is_catalog_incident(incident_id, summary):
        log.info("refresh_live(%s): not a CAL FIRE catalog incident (bundle-only); not refreshed", incident_id)
        return False
    prog = BuildProgress(progress, REFRESH_STAGES)
    render, fire = grids_from_manifest(m)
    bbox = None
    try:
        bbox = catalog.estimate_fire_bbox(summary)
    except Exception as e:
        log.info("refresh_live(%s): fire bbox unavailable: %s", incident_id, config.mask_secrets(e))
    t_now = now_ms()
    ctx = BuildContext(
        summary=IncidentSummary.model_validate(_summary_with(summary, "ready", m.get("built_ms"))), bundle_dir=bdir,
        render_grid=render, fire_grid=fire, time_origin_ms=int(m["time_origin_ms"]), mode="live",
        progress=prog.stage_fn("observations"), fire_bbox_lonlat=tuple(bbox) if bbox else None, end_ms=t_now, now_ms=t_now,
    )
    try:
        prog.report("observations", 0.0, "new detections: rebuilding the observed spread")
        build_observed(ctx)
        tr = (bundle.load_manifest(bdir) or {}).get("time_range") or {}
        ctx.end_ms, ctx.now_ms = int(tr.get("end_ms", t_now)), int(tr.get("now_ms", t_now))
        ctx.progress = prog.stage_fn("weather")
        prog.report("weather", 0.0, "refreshing weather")
        build_weather(ctx)
    except BaseException as e:
        try:
            add_warning(bdir, f"{REFRESH_FAILED_PREFIX} at {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}: {short_error(e)}")
        except Exception:
            log.exception("could not record the refresh failure for %s", incident_id)
        raise
    _optional_steps(bdir, prog, "live", forecast=False)
    built = now_ms()

    def finalize(m2: dict) -> None:
        m2["status"] = "ready"
        m2["built_ms"] = built
        m2["summary"] = _summary_with(summary, "ready", built)
        m2["warnings"] = [w for w in m2.get("warnings") or [] if not str(w).startswith(REFRESH_FAILED_PREFIX)]

    final = bundle.update_manifest(bdir, finalize)
    _validate(final)
    prog.finish("behavior", "live bundle refreshed")
    return True


def run_forecast_locked(
    incident_id: str,
    start_ms: int | None = None,
    horizon_h: int = 72,
    ensemble: str = "auto",
    members: int | None = None,
    progress: ProgressFn | None = None,
) -> ForecastManifest:
    """``spread.ensemble.run_forecast`` on a ready bundle under the shared bundle lock (never during a build)."""
    from ..spread.ensemble import run_forecast

    bdir = bundle.bundle_dir(incident_id)
    with bundle_lock(bdir, shared=True, timeout=FORECAST_LOCK_TIMEOUT_S):
        m = bundle.load_manifest(bdir)
        if not m or m.get("status") != "ready":
            raise RuntimeError(f"bundle {incident_id} is not ready")
        return run_forecast(bdir, start_ms=start_ms, horizon_h=horizon_h, ensemble=ensemble, members=members, progress=progress)
