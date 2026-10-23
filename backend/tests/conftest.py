"""Shared pytest fixtures. Tests are offline and fast (SPEC 10).

* ``fire3d.http`` is blocked from reaching the network in every test (autouse ``_offline_http``); install your
  own ``httpx.MockTransport`` via ``monkeypatch.setattr(fire3d.http, "_transport", ...)`` or mark a test
  ``@pytest.mark.network`` to opt out.
* ``tmp_data_dir`` points DATA_DIR / INCIDENTS_DIR / CACHE_DIR at a temp dir.
* ``fixture_bundle`` / ``fixture_live_bundle`` are the synthetic bundles from ``scripts/make_fixture.py``
  (read-only; skipped when missing).
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

import fire3d.http as fhttp
from fire3d import config as f3config
from fire3d.grid import Grid, make_aoi

FIXTURE_ROOT = f3config.REPO_ROOT / "data" / "incidents"


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "network: test may use the real network through fire3d.http")


def _refuse(request: httpx.Request) -> httpx.Response:
    raise RuntimeError(f"network access in tests is not allowed: {f3config.mask_secrets(str(request.url))}")


@pytest.fixture(autouse=True)
def _offline_http(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    if request.node.get_closest_marker("network") is None:
        monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(_refuse))
    fhttp.reset_down_memos()        # a failure remembered by one test never leaks into the next


@pytest.fixture
def tmp_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Temp DATA_DIR (with ``incidents/``) and CACHE_DIR for one test."""
    data = tmp_path / "data"
    (data / "incidents").mkdir(parents=True)
    monkeypatch.setattr(f3config, "DATA_DIR", data)
    monkeypatch.setattr(f3config, "INCIDENTS_DIR", data / "incidents")
    monkeypatch.setattr(f3config, "CACHE_DIR", data / "cache")
    monkeypatch.setenv("FIRE3D_DATA_DIR", str(data))
    monkeypatch.setenv("FIRE3D_CACHE_DIR", str(data / "cache"))
    return data


def _bundle_or_skip(name: str) -> Path:
    p = FIXTURE_ROOT / name
    if not (p / "manifest.json").is_file():
        pytest.skip(f"{name} missing: run `uv run python scripts/make_fixture.py`")
    return p


@pytest.fixture
def fixture_bundle() -> Path:
    """data/incidents/fixture-demo (historical synthetic bundle)."""
    return _bundle_or_skip("fixture-demo")


@pytest.fixture
def fixture_live_bundle() -> Path:
    """data/incidents/fixture-live (live synthetic bundle)."""
    return _bundle_or_skip("fixture-live")


@pytest.fixture
def demo_grids() -> tuple[Grid, Grid]:
    """(render, fire) grids of a 12 km historical AOI near Altadena (EPSG:32611)."""
    return make_aoi(-118.07, 34.20, (-118.10, 34.18, -118.04, 34.22), "historical")
