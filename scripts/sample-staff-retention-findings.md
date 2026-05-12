# StaffRetentionDay — XLSX shape (captured 2026-05-11)

Telerik report type: `YoureOnTime.Web.TelerikReports.StaffRetentionDay, YoureOnTime.Reports`
Sample window: 2026-05-04 → 2026-05-10 (1 week)
Sheet name: `Retention`
Rows in sample: ~362 (many trailing blank rows; 26 columns per row)
Raw XLSX size: ~130 KB (each location header carries an embedded PNG location icon → 268 inline images)

---

## Parameter discovery — confirmed parameters

| Parameter | Type | Visibility |
|-----------|------|-----------|
| StartDate | System.DateTime | hidden |
| EndDate | System.DateTime | hidden |
| OrganisationId | System.Int64 | hidden |
| LocationId | System.Int64 | hidden |
| StaffId | System.Int64 | hidden |
| FranchiseId | System.Int64 | hidden |

`DoNothing` is sent in the parameter discovery payload but not returned by the server. Pass `null` for
location / staff / franchise filters to get the full org pull.

---

## Header / preamble rows

| Row | Col | Value | Notes |
|-----|-----|-------|-------|
| r0  | [0] | `Staff Retention Report` | title |
| r1  | [0] | `Start Date:` | preamble label |
| r2  | [3] | `46146` (Excel serial) | start date numeric |
| r3  | [0] | `End Date:` | preamble label |
| r4  | [21] | `Previous Staff Retention` | merged group header (covers r7 cols 19/22/24) |
| r5  | [3] | `46152.99998842592` | end date numeric (end-of-day) |
| r7  | [2] | `Staff` | column header |
| r7  | [19] | `Apr-26` | trailing-month-1 label |
| r7  | [22] | `Mar-26` | trailing-month-2 label |
| r7  | [24] | `Feb-26` | trailing-month-3 label |
| r8  | [9]  | `Total\nSales` | embedded newline |
| r8  | [11] | `Returned To Staff` |  |
| r8  | [12] | `Returned To Business` |  |
| r8  | [14] | `New\nClients` | embedded newline |
| r8  | [15] | `Total Rebooked` |  |
| r8  | [17] | `New Clients Rebooked` |  |

The trailing-month labels (`Apr-26`, `Mar-26`, `Feb-26`) are derived from the start of the window and
shift one position to the right of the data columns they label (merged cells; data is at cols 19/23/25).

---

## Block structure (repeats per location)

Each location group has:

1. **Location header row** — `col[1]` = location name, all other cols empty.
2. **Per-staff data rows** — `col[2]` = staff name, data at fixed columns (see below).
3. **Location subtotal row** — `col[1]` = `Total`, data summed across the location's staff.
4. **Blank separator row(s)**.

The very last subtotal in the workbook has `col[0]` = `Grand Total` — an org-wide rollup.

### Per-staff data columns

| Col | Field | Example value | Notes |
|-----|-------|--------------|-------|
| 2  | staffName | `Allison Indra` | spaces in real names preserved |
| 10 | totalSales | `38` | integer count |
| 11 | returnedToStaff | `13 (34%)` | count followed by `(N%)` |
| 12 | returnedToBusiness | `24 (63%)` |  |
| 14 | newClients | `1 (3%)` |  |
| 15 | totalRebooked | `6 (16%)` |  |
| 17 | newClientsRebooked | `0 (0%)` |  |
| 19 | retention1MonthBack | `33 (17%)` | maps to r7 col[19] month label |
| 23 | retention2MonthsBack | `107 (57%)` | r7 label is at col[22] |
| 25 | retention3MonthsBack | `133 (81%)` | r7 label is at col[24] |

The count/percent string is parsed by splitting on the open paren: `count` is the leading integer,
`percent` is the integer before `%` inside the parens. When a stylist has zero qualifying clients,
YOT writes `0 (0%)` (not blank).

---

## Metric definitions (from the report's footer glossary)

| Metric | Meaning |
|--------|--------|
| Total Sales | Number of sales performed by the staff in the window |
| Returned To Staff | Client's previous visit was with this same staff member (staff loyalty) |
| Returned To Business | Client's previous visit was at the business but with a different staff member |
| New Clients | First-time client (no prior visits) |
| Total Rebooked | Clients who rebooked another appointment from this visit |
| New Clients Rebooked | Subset of New Clients who rebooked |
| Previous Staff Retention | For each trailing month label, count + % of clients seen back at this same staff in the current window |

---

## Parsing notes

* `Grand Total` row should be captured separately and treated as an org-wide rollup, not a per-location subtotal.
* Skip rows where col[0]–col[25] are all empty.
* The fixture's "Today"-only pull was empty in the data area (header/preamble only). Always use a
  multi-day window for testing.
