import { describe, it, expect } from 'vitest';
import { parseDayOfWeekSummaryRows, buildDayOfWeekSummaryInstanceParams, WEEKDAYS } from '../reports/day-of-week-summary';
import { groupDayOfWeekSummary, averageStaffByWeekday, averageStaffHoursByWeekday } from '../../api/day-of-week-summary';

// The sheet the way Telerik lays it out: a title block, one header row with
// some labels split over two lines, a "Week Starting" row over the label
// column, then per shop a name row, a blank, seven weekday rows and a blank.
// Empty spacer columns sit between the figures. Figures are made up.
const HEADER = ['', '', '', 'Sales\r\n#', 'Sales\r\nValue', 'Average Sales Day', 'Average Sale\r\nValue', '', 'Appoint. Count', '', 'Average Sales Per Day', 'Appoint.\r\n% of week', 'Average Cancelled', '', 'Average\r\nNo Show', 'Cancelled\r\n%', 'No Show\r\n%', 'Average Wait (mins)', ''];
const blank = () => HEADER.map(() => '');
const label = (text: string) => { const row = blank(); row[1] = text; return row; };
const day = (name: string, n: number) => ['', name, '', String(n), String(n * 30), String(n * 7.5), '25.5', '', String(n + 5), '', String(n / 4), '12.5', '1.25', '', '0.5', '4', '2', '6', ''];
const closed = (name: string) => ['', name, '', '0', '', '', '', '', '0', '', '0', '0', '', '', '', '', '', '', ''];
const shop = (name: string, base: number, closedDay?: string) => [
  label(name), blank(),
  ...WEEKDAYS.map((d, i) => (d === closedDay ? closed(d) : day(d, base + i))),
  blank(),
];
const SHEET = [
  ['Day Of Week Summary', ...blank().slice(1)],
  ['Start Date:', '', '46296', ...blank().slice(3)],
  ['End Date:', '', '46326', ...blank().slice(3)],
  blank(), HEADER, label('Week Starting'), blank(), blank(),
  ...shop('Shop One', 100),
  ...shop('Shop Two', 40, 'Monday'),
];

describe('DayOfWeekSummary sheet parser', () => {
  it('reads seven weekday rows per shop, Sunday first, by header label', () => {
    const { locations, rows } = parseDayOfWeekSummaryRows(SHEET);
    expect(locations).toEqual(['Shop One', 'Shop Two']);
    expect(rows).toHaveLength(14);
    const one = rows.filter((r) => r.locationName === 'Shop One');
    expect(one.map((r) => r.day)).toEqual([...WEEKDAYS]);
    expect(one.map((r) => r.dayIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(one[0]).toMatchObject({
      salesCount: 100, salesValue: 3000, averageSalesDay: 750, averageSaleValue: 25.5,
      appointmentCount: 105, averageSalesPerDay: 25, appointmentPctOfWeek: 12.5,
      averageCancelled: 1.25, averageNoShow: 0.5, cancelledPct: 4, noShowPct: 2, averageWaitMinutes: 6,
    });
  });

  it('keeps a closed weekday as zeros and blanks, not invented averages', () => {
    const { rows } = parseDayOfWeekSummaryRows(SHEET);
    const monday = rows.find((r) => r.locationName === 'Shop Two' && r.day === 'Monday')!;
    expect(monday.salesCount).toBe(0);
    expect(monday.appointmentCount).toBe(0);
    expect(monday.averageSalesDay).toBeNull();
    expect(monday.averageSaleValue).toBeNull();
    expect(monday.averageCancelled).toBeNull();
  });

  it('follows the header labels when Telerik moves the columns', () => {
    // Drop the spacer column after the labels: every figure shifts one left.
    const shifted = SHEET.map((row) => [row[0], row[1], ...row.slice(3)]);
    const { rows } = parseDayOfWeekSummaryRows(shifted);
    expect(rows).toHaveLength(14);
    expect(rows[0]).toMatchObject({ locationName: 'Shop One', day: 'Sunday', salesCount: 100, averageSalesDay: 750 });
  });

  it('returns nothing for a sheet without the header, rather than guessing', () => {
    expect(parseDayOfWeekSummaryRows([['Something else'], ['', 'Sunday', '', '5']])).toEqual({ locations: [], rows: [] });
    expect(parseDayOfWeekSummaryRows([])).toEqual({ locations: [], rows: [] });
  });

  it('sends both dates at midnight', () => {
    const params = buildDayOfWeekSummaryInstanceParams({ startDateIso: '2026-10-01T09:30:00', endDateIso: '2026-10-31T23:59:59', organisationId: 1 });
    expect(params.StartDate).toBe('2026-10-01T00:00:00');
    expect(params.EndDate).toBe('2026-10-31T00:00:00');
  });
});

describe('grouping for the dashboard', () => {
  const canonical = (name: string) => (name.toLowerCase() === 'shop 1' ? 'Shop One' : name);

  it('gives each shop seven days in order with its location id', () => {
    const { rows } = parseDayOfWeekSummaryRows(SHEET);
    const grouped = groupDayOfWeekSummary(rows, canonical, (name) => (name === 'Shop One' ? '11' : null));
    expect(grouped.map((g) => [g.locationName, g.locationId, g.days.length])).toEqual([['Shop One', '11', 7], ['Shop Two', null, 7]]);
    expect(grouped[0]!.days.map((d) => d.day)).toEqual([...WEEKDAYS]);
    expect((grouped[0]!.days[0] as any).locationName).toBeUndefined();
  });

  it('fills a weekday the report left out with blanks', () => {
    const { rows } = parseDayOfWeekSummaryRows(SHEET);
    const grouped = groupDayOfWeekSummary(rows.filter((r) => !(r.locationName === 'Shop One' && r.day === 'Wednesday')), canonical, () => null);
    expect(grouped[0]!.days[3]).toMatchObject({ day: 'Wednesday', dayIndex: 3, salesCount: null, appointmentCount: null });
  });

  it('keeps the busier spelling of a shop listed twice instead of adding averages', () => {
    const { rows } = parseDayOfWeekSummaryRows([...SHEET, ...shop('Shop 1', 5)]);
    const grouped = groupDayOfWeekSummary(rows, canonical, () => null);
    expect(grouped.map((g) => g.locationName)).toEqual(['Shop One', 'Shop Two']);
    expect(grouped[0]!.days[0]!.salesCount).toBe(100);
  });
});

describe('average staff per weekday', () => {
  const canonical = (name: string) => (name.toLowerCase() === 'shop 1' ? 'Shop One' : name);
  // 2026-10-04 and 2026-10-11 are Sundays; 2026-10-05 is a Monday.
  const counts = [
    { locationName: 'Shop One', date: '2026-10-04', staffCount: 4 },
    { locationName: 'Shop One', date: '2026-10-11', staffCount: 6 },
    { locationName: 'Shop One', date: '2026-10-05', staffCount: 3 },
    { locationName: 'Shop Two', date: '2026-10-05', staffCount: 2 },
  ];

  it('averages the head count over the dates of each weekday the shop was staffed', () => {
    const byShop = averageStaffByWeekday(counts, canonical);
    expect(byShop.get('shop one')).toEqual([5, 3, null, null, null, null, null]);
    expect(byShop.get('shop two')).toEqual([null, 2, null, null, null, null, null]);
  });

  it('adds two spellings of one shop on the same date and ignores unusable rows', () => {
    const byShop = averageStaffByWeekday([
      ...counts,
      { locationName: 'Shop 1', date: '2026-10-05', staffCount: 1 },
      { locationName: 'Shop One', date: 'not-a-date', staffCount: 9 },
      { locationName: 'Shop One', date: '2026-10-06', staffCount: 0 },
    ], canonical);
    expect(byShop.get('shop one')).toEqual([5, 4, null, null, null, null, null]);
  });

  it('is attached to each weekday, and left empty for a shop with no staff rows', () => {
    const { rows } = parseDayOfWeekSummaryRows(SHEET);
    const headcount = averageStaffByWeekday(counts.filter((c) => c.locationName === 'Shop One'), canonical);
    const grouped = groupDayOfWeekSummary(rows, canonical, () => null, new Map([['shop one', [2.5, 1.5, null, null, null, null, null]]]), headcount);
    // The hours-based figure is the one called averageStaffPerDay; the head
    // count rides beside it.
    expect(grouped[0]!.days.map((d) => d.averageStaffPerDay)).toEqual([2.5, 1.5, null, null, null, null, null]);
    expect(grouped[0]!.days.map((d) => d.averageStaffHeadcount)).toEqual([5, 3, null, null, null, null, null]);
    expect(grouped[1]!.days.every((d) => d.averageStaffPerDay === null && d.averageStaffHeadcount === null)).toBe(true);
    // Without the lookup the field is still present, as null.
    expect(groupDayOfWeekSummary(rows, canonical, () => null)[0]!.days[0]!.averageStaffPerDay).toBeNull();
  });
});

describe('staff per weekday by hours', () => {
  const canonical = (name: string) => (name.toLowerCase() === 'shop 1' ? 'Shop One' : name);
  // Open 6 hours on Sunday, 10 on Monday, closed Tuesday.
  const open = (weekday: number) => [360, 600, null, 600, 600, 660, 480][weekday] ?? null;
  // 2026-10-04 and 2026-10-11 are Sundays; 2026-10-05 a Monday; 2026-10-06 a Tuesday.

  it('counts four people working half the open day as two stylists', () => {
    // Four stylists, 5 hours each, on a 10-hour Monday.
    const byShop = averageStaffHoursByWeekday([{ locationName: 'Shop One', date: '2026-10-05', minutesWorked: 4 * 300 }], canonical, open);
    expect(byShop.get('shop one')).toEqual([null, 2, null, null, null, null, null]);
  });

  it('averages the daily figures over the dates of the weekday that have hours', () => {
    const byShop = averageStaffHoursByWeekday([
      { locationName: 'Shop One', date: '2026-10-04', minutesWorked: 720 },  // 12h / 6h open = 2
      { locationName: 'Shop One', date: '2026-10-11', minutesWorked: 1440 }, // 24h / 6h open = 4
      { locationName: 'Shop 1', date: '2026-10-11', minutesWorked: 360 },    // same shop, same day: +1
      { locationName: 'Shop One', date: '2026-10-18', minutesWorked: 0 },    // no hours: not a staffed day
    ], canonical, open);
    expect(byShop.get('shop one')![0]).toBe((2 + 5) / 2);
  });

  it('gives nothing for a weekday the shop is closed, or a bad date', () => {
    const byShop = averageStaffHoursByWeekday([
      { locationName: 'Shop One', date: '2026-10-06', minutesWorked: 600 },
      { locationName: 'Shop One', date: 'nope', minutesWorked: 600 },
    ], canonical, open);
    expect(byShop.get('shop one')).toEqual([null, null, null, null, null, null, null]);
  });
});
