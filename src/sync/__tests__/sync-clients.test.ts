import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock the YOT driver so the sync walks a deterministic fake API.
const { fetchClientsMock } = vi.hoisted(() => ({ fetchClientsMock: vi.fn() }));
vi.mock('../../drivers/yot-client', () => ({
  fetchClients: (...a: any[]) => fetchClientsMock(...a),
  characterizeClientPaging: vi.fn(), extractAppointmentsRangeRows: vi.fn(),
  fetchAppointmentsRange: vi.fn(), fetchBusiness: vi.fn(),
  fetchLocationServices: vi.fn(), fetchLocationStaff: vi.fn(),
  fetchLocations: vi.fn(), fetchStaffProfile: vi.fn(), ping: vi.fn(),
}));

import { runClientsSync, NotConfiguredError } from '../sync-clients';
import { initializeDatabase, closeDatabase } from '../../db';

const PAGE_SIZE = 25;
const makePage = (page: number) => Array.from({ length: PAGE_SIZE }, (_, i) => ({
  id: `${page}-${i}`, givenName: 'Test', surname: `P${page}`, mobilePhone: '3135550000', active: true,
}));

let tmp: string;
let teamSeq = 0;
function freshTeam(withConfig = true): string {
  const teamId = `S${teamSeq++}`;
  const { sqlite } = initializeDatabase(teamId);
  if (withConfig) {
    sqlite.prepare('INSERT INTO plugin_config (team_id, key, value, updated_at) VALUES (?,?,?,?)')
      .run(teamId, 'yot', JSON.stringify({ apiKey: 'k' }), new Date().toISOString());
  }
  return teamId;
}
const clientCount = (teamId: string) => {
  const { sqlite } = initializeDatabase(teamId);
  return (sqlite.prepare('SELECT COUNT(*) AS n FROM clients WHERE team_id=?').get(teamId) as any).n;
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'yot-sync-clients-'));
  process.env.HOME = tmp;
  process.env.YOT_ALLOW_DB_AUTOCREATE = '1';
  fetchClientsMock.mockReset();
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('runClientsSync (out-of-process callable)', () => {
  it('completes a full pass and clears the resume cursor', async () => {
    fetchClientsMock.mockImplementation(async (_c: any, { page }: { page: number }) => (page <= 3 ? makePage(page) : []));
    const teamId = freshTeam();
    const res = await runClientsSync({ teamId, maxPages: 10 });
    expect(res).toMatchObject({ ok: true, complete: true, fromPage: 1, lastPage: 3, nextPage: null, stoppedBecause: 'empty-page' });
    expect(res.synced).toBe(75);
    expect(clientCount(teamId)).toBe(75);
  });

  it('throws NotConfiguredError when the team has no apiKey', async () => {
    const teamId = freshTeam(false);
    await expect(runClientsSync({ teamId })).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it('closeDatabase checkpoints and releases without throwing', async () => {
    fetchClientsMock.mockImplementation(async (_c: any, { page }: { page: number }) => (page <= 1 ? makePage(page) : []));
    const teamId = freshTeam();
    await runClientsSync({ teamId, maxPages: 5 });
    expect(() => closeDatabase(teamId)).not.toThrow();
    // Re-opening after close still works (fresh connection).
    expect(clientCount(teamId)).toBe(25);
  });
});
