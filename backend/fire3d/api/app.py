"""FastAPI application (SPEC 6), served as ``fire3d.api.app:app`` on port 8710. Owner: api agent.

Routes: health; incident list (``year=`` / ``state=`` filters, ``bbox_lonlat`` on rows, ``sources``, gzip) + detail;
build and forecast jobs; job status; bundle files (gzip, ETag, ``Cache-Control: no-cache``, traversal-safe); live
aircraft (10 s cache per incident); live status; point lookup (``/api/geo/lookup``, brief 3). Routers: geocode, extras
(optional map sources), official (CAL FIRE status history, NWS fire weather and local alerts, ``api/official.py``),
records (NIFC WFIGS incident records and accuracy regions, ``api/records.py``).
Startup (lifespan) starts the live refresh loop when FIRE3D_LIVE=1 (``config.LIVE_ENABLED``).

Blocking work never runs on the event loop: route functions that touch the network or disk are plain ``def``
(FastAPI runs them in its threadpool) and builds/forecasts run as background jobs (``api/jobs.py``). Incidents
unknown to the catalog but present on disk (e.g. the fixtures) are served read-only from their manifest.
Error responses and logs never contain the FIRMS key (``config.mask_secrets``).
"""

from __future__ import annotations

import asyncio
import gzip
import logging
import math
import threading
import time
import traceback
from collections import OrderedDict
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Literal

import orjson
from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from .. import bundle, catalog, config
from ..build import pipeline
from ..contracts import AircraftResponse, ForecastRequest, HealthResponse, IncidentSummary, dump
from ..http import _MaskSecretsFilter
from ..sources import aircraft as aircraft_src
from ..timeutil import HOUR_MS, now_ms
from . import jobs as jobs_mod
from . import live
from . import extras as extras_routes
from . import geocode as geocode_routes
from . import official as official_routes
from . import records as records_routes

log = logging.getLogger(__name__)

DEFAULT_HISTORICAL_MIN_ACRES = 300.0
MAX_HORIZON_H = 240
MAX_MEMBERS = 101
CONTENT_TYPES = {
    ".json": "application/json", ".bin": "application/octet-stream", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".npz": "application/octet-stream", ".txt": "text/plain; charset=utf-8",
}
NO_GZIP = {".jpg", ".jpeg", ".png", ".npz"}          # already compressed
GZIP_CACHE_BYTES = 128 << 20


# ----------------------------------------------------------------------------------------------------------------
# Logging, errors, JSON
# ----------------------------------------------------------------------------------------------------------------
class MaskingFormatter(logging.Formatter):
    """A Formatter whose whole output (message, traceback, stack) passes through ``config.mask_secrets``."""

    def format(self, record: logging.LogRecord) -> str:
        return config.mask_secrets(super().format(record))


LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


def setup_logging() -> None:
    """Give the ``fire3d`` loggers a stderr handler (uvicorn only configures its own loggers); secrets are masked
    in messages and tracebacks."""
    lg = logging.getLogger("fire3d")
    if lg.handlers or logging.getLogger().handlers:
        return
    h = logging.StreamHandler()
    h.setFormatter(MaskingFormatter(LOG_FORMAT))
    h.addFilter(_MaskSecretsFilter())
    lg.addHandler(h)
    if lg.level == logging.NOTSET:
        lg.setLevel(logging.INFO)


class MaskedErrorMiddleware:
    """Turns unhandled exceptions into ``500 {"detail": <masked message>}`` and logs a masked traceback, so the
    server's own (unmasked) exception logging never sees them."""

    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def send_wrapper(message: dict) -> None:
            nonlocal started
            if message.get("type") == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as e:
            log.error("unhandled error on %s %s:\n%s", scope.get("method"), config.mask_secrets(scope.get("path", "")),
                      config.mask_secrets("".join(traceback.format_exception(e))))
            if started:
                return
            resp = JSONResponse({"detail": f"internal error: {pipeline.short_error(e)}"}, status_code=500)
            await resp(scope, receive, send)


def _json(obj: Any, status: int = 200, headers: dict[str, str] | None = None) -> Response:
    return Response(orjson.dumps(obj, option=orjson.OPT_SERIALIZE_NUMPY | orjson.OPT_NON_STR_KEYS), status_code=status,
                    media_type="application/json", headers=headers)


def _http_error(status: int, detail: str) -> HTTPException:
    return HTTPException(status_code=status, detail=config.mask_secrets(detail))


def _jobs() -> jobs_mod.JobManager:
    return jobs_mod.get_manager()


# ----------------------------------------------------------------------------------------------------------------
# Incident resolution
# ----------------------------------------------------------------------------------------------------------------
def _bdir(incident_id: str) -> Path:
    try:
        return bundle.bundle_dir(incident_id)
    except ValueError:
        raise _http_error(404, f"unknown incident {incident_id!r}") from None


def _manifest(bdir: Path) -> dict | None:
    try:
        m = bundle.load_manifest(bdir) if bdir.is_dir() else None
    except (OSError, ValueError) as e:
        log.warning("unreadable manifest in %s: %s", bdir.name, e)
        return None
    return m if isinstance(m, dict) else None


def _summary_dict(s: Any) -> dict:
    return dump(s if isinstance(s, IncidentSummary) else IncidentSummary.model_validate(s))


def _catalog_summary(incident_id: str) -> dict | None:
    """The catalog's summary as a dict, or None. ``catalog.ListsUnavailable`` (the lists cannot be reached and no
    bundle on disk knows the id) is raised: the API answers 503 (:func:`_lists_unavailable`), never "unknown"."""
    try:
        s = catalog.get_summary(incident_id)
    except NotImplementedError:
        return None
    except catalog.ListsUnavailable:
        raise
    except Exception as e:
        log.warning("catalog.get_summary(%s) failed: %s", incident_id, config.mask_secrets(e))
        return None
    if s is None:
        return None
    try:
        return _summary_dict(s)
    except ValidationError as e:
        log.warning("catalog summary for %s does not match the contract: %s", incident_id, e)
        return None


def _resolve(incident_id: str, m: dict | None) -> tuple[dict, bool] | None:
    """``(summary dict, buildable)`` from the catalog, else from the bundle manifest; None when unknown.
    ``buildable``: ``pipeline.is_catalog_incident`` (a listed CAL FIRE or NIFC WFIGS fire; bundle-only incidents such
    as the fixtures are read-only)."""
    s = _catalog_summary(incident_id)
    if s is None and m and isinstance(m.get("summary"), dict):
        try:
            s = _summary_dict(m["summary"])
        except ValidationError:
            return None
    if s is None:
        return None
    return s, pipeline.is_catalog_incident(incident_id, s)


def _bundle_state(incident_id: str, bdir: Path | None, m: dict | None) -> tuple[str, int | None]:
    """(bundle_status, bundle_built_ms) from running jobs + the manifest on disk."""
    if _jobs().active_for(incident_id, "build") is not None:
        return "building", None
    if m is None:
        return "none", None
    st = m.get("status")
    if st == "ready":
        return "ready", int(m.get("built_ms") or 0) or None
    if st == "building":
        return ("building", None) if bdir is not None and pipeline.build_in_progress(bdir) else ("error", None)
    return "error", None


def _overlay(s: dict, m: dict | None = None, bdir: Path | None = None, *, load: bool = True) -> dict:
    """Summary with bundle_status / bundle_built_ms reflecting this server's jobs and the bundle on disk."""
    out = dict(s)
    if bdir is None:
        try:
            bdir = bundle.bundle_dir(out["id"])
        except ValueError:
            return out
    if m is None and load:
        m = _manifest(bdir)
    out["bundle_status"], out["bundle_built_ms"] = _bundle_state(out["id"], bdir, m)
    return out


def _manifest_view(m: dict, incident_id: str, bdir: Path) -> dict:
    """The manifest as served: a stale "building" manifest becomes "error"; a non-ready manifest gets placeholder
    values for the fields a build fills in later, so it always has the IncidentManifest shape."""
    if m.get("status") == "ready":
        return m
    v = dict(m)
    if v.get("status") == "building" and _jobs().active_for(incident_id, "build") is None and not pipeline.build_in_progress(bdir):
        v["status"] = "error"
        v["warnings"] = list(v.get("warnings") or []) + ["Build interrupted (the build process stopped); rebuild to retry."]
    t0 = int(v.get("time_origin_ms") or (v.get("summary") or {}).get("started_ms") or 0)
    placeholders = {
        "schema_version": 1, "time_range": {"start_ms": t0, "end_ms": t0, "now_ms": t0}, "layers": {}, "ignition": None,
        "default_profile_path": [], "fuels_edition": "", "data_sources": [], "forecasts": [], "warnings": [],
        "stats": {"final_acres_observed": 0.0, "detections": 0, "perimeters": 0}, "built_ms": 0, "time_origin_ms": t0,
    }
    for k, val in placeholders.items():
        v.setdefault(k, val)
    return v


def _ready_bbox(m: dict | None) -> list[float] | None:
    """``manifest.grid.bbox_lonlat`` (w, s, e, n) when it is four finite numbers, else None."""
    bb = ((m or {}).get("grid") or {}).get("bbox_lonlat") if isinstance((m or {}).get("grid"), dict) else None
    if not isinstance(bb, (list, tuple)) or len(bb) != 4:
        return None
    try:
        vals = [float(v) for v in bb]
    except (TypeError, ValueError):
        return None
    return vals if all(math.isfinite(v) for v in vals) and vals[0] < vals[2] and vals[1] < vals[3] else None


def _list_row(s: dict, m: dict | None = None) -> dict:
    """A list row (``IncidentListRow``): the summary with this server's bundle state plus ``bbox_lonlat``, the
    analysis area of a ready bundle (null otherwise)."""
    try:
        bdir = bundle.bundle_dir(s["id"])
    except ValueError:
        return {**s, "bbox_lonlat": None}
    if m is None:
        m = _manifest(bdir)
    out = _overlay(s, m, bdir, load=False)
    out["bbox_lonlat"] = _ready_bbox(m) if out["bundle_status"] == "ready" else None
    return out


def _bundle_rows(mode: str, min_acres: float | None, year: int | None = None) -> list[dict]:
    """Fallback incident list from bundles on disk (catalog unavailable). ``year`` (historical lists asked for one
    year): the bundles of that year in either mode, since a year list also holds that year's active fires."""
    rows = []
    for m in bundle.list_bundles():
        if not isinstance(m.get("summary"), dict):
            continue
        if year is None and m.get("mode") != mode:
            continue
        try:
            s = _summary_dict(m["summary"])
        except ValidationError:
            continue
        if year is not None and s.get("year") != year:
            continue
        if min_acres is not None and s.get("acres") is not None and s["acres"] < min_acres:
            continue
        rows.append(_list_row(s, m))
    if mode == "historical":
        rows.sort(key=lambda r: -(r.get("acres") or 0.0))
    else:
        rows.sort(key=lambda r: (-(r.get("detections_24h") or 0), -(r.get("acres") or 0.0)))
    return rows


# ----------------------------------------------------------------------------------------------------------------
# Bundle files
# ----------------------------------------------------------------------------------------------------------------
class GzipCache:
    """LRU of gzip-compressed bundle files keyed by (path, mtime_ns, size)."""

    def __init__(self, max_bytes: int = GZIP_CACHE_BYTES):
        self.max_bytes = max_bytes
        self._items: OrderedDict[tuple[str, int, int], bytes] = OrderedDict()
        self._size = 0
        self._lock = threading.Lock()

    def get(self, path: Path, st: Any) -> bytes:
        key = (str(path), st.st_mtime_ns, st.st_size)
        with self._lock:
            hit = self._items.get(key)
            if hit is not None:
                self._items.move_to_end(key)
                return hit
        data = gzip.compress(path.read_bytes(), compresslevel=6, mtime=0)
        with self._lock:
            if key not in self._items:
                self._items[key] = data
                self._size += len(data)
                while self._size > self.max_bytes and len(self._items) > 1:
                    _, old = self._items.popitem(last=False)
                    self._size -= len(old)
        return data


_gzip_cache = GzipCache()


# ----------------------------------------------------------------------------------------------------------------
# Aircraft cache
# ----------------------------------------------------------------------------------------------------------------
@dataclass
class _AircraftEntry:
    fetched: float                      # time.monotonic()
    updated_ms: int
    aircraft: list[Any]                 # every classified aircraft (filtered per request)
    source: str = aircraft_src.SOURCE   # provider that answered (adsb.lol, or the adsb.fi fallback)


@dataclass
class _AircraftCache:
    entries: dict[str, _AircraftEntry] = field(default_factory=dict)
    contexts: dict[str, tuple[Any, aircraft_src.AircraftContext]] = field(default_factory=dict)
    locks: dict[str, threading.Lock] = field(default_factory=dict)
    guard: threading.Lock = field(default_factory=threading.Lock)

    def lock(self, key: str) -> threading.Lock:
        with self.guard:
            return self.locks.setdefault(key, threading.Lock())

    def clear(self) -> None:
        with self.guard:
            self.entries.clear()
            self.contexts.clear()


AIRCRAFT_CACHE = _AircraftCache()


def _aircraft_context(incident_id: str, s: dict, m: dict | None, bdir: Path) -> aircraft_src.AircraftContext:
    ready = bool(m and m.get("status") == "ready")
    key = (m.get("built_ms") if ready else None, s.get("lat"), s.get("lon"))
    hit = AIRCRAFT_CACHE.contexts.get(incident_id)
    if hit is not None and hit[0] == key:
        return hit[1]
    ctx = aircraft_src.AircraftContext.from_bundle(bdir, m) if ready else aircraft_src.AircraftContext.around(s["lon"], s["lat"], s.get("acres"))
    AIRCRAFT_CACHE.contexts[incident_id] = (key, ctx)
    return ctx


def _aircraft_entry(incident_id: str, s: dict, m: dict | None, bdir: Path) -> tuple[_AircraftEntry | None, str | None]:
    with AIRCRAFT_CACHE.lock(incident_id):
        entry = AIRCRAFT_CACHE.entries.get(incident_id)
        now = time.monotonic()
        if entry is not None and now - entry.fetched < config.AIRCRAFT_RESPONSE_CACHE_S:
            return entry, None
        ctx = _aircraft_context(incident_id, s, m, bdir)
        lon, lat = ctx.center_lonlat() if (m and m.get("status") == "ready") else (s["lon"], s["lat"])
        try:
            raw, adsb_now = aircraft_src.fetch_point(lat, lon, config.AIRCRAFT_RADIUS_NM)
        except aircraft_src.AircraftUnavailable as e:
            if entry is not None and now - entry.fetched <= config.AIRCRAFT_STALE_OK_S:
                return entry, f"{e}; showing positions from {now - entry.fetched:.0f} s ago"
            return None, f"Live aircraft unavailable: {e}"
        entry = _AircraftEntry(fetched=now, updated_ms=adsb_now or now_ms(), aircraft=aircraft_src.aircraft_list(raw, ctx, include_all=True),
                               source=aircraft_src.last_source())
        AIRCRAFT_CACHE.entries[incident_id] = entry
        return entry, None


# ----------------------------------------------------------------------------------------------------------------
# App
# ----------------------------------------------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Start the live refresh loop (FIRE3D_LIVE=1) and stop it plus the job workers on shutdown."""
    setup_logging()
    task: asyncio.Task | None = None
    if config.LIVE_ENABLED:
        task = asyncio.create_task(live.live_refresh_loop(_jobs()), name="fire3d-live-refresh")
    else:
        log.info("live refresh loop disabled (FIRE3D_LIVE=0)")
    try:
        yield
    finally:
        if task is not None:
            task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await task
        jobs_mod.shutdown_manager()


app = FastAPI(title="Fire-3d API", version=config.VERSION, description="Wildfire Forensics & Forecast (SPEC 6)", lifespan=lifespan)
app.add_middleware(MaskedErrorMiddleware)


@app.exception_handler(catalog.ListsUnavailable)
async def _lists_unavailable(request: Request, exc: catalog.ListsUnavailable) -> Response:
    """CONTRACT 14.2: an id the source lists cannot decide right now (CAL FIRE or NIFC WFIGS unreachable, no bundle on
    disk) is 503 "The fire lists could not be reached right now; try again later.", never 404 or a local bundle."""
    return JSONResponse({"detail": catalog.LISTS_UNAVAILABLE_TEXT}, status_code=503)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["ETag"],
)

# Map-first UI routers (docs/redesign/BRIEF.md): address lookup and optional map sources.
app.include_router(geocode_routes.router)
app.include_router(extras_routes.router)
app.include_router(official_routes.router)       # BRIEF-2: CAL FIRE status history, NWS fire weather alerts
app.include_router(records_routes.router)        # brief 3: NIFC WFIGS incident records, accuracy regions (14.4, 14.5)


@app.get("/api/health")
async def health() -> Response:
    """Liveness probe: ``{ok: true, version}``."""
    return _json(dump(HealthResponse(ok=True, version=config.VERSION)))


GZIP_MIN_BYTES = 1024


def _maybe_gzip(body: bytes, request: Request | None, headers: dict[str, str] | None = None) -> Response:
    """JSON ``body`` gzip-compressed in the handler when the request accepts it (brief 3, B-R17), with
    ``Vary: Accept-Encoding``; small bodies are sent as they are."""
    h = {"Vary": "Accept-Encoding", **(headers or {})}
    accepts = request is not None and "gzip" in request.headers.get("accept-encoding", "").lower()
    if accepts and len(body) >= GZIP_MIN_BYTES:
        h["Content-Encoding"] = "gzip"
        return Response(gzip.compress(body, compresslevel=6, mtime=0), media_type="application/json", headers=h)
    return Response(body, media_type="application/json", headers=h)


def _bundle_sources(reason: str) -> list[dict]:
    return [{"id": sid, "name": name, "status": "unavailable", "retrieved_ms": None, "reason": reason}
            for sid, name in (("calfire", "CAL FIRE"), ("wfigs", "NIFC WFIGS (IRWIN)"))]


@app.get("/api/incidents")
def list_incidents(
    request: Request,
    mode: Literal["live", "historical"] = "historical",
    min_acres: float | None = Query(None, ge=0),
    year: int | None = Query(None, ge=2000, le=2100),
    state: str | None = Query(None, min_length=2, max_length=2, pattern=r"^[A-Za-z]{2}$"),
) -> Response:
    """``{mode, updated_ms, incidents, year?, sources}`` (CONTRACT 14.1): the national list (live: every active
    wildfire of the lower 48 by detections_24h then acres; historical: the wildfires of ``year``, default the current
    UTC year, >= 300 ac by default, by acres; CAL FIRE is the record in California). ``state`` (USPS) filters rows.
    Rows carry ``bbox_lonlat`` (the analysis area of a ready bundle, else null). ``sources`` says which source lists
    answered. gzip when accepted. Falls back to the bundles on disk when both source lists are unavailable."""
    lo = min_acres if min_acres is not None else (DEFAULT_HISTORICAL_MIN_ACRES if mode == "historical" else None)

    yr = year if mode == "historical" else None
    st = state.upper() if state else None
    try:
        raw = catalog.get_catalog(mode, min_acres=lo, **({"year": yr} if yr is not None else {}))
        sources = catalog.cached_sources(mode, year=yr, min_acres=lo)
        if st is not None:
            raw = [x for x in raw if (getattr(x, "state", None) or "").upper() == st]
    except Exception as e:
        log.warning("catalog.list_incidents(%s) failed (%s); listing bundles on disk", mode, config.mask_secrets(e))
        rows = [r for r in _bundle_rows(mode, lo, yr) if st is None or (r.get("state") or "").upper() == st]
        sources = _bundle_sources("The fire lists (CAL FIRE and NIFC) are unavailable right now; only fires with a "
                                  "bundle on this server are listed.")
    else:
        rows = []
        for s in raw:
            try:
                rows.append(_list_row(_summary_dict(s)))
            except ValidationError as e:
                log.warning("skipping a catalog row that does not match IncidentSummary: %s", e)
    body: dict[str, Any] = {"mode": mode, "updated_ms": now_ms(), "incidents": rows}
    if mode == "historical":
        body["year"] = yr if yr is not None else catalog.default_year()
    body["sources"] = sources
    return _maybe_gzip(orjson.dumps(body, option=orjson.OPT_SERIALIZE_NUMPY | orjson.OPT_NON_STR_KEYS), request)


@app.get("/api/incidents/{incident_id}")
def get_incident(incident_id: str) -> Response:
    """``{summary, manifest | null, job | null}``."""
    bdir = _bdir(incident_id)
    m = _manifest(bdir)
    res = _resolve(incident_id, m)
    if res is None:
        raise _http_error(404, f"unknown incident {incident_id!r}")
    s = _overlay(res[0], m, bdir, load=False)
    job = _jobs().latest_for(incident_id)
    return _json({
        "summary": s,
        "manifest": _manifest_view(m, incident_id, bdir) if m else None,
        "job": dump(job) if job else None,
    })


def _build_job_fn(incident_id: str, force: bool):
    def fn(progress):
        m = pipeline.build_incident(incident_id, progress=progress, force=force)
        return {"built_ms": m.built_ms, "status": m.status, "warnings": len(m.warnings), "message": f"bundle {m.status}"}

    return fn


UNSUPPORTED_TEXT = "Fire-3d does not support Alaska, Hawaii or US territories yet."


def _not_buildable(incident_id: str, summary: dict) -> tuple[int, str]:
    """The build gate's answer for an id ``pipeline.is_catalog_incident`` refuses (CONTRACT 14.2): 422 for Alaska,
    Hawaii or a territory; 409 for a local or synthetic bundle (no CAL FIRE or NIFC WFIGS list knows the id) or an
    alias of a listed fire; 503 when the lists cannot be reached (never "a local or synthetic bundle"); else 409
    "cannot be built in this version"."""
    from .. import regions

    try:
        listed = catalog.resolve_listed(incident_id)
    except Exception as e:  # noqa: BLE001 - a lookup failure must not turn into a 500: the lists cannot tell now
        log.warning("build gate: resolve_listed(%s) failed: %s", incident_id, config.mask_secrets(e))
        return 503, catalog.LISTS_UNAVAILABLE_TEXT
    st = (listed.state if listed is not None else summary.get("state")) or None
    if listed is not None and not regions.is_supported_state(st):
        return 422, UNSUPPORTED_TEXT
    if listed is None:
        return 409, f"'{incident_id}' is a local or synthetic bundle; it cannot be rebuilt."
    if listed.id != incident_id:
        return 409, f"'{incident_id}' is listed as '{listed.id}'."
    return 409, f"'{incident_id}' cannot be built in this version yet."


@app.post("/api/incidents/{incident_id}/build")
def start_build(incident_id: str, force: bool = False) -> Response:
    """Build (``force``: rebuild) the bundle in the background; returns the running build job if there is one."""
    bdir = _bdir(incident_id)
    jm = _jobs()
    active = jm.active_for(incident_id, "build")
    if active is not None:
        return _json(dump(active))
    m = _manifest(bdir)
    res = _resolve(incident_id, m)
    if res is None:
        raise _http_error(404, f"unknown incident {incident_id!r}")
    summary, buildable = res
    if not buildable and (force or not m or m.get("status") != "ready"):
        raise _http_error(*_not_buildable(incident_id, summary))
    st = jm.submit("build", incident_id, _build_job_fn(incident_id, force), progress_mode="overall",
                   message="build queued" if not force else "rebuild queued")
    return _json(dump(st))


@app.post("/api/incidents/{incident_id}/forecast")
def start_forecast(incident_id: str, req: ForecastRequest | None = Body(default=None)) -> Response:
    """Run an ensemble forecast in the background (default start: live = now_ms, historical = ignition + 24 h,
    resolved by spread.ensemble.run_forecast)."""
    bdir = _bdir(incident_id)
    jm = _jobs()
    active = jm.active_for(incident_id, "forecast")
    if active is not None:
        return _json(dump(active))
    m = _manifest(bdir)
    if m is None and _resolve(incident_id, None) is None:
        raise _http_error(404, f"unknown incident {incident_id!r}")
    if jm.active_for(incident_id, "build") is not None:
        raise _http_error(409, "a build of this incident is running; forecast after it finishes")
    if m is None:
        raise _http_error(409, "the incident has no bundle yet; build it first")
    if m.get("status") != "ready":
        raise _http_error(409, f"the bundle is not ready (status {m.get('status')!r}); rebuild it first")
    req = req or ForecastRequest()
    if not 1 <= req.horizon_h <= MAX_HORIZON_H:
        raise _http_error(422, f"horizon_h must be 1..{MAX_HORIZON_H}")
    if req.members is not None and not 1 <= req.members <= MAX_MEMBERS:
        raise _http_error(422, f"members must be 1..{MAX_MEMBERS}")
    tr = m.get("time_range") or {}
    start_ms = req.start_ms           # None -> spread.ensemble's SPEC 6 default (live now_ms, historical ignition + 24 h)
    if start_ms is not None and not int(tr.get("start_ms", start_ms)) <= start_ms <= int(tr.get("end_ms", start_ms)) + HOUR_MS:
        raise _http_error(422, "start_ms must lie within the bundle's time_range")
    st = live.submit_forecast(jm, incident_id, start_ms=start_ms, horizon_h=int(req.horizon_h), ensemble=req.ensemble, members=req.members)
    return _json(dump(st))


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> Response:
    """JobStatus of a build / forecast / refresh job."""
    st = _jobs().get(job_id)
    if st is None:
        raise _http_error(404, f"unknown job {job_id!r}")
    return _json(dump(st))


@app.get("/api/bundles/{incident_id}/{path:path}")
def bundle_file(incident_id: str, path: str, request: Request) -> Response:
    """A bundle file: gzip when accepted (not for JPEG/PNG/npz), weak ETag + 304, ``Cache-Control: no-cache``.
    Absolute paths, ``..``, dotfiles (locks, temp files), directories and symlink escapes are 404."""
    bdir = _bdir(incident_id)
    try:
        p = bundle.resolve_bundle_file(bdir, path)
    except ValueError:
        raise _http_error(404, "not found") from None
    if any(part.startswith(".") for part in path.replace("\\", "/").split("/")) or not p.is_file():
        raise _http_error(404, "not found")
    st = p.stat()
    use_gzip = "gzip" in request.headers.get("accept-encoding", "").lower() and p.suffix.lower() not in NO_GZIP
    etag = f'W/"{st.st_size:x}-{st.st_mtime_ns:x}{"-gz" if use_gzip else ""}"'
    headers = {"ETag": etag, "Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
    inm = request.headers.get("if-none-match")
    if inm and (inm.strip() == "*" or etag in [t.strip() for t in inm.split(",")]):
        return Response(status_code=304, headers=headers)
    ctype = CONTENT_TYPES.get(p.suffix.lower(), "application/octet-stream")
    if use_gzip:
        headers["Content-Encoding"] = "gzip"
        return Response(_gzip_cache.get(p, st), media_type=ctype, headers=headers)
    return Response(p.read_bytes(), media_type=ctype, headers=headers)


@app.get("/api/incidents/{incident_id}/aircraft")
def incident_aircraft(incident_id: str, all: str = "0") -> Response:  # noqa: A002 - query name from SPEC 6
    """Live aircraft around a live incident (adsb.lol, 10 s cache): fire aircraft only unless ``all=1``."""
    bdir = _bdir(incident_id)
    m = _manifest(bdir)
    res = _resolve(incident_id, m)
    if res is None:
        raise _http_error(404, f"unknown incident {incident_id!r}")
    s = res[0]
    radius = float(config.AIRCRAFT_RADIUS_NM)
    if s.get("mode") != "live":
        return _json(dump(AircraftResponse(updated_ms=now_ms(), source=aircraft_src.SOURCE, radius_nm=radius, aircraft=[],
                                           note="Aircraft are tracked for live incidents only.")))
    include_all = str(all).strip().lower() in ("1", "true", "yes", "on")
    entry, note = _aircraft_entry(incident_id, s, m, bdir)
    if entry is None:
        return _json(dump(AircraftResponse(updated_ms=now_ms(), source=aircraft_src.SOURCE, radius_nm=radius, aircraft=[], note=note)))
    items = [a for a in entry.aircraft if include_all or a.is_fire_aircraft]
    if note is None and not items:
        note = "No firefighting aircraft detected near the fire right now." if not include_all else "No aircraft in range right now."
    return _json(dump(AircraftResponse(updated_ms=entry.updated_ms, source=entry.source, radius_nm=radius, aircraft=items, note=note)))


@app.get("/api/live/status")
def live_status() -> Response:
    """``{last_refresh_ms, next_refresh_ms, active_incidents, detections_24h_ca, auto_build, detections_24h}``."""
    return _json(dump(live.live_status()))


def _coord(raw: str | None, name: str, lo: float, hi: float) -> float:
    try:
        v = float(str(raw).strip())
    except (TypeError, ValueError):
        raise _http_error(400, f"{name} must be a number") from None
    if not math.isfinite(v) or not lo <= v <= hi:
        raise _http_error(400, f"{name} must be between {lo:g} and {hi:g}")
    return v


@app.get("/api/geo/lookup")
def geo_lookup(lon: str | None = None, lat: str | None = None) -> Response:
    """Brief 3 (CONTRACT 14.3): state, county, time zone and coverage at a point, offline (``fire3d.regions``).
    400 on missing or bad numbers; cached by browsers for a day (the region files change only with a release)."""
    from .. import regions
    from ..contracts import GeoLookup

    x = _coord(lon, "lon", -180.0, 180.0)
    y = _coord(lat, "lat", -90.0, 90.0)
    body = dump(GeoLookup.model_validate(regions.lookup(x, y)))
    return _json(body, headers={"Cache-Control": "public, max-age=86400"})
