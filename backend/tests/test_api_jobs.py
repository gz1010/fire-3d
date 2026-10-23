"""api/jobs.py: lifecycle, dedupe, progress mapping, masked errors, pools, shutdown."""

from __future__ import annotations

import threading
import time

import pytest

from fire3d import config
from fire3d.api.jobs import JobManager, StepProgress, get_manager, set_manager
from fire3d.contracts import JobStatus, contract_problems
from test_pipeline_support import FAKE_KEY


@pytest.fixture
def jm():
    m = JobManager()
    yield m
    m.shutdown()
    assert m.drain(30)


def test_lifecycle_and_result(jm):
    gate = threading.Event()
    seen = threading.Event()

    def fn(progress):
        progress("terrain", 0.25, "DEM")
        seen.set()
        gate.wait(5)
        progress("weather", 0.75, "HRRR")
        return {"built_ms": 123, "message": "bundle ready"}

    st = jm.submit("build", "inc-a", fn, progress_mode="overall")
    assert st.status in ("queued", "running") and st.created_ms > 0 and st.kind == "build"
    assert seen.wait(5)
    mid = jm.get(st.id)
    assert mid.status == "running" and mid.step == "terrain" and mid.progress == 0.25 and mid.message == "DEM"
    assert mid.started_ms is not None and mid.finished_ms is None
    assert jm.submit("build", "inc-a", fn).id == st.id                  # dedupe while running
    gate.set()
    done = jm.wait(st.id, 5)
    assert done.status == "done" and done.progress == 1.0 and done.step == "done"
    assert done.result == {"built_ms": 123, "message": "bundle ready"} and done.message == "bundle ready"
    assert done.finished_ms >= done.started_ms >= done.created_ms
    assert contract_problems(JobStatus, done) == []
    assert jm.submit("build", "inc-a", lambda p: None).id != st.id        # finished jobs are not reused


def test_error_is_short_and_masked(jm, monkeypatch, caplog):
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", FAKE_KEY)

    def boom(progress):
        raise RuntimeError(f"HTTP 500 for https://firms.modaps.eosdis.nasa.gov/api/area/csv/{FAKE_KEY}/GOES_NRT/1,2,3,4/2/2025-01-07")

    with caplog.at_level("ERROR", logger="fire3d.api.jobs"):
        st = jm.wait(jm.submit("forecast", "inc-b", boom).id, 5)
    assert st.status == "error" and st.error.startswith("RuntimeError: HTTP 500")
    assert FAKE_KEY not in st.error and "***" in st.error and st.message == st.error
    assert "Traceback" in caplog.text and FAKE_KEY not in caplog.text


def test_step_progress_mapping():
    sp = StepProgress({"weather": 0.1, "members": 0.7, "quantiles": 0.1})
    vals = [sp.update("weather", 0.5), sp.update("weather", 1.0), sp.update("members", 0.5), sp.update("members", 1.0),
            sp.update("quantiles", 1.0), sp.update("something new", 0.5), sp.update("members", 0.1)]
    assert vals == sorted(vals)
    assert vals[1] == pytest.approx(0.1) and vals[2] == pytest.approx(0.45) and vals[3] == pytest.approx(0.8)
    assert vals[-1] <= 0.99
    unknown = StepProgress()
    a, b = unknown.update("a", 1.0), unknown.update("b", 1.0)
    assert a == pytest.approx(0.5) and b == pytest.approx(0.75)
    assert unknown.update("c", float("nan")) == b


def test_steps_mode_on_a_job(jm):
    def fn(progress):
        progress("weather", 1.0, "")
        progress("members", 0.5, "16/31")
        time.sleep(0.2)
        return None

    st = jm.submit("forecast", "inc-c", fn, weights={"weather": 0.1, "members": 0.8})
    time.sleep(0.1)
    mid = jm.get(st.id)
    assert mid.step == "members" and mid.progress == pytest.approx(0.5) and mid.message == "16/31"
    assert jm.wait(st.id, 5).message == "finished"


def test_forecast_pool_runs_one_at_a_time_and_builds_two(jm):
    running = {"forecast": 0, "build": 0}
    peak = {"forecast": 0, "build": 0}
    lock = threading.Lock()

    def make(kind):
        def fn(progress):
            with lock:
                running[kind] += 1
                peak[kind] = max(peak[kind], running[kind])
            time.sleep(0.15)
            with lock:
                running[kind] -= 1

        return fn

    ids = [jm.submit("forecast", f"inc-{i}", make("forecast")).id for i in range(3)]
    ids += [jm.submit("build", f"inc-{i}", make("build"), progress_mode="overall").id for i in range(4)]
    for jid in ids:
        assert jm.wait(jid, 10).status == "done"
    assert peak["forecast"] == 1 and peak["build"] == 2


def test_latest_for_prefers_active(jm):
    gate = threading.Event()
    first = jm.wait(jm.submit("build", "inc-d", lambda p: {"message": "ok"}).id, 5)
    st = jm.submit("forecast", "inc-d", lambda p: gate.wait(5))
    assert jm.latest_for("inc-d").id == st.id
    assert jm.active_for("inc-d", "build") is None and jm.active_for("inc-d", "forecast").id == st.id
    gate.set()
    jm.wait(st.id, 5)
    assert jm.latest_for("inc-d").id == st.id and jm.latest_for("inc-d").id != first.id
    assert jm.latest_for("nobody") is None and jm.get("job-nope") is None


def test_shutdown_cancels_queued_jobs():
    m = JobManager(build_workers=1)
    gate = threading.Event()
    busy = m.submit("build", "x1", lambda p: gate.wait(5))
    queued = m.submit("build", "x2", lambda p: None)
    time.sleep(0.05)
    m.shutdown()
    st = m.get(queued.id)
    assert st.status == "error" and "shutting down" in st.error
    gate.set()
    assert m.wait(busy.id, 5).status == "done"
    with pytest.raises(RuntimeError):
        m.submit("build", "x3", lambda p: None)


def test_prune_keeps_recent_finished_jobs():
    m = JobManager(max_finished=3)
    try:
        ids = [m.submit("build", f"p{i}", lambda p: None).id for i in range(6)]
        for jid in ids:
            m.wait(jid, 5)
        m.submit("build", "p-last", lambda p: None)
        assert len(m.list()) <= 4 and m.get(ids[0]) is None
    finally:
        m.shutdown()


def test_unknown_kind_and_global_manager():
    m = JobManager()
    try:
        with pytest.raises(ValueError):
            m.submit("nope", "x", lambda p: None)
    finally:
        m.shutdown()
    set_manager(None)
    g = get_manager()
    assert get_manager() is g
    g.shutdown()
    assert get_manager() is not g                                          # recreated after shutdown
    get_manager().shutdown()
    set_manager(None)


def test_build_job_only_starts_the_archive_fetch_and_drain_waits_for_it(jm, monkeypatch):
    """Review round 1 R2: a build job ("Prepare analysis") ends when its bundle is ready; the OpenFEMA archive fetch
    after it runs in the background (CONTRACT 14.7 "a successful build also starts it"), and drain waits for it. A
    build outside a job (the CLI) fetches synchronously."""
    from types import SimpleNamespace

    from fire3d.build import pipeline
    from fire3d.sources import openfema

    gate = threading.Event()
    seen: list[bool] = []

    def fake_prefetch(started_ms, end_ms, *, background=False, threads=None, **kw):
        seen.append(background)
        if not background:
            return "stored"
        th = threading.Thread(target=gate.wait, args=(10,), daemon=True)
        th.start()
        if threads is not None:
            threads.append(th)
        return "started"

    monkeypatch.setattr(openfema, "prefetch", fake_prefetch)
    summary = SimpleNamespace(id="2025-test-fire-abc123", mode="historical", started_ms=1_742_000_000_000)
    manifest = SimpleNamespace(time_range=SimpleNamespace(end_ms=1_742_500_000_000))
    st = jm.submit("build", "inc-a", lambda p: {"archive": pipeline.archive_prefetch(summary, manifest)},
                   progress_mode="overall")
    done = jm.wait(st.id, 5)
    assert done.status == "done" and done.result == {"archive": "started"} and seen == [True]
    assert jm.drain(0.2) is False                                  # the follow-up is still running
    gate.set()
    assert jm.drain(5) is True
    assert pipeline.archive_prefetch(summary, manifest) == "stored" and seen == [True, False]   # CLI: synchronous
    assert pipeline.archive_prefetch(summary, manifest, background=True) == "started"
    gate.set()
