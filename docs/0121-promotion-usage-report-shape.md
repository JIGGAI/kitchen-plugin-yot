# 0121 — Promotion Usage report characterization

This slice uses the Telerik report service as the source of truth for the
Promotion tab, matching the revenue path.

## Probe artifact

Use:

```sh
node_modules/.bin/esbuild scripts/characterize-promotion-usage-report.ts \
  --bundle --platform=node --format=cjs \
  --outfile=/tmp/characterize-promotion-usage-report.js \
  --external:better-sqlite3 --external:adm-zip

NODE_PATH="$PWD/node_modules" \
  node /tmp/characterize-promotion-usage-report.js \
  > /tmp/promotion-usage-report.json
```

The script reads the local YOT config from
`~/.openclaw/kitchen/plugins/yot/yot-hmx-marketing-team.db`, fetches
parameter definitions and a workbook, then prints:

- resolved parameter definitions
- workbook header row
- normalized parsed sample rows
- request log metadata

## Expected request contract

Parameter discovery is built from the report page fields already identified:

- `DateRange=Custom`
- `StartDate`
- `EndDate`
- `StaffId`
- `LocationId` (`0` when no location filter is applied)
- `ReportName=PromotionUsageReport`

The confirmed report type string is:

`YoureOnTime.Web.TelerikReports.PromotionsUsed, YoureOnTime.Reports`

## Parser contract

The live workbook was fetched after the correct Telerik class was identified.
The first sheet is `PromotionsUsed` and the effective detail/header rows are:

- row 4: super-header with values like `Ex-Tax Total` and `Average Discount %`
- row 5: actual detail header with values including `Name`, `Code`, `SubTotal`, `Total`, `Available`, `Used`

The worksheet is organized as repeated location blocks:

- blank spacer rows
- one row whose `Name` cell is the location name
- one or more promotion rows for that location

Important implication: **the report does not include a per-row date column**.
So the promotion sync treats each report execution window as the date bucket.
To produce daily location usage, the sync runs the report one day at a time and
assigns that requested day to all rows returned for that run.

The parser now maps:

- promotion name: `Name` (plus tolerant aliases)
- promotion code: `Code`
- usage count: `Used`
- discount amount: `Ex-Tax Total`
- optional extra metrics: `SubTotal`, `Total`, `Average Discount %`, `Available`

## Follow-up

If we later want richer promotion analytics, we can expose the extra parsed
metrics in the UI. The core operator view only needs unique promotions plus
per-day/per-location usage counts.
