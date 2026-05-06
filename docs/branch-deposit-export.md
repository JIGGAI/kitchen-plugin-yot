# Branch deposit export workflow

Nightly export script for turning the YOT `StaffCashoutReport` into a Branch-ready CSV.

## What it does

For a target date, the script:

1. Pulls the Telerik `StaffCashoutReport` using the same report client flow used by the other YOT report jobs.
2. Reads the matching date tab from the Google Sheet `Branch Daily Totals`.
3. Matches report staff rows back to Branch rows by name, with a small fuzzy fallback for middle names / nickname-style first names.
4. Exports a CSV with:
   - `STAFF ID`
   - `FIRST NAME`
   - `LAST NAME`
   - `TYPE` (`Deposit`)
   - `AMOUNT` (YOT bank-to-bank amount)
   - `TRANSACTION ID`
   - `LOCATION`
5. Writes a diagnostics JSON beside the CSV so unmatched names and negative/non-positive amounts are visible.

## Command

```bash
cd ~/kitchen-plugin-yot
npm run export:branch-deposits -- --date=2026-05-05
```

## Defaults

- Team: `hmx-marketing-team`
- Organisation: `11082`
- Google account: `govna.assistant@gmail.com`
- Branch sheet: `1jIFWOMmvMVbGULUbDpEqV2e6CsXy_DzhBrCorV9H-EA`
- Output dir: `/Users/hairmx/hmx-reports`

## Output files

For `--date=2026-05-05` the script writes:

- `/Users/hairmx/hmx-reports/branch-deposits-2026-05-05.csv`
- `/Users/hairmx/hmx-reports/branch-deposits-2026-05-05.diagnostics.json`

## Notes

- Rows with zero/negative bank-to-bank amounts are excluded from the CSV and listed in diagnostics.
- If the Branch sheet already contains duplicate placeholders for the same staff/location, the script keeps the strongest row and drops weaker duplicates.
- Weekend / multi-day sheet tabs like `5/2-3/26` are supported.
