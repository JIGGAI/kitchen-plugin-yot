import { describe, it, expect } from 'vitest';
import { parseDayOfWeekSummaryRows, buildDayOfWeekSummaryInstanceParams, WEEKDAYS } from '../reports/day-of-week-summary';
import { groupDayOfWeekSummary } from '../../api/day-of-week-summary';

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
