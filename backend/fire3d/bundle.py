"""Incident bundle I/O (SPEC 5): paths, manifest load/save/update (atomic + locked), layers, JSON, npz.

The manifest is handled as a plain dict while a bundle is being built (it is partial until the pipeline
finishes); validate the finished one with ``contracts.validate_strict(IncidentManifest, m)``.
Concurrency: :func:`update_manifest` holds an ``fcntl`` lock on ``<bundle>/.manifest.lock`` (plus a per-process
re-entrant lock), so build steps in different threads/processes never lose each other's updates. Writes are
atomic (temp file + ``os.replace``), so readers never see a partial file.
"""

from __future__ import annotations

import fcntl
import io
import os
import re
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

import numpy as np
import orjson
from pydantic import BaseModel

from . import config
from .contracts import IncidentManifest

MANIFEST_NAME = "manifest.json"
LOCK_NAME = ".manifest.lock"
LAYERS_DIR = "layers"
FORECASTS_DIR = "forecasts"
STATIC_NPZ = "sim/static.npz"

DTYPES: dict[str, np.dtype] = {
    "float32": np.dtype("<f4"),
    "uint8": np.dtype("u1"),
    "uint16": np.dtype("<u2"),
    "int16": np.dtype("<i2"),
}
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$")
_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")

PathLike = str | os.PathLike[str]


# ----------------------------------------------------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------------------------------------------------
def bundle_dir(incident_id: str) -> Path:
    """``INCIDENTS_DIR / incident_id`` (ids are validated: letters, digits, ``.``, ``_``, ``-``)."""
    if not _ID_RE.match(incident_id) or ".." in incident_id:
        raise ValueError(f"invalid incident id: {incident_id!r}")
    return Path(config.INCIDENTS_DIR) / incident_id


def resolve_bundle_file(bdir: PathLike, rel_path: str) -> Path:
    """Safely join a bundle-relative path (raises ValueError on absolute paths, ``..`` or symlink escapes)."""
    base = Path(bdir).resolve()
    rel = str(rel_path).replace("\\", "/")
    if not rel or rel.startswith("/") or any(part in ("..", "") for part in rel.split("/")) or "\x00" in rel:
        raise ValueError(f"invalid bundle path: {rel_path!r}")
    p = (base / rel).resolve()
    if p != base and base not in p.parents:
        raise ValueError(f"path escapes bundle: {rel_path!r}")
    return p


def manifest_path(bdir: PathLike) -> Path:
    return Path(bdir) / MANIFEST_NAME


def forecast_dir(bdir: PathLike, run_id: str) -> Path:
    if not _ID_RE.match(run_id):
        raise ValueError(f"invalid run id: {run_id!r}")
    return Path(bdir) / FORECASTS_DIR / run_id


def new_forecast_run_id(bdir: PathLike) -> str:
    """Next free ``fx-NNN`` run id in this bundle."""
    root = Path(bdir) / FORECASTS_DIR
    nums = [int(m.group(1)) for d in (root.iterdir() if root.is_dir() else []) if (m := re.fullmatch(r"fx-(\d+)", d.name))]
    return f"fx-{(max(nums) + 1) if nums else 1:03d}"


# ----------------------------------------------------------------------------------------------------------------
# Atomic files + JSON
# ----------------------------------------------------------------------------------------------------------------
def atomic_write_bytes(path: PathLike, data: bytes) -> None:
    """Write ``data`` atomically (temp file in the same directory + ``os.replace``)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def _json_default(o: Any) -> Any:
    if isinstance(o, BaseModel):
        return o.model_dump(mode="json")
    if isinstance(o, Path):
        return str(o)
    if isinstance(o, (set, frozenset)):
        return sorted(o)
    raise TypeError(f"not JSON serializable: {type(o).__name__}")


def to_json_bytes(obj: Any, *, indent: bool = False) -> bytes:
    """orjson bytes; numpy arrays/scalars and pydantic models allowed; NaN becomes null."""
    opt = orjson.OPT_SERIALIZE_NUMPY | orjson.OPT_NON_STR_KEYS | (orjson.OPT_INDENT_2 if indent else 0)
    return orjson.dumps(obj, default=_json_default, option=opt)


def write_json(path: PathLike, obj: Any, *, indent: bool = False) -> None:
    """Atomically write ``obj`` as JSON (orjson)."""
    atomic_write_bytes(path, to_json_bytes(obj, indent=indent))


def read_json(path: PathLike) -> Any:
    return orjson.loads(Path(path).read_bytes())


def write_npz(path: PathLike, **arrays: np.ndarray) -> None:
    """Atomically write a compressed ``.npz`` (e.g. ``sim/static.npz``)."""
    buf = io.BytesIO()
    np.savez_compressed(buf, **arrays)
    atomic_write_bytes(path, buf.getvalue())


def read_npz(path: PathLike) -> dict[str, np.ndarray]:
    with np.load(Path(path)) as z:
        return {k: z[k] for k in z.files}


# ----------------------------------------------------------------------------------------------------------------
# Manifest
# ----------------------------------------------------------------------------------------------------------------
def load_manifest(bdir: PathLike) -> dict | None:
    """The manifest as a dict, or None if the bundle has none yet."""
    p = manifest_path(bdir)
    try:
        return orjson.loads(p.read_bytes())
    except FileNotFoundError:
        return None


def load_manifest_model(bdir: PathLike) -> IncidentManifest | None:
    """The manifest validated as :class:`IncidentManifest` (raises if it is incomplete)."""
    m = load_manifest(bdir)
    return None if m is None else IncidentManifest.model_validate(m)


def save_manifest(bdir: PathLike, manifest: dict | IncidentManifest) -> None:
    """Atomically write ``manifest.json`` (pretty-printed). Prefer :func:`update_manifest` during builds."""
    data = manifest.model_dump(mode="json") if isinstance(manifest, BaseModel) else manifest
    Path(bdir).mkdir(parents=True, exist_ok=True)
    write_json(manifest_path(bdir), data, indent=True)


_rlocks_guard = threading.Lock()
_rlocks: dict[str, threading.RLock] = {}
_held = threading.local()


@contextmanager
def manifest_lock(bdir: PathLike) -> Iterator[None]:
    """Exclusive, re-entrant (per thread) lock on a bundle's manifest across threads and processes."""
    bdir = Path(bdir)
    bdir.mkdir(parents=True, exist_ok=True)
    key = str(bdir.resolve())
    with _rlocks_guard:
        rl = _rlocks.setdefault(key, threading.RLock())
    with rl:
        depth: dict[str, int] = getattr(_held, "depth", None) or {}
        _held.depth = depth
        outer = depth.get(key, 0) == 0
        depth[key] = depth.get(key, 0) + 1
        fd = None
        try:
            if outer:
                fd = os.open(bdir / LOCK_NAME, os.O_RDWR | os.O_CREAT, 0o644)
                fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            depth[key] -= 1
            if fd is not None:
                fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)


def update_manifest(bdir: PathLike, fn: Callable[[dict], dict | None]) -> dict:
    """Locked read-modify-write: ``fn`` gets the current manifest dict (``{}`` if none), mutates it in place or
    returns a replacement; the result is saved atomically and returned."""
    with manifest_lock(bdir):
        m = load_manifest(bdir) or {}
        r = fn(m)
        if r is not None:
            m = r.model_dump(mode="json") if isinstance(r, BaseModel) else r
        save_manifest(bdir, m)
        return m


def list_bundles() -> list[dict]:
    """Manifests (dicts) of every bundle under ``INCIDENTS_DIR`` that has a manifest, sorted by id."""
    root = Path(config.INCIDENTS_DIR)
    out: list[dict] = []
    if not root.is_dir():
        return out
    for d in sorted(root.iterdir()):
        if d.is_dir() and (d / MANIFEST_NAME).is_file():
            try:
                m = load_manifest(d)
            except (OSError, orjson.JSONDecodeError):
                continue
            if isinstance(m, dict):
                out.append(m)
    return out


# ----------------------------------------------------------------------------------------------------------------
# Layers
# ----------------------------------------------------------------------------------------------------------------
def _dtype_name(dt: np.dtype) -> str:
    for name, d in DTYPES.items():
        if dt.kind == d.kind and dt.itemsize == d.itemsize:
            return name
    raise ValueError(f"unsupported layer dtype {dt} (use float32, uint8, uint16 or int16)")


def layer_stats(arr: np.ndarray, nodata: float | None = None) -> tuple[float | None, float | None]:
    """(min, max) ignoring NaN, ``nodata`` and NEVER; (None, None) if nothing is left."""
    a = np.asarray(arr)
    mask = np.ones(a.shape, dtype=bool)
    if a.dtype.kind == "f":
        mask &= np.isfinite(a) & (a < config.NEVER * 0.999)
    if nodata is not None:
        mask &= a != nodata
    if not mask.any():
        return None, None
    v = a[mask]
    return float(v.min()), float(v.max())


def write_layer(
    bdir: PathLike,
    name: str,
    array: np.ndarray,
    grid_kind: str,
    units: str | None,
    description: str,
    nodata: float | None = None,
    *,
    rel_dir: str = LAYERS_DIR,
    register: bool = True,
) -> dict:
    """Write ``<rel_dir>/<name>.bin`` (raw little-endian) and return its LayerInfo dict.

    ``grid_kind``: "render" | "fire" (2-D (H, W) arrays) or "points" ((N, k) arrays, e.g. trees (N, 6)).
    float64 is stored as float32 and bool as uint8. min/max ignore NaN, ``nodata`` and NEVER.
    With ``register`` (default) the info is stored as ``manifest.layers[name]``; forecast layers use
    ``rel_dir="forecasts/<run_id>", register=False`` and go into the ForecastManifest instead.
    """
    if grid_kind not in ("render", "fire", "points"):
        raise ValueError("grid_kind must be 'render', 'fire' or 'points' (use write_image_layer for JPEGs)")
    arr = np.asarray(array)
    if arr.dtype == np.float64:
        arr = arr.astype(np.float32)
    elif arr.dtype == np.bool_:
        arr = arr.astype(np.uint8)
    dname = _dtype_name(arr.dtype)
    if arr.ndim != 2:
        raise ValueError(f"layer {name!r} must be 2-D, got shape {arr.shape}")
    if not _NAME_RE.match(name):
        raise ValueError(f"invalid layer name: {name!r}")
    rel = f"{rel_dir.strip('/')}/{name}.bin"
    atomic_write_bytes(resolve_bundle_file(bdir, rel), np.ascontiguousarray(arr, dtype=DTYPES[dname]).tobytes())
    info: dict[str, Any] = {"file": rel, "grid": grid_kind, "dtype": dname}
    if grid_kind == "points":
        info["count"] = int(arr.shape[0])
    else:
        info["width"], info["height"] = int(arr.shape[1]), int(arr.shape[0])
        lo, hi = layer_stats(arr, nodata)
        if lo is not None:
            info["min"], info["max"] = lo, hi
    if units is not None:
        info["units"] = units
    if nodata is not None:
        info["nodata"] = float(nodata)
    info["description"] = description
    if register:
        update_manifest(bdir, lambda m: m.setdefault("layers", {}).__setitem__(name, info))
    return info


def write_image_layer(bdir: PathLike, name: str, jpeg_bytes: bytes, width: int, height: int, description: str, *, register: bool = True) -> dict:
    """Write ``layers/<name>.jpg`` and register a LayerInfo (grid "image", dtype "jpeg")."""
    if not jpeg_bytes.startswith(b"\xff\xd8"):
        raise ValueError(f"layer {name!r}: not JPEG data")
    if not _NAME_RE.match(name):
        raise ValueError(f"invalid layer name: {name!r}")
    rel = f"{LAYERS_DIR}/{name}.jpg"
    atomic_write_bytes(resolve_bundle_file(bdir, rel), jpeg_bytes)
    info = {"file": rel, "grid": "image", "dtype": "jpeg", "width": int(width), "height": int(height), "description": description}
    if register:
        update_manifest(bdir, lambda m: m.setdefault("layers", {}).__setitem__(name, info))
    return info


def remove_layer(bdir: PathLike, name: str) -> None:
    """Unregister a layer and delete its file (no error if absent)."""
    removed: dict = {}

    def fn(m: dict) -> None:
        info = m.get("layers", {}).pop(name, None)
        if info:
            removed.update(info)

    update_manifest(bdir, fn)
    if removed.get("file"):
        try:
            resolve_bundle_file(bdir, removed["file"]).unlink()
        except (FileNotFoundError, ValueError):
            pass


def read_array(bdir: PathLike, info: dict) -> np.ndarray:
    """Read the file described by a LayerInfo dict: (H, W) rasters, (count, k) points, (H, W, 3) uint8 JPEG."""
    path = resolve_bundle_file(bdir, info["file"])
    if info["dtype"] == "jpeg":
        from PIL import Image

        with Image.open(path) as im:
            return np.asarray(im.convert("RGB"))
    dt = DTYPES[info["dtype"]]
    a = np.fromfile(path, dtype=dt)
    if info.get("grid") == "points":
        a = a.reshape(int(info["count"]), -1)
    else:
        a = a.reshape(int(info["height"]), int(info["width"]))
    return a.astype(dt.newbyteorder("="), copy=False)


def read_layer(bdir: PathLike, name: str, manifest: dict | None = None) -> np.ndarray:
    """Read ``manifest.layers[name]`` (KeyError if the layer is not registered)."""
    m = manifest if manifest is not None else (load_manifest(bdir) or {})
    return read_array(bdir, m["layers"][name])
