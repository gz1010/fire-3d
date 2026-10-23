"""Background jobs for builds, forecasts and live refreshes (SPEC 6, 8.7). Owner: api agent.

* Two pools of daemon worker threads: ``build`` (2 workers, also runs ``refresh`` jobs) and ``forecast``
  (1 worker, so at most one forecast runs at a time). Daemon threads let the server (and ``uvicorn --reload``)
  exit without waiting for a long build; the interrupted bundle's "building" manifest is then reported as
  "error" (see ``pipeline.build_in_progress``).
* Dedupe: submitting a (kind, incident) that is already queued or running returns that job.
* Progress: the job function gets ``progress(step, fraction, message)``. With ``progress_mode="overall"`` the
  fraction is the whole job's (pipeline builds report weighted overall progress); with ``"steps"`` it is a
  fraction within ``step`` and :class:`StepProgress` turns it into a monotone overall value.
* Errors: ``error`` is a short secret-masked message; the full traceback (masked) goes to the log.
* Follow-ups: a job runs inside ``pipeline.background_followups()``, so a build only *starts* the fetches that warm a
  cache once its bundle is ready (the OpenFEMA archive, CONTRACT 14.7) and ends without waiting for them;
  :meth:`JobManager.drain` also waits for those threads.
"""

from __future__ import annotations

import itertools
import logging
import math
import queue
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

import orjson
from pydantic import BaseModel

from .. import config
from ..build.pipeline import background_followups, short_error
from ..contracts import JobStatus
from ..timeutil import now_ms

log = logging.getLogger(__name__)

ProgressFn = Callable[[str, float, str], None]
JobFn = Callable[[ProgressFn], Any]
ProgressMode = Literal["overall", "steps"]

POOL_FOR_KIND = {"build": "build", "refresh": "build", "forecast": "forecast"}
ACTIVE = ("queued", "running")
MAX_FINISHED_JOBS = 500
PROGRESS_CAP = 0.99            # only a finished job reports 1.0

# Typical spread.ensemble.run_forecast step names -> share of the job (unknown names get half of what is left).
FORECAST_STEP_WEIGHTS: dict[str, float] = {
    "setup": 0.03, "load": 0.03, "static": 0.03, "ignition": 0.02,
    "weather": 0.10, "members_weather": 0.10, "weather members": 0.10,
    "members": 0.70, "spread": 0.70, "simulate": 0.70, "simulation": 0.70, "run": 0.70,
    "quantiles": 0.08, "aggregate": 0.08, "outputs": 0.05, "write": 0.04, "skill": 0.03, "hindcast": 0.03,
}


class StepProgress:
    """Monotone overall progress from ``(step, fraction within step)`` reports.

    A step listed in ``weights`` spans that share of the job; an unknown step spans half of what is left. When a
    new step starts, the previous one counts as complete. Values are capped at :data:`PROGRESS_CAP`.
    """

    def __init__(self, weights: dict[str, float] | None = None, cap: float = PROGRESS_CAP):
        self.weights = {str(k).lower(): float(v) for k, v in (weights or {}).items()}
        self.cap = cap
        self.value = 0.0
        self._steps: dict[str, tuple[float, float]] = {}
        self._last: tuple[float, float] | None = None

    def update(self, step: str, fraction: float) -> float:
        key = str(step).lower()
        rec = self._steps.get(key)
        if rec is None:
            base = self.value if self._last is None else max(self.value, self._last[0] + self._last[1])
            base = min(base, self.cap)
            w = self.weights.get(key)
            span = w if w is not None else (1.0 - base) * 0.5
            rec = self._steps[key] = (base, max(0.0, min(span, self.cap - base)))
        self._last = rec
        f = float(fraction) if isinstance(fraction, (int, float)) and math.isfinite(fraction) else 0.0
        self.value = max(self.value, min(self.cap, rec[0] + rec[1] * min(max(f, 0.0), 1.0)))
        return self.value


@dataclass
class _Job:
    id: str
    kind: str
    incident_id: str
    fn: JobFn
    tracker: StepProgress | None
    status: str = "queued"
    progress: float = 0.0
    step: str = "queued"
    message: str = "waiting for a worker"
    created_ms: int = field(default_factory=now_ms)
    started_ms: int | None = None
    finished_ms: int | None = None
    error: str | None = None
    result: Any = None
    done: threading.Event = field(default_factory=threading.Event)

    def view(self) -> JobStatus:
        return JobStatus(
            id=self.id, kind=self.kind, incident_id=self.incident_id, status=self.status, progress=round(self.progress, 4),
            step=self.step, message=self.message, created_ms=self.created_ms, started_ms=self.started_ms,
            finished_ms=self.finished_ms, error=self.error, result=self.result,
        )


def _jsonable(value: Any) -> Any:
    """Make a job result JSON-safe (pydantic models dumped, numpy converted, anything else stringified)."""
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    try:
        return orjson.loads(orjson.dumps(value, option=orjson.OPT_SERIALIZE_NUMPY | orjson.OPT_NON_STR_KEYS, default=str))
    except (TypeError, orjson.JSONEncodeError):
        return str(value)


class _WorkerPool:
    """A queue served by ``workers`` daemon threads."""

    def __init__(self, name: str, workers: int, run: Callable[[_Job], None]):
        self.name = name
        self._q: queue.Queue[_Job | None] = queue.Queue()
        self._run = run
        self._threads = [threading.Thread(target=self._loop, name=f"fire3d-{name}-{i}", daemon=True) for i in range(max(1, workers))]
        for t in self._threads:
            t.start()

    def _loop(self) -> None:
        while True:
            job = self._q.get()
            if job is None:
                return
            try:
                self._run(job)
            except BaseException:  # a worker must never die
                log.error("job runner crashed:\n%s", config.mask_secrets(traceback.format_exc()))

    def submit(self, job: _Job) -> None:
        self._q.put(job)

    def stop(self) -> None:
        for _ in self._threads:
            self._q.put(None)


class JobManager:
    """Registry + worker pools for background jobs (see module docstring)."""

    def __init__(self, build_workers: int = 2, forecast_workers: int = 1, max_finished: int = MAX_FINISHED_JOBS):
        self._lock = threading.RLock()
        self._jobs: dict[str, _Job] = {}
        self._seq = itertools.count(1)
        self._max_finished = max_finished
        self._followups: list[threading.Thread] = []
        self.closed = False
        self._pools = {
            "build": _WorkerPool("build", build_workers, self._run),
            "forecast": _WorkerPool("forecast", forecast_workers, self._run),
        }

    # ------------------------------------------------------------------ submit / query
    def submit(
        self,
        kind: str,
        incident_id: str,
        fn: JobFn,
        *,
        progress_mode: ProgressMode = "steps",
        weights: dict[str, float] | None = None,
        message: str = "waiting for a worker",
    ) -> JobStatus:
        """Queue ``fn(progress)`` as a job, or return the queued/running job of the same (kind, incident)."""
        if kind not in POOL_FOR_KIND:
            raise ValueError(f"unknown job kind {kind!r}")
        with self._lock:
            if self.closed:
                raise RuntimeError("the job manager is shut down")
            existing = self._active(kind, incident_id)
            if existing is not None:
                return existing.view()
            job = _Job(
                id=f"job-{next(self._seq):04d}-{uuid.uuid4().hex[:8]}", kind=kind, incident_id=incident_id, fn=fn,
                tracker=None if progress_mode == "overall" else StepProgress(weights), message=message,
            )
            self._jobs[job.id] = job
            self._prune()
        self._pools[POOL_FOR_KIND[kind]].submit(job)
        return job.view()

    def get(self, job_id: str) -> JobStatus | None:
        with self._lock:
            j = self._jobs.get(job_id)
            return j.view() if j else None

    def active_for(self, incident_id: str, kind: str | None = None) -> JobStatus | None:
        """The newest queued/running job of the incident (optionally of one kind)."""
        with self._lock:
            j = self._active(kind, incident_id)
            return j.view() if j else None

    def latest_for(self, incident_id: str) -> JobStatus | None:
        """The incident's newest active job, else its most recently created finished job."""
        with self._lock:
            j = self._active(None, incident_id)
            if j is None:
                js = [x for x in self._jobs.values() if x.incident_id == incident_id]
                j = max(js, key=lambda x: (x.created_ms, x.id)) if js else None
            return j.view() if j else None

    def list(self, incident_id: str | None = None, active_only: bool = False) -> list[JobStatus]:
        with self._lock:
            return [j.view() for j in self._jobs.values()
                    if (incident_id is None or j.incident_id == incident_id) and (not active_only or j.status in ACTIVE)]

    def wait(self, job_id: str, timeout: float | None = None) -> JobStatus | None:
        """Block until the job finishes (or ``timeout``); returns its status (None if unknown)."""
        with self._lock:
            j = self._jobs.get(job_id)
        if j is None:
            return None
        j.done.wait(timeout)
        return self.get(job_id)

    def drain(self, timeout: float | None = None) -> bool:
        """Wait until no job is queued or running and the follow-up threads the jobs started (the OpenFEMA archive
        fetch after a build) have ended (e.g. after :meth:`shutdown`); False on timeout."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            with self._lock:
                pending = [j for j in self._jobs.values() if j.status in ACTIVE]
            if not pending:
                break
            for j in pending:
                left = None if deadline is None else deadline - time.monotonic()
                if left is not None and left <= 0:
                    return False
                j.done.wait(left)
        while True:
            with self._lock:
                self._followups = [t for t in self._followups if t.is_alive()]
                alive = list(self._followups)
            if not alive:
                return True
            for t in alive:
                left = None if deadline is None else deadline - time.monotonic()
                if left is not None and left <= 0:
                    return False
                t.join(left)

    def shutdown(self) -> None:
        """Stop accepting jobs, cancel queued ones and stop the workers (running jobs end with the process)."""
        with self._lock:
            self.closed = True
            for j in self._jobs.values():
                if j.status == "queued":
                    j.status, j.error, j.message, j.finished_ms = "error", "cancelled: server shutting down", "cancelled", now_ms()
                    j.done.set()
        for p in self._pools.values():
            p.stop()

    # ------------------------------------------------------------------ internals
    def _active(self, kind: str | None, incident_id: str) -> _Job | None:
        for j in reversed(self._jobs.values()):
            if j.incident_id == incident_id and j.status in ACTIVE and (kind is None or j.kind == kind):
                return j
        return None

    def _prune(self) -> None:
        finished = [jid for jid, j in self._jobs.items() if j.status not in ACTIVE]
        for jid in finished[: max(0, len(finished) - self._max_finished)]:
            del self._jobs[jid]

    def _run(self, job: _Job) -> None:
        with self._lock:
            if job.status != "queued":
                return
            job.status, job.started_ms, job.step, job.message = "running", now_ms(), "starting", "starting"

        def progress(step: str, fraction: float, message: str = "") -> None:
            with self._lock:
                if job.status != "running":
                    return
                try:
                    f = float(fraction)
                except (TypeError, ValueError):
                    f = 0.0
                if job.tracker is not None:
                    value = job.tracker.update(str(step), f)
                else:
                    value = max(job.progress, min(PROGRESS_CAP, f if math.isfinite(f) else 0.0))
                job.progress = value
                job.step = str(step)[:80]
                job.message = config.mask_secrets(str(message))[:300]

        started: list[threading.Thread] = []
        try:
            with background_followups() as started:
                result = _jsonable(job.fn(progress))
        except BaseException as e:  # noqa: BLE001 - every failure is recorded on the job
            tb = config.mask_secrets("".join(traceback.format_exception(e)))
            log.error("job %s (%s %s) failed:\n%s", job.id, job.kind, job.incident_id, tb)
            with self._lock:
                job.status, job.error, job.finished_ms = "error", short_error(e), now_ms()
                job.message = job.error
        else:
            with self._lock:
                job.status, job.progress, job.step, job.finished_ms, job.result = "done", 1.0, "done", now_ms(), result
                msg = result.get("message") if isinstance(result, dict) else None
                job.message = config.mask_secrets(str(msg))[:300] if msg else "finished"
        finally:
            with self._lock:
                self._followups = [t for t in self._followups if t.is_alive()] + [t for t in started if t.is_alive()]
            job.done.set()


_manager: JobManager | None = None
_manager_lock = threading.Lock()


def get_manager() -> JobManager:
    """The process-wide :class:`JobManager` (created on first use, recreated after :meth:`JobManager.shutdown`)."""
    global _manager
    with _manager_lock:
        if _manager is None or _manager.closed:
            _manager = JobManager()
        return _manager


def shutdown_manager() -> None:
    """Shut down the process-wide manager, if one exists (never creates one)."""
    with _manager_lock:
        m = _manager
    if m is not None and not m.closed:
        m.shutdown()


def set_manager(manager: JobManager | None) -> None:
    """Replace the process-wide manager (tests)."""
    global _manager
    with _manager_lock:
        _manager = manager
