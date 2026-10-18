"""fire3d/cli.py: incident name matching and the catalog / build / forecast / hindcast / serve commands."""

from __future__ import annotations

import pytest

from fire3d import cli, config
from test_pipeline_support import FakeBuild, make_summary

HIST = "2025-alpha-fire-aaa111"
LIVE = "2026-alpha-ridge-fire-bbb222"


@pytest.fixture
def fake(tmp_data_dir, monkeypatch) -> FakeBuild:
    return FakeBuild([
        make_summary(HIST, "historical", name="Alpha Fire", acres=5000.0),
        make_summary("2025-gifford-fire-ccc333", "historical", name="Gifford Fire", acres=131612.0),
        make_summary("2025-eaton-fire-72660a", "historical", name="Eaton Fire", acres=14021.0),
        make_summary(LIVE, "live", name="Alpha Ridge Fire", acres=900.0, detections_24h=12),
    ]).install(monkeypatch)


def test_match_incidents(fake):
    rows = fake.get_catalog("historical") + fake.get_catalog("live")
    assert cli.match_incidents("eaton", rows)[0].id == "2025-eaton-fire-72660a"
    assert cli.match_incidents("Eaton Fire", rows)[0].id == "2025-eaton-fire-72660a"
    assert cli.match_incidents("gif", rows)[0].name == "Gifford Fire"
    assert cli.match_incidents("giford", rows)[0].name == "Gifford Fire"         # close spelling
    assert cli.match_incidents("2025-eaton", rows)[0].id == "2025-eaton-fire-72660a"
    alpha = cli.match_incidents("alpha", rows)
    assert alpha[0].id == HIST and {a.id for a in alpha} == {HIST, LIVE}           # exact name beats prefix
    assert [a.id for a in cli.match_incidents("ridge", rows)] == [LIVE]
    assert cli.match_incidents("zzz", rows) == [] and cli.match_incidents("  ", rows) == []


def test_resolve_incident(fake, capsys):
    assert cli.resolve_incident(HIST) == HIST
    assert cli.resolve_incident("eaton") == "2025-eaton-fire-72660a"
    assert cli.resolve_incident("alpha") == HIST
    assert "other matches" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        cli.resolve_incident("no such fire anywhere")


def test_catalog_build_forecast_hindcast_commands(fake, capsys):
    assert cli.main(["catalog", "--mode", "historical", "--min-acres", "1000"]) == 0
    out = capsys.readouterr().out
    assert "3 historical incidents" in out and "Gifford Fire" in out
    assert cli.main(["build", "alpha fire"]) == 0
    out = capsys.readouterr().out
    assert f"built {HIST}: status=ready" in out and "[observations]" in out and "layers:" in out
    assert cli.main(["forecast", HIST, "--horizon", "24", "--ensemble", "none"]) == 0
    out = capsys.readouterr().out
    assert "forecast fx-001: ready" in out and "+ 24 h area" in out
    assert fake.forecast_args[-1]["ensemble"] == "none" and fake.forecast_args[-1]["horizon_h"] == 24
    assert cli.main(["hindcast", HIST, "--start", "2025-08-15T12:00Z"]) == 0
    out = capsys.readouterr().out
    assert "hindcast skill" in out and "0.800" in out
    assert fake.forecast_args[-1]["start_ms"] == 1755259200000


def test_forecast_requires_bundle_and_errors_are_masked(fake, capsys, monkeypatch):
    with pytest.raises(SystemExit):
        cli.main(["forecast", HIST])
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", "0123456789abcdef0123456789abcdef")
    fake.fail["static"] = RuntimeError("DEM failed MAP_KEY=0123456789abcdef0123456789abcdef")
    assert cli.main(["build", HIST]) == 1
    err = capsys.readouterr().err
    assert "error: RuntimeError" in err and "0123456789abcdef0123456789abcdef" not in err


def test_serve_command(monkeypatch):
    import uvicorn

    seen = {}
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: seen.update(app=app, **kw))
    monkeypatch.setattr(config, "LIVE_ENABLED", True)
    monkeypatch.setenv("FIRE3D_LIVE", "1")
    assert cli.main(["serve", "--port", "8010", "--no-live"]) == 0
    assert seen["app"] == "fire3d.api.app:app" and seen["port"] == 8010 and seen["host"] == "127.0.0.1"
    assert config.LIVE_ENABLED is False
    assert cli.build_parser().parse_args(["serve"]).port == 8710
