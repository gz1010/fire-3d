"""FEMA IPAWS archived alerts via OpenFEMA: the archive channel of the local-alerts endpoint (CONTRACT 14.7).

Source: ``https://www.fema.gov/api/open/v1/IpawsArchivedAlerts`` (OpenFEMA dataset "IPAWS Archived Alerts" v1):
every message sent through FEMA IPAWS, as its CAP fields, "published with a twenty-four (24) hour delay"; "FEMA does
not validate the content of each message". Terms: OpenFEMA terms and conditions
(https://www.fema.gov/about/openfema/terms-conditions, version of 2025-01-22, checked by the brief-3 evacuations
audit): free to use, the notice :data:`NOTICE` is required, and no FEMA or DHS logo may be used.

Query (:func:`fetch_window`): one date window on ``sent`` with ``status eq 'Actual'``, paged with ``$top``/``$skip``.
Event codes, SAME county codes and polygons are matched here (:func:`parse_record`, ``nws.place_local``), not on the
server: OpenFEMA's nested ``any()`` filters on ``info`` are slow (the audit saw a 503 after 60 s), while a day of
national messages is about 40-200 rows and answers in about a second. ``references`` exist only inside the CAP XML
(``originalMessage``), so it is requested and read with a regular expression (never parsed as XML); only the
identifiers are kept, never the operators' sender addresses.

Every alert's ``source_url`` is the OpenFEMA query for that record, by its CAP ``identifier`` (:func:`record_url`).
Requests go through :mod:`fire3d.http` (disk cache) behind :data:`OPENFEMA_LIMITER`.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Iterable
from urllib.parse import quote

import shapely

from .. import http as fhttp
from ..timeutil import DAY_MS, HOUR_MS, ms_to_dt, now_ms
from . import nws

log = logging.getLogger(__name__)

API_URL = "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts"
DATASET_URL = "https://www.fema.gov/openfema-data-page/ipaws-archived-alerts-v1"
TERMS_URL = "https://www.fema.gov/about/openfema/terms-conditions"
CREDIT = "FEMA IPAWS archive via OpenFEMA"
NOTICE = "This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA"
SOURCE: dict[str, str] = {
    "name": "FEMA IPAWS Archived Alerts (OpenFEMA)",
    "url": DATASET_URL,
    "credit": CREDIT,
    "license": "OpenFEMA terms: free to use with the notice \"" + NOTICE + "\"; no FEMA or DHS logos",
    "terms_url": TERMS_URL,
}
ARCHIVE_DELAY_MS = 24 * HOUR_MS        # OpenFEMA publishes IPAWS messages about a day later
PAGE_SIZE = 1000
MAX_PAGES = 10
SELECT = "identifier,sent,msgType,status,info,originalMessage"
TIMEOUT_S = 60.0
RETRIES = 1
RECENT_TTL_S = 3600.0                  # a window that ended less than 3 days ago may still be filling
PAST_TTL_S = 30 * 86400.0
OPENFEMA_LIMITER = fhttp.RateLimiter(20, 60.0, "official: OpenFEMA")
_NAME = "FEMA's IPAWS archive (OpenFEMA)"
_REFS_RE = re.compile(r"<(?:\w+:)?references>(.*?)</(?:\w+:)?references>", re.S)


def record_url(identifier: str) -> str:
    """The OpenFEMA query that returns this one message, by its CAP identifier (URL-encoded)."""
    flt = f"identifier eq '{identifier}'"
    return f"{API_URL}?$filter={quote(flt, safe='')}"


def _iso(ms: int) -> str:
    return ms_to_dt(ms).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def window_params(start_ms: int, end_ms: int, skip: int = 0) -> dict[str, str]:
    """OData parameters of one page of the ``[start_ms, end_ms)`` window (sent time, actual messages only)."""
    return {
        "$filter": f"status eq 'Actual' and sent ge '{_iso(start_ms)}' and sent lt '{_iso(end_ms)}'",
        "$select": SELECT,
        "$orderby": "sent",
        "$top": str(PAGE_SIZE),
        "$skip": str(skip),
        "$inlinecount": "allpages",
    }


def window_ttl_s(end_ms: int, now: int) -> float:
    return RECENT_TTL_S if end_ms > now - 3 * DAY_MS else PAST_TTL_S


def fetch_window(start_ms: int, end_ms: int, *, now: int | None = None, timeout: float = TIMEOUT_S) -> tuple[list[dict], int, bool]:
    """Every actual IPAWS message sent in ``[start_ms, end_ms)``: ``(records, fetched_ms, truncated)``. Raises
    ``nws.SourceError`` (unreachable, unreadable) or ``nws.SourceBusy`` (Fire-3d's own limit)."""
    t_now = now if now is not None else now_ms()
    ttl = window_ttl_s(end_ms, t_now)
    out: list[dict] = []
    fetched: list[int] = []
    total = None
    for page in range(MAX_PAGES):
        params = window_params(start_ms, end_ms, page * PAGE_SIZE)
        hit = fhttp.peek_cache("GET", API_URL, params, ttl)
        if hit is None and not OPENFEMA_LIMITER.try_acquire():
            raise nws.SourceBusy(f"{_NAME}: Fire-3d's request limit is reached; try again in a minute")
        try:
            resp = hit or fhttp.request("GET", API_URL, params=params, ttl_s=ttl, timeout=timeout, retries=RETRIES)
            data = resp.json()
        except fhttp.HttpError as e:
            code = f"HTTP {e.status}" if e.status is not None else "no response"
            raise nws.SourceError(f"{_NAME} could not be reached ({code})", e.status) from None
        except ValueError:
            fhttp.evict_cache("GET", API_URL, params)
            raise nws.SourceError(f"{_NAME} sent a reply Fire-3d could not read") from None
        rows = data.get("IpawsArchivedAlerts") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            fhttp.evict_cache("GET", API_URL, params)
            raise nws.SourceError(f"{_NAME} sent an unexpected reply")
        fetched.append(int(resp.fetched_ms))
        out.extend(r for r in rows if isinstance(r, dict))
        meta = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
        total = meta.get("count") if isinstance(meta.get("count"), int) else total
        if len(rows) < PAGE_SIZE or (total is not None and len(out) >= total):
            return out, min(fetched), False
    return out, min(fetched), True


def references_of(original_message: Any) -> list[str]:
    """The referenced messages' identifiers from the CAP XML ``<references>`` ("sender,identifier,sent" triples);
    the sender part is never kept."""
    if not isinstance(original_message, str):
        return []
    m = _REFS_RE.search(original_message)
    if not m:
        return []
    out = []
    for triple in m.group(1).split():
        parts = triple.split(",")
        if len(parts) >= 3 and parts[1]:
            out.append(parts[1])
    return list(dict.fromkeys(out))


def _pairs(items: Any, key: str) -> list[str]:
    """Values of the ``{name, value}`` items named ``key`` (OpenFEMA's transformed eventCode / parameter / geocode)."""
    out = []
    for it in items or []:
        if isinstance(it, dict) and str(it.get("name") or it.get("valueName") or "") == key and it.get("value") is not None:
            out.append(str(it["value"]))
    return out


def _pick_info(infos: Any) -> dict | None:
    items = [i for i in infos or [] if isinstance(i, dict)]
    if not items:
        return None
    return next((i for i in items if str(i.get("language") or "en").lower().startswith("en")), items[0])


def parse_record(rec: dict) -> dict[str, Any] | None:
    """One OpenFEMA record -> a LocalAlert dict (``channel`` openfema_archive, ``archived`` true, text verbatim, keys
    starting with "_" internal); None unless it is an actual local officials' message in scope (FRW, EVI, SPW, CDW;
    CEM and LAE when the text mentions fire, smoke or evacuation). The operator's ``sender`` is never read."""
    if not isinstance(rec, dict) or rec.get("status") != "Actual":
        return None
    ident = str(rec.get("identifier") or "").strip()
    info = _pick_info(rec.get("info"))
    if not ident or info is None:
        return None
    codes = _pairs(info.get("eventCode"), "SAME")
    code = next((c for c in codes if c in nws.LOCAL_CODES), None)
    if code is None:
        return None
    params = info.get("parameter")
    wea = next(iter(_pairs(params, "CMAMtext")), None)
    wea_long = next(iter(_pairs(params, "CMAMlongtext")), None)
    event = nws._text(info.get("event"))
    headline = nws._text(info.get("headline"))
    desc, instr = nws._verbatim(info.get("description")), nws._verbatim(info.get("instruction"))
    if not nws.local_in_scope(code, event, headline, desc, instr, wea, wea_long):
        return None
    areas = [a for a in info.get("area") or [] if isinstance(a, dict)]
    same = [c for a in areas for c in _pairs(a.get("geocode"), "SAME") if re.fullmatch(r"\d{6}", c)]
    ugcs = [c for a in areas for c in _pairs(a.get("geocode"), "UGC") if nws.UGC_RE.match(c)]
    polys = [g for g in (nws.polygonal(a.get("polygon")) for a in areas) if g is not None]
    geom = shapely.union_all(polys) if polys else None
    descs = [nws._text(a.get("areaDesc")) for a in areas]
    mt = nws._text(rec.get("msgType"))
    sender_name = nws._text(info.get("senderName"))
    return {
        "id": ident,
        "channel": "openfema_archive",
        "archived": True,
        "event": event or code,
        "event_code": code,
        "message_type": mt if mt in ("Alert", "Update", "Cancel") else None,
        "references": references_of(rec.get("originalMessage")),
        "sender_name": sender_name,
        "sender_is_platform": nws.is_platform_sender(sender_name),
        "sent_ms": nws._ms(rec.get("sent")),
        "effective_ms": nws._ms(info.get("effective")),
        "onset_ms": nws._ms(info.get("onset")),
        "expires_ms": nws._ms(info.get("expires")),
        "headline": headline,
        "description": desc,
        "instruction": instr,
        "wea_text": nws._verbatim(wea),
        "wea_long_text": nws._verbatim(wea_long),
        "web": nws._https(info.get("web")),
        "source_url": record_url(ident),
        "area_desc": "; ".join(dict.fromkeys(d for d in descs if d)) or None,
        "same_codes": list(dict.fromkeys(same)),
        "ugcs": list(dict.fromkeys(ugcs)),
        "polygon": nws.geojson_out(geom),
        "_geom": geom,
    }


def parse_records(records: Iterable[dict]) -> list[dict]:
    """The in-scope messages of ``records``, one per CAP identifier (the latest copy of a duplicate wins)."""
    out: dict[str, dict] = {}
    for r in records:
        a = parse_record(r)
        if a is not None:
            out[a["id"]] = a
    return list(out.values())


def archive_window(at_ms: int) -> tuple[int, int]:
    """The archive window of a replay time: messages sent from ``at_ms - 24 h`` to ``at_ms + 1 h`` (whole hours, the
    same span as the NWS past request), so one window is one cache entry."""
    a = (int(at_ms) - nws.PAST_BEFORE_MS) // HOUR_MS * HOUR_MS
    b = -(-(int(at_ms) + nws.PAST_AFTER_MS) // HOUR_MS) * HOUR_MS
    return a, b


def archived_alerts(at_ms: int, *, now: int | None = None, timeout: float = TIMEOUT_S) -> tuple[list[dict], int, bool]:
    """The in-scope archived messages around ``at_ms`` (see :func:`archive_window`): ``(alerts, fetched_ms,
    truncated)``. Raises ``nws.SourceError`` / ``nws.SourceBusy``."""
    a, b = archive_window(at_ms)
    recs, fetched, truncated = fetch_window(a, b, now=now, timeout=timeout)
    return parse_records(recs), fetched, truncated
