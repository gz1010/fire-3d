# us-official: as built (brief 3, wave 1)

Role `us-official`: official information across the lower 48 (both ends). Oregon evacuations and "not available in
this state" elsewhere, cameras, source-neutral fire records, national NWS and local officials' alerts in the UI. This
note records what was built against CONTRACT §14 and every deviation; it is kept current at each milestone.

## 14.9.6 Cross-role shims (M1)

All optional; without `tf` each falls back to `getTimeFormat()` (`state/timeZone.ts`: the open fire's zone, else the
selected place's, else the viewer's, with the current workspace's clock).

| Export | File | Shim |
|---|---|---|
| `FeedInput.tf?: TimeFmt` | `ui/feed/feedModel.ts` | `buildFeedItems` words every time in `tf` (forecast re-run time, pass days and times, the quiet-period row); `groupPassesByDay(passes, wallMs, tf?)` and `quietItem(m, wallMs, staleAfterMs?, tf?)` group and word days in `tf.tz` |
| `OfficialContext.tf?: TimeFmt` | `location/official.ts` | `officialBlock(info, { …, tf })`: zone times in `tf`; `calfireLine(cf, units, tf?)` too |
| `officialFireWeatherNote(fw, tf?)` | `location/official.ts` | accepted; the note ("NWS Red Flag Warning in effect") has no time |
| `zoneDetail(zone, nowMs, tf?)` | `extras/evacuation.ts` | "Updated by the issuer …" / "listed by …" in `tf` (`zoneTimeText(p, nowMs, tf?)`, `fmtWhen(ms, refMs?, tf?)`) |
| `cameraViewText(cam, tf?)` | `extras/cameras.ts` | accepted; the text has no time |
| `fmtStatusTimeAt(ms, nowMs, tf)` | `ui/shell/dataStatus.ts` | new: `fmtAt(ms, tf, { zone: true, year: 'auto', refMs: nowMs })`; `fmtStatusTime` kept, `@deprecated` |

`EvacuationOfficial.state` (`official/model.ts`) gains `'not-available'` (§14.8.5). M1 renders it as "Evacuation
zones: not available in this state" (card, §14.14 short form, with the reason in `sub`), "Not available in this
state." (compact summary and Official now, no "Cal OES" source tag).

Call sites for `us-web` to pass `tf` (its files; listed in its report): `ui/KeyEvents.tsx` and
`ui/timeline/CompactTimeline.tsx` (`buildFeedItems`), `map/mapController.ts` (`buildFeedItems`, `zoneDetail`,
`cameraViewText`), `location/LocationCard.tsx` (`officialBlock`, `officialFireWeatherNote`), `location/OverviewCard.tsx`
(`officialBlock`).
