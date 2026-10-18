"""Shared fakes for the api agent's tests (no tests here).

:class:`FakeBuild` replaces the modules other agents own (catalog, static layers, observed, weather, behaviour,
ensemble) with small deterministic versions that write a contract-complete bundle, so the pipeline, jobs and API
can be tested offline and fast.
"""

from __future__ import annotations

import collections
import io
import math
from typing import Any

import numpy as np

from fire3d import bundle, config
from fire3d.contracts import ForecastManifest, IncidentSummary
from fire3d.grid import weather_axes
from fire3d.timeutil import HOUR_MS, floor_hour_ms, now_ms

STARTED_MS = 1755181560000          # 2025-08-14T14:26:00Z
FAKE_KEY = "0123456789abcdef0123456789abcdef"   # FIRMS-key-shaped test value (never a real key)


def make_summary(
    iid: str = "2025-test-fire-abc123",
    mode: str = "historical",
    *,
    name: str = "Test Fire",
    lat: float = 34.20,
    lon: float = -118.07,
    acres: float | None = 1500.0,
    started_ms: int | None = None,
    detections_24h: int | None = None,
) -> IncidentSummary:
    started = started_ms if started_ms is not None else (STARTED_MS if mode == "historical" else floor_hour_ms(now_ms()) - 30 * HOUR_MS + 26 * 60_000)
    year, uid6 = int(iid[:4]), iid.rsplit("-", 1)[-1]          # ids follow SPEC 4.4: {year}-{slug(name)}-{uid[:6]}
    return IncidentSummary(
        id=iid, name=name, mode=mode, year=year, calfire_uid=f"{uid6}00-0000-4000-8000-000000000000",
        started_ms=started, updated_ms=started + 5 * 24 * HOUR_MS if mode == "historical" else now_ms(),
        contained_ms=started + 6 * 24 * HOUR_MS if mode == "historical" else None, acres=acres,
        percent_contained=100.0 if mode == "historical" else 20.0, is_active=mode == "live", county="Los Angeles",
        location="Test location", admin_unit="Test unit", url=None, lat=lat, lon=lon,
        detections_24h=detections_24h if mode == "live" else None, bundle_status="none", bundle_built_ms=None,
    )


def _jpeg(w: int = 64, h: int = 64) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (w, h), (70, 90, 60)).save(buf, format="JPEG", quality=80)
    return buf.getvalue()


class FakeBuild:
    """Fake versions of every module the pipeline calls; ``calls`` counts invocations."""

    def __init__(self, summaries: list[IncidentSummary] | None = None, *, radius_m: float = 1500.0, growth_h: float = 20.0,
                 peak_gust_hour: float = 8.0, fail: dict[str, BaseException] | None = None):
        self.summaries = {s.id: s for s in (summaries or [])}
        self.radius_m = radius_m
        self.growth_h = growth_h
        self.peak_gust_hour = peak_gust_hour        # hours after ignition, inside the growth window
        self.fail = dict(fail or {})
        self.calls: collections.Counter[str] = collections.Counter()
        self.forecast_args: list[dict] = []
        self.ctx_end_ms: list[int | None] = []
        self.ctx_now_ms: list[int | None] = []

    # ------------------------------------------------------------------ install
    def install(self, monkeypatch: Any) -> "FakeBuild":
        import fire3d.build.aoi as aoi
        import fire3d.build.observed as observed
        import fire3d.build.weather_bundle as weather_bundle
        import fire3d.catalog as catalog
        import fire3d.spread.behavior as behavior
        import fire3d.spread.ensemble as ensemble

        monkeypatch.setattr(catalog, "get_summary", self.get_summary)
        monkeypatch.setattr(catalog, "get_catalog", self.get_catalog)
        monkeypatch.setattr(catalog, "estimate_fire_bbox", self.estimate_fire_bbox)
        monkeypatch.setattr(catalog, "live_detections_24h_total", lambda refresh=False: 1234, raising=False)
        monkeypatch.setattr(aoi, "build_static_layers", self.build_static_layers)
        monkeypatch.setattr(observed, "build_observed", self.build_observed)
        monkeypatch.setattr(weather_bundle, "build_weather", self.build_weather)
        monkeypatch.setattr(behavior, "annotate_weather_with_behavior", self.annotate)
        monkeypatch.setattr(ensemble, "run_forecast", self.run_forecast)
        return self

    def _maybe_fail(self, step: str) -> None:
        if step in self.fail:
            raise self.fail[step]

    # ------------------------------------------------------------------ catalog
    def get_summary(self, incident_id: str) -> IncidentSummary | None:
        self.calls["get_summary"] += 1
        return self.summaries.get(incident_id)

    def get_catalog(self, mode: str, min_acres: float | None = None, refresh: bool = False,
                    year: int | None = None) -> list[IncidentSummary]:
        self.calls["get_catalog"] += 1
        rows = [s for s in self.summaries.values() if s.mode == mode and (min_acres is None or (s.acres or 0) >= min_acres)]
        if mode == "historical" and year is not None:          # a year list: that year's fires, rows in mode "historical"
            rows = [s.model_copy(update={"mode": "historical", "detections_24h": None}) for s in self.summaries.values()
                    if s.year == year and (min_acres is None or (s.acres or 0) >= min_acres)]
        if mode == "historical":
            return sorted(rows, key=lambda s: -(s.acres or 0))
        return sorted(rows, key=lambda s: (-(s.detections_24h or 0), -(s.acres or 0)))

    def estimate_fire_bbox(self, summary: IncidentSummary) -> tuple[float, float, float, float] | None:
        self.calls["bbox"] += 1
        self._maybe_fail("bbox")
        d_lat = self.radius_m / 111_320.0
        d_lon = d_lat / math.cos(math.radians(summary.lat))
        return (summary.lon - d_lon, summary.lat - d_lat, summary.lon + d_lon, summary.lat + d_lat)

    # ------------------------------------------------------------------ static layers
    def build_static_layers(self, ctx: Any) -> None:
        self.calls["static"] += 1
        self.ctx_end_ms.append(ctx.end_ms)
        self.ctx_now_ms.append(ctx.now_ms)
        for step in ("dem", "sky_view", "landfire", "naip", "water", "trees", "dnbr"):
            ctx.progress(step, 0.5, f"{step} half")
            ctx.progress(step, 1.0, f"{step} done")
        self._maybe_fail("static")
        b = ctx.bundle_dir
        X, Z = ctx.render_grid.cell_centers_local()
        elev = (800.0 + 0.03 * X - 0.02 * Z).astype(np.float32)
        bundle.write_layer(b, "elevation", elev, "render", "m", "Elevation (fake)")
        bundle.write_layer(b, "sky_view", np.full(ctx.render_grid.shape, 200, np.uint8), "render", None, "Sky view (fake)")
        bundle.write_layer(b, "water", np.zeros(ctx.render_grid.shape, np.uint8), "render", None, "Water (fake)")
        fshape = ctx.fire_grid.shape
        bundle.write_layer(b, "fuel", np.full(fshape, 102, np.uint8), "fire", None, "FBFM40 (fake)", nodata=0)
        bundle.write_layer(b, "canopy_cover", np.full(fshape, 30, np.uint8), "fire", "%", "Canopy cover (fake)")
        bundle.write_layer(b, "canopy_height", np.full(fshape, 8.0, np.float32), "fire", "m", "Canopy height (fake)")
        bundle.write_image_layer(b, "naip", _jpeg(), 64, 64, "NAIP (fake)")
        trees = np.array([[0.0, 800.0, 0.0, 9.0, 2.5, 0.0], [100.0, 803.0, -50.0, 6.0, 1.7, 1.0]], np.float32)
        bundle.write_layer(b, "trees", trees, "points", None, "Trees (fake)")
        bundle.write_npz(b / bundle.STATIC_NPZ, fuel_model=np.full(fshape, 102, np.int16), elevation=np.full(fshape, 800.0, np.float32))

        def fn(m: dict) -> None:
            m["grid"]["elev_min_m"], m["grid"]["elev_max_m"] = float(elev.min()), float(elev.max())
            m["fuels_edition"] = "LF2025" if ctx.mode == "live" else "LF2024"
            m.setdefault("data_sources", []).append({"name": "Terrain (fake)", "detail": "test", "fetched_ms": now_ms()})

        bundle.update_manifest(b, fn)

    # ------------------------------------------------------------------ observed
    def times(self, ctx: Any) -> tuple[float, int, int]:
        """(ignition hour, end_ms, now_ms)."""
        origin = ctx.time_origin_ms
        ign_h = (ctx.summary.started_ms - origin) / HOUR_MS
        if ctx.mode == "live":
            now = origin + int((ign_h + 0.6 * self.growth_h) * HOUR_MS)
            return ign_h, now, now
        end = origin + int((ign_h + self.growth_h + 24) * HOUR_MS)
        return ign_h, end, end

    def build_observed(self, ctx: Any) -> None:
        self.calls["observed"] += 1
        ctx.progress("detections", 0.3, "fake detections")
        self._maybe_fail("observed")
        b, origin, fire = ctx.bundle_dir, ctx.time_origin_ms, ctx.fire_grid
        ign_h, end_ms, now_ms_ = self.times(ctx)
        now_h = (now_ms_ - origin) / HOUR_MS
        X, Z = fire.cell_centers_local()
        r = np.hypot(X, Z)
        arrival = (ign_h + r / (self.radius_m / self.growth_h)).astype(np.float32)
        arrival[(r > self.radius_m) | (arrival > now_h)] = config.NEVER
        bundle.write_layer(b, "observed_arrival", arrival, "fire", "h", "Observed arrival (fake)")
        t = list(range(origin, now_ms_ + 1, HOUR_MS))
        cell_ac = fire.res_m ** 2 / config.ACRE_M2
        area = [float((arrival <= (ti - origin) / HOUR_MS).sum() * cell_ac) for ti in t]
        growth = [0.0] + [max(0.0, area[i] - area[i - 1]) for i in range(1, len(area))]
        bundle.write_json(b / "timeseries.json", {
            "step_h": 1, "t_ms": t, "area_acres": area, "growth_acres_per_h": growth,
            "ros_ch_per_h": [0.0] * len(t), "detections_per_h": [0] * len(t),
        })
        bundle.write_json(b / "events.json", {"events": [
            {"id": "ev-01", "type": "ignition", "t_ms": ctx.summary.started_ms, "title": "Ignition", "detail": "fake",
             "x": 0.0, "z": 0.0, "confidence": "estimated", "source": "test"},
        ]})
        lon, lat = fire.local_to_lonlat(0.0, 0.0)
        bundle.write_json(b / "detections.json", {"detections": [
            {"t_ms": ctx.summary.started_ms + HOUR_MS, "lat": lat, "lon": lon, "x": 0.0, "z": 0.0, "frp": 12.5,
             "satellite": "N20", "instrument": "VIIRS", "confidence": "n", "daynight": "D", "footprint_m": 375.0},
        ]})
        bundle.write_json(b / "perimeters.json", {"perimeters": []})

        def fn(m: dict) -> None:
            m["time_range"] = {"start_ms": origin, "end_ms": end_ms, "now_ms": now_ms_}
            m["ignition"] = {"x": 0.0, "z": 0.0, "lat": lat, "lon": lon, "t_ms": ctx.summary.started_ms, "source": "CAL FIRE (fake)"}
            m["default_profile_path"] = [[0.0, 0.0], [self.radius_m, 0.0]]
            m["stats"] = {"final_acres_observed": area[-1], "detections": 1, "perimeters": 0}

        bundle.update_manifest(b, fn)
        ctx.progress("arrival", 1.0, "fake arrival done")

    # ------------------------------------------------------------------ weather
    def build_weather(self, ctx: Any) -> None:
        self.calls["weather"] += 1
        self._maybe_fail("weather")
        origin = ctx.time_origin_ms
        ign_h, end_ms, _ = self.times(ctx)
        t = list(range(origin - 72 * HOUR_MS, end_ms + 72 * HOUR_MS + 1, HOUR_MS))
        n = len(t)
        gust = np.full(n, 6.0)
        peak_t = floor_hour_ms(origin + (ign_h + self.peak_gust_hour) * HOUR_MS)
        gust[t.index(peak_t)] = 22.0
        gust[-10] = 35.0                    # stronger gust long after the fire stopped growing: must be ignored
        xs, zs = weather_axes(ctx.render_grid)
        series = lambda v: [float(v)] * n  # noqa: E731
        bundle.write_json(ctx.bundle_dir / "weather.json", {
            "source": "open-meteo:fake", "t_ms": t,
            "at_fire": {
                "temp_c": series(28), "rh_pct": series(15), "dewpoint_c": series(0), "wind_speed_ms": [float(g * 0.6) for g in gust],
                "wind_dir_deg": series(45), "wind_gust_ms": [float(g) for g in gust], "precip_mm": series(0),
                "fm1_pct": series(4), "fm10_pct": series(6), "fm100_pct": series(9), "ffwi": series(40),
            },
            "grid": {"nx": 4, "ny": 4, "x": xs, "z": zs, "u_ms": [1.0] * (16 * n), "v_ms": [-1.0] * (16 * n)},
            "forecast_from_ms": None,
        })
        self.peak_t = peak_t

    def annotate(self, bdir: Any) -> None:
        self.calls["annotate"] += 1
        self._maybe_fail("annotate")
        w = bundle.read_json(bdir / "weather.json")
        n = len(w["t_ms"])
        w["at_fire"]["flame_length_ft"] = [3.0] * n
        w["at_fire"]["ros_ch_per_h_potential"] = [10.0] * n
        bundle.write_json(bdir / "weather.json", w)

    # ------------------------------------------------------------------ forecast
    def run_forecast(self, bundle_dir: Any, start_ms: int | None = None, horizon_h: int = 72, ensemble: str = "auto",
                     members: int | None = None, progress: Any = None) -> ForecastManifest:
        self.calls["forecast"] += 1
        self.forecast_args.append({"start_ms": start_ms, "horizon_h": horizon_h, "ensemble": ensemble, "members": members})
        if progress:
            progress("weather", 1.0, "fake members")
            progress("members", 0.5, "16/31")
            progress("members", 1.0, "31/31")
            progress("quantiles", 1.0, "done")
        self._maybe_fail("forecast")
        m = bundle.load_manifest(bundle_dir)
        live = m["mode"] == "live"
        default = m["time_range"]["now_ms"] if live else m["ignition"]["t_ms"] + 24 * HOUR_MS      # SPEC 6 defaults
        start = int(start_ms if start_ms is not None else default)
        run_id = bundle.new_forecast_run_id(bundle_dir)
        rel = f"forecasts/{run_id}"
        fshape = (m["grid"]["fire"]["height"], m["grid"]["fire"]["width"])
        layers = {}
        for name in ("arrival_p10", "arrival_p50", "arrival_p90", "burn_probability", "flame_length_p50"):
            layers[name] = bundle.write_layer(bundle_dir, name, np.full(fshape, config.NEVER, np.float32), "fire", None, name, rel_dir=rel, register=False)
        t = [start + h * HOUR_MS for h in range(horizon_h + 1)]
        ens = ("gfs025" if live else "perturbed") if ensemble == "auto" else ensemble
        fm = {
            "run_id": run_id, "incident_id": m["id"], "status": "ready", "issued_ms": now_ms(), "start_ms": start, "horizon_h": horizon_h,
            "time_origin_ms": m["time_origin_ms"],
            "model": {"engine": "pyretechnics", "version": "test", "surface_lw_ratio_model": "behave", "crown": True, "spotting": False,
                      "spread_adjustment": 1.0, "grid_res_m": float(m["grid"]["fire"]["res_m"])},
            "weather": {"source": "fake", "ensemble": ens, "members": members or 31},
            "layers": layers,
            "series": {"t_ms": t, "area_acres_p10": [100.0] * len(t), "area_acres_p50": [200.0] * len(t),
                       "area_acres_p90": [300.0] * len(t), "ros_ch_per_h_p50": [5.0] * len(t)},
            "runtime_s": 0.1, "warnings": [],
        }
        if not live:
            fm["skill"] = [{"lead_h": 24.0, "sorensen": 0.8, "observed_acres": 1000.0, "forecast_acres_p50": 900.0}]
        bundle.write_json(bundle.forecast_dir(bundle_dir, run_id) / "forecast.json", fm)
        summary = {"run_id": run_id, "status": "ready", "issued_ms": fm["issued_ms"], "start_ms": start, "horizon_h": horizon_h,
                   "ensemble": ens, "members": members or 31, "file": f"{rel}/forecast.json"}
        bundle.update_manifest(bundle_dir, lambda mm: mm.__setitem__("forecasts", [summary] + list(mm.get("forecasts") or [])))
        return ForecastManifest.model_validate(fm)
