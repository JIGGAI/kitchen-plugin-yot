import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { initializeDatabase } from '../db';

type Db = ReturnType<typeof initializeDatabase>['db'];

export type AppointmentLookupMaps = {
  locationsById: Map<string, schema.Location>;
  stylistsByScopedPrivateId: Map<string, schema.Stylist>;
  stylistsByPrivateId: Map<string, schema.Stylist>;
  clientsById: Map<string, schema.Client>;
  servicesByScopedPrivateId: Map<string, schema.Service>;
  servicesByPrivateId: Map<string, schema.Service>;
};

function clean(v: string | null | undefined): string | null {
  if (!v) return null;
  const trimmed = String(v).trim();
  return trimmed ? trimmed : null;
}

function uniqueIds(values: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    const cleaned = clean(value);
    if (cleaned) set.add(cleaned);
  }
  return Array.from(set);
}

// Builds the join-target lookup maps used by mapAppointmentRecordWithLookups,
// but loads only the rows referenced by `rows`. The previous implementation
// loaded every team-scoped client (185K+ for the HMX team) on every paginated
// /appointments call, which dwarfed the SQL-pushdown win on the appointments
// table itself. Each lookup table is hit once per call with an `IN (...)`
// query on its primary key, so cost scales with page size, not table size.
export function buildAppointmentLookupsForRows(
  db: Db,
  teamId: string,
  rows: schema.Appointment[],
): AppointmentLookupMaps {
  const locationsById = new Map<string, schema.Location>();
  const stylistsByScopedPrivateId = new Map<string, schema.Stylist>();
  const stylistsByPrivateId = new Map<string, schema.Stylist>();
  const clientsById = new Map<string, schema.Client>();
  const servicesByScopedPrivateId = new Map<string, schema.Service>();
  const servicesByPrivateId = new Map<string, schema.Service>();

  if (!rows.length) {
    return {
      locationsById,
      stylistsByScopedPrivateId,
      stylistsByPrivateId,
      clientsById,
      servicesByScopedPrivateId,
      servicesByPrivateId,
    };
  }

  const locationIds = uniqueIds(rows.map((r) => r.locationId));
  const clientIds = uniqueIds(rows.map((r) => r.clientId));
  const stylistPrivateIds = uniqueIds([
    ...rows.map((r) => r.stylistId),
    ...rows.map((r) => r.staffId),
  ]);
  const servicePrivateIds = uniqueIds(rows.map((r) => r.serviceId));

  if (locationIds.length) {
    const locations = db.select().from(schema.locations)
      .where(and(eq(schema.locations.teamId, teamId), inArray(schema.locations.id, locationIds)))
      .all() as schema.Location[];
    for (const row of locations) locationsById.set(row.id, row);
  }

  if (clientIds.length) {
    const clients = db.select().from(schema.clients)
      .where(and(eq(schema.clients.teamId, teamId), inArray(schema.clients.id, clientIds)))
      .all() as schema.Client[];
    for (const row of clients) clientsById.set(row.id, row);
  }

  if (stylistPrivateIds.length) {
    const stylists = db.select().from(schema.stylists)
      .where(and(eq(schema.stylists.teamId, teamId), inArray(schema.stylists.privateId, stylistPrivateIds)))
      .all() as schema.Stylist[];
    for (const row of stylists) {
      const privateId = clean(row.privateId);
      if (!privateId) continue;
      if (row.locationId) stylistsByScopedPrivateId.set(`${row.locationId}:${privateId}`, row);
      if (!stylistsByPrivateId.has(privateId)) stylistsByPrivateId.set(privateId, row);
    }
  }

  if (servicePrivateIds.length) {
    const services = db.select().from(schema.services)
      .where(and(eq(schema.services.teamId, teamId), inArray(schema.services.privateId, servicePrivateIds)))
      .all() as schema.Service[];
    for (const row of services) {
      const privateId = clean(row.privateId);
      if (!privateId) continue;
      if (row.locationId) servicesByScopedPrivateId.set(`${row.locationId}:${privateId}`, row);
      if (!servicesByPrivateId.has(privateId)) servicesByPrivateId.set(privateId, row);
    }
  }

  return {
    locationsById,
    stylistsByScopedPrivateId,
    stylistsByPrivateId,
    clientsById,
    servicesByScopedPrivateId,
    servicesByPrivateId,
  };
}
