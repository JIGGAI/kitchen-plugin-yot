import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { holidaysByDate, replaceHolidays } from '../sync-holidays';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE public_holidays (
    team_id TEXT NOT NULL, holiday_id TEXT NOT NULL, name TEXT NOT NULL,
    date TEXT NOT NULL, synced_at TEXT NOT NULL, PRIMARY KEY (team_id, holiday_id));`);
  db.exec(`CREATE TABLE public_holiday_locations (
    team_id TEXT NOT NULL, holiday_id TEXT NOT NULL, location_id TEXT NOT NULL,
    PRIMARY KEY (team_id, holiday_id, location_id));`);
  return db;
}

describe('replaceHolidays', () => {
  it('replaces the team rows wholesale (removed-in-YOT holidays disappear)', () => {
    const db = makeDb();
    replaceHolidays(db, 'T', [
      { holidayId: '1', name: 'A', date: '2026-05-25' },
      { holidayId: '2', name: 'B', date: '2026-07-04' },
    ]);
    replaceHolidays(db, 'T', [{ holidayId: '1', name: 'A', date: '2026-05-25' }]);
    const rows = db.prepare('SELECT holiday_id FROM public_holidays WHERE team_id=?').all('T');
    expect(rows.map((r: any) => r.holiday_id)).toEqual(['1']);
  });

  it('does not touch other teams', () => {
    const db = makeDb();
    replaceHolidays(db, 'T1', [{ holidayId: '1', name: 'A', date: '2026-05-25' }]);
    replaceHolidays(db, 'T2', [{ holidayId: '9', name: 'Z', date: '2026-12-25' }]);
    replaceHolidays(db, 'T1', []);
    expect(db.prepare('SELECT COUNT(*) c FROM public_holidays WHERE team_id=?').get('T2')).toEqual({ c: 1 });
  });
});

describe('holidaysByDate', () => {
  it('maps only matching dates to names', () => {
    const db = makeDb();
    replaceHolidays(db, 'T', [
      { holidayId: '1', name: 'Memorial Day', date: '2026-05-25' },
      { holidayId: '2', name: 'Independence Day', date: '2026-07-04' },
    ]);
    const map = holidaysByDate(db, 'T', ['2026-05-25', '2026-05-26', '2026-07-04']);
    expect(map.get('2026-05-25')).toBe('Memorial Day');
    expect(map.get('2026-07-04')).toBe('Independence Day');
    expect(map.has('2026-05-26')).toBe(false);
  });

  it('returns an empty map for no dates', () => {
    const db = makeDb();
    expect(holidaysByDate(db, 'T', []).size).toBe(0);
  });
});

describe('holidaysByDate with location scoping', () => {
  // Mirrors the real July 5 case: a holiday that closes most shops but leaves
  // a subset (the FL shops) open, plus a fully org-wide holiday (July 4).
  function seed() {
    const db = makeDb();
    replaceHolidays(
      db,
      'T',
      [
        { holidayId: 'jul4', name: 'Independence Day', date: '2026-07-04' },
        { holidayId: 'jul5', name: 'Independance Day weekend', date: '2026-07-05' },
      ],
      new Map([
        // jul4: no rows → closes all locations
        // jul5: closes MI + non-FL shops; FL_OPEN is NOT in the closed set
        ['jul5', ['MI_A', 'MI_B', 'FL_CLOSED']],
      ]),
    );
    return db;
  }

  it('closes the location when the holiday is scoped to it', () => {
    const db = seed();
    const map = holidaysByDate(db, 'T', ['2026-07-05'], 'MI_A');
    expect(map.get('2026-07-05')).toBe('Independance Day weekend');
  });

  it('leaves a location OPEN when the holiday is not scoped to it (the July 5 FL bug)', () => {
    const db = seed();
    const map = holidaysByDate(db, 'T', ['2026-07-05'], 'FL_OPEN');
    expect(map.has('2026-07-05')).toBe(false);
  });

  it('closes ALL locations for a holiday with no scoping rows (back-compat)', () => {
    const db = seed();
    expect(holidaysByDate(db, 'T', ['2026-07-04'], 'FL_OPEN').get('2026-07-04')).toBe('Independence Day');
    expect(holidaysByDate(db, 'T', ['2026-07-04'], 'MI_A').get('2026-07-04')).toBe('Independence Day');
  });

  it('without a locationId, returns the holiday team-wide (legacy behaviour)', () => {
    const db = seed();
    // No location filter → jul5 shows up regardless of scoping
    expect(holidaysByDate(db, 'T', ['2026-07-05']).get('2026-07-05')).toBe('Independance Day weekend');
  });

  it('re-syncing replaces scoping rows wholesale', () => {
    const db = seed();
    // Re-sync with jul5 now closing FL_OPEN too (and dropping FL_CLOSED)
    replaceHolidays(
      db,
      'T',
      [{ holidayId: 'jul5', name: 'Independance Day weekend', date: '2026-07-05' }],
      new Map([['jul5', ['FL_OPEN']]]),
    );
    expect(holidaysByDate(db, 'T', ['2026-07-05'], 'FL_OPEN').get('2026-07-05')).toBe('Independance Day weekend');
    expect(holidaysByDate(db, 'T', ['2026-07-05'], 'FL_CLOSED').has('2026-07-05')).toBe(false);
    // jul4 rows are gone entirely after the wholesale replace
    const cnt = db.prepare('SELECT COUNT(*) c FROM public_holiday_locations WHERE team_id=?').get('T') as { c: number };
    expect(cnt.c).toBe(1);
  });
});
