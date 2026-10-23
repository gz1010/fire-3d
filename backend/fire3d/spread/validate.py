"""Forecast verification: Sørensen skill, batch hindcasts and timing benchmarks (SPEC 8.5). Owner: spread agent.

* :func:`sorensen` - Sørensen-Dice coefficient of two burned masks.
* :func:`skill_from_arrays` / :func:`hindcast_skill` - the ForecastManifest ``skill`` entries: forecast p50 burned
  by ``start + L`` vs observed burned by ``start + L`` for L in {12, 24, 48, 72} h within the horizon and the data.
* :func:`batch_hindcast` - grid search of ``spread_adjustment`` over several fires and start offsets (one process
  pool for every run); :func:`summarize_hindcast` / :func:`hindcast_markdown` report it. Besides the contract's
  total-area Sørensen, rows carry ``sorensen_growth`` (new growth only, the initial burned area excluded), which is
  the discriminating score for calibration.
* :func:`region_accuracy` / :func:`regional_accuracy` - per-fire and per-region accuracy (mean of fire means, CONTRACT
  14.4) for ``fire3d/data/regional_accuracy.json``.
* :func:`live_start_check` - pseudo-live re-issue of forecasts on past fires: at fixed issue times, the old live
  start (last detection) against the latest satellite pass (with and without the decay counted from the last
  activity), scored at the same valid times (docs/validation.md section 6); :func:`summarize_live_check`.

CLI (from backend/)::

    uv run python -m fire3d.spread.validate hindcast <bundle-or-id> [...] [--offsets 24 48]
        [--adjustments 0.5 0.75 1 1.5 2] [--ensemble none] [--horizon 72] [--out report.md] [--json rows.json]
    uv run python -m fire3d.spread.validate bench <bundle-or-id> [--sizes 256 384 512] [--horizon 72]
    uv run python -m fire3d.spread.validate live-start <bundle-or-id> [...] [--every 6] [--first 6] [--latency 1]
        [--leads 12 24 48] [--json rows.json]
    uv run python -m fire3d.spread.validate hindcast '<id>@2025-08-25T19:30Z,2025-08-26T19:30Z' ...   (absolute starts)
    uv run python -m fire3d.spread.validate regional fires.json --out fire3d/data/regional_accuracy.json
"""

from __future__ import annotations

import argparse
import dataclasses
import logging
import math
import sys
import time
from pathlib import Path
from typing import Any, Callable, Sequence

import numpy as np

from .. import bundle as fbundle
from .. import config
from ..types import ProgressFn, SpreadSettings, StaticInputs, no_progress

log = logging.getLogger(__name__)

NEVER = config.NEVER
LEAD_HOURS = (12, 24, 48, 72)
TIME_TOL_H = 1e-3


def sorensen(a_mask: np.ndarray, b_mask: np.ndarray) -> float:
    """Sørensen-Dice coefficient 2|A∩B| / (|A| + |B|) of two boolean masks (1.0 when both are empty)."""
    a = np.asarray(a_mask, dtype=bool)
    b = np.asarray(b_mask, dtype=bool)
    if a.shape != b.shape:
        raise ValueError(f"mask shapes differ: {a.shape} vs {b.shape}")
    na, nb = int(a.sum()), int(b.sum())
    if na + nb == 0:
        return 1.0
    return 2.0 * int(np.count_nonzero(a & b)) / (na + nb)


def burned_by(arrival: np.ndarray, t_h: float) -> np.ndarray:
    """Pixels of an arrival raster (hours since origin, NEVER = unburned) burned by ``t_h``."""
    a = np.asarray(arrival)
    return (a < NEVER * 0.999) & (a <= t_h + TIME_TOL_H)


def _acres(mask: np.ndarray, res_m: float) -> float:
    return float(np.count_nonzero(mask)) * res_m * res_m / config.ACRE_M2


def skill_from_arrays(
    forecast_p50: np.ndarray,
    observed_arrival: np.ndarray,
    start_h: float,
    res_m: float,
    lead_hours: Sequence[float] = LEAD_HOURS,
    *,
    horizon_h: float | None = None,
    data_end_h: float | None = None,
    growth: bool = False,
) -> list[dict]:
    """Skill entries ``{lead_h, sorensen, observed_acres, forecast_acres_p50}`` (plus ``sorensen_growth`` /
    ``observed_growth_acres`` / ``forecast_growth_acres`` with ``growth=True``) for every lead within the horizon
    and the observed data range. Arrays are hours since the same origin."""
    fc = np.asarray(forecast_p50)
    ob = np.asarray(observed_arrival)
    if fc.shape != ob.shape:
        raise ValueError(f"forecast {fc.shape} and observed {ob.shape} grids differ")
    initial = burned_by(ob, start_h) if growth else None
    out: list[dict] = []
    for lead in lead_hours:
        lead = float(lead)
        if horizon_h is not None and lead > float(horizon_h) + 1e-9:
            continue
        t = start_h + lead
        if data_end_h is not None and t > data_end_h + 1e-9:
            continue
        o = burned_by(ob, t)
        f = burned_by(fc, t)
        row = {
            "lead_h": lead,
            "sorensen": round(sorensen(f, o), 4),
            "observed_acres": round(_acres(o, res_m), 1),
            "forecast_acres_p50": round(_acres(f, res_m), 1),
        }
        if growth:
            og, fg = o & ~initial, f & ~initial
            row["sorensen_growth"] = round(sorensen(fg, og), 4)
            row["observed_growth_acres"] = round(_acres(og, res_m), 1)
            row["forecast_growth_acres"] = round(_acres(fg, res_m), 1)
        out.append(row)
    return out


def skill_entry(row: dict) -> dict:
    """A ``SkillEntry`` from a :func:`skill_from_arrays` row made with ``growth=True``: the total-area Sørensen and
    ``growth_sorensen`` (the new growth only, the area burned at the start excluded; CONTRACT 14.12.7, V-R13)."""
    out = {k: row[k] for k in ("lead_h", "sorensen", "observed_acres", "forecast_acres_p50")}
    if row.get("sorensen_growth") is not None:
        out["growth_sorensen"] = row["sorensen_growth"]
    return out


def hindcast_skill(
    forecast_dir: Path,
    observed_arrival: np.ndarray,
    time_origin_ms: int | None = None,
    lead_hours: Sequence[float] = LEAD_HOURS,
    data_end_ms: int | None = None,
) -> list[dict]:
    """``[{lead_h, sorensen, observed_acres, forecast_acres_p50, growth_sorensen}]`` (the forecast manifest's
    ``skill`` shape) comparing a written forecast's p50 with the observed arrival at each lead time inside the horizon
    and the data range.

    ``forecast_dir`` is ``<bundle>/forecasts/<run_id>``. ``observed_arrival`` is in hours since ``time_origin_ms``
    (default: the forecast's own origin; a different origin is shifted). ``data_end_ms`` limits the leads to
    observed times (default: no limit beyond the horizon)."""
    fdir = Path(forecast_dir)
    doc = fbundle.read_json(fdir / "forecast.json")
    if doc.get("status") != "ready":
        raise ValueError(f"{fdir.name} is not a ready forecast (status {doc.get('status')!r})")
    bdir = fdir.parent.parent
    p50 = fbundle.read_array(bdir, doc["layers"]["arrival_p50"])
    origin = int(doc["time_origin_ms"])
    obs = np.asarray(observed_arrival, dtype=np.float64)
    if time_origin_ms is not None and int(time_origin_ms) != origin:
        shift = (int(time_origin_ms) - origin) / config.MS_PER_H
        obs = np.where(obs < NEVER * 0.999, obs + shift, NEVER)
    man = fbundle.load_manifest(bdir) or {}
    try:
        res = float(man["grid"]["fire"]["res_m"])
    except (KeyError, TypeError):
        res = float(doc["model"]["grid_res_m"])
    start_h = (int(doc["start_ms"]) - origin) / config.MS_PER_H
    end_h = None if data_end_ms is None else (int(data_end_ms) - origin) / config.MS_PER_H
    rows = skill_from_arrays(p50, obs, start_h, res, lead_hours, horizon_h=float(doc["horizon_h"]), data_end_h=end_h,
                             growth=True)
    return [skill_entry(r) for r in rows]


# ----------------------------------------------------------------------------------------------------------------
# Batch hindcast (spread_adjustment calibration)
# ----------------------------------------------------------------------------------------------------------------
def batch_hindcast(
    bundle_dirs: Sequence[Path],
    start_offsets_h: Sequence[float] = (24.0, 48.0),
    adjustments: Sequence[float] = (0.5, 0.75, 1.0, 1.5, 2.0),
    *,
    ensemble: str = "none",
    members: int | None = None,
    horizon_h: int = 72,
    lead_hours: Sequence[float] = LEAD_HOURS,
    workers: int | None = None,
    progress: ProgressFn | None = None,
    settings: SpreadSettings | None = None,
    start_times_ms: Sequence[int] | None = None,
) -> list[dict]:
    """Hindcasts for every (bundle, start offset after ignition, spread_adjustment); nothing is written to the
    bundles. ``start_times_ms`` (absolute UTC epoch ms, the pre-registered starts of docs/validation.md section 10.1)
    replaces the offsets; ``start_offset_h`` is then the start's offset after the bundle's ignition, for reference. ``settings`` holds the other spread settings (WUI, spotting, ...; its spread_adjustment is replaced). Returns one row per verifiable lead: ``{incident_id, start_offset_h, start_ms, spread_adjustment,
    ensemble, members, lead_h, sorensen, sorensen_growth, observed_acres, forecast_acres_p50,
    observed_growth_acres, forecast_growth_acres, area_ratio}`` (``area_ratio`` = forecast / observed growth).
    Runs that cannot be set up produce a row with an ``error`` and no lead."""
    from . import ensemble as ens

    progress = progress or no_progress
    rows: list[dict] = []
    tasks: list = []
    setups: dict = {}
    for bdir in bundle_dirs:
        bdir = Path(bdir)
        man = fbundle.load_manifest(bdir) or {}
        iid = str(man.get("id") or bdir.name)
        t_ign = (man.get("ignition") or {}).get("t_ms") or (man.get("summary") or {}).get("started_ms")
        if start_times_ms is not None:
            starts = [(round((int(t) - int(t_ign)) / config.MS_PER_H, 3) if t_ign is not None else 0.0, int(t))
                      for t in start_times_ms]
        else:
            starts = [(float(off), None) for off in start_offsets_h]
        for off, abs_start in starts:
            if abs_start is None and t_ign is None:
                rows.append({"incident_id": iid, "start_offset_h": float(off), "error": "no ignition time"})
                continue
            start = int(abs_start) if abs_start is not None else int(t_ign + float(off) * config.MS_PER_H)
            try:
                setup = ens.prepare_forecast(bdir, start, horizon_h, ensemble, members)
            except Exception as e:  # noqa: BLE001 - report and continue with the other runs
                rows.append({"incident_id": iid, "start_offset_h": float(off), "start_ms": start,
                             "error": config.mask_secrets(f"{type(e).__name__}: {e}")})
                continue
            for adj in adjustments:
                key = (str(bdir), float(off), float(adj))
                setups[key] = setup
                st = dataclasses.replace(settings or ens.forecast_settings(), spread_adjustment=float(adj))
                tasks += ens.member_tasks(setup, st, group=key, index0=len(tasks))
    if tasks:
        progress("hindcast", 0.0, f"{len(tasks)} member run(s)")
        results, _ = ens.run_member_tasks(tasks, workers, progress, "hindcast")
        by_group: dict = {}
        for r in results:
            by_group.setdefault(r["group"], []).append(r)
        for key, rs in by_group.items():
            setup = setups[key]
            p50 = ens.quantile_maps(np.stack([r["arrival_h"] for r in rs]), (50,))[50]
            if setup.observed is None:
                rows.append({"incident_id": setup.incident_id, "start_offset_h": key[1], "start_ms": setup.start_ms,
                             "spread_adjustment": key[2], "error": "no observed arrival"})
                continue
            end_h = None if setup.data_end_ms is None else (setup.data_end_ms - setup.time_origin_ms) / config.MS_PER_H
            for s in skill_from_arrays(p50, setup.observed, setup.start_h, setup.res_m, lead_hours,
                                       horizon_h=setup.horizon_h, data_end_h=end_h, growth=True):
                og = s["observed_growth_acres"]
                rows.append({
                    "incident_id": setup.incident_id, "start_offset_h": key[1], "start_ms": setup.start_ms,
                    "spread_adjustment": key[2], "ensemble": setup.ensemble, "members": len(rs), **s,
                    "area_ratio": round(s["forecast_growth_acres"] / og, 3) if og > 0 else None,
                })
    rows.sort(key=lambda r: (r["incident_id"], r.get("start_offset_h", 0.0), r.get("spread_adjustment", 0.0), r.get("lead_h", 0.0)))
    return rows


def summarize_hindcast(rows: Sequence[dict]) -> list[dict]:
    """Per ``spread_adjustment``: number of scored leads, mean Sørensen (total and growth-only) and median
    forecast/observed growth ratio, sorted by adjustment. ``best`` marks the highest mean growth Sørensen."""
    by: dict[float, list[dict]] = {}
    for r in rows:
        if "lead_h" in r:
            by.setdefault(float(r["spread_adjustment"]), []).append(r)
    out = []
    for adj in sorted(by):
        rs = by[adj]
        ratios = [r["area_ratio"] for r in rs if r.get("area_ratio") is not None]
        out.append({
            "spread_adjustment": adj,
            "n": len(rs),
            "sorensen_mean": round(float(np.mean([r["sorensen"] for r in rs])), 4),
            "sorensen_growth_mean": round(float(np.mean([r["sorensen_growth"] for r in rs])), 4),
            "area_ratio_median": round(float(np.median(ratios)), 3) if ratios else None,
            "best": False,
        })
    if out:
        best = max(out, key=lambda s: (s["sorensen_growth_mean"], -abs(math.log(s["spread_adjustment"]))))
        best["best"] = True
    return out


def hindcast_markdown(rows: Sequence[dict], summary: Sequence[dict] | None = None, title: str = "Hindcast calibration") -> str:
    """Markdown report (summary table + per-run rows) for ``docs/validation.md``."""
    summary = list(summary if summary is not None else summarize_hindcast(rows))
    lines = [f"# {title}", ""]
    ens = sorted({str(r.get("ensemble")) for r in rows if r.get("ensemble")})
    fires = sorted({str(r["incident_id"]) for r in rows})
    lines.append(f"Fires: {', '.join(fires) or '-'}; ensemble: {', '.join(ens) or '-'}. Sørensen = 2|F∩O|/(|F|+|O|) of "
                 "forecast p50 vs observed burned area at start + lead; *growth* excludes the area burned at the start.")
    lines.append("")
    lines.append("| spread_adjustment | scored leads | Sørensen (total) | Sørensen (growth) | growth ratio fc/obs (median) |")
    lines.append("|---:|---:|---:|---:|---:|")
    for s in summary:
        mark = " **(best)**" if s["best"] else ""
        ratio = "-" if s["area_ratio_median"] is None else f"{s['area_ratio_median']:.2f}"
        lines.append(f"| {s['spread_adjustment']:g}{mark} | {s['n']} | {s['sorensen_mean']:.3f} | {s['sorensen_growth_mean']:.3f} | {ratio} |")
    lines += ["", "| fire | start offset (h) | adj | lead (h) | Sørensen | growth Sørensen | obs ac | fc p50 ac | obs growth ac | fc growth ac |",
              "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for r in rows:
        if "lead_h" not in r:
            lines.append(f"| {r['incident_id']} | {r.get('start_offset_h', 0):g} | {r.get('spread_adjustment', '-')} | - | "
                         f"error: {r.get('error', '?')} | | | | | |")
            continue
        lines.append(f"| {r['incident_id']} | {r['start_offset_h']:g} | {r['spread_adjustment']:g} | {r['lead_h']:g} | "
                     f"{r['sorensen']:.3f} | {r['sorensen_growth']:.3f} | {r['observed_acres']:,.0f} | {r['forecast_acres_p50']:,.0f} | "
                     f"{r['observed_growth_acres']:,.0f} | {r['forecast_growth_acres']:,.0f} |")
    return "\n".join(lines) + "\n"


# ----------------------------------------------------------------------------------------------------------------
# Per-fire and per-region accuracy (CONTRACT 14.4; docs/validation.md section 10; audit V-R9)
# ----------------------------------------------------------------------------------------------------------------
ACCURACY_REGIONS: tuple[tuple[str, str], ...] = (
    ("NWCC", "Northwest"), ("NRCC", "Northern Rockies"), ("GBCC", "Great Basin"), ("SWCC", "Southwest"),
    ("SACC-SP", "Southern Plains"), ("SACC-SE", "Southeast"), ("RMCC", "Rocky Mountain"), ("EACC", "Eastern"),
    ("ONCC", "Northern California"), ("OSCC", "Southern California"),
)
MIN_FIRES = 2                 # CONTRACT 14.4: a regional score needs >= 2 fires and >= 16 scored leads
MIN_LEADS = 16
FIRE_KEYS = ("id", "name", "state", "n_leads", "growth_sorensen", "fuels_edition", "lfm_method", "era5_hours",
             "gfs_fill_hours", "weather_source", "replaced")


def region_status(n_fires: int, n_leads: int) -> str:
    """``tested`` with >= 2 fires and >= 16 scored leads; otherwise ``limited`` with at least 1 fire; else
    ``untested`` (CONTRACT 14.4: 2 fires with 12 leads are ``limited``)."""
    if int(n_fires) >= MIN_FIRES and int(n_leads) >= MIN_LEADS:
        return "tested"
    return "limited" if int(n_fires) >= 1 else "untested"


def _scored(rows: Sequence[dict] | None) -> list[dict]:
    return [r for r in rows or [] if "lead_h" in r and r.get("sorensen_growth") is not None]


def _r(v: float | None, nd: int = 3) -> float | None:
    return None if v is None else round(float(v), nd)


def fire_score(rows: Sequence[dict]) -> dict:
    """One fire's score from its hindcast rows (one row per scored lead): ``n_leads``, ``growth_sorensen`` (mean over
    its leads), ``total_sorensen``, ``by_lead`` means, ``growth_ratios`` (forecast / observed growth, per lead),
    observed / forecast growth means (ac)."""
    rs = _scored(rows)
    if not rs:
        return {"n_leads": 0, "growth_sorensen": None, "total_sorensen": None, "by_lead": {}, "growth_ratios": []}
    by: dict[str, list[float]] = {}
    for r in rs:
        by.setdefault(str(int(round(float(r["lead_h"])))), []).append(float(r["sorensen_growth"]))
    return {
        "n_leads": len(rs),
        "growth_sorensen": float(np.mean([float(r["sorensen_growth"]) for r in rs])),
        "total_sorensen": float(np.mean([float(r["sorensen"]) for r in rs])) if all("sorensen" in r for r in rs) else None,
        "by_lead": {k: float(np.mean(v)) for k, v in sorted(by.items(), key=lambda kv: float(kv[0]))},
        "growth_ratios": [float(r["area_ratio"]) for r in rs if r.get("area_ratio") is not None],
        "observed_growth_mean_ac": float(np.mean([float(r.get("observed_growth_acres") or 0.0) for r in rs])),
        "forecast_growth_mean_ac": float(np.mean([float(r.get("forecast_growth_acres") or 0.0) for r in rs])),
    }


def region_accuracy(region_id: str, name: str, fires: Sequence[dict], *, in_sample: bool = False,
                    caveats: Sequence[str] = ()) -> dict:
    """One region of ``regional_accuracy.json`` from its fires.

    Each fire is ``{id, name, state, year, rows, ignition_rows?, fuels_edition, lfm_method, era5_hours,
    gfs_fill_hours?, weather_source?, replaced?, fuel_groups?, caveats?}`` with ``rows`` the label rows (31-member p50,
    pre-registered starts) and ``ignition_rows`` the ignition + 6/12/24 h rows. The region value is the **mean of the
    fire means** (one fire with more starts cannot dominate); ``pooled_leads`` is the mean over all leads,
    ``by_lead`` the per-lead means over all leads ("12"/"24"/"48"/"72"), ``ignition_relative`` the mean of the fire
    means of the ignition rows, ``range`` the min-max of the fire means, ``growth_ratio_median`` the median of the
    per-lead forecast / observed growth ratios. Fires without a scored lead are not counted."""
    scored = []
    for f in fires:
        sc = fire_score(f.get("rows") or [])
        if sc["n_leads"] > 0:
            scored.append((f, sc))
    out: dict[str, Any] = {"id": region_id, "name": name}
    n_fires = len(scored)
    n_leads = int(sum(sc["n_leads"] for _, sc in scored))
    out["status"] = region_status(n_fires, n_leads)
    if in_sample:
        out["in_sample"] = True
    elif n_fires:
        out["in_sample"] = False
    out["n_fires"] = n_fires
    if not n_fires:
        return out
    means = [sc["growth_sorensen"] for _, sc in scored]
    all_rows = [r for f, _ in scored for r in _scored(f.get("rows"))]
    by: dict[str, list[float]] = {}
    for r in all_rows:
        by.setdefault(str(int(round(float(r["lead_h"])))), []).append(float(r["sorensen_growth"]))
    ratios = [x for _, sc in scored for x in sc["growth_ratios"]]
    ign = [fire_score(f.get("ignition_rows") or []) for f, _ in scored]
    ign_means = [s["growth_sorensen"] for s in ign if s["n_leads"] > 0]
    methods = sorted({str(f.get("lfm_method")) for f, _ in scored if f.get("lfm_method")})
    out.update({
        "n_leads": n_leads,
        "growth_sorensen": _r(np.mean(means)),
        "range": [_r(min(means)), _r(max(means))],
        "pooled_leads": _r(np.mean([float(r["sorensen_growth"]) for r in all_rows])),
        "ignition_relative": _r(np.mean(ign_means)) if ign_means else None,
        "by_lead": {k: _r(np.mean(v)) for k, v in sorted(by.items(), key=lambda kv: float(kv[0]))},
        "growth_ratio_median": _r(np.median(ratios), 2) if ratios else None,
        "years": sorted({int(f["year"]) for f, _ in scored if f.get("year") is not None}),
        "lfm_method": methods[0] if len(methods) == 1 else "+".join(methods) if methods else None,
        "fuels_editions": sorted({str(f["fuels_edition"]) for f, _ in scored if f.get("fuels_edition")}),
        "fuel_groups_tested": sorted({str(g) for f, _ in scored for g in (f.get("fuel_groups") or [])}),
        "caveats": list(caveats) + [c for f, _ in scored for c in (f.get("caveats") or [])],
        "fires": [],
    })
    for f, sc in scored:
        fire = {"id": f["id"], "name": f["name"], "state": f["state"], "n_leads": sc["n_leads"],
                "growth_sorensen": _r(sc["growth_sorensen"]), "fuels_edition": f.get("fuels_edition") or "",
                "lfm_method": f.get("lfm_method") or "", "era5_hours": float(f.get("era5_hours") or 0.0)}
        for k in ("gfs_fill_hours", "weather_source", "replaced"):
            if k in f:
                fire[k] = f[k]
        out["fires"].append(fire)
    return out


def regional_accuracy(fires: Sequence[dict], *, generated_ms: int, engine: str, settings: str,
                      in_sample_regions: Sequence[str] = ("OSCC",), region_caveats: dict[str, Sequence[str]] | None = None,
                      starts: str = "", secondary: str = "") -> dict:
    """The whole ``regional_accuracy.json`` (schema 1, CONTRACT 14.4): every one of the ten regions, from the fires
    (each with its ``region``); regions without a fire are ``untested``. Never writes ``seed``."""
    region_caveats = region_caveats or {}
    by: dict[str, list[dict]] = {}
    for f in fires:
        by.setdefault(str(f["region"]), []).append(f)
    unknown = sorted(set(by) - {rid for rid, _ in ACCURACY_REGIONS})
    if unknown:
        raise ValueError(f"unknown accuracy region(s): {unknown}")
    regions = [region_accuracy(rid, name, by.get(rid, []), in_sample=rid in set(in_sample_regions),
                               caveats=region_caveats.get(rid, ())) for rid, name in ACCURACY_REGIONS]
    return {
        "schema_version": 1,
        "generated_ms": int(generated_ms),
        "model": {"engine": engine, "settings": settings},
        "method": {"metric": "growth_sorensen", "forecast": "p50 of 31 perturbed members", "leads_h": list(LEAD_HOURS),
                   "aggregate": "mean_of_fire_means", "min_fires": MIN_FIRES, "min_leads": MIN_LEADS,
                   "weather": "archived HRRR (hindcast), no ERA5 fill",
                   "starts": starts or "pre-registered, during main growth",
                   "secondary": secondary or "ignition + 6/12/24 h"},
        "assignment": {"by": "WFIGS GACC of the fire's record (CAL FIRE fires: the matched WFIGS record)",
                       "split": {"SACC-SP": ["TX", "OK"], "SACC-SE": ["the rest of SACC"]},
                       "fallback": "California county table (ca_county_gacc.json) when present, else none: accuracy "
                                   "not yet tested here"},
        "regions": regions,
    }


# ----------------------------------------------------------------------------------------------------------------
# Pseudo-live check of the live forecast start (docs/validation.md section 6)
# ----------------------------------------------------------------------------------------------------------------
LIVE_CHECK_VARIANTS = ("last_detection", "latest_pass", "latest_pass_decay")


def _centroid_lonlat(man: dict, observed: np.ndarray) -> tuple[float, float]:
    from ..grid import grids_from_manifest

    _, fire = grids_from_manifest(man)
    b = np.asarray(observed) < NEVER * 0.999
    if b.any():
        r, c = np.nonzero(b)
        x, z = fire.pixel_center_local(r, c)
        lon, lat = fire.local_to_lonlat(float(np.mean(x)), float(np.mean(z)))
        return float(lon), float(lat)
    s = man.get("summary") or {}
    return float(s["lon"]), float(s["lat"])


def live_start_check(
    bundle_dirs: Sequence[Path],
    *,
    every_h: float = 6.0,
    first_h: float = 6.0,
    latency_h: float = 1.0,
    leads: Sequence[float] = (12.0, 24.0, 48.0),
    workers: int | None = None,
    progress: ProgressFn | None = None,
    passes_fn: Callable[..., Any] | None = None,
) -> list[dict]:
    """Re-issue forecasts on historical bundles as if they were live, to test the live start rule.

    Issue times run every ``every_h`` from ignition + ``first_h`` to the bundle's ``end_ms`` (detections are
    complete up to there). At issue time tau the system knows the polar detections and the satellite passes (NASA
    CMR archive granules over the fire centroid) up to tau - ``latency_h``, and the burned area only up to the last
    detection (the observed reconstruction clipped there). Variants:

    * ``last_detection``: the old rule, start = last detection;
    * ``latest_pass``: start = the latest pass (later than the last detection only when passes saw no fire), decay
      counted from the start;
    * ``latest_pass_decay``: the same, decay counted from the last activity (the operational setting).

    The new variants are run only when the latest pass is later than the last detection (otherwise all three are
    the same run). Every variant uses the operational settings (deterministic member, held perimeter, persistent
    GOES detections after the last detection as activity markers; no containment history exists for past fires) and
    is scored at the same valid times tau + lead against the full reconstruction. ``sorensen_growth`` counts only
    area beyond what was known at tau. Nothing is written to the bundles."""
    from ..build import live_observation as lo
    from ..sources import overpass
    from . import ensemble as ens

    progress = progress or no_progress
    passes_fn = passes_fn or overpass.fetch_passes
    rows: list[dict] = []
    tasks: list = []
    meta: dict = {}
    lat_ms = int(latency_h * config.MS_PER_H)
    for bdir in bundle_dirs:
        bdir = Path(bdir)
        man = fbundle.load_manifest(bdir) or {}
        iid = str(man.get("id") or bdir.name)
        try:
            origin = int(man["time_origin_ms"])
            res = float(man["grid"]["fire"]["res_m"])
            observed = fbundle.read_layer(bdir, "observed_arrival", man).astype(np.float32)
            end = int(man["time_range"]["end_ms"])
            data_end = ens.data_end_ms(man)
            t_ign = int((man.get("ignition") or {}).get("t_ms") or (man.get("summary") or {})["started_ms"])
            doc = fbundle.read_json(bdir / "detections.json")
        except (KeyError, OSError, ValueError) as e:
            rows.append({"incident_id": iid, "error": f"bundle unusable: {e}"})
            continue
        dets = (doc or {}).get("detections") or []
        pol = [d for d in dets if d.get("instrument") in ens.POLAR_INSTRUMENTS]
        det_xzt = np.asarray([(float(d["x"]), float(d["z"]), float(d["t_ms"])) for d in pol], dtype=np.float64).reshape(-1, 3)
        import pandas as pd

        goes = pd.DataFrame([{"t_ms": int(d["t_ms"]), "x": float(d["x"]), "z": float(d["z"]), "satellite": str(d.get("satellite"))}
                             for d in dets if d.get("instrument") == "GOES"], columns=["t_ms", "x", "z", "satellite"])
        lon, lat = _centroid_lonlat(man, observed)
        found = passes_fn(lon, lat, t_ign - 24 * config.MS_PER_H, end + 6 * config.MS_PER_H, nrt=False)
        if not len(found) and getattr(found, "errors", None):
            rows.append({"incident_id": iid, "error": "no satellite passes: " + "; ".join(found.errors)[:200]})
            continue
        pass_t = np.asarray(sorted(int(q.t_ms) for q in found), dtype=np.int64)
        tau = t_ign + int(first_h * config.MS_PER_H)
        while tau <= end:
            known_t = det_xzt[:, 2][det_xzt[:, 2] <= tau - lat_ms]
            if not len(known_t):
                tau += int(every_h * config.MS_PER_H)
                continue
            last = int(known_t.max())
            kp = pass_t[pass_t <= tau - lat_ms]
            latest = int(kp.max()) if len(kp) else None
            start_pass = max(last, latest) if latest is not None else last
            last_h = (last - origin) / config.MS_PER_H
            obs_live = np.where(burned_by(observed, last_h), observed, np.float32(NEVER)).astype(np.float32)
            known = burned_by(obs_live, last_h)
            markers = lo.activity_markers(None, goes, known, res, last, tau - lat_ms)
            quiet = int(((kp > last + 60_000)).sum()) if len(kp) else 0
            act = {"last_detection_ms": last, "now_ms": start_pass, "rule": "latest_pass" if start_pass > last + 60_000 else "last_detection",
                   "quiet_passes": quiet, "markers": markers, "passes": [], "note": "pseudo-live"}
            variants: dict[str, tuple[int, int | None]] = {"last_detection": (last, None)}
            if start_pass > last + 60_000:
                t_act = lo.last_activity_ms(act)
                variants["latest_pass"] = (start_pass, None)
                variants["latest_pass_decay"] = (start_pass, t_act if t_act is not None and t_act < start_pass else None)
            v_max = tau + int(max(leads) * config.MS_PER_H)
            for name, (start, decay_origin) in variants.items():
                horizon = int(math.ceil((v_max - start) / config.MS_PER_H))
                try:
                    setup = ens.prepare_forecast(bdir, start, horizon, "none")
                except Exception as e:  # noqa: BLE001 - report and continue
                    rows.append({"incident_id": iid, "issue_ms": tau, "variant": name, "error": config.mask_secrets(e)})
                    continue
                start_h = (start - origin) / config.MS_PER_H
                setup = dataclasses.replace(setup, mode="live", observed=obs_live, ignition_mask=burned_by(obs_live, start_h),
                                            sim_start_ms=start, detections=det_xzt[det_xzt[:, 2] <= start + 60_000],
                                            activity=act, percent_contained=None, data_end_ms=data_end)
                st = dataclasses.replace(ens.forecast_settings(), adjustment_origin_ms=decay_origin)
                _, hold = ens.setup_hold(setup, st)
                key = (iid, int(tau), name)
                meta[key] = {"observed": observed, "known": known, "origin": origin, "res": res, "data_end": data_end,
                             "start": start, "last": last, "latest": latest, "quiet_passes": quiet, "markers": len(markers),
                             "held": hold.get("held_fraction"), "tau": int(tau)}
                tasks += ens.member_tasks(setup, st, group=key, index0=len(tasks))
            tau += int(every_h * config.MS_PER_H)
    if tasks:
        progress("live-check", 0.0, f"{len(tasks)} run(s)")
        results, _ = ens.run_member_tasks(tasks, workers, progress, "live-check")
        for r in results:
            key = r["group"]
            mt = meta[key]
            for lead in leads:
                v = mt["tau"] + int(float(lead) * config.MS_PER_H)
                if mt["data_end"] is not None and v > mt["data_end"]:
                    continue
                v_h = (v - mt["origin"]) / config.MS_PER_H
                o = burned_by(mt["observed"], v_h)
                f = burned_by(r["arrival_h"], v_h)
                k = mt["known"]
                og, fg = o & ~k, f & ~k
                rows.append({
                    "incident_id": key[0], "issue_ms": key[1], "variant": key[2], "start_ms": mt["start"],
                    "last_detection_ms": mt["last"], "latest_pass_ms": mt["latest"], "quiet_passes": mt["quiet_passes"],
                    "markers": mt["markers"], "held_fraction": mt["held"], "lead_from_issue_h": float(lead),
                    "sorensen": round(sorensen(f, o), 4), "sorensen_growth": round(sorensen(fg, og), 4),
                    "observed_acres": round(_acres(o, mt["res"]), 1), "forecast_acres": round(_acres(f, mt["res"]), 1),
                    "observed_growth_acres": round(_acres(og, mt["res"]), 1), "forecast_growth_acres": round(_acres(fg, mt["res"]), 1),
                })
    rows.sort(key=lambda r: (r["incident_id"], r.get("issue_ms", 0), r.get("variant", ""), r.get("lead_from_issue_h", 0.0)))
    return rows


def summarize_live_check(rows: Sequence[dict]) -> dict:
    """``quiet``: per variant over the issues whose latest pass was later than the last detection (the only ones
    where the rules differ); ``all``: the old rule everywhere against the operational rule (``latest_pass_decay``
    where quiet, else the identical ``last_detection`` run)."""
    scored = [r for r in rows if "lead_from_issue_h" in r]
    quiet_keys = {(r["incident_id"], r["issue_ms"]) for r in scored if r["variant"] != "last_detection"}

    def stats(rs: list[dict]) -> dict:
        if not rs:
            return {"n": 0}
        ratios = [r["forecast_growth_acres"] / r["observed_growth_acres"] for r in rs if r["observed_growth_acres"] > 0]
        return {
            "n": len(rs),
            "sorensen_growth_mean": round(float(np.mean([r["sorensen_growth"] for r in rs])), 4),
            "sorensen_mean": round(float(np.mean([r["sorensen"] for r in rs])), 4),
            "growth_error_acres_mean": round(float(np.mean([abs(r["forecast_growth_acres"] - r["observed_growth_acres"]) for r in rs])), 1),
            "growth_ratio_median": round(float(np.median(ratios)), 3) if ratios else None,
            "forecast_growth_acres_mean": round(float(np.mean([r["forecast_growth_acres"] for r in rs])), 1),
            "observed_growth_acres_mean": round(float(np.mean([r["observed_growth_acres"] for r in rs])), 1),
        }

    quiet = {v: stats([r for r in scored if r["variant"] == v and (r["incident_id"], r["issue_ms"]) in quiet_keys])
             for v in LIVE_CHECK_VARIANTS}
    old = [r for r in scored if r["variant"] == "last_detection"]
    new = [r for r in scored if (r["variant"] == "latest_pass_decay") or (r["variant"] == "last_detection"
                                                                          and (r["incident_id"], r["issue_ms"]) not in quiet_keys)]
    by_lead = {}
    for lead in sorted({r["lead_from_issue_h"] for r in scored}):
        by_lead[f"{lead:g}"] = {"old": stats([r for r in old if r["lead_from_issue_h"] == lead]),
                                "new": stats([r for r in new if r["lead_from_issue_h"] == lead])}
    return {"issues": len({(r["incident_id"], r["issue_ms"]) for r in scored}), "quiet_issues": len(quiet_keys),
            "quiet": quiet, "all": {"old": stats(old), "new": stats(new)}, "by_lead": by_lead}


# ----------------------------------------------------------------------------------------------------------------
# Timing benchmark
# ----------------------------------------------------------------------------------------------------------------
def _crop_static(st: StaticInputs, r0: int, c0: int, m: int) -> StaticInputs:
    names = ("fuel_model", "slope", "aspect", "canopy_cover", "canopy_height", "canopy_base_height", "canopy_bulk_density", "elevation")
    return StaticInputs(**{k: np.ascontiguousarray(getattr(st, k)[r0:r0 + m, c0:c0 + m]) for k in names}, res_m=st.res_m)


def bench(bundle_dir: Path, sizes: Sequence[int] = (256, 384, 512), horizon_h: int = 72, start_ms: int | None = None) -> list[dict]:
    """Time one deterministic member for ``horizon_h`` hours on centred crops (M x M, M <= the fire grid) of a
    bundle's fire grid, igniting from its forecast-start mask. Returns one dict per size."""
    from . import engine
    from . import ensemble as ens

    setup = ens.prepare_forecast(Path(bundle_dir), start_ms, horizon_h, "none")
    st = engine.load_static_inputs(Path(bundle_dir))
    full = st.fuel_model.shape[0]
    rr, cc = np.nonzero(setup.ignition_mask)
    rc, ccen = int(rr.mean()), int(cc.mean())
    out = []
    for m in sizes:
        m = int(min(m, full))
        r0 = int(np.clip(rc - m // 2, 0, full - m))
        c0 = int(np.clip(ccen - m // 2, 0, full - m))
        sub = _crop_static(st, r0, c0, m)
        ign = setup.ignition_mask[r0:r0 + m, c0:c0 + m]
        if not ign.any():
            continue
        t0 = time.perf_counter()
        so = engine.simulate(sub, setup.members[0], ign, setup.sim_start_ms, (setup.end_ms - setup.sim_start_ms) / config.MS_PER_H,
                             setup.time_origin_ms, SpreadSettings())
        dt = time.perf_counter() - t0
        burned = so.result.arrival_h < NEVER * 0.999
        out.append({"m": m, "seconds": round(dt, 2), "burned_acres": round(_acres(burned, st.res_m), 1),
                    "initial_acres": round(_acres(ign, st.res_m), 1), "reached_edge": engine.reached_edge(so.result.arrival_h),
                    "ros_max_m_min": round(float(so.spread_rate_m_min.max()), 1)})
    return out


# ----------------------------------------------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------------------------------------------
def _bundle_path(ref: str) -> Path:
    p = Path(ref)
    if (p / "manifest.json").is_file():
        return p
    b = fbundle.bundle_dir(ref)
    if not (b / "manifest.json").is_file():
        raise SystemExit(f"no bundle at {ref!r} (or {b})")
    return b


def _iso_ms(text: str) -> int:
    """'2025-08-25T19:30Z' / '...:00Z' / '+00:00' -> epoch ms (UTC)."""
    from datetime import datetime, timezone

    d = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return int(d.timestamp() * 1000)


def _print_progress(step: str, fraction: float, message: str) -> None:
    print(f"[{step:>10}] {fraction * 100:5.1f}%  {config.mask_secrets(message)}", flush=True)


def main(argv: Sequence[str] | None = None) -> int:
    """``hindcast`` (batch calibration) and ``bench`` (timing) commands."""
    p = argparse.ArgumentParser(prog="python -m fire3d.spread.validate", description="Fire-3d spread verification")
    sub = p.add_subparsers(dest="command", required=True)
    h = sub.add_parser("hindcast", help="batch hindcast / spread_adjustment grid search")
    h.add_argument("bundles", nargs="+", help="bundle directories or incident ids; 'id:6,12,24' gives that bundle its own offsets")
    h.add_argument("--offsets", nargs="+", type=float, default=[24.0, 48.0], help="start offsets after ignition (h)")
    h.add_argument("--adjustments", nargs="+", type=float, default=[0.5, 0.75, 1.0, 1.5, 2.0])
    h.add_argument("--ensemble", default="none", choices=("none", "perturbed", "gfs025", "ecmwf_ifs025", "auto"))
    h.add_argument("--members", type=int, default=None)
    h.add_argument("--horizon", type=int, default=72)
    h.add_argument("--workers", type=int, default=None)
    h.add_argument("--wui", action=argparse.BooleanOptionalAction, default=None, help="WUI treatment (default: the calibrated config.FORECAST_* settings)")
    h.add_argument("--wui-adjustment", type=float, default=None, help="spread multiplier of WUI cells")
    h.add_argument("--spotting", action=argparse.BooleanOptionalAction, default=None)
    h.add_argument("--hold", action=argparse.BooleanOptionalAction, default=None, help="hold the inactive perimeter")
    h.add_argument("--decay-h", type=float, default=None, help="e-folding lead time of the multiplier (0 = constant)")
    h.add_argument("--floor", type=float, default=None, help="long-lead fraction of the multiplier")
    h.add_argument("--lfm", choices=("drought", "table", "california"), default=None,
                   help="live fuel moisture: drought-adjusted or month table (California's rule); 'california' "
                        "forces California's rule outside California too (the GSI ablation)")
    h.add_argument("--edge-m", type=float, default=None, help="ignore activity deeper than this inside the burned area (0 = off)")
    h.add_argument("--radius-m", type=float, default=None, help="perimeter within this distance of activity stays active (default 1000)")
    h.add_argument("--growth-only", action=argparse.BooleanOptionalAction, default=None,
                   help="detections count as activity only where they coincide with growth")
    h.add_argument("--out", help="write the markdown report here")
    h.add_argument("--json", help="write the rows as JSON here")
    b = sub.add_parser("bench", help="time one member at several grid sizes")
    b.add_argument("bundle")
    b.add_argument("--sizes", nargs="+", type=int, default=[256, 384, 512])
    b.add_argument("--horizon", type=int, default=72)
    lv = sub.add_parser("live-start", help="pseudo-live check of the live forecast start on past fires")
    lv.add_argument("bundles", nargs="+")
    lv.add_argument("--every", type=float, default=6.0, help="hours between issue times")
    lv.add_argument("--first", type=float, default=6.0, help="first issue time, hours after ignition")
    lv.add_argument("--latency", type=float, default=1.0, help="hours before data are known (FIRMS / CMR latency)")
    lv.add_argument("--leads", nargs="+", type=float, default=[12.0, 24.0, 48.0], help="valid times after the issue (h)")
    lv.add_argument("--workers", type=int, default=None)
    lv.add_argument("--edge-m", type=float, default=None, help="ignore activity deeper than this inside the burned area (0 = off)")
    lv.add_argument("--radius-m", type=float, default=None, help="perimeter within this distance of activity stays active (default 1000)")
    lv.add_argument("--growth-only", action=argparse.BooleanOptionalAction, default=None,
                    help="detections count as activity only where they coincide with growth")
    lv.add_argument("--json", help="write rows + summary as JSON here")
    rg = sub.add_parser("regional", help="per-region accuracy file (CONTRACT 14.4) from per-fire hindcast rows")
    rg.add_argument("fires", help="JSON {fires: [...], region_caveats?, in_sample_regions?, starts?, secondary?, settings?}")
    rg.add_argument("--out", required=True, help="regional_accuracy.json to write")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if args.command == "regional":
        import json

        spec = json.loads(Path(args.fires).read_text(encoding="utf-8"))
        doc = regional_accuracy(spec["fires"], generated_ms=int(spec.get("generated_ms") or time.time() * 1000),
                                engine=spec.get("engine") or "pyretechnics", settings=spec.get("settings") or "config.FORECAST_*",
                                in_sample_regions=spec.get("in_sample_regions") or ("OSCC",),
                                region_caveats=spec.get("region_caveats") or {}, starts=spec.get("starts") or "",
                                secondary=spec.get("secondary") or "")
        fbundle.write_json(Path(args.out), doc, indent=True)
        for r in doc["regions"]:
            print(f"{r['id']:8s} {r['status']:9s} fires {r['n_fires']} leads {r.get('n_leads', 0)} "
                  f"growth {r.get('growth_sorensen')} range {r.get('range')}")
        return 0
    if args.command == "live-start":
        if args.edge_m is not None:
            config.FORECAST_ACTIVE_EDGE_M = float(args.edge_m)
        if args.growth_only is not None:
            config.FORECAST_ACTIVE_GROWTH_ONLY = bool(args.growth_only)
        if args.radius_m is not None:
            config.FORECAST_ACTIVE_RADIUS_M = float(args.radius_m)
        rows = live_start_check([_bundle_path(b) for b in args.bundles], every_h=args.every, first_h=args.first,
                                latency_h=args.latency, leads=args.leads, workers=args.workers, progress=_print_progress)
        summary = summarize_live_check(rows)
        import json

        print(json.dumps(summary, indent=1))
        errors = [r for r in rows if "error" in r]
        for r in errors[:10]:
            print("error:", r)
        if args.json:
            fbundle.write_json(Path(args.json), {"rows": rows, "summary": summary}, indent=True)
        return 0
    if args.command == "bench":
        for r in bench(_bundle_path(args.bundle), args.sizes, args.horizon):
            print(f"M={r['m']}: {r['seconds']:.1f} s  {r['initial_acres']:,.0f} -> {r['burned_acres']:,.0f} ac  "
                  f"edge={r['reached_edge']}  ros max {r['ros_max_m_min']} m/min")
        return 0
    from .ensemble import forecast_settings

    base = forecast_settings()
    for name, val in (("wui", args.wui), ("wui_spread_adjustment", args.wui_adjustment), ("spotting", args.spotting),
                      ("hold_inactive", args.hold), ("adjustment_decay_h", args.decay_h), ("adjustment_floor", args.floor),
                      ("active_edge_m", args.edge_m), ("active_growth_only", args.growth_only), ("active_radius_m", args.radius_m)):
        if val is not None:
            base = dataclasses.replace(base, **{name: val})
    if args.lfm == "california":
        config.LFM_FORCE_CALIFORNIA = True
    elif args.lfm is not None:
        config.DROUGHT_ADJUSTED_LFM = args.lfm == "drought"
    groups: dict[tuple[float, ...], list[Path]] = {}
    absolute: list[tuple[Path, list[int]]] = []
    for spec in args.bundles:
        if "@" in spec and not Path(spec).exists():      # 'id@2025-08-25T19:30Z,...': absolute UTC starts
            name, _, times = spec.partition("@")
            absolute.append((_bundle_path(name), [_iso_ms(t) for t in times.split(",") if t.strip()]))
            continue
        name, sep, offs = spec.rpartition(":") if ":" in spec and not Path(spec).exists() else (spec, "", "")
        key = tuple(float(o) for o in offs.split(",")) if sep else tuple(args.offsets)
        groups.setdefault(key, []).append(_bundle_path(name))
    rows = []
    for offsets, dirs in groups.items():
        rows += batch_hindcast(dirs, list(offsets), args.adjustments, ensemble=args.ensemble, members=args.members,
                               horizon_h=args.horizon, workers=args.workers, progress=_print_progress, settings=base)
    for bdir, times in absolute:
        rows += batch_hindcast([bdir], (), args.adjustments, ensemble=args.ensemble, members=args.members,
                               horizon_h=args.horizon, workers=args.workers, progress=_print_progress, settings=base,
                               start_times_ms=times)
    rows.sort(key=lambda r: (r["incident_id"], r.get("start_offset_h", 0.0), r.get("spread_adjustment", 0.0), r.get("lead_h", 0.0)))
    summary = summarize_hindcast(rows)
    md = hindcast_markdown(rows, summary)
    print(md)
    if args.out:
        Path(args.out).write_text(md, encoding="utf-8")
    if args.json:
        fbundle.write_json(Path(args.json), {"rows": rows, "summary": summary}, indent=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
