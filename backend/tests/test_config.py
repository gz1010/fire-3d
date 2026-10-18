"""config.py: .env parsing, secret masking, constants."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from fire3d import config

FAKE_KEY = "0123456789abcdef0123456789abcdef"


def test_parse_env_file(tmp_path: Path) -> None:
    p = tmp_path / ".env"
    p.write_text(
        "# comment line\n"
        "\n"
        "PLAIN=value1\n"
        "  SPACED  =  value two  \n"
        'DQ="quoted # not a comment"\n'
        "SQ='single'\n"
        "export EXPORTED=yes\n"
        "INLINE=abc # trailing comment\n"
        "EMPTY=\n"
        "not a valid line\n"
        "1BAD=x\n",
        encoding="utf-8",
    )
    env = config.parse_env_file(p)
    assert env == {
        "PLAIN": "value1",
        "SPACED": "value two",
        "DQ": "quoted # not a comment",
        "SQ": "single",
        "EXPORTED": "yes",
        "INLINE": "abc",
        "EMPTY": "",
    }


def test_parse_env_missing_file(tmp_path: Path) -> None:
    assert config.parse_env_file(tmp_path / "nope.env") == {}


def test_load_env_file_real_env_wins(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / ".env"
    p.write_text("FIRE3D_TEST_A=from_file\nFIRE3D_TEST_B=from_file\n", encoding="utf-8")
    monkeypatch.setenv("FIRE3D_TEST_A", "from_env")
    monkeypatch.delenv("FIRE3D_TEST_B", raising=False)
    config.load_env_file(p)
    try:
        assert os.environ["FIRE3D_TEST_A"] == "from_env"
        assert os.environ["FIRE3D_TEST_B"] == "from_file"
    finally:
        os.environ.pop("FIRE3D_TEST_B", None)


def test_mask_secrets_masks_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", FAKE_KEY)
    url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{FAKE_KEY}/VIIRS_SNPP_SP/-118,34,-117,35/5/2025-01-07"
    masked = config.mask_secrets(url)
    assert FAKE_KEY not in masked
    assert "/api/area/csv/***/VIIRS_SNPP_SP/" in masked
    assert config.mask_secrets(f"error: bad key {FAKE_KEY}!") == "error: bad key ***!"
    assert config.mask_secrets(ValueError(f"x {FAKE_KEY}")) == "x ***"


def test_mask_secrets_patterns_without_known_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", None)
    other = "fedcba9876543210fedcba9876543210"
    assert other not in config.mask_secrets(f"https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/{other}/ALL")
    assert config.mask_secrets("https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=abc123&x=1") == (
        "https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=***&x=1"
    )
    assert config.mask_secrets("nothing secret here") == "nothing secret here"


def test_real_key_is_masked_if_present() -> None:
    key = config.FIRMS_MAP_KEY
    if not key:
        pytest.skip("no FIRMS key configured")
    assert key not in config.mask_secrets(f"prefix {key} suffix")


def test_resolve_dir_relative_to_repo_root(tmp_path: Path) -> None:
    assert config.resolve_dir(None, config.REPO_ROOT / "data") == (config.REPO_ROOT / "data").resolve()
    assert config.resolve_dir("data/dev/terrain", config.REPO_ROOT) == (config.REPO_ROOT / "data" / "dev" / "terrain").resolve()
    assert config.resolve_dir(str(tmp_path), config.REPO_ROOT) == tmp_path.resolve()


def test_constants_and_paths() -> None:
    assert config.NEVER == 1.0e6
    assert config.ACRE_M2 == pytest.approx(4046.8564224)
    assert config.CHAIN_M == pytest.approx(20.1168)
    assert config.CA_BBOX == (-124.6, 32.4, -113.9, 42.1)
    assert config.RENDER_SIZE == 1024
    assert config.FIRMS_MAX_REQUESTS_PER_10MIN == 150
    assert config.INCIDENTS_DIR == config.DATA_DIR / "incidents"
    assert sorted(config.LIVE_FUEL_MOISTURE_BY_MONTH) == list(range(1, 13))
    assert config.LIVE_FUEL_MOISTURE_BY_MONTH[8] == (0.3, 0.7)
    assert config.USER_AGENT == "Fire-3d/0.1 (research prototype)"
    for k in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
        assert Path(os.environ[k]).is_file()
    assert isinstance(config.LIVE_ENABLED, bool) and isinstance(config.AUTO_BUILD_LIVE, bool)
