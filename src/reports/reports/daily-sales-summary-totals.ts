// YoureOnTime DailySalesSummaryTotals report adapter.
//
// Distinct from DailySalesSummary — emits per-location totals over the
// requested date range (one "Totals" row per location, plus a grand-total
// row at the end). Telerik report type:
//   "YoureOnTime.Web.TelerikReports.DailySalesSummaryTotals, YoureOnTime.Reports"
//
// XLSX shape (sheet name "DailySalesSummary"):
//   row 0:  title
//   row 1:  Start Date
//   row 2:  End Date
//   row 3:  blank
//   row 4:  column headers
//   then for each location:
//     <Location Name>
//     <Month label>     (one detail row per month in range)
//     ...
//     "Totals"          (per-location overall total)
//   final row: "Totals" (grand total across all locations)
//
// Data column positions (1 cell offset from header for Cash Sales due to
// merged-cell layout — confirmed by sum-check Cash+CC+Voucher+Other = Total):
//   [0]  Location label / "Totals" / month label
//   [4]  Cash Sales
//   [5]  Credit Card Sales
//   [6]  Voucher Sales
//   [7]  Other Sales
//   [9]  Total Sales
//   [11] Credit Card Tips
//   [12] Other Tips
//   [14] Number of Sales
//   [15] Service per Sale
//   [16] Avg Sale Value
//   [17] Comm. Total
//   [18] Comm. Net
//   [19] Gross Income
//   [20] % Cost of Sale (fraction, e.g. 0.5246 = 52.46%)

import type { ReportDocumentFormat, ReportParameterDefinition } from '../client';
import { readWorkbook } from '../xlsx';

export const DAILY_SALES_SUMMARY_TOTALS_REPORT = {
  key: 'dailySalesSummaryTotals',
  reportName: 'DailySalesSummaryTotalsReport',
  reportType: 'YoureOnTime.Web.TelerikReports.DailySalesSummaryTotals, YoureOnTime.Reports',
  preferredFormat: 'XLSX' as ReportDocumentFormat,
};

export type DailySalesSummaryTotalsParams = {
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  staffId?: number | null;
  dayOfWeek?: number | null;
};

export type DailySalesSummaryTotalsRow = {
  locationName: string | null;
  rowKind: 'locationTotal' | 'grandTotal';
  cashSales: number | null;
  creditCardSales: number | null;
  voucherSales: number | null;
  otherSales: number | null;
  totalSales: number | null;
  creditCardTips: number | null;
  otherTips: number | null;
  numberOfSales: number | null;
  servicesPerSale: number | null;
  avgSaleValue: number | null;
  commissionTotal: number | null;
  commissionNet: number | null;
  grossIncome: number | null;
  pctCostOfSale: number | null;
  raw: unknown[];
};

export type DailySalesSummaryTotalsResult = {
  sheetName: string | null;
  parameters: Array<{ name: string; type: string; isVisible: boolean; value: unknown }>;
  locations: string[];
  rows: DailySalesSummaryTotalsRow[];
};

const COL = {
  cashSales: 4,
  creditCardSales: 5,
  voucherSales: 6,
  otherSales: 7,
  totalSales: 9,
  creditCardTips: 11,
  otherTips: 12,
  numberOfSales: 14,
  servicesPerSale: 15,
  avgSaleValue: 16,
  commissionTotal: 17,
  commissionNet: 18,
  grossIncome: 19,
  pctCostOfSale: 20,
} as const;

function parseNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const n = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function valueAt(row: unknown[], idx: number): number | null {
  return parseNumber(row[idx]);
}

export function buildDailySalesSummaryTotalsParameterDiscovery(
  params: DailySalesSummaryTotalsParams,
  apiKey: string,
): Record<string, string> {
  return {
    DateRange: 'Custom',
    StartDate: params.startDateIso.replace('.000Z', ''),
    EndDate: params.endDateIso.replace('.000Z', ''),
    FranchiseId: '',
    LocationId: params.locationId == null ? '' : String(params.locationId),
    DoNothing: '',
    Title: 'Daily Sales Summary Totals Report',
    ReportName: DAILY_SALES_SUMMARY_TOTALS_REPORT.reportName,
    FrameView: 'True',
    OrganisationId: String(params.organisationId),
    ReportClass: 'DailySalesSummaryTotals',
    Key: apiKey,
  };
}

export function buildDailySalesSummaryTotalsInstanceParams(
  params: DailySalesSummaryTotalsParams,
): Record<string, string | number | null> {
  return {
    StartDate: params.startDateIso.replace('.000Z', ''),
    EndDate: params.endDateIso.replace('.000Z', ''),
    OrganisationId: params.organisationId,
    LocationId: params.locationId ?? null,
    StaffId: params.staffId ?? null,
    DayOfWeek: params.dayOfWeek ?? null,
    FranchiseId: null,
  };
}

export function parseDailySalesSummaryTotalsWorkbook(
  buffer: Buffer,
  parameterDefinitions: ReportParameterDefinition[] = [],
): DailySalesSummaryTotalsResult {
  const sheets = readWorkbook(buffer);
  const sheet = sheets.find((s) => s.name === 'DailySalesSummary') || sheets[0] || null;
  if (!sheet) {
    return { sheetName: null, parameters: [], locations: [], rows: [] };
  }

  // Walk rows. Track currentLocation. When we hit "Totals" with currentLocation
  // set, emit a per-location totals row and clear currentLocation. The final
  // unattributed "Totals" is the grand total.
  const rows: DailySalesSummaryTotalsRow[] = [];
  const locations: string[] = [];
  let currentLocation: string | null = null;

  for (const row of sheet.rows) {
    const first = String(row[0] ?? '').trim();
    if (!first) continue;

    // Skip the title and date-range header rows.
    if (first === 'Daily Sales Summary Totals Report') continue;
    if (first === 'Start Date:' || first === 'End Date:') continue;

    if (first === 'Totals') {
      const numeric = {
        cashSales: valueAt(row, COL.cashSales),
        creditCardSales: valueAt(row, COL.creditCardSales),
        voucherSales: valueAt(row, COL.voucherSales),
        otherSales: valueAt(row, COL.otherSales),
        totalSales: valueAt(row, COL.totalSales),
        creditCardTips: valueAt(row, COL.creditCardTips),
        otherTips: valueAt(row, COL.otherTips),
        numberOfSales: valueAt(row, COL.numberOfSales),
        servicesPerSale: valueAt(row, COL.servicesPerSale),
        avgSaleValue: valueAt(row, COL.avgSaleValue),
        commissionTotal: valueAt(row, COL.commissionTotal),
        commissionNet: valueAt(row, COL.commissionNet),
        grossIncome: valueAt(row, COL.grossIncome),
        pctCostOfSale: valueAt(row, COL.pctCostOfSale),
      };
      if (currentLocation) {
        rows.push({ locationName: currentLocation, rowKind: 'locationTotal', ...numeric, raw: row });
        currentLocation = null;
      } else {
        rows.push({ locationName: null, rowKind: 'grandTotal', ...numeric, raw: row });
      }
      continue;
    }

    // Month-label rows (e.g. "May 2026") have numeric data in the same columns
    // but live between the location label and the per-location Totals row. We
    // skip them — only Totals rows are persisted.
    const hasNumericData = row.slice(1).some((v) => parseNumber(v) != null);
    if (!hasNumericData && /[A-Za-z]/.test(first)) {
      currentLocation = first;
      if (!locations.includes(first)) locations.push(first);
    }
    // Otherwise: month detail row (numeric data, label like "May 2026") — skip.
  }

  return {
    sheetName: sheet.name,
    parameters: parameterDefinitions.map((p) => ({
      name: p.name,
      type: p.type,
      isVisible: p.isVisible,
      value: p.value,
    })),
    locations,
    rows,
  };
}
