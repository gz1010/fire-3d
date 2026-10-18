"""Build ``fire3d/data/gazetteer_ca.json``: California towns, cities and ZIP areas for ``/api/geocode`` (brief 2, C-R5).

    cd backend && uv run python scripts/build_gazetteer.py [--year 2026] [--source DIR] [--out PATH]

Source: the U.S. Census Bureau Gazetteer Files
<https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html>. They are a U.S. Government
work and in the public domain (17 U.S.C. section 105); Fire-3d credits them as "U.S. Census Bureau Gazetteer Files".

* ``<year>_gaz_place_06.txt``: California's incorporated places (cities, towns) and census-designated places (CDPs).
* ``<year>_Gaz_zcta_national.zip``: ZIP Code Tabulation Areas (ZCTAs), kept for California's ZIP prefixes 900-961.

Each row's internal point (INTPTLAT, INTPTLONG) is a point inside the area, not a building, post office or population
centre, so the app labels these positions "town center (approximate)" and "ZIP area (approximate)". ZCTAs approximate
USPS ZIP codes; PO-box-only ZIP codes have no ZCTA. Land area (ALAND) sizes the map view when a result is picked.

The files are downloaded once through ``fire3d.http`` (identifying User-Agent, disk cache), or read from ``--source``
(a directory holding the two files; the ZCTA file may be the .zip or the extracted .txt). The 2026 files are
pipe-delimited, older vintages tab-delimited; columns are read by header name. The output has one entry per line
(readable diffs) and is about 135 KB (about 45 KB gzipped).
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

BASE_URL = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/{year}_Gazetteer/"
PLACE_FILE = "{year}_gaz_place_06.txt"
ZCTA_FILE = "{year}_Gaz_zcta_national.zip"
CREDIT = "U.S. Census Bureau Gazetteer Files"
LICENSE = "Public domain: a U.S. Government work (17 U.S.C. section 105)"
INFO_URL = "https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html"
OUT_DEFAULT = Path(__file__).resolve().parents[1] / "fire3d" / "data" / "gazetteer_ca.json"

# Legal/statistical area description codes in the place file: 25 city, 43 town, 57 census-designated place
LSAD_KIND = {"25": "city", "43": "town", "57": "cdp"}
LSAD_SUFFIX = re.compile(r"\s+(city|town|CDP)$")
CA_ZIP = re.compile(r"^9(?:[0-5]\d|6[01])\d\d$")            # 90000-96199 (962xx-966xx are military APO/FPO)
CA_BBOX = (-124.6, 32.4, -113.9, 42.1)                     # interior points must fall inside California's box


def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:              # older vintages were Latin-1
        return raw.decode("latin-1")


def _rows(text: str) -> list[dict[str, str]]:
    lines = [ln for ln in text.splitlines() if ln.strip()]
    sep = "|" if "|" in lines[0] else "\t"
    head = [h.strip() for h in lines[0].split(sep)]
    return [dict(zip(head, (v.strip() for v in ln.split(sep)), strict=False)) for ln in lines[1:]]


def _fetch(url: str) -> bytes:
    from fire3d import http as fhttp

    return fhttp.request("GET", url, ttl_s=30 * 86_400.0, timeout=60.0, retries=1).content


def _read_source(year: int, source: Path | None) -> tuple[str, str]:
    place_name, zcta_name = PLACE_FILE.format(year=year), ZCTA_FILE.format(year=year)
    if source:
        place_raw = (source / place_name).read_bytes()
        zp = source / zcta_name
        zcta_raw = zp.read_bytes() if zp.exists() else None
        if zcta_raw is None:
            return _decode(place_raw), _decode((source / zcta_name.replace(".zip", ".txt")).read_bytes())
    else:
        base = BASE_URL.format(year=year)
        place_raw = _fetch(base + place_name)
        zcta_raw = _fetch(base + zcta_name)
    with zipfile.ZipFile(io.BytesIO(zcta_raw)) as zf:
        txt = next(n for n in zf.namelist() if n.lower().endswith(".txt"))
        zcta_text = _decode(zf.read(txt))
    return _decode(place_raw), zcta_text


def _in_ca(lat: float, lon: float) -> bool:
    return CA_BBOX[1] <= lat <= CA_BBOX[3] and CA_BBOX[0] <= lon <= CA_BBOX[2]


def _km2(aland_m2: str) -> float | int:
    v = float(aland_m2 or 0) / 1e6
    return round(v, 2) if v < 10 else round(v, 1) if v < 100 else round(v)


def build(place_text: str, zcta_text: str) -> tuple[list[list], list[list]]:
    places: list[list] = []
    for r in _rows(place_text):
        if r.get("USPS") != "CA":
            continue
        lat, lon = float(r["INTPTLAT"]), float(r["INTPTLONG"])
        if not _in_ca(lat, lon):
            raise ValueError(f"place {r['NAME']} has an interior point outside California: {lat}, {lon}")
        name = LSAD_SUFFIX.sub("", r["NAME"]).strip()
        places.append([name, LSAD_KIND.get(r.get("LSAD", ""), "place"), round(lat, 4), round(lon, 4), _km2(r.get("ALAND", "0"))])
    zips: list[list] = []
    for r in _rows(zcta_text):
        z = r["GEOID"]
        if not CA_ZIP.match(z):
            continue
        lat, lon = float(r["INTPTLAT"]), float(r["INTPTLONG"])
        if not _in_ca(lat, lon):
            continue
        zips.append([z, round(lat, 4), round(lon, 4), _km2(r.get("ALAND", "0"))])
    places.sort(key=lambda p: (p[0].casefold(), p[2], p[3]))
    zips.sort(key=lambda z: z[0])
    return places, zips


def write(out: Path, year: int, places: list[list], zips: list[list]) -> None:
    head = {
        "source": CREDIT,
        "vintage": year,
        "files": [PLACE_FILE.format(year=year), ZCTA_FILE.format(year=year)],
        "url": INFO_URL,
        "license": LICENSE,
        "retrieved": time.strftime("%Y-%m-%d"),
        "note": ("Positions are each area's Census internal point (inside the area; approximate). ZCTAs approximate "
                 "USPS ZIP codes; PO-box-only ZIP codes have no ZCTA."),
        "place_fields": ["name", "type", "lat", "lon", "land_km2"],
        "zip_fields": ["zip", "lat", "lon", "land_km2"],
        "counts": {"places": len(places), "zips": len(zips)},
    }
    dump = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":"))  # noqa: E731
    lines = [dump(head)[:-1] + ","]
    lines.append('"places":[')
    lines.append(",\n".join(dump(p) for p in places))
    lines.append('],"zips":[')
    lines.append(",\n".join(dump(z) for z in zips))
    lines.append("]}")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".json.tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    json.loads(tmp.read_text(encoding="utf-8"))          # sanity check before replacing
    tmp.replace(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--year", type=int, default=2026, help="Gazetteer vintage (default 2026, the newest on 2026-10-18)")
    ap.add_argument("--source", type=Path, default=None, help="directory with the downloaded files (skips the download)")
    ap.add_argument("--out", type=Path, default=OUT_DEFAULT)
    a = ap.parse_args(argv)
    place_text, zcta_text = _read_source(a.year, a.source)
    places, zips = build(place_text, zcta_text)
    kinds = {k: sum(1 for p in places if p[1] == k) for k in ("city", "town", "cdp", "place")}
    write(a.out, a.year, places, zips)
    print(f"{a.out}: {len(places)} places ({kinds}), {len(zips)} ZIP areas, {a.out.stat().st_size / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
