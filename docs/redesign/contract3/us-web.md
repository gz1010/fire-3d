# us-web: as built (brief 3, wave 1)

Role `us-web` (web: lower-48 overview, fire-local time zones and the mixed clock, national search and coverage, fire
card records, per-region accuracy labels). This note records what was built against CONTRACT §14 and every deviation.
It is kept current at each milestone; the integration folds it into §14 as "as built" sub-headings.

## 14.9 Time zones and the mixed clock (M1)

### 14.9.2 `web/src/lib/time.ts`

Implemented exactly as §14.9.2 (names, signatures, exact strings):
`Clock`, `TimeFmt`, `timeFmt`, `viewerZone`, `isValidZone`, `zoneAbbr`, `zoneName`, `zoneLine`, `WallParts`,
`wallParts`, `zoneOffsetMinutes`, `startOfLocalDay`, `wallTimeToMs`, `localYear`, `localHourTicks`, `localDayTicks`,
`localWallTicks`, `fmtClock`, `fmtAt`, `fmtDayDate`, `fmtDayRange`. The zone-free helpers keep their names.

Details the contract left open:
- `timeFmt(tz, clock)` returns a frozen, shared instance per (zone, clock), so a `TimeFmt` is a stable React
  dependency. A null, empty or unknown zone falls back to `viewerZone()` (never Pacific).
- `fmtAt` and `fmtDayDate` default to `year: 'never'` (so a migrated `fmtDateTime` call keeps today's string);
  `'auto'` adds the year when the local year differs from `refMs`'s (default now); `'always'` always.
- `zoneAbbr` uses Intl `short` (en-US); a zone without an English abbreviation reads "UTC−3" / "UTC+5:30".
- `zoneName` uses Intl `longGeneric`: "Pacific Time", "Mountain Time", "Central Time", "Eastern Time"; Arizona
  (America/Phoenix) reads "Mountain Standard Time" (Intl's own name, correct: no daylight time); UTC zones read
  "Coordinated Universal Time".
- `zoneLine(tf, ms, whose)`: "Times: Mountain Time (MDT), the fire's local time" / "Times: Eastern Time (EST), local
  time at this place" / "Times: your device's time (CDT)".
- `wallTimeToMs(tz, y, mo, d, h, mi)`: candidates from the offsets a day either side plus the offset at each first
  guess (two passes, no fixed offsets); the earliest candidate whose wall clock matches wins (fall-back: the daylight
  instant); none matches inside a spring-forward gap, so it resolves forward (02:30 → 03:30 daylight time), as
  `laWallToMs` did.
- `localWallTicks` labels: 24-hour "06:00", 12-hour "6 AM" / "12 AM" / "12 PM"; the day label "Oct 22" in both.

### 14.9.3 Deprecated names

All 19 kept, marked `@deprecated`, each delegating to the new API with America/Los_Angeles and a 24-hour clock. An
equivalence run (old file from git vs new, Pacific ticks over 4 starts × 4 spans × 7 steps, every formatter every
7 h 13 min through 2025-2026, `laWallToMs` over March and November 2026) gave identical output.

`web/scripts/check-time-api.mjs` (+ `check-time-api.d.mts` for its unit test):
- `--role <label>` expands that role's `owns` (and `owns_bugfix_only`) globs from `plan3-roles.json` with the PLAN-3
  appendix B rules, over the code files under `web/` (`.ts .tsx .mts .mjs .js .jsx`; `node_modules`, `dist` skipped);
  explicit files or directories can be given too; `--quiet` prints only files with a count above 0.
- Parses each file with the TypeScript compiler: counts uses of deprecated names imported from `lib/time` (named,
  renamed, namespace `T.name` and `T.Type`), re-exports of them, never comments, strings or same-named properties.
  Skips `web/src/lib/time.ts`.
- Counts `America/Los_Angeles` in string, template and JSX-text literals of non-test files (`*.test.*`,
  `*.testutil.*` skipped); a line with `// tz-ok: <reason>` is listed with its reason and not counted.
- Prints both counts per file and the totals; exit 1 when either total is above 0 (2 on a usage error).
- Opt-out in use: the checker's own search string (`web/scripts/check-time-api.mjs`, "the checker's own search
  string").

### 14.9.4 `web/src/state/timeZone.ts`

As §14.9.4: `clockFor`, `useClock`, `useTimeFormat`, `useTimeFormatFor`, `useZoneSource`, `getTimeFormat`, plus:
- `usePlaceZone` (zustand: `placeZone`, `setPlaceZone(tz | null)`): the zone of the place the location card shows
  when no fire is open (from `/api/geo/lookup`). `useTimeFormat` uses the open fire's `summary.time_zone`, else this
  place zone, else the viewer's zone; `useZoneSource` reports which ('fire' | 'place' | 'viewer'). This is how the
  'place' value of §14.9.4 is fed.
- `getZoneSource()` (non-hook read), `zoneOf(summary)` (a summary's valid zone or null), `zoneSourceOf(fire, place)`.
- A summary whose `id` differs from the store's `incidentId` (stale during a switch) is ignored.
