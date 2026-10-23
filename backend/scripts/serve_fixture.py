#!/usr/bin/env python
"""Standalone server for the SPEC 6 read endpoints, straight from bundles on disk (no ``fire3d.api`` import).

Frontend agents develop against it before the real API exists; it is also the reference behaviour for the
bundle file endpoint (gzip, ETag, no-cache, traversal-safe). Build/forecast POSTs return fake jobs that finish after
~5 s, and ``/aircraft`` returns 4-6 synthetic fire aircraft circling live incidents (``?force=1`` for any incident,
``?all=1`` adds non-fire traffic).

Usage: ``uv run python scripts/serve_fixture.py --port 8099 [--data-dir DIR] [--host 127.0.0.1]``
"""

from __future__ import annotations

import argparse
import gzip
import math
import sys
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

import numpy as np
import uvicorn
from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fire3d import bundle, config  # noqa: E402
from fire3d.contracts import (  # noqa: E402
    Aircraft,
    AircraftResponse,
    ForecastRequest,
    HealthResponse,
    IncidentDetailResponse,
    IncidentListResponse,
    IncidentListRow,
    IncidentSummary,
    JobStatus,
    ListSource,
    LiveStatus,
    dump,
)
from fire3d.grid import grids_from_manifest  # noqa: E402

JOB_SECONDS = 5.0
CONTENT_TYPES = {".json": "application/json", ".bin": "application/octet-stream", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                 ".png": "image/png", ".npz": "application/octet-stream"}
NO_GZIP = {".jpg", ".jpeg", ".png", ".npz"}
BUILD_STEPS = ["aoi", "terrain", "fuels", "imagery", "observed", "weather", "behavior"]
FORECAST_STEPS = ["weather members", "spread", "quantiles", "write"]
FIXTURE_LIST_REASON = "Fixture server: only the fire bundles on disk are listed (the CAL FIRE and NIFC lists are not fetched)."

# Synthetic fire aircraft: (hex, callsign, registration, ICAO type, category, reason, orbit radius m, gs kt, AGL m, clockwise)
FIRE_FLEET = [
    ("a3f2c1", "TNKR912", "N612AX", "DC10", "airtanker", "type DC10 (VLAT airtanker)", 3200.0, 165.0, 450.0, True),
    ("a1b7e4", "CAL301", "N481DF", "OV10", "air_attack", "type OV10 (CAL FIRE air attack)", 4600.0, 140.0, 1150.0, False),
    ("a5c9d2", "LEAD51", "N151Z", "BE20", "lead_plane", "callsign prefix LEAD (lead plane)", 2500.0, 150.0, 320.0, True),
    ("a7e0b9", "HELI404", "N404CF", "S70", "helicopter", "type S70 (Firehawk helitanker)", 1300.0, 85.0, 160.0, False),
    ("a2d4f6", "TNKR131", "N131CG", "C130", "airtanker", "type C130 (airtanker)", 3900.0, 175.0, 520.0, False),
    ("a9b3c7", "N189AC", "N189AC", "S64", "helicopter", "type S64 (Skycrane helitanker)", 900.0, 70.0, 120.0, True),
]
OTHER_TRAFFIC = [
    ("ac81f0", "SWA2318", "N8710M", "B38M", "unknown", "airliner (A3) en route", 11000.0, 455.0, 10600.0, True),
    ("a0c3d7", "N52918", "N52918", "C172", "unknown", "general aviation, not over the fire", 15000.0, 105.0, 1500.0, False),
]


class GzipCache:
    """Small LRU of gzip-compressed bundle files keyed by (path, mtime_ns, size)."""

    def __init__(self, max_bytes: int = 96 << 20):
        self.max_bytes = max_bytes
        self.items: OrderedDict[tuple[str, int, int], bytes] = OrderedDict()
        self.size = 0
        self.lock = threading.Lock()

    def get(self, path: Path, st) -> bytes:
        key = (str(path), st.st_mtime_ns, st.st_size)
        with self.lock:
            hit = self.items.get(key)
            if hit is not None:
                self.items.move_to_end(key)
                return hit
        data = gzip.compress(path.read_bytes(), compresslevel=5, mtime=0)
        with self.lock:
            self.items[key] = data
            self.size += len(data)
            while self.size > self.max_bytes and len(self.items) > 1:
                _, old = self.items.popitem(last=False)
                self.size -= len(old)
        return data


def create_app(data_dir: Path) -> FastAPI:
    """Build the fixture app serving bundles under ``data_dir/incidents``."""
    incidents_dir = Path(data_dir).resolve() / "incidents"
    app = FastAPI(title="Fire-3d fixture server", version=config.VERSION)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], expose_headers=["ETag"])
    jobs: dict[str, dict[str, Any]] = {}
    jobs_lock = threading.Lock()
    gz = GzipCache()
    started = int(time.time() * 1000)
    centroid_cache: dict[tuple[str, int], tuple[float, float, np.ndarray | None]] = {}

    def bdir(incident_id: str) -> Path:
        try:
            bundle.bundle_dir(incident_id)          # validates the id
        except ValueError:
            raise HTTPException(404, "unknown incident") from None
        return incidents_dir / incident_id

    def manifests() -> list[dict]:
        out = []
        if incidents_dir.is_dir():
            for d in sorted(incidents_dir.iterdir()):
                if d.is_dir() and not d.name.startswith(".") and (d / bundle.MANIFEST_NAME).is_file():
                    m = bundle.load_manifest(d)
                    if isinstance(m, dict) and m.get("status") == "ready":
                        out.append(m)
        return out

    def summary_of(m: dict) -> dict:
        s = dict(m["summary"])
        s["bundle_status"] = "ready"
        s["bundle_built_ms"] = m.get("built_ms")
        return dump(IncidentSummary.model_validate(s))

    def row_of(m: dict) -> dict:
        """A list row (``IncidentListRow``): the summary plus the ready bundle's analysis area (``bbox_lonlat``)."""
        grid = m.get("grid") if isinstance(m.get("grid"), dict) else {}
        bb = grid.get("bbox_lonlat")
        ok = isinstance(bb, (list, tuple)) and len(bb) == 4 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in bb)
        ok = ok and bb[0] < bb[2] and bb[1] < bb[3]
        return dump(IncidentListRow.model_validate({**summary_of(m), "bbox_lonlat": list(bb) if ok else None}))

    def list_sources() -> list[ListSource]:
        """The fixture server never reaches the source lists (CONTRACT 14.1 ``sources``): both are unavailable."""
        return [ListSource(id=sid, name=name, status="unavailable", retrieved_ms=None, reason=FIXTURE_LIST_REASON)
                for sid, name in (("calfire", "CAL FIRE"), ("wfigs", "NIFC WFIGS (IRWIN)"))]

    def load_ready(incident_id: str) -> dict:
        d = bdir(incident_id)
        m = bundle.load_manifest(d) if d.is_dir() else None
        if not isinstance(m, dict):
            raise HTTPException(404, f"no bundle for {incident_id}")
        return m

    # ---------------------------------------------------------------- jobs
    def job_view(j: dict[str, Any]) -> dict:
        now = time.time()
        el = now - j["t0"]
        steps = BUILD_STEPS if j["kind"] == "build" else FORECAST_STEPS
        if el < 0.4:
            status, progress, step, started_ms, finished_ms = "queued", 0.0, "queued", None, None
        elif el < JOB_SECONDS:
            frac = (el - 0.4) / (JOB_SECONDS - 0.4)
            i = min(len(steps) - 1, int(frac * len(steps)))
            status, progress, step = "running", round(frac, 3), steps[i]
            started_ms, finished_ms = j["created_ms"] + 400, None
        else:
            status, progress, step = "done", 1.0, "done"
            started_ms, finished_ms = j["created_ms"] + 400, j["created_ms"] + int(JOB_SECONDS * 1000)
        msg = {"queued": "waiting for a worker", "done": "finished (fixture: nothing was rebuilt)"}.get(step, f"{step} (fixture)")
        return dump(JobStatus(
            id=j["id"], kind=j["kind"], incident_id=j["incident_id"], status=status, progress=progress, step=step, message=msg,
            created_ms=j["created_ms"], started_ms=started_ms, finished_ms=finished_ms, error=None,
            result=j["result"] if status == "done" else None,
        ))

    def start_job(kind: str, incident_id: str, result: Any) -> dict:
        with jobs_lock:
            for j in jobs.values():
                if j["incident_id"] == incident_id and j["kind"] == kind and time.time() - j["t0"] < JOB_SECONDS:
                    return job_view(j)
            jid = f"job-{len(jobs) + 1:04d}-{kind}"
            j = {"id": jid, "kind": kind, "incident_id": incident_id, "t0": time.time(), "created_ms": int(time.time() * 1000), "result": result}
            jobs[jid] = j
            return job_view(j)

    def latest_job(incident_id: str) -> dict | None:
        with jobs_lock:
            js = [j for j in jobs.values() if j["incident_id"] == incident_id]
        return job_view(max(js, key=lambda j: j["t0"])) if js else None

    # ---------------------------------------------------------------- endpoints
    @app.get("/api/health")
    def health() -> dict:
        return dump(HealthResponse(ok=True, version=config.VERSION))

    @app.get("/api/incidents")
    def incidents(mode: str = Query("historical", pattern="^(live|historical)$"), min_acres: float | None = None,
                  year: int | None = None, state: str | None = None) -> dict:
        lo = min_acres if min_acres is not None else (300.0 if mode == "historical" else None)
        rows = [row_of(m) for m in manifests() if m.get("mode") == mode]
        if mode == "historical" and year is not None:
            rows = [r for r in rows if r["year"] == year]
        if state:
            rows = [r for r in rows if (r.get("state") or "").upper() == state.upper()]
        if lo is not None:
            rows = [r for r in rows if r["acres"] is None or r["acres"] >= lo]
        if mode == "historical":
            rows.sort(key=lambda r: -(r["acres"] or 0))
        else:
            rows.sort(key=lambda r: (-(r["detections_24h"] or 0), -(r["acres"] or 0)))
        return dump(IncidentListResponse(mode=mode, updated_ms=int(time.time() * 1000), incidents=rows, sources=list_sources(),
                                         year=year if mode == "historical" else None))

    @app.get("/api/incidents/{incident_id}")
    def incident(incident_id: str) -> dict:
        m = load_ready(incident_id)
        return dump(IncidentDetailResponse(summary=summary_of(m), manifest=m, job=latest_job(incident_id)))

    @app.post("/api/incidents/{incident_id}/build")
    def build(incident_id: str, force: bool = False) -> dict:
        m = load_ready(incident_id)
        return start_job("build", incident_id, {"built_ms": m.get("built_ms"), "force": force})

    @app.post("/api/incidents/{incident_id}/forecast")
    def forecast(incident_id: str, req: ForecastRequest | None = Body(default=None)) -> dict:
        m = load_ready(incident_id)
        runs = m.get("forecasts") or []
        return start_job("forecast", incident_id, {"run_id": runs[0]["run_id"] if runs else None, "request": dump(req) if req else None})

    @app.get("/api/jobs/{job_id}")
    def job(job_id: str) -> dict:
        with jobs_lock:
            j = jobs.get(job_id)
        if j is None:
            raise HTTPException(404, "unknown job")
        return job_view(j)

    @app.get("/api/live/status")
    def live_status() -> dict:
        live = [m for m in manifests() if m.get("mode") == "live"]
        now = int(time.time() * 1000)
        last = now - (now - started) % (15 * 60_000)
        det = sum((m["summary"].get("detections_24h") or 0) for m in live)
        return dump(LiveStatus(last_refresh_ms=last, next_refresh_ms=last + 15 * 60_000, active_incidents=len(live), detections_24h_ca=det,
                               auto_build=False, detections_24h=det))

    def fire_center(incident_id: str, m: dict) -> tuple[float, float, np.ndarray | None]:
        key = (incident_id, int(m.get("built_ms") or 0))
        if key not in centroid_cache:
            d = bdir(incident_id)
            cx, cz = (m["ignition"]["x"], m["ignition"]["z"]) if m.get("ignition") else (0.0, 0.0)
            elev = None
            try:
                arr = bundle.read_layer(d, "observed_arrival", m)
                r, c = np.nonzero(arr < config.NEVER)
                if len(r):
                    _, fire = grids_from_manifest(m)
                    cx = float(((c + 0.5) * fire.res_m - fire.extent_m / 2).mean())
                    cz = float(((r + 0.5) * fire.res_m - fire.extent_m / 2).mean())
                elev = bundle.read_layer(d, "elevation", m)
            except (KeyError, OSError, ValueError):
                pass
            centroid_cache[key] = (cx, cz, elev)
        return centroid_cache[key]

    @app.get("/api/incidents/{incident_id}/aircraft")
    def aircraft(incident_id: str, all: int = 0, force: int = 0) -> dict:  # noqa: A002 - query name from SPEC 6
        m = load_ready(incident_id)
        now = time.time()
        if m.get("mode") != "live" and not force:
            return dump(AircraftResponse(updated_ms=int(now * 1000), source="adsb.lol (fixture)", radius_nm=40, aircraft=[],
                                         note="Aircraft are only tracked for live incidents."))
        render, _ = grids_from_manifest(m)
        cx, cz, elev = fire_center(incident_id, m)
        half = render.extent_m / 2

        def ground(x: float, z: float) -> float | None:
            if elev is None or abs(x) > half or abs(z) > half:
                return None
            rr, cc = render.local_to_rowcol(x, z)
            return float(elev[int(np.clip(rr, 0, elev.shape[0] - 1)), int(np.clip(cc, 0, elev.shape[1] - 1))])

        fleet = FIRE_FLEET[: 4 + int(now // 300) % 3] + (OTHER_TRAFFIC if all else [])
        out = []
        for i, (hx, cs, reg, typ, cat, reason, radius, gs, agl, cw) in enumerate(fleet):
            is_fire = cat != "unknown"
            period = 2 * math.pi * radius / (gs * 0.514444)
            theta = (i * 1.37 + 2 * math.pi * (now / period)) * (1 if cw else -1)
            x = cx + radius * math.sin(theta)
            z = cz - radius * math.cos(theta)
            track = (math.degrees(theta) + (90.0 if cw else -90.0)) % 360.0
            g = ground(x, z)
            alt = (g if g is not None else float(m["grid"]["elev_min_m"])) + agl + 25.0 * math.sin(now / 20.0 + i)
            lon, lat = render.local_to_lonlat(x, z)
            out.append(Aircraft(
                hex=hx, callsign=cs, registration=reg, type=typ, category=cat, is_fire_aircraft=is_fire, reason=reason,
                lat=round(lat, 6), lon=round(lon, 6), x=round(x, 1), z=round(z, 1), alt_m=round(alt, 1),
                agl_m=None if g is None else round(alt - g, 1), gs_kt=round(gs, 1), track_deg=round(track, 1),
                seen_s=round(0.3 + (now * 7.3 + i) % 2.2, 1), on_ground=False,
            ))
        return dump(AircraftResponse(updated_ms=int(now * 1000), source="adsb.lol (fixture)", radius_nm=40, aircraft=out))

    @app.get("/api/bundles/{incident_id}/{path:path}")
    def bundle_file(incident_id: str, path: str, request: Request) -> Response:
        d = bdir(incident_id)
        try:
            p = bundle.resolve_bundle_file(d, path)
        except ValueError:
            raise HTTPException(404, "not found") from None
        if any(part.startswith(".") for part in Path(path).parts) or not p.is_file():
            raise HTTPException(404, "not found")
        st = p.stat()
        use_gzip = "gzip" in request.headers.get("accept-encoding", "").lower() and p.suffix.lower() not in NO_GZIP
        etag = f'W/"{st.st_size:x}-{st.st_mtime_ns:x}{"-gz" if use_gzip else ""}"'
        headers = {"ETag": etag, "Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
        inm = request.headers.get("if-none-match")
        if inm and etag in [t.strip() for t in inm.split(",")]:
            return Response(status_code=304, headers=headers)
        ctype = CONTENT_TYPES.get(p.suffix.lower(), "application/octet-stream")
        if use_gzip:
            headers["Content-Encoding"] = "gzip"
            return Response(gz.get(p, st), media_type=ctype, headers=headers)
        return Response(p.read_bytes(), media_type=ctype, headers=headers)

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

    return app


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Fire-3d fixture server (SPEC 6 read endpoints from disk)")
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--data-dir", type=Path, default=None, help="data dir containing incidents/ (default: FIRE3D_DATA_DIR or <repo>/data)")
    args = ap.parse_args(argv)
    data_dir = (args.data_dir or config.DATA_DIR).resolve()
    print(f"serving bundles from {data_dir / 'incidents'} on http://{args.host}:{args.port}", flush=True)
    uvicorn.run(create_app(data_dir), host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
