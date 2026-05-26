import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { holidaysByDate, replaceHolidays } from '../sync-holidays';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE public_holidays (
    team_id TEXT NOT NULL, holiday_id TEXT NOT NULL, name TEXT NOT NULL,
    date TEXT NOT NULL, synced_at TEXT NOT NULL, PRIMARY KEY (team_id, holiday_id));`);
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
