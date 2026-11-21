import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleRequest } from '../handler';
import { initializeDatabase } from '../../db';
import {
  appointmentMoneyTotals,
  clientIdsWithAppointmentsAtLocation,
  clientIdsWithAppointmentsForStylist,
  locationIdsWithAppointmentsFor,
  readRelationshipAppointments,
  stylistIdsWithAppointmentsForClient,
} from '../appointment-reads';

// The detail and list routes used to load every appointment of the team and
// filter in JS. These pin what the narrow reads must return instead.
let tempHome: string;
let seq = 0;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'yot-appointment-reads-'));
  process.env.HOME = tempHome;
  process.env.YOT_ALLOW_DB_AUTOCREATE = '1';
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

type Seed = {
  id: string; loc: string; client?: string | null; stylist?: string | null; staff?: string | null;
  startAt?: string | null; startsAt?: string | null; net?: number | null; gross?: number | null; total?: number | null;
  discount?: number | null; updated?: string | null;
};

function seed(rows: Seed[]) {
  const teamId = `APR${seq++}`;
  const { sqlite } = initializeDatabase(teamId);
  const insert = sqlite.prepare(
    `INSERT INTO appointments
       (id, team_id, location_id, client_id, client_name, stylist_id, staff_id, start_at, starts_at,
        net_amount, gross_amount, total, discount_amount, updated_at_remote, synced_at, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-11-01T00:00:00Z', ?)`,
  );
  for (const r of rows) {
    insert.run(
      r.id, teamId, r.loc, r.client ?? null, r.client ? `Client ${r.client}` : null, r.stylist ?? null, r.staff ?? null,
      r.startAt ?? null, r.startsAt ?? null, r.net ?? null, r.gross ?? null, r.total ?? null, r.discount ?? null,
      r.updated ?? null, '{"big":"payload"}',
    );
  }
  // Another team's rows must never leak in.
  const other = initializeDatabase(`${teamId}X`).sqlite;
  other.prepare(
    `INSERT INTO appointments (id, team_id, location_id, client_id, stylist_id, start_at, synced_at)
     VALUES ('foreign', ?, 'A', 'c1', 's1', '2026-10-01T10:00:00', '2026-11-01T00:00:00Z')`,
  ).run(`${teamId}X`);
  return { sqlite, teamId };
}

const ROWS: Seed[] = [
  { id: 'a1', loc: 'A', client: 'c1', stylist: 's1', staff: 's1', startAt: '2026-10-01T10:00:00' },
  { id: 'a2', loc: 'A', client: 'c2', stylist: 's2', staff: 's2', startAt: '2026-10-02T10:00:00' },
  { id: 'a3', loc: 'B', client: 'c1', stylist: 's2', staff: 's2', startAt: '2026-10-03T10:00:00' },
  { id: 'a4', loc: 'B', client: 'c3', stylist: null, staff: 's1', startsAt: '2026-10-04T10:00:00' }, // legacy: staff_id only
  { id: 'a5', loc: 'C', client: null, stylist: 's3', staff: 's3', startAt: '2026-10-05T10:00:00' }, // walk-in, no client
];

const ids = (rows: Array<{ clientId: string | null; locationId: string | null }>) => rows.map((r) => `${r.locationId}/${r.clientId}`).sort();

describe('readRelationshipAppointments', () => {
  it('returns only the focused rows, without the raw payload', () => {
    const { sqlite, teamId } = seed(ROWS);
    expect(ids(readRelationshipAppointments(sqlite, teamId, { locationId: 'A' }))).toEqual(['A/c1', 'A/c2']);
    expect(ids(readRelationshipAppointments(sqlite, teamId, { clientId: 'c1' }))).toEqual(['A/c1', 'B/c1']);
    // A stylist matches on stylist_id, and on staff_id for rows with no stylist_id.
    expect(ids(readRelationshipAppointments(sqlite, teamId, { stylistId: 's1' }))).toEqual(['A/c1', 'B/c3']);
    expect(ids(readRelationshipAppointments(sqlite, teamId, { stylistId: 's2' }))).toEqual(['A/c2', 'B/c1']);
    // Several focuses narrow together.
    expect(ids(readRelationshipAppointments(sqlite, teamId, { clientId: 'c1', locationId: 'B' }))).toEqual(['B/c1']);
    expect(ids(readRelationshipAppointments(sqlite, teamId, { stylistId: 's2', locationId: 'A' }))).toEqual(['A/c2']);
    expect(readRelationshipAppointments(sqlite, teamId, {})).toHaveLength(5);
    const row = readRelationshipAppointments(sqlite, teamId, { locationId: 'C' })[0];
    expect(Object.keys(row).sort()).toEqual(['clientId', 'clientName', 'locationId', 'staffId', 'startAt', 'startsAt', 'stylistId']);
  });
});

describe('filter lookups', () => {
  it('finds shops, clients and stylists through appointments', () => {
    const { sqlite, teamId } = seed(ROWS);
    const sorted = (s: Set<string>) => [...s].sort();
    expect(sorted(locationIdsWithAppointmentsFor(sqlite, teamId, { stylistId: 's1' }))).toEqual(['A', 'B']);
    expect(sorted(locationIdsWithAppointmentsFor(sqlite, teamId, { clientId: 'c2' }))).toEqual(['A']);
    expect(sorted(locationIdsWithAppointmentsFor(sqlite, teamId, { stylistId: 's3', clientId: 'c2' }))).toEqual(['A', 'C']);
    expect(sorted(locationIdsWithAppointmentsFor(sqlite, teamId, { stylistId: 'nobody' }))).toEqual([]);
    expect(sorted(clientIdsWithAppointmentsAtLocation(sqlite, teamId, 'B'))).toEqual(['c1', 'c3']);
    expect(sorted(clientIdsWithAppointmentsAtLocation(sqlite, teamId, 'C'))).toEqual([]); // the walk-in has no client
    expect(sorted(clientIdsWithAppointmentsForStylist(sqlite, teamId, 's1'))).toEqual(['c1', 'c3']);
    expect(sorted(stylistIdsWithAppointmentsForClient(sqlite, teamId, 'c1'))).toEqual(['s1', 's2']);
    expect(sorted(stylistIdsWithAppointmentsForClient(sqlite, teamId, 'c3'))).toEqual(['s1']);
  });
});

describe('appointmentMoneyTotals', () => {
  it('sums the money fields with the same fallbacks the row-by-row code used', () => {
    const { sqlite, teamId } = seed([
      { id: 'm1', loc: 'A', gross: 50, discount: 5, net: 45, updated: '2026-10-03T00:00:00Z' },
      { id: 'm2', loc: 'A', total: 30 },                       // total stands in for gross and net
      { id: 'm3', loc: 'A', gross: 20 },                       // gross stands in for net
      { id: 'm4', loc: 'A', updated: '2026-12-01T00:00:00Z' }, // no money: counted only in `total`
      { id: 'm5', loc: 'B', net: 999 },
    ]);
    expect(appointmentMoneyTotals(sqlite, teamId, 'A')).toEqual({
      total: 4, withAmounts: 3, grossAmount: 100, discountAmount: 5, netAmount: 95,
      lastUpdatedWithAmounts: '2026-11-01T00:00:00Z', // m2/m3 fall back to synced_at, later than m1's remote stamp
      lastUpdatedAll: '2026-12-01T00:00:00Z',
    });
    expect(appointmentMoneyTotals(sqlite, teamId, 'nowhere')).toEqual({
      total: 0, withAmounts: 0, grossAmount: 0, discountAmount: 0, netAmount: 0,
      lastUpdatedWithAmounts: null, lastUpdatedAll: null,
    });
  });
});

describe('detail routes', () => {
  it('GET /locations/:id summarises only that shop', async () => {
    const { sqlite, teamId } = seed(ROWS);
    sqlite.prepare(`INSERT INTO locations (id, team_id, name, active, synced_at) VALUES ('B', ?, 'Shop B', 1, '2026-11-01T00:00:00Z')`).run(teamId);
    const res: any = await handleRequest({ method: 'GET', path: '/locations/B', query: { team: teamId }, headers: {}, body: null } as any, {} as any);
    expect(res.status).toBe(200);
    const rel = res.data.relationships;
    expect(rel.appointmentCount).toBe(2);
    expect(rel.uniqueClientCount).toBe(2);
    expect(rel.uniqueStylistCount).toBe(2);
    expect(rel.lastAppointmentAt).toBe('2026-10-04T10:00:00');
    expect(rel.revenue.source).toBe('none');
    expect(rel.revenue.appointmentCount).toBe(2);
  });
});
