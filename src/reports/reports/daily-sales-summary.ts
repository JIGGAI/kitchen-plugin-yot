// YoureOnTime DailySalesSummary report adapter.
//
// Different YOT report from DailyRevenueSummary — separate Telerik type at:
//   "YoureOnTime.Web.TelerikReports.DailySalesSummary, YoureOnTime.Reports"
//
// The XLSX export carries per-day sales-side facts (counts of distinct
// checkout transactions, services-per-sale ratio, sales-side dollar totals)
// that the DailyRevenueSummary export omits.
//
// Workbook shape (sheet name "DailySalesSummary"):
//   row 0: title
//   row 1: "Start Date:" with value
//   row 2: "End Date:"   with value
//   row 4: column headers (sparse — many None cells between labels)
//   row 5: "Date" anchor
//   then repeated location blocks:
//     <Location Name>
//     <month label, e.g. datetime>
//     dd/m/yyyy detail rows
//     "Month Averages"
//     "Month Total"
//     ... next month ...
//     "Averages" (overall)
//     "Total"   (overall)

import type { ReportDocumentFormat, ReportParameterDefinition } from '../client';
import { readWorkbook } from '../xlsx';

export const DAILY_SALES_SUMMARY_REPORT = {
  key: 'dailySalesSummary',
  reportName: 'DailySalesSummaryReport',
  reportType: 'YoureOnTime.Web.TelerikReports.DailySalesSummary, YoureOnTime.Reports',
  preferredFormat: 'XLSX' as ReportDocumentFormat,
};

export type DailySalesSummaryParams = {
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  staffId?: number | null;
  dayOfWeek?: number | null;
};

export type DailySalesSummaryRow = {
  locationName: string;
  rowKind: 'detail' | 'monthAverage' | 'monthTotal' | 'overallAverage' | 'overallTotal';
  /** dd/m/yyyy as it appears in the report; null for aggregate rows. */
  date: string | null;
  cashSales: number | null;
  creditCardSales: number | null;
  voucherSales: number | null;
  otherSales: number | null;
  totalSales: number | null;
  creditCardTips: number | null;
  totalCreditCard: number | null;
  otherTips: number | null;
  /** Count of distinct checkout transactions ("Number of Sales" column). */
  numberOfSales: number | null;
  /** Mean services per sale (numberOfSales × servicesPerSale = total services). */
  servicesPerSale: number | null;
  serviceSales: number | null;
  productSales: number | null;
  avgSaleValue: number | null;
  commissionTotal: number | null;
  raw: unknown[];
};

export type DailySalesSummaryResult = {
  sheetName: string | null;
  headerRow: string[];
  parameters: Array<{
    name: string;
    type: string;
    isVisible: boolean;
    value: unknown;
  }>;
  locations: string[];
  rows: DailySalesSummaryRow[];
};

function parseNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const n = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildHeaderIndexMap(headerRow: unknown[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < headerRow.length; i++) {
    const key = normalizeHeader(headerRow[i]);
    if (key && !map.has(key)) map.set(key, i);
  }
  return map;
}

function firstDefinedIndex(map: Map<string, number>, keys: string[]): number | null {
  for (const key of keys) {
    const hit = map.get(normalizeHeader(key));
    if (hit !== undefined) return hit;
  }
  return null;
}

function valueAt(row: unknown[], index: number | null): number | null {
  if (index == null) return null;
  return parseNumber(row[index]);
}

export function buildDailySalesSummaryParameterDiscovery(
  params: DailySalesSummaryParams,
  apiKey: string,
): Record<string, string> {
  return {
    DateRange: 'Custom',
    StartDate: params.startDateIso.replace('.000Z', ''),
    EndDate: params.endDateIso.replace('.000Z', ''),
    FranchiseId: '',
    LocationId: params.locationId == null ? '' : String(params.locationId),
    DayOfWeek: params.dayOfWeek == null ? '' : String(params.dayOfWeek),
    DoNothing: '',
    Title: 'Daily Sales Summary Report',
    ReportName: DAILY_SALES_SUMMARY_REPORT.reportName,
    FrameView: 'True',
    OrganisationId: String(params.organisationId),
    ReportClass: 'DailySalesSummary',
    Key: apiKey,
  };
}

export function buildDailySalesSummaryInstanceParams(
  params: DailySalesSummaryParams,
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

const DETAIL_DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

export function parseDailySalesSummaryWorkbook(
  buffer: Buffer,
  parameterDefinitions: ReportParameterDefinition[] = [],
): DailySalesSummaryResult {
  const sheets = readWorkbook(buffer);
  const sheet = sheets.find((s) => s.name === 'DailySalesSummary') || sheets[0] || null;
  if (!sheet) {
    return { sheetName: null, headerRow: [], parameters: [], locations: [], rows: [] };
  }

  // Find the header row: it has 'Number of Sales' or 'Total Sales' in some cell.
  const headerRowIndex = sheet.rows.findIndex((row) =>
    row.some((value) => normalizeHeader(value) === 'number of sales')
      || row.some((value) => normalizeHeader(value) === 'total sales'),
  );
  const headerRowRaw = headerRowIndex >= 0 ? sheet.rows[headerRowIndex] : [];
  const headerRow = headerRowRaw.map((value) => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim());
  const headerIndex = buildHeaderIndexMap(headerRowRaw);

  const cashSalesIndex = firstDefinedIndex(headerIndex, ['Cash Sales']);
  const creditCardSalesIndex = firstDefinedIndex(headerIndex, ['Credit Card Sales']);
  const voucherSalesIndex = firstDefinedIndex(headerIndex, ['Voucher Sales']);
  const otherSalesIndex = firstDefinedIndex(headerIndex, ['Other Sales']);
  const totalSalesIndex = firstDefinedIndex(headerIndex, ['Total Sales']);
  const creditCardTipsIndex = firstDefinedIndex(headerIndex, ['Credit Card Tips']);
  const totalCreditCardIndex = firstDefinedIndex(headerIndex, ['Total Credit Card']);
  const otherTipsIndex = firstDefinedIndex(headerIndex, ['Other Tips']);
  const numberOfSalesIndex = firstDefinedIndex(headerIndex, ['Number of Sales', 'Number Of Sales']);
  const servicesPerSaleIndex = firstDefinedIndex(headerIndex, ['Services per Sale', 'Services Per Sale']);
  const serviceSalesIndex = firstDefinedIndex(headerIndex, ['Service Sales']);
  const productSalesIndex = firstDefinedIndex(headerIndex, ['Product Sales']);
  const avgSaleValueIndex = firstDefinedIndex(headerIndex, ['Avg Sale Value']);
  const commissionTotalIndex = firstDefinedIndex(headerIndex, ['Commission Total']);

  const rows: DailySalesSummaryRow[] = [];
  const locations: string[] = [];
  let currentLocation: string | null = null;

  // Walk every row after the header: a non-numeric, no-data row is the next
  // location label (or a month delimiter — both look similar). Detail rows
  // start with a dd/m/yyyy date string. Aggregate rows: "Month Averages",
  // "Month Total", "Averages", "Total".
  for (let i = headerRowIndex + 1; i < sheet.rows.length; i++) {
    const row = sheet.rows[i];
    const first = String(row[0] ?? '').trim();
    if (!first) continue;

    // Aggregate row labels we care about.
    let rowKind: DailySalesSummaryRow['rowKind'] | null = null;
    if (DETAIL_DATE_RE.test(first)) rowKind = 'detail';
    else if (first === 'Month Averages') rowKind = 'monthAverage';
    else if (first === 'Month Total') rowKind = 'monthTotal';
    else if (first === 'Averages') rowKind = 'overallAverage';
    else if (first === 'Total') rowKind = 'overallTotal';

    if (rowKind === null) {
      // Either a location label or a month-block header (datetime). The month
      // block header has a Date object as its first cell, NOT a string of
      // letters. We treat string labels as locations.
      const numericData = row.slice(1).some((value) => parseNumber(value) != null);
      if (!numericData && /[A-Za-z]/.test(first)) {
        currentLocation = first;
        if (!locations.includes(first)) locations.push(first);
      }
      continue;
    }
    if (!currentLocation) continue;

    rows.push({
      locationName: currentLocation,
      rowKind,
      date: rowKind === 'detail' ? first : null,
      cashSales: valueAt(row, cashSalesIndex),
      creditCardSales: valueAt(row, creditCardSalesIndex),
      voucherSales: valueAt(row, voucherSalesIndex),
      otherSales: valueAt(row, otherSalesIndex),
      totalSales: valueAt(row, totalSalesIndex),
      creditCardTips: valueAt(row, creditCardTipsIndex),
      totalCreditCard: valueAt(row, totalCreditCardIndex),
      otherTips: valueAt(row, otherTipsIndex),
      numberOfSales: valueAt(row, numberOfSalesIndex),
      servicesPerSale: valueAt(row, servicesPerSaleIndex),
      serviceSales: valueAt(row, serviceSalesIndex),
      productSales: valueAt(row, productSalesIndex),
      avgSaleValue: valueAt(row, avgSaleValueIndex),
      commissionTotal: valueAt(row, commissionTotalIndex),
      raw: row,
    });
  }

  return {
    sheetName: sheet.name,
    headerRow,
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
