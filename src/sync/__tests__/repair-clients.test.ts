import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { fetchClientMock } = vi.hoisted(() => ({ fetchClientMock: vi.fn() }));
vi.mock('../../drivers/yot-client', () => ({
  fetchClient: (...a: any[]) => fetchClientMock(...a),
  fetchClients: vi.fn(),
  characterizeClientPaging: vi.fn(), extractAppointmentsRangeRows: vi.fn(),
  fetchAppointmentsRange: vi.fn(), fetchBusiness: vi.fn(),
  fetchLocationServices: vi.fn(), fetchLocationStaff: vi.fn(),
  fetchLocations: vi.fn(), fetchStaffProfile: vi.fn(), ping: vi.fn(),
}));

import { repairClientsById, selectRepairCandidates } from '../repair-clients';
import { NotConfiguredError } from '../sync-clients';
import { initializeDatabase } from '../../db';

let tmp: string;
let teamSeq = 0;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

function freshTeam(withConfig = true): string {
  const teamId = `R${teamSeq++}`;
  const { sqlite } = initializeDatabase(teamId);
  if (withConfig) {
    sqlite.prepare('INSERT INTO plugin_config (team_id, key, value, updated_at) VALUES (?,?,?,?)')
      .run(teamId, 'yot', JSON.stringify({ apiKey: 'k' }), new Date().toISOString());
  }
  return teamId;
}

function addAppt(teamId: string, clientId: string, startAt: string, id = `${clientId}-${startAt}`) {
  const { sqlite } = initializeDatabase(teamId);
  sqlite.prepare('INSERT INTO appointments (id, team_id, client_id, start_at, status, synced_at) VALUES (?,?,?,?,?,?)')
    .run(id, teamId, clientId, startAt, 'Complete', new Date().toISOString());
}

function addClient(teamId: string, id: string, syncedAt = new Date().toISOString()) {
  const { sqlite } = initializeDatabase(teamId);
  sqlite.prepare('INSERT INTO clients (id, team_id, synced_at) VALUES (?,?,?)').run(id, teamId, syncedAt);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'yot-repair-clients-'));
  process.env.HOME = tmp;
  process.env.YOT_ALLOW_DB_AUTOCREATE = '1';
  fetchClientMock.mockReset();
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('selectRepairCandidates', () => {
  it('returns appointment client_ids missing from the roster, skipping the walk-in sentinel', () => {
    const teamId = freshTeam();
    addAppt(teamId, '100', daysAgo(5));
    addAppt(teamId, '200', daysAgo(10));
    addAppt(teamId, '0', daysAgo(1));        // walk-in sentinel — never a real client
    addClient(teamId, '200');                 // already in the roster
    const { sqlite } = initializeDatabase(teamId);

    expect(selectRepairCandidates(sqlite, { teamId })).toEqual(['100']);
  });

  it('ranks by most recent PAST visit, ignoring future bookings', () => {
    const teamId = freshTeam();
    addAppt(teamId, 'standing', daysAgo(400));
    addAppt(teamId, 'standing', daysAhead(60));   // a booking months out must not float this to the top
    addAppt(teamId, 'recent', daysAgo(3));
    const { sqlite } = initializeDatabase(teamId);

    expect(selectRepairCandidates(sqlite, { teamId })).toEqual(['recent', 'standing']);
  });

  it('honors sinceDays and limit', () => {
    const teamId = freshTeam();
    addAppt(teamId, 'fresh', daysAgo(10));
    addAppt(teamId, 'old', daysAgo(900));
    const { sqlite } = initializeDatabase(teamId);

    expect(selectRepairCandidates(sqlite, { teamId, sinceDays: 365 })).toEqual(['fresh']);
    expect(selectRepairCandidates(sqlite, { teamId, limit: 1 })).toEqual(['fresh']);
  });

  it('refreshStaleDays also picks up roster rows that have gone stale', () => {
    const teamId = freshTeam();
    addAppt(teamId, 'stale', daysAgo(5));
    addClient(teamId, 'stale', daysAgo(120));
    const { sqlite } = initializeDatabase(teamId);

    expect(selectRepairCandidates(sqlite, { teamId })).toEqual([]);
    expect(selectRepairCandidates(sqlite, { teamId, refreshStaleDays: 30 })).toEqual(['stale']);
  });
});

describe('repairClientsById', () => {
  it('writes fetched clients into the roster', async () => {
    const teamId = freshTeam();
    addAppt(teamId, '100', daysAgo(5));
    addAppt(teamId, '101', daysAgo(6));
    fetchClientMock.mockImplementation(async (_c: any, id: string) => ({
      id, givenName: 'A', surname: id, mobilePhone: '3135550000', active: true,
    }));

    const res = await repairClientsById({ teamId, concurrency: 2 });
    expect(res).toMatchObject({ candidates: 2, attempted: 2, written: 2, notFound: 0, failed: 0 });
    expect(res.rosterAfter - res.rosterBefore).toBe(2);

    const { sqlite } = initializeDatabase(teamId);
    const row = sqlite.prepare('SELECT mobile_phone, full_name FROM clients WHERE id=?').get('100') as any;
    expect(row.mobile_phone).toBe('3135550000');
    expect(row.full_name).toBe('A 100');
  });

  it('counts a 404 as not-found without writing a row', async () => {
    const teamId = freshTeam();
    addAppt(teamId, 'gone', daysAgo(5));
    fetchClientMock.mockResolvedValue(null);   // driver maps 404 -> null

    const res = await repairClientsById({ teamId });
    expect(res).toMatchObject({ attempted: 1, written: 0, notFound: 1, failed: 0 });
    expect(res.rosterAfter).toBe(res.rosterBefore);
  });

  it('records ids YOT cannot serialize as broken, and keeps going', async () => {
    const teamId = freshTeam();
    addAppt(teamId, 'ok', daysAgo(5));
    addAppt(teamId, 'broken', daysAgo(6));
    fetchClientMock.mockImplementation(async (_c: any, id: string) => {
      if (id === 'broken') throw new Error('YOT /client/broken failed: 500');
      return { id, givenName: 'A', surname: id, active: true };
    });

    const res = await repairClientsById({ teamId, concurrency: 1, retries: 3 });
    expect(res.written).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.brokenIds).toEqual(['broken']);
    // A deterministic 500 is capped at 2 attempts, not the full retry budget.
    expect(fetchClientMock.mock.calls.filter(([, id]) => id === 'broken')).toHaveLength(2);
  });

  it('is idempotent — a second run finds nothing left to do', async () => {
    const teamId = freshTeam();
    addAppt(teamId, '100', daysAgo(5));
    fetchClientMock.mockImplementation(async (_c: any, id: string) => ({ id, givenName: 'A', surname: id, active: true }));

    await repairClientsById({ teamId });
    const second = await repairClientsById({ teamId });
    expect(second).toMatchObject({ candidates: 0, attempted: 0, written: 0 });
  });

  it('throws NotConfiguredError when the team has no apiKey', async () => {
    const teamId = freshTeam(false);
    await expect(repairClientsById({ teamId })).rejects.toBeInstanceOf(NotConfiguredError);
  });
});
