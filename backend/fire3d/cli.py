"""Command-line entry points (SPEC 10): ``uv run python -m fire3d.cli <command>``.

Commands:
  ``catalog --mode live|historical [--min-acres N] [--refresh]``  list incidents
  ``build <id-or-name> [--force]``                                 build (or rebuild) a bundle, with progress
  ``forecast <id-or-name> [--start ISO] [--horizon 72] [--ensemble auto] [--members N]``
  ``hindcast <id-or-name> --start ISO [...]``                      forecast from a past moment and print its skill
  ``serve [--port 8710] [--host 127.0.0.1] [--reload] [--live/--no-live] [--auto-build/--no-auto-build]``

Incidents can be given by id or by (partial, case-insensitive) name, e.g. ``build eaton``. Modules are imported
lazily, so each command works as soon as the modules it needs exist. Errors are printed without secrets.
"""

from __future__ import annotations

import argparse
import difflib
import logging
import os
import re
import sys
import time
from typing import Any, Sequence

from . import config


def _progress_printer():
    """A progress callback printing ``[step] pct  message`` lines (at most every 0.5 s unless the step changes)."""
    state = {"step": None, "t": 0.0}

    def progress(step: str, fraction: float, message: str = "") -> None:
        now = time.monotonic()
        if step == state["step"] and now - state["t"] < 0.5 and fraction < 1.0:
            return
        state["step"], state["t"] = step, now
        print(f"[{step:>12}] {fraction * 100:5.1f}%  {config.mask_secrets(message)}", flush=True)

    return progress


def _norm(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()
    return re.sub(r"\s+(fire|incident|complex)$", "", s)


def match_incidents(ref: str, summaries: Sequence[Any]) -> list[Any]:
    """Every summary matching ``ref`` by name or id, best first: exact name, name prefix, substring, all words,
    then (only when nothing else matched) close spellings; within a tier live incidents and larger fires first."""
    needle = _norm(ref)
    if not needle:
        return []
    words = needle.split()
    tiers: list[list[Any]] = [[], [], [], [], []]
    for s in summaries:
        name = _norm(s.name)
        if name == needle or s.id.lower() == ref.lower():
            tiers[0].append(s)
        elif name.startswith(needle) or s.id.lower().startswith(ref.lower()):
            tiers[1].append(s)
        elif needle in name:
            tiers[2].append(s)
        elif all(w in name.split() for w in words):
            tiers[3].append(s)
    if not any(tiers):
        names = {_norm(s.name): s for s in summaries}
        for n in difflib.get_close_matches(needle, list(names), n=5, cutoff=0.75):
            tiers[4].append(names[n])
    out: list[Any] = []
    for tier in tiers:
        out.extend(sorted(tier, key=lambda s: (s.mode != "live", -(s.acres or 0.0))))
    return out


def resolve_incident(ref: str) -> str:
    """An incident id from an id (bundle on disk or catalog entry) or a fuzzy name."""
    from .bundle import MANIFEST_NAME, bundle_dir
    from .catalog import get_catalog, get_summary

    ref = ref.strip()
    try:
        bdir = bundle_dir(ref)
    except ValueError:
        bdir = None
    if bdir is not None:
        if (bdir / MANIFEST_NAME).is_file():
            return ref
        try:
            if get_summary(ref) is not None:
                return ref
        except NotImplementedError:
            raise
        except Exception as e:  # the catalog may be offline; try the name search below
            print(f"warning: catalog lookup failed: {config.mask_secrets(e)}", file=sys.stderr)
    summaries: list[Any] = []
    for mode in ("live", "historical"):
        try:
            summaries.extend(get_catalog(mode, min_acres=0))
        except NotImplementedError:
            raise
        except Exception as e:
            print(f"warning: {mode} catalog unavailable: {config.mask_secrets(e)}", file=sys.stderr)
    found = match_incidents(ref, summaries)
    if not found:
        raise SystemExit(f"no incident matches {ref!r}")
    if len(found) > 1:
        others = ", ".join(f"{s.name} ({s.id})" for s in found[1:6])
        print(f"'{ref}' -> {found[0].name} ({found[0].id}); other matches: {others}", file=sys.stderr)
    return found[0].id


# ----------------------------------------------------------------------------------------------------------------
# Commands
# ----------------------------------------------------------------------------------------------------------------
def _cmd_catalog(args: argparse.Namespace) -> int:
    from .catalog import get_catalog

    rows = get_catalog(args.mode, min_acres=args.min_acres, refresh=args.refresh)
    print(f"{len(rows)} {args.mode} incidents")
    for s in rows:
        acres = f"{s.acres:,.0f}" if s.acres is not None else "?"
        cont = f"{s.percent_contained:.0f}%" if s.percent_contained is not None else "-"
        det = "" if s.detections_24h is None else f"  det24h={s.detections_24h}"
        print(f"  {s.id:<46} {s.name[:30]:<30} {acres:>10} ac {cont:>5}  {s.bundle_status}{det}")
    return 0


def _cmd_build(args: argparse.Namespace) -> int:
    from .build.pipeline import build_incident

    incident_id = resolve_incident(args.incident)
    print(f"building {incident_id}{' (force)' if args.force else ''} into {config.INCIDENTS_DIR / incident_id}", flush=True)
    t0 = time.monotonic()
    m = build_incident(incident_id, progress=_progress_printer(), force=args.force)
    print(f"built {m.id}: status={m.status} in {time.monotonic() - t0:.0f} s")
    print(f"  AOI {m.grid.extent_m / 1000:g} km {m.grid.crs}, fire grid {m.grid.fire.width}² @ {m.grid.fire.res_m:.1f} m, "
          f"elevation {m.grid.elev_min_m:.0f}-{m.grid.elev_max_m:.0f} m")
    print(f"  layers: {', '.join(sorted(m.layers))}")
    print(f"  observed: {m.stats.final_acres_observed:,.0f} ac, {m.stats.detections} detections, {m.stats.perimeters} perimeters")
    for f in m.forecasts:
        print(f"  forecast {f.run_id}: {f.status} {f.ensemble} x{f.members}, +{f.horizon_h} h")
    for w in m.warnings:
        print(f"  warning: {config.mask_secrets(w)}")
    return 0


def _print_skill(skill: Sequence[Any]) -> None:
    print("  lead    sorensen   observed ac   forecast p50 ac")
    for s in skill:
        g = s if isinstance(s, dict) else s.model_dump()
        print(f"  {g['lead_h']:>4.0f} h  {g['sorensen']:>8.3f}   {g['observed_acres']:>11,.0f}   {g['forecast_acres_p50']:>15,.0f}")


def _run_forecast(args: argparse.Namespace, hindcast: bool) -> int:
    from .bundle import bundle_dir, forecast_dir, load_manifest, read_layer
    from .spread.ensemble import run_forecast
    from .timeutil import iso_to_ms, ms_to_iso

    incident_id = resolve_incident(args.incident)
    bdir = bundle_dir(incident_id)
    m = load_manifest(bdir)
    if not m or m.get("status") != "ready":
        raise SystemExit(f"{incident_id} has no ready bundle; run `build {incident_id}` first")
    start_ms = iso_to_ms(args.start) if args.start else None
    t0 = time.monotonic()
    fm = run_forecast(bdir, start_ms=start_ms, horizon_h=args.horizon, ensemble=args.ensemble, members=args.members, progress=_progress_printer())
    print(f"forecast {fm.run_id}: {fm.status}, {fm.weather.ensemble} x{fm.weather.members} ({fm.weather.source}), "
          f"start {ms_to_iso(fm.start_ms)}, runtime {fm.runtime_s:.1f} s (wall {time.monotonic() - t0:.0f} s)")
    p = fm.series
    for lead in sorted({24, 48, 72, fm.horizon_h}):
        t = fm.start_ms + lead * 3_600_000
        if lead <= fm.horizon_h and t in p.t_ms:
            i = p.t_ms.index(t)
            print(f"  +{lead:>3} h area p10 {p.area_acres_p10[i]:>9,.0f}  p50 {p.area_acres_p50[i]:>9,.0f}  p90 {p.area_acres_p90[i]:>9,.0f} ac")
    skill = list(fm.skill or [])
    if hindcast and not skill:
        try:
            from .spread.ensemble import data_end_ms
            from .spread.validate import hindcast_skill

            obs = read_layer(bdir, "observed_arrival", m)
            skill = hindcast_skill(forecast_dir(bdir, fm.run_id), obs, time_origin_ms=m["time_origin_ms"],
                                   data_end_ms=data_end_ms(m))
        except Exception as e:
            print(f"  skill unavailable: {config.mask_secrets(e)}")
    if skill:
        print("hindcast skill (Sørensen of forecast p50 vs observed burned area):")
        _print_skill(skill)
    elif hindcast:
        print("  no lead time falls inside the observed period, so there is no skill score")
    for w in fm.warnings:
        print(f"  warning: {config.mask_secrets(w)}")
    return 0 if fm.status == "ready" else 1


def _cmd_forecast(args: argparse.Namespace) -> int:
    return _run_forecast(args, hindcast=False)


def _cmd_hindcast(args: argparse.Namespace) -> int:
    return _run_forecast(args, hindcast=True)


def _cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    if args.port == 8000:
        print("note: port 8000 belongs to another local app; the Fire-3d API uses 8710", file=sys.stderr)
    for flag, env, attr in ((args.live, "FIRE3D_LIVE", "LIVE_ENABLED"), (args.auto_build, "FIRE3D_AUTO_BUILD_LIVE", "AUTO_BUILD_LIVE")):
        if flag is not None:
            os.environ[env] = "1" if flag else "0"     # for --reload subprocesses
            setattr(config, attr, bool(flag))           # this process has already imported config
    uvicorn.run("fire3d.api.app:app", host=args.host, port=args.port, reload=args.reload,
                reload_dirs=[str(config.PACKAGE_DIR)] if args.reload else None)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m fire3d.cli", description="Fire-3d backend CLI (Wildfire Forensics & Forecast)")
    p.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    sub = p.add_subparsers(dest="command", metavar="<command>")

    c = sub.add_parser("catalog", help="list live or historical incidents")
    c.add_argument("--mode", choices=("live", "historical"), default="live")
    c.add_argument("--min-acres", type=float, default=None)
    c.add_argument("--refresh", action="store_true", help="bypass the catalog cache")
    c.set_defaults(func=_cmd_catalog)

    b = sub.add_parser("build", help="build (or rebuild) an incident bundle")
    b.add_argument("incident", help="incident id or name")
    b.add_argument("--force", action="store_true", help="rebuild even if the bundle is ready")
    b.set_defaults(func=_cmd_build)

    for name, helptext, start_required in (("forecast", "run an ensemble forecast", False),
                                           ("hindcast", "forecast from a past moment and score it against what burned", True)):
        f = sub.add_parser(name, help=helptext)
        f.add_argument("incident", help="incident id or name")
        f.add_argument("--start", required=start_required, help="ISO start time (UTC unless an offset is given)")
        f.add_argument("--horizon", type=int, default=72, help="hours (default 72)")
        f.add_argument("--ensemble", choices=("auto", "gfs025", "ecmwf_ifs025", "perturbed", "none"), default="auto")
        f.add_argument("--members", type=int, default=None)
        f.set_defaults(func=_cmd_forecast if name == "forecast" else _cmd_hindcast)

    s = sub.add_parser("serve", help="run the API (uvicorn fire3d.api.app:app)")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8710)
    s.add_argument("--reload", action="store_true")
    s.add_argument("--live", dest="live", action="store_true", default=None, help="run the live refresh loop (FIRE3D_LIVE=1)")
    s.add_argument("--no-live", dest="live", action="store_false", help="no live refresh loop (FIRE3D_LIVE=0)")
    s.add_argument("--auto-build", dest="auto_build", action="store_true", default=None, help="auto-build live incidents")
    s.add_argument("--no-auto-build", dest="auto_build", action="store_false")
    s.set_defaults(func=_cmd_serve)
    return p


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return 0
    from .api.app import LOG_FORMAT, MaskingFormatter

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format=LOG_FORMAT)
    for h in logging.getLogger().handlers:
        h.setFormatter(MaskingFormatter(LOG_FORMAT))     # secrets masked in messages and tracebacks
    try:
        return int(args.func(args) or 0)
    except NotImplementedError as e:
        print(f"not implemented yet: {config.mask_secrets(e)}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
    except SystemExit:
        raise
    except Exception as e:
        if args.verbose:
            import traceback

            print(config.mask_secrets(traceback.format_exc()), file=sys.stderr)
        print(f"error: {type(e).__name__}: {config.mask_secrets(e)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
