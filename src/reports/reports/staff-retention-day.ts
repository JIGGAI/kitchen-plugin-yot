// YoureOnTime StaffRetentionDay Telerik report adapter.
//
// Telerik report type:
//   "YoureOnTime.Web.TelerikReports.StaffRetentionDay, YoureOnTime.Reports"
//
// Sheet name: "Retention".
//
// Per-(location, staff) client retention metrics for the requested window. See
// scripts/sample-staff-retention-findings.md for the full column map; the short
// version is below.

import type { ReportDocumentFormat, ReportParameterDefinition } from '../client';
import { readWorkbook } from '../xlsx';

// ---------------------------------------------------------------------------
// Column position constants
// ---------------------------------------------------------------------------

const COL = {
  locationHeader: 1,     // location name (location header row)
  totalLabel: 1,         // "Total" (per-location subtotal row)
  staffName: 2,          // staff name (data row)
  totalSales: 10,
  returnedToStaff: 11,
  returnedToBusiness: 12,
  newClients: 14,
  totalRebooked: 15,
  newClientsRebooked: 17,
  retention1mb: 19,
  retention2mb: 23,
  retention3mb: 25,
  // Header row positions
  hdrMonth1: 19,
  hdrMonth2: 22,
  hdrMonth3: 24,
} as const;

// ---------------------------------------------------------------------------
// Report descriptor
// ---------------------------------------------------------------------------

export const STAFF_RETENTION_DAY_REPORT = {
  key: 'staffRetentionDay',
  reportName: 'StaffRetentionDayReport',
  reportType: 'YoureOnTime.Web.TelerikReports.StaffRetentionDay, YoureOnTime.Reports',
  preferredFormat: 'XLSX' as ReportDocumentFormat,
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StaffRetentionDayParams = {
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  staffId?: number | null;
  franchiseId?: number | null;
};

export type RetentionMetric = {
  count: number;
  pct: number; // 0-100, integer (YOT only emits whole percents)
};

export type StaffRetentionRow = {
  locationName: string;
  staffName: string;
  totalSales: number;
  returnedToStaff: RetentionMetric | null;
  returnedToBusiness: RetentionMetric | null;
  newClients: RetentionMetric | null;
  totalRebooked: RetentionMetric | null;
  newClientsRebooked: RetentionMetric | null;
  // Trailing-month retention; the actual month label comes from
  // result.trailingMonthLabels.
  retention1MonthBack: RetentionMetric | null;
  retention2MonthsBack: RetentionMetric | null;
  retention3MonthsBack: RetentionMetric | null;
};

export type StaffRetentionLocationTotal = Omit<StaffRetentionRow, 'staffName'> & {
  staffName: 'Total';
};

export type StaffRetentionDayResult = {
  sheetName: string | null;
  parameters: Array<{ name: string; type: string; isVisible: boolean; value: unknown }>;
  trailingMonthLabels: { m1: string | null; m2: string | null; m3: string | null };
  locations: string[];
  rows: StaffRetentionRow[];
  locationTotals: StaffRetentionLocationTotal[];
  grandTotal: StaffRetentionLocationTotal | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a "count (pct%)" cell into structured numbers. Returns null when the
 * cell is blank or unparseable. YOT writes "0 (0%)" for zero — we keep that.
 */
function parseMetricCell(raw: unknown): RetentionMetric | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Examples: "13 (34%)", "0 (0%)", "1 (50%)"
  const m = s.match(/^(-?\d+)\s*\((-?\d+)%\)/);
  if (!m) {
    // Some cells may be just a count without parentheses (rare). Try as integer.
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? { count: n, pct: 0 } : null;
  }
  const count = parseInt(m[1], 10);
  const pct = parseInt(m[2], 10);
  if (!Number.isFinite(count) || !Number.isFinite(pct)) return null;
  return { count, pct };
}

function parseIntOrZero(raw: unknown): number {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (!s) return 0;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

function rowIsAllEmpty(row: string[]): boolean {
  for (const cell of row) if ((cell ?? '').trim() !== '') return false;
  return true;
}

function isHeaderPreambleRow(row: string[]): boolean {
  const col0 = (row[0] ?? '').trim();
  if (col0 === 'Staff Retention Report') return true;
  if (col0 === 'Start Date:' || col0 === 'End Date:') return true;
  return false;
}

function isLocationHeaderRow(row: string[]): boolean {
  // Location header: col[1] is a non-empty name, col[0]/col[2]/col[10] are all empty
  const col0 = (row[0] ?? '').trim();
  const col1 = (row[COL.locationHeader] ?? '').trim();
  const col2 = (row[COL.staffName] ?? '').trim();
  const col10 = (row[COL.totalSales] ?? '').trim();
  if (col0 !== '' || col2 !== '' || col10 !== '') return false;
  if (!col1) return false;
  // Exclude the per-location subtotal row (col[1] === "Total")
  if (col1 === 'Total') return false;
  return true;
}

function isStaffDataRow(row: string[]): boolean {
  // Staff data: col[2] non-empty AND col[10] is a numeric count
  const col2 = (row[COL.staffName] ?? '').trim();
  const col10 = (row[COL.totalSales] ?? '').trim();
  if (!col2 || !col10) return false;
  return /^-?\d+$/.test(col10);
}

function isLocationTotalRow(row: string[]): boolean {
  // Subtotal row: col[1] === "Total", col[10] numeric
  const col1 = (row[COL.totalLabel] ?? '').trim();
  const col10 = (row[COL.totalSales] ?? '').trim();
  if (col1 !== 'Total') return false;
  return /^-?\d+$/.test(col10);
}

function isGrandTotalRow(row: string[]): boolean {
  // Grand total row: col[0] === "Grand Total"
  const col0 = (row[0] ?? '').trim();
  return col0 === 'Grand Total';
}

function metricsFromRow(row: string[]) {
  return {
    totalSales: parseIntOrZero(row[COL.totalSales]),
    returnedToStaff: parseMetricCell(row[COL.returnedToStaff]),
    returnedToBusiness: parseMetricCell(row[COL.returnedToBusiness]),
    newClients: parseMetricCell(row[COL.newClients]),
    totalRebooked: parseMetricCell(row[COL.totalRebooked]),
    newClientsRebooked: parseMetricCell(row[COL.newClientsRebooked]),
    retention1MonthBack: parseMetricCell(row[COL.retention1mb]),
    retention2MonthsBack: parseMetricCell(row[COL.retention2mb]),
    retention3MonthsBack: parseMetricCell(row[COL.retention3mb]),
  };
}

// ---------------------------------------------------------------------------
// Parameter builders
// ---------------------------------------------------------------------------

export function buildStaffRetentionDayParameterDiscovery(
  params: StaffRetentionDayParams,
  apiKey: string,
): Record<string, string> {
  return {
    DateRange: 'Custom',
    StartDate: params.startDateIso.replace('.000Z', ''),
    EndDate: params.endDateIso.replace('.000Z', ''),
    FranchiseId: params.franchiseId == null ? '' : String(params.franchiseId),
    LocationId: params.locationId == null ? '' : String(params.locationId),
    StaffId: params.staffId == null ? '' : String(params.staffId),
    DoNothing: '',
    Title: 'Staff Retention Report',
    ReportName: STAFF_RETENTION_DAY_REPORT.reportName,
    FrameView: 'True',
    OrganisationId: String(params.organisationId),
    ReportClass: 'StaffRetentionDay',
    Key: apiKey,
  };
}

export function buildStaffRetentionDayInstanceParams(
  params: StaffRetentionDayParams,
): Record<string, string | number | null> {
  return {
    StartDate: params.startDateIso.replace('.000Z', ''),
    EndDate: params.endDateIso.replace('.000Z', ''),
    OrganisationId: params.organisationId,
    LocationId: params.locationId ?? null,
    StaffId: params.staffId ?? null,
    FranchiseId: params.franchiseId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Workbook parser
// ---------------------------------------------------------------------------

export function parseStaffRetentionDayWorkbook(
  buffer: Buffer,
  parameterDefinitions: ReportParameterDefinition[] = [],
): StaffRetentionDayResult {
  const sheets = readWorkbook(buffer);
  const sheet = sheets.find((s) => s.name === 'Retention') || sheets[0] || null;

  if (!sheet) {
    return {
      sheetName: null,
      parameters: [],
      trailingMonthLabels: { m1: null, m2: null, m3: null },
      locations: [],
      rows: [],
      locationTotals: [],
      grandTotal: null,
    };
  }

  // Read trailing-month labels from the first ~10 rows (defensive — usually r7)
  let trailingMonthLabels = { m1: null as string | null, m2: null as string | null, m3: null as string | null };
  for (let r = 0; r < Math.min(12, sheet.rows.length); r++) {
    const row = sheet.rows[r];
    const m1 = (row[COL.hdrMonth1] ?? '').trim();
    const m2 = (row[COL.hdrMonth2] ?? '').trim();
    const m3 = (row[COL.hdrMonth3] ?? '').trim();
    if (m1 || m2 || m3) {
      trailingMonthLabels = { m1: m1 || null, m2: m2 || null, m3: m3 || null };
      break;
    }
  }

  const rows: StaffRetentionRow[] = [];
  const locationTotals: StaffRetentionLocationTotal[] = [];
  const locations: string[] = [];
  let currentLocation: string | null = null;
  let grandTotal: StaffRetentionLocationTotal | null = null;

  for (const row of sheet.rows) {
    if (rowIsAllEmpty(row)) continue;
    if (isHeaderPreambleRow(row)) continue;

    if (isGrandTotalRow(row)) {
      grandTotal = {
        locationName: 'Grand Total',
        staffName: 'Total',
        ...metricsFromRow(row),
      };
      continue;
    }

    if (isLocationHeaderRow(row)) {
      currentLocation = (row[COL.locationHeader] ?? '').trim();
      if (currentLocation && !locations.includes(currentLocation)) {
        locations.push(currentLocation);
      }
      continue;
    }

    if (isLocationTotalRow(row) && currentLocation) {
      locationTotals.push({
        locationName: currentLocation,
        staffName: 'Total',
        ...metricsFromRow(row),
      });
      continue;
    }

    if (isStaffDataRow(row) && currentLocation) {
      rows.push({
        locationName: currentLocation,
        staffName: (row[COL.staffName] ?? '').trim(),
        ...metricsFromRow(row),
      });
      continue;
    }
  }

  return {
    sheetName: sheet.name,
    parameters: parameterDefinitions.map((p) => ({
      name: p.name,
      type: p.type,
      isVisible: !!p.isVisible,
      value: p.value,
    })),
    trailingMonthLabels,
    locations,
    rows,
    locationTotals,
    grandTotal,
  };
}
