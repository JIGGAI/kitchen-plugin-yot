import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializeDatabase } from '../../db';
import {
  DEFAULT_RAW_RETENTION_DAYS,
  rawForStorage,
  rawRetentionCutoff,
  rawRetentionDays,
  trimAppointmentRaw,
} from '../appointment-raw-retention';

let tempHome: string;
let seq = 0;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'yot-raw-retention-'));
  process.env.HOME = tempHome;
  process.env.YOT_ALLOW_DB_AUTOCREATE = '1';
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe('rawRetentionDays', () => {
  it('defaults to 90 and reads the override', () => {
    expect(rawRetentionDays({})).toBe(DEFAULT_RAW_RETENTION_DAYS);
    expect(rawRetentionDays({ YOT_APPOINTMENT_RAW_RETENTION_DAYS: '' })).toBe(90);
    expect(rawRetentionDays({ YOT_APPOINTMENT_RAW_RETENTION_DAYS: '30' })).toBe(30);
    expect(rawRetentionDays({ YOT_APPOINTMENT_RAW_RETENTION_DAYS: '0' })).toBe(0);
  });

  it('falls back to the default on nonsense', () => {
    expect(rawRetentionDays({ YOT_APPOINTMENT_RAW_RETENTION_DAYS: 'soon' })).toBe(90);
    expect(rawRetentionDays({ YOT_APPOINTMENT_RAW_RETENTION_DAYS: '-5' })).toBe(90);
  });
});

describe('rawRetentionCutoff', () => {
  it('is the local date that many days back', () => {
    const now = new Date(2026, 10, 21, 9, 30).getTime();
    expect(rawRetentionCutoff(now, 90)).toBe('2026-08-23');
    expect(rawRetentionCutoff(now, 1)).toBe('2026-11-20');
  });

  it('is null when retention is off', () => {
    expect(rawRetentionCutoff(Date.now(), 0)).toBeNull();
  });
});

describe('rawForStorage', () => {
  const item = { appointmentId: 7 };
  it('keeps the payload on or after the cutoff and drops it before', () => {
    expect(rawForStorage(item, '2026-08-23T09:00:00', '2026-08-23')).toBe('{"appointmentId":7}');
    expect(rawForStorage(item, '2026-08-22T18:45:00', '2026-08-23')).toBeNull();
  });

  it('keeps the payload when there is no cutoff or no start time', () => {
    expect(rawForStorage(item, '2020-01-01T09:00:00', null)).toBe('{"appointmentId":7}');
    expect(rawForStorage(item, null, '2026-08-23')).toBe('{"appointmentId":7}');
  });
});

describe('trimAppointmentRaw', () => {
  function seed(rows: Array<{ id: string; team?: string; startAt?: string | null; startsAt?: string | null; raw?: string | null }>) {
    const teamId = `RAW${seq++}`;
    const { sqlite } = initializeDatabase(teamId);
    const insert = sqlite.prepare(
      `INSERT INTO appointments (id, team_id, location_id, client_name, start_at, starts_at, raw, synced_at)
       VALUES (?, ?, 'L1', 'Someone', ?, ?, ?, '2026-11-21T00:00:00.000Z')`,
    );
    for (const row of rows) {
      insert.run(row.id, row.team ?? teamId, row.startAt ?? null, row.startsAt ?? null, row.raw === undefined ? '{"a":1}' : row.raw);
    }
    const read = () => Object.fromEntries(
      (sqlite.prepare('SELECT id, raw, client_name AS clientName FROM appointments ORDER BY id').all() as Array<{ id: string; raw: string | null; clientName: string }>)
        .map((row) => [row.id, row]),
    );
    return { teamId, sqlite, read };
  }

  it('clears raw before the cutoff and leaves everything else alone', () => {
    const { teamId, sqlite, read } = seed([
      { id: 'old', startAt: '2026-08-22T18:45:00' },
      { id: 'edge', startAt: '2026-08-23T08:00:00' },
      { id: 'new', startAt: '2026-11-20T10:00:00' },
      { id: 'legacy-old', startsAt: '2024-01-05T10:00:00' },
      { id: 'legacy-new', startsAt: '2026-11-01T10:00:00' },
      { id: 'undated' },
      { id: 'other-team', team: 'someone-else', startAt: '2024-01-05T10:00:00' },
    ]);

    expect(trimAppointmentRaw(sqlite, teamId, '2026-08-23')).toBe(2);

    const rows = read();
    expect(rows.old.raw).toBeNull();
    expect(rows['legacy-old'].raw).toBeNull();
    expect(rows.old.clientName).toBe('Someone');
    for (const id of ['edge', 'new', 'legacy-new', 'undated', 'other-team']) expect(rows[id].raw).toBe('{"a":1}');

    // A second pass has nothing left to do.
    expect(trimAppointmentRaw(sqlite, teamId, '2026-08-23')).toBe(0);
  });

  it('does nothing when retention is off', () => {
    const { teamId, sqlite, read } = seed([{ id: 'old', startAt: '2020-01-01T09:00:00' }]);
    expect(trimAppointmentRaw(sqlite, teamId, null)).toBe(0);
    expect(read().old.raw).toBe('{"a":1}');
  });
});
