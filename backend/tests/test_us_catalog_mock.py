"""Offline WFIGS / CAL FIRE / FIRMS services for the brief-3 catalog tests (us-catalog; helpers only, no tests).

``WfigsServer`` answers the three WFIGS layers' ArcGIS ``query`` requests from a list of features, evaluating the
small ``where`` grammar ``fire3d.sources.wfigs`` sends (``IncidentTypeCategory='WF'``, ``UniqueFireIdentifier LIKE
'2025-%'``, ``IncidentSize>=300``, ``IrwinID LIKE '{ABC%'``, joined by AND). ``feature()`` builds one ArcGIS JSON
feature with the attribute names WFIGS uses.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

import httpx

from fire3d.timeutil import iso_to_ms


def feature(name: str, irwin: str, state: str | None, lon: float, lat: float, *, ufi: str | None = None, size: float | None = 500.0,
            pct: float | None = None, discovered: str = "2026-10-10T18:00:00Z", modified: str = "2026-10-22T16:00:00Z",
            typ: str = "WF", agency: str | None = "USFS", unit: str | None = "XXUNF", county: str | None = "Somewhere",
            gacc: str | None = "NWCC", cpx_name: str | None = None, cpx_child: int = 0, contained: str | None = None,
            controlled: str | None = None, out: str | None = None) -> dict:
    year = discovered[:4]
    st = (state or "US-XX")[3:] if (state or "").startswith("US-") else (state or "XX")
    return {
        "attributes": {
            "IrwinID": "{" + irwin.lower() + "}", "UniqueFireIdentifier": ufi or f"{year}-{st}XXX-{irwin[:6].upper()}",
            "IncidentName": name, "IncidentTypeCategory": typ, "IncidentSize": size, "PercentContained": pct,
            "FireDiscoveryDateTime": iso_to_ms(discovered), "ContainmentDateTime": iso_to_ms(contained) if contained else None,
            "ControlDateTime": iso_to_ms(controlled) if controlled else None, "FireOutDateTime": iso_to_ms(out) if out else None,
            "ModifiedOnDateTime_dt": iso_to_ms(modified), "POOState": state, "POOCounty": county,
            "POOProtectingAgency": agency, "POOProtectingUnit": unit, "GACC": gacc, "IsCpxChild": cpx_child,
            "CpxName": cpx_name, "CpxID": None, "ICS209ReportDateTime": None,
        },
        "geometry": {"x": lon, "y": lat},
    }


def _matches(attrs: dict, where: str) -> bool:
    for clause in re.split(r"\s+AND\s+", where.strip()):
        clause = clause.strip().strip("()")
        if m := re.fullmatch(r"(\w+)\s*=\s*'([^']*)'", clause):
            if str(attrs.get(m.group(1)) or "") != m.group(2):
                return False
        elif m := re.fullmatch(r"(\w+)\s+IN\s+\((.*)\)", clause):
            vals = re.findall(r"'([^']*)'", m.group(2))
            if str(attrs.get(m.group(1)) or "") not in vals:
                return False
        elif m := re.fullmatch(r"(\w+)\s+LIKE\s+'([^']*)'", clause):
            rx = "^" + re.escape(m.group(2)).replace("%", ".*") + "$"
            if not re.match(rx, str(attrs.get(m.group(1)) or ""), flags=re.IGNORECASE):
                return False
        elif m := re.fullmatch(r"(\w+)\s*>=\s*([\d.]+)", clause):
            v = attrs.get(m.group(1))
            if v is None or float(v) < float(m.group(2)):
                return False
        else:
            raise AssertionError(f"unsupported where clause: {clause!r}")
    return True


@dataclass
class WfigsServer:
    current: list[dict] = field(default_factory=list)
    ytd: list[dict] = field(default_factory=list)
    all_years: list[dict] = field(default_factory=list)
    down: bool = False
    calls: list[str] = field(default_factory=list)

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.calls.append(url)
        if self.down:
            return httpx.Response(503, text="Service Unavailable")
        q = dict(request.url.params)
        layer = (self.current if "Locations_Current" in url else self.ytd if "Locations_YearToDate" in url else self.all_years)
        where = q.get("where", "1=1")
        feats = [f for f in layer if where == "1=1" or _matches(f["attributes"], where)]
        off, n = int(q.get("resultOffset", 0)), int(q.get("resultRecordCount", 2000))
        page = feats[off:off + n]
        return httpx.Response(200, json={"features": page, "exceededTransferLimit": off + n < len(feats)})


def feed_csv(rows: list[tuple[float, float, str]], satellite: str = "N") -> str:
    """A FIRMS VIIRS feed CSV with rows (lat, lon, ISO time)."""
    head = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight\n"
    out = []
    for lat, lon, iso in rows:
        d, t = iso[:10], iso[11:16].replace(":", "")
        out.append(f"{lat:.5f},{lon:.5f},330.0,0.4,0.4,{d},{t},{satellite},nominal,2.0NRT,300.0,5.0,D\n")
    return head + "".join(out)


def json_body(obj: Any) -> str:
    return json.dumps(obj)
