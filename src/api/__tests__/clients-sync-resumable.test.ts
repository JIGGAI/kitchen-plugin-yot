import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock the YOT driver so /clients/sync walks a deterministic fake API.
const { fetchClientsMock } = vi.hoisted(() => ({ fetchClientsMock: vi.fn() }));
vi.mock('../../drivers/yot-client', () => ({
  fetchClients: (...a: any[]) => fetchClientsMock(...a),
  characterizeClientPaging: vi.fn(), extractAppointmentsRangeRows: vi.fn(),
  fetchAppointmentsRange: vi.fn(), fetchBusiness: vi.fn(),
  fetchLocationServices: vi.fn(), fetchLocationStaff: vi.fn(),
  fetchLocations: vi.fn(), fetchStaffProfile: vi.fn(), ping: vi.fn(),
}));

import { handleRequest } from '../handler';
import { initializeDatabase } from '../../db';

const PAGE_SIZE = 25;
const makePage = (page: number) => Array.from({ length: PAGE_SIZE }, (_, i) => ({
  id: `${page}-${i}`, givenName: 'Test', surname: `P${page}`, mobilePhone: '3135550000', active: true,
}));

let tmp: string;
let teamSeq = 0;
function freshTeam(): string {
  const teamId = `T${teamSeq++}`;
  const { sqlite } = initializeDatabase(teamId); // creates + migrates temp db
  sqlite.prepare('INSERT INTO plugin_config (team_id, key, value, updated_at) VALUES (?,?,?,?)')
    .run(teamId, 'yot', JSON.stringify({ apiKey: 'k' }), new Date().toISOString());
  return teamId;
}
const sync = (teamId: string, query: Record<string, string> = {}) =>
  handleRequest({ method: 'POST', path: '/clients/sync', query: { team: teamId, ...query }, headers: {}, body: null }, {} as any);
const stateRow = (teamId: string) => {
  const { sqlite } = initializeDatabase(teamId);
  return sqlite.prepare("SELECT resume_page AS resumePage, row_count AS rowCount FROM sync_state WHERE team_id=? AND resource='clients'").get(teamId) as any;
};
const clientCount = (teamId: string) => {
  const { sqlite } = initializeDatabase(teamId);
  return (sqlite.prepare('SELECT COUNT(*) AS n FROM clients WHERE team_id=?').get(teamId) as any).n;
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'yot-clients-sync-'));
  process.env.HOME = tmp;
  process.env.YOT_ALLOW_DB_AUTOCREATE = '1';
  fetchClientsMock.mockReset();
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('/clients/sync (resumable, streaming)', () => {
  it('completes a full pass and clears the resume cursor', async () => {
    fetchClientsMock.mockImplementation(async (_config: any, { page }: { page: number }) => (page <= 3 ? makePage(page) : []));
    const teamId = freshTeam();
    const res: any = await sync(teamId, { maxPages: '10' });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ ok: true, complete: true, fromPage: 1, lastPage: 3, nextPage: null, stoppedBecause: 'empty-page' });
    expect(res.data.synced).toBe(75);
    expect(clientCount(teamId)).toBe(75);
    expect(stateRow(teamId).resumePage).toBeNull(); // cursor cleared on completion
  });

  it('stops at the chunk boundary and persists a resume cursor, then resumes', async () => {
    fetchClientsMock.mockImplementation(async (_config: any, { page }: { page: number }) => (page <= 3 ? makePage(page) : []));
    const teamId = freshTeam();
    // Chunk 1: only 2 pages.
    const r1: any = await sync(teamId, { maxPages: '2' });
    expect(r1.data).toMatchObject({ complete: false, lastPage: 2, nextPage: 3, stoppedBecause: 'maxPages' });
    expect(stateRow(teamId).resumePage).toBe(3);
    expect(clientCount(teamId)).toBe(50);
    // Chunk 2: no startPage → resumes from cursor (page 3), then hits empty page 4.
    const r2: any = await sync(teamId, { maxPages: '10' });
    expect(r2.data).toMatchObject({ complete: true, fromPage: 3, lastPage: 3, nextPage: null });
    expect(clientCount(teamId)).toBe(75);
    expect(stateRow(teamId).resumePage).toBeNull();
  });

  it('preserves the cursor at the failing page when skipping is disabled', async () => {
    fetchClientsMock.mockImplementation(async (_config: any, { page }: { page: number }) => {
      if (page === 1) return makePage(1);
      throw new Error('timeout past page boundary');
    });
    const teamId = freshTeam();
    const res: any = await sync(teamId, { maxPages: '10', retryBackoffMs: '0', maxSkippedPages: '0' });
    expect(res.data).toMatchObject({ complete: false, lastPage: 1, nextPage: 2, stoppedBecause: 'error' });
    expect(res.data.error).toMatch(/timeout/);
    expect(stateRow(teamId).resumePage).toBe(2); // retry from the failed page next run
    expect(clientCount(teamId)).toBe(25);         // page 1 persisted despite the later failure
  });

  it('by default steps over persistently failing pages instead of parking on one', async () => {
    // The real failure this guards: YOT 500s deterministically on some deep
    // pages, and stopping there pinned the cursor so the weekly walk spent
    // every run re-failing the same page — zero progress for ten weeks.
    fetchClientsMock.mockImplementation(async (_config: any, { page }: { page: number }) => {
      if (page === 1) return makePage(1);
      throw new Error('timeout past page boundary');
    });
    const teamId = freshTeam();
    const res: any = await sync(teamId, { maxPages: '10', retryBackoffMs: '0' });
    expect(res.data.skippedPages).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(res.data).toMatchObject({ stoppedBecause: 'maxPages', lastPage: 10, nextPage: 11 });
    expect(stateRow(teamId).resumePage).toBe(11);  // the walk moved on
    expect(clientCount(teamId)).toBe(25);
  });

  it('retries a transient page error within the chunk and keeps going', async () => {
    const attempts: Record<number, number> = {};
    fetchClientsMock.mockImplementation(async (_config: any, { page }: { page: number }) => {
      attempts[page] = (attempts[page] || 0) + 1;
      if (page === 2 && attempts[page] === 1) throw new Error('transient 500'); // fails once, then succeeds
      return page <= 3 ? makePage(page) : [];
    });
    const teamId = freshTeam();
    const res: any = await sync(teamId, { maxPages: '10', retryBackoffMs: '0' });
    expect(res.data).toMatchObject({ complete: true, lastPage: 3, nextPage: null, stoppedBecause: 'empty-page' });
    expect(clientCount(teamId)).toBe(75);   // all 3 pages landed despite the blip
    expect(attempts[2]).toBe(2);            // page 2 was retried once and recovered
    expect(stateRow(teamId).resumePage).toBeNull();
  });

  it('gives up after pageRetries attempts on a stuck page', async () => {
    const attempts: Record<number, number> = {};
    fetchClientsMock.mockImplementation(async (_config: any, { page }: { page: number }) => {
      attempts[page] = (attempts[page] || 0) + 1;
      if (page === 1) return makePage(1);
      throw new Error('stuck');
    });
    const teamId = freshTeam();
    const res: any = await sync(teamId, { maxPages: '10', pageRetries: '3', retryBackoffMs: '0', maxSkippedPages: '0' });
    expect(res.data).toMatchObject({ stoppedBecause: 'error', lastPage: 1 });
    expect(attempts[2]).toBe(3); // tried 3 times before giving up
  });
});
