// YoureOnTime StaffTimeCardSummary Telerik report adapter.
//
// Telerik report type:
//   "YoureOnTime.Web.TelerikReports.StaffTimeCardSummary, YoureOnTime.Reports"
//
// Sheet name: "StaffTimeCard" (NOT "StaffTimeCardSummary" — the plan placeholder was wrong;
// confirmed from the captured XLSX fixture in sample-staff-timecard-findings.md).
//
// The workbook is 26 columns wide. Layout repeats for each location → each staff member:
//
//   [location header row]  col[0] = location name, other cols empty
//   [staff name row]       col[0] = '', col[1] = staff name, other cols empty
//   [subheader A row]      col[11] = "Scheduled" (skip)
//   [subheader B row]      empty / merge row (skip)
//   [column header row]    col[0] = "Date" (skip)
//   [shift data rows...]   col[0] matches /^\d{4,6}$/ (Excel serial date)
//   [staff summary row]    col[1] matches /^\d+ days scheduled/ (skip)
//   [blank separator]      skip
//
// Column positions — locked from the captured fixture (findings doc):
//
//   COL.shiftDate         [0]   Excel serial integer (days since 1899-12-30)
//   COL.clockIn           [2]   Excel time fraction; (value % 1) * 24 = hour of day
//   COL.clockOut          [3]   Excel time fraction (not required for late-arrivals feature)
//   COL.scheduledStart    [12]  "HH:MM" text string
//   COL.arrivedMinutes    [19]  Signed integer minutes (+= late, 0 = on time)
//   COL.departureMinutes  [21]  Signed integer minutes (not required for late-arrivals feature)
//
// The ** OFFICE ** pseudo-location (and variants) is excluded — it groups admin staff, not a
// real shop location.

import type { ReportDocumentFormat, ReportParameterDefinition } from '../client';
import { readWorkbook } from '../xlsx';

// ---------------------------------------------------------------------------
// Column position constants — match the findings doc exactly
// ---------------------------------------------------------------------------

const COL = {
  // col[0]: shift date as Excel serial integer (e.g. 46150 = 2026-05-08)
  shiftDate: 0,
  // col[2]: actual clock-in as Excel time fraction (integer part 1; frac * 24 = hour)
  clockIn: 2,
  // col[3]: actual clock-out as Excel time fraction
  clockOut: 3,
  // col[12]: scheduled start time as "HH:MM" text string
  scheduledStart: 12,
  // col[19]: punctuality — arrival in signed minutes (+= late). THE LATE SIGNAL.
  arrivedMinutes: 19,
  // col[21]: punctuality — departure in signed minutes (not required here)
  departureMinutes: 21,
} as const;

// ---------------------------------------------------------------------------
// Report descriptor
// ---------------------------------------------------------------------------

export const STAFF_TIMECARD_SUMMARY_REPORT = {
  key: 'staffTimecardSummary',
  reportName: 'StaffTimeCardSummaryReport',
  reportType: 'YoureOnTime.Web.TelerikReports.StaffTimeCardSummary, YoureOnTime.Reports',
  preferredFormat: 'XLSX' as ReportDocumentFormat,
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StaffTimecardSummaryParams = {
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  staffId?: number | null;
};

export type StaffTimecardSummaryShiftRow = {
  locationName: string | null;
  staffName: string | null;
  rowKind: 'shift';
  shiftDate: string | null;       // YYYY-MM-DD
  arrivedMinutes: number | null;  // signed int; + = late, 0 = on time, null = no clock-in data
  raw: unknown[];
};

export type StaffTimecardSummaryResult = {
  sheetName: string | null;
  parameters: Array<{ name: string; type: string; isVisible: boolean; value: unknown }>;
  locations: string[];
  rows: StaffTimecardSummaryShiftRow[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an Excel date serial to an ISO date string (YYYY-MM-DD).
 * Excel serials count days from 1899-12-30 (the epoch used by adm-zip's raw output).
 * Formula: JS timestamp = (serial - 25569) * 86400000
 */
function excelSerialToIsoDate(serial: string | number): string {
  const n = Math.round(Number(serial));
  if (!Number.isFinite(n)) return '';
  return new Date((n - 25569) * 86400000).toISOString().slice(0, 10);
}

/**
 * Parse a raw cell value as a signed integer (minutes).
 * Returns null if the value is absent, empty, or non-numeric.
 */
function parseIntOrNull(value: unknown): number | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Returns true when a location name string is the ** OFFICE ** pseudo-location
 * (or close variants like *OFFICE*, OFFICE).
 */
function isOfficePseudoLocation(name: string): boolean {
  const upper = name.trim().toUpperCase();
  // Exact pseudo-location patterns we've observed or that could appear
  if (/^\*+\s*OFFICE\s*\*+$/.test(upper)) return true;
  if (upper === 'OFFICE') return true;
  return false;
}

/**
 * Returns true when a row is a shift data row.
 * The shift date column (col[0]) contains a 4-6 digit Excel serial integer.
 */
function isShiftRow(row: string[]): boolean {
  const col0 = (row[COL.shiftDate] ?? '').trim();
  return /^\d{4,6}$/.test(col0);
}

/**
 * Returns true when the row is a staff-name row:
 * col[0] is empty, col[1] is a non-empty staff name, remaining cols are empty.
 */
function isStaffNameRow(row: string[]): boolean {
  const col0 = (row[0] ?? '').trim();
  const col1 = (row[1] ?? '').trim();
  if (col0 !== '') return false;
  if (!col1) return false;
  // Staff summary rows have col[1] like "N days scheduled, N days worked" — exclude those
  if (/^\d+ days scheduled/.test(col1)) return false;
  // Subheader A rows have col[11] = "Scheduled" — different structure
  if ((row[11] ?? '').trim() === 'Scheduled') return false;
  return true;
}

/**
 * Returns true when the row is a location header row:
 * col[0] is a non-empty name, and cols[1..25] are all empty.
 */
function isLocationHeaderRow(row: string[]): boolean {
  const col0 = (row[0] ?? '').trim();
  if (!col0) return false;
  // Column header row has col[0] = "Date" — exclude it
  if (col0 === 'Date') return false;
  // Preamble rows we want to skip
  if (col0 === 'Start Date:' || col0 === 'End Date:') return false;
  if (col0 === 'Staff Hours Summary Report') return false;
  // Shift rows have a numeric col[0]
  if (/^\d{4,6}$/.test(col0)) return false;
  // Check that the rest of the row is empty (location header is a label-only row)
  for (let i = 1; i <= 25; i++) {
    if ((row[i] ?? '').trim() !== '') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Parameter builders
// ---------------------------------------------------------------------------

export function buildStaffTimecardSummaryParameterDiscovery(
  params: StaffTimecardSummaryParams,
  apiKey: string,
): Record<string, string> {
  return {
    DateRange: 'Custom',
    StartDate: params.startDateIso.replace('.000Z', ''),
    EndDate: params.endDateIso.replace('.000Z', ''),
    FranchiseId: '',
    LocationId: params.locationId == null ? '' : String(params.locationId),
    StaffId: params.staffId == null ? '' : String(params.staffId),
    LateArrivals: '',
    EarlyLeavers: '',
    DoNothing: '',
    Title: 'Staff Hours Summary Report',
    ReportName: STAFF_TIMECARD_SUMMARY_REPORT.reportName,
    FrameView: 'True',
    OrganisationId: String(params.organisationId),
    ReportClass: 'StaffTimeCardSummary',
    Key: apiKey,
  };
}

export function buildStaffTimecardSummaryInstanceParams(
  params: StaffTimecardSummaryParams,
): Record<string, string | number | null> {
  return {
    StartDate: params.startDateIso.replace('.000Z', ''),
    EndDate: params.endDateIso.replace('.000Z', ''),
    OrganisationId: params.organisationId,
    LocationId: params.locationId ?? null,
    StaffId: params.staffId ?? null,
    FranchiseId: null,
    LateArrivals: null,
    EarlyLeavers: null,
  };
}

// ---------------------------------------------------------------------------
// Workbook parser
// ---------------------------------------------------------------------------

export function parseStaffTimecardSummaryWorkbook(
  buffer: Buffer,
  parameterDefinitions: ReportParameterDefinition[] = [],
): StaffTimecardSummaryResult {
  const sheets = readWorkbook(buffer);
  const sheet = sheets.find((s) => s.name === 'StaffTimeCard') || sheets[0] || null;

  if (!sheet) {
    return { sheetName: null, parameters: [], locations: [], rows: [] };
  }

  const rows: StaffTimecardSummaryShiftRow[] = [];
  const locations: string[] = [];
  let currentLocation: string | null = null;
  let currentStaff: string | null = null;
  // Track whether the current staff+location block is inside an OFFICE pseudo-location.
  let inOfficeBlock = false;

  for (const row of sheet.rows) {
    // --- Location header row ---
    if (isLocationHeaderRow(row)) {
      const locationName = row[0].trim();
      currentLocation = locationName;
      currentStaff = null;
      inOfficeBlock = isOfficePseudoLocation(locationName);
      if (!inOfficeBlock && !locations.includes(locationName)) {
        locations.push(locationName);
      }
      continue;
    }

    // --- Staff name row ---
    if (isStaffNameRow(row)) {
      currentStaff = row[1].trim() || null;
      continue;
    }

    // --- Skip rows while inside OFFICE block ---
    if (inOfficeBlock) continue;

    // --- Shift data row ---
    if (isShiftRow(row)) {
      // Phantom row: stylist appears in this location's block but did not work
      // here on this date (no clock-in). The StaffTimeCard report lists every
      // stylist in every location block, so 90%+ of shift rows are phantoms.
      // We only care about real clock-ins for late-arrival tracking.
      const clockInRaw = row[COL.clockIn];
      const clockInStr = clockInRaw == null ? '' : String(clockInRaw).trim();
      if (!clockInStr) continue;

      const shiftDate = excelSerialToIsoDate(row[COL.shiftDate]);
      const arrivedMinutes = parseIntOrNull(row[COL.arrivedMinutes]);

      rows.push({
        locationName: currentLocation,
        staffName: currentStaff,
        rowKind: 'shift',
        shiftDate: shiftDate || null,
        arrivedMinutes,
        raw: row,
      });
      continue;
    }

    // All other rows (preamble, subheaders, column headers, staff summaries,
    // blank separators) are silently skipped.
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
