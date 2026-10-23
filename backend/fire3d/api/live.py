"""Live refresh loop and auto-build (SPEC 8.7). Owner: api agent.

``live_refresh_loop`` (an asyncio task started by the API when FIRE3D_LIVE=1) runs one cycle every 15 min:

1. refresh the national live list (``catalog.get_catalog("live", refresh=True)``: every active wildfire of the lower
   48, CAL FIRE the record in California, NIFC WFIGS elsewhere; brief 3) and the national FIRMS 7-day feeds
   (``firms.load_live_us(days=7)``);
2. copy each record's current acres, containment, update time and status into every ready live bundle's manifest
   summary, and the whole record identity when the listed row is now another agency's record (an id pinned to a
   bundle built under the fire's NIFC WFIGS id; :func:`sync_live_summaries`: local writes only, no extra request for
   listed incidents);
3. for every ready live bundle of a still-active incident with detections newer than its ``now_ms`` (or a bundle
   older than :data:`STALE_REFRESH_H`), queue a ``refresh`` job: ``pipeline.refresh_live`` re-runs
   build_observed + build_weather, then a forecast job is queued when the newest forecast is older than 3 h or the
   burned area changed by more than 2 % (the forecast pool runs one forecast at a time). After a live forecast,
   :func:`prune_live_forecasts` keeps the newest :data:`KEEP_LIVE_FORECASTS` runs (disk stays bounded).

On the first successful cycle (and while FIRE3D_AUTO_BUILD_LIVE=1) up to 4 live incidents with >= 100 acres and
detections in the last 48 h are built, one after another, chosen from the whole lower-48 live list (BRIEF-3 round 2
item 4). All heavy work runs in jobs or worker threads; the loop itself only schedules.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .. import bundle, config
from ..contracts import IncidentSummary, LiveStatus
from ..grid import fallback_radius_m
from ..timeutil import HOUR_MS, now_ms
from .jobs import FORECAST_STEP_WEIGHTS, JobManager, get_manager

log = logging.getLogger(__name__)

REFRESH_INTERVAL_S = float(os.environ.get("FIRE3D_LIVE_INTERVAL_S", "") or 15 * 60.0)   # SPEC 8.7: 15 min (env for tests)
AUTO_BUILD_MAX = 4
AUTO_BUILD_MIN_ACRES = 100.0
AUTO_BUILD_WINDOW_H = 48.0
AUTO_BUILD_POLL_S = 3.0
FORECAST_MAX_AGE_H = 3.0
FORECAST_AREA_CHANGE = 0.02
STALE_REFRESH_H = 3.0
COUNTS_TTL_S = 10 * 60.0
COUNTS_WAIT_S = 2.0
# Record fields copied into live bundle summaries each cycle (identity, mode and bundle fields stay); brief 3 adds
# the other agencies' records and the active sources (a California fire's records can disagree, round 3 item 2)
SUMMARY_SYNC_FIELDS = ("acres", "percent_contained", "updated_ms", "contained_ms", "is_active", "county", "location",
                       "admin_unit", "url", "lat", "lon", "detections_24h", "active_sources", "other_records",
                       "complex_members", "irwin_id", "gacc", "accuracy_region")
# Whose record the row is. Copied as well when the fresh row is another agency's record than the bundle summary's
# (CONTRACT 14.2 "Id pinning": a bundle built under a fire's NIFC WFIGS id that CAL FIRE lists later keeps its id, and
# its summary becomes CAL FIRE's record whole; never CAL FIRE's numbers and link under the WFIGS issuer). The id stays;
# the start time and year are the record's too (what the next refresh writes; the bundle keeps its time_origin_ms).
RECORD_IDENTITY_FIELDS = ("name", "source_name", "record_source", "record_issuer", "uid", "calfire_uid", "agency",
                          "agency_code", "unique_fire_id", "aliases", "complex_name", "state", "time_zone",
                          "started_ms", "year")
KEEP_LIVE_FORECASTS = 4            # newest ready runs kept per live bundle by the live loop ...
PRUNE_MIN_AGE_H = 6.0              # ... and every run issued in the last 6 h
PRUNE_GRACE_S = 3600.0             # unlisted run directories are deleted only after this (open views keep working)


@dataclass
class LiveState:
    """What ``GET /api/live/status`` reports (plus internals)."""

    running: bool = False
    last_refresh_ms: int | None = None
    next_refresh_ms: int | None = None
    active_incidents: int | None = None
    detections_24h_ca: int | None = None
    detections_24h: int | None = None           # brief 3: lower 48 (FIRMS feed rows of the last 24 h in the states)
    counts_ms: int | None = None
    last_error: str | None = None
    auto_build_done: bool = False
    auto_build_ids: list[str] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)


STATE = LiveState()


def live_status() -> LiveStatus:
    """Status for ``GET /api/live/status``. Without the loop, the counts are filled lazily in the background."""
    st = STATE
    if not st.running and (st.counts_ms is None or time.time() * 1000 - st.counts_ms > COUNTS_TTL_S * 1000):
        _refresh_counts_in_background()
    return LiveStatus(
        last_refresh_ms=st.last_refresh_ms,
        next_refresh_ms=st.next_refresh_ms if st.running else None,
        active_incidents=int(st.active_incidents or 0),
        detections_24h_ca=st.detections_24h_ca,
        auto_build=bool(st.running and config.AUTO_BUILD_LIVE),
        detections_24h=st.detections_24h,
    )


_counts_thread: threading.Thread | None = None


def _refresh_counts_in_background(wait_s: float = COUNTS_WAIT_S) -> None:
    """Refresh the counts in a daemon thread, waiting up to ``wait_s`` (cached catalogs answer at once)."""
    global _counts_thread
    with STATE.lock:
        if _counts_thread is not None and _counts_thread.is_alive():
            return
        STATE.counts_ms = now_ms()          # one attempt per TTL, even when it fails
        _counts_thread = threading.Thread(target=_refresh_counts, name="fire3d-live-counts", daemon=True)
        _counts_thread.start()
        t = _counts_thread
    t.join(wait_s)


def _refresh_counts() -> None:
    """active_incidents + detections_24h + detections_24h_ca from the (cached) catalog and FIRMS feeds."""
    from .. import catalog

    try:
        STATE.active_incidents = len(catalog.get_catalog("live"))
    except Exception as e:
        log.info("live counts: catalog unavailable: %s", config.mask_secrets(e))
    try:
        n = detections_24h_ca()
        if n is not None:
            STATE.detections_24h_ca = n
    except Exception as e:
        log.info("live counts: FIRMS feeds unavailable: %s", config.mask_secrets(e))
    try:
        n = detections_24h_us()
        if n is not None:
            STATE.detections_24h = n
    except Exception as e:
        log.info("live counts: national FIRMS feeds unavailable: %s", config.mask_secrets(e))
    STATE.counts_ms = now_ms()


def detections_24h_ca(dets_7d: Any = None) -> int | None:
    """California detections of the keyless 24 h FIRMS feeds: the catalog's total (the same feeds that give each
    incident's detections_24h) when available, else counted from ``dets_7d`` / the 24 h feeds."""
    from .. import catalog

    total = getattr(catalog, "live_detections_24h_total", None)
    if callable(total):
        n = total()
        if n is not None:
            return int(n)
    if dets_7d is not None:
        return _count_24h(dets_7d, california=True)
    from ..sources import firms

    return _count_24h(firms.load_live_us(days=1), california=True)


def detections_24h_us(dets_7d: Any = None) -> int | None:
    """Lower-48 detections of the keyless 24 h FIRMS feeds (``LiveStatus.detections_24h``): rows of
    ``load_live_us(days=1)`` inside the lower-48 state polygons; the catalog's total (the same feed) when available,
    else counted from ``dets_7d`` (the cycle's 7-day feed, last 24 h) or a fresh ``load_live_us(days=1)``."""
    from .. import catalog

    total = getattr(catalog, "live_detections_24h_us_total", None)
    if callable(total):
        try:
            n = total()
        except Exception as e:  # noqa: BLE001 - fall back to counting the feed
            log.info("live counts: catalog total unavailable: %s", config.mask_secrets(e))
            n = None
        if n is not None:
            return int(n)
    if dets_7d is not None:
        return _count_24h(dets_7d, lower48=True)
    from ..sources import firms

    return _count_24h(firms.load_live_us(days=1), lower48=True)


def _count_24h(dets: Any, *, california: bool = False, lower48: bool = False) -> int | None:
    """Rows of the last 24 h, inside California (``catalog.CA_OUTLINE``, the SPEC's CA box first) or inside the
    lower-48 state polygons when asked."""
    if dets is None:
        return None
    try:
        recent = np.asarray(dets["t_ms"], dtype=np.int64) >= now_ms() - 24 * HOUR_MS
        if not (california or lower48):
            return int(recent.sum())
        lat = np.asarray(dets["lat"], dtype=np.float64)[recent]
        lon = np.asarray(dets["lon"], dtype=np.float64)[recent]
    except (KeyError, TypeError, ValueError):
        return None
    if lower48:
        from .. import regions

        return int(regions.in_lower48(lon, lat).sum())
    from .. import catalog

    w, s, e, n = config.CA_BBOX
    box = (lon >= w) & (lon <= e) & (lat >= s) & (lat <= n)
    return int(catalog.in_california(lat[box], lon[box]).sum())


# ----------------------------------------------------------------------------------------------------------------
# One cycle
# ----------------------------------------------------------------------------------------------------------------
def fetch_cycle_data() -> tuple[list[IncidentSummary], Any]:
    """Fresh national live list + the national FIRMS 7-day detections (``load_live_us(days=7)``; None if the feeds
    fail)."""
    from .. import catalog

    rows = [IncidentSummary.model_validate(s) if isinstance(s, dict) else s for s in catalog.get_catalog("live", refresh=True)]
    summaries = [s for s in rows if s.mode == "live"]
    dets = None
    try:
        from ..sources import firms

        dets = firms.load_live_us(days=7)
    except Exception as e:
        log.warning("live refresh: FIRMS feeds unavailable: %s", config.mask_secrets(e))
    return summaries, dets


def _live_bundles() -> list[dict]:
    return [m for m in bundle.list_bundles() if m.get("mode") == "live" and m.get("status") == "ready"]


def record_identity(summary: dict) -> tuple[str, str]:
    """``(record_source, uid)`` of a summary dict, with the CONTRACT 14.1 defaults of old manifests (no
    ``record_source``: "calfire"; no ``uid``: ``calfire_uid``); the uid upper case without braces."""
    src = summary.get("record_source") or "calfire"
    uid = summary.get("uid") if "uid" in summary else summary.get("calfire_uid")
    return str(src), str(uid or "").strip().strip("{}").upper()


def summary_changes(current: dict, fresh: IncidentSummary | dict) -> dict:
    """The :data:`SUMMARY_SYNC_FIELDS` whose fresh value (the record's: CAL FIRE or NIFC WFIGS) differs from the bundle
    summary's. When the fresh row is another record than the summary's (:func:`record_identity` differs: an id pinned
    to a bundle built under the fire's WFIGS id, CONTRACT 14.2), the :data:`RECORD_IDENTITY_FIELDS` are added, so the
    numbers, the link and the issuer always come from one record."""
    f = fresh.model_dump(mode="json") if isinstance(fresh, IncidentSummary) else dict(fresh)
    keys = SUMMARY_SYNC_FIELDS
    if record_identity(f) != record_identity(current):
        keys = SUMMARY_SYNC_FIELDS + RECORD_IDENTITY_FIELDS
    return {k: f.get(k) for k in keys if k in f and f.get(k) != current.get(k)}


def sync_live_summaries(summaries: list[IncidentSummary], lookup: Any = None) -> list[str]:
    """Make every ready live bundle's ``manifest.summary`` follow its records (CAL FIRE or NIFC WFIGS; issue: acres /
    containment used to refresh only with new detections). Listed incidents use this cycle's list; an incident that
    left the live list is looked up once through ``catalog.get_summary`` (its year list, cached), so a fire no record
    lists as active stops reading as active. Atomic manifest updates, no rebuild, ``built_ms`` unchanged (bundle files
    did not change). Returns the ids that changed."""
    from .. import catalog

    lookup = lookup or catalog.get_summary
    by_id = {s.id: s for s in summaries}
    changed: list[str] = []
    for m in _live_bundles():
        iid = m.get("id")
        cur = m.get("summary")
        if not iid or not isinstance(cur, dict):
            continue
        fresh = by_id.get(iid)
        if fresh is None:
            try:
                fresh = lookup(iid)
            except Exception as e:  # noqa: BLE001 - try again next cycle
                log.info("live summaries: %s lookup failed: %s", iid, config.mask_secrets(e))
                continue
            if isinstance(fresh, dict):
                fresh = IncidentSummary.model_validate(fresh)
            if fresh is None or fresh.id != iid:
                continue
        upd = summary_changes(cur, fresh)
        if not upd:
            continue

        def fn(mm: dict, upd=upd) -> None:
            if isinstance(mm.get("summary"), dict):
                mm["summary"].update(upd)

        try:
            bundle.update_manifest(bundle.bundle_dir(iid), fn)
            changed.append(iid)
        except (OSError, ValueError) as e:
            log.warning("live summaries: %s not updated: %s", iid, config.mask_secrets(e))
    return changed


def prune_live_forecasts(incident_id: str, keep: int = KEEP_LIVE_FORECASTS, min_age_h: float = PRUNE_MIN_AGE_H,
                         grace_s: float = PRUNE_GRACE_S, now: int | None = None) -> list[str]:
    """Bound the disk use of a live bundle's forecasts: manifest entries beyond the newest ``keep`` ready runs (and
    failed runs) that were issued more than ``min_age_h`` ago are removed from the manifest first; run directories
    that no manifest entry lists are deleted once they are ``grace_s`` old, so a view that has a run open keeps
    working for a while. Historical bundles and running runs are never touched. Returns the removed run ids."""
    import shutil

    bdir = bundle.bundle_dir(incident_id)
    m = bundle.load_manifest(bdir) or {}
    if m.get("mode") != "live":
        return []
    now = now or now_ms()
    runs = [f for f in m.get("forecasts") or [] if isinstance(f, dict)]
    ready = sorted((f for f in runs if f.get("status") == "ready"), key=lambda f: int(f.get("issued_ms") or 0), reverse=True)
    old = lambda f: now - int(f.get("issued_ms") or 0) > min_age_h * HOUR_MS  # noqa: E731
    drop = {f["run_id"] for f in ready[keep:] if old(f)} | {f["run_id"] for f in runs if f.get("status") == "error" and old(f)}
    if drop:
        bundle.update_manifest(bdir, lambda mm: mm.update(
            forecasts=[f for f in mm.get("forecasts") or [] if not (isinstance(f, dict) and f.get("run_id") in drop)]))
    listed = {f.get("run_id") for f in (bundle.load_manifest(bdir) or {}).get("forecasts") or [] if isinstance(f, dict)}
    fdir = bdir / bundle.FORECASTS_DIR
    removed = sorted(drop)
    if fdir.is_dir():
        for d in fdir.iterdir():
            if d.is_dir() and d.name not in listed and time.time() - d.stat().st_mtime > grace_s:
                shutil.rmtree(d, ignore_errors=True)
                if d.name not in removed:
                    removed.append(d.name)
    return removed


def _newest_forecast(m: dict) -> dict | None:
    runs = [f for f in (m.get("forecasts") or []) if isinstance(f, dict) and f.get("status") == "ready"]
    return max(runs, key=lambda f: int(f.get("issued_ms") or 0)) if runs else None


def needs_forecast(before: dict, after: dict, now: int | None = None) -> bool:
    """Re-forecast when the newest ready forecast is > 3 h old (or missing) or the area changed > 2 %."""
    now = now or now_ms()
    fx = _newest_forecast(after)
    if fx is None or now - int(fx.get("issued_ms") or 0) > FORECAST_MAX_AGE_H * HOUR_MS:
        return True
    a0 = float((before.get("stats") or {}).get("final_acres_observed") or 0.0)
    a1 = float((after.get("stats") or {}).get("final_acres_observed") or 0.0)
    return abs(a1 - a0) > FORECAST_AREA_CHANGE * max(a0, 1.0)


def submit_forecast(jobs: JobManager, incident_id: str, *, start_ms: int | None = None, horizon_h: int = 72,
                    ensemble: str = "auto", members: int | None = None):
    """Queue a forecast job (deduped per incident; the forecast pool runs one at a time)."""
    from ..build import pipeline

    def fn(progress):
        fm = pipeline.run_forecast_locked(incident_id, start_ms=start_ms, horizon_h=horizon_h, ensemble=ensemble,
                                          members=members, progress=progress)
        try:
            gone = prune_live_forecasts(incident_id)
            if gone:
                log.info("live forecasts of %s pruned: %s", incident_id, ", ".join(gone))
        except Exception as e:  # noqa: BLE001 - pruning is housekeeping
            log.warning("pruning live forecasts of %s failed: %s", incident_id, config.mask_secrets(e))
        return {
            "run_id": fm.run_id, "status": fm.status, "start_ms": fm.start_ms, "horizon_h": fm.horizon_h,
            "ensemble": fm.weather.ensemble, "members": fm.weather.members, "runtime_s": fm.runtime_s,
            "message": f"forecast {fm.run_id} {fm.status}",
        }

    return jobs.submit("forecast", incident_id, fn, weights=FORECAST_STEP_WEIGHTS)


def refresh_job_fn(jobs: JobManager, incident_id: str, detections: Any, force: bool = False):
    """The ``refresh`` job: pipeline.refresh_live, then maybe a forecast job."""
    from ..build import pipeline

    def fn(progress):
        bdir = bundle.bundle_dir(incident_id)
        before = bundle.load_manifest(bdir) or {}
        changed = pipeline.refresh_live(incident_id, progress=progress, detections=detections, force=force)
        if not changed:
            return {"changed": False, "message": "no new data"}
        after = bundle.load_manifest(bdir) or {}
        fx_job = None
        if needs_forecast(before, after):
            fx_job = submit_forecast(jobs, incident_id).id
        return {"changed": True, "forecast_job": fx_job, "message": "refreshed" + (" + forecast queued" if fx_job else "")}

    return fn


def schedule_refreshes(jobs: JobManager, summaries: list[IncidentSummary], detections: Any) -> list[str]:
    """Queue refresh jobs for ready live bundles of active incidents with new data; returns their incident ids."""
    from ..build import pipeline

    active_ids = {s.id for s in summaries}
    now = now_ms()
    queued: list[str] = []
    for m in _live_bundles():
        iid = m.get("id")
        if not iid or iid not in active_ids or jobs.active_for(iid, "build") or jobs.active_for(iid, "refresh"):
            continue
        stale = now - int(m.get("built_ms") or 0) > STALE_REFRESH_H * HOUR_MS
        if pipeline.has_new_detections(m, detections) or stale:
            jobs.submit("refresh", iid, refresh_job_fn(jobs, iid, detections, force=stale), message="live refresh queued")
            queued.append(iid)
    return queued


def _haversine_km(lat1: float, lon1: float, lat2: np.ndarray, lon2: np.ndarray) -> np.ndarray:
    p1, p2 = math.radians(lat1), np.radians(lat2)
    dphi, dl = p2 - p1, np.radians(lon2 - lon1)
    a = np.sin(dphi / 2) ** 2 + math.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * 6371.0 * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))


def auto_build_candidates(summaries: list[IncidentSummary], detections: Any, limit: int = AUTO_BUILD_MAX) -> list[str]:
    """Up to ``limit`` most active live incidents with >= 100 ac and detections in the last 48 h (SPEC 8.7)."""
    now = now_ms()
    lat = lon = t = None
    if detections is not None and len(detections):
        try:
            t = np.asarray(detections["t_ms"], dtype=np.int64)
            keep = t >= now - AUTO_BUILD_WINDOW_H * HOUR_MS
            lat = np.asarray(detections["lat"], dtype=np.float64)[keep]
            lon = np.asarray(detections["lon"], dtype=np.float64)[keep]
        except (KeyError, TypeError, ValueError):
            lat = lon = None
    scored: list[tuple[int, float, str]] = []
    for s in summaries:
        if s.mode != "live" or (s.acres or 0.0) < AUTO_BUILD_MIN_ACRES:
            continue
        if lat is not None and lon is not None:
            radius_km = min(30.0, max(5.0, 2.0 * fallback_radius_m(s.acres) / 1000.0))
            n = int((_haversine_km(s.lat, s.lon, lat, lon) <= radius_km).sum()) if lat.size else 0
        else:                                   # no feed: fall back to the catalog's 24 h count
            n = int(s.detections_24h or 0)
        if n > 0:
            scored.append((n, float(s.acres or 0.0), s.id))
    scored.sort(key=lambda r: (-r[0], -r[1]))
    return [iid for _, _, iid in scored[:limit]]


def _build_job_fn(incident_id: str):
    from ..build import pipeline

    def fn(progress):
        m = pipeline.build_incident(incident_id, progress=progress, force=False)
        return {"built_ms": m.built_ms, "status": m.status, "warnings": len(m.warnings), "message": f"bundle {m.status}"}

    return fn


async def auto_build(jobs: JobManager, candidates: list[str]) -> None:
    """Build the candidates that are not ready yet, sequentially (each waits for the previous one)."""
    for iid in candidates:
        try:
            m = bundle.load_manifest(bundle.bundle_dir(iid))
        except (OSError, ValueError):
            m = None
        if m and m.get("status") == "ready":
            continue
        st = jobs.submit("build", iid, _build_job_fn(iid), progress_mode="overall", message="auto-build queued")
        STATE.auto_build_ids.append(iid)
        log.info("live auto-build: %s (job %s)", iid, st.id)
        while True:
            cur = jobs.get(st.id)
            if cur is None or cur.status in ("done", "error"):
                break
            await asyncio.sleep(AUTO_BUILD_POLL_S)


async def run_cycle(jobs: JobManager) -> tuple[list[IncidentSummary], Any]:
    """One refresh cycle (network work in a worker thread); updates :data:`STATE`."""
    summaries, dets = await asyncio.to_thread(fetch_cycle_data)
    summaries = [s for s in summaries if s.mode == "live"]
    STATE.active_incidents = len(summaries)
    try:
        n24 = await asyncio.to_thread(detections_24h_ca, dets)
    except Exception as e:
        n24 = None
        log.info("live refresh: 24 h detection count unavailable: %s", config.mask_secrets(e))
    if n24 is not None:
        STATE.detections_24h_ca = n24
    try:
        n24_us = await asyncio.to_thread(detections_24h_us, dets)
    except Exception as e:
        n24_us = None
        log.info("live refresh: national 24 h detection count unavailable: %s", config.mask_secrets(e))
    if n24_us is not None:
        STATE.detections_24h = n24_us
    STATE.counts_ms = now_ms()
    try:
        synced = await asyncio.to_thread(sync_live_summaries, summaries)
        if synced:
            log.info("live refresh: CAL FIRE summary updated for %s", ", ".join(synced))
    except Exception as e:  # noqa: BLE001 - never stop the cycle for this
        log.warning("live refresh: summary sync failed: %s", config.mask_secrets(e))
    queued = await asyncio.to_thread(schedule_refreshes, jobs, summaries, dets)
    if queued:
        log.info("live refresh: queued %d bundle refresh(es): %s", len(queued), ", ".join(queued))
    return summaries, dets


async def live_refresh_loop(jobs: JobManager | None = None, interval_s: float | None = None) -> None:
    """Every 15 min: refresh the CAL FIRE list + FIRMS feeds, refresh built live bundles, re-forecast (SPEC 8.7)."""
    jobs = jobs or get_manager()
    interval = float(interval_s or REFRESH_INTERVAL_S)
    STATE.running = True
    auto_task: asyncio.Task | None = None
    log.info("live refresh loop started (every %.0f min, auto-build %s)", interval / 60, "on" if config.AUTO_BUILD_LIVE else "off")
    try:
        while True:
            try:
                summaries, dets = await run_cycle(jobs)
                STATE.last_error = None
                if config.AUTO_BUILD_LIVE and not STATE.auto_build_done:
                    STATE.auto_build_done = True
                    cands = auto_build_candidates(summaries, dets)
                    log.info("live auto-build candidates: %s", ", ".join(cands) or "none")
                    auto_task = asyncio.create_task(auto_build(jobs, cands))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # keep looping; the next cycle retries
                STATE.last_error = config.mask_secrets(f"{type(e).__name__}: {e}")[:300]
                log.warning("live refresh cycle failed: %s", STATE.last_error)
            STATE.last_refresh_ms = now_ms()
            STATE.next_refresh_ms = STATE.last_refresh_ms + int(interval * 1000)
            await asyncio.sleep(interval)
    finally:
        STATE.running = False
        STATE.next_refresh_ms = None
        if auto_task is not None and not auto_task.done():
            auto_task.cancel()
        log.info("live refresh loop stopped")
