// YoureOnTime MonthlyPerformanceSummary report adapter.
//
// Telerik report type:
//   "YoureOnTime.Web.TelerikReports.MonthlyPerformanceSummary, YoureOnTime.Reports"
//
// Sheet name "MonthlyPerformanceSummary". 33-column workbook. Header lives
// across rows 4-6 (split labels + sublabels). Data rows are positioned by
// fixed column index (slightly off from header positions due to merged cells
// in the Telerik layout — column positions verified by sum-checks against
// Grand Total row). For each location:
//   <Location Name>
//   <Month label e.g. "May 2026"> — one detail row per month in range
//   ...
//   "Total"   — per-location aggregate (empty when range has 1 month)
// Final row: "Grand Total" across all locations.
//
// Data column positions:
//   [1]  Month label (e.g. "May 2026") / "Total" / "Grand Total"
//   [7]  Appointments
//   [8]  Cancelled
//   [9]  No Shows
//   [10] Online Bookings
//   [11] New Clients
//   [13] Total Clients
//   [14] # of Sales
//   [15] Sales per Day
//   [19] # of Vouchers
//   [21] Product Sales Value
//   [23] Service Sales Value
//   [26] Total Sales
//   [28] Last Year Comparison ($ amount, prior-year same period)
//   [32] Last Year Comparison (% string e.g. "(-43%)")

import type { ReportDocumentFormat, ReportParameterDefinition } from '../client';
import { readWorkbook } from '../xlsx';

export const MONTHLY_PERFORMANCE_SUMMARY_REPORT = {
  key: 'monthlyPerformanceSummary',
  reportName: 'MonthlySalesSummaryReport',
  reportType: 'YoureOnTime.Web.TelerikReports.MonthlyPerformanceSummary, YoureOnTime.Reports',
  preferredFormat: 'XLSX' as ReportDocumentFormat,
};

export type MonthlyPerformanceSummaryParams = {
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  staffId?: number | null;
};

export type MonthlyPerformanceSummaryRow = {
  locationName: string | null;
  rowKind: 'monthDetail' | 'locationTotal' | 'grandTotal';
  /** Month label as it appears (e.g. "May 2026"); null for aggregate rows. */
  monthLabel: string | null;
  appointments: number | null;
  cancelled: number | null;
  noShows: number | null;
  onlineBookings: number | null;
  newClients: number | null;
  totalClients: number | null;
  salesCount: number | null;
  salesPerDay: number | null;
  voucherCount: number | null;
  productSales: number | null;
  serviceSales: number | null;
  totalSales: number | null;
  yoyAmount: number | null;
  /** Parsed from "(-43%)" → -43 (number). Null if absent. */
  yoyPct: number | null;
  raw: unknown[];
};

export type MonthlyPerformanceSummaryResult = {
  sheetName: string | null;
  parameters: Array<{ name: string; type: string; isVisible: boolean; value: unknown }>;
  locations: string[];
  rows: MonthlyPerformanceSummaryRow[];
};

const COL = {
  monthLabel: 1,
  appointments: 7,
  cancelled: 8,
  noShows: 9,
  onlineBookings: 10,
  newClients: 11,
  totalClients: 13,
  salesCount: 14,
  salesPerDay: 15,
  voucherCount: 19,
  productSales: 21,
  serviceSales: 23,
  totalSales: 26,
  yoyAmount: 28,
  yoyPct: 32,
} as const;

function parseNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const n = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// "(-43%)" or "(50%)" → -43 / 50. Returns null on missing/unparseable.
function parsePctParens(value: unknown): number | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const m = text.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const sign = text.includes('-') ? -1 : 1;
  const n = Number(m[0]);
  if (!Number.isFinite(n)) return null;
  return sign * Math.abs(n);
}

function valueAt(row: unknown[], idx: number): number | null {
  return parseNumber(row[idx]);
}

const MONTH_LABEL_RE = /^[A-Z][a-z]+ \d{4}$/; // "May 2026"

export function buildMonthlyPerformanceSummaryParameterDiscovery(
  params: MonthlyPerformanceSummaryParams,
  apiKey: string,
): Record<string, string> {
  return {
    DateRange: 'Custom',
    StartDate: params.startDateIso.replace('.000Z', ''),
    EndDate: params.endDateIso.replace('.000Z', ''),
    FranchiseId: '',
    LocationId: params.locationId == null ? '' : String(params.locationId),
    StaffId: params.staffId == null ? '' : String(params.staffId),
    DoNothing: '',
    Title: 'Monthly Sales Summary Report',
    ReportName: MONTHLY_PERFORMANCE_SUMMARY_REPORT.reportName,
    FrameView: 'True',
    OrganisationId: String(params.organisationId),
    ReportClass: 'MonthlyPerformanceSummary',
    Key: apiKey,
  };
}

export function buildMonthlyPerformanceSummaryInstanceParams(
  params: MonthlyPerformanceSummaryParams,
): Record<string, string | number | null> {
  return {
    StartDate: params.startDateIso.replace('.000Z', ''),
    EndDate: params.endDateIso.replace('.000Z', ''),
    OrganisationId: params.organisationId,
    LocationId: params.locationId ?? null,
    StaffId: params.staffId ?? null,
    PaymentGroupId: null,
    PaymentTypeId: null,
    FranchiseId: null,
  };
}

export function parseMonthlyPerformanceSummaryWorkbook(
  buffer: Buffer,
  parameterDefinitions: ReportParameterDefinition[] = [],
): MonthlyPerformanceSummaryResult {
  const sheets = readWorkbook(buffer);
  const sheet = sheets.find((s) => s.name === 'MonthlyPerformanceSummary') || sheets[0] || null;
  if (!sheet) {
    return { sheetName: null, parameters: [], locations: [], rows: [] };
  }

  const rows: MonthlyPerformanceSummaryRow[] = [];
  const locations: string[] = [];
  let currentLocation: string | null = null;

  for (const row of sheet.rows) {
    const colA = String(row[1] ?? '').trim();
    if (!colA) continue;

    // Header / footer rows we ignore.
    if (colA === 'Monthly Performance Summary Report') continue;
    if (colA === 'Start Date:' || colA === 'End Date:') continue;
    if (colA === 'Month Starting') continue;

    const numeric = {
      appointments: valueAt(row, COL.appointments),
      cancelled: valueAt(row, COL.cancelled),
      noShows: valueAt(row, COL.noShows),
      onlineBookings: valueAt(row, COL.onlineBookings),
      newClients: valueAt(row, COL.newClients),
      totalClients: valueAt(row, COL.totalClients),
      salesCount: valueAt(row, COL.salesCount),
      salesPerDay: valueAt(row, COL.salesPerDay),
      voucherCount: valueAt(row, COL.voucherCount),
      productSales: valueAt(row, COL.productSales),
      serviceSales: valueAt(row, COL.serviceSales),
      totalSales: valueAt(row, COL.totalSales),
      yoyAmount: valueAt(row, COL.yoyAmount),
      yoyPct: parsePctParens(row[COL.yoyPct]),
    };
    const hasNumericData = Object.values(numeric).some((v) => v != null);

    if (colA === 'Grand Total') {
      rows.push({ locationName: null, rowKind: 'grandTotal', monthLabel: null, ...numeric, raw: row });
      currentLocation = null;
      continue;
    }
    if (colA === 'Total') {
      // Per-location total. Often empty when the range is a single month
      // (because the single month-detail row already carries the same numbers).
      if (currentLocation && hasNumericData) {
        rows.push({ locationName: currentLocation, rowKind: 'locationTotal', monthLabel: null, ...numeric, raw: row });
      }
      continue;
    }
    if (MONTH_LABEL_RE.test(colA)) {
      if (currentLocation && hasNumericData) {
        rows.push({ locationName: currentLocation, rowKind: 'monthDetail', monthLabel: colA, ...numeric, raw: row });
      }
      continue;
    }
    // Otherwise: it's a location name (alpha label, no numeric data).
    if (!hasNumericData && /[A-Za-z]/.test(colA)) {
      currentLocation = colA;
      if (!locations.includes(colA)) locations.push(colA);
    }
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
