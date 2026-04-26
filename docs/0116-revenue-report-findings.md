# 0116 Revenue Report Findings

Live characterization of the You're On Time Telerik reports service for ticket 0116 (revenue analytics), run against Hair Mechanix marketing-team credentials from the Mac Studio host on 2026-04-26.

## Executive summary

- **Revenue is available through the Telerik reports service**, not the legacy `api2.youreontime.com/1/api` endpoints.
- The working service base is:
  - `https://youreontime-reports.azurewebsites.net/api/reports`
- The service uses **ephemeral report clients**. A client id must be created first via:
  - `POST /api/reports/clients`
- The first landed report adapter is:
  - report name: `DailyRevenueSummaryReport`
  - report type: `YoureOnTime.Web.TelerikReports.DailyRevenueSummary, YoureOnTime.Reports`
- **XLSX is the preferred ingestion format.** CSV is a flattened rendered export; XLSX preserves a usable worksheet structure.

## Working flow

1. `POST /api/reports/clients`
   - returns `{ "clientId": "..." }`
2. `POST /api/reports/clients/{clientId}/parameters`
   - parameter discovery succeeds for `DailyRevenueSummaryReport`
3. `POST /api/reports/clients/{clientId}/instances`
   - returns `{ "instanceId": "..." }`
4. `POST /api/reports/clients/{clientId}/instances/{instanceId}/documents`
   - with `{ "format": "XLSX" }`
   - returns `{ "documentId": "..." }`
5. `GET /api/reports/clients/{clientId}/instances/{instanceId}/documents/{documentId}/info`
   - poll until `documentReady: true`
6. `GET /api/reports/clients/{clientId}/instances/{instanceId}/documents/{documentId}`
   - fetch workbook bytes

## Workbook shape

The landed adapter parses sheet `DailySalesSummary`.

Header row:

- `Date`
- `Cash Payments`
- `Card Payments`
- `Voucher Payments`
- `Other Payments`
- `Account Payments`
- `Total Payments`
- `Service Sales`
- `Product Sales`
- `Voucher Sales`
- `Membership Sales`
- `No Sale / Cash Out`
- `Total Cash on Hand`
- `Total Revenue`
- `Taxable Revenue`
- `Revenue Less Tax`

The worksheet is organized as repeated **location blocks**:

- location name row
- daily detail rows
- `Averages` row
- `Total` row

## Characterized sample window

Using:

- start: `2026-04-26T00:00:00.000Z`
- end: `2026-05-02T00:00:00.000Z`
- organisation: `11082`

The parser returned:

- sheet name: `DailySalesSummary`
- locations: `29`
- detail rows: `203`
- total rows: `30`

Representative parsed detail row (`Auburn Hills MI`, `26/4/2026`):

- cashPayments: `154.5`
- cardPayments: `1022.43`
- voucherPayments: `47`
- totalPayments: `1223.93`
- serviceSales: `1156`
- productSales: `67.93`
- totalCashOnHand: `154.5`
- totalRevenue: `1223.93`
- taxableRevenue: `1223.93`
- revenueLessTax: `1221.52`

## Landed code

- `src/reports/client.ts`
  - generic Telerik reports client
  - dynamic `clientId` acquisition via `POST /clients`
- `src/reports/xlsx.ts`
  - generic XLSX workbook reader for report adapters
- `src/reports/report-registry.ts`
  - report registry for plug-in adapters
- `src/reports/reports/daily-revenue-summary.ts`
  - first report adapter
- `scripts/characterize-revenue-reports.ts`
  - end-to-end characterization harness using the generic framework

## Recommended next slice

Use the `DailyRevenueSummaryReport` adapter to write normalized rows into `revenue_facts` (and any richer downstream revenue tables we add later), keyed by:

- `team_id`
- `location_id`
- `date`

with parsed values for:

- payments (cash/card/voucher/other/account/total)
- sales (service/product/voucher/membership)
- cash handling
- total/taxable/net-of-tax revenue
