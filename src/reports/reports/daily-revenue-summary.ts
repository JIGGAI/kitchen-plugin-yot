import type { ReportDocumentFormat, ReportParameterDefinition } from '../client';
import { readWorkbook } from '../xlsx';

export const DAILY_REVENUE_SUMMARY_REPORT = {
  key: 'dailyRevenueSummary',
  reportName: 'DailyRevenueSummaryReport',
  reportType: 'YoureOnTime.Web.TelerikReports.DailyRevenueSummary, YoureOnTime.Reports',
  preferredFormat: 'XLSX' as ReportDocumentFormat,
};

export type DailyRevenueSummaryParams = {
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  staffId?: number | null;
  dayOfWeek?: number | null;
};

export type DailyRevenueSummaryRow = {
  locationName: string;
  rowKind: 'detail' | 'average' | 'total';
  date: string | null;
  cashPayments: number | null;
  cardPayments: number | null;
  voucherPayments: number | null;
  otherPayments: number | null;
  accountPayments: number | null;
  totalPayments: number | null;
  serviceSales: number | null;
  productSales: number | null;
  voucherSales: number | null;
  membershipSales: number | null;
  noSaleCashOut: number | null;
  totalCashOnHand: number | null;
  totalRevenue: number | null;
  taxableRevenue: number | null;
  revenueLessTax: number | null;
  raw: string[];
};

export type DailyRevenueSummaryResult = {
  sheetName: string | null;
  headerRow: string[];
  parameters: Array<{
    name: string;
    type: string;
    isVisible: boolean;
    value: unknown;
  }>;
  locations: string[];
  rows: DailyRevenueSummaryRow[];
};

function parseNumber(value: string | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeHeader(value: string | undefined): string {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildHeaderIndexMap(headerRow: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < headerRow.length; i++) {
    const key = normalizeHeader(headerRow[i]);
    if (!key || map.has(key)) continue;
    map.set(key, i);
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

function valueAt(row: string[], index: number | null): number | null {
  if (index == null) return null;
  return parseNumber(row[index]);
}

export function buildDailyRevenueSummaryParameterDiscovery(params: DailyRevenueSummaryParams, apiKey: string): Record<string, string> {
  return {
    DateRange: 'Custom',
    StartDate: params.startDateIso.replace('.000Z', ''),
    EndDate: params.endDateIso.replace('.000Z', ''),
    FranchiseId: '',
    LocationId: params.locationId == null ? '' : String(params.locationId),
    DayOfWeek: params.dayOfWeek == null ? '' : String(params.dayOfWeek),
    DoNothing: '',
    Title: 'Daily Revenue Summary',
    ReportName: DAILY_REVENUE_SUMMARY_REPORT.reportName,
    FrameView: 'True',
    OrganisationId: String(params.organisationId),
    ReportClass: 'DailyRevenueSummary',
    Key: apiKey,
  };
}

export function buildDailyRevenueSummaryInstanceParams(params: DailyRevenueSummaryParams): Record<string, string | number | null> {
  return {
    StartDate: params.startDateIso,
    EndDate: params.endDateIso,
    OrganisationId: params.organisationId,
    LocationId: params.locationId ?? null,
    StaffId: params.staffId ?? null,
    DayOfWeek: params.dayOfWeek ?? null,
  };
}

export function parseDailyRevenueSummaryWorkbook(
  buffer: Buffer,
  parameterDefinitions: ReportParameterDefinition[] = [],
): DailyRevenueSummaryResult {
  const sheets = readWorkbook(buffer);
  const sheet = sheets.find((candidate) => candidate.name === 'DailySalesSummary') || sheets[0] || null;
  if (!sheet) {
    return { sheetName: null, headerRow: [], parameters: [], locations: [], rows: [] };
  }

  const headerSource = sheet.rows.find((row) => row[0] === 'Date' && row.some((value) => String(value).includes('Revenue'))) || [];
  const headerRow = headerSource.map((value) => value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim());
  const startIndex = sheet.rows.findIndex((row) => row[0] === 'Date' && row.some((value) => String(value).includes('Revenue')));
  const headerIndex = buildHeaderIndexMap(headerRow);

  const cashPaymentsIndex = firstDefinedIndex(headerIndex, ['Cash Payments']);
  const cardPaymentsIndex = firstDefinedIndex(headerIndex, ['Card Payments']);
  const voucherPaymentsIndex = firstDefinedIndex(headerIndex, ['Voucher Payments']);
  const otherPaymentsIndex = firstDefinedIndex(headerIndex, ['Other Payments']);
  const accountPaymentsIndex = firstDefinedIndex(headerIndex, ['Account Payments']);
  const totalPaymentsIndex = firstDefinedIndex(headerIndex, ['Total Payments']);
  const serviceSalesIndex = firstDefinedIndex(headerIndex, ['Service Sales']);
  const productSalesIndex = firstDefinedIndex(headerIndex, ['Product Sales']);
  const voucherSalesIndex = firstDefinedIndex(headerIndex, ['Voucher Sales']);
  const membershipSalesIndex = firstDefinedIndex(headerIndex, ['Membership Sales']);
  const noSaleCashOutIndex = firstDefinedIndex(headerIndex, ['No Sale/ Cash Out', 'No Sale / Cash Out']);
  const totalCashOnHandIndex = firstDefinedIndex(headerIndex, ['Total Cash on Hand']);
  const totalRevenueIndex = firstDefinedIndex(headerIndex, ['Total Revenue']);
  const taxableRevenueIndex = firstDefinedIndex(headerIndex, ['Taxable Revenue']);
  const revenueLessTaxIndex = firstDefinedIndex(headerIndex, ['Revenue Less Tax']);

  const rows: DailyRevenueSummaryRow[] = [];
  const locations: string[] = [];
  let currentLocation: string | null = null;

  for (const row of sheet.rows.slice(startIndex + 1)) {
    const first = (row[0] || '').trim();
    const hasData = row.slice(1).some((value) => String(value || '').trim());
    if (!first) continue;
    if (!hasData) {
      currentLocation = first;
      if (!locations.includes(first)) locations.push(first);
      continue;
    }

    const rowKind = /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(first)
      ? 'detail'
      : first === 'Averages'
        ? 'average'
        : first === 'Total'
          ? 'total'
          : null;
    if (!rowKind || !currentLocation) continue;

    rows.push({
      locationName: currentLocation,
      rowKind,
      date: rowKind === 'detail' ? first : null,
      cashPayments: valueAt(row, cashPaymentsIndex),
      cardPayments: valueAt(row, cardPaymentsIndex),
      voucherPayments: valueAt(row, voucherPaymentsIndex),
      otherPayments: valueAt(row, otherPaymentsIndex),
      accountPayments: valueAt(row, accountPaymentsIndex),
      totalPayments: valueAt(row, totalPaymentsIndex),
      serviceSales: valueAt(row, serviceSalesIndex),
      productSales: valueAt(row, productSalesIndex),
      voucherSales: valueAt(row, voucherSalesIndex),
      membershipSales: valueAt(row, membershipSalesIndex),
      noSaleCashOut: valueAt(row, noSaleCashOutIndex),
      totalCashOnHand: valueAt(row, totalCashOnHandIndex),
      totalRevenue: valueAt(row, totalRevenueIndex),
      taxableRevenue: valueAt(row, taxableRevenueIndex),
      revenueLessTax: valueAt(row, revenueLessTaxIndex),
      raw: row,
    });
  }

  return {
    sheetName: sheet.name,
    headerRow,
    parameters: parameterDefinitions.map((row) => ({
      name: row.name,
      type: row.type,
      isVisible: row.isVisible,
      value: row.value,
    })),
    locations,
    rows,
  };
}
