import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema';
import { stylistsByLocationForRange } from '../stylists-by-location';

// Schema mirrors list-appointments.test.ts — only the columns stylistsByLocationForRange reads.
// Indexes intentionally omitted; tests run against tiny row counts and care about
// correctness, not query plans.
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

beforeEach(() => {
  ({ db } = makeTestDb());
});

describe('stylistsByLocationForRange', () => {
  it('returns distinct stylist ids per location without a date window', () => {
    db.insert(schema.appointments).values([
      // loc-1: two rows for stylist-A (must be deduped), one for stylist-B
      appt({ id: 'a1', locationId: 'loc-1', stylistId: 'stylist-A', staffId: null }),
      appt({ id: 'a2', locationId: 'loc-1', stylistId: 'stylist-A', staffId: null }),
      appt({ id: 'a3', locationId: 'loc-1', stylistId: 'stylist-B', staffId: null }),
      // loc-2: one stylist
      appt({ id: 'b1', locationId: 'loc-2', stylistId: 'stylist-C', staffId: null }),
    ]).run();

    const result = stylistsByLocationForRange(db as any, TEAM);

    const byLoc = new Map(result.map((r) => [r.locationId, r.stylistIds.slice().sort()]));
    expect(byLoc.get('loc-1')).toEqual(['stylist-A', 'stylist-B']);
    expect(byLoc.get('loc-2')).toEqual(['stylist-C']);
    expect(result).toHaveLength(2);
  });

  it('falls back to staff_id when stylist_id is null', () => {
    db.insert(schema.appointments).values([
      appt({ id: 's1', locationId: 'loc-1', stylistId: null, staffId: 'staff-7' }),
      appt({ id: 's2', locationId: 'loc-1', stylistId: null, staffId: 'staff-9' }),
    ]).run();

    const result = stylistsByLocationForRange(db as any, TEAM);

    expect(result).toHaveLength(1);
    const ids = result[0]!.stylistIds.slice().sort();
    expect(ids).toEqual(['staff-7', 'staff-9']);
  });

  it('excludes rows where both stylist_id and staff_id are null', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'good', locationId: 'loc-1', stylistId: 'stylist-X', staffId: null }),
      appt({ id: 'null-both', locationId: 'loc-1', stylistId: null, staffId: null }),
    ]).run();

    const result = stylistsByLocationForRange(db as any, TEAM);

    expect(result).toHaveLength(1);
    expect(result[0]!.stylistIds).toEqual(['stylist-X']);
  });

  it('filters by startsAfter — excludes rows before the lower bound', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'before', locationId: 'loc-1', stylistId: 'old-stylist', startAt: '2026-04-18T08:00:00' }),
      appt({ id: 'after',  locationId: 'loc-1', stylistId: 'new-stylist', startAt: '2026-04-20T08:00:00' }),
    ]).run();

    const result = stylistsByLocationForRange(db as any, TEAM, { startsAfter: '2026-04-19T00:00:00' });

    expect(result).toHaveLength(1);
    expect(result[0]!.stylistIds).toEqual(['new-stylist']);
  });

  it('filters by startsBefore — excludes rows after the upper bound', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'in',  locationId: 'loc-1', stylistId: 'stylist-in',  startAt: '2026-04-19T08:00:00' }),
      appt({ id: 'out', locationId: 'loc-1', stylistId: 'stylist-out', startAt: '2026-04-21T08:00:00' }),
    ]).run();

    const result = stylistsByLocationForRange(db as any, TEAM, { startsBefore: '2026-04-20T23:59:59' });

    expect(result).toHaveLength(1);
    expect(result[0]!.stylistIds).toEqual(['stylist-in']);
  });

  it('applies startsAfter + startsBefore together as a date window', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'too-early', locationId: 'loc-1', stylistId: 'stylist-early', startAt: '2026-04-17T08:00:00' }),
      appt({ id: 'in-window', locationId: 'loc-1', stylistId: 'stylist-mid',   startAt: '2026-04-19T08:00:00' }),
      appt({ id: 'too-late',  locationId: 'loc-1', stylistId: 'stylist-late',  startAt: '2026-04-22T08:00:00' }),
    ]).run();

    const result = stylistsByLocationForRange(db as any, TEAM, {
      startsAfter:  '2026-04-18T00:00:00',
      startsBefore: '2026-04-20T23:59:59',
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.stylistIds).toEqual(['stylist-mid']);
  });

  it('isolates by teamId — never returns another team\'s stylists', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'mine',  teamId: TEAM,       locationId: 'loc-1', stylistId: 'my-stylist' }),
      appt({ id: 'other', teamId: OTHER_TEAM, locationId: 'loc-1', stylistId: 'their-stylist' }),
    ]).run();

    const result = stylistsByLocationForRange(db as any, TEAM);

    expect(result).toHaveLength(1);
    expect(result[0]!.stylistIds).toEqual(['my-stylist']);
  });

  it('returns empty array when no qualifying rows exist', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'x', locationId: 'loc-1', stylistId: null, staffId: null }),
    ]).run();

    const result = stylistsByLocationForRange(db as any, TEAM);

    expect(result).toEqual([]);
  });

  it('dedupes a stylist who appears in multiple appointments at the same location', () => {
    db.insert(schema.appointments).values([
      appt({ id: 'r1', locationId: 'loc-1', stylistId: 'dup-stylist' }),
      appt({ id: 'r2', locationId: 'loc-1', stylistId: 'dup-stylist' }),
      appt({ id: 'r3', locationId: 'loc-1', stylistId: 'dup-stylist' }),
    ]).run();

    const result = stylistsByLocationForRange(db as any, TEAM);

    expect(result).toHaveLength(1);
    expect(result[0]!.stylistIds).toEqual(['dup-stylist']);
  });
});
