import { and, desc, eq, gte, lte, or, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { initializeDatabase } from '../db';

type Db = ReturnType<typeof initializeDatabase>['db'];

export type AppointmentFilters = {
  locationId?: string | null;
  stylistId?: string | null;
  clientId?: string | null;
  appointmentId?: string | null;
  statusCode?: string | null;
  categoryId?: string | null;
  search?: string | null;
  startsAfter?: string | null;
  startsBefore?: string | null;
};

export type AppointmentListResult = {
  rows: schema.Appointment[];
  total: number;
};

// Pushes filters into Drizzle WHERE clauses so the indexed
// (team_id, start_at) / (team_id, location_id, start_at) /
// (team_id, stylist_id, start_at) indexes carry the load. The previous
// implementation loaded every team row into JS and filtered in memory,
// which made paginated /appointments calls O(N × pages) over an 84K-row
// table — the root cause of the dashboard's 30s+ load times.
//
// `search` still drops to JS because it spans joined fields (clientName,
// stylistName, locationName, serviceName) that need lookups; cheap to
// post-filter once the SQL where-clause has narrowed the working set.
export function listAppointmentsForRequest(
  db: Db,
  teamId: string,
  filters: AppointmentFilters,
  pagination: { limit: number; offset: number },
  searchPostFilter?: (rows: schema.Appointment[]) => schema.Appointment[],
): AppointmentListResult {
  const conds = [eq(schema.appointments.teamId, teamId)];

  if (filters.locationId)   conds.push(eq(schema.appointments.locationId, filters.locationId));
  if (filters.clientId)     conds.push(eq(schema.appointments.clientId, filters.clientId));
  if (filters.startsAfter)  conds.push(gte(schema.appointments.startAt, filters.startsAfter));
  if (filters.startsBefore) conds.push(lte(schema.appointments.startAt, filters.startsBefore));

  if (filters.appointmentId) {
    conds.push(or(
      eq(schema.appointments.id, filters.appointmentId),
      eq(schema.appointments.appointmentId, filters.appointmentId),
    )!);
  }
  if (filters.stylistId) {
    conds.push(or(
      eq(schema.appointments.stylistId, filters.stylistId),
      eq(schema.appointments.staffId, filters.stylistId),
    )!);
  }
  if (filters.statusCode) {
    conds.push(or(
      eq(schema.appointments.statusCode, filters.statusCode),
      eq(schema.appointments.status, filters.statusCode),
    )!);
  }
  if (filters.categoryId) {
    conds.push(or(
      eq(schema.appointments.categoryId, filters.categoryId),
      eq(schema.appointments.categoryName, filters.categoryId),
    )!);
  }

  const whereClause = and(...conds);
  const search = (filters.search || '').trim();

  if (search && searchPostFilter) {
    const allRows = db.select().from(schema.appointments)
      .where(whereClause)
      .orderBy(desc(schema.appointments.startAt))
      .all() as schema.Appointment[];
    const matched = searchPostFilter(allRows);
    return {
      rows: matched.slice(pagination.offset, pagination.offset + pagination.limit),
      total: matched.length,
    };
  }

  const totalRow = db.select({ c: sql<number>`count(*)` })
    .from(schema.appointments)
    .where(whereClause)
    .get() as { c: number } | undefined;
  const total = Number(totalRow?.c ?? 0);

  const rows = db.select().from(schema.appointments)
    .where(whereClause)
    .orderBy(desc(schema.appointments.startAt))
    .limit(pagination.limit)
    .offset(pagination.offset)
    .all() as schema.Appointment[];

  return { rows, total };
}
