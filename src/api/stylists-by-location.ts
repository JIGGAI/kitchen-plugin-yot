import { and, eq, gte, lte, isNotNull, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { initializeDatabase } from '../db';

type Db = ReturnType<typeof initializeDatabase>['db'];

export type StylistsByLocationRow = { locationId: string; stylistIds: string[] };

/**
 * Distinct stylist ids per location within an optional [startsAfter, startsBefore]
 * window. One indexed GROUP BY (no pagination, no per-row lookups) — replaces the
 * dashboard's appointment-pagination just to learn who worked where.
 * Stylist identity = COALESCE(stylist_id, staff_id).
 */
export function stylistsByLocationForRange(
  db: Db,
  teamId: string,
  filters: { startsAfter?: string | null; startsBefore?: string | null } = {},
): StylistsByLocationRow[] {
  const sid = sql<string>`COALESCE(${schema.appointments.stylistId}, ${schema.appointments.staffId})`;
  const conds = [eq(schema.appointments.teamId, teamId), isNotNull(sid)];
  if (filters.startsAfter)  conds.push(gte(schema.appointments.startAt, filters.startsAfter));
  if (filters.startsBefore) conds.push(lte(schema.appointments.startAt, filters.startsBefore));

  const rows = db.select({ locationId: schema.appointments.locationId, sid })
    .from(schema.appointments)
    .where(and(...conds))
    .groupBy(schema.appointments.locationId, sid)
    .all() as Array<{ locationId: string | null; sid: string | null }>;

  const byLoc = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.locationId || !r.sid) continue;
    const arr = byLoc.get(r.locationId) || [];
    arr.push(String(r.sid));
    byLoc.set(r.locationId, arr);
  }
  return [...byLoc.entries()].map(([locationId, stylistIds]) => ({ locationId, stylistIds }));
}
