# YOT Public Holidays on Staff Coverage Diagrams — Design

**Date:** 2026-05-25
**Status:** Approved (design); pending implementation plan
**Repo:** `kitchen-plugin-yot` (+ dashboard `~/Sites/hmx-dashboard`)

## Problem

Stores close on public holidays, but the staff-coverage diagrams have no notion
of holidays. They show recurring day-of-week closures (`closed`/`closedByDow`,
e.g. Bethel Park closed Sundays) but treat a holiday like any other day —
computing and warning about "understaffed" coverage on dates when nobody is
expected to work.

YOT already holds the source of truth: 17 hand-keyed public holidays (e.g.
"Memorial weekend" 05/23/2026, "Labor- OFF", July 4, Christmas) on its MVC
web-app surface. We will pull these into the plugin and surface a store-closed
indicator on both coverage diagrams.

## Decisions (locked)

1. **Source of truth:** YOT. Pull the existing holidays into our DB; staff keep
   managing them in YOT. We never write holidays back to YOT.
2. **Surface:** both the dashboard diagram (`public/staff-coverage.js`) and the
   kitchen-plugin tab (`src/tabs/coverage.tsx`).
3. **Scope:** holidays are global — a holiday date closes every location. No
   per-location overrides (matches how YOT stores the list).
4. **Behavior:** on a holiday date, render a `CLOSED — <name>` badge, keep the
   location row visible, and suppress under-cover / coverage-gap warnings.

## Architecture (Approach A: DB table + read-time fold into coverage payload)

Holidays sync into a dedicated table. The existing `/coverage/slots` and
`/coverage/history` responses are augmented at **read time** with a `holiday`
field looked up by date — so editing holidays in YOT (after a re-sync) reflects
immediately without re-running the per-(location, date) coverage cache.

```
YOT MVC  ──fetch/parse──>  public_holidays table  ──read-time lookup──>  /coverage/slots
(17 rows)                  (teamId, date, name)                          /coverage/history
                                                                              │
                                                                    holiday: {name} | null
                                                                              │
                                                              dashboard staff-coverage.js
                                                              plugin   coverage.tsx
                                                              (CLOSED badge + suppress warnings)
```

### 1. Fetch + parse (driver layer)

Following the franchises pattern (fetch in the MVC client, parser in a dedicated
`src/coverage/parse-*.ts`):

`src/drivers/yot-mvc-client.ts`:

- `fetchPublicHolidaysHtml(config): Promise<string>` — POSTs
  `/Staff/PublicHolidays/List?PageIndex=N` in a pagination loop (same shape as
  `fetchFranchisesHtml`), joining pages. The `?PageIndex=0` query param is
  **required** — without it the endpoint returns the empty "no items" shell.
`src/coverage/parse-public-holidays-html.ts`:

- `parsePublicHolidaysHtml(html): { holidayId: string; name: string; date: string }[]`
  — extracts each `<li itemId="…"><span class='header'>NAME</span>
  <span class='detail'>MM/DD/YYYY</span></li>` row, HTML-decodes the name
  (e.g. `New Year&#x27;s Day`), and normalizes the date `MM/DD/YYYY → YYYY-MM-DD`.

Fetches are wrapped by callers in `withAutoLogin(..., { looksEmpty: (h) => !/itemId=/i.test(h) })`
so a stale cookie self-heals (per PR #80).

### 2. Schema + migration

New table `public_holidays`:

| column      | type | notes |
|-------------|------|-------|
| `team_id`   | text notNull | |
| `holiday_id`| text notNull | YOT `itemId` |
| `name`      | text notNull | decoded display name |
| `date`      | text notNull | `YYYY-MM-DD` |
| `synced_at` | text notNull | ISO timestamp |

Primary key `(team_id, holiday_id)`. A non-unique index on `(team_id, date)`
for the read-time lookup. Migration added under the existing migrations dir.

### 3. Sync + lookup (`src/coverage/sync-holidays.ts`)

- `syncPublicHolidays({ teamId }): Promise<{ syncedAt: string; count: number }>`
  — reads config, `withAutoLogin(fetchPublicHolidaysHtml, { looksEmpty })`,
  parses, then **replaces** the team's holiday rows in a transaction
  (delete-all-for-team + insert) so removed-in-YOT holidays disappear.
- `holidaysByDate(db, teamId, dates: string[]): Map<string, string>` — date →
  name, one indexed query for the set of dates a coverage response needs.
- `listPublicHolidays(db, teamId, from?, to?)` — for the list endpoint.

### 4. API wiring (`src/api/handler.ts`)

- `POST /public-holidays/sync` → `syncPublicHolidays` (mirrors `/franchises/sync`).
- `GET /public-holidays?from=&to=` → `listPublicHolidays` (mirrors `/franchises`).
- `GET /coverage/slots`: attach `holiday: { name: string } | null` for the
  requested `date` via `holidaysByDate`.
- `GET /coverage/history`: for each date in the week series, if it's a holiday
  set `closed: true` and `holiday: { name }` (the week/drill view then shows the
  closed day too).

The coverage cache (`location_coverage_facts`) is unchanged; holiday is a
read-time overlay.

### 5. UI

Both front-ends read the new `holiday` field. When `row.holiday` (slots) or a
day cell's `holiday` (history) is set:

- Render a `CLOSED — <name>` badge on the location row / day cell.
- Keep the row visible (do **not** filter it out via the inactive-row logic).
- Suppress the under-cover / coverage-gap warnings and the "find cover" affordance
  for that date.

Files: dashboard `public/assets/staff-coverage.js` (+ any markup in
`public/staff-coverage.html`); plugin `src/tabs/coverage.tsx`.

## Testing (TDD)

| Unit | Test |
|------|------|
| `parsePublicHolidaysHtml` | fixture from the real 17-row HTML → correct ids/names/dates; decodes `&#x27;`; normalizes `MM/DD/YYYY`→`YYYY-MM-DD` |
| date normalization | single-digit month/day (e.g. `7/4/2026`) and year rollover |
| `syncPublicHolidays` replace | removed-in-YOT rows are deleted on re-sync |
| `holidaysByDate` | maps only matching dates; empty for non-holiday dates |
| `/coverage/slots` payload | `holiday: {name}` on a holiday date, `null` otherwise |
| `/coverage/history` payload | holiday date → `closed: true` + `holiday` |

UI suppression logic is exercised manually against the live dashboard after the
data layer is green (front-end JS/TSX has no test harness here).

## Out of scope (YAGNI)

- Per-location holiday overrides (some stores open on a holiday).
- Editing / creating holidays from the dashboard (YOT remains the editor).
- Half-day / reduced-hours holidays.
- Standalone holiday calendar views.

## Rollout

1. Land data layer (schema, fetch/parse, sync, lookup, API) with tests.
2. Run `POST /public-holidays/sync` for `hmx-marketing-team` to populate.
3. Wire both UIs; verify against live dashboard on a known holiday
   (e.g. 2026-05-25 Memorial Day) — both diagrams show `CLOSED — Memorial Day`
   with no coverage warnings.
4. Register holiday sync in the existing sync cadence (holidays change rarely;
   a daily/periodic tick is sufficient).
