import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  STAFF_RETENTION_DAY_REPORT,
  buildStaffRetentionDayParameterDiscovery,
  buildStaffRetentionDayInstanceParams,
  parseStaffRetentionDayWorkbook,
} from '../reports/staff-retention-day';

const fixturePath = join(__dirname, 'fixtures', 'staff-retention-day-sample.xlsx');
const fixtureBuffer = readFileSync(fixturePath);

describe('STAFF_RETENTION_DAY_REPORT', () => {
  it('has the correct identifiers', () => {
    expect(STAFF_RETENTION_DAY_REPORT.reportName).toBe('StaffRetentionDayReport');
    expect(STAFF_RETENTION_DAY_REPORT.reportType).toBe(
      'YoureOnTime.Web.TelerikReports.StaffRetentionDay, YoureOnTime.Reports',
    );
    expect(STAFF_RETENTION_DAY_REPORT.preferredFormat).toBe('XLSX');
    expect(STAFF_RETENTION_DAY_REPORT.key).toBe('staffRetentionDay');
  });
});

describe('buildStaffRetentionDayParameterDiscovery', () => {
  const params = {
    startDateIso: '2026-05-04T00:00:00.000Z',
    endDateIso: '2026-05-10T23:59:59.000Z',
    organisationId: 11082,
    locationId: null,
    staffId: null,
    franchiseId: null,
  };

  it('strips .000Z from dates and sets Custom DateRange', () => {
    const r = buildStaffRetentionDayParameterDiscovery(params, 'k');
    expect(r.StartDate).toBe('2026-05-04T00:00:00');
    expect(r.EndDate).toBe('2026-05-10T23:59:59');
    expect(r.DateRange).toBe('Custom');
  });

  it('uses empty strings for null filters and passes through the API key', () => {
    const r = buildStaffRetentionDayParameterDiscovery(params, 'k');
    expect(r.LocationId).toBe('');
    expect(r.StaffId).toBe('');
    expect(r.FranchiseId).toBe('');
    expect(r.Key).toBe('k');
  });

  it('serializes set filters as decimal strings', () => {
    const r = buildStaffRetentionDayParameterDiscovery(
      { ...params, locationId: 42, franchiseId: 7 },
      'k',
    );
    expect(r.LocationId).toBe('42');
    expect(r.FranchiseId).toBe('7');
  });
});

describe('buildStaffRetentionDayInstanceParams', () => {
  it('returns nulls for unset filters', () => {
    const r = buildStaffRetentionDayInstanceParams({
      startDateIso: '2026-05-04T00:00:00.000Z',
      endDateIso: '2026-05-10T23:59:59.000Z',
      organisationId: 11082,
    });
    expect(r.LocationId).toBeNull();
    expect(r.StaffId).toBeNull();
    expect(r.FranchiseId).toBeNull();
    expect(r.OrganisationId).toBe(11082);
  });
});

describe('parseStaffRetentionDayWorkbook', () => {
  const result = parseStaffRetentionDayWorkbook(fixtureBuffer);

  it('reads from the Retention sheet', () => {
    expect(result.sheetName).toBe('Retention');
  });

  it('extracts trailing-month labels from row 7', () => {
    // The captured fixture is for the week ending 2026-05-10, so the labels
    // are Apr-26 / Mar-26 / Feb-26.
    expect(result.trailingMonthLabels.m1).toBe('Apr-26');
    expect(result.trailingMonthLabels.m2).toBe('Mar-26');
    expect(result.trailingMonthLabels.m3).toBe('Feb-26');
  });

  it('discovers locations from header rows', () => {
    expect(result.locations.length).toBeGreaterThan(5);
    expect(result.locations).toContain('Auburn Hills MI');
  });

  it('emits one row per (location, staff)', () => {
    expect(result.rows.length).toBeGreaterThan(20);
    const auburn = result.rows.filter((r) => r.locationName === 'Auburn Hills MI');
    expect(auburn.length).toBeGreaterThan(5);
    const abbigail = auburn.find((r) => r.staffName === 'Abbigail Ward');
    expect(abbigail).toBeDefined();
    expect(abbigail!.totalSales).toBe(10);
    expect(abbigail!.returnedToStaff).toEqual({ count: 1, pct: 10 });
    expect(abbigail!.returnedToBusiness).toEqual({ count: 8, pct: 80 });
    expect(abbigail!.newClients).toEqual({ count: 1, pct: 10 });
    expect(abbigail!.totalRebooked).toEqual({ count: 1, pct: 10 });
    expect(abbigail!.newClientsRebooked).toEqual({ count: 0, pct: 0 });
    expect(abbigail!.retention1MonthBack).toEqual({ count: 1, pct: 2 });
    expect(abbigail!.retention2MonthsBack).toEqual({ count: 3, pct: 12 });
    expect(abbigail!.retention3MonthsBack).toEqual({ count: 0, pct: 0 });
  });

  it('captures per-location subtotals', () => {
    const auburnTotal = result.locationTotals.find((t) => t.locationName === 'Auburn Hills MI');
    expect(auburnTotal).toBeDefined();
    expect(auburnTotal!.totalSales).toBe(227);
    expect(auburnTotal!.returnedToStaff).toEqual({ count: 28, pct: 12 });
    expect(auburnTotal!.returnedToBusiness).toEqual({ count: 166, pct: 73 });
  });

  it('handles "Total" label without picking it as a staff row', () => {
    // No staffName should be "Total"
    expect(result.rows.find((r) => r.staffName === 'Total')).toBeUndefined();
  });
});
