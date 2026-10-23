"""Build ``fire3d/data/gazetteer_us.json``: US towns, cities, counties and ZIP areas for ``/api/geocode`` (brief 3,
CONTRACT 14.10; it replaces brief 2's ``gazetteer_ca.json``).

    cd backend && uv run python scripts/build_gazetteer.py [--year 2026] [--source DIR] [--out PATH]

Source: the U.S. Census Bureau Gazetteer Files
<https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html>. They are a U.S. Government
work and in the public domain (17 U.S.C. section 105); Fire-3d credits them as "U.S. Census Bureau Gazetteer Files".

* ``<year>_Gaz_place_national.zip``: every incorporated place (city, town, village, borough, municipality,
  consolidated city-county) and census-designated place of the 50 states, DC and Puerto Rico.
* ``<year>_Gaz_counties_national.zip``: counties and county equivalents.
* ``<year>_Gaz_zcta_national.zip``: ZIP Code Tabulation Areas (ZCTAs). The file has no state column: the state of a
  ZCTA is the lower-48 state its internal point lies in (``fire3d.regions``), else its ZIP prefix (Alaska 995-999,
  Hawaii 967-968, Puerto Rico 006-007 and 009, U.S. Virgin Islands 008, Pacific islands 969).

Each row keeps its state (USPS); places add their county (from ``fire3d.regions``, lower 48 only). Alaska, Hawaii and
territory rows are kept (the API flags them as not supported). Each row's internal point (INTPTLAT, INTPTLONG) is a
point inside the area, not a building, post office or population centre, so the app labels these positions "town
center (approximate)" and "ZIP area (approximate)". ZCTAs approximate USPS ZIP codes; PO-box-only ZIP codes have no
ZCTA. Land area (ALAND) sizes the map view when a result is picked and ranks same-named places.

The files are downloaded once through ``fire3d.http`` (identifying User-Agent, disk cache), or read from ``--source``
(a directory holding the three .zip files). The output has one entry per line (readable diffs).
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
PLACE_FILE = "{year}_Gaz_place_national.zip"
COUNTY_FILE = "{year}_Gaz_counties_national.zip"
ZCTA_FILE = "{year}_Gaz_zcta_national.zip"
CREDIT = "U.S. Census Bureau Gazetteer Files"
LICENSE = "Public domain: a U.S. Government work (17 U.S.C. section 105)"
INFO_URL = "https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html"
OUT_DEFAULT = Path(__file__).resolve().parents[1] / "fire3d" / "data" / "gazetteer_us.json"

# Legal/statistical area description code -> plain place type (the API's ``place_type``)
LSAD_KIND = {"25": "city", "43": "town", "47": "village", "21": "borough", "53": "borough", "37": "municipality",
             "57": "cdp", "55": "comunidad", "62": "zona_urbana", "UG": "government", "CG": "government",
             "MG": "government", "UC": "government", "CN": "city", "00": "city"}
# The trailing LSAD words of a place NAME (longest first): "Boise City city" -> "Boise City"
SUFFIXES = (" metropolitan government (balance)", " consolidated government (balance)", " unified government (balance)",
            " metro government (balance)", " city and borough", " consolidated government", " metropolitan government",
            " unified government", " metro government", " city (balance)", " town (balance)", " urban county",
            " zona urbana", " municipality", " corporation", " comunidad", " (balance)", " borough", " village", " town",
            " city", " CDP")
# Common names of places whose Census name differs ("Boise City" is Idaho's capital, Boise); the API matches them
# exactly. Consolidated city-counties ("Nashville-Davidson", "Louisville/Jefferson County") also match by their first part.
ALIASES = {("Boise City", "ID"): "Boise"}
ZIP_PREFIX_STATE = (("995", "999", "AK"), ("967", "968", "HI"), ("006", "007", "PR"), ("009", "009", "PR"),
                    ("008", "008", "VI"), ("969", "969", "GU"))


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

    return fhttp.request("GET", url, ttl_s=30 * 86_400.0, timeout=120.0, retries=1).content


def _unzip(raw: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        txt = next(n for n in zf.namelist() if n.lower().endswith(".txt"))
        return _decode(zf.read(txt))


def _read_source(year: int, source: Path | None) -> tuple[str, str, str]:
    names = [f.format(year=year) for f in (PLACE_FILE, COUNTY_FILE, ZCTA_FILE)]
    raws = [(source / n).read_bytes() if source else _fetch(BASE_URL.format(year=year) + n) for n in names]
    return tuple(_unzip(r) for r in raws)  # type: ignore[return-value]


def _km2(aland_m2: str) -> float | int:
    v = float(aland_m2 or 0) / 1e6
    return round(v, 2) if v < 10 else round(v, 1) if v < 100 else round(v)


def place_name(raw: str) -> str:
    """The place NAME without its LSAD words ("Indianapolis city (balance)" -> "Indianapolis")."""
    for suf in SUFFIXES:
        if raw.endswith(suf) and len(raw) > len(suf):
            return raw[: -len(suf)].strip()
    return raw.strip()


def zip_state(zip5: str, lat: float, lon: float) -> str | None:
    from fire3d import regions

    st = regions.state_at(lon, lat)
    if st:
        return st
    for lo, hi, s in ZIP_PREFIX_STATE:
        if lo <= zip5[:3] <= hi:
            return s
    return None


def build(place_text: str, county_text: str, zcta_text: str) -> tuple[list[list], list[list]]:
    from fire3d import regions

    places: list[list] = []
    for r in _rows(place_text):
        lat, lon = float(r["INTPTLAT"]), float(r["INTPTLONG"])
        st = r["USPS"]
        c = regions.county_at(lon, lat) if st in regions.L48 else None
        county = c.name if c is not None and c.state == st else None
        name = place_name(r["NAME"])
        kind = LSAD_KIND.get(r.get("LSAD", ""), "place")
        alias = ALIASES.get((name, st))
        if alias is None and re.search(r"government|urban county", r["NAME"]) and re.search(r"[-/]", name):
            alias = re.split(r"[-/]", name)[0].strip()
        places.append([name, kind, st, round(lat, 4), round(lon, 4), _km2(r.get("ALAND", "0")), county, alias])
    for r in _rows(county_text):
        lat, lon = float(r["INTPTLAT"]), float(r["INTPTLONG"])
        places.append([r["NAME"].strip(), "county", r["USPS"], round(lat, 4), round(lon, 4), _km2(r.get("ALAND", "0")), None, None])
    zips: list[list] = []
    for r in _rows(zcta_text):
        z = r["GEOID"]
        lat, lon = float(r["INTPTLAT"]), float(r["INTPTLONG"])
        st = zip_state(z, lat, lon)
        if st is None:
            continue
        zips.append([z, st, round(lat, 4), round(lon, 4), _km2(r.get("ALAND", "0"))])
    places.sort(key=lambda p: (p[0].casefold(), p[2], p[3], p[4]))
    zips.sort(key=lambda z: z[0])
    return places, zips


def write(out: Path, year: int, places: list[list], zips: list[list]) -> None:
    head = {
        "source": CREDIT,
        "vintage": year,
        "files": [f.format(year=year) for f in (PLACE_FILE, COUNTY_FILE, ZCTA_FILE)],
        "url": INFO_URL,
        "license": LICENSE,
        "retrieved": time.strftime("%Y-%m-%d"),
        "note": ("Positions are each area's Census internal point (inside the area; approximate). ZCTAs approximate "
                 "USPS ZIP codes; PO-box-only ZIP codes have no ZCTA. Alaska, Hawaii and territory rows are kept "
                 "(Fire-3d does not support them yet)."),
        "place_fields": ["name", "type", "state", "lat", "lon", "land_km2", "county", "alias"],
        "zip_fields": ["zip", "state", "lat", "lon", "land_km2"],
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
    ap.add_argument("--year", type=int, default=2026, help="Gazetteer vintage (default 2026, the newest on 2026-10-23)")
    ap.add_argument("--source", type=Path, default=None, help="directory with the downloaded .zip files (skips the download)")
    ap.add_argument("--out", type=Path, default=OUT_DEFAULT)
    a = ap.parse_args(argv)
    place_text, county_text, zcta_text = _read_source(a.year, a.source)
    places, zips = build(place_text, county_text, zcta_text)
    kinds: dict[str, int] = {}
    for p in places:
        kinds[p[1]] = kinds.get(p[1], 0) + 1
    write(a.out, a.year, places, zips)
    print(f"{a.out}: {len(places)} places ({kinds}), {len(zips)} ZIP areas, {a.out.stat().st_size / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
