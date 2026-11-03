// YoureOnTime MonthlyPerformanceSummary report adapter.
//
// Telerik report type:
//   "YoureOnTime.Web.TelerikReports.MonthlyPerformanceSummary, YoureOnTime.Reports"
//
// Sheet name "MonthlyPerformanceSummary". Header lives across several rows
// (split labels + sublabels). Telerik has changed the workbook width over time,
// so data columns are resolved from those labels rather than assumed to live at
// one permanent index. Some labels sit over decorative spacer columns; the
// resolver accounts for those stable offsets. For each location:
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

type MonthlyPerformanceColumns = { [Key in keyof typeof COL]: number };

function normalizeHeader(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findHeaderColumn(rows: unknown[][], label: string): number | null {
  const wanted = normalizeHeader(label);
  for (const row of rows) {
    const index = row.findIndex((value) => normalizeHeader(value) === wanted);
    if (index >= 0) return index;
  }
  return null;
}

/**
 * Resolve the numeric data columns from the workbook's visible headers.
 *
 * The Telerik export uses blank/decorative cells inside several metric groups,
 * so not every number lands in the same cell as its label. Deriving each index
 * from the nearest named header keeps both the legacy 33-column layout and the
 * current 35-column layout working when a group is inserted or removed.
 */
export function resolveMonthlyPerformanceColumns(rows: unknown[][]): MonthlyPerformanceColumns {
  const header = (label: string, fallback: number) => findHeaderColumn(rows, label) ?? fallback;
  const cancelled = header('Cancelled', COL.cancelled);
  const salesPerDayLabel = header('Sales per Day', COL.salesPerDay + 1);
  const serviceSalesLabel = header('Service Sales Value', COL.serviceSales + 2);
  const totalSalesLabel = header('Total Sales', COL.totalSales + 1);
  const comparisonLabel = header('Last Year Comparison', COL.yoyAmount + 1);

  return {
    monthLabel: Math.max(0, header('Month Starting', COL.monthLabel + 1) - 1),
    appointments: Math.max(0, cancelled - 1),
    cancelled,
    noShows: header('No Shows', COL.noShows),
    onlineBookings: header('Online Bookings', COL.onlineBookings),
    newClients: header('New Clients', COL.newClients),
    totalClients: header('Total Clients', COL.totalClients),
    salesCount: header('# of Sales', COL.salesCount),
    salesPerDay: Math.max(0, salesPerDayLabel - 1),
    voucherCount: header('# of Vouchers', COL.voucherCount),
    productSales: header('Product Sales Value', COL.productSales),
    serviceSales: Math.max(0, serviceSalesLabel - 2),
    totalSales: Math.max(0, totalSalesLabel - 1),
    yoyAmount: Math.max(0, comparisonLabel - 1),
    yoyPct: comparisonLabel + 3,
  };
}

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

  const columns = resolveMonthlyPerformanceColumns(sheet.rows);
  const rows: MonthlyPerformanceSummaryRow[] = [];
  const locations: string[] = [];
  let currentLocation: string | null = null;

  for (const row of sheet.rows) {
    const colA = String(row[columns.monthLabel] ?? '').trim();
    if (!colA) continue;

    // Header / footer rows we ignore.
    if (colA === 'Monthly Performance Summary Report') continue;
    if (colA === 'Start Date:' || colA === 'End Date:') continue;
    if (colA === 'Month Starting') continue;

    const numeric = {
      appointments: valueAt(row, columns.appointments),
      cancelled: valueAt(row, columns.cancelled),
      noShows: valueAt(row, columns.noShows),
      onlineBookings: valueAt(row, columns.onlineBookings),
      newClients: valueAt(row, columns.newClients),
      totalClients: valueAt(row, columns.totalClients),
      salesCount: valueAt(row, columns.salesCount),
      salesPerDay: valueAt(row, columns.salesPerDay),
      voucherCount: valueAt(row, columns.voucherCount),
      productSales: valueAt(row, columns.productSales),
      serviceSales: valueAt(row, columns.serviceSales),
      totalSales: valueAt(row, columns.totalSales),
      yoyAmount: valueAt(row, columns.yoyAmount),
      yoyPct: parsePctParens(row[columns.yoyPct]),
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
