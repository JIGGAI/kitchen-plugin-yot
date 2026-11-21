import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializeDatabase } from '../../db';
import { averageDailyAppointmentsByDow } from '../sync';

// The averaging reads appointments for one shop inside the look-back window
// only. These pin the window edges and the legacy starts_at-only fallback,
// so the bounded query keeps returning what the full-table read did.
let seq = 0;
let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'yot-average-by-dow-'));
  process.env.HOME = tempHome;
  process.env.YOT_ALLOW_DB_AUTOCREATE = '1';
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

function seed(rows: Array<{ id: string; loc?: string; startAt?: string | null; startsAt?: string | null }>) {
  const teamId = `AVGDOW${seq++}`;
  const { db, sqlite } = initializeDatabase(teamId);
  const insert = sqlite.prepare(
    `INSERT INTO appointments (id, team_id, location_id, stylist_id, start_at, starts_at, synced_at)
     VALUES (?, ?, ?, '1', ?, ?, '2026-11-01T00:00:00Z')`,
  );
  for (const r of rows) insert.run(r.id, teamId, r.loc ?? 'A', r.startAt ?? null, r.startsAt ?? null);
  return { db, sqlite, teamId };
}

describe('averageDailyAppointmentsByDow', () => {
  it('counts only this shop, inside [reference - days, reference)', () => {
    // Reference Mon 2026-11-02, 14 days back → window 2026-10-19 .. 2026-11-01.
    const { db, sqlite, teamId } = seed([
      { id: 'in-1', startAt: '2026-10-26T10:00:00' },          // Mon, in window
      { id: 'in-2', startAt: '2026-10-26T10:30:00' },          // same Mon, same hour
      { id: 'in-3', startAt: '2026-10-26T14:00:00' },          // same Mon, later
      { id: 'edge-first', startAt: '2026-10-19T09:00:00' },    // first day of the window (Mon)
      { id: 'too-old', startAt: '2026-10-18T09:00:00' },       // Sun, the day before the window
      { id: 'years-old', startAt: '2023-06-05T09:00:00' },     // a Monday long before it
      { id: 'ref-day', startAt: '2026-11-02T09:00:00' },       // the reference day is excluded
      { id: 'other-shop', loc: 'B', startAt: '2026-10-27T09:00:00' }, // Tue at another shop
    ]);
    const out = averageDailyAppointmentsByDow(db, sqlite, teamId, 'A', '2026-11-02', 14);
    // Two open Mondays: 3 appointments and 1.
    expect(out.averageByDow.mon).toBe(2);
    expect(out.closedByDow.mon).toBe(false);
    expect(out.closedByDow.sun).toBe(true);   // the 10/18 row is outside the window
    expect(out.closedByDow.tue).toBe(true);   // the Tuesday row belongs to shop B
    expect(out.averageHourlyByDow.mon).toEqual({ 9: 0.5, 10: 1, 14: 0.5 });
  });

  it('falls back to starts_at for legacy rows without start_at', () => {
    const { db, sqlite, teamId } = seed([
      { id: 'legacy-in', startsAt: '2026-10-28T11:00:00' },   // Wed, in window
      { id: 'legacy-old', startsAt: '2026-09-02T11:00:00' },  // Wed, before the window
      { id: 'modern', startAt: '2026-10-28T12:00:00', startsAt: '2026-10-28T12:00:00' }, // counted once
    ]);
    const out = averageDailyAppointmentsByDow(db, sqlite, teamId, 'A', '2026-11-02', 14);
    expect(out.averageByDow.wed).toBe(2);
    expect(out.averageHourlyByDow.wed).toEqual({ 11: 1, 12: 1 });
  });
});
