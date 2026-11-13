// Day of Week Summary: YOT's DayOfWeekSummary report grouped by shop for the
// dashboard. The report is run for the range asked for on every request —
// its columns are averages over that range, so nothing is stored.

import { WEEKDAYS, type DayOfWeekSummaryRow } from '../reports/reports/day-of-week-summary';

export type DayOfWeekDay = Omit<DayOfWeekSummaryRow, 'locationName'>;

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
    .map(({ name, days }) => ({
      locationId: resolveLocationId(name),
      locationName: name,
      days: WEEKDAYS.map((_, dayIndex) => days.get(dayIndex) || emptyDay(dayIndex)),
    }))
    .sort((a, b) => a.locationName.localeCompare(b.locationName, undefined, { sensitivity: 'base' }));
}
