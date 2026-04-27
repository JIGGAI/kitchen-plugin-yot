import type { ReportDocumentFormat, ReportParameterDefinition } from '../client';
import { readWorkbook } from '../xlsx';

export const PROMOTION_USAGE_REPORT = {
  key: 'promotionUsage',
  reportName: 'PromotionUsageReport',
  reportType: 'YoureOnTime.Web.TelerikReports.PromotionsUsed, YoureOnTime.Reports',
  preferredFormat: 'XLSX' as ReportDocumentFormat,
};

export type PromotionUsageParams = {
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  staffId?: number | null;
};

export type PromotionUsageRow = {
  date: string | null;
  locationName: string | null;
  promotionName: string | null;
  promotionCode: string | null;
  usageCount: number;
  discountAmount: number | null;
  subtotalAmount: number | null;
  totalAmount: number | null;
  averageDiscountPercent: number | null;
  availablePercent: number | null;
  raw: string[];
};

export type PromotionUsageResult = {
  sheetName: string | null;
  headerRow: string[];
  parameters: Array<{
    name: string;
    type: string;
    isVisible: boolean;
    value: unknown;
  }>;
  rows: PromotionUsageRow[];
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
  const stripped = value.replace(/[$,%\s]/g, '').replace(/,/g, '');
  if (!stripped) return null;
  const n = Number(stripped);
  return Number.isFinite(n) ? n : null;
}

function parseReportDate(value: string | null): string | null {
  if (!value) return null;
  const au = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (au) {
    const [, day, month, year] = au;
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
    const hasLegacyDetailShape = normalized.includes('date') && normalized.some((value) => value.includes('promotion'));
    const hasPromotionsUsedShape = normalized.includes('name') && normalized.includes('code') && normalized.includes('used');
    if (hasLegacyDetailShape || hasPromotionsUsedShape) {
      return { index: i, headerRow };
    }
  }
  return { index: 0, headerRow: rows[0]?.map((value) => cleanCell(value) || '') || [] };
}

export function buildPromotionUsageParameterDiscovery(params: PromotionUsageParams, apiKey: string): Record<string, string> {
  return {
    DateRange: 'Custom',
    StartDate: params.startDateIso.replace('.000Z', ''),
    EndDate: params.endDateIso.replace('.000Z', ''),
    FranchiseId: '',
    LocationId: params.locationId == null ? '' : String(params.locationId),
    StaffId: params.staffId == null ? '' : String(params.staffId),
    DoNothing: '',
    Title: 'Promotion Usage Report',
    ReportName: PROMOTION_USAGE_REPORT.reportName,
    FrameView: 'True',
    OrganisationId: String(params.organisationId),
    ReportClass: 'PromotionsUsed',
    Key: apiKey,
  };
}

export function buildPromotionUsageInstanceParams(params: PromotionUsageParams): Record<string, string | number | null> {
  return {
    StartDate: params.startDateIso,
    EndDate: params.endDateIso,
    OrganisationId: params.organisationId,
    LocationId: params.locationId ?? null,
    StaffId: params.staffId ?? null,
  };
}

export function parsePromotionUsageWorkbook(
  buffer: Buffer,
  parameterDefinitions: ReportParameterDefinition[] = [],
): PromotionUsageResult {
  const sheets = readWorkbook(buffer);
  const sheet = sheets[0] || null;
  if (!sheet) {
    return { sheetName: null, headerRow: [], parameters: [], rows: [] };
  }

  const { index: headerIndex, headerRow } = chooseHeaderRow(sheet.rows);
  const headerMap = buildHeaderIndexMap(headerRow);
  const dateIndex = firstDefinedIndex(headerMap, ['Date', 'Usage Date']);
  const locationIndex = firstDefinedIndex(headerMap, ['Location', 'Location Name', 'Salon', 'Store']);
  const promotionNameIndex = firstDefinedIndex(headerMap, ['Promotion', 'Promotion Name', 'Promo Name', 'Discount Name', 'Name']);
  const promotionCodeIndex = firstDefinedIndex(headerMap, ['Promotion Code', 'Promo Code', 'Code']);
  const usageCountIndex = firstDefinedIndex(headerMap, ['Usage Count', 'Count', 'Used', 'Qty', 'Quantity']);
  const discountAmountIndex = firstDefinedIndex(headerMap, ['Discount Amount', 'Discount', 'Amount', 'Value', 'Ex-Tax Total']);
  const subtotalIndex = firstDefinedIndex(headerMap, ['SubTotal']);
  const totalIndex = firstDefinedIndex(headerMap, ['Total']);
  const averageDiscountPercentIndex = firstDefinedIndex(headerMap, ['Average Discount %']);
  const availablePercentIndex = firstDefinedIndex(headerMap, ['Available']);
  const usedIndex = firstDefinedIndex(headerMap, ['Used']);

  const rows: PromotionUsageRow[] = [];
  let currentLocationName: string | null = null;

  for (const rawRow of sheet.rows.slice(headerIndex + 1)) {
    if (!rowHasAnyData(rawRow)) continue;

    const explicitLocation = locationIndex == null ? null : cleanCell(rawRow[locationIndex]);
    const promotionName = promotionNameIndex == null ? null : cleanCell(rawRow[promotionNameIndex]);
    const promotionCode = promotionCodeIndex == null ? null : cleanCell(rawRow[promotionCodeIndex]);
    const usageCount = parseNumber(usageCountIndex == null ? null : cleanCell(rawRow[usageCountIndex]))
      ?? parseNumber(usedIndex == null ? null : cleanCell(rawRow[usedIndex]))
      ?? parseNumber(cleanCell(rawRow[22]))
      ?? 1;
    const discountAmount = parseNumber(discountAmountIndex == null ? null : cleanCell(rawRow[discountAmountIndex]))
      ?? parseNumber(cleanCell(rawRow[11]));
    const subtotalAmount = parseNumber(subtotalIndex == null ? null : cleanCell(rawRow[subtotalIndex]))
      ?? parseNumber(cleanCell(rawRow[8]));
    const totalAmount = parseNumber(totalIndex == null ? null : cleanCell(rawRow[totalIndex]))
      ?? parseNumber(cleanCell(rawRow[14]));
    const averageDiscountPercent = parseNumber(averageDiscountPercentIndex == null ? null : cleanCell(rawRow[averageDiscountPercentIndex]))
      ?? parseNumber(cleanCell(rawRow[18]));
    const availablePercent = parseNumber(availablePercentIndex == null ? null : cleanCell(rawRow[availablePercentIndex]));
    const looksLikeLocationRow = Boolean(
      promotionName &&
      !promotionCode &&
      subtotalAmount == null &&
      totalAmount == null &&
      discountAmount == null &&
      availablePercent == null &&
      (usedIndex == null || cleanCell(rawRow[usedIndex]) == null)
    );
    if (looksLikeLocationRow) {
      currentLocationName = promotionName;
      continue;
    }

    const locationName = explicitLocation || currentLocationName;
    const date = parseReportDate(dateIndex == null ? null : cleanCell(rawRow[dateIndex]));

    if ((!promotionName && !promotionCode) || !locationName) continue;
    rows.push({
      date,
      locationName,
      promotionName,
      promotionCode,
      usageCount,
      discountAmount,
      subtotalAmount,
      totalAmount,
      averageDiscountPercent,
      availablePercent,
      raw: rawRow,
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
  };
}
