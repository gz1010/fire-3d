"""Brief 3 validation outside California: the pre-registered test fires, their starts and the protocol driver.

The fire list, the absolute UTC hindcast starts and the replacement rule are pre-registered in ``docs/validation.md``
(section 10.1, committed before any hindcast outside California); this module holds the same data so the runs use
exactly those starts (never ``ignition.t_ms`` of a built bundle). Sources: ``docs/redesign/audit-3/validation.md``
section 3 (fires, ids, IRWIN ids, starts, fuels editions, UTM zones) and the NIFC WFIGS incident records
(``FireDiscoveryDateTime``, read through ``fire3d.catalog.get_summary`` on 2026-10-23).

Commands (from ``backend/``)::

    uv run python scripts/validate_us_fires.py starts            # the pre-registered start table (markdown)
    uv run python scripts/validate_us_fires.py checks [ids...]   # protocol step 2 bundle checks (JSON)
    uv run python scripts/validate_us_fires.py hindcast <id> --what main|ignition|ablation [--ensemble perturbed]
    uv run python scripts/validate_us_fires.py california         # the California baseline (31-member p50)
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


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("starts")
    sub.add_parser("list")
    a = p.parse_args(argv)
    if a.cmd == "starts":
        print(starts_markdown())
    elif a.cmd == "list":
        print(json.dumps([f.__dict__ for f in FIRES], indent=1, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
