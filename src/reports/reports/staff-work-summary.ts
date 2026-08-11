// YoureOnTime StaffWorkSummary Telerik report adapter.
//
// Telerik report type:
//   "YoureOnTime.Web.TelerikReports.StaffWorkSummary_2121, YoureOnTime.Reports"
//
// Supplies two columns the StaffPerformance report doesn't carry: "Sales per
// hour" and "Avg Length" (surfaced on the stylist leaderboard as "Chair time").
//
// Layout, confirmed against a live 2026-08-04 workbook. Unlike StaffPerformance
// the label column is [1], not [0]:
//
//   [title row]        col[0] = "Staff Work Summary Report"
//   [param rows]       col[0] = "Start Date:" / "End Date:"
//   [header rows]      col[5]  = "Scheduled Work Time", col[25] = "Sales per hour",
//                      col[29] = "Avg \r\nLength", col[1] = "Name"
//   [location row]     col[1] = location name, no numeric data
//   [staff rows]       col[1] = staff name + numeric data
//
// Column positions are read off merged header cells, so several headers sit one
// column to the left of their data (header [16] "% Filled Appoint." → data
// [17]). Only the columns whose meaning could be verified against another
// source are parsed here:
//
//   [22] "Total Sales" and [20] "% Filled Walk Ins" both appear to land on data
//   column [21], and cross-checking against staff_performance_facts matched for
//   some stylists but not others. Rather than ship a column that might be
//   mislabelled, they are left unparsed — nothing needs them yet.
//
// A note on "Sales per hour": the divisor YOT uses could not be reproduced from
// either scheduled or clocked hours (7 of 29 stylists on 2026-08-04 matched
// clocked hours exactly, the rest didn't), so this adapter treats the reported
// figure as authoritative rather than recomputing it.

import type { ReportDocumentFormat, ReportParameterDefinition } from '../client';
import { readWorkbook } from '../xlsx';
import { parseHoursWorkedToMinutes } from './staff-performance';

// ---------------------------------------------------------------------------
// Column positions — locked from the captured 2026-08-04 workbook
// ---------------------------------------------------------------------------

const COL = {
  /** [1]: location name on a location row, staff name on a staff row. */
  label: 1,
  /** [6]: "5h, 0m" — scheduled shift length. */
  scheduledWorkTime: 6,
  /** [9]: "5h, 0m" — scheduled time less breaks. The aggregation weight. */
  workLessBreaks: 9,
  /** [10]: integer day count. Fallback weight when hours are absent. */
  daysWorked: 10,
  /** [25]: THE SALES-PER-HOUR SIGNAL. */
  salesPerHour: 25,
  /** [29]: "28m" / "1h, 5m" — average appointment length ("Chair time"). */
  avgLength: 29,
} as const;

export const STAFF_WORK_SUMMARY_REPORT = {
  key: 'staffWorkSummary',
  reportName: 'StaffWorkSummaryReport',
  reportType: 'YoureOnTime.Web.TelerikReports.StaffWorkSummary_2121, YoureOnTime.Reports',
  preferredFormat: 'XLSX' as ReportDocumentFormat,
};

export type StaffWorkSummaryParams = {
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  staffId?: number | null;
};

export type StaffWorkSummaryRow = {
  locationName: string;
  staffName: string;
  salesPerHour: number | null;
  avgLengthMinutes: number | null;
  scheduledMinutes: number | null;
  workLessBreaksMinutes: number | null;
  daysWorked: number | null;
};

export type StaffWorkSummaryResult = {
  sheetName: string | null;
  locations: string[];
  rows: StaffWorkSummaryRow[];
};

function cleanString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).replace(/\r\n/g, ' ').trim();
  return text || null;
}

function parseNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  // YOT writes "#NUM!"/"#DIV/0!" when a ratio divides by zero.
  if (trimmed.startsWith('#')) return null;
  const n = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** "28m" / "5h, 0m" → minutes. Null (not 0) when the cell is blank, so a
 *  missing average is distinguishable from a genuine zero. */
function parseDurationMinutes(value: unknown): number | null {
  const text = cleanString(value);
  if (!text) return null;
  const minutes = parseHoursWorkedToMinutes(text);
  return minutes > 0 ? minutes : null;
}

export function buildStaffWorkSummaryParameterDiscovery(
  params: StaffWorkSummaryParams,
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
    Title: 'Staff Work Summary Report',
    ReportName: STAFF_WORK_SUMMARY_REPORT.reportName,
    FrameView: 'True',
    OrganisationId: String(params.organisationId),
    ReportClass: 'StaffWorkSummary_2121',
    Key: apiKey,
  };
}

export function buildStaffWorkSummaryInstanceParams(
  params: StaffWorkSummaryParams,
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

// Header labels that appear in column [1] and must never be mistaken for a
// location or a stylist.
const NON_DATA_LABELS = new Set(['Name', 'Totals', 'Grand Total']);

export function parseStaffWorkSummaryWorkbook(
  buffer: Buffer,
  _parameterDefinitions: ReportParameterDefinition[] = [],
): StaffWorkSummaryResult {
  const sheets = readWorkbook(buffer);
  const sheet = sheets.find((s) => s.name.includes('StaffWorkSummary')) || sheets[0] || null;
  if (!sheet) return { sheetName: null, locations: [], rows: [] };

  const rows: StaffWorkSummaryRow[] = [];
  const locations: string[] = [];
  let currentLocation: string | null = null;

  for (const row of sheet.rows) {
    // The title and date rows live in column [0]; every data row leaves it
    // blank, so anything with content there is chrome.
    if (cleanString(row[0])) continue;

    const label = cleanString(row[COL.label]);
    if (!label || NON_DATA_LABELS.has(label)) continue;

    const salesPerHour = parseNumber(row[COL.salesPerHour]);
    const avgLengthMinutes = parseDurationMinutes(row[COL.avgLength]);
    const scheduledMinutes = parseDurationMinutes(row[COL.scheduledWorkTime]);
    const workLessBreaksMinutes = parseDurationMinutes(row[COL.workLessBreaks]);
    const daysWorked = parseNumber(row[COL.daysWorked]);

    /* Location header vs staff row.
     *
     * This used to key off the five mapped columns being empty, which quietly
     * turned a stylist into a location whenever they had no hours in the
     * window — and then filed every stylist below them under that person's
     * name. On 2026-08-01..09 that put all 13 World of Golf FL. stylists under
     * "Alex  Stanley", who shows only "00m" of break time in column 8; 283 of
     * 6,543 rows across the retained history had a person in the location
     * column for the same reason.
     *
     * The structural difference is that a header carries nothing but its name,
     * while a staff row always carries something somewhere — even a stylist
     * who only clocked a break. So test every column, not the mapped five. */
    const hasAnyDataCell = row.some((cell, i) => i !== COL.label && cleanString(cell) != null);
    if (!hasAnyDataCell) {
      currentLocation = label;
      if (!locations.includes(label)) locations.push(label);
      continue;
    }

    // A staff row before any location header would have nowhere to belong.
    if (!currentLocation) continue;

    rows.push({
      locationName: currentLocation,
      staffName: label,
      salesPerHour,
      avgLengthMinutes,
      scheduledMinutes,
      workLessBreaksMinutes,
      daysWorked,
    });
  }

  return { sheetName: sheet.name, locations, rows };
}
