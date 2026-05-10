// YoureOnTime StaffPerformance_2121 report adapter.
//
// Telerik report type:
//   "YoureOnTime.Web.TelerikReports.StaffPerformance_2121, YoureOnTime.Reports"
//
// Sheet name "StaffPerformance_2121". 23-column workbook. Header in row 4
// uses split labels (\r\n inside cell text). Data rows are positioned by
// fixed column index — sniffed from the actual XLSX export and verified
// against per-location "Totals" rows + the final "Grand Total".
//
// Layout per location:
//   <Location Name> (alpha label, no numeric data)
//   <Staff Name>    (one row per stylist at that location)
//   ...
//   "Totals"        (per-location overall total)
// Final row: "Grand Total" across the whole network.
//
// Data column positions:
//   [0]  Staff name / Location label / "Totals" / "Grand Total"
//   [5]  Total Sales (count of distinct sales for that staff member)
//   [6]  Service Sold (count of services sold)
//   [7]  Services Value ($)
//   [8]  Services per Sale (ratio)
//   [10] Average Tip ($)
//   [11] Products Sold (count)
//   [12] Products Value ($)
//   [14] Total Sales ($) — the dollar value (= Services Value + Products Value)
//        Note: Yes, the report has TWO "Total Sales" header cells.
//        [5] is the count, [14] is the dollar amount. The first one ([5])
//        sits above the services columns; the second ([14]) sits above the
//        downstream summary columns.
//   [15] Points Earned
//   [16] Clients per Point (ratio; can be "#NUM!" when Points Earned is 0)
//   [17] Commission & Tips Total ($)
//   [18] Avg. Sale Value ($)
//   [19] Hours Worked (string e.g. "8h, 0m" — preserved as raw text)
//   [22] Total Per Hour ($)

import type { ReportDocumentFormat, ReportParameterDefinition } from '../client';
import { readWorkbook } from '../xlsx';

export const STAFF_PERFORMANCE_REPORT = {
  key: 'staffPerformance',
  reportName: 'StaffPerformanceReport',
  reportType: 'YoureOnTime.Web.TelerikReports.StaffPerformance_2121, YoureOnTime.Reports',
  preferredFormat: 'XLSX' as ReportDocumentFormat,
};

export type StaffPerformanceParams = {
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  staffId?: number | null;
};

export type StaffPerformanceRow = {
  locationName: string | null;
  staffName: string | null;
  rowKind: 'staff' | 'locationTotal' | 'grandTotal';
  totalSalesCount: number | null;
  serviceSold: number | null;
  servicesValue: number | null;
  servicesPerSale: number | null;
  averageTip: number | null;
  productsSold: number | null;
  productsValue: number | null;
  totalSalesValue: number | null;
  pointsEarned: number | null;
  clientsPerPoint: number | null;
  commissionTipsTotal: number | null;
  avgSaleValue: number | null;
  hoursWorkedRaw: string | null;
  totalPerHour: number | null;
  raw: unknown[];
};

export type StaffPerformanceResult = {
  sheetName: string | null;
  parameters: Array<{ name: string; type: string; isVisible: boolean; value: unknown }>;
  locations: string[];
  rows: StaffPerformanceRow[];
};

const COL = {
  totalSalesCount: 5,
  serviceSold: 6,
  servicesValue: 7,
  servicesPerSale: 8,
  averageTip: 10,
  productsSold: 11,
  productsValue: 12,
  totalSalesValue: 14,
  pointsEarned: 15,
  clientsPerPoint: 16,
  commissionTipsTotal: 17,
  avgSaleValue: 18,
  hoursWorked: 19,
  totalPerHour: 22,
} as const;

function parseNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  // YOT writes "#NUM!" when a ratio divides by zero (e.g. clientsPerPoint when
  // Points Earned is 0). Treat those as null rather than NaN.
  if (trimmed.startsWith('#')) return null;
  const n = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function valueAt(row: unknown[], idx: number): number | null {
  return parseNumber(row[idx]);
}

function cleanString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

export function buildStaffPerformanceParameterDiscovery(
  params: StaffPerformanceParams,
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
    Title: 'Staff Performance Report',
    ReportName: STAFF_PERFORMANCE_REPORT.reportName,
    FrameView: 'True',
    OrganisationId: String(params.organisationId),
    ReportClass: 'StaffPerformance_2121',
    Key: apiKey,
  };
}

export function buildStaffPerformanceInstanceParams(
  params: StaffPerformanceParams,
): Record<string, string | number | null> {
  return {
    StartDate: params.startDateIso.replace('.000Z', ''),
    EndDate: params.endDateIso.replace('.000Z', ''),
    OrganisationId: params.organisationId,
    LocationId: params.locationId ?? null,
    StaffId: params.staffId ?? null,
    FranchiseId: null,
  };
}

export function parseStaffPerformanceWorkbook(
  buffer: Buffer,
  parameterDefinitions: ReportParameterDefinition[] = [],
): StaffPerformanceResult {
  const sheets = readWorkbook(buffer);
  const sheet = sheets.find((s) => s.name === 'StaffPerformance_2121') || sheets[0] || null;
  if (!sheet) {
    return { sheetName: null, parameters: [], locations: [], rows: [] };
  }

  const rows: StaffPerformanceRow[] = [];
  const locations: string[] = [];
  let currentLocation: string | null = null;

  for (const row of sheet.rows) {
    const colA = cleanString(row[0]);
    if (!colA) continue;

    // Header / footer rows we always ignore.
    if (colA === 'Staff Performance Report') continue;
    if (colA === 'Start Date:' || colA === 'End Date:') continue;
    if (colA === 'Staff') continue;

    const numeric = {
      totalSalesCount: valueAt(row, COL.totalSalesCount),
      serviceSold: valueAt(row, COL.serviceSold),
      servicesValue: valueAt(row, COL.servicesValue),
      servicesPerSale: valueAt(row, COL.servicesPerSale),
      averageTip: valueAt(row, COL.averageTip),
      productsSold: valueAt(row, COL.productsSold),
      productsValue: valueAt(row, COL.productsValue),
      totalSalesValue: valueAt(row, COL.totalSalesValue),
      pointsEarned: valueAt(row, COL.pointsEarned),
      clientsPerPoint: valueAt(row, COL.clientsPerPoint),
      commissionTipsTotal: valueAt(row, COL.commissionTipsTotal),
      avgSaleValue: valueAt(row, COL.avgSaleValue),
      hoursWorkedRaw: cleanString(row[COL.hoursWorked]),
      totalPerHour: valueAt(row, COL.totalPerHour),
    };
    const hasNumericData = (
      numeric.totalSalesCount != null
      || numeric.servicesValue != null
      || numeric.totalSalesValue != null
      || numeric.commissionTipsTotal != null
    );

    if (colA === 'Grand Total') {
      rows.push({ locationName: null, staffName: null, rowKind: 'grandTotal', ...numeric, raw: row });
      currentLocation = null;
      continue;
    }
    if (colA === 'Totals') {
      if (currentLocation && hasNumericData) {
        rows.push({ locationName: currentLocation, staffName: null, rowKind: 'locationTotal', ...numeric, raw: row });
      }
      continue;
    }
    if (!hasNumericData) {
      // Alpha label with no numbers → it's a location label.
      currentLocation = colA;
      if (!locations.includes(colA)) locations.push(colA);
      continue;
    }
    // Otherwise: a staff data row (numeric data + a name in column A).
    if (currentLocation) {
      rows.push({ locationName: currentLocation, staffName: colA, rowKind: 'staff', ...numeric, raw: row });
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
