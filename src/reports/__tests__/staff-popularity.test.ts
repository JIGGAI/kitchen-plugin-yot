import { describe, it, expect } from 'vitest';
import {
  buildStaffPopularityInstanceParams,
  buildStaffPopularityParameterDiscovery,
  parseStaffPopularityCsv,
} from '../reports/staff-popularity';

// Telerik's CSV for StaffPopularity is denormalised: every line repeats the
// title, window, grand totals and its shop's subtotals beside one stylist's
// numbers. This is the real header row with made-up people.
const HEADER = 'titleTextBox,startDateLabelTextBox,startDateValueTextBox,endDateLabelTextBox,endDateValueTextBox,headerStaffTextBox,headerOnlineBookingsTextBox,headerRegularBookingsTextBox,headerTotalBookingsTextBox,grandTotalLabelTextBox,onlineBookingsGrandTotalTextBox,regularBookingsGrandTotalTextBox,totalBookingsGrandTotalTextBox,locationTextBox,totalLabelTextBox,onlineBookingsSubTotalTextBox,regularBookingsSubTotalTextBox,totalBookingsSubTotalTextBox,staffNameDataTextBox,onlineBookingsDataTextBox,regularBookingsDataTextBox,totalBookingsDataTextBox';
const line = (location: string, sub: [string, string, string], staff: string, online: string, regular: string, total: string) =>
  `Staff Popularity Report,Start Date:,"Thursday, October 1, 2026",End Date:,"Saturday, October 31, 2026",Staff Name,Online Bookings,Regular Bookings,Total Bookings,Grand Total,"17,693","11,085","28,778",${location},Total,${sub.map((v) => `"${v}"`).join(',')},${staff},"${online}","${regular}","${total}"`;
const CSV = '﻿' + [
  HEADER,
  line('Shop One MI', ['1,338', '465', '1,803'], 'Stylist  One', '1,153', '10', '1,163'),
  line('Shop One MI', ['1,338', '465', '1,803'], 'Unused Account', '0', '0', '0'),
  line('Shop One MI', ['1,338', '465', '1,803'], 'First Available', '185', '455', '640'),
  line('Shop Two MI', ['10', '15', '25'], 'Stylist Two', '10', '15', '25'),
].join('\r\n') + '\r\n';

describe('parseStaffPopularityCsv', () => {
  it('reads one row per stylist, with thousands separators and doubled spaces handled', () => {
    const parsed = parseStaffPopularityCsv(Buffer.from(CSV, 'utf8'));
    expect(parsed.locations).toEqual(['Shop One MI', 'Shop Two MI']);
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.rows[0]).toEqual({
      locationName: 'Shop One MI', staffName: 'Stylist One', firstAvailable: false,
      onlineBookings: 1153, regularBookings: 10, totalBookings: 1163,
    });
    expect(parsed.grandTotal).toEqual({ onlineBookings: 17693, regularBookings: 11085, totalBookings: 28778 });
  });

  it('flags the shop\'s First Available row instead of treating it as a person', () => {
    const parsed = parseStaffPopularityCsv(CSV);
    const fa = parsed.rows.filter((r) => r.firstAvailable);
    expect(fa).toHaveLength(1);
    expect(fa[0]).toMatchObject({ locationName: 'Shop One MI', onlineBookings: 185, regularBookings: 455 });
  });

  it('finds columns by name, so a reordered export still parses', () => {
    const reordered = [
      'staffNameDataTextBox,locationTextBox,regularBookingsDataTextBox,onlineBookingsDataTextBox',
      'Stylist One,Shop One MI,4,6',
    ].join('\n');
    expect(parseStaffPopularityCsv(reordered).rows[0]).toMatchObject({
      staffName: 'Stylist One', locationName: 'Shop One MI', onlineBookings: 6, regularBookings: 4, totalBookings: 10,
    });
  });

  it('an empty window is no rows, not an error', () => {
    expect(parseStaffPopularityCsv('').rows).toEqual([]);
    expect(parseStaffPopularityCsv(HEADER + '\r\n').rows).toEqual([]);
  });

  it('throws on a changed layout rather than storing a day of zeroes', () => {
    expect(() => parseStaffPopularityCsv('Staff,Shop,Online\nStylist One,Shop One MI,5\n')).toThrow(/missing column/);
  });
});

describe('StaffPopularity parameters', () => {
  // Sent with a time of day, EndDate makes the report include the next day too.
  it('sends both ends at midnight whatever the caller passed', () => {
    const params = { startDateIso: '2026-10-05T00:00:00', endDateIso: '2026-10-05T23:59:59', organisationId: 11082 };
    expect(buildStaffPopularityInstanceParams(params)).toEqual({
      StartDate: '2026-10-05T00:00:00', EndDate: '2026-10-05T00:00:00',
      OrganisationId: 11082, LocationId: null, FranchiseId: null,
    });
    const discovery = buildStaffPopularityParameterDiscovery(params, 'k');
    expect(discovery.EndDate).toBe('2026-10-05T00:00:00');
    expect(discovery.ReportName).toBe('StaffPopularityReport');
  });
});
