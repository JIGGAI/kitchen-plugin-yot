// Day of Week Summary: YOT's DayOfWeekSummary report grouped by shop for the
// dashboard. The report is run for the range asked for on every request —
// its columns are averages over that range, so nothing is stored.
//
// One figure is added that the report does not have: average staff per day,
// from the Staff Performance rows already stored for the same dates. It is
// counted in hours (hours worked over the shop's open hours), with the plain
// head count alongside.

import { WEEKDAYS, type DayOfWeekSummaryRow } from '../reports/reports/day-of-week-summary';

export type DayOfWeekDay = Omit<DayOfWeekSummaryRow, 'locationName'> & {
  /**
   * Full-day stylists on a typical one of this weekday, by HOURS: the hours
   * worked at the shop that day over the hours the shop is open (see
   * averageStaffHoursByWeekday). Four people each working half the open day
   * are 2. Not from the YOT report. Null when no hours exist for the weekday.
   */
  averageStaffPerDay?: number | null;
  /**
   * The plain head count behind it: staff with a Staff Performance row that
   * day, however long they worked (see averageStaffByWeekday).
   */
  averageStaffHeadcount?: number | null;
};

/** One (shop, day) head count from staff_performance_facts. */
export type StaffDayCount = { locationName: string; date: string; staffCount: number };

/** Hours worked at one shop on one date, everyone added together. */
export type StaffDayHours = { locationName: string; date: string; minutesWorked: number };

/**
 * Staff per weekday measured in hours, per shop — the way Staff Coverage
 * thinks about staffing. For each date: the minutes everyone worked at the
 * shop, divided by the minutes the shop is open that day, which is how many
 * stylists it would take to cover those hours working the whole open day.
 * Those daily figures are then averaged over the dates of each weekday on
 * which hours were recorded.
 *
 * `openMinutesForWeekday` gives the shop's open minutes (0 = Sunday); a
 * weekday it reports as closed (null or 0) yields null.
 *
 * Returns a lookup by canonical shop name → seven figures, Sunday first.
 */
export function averageStaffHoursByWeekday(
  rows: StaffDayHours[],
  canonicalName: (name: string) => string,
  openMinutesForWeekday: (weekday: number) => number | null,
): Map<string, Array<number | null>> {
  const key = (name: string) => canonicalName(String(name || '')).trim().replace(/\s+/g, ' ').toLowerCase();
  const perDate = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!row || !(Number(row.minutesWorked) > 0) || !/^\d{4}-\d{2}-\d{2}/.test(String(row.date))) continue;
    const shop = key(row.locationName);
    if (!shop) continue;
    const dates = perDate.get(shop) || new Map<string, number>();
    const date = String(row.date).slice(0, 10);
    dates.set(date, (dates.get(date) || 0) + Number(row.minutesWorked));
    perDate.set(shop, dates);
  }
  const out = new Map<string, Array<number | null>>();
  for (const [shop, dates] of perDate) {
    const totals = [0, 0, 0, 0, 0, 0, 0];
    const days = [0, 0, 0, 0, 0, 0, 0];
    for (const [date, minutes] of dates) {
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      const open = openMinutesForWeekday(weekday);
      if (!(Number(open) > 0)) continue;
      totals[weekday]! += minutes / Number(open);
      days[weekday]! += 1;
    }
    out.set(shop, totals.map((total, i) => (days[i]! > 0 ? total / days[i]! : null)));
  }
  return out;
}

/**
 * Average staff per weekday, per shop: the number of staff with a Staff
 * Performance row on a date, averaged over the dates of each weekday on which
 * the shop had anyone at all. A date with no rows is a day the shop was
 * closed (or not yet synced) and does not pull the average down.
 *
 * Returns a lookup by canonical shop name → seven averages, Sunday first,
 * null where the shop has no staffed date for that weekday.
 */
export function averageStaffByWeekday(
  counts: StaffDayCount[],
  canonicalName: (name: string) => string,
): Map<string, Array<number | null>> {
  const key = (name: string) => canonicalName(String(name || '')).trim().replace(/\s+/g, ' ').toLowerCase();
  // Two spellings of one shop on one date are the same day: add their staff.
  const perDate = new Map<string, Map<string, number>>();
  for (const row of counts) {
    if (!row || !(Number(row.staffCount) > 0) || !/^\d{4}-\d{2}-\d{2}/.test(String(row.date))) continue;
    const shop = key(row.locationName);
    if (!shop) continue;
    const dates = perDate.get(shop) || new Map<string, number>();
    const date = String(row.date).slice(0, 10);
    dates.set(date, (dates.get(date) || 0) + Number(row.staffCount));
    perDate.set(shop, dates);
  }
  const out = new Map<string, Array<number | null>>();
  for (const [shop, dates] of perDate) {
    const totals = [0, 0, 0, 0, 0, 0, 0];
    const days = [0, 0, 0, 0, 0, 0, 0];
    for (const [date, staff] of dates) {
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      totals[weekday]! += staff;
      days[weekday]! += 1;
    }
    out.set(shop, totals.map((total, i) => (days[i]! > 0 ? total / days[i]! : null)));
  }
  return out;
}

export type DayOfWeekLocation = {
  locationId: string | null;
  locationName: string;
  /** Sunday first; always seven entries, a missing weekday filled with nulls. */
  days: DayOfWeekDay[];
};

const emptyDay = (dayIndex: number): DayOfWeekDay => ({
  day: WEEKDAYS[dayIndex]!, dayIndex,
  salesCount: null, salesValue: null, averageSalesDay: null, averageSaleValue: null,
  appointmentCount: null, averageSalesPerDay: null, appointmentPctOfWeek: null,
  averageCancelled: null, averageNoShow: null, cancelledPct: null, noShowPct: null, averageWaitMinutes: null,
});

/**
 * One entry per shop, alphabetical, each with its seven weekdays in order.
 * Shops are keyed by canonical name; if the report lists a shop under two
 * spellings, the spelling with more appointments is kept rather than the two
 * being added — averages do not add.
 */
export function groupDayOfWeekSummary(
  rows: DayOfWeekSummaryRow[],
  canonicalName: (name: string) => string,
  resolveLocationId: (name: string) => string | null,
  staffByShop: Map<string, Array<number | null>> = new Map(),
  headcountByShop: Map<string, Array<number | null>> = new Map(),
): DayOfWeekLocation[] {
  const appointments = (days: Map<number, DayOfWeekDay>) => [...days.values()].reduce((a, d) => a + Number(d.appointmentCount || 0), 0);
  const bySpelling = new Map<string, Map<number, DayOfWeekDay>>();
  for (const row of rows) {
    const spelling = String(row.locationName || '').trim().replace(/\s+/g, ' ');
    if (!spelling) continue;
    const days = bySpelling.get(spelling) || new Map<number, DayOfWeekDay>();
    const { locationName: _ignored, ...day } = row;
    days.set(row.dayIndex, day);
    bySpelling.set(spelling, days);
  }
  const byShop = new Map<string, { name: string; days: Map<number, DayOfWeekDay> }>();
  for (const [spelling, days] of bySpelling) {
    const name = canonicalName(spelling).trim().replace(/\s+/g, ' ') || spelling;
    const key = name.toLowerCase();
    const existing = byShop.get(key);
    if (!existing || appointments(days) > appointments(existing.days)) byShop.set(key, { name, days });
  }
  return [...byShop.values()]
    .map(({ name, days }) => {
      const staff = staffByShop.get(name.toLowerCase()) || null;
      const headcount = headcountByShop.get(name.toLowerCase()) || null;
      return {
        locationId: resolveLocationId(name),
        locationName: name,
        days: WEEKDAYS.map((_, dayIndex) => ({
          ...(days.get(dayIndex) || emptyDay(dayIndex)),
          averageStaffPerDay: staff ? staff[dayIndex] ?? null : null,
          averageStaffHeadcount: headcount ? headcount[dayIndex] ?? null : null,
        })),
      };
    })
    .sort((a, b) => a.locationName.localeCompare(b.locationName, undefined, { sensitivity: 'base' }));
}
