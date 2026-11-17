// Helpers for read endpoints whose facts are keyed by the shop name a YOT
// report printed on the day of the sync. YOT renames shops, so one shop's
// history can sit under several spellings; consumers join on the name the
// locations table carries today. `canonicalName` is canonicalLocationName
// from handler.ts, passed in to keep this module free of handler imports.

type CanonicalName = (name: string) => string;

const shopKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export type MonthlyStaffPerformanceRow = {
  locationName: string;
  staffName: string;
  yearMonth: string;
  totalSalesValue: number;
  totalSalesCount: number;
};

/**
 * Rename every row's shop to its canonical name and sum rows that land on the
 * same (shop, stylist, month). Days are disjoint across a rename, so summing
 * is exact. Staff names are left as printed; only the shop is folded.
 */
export function mergeMonthlyStaffPerformance(
  rows: MonthlyStaffPerformanceRow[],
  canonicalName: CanonicalName,
): MonthlyStaffPerformanceRow[] {
  const merged = new Map<string, MonthlyStaffPerformanceRow>();
  for (const row of rows) {
    const locationName = canonicalName(row.locationName);
    const key = `${shopKey(locationName)}::${row.staffName}::${row.yearMonth}`;
    const existing = merged.get(key);
    if (existing) {
      existing.totalSalesValue += Number(row.totalSalesValue) || 0;
      existing.totalSalesCount += Number(row.totalSalesCount) || 0;
    } else {
      merged.set(key, { ...row, locationName });
    }
  }
  return [...merged.values()];
}

/**
 * Return rows with each shop under its canonical name, in the same order.
 * When `onlyLocation` is given, keep the rows for that shop, whichever
 * spelling the caller or the stored row uses.
 */
export function canonicalizeRowLocations<T extends { locationName: string | null }>(
  rows: T[],
  canonicalName: CanonicalName,
  onlyLocation?: string | null,
): T[] {
  const wanted = onlyLocation ? shopKey(canonicalName(onlyLocation)) : null;
  const out: T[] = [];
  for (const row of rows) {
    const locationName = row.locationName == null ? null : canonicalName(row.locationName);
    if (wanted && (locationName == null || shopKey(locationName) !== wanted)) continue;
    out.push(locationName === row.locationName ? row : { ...row, locationName });
  }
  return out;
}
