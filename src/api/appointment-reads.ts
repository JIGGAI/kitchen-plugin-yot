/**
 * Narrow, index-backed reads over `appointments`.
 *
 * The table holds years of history and every row carries the raw YOT
 * payload. `db.select().from(appointments).where(team).all()` therefore
 * materialises the whole history, payloads included, which costs seconds at
 * best and exhausts the heap at worst. Everything here asks SQLite for only
 * the columns and rows a caller needs.
 */
import type { initializeDatabase } from '../db';

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

/** The fields the relationship summary reads from an appointment. */
export type RelationshipAppointmentRow = {
  clientId: string | null;
  clientName: string | null;
  locationId: string | null;
  stylistId: string | null;
  staffId: string | null;
  startAt: string | null;
  startsAt: string | null;
};

export type RelationshipFocus = { clientId?: string | null; stylistId?: string | null; locationId?: string | null };

const RELATIONSHIP_COLUMNS = `client_id AS clientId, client_name AS clientName, location_id AS locationId,
       stylist_id AS stylistId, staff_id AS staffId, start_at AS startAt, starts_at AS startsAt`;

const trimmed = (value: string | null | undefined): string | null => {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
};

/**
 * Appointments matching every focus that is set (client, location, stylist),
 * the same rows the old "load the team, filter in JS" code kept.
 *
 * A stylist matches on `stylist_id`, or on `staff_id` for legacy rows that
 * have no `stylist_id`. The most selective focus drives an index seek; the
 * remaining ones are re-checked in JS with the original comparisons.
 */
export function readRelationshipAppointments(sqlite: SqliteDb, teamId: string, focus: RelationshipFocus): RelationshipAppointmentRow[] {
  let rows: RelationshipAppointmentRow[];
  if (focus.clientId) {
    rows = sqlite.prepare(
      `SELECT ${RELATIONSHIP_COLUMNS} FROM appointments WHERE team_id = ? AND client_id = ?`,
    ).all(teamId, focus.clientId) as RelationshipAppointmentRow[];
  } else if (focus.stylistId) {
    rows = sqlite.prepare(
      `SELECT ${RELATIONSHIP_COLUMNS} FROM appointments WHERE team_id = ? AND stylist_id = ?
       UNION ALL
       SELECT ${RELATIONSHIP_COLUMNS} FROM appointments WHERE team_id = ? AND stylist_id IS NULL AND TRIM(staff_id) = ?`,
    ).all(teamId, focus.stylistId, teamId, focus.stylistId) as RelationshipAppointmentRow[];
  } else if (focus.locationId) {
    rows = sqlite.prepare(
      `SELECT ${RELATIONSHIP_COLUMNS} FROM appointments WHERE team_id = ? AND location_id = ?`,
    ).all(teamId, focus.locationId) as RelationshipAppointmentRow[];
  } else {
    rows = sqlite.prepare(
      `SELECT ${RELATIONSHIP_COLUMNS} FROM appointments WHERE team_id = ?`,
    ).all(teamId) as RelationshipAppointmentRow[];
  }
  if (focus.clientId) rows = rows.filter((row) => row.clientId === focus.clientId);
  if (focus.locationId) rows = rows.filter((row) => row.locationId === focus.locationId);
  if (focus.stylistId) rows = rows.filter((row) => trimmed(row.stylistId ?? row.staffId) === focus.stylistId);
  return rows;
}

/**
 * A stylist's appointments are the rows with that `stylist_id`, plus legacy
 * rows that carry only `staff_id`: the same precedence (`stylist_id ??
 * staff_id`) the relationship summary uses. Both branches seek on
 * (team_id, stylist_id, start_at).
 *
 * These queries deliberately return plain rows and de-duplicate in JS: with
 * DISTINCT the planner prefers an index that yields the output order and
 * walks every appointment of the team to get it.
 */
function idsForStylist(sqlite: SqliteDb, teamId: string, stylistId: string, column: 'location_id' | 'client_id'): Set<string> {
  const rows = sqlite.prepare(
    `SELECT ${column} AS id FROM appointments WHERE team_id = ? AND stylist_id = ?
     UNION ALL
     SELECT ${column} AS id FROM appointments WHERE team_id = ? AND stylist_id IS NULL AND staff_id = ?`,
  ).all(teamId, stylistId, teamId, stylistId) as Array<{ id: string | null }>;
  const out = new Set<string>();
  for (const r of rows) if (r.id) out.add(r.id);
  return out;
}

/** Shops with at least one appointment for the stylist and/or the client. */
export function locationIdsWithAppointmentsFor(
  sqlite: SqliteDb, teamId: string, filter: { stylistId?: string | null; clientId?: string | null },
): Set<string> {
  const out = filter.stylistId ? idsForStylist(sqlite, teamId, filter.stylistId, 'location_id') : new Set<string>();
  if (filter.clientId) {
    const rows = sqlite.prepare(
      `SELECT location_id AS id FROM appointments WHERE team_id = ? AND client_id = ?`,
    ).all(teamId, filter.clientId) as Array<{ id: string | null }>;
    for (const r of rows) if (r.id) out.add(r.id);
  }
  return out;
}

/** Clients with at least one appointment at the shop. */
export function clientIdsWithAppointmentsAtLocation(sqlite: SqliteDb, teamId: string, locationId: string): Set<string> {
  const rows = sqlite.prepare(
    `SELECT client_id AS id FROM appointments WHERE team_id = ? AND location_id = ?`,
  ).all(teamId, locationId) as Array<{ id: string | null }>;
  const out = new Set<string>();
  for (const r of rows) if (r.id) out.add(r.id);
  return out;
}

/** Clients with at least one appointment with the stylist. */
export function clientIdsWithAppointmentsForStylist(sqlite: SqliteDb, teamId: string, stylistId: string): Set<string> {
  return idsForStylist(sqlite, teamId, stylistId, 'client_id');
}

/** Every stylist id (`stylist_id` and `staff_id`) the client has an appointment with. */
export function stylistIdsWithAppointmentsForClient(sqlite: SqliteDb, teamId: string, clientId: string): Set<string> {
  const rows = sqlite.prepare(
    `SELECT stylist_id AS stylistId, staff_id AS staffId FROM appointments WHERE team_id = ? AND client_id = ?`,
  ).all(teamId, clientId) as Array<{ stylistId: string | null; staffId: string | null }>;
  const out = new Set<string>();
  for (const r of rows) {
    if (r.stylistId) out.add(r.stylistId);
    if (r.staffId) out.add(r.staffId);
  }
  return out;
}

/**
 * Money totals from a shop's appointments, used only when the shop has no
 * revenue_facts rows. `withAmounts` counts rows carrying any money field.
 */
export function appointmentMoneyTotals(sqlite: SqliteDb, teamId: string, locationId: string): {
  total: number; withAmounts: number; grossAmount: number; discountAmount: number; netAmount: number;
  lastUpdatedWithAmounts: string | null; lastUpdatedAll: string | null;
} {
  const updated = `COALESCE(NULLIF(updated_at_remote, ''), NULLIF(synced_at, ''))`;
  const hasAmount = `(net_amount IS NOT NULL OR gross_amount IS NOT NULL OR total IS NOT NULL)`;
  const row = sqlite.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(${hasAmount}), 0) AS withAmounts,
            COALESCE(SUM(CASE WHEN ${hasAmount} THEN COALESCE(gross_amount, total, 0) END), 0) AS grossAmount,
            COALESCE(SUM(CASE WHEN ${hasAmount} THEN COALESCE(discount_amount, 0) END), 0) AS discountAmount,
            COALESCE(SUM(CASE WHEN ${hasAmount} THEN COALESCE(net_amount, total, gross_amount, 0) END), 0) AS netAmount,
            MAX(CASE WHEN ${hasAmount} THEN ${updated} END) AS lastUpdatedWithAmounts,
            MAX(${updated}) AS lastUpdatedAll
       FROM appointments WHERE team_id = ? AND location_id = ?`,
  ).get(teamId, locationId) as any;
  return {
    total: Number(row?.total || 0),
    withAmounts: Number(row?.withAmounts || 0),
    grossAmount: Number(row?.grossAmount || 0),
    discountAmount: Number(row?.discountAmount || 0),
    netAmount: Number(row?.netAmount || 0),
    lastUpdatedWithAmounts: row?.lastUpdatedWithAmounts ?? null,
    lastUpdatedAll: row?.lastUpdatedAll ?? null,
  };
}
