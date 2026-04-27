import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema';
import { buildAppointmentLookupsForRows } from '../appointment-lookups';

// Schema mirrors src/db/schema.ts column-for-column. Drizzle's SELECT
// expands `*` into the schema's full column list, so any missing column
// errors at the SQLite layer. Tests insert via raw better-sqlite3 to avoid
// needing every column populated.
const SCHEMA_DDL = `
CREATE TABLE appointments (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  appointment_id TEXT,
  internal_id TEXT,
  client_id TEXT,
  staff_id TEXT,
  stylist_id TEXT,
  service_id TEXT,
  service_name_raw TEXT,
  service_name_norm TEXT,
  location_id TEXT,
  starts_at TEXT,
  ends_at TEXT,
  start_at TEXT,
  end_at TEXT,
  status TEXT,
  status_code TEXT,
  status_description TEXT,
  category_id TEXT,
  category_name TEXT,
  duration_minutes INTEGER,
  client_name TEXT,
  client_phone TEXT,
  client_notes TEXT,
  description_html TEXT,
  description_text TEXT,
  referrer TEXT,
  promotion_code TEXT,
  arrival_note TEXT,
  reminder_sent INTEGER,
  cancelled_flag INTEGER,
  online_booking INTEGER,
  new_client INTEGER,
  is_class INTEGER,
  processing_length INTEGER,
  total REAL,
  gross_amount REAL,
  discount_amount REAL,
  net_amount REAL,
  created_at_remote TEXT,
  created_by TEXT,
  updated_at_remote TEXT,
  updated_by TEXT,
  raw TEXT,
  synced_at TEXT NOT NULL
);
CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT,
  email_address TEXT,
  business_phone TEXT,
  mobile_phone TEXT,
  can_book_online INTEGER,
  active INTEGER,
  street TEXT,
  suburb TEXT,
  state TEXT,
  postcode TEXT,
  country TEXT,
  raw TEXT,
  synced_at TEXT NOT NULL
);
CREATE TABLE stylists (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  location_id TEXT,
  private_id TEXT,
  given_name TEXT,
  surname TEXT,
  full_name TEXT,
  initial TEXT,
  job_title TEXT,
  job_description TEXT,
  email_address TEXT,
  mobile_phone TEXT,
  active INTEGER,
  source_location_id TEXT,
  service_category_names TEXT,
  service_ids TEXT,
  service_names TEXT,
  profile_raw TEXT,
  raw TEXT,
  synced_at TEXT NOT NULL
);
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  tags TEXT,
  last_visit_at TEXT,
  total_visits INTEGER,
  total_spend REAL,
  raw TEXT,
  synced_at TEXT NOT NULL,
  private_id TEXT,
  other_name TEXT,
  full_name TEXT,
  home_phone TEXT,
  mobile_phone TEXT,
  business_phone TEXT,
  email_address TEXT,
  birthday TEXT,
  gender TEXT,
  active INTEGER,
  street TEXT,
  suburb TEXT,
  state TEXT,
  postcode TEXT,
  country TEXT,
  source_location_id TEXT,
  created_at_remote TEXT
);
CREATE TABLE services (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  location_id TEXT,
  private_id TEXT,
  name TEXT,
  category_id TEXT,
  category_name TEXT,
  duration_minutes INTEGER,
  length_display TEXT,
  price REAL,
  price_display TEXT,
  description TEXT,
  active INTEGER,
  staff_price_count INTEGER,
  staff_price_overrides TEXT,
  raw TEXT,
  synced_at TEXT NOT NULL
);
`;

type TestDb = ReturnType<typeof drizzle>;

const TEAM = 'team-a';
const NOW = '2026-04-20T00:00:00';

function makeTestDb(): { db: TestDb; sqlite: Database.Database } {
  const sqlite = new Database(':memory:');
  sqlite.exec(SCHEMA_DDL);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

function insertClient(s: Database.Database, c: { id: string; teamId: string; fullName?: string }): void {
  s.prepare('INSERT INTO clients (id, team_id, full_name, synced_at) VALUES (?, ?, ?, ?)').run(c.id, c.teamId, c.fullName ?? null, NOW);
}
function insertStylist(s: Database.Database, st: { id: string; teamId: string; privateId: string; fullName?: string; locationId?: string | null }): void {
  s.prepare('INSERT INTO stylists (id, team_id, private_id, full_name, location_id, synced_at) VALUES (?, ?, ?, ?, ?, ?)').run(st.id, st.teamId, st.privateId, st.fullName ?? null, st.locationId ?? null, NOW);
}
function insertService(s: Database.Database, sv: { id: string; teamId: string; privateId: string; name?: string; locationId?: string | null }): void {
  s.prepare('INSERT INTO services (id, team_id, private_id, name, location_id, synced_at) VALUES (?, ?, ?, ?, ?, ?)').run(sv.id, sv.teamId, sv.privateId, sv.name ?? null, sv.locationId ?? null, NOW);
}
function insertLocation(s: Database.Database, l: { id: string; teamId: string; name?: string }): void {
  s.prepare('INSERT INTO locations (id, team_id, name, synced_at) VALUES (?, ?, ?, ?)').run(l.id, l.teamId, l.name ?? null, NOW);
}

let db: TestDb;
let sqlite: Database.Database;

beforeEach(() => {
  ({ db, sqlite } = makeTestDb());
});

describe('buildAppointmentLookupsForRows', () => {
  it('loads only referenced clients, not the entire clients table', () => {
    insertClient(sqlite, { id: 'c-needed', teamId: TEAM, fullName: 'Needed Client' });
    insertClient(sqlite, { id: 'c-other', teamId: TEAM, fullName: 'Other Client' });
    insertClient(sqlite, { id: 'c-other-2', teamId: TEAM, fullName: 'Other Client 2' });

    const rows = [{ clientId: 'c-needed' } as schema.Appointment];
    const lookups = buildAppointmentLookupsForRows(db, TEAM, rows);

    expect(lookups.clientsById.size).toBe(1);
    expect(lookups.clientsById.get('c-needed')?.fullName).toBe('Needed Client');
    expect(lookups.clientsById.has('c-other')).toBe(false);
  });

  it('isolates by teamId — never returns another team\'s lookup rows', () => {
    insertClient(sqlite, { id: 'c-mine', teamId: TEAM, fullName: 'Mine' });
    insertClient(sqlite, { id: 'c-other-team', teamId: 'team-b', fullName: 'Other Team' });

    const rows = [
      { clientId: 'c-mine' } as schema.Appointment,
      { clientId: 'c-other-team' } as schema.Appointment,
    ];
    const lookups = buildAppointmentLookupsForRows(db, TEAM, rows);

    expect(lookups.clientsById.has('c-mine')).toBe(true);
    expect(lookups.clientsById.has('c-other-team')).toBe(false);
  });

  it('loads stylists matching either stylist_id or staff_id (legacy fallback)', () => {
    insertStylist(sqlite, { id: 'r1', teamId: TEAM, privateId: 'sty-A', fullName: 'A' });
    insertStylist(sqlite, { id: 'r2', teamId: TEAM, privateId: 'sty-B', fullName: 'B' });
    insertStylist(sqlite, { id: 'r3', teamId: TEAM, privateId: 'sty-C', fullName: 'C' });

    const rows = [
      { stylistId: 'sty-A', staffId: null } as schema.Appointment,
      { stylistId: null, staffId: 'sty-B' } as schema.Appointment,
    ];
    const lookups = buildAppointmentLookupsForRows(db, TEAM, rows);

    expect(lookups.stylistsByPrivateId.get('sty-A')?.fullName).toBe('A');
    expect(lookups.stylistsByPrivateId.get('sty-B')?.fullName).toBe('B');
    expect(lookups.stylistsByPrivateId.has('sty-C')).toBe(false);
  });

  it('builds scoped stylist key when stylist row has a location_id', () => {
    insertStylist(sqlite, { id: 'r1', teamId: TEAM, privateId: 'sty-X', fullName: 'X@loc1', locationId: 'loc-1' });
    insertStylist(sqlite, { id: 'r2', teamId: TEAM, privateId: 'sty-X', fullName: 'X@loc2', locationId: 'loc-2' });

    const rows = [{ stylistId: 'sty-X', locationId: 'loc-1' } as schema.Appointment];
    const lookups = buildAppointmentLookupsForRows(db, TEAM, rows);

    expect(lookups.stylistsByScopedPrivateId.get('loc-1:sty-X')?.fullName).toBe('X@loc1');
    expect(lookups.stylistsByScopedPrivateId.get('loc-2:sty-X')?.fullName).toBe('X@loc2');
  });

  it('loads services referenced by serviceId', () => {
    insertService(sqlite, { id: 's1', teamId: TEAM, privateId: 'svc-haircut', name: 'Haircut' });
    insertService(sqlite, { id: 's2', teamId: TEAM, privateId: 'svc-shave', name: 'Shave' });

    const rows = [{ serviceId: 'svc-haircut' } as schema.Appointment];
    const lookups = buildAppointmentLookupsForRows(db, TEAM, rows);

    expect(lookups.servicesByPrivateId.get('svc-haircut')?.name).toBe('Haircut');
    expect(lookups.servicesByPrivateId.has('svc-shave')).toBe(false);
  });

  it('loads locations referenced by location_id', () => {
    insertLocation(sqlite, { id: 'loc-1', teamId: TEAM, name: 'Downtown' });
    insertLocation(sqlite, { id: 'loc-2', teamId: TEAM, name: 'Uptown' });

    const rows = [{ locationId: 'loc-1' } as schema.Appointment];
    const lookups = buildAppointmentLookupsForRows(db, TEAM, rows);

    expect(lookups.locationsById.get('loc-1')?.name).toBe('Downtown');
    expect(lookups.locationsById.has('loc-2')).toBe(false);
  });

  it('returns empty maps when rows is empty', () => {
    const lookups = buildAppointmentLookupsForRows(db, TEAM, []);

    expect(lookups.clientsById.size).toBe(0);
    expect(lookups.stylistsByPrivateId.size).toBe(0);
    expect(lookups.servicesByPrivateId.size).toBe(0);
    expect(lookups.locationsById.size).toBe(0);
  });

  it('deduplicates lookup IDs across rows (one query per table regardless of repeats)', () => {
    insertClient(sqlite, { id: 'c-1', teamId: TEAM, fullName: 'Repeated Client' });

    const rows = [
      { clientId: 'c-1' } as schema.Appointment,
      { clientId: 'c-1' } as schema.Appointment,
      { clientId: 'c-1' } as schema.Appointment,
    ];
    const lookups = buildAppointmentLookupsForRows(db, TEAM, rows);

    expect(lookups.clientsById.size).toBe(1);
    expect(lookups.clientsById.get('c-1')?.fullName).toBe('Repeated Client');
  });
});
