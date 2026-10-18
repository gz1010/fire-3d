"""bundle.py: paths, atomic/locked manifest updates, layer I/O, JSON, npz."""

from __future__ import annotations

import io
import multiprocessing as mp
import threading
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from fire3d import bundle, config
from fire3d.contracts import IncidentSummary


def test_bundle_dir_validates_ids(tmp_data_dir: Path) -> None:
    assert bundle.bundle_dir("2025-eaton-fire-72660a") == tmp_data_dir / "incidents" / "2025-eaton-fire-72660a"
    for bad in ("../etc", "a/b", "", ".hidden", "x" * 300):
        with pytest.raises(ValueError):
            bundle.bundle_dir(bad)


def test_resolve_bundle_file_blocks_traversal(tmp_path: Path) -> None:
    b = tmp_path / "b"
    b.mkdir()
    assert bundle.resolve_bundle_file(b, "layers/fuel.bin") == (b / "layers" / "fuel.bin").resolve()
    for bad in ("../x", "/etc/passwd", "layers/../../x", "a//b", "", "a/./../.."):
        with pytest.raises(ValueError):
            bundle.resolve_bundle_file(b, bad)
    (tmp_path / "outside").mkdir()
    (b / "link").symlink_to(tmp_path / "outside")
    with pytest.raises(ValueError):
        bundle.resolve_bundle_file(b, "link/secret")


@pytest.mark.parametrize("dtype", ["float32", "uint8", "uint16", "int16"])
def test_write_read_layer_round_trip(tmp_data_dir: Path, dtype: str) -> None:
    b = bundle.bundle_dir("t1")
    arr = (np.arange(12 * 10).reshape(12, 10) % 200).astype(dtype)
    info = bundle.write_layer(b, "lay", arr, "fire", "u", "test layer")
    assert info == {"file": "layers/lay.bin", "grid": "fire", "dtype": dtype, "width": 10, "height": 12, "min": 0.0, "max": 119.0, "units": "u", "description": "test layer"}
    raw = np.fromfile(b / "layers" / "lay.bin", dtype=bundle.DTYPES[dtype])
    assert np.array_equal(raw.reshape(12, 10), arr)                    # little-endian raw, no header
    assert (b / "layers" / "lay.bin").stat().st_size == arr.size * arr.itemsize
    out = bundle.read_layer(b, "lay")
    assert out.dtype == np.dtype(dtype) and np.array_equal(out, arr)
    assert bundle.load_manifest(b)["layers"]["lay"] == info


def test_layer_stats_ignore_nodata_never_nan(tmp_data_dir: Path) -> None:
    b = bundle.bundle_dir("t2")
    a = np.array([[1.5, config.NEVER, np.nan], [-9999.0, 7.25, 3.0]], dtype=np.float64)
    info = bundle.write_layer(b, "arrival", a, "fire", "h", "arrival", nodata=-9999.0)
    assert info["dtype"] == "float32" and info["min"] == 1.5 and info["max"] == 7.25 and info["nodata"] == -9999.0
    info2 = bundle.write_layer(b, "never", np.full((2, 2), config.NEVER), "fire", "h", "all never")
    assert "min" not in info2 and "max" not in info2
    info3 = bundle.write_layer(b, "mask", np.array([[True, False]]), "render", None, "bool -> uint8")
    assert info3["dtype"] == "uint8" and "units" not in info3


def test_points_and_image_layers(tmp_data_dir: Path) -> None:
    b = bundle.bundle_dir("t3")
    trees = np.random.default_rng(0).random((50, 6)).astype(np.float32)
    info = bundle.write_layer(b, "trees", trees, "points", "m", "trees")
    assert info["count"] == 50 and "width" not in info
    assert np.array_equal(bundle.read_layer(b, "trees"), trees)
    buf = io.BytesIO()
    Image.new("RGB", (32, 16), (10, 120, 30)).save(buf, "JPEG")
    iinfo = bundle.write_image_layer(b, "naip", buf.getvalue(), 32, 16, "aerial")
    assert iinfo == {"file": "layers/naip.jpg", "grid": "image", "dtype": "jpeg", "width": 32, "height": 16, "description": "aerial"}
    img = bundle.read_layer(b, "naip")
    assert img.shape == (16, 32, 3)
    with pytest.raises(ValueError):
        bundle.write_image_layer(b, "bad", b"not a jpeg", 1, 1, "x")
    bundle.remove_layer(b, "trees")
    assert "trees" not in bundle.load_manifest(b)["layers"] and not (b / "layers" / "trees.bin").exists()


def test_write_layer_rejects_bad_input(tmp_data_dir: Path) -> None:
    b = bundle.bundle_dir("t4")
    with pytest.raises(ValueError):
        bundle.write_layer(b, "x", np.zeros((2, 2), np.int64), "fire", None, "int64 unsupported")
    with pytest.raises(ValueError):
        bundle.write_layer(b, "x", np.zeros(4, np.float32), "fire", None, "1-D")
    with pytest.raises(ValueError):
        bundle.write_layer(b, "../x", np.zeros((2, 2), np.float32), "fire", None, "bad name")
    fx = bundle.write_layer(b, "arrival_p50", np.zeros((2, 2), np.float32), "fire", "h", "fx", rel_dir="forecasts/fx-001", register=False)
    assert fx["file"] == "forecasts/fx-001/arrival_p50.bin" and (b / fx["file"]).is_file()
    assert bundle.load_manifest(b) is None or "arrival_p50" not in (bundle.load_manifest(b) or {}).get("layers", {})


def test_manifest_save_load_update(tmp_data_dir: Path) -> None:
    b = bundle.bundle_dir("t5")
    assert bundle.load_manifest(b) is None
    bundle.save_manifest(b, {"id": "t5", "layers": {}})
    m = bundle.update_manifest(b, lambda m: m.update(status="building"))
    assert m["status"] == "building" and bundle.load_manifest(b)["status"] == "building"
    m = bundle.update_manifest(b, lambda m: {**m, "warnings": ["w"]})
    assert bundle.load_manifest(b)["warnings"] == ["w"]

    def nested(m: dict) -> None:   # re-entrant: no deadlock
        bundle.update_manifest(b, lambda inner: inner.update(nested=True))
        m["outer"] = True

    bundle.update_manifest(b, nested)
    m = bundle.load_manifest(b)
    assert m["outer"] is True
    assert not list(b.glob(".*.tmp"))


def test_update_manifest_threads_do_not_lose_updates(tmp_data_dir: Path) -> None:
    b = bundle.bundle_dir("t6")
    bundle.save_manifest(b, {"n": 0})

    def work() -> None:
        for _ in range(25):
            bundle.update_manifest(b, lambda m: m.update(n=m["n"] + 1))

    ts = [threading.Thread(target=work) for _ in range(8)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert bundle.load_manifest(b)["n"] == 200


def _proc_increment(bdir: str, n: int) -> None:
    from fire3d import bundle as b

    for _ in range(n):
        b.update_manifest(bdir, lambda m: m.update(n=m["n"] + 1))


def test_update_manifest_processes_do_not_lose_updates(tmp_path: Path) -> None:
    b = tmp_path / "proc"
    bundle.save_manifest(b, {"n": 0})
    ctx = mp.get_context("spawn")
    ps = [ctx.Process(target=_proc_increment, args=(str(b), 20)) for _ in range(3)]
    for p in ps:
        p.start()
    for p in ps:
        p.join(60)
        assert p.exitcode == 0
    assert bundle.load_manifest(b)["n"] == 60


def test_json_helpers(tmp_path: Path) -> None:
    s = IncidentSummary(
        id="x", name="X", mode="historical", year=2025, calfire_uid="u", started_ms=1, updated_ms=None, contained_ms=None,
        acres=None, percent_contained=None, is_active=False, county=None, location=None, admin_unit=None, url=None,
        lat=34.0, lon=-118.0, detections_24h=None, bundle_status="none", bundle_built_ms=None,
    )
    obj = {"a": np.float32(1.5), "b": np.arange(3), "c": np.int64(7), "s": s, "nan": float("nan")}
    p = tmp_path / "x" / "o.json"
    bundle.write_json(p, obj)
    back = bundle.read_json(p)
    assert back["a"] == 1.5 and back["b"] == [0, 1, 2] and back["c"] == 7 and back["s"]["id"] == "x" and back["nan"] is None


def test_npz_and_listing(tmp_data_dir: Path) -> None:
    b1, b2 = bundle.bundle_dir("b-one"), bundle.bundle_dir("a-two")
    bundle.save_manifest(b1, {"id": "b-one"})
    bundle.save_manifest(b2, {"id": "a-two"})
    (tmp_data_dir / "incidents" / "no-manifest").mkdir()
    assert [m["id"] for m in bundle.list_bundles()] == ["a-two", "b-one"]
    bundle.write_npz(b1 / bundle.STATIC_NPZ, fuel_model=np.array([[101, 98]], np.int16), slope=np.zeros((1, 2), np.float32))
    z = bundle.read_npz(b1 / bundle.STATIC_NPZ)
    assert z["fuel_model"].dtype == np.int16 and z["fuel_model"][0, 1] == 98
    assert bundle.new_forecast_run_id(b1) == "fx-001"
    (b1 / "forecasts" / "fx-007").mkdir(parents=True)
    assert bundle.new_forecast_run_id(b1) == "fx-008"
