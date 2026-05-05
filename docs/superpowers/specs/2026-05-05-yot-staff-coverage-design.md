# YOT Staff Coverage & Light-Windows Reporting — Design

**Date:** 2026-05-05
**Repo:** `kitchen-plugin-yot`
**Status:** approved (in chat) — pending written review

## Problem

The YOT plugin currently exposes appointment, client, stylist, and revenue
data, but cannot answer the operational question that drives staffing
decisions:

> *"At which times of day, at which locations, are we short on stylists for
> the customer load — and who can I call to fill the gap?"*

We can compute customer demand from the already-synced `appointments` table,
but we have no insight into rostered shifts or actual time worked. Both are
required to identify "light" coverage windows accurately.

## Goals

1. Per-location, per-day **coverage table** in 30-minute slots, exposing
   customer count, required staff, actually-worked staff, rostered staff,
   and a `light` flag.
2. Per-location **light-windows report** — contiguous slots where
   `actualStylists < requiredStylists`, ranked by deficit.
3. **"Find cover"** query — for a chosen window, list stylists who could
   work it, ranked by qualification and gap fit. Pool includes
   non-rostered staff (i.e., people who aren't scheduled that day at all).
4. **Standalone Coverage tab** in the Kitchen UI as the primary surface.

## Non-goals (YAGNI)

- Auto-assigning staff to gaps. Surface candidates only.
- Notifying suggested staff (push/SMS/email). Out of scope.
- Multi-day rollups, week views, or trend charts. Single-day view in v1.
- HTML scraping of `app.youreontime.com` or session-cookie auth. Will only
  reconsider if Telerik returns "report not found / unauthorized."
- Coverage data for *every* location pre-warmed by sync — only locations
  with active syncs.

## Data sources

| Source | Already wired? | Used for |
|---|---|---|
| `appointments` table (local SQLite) | yes | customer count per slot, who's booked |
| `stylists` table (local SQLite) | yes | stylist names, home location |
| `LocationAvailabilityReport` (new Telerik report) | no | rostered shifts per stylist per day |
| `StaffTimeCardReport` (new Telerik report) | no | actual clock-in/out segments |

Both new reports follow the existing `staff-cashout` pattern. Auth is the
YOT API key passed as the `Key:` parameter in the Telerik discovery
payload — same as the other three reports we already pull. If Telerik
rejects the `reportType` string we guess, we correct it from the error
message it returns (same way the existing reports were originally landed).

### Best-effort report identifiers (refine on first run)

```ts
LOCATION_AVAILABILITY_REPORT = {
  key: 'locationAvailability',
  reportName: 'LocationAvailabilityReport',
  reportType: 'YoureOnTime.Web.TelerikReports.LocationAvailability, YoureOnTime.Reports',
  preferredFormat: 'XLSX',
}

STAFF_TIME_CARD_REPORT = {
  key: 'staffTimeCard',
  reportName: 'StaffTimeCardReport',
  reportType: 'YoureOnTime.Web.TelerikReports.StaffTimeCard, YoureOnTime.Reports',
  preferredFormat: 'XLSX',
}
```

### Discovery parameters (mirroring `buildStaffCashoutParameterDiscovery`)

`LocationAvailability`:
- `LocationId` (required, int)
- `StartDate`, `EndDate` (`YYYY-MM-DD`)
- `OnlyShowWorking` — `'Rostered'` (default) | `'All'`
- `StaffId` (optional, blank = all)
- `OrganisationId`, `FranchiseId` — same passthrough as cashout
- `Key` = `apiKey`

`StaffTimeCard`:
- `LocationId`, `StartDate`, `EndDate`, `StaffId`, `OrganisationId`,
  `FranchiseId`, `Key` (same shape).

## Coverage math

For each location `L`, each date `D`, each 30-minute slot `S`:

```
customerCount(S)     = COUNT(appointments at L, startsAt..endsAt overlaps S)
                       ← from local `appointments` table
requiredStylists(S)  = ceil(customerCount(S) / customersPerStylist)
                       ← customersPerStylist defaults to 10, per-location
                         override stored in YotConfig
actualStylists(S)    = COUNT_DISTINCT(stylists with timecard segment overlapping S)
rosteredStylists(S)  = COUNT_DISTINCT(stylists rostered for S)
light(S)             = actualStylists(S) < requiredStylists(S)
                       ← uses ACTUAL where known; falls back to rostered
                         for future slots not yet clocked
```

### Hybrid actual/rostered for "today"

- Past or current slots (slot end < now): use `actualStylists`. Time-card
  data is post-hoc but available for completed slots.
- Future slots (slot start > now): `actualStylists` is taken as
  `min(rosteredStylists, actualStylists)` — i.e., the prediction is the
  roster, but adjusted downward if anyone has clocked out early.
- The slot table exposes both columns separately so the UI can render
  "expected vs actual" honestly.

## Light-windows derivation

Walk the slot list in chronological order. Group consecutive slots where
`light=true` into a single window:

```ts
{
  startsAt, endsAt,
  durationMinutes,
  customerCount,    // peak across the window
  requiredStylists, // peak across the window
  actualStylists,   // min across the window (worst point)
  deficit,          // requiredStylists - actualStylists
}
```

Sort by `deficit desc, startsAt asc`. The first window is the most
urgent gap.

## "Find cover" query

`GET /coverage/staff-available?locationId=L&from=ISO&to=ISO&serviceMinutes=N&pool=cross|same`

**Pool:**
- `same` — staff with their home location = `L`.
- `cross` (default and recommended) — *every* known stylist, ranked by
  qualification at `L`. **Includes staff not rostered anywhere that day**
  — useful for calling people in on their day off.

**Filtering:**
1. Drop staff with an appointment overlapping `[from, to]` at *any*
   location.
2. Compute `gapStart = max(rosterStart, from)`, `gapEnd = min(rosterEnd, to)`.
   For staff with no roster that day, `gap` is the requested window
   (i.e., they're treated as fully free).
3. If `serviceMinutes` is supplied, drop staff with
   `gapMinutes < serviceMinutes`.

**Returned shape:**

```ts
{
  stylistId, name,
  homeLocationId, homeLocationName,
  qualifiedHere,           // bool: ≥1 past appointment at L OR home is L
  rosteredToday,           // bool: rostered anywhere today
  gapStart, gapEnd, gapMinutes,
  lastWorkedHereAt,        // ISO or null
}
```

**Ranking:** `qualifiedHere desc, rosteredToday desc, gapMinutes desc, lastWorkedHereAt desc`.
Rationale: prefer someone qualified and already on the clock; only suggest
calling someone in on their day off if no rostered staff fits.

## API endpoints

All under `/api/yot/...` via the existing kitchen plugin handler:

- `POST /coverage/sync` — body: `{ locationId, date }`. Pulls the two
  reports for the given day at the given location, populates
  `location_coverage_facts` cache. Idempotent.
- `GET /coverage/slots?locationId=L&date=D` — returns the 30-min slot
  table.
- `GET /coverage/light-windows?locationId=L&from=ISO&to=ISO` — returns
  the deficit-ranked windows. Default `from=today 00:00, to=today 23:59`.
- `GET /coverage/staff-available?locationId=L&from=ISO&to=ISO&serviceMinutes=N&pool=cross|same`
  — returns the candidate pool described above.

All four endpoints are read against `location_coverage_facts`; missing
data triggers an automatic `sync` first if the request is interactive.

## Caching / sync

New table `location_coverage_facts`:

```sql
CREATE TABLE location_coverage_facts (
  team_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  date TEXT NOT NULL,                  -- ISO YYYY-MM-DD
  slot_payload TEXT NOT NULL,          -- JSON: { slots: [...] }
  rostered_payload TEXT NOT NULL,      -- JSON: { rows: [...] } raw report rows
  timecard_payload TEXT NOT NULL,      -- JSON: { rows: [...] } raw report rows
  computed_at TEXT NOT NULL,           -- ISO timestamp of last computation
  customers_per_stylist INTEGER NOT NULL,
  PRIMARY KEY (team_id, location_id, date)
);
```

Raw report rows are kept so we can recompute the slot payload if the math
changes (e.g., user tunes `customersPerStylist`) without re-fetching from
YOT.

**TTL policy:**
- Today: 15 minutes.
- Yesterday or earlier: 24 hours.
- Future dates: 30 minutes (rostered data can change up to the day).

**Background sync** via a new launchd plist
`com.hairmx.yot-coverage-sync.<teamId>.plist`:
- Runs every 15 minutes during business hours (configurable per team,
  default 08:00–20:00 local).
- Iterates locations with active YOT sync, calls `/coverage/sync` for
  today + tomorrow.
- Wraps in `shlock` per the established pattern (see
  `feedback_shlock_launchd_plists` memory).

Manual `[↻ Refresh]` button in the Coverage tab triggers an out-of-cycle
fetch for the selected location+date.

## UI — standalone Coverage tab

New file `src/tabs/coverage.tsx`. Layout:

```
┌─ Coverage ──────────────────────────────────────────────────┐
│ Location [▼]  Date [picker]   [↻ Refresh]                  │
├─────────────────────────────────────────────────────────────┤
│ Slot table (30-min rows)                                    │
│   Time   Required  Actual  Rostered  Customers  Status      │
│   09:00     2        2        3         18      ok          │
│   09:30     3        1        3         25     LIGHT (red)  │
│   ...                                                        │
├─ Light windows ─────────────────────────────────────────────┤
│ 09:30–11:00   needs 3, have 1, deficit 2  [Find cover]      │
│ 14:00–14:30   needs 2, have 1, deficit 1  [Find cover]      │
├─ Find cover (inline panel; appears when button clicked) ────┤
│ Window: 09:30–11:00   Min duration: [60 min]   Pool: [cross▼]│
│   Sarah K.    home: Westside    free 09:00–12:00   ✓ qual  │
│   Mike R.     home: Downtown    free 08:30–11:30   — qual  │
│   Jen L.      home: this loc    free 10:00–11:00   ✓ qual  │
│   Carla M.    home: Eastside    not rostered today ✓ qual  │
└─────────────────────────────────────────────────────────────┘
```

Coverage pane in the locations popup is **not** added — the standalone
tab is the canonical surface.

## Configuration

Stored in YotConfig (existing `plugin_config` table) under a new
`coverage` block:

```json
{
  "coverage": {
    "customersPerStylistDefault": 10,
    "perLocation": {
      "<locationId>": {
        "customersPerStylist": 8
      }
    },
    "businessHours": { "start": "08:00", "end": "20:00" }
  }
}
```

## Files to add (mirrors existing reports pattern)

- `src/reports/reports/location-availability.ts` — Telerik report id +
  param builders + XLSX parser → `LocationAvailabilityResult`.
- `src/reports/reports/staff-time-card.ts` — same shape →
  `StaffTimeCardResult`.
- `src/reports/run-location-availability.ts` — one-shot fetch wrapper.
- `src/reports/run-staff-time-card.ts` — same.
- `src/reports/report-registry.ts` — register both.
- `src/coverage/compute.ts` — slot math + light-window aggregation.
- `src/coverage/find-cover.ts` — staff-available query.
- `src/db/schema.ts` — add `location_coverage_facts` table + migration.
- `src/api/handler.ts` — wire 4 new endpoints under `/coverage/*`.
- `src/tabs/coverage.tsx` — new tab UI.
- `src/index.ts` — register the new tab in the plugin manifest.
- `package.json` `kitchenPlugin.tabs` — add `{ id: 'coverage', label: 'Coverage', icon: 'clock', bundle: './dist/tabs/coverage.js' }`.

Plus a launchd plist template under
`~/.openclaw/workspace-hmx-marketing-team/...` (handled out-of-repo,
referenced in install docs).

## Open risks

1. **Telerik `reportType` strings are guesses.** First call may 404. We
   handle by surfacing the Telerik error to the user and (if needed)
   providing a small `openclaw kitchen plugin yot probe-report` CLI to
   list known report keys. Low blast radius — single error message,
   easy to correct.
2. **`customersPerStylist=10` rule of thumb may not match reality.**
   It's a config knob; can be tuned per location after observing one
   week of data.
3. **Time-card data may lag** (employees may clock in late or stylists
   may not punch out for hours). Hybrid actual/rostered logic above is
   the mitigation; not a blocker.
4. **Cross-location "available" pool needs stylists synced from all
   locations.** If a team only syncs one location, the pool is small.
   Acceptable for v1; documented limitation.

## Acceptance criteria

- [ ] `POST /coverage/sync` for a real location+date populates the
      `location_coverage_facts` row and returns 200.
- [ ] `GET /coverage/slots` returns 30-min slots with all four counts
      and a `light` flag.
- [ ] `GET /coverage/light-windows` returns deficit-ranked windows for
      a known-light day.
- [ ] `GET /coverage/staff-available` ranks rostered-and-qualified
      candidates above non-rostered candidates above unqualified ones.
- [ ] Coverage tab renders the slot table, light-windows list, and
      "Find cover" inline panel for a real location.
- [ ] Background sync plist runs every 15 min during business hours
      and is shlock-guarded.

## Implementation note

Spec only — no code yet. Implementation plan to be drafted via
the `superpowers:writing-plans` skill in a follow-up.
