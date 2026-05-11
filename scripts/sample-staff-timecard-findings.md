# StaffTimeCardSummary — XLSX shape (captured 2026-05-10)

Telerik report type: `YoureOnTime.Web.TelerikReports.StaffTimeCardSummary, YoureOnTime.Reports`
Sample window: 2026-05-08 → 2026-05-10 (3-day window; smaller window chosen to keep render time under 3 min)
Sheet name: `StaffTimeCard` (**not** `StaffTimeCardSummary`)
Total rows in 3-day pull: 58,850 (26 columns per row)
Raw XLSX size: ~11.5 MB (embedded PNG images per location header inflate the file)

> NOTE ON REPORT SCALE: The full org (all locations) for 3 days produces 58K rows. A full-month pull
> for the default date range (first-of-month → today) timed out on Telerik's side after ~2.5 min of
> polling (~100 polls × 1.5s). Use a per-location strategy or narrow date windows when syncing.
> For the "Late Arrivals" feature, a per-location sync loop is strongly recommended.

---

## Parameter discovery — confirmed parameters

| Parameter | Type | Visibility |
|-----------|------|-----------|
| StartDate | System.DateTime | hidden |
| EndDate | System.DateTime | hidden |
| OrganisationId | System.Int64 | hidden |
| LocationId | System.Int64 | hidden |
| StaffId | System.Int64 | hidden |
| LateArrivals | System.Int64 | hidden |
| EarlyLeavers | System.Int64 | hidden |

> `FranchiseId`, `LateArrivals`, `EarlyLeavers`, `DoNothing` are sent in the parameter discovery
> payload but not returned by the server. They appear to be ignored. `LateArrivals` / `EarlyLeavers`
> may be filter flags — pass `null` (instance params) to get all shifts.

---

## Header / preamble rows (always present)

| Row index | Col[0] value | Purpose |
|-----------|-------------|---------|
| 0 | (empty) | formatting row |
| 1 | "Staff Hours Summary Report" | report title |
| 2 | "Start Date:" | preamble label; col[2] = start date as Excel serial |
| 3 | "End Date:" | preamble label; col[2] = end date as Excel serial |
| 4 | (empty) | separator |

---

## Block structure (repeats for each location → each staff member)

Each location section starts with a **location header row**, then contains one or more staff blocks.
Each staff block repeats the following fixed 4-row preamble before any shift data:

```
[location header row]   col[0] = location name  (e.g. "Auburn Hills MI")
[staff name row]        col[0] = ''  col[1] = staff name  (e.g. "Aishia Adams")
[subheader A row]       col[11] = "Scheduled"  col[19] = "Punctuality (minutes)"
[subheader B row]       (empty — formatting/merge row)
[column header row]     col[0]="Date"  col[2]="Start Time"  col[3]="End Time"
                        col[5]="Hours At Work"  col[6]="Hours Checked"
                        col[8]="Break Time"  col[11]="Work Time"  col[14]="Break Time"
                        col[18]="Arrival"  col[21]="Departure"  col[23]="Hours Under/Over"
[shift data rows...]    one row per shift (see below)
[staff summary row]     col[1] = "N days scheduled, N days worked"  col[12] = total scheduled time
[blank row]             separator before next staff block
```

---

## Shift data row — confirmed column positions

| Col index | Header label | Raw value type | Notes |
|-----------|-------------|---------------|-------|
| [0] | Date | Excel serial number (e.g. `46150`) | 46150 = 2026-05-08 (days since 1899-12-30) |
| [2] | Start Time (actual clock-in) | Excel time fraction (e.g. `1.3618...`) | Integer part is always 1; fractional part × 24 = hour of day. E.g. 1.3618 → 0.3618×24 = 8h41m. |
| [3] | End Time (actual clock-out) | Excel time fraction | Same encoding as col[2] |
| [5] | Hours At Work | Formatted string (e.g. `"08:20"`, `"10:32 (10.53)"`) | Hours:minutes the stylist was physically present; may have decimal in parens |
| [6] | Hours Checked | Formatted string | Same as Hours At Work in most rows observed |
| [8] | Break Time | Numeric (0 or decimal) | Break duration in hours |
| [12] | Scheduled Start | Time string `"HH:MM"` (e.g. `"08:00"`, `"07:30"`) | This is the **scheduled** start, stored as a text string |
| [14] | Scheduled Break | Time string `"HH:MM"` (e.g. `"00:00"`, `"00:30"`) | Scheduled break duration |
| **[19]** | **Punctuality — Arrival (minutes)** | **Integer (minutes late)** | **Positive = arrived late. 0 = on time. No negative values observed (early arrivals not flagged?). THIS IS THE LATE SIGNAL.** |
| [21] | Punctuality — Departure (minutes) | Integer | Positive = left late, negative = left early |
| [23] | Hours Under/Over (minutes) | Integer | Net deviation for the shift in minutes |

> CRITICAL FINDING: The "Arrives" variance is a plain signed integer at col[19], in minutes.
> Positive = late. This is NOT encoded as a font color. No special color treatment is needed for
> the late-arrival signal — just read `row[19]` as a number.

---

## Color encoding notes

The workbook uses styling extensively for the visual report (header colors, alternating rows), but
**none of the data column colors encode the late/early signal**.

Colors observed in the first 20 rows:
- `fgColor=FFFFFFFF fontColor=FF1C3A70` — standard body cells (dark blue text on white)
- `fgColor=FFFFFFFF fontColor=FF004080` — preamble labels ("Start Date:", "End Date:")
- `fgColor=FF004080 fontColor=FFFF0000` — column header row (red text on dark blue fill, styleIdx=9)
- `fgColor=FFE0E0E0 fontColor=FFFFFFFF` — per-staff summary/total row (white text on light grey)
- `fgColor=FFFFFFFF fontColor=FFFFFFFF` — subheader / merged cells (white on white — invisible label rows)

No font or fill color distinguishes a late arrival from an on-time arrival. The `col[19]` integer
value is the sole signal.

---

## Row-type identification (parser guide)

```
row[0] non-empty AND row[1..25] all empty AND row[0] matches known location name → LOCATION HEADER
row[1] non-empty AND row[0] empty AND row[2..25] all empty → STAFF NAME ROW
row[0] == 'Date' → COLUMN HEADER ROW (skip)
row[0] matches /^\d{5}$/ (5-digit Excel serial) → SHIFT DATA ROW
row[1] matches /^\d+ days scheduled/ → STAFF SUMMARY ROW (skip or aggregate)
row[0] empty AND row[11] == 'Scheduled' → SUBHEADER A (skip)
everything else empty → BLANK SEPARATOR (skip)
```

---

## Implication for the adapter and "Late Arrivals" feature

The plan's assumption about column positions (`shiftDate=1, scheduledStart=2, clockIn=3,
arrivedMinutes=4`) does **NOT match reality**. Actual positions from the live report:

| Plan placeholder | Actual column |
|-----------------|--------------|
| shiftDate = col[1] | **col[0]** (Excel serial) |
| scheduledStart = col[2] | **col[12]** (HH:MM text string) |
| clockIn = col[3] | **col[2]** (Excel time fraction) |
| arrivedMinutes = col[4] | **col[19]** (integer minutes, positive = late) |

**The adapter must handle:**
1. Date at col[0] as Excel serial — convert with `epochDate + (serial - 25569) * 86400000`
2. Scheduled start at col[12] as `"HH:MM"` string
3. Clock-in at col[2] as Excel time fraction — `(value % 1) * 24` hours
4. Punctuality at col[19] as plain integer minutes
5. The report is PER-STYLIST, per-shift (not a "summary" in the sense of one row per stylist)
6. Location context must be tracked by scanning for location header rows (col[0] non-empty with known location name)
7. 58K rows for 3 days across all locations — filter by location to keep sync windows manageable

---

## Concerns and recommendations for Task 3

1. **No location-per-stylist column.** Location is identified by scanning preceding header rows.
   The parser must carry a `currentLocation` state variable as it iterates rows.

2. **Excel date/time encoding.** Dates are 5-digit integer serials (offset from 1899-12-30).
   Times are Excel decimal fractions (time of day as fraction of 24 hours, with integer part = 1).
   `adm-zip` delivers these as raw numeric strings — need explicit conversion.

3. **Report scale.** The full-org XLSX for a typical month will be enormous (order of magnitude
   larger than the 3-day 11 MB sample). The adapter should be called per-location using
   `LocationId` in instance params to keep response times under the 5-minute kitchen timeout.

4. **"Punctuality (minutes)" column is col[19] = Arrival only.** Col[21] = Departure, col[23] = net.
   For "Late Arrivals" counting we only need col[19] > 0.

5. **Staff with no clock-in have no shift data row** (only the summary row exists). The summary row
   at col[1] = "N days scheduled, 0 days worked" indicates the stylist was scheduled but didn't
   clock in — these are NOT late arrivals, just absent.

6. **`** OFFICE **` is a special location label** (appears to be a non-location grouping for
   office/admin staff). Should be excluded from the late-arrivals count.
