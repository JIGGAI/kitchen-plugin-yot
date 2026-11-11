// YoureOnTime StaffPopularity Telerik report adapter.
//
// Telerik report type:
//   "YoureOnTime.Web.TelerikReports.StaffPopularity, YoureOnTime.Reports"
//
// What the report says: for each shop, how many bookings in the window asked
// for each stylist by name, split into bookings made online and bookings made
// by the shop ("Regular"). Bookings that did not ask for anyone land on a
// per-shop "First Available" row, so a stylist's count here is NOT the number
// of appointments they performed — it is how often they were requested. That
// is why it cannot be rebuilt from the appointments table: the API's
// appointment rows carry who did the cut, not whether they were asked for.
//
// Read as CSV, not XLSX. Telerik's CSV export is denormalised: every line
// carries the title, the window, the grand totals, its shop's subtotals and
// one stylist's numbers, under a header row of textbox names. Columns are
// looked up by those names, never by position.
//
// EndDate is inclusive of the whole day when sent at midnight. Sending
// T23:59:59 makes the report include the NEXT day as well (a one-day pull
// for Oct 5 returned Oct 5 + Oct 6), so both ends go out at T00:00:00.
// Day pulls are additive: three single days summed row-for-row to the
// three-day report (342 of 342 rows, 2026-10-05..07).

import type { ReportDocumentFormat, ReportParameterDefinition } from '../client';
import { readCsv } from '../csv';

export const STAFF_POPULARITY_REPORT = {
  key: 'staffPopularity',
  reportName: 'StaffPopularityReport',
  reportType: 'YoureOnTime.Web.TelerikReports.StaffPopularity, YoureOnTime.Reports',
  preferredFormat: 'CSV' as ReportDocumentFormat,
};

/** The per-shop row for bookings that did not ask for a particular stylist. */
export const FIRST_AVAILABLE_NAME = 'First Available';

export type StaffPopularityParams = {
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  franchiseId?: number | null;
};

export type StaffPopularityRow = {
  locationName: string;
  staffName: string;
  /** True for the shop's "First Available" row (nobody was asked for). */
  firstAvailable: boolean;
  onlineBookings: number;
  regularBookings: number;
  totalBookings: number;
};

export type StaffPopularityResult = {
  sheetName: string | null;
  parameters: Array<{ name: string; type: string; isVisible: boolean; value: unknown }>;
  locations: string[];
  rows: StaffPopularityRow[];
  grandTotal: { onlineBookings: number; regularBookings: number; totalBookings: number } | null;
};

const COLUMNS = {
  location: 'locationTextBox',
  staff: 'staffNameDataTextBox',
  online: 'onlineBookingsDataTextBox',
  regular: 'regularBookingsDataTextBox',
  total: 'totalBookingsDataTextBox',
  grandOnline: 'onlineBookingsGrandTotalTextBox',
  grandRegular: 'regularBookingsGrandTotalTextBox',
  grandTotal: 'totalBookingsGrandTotalTextBox',
} as const;

function parseCount(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const n = Number(text.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// The report's own EndDate handling (see the header) means a date sent with a
// time of day silently widens the window, so the time is dropped here rather
// than trusted to the caller.
function midnight(iso: string): string {
  return `${iso.slice(0, 10)}T00:00:00`;
}

export function buildStaffPopularityParameterDiscovery(
  params: StaffPopularityParams,
  apiKey: string,
): Record<string, string> {
  return {
    DateRange: 'Custom',
    StartDate: midnight(params.startDateIso),
    EndDate: midnight(params.endDateIso),
    FranchiseId: params.franchiseId == null ? '' : String(params.franchiseId),
    LocationId: params.locationId == null ? '' : String(params.locationId),
    DoNothing: '',
    Title: 'Staff Popularity Report',
    ReportName: STAFF_POPULARITY_REPORT.reportName,
    FrameView: 'True',
    OrganisationId: String(params.organisationId),
    ReportClass: 'StaffPopularity',
    Key: apiKey,
  };
}

export function buildStaffPopularityInstanceParams(
  params: StaffPopularityParams,
): Record<string, string | number | null> {
  return {
    StartDate: midnight(params.startDateIso),
    EndDate: midnight(params.endDateIso),
    OrganisationId: params.organisationId,
    LocationId: params.locationId ?? null,
    FranchiseId: params.franchiseId ?? null,
  };
}

export function parseStaffPopularityCsv(
  buffer: Buffer | string,
  parameterDefinitions: ReportParameterDefinition[] = [],
): StaffPopularityResult {
  const parameters = parameterDefinitions.map((p) => ({
    name: p.name, type: p.type, isVisible: p.isVisible, value: p.value,
  }));
  const grid = readCsv(buffer);
  const header = grid[0] ?? [];
  const col = (name: string) => header.indexOf(name);
  const idx = {
    location: col(COLUMNS.location),
    staff: col(COLUMNS.staff),
    online: col(COLUMNS.online),
    regular: col(COLUMNS.regular),
    total: col(COLUMNS.total),
    grandOnline: col(COLUMNS.grandOnline),
    grandRegular: col(COLUMNS.grandRegular),
    grandTotal: col(COLUMNS.grandTotal),
  };
  // An empty window comes back as a header-only (or empty) document; that is
  // "no bookings", not a malformed report. A document WITH data lines but
  // without the columns we read is a changed layout and must not be stored
  // as a day of zeroes.
  const dataLines = grid.slice(1).filter((line) => line.some((cell) => cell.trim() !== ''));
  if (!dataLines.length) {
    return { sheetName: null, parameters, locations: [], rows: [], grandTotal: null };
  }
  const missing = (['location', 'staff', 'online', 'regular'] as const).filter((k) => idx[k] < 0);
  if (missing.length) {
    throw new Error(`StaffPopularity CSV is missing column(s): ${missing.map((k) => COLUMNS[k]).join(', ')}`);
  }

  const rows: StaffPopularityRow[] = [];
  const locations: string[] = [];
  let grandTotal: StaffPopularityResult['grandTotal'] = null;
  for (const line of dataLines) {
    const locationName = String(line[idx.location] ?? '').trim();
    const staffName = String(line[idx.staff] ?? '').replace(/\s+/g, ' ').trim();
    if (!locationName || !staffName) continue;
    const onlineBookings = parseCount(line[idx.online]) ?? 0;
    const regularBookings = parseCount(line[idx.regular]) ?? 0;
    const reportedTotal = idx.total >= 0 ? parseCount(line[idx.total]) : null;
    if (!locations.includes(locationName)) locations.push(locationName);
    rows.push({
      locationName,
      staffName,
      firstAvailable: staffName.toLowerCase() === FIRST_AVAILABLE_NAME.toLowerCase(),
      onlineBookings,
      regularBookings,
      totalBookings: reportedTotal ?? onlineBookings + regularBookings,
    });
    if (!grandTotal && idx.grandTotal >= 0) {
      const total = parseCount(line[idx.grandTotal]);
      if (total != null) {
        grandTotal = {
          onlineBookings: (idx.grandOnline >= 0 ? parseCount(line[idx.grandOnline]) : null) ?? 0,
          regularBookings: (idx.grandRegular >= 0 ? parseCount(line[idx.grandRegular]) : null) ?? 0,
          totalBookings: total,
        };
      }
    }
  }

  return { sheetName: 'csv', parameters, locations, rows, grandTotal };
}
