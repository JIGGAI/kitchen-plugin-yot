// Grouping for GET /staff-retention.
//
// staff_retention_facts stores the shop name exactly as YOT's StaffRetentionDay
// report printed it on the day of the sync. When YOT renames a shop, windows
// synced before the rename keep the old spelling, and a window synced on both
// sides of it holds the shop twice. Everything downstream joins on the name
// the locations table carries today (the dashboard's ownership filter, the
// new-client cohort endpoint), so rows are returned under the canonical name.

export type RetentionLocationRow = {
  locationName: string;
  staffName: string;
  totalSales: number;
  syncedAt: string;
};

export type RetentionLocation<T> = { locationName: string; staff: T[] };

/**
 * Group one window's rows by shop, under each shop's canonical name.
 *
 * If a window holds the same shop under more than one spelling, those are
 * separate snapshots of the same report, not parts of one: the spelling synced
 * most recently is kept whole and the others are dropped. Summing them would
 * double every count, and merging them row by row would keep staff who are no
 * longer in the newer report.
 */
export function groupRetentionByLocation<T extends RetentionLocationRow>(
  rows: T[],
  canonicalName: (name: string) => string,
): RetentionLocation<T>[] {
  const bySpelling = new Map<string, { staff: T[]; newest: string }>();
  for (const r of rows) {
    const bucket = bySpelling.get(r.locationName) || { staff: [], newest: '' };
    bucket.staff.push(r);
    const syncedAt = String(r.syncedAt || '');
    if (syncedAt > bucket.newest) bucket.newest = syncedAt;
    bySpelling.set(r.locationName, bucket);
  }

  const byShop = new Map<string, { locationName: string; staff: T[]; newest: string }>();
  for (const [spelling, bucket] of bySpelling) {
    const locationName = canonicalName(spelling);
    const key = locationName.trim().replace(/\s+/g, ' ').toLowerCase();
    const incumbent = byShop.get(key);
    if (incumbent && incumbent.newest >= bucket.newest) continue;
    byShop.set(key, { locationName, staff: bucket.staff, newest: bucket.newest });
  }

  return Array.from(byShop.values())
    .sort((a, b) => a.locationName.localeCompare(b.locationName))
    .map((loc) => ({
      locationName: loc.locationName,
      staff: loc.staff
        .map((s) => (s.locationName === loc.locationName ? s : { ...s, locationName: loc.locationName }))
        .sort((a, b) => (b.totalSales - a.totalSales) || a.staffName.localeCompare(b.staffName)),
    }));
}
