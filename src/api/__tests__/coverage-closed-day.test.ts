import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleRequest } from '../handler';
import { initializeDatabase } from '../../db';

let tempHome: string;
let seq = 0;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'yot-coverage-closed-'));
  process.env.HOME = tempHome;
  process.env.YOT_ALLOW_DB_AUTOCREATE = '1';
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe('closed coverage dates', () => {
  it('renders a one-off closed Monday as closed with no requirement, shortage, or absence', async () => {
    const teamId = `CC${seq++}`;
    const { sqlite } = initializeDatabase(teamId);
    sqlite.prepare(
      `INSERT INTO locations (id, team_id, name, active, synced_at)
       VALUES (?, ?, ?, 1, ?)`,
    ).run('2654', teamId, 'Sterling Warren MI', '2026-11-03T00:00:00Z');

    // Prove Mondays are normally operating days, so the result must come from
    // this date's cached closure rather than the recurring-DOW fallback.
    sqlite.prepare(
      `INSERT INTO appointments
         (id, team_id, location_id, stylist_id, start_at, end_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'historical-monday', teamId, '2654', '1',
      '2026-10-26T10:00:00', '2026-10-26T11:00:00', '2026-10-27T00:00:00Z',
    );
    sqlite.prepare(
      `INSERT INTO appointments
         (id, team_id, location_id, stylist_id, start_at, end_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'historical-tuesday', teamId, '2654', '1',
      '2026-10-27T10:00:00', '2026-10-27T11:00:00', '2026-10-28T00:00:00Z',
    );

    sqlite.prepare(
      `INSERT INTO location_coverage_facts
         (team_id, location_id, date, slot_payload, rostered_payload,
          timecard_payload, computed_at, customers_per_stylist)
       VALUES (?, ?, ?, ?, ?, '{}', ?, 10)`,
    ).run(
      teamId,
      '2654',
      '2026-11-02',
      JSON.stringify({
        slots: [], averageDailyAppointments: 15.5,
        customersPerStylistForDay: 10, requiredStylists: 0, closed: true,
      }),
      JSON.stringify({ rows: [] }),
      '2026-11-03T00:00:00Z',
    );

    const history: any = await handleRequest({
      method: 'GET', path: '/coverage/history',
      query: { team: teamId, start: '2026-11-02', end: '2026-11-03' },
      headers: {}, body: null,
    } as any, {} as any);
    const day = history.data.data[0].days.find((entry: any) => entry.date === '2026-11-02');
    expect(day).toEqual({
      date: '2026-11-02', stylists: 0, appts: 0, required: 0,
      lightHours: 0, underCover: false, closed: true, hasRoster: false,
      holiday: null,
    });

    const schedule: any = await handleRequest({
      method: 'GET', path: '/coverage/day-schedule',
      query: { team: teamId, locationId: '2654', date: '2026-11-02' },
      headers: {}, body: null,
    } as any, {} as any);
    expect(schedule.data.stylists).toEqual([]);
    expect(schedule.data.appointments).toEqual([]);
  });
});
