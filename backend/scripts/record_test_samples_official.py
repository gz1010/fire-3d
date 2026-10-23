"""Re-record the offline samples in ``backend/tests/data/official/`` and ``backend/tests/data/terrain/``.

The samples are read by ``tests/test_official_nws.py`` (official) and ``tests/test_terrain_sentinel.py`` (terrain).
Run it from ``backend/``::

    uv run python scripts/record_test_samples_official.py              # fetch, trim, check, write
    uv run python scripts/record_test_samples_official.py --dry-run    # fetch, trim, check, write nothing

About 15 polite requests (one at a time, at least a second apart), made through ``fire3d.http`` with its cache in a
temporary folder (never ``data/``; ``--cache-dir`` keeps it between runs instead):

* api.weather.gov: the two NWS Los Angeles/Oxnard Red Flag Warning messages of Oct 17 2026 09:11 PDT, by their CAP
  ids (2), California's current Red Flag Warnings and Fire Weather Watches (1, the app's own request), and five fire
  weather zones (5).
* Iowa Environmental Mesonet (IEM): ``json/vtec_events_bypoint.py`` at the Eaton Fire (1), ``json/vtec_event.py``
  for LOX FW.W #1, FW.A #1, FW.W #2 and FW.A #2 of 2025 (4), and ``geojson/vtec_event.py`` for FW.W #1 (1).
* Element 84 Earth Search STAC: the Sentinel-2 L2A item S2A_11SLT_20250102_0_L2A (1).

Brief 3 (``--only national``, 3 requests; ``--only existing`` re-records only the files above):

* api.weather.gov: the national ``/alerts/active`` answer for the 48 states + DC with the fire weather and local
  officials' events, exactly as ``nws.national_url()`` asks (1), and the Los Angeles County Civil Emergency Message
  ``v2-3.13.8-1556392-1792113838542`` of 2026-10-16 (a relayed local officials' message, NWEM) by its id (1).
* OpenFEMA ``IpawsArchivedAlerts``: the actual messages sent 2026-10-09 21:00 to 2026-10-10 03:00 UTC (Kern County
  "Cyrus Fire" Fire Warnings, a Sheridan County WY Fire Warning without a polygon, and weather alerts that are out of
  scope), with the app's own ``$select`` (1).

No API key is needed or sent. How each file is trimmed, and which values are set rather than recorded, is written
down in ``tests/data/official/PROVENANCE.md`` and ``tests/data/terrain/PROVENANCE.md``. Every sample is checked
against what the tests need before anything is written; a failed check stops the script and writes nothing.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
OFFICIAL_DIR = BACKEND / "tests" / "data" / "official"
TERRAIN_DIR = BACKEND / "tests" / "data" / "terrain"

# The shared HTTP cache normally lives in data/cache; keep this script's cache out of data/. This must happen before
# fire3d is imported, because fire3d.config reads FIRE3D_CACHE_DIR at import time.
_TMP = tempfile.TemporaryDirectory(prefix="fire3d-record-official-")
os.environ["FIRE3D_CACHE_DIR"] = _TMP.name

import shapely
from shapely.geometry import MultiPolygon, Point, mapping, shape

from fire3d import config
from fire3d import http as fhttp
from fire3d.sources import nws, sentinel
from fire3d.timeutil import iso_to_ms

config.USER_AGENT = "Fire-3d/0.1 test-sample recorder (research prototype; a few requests per run)"
NWS_HEADERS = {"User-Agent": config.USER_AGENT, "Accept": "application/geo+json"}
TTL_S = 7 * 86400.0                        # only matters with --cache-dir (re-runs reuse the answers)
PAUSE_S = 1.2                              # between real requests

# ------------------------------------------------------------------------------------------------------------------
# What is recorded
# ------------------------------------------------------------------------------------------------------------------
# NWS LOX Red Flag Warning FW.W #5, CON, issued Oct 17 2026 09:11 PDT (WWUS86 KLOX 171611): one CAP message per
# segment. NWS lists .002.1 (valleys and coasts, 12 zones from CAZ288) before .001.1 (mountains, 10 zones).
LOX_ALERT_IDS = [
    "urn:oid:2.49.0.1.840.0.471a752cfb304d358eb27b2608f7c2c48c784049.002.1",
    "urn:oid:2.49.0.1.840.0.471a752cfb304d358eb27b2608f7c2c48c784049.001.1",
]
LOX_UPDATED = "2026-10-17T16:20:00+00:00"     # as if /alerts/active had been fetched while both were in effect
# The original empty California answer was recorded on 2026-10-18 with this "updated" value (asserted by
# test_endpoint_live_none_is_not_an_all_clear); today's real empty answer gets it back.
EMPTY_UPDATED = "2026-10-18T16:09:10+00:00"
ZONE_UGCS = ["CAZ243", "CAZ288", "CAZ362", "CAZ369", "CAZ370"]
ZONE_TOL_DEG = 0.0002                       # about 20 m: finer than the app's 100 m display outline
ZONE_DECIMALS = 5

EATON = (-118.069155, 34.203483)
PALISADES = (-118.54453, 34.07022)
HENDERSON = (-117.41451, 33.3445584)
BYPOINT_PARAMS = {"lat": f"{EATON[1]:.4f}", "lon": f"{EATON[0]:.4f}", "sdate": "2025-01-05", "edate": "2025-01-12"}
# IEM text products kept per event (UTC "valid" times); the per-zone rows are kept whole. Kept: the event's first
# product, the statement in force at the Eaton replay time (Jan 8 2025 noon PST), and the products that changed the
# event (extension, cancellation, upgrade, expiry). The routine Jan 6 statements are left out on purpose: the tests
# expect the first product to be the latest one with an Eaton segment by Jan 7 12:00 UTC.
EVENTS = {
    ("W", 1): ["2025-01-05T22:40:00Z", "2025-01-07T22:37:00Z", "2025-01-09T00:01:00Z", "2025-01-10T22:48:00Z"],
    ("A", 1): ["2025-01-03T22:19:00Z", "2025-01-07T22:37:00Z", "2025-01-09T00:01:00Z"],
    ("W", 2): ["2025-01-11T21:16:00Z", "2025-01-16T01:41:00Z"],
    ("A", 2): ["2025-01-10T22:48:00Z", "2025-01-11T21:16:00Z"],
}
GEO_TOL_DEG = 0.001                         # about 100 m, like the app's own display outlines
GEO_DECIMALS = 4

STAC_ITEM_URL = ("https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/"
                 "S2A_11SLT_20250102_0_L2A")


# ------------------------------------------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------------------------------------------
def fetch_json(url: str, params: dict | None = None, headers: dict | None = None) -> object:
    if fhttp.peek_cache("GET", url, params, TTL_S) is None:
        time.sleep(PAUSE_S)
    resp = fhttp.request("GET", url, params=params, headers=headers, ttl_s=TTL_S, timeout=60.0, retries=2)
    print(f"  {'cache' if resp.from_cache else 'GET  '} {fhttp.display_url(url, params)} ({len(resp.content):,} B)")
    return resp.json()


def _round(obj: object, nd: int) -> object:
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, (list, tuple)):
        return [_round(v, nd) for v in obj]
    return obj


def simplify_geometry(geom: dict, tol_deg: float, decimals: int) -> dict:
    """A GeoJSON geometry simplified (topology kept) and snapped to a 10^-decimals degree grid; still valid."""
    g = shape(geom)
    s = shapely.set_precision(g.simplify(tol_deg, preserve_topology=True), 10.0 ** -decimals)
    if s.is_empty or not s.is_valid:
        raise SystemExit(f"simplifying a {geom.get('type')} failed: nothing written")
    if geom.get("type") == "MultiPolygon" and s.geom_type == "Polygon":
        s = MultiPolygon([s])                   # keep the upstream type (IEM sends single-part MultiPolygons)
    m = mapping(s)
    return {"type": m["type"], "coordinates": _round(m["coordinates"], decimals)}


def dump(obj: object) -> str:
    return json.dumps(obj, indent=1, ensure_ascii=True) + "\n"


def dump_features(head: dict, features: list[dict]) -> str:
    """A FeatureCollection with one compact line per feature (geometry-heavy files stay small and diffable)."""
    keys = [k for k in head if k != "features"]
    lines = [f" {json.dumps(k)}: {json.dumps(head[k], ensure_ascii=True)}," for k in keys]
    feats = ",\n".join("  " + json.dumps(f, separators=(",", ":"), ensure_ascii=True) for f in features)
    return "{\n" + "\n".join(lines) + "\n \"features\": [\n" + feats + "\n ]\n}\n"


def dump_zone_map(zones: dict[str, dict]) -> str:
    rows = ",\n".join(f" {json.dumps(k)}: {json.dumps(v, separators=(',', ':'), ensure_ascii=True)}" for k, v in zones.items())
    return "{\n" + rows + "\n}\n"


def need(cond: bool, what: str) -> None:
    if not cond:
        raise SystemExit(f"check failed: {what}; nothing written")


# ------------------------------------------------------------------------------------------------------------------
# NWS (api.weather.gov)
# ------------------------------------------------------------------------------------------------------------------
def build_nws() -> tuple[dict, dict, dict]:
    print("api.weather.gov")
    active_url = f"{nws.NWS_API}/alerts/active?area=CA&event=Red%20Flag%20Warning,Fire%20Weather%20Watch"
    active = fetch_json(active_url, headers=NWS_HEADERS)
    need(isinstance(active, dict) and isinstance(active.get("features"), list), "California answer shape")
    n_live = len(active["features"])
    empty = {k: v for k, v in active.items() if k not in ("pagination",)}
    empty["features"] = []                                  # trimmed to empty if anything is active today
    empty["updated"] = EMPTY_UPDATED
    print(f"  California today: {n_live} active fire weather alert(s) -> recorded as an empty answer")

    feats = []
    for aid in LOX_ALERT_IDS:
        f = fetch_json(f"{nws.NWS_API}/alerts/{aid}", headers=NWS_HEADERS)
        need(isinstance(f, dict) and f.get("type") == "Feature", f"alert {aid} shape")
        feats.append({k: v for k, v in f.items() if k != "@context"})   # collection members carry no @context
    lox = {"@context": active.get("@context"), "type": "FeatureCollection", "features": feats,
           "title": active.get("title") or "Current watches, warnings, and advisories for California",
           "updated": LOX_UPDATED}

    zones: dict[str, dict] = {}
    for ugc in ZONE_UGCS:
        z = fetch_json(f"{nws.NWS_API}/zones/fire/{ugc}", headers=NWS_HEADERS)
        need(isinstance(z, dict) and isinstance(z.get("geometry"), dict), f"zone {ugc} geometry")
        z = {k: v for k, v in z.items() if k != "@context"}
        z["geometry"] = simplify_geometry(z["geometry"], ZONE_TOL_DEG, ZONE_DECIMALS)
        zones[ugc] = z
    return lox, empty, zones


def check_nws(lox: dict, empty: dict, zones: dict) -> None:
    need(empty["features"] == [] and iso_to_ms(empty["updated"]) == iso_to_ms(EMPTY_UPDATED), "empty answer")
    a = [nws.normalize_alert(f) for f in lox["features"]]
    need(all(x is not None for x in a) and len(a) == 2, "two Red Flag Warnings")
    need(a[0]["vtec"] == {"office": "KLOX", "phenomena": "FW", "significance": "W", "etn": 5, "action": "CON"}, "VTEC")
    need(a[0]["ugcs"][0] == "CAZ288" and len(a[0]["ugcs"]) == 12 and a[0]["message_type"] == "Update", "first alert zones")
    need(a[0]["onset_ms"] == iso_to_ms("2026-10-17T09:11:00-07:00") and a[0]["ends_ms"] == iso_to_ms("2026-10-17T20:00:00-07:00"), "times")
    need((a[0]["nws_headline"] or "").startswith("RED FLAG WARNING REMAINS IN EFFECT UNTIL 8 PM PDT"), "NWS headline")
    need([u for u in a[1]["ugcs"] if u in zones] == ["CAZ369", "CAZ370"], "second alert: the Santa Monica Mountains")
    need([u for u in a[0]["ugcs"] if u in zones] == ["CAZ288", "CAZ362"], "first alert: Santa Clarita, Malibu Coast")
    need(zones["CAZ370"]["properties"]["name"] == "Eastern Santa Monica Mountains Recreational Area", "CAZ370 name")
    g = {u: shape(z["geometry"]) for u, z in zones.items()}
    need(all(x.is_valid for x in g.values()), "valid zone polygons")
    need(g["CAZ370"].covers(Point(*PALISADES)) and not g["CAZ362"].covers(Point(*PALISADES)), "Palisades in CAZ370")
    need(0 < nws.distance_km(g["CAZ362"], *PALISADES) < 10, "Malibu Coast within 10 km of Palisades")
    need(g["CAZ243"].covers(Point(*HENDERSON)), "Henderson in CAZ243")
    out = nws.simplified(g["CAZ243"])
    need(shape(out).covers(Point(*HENDERSON)), "Henderson in the simplified CAZ243")
    need(len(json.dumps(out)) < len(json.dumps(zones["CAZ243"]["geometry"])), "recorded outline finer than 100 m")


# ------------------------------------------------------------------------------------------------------------------
# IEM
# ------------------------------------------------------------------------------------------------------------------
def build_iem() -> tuple[dict, dict[tuple[str, int], dict], dict]:
    print("Iowa Environmental Mesonet")
    bypoint = fetch_json(nws.IEM_BYPOINT_URL, BYPOINT_PARAMS)
    need(isinstance(bypoint, dict) and isinstance(bypoint.get("events"), list), "bypoint shape")
    events: dict[tuple[str, int], dict] = {}
    for (sig, etn), keep in EVENTS.items():
        params = {"wfo": "LOX", "year": 2025, "phenomena": "FW", "significance": sig, "etn": etn}
        d = fetch_json(nws.IEM_EVENT_URL, params)
        need(isinstance(d, dict) and d.get("event_exists") is True, f"FW.{sig} #{etn} exists")
        d = copy.deepcopy(d)
        valid = {p.get("valid") for p in [d.get("report")] + list(d.get("svs") or []) if isinstance(p, dict)}
        need(set(keep) <= valid, f"FW.{sig} #{etn} has the products to keep")
        need(d["report"]["valid"] == keep[0], f"FW.{sig} #{etn}: the first kept product is the report")
        d["svs"] = [p for p in d.get("svs") or [] if p.get("valid") in keep[1:]]
        events[(sig, etn)] = d
    params = {"wfo": "LOX", "year": 2025, "phenomena": "FW", "significance": "W", "etn": 1}
    geo = fetch_json(nws.IEM_EVENT_GEOJSON_URL, params)
    need(isinstance(geo, dict) and isinstance(geo.get("features"), list) and geo["features"], "FW.W #1 polygons")
    geo = copy.deepcopy(geo)
    for f in geo["features"]:
        f["geometry"] = simplify_geometry(f["geometry"], GEO_TOL_DEG, GEO_DECIMALS)
    return bypoint, events, geo


def check_iem(bypoint: dict, events: dict, geo: dict) -> None:
    found = nws.bypoint_events(bypoint["events"], at_point=True)
    need({("LOX", 2025, "FW", s, e) for s, e in EVENTS} <= set(found), "bypoint lists FW.W/FW.A #1 and #2")
    need(found[("LOX", 2025, "FW", "W", 1)].point_ugcs == {"CAZ380"}, "Eaton is in CAZ380")
    w1 = nws.parse_event_detail(events[("W", 1)])
    ev = nws.ArchiveEvent("LOX", 2025, "FW", "W", 1, None)
    for at, want in (("2025-01-07T12:00:00Z", "2025-01-05T22:40:00Z"), ("2025-01-08T20:00:00Z", "2025-01-07T22:37:00Z"),
                     ("2025-01-11T00:00:00Z", "2025-01-10T22:48:00Z")):
        prod, _ = nws.segment_at(w1, "CAZ380", ev, iso_to_ms(at))
        need(prod is not None and prod["valid_ms"] == iso_to_ms(want), f"FW.W #1 statement at {at}")
    zones = nws.parse_event_zones(geo)
    need("CAZ380" in zones, "CAZ380 polygon")
    covering = sorted(u for u, g in zones.items() if g.covers(Point(*EATON)))
    need(covering == ["CAZ380"], f"only CAZ380 covers Eaton after simplifying (got {covering})")


# ------------------------------------------------------------------------------------------------------------------
# Earth Search
# ------------------------------------------------------------------------------------------------------------------
def build_stac() -> dict:
    print("Earth Search")
    item = fetch_json(STAC_ITEM_URL)
    need(isinstance(item, dict) and item.get("id") == "S2A_11SLT_20250102_0_L2A", "STAC item id")
    return item


def check_stac(item: dict) -> None:
    from fire3d.grid import make_aoi

    grid = make_aoi(-118.069155, 34.203483, (-118.16, 34.16, -118.03, 34.25), "historical")[1]
    sc = sentinel.parse_scene(item, grid)
    need(sc is not None and sc.tile == "11SLT" and abs(sc.coverage - 1.0) < 1e-3, "scene parses and covers Eaton")
    need(abs(sc.cloud - 3.015763) < 1e-6 and sc.t_ms == iso_to_ms("2025-01-02T18:45:02.738Z"), "cloud cover and time")
    need((sc.assets["nir"].scale, sc.assets["nir"].offset) == (1e-4, -0.1) and sc.boa_offset_applied is True, "assets")


# ------------------------------------------------------------------------------------------------------------------
# ------------------------------------------------------------------------------------------------------------------
# Brief 3: national NWS answer, a relayed local officials' message, an OpenFEMA window
# ------------------------------------------------------------------------------------------------------------------
NWEM_ID = "v2-3.13.8-1556392-1792113838542"        # LA County CEM, 2026-10-16 01:23:59 UTC ("+01:00" stamp kept)
OPENFEMA_WINDOW = ("2026-10-09T21:00:00Z", "2026-10-10T03:00:00Z")
REDACTED_SENDER = "redacted@example.invalid"     # operators' sender addresses are never recorded
OUT_OF_SCOPE_KEPT = ("FFW", "TOR", "LEW")         # one record each, to test the scope filter


def build_national() -> tuple[dict, dict, dict]:
    from fire3d.sources import openfema

    national = fetch_json(nws.national_url(), None, NWS_HEADERS)
    nwem = fetch_json(f"{nws.NWS_API}/alerts/{NWEM_ID}", None, NWS_HEADERS)
    nwem = copy.deepcopy(nwem)
    nwem["properties"]["sender"] = REDACTED_SENDER
    for f in national.get("features", []):
        if isinstance(f.get("properties"), dict) and "sender" in f["properties"]:
            f["properties"]["sender"] = f["properties"]["sender"] if str(f["properties"]["sender"]).startswith("w-nws") else REDACTED_SENDER
    a, b = (iso_to_ms(t) for t in OPENFEMA_WINDOW)
    raw = fetch_json(openfema.API_URL, openfema.window_params(a, b, 0))
    rows = raw.get("IpawsArchivedAlerts") or []
    kept, seen_codes = [], set()
    for r in rows:
        info = (r.get("info") or [{}])[0] if r.get("info") else {}
        codes = [e.get("value") for e in info.get("eventCode") or []]
        in_scope = bool(set(codes) & set(nws.LOCAL_CODES))
        extra = next((c for c in codes if c in OUT_OF_SCOPE_KEPT and c not in seen_codes), None)
        if not (in_scope or extra or (r.get("msgType") == "Cancel" and "Cancel" not in seen_codes)):
            continue
        seen_codes.add(extra or ("Cancel" if r.get("msgType") == "Cancel" else ""))
        r = copy.deepcopy(r)
        if "sender" in r:
            r["sender"] = REDACTED_SENDER
        om = r.get("originalMessage") or ""
        m = re.search(r"<references>.*?</references>", om, re.S)
        r["originalMessage"] = m.group(0) if m else ""
        r["originalMessage"] = re.sub(r"[^,\s<>]+@[^,\s<>]+", REDACTED_SENDER, r["originalMessage"])
        for inf in r.get("info") or []:
            for ar in inf.get("area") or []:
                if isinstance(ar.get("polygon"), dict):
                    ar["polygon"] = simplify_geometry(ar["polygon"], 0.0, 4)
        kept.append(r)
    meta = dict(raw.get("metadata") or {})
    meta["count"] = len(kept)
    meta.pop("rundate", None)
    return national, nwem, {"metadata": meta, "IpawsArchivedAlerts": kept}


def check_national(national: dict, nwem: dict, fema: dict) -> None:
    from fire3d.sources import openfema

    need(isinstance(national.get("features"), list), "national answer is a FeatureCollection")
    need("Alabama" in str(national.get("title")) and "Wyoming" in str(national.get("title")), "49-state title")
    a = nws.normalize_local_nws(nwem)
    need(a is not None and a["event_code"] == "CEM" and a["sender_is_platform"], "NWEM CEM parses, fire keyword, platform")
    need(a is not None and a["same_codes"] == ["006037"] and a["source_url"].startswith("https://api.weather.gov/alerts/"), "NWEM codes and link")
    parsed = openfema.parse_records(fema["IpawsArchivedAlerts"])
    need(any(x["event_code"] == "FRW" and x["_geom"] is not None for x in parsed), "an FRW with a polygon")
    need(any(x["event_code"] == "FRW" and x["_geom"] is None for x in parsed), "an FRW without a polygon")
    need(any(x["references"] for x in parsed), "an update with references")
    need(nwem["properties"].get("sender") == REDACTED_SENDER, "the NWEM operator address is redacted")
    need(all(r.get("sender") in (None, REDACTED_SENDER) for r in fema["IpawsArchivedAlerts"]), "OpenFEMA senders redacted")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="fetch, trim and check; write nothing")
    ap.add_argument("--cache-dir", type=Path, help="keep the HTTP cache here between runs (never under data/)")
    ap.add_argument("--only", choices=("all", "existing", "national"), default="all",
                    help="record everything, only the brief-2 samples, or only the brief-3 national samples")
    args = ap.parse_args()
    if args.cache_dir:
        cache = args.cache_dir.resolve()
        need(not cache.is_relative_to((config.REPO_ROOT / "data").resolve()), "--cache-dir outside data/")
        config.CACHE_DIR = cache

    files: dict[Path, str] = {}
    if args.only in ("all", "existing"):
        lox, empty, zones = build_nws()
        check_nws(lox, empty, zones)
        bypoint, events, geo = build_iem()
        check_iem(bypoint, events, geo)
        item = build_stac()
        check_stac(item)
        files.update({
            OFFICIAL_DIR / "nws_alerts_lox_rfw.json": dump(lox),
            OFFICIAL_DIR / "nws_alerts_ca_empty.json": dump(empty),
            OFFICIAL_DIR / "nws_zones_fire.json": dump_zone_map(zones),
            OFFICIAL_DIR / "iem_bypoint_eaton.json": dump(bypoint),
            **{OFFICIAL_DIR / f"iem_event_lox_fw_{s.lower()}_{e}.json": dump(d) for (s, e), d in events.items()},
            OFFICIAL_DIR / "iem_geojson_lox_fw_w_1.json": dump_features(geo, geo["features"]),
            TERRAIN_DIR / "stac_item_s2_11SLT_20250102.json": dump(item),
        })
    if args.only in ("all", "national"):
        national, nwem, fema = build_national()
        check_national(national, nwem, fema)
        files.update({
            OFFICIAL_DIR / "nws_alerts_national.json": dump(national),
            OFFICIAL_DIR / "nws_nwem_cem_la.json": dump(nwem),
            OFFICIAL_DIR / "openfema_window_frw.json": dump(fema),
        })
    key = config.FIRMS_MAP_KEY
    if key and any(key in body for body in files.values()):
        raise SystemExit("the FIRMS key reached a sample: nothing written")
    for path, body in files.items():
        print(f"{path.relative_to(BACKEND)}: {len(body.encode()):,} bytes")
    if args.dry_run:
        return 0
    for path, body in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    print(f"wrote {len(files)} files")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        _TMP.cleanup()
