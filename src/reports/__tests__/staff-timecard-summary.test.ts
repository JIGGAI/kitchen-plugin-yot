import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  STAFF_TIMECARD_SUMMARY_REPORT,
  buildStaffTimecardSummaryParameterDiscovery,
  buildStaffTimecardSummaryInstanceParams,
  parseStaffTimecardSummaryWorkbook,
} from '../reports/staff-timecard-summary';

const fixturePath = join(__dirname, 'fixtures', 'staff-timecard-summary-sample.xlsx');
const fixtureBuffer = readFileSync(fixturePath);

// ---------------------------------------------------------------------------
// Report constant assertions
// ---------------------------------------------------------------------------

describe('STAFF_TIMECARD_SUMMARY_REPORT', () => {
  it('has the correct reportName', () => {
    expect(STAFF_TIMECARD_SUMMARY_REPORT.reportName).toBe('StaffTimeCardSummaryReport');
  });

  it('has the correct reportType', () => {
    expect(STAFF_TIMECARD_SUMMARY_REPORT.reportType).toBe(
      'YoureOnTime.Web.TelerikReports.StaffTimeCardSummary, YoureOnTime.Reports',
    );
  });

  it('has preferredFormat XLSX', () => {
    expect(STAFF_TIMECARD_SUMMARY_REPORT.preferredFormat).toBe('XLSX');
  });

  it('has key staffTimecardSummary', () => {
    expect(STAFF_TIMECARD_SUMMARY_REPORT.key).toBe('staffTimecardSummary');
  });
});

// ---------------------------------------------------------------------------
// Parameter discovery builder
// ---------------------------------------------------------------------------

describe('buildStaffTimecardSummaryParameterDiscovery', () => {
  const params = {
    startDateIso: '2026-05-08T00:00:00.000Z',
    endDateIso: '2026-05-10T23:59:59.000Z',
    organisationId: 12345,
    locationId: 7,
    staffId: null,
  };
  const apiKey = 'test-api-key-abc123';

  it('strips .000Z from dates', () => {
    const result = buildStaffTimecardSummaryParameterDiscovery(params, apiKey);
    expect(result.StartDate).toBe('2026-05-08T00:00:00');
    expect(result.EndDate).toBe('2026-05-10T23:59:59');
  });

  it('sets DateRange to Custom', () => {
    const result = buildStaffTimecardSummaryParameterDiscovery(params, apiKey);
    expect(result.DateRange).toBe('Custom');
  });

  it('sets ReportClass to StaffTimeCardSummary', () => {
    const result = buildStaffTimecardSummaryParameterDiscovery(params, apiKey);
    expect(result.ReportClass).toBe('StaffTimeCardSummary');
  });

  it('stringifies OrganisationId', () => {
    const result = buildStaffTimecardSummaryParameterDiscovery(params, apiKey);
    expect(result.OrganisationId).toBe('12345');
  });

  it('passes LocationId as string', () => {
    const result = buildStaffTimecardSummaryParameterDiscovery(params, apiKey);
    expect(result.LocationId).toBe('7');
  });

  it('passes StaffId as empty string when null', () => {
    const result = buildStaffTimecardSummaryParameterDiscovery(params, apiKey);
    expect(result.StaffId).toBe('');
  });

  it('passes the api key', () => {
    const result = buildStaffTimecardSummaryParameterDiscovery(params, apiKey);
    expect(result.Key).toBe(apiKey);
  });

  it('has the correct report title', () => {
    const result = buildStaffTimecardSummaryParameterDiscovery(params, apiKey);
    expect(result.Title).toBe('Staff Hours Summary Report');
  });

  it('has ReportName matching the constant', () => {
    const result = buildStaffTimecardSummaryParameterDiscovery(params, apiKey);
    expect(result.ReportName).toBe(STAFF_TIMECARD_SUMMARY_REPORT.reportName);
  });

  it('has FrameView set to True', () => {
    const result = buildStaffTimecardSummaryParameterDiscovery(params, apiKey);
    expect(result.FrameView).toBe('True');
  });

  it('sets LateArrivals to -14 (YOT UI threshold the business uses) and leaves EarlyLeavers/DoNothing empty', () => {
    const result = buildStaffTimecardSummaryParameterDiscovery(params, apiKey);
    expect(result.LateArrivals).toBe('-14');
    expect(result.EarlyLeavers).toBe('');
    expect(result.DoNothing).toBe('');
  });

  it('sets FranchiseId to empty string', () => {
    const result = buildStaffTimecardSummaryParameterDiscovery(params, apiKey);
    expect(result.FranchiseId).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Instance params builder
// ---------------------------------------------------------------------------

describe('buildStaffTimecardSummaryInstanceParams', () => {
  it('strips .000Z from dates', () => {
    const params = {
      startDateIso: '2026-05-08T00:00:00.000Z',
      endDateIso: '2026-05-10T23:59:59.000Z',
      organisationId: 999,
    };
    const result = buildStaffTimecardSummaryInstanceParams(params);
    expect(result.StartDate).toBe('2026-05-08T00:00:00');
    expect(result.EndDate).toBe('2026-05-10T23:59:59');
  });

  it('passes OrganisationId as a number', () => {
    const params = {
      startDateIso: '2026-05-08T00:00:00.000Z',
      endDateIso: '2026-05-10T23:59:59.000Z',
      organisationId: 999,
    };
    const result = buildStaffTimecardSummaryInstanceParams(params);
    expect(result.OrganisationId).toBe(999);
  });

  it('maps undefined locationId to null', () => {
    const params = {
      startDateIso: '2026-05-08T00:00:00.000Z',
      endDateIso: '2026-05-10T23:59:59.000Z',
      organisationId: 999,
    };
    const result = buildStaffTimecardSummaryInstanceParams(params);
    expect(result.LocationId).toBeNull();
  });

  it('passes numeric locationId through', () => {
    const params = {
      startDateIso: '2026-05-08T00:00:00.000Z',
      endDateIso: '2026-05-10T23:59:59.000Z',
      organisationId: 999,
      locationId: 42,
    };
    const result = buildStaffTimecardSummaryInstanceParams(params);
    expect(result.LocationId).toBe(42);
  });

  it('passes null locationId through as null', () => {
    const params = {
      startDateIso: '2026-05-08T00:00:00.000Z',
      endDateIso: '2026-05-10T23:59:59.000Z',
      organisationId: 999,
      locationId: null,
    };
    const result = buildStaffTimecardSummaryInstanceParams(params);
    expect(result.LocationId).toBeNull();
  });

  it('sets LateArrivals to -14 and leaves FranchiseId/EarlyLeavers null', () => {
    const params = {
      startDateIso: '2026-05-08T00:00:00.000Z',
      endDateIso: '2026-05-10T23:59:59.000Z',
      organisationId: 999,
    };
    const result = buildStaffTimecardSummaryInstanceParams(params);
    expect(result.FranchiseId).toBeNull();
    expect(result.LateArrivals).toBe(-14);
    expect(result.EarlyLeavers).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Workbook parser — against real XLSX fixture
// ---------------------------------------------------------------------------

describe('parseStaffTimecardSummaryWorkbook (fixture)', () => {
  // Parse once; assertions re-use the same result.
  const result = parseStaffTimecardSummaryWorkbook(fixtureBuffer);

  it('reads the correct sheet name', () => {
    expect(result.sheetName).toBe('StaffTimeCard');
  });

  it('discovers at least one location', () => {
    expect(result.locations.length).toBeGreaterThan(0);
  });

  it('excludes the ** OFFICE ** pseudo-location', () => {
    for (const loc of result.locations) {
      expect(loc.toUpperCase()).not.toMatch(/^\*+\s*OFFICE\s*\*+$/);
      expect(loc.trim().toUpperCase()).not.toBe('OFFICE');
    }
  });

  it('returns at least 100 shift rows (3-day full-org pull)', () => {
    expect(result.rows.length).toBeGreaterThanOrEqual(100);
  });

  it('every shift row has a non-null locationName', () => {
    for (const row of result.rows) {
      expect(row.locationName).not.toBeNull();
    }
  });

  it('every shift row has a non-null staffName', () => {
    for (const row of result.rows) {
      expect(row.staffName).not.toBeNull();
    }
  });

  it('every shift row has a shiftDate matching YYYY-MM-DD', () => {
    for (const row of result.rows) {
      expect(row.shiftDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('every row has rowKind === shift', () => {
    for (const row of result.rows) {
      expect(row.rowKind).toBe('shift');
    }
  });

  it('at least one shift has arrivedMinutes > 0 (someone was late)', () => {
    const lateShifts = result.rows.filter((r) => r.arrivedMinutes != null && r.arrivedMinutes > 0);
    expect(lateShifts.length).toBeGreaterThan(0);
  });

  it('arrivedMinutes is always null or a finite number', () => {
    // Real shifts may have null arrivedMinutes when the stylist was unscheduled
    // (clocked in but had no scheduled start — col[12] is empty).
    // Phantoms (no clock-in) are filtered before push, so this assertion holds
    // for all emitted shift rows: when non-null, arrivedMinutes must be finite.
    for (const row of result.rows) {
      if (row.arrivedMinutes != null) {
        expect(Number.isFinite(row.arrivedMinutes)).toBe(true);
      }
    }
  });

  it('filters out phantom rows (stylist listed in a location block but did not work there)', () => {
    // The captured 3-day fixture has 34 locations and lists every stylist in
    // every block. Before the phantom filter, 97%+ of shift-row candidates are
    // phantoms (empty clock-in). After filtering, only real clock-ins remain.
    const shifts = result.rows.filter((r) => r.rowKind === 'shift');
    // Sanity: there are real shifts.
    expect(shifts.length).toBeGreaterThan(50);
    // The fixture has ~286 real shifts out of ~9765 candidates. The filter must
    // reduce the count dramatically — well under 1000.
    expect(shifts.length).toBeLessThan(1000);
    // Every emitted shift row has raw[2] (clock-in) as a non-empty value.
    // We verify this indirectly: every row must have a valid shiftDate (only
    // reachable if the row passed the isShiftRow + clock-in checks).
    for (const s of shifts) {
      expect(s.shiftDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('no shift rows have a location from the OFFICE pseudo-location', () => {
    for (const row of result.rows) {
      if (row.locationName != null) {
        expect(row.locationName.toUpperCase()).not.toMatch(/^\*+\s*OFFICE\s*\*+$/);
        expect(row.locationName.trim().toUpperCase()).not.toBe('OFFICE');
      }
    }
  });

  it('has parameters array (may be empty when no definitions supplied)', () => {
    expect(Array.isArray(result.parameters)).toBe(true);
  });
});
