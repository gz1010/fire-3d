"""Optional map sources for the map-first UI: official evacuation zones, public cameras and recent satellite imagery
(docs/redesign/BRIEF.md section 11; endpoints and shapes in docs/redesign/CONTRACT.md "Optional sources").

Owned by the redesign optional-sources agent; app.py mounts ``router``.

Sources (free, no key, official or officially sanctioned; terms checked 2026-10-17):

* Evacuations: Cal OES "California Evacuation Aggregation Layer" (county services + Genasys Protect, rebuilt about
  every 5 min; data.ca.gov: "No restrictions on public use") and Cal OES "County Evacuation Inventory" (which counties
  feed it). Current status only: a past time gets ``not_available_for_past_dates``, never today's zones. Status
  wording is passed through verbatim.
* Cameras: Cal OES "California Webcams" (camera locations and image links): ALERTCalifornia (UC San Diego, CC BY-NC-ND
  4.0, credit "ALERTCalifornia | UC San Diego", non-commercial) and Caltrans CCTV (CWWP2 feeds, public domain; status
  and update interval from the district feeds). Frames are fetched only when a user asks for one; they live in
  memory for minutes (never on disk) and carry the image's own Last-Modified time.
* Recent imagery: Sentinel-2 L2A scenes (Element 84 Earth Search STAC; true-colour COGs rendered here into Web
  Mercator WebP, disk cache ``CACHE_DIR/extras/sentinel2``), Landsat 8/9 (NASA HLS L30: CMR metadata + GIBS tiles),
  VIIRS daily images (NASA CMR pass times + GIBS tiles) and GOES-West 10-minute GeoColor (GIBS).

Every JSON response carries ``status`` ("available" | "unavailable" | "not_available_for_past_dates"), a
``reason``, ``retrieved_ms`` (when Fire-3d fetched it from the source), ``source_updated_ms`` (the source's own update
time) and source / attribution metadata. Upstream calls go through ``fire3d.http`` (timeouts, retries with backoff,
disk cache with TTLs matched to each source's update cadence) behind a short in-memory cache and per-source request
limits; the proxy's own limit answers 429. Route functions are plain ``def`` (FastAPI runs them in its threadpool).
"""
from __future__ import annotations

import hashlib
import io
import logging
import math
import os
import re
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import quote

import httpx
import numpy as np
import orjson
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from .. import bundle, config, regions
from .. import http as fhttp
from ..sources import evacuations as evac
from ..timeutil import DAY_MS, HOUR_MS, MAX_QUERY_MS, now_ms

log = logging.getLogger(__name__)

router = APIRouter(tags=["extras"])

# ----------------------------------------------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------------------------------------------
PAST_TOLERANCE_MS = 6 * HOUR_MS       # a requested time older than now - this is "past" (= timeline STALE_AFTER_MS)
MAX_BBOX_SPAN_DEG = 2.0               # list endpoints
MAX_RENDER_SPAN_DEG = 0.8             # Sentinel-2 renders
DEFAULT_MARGIN_KM = 15.0              # incident area = AOI bbox + this margin
UPSTREAM_TIMEOUT_S = 20.0
UPSTREAM_RETRIES = 1                  # interactive endpoints: one retry with backoff (fire3d.http)

ARCGIS_ROOT = evac.CALOES_ROOT
EVAC_LAYER_URL = evac.CALOES_LAYER_URL
EVAC_INVENTORY_URL = evac.CALOES_INVENTORY_URL
WEBCAMS_LAYER_URL = f"{ARCGIS_ROOT}/CalOES_California_Webcams/FeatureServer/0"
CWWP2_DISTRICT_URL = "https://cwwp2.dot.ca.gov/data/d{d}/cctv/cctvStatusD{d:02d}.json"
ALERTCA_FRAME_URL = "https://cameras.alertcalifornia.org/public-camera-data/{slug}/latest-frame.jpg"
ALERTCA_VIEWER_URL = "https://cameras.alertcalifornia.org/?id={slug}"
CALTRANS_FRAME_URL = "https://cwwp2.dot.ca.gov/data/d{d}/cctv/image/{name}/{name}.jpg"
EARTH_SEARCH_URL = "https://earth-search.aws.element84.com/v1"
S2_COLLECTION = "sentinel-2-l2a"
S2_ASSET_HOST = "sentinel-cogs.s3.us-west-2.amazonaws.com"
CMR_GRANULES_URL = "https://cmr.earthdata.nasa.gov/search/granules.json"
GIBS_ROOT = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"

EVAC_TTL_S = evac.EVAC_TTL_S          # Cal OES rebuilds every ~5 min; Oregon OEM recalculates every 15 min
INVENTORY_TTL_S = 24 * 3600.0
CAMERAS_TTL_S = 120.0                 # fire-camera directions update every minute
CWWP2_TTL_S = 6 * 3600.0              # district status files change "as necessary"
FRAME_TTL_ALERTCA_S = 15.0            # ALERTCalifornia serves max-age=10
FRAME_TTL_CALTRANS_S = 60.0           # Caltrans images refresh every 5-15 min
FRAME_KEEP_S = 600.0                  # served frame bytes stay addressable this long
FRAME_MAX_BYTES = 6 << 20
FRAME_STORE_MAX = 48
SCENES_TTL_RECENT_S = 1800.0          # catalogue searches whose window touches the last 2 days
SCENES_TTL_PAST_S = 30 * 86400.0
GIBS_DOMAIN_TTL_S = 1800.0
GOES_DOMAIN_TTL_RECENT_S = 300.0
IMAGERY_WINDOW_DAYS = 30
VIIRS_WINDOW_DAYS = 3
VIIRS_IMAGERY_DELAY_MS = 3 * HOUR_MS  # GIBS daily VIIRS images appear roughly 3 h after a pass
GOES_WINDOW_MS = 3 * HOUR_MS
MAX_S2_PASSES = 6
MAX_LANDSAT_DATES = 4
MIN_COVERAGE = 0.2                    # scenes covering less of the requested area are left out
RENDER_MAX_PX = 2048
RENDER_CACHE_MAX_BYTES = 300 << 20
RENDER_CACHE_TRIM_BYTES = 240 << 20
RENDER_VERSION = "1"

GIBS_ACK = ("We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), "
            "part of NASA's Earth Science Data and Information System (ESDIS).")
CALOES_DISCLAIMER = evac.CALOES_DISCLAIMER

SOURCES: dict[str, dict[str, Any]] = {
    **evac.SOURCES,          # caloes_evacuations, caloes_evacuation_inventory, or_oem_evacuations
    "caloes_webcams": {
        "id": "caloes_webcams",
        "name": "CalOES California Webcams",
        "publisher": "Cal OES",
        "url": "https://www.arcgis.com/home/item.html?id=5b4040338d704693994d5682ab2747c5",
        "service_url": WEBCAMS_LAYER_URL,
        "license": "Public use; ALERTCalifornia data CC BY-NC-ND 4.0 (non-commercial, no derivatives)",
        "terms_url": "https://www.arcgis.com/home/item.html?id=5b4040338d704693994d5682ab2747c5",
        "attribution": "Camera locations: Cal OES California Webcams",
        "disclaimer": "Cal OES provides such information \"as is\"; the user assumes the entire risk related to its use.",
        "cadence": "Fire-camera directions every minute; traffic-camera status nightly",
    },
    "alertcalifornia": {
        "id": "alertcalifornia",
        "name": "ALERTCalifornia camera network",
        "publisher": "UC San Diego ALERTCalifornia",
        "url": "https://cameras.alertcalifornia.org/",
        "license": "CC BY-NC-ND 4.0: non-commercial use, no derivatives; commercial use needs a licence from UC San Diego OIC",
        "terms_url": "https://alertcalifornia.org/terms/",
        "attribution": "ALERTCalifornia | UC San Diego",
        "disclaimer": "Images are shown unmodified (information bar and partner logos kept).",
        "cadence": "Frames update about every minute",
    },
    "caltrans_cctv": {
        "id": "caltrans_cctv",
        "name": "Caltrans CCTV (CWWP2)",
        "publisher": "California Department of Transportation (Caltrans)",
        "url": "https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm",
        "license": "Public domain (Caltrans conditions of use); no charge for the data",
        "terms_url": "https://dot.ca.gov/conditions-of-use",
        "attribution": "Caltrans",
        "disclaimer": "Caltrans traffic camera images are neither retained nor archived.",
        "cadence": "Each camera states its own update interval (5-15 min)",
    },
    "earth_search_s2": {
        "id": "earth_search_s2",
        "name": "Sentinel-2 L2A (Element 84 Earth Search)",
        "publisher": "ESA Copernicus; catalogue by Element 84; COGs on AWS Open Data",
        "url": f"{EARTH_SEARCH_URL}/collections/{S2_COLLECTION}",
        "license": "Copernicus Sentinel data terms: free use, including modification",
        "terms_url": "https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice",
        "attribution": "Contains modified Copernicus Sentinel data {year} (Earth Search by Element 84)",
        "disclaimer": None,
        "cadence": "New scenes every 2-5 days; usually listed 4-6 h after acquisition",
    },
    "nasa_hls": {
        "id": "nasa_hls",
        "name": "Harmonized Landsat Sentinel-2 (HLS L30) via NASA GIBS",
        "publisher": "NASA LP DAAC (HLS), NASA GIBS (imagery tiles), NASA CMR (metadata)",
        "url": "https://www.earthdata.nasa.gov/data/projects/hls",
        "license": "NASA open data (CC0 unless marked; no restrictions on use; cite NASA)",
        "terms_url": "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance",
        "attribution": "Landsat 8/9 HLS: NASA LP DAAC / USGS; imagery by NASA GIBS",
        "disclaimer": GIBS_ACK,
        "cadence": "Landsat 8/9 every 8 days combined; listed 1-3 days after acquisition",
    },
    "nasa_viirs": {
        "id": "nasa_viirs",
        "name": "VIIRS Corrected Reflectance (NOAA-20, NOAA-21) via NASA GIBS",
        "publisher": "NASA LANCE / GIBS; pass times from NASA CMR",
        "url": "https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api",
        "license": "NASA open data (CC0 unless marked; no restrictions on use; cite NASA)",
        "terms_url": "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance",
        "attribution": "VIIRS imagery: NASA GIBS / LANCE",
        "disclaimer": GIBS_ACK,
        "cadence": "Daily daytime passes; images about 3 h after a pass",
    },
    "nasa_goes": {
        "id": "nasa_goes",
        "name": "GOES-West ABI GeoColor via NASA GIBS",
        "publisher": "NOAA GOES-West; imagery by NASA GIBS",
        "url": "https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api",
        "license": "Public domain (NOAA) / NASA open data",
        "terms_url": "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance",
        "attribution": "GOES-West imagery: NOAA, via NASA GIBS",
        "disclaimer": GIBS_ACK,
        "cadence": "Every 10 minutes; usually 30-60 min behind",
    },
}

# ----------------------------------------------------------------------------------------------------------------
# Errors, caches, limits
# ----------------------------------------------------------------------------------------------------------------


class SourceError(RuntimeError):
    """An upstream source failed (message is user-facing and secret-free)."""


class SourceBusy(SourceError):
    """Fire-3d's own request limit for this source is reached."""


class _TtlCache:
    """Thread-safe in-memory TTL + LRU cache."""

    def __init__(self, maxsize: int = 256):
        self.maxsize = maxsize
        self._d: OrderedDict[Any, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: Any) -> Any | None:
        with self._lock:
            hit = self._d.get(key)
            if hit is None:
                return None
            exp, val = hit
            if exp < time.monotonic():
                del self._d[key]
                return None
            self._d.move_to_end(key)
            return val

    def set(self, key: Any, val: Any, ttl_s: float) -> None:
        with self._lock:
            self._d[key] = (time.monotonic() + ttl_s, val)
            self._d.move_to_end(key)
            while len(self._d) > self.maxsize:
                self._d.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._d.clear()


@dataclass
class _Upstream:
    """One upstream service and Fire-3d's own request limit for it."""

    name: str
    limiter: fhttp.RateLimiter


UP_ARCGIS = _Upstream("Cal OES ArcGIS services", evac.ARCGIS_LIMITER)    # services.arcgis.com (Cal OES, Oregon OEM)
UP_CWWP2 = _Upstream("Caltrans CWWP2", fhttp.RateLimiter(20, 60.0, "extras: Caltrans CWWP2"))
UP_FRAMES = _Upstream("camera image servers", fhttp.RateLimiter(30, 60.0, "extras: camera frames"))
UP_EARTH_SEARCH = _Upstream("Element 84 Earth Search", fhttp.RateLimiter(30, 60.0, "extras: Earth Search"))
UP_CMR = _Upstream("NASA CMR", fhttp.RateLimiter(60, 60.0, "extras: NASA CMR"))
UP_GIBS = _Upstream("NASA GIBS", fhttp.RateLimiter(30, 60.0, "extras: NASA GIBS"))
UP_RENDER = _Upstream("Sentinel-2 rendering", fhttp.RateLimiter(8, 60.0, "extras: Sentinel-2 renders"))

_mem = _TtlCache(512)
_frames_latest = _TtlCache(256)               # camera id -> frame metadata dict (short TTL)
_frame_store: OrderedDict[str, tuple[float, bytes, str]] = OrderedDict()   # token -> (stored monotonic, bytes, ctype)
_frame_lock = threading.Lock()
_last_evac_counts: dict[tuple[str, str], int] = {}
_render_slots = threading.Semaphore(1)
_render_key_locks: dict[str, threading.Lock] = {}
_render_key_guard = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="extras")


def reset_state() -> None:
    """Drop every in-memory cache (tests)."""
    _mem.clear()
    _frames_latest.clear()
    with _frame_lock:
        _frame_store.clear()
    _last_evac_counts.clear()


def _fetch(up: _Upstream, method: str, url: str, *, params: Any = None, body: Any = None, ttl_s: float,
           timeout: float = UPSTREAM_TIMEOUT_S, retries: int = UPSTREAM_RETRIES, parse: str = "json") -> tuple[Any, int]:
    """(payload, fetched_ms) via the in-memory cache, the source's request limit and fire3d.http (disk cache, retries).
    ``parse``: "json" or "text". Raises SourceBusy / SourceError."""
    key = (method, url, orjson.dumps(params, option=orjson.OPT_SORT_KEYS) if params is not None else b"",
           orjson.dumps(body, option=orjson.OPT_SORT_KEYS) if body is not None else b"", parse)
    if ttl_s > 0:
        hit = _mem.get(key)
        if hit is not None:
            return hit
    if not up.limiter.try_acquire():
        raise SourceBusy(f"{up.name}: Fire-3d's request limit is reached; try again in a minute")
    try:
        resp = fhttp.request(method, url, params=params, json_body=body, ttl_s=ttl_s, timeout=timeout, retries=retries)
        payload = resp.json() if parse == "json" else resp.text
    except fhttp.HttpError as e:
        code = f"HTTP {e.status}" if e.status is not None else "no response"
        raise SourceError(f"{up.name} could not be reached ({code})") from None
    except (orjson.JSONDecodeError, ValueError):
        raise SourceError(f"{up.name} sent a reply Fire-3d could not read") from None
    out = (payload, resp.fetched_ms)
    if ttl_s > 0:
        _mem.set(key, out, ttl_s)
    return out


# ----------------------------------------------------------------------------------------------------------------
# Area, time and incident context
# ----------------------------------------------------------------------------------------------------------------
BBox = tuple[float, float, float, float]


def parse_bbox(text: str | None, max_span: float = MAX_BBOX_SPAN_DEG) -> BBox:
    """"w,s,e,n" in WGS84 degrees -> rounded tuple; ValueError with a user-facing message."""
    if not text:
        raise ValueError("bbox is required (w,s,e,n in degrees)")
    parts = text.split(",")
    if len(parts) != 4:
        raise ValueError("bbox must be four numbers: w,s,e,n")
    try:
        w, s, e, n = (float(p) for p in parts)
    except ValueError:
        raise ValueError("bbox must be four numbers: w,s,e,n") from None
    if not all(math.isfinite(v) for v in (w, s, e, n)):
        raise ValueError("bbox values must be finite")
    if not (-180 <= w < e <= 180 and -85 <= s < n <= 85):
        raise ValueError("bbox must satisfy -180 <= w < e <= 180 and -85 <= s < n <= 85")
    if e - w > max_span or n - s > max_span:
        raise ValueError(f"bbox spans more than {max_span} degrees")
    return (round(w, 4), round(s, 4), round(e, 4), round(n, 4))


def bbox_key(b: BBox) -> str:
    return ",".join(f"{v:.4f}" for v in b)


def expand_bbox(b: BBox, km: float) -> BBox:
    lat = math.radians((b[1] + b[3]) / 2)
    dlat = km / 111.32
    dlon = km / (111.32 * max(0.2, math.cos(lat)))
    return (round(max(-180.0, b[0] - dlon), 4), round(max(-85.0, b[1] - dlat), 4),
            round(min(180.0, b[2] + dlon), 4), round(min(85.0, b[3] + dlat), 4))


@dataclass
class AreaContext:
    bbox: BBox
    at_ms: int | None          # requested time (None = now)
    now_ms: int
    incident_id: str | None
    incident_mode: str | None  # "live" | "historical" | None

    @property
    def is_past(self) -> bool:
        """True for a historical incident or a requested time older than now - PAST_TOLERANCE_MS."""
        if self.incident_mode == "historical":
            return True
        return self.at_ms is not None and self.at_ms < self.now_ms - PAST_TOLERANCE_MS

    @property
    def reference_ms(self) -> int:
        """The time imagery is listed for: the requested time, never later than now."""
        return min(self.at_ms, self.now_ms) if self.at_ms is not None else self.now_ms


def _incident_info(incident_id: str) -> tuple[BBox | None, str | None]:
    """(AOI bbox or a box around the reported point, mode) for an incident id; HTTP 400/404 on bad / unknown ids."""
    try:
        bdir = bundle.bundle_dir(incident_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid incident id") from None
    m = None
    try:
        m = bundle.load_manifest(bdir) if bdir.is_dir() else None
    except (OSError, ValueError):
        m = None
    if isinstance(m, dict):
        grid = m.get("grid") or {}
        bb = grid.get("bbox_lonlat")
        summary = m.get("summary") or {}
        mode = m.get("mode") or summary.get("mode")
        if isinstance(bb, (list, tuple)) and len(bb) == 4:
            return (float(bb[0]), float(bb[1]), float(bb[2]), float(bb[3])), mode
        if "lat" in summary and "lon" in summary:
            lat, lon = float(summary["lat"]), float(summary["lon"])
            return expand_bbox((lon, lat, lon, lat), 10.0), mode
    from .. import catalog

    try:
        s = catalog.get_summary(incident_id)
    except catalog.ListsUnavailable:
        raise HTTPException(status_code=503, detail=catalog.LISTS_UNAVAILABLE_TEXT) from None
    except Exception as e:  # noqa: BLE001 - an unexpected lookup failure: treat as unknown here
        log.warning("extras: catalog lookup for %s failed: %s", incident_id, config.mask_secrets(e))
        s = None
    if s is None:
        raise HTTPException(status_code=404, detail=f"unknown incident {incident_id!r}")
    return expand_bbox((s.lon, s.lat, s.lon, s.lat), 10.0), s.mode


def area_context(bbox: str | None, incident: str | None, at_ms: int | None, margin_km: float,
                 max_span: float = MAX_BBOX_SPAN_DEG) -> AreaContext:
    mode = None
    area: BBox | None = None
    if incident:
        aoi, mode = _incident_info(incident)
        if aoi is not None and not bbox:
            area = expand_bbox(aoi, margin_km)
    try:
        if bbox:
            area = parse_bbox(bbox, max_span)
        elif area is None:
            raise ValueError("bbox or incident is required")
        else:
            area = parse_bbox(bbox_key(area), max_span)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    return AreaContext(area, at_ms, now_ms(), incident, mode)


def _envelope(b: BBox) -> dict[str, str]:
    return {"geometry": f"{b[0]},{b[1]},{b[2]},{b[3]}", "geometryType": "esriGeometryEnvelope", "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects"}


def _base(kind: str, ctx: AreaContext, source_ids: Iterable[str]) -> dict[str, Any]:
    return {
        "kind": kind,
        "status": "available",
        "reason": None,
        "reason_code": None,
        "retrieved_ms": None,
        "source_updated_ms": None,
        "requested_at_ms": ctx.at_ms,
        "now_ms": ctx.now_ms,
        "bbox": list(ctx.bbox),
        "incident_id": ctx.incident_id,
        "sources": [SOURCES[s] for s in source_ids],
        "caveats": [],
    }


def _json(obj: Any, status: int = 200, cache: str = "no-store") -> Response:
    return Response(orjson.dumps(obj, option=orjson.OPT_SERIALIZE_NUMPY), status_code=status, media_type="application/json",
                    headers={"Cache-Control": cache})


def _clean(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _int_ms(v: Any) -> int | None:
    try:
        x = int(v)
    except (TypeError, ValueError):
        return None
    return x if x > 0 else None


def _arcgis_check(data: Any, what: str) -> dict:
    """ArcGIS answers errors with HTTP 200 and {"error": ...}."""
    if not isinstance(data, dict):
        raise SourceError(f"{what} sent an unexpected reply")
    if "error" in data:
        err = data.get("error") or {}
        raise SourceError(f"{what} returned an error ({err.get('code', 'unknown')})")
    return data


def _arcgis_features(url: str, params: dict[str, Any], *, ttl_s: float, what: str, max_pages: int = 5,
                     up: _Upstream | None = None) -> tuple[list[dict], int]:
    """All GeoJSON features of an ArcGIS query (paged by resultOffset), plus the oldest fetch time."""
    feats: list[dict] = []
    fetched = None
    offset = 0
    for _ in range(max_pages):
        p = {**params, "f": "geojson", "resultOffset": offset, "orderByFields": "OBJECTID"}
        data, ms = _fetch(up or UP_ARCGIS, "GET", f"{url}/query", params=p, ttl_s=ttl_s)
        data = _arcgis_check(data, what)
        fetched = ms if fetched is None else min(fetched, ms)
        page = data.get("features") or []
        feats.extend(page)
        more = data.get("exceededTransferLimit") or (data.get("properties") or {}).get("exceededTransferLimit")
        if not more or not page:
            break
        offset += len(page)
    return feats, int(fetched or now_ms())


def _layer_updated_ms(url: str, what: str, ttl_s: float, up: _Upstream | None = None) -> int | None:
    try:
        info, _ = _fetch(up or UP_ARCGIS, "GET", url, params={"f": "json"}, ttl_s=ttl_s)
        ei = _arcgis_check(info, what).get("editingInfo") or {}
    except SourceError as e:
        log.info("extras: %s", e)
        return None
    return _int_ms(ei.get("dataLastEditDate") or ei.get("lastEditDate"))


# ----------------------------------------------------------------------------------------------------------------
# Evacuations (CONTRACT §14.8: the state registry, adapters and mappings live in fire3d.sources.evacuations)
# ----------------------------------------------------------------------------------------------------------------
STATUS_RANK = evac.STATUS_RANK
evac_status_key = evac.evac_status_key
normalize_zone = evac.normalize_caloes          # brief-2 name of the Cal OES mapping


def _title(s: str | None) -> str | None:
    if not s:
        return None
    return " ".join(w[:1].upper() + w[1:].lower() for w in s.split())


def normalize_inventory(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        a = r.get("properties") or r.get("attributes") or {}
        name = _clean(a.get("CountyName"))
        if not name:
            continue
        in_use = str(a.get("DataInUse") or "").strip().lower() == "yes"
        src = _clean(a.get("Source"))
        out.append({
            "county": name,
            "in_statewide_layer": in_use,
            "acquisition_status": _clean(a.get("DataAcqStatus")),
            "zone_source": "Genasys Protect (Zonehaven)" if src and src.lower() == "zonehaven" else ("County GIS" if src else None),
            "reference_url": _clean(a.get("Reference_App")) if str(a.get("Reference_App") or "").startswith("https://") else None,
        })
    return sorted(out, key=lambda c: c["county"])


def _adapter_upstream(ad: evac.EvacAdapter) -> _Upstream:
    """The adapter's host limit (``UP_ARCGIS.limiter``, shared by every services.arcgis.com layer) under its own name."""
    return _Upstream(ad.upstream_name, UP_ARCGIS.limiter)


def _evac_zone_features(b: BBox, ad: evac.EvacAdapter | None = None) -> tuple[list[dict], int]:
    """Raw zone features of one adapter's layer for a bbox, cached here for its TTL (the upstream query bypasses the
    disk cache). Only the adapter's whitelisted fields are requested (EV-R4)."""
    ad = ad or evac.ADAPTERS["caloes_evacuations"]
    key = bbox_key(b)
    hit = _mem.get(("evac", ad.id, key))
    if hit is not None:
        return hit
    params = {**_envelope(b), "where": ad.where, "outFields": ",".join(ad.out_fields), "outSR": "4326",
              "geometryPrecision": "6", "returnGeometry": "true"}
    up = _adapter_upstream(ad)
    feats, fetched = _arcgis_features(ad.query_url, params, ttl_s=0, what=ad.layer_what, up=up)
    prev = _last_evac_counts.get((ad.id, key))
    if ad.confirm_drop and prev is not None and len(feats) < prev:
        # The layer is rebuilt every ~5 min and briefly shows only part of the zones: confirm a drop once.
        time.sleep(2.0)
        feats, fetched = _arcgis_features(ad.query_url, params, ttl_s=0, what=ad.layer_what, up=up)
    _last_evac_counts[(ad.id, key)] = len(feats)
    _mem.set(("evac", ad.id, key), (feats, fetched), ad.ttl_s)
    return feats, fetched


def _source_entry(sid: str, home_state: str, **fields: Any) -> dict[str, Any]:
    """A ``sources[]`` entry with the §14.8.2 per-source fields (a copy: SOURCES stays unchanged), plus
    ``aggregator``, the short name the web uses in sentences ("Cal OES", "Oregon OEM")."""
    ad = evac.ADAPTERS.get(sid)
    return {**SOURCES[sid], "retrieved_ms": None, "updated_ms": None, "status": "available", "reason": None,
            "home_state": home_state, "credit": evac.CREDITS.get(sid, SOURCES[sid].get("publisher")),
            "aggregator": ad.aggregator if ad else "Cal OES", **fields}


def _caloes_inventory(ctx: AreaContext, caveats: list[str]) -> tuple[list[dict], str | None]:
    """Cal OES county coverage for the bbox: (coverage rows, not-covered reason or None)."""
    coverage: list[dict] = []
    try:
        rows, _ = _arcgis_features(EVAC_INVENTORY_URL, {**_envelope(ctx.bbox), "where": "1=1", "returnGeometry": "false",
                                                        "outFields": "CountyName,Source,Reference_App,DataInUse,DataAcqStatus"},
                                   ttl_s=INVENTORY_TTL_S, what="Cal OES county inventory")
        coverage = normalize_inventory(rows)
    except SourceBusy:
        raise
    except SourceError as e:
        caveats.append(f"County coverage could not be checked: {e}.")
    covered = [c for c in coverage if c["in_statewide_layer"]]
    missing = [c["county"] for c in coverage if not c["in_statewide_layer"]]
    if coverage and not covered:
        return coverage, (f"The statewide layer has no evacuation zones from {', '.join(missing)} County. "
                          "Check the county's official channels.")
    if missing:
        caveats.append(f"Not in the statewide layer: {', '.join(missing)} County. Zones there are not shown.")
    return coverage, None


def evacuations_payload(ctx: AreaContext) -> dict[str, Any]:
    """Official evacuation zones for the area from every state source it touches (CONTRACT §14.8.3).

    A California-only area answers exactly as in brief 2, plus the §14.8.2 keys. An area in no state with a source
    answers ``state_not_available`` without any upstream request."""
    states = regions.states_in_bbox(ctx.bbox)
    avail = [st for st in states if evac.STATE_AVAILABILITY[st]["availability"] == "available"]
    uncovered = [st for st in states if st not in avail]
    adapters = [evac.ADAPTERS[a] for st in avail for a in evac.STATE_AVAILABILITY[st]["adapter_ids"]]
    source_ids: list[str] = []
    for ad in adapters:
        source_ids.append(ad.id)
        if ad.id == "caloes_evacuations":
            source_ids.append("caloes_evacuation_inventory")
    out = _base("evacuations", ctx, ())
    out["sources"] = [_source_entry(sid, "CA" if sid.startswith("caloes") else "OR") for sid in source_ids]
    issuing = [ad.issuing_authority for ad in adapters]
    out.update({"issuing_authority": " ".join(issuing) if issuing else
                "Local emergency officials. Fire-3d has no official evacuation zone source for this area.",
                "zones": {"type": "FeatureCollection", "features": []}, "counts": {}, "coverage": [],
                "states": evac.states_entries(states, {})})
    if not adapters:
        if states:
            reason = evac.not_available_reason(uncovered)
        else:
            reason = evac.outside_reason((ctx.bbox[0] + ctx.bbox[2]) / 2, (ctx.bbox[1] + ctx.bbox[3]) / 2)
        out.update(status="unavailable", reason_code="state_not_available", reason=reason)
        return out
    if ctx.is_past:
        out.update(status="not_available_for_past_dates", reason_code="past_date",
                   reason="Official evacuation status is published as current status only. Past orders and warnings are "
                          "not available from this source, so none are shown for the selected time.")
        for sid in out["sources"]:
            sid["status"] = "unavailable"
            sid["reason"] = "Current status only: not available for past dates."
        return out
    src_by_id = {s["id"]: s for s in out["sources"]}
    per_source: list[tuple[evac.EvacAdapter, list[dict]]] = []
    answered: set[str] = set()
    failures: list[tuple[evac.EvacAdapter, str, str]] = []     # (adapter, reason_code, reason)
    zone_caveats: list[str] = []
    for ad in adapters:
        entry = src_by_id[ad.id]
        if ad.id == "caloes_evacuations":
            coverage, not_covered = _caloes_inventory(ctx, out["caveats"])
            out["coverage"] = coverage
            inv = src_by_id.get("caloes_evacuation_inventory")
            if inv is not None and any(c.startswith("County coverage could not be checked") for c in out["caveats"]):
                inv.update(status="unavailable", reason="County coverage could not be checked.")
            if not_covered:
                entry.update(status="unavailable", reason=not_covered)
                failures.append((ad, "not_covered", not_covered))
                continue
        try:
            feats, fetched = _evac_zone_features(ctx.bbox, ad)
        except SourceBusy:
            raise
        except SourceError as e:
            reason = f"{e}. No evacuation zones are shown."
            entry.update(status="unavailable", reason=reason)
            failures.append((ad, "upstream_error", reason))
            continue
        zones = [z for z in (ad.normalize(f) for f in feats) if z is not None]
        updated = _layer_updated_ms(ad.query_url, ad.layer_what, ad.ttl_s, up=_adapter_upstream(ad))
        entry.update(retrieved_ms=fetched, updated_ms=updated)
        answered.add(ad.id)
        per_source.append((ad, zones))
        zone_caveats.extend(ad.standing_caveats)
        if not zones:
            # several states in the area: say whose "none" it is (a California-only answer keeps brief 2's sentence)
            zone_caveats.append(ad.none_caveat_named if len(adapters) > 1 or uncovered else ad.none_caveat)
    checked = {ad.home_state: ad.id in answered for ad in adapters}
    out["states"] = evac.states_entries(states, checked)
    if not answered:
        # every source in the area failed: never "none"
        if len(failures) == 1:
            _, code, reason = failures[0]
        else:
            code, reason = "upstream_error", " ".join(r for _, _, r in failures)
        out.update(status="unavailable", reason_code=code, reason=reason)
        return out
    for ad, _code, reason in failures:
        out["caveats"].append(f"{evac.state_name(ad.home_state)}: {ad.aggregator} could not be checked ({reason})")
    zones = evac.dedup_border_zones(per_source, answered)
    zones.sort(key=lambda z: (STATUS_RANK.get(z["properties"]["status_key"], 9), z["properties"]["zone_id"]))
    counts: dict[str, int] = {}
    for z in zones:
        k = z["properties"]["status_key"]
        counts[k] = counts.get(k, 0) + 1
    out["zones"]["features"] = zones
    out["counts"] = counts
    answered_entries = [src_by_id[a] for a in src_by_id if a in answered]
    if len(answered_entries) == 1:
        out["retrieved_ms"] = answered_entries[0]["retrieved_ms"]
        out["source_updated_ms"] = answered_entries[0]["updated_ms"]
    out["caveats"].extend(zone_caveats)
    out["caveats"].extend(evac.uncovered_state_caveat(st) for st in uncovered)
    return out


@router.get("/api/extras/evacuations")
def get_evacuations(bbox: str | None = None, incident: str | None = None, at_ms: int | None = Query(None, ge=0, le=MAX_QUERY_MS),
                    margin_km: float = Query(DEFAULT_MARGIN_KM, ge=0, le=60)) -> Response:
    """Official evacuation zones (current status only) intersecting ``bbox`` or the incident's area."""
    ctx = area_context(bbox, incident, at_ms, margin_km)
    try:
        return _json(evacuations_payload(ctx))
    except SourceBusy as e:
        raise HTTPException(status_code=429, detail=str(e)) from None


# ----------------------------------------------------------------------------------------------------------------
# Cameras
# ----------------------------------------------------------------------------------------------------------------
_ALERTCA_THUMB = re.compile(r"^https://cameras\.alertcalifornia\.org/public-camera-data/([A-Za-z0-9][A-Za-z0-9_-]{0,63})/latest-frame\.jpg$")
_CALTRANS_IMG = re.compile(r"^https?://cwwp2\.dot\.ca\.gov/data/d(\d{1,2})/cctv/image/([a-z0-9][a-z0-9_-]{0,95})/\2\.jpg$")
_CAMERA_ID = re.compile(r"^(?:alertca:([A-Za-z0-9][A-Za-z0-9_-]{0,63})|caltrans:d(\d{1,2}):([a-z0-9][a-z0-9_-]{0,95}))$")


def camera_frame_url(camera_id: str) -> tuple[str, str]:
    """(official image URL, source id) for a camera id; ValueError for anything else (no open proxy)."""
    m = _CAMERA_ID.match(camera_id or "")
    if not m:
        raise ValueError("unknown camera id")
    if m.group(1):
        return ALERTCA_FRAME_URL.format(slug=m.group(1)), "alertcalifornia"
    d = int(m.group(2))
    if not 1 <= d <= 12:
        raise ValueError("unknown camera id")
    return CALTRANS_FRAME_URL.format(d=d, name=m.group(3)), "caltrans_cctv"


def _azimuth(v: Any) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return round(x % 360.0, 1) if math.isfinite(x) else None


def normalize_camera(f: dict) -> dict | None:
    """One Cal OES webcam -> a camera feature with a namespaced id, or None (unsupported source / unparseable)."""
    p = f.get("properties") or {}
    geom = f.get("geometry") or {}
    coords = geom.get("coordinates") if geom.get("type") == "Point" else None
    if not coords or len(coords) < 2:
        try:
            coords = [float(p["Longitude"]), float(p["Latitude"])]
        except (KeyError, TypeError, ValueError):
            return None
    src = str(p.get("Source") or "").strip().lower()
    name = _clean(p.get("Location")) or "Camera"
    thumb = str(p.get("Thumbnail_Url") or "").strip()
    webcam = str(p.get("Webcam_URL") or "").strip()
    if src == "alert california":
        m = _ALERTCA_THUMB.match(thumb)
        if not m:
            return None
        slug = m.group(1)
        props = {
            "id": f"alertca:{slug}", "name": name, "source_id": "alertcalifornia", "source_label": "ALERTCalifornia",
            "kind": "wildfire", "view": _clean(p.get("View_Direction")), "azimuth_deg": _azimuth(p.get("View_Degrees")),
            "viewer_url": ALERTCA_VIEWER_URL.format(slug=slug), "credit": SOURCES["alertcalifornia"]["attribution"],
            "license": SOURCES["alertcalifornia"]["license"], "district": None,
        }
    elif src == "caltrans":
        m = _CALTRANS_IMG.match(webcam) or _CALTRANS_IMG.match(thumb)
        if not m:
            return None
        d, cam = int(m.group(1)), m.group(2)
        props = {
            "id": f"caltrans:d{d}:{cam}", "name": name, "source_id": "caltrans_cctv", "source_label": "Caltrans",
            "kind": "traffic", "view": _clean(p.get("View_Direction")), "azimuth_deg": None, "viewer_url": None,
            "credit": "Caltrans", "license": SOURCES["caltrans_cctv"]["license"], "district": d,
            "_image_url": CALTRANS_FRAME_URL.format(d=d, name=cam),
        }
    else:
        return None
    props.update({
        "county": _title(_clean(p.get("County"))), "nearby_place": _clean(p.get("NearBy_Place")),
        "elevation_ft": p.get("Elevation_Ft") if isinstance(p.get("Elevation_Ft"), (int, float)) else None,
        "in_service": None, "update_minutes": None, "status_record_ms": None, "streaming_video": False,
        "frame_endpoint": f"/api/extras/cameras/latest?id={quote(props['id'], safe='')}",
    })
    return {"type": "Feature", "id": props["id"], "geometry": {"type": "Point", "coordinates": [round(float(coords[0]), 6), round(float(coords[1]), 6)]},
            "properties": props}


def _caltrans_index(d: int) -> dict[str, dict]:
    """currentImageURL -> {in_service, update_minutes, record_ms, streaming} for one Caltrans district."""
    key = ("cwwp2-index", d)
    hit = _mem.get(key)
    if hit is not None:
        return hit
    data, _ = _fetch(UP_CWWP2, "GET", CWWP2_DISTRICT_URL.format(d=d), ttl_s=CWWP2_TTL_S, timeout=30.0)
    idx: dict[str, dict] = {}
    for row in (data or {}).get("data") or []:
        c = (row or {}).get("cctv") or {}
        img = ((c.get("imageData") or {}).get("static") or {}).get("currentImageURL")
        if not img:
            continue
        rec = c.get("recordTimestamp") or {}
        try:
            freq = int(str(((c.get("imageData") or {}).get("static") or {}).get("currentImageUpdateFrequency") or "").strip())
        except ValueError:
            freq = None
        epoch = _int_ms(rec.get("recordEpoch"))
        idx[str(img).replace("http://", "https://")] = {
            "in_service": str(c.get("inService", "")).strip().lower() == "true",
            "update_minutes": freq,
            "record_ms": epoch * 1000 if epoch else None,
            "streaming": bool(str((c.get("imageData") or {}).get("streamingVideoURL") or "").strip()),
        }
    _mem.set(key, idx, CWWP2_TTL_S)
    return idx


CAMERAS_NOT_AVAILABLE = "Public cameras: California only (ALERTCalifornia, Caltrans). Not available in this state."


def cameras_payload(ctx: AreaContext) -> dict[str, Any]:
    out = _base("cameras", ctx, ("caloes_webcams", "alertcalifornia", "caltrans_cctv"))
    out.update({"cameras": {"type": "FeatureCollection", "features": []}, "counts": {}, "excluded": {}})
    if "CA" not in regions.states_in_bbox(ctx.bbox):
        # CONTRACT §14.8.6 / §14.14: the camera sources are California's; no upstream request elsewhere, and no
        # California source listed for an answer that used none (as evacuations do; the sentence names the networks)
        out.update(status="unavailable", reason_code="state_not_available", reason=CAMERAS_NOT_AVAILABLE, sources=[])
        return out
    if ctx.is_past:
        out.update(status="not_available_for_past_dates", reason_code="past_date",
                   reason="Public cameras show live images only. Past frames are not archived publicly, so cameras are "
                          "not shown for the selected time.")
        return out
    params = {**_envelope(ctx.bbox), "where": "1=1", "outSR": "4326", "returnGeometry": "true",
              "outFields": "Location,Source,Display_Type,View_Direction,Webcam_URL,Thumbnail_Url,NearBy_Place,County,"
                           "Elevation_Ft,CameraType,View_Degrees,Longitude,Latitude"}
    try:
        feats, fetched = _arcgis_features(WEBCAMS_LAYER_URL, params, ttl_s=CAMERAS_TTL_S, what="Cal OES webcam layer")
    except SourceBusy:
        raise
    except SourceError as e:
        out.update(status="unavailable", reason_code="upstream_error", reason=f"{e}. No cameras are shown.")
        return out
    cams: list[dict] = []
    excluded: dict[str, int] = {}
    for f in feats:
        c = normalize_camera(f)
        if c is None:
            src = str((f.get("properties") or {}).get("Source") or "unknown").strip() or "unknown"
            excluded[src] = excluded.get(src, 0) + 1
            continue
        cams.append(c)
    districts = sorted({c["properties"]["district"] for c in cams if c["properties"]["district"]})
    for d in districts:
        try:
            idx = _caltrans_index(d)
        except SourceError as e:
            out["caveats"].append(f"Caltrans district {d} status could not be loaded ({e}); in-service status unknown.")
            continue
        for c in cams:
            p = c["properties"]
            if p["district"] != d:
                continue
            info = idx.get(p.get("_image_url", ""))
            if info:
                p.update(in_service=info["in_service"], update_minutes=info["update_minutes"],
                         status_record_ms=info["record_ms"], streaming_video=info["streaming"])
    for c in cams:
        c["properties"].pop("_image_url", None)
    cams.sort(key=lambda c: (c["properties"]["kind"] != "wildfire", c["properties"]["name"]))
    counts: dict[str, int] = {}
    for c in cams:
        counts[c["properties"]["kind"]] = counts.get(c["properties"]["kind"], 0) + 1
    out["cameras"]["features"] = cams
    out["counts"] = counts
    out["excluded"] = excluded
    out["retrieved_ms"] = fetched
    out["source_updated_ms"] = _layer_updated_ms(WEBCAMS_LAYER_URL, "Cal OES webcam layer", CAMERAS_TTL_S)
    if excluded:
        out["caveats"].append("Cameras from networks whose terms Fire-3d has not verified are not shown "
                              f"({', '.join(f'{k}: {v}' for k, v in sorted(excluded.items()))}).")
    out["caveats"].append("Camera images are live views, opened only on request; each shows when the camera server last "
                          "updated it (the capture time is printed on the image).")
    return out


@router.get("/api/extras/cameras")
def get_cameras(bbox: str | None = None, incident: str | None = None, at_ms: int | None = Query(None, ge=0, le=MAX_QUERY_MS),
                margin_km: float = Query(25.0, ge=0, le=60)) -> Response:
    """Public wildfire (ALERTCalifornia) and traffic (Caltrans) cameras in the area (live context only)."""
    ctx = area_context(bbox, incident, at_ms, margin_km)
    try:
        return _json(cameras_payload(ctx))
    except SourceBusy as e:
        raise HTTPException(status_code=429, detail=str(e)) from None


def _http_date_ms(v: str | None) -> int | None:
    if not v:
        return None
    try:
        dt = parsedate_to_datetime(v)
    except (TypeError, ValueError, IndexError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _get_frame(url: str, timeout: float = 15.0, retries: int = 1) -> tuple[bytes, str, int | None]:
    """(bytes, content type, Last-Modified ms) through fire3d.http's client (shared UA, concurrency cap and the
    offline test transport). Frames are not written to the disk cache."""
    attempt = 0
    while True:
        status: int | None = None
        try:
            with fhttp._semaphore:  # noqa: SLF001 - same package; shares the global concurrency cap
                r = fhttp._client().get(url, timeout=httpx.Timeout(timeout, connect=min(10.0, timeout)))  # noqa: SLF001
            status = r.status_code
            if 200 <= status < 300:
                return r.content, r.headers.get("content-type", ""), _http_date_ms(r.headers.get("last-modified"))
            if status != 429 and status < 500:
                raise SourceError(f"camera image server answered HTTP {status}")
            err = f"HTTP {status}"
        except SourceError:
            raise
        except httpx.HTTPError as e:
            err = type(e).__name__
        if attempt >= retries:
            raise SourceError(f"camera image could not be loaded ({err})")
        time.sleep(min(4.0, fhttp.BACKOFF_BASE_S * (2 ** attempt)))
        attempt += 1


def _store_frame(content: bytes, ctype: str) -> str:
    token = hashlib.sha256(content).hexdigest()[:32]
    with _frame_lock:
        now = time.monotonic()
        for k in [k for k, (t, _, _) in _frame_store.items() if now - t > FRAME_KEEP_S]:
            del _frame_store[k]
        _frame_store[token] = (now, content, ctype)
        _frame_store.move_to_end(token)
        while len(_frame_store) > FRAME_STORE_MAX:
            _frame_store.popitem(last=False)
    return token


def camera_latest(camera_id: str) -> dict[str, Any]:
    try:
        url, src = camera_frame_url(camera_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="unknown camera id") from None
    hit = _frames_latest.get(camera_id)
    if hit is not None:
        return hit
    if not UP_FRAMES.limiter.try_acquire():
        raise HTTPException(status_code=429, detail="Fire-3d's camera image limit is reached; try again in a minute")
    meta = SOURCES[src]
    out: dict[str, Any] = {"camera_id": camera_id, "source": meta, "credit": meta["attribution"], "license": meta["license"],
                           "viewer_url": ALERTCA_VIEWER_URL.format(slug=camera_id.split(":", 1)[1]) if src == "alertcalifornia" else None}
    try:
        content, ctype, lm = _get_frame(url)
    except SourceError as e:
        out.update(status="unavailable", reason=str(e), image_url=None, image_time_ms=None, retrieved_ms=now_ms())
        _frames_latest.set(camera_id, out, 10.0)
        return out
    kind = "image/jpeg" if content[:3] == b"\xff\xd8\xff" else ("image/png" if content[:8] == b"\x89PNG\r\n\x1a\n" else None)
    if kind is None or len(content) > FRAME_MAX_BYTES:
        out.update(status="unavailable", reason="the camera server did not return an image", image_url=None,
                   image_time_ms=None, retrieved_ms=now_ms())
        _frames_latest.set(camera_id, out, 10.0)
        return out
    width = height = None
    try:
        from PIL import Image

        with Image.open(io.BytesIO(content)) as im:
            width, height = im.size
    except Exception:  # dimensions are optional
        pass
    token = _store_frame(content, kind)
    retrieved = now_ms()
    out.update(status="available", reason=None, image_url=f"/api/extras/cameras/frames/{token}.{'jpg' if kind == 'image/jpeg' else 'png'}",
               image_time_ms=lm, image_time_basis="Last-Modified time reported by the camera image server",
               retrieved_ms=retrieved, age_ms=(retrieved - lm) if lm else None, width=width, height=height, bytes=len(content))
    if lm is None:
        out["reason"] = "the camera server did not report when this image was taken"
    _frames_latest.set(camera_id, out, FRAME_TTL_ALERTCA_S if src == "alertcalifornia" else FRAME_TTL_CALTRANS_S)
    return out


@router.get("/api/extras/cameras/latest")
def get_camera_latest(id: str) -> Response:  # noqa: A002 - query name
    """Fetch one camera's latest image now (explicit user action) -> JSON with a frame URL and the image time."""
    return _json(camera_latest(id))


@router.get("/api/extras/cameras/frames/{name}")
def get_camera_frame(name: str) -> Response:
    """Bytes of a frame fetched by /cameras/latest (content-addressed, kept in memory for ~10 min)."""
    m = re.match(r"^([0-9a-f]{32})\.(jpg|png)$", name)
    if not m:
        raise HTTPException(status_code=404, detail="not found")
    with _frame_lock:
        hit = _frame_store.get(m.group(1))
    if hit is None:
        raise HTTPException(status_code=404, detail="frame expired; request the camera's latest image again")
    return Response(hit[1], media_type=hit[2], headers={"Cache-Control": "private, max-age=600, immutable"})


# ----------------------------------------------------------------------------------------------------------------
# Recent imagery: shared helpers
# ----------------------------------------------------------------------------------------------------------------


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso_to_ms(s: Any) -> int | None:
    if not s:
        return None
    try:
        t = str(s).strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(t)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _day(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def _bbox_poly(b: BBox):
    from shapely.geometry import box

    return box(b[0], b[1], b[2], b[3])


def coverage_fraction(footprints: list[Any], b: BBox) -> float:
    """Share of the bbox covered by the union of footprints (shapely geometries in lon/lat)."""
    from shapely.ops import unary_union

    target = _bbox_poly(b)
    geoms = [g for g in footprints if g is not None and not g.is_empty]
    if not geoms or target.area <= 0:
        return 0.0
    try:
        u = unary_union([g.buffer(0) for g in geoms])
        return float(max(0.0, min(1.0, u.intersection(target).area / target.area)))
    except Exception:  # invalid geometry from a catalogue
        return 0.0


def weighted_cloud(items: list[tuple[Any, float | None]], b: BBox) -> float | None:
    """Area-weighted (over the bbox) mean of per-scene cloud cover percentages."""
    target = _bbox_poly(b)
    num = den = 0.0
    for geom, cc in items:
        if cc is None or geom is None:
            continue
        try:
            a = geom.buffer(0).intersection(target).area
        except Exception:
            continue
        num += a * cc
        den += a
    return round(num / den, 1) if den > 0 else None


def _window(ctx: AreaContext, days: int) -> tuple[int, int, bool]:
    """(start_ms, end_ms, recent): the search window ending at the reference time, quantised for cache hits."""
    ref = ctx.reference_ms
    recent = ctx.now_ms - ref < 2 * DAY_MS
    end = (ref // (30 * 60_000) + 1) * 30 * 60_000 if recent else (ref // DAY_MS + 1) * DAY_MS
    return end - days * DAY_MS, end, recent


def gibs_tiles(layer: str, time_value: str, matrix_set: str, ext: str) -> str:
    return f"{GIBS_ROOT}/{layer}/default/{time_value}/{matrix_set}/{{z}}/{{y}}/{{x}}.{ext}"


def parse_gibs_domain(xml: str) -> list[tuple[int, int, int]]:
    """GIBS DescribeDomains / Dimension values -> [(start_ms, end_ms, period_ms)] (period 0 = single)."""
    m = re.search(r"<Domain>(.*?)</Domain>", xml or "", re.S)
    if not m:
        return []
    out = []
    for part in m.group(1).split(","):
        bits = part.strip().split("/")
        if len(bits) != 3:
            continue
        a, b = _iso_to_ms(bits[0] if "T" in bits[0] else bits[0] + "T00:00:00Z"), _iso_to_ms(bits[1] if "T" in bits[1] else bits[1] + "T00:00:00Z")
        per = _iso_period_ms(bits[2])
        if a is not None and b is not None:
            out.append((a, b, per))
    return out


def _iso_period_ms(p: str) -> int:
    m = re.match(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$", p.strip())
    if not m:
        return 0
    d, h, mi = (int(x) if x else 0 for x in m.groups())
    return ((d * 24 + h) * 60 + mi) * 60_000


def gibs_has(domain: list[tuple[int, int, int]], t_ms: int) -> bool:
    for a, b, per in domain:
        if a <= t_ms <= b and (per <= 0 or (t_ms - a) % per == 0):
            return True
    return False


def gibs_latest_at_or_before(domain: list[tuple[int, int, int]], t_ms: int) -> int | None:
    best = None
    for a, b, per in domain:
        if a > t_ms:
            continue
        hi = min(b, t_ms)
        cand = hi if per <= 0 else a + ((hi - a) // per) * per
        if best is None or cand > best:
            best = cand
    return best


def _gibs_domain(layer: str, matrix_set: str, start_ms: int | None = None, end_ms: int | None = None,
                 ttl_s: float = GIBS_DOMAIN_TTL_S) -> tuple[list[tuple[int, int, int]], int]:
    """(time domain, fetched_ms) of a GIBS layer from DescribeDomains (whole archive or a time window)."""
    span = "all" if start_ms is None else f"{_iso(start_ms)}--{_iso(end_ms or start_ms)}"
    url = f"{GIBS_ROOT}/1.0.0/{layer}/default/{matrix_set}/all/{span}.xml"
    text, fetched = _fetch(UP_GIBS, "GET", url, ttl_s=ttl_s, parse="text")
    return parse_gibs_domain(text), fetched


def _product(**kw: Any) -> dict[str, Any]:
    base = {"id": None, "family": None, "label": None, "composite": None, "platform": None, "sensor": None,
            "acquired_ms": None, "acquired_end_ms": None, "pass_times_ms": [], "published_ms": None, "latency_ms": None,
            "latency_note": None, "resolution_m": None, "resolution_note": None, "cloud_cover_pct": None,
            "cloud_note": None, "coverage_pct": None, "coverage_note": None, "available": True,
            "unavailable_reason": None, "display": None, "attribution": None, "source_id": None, "notes": []}
    base.update(kw)
    return base


# ----------------------------------------------------------------------------------------------------------------
# Sentinel-2 (Earth Search)
# ----------------------------------------------------------------------------------------------------------------
_S2_ID = re.compile(r"^S2[A-D]_\d{2}[A-Z]{3}_\d{8}_\d+_L2A$")


def _s2_footprint(geom: Any):
    from shapely.geometry import shape

    try:
        return shape(geom) if geom else None
    except Exception:
        return None


def group_s2_passes(features: list[dict], b: BBox, ref_ms: int) -> list[dict]:
    """Earth Search items -> passes (same platform within 10 min), newest first, coverage over the bbox."""
    items = []
    for f in features:
        fid = str(f.get("id") or "")
        p = f.get("properties") or {}
        t = _iso_to_ms(p.get("datetime"))
        if not _S2_ID.match(fid) or t is None or t > ref_ms:
            continue
        cc = p.get("eo:cloud_cover")
        items.append({"id": fid, "t": t, "created": _iso_to_ms(p.get("created")), "platform": str(p.get("platform") or ""),
                      "cloud": float(cc) if isinstance(cc, (int, float)) else None, "geom": _s2_footprint(f.get("geometry"))})
    items.sort(key=lambda i: -i["t"])
    passes: list[list[dict]] = []
    for it in items:
        for grp in passes:
            if grp[0]["platform"] == it["platform"] and abs(grp[0]["t"] - it["t"]) <= 10 * 60_000:
                grp.append(it)
                break
        else:
            passes.append([it])
    out = []
    for grp in passes:
        cov = coverage_fraction([i["geom"] for i in grp], b)
        if cov < MIN_COVERAGE:
            continue
        # keep only tiles that touch the area (adjacent MGRS tiles of the same pass may not)
        target = _bbox_poly(b)
        used = [i for i in grp if i["geom"] is not None and i["geom"].intersects(target)] or grp
        used.sort(key=lambda i: (i["cloud"] if i["cloud"] is not None else 101.0, i["id"]))
        created = [i["created"] for i in used if i["created"]]
        out.append({"items": used, "t0": min(i["t"] for i in used), "t1": max(i["t"] for i in used),
                    "published": min(created) if created else None, "coverage": cov,
                    "cloud": weighted_cloud([(i["geom"], i["cloud"]) for i in used], b),
                    "platform": used[0]["platform"]})
    return out[:MAX_S2_PASSES]


def _platform_label(p: str) -> str:
    m = re.match(r"^sentinel-2([a-d])$", p.strip().lower())
    return f"Sentinel-2{m.group(1).upper()}" if m else (p or "Sentinel-2")


def sentinel2_products(ctx: AreaContext) -> tuple[list[dict], int]:
    start, end, recent = _window(ctx, IMAGERY_WINDOW_DAYS)
    body = {"collections": [S2_COLLECTION], "bbox": list(ctx.bbox), "datetime": f"{_iso(start)}/{_iso(end)}", "limit": 100,
            "sortby": [{"field": "properties.datetime", "direction": "desc"}]}
    data, fetched = _fetch(UP_EARTH_SEARCH, "POST", f"{EARTH_SEARCH_URL}/search", body=body,
                           ttl_s=SCENES_TTL_RECENT_S if recent else SCENES_TTL_PAST_S)
    feats = (data or {}).get("features") or []
    products = []
    pixel_m = render_pixel_m(ctx.bbox)
    shown = (f"10 m pixels, shown at about {pixel_m:.0f} m over this area (renders are at most {RENDER_MAX_PX} px across)"
             if pixel_m > 10.5 else "10 m pixels")
    for ps in group_s2_passes(feats, ctx.bbox, ctx.reference_ms):
        ids = ",".join(i["id"] for i in ps["items"])
        year = _day(ps["t0"])[:4]
        w, s, e, n = ctx.bbox
        products.append(_product(
            id=f"sentinel-2:{ids}", family="sentinel-2", label="Sentinel-2 true colour", composite="true_color",
            platform=_platform_label(ps["platform"]), sensor="MSI", acquired_ms=ps["t0"], acquired_end_ms=ps["t1"],
            pass_times_ms=sorted({i["t"] for i in ps["items"]}), published_ms=ps["published"],
            latency_ms=(ps["published"] - ps["t0"]) if ps["published"] else None,
            latency_note="time from acquisition to listing in Earth Search",
            resolution_m=10, resolution_note=shown,
            cloud_cover_pct=ps["cloud"], cloud_note="cloud cover of the whole scene tiles, not just this area",
            coverage_pct=round(ps["coverage"] * 100, 1), coverage_note="share of the requested area with image data",
            display={"type": "image", "url": f"/api/extras/imagery/sentinel2.webp?items={ids}&bbox={bbox_key(ctx.bbox)}",
                     "coordinates": [[w, n], [e, n], [e, s], [w, s]], "bbox": [w, s, e, n], "pixel_m": pixel_m},
            attribution=SOURCES["earth_search_s2"]["attribution"].format(year=year), source_id="earth_search_s2"))
    return products, fetched


# ----------------------------------------------------------------------------------------------------------------
# Landsat 8/9 (HLS L30: CMR metadata + GIBS tiles)
# ----------------------------------------------------------------------------------------------------------------
HLS_LAYER = "HLS_L30_Nadir_BRDF_Adjusted_Reflectance"
HLS_MATRIX = "GoogleMapsCompatible_Level12"


def _cmr_polygons(entry: dict):
    """CMR legacy JSON polygons ("lat lon lat lon ...") -> shapely geometry in lon/lat."""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    polys = []
    for poly in entry.get("polygons") or []:
        ring = poly[0] if isinstance(poly, list) and poly else poly
        try:
            nums = [float(x) for x in str(ring).split()]
        except ValueError:
            continue
        pts = [(nums[i + 1], nums[i]) for i in range(0, len(nums) - 1, 2)]
        if len(pts) >= 3:
            polys.append(Polygon(pts).buffer(0))
    boxes = entry.get("boxes") or []
    for bx in boxes:
        try:
            s, w, n, e = (float(x) for x in str(bx).split())
        except ValueError:
            continue
        polys.append(_bbox_poly((w, s, e, n)))
    return unary_union(polys) if polys else None


def _cmr_granules(short_name: str, ctx_bbox: BBox, start_ms: int, end_ms: int, ttl_s: float,
                  extra: dict[str, str] | None = None) -> tuple[list[dict], int]:
    params = {"short_name": short_name, "bounding_box": bbox_key(ctx_bbox), "temporal": f"{_iso(start_ms)},{_iso(end_ms)}",
              "page_size": "100", "sort_key": "-start_date", **(extra or {})}
    data, fetched = _fetch(UP_CMR, "GET", CMR_GRANULES_URL, params=params, ttl_s=ttl_s)
    return list(((data or {}).get("feed") or {}).get("entry") or []), fetched


def landsat_products(ctx: AreaContext) -> tuple[list[dict], int]:
    start, end, recent = _window(ctx, IMAGERY_WINDOW_DAYS)
    entries, fetched = _cmr_granules("HLSL30", ctx.bbox, start, end, SCENES_TTL_RECENT_S if recent else SCENES_TTL_PAST_S,
                                     {"version": "2.0"})
    by_day: dict[str, list[dict]] = {}
    for e in entries:
        t = _iso_to_ms(e.get("time_start"))
        if t is None or t > ctx.reference_ms:
            continue
        by_day.setdefault(_day(t), []).append({"t": t, "geom": _cmr_polygons(e), "updated": _iso_to_ms(e.get("updated")),
                                               "cloud": float(e["cloud_cover"]) if _is_num(e.get("cloud_cover")) else None})
    if not by_day:
        return [], fetched
    try:
        domain, _ = _gibs_domain(HLS_LAYER, HLS_MATRIX)
    except SourceError as e:
        domain = None
        log.info("extras: HLS domain: %s", e)
    products = []
    for day in sorted(by_day, reverse=True)[:MAX_LANDSAT_DATES]:
        grp = by_day[day]
        cov = coverage_fraction([g["geom"] for g in grp], ctx.bbox)
        if cov < MIN_COVERAGE:
            continue
        t0 = min(g["t"] for g in grp)
        upd = [g["updated"] for g in grp if g["updated"]]
        day_ms = _iso_to_ms(day + "T00:00:00Z") or t0
        in_gibs = gibs_has(domain, day_ms) if domain is not None else False
        products.append(_product(
            id=f"landsat:{day}", family="landsat", label="Landsat 8/9 true colour (HLS)", composite="true_color",
            platform="Landsat 8/9", sensor="OLI", acquired_ms=t0, acquired_end_ms=max(g["t"] for g in grp),
            pass_times_ms=sorted({g["t"] for g in grp}), published_ms=max(upd) if upd else None,
            latency_ms=(max(upd) - t0) if upd else None, latency_note="time from acquisition to the latest catalogue update",
            resolution_m=30, resolution_note="30 m pixels (Harmonized Landsat Sentinel-2)",
            cloud_cover_pct=weighted_cloud([(g["geom"], g["cloud"]) for g in grp], ctx.bbox),
            cloud_note="cloud cover of the whole scene tiles, not just this area",
            coverage_pct=round(cov * 100, 1), coverage_note="share of the requested area with image data",
            available=in_gibs,
            unavailable_reason=None if in_gibs else ("NASA GIBS has not published imagery for this date yet"
                                                     if domain is not None else "NASA GIBS availability could not be checked"),
            display={"type": "raster", "tiles": [gibs_tiles(HLS_LAYER, day, HLS_MATRIX, "png")], "tile_size": 256,
                     "max_zoom": 12, "bounds": list(ctx.bbox)} if in_gibs else None,
            attribution=SOURCES["nasa_hls"]["attribution"], source_id="nasa_hls"))
    return products, fetched


def _is_num(v: Any) -> bool:
    try:
        return math.isfinite(float(v))
    except (TypeError, ValueError):
        return False


# ----------------------------------------------------------------------------------------------------------------
# VIIRS daily images (CMR pass times + GIBS)
# ----------------------------------------------------------------------------------------------------------------
VIIRS_SATS = (
    # (label, CMR short names (standard, NRT), GIBS satellite key)
    ("NOAA-20", ("VJ102MOD", "VJ102MOD_NRT"), "NOAA20"),
    ("NOAA-21", ("VJ202MOD", "VJ202MOD_NRT"), "NOAA21"),
)
VIIRS_COMPOSITES = (
    ("true_color", "TrueColor", "VIIRS true colour", "daily image as the eye would see it (smoke and clouds visible)"),
    ("fire_false_color", "BandsM11-I2-I1", "VIIRS fire false colour",
     "bands M11-I2-I1: burn scars dark red-brown, active fire bright orange; smoke mostly transparent"),
)
VIIRS_MATRIX = "GoogleMapsCompatible_Level9"


def viirs_passes(short_names: tuple[str, ...], b: BBox, start: int, end: int, recent: bool) -> tuple[list[int], int]:
    """Daytime pass start times (minute precision) over the bbox from the standard + NRT granule collections."""
    times: set[int] = set()
    errors = 0
    fetched = now_ms()
    for sn in short_names:
        try:
            entries, ms = _cmr_granules(sn, b, start, end, SCENES_TTL_RECENT_S if recent else SCENES_TTL_PAST_S,
                                        {"day_night_flag": "DAY"})
        except SourceBusy:
            raise
        except SourceError:
            errors += 1
            continue
        fetched = min(fetched, ms)
        for e in entries:
            t = _iso_to_ms(e.get("time_start"))
            if t is not None:
                times.add(t // 60_000 * 60_000)
    if errors == len(short_names):
        raise SourceError("NASA CMR could not be reached for VIIRS pass times")
    return sorted(times), fetched


def viirs_products(ctx: AreaContext) -> tuple[list[dict], int]:
    start, end, recent = _window(ctx, VIIRS_WINDOW_DAYS)
    ref = ctx.reference_ms
    products: list[dict] = []
    fetched = now_ms()
    for label, short_names, key in VIIRS_SATS:
        passes, ms = viirs_passes(short_names, ctx.bbox, start, end, recent)
        fetched = min(fetched, ms)
        by_day: dict[str, list[int]] = {}
        for t in passes:
            by_day.setdefault(_day(t), []).append(t)
        layer_tc = f"VIIRS_{key}_CorrectedReflectance_TrueColor"
        try:
            domain, _ = _gibs_domain(layer_tc, VIIRS_MATRIX)
        except SourceError as e:
            domain = None
            log.info("extras: VIIRS domain: %s", e)
        shown = 0
        for day in sorted(by_day, reverse=True):
            ts = by_day[day]
            # the daily image combines every pass of the date: offer it only once all of them are before the reference
            if max(ts) > ref:
                continue
            day_ms = _iso_to_ms(day + "T00:00:00Z") or ts[0]
            ready = (ctx.now_ms - max(ts)) >= VIIRS_IMAGERY_DELAY_MS
            in_gibs = gibs_has(domain, day_ms) if domain is not None else False
            ok = ready and in_gibs
            reason = None if ok else ("the daily image is usually ready about 3 hours after the pass" if not ready
                                      else ("NASA GIBS has not published this date yet" if domain is not None
                                            else "NASA GIBS availability could not be checked"))
            for comp, band, comp_label, comp_note in VIIRS_COMPOSITES:
                layer = f"VIIRS_{key}_CorrectedReflectance_{band}"
                products.append(_product(
                    id=f"viirs:{key.lower()}:{comp}:{day}", family="viirs", label=f"{comp_label} ({label})",
                    composite=comp, platform=label, sensor="VIIRS", acquired_ms=min(ts), acquired_end_ms=max(ts),
                    pass_times_ms=ts, published_ms=None, latency_ms=None,
                    latency_note="daily images appear about 3 hours after the satellite pass",
                    resolution_m=375, resolution_note="about 375 m pixels (750 m bands sharpened)",
                    cloud_cover_pct=None, cloud_note="cloud cover not reported; clouds and smoke are visible in the image",
                    coverage_pct=100.0, coverage_note="wide swath: the daily image covers the whole area",
                    available=ok, unavailable_reason=reason,
                    display={"type": "raster", "tiles": [gibs_tiles(layer, day, VIIRS_MATRIX, "jpg")], "tile_size": 256,
                             "max_zoom": 9, "bounds": list(ctx.bbox)} if ok else None,
                    notes=[comp_note] + (["passes on this date: " + ", ".join(_iso(t)[11:16] + " UTC" for t in ts)]
                                         if len(ts) > 1 else []),
                    attribution=SOURCES["nasa_viirs"]["attribution"], source_id="nasa_viirs"))
            shown += 1
            if shown >= 2:
                break
    return products, fetched


# ----------------------------------------------------------------------------------------------------------------
# GOES-West GeoColor (GIBS)
# ----------------------------------------------------------------------------------------------------------------
GOES_LAYER = "GOES-West_ABI_GeoColor"
GOES_MATRIX = "GoogleMapsCompatible_Level7"


def goes_products(ctx: AreaContext) -> tuple[list[dict], int]:
    ref = ctx.reference_ms
    lo = ref - GOES_WINDOW_MS
    recent = ctx.now_ms - ref < 2 * DAY_MS
    q_end = (ref // 600_000 + 1) * 600_000 if recent else (ref // HOUR_MS + 1) * HOUR_MS
    q_start = (lo // HOUR_MS) * HOUR_MS
    domain, fetched = _gibs_domain(GOES_LAYER, GOES_MATRIX, q_start, q_end,
                                   GOES_DOMAIN_TTL_RECENT_S if recent else SCENES_TTL_PAST_S)
    t = gibs_latest_at_or_before(domain, ref)
    if t is None or t < lo:
        return [], fetched
    retrieved = fetched
    return [_product(
        id=f"goes-west:{_iso(t)}", family="goes", label="GOES-West GeoColor", composite="geocolor", platform="GOES-West",
        sensor="ABI", acquired_ms=t, acquired_end_ms=t + 10 * 60_000, pass_times_ms=[t], published_ms=None,
        latency_ms=(retrieved - t) if recent else None,
        latency_note="age of the newest published frame when Fire-3d checked (GIBS publishes frames 30-60 min late)",
        resolution_m=2000, resolution_note="about 1-2 km pixels: smoke plumes and clouds, not fire edges",
        cloud_cover_pct=None, cloud_note="cloud cover not reported; clouds and smoke are visible",
        coverage_pct=100.0, coverage_note="full-disk view covers the whole area",
        display={"type": "raster", "tiles": [gibs_tiles(GOES_LAYER, _iso(t), GOES_MATRIX, "png")], "tile_size": 256,
                 "max_zoom": 7, "bounds": list(ctx.bbox)},
        notes=["true colour by day; infrared clouds and city lights at night"],
        attribution=SOURCES["nasa_goes"]["attribution"], source_id="nasa_goes")], fetched


IMAGERY_FAMILIES: dict[str, tuple[str, str, Callable[[AreaContext], tuple[list[dict], int]]]] = {
    "sentinel-2": ("Sentinel-2 (10 m)", "earth_search_s2", sentinel2_products),
    "landsat": ("Landsat 8/9 (30 m)", "nasa_hls", landsat_products),
    "viirs": ("VIIRS daily (375 m)", "nasa_viirs", viirs_products),
    "goes": ("GOES-West every 10 min (1-2 km)", "nasa_goes", goes_products),
}


def imagery_payload(ctx: AreaContext, families: list[str]) -> dict[str, Any]:
    out = _base("imagery", ctx, [IMAGERY_FAMILIES[f][1] for f in families])
    out.update({"reference_ms": ctx.reference_ms, "products": [], "families": []})
    futures = {f: _pool.submit(IMAGERY_FAMILIES[f][2], ctx) for f in families}
    fetched_all: list[int] = []
    busy: SourceBusy | None = None
    for fam, fut in futures.items():
        label, src, _ = IMAGERY_FAMILIES[fam]
        try:
            prods, fetched = fut.result(timeout=90)
        except SourceBusy as e:
            busy = e
            out["families"].append({"family": fam, "label": label, "source_id": src, "status": "unavailable",
                                    "reason": str(e), "count": 0})
            continue
        except SourceError as e:
            out["families"].append({"family": fam, "label": label, "source_id": src, "status": "unavailable",
                                    "reason": f"{e}", "count": 0})
            continue
        except Exception as e:  # never let one family break the others
            log.warning("extras: imagery family %s failed: %s", fam, config.mask_secrets(e))
            out["families"].append({"family": fam, "label": label, "source_id": src, "status": "unavailable",
                                    "reason": "unexpected error while listing images", "count": 0})
            continue
        fetched_all.append(fetched)
        out["products"].extend(prods)
        n_ok = sum(1 for p in prods if p["available"])
        out["families"].append({"family": fam, "label": label, "source_id": src,
                                "status": "available" if n_ok else "none",
                                "reason": None if n_ok else ("no usable images in the time window" if not prods
                                                             else "images found but not displayable yet"),
                                "count": n_ok})
    out["products"].sort(key=lambda p: (-(p["acquired_ms"] or 0), p["id"]))
    out["retrieved_ms"] = min(fetched_all) if fetched_all else None
    # the sources' own update time: the newest catalogue listing among the products (each product has its own)
    listed = [p["published_ms"] for p in out["products"] if p.get("published_ms")]
    out["source_updated_ms"] = max(listed) if listed else None
    if all(f["status"] == "unavailable" for f in out["families"]):
        if busy is not None and len(families) == 1:
            raise busy
        out.update(status="unavailable", reason_code="upstream_error",
                   reason="No imagery source could be reached: " + "; ".join(f["reason"] for f in out["families"]))
    out["caveats"].append("These are satellite images with their own acquisition times; they are not the dated aerial "
                          "basemap and not live fire detections.")
    return out


@router.get("/api/extras/imagery")
def get_imagery(bbox: str | None = None, incident: str | None = None, at_ms: int | None = Query(None, ge=0, le=MAX_QUERY_MS),
                margin_km: float = Query(5.0, ge=0, le=30), families: str | None = None) -> Response:
    """Recently acquired satellite images (acquired at or before ``at_ms`` / now) for the area."""
    fams = [f.strip() for f in (families or ",".join(IMAGERY_FAMILIES)).split(",") if f.strip()]
    bad = [f for f in fams if f not in IMAGERY_FAMILIES]
    if bad or not fams:
        raise HTTPException(status_code=400, detail=f"families must be a subset of {', '.join(IMAGERY_FAMILIES)}")
    ctx = area_context(bbox, incident, at_ms, margin_km, max_span=MAX_RENDER_SPAN_DEG)
    try:
        return _json(imagery_payload(ctx, fams))
    except SourceBusy as e:
        raise HTTPException(status_code=429, detail=str(e)) from None


# ----------------------------------------------------------------------------------------------------------------
# Sentinel-2 rendering (true-colour COG -> Web Mercator WebP over the bbox)
# ----------------------------------------------------------------------------------------------------------------
GDAL_ENV: dict[str, Any] = {
    "GDAL_HTTP_MULTIRANGE": "YES",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "GDAL_HTTP_TIMEOUT": "60",
    "GDAL_HTTP_CONNECTTIMEOUT": "15",
    "GDAL_HTTP_USERAGENT": config.USER_AGENT,
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_CACHEMAX": 128,
}


def render_dir() -> Path:
    return Path(config.CACHE_DIR) / "extras" / "sentinel2"


def mercator_xy(lon: float, lat: float) -> tuple[float, float]:
    r = 6378137.0
    return math.radians(lon) * r, r * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def _render_res(b: BBox, max_px: int) -> tuple[tuple[float, float, float, float], float, float]:
    """(Web Mercator bounds, pixel size in mercator metres, mercator metres per ground metre) of a bbox render:
    10 m ground pixels (the Sentinel-2 true-colour resolution), coarser when the area needs more than max_px."""
    x0, y0 = mercator_xy(b[0], b[1])
    x1, y1 = mercator_xy(b[2], b[3])
    scale = 1 / math.cos(math.radians((b[1] + b[3]) / 2))
    return (x0, y0, x1, y1), max(10.0 * scale, (x1 - x0) / max_px, (y1 - y0) / max_px), scale


def render_grid(b: BBox, max_px: int = RENDER_MAX_PX) -> tuple[tuple[float, float, float, float], int, int]:
    """Web Mercator bounds and pixel size for a bbox at <= 10 m ground resolution and <= max_px per side."""
    (x0, y0, x1, y1), res, _ = _render_res(b, max_px)
    w = max(1, int(math.ceil((x1 - x0) / res)))
    h = max(1, int(math.ceil((y1 - y0) / res)))
    return (x0, y0, x1, y1), w, h


def render_pixel_m(b: BBox, max_px: int = RENDER_MAX_PX) -> float:
    """Ground size (m) of one pixel of the render of a bbox: 10 m (native) for small areas, coarser for large ones."""
    _, res, scale = _render_res(b, max_px)
    return round(res / scale, 1)


def _s2_visual_href(item_id: str) -> str:
    data, _ = _fetch(UP_EARTH_SEARCH, "GET", f"{EARTH_SEARCH_URL}/collections/{S2_COLLECTION}/items/{item_id}",
                     ttl_s=SCENES_TTL_PAST_S)
    href = (((data or {}).get("assets") or {}).get("visual") or {}).get("href")
    if not href or not str(href).startswith(f"https://{S2_ASSET_HOST}/"):
        raise SourceError("the scene has no true-colour image Fire-3d can read")
    return str(href)


def _read_visual(href: str, bounds: tuple[float, float, float, float], w: int, h: int) -> np.ndarray:
    """(3, h, w) uint8 of a TCI COG warped onto the Web Mercator grid (0 = no data)."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.transform import from_bounds
    from rasterio.vrt import WarpedVRT

    dst_t = from_bounds(*bounds, w, h)
    ground_res = (bounds[2] - bounds[0]) / w * math.cos(math.atan(math.sinh(((bounds[1] + bounds[3]) / 2) / 6378137.0)))
    with rasterio.Env(**GDAL_ENV):
        with rasterio.open(href) as src0:
            ovr = src0.overviews(1)
            native = abs(src0.transform.a)
        level = None
        for i, f in enumerate(ovr):
            if native * f <= ground_res * 1.05:
                level = i
        kw = {"overview_level": level} if level is not None else {}
        with rasterio.open(href, **kw) as src:
            src_res = abs(src.transform.a) if level is None else native * ovr[level]
            rs = Resampling.average if ground_res > src_res * 1.5 else Resampling.bilinear
            with WarpedVRT(src, crs="EPSG:3857", transform=dst_t, width=w, height=h, resampling=rs, src_nodata=0,
                           nodata=0) as vrt:
                return vrt.read(indexes=[1, 2, 3])


def _render_key(ids: list[str], b: BBox) -> str:
    return hashlib.sha256(f"{','.join(sorted(ids))}|{bbox_key(b)}|v{RENDER_VERSION}".encode()).hexdigest()[:40]


def _trim_render_cache(d: Path) -> None:
    try:
        files = sorted((p for p in d.glob("*.webp") if p.is_file()), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in files)
        if total <= RENDER_CACHE_MAX_BYTES:
            return
        for p in files:
            if total <= RENDER_CACHE_TRIM_BYTES:
                break
            total -= p.stat().st_size
            p.unlink(missing_ok=True)
    except OSError as e:
        log.warning("extras: render cache trim failed: %s", e)


def render_sentinel2(ids: list[str], b: BBox, reader: Callable[[str, tuple, int, int], np.ndarray] | None = None) -> Path:
    """Render (or reuse) the WebP for these Earth Search items over the bbox; raises SourceError / SourceBusy."""
    d = render_dir()
    key = _render_key(ids, b)
    out = d / f"{key}.webp"
    if out.is_file():
        os.utime(out)
        return out
    with _render_key_guard:
        lock = _render_key_locks.setdefault(key, threading.Lock())
    try:
        with lock:
            if out.is_file():
                return out
            if not UP_RENDER.limiter.try_acquire():
                raise SourceBusy("Fire-3d's Sentinel-2 rendering limit is reached; try again in a minute")
            if not _render_slots.acquire(timeout=60):
                raise SourceBusy("Sentinel-2 rendering is busy; try again shortly")
            try:
                _render_to(out, ids, b, reader or _read_visual)
            finally:
                _render_slots.release()
            _trim_render_cache(d)
    finally:
        with _render_key_guard:
            _render_key_locks.pop(key, None)
    return out


def _render_to(out: Path, ids: list[str], b: BBox, read: Callable[[str, tuple, int, int], np.ndarray]) -> None:
    """Mosaic the items' true-colour images (first item wins where several cover a pixel) into a WebP."""
    bounds, w, h = render_grid(b)
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    for item_id in ids:
        href = _s2_visual_href(item_id)
        try:
            rgb = read(href, bounds, w, h)
        except SourceError:
            raise
        except Exception as e:
            log.warning("extras: reading %s failed: %s", item_id, e)
            raise SourceError("the Sentinel-2 image could not be read") from None
        valid = (rgb != 0).any(axis=0)
        fill = valid & (rgba[..., 3] == 0)
        for c in range(3):
            rgba[..., c][fill] = rgb[c][fill]
        rgba[..., 3][fill] = 255
        if rgba[..., 3].all():
            break
    if not rgba[..., 3].any():
        raise SourceError("the scene has no image data over this area")
    from PIL import Image

    out.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "WEBP", quality=85, method=4)
    fhttp.atomic_write_bytes(out, buf.getvalue())


@router.get("/api/extras/imagery/sentinel2.webp")
def get_sentinel2_render(items: str, bbox: str) -> Response:
    """The true-colour Sentinel-2 image of one pass (1-4 Earth Search items) over the bbox, in Web Mercator with
    transparent no-data. Place it with a MapLibre image source at the bbox corners."""
    ids = [i.strip() for i in items.split(",") if i.strip()]
    if not 1 <= len(ids) <= 4 or not all(_S2_ID.match(i) for i in ids):
        raise HTTPException(status_code=400, detail="items must be 1-4 Sentinel-2 L2A item ids")
    try:
        b = parse_bbox(bbox, MAX_RENDER_SPAN_DEG)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    try:
        p = render_sentinel2(ids, b)
    except SourceBusy as e:
        raise HTTPException(status_code=503, detail=str(e)) from None
    except SourceError as e:
        raise HTTPException(status_code=502, detail=str(e)) from None
    return Response(p.read_bytes(), media_type="image/webp", headers={"Cache-Control": "public, max-age=604800, immutable"})


# ----------------------------------------------------------------------------------------------------------------
# Source metadata
# ----------------------------------------------------------------------------------------------------------------


@router.get("/api/extras/sources")
def get_sources() -> Response:
    """Every optional source with its publisher, licence, terms link, attribution and update cadence."""
    return _json({"sources": SOURCES, "past_tolerance_ms": PAST_TOLERANCE_MS}, cache="public, max-age=3600")
