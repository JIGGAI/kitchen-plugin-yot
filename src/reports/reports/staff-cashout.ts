import type { ReportDocumentFormat, ReportParameterDefinition } from '../client';
import { readWorkbook } from '../xlsx';

export const STAFF_CASHOUT_REPORT = {
  key: 'staffCashout',
  reportName: 'StaffCashoutReport',
  reportType: 'YoureOnTime.Web.TelerikReports.StaffCashout, YoureOnTime.Reports',
  preferredFormat: 'XLSX' as ReportDocumentFormat,
};

export type StaffCashoutParams = {
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  staffId?: number | null;
};

export type StaffCashoutRow = {
  date: string | null;
  locationName: string | null;
  staffName: string | null;
  services: number | null;
  serviceRevenue: number | null;
  productRevenue: number | null;
  voucherRevenue: number | null;
  membershipRevenue: number | null;
  otherRevenue: number | null;
  totalRevenue: number | null;
  tips: number | null;
  raw: string[];
};

export type StaffCashoutResult = {
  sheetName: string | null;
  headerRow: string[];
  parameters: Array<{
    name: string;
    type: string;
    isVisible: boolean;
    value: unknown;
  }>;
  rows: StaffCashoutRow[];
  debugAllRows?: string[][];
};

function cleanCell(value: string | undefined): string | null {
  const text = String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
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

function parseNumber(value: string | null): number | null {
  if (!value) return null;
  const stripped = value.replace(/[$,%\s]/g, '');
  if (!stripped) return null;
  const n = Number(stripped);
  return Number.isFinite(n) ? n : null;
}

function parseReportDate(value: string | null): string | null {
  if (!value) return null;
  const us = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const [, month, day, year] = us;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

function rowHasAnyData(row: string[]): boolean {
  return row.some((value) => cleanCell(value));
}

function chooseHeaderRow(rows: string[][]): { index: number; headerRow: string[] } {
  for (let i = 0; i < rows.length; i++) {
    const headerRow = rows[i]!.map((value) => cleanCell(value) || '');
    const normalized = headerRow.map((value) => normalizeHeader(value));
    if (normalized.includes('total services') || normalized.includes('services cash')) {
      return { index: i, headerRow };
    }
  }
  return { index: 0, headerRow: rows[0]?.map((value) => cleanCell(value) || '') || [] };
}

function findNameColumn(rows: string[][], headerIndex: number): number {
  for (let i = headerIndex; i < Math.min(headerIndex + 4, rows.length); i++) {
    const row = rows[i] || [];
    for (let c = 0; c < row.length; c++) {
      if (normalizeHeader(row[c]) === 'name') return c;
    }
  }
  return 1;
}

export function buildStaffCashoutParameterDiscovery(params: StaffCashoutParams, apiKey: string): Record<string, string> {
  return {
    DateRange: 'Custom',
    StartDate: params.startDateIso.replace('.000Z', ''),
    EndDate: params.endDateIso.replace('.000Z', ''),
    FranchiseId: '',
    LocationId: params.locationId == null ? '' : String(params.locationId),
    StaffId: params.staffId == null ? '' : String(params.staffId),
    DoNothing: '',
    Title: 'Staff Cashout',
    ReportName: STAFF_CASHOUT_REPORT.reportName,
    FrameView: 'True',
    OrganisationId: String(params.organisationId),
    ReportClass: 'StaffCashout',
    Key: apiKey,
  };
}

export function buildStaffCashoutInstanceParams(params: StaffCashoutParams): Record<string, string | number | null> {
  return {
    StartDate: params.startDateIso,
    EndDate: params.endDateIso,
    OrganisationId: params.organisationId,
    LocationId: params.locationId ?? null,
    StaffId: params.staffId ?? null,
  };
}

export function parseStaffCashoutWorkbook(
  buffer: Buffer,
  parameterDefinitions: ReportParameterDefinition[] = [],
  options: { includeDebugRows?: boolean } = {},
): StaffCashoutResult {
  const sheets = readWorkbook(buffer);
  const sheet = sheets[0] || null;
  if (!sheet) {
    return { sheetName: null, headerRow: [], parameters: [], rows: [] };
  }

  const { index: headerIndex, headerRow } = chooseHeaderRow(sheet.rows);
  const headerMap = buildHeaderIndexMap(headerRow);
  const nameIndex = findNameColumn(sheet.rows, headerIndex);
  const totalServicesIndex = firstDefinedIndex(headerMap, ['Total Services']);
  const totalProductsIndex = firstDefinedIndex(headerMap, ['Total Products']);
  const totalCcTipsIndex = firstDefinedIndex(headerMap, ['Total CC Tips', 'Tips', 'Gratuity']);

  const rows: StaffCashoutRow[] = [];
  let currentLocationName: string | null = null;

  for (const rawRow of sheet.rows.slice(headerIndex + 1)) {
    if (!rowHasAnyData(rawRow)) continue;
    const firstCell = cleanCell(rawRow[0]);
    const staffName = cleanCell(rawRow[nameIndex]);
    const normalizedFirst = normalizeHeader(firstCell || '');
    const normalizedName = normalizeHeader(staffName || '');

    if (normalizedFirst === 'totals' || normalizedName === 'average' || normalizedName === 'name') {
      continue;
    }

    if (firstCell && !staffName) {
      currentLocationName = firstCell;
      continue;
    }

    if (!staffName) continue;

    const totalServices = parseNumber(totalServicesIndex == null ? null : cleanCell(rawRow[totalServicesIndex]));
    const totalProducts = parseNumber(totalProductsIndex == null ? null : cleanCell(rawRow[totalProductsIndex]));
    const tips = parseNumber(totalCcTipsIndex == null ? null : cleanCell(rawRow[totalCcTipsIndex]));
    const totalRevenue = (totalServices ?? 0) + (totalProducts ?? 0);

    rows.push({
      date: null,
      locationName: currentLocationName,
      staffName,
      services: null,
      serviceRevenue: totalServices,
      productRevenue: totalProducts,
      voucherRevenue: null,
      membershipRevenue: null,
      otherRevenue: null,
      totalRevenue,
      tips,
      raw: rawRow.map((value) => String(value || '')),
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
    rows,
    ...(options.includeDebugRows ? { debugAllRows: sheet.rows } : {}),
  };
}
