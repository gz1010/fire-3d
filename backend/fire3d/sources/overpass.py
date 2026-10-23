"""Polar-orbiter passes over a fire, from NASA CMR granule metadata (SPEC 8.3 time_range). Owner: backend.

A live forecast starts at the latest *observation* of the fire. Fire detections only say when a satellite saw
fire; a pass that looked at the fire and saw nothing is an observation too ("no active fire above the detection
limit"). The passes come from NASA's Common Metadata Repository (CMR): the granules of the same active-fire
products that NASA FIRMS distributes (VIIRS 375 m VNP14IMG / VJ114IMG / VJ214IMG, MODIS MOD14 / MYD14), the LANCE
near-real-time collections for live fires and the standard (archive) collections for past fires. A granule whose
footprint contains the point is a pass over it; FIRMS ``acq_time`` falls inside the granule's
[time_start, time_end] (checked against FIRMS rows on 2026-10-17).

* :func:`fetch_passes` - every pass over a point in a time window (one CMR search per product).
* :func:`confirmed` - passes whose granule was published in CMR at least :data:`INGEST_MARGIN_MS` before the FIRMS
  data we compare against was fetched, so their detections (if any) are in our copy of FIRMS.
* :func:`detections_per_pass` - how many detections of the fire each pass produced.

Network: one CMR search per product (5 per call), no key or account, ``Client-Id: fire3d`` header, cached 10 min
while the window touches the last 6 h (30 days after), at most :data:`MAX_REQUESTS_PER_MIN` requests per minute,
20 s timeout and one retry. Failures are collected per product in ``PassList.errors``; when the first search gets no
answer at all (CMR down) the others are skipped, so an outage costs one timeout. Callers decide what an incomplete
list means.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Sequence

import numpy as np

from .. import config
from .. import http as fhttp
from ..timeutil import HOUR_MS, fmt_local_short, now_ms

log = logging.getLogger(__name__)

CMR_GRANULES_URL = "https://cmr.earthdata.nasa.gov/search/granules.json"
CMR_HEADERS = {"Client-Id": "fire3d"}
MAX_REQUESTS_PER_MIN = 30
TTL_RECENT_S = 10 * 60.0             # windows ending within RECENT_MS of now: new granules keep arriving
TTL_PAST_S = 30 * 86400.0
RECENT_MS = 6 * HOUR_MS
PAGE_SIZE = 200
REQUEST_TIMEOUT_S = 20.0
INGEST_MARGIN_MS = 30 * 60_000       # a granule published this long before the FIRMS fetch is in FIRMS (FIRMS is LANCE)
UNPUBLISHED_LATENCY_MS = 3 * HOUR_MS  # no publish time: FIRMS' documented NRT latency ("within 3 hours")
MATCH_SLACK_MS = 60_000              # FIRMS acq_time has minute precision

_limiter = fhttp.RateLimiter(MAX_REQUESTS_PER_MIN, 60.0, "NASA CMR (satellite passes)")


@dataclass(frozen=True)
class Product:
    """One active-fire product: FIRMS satellite code, instrument, label, CMR (short_name, version) NRT / archive."""

    satellite: str
    instrument: str
    label: str
    nrt: tuple[str, str]
    archive: tuple[str, str]


PRODUCTS: tuple[Product, ...] = (
    Product("N", "VIIRS", "Suomi NPP VIIRS", ("VNP14IMG_NRT", "2"), ("VNP14IMG", "002")),
    Product("N20", "VIIRS", "NOAA-20 VIIRS", ("VJ114IMG_NRT", "2"), ("VJ114IMG", "002")),
    Product("N21", "VIIRS", "NOAA-21 VIIRS", ("VJ214IMG_NRT", "2"), ("VJ214IMG", "002")),
    Product("Terra", "MODIS", "Terra MODIS", ("MOD14", "6.1NRT"), ("MOD14", "061")),
    Product("Aqua", "MODIS", "Aqua MODIS", ("MYD14", "6.1NRT"), ("MYD14", "061")),
)
PRODUCT_BY_SATELLITE = {p.satellite: p for p in PRODUCTS}


@dataclass(frozen=True)
class Pass:
    """One granule of an active-fire product whose footprint contains the point."""

    t_ms: int                 # granule start (FIRMS acq times of this pass fall in [t_ms, t_end_ms])
    t_end_ms: int
    satellite: str            # FIRMS code: N, N20, N21, Terra, Aqua
    instrument: str           # VIIRS | MODIS
    label: str                # "NOAA-21 VIIRS"
    daynight: str             # "D" | "N" ("D" when CMR says BOTH/UNSPECIFIED and the sun cannot tell)
    published_ms: int | None  # CMR ``updated``: when the granule metadata was published (~ product time)
    product: str              # "VJ214IMG_NRT v2"

    def as_dict(self) -> dict:
        return {"t_ms": self.t_ms, "t_end_ms": self.t_end_ms, "satellite": self.satellite, "instrument": self.instrument,
                "label": self.label, "daynight": self.daynight, "published_ms": self.published_ms, "product": self.product}

    def describe(self, tz: str | None = None) -> str:
        """``"NOAA-21 VIIRS, Oct 17 14:24 PDT (day)"`` in the fire's zone ``tz`` (UTC when None)."""
        return f"{self.label}, {pass_time(self.t_ms, tz)} ({'day' if self.daynight == 'D' else 'night'})"


class PassList(list):
    """``list[Pass]`` (newest first) plus ``errors`` (per product), ``fetched_ms`` (oldest response) and ``source``."""

    def __init__(self, items: Iterable[Pass] = (), errors: Sequence[str] = (), fetched_ms: int | None = None, source: str = ""):
        super().__init__(items)
        self.errors = list(errors)
        self.fetched_ms = fetched_ms
        self.source = source

    @property
    def complete(self) -> bool:
        """True when every product answered."""
        return not self.errors


def pass_time(ms: int, tz: str | None = None) -> str:
    """``"Oct 17 14:24 PDT"`` in the fire's zone ``tz`` (UTC when None; never an assumed Pacific time)."""
    return fmt_local_short(int(ms), tz)


def la_time(ms: int, tz: str | None = None) -> str:
    """Deprecated alias of :func:`pass_time` (brief 3)."""
    return pass_time(ms, tz)


def iso_to_ms(value: object) -> int | None:
    """CMR ISO 8601 time (``2026-10-17T21:24:00.000Z``) -> epoch ms; None when missing or malformed."""
    if not isinstance(value, str) or not value:
        return None
    try:
        d = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return int(round(d.timestamp() * 1000))


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000.0, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _solar_daynight(t_ms: int, lat: float, lon: float) -> str:
    from .firms import solar_elevation_deg

    try:
        return "D" if float(np.asarray(solar_elevation_deg(t_ms, lat, lon)).ravel()[0]) > 0.0 else "N"
    except Exception:  # noqa: BLE001 - a label only
        return "D"


def parse_granules(entries: Sequence[dict], product: Product, collection: tuple[str, str], lat: float, lon: float) -> list[Pass]:
    """CMR ``feed.entry`` items -> passes (malformed entries skipped)."""
    out: list[Pass] = []
    for e in entries or []:
        if not isinstance(e, dict):
            continue
        t0, t1 = iso_to_ms(e.get("time_start")), iso_to_ms(e.get("time_end"))
        if t0 is None:
            continue
        flag = str(e.get("day_night_flag") or "").upper()
        dn = "D" if flag == "DAY" else "N" if flag == "NIGHT" else _solar_daynight(t0, lat, lon)
        out.append(Pass(t_ms=t0, t_end_ms=max(t1 or t0, t0), satellite=product.satellite, instrument=product.instrument,
                        label=product.label, daynight=dn, published_ms=iso_to_ms(e.get("updated")),
                        product=f"{collection[0]} v{collection[1]}"))
    return out


def fetch_passes(lon: float, lat: float, start_ms: int, end_ms: int, *, nrt: bool = True,
                 satellites: Iterable[str] | None = None) -> PassList:
    """Passes of the VIIRS/MODIS active-fire products whose granule footprint contains (lon, lat) and that start in
    [start_ms, end_ms], newest first. ``nrt``: the LANCE NRT collections (live) or the standard archive ones (past
    fires). ``satellites`` limits the products (FIRMS codes). Never raises for network errors: they are listed in
    ``errors`` (one per failed product)."""
    want = set(satellites) if satellites else None
    start_ms, end_ms = int(start_ms), int(end_ms)
    passes: list[Pass] = []
    errors: list[str] = []
    fetched: list[int] = []
    if end_ms < start_ms:
        return PassList([], ["empty time window"], None, "")
    ttl = TTL_RECENT_S if end_ms > now_ms() - RECENT_MS else TTL_PAST_S
    used: list[str] = []
    unreachable = False
    for p in PRODUCTS:
        if want is not None and p.satellite not in want:
            continue
        coll = p.nrt if nrt else p.archive
        if unreachable:          # CMR itself is down (no answer to the first search): do not wait on every product
            errors.append(f"{coll[0]} v{coll[1]}: skipped, NASA CMR unreachable")
            continue
        params = {"short_name": coll[0], "version": coll[1], "point": f"{float(lon):.5f},{float(lat):.5f}",
                  "temporal": f"{_iso(start_ms)},{_iso(end_ms)}", "page_size": str(PAGE_SIZE), "sort_key": "-start_date"}
        try:
            hit = _limiter.acquire(timeout=60.0)
            if not hit:
                raise fhttp.HttpError(None, CMR_GRANULES_URL, "client-side CMR rate limit")
            resp = fhttp.request("GET", CMR_GRANULES_URL, params=params, headers=CMR_HEADERS, ttl_s=ttl,
                                 timeout=REQUEST_TIMEOUT_S, retries=1)
            data = resp.json()
            entries = ((data or {}).get("feed") or {}).get("entry") or []
        except Exception as e:  # noqa: BLE001 - HttpError, bad JSON, transport errors: recorded per product
            errors.append(config.mask_secrets(f"{coll[0]} v{coll[1]}: {type(e).__name__}: {e}")[:240])
            no_answer = not isinstance(e, fhttp.HttpError) or e.status is None
            unreachable = no_answer and not used
            continue
        fetched.append(int(resp.fetched_ms))
        used.append(f"{coll[0]} v{coll[1]}")
        passes += parse_granules(entries, p, coll, lat, lon)
    passes.sort(key=lambda q: (q.t_ms, q.satellite), reverse=True)
    src = ("NASA CMR granules of " + ", ".join(used)) if used else ""
    return PassList(passes, errors, min(fetched) if fetched else None, src)


def is_confirmed(p: Pass, data_ms: int, margin_ms: int = INGEST_MARGIN_MS) -> bool:
    """True when ``p``'s detections must already be in FIRMS data fetched at ``data_ms``: its granule was published
    ``margin_ms`` before (or, without a publish time, it ended FIRMS' 3 h NRT latency before)."""
    if p.published_ms is not None:
        return p.published_ms + margin_ms <= data_ms
    return p.t_end_ms + UNPUBLISHED_LATENCY_MS <= data_ms


def confirmed(passes: Iterable[Pass], data_ms: int | None, margin_ms: int = INGEST_MARGIN_MS) -> list[Pass]:
    """The passes :func:`is_confirmed` at ``data_ms`` (none without a data time), newest first."""
    if data_ms is None:
        return []
    return sorted((p for p in passes if is_confirmed(p, int(data_ms), margin_ms)), key=lambda q: (q.t_ms, q.satellite), reverse=True)


def detections_per_pass(passes: Sequence[Pass], det_t_ms: Sequence[int] | np.ndarray, det_satellite: Sequence[str] | np.ndarray,
                        slack_ms: int = MATCH_SLACK_MS) -> list[int]:
    """Number of detections (same satellite, time inside the granule +- ``slack_ms``) per pass."""
    t = np.asarray(det_t_ms, dtype=np.int64)
    s = np.asarray(det_satellite, dtype=object).astype(str)
    out = []
    for p in passes:
        sel = (s == p.satellite) & (t >= p.t_ms - slack_ms) & (t <= p.t_end_ms + slack_ms)
        out.append(int(sel.sum()))
    return out
