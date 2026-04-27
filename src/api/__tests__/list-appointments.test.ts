import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema';
import { listAppointmentsForRequest } from '../list-appointments';

// Schema mirrors db/migrations 0001 + 0003 + 0004 — only the columns the
// list helper reads. Indexes intentionally omitted; tests run against tiny
// row counts and care about correctness, not query plans.
const APPOINTMENTS_DDL = `
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
`;

type TestDb = ReturnType<typeof drizzle>;

function makeTestDb(): { db: TestDb; sqlite: Database.Database } {
  const sqlite = new Database(':memory:');
  sqlite.exec(APPOINTMENTS_DDL);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

const TEAM = 'team-a';
const OTHER_TEAM = 'team-b';

function appt(overrides: Partial<schema.Appointment> = {}): schema.Appointment {
  const now = '2026-04-20T00:00:00';
  return {
    id: overrides.id ?? `appt-${Math.random().toString(36).slice(2, 9)}`,
    teamId: TEAM,
    appointmentId: null,
    internalId: null,
    clientId: null,
    staffId: null,
    stylistId: null,
    serviceId: null,
    serviceNameRaw: null,
    serviceNameNorm: null,
    locationId: null,
    startsAt: now,
    endsAt: null,
    startAt: now,
    endAt: null,
    status: null,
    statusCode: null,
    statusDescription: null,
    categoryId: null,
    categoryName: null,
    durationMinutes: null,
    clientName: null,
    clientPhone: null,
    clientNotes: null,
    descriptionHtml: null,
    descriptionText: null,
    referrer: null,
    promotionCode: null,
    arrivalNote: null,
    reminderSent: null,
    cancelledFlag: null,
    onlineBooking: null,
    newClient: null,
    isClass: null,
    processingLength: null,
    total: null,
    grossAmount: null,
    discountAmount: null,
    netAmount: null,
    createdAtRemote: null,
    createdBy: null,
    updatedAtRemote: null,
    updatedBy: null,
    raw: null,
    syncedAt: now,
    ...overrides,
  };
}

let db: TestDb;
let sqlite: Database.Database;

beforeEach(() => {
  ({ db, sqlite } = makeTestDb());
});

describe('listAppointmentsForRequest', () => {
  it('filters by startsAfter (inclusive lower bound)', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'a', startAt: '2026-04-19T08:00:00', startsAt: '2026-04-19T08:00:00' }),
      appt({ id: 'b', startAt: '2026-04-20T08:00:00', startsAt: '2026-04-20T08:00:00' }),
      appt({ id: 'c', startAt: '2026-04-21T08:00:00', startsAt: '2026-04-21T08:00:00' }),
    ]).run();

    const result = listAppointmentsForRequest(
      db,
      TEAM,
      { startsAfter: '2026-04-20T00:00:00' },
      { limit: 100, offset: 0 },
    );

    expect(result.rows.map((r) => r.id).sort()).toEqual(['b', 'c']);
    expect(result.total).toBe(2);
  });

  it('filters by startsBefore (inclusive upper bound)', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'a', startAt: '2026-04-19T08:00:00' }),
      appt({ id: 'b', startAt: '2026-04-20T08:00:00' }),
      appt({ id: 'c', startAt: '2026-04-21T08:00:00' }),
    ]).run();

    const result = listAppointmentsForRequest(
      db,
      TEAM,
      { startsBefore: '2026-04-20T23:59:59' },
      { limit: 100, offset: 0 },
    );

    expect(result.rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(result.total).toBe(2);
  });

  it('combines startsAfter + startsBefore as a date range', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'a', startAt: '2026-04-18T08:00:00' }),
      appt({ id: 'b', startAt: '2026-04-19T08:00:00' }),
      appt({ id: 'c', startAt: '2026-04-20T08:00:00' }),
      appt({ id: 'd', startAt: '2026-04-21T08:00:00' }),
    ]).run();

    const result = listAppointmentsForRequest(
      db,
      TEAM,
      { startsAfter: '2026-04-19T00:00:00', startsBefore: '2026-04-20T23:59:59' },
      { limit: 100, offset: 0 },
    );

    expect(result.rows.map((r) => r.id).sort()).toEqual(['b', 'c']);
    expect(result.total).toBe(2);
  });

  it('isolates rows by teamId — never returns another team\'s data', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'mine', teamId: TEAM }),
      appt({ id: 'other', teamId: OTHER_TEAM }),
    ]).run();

    const result = listAppointmentsForRequest(db, TEAM, {}, { limit: 100, offset: 0 });

    expect(result.rows.map((r) => r.id)).toEqual(['mine']);
    expect(result.total).toBe(1);
  });

  it('filters by locationId', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'a', locationId: 'loc-1' }),
      appt({ id: 'b', locationId: 'loc-2' }),
      appt({ id: 'c', locationId: 'loc-1' }),
    ]).run();

    const result = listAppointmentsForRequest(
      db,
      TEAM,
      { locationId: 'loc-1' },
      { limit: 100, offset: 0 },
    );

    expect(result.rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
    expect(result.total).toBe(2);
  });

  it('filters by stylistId matching stylist_id', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'a', stylistId: 'stylist-7', staffId: null }),
      appt({ id: 'b', stylistId: 'stylist-9', staffId: null }),
    ]).run();

    const result = listAppointmentsForRequest(
      db,
      TEAM,
      { stylistId: 'stylist-7' },
      { limit: 100, offset: 0 },
    );

    expect(result.rows.map((r) => r.id)).toEqual(['a']);
  });

  it('filters by stylistId matching legacy staff_id when stylist_id null', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'a', stylistId: null, staffId: 'staff-7' }),
      appt({ id: 'b', stylistId: null, staffId: 'staff-9' }),
    ]).run();

    const result = listAppointmentsForRequest(
      db,
      TEAM,
      { stylistId: 'staff-7' },
      { limit: 100, offset: 0 },
    );

    expect(result.rows.map((r) => r.id)).toEqual(['a']);
  });

  it('filters by statusCode (matches status_code or legacy status)', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'a', statusCode: 'COMPLETED', status: null }),
      appt({ id: 'b', statusCode: null, status: 'COMPLETED' }),
      appt({ id: 'c', statusCode: 'CANCELLED', status: null }),
    ]).run();

    const result = listAppointmentsForRequest(
      db,
      TEAM,
      { statusCode: 'COMPLETED' },
      { limit: 100, offset: 0 },
    );

    expect(result.rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('returns rows sorted by start_at descending', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'old', startAt: '2026-04-18T08:00:00' }),
      appt({ id: 'newest', startAt: '2026-04-22T08:00:00' }),
      appt({ id: 'mid', startAt: '2026-04-20T08:00:00' }),
    ]).run();

    const result = listAppointmentsForRequest(db, TEAM, {}, { limit: 100, offset: 0 });

    expect(result.rows.map((r) => r.id)).toEqual(['newest', 'mid', 'old']);
  });

  it('paginates with limit + offset and reports unfiltered total', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      appt({ id: `appt-${i}`, startAt: `2026-04-${String(20 + i).padStart(2, '0')}T08:00:00` }),
    );
    db.insert(schema.appointments).values(rows).run();

    const page1 = listAppointmentsForRequest(db, TEAM, {}, { limit: 2, offset: 0 });
    const page2 = listAppointmentsForRequest(db, TEAM, {}, { limit: 2, offset: 2 });

    // Sorted desc by start_at, so newest first.
    expect(page1.rows.map((r) => r.id)).toEqual(['appt-4', 'appt-3']);
    expect(page1.total).toBe(5);

    expect(page2.rows.map((r) => r.id)).toEqual(['appt-2', 'appt-1']);
    expect(page2.total).toBe(5);
  });

  it('returns empty result when filter excludes everything', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'a', locationId: 'loc-1' }),
    ]).run();

    const result = listAppointmentsForRequest(
      db,
      TEAM,
      { locationId: 'loc-NEVER' },
      { limit: 100, offset: 0 },
    );

    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });
});
