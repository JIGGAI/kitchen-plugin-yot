// YoureOnTime DayOfWeekSummary Telerik report adapter.
//
// Telerik report type:
//   "YoureOnTime.Web.TelerikReports.DayOfWeekSummary, YoureOnTime.Reports"
//
// What the report says: for each shop, the requested date range folded onto
// the seven days of the week — how a typical Sunday, Monday, … went. One row
// per (shop, weekday), Sunday first, under a column the report titles "Week
// Starting".
//
// Sheet "DayOfWeekSummary". The header is one row of labels (some split over
// two lines), followed by a row carrying only "Week Starting" over the label
// column. Then, per shop: a row with just the shop name, a blank row, seven
// weekday rows, a blank row. There are no shop or grand totals.
//
// Columns are found by their header labels rather than by position — Telerik
// pads the sheet with decorative empty columns and has moved them before.
//
// What the figures are (checked against several months of every shop):
//   Sales #, Sales Value      totals for that weekday over the range.
//   Average Sales Per Day     Sales # ÷ the number of times that weekday
//                             falls in the range (sales on a typical Monday).
//   Average Sales Day         Sales Value ÷ a day count — but NOT that
//                             weekday's. The report divides by the count of
//                             the weekday BEFORE it (Sunday by the number of
//                             Saturdays, Monday by the number of Sundays, …),
//                             so the column is off whenever neighbouring
//                             weekdays occur a different number of times in
//                             the range. It is carried here exactly as
//                             printed; a caller wanting dollars on a typical
//                             Monday should derive it as
//                             Sales Value × Average Sales Per Day ÷ Sales #.
//   Average Sale Value        the report's own figure; it is not Sales Value ÷
//                             Sales #, so it is carried as printed.
//   Appoint. Count            appointments on that weekday over the range.
//   Appoint. % of week        that weekday's share of the shop's appointments.
//   Average Cancelled / No Show   per occurrence of that weekday.
//   Cancelled % / No Show %   of that weekday's appointments.
//   Average Wait (mins)       as printed.
//
// Because most columns are averages over the range, a range cannot be built
// by adding stored days together: the report is run for the range asked for.
//
// A weekday the shop is closed prints 0 sales and 0 appointments and leaves
// the averages empty; those stay null here, not 0.

import type { ReportDocumentFormat, ReportParameterDefinition } from '../client';
import { readWorkbook } from '../xlsx';

export const DAY_OF_WEEK_SUMMARY_REPORT = {
  key: 'dayOfWeekSummary',
  reportName: 'DayOfWeekSummaryReport',
  reportType: 'YoureOnTime.Web.TelerikReports.DayOfWeekSummary, YoureOnTime.Reports',
  preferredFormat: 'XLSX' as ReportDocumentFormat,
};

export type DayOfWeekSummaryParams = {
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  staffId?: number | null;
};

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export type DayOfWeekSummaryRow = {
  locationName: string;
  /** "Sunday" … "Saturday", as printed. */
  day: string;
  /** 0 = Sunday … 6 = Saturday. */
  dayIndex: number;
  salesCount: number | null;
  salesValue: number | null;
  averageSalesDay: number | null;
  averageSaleValue: number | null;
  appointmentCount: number | null;
  averageSalesPerDay: number | null;
  /** Percent, 0–100. */
  appointmentPctOfWeek: number | null;
  averageCancelled: number | null;
  averageNoShow: number | null;
  /** Percent, 0–100. */
  cancelledPct: number | null;
  /** Percent, 0–100. */
  noShowPct: number | null;
  averageWaitMinutes: number | null;
};

export type DayOfWeekSummaryResult = {
  sheetName: string | null;
  parameters: Array<{ name: string; type: string; isVisible: boolean; value: unknown }>;
  locations: string[];
  rows: DayOfWeekSummaryRow[];
};

// Header label (lower-cased, whitespace collapsed) → field.
const HEADER_FIELDS: Record<string, keyof Omit<DayOfWeekSummaryRow, 'locationName' | 'day' | 'dayIndex'>> = {
  'sales #': 'salesCount',
  'sales value': 'salesValue',
  'average sales day': 'averageSalesDay',
  'average sale value': 'averageSaleValue',
  'appoint. count': 'appointmentCount',
  'average sales per day': 'averageSalesPerDay',
  'appoint. % of week': 'appointmentPctOfWeek',
  'average cancelled': 'averageCancelled',
  'average no show': 'averageNoShow',
  'cancelled %': 'cancelledPct',
  'no show %': 'noShowPct',
  'average wait (mins)': 'averageWaitMinutes',
};

const normalizeHeader = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function parseNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!text) return null;
  const n = Number(text.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the sheet's rows. Split out from the workbook reader so the layout
 * rules can be tested without building an .xlsx.
 */
export function parseDayOfWeekSummaryRows(sheetRows: unknown[][]): { locations: string[]; rows: DayOfWeekSummaryRow[] } {
  // The header row is the one naming at least three known columns.
  let columns: Array<readonly [number, (typeof HEADER_FIELDS)[string]]> = [];
  let headerIndex = -1;
  for (let i = 0; i < sheetRows.length && headerIndex < 0; i += 1) {
    const found = (sheetRows[i] || [])
      .map((cell, col) => [col, HEADER_FIELDS[normalizeHeader(cell)]] as const)
      .filter(([, field]) => field);
    if (found.length >= 3) { headerIndex = i; columns = found as unknown as typeof columns; }
  }
  const rows: DayOfWeekSummaryRow[] = [];
  const locations: string[] = [];
  if (headerIndex < 0) return { locations, rows };
  const firstDataColumn = Math.min(...columns.map(([col]) => col));

  let currentLocation: string | null = null;
  for (const row of sheetRows.slice(headerIndex + 1)) {
    // The label sits in one of the columns left of the first figure.
    const label = (row || []).slice(0, firstDataColumn).map((cell) => String(cell ?? '').trim()).find(Boolean) || '';
    if (!label || normalizeHeader(label) === 'week starting') continue;
    const dayIndex = WEEKDAYS.findIndex((d) => d.toLowerCase() === label.toLowerCase());
    if (dayIndex < 0) {
      // Not a weekday: a shop heading (it carries no figures).
      if (columns.some(([col]) => parseNumber(row[col]) != null)) continue;
      currentLocation = label;
      if (!locations.includes(label)) locations.push(label);
      continue;
    }
    if (!currentLocation) continue;
    const out: DayOfWeekSummaryRow = {
      locationName: currentLocation, day: WEEKDAYS[dayIndex]!, dayIndex,
      salesCount: null, salesValue: null, averageSalesDay: null, averageSaleValue: null,
      appointmentCount: null, averageSalesPerDay: null, appointmentPctOfWeek: null,
      averageCancelled: null, averageNoShow: null, cancelledPct: null, noShowPct: null, averageWaitMinutes: null,
    };
    for (const [col, field] of columns) out[field] = parseNumber(row[col]);
    rows.push(out);
  }
  return { locations, rows };
}

// Both ends go out at midnight: the report counts the whole end day, and a
// time of day on EndDate has been seen to pull in the following day on other
// reports (see staff-popularity).
const midnight = (iso: string): string => `${iso.slice(0, 10)}T00:00:00`;

export function buildDayOfWeekSummaryParameterDiscovery(
  params: DayOfWeekSummaryParams,
  apiKey: string,
): Record<string, string> {
  return {
    DateRange: 'Custom',
    StartDate: midnight(params.startDateIso),
    EndDate: midnight(params.endDateIso),
    FranchiseId: '',
    LocationId: params.locationId == null ? '' : String(params.locationId),
    DoNothing: '',
    Title: 'Day Of Week Summary Report',
    ReportName: DAY_OF_WEEK_SUMMARY_REPORT.reportName,
    FrameView: 'True',
    OrganisationId: String(params.organisationId),
    ReportClass: 'DayOfWeekSummary',
    Key: apiKey,
  };
}

export function buildDayOfWeekSummaryInstanceParams(
  params: DayOfWeekSummaryParams,
): Record<string, string | number | null> {
  return {
    StartDate: midnight(params.startDateIso),
    EndDate: midnight(params.endDateIso),
    OrganisationId: params.organisationId,
    LocationId: params.locationId ?? null,
    StaffId: params.staffId ?? null,
  };
}

export function parseDayOfWeekSummaryWorkbook(
  buffer: Buffer,
  parameterDefinitions: ReportParameterDefinition[] = [],
): DayOfWeekSummaryResult {
  const sheets = readWorkbook(buffer);
  const sheet = sheets.find((s) => s.name === 'DayOfWeekSummary') || sheets[0] || null;
  if (!sheet) return { sheetName: null, parameters: [], locations: [], rows: [] };
  const { locations, rows } = parseDayOfWeekSummaryRows(sheet.rows);
  return {
    sheetName: sheet.name,
    parameters: parameterDefinitions.map((p) => ({ name: p.name, type: p.type, isVisible: p.isVisible, value: p.value })),
    locations,
    rows,
  };
}
