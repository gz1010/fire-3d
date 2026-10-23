"""Brief 3 validation outside California: the pre-registered test fires, their starts and the protocol driver.

The fire list, the absolute UTC hindcast starts and the replacement rule are pre-registered in ``docs/validation.md``
(section 10.1, committed before any hindcast outside California); this module holds the same data so the runs use
exactly those starts (never ``ignition.t_ms`` of a built bundle). Sources: ``docs/redesign/audit-3/validation.md``
section 3 (fires, ids, IRWIN ids, starts, fuels editions, UTM zones) and the NIFC WFIGS incident records
(``FireDiscoveryDateTime``, read through ``fire3d.catalog.get_summary`` on 2026-10-23).

Commands (from ``backend/``)::

    uv run python scripts/validate_us_fires.py starts            # the pre-registered start table (markdown)
    uv run python scripts/validate_us_fires.py checks [ids...]   # protocol step 2 bundle checks (JSON)
    uv run python scripts/validate_us_fires.py hindcast <id> --what main|main_det|ignition|ablation_det --out-dir <dir>
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

UTC = timezone.utc


@dataclass(frozen=True)
class TestFire:
    n: int                      # row of docs/redesign/audit-3/validation.md section 3
    id: str
    name: str
    state: str
    region: str                 # accuracy region (CONTRACT 14.4): the WFIGS GACC, SACC split into SP / SE
    irwin_id: str
    discovery_utc: str          # WFIGS FireDiscoveryDateTime (UTC)
    time_zone: str              # IANA zone of the point of origin (fire3d.regions)
    fuels_edition: str          # LF{federal FY of ignition - 1}
    utm_zone: int
    main_starts_utc: tuple[str, ...]      # pre-registered label starts (absolute UTC)
    fuel_group: str             # the fuel group this fire tests (V section 3 "Fuel")
    reserve: bool = False
    notes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def discovery(self) -> datetime:
        return parse_utc(self.discovery_utc)

    def ignition_starts_utc(self, offsets_h: tuple[float, ...] = (6.0, 12.0, 24.0)) -> tuple[str, ...]:
        """The fixed California rule, ignition + 6/12/24 h, from the WFIGS discovery time (never ``ignition.t_ms``)."""
        return tuple(fmt_utc(self.discovery + timedelta(hours=h)) for h in offsets_h)


def parse_utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(UTC)


def fmt_utc(d: datetime) -> str:
    d = d.astimezone(UTC)
    return d.strftime("%Y-%m-%dT%H:%M:%SZ") if d.second else d.strftime("%Y-%m-%dT%H:%MZ")


def to_ms(s: str) -> int:
    return int(parse_utc(s).timestamp() * 1000)


def local_label(s: str, tz: str) -> str:
    d = parse_utc(s).astimezone(ZoneInfo(tz))
    return d.strftime("%b %d %H:%M ") + (d.tzname() or "")


def _plus(disc: str, *hours: float) -> tuple[str, ...]:
    d = parse_utc(disc)
    return tuple(fmt_utc(d + timedelta(hours=h)) for h in hours)


# Pre-registered 2026-10-23 (docs/validation.md section 10.1). Horse Gulch, Greer and Rush: discovery + offsets.
FIRES: tuple[TestFire, ...] = (
    TestFire(1, "2025-emigrant-241e2b", "Emigrant", "OR", "NWCC", "241E2B4C-AB2C-42E6-A901-396E1DBC974B",
             "2025-08-24T19:30Z", "America/Los_Angeles", "LF2024", 10,
             ("2025-08-25T19:30Z", "2025-08-26T19:30Z", "2025-08-28T19:30Z"), "timber"),
    TestFire(2, "2025-lower-sugarloaf-569fb7", "Lower Sugarloaf", "WA", "NWCC", "569FB7BD-BA9B-4706-9D42-F05C7C6AC148",
             "2025-09-01T16:21Z", "America/Los_Angeles", "LF2024", 10,
             ("2025-09-16T16:00Z", "2025-09-17T16:00Z", "2025-09-18T16:00Z"), "timber",
             notes=("no perimeter between 09-17 16:00 and 09-21 17:48 UTC: the run is timed by VIIRS only",)),
    TestFire(3, "2025-island-creek-ff270c", "Island Creek", "ID", "NRCC", "FF270CFC-CADF-4402-B633-49DB89CB1403",
             "2025-08-01T05:36Z", "America/Los_Angeles", "LF2024", 11,
             ("2025-08-19T06:00Z", "2025-08-20T06:00Z", "2025-08-21T06:00Z"), "timber"),
    TestFire(4, "2024-horse-gulch-889237", "Horse Gulch", "MT", "NRCC", "889237AA-38DC-45D4-A8D0-B70D8990F5B7",
             "2024-07-09T19:32Z", "America/Denver", "LF2023", 12,
             _plus("2024-07-09T19:32Z", 6, 12, 24), "timber"),
    TestFire(5, "2025-france-canyon-7d16d1", "France Canyon", "UT", "GBCC", "7D16D16F-4B11-4E71-A81B-FBCED2AE4C65",
             "2025-06-11T22:05Z", "America/Denver", "LF2024", 12,
             ("2025-06-16T22:00Z", "2025-06-18T22:00Z", "2025-06-20T22:00Z"), "timber"),
    TestFire(6, "2025-cottonwood-peak-a3ba9f", "Cottonwood Peak", "NV", "GBCC", "A3BA9F0A-424A-43F3-9DDD-6C37B411CA7C",
             "2025-08-16T02:02Z", "America/Los_Angeles", "LF2024", 11,
             ("2025-08-16T14:00Z", "2025-08-17T02:00Z", "2025-08-18T02:00Z", "2025-08-19T02:00Z"), "shrub and grass"),
    TestFire(7, "2025-trout-4fd248", "Trout", "NM", "SWCC", "4FD24826-A2AB-4A78-A290-76A14185F7B5",
             "2025-06-12T13:24Z", "America/Denver", "LF2024", 12,
             ("2025-06-13T13:30Z", "2025-06-14T13:30Z", "2025-06-15T13:30Z", "2025-06-17T13:30Z"), "grass and timber"),
    TestFire(8, "2025-greer-a746c6", "Greer", "AZ", "SWCC", "A746C681-F72F-4D72-942E-116E3629A264",
             "2025-05-13T17:47:56Z", "America/Phoenix", "LF2024", 12,
             _plus("2025-05-13T17:47:56Z", 6, 12, 24, 72), "grass and timber"),
    TestFire(9, "2024-windy-deuce-b972cf", "Windy Deuce", "TX", "SACC-SP", "B972CFFD-155A-421E-B86B-969AF75E1880",
             "2024-02-27T00:23:16Z", "America/Chicago", "LF2023", 14,
             ("2024-02-27T06:30Z", "2024-02-27T12:30Z", "2024-02-27T18:30Z"), "grass",
             notes=("starts moved to the first perimeter (65 % of the final area): a test of the second day only",)),
    TestFire(10, "2025-table-rock-20616f", "Table Rock", "SC", "SACC-SE", "20616F64-CA32-4E0F-920D-95FEB034CFBA",
             "2025-03-22T13:26Z", "America/New_York", "LF2024", 17,
             ("2025-03-25T13:30Z", "2025-03-26T13:30Z", "2025-03-27T13:30Z"), "hardwood litter and pine"),
    TestFire(11, "2024-rush-641e3e", "Rush", "OK", "SACC-SP", "641E3E69-A4ED-4D7C-B46E-C113EB0C5C48",
             "2024-10-24T20:17Z", "America/Chicago", "LF2024", 14,
             _plus("2024-10-24T20:17Z", 6, 12, 24), "grass",
             notes=("the +6 h and +12 h starts begin before the first perimeter (46 % of the final area)",)),
    TestFire(12, "2025-black-cove-95c3c8", "Black Cove", "NC", "SACC-SE", "95C3C8D3-BA4E-435B-A996-D469B449DEF5",
             "2025-03-19T19:00Z", "America/New_York", "LF2024", 17,
             ("2025-03-20T19:00Z", "2025-03-22T19:00Z", "2025-03-23T19:00Z"), "hardwood litter"),
)

# Reserves (V section 3, in that order per region; none in the Southern Plains). Ids are built only if a fire of the
# same region fails a bundle check before any of its scores exist (the replacement rule, docs/validation.md 10.1).
RESERVES: dict[str, tuple[str, ...]] = {
    "SWCC": ("South Fork, NM 2024: IRWIN E0B77E6D-BE30-4A7B-9875-0E8F1BDFD8D7",),
    "GBCC": ("Monroe Canyon, UT 2025: IRWIN A60CFA6A-C332-4BDD-802B-6E37DC0BBD3E",
             "Forsyth, UT 2025: IRWIN A0E0393C-0265-4AC1-8F6A-10C02C2F5BBA"),
    "NWCC": ("Pioneer, WA 2024: IRWIN 03FE65C0-435C-4116-A78E-AFEFE1ADC9A7",),
    "NRCC": ("Daly, MT 2024: IRWIN BDB7328D-8B59-45E4-93BF-664A9403534C",),
}

# California baseline (docs/validation.md section 5.1): starts as hours after each bundle's ignition.
CALIFORNIA: tuple[tuple[str, tuple[float, ...]], ...] = (
    ("2025-eaton-fire-dbfa57", (6.0, 12.0, 24.0)),
    ("2025-madre-fire-01e7e8", (24.0, 48.0)),
    ("2025-palisades-fire-abfed7", (6.0, 12.0, 24.0)),
)
CALIFORNIA_51 = {"2025-eaton-fire-dbfa57": 0.438, "2025-madre-fire-01e7e8": 0.395, "2025-palisades-fire-abfed7": 0.467,
                 "all": 0.438}


def fire_by_id(fid: str) -> TestFire:
    for f in FIRES:
        if f.id == fid:
            return f
    raise KeyError(fid)


def starts_markdown() -> str:
    """The pre-registered start table: absolute UTC and the fire's local time."""
    lines = ["| # | fire (state, region) | WFIGS discovery (UTC) | label starts (UTC; local) | ignition + 6/12/24 h (UTC) |",
             "|---|---|---|---|---|"]
    for f in FIRES:
        main = "<br>".join(f"{s} ({local_label(s, f.time_zone)})" for s in f.main_starts_utc)
        ign = ", ".join(f.ignition_starts_utc())
        lines.append(f"| {f.n} | {f.name} ({f.state}, {f.region}) | {fmt_utc(f.discovery)} ({local_label(fmt_utc(f.discovery), f.time_zone)}) "
                     f"| {main} | {ign} |")
    return "\n".join(lines)


# ----------------------------------------------------------------------------------------------------------------
# Protocol step 2: bundle checks (docs/validation.md 10.1), recorded per fire before any score
# ----------------------------------------------------------------------------------------------------------------
FAMILY_WORDS = (("GR", 101, 109, ("grass",)), ("GS", 121, 124, ("grass", "shrub")), ("SH", 141, 149, ("shrub",)),
                ("TU", 161, 165, ("timber",)), ("TL", 181, 189, ("timber",)), ("SB", 201, 204, ("timber",)))
FUEL_GROUP_MIN_SHARE = 0.25      # a fuel word counts as tested when >= 25 % of the fire's burnable burned area


def fuel_families(fuel_model, burned) -> dict[str, float]:
    """Share of each FBFM40 family (GR, GS, SH, TU, TL, SB) in the burnable burned cells."""
    import numpy as np

    f = np.asarray(fuel_model)[np.asarray(burned, dtype=bool)]
    out: dict[str, float] = {}
    burnable = [(fam, int(((f >= lo) & (f <= hi)).sum())) for fam, lo, hi, _ in FAMILY_WORDS]
    total = sum(n for _, n in burnable)
    for fam, n in burnable:
        if total and n:
            out[fam] = round(n / total, 3)
    return out


def fuel_groups(families: dict[str, float], min_share: float = FUEL_GROUP_MIN_SHARE) -> list[str]:
    """Plain fuel words (grass, shrub, timber) whose summed FBFM40 family shares reach ``min_share`` of the burnable
    burned area (GR -> grass; GS half grass, half shrub; SH -> shrub; TU, TL, SB -> timber)."""
    share: dict[str, float] = {}
    for fam, _, _, w in FAMILY_WORDS:
        for word in w:
            share[word] = share.get(word, 0.0) + families.get(fam, 0.0) / len(w)
    return sorted(word for word, v in share.items() if v >= min_share - 1e-9)


def bundle_checks(fid: str, fire: TestFire | None = None) -> dict:
    """Protocol step 2 for one built bundle: status, observed/WFIGS area ratio (0.8-1.25), perimeters (all, in the
    growth window), fire inside the AOI, fuels edition and UTM zone as listed, weather source and ERA5 / GFS-fill
    hours (with the fill hours that fall inside a scored window), no observed pixel > 2 km outside the final WFIGS
    perimeter, the GSI series, fuel families of the burned area."""
    import numpy as np
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    from fire3d import bundle as fb
    from fire3d import config
    from fire3d.build import weather_bundle as WB
    from fire3d.cli import weather_hours
    from fire3d.grid import grids_from_manifest

    b = config.INCIDENTS_DIR / fid
    man = fb.load_manifest(b) or {}
    out: dict = {"id": fid, "status": man.get("status"), "problems": []}
    if man.get("status") != "ready":
        out["problems"].append(f"bundle status {man.get('status')!r}")
        return out
    summ = man.get("summary") or {}
    origin = int(man["time_origin_ms"])
    obs = fb.read_layer(b, "observed_arrival", man)
    burned = obs < config.NEVER * 0.999
    final_ac = float((man.get("stats") or {}).get("final_acres_observed") or 0.0)
    wfigs_ac = float(summ.get("acres") or 0.0)
    ratio = final_ac / wfigs_ac if wfigs_ac else None
    out.update(final_acres_observed=final_ac, wfigs_acres=wfigs_ac, area_ratio=None if ratio is None else round(ratio, 3))
    if ratio is None or not (0.8 <= ratio <= 1.25):
        out["problems"].append(f"area ratio {ratio} outside 0.8-1.25")
    # growth window: discovery .. the time the observed area first reaches 95 % of its final area
    t_h = np.sort(obs[burned].ravel())
    t95 = origin + float(t_h[int(0.95 * (len(t_h) - 1))]) * 3600e3 if len(t_h) else None
    perims = (fb.read_json(b / "perimeters.json") or {}).get("perimeters") or []
    times = sorted(int(p["t_ms"]) for p in perims if p.get("t_ms"))
    start = int(summ.get("started_ms") or origin)
    out.update(perimeters=len(perims), perimeters_in_growth=sum(1 for t in times if t95 is not None and start <= t <= t95),
               growth_end_95_utc=None if t95 is None else _iso(t95))
    # inside the AOI: no burned cell within 3 cells of the grid edge
    edge = np.zeros_like(burned)
    edge[:3, :] = edge[-3:, :] = edge[:, :3] = edge[:, -3:] = True
    out["burned_cells_at_aoi_edge"] = int((burned & edge).sum())
    if out["burned_cells_at_aoi_edge"]:
        out["problems"].append("fire reaches the AOI edge")
    # fuels and UTM
    out["fuels_edition"] = man.get("fuels_edition")
    fallback = [w for w in man.get("warnings") or [] if str(w).startswith("LANDFIRE") and " used" in str(w)]
    out["fuels_fallback_notes"] = fallback
    out["utm_zone"] = (man.get("grid") or {}).get("utm_zone")
    if fire is not None:
        if out["fuels_edition"] != fire.fuels_edition or fallback:
            out["problems"].append(f"fuels {out['fuels_edition']} (expected {fire.fuels_edition}) {fallback}")
        if out["utm_zone"] != fire.utm_zone:
            out["problems"].append(f"UTM zone {out['utm_zone']} (expected {fire.utm_zone})")
    # weather
    wh = weather_hours(b) or {}
    out.update(weather_source=wh.get("source"), weather_hours=wh.get("hours"), hrrr_hours=wh.get("hrrr_hours"),
               gfs_fill_hours=wh.get("gfs_fill_hours"), era5_hours=(wh.get("hours") if wh.get("era5") else 0))
    if wh.get("source") != "open-meteo:historical-forecast:gfs_hrrr":
        out["problems"].append(f"weather source {wh.get('source')}")
    if wh.get("era5"):
        out["problems"].append("ERA5 hours present")
    if fire is not None and wh.get("gfs_fill_hours"):
        gw = WB.load_grid_weather(b)
        fill = [int(t) for t, h in zip(gw.t_ms, gw.hrrr) if not h]
        windows = [(to_ms(s0), to_ms(s0) + 72 * 3600_000) for s0 in fire.main_starts_utc + fire.ignition_starts_utc()]
        inside = [t for t in fill if any(a <= t <= z for a, z in windows)]
        out["gfs_fill_hours_in_scored_windows"] = len(inside)
        out["gfs_fill_span_utc"] = [_iso(min(fill)), _iso(max(fill))]
    # observed pixels outside the final WFIGS perimeter (local metres)
    final = max(perims, key=lambda p: (float(p.get("acres") or 0.0), int(p.get("t_ms") or 0))) if perims else None
    if final is not None and burned.any():
        polys = [Polygon(r) for r in final.get("rings") or [] if len(r) >= 3]
        shape = unary_union([p.buffer(0) for p in polys])
        _, fire_grid = grids_from_manifest(man)
        r, c = np.nonzero(burned)
        x, z = fire_grid.pixel_center_local(r, c)
        import shapely

        zone = shape.buffer(2000.0)
        outside = int((~shapely.contains_xy(zone, np.asarray(x, dtype=float), np.asarray(z, dtype=float))).sum())
        out["observed_cells_over_2km_outside_final_perimeter"] = int(outside)
        out["final_perimeter_source"] = final.get("source")
        if outside:
            out["problems"].append(f"{outside} observed cells > 2 km outside the final WFIGS perimeter")
    else:
        out["observed_cells_over_2km_outside_final_perimeter"] = None
        out["problems"].append("no WFIGS perimeter in the bundle")
    # GSI series and the moisture at the starts
    doc = WB.load_lfm_gsi(b)
    out["lfm_gsi"] = None if doc is None else {"source": doc.get("source"), "from": doc.get("from"), "to": doc.get("to"),
                                                "days": len(doc.get("days") or [])}
    if fire is not None:
        lm = []
        for s0 in dict.fromkeys(fire.main_starts_utc + fire.ignition_starts_utc()):     # unique, in order
            d = WB.live_moisture_detail(b, man, to_ms(s0), fetch=False)
            lm.append({"start": s0, "method": d["method"], "gsi": d["gsi"], "herb": round(d["herb"], 3),
                       "woody": round(d["woody"], 3)})
        out["live_fuel_moisture"] = lm
        if summ.get("state") != "CA" and any(x["method"] != "gsi_nfdrs2016" for x in lm):
            out["problems"].append("GSI unavailable at a start")
    # fuel families of the burned area
    st = np.load(b / "sim" / "static.npz")
    fam = fuel_families(st["fuel_model"], burned)
    out["fuel_families"] = fam
    out["fuel_groups"] = fuel_groups(fam)
    out["ok"] = not out["problems"]
    return out


def _iso(ms: float) -> str:
    return datetime.fromtimestamp(float(ms) / 1000.0, tz=UTC).strftime("%Y-%m-%dT%H:%MZ")


# ----------------------------------------------------------------------------------------------------------------
# Protocol steps 4-7: hindcasts (rows written to --out-dir as <id>.<what>.json)
# ----------------------------------------------------------------------------------------------------------------
WHATS = ("main", "main_det", "ignition", "ablation_det", "sens_det")
SENS_ADJUSTMENTS = (0.5, 1.0, 2.0)   # sensitivity only (reported, never adopted unless California improves too)


def run_hindcast(fid: str, what: str, out_dir: Path, workers: int | None = None) -> list[dict]:
    """``main``: 31-member perturbed p50 at the pre-registered label starts; ``main_det``: the deterministic member at
    the same starts; ``ignition``: p50 at WFIGS discovery + 6/12/24 h; ``ablation_det``: the deterministic member at
    the label starts with California's moisture rule forced (config.LFM_FORCE_CALIFORNIA); ``sens_det``: the
    deterministic member at the label starts with start multipliers 0.5, 1 and 2 (a sensitivity check, not a tuning).
    Operational settings, multiplier 0.5. California ids run their docs/validation.md offsets (``main``) instead."""
    from fire3d import bundle as fb
    from fire3d import config
    from fire3d.spread import validate as V
    from fire3d.spread.ensemble import forecast_settings

    b = config.INCIDENTS_DIR / fid
    ca = dict(CALIFORNIA)
    ens = "perturbed" if what in ("main", "ignition") else "none"
    kw = dict(ensemble=ens, members=None, horizon_h=72, workers=workers, settings=forecast_settings())
    if what == "ablation_det":
        config.LFM_FORCE_CALIFORNIA = True
    try:
        adjustments = SENS_ADJUSTMENTS if what == "sens_det" else (0.5,)
        if fid in ca:
            offs = ca[fid] if what in ("main", "main_det", "sens_det") else (6.0, 12.0, 24.0)
            rows = V.batch_hindcast([b], offs, adjustments, **kw)
        else:
            f = fire_by_id(fid)
            starts = f.ignition_starts_utc() if what == "ignition" else f.main_starts_utc
            rows = V.batch_hindcast([b], (), adjustments, start_times_ms=[to_ms(x) for x in starts], **kw)
    finally:
        config.LFM_FORCE_CALIFORNIA = False
    for r in rows:
        if r.get("start_ms"):
            r["start_utc"] = _iso(r["start_ms"])
    out_dir.mkdir(parents=True, exist_ok=True)
    fb.write_json(out_dir / f"{fid}.{what}.json", {"id": fid, "what": what, "rows": rows}, indent=True)
    return rows


# ----------------------------------------------------------------------------------------------------------------
# Collection: fires.json for ``fire3d.spread.validate regional`` and the markdown tables of docs/validation.md 10
# ----------------------------------------------------------------------------------------------------------------
REGION_CAVEATS: dict[str, list[str]] = {
    "NWCC": ["Lower Sugarloaf's run has no perimeter between Sep 17 and Sep 21: its truth is timed by VIIRS only."],
    "SACC-SP": ["Windy Deuce scores only the second day (65 % of its final area burned by the first perimeter).",
                "Rush's first perimeter already held 46 % of the final area; its first leads are timed by VIIRS."],
}
COMMON_CAVEAT = "Two fires: a rough value (about ±0.05)."


def _load_rows(run_dir: Path, fid: str, what: str) -> list[dict] | None:
    p = run_dir / f"{fid}.{what}.json"
    if not p.is_file():
        return None
    return [r for r in json.loads(p.read_text()).get("rows") or [] if r.get("spread_adjustment", 0.5) == 0.5]


def ignition_rows(run_dir: Path, f: TestFire) -> list[dict]:
    """The ignition + 6/12/24 h rows: their own run, else (Horse Gulch, Greer, Rush, whose label starts include
    them) the label rows at those starts."""
    own = _load_rows(run_dir, f.id, "ignition")
    if own is not None:
        return own
    want = {to_ms(x) for x in f.ignition_starts_utc()}
    if not want <= {to_ms(x) for x in f.main_starts_utc}:
        return []
    return [r for r in _load_rows(run_dir, f.id, "main") or [] if r.get("start_ms") in want]


def _mean(rows: list[dict] | None, key: str = "sorensen_growth") -> float | None:
    sc = [float(r[key]) for r in rows or [] if "lead_h" in r and r.get(key) is not None]
    return sum(sc) / len(sc) if sc else None


def collect(run_dir: Path, checks: list[dict], california_meta: dict) -> dict:
    """fires.json for ``validate regional``: every fire with label rows (``main``), ignition rows and its checks."""
    by_check = {c["id"]: c for c in checks}
    fires = []
    for f in FIRES:
        rows = _load_rows(run_dir, f.id, "main")
        c = by_check.get(f.id) or {}
        if rows is None or not c.get("ok"):
            continue
        methods = sorted({x["method"] for x in c.get("live_fuel_moisture") or [] if x["start"] in f.main_starts_utc})
        fires.append({"id": f.id, "name": f.name, "state": f.state, "region": f.region, "year": f.discovery.year,
                      "rows": rows, "ignition_rows": ignition_rows(run_dir, f),
                      "fuels_edition": c.get("fuels_edition"), "lfm_method": "+".join(methods) or None,
                      "era5_hours": c.get("era5_hours") or 0, "gfs_fill_hours": c.get("gfs_fill_hours") or 0,
                      "weather_source": c.get("weather_source"), "replaced": None,
                      "fuel_groups": c.get("fuel_groups") or [], "caveats": []})
    for fid, _ in CALIFORNIA:
        rows = _load_rows(run_dir, fid, "main")
        meta = california_meta.get(fid) or {}
        if rows is None:
            continue
        ign = _load_rows(run_dir, fid, "ignition") or []
        fires.append({"id": fid, "name": meta.get("name") or fid, "state": "CA", "region": "OSCC",
                      "year": int(fid[:4]), "rows": rows, "ignition_rows": ign,
                      "fuels_edition": meta.get("fuels_edition"), "lfm_method": meta.get("lfm_method"),
                      "era5_hours": meta.get("era5_hours", 0), "gfs_fill_hours": meta.get("gfs_fill_hours", 0),
                      "weather_source": meta.get("weather_source"), "replaced": None,
                      "fuel_groups": meta.get("fuel_groups") or [], "caveats": []})
    caveats = {rid: [COMMON_CAVEAT] + REGION_CAVEATS.get(rid, []) for rid in {f["region"] for f in fires} if rid != "OSCC"}
    caveats["OSCC"] = ["The model's settings (multiplier 0.5, 12 h decay, held perimeter) were fitted on these three "
                       "fires: in-sample, a best case."]
    return {"fires": fires, "region_caveats": caveats, "in_sample_regions": ["OSCC"],
            "starts": "pre-registered (docs/validation.md section 10.1), during main growth; California: ignition + "
                      "6/12/24 h (Madre + 24/48 h)",
            "secondary": "WFIGS discovery + 6/12/24 h (California: bundle ignition + 6/12/24 h)"}


def _fmt(v, nd: int = 3) -> str:
    return "–" if v is None else f"{v:.{nd}f}"


def _median(xs: list[float]) -> float | None:
    xs = sorted(xs)
    if not xs:
        return None
    n = len(xs)
    return xs[n // 2] if n % 2 else 0.5 * (xs[n // 2 - 1] + xs[n // 2])


def tables_markdown(run_dir: Path, checks: list[dict]) -> str:
    """docs/validation.md 10.x tables: per fire (label p50, deterministic, ignition-relative, ablation), per lead."""
    by_check = {c["id"]: c for c in checks}
    out = ["| # | fire (state, region; zone) | starts / scored leads | p50 growth Sørensen | deterministic | "
           "ignition + 6/12/24 h (p50) | California table (det.) | total Sørensen (p50) | obs / fc growth, mean ac | "
           "growth ratio (median) | GSI at the starts | herb / woody |",
           "|---|---|---|---:|---:|---:|---:|---:|---|---:|---|---|"]
    for f in FIRES:
        main_rows = _load_rows(run_dir, f.id, "main")
        if main_rows is None:
            out.append(f"| {f.n} | {f.name} ({f.state}, {f.region}; {f.time_zone}) | not run | | | | | | | | | |")
            continue
        sc = [r for r in main_rows if "lead_h" in r]
        det = _mean(_load_rows(run_dir, f.id, "main_det"))
        ign = _mean(ignition_rows(run_dir, f))
        abl = _mean(_load_rows(run_dir, f.id, "ablation_det"))
        tot = _mean(main_rows, "sorensen")
        og = _mean(main_rows, "observed_growth_acres")
        fg = _mean(main_rows, "forecast_growth_acres")
        ratio = _median([float(r["area_ratio"]) for r in sc if r.get("area_ratio") is not None])
        lm = list({x["start"]: x for x in (by_check.get(f.id) or {}).get("live_fuel_moisture") or []
                   if x["start"] in f.main_starts_utc}.values())
        gsi = ", ".join(_fmt(x["gsi"], 2) for x in lm) or "–"
        hw = ", ".join(f"{x['herb']:.0%}/{x['woody']:.0%}" for x in lm) or "–"
        out.append(f"| {f.n} | {f.name} ({f.state}, {f.region}; {f.time_zone}) | {len(f.main_starts_utc)} / {len(sc)} | "
                   f"**{_fmt(_mean(main_rows))}** | {_fmt(det)} | {_fmt(ign)} | {_fmt(abl)} | {_fmt(tot)} | "
                   f"{0 if og is None else og:,.0f} / {0 if fg is None else fg:,.0f} | {_fmt(ratio, 2)} | {gsi} | {hw} |")
    out += ["", "| fire | start (UTC; local) | burned at the start (ac) | lead (h) | observed growth (ac) | "
            "forecast growth p50 (ac) | growth Sørensen | total Sørensen |", "|---|---|---:|---:|---:|---:|---:|---:|"]
    for f in FIRES:
        for r in [r for r in _load_rows(run_dir, f.id, "main") or [] if "lead_h" in r]:
            st = r.get("start_utc") or ""
            at_start = float(r["observed_acres"]) - float(r["observed_growth_acres"])
            out.append(f"| {f.name} | {st} ({local_label(st, f.time_zone) if st else ''}) | {at_start:,.0f} | "
                       f"{r['lead_h']:.0f} | {r['observed_growth_acres']:,.0f} | {r['forecast_growth_acres']:,.0f} | "
                       f"{r['sorensen_growth']:.2f} | {r['sorensen']:.2f} |")
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("starts")
    sub.add_parser("list")
    c = sub.add_parser("checks")
    c.add_argument("ids", nargs="*")
    c.add_argument("--out", help="write the checks as JSON here")
    h = sub.add_parser("hindcast")
    h.add_argument("id")
    h.add_argument("--what", choices=WHATS, default="main")
    h.add_argument("--out-dir", required=True)
    h.add_argument("--workers", type=int, default=None)
    co = sub.add_parser("collect")
    co.add_argument("--runs", required=True, help="directory of hindcast rows (<id>.<what>.json)")
    co.add_argument("--checks", required=True, help="checks JSON of the 12 fires")
    co.add_argument("--out", required=True, help="fires.json for fire3d.spread.validate regional")
    tb = sub.add_parser("tables")
    tb.add_argument("--runs", required=True)
    tb.add_argument("--checks", required=True)
    a = p.parse_args(argv)
    if a.cmd == "tables":
        print(tables_markdown(Path(a.runs), json.loads(Path(a.checks).read_text())))
        return 0
    if a.cmd == "collect":
        from fire3d import bundle as fb
        from fire3d import config
        from fire3d.build import weather_bundle as WB

        checks = json.loads(Path(a.checks).read_text())
        meta = {}
        for fid, offs in CALIFORNIA:
            b = config.INCIDENTS_DIR / fid
            if not (b / "manifest.json").is_file():
                continue
            c = bundle_checks(fid, None)
            man = fb.load_manifest(b)
            t_ign = (man.get("ignition") or {}).get("t_ms") or man["summary"]["started_ms"]
            methods = sorted({WB.live_moisture_detail(b, man, int(t_ign + o * 3600_000), fetch=False)["method"] for o in offs})
            meta[fid] = {"name": man.get("name"), "fuels_edition": c.get("fuels_edition"), "lfm_method": "+".join(methods),
                         "era5_hours": c.get("era5_hours") or 0, "gfs_fill_hours": c.get("gfs_fill_hours") or 0,
                         "weather_source": c.get("weather_source"), "fuel_groups": c.get("fuel_groups") or [],
                         "checks": c}
        spec = collect(Path(a.runs), checks, meta)
        spec["california_checks"] = {k: v["checks"] for k, v in meta.items()}
        Path(a.out).write_text(json.dumps(spec, indent=1), encoding="utf-8")
        print(f"{len(spec['fires'])} fires -> {a.out}")
        return 0
    if a.cmd == "starts":
        print(starts_markdown())
    elif a.cmd == "list":
        print(json.dumps([f.__dict__ for f in FIRES], indent=1, default=str))
    elif a.cmd == "checks":
        ids = a.ids or [f.id for f in FIRES]
        res = []
        for fid in ids:
            try:
                fire = fire_by_id(fid)
            except KeyError:
                fire = None
            r = bundle_checks(fid, fire)
            res.append(r)
            print(f"{fid}: ok={r.get('ok')} ratio={r.get('area_ratio')} perims={r.get('perimeters')}/"
                  f"{r.get('perimeters_in_growth')} fuels={r.get('fuels_edition')} utm={r.get('utm_zone')} "
                  f"weather={r.get('weather_source')} gfs_fill={r.get('gfs_fill_hours')} era5={r.get('era5_hours')} "
                  f"outside2km={r.get('observed_cells_over_2km_outside_final_perimeter')} groups={r.get('fuel_groups')} "
                  f"problems={r.get('problems')}")
        if a.out:
            Path(a.out).write_text(json.dumps(res, indent=1), encoding="utf-8")
    elif a.cmd == "hindcast":
        import logging

        logging.basicConfig(level=logging.WARNING)
        rows = run_hindcast(a.id, a.what, Path(a.out_dir), a.workers)
        sc = [r for r in rows if "lead_h" in r]
        err = [r for r in rows if "error" in r]
        mean = sum(r["sorensen_growth"] for r in sc) / len(sc) if sc else None
        print(f"{a.id} {a.what}: {len(sc)} leads, mean growth Sørensen {mean}, errors {len(err)} {err[:2]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
