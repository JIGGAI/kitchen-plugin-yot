# Surface scheduled-but-absent stylists in Staff Coverage

**Date:** 2026-05-27
**Repos:** `kitchen-plugin-yot` (parser + endpoint), `hmx-dashboard` (UI)

## Problem

The Staff Coverage day-schedule grid lists the stylists working a given day.
A stylist marked with a roster exception (e.g. "Sick", "No Show") silently
disappears from the list, so managers can't see who was expected but is out.

**Root cause.** YOT's `LocationAvailability` grid renders an exception cell as:

```html
<a class="change_staff_day_schedule" ... data-name="Josh Christen (Artist)"
   data-day="27" data-month="5" data-year="2026"><span style='color:red'>Sick</span></a>
```

There is no shift time — just a red `<span>` carrying a **free-text reason**.
Observed reasons for one stylist in a single week: `Memorial weekend`,
`Memorial Day`, `No Show`, `Sick`. The parser (`parse-roster-html.ts`) only
special-cases the literal word "Holiday"; every other reason falls through to
`not-scheduled`. The `/coverage/day-schedule` endpoint then renders only
`status === 'scheduled'` rows, so absent stylists are dropped.

## Goal

Show a scheduled-but-absent stylist as an **inline row with a red badge**
(the actual reason text — "Sick", "No Show"), while:

- keeping **store-wide holiday/closure** labels (Memorial Day, etc.) treated as
  closures, not per-person absences;
- never counting an absent stylist toward coverage / availability.

## Design

### 1. Parser — `src/coverage/parse-roster-html.ts`

- Extend `RosterStatus` with `'absent'`; add optional `reason?: string` to
  `RosterEntry`.
- Classification order in `classifyAndExtract`:
  1. Time range present → `scheduled` (unchanged).
  2. Red-span / non-time text matching a **closure keyword list**
     (`holiday`, `memorial`, `christmas`, `thanksgiving`, `new year`,
     `labor day`, `independence`, `closed`, …, case-insensitive) → `holiday`
     (preserves today's behavior; "Holiday" still classifies as holiday).
  3. Any other non-empty reason text (after stripping tags) that isn't
     "Not Scheduled" → `'absent'` with `reason` = the trimmed reason text.
  4. Otherwise ("Not Scheduled" / empty) → `not-scheduled` (unchanged).
- Reasons are free-text, so closure detection is keyword-driven. The keyword
  list lives as a module constant and is easy to extend. (Future option, out
  of scope: cross-check the `public_holidays` table by date instead of
  keywords.)

### 2. Endpoint — `/coverage/day-schedule` in `src/api/handler.ts`

- After building scheduled + off-roster stylist rows, collect roster rows with
  `status === 'absent'`.
- Emit each unique absent stylist (deduped against scheduled IDs and
  off-roster appointment IDs) as a `StylistRow`:
  `{ stylistId, fullName, shiftStartAt: null, shiftEndAt: null, onRoster: false,
  absent: true, absenceReason }`.
- Sort absent rows to the bottom of the `stylists` array.
- `scheduledRosterRows`, `businessStart/End`, and all coverage math are
  untouched. The averaging consumer in `sync.ts` only checks
  `status === 'scheduled'`, so the new status is additive.

### 3. UI — `renderScheduleGrid` in `public/assets/staff-coverage.js`

- Single renderer; also powers the daily drill-down modal, so both surfaces
  get the change for free.
- For a row with `absent === true`: render no shift band; show a red badge
  with the reason text (`absenceReason`) where the shift time normally appears;
  style the row using the existing off-roster treatment
  (`schedule-row-off-roster`) plus an absence modifier.
- Add minimal CSS for the badge (in `staff-coverage.css` or inline class).
- Bump the `?v=` query on the changed JS/CSS in `staff-coverage.html`.

### 4. Backfill

Existing `rostered_payload` rows store these as `not-scheduled` with no reason.
After deploying the parser change, re-run the coverage sync for the current
window (`yot-coverage-sync.sh`, or POST `/coverage/sync` per location/day) so
today reclassifies. The nightly cron (`com.hairmx.yot-coverage-sync…plist`)
covers future days automatically.

## Testing

- `parse-roster-html.test.ts`: add cases for `<span style='color:red'>Sick</span>`
  and `No Show` → `absent` + correct `reason`; `Memorial Day` / `Holiday` →
  `holiday`; `Not Scheduled` → `not-scheduled` (regression).
- Endpoint: an absent roster row appears in `stylists` with `absent:true` and
  the reason, and is absent from any coverage count.
- Manual: Centerville OH, 2026-05-27 — Josh Christen renders as an inline
  "Sick" row after re-sync.

## Out of scope (YAGNI)

- No invented "supposed-to-work hours" for absent stylists (YOT replaces the
  shift time with the reason; those hours aren't available anyway).
- No changes to coverage thresholds, the find-cover modal, the weekly grid, or
  notifications.
